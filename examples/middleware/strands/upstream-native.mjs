/** Bounded native dependency diagnostics. Passing parity does not certify missing behavior. */
import assert from 'node:assert/strict';
import { Agent, FunctionTool, BeforeToolsEvent } from '@strands-agents/sdk';
import { createMiddlewareRuntime } from '../../../packages/sdk/typescript/dist/middleware/index.js';
import { withCavemanStrands } from '../../../packages/middleware/typescript/dist/strands.js';
import { providerFixture, sources } from './certification-provider.mjs';

export async function nativeParallelGap(t, service, cell) {
  const rows = [];
  for (const mode of ['unwrapped', 'compress', 'off', 'outage']) {
    const fixture = await providerFixture('openai', { parallel: true }), reports = [], executed = [], beforeTools = [];
    const runtime = createMiddlewareRuntime({ endpoint: mode === 'outage' ? 'http://127.0.0.1:1' : service.endpoint,
      mode: mode === 'off' ? 'off' : 'compress', onReport: report => reports.push(report) });
    try {
      if (mode === 'compress') await runtime.ready();
      const tools = ['read_logs', 'read_aux'].map(name => new FunctionTool({ name, description: `Read ${name}`,
        inputSchema: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'] },
        callback: args => { executed.push({ name, input: args }); return sources[name]; } }));
      const input = { model: fixture.model(), tools, retryStrategy: null, toolExecutor: 'concurrent', printer: false };
      const agent = new Agent(mode === 'unwrapped' ? input : withCavemanStrands(input, { runtime,
        scope: { namespace: `f09-upstream-${crypto.randomUUID()}`, session_id: 'session', branch_id: 'main', cache_epoch: '0' } }));
      agent.addHook(BeforeToolsEvent, event => beforeTools.push(event.message.content.filter(block => block.type === 'toolUseBlock').map(block => ({ name: block.name, id: block.toolUseId, input: block.input }))));
      const result = await agent.invoke('Read both sources.', { limits: { turns: 1 }, cancelSignal: t.signal });
      assert.equal(fixture.state.calls.length, 1); assert.deepEqual(fixture.state.errors, []);
      assert.deepEqual(fixture.state.actions[0].ids, ['read-1', 'read-2']);
      assert.deepEqual(beforeTools, [[{ name: 'read_aux', id: 'read-2', input: { marker: 'native-aux' } }]]);
      assert.deepEqual(executed, [{ name: 'read_aux', input: { marker: 'native-aux' } }]);
      assert.equal(result.stopReason, 'limitTurns');
      assert.ok(reports.every(report => report.replacement_count === 0));
      rows.push({ mode, provider_calls: 1, provider_tool_ids: ['read-1', 'read-2'], native_before_tools: beforeTools,
        actual_native_executions: executed, terminal_stop_reason: result.stopReason, callback_count: reports.length });
    } finally { await fixture.close(); await runtime.close(); }
  }
  const source = { framework: '@strands-agents/sdk@1.17.0', provider: 'openai@6.49.0',
    mapper: 'dist/src/models/openai/chat-adapter.js:338-365', aggregator: 'dist/src/models/model.js:173-212',
    defect: 'Two legal Chat Completions tool deltas start before either stop; the native single-block accumulator retains only the last tool.' };
  t.diagnostic(`CAVEMAN_MIDDLEWARE_UNBACKED_NATIVE ${JSON.stringify({ cell_id: cell.id, reason: 'upstream_native_parallel_tool_loss', source, native_parity: rows,
    required_journey_complete: false, evidence_class: 'bounded_native_dependency_reproduction' })}`);
}

