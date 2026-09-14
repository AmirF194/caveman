import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test, { after } from 'node:test';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { MockMemory } from '@mastra/core/memory';
import { InMemoryStore } from '@mastra/core/storage';
import { Mastra } from '@mastra/core/mastra';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { RequestContext } from '@mastra/core/request-context';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { wrapLanguageModel } from 'ai';
import { z } from 'zod';
import { createMiddlewareRuntime } from '../../../packages/sdk/typescript/dist/middleware/index.js';
import { createCavemanMastraProcessor, withCavemanMastra } from '../../../packages/middleware/typescript/dist/mastra.js';
import { createCavemanMiddleware } from '../../../packages/middleware/typescript/dist/ai-sdk.js';
import { startRuntime } from '../../../packages/middleware/conformance/runtime-fixture.mjs';
import { beginNativeCertification, emitJourney } from './certification-evidence.mjs';

const source = Array.from({ length: 160 }, (_, i) => `[INFO] café 🌍 row ${i}: omitted-detail-${i} verbose repeated diagnostic data\r\n`).join('');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const proof = { schema_version: 1, generated_at: new Date().toISOString(), evidence_class: 'native_framework_local_provider_fixtures_real_runtime', framework: { name: '@mastra/core', version: '1.65.0' }, source: { utf8_bytes: Buffer.byteLength(source), sha256: sha256(source), encoding: 'UTF-8, CRLF, emoji and accented text', omitted_detail: 'omitted-detail-80' }, scenarios: [], lifecycle: [] };
after(() => {
  if (!process.env.CAVEMAN_MASTRA_EVIDENCE) return;
  const runtime = process.env.CAVEMAN_MIDDLEWARE_TEST_BINARY;
  proof.runtime = runtime ? { sha256: sha256(readFileSync(runtime)) } : null;
  proof.lock_sha256 = sha256(readFileSync(new URL('./package-lock.json', import.meta.url)));
  proof.adapter_sha256 = sha256(readFileSync(new URL('../../../packages/middleware/typescript/src/mastra.ts', import.meta.url)));
  writeFileSync(process.env.CAVEMAN_MASTRA_EVIDENCE, `${JSON.stringify(proof, null, 2)}\n`);
});
const scope = session => ({ namespace: 'native-mastra', session_id: session, branch_id: 'main', cache_epoch: '0' });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const hasOriginal = value => JSON.stringify(value).includes(JSON.stringify(source).slice(1, -1));
const toolResults = (body, family) => family === 'openai'
  ? body.messages.filter(message => message.role === 'tool').map(message => ({ id: message.tool_call_id, text: message.content }))
  : body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(part => part.type === 'tool_result').map(part => ({ id: part.tool_use_id, text: typeof part.content === 'string' ? part.content : part.content.map(part => part.text).join('') }));

