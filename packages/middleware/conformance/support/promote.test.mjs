/** Validator fixtures cannot earn native support: only the real replay API can. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from './inventory.mjs';
import { requiredCells, mandatoryJourney } from './catalog.mjs';
import { assembleNativeCertification, executionObservation, executionPrefix } from './certify.mjs';
import { assertScopedInputCoverage, assertOriginalCandidate, assertReplayRecord, promotedRows, assertPromotedRow, promoteNativeGroup, replayScopedManifestRows, scopedExecutionForRow } from './promote.mjs';

const encode = value => `${JSON.stringify(value, null, 2)}\n`;
const hash = 'a'.repeat(64), copy = value => JSON.parse(JSON.stringify(value));

function observationFixture() {
  const cell = requiredCells().find(cell => cell.family === 'F04' && cell.provider === 'openai' && cell.method === 'generateText');
  const file = 'examples/middleware/ai-sdk/conformance.test.mjs', name = 'validator fixture only', id = `${file}::${name}`;
  const input = { family: 'F04', language: 'typescript', framework_versions: { ai: '7.0.94' }, adapter_version: '0.1.0', runtime_protocol: 1,
    runtime: { binary_sha256: hash }, source_lock: { files: [] }, test_catalog: { tests: [{ file, name, id }] } };
  const execution = executionObservation(input, { runtime_build: 'validator-unit-fixture', schema_version: 1 });
  const journey = Object.fromEntries(mandatoryJourney.map(assertion => [assertion, { test_id: id, observation: { outcome: 'observed', assertion, fixture: 'validator-only' } }]));
  const inspected = { input, execution, raw_output: { path: 'original.tap', sha256: hash }, coverage: [{ cell, complete: true, missing: [], journey }] };
  const record = assembleNativeCertification(inspected, cell.id);
  const reference = { path: 'candidate.json', sha256: sha256(encode(record)) }, nonce = 'fresh-fixture-nonce';
  const output = `TAP version 13\n# ${executionPrefix}${JSON.stringify({ ...execution, replay_nonce: nonce })}\n` +
    mandatoryJourney.map(assertion => `# CAVEMAN_MIDDLEWARE_OBSERVATION ${JSON.stringify({ cell_id: cell.id, assertion, ...journey[assertion] })}\n`).join('') +
    `ok 1 - ${name}\n1..1\n# pass 1\n# fail 0\n`;
  const replay = { schema_version: 1, producer: 'caveman-middleware-independent-replay-v1', evidence_class: 'native_fixture_replay', input_snapshot_sha256: sha256(encode(input)), support_promotion: false,
    processes: [{ file, program: '/fixture/bin/node', args: ['--test', '--test-reporter=tap', file], cwd: '.', replay_nonce: nonce, exit_code: 0, raw_output: { path: 'replay.tap', sha256: sha256(output) } }],
    certifications: [{ ...reference, replayed_sha256: reference.sha256, cell_id: cell.id, tests: [id], assertions: [...mandatoryJourney], result: 'passed' }], verified_assertions: mandatoryJourney.length };
  return { input, inspected, record, replay, references: [reference], records: [record], outputs: [{ file, nonce, output }] };
}

test('scoped proof requires every independently selected source role and exact built runtime input', () => {
  const sources = ['adapter_source', 'sdk_source', 'dependency_lock', 'executed_module', 'test_source', 'package_or_fixture'].map((role, index) => ({ path: `owned-${index}`, role }));
  const runtimeSources = [{ path: 'go.mod', role: 'runtime_source', sha256: hash }];
  const input = { source_lock: { files: [...sources, ...runtimeSources].map(file => ({ ...file, sha256: hash })) }, runtime: { build_provenance: { path: '/fixture/build.json', sha256: hash } } };
  assert.doesNotThrow(() => assertScopedInputCoverage(input, { sources, runtimeSources }));
  for (const source of [...sources, ...runtimeSources]) {
    const removed = copy(input); removed.source_lock.files = removed.source_lock.files.filter(file => file.path !== source.path);
    assert.throws(() => assertScopedInputCoverage(removed, { sources, runtimeSources }), /missing required/);
  }
  const tampered = copy(input); tampered.source_lock.files.find(file => file.path === 'go.mod').sha256 = 'b'.repeat(64);
  assert.throws(() => assertScopedInputCoverage(tampered, { sources, runtimeSources }), /runtime build\/source mismatch/);
  const duplicate = copy(input); duplicate.source_lock.files.push(duplicate.source_lock.files[0]);
  assert.throws(() => assertScopedInputCoverage(duplicate, { sources, runtimeSources }), /duplicate/);
  const unrelated = copy(input); unrelated.source_lock.files.push({ path: 'unexecuted_test.go', role: 'runtime_source', sha256: hash });
  assert.throws(() => assertScopedInputCoverage(unrelated, { sources, runtimeSources }), /not in this executable/);
});

test('native candidate mutations cannot change observations, exact tests or scoped execution hashes', () => {
  const fixture = observationFixture();
  assert.equal(assertOriginalCandidate(fixture.record, fixture.inspected), fixture.record);
  for (const change of [record => { record.runtime.source_lock_sha256 = hash; }, record => { record.tests[0].id += '-other'; },
    record => { delete record.journey[mandatoryJourney[0]]; }, record => { record.journey[mandatoryJourney[0]].observation.fixture = 'unobserved'; },
    record => { record.cells.push(record.cells[0]); }]) {
    const changed = copy(fixture.record); change(changed);
    assert.throws(() => assertOriginalCandidate(changed, fixture.inspected), /candidate differs/);
  }
});

test('saved native replay is checked against nonce-bound raw observations and exact candidate digests', () => {
  const fixture = observationFixture();
  assert.equal(assertReplayRecord(fixture).length, 1);
  for (const change of [data => { data.replay.processes[0].exit_code = 1; },
    data => { data.replay.processes.push(copy(data.replay.processes[0])); data.outputs.push(copy(data.outputs[0])); },
    data => { data.replay.processes[0].replay_nonce = 'reused-nonce'; },
    data => { data.replay.certifications[0].replayed_sha256 = hash; },
    data => { data.replay.verified_assertions--; },
    data => { data.replay.processes[0].args = ['arbitrary-script.mjs']; },
    data => { data.replay.input_snapshot_sha256 = hash; }]) {
    const changed = copy(fixture); change(changed);
    assert.throws(() => assertReplayRecord(changed));
  }
  const missing = copy(fixture); missing.outputs[0].output = missing.outputs[0].output.split('\n').filter(line => !line.includes(`"assertion":"${mandatoryJourney[0]}"`)).join('\n');
  missing.replay.processes[0].raw_output.sha256 = sha256(missing.outputs[0].output);
  assert.throws(() => assertReplayRecord(missing), /missing|differs/);
});

test('a fabricated saved success or matching row never earns a fresh promotion capability', async () => {
  const fixture = observationFixture();
  await assert.rejects(promotedRows({ ...fixture, replay: { result: 'passed' } }, { path: 'fake.json', sha256: hash }), /actual fresh replay/);
  const row = { state: 'conformant', tests: ['invented'], evidence: [{ kind: 'native_fixture', sha256: hash }] };
  assert.throws(() => assertPromotedRow(row, { rows: [row], verified_assertions: 8 }), /actual fresh scoped replay/);
  assert.throws(() => scopedExecutionForRow(row, row.evidence[0], { rows: [row], executions: [{ candidate_sha256: hash }] }), /actual fresh batch/);
  await assert.rejects(replayScopedManifestRows([{ state: 'provider_tested' }], { output: 'unused' }), /separate explicit live-proof/);
});

test('promotion rejects missing, duplicate, stale and escaping artifacts before any native process', async () => {
  const candidate = { path: 'candidate.json', sha256: hash };
  await assert.rejects(promoteNativeGroup({ input: {}, candidates: [], output: 'unused' }), /missing or duplicate/);
  await assert.rejects(promoteNativeGroup({ input: {}, candidates: [candidate, candidate], output: 'unused' }), /missing or duplicate/);
  await assert.rejects(promoteNativeGroup({ input: { path: '../go.mod', sha256: hash }, candidates: [candidate], output: 'unused' }), /invalid repository artifact/);
  await assert.rejects(promoteNativeGroup({ input: { path: 'go.mod', sha256: hash }, candidates: [candidate], output: 'unused' }), /stale or tampered/);
});
