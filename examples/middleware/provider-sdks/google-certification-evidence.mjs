/** Exact F03 TypeScript inputs from native Google SDK declarations. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

export const testFile = 'examples/middleware/provider-sdks/google.test.mjs';
const require = createRequire(import.meta.url);
async function installedVersion(name) {
  let directory = dirname(require.resolve(name));
  for (;;) {
    const metadata = await readFile(resolve(directory, 'package.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (metadata?.name === name) return metadata.version;
    const parent = dirname(directory); if (parent === directory) throw new Error(`Cannot locate installed ${name}`); directory = parent;
  }
}
export async function certificationInputs() {
  const { json } = await import('../../../packages/middleware/conformance/support/inventory.mjs');
  const { captureNativeCertificationInputs: captureCertificationInputs } = await import('../../../packages/middleware/conformance/support/runtime-build.mjs');
  const { declaredNodeTests } = await import('../../../packages/middleware/conformance/support/certify.mjs');
  const { requiredCells } = await import('../../../packages/middleware/conformance/support/catalog.mjs');
  const fixture = await json('examples/middleware/provider-sdks/google-certification-cells.json');
  assert.deepEqual(fixture.cells, requiredCells().filter(cell => cell.family === 'F03' && cell.language === 'typescript'));
  const sources = new Map();
  const add = (path, role) => sources.set(path, { path, role });
  for (const name of ['google', 'wire', 'common', 'versions']) { add(`packages/middleware/typescript/src/${name}.ts`, 'adapter_source'); add(`packages/middleware/typescript/dist/${name}.js`, 'executed_module'); }
  for (const name of ['index', 'runtime', 'types', 'validate']) add(`packages/sdk/typescript/dist/middleware/${name}.js`, 'executed_module');
  for (const name of ['google.test.mjs', 'google-certification-native.mjs', 'google-certification-evidence.mjs', 'google-certification-cells.json']) add(`examples/middleware/provider-sdks/${name}`, 'test_source');
  for (const path of ['examples/middleware/google/certify.mjs', 'packages/middleware/conformance/runtime-fixture.mjs', 'packages/middleware/conformance/support/certify.mjs',
    'packages/middleware/conformance/support/catalog.mjs', 'packages/middleware/conformance/support/inventory.mjs', 'packages/middleware/conformance/support/observations.mjs']) add(path, 'test_source');
  add('examples/middleware/provider-sdks/package-lock.json', 'dependency_lock'); add('examples/middleware/provider-sdks/package.json', 'package_or_fixture');
  const frameworkVersions = {};
  for (const name of ['@google/genai', 'google-auth-library']) frameworkVersions[name] = await installedVersion(name);
  return captureCertificationInputs({ family: 'F03', language: 'typescript', sources: [...sources.values()],
    tests: await declaredNodeTests([testFile], { namePrefix: 'F03 native ' }), binary: process.env.CAVEMAN_MIDDLEWARE_TEST_BINARY, frameworkVersions });
}

let emitted = false;
export async function beginNativeCertification(t, capabilities) {
  if (emitted) return;
  if (process.env.CAVEMAN_MIDDLEWARE_PACKAGED_TEST === '1') {
    t.diagnostic(`CAVEMAN_MIDDLEWARE_PACKAGED_EXECUTION ${JSON.stringify({ evidence_class: 'installed_artifact_runtime_observation', runtime_build: capabilities.runtime_build, runtime_protocol: capabilities.schema_version })}`);
  } else {
    const { executionObservation, executionPrefix } = await import('../../../packages/middleware/conformance/support/certify.mjs');
    t.diagnostic(`${executionPrefix}${JSON.stringify(executionObservation(await certificationInputs(), capabilities))}`);
  }
  emitted = true;
}
export function emitJourney(t, cell, journey) {
  for (const [assertion, observation] of Object.entries(journey))
    t.diagnostic(`CAVEMAN_MIDDLEWARE_OBSERVATION ${JSON.stringify({ cell_id: cell.id, test_id: `${testFile}::${t.name}`, assertion, observation })}`);
}
