/** Gate package execution on a current native Go closure and retain its inputs. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureRuntimeClosure, validateRuntimeBuild } from '../support/runtime-build.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => `${JSON.stringify(value, null, 2)}\n`;
const producerPaths = ['packages/middleware/conformance/packaging/native-provenance.mjs',
  'packages/middleware/conformance/support/runtime-build.mjs', 'packages/middleware/conformance/support/inventory.mjs'];
const producerHashes = async () => Object.fromEntries(await Promise.all(producerPaths.map(async path => [path, hash(await readFile(resolve(root, path)))])));

/** Preserve original bytes. A copied report is never rewritten to claim a new build. */
async function archiveFile(source, path, expected) {
  const bytes = await readFile(source), sha256 = hash(bytes);
  assert.equal(sha256, expected, `Native provenance input changed while archiving: ${source}`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, { flag: 'wx' });
  return { source_path: source, path, sha256, bytes: bytes.length };
}

function commandFiles(commands) {
  const files = new Map();
  const visit = value => {
    if (value === null || typeof value !== 'object') return;
    if (typeof value.path === 'string' && /^[a-f0-9]{64}$/.test(value.sha256 ?? '')) {
      assert(!files.has(value.path) || files.get(value.path) === value.sha256, `Conflicting native command output hash: ${value.path}`);
      files.set(value.path, value.sha256);
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(commands);
  return [...files].map(([path, sha256]) => ({ path, sha256 }));
}

/** Run before any package build, resolver, install, or consumer execution. */
export async function verifyNativeInputs({ output, runtimes }) {
  output = resolve(output);
  await mkdir(output, { recursive: true });
  assert.equal((await readdir(output)).length, 0, 'Native verification output must be empty');
  const report = { schema_version: 'caveman-packaging-native-inputs/v1', evidence_class: 'current_native_runtime_build',
    phase: 'before_package_builds_and_installs', started_at: new Date().toISOString(), completed: false,
    native: { platform: process.platform, arch: process.arch }, producers: await producerHashes(), targets: {} };
  const reportPath = resolve(output, 'verification.json');
  try {
    assert(runtimes?.proxy, 'The native proxy runtime is required');
    for (const [target, input] of Object.entries(runtimes)) {
      assert(['proxy', 'mcp'].includes(target), `Unexpected native runtime target ${target}`);
      const entry = report.targets[target] = { status: 'validating', source_provenance: input.provenance ?? null, binary_path: input.binary ?? null,
        command_outputs: [], sources: [] };
      assert(input.binary, `Set the matching ${target} native binary`);
      assert(input.provenance, `Set ${target === 'proxy' ? 'CAVEMAN_MIDDLEWARE_RUNTIME_PROVENANCE' : 'CAVEMAN_MCP_RUNTIME_PROVENANCE'} before package execution`);
      const directory = resolve(output, target), path = resolve(input.provenance), bytes = await readFile(path);
      const reference = { path, sha256: hash(bytes) };
      entry.build_provenance = await archiveFile(path, resolve(directory, 'original-build.json'), reference.sha256);
      // Verify the original binary, source, commands, and compiler before invoking Go.
      const build = await validateRuntimeBuild(reference, { target, binary: input.binary });
      assert.deepEqual(build.native, report.native, `The ${target} runtime was not built on this native platform and architecture`);
      entry.binary = { path: resolve(input.binary), sha256: build.binary.sha256 };
      entry.native_toolchain = build.toolchain;
      entry.native_toolchain_hashes = build.toolchain_hashes;
      const go = process.env.CAVEMAN_MIDDLEWARE_GO ?? resolve(build.toolchain.GOROOT, 'bin/go');
      const currentClosure = await captureRuntimeClosure({ target, output: resolve(directory, 'current'), go });
      entry.current_closure = { path: resolve(directory, 'current-closure.json'), sha256: hash(encode(currentClosure)),
        manifest_sha256: currentClosure.manifest_sha256 };
      await writeFile(entry.current_closure.path, encode(currentClosure), { flag: 'wx' });
      await validateRuntimeBuild(reference, { target, binary: input.binary, currentClosure });
      let index = 0;
      for (const command of commandFiles([...build.commands, currentClosure.command])) {
        entry.command_outputs.push(await archiveFile(command.path, resolve(directory, 'commands', `${String(++index).padStart(3, '0')}.log`), command.sha256));
      }
      for (const source of build.before.files) {
        entry.sources.push({ repository_path: source.path,
          ...await archiveFile(resolve(root, source.path), resolve(directory, 'source', source.path), source.sha256) });
      }
      // Detect mutation while the archive was being copied, including binary and logs.
      await validateRuntimeBuild(reference, { target, binary: input.binary, currentClosure });
      entry.source_manifest_sha256 = build.source_manifest_sha256;
      entry.status = 'passed';
    }
    assert.deepEqual(await producerHashes(), report.producers, 'Native verification producer changed during the gate');
    report.completed = true;
  } catch (error) {
    report.error = String(error);
    throw error;
  } finally {
    report.completed_at = new Date().toISOString();
    await writeFile(reportPath, encode(report), { flag: 'wx' });
  }
  return { path: reportPath, sha256: hash(await readFile(reportPath)), completed: true,
    targets: Object.fromEntries(Object.entries(report.targets).map(([target, entry]) => [target, {
      binary_sha256: entry.binary.sha256, source_manifest_sha256: entry.source_manifest_sha256 }])) };
}
