#!/usr/bin/env node
/** Apply exact qualified evidence only after fresh native replay succeeds. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root, supportPath, matrixPath, renderMatrix, sha256 } from './inventory.mjs';
import { cellKey, families, mandatoryJourney } from './catalog.mjs';
import { assertCriterionRow, validateQualifiedInventory } from './qualified-inventory.mjs';

const encode = value => `${JSON.stringify(value, null, 2)}\n`;
const fail = message => { throw new Error(`Support application refused: ${message}`); };

async function artifact(path, expected) {
  if (typeof path !== 'string' || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) fail('evidence must be a repository-relative file');
  const actual = await realpath(resolve(root, path));
  if (actual === root || relative(root, actual).startsWith(`..${sep}`)) fail('evidence escaped repository');
  const bytes = await readFile(actual), reference = { path, sha256: sha256(bytes) };
  if (expected && reference.sha256 !== expected) fail(`stale evidence ${path}`);
  return { reference, value: JSON.parse(bytes) };
}

export async function applyQualifiedSupport({ promotions = [], acceptance, pythonByScope = {}, output }) {
  if (!promotions.length && !acceptance) fail('supply at least one scoped promotion or complete-criterion candidate');
  const paths = ['required-cells.json', 'traceability.json', 'test-catalog.json', 'source-lock.json', 'reports.json',
    ...families.map(family => `manifests/${family.id}.json`)].map(path => `${supportPath}/${path}`);
  paths.push(matrixPath);
  const captured = new Map(await Promise.all(paths.map(async path => [path, await readFile(resolve(root, path))])));
  const before = new Map([...captured].map(([path, bytes]) => [path, sha256(bytes)]));
  const capturedJSON = name => JSON.parse(captured.get(`${supportPath}/${name}.json`).toString('utf8'));
  // Parse the same bytes used by the concurrent-write guard. A second read
  // could observe an edit that the original snapshot did not contain.
  const candidate = { frozen: capturedJSON('required-cells'), traceability: capturedJSON('traceability'),
    tests: capturedJSON('test-catalog'), sources: capturedJSON('source-lock'), reports: capturedJSON('reports'),
    manifests: families.flatMap(family => capturedJSON(`manifests/${family.id}`)) };
  const rows = new Map(candidate.manifests.map((row, index) => [cellKey(row), index]));
  const applied = new Set(), references = [];
  for (const path of promotions) {
    const { reference, value: promotion } = await artifact(path);
    if (promotion.producer !== 'caveman-middleware-scoped-promotion-v1' || promotion.evidence_class !== 'reviewable_native_support_promotion' ||
        promotion.shared_inventory_mutated !== false || promotion.live_provider_promotions !== 0 || promotion.acceptance_items?.length !== 0) fail('wrong scoped promotion class');
    const { value: qualified } = await artifact(promotion.rows?.path, promotion.rows?.sha256);
    if (!Array.isArray(qualified) || !qualified.length) fail('promotion contains no exact rows');
    assert.deepEqual([...promotion.cells].sort(), qualified.map(cellKey).sort(), 'promotion cells differ from its exact rows');
    assert.equal(promotion.verified_assertions, qualified.length * mandatoryJourney.length, 'promotion assertion count differs');
    for (const row of qualified) {
      const id = cellKey(row);
      if (row.state !== 'conformant' || !rows.has(id) || applied.has(id)) fail(`unknown, duplicate or non-native promotion ${id}`);
      const proof = row.evidence.filter(item => item.kind === 'runtime_contract');
      if (proof.length !== 1 || proof[0].artifact !== promotion.proof?.path || proof[0].sha256 !== promotion.proof?.sha256) fail('row differs from its scoped proof reference');
      candidate.manifests[rows.get(id)] = row; applied.add(id);
    }
    references.push(reference);
  }
  const accepted = [];
  if (acceptance) {
    const { reference, value: report } = await artifact(acceptance);
    if (report.producer !== 'caveman-middleware-shared-acceptance-v1' || report.evidence_class !== 'shared_go_acceptance_component_candidate' || report.support_promotion !== false) fail('wrong complete-criterion candidate class');
    const items = new Map(candidate.traceability.requirements.flatMap(item => item.acceptance).map(item => [item.id, item]));
    for (const observed of report.criteria.filter(item => item.status === 'covered')) {
      const item = items.get(observed.id);
      if (!item || accepted.includes(item.id)) fail('unknown or duplicate acceptance criterion');
      item.tests = [...new Set(observed.components.map(component => component.test_id))].sort();
      assertCriterionRow(item, report);
      item.state = 'conformant'; item.proof = [reference];
      item.source_coverage = 'The complete exact criterion is backed by the referenced native component execution and independently replayed before application.';
      delete item.missing_proof; accepted.push(item.id);
    }
    if (!accepted.length) fail('acceptance report has no completely covered criteria');
    candidate.traceability.evidence_class = 'source_traceability_with_scoped_acceptance';
    references.push(reference);
  }
  const result = await validateQualifiedInventory(candidate, { checkDocs: false, replay: true, pythonByScope, output });
  if (!result.valid) fail(result.errors.join('\n'));
  // Refuse overwriting edits made while the independent processes were running.
  for (const [path, digest] of before) if (sha256(await readFile(resolve(root, path))) !== digest) fail(`inventory changed during qualification: ${path}`);
  for (const reference of references) await artifact(reference.path, reference.sha256);
  const writes = new Map(families.map(family => [`${supportPath}/manifests/${family.id}.json`, encode(candidate.manifests.filter(row => row.family === family.id))]));
  writes.set(`${supportPath}/traceability.json`, encode(candidate.traceability));
  writes.set(matrixPath, renderMatrix(candidate));
  for (const [path, bytes] of writes) {
    if (sha256(bytes) === before.get(path)) continue;
    const target = resolve(root, path), temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, target);
  }
  return { evidence_class: 'applied_scoped_support', promoted_cells: applied.size, accepted_criteria: accepted,
    references, counts: result.counts, completion: result.completion, replay_output: result.replay_output };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  (async () => {
    const options = { promotions: [] };
    for (const argument of process.argv.slice(2)) {
      const match = argument.match(/^--(promotion|acceptance|python-map|replay-output)=(.+)$/s);
      if (!match) fail(`unknown argument ${argument}`);
      if (match[1] === 'promotion') options.promotions.push(match[2]);
      else if (match[1] === 'acceptance') options.acceptance = match[2];
      else if (match[1] === 'replay-output') options.output = match[2];
      else options.pythonByScope = JSON.parse(await readFile(match[2], 'utf8'));
    }
    process.stdout.write(encode(await applyQualifiedSupport(options)));
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
