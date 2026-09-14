/** Execute shared Go acceptance components without promoting incomplete criteria.
 *
 * Capture:
 * TMPDIR=/private/tmp node acceptance.mjs --binary=/path/middleware.test \
 *   --provenance=/path/build.json --output=/new/evidence/directory
 *
 * Verification always executes another fresh native process:
 * TMPDIR=/private/tmp node acceptance.mjs --verify=/path/report.json
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { root, parseSpecification, sha256 } from './inventory.mjs';
import { specificationFiles } from './catalog.mjs';
import { runtimeBuildSources } from './runtime-build.mjs';

export const testFile = 'proxy/internal/middleware/acceptance_test.go';
export const mappingFile = 'packages/middleware/conformance/support/acceptance-criteria.json';
export const prefix = 'CAVEMAN_MIDDLEWARE_OBSERVATION ';
export const restartPrefix = 'CAVEMAN_MIDDLEWARE_RESTART_PROCESS ';
const childPrefix = 'CAVEMAN_MIDDLEWARE_RESTART_CHILD ';
const childTest = 'TestMiddlewareRestartWorkerProcess';
const restartTest = 'TestMiddlewareAcceptanceTwentyTurnsAcrossProcesses';
const moduleFile = relative(root, fileURLToPath(import.meta.url)).split(sep).join('/');
const hashPattern = /^[a-f0-9]{64}$/;
const encode = value => `${JSON.stringify(value, null, 2)}\n`;
const fail = message => { throw new Error(`Shared acceptance refused: ${message}`); };
const check = (value, message) => { if (!value) fail(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonempty = value => typeof value === 'string' && value.length > 0;
const canonical = value => JSON.stringify(value, function (key, item) {
  return object(item) ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item;
});
const digest = value => sha256(encode(value));
const reference = async path => ({ path, sha256: sha256(await readFile(resolve(root, path))) });
const portable = path => {
  const value = relative(root, resolve(path));
  return value === '..' || value.startsWith(`..${sep}`) ? resolve(path) : value.split(sep).join('/');
};

/** Literal declarations and component calls, independent of stored evidence. */
export function discoverAcceptanceTests(source) {
  const declarations = [...source.matchAll(/^func (TestMiddlewareAcceptance\w+)\(t \*testing\.T\) \{/gm)];
  check(declarations.length > 0, 'no literal shared acceptance tests');
  const tests = [], components = [];
  const line = offset => source.slice(0, offset).split('\n').length;
  for (const [index, declaration] of declarations.entries()) {
    const name = declaration[1], id = `${testFile}::${name}`;
    tests.push({ id, file: testFile, name, line: line(declaration.index), declaration: declaration[0], sha256: sha256(source) });
    const body = source.slice(declaration.index, declarations[index + 1]?.index ?? source.length);
    const calls = [...body.matchAll(/acceptance\(t, "([a-z][a-z0-9_]+)", \[\]string\{([^}]+)\},/g)];
    check(calls.length > 0, `${name}: no literal component observations`);
    for (const call of calls) {
      const ids = [...call[2].matchAll(/"((?:runtime|proof)\.R\d+\.AC\d+)"/g)].map(match => match[1]);
      check(ids.length > 0 && call[2].replace(/"(?:runtime|proof)\.R\d+\.AC\d+"|\s|,/g, '') === '', `${name}: nonliteral criterion IDs`);
      for (const acceptance_id of ids) components.push({ id: `${acceptance_id}::${call[1]}`, acceptance_id,
        name: call[1], test_id: id, line: line(declaration.index + call.index) });
    }
  }
  check(new Set(tests.map(test => test.id)).size === tests.length, 'duplicate literal test ID');
  check(new Set(components.map(component => component.id)).size === components.length, 'duplicate literal component ID');
  const restartLogs = [...source.matchAll(/t\.Log\("CAVEMAN_MIDDLEWARE_RESTART_PROCESS "/g)];
  check(restartLogs.length === 1 && tests.some(test => test.name === restartTest), 'missing literal restart process protocol');
  return { tests, components, restart_protocol: { test_id: `${testFile}::${restartTest}`, child_test: childTest, line: line(restartLogs[0].index) } };
}

export async function loadAcceptanceMapping() {
  const mapping = JSON.parse(await readFile(resolve(root, mappingFile), 'utf8'));
  const requirements = await parseSpecification(), criteria = requirements.flatMap(requirement => requirement.acceptance);
  check(requirements.length === 29 && criteria.length === 180, 'normative acceptance inventory changed');
  check(mapping.schema_version === 1 && mapping.producer === 'caveman-middleware-criterion-decomposition-v1' &&
    mapping.evidence_scope === 'actual_go_runtime_fixture', 'invalid criterion mapping');
  assert.deepEqual(mapping.counts, { requirements: 29, acceptance_items: 180 }, 'criterion counts changed');
  assert.deepEqual(mapping.specifications, await Promise.all(specificationFiles.map(reference)), 'stale specification mapping');
  check(mapping.criteria?.length === criteria.length, 'criterion mapping omitted required items');
  const declared = discoverAcceptanceTests(await readFile(resolve(root, testFile), 'utf8'));
  const components = new Map(declared.components.map(component => [component.id, component]));
  const mapped = [];
  for (const [index, expected] of criteria.entries()) {
    const item = mapping.criteria[index];
    assert.deepEqual({ id: item.id, text: item.text, path: item.path, line: item.line }, expected, 'criterion text or order changed');
    check(item.text_sha256 === sha256(expected.text), `${expected.id}: stale criterion text`);
    check(['complete', 'partial', 'missing'].includes(item.assessment) && Array.isArray(item.components) && Array.isArray(item.remaining), `${expected.id}: invalid decomposition`);
    check(item.assessment === 'complete' ? item.remaining.length === 0 && item.components.length > 0 : item.remaining.length > 0, `${expected.id}: incomplete text promoted`);
    check(item.assessment === 'missing' ? item.components.length === 0 : item.components.length > 0, `${expected.id}: invalid component coverage`);
    check(item.remaining.every(nonempty), `${expected.id}: unexplained remaining text`);
    for (const selected of item.components) {
      const actual = components.get(selected.id);
      check(actual && actual.acceptance_id === item.id && actual.name === selected.name && actual.test_id === selected.test_id && nonempty(selected.description), `${expected.id}: undeclared or changed component`);
      mapped.push(selected.id);
    }
  }
  check(new Set(mapped).size === mapped.length && mapped.length === components.size && [...components.keys()].every(id => mapped.includes(id)), 'duplicate, omitted or unknown component mapping');
  return { mapping, ...declared };
}

/** These validate emitted mechanism observations, not handwritten pass fields. */
export function validateComponentObservation(name, value) {
  check(object(value) && value.outcome === 'observed' && value.evidence_scope === 'actual_go_runtime_fixture', `${name}: missing runtime observation`);
  switch (name) {
    case 'capability_discovery':
      check(nonempty(value.runtime_build) && value.protocol === 1 && nonempty(value.policy_revision) && positive(value.transform_count) &&
        value.persistent === true && value.recovery === true && positive(value.retention_seconds), 'capability discovery is incomplete');
      assert.deepEqual(value.limits, { deadline_ms: 100, request_bytes: 2097152, segment_bytes: 524288, page_bytes: 262144 }, 'capability limits changed');
      break;
    case 'engine_semantic_corpus': {
      const names = ['json_enumeration_and_arithmetic', 'exact_code_copy', 'patch_generation', 'csv_anomaly', 'yaml_drift',
        'long_logs_missing_fact', 'unicode_crlf', 'original_offset_citation', 'identical_document_a', 'identical_document_b'];
      check(Array.isArray(value.cases), 'semantic corpus cases absent');
      assert.deepEqual(value.cases.map(row => row.case), names, 'semantic corpus omitted, duplicated or reordered a case');
      for (const row of value.cases) {
        check(hashPattern.test(row.source_sha256) && positive(row.utf8_bytes) && nonempty(row.status) && nonempty(row.reason), 'semantic source observation incomplete');
        if (row.recovered_sha256 !== undefined) {
          check(row.recovered_sha256 === row.source_sha256 && nonempty(row.transform_id) && object(row.measurement), 'semantic exact recovery absent');
          const measured = row.measurement;
          check(positive(measured.tokens_before) && nonempty(measured.tokenizer) && measured.scope === 'segment' &&
            measured.overhead_coverage === 'segment_and_declared_recovery_tool' && measured.net_reduction_positive === true &&
            measured.basis === 'inferred' && measured.verified_saved_usd === 0, 'semantic measurement exceeded its evidence');
        }
      }
      const citation = value.cases.find(row => row.case === 'original_offset_citation');
      check(citation.status === 'bypassed' && citation.reason === 'protected' && hashPattern.test(citation.original_quote_sha256) && positive(citation.original_byte_offset), 'original-byte citation protection absent');
      check(value.actual_compressed_cases === value.cases.filter(row => row.recovered_sha256).length && positive(value.actual_compressed_cases) && value.unknown_transform_http_status === 400, 'semantic corpus was a no-op or guessed capability');
      break;
    }
    case 'authenticated_scope_isolation':
      for (const [key, expected] of Object.entries({ interleaved_scopes: 100, authenticated_principals: 2, own_exact_recoveries: 100,
        cross_principal_or_global_hash_denials: 300, same_principal_namespace_denials: 100, unauthenticated_denials: 100,
        own_frozen_reuses: 100, cross_principal_frozen_reuse_denials: 100, same_principal_namespace_reuse_denials: 100 })) check(value[key] === expected, `scope isolation missing ${key}`);
      break;
    case 'browser_and_fetch_url_refusal':
      check(value.missing_principal_resolver_rejected === true && Array.isArray(value.refusals) && value.refusals.length === 7, 'HTTP refusal controls absent');
      assert.deepEqual(value.refusals.map(row => row.header ?? row.field), ['Origin', 'Sec-Fetch-Site', 'url', 'fetch_url', 'tenant_id', 'authorization', 'api_key'], 'HTTP refusal controls changed');
      check(value.refusals.every(row => row.header ? row.status === 403 : row.status === 400 && positive(row.body_bytes) && row.body_bytes <= 128), 'unbounded or successful refusal result');
      break;
    case 'queued_deadline':
      check(value.configured_deadline_ms === 100 && positive(value.queue_capacity) && value.result_status === 504 && value.reason === 'deadline' &&
        value.within_25ms_scheduler_tolerance === true && value.remaining_queue_slots_used === 0 && value.stored_original_bytes === 0, 'shared queue deadline observation absent');
      break;
    case 'retained_capacity_original':
      check(value.configured_ccr_bytes === 131072 && positive(value.accepted_originals_before_capacity) && value.capacity_http_status === 503 &&
        positive(value.retention_seconds) && hashPattern.test(value.first_original_sha256) && value.reopened_original_sha256 === value.first_original_sha256 &&
        value.store_reopened === true && value.process_restarted === false && value.retention_elapsed === false, 'capacity observation invented restart or retention proof');
      break;
    case 'receipt_storage': {
      check(value.prepared_plan_provider_receipts === 0 && nonempty(value.tokenizer) && value.measurement_scope === 'segment' && value.basis === 'inferred' &&
        value.verified_saved_usd === 0 && value.duplicate_completed_calls === 2 && value.persisted_completed_rows === 1 &&
        value.missing_usage_rejected_as_complete === true && Array.isArray(value.rows) && value.rows.length === 3, 'receipt storage observation incomplete');
      assert.deepEqual(value.rows.map(row => row.event_kind).sort(), ['cancelled', 'completed', 'dispatch_intent'], 'receipt events missing or duplicated');
      for (const row of value.rows) {
        check(nonempty(row.attempt_id) && nonempty(row.logical_call_id) && row.plan_reference_matches === true && row.scope_matches === true, 'receipt identity lost');
        if (row.event_kind === 'completed') check(row.usage?.provenance === 'client_observed_sdk' && row.usage.complete === true && row.usage.input_tokens === 321 && row.usage.output_tokens === 17, 'fixture usage or provenance changed');
        else check(row.usage === null, 'unknown usage became measured zero');
      }
      break;
    }
    case 'bounded_exact_recovery_pages':
      check(hashPattern.test(value.source_sha256) && value.joined_sha256 === value.source_sha256 && positive(value.total_bytes) &&
        value.page_limit === 91 && value.page_cap === 262144 && value.pages > 1 && positive(value.utf8_boundary_adjustments) &&
        value.full_original_complete === true && value.excerpt_kind === 'excerpt' && value.excerpt_complete === false &&
        value.excerpt_continuation === 0 && value.query_limit === 512 && value.query_match_present === true, 'exact bounded recovery or UTF-8 paging absent');
      assert.deepEqual(value.refusals, [
        { case: 'over_page_cap', code: 'payload_limit' }, { case: 'under_one_rune', code: 'payload_limit' },
        { case: 'negative_offset', code: 'invalid_request' }, { case: 'middle_of_rune', code: 'invalid_range' },
        { case: 'past_original', code: 'invalid_range' }, { case: 'over_query_cap', code: 'invalid_request' },
        { case: 'query_offset', code: 'invalid_range' },
      ], 'recovery bounds or typed range refusals changed');
      break;
    case 'distinct_recovered_source_identity':
      check(value.distinct_scoped_handles === true && Array.isArray(value.sources) && value.sources.length === 2, 'distinct recovery source identities absent');
      assert.deepEqual(value.sources.map(row => row.source_id), ['document-a', 'document-b'], 'original citation identities changed');
      check(value.sources.every(row => hashPattern.test(row.original_sha256) && row.recovered_sha256 === row.original_sha256 && positive(row.utf8_bytes)) &&
        value.sources[0].original_sha256 === value.sources[1].original_sha256 && value.sources[0].utf8_bytes === value.sources[1].utf8_bytes, 'equal source bytes were not exactly recovered with distinct identities');
      break;
    case 'unique_content_credit_on_reuse':
      check(value.initial_sources === 2 && value.reused_replacements === 2 && value.initial_unique_credit_positive === true &&
        value.reused_unique_tokens_reduced === 0 && value.new_source_unique_tokens_reduced === 0 && value.persisted_original_credit_rows === 1 &&
        value.measurement_scope === 'segment' && nonempty(value.tokenizer) && value.overhead_coverage === 'segment_and_declared_recovery_tool' &&
        value.basis === 'inferred' && value.verified_saved_usd === 0, 'reuse invented unique reduction or request-level accounting');
      break;
    case 'scoped_idempotent_replacement':
      check(value.identical_scoped_replays === 3 && value.replacement_bytes_equal === true && value.replacement_set_equal === true &&
        value.changed_original_http_status === 409 && value.changed_original_error === 'identity_conflict' &&
        hashPattern.test(value.original_sha256) && value.recovered_after_rejection_sha256 === value.original_sha256, 'scoped idempotency or conflict protection absent');
      break;
    case 'concurrent_durable_replacement':
      check(value.concurrent_requests === 12 && value.runtime_instances === 2 && value.separate_processes === false &&
        value.equal_replacement_bytes === true && value.responses_with_existing_durable_choice === 12 && value.observed_before_response_write === true &&
        value.persisted_choice_rows === 1 && value.persisted_plan_rows === 12 && value.first_publications === 1, 'concurrent durable winner observation absent or process scope inflated');
      break;
    case 'twenty_turn_process_restart':
      for (const [key, expected] of Object.entries({ append_only_turns: 20, seed_turns: 10, resumed_turns: 10, separate_processes: 3,
        concurrent_workers: 2, gated_concurrent_turns: 10, earlier_byte_comparisons: 335, exact_original_recoveries: 365, retained_originals: 20 }))
        check(value[key] === expected, `process restart missing ${key}`);
      check(value.seed_exited_before_workers_started === true && value.replacement_bytes_and_markers_equal === true &&
        value.both_stores_reopened_in_each_worker === true && value.retention_elapsed === false, 'process restart or retention scope changed');
      check(Array.isArray(value.original_sha256s) && value.original_sha256s.length === 20 && new Set(value.original_sha256s).size === 20 &&
        value.original_sha256s.every(value => hashPattern.test(value)), 'process restart omitted appended originals');
      break;
    default: fail(`unknown component validator ${name}`);
  }
}

/** Pure parser; supplied nonce strings alone never establish a fresh process. */
export function inspectAcceptanceExecution({ stdout, stderr = '', run_nonce, process_id, exit_code, executable_sha256 }, catalog) {
  check(hashPattern.test(run_nonce ?? '') && positive(process_id) && exit_code === 0, 'missing native execution identity or failed process');
  check(typeof stdout === 'string' && typeof stderr === 'string' && stderr.length === 0, 'native output absent or stderr is nonempty');
  const knownTests = new Map(catalog.tests.map(test => [test.name, test]));
  const knownComponents = new Map(catalog.components.map(component => [component.id, component]));
  const started = new Set(), passed = new Set(), observations = new Map(), subprocesses = [];
  let active = null, final = false;
  for (const line of stdout.split('\n')) {
    const start = line.match(/^=== RUN   (\w+)$/), pass = line.match(/^--- PASS: (\w+) \(\d+(?:\.\d+)?s\)$/);
    if (start) {
      check(!final && !active && knownTests.has(start[1]) && !started.has(start[1]), 'unknown, overlapping or duplicate executed test ID');
      started.add(start[1]); active = start[1]; continue;
    }
    if (pass) {
      check(!final && active === pass[1] && !passed.has(pass[1]), 'forged or duplicate literal test success');
      passed.add(pass[1]); active = null; continue;
    }
    if (line === 'PASS') { check(!active && !final, 'duplicate or premature terminal PASS'); final = true; continue; }
    check(!/^(?:FAIL|--- (?:FAIL|SKIP)|=== (?:PAUSE|CONT))\b/.test(line), 'failed, skipped or unexpected parallel test');
    if (line.includes(restartPrefix)) {
      const match = line.match(/^\s+acceptance_test\.go:(\d+): CAVEMAN_MIDDLEWARE_RESTART_PROCESS (.+)$/);
      check(match && active === restartTest && !final && Number(match[1]) === catalog.restart_protocol.line, 'restart process is outside its literal executing Go test');
      try { subprocesses.push(JSON.parse(match[2])); } catch { fail('malformed restart process transcript'); }
      continue;
    }
    if (!line.includes(prefix)) continue;
    const match = line.match(/^\s+acceptance_test\.go:(\d+): CAVEMAN_MIDDLEWARE_OBSERVATION (.+)$/);
    check(match && active && !final, 'observation is outside its executing Go test');
    let row;
    try { row = JSON.parse(match[2]); } catch { fail('malformed component observation'); }
    const component = knownComponents.get(row.component_id);
    check(component && row.acceptance_id === component.acceptance_id && row.assertion === component.name && row.test_id === component.test_id &&
      component.test_id === knownTests.get(active).id && Number(match[1]) === component.line, 'component is not its literal executed source declaration');
    check(row.run_nonce === run_nonce && row.process_id === process_id, 'forged, stale or missing observation nonce/process');
    check(!observations.has(component.id), 'duplicate component observation');
    validateComponentObservation(component.name, row.observation);
    observations.set(component.id, row);
  }
  check(final && !active && started.size === knownTests.size && passed.size === knownTests.size && [...knownTests.keys()].every(name => started.has(name) && passed.has(name)), 'missing literal executed test success');
  check(observations.size === knownComponents.size && [...knownComponents.keys()].every(id => observations.has(id)), 'missing exact criterion component');
  validateRestartProcesses(subprocesses, { run_nonce, process_id, executable_sha256,
    observation: observations.get('runtime.R6.AC02::twenty_turn_process_restart')?.observation });
  return { tests: catalog.tests.map(test => ({ id: test.id, result: 'passed' })),
    observations: [...observations.values()].sort((left, right) => left.component_id.localeCompare(right.component_id)), subprocesses };
}

/** Parent-captured child stdout is checked against the actual executable and
 * process invocation. Random handles/nonces stay in raw transcripts; comparison
 * across independent replays uses only the asserted deterministic predicates. */
export function validateRestartProcesses(processes, { run_nonce, process_id, executable_sha256, observation }) {
  check(Array.isArray(processes) && processes.length === 3 && hashPattern.test(executable_sha256 ?? '') && object(observation), 'missing actual restart process evidence');
  assert.deepEqual(processes.map(row => row.role), ['seed', 'worker-a', 'worker-b'], 'restart roles duplicated or missing');
  check(new Set([process_id, ...processes.map(row => row.process_id)]).size === 4 &&
    new Set([run_nonce, ...processes.map(row => row.nonce)]).size === 4, 'restart reused a parent/child PID or challenge');
  const allSequence = [], turnResults = new Map(), gates = new Map(), views = new Map(), manifests = new Map();
  let comparisons = 0, recoveries = 0;
  for (const record of processes) {
    check(record.test_id === `${testFile}::${restartTest}` && positive(record.process_id) && record.parent_process_id === process_id &&
      record.parent_nonce === run_nonce && hashPattern.test(record.nonce ?? '') && record.executable_sha256 === executable_sha256 &&
      record.exit_code === 0 && record.stderr === '' && typeof record.stdout === 'string', 'restart child identity, executable or exit changed');
    const events = [];
    let active = false, passed = false, final = false;
    for (const line of record.stdout.split('\n')) {
      if (line === `=== RUN   ${childTest}`) { check(!active && !passed && !final, 'duplicate restart child start'); active = true; continue; }
      if (new RegExp(`^--- PASS: ${childTest} \\(\\d+(?:\\.\\d+)?s\\)$`).test(line)) {
        check(active && !passed && !final, 'forged restart child pass'); active = false; passed = true; continue;
      }
      if (line === 'PASS') { check(passed && !active && !final, 'premature restart child PASS'); final = true; continue; }
      check(!/^(?:FAIL|--- (?:FAIL|SKIP)|=== (?:RUN|PAUSE|CONT))\b/.test(line), 'failed or unexpected restart child test');
      if (!line.startsWith(childPrefix)) { check(line === '', 'unexpected restart child output'); continue; }
      check(active && !passed && !final, 'restart child observation outside its executing test');
      let event;
      try { event = JSON.parse(line.slice(childPrefix.length)); } catch { fail('malformed restart child event'); }
      for (const field of ['role', 'process_id', 'parent_process_id', 'parent_nonce', 'nonce', 'executable_sha256'])
        check(event[field] === record[field], `restart child forged ${field}`);
      events.push(event);
    }
    check(final && passed && !active && events.length === 22 && record.received?.length === 22 && record.commands?.length === 21, 'missing restart child events or native completion');
    const sequence = [record.start_sequence];
    const receive = (eventIndex, kind, turn, challenge) => {
      const event = events[eventIndex], received = record.received[eventIndex];
      check(event.kind === kind && event.turn === turn && event.challenge === challenge &&
        received.kind === kind && received.turn === turn && received.challenge === challenge, 'restart gate event or parent receipt changed');
      sequence.push(received.parent_sequence);
      return event;
    };
    const command = (index, action, turn, challenge) => {
      const value = record.commands[index];
      check(value.action === action && value.turn === turn && value.challenge === challenge, 'restart prepare/release command changed');
      sequence.push(value.parent_sequence);
      return value;
    };
    receive(0, 'ready', -1, '');
    const first = record.role === 'seed' ? 0 : 10;
    for (let offset = 0; offset < 10; offset++) {
      const turn = first + offset, challenge = record.commands[offset * 2].challenge;
      check(hashPattern.test(challenge ?? ''), 'missing fresh turn gate');
      command(offset * 2, 'prepare', turn, challenge);
      const prepared = receive(offset * 2 + 1, 'prepared', turn, challenge);
      const release = command(offset * 2 + 1, 'release', turn, challenge);
      const completed = receive(offset * 2 + 2, 'completed', turn, challenge);
      check(prepared.manifest?.length === turn + 2 && completed.views?.length === turn + 1, 'restart omitted append-only history or views');
      for (const [index, item] of prepared.manifest.entries()) {
        check(item.id === (index === 0 ? 'msg-0' : `msg-${String(index).padStart(2, '0')}`) && hashPattern.test(item.sha256 ?? '') &&
          (index === 0 ? item.sha256 === sha256('user protected') : item.sha256 === observation.original_sha256s[index - 1]), 'restart history source identity changed');
        if (manifests.has(index)) check(canonical(item) === canonical(manifests.get(index)), 'restart history edited instead of appended');
        else manifests.set(index, item);
      }
      for (const [index, view] of completed.views.entries()) {
        check(view.segment_id === `tool-turn-${String(index).padStart(2, '0')}` && view.source_id === `document-turn-${String(index).padStart(2, '0')}` &&
          view.original_sha256 === observation.original_sha256s[index] && view.recovered_sha256 === view.original_sha256 && positive(view.recovered_bytes) &&
          typeof view.text === 'string' && view.sha256 === sha256(view.text) && /^cmw_[a-f0-9]{48}$/.test(view.recovery_handle ?? '') &&
          view.text.includes(`handle=${view.recovery_handle}`), 'restart replacement bytes, marker or exact original changed');
        if (index < turn) { check(view.reused === true && view.unique_original === false, 'earlier frozen view was recompressed or credited again'); comparisons++; }
        const identity = { segment_id: view.segment_id, source_id: view.source_id, original_sha256: view.original_sha256, text: view.text,
          sha256: view.sha256, recovery_handle: view.recovery_handle, recovered_sha256: view.recovered_sha256, recovered_bytes: view.recovered_bytes };
        if (views.has(index)) check(canonical(identity) === canonical(views.get(index)), 'restarted workers changed frozen bytes or recovery markers');
        else views.set(index, identity);
        recoveries++;
      }
      if (!gates.has(turn)) gates.set(turn, []);
      gates.get(turn).push({ role: record.role, challenge, prepared: record.received[offset * 2 + 1].parent_sequence,
        released: release.parent_sequence, completed: record.received[offset * 2 + 2].parent_sequence });
      turnResults.set(`${record.role}:${turn}`, completed);
    }
    command(20, 'stop', first + 9, record.nonce);
    receive(21, 'closed', first + 9, record.nonce);
    sequence.push(record.exit_sequence);
    check(sequence.every(positive) && sequence.every((value, index) => index === 0 || value > sequence[index - 1]), 'restart child lifecycle order changed');
    allSequence.push(...sequence);
  }
  const [seed, workerA, workerB] = processes;
  check(seed.exit_sequence < workerA.start_sequence && seed.exit_sequence < workerB.start_sequence &&
    workerA.start_sequence < workerB.exit_sequence && workerB.start_sequence < workerA.exit_sequence, 'seed did not exit before overlapping worker processes');
  assert.deepEqual(allSequence.sort((left, right) => left - right), Array.from({ length: allSequence.length }, (_, index) => index + 1), 'restart parent event sequence duplicated or omitted');
  const challenges = [];
  for (const [turn, group] of gates) {
    check(group.length === (turn < 10 ? 1 : 2) && new Set(group.map(row => row.challenge)).size === 1, 'restart worker turn gate missing or mismatched');
    check(Math.max(...group.map(row => row.prepared)) < Math.min(...group.map(row => row.released)) &&
      Math.max(...group.map(row => row.released)) < Math.min(...group.map(row => row.completed)), 'workers were not prepared together before turn release');
    challenges.push(group[0].challenge);
  }
  check(new Set([...challenges, run_nonce, ...processes.map(row => row.nonce)]).size === 24 && gates.size === 20 && turnResults.size === 30 &&
    views.size === 20 && comparisons === observation.earlier_byte_comparisons && recoveries === observation.exact_original_recoveries, 'restart claims exceed actual turn, byte comparison or recovery evidence');
}

async function producerModules() {
  const paths = new Set(), pending = [moduleFile];
  while (pending.length) {
    const path = pending.pop();
    if (paths.has(path)) continue;
    check(!path.startsWith('../') && !path.startsWith('/'), 'producer module escaped repository');
    check(relative(root, await realpath(resolve(root, path))).split(sep)[0] !== '..', 'producer module symlink escaped repository');
    paths.add(path);
    const source = await readFile(resolve(root, path), 'utf8');
    for (const match of source.matchAll(/(?:from\s*|import\s*\(\s*)['"](\.[^'"]+\.mjs)['"]/g))
      pending.push(relative(root, resolve(root, dirname(path), match[1])).split(sep).join('/'));
  }
  return [...paths].sort();
}

export async function captureAcceptanceInputs({ binary, provenance }) {
  const catalog = await loadAcceptanceMapping();
  const build = await runtimeBuildSources({ binary, provenance, target: 'middleware-tests' });
  const paths = [...new Set([...build.sources.map(source => source.path), ...await producerModules(), ...specificationFiles, mappingFile])].sort();
  const snapshot = { schema_version: 1, evidence_class: 'shared_acceptance_inputs', build_provenance: build.reference, binary: build.binary,
    producer_runtime: { platform: process.platform, arch: process.arch, node: process.version, executable: await reference(process.execPath) },
    source_files: await Promise.all(paths.map(reference)), tests: catalog.tests, components: catalog.components, restart_protocol: catalog.restart_protocol,
    criterion_mapping: await reference(mappingFile), specifications: catalog.mapping.specifications };
  return { snapshot: { ...snapshot, source_identity_sha256: digest(snapshot) }, catalog };
}

export function compareAcceptanceInputs(recorded, current) {
  for (const value of [recorded, current]) {
    check(value?.schema_version === 1 && value.evidence_class === 'shared_acceptance_inputs' && Array.isArray(value.source_files), 'invalid shared source snapshot');
    const { source_identity_sha256, ...fields } = value;
    check(hashPattern.test(source_identity_sha256 ?? '') && source_identity_sha256 === digest(fields), 'tampered source identity');
    check(new Set(value.source_files.map(file => file.path)).size === value.source_files.length, 'duplicate shared source input');
  }
  check(canonical(recorded) === canonical(current), 'stale shared source/build identity');
}

const liveExecutions = new WeakSet();
function observedValues(execution) {
  return execution.observations.map(({ acceptance_id, component_id, assertion, test_id, observation }) => ({ acceptance_id, component_id, assertion, test_id, observation }));
}

async function executeNative({ binary, provenance, output, name, priorNonces = [] }) {
  const before = await captureAcceptanceInputs({ binary, provenance });
  const nonce = randomBytes(32).toString('hex');
  check(!priorNonces.includes(nonce), 'reused process challenge');
  const args = ['-test.v', '-test.count=1', `-test.run=^(?:${before.catalog.tests.map(test => test.name).join('|')})$`, '-test.timeout=60s'];
  const started = process.hrtime.bigint();
  let stdout = '', stderr = '', exceeded = false, processID;
  const exitCode = await new Promise((yes, no) => {
    const env = Object.fromEntries(['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'].filter(name => process.env[name]).map(name => [name, process.env[name]]));
    env.TMPDIR = process.env.TMPDIR || tmpdir();
    env.CAVEMAN_MIDDLEWARE_ACCEPTANCE_NONCE = nonce;
    const child = spawn(resolve(binary), args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    processID = child.pid;
    let hardStop;
    const stop = () => { exceeded = true; child.kill('SIGTERM'); hardStop ??= setTimeout(() => child.kill('SIGKILL'), 5000); };
    const timer = setTimeout(stop, 65000);
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length + stderr.length > 8 * 1024 * 1024) stop(); });
    child.stderr.on('data', chunk => { stderr += chunk; if (stdout.length + stderr.length > 8 * 1024 * 1024) stop(); });
    child.once('error', error => { clearTimeout(timer); clearTimeout(hardStop); no(error); });
    child.once('close', code => { clearTimeout(timer); clearTimeout(hardStop); yes(code); });
  });
  const stdoutPath = resolve(output, `${name}.log`), stderrPath = resolve(output, `${name}.stderr`);
  await writeFile(stdoutPath, stdout, { flag: 'wx' });
  await writeFile(stderrPath, stderr, { flag: 'wx' });
  check(!exceeded, `${name}: output or deadline limit exceeded`);
  const parsed = inspectAcceptanceExecution({ stdout, stderr, run_nonce: nonce, process_id: processID, exit_code: exitCode,
    executable_sha256: before.snapshot.binary.sha256 }, before.catalog);
  const after = await captureAcceptanceInputs({ binary, provenance });
  compareAcceptanceInputs(before.snapshot, after.snapshot);
  const result = { schema_version: 1, program: resolve(binary), executable_sha256: before.snapshot.binary.sha256, args, cwd: '.', process_id: processID, run_nonce: nonce,
    exit_code: exitCode, exceeded, elapsed_ms: Number(process.hrtime.bigint() - started) / 1e6,
    input_before: before.snapshot.source_identity_sha256, input_after: after.snapshot.source_identity_sha256,
    stdout: await reference(portable(stdoutPath)), stderr: await reference(portable(stderrPath)), ...parsed };
  liveExecutions.add(result);
  return { result, ...before };
}

export function assessAcceptance(mapping, observations) {
  const observed = new Map(observations.map(row => [row.component_id, row]));
  check(observed.size === observations.length, 'duplicate criterion observations');
  return mapping.criteria.map(item => {
    const components = item.components.map(component => ({ ...component, observed: observed.has(component.id) }));
    const missing = components.filter(component => !component.observed).map(component => `Missing executed component ${component.id}`);
    const remaining = [...item.remaining, ...missing];
    const status = item.assessment === 'complete' && remaining.length === 0 && components.length > 0 ? 'covered' :
      components.some(component => component.observed) ? 'partial' : 'missing';
    return { id: item.id, text: item.text, text_sha256: item.text_sha256, path: item.path, line: item.line, status, components, remaining };
  });
}

async function newDirectory(path) {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await mkdir(resolve(path)); // Existing captures are immutable; choose a new path.
}

export async function produceAcceptanceEvidence({ binary, provenance, output }) {
  check(nonempty(binary) && nonempty(provenance) && nonempty(output), 'binary, provenance and new output directory are required');
  await newDirectory(output);
  const native = await executeNative({ binary, provenance, output, name: 'native' });
  const replay = await executeNative({ binary, provenance, output, name: 'replay', priorNonces: [native.result.run_nonce] });
  check(liveExecutions.has(native.result) && liveExecutions.has(replay.result), 'serialized success fields cannot establish a fresh replay');
  compareAcceptanceInputs(native.snapshot, replay.snapshot);
  check(canonical(observedValues(native.result)) === canonical(observedValues(replay.result)), 'independent replay changed a criterion-component observation');
  const criteria = assessAcceptance(native.catalog.mapping, replay.result.observations);
  const inputsPath = resolve(output, 'inputs.json');
  await writeFile(inputsPath, encode(native.snapshot), { flag: 'wx' });
  const report = { schema_version: 1, producer: 'caveman-middleware-shared-acceptance-v1', evidence_class: 'shared_go_acceptance_component_candidate',
    recorded_at: new Date().toISOString(), input_snapshot: await reference(portable(inputsPath)), source_identity_sha256: native.snapshot.source_identity_sha256,
    runtime_scope: 'Actual Engine, persistent stores and middleware HTTP handler in a native Go test executable; no native framework or hosted provider inference.',
    processes: [native.result, replay.result], independent_replay: { verified_components: replay.result.observations.length, fresh_processes: 2 },
    counts: { requirements: 29, acceptance_items: criteria.length, covered: criteria.filter(row => row.status === 'covered').length,
      partial: criteria.filter(row => row.status === 'partial').length, missing: criteria.filter(row => row.status === 'missing').length },
    criteria, support_promotion: false, all_criteria_covered: criteria.every(row => row.status === 'covered') };
  const path = resolve(output, 'report.json');
  await writeFile(path, encode(report), { flag: 'wx' });
  return { path: portable(path), ...report.counts, independently_verified_components: report.independent_replay.verified_components,
    source_identity_sha256: report.source_identity_sha256, support_promotion: false };
}

async function readReference(item) {
  check(nonempty(item?.path) && hashPattern.test(item.sha256 ?? ''), 'missing artifact reference');
  const bytes = await readFile(resolve(root, item.path));
  check(sha256(bytes) === item.sha256, `tampered artifact ${item.path}`);
  return bytes;
}

/** Historical validation never substitutes for verifyAcceptanceEvidence replay. */
export async function validateRecordedAcceptance(path) {
  const report = JSON.parse(await readFile(resolve(root, path), 'utf8'));
  check(report.schema_version === 1 && report.producer === 'caveman-middleware-shared-acceptance-v1' &&
    report.evidence_class === 'shared_go_acceptance_component_candidate' && report.support_promotion === false, 'invalid shared acceptance candidate');
  const input = JSON.parse(await readReference(report.input_snapshot));
  const current = await captureAcceptanceInputs({ binary: input.binary.path, provenance: input.build_provenance.path });
  compareAcceptanceInputs(input, current.snapshot);
  check(report.source_identity_sha256 === input.source_identity_sha256, 'candidate source identity changed');
  check(report.processes?.length === 2 && new Set(report.processes.map(item => item.run_nonce)).size === 2, 'duplicate or missing independent process challenge');
  const parsed = [];
  const args = ['-test.v', '-test.count=1', `-test.run=^(?:${current.catalog.tests.map(test => test.name).join('|')})$`, '-test.timeout=60s'];
  for (const item of report.processes) {
    check(item.program === input.binary.path && item.executable_sha256 === input.binary.sha256 && item.cwd === '.' && item.input_before === input.source_identity_sha256 && item.input_after === input.source_identity_sha256 && item.exceeded === false, 'changed command or before/after identity');
    assert.deepEqual(item.args, args, 'literal native test command changed');
    const actual = inspectAcceptanceExecution({ ...item, stdout: (await readReference(item.stdout)).toString('utf8'), stderr: (await readReference(item.stderr)).toString('utf8') }, current.catalog);
    check(canonical(actual.tests) === canonical(item.tests) && canonical(actual.observations) === canonical(item.observations) &&
      canonical(actual.subprocesses) === canonical(item.subprocesses), 'candidate observation differs from its raw native output');
    parsed.push(actual);
  }
  check(canonical(observedValues(parsed[0])) === canonical(observedValues(parsed[1])), 'stored independent observations differ');
  const criteria = assessAcceptance(current.catalog.mapping, parsed[1].observations);
  check(canonical(criteria) === canonical(report.criteria), 'criterion text, missing work or coverage was altered');
  assert.deepEqual(report.counts, { requirements: 29, acceptance_items: 180, covered: criteria.filter(row => row.status === 'covered').length,
    partial: criteria.filter(row => row.status === 'partial').length, missing: criteria.filter(row => row.status === 'missing').length }, 'acceptance counts exceed complete criterion evidence');
  assert.deepEqual(report.independent_replay, { verified_components: parsed[1].observations.length, fresh_processes: 2 }, 'independent replay counts changed');
  check(report.all_criteria_covered === criteria.every(row => row.status === 'covered'), 'broad completion was invented');
  return { report, snapshot: input, catalog: current.catalog, observations: parsed[1].observations, validation_scope: 'historical_artifacts_only' };
}

/** No caller-supplied nonce/output can replace this real new process. */
export async function verifyAcceptanceEvidence({ path, output }) {
  const saved = await validateRecordedAcceptance(path);
  output ??= resolve(dirname(resolve(root, path)), `verification-${randomBytes(12).toString('hex')}`);
  await newDirectory(output);
  const replay = await executeNative({ binary: saved.snapshot.binary.path, provenance: saved.snapshot.build_provenance.path,
    output, name: 'fresh-replay', priorNonces: saved.report.processes.map(item => item.run_nonce) });
  check(liveExecutions.has(replay.result), 'verification requires a live native process');
  compareAcceptanceInputs(saved.snapshot, replay.snapshot);
  check(canonical(observedValues(replay.result)) === canonical(observedValues({ observations: saved.observations })), 'fresh replay did not reproduce the exact criterion components');
  const result = { schema_version: 1, evidence_class: 'fresh_shared_acceptance_replay', candidate: await reference(portable(resolve(root, path))),
    source_identity_sha256: replay.snapshot.source_identity_sha256, process: replay.result,
    verified_components: replay.result.observations.length, counts: saved.report.counts, support_promotion: false };
  await writeFile(resolve(output, 'verification.json'), encode(result), { flag: 'wx' });
  return { path: portable(resolve(output, 'verification.json')), ...saved.report.counts, verified_components: result.verified_components, support_promotion: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = Object.fromEntries(process.argv.slice(2).map(value => value.replace(/^--/, '').split(/=(.*)/s, 2)));
  const result = args.verify ? verifyAcceptanceEvidence({ path: args.verify, output: args.output }) : produceAcceptanceEvidence(args);
  result.then(value => process.stdout.write(encode(value))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
