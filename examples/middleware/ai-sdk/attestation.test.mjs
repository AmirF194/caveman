import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, jsonSchema, stepCountIs, tool, ToolLoopAgent, wrapLanguageModel } from 'ai';
import { createMiddlewareRuntime } from '../../../packages/sdk/typescript/dist/middleware/index.js';
import { createCavemanMiddleware, withCaveman } from '../../../packages/middleware/typescript/dist/ai-sdk.js';
import { startRuntime } from '../../../packages/middleware/conformance/runtime-fixture.mjs';

const original = Array.from({ length: 150 }, (_, i) => `[INFO] row ${i}: café 🌍 exact-value-${String(i).padStart(3, '0')} verbose repeated diagnostic details\r\n`).join('');
const fact = 'exact-value-074';
const scope = name => ({ namespace: 'ai-sdk-attestation', session_id: name, branch_id: 'main', cache_epoch: '0' });
const sourceTool = () => tool({ description: 'Read source logs.', inputSchema: jsonSchema({ type: 'object', properties: {}, additionalProperties: false }), execute: async () => original });
const sourceHistory = () => [
  { role: 'user', content: 'Read the source.' },
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'read-1', toolName: 'read_logs', input: {} }] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'read-1', toolName: 'read_logs', output: { type: 'text', value: original } }] },
];
const nativePrompt = () => {
  const messages = sourceHistory();
  messages[0].content = [{ type: 'text', text: messages[0].content }];
  return messages;
};

async function providerFixture(handler) {
  const calls = [], errors = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      calls.push(body);
      await handler(body, res, calls.length);
    } catch (error) { errors.push(error.message); res.destroy(error); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { calls, errors, url: `http://127.0.0.1:${server.address().port}/v1`, close: async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  } };
}

function reply(res, { name, input = {}, id, text = fact } = {}) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: 'chatcmpl_attestation', object: 'chat.completion', created: 1, model: 'fixture-model',
    choices: [{ index: 0, message: { role: 'assistant', content: name ? null : text,
      ...(name ? { tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] } : {}) },
      finish_reason: name ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020 } }));
}

function instrument(endpoint) {
  const runtime = createMiddlewareRuntime({ endpoint, deadlineMs: 1000 });
  const plans = [], receipts = [], optimize = runtime.optimize.bind(runtime), observe = runtime.observe.bind(runtime);
  runtime.optimize = async options => { const result = await optimize(options); plans.push({ options, result }); return result; };
  runtime.observe = receipt => { receipts.push(receipt); return observe(receipt); };
  return { runtime, plans, receipts };
}

function editNativeTools(bundle, edit) {
  return { ...bundle, model: wrapLanguageModel({ model: bundle.model, middleware: {
    specificationVersion: 'v4', transformParams({ params }) { edit(params.tools); return params; },
  } }) };
}

