import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test, { after } from 'node:test';
import OpenAI from 'openai';
import { createMiddlewareRuntime } from '../../../packages/sdk/typescript/dist/middleware/index.js';
import { withCavemanOpenAI, withCavemanOpenAITools } from '../../../packages/middleware/typescript/dist/openai.js';
import { SOURCE, FACT, api, args, definitions, history, instrument, providerFixture, protectedHistories, scope as nativeScope, textOf, waitFor, evidenceRecorder } from './native-fixture.mjs';
import { startRuntime } from '../../../packages/middleware/conformance/runtime-fixture.mjs';
import { certifyCells } from './certification-native.mjs';

const source=Array.from({length:120},(_,i)=>`[INFO] row ${i} café 🌍 omitted-detail-${i} verbose repeated log data\r\n`).join('');
const scope={namespace:'native-provider',session_id:'openai',branch_id:'main',cache_epoch:'0'};
const nativeEvidence=evidenceRecorder('openai',{openai:'7.12.1'});
after(()=>nativeEvidence.write());

test('F01 native exact operation journeys preserve baselines and executor ownership', {timeout:90000}, async t => {
  const service = await startRuntime(); t.after(service.stop);
  await certifyCells(t, 'F01', service.endpoint);
});
function completion(content,toolCalls=[]){return {id:'completion-native',object:'chat.completion',created:1,model:'fixture-model',choices:[{index:0,message:{role:'assistant',content,tool_calls:toolCalls},finish_reason:toolCalls.length?'tool_calls':'stop',logprobs:null}],usage:{prompt_tokens:1000,completion_tokens:20,total_tokens:1020}};}

