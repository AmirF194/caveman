/** Exact native CrewAI certification inputs; packaged Python fixtures are self-contained. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
export const testFile = 'examples/middleware/crewai/test_native.py';
export const driver = 'packages/middleware/conformance/python-framework.test.mjs';

export async function certificationInputs() {
  const { root, sha256, json } = await import('../../../packages/middleware/conformance/support/inventory.mjs');
  const { captureNativeCertificationInputs: captureCertificationInputs } = await import('../../../packages/middleware/conformance/support/runtime-build.mjs');
  const { requiredCells } = await import('../../../packages/middleware/conformance/support/catalog.mjs');
  const cells = await json('examples/middleware/crewai/certification-cells.json');
  assert.deepEqual(cells.cells, requiredCells().filter(cell => cell.family === 'F10'));
  const previous = await json('packages/middleware/conformance/support/source-lock.json');
  const sources = new Map(previous.files.filter(file => file.role === 'runtime_source' || file.role === 'contract_schema' ||
    (file.role === 'sdk_source' && file.path.startsWith('packages/sdk/python/'))).map(({ path, role }) => [path, { path, role }]));
  const add = (path, role) => sources.set(path, { path, role });
  for (const name of ['crewai', 'litellm', '_native', '_usage', '_versions', '__init__']) add(`packages/middleware/python/caveman_middleware/${name}.py`, 'adapter_source');
  for (const name of ['test_native.py', 'provider.py', 'demo.py', '_certification_native.py', '_test_result.py', 'certification-evidence.mjs', 'certification-cells.json', 'certify.mjs']) add(`examples/middleware/crewai/${name}`, 'test_source');
  for (const path of [driver, 'packages/middleware/conformance/runtime-fixture.mjs', 'packages/middleware/conformance/evidence_runtime.py',
    'packages/middleware/conformance/support/certify.mjs', 'packages/middleware/conformance/support/catalog.mjs',
    'packages/middleware/conformance/support/inventory.mjs', 'packages/middleware/conformance/support/observations.mjs']) add(path, 'test_source');
  add('examples/middleware/crewai/requirements.lock', 'dependency_lock');
  add('examples/middleware/crewai/requirements.in', 'package_or_fixture');
  const source = await readFile(`${root}/${testFile}`, 'utf8'), tests = [];
  for (const [index, line] of source.split('\n').entries()) {
    const match = line.match(/^\s*async def (test_f10_(?:openai|anthropic)_exact_journeys)\(/); if (!match) continue;
    const name = `CrewAICertification.${match[1]}`;
    tests.push({ id: `${testFile}::${name}`, file: testFile, name, line: index + 1, declaration: `def ${match[1]}(`, sha256: sha256(source),
      evidence_scope: 'source_only', fixture_scope: 'installed_framework_local_fixture_source',
      rerun: { program: 'node', args: ['--test', '--test-reporter=tap', driver], cwd: '.', env: { CAVEMAN_MIDDLEWARE_TEST_FAMILY: 'crewai', CAVEMAN_MIDDLEWARE_CERT_FAMILY: 'F10' } } });
  }
  assert.equal(tests.length, 2);
  const python = process.env.CAVEMAN_MIDDLEWARE_TEST_PYTHON; assert.ok(python, 'Set the exact locked CrewAI environment');
  const names = ['crewai', 'litellm', 'openai', 'anthropic', 'pydantic'];
  const { stdout } = await promisify(execFile)(python, ['-c', 'import importlib.metadata as m,json,sys;print(json.dumps({name:m.version(name) for name in sys.argv[1:]}))', ...names]);
  return captureCertificationInputs({ family: 'F10', language: 'python', sources: [...sources.values()], tests: { schema_version: 1, tests }, binary: process.env.CAVEMAN_MIDDLEWARE_TEST_BINARY, frameworkVersions: JSON.parse(stdout) });
}

export async function beginPythonCertification(t, endpoint) {
  const response = await fetch(`${endpoint}/caveman/v1/middleware/capabilities`); assert.equal(response.status, 200);
  const capabilities = await response.json();
  if (process.env.CAVEMAN_MIDDLEWARE_PACKAGED_TEST === '1') {
    t.diagnostic(`CAVEMAN_MIDDLEWARE_PACKAGED_EXECUTION ${JSON.stringify({ evidence_class: 'installed_artifact_runtime_observation', runtime_build: capabilities.runtime_build, runtime_protocol: capabilities.schema_version })}`); return;
  }
  const { executionObservation, executionPrefix } = await import('../../../packages/middleware/conformance/support/certify.mjs');
  t.diagnostic(`${executionPrefix}${JSON.stringify(executionObservation(await certificationInputs(), capabilities))}`);
}
