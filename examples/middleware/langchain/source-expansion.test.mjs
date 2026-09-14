import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createAgent } from 'langchain';
import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { HumanMessage, AIMessage, ToolMessage, isAIMessage } from '@langchain/core/messages';
import { BaseRetriever } from '@langchain/core/retrievers';
import { Document } from '@langchain/core/documents';
import { tool } from '@langchain/core/tools';
import { createMiddlewareRuntime, recoveryInputSchema } from '../../../packages/sdk/typescript/dist/middleware/index.js';
import { CavemanDocumentCompressor, createCavemanLangChain } from '../../../packages/middleware/typescript/dist/langchain.js';
import { startRuntime } from '../../../packages/middleware/conformance/runtime-fixture.mjs';

const source=Array.from({length:140},(_,i)=>`[INFO] café 🌍 row ${i} retained-detail-${i} long repeated diagnostic\r\n`).join('');
const final='retained-detail-70 [source-a] [source-b]';
const scoped=session_id=>({namespace:'langchain-rag-ts',session_id,branch_id:'main',cache_epoch:'0'});
const documents=()=>[
  new Document({id:'source-a',pageContent:source,metadata:{source:'a.md',citation:{page:1}}}),
  new Document({id:'source-b',pageContent:source,metadata:{source:'b.md',citation:{page:2}}}),
  new Document({id:'source-c',pageContent:'Short supporting source.',metadata:{source:'c.md'}}),
];
const documentViews=docs=>docs.map(d=>({id:d.id,metadata:d.metadata,text:d.pageContent}));

async function recordEvidence(mode,protocol,provider,retriever,views){
  const directory=process.env.CAVEMAN_LANGCHAIN_EVIDENCE_DIR;if(!directory)return;
  const digest=value=>createHash('sha256').update(value).digest('hex');
  const record={schema_version:1,integration_id:'F05',language:'typescript',mode,provider:protocol,evidence_class:'installed_framework_local_http_real_engine',
    provider_calls:provider.calls.length,streaming_requests:provider.calls.filter(c=>c.stream).length,
    provider_request_json_sha256:provider.calls.map(c=>digest(JSON.stringify(c))),original_documents_unchanged:JSON.stringify(retriever.documents)===JSON.stringify(documents()),
    native_document_copies:views[0].every(d=>d instanceof Document),document_order:views[0].map(d=>d.id),metadata_preserved:JSON.stringify(views[0].map(d=>d.metadata))===JSON.stringify(documents().map(d=>d.metadata)),
    sources:provider.pages.map((p,i)=>({source_id:p.source_id,handle:p.handle,original_sha256:p.original_sha256,recovered_sha256:digest(p.text),recovered_utf8_bytes:Buffer.byteLength(p.text),complete:p.complete,compressed_view_sha256:digest(views[0][i].pageContent)})),
    text_before_provider_completion:mode==='async-stream'?provider.released:null};
  await mkdir(directory,{recursive:true});await writeFile(join(directory,`typescript-${mode}-${protocol}.json`),JSON.stringify(record,null,2)+'\n');
}

class FixtureRetriever extends BaseRetriever{
  lc_namespace=['application','fixture-retriever'];
  documents=documents();calls=[];
  async _getRelevantDocuments(query){this.calls.push(query);return this.documents;}
}

