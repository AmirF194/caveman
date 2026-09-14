/** Run and independently replay one exact LangChain/LangGraph family/language snapshot. */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { certificationInputs, testFiles, driver } from './certification-evidence.mjs';
import { root, sha256 } from '../../../packages/middleware/conformance/support/inventory.mjs';
import { inspectNativeEvidence, assembleNativeCertification, replayNativeCertifications } from '../../../packages/middleware/conformance/support/certify.mjs';

const [family, language] = process.argv.slice(2);
if (!['F05', 'F06'].includes(family) || !['python', 'typescript'].includes(language)) throw new Error('Usage: node examples/middleware/langchain/certify.mjs F05|F06 python|typescript [--replay]');
process.env.CAVEMAN_MIDDLEWARE_CERT_FAMILY = family;
const suffix = process.env.CAVEMAN_MIDDLEWARE_CERT_OUTPUT_SUFFIX;
if (suffix && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(suffix)) throw new Error('Invalid certification output suffix');
const directory = ['examples/middleware/langchain/certification', suffix, `${family}-${language}`].filter(Boolean).join('/');
const encode = value => `${JSON.stringify(value, null, 2)}\n`;
const save = (path, value) => writeFile(resolve(root, path), encode(value));
await mkdir(resolve(root, directory), { recursive: true });
const input = await certificationInputs(family, language), rawOutput = `${directory}/native.tap`;
await save(`${directory}/inputs.json`, input);
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|CLIENT_SECRET|SECRET_ACCESS_KEY|SESSION_TOKEN|GOOGLE_APPLICATION_CREDENTIALS|AWS_PROFILE|CAVEMAN_LANGCHAIN_EVIDENCE|CAVEMAN_MIDDLEWARE_PACKAGED_TEST)/i.test(name)));
env.CAVEMAN_MIDDLEWARE_TEST_FAMILY = 'langchain';
await new Promise((yes, no) => {
  const child = spawn(process.execPath, ['--test', '--test-reporter=tap', language === 'python' ? driver : testFiles.typescript], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; const capture = chunk => { output += chunk; };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  const timer = setTimeout(() => child.kill('SIGTERM'), 180000);
  child.on('error', error => { clearTimeout(timer); no(error); });
  child.on('close', async code => {
    clearTimeout(timer);
    try { await writeFile(resolve(root, rawOutput), output); if (code !== 0) throw new Error(`Native ${family}/${language} failed with exit ${code}; ${rawOutput}`); yes(); } catch (error) { no(error); }
  });
});
const inspected = await inspectNativeEvidence({ input, rawOutput });
const summary = { evidence_class: 'candidate_coverage_not_promotion', input_snapshot_sha256: sha256(encode(input)), raw_output: inspected.raw_output, cells: [], independent_replay: { requested: process.argv.includes('--replay'), artifacts: [] } };
for (const item of inspected.coverage) {
  const row = { id: item.cell.id, backed: item.complete, missing: item.missing, additional_observations: item.additional_observations };
  if (item.complete) {
    const path = `${directory}/${sha256(item.cell.id).slice(0, 16)}.json`; await save(path, assembleNativeCertification(inspected, item.cell.id));
    row.artifact = { path, sha256: sha256(await readFile(resolve(root, path))) };
  }
  summary.cells.push(row);
}
await save(`${directory}/coverage.json`, summary);
process.stdout.write(`${JSON.stringify({ family, language, backed: summary.cells.filter(row => row.backed).length, unbacked: summary.cells.filter(row => !row.backed).map(({ id, missing }) => ({ id, missing })) })}\n`);
if (process.argv.includes('--replay')) {
  try {
    const replay = await replayNativeCertifications({ input, references: summary.cells.filter(row => row.backed).map(row => row.artifact), rawOutput: `${directory}/native-replay.tap` });
    await save(`${directory}/replay.json`, replay);
    summary.independent_replay = { requested: true, result: 'passed', report: { path: `${directory}/replay.json`, sha256: sha256(encode(replay)) }, artifacts: replay.certifications };
    process.stdout.write(`Independent replay passed: ${replay.certifications.length} cells, ${replay.verified_assertions} assertions\n`);
  } catch (error) { summary.independent_replay = { requested: true, result: 'failed', error: error.message, raw_output: error.raw_output ?? null, artifacts: [] }; throw error; }
  finally { await save(`${directory}/coverage.json`, summary); }
}
