/** Exact installed ASGI inputs and literal native test identities. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { root, sha256, json } from '../../../packages/middleware/conformance/support/inventory.mjs';
import { captureNativeCertificationInputs } from '../../../packages/middleware/conformance/support/runtime-build.mjs';
import { requiredCells } from '../../../packages/middleware/conformance/support/catalog.mjs';
import { executionObservation, executionPrefix } from '../../../packages/middleware/conformance/support/certify.mjs';

export const testFile = 'examples/middleware/asgi/test_native.py';
export const driver = 'packages/middleware/conformance/python-framework.test.mjs';
export async function certificationInputs() {
  const fixture = await json('examples/middleware/asgi/certification-cells.json');
  assert.deepEqual(fixture.cells, requiredCells().filter(cell => cell.family === 'F12'));
  const sources = [];
  for (const name of ['test_native.py', '_certification_native.py', '_test_result.py', 'certification-evidence.mjs', 'certification-cells.json', 'certify.mjs'])
    sources.push({ path: `examples/middleware/asgi/${name}`, role: 'test_source' });
  for (const path of [driver, 'packages/middleware/conformance/evidence_runtime.py', 'packages/middleware/conformance/runtime-fixture.mjs', 'examples/middleware/python-provider-sdks/_http_fixture.py']) sources.push({ path, role: 'test_source' });
  const source = await readFile(`${root}/${testFile}`, 'utf8'), tests = [];
  for (const [index, line] of source.split('\n').entries()) {
    const match = line.match(/^\s*async def (test_(?:openai_chat|openai_responses|anthropic)_exact_operation_journeys)\(/);
    if (!match) continue;
    const name = `NativeASGICertification.${match[1]}`;
    tests.push({ id: `${testFile}::${name}`, file: testFile, name, line: index + 1, declaration: `def ${match[1]}(`,
      sha256: sha256(source), evidence_scope: 'source_only', fixture_scope: 'installed_framework_local_fixture_source',
      rerun: { program: 'node', args: ['--test', '--test-reporter=tap', driver], cwd: '.',
        env: { CAVEMAN_MIDDLEWARE_TEST_FAMILY: 'asgi', CAVEMAN_MIDDLEWARE_TEST_PYTHON: '<exact locked ASGI environment>' } } });
  }
  assert.equal(tests.length, 3);
  const python = process.env.CAVEMAN_MIDDLEWARE_TEST_PYTHON; assert.ok(python);
  const names = ['fastapi', 'starlette', 'uvicorn', 'openai', 'anthropic', 'httpx2', 'pydantic'];
  const { stdout } = await promisify(execFile)(python, ['-c', 'import importlib.metadata as m, json, sys; print(json.dumps({name:m.version(name) for name in sys.argv[1:]}))', ...names]);
  return captureNativeCertificationInputs({ family: 'F12', language: 'python', sources, tests: { schema_version: 1, tests },
    binary: process.env.CAVEMAN_MIDDLEWARE_TEST_BINARY, frameworkVersions: JSON.parse(stdout) });
}

export async function beginPythonCertification(t, endpoint) {
  const response = await fetch(`${endpoint}/caveman/v1/middleware/capabilities`); assert.equal(response.status, 200);
  const capabilities = await response.json();
  if (process.env.CAVEMAN_MIDDLEWARE_PACKAGED_TEST === '1') {
    t.diagnostic(`CAVEMAN_MIDDLEWARE_PACKAGED_EXECUTION ${JSON.stringify({ evidence_class: 'installed_artifact_runtime_observation', runtime_build: capabilities.runtime_build, runtime_protocol: capabilities.schema_version })}`);
    return;
  }
  t.diagnostic(`${executionPrefix}${JSON.stringify(executionObservation(await certificationInputs(), capabilities))}`);
}
