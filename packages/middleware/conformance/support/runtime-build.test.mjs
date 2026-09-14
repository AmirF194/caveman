import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { root } from './inventory.mjs';
import { parseGoPackages, runtimeSourcesFromPackages, validateRuntimeBuild } from './runtime-build.mjs';

test('Go dependency parser retains object streams with quoted braces and rejects incomplete data', () => {
  assert.deepEqual(parseGoPackages('{"name":"quoted \\\"} {","rows":[{"n":1}]}\n{"name":"second"}\n'), [
    { name: 'quoted "} {', rows: [{ n: 1 }] }, { name: 'second' },
  ]);
  for (const input of ['', '{"partial":', '[]', '{"ok":1} trailing']) assert.throws(() => parseGoPackages(input));
});

test('actual owned Go inputs include module locks and embedded assets without unrelated source globs', async () => {
  const closure = await runtimeSourcesFromPackages([{ ImportPath: 'fixture/pixel', Dir: resolve(root, 'engine/pixel'),
    Module: { Main: true }, GoFiles: ['atlas.go'], EmbedFiles: ['assets/atlas-pixels.bin.gz', 'assets/atlas-pixels.bin.gz'] }]);
  assert.deepEqual(closure.files.map(file => file.path), ['engine/pixel/assets/atlas-pixels.bin.gz', 'engine/pixel/atlas.go', 'go.mod', 'go.sum']);
  assert.ok(closure.files.every(file => file.role === 'runtime_source' && /^[a-f0-9]{64}$/.test(file.sha256)));
  assert.ok(!closure.files.some(file => file.path.endsWith('_test.go')));
});

test('runtime closure refuses unresolved dependencies and unchecked external modules', async () => {
  await assert.rejects(runtimeSourcesFromPackages([{ ImportPath: 'broken', Error: { Err: 'missing dependency' } }]), /unresolved/);
  await assert.rejects(runtimeSourcesFromPackages([{ ImportPath: 'broken', DepsErrors: [{ Err: 'missing dependency' }] }]), /unresolved/);
  await assert.rejects(runtimeSourcesFromPackages([{ ImportPath: 'unchecked', Module: { Path: 'unchecked', Version: 'v1.0.0' } }]), /unchecked/);
  await assert.rejects(runtimeSourcesFromPackages([{ ImportPath: 'outside', Dir: '/private/tmp', Module: { Main: true }, GoFiles: ['secret.go'] }]), /outside repository/);
});

test('native build proof cannot be supplied by an unreferenced saved success field', async () => {
  await assert.rejects(validateRuntimeBuild({ completed: true }), /missing build provenance/);
  await assert.rejects(validateRuntimeBuild({ path: 'go.mod', sha256: '0'.repeat(64) }), /hash changed/);
});
