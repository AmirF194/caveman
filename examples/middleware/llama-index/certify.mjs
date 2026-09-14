/** Produce and independently replay exact F15 candidates; never promote support. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { root, sha256 } from '../../../packages/middleware/conformance/support/inventory.mjs';
import { assembleNativeCertification, inspectNativeEvidence, replayNativeCertifications } from '../../../packages/middleware/conformance/support/certify.mjs';

const language = 'python';
process.env.CAVEMAN_MIDDLEWARE_CERT_FAMILY = 'F15';
process.env.CAVEMAN_MIDDLEWARE_TEST_FAMILY = 'llama-index';
const helper = await import('./certification-evidence.mjs');
const directory = process.argv.find(value => value.startsWith('--output='))?.slice('--output='.length) ?? `examples/middleware/llama-index/certification/python`;
assert(directory.startsWith('examples/middleware/llama-index/certification/') &&
  !directory.includes('\\') && !directory.split('/').some(part => !part || part === '.' || part === '..'),
  'Use a new repository certification directory for this family');
const encode = value => `${JSON.stringify(value, null, 2)}\n`;
const save = (path, value) => writeFile(resolve(root, path), encode(value));
await mkdir(resolve(root, directory), { recursive: true });
assert.equal((await readdir(resolve(root, directory))).length, 0, 'Capture output must be empty; retain earlier evidence');
const input = await helper.certificationInputs(), rawOutput = `${directory}/native.tap`;
await save(`${directory}/inputs.json`, input);
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|CLIENT_SECRET|SECRET_ACCESS_KEY|SESSION_TOKEN|GOOGLE_APPLICATION_CREDENTIALS|AWS_PROFILE)/i.test(name)));
await new Promise((yes, no) => {
  const child = spawn(process.execPath, ['--test', '--test-reporter=tap', language === 'python' ? helper.driver : helper.testFile], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const capture = chunk => { output += chunk; if (output.length > 8 * 1024 * 1024) child.kill('SIGTERM'); };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  const timer = setTimeout(() => child.kill('SIGTERM'), 180_000);
  child.on('error', error => { clearTimeout(timer); no(error); });
  child.on('close', async code => {
    clearTimeout(timer);
    try { await writeFile(resolve(root, rawOutput), output); if (code !== 0) throw new Error(`Native F15 ${language} failed (${code}); inspect ${rawOutput}`); yes(); }
    catch (error) { no(error); }
  });
});
const inspected = await inspectNativeEvidence({ input, rawOutput });
const summary = { evidence_class: 'candidate_coverage_not_promotion', input_snapshot_sha256: sha256(encode(input)), raw_output: inspected.raw_output,
  cells: [], independent_replay: { requested: false, artifacts: [] } };
for (const item of inspected.coverage) {
  const row = { id: item.cell.id, backed: item.complete, missing: item.missing, additional_observations: item.additional_observations };
  if (item.complete) {
    const path = `${directory}/${sha256(item.cell.id).slice(0, 16)}.json`; await save(path, assembleNativeCertification(inspected, item.cell.id));
    row.artifact = { path, sha256: sha256(await readFile(resolve(root, path))) };
  }
  summary.cells.push(row);
}
await save(`${directory}/coverage.json`, summary);
process.stdout.write(`${JSON.stringify({ family: 'F15', language, backed: summary.cells.filter(cell => cell.backed).length, unbacked: summary.cells.filter(cell => !cell.backed).map(({ id, missing }) => ({ id, missing })) })}\n`);
if (process.argv.includes('--replay')) {
  summary.independent_replay = await replayNativeCertifications({ input, references: summary.cells.filter(cell => cell.backed).map(cell => cell.artifact), rawOutput: `${directory}/native-replay.tap` });
  await save(`${directory}/coverage.json`, summary);
  process.stdout.write(`Independent native replay passed: ${summary.independent_replay.verified_assertions} assertions\n`);
}
