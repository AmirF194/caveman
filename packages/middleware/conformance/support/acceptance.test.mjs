/** Adversarial controls use captured native output, never substitute Go tests.
 * Set CAVEMAN_MIDDLEWARE_ACCEPTANCE_REPORT to also check the live build closure
 * and execute a new native verifier process on the current host.
 */
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { root, sha256 } from './inventory.mjs';
import { loadAcceptanceMapping, discoverAcceptanceTests, inspectAcceptanceExecution, compareAcceptanceInputs,
  validateComponentObservation, assessAcceptance, validateRecordedAcceptance, verifyAcceptanceEvidence, testFile, prefix } from './acceptance.mjs';

const live = Boolean(process.env.CAVEMAN_MIDDLEWARE_ACCEPTANCE_REPORT);
const reportPath = process.env.CAVEMAN_MIDDLEWARE_ACCEPTANCE_REPORT ?? 'packages/middleware/conformance/support/acceptance-restart-evidence/report.json';
const encode = value => `${JSON.stringify(value, null, 2)}\n`;
const coveredIds = ['runtime.R2.AC04', 'runtime.R5.AC05', 'runtime.R6.AC02', 'runtime.R6.AC03', 'runtime.R9.AC01', 'runtime.R9.AC04', 'runtime.R11.AC03', 'runtime.R12.AC04', 'proof.R3.AC04'];
const restartPrefix = 'CAVEMAN_MIDDLEWARE_RESTART_PROCESS ';
const childPrefix = 'CAVEMAN_MIDDLEWARE_RESTART_CHILD ';
let report, input, catalog, stdout, stderr, scratch;
before(async () => {
  report = JSON.parse(await readFile(resolve(root, reportPath), 'utf8'));
  input = JSON.parse(await readFile(resolve(root, report.input_snapshot.path), 'utf8'));
  catalog = await loadAcceptanceMapping();
  stdout = await readFile(resolve(root, report.processes[0].stdout.path), 'utf8');
  stderr = await readFile(resolve(root, report.processes[0].stderr.path), 'utf8');
  scratch = await mkdtemp(resolve(tmpdir(), 'caveman-acceptance-controls-'));
});
after(async () => { if (scratch) await rm(scratch, { recursive: true, force: true }); });

const run = (output = stdout, changes = {}) => inspectAcceptanceExecution({ ...report.processes[0], stdout: output, stderr, ...changes }, catalog);
function changeObservation(change, { id, all = false } = {}) {
  let done = false;
  return stdout.split('\n').map(line => {
    if (!line.includes(prefix) || done && !all) return line;
    const start = line.indexOf(prefix) + prefix.length, row = JSON.parse(line.slice(start));
    if (id && row.acceptance_id !== id) return line;
    done = true;
    change(row);
    return line.slice(0, start) + JSON.stringify(row);
  }).join('\n');
}
function changeRestart(change, role = 'worker-a') {
  return stdout.split('\n').map(line => {
    if (!line.includes(restartPrefix)) return line;
    const start = line.indexOf(restartPrefix) + restartPrefix.length, row = JSON.parse(line.slice(start));
    if (row.role !== role) return line;
    change(row);
    return line.slice(0, start) + JSON.stringify(row);
  }).join('\n');
}
function changeChildEvent(record, change, select = event => event.kind === 'completed') {
  let done = false;
  record.stdout = record.stdout.split('\n').map(line => {
    if (done || !line.startsWith(childPrefix)) return line;
    const event = JSON.parse(line.slice(childPrefix.length));
    if (!select(event)) return line;
    done = true;
    change(event);
    return childPrefix + JSON.stringify(event);
  }).join('\n');
}

test('criterion mapping retains the exact text and remaining work for all 180 items', () => {
  assert.equal(catalog.mapping.criteria.length, 180);
  const actual = assessAcceptance(catalog.mapping, run().observations);
  assert.deepEqual(actual.filter(item => item.status === 'covered').map(item => item.id), coveredIds);
  assert.equal(actual.filter(item => item.status === 'partial').length, 15);
  assert.equal(actual.filter(item => item.status === 'missing').length, 156);
  assert.ok(actual.filter(item => item.status !== 'covered').every(item => item.remaining.length > 0));
  const capacity = actual.find(item => item.id === 'runtime.R5.AC07');
  assert.equal(capacity.status, 'partial');
  assert.ok(capacity.remaining.some(text => text.includes('retention interval')));
  assert.ok(capacity.components.some(item => item.name === 'twenty_turn_process_restart' && item.observed));
  assert.ok(actual.find(item => item.id === 'runtime.R3.AC02').remaining.some(text => text.includes('development')));
});

