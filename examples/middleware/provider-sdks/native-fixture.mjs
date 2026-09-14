import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createMiddlewareRuntime } from '../../../packages/sdk/typescript/dist/middleware/index.js';

export const SOURCE=Array.from({length:140},(_,i)=>`[INFO] café 🌍 row ${i} retained-detail-${i} long repeated diagnostic\r\n`).join('');
export const FACT='retained-detail-70';
export const scope=name=>({namespace:'provider-sdk-http',session_id:name,branch_id:'main',cache_epoch:'0'});
export const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
export const waitFor=async(promise,ms=200)=>Promise.race([promise.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),ms))]);
export const history=protocol=>protocol==='openai-chat'?
  [{role:'user',content:'Read source'},{role:'assistant',content:null,tool_calls:[{id:'read-1',type:'function',function:{name:'read_logs',arguments:'{}'}}]},{role:'tool',tool_call_id:'read-1',content:SOURCE}]:
  protocol==='openai-responses'?[{role:'user',content:'Read source'},{type:'function_call',call_id:'read-1',name:'read_logs',arguments:'{}'},{type:'function_call_output',call_id:'read-1',output:SOURCE}]:
  [{role:'user',content:'Read source'},{role:'assistant',content:[{type:'tool_use',id:'read-1',name:'read_logs',input:{}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'read-1',content:SOURCE}]}];
export function definitions(protocol){
  const tool={name:'read_logs',description:'Read source',parameters:{type:'object',properties:{},additionalProperties:false}};
  return protocol==='openai-chat'?[{type:'function',function:tool}]:protocol==='openai-responses'?[{type:'function',...tool,strict:false}]:[{name:tool.name,description:tool.description,input_schema:tool.parameters}];
}
export const args=(protocol,model='helpers',messages=history(protocol))=>({model,[protocol==='openai-responses'?'input':'messages']:messages,...(protocol==='anthropic-messages'?{max_tokens:100}:{})});
export const textOf=(result,protocol)=>protocol==='openai-chat'?result.choices[0].message.content:protocol==='openai-responses'?result.output_text:result.content[0].text;
export const api=(client,protocol)=>protocol==='openai-chat'?client.chat.completions:protocol==='openai-responses'?client.responses:client.messages;

export function protectedHistories(protocol){
  return ['unmatched','before_call','duplicate_call','duplicate_result','unknown_result_contract','unknown_call_contract','error','citations','mixed_media'].map(name=>{
    const messages=history(protocol),result=protocol==='anthropic-messages'?messages[2].content[0]:messages[2],call=protocol==='openai-chat'?messages[1].tool_calls[0]:protocol==='anthropic-messages'?messages[1].content[0]:messages[1];
    const id=protocol==='openai-chat'?'tool_call_id':protocol==='openai-responses'?'call_id':'tool_use_id',content=protocol==='openai-responses'?'output':'content';
    if(name==='unmatched')result[id]='missing';
    else if(name==='before_call')[messages[1],messages[2]]=[messages[2],messages[1]];
    else if(name==='duplicate_call')messages.splice(2,0,structuredClone(messages[1]));
    else if(name==='duplicate_result')messages.push(structuredClone(messages[2]));
    else if(name==='unknown_result_contract')result.future_contract={signed:'opaque'};
    else if(name==='unknown_call_contract')call.future_contract={signed:'opaque'};
    else if(name==='error')result.is_error=true;
    else if(name==='citations')result[content]=[{type:'text',text:SOURCE,citations:[]}];
    else if(name==='mixed_media')result[content]=[{type:'text',text:SOURCE},{type:'image',source:{type:'url',url:'https://example.invalid/image.png'}}];
    return {name,messages};
  });
}

export function instrument(endpoint,mode='compress',deadlineMs=1000){
  const diagnostics=[],plans=[],receipts=[],reports=[];
  const runtime=createMiddlewareRuntime({endpoint:mode==='outage'?'http://127.0.0.1:1':endpoint,mode:mode==='off'?'off':'compress',deadlineMs:mode==='outage'?200:deadlineMs,onDiagnostic:entry=>diagnostics.push(entry),onReport:entry=>{reports.push(entry);}});
  const optimize=runtime.optimize.bind(runtime),observe=runtime.observe.bind(runtime);
  runtime.optimize=async options=>{const result=await optimize(options);plans.push({options,result});return result;};
  runtime.observe=receipt=>{receipts.push(receipt);return observe(receipt);};
  return {runtime,plans,receipts,diagnostics,reports};
}

