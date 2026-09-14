/** Exact F04 inputs and observations. Candidate evidence does not promote support. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

export const testFile = 'examples/middleware/ai-sdk/conformance.test.mjs';
const require = createRequire(import.meta.url);
const anthropicRequire = createRequire(new URL(process.env.CAVEMAN_MIDDLEWARE_PACKAGED_TEST === '1' ? './package.json' : '../mastra/package.json', import.meta.url));
async function installedVersion(name, resolver = require) {
  let directory = dirname(resolver.resolve(name));
  for (;;) {
    const metadata = await readFile(resolve(directory, 'package.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (metadata?.name === name) return metadata.version;
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Cannot identify installed ${name}`);
    directory = parent;
  }
}

export async function certificationInputs() {
  const { json } = await import('../../../packages/middleware/conformance/support/inventory.mjs');
  const { declaredNodeTests } = await import('../../../packages/middleware/conformance/support/certify.mjs');
  const { captureNativeCertificationInputs: captureCertificationInputs } = await import('../../../packages/middleware/conformance/support/runtime-build.mjs');
  const previous = await json('packages/middleware/conformance/support/source-lock.json');
  const selected = previous.files.filter(file => file.role === 'runtime_source' || file.role === 'contract_schema' ||
    (file.role === 'sdk_source' && file.path.startsWith('packages/sdk/typescript/')));
  const sources = new Map(selected.map(({ path, role }) => [path, { path, role }]));
  const add = (path, role) => sources.set(path, { path, role });
  for (const name of ['ai-sdk', 'transport', 'openai', 'common', 'versions', 'provider-leaves']) {
    add(`packages/middleware/typescript/src/${name}.ts`, 'adapter_source');
    add(`packages/middleware/typescript/dist/${name}.js`, 'executed_module');
  }
  for (const name of ['index', 'runtime', 'types', 'validate']) add(`packages/sdk/typescript/dist/middleware/${name}.js`, 'executed_module');
  for (const path of [testFile, 'examples/middleware/ai-sdk/certification-evidence.mjs', 'examples/middleware/ai-sdk/certification-native.mjs',
    'examples/middleware/ai-sdk/certify.mjs', 'packages/middleware/conformance/runtime-fixture.mjs',
    'packages/middleware/conformance/support/certify.mjs', 'packages/middleware/conformance/support/catalog.mjs',
    'packages/middleware/conformance/support/inventory.mjs', 'packages/middleware/conformance/support/observations.mjs']) add(path, 'test_source');
  for (const family of ['ai-sdk', 'mastra']) {
    add(`examples/middleware/${family}/package-lock.json`, 'dependency_lock');
    add(`examples/middleware/${family}/package.json`, 'package_or_fixture');
  }
  const frameworkVersions = {};
  for (const name of ['ai', '@ai-sdk/provider', '@ai-sdk/openai', 'zod']) frameworkVersions[name] = await installedVersion(name);
  frameworkVersions['@ai-sdk/anthropic'] = await installedVersion('@ai-sdk/anthropic', anthropicRequire);
  return captureCertificationInputs({ family: 'F04', language: 'typescript', sources: [...sources.values()],
    tests: await declaredNodeTests([testFile], { namePrefix: 'AI SDK F04 ' }),
    binary: process.env.CAVEMAN_MIDDLEWARE_TEST_BINARY, frameworkVersions });
}

let inputsPromise, emitted = false;
export async function beginNativeCertification(t, capabilities) {
  if (emitted) return;
  if (process.env.CAVEMAN_MIDDLEWARE_PACKAGED_TEST === '1') {
    assert.ok(capabilities.runtime_build);
    t.diagnostic(`CAVEMAN_MIDDLEWARE_PACKAGED_EXECUTION ${JSON.stringify({ evidence_class: 'installed_artifact_runtime_observation', runtime_build: capabilities.runtime_build, runtime_protocol: capabilities.schema_version })}`);
  } else {
    const { executionObservation, executionPrefix } = await import('../../../packages/middleware/conformance/support/certify.mjs');
    inputsPromise ??= certificationInputs();
    t.diagnostic(`${executionPrefix}${JSON.stringify(executionObservation(await inputsPromise, capabilities))}`);
  }
  emitted = true;
}

export function emitJourney(t, provider, method, observations) {
  assert.ok(['openai', 'anthropic'].includes(provider));
  const streaming = ['streamText', 'streamText.structured', 'public_tool_loop.stream', 'cancel_and_close'].includes(method);
  const structured = method.endsWith('.structured'), modelOnly = structured || method === 'wrapLanguageModel.model_only';
  const id = ['F04', 'typescript', provider, provider === 'openai' ? 'openai-chat-completions' : 'anthropic-messages',
    method, 'async', streaming ? 'stream' : 'complete', structured ? 'structured' : 'unstructured', modelOnly ? 'model_only' : 'native_executor'].join('|');
  for (const [assertion, observation] of Object.entries(observations)) {
    t.diagnostic(`CAVEMAN_MIDDLEWARE_OBSERVATION ${JSON.stringify({ cell_id: id, test_id: `${testFile}::${t.name}`, assertion, observation })}`);
  }
}
