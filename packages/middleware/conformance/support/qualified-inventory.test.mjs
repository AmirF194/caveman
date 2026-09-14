import assert from 'node:assert/strict';
import test from 'node:test';
import { loadInventory } from './inventory.mjs';
import { sourceProjection, assertCriterionRow, validateReleaseGates, validateQualifiedInventory } from './qualified-inventory.mjs';

const snapshot = await loadInventory();
const copy = () => structuredClone(snapshot);
const proof = { path: 'go.mod', sha256: 'a'.repeat(64) };
const markNative = row => {
  row.state = 'conformant';
  row.evidence.push({ kind: 'native_fixture', artifact: proof.path, sha256: proof.sha256 },
    { kind: 'runtime_contract', artifact: proof.path, sha256: proof.sha256 });
};

test('source projection keeps original claims, exact evidence and all required scope intact', () => {
  const original = copy();
  markNative(original.manifests[0]);
  const item = original.traceability.requirements[0].acceptance[0];
  item.state = 'conformant'; item.proof = [proof]; item.tests = ['exact-test'];
  original.reports.gates[0].state = 'passed';
  const before = structuredClone(original), projected = sourceProjection(original);
  assert.deepEqual(original, before);
  assert.equal(projected.manifests[0].state, 'implemented');
  assert.deepEqual(projected.manifests[0].evidence, original.manifests[0].evidence);
  assert.deepEqual(projected.manifests[0].tests, original.manifests[0].tests);
  assert.equal(projected.manifests.length, original.manifests.length);
  assert.deepEqual(projected.frozen, original.frozen);
  assert.deepEqual(projected.sources, original.sources);
  assert.equal(projected.traceability.requirements[0].acceptance[0].state, 'implemented');
  assert.equal(projected.reports.gates[0].state, 'incomplete');
});

test('unknown, live-provider and unbound native states cannot enter the projection', () => {
  for (const state of ['provider_tested', 'unsupported_version', 'passed']) {
    const input = copy(); input.manifests[0].state = state;
    assert.throws(() => sourceProjection(input), /unknown support state|separate qualified live-provider/);
  }
  const unbound = copy(); unbound.manifests[0].state = 'conformant';
  assert.throws(() => sourceProjection(unbound), /one exact native candidate/);
  markNative(unbound.manifests[0]);
  unbound.manifests[0].evidence.push({ kind: 'runtime_contract', artifact: proof.path, sha256: proof.sha256 });
  assert.throws(() => sourceProjection(unbound), /one exact native candidate/);
});

test('acceptance promotion binds complete criterion text and every observed component test', () => {
  const item = { id: 'runtime.R2.AC04', text: 'Exact unchanged normative text.', path: 'spec.md', line: 1, tests: ['test-one', 'test-two'] };
  const complete = { ...item, status: 'covered', remaining: [], components: [
    { observed: true, test_id: 'test-one' }, { observed: true, test_id: 'test-two' },
  ] };
  assert.doesNotThrow(() => assertCriterionRow(item, { criteria: [complete] }));
  for (const mutation of [value => { value.status = 'partial'; }, value => { value.remaining.push('Missing process restart.'); },
    value => { value.components[0].observed = false; }, value => { value.text = 'A weaker claim.'; },
    value => { value.components.pop(); }, value => { value.components[0].test_id = 'a-different-test'; }]) {
    const altered = structuredClone(complete); mutation(altered);
    assert.throws(() => assertCriterionRow(item, { criteria: [altered] }));
  }
});

test('release gates cannot pass on one convenient accepted criterion', async () => {
  const input = copy(), membership = await validateReleaseGates(input);
  for (const requirement of input.traceability.requirements) for (const item of requirement.acceptance) item.state = 'conformant';
  const gate = input.reports.gates.find(item => item.id === 'native_journeys');
  gate.state = 'passed'; gate.acceptance_items = [membership.gates.native_journeys[0]];
  await assert.rejects(validateReleaseGates(input), /passing gate omitted required criteria/);
  gate.acceptance_items = [...membership.gates.native_journeys];
  await assert.doesNotReject(validateReleaseGates(input));
  input.traceability.requirements.find(item => item.id === 'adapters.R1').acceptance[0].state = 'implemented';
  await assert.rejects(validateReleaseGates(input), /passing gate lacks complete accepted criteria/);
});

test('duplicate or omitted release gates cannot shrink completion', async () => {
  const input = copy(); input.reports.gates[1] = structuredClone(input.reports.gates[0]);
  await assert.rejects(validateReleaseGates(input), /missing, extra or duplicate release gate/);
});

test('caller hash sets and source projection cannot grant original claimed support', async () => {
  const input = copy(); markNative(input.manifests[0]);
  const result = await validateQualifiedInventory(input, { checkDocs: false, replayed: new Set([proof.sha256]) });
  assert.equal(result.valid, false);
  assert.equal(result.counts.conformant, 1, 'displayed states belong to original rows');
  assert.equal(result.counts.implemented, input.manifests.filter(row => row.state === 'implemented').length);
  assert.ok(result.errors.includes('Independent scoped replay required for conformant claims; use --replay.'));
  assert.equal(result.native_replay, undefined);
  assert.equal(result.completion.complete, false);
});
