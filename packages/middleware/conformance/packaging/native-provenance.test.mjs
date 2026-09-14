/** Real native Go builds exercise the pre-install provenance boundary. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const producerPaths = ['packages/middleware/conformance/packaging/native-provenance.mjs',
  'packages/middleware/conformance/support/runtime-build.mjs'];

test('native provenance rejects changed executables and newly compiled inputs before package work', { timeout: 120_000 }, async t => {
  const output = await mkdtemp(resolve(tmpdir(), 'caveman-packaging-provenance-test-'));
  const fixture = resolve(output, 'fixture');
  for (const path of producerPaths) {
    await mkdir(dirname(resolve(fixture, path)), { recursive: true });
    await copyFile(resolve(root, path), resolve(fixture, path));
    assert.equal(hash(await readFile(resolve(fixture, path))), hash(await readFile(resolve(root, path))));
  }
  // Only root discovery changes; both real producer implementations are byte-identical.
  await writeFile(resolve(fixture, 'packages/middleware/conformance/support/inventory.mjs'),
    "import { fileURLToPath } from 'node:url'; export const root = fileURLToPath(new URL('../../../../', import.meta.url));\n");
  await writeFile(resolve(fixture, 'package.json'), '{"type":"module"}\n');
  await writeFile(resolve(fixture, 'go.mod'), 'module example.com/caveman-native-provenance-fixture\n\ngo 1.26.5\n');
  await writeFile(resolve(fixture, 'go.sum'), '');
  await mkdir(resolve(fixture, 'proxy/cmd/caveman-proxy'), { recursive: true });
  await writeFile(resolve(fixture, 'proxy/cmd/caveman-proxy/main.go'), 'package main\n\nfunc main() {}\n');
  const env = { ...process.env, GOWORK: 'off', GOTOOLCHAIN: 'local', GOPROXY: 'off', GOTELEMETRY: 'off',
    CAVEMAN_MIDDLEWARE_BUILD_GOCACHE: resolve(output, 'go-cache') };
  const script = resolve(output, 'exercise.mjs');
  await writeFile(script, `
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildRuntime } from ${JSON.stringify(resolve(fixture, producerPaths[1]))};
import { verifyNativeInputs } from ${JSON.stringify(resolve(fixture, producerPaths[0]))};
const output = ${JSON.stringify(output)}, fixture = ${JSON.stringify(fixture)};
const build = await buildRuntime({ target: 'proxy', output: resolve(output, 'native-build') });
const original = { binary: build.binary.path, provenance: resolve(output, 'native-build/build.json') };
const accepted = await verifyNativeInputs({ output: resolve(output, 'accepted'), runtimes: { proxy: original } });
assert.equal(accepted.completed, true);
const success = JSON.parse(await readFile(accepted.path));
assert(success.targets.proxy.sources.some(file => file.repository_path.endsWith('/main.go')));
assert.equal(success.targets.proxy.source_manifest_sha256, build.source_manifest_sha256);
const changed = resolve(output, 'changed-binary');
await writeFile(changed, Buffer.concat([await readFile(original.binary), Buffer.from('changed')]));
await assert.rejects(verifyNativeInputs({ output: resolve(output, 'wrong-binary'), runtimes: { proxy: { ...original, binary: changed } } }), /runtime binary differs from proven native build/);
await assert.rejects(verifyNativeInputs({ output: resolve(output, 'missing-provenance'), runtimes: { proxy: { binary: original.binary } } }), /CAVEMAN_MIDDLEWARE_RUNTIME_PROVENANCE/);
await writeFile(resolve(fixture, 'proxy/cmd/caveman-proxy/added.go'), 'package main\\nconst newlyCompiledInput = 1\\n');
await assert.rejects(verifyNativeInputs({ output: resolve(output, 'new-compiled-input'), runtimes: { proxy: original } }), /current Go dependency closure differs from the built binary/);
for (const name of ['wrong-binary', 'missing-provenance', 'new-compiled-input']) {
 const rejected = JSON.parse(await readFile(resolve(output, name, 'verification.json')));
 assert.equal(rejected.completed, false); assert(rejected.error);
}
console.log(JSON.stringify({ output, accepted: true, rejected: ['changed binary', 'missing provenance', 'new actual compiled source'], package_builds: 0, installs: 0 }));
`);
  const result = await execute(process.execPath, [script], { cwd: fixture, env, timeout: 110_000, maxBuffer: 2 * 1024 * 1024 });
  await writeFile(resolve(output, 'execution.log'), result.stdout + result.stderr);
  const summary = JSON.parse(result.stdout.trim());
  assert.equal(summary.accepted, true); assert.equal(summary.rejected.length, 3);
  assert.equal(summary.package_builds, 0); assert.equal(summary.installs, 0);
  const blockedOutput = resolve(output, 'runner-stopped-before-package-work');
  const blockedEnv = { ...env, CAVEMAN_MIDDLEWARE_TEST_BINARY: resolve(output, 'native-build/caveman-proxy') };
  delete blockedEnv.CAVEMAN_MIDDLEWARE_RUNTIME_PROVENANCE;
  delete blockedEnv.CAVEMAN_MCP_TEST_BINARY;
  delete blockedEnv.CAVEMAN_MCP_RUNTIME_PROVENANCE;
  const blocked = await execute(process.execPath, [resolve(root, 'packages/middleware/conformance/packaged-consumer.mjs'),
    '--only=typescript-core', `--output=${blockedOutput}`], { cwd: root, env: blockedEnv, timeout: 10_000 }).catch(error => error);
  assert.equal(blocked.code, 1); assert.match(blocked.stderr, /CAVEMAN_MIDDLEWARE_RUNTIME_PROVENANCE/);
  await writeFile(resolve(output, 'runner-rejection.log'), blocked.stdout + blocked.stderr);
  const rejected = JSON.parse(await readFile(resolve(blockedOutput, 'report.json')));
  assert.equal(rejected.native_provenance.status, 'failed');
  assert.deepEqual(rejected.build, []); assert.deepEqual(rejected.cases, []);
  assert.deepEqual(await readdir(resolve(blockedOutput, 'artifacts')), []);
  summary.runner_rejected_before_package_work = true;
  t.diagnostic(JSON.stringify({ evidence_class: 'real_native_provenance_boundary_test', ...summary }));
  // Keep logs, reports, and inputs for examination; only the test's build cache is disposable.
  assert((await readdir(resolve(output, 'accepted'))).includes('verification.json'));
});
