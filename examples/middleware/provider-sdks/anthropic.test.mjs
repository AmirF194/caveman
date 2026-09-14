import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test, { after } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { createMiddlewareRuntime } from '../../../packages/sdk/typescript/dist/middleware/index.js';
import { withCavemanAnthropic } from '../../../packages/middleware/typescript/dist/anthropic.js';
import { startRuntime } from '../../../packages/middleware/conformance/runtime-fixture.mjs';
import { certifyCells } from './certification-native.mjs';

test('F02 native exact operation journeys preserve baselines and executor ownership', {timeout:90000}, async t => {
  const service = await startRuntime(); t.after(service.stop);
  await certifyCells(t, 'F02', service.endpoint);
});
import { SOURCE, FACT, args, definitions, history, instrument, providerFixture, protectedHistories, scope as nativeScope, waitFor, evidenceRecorder } from './native-fixture.mjs';

const source = Array.from({length:140}, (_,i) => `[INFO] café 🌍 row ${i} retained-detail-${i} long repeated diagnostic\r\n`).join('');
const scope = { namespace:'native-provider', session_id:'anthropic', branch_id:'main', cache_epoch:'0' };
const nativeEvidence=evidenceRecorder('anthropic',{'@anthropic-ai/sdk':'0.124.0'});
after(()=>nativeEvidence.write());
const deferred = () => { let resolve; const promise = new Promise(r => resolve=r); return { promise, resolve }; };
const usage = {input_tokens:1000,output_tokens:20,cache_creation_input_tokens:0,cache_read_input_tokens:100};
const message = (content, stop='end_turn') => ({id:'msg-fixture',type:'message',role:'assistant',model:'fixture-model',content,stop_reason:stop,stop_sequence:null,usage});
const toolUse = (name,input,id) => ({type:'tool_use',name,input,id});