test('all eleven literal Go test IDs and twenty-five exact components passed in captured native output', () => {
  const actual = run();
  assert.equal(actual.tests.length, 11);
  assert.equal(actual.observations.length, 25);
  assert.equal(actual.subprocesses.length, 3);
  assert.deepEqual(actual.tests.map(row => row.id), catalog.tests.map(row => row.id));
  assert.ok(actual.observations.every(row => row.run_nonce === report.processes[0].run_nonce));
});

test('literal source discovery refuses duplicated test/component declarations', async () => {
  const source = await readFile(resolve(root, testFile), 'utf8');
  assert.throws(() => discoverAcceptanceTests(source + '\n' + source), /duplicate literal/);
});

test('missing, forged and stale nonce or process identity cannot back an observation', () => {
  for (const change of [row => { delete row.run_nonce; }, row => { row.run_nonce = 'f'.repeat(64); }, row => { row.run_nonce = report.processes[1].run_nonce; }, row => { row.process_id++; }])
    assert.throws(() => run(changeObservation(change)), /nonce\/process/);
  assert.throws(() => run(stdout, { run_nonce: '0'.repeat(64) }), /nonce\/process/);
  assert.throws(() => run(stdout, { process_id: report.processes[0].process_id + 1 }), /nonce\/process/);
});

test('duplicate and missing observations cannot inflate component coverage', () => {
  const line = stdout.split('\n').find(line => line.includes(prefix));
  assert.throws(() => run(stdout.replace(line, `${line}\n${line}`)), /duplicate component/);
  assert.throws(() => run(stdout.replace(line + '\n', '')), /missing exact criterion component/);
});

test('a component must name its actual criterion, test and literal source line', () => {
  assert.throws(() => run(changeObservation(row => { row.acceptance_id = 'proof.R7.AC01'; })), /literal executed source/);
  assert.throws(() => run(changeObservation(row => { row.component_id = 'proof.R7.AC01::everything_passed'; })), /literal executed source/);
  assert.throws(() => run(changeObservation(row => { row.test_id = catalog.tests.at(-1).id; })), /literal executed source/);
  assert.throws(() => run(stdout.replace(/acceptance_test\.go:\d+:/, 'acceptance_test.go:1:')), /literal executed source/);
});

test('invented pass lines, skipped tests and observations outside executing tests fail', () => {
  const first = catalog.tests[0].name;
  assert.throws(() => run(stdout.replace(`=== RUN   ${first}`, `--- PASS: ${first} (0.01s)\n=== RUN   ${first}`)), /forged or duplicate/);
  assert.throws(() => run(stdout.replace(`=== RUN   ${first}`, '=== RUN   TestInventedSuccess')), /unknown/);
  assert.throws(() => run(stdout.replace(`--- PASS: ${first}`, `--- SKIP: ${first}`)), /failed, skipped/);
  const observed = stdout.split('\n').find(line => line.includes(prefix));
  assert.throws(() => run(stdout.replace(observed + '\n', '') + '\n' + observed), /outside its executing/);
});

test('missing or failed literal test completion cannot earn a pass', () => {
  assert.throws(() => run(stdout.replace(/^--- PASS: .+\n/m, '')), /overlapping|missing/);
  assert.throws(() => run(stdout.replace(/\nPASS\n$/, '\n')), /missing literal/);
  assert.throws(() => run(stdout, { exit_code: 1 }), /failed process/);
  assert.throws(() => run(stdout, { stderr: 'a hidden native failure' }), /stderr/);
});