test('native ToolLoopAgent callbacks attest real recovery and preserve caller hook order', { timeout: 30000 }, async t => {
  const service = await startRuntime(); t.after(service.stop);
  const observed = instrument(service.endpoint); t.after(() => observed.runtime.close()); await observed.runtime.ready();
  let sourceExecutions = 0;
  const provider = await providerFixture((body, res) => {
    const source = body.messages.find(message => message.role === 'tool' && message.tool_call_id === 'read-1');
    if (!source) return reply(res, { name: 'read_logs', id: 'read-1' });
    assert.ok(source.content.includes('cmw_')); assert.ok(!source.content.includes(fact));
    const recovered = body.messages.find(message => message.role === 'tool' && message.tool_call_id === 'recover-1');
    if (!recovered) return reply(res, { name: 'caveman_retrieve', id: 'recover-1', input: { handle: source.content.match(/cmw_[a-f0-9]{48}/)[0] } });
    assert.equal(JSON.parse(recovered.content).text, original);
    reply(res);
  }); t.after(provider.close);
  const calls = [], callIds = new Set();
  const model = createOpenAI({ baseURL: provider.url, apiKey: 'local-fixture' }).chat('fixture-model');
  const read = sourceTool(); read.execute = async () => { sourceExecutions++; return original; };
  let bundle;
  bundle = withCaveman({ model, tools: { read_logs: read }, maxRetries: 0, stopWhen: stepCountIs(5),
    prepareStep: ({ stepNumber }) => { calls.push(`prepare:${stepNumber}`); return {}; },
    experimental_onStepStart: event => { calls.push(`step:${event.stepNumber}`); callIds.add(event.callId); assert.equal(event.tools, bundle.tools); },
    experimental_onLanguageModelCallStart: event => { calls.push('model'); assert.ok(callIds.has(event.callId)); },
    onStepFinish: event => { calls.push(`end:${event.stepNumber}`); assert.ok(callIds.has(event.callId)); },
  }, { runtime: observed.runtime, scope: scope('tool-loop') });
  assert.equal(bundle.tools.read_logs, read, 'application source tool remains the original native object');
  assert.throws(() => { bundle.tools.caveman_retrieve.execute = async () => 'substitute'; }, TypeError);
  assert.throws(() => { bundle.tools.caveman_retrieve.inputSchema.jsonSchema.properties.handle.type = 'number'; }, TypeError);
  const agent = new ToolLoopAgent(bundle);
  const result = await agent.generate({ prompt: 'Read logs and recover row 74.' });
  assert.equal(result.text, fact); assert.equal(result.steps.length, 3); assert.equal(sourceExecutions, 1);
  assert.deepEqual(calls, ['prepare:0', 'step:0', 'model', 'end:0', 'prepare:1', 'step:1', 'model', 'end:1', 'prepare:2', 'step:2', 'model', 'end:2']);
  assert.equal(observed.plans.length, 3); assert.ok(observed.plans.every(plan => plan.options.binding));
  assert.ok(observed.plans.some(plan => plan.result.replacements.length));
  const recovered = result.steps.flatMap(step => step.toolResults).find(part => part.toolName === 'caveman_retrieve');
  assert.equal(recovered.output.text, original); assert.equal(recovered.output.complete, true);
  assert.deepEqual(provider.errors, []);
  t.diagnostic(JSON.stringify({ native_api: 'ToolLoopAgent.generate', provider_calls: provider.calls.length, optimize_calls: observed.plans.length,
    source_executions: sourceExecutions, recovery_exact: true, caller_callbacks_preserved: true }));
});

