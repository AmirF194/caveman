/** Native MCP clients and application-owned provider loops, with real Engine work. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createMiddlewareRuntime, sha256 } from '../../../packages/sdk/typescript/dist/middleware/index.js';
import { CavemanMCPHost, bindMCPTool } from '../../../packages/middleware/typescript/dist/mcp.js';
import { startRuntime } from '../../../packages/middleware/conformance/runtime-fixture.mjs';
import { nativeClient } from './_client.mjs';
import { providerFixture, SOURCE } from './_provider.mjs';
import { runTextHost } from './example.mjs';
import { beginNativeCertification, emitJourney } from './certification-evidence.mjs';

const cells = JSON.parse(await readFile(new URL('./certification-cells.json', import.meta.url), 'utf8')).cells;
const hash = value => createHash('sha256').update(value).digest('hex');
const sourceHash = hash(SOURCE), fact = 'retained-detail-70';
const scope = () => ({ namespace: `f13-native-${crypto.randomUUID()}`, session_id: 'session', branch_id: 'main', cache_epoch: '0' });
const manifest = async result => [{ id: 'original-result', sha256: await sha256(JSON.stringify(result)) }];
const normalize = text => text.replaceAll(/cmw_[a-f0-9]{48}|ccr_[a-zA-Z0-9_-]+/g, '<OPAQUE_RECOVERY_HANDLE>');
const reportView = report => ({ status: report.status, reason: report.reason, adapter: report.adapter,
  replacement_count: report.replacement_count, reused_count: report.reused_count, transform_ids: [...report.transform_ids],
  logical_call_id_present: report.logical_call_id !== null, attempt_id_present: report.attempt_id !== null });
const resultText = (body, protocol, id) => protocol === 'openai' ? body.messages.find(message => message.tool_call_id === id)?.content
  : body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).find(part => part.type === 'tool_result' && part.tool_use_id === id)?.content;

function trackedHost(runtime, protocolVersion, reports, projections, selected = scope()) {
  const host = new CavemanMCPHost({ runtime, scope: selected, serverId: 'native-fixture', protocolVersion });
  const project = host.projectResult.bind(host);
  host.projectResult = async (original, options) => {
    const before = JSON.stringify(original), count = reports.length;
    const result = await project(original, options);
    assert.equal(JSON.stringify(original), before, 'the native application owns its unchanged result');
    assert.equal(reports.length, count + 1, 'one final callback for each native result projection');
    const report = reports.at(-1); assert.equal(runtime.lastReport, report);
    assert.ok(Object.isFrozen(report)); assert.ok(Object.isFrozen(report.transform_ids));
    assert.equal(report.schema_version, 1); assert.ok(['applied', 'reused', 'skipped', 'recorded', 'disabled'].includes(report.status));
    assert.ok(!JSON.stringify(report).includes(fact));
    const changed = result.content.reduce((count, part, i) => count + (part.type === 'text' && part.text !== original.content[i]?.text ? 1 : 0), 0);
    assert.equal(report.replacement_count, changed, 'callback counts the view actually returned');
    assert.equal(report.transform_ids.length, changed ? new Set(report.transform_ids).size : 0);
    if (changed) { assert.ok(['applied', 'reused'].includes(report.status)); assert.equal(report.adapter, 'mcp'); assert.ok(report.transform_ids.length); }
    else assert.ok(['skipped', 'recorded', 'disabled'].includes(report.status));
    if (runtime.mode === 'off') assert.equal(report.status, 'disabled');
    projections.push({ original, result, report });
    return result;
  };
  return host;
}

async function nativeDetails(context, cell, client, protocolVersion, bindings) {
  const { runtime, service, mode, reports, projections } = context;
  const selected = scope(), host = trackedHost(runtime, protocolVersion, reports, projections, selected);
  const read = bindings.find(binding => binding.tool.name === 'read_logs');
  if (cell.method === 'native_result_identity_and_blocks') {
    const details = {};
    for (const name of ['mixed', 'failure']) {
      const binding = bindings.find(binding => binding.tool.name === name), original = await binding.execute({});
      const view = await host.projectResult(original, { tool: binding.tool, callId: name, contextManifest: await manifest(original), registeredTools: host.register(bindings) });
      assert.deepEqual(view._meta, original._meta); assert.equal(view.isError, original.isError);
      if (name === 'mixed') {
        assert.equal(view.content.length, 6);
        for (let i = 1; i < 6; i++) assert.equal(view.content[i], original.content[i]);
        assert.deepEqual(view.content[0].annotations, original.content[0].annotations);
      } else assert.equal(view, original);
      details[name] = { native_blocks: original.content.map(part => part.type), untouched_block_identities: name === 'mixed' ? 5 : 1,
        is_error: Boolean(view.isError), metadata_retained: true };
    }
    return details;
  }
  if (cell.method === 'cancel_and_options') {
    const waiting = bindings.find(binding => binding.tool.name === 'wait_forever');
    let ready; const started = new Promise(yes => { ready = yes; }), controller = new AbortController();
    const call = waiting.execute({}, { signal: controller.signal, onprogress: ready, timeout: 2000 });
    const rejected = assert.rejects(call); await started; controller.abort(); await rejected;
    const original = await read.execute({}, { timeout: 2000 }); assert.equal(original.content[0].text, SOURCE);
    await host.projectResult(original, { tool: read.tool, callId: 'after-cancel', contextManifest: await manifest(original), registeredTools: host.register(bindings) });
    const reportCount = reports.length;
    await assert.rejects(host.projectResult(original, { tool: read.tool, callId: 'cancelled-projection', contextManifest: [], signal: controller.signal }), { name: 'AbortError' });
    assert.equal(reports.length, reportCount + 1); assert.equal(reports.at(-1).replacement_count, 0);
    assert.equal(reports.at(-1).status, mode === 'off' ? 'disabled' : 'skipped');
    return { native_progress_before_cancel: true, native_rejection: true, subsequent_call_exact_sha256: hash(original.content[0].text), aborted_projection_report: reportView(reports.at(-1)) };
  }
  if (cell.method === 'twenty_turn_restart') {
    const original = await read.execute({}), saved = JSON.stringify(original), history = await manifest(original);
    let current = host, first, view;
    for (let turn = 0; turn < 20; turn++) {
      if ([5, 15].includes(turn)) { await service.restart(); current = trackedHost(runtime, protocolVersion, reports, projections, selected); }
      const restored = CallToolResultSchema.parse(JSON.parse(saved));
      view = await current.projectResult(restored, { tool: read.tool, callId: 'stable-call', contextManifest: history, registeredTools: current.register(bindings) });
      first ??= JSON.stringify(view); assert.equal(JSON.stringify(view), first); assert.equal(JSON.stringify(restored), saved);
      history.push({ id: `turn-${turn}`, sha256: await sha256(`native continuation ${turn}`) });
    }
    const handle = view.content[0].text.match(/cmw_[a-f0-9]{48}/)?.[0];
    if (mode === 'compress') {
      assert.ok(handle); assert.equal(JSON.parse((await current.recovery.execute({ handle })).content[0].text).text, SOURCE);
      await assert.rejects(trackedHost(runtime, protocolVersion, reports, projections).recovery.execute({ handle }));
    } else { assert.equal(handle, undefined); assert.equal(view.content[0].text, SOURCE); }
    return { native_typed_roundtrips: 20, runtime_process_restarts: 2, identical_view_across_restarts: true,
      original_sha256: hash(original.content[0].text), cross_scope_denial: mode === 'compress' };
  }
  if (cell.method === 'host_recovery_registration' && mode === 'compress') {
    const original = await read.execute({}), registered = host.register(bindings), optimize = runtime.optimize.bind(runtime);
    assert.equal(registered.at(-1), host.recovery);
    runtime.optimize = async (...args) => { const outcome = await optimize(...args); assert.ok(outcome.replacements.length); registered.pop(); return outcome; };
    try {
      const view = await host.projectResult(original, { tool: read.tool, callId: 'registry-race', contextManifest: await manifest(original), registeredTools: registered });
      assert.equal(view, original); assert.equal(reports.at(-1).reason, 'recovery_unavailable');
      assert.equal(reports.at(-1).replacement_count, 0); assert.equal(reports.at(-1).status, 'skipped');
      return { actual_executor_registered: true, registry_changed_after_real_optimization: true, original_restored: true, final_report: reportView(reports.at(-1)) };
    } finally { runtime.optimize = optimize; }
  }
  return {};
}

async function run(t, cell, protocol, mode) {
  const service = await startRuntime();
  const reports = [], projections = [], plans = [], runtimeRequests = [], nativeExecutions = [];
  const runtime = createMiddlewareRuntime({ endpoint: mode === 'outage' ? 'http://127.0.0.1:1' : service.endpoint,
    mode: ['off', 'record'].includes(mode) ? mode : 'compress', onReport: report => { reports.push(report); },
    fetch: async (input, init) => { runtimeRequests.push(new URL(input).pathname); return fetch(input, init); } });
  const optimize = runtime.optimize.bind(runtime);
  runtime.optimize = async (...args) => { const result = await optimize(...args); plans.push(result); return result; };
  const engine = cell.method === 'existing_server_interoperation', structured = cell.structured_output;
  const toolName = engine ? 'caveman_compress' : cell.method === 'structuredContent_and_outputSchema' ? 'structured'
    : cell.method === 'mixed_structured_text_protection' ? 'mixed_structured' : 'read_logs';
  const expectedText = toolName === 'structured' ? text => assert.deepEqual(JSON.parse(text), { source: SOURCE })
    : toolName === 'mixed_structured' ? SOURCE + 'protected explanation' : SOURCE;
  const provider = await providerFixture(protocol, { toolName, expectedText, nativeEngine: engine,
    toolArguments: engine ? { input: SOURCE } : toolName === 'read_logs' ? { path: 'fixture/diagnostics.log' } : {} });
  const client = protocol === 'openai' ? new OpenAI({ apiKey: 'fixture', baseURL: provider.url + '/v1', maxRetries: 0 })
    : new Anthropic({ apiKey: 'fixture', baseURL: provider.url, maxRetries: 0 });
  const context = { service, runtime, reports, projections, plans, mode };
  try {
    if (mode === 'compress') await beginNativeCertification(t, await runtime.ready());
    const transport = cell.method.startsWith('streamable_http') ? 'http' : 'stdio';
    let journey, details, negotiated;
    const captured = await nativeClient(transport, async (mcp, protocolVersion) => {
      negotiated = protocolVersion; assert.equal(protocolVersion, cell.protocol.slice(4));
      const bindings = (await mcp.listTools()).tools.map(tool => {
        const binding = bindMCPTool(mcp, tool), execute = binding.execute;
        binding.execute = async (...args) => { const result = await execute(...args); nativeExecutions.push({ name: tool.name, result }); return result; };
        return binding;
      });
      const host = trackedHost(runtime, protocolVersion, reports, projections);
      if (engine) { assert.deepEqual(host.register(bindings), bindings); assert.equal(bindings.filter(binding => binding.tool.name === 'caveman_retrieve').length, 1); }
      const chunks = [];
      journey = await runTextHost({ client, model: 'fixture-model', protocol, host, tools: bindings, prompt: 'Find retained-detail-70', stream: cell.streaming,
        onText: text => { if (!chunks.length) { assert.equal(provider.state.finished, false); provider.state.release(); } chunks.push(text); } });
      assert.equal(journey.final, fact); if (cell.streaming) assert.equal(chunks.join(''), fact);
      assert.equal(journey.originals[0].result, nativeExecutions[0].result);
      if (structured) {
        const original = journey.originals[0].result;
        assert.ok('structuredContent' in original);
        if (toolName === 'structured') assert.ok(bindings.find(binding => binding.tool.name === toolName).tool.outputSchema);
        else assert.deepEqual(original.structuredContent, { answer: fact });
        assert.ok(projections.every(projection => projection.result === projection.original));
      }
      details = engine || structured ? {} : await nativeDetails(context, cell, mcp, protocolVersion, bindings);
    }, { engine });
    const active = engine || mode === 'compress' && !structured;
    assert.equal(provider.state.calls.length, active ? 3 : 2);
    assert.equal(journey.originals.length, active ? 2 : 1);
    assert.equal(nativeExecutions.filter(call => call.name === toolName).length >= 1, true);
    assert.deepEqual(provider.state.errors, []);
    assert.deepEqual(provider.state.calls[0].body.tools, provider.state.calls.at(-1).body.tools);
    assert.ok(provider.state.calls.every(call => call.headers['x-native-option'] === 'preserved'));
    const wireSource = resultText(provider.state.calls[1].body, protocol, 'read-1');
    let recoveredHash = null, shortened = null;
    if (active) {
      const request = provider.state.responses[1]; assert.equal(request.name, 'caveman_retrieve');
      const result = journey.originals[1].result;
      const original = engine ? result.content[0].text : JSON.parse(result.content[0].text).text;
      assert.equal(original, SOURCE); recoveredHash = hash(original);
      shortened = engine ? JSON.parse(wireSource).compressed : wireSource;
      assert.ok(!shortened.includes(fact)); assert.ok(Buffer.byteLength(shortened) < Buffer.byteLength(SOURCE));
      if (engine) assert.equal(JSON.parse(wireSource).recovery_handle, request.args.recovery_handle);
      else assert.equal(wireSource.match(/cmw_[a-f0-9]{48}/)[0], request.args.handle);
    } else if (typeof expectedText === 'function') expectedText(wireSource); else assert.equal(wireSource, expectedText);
    if (!engine && !structured) assert.equal(journey.originals[0].result.content[0].text, SOURCE);
    if (mode === 'off') { assert.equal(runtimeRequests.length, 0); assert.equal(plans.length, 0); }
    if (engine || structured) assert.equal(plans.length, 0);
    if (mode === 'outage' && !engine && !structured) assert.ok(runtimeRequests.some(path => path.endsWith('/capabilities')));
    if (transport === 'http') {
      const calls = captured.rows.filter(row => row.body?.method === 'tools/call');
      assert.equal(calls.length, nativeExecutions.length);
      assert.ok(calls.every(call => call.headers['x-native-mcp'] === 'preserved' && call.headers['mcp-protocol-version'] === negotiated));
      assert.equal(new Set(calls.map(call => call.body.id)).size, calls.length);
    }
    return { protocol, transport, mode, final: journey.final, provider_calls: provider.state.calls.length, native_source_tool: toolName,
      native_tool_calls: nativeExecutions.map(call => call.name), negotiated_protocol: negotiated,
      recovery_owner: engine ? 'existing_native_caveman_mcp_server' : active ? 'registered_host_local_executor' : 'none',
      middleware_projection_calls: reports.length, successful_projections: projections.length, callback_reports: reports.map(reportView),
      source_result_identity_preserved: true, native_history_sha256: hash(normalize(JSON.stringify(journey.messages))), source_sha256: sourceHash,
      transformed_request_sha256: hash(normalize(provider.state.calls[1].wire)), provider_tool_result_sha256: hash(normalize(wireSource)),
      shortened_sha256: shortened ? hash(normalize(shortened)) : null,
      omitted_fact_absent: active, recovery_requests: active ? 1 : 0, exact_recovered_sha256: recoveredHash,
      native_options_and_schemas_preserved: true, native_stream_before_eof: cell.streaming, runtime_requests: runtimeRequests,
      protected_result_identity: structured || engine, native_details: details };
  } finally { runtime.close(); await provider.close(); await service.stop(); }
}

export async function certifyCell(t, method) {
  const cell = cells.find(cell => cell.language === 'typescript' && cell.method === method); assert.ok(cell);
  const providers = ['stdio.call_tool', 'streamable_http.call_tool', 'stdio.host_stream', 'streamable_http.host_stream'].includes(method) ? ['openai', 'anthropic'] : ['openai'];
  const rows = [];
  for (const protocol of providers) {
    const controls = {};
    for (const mode of ['compress', 'off', 'outage']) controls[mode] = await run(t, cell, protocol, mode);
    for (const baseline of [controls.off, controls.outage]) {
      assert.equal(baseline.final, controls.compress.final); assert.equal(baseline.source_sha256, controls.compress.source_sha256);
      assert.equal(baseline.source_result_identity_preserved, true);
      if (cell.structured_output || method === 'existing_server_interoperation') assert.equal(baseline.provider_tool_result_sha256, controls.compress.provider_tool_result_sha256);
    }
    rows.push(controls);
  }
  if (method === 'host_recovery_registration') {
    const recorded = await run(t, cell, 'openai', 'record');
    assert.ok(recorded.callback_reports.some(report => report.status === 'recorded'));
    rows[0].compress.record_mode = recorded;
  }
  const active = rows.map(row => row.compress), observed = values => ({ outcome: 'observed', native_runs: values });
  const free = cell.recovery === 'model_only' ? { outcome: 'recovery_free', reason: 'native MCP structuredContent/outputSchema contract',
    native_result_identity_preserved: true, recovery_requests: 0, replacements: 0, original_source_sha256: sourceHash } : null;
  emitJourney(t, cell, {
    native_application: observed(active.map(row => ({ method, protocol: row.protocol, transport: row.transport, negotiated_protocol: row.negotiated_protocol,
      native_entry_point: 'installed MCP Client.callTool and application-owned native provider loop', recovery_owner: row.recovery_owner }))),
    real_tool_result: observed(active.map(row => ({ source_tool: row.native_source_tool, native_tool_calls: row.native_tool_calls, source_sha256: row.source_sha256, source_result_identity_preserved: true }))),
    transformed_provider_request: free ?? observed(active.map(row => ({ transformed_request_sha256: row.transformed_request_sha256, shortened_sha256: row.shortened_sha256,
      omitted_fact_absent: row.omitted_fact_absent, recovery_owner: row.recovery_owner }))),
    omitted_fact_requested: free ?? observed(active.map(row => ({ native_provider_recovery_requests: row.recovery_requests, exact_view_handle_requested: true, recovery_owner: row.recovery_owner }))),
    host_executes_exact_recovery: free ?? observed(active.map(row => ({ exact_recovered_sha256: row.exact_recovered_sha256, source_sha256: row.source_sha256, recovery_owner: row.recovery_owner }))),
    native_result_history_events_and_call_count: observed(active), off_baseline: observed(rows.map(row => row.off)), optimizer_unavailable: observed(rows.map(row => row.outage)),
  });
}
