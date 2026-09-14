import test from 'node:test';
import assert from 'node:assert/strict';
import { requiredNativeSources } from './source-scope.mjs';

test('native TypeScript scope includes imported source, executed code and package manifests', async () => {
  const files = new Map((await requiredNativeSources({ family: 'F01', language: 'typescript', tests: ['examples/middleware/provider-sdks/openai.test.mjs'] })).map(file => [file.path, file.role]));
  assert.equal(files.get('packages/middleware/typescript/src/wire.ts'), 'adapter_source');
  assert.equal(files.get('packages/middleware/typescript/dist/wire.js'), 'executed_module');
  assert.equal(files.get('packages/middleware/typescript/dist/provider-response.js'), 'executed_module');
  assert.equal(files.get('packages/sdk/typescript/src/middleware/validate.ts'), 'sdk_source');
  for (const owner of ['middleware', 'sdk']) assert.equal(files.get(`packages/${owner}/typescript/package.json`), 'package_or_fixture');
  assert.ok(files.has('examples/middleware/provider-sdks/certification-cells.json'));
  assert.ok(!files.has('packages/middleware/typescript/src/mastra.ts'), 'an unrelated family must not enter this proof scope');
});

test('native Python scope includes package bootstrap imports and excludes generated evidence output', async () => {
  const files = new Map((await requiredNativeSources({ family: 'F01', language: 'python', tests: ['examples/middleware/python-provider-sdks/test_providers.py'] })).map(file => [file.path, file.role]));
  assert.equal(files.get('packages/sdk/python/caveman_cloud/__init__.py'), 'sdk_source');
  assert.equal(files.get('packages/sdk/python/caveman_cloud/core.py'), 'sdk_source');
  assert.equal(files.get('packages/middleware/python/caveman_middleware/__init__.py'), 'adapter_source');
  for (const owner of ['middleware', 'sdk']) assert.equal(files.get(`packages/${owner}/python/pyproject.toml`), 'package_or_fixture');
  assert.ok(files.has('examples/middleware/python-provider-sdks/_certification_native.py'));
  assert.ok(!files.has('examples/middleware/python-provider-sdks/native-evidence.json'));
  assert.ok(!files.has('packages/middleware/python/caveman_middleware/llama_index.py'));
});

test('source scope rejects missing or non-allowlisted native entry points', async () => {
  for (const options of [{ family: 'unknown', language: 'typescript', tests: ['anything.mjs'] },
    { family: 'F01', language: 'typescript', tests: [] },
    { family: 'F01', language: 'typescript', tests: ['examples/middleware/mastra/conformance.test.mjs'] }])
    await assert.rejects(requiredNativeSources(options), /unknown family or native test entry point/);
});