test('official OpenAI runTools executes recovery; native APIPromise and Response helpers remain intact', {timeout:30000},async t=>{
  const service=await startRuntime();t.after(service.stop);
  const runtime=createMiddlewareRuntime({endpoint:service.endpoint});t.after(()=>runtime.close());await runtime.ready();
  const calls=[],errors=[];
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));calls.push({body,headers:req.headers});
    try{
      res.setHeader('Content-Type','application/json');res.setHeader('X-Request-Id','provider-fixture-request');
      if(req.url==='/v1/responses')return res.end(JSON.stringify({id:'resp-fixture',object:'response',created_at:1,status:'completed',model:'fixture-model',output:[],usage:{input_tokens:10,output_tokens:2,total_tokens:12}}));
      if(body.model==='parse')return res.end(JSON.stringify(completion('{"answer":42}')));
      if(body.model==='helpers')return res.end(JSON.stringify(completion('native')));
      const tool=body.messages.find(m=>m.role==='tool'&&m.tool_call_id==='read-1');
      if(!tool)return res.end(JSON.stringify(completion(null,[{id:'read-1',type:'function',function:{name:'read_logs',arguments:'{}'}}])));
      const handle=tool.content.match(/cmw_[a-f0-9]{48}/)?.[0];assert.ok(handle,'native runner tool result shortened');assert.ok(!tool.content.includes('omitted-detail-60'));
      const recovery=body.messages.find(m=>m.role==='tool'&&m.tool_call_id==='recover-1');
      if(!recovery)return res.end(JSON.stringify(completion(null,[{id:'recover-1',type:'function',function:{name:'caveman_retrieve',arguments:JSON.stringify({handle})}}])));
      assert.equal(JSON.parse(recovery.content).text,source);
      res.end(JSON.stringify(completion('omitted-detail-60')));
    }catch(error){errors.push(error.message);res.destroy(error);}
  });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const baseURL=`http://127.0.0.1:${server.address().port}/v1`;
  let nativeFetchCalls=0;
  const nativeFetch=async(...args)=>{nativeFetchCalls++;return fetch(...args);};
  const original=new OpenAI({baseURL,apiKey:'local-fixture-provider-token',maxRetries:0,fetch:nativeFetch});
  const originalRun=original.chat.completions.runTools;
  const client=withCavemanOpenAI(original,{runtime,scope,fetch:nativeFetch,cavemanProxy:true});
  assert.ok(client instanceof OpenAI);assert.notEqual(client,original);assert.equal(original.chat.completions.runTools,originalRun);
  const tools=[{type:'function',function:{name:'read_logs',description:'Read logs',parameters:{type:'object',properties:{}},parse:JSON.parse,function:async()=>source}}];
  const input=[{role:'user',content:'Read logs and recover omitted-detail-60.'}];
  const before=structuredClone(input);
  const runner=client.chat.completions.runTools({model:'fixture-model',messages:input,tools},{maxChatCompletions:5});
  assert.equal(typeof runner.on,'function');assert.equal(typeof runner.abort,'function');
  assert.equal(await runner.finalContent(),'omitted-detail-60');
  assert.deepEqual(input,before);assert.equal(tools.length,1);assert.deepEqual(errors,[]);
  assert.equal(calls.length,3);
  assert.deepEqual(calls[0].body.tools,calls[1].body.tools);assert.deepEqual(calls[1].body.tools,calls[2].body.tools);
  assert.ok(calls.every(c=>c.headers['x-cave-transforms']===undefined),'control header never goes to unrelated provider origin');
  const pending=client.chat.completions.create({model:'helpers',messages:[{role:'user',content:'hello'}]});
  assert.equal(typeof pending.withResponse,'function');assert.equal(typeof pending.asResponse,'function');
  const {data,response,request_id}=await pending.withResponse();
  assert.equal(data.choices[0].message.content,'native');assert.equal(request_id,'provider-fixture-request');assert.equal(response.url,baseURL+'/chat/completions');
  const raw=await client.chat.completions.create({model:'helpers',messages:[{role:'user',content:'hello'}]}).asResponse();
  assert.equal(raw.bodyUsed,false);assert.equal(raw.clone().url,raw.url);await raw.text();
  const parsed=await client.chat.completions.parse({model:'parse',messages:[{role:'user',content:'json'}],response_format:{type:'json_schema',json_schema:{name:'answer',schema:{type:'object',properties:{answer:{type:'number'}},required:['answer'],additionalProperties:false},strict:true}}});
  assert.deepEqual(parsed.choices[0].message.parsed,{answer:42});
  const responses=client.responses.create({model:'helpers',input:'hello'});assert.equal(typeof responses.withResponse,'function');
  const responseResult=await responses.withResponse();assert.equal(responseResult.data.id,'resp-fixture');assert.equal(responseResult.response.url,baseURL+'/responses');
  assert.equal(nativeFetchCalls,calls.length,'original custom fetch owns every provider request');
});

