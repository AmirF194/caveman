import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { createAgent, createMiddleware, humanInTheLoopMiddleware } from 'langchain';
import { MemorySaver, Command } from '@langchain/langgraph';
import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { HumanMessage, AIMessage, ToolMessage, isAIMessage } from '@langchain/core/messages';
import { Document } from '@langchain/core/documents';
import { tool } from '@langchain/core/tools';
import { createMiddlewareRuntime } from '../../../packages/sdk/typescript/dist/middleware/index.js';
import { withCavemanAgent, withCavemanModel, scopeFromConfig, CavemanDocumentCompressor } from '../../../packages/middleware/typescript/dist/langchain.js';
import { startRuntime } from '../../../packages/middleware/conformance/runtime-fixture.mjs';
import './source-expansion.test.mjs';
import { runNativeCertification } from './certification-native.mjs';

const source=Array.from({length:140},(_,i)=>`[INFO] café 🌍 row ${i} retained-detail-${i} long repeated diagnostic\r\n`).join('');
const scope=config=>scopeFromConfig(config,'langchain-native-ts');
const readLogs=tool(async()=>source,{name:'read_logs',description:'Read logs',schema:{type:'object',properties:{},additionalProperties:false}});

test('LangChain F05 OpenAI exact native operation journeys', {timeout:90000}, t => runNativeCertification(t, 'F05', 'openai'));
test('LangChain F05 Anthropic exact native operation journeys', {timeout:90000}, t => runNativeCertification(t, 'F05', 'anthropic'));
test('LangChain F06 OpenAI exact native graph journeys', {timeout:90000}, t => runNativeCertification(t, 'F06', 'openai'));
test('LangChain F06 Anthropic exact native graph journeys', {timeout:90000}, t => runNativeCertification(t, 'F06', 'anthropic'));

