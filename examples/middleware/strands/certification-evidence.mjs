/** Exact native F09 input snapshots and observation declarations. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
export const testFile = 'examples/middleware/strands/conformance.test.mjs';
export const pythonFile = 'examples/middleware/strands/test_native.py';
export const driver = 'packages/middleware/conformance/python-framework.test.mjs';
const require = createRequire(import.meta.url);
async function nodeVersion(name) {
  let directory = dirname(require.resolve(name));
  for (;;) {
    const metadata = await readFile(resolve(directory, 'package.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (metadata?.name === name) return metadata.version;
    const parent = dirname(directory); assert.notEqual(parent, directory); directory = parent;
  }
}
export async function certificationInputs(language = 'typescript') {
  const { root, json, sha256 } = await import('../../../packages/middleware/conformance/support/inventory.mjs');
  const { requiredCells } = await import('../../../packages/middleware/conformance/support/catalog.mjs');
  const { declaredNodeTests } = await import('../../../packages/middleware/conformance/support/certify.mjs');
  const { captureNativeCertificationInputs } = await import('../../../packages/middleware/conformance/support/runtime-build.mjs');
  const fixture = await json('examples/middleware/strands/certification-cells.json');
  assert.deepEqual(fixture.cells, requiredCells().filter(cell => cell.family === 'F09'));
  const files = language === 'typescript' ? ['conformance.test.mjs', 'certification-native.mjs', 'certification-provider.mjs', 'upstream-native.mjs']
    : ['test_native.py', '_certification_native.py', '_certification_provider.py', '_test_result.py'];
  const sources = [...files, 'certification-evidence.mjs', 'certification-cells.json', 'certify.mjs']
    .map(name => ({ path: `examples/middleware/strands/${name}`, role: 'test_source' }));
  sources.push(...['packages/middleware/conformance/runtime-fixture.mjs', 'packages/middleware/conformance/support/certify.mjs',
    'packages/middleware/conformance/support/catalog.mjs', 'packages/middleware/conformance/support/inventory.mjs',
    'packages/middleware/conformance/support/observations.mjs', ...(language === 'python' ? [driver, 'packages/middleware/conformance/python_fixture.py', 'packages/middleware/conformance/evidence_runtime.py'] : [])]
    .map(path => ({ path, role: 'test_source' })));
  const frameworkVersions = {}; let tests;
  if (language === 'typescript') {
    const lock = await json('examples/middleware/strands/package-lock.json');
    for (const name of ['@strands-agents/sdk', 'openai', '@anthropic-ai/sdk', '@aws-sdk/client-bedrock-runtime']) {
      frameworkVersions[name] = await nodeVersion(name);
      assert.equal(lock.packages[`node_modules/${name}`].version, frameworkVersions[name], `Installed ${name} matches the actual native lock`);
    }
    tests = await declaredNodeTests([testFile], { namePrefix: 'Strands F09 ' }); assert.equal(tests.tests.length, 21);
  } else {
    const python = process.env.CAVEMAN_MIDDLEWARE_TEST_PYTHON; assert.ok(python);
    const names = ['strands-agents', 'openai', 'anthropic', 'boto3', 'botocore', 'pydantic'];
    const { stdout } = await promisify(execFile)(python, ['-c', 'import importlib.metadata as m,json,sys;print(json.dumps({n:m.version(n) for n in sys.argv[1:]}))', ...names]);
    Object.assign(frameworkVersions, JSON.parse(stdout));
    const source = await readFile(resolve(root, pythonFile), 'utf8'), name = 'AsyncNativeStrands.test_certifies_exact_f09_native_operations';
    const line = source.split('\n').findIndex(value => value.includes('async def test_certifies_exact_f09_native_operations(')) + 1; assert.ok(line);
    tests = { schema_version: 1, tests: [{ id: `${pythonFile}::${name}`, file: pythonFile, name, line,
      declaration: 'def test_certifies_exact_f09_native_operations(', sha256: sha256(source), evidence_scope: 'source_only', fixture_scope: 'installed_framework_local_fixture_source',
      rerun: { program: 'node', args: ['--test', '--test-reporter=tap', driver], cwd: '.', env: { CAVEMAN_MIDDLEWARE_TEST_FAMILY: 'strands', CAVEMAN_MIDDLEWARE_TEST_PYTHON: '<exact locked Strands environment>' } } }] };
  }
  return captureNativeCertificationInputs({ family: 'F09', language, sources, tests, binary: process.env.CAVEMAN_MIDDLEWARE_TEST_BINARY, frameworkVersions });
}
let emitted = false;
export async function beginNativeCertification(t, capabilities, language = 'typescript') {
  if (language === 'typescript' && emitted) return;
  if (process.env.CAVEMAN_MIDDLEWARE_UNCAPTURED_TEST === '1') t.diagnostic(`CAVEMAN_MIDDLEWARE_UNCAPTURED_NATIVE ${JSON.stringify({ family: 'F09', language, runtime_build: capabilities.runtime_build })}`);
  else if (process.env.CAVEMAN_MIDDLEWARE_PACKAGED_TEST === '1') t.diagnostic(`CAVEMAN_MIDDLEWARE_PACKAGED_EXECUTION ${JSON.stringify({ evidence_class: 'installed_artifact_runtime_observation', runtime_build: capabilities.runtime_build, runtime_protocol: capabilities.schema_version })}`);
  else {
    const { executionObservation, executionPrefix } = await import('../../../packages/middleware/conformance/support/certify.mjs');
    t.diagnostic(`${executionPrefix}${JSON.stringify(executionObservation(await certificationInputs(language), capabilities))}`);
  }
  if (language === 'typescript') emitted = true;
}
export async function beginPythonCertification(t, endpoint) {
  const response = await fetch(`${endpoint}/caveman/v1/middleware/capabilities`); assert.equal(response.status, 200);
  await beginNativeCertification(t, await response.json(), 'python');
}
export function emitJourney(t, cell, observations) {
  for (const [assertion, observation] of Object.entries(observations)) t.diagnostic(`CAVEMAN_MIDDLEWARE_OBSERVATION ${JSON.stringify({ cell_id: cell.id, test_id: `${testFile}::${t.name}`, assertion, observation })}`);
}
