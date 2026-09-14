/** Native Linux build and package consumers, with no host credentials or ports. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const args = process.argv.slice(2), option = name => args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
for (const arg of args) assert(/^(--output=|--prepared=|--artifacts=|--only=|--prepare-only$|--verify-only$)/.test(arg), `Unknown argument ${arg}`);
const docker = process.env.CAVEMAN_PACKAGING_DOCKER ?? 'docker';
const output = resolve(option('prepared') ?? option('output') ?? `/tmp/caveman-packaging-linux-${randomUUID()}`);
const nodeImage = 'node@sha256:f5a0871ab03b035c58bdb3007c3d177b001c2145c18e81817b71624dcf7d8bff';
const pythonImage = 'python@sha256:0de818129b26ed8f46fd772f540c80e277b67a28229531a1ba0fdacfaed19bcb';
const goImage = 'golang@sha256:53eeac89074db483fdf0ab3be1df32bf6e47562263d2d0d6baa7f26acb4957dd';
const hash = data => createHash('sha256').update(data).digest('hex');
const fileHash = async path => hash(await readFile(path));
let report;
if (option('prepared')) {
  report = JSON.parse(await readFile(join(output, 'linux-environment.json'), 'utf8'));
  assert.equal(report.schema_version, 'caveman-native-linux-packaging/v2', 'Earlier Linux build evidence is historical; prepare a fresh v2 output for actual Go dependency-closure proof');
}
else {
  await mkdir(output, { recursive: true }); assert.equal((await readdir(output)).length, 0, 'Linux preparation output must be empty');
  report = { schema_version: 'caveman-native-linux-packaging/v2', id: randomUUID(), created_at: new Date().toISOString(),
    output, images: { node: nodeImage, python: pythonImage, go: goImage }, commands: [],
    published: false, host_credentials: false, published_ports: false, source_mount: 'read-only', cross_compiled: false };
}
const save = () => writeFile(join(output, 'linux-environment.json'), JSON.stringify(report, null, 2) + '\n');
async function run(label, command, args, timeout = 900_000) {
  const entry = { label, command: [command, ...args], started_at: new Date().toISOString(), log: join(output, `${report.commands.length + 1}-${label}.log`) };
  report.commands.push(entry); await save(); console.log(JSON.stringify({ linux_packaging: label, status: 'running' }));
  const log = createWriteStream(entry.log), began = performance.now();
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let tail = '', expired = false;
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { log.write(data); tail = (tail + data).slice(-4000); });
  const timer = setTimeout(() => { expired = true; child.kill('SIGTERM'); }, timeout);
  try { entry.exit_code = await new Promise((yes, no) => { child.once('error', no); child.once('exit', yes); });
    assert(entry.exit_code === 0 && !expired, `${label} exited ${entry.exit_code}${expired ? ' after timeout' : ''}\n${tail}`);
    entry.status = 'passed';
  } catch (error) { entry.status = 'failed'; entry.error = String(error); throw error; }
  finally { clearTimeout(timer); await new Promise(yes => log.end(yes)); entry.log_sha256 = await fileHash(entry.log);
    entry.duration_ms = Math.round(performance.now() - began); await save(); console.log(JSON.stringify({ linux_packaging: label, status: entry.status, ...(entry.error ? { error: entry.error } : {}) })); }
}
const mount = (source, destination, readonly = false) => `type=bind,src=${source},dst=${destination}${readonly ? ',readonly' : ''}`;
const producerPaths = ['packages/middleware/conformance/support/runtime-build.mjs', 'packages/middleware/conformance/packaging/linux-native.mjs'];
const producerHashes = async () => Object.fromEntries(await Promise.all(producerPaths.map(async path => [path, await fileHash(join(root, path))])));
const producers = await producerHashes();
if (!option('prepared')) {
  const context = join(output, 'image-context'); await mkdir(context);
  await copyFile(join(root, 'packages/middleware/conformance/packaging/Dockerfile'), join(context, 'Dockerfile'));
  report.dockerfile_sha256 = await fileHash(join(context, 'Dockerfile'));
  report.image_tag = `caveman-packaging:${report.id}`;
  await run('environment-build', docker, ['build', '--label', `caveman.packaging=${report.id}`, '--tag', report.image_tag, context]);
  await run('environment-inspect', docker, ['image', 'inspect', report.image_tag]);
} else {
  try { await run('environment-present', docker, ['image', 'inspect', report.image_tag]); }
  catch (error) {
    assert(String(error).includes('No such image'), `Cannot inspect the prepared Linux image: ${error}`);
    const context = join(output, 'image-context');
    assert.equal(await fileHash(join(context, 'Dockerfile')), report.dockerfile_sha256, 'Recorded Dockerfile changed');
    await run('environment-restore', docker, ['build', '--label', `caveman.packaging=${report.id}`, '--tag', report.image_tag, context]);
    await run('environment-restored-inspect', docker, ['image', 'inspect', report.image_tag]);
  }
}
if (!report.prepared) {
  const moduleCache = process.env.CAVEMAN_PACKAGING_GO_MOD_CACHE;
  report.module_cache = moduleCache ? { path: resolve(moduleCache), mount: 'read-only', verified: 'go mod verify before and after each build' } : { mount: 'owned temporary output' };
  const attempt = `native-attempt-${randomUUID()}`;
  const sourceAttempt = { started_at: new Date().toISOString(), output: join(output, attempt), container_output: `/output/${attempt}`, producers };
  report.native_build_attempts ??= []; report.native_build_attempts.push(sourceAttempt); await save();
  await run('native-go-build', docker, nativeArguments(`caveman-packaging-go-${report.id}`,
    ['--build', `--output=${sourceAttempt.container_output}`]));
  assert.deepEqual(await producerHashes(), producers, 'Native build producer changed during compilation');
  sourceAttempt.completed_at = new Date().toISOString();
  report.native_output = sourceAttempt.output; report.native_container_output = sourceAttempt.container_output;
  report.native_producers = producers;
  report.binaries = {};
  for (const [target, name] of [['proxy', 'caveman-proxy'], ['mcp', 'caveman-mcp']]) {
    const path = join(report.native_output, 'native', target, name);
    const provenancePath = join(report.native_output, 'native', target, 'build.json');
    const build = JSON.parse(await readFile(provenancePath, 'utf8'));
    assert(build.completed && build.native.platform === 'linux', `Native build did not complete for ${name}`);
    assert.equal(await fileHash(path), build.binary.sha256, `Built binary changed for ${name}`);
    report.binaries[name] = { path, container_path: `/native/${target}/${name}`, sha256: build.binary.sha256,
      build_provenance: { path: provenancePath, sha256: await fileHash(provenancePath) }, source_manifest_sha256: build.source_manifest_sha256 };
  }
  report.prepared = true; await save();
}
assert(report.prepared, 'Native Linux environment preparation must have passed');
assert.deepEqual(producers, report.native_producers, 'Native build producer changed; prepare a fresh output');
for (const [name, binary] of Object.entries(report.binaries)) {
  assert.equal(await fileHash(binary.path), binary.sha256, `Prepared Linux binary changed: ${name}`);
  assert.equal(await fileHash(binary.build_provenance.path), binary.build_provenance.sha256, `Prepared Linux build provenance changed: ${name}`);
}
if (args.includes('--prepare-only')) { console.log(JSON.stringify({ prepared_linux_environment: output })); process.exit(0); }
assert(option('artifacts') || args.includes('--verify-only'), 'Pass --artifacts pointing to both freshly packed tarballs and wheels');
const verificationName = `verification-${randomUUID()}`;
await run('native-input-verification', docker, nativeArguments(`caveman-packaging-verify-${report.id}`,
  [`--output=${report.native_container_output}`, `--verification=${report.native_container_output}/${verificationName}`]));
const verificationPath = join(report.native_output, verificationName, 'verification.json');
const verification = JSON.parse(await readFile(verificationPath, 'utf8'));
assert.equal(verification.completed, true, 'Current native dependency closure was not verified');
assert.deepEqual(await producerHashes(), producers, 'Native build producer changed during verification');
if (args.includes('--verify-only')) { console.log(JSON.stringify({ verified_linux_environment: output, verification: verificationPath })); process.exit(0); }
const runId = randomUUID(), hostRun = join(output, `run-${runId}`); await mkdir(hostRun);
const matrix = { path: join(hostRun, 'consumers/report.json'), command_index: report.commands.length,
  requested_cases: option('only')?.split(',') ?? 'all', native_verification: { path: verificationPath, sha256: await fileHash(verificationPath) },
  native_builds: report.binaries };
report.matrices ??= []; report.matrices.push(matrix);
try { await run('native-matrix', docker, ['run', '--rm', '--cpus=2', '--memory=4g', '--name', `caveman-packaging-matrix-${runId}`, '--label', `caveman.packaging=${report.id}`,
  '--read-only', '--tmpfs', '/tmp', '--mount', mount(root, '/source', true), '--mount', mount(resolve(option('artifacts')), '/artifacts', true),
  '--mount', mount(join(report.native_output, 'native'), '/native', true), '--mount', mount(output, '/output', true),
  '--mount', mount(hostRun, '/matrix'), '--workdir', '/source',
  ...(report.module_cache.path ? ['--mount', mount(report.module_cache.path, '/module-cache', true)] : []),
  '--env', `CAVEMAN_MIDDLEWARE_TEST_BINARY=${report.binaries['caveman-proxy'].container_path}`, '--env', `CAVEMAN_MCP_TEST_BINARY=${report.binaries['caveman-mcp'].container_path}`,
  '--env', `CAVEMAN_MIDDLEWARE_RUNTIME_PROVENANCE=${report.native_container_output}/native/proxy/build.json`,
  '--env', `CAVEMAN_MCP_RUNTIME_PROVENANCE=${report.native_container_output}/native/mcp/build.json`,
  '--env', 'GOCACHE=/matrix/go-cache', '--env', `GOMODCACHE=${report.module_cache.path ? '/module-cache' : '/output/go-mod-cache'}`,
  '--env', 'GOTELEMETRY=off', '--env', 'GOPROXY=off',
  '--env', 'CAVEMAN_PACKAGING_PYTHON=/usr/local/bin/python3', report.image_tag,
  'node', 'packages/middleware/conformance/packaged-consumer.mjs', '--output=/matrix/consumers', '--artifacts=/artifacts',
  ...(option('only') ? [`--only=${option('only')}`] : [])], 3_600_000); }
finally {
  matrix.status = report.commands[matrix.command_index].status;
  try { matrix.sha256 = await fileHash(matrix.path); }
  catch (error) { matrix.report_error = String(error); }
  report.last_matrix = matrix; await save();
  console.log(JSON.stringify({ linux_environment: join(output, 'linux-environment.json'), matrix: matrix.path, status: matrix.status }));
}

function nativeArguments(name, args) {
  const moduleCache = report.module_cache.path;
  return ['run', '--rm', '--cpus=2', '--memory=4g', '--name', name, '--label', `caveman.packaging=${report.id}`,
    '--read-only', '--tmpfs', '/tmp', '--mount', mount(root, '/source', true), '--mount', mount(output, '/output'), '--workdir', '/source',
    '--env', 'GOCACHE=/output/go-cache', '--env', `GOMODCACHE=${moduleCache ? '/module-cache' : '/output/go-mod-cache'}`, '--env', 'GOTELEMETRY=off',
    ...(report.prepared ? ['--env', 'GOPROXY=off'] : []),
    ...(moduleCache ? ['--mount', mount(moduleCache, '/module-cache', true)] : []),
    report.image_tag, 'node', 'packages/middleware/conformance/packaging/linux-native.mjs', ...args];
}
