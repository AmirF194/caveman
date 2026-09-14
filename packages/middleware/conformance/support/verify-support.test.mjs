import assert from 'node:assert/strict';
import test from 'node:test';
import { loadInventory, validateInventory, completionGaps, renderMatrix } from './inventory.mjs';
import { cellKey, requiredCells } from './catalog.mjs';
import { hasObservation, observationPrefix } from './observations.mjs';
import { sourceProjection } from './qualified-inventory.mjs';

const snapshot = sourceProjection(await loadInventory());
const copy = () => structuredClone(snapshot);
async function rejects(mutator, message) {
  const input = copy(); mutator(input);
  const result = await validateInventory(input, { checkDocs: false });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.includes(message)), `Expected ${message}; got ${result.errors.slice(0, 8).join('\n')}`);
}

test('support inventory accepts honest incomplete source coverage without certification', async () => {
  const result = await validateInventory(snapshot, { checkDocs: false });
  assert.equal(result.valid, true, result.errors.join('\n'));
  assert.equal(result.counts.operations, requiredCells().length);
  assert.equal(result.counts.requirements, 29);
  assert.equal(result.counts.acceptance_items, 180);
  assert.equal(result.completion.complete, false);
});

test('support inventory rejects an omitted mandatory operation', async () => {
  await rejects(input => input.manifests.pop(), 'missing mandatory cell');
});
test('support inventory rejects duplicate cells instead of hiding an omission', async () => {
  await rejects(input => { input.manifests[input.manifests.length - 1] = structuredClone(input.manifests[0]); }, 'duplicate operation cell');
});
test('support inventory rejects shrinking the frozen mandatory catalog', async () => {
  await rejects(input => input.frozen.cells.pop(), 'required-cell freeze differs');
});
test('support inventory rejects unsupported_version as a certification state', async () => {
  await rejects(input => { input.manifests[0].state = 'unsupported_version'; }, 'invalid support state');
});
test('support inventory rejects source-only conformant claims', async () => {
  await rejects(input => { input.manifests[0].state = 'conformant'; }, 'certification requires native execution evidence');
});
test('support inventory rejects a handwritten success report as native proof', async () => {
  await rejects(input => {
    const report = input.reports.artifacts.find(item => item.classification.startsWith('local_runtime_performance'));
    input.manifests[0].state = 'conformant';
    input.manifests[0].evidence.push({ kind: 'native_fixture', artifact: report.path, sha256: report.sha256 });
  }, 'handwritten success fields are not execution proof');
});
test('support inventory requires emitted observations bound to the exact operation and test', () => {
  const expected = { cell_id: 'F13|python|host|stdio', assertion: 'host_executes_exact_recovery', test_id: 'native.py::test_recovery', observation: { original_sha256: 'a'.repeat(64), recovered_sha256: 'a'.repeat(64) } };
  assert.equal(hasObservation('ok 1 - test_recovery\n# pass 1\n# fail 0\n', expected), false);
  const emitted = `# ${observationPrefix}${JSON.stringify(expected)}\n`;
  assert.equal(hasObservation(emitted, expected), true);
  assert.equal(hasObservation(emitted, { ...expected, cell_id: 'another-operation' }), false);
  assert.equal(hasObservation(emitted, { ...expected, test_id: 'a-different-test' }), false);
  assert.equal(hasObservation(emitted, { ...expected, observation: { passed: true } }), false);
});
test('support inventory rejects inherited certification for another operation', async () => {
  await rejects(input => {
    const report = input.reports.artifacts.find(item => item.classification.startsWith('local_runtime_performance'));
    input.manifests[0].state = 'conformant';
    input.manifests[0].evidence.push({ kind: 'native_fixture', artifact: report.path, sha256: report.sha256 });
  }, 'evidence does not cover this exact operation cell');
});
test('support inventory rejects provider_tested without live provider receipts', async () => {
  await rejects(input => { input.manifests[0].state = 'provider_tested'; }, 'provider_tested requires real provider evidence');
});
test('support inventory rejects not_applicable without upstream API absence proof', async () => {
  await rejects(input => { input.manifests[0].state = 'not_applicable'; }, 'does not establish API absence');
});
test('support inventory rejects stale referenced evidence hashes', async () => {
  await rejects(input => { input.manifests[0].evidence[0].sha256 = '0'.repeat(64); }, 'stale sha256');
});
test('support inventory rejects missing dependency locks', async () => {
  await rejects(input => { input.sources.files = input.sources.files.filter(file => !file.path.endsWith('python-provider-sdks/requirements.lock')); }, 'missing dependency source lock');
});
test('support inventory rejects missing implementation sources', async () => {
  await rejects(input => { input.sources.files = input.sources.files.filter(file => !file.path.endsWith('caveman_middleware/openai.py')); }, 'implemented row has no implementation source lock');
});
test('support inventory rejects provider SDK versions not in the dependency lock', async () => {
  await rejects(input => { input.manifests[0].provider_sdk_versions = { openai: '0.0.0' }; }, 'provider SDK versions differ');
});
test('support inventory rejects nonexistent test names', async () => {
  await rejects(input => { input.manifests[0].tests.push('invented-test.py::test_success'); }, 'unknown test name');
});
test('support inventory rejects omitted normative acceptance items', async () => {
  await rejects(input => input.traceability.requirements[0].acceptance.pop(), 'omitted acceptance item');
});
test('support inventory rejects weakened acceptance text', async () => {
  await rejects(input => { input.traceability.requirements[0].acceptance[0].text = 'Import succeeds.'; }, 'stale or weakened requirement text');
});
test('support inventory rejects acceptance marked complete because source exists', async () => {
  await rejects(input => { input.traceability.requirements[0].acceptance[0].state = 'conformant'; }, 'implementation is not accepted proof');
});
test('support inventory rejects release gates made green without accepted proof', async () => {
  await rejects(input => { input.reports.gates[0].state = 'passed'; }, 'passing release gate requires');
});
test('support inventory detects a public matrix different from its manifests', async () => {
  const input = copy();
  input.manifests[0].state = 'missing';
  const result = await validateInventory(input);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.includes('public support matrix is stale')));
  assert.notEqual(renderMatrix(input), renderMatrix(snapshot));
});
test('support inventory completion audit retains every open operation and acceptance gate', () => {
  const gaps = completionGaps(snapshot);
  assert.equal(gaps.complete, false);
  assert.equal(gaps.operations.length, snapshot.manifests.length);
  assert.equal(gaps.acceptance.length, 180);
  assert.equal(new Set(gaps.operations.map(row => row.id)).size, snapshot.manifests.length);
  assert.equal(gaps.operations[0].id, cellKey(snapshot.manifests[0]));
  assert.ok(gaps.release_gates.some(gate => gate.id === 'performance' && gate.state !== 'passed'));
});
