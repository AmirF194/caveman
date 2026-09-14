/** Full native AI SDK adapter timing with local provider HTTP outside the span. */
import assert from 'node:assert/strict';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cpus, platform, arch, loadavg, totalmem, freemem } from 'node:os';
import { createMiddlewareRuntime } from '../../sdk/typescript/dist/middleware/index.js';
import { withCaveman } from '../typescript/dist/ai-sdk.js';
import { startRuntime } from './runtime-fixture.mjs';
import { nativeChatFixture, chatResponse } from './native-chat-fixture.mjs';
import { captureBenchmarkInputs } from './support/benchmark-evidence.mjs';

const native = createRequire(new URL('../../../examples/middleware/ai-sdk/package.json', import.meta.url));
const { createOpenAI } = native('@ai-sdk/openai');
const { generateText, tool, jsonSchema, wrapLanguageModel } = native('ai');
const binary = process.env.CAVEMAN_MIDDLEWARE_TEST_BINARY;
const sourceFiles = ['packages/middleware/conformance/performance.mjs', 'packages/middleware/conformance/native-chat-fixture.mjs',
  'packages/middleware/typescript/src/ai-sdk.ts', 'packages/middleware/typescript/src/common.ts',
  'packages/middleware/typescript/src/versions.ts', 'packages/middleware/typescript/dist/ai-sdk.js',
  'packages/middleware/typescript/dist/common.js', 'packages/middleware/typescript/dist/versions.js',
  'packages/sdk/typescript/src/middleware/runtime.ts', 'packages/sdk/typescript/dist/middleware/runtime.js',
  'packages/middleware/conformance/runtime-fixture.mjs', 'examples/middleware/ai-sdk/package-lock.json'];
const sourceSnapshot = await Promise.all(sourceFiles.map(async path => ({ path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') })));
const inputProvenance = await captureBenchmarkInputs({ files: sourceFiles, binary });
const binaryHash = createHash('sha256').update(await readFile(binary)).digest('hex');
const output = resolve(process.env.CAVEMAN_MIDDLEWARE_PERFORMANCE_OUTPUT ?? 'packages/middleware/conformance/evidence/performance.json');
const concurrency = 16, requests = Number(process.env.CAVEMAN_MIDDLEWARE_PERFORMANCE_REQUESTS ?? 1000), warmupCalls = 100;
if (!Number.isSafeInteger(requests) || requests < 1 || requests > 100000) throw new Error('Invalid performance request count');
const source = Array.from({ length: 2000 }, (_, i) => `[INFO] row ${i} repeated diagnostic details with exact detail-${i}\n`).join('').slice(0, 100 << 10);
const scope = id => ({ namespace: 'performance', session_id: id, branch_id: 'main', cache_epoch: '0' });
const messages = [
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'read-1', toolName: 'read_logs', input: {} }] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'read-1', toolName: 'read_logs', output: { type: 'text', value: source } }] },
];
const sourceTool = tool({ description: 'Read diagnostic logs.', inputSchema: jsonSchema({ type: 'object', properties: {}, additionalProperties: false }), execute: async () => source });

function summarize(samples, statuses = []) {
  samples.sort((a, b) => a - b);
  const bypass = statuses.filter(status => status !== 'optimized').length;
  return { requests: samples.length, p50_ms: samples[Math.floor(samples.length * .5)], p95_ms: samples[Math.ceil(samples.length * .95) - 1], max_ms: samples.at(-1),
    ...(statuses.length ? { bypass_count: bypass, bypass_fraction: bypass / samples.length,
      statuses: statuses.reduce((out, status) => (out[status] = (out[status] ?? 0) + 1, out), {}) } : {}) };
}
async function parallel(count, job) {
  const times = [], statuses = [], nativeWall = []; let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < count) {
      const index = next++, start = performance.now(), result = await job(index);
      statuses.push(result.status); times.push(result.adapterMs); nativeWall.push(performance.now() - start);
    }
  }));
  return { ...summarize(times, statuses), native_call_wall: summarize(nativeWall) };
}

const service = await startRuntime({ binary });
const provider = await nativeChatFixture(async (body, response) => {
  assert.equal(body.messages.filter(message => message.role === 'tool').length, 1);
  await chatResponse(body, response, { text: 'performance-fixture' });
});
const model = createOpenAI({ apiKey: 'local-fixture', baseURL: provider.url }).chat('performance-fixture');
const observed = new Map(), phases = { cold: [], warm: [] };
const hostAtStart = { load_average: loadavg(), free_memory_bytes: freemem() };
let phase, validPlan;
const runtime = createMiddlewareRuntime({ endpoint: service.endpoint, fetch: async (url, init) => {
  const id = typeof init?.body === 'string' ? init.body.slice(0, 512).match(/"logical_call_id":"([^"]+)"/)?.[1] : null;
  const entry = id && url.endsWith('/optimize') ? observed.get(id) : null;
  if (entry) entry.dispatched = performance.now();
  const result = await fetch(url, init);
  if (entry) entry.headers = performance.now();
  return result;
} });
const optimize = runtime.optimize.bind(runtime);
runtime.optimize = async options => {
  const result = await optimize(options), entry = observed.get(options.logicalCallId);
  if (entry) entry.result = result;
  if (result.status === 'optimized') validPlan = result;
  return result;
};