test('LangChain passive reports preserve native off opaque and unsupported calls', {timeout:30000}, async t => {
  const directory=mkdtempSync(join(tmpdir(),'caveman-langchain-version-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const modules=join(directory,'node_modules'),framework=join(modules,'langchain');
  mkdirSync(framework,{recursive:true});mkdirSync(join(modules,'@caveman-ai'),{recursive:true});
  writeFileSync(join(directory,'package.json'),JSON.stringify({type:'module'}));
  writeFileSync(join(framework,'package.json'),JSON.stringify({name:'langchain',version:'99.0.0',type:'module',exports:'./index.mjs'}));
  writeFileSync(join(framework,'index.mjs'),`export * from ${JSON.stringify(import.meta.resolve('langchain'))};\n`);
  const core=fileURLToPath(import.meta.resolve('@langchain/core/messages'));
  const namespace=core.lastIndexOf('/@langchain/core/');assert.notEqual(namespace,-1);
  symlinkSync(core.slice(0,namespace+'/@langchain'.length),join(modules,'@langchain'),'dir');
  symlinkSync(fileURLToPath(new URL('../../../packages/sdk/typescript',import.meta.url)),join(modules,'@caveman-ai/sdk'),'dir');
  for(const file of ['langchain.js','langchain-model.js','common.js','versions.js'])cpSync(new URL(`../../../packages/middleware/typescript/dist/${file}`,import.meta.url),join(directory,file));
  const untested=await import(pathToFileURL(join(directory,'langchain.js')).href);
  for(const mode of ['off','opaque','unsupported']){
    const provider=await fixture('openai');t.after(provider.close);
    const reports=[],requests=[];
    const runtime=createMiddlewareRuntime({mode:mode==='off'?'off':'compress',onReport:report=>{reports.push(report);throw new Error('Application report callback failure');},fetch:(...args)=>{requests.push(args);throw new Error('Passive calls cannot use the optimizer');}});t.after(()=>runtime.close());
    const original=new ChatOpenAI({model:'helpers',apiKey:'fixture',configuration:{baseURL:provider.url+'/v1'},maxRetries:0,useResponsesApi:false});
    const opaque=()=> 'caller-owned';
    const input=[new HumanMessage({content:'native',additional_kwargs:mode==='opaque'?{opaque}: {}})];
    const wrap=mode==='unsupported'?untested.withCavemanModel:withCavemanModel;
    const wrapped=wrap(original,{runtime,scope:()=>{throw new Error('Passive calls cannot resolve a recovery scope');}});
    assert.equal(reports.length,0);assert.notEqual(wrapped,original);
    const baseline=await original.invoke(input),value=await wrapped.invoke(input);
    assert.equal(baseline.content,'native');assert.equal(value.content,baseline.content);
    assert.deepEqual(provider.calls[0].body,provider.calls[1].body);
    let text='';for await(const chunk of await wrapped.stream(input))text+=chunk.content;
    assert.equal(text,'native');assert.equal(provider.calls.length,3);assert.equal(reports.length,2);
    const reason=mode==='off'?'disabled':mode==='unsupported'?'unsupported_version':'unsupported_shape';
    assert.ok(reports.every(report=>report.reason===reason&&report.status===(mode==='off'?'disabled':'skipped')&&report.replacement_count===0));
    assert.equal(new Set(reports.map(report=>report.attempt_id)).size,2);assert.equal(runtime.lastReport,reports.at(-1));
    assert.deepEqual(requests,[]);assert.deepEqual(provider.errors,[]);
    if(mode==='opaque')assert.equal(input[0].additional_kwargs.opaque,opaque);
  }
});

async function fixture(protocol){
  const calls=[],errors=[];
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));calls.push({body,headers:req.headers});
    try{
      const results=protocol==='openai'?body.messages.filter(m=>m.role==='tool'):body.messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(p=>p.type==='tool_result');
      const logs=results.find(p=>(p.tool_call_id??p.tool_use_id)==='read-1');
      let name,args={},id,content=null;
      if(body.model==='helpers')content='native';
      else if(body.model==='parse')content='{"answer":42}';
      else if(!logs){name='read_logs';id='read-1';}
      else{
        const handle=logs.content.match(/cmw_[a-f0-9]{48}/)?.[0];assert.ok(handle,'native LangChain source result shortened');assert.ok(!logs.content.includes('retained-detail-70'));
        const recovered=results.find(p=>(p.tool_call_id??p.tool_use_id)==='recover-1');
        if(!recovered){name='caveman_retrieve';args={handle};id='recover-1';}
        else{let page;try{page=JSON.parse(recovered.content);}catch{throw new Error(`Native recovery failed: ${recovered.content.slice(0,500)}`);}assert.equal(page.text,source);content='retained-detail-70';}
      }
      if(protocol==='openai'){
        if(body.stream){
          res.writeHead(200,{'Content-Type':'text/event-stream'});
          const event={id:`fixture-${calls.length}`,object:'chat.completion.chunk',model:body.model,created:1};
          res.write(`data: ${JSON.stringify({...event,choices:[{index:0,delta:{role:'assistant',content:'nat'},finish_reason:null}]})}\n\n`);
          await new Promise(resolve=>setTimeout(resolve,20));
          res.end(`data: ${JSON.stringify({...event,choices:[{index:0,delta:{content:'ive'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}})}\n\ndata: [DONE]\n\n`);return;
        }
        const message={role:'assistant',content,...(name?{tool_calls:[{id,type:'function',function:{name,arguments:JSON.stringify(args)}}]}:{})};
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:`fixture-${calls.length}`,object:'chat.completion',model:body.model,created:1,choices:[{index:0,message,finish_reason:name?'tool_calls':'stop',logprobs:null}],usage:{prompt_tokens:1000,completion_tokens:20,total_tokens:1020}}));
      }else{
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:`fixture-${calls.length}`,type:'message',role:'assistant',model:body.model,content:name?[{type:'tool_use',id,name,input:args}]:[{type:'text',text:content}],stop_reason:name?'tool_use':'end_turn',stop_sequence:null,usage:{input_tokens:1000,output_tokens:20}}));
      }
    }catch(error){errors.push(error.message);res.destroy(error);}
  });server.listen(0,'127.0.0.1');await once(server,'listening');
  return {calls,errors,url:`http://127.0.0.1:${server.address().port}`,close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})};
}