test('official Anthropic lazy runner recovers exact originals and native streams flush before EOF', {timeout:30000}, async t => {
  const service=await startRuntime();t.after(service.stop);
  const runtime=createMiddlewareRuntime({endpoint:service.endpoint});t.after(()=>runtime.close());await runtime.ready();
  const calls=[], errors=[], release=deferred(); let finished=false;
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));calls.push({body,url:req.url,headers:req.headers});
    try {
      res.setHeader('Request-Id','anthropic-fixture-request');
      if(req.url.startsWith('/v1/messages/count_tokens')) {res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({input_tokens:7}));}
      const results=body.messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(p=>p.type==='tool_result');
      const log=results.find(p=>p.tool_use_id==='read-1');
      let content,stop='end_turn';
      if(body.model==='helpers') content=[{type:'text',text:'native'}];
      else if(!log) {content=[toolUse('read_logs',{},'read-1')];stop='tool_use';}
      else {
        const handle=log.content.match(/cmw_[a-f0-9]{48}/)?.[0];assert.ok(handle,'native tool result shortened');
        assert.ok(!log.content.includes('retained-detail-70'));
        const recovered=results.find(p=>p.tool_use_id==='recover-1');
        if(!recovered) {content=[toolUse('caveman_retrieve',{handle},'recover-1')];stop='tool_use';}
        else {assert.equal(JSON.parse(recovered.content).text,source);content=[{type:'text',text:'retained-detail-70'}];}
      }
      if(!body.stream) {res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(message(content,stop)));}
      res.writeHead(200, {'Content-Type':'text/event-stream'});
      const event=(type,fields)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...fields})}\n\n`);
      event('message_start',{message:{...message([]),stop_reason:null}});
      const part=content[0];
      if(part.type==='tool_use') {
        event('content_block_start',{index:0,content_block:{...part,input:{}}});
        event('content_block_delta',{index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(part.input)}});
      } else {
        event('content_block_start',{index:0,content_block:{type:'text',text:''}});
        event('content_block_delta',{index:0,delta:{type:'text_delta',text:'retained-'}});
        await release.promise;finished=true;
        event('content_block_delta',{index:0,delta:{type:'text_delta',text:'detail-70'}});
      }
      event('content_block_stop',{index:0});event('message_delta',{delta:{stop_reason:stop,stop_sequence:null},usage:{output_tokens:20}});event('message_stop',{});res.end();
    }catch(error){errors.push(error.message);res.destroy(error);}
  });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  let fetches=0;
  const nativeFetch=(...args)=>{fetches++;return fetch(...args);};
  const original=new Anthropic({apiKey:'fixture-only',baseURL:`http://127.0.0.1:${server.address().port}`,maxRetries:0,fetch:nativeFetch});
  const beforeRunner=original.beta.messages.toolRunner;
  const client=withCavemanAnthropic(original,{runtime,scope,fetch:nativeFetch});
  assert.ok(client instanceof Anthropic);assert.equal(original.beta.messages.toolRunner,beforeRunner);
  const tools=[{name:'read_logs',description:'Read source',input_schema:{type:'object',properties:{}},run:()=>source,parse:input=>input}];
  const input=[{role:'user',content:'Read and recover row 70.'}];
  const params={model:'fixture-model',max_tokens:100,messages:input,tools,max_iterations:5,betas:['fixture-beta'],system:[{type:'text',text:'Keep system intact',cache_control:{type:'ephemeral'}}],thinking:{type:'enabled',budget_tokens:1024}};
  const runner=client.beta.messages.toolRunner(params);
  assert.equal(calls.length,0,'native runner remains lazy');
  assert.equal(typeof runner.setMessagesParams,'function');
  const final=await runner;
  assert.equal(final.content[0].text,'retained-detail-70');
  assert.equal(input.length,1);assert.equal(tools.length,1);
  assert.ok(JSON.stringify(runner.params.messages).includes(source.replaceAll('\r','\\r').replaceAll('\n','\\n')),'native runner history keeps originals');
  assert.equal(calls.length,3);assert.deepEqual(calls[1].body.system,params.system);assert.deepEqual(calls[1].body.thinking,params.thinking);
  assert.ok(calls[1].headers['anthropic-beta'].includes('fixture-beta'));
  for(const call of calls)assert.deepEqual(call.body.tools,calls[0].body.tools);
  const raw=await client.messages.create({model:'helpers',max_tokens:10,messages:input}).withResponse();
  assert.equal(raw.data.content[0].text,'native');assert.equal(raw.request_id,'anthropic-fixture-request');
  assert.equal(await client.messages.countTokens({model:'helpers',messages:input}).then(v=>v.input_tokens),7);
  const streamingClient=withCavemanAnthropic(original,{runtime,scope:{...scope,branch_id:'stream'},fetch:nativeFetch});
  const streamed=streamingClient.beta.messages.toolRunner({...params,stream:true});
  let text='';
  for await(const stream of streamed) {
    assert.equal(typeof stream.finalMessage,'function');assert.equal(typeof stream.abort,'function');
    for await(const event of stream) {
      if(event.type!=='content_block_delta'||event.delta.type!=='text_delta')continue;
      const chunk=event.delta.text;
      if(!text) {assert.equal(finished,false,'first stream text precedes EOF');release.resolve();}
      text+=chunk;
    }
    await stream.finalMessage();
  }
  assert.equal(text,'retained-detail-70');assert.equal((await streamed.done()).content[0].text,text);
  assert.deepEqual(errors,[]);assert.equal(fetches,calls.length,'caller fetch owns every request');
});