test('native generation denies substituted executors, schema changes, collisions, duplicate names and missing attestation hooks', { timeout: 30000 }, async t => {
  const service = await startRuntime(); t.after(service.stop);
  const provider = await providerFixture((_, res) => reply(res)); t.after(provider.close);
  const observed = instrument(service.endpoint); t.after(() => observed.runtime.close()); await observed.runtime.ready();
  const model = createOpenAI({ baseURL: provider.url, apiKey: 'local-fixture' }).chat('fixture-model');
  const variants = [
    ['cloned_registry_with_substitute', bundle => ({ ...bundle, tools: { ...bundle.tools, caveman_retrieve: { ...bundle.tools.caveman_retrieve, execute: async () => 'fake' } } })],
    ['cloned_registry_without_executor', bundle => ({ ...bundle, tools: { ...bundle.tools, caveman_retrieve: { ...bundle.tools.caveman_retrieve, execute: undefined } } })],
    ['cloned_registry_with_approval', bundle => ({ ...bundle, tools: { ...bundle.tools, caveman_retrieve: { ...bundle.tools.caveman_retrieve, needsApproval: true } } })],
    ['aliased_recovery', bundle => ({ ...bundle, tools: { ...bundle.tools, recovery_alias: bundle.tools.caveman_retrieve } })],
    ['missing_step_callback', bundle => ({ ...bundle, onStepStart: undefined })],
    ['missing_model_callback', bundle => ({ ...bundle, onLanguageModelCallStart: undefined })],
    ['renamed_native_tool', bundle => editNativeTools(bundle, tools => { tools.find(entry => entry.name === 'caveman_retrieve').name = 'different_recovery'; })],
    ['changed_native_schema', bundle => editNativeTools(bundle, tools => { tools.find(entry => entry.name === 'caveman_retrieve').inputSchema = { type: 'object', properties: {} }; })],
    ['changed_native_description', bundle => editNativeTools(bundle, tools => { tools.find(entry => entry.name === 'caveman_retrieve').description = 'different'; })],
    ['duplicate_recovery_definition', bundle => editNativeTools(bundle, tools => { tools.push({ ...tools.find(entry => entry.name === 'caveman_retrieve') }); })],
    ['duplicate_other_tool_name', bundle => editNativeTools(bundle, tools => { tools.push({ ...tools.find(entry => entry.name === 'read_logs') }); })],
  ];
  for (const [name, alter] of variants) {
    const messages = sourceHistory(), before = structuredClone(messages), start = observed.plans.length;
    const bundle = withCaveman({ model, messages, tools: { read_logs: sourceTool() }, maxRetries: 0 }, { runtime: observed.runtime, scope: scope(name) });
    const result = await generateText(alter(bundle));
    assert.equal(result.text, fact, name); assert.deepEqual(messages, before, name);
    assert.equal(observed.plans.length - start, 1, name);
    const plan = observed.plans.at(-1);
    assert.equal(plan.options.candidates.length, 1, name); assert.equal(plan.options.binding, null, name);
    assert.equal(plan.result.replacements.length, 0, name);
    assert.equal(provider.calls.at(-1).messages.find(message => message.tool_call_id === 'read-1').content, original, name);
  }
  const existing = tool({ inputSchema: jsonSchema({ type: 'object', properties: {} }), execute: async () => 'existing application tool' });
  const collision = withCaveman({ model, tools: { read_logs: sourceTool(), caveman_retrieve: existing }, messages: sourceHistory(), maxRetries: 0 },
    { runtime: observed.runtime, scope: scope('collision') });
  assert.equal(collision.tools.caveman_retrieve, existing);
  await generateText(collision); assert.equal(observed.plans.at(-1).options.binding, null);

  // Extra JavaScript properties cannot turn the public model-only middleware
  // into a private attested bundle, even with a real runtime-owned binding.
  const binding = observed.runtime.recovery(scope('standalone'));
  const fakeRegistry = { caveman_retrieve: tool({ description: binding.description, inputSchema: jsonSchema(binding.inputSchema), execute: binding.execute }) };
  const standalone = wrapLanguageModel({ model, middleware: createCavemanMiddleware({ runtime: observed.runtime, scope: scope('standalone'), binding, registry: fakeRegistry }) });
  await generateText({ model: standalone, tools: fakeRegistry, messages: sourceHistory(), maxRetries: 0 });
  assert.equal(observed.plans.at(-1).options.binding, null); assert.equal(observed.plans.at(-1).result.replacements.length, 0);
  assert.deepEqual(provider.errors, []);
  t.diagnostic(JSON.stringify({ native_api: 'generateText', protected_cases: [...variants.map(([name]) => name), 'existing_name_collision', 'untrusted_standalone_registry'] }));
});

test('native finalized recovery schema mutation during async optimize retains originals and clears receipt plan', { timeout: 30000 }, async t => {
  const service = await startRuntime(); t.after(service.stop);
  const provider = await providerFixture((_, res) => reply(res)); t.after(provider.close);
  const observed = instrument(service.endpoint); t.after(() => observed.runtime.close()); await observed.runtime.ready();
  const optimize = observed.runtime.optimize.bind(observed.runtime);
  let nativeTools, mutated = false;
  observed.runtime.optimize = async options => {
    const result = await optimize(options);
    assert.ok(result.replacements.length, 'the candidate was eligible before mutation');
    nativeTools.find(tool => tool.name === 'caveman_retrieve').inputSchema = { type: 'object', properties: {} };
    mutated = true;
    return result;
  };
  const model = createOpenAI({ baseURL: provider.url, apiKey: 'local-fixture' }).chat('fixture-model');
  const bundle = withCaveman({ model, tools: { read_logs: sourceTool() }, messages: sourceHistory(), maxRetries: 0,
    onLanguageModelCallStart: event => { nativeTools = event.tools; },
  }, { runtime: observed.runtime, scope: scope('mutation-during-optimize') });
  const result = await generateText(bundle);
  assert.equal(result.text, fact); assert.equal(mutated, true);
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0].messages.find(message => message.tool_call_id === 'read-1').content, original);
  assert.ok(observed.receipts.length);
  assert.ok(observed.receipts.every(receipt => receipt.plan_id === null), 'discarded projection must not be claimed as dispatched');
});

