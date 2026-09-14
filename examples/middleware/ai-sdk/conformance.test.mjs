import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createOpenAI } from '@ai-sdk/openai';
import { jsonSchema, streamText, generateText, tool, stepCountIs, wrapLanguageModel } from 'ai';
import { createMiddlewareRuntime } from '../../../packages/sdk/typescript/dist/middleware/index.js';
import { withCaveman, createCavemanMiddleware } from '../../../packages/middleware/typescript/dist/ai-sdk.js';
import { startRuntime } from '../../../packages/middleware/conformance/runtime-fixture.mjs';
import { certifyOrdinary, certifyModelOnly, certifyCancellation } from './certification-native.mjs';

const original = Array.from({ length: 150 }, (_,i) => `[INFO] reading row ${i}: café 🌍 exact-value-${String(i).padStart(3,'0')} verbose repeated details\r\n`).join('')+'[ERROR] preserve diagnostic exactly\r\n';
const scope = { namespace: 'conformance', session_id: 'native-ai-sdk', branch_id: 'main', cache_epoch: '0' };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function providerFixture(handler) {
  const calls = [], errors = [];
  const server = createServer(async (req,res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const wire = Buffer.concat(chunks).toString('utf8');
    const body = JSON.parse(wire);
    calls.push({ body, wire, headers: req.headers });
    try { await handler(body,res,calls.length); } catch (error) { errors.push(error.message); res.destroy(error); }
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  return { calls, errors, url: `http://127.0.0.1:${server.address().port}/v1`, close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
function sse(res) {
  res.writeHead(200, { 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache' });
  return (delta, finish = null) => res.write(`data: ${JSON.stringify({ id:'chatcmpl-fixture', object:'chat.completion.chunk', created:1, model:'fixture-model', choices:[{ index:0, delta, finish_reason:finish }], ...(finish ? { usage:{ prompt_tokens:1000, completion_tokens:20, total_tokens:1020 } } : {}) })}\n\n`);
}
function toolResponse(res, name, args, id) {
  const send = sse(res);
  send({ role:'assistant', tool_calls:[{ index:0, id, type:'function', function:{ name, arguments:JSON.stringify(args) } }] });
  send({},'tool_calls'); res.end('data: [DONE]\n\n');
}

test('native AI SDK tool loop compresses, recovers exact bytes, streams before EOF, and reuses after restart', { timeout: 30000 }, async t => {
  const service = await startRuntime(); t.after(service.stop);
  const receivedFirst = deferred(), releaseFinal = deferred();
  const rpc = [], diagnostics = [];
  const runtime = createMiddlewareRuntime({ endpoint:service.endpoint, onDiagnostic: event=>diagnostics.push(event), fetch:async (url,options) => {
    const response = await fetch(url,options);
    if (url.endsWith('/optimize')) rpc.push({ request:JSON.parse(options.body), response:await response.clone().json() });
    return response;
  }}); t.after(() => runtime.close()); await runtime.ready();
  let released = false, toolExecutions = 0;
  const provider = await providerFixture(async (body,res,step) => {
    assert.equal(body.temperature,0.2);
    assert.equal(body.seed,42);
    if (step===1) return toolResponse(res,'read_logs',{},'read-1');
    const logs = body.messages.find(m => m.role==='tool' && m.tool_call_id==='read-1');
    assert.ok(logs?.content.includes('cmw_'),`native provider step ${step} received a shortened tool result`);
    assert.ok(!logs.content.includes('exact-value-074'),'recovery must provide information actually omitted');
    if (step===2) {
      const handle = logs.content.match(/cmw_[a-f0-9]{48}/)[0];
      return toolResponse(res,'caveman_retrieve',{ handle },'recover-1');
    }
    const recovered = body.messages.find(m => m.role==='tool' && m.tool_call_id==='recover-1');
    const page = JSON.parse(recovered.content);
    assert.equal(page.text,original);
    assert.equal(page.complete,true);
    const send = sse(res); send({ role:'assistant', content:'exact-' });
    if (step===3) { receivedFirst.resolve(); await releaseFinal.promise; released=true; }
    send({ content:'value-074' }); send({},'stop'); res.end('data: [DONE]\n\n');
  }); t.after(provider.close);
  t.after(()=>{if(provider.errors.length) t.diagnostic(JSON.stringify({ errors:provider.errors, diagnostics, calls:provider.calls.map(call=>call.body.messages.map(m=>({role:m.role,id:m.tool_call_id,shortened:typeof m.content==='string'&&m.content.includes('cmw_')}))), rpc:rpc.map(row=>({status:row.response.status,reason:row.response.reason,error:row.response.error,skipped:row.response.skipped,sequence:row.request.sequence})) }));});
  const openai = createOpenAI({ baseURL:provider.url, apiKey:'local-fixture-no-provider-account' });
  // Nested native middleware must leave the outer registered owner in charge.
  const nested = wrapLanguageModel({ model:openai.chat('fixture-model'), middleware:createCavemanMiddleware({ runtime, scope }) });
  const messages = [{ role:'user', content:'Read logs, recover row 74 exactly, and report its value.' }];
  const before = structuredClone(messages);
  const tools = { read_logs:tool({ description:'Read retained source logs.', inputSchema:jsonSchema({ type:'object', properties:{}, additionalProperties:false }), execute:async () => { toolExecutions++; return original; } }) };
  const options = withCaveman({ model:nested, tools, messages, temperature:0.2, seed:42, maxRetries:0, stopWhen:stepCountIs(6) },{ runtime,scope });
  const result = streamText(options);
  const iterator = result.textStream[Symbol.asyncIterator]();
  const first = await Promise.race([iterator.next(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('stream buffered until EOF')),4000))]);
  await receivedFirst.promise;
  assert.equal(first.value,'exact-'); assert.equal(released,false);
  releaseFinal.resolve();
  let answer = first.value;
  for (;;) { const next=await iterator.next();if(next.done)break;answer+=next.value; }
  assert.equal(answer,'exact-value-074');
  assert.equal(toolExecutions,1);
  assert.deepEqual(messages,before);
  const history = [...messages,...await result.responseMessages,{ role:'user',content:'Repeat that value.' }];
  assert.ok(JSON.stringify(history).includes('exact-value-074'),'host history retains originals');
  const compressed = provider.calls[1].body.messages.find(m=>m.tool_call_id==='read-1').content;
  await service.restart();
  const second = streamText(withCaveman({ model:openai.chat('fixture-model'),tools,messages:history,temperature:0.2,seed:42,maxRetries:0,stopWhen:stepCountIs(3) },{ runtime,scope }));
  assert.equal(await second.text,'exact-value-074');
  assert.equal(provider.calls[3].body.messages.find(m=>m.tool_call_id==='read-1').content,compressed);
  for(const call of provider.calls) assert.deepEqual(call.body.tools,provider.calls[0].body.tools,'recovery registration remains prefix-stable');
  const plans = rpc.filter(row=>row.response.status==='optimized');
  assert.equal(plans.length,3,'one selected optimization owner for each call containing logs');
  assert.equal(plans[0].response.measurement.unique_tokens_reduced>0,true);
  assert.ok(plans.slice(1).every(row=>row.response.measurement.unique_tokens_reduced===0));
  assert.ok(plans.every(row=>row.response.measurement.verified_saved_usd===0));
});

test('provider failure stays one native request; schema collision disables lossy path', { timeout:20000 }, async t => {
  const service=await startRuntime();t.after(service.stop);
  const runtime=createMiddlewareRuntime({ endpoint:service.endpoint });t.after(()=>runtime.close());await runtime.ready();
  const provider=await providerFixture(async (body,res)=>{res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'fixture provider failure',type:'server_error'}}));});t.after(provider.close);
  const openai=createOpenAI({baseURL:provider.url,apiKey:'local-fixture-no-provider-account'});
  const existing=tool({inputSchema:jsonSchema({type:'object',properties:{}}),execute:async()=> 'existing application tool'});
  const input={model:openai.chat('fixture-model'),tools:{caveman_retrieve:existing},messages:[{role:'user',content:'Continue.'}],maxRetries:0};
  const wrapped=withCaveman(input,{runtime,scope:{...scope,session_id:'failure'}});
  assert.equal(wrapped.tools.caveman_retrieve,existing);
  await assert.rejects(generateText(wrapped));
  assert.equal(provider.calls.length,1);
});