test('OpenAI Chat and Responses preserve native raw, parse, stream and client-clone helpers', {timeout:30000}, async t=>{
  const service=await startRuntime();t.after(service.stop);
  for(const protocol of ['openai-chat','openai-responses']){
    const provider=await providerFixture(protocol);t.after(provider.close);
    const observed=instrument(service.endpoint);t.after(()=>observed.runtime.close());await observed.runtime.ready();
    let fetches=0;const nativeFetch=(...params)=>{fetches++;return fetch(...params);};
    const original=new OpenAI({apiKey:'fixture',baseURL:provider.url+'/v1',maxRetries:0,fetch:nativeFetch});
    const client=withCavemanOpenAI(original,{runtime:observed.runtime,scope:nativeScope('helpers-'+protocol),fetch:nativeFetch});
    const params=args(protocol),before=structuredClone(params),resource=api(client,protocol);
    const pending=resource.create(params,{headers:{'x-native-option':'kept'}});
    assert.equal(typeof pending.withResponse,'function');assert.equal(typeof pending.asResponse,'function');
    const response=await pending.withResponse();assert.equal(textOf(response.data,protocol),'native');assert.equal(response.request_id,'fixture-openai');
    const raw=await resource.create(params).asResponse();assert.equal(raw.bodyUsed,false);assert.equal(raw.clone().url,raw.url);assert.ok((await raw.text()).includes('native'));
    const events=[];for await(const event of await resource.create({...params,stream:true}))events.push(event);
    assert.ok(events.length>2);
    const schema={type:'object',properties:{answer:{type:'integer'}},required:['answer'],additionalProperties:false};
    const parsed=await resource.parse({...params,model:'parse',...(protocol==='openai-chat'?{response_format:{type:'json_schema',json_schema:{name:'answer',schema,strict:true}}}:{text:{format:{type:'json_schema',name:'answer',schema,strict:true}}})});
    assert.deepEqual(protocol==='openai-chat'?parsed.choices[0].message.parsed:parsed.output_parsed,{answer:42});
    const stream=resource.stream(params);const nativeEvents=[];
    for await(const event of stream)nativeEvents.push(event);
    const final=protocol==='openai-chat'?await stream.finalChatCompletion():await stream.finalResponse();
    assert.equal(textOf(final,protocol),'native');assert.equal(typeof stream.abort,'function');
    const baselineEvents=[];for await(const event of api(original,protocol).stream(params))baselineEvents.push(event.type??event.object);
    assert.deepEqual(nativeEvents.map(event=>event.type??event.object),baselineEvents);
    const count=observed.plans.length;await api(client.withOptions({timeout:3000}),protocol).create(params);assert.equal(observed.plans.length,count+1);
    assert.deepEqual(params,before);assert.ok(observed.plans.every(plan=>plan.result.replacements.length===0));
    assert.ok(provider.calls.every(call=>JSON.stringify(call.body[protocol==='openai-chat'?'messages':'input'])===JSON.stringify(before[protocol==='openai-chat'?'messages':'input'])));
    assert.equal(provider.calls[0].headers['x-native-option'],'kept');assert.equal(fetches,provider.calls.length);assert.deepEqual(provider.errors,[]);
    nativeEvidence.record(protocol,'native_helpers',provider,observed,{native_event_order:nativeEvents.map(event=>event.type??event.object),native_event_order_equal:true,original_history:true});
  }
});

test('OpenAI application-owned Chat and Responses loops recover exact bytes across native create and streaming', {timeout:30000},async t=>{
  const service=await startRuntime();t.after(service.stop);
  for(const protocol of ['openai-chat','openai-responses'])for(const mode of ['compress','off','outage'])for(const streaming of [false,true]){
    const provider=await providerFixture(protocol);t.after(provider.close);
    const observed=instrument(service.endpoint,mode);t.after(()=>observed.runtime.close());if(mode==='compress')await observed.runtime.ready();
    const original=new OpenAI({apiKey:'fixture',baseURL:provider.url+'/v1',maxRetries:0});let reads=0;
    const originalTools=definitions(protocol),beforeTools=structuredClone(originalTools);
    const bundle=withCavemanOpenAITools(original,{runtime:observed.runtime,scope:nativeScope(`app-${protocol}-${mode}-${streaming}`),fetch,protocol,tools:originalTools,functions:{read_logs:async()=>{reads++;return SOURCE;}}});
    assert.deepEqual(originalTools,beforeTools);assert.throws(()=>{bundle.functions.read_logs=async()=>'';},TypeError);
    const changed=bundle.tools;changed[0].type='future_tool';assert.deepEqual(bundle.tools[0],beforeTools[0]);
    const client=bundle.client.withOptions({timeout:3000}),messages=[{role:'user',content:'Read source and recover row 70'}];
    let result,recovered;
    for(let step=0;step<5;step++){
      const params={...args(protocol,'loop',messages),tools:bundle.tools};
      if(streaming){const stream=api(client,protocol).stream(params);for await(const event of stream){}result=protocol==='openai-chat'?await stream.finalChatCompletion():await stream.finalResponse();}
      else result=await api(client,protocol).create(params);
      let calls;
      if(protocol==='openai-chat'){const message=result.choices[0].message;messages.push(message);calls=(message.tool_calls??[]).map(call=>({id:call.id,name:call.function.name,input:JSON.parse(call.function.arguments)}));}
      else{messages.push(...result.output);calls=result.output.filter(item=>item.type==='function_call').map(item=>({id:item.call_id,name:item.name,input:JSON.parse(item.arguments)}));}
      if(!calls.length)break;
      for(const call of calls){const value=await bundle.functions[call.name](call.input);if(call.name==='caveman_retrieve')recovered=value.text;const content=typeof value==='string'?value:JSON.stringify(value);messages.push(protocol==='openai-chat'?{role:'tool',tool_call_id:call.id,content}:{type:'function_call_output',call_id:call.id,output:content});}
    }
    assert.equal(textOf(result,protocol),FACT);assert.equal(reads,1);assert.equal(provider.calls.length,mode==='compress'?3:2);
    if(mode==='compress'){assert.equal(recovered,SOURCE);assert.ok(observed.plans.some(plan=>plan.result.replacements.length));}else assert.equal(recovered,undefined);
    assert.deepEqual(provider.errors,[]);
    nativeEvidence.record(protocol,streaming?'application_tool_loop.stream':'application_tool_loop',provider,observed,{mode,final:FACT,recovered_exact:recovered===SOURCE,source_executions:reads});
  }
});

