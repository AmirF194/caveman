/** Inputs and observations for the native F16 journey tests. No support promotion. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

export const testFile = 'examples/middleware/mastra/conformance.test.mjs';
const require = createRequire(import.meta.url);
const familySources = ['mastra', 'ai-sdk', 'common', 'versions'];

async function installedVersion(name, entry) {
  let directory = dirname(require.resolve(entry));
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
  for (const name of familySources) {
    add(`packages/middleware/typescript/src/${name}.ts`, 'adapter_source');
    add(`packages/middleware/typescript/dist/${name}.js`, 'executed_module');
  }
  for (const name of ['index', 'runtime', 'types', 'validate']) add(`packages/sdk/typescript/dist/middleware/${name}.js`, 'executed_module');
  for (const path of [testFile, 'examples/middleware/mastra/certification-evidence.mjs', 'examples/middleware/mastra/certify.mjs',
    'packages/middleware/conformance/runtime-fixture.mjs', 'packages/middleware/conformance/support/certify.mjs',
    'packages/middleware/conformance/support/catalog.mjs', 'packages/middleware/conformance/support/inventory.mjs',
    'packages/middleware/conformance/support/observations.mjs']) add(path, 'test_source');
  add('examples/middleware/mastra/package-lock.json', 'dependency_lock');
  add('examples/middleware/mastra/package.json', 'package_or_fixture');
  const frameworkVersions = {};
  for (const [name, entry] of [['@mastra/core', '@mastra/core/agent'], ['@ai-sdk/openai', '@ai-sdk/openai'],
    ['@ai-sdk/anthropic', '@ai-sdk/anthropic'], ['ai', 'ai'], ['zod', 'zod']]) frameworkVersions[name] = await installedVersion(name, entry);
  return captureCertificationInputs({ family: 'F16', language: 'typescript', sources: [...sources.values()],
    tests: await declaredNodeTests([testFile], { namePrefix: 'Mastra F16 ' }),
    binary: process.env.CAVEMAN_MIDDLEWARE_TEST_BINARY, frameworkVersions });
}

let inputsPromise, executionEmitted = false;
export async function beginNativeCertification(t, capabilities) {
  if (process.env.CAVEMAN_MIDDLEWARE_PACKAGED_TEST === '1') {
    if (!executionEmitted) {
      assert.ok(capabilities.runtime_build);
      t.diagnostic(`CAVEMAN_MIDDLEWARE_PACKAGED_EXECUTION ${JSON.stringify({ evidence_class: 'installed_artifact_runtime_observation', runtime_build: capabilities.runtime_build, runtime_protocol: capabilities.schema_version })}`);
      executionEmitted = true;
    }
    return;
  }
  const { executionObservation, executionPrefix } = await import('../../../packages/middleware/conformance/support/certify.mjs');
  inputsPromise ??= certificationInputs();
  const input = await inputsPromise;
  if (!executionEmitted) {
    t.diagnostic(`${executionPrefix}${JSON.stringify(executionObservation(input, capabilities))}`);
    executionEmitted = true;
  }
}

export function emitJourney(t, provider, method, journey) {
  assert.ok(['openai', 'anthropic'].includes(provider));
  assert.ok(['agent.generate', 'agent.stream', 'agent.structured_output', 'processLLMRequest.every_step',
    'MessageList_memory_and_UI_history', 'workflow_suspend_resume', 'native_tool_execution', 'nested_AI_SDK_ownership', 'cancel_and_close'].includes(method));
  const streaming = ['agent.stream', 'cancel_and_close'].includes(method), structured = method === 'agent.structured_output';
  const cellId = ['F16', 'typescript', provider, provider === 'openai' ? 'openai-chat-completions' : 'anthropic-messages', method, 'async',
    streaming ? 'stream' : 'complete', structured ? 'structured' : 'unstructured', structured ? 'model_only' : 'native_executor'].join('|');
  for (const [assertion, observation] of Object.entries(journey)) {
    t.diagnostic(`CAVEMAN_MIDDLEWARE_OBSERVATION ${JSON.stringify({ cell_id: cellId, test_id: `${testFile}::${t.name}`, assertion, observation })}`);
  }
}