async function run(client, id, index, component = false) {
  const logical = `logical-${id}-${index}`, entry = {};
  observed.set(logical, entry);
  try {
    // The inner public native middleware records arrival after Caveman's view
    // and dispatch observation, but before native provider serialization/HTTP.
    const measuredModel = wrapLanguageModel({ model, middleware: {
      specificationVersion: 'v4',
      wrapGenerate: async ({ params, doGenerate }) => {
        entry.finished = performance.now();
        entry.shortened = params.prompt[1].content[0].output.value !== source;
        return doGenerate();
      },
    } });
    const construction = performance.now();
    const input = withCaveman({ model: measuredModel, messages, tools: { read_logs: sourceTool }, maxRetries: 0,
      onLanguageModelCallStart: () => { entry.started = performance.now(); },
    }, { runtime: client, scope: scope(id), logicalCallId: logical });
    entry.constructionMs = performance.now() - construction;
    const result = await generateText(input);
    assert.equal(result.text, 'performance-fixture');
    assert.equal(messages[1].content[0].output.value, source, 'caller history remains original');
    assert.ok(Number.isFinite(entry.started) && Number.isFinite(entry.finished), 'native call hooks and model boundary both executed');
    const status = component ? (entry.shortened ? 'optimized' : 'missing_view') : entry.result?.status === 'optimized' ? 'optimized' : entry.result?.reason ?? 'missing_outcome';
    if (status === 'optimized') assert.equal(entry.shortened, true);
    if (phase && entry.headers !== undefined) phases[phase].push({ preparation: entry.dispatched - entry.started,
      runtime_headers: entry.headers - entry.dispatched, response_validation: entry.finished - entry.headers });
    return { status, adapterMs: entry.constructionMs + entry.finished - entry.started };
  } finally { observed.delete(logical); }
}

try {
  const caps = await runtime.ready();
  for (let i = 0; i < warmupCalls; i++) {
    const result = await run(runtime, `warmup-${i % concurrency}`, i);
    if (result.status !== 'optimized') throw new Error(`Warmup failed: ${result.status}`);
  }
  // Only RPC/Engine and background receipt delivery are substituted in this
  // component. The actual native generation API supplies real executor/tool
  // contexts. Cross-scope replay here is a timing fixture, never recovery proof.
  const component = createMiddlewareRuntime({ endpoint: service.endpoint });
  component.optimize = async () => validPlan;
  component.observe = async () => {};
  let adapterOnly;
  try { adapterOnly = await parallel(requests, i => run(component, `adapter-${i}`, i, true)); }
  finally { component.close(); }
  phase = 'cold';
  const cold = await parallel(requests, i => run(runtime, `cold-${i}`, i));
  phase = undefined;
  for (let i = 0; i < concurrency; i++) if ((await run(runtime, `warm-${i}`, 0)).status !== 'optimized') throw new Error('Warm replay setup failed');
  phase = 'warm';
  const warm = await parallel(requests, i => run(runtime, `warm-${i % concurrency}`, i + 1));
  assert.deepEqual(provider.errors, []);
  const sourceEnd = await Promise.all(sourceFiles.map(async path => ({ path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') })));
  const sourcesUnchanged = JSON.stringify(sourceSnapshot) === JSON.stringify(sourceEnd);
  const runtimeUnchanged = binaryHash === createHash('sha256').update(await readFile(binary)).digest('hex');
  const inputsUnchanged = JSON.stringify(inputProvenance) === JSON.stringify(await captureBenchmarkInputs({ files: sourceFiles, binary }));
  const evidence = { schema_version: 1, evidence_class: 'local_native_adapter_performance', recorded_at: new Date().toISOString(),
    node: process.version, platform: platform(), arch: arch(), cpu_count: cpus().length, cpu_model: cpus()[0]?.model, total_memory_bytes: totalmem(),
    host_at_start: hostAtStart, host_at_end: { load_average: loadavg(), free_memory_bytes: freemem() }, dedicated_host: false,
    runtime_build: caps.runtime_build, runtime_sha256: binaryHash, runtime_binary_unchanged: runtimeUnchanged,
    sources: sourceSnapshot, sources_unchanged: sourcesUnchanged,
    input_provenance: inputProvenance, input_provenance_unchanged: inputsUnchanged,
    concurrency, warmup_calls: warmupCalls, payload_bytes: Buffer.byteLength(source),
    measurement_boundary: { adapter: 'actual generateText(withCaveman(...)), native executor hooks, and inner public wrapGenerate boundary',
      adapter_only: 'bundle construction plus native language-model-call-start to inner model dispatch; actual adapter traversal/attestation/copy with valid Engine plan replay and no receipt RPC',
      roundtrip: 'same native span with SDK validation, local RPC, durable Engine/CCR processing, plan application and asynchronous receipt submission',
      excluded: 'native application prompt preparation before language-model-call-start; provider serialization, local fixture HTTP, generation and final response processing',
      native_call_wall: 'whole native generation including local fixture HTTP, reported separately',
      provider_dispatch: 'local deterministic HTTP fixture only', protocols: { ai: '7.0.94', '@ai-sdk/openai': '4.0.62' } },
    adapter_only: adapterOnly, cold, warm,
    phases: Object.fromEntries(Object.entries(phases).map(([stage, values]) => [stage, Object.fromEntries(['preparation', 'runtime_headers', 'response_validation'].map(key => [key, summarize(values.map(value => value[key]))]))])),
    gates: { source_and_runtime_unchanged: sourcesUnchanged && runtimeUnchanged && inputsUnchanged,
      minimum_1000_requests: requests >= 1000, adapter_p95_at_most_5ms: adapterOnly.p95_ms <= 5,
      roundtrip_p95_at_most_50ms: cold.p95_ms <= 50 && warm.p95_ms <= 50, bypass_under_1pct: cold.bypass_fraction < .01 && warm.bypass_fraction < .01 },
    hosted_provider_tested: false };
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
  process.stdout.write(JSON.stringify(evidence) + '\n');
  if (Object.values(evidence.gates).some(passed => !passed)) process.exitCode = 1;
} finally { runtime.close(); await provider.close(); await service.stop(); }