test('OpenAI native runTools streaming and mode fallbacks preserve native scheduler and callbacks', {timeout:30000},async t=>{
  const service=await startRuntime();t.after(service.stop);
  for(const mode of ['compress','off','outage'])for(const streaming of [false,true]){
    const provider=await providerFixture('openai-chat');t.after(provider.close);const observed=instrument(service.endpoint,mode);t.after(()=>observed.runtime.close());if(mode==='compress')await observed.runtime.ready();
    const original=new OpenAI({apiKey:'fixture',baseURL:provider.url+'/v1',maxRetries:0});
    const client=withCavemanOpenAI(original,{runtime:observed.runtime,scope:nativeScope(`runTools-${mode}-${streaming}`),fetch}).withOptions({timeout:3000});let reads=0,callbacks=0;
    const tools=[{type:'function',function:{...definitions('openai-chat')[0].function,parse:JSON.parse,function:async()=>{reads++;return SOURCE;}}}];
    const runner=client.chat.completions.runTools({model:'loop',messages:[{role:'user',content:'Read source'}],tools,stream:streaming},{maxChatCompletions:5,afterCompletion:()=>{callbacks++;}});
    assert.equal(typeof runner.on,'function');assert.equal(typeof runner.abort,'function');assert.equal(await runner.finalContent(),FACT);assert.equal(reads,1);assert.equal(callbacks,provider.calls.length);assert.equal(provider.calls.length,mode==='compress'?3:2);assert.equal(tools.length,1);assert.deepEqual(provider.errors,[]);
    nativeEvidence.record('openai-chat',streaming?'runTools.stream':'runTools',provider,observed,{mode,final:FACT,native_callbacks:callbacks});
  }
});