async function ragFixture(protocol,compressed=true){
  const fixture={calls:[],errors:[],handles:[],pages:[],released:false,finished:false};
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));fixture.calls.push(body);
    try{
      const results=protocol==='openai'?body.messages.filter(m=>m.role==='tool'):body.messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(p=>p.type==='tool_result');
      const key=protocol==='openai'?'tool_call_id':'tool_use_id';
      const search=results.find(m=>m[key]==='search-1');let calls=[],text=null;
      if(body.model==='helpers')text='native';
      else if(!search)calls=[{id:'search-1',name:'search_documents',args:{query:'What is row 70?'}}];
      else{
        const views=JSON.parse(search.content);
        assert.deepEqual(views.map(d=>d.id),['source-a','source-b','source-c']);
        assert.deepEqual(views.map(d=>d.metadata),documents().map(d=>d.metadata));
        if(!compressed){assert.deepEqual(views,documentViews(documents()));text=final;}
        else{
          fixture.handles=views.slice(0,2).map(d=>d.text.match(/cmw_[a-f0-9]{48}/)?.[0]);
          assert.ok(fixture.handles.every(Boolean),'retrieved documents must reach the provider compressed');
          assert.equal(new Set(fixture.handles).size,2,'duplicate text retains independent source grants');
          assert.ok(views.slice(0,2).every(d=>!d.text.includes('retained-detail-70')));
          assert.equal(views[2].text,documents()[2].pageContent);
          const expanded=[0,1].map(i=>results.find(m=>m[key]===`expand-${i}`));
          if(!expanded.every(Boolean))calls=fixture.handles.map((handle,i)=>({id:`expand-${i}`,name:'caveman_retrieve',args:{handle}}));
          else{
            fixture.pages=expanded.map(m=>JSON.parse(m.content));
            assert.deepEqual(fixture.pages.map(p=>p.source_id),['source-a','source-b']);
            for(const page of fixture.pages){
              assert.deepEqual(Buffer.from(page.text),Buffer.from(source));assert.equal(page.complete,true);
              assert.equal(page.original_sha256,createHash('sha256').update(source).digest('hex'));
            }
            text=final;
          }
        }
      }
      if(protocol==='openai'){
        const base={id:`rag-fixture-${fixture.calls.length}`,model:body.model,created:1};
        if(body.stream){
          res.writeHead(200,{'content-type':'text/event-stream'});
          const event=(delta,finish_reason=null)=>`data: ${JSON.stringify({...base,object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason}]})}\n\n`;
          if(calls.length)res.write(event({role:'assistant',tool_calls:calls.map((c,index)=>({index,id:c.id,type:'function',function:{name:c.name,arguments:JSON.stringify(c.args)}}))}));
          else{
            res.write(event({role:'assistant',content:'retained-'}));
            const deadline=Date.now()+5000;while(!fixture.released&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
            assert.ok(fixture.released,'native agent stream delivers text before provider completion');
            fixture.finished=true;res.write(event({content:'detail-70 [source-a] [source-b]'}));
          }
          res.end(event({},calls.length?'tool_calls':'stop')+'data: [DONE]\n\n');return;
        }
        const message={role:'assistant',content:text,...(calls.length?{tool_calls:calls.map(c=>({id:c.id,type:'function',function:{name:c.name,arguments:JSON.stringify(c.args)}}))}:{})};
        res.setHeader('content-type','application/json');res.end(JSON.stringify({...base,object:'chat.completion',choices:[{index:0,message,finish_reason:calls.length?'tool_calls':'stop',logprobs:null}],usage:{prompt_tokens:1000,completion_tokens:20,total_tokens:1020}}));
      }else{
        const message={id:`rag-fixture-${fixture.calls.length}`,type:'message',role:'assistant',model:body.model,content:calls.length?calls.map(c=>({type:'tool_use',id:c.id,name:c.name,input:c.args})):[{type:'text',text}],stop_reason:calls.length?'tool_use':'end_turn',stop_sequence:null,usage:{input_tokens:1000,output_tokens:20}};
        if(body.stream){
          res.writeHead(200,{'content-type':'text/event-stream'});
          const event=(type,fields={})=>`event: ${type}\ndata: ${JSON.stringify({type,...fields})}\n\n`;
          res.write(event('message_start',{message:{...message,content:[],stop_reason:null}}));
          for(const [index,part] of message.content.entries()){
            if(part.type==='tool_use'){
              res.write(event('content_block_start',{index,content_block:{...part,input:{}}}));
              res.write(event('content_block_delta',{index,delta:{type:'input_json_delta',partial_json:JSON.stringify(part.input)}}));
            }else{
              res.write(event('content_block_start',{index,content_block:{type:'text',text:''}}));
              res.write(event('content_block_delta',{index,delta:{type:'text_delta',text:'retained-'}}));
              const deadline=Date.now()+5000;while(!fixture.released&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
              assert.ok(fixture.released,'native agent stream delivers text before provider completion');
              fixture.finished=true;res.write(event('content_block_delta',{index,delta:{type:'text_delta',text:'detail-70 [source-a] [source-b]'}}));
            }
            res.write(event('content_block_stop',{index}));
          }
          res.end(event('message_delta',{delta:{stop_reason:message.stop_reason,stop_sequence:null},usage:{output_tokens:20}})+event('message_stop'));return;
        }
        res.setHeader('content-type','application/json');res.end(JSON.stringify(message));
      }
    }catch(error){fixture.errors.push(error.message);res.destroy(error);}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  return {...fixture,get calls(){return fixture.calls;},get errors(){return fixture.errors;},get pages(){return fixture.pages;},get handles(){return fixture.handles;},get finished(){return fixture.finished;},get released(){return fixture.released;},release(){fixture.released=true;},
    url:`http://127.0.0.1:${server.address().port}`,close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})};
}