test('native LangChain and LangGraph tool nodes preserve checkpoint state across threads, restart, branch and interrupt', {timeout:30000},async t=>{
  const service=await startRuntime();t.after(service.stop);
  const rpc=[];
  const runtime=createMiddlewareRuntime({endpoint:service.endpoint,fetch:async(url,options)=>{const r=await fetch(url,options);if(url.endsWith('/optimize'))rpc.push(await r.clone().json());return r;}});t.after(()=>runtime.close());await runtime.ready();
  const provider=await fixture('openai');t.after(provider.close);
  t.after(()=>{if(provider.errors.length)t.diagnostic(JSON.stringify({errors:provider.errors,requests:provider.calls.map(c=>c.body.messages.map(m=>({role:m.role,id:m.tool_call_id,shortened:typeof m.content==='string'&&m.content.includes('cmw_')}))),rpc:rpc.map(p=>({status:p.status,reason:p.reason,skipped:p.skipped,error:p.error}))}));});
  const model=withCavemanModel(new ChatOpenAI({model:'fixture-model',apiKey:'fixture',configuration:{baseURL:provider.url+'/v1'},maxRetries:0,useResponsesApi:false}),{runtime,scope});
  const input={messages:[new HumanMessage({content:'Read logs and recover row 70',id:'user-original'})]};
  const before=input.messages.map(m=>m.toDict());
  const agent=createAgent(withCavemanAgent({model,tools:[readLogs],checkpointer:new MemorySaver()},{runtime,scope}));
  const configA={configurable:{thread_id:'a'}},configB={configurable:{thread_id:'b'}};
  const a=await agent.invoke(input,configA),b=await agent.invoke(input,configB);
  assert.equal(a.messages.at(-1).content,'retained-detail-70');assert.equal(b.messages.at(-1).content,'retained-detail-70');
  assert.deepEqual(input.messages.map(m=>m.toDict()),before);
  const state=await agent.getState(configA);
  assert.equal(state.values.messages.find(m=>m.type==='tool'&&m.name==='read_logs').content,source);
  const first=provider.calls[1].body.messages.find(m=>m.role==='tool').content;
  const other=provider.calls[4].body.messages.find(m=>m.role==='tool').content;
  assert.notEqual(first,other);
  await service.restart();
  const resumed=await agent.invoke({messages:[new HumanMessage('Repeat')]},configA);assert.equal(resumed.messages.at(-1).content,'retained-detail-70');
  assert.equal(provider.calls.at(-1).body.messages.find(m=>m.role==='tool').content,first);
  await agent.invoke({messages:[new HumanMessage('Fork')]},{configurable:{...state.config.configurable,caveman_branch_id:'fork'}});
  const approval=humanInTheLoopMiddleware({interruptOn:{read_logs:true,caveman_retrieve:true}});
  const paused=createAgent(withCavemanAgent({model,tools:[readLogs],checkpointer:new MemorySaver(),middleware:[approval]},{runtime,scope}));
  const config={configurable:{thread_id:'interrupted'}};
  const interrupted=await paused.invoke(input,config);assert.ok(interrupted.__interrupt__?.length);
  const resumedTool=await paused.invoke(new Command({resume:{decisions:[{type:'approve'}]}}),config);
  assert.ok(resumedTool.__interrupt__?.length,'recovery still passes through native approval');
  assert.equal((await paused.invoke(new Command({resume:{decisions:[{type:'approve'}]}}),config)).messages.at(-1).content,'retained-detail-70');
  assert.deepEqual(provider.errors,[]);
  assert.equal(rpc.filter(r=>r.status==='optimized').length,8,'one optimizer owner per tool-bearing outbound call');
});

