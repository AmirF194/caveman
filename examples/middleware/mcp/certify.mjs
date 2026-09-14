/** Capture and independently replay F13; existing evidence is never overwritten. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { certificationInputs, testFile, driver } from './certification-evidence.mjs';
import { root, sha256 } from '../../../packages/middleware/conformance/support/inventory.mjs';
import { assembleNativeCertification, inspectNativeEvidence, replayNativeCertifications } from '../../../packages/middleware/conformance/support/certify.mjs';

const args = process.argv.slice(2), option = name => args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
for (const arg of args) assert(/^(--language=|--output=|--replay$)/.test(arg), `Unknown argument ${arg}`);
const language = option('language') ?? 'typescript'; assert.ok(['typescript', 'python'].includes(language));
const directory = option('output'); assert.ok(directory?.startsWith('examples/middleware/mcp/certification/'), 'Use a new F13 certification output directory');
assert(!directory.split('/').some(part => part === '..' || !part));
await mkdir(resolve(root, directory), { recursive: true }); assert.equal((await readdir(resolve(root, directory))).length, 0, 'Capture output must be empty');
process.env.CAVEMAN_MIDDLEWARE_CERT_FAMILY = 'F13'; process.env.CAVEMAN_MIDDLEWARE_TEST_FAMILY = 'mcp';
delete process.env.CAVEMAN_MIDDLEWARE_UNCAPTURED_TEST; delete process.env.CAVEMAN_MIDDLEWARE_PACKAGED_TEST;
const encode = value => `${JSON.stringify(value, null, 2)}\n`, save = (path, value) => writeFile(resolve(root, path), encode(value));
const input = await certificationInputs(language), rawOutput = `${directory}/native.tap`;
await save(`${directory}/inputs.json`, input);
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|CLIENT_SECRET|SECRET_ACCESS_KEY|SESSION_TOKEN|GOOGLE_APPLICATION_CREDENTIALS|AWS_PROFILE)/i.test(name)));
await new Promise((yes, no) => {
  const child = spawn(process.execPath, ['--test', '--test-reporter=tap', language === 'python' ? driver : testFile], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', exceeded = false;
  const capture = chunk => { output += chunk; if (output.length > 8 * 1024 * 1024) { exceeded = true; child.kill('SIGTERM'); } };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  const timer = setTimeout(() => { exceeded = true; child.kill('SIGTERM'); }, 180_000);
  child.on('error', error => { clearTimeout(timer); no(error); });
  child.on('close', async code => {
    clearTimeout(timer);
    try { await writeFile(resolve(root, rawOutput), output); assert(code === 0 && !exceeded, `F13 ${language} native execution failed (${code}); ${rawOutput}`); yes(); }
    catch (error) { no(error); }
  });
});
const inspected = await inspectNativeEvidence({ input, rawOutput });
const summary = { evidence_class: 'candidate_coverage_not_promotion', input_snapshot_sha256: sha256(encode(input)), raw_output: inspected.raw_output,
  cells: [], independent_replay: { requested: args.includes('--replay'), result: 'not_run' } };
for (const item of inspected.coverage) {
  const row = { id: item.cell.id, backed: item.complete, missing: item.missing, additional_observations: item.additional_observations };
  if (item.complete) {
    const path = `${directory}/${sha256(item.cell.id).slice(0, 16)}.json`;
    await save(path, assembleNativeCertification(inspected, item.cell.id));
    row.artifact = { path, sha256: sha256(await readFile(resolve(root, path))) };
  }
  summary.cells.push(row);
}
await save(`${directory}/coverage.json`, summary);
assert.equal(summary.cells.length, 11); assert(summary.cells.every(cell => cell.backed), 'Every exact F13 cell requires all eight native observations');
console.log(JSON.stringify({ family: 'F13', language, backed: 11, coverage: `${directory}/coverage.json` }));
if (args.includes('--replay')) {
  try {
    const replay = await replayNativeCertifications({ input, references: summary.cells.map(cell => cell.artifact), rawOutput: `${directory}/native-replay.tap` });
    await save(`${directory}/replay.json`, replay);
    summary.independent_replay = { requested: true, result: 'passed', report: { path: `${directory}/replay.json`, sha256: sha256(encode(replay)) },
      assertions: replay.verified_assertions, artifacts: replay.certifications };
    console.log(JSON.stringify({ independently_replayed: replay.certifications.length, assertions: replay.verified_assertions }));
  } catch (error) {
    summary.independent_replay = { requested: true, result: 'failed', error: error.message, raw_output: error.raw_output ?? null };
    throw error;
  } finally { await save(`${directory}/coverage.json`, summary); }
}