function modelFor(protocol,provider){
  return protocol==='openai'?new ChatOpenAI({model:'rag-model',apiKey:'fixture',configuration:{baseURL:provider.url+'/v1'},maxRetries:0,useResponsesApi:false}):
    new ChatAnthropic({model:'rag-model',apiKey:'fixture',clientOptions:{baseURL:provider.url},maxRetries:0,maxTokens:200});
}

function ragAgent(runtime,scope,model,expansion=true){
  const retriever=new FixtureRetriever({}),reader=runtime.recovery(scope),views=[];
  const compressor=new CavemanDocumentCompressor({runtime,scope,...(expansion?{sourceExpansion:reader}:{})});
  const search=tool(async({query},config)=>{
    const original=await retriever.invoke(query,config),view=await compressor.compressDocuments(original,query);
    views.push(view);return [JSON.stringify(documentViews(view)),original];
  },{name:'search_documents',description:'Search application sources.',returnDirect:false,responseFormat:'content_and_artifact',schema:{type:'object',properties:{query:{type:'string'}},required:['query'],additionalProperties:false}});
  const expand=tool(async(args,config)=>JSON.stringify(await reader.execute(args,{signal:config?.signal})),{name:reader.name,description:reader.description,schema:structuredClone(reader.inputSchema)});
  return {agent:createAgent({model,tools:[search,...(expansion?[expand]:[])]}),retriever,reader,views};
}

for(const protocol of ['openai','anthropic']){
  test(`native ${protocol} RAG source expansion preserves duplicate citations, originals, and exact scoped paging`,{timeout:20000},async t=>{
    const service=await startRuntime();t.after(service.stop);
    const runtime=createMiddlewareRuntime({endpoint:service.endpoint,deadlineMs:1000});t.after(()=>runtime.close());await runtime.ready();
    const provider=await ragFixture(protocol);t.after(provider.close);t.after(()=>{if(provider.errors.length)t.diagnostic(provider.errors.join('\n'));});
    const scope=scoped(protocol),{agent,retriever,reader,views}=ragAgent(runtime,scope,modelFor(protocol,provider));
    const result=await agent.invoke({messages:[new HumanMessage('Find row 70 with both citations')]});
    assert.equal(result.messages.at(-1).content,final);assert.deepEqual(retriever.documents,documents());
    assert.deepEqual(result.messages.find(m=>m.type==='tool'&&m.name==='search_documents').artifact,documents());
    assert.ok(views[0].every(d=>d instanceof Document));assert.deepEqual(views[0].map(d=>d.id),documents().map(d=>d.id));
    assert.deepEqual(views[0].map(d=>d.metadata),documents().map(d=>d.metadata));
    assert.notEqual(views[0][0],retriever.documents[0]);assert.equal(views[0][0].metadata,retriever.documents[0].metadata);
    assert.equal(provider.calls.length,3);assert.deepEqual(provider.errors,[]);
    let offset=0;const chunks=[];
    while(offset!==null){const page=await reader.execute({handle:provider.handles[0],offset,limit:1021});chunks.push(page.text);offset=page.next_offset;}
    assert.deepEqual(Buffer.from(chunks.join('')),Buffer.from(source));
    await assert.rejects(runtime.recovery({...scope,branch_id:'other'}).execute({handle:provider.handles[0]}),error=>error.code==='not_found');
    await recordEvidence('async',protocol,provider,retriever,views);
  });

  test(`native ${protocol} RAG stream delivers text before provider completion`,{timeout:20000},async t=>{
    const service=await startRuntime();t.after(service.stop);
    const runtime=createMiddlewareRuntime({endpoint:service.endpoint,deadlineMs:1000});t.after(()=>runtime.close());await runtime.ready();
    const provider=await ragFixture(protocol);t.after(provider.close);t.after(()=>{if(provider.errors.length)t.diagnostic(provider.errors.join('\n'));});
    const {agent,retriever,views}=ragAgent(runtime,scoped('stream-'+protocol),modelFor(protocol,provider));
    let text='';
    for await(const [message] of await agent.stream({messages:[new HumanMessage('Find row 70 with both citations')]},{streamMode:'messages'})){
      if(!isAIMessage(message))continue;
      const value=typeof message.content==='string'?message.content:message.content.filter(p=>p.type==='text').map(p=>p.text).join('');
      if(value==='retained-'){assert.equal(provider.finished,false);provider.release();}text+=value;
    }
    assert.equal(text,final);assert.equal(provider.finished,true);assert.deepEqual(provider.errors,[]);
    assert.deepEqual(retriever.documents,documents());assert.deepEqual(views[0].map(d=>d.id),['source-a','source-b','source-c']);
    await recordEvidence('async-stream',protocol,provider,retriever,views);
  });

  test(`native ${protocol} default RAG sends original documents without source expansion`,{timeout:15000},async t=>{
    const service=await startRuntime();t.after(service.stop);
    const runtime=createMiddlewareRuntime({endpoint:service.endpoint,deadlineMs:1000});t.after(()=>runtime.close());await runtime.ready();
    const provider=await ragFixture(protocol,false);t.after(provider.close);
    const {agent,retriever,views}=ragAgent(runtime,scoped('default-'+protocol),modelFor(protocol,provider),false);
    const result=await agent.invoke({messages:[new HumanMessage('Find row 70 with both citations')]});
    if(result.messages.at(-1).content!==final)t.diagnostic(JSON.stringify({messages:result.messages.map(m=>({type:m.type,name:m.name})),calls:provider.calls.length,errors:provider.errors}));
    assert.equal(result.messages.at(-1).content===final,true);assert.deepEqual(views[0],retriever.documents);assert.equal(provider.calls.length,2);assert.deepEqual(provider.errors,[]);
  });
}

