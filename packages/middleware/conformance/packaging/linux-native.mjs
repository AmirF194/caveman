/** Execute the actual native Go build/closure verifier inside the Linux image. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildRuntime, captureRuntimeClosure, validateRuntimeBuild } from '../support/runtime-build.mjs';

assert.equal(process.platform, 'linux', 'Linux build provenance requires a native Linux process');
const args = process.argv.slice(2);
for (const arg of args) assert(/^(--output=|--verification=|--build$)/.test(arg), `Unknown native argument ${arg}`);
const option = name => args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
assert(option('output'), 'Explicit output required');
const output = resolve(option('output'));
const targets = { proxy: 'caveman-proxy', mcp: 'caveman-mcp' };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
if (args.includes('--build')) {
  for (const target of Object.keys(targets)) {
    const report = await buildRuntime({ target, output: resolve(output, 'native', target) });
    console.log(JSON.stringify({ target, binary: report.binary, source_manifest_sha256: report.source_manifest_sha256 }));
  }
}
if (option('verification')) {
  const verification = resolve(option('verification'));
  assert(verification.startsWith(`${output}/`), 'Verification output must be inside the owned output');
  await mkdir(verification, { recursive: true });
  assert.equal((await readdir(verification)).length, 0, 'Verification output must be empty');
  const report = { schema_version: 'caveman-linux-native-verification/v1', native: { platform: process.platform, arch: process.arch },
    started_at: new Date().toISOString(), targets: {}, completed: false };
  try {
    for (const [target, name] of Object.entries(targets)) {
      const path = resolve(output, 'native', target, 'build.json');
      const reference = { path, sha256: hash(await readFile(path)) };
      const currentClosure = await captureRuntimeClosure({ target, output: resolve(verification, target) });
      const build = await validateRuntimeBuild(reference, { target, binary: resolve(output, 'native', target, name), currentClosure });
      report.targets[target] = { build_provenance: reference, binary: build.binary, current_closure: currentClosure };
    }
    report.completed = true;
  } catch (error) { report.error = String(error); throw error; }
  finally { report.completed_at = new Date().toISOString(); await writeFile(resolve(verification, 'verification.json'), `${JSON.stringify(report, null, 2)}\n`); }
  console.log(JSON.stringify({ verified: resolve(verification, 'verification.json'), targets: Object.keys(report.targets) }));
}
assert(args.includes('--build') || option('verification'), 'Select native build or verification');
