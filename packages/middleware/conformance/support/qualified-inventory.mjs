/** Validate source inventory and scoped execution as separate evidence layers. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { root, validateInventory, completionGaps, renderMatrix, matrixPath, sha256, parseSpecification } from './inventory.mjs';
import { cellKey } from './catalog.mjs';
import { replayScopedManifestRows } from './promote.mjs';

const states = ['missing', 'implemented', 'conformant', 'provider_tested', 'not_applicable'];
const fail = message => { throw new Error(`Qualified inventory refused: ${message}`); };
const criteria = inventory => inventory.traceability.requirements.flatMap(item => item.acceptance);
const equal = (actual, expected, message) => assert.deepEqual(actual, expected, message);

/** This projection grants no execution state; it only reuses source checks. */
export function sourceProjection(inventory) {
  const projection = structuredClone(inventory);
  for (const row of projection.manifests) {
    if (!states.includes(row.state)) fail(`unknown support state ${row.state}`);
    if (row.state === 'provider_tested') fail('provider_tested needs a separate qualified live-provider proof path');
    if (row.state === 'conformant') {
      if (row.evidence?.filter(item => item.kind === 'native_fixture').length !== 1 ||
          row.evidence.filter(item => item.kind === 'runtime_contract').length !== 1) {
        fail(`${cellKey(row)}: conformant needs one exact native candidate and one scoped proof`);
      }
      row.state = 'implemented';
    }
  }
  for (const item of criteria(projection)) if (item.state === 'conformant') {
    if (item.proof?.length !== 1 || !item.tests?.length) fail(`${item.id}: complete criterion needs one whole-criterion proof and exact tests`);
    item.state = 'implemented';
    item.missing_proof = 'Execution is validated separately against this exact complete criterion and a fresh native process.';
  }
  for (const gate of projection.reports.gates) if (gate.state === 'passed') gate.state = 'incomplete';
  return projection;
}

async function artifact(reference) {
  if (!reference || typeof reference.path !== 'string' || !/^[a-f0-9]{64}$/.test(reference.sha256 ?? '') ||
      reference.path.startsWith('/') || reference.path.includes('\\') || reference.path.split('/').some(part => !part || part === '.' || part === '..')) {
    fail('proof needs an exact repository artifact reference');
  }
  const path = await realpath(resolve(root, reference.path));
  if (path === root || relative(root, path).startsWith(`..${sep}`)) fail('proof escaped repository');
  const bytes = await readFile(path);
  if (sha256(bytes) !== reference.sha256) fail(`stale proof artifact ${reference.path}`);
  return JSON.parse(bytes);
}

/** Match a complete observed criterion, never an adjacent passing component. */
export function assertCriterionRow(item, report) {
  const observed = report.criteria?.find(candidate => candidate.id === item.id);
  if (!observed || observed.status !== 'covered' || observed.remaining.length ||
      !observed.components.length || observed.components.some(component => component.observed !== true)) {
    fail(`${item.id}: proof covers only part of this criterion or has no observations`);
  }
  equal({ id: item.id, text: item.text, path: item.path, line: item.line },
    { id: observed.id, text: observed.text, path: observed.path, line: observed.line }, 'criterion text/reference differs from execution');
  const tests = [...new Set(observed.components.map(component => component.test_id))].sort();
  equal([...item.tests].sort(), tests, 'criterion tests differ from the complete observed components');
}

/** Exhaustive gate membership prevents a gate passing on an arbitrary subset. */
export async function validateReleaseGates(inventory) {
  const membership = JSON.parse(await readFile(resolve(root, 'packages/middleware/conformance/support/release-gates.json'), 'utf8'));
  const required = (await parseSpecification()).flatMap(item => item.acceptance).map(item => item.id).sort();
  equal(membership.schema_version, 1, 'unknown release gate policy');
  const assigned = Object.values(membership.gates).flat();
  equal([...assigned].sort(), required, 'release gates must assign all 180 normative criteria exactly once');
  const gates = inventory.reports.gates;
  equal(gates.map(gate => gate.id).sort(), Object.keys(membership.gates).sort(), 'missing, extra or duplicate release gate');
  const accepted = new Set(criteria(inventory).filter(item => item.state === 'conformant').map(item => item.id));
  for (const gate of gates.filter(item => item.state === 'passed')) {
    const ids = membership.gates[gate.id];
    equal([...(gate.acceptance_items ?? [])].sort(), [...ids].sort(), `${gate.id}: passing gate omitted required criteria`);
    if (!ids.every(id => accepted.has(id))) fail(`${gate.id}: passing gate lacks complete accepted criteria`);
  }
  return membership;
}

