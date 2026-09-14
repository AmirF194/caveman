import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { families, requiredCells, mandatoryJourney } from './catalog.mjs';
import { root, sha256 } from './inventory.mjs';
import { observationPrefix } from './observations.mjs';
import { assembleNativeCertification, captureCertificationInputs, declaredNodeTests, executionObservation,
  executionPrefix, inspectNativeEvidence, successfulTapTests, validateCertificationInputs, matchNativeReplay, replayNativeCertifications } from './certify.mjs';

// Synthetic files exercise refusal rules only. This test driver never creates
// a certification outside its temporary directory, and the synthetic declaration
// emits no observations, so independent native replay cannot promote it.
async function fixture(t, family = 'F16', language = 'typescript') {
  const directory = await mkdtemp(resolve(root, 'packages/middleware/conformance/support/.certify-unit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = relative(root, resolve(directory, 'synthetic.test.mjs'));
  const binary = resolve(directory, 'synthetic-binary');
  const source = "test('synthetic assembler unit fixture', () => {});\n";
  await writeFile(resolve(root, file), source); await writeFile(binary, 'SYNTHETIC UNIT TEST INPUT; NOT A RUNTIME');
  const config = families.find(item => item.id === family).languages[language];
  const input = await captureCertificationInputs({ family, language, binary, frameworkVersions: { [config.framework]: config.version },
    tests: await declaredNodeTests([file]), sources: [
      ...config.source.map(path => ({ path, role: 'adapter_source' })), ...config.lock.map(path => ({ path, role: 'dependency_lock' })),
      { path: 'packages/sdk/typescript/src/middleware/runtime.ts', role: 'sdk_source' },
      { path: 'proxy/internal/standalone/middleware.go', role: 'runtime_source' }, { path: file, role: 'test_source' },
    ] });
  const cell = requiredCells().find(cell => cell.family === family && cell.language === language && cell.method === (family === 'F16' ? 'agent.generate' : 'unrelated_endpoint_passthrough'));
  const observation = { outcome: 'observed', synthetic_unit_only: true };
  const observations = mandatoryJourney.map(assertion => ({ cell_id: cell.id, test_id: input.test_catalog.tests[0].id, assertion, observation: { ...observation } }));
  const execution = executionObservation(input, { runtime_build: 'synthetic-unit-only', schema_version: 1 });
  const rawOutput = relative(root, resolve(directory, 'synthetic.tap'));
  const write = async (items = observations, metadata = execution, tail = '') => {
    const text = `TAP version 13\n# ${executionPrefix}${JSON.stringify(metadata)}\n${items.map(item => `# ${observationPrefix}${JSON.stringify(item)}`).join('\n')}\nok 1 - synthetic assembler unit fixture\n1..1\n# tests 1\n# pass 1\n# fail 0\n${tail}`;
    await writeFile(resolve(root, rawOutput), text); return text;
  };
  await write();
  return { input, cell, observations, execution, rawOutput, file, binary, source, write,
    inspect: () => inspectNativeEvidence({ input, rawOutput }) };
}

test('native assembler requires a complete passing TAP run and excludes skipped tests', () => {
  assert.deepEqual([...successfulTapTests('ok 1 - actual\n1..1\n# pass 1\n# fail 0\n')], ['actual']);
  for (const output of ['ok 1 - actual\n# pass 1\n# fail 0\n', 'not ok 1 - actual\n1..1\n# pass 1\n# fail 0\n',
    'ok 1 - actual # SKIP\n1..1\n# pass 1\n# fail 0\n', 'ok 1 - actual\n1..1\n# pass 1\n# fail 0\n# cancelled 1\n']) assert.throws(() => successfulTapTests(output), /refused/);
});

test('native assembler selects one exact complete cell and exposes every other missing cell', async t => {
  const f = await fixture(t), inspected = await f.inspect();
  assert.equal(inspected.coverage.length, 18); assert.equal(inspected.coverage.filter(row => row.complete).length, 1);
  const artifact = assembleNativeCertification(inspected, f.cell.id);
  assert.deepEqual(artifact.cells, [f.cell.id]); assert.equal(artifact.tests[0].id, f.input.test_catalog.tests[0].id);
  assert.equal(Object.keys(artifact.journey).length, 8); assert.equal(artifact.independent_replay_required, true);
  assert.throws(() => assembleNativeCertification(inspected, inspected.coverage.find(row => !row.complete).cell.id), /no observation/);
});

test('native assembler refuses missing assertions, unknown cells and conflicting observations', async t => {
  const f = await fixture(t);
  await f.write(f.observations.filter(item => item.assertion !== 'optimizer_unavailable'));
  const missing = await f.inspect(); assert.throws(() => assembleNativeCertification(missing, f.cell.id), /optimizer_unavailable/);
  await f.write([...f.observations, { ...f.observations[0], observation: { outcome: 'observed', conflicting_unit_only: true } }]);
  const conflict = await f.inspect(); assert.throws(() => assembleNativeCertification(conflict, f.cell.id), /conflicting observations/);
  await f.write([{ ...f.observations[0], cell_id: `${f.cell.id}|forged` }]); await assert.rejects(f.inspect, /unexpected cell/);
});

test('native assembler rejects stale source, declaration, lock identity, runtime and execution metadata', async t => {
  const f = await fixture(t);
  await writeFile(resolve(root, f.file), `${f.source}// changed\n`); await assert.rejects(f.inspect, /stale source hash/);
  await writeFile(resolve(root, f.file), f.source);
  const declaration = structuredClone(f.input); declaration.test_catalog.tests[0].line++;
  await assert.rejects(() => validateCertificationInputs(declaration), /test declaration changed/);
  const framework = structuredClone(f.input); framework.framework_versions['@mastra/core'] = '99.0.0';
  await assert.rejects(() => validateCertificationInputs(framework), /revision mismatch/);
  await f.write(f.observations, { ...f.execution, input_snapshot_sha256: '0'.repeat(64) }); await assert.rejects(f.inspect, /hashes do not match/);
  await f.write(); await writeFile(f.binary, 'changed synthetic runtime'); await assert.rejects(f.inspect, /runtime binary changed/);
});

test('native assembler rejects observations without exact passing tests and failed output', async t => {
  const f = await fixture(t);
  await f.write(f.observations.map(item => ({ ...item, test_id: 'unexecuted::invented test' }))); await assert.rejects(f.inspect, /exact passing test/);
  await f.write(f.observations, f.execution, 'not ok 2 - later native failure\n'); await assert.rejects(f.inspect, /failed or incomplete/);
});

test('native assembler only admits explicit recovery-free observations on applicable model-only cells', async t => {
  const f = await fixture(t);
  const applyFree = cellId => f.observations.map(item => ({ ...item, cell_id: cellId,
    observation: ['transformed_provider_request', 'omitted_fact_requested', 'host_executes_exact_recovery'].includes(item.assertion)
      ? { outcome: 'recovery_free', reason: 'synthetic typed output unit case', recovery_requests: 0, replacements: 0 } : item.observation }));
  await f.write(applyFree(f.cell.id)); const native = await f.inspect(); assert.throws(() => assembleNativeCertification(native, f.cell.id), /inapplicable/);
  const typed = requiredCells().find(cell => cell.family === 'F16' && cell.provider === 'openai' && cell.method === 'agent.structured_output');
  await f.write(applyFree(typed.id)); assert.equal(assembleNativeCertification(await f.inspect(), typed.id).cells[0], typed.id);
});

test('native assembler endpoint passthrough requires the frozen endpoint and matching zero-traffic baselines', async t => {
  const f = await fixture(t, 'F01');
  const identity = { applicability: 'endpoint_passthrough', optimizer_requests: 0, recovery_requests: 0, replacements: 0,
    request_sha256: sha256('synthetic request'), response_sha256: sha256('synthetic response'), provider_calls: 1 };
  const observations = f.observations.map(item => ({ ...item, observation: {
    outcome: ['real_tool_result', 'transformed_provider_request', 'omitted_fact_requested', 'host_executes_exact_recovery'].includes(item.assertion) ? 'recovery_free' : 'observed',
    reason: 'synthetic endpoint applicability unit case', ...identity } }));
  await f.write(observations); assert.equal(assembleNativeCertification(await f.inspect(), f.cell.id).cells[0], f.cell.id);
  await f.write(observations.filter(item => item.assertion !== 'off_baseline')); const missing = await f.inspect(); assert.throws(() => assembleNativeCertification(missing, f.cell.id), /off_baseline/);
  await f.write(observations.map(item => item.assertion === 'optimizer_unavailable' ? { ...item, observation: { ...item.observation, optimizer_requests: 1 } } : item));
  const traffic = await f.inspect(); assert.throws(() => assembleNativeCertification(traffic, f.cell.id), /zero-traffic baseline/);
  const create = requiredCells().find(cell => cell.family === 'F01' && cell.language === 'typescript' && cell.method === 'create');
  assert.ok(create);
  await f.write(observations.map(item => ({ ...item, cell_id: create.id, recovery: 'not_applicable' })));
  const forged = await f.inspect(); assert.throws(() => assembleNativeCertification(forged, create.id), /inapplicable|expected an explicit/);
});

test('batch replay rejects partial or mismatched candidates and duplicate actual observations', async t => {
  const f = await fixture(t), record = assembleNativeCertification(await f.inspect(), f.cell.id);
  const nonce = 'fresh-synthetic-process-nonce';
  const output = await f.write(f.observations, { ...f.execution, replay_nonce: nonce });
  const outputs = [{ file: f.file, output, nonce }];
  assert.equal(matchNativeReplay({ input: f.input, records: [record], outputs })[0].assertions.length, 8);
  const partial = structuredClone(record); delete partial.journey.off_baseline;
  assert.throws(() => matchNativeReplay({ input: f.input, records: [partial], outputs }), /partial replay journey/);
  const mismatched = structuredClone(record); mismatched.journey.real_tool_result.observation = { outcome: 'observed', fabricated: true };
  assert.throws(() => matchNativeReplay({ input: f.input, records: [mismatched], outputs }), /differs/);
  assert.throws(() => matchNativeReplay({ input: f.input, records: [record, record], outputs }), /duplicate/);
  const duplicated = await f.write([...f.observations, f.observations[0]], { ...f.execution, replay_nonce: nonce });
  assert.throws(() => matchNativeReplay({ input: f.input, records: [record], outputs: [{ file: f.file, output: duplicated, nonce }] }), /duplicated/);
});

test('batch replay rejects saved prior-run output even when all tests and observations match', async t => {
  const f = await fixture(t), record = assembleNativeCertification(await f.inspect(), f.cell.id);
  const prior = await f.write(f.observations, { ...f.execution, replay_nonce: 'prior-synthetic-process-nonce' });
  assert.throws(() => matchNativeReplay({ input: f.input, records: [record], outputs: [{ file: f.file, output: prior, nonce: 'new-synthetic-process-nonce' }] }), /fresh process nonce/);
  const initial = await f.write();
  assert.throws(() => matchNativeReplay({ input: f.input, records: [record], outputs: [{ file: f.file, output: initial, nonce: 'new-synthetic-process-nonce' }] }), /fresh process nonce/);
});

test('batch replay rejects changed or partial artifacts before starting any process', async t => {
  const f = await fixture(t), record = assembleNativeCertification(await f.inspect(), f.cell.id);
  const artifact = f.rawOutput.replace(/\.tap$/, '.json'), encode = value => `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(resolve(root, artifact), encode(record));
  await assert.rejects(() => replayNativeCertifications({ input: f.input, references: [{ path: artifact, sha256: '0'.repeat(64) }], rawOutput: `${f.rawOutput}.replay.tap` }), /artifact hash changed/);
  await assert.rejects(() => replayNativeCertifications({ input: f.input, references: [{ path: artifact, sha256: sha256(encode(record)) }], rawOutput: f.rawOutput }), /separate from the original/);
  const partial = structuredClone(record); delete partial.journey.optimizer_unavailable;
  await writeFile(resolve(root, artifact), encode(partial));
  await assert.rejects(() => replayNativeCertifications({ input: f.input, references: [{ path: artifact, sha256: sha256(encode(partial)) }], rawOutput: `${f.rawOutput}.replay.tap` }), /differs from its exact original/);
});