test('AI SDK F04 openai generateText exact journey', { timeout: 30000 }, t => certifyOrdinary(t, 'openai', 'generateText'));
test('AI SDK F04 anthropic generateText exact journey', { timeout: 30000 }, t => certifyOrdinary(t, 'anthropic', 'generateText'));
test('AI SDK F04 openai streamText exact journey', { timeout: 30000 }, t => certifyOrdinary(t, 'openai', 'streamText'));
test('AI SDK F04 anthropic streamText exact journey', { timeout: 30000 }, t => certifyOrdinary(t, 'anthropic', 'streamText'));
test('AI SDK F04 openai generateText.structured exact journey', { timeout: 30000 }, t => certifyModelOnly(t, 'openai', 'generateText.structured'));
test('AI SDK F04 anthropic generateText.structured exact journey', { timeout: 30000 }, t => certifyModelOnly(t, 'anthropic', 'generateText.structured'));
test('AI SDK F04 openai streamText.structured exact journey', { timeout: 30000 }, t => certifyModelOnly(t, 'openai', 'streamText.structured'));
test('AI SDK F04 anthropic streamText.structured exact journey', { timeout: 30000 }, t => certifyModelOnly(t, 'anthropic', 'streamText.structured'));
test('AI SDK F04 openai public_tool_loop exact journey', { timeout: 30000 }, t => certifyOrdinary(t, 'openai', 'public_tool_loop'));
test('AI SDK F04 anthropic public_tool_loop exact journey', { timeout: 30000 }, t => certifyOrdinary(t, 'anthropic', 'public_tool_loop'));
test('AI SDK F04 openai public_tool_loop.stream exact journey', { timeout: 30000 }, t => certifyOrdinary(t, 'openai', 'public_tool_loop.stream'));
test('AI SDK F04 anthropic public_tool_loop.stream exact journey', { timeout: 30000 }, t => certifyOrdinary(t, 'anthropic', 'public_tool_loop.stream'));
test('AI SDK F04 openai wrapLanguageModel.model_only exact journey', { timeout: 30000 }, t => certifyModelOnly(t, 'openai', 'wrapLanguageModel.model_only'));
test('AI SDK F04 anthropic wrapLanguageModel.model_only exact journey', { timeout: 30000 }, t => certifyModelOnly(t, 'anthropic', 'wrapLanguageModel.model_only'));
test('AI SDK F04 openai nested_provider_client_ownership exact journey', { timeout: 30000 }, t => certifyOrdinary(t, 'openai', 'nested_provider_client_ownership'));
test('AI SDK F04 anthropic nested_provider_client_ownership exact journey', { timeout: 30000 }, t => certifyOrdinary(t, 'anthropic', 'nested_provider_client_ownership'));
test('AI SDK F04 openai cancel_and_close exact journey', { timeout: 30000 }, t => certifyCancellation(t, 'openai'));
test('AI SDK F04 anthropic cancel_and_close exact journey', { timeout: 30000 }, t => certifyCancellation(t, 'anthropic'));
