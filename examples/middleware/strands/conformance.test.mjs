import assert from 'node:assert/strict';
import { createServer } from 'node:http2';
import { once } from 'node:events';
import { crc32 } from 'node:zlib';
import test from 'node:test';
import { Agent, BedrockModel, FunctionTool } from '@strands-agents/sdk';
import { createMiddlewareRuntime } from '../../../packages/sdk/typescript/dist/middleware/index.js';
import { withCavemanStrands } from '../../../packages/middleware/typescript/dist/strands.js';
import { startRuntime } from '../../../packages/middleware/conformance/runtime-fixture.mjs';

const source=Array.from({length:140},(_,i)=>`[INFO] café 🌍 row ${i} retained-detail-${i} long repeated diagnostic\r\n`).join('');
function event(name,payload){
  const headers=[];
  for(const [key,value]of Object.entries({':event-type':name,':content-type':'application/json',':message-type':'event'})){
    const k=Buffer.from(key),v=Buffer.from(value),length=Buffer.alloc(2);length.writeUInt16BE(v.length);
    headers.push(Buffer.from([k.length]),k,Buffer.from([7]),length,v);
  }
  const h=Buffer.concat(headers),body=Buffer.from(JSON.stringify(payload)),prelude=Buffer.alloc(12);
  prelude.writeUInt32BE(16+h.length+body.length);prelude.writeUInt32BE(h.length,4);prelude.writeUInt32BE(crc32(prelude.subarray(0,8)),8);
  const frame=Buffer.concat([prelude,h,body]),checksum=Buffer.alloc(4);checksum.writeUInt32BE(crc32(frame));return Buffer.concat([frame,checksum]);
}
async function provider(){
  const calls=[],errors=[];let release,gate=new Promise(r=>release=r),released=false;
  const server=createServer(async(req,res)=>{
    try{
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const body=JSON.parse(Buffer.concat(chunks));calls.push({body,headers:req.headers});
      const results=body.messages.flatMap(m=>m.content.filter(p=>p.toolResult).map(p=>p.toolResult));
      const original=results.find(r=>r.toolUseId==='read-1'),recovered=results.find(r=>r.toolUseId==='recover-1');
      let call,text;
      if(!original)call={toolUseId:'read-1',name:'read_logs',input:{}};
      else{
        const value=original.content[0].text,handle=value.match(/cmw_[a-f0-9]{48}/)?.[0];
        if(handle&&!recovered){assert.ok(!value.includes('retained-detail-70'));call={toolUseId:'recover-1',name:'caveman_retrieve',input:{handle}};}
        else{assert.equal(recovered?JSON.parse(recovered.content[0].text).text:value,source);text='retained-detail-70';}
      }
      res.writeHead(200,{'content-type':'application/vnd.amazon.eventstream'});
      const send=(name,payload)=>res.write(event(name,payload));
      send('messageStart',{role:'assistant'});
      if(call){send('contentBlockStart',{contentBlockIndex:0,start:{toolUse:{toolUseId:call.toolUseId,name:call.name}}});send('contentBlockDelta',{contentBlockIndex:0,delta:{toolUse:{input:JSON.stringify(call.input)}}});}
      else{
        send('contentBlockDelta',{contentBlockIndex:0,delta:{text:'retained-'}});
        let timeout;try{await Promise.race([gate,new Promise((_,reject)=>timeout=setTimeout(()=>reject(new Error('Native stream did not deliver its first chunk before continuation')),3000))]);}finally{clearTimeout(timeout);}
        send('contentBlockDelta',{contentBlockIndex:0,delta:{text:'detail-70'}});
      }
      send('contentBlockStop',{contentBlockIndex:0});send('messageStop',{stopReason:call?'tool_use':'end_turn'});
      send('metadata',{usage:{inputTokens:1000,outputTokens:20,totalTokens:1020},metrics:{latencyMs:1}});res.end();
    }catch(error){errors.push(error.message);res.destroy(error);}
  });
  const sessions=new Set();server.on('session',session=>{sessions.add(session);session.once('close',()=>sessions.delete(session));});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  return {calls,errors,release(){released=true;release();},get released(){return released;},url:`http://127.0.0.1:${server.address().port}`,
    async close(){release();for(const session of sessions)session.destroy();await new Promise(r=>server.close(r));}};
}
function agent(provider,runtime,session){
  const model=new BedrockModel({modelId:'anthropic.fixture-v1',region:'us-east-1',clientConfig:{endpoint:provider.url,credentials:{accessKeyId:'fixture',secretAccessKey:'fixture'},maxAttempts:1}});
  const read=new FunctionTool({name:'read_logs',description:'Read source',callback:()=>source});
  return new Agent(withCavemanStrands({model,tools:[read]},{runtime,scope:{namespace:'strands-ts',session_id:session,branch_id:'main',cache_epoch:'0'}}));
}

