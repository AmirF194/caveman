/** Build package artifacts and exercise every public entry in clean consumers. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { tmpdir, platform, arch, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cases, pythonImports, typescriptConsumer } from './catalog.mjs';
import { pythonConsumer } from './python-types.mjs';
import { nativeFixtures } from './fixtures.mjs';
import { verifyNativeInputs } from './native-provenance.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const args = process.argv.slice(2), option = name => args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
for (const argument of args) assert(/^(--only=|--output=|--artifacts=|--list$|--keep-consumers$)/.test(argument), `Unknown argument ${argument}`);
if (args.includes('--list')) { console.log(JSON.stringify(cases, null, 2)); process.exit(0); }
const names = option('only')?.split(','), selected = names ? cases.filter(value => names.includes(value.id)) : cases;
if (names) assert.equal(selected.length, names.length, 'Unknown or repeated package case');
const output = option('output') ? resolve(option('output')) : await mkdtemp(join(tmpdir(), 'caveman-packaging-'));
await mkdir(output, { recursive: true });
assert.equal((await readdir(output)).length, 0, 'Output must be empty; consumers are never reused');
const artifacts = join(output, 'artifacts'); await mkdir(artifacts);
const binary = process.env.CAVEMAN_MIDDLEWARE_TEST_BINARY;
assert(binary, 'Set CAVEMAN_MIDDLEWARE_TEST_BINARY to a freshly built native runtime');
const hash = data => createHash('sha256').update(data).digest('hex');
const fileHash = async path => hash(await readFile(path));
const nativeDirectory = join(output, 'native'); await mkdir(nativeDirectory);
async function snapshotBinary(input, name) {
  const sourcePath = resolve(input), sha256 = await fileHash(sourcePath), path = join(nativeDirectory, name);
  await copyFile(sourcePath, path); await chmod(path, 0o755);
  assert.equal(await fileHash(path), sha256, `Native binary changed while snapshotting: ${sourcePath}`);
  return { path, sha256, source_path: sourcePath, owned_snapshot: true };
}
const nativeRuntime = await snapshotBinary(binary, 'caveman-proxy');
const nativeMCP = process.env.CAVEMAN_MCP_TEST_BINARY ? await snapshotBinary(process.env.CAVEMAN_MCP_TEST_BINARY, 'caveman-mcp') : null;
const ownHome = join(output, 'home'); await mkdir(ownHome);
const emptyConfig = join(output, 'empty.npmrc'); await writeFile(emptyConfig, '');
const emptyGlobalConfig = join(output, 'empty-global.npmrc'); await writeFile(emptyGlobalConfig, '');
// Drop developer credentials, provider configuration and source-resolution aliases.
const env = Object.fromEntries(['PATH', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SYSTEMROOT']
  .filter(key => process.env[key]).map(key => [key, process.env[key]]));
Object.assign(env, { HOME: ownHome, PYTHONNOUSERSITE: '1', UV_NO_CONFIG: '1', UV_NO_PROGRESS: '1',
  UV_CACHE_DIR: process.env.CAVEMAN_PACKAGING_UV_CACHE ?? join(output, 'uv-cache'),
  npm_config_userconfig: emptyConfig, npm_config_globalconfig: emptyGlobalConfig,
  npm_config_cache: process.env.CAVEMAN_PACKAGING_NPM_CACHE ?? join(output, 'npm-cache'),
  npm_config_registry: 'https://registry.npmjs.org', npm_config_audit: 'false', npm_config_fund: 'false',
  CAVEMAN_MIDDLEWARE_TEST_BINARY: nativeRuntime.path, LITELLM_LOCAL_MODEL_COST_MAP: 'True',
  CREWAI_TELEMETRY_DISABLED: 'true', OTEL_SDK_DISABLED: 'true', DO_NOT_TRACK: '1',
  ANONYMIZED_TELEMETRY: 'False', AWS_EC2_METADATA_DISABLED: 'true' });
if (nativeMCP) env.CAVEMAN_MCP_TEST_BINARY = nativeMCP.path;
const report = { schema_version: 'caveman-isolated-packaging/v1', evidence_class: 'local_installed_artifact',
  started_at: new Date().toISOString(), output, source_root: root,
  platform: { os: platform(), arch: arch(), release: release(), node: process.version },
  native_runtime: nativeRuntime, native_mcp: nativeMCP,
  hosted_provider_tested: false, published: false, workspace_aliases: false, source: {}, artifacts: [], build: [], cases: [],
  limitations: ['Deterministic local provider fixtures; no paid inference.',
    'TypeScript consumer calls use skipLibCheck; upstream declaration bodies are not rechecked.',
    'Python consumer calls use pinned mypy; imported library internals and untyped upstream imports are not rechecked.'] };
const save = () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
let sequence = 0;
async function run(stages, label, command, args, cwd = output, additions = {}, timeout = 300_000) {
  const stage = { label, command: [command, ...args], cwd, started_at: new Date().toISOString(), status: 'running',
    log: join(output, `${String(++sequence).padStart(3, '0')}-${label}.log`) };
  stages.push(stage); await save(); console.log(JSON.stringify({ packaging_stage: label, status: 'running' }));
  const began = performance.now(), log = createWriteStream(stage.log);
  const child = spawn(command, args, { cwd, env: { ...env, ...additions }, stdio: ['ignore', 'pipe', 'pipe'] });
  let tail = '', timedOut = false;
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { log.write(data); tail = (tail + data).slice(-16_000); });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeout);
  try {
    stage.exit_code = await new Promise((yes, no) => { child.once('error', no); child.once('exit', yes); });
    if (stage.exit_code !== 0 || timedOut) throw new Error(`${label} ${timedOut ? 'timed out' : `exited ${stage.exit_code}`}\n${tail}`);
    stage.status = 'passed';
  } catch (error) { stage.status = 'failed'; stage.error = String(error); }
  finally { clearTimeout(timer); await new Promise(yes => log.end(yes)); stage.duration_ms = Math.round(performance.now() - began);
    stage.log_sha256 = await fileHash(stage.log); await save();
    console.log(JSON.stringify({ packaging_stage: label, status: stage.status, duration_ms: stage.duration_ms,
      ...(stage.error ? { error: stage.error.slice(-2000) } : {}) })); }
  return stage;
}
async function must(...args) { const result = await run(...args); if (result.status !== 'passed') throw new Error(result.error); return result; }
async function filesBelow(base, relative = '') {
  const result = [];
  for (const entry of await readdir(join(base, relative), { withFileTypes: true })) {
    if (['node_modules', 'dist', 'build', '__pycache__', '.venv'].includes(entry.name) || entry.name.endsWith('.egg-info')) continue;
    const path = join(relative, entry.name);
    if (entry.isDirectory()) result.push(...await filesBelow(base, path)); else if (entry.isFile()) result.push(path);
  }
  return result.sort();
}
async function sourceHashes() {
  const result = {};
  for (const base of ['packages/sdk/typescript', 'packages/sdk/python', 'packages/middleware/typescript', 'packages/middleware/python'])
    for (const file of await filesBelow(join(root, base))) result[join(base, file)] = await fileHash(join(root, base, file));
  return result;
}
report.native_provenance = { status: 'running' }; await save();
try {
  report.native_provenance = { status: 'passed', ...await verifyNativeInputs({ output: join(output, 'runtime-provenance'),
    runtimes: { proxy: { binary: nativeRuntime.path, provenance: process.env.CAVEMAN_MIDDLEWARE_RUNTIME_PROVENANCE },
      ...(nativeMCP || selected.some(value => value.name === 'mcp') ? { mcp: { binary: nativeMCP?.path, provenance: process.env.CAVEMAN_MCP_RUNTIME_PROVENANCE } } : {}) } }) };
} catch (error) {
  const path = join(output, 'runtime-provenance', 'verification.json');
  report.native_provenance = { status: 'failed', path, sha256: await fileHash(path), error: String(error) };
  report.completed_at = new Date().toISOString();
  report.summary = { expected: selected.length, passed: 0, failed: 0, not_run: selected.length, native_provenance_failed: true };
  await save(); throw error;
}
await save();
report.source = await sourceHashes();
const selectedPackageRoots = [...new Set(selected.flatMap(value => {
  const languages = value.language === 'typescript' && value.name === 'mcp' ? ['typescript', 'python'] : [value.language];
  return languages.flatMap(language => ['sdk', 'middleware'].map(family => `packages/${family}/${language}/`));
}))];
const selectedSource = source => Object.fromEntries(Object.entries(source).filter(([path]) => selectedPackageRoots.some(prefix => path.startsWith(prefix))));
let artifactSource = report.source;
report.harness_source = {};
for (const name of await filesBelow(join(root, 'packages/middleware/conformance/packaging'))) {
  const path = `packages/middleware/conformance/packaging/${name}`; report.harness_source[path] = await fileHash(join(root, path));
}
report.harness_source['packages/middleware/conformance/packaged-consumer.mjs'] = await fileHash(join(root, 'packages/middleware/conformance/packaged-consumer.mjs'));
await must(report.build, 'declared-adapter-inventory', process.env.CAVEMAN_PACKAGING_PYTHON ?? 'python3', ['-c',
  'import json,sys,tomllib; from pathlib import Path; root=Path(sys.argv[1]); cases=json.loads(sys.argv[2]); npm=json.loads((root/"packages/middleware/typescript/package.json").read_text()); py=tomllib.loads((root/"packages/middleware/python/pyproject.toml").read_text()); expected_ts=sorted(key.removeprefix("./") for key in npm["exports"]); expected_py=sorted(py["project"]["optional-dependencies"]); actual=lambda language:sorted(row["name"] for row in cases if row["language"]==language and row["name"]!="core"); assert actual("typescript")==expected_ts,(actual("typescript"),expected_ts); assert actual("python")==expected_py,(actual("python"),expected_py); print(json.dumps({"typescript_exports":expected_ts,"python_extras":expected_py,"core_consumers":2}))', root, JSON.stringify(cases)]);
if (option('artifacts')) {
  const provenancePath = join(resolve(option('artifacts')), 'source-provenance.json');
  const provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
  assert.deepEqual(selectedSource(provenance.source), selectedSource(report.source), 'Supplied artifacts were built from different selected package source');
  artifactSource = provenance.source;
  for (const name of await readdir(resolve(option('artifacts')))) if (/\.(tgz|whl)$/.test(name)) await copyFile(join(resolve(option('artifacts')), name), join(artifacts, name));
  for (const artifact of provenance.artifacts) assert.equal(await fileHash(join(artifacts, artifact.name)), artifact.sha256, `Supplied artifact hash changed: ${artifact.name}`);
  report.artifact_producer = { path: provenancePath, sha256: await fileHash(provenancePath), source_verified_for_selected_consumers: true,
    verified_package_roots: selectedPackageRoots,
    unselected_source_differences: [...new Set([...Object.keys(provenance.source), ...Object.keys(report.source)])].filter(path => provenance.source[path] !== report.source[path]) };
  report.artifact_build = 'supplied artifacts with verified selected package source and artifact hashes';
} else {
  for (const family of ['sdk', 'middleware']) await must(report.build, `pack-${family}-npm`, 'pnpm', ['pack', '--pack-destination', artifacts], join(root, `packages/${family}/typescript`));
  for (const family of ['sdk', 'middleware']) await must(report.build, `pack-${family}-wheel`, 'uv', ['build', '--wheel', '--out-dir', artifacts, join(root, `packages/${family}/python`)]);
  const afterBuild = await sourceHashes();
  const changedDuringBuild = [...new Set([...Object.keys(afterBuild), ...Object.keys(report.source)])].filter(path => afterBuild[path] !== report.source[path]);
  assert.equal(changedDuringBuild.length, 0, `Package source changed during artifact build: ${changedDuringBuild.join(', ')}`);
  report.artifact_build = 'fresh native build from recorded source';
}
for (const name of (await readdir(artifacts)).filter(name => /\.(tgz|whl)$/.test(name)).sort()) report.artifacts.push({ name,
  path: join(artifacts, name), sha256: await fileHash(join(artifacts, name)), bytes: (await stat(join(artifacts, name))).size });
const npmArtifacts = report.artifacts.filter(value => value.name.endsWith('.tgz'));
const sdkWheel = report.artifacts.find(value => value.name.startsWith('caveman_sdk-') && value.name.endsWith('.whl'));
const middlewareWheel = report.artifacts.find(value => value.name.startsWith('caveman_middleware-') && value.name.endsWith('.whl'));
assert(npmArtifacts.length === 2 && sdkWheel && middlewareWheel, 'Both tarballs and both wheels are required');
await writeFile(join(artifacts, 'source-provenance.json'), JSON.stringify({ schema_version: 1, source: artifactSource,
  artifacts: report.artifacts.map(({ name, sha256, bytes }) => ({ name, sha256, bytes })) }, null, 2) + '\n');
async function copyFixture(source, destination, evidence, transform = value => value) {
  const original = await readFile(join(root, source), 'utf8'), copied = transform(original); await writeFile(destination, copied);
  evidence.fixtures.push({ source, original_sha256: hash(original), copy: destination, copied_sha256: hash(copied), import_rewrites: original !== copied });
}
function tsRewrites(code) {
  return code.replaceAll('../../../packages/sdk/typescript/dist/middleware/index.js', '@caveman-ai/sdk/middleware')
    .replace(/\.\.\/\.\.\/\.\.\/packages\/middleware\/typescript\/dist\/([a-z-]+)\.js/g, '@caveman-ai/middleware/$1')
    .replaceAll('../../../packages/middleware/conformance/runtime-fixture.mjs', './runtime-fixture.mjs')
    .replaceAll('../../../packages/middleware/typescript/node_modules/@google/genai/dist/node/index.mjs', '@google/genai')
    .replace("new URL('../../../packages/middleware/typescript/src/mastra.ts', import.meta.url)", "new URL(import.meta.resolve('@caveman-ai/middleware/mastra'))")
    .replace(/new URL\('\.\.\/\.\.\/\.\.\/packages\/sdk\/typescript',\s*import\.meta\.url\)/g, "new URL('../', import.meta.resolve('@caveman-ai/sdk'))")
    .replace(/new URL\(`\.\.\/\.\.\/\.\.\/packages\/middleware\/typescript\/dist\/\$\{file\}`,\s*import\.meta\.url\)/g, "new URL(file, import.meta.resolve('@caveman-ai/middleware/mastra'))")
    .replaceAll('../../../packages/middleware/conformance/support/', './unavailable-repository-support/')
    .replace(/errors\.push\(error\.message\);\s*res\.destroy\(error\);/g,
      "errors.push(error.message); console.error('isolated-provider-fixture-failure', error); res.destroy(error);")
    .replaceAll('createMiddlewareRuntime({', "createMiddlewareRuntime({ onDiagnostic: event => console.error('isolated-runtime-diagnostic', JSON.stringify(event)), ");
}
function providerEvidenceRewrites(code) {
  return code.replace(/const paths=\[.*?\];\n      const hash=content=>createHash\('sha256'\)\.update\(content\)\.digest\('hex'\),root=new URL\('\.\.\/\.\.\/\.\.\/',import\.meta\.url\),files=\{\};\n      for\(const path of paths\)files\[path\]=hash\(await readFile\(new URL\(path,root\)\)\);/,
    "const paths=[new URL(`./${name}.test.mjs`,import.meta.url),new URL('./native-fixture.mjs',import.meta.url),new URL('./package-lock.json',import.meta.url),new URL(import.meta.resolve(`@caveman-ai/middleware/${name}`)),new URL('./transport.js',import.meta.resolve(`@caveman-ai/middleware/${name}`)),new URL('./provider-leaves.js',import.meta.resolve(`@caveman-ai/middleware/${name}`))];\n      const hash=content=>createHash('sha256').update(content).digest('hex'),files={};\n      for(const path of paths)files[path.href]=hash(await readFile(path));");
}
function pythonFixtureRewrites(code, definition, name) {
  if (definition.name === 'mcp' && name === 'test_native.py') return code.replace('Path(__file__).parents[1] / "pydantic-ai/_fixture.py"', 'Path(__file__).with_name("mcp_provider_fixture.py")');
  if (['openai', 'anthropic'].includes(definition.name) && name === '_certification_native.py') {
    const input = '(ROOT / "packages/middleware/conformance/support/required-cells.json")';
    assert.equal(code.split(input).length, 2, 'Provider certification cell input changed');
    return code.replace(input, 'Path(__file__).with_name("required-cells.json")');
  }
  if (['openai', 'anthropic'].includes(definition.name) && name === 'test_native.py') return code
    .replace('root = Path(__file__).resolve().parents[3]', 'root = Path(__file__).resolve().parent')
    .replaceAll('root / "packages/middleware/python/caveman_middleware/', 'Path(sys.modules["caveman_middleware.openai"].__file__).parent / "');
  return code;
}
async function verifyLockPins(beforePath, afterPath) {
  const before = JSON.parse(await readFile(beforePath, 'utf8')), after = JSON.parse(await readFile(afterPath, 'utf8'));
  for (const [name, value] of Object.entries(before.packages)) if (name) {
    assert.equal(after.packages[name]?.version, value.version, `Exact example version changed: ${name}`);
    assert.equal(after.packages[name]?.integrity, value.integrity, `Exact example integrity changed: ${name}`);
  }
}
async function typescriptCase(definition, evidence, consumer) {
  const stage = (label, command, args, additions) => run(evidence.stages, `${definition.id}-${label}`, command, args, consumer, additions);
  if (definition.example) {
    await copyFile(join(root, definition.example, 'package.json'), join(consumer, 'package.json'));
    await copyFile(join(root, definition.locks[0]), join(consumer, 'package-lock.json'));
    await must(evidence.stages, `${definition.id}-example-lock`, 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], consumer);
  } else await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'caveman-isolated-core', private: true, type: 'module' }));
  if (definition.supplementaryDependencies?.length) {
    evidence.supplementary_dependencies = [];
    for (const dependency of definition.supplementaryDependencies) {
      const lock = JSON.parse(await readFile(join(root, dependency.lock), 'utf8'));
      const pinned = lock.packages[`node_modules/${dependency.name}`];
      assert.equal(pinned?.version, dependency.version, `Supplementary provider pin changed: ${dependency.name}`);
      assert(pinned.integrity, `Supplementary provider integrity absent: ${dependency.name}`);
      evidence.supplementary_dependencies.push({ ...dependency, integrity: pinned.integrity });
    }
    await must(evidence.stages, `${definition.id}-supplementary-dependencies`, 'npm', ['install', '--save-exact', '--ignore-scripts', '--no-audit', '--no-fund',
      ...definition.supplementaryDependencies.map(value => `${value.name}@${value.version}`)], consumer);
    await verifyLockPins(join(root, definition.locks[0]), join(consumer, 'package-lock.json'));
    const installed = JSON.parse(await readFile(join(consumer, 'package-lock.json'), 'utf8'));
    for (const dependency of evidence.supplementary_dependencies) {
      const value = installed.packages[`node_modules/${dependency.name}`];
      assert.equal(value?.version, dependency.version, `Supplementary provider version changed: ${dependency.name}`);
      assert.equal(value?.integrity, dependency.integrity, `Supplementary provider integrity changed: ${dependency.name}`);
    }
  }
  await must(evidence.stages, `${definition.id}-artifacts`, 'npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...npmArtifacts.map(value => value.path)], consumer);
  if (definition.example) await verifyLockPins(join(root, definition.locks[0]), join(consumer, 'package-lock.json'));
  const specs = ['@caveman-ai/sdk', '@caveman-ai/sdk/middleware', ...(definition.name === 'core' ? [] : [`@caveman-ai/middleware/${definition.name}`])];
  await writeFile(join(consumer, 'probe.mjs'), `import assert from 'node:assert/strict';
import { realpathSync, readFileSync, writeFileSync } from 'node:fs'; import { fileURLToPath } from 'node:url';
const imports = {}; for (const name of ${JSON.stringify(specs)}) { const path = realpathSync(fileURLToPath(import.meta.resolve(name))); assert(path.startsWith(process.cwd() + '/node_modules/')); await import(name); imports[name] = path; }
const sdk = JSON.parse(readFileSync('node_modules/@caveman-ai/sdk/package.json')); const middleware = JSON.parse(readFileSync('node_modules/@caveman-ai/middleware/package.json'));
assert.deepEqual(sdk.dependencies ?? {}, {}); assert.deepEqual(Object.keys(middleware.dependencies), ['@caveman-ai/sdk']); assert(!middleware.dependencies['@caveman-ai/sdk'].includes('workspace:'));
const lock = JSON.parse(readFileSync('package-lock.json'));
${definition.name === 'core' ? "assert.deepEqual(Object.keys(lock.packages).filter(value => value).sort(), ['node_modules/@caveman-ai/middleware', 'node_modules/@caveman-ai/sdk']);" : ''}
writeFileSync('installed-package-probe.json', JSON.stringify({ imports, sdk, middleware, core: ${definition.name === 'core'}, workspace_aliases: false }, null, 2));\n`);
  await stage('installed-imports', process.execPath, ['probe.mjs']);
  const existingLock = JSON.parse(await readFile(join(consumer, 'package-lock.json'), 'utf8'));
  const nodeTypesVersion = existingLock.packages['node_modules/@types/node']?.version ?? '22.13.10';
  const typescriptVersion = existingLock.packages['node_modules/typescript']?.version ?? '5.9.3';
  await must(evidence.stages, `${definition.id}-type-tools`, 'npm', ['install', '--save-dev', '--ignore-scripts', '--no-audit', '--no-fund', `typescript@${typescriptVersion}`, `@types/node@${nodeTypesVersion}`], consumer);
  if (definition.example) await verifyLockPins(join(root, definition.locks[0]), join(consumer, 'package-lock.json'));
  await writeFile(join(consumer, 'consumer.mts'), typescriptConsumer(definition.name));
  await stage('types', process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--skipLibCheck', 'consumer.mts']);
  if (!definition.example) return;
  for (const { source, destination } of nativeFixtures(definition)) await copyFixture(source, join(consumer, destination), evidence, destination.endsWith('.mjs') ? code => {
    const copied = providerEvidenceRewrites(tsRewrites(code)); assert(!copied.includes('../../../packages/'), `Unisolated fixture ${destination}`); return copied;
  } : undefined);
  const additions = { CAVEMAN_MIDDLEWARE_PACKAGED_TEST: '1' };
  if (definition.name === 'mastra') {
    additions.CAVEMAN_MASTRA_EVIDENCE = join(consumer, 'native-proof.json');
  }
  if (definition.name === 'mcp') {
    additions.CAVEMAN_MIDDLEWARE_TEST_PYTHON = await pythonEnvironment(definition, evidence, consumer, 'mcp-server', false);
    assert(env.CAVEMAN_MCP_TEST_BINARY, 'MCP needs a freshly built CAVEMAN_MCP_TEST_BINARY');
  }
  await stage('native-tests', process.execPath, ['--test', '--test-concurrency=1', ...definition.tests], additions);
  evidence.installed_lock_sha256 = await fileHash(join(consumer, 'package-lock.json'));
}
async function pythonEnvironment(definition, evidence, consumer, suffix = 'venv', probeExtra = true) {
  const environment = join(consumer, suffix), label = `${definition.id}-${suffix}`;
  await must(evidence.stages, label, 'uv', ['venv', '--python', process.env.CAVEMAN_PACKAGING_PYTHON ?? '3.13', environment], consumer);
  const python = join(environment, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const requirements = join(consumer, `${suffix}-artifacts.in`), extra = definition.name === 'core' ? '' : `[${definition.name}]`;
  await writeFile(requirements, `caveman-sdk @ ${pathToFileURL(sdkWheel.path).href}#sha256=${sdkWheel.sha256}\ncaveman-middleware${extra} @ ${pathToFileURL(middlewareWheel.path).href}#sha256=${middlewareWheel.sha256}\n`);
  const exactLocks = definition.name === 'mcp' && definition.language === 'typescript' ? ['examples/middleware/mcp/requirements.lock'] : definition.locks;
  const exactLock = exactLocks[0];
  const resolved = join(consumer, `${suffix}-declared-extra.lock`);
  const compile = ['pip', 'compile', '--python', python, '--generate-hashes', '--output-file', resolved, requirements];
  for (const lock of exactLocks) compile.push('--constraint', join(root, lock));
  await must(evidence.stages, `${label}-resolve-extra`, 'uv', compile, consumer);
  await must(evidence.stages, `${label}-install-extra`, 'uv', ['pip', 'sync', '--python', python, '--require-hashes', resolved], consumer);
  await must(evidence.stages, `${label}-check`, 'uv', ['pip', 'check', '--python', python], consumer);
  if (probeExtra) {
    await writeFile(join(consumer, 'probe-config.json'), JSON.stringify({ core: definition.name === 'core', imports: pythonImports[definition.name] }));
    await copyFile(join(root, 'packages/middleware/conformance/packaging/probe.py'), join(consumer, 'probe.py'));
    await run(evidence.stages, `${definition.id}-extra-imports`, python, ['-I', 'probe.py', 'probe-config.json', 'declared-extra-probe.json'], consumer);
    await run(evidence.stages, `${definition.id}-syntax`, python, ['-I', '-c',
      'import compileall, pathlib, caveman_middleware; assert compileall.compile_dir(str(pathlib.Path(caveman_middleware.__file__).parent), quiet=1)'], consumer);
  }
  evidence.resolved_locks ??= []; evidence.resolved_locks.push({ path: resolved, sha256: await fileHash(resolved), kind: 'actual-declared-extra' });
  if (exactLock) {
    const fixtureLock = join(consumer, `${suffix}-native-example.lock`);
    await must(evidence.stages, `${label}-resolve-example`, 'uv', ['pip', 'compile', '--python', python, '--generate-hashes', '--output-file', fixtureLock, requirements, ...exactLocks.map(lock => join(root, lock))], consumer);
    await must(evidence.stages, `${label}-install-example`, 'uv', ['pip', 'sync', '--python', python, '--require-hashes', fixtureLock], consumer);
    await must(evidence.stages, `${label}-example-check`, 'uv', ['pip', 'check', '--python', python], consumer);
    evidence.resolved_locks.push({ path: fixtureLock, sha256: await fileHash(fixtureLock), exact_example: exactLock, exact_example_sha256: await fileHash(join(root, exactLock)),
      exact_examples: await Promise.all(exactLocks.map(async path => ({ path, sha256: await fileHash(join(root, path)) }))) });
  }
  return python;
}
let typeCheckerPython;
async function pythonTypeChecker() {
  if (typeCheckerPython) return typeCheckerPython;
  const environment = join(output, 'python-type-tools');
  await must(report.build, 'python-type-tools-venv', 'uv', ['venv', '--python', process.env.CAVEMAN_PACKAGING_PYTHON ?? '3.13', environment]);
  const python = join(environment, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const lock = join(root, 'packages/middleware/conformance/packaging/type-requirements.lock');
  await must(report.build, 'python-type-tools-install', 'uv', ['pip', 'sync', '--python', python, '--require-hashes', lock]);
  await must(report.build, 'python-type-tools-version', python, ['-m', 'mypy', '--version']);
  report.python_type_tools = { environment, lock_sha256: await fileHash(lock), isolated_from_consumers: true };
  typeCheckerPython = python; return python;
}
async function pythonCase(definition, evidence, consumer) {
  const python = await pythonEnvironment(definition, evidence, consumer);
  const typeChecker = await pythonTypeChecker();
  await writeFile(join(consumer, 'consumer.py'), pythonConsumer(definition.name));
  await run(evidence.stages, `${definition.id}-types`, typeChecker, ['-m', 'mypy', '--python-executable', python, '--python-version', '3.13',
    '--follow-imports=silent', '--ignore-missing-imports', '--no-incremental', '--check-untyped-defs', 'consumer.py'], consumer);
  if (!definition.example) return;
  for (const { source, destination } of nativeFixtures(definition)) await copyFixture(source, join(consumer, destination), evidence,
    destination === 'run-python.mjs' ? code => code.replace("from '../runtime-fixture.mjs'", "from './runtime-fixture.mjs'")
      : code => pythonFixtureRewrites(code, definition, destination));
  await run(evidence.stages, `${definition.id}-example-imports`, python, ['-I', 'probe.py', 'probe-config.json', 'native-example-probe.json'], consumer);
  for (const [index, test] of definition.tests.entries()) {
    await run(evidence.stages, `${definition.id}-native-tests${index ? `-${index + 1}` : ''}`, process.execPath, ['run-python.mjs', python, test], consumer, {
      CAVEMAN_MIDDLEWARE_TEST_PYTHON: python, CAVEMAN_MIDDLEWARE_PACKAGED_TEST: '1' });
  }
}
for (const definition of selected) {
  const consumer = join(output, definition.id); await mkdir(consumer);
  const evidence = { id: definition.id, language: definition.language, adapter: definition.name, consumer,
    exact_locks: await Promise.all(definition.locks.map(async path => ({ path, sha256: await fileHash(join(root, path)) }))), stages: [], fixtures: [], status: 'running' };
  report.cases.push(evidence); await save();
  try {
    const space = await statfs(output); evidence.free_bytes_before_case = space.bsize * space.bavail;
    assert(evidence.free_bytes_before_case >= 1024 ** 3, 'Less than 1 GiB free; refusing another clean install');
    if (definition.language === 'typescript') await typescriptCase(definition, evidence, consumer); else await pythonCase(definition, evidence, consumer);
  }
  catch (error) { evidence.error = String(error); }
  evidence.status = !evidence.error && evidence.stages.every(stage => stage.status === 'passed') ? 'passed' : 'failed';
  evidence.proof_files = [];
  const proofNames = new Set(['installed-package-probe.json', 'declared-extra-probe.json', 'native-example-probe.json', 'consumer.mts', 'consumer.py',
    ...(await readdir(consumer)).filter(name => /(?:-evidence|native-proof)\.json$/.test(name))]);
  for (const name of proofNames) {
    try { evidence.proof_files.push({ path: join(consumer, name), sha256: await fileHash(join(consumer, name)) }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!args.includes('--keep-consumers')) {
    evidence.disposable_environments_removed = [];
    for (const name of ['node_modules', 'venv', 'mcp-server', '.mypy_cache']) {
      await rm(join(consumer, name), { recursive: true, force: true, maxRetries: 3 });
      evidence.disposable_environments_removed.push(name);
    }
    // Only remove caches created inside this run, never an explicitly supplied cache.
    for (const [name, key] of [['uv-cache', 'UV_CACHE_DIR'], ['npm-cache', 'npm_config_cache']]) if (env[key] === join(output, name)) {
      await rm(join(output, name), { recursive: true, force: true, maxRetries: 3 });
      evidence.disposable_environments_removed.push(`../${name}`);
    }
  }
  console.log(JSON.stringify({ packaging_case: definition.id, status: evidence.status, ...(evidence.error ? { error: evidence.error.slice(-2000) } : {}) })); await save();
}
report.completed_at = new Date().toISOString();
if (typeCheckerPython && !args.includes('--keep-consumers')) {
  await rm(join(output, 'python-type-tools'), { recursive: true, force: true, maxRetries: 3 });
  report.python_type_tools.disposable_environment_removed = true;
}
const finalSource = await sourceHashes();
report.source_changed_after_build = JSON.stringify(finalSource) !== JSON.stringify(report.source);
report.selected_source_changed_after_build = JSON.stringify(selectedSource(finalSource)) !== JSON.stringify(selectedSource(report.source));
report.summary = { passed: report.cases.filter(value => value.status === 'passed').length, failed: report.cases.filter(value => value.status === 'failed').length,
  expected: selected.length, all_adapters_selected: selected.length === cases.length };
report.rerun = { command: ['node', 'packages/middleware/conformance/packaged-consumer.mjs', ...(names ? [`--only=${names.join(',')}`] : []), '--output=NEW_EMPTY_DIRECTORY'],
  required_environment: { CAVEMAN_MIDDLEWARE_TEST_BINARY: 'FRESH_NATIVE_RUNTIME_BINARY', CAVEMAN_MIDDLEWARE_RUNTIME_PROVENANCE: 'MATCHING_RUNTIME_BUILD_JSON',
    CAVEMAN_MCP_TEST_BINARY: 'FRESH_NATIVE_MCP_BINARY_FOR_MCP_CASES', CAVEMAN_MCP_RUNTIME_PROVENANCE: 'MATCHING_MCP_BUILD_JSON_FOR_MCP_CASES',
    CAVEMAN_PACKAGING_PYTHON: 'EXACT_PYTHON_EXECUTABLE_OR_3.13' } };
await save(); console.log(JSON.stringify({ packaging_report: join(output, 'report.json'), ...report.summary }));
if (report.summary.failed || report.selected_source_changed_after_build) process.exitCode = 1;
