/** Exact F01/F02 native inputs and observations; no support promotion. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
export const testFile = family => `examples/middleware/provider-sdks/${family === 'F01' ? 'openai' : 'anthropic'}.test.mjs`;
async function installedVersion(name) {
  let directory = dirname(require.resolve(name));
  for (;;) {
    const metadata = await readFile(resolve(directory, 'package.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (metadata?.name === name) return metadata.version;
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Cannot identify installed ${name}`);
    directory = parent;
  }
}

export async function certificationInputs(family = process.env.CAVEMAN_MIDDLEWARE_CERT_FAMILY ?? 'F01') {
  assert.ok(['F01', 'F02'].includes(family));
  const { json } = await import('../../../packages/middleware/conformance/support/inventory.mjs');
  const { declaredNodeTests } = await import('../../../packages/middleware/conformance/support/certify.mjs');
  const { captureNativeCertificationInputs: captureCertificationInputs } = await import('../../../packages/middleware/conformance/support/runtime-build.mjs');
  const previous = await json('packages/middleware/conformance/support/source-lock.json');
  const sources = new Map(previous.files.filter(file => file.role === 'runtime_source' || file.role === 'contract_schema' ||
    (file.role === 'sdk_source' && file.path.startsWith('packages/sdk/typescript/'))).map(({ path, role }) => [path, { path, role }]));
  const add = (path, role) => sources.set(path, { path, role });
  for (const name of ['openai', 'anthropic', 'transport', 'provider-leaves', 'common', 'versions']) {
    add(`packages/middleware/typescript/src/${name}.ts`, 'adapter_source');
    add(`packages/middleware/typescript/dist/${name}.js`, 'executed_module');
  }
  for (const name of ['index', 'runtime', 'types', 'validate']) add(`packages/sdk/typescript/dist/middleware/${name}.js`, 'executed_module');
  for (const name of ['openai.test.mjs', 'anthropic.test.mjs', 'native-fixture.mjs', 'certification-native.mjs', 'certification-evidence.mjs', 'certification-cells.json', 'certify.mjs'])
    add(`examples/middleware/provider-sdks/${name}`, 'test_source');
  for (const path of ['packages/middleware/conformance/runtime-fixture.mjs', 'packages/middleware/conformance/support/certify.mjs',
    'packages/middleware/conformance/support/catalog.mjs', 'packages/middleware/conformance/support/inventory.mjs',
    'packages/middleware/conformance/support/observations.mjs']) add(path, 'test_source');
  add('examples/middleware/provider-sdks/package-lock.json', 'dependency_lock');
  add('examples/middleware/provider-sdks/package.json', 'package_or_fixture');
  const frameworkVersions = {};
  for (const name of ['openai', '@anthropic-ai/sdk']) frameworkVersions[name] = await installedVersion(name);
  return captureCertificationInputs({ family, language: 'typescript', sources: [...sources.values()],
    tests: await declaredNodeTests([testFile(family)], { namePrefix: `${family} native ` }),
    binary: process.env.CAVEMAN_MIDDLEWARE_TEST_BINARY, frameworkVersions });
}

export async function beginNativeCertification(t, family, capabilities) {
  if (process.env.CAVEMAN_MIDDLEWARE_PACKAGED_TEST === '1') {
    t.diagnostic(`CAVEMAN_MIDDLEWARE_PACKAGED_EXECUTION ${JSON.stringify({ evidence_class: 'installed_artifact_runtime_observation', runtime_build: capabilities.runtime_build, runtime_protocol: capabilities.schema_version })}`);
    return;
  }
  const { executionObservation, executionPrefix } = await import('../../../packages/middleware/conformance/support/certify.mjs');
  t.diagnostic(`${executionPrefix}${JSON.stringify(executionObservation(await certificationInputs(family), capabilities))}`);
}

export function emitJourney(t, cell, journey) {
  for (const [assertion, observation] of Object.entries(journey))
    t.diagnostic(`CAVEMAN_MIDDLEWARE_OBSERVATION ${JSON.stringify({ cell_id: cell.id, test_id: `${testFile(cell.family)}::${t.name}`, assertion, observation })}`);
}