test('altered runtime measurements and invented process restart are rejected', () => {
  assert.throws(() => run(changeObservation(row => { row.observation.verified_saved_usd = 1; }, { id: 'runtime.R11.AC06' })), /receipt storage/);
  assert.throws(() => run(changeObservation(row => { row.observation.process_restarted = true; }, { id: 'runtime.R5.AC07' })), /invented restart/);
  assert.throws(() => run(changeObservation(row => { row.observation.own_exact_recoveries = 99; }, { id: 'runtime.R9.AC01' })), /scope isolation/);
  assert.throws(() => run(changeObservation(row => { row.observation.cross_principal_frozen_reuse_denials = 99; }, { id: 'proof.R3.AC04' })), /scope isolation/);
  assert.throws(() => run(changeObservation(row => { row.observation.utf8_boundary_adjustments = 0; }, { id: 'runtime.R5.AC05' })), /UTF-8 paging/);
  assert.throws(() => run(changeObservation(row => { row.observation.changed_original_http_status = 200; }, { id: 'runtime.R2.AC04' })), /idempotency/);
  assert.throws(() => run(changeObservation(row => { row.observation.responses_with_existing_durable_choice = 11; }, { id: 'runtime.R6.AC03' })), /durable winner/);
  assert.throws(() => run(changeObservation(row => { row.observation.reused_unique_tokens_reduced = 1; }, { id: 'runtime.R11.AC03' })), /unique reduction/);
  assert.throws(() => run(changeObservation(row => { row.observation.sources[1].source_id = 'document-a'; }, { id: 'runtime.R12.AC04' })), /citation identities/);
  assert.throws(() => validateComponentObservation('imaginary_full_acceptance', { outcome: 'observed', evidence_scope: 'actual_go_runtime_fixture' }), /unknown component/);
});

test('restart proof requires three actually distinct parent-bound processes and the exact native executable', () => {
  const seed = report.processes[0].subprocesses[0];
  for (const change of [row => { row.process_id = seed.process_id; }, row => { row.nonce = seed.nonce; },
    row => { row.parent_process_id++; }, row => { row.parent_nonce = 'f'.repeat(64); }, row => { row.executable_sha256 = 'f'.repeat(64); },
    row => { row.exit_code = 1; }, row => { row.stderr = 'hidden child failure'; }])
    assert.throws(() => run(changeRestart(change)), /restart.*(PID|challenge|identity|executable|exit)/);
  assert.throws(() => run(stdout, { executable_sha256: 'f'.repeat(64) }), /restart child identity/);
  assert.throws(() => run(stdout.split('\n').filter(line => !line.includes(restartPrefix)).join('\n')), /missing actual restart process evidence/);
});

test('restart child native pass lines, complete gated output and fresh challenges cannot be forged', () => {
  assert.throws(() => run(changeRestart(row => { row.stdout = row.stdout.replace('--- PASS:', '--- SKIP:'); })), /failed.*restart child/);
  assert.throws(() => run(changeRestart(row => { row.stdout = row.stdout.replace(/\nPASS\n$/, '\n'); })), /missing restart child/);
  assert.throws(() => run(changeRestart(row => { row.stdout = row.stdout.split('\n').filter(line => !line.includes('"kind":"completed"')).join('\n'); })), /missing restart child/);
  assert.throws(() => run(changeRestart(row => { row.commands[1].challenge = row.nonce; })), /prepare\/release/);
  assert.throws(() => run(changeRestart(row => changeChildEvent(row, event => { event.process_id++; }))), /forged process_id/);
  assert.throws(() => run(changeRestart(row => changeChildEvent(row, event => { event.challenge = row.nonce; }))), /gate event/);
  assert.throws(() => run(changeRestart(row => { row.commands[1].parent_sequence = row.commands[0].parent_sequence; })), /lifecycle|sequence/);
  assert.throws(() => run(changeRestart(row => { row.start_sequence = report.processes[0].subprocesses[0].exit_sequence; })), /seed did not exit/);
});

test('every appended original, frozen replacement byte and recovery marker remains bound across restart', () => {
  assert.throws(() => run(changeRestart(row => changeChildEvent(row, event => { event.views[0].recovered_sha256 = 'f'.repeat(64); }))), /exact original/);
  assert.throws(() => run(changeRestart(row => changeChildEvent(row, event => { event.views[0].reused = false; }))), /earlier frozen/);
  assert.throws(() => run(changeRestart(row => changeChildEvent(row, event => {
    event.views[0].text += 'changed frozen bytes'; event.views[0].sha256 = sha256(event.views[0].text);
  }))), /changed frozen bytes/);
  assert.throws(() => run(changeRestart(row => changeChildEvent(row, event => {
    const view = event.views[0], altered = 'cmw_' + 'f'.repeat(48);
    view.text = view.text.replace(view.recovery_handle, altered); view.recovery_handle = altered; view.sha256 = sha256(view.text);
  }))), /changed frozen bytes/);
  assert.throws(() => run(changeRestart(row => changeChildEvent(row, event => { event.manifest[0].sha256 = 'f'.repeat(64); }, event => event.kind === 'prepared'))), /history source identity/);
  assert.throws(() => run(changeObservation(row => { row.observation.exact_original_recoveries = 366; }, { id: 'runtime.R6.AC02' })), /process restart/);
});