test('OpenAI opaque history, signed bodies, unrelated endpoints and errors remain native', {timeout:30000},async t=>{
  const service=await startRuntime();t.after(service.stop);
  for(const protocol of ['openai-chat','openai-responses']){
    const provider=await providerFixture(protocol);t.after(provider.close);const observed=instrument(service.endpoint);t.after(()=>observed.runtime.close());await observed.runtime.ready();
    const original=new OpenAI({apiKey:'fixture',baseURL:provider.url+'/v1',maxRetries:0}),client=withCavemanOpenAI(original,{runtime:observed.runtime,scope:nativeScope('opaque-'+protocol),fetch});
    for(const headers of [{'signature':'opaque-signature'},{'content-encoding':'identity'},{'dpop':'opaque-proof'},{'authorization':'Signature keyId=fixture'},{'content-type':'application/custom-json'}]){
      await api(original,protocol).create(args(protocol),{headers});const native=provider.calls.at(-1).raw,start=observed.plans.length;await api(client,protocol).create(args(protocol),{headers});assert.equal(provider.calls.at(-1).raw,native);assert.equal(observed.plans.length,start);
    }
    if(protocol==='openai-responses'){
      for(const reference of [{previous_response_id:'resp_opaque'},{conversation:'conv_opaque'},{conversation:{id:'conv_opaque'}}]){const start=observed.plans.length;await client.responses.create({...args(protocol),...reference});assert.equal(observed.plans.length,start);assert.deepEqual(provider.calls.at(-1).body.input,history(protocol));for(const [key,value]of Object.entries(reference))assert.deepEqual(provider.calls.at(-1).body[key],value);}
      const start=observed.plans.length;await client.responses.retrieve('resp_opaque');await client.responses.cancel('resp_opaque');await client.responses.compact({model:'helpers',input:history(protocol)});assert.equal(observed.plans.length,start);
    }else{const start=observed.plans.length;await client.embeddings.create({model:'fixture-embedding',input:SOURCE,encoding_format:'float'});await client.batches.create({completion_window:'24h',endpoint:'/v1/chat/completions',input_file_id:'file_opaque'});assert.equal(observed.plans.length,start);}
    const errors=[];for(const native of [original,client]){try{await api(native,protocol).create(args(protocol,'failure'));assert.fail('expected native error');}catch(error){assert.ok(error instanceof OpenAI.BadRequestError);errors.push([error.status,error.error]);}}assert.deepEqual(errors[0],errors[1]);assert.equal(provider.calls.filter(call=>call.body.model==='failure').length,2);assert.deepEqual(provider.errors,[]);
    nativeEvidence.record(protocol,'opaque_signed_unrelated_and_errors',provider,observed,{native_bytes_equal:true,native_error:'BadRequestError'});
  }
});

test('OpenAI stream abort closes the native provider before fixture EOF', {timeout:30000},async t=>{
  const service=await startRuntime();t.after(service.stop);
  for(const protocol of ['openai-chat','openai-responses'])for(const wrapped of [false,true]){
    const provider=await providerFixture(protocol,{pause:'first'});t.after(provider.close);const observed=instrument(service.endpoint);t.after(()=>observed.runtime.close());await observed.runtime.ready();
    const original=new OpenAI({apiKey:'fixture',baseURL:provider.url+'/v1',maxRetries:0});const client=wrapped?withCavemanOpenAI(original,{runtime:observed.runtime,scope:nativeScope('cancel-'+protocol),fetch}):original;
    const controller=new AbortController(),stream=await api(client,protocol).create({...args(protocol),stream:true},{signal:controller.signal});
    const iterator=stream[Symbol.asyncIterator]();await iterator.next();controller.abort();await iterator.return();
    assert.equal(provider.released,false);assert.equal(await waitFor(provider.closed.promise),true);assert.equal((await provider.closed.promise).beforeRelease,true);assert.equal(provider.calls.length,1);
    if(wrapped){assert.ok(observed.receipts.some(receipt=>receipt.event_kind==='cancelled'&&receipt.usage===null),JSON.stringify(observed.receipts));}
    nativeEvidence.record(protocol,'cancel_before_eof',provider,observed,{wrapped,peer_closed_before_release:true});
  }
});

test('OpenAI native unknown, erroneous and ambiguous result shapes never become candidates', {timeout:30000},async t=>{
  const service=await startRuntime();t.after(service.stop);
  for(const protocol of ['openai-chat','openai-responses']){
    const provider=await providerFixture(protocol);t.after(provider.close);const observed=instrument(service.endpoint);t.after(()=>observed.runtime.close());await observed.runtime.ready();
    const original=new OpenAI({apiKey:'fixture',baseURL:provider.url+'/v1',maxRetries:0}),client=withCavemanOpenAI(original,{runtime:observed.runtime,scope:nativeScope('protected-'+protocol),fetch});
    for(const {name,messages}of protectedHistories(protocol)){
      const before=structuredClone(messages),start=observed.plans.length;
      await api(original,protocol).create(args(protocol,'helpers',messages));const native=provider.calls.at(-1).raw;
      await api(client,protocol).create(args(protocol,'helpers',messages));
      assert.equal(observed.plans.slice(start).flatMap(plan=>plan.options.candidates).length,0,`${protocol}: ${name}`);
      assert.deepEqual(messages,before);assert.equal(provider.calls.at(-1).raw,native);
    }
    const start=observed.plans.length;await api(client,protocol).create(args(protocol));assert.equal(observed.plans.slice(start).flatMap(plan=>plan.options.candidates).length,1,'known ordinary text remains eligible');
    nativeEvidence.record(protocol,'protected_native_shapes',provider,observed,{protected_cases:9,native_wire_equal:true,positive_text_candidate:true});
  }
});

