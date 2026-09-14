/** Native stream buffering proof. Run with node --expose-gc --test. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { cpus, totalmem, platform, arch } from 'node:os';
import { createMiddlewareRuntime } from '../../sdk/typescript/dist/middleware/index.js';
import { withCaveman } from '../typescript/dist/ai-sdk.js';
import { nativeChatFixture, chatChunk, startSSE, writeChunk } from './native-chat-fixture.mjs';
import { startRuntime } from './runtime-fixture.mjs';
import { captureBenchmarkInputs } from './support/benchmark-evidence.mjs';

const native = createRequire(new URL('../../../examples/middleware/ai-sdk/package.json', import.meta.url));
const { createOpenAI } = native('@ai-sdk/openai');
const { wrapLanguageModel } = native('ai');
const tick = () => new Promise(resolve => setImmediate(resolve));

function trackNativeEvents(stream) {
  const input = stream.getReader(), records = [], identities = new WeakMap();
  let produced = 0, pendingBytes = 0, peakPending = 0;
  const tracked = new ReadableStream({
    async pull(controller) {
      try {
        const next = await input.read();
        if (next.done) { input.releaseLock(); controller.close(); return; }
        const size = Buffer.byteLength(JSON.stringify(next.value)) * 2;
        identities.set(next.value, size); records.push({ reference: new WeakRef(next.value), size });
        produced++; pendingBytes += size; peakPending = Math.max(peakPending, pendingBytes);
        controller.enqueue(next.value);
      } catch (error) { input.releaseLock(); controller.error(error); }
    },
    async cancel(reason) { try { await input.cancel(reason); } finally { input.releaseLock(); } },
  }, { highWaterMark: 0 });
  return {
    stream: tracked,
    consume(event) { assert.ok(identities.has(event), 'middleware forwards the exact native event object'); pendingBytes -= identities.get(event); },
    sample() { return { produced, pending_bytes: pendingBytes, peak_pending_bytes: peakPending,
      live_event_bytes: records.reduce((sum, item) => sum + (item.reference.deref() ? item.size : 0), 0) }; },
  };
}

test('native AI SDK forwards 10000 events and 64 MiB with bounded additional event retention', { timeout: 90000 }, async t => {
  assert.equal(typeof global.gc, 'function', 'run node --expose-gc --test packages/middleware/conformance/stream-memory.test.mjs');
  const binary = process.env.CAVEMAN_MIDDLEWARE_TEST_BINARY;
  const files = ['packages/middleware/conformance/stream-memory.test.mjs', 'packages/middleware/conformance/native-chat-fixture.mjs',
    'packages/middleware/conformance/runtime-fixture.mjs', 'packages/middleware/typescript/src/common.ts',
    'packages/middleware/typescript/src/ai-sdk.ts', 'packages/middleware/typescript/src/versions.ts',
    'packages/middleware/typescript/dist/common.js', 'packages/middleware/typescript/dist/ai-sdk.js',
    'packages/middleware/typescript/dist/versions.js', 'packages/sdk/typescript/src/middleware/runtime.ts',
    'packages/sdk/typescript/dist/middleware/runtime.js', 'examples/middleware/ai-sdk/package-lock.json'];
  const snapshot = async () => Promise.all(files.map(async path => ({ path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') })));
  const sourceSnapshot = await snapshot(), binaryHash = createHash('sha256').update(await readFile(binary)).digest('hex');
  const inputProvenance = await captureBenchmarkInputs({ files, binary });
  const service = await startRuntime({ binary }); t.after(service.stop);
  const runtime = createMiddlewareRuntime({ endpoint: service.endpoint }); t.after(() => runtime.close()); await runtime.ready();
  const eventCount = 10000, responseBytes = 64 << 20, done = 'data: [DONE]\n\n';
  let deliveredBytes = 0, deliveredEvents = 0;
  const provider = await nativeChatFixture(async (body, response) => {
    startSSE(response);
    const total = responseBytes - Buffer.byteLength(done);
    for (let i = 0; i < eventCount; i++) {
      const size = Math.floor(total / eventCount) + (i < total % eventCount ? 1 : 0);
      const delta = { ...(i === 0 ? { role: 'assistant' } : {}), content: '' };
      const last = i === eventCount - 1;
      const usage = last ? { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020 } : undefined;
      const overhead = Buffer.byteLength(chatChunk(body, delta, last ? 'stop' : null, usage));
      delta.content = 'x'.repeat(size - overhead);
      const chunk = chatChunk(body, delta, last ? 'stop' : null, usage);
      if (!await writeChunk(response, chunk)) return;
      deliveredBytes += Buffer.byteLength(chunk); deliveredEvents++;
    }
    deliveredBytes += Buffer.byteLength(done); response.end(done);
  }); t.after(provider.close);

  async function measure(wrapped) {
    const samples = []; let tracker;
    const model = wrapLanguageModel({ model: createOpenAI({ apiKey: 'local-fixture', baseURL: provider.url }).chat('stream-memory'), middleware: {
      specificationVersion: 'v4',
      wrapStream: async ({ doStream }) => { const result = await doStream(); tracker = trackNativeEvents(result.stream); return { ...result, stream: tracker.stream }; },
    } });
    const selected = wrapped ? withCaveman({ model }, { runtime, scope: { namespace: 'stream-memory', session_id: 'native', branch_id: 'main', cache_epoch: '0' } }).model : model;
    const result = await selected.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'Stream fixture output.' }] }], maxOutputTokens: 100 });
    const reader = result.stream.getReader();
    let textBytes = 0, textEvents = 0, received = 0, firstPaused = false;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      tracker.consume(next.value); received++;
      if (next.value.type === 'text-delta') {
        textBytes += Buffer.byteLength(next.value.delta); textEvents++;
        if (!firstPaused) {
          firstPaused = true;
          const before = tracker.sample().produced;
          await new Promise(resolve => setTimeout(resolve, 30));
          assert.equal(tracker.sample().produced, before, 'consumer pause prevents middleware from draining native events');
          assert.ok(textEvents < eventCount, 'first text arrives before stream completion');
        }
      }
      if (received % 500 === 0) {
        await tick(); global.gc(); await tick(); global.gc();
        samples.push({ received, ...tracker.sample() });
      }
    }
    reader.releaseLock();
    await tick(); global.gc(); await tick(); global.gc();
    samples.push({ received, ...tracker.sample() });
    assert.equal(textEvents, eventCount); assert.ok(textBytes > 60 << 20);
    assert.equal(tracker.sample().pending_bytes, 0);
    return { text_events: textEvents, text_bytes: textBytes, native_events: received, samples,
      peak_native_event_bytes: Math.max(...samples.map(sample => sample.live_event_bytes)),
      peak_pending_bytes: tracker.sample().peak_pending_bytes };
  }
  const baseline = await measure(false), wrapped = await measure(true);
  const additional = Math.max(0, wrapped.peak_native_event_bytes - baseline.peak_native_event_bytes);
  assert.ok(additional <= 1 << 20, `additional live native event payload ${additional} exceeds 1 MiB`);
  assert.ok(wrapped.peak_pending_bytes <= 1 << 20);
  assert.equal(deliveredBytes, responseBytes * 2); assert.equal(deliveredEvents, eventCount * 2);
  assert.deepEqual(provider.errors, []);
  const sourceUnchanged = JSON.stringify(sourceSnapshot) === JSON.stringify(await snapshot());
  const runtimeUnchanged = binaryHash === createHash('sha256').update(await readFile(binary)).digest('hex');
  const inputsUnchanged = JSON.stringify(inputProvenance) === JSON.stringify(await captureBenchmarkInputs({ files, binary }));
  assert.ok(sourceUnchanged && runtimeUnchanged && inputsUnchanged, 'source, compiled inputs, and runtime remain unchanged during measurement');
  const report = { schema_version: 1, evidence_class: 'local_native_stream_buffering', recorded_at: new Date().toISOString(),
    runtime_sha256: binaryHash, runtime_binary_unchanged: runtimeUnchanged, node: process.version,
    host: { platform: platform(), arch: arch(), cpu_count: cpus().length, cpu_model: cpus()[0]?.model, memory_bytes: totalmem() },
    sources: sourceSnapshot, sources_unchanged: sourceUnchanged,
    input_provenance: inputProvenance, input_provenance_unchanged: inputsUnchanged,
    response_bytes_per_arm: responseBytes, provider_events_per_arm: eventCount, baseline, wrapped,
    additional_live_native_event_bytes: additional,
    measurement: 'Weak references to actual native provider events after GC; JSON byte length doubled bounds text storage. Native source and instrumentation are identical in both arms. Exact event identity, zero prefetch during pause, and pending payload bytes are checked. This measures retained stream event payload, not total process RSS or allocation throughput.',
    gates: { source_and_runtime_unchanged: sourceUnchanged && runtimeUnchanged && inputsUnchanged, native_identity: true, first_event_before_completion: true, backpressure: true,
      additional_event_payload_at_most_1mib: additional <= 1 << 20, pending_payload_at_most_1mib: wrapped.peak_pending_bytes <= 1 << 20 },
    local_provider_fixture: true, external_inference_requests: 0, hosted_provider_tested: false };
  const output = resolve(process.env.CAVEMAN_MIDDLEWARE_STREAM_MEMORY_OUTPUT ?? 'packages/middleware/conformance/evidence/stream-memory.json');
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  t.diagnostic(JSON.stringify({ output, response_bytes: responseBytes, events: eventCount, additional_live_event_bytes: additional,
    max_pending_bytes: wrapped.peak_pending_bytes, runtime_sha256: report.runtime_sha256 }));
});
