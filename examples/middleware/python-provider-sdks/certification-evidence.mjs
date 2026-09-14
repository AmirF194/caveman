/** Exact inputs from the installed Python SDK environment and native unittest declarations. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { root, sha256, json } from '../../../packages/middleware/conformance/support/inventory.mjs';
import { executionObservation, executionPrefix } from '../../../packages/middleware/conformance/support/certify.mjs';
import { captureNativeCertificationInputs as captureCertificationInputs } from '../../../packages/middleware/conformance/support/runtime-build.mjs';

export const testFile = 'examples/middleware/python-provider-sdks/test_providers.py';
export const driver = 'packages/middleware/conformance/python-provider.test.mjs';

export async function certificationInputs(family = process.env.CAVEMAN_MIDDLEWARE_CERT_FAMILY ?? 'F01') {
  assert.ok(['F01', 'F02'].includes(family));
  const previous = await json('packages/middleware/conformance/support/source-lock.json');
  const sources = new Map(previous.files.filter(file => file.role === 'runtime_source' || file.role === 'contract_schema' ||
    (file.role === 'sdk_source' && file.path.startsWith('packages/sdk/python/'))).map(({ path, role }) => [path, { path, role }]));
  const add = (path, role) => sources.set(path, { path, role });
  for (const name of ['openai', 'anthropic', '_httpx2', '_native', '_usage', '_versions', '_streams', '__init__'])
    add(`packages/middleware/python/caveman_middleware/${name}.py`, 'adapter_source');
  for (const name of ['test_providers.py', 'test_native.py', '_http_fixture.py', '_certification_native.py', '_test_result.py',
    'certification-evidence.mjs', 'certify.mjs']) add(`examples/middleware/python-provider-sdks/${name}`, 'test_source');
  for (const path of [driver, 'packages/middleware/conformance/runtime-fixture.mjs', 'packages/middleware/conformance/support/certify.mjs',
    'packages/middleware/conformance/support/catalog.mjs', 'packages/middleware/conformance/support/inventory.mjs',
    'packages/middleware/conformance/support/observations.mjs']) add(path, 'test_source');
  add('examples/middleware/python-provider-sdks/requirements.lock', 'dependency_lock');
  add('examples/middleware/python-provider-sdks/requirements.in', 'package_or_fixture');
  const source = await readFile(`${root}/${testFile}`, 'utf8'), tests = [];
  const namePrefix = family === 'F01' ? 'test_openai_f01_' : 'test_anthropic_f02_';
  for (const [index, line] of source.split('\n').entries()) {
    const match = line.match(/^\s*async def (test_\w+)\(/);
    if (!match?.[1].startsWith(namePrefix)) continue;
    const name = `ProviderJourney.${match[1]}`;
    tests.push({ id: `${testFile}::${name}`, file: testFile, name, line: index + 1,
      declaration: `def ${match[1]}(`, sha256: sha256(source), evidence_scope: 'source_only',
      fixture_scope: 'installed_framework_local_fixture_source',
      rerun: { program: 'node', args: ['--test', '--test-reporter=tap', driver], cwd: '.',
        env: { CAVEMAN_MIDDLEWARE_CERT_FAMILY: family, CAVEMAN_MIDDLEWARE_TEST_PYTHON: '<exact locked provider environment>' } } });
  }
  assert.equal(tests.length, 2);
  const names = [family === 'F01' ? 'openai' : 'anthropic', 'httpx2', 'httpcore2', 'pydantic'];
  const python = process.env.CAVEMAN_MIDDLEWARE_TEST_PYTHON;
  assert.ok(python, 'Set the exact locked Python SDK environment');
  const { stdout } = await promisify(execFile)(python, ['-c', 'import importlib.metadata as m, json, sys; print(json.dumps({name:m.version(name) for name in sys.argv[1:]}))', ...names]);
  return captureCertificationInputs({ family, language: 'python', sources: [...sources.values()],
    tests: { schema_version: 1, tests }, binary: process.env.CAVEMAN_MIDDLEWARE_TEST_BINARY,
    frameworkVersions: JSON.parse(stdout) });
}

export async function beginPythonCertification(t, endpoint) {
  const response = await fetch(`${endpoint}/caveman/v1/middleware/capabilities`);
  assert.equal(response.status, 200);
  const capabilities = await response.json();
  if (process.env.CAVEMAN_MIDDLEWARE_PACKAGED_TEST === '1') {
    t.diagnostic(`CAVEMAN_MIDDLEWARE_PACKAGED_EXECUTION ${JSON.stringify({ evidence_class: 'installed_artifact_runtime_observation', runtime_build: capabilities.runtime_build, runtime_protocol: capabilities.schema_version })}`);
    return;
  }
  process.env.CAVEMAN_MIDDLEWARE_CERT_FAMILY ??= 'F01';
  const input = await certificationInputs();
  t.diagnostic(`${executionPrefix}${JSON.stringify(executionObservation(input, capabilities))}`);
}
