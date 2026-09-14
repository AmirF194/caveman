/** Exact installed Strands operations, native executors, and callback report assertions. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Agent, FunctionTool, Message, BeforeModelCallEvent, AfterInvocationEvent } from '@strands-agents/sdk';
import { z } from 'zod';
import { createMiddlewareRuntime } from '../../../packages/sdk/typescript/dist/middleware/index.js';
import { withCavemanStrands, withCavemanStrandsModel } from '../../../packages/middleware/typescript/dist/strands.js';
import { startRuntime } from '../../../packages/middleware/conformance/runtime-fixture.mjs';
import { providerFixture, nativeResults, nativeTools, sources, FACT, handlePattern } from './certification-provider.mjs';
import { beginNativeCertification, emitJourney } from './certification-evidence.mjs';
import { nativeParallelGap, nativeCancellationBaseline, cancellationBeforeDispatch } from './upstream-native.mjs';
const cells = JSON.parse(await readFile(new URL('./certification-cells.json', import.meta.url), 'utf8')).cells;
const hash = value => createHash('sha256').update(value).digest('hex');
const normalized = value => JSON.stringify(value).replaceAll(handlePattern, '<OPAQUE_RECOVERY_HANDLE>').replaceAll(/"trackingId":"[^"]+"/g, '"trackingId":"<NATIVE_ID>"');
const reportView = r => ({ status: r.status, reason: r.reason, adapter: r.adapter, replacement_count: r.replacement_count, reused_count: r.reused_count,
  transform_ids: [...r.transform_ids], logical_call_id_present: r.logical_call_id !== null, attempt_id_present: r.attempt_id !== null });
const originals = agent => agent.messages.flatMap(m => m.content).filter(p => p.type === 'toolResultBlock' && p.toolUseId.startsWith('read-'));
const messagesText = result => result.lastMessage.content.filter(p => p.type === 'textBlock').map(p => p.text).join('');

async function run(t, service, cell, mode, lifecycleAction = 'abort') {
  const parallel = cell.method === 'parallel_tool_batch', streamed = ['agent.stream', 'cancel_and_close'].includes(cell.method);
  const fixture = await providerFixture(cell.provider, { parallel, gateText: streamed });
  const reports = [], requests = [], plans = [], diagnostics = [], hooks = [], executions = [], phase = { typed: false };
  const runtime = createMiddlewareRuntime({ endpoint: mode === 'outage' ? 'http://127.0.0.1:1' : service.endpoint, mode: mode === 'off' ? 'off' : 'compress',
    onReport(report) { assert.ok(Object.isFrozen(report)); assert.ok(Object.isFrozen(report.transform_ids)); assert.equal(report.schema_version, 1); assert.ok(!JSON.stringify(report).includes(FACT)); reports.push(report); },
    onDiagnostic(event) { diagnostics.push(event); },
    fetch: async (url, init) => { if (url.endsWith('/optimize')) requests.push(JSON.parse(init.body)); const response = await fetch(url, init); if (url.endsWith('/optimize')) plans.push(await response.clone().json()); return response; } });
  const selectedScope = { namespace: `f09-native-${crypto.randomUUID()}`, session_id: 'session', branch_id: 'main', cache_epoch: '0' };
  let parallelResolve; const barrier = new Promise(resolve => parallelResolve = resolve);
  const tools = ['read_logs', ...(parallel ? ['read_aux'] : [])].map(name => new FunctionTool({ name, description: `Read original ${name}`,
    inputSchema: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'] },
    callback: async args => {
      assert.deepEqual(args, { marker: name === 'read_logs' ? 'native-main' : 'native-aux' }); executions.push(name);
      if (parallel) { if (executions.length === 2) parallelResolve(); let timer; try { await Promise.race([barrier, new Promise((_, reject) => timer = setTimeout(() => reject(new Error('Native parallel tool executor serialized the barrier')), 3000))]); } finally { clearTimeout(timer); } }
      return sources[name];
    } }));
  const create = () => new Agent(withCavemanStrands({ model: fixture.model(), tools, retryStrategy: null, toolExecutor: parallel ? 'concurrent' : 'sequential',
    systemPrompt: 'Keep native caller configuration.' }, { runtime, scope: selectedScope }));
  let agent, final = null, firstDeltaBeforeEOF = false, cancelled = false, cancelError = null, snapshot = null, hookResumes = 0, typedResult = null;
  let cancellationBoundary = Promise.resolve(), closedBeforeRelease = null, returnRequested = false, returnedBeforeRelease = null, returned = false;
  const installHook = current => current.addHook(BeforeModelCallEvent, event => { hooks.push(event.type); assert.equal(event.agent, current); });
  try {
    agent = create(); installHook(agent);
    if (mode === 'compress') await runtime.ready();
    if (cell.method === 'every_model_continuation') agent.addHook(AfterInvocationEvent, event => {
      if (!hookResumes) { hookResumes++; fixture.state.resume = true; event.resume = 'Recover the persisted source again.'; }
    });
    if (streamed) {
      const controller = new AbortController(), iterator = agent.stream('Read original logs and recover the omitted detail.', { cancelSignal: AbortSignal.any([controller.signal, t.signal]) }); let text = '';
      try {
        while (true) {
          const next = await iterator.next(); if (next.done) { final = next.value; break; }
          const event = next.value;
          if (event.type === 'modelStreamUpdateEvent' && event.event.type === 'modelContentBlockDeltaEvent' && event.event.delta.type === 'textDelta') {
            text += event.event.delta.text;
            if (text === 'retained-') { assert.equal(fixture.state.gateReleased, false); firstDeltaBeforeEOF = true;
              if (cell.method === 'cancel_and_close') {
                if (lifecycleAction === 'abort') { controller.abort(new Error('native-fixture-cancel')); cancelled = true; }
                else returnRequested = true;
                cancellationBoundary = new Promise(resolve => setTimeout(() => { closedBeforeRelease = fixture.state.closedBeforeEOF;
                  if (returnRequested) returnedBeforeRelease = returned; fixture.release(); resolve(); }, 100));
                if (returnRequested) { await iterator.return(); returned = true; break; }
              } else fixture.release(); }
          }
        }
      } catch (error) { if (!controller.signal.aborted) throw error; cancelError = error.name; }
      finally { await iterator.return(); await cancellationBoundary; }
      if (cell.method === 'cancel_and_close') { assert.equal(lifecycleAction === 'abort' ? cancelled : returnRequested, true); assert.equal(text, 'retained-'); }
      else { assert.equal(text, FACT); assert.equal(messagesText(final), FACT); }
    } else { final = await agent.invoke('Read original logs and recover the omitted detail.', { cancelSignal: t.signal }); assert.equal(messagesText(final), FACT); }
    const initialOriginals = originals(agent); assert.equal(initialOriginals.length, parallel ? 2 : 1);
    for (const original of initialOriginals) assert.equal(original.content[0].text, sources[original.toolUseId === 'read-1' ? 'read_logs' : 'read_aux']);
    const phaseStart = { calls: fixture.state.calls.length, reports: reports.length, plans: plans.length };
    if (cell.method === 'resumed_session') {
      snapshot = JSON.parse(JSON.stringify(agent.takeSnapshot({ preset: 'session' })));
      const originalState = JSON.stringify(snapshot.data.messages);
      await service.restart(); if (mode === 'compress') await runtime.ready();
      const restored = create(); restored.loadSnapshot(snapshot); installHook(restored);
      assert.deepEqual(restored.messages.map(m => m.toJSON()), snapshot.data.messages);
      assert.ok(restored.messages.every(m => m.constructor.name === 'Message' && typeof m.toJSON === 'function'));
      fixture.state.resume = true; final = await restored.invoke('Recover the persisted source again.', { cancelSignal: t.signal });
      assert.equal(messagesText(final), FACT); assert.equal(JSON.stringify(snapshot.data.messages), originalState); agent = restored;
    }
    if (cell.method === 'model.structured_output') {
      fixture.state.structured = true; phase.typed = true;
      const originalState = agent.messages.map(m => m.toJSON());
      const typed = new Agent({ model: withCavemanStrandsModel(fixture.model(), { runtime, scope: { ...selectedScope, branch_id: 'typed', cache_epoch: '1' } }),
        messages: originalState.map(Message.fromJSON), retryStrategy: null }); installHook(typed);
      typedResult = await typed.invoke('Return the typed answer.', { structuredOutputSchema: z.object({ answer: z.number().int() }), cancelSignal: t.signal });
      assert.deepEqual(typedResult.structuredOutput, { answer: 42 }); assert.equal(fixture.state.structuredSeen, 2);
      assert.equal(fixture.state.actions.filter(a => a.type === 'structured').length, 1, 'Native typed validation follows the forced schema continuation');
      assert.deepEqual(agent.messages.map(m => m.toJSON()), originalState);
      assert.ok(reports.slice(phaseStart.reports).every(r => r.replacement_count === 0));
      assert.ok(plans.slice(phaseStart.plans).every(p => p.replacements.length === 0));
    }
    const wire = fixture.state.calls[1].body, wireSource = nativeResults(wire, cell.provider).find(r => r.id === 'read-1').text;
    const recoveryActions = fixture.state.actions.filter(a => a.type.startsWith('recover'));
    assert.equal(executions.length, parallel ? 2 : 1); assert.equal(hooks.length, fixture.state.calls.length);
    assert.equal(reports.length, fixture.state.calls.length, 'Exactly one callback reports each model dispatch');
    assert.equal(runtime.lastReport, reports.at(-1));
    for (const [index, report] of reports.entries()) {
      const count = nativeResults(fixture.state.calls[index].body, cell.provider).filter(r => r.id.startsWith('read-') && r.text.match(handlePattern)).length;
      assert.equal(report.replacement_count, count, 'Callback counts the view sent by the native provider SDK');
      assert.equal(report.adapter, 'strands');
      if (mode === 'off') assert.equal(report.status, 'disabled');
      if (count) { assert.ok(['applied', 'reused'].includes(report.status)); assert.ok(report.transform_ids.length); }
      else assert.ok(['skipped', 'disabled'].includes(report.status));
    }
    if (mode === 'compress') {
      assert.notEqual(wireSource, sources.read_logs); assert.equal(wireSource.includes(FACT), false); assert.ok(recoveryActions.length);
      assert.equal(recoveryActions[0].handle, wireSource.match(handlePattern)[0]);
      const mainSource = originals(agent).find(r => r.toolUseId === 'read-1'); assert.equal(mainSource.content[0].text, sources.read_logs);
      if (cell.method === 'resumed_session' || cell.method === 'every_model_continuation') assert.ok(recoveryActions.some(a => a.type === 'recover_resume'));
      assert.equal(fixture.state.calls.length, parallel ? 4 : ['resumed_session', 'every_model_continuation', 'model.structured_output'].includes(cell.method) ? 5 : 3);
    } else {
      assert.equal(wireSource, sources.read_logs); assert.equal(recoveryActions.length, 0); assert.ok(reports.every(r => r.replacement_count === 0));
      assert.equal(fixture.state.calls.length, cell.method === 'model.structured_output' ? 4 : ['resumed_session', 'every_model_continuation'].includes(cell.method) ? 3 : 2);
      if (mode === 'off') assert.equal(requests.length, 0);
    }
    if (parallel) assert.deepEqual(executions.toSorted(), ['read_aux', 'read_logs']);
    if (cell.method === 'every_model_continuation') assert.equal(hookResumes, 1);
    if (streamed) assert.equal(firstDeltaBeforeEOF, true);
    assert.deepEqual(fixture.state.errors, []);
    return { mode, native_entry_point: cell.method === 'model.structured_output' ? 'Agent.invoke(structuredOutputSchema) -> Model.stream, forced native validation' : `Agent.${cell.method === 'resumed_session' ? 'takeSnapshot/loadSnapshot/invoke' : cell.method === 'every_model_continuation' ? 'invoke/AfterInvocationEvent.resume' : streamed ? 'stream' : 'invoke'}`,
      provider_calls: fixture.state.calls.length, native_tool_calls: executions, source_sha256: hash(sources.read_logs), provider_source_sha256: hash(normalized(wireSource)),
      transformed_request_sha256: hash(normalized(wire)), omitted_fact_absent: !wireSource.includes(FACT), recovery_requests: recoveryActions.length,
      recovered_source_sha256: recoveryActions.length ? hash(sources.read_logs) : null, source_identity_preserved: true,
      native_history_sha256: hash(normalized(agent.messages.map(m => m.toJSON()))), native_message_classes: [...new Set(agent.messages.map(m => m.constructor.name))],
      callback_reports: reports.map(reportView), native_model_hook_calls: hooks.length, first_delta_before_eof: firstDeltaBeforeEOF,
      cancellation: { requested: cancelled, error_type: cancelError, provider_closed_before_release: closedBeforeRelease,
        generator_return_requested: returnRequested, return_completed_before_release: returnedBeforeRelease }, snapshot_roundtrip: snapshot !== null, runtime_restarts: snapshot ? 1 : 0, native_hook_resumes: hookResumes,
      typed: phase.typed ? { output: typedResult.structuredOutput, native_calls: fixture.state.calls.length - phaseStart.calls, callback_reports: reports.slice(phaseStart.reports).map(reportView),
        forced_schema: fixture.state.actions.find(a => a.type === 'structured').schema, recovery_tools: nativeTools(fixture.state.calls.at(-1).body, cell.provider).filter(t => t.name === 'caveman_retrieve').length, replacements: 0 } : null };
  } catch (error) {
    t.diagnostic(`CAVEMAN_MIDDLEWARE_FAILURE ${JSON.stringify({ family: 'F09', cell_id: cell.id, mode, lifecycle_action: lifecycleAction,
      provider_calls: fixture.state.calls.length, native_tool_calls: executions, callback_reports: reports.map(reportView), diagnostics,
      runtime_plans: plans.map(plan => ({ status: plan.status, reason: plan.reason, replacements: plan.replacements?.length ?? 0 })),
      required_journey_complete: false })}`);
    throw error;
  } finally { fixture.release(); await fixture.close(); await runtime.close(); }
}

export async function certifyStrands(t, provider, method) {
  const cell = cells.find(c => c.language === 'typescript' && c.provider === provider && c.method === method); assert.ok(cell);
  const service = await startRuntime(); t.after(service.stop);
  const response = await fetch(service.endpoint + '/caveman/v1/middleware/capabilities'); assert.equal(response.status, 200); await beginNativeCertification(t, await response.json());
  if (provider === 'openai' && method === 'parallel_tool_batch') return nativeParallelGap(t, service, cell);
  const controls = {}; for (const mode of ['compress', 'off', 'outage']) controls[mode] = await run(t, service, cell, mode);
  const active = controls.compress, observed = value => ({ outcome: 'observed', ...value });
  assert.deepEqual(controls.off.native_tool_calls, active.native_tool_calls); assert.deepEqual(controls.outage.native_tool_calls, active.native_tool_calls);
  if (method === 'cancel_and_close') {
    const baseline = await nativeCancellationBaseline(t, provider);
    assert.deepEqual(controls.off.cancellation, baseline); assert.deepEqual(controls.outage.cancellation, baseline); assert.deepEqual(active.cancellation, baseline);
    active.unwrapped_native_cancellation = baseline;
    active.strict_transport_cancellation_passed = baseline.provider_closed_before_release;
    const earlyBaseline = await nativeCancellationBaseline(t, provider, 'return'), earlyControls = {};
    for (const mode of ['compress', 'off', 'outage']) {
      earlyControls[mode] = await run(t, service, cell, mode, 'return');
      assert.deepEqual(earlyControls[mode].cancellation, earlyBaseline);
    }
    active.early_generator_close = { unwrapped: earlyBaseline, ...earlyControls };
    active.strict_transport_early_close_passed = earlyBaseline.provider_closed_before_release;
    active.cancellation_before_dispatch = await cancellationBeforeDispatch(t, service, provider);
  }
  const free = cell.structured_output ? { outcome: 'recovery_free', reason: 'native forced schema output through the public model delegate', replacements: 0, recovery_requests: 0, typed: active.typed } : null;
  emitJourney(t, cell, {
    native_application: observed({ provider, method, native_entry_point: active.native_entry_point }),
    real_tool_result: observed({ native_executions: active.native_tool_calls, source_sha256: active.source_sha256, original_history_preserved: true }),
    transformed_provider_request: free ?? observed({ request_sha256: active.transformed_request_sha256, provider_source_sha256: active.provider_source_sha256, omitted_fact_absent: active.omitted_fact_absent }),
    omitted_fact_requested: free ?? observed({ native_recovery_calls: active.recovery_requests, exact_wire_handle_requested: true }),
    host_executes_exact_recovery: free ?? observed({ source_sha256: active.source_sha256, exact_recovered_sha256: active.recovered_source_sha256, native_executor: 'Strands tool registry' }),
    native_result_history_events_and_call_count: observed(active), off_baseline: observed(controls.off), optimizer_unavailable: observed(controls.outage),
  });
}
