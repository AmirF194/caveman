/** Frozen operation journeys on official SDK clients and the real loopback runtime. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { withCavemanOpenAI, withCavemanOpenAITools } from '../../../packages/middleware/typescript/dist/openai.js';
import { withCavemanAnthropic } from '../../../packages/middleware/typescript/dist/anthropic.js';
import { SOURCE, FACT, api, args, definitions, instrument, providerFixture, scope, textOf, waitFor } from './native-fixture.mjs';
import { beginNativeCertification, emitJourney } from './certification-evidence.mjs';

const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const sourceHash = digest(SOURCE);
const protocolOf = cell => cell.protocol === 'openai-chat-completions' ? 'openai-chat' : cell.protocol;
const eventName = event => event.type ?? event.object ?? event.constructor.name;
const collect = async stream => { const output = []; for await (const event of stream) output.push(event); return output; };
const resultText = (value, protocol) => protocol === 'openai-responses' ? value.output_text ?? value.output[0].content[0].text : textOf(value, protocol);
const results = (body, protocol) => Object.fromEntries(protocol === 'openai-chat' ? (body.messages ?? []).filter(item => item.role === 'tool').map(item => [item.tool_call_id, item.content]) :
  protocol === 'openai-responses' ? (body.input ?? []).filter(item => item.type === 'function_call_output').map(item => [item.call_id, item.output]) :
  (body.messages ?? []).flatMap(item => Array.isArray(item.content) ? item.content : []).filter(item => item.type === 'tool_result').map(item => [item.tool_use_id, item.content]));
function nativeClient(provider, protocol) {
  return protocol.startsWith('openai') ? new OpenAI({ apiKey: 'local-fixture', baseURL: provider.url + '/v1', maxRetries: 0, timeout: 3000 }) :
    new Anthropic({ apiKey: 'local-fixture', baseURL: provider.url, maxRetries: 0, timeout: 3000 });
}
const wrap = (client, protocol, options) => protocol.startsWith('openai') ? withCavemanOpenAI(client, options) : withCavemanAnthropic(client, options);
function reportEvidence(observed, count, mode) {
  assert.equal(observed.reports.length, count, 'exactly one report per wrapped physical provider attempt');
  assert.equal(observed.runtime.lastReport, observed.reports.at(-1));
  for (const report of observed.reports) {
    assert.ok(Object.isFrozen(report) && Object.isFrozen(report.transform_ids));
    const replacements = observed.plans.find(plan => plan.result.request?.logical_call_id === report.logical_call_id && plan.result.request?.attempt_id === report.attempt_id)?.result.replacements ?? [];
    assert.equal(report.status, mode === 'off' ? 'disabled' : replacements.length ? replacements.every(item => item.reused) ? 'reused' : 'applied' : 'skipped');
    assert.equal(report.replacement_count, replacements.length);
    assert.deepEqual(report.transform_ids, [...new Set(replacements.map(item => item.transform_id))].sort());
    assert.ok(!JSON.stringify(report).includes(SOURCE));
  }
  if (mode === 'off') { assert.equal(observed.plans.length, 0); assert.equal(observed.receipts.length, 0); }
  return { count, statuses: observed.reports.map(report => report.status), replacement_counts: observed.reports.map(report => report.replacement_count), metadata_only: true };
}
function appendResponse(messages, reply, protocol) {
  if (protocol === 'openai-chat') {
    messages.push(reply.choices[0].message);
    return (reply.choices[0].message.tool_calls ?? []).map(call => ({ id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) }));
  }
  if (protocol === 'openai-responses') {
    messages.push(...reply.output);
    return reply.output.filter(item => item.type === 'function_call').map(call => ({ id: call.call_id, name: call.name, input: JSON.parse(call.arguments) }));
  }
  messages.push({ role: 'assistant', content: reply.content });
  return reply.content.filter(item => item.type === 'tool_use').map(call => ({ id: call.id, name: call.name, input: call.input }));
}
function appendResult(messages, protocol, id, value) {
  const content = typeof value === 'string' ? value : JSON.stringify(value);
  messages.push(protocol === 'openai-chat' ? { role: 'tool', tool_call_id: id, content } :
    protocol === 'openai-responses' ? { type: 'function_call_output', call_id: id, output: content } :
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] });
}
async function sourceHistory(original, protocol, executions) {
  const messages = [{ role: 'user', content: 'Read source and recover row 70' }];
  const reply = await api(original, protocol).create({ ...args(protocol, 'loop', messages), tools: definitions(protocol) });
  const calls = appendResponse(messages, reply, protocol);
  assert.deepEqual(calls, [{ id: 'read-1', name: 'read_logs', input: {} }]);
  const readLogs = async input => { executions.push(input); return SOURCE; };
  appendResult(messages, protocol, calls[0].id, await readLogs(calls[0].input));
  return { messages, responseId: reply.id };
}

async function targetMethod(cell, client, provider, messages, responseId) {
  const protocol = protocolOf(cell), resource = api(client, protocol), params = args(protocol, 'helpers', messages);
  let native, value, events = [];
  if (['create', 'messages.create'].includes(cell.method)) {
    native = await resource.create(params); value = resultText(native, protocol);
  } else if (['create.stream', 'messages.create.stream'].includes(cell.method)) {
    native = await resource.create({ ...params, stream: true });
    const chunks = await collect(native); events = chunks.map(eventName); assert.ok(events.length > 2);
    value = chunks.map(event => protocol === 'openai-chat' ? event.choices[0]?.delta.content ?? '' :
      protocol === 'openai-responses' ? event.type === 'response.output_text.delta' ? event.delta : '' :
      event.type === 'content_block_delta' && event.delta.type === 'text_delta' ? event.delta.text : '').join('');
  } else if (cell.method === 'asResponse') {
    native = await resource.create(params).asResponse(); assert.equal(native.status, 200); assert.equal(native.bodyUsed, false);
    value = resultText(await native.json(), protocol);
  } else if (['withResponse', 'messages.raw_response'].includes(cell.method)) {
    const result = await resource.create(params).withResponse(); assert.equal(result.response.status, 200);
    native = result.data; value = resultText(native, protocol); assert.ok(result.request_id);
  } else if (cell.method === 'parse') {
    const schema = { type: 'object', properties: { answer: { type: 'integer' } }, required: ['answer'], additionalProperties: false };
    native = await resource.parse({ ...params, model: 'parse', ...(protocol === 'openai-chat' ?
      { response_format: { type: 'json_schema', json_schema: { name: 'answer', schema, strict: true } } } :
      { text: { format: { type: 'json_schema', name: 'answer', schema, strict: true } } }) });
    value = protocol === 'openai-chat' ? native.choices[0].message.parsed : native.output_parsed;
    assert.deepEqual(value, { answer: 42 });
  } else if (cell.method === 'messages.stream') {
    native = resource.stream(params); events = (await collect(native)).map(eventName);
    value = resultText(await native.finalMessage(), protocol); assert.ok(events.length > 2);
  } else if (cell.method === 'cancel') {
    native = await resource.create({ ...params, stream: true });
    const iterator = native[Symbol.asyncIterator](), first = await iterator.next();
    assert.equal(first.done, false); events.push(eventName(first.value)); native.controller.abort();
    assert.equal(provider.released, false); const closure = provider.closures.at(-1).promise;
    assert.equal(await waitFor(closure), true); assert.equal((await closure).beforeRelease, true);
    value = 'cancelled_before_fixture_eof';
  } else if (cell.method === 'server_history_reference') {
    for (const reference of [{ previous_response_id: responseId }, { conversation: 'conv-fixture' }, { conversation: { id: 'conv-fixture' } }]) {
      native = await resource.create({ model: 'helpers', input: [messages.at(-1)], ...reference });
      assert.equal(resultText(native, protocol), 'native'); assert.deepEqual(provider.calls.at(-1).body.input, [messages.at(-1)]);
      for (const [key, entry] of Object.entries(reference)) assert.deepEqual(provider.calls.at(-1).body[key], entry);
    }
    value = 'native';
  } else if (cell.method === 'unrelated_endpoint_passthrough') {
    native = await client.embeddings.create({ model: 'fixture-embedding', input: SOURCE, encoding_format: 'float' });
    value = native.data[0].embedding; assert.deepEqual(value, [1, 2]);
  } else if (cell.method === 'countTokens.passthrough') {
    native = await client.messages.countTokens({ model: 'helpers', messages });
    value = { input_tokens: native.input_tokens }; assert.deepEqual(value, { input_tokens: 7 });
  } else throw new Error(`No native method for ${cell.id}`);
  if (!['parse', 'cancel', 'unrelated_endpoint_passthrough', 'countTokens.passthrough'].includes(cell.method)) assert.equal(value, 'native');
  return { native_type: native.constructor.name, value, events };
}

async function modelCase(cell, endpoint, mode) {
  const protocol = protocolOf(cell), provider = await providerFixture(protocol, { pause: cell.method === 'cancel' ? 'first' : undefined });
  const observed = instrument(endpoint, mode, 3000);
  try {
    if (mode === 'compress') await observed.runtime.ready();
    const original = nativeClient(provider, protocol), client = wrap(original, protocol, { runtime: observed.runtime, scope: scope(digest(cell.id + mode)), fetch });
    const executions = [], { messages, responseId } = await sourceHistory(original, protocol, executions), before = structuredClone(messages);
    const output = await targetMethod(cell, client, provider, messages, responseId);
    assert.deepEqual(messages, before); assert.deepEqual(executions, [{}]); assert.deepEqual(provider.errors, []);
    assert.ok(observed.plans.every(plan => plan.result.replacements.length === 0 && plan.options.binding === null));
    assert.ok(JSON.stringify(provider.calls.at(-1).body).includes(JSON.stringify(SOURCE).slice(1, -1)));
    const noOptimizer = ['server_history_reference', 'unrelated_endpoint_passthrough', 'countTokens.passthrough'].includes(cell.method) || mode === 'off';
    assert.equal(observed.plans.length, noOptimizer ? 0 : 1);
    if (mode === 'outage' && observed.plans.length) assert.equal(observed.plans.at(-1).result.reason, 'runtime_unavailable');
    return { output, reports: reportEvidence(observed, provider.calls.length - 1, mode), source_executions: executions.length, provider_calls: provider.calls.length, optimizer_requests: observed.plans.length,
      recovery_requests: 0, replacements: 0, request_sha256: digest(provider.calls.at(-1).raw),
      response_sha256: cell.recovery === 'not_applicable' ? digest(provider.responses.at(-1).raw) : null,
      history_sha256: digest(before), original_provider_text: true, native_socket_closed_before_eof: cell.method === 'cancel' };
  } finally { observed.runtime.close(); await provider.close(); }
}

async function loopCase(cell, endpoint, mode) {
  const protocol = protocolOf(cell), provider = await providerFixture(protocol), observed = instrument(endpoint, mode, 3000);
  try {
    if (mode === 'compress') await observed.runtime.ready();
    const original = nativeClient(provider, protocol), options = { runtime: observed.runtime, scope: scope(digest(cell.id + mode)), fetch };
    const sourceCalls = [], eventTypes = [], messages = [{ role: 'user', content: 'Read source and recover row 70' }], before = structuredClone(messages);
    const readLogs = async input => { sourceCalls.push(input); return SOURCE; };
    let native, final, stored, executionOwner;
    if (protocol === 'openai-chat') {
      const client = withCavemanOpenAI(original, options);
      const runner = client.chat.completions.runTools({ model: 'loop', messages, stream: cell.streaming,
        tools: [{ type: 'function', function: { ...definitions(protocol)[0].function, parse: JSON.parse, function: readLogs } }] }, { maxChatCompletions: 5 });
      for (const event of ['message', 'functionCall', 'functionCallResult', 'finalContent']) runner.on(event, () => eventTypes.push(event));
      final = await runner.finalContent(); native = await runner.finalChatCompletion();
      stored = results({ messages: runner.messages }, protocol); executionOwner = 'native_tool_runner'; assert.deepEqual(messages, before);
    } else if (protocol === 'openai-responses') {
      assert.equal(typeof original.responses.runTools, 'undefined');
      const bundle = withCavemanOpenAITools(original, { ...options, protocol, tools: definitions(protocol), functions: { read_logs: readLogs } });
      for (let step = 0; step < 5; step++) {
        const params = { ...args(protocol, 'loop', messages), tools: bundle.tools };
        if (cell.streaming) {
          const stream = bundle.client.responses.stream(params); eventTypes.push((await collect(stream)).map(eventName)); native = await stream.finalResponse();
        } else native = await bundle.client.responses.create(params);
        const calls = appendResponse(messages, native, protocol);
        if (!calls.length) break;
        for (const call of calls) appendResult(messages, protocol, call.id, await bundle.functions[call.name](call.input));
      }
      final = resultText(native, protocol); stored = results({ input: messages }, protocol); executionOwner = 'application';
    } else {
      const client = withCavemanAnthropic(original, options), runner = client.beta.messages.toolRunner({ model: 'loop', max_tokens: 100, max_iterations: 5,
        messages, stream: cell.streaming, tools: [{ ...definitions(protocol)[0], parse: input => input, run: readLogs }] });
      if (cell.streaming) {
        for await (const stream of runner) { eventTypes.push((await collect(stream)).map(eventName)); native = await stream.finalMessage(); }
        assert.equal(resultText(await runner.done(), protocol), FACT);
      } else native = await runner;
      final = resultText(native, protocol); stored = results(runner.params, protocol); executionOwner = 'native_tool_runner'; assert.deepEqual(messages, before);
    }
    assert.equal(final, FACT); assert.deepEqual(sourceCalls, [{}]); assert.equal(stored['read-1'], SOURCE); assert.deepEqual(provider.errors, []);
    assert.equal(provider.calls.length, mode === 'compress' ? 3 : 2);
    const projected = results(provider.calls[1].body, protocol)['read-1'], recovered = results(provider.calls.at(-1).body, protocol)['recover-1'];
    assert.equal(projected !== SOURCE, mode === 'compress');
    if (mode === 'compress') {
      assert.ok(!projected.includes(FACT) && projected.includes('cmw_')); assert.equal(JSON.parse(recovered).text, SOURCE);
      assert.ok(observed.plans.some(plan => plan.result.replacements.length));
    } else {
      assert.equal(recovered, undefined); assert.ok(observed.plans.every(plan => plan.result.replacements.length === 0));
      assert.equal(observed.plans.length, mode === 'off' ? 0 : 2);
      if (mode === 'outage') assert.ok(observed.plans.some(plan => plan.result.reason === 'runtime_unavailable'));
    }
    return { reports: reportEvidence(observed, provider.calls.length, mode), execution_owner: executionOwner, upstream_scheduler_available: protocol !== 'openai-responses', native_type: native.constructor.name, value: final,
      events: eventTypes, source_executions: sourceCalls.length, provider_calls: provider.calls.length, optimizer_requests: observed.plans.length,
      recovery_requests: Number(recovered !== undefined), recovered_sha256: recovered === undefined ? null : digest(JSON.parse(recovered).text),
      stored_source_sha256: digest(stored['read-1']), transformed_provider_requests: provider.calls.filter(call => results(call.body, protocol)['read-1'] !== undefined && results(call.body, protocol)['read-1'] !== SOURCE).length };
  } finally { observed.runtime.close(); await provider.close(); }
}

export async function certifyCells(t, family, endpoint) {
  const response = await fetch(`${endpoint}/caveman/v1/middleware/capabilities`); assert.equal(response.status, 200);
  await beginNativeCertification(t, family, await response.json());
  const fixture = JSON.parse(await readFile(new URL('./certification-cells.json', import.meta.url), 'utf8'));
  if (process.env.CAVEMAN_MIDDLEWARE_PACKAGED_TEST !== '1') {
    const { requiredCells } = await import('../../../packages/middleware/conformance/support/catalog.mjs');
    assert.deepEqual(fixture.cells, requiredCells().filter(cell => ['F01', 'F02'].includes(cell.family) && cell.language === 'typescript'));
  }
  const cells = fixture.cells.filter(cell => cell.family === family);
  assert.equal(cells.length, family === 'F01' ? 19 : 8);
  for (const cell of cells) {
    const rows = {};
    for (const mode of ['compress', 'off', 'outage']) rows[mode] = await (cell.recovery === 'native_executor' ? loopCase(cell, endpoint, mode) : modelCase(cell, endpoint, mode));
    const { compress: current, off, outage: unavailable } = rows;
    let journey;
    if (cell.recovery === 'native_executor') {
      assert.equal(current.value, off.value); assert.equal(current.value, unavailable.value);
      journey = {
        native_application: { outcome: 'observed', execution_owner: current.execution_owner, upstream_scheduler_available: current.upstream_scheduler_available, method: cell.method, execution: cell.execution },
        real_tool_result: { outcome: 'observed', executor: 'read_logs', executions: current.source_executions, utf8_bytes: Buffer.byteLength(SOURCE), sha256: sourceHash },
        transformed_provider_request: { outcome: 'observed', provider_requests_with_projection: current.transformed_provider_requests, omitted_fact_absent: true, stored_source_sha256: current.stored_source_sha256 },
        omitted_fact_requested: { outcome: 'observed', requested_fact: FACT, native_recovery_function: 'caveman_retrieve', recovery_requests: current.recovery_requests },
        host_executes_exact_recovery: { outcome: 'observed', execution_owner: current.execution_owner, recovered_sha256: current.recovered_sha256, source_sha256: sourceHash },
        native_result_history_events_and_call_count: { outcome: 'observed', native_reports: current.reports, native_type: current.native_type, final_value: current.value, event_order: current.events, provider_calls: current.provider_calls, stored_source_sha256: current.stored_source_sha256 },
        off_baseline: { outcome: 'observed', native_reports: off.reports, final_value: off.value, provider_calls: off.provider_calls, optimizer_requests: off.optimizer_requests, recovery_requests: off.recovery_requests, stored_source_sha256: off.stored_source_sha256 },
        optimizer_unavailable: { outcome: 'observed', native_reports: unavailable.reports, final_value: unavailable.value, provider_calls: unavailable.provider_calls, optimizer_requests: unavailable.optimizer_requests, recovery_requests: unavailable.recovery_requests, stored_source_sha256: unavailable.stored_source_sha256 },
      };
    } else {
      assert.deepEqual(current.output, off.output); assert.deepEqual(current.output, unavailable.output);
      for (const baseline of [off, unavailable]) { assert.equal(current.request_sha256, baseline.request_sha256); assert.equal(current.provider_calls, baseline.provider_calls); }
      const passthrough = cell.recovery === 'not_applicable';
      const noRecovery = { outcome: 'recovery_free', reason: passthrough ? 'non-generation endpoint preserves the native exchange' : 'native model-only operation has no registered recovery executor', recovery_requests: 0, replacements: 0,
        ...(passthrough ? { applicability: 'endpoint_passthrough', optimizer_requests: 0, request_sha256: current.request_sha256, response_sha256: current.response_sha256, provider_calls: current.provider_calls } : { original_provider_text: current.original_provider_text, source_sha256: sourceHash }) };
      if (passthrough) for (const baseline of [off, unavailable]) assert.equal(current.response_sha256, baseline.response_sha256);
      const baseline = value => ({ outcome: 'observed', native_reports: value.reports, native_output: value.output, ...(passthrough ? { applicability: 'endpoint_passthrough' } : {}),
        ...Object.fromEntries(['request_sha256', 'response_sha256', 'provider_calls', 'optimizer_requests', 'recovery_requests', 'replacements'].map(key => [key, value[key]])) });
      journey = {
        native_application: { outcome: 'observed', method: cell.method, execution: cell.execution, official_sdk_client: true },
        real_tool_result: passthrough ? noRecovery : { outcome: 'observed', executor: 'read_logs', execution_owner: 'application', executions: current.source_executions, sha256: sourceHash, utf8_bytes: Buffer.byteLength(SOURCE) },
        transformed_provider_request: noRecovery, omitted_fact_requested: noRecovery, host_executes_exact_recovery: noRecovery,
        native_result_history_events_and_call_count: { outcome: 'observed', native_reports: current.reports, ...current.output, provider_calls: current.provider_calls, original_history_sha256: current.history_sha256, native_socket_closed_before_eof: current.native_socket_closed_before_eof },
        off_baseline: baseline(off), optimizer_unavailable: baseline(unavailable),
      };
    }
    emitJourney(t, cell, journey);
  }
}
