/** Native interleaved-session soak. Default duration is the full 30-minute gate. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile, appendFile, mkdir, mkdtemp, copyFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { cpus, totalmem, platform, arch, tmpdir } from 'node:os';
import { createMiddlewareRuntime } from '../../sdk/typescript/dist/middleware/index.js';
import { withCaveman } from '../typescript/dist/ai-sdk.js';
import { nativeChatFixture, chatResponse, startSSE, chatChunk, writeChunk } from './native-chat-fixture.mjs';
import { startRuntime } from './runtime-fixture.mjs';
import { captureBenchmarkInputs } from './support/benchmark-evidence.mjs';

const native = createRequire(new URL('../../../examples/middleware/ai-sdk/package.json', import.meta.url));
const { createOpenAI } = native('@ai-sdk/openai');
const { generateText, streamText, tool, jsonSchema, stepCountIs } = native('ai');
const execute = promisify(execFile), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const durationSeconds = Number(process.env.CAVEMAN_MIDDLEWARE_SOAK_SECONDS ?? 1800);
const roundMilliseconds = Number(process.env.CAVEMAN_MIDDLEWARE_SOAK_ROUND_MS ?? 10000);
if (!Number.isFinite(durationSeconds) || durationSeconds < 15 || durationSeconds > 7200) throw new Error('Invalid soak duration');
if (!Number.isFinite(roundMilliseconds) || roundMilliseconds < 100 || roundMilliseconds > 30000) throw new Error('Invalid soak round interval');
const output = resolve(process.env.CAVEMAN_MIDDLEWARE_SOAK_OUTPUT ?? 'packages/middleware/conformance/evidence/soak.json');
const journal = output.replace(/\.json$/, '') + '.samples.jsonl';
const binary = process.env.CAVEMAN_MIDDLEWARE_TEST_BINARY;
if (!binary) throw new Error('Set CAVEMAN_MIDDLEWARE_TEST_BINARY to the real local runtime.');
// Keep restarts on identical executable bytes even if another process removes
// the caller's temporary build output during this half-hour run.
const binaryDirectory = await mkdtemp(resolve(tmpdir(), 'caveman-soak-runtime-'));
const runtimeBinary = resolve(binaryDirectory, 'caveman-proxy');
await copyFile(binary, runtimeBinary);
const runtimeBinaryHash = hash(await readFile(runtimeBinary));
const sourceFiles = ['packages/middleware/conformance/soak.mjs', 'packages/middleware/conformance/soak-storage.py',
  'packages/middleware/conformance/native-chat-fixture.mjs', 'packages/middleware/conformance/runtime-fixture.mjs',
  'packages/middleware/typescript/src/ai-sdk.ts', 'packages/middleware/typescript/src/common.ts', 'packages/middleware/typescript/src/versions.ts',
  'packages/sdk/typescript/src/middleware/runtime.ts', 'examples/middleware/ai-sdk/package-lock.json'];
const sourceSnapshot = await Promise.all(sourceFiles.map(async path => ({ path, sha256: hash(await readFile(path)) })));
const inputProvenance = await captureBenchmarkInputs({ files: sourceFiles, binary: runtimeBinary });
const concurrency = 16, scopeCount = 100, recoveryCapacity = 16 << 20;
const original = Array.from({ length: 100 }, (_, i) => `[INFO] reading row ${i}: café 🌍 exact-value-${String(i).padStart(3, '0')} verbose repeated details\r\n`).join('');
const fact = 'exact-value-050', originalHash = hash(original);
const scope = id => ({ namespace: 'native-soak', session_id: `scope-${id}`, branch_id: 'main', cache_epoch: '0' });
const sessions = Array.from({ length: scopeCount }, (_, id) => ({ id, scope: scope(id), history: [], turns: 0,
  handle: null, viewHash: null, sourceExecutions: 0, providerCalls: 0, requestedRecoveries: 0, recoveredAnswers: 0, originalAnswers: 0, recoveryErrors: 0 }));
const diagnostics = {}, outcomes = {}, samples = [], lifecycle = [], startedAt = new Date().toISOString();
const cleanup = { delete_attempts: 0, denial_attempts: 0, transient_failures: {}, deleted_scopes: 0 };
const nativeMethods = { generateText: { attempted: 0, completed: 0 }, streamText: { attempted: 0, completed: 0 } };
let crossScopeDenials = 0;
let activeJobs = 0, activeStreams = 0, completed = 0, restartCount = 0, cancelled = 0, failedProbes = 0;
let service, runtime, provider, caps, closed = false, failure = null, mainStarted;
let stage = 'setup';
await mkdir(dirname(output), { recursive: true }); await writeFile(journal, '');

function counters() {
  return { active_jobs: activeJobs, active_streams: activeStreams,
    pending_optimizations: runtime?.pending ?? 0, pending_receipts: runtime?.receiptsPending ?? 0,
    pending_fetches: runtime?.fetchesPending ?? 0, pending_receipt_fetches: runtime?.receiptFetchesPending ?? 0 };
}
async function settle() {
  const deadline = Date.now() + 5000;
  while (Object.values(counters()).some(value => value !== 0) && Date.now() < deadline) await sleep(10);
  assert.ok(Object.values(counters()).every(value => value === 0), `active work did not settle: ${JSON.stringify(counters())}`);
}
async function sample(label) {
  await settle();
  const [disk, processRSS] = await Promise.all([
    execute(process.env.CAVEMAN_MIDDLEWARE_SOAK_PYTHON ?? 'python3', ['packages/middleware/conformance/soak-storage.py', service.home]),
    execute('ps', ['-o', 'rss=', '-p', String(service.pid)]),
  ]);
  const storage = JSON.parse(disk.stdout);
  assert.ok(storage.metadata_bytes <= 64 << 20, 'middleware retained metadata stays within its configured default capacity');
  assert.ok(storage.ccr_original_bytes <= recoveryCapacity, 'CCR retained originals stay within configured capacity');
  assert.equal(storage.revoked_choice_payload_bytes, 0, 'deleted scopes retain no replacement/CCR-reference payload');
  const row = { label, at: new Date().toISOString(), elapsed_seconds: mainStarted ? (performance.now() - mainStarted) / 1000 : 0,
    completed_turns: completed, restarts: restartCount, node_rss_bytes: process.memoryUsage().rss,
    node_heap_used_bytes: process.memoryUsage().heapUsed, runtime_rss_bytes: Number(processRSS.stdout.trim()) * 1024,
    ...counters(), provider_active_responses: provider.stats().active_responses, provider_open_sockets: provider.stats().open_sockets, ...storage };
  samples.push(row); await appendFile(journal, JSON.stringify(row) + '\n');
  process.stdout.write(JSON.stringify({ event: 'soak_sample', ...row }) + '\n');
  return row;
}
async function parallel(items, action) {
  let next = 0;
  const results = await Promise.allSettled(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await action(items[next++]);
  }));
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
}
async function cleanupRequest(kind, action) {
  // Administrative cleanup is idempotent application work, outside native
  // inference and the timed optimization workload. Keep each RPC's production
  // 100 ms deadline and record every bounded application retry under host load.
  for (let attempt = 0; attempt < 5; attempt++) {
    cleanup[kind === 'delete' ? 'delete_attempts' : 'denial_attempts']++;
    try { return await action(); }
    catch (error) {
      if (!['deadline', 'capacity', 'runtime_unavailable'].includes(error.code) || attempt === 4) throw error;
      cleanup.transient_failures[error.code] = (cleanup.transient_failures[error.code] ?? 0) + 1;
      await sleep(20);
    }
  }
}
async function turn(session) {
  activeJobs++;
  const streaming = (session.id + session.turns) % 2 === 0;
  const nativeMethod = nativeMethods[streaming ? 'streamText' : 'generateText'];
  nativeMethod.attempted++;
  if (streaming) activeStreams++;
  const oldHistoryHash = hash(JSON.stringify(session.history));
  const messages = [...session.history, { role: 'user', content: `Turn ${session.turns}: read logs if needed, recover row 50 exactly, and report its value.` }];
  const before = hash(JSON.stringify(messages));
  try {
    const tools = { read_logs: tool({ description: 'Read exact diagnostic source logs.',
      inputSchema: jsonSchema({ type: 'object', properties: {}, additionalProperties: false }),
      execute: async () => { session.sourceExecutions++; return original; } }) };
    const model = createOpenAI({ apiKey: 'local-fixture', baseURL: provider.url }).chat(`soak-${session.id}`);
    const input = withCaveman({ model, messages, tools, maxRetries: 0, stopWhen: stepCountIs(7) },
      { runtime, scope: session.scope, logicalCallId: `soak-${session.id}-turn-${session.turns}` });
    const result = streaming ? streamText(input) : await generateText(input);
    let answer;
    if (streaming) { answer = ''; for await (const text of result.textStream) answer += text; }
    else answer = result.text;
    assert.equal(answer, fact); assert.equal(hash(JSON.stringify(messages)), before);
    assert.equal(hash(JSON.stringify(session.history)), oldHistoryHash);
    session.history = [...messages, ...await result.responseMessages];
    assert.ok(JSON.stringify(session.history).includes(original.replace(/\r/g, '\\r').replace(/\n/g, '\\n')),
      'original source remains in native host history');
    session.turns++; completed++; nativeMethod.completed++;
  } finally { activeJobs--; if (streaming) activeStreams--; }
}
async function lifecycleProbe(stage) {
  const before = provider.stats().requests;
  const failureModel = createOpenAI({ apiKey: 'local-fixture', baseURL: provider.url }).chat('soak-failure');
  await assert.rejects(generateText(withCaveman({ model: failureModel, prompt: 'Fail once.', maxRetries: 0 },
    { runtime, scope: { ...scope('failure'), cache_epoch: stage } })));
  assert.equal(provider.stats().requests - before, 1, 'no middleware inference retry after provider failure'); failedProbes++;
  const streamModel = createOpenAI({ apiKey: 'local-fixture', baseURL: provider.url }).chat('soak-cancel');
  const wrapped = withCaveman({ model: streamModel }, { runtime, scope: { ...scope('cancel'), cache_epoch: stage } }).model;
  const stream = await wrapped.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'Cancel after first text.' }] }] });
  const reader = stream.stream.getReader();
  for (;;) {
    const next = await reader.read(); assert.equal(next.done, false);
    if (next.value.type === 'text-delta') break;
  }
  const began = performance.now(); await reader.cancel('soak consumer closed'); reader.releaseLock();
  const deadline = Date.now() + 1000;
  while (provider.stats().active_responses && Date.now() < deadline) await sleep(10);
  assert.equal(provider.stats().active_responses, 0, 'native cancellation closes fixture response without EOF');
  cancelled++; await settle();
  lifecycle.push({ stage, failure_requests: 1, cancellation_close_ms: performance.now() - began, ...counters() });
  await runtime.deleteSession({ ...scope('failure'), cache_epoch: stage });
  await runtime.deleteSession({ ...scope('cancel'), cache_epoch: stage });
}

try {
  service = await startRuntime({ binary: runtimeBinary, recoveryBytes: recoveryCapacity });
  runtime = createMiddlewareRuntime({ endpoint: service.endpoint, onDiagnostic: event => { diagnostics[event.code] = (diagnostics[event.code] ?? 0) + 1; } });
  const optimize = runtime.optimize.bind(runtime);
  runtime.optimize = async input => {
    const result = await optimize(input); outcomes[result.reason] = (outcomes[result.reason] ?? 0) + 1;
    return result;
  };
  caps = await runtime.ready();
  provider = await nativeChatFixture(async (body, response) => {
    if (body.model === 'soak-failure') {
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'soak injected provider failure', type: 'server_error' } })); return;
    }
    if (body.model === 'soak-cancel') {
      startSSE(response); await writeChunk(response, chatChunk(body, { role: 'assistant', content: 'first' }));
      await new Promise(resolve => response.once('close', resolve)); return;
    }
    const session = sessions[Number(body.model.slice(5))]; assert.ok(session);
    session.providerCalls++;
    const logs = body.messages.find(message => message.role === 'tool' && message.tool_call_id === `read-${session.id}`);
    if (!logs) return chatResponse(body, response, { calls: [{ name: 'read_logs', input: {}, id: `read-${session.id}` }] });
    if (logs.content === original) {
      // A bounded optimizer bypass is allowed to forward the exact source.
      // The native provider can then answer directly without recovery.
      session.originalAnswers++;
      return chatResponse(body, response, { text: fact });
    }
    assert.ok(logs.content.includes('cmw_'), 'native provider receives a lossy view');
    assert.ok(!logs.content.includes(fact), 'requested fact must be recovered');
    const handle = logs.content.match(/cmw_[a-f0-9]{48}/)?.[0]; assert.ok(handle);
    if (session.handle) { assert.equal(handle, session.handle); assert.equal(hash(logs.content), session.viewHash); }
    else { session.handle = handle; session.viewHash = hash(logs.content); }
    const lastUser = body.messages.findLastIndex(message => message.role === 'user');
    const recoveryResults = body.messages.slice(lastUser + 1).filter(message => message.role === 'tool' && message.tool_call_id?.startsWith(`recover-${session.id}-`));
    const recovered = recoveryResults.at(-1);
    if (!recovered) {
      session.requestedRecoveries++;
      return chatResponse(body, response, { calls: [{ name: 'caveman_retrieve', input: { handle }, id: `recover-${session.id}-${session.turns}` }] });
    }
    let page;
    try { page = JSON.parse(recovered.content); }
    catch (error) {
      // The fixture model explicitly handles a native tool error, with a
      // bounded new tool request. This is host-loop behavior, fully counted;
      // the middleware itself never resends an inference request.
      if (!/Caveman middleware: (deadline|capacity|runtime_unavailable)/.test(recovered.content) || recoveryResults.length >= 3) throw error;
      session.recoveryErrors++; session.requestedRecoveries++;
      return chatResponse(body, response, { calls: [{ name: 'caveman_retrieve', input: { handle }, id: `recover-${session.id}-${session.turns}-retry-${recoveryResults.length}` }] });
    }
    assert.equal(page.text, original); assert.equal(page.complete, true);
    assert.equal(page.original_sha256, originalHash);
    session.recoveredAnswers++;
    await chatResponse(body, response, { text: fact });
  });
  // Establish each grant before the timed interleaving workload. Discovery is
  // serial so unrelated package builds cannot prevent cold scope setup from
  // completing; the measured soak remains at concurrency 16 throughout.
  for (const session of sessions) await turn(session);
  // Discovery/setup is outside the timed soak. A permitted first-call bypass
  // gets a new ordinary native turn before isolation assertions need its grant.
  for (let attempt = 0; attempt < 3 && sessions.some(session => !session.handle); attempt++) {
    for (const session of sessions.filter(session => !session.handle)) await turn(session);
  }
  assert.equal(new Set(sessions.map(session => session.handle)).size, scopeCount);
  for (const session of sessions) {
    await assert.rejects(runtime.recovery(sessions[(session.id + 1) % scopeCount].scope).execute({ handle: session.handle }),
      error => error.code === 'not_found');
    crossScopeDenials++;
  }
  await lifecycleProbe('initial');
  stage = 'native-soak'; mainStarted = performance.now(); await sample('start');
  let nextScope = 0, nextSample = 30000, nextRound = 0;
  const duration = durationSeconds * 1000;
  while (performance.now() - mainStarted < duration) {
    const elapsed = performance.now() - mainStarted;
    if (restartCount < 2 && elapsed >= duration * (restartCount + 1) / 3) {
      await settle(); await service.restart(); await runtime.ready(); restartCount++;
      await lifecycleProbe(`restart-${restartCount}`); await sample(`restart-${restartCount}`);
    }
    const selected = Array.from({ length: concurrency }, () => sessions[nextScope++ % scopeCount]);
    await parallel(selected, turn);
    if (performance.now() - mainStarted >= nextSample) { await sample('running'); nextSample += 30000; }
    nextRound += roundMilliseconds;
    const remaining = Math.min(nextRound, duration) - (performance.now() - mainStarted);
    if (remaining > 0) await sleep(remaining);
  }
  await sample('before-delete');
  stage = 'session-cleanup';
  for (const session of sessions) {
    assert.equal(session.sourceExecutions, 1, 'resumption does not replay original source tools');
    assert.ok(session.turns >= 2, 'every scope was resumed');
    assert.equal(session.providerCalls, session.turns + session.sourceExecutions + session.requestedRecoveries,
      'native provider calls equal final answers plus original and recovery tool requests');
    assert.equal(session.recoveredAnswers + session.originalAnswers, session.turns);
    await cleanupRequest('delete', () => runtime.deleteSession(session.scope));
    await cleanupRequest('denial', async () => {
      try { await runtime.recovery(session.scope).execute({ handle: session.handle }); }
      catch (error) { if (error.code === 'deleted') return; throw error; }
      assert.fail('Deleted scoped recovery grant remained usable');
    });
    cleanup.deleted_scopes++;
    session.history.length = 0;
  }
  const deleted = await sample('after-delete');
  assert.equal(deleted.live_scopes, 0); assert.equal(deleted.choice_payload_bytes, 0); assert.equal(deleted.manifest_bytes, 0);
  assert.equal(deleted.plans, 0); assert.equal(deleted.ccr_originals, 1, 'identical sources share one bounded retained Engine original');
  assert.equal(deleted.ccr_original_bytes, Buffer.byteLength(original));
  runtime.close(); await provider.close(); await settle(); closed = true;
  const closeDeadline = Date.now() + 1000;
  while (provider.stats().open_sockets && Date.now() < closeDeadline) await sleep(5);
  assert.equal(provider.stats().active_responses, 0); assert.equal(provider.stats().open_sockets, 0);
  assert.deepEqual(provider.errors, []);
  assert.equal(restartCount, 2);
} catch (error) { failure = { stage, name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1; }
finally {
  runtime?.close(); await provider?.close().catch(() => {});
  await service?.stop();
  const sourceEnd = await Promise.all(sourceFiles.map(async path => ({ path, sha256: hash(await readFile(path)) })));
  let inputsUnchanged = false;
  try {
    inputsUnchanged = JSON.stringify(inputProvenance) === JSON.stringify(await captureBenchmarkInputs({ files: sourceFiles, binary: runtimeBinary }));
  } catch (error) {
    failure ??= { stage: 'input_provenance', name: error.name, message: error.message };
  }
  if (!inputsUnchanged) process.exitCode = 1;
  const report = { schema_version: 1, evidence_class: 'local_native_interleaved_soak', started_at: startedAt,
    finished_at: new Date().toISOString(), configured_duration_seconds: durationSeconds,
    elapsed_main_seconds: mainStarted ? (performance.now() - mainStarted) / 1000 : 0,
    host: { node: process.version, platform: platform(), arch: arch(), cpu_model: cpus()[0]?.model, cpu_count: cpus().length, memory_bytes: totalmem() },
    concurrency, setup_concurrency: 1, scopes: scopeCount, completed_turns: completed, runtime_restarts: restartCount,
    original_bytes: Buffer.byteLength(original), original_sha256: originalHash, configured_ccr_capacity_bytes: recoveryCapacity,
    runtime_build: caps?.runtime_build, runtime_sha256: runtimeBinaryHash,
    runtime_binary_unchanged: runtimeBinaryHash === hash(await readFile(runtimeBinary)),
    sources: sourceSnapshot, sources_unchanged: JSON.stringify(sourceSnapshot) === JSON.stringify(sourceEnd),
    input_provenance: inputProvenance, input_provenance_unchanged: inputsUnchanged,
    scenarios: { native_methods: nativeMethods,
      exact_recovered_answers: sessions.reduce((sum, session) => sum + session.recoveredAnswers, 0),
      unchanged_original_bypass_answers: sessions.reduce((sum, session) => sum + session.originalAnswers, 0),
      native_model_requested_recovery_retries: sessions.reduce((sum, session) => sum + session.recoveryErrors, 0),
      cross_scope_denials: crossScopeDenials, deletion_denials: cleanup.deleted_scopes,
      source_executions: sessions.reduce((sum, session) => sum + session.sourceExecutions, 0),
      minimum_scope_turns: Math.min(...sessions.map(session => session.turns)), cancelled_streams: cancelled, injected_provider_failures: failedProbes },
    provider: provider?.stats(), provider_errors: provider?.errors, outcomes, diagnostics, lifecycle, cleanup, final_counters: counters(), samples,
    retention_policy: 'Deleting a middleware session revokes scoped grants and purges its manifests, plans and replacement/CCR-reference payload. Bounded metadata tombstones/receipts and one content-addressed Engine original remain under separate CCR capacity policy. Caller histories are caller-owned and explicitly released after deletion.',
    measurement: 'Process RSS/heap and read-only SQLite payload/file size sampled after each work batch settles. Native provider SDK/HTTP pools and caller history are included in RSS; this is not a claim of zero allocator retention.',
    gates: { source_and_runtime_unchanged: inputsUnchanged && JSON.stringify(sourceSnapshot) === JSON.stringify(sourceEnd) && runtimeBinaryHash === hash(await readFile(runtimeBinary)),
      full_30_minutes: durationSeconds >= 1800 && !!mainStarted && (performance.now() - mainStarted) >= 1800000,
      native_journeys_and_lifecycle: !failure && closed, all_counters_zero: Object.values(counters()).every(value => value === 0),
      scoped_payloads_purged_with_bounded_ccr: !failure && closed, two_runtime_restarts: restartCount === 2 },
    failure, local_provider_fixture: true, external_inference_requests: 0, hosted_provider_tested: false };
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ event: 'soak_complete', output, gates: report.gates, failure }) + '\n');
}
