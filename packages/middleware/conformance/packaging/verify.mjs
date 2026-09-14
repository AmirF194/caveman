/** Verify complete platform coverage without replacing earlier failed attempts. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cases } from './catalog.mjs';
import { pythonConsumer } from './python-types.mjs';
import { typescriptConsumer } from './catalog.mjs';
import { nativeFixtures } from './fixtures.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const args = process.argv.slice(2), values = name => args.filter(arg => arg.startsWith(`--${name}=`)).map(arg => arg.slice(name.length + 3));
for (const arg of args) assert(/^(--report=|--platforms=|--artifacts=|--output=)/.test(arg), `Unknown argument ${arg}`);
const one = name => { const found = values(name); assert.equal(found.length, 1, `Pass one --${name}`); return found[0]; };
const platforms = one('platforms').split(','), artifactRoot = resolve(one('artifacts')), output = resolve(one('output'));
assert(platforms.length && new Set(platforms).size === platforms.length, 'Expected platforms must be unique');
assert(values('report').length, 'Pass at least one --report');
const hash = data => createHash('sha256').update(data).digest('hex'), fileHash = async path => hash(await readFile(path));
const failures = [], check = (condition, message) => { if (!condition) failures.push(message); };
const canonicalPath = join(artifactRoot, 'source-provenance.json'), canonical = JSON.parse(await readFile(canonicalPath, 'utf8'));
const artifactHashes = Object.fromEntries(canonical.artifacts.map(row => [row.name, row.sha256]));
assert.equal(Object.keys(artifactHashes).length, 4, 'Canonical input must contain both tarballs and both wheels');
for (const artifact of canonical.artifacts) check(await fileHash(join(artifactRoot, artifact.name)) === artifact.sha256, `Canonical artifact changed: ${artifact.name}`);

async function sourceFiles(base, prefix = '') {
  const result = [];
  for (const entry of await readdir(join(base, prefix), { withFileTypes: true })) {
    if (['node_modules', 'dist', 'build', '__pycache__', '.venv'].includes(entry.name) || entry.name.endsWith('.egg-info')) continue;
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...await sourceFiles(base, path)); else if (entry.isFile()) result.push(path);
  }
  return result;
}
const currentSource = {};
for (const path of ['packages/sdk/typescript', 'packages/sdk/python', 'packages/middleware/typescript', 'packages/middleware/python'])
  for (const file of await sourceFiles(join(root, path))) currentSource[join(path, file)] = await fileHash(join(root, path, file));
for (const path of new Set([...Object.keys(currentSource), ...Object.keys(canonical.source)]))
  check(currentSource[path] === canonical.source[path], `Canonical artifact source differs from current package source: ${path}`);

const reports = [], attempts = new Map();
for (const path of values('report').map(path => resolve(path))) {
  const bytes = await readFile(path), data = JSON.parse(bytes), entry = { path, sha256: hash(bytes), data };
  reports.push(entry);
  check(data.schema_version === 'caveman-isolated-packaging/v1', `Unknown report schema: ${path}`);
  check(!!data.completed_at && !data.interrupted, `Incomplete report: ${path}`);
  check(data.hosted_provider_tested === false && data.published === false && data.workspace_aliases === false, `Unexpected evidence class: ${path}`);
  check(data.selected_source_changed_after_build === false, `Selected source changed during report: ${path}`);
  check(platforms.includes(data.platform.os), `Unexpected platform ${data.platform.os}: ${path}`);
  for (const row of data.cases) {
    const key = `${data.platform.os}:${row.id}`, list = attempts.get(key) ?? [];
    list.push({ entry, row }); attempts.set(key, list);
  }
}
function localPath(path, entry) {
  const suffix = relative(entry.data.output, path);
  assert(suffix !== '..' && !suffix.startsWith('../') && !isAbsolute(suffix), `Evidence path is outside its report: ${path}`);
  return join(dirname(entry.path), suffix);
}
const checkedFiles = new Map();
async function verifyFile(path, expected, label) {
  try {
    if (!checkedFiles.has(path)) checkedFiles.set(path, await fileHash(path));
    check(checkedFiles.get(path) === expected, `Evidence hash changed (${label}): ${path}`);
  } catch (error) { failures.push(`Cannot read evidence (${label}): ${path}: ${error.code ?? error}`); }
}
const checkedNativeReports = new Map();
async function verifyNativeReport(entry) {
  if (checkedNativeReports.has(entry.path)) return checkedNativeReports.get(entry.path);
  const before = failures.length, data = entry.data, label = `${data.platform.os}/native provenance`;
  try {
    const reference = data.native_provenance;
    assert(reference?.status === 'passed' && reference.completed === true, 'Native input gate did not pass before package work');
    const path = localPath(reference.path, entry);
    await verifyFile(path, reference.sha256, label);
    const proof = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(proof.schema_version, 'caveman-packaging-native-inputs/v1');
    assert.equal(proof.completed, true); assert.equal(proof.phase, 'before_package_builds_and_installs');
    assert.deepEqual(proof.native, { platform: data.platform.os, arch: data.platform.arch });
    assert(proof.targets.proxy, 'Missing proxy closure');
    for (const [source, sha256] of Object.entries(proof.producers)) await verifyFile(join(root, source), sha256, `${label}/current producer`);
    for (const [target, value] of Object.entries(proof.targets)) {
      assert.equal(value.status, 'passed');
      const binary = target === 'proxy' ? data.native_runtime : target === 'mcp' ? data.native_mcp : null;
      assert(binary && value.binary.sha256 === binary.sha256, `Native ${target} proof names another binary`);
      await verifyFile(localPath(value.build_provenance.path, entry), value.build_provenance.sha256, `${label}/${target}/original build`);
      const build = JSON.parse(await readFile(localPath(value.build_provenance.path, entry), 'utf8'));
      assert.equal(build.producer, 'caveman-middleware-runtime-build-v1'); assert.equal(build.completed, true);
      assert.equal(build.binary.sha256, binary.sha256); assert.deepEqual(build.native, proof.native);
      assert.equal(build.source_manifest_sha256, value.source_manifest_sha256);
      await verifyFile(localPath(value.current_closure.path, entry), value.current_closure.sha256, `${label}/${target}/current closure`);
      const current = JSON.parse(await readFile(localPath(value.current_closure.path, entry), 'utf8'));
      assert.equal(current.manifest_sha256, build.source_manifest_sha256);
      assert.deepEqual(current.files, build.before.files);
      assert.equal(value.sources.length, build.before.files.length);
      for (const source of build.before.files) {
        const archived = value.sources.find(item => item.repository_path === source.path);
        assert(archived && archived.sha256 === source.sha256, `Missing runtime source archive ${source.path}`);
        await verifyFile(localPath(archived.path, entry), source.sha256, `${label}/${target}/archived source`);
        await verifyFile(join(root, source.path), source.sha256, `${label}/${target}/current source`);
      }
      for (const command of [...build.commands, current.command]) {
        const archived = value.command_outputs.find(item => item.source_path === command.raw_output.path);
        assert(archived && archived.sha256 === command.raw_output.sha256, 'Missing original native command output');
      }
      for (const file of value.command_outputs) await verifyFile(localPath(file.path, entry), file.sha256, `${label}/${target}/command output`);
    }
    if (data.native_mcp) assert(proof.targets.mcp, 'Missing MCP native closure');
  } catch (error) { failures.push(`Cannot verify native input gate ${entry.path}: ${error.code ?? error}`); }
  const passed = failures.length === before;
  checkedNativeReports.set(entry.path, passed); return passed;
}
const verifiedCases = [], platformRuntime = new Map(), platformNode = new Map(), platformPython = new Map();
for (const platform of platforms) for (const definition of cases) {
  const key = `${platform}:${definition.id}`, history = attempts.get(key) ?? [];
  history.sort((a, b) => (a.row.stages[0]?.started_at ?? a.entry.data.started_at).localeCompare(b.row.stages[0]?.started_at ?? b.entry.data.started_at));
  const latest = history.at(-1), before = failures.length;
  if (!latest) { failures.push(`Missing consumer: ${key}`); verifiedCases.push({ platform, id: definition.id, status: 'missing' }); continue; }
  const { entry, row } = latest, data = entry.data, unusedFixtureCopies = [];
  try {
  check(await verifyNativeReport(entry), `Invalid native input provenance: ${key}`);
  check(row.status === 'passed', `Latest consumer failed: ${key}`);
  check(row.stages.length > 0 && row.stages.every(stage => stage.status === 'passed' && stage.exit_code === 0), `A stage did not pass: ${key}`);
  for (const label of [`${definition.id}-types`, `${definition.id}-${definition.language === 'typescript' ? 'installed-imports' : 'extra-imports'}`,
    ...(definition.example ? definition.language === 'python'
      ? definition.tests.map((_, index) => `${definition.id}-native-tests${index ? `-${index + 1}` : ''}`)
      : [`${definition.id}-native-tests`] : []),
    ...(definition.supplementaryDependencies?.length ? [`${definition.id}-supplementary-dependencies`] : [])]) check(row.stages.some(stage => stage.label === label), `Required stage absent: ${key}/${label}`);
  for (const dependency of definition.supplementaryDependencies ?? []) {
    const installed = row.supplementary_dependencies?.find(value => value.name === dependency.name);
    const sourceLock = JSON.parse(await readFile(join(root, dependency.lock), 'utf8'));
    const finalLock = JSON.parse(await readFile(join(dirname(entry.path), definition.id, 'package-lock.json'), 'utf8'));
    const resolved = finalLock.packages[`node_modules/${dependency.name}`];
    check(installed?.version === dependency.version && installed?.integrity === sourceLock.packages[`node_modules/${dependency.name}`]?.integrity,
      `Supplementary provider pin differs: ${key}/${dependency.name}`);
    check(resolved?.version === dependency.version && resolved?.integrity === installed?.integrity,
      `Final supplementary provider lock differs: ${key}/${dependency.name}`);
  }
  const languages = definition.language === 'typescript' && definition.name === 'mcp' ? ['typescript', 'python'] : [definition.language];
  for (const artifact of canonical.artifacts.filter(value => languages.includes(value.name.endsWith('.tgz') ? 'typescript' : 'python')))
    check(data.artifacts.find(value => value.name === artifact.name)?.sha256 === artifactHashes[artifact.name], `Consumer used different artifact bytes: ${key}/${artifact.name}`);
  for (const [path, sha256] of Object.entries(canonical.source)) if (languages.some(language => ['sdk', 'middleware'].some(family => path.startsWith(`packages/${family}/${language}/`))))
    check(data.source[path] === sha256, `Consumer package source differs: ${key}/${path}`);
  const runtime = `${data.platform.arch}:${data.native_runtime.sha256}`;
  if (!platformRuntime.has(platform)) platformRuntime.set(platform, runtime);
  check(platformRuntime.get(platform) === runtime, `Mixed native runtimes: ${key}`);
  if (!platformNode.has(platform)) platformNode.set(platform, data.platform.node);
  check(platformNode.get(platform) === data.platform.node, `Mixed Node versions: ${key}`);
  await verifyFile(localPath(data.native_runtime.path, entry), data.native_runtime.sha256, `${key}/runtime`);
  if (definition.name === 'mcp') {
    check(!!data.native_mcp, `MCP binary proof absent: ${key}`);
    if (data.native_mcp) await verifyFile(localPath(data.native_mcp.path, entry), data.native_mcp.sha256, `${key}/mcp`);
  }
  for (const stage of row.stages) await verifyFile(localPath(stage.log, entry), stage.log_sha256, `${key}/${stage.label}`);
  const requiredFixtures = new Set(nativeFixtures(definition).map(fixture => fixture.source));
  for (const source of requiredFixtures) check(row.fixtures.some(fixture => fixture.source === source), `Required fixture absent: ${key}/${source}`);
  for (const fixture of row.fixtures) {
    // Early runs copied entire example directories. The explicit inventory
    // identifies execution inputs; every retained copy still gets hash checked.
    if (requiredFixtures.has(fixture.source)) await verifyFile(join(root, fixture.source), fixture.original_sha256, `${key}/current fixture`);
    else unusedFixtureCopies.push(fixture.source);
    await verifyFile(localPath(fixture.copy, entry), fixture.copied_sha256, `${key}/copied fixture`);
  }
  for (const proof of row.proof_files) await verifyFile(localPath(proof.path, entry), proof.sha256, `${key}/proof`);
  for (const lock of row.exact_locks) await verifyFile(join(root, lock.path), lock.sha256, `${key}/exact lock`);
  for (const lock of row.resolved_locks ?? []) {
    await verifyFile(localPath(lock.path, entry), lock.sha256, `${key}/resolved lock`);
    if (lock.exact_example) await verifyFile(join(root, lock.exact_example), lock.exact_example_sha256, `${key}/sidecar exact lock`);
  }
  if (row.installed_lock_sha256) await verifyFile(join(dirname(entry.path), definition.id, 'package-lock.json'), row.installed_lock_sha256, `${key}/npm lock`);
  const typeFile = definition.language === 'typescript' ? 'consumer.mts' : 'consumer.py';
  await verifyFile(join(dirname(entry.path), definition.id, typeFile), hash(definition.language === 'typescript' ? typescriptConsumer(definition.name) : pythonConsumer(definition.name)), `${key}/current public type consumer`);
  if (definition.language === 'python') {
    const probe = JSON.parse(await readFile(join(dirname(entry.path), definition.id, 'declared-extra-probe.json'), 'utf8'));
    if (!platformPython.has(platform)) platformPython.set(platform, probe.python);
    check(platformPython.get(platform) === probe.python, `Mixed Python versions: ${key}`);
  }
  } catch (error) { failures.push(`Cannot verify consumer ${key}: ${error.code ?? error}`); }
  verifiedCases.push({ platform, id: definition.id, status: failures.length === before ? 'passed' : 'failed', report: entry.path,
    ...(unusedFixtureCopies.length ? { unused_fixture_copies: unusedFixtureCopies } : {}),
    attempts: history.map(value => ({ report: value.entry.path, report_sha256: value.entry.sha256, status: value.row.status, started_at: value.row.stages[0]?.started_at })) });
}
const result = { schema_version: 'caveman-packaging-verification/v1', created_at: new Date().toISOString(), evidence_class: 'local_installed_artifact',
  artifacts: canonical.artifacts, source_provenance: { path: canonicalPath, sha256: await fileHash(canonicalPath) },
  reports: reports.map(({ path, sha256, data }) => ({ path, sha256, summary: data.summary })),
  platforms: platforms.map(os => ({ os, node: platformNode.get(os), python: platformPython.get(os), runtime: platformRuntime.get(os) })),
  cases: verifiedCases, failures, published: false, hosted_provider_tested: false,
  summary: { expected: platforms.length * cases.length, passed: verifiedCases.filter(row => row.status === 'passed').length, valid: failures.length === 0 } };
await writeFile(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ packaging_verification: output, ...result.summary, failures }, null, 2));
if (failures.length) process.exitCode = 1;