test('an observed component cannot close a broader criterion or turn omitted criteria green', () => {
  const actual = assessAcceptance(catalog.mapping, run().observations);
  for (const id of ['runtime.R5.AC07', 'runtime.R10.AC02', 'runtime.R11.AC01', 'proof.R3.AC01', 'proof.R3.AC03'])
    assert.equal(actual.find(row => row.id === id).status, 'partial');
  assert.equal(actual.find(row => row.id === 'proof.R7.AC01').status, 'missing');
  assert.ok(assessAcceptance(catalog.mapping, []).every(row => row.status === 'missing'));
});

test('tampered, duplicate and coherently rehashed stale source/build snapshots fail', () => {
  compareAcceptanceInputs(input, input);
  const tampered = structuredClone(input);
  tampered.binary.sha256 = '0'.repeat(64);
  assert.throws(() => compareAcceptanceInputs(tampered, input), /tampered source identity/);
  const rehash = value => { const { source_identity_sha256, ...fields } = value; value.source_identity_sha256 = sha256(encode(fields)); return value; };
  const duplicate = structuredClone(input);
  duplicate.source_files.push(duplicate.source_files[0]);
  assert.throws(() => compareAcceptanceInputs(rehash(duplicate), input), /duplicate shared source/);
  const stale = structuredClone(input);
  stale.source_files[0].sha256 = '0'.repeat(64);
  assert.throws(() => compareAcceptanceInputs(rehash(stale), input), /stale shared source\/build/);
});

test('native build closure and historical artifact hashes validate on the current host', { skip: !live }, async () => {
  const actual = await validateRecordedAcceptance(reportPath);
  assert.equal(actual.validation_scope, 'historical_artifacts_only');
  assert.equal(actual.report.counts.covered, 9);
});

test('historical validation rejects forged coverage, duplicate replay nonce and altered raw logs', { skip: !live }, async () => {
  const altered = async (name, mutate) => {
    const value = structuredClone(report);
    await mutate(value);
    const path = resolve(scratch, `${name}.json`);
    await writeFile(path, encode(value));
    return path;
  };
  const inflated = await altered('inflated', value => {
    const row = value.criteria.find(row => row.id === 'runtime.R5.AC07');
    row.status = 'covered'; row.remaining = [];
    value.counts.covered++; value.counts.partial--;
  });
  await assert.rejects(validateRecordedAcceptance(inflated), /criterion text, missing work or coverage/);
  const duplicate = await altered('duplicate', value => { value.processes[1].run_nonce = value.processes[0].run_nonce; });
  await assert.rejects(validateRecordedAcceptance(duplicate), /duplicate or missing independent/);
  const corrupted = await altered('corrupted', async value => {
    const path = resolve(scratch, 'corrupted.log');
    await writeFile(path, stdout.replace('capability_discovery', 'invented_component'));
    value.processes[0].stdout.path = path;
  });
  await assert.rejects(validateRecordedAcceptance(corrupted), /tampered artifact/);
});

test('independent verification executes a new native process with a newly generated nonce', { skip: !live }, async () => {
  const result = await verifyAcceptanceEvidence({ path: reportPath, output: resolve(scratch, 'fresh-verification') });
  const proof = JSON.parse(await readFile(resolve(root, result.path), 'utf8'));
  assert.equal(result.verified_components, 25);
  assert.equal(result.covered, 9);
  assert.equal(result.support_promotion, false);
  assert.ok(!report.processes.some(row => row.run_nonce === proof.process.run_nonce));
  assert.equal(proof.process.input_before, proof.process.input_after);
  assert.equal(proof.process.exit_code, 0);
});