test('native model delegate protects unmatched, error, duplicate, provider-executed and unknown result shapes', { timeout: 30000 }, async t => {
  const service = await startRuntime(); t.after(service.stop);
  const provider = await providerFixture((_, res) => reply(res)); t.after(provider.close);
  const observed = instrument(service.endpoint); t.after(() => observed.runtime.close()); await observed.runtime.ready();
  const native = createOpenAI({ baseURL: provider.url, apiKey: 'local-fixture' }).chat('fixture-model');
  const part = prompt => prompt[2].content[0];
  const variants = [
    ['unmatched_id', prompt => { part(prompt).toolCallId = 'missing'; }],
    ['mismatched_name', prompt => { part(prompt).toolName = 'different'; }],
    ['result_before_call', prompt => { [prompt[1], prompt[2]] = [prompt[2], prompt[1]]; }],
    ['duplicate_call_id', prompt => { prompt[1].content.push(structuredClone(prompt[1].content[0])); }],
    ['duplicate_result_id', prompt => { prompt[2].content.push(structuredClone(part(prompt))); }],
    ['provider_executed', prompt => { prompt[1].content[0].providerExecuted = true; }],
    ['unknown_call_contract', prompt => { prompt[1].content[0].futureContract = true; }],
    ['missing_call_input', prompt => { delete prompt[1].content[0].input; }],
    ['error_text', prompt => { part(prompt).output.type = 'error-text'; }],
    ['error_json', prompt => { part(prompt).output = { type: 'error-json', value: { message: original } }; }],
    ['structured_json', prompt => { part(prompt).output = { type: 'json', value: { message: original } }; }],
    ['multimodal', prompt => { part(prompt).output = { type: 'content', value: [{ type: 'text', text: original }] }; }],
    ['explicit_error_flag', prompt => { part(prompt).isError = true; }],
    ['unknown_result_contract', prompt => { part(prompt).futureContract = true; }],
    ['unknown_output_contract', prompt => { part(prompt).output.futureContract = true; }],
    ['citations', prompt => { part(prompt).output.citations = []; }],
  ];
  for (const [name, alter] of variants) {
    const prompt = nativePrompt(); alter(prompt);
    const before = structuredClone(prompt);
    const wrapped = wrapLanguageModel({ model: native, middleware: createCavemanMiddleware({ runtime: observed.runtime, scope: scope(name) }) });
    const baselineStart = provider.calls.length;
    const baseline = await native.doGenerate({ prompt });
    const baselineCalls = provider.calls.slice(baselineStart);
    const wrappedStart = provider.calls.length;
    const result = await wrapped.doGenerate({ prompt });
    assert.deepEqual(result.content, baseline.content, name);
    assert.deepEqual(provider.calls.slice(wrappedStart), baselineCalls, name);
    assert.deepEqual(prompt, before, name);
    assert.equal(observed.plans.at(-1).options.candidates.length, 0, name);
  }
  for (const type of ['text', 'json']) {
    const prompt = nativePrompt(); part(prompt).output.type = type;
    const before = structuredClone(prompt);
    const wrapped = wrapLanguageModel({ model: native, middleware: createCavemanMiddleware({ runtime: observed.runtime, scope: scope(`known-${type}`) }) });
    await wrapped.doGenerate({ prompt });
    assert.deepEqual(prompt, before); assert.equal(observed.plans.at(-1).options.candidates.length, 1);
    assert.equal(observed.plans.at(-1).options.binding, null);
  }
  assert.deepEqual(provider.errors, []);
  t.diagnostic(JSON.stringify({ native_api: 'LanguageModelV4.doGenerate', protected_shapes: variants.map(([name]) => name), known_string_outputs: ['text', 'json'] }));
});