test('native Strands tool loop, signed Bedrock streaming and original state',{timeout:20000},async t=>{
  const service=await startRuntime();t.after(service.stop);
  const rpc=[],runtime=createMiddlewareRuntime({endpoint:service.endpoint,fetch:async(url,options)=>{const response=await fetch(url,options);if(url.endsWith('/optimize'))rpc.push(await response.clone().json());return response;}});t.after(()=>runtime.close());await runtime.ready();
  const fixture=await provider();t.after(fixture.close);t.after(()=>{if(fixture.errors.length)t.diagnostic(fixture.errors);});
  const native=agent(fixture,runtime,'stream');let text='';
  const stream=native.stream('Read source and recover');let result;
  while(true){const next=await stream.next();if(next.done){result=next.value;break;}const event=next.value;
    if(event.type==='modelStreamUpdateEvent'&&event.event.type==='modelContentBlockDeltaEvent'&&event.event.delta.type==='textDelta'){
      text+=event.event.delta.text;if(text==='retained-'){assert.equal(fixture.released,false);fixture.release();}
    }
  }
  assert.equal(text,'retained-detail-70');assert.equal(result.lastMessage.content[0].text,text);
  assert.equal(fixture.calls.length,3);assert.equal(rpc.filter(p=>p.status==='optimized').length,2);
  assert.ok(fixture.calls.every(c=>c.headers.authorization.startsWith('AWS4-HMAC-SHA256 ')));
  const original=native.messages.flatMap(m=>m.content).find(b=>b.type==='toolResultBlock'&&b.toolUseId==='read-1');
  assert.equal(original.content[0].text,source);assert.deepEqual(fixture.errors,[]);
});

test('native Strands invoke preserves off and unavailable behavior',{timeout:20000},async t=>{
  const service=await startRuntime();t.after(service.stop);
  for(const [mode,endpoint]of [['off',service.endpoint],['compress','http://127.0.0.1:1']]){
    const fixture=await provider();t.after(fixture.close);fixture.release();
    const runtime=createMiddlewareRuntime({mode,endpoint});t.after(()=>runtime.close());
    const result=await agent(fixture,runtime,mode).invoke('Read source');
    assert.equal(result.lastMessage.content[0].text,'retained-detail-70');assert.equal(fixture.calls.length,2);assert.deepEqual(fixture.errors,[]);
  }
});

import { certifyStrands } from './certification-native.mjs';
test('Strands F09 openai agent.invoke', { timeout: 30000 }, t => certifyStrands(t, 'openai', 'agent.invoke'));
test('Strands F09 openai agent.stream', { timeout: 30000 }, t => certifyStrands(t, 'openai', 'agent.stream'));
test('Strands F09 openai model.structured_output', { timeout: 30000 }, t => certifyStrands(t, 'openai', 'model.structured_output'));
test('Strands F09 openai parallel_tool_batch', { timeout: 30000 }, t => certifyStrands(t, 'openai', 'parallel_tool_batch'));
test('Strands F09 openai resumed_session', { timeout: 30000 }, t => certifyStrands(t, 'openai', 'resumed_session'));
test('Strands F09 openai every_model_continuation', { timeout: 30000 }, t => certifyStrands(t, 'openai', 'every_model_continuation'));
test('Strands F09 openai cancel_and_close', { timeout: 30000 }, t => certifyStrands(t, 'openai', 'cancel_and_close'));
test('Strands F09 anthropic agent.invoke', { timeout: 30000 }, t => certifyStrands(t, 'anthropic', 'agent.invoke'));
test('Strands F09 anthropic agent.stream', { timeout: 30000 }, t => certifyStrands(t, 'anthropic', 'agent.stream'));
test('Strands F09 anthropic model.structured_output', { timeout: 30000 }, t => certifyStrands(t, 'anthropic', 'model.structured_output'));
test('Strands F09 anthropic parallel_tool_batch', { timeout: 30000 }, t => certifyStrands(t, 'anthropic', 'parallel_tool_batch'));
test('Strands F09 anthropic resumed_session', { timeout: 30000 }, t => certifyStrands(t, 'anthropic', 'resumed_session'));
test('Strands F09 anthropic every_model_continuation', { timeout: 30000 }, t => certifyStrands(t, 'anthropic', 'every_model_continuation'));
test('Strands F09 anthropic cancel_and_close', { timeout: 30000 }, t => certifyStrands(t, 'anthropic', 'cancel_and_close'));
test('Strands F09 bedrock agent.invoke', { timeout: 30000 }, t => certifyStrands(t, 'bedrock', 'agent.invoke'));
test('Strands F09 bedrock agent.stream', { timeout: 30000 }, t => certifyStrands(t, 'bedrock', 'agent.stream'));
test('Strands F09 bedrock model.structured_output', { timeout: 30000 }, t => certifyStrands(t, 'bedrock', 'model.structured_output'));
test('Strands F09 bedrock parallel_tool_batch', { timeout: 30000 }, t => certifyStrands(t, 'bedrock', 'parallel_tool_batch'));
test('Strands F09 bedrock resumed_session', { timeout: 30000 }, t => certifyStrands(t, 'bedrock', 'resumed_session'));
test('Strands F09 bedrock every_model_continuation', { timeout: 30000 }, t => certifyStrands(t, 'bedrock', 'every_model_continuation'));
test('Strands F09 bedrock cancel_and_close', { timeout: 30000 }, t => certifyStrands(t, 'bedrock', 'cancel_and_close'));
