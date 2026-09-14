/** Installed AI SDK generation and ToolLoopAgent journeys over local provider HTTP. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, streamText, ToolLoopAgent, Output, tool, jsonSchema, stepCountIs, wrapLanguageModel } from 'ai';
import { z } from 'zod';
import { createMiddlewareRuntime } from '../../../packages/sdk/typescript/dist/middleware/index.js';
import { withCaveman, createCavemanMiddleware } from '../../../packages/middleware/typescript/dist/ai-sdk.js';
import { createCavemanFetch } from '../../../packages/middleware/typescript/dist/openai.js';
import { startRuntime } from '../../../packages/middleware/conformance/runtime-fixture.mjs';
import { beginNativeCertification, emitJourney } from './certification-evidence.mjs';

const requireAnthropic = createRequire(new URL(process.env.CAVEMAN_MIDDLEWARE_PACKAGED_TEST === '1' ? './package.json' : '../mastra/package.json', import.meta.url));
const { createAnthropic } = requireAnthropic('@ai-sdk/anthropic');
const source = Array.from({ length: 150 }, (_, i) => `[INFO] reading row ${i}: café 🌍 exact-value-${String(i).padStart(3, '0')} verbose repeated details\r\n`).join('');
const fact = 'exact-value-074';
const sha = value => createHash('sha256').update(value).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function bounded(promise, message, limit = 4000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, no) => { timer = setTimeout(() => no(new Error(message)), limit); })]); }
  finally { clearTimeout(timer); }
}
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(yes => setTimeout(yes, 10)); }
  assert.ok(predicate(), 'native lifecycle did not settle');
}
function toolText(body, provider, id) {
  if (provider === 'openai') return body.messages.find(message => message.role === 'tool' && message.tool_call_id === id)?.content;
  const result = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).find(part => part.type === 'tool_result' && part.tool_use_id === id);
  return typeof result?.content === 'string' ? result.content : result?.content?.map(part => part.text ?? '').join('');
}
function nativeJSON(provider, action) {
  const { name, id, args = {}, text = fact } = action;
  return provider === 'openai' ? {
    id: 'chatcmpl_native_f04', object: 'chat.completion', created: 1, model: 'fixture-model',
    choices: [{ index: 0, message: { role: 'assistant', content: name ? null : text,
      ...(name ? { tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : {}) }, finish_reason: name ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020 },
  } : { id: 'msg_native_f04', type: 'message', role: 'assistant', model: 'fixture-model',
    content: name ? [{ type: 'tool_use', id, name, input: args }] : [{ type: 'text', text }],
    stop_reason: name ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 20 } };
}
async function nativeStream(res, provider, action, state) {
  const { name, id, args = {}, text = fact } = action;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const partial = text.slice(0, 6), rest = text.slice(6);
  if (provider === 'openai') {
    const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: 'chatcmpl_native_f04', object: 'chat.completion.chunk', created: 1, model: 'fixture-model',
      choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020 } } : {}) })}\n\n`);
    if (name) send({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
    else {
      send({ role: 'assistant', content: partial });
      if (state.gated) { state.waiting = true; await state.release.promise; if (res.destroyed) return; state.released = true; }
      send({ content: rest });
    }
    send({}, name ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n'); return;
  }
  const send = (type, payload) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
  send('message_start', { message: { id: 'msg_native_f04', type: 'message', role: 'assistant', model: 'fixture-model', content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 0 } } });
  if (name) {
    send('content_block_start', { index: 0, content_block: { type: 'tool_use', id, name, input: {} } });
    send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } });
  } else {
    send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: partial } });
    if (state.gated) { state.waiting = true; await state.release.promise; if (res.destroyed) return; state.released = true; }
    send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: rest } });
  }
  send('content_block_stop', { index: 0 });
  send('message_delta', { delta: { stop_reason: name ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } });
  send('message_stop', {}); res.end();
}
async function fixture(provider) {
  const state = { calls: [], responses: [], errors: [], closed: false, waiting: false, gated: false, released: false, structured: false, release: deferred() };
  const server = createServer(async (req, res) => {
    try {
      const parts = []; for await (const part of req) parts.push(part);
      const wire = Buffer.concat(parts).toString('utf8'), body = JSON.parse(wire);
      state.calls.push({ body, wire, headers: req.headers });
      const logs = toolText(body, provider, 'read-1'), recovered = toolText(body, provider, 'recover-1');
      let action;
      if (logs === undefined) action = { name: 'read_logs', id: 'read-1', args: {} };
      else {
        const handle = logs.match(/cmw_[a-f0-9]{48}/)?.[0];
        if (handle) {
          assert.ok(!logs.includes(fact));
          if (recovered === undefined) action = { name: 'caveman_retrieve', id: 'recover-1', args: { handle } };
          else { const page = JSON.parse(recovered); assert.equal(page.text, source); assert.equal(page.complete, true); }
        } else assert.equal(logs, source);
        action ??= { text: state.structured ? JSON.stringify({ answer: fact }) : fact };
      }
      state.responses.push(structuredClone(action));
      if (!action.name && state.gated) res.on('close', () => { state.closed = true; });
      if (body.stream) await nativeStream(res, provider, action, state);
      else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(nativeJSON(provider, action))); }
    } catch (error) { state.errors.push(error.message); res.destroy(error); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let stopped = false;
  return { state, url: `http://127.0.0.1:${server.address().port}/v1`, async close() {
    if (stopped) return; stopped = true; state.release.resolve(); server.closeAllConnections(); await new Promise(yes => server.close(yes));
  } };
}
const counters = runtime => Object.fromEntries(['pending', 'receiptsPending', 'fetchesPending', 'receiptFetchesPending'].map(key => [key, Reflect.get(runtime, key)]));
const idle = runtime => Object.values(counters(runtime)).every(value => value === 0);
async function setup(t, provider, method, mode) {
  const service = mode === 'outage' ? null : await startRuntime(); if (service) t.after(service.stop);
  const endpoint = service?.endpoint ?? 'http://127.0.0.1:1', providerFixture = await fixture(provider); t.after(providerFixture.close);
  const plans = [], retrievals = [], receipts = [], reports = [], runtimeHTTP = [], reads = [], nativeStreams = [], hookOrder = [], transport = [];
  const runtime = createMiddlewareRuntime({ endpoint, mode: mode === 'off' ? 'off' : 'compress', onReport: report => { reports.push(report); }, fetch: async (input, init) => {
    runtimeHTTP.push(new URL(input).pathname); return fetch(input, init);
  } }); t.after(() => runtime.close());
  const optimize = runtime.optimize.bind(runtime), retrieve = runtime.retrieve.bind(runtime), observe = runtime.observe.bind(runtime);
  runtime.optimize = async options => { const result = await optimize(options); plans.push({ options, result }); return result; };
  runtime.retrieve = async (selectedScope, args, signal) => { const result = await retrieve(selectedScope, args, signal); retrievals.push({ args, result }); return result; };
  runtime.observe = receipt => { receipts.push(structuredClone(receipt)); return observe(receipt); };
  if (mode === 'compress') await beginNativeCertification(t, await runtime.ready());
  const scope = { namespace: 'f04-certification', session_id: `${provider}-${method}-${mode}`, branch_id: 'main', cache_epoch: '0' };
  let providerFetch = fetch;
  if (method === 'nested_provider_client_ownership') providerFetch = createCavemanFetch({ runtime, scope, provider, providerBaseURL: providerFixture.url,
    frameworkVersion: provider === 'openai' ? '4.0.62' : '4.0.50', fetch: async (input, init) => { transport.push(init.body); return fetch(input, init); } });
  const nativeModel = provider === 'openai' ? createOpenAI({ baseURL: providerFixture.url, apiKey: 'local-fixture', fetch: providerFetch }).chat('fixture-model')
    : createAnthropic({ baseURL: providerFixture.url, apiKey: 'local-fixture', fetch: providerFetch })('claude-sonnet-4-5');
  const trackedModel = new Proxy(nativeModel, { get(target, key) {
    if (key === 'doStream') return async (...args) => { const result = await Reflect.apply(target.doStream, target, args); nativeStreams.push(result.stream); return result; };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const model = wrapLanguageModel({ model: trackedModel, middleware: { specificationVersion: 'v4', transformParams: ({ params }) => {
    hookOrder.push('caller-middleware'); return params;
  } } });
  const tools = { read_logs: tool({ description: 'Read retained source logs.', inputSchema: jsonSchema({ type: 'object', properties: {}, additionalProperties: false }),
    execute: async () => { reads.push(source); return source; } }) };
  const messages = [{ role: 'user', content: 'Read logs and report the exact row 74 value.' }];
  const input = { model, tools, messages, maxRetries: 0, maxOutputTokens: 100, temperature: 0.2, stopWhen: stepCountIs(5), headers: { 'x-fixture-native': 'f04' },
    onStepStart: () => { hookOrder.push('caller-step-start'); }, onStepEnd: () => { hookOrder.push('caller-step-end'); } };
  return { service, providerFixture, runtime, plans, retrievals, receipts, reports, runtimeHTTP, scope, reads, nativeStreams, hookOrder, transport, input, provider, mode };
}
function assertReports(context, providerCalls) {
  assert.equal(context.reports.length, providerCalls, 'one report per wrapped native inference turn, including nested transport');
  assert.equal(context.runtime.lastReport, context.reports.at(-1));
  for (const report of context.reports) {
    assert.ok(Object.isFrozen(report) && Object.isFrozen(report.transform_ids));
    assert.equal(report.adapter, 'ai-sdk');
    const result = context.plans.find(plan => plan.result.request?.logical_call_id === report.logical_call_id && plan.result.request?.attempt_id === report.attempt_id)?.result;
    const replacements = result?.replacements ?? [];
    assert.equal(report.status, context.mode === 'off' ? 'disabled' : replacements.length ? replacements.every(item => item.reused) ? 'reused' : 'applied' : 'skipped');
    assert.equal(report.replacement_count, replacements.length);
    assert.deepEqual(report.transform_ids, [...new Set(replacements.map(item => item.transform_id))].sort());
    assert.ok(!JSON.stringify(report).includes(source));
  }
  if (context.mode === 'off') { assert.equal(context.plans.length, 0); assert.equal(context.receipts.length, 0); assert.equal(context.runtimeHTTP.length, 0); }
  return { count: context.reports.length, statuses: context.reports.map(report => report.status), replacement_counts: context.reports.map(report => report.replacement_count), metadata_only: true };
}
function recoveryEvidence(context) {
  const { provider, providerFixture: { state }, retrievals, reads } = context;
  assert.deepEqual(reads, [source]);
  const shortened = toolText(state.calls[1].body, provider, 'read-1'), handle = shortened.match(/cmw_[a-f0-9]{48}/)?.[0];
  assert.ok(handle); assert.ok(!shortened.includes(fact)); assert.ok(Buffer.byteLength(shortened) < Buffer.byteLength(source));
  assert.deepEqual(state.responses[1], { name: 'caveman_retrieve', id: 'recover-1', args: { handle } });
  assert.equal(retrievals.length, 1); assert.equal(retrievals[0].args.handle, handle); assert.equal(retrievals[0].result.text, source);
  const page = JSON.parse(toolText(state.calls[2].body, provider, 'recover-1')); assert.equal(page.text, source); assert.equal(page.complete, true);
  return {
    real_tool_result: { outcome: 'observed', native_executor: 'AI SDK Tool.execute', executions: reads.length, source_sha256: sha(reads[0]), utf8_bytes: Buffer.byteLength(reads[0]) },
    transformed_provider_request: { outcome: 'observed', request_index: 2, omitted_fact_absent: true, shortened_utf8_bytes: Buffer.byteLength(shortened),
      normalized_shortened_sha256: sha(shortened.replaceAll(/cmw_[a-f0-9]{48}/g, '<OPAQUE_RECOVERY_HANDLE>')), normalization: 'replace runtime-generated handle only' },
    omitted_fact_requested: { outcome: 'observed', native_response_index: 2, requested_tool: state.responses[1].name, requested_exact_view_handle: true },
    host_executes_exact_recovery: { outcome: 'observed', native_executor: 'AI SDK registered recovery Tool.execute', executions: retrievals.length,
      runtime_recovered_sha256: sha(retrievals[0].result.text), provider_recovered_sha256: sha(page.text), complete: page.complete },
  };
}
function nativeEvidence(method) {
  return { outcome: 'observed', framework: 'ai', framework_version: '7.0.94', entry_point: method.startsWith('public_tool_loop')
    ? method.endsWith('.stream') ? 'ToolLoopAgent.stream' : 'ToolLoopAgent.generate'
    : method.startsWith('streamText') || method === 'cancel_and_close' ? 'streamText' : 'generateText', behavior: method };
}
async function runOrdinary(t, provider, method, mode) {
  const context = await setup(t, provider, method, mode), { input, runtime, scope, providerFixture: { state } } = context;
  const before = structuredClone(input.messages), nativeRead = input.tools.read_logs;
  const streaming = ['streamText', 'public_tool_loop.stream'].includes(method); state.gated = streaming;
  const bundle = withCaveman(input, { runtime, scope });
  if (mode === 'off') { assert.equal(bundle.messages, input.messages); assert.equal(bundle.tools, input.tools); }
  const agent = method.startsWith('public_tool_loop') ? new ToolLoopAgent(bundle) : null;
  const result = agent ? await (streaming ? agent.stream({ messages: input.messages }) : agent.generate({ messages: input.messages }))
    : streaming ? streamText(bundle) : await generateText(bundle);
  const events = [];
  if (streaming) {
    let first = false;
    for await (const event of result.fullStream) {
      events.push(event);
      if (event.type === 'text-delta' && !first) { first = true; assert.equal(event.text, fact.slice(0, 6)); assert.equal(state.released, false); state.release.resolve(); }
    }
    assert.ok(first); assert.ok(events.some(event => event.type === 'finish'));
  }
  const answer = await result.text, steps = await result.steps, history = await result.responseMessages;
  const expected = mode === 'compress' ? 3 : 2;
  assert.equal(answer, fact); assert.equal(state.calls.length, expected); assert.equal(steps.length, expected);
  assert.deepEqual(context.reads, [source]); assert.deepEqual(input.messages, before); assert.equal(input.tools.read_logs, nativeRead);
  assert.ok(JSON.stringify(history).includes(JSON.stringify(source).slice(1, -1)), 'native response history retains the exact source');
  assert.deepEqual(state.errors, []); assert.ok(state.calls.every(call => call.headers['x-fixture-native'] === 'f04' && call.body.temperature === 0.2));
  assert.deepEqual(context.hookOrder, Array.from({ length: expected }, () => ['caller-step-start', 'caller-middleware', 'caller-step-end']).flat());
  assert.ok(state.calls.every(call => JSON.stringify(call.body.tools) === JSON.stringify(state.calls[0].body.tools)));
  if (mode !== 'off') {
    await until(() => context.receipts.filter(receipt => receipt.event_kind === 'completed').length === expected && idle(runtime));
    assert.equal(context.plans.length, expected); assert.ok(context.plans.every(plan => plan.options.adapter.id === 'ai-sdk'));
    assert.equal(context.receipts.filter(receipt => receipt.event_kind === 'dispatch_intent').length, expected);
    assert.ok(context.receipts.filter(receipt => receipt.event_kind === 'completed').every(receipt => receipt.usage?.complete));
  } else { assert.equal(context.plans.length, 0); assert.equal(context.runtimeHTTP.length, 0); }
  if (mode !== 'compress') { assert.equal(toolText(state.calls[1].body, provider, 'read-1'), source); assert.equal(context.retrievals.length, 0); }
  if (mode === 'outage') assert.ok(context.runtimeHTTP.some(path => path.endsWith('/capabilities')));
  if (method === 'nested_provider_client_ownership') {
    assert.equal(context.transport.length, expected); assert.deepEqual(context.transport, state.calls.map(call => call.wire));
    assert.ok(state.calls.every(call => !call.headers['x-cave-transforms']));
    if (mode !== 'off') assert.deepEqual(context.receipts.filter(receipt => receipt.event_kind === 'completed').map(receipt => receipt.provider_request_sha256), state.calls.map(call => sha(call.wire)));
  }
  return { context, summary: { outcome: 'observed', native_reports: assertReports(context, expected), answer_sha256: sha(answer), provider_calls: expected, native_steps: steps.length, native_source_executions: context.reads.length,
    host_history_retains_original: true, caller_messages_unchanged: true, native_tool_identity_preserved: true, caller_hook_order: context.hookOrder,
    original_sha256: sha(context.reads[0]), recovery_requests: context.retrievals.length, replacements: context.plans.flatMap(plan => plan.result.replacements).length,
    native_event_types: [...new Set(events.map(event => event.type))].sort(), first_chunk_before_eof: streaming,
    nested_transport_calls: context.transport.length, optimizer_owners: [...new Set(context.plans.map(plan => plan.options.adapter.id))] } };
}
export async function certifyOrdinary(t, provider, method) {
  const compressed = await runOrdinary(t, provider, method, 'compress'), off = await runOrdinary(t, provider, method, 'off'), outage = await runOrdinary(t, provider, method, 'outage');
  assert.equal(compressed.summary.answer_sha256, off.summary.answer_sha256); assert.equal(off.summary.answer_sha256, outage.summary.answer_sha256);
  emitJourney(t, provider, method, { native_application: nativeEvidence(method), ...recoveryEvidence(compressed.context),
    native_result_history_events_and_call_count: compressed.summary, off_baseline: off.summary, optimizer_unavailable: outage.summary });
}

async function runModelOnly(t, provider, method, mode) {
  const context = await setup(t, provider, method, mode), { input, runtime, scope, providerFixture: { state } } = context;
  // The seed comes from the real SDK tool executor, never a fabricated history.
  const seed = await generateText(input); assert.equal(seed.text, fact); assert.equal(state.calls.length, 2); assert.deepEqual(context.reads, [source]);
  const messages = [...input.messages, ...seed.responseMessages, { role: 'user', content: 'Return the retained row 74 value.' }], before = structuredClone(messages);
  const structured = method.endsWith('.structured'), streaming = method === 'streamText.structured'; state.structured = structured; state.gated = streaming;
  const model = wrapLanguageModel({ model: input.model, middleware: createCavemanMiddleware({ runtime, scope }) });
  const options = { ...input, model, messages, ...(structured ? { output: Output.object({ schema: z.object({ answer: z.string() }) }) } : {}) };
  const result = streaming ? streamText(options) : await generateText(options);
  const events = [];
  if (streaming) for await (const event of result.fullStream) {
    events.push(event);
    if (event.type === 'text-delta' && !state.released) { assert.equal(state.released, false); state.release.resolve(); }
  }
  const answer = await result.text, output = structured ? await result.output : null;
  assert.equal(answer, structured ? JSON.stringify({ answer: fact }) : fact); if (structured) assert.deepEqual(output, { answer: fact });
  assert.equal(state.calls.length, 3); assert.deepEqual(context.reads, [source]); assert.deepEqual(messages, before);
  assert.equal(toolText(state.calls[2].body, provider, 'read-1'), source); assert.equal(context.retrievals.length, 0);
  assert.equal(context.plans.flatMap(plan => plan.result.replacements).length, 0); assert.ok(!JSON.stringify(state.calls[2].body).includes('caveman_retrieve'));
  assert.deepEqual(state.errors, []);
  if (mode !== 'off') await until(() => context.receipts.filter(receipt => receipt.event_kind === 'completed').length === 1 && idle(runtime));
  if (mode === 'off') assert.equal(context.runtimeHTTP.length, 0);
  if (mode === 'outage') assert.ok(context.runtimeHTTP.some(path => path.endsWith('/capabilities')));
  return { context, summary: { outcome: 'observed', native_reports: assertReports(context, 1), typed_output: output, answer_sha256: sha(answer), bootstrap_provider_calls: 2, tested_provider_calls: 1,
    provider_calls: state.calls.length, tested_request_sha256: sha(state.calls[2].wire), original_sha256: sha(context.reads[0]), native_source_executions: context.reads.length,
    original_history_unchanged: true, recovery_requests: context.retrievals.length, replacements: context.plans.flatMap(plan => plan.result.replacements).length,
    native_event_types: [...new Set(events.map(event => event.type))].sort(), first_chunk_before_eof: streaming } };
}
export async function certifyModelOnly(t, provider, method) {
  const compressed = await runModelOnly(t, provider, method, 'compress'), off = await runModelOnly(t, provider, method, 'off'), outage = await runModelOnly(t, provider, method, 'outage');
  assert.equal(compressed.summary.tested_request_sha256, off.summary.tested_request_sha256); assert.equal(off.summary.tested_request_sha256, outage.summary.tested_request_sha256);
  const recoveryFree = { outcome: 'recovery_free', reason: 'The native model-only or structured-output seam has no registered recovery executor.',
    recovery_requests: compressed.summary.recovery_requests, replacements: compressed.summary.replacements, original_sha256: compressed.summary.original_sha256 };
  emitJourney(t, provider, method, { native_application: nativeEvidence(method),
    real_tool_result: { outcome: 'observed', phase: 'native generateText bootstrap', native_executor: 'AI SDK Tool.execute', executions: compressed.context.reads.length, source_sha256: sha(compressed.context.reads[0]) },
    transformed_provider_request: recoveryFree, omitted_fact_requested: recoveryFree, host_executes_exact_recovery: recoveryFree,
    native_result_history_events_and_call_count: compressed.summary, off_baseline: off.summary, optimizer_unavailable: outage.summary });
}

async function runCancellation(t, provider, mode) {
  const context = await setup(t, provider, 'cancel_and_close', mode), { runtime, scope, input, providerFixture: { state } } = context;
  state.gated = true;
  const controller = new AbortController(), before = structuredClone(input.messages);
  const result = streamText(withCaveman({ ...input, abortSignal: controller.signal }, { runtime, scope }));
  const reader = result.fullStream.getReader(), events = [];
  let first;
  do { first = await bounded(reader.read(), 'native cancellation first chunk waited for EOF'); if (!first.done) events.push(first.value); }
  while (!first.done && first.value.type !== 'text-delta');
  assert.equal(first.value?.text, fact.slice(0, 6)); assert.equal(state.released, false);
  const expected = mode === 'compress' ? 3 : 2; assert.equal(state.calls.length, expected);
  const pending = reader.read(); controller.abort();
  let next = await bounded(pending, 'native active cancellation did not release read');
  while (!next.done) { events.push(next.value); next = await bounded(reader.read(), 'native abort stream did not close'); }
  reader.releaseLock();
  await until(() => state.closed && context.nativeStreams.every(stream => !stream.locked) && idle(runtime));
  assert.deepEqual(input.messages, before); assert.deepEqual(context.reads, [source]); assert.deepEqual(state.errors, []);
  assert.ok(events.some(event => event.type === 'abort')); assert.ok(!events.some(event => event.type === 'finish'));
  const steps = await result.steps; assert.equal(steps.length, expected - 1);
  const history = await result.responseMessages; assert.ok(JSON.stringify(history).includes(JSON.stringify(source).slice(1, -1)));
  if (mode !== 'off') {
    const cancelled = context.receipts.filter(receipt => receipt.event_kind === 'cancelled'); assert.equal(cancelled.length, 1); assert.equal(cancelled[0].usage, null);
    assert.equal(context.receipts.filter(receipt => receipt.event_kind !== 'dispatch_intent' && receipt.attempt_id === cancelled[0].attempt_id).length, 1);
    assert.equal(context.receipts.filter(receipt => receipt.event_kind === 'completed').length, expected - 1);
  } else { assert.equal(context.receipts.length, 0); assert.equal(context.runtimeHTTP.length, 0); }
  if (mode !== 'compress') { assert.equal(toolText(state.calls[1].body, provider, 'read-1'), source); assert.equal(context.retrievals.length, 0); }
  const nativeReports = assertReports(context, expected);
  // Native pre-abort must stay undispatched, including optimizer outage.
  const preabort = new AbortController(); preabort.abort();
  await assert.rejects(generateText(withCaveman({ ...input, abortSignal: preabort.signal }, { runtime, scope })));
  assert.equal(state.calls.length, expected);
  return { context, summary: { outcome: 'observed', native_reports: nativeReports, action: 'active AbortSignal followed by native stream close', provider_calls: expected, native_source_executions: context.reads.length,
    first_text: first.value.text, first_chunk_before_eof: true, provider_closed: state.closed, provider_stream_locks: context.nativeStreams.filter(stream => stream.locked).length,
    rpc_counters: counters(runtime), native_abort_events: events.filter(event => event.type === 'abort').length, native_finish_events: events.filter(event => event.type === 'finish').length,
    completed_native_steps: steps.length, history_retains_original: true, recovery_requests: context.retrievals.length,
    cancelled_receipts: context.receipts.filter(receipt => receipt.event_kind === 'cancelled').length, cancelled_usage: null, preabort_extra_provider_calls: 0 } };
}
export async function certifyCancellation(t, provider) {
  const compressed = await runCancellation(t, provider, 'compress'), off = await runCancellation(t, provider, 'off'), outage = await runCancellation(t, provider, 'outage');
  for (const run of [off, outage]) {
    assert.equal(run.summary.first_text, compressed.summary.first_text); assert.equal(run.summary.native_abort_events, compressed.summary.native_abort_events);
    assert.equal(run.summary.provider_closed, compressed.summary.provider_closed); assert.deepEqual(run.summary.rpc_counters, compressed.summary.rpc_counters);
  }
  emitJourney(t, provider, 'cancel_and_close', { native_application: nativeEvidence('cancel_and_close'), ...recoveryEvidence(compressed.context),
    native_result_history_events_and_call_count: compressed.summary, off_baseline: off.summary, optimizer_unavailable: outage.summary });
}