export async function nativeCancellationBaseline(t, protocol, action = 'abort') {
  const fixture = await providerFixture(protocol, { gateText: true }), controller = new AbortController();
  let cancellationBoundary = Promise.resolve(), closed = null, errorType = null, text = '', returnRequested = false, returned = false, returnedBeforeRelease = null;
  try {
    const agent = new Agent({ model: fixture.model(), tools: [new FunctionTool({ name: 'read_logs', description: 'Read original source',
      inputSchema: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'] }, callback: () => sources.read_logs })], retryStrategy: null });
    const iterator = agent.stream('Read source.', { cancelSignal: AbortSignal.any([controller.signal, t.signal]) });
    try {
      for (;;) {
        const next = await iterator.next(); if (next.done) break;
        const event = next.value;
        if (event.type === 'modelStreamUpdateEvent' && event.event.type === 'modelContentBlockDeltaEvent' && event.event.delta.type === 'textDelta') {
          text += event.event.delta.text;
          if (text === 'retained-') {
            assert.equal(fixture.state.gateReleased, false);
            if (action === 'abort') controller.abort(new Error('native-fixture-cancel')); else returnRequested = true;
            cancellationBoundary = new Promise(resolve => setTimeout(() => { closed = fixture.state.closedBeforeEOF;
              if (returnRequested) returnedBeforeRelease = returned; fixture.release(); resolve(); }, 100));
            if (returnRequested) { await iterator.return(); returned = true; break; }
          }
        }
      }
    } catch (error) { if (!controller.signal.aborted) throw error; errorType = error.name; }
    finally { await iterator.return(); await cancellationBoundary; }
    assert.equal(text, 'retained-'); assert.equal(fixture.state.calls.length, 2); assert.deepEqual(fixture.state.errors, []);
    return { requested: controller.signal.aborted, error_type: errorType, provider_closed_before_release: closed,
      generator_return_requested: returnRequested, return_completed_before_release: returnedBeforeRelease };
  } finally { fixture.release(); await fixture.close(); }
}

export async function cancellationBeforeDispatch(t, service, protocol) {
  const rows = [];
  for (const mode of ['unwrapped', 'compress', 'off', 'outage', 'during_optimization']) {
    const fixture = await providerFixture(protocol), controller = new AbortController(), plans = [], reports = [];
    const runtime = createMiddlewareRuntime({ mode: mode === 'off' ? 'off' : 'compress',
      endpoint: mode === 'outage' ? 'http://127.0.0.1:1' : service.endpoint, onReport: report => reports.push(report),
      fetch: async (url, init) => {
        const response = await fetch(url, init);
        if (url.endsWith('/optimize')) { plans.push(await response.clone().json()); if (mode === 'during_optimization') controller.abort(new Error('cancel-before-provider')); }
        return response;
      } });
    try {
      if (mode === 'during_optimization') await runtime.ready(); else controller.abort(new Error('cancel-before-invocation'));
      let messages = [], before = 0;
      const read = new FunctionTool({ name: 'read_logs', description: 'Read original source',
        inputSchema: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'] }, callback: () => sources.read_logs });
      if (mode === 'during_optimization') {
        const seed = new Agent({ model: fixture.model(), tools: [read], retryStrategy: null, printer: false });
        await seed.invoke('Read source.', { cancelSignal: t.signal });
        messages = seed.messages.map(message => message.toJSON()); before = fixture.state.calls.length; assert.equal(before, 2);
      }
      const input = { model: fixture.model(), messages, tools: [read], retryStrategy: null, printer: false };
      const agent = new Agent(mode === 'unwrapped' ? input : withCavemanStrands(input, { runtime,
        scope: { namespace: `f09-cancel-${crypto.randomUUID()}`, session_id: 'session', branch_id: 'main', cache_epoch: '0' } }));
      const result = await agent.invoke('Read source.', { cancelSignal: AbortSignal.any([controller.signal, t.signal]) });
      assert.equal(result.stopReason, 'cancelled'); assert.equal(fixture.state.calls.length - before, 0);
      assert.equal(plans.length, mode === 'during_optimization' ? 1 : 0); assert.deepEqual(fixture.state.errors, []);
      assert.ok(reports.every(report => report.replacement_count === 0));
      rows.push({ mode, native_stop_reason: result.stopReason, provider_calls: 0, seed_native_provider_calls: before,
        actual_runtime_plans_before_cancellation: plans.length, callback_count: reports.length });
    } finally { await fixture.close(); await runtime.close(); }
  }
  return rows;
}