async function replayAcceptanceRows(inventory, output) {
  // Import only when acceptance claims exist; the source ledger is independent
  // of the producer's implementation and does not manufacture a replay token.
  const { validateRecordedAcceptance, verifyAcceptanceEvidence } = await import('./acceptance.mjs');
  const groups = new Map();
  for (const item of criteria(inventory).filter(item => item.state === 'conformant')) {
    const ref = item.proof[0], key = `${ref.path}:${ref.sha256}`;
    if (!groups.has(key)) groups.set(key, { reference: ref, rows: [] });
    groups.get(key).rows.push(item);
  }
  const executions = [];
  for (const [index, group] of [...groups.values()].entries()) {
    const record = await artifact(group.reference);
    const saved = await validateRecordedAcceptance(group.reference.path);
    equal(saved.report, record, 'acceptance artifact changed during source validation');
    for (const item of group.rows) assertCriterionRow(item, record);
    const replay = await verifyAcceptanceEvidence({ path: group.reference.path, output: resolve(root, output, `acceptance-${index + 1}`) });
    equal(await artifact(group.reference), record, 'acceptance artifact changed during fresh replay');
    const current = await validateRecordedAcceptance(group.reference.path);
    equal(current.report, record, 'acceptance inputs changed after fresh replay');
    executions.push({ proof: group.reference, criteria: group.rows.map(item => item.id), replay });
  }
  return executions;
}

/** No caller-supplied hash set or saved pass flag can qualify a support row. */
export async function validateQualifiedInventory(inventory, { checkDocs = true, replay = false, output, pythonByScope = {} } = {}) {
  const errors = [], executions = {};
  const run = async operation => { try { return await operation(); } catch (error) { errors.push(error.message); return null; } };
  const projection = await run(() => sourceProjection(inventory));
  const source = projection && await run(() => validateInventory(projection, { checkDocs: false }));
  if (source) errors.push(...source.errors);
  await run(() => validateReleaseGates(inventory));
  const native = inventory.manifests.filter(row => row.state === 'conformant');
  const acceptance = criteria(inventory).filter(item => item.state === 'conformant');
  if ((native.length || acceptance.length) && !replay) errors.push('Independent scoped replay required for conformant claims; use --replay.');
  if (!errors.length && replay && (native.length || acceptance.length)) {
    output ??= `.artifacts/middleware-support/replay-${randomUUID()}`;
    if (native.length) executions.native = await run(() => replayScopedManifestRows(inventory.manifests, { output: `${output}/native`, pythonByScope }));
    if (!errors.length && acceptance.length) executions.acceptance = await run(() => replayAcceptanceRows(inventory, output));
    // Native execution must not hide edits to sources outside that family.
    const after = await run(() => validateInventory(sourceProjection(inventory), { checkDocs: false }));
    if (after) errors.push(...after.errors);
    await run(() => validateReleaseGates(inventory));
  }
  if (checkDocs) await run(async () => {
    equal(await readFile(resolve(root, matrixPath), 'utf8'), renderMatrix(inventory), 'public support matrix differs from original qualified rows');
  });
  const completion = completionGaps(inventory);
  return { valid: errors.length === 0, errors: [...new Set(errors)],
    counts: { operations: inventory.manifests.length, requirements: inventory.traceability.requirements.length,
      acceptance_items: criteria(inventory).length, ...Object.fromEntries(states.map(state => [state, inventory.manifests.filter(row => row.state === state).length])) },
    completion: { ...completion, complete: errors.length === 0 && completion.complete },
    ...(executions.native ? { native_replay: { cells: executions.native.rows.length, verified_assertions: executions.native.verified_assertions } } : {}),
    ...(executions.acceptance ? { acceptance_replays: executions.acceptance } : {}),
    ...(output ? { replay_output: output } : {}) };
}
