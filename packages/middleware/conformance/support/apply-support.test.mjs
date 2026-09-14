import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { applyQualifiedSupport } from './apply-support.mjs';
import { root, supportPath, matrixPath, sha256 } from './inventory.mjs';
import { families } from './catalog.mjs';

const tracked = [matrixPath, `${supportPath}/traceability.json`,
  ...families.map(family => `${supportPath}/manifests/${family.id}.json`)];
const hashes = () => Promise.all(tracked.map(async path => [path, sha256(await readFile(resolve(root, path)))]));

test('invalid support candidates fail before any shared manifest or matrix write', async t => {
  const parent = resolve(root, '.artifacts/middleware-support');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(resolve(parent, 'apply-rejections-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const before = await hashes();
  const save = async (name, value) => {
    const path = resolve(directory, name);
    await writeFile(path, JSON.stringify(value));
    return relative(root, path);
  };

  await assert.rejects(applyQualifiedSupport({}), /supply at least one/);
  await assert.rejects(applyQualifiedSupport({ promotions: ['/tmp/untrusted.json'] }), /repository-relative/);
  await assert.rejects(applyQualifiedSupport({ promotions: ['../untrusted.json'] }), /repository-relative/);
  const forgedPromotion = await save('forged-promotion.json', {
    producer: 'caveman-middleware-scoped-promotion-v1',
    evidence_class: 'reviewable_native_support_promotion',
    shared_inventory_mutated: false, live_provider_promotions: 1, acceptance_items: [],
  });
  await assert.rejects(applyQualifiedSupport({ promotions: [forgedPromotion] }), /wrong scoped promotion class/);

  const partial = await save('partial-acceptance.json', {
    producer: 'caveman-middleware-shared-acceptance-v1',
    evidence_class: 'shared_go_acceptance_component_candidate', support_promotion: false,
    criteria: [{ id: 'runtime.R6.AC02', status: 'partial', remaining: ['Missing process restart.'] }],
  });
  await assert.rejects(applyQualifiedSupport({ acceptance: partial }), /no completely covered criteria/);
  const unknown = await save('unknown-acceptance.json', {
    producer: 'caveman-middleware-shared-acceptance-v1',
    evidence_class: 'shared_go_acceptance_component_candidate', support_promotion: false,
    criteria: [{ id: 'invented.R1.AC01', status: 'covered', components: [] }],
  });
  await assert.rejects(applyQualifiedSupport({ acceptance: unknown }), /unknown or duplicate acceptance criterion/);
  assert.deepEqual(await hashes(), before);
});