test('native LangChain Anthropic path executes scoped recovery', {timeout:20000},async t=>{
  const service=await startRuntime();t.after(service.stop);
  const runtime=createMiddlewareRuntime({endpoint:service.endpoint});t.after(()=>runtime.close());await runtime.ready();
  const provider=await fixture('anthropic');t.after(provider.close);
  t.after(()=>{if(provider.errors.length)t.diagnostic(JSON.stringify({errors:provider.errors,requests:provider.calls.map(c=>c.body.messages.map(m=>({role:m.role,parts:Array.isArray(m.content)?m.content.map(p=>({type:p.type,id:p.tool_use_id,shortened:typeof p.content==='string'&&p.content.includes('cmw_')})):[]})))}));});
  const model=new ChatAnthropic({model:'fixture-model',apiKey:'fixture',clientOptions:{baseURL:provider.url},maxRetries:0,maxTokens:100});
  const agent=createAgent(withCavemanAgent({model,tools:[readLogs]},{runtime,scope:{namespace:'langchain-ts',session_id:'anthropic',branch_id:'main',cache_epoch:'0'}}));
  const result=await agent.invoke({messages:[new HumanMessage('Read and recover')]});
  if(result.messages.at(-1).content!=='retained-detail-70')t.diagnostic(JSON.stringify({calls:provider.calls.length,errors:provider.errors,returnDirect:readLogs.returnDirect,result:result.messages.map(m=>({type:m.type,name:m.name,tools:m.tool_calls?.map(c=>c.name)}))}));
  assert.equal(result.messages.at(-1).content,'retained-detail-70');
  assert.equal(provider.calls.length,3);assert.deepEqual(provider.errors,[]);
});

test('native model helper binding, batch, streaming, callbacks and document views survive', {timeout:20000},async t=>{
  const service=await startRuntime();t.after(service.stop);
  const runtime=createMiddlewareRuntime({endpoint:service.endpoint});t.after(()=>runtime.close());await runtime.ready();
  const provider=await fixture('openai');t.after(provider.close);
  const model=new ChatOpenAI({model:'helpers',apiKey:'fixture',configuration:{baseURL:provider.url+'/v1'},maxRetries:0,useResponsesApi:false});
  const native=withCavemanModel(model,{runtime,scope});
  const input=[new HumanMessage('Read'),new AIMessage({content:'',tool_calls:[{name:'read_logs',args:{},id:'read-1',type:'tool_call'}]}),new ToolMessage({content:source,tool_call_id:'read-1',name:'read_logs',artifact:{source:'document-1'}})];
  const before=input.map(m=>m.toDict()),tags=[];
  const config={configurable:{thread_id:'direct'},tags:['caller-tag'],callbacks:[{handleChatModelStart(_model,_messages,_runId,_parent,_extra,received){tags.push(...(received??[]));}}]};
  assert.equal((await native.bindTools([readLogs]).invoke(input,config)).content,'native');
  assert.ok(tags.includes('caller-tag'));assert.deepEqual(input.map(m=>m.toDict()),before);
  assert.equal(provider.calls.at(-1).body.messages.at(-1).content,source,'model-only path has no lossy executor');
  assert.deepEqual((await native.batch([input,input],[{configurable:{thread_id:'batch-a'}},{configurable:{thread_id:'batch-b'}}])).map(m=>m.content),['native','native']);
  let content='';for await(const message of await native.stream(input,config))content+=message.content;assert.equal(content,'native');
  const structured=withCavemanModel(new ChatOpenAI({model:'parse',apiKey:'fixture',configuration:{baseURL:provider.url+'/v1'},maxRetries:0,useResponsesApi:false}),{runtime,scope:{namespace:'langchain-ts',session_id:'structured',branch_id:'main',cache_epoch:'0'}});
  assert.deepEqual(await structured.withStructuredOutput({type:'object',properties:{answer:{type:'number'}},required:['answer'],additionalProperties:false},{method:'jsonSchema',name:'Answer'}).invoke('Return JSON'),{answer:42});
  const documents=[new Document({id:'a',pageContent:source,metadata:{source:'a'}}),new Document({id:'b',pageContent:source,metadata:{source:'b'}})];
  const compressor=new CavemanDocumentCompressor({runtime,scope:{namespace:'langchain-ts',session_id:'rag',branch_id:'main',cache_epoch:'0'}});
  assert.deepEqual(await compressor.compressDocuments(documents,'row70'),documents);assert.deepEqual(provider.errors,[]);
});