test('OpenAI native application registration rejects altered schemas, duplicate names and forced output', {timeout:30000},async t=>{
  const service=await startRuntime();t.after(service.stop);
  for(const protocol of ['openai-chat','openai-responses']){
    const provider=await providerFixture(protocol);t.after(provider.close);const observed=instrument(service.endpoint);t.after(()=>observed.runtime.close());await observed.runtime.ready();
    const original=new OpenAI({apiKey:'fixture',baseURL:provider.url+'/v1',maxRetries:0});
    const variants=['model_only_schema','missing_recovery','changed_name','changed_schema','changed_description','duplicate_recovery','duplicate_source','forced_tool','structured_output'];
    for(const variant of variants){
      const options={runtime:observed.runtime,scope:nativeScope('registration-'+protocol+'-'+variant),fetch};
      const bundle=withCavemanOpenAITools(original,{...options,protocol,tools:definitions(protocol),functions:{read_logs:async()=>SOURCE}});
      const params={...args(protocol),tools:bundle.tools},get=tool=>protocol==='openai-chat'?tool.function:tool,recovery=get(params.tools.at(-1));
      if(variant==='missing_recovery')params.tools.pop();
      else if(variant==='changed_name')recovery.name='different_recovery';
      else if(variant==='changed_schema')recovery.parameters={type:'object',properties:{}};
      else if(variant==='changed_description')recovery.description='Different executor contract';
      else if(variant==='duplicate_recovery')params.tools.push(structuredClone(params.tools.at(-1)));
      else if(variant==='duplicate_source')params.tools.push(structuredClone(params.tools[0]));
      else if(variant==='forced_tool')params.tool_choice=protocol==='openai-chat'?{type:'function',function:{name:'read_logs'}}:{type:'function',name:'read_logs'};
      else if(variant==='structured_output'){
        if(protocol==='openai-chat')params.response_format={type:'json_object'};
        else params.text={format:{type:'json_schema',name:'answer',schema:{type:'object',properties:{answer:{type:'string'}},required:['answer'],additionalProperties:false},strict:true}};
      }
      const client=variant==='model_only_schema'?withCavemanOpenAI(original,options):bundle.client,start=observed.plans.length;
      await api(client,protocol).create(params);assert.equal(observed.plans.length,start+1);assert.equal(observed.plans.at(-1).options.binding,null,variant);assert.equal(observed.plans.at(-1).result.replacements.length,0,variant);
      assert.deepEqual(provider.calls.at(-1).body[protocol==='openai-chat'?'messages':'input'],history(protocol));
    }
    for(const invalid of [
      {tools:[...definitions(protocol),...definitions(protocol)],functions:{read_logs:async()=>SOURCE}},
      {tools:definitions(protocol),functions:{}},
      {tools:definitions(protocol),functions:{read_logs:async()=>SOURCE,caveman_retrieve:async()=>''}},
    ])assert.throws(()=>withCavemanOpenAITools(original,{runtime:observed.runtime,scope:nativeScope('invalid-'+protocol),fetch,protocol,...invalid}),TypeError);
    assert.deepEqual(provider.errors,[]);nativeEvidence.record(protocol,'executor_registration',provider,observed,{protected_cases:variants,immutable_dispatch:true,invalid_registries_rejected:3});
  }
});
