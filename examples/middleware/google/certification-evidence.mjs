/** Frozen inputs for native Python Google/Vertex operation tests. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';

export const testFile = 'examples/middleware/google/test_native.py';
export const driver = 'packages/middleware/conformance/python-framework.test.mjs';
export async function certificationInputs() {
  const { root, sha256, json } = await import('../../../packages/middleware/conformance/support/inventory.mjs');
  const { captureNativeCertificationInputs: captureCertificationInputs } = await import('../../../packages/middleware/conformance/support/runtime-build.mjs');
  const { requiredCells } = await import('../../../packages/middleware/conformance/support/catalog.mjs');
  const fixture = await json('examples/middleware/google/certification-cells.json');
  assert.deepEqual(fixture.cells, requiredCells().filter(cell => cell.family === 'F03' && cell.language === 'python'));
  const sources = new Map();
  const add = (path, role) => sources.set(path, { path, role });
  for (const name of ['google', '_google_wire', '_native', '_usage', '_versions', '__init__']) add(`packages/middleware/python/caveman_middleware/${name}.py`, 'adapter_source');
  for (const name of ['test_native.py', 'example.py', '_certification_native.py', '_certification_fixture.py', '_test_result.py', 'certification-evidence.mjs', 'certification-cells.json', 'certify.mjs'])
    add(`examples/middleware/google/${name}`, 'test_source');
  for (const path of [driver, 'packages/middleware/conformance/runtime-fixture.mjs', 'packages/middleware/conformance/python_fixture.py', 'packages/middleware/conformance/evidence_runtime.py',
    'packages/middleware/conformance/support/certify.mjs', 'packages/middleware/conformance/support/catalog.mjs', 'packages/middleware/conformance/support/inventory.mjs', 'packages/middleware/conformance/support/observations.mjs']) add(path, 'test_source');
  add('examples/middleware/python-provider-sdks/requirements.lock', 'dependency_lock');
  const source = await readFile(`${root}/${testFile}`, 'utf8'), tests = [];
  for (const [index, line] of source.split('\n').entries()) {
    const match = line.match(/^\s*async def (test_(?:google|vertex)_(?:sync|async)_exact_operation_journeys)\(/);
    if (!match) continue;
    const name = `GoogleCertification.${match[1]}`;
    tests.push({ id: `${testFile}::${name}`, file: testFile, name, line: index + 1, declaration: `def ${match[1]}(`, sha256: sha256(source),
      evidence_scope: 'source_only', fixture_scope: 'installed_framework_local_fixture_source',
      rerun: { program: 'node', args: ['--test', '--test-reporter=tap', driver], cwd: '.', env: { CAVEMAN_MIDDLEWARE_TEST_FAMILY: 'google', CAVEMAN_MIDDLEWARE_TEST_PYTHON: '<exact locked Google SDK environment>' } } });
  }
  assert.equal(tests.length, 4);
  const python = process.env.CAVEMAN_MIDDLEWARE_TEST_PYTHON; assert.ok(python);
  const names = ['google-genai', 'google-auth', 'httpx', 'httpx2', 'pydantic'];
  const { stdout } = await promisify(execFile)(python, ['-c', 'import importlib.metadata as m, json, sys; print(json.dumps({name:m.version(name) for name in sys.argv[1:]}))', ...names]);
  return captureCertificationInputs({ family: 'F03', language: 'python', sources: [...sources.values()], tests: { schema_version: 1, tests },
    binary: process.env.CAVEMAN_MIDDLEWARE_TEST_BINARY, frameworkVersions: JSON.parse(stdout) });
}

export async function beginPythonCertification(t, endpoint) {
  const response = await fetch(`${endpoint}/caveman/v1/middleware/capabilities`); assert.equal(response.status, 200);
  const capabilities = await response.json();
  if (process.env.CAVEMAN_MIDDLEWARE_PACKAGED_TEST === '1') {
    t.diagnostic(`CAVEMAN_MIDDLEWARE_PACKAGED_EXECUTION ${JSON.stringify({ evidence_class: 'installed_artifact_runtime_observation', runtime_build: capabilities.runtime_build, runtime_protocol: capabilities.schema_version })}`);
    return;
  }
  const { executionObservation, executionPrefix } = await import('../../../packages/middleware/conformance/support/certify.mjs');
  t.diagnostic(`${executionPrefix}${JSON.stringify(executionObservation(await certificationInputs(), capabilities))}`);
}
