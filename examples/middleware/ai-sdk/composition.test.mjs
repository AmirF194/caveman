import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { hash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, jsonSchema, stepCountIs, streamText, tool } from 'ai';
import { createMiddlewareRuntime } from '../../../packages/sdk/typescript/dist/middleware/index.js';
import { withCaveman } from '../../../packages/middleware/typescript/dist/ai-sdk.js';
import { createCavemanFetch } from '../../../packages/middleware/typescript/dist/openai.js';
import { startRuntime } from '../../../packages/middleware/conformance/runtime-fixture.mjs';

// Anthropic is loaded from the existing exact-version native environment. This
// fixture proves the public provider fetch seam, not an OpenAI/Anthropic SDK
// client class inside AI SDK. No additional compression implementation exists.
const anthropicRequire = createRequire(new URL('../mastra/package.json', import.meta.url));
const { createAnthropic } = anthropicRequire('@ai-sdk/anthropic');
const binarySHA256 = hash('sha256', readFileSync(process.env.CAVEMAN_MIDDLEWARE_TEST_BINARY));
const nativeVersions = {
  ai: JSON.parse(readFileSync(new URL('node_modules/ai/package.json', import.meta.url))).version,
  openai_provider: JSON.parse(readFileSync(new URL('node_modules/@ai-sdk/openai/package.json', import.meta.url))).version,
  anthropic_provider: JSON.parse(readFileSync(new URL('../mastra/node_modules/@ai-sdk/anthropic/package.json', import.meta.url))).version,
};
assert.deepEqual(nativeVersions, { ai: '7.0.94', openai_provider: '4.0.62', anthropic_provider: '4.0.50' });
const original = Array.from({ length: 150 }, (_, i) => `[INFO] reading row ${i}: café 🌍 exact-value-${String(i).padStart(3, '0')} verbose repeated details\r\n`).join('');
const omittedFact = 'exact-value-074';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function within(promise, milliseconds, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
const cell = provider => `F04|typescript|${provider}|${provider === 'openai' ? 'openai-chat-completions' : 'anthropic-messages'}|nested_provider_client_ownership|async|complete|unstructured|native_executor`;
function evidence(t, provider, assertion, observation) {
  t.diagnostic('CAVEMAN_MIDDLEWARE_OBSERVATION ' + JSON.stringify({ cell_id: cell(provider), assertion,
    test_id: `examples/middleware/ai-sdk/composition.test.mjs::${t.name}`,
    observation: { runtime_binary_sha256: binarySHA256, native_versions: nativeVersions, ...observation } }));
}
function toolText(body, provider, id) {
  if (provider === 'openai') return body.messages.find(m => m.role === 'tool' && m.tool_call_id === id)?.content;
  const result = body.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).find(p => p.type === 'tool_result' && p.tool_use_id === id);
  if (typeof result?.content === 'string') return result.content;
  return result?.content?.map(p => p.text ?? '').join('');
}
function reply(res, provider, { name, args = {}, id, text = omittedFact }) {
  res.writeHead(200, { 'content-type': 'application/json' });
  const payload = provider === 'openai' ? {
    id: 'chatcmpl_composition', object: 'chat.completion', created: 1, model: 'fixture-model',
    choices: [{ index: 0, message: { role: 'assistant', content: name ? null : text,
      ...(name ? { tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : {}) }, finish_reason: name ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020 },
  } : { id: 'msg_composition', type: 'message', role: 'assistant', model: 'fixture-model',
    content: name ? [{ type: 'tool_use', id, name, input: args }] : [{ type: 'text', text }],
    stop_reason: name ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 20 } };
  res.end(JSON.stringify(payload));
}
function beginStream(res, provider) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  if (provider === 'openai') {
    const send = (content, finish = null) => res.write(`data: ${JSON.stringify({ id: 'chatcmpl_stream', object: 'chat.completion.chunk', created: 1, model: 'fixture-model',
      choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: finish }],
      ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } } : {}) })}\n\n`);
    send('first');
    return () => { send('-last'); send(null, 'stop'); res.end('data: [DONE]\n\n'); };
  }
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send('message_start', { message: { id: 'msg_stream', type: 'message', role: 'assistant', model: 'fixture-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'first' } });
  return () => {
    send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '-last' } });
    send('content_block_stop', { index: 0 });
    send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } });
    send('message_stop', {}); res.end();
  };
}
async function providerFixture(provider) {
  const calls = [], errors = [], first = deferred(), release = deferred(), closed = deferred();
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const wire = Buffer.concat(chunks).toString('utf8'), body = JSON.parse(wire);
      calls.push({ body, wire, headers: req.headers, path: req.url });
      res.on('close', closed.resolve);
      if (body.model === 'failure') {
        res.writeHead(503, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'composition provider failure' } }));
      }
      if (body.stream) { const finish = beginStream(res, provider); first.resolve(); await release.promise; finish(); return; }
      const logs = toolText(body, provider, 'read-1');
      if (logs === undefined) return reply(res, provider, { name: 'read_logs', id: 'read-1' });
      const handle = logs.match(/cmw_[a-f0-9]{48}/)?.[0];
      if (handle) {
        assert.ok(!logs.includes(omittedFact), 'recovery is requested for a genuinely omitted fact');
        const recovered = toolText(body, provider, 'recover-1');
        if (recovered === undefined) return reply(res, provider, { name: 'caveman_retrieve', args: { handle }, id: 'recover-1' });
        const page = JSON.parse(recovered);
        assert.equal(page.text, original); assert.equal(page.complete, true);
      } else assert.equal(logs, original);
      reply(res, provider, {});
    } catch (error) { errors.push(error.message); res.destroy(error); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { calls, errors, first, release, closed, url: `http://127.0.0.1:${server.address().port}/v1`,
    close: async () => { release.resolve(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
function instrumentRuntime(endpoint, mode = 'compress') {
  const plans = [], receipts = [];
  const runtime = createMiddlewareRuntime({ endpoint, mode });
  const optimize = runtime.optimize.bind(runtime), observe = runtime.observe.bind(runtime);
  runtime.optimize = async options => { const result = await optimize(options); plans.push({ options, result }); return result; };
  runtime.observe = receipt => { receipts.push(receipt); return observe(receipt); };
  return { runtime, plans, receipts };
}
function nativeModel(provider, fixture, runtime, scope, modelId = 'fixture-model', transportCalls = []) {
  const transport = createCavemanFetch({ runtime, scope, provider, providerBaseURL: fixture.url,
    frameworkVersion: provider === 'openai' ? '4.0.62' : '4.0.50', fetch: async (input, init) => {
      transportCalls.push({ url: String(input), wire: init.body }); return fetch(input, init);
    } });
  return provider === 'openai'
    ? createOpenAI({ baseURL: fixture.url, apiKey: 'local-fixture', fetch: transport }).chat(modelId)
    : createAnthropic({ baseURL: fixture.url, apiKey: 'local-fixture', fetch: transport })(modelId);
}

async function journey(t, provider) {
    const service = await startRuntime(); t.after(service.stop);
    const fixture = await providerFixture(provider); t.after(fixture.close);
    const observed = instrumentRuntime(service.endpoint); t.after(() => observed.runtime.close()); await observed.runtime.ready();
    const scope = { namespace: 'composition', session_id: `ai-sdk-${provider}`, branch_id: 'main', cache_epoch: '0' };
    const transportCalls = [], executions = [];
    const model = nativeModel(provider, fixture, observed.runtime, scope, 'fixture-model', transportCalls);
    const messages = [{ role: 'user', content: 'Read logs and recover the exact value from row 74.' }], before = structuredClone(messages);
    const tools = { read_logs: tool({ inputSchema: jsonSchema({ type: 'object', properties: {}, additionalProperties: false }), execute: async () => { executions.push('read_logs'); return original; } }) };
    const input = { model, messages, tools, maxOutputTokens: 100, maxRetries: 0, stopWhen: stepCountIs(5) };
    const wrapped = withCaveman(input, { runtime: observed.runtime, scope });
    const registeredRecovery = wrapped.tools.caveman_retrieve.execute;
    assert.equal(typeof registeredRecovery, 'function');
    const result = await generateText(wrapped);
    assert.equal(result.text, omittedFact); assert.equal(result.steps.length, 3); assert.deepEqual(messages, before);
    assert.deepEqual(executions, ['read_logs']); assert.equal(fixture.calls.length, 3); assert.equal(transportCalls.length, 3);
    assert.ok(transportCalls.every((call, i) => call.wire === fixture.calls[i].wire));
    assert.equal(observed.plans.length, 3, 'exactly one optimizer call per native model request');
    assert.ok(observed.plans.every(p => p.options.adapter.id === 'ai-sdk'), 'F01/F02 transport yields ownership to F04');
    assert.equal(observed.receipts.filter(r => r.event_kind === 'dispatch_intent').length, 3);
    const completed = observed.receipts.filter(r => r.event_kind === 'completed');
    assert.equal(completed.length, 3); assert.deepEqual(completed.map(r => r.provider_request_sha256), fixture.calls.map(c => hash('sha256', c.wire)));
    assert.ok(fixture.calls.every(c => !('x-cave-transforms' in c.headers)));
    const compressed = toolText(fixture.calls[1].body, provider, 'read-1');
    assert.ok(compressed.includes('cmw_')); assert.ok(!compressed.includes(omittedFact));
    const recoveryResult = result.steps.flatMap(s => s.toolResults).find(r => r.toolName === 'caveman_retrieve');
    assert.equal(recoveryResult.output.text, original); assert.equal(recoveryResult.output.complete, true);
    assert.ok(JSON.stringify(await result.responseMessages).includes(omittedFact)); assert.deepEqual(fixture.errors, []);
    const common = { provider, native_calls: 3, transport_calls: 3, optimize_calls: 3, optimizer_owner: 'ai-sdk',
      native_steps: 3, original_sha256: hash('sha256', original), recovery_sha256: hash('sha256', recoveryResult.output.text), recovery_executor: 'AI SDK registered binding.execute' };
    for (const assertion of ['native_application', 'real_tool_result', 'transformed_provider_request', 'omitted_fact_requested', 'host_executes_exact_recovery', 'native_result_history_events_and_call_count']) evidence(t, provider, assertion, common);

    for (const mode of ['off', 'outage']) {
      const other = instrumentRuntime(mode === 'outage' ? 'http://127.0.0.1:1' : service.endpoint, mode === 'off' ? 'off' : 'compress');
      t.after(() => other.runtime.close());
      const beforeCalls = fixture.calls.length;
      const baselineInput = { ...input, model: nativeModel(provider, fixture, other.runtime, { ...scope, session_id: `${scope.session_id}-${mode}` }) };
      const baselineOptions = withCaveman(baselineInput, { runtime: other.runtime, scope: { ...scope, session_id: `${scope.session_id}-${mode}` } });
      if (mode === 'off') assert.equal(baselineOptions, baselineInput, 'off returns the native AI SDK options');
      const baseline = await generateText(baselineOptions);
      assert.equal(baseline.text, omittedFact); assert.equal(fixture.calls.length - beforeCalls, 2);
      assert.equal(toolText(fixture.calls.at(-1).body, provider, 'read-1'), original);
      if (mode === 'off') assert.equal(other.plans.length, 0);
      evidence(t, provider, mode === 'off' ? 'off_baseline' : 'optimizer_unavailable', { provider, native_calls: 2, original_reaches_provider: true, answer: baseline.text, optimizer_calls: other.plans.length });
    }
}

async function lifecycle(t, provider) {
    const service = await startRuntime(); t.after(service.stop);
    const fixture = await providerFixture(provider); t.after(fixture.close);
    const observed = instrumentRuntime(service.endpoint); t.after(() => observed.runtime.close()); await observed.runtime.ready();
    const scope = { namespace: 'composition', session_id: `ai-sdk-${provider}-stream`, branch_id: 'main', cache_epoch: '0' };
    const model = nativeModel(provider, fixture, observed.runtime, scope);
    const result = streamText(withCaveman({ model, messages: [{ role: 'user', content: 'Stream.' }], maxOutputTokens: 100, maxRetries: 0 }, { runtime: observed.runtime, scope }));
    const reader = result.textStream.getReader();
    const first = await within(reader.read(), 3000, 'native first chunk waited for EOF');
    assert.equal(first.value, 'first'); fixture.release.resolve();
    let text = first.value; for (;;) { const next = await reader.read(); if (next.done) break; text += next.value; }
    assert.equal(text, 'first-last'); assert.equal(observed.plans.length, 1);
    assert.equal(observed.receipts.filter(r => r.event_kind === 'completed').length, 1);

    const failureScope = { ...scope, session_id: `${scope.session_id}-failure` }, start = fixture.calls.length;
    const failure = nativeModel(provider, fixture, observed.runtime, failureScope, 'failure');
    await assert.rejects(generateText(withCaveman({ model: failure, messages: [{ role: 'user', content: 'Fail.' }], maxOutputTokens: 100, maxRetries: 0 }, { runtime: observed.runtime, scope: failureScope })), /composition provider failure/);
    assert.equal(fixture.calls.length - start, 1); assert.equal(observed.receipts.filter(r => r.event_kind === 'failed').length, 1);

    const cancelFixture = await providerFixture(provider); t.after(cancelFixture.close);
    const cancelScope = { ...scope, session_id: `${scope.session_id}-cancel` };
    const cancelledModel = withCaveman({ model: nativeModel(provider, cancelFixture, observed.runtime, cancelScope) }, { runtime: observed.runtime, scope: cancelScope }).model;
    // AI SDK's public native LanguageModelV4 stream exercises consumer cancel
    // directly, without a framework tee continuing consumption in the background.
    const native = await cancelledModel.doStream({ maxOutputTokens: 100, prompt: [{ role: 'user', content: [{ type: 'text', text: 'Cancel.' }] }] });
    const cancelReader = native.stream.getReader();
    while ((await cancelReader.read()).value?.type !== 'text-delta') { /* native start events */ }
    await cancelReader.cancel('consumer cancelled');
    await within(cancelFixture.closed.promise, 1000, 'native consumer cancellation did not close provider response');
    assert.equal(observed.receipts.filter(r => r.event_kind === 'cancelled').length, 1);
    assert.equal(cancelFixture.calls.length, 1); cancelFixture.release.resolve();
    assert.deepEqual(fixture.errors, []); assert.deepEqual(cancelFixture.errors, []);
    evidence(t, provider, 'native_stream_failure_and_cancel', { first_chunk_before_eof: true, stream_answer: text, cancellation_receipts: 1,
      provider_response_closed_on_cancel: true, native_failure_calls: 1, native_failure_receipts: 1 });
}

test('native AI SDK openai composes with public provider transport and executes exact recovery', { timeout: 30000 }, t => journey(t, 'openai'));
test('native AI SDK anthropic composes with public provider transport and executes exact recovery', { timeout: 30000 }, t => journey(t, 'anthropic'));
test('native AI SDK openai transport composition preserves streaming cancellation and provider failure', { timeout: 20000 }, t => lifecycle(t, 'openai'));
test('native AI SDK anthropic transport composition preserves streaming cancellation and provider failure', { timeout: 20000 }, t => lifecycle(t, 'anthropic'));