test('native callback correlation isolates concurrent substituted registries and failed caller hooks', { timeout: 20000 }, async t => {
  const service = await startRuntime(); t.after(service.stop);
  const provider = await providerFixture((_, res) => reply(res)); t.after(provider.close);
  const observed = instrument(service.endpoint); t.after(() => observed.runtime.close()); await observed.runtime.ready();
  const model = createOpenAI({ baseURL: provider.url, apiKey: 'local-fixture' }).chat('fixture-model');
  let entered = 0, release;
  const ready = new Promise(resolve => { release = resolve; });
  const callIds = [];
  const bundle = withCaveman({ model, tools: { read_logs: sourceTool() }, messages: sourceHistory(), maxRetries: 0,
    onStepStart: async event => { callIds.push(event.callId); if (++entered === 2) release(); await ready; },
  }, { runtime: observed.runtime, scope: scope('concurrent') });
  const fake = { ...bundle, tools: { ...bundle.tools, caveman_retrieve: { ...bundle.tools.caveman_retrieve, execute: async () => 'fake' } } };
  const results = await Promise.all([generateText(bundle), generateText(fake)]);
  assert.ok(results.every(result => result.text === fact)); assert.equal(new Set(callIds).size, 2);
  assert.equal(observed.plans.length, 2); assert.equal(observed.plans.filter(plan => plan.options.binding).length, 1);
  assert.equal(provider.calls.filter(body => body.messages.some(message => message.role === 'tool' && message.content.includes('cmw_'))).length, 1);
  for (const hook of ['onStepStart', 'onLanguageModelCallStart']) {
    const guarded = withCaveman({ model, tools: { read_logs: sourceTool() }, messages: sourceHistory(), maxRetries: 0,
      [hook]: () => { throw new Error('native callback failure'); },
    }, { runtime: observed.runtime, scope: scope(hook) });
    // AI SDK's notify() swallows callback failures. Preserve its inference
    // behavior while declining recovery when the attestation hook cannot finish.
    const result = await generateText(guarded);
    assert.equal(result.text, fact); assert.equal(observed.plans.at(-1).options.binding, null);
    assert.equal(observed.plans.at(-1).result.replacements.length, 0);
  }
  assert.deepEqual(provider.errors, []);
});

test('AbortSignal cancellation after native stream headers records cancelled without usage', { timeout: 20000 }, async t => {
  const service = await startRuntime(); t.after(service.stop);
  const observed = instrument(service.endpoint); t.after(() => observed.runtime.close()); await observed.runtime.ready();
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const provider = await providerFixture((_, res) => {
    res.on('close', resolveClosed);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ id: 'chatcmpl_abort', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'first' }, finish_reason: null }] })}\n\n`);
  }); t.after(provider.close);
  const controller = new AbortController();
  const native = createOpenAI({ baseURL: provider.url, apiKey: 'local-fixture' }).chat('fixture-model');
  const wrapped = wrapLanguageModel({ model: native, middleware: createCavemanMiddleware({ runtime: observed.runtime, scope: scope('abort-after-headers') }) });
  const result = await wrapped.doStream({ abortSignal: controller.signal, prompt: [{ role: 'user', content: [{ type: 'text', text: 'Stream.' }] }] });
  const reader = result.stream.getReader();
  while ((await reader.read()).value?.type !== 'text-delta') { /* native start events */ }
  const pending = reader.read();
  controller.abort(new Error('application aborted after first content'));
  await assert.rejects(pending);
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('native provider connection stayed open')), 3000))]);
  assert.equal(provider.calls.length, 1);
  const terminal = observed.receipts.filter(receipt => receipt.event_kind !== 'dispatch_intent');
  assert.equal(terminal.length, 1); assert.equal(terminal[0].event_kind, 'cancelled'); assert.equal(terminal[0].usage, null);
  assert.deepEqual(provider.errors, []);
});