test('Anthropic native Messages and beta helpers preserve parsing, signed thinking, cache markers and errors', {timeout:30000},async t=>{
  const service=await startRuntime();t.after(service.stop);
  const provider=await providerFixture('anthropic-messages');t.after(provider.close);const observed=instrument(service.endpoint);t.after(()=>observed.runtime.close());await observed.runtime.ready();
  let fetches=0;const nativeFetch=(...params)=>{fetches++;return fetch(...params);};
  const original=new Anthropic({apiKey:'fixture',baseURL:provider.url,maxRetries:0,fetch:nativeFetch}),client=withCavemanAnthropic(original,{runtime:observed.runtime,scope:nativeScope('helpers-anthropic'),fetch:nativeFetch});
  const messages=history('anthropic-messages');messages[1].content.unshift({type:'thinking',thinking:'opaque reasoning',signature:'signed-thinking-bytes'});
  const params={...args('anthropic-messages','helpers',messages),system:[{type:'text',text:'original system',cache_control:{type:'ephemeral'}}],thinking:{type:'enabled',budget_tokens:1024}};
  const before=structuredClone(params);
  for(const [name,resource]of [['messages',client.messages],['beta.messages',client.beta.messages]]){
    const extra=name==='beta.messages'?{betas:['fixture-beta']}:{};
    const pending=resource.create({...params,...extra},{headers:{'x-native-option':'kept'}});assert.equal(typeof pending.withResponse,'function');assert.equal(typeof pending.asResponse,'function');
    const response=await pending.withResponse();assert.equal(response.data.content[0].text,'native');assert.equal(response.request_id,'fixture-anthropic');
    const raw=await resource.create({...params,...extra}).asResponse();assert.equal(raw.bodyUsed,false);assert.equal(raw.clone().url,raw.url);await raw.text();
    const chunks=[];for await(const event of await resource.create({...params,...extra,stream:true}))chunks.push(event);assert.ok(chunks.length>3);
    const parsed=await resource.parse({...params,...extra,model:'parse',output_config:{format:{type:'json_schema',schema:{type:'object',properties:{answer:{type:'integer'}},required:['answer'],additionalProperties:false}}}});assert.deepEqual(parsed.parsed_output,{answer:42});
    const stream=resource.stream({...params,...extra});const events=[];for await(const event of stream)events.push(event.type);assert.equal((await stream.finalMessage()).content[0].text,'native');assert.equal(typeof stream.abort,'function');
    const baseline=name==='messages'?original.messages:original.beta.messages,baselineEvents=[];for await(const event of baseline.stream({...params,...extra}))baselineEvents.push(event.type);assert.deepEqual(events,baselineEvents);
    nativeEvidence.record('anthropic-messages',name+'.native_helpers',provider,observed,{native_event_order:events,native_event_order_equal:true});
  }
  const count=observed.plans.length;await client.withOptions({timeout:3000}).messages.create(params);assert.equal(observed.plans.length,count+1);assert.deepEqual(params,before);
  assert.ok(provider.calls.every(call=>JSON.stringify(call.body.messages)===JSON.stringify(messages)));assert.ok(provider.calls.every(call=>JSON.stringify(call.body.system)===JSON.stringify(params.system)));assert.ok(observed.plans.every(plan=>plan.result.replacements.length===0));
  for(const headers of [{'signature':'opaque'},{'content-encoding':'identity'},{'dpop':'opaque-proof'},{'authorization':'Signature keyId=fixture'},{'content-type':'application/custom-json'}]){await original.messages.create(params,{headers});const native=provider.calls.at(-1).raw,start=observed.plans.length;await client.messages.create(params,{headers});assert.equal(provider.calls.at(-1).raw,native);assert.equal(observed.plans.length,start);}
  const start=observed.plans.length;assert.equal((await client.messages.countTokens({model:'helpers',messages})).input_tokens,7);await client.messages.batches.create({requests:[{custom_id:'batch-1',params}]});assert.equal(observed.plans.length,start);
  const errors=[];for(const native of [original,client]){try{await native.messages.create({...params,model:'failure'});assert.fail('expected error');}catch(error){assert.ok(error instanceof Anthropic.BadRequestError);errors.push([error.status,error.error]);}}assert.deepEqual(errors[0],errors[1]);assert.equal(provider.calls.filter(call=>call.body.model==='failure').length,2);assert.equal(fetches,provider.calls.length);assert.deepEqual(provider.errors,[]);
  nativeEvidence.record('anthropic-messages','opaque_signed_unrelated_and_errors',provider,observed,{native_bytes_equal:true,signed_thinking_preserved:true,native_error:'BadRequestError'});
});