function resultFor(protocol,index,text,call){
  if(protocol==='openai-chat')return {id:`chatcmpl_${index}`,object:'chat.completion',created:1,model:'fixture-model',choices:[{index:0,message:{role:'assistant',content:text,...(call?{tool_calls:[{type:'function',id:call.id,function:{name:call.name,arguments:JSON.stringify(call.input)}}]}:{})},finish_reason:call?'tool_calls':'stop',logprobs:null}],usage:{prompt_tokens:1000,completion_tokens:20,total_tokens:1020,prompt_tokens_details:{cached_tokens:100}}};
  if(protocol==='openai-responses')return {id:`resp_${index}`,object:'response',created_at:1,status:'completed',model:'fixture-model',output:[call?{id:'fc_'+call.id,type:'function_call',call_id:call.id,name:call.name,arguments:JSON.stringify(call.input),status:'completed'}:{id:'msg_output',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[],logprobs:[]}]}],usage:{input_tokens:1000,output_tokens:20,total_tokens:1020,input_tokens_details:{cached_tokens:100},output_tokens_details:{reasoning_tokens:0}},error:null,incomplete_details:null};
  return {id:`msg_${index}`,type:'message',role:'assistant',model:'claude-sonnet-4-6',content:[call?{type:'tool_use',id:call.id,name:call.name,input:call.input}:{type:'text',text}],stop_reason:call?'tool_use':'end_turn',stop_sequence:null,usage:{input_tokens:1000,output_tokens:20,cache_read_input_tokens:100,cache_creation_input_tokens:0}};
}

function* events(protocol,result){
  const event=(type,fields={})=>`event: ${type}\ndata: ${JSON.stringify({type,...fields})}\n\n`;
  if(protocol==='openai-chat'){
    const choice=result.choices[0],message=choice.message,tool=message.tool_calls?.[0];
    const common={id:result.id,object:'chat.completion.chunk',created:1,model:result.model};
    const deltas=[{role:'assistant'},...(tool?[{tool_calls:[{index:0,id:tool.id,type:'function',function:{name:tool.function.name,arguments:tool.function.arguments.slice(0,1)}}]},{tool_calls:[{index:0,function:{arguments:tool.function.arguments.slice(1)}}]}]:[{content:message.content.slice(0,3)},{content:message.content.slice(3)}])];
    for(const delta of deltas)yield `data: ${JSON.stringify({...common,choices:[{index:0,delta,finish_reason:null}]})}\n\n`;
    yield `data: ${JSON.stringify({...common,choices:[{index:0,delta:{},finish_reason:choice.finish_reason}],usage:result.usage})}\n\n`;
    yield 'data: [DONE]\n\n';return;
  }
  if(protocol==='openai-responses'){
    let sequence=0;const responseEvent=(type,fields)=>event(type,{sequence_number:sequence++,...fields});
    const item=result.output[0];
    yield responseEvent('response.created',{response:{...result,status:'in_progress',output:[],usage:null}});
    yield responseEvent('response.output_item.added',{output_index:0,item:{...item,...(item.type==='function_call'?{arguments:''}:{content:[]}),status:'in_progress'}});
    if(item.type==='function_call'){
      for(const delta of [item.arguments.slice(0,1),item.arguments.slice(1)])yield responseEvent('response.function_call_arguments.delta',{output_index:0,item_id:item.id,delta});
      yield responseEvent('response.function_call_arguments.done',{output_index:0,item_id:item.id,name:item.name,arguments:item.arguments});
    }else{
      const part=item.content[0];
      yield responseEvent('response.content_part.added',{output_index:0,item_id:item.id,content_index:0,part:{...part,text:''}});
      for(const delta of [part.text.slice(0,3),part.text.slice(3)])yield responseEvent('response.output_text.delta',{output_index:0,item_id:item.id,content_index:0,delta,logprobs:[]});
      yield responseEvent('response.output_text.done',{output_index:0,item_id:item.id,content_index:0,text:part.text,logprobs:[]});
      yield responseEvent('response.content_part.done',{output_index:0,item_id:item.id,content_index:0,part});
    }
    yield responseEvent('response.output_item.done',{output_index:0,item});
    yield responseEvent('response.completed',{response:result});return;
  }
  const part=result.content[0],tool=part.type==='tool_use',value=tool?JSON.stringify(part.input):part.text;
  yield event('message_start',{message:{...result,content:[],stop_reason:null}});
  yield event('content_block_start',{index:0,content_block:{...part,...(tool?{input:{}}:{text:''})}});
  for(const delta of [value.slice(0,1),value.slice(1)])yield event('content_block_delta',{index:0,delta:tool?{type:'input_json_delta',partial_json:delta}:{type:'text_delta',text:delta}});
  yield event('content_block_stop',{index:0});
  yield event('message_delta',{delta:{stop_reason:result.stop_reason,stop_sequence:null},usage:{output_tokens:20}});
  yield event('message_stop');
}