test('source expansion rejects booleans, schemas, callbacks, lookalikes, other runtimes and other scopes',{timeout:20000},async t=>{
  const service=await startRuntime();t.after(service.stop);
  const runtime=createMiddlewareRuntime({endpoint:service.endpoint,deadlineMs:1000}),other=createMiddlewareRuntime({endpoint:service.endpoint});
  t.after(()=>runtime.close());t.after(()=>other.close());await runtime.ready();
  const scope=scoped('invalid'),reader=runtime.recovery(scope);
  for(const sourceExpansion of [undefined,true,structuredClone(recoveryInputSchema),async()=>source,{...reader},other.recovery(scope),runtime.recovery(scoped('foreign'))]){
    const docs=documents(),view=await new CavemanDocumentCompressor({runtime,scope,sourceExpansion}).compressDocuments(docs,'row70');
    assert.deepEqual(view,docs);assert.ok(view.every((d,i)=>d===docs[i]));
  }
  for(const [mode,endpoint] of [['off',service.endpoint],['record',service.endpoint],['compress','http://127.0.0.1:1']]){
    const control=createMiddlewareRuntime({mode,endpoint});t.after(()=>control.close());const docs=documents();
    assert.deepEqual(await new CavemanDocumentCompressor({runtime:control,scope,sourceExpansion:control.recovery(scope)}).compressDocuments(docs,'row70'),docs);
  }
});

test('mutated native recovery tool contract cannot keep authorizing lossy provider text',{timeout:20000},async t=>{
  const service=await startRuntime();t.after(service.stop);
  const runtime=createMiddlewareRuntime({endpoint:service.endpoint,deadlineMs:1000});t.after(()=>runtime.close());await runtime.ready();
  const mutations={name:t=>{t.name='other_reader';},description:t=>{t.description='Changed contract';},schema:t=>{t.schema.properties.handle.type='integer';},func:t=>{t.func=async()=> 'unrelated';},invoke:t=>{t.invoke=async()=> 'unrelated';},call:t=>{t.call=async()=> 'unrelated';},returnDirect:t=>{t.returnDirect=true;}};
  for(const [name,mutate] of Object.entries(mutations)){
    const provider=await ragFixture('openai');
    try{
      const {middleware,recoveryTool}=createCavemanLangChain({runtime,scope:scoped('mutated-'+name)});mutate(recoveryTool);
      const model=new ChatOpenAI({model:'helpers',apiKey:'fixture',configuration:{baseURL:provider.url+'/v1'},maxRetries:0,useResponsesApi:false});
      const agent=createAgent({model,tools:[recoveryTool],middleware:[middleware]});
      await agent.invoke({messages:[new HumanMessage('Read'),new AIMessage({content:'',tool_calls:[{name:'read_logs',args:{},id:'read-1',type:'tool_call'}]}),new ToolMessage({content:source,tool_call_id:'read-1',name:'read_logs'})]});
      assert.equal(provider.calls.at(-1).messages.at(-1).content,source,name);assert.deepEqual(provider.errors,[]);
    }finally{await provider.close();}
  }
  assert.equal(recoveryInputSchema.properties.handle.type,'string');
});