test('Anthropic native runner modes preserve application history and source dispatch for complete and streamed calls', {timeout:30000},async t=>{
  const service=await startRuntime();t.after(service.stop);
  for(const mode of ['compress','off','outage'])for(const streaming of [false,true]){
    const provider=await providerFixture('anthropic-messages');t.after(provider.close);const observed=instrument(service.endpoint,mode);t.after(()=>observed.runtime.close());if(mode==='compress')await observed.runtime.ready();
    const original=new Anthropic({apiKey:'fixture',baseURL:provider.url,maxRetries:0}),client=withCavemanAnthropic(original,{runtime:observed.runtime,scope:nativeScope(`runner-${mode}-${streaming}`),fetch}).withOptions({timeout:3000});let reads=0;
    const tools=[{...definitions('anthropic-messages')[0],parse:input=>input,run:async()=>{reads++;return SOURCE;}}],messages=[{role:'user',content:'Read source and recover row 70'}],before=structuredClone(messages);
    const runner=client.beta.messages.toolRunner({model:'loop',max_tokens:100,max_iterations:5,messages,tools,stream:streaming});assert.equal(provider.calls.length,0);assert.equal(typeof runner.setMessagesParams,'function');
    let final;if(streaming){for await(const stream of runner){for await(const event of stream){}final=await stream.finalMessage();}assert.equal((await runner.done()).content[0].text,FACT);}else final=await runner;
    assert.equal(final.content[0].text,FACT);assert.equal(reads,1);assert.equal(provider.calls.length,mode==='compress'?3:2);assert.equal(tools.length,1);assert.deepEqual(messages,before);assert.deepEqual(provider.errors,[]);
    nativeEvidence.record('anthropic-messages',streaming?'toolRunner.stream':'toolRunner',provider,observed,{mode,final:FACT,source_executions:reads,original_history:true});
  }
});

test('Anthropic native runner rechecks real executors for substitutions, duplicate names and in-flight mutation', {timeout:30000},async t=>{
  const service=await startRuntime();t.after(service.stop);
  const provider=await providerFixture('anthropic-messages');t.after(provider.close);const observed=instrument(service.endpoint);t.after(()=>observed.runtime.close());await observed.runtime.ready();
  const original=new Anthropic({apiKey:'fixture',baseURL:provider.url,maxRetries:0});
  const clientFor=name=>withCavemanAnthropic(original,{runtime:observed.runtime,scope:nativeScope('attestation-anthropic-'+name),fetch});
  const source=()=>({...definitions('anthropic-messages')[0],parse:input=>input,run:async()=>SOURCE});
  const variants=[
    ['substituted_executor',tools=>tools.map(tool=>tool.name==='caveman_retrieve'?{...tool,run:async()=>'fake'}:tool)],
    ['removed_executor',tools=>tools.map(tool=>tool.name==='caveman_retrieve'?{...tool,run:undefined}:tool)],
    ['renamed',tools=>tools.map(tool=>tool.name==='caveman_retrieve'?{...tool,name:'different_recovery'}:tool)],
    ['changed_schema',tools=>tools.map(tool=>tool.name==='caveman_retrieve'?{...tool,input_schema:{type:'object',properties:{}}}:tool)],
    ['duplicate_recovery',tools=>[...tools,tools.find(tool=>tool.name==='caveman_retrieve')]],
    ['duplicate_source',tools=>[...tools,tools.find(tool=>tool.name==='read_logs')]],
    ['forced_tool',tools=>tools],
    ['structured_output',tools=>tools],
    ['tool_removal',tools=>tools],
  ];
  for(const [name,edit]of variants){
    const runner=clientFor(name).beta.messages.toolRunner({...args('anthropic-messages'),tools:[source()],max_iterations:1});
    const recovery=runner.params.tools.find(tool=>tool.name==='caveman_retrieve');assert.throws(()=>{recovery.run=async()=>'fake';},TypeError);assert.throws(()=>{recovery.input_schema.properties.handle.type='number';},TypeError);
    runner.setMessagesParams(params=>({...params,tools:edit(params.tools),
      ...(name==='forced_tool'?{tool_choice:{type:'tool',name:'read_logs'}}:{}),
      ...(name==='structured_output'?{output_config:{format:{type:'json_schema',schema:{type:'object',properties:{}}}}}:{}),
      ...(name==='tool_removal'?{messages:[...params.messages,{role:'user',content:[{type:'tool_removal',name:'caveman_retrieve'}]}]}:{}),
    }));const start=observed.plans.length;assert.equal((await runner).content[0].text,'native');assert.equal(observed.plans.length,start+1);assert.equal(observed.plans.at(-1).options.binding,null,name);assert.equal(provider.calls.at(-1).body.messages[2].content[0].content,SOURCE,name);
  }
  const runner=clientFor('race').beta.messages.toolRunner({...args('anthropic-messages'),tools:[source()],max_iterations:1});
  const optimize=observed.runtime.optimize.bind(observed.runtime);let mutated=false;
  observed.runtime.optimize=async options=>{const result=await optimize(options);assert.ok(result.replacements.length);runner.setMessagesParams(params=>({...params,tools:params.tools.map(tool=>tool.name==='caveman_retrieve'?{...tool,run:async()=>'fake'}:tool)}));mutated=true;return result;};
  const receiptStart=observed.receipts.length;assert.equal((await runner).content[0].text,'native');assert.equal(mutated,true);assert.equal(provider.calls.at(-1).body.messages[2].content[0].content,SOURCE);assert.ok(observed.receipts.slice(receiptStart).every(receipt=>receipt.plan_id===null));
  assert.deepEqual(provider.errors,[]);nativeEvidence.record('anthropic-messages','executor_attestation',provider,observed,{protected_cases:variants.map(([name])=>name),in_flight_mutation_retains_original:true,discarded_projection_receipt_plan:null});
});

