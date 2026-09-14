/** Exact F13 native observations. Candidates never promote support by themselves. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

export const testFile = 'examples/middleware/mcp/conformance.test.mjs';
export const pythonFile = 'examples/middleware/mcp/test_native.py';
export const driver = 'packages/middleware/conformance/python-framework.test.mjs';
const require = createRequire(import.meta.url);
async function nodeVersion(name) {
  let directory = dirname(require.resolve(name === '@modelcontextprotocol/sdk' ? `${name}/client/index.js` : name));
  for (;;) {
    const metadata = await readFile(resolve(directory, 'package.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (metadata?.name === name) return metadata.version;
    const parent = dirname(directory); assert.notEqual(parent, directory, `Cannot find installed ${name}`); directory = parent;
  }
}
export async function certificationInputs(language = 'typescript') {
  const { root, sha256, json } = await import('../../../packages/middleware/conformance/support/inventory.mjs');
  const { requiredCells } = await import('../../../packages/middleware/conformance/support/catalog.mjs');
  const { declaredNodeTests } = await import('../../../packages/middleware/conformance/support/certify.mjs');
  const { captureNativeCertificationInputs } = await import('../../../packages/middleware/conformance/support/runtime-build.mjs');
  const fixture = await json('examples/middleware/mcp/certification-cells.json');
  assert.deepEqual(fixture.cells, requiredCells().filter(cell => cell.family === 'F13'));
  const sources = new Map(), add = (path, role) => sources.set(path, { path, role });
  const files = language === 'typescript' ? ['conformance.test.mjs', 'example.mjs', '_client.mjs', '_provider.mjs', 'certification-native.mjs']
    : ['test_native.py', 'example.py', '_client.py', '_certification_native.py', '_certification_provider.py', '_test_result.py'];
  for (const name of [...files, '_server.py', 'certification-evidence.mjs', 'certification-cells.json', 'certify.mjs'])
    add(`examples/middleware/mcp/${name}`, 'test_source');
  for (const path of [...(language === 'python' ? [driver, 'packages/middleware/conformance/python_fixture.py', 'examples/middleware/pydantic-ai/_fixture.py'] : []),
    'packages/middleware/conformance/runtime-fixture.mjs',
    'packages/middleware/conformance/support/certify.mjs', 'packages/middleware/conformance/support/catalog.mjs',
    'packages/middleware/conformance/support/inventory.mjs', 'packages/middleware/conformance/support/observations.mjs']) add(path, 'test_source');
  add('examples/middleware/mcp/package.json', 'package_or_fixture');
  add('examples/middleware/mcp/package-lock.json', 'dependency_lock');
  add('examples/middleware/mcp/requirements.lock', 'dependency_lock');
  const python = process.env.CAVEMAN_MIDDLEWARE_TEST_PYTHON; assert.ok(python, 'Use the exact locked MCP Python fixture environment');
  const names = language === 'python' ? ['mcp', 'openai', 'anthropic', 'httpx2', 'httpcore2', 'pydantic'] : ['mcp'];
  const { stdout } = await promisify(execFile)(python, ['-c', 'import importlib.metadata as m, json, sys; print(json.dumps({name:m.version(name) for name in sys.argv[1:]}))', ...names]);
  const pythonVersions = JSON.parse(stdout), frameworkVersions = language === 'python' ? pythonVersions : {};
  const providerVersions = {};
  assert.equal(pythonVersions.mcp, '2.2.0', 'The native MCP server fixture must match its exact Python lock');
  let tests;
  if (language === 'typescript') {
    const nativeLock = await json('examples/middleware/mcp/package-lock.json');
    for (const name of ['@modelcontextprotocol/sdk', 'openai', '@anthropic-ai/sdk']) {
      const version = await nodeVersion(name); assert.equal(nativeLock.packages[`node_modules/${name}`].version, version, `Native MCP fixture lock mismatch for ${name}`);
      frameworkVersions[name] = version;
      if (name !== '@modelcontextprotocol/sdk') providerVersions[name] = version;
    }
    tests = await declaredNodeTests([testFile], { namePrefix: 'MCP F13 ' });
    assert.equal(tests.tests.length, 11);
  } else {
    const source = await readFile(resolve(root, pythonFile), 'utf8');
    const name = 'NativeMCP.test_certifies_exact_f13_native_operations';
    const line = source.split('\n').findIndex(value => value.includes('async def test_certifies_exact_f13_native_operations(')) + 1;
    assert.ok(line);
    tests = { schema_version: 1, tests: [{ id: `${pythonFile}::${name}`, file: pythonFile, name, line,
      declaration: 'def test_certifies_exact_f13_native_operations(', sha256: sha256(source), evidence_scope: 'source_only',
      fixture_scope: 'installed_framework_local_fixture_source', rerun: { program: 'node', args: ['--test', '--test-reporter=tap', driver], cwd: '.',
        env: { CAVEMAN_MIDDLEWARE_TEST_FAMILY: 'mcp', CAVEMAN_MIDDLEWARE_TEST_PYTHON: '<exact locked MCP environment>' } } }] };
  }
  const input = await captureNativeCertificationInputs({ family: 'F13', language, sources: [...sources.values()], tests,
    binary: process.env.CAVEMAN_MIDDLEWARE_TEST_BINARY, frameworkVersions });
  if (language === 'typescript') input.native_server_fixture = { language: 'python', framework_versions: pythonVersions,
    dependency_lock: { path: 'examples/middleware/mcp/requirements.lock', sha256: sha256(await readFile(resolve(root, 'examples/middleware/mcp/requirements.lock'))) } };
  if (language === 'typescript') input.native_provider_fixture = { language: 'typescript', framework_versions: providerVersions,
    dependency_lock: { path: 'examples/middleware/mcp/package-lock.json', sha256: sha256(await readFile(resolve(root, 'examples/middleware/mcp/package-lock.json'))) } };
  return input;
}
let emitted = false;
export async function beginNativeCertification(t, capabilities, language = 'typescript') {
  if (language === 'typescript' && emitted) return;
  if (process.env.CAVEMAN_MIDDLEWARE_UNCAPTURED_TEST === '1') {
    t.diagnostic(`CAVEMAN_MIDDLEWARE_UNCAPTURED_NATIVE ${JSON.stringify({ family: 'F13', language, runtime_build: capabilities.runtime_build })}`);
  } else if (process.env.CAVEMAN_MIDDLEWARE_PACKAGED_TEST === '1') {
    t.diagnostic(`CAVEMAN_MIDDLEWARE_PACKAGED_EXECUTION ${JSON.stringify({ evidence_class: 'installed_artifact_runtime_observation', runtime_build: capabilities.runtime_build, runtime_protocol: capabilities.schema_version })}`);
  } else {
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
  for (const [assertion, observation] of Object.entries(observations))
    t.diagnostic(`CAVEMAN_MIDDLEWARE_OBSERVATION ${JSON.stringify({ cell_id: cell.id, test_id: `${testFile}::${t.name}`, assertion, observation })}`);
}