export async function providerFixture(protocol,{pause,handler}={}){
  const calls=[],errors=[],responses=[],closures=[],headers=deferred(),first=deferred(),release=deferred(),closed=deferred();let released=!pause;
  const releaseNow=()=>{released=true;release.resolve();};if(!pause)releaseNow();
  const server=createServer(async(req,res)=>{
    try{
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const raw=Buffer.concat(chunks).toString('utf8'),body=raw?JSON.parse(raw):{},path=req.url.split('?')[0];
      calls.push({method:req.method,path,body,raw,headers:req.headers});
      const closure=deferred();closures.push(closure);
      res.on('close',()=>{const value={beforeRelease:!released};closed.resolve(value);closure.resolve(value);});
      res.setHeader('x-request-id','fixture-openai');res.setHeader('request-id','fixture-anthropic');
      const json=(value,status=200)=>{const raw=JSON.stringify(value);responses.push({status,raw});res.writeHead(status,{'content-type':'application/json'});res.end(raw);};
      if(handler&&await handler(body,req,res,json))return;
      if(body.model==='failure')return json({error:{type:'invalid_request_error',message:'deterministic native failure'}},400);
      if(path.endsWith('/count_tokens')||path.endsWith('/input_tokens'))return json({input_tokens:7});
      if(path.endsWith('/batches'))return json({id:'batch_fixture',object:'batch',type:'message_batch',status:'validating',processing_status:'in_progress',request_counts:{processing:1,succeeded:0,errored:0,canceled:0,expired:0}});
      if(path.endsWith('/embeddings'))return json({object:'list',data:[{object:'embedding',index:0,embedding:[1,2]}],model:'fixture-embedding',usage:{prompt_tokens:7,total_tokens:7}});
      if(path.endsWith('/compact'))return json({id:'compact_fixture',object:'response.compaction',created_at:1,output:[{type:'compaction',id:'opaque',encrypted_content:'opaque-signed-payload'}],usage:{input_tokens:7,output_tokens:2,total_tokens:9}});
      let text=body.model==='parse'?'{"answer":42}':'native',call;
      if(body.model==='loop'){
        const found=protocol==='openai-chat'?Object.fromEntries((body.messages??[]).filter(message=>message.role==='tool').map(message=>[message.tool_call_id,message.content])):
          protocol==='openai-responses'?Object.fromEntries((body.input??[]).filter(item=>item.type==='function_call_output').map(item=>[item.call_id,item.output])):
          Object.fromEntries((body.messages??[]).flatMap(message=>Array.isArray(message.content)?message.content:[]).filter(part=>part.type==='tool_result').map(part=>[part.tool_use_id,part.content]));
        if(!('read-1' in found)){text=null;call={name:'read_logs',id:'read-1',input:{}};}
        else{
          const handle=typeof found['read-1']==='string'?found['read-1'].match(/cmw_[a-f0-9]{48}/)?.[0]:null;
          if(handle&&!('recover-1' in found)){assert.ok(!found['read-1'].includes(FACT));text=null;call={name:'caveman_retrieve',id:'recover-1',input:{handle}};}
          else{if('recover-1' in found)assert.equal(JSON.parse(found['recover-1']).text,SOURCE);else assert.equal(found['read-1'],SOURCE);text=FACT;}
        }
      }
      const result=resultFor(protocol,calls.length,text,call);
      if(!body.stream)return json(result);
      res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders();headers.resolve();
      if(pause==='headers')await release.promise;
      let index=0;
      for(const event of events(protocol,result)){
        res.write(event);
        if(index++===0){first.resolve();if(pause==='first')await release.promise;}
      }
      res.end();
    }catch(error){errors.push(error.message);res.destroy(error);}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  return {calls,errors,responses,closures,headers,first,closed,url:`http://127.0.0.1:${server.address().port}`,release:releaseNow,get released(){return released;},
    async close(){releaseNow();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}

export function evidenceRecorder(name,versions){
  const records=[];
  return {record(protocol,operation,provider,observed,extra={}){records.push({protocol,operation,provider_requests:provider.calls.length,optimization_calls:observed.plans.length,bound_calls:observed.plans.filter(plan=>plan.options.binding).length,replacement_calls:observed.plans.filter(plan=>plan.result.replacements.length).length,...extra});},
    async write(){
      const paths=[`examples/middleware/provider-sdks/${name}.test.mjs`,'examples/middleware/provider-sdks/native-fixture.mjs','examples/middleware/provider-sdks/package-lock.json',`packages/middleware/typescript/src/${name}.ts`,'packages/middleware/typescript/src/transport.ts','packages/middleware/typescript/src/provider-leaves.ts'];
      const hash=content=>createHash('sha256').update(content).digest('hex'),root=new URL('../../../',import.meta.url),files={};
      for(const path of paths)files[path]=hash(await readFile(new URL(path,root)));
      const runtime_sha256=process.env.CAVEMAN_MIDDLEWARE_TEST_BINARY?hash(await readFile(process.env.CAVEMAN_MIDDLEWARE_TEST_BINARY)):null;
      await writeFile(new URL(`./${name}-native-evidence.json`,import.meta.url),JSON.stringify({evidence_class:'installed_provider_sdk_with_deterministic_http',versions,node:process.version,runtime_sha256,source_sha256:hash(SOURCE),files,observations:records},null,2)+'\n');
    }};
}