test('Anthropic native stream abort closes provider before the withheld fixture event', {timeout:30000},async t=>{
  const service=await startRuntime();t.after(service.stop);
  for(const wrapped of [false,true])for(const helper of [false,true]){
    const provider=await providerFixture('anthropic-messages',{pause:'first'});t.after(provider.close);const observed=instrument(service.endpoint);t.after(()=>observed.runtime.close());await observed.runtime.ready();
    const original=new Anthropic({apiKey:'fixture',baseURL:provider.url,maxRetries:0}),client=wrapped?withCavemanAnthropic(original,{runtime:observed.runtime,scope:nativeScope('cancel-anthropic-'+helper),fetch}):original;
    const controller=new AbortController(),stream=helper?client.messages.stream(args('anthropic-messages'),{signal:controller.signal}):await client.messages.create({...args('anthropic-messages'),stream:true},{signal:controller.signal});
    if(helper){stream.on('error',()=>{});stream.on('abort',()=>{});}
    const iterator=stream[Symbol.asyncIterator]();await iterator.next();controller.abort();await iterator.return();
    assert.equal(provider.released,false);assert.equal(await waitFor(provider.closed.promise),true);assert.equal((await provider.closed.promise).beforeRelease,true);assert.equal(provider.calls.length,1);
    if(wrapped)assert.ok(observed.receipts.some(receipt=>receipt.event_kind==='cancelled'&&receipt.usage===null),JSON.stringify(observed.receipts));
    nativeEvidence.record('anthropic-messages',helper?'messages.stream.cancel':'messages.create.cancel',provider,observed,{wrapped,peer_closed_before_release:true});
  }
});

test('Anthropic native unknown, error, cited and mixed-media tool results remain unchanged', {timeout:30000},async t=>{
  const service=await startRuntime();t.after(service.stop);
  const provider=await providerFixture('anthropic-messages');t.after(provider.close);const observed=instrument(service.endpoint);t.after(()=>observed.runtime.close());await observed.runtime.ready();
  const original=new Anthropic({apiKey:'fixture',baseURL:provider.url,maxRetries:0}),client=withCavemanAnthropic(original,{runtime:observed.runtime,scope:nativeScope('protected-anthropic'),fetch});
  for(const {name,messages}of protectedHistories('anthropic-messages')){
    const before=structuredClone(messages),start=observed.plans.length;await original.messages.create(args('anthropic-messages','helpers',messages));const native=provider.calls.at(-1).raw;await client.messages.create(args('anthropic-messages','helpers',messages));
    assert.equal(observed.plans.slice(start).flatMap(plan=>plan.options.candidates).length,0,name);assert.deepEqual(messages,before);assert.equal(provider.calls.at(-1).raw,native);
  }
  const start=observed.plans.length;await client.messages.create(args('anthropic-messages'));assert.equal(observed.plans.slice(start).flatMap(plan=>plan.options.candidates).length,1);
  nativeEvidence.record('anthropic-messages','protected_native_shapes',provider,observed,{protected_cases:9,native_wire_equal:true,positive_text_candidate:true});
});