async function provider(t, family, mode = 'compress') {
  const state = { calls: [], responses: [], errors: [], release: null, released: false, closed: false };
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8'), body = JSON.parse(raw);
    state.calls.push({ body, raw, headers: req.headers });
    try {
      if (body.model === 'failure' || (body.model === 'retry-once' && state.calls.length === 1)) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'native fixture error', type: 'api_error' } })); return; }
      const results = toolResults(body, family);
      const log = results.find(result => result.id === 'read-1');
      let tool, text = 'omitted-detail-80';
      if (body.model === 'helpers' || body.model === 'cancel') text = 'native';
      else if (['structured', 'structured-journey'].includes(body.model)) {
        const answer = body.model === 'structured' ? 'native' : 'omitted-detail-80';
        if (family === 'anthropic' && body.tools?.some(tool => tool.name === 'json')) tool = { name: 'json', args: { answer }, id: 'structured-result' };
        else text = JSON.stringify({ answer });
      }
      else if (!log) tool = { name: 'read_logs', args: {}, id: 'read-1' };
      else if (mode !== 'compress' || body.model === 'seed-original') assert.equal(log.text, source);
      else {
        const handle = log.text.match(/cmw_[a-f0-9]{48}/)?.[0];
        assert.ok(handle, `Mastra ${family} native continuation must receive shortened logs`);
        assert.ok(!log.text.includes('omitted-detail-80'));
        const recovery = results.find(result => result.id === 'recover-1');
        if (!recovery) tool = { name: 'caveman_retrieve', args: { handle }, id: 'recover-1' };
        else { assert.equal(JSON.parse(recovery.text).text, source); assert.equal(JSON.parse(recovery.text).complete, true); }
      }
      state.responses.push({ tool: tool ? structuredClone(tool) : null, text: tool ? null : text });
      const finish = tool ? 'tool_calls' : 'stop';
      if (family === 'openai') {
        const message = tool ? { role: 'assistant', content: null, tool_calls: [{ id: tool.id, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : { role: 'assistant', content: text };
        const usage = { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020, prompt_tokens_details: { cached_tokens: 100 } };
        if (!body.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'chatcmpl-mastra', object: 'chat.completion', created: 1, model: body.model, choices: [{ index: 0, message, finish_reason: finish }], usage })); return; }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'chatcmpl-mastra', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage } : {}) })}\n\n`);
        if (tool) send({ role: 'assistant', tool_calls: [{ index: 0, id: tool.id, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] });
        else {
          send({ role: 'assistant', content: text.slice(0, 7) });
          if (body.model === 'journey-cancel' || (mode === 'compress' && ['fixture-model', 'cancel'].includes(body.model))) {
            res.on('close', () => { state.closed = true; state.release?.(); });
            await new Promise(resolve => { state.release = () => { state.released = true; resolve(); }; });
          }
          send({ content: text.slice(7) });
        }
        send({}, finish); res.end('data: [DONE]\n\n');
      } else {
        const content = tool ? [{ type: 'tool_use', name: tool.name, input: tool.args, id: tool.id }] : [{ type: 'text', text }];
        const message = { id: 'msg-mastra', type: 'message', role: 'assistant', model: body.model, content, stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } };
        if (!body.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(message)); return; }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (type, fields) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
        send('message_start', { message: { ...message, content: [], stop_reason: null } });
        if (tool) {
          send('content_block_start', { index: 0, content_block: { ...content[0], input: {} } });
          send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.args) } });
        } else {
          send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
          send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(0, 7) } });
          if (body.model === 'journey-cancel' || (mode === 'compress' && ['fixture-model', 'cancel'].includes(body.model))) {
            res.on('close', () => { state.closed = true; state.release?.(); });
            await new Promise(resolve => { state.release = () => { state.released = true; resolve(); }; });
          }
          send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(7) } });
        }
        send('content_block_stop', { index: 0 });
        send('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 20 } });
        send('message_stop', {}); res.end();
      }
    } catch (error) { state.errors.push(error.message); res.destroy(error); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { state.release?.(); server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  return { state, model: modelId => family === 'openai' ? createOpenAI({ baseURL: url, apiKey: 'native-fixture-key' }).chat(modelId) : createAnthropic({ baseURL: url, apiKey: 'native-fixture-key' })(modelId) };
}

async function setup(t, family, operation, mode = 'compress') {
  const service = mode === 'compress' || mode === 'record' ? await startRuntime({ mode }) : null; if (service) t.after(service.stop);
  const rpc = [], receipts = [], diagnostics = [], retrievals = [], fetchAttempts = [], reports = [];
  // Functional native interoperability tolerates local scheduling contention;
  // production defaults and the separate latency oracle remain unchanged.
  const runtime = createMiddlewareRuntime({ endpoint: service?.endpoint ?? 'http://127.0.0.1:1', deadlineMs: 1000, mode: ['off', 'record'].includes(mode) ? mode : 'compress', onDiagnostic: event => diagnostics.push(event), onReport: report => reports.push(report), fetch: async (url, options) => {
    fetchAttempts.push({ path: new URL(url).pathname });
    const response = await fetch(url, options);
    if (url.endsWith('/optimize')) rpc.push({ request: JSON.parse(options.body), response: await response.clone().json() });
    if (url.endsWith('/retrieve')) retrievals.push({ request: JSON.parse(options.body), response: await response.clone().json() });
    if (url.endsWith('/receipts')) receipts.push(JSON.parse(options.body));
    return response;
  } }); t.after(() => runtime.close()); const capabilities = service ? await runtime.ready() : null;
  const fixture = await provider(t, family, mode), selectedScope = scope(`${family}-${operation}-${mode}`);
  const middleware = createCavemanMastraProcessor({ runtime, scope: selectedScope });
  const stored = new InMemoryStore(), memory = new MockMemory({ storage: stored, enableMessageHistory: true, options: { lastMessages: 100 } });
  let reads = 0;
  const readResults = [], inputSteps = [];
  const read = createTool({ id: 'read_logs', description: 'Read the diagnostic log.', inputSchema: z.object({}), execute: async () => { reads++; readResults.push(source); return source; } });
  const nested = wrapLanguageModel({ model: fixture.model('fixture-model'), middleware: createCavemanMiddleware({ runtime, scope: selectedScope }) });
  const history = [];
  const capture = { id: 'native-history-capture', processOutputResult({ messageList }) { history.push({ db: structuredClone(messageList.get.all.db()), ui: structuredClone(messageList.get.all.aiV5.ui()) }); } };
  const inputCapture = { id: 'native-input-step-capture', processInputStep({ messageList }) { inputSteps.push(structuredClone(messageList.get.all.db())); } };
  const agent = withCavemanMastra(new Agent({ id: 'native-mastra', name: 'Native Mastra', instructions: 'Read the exact source log.', model: nested, tools: { read_logs: read }, memory, inputProcessors: [inputCapture], outputProcessors: [capture] }), { runtime, scope: selectedScope });
  const params = { maxSteps: 6, modelSettings: { temperature: 0.2, maxRetries: 0 }, memory: { thread: selectedScope.session_id, resource: 'fixture-user' } };
  t.after(() => proof.scenarios.push({ family, operation, mode, native_read_executions: reads, provider_requests: fixture.state.calls.map(({ raw, body }) => ({ sha256: sha256(raw), utf8_bytes: Buffer.byteLength(raw), model: body.model, stream: body.stream ?? false, tools: (body.tools ?? []).map(tool => tool.function?.name ?? tool.name), tool_results: toolResults(body, family).map(result => ({ id: result.id, sha256: sha256(result.text), utf8_bytes: Buffer.byteLength(result.text), has_recovery_handle: /cmw_[a-f0-9]{48}/.test(result.text), omitted_detail_present: result.text.includes('omitted-detail-80') })) })), optimizer_plans: rpc.map(({ request, response }) => ({ scope: request.scope, attempt_id: request.attempt_id, status: response.status, reason: response.reason, measurement: response.measurement })), receipts: receipts.map(receipt => ({ attempt_id: receipt.attempt_id, event_kind: receipt.event_kind, usage: receipt.usage })), fixture_errors: fixture.state.errors }));
  t.after(() => { if (fixture.state.errors.length) t.diagnostic(JSON.stringify({ errors: fixture.state.errors, diagnostics, plans: rpc.map(row => ({ status: row.response.status, reason: row.response.reason, skipped: row.response.skipped })) })); });
  return { service, runtime, rpc, receipts, retrievals, fetchAttempts, capabilities, diagnostics, reports, fixture, selectedScope, middleware, stored, memory, agent, params, history, inputSteps, read, readResults, capture, reads: () => reads };
}

for (const family of ['openai', 'anthropic']) for (const operation of ['generate', 'stream']) test(`Mastra ${family} ${operation} native loop recovers original bytes and preserves memory/UI history`, { timeout: 30000 }, async t => {
  const context = await setup(t, family, operation);
  const input = [{ role: 'user', content: 'Read logs and report omitted-detail-80 exactly.' }], original = structuredClone(input);
  const result = await context.agent[operation](input, context.params);
  let answer;
  if (operation === 'stream') {
    const iterator = result.textStream[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.value, 'omitted'); assert.equal(context.fixture.state.released, false);
    context.fixture.state.release(); answer = first.value;
    for (;;) { const next = await iterator.next(); if (next.done) break; answer += next.value; }
  } else answer = result.text;
  assert.equal(answer, 'omitted-detail-80');
  assert.deepEqual(input, original); assert.equal(context.reads(), 1);
  assert.equal(context.fixture.state.calls.length, 3); assert.deepEqual(context.fixture.state.errors, []);
  assert.equal(context.rpc.filter(row => row.response.status === 'optimized').length, 2, 'nested AI SDK yields to the Mastra owner exactly once');
  const remembered = await context.memory.recall({ threadId: context.selectedScope.session_id, resourceId: 'fixture-user' });
  assert.ok(hasOriginal(remembered.messages));
  assert.ok(context.history.length); assert.ok(hasOriginal(context.history.at(-1).db)); assert.ok(hasOriginal(context.history.at(-1).ui));
  const schemas = context.fixture.state.calls.map(call => call.body.tools);
  assert.deepEqual(schemas[1], schemas[0]); assert.deepEqual(schemas[2], schemas[0]);
  assert.ok(context.fixture.state.calls.every(call => !call.headers['x-cave-transforms']));
  for (let i = 0; i < 100 && context.receipts.length < 6; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(context.receipts.filter(receipt => receipt.event_kind === 'dispatch_intent').length, 3);
  const completed = context.receipts.filter(receipt => receipt.event_kind === 'completed');
  assert.equal(completed.length, 3); assert.ok(completed.every(receipt => receipt.usage?.complete === true));
});

for (const family of ['openai', 'anthropic']) for (const mode of ['off', 'record', 'outage']) test(`Mastra ${family} ${mode} preserves native generation and streaming call counts`, { timeout: 30000 }, async t => {
  for (const operation of ['generate', 'stream']) {
    const context = await setup(t, family, operation, mode);
    const result = await context.agent[operation]('Read the logs and find omitted-detail-80.', context.params);
    assert.equal(await result.text, 'omitted-detail-80');
    assert.equal(context.fixture.state.calls.length, 2); assert.equal(context.reads(), 1);
    assert.deepEqual(context.fixture.state.errors, []);
    const remembered = await context.memory.recall({ threadId: context.selectedScope.session_id, resourceId: 'fixture-user' });
    assert.ok(hasOriginal(remembered.messages));
  }
});

const originalHistory = () => [
  { role: 'user', content: 'Read the original source.' },
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'read-1', toolName: 'read_logs', input: {} }] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'read-1', toolName: 'read_logs', output: { type: 'text', value: source } }] },
  { role: 'user', content: 'Give the answer.' },
];

for (const family of ['openai', 'anthropic']) test(`Mastra ${family} structured output, forced tools and schema-only collision preserve native requests`, { timeout: 30000 }, async t => {
  const context = await setup(t, family, 'protected');
  const read = createTool({ id: 'read_logs', description: 'Read the diagnostic log.', inputSchema: z.object({}), execute: async () => source });
  const fake = createTool({ id: 'caveman_retrieve', description: 'Application schema without recovery.', inputSchema: z.object({ handle: z.string() }) });
  for (const contract of ['structured', 'forced', 'collision', 'model-only']) {
    const native = { id: `protected-${contract}`, name: 'Protected native agent', model: context.fixture.model(contract === 'structured' ? 'structured' : 'helpers'), instructions: 'Keep the complete request.', tools: { read_logs: read, ...(contract === 'collision' ? { caveman_retrieve: fake } : {}) } };
    const original = new Agent(native);
    const wrapped = withCavemanMastra(new Agent(native), { runtime: context.runtime, scope: scope(`${family}-${contract}`), recovery: contract !== 'model-only' });
    const options = { maxSteps: 1, modelSettings: { maxRetries: 0, temperature: 0.2 }, ...(contract === 'structured' ? { structuredOutput: { schema: z.object({ answer: z.string() }) } } : {}), ...(contract === 'forced' ? { toolChoice: { type: 'tool', toolName: 'read_logs' } } : {}) };
    for (const operation of ['generate', 'stream']) {
      const input = originalHistory(), before = structuredClone(input);
      const baseline = await original[operation](input, options); const baselineText = await baseline.text; const wire = context.fixture.state.calls.at(-1).raw;
      const result = await wrapped[operation](input, options);
      assert.equal(await result.text, baselineText); if (contract === 'structured') assert.deepEqual(await result.object, { answer: 'native' });
      assert.equal(context.fixture.state.calls.at(-1).raw, wire);
      assert.deepEqual(input, before); assert.ok(hasOriginal(context.fixture.state.calls.at(-1).body));
    }
  }
  assert.deepEqual(context.fixture.state.errors, []);
});

for (const family of ['openai', 'anthropic']) test(`Mastra ${family} native workflow suspend/resume reuses replacements after runtime restart and keeps stored originals`, { timeout: 30000 }, async t => {
  const context = await setup(t, family, 'workflow');
  const first = createStep({ id: 'read-and-answer', inputSchema: z.object({ question: z.string() }), outputSchema: z.object({ answer: z.string() }), execute: async ({ inputData }) => {
    const result = await context.agent.generate(inputData.question, context.params);
    return { answer: result.text };
  } });
  const pause = createStep({ id: 'wait-for-resume', inputSchema: z.object({ answer: z.string() }), outputSchema: z.object({ answer: z.string() }), suspendSchema: z.object({ answer: z.string() }), resumeSchema: z.object({ approved: z.boolean() }), execute: async ({ inputData, resumeData, suspend }) => {
    if (!resumeData) return suspend(inputData);
    assert.equal(resumeData.approved, true);
    const result = await context.agent.generate('Repeat the exact retained fact.', context.params);
    return { answer: result.text };
  } });
  const workflow = createWorkflow({ id: 'native-caveman-workflow', inputSchema: z.object({ question: z.string() }), outputSchema: z.object({ answer: z.string() }) }).then(first).then(pause).commit();
  new Mastra({ storage: context.stored, workflows: { native: workflow }, agents: { native: context.agent } });
  const run = await workflow.createRun();
  const suspended = await run.start({ inputData: { question: 'Read logs and find omitted-detail-80.' } });
  assert.equal(suspended.status, 'suspended'); assert.equal(context.fixture.state.calls.length, 3);
  const compressed = toolResults(context.fixture.state.calls[1].body, family).find(result => result.id === 'read-1').text;
  await context.service.restart();
  const restoredRun = await workflow.createRun({ runId: run.runId });
  const resumed = await restoredRun.resume({ resumeData: { approved: true } });
  assert.equal(resumed.status, 'success'); assert.deepEqual(resumed.result, { answer: 'omitted-detail-80' });
  assert.equal(context.fixture.state.calls.length, 4); assert.equal(context.reads(), 1);
  assert.equal(toolResults(context.fixture.state.calls[3].body, family).find(result => result.id === 'read-1').text, compressed);
  const remembered = await context.memory.recall({ threadId: context.selectedScope.session_id, resourceId: 'fixture-user' });
  assert.ok(hasOriginal(remembered.messages));
  assert.equal(context.rpc.at(-1).response.measurement.unique_tokens_reduced, 0);
});

for (const family of ['openai', 'anthropic']) test(`Mastra ${family} pre-abort, active abort and native failure never replay inference`, { timeout: 30000 }, async t => {
  const context = await setup(t, family, 'cancellation');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(context.agent.generate('Never send.', { ...context.params, abortSignal: controller.signal }));
  assert.equal(context.fixture.state.calls.length, 0);
  const abort = new AbortController();
  const output = await context.agent.stream('Stream until cancelled.', { ...context.params, model: context.fixture.model('cancel'), abortSignal: abort.signal });
  const iterator = output.textStream[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value, 'native'); assert.equal(context.fixture.state.released, false);
  abort.abort(); await iterator.return();
  for (let i = 0; i < 100 && !context.fixture.state.closed; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(context.fixture.state.closed, true); assert.equal(context.fixture.state.calls.length, 1);
  await assert.rejects(context.agent.generate('Fail once.', { ...context.params, model: context.fixture.model('failure') }));
  assert.equal(context.fixture.state.calls.length, 2);
});

const waitUntil = async (predicate, limit = 1000) => {
  const deadline = Date.now() + limit;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  return predicate();
};
const bounded = (promise, label, limit = 1500) => Promise.race([
  promise,
  new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`${label} timed out`)), limit); timer.unref(); }),
]);

for (const family of ['openai', 'anthropic']) for (const surface of ['textStream', 'fullStream']) test(`Mastra ${family} ${surface} native close detaches while AbortSignal closes active provider transport`, { timeout: 30000 }, async t => {
  const rows = [];
  for (const wrapped of [false, true]) for (const action of ['close', 'abort']) {
    const context = await setup(t, family, `${surface}-${wrapped}-${action}`);
    const controller = new AbortController();
    const original = new Agent({ id: `lifecycle-${wrapped}-${action}`, name: 'Native stream lifecycle', instructions: 'Stream the response.', model: context.fixture.model('cancel') });
    const agent = wrapped ? withCavemanMastra(original, { runtime: context.runtime, scope: context.selectedScope }) : original;
    const output = await agent.stream('Stream until closed.', { maxSteps: 1, abortSignal: controller.signal, modelSettings: { maxRetries: 0 } });
    const iterator = output[surface][Symbol.asyncIterator]();
    let first;
    do { first = await bounded(iterator.next(), 'first native text'); }
    while (!first.done && surface === 'fullStream' && first.value.type !== 'text-delta');
    assert.equal(first.done, false);
    assert.equal(surface === 'textStream' ? first.value : first.value.payload.text, 'native');
    assert.equal(context.fixture.state.released, false, 'first chunk must arrive before provider release');
    let returned;
    if (action === 'close') {
      returned = await bounded(iterator.return(), 'native iterator return');
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(context.fixture.state.closed, false, 'pinned native Mastra close only detaches its event listener');
      assert.equal(context.fixture.state.released, false);
      assert.equal(context.receipts.filter(row => row.event_kind !== 'dispatch_intent').length, 0);
    } else {
      const next = iterator.next();
      controller.abort();
      returned = await bounded(next.then(value => value, error => ({ error: error.name })), 'active native abort');
      assert.equal(await waitUntil(() => context.fixture.state.closed), true);
      if (wrapped) {
        assert.equal(await waitUntil(() => context.receipts.some(row => row.event_kind === 'cancelled')), true);
        const terminal = context.receipts.filter(row => row.event_kind !== 'dispatch_intent');
        assert.equal(terminal.length, 1); assert.equal(terminal[0].event_kind, 'cancelled'); assert.equal(terminal[0].usage, null);
      }
    }
    rows.push({ family, surface, wrapped, action, first_chunk_before_release: true, returned, provider_closed: context.fixture.state.closed, provider_calls: context.fixture.state.calls.length, receipt_events: context.receipts.map(row => row.event_kind) });
    controller.abort();
    assert.equal(await waitUntil(() => context.fixture.state.closed), true);
    await bounded(iterator.return(), 'cleanup iterator return');
    assert.equal(context.fixture.state.calls.length, 1);
  }
  t.diagnostic(JSON.stringify({ lifecycle_evidence: rows }));
  proof.lifecycle.push(...rows);
});

for (const family of ['openai', 'anthropic']) test(`Mastra ${family} replacing the recovery tool map declines lossy text`, { timeout: 20000 }, async t => {
  const context = await setup(t, family, 'replacement-map');
  const replace = { id: 'replace-tools', processInputStep({ tools }) {
    const previous = tools.caveman_retrieve;
    return { tools: { ...tools, caveman_retrieve: createTool({ id: previous.id, description: previous.description, inputSchema: previous.inputSchema, execute: async () => ({ text: 'replacement cannot read original' }) }) } };
  } };
  const agent = withCavemanMastra(new Agent({ id: 'native-replacement-map', name: 'Native replacement tool map', instructions: 'Preserve the complete source.', model: context.fixture.model('helpers'), inputProcessors: [replace] }), { runtime: context.runtime, scope: context.selectedScope });
  const result = await agent.generate(originalHistory(), { maxSteps: 1, modelSettings: { maxRetries: 0 } });
  assert.equal(result.text, 'native');
  assert.equal(hasOriginal(context.fixture.state.calls.at(-1).body), true);
  assert.ok(context.rpc.every(row => row.response.status !== 'optimized'));
});

for (const family of ['openai', 'anthropic']) test(`Mastra ${family} final prepareStep changes cannot bypass native executor attestation`, { timeout: 20000 }, async t => {
  const context = await setup(t, family, 'prepareStep-changes');
  for (const kind of ['execute', 'replace', 'remove', 'model']) {
    let prepared = 0, processed = 0;
    const prepareStep = args => {
      prepared++;
      const current = args.tools.caveman_retrieve;
      const base = { modelSettings: { temperature: 0.42, maxRetries: 0 } };
      if (kind === 'execute') { current.execute = async () => ({ text: 'wrong original' }); return base; }
      if (kind === 'replace') return { ...base, tools: { ...args.tools, caveman_retrieve: createTool({ id: current.id, description: current.description, inputSchema: current.inputSchema, execute: async () => ({ text: 'wrong original' }) }) } };
      if (kind === 'remove') return { ...base, tools: {} };
      return { ...base, model: context.fixture.model('helpers') };
    };
    const original = new Agent({ id: `native-prepare-${kind}`, name: 'Native application prepareStep', instructions: 'Keep the source.', model: context.fixture.model('helpers'), inputProcessors: [{ id: 'app-input', processInputStep() { processed++; } }], defaultOptions: { prepareStep } });
    const wrapped = withCavemanMastra(original, { runtime: context.runtime, scope: scope(`${family}-prepare-${kind}`) });
    const before = await original.listConfiguredInputProcessors();
    for (const operation of ['generate', 'stream']) {
      const count = context.rpc.length;
      const result = await wrapped[operation](originalHistory(), { maxSteps: 1 });
      assert.equal(await result.text, 'native');
      assert.equal(hasOriginal(context.fixture.state.calls.at(-1).body), true, kind);
      assert.equal(context.fixture.state.calls.at(-1).body.temperature, 0.42);
      assert.ok(context.rpc.slice(count).every(row => row.response.status !== 'optimized'));
    }
    assert.equal(prepared, 2); assert.equal(processed, 2);
    assert.deepEqual(await original.listConfiguredInputProcessors(), before);
  }
});

for (const family of ['openai', 'anthropic']) test(`Mastra ${family} low-level processor preserves original requests without an attested executor table`, { timeout: 20000 }, async t => {
  const context = await setup(t, family, 'processor-only');
  const configuration = { id: 'native-low-level', name: 'Native processor only', instructions: 'Keep complete source.', model: context.fixture.model('helpers') };
  const original = new Agent(configuration);
  const wrapped = new Agent({ ...configuration, inputProcessors: [context.middleware] });
  for (const operation of ['generate', 'stream']) {
    assert.equal(await (await original[operation](originalHistory(), { maxSteps: 1 })).text, 'native');
    const before = context.fixture.state.calls.at(-1).raw;
    assert.equal(await (await wrapped[operation](originalHistory(), { maxSteps: 1 })).text, 'native');
    assert.equal(context.fixture.state.calls.at(-1).raw, before);
  }
  assert.ok(context.rpc.every(row => row.response.status !== 'optimized'));
});

test('Mastra bundle retains concurrent per-call processors and prepareStep overrides without shared state', { timeout: 20000 }, async t => {
  const context = await setup(t, 'openai', 'concurrent-prepareStep');
  const reached = deferred(); let preparations = 0, configured = 0, defaultPrepared = 0;
  const original = new Agent({ id: 'native-concurrent-prepare', name: 'Native concurrent prepare callbacks', instructions: 'Read exact source.', model: context.fixture.model('fixture-model'), inputProcessors: [{ id: 'configured-input', processInputStep() { configured++; } }], defaultOptions: { prepareStep() { defaultPrepared++; } } });
  const wrapped = withCavemanMastra(original, { runtime: context.runtime, scope: ({ requestContext }) => scope(requestContext.get('conversation')) });
  const outcomes = await Promise.all(['kept', 'changed'].map(async id => {
    const requestContext = new RequestContext(); requestContext.set('conversation', id);
    let processors = 0, calls = 0;
    const result = await wrapped.generate(originalHistory(), { requestContext, maxSteps: 3, modelSettings: { maxRetries: 0 }, inputProcessors: [{ id: 'per-call-input', processInputStep() { processors++; } }], prepareStep: async args => {
      calls++;
      if (args.stepNumber === 0) {
        if (++preparations === 2) reached.resolve();
        await reached.promise;
      }
      if (id === 'changed') return { model: context.fixture.model('helpers'), tools: {} };
    } });
    return { id, text: result.text, processors, preparations: calls };
  }));
  assert.deepEqual(outcomes, [{ id: 'kept', text: 'omitted-detail-80', processors: 2, preparations: 2 }, { id: 'changed', text: 'native', processors: 1, preparations: 1 }]);
  assert.equal(configured, 0); assert.equal(defaultPrepared, 0);
  assert.equal(context.fixture.state.calls.length, 3);
  const changed = context.fixture.state.calls.find(call => call.body.model === 'helpers');
  assert.equal(hasOriginal(changed.body), true);
  const compressed = context.rpc.filter(row => row.response.status === 'optimized');
  assert.ok(compressed.length > 0); assert.ok(compressed.every(row => row.request.scope.session_id === 'kept'));
});

for (const family of ['openai', 'anthropic']) test(`Mastra ${family} protects JSON objects, tool errors, content blocks and signed reasoning`, { timeout: 20000 }, async t => {
  const context = await setup(t, family, 'protected-structures');
  const outputs = [
    { type: 'json', value: { original: source, count: 160 } },
    { type: 'json', value: [source, { nested: true }] },
    { type: 'error-text', value: source },
    { type: 'error-json', value: { original: source, retryable: false } },
    { type: 'content', value: [{ type: 'text', text: source }] },
  ];
  const withoutToolRegistration = body => { const value = structuredClone(body); delete value.tools; delete value.tool_choice; return value; };
  const config = { id: 'native-protected-parts', name: 'Native protected structures', instructions: 'Preserve content.', model: context.fixture.model('helpers') };
  const original = new Agent(config), wrapped = withCavemanMastra(new Agent(config), { runtime: context.runtime, scope: context.selectedScope });
  for (const output of outputs) for (const operation of ['generate', 'stream']) {
    const input = originalHistory(); input[2].content[0].output = output;
    input[1].content.unshift({ type: 'reasoning', text: 'retained reasoning block', providerOptions: { anthropic: { signature: 'native-signed-reasoning' } } });
    const before = structuredClone(input);
    assert.equal(await (await original[operation](input, { maxSteps: 1 })).text, 'native');
    const expected = withoutToolRegistration(context.fixture.state.calls.at(-1).body);
    assert.equal(await (await wrapped[operation](input, { maxSteps: 1 })).text, 'native');
    assert.deepEqual(withoutToolRegistration(context.fixture.state.calls.at(-1).body), expected);
    assert.deepEqual(input, before);
  }
  assert.ok(context.rpc.every(row => row.response.status !== 'optimized'));
  assert.deepEqual(context.fixture.state.errors, []);
});

for (const family of ['openai', 'anthropic']) test(`Mastra ${family} imported error text stays protected on subsequent memory turns`, { timeout: 20000 }, async t => {
  const context = await setup(t, family, 'imported-error-memory');
  const input = originalHistory(); input[2].content[0].output.type = 'error-text';
  const first = await context.agent.generate(input, { ...context.params, model: context.fixture.model('helpers'), maxSteps: 1 });
  assert.equal(first.text, 'native'); assert.equal(hasOriginal(context.fixture.state.calls.at(-1).body), true);
  const next = await context.agent.generate('Keep the previous diagnostic error.', { ...context.params, model: context.fixture.model('helpers'), maxSteps: 1 });
  assert.equal(next.text, 'native'); assert.equal(hasOriginal(context.fixture.state.calls.at(-1).body), true);
  assert.ok(context.rpc.every(row => row.response.status !== 'optimized'));
  const recalled = await context.memory.recall({ threadId: context.selectedScope.session_id, resourceId: 'fixture-user' });
  assert.ok(hasOriginal(recalled.messages));
});

test('Mastra unknown installed version is inert by default and strict only when requested', { timeout: 20000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'caveman-mastra-version-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const core = join(directory, 'node_modules/@mastra/core'), sdk = join(directory, 'node_modules/@caveman-ai');
  mkdirSync(core, { recursive: true }); mkdirSync(sdk, { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(join(core, 'package.json'), JSON.stringify({ name: '@mastra/core', version: '99.0.0', type: 'module', exports: { './agent': './agent.mjs', './tools': './tools.mjs', './schema': './schema.mjs' } }));
  for (const entry of ['agent', 'tools', 'schema']) writeFileSync(join(core, `${entry}.mjs`), `export * from ${JSON.stringify(import.meta.resolve(`@mastra/core/${entry}`))};\n`);
  symlinkSync(fileURLToPath(new URL('../../../packages/sdk/typescript', import.meta.url)), join(sdk, 'sdk'), 'dir');
  for (const file of ['mastra.js', 'common.js', 'versions.js']) cpSync(new URL(`../../../packages/middleware/typescript/dist/${file}`, import.meta.url), join(directory, file));
  const untested = await import(pathToFileURL(join(directory, 'mastra.js')).href);
  const context = await setup(t, 'openai', 'unknown-version');
  const diagnostics = [], reports = [], requests = [];
  const runtime = createMiddlewareRuntime({ endpoint: context.service.endpoint, onDiagnostic: event => diagnostics.push(event), onReport: report => reports.push(report), fetch: (...args) => { requests.push(args); throw new Error('Passive reporting cannot perform optimizer I/O'); } }); t.after(() => runtime.close());
  const native = new Agent({ id: 'native-untested-version', name: 'Untested installed version', instructions: 'Keep originals.', model: context.fixture.model('helpers') });
  const originalGenerate = native.generate, wrapped = untested.withCavemanMastra(native, { runtime, scope: context.selectedScope });
  assert.notEqual(wrapped, native); assert.equal(native.generate, originalGenerate); assert.equal(reports.length, 0);
  const direct = await wrapped.generate(originalHistory(), { maxSteps: 1 });
  assert.equal(direct.text, 'native'); assert.equal(reports.length, 1);
  const processor = untested.createCavemanMastraProcessor({ runtime, scope: context.selectedScope });
  assert.equal(processor.processLLMRequest, undefined);
  const result = await native.generate(originalHistory(), { maxSteps: 1, inputProcessors: [processor] });
  assert.equal(result.text, 'native'); assert.equal(hasOriginal(context.fixture.state.calls.at(-1).body), true);
  assert.ok(!context.fixture.state.calls.at(-1).body.tools?.some(tool => tool.function?.name === 'caveman_retrieve'));
  assert.equal(context.fixture.state.calls.at(-1).raw, context.fixture.state.calls.at(-2).raw);
  assert.equal(reports.length, 2); assert.ok(reports.every(report => report.status === 'skipped' && report.reason === 'unsupported_version' && report.replacement_count === 0));
  assert.equal(runtime.lastReport, reports.at(-1)); assert.deepEqual(requests, []); assert.equal(native.generate, originalGenerate);
  assert.deepEqual(diagnostics.map(event => event.code), ['unsupported_version', 'unsupported_version']);
  const strict = createMiddlewareRuntime({ strict: true }); t.after(() => strict.close());
  assert.throws(() => untested.withCavemanMastra(native, { runtime: strict, scope: context.selectedScope }), error => error.code === 'unsupported_version');
});

test('Mastra owns native retries, reuses exact replacements and observes each attempt once', { timeout: 30000 }, async t => {
  const context = await setup(t, 'openai', 'native-retry');
  const result = await context.agent.generate(originalHistory(), { ...context.params, model: context.fixture.model('retry-once'), modelSettings: { maxRetries: 1 } });
  assert.equal(result.text, 'omitted-detail-80');
  assert.equal(context.fixture.state.calls.length, 3); assert.equal(context.reads(), 0);
  assert.equal(context.fixture.state.calls[0].raw, context.fixture.state.calls[1].raw);
  for (let i = 0; i < 100 && context.receipts.length < 6; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(context.receipts.filter(receipt => receipt.event_kind === 'dispatch_intent').length, 3);
  assert.equal(context.receipts.filter(receipt => receipt.event_kind === 'failed').length, 1);
  assert.equal(context.receipts.filter(receipt => receipt.event_kind === 'completed').length, 2);
  assert.equal(new Set(context.receipts.map(receipt => receipt.attempt_id)).size, 3);
  assert.ok(context.rpc[0].response.measurement.unique_tokens_reduced > 0);
  assert.ok(context.rpc.slice(1).every(row => row.response.measurement.unique_tokens_reduced === 0));
});

test('Mastra guardrail sees original tool content during optimizer availability and outage', { timeout: 30000 }, async t => {
  for (const mode of ['compress', 'outage']) {
    const context = await setup(t, 'openai', `guard-${mode}`, mode);
    let guarded = false;
    const guard = { id: 'original-content-guard', processInputStep({ messageList, abort }) {
      if (hasOriginal(messageList.get.all.db())) { guarded = true; abort('source denied by original-content policy'); }
    } };
    const result = await context.agent.generate('Read the protected source.', { ...context.params, inputProcessors: [guard] });
    assert.equal(result.tripwire?.reason, 'source denied by original-content policy');
    assert.equal(guarded, true); assert.equal(context.fixture.state.calls.length, 1); assert.equal(context.rpc.length, 0);
  }
});

test('one native Mastra processor isolates interleaved RequestContext scopes on an existing agent', { timeout: 30000 }, async t => {
  const context = await setup(t, 'openai', 'interleaved');
  const seen = [];
  const dynamic = { runtime: context.runtime, scope: ({ requestContext }) => {
    const session = requestContext?.get('conversation');
    assert.equal(typeof session, 'string'); seen.push(session);
    return scope(session);
  } };
  const agent = new Agent({ id: 'existing-agent', name: 'Existing application agent', instructions: 'Use exact original logs.', model: context.fixture.model('fixture-model'), tools: {
    read_logs: createTool({ id: 'read_logs', description: 'Read source.', inputSchema: z.object({}), execute: async () => source }),
  } });
  const wrapped = withCavemanMastra(agent, dynamic);
  const before = await agent.listConfiguredInputProcessors();
  const results = await Promise.all(['conversation-a', 'conversation-b'].map(async id => {
    const requestContext = new RequestContext(); requestContext.set('conversation', id);
    const result = await wrapped.generate('Read and recover omitted-detail-80.', { requestContext, inputProcessors: before, maxSteps: 6, modelSettings: { maxRetries: 0 } });
    return result.text;
  }));
  assert.deepEqual(results, ['omitted-detail-80', 'omitted-detail-80']);
  assert.deepEqual(await agent.listConfiguredInputProcessors(), before);
  assert.equal(context.fixture.state.calls.length, 6); assert.equal(seen.length, 6);
  const plans = context.rpc.filter(row => row.response.status === 'optimized');
  assert.equal(new Set(plans.map(row => row.request.scope.session_id)).size, 2);
  const a = plans.find(row => row.request.scope.session_id === 'conversation-a');
  const b = plans.find(row => row.request.scope.session_id === 'conversation-b');
  const handleA = a.response.replacements[0].text.match(/cmw_[a-f0-9]{48}/)[0];
  const handleB = b.response.replacements[0].text.match(/cmw_[a-f0-9]{48}/)[0];
  assert.notEqual(handleA, handleB);
  assert.equal((await context.runtime.retrieve(scope('conversation-a'), { handle: handleA })).text, source);
  await assert.rejects(context.runtime.retrieve(scope('conversation-a'), { handle: handleB }));
});

for (const family of ['openai', 'anthropic']) test(`Mastra ${family} changed native recovery executor cannot authorize lossy text`, { timeout: 20000 }, async t => {
  const context = await setup(t, family, 'changed-executor');
  const changes = {
    execute(tool) { tool.execute = async () => ({ text: 'unrelated executor' }); },
    id(tool) { tool.id = 'another_reader'; },
    description(tool) { tool.description = 'Changed description'; },
    schema(tool) { tool.inputSchema = createTool({ id: 'schema', description: 'Changed schema', inputSchema: z.object({ handle: z.number() }) }).inputSchema; },
    validator(tool) { tool.inputSchema['~standard'].validate = () => ({ issues: [{ message: 'This validator rejects every recovery call' }] }); },
    output(tool) { tool.toModelOutput = () => ({ type: 'text', value: 'discarded original' }); },
    outputHook(tool) { tool.onOutput = () => 'discarded original'; },
    approval(tool) { tool.requireApproval = true; },
  };
  for (const [name, change] of Object.entries(changes)) {
    let changed = false;
    const mutate = { id: `mutate-${name}`, processInputStep({ tools }) {
      assert.equal(typeof tools.caveman_retrieve.execute, 'function');
      change(tools.caveman_retrieve); changed = true;
    } };
    const agent = withCavemanMastra(new Agent({ id: `changed-${name}`, name: 'Native changed tool', instructions: 'Keep original source.', model: context.fixture.model('helpers'), inputProcessors: [mutate] }), { runtime: context.runtime, scope: scope(`${family}-changed-${name}`) });
    const before = context.rpc.length;
    const result = await agent.generate(originalHistory(), { maxSteps: 1, modelSettings: { maxRetries: 0 } });
    assert.equal(result.text, 'native'); assert.equal(changed, true);
    assert.equal(hasOriginal(context.fixture.state.calls.at(-1).body), true, name);
    assert.ok(context.rpc.slice(before).every(row => row.response.status !== 'optimized'), name);
  }
});

for (const family of ['openai', 'anthropic']) test(`Mastra ${family} twenty turns preserve one source grant through two process restarts`, { timeout: 30000 }, async t => {
  const context = await setup(t, family, 'twenty-turn');
  let originalView;
  const continuations = [];
  for (let turn = 0; turn < 20; turn++) {
    if (turn === 7 || turn === 14) await context.service.restart();
    const result = await context.agent.generate(turn ? `Turn ${turn}: repeat the exact retained fact.` : 'Read and recover omitted-detail-80.', context.params);
    assert.equal(result.text, 'omitted-detail-80');
    const wire = context.fixture.state.calls.at(-1).body;
    const view = toolResults(wire, family).find(result => result.id === 'read-1').text;
    originalView ??= view;
    assert.equal(view, originalView, `turn ${turn}`);
    continuations.push(context.rpc.at(-1).response.measurement.unique_tokens_reduced);
  }
  assert.equal(context.fixture.state.calls.length, 22); assert.equal(context.reads(), 1);
  assert.ok(continuations.every(reduced => reduced === 0));
  const handle = originalView.match(/cmw_[a-f0-9]{48}/)[0];
  assert.equal((await context.runtime.retrieve(context.selectedScope, { handle })).text, source);
  for (const wrong of [{ ...context.selectedScope, namespace: 'other' }, { ...context.selectedScope, session_id: 'other' }, { ...context.selectedScope, branch_id: 'other' }, { ...context.selectedScope, cache_epoch: '1' }]) {
    await assert.rejects(context.runtime.retrieve(wrong, { handle }), error => error.code === 'not_found');
  }
  const remembered = await context.memory.recall({ threadId: context.selectedScope.session_id, resourceId: 'fixture-user' });
  assert.ok(hasOriginal(remembered.messages));
  assert.ok(context.history.every(row => hasOriginal(row.db) && hasOriginal(row.ui)));
  assert.deepEqual(context.fixture.state.errors, []);
});

// Exact operation cells have literal test declarations so source inventories and
// independent replay can identify the executed test without expanding templates.
const originalLeaf = value => {
  if (value === source) return value;
  if (value && typeof value === 'object') for (const child of Object.values(value)) {
    const found = originalLeaf(child); if (found !== undefined) return found;
  }
};
const originalDigest = value => {
  const actual = originalLeaf(value); assert.equal(actual, source); return sha256(actual);
};
function nativeReports(context, calls) {
  const reports = context.reports;
  assert.equal(reports.length, calls, 'Exactly one report per actual native provider attempt, including nested AI SDK and off calls');
  assert.equal(context.runtime.lastReport, reports.at(-1));
  assert.equal(new Set(reports.map(report => report.attempt_id)).size, calls);
  assert.ok(reports.every(report => report.adapter === 'mastra' && Object.isFrozen(report) && Object.isFrozen(report.transform_ids)));
  assert.equal(hasOriginal(reports), false);
  const replacements = context.rpc.flatMap(row => row.response.replacements ?? []).length;
  assert.equal(reports.reduce((sum, report) => sum + report.replacement_count, 0), replacements);
  if (context.runtime.mode === 'off') { assert.ok(reports.every(report => report.status === 'disabled')); assert.equal(context.fetchAttempts.length, 0); }
  else if (replacements) { assert.ok(reports.some(report => report.status === 'applied')); assert.ok(reports.some(report => report.status === 'reused')); }
  return { count: reports.length, statuses: reports.map(report => report.status).sort(), replacement_count: replacements, source_content_absent: true };
}
const nativeSummary = async (context, family, mode, { answer, events = [], resumed = false } = {}) => {
  const compressed = mode === 'compress', expectedCalls = (compressed ? 3 : 2) + Number(resumed);
  assert.equal(answer, 'omitted-detail-80');
  assert.equal(context.fixture.state.calls.length, expectedCalls);
  assert.equal(context.reads(), 1); assert.deepEqual(context.readResults, [source]);
  assert.equal(context.inputSteps.length, expectedCalls, 'native processInputStep runs once for every provider step');
  assert.ok(context.inputSteps.slice(1).every(hasOriginal), 'native input processors always see retained originals');
  assert.deepEqual(context.fixture.state.errors, []);
  const views = context.fixture.state.calls.slice(1).map(call => toolResults(call.body, family).find(result => result.id === 'read-1').text);
  assert.ok(views.every(view => view === views[0]));
  const schemas = context.fixture.state.calls.map(call => call.body.tools);
  assert.ok(schemas.every(schema => JSON.stringify(schema) === JSON.stringify(schemas[0])));
  assert.ok(context.fixture.state.calls.every(call => !call.headers['x-cave-transforms']));
  const remembered = await context.memory.recall({ threadId: context.selectedScope.session_id, resourceId: 'fixture-user' });
  const retainedSha = originalDigest(remembered.messages);
  assert.ok(context.history.length);
  const dbSha = originalDigest(context.history.at(-1).db), uiSha = originalDigest(context.history.at(-1).ui);
  if (compressed) {
    assert.equal(context.rpc.filter(row => row.response.status === 'optimized').length, expectedCalls - 1, 'nested AI SDK yields to the native Mastra owner');
    assert.equal(await waitUntil(() => context.receipts.filter(row => row.event_kind === 'completed').length === expectedCalls), true);
    assert.equal(context.receipts.filter(row => row.event_kind === 'dispatch_intent').length, expectedCalls);
    const terminal = context.receipts.filter(row => row.event_kind !== 'dispatch_intent');
    assert.equal(terminal.length, expectedCalls); assert.ok(terminal.every(row => row.event_kind === 'completed' && row.usage?.complete === true));
  } else {
    assert.equal(views[0], source); assert.equal(context.retrievals.length, 0);
    assert.equal(context.rpc.flatMap(row => row.response.replacements ?? []).length, 0);
    if (mode === 'off') assert.equal(context.fetchAttempts.length, 0);
    if (mode === 'outage') assert.ok(context.fetchAttempts.some(row => row.path.endsWith('/capabilities')));
  }
  if (events.length) {
    assert.ok(events.some(event => event.type === 'tool-result' && originalLeaf(event) === source));
    assert.ok(events.some(event => event.type === 'finish'));
    assert.equal(events.filter(event => event.type === 'step-finish').length, expectedCalls);
  }
  return { outcome: 'observed', answer_sha256: sha256(answer), provider_calls: expectedCalls, native_read_executions: context.reads(),
    native_input_steps: context.inputSteps.length, recovery_requests: context.retrievals.length,
    replacements: context.rpc.flatMap(row => row.response.replacements ?? []).length,
    original_sha256: sha256(context.readResults[0]), retained_memory_sha256: retainedSha, message_list_sha256: dbSha, ui_history_sha256: uiSha,
    native_event_types: [...new Set(events.map(event => event.type))].sort(),
    completed_receipts: context.receipts.filter(row => row.event_kind === 'completed').length,
    streaming_provider_calls: context.fixture.state.calls.filter(call => call.body.stream).length,
    workflow_resumed: resumed, native_reports: nativeReports(context, expectedCalls) };
};

function recoveryJourney(context, family) {
  assert.deepEqual(context.readResults, [source]);
  const calls = context.fixture.state.calls, shortened = toolResults(calls[1].body, family).find(result => result.id === 'read-1').text;
  const handle = shortened.match(/cmw_[a-f0-9]{48}/)?.[0];
  assert.ok(handle); assert.ok(!shortened.includes('omitted-detail-80')); assert.ok(Buffer.byteLength(shortened) < Buffer.byteLength(source));
  assert.deepEqual(context.fixture.state.responses[1].tool, { name: 'caveman_retrieve', args: { handle }, id: 'recover-1' });
  assert.equal(context.retrievals.length, 1);
  assert.equal(context.retrievals[0].request.handle, handle);
  assert.equal(context.retrievals[0].response.text, source); assert.equal(context.retrievals[0].response.complete, true);
  const actualRecovery = JSON.parse(toolResults(calls[2].body, family).find(result => result.id === 'recover-1').text);
  assert.equal(actualRecovery.text, source); assert.equal(actualRecovery.complete, true);
  return {
    real_tool_result: { outcome: 'observed', native_tool: 'read_logs', executions: context.reads(), utf8_bytes: Buffer.byteLength(context.readResults[0]), sha256: sha256(context.readResults[0]) },
    transformed_provider_request: { outcome: 'observed', request_index: 2, original_sha256: sha256(source), shortened_utf8_bytes: Buffer.byteLength(shortened),
      normalized_shortened_sha256: sha256(shortened.replaceAll(/cmw_[a-f0-9]{48}/g, '<OPAQUE_RECOVERY_HANDLE>')), normalization: 'replace runtime-generated handle only', omitted_fact_absent: true },
    omitted_fact_requested: { outcome: 'observed', provider_response_index: 2, tool_name: context.fixture.state.responses[1].tool.name, exact_view_handle_requested: true, recovery_requests: 1 },
    host_executes_exact_recovery: { outcome: 'observed', native_executor: 'Mastra Tool.execute', executions: context.retrievals.length,
      runtime_recovered_sha256: sha256(context.retrievals[0].response.text), provider_recovered_sha256: sha256(actualRecovery.text), recovered_utf8_bytes: Buffer.byteLength(actualRecovery.text), complete: actualRecovery.complete },
  };
}

async function runOrdinaryJourney(t, family, method, mode) {
  const context = await setup(t, family, `cert-${method}`, mode);
  if (mode === 'compress') await beginNativeCertification(t, context.capabilities);
  const events = [], input = [{ role: 'user', content: 'Read logs and report omitted-detail-80 exactly.' }], before = structuredClone(input);
  let answer, restarted = false;
  if (method === 'workflow_suspend_resume') {
    const first = createStep({ id: 'cert-read', inputSchema: z.object({ question: z.string() }), outputSchema: z.object({ answer: z.string() }),
      execute: async ({ inputData }) => ({ answer: (await context.agent.generate(inputData.question, context.params)).text }) });
    const pause = createStep({ id: 'cert-suspend', inputSchema: z.object({ answer: z.string() }), outputSchema: z.object({ answer: z.string() }),
      suspendSchema: z.object({ answer: z.string() }), resumeSchema: z.object({ approved: z.boolean() }), execute: async ({ inputData, resumeData, suspend }) => {
        if (!resumeData) return suspend(inputData);
        assert.equal(resumeData.approved, true);
        return { answer: (await context.agent.generate('Repeat the exact retained fact.', context.params)).text };
      } });
    const workflow = createWorkflow({ id: 'cert-workflow', inputSchema: z.object({ question: z.string() }), outputSchema: z.object({ answer: z.string() }) }).then(first).then(pause).commit();
    new Mastra({ storage: context.stored, workflows: { certification: workflow }, agents: { certification: context.agent } });
    const run = await workflow.createRun(), suspended = await run.start({ inputData: { question: input[0].content } });
    assert.equal(suspended.status, 'suspended'); assert.equal(context.fixture.state.calls.length, mode === 'compress' ? 3 : 2);
    const firstView = toolResults(context.fixture.state.calls[1].body, family).find(result => result.id === 'read-1').text;
    if (context.service) { const pid = context.service.pid; await context.service.restart(); assert.notEqual(context.service.pid, pid); restarted = true; }
    const restored = await workflow.createRun({ runId: run.runId }), result = await restored.resume({ resumeData: { approved: true } });
    assert.equal(result.status, 'success'); assert.deepEqual(result.result, { answer: 'omitted-detail-80' }); answer = result.result.answer;
    assert.equal(toolResults(context.fixture.state.calls.at(-1).body, family).find(result => result.id === 'read-1').text, firstView);
    if (mode === 'compress') assert.equal(context.rpc.at(-1).response.measurement.unique_tokens_reduced, 0);
  } else if (method === 'agent.stream') {
    const result = await context.agent.stream(input, context.params);
    answer = '';
    for await (const event of result.fullStream) {
      events.push(event);
      if (event.type === 'text-delta') {
        if (!answer && mode === 'compress') { assert.equal(context.fixture.state.released, false); assert.equal(event.payload.text, 'omitted'); context.fixture.state.release(); }
        answer += event.payload.text;
      }
    }
  } else answer = (await context.agent.generate(input, context.params)).text;
  assert.deepEqual(input, before);
  const summary = await nativeSummary(context, family, mode, { answer, events, resumed: method === 'workflow_suspend_resume' });
  return { context, summary, restarted };
}

async function certifyOrdinaryCell(t, family, method) {
  const compressed = await runOrdinaryJourney(t, family, method, 'compress');
  const off = await runOrdinaryJourney(t, family, method, 'off');
  const outage = await runOrdinaryJourney(t, family, method, 'outage');
  assert.equal(compressed.summary.answer_sha256, off.summary.answer_sha256); assert.equal(off.summary.answer_sha256, outage.summary.answer_sha256);
  assert.equal(off.summary.provider_calls, outage.summary.provider_calls);
  emitJourney(t, family, method, {
    native_application: { outcome: 'observed', entry_point: method === 'agent.stream' ? 'Agent.stream' : method === 'workflow_suspend_resume' ? 'Workflow.start/createRun/resume -> Agent.generate' : 'Agent.generate',
      behavior: method, installed_framework: '@mastra/core', framework_version: '1.65.0', native_input_steps: compressed.summary.native_input_steps,
      process_restart: compressed.restarted, nested_ai_sdk_owner: 'Mastra' },
    ...recoveryJourney(compressed.context, family), native_result_history_events_and_call_count: compressed.summary,
    off_baseline: off.summary, optimizer_unavailable: outage.summary,
  });
}

async function runStructuredJourney(t, family, mode) {
  const context = await setup(t, family, 'cert-structured', mode);
  if (mode === 'compress') await beginNativeCertification(t, context.capabilities);
  const original = new Agent({ id: 'structured-certification', name: 'Native structured certification', instructions: 'Read and retain the source.',
    model: context.fixture.model('seed-original'), tools: { read_logs: context.read }, memory: context.memory, outputProcessors: [context.capture] });
  const bootstrap = await original.generate('Read logs and retain omitted-detail-80.', context.params);
  assert.equal(bootstrap.text, 'omitted-detail-80'); assert.equal(context.reads(), 1); assert.equal(context.fixture.state.calls.length, 2);
  const agent = withCavemanMastra(original, { runtime: context.runtime, scope: context.selectedScope });
  const result = await agent.generate('Return the retained fact as the typed answer.', { ...context.params, model: context.fixture.model('structured-journey'), structuredOutput: { schema: z.object({ answer: z.string() }) } });
  assert.deepEqual(result.object, { answer: 'omitted-detail-80' });
  assert.equal(context.fixture.state.calls.length, 3); assert.equal(context.reads(), 1);
  assert.deepEqual(context.fixture.state.errors, []); assert.equal(context.retrievals.length, 0);
  assert.ok(context.fixture.state.responses.every(response => response.tool?.name !== 'caveman_retrieve'));
  assert.equal(context.rpc.flatMap(row => row.response.replacements ?? []).length, 0);
  const typedBody = context.fixture.state.calls[2].body;
  assert.equal(originalDigest(typedBody), sha256(source));
  assert.ok(!JSON.stringify(typedBody).includes('caveman_retrieve'));
  const remembered = await context.memory.recall({ threadId: context.selectedScope.session_id, resourceId: 'fixture-user' });
  const summary = { outcome: 'observed', typed_object: result.object, bootstrap_provider_calls: 2, typed_provider_calls: 1, provider_calls: context.fixture.state.calls.length,
    native_read_executions: context.reads(), recovery_requests: context.retrievals.length, replacements: context.rpc.flatMap(row => row.response.replacements ?? []).length,
    original_sha256: sha256(context.readResults[0]), retained_memory_sha256: originalDigest(remembered.messages),
    message_list_sha256: originalDigest(context.history.at(-1).db), ui_history_sha256: originalDigest(context.history.at(-1).ui), typed_request_sha256: sha256(context.fixture.state.calls[2].raw), native_reports: nativeReports(context, 1) };
  if (mode === 'compress') {
    assert.equal(await waitUntil(() => context.receipts.some(row => row.event_kind === 'completed')), true);
    assert.equal(context.receipts.filter(row => row.event_kind === 'completed').length, 1);
  }
  if (mode === 'off') assert.equal(context.fetchAttempts.length, 0);
  if (mode === 'outage') assert.ok(context.fetchAttempts.some(row => row.path.endsWith('/capabilities')));
  return { context, summary };
}

async function certifyStructuredCell(t, family) {
  const compressed = await runStructuredJourney(t, family, 'compress'), off = await runStructuredJourney(t, family, 'off'), outage = await runStructuredJourney(t, family, 'outage');
  assert.equal(compressed.summary.typed_request_sha256, off.summary.typed_request_sha256); assert.equal(off.summary.typed_request_sha256, outage.summary.typed_request_sha256);
  const recoveryFree = { outcome: 'recovery_free', reason: 'native structuredOutput preserves the full source and excludes executable recovery',
    recovery_requests: compressed.context.retrievals.length, replacements: compressed.context.rpc.flatMap(row => row.response.replacements ?? []).length,
    full_source_sha256: originalDigest(compressed.context.fixture.state.calls[2].body), typed_provider_calls: 1 };
  emitJourney(t, family, 'agent.structured_output', {
    native_application: { outcome: 'observed', entry_point: 'Agent.generate({structuredOutput:{schema}})', installed_framework: '@mastra/core', framework_version: '1.65.0', native_object: compressed.summary.typed_object },
    real_tool_result: { outcome: 'observed', phase: 'native Agent.generate bootstrap before typed continuation', native_tool: 'read_logs', executions: compressed.context.reads(),
      utf8_bytes: Buffer.byteLength(compressed.context.readResults[0]), sha256: sha256(compressed.context.readResults[0]) },
    transformed_provider_request: recoveryFree, omitted_fact_requested: recoveryFree, host_executes_exact_recovery: recoveryFree,
    native_result_history_events_and_call_count: compressed.summary, off_baseline: off.summary, optimizer_unavailable: outage.summary,
  });
}

// Attribute actual reader allocations to the executed observeStream frame.
// Mastra inserts a conversion stream above provider SDK streams, so probing
// only the provider's getReader would miss the middleware-owned reader.
function inspectMiddlewareReaders(t) {
  const original = ReadableStream.prototype.getReader;
  let current;
  ReadableStream.prototype.getReader = function (...args) {
    const reader = Reflect.apply(original, this, args);
    if (!current || !/at observeStream \([^\n]+[/\\]common\.js:\d+:\d+\)/.test(new Error().stack)) return reader;
    const state = current, read = reader.read.bind(reader), release = reader.releaseLock.bind(reader);
    state.acquired++;
    reader.read = (...args) => {
      state.reads++; state.pending++; state.peakPending = Math.max(state.peakPending, state.pending);
      return read(...args).finally(() => { state.pending--; });
    };
    reader.releaseLock = () => { release(); state.released++; };
    return reader;
  };
  t.after(() => { ReadableStream.prototype.getReader = original; });
  return { begin() { current = { acquired: 0, released: 0, reads: 0, pending: 0, peakPending: 0 }; return current; } };
}

// Keep real provider streams intact and retain references only for lock probes.
function inspectNativeReaders(model, state) {
  const streams = [];
  const tracked = new Proxy(model, { get(target, key) {
    if (key === 'doStream') return async (...args) => {
      const result = await Reflect.apply(target.doStream, target, args), stream = result.stream;
      streams.push(stream);
      return result;
    };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { model: tracked, state, snapshot: () => ({ provider_streams: streams.length, locked_provider_streams: streams.filter(stream => stream.locked).length,
    observed_reader_acquires: state.acquired, observed_reader_releases: state.released, active_observed_readers: state.acquired - state.released,
    pending_observed_reads: state.pending, peak_pending_observed_reads: state.peakPending }) };
}

function runtimeCounters(runtime) {
  const counters = Object.fromEntries(['pending', 'receiptsPending', 'fetchesPending', 'receiptFetchesPending'].map(key => [key, Reflect.get(runtime, key)]));
  assert.ok(Object.values(counters).every(value => Number.isSafeInteger(value) && value >= 0));
  return counters;
}
const runtimeIdle = runtime => Object.values(runtimeCounters(runtime)).every(value => value === 0);

async function certifyCancellationParity(t, family) {
  const runs = [], readerProbe = inspectMiddlewareReaders(t);
  for (const mode of ['compress', 'off', 'outage']) for (const surface of ['textStream', 'fullStream']) for (const action of ['close', 'abort']) {
    const context = await setup(t, family, `cert-cancel-${surface}-${action}`, mode);
    if (mode === 'compress') await beginNativeCertification(t, context.capabilities);
    const probe = inspectNativeReaders(context.fixture.model('journey-cancel'), readerProbe.begin());
    const logicalReceipts = [], observe = context.runtime.observe.bind(context.runtime);
    context.runtime.observe = receipt => { logicalReceipts.push(structuredClone(receipt)); return observe(receipt); };
    const controller = new AbortController();
    const output = await context.agent.stream('Read logs and report omitted-detail-80.', { ...context.params, model: probe.model, abortSignal: controller.signal });
    const iterator = output[surface][Symbol.asyncIterator]();
    let first;
    do { first = await bounded(iterator.next(), 'certification first native chunk'); }
    while (!first.done && surface === 'fullStream' && first.value.type !== 'text-delta');
    const firstText = surface === 'textStream' ? first.value : first.value.payload.text;
    assert.equal(firstText, 'omitted'); assert.equal(context.fixture.state.released, false);
    const expectedCalls = mode === 'compress' ? 3 : 2;
    assert.equal(context.fixture.state.calls.length, expectedCalls); assert.equal(context.reads(), 1);
    assert.equal(await waitUntil(() => runtimeIdle(context.runtime)), true);
    assert.equal(probe.snapshot().locked_provider_streams, 1);
    if (mode !== 'off') {
      assert.equal(probe.state.acquired, expectedCalls); assert.equal(probe.state.released, expectedCalls - 1);
      assert.equal(await waitUntil(() => probe.state.pending === 1), true);
      assert.equal(probe.state.peakPending, 1);
    }
    const duringGeneration = probe.snapshot();
    let closeDetached = false, closeResult = null, abortResult = null, afterClose = null;
    if (action === 'close') {
      const returned = await bounded(iterator.return(), 'certification native close');
      assert.deepEqual(returned, { done: true, value: undefined });
      closeResult = { done: returned.done, value_is_undefined: returned.value === undefined };
      const reads = probe.state.reads;
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(context.fixture.state.closed, false); assert.equal(context.fixture.state.released, false);
      assert.equal(output.status, 'running'); assert.equal(context.fixture.state.calls.length, expectedCalls);
      assert.equal(probe.state.reads, reads, 'detaching the native event listener introduces no new reader loop');
      assert.deepEqual(probe.snapshot(), duringGeneration);
      assert.equal(runtimeIdle(context.runtime), true);
      assert.equal(logicalReceipts.filter(row => row.event_kind === 'cancelled').length, 0);
      afterClose = { native_status: output.status, readers: probe.snapshot(), rpc_counters: runtimeCounters(context.runtime), provider_closed: context.fixture.state.closed };
      closeDetached = true;
    } else {
      const pending = iterator.next(); controller.abort();
      const returned = await bounded(pending, 'certification active abort');
      if (surface === 'textStream') {
        assert.deepEqual(returned, { done: true, value: undefined }); abortResult = { done: returned.done, value_is_undefined: returned.value === undefined };
      } else {
        assert.equal(returned.done, false);
        const { runId, ...event } = returned.value;
        assert.match(runId, /^[a-f0-9-]{36}$/); assert.deepEqual(event, { type: 'abort', from: 'AGENT', payload: {} });
        abortResult = { done: returned.done, event, volatile_run_id_present: true };
      }
      assert.equal(await waitUntil(() => context.fixture.state.closed), true);
    }
    controller.abort(); assert.equal(await waitUntil(() => context.fixture.state.closed), true); await bounded(iterator.return(), 'certification cancellation cleanup');
    assert.equal(await waitUntil(() => output.status === 'canceled' && probe.snapshot().locked_provider_streams === 0 && runtimeIdle(context.runtime)), true);
    assert.equal(probe.state.pending, 0); assert.equal(probe.state.acquired, probe.state.released);
    if (mode !== 'off') {
      const cancelled = logicalReceipts.filter(row => row.event_kind === 'cancelled');
      assert.equal(cancelled.length, 1); assert.equal(cancelled[0].usage, null);
      assert.equal(logicalReceipts.filter(row => row.event_kind === 'dispatch_intent').length, expectedCalls);
      assert.equal(logicalReceipts.filter(row => row.event_kind === 'completed').length, expectedCalls - 1);
      assert.equal(logicalReceipts.filter(row => row.attempt_id === cancelled[0].attempt_id && row.event_kind !== 'dispatch_intent').length, 1);
      if (mode === 'compress') {
        assert.equal(context.receipts.filter(row => row.event_kind === 'cancelled').length, 1);
        assert.equal(context.receipts.find(row => row.event_kind === 'cancelled').usage, null);
      }
    } else {
      assert.equal(logicalReceipts.length, 0);
    }
    if (mode !== 'compress') { assert.equal(toolResults(context.fixture.state.calls[1].body, family).find(result => result.id === 'read-1').text, source); assert.equal(context.retrievals.length, 0); }
    const nativeDB = output.messageList.get.all.db(), nativeUI = output.messageList.get.all.aiV5.ui();
    const remembered = await context.memory.recall({ threadId: context.selectedScope.session_id, resourceId: 'fixture-user' });
    assert.equal(originalDigest(nativeDB), sha256(source)); assert.equal(originalDigest(nativeUI), sha256(source));
    assert.equal(context.fixture.state.calls.length - context.retrievals.length, 2, 'only the actual recovery request adds a native step');
    assert.deepEqual(context.fixture.state.errors, []);
    runs.push({ context, mode, surface, action, observation: { outcome: 'observed', surface, action, first_text: firstText, first_chunk_before_release: true,
      close_result: closeResult, active_abort_result: abortResult, close_detaches_without_transport_cancellation: closeDetached,
      during_native_generation: duringGeneration, after_native_close: afterClose, after_explicit_abort: { native_status: output.status, readers: probe.snapshot(), rpc_counters: runtimeCounters(context.runtime) },
      abort_closes_provider: context.fixture.state.closed, provider_calls: context.fixture.state.calls.length, native_read_executions: context.reads(), recovery_requests: context.retrievals.length,
      logical_cancelled_receipts: logicalReceipts.filter(row => row.event_kind === 'cancelled').length,
      cancelled_receipt_usage: logicalReceipts.find(row => row.event_kind === 'cancelled')?.usage ?? null,
      message_list_sha256: originalDigest(nativeDB), ui_history_sha256: originalDigest(nativeUI), memory_retains_original: hasOriginal(remembered.messages), native_reports: nativeReports(context, expectedCalls) } });
  }
  for (const surface of ['textStream', 'fullStream']) for (const action of ['close', 'abort']) {
    const selected = runs.filter(run => run.surface === surface && run.action === action);
    for (const run of selected.slice(1)) {
      assert.deepEqual(run.observation.close_result, selected[0].observation.close_result);
      assert.deepEqual(run.observation.active_abort_result, selected[0].observation.active_abort_result);
      assert.equal(run.observation.first_text, selected[0].observation.first_text);
      assert.equal(run.observation.after_explicit_abort.native_status, selected[0].observation.after_explicit_abort.native_status);
      assert.equal(run.observation.memory_retains_original, selected[0].observation.memory_retains_original);
    }
  }
  const compressed = runs.find(run => run.mode === 'compress' && run.surface === 'textStream' && run.action === 'abort');
  emitJourney(t, family, 'cancel_and_close', {
    native_application: { outcome: 'observed', entry_point: 'Agent.stream.textStream/fullStream', installed_framework: '@mastra/core', framework_version: '1.65.0' },
    ...recoveryJourney(compressed.context, family),
    native_result_history_events_and_call_count: { outcome: 'observed', terminal_kind: 'native_canceled_after_explicit_abort', native_close_semantics: 'listener_detach_keeps_native_generation_alive',
      actions: runs.filter(run => run.mode === 'compress').map(run => run.observation) },
    off_baseline: { outcome: 'observed', actions: runs.filter(run => run.mode === 'off').map(run => run.observation) },
    optimizer_unavailable: { outcome: 'observed', actions: runs.filter(run => run.mode === 'outage').map(run => run.observation) },
    native_iterator_close_limited: { outcome: 'observed_native_semantics', reason: 'Mastra 1.65.0 iterator.return detaches the native listener; active generation and its one native-pulled observer remain until explicit AbortSignal.',
      close_observation_delay_ms: 100, actions: runs.map(run => ({ mode: run.mode, ...run.observation })) },
  });
}

test('Mastra F16 openai agent.generate exact journey', { timeout: 30000 }, t => certifyOrdinaryCell(t, 'openai', 'agent.generate'));
test('Mastra F16 anthropic agent.generate exact journey', { timeout: 30000 }, t => certifyOrdinaryCell(t, 'anthropic', 'agent.generate'));
test('Mastra F16 openai agent.stream exact journey', { timeout: 30000 }, t => certifyOrdinaryCell(t, 'openai', 'agent.stream'));
test('Mastra F16 anthropic agent.stream exact journey', { timeout: 30000 }, t => certifyOrdinaryCell(t, 'anthropic', 'agent.stream'));
test('Mastra F16 openai agent.structured_output recovery-free journey', { timeout: 30000 }, t => certifyStructuredCell(t, 'openai'));
test('Mastra F16 anthropic agent.structured_output recovery-free journey', { timeout: 30000 }, t => certifyStructuredCell(t, 'anthropic'));
test('Mastra F16 openai processLLMRequest.every_step exact journey', { timeout: 30000 }, t => certifyOrdinaryCell(t, 'openai', 'processLLMRequest.every_step'));
test('Mastra F16 anthropic processLLMRequest.every_step exact journey', { timeout: 30000 }, t => certifyOrdinaryCell(t, 'anthropic', 'processLLMRequest.every_step'));
test('Mastra F16 openai MessageList_memory_and_UI_history exact journey', { timeout: 30000 }, t => certifyOrdinaryCell(t, 'openai', 'MessageList_memory_and_UI_history'));
test('Mastra F16 anthropic MessageList_memory_and_UI_history exact journey', { timeout: 30000 }, t => certifyOrdinaryCell(t, 'anthropic', 'MessageList_memory_and_UI_history'));
test('Mastra F16 openai workflow_suspend_resume exact journey', { timeout: 30000 }, t => certifyOrdinaryCell(t, 'openai', 'workflow_suspend_resume'));
test('Mastra F16 anthropic workflow_suspend_resume exact journey', { timeout: 30000 }, t => certifyOrdinaryCell(t, 'anthropic', 'workflow_suspend_resume'));
test('Mastra F16 openai native_tool_execution exact journey', { timeout: 30000 }, t => certifyOrdinaryCell(t, 'openai', 'native_tool_execution'));
test('Mastra F16 anthropic native_tool_execution exact journey', { timeout: 30000 }, t => certifyOrdinaryCell(t, 'anthropic', 'native_tool_execution'));
test('Mastra F16 openai nested_AI_SDK_ownership exact journey', { timeout: 30000 }, t => certifyOrdinaryCell(t, 'openai', 'nested_AI_SDK_ownership'));
test('Mastra F16 anthropic nested_AI_SDK_ownership exact journey', { timeout: 30000 }, t => certifyOrdinaryCell(t, 'anthropic', 'nested_AI_SDK_ownership'));
test('Mastra F16 openai cancel_and_close preserves native lifecycle and releases observer resources', { timeout: 30000 }, t => certifyCancellationParity(t, 'openai'));
test('Mastra F16 anthropic cancel_and_close preserves native lifecycle and releases observer resources', { timeout: 30000 }, t => certifyCancellationParity(t, 'anthropic'));
