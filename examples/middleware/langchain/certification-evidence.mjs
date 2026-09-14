/** Exact, family-local input snapshots. Installed artifact runs need no repository imports. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const driver = 'packages/middleware/conformance/python-framework.test.mjs';
export const testFiles = { python: 'examples/middleware/langchain/test_native.py', typescript: 'examples/middleware/langchain/conformance.test.mjs' };
export const selectedFamily = process.env.CAVEMAN_MIDDLEWARE_CERT_FAMILY ?? 'F05';
export const packaged = process.env.CAVEMAN_MIDDLEWARE_PACKAGED_TEST === '1';
const require = createRequire(import.meta.url);
export const fixtureCells = JSON.parse(await readFile(new URL('./certification-cells.json', import.meta.url), 'utf8')).cells;

async function installedVersion(name) {
  let directory = dirname(require.resolve(name));
  for (;;) {
    const metadata = await readFile(resolve(directory, 'package.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (metadata?.name === name) return metadata.version;
    const parent = dirname(directory); assert.notEqual(parent, directory, `Missing installed ${name}`); directory = parent;
  }
}

export async function certificationInputs(family = selectedFamily, language = 'typescript') {
  assert.ok(['F05', 'F06'].includes(family)); assert.ok(['python', 'typescript'].includes(language));
  const { root, sha256, json } = await import('../../../packages/middleware/conformance/support/inventory.mjs');
  const { declaredNodeTests } = await import('../../../packages/middleware/conformance/support/certify.mjs');
  const { captureNativeCertificationInputs: captureCertificationInputs } = await import('../../../packages/middleware/conformance/support/runtime-build.mjs');
  const { requiredCells } = await import('../../../packages/middleware/conformance/support/catalog.mjs');
  assert.deepEqual(fixtureCells, requiredCells().filter(cell => ['F05', 'F06'].includes(cell.family)));
  const previous = await json('packages/middleware/conformance/support/source-lock.json');
  const sources = new Map(previous.files.filter(file => file.role === 'runtime_source' || file.role === 'contract_schema' ||
    (file.role === 'sdk_source' && file.path.startsWith(`packages/sdk/${language}/`))).map(({ path, role }) => [path, { path, role }]));
  const add = (path, role) => sources.set(path, { path, role });
  const shared = ['certification-evidence.mjs', 'certify.mjs', 'certification-cells.json'];
  for (const name of shared) add(`examples/middleware/langchain/${name}`, 'test_source');
  for (const name of ['certify.mjs', 'catalog.mjs', 'inventory.mjs', 'observations.mjs']) add(`packages/middleware/conformance/support/${name}`, 'test_source');
  add('packages/middleware/conformance/runtime-fixture.mjs', 'test_source');
  let tests, frameworkVersions;
  if (language === 'typescript') {
    for (const name of ['langchain', 'langchain-model', 'common', 'versions']) {
      add(`packages/middleware/typescript/src/${name}.ts`, 'adapter_source');
      add(`packages/middleware/typescript/dist/${name}.js`, 'executed_module');
    }
    for (const name of ['index', 'runtime', 'types', 'validate']) add(`packages/sdk/typescript/dist/middleware/${name}.js`, 'executed_module');
    for (const name of ['conformance.test.mjs', 'source-expansion.test.mjs', 'certification-native.mjs']) add(`examples/middleware/langchain/${name}`, 'test_source');
    add('examples/middleware/langchain/package-lock.json', 'dependency_lock');
    add('examples/middleware/langchain/package.json', 'package_or_fixture');
    tests = await declaredNodeTests([testFiles.typescript], { namePrefix: `LangChain ${family} ` });
    frameworkVersions = {};
    for (const name of ['langchain', '@langchain/core', '@langchain/langgraph', '@langchain/openai', '@langchain/anthropic']) frameworkVersions[name] = await installedVersion(name);
  } else {
    for (const name of ['langchain', '_native', '_usage', '_versions', '_streams', '__init__']) add(`packages/middleware/python/caveman_middleware/${name}.py`, 'adapter_source');
    for (const name of ['test_native.py', 'test_source_expansion.py', '_certification_native.py', '_certification_fixture.py', '_test_result.py']) add(`examples/middleware/langchain/${name}`, 'test_source');
    for (const path of [driver, 'packages/middleware/conformance/python_fixture.py', 'examples/middleware/python-provider-sdks/test_providers.py']) add(path, 'test_source');
    add('examples/middleware/langchain/requirements.lock', 'dependency_lock');
    add('examples/middleware/langchain/requirements.in', 'package_or_fixture');
    const source = await readFile(resolve(root, testFiles.python), 'utf8'), rows = [];
    for (const [index, line] of source.split('\n').entries()) {
      const match = line.match(/^\s*async def (test_f0[56]_(?:openai|anthropic)_exact_journeys)\(/);
      if (!match || !match[1].startsWith(`test_${family.toLowerCase()}_`)) continue;
      const name = `LangChainCertification.${match[1]}`;
      rows.push({ id: `${testFiles.python}::${name}`, file: testFiles.python, name, line: index + 1, declaration: `def ${match[1]}(`,
        sha256: sha256(source), evidence_scope: 'source_only', fixture_scope: 'installed_framework_local_fixture_source',
        rerun: { program: 'node', args: ['--test', '--test-reporter=tap', driver], cwd: '.', env: { CAVEMAN_MIDDLEWARE_TEST_FAMILY: 'langchain', CAVEMAN_MIDDLEWARE_CERT_FAMILY: family } } });
    }
    tests = { schema_version: 1, tests: rows };
    const python = process.env.CAVEMAN_MIDDLEWARE_TEST_PYTHON; assert.ok(python, 'Set the exact locked LangChain Python environment');
    const names = ['langchain', 'langchain-core', 'langgraph', 'langchain-openai', 'langchain-anthropic'];
    const { stdout } = await promisify(execFile)(python, ['-c', 'import importlib.metadata as m,json,sys;print(json.dumps({name:m.version(name) for name in sys.argv[1:]}))', ...names]);
    frameworkVersions = JSON.parse(stdout);
  }
  assert.equal(tests.tests.length, 2, 'Two literal provider journey tests are required');
  return captureCertificationInputs({ family, language, sources: [...sources.values()], tests, binary: process.env.CAVEMAN_MIDDLEWARE_TEST_BINARY, frameworkVersions });
}

let emitted = false;
export async function beginNativeCertification(t, capabilities, language = 'typescript') {
  if (emitted) return;
  assert.ok(capabilities.runtime_build); assert.equal(capabilities.schema_version, 1);
  if (packaged) t.diagnostic(`CAVEMAN_MIDDLEWARE_PACKAGED_EXECUTION ${JSON.stringify({ evidence_class: 'installed_artifact_runtime_observation', runtime_build: capabilities.runtime_build, runtime_protocol: capabilities.schema_version })}`);
  else {
    const { executionObservation, executionPrefix } = await import('../../../packages/middleware/conformance/support/certify.mjs');
    t.diagnostic(`${executionPrefix}${JSON.stringify(executionObservation(await certificationInputs(selectedFamily, language), capabilities))}`);
  }
  emitted = true;
}
export async function beginPythonCertification(t, endpoint) {
  const response = await fetch(`${endpoint}/caveman/v1/middleware/capabilities`); assert.equal(response.status, 200);
  await beginNativeCertification(t, await response.json(), 'python');
}
export function emitJourney(t, cell, journey) {
  assert.ok(fixtureCells.some(row => row.id === cell.id));
  for (const [assertion, observation] of Object.entries(journey)) t.diagnostic(`CAVEMAN_MIDDLEWARE_OBSERVATION ${JSON.stringify({ cell_id: cell.id, test_id: `${testFiles.typescript}::${t.name}`, assertion, observation })}`);
}
