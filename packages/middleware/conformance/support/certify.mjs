/** Assemble native evidence and replay allowlisted test drivers without inventing observations. */
import { readFile, realpath, writeFile, mkdir, lstat, stat } from 'node:fs/promises';
import { resolve, relative, sep, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { root, sha256, dependencyVersions } from './inventory.mjs';
import { families, requiredCells, mandatoryJourney } from './catalog.mjs';
import { recordedObservations, hasObservation } from './observations.mjs';

export const executionPrefix = 'CAVEMAN_MIDDLEWARE_EXECUTION ';
const encoding = value => `${JSON.stringify(value, null, 2)}\n`;
const digest = value => sha256(encoding(value));
const hashPattern = /^[a-f0-9]{64}$/;
const fail = message => { throw new Error(`Native certification refused: ${message}`); };
const endpointPassthrough = cell => cell.recovery === 'not_applicable' &&
  ((cell.family === 'F01' && cell.method === 'unrelated_endpoint_passthrough') ||
    (cell.family === 'F02' && ['count_tokens.passthrough', 'countTokens.passthrough'].includes(cell.method)));
const endpointIdentity = observation => observation.applicability === 'endpoint_passthrough' &&
  observation.optimizer_requests === 0 && observation.recovery_requests === 0 && observation.replacements === 0 &&
  hashPattern.test(observation.request_sha256 ?? '') && hashPattern.test(observation.response_sha256 ?? '') &&
  Number.isSafeInteger(observation.provider_calls) && observation.provider_calls > 0;

function repositoryPath(path) {
  if (typeof path !== 'string' || path.includes('\\') || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')) fail(`invalid repository path ${path}`);
  return resolve(root, path);
}
const outsideRepository = path => relative(root, path) === '..' || relative(root, path).startsWith(`..${sep}`);
async function repositoryFile(path) {
  repositoryPath(path);
  const actual = await realpath(resolve(root, path));
  if (actual === root || outsideRepository(actual)) fail(`source escaped repository: ${path}`);
  return readFile(actual);
}

/** Literal declarations only. Dynamic names need a real resolved test catalog. */
export async function declaredNodeTests(files, { namePrefix = '' } = {}) {
  const tests = [];
  for (const file of files) {
    const source = (await repositoryFile(file)).toString('utf8');
    for (const [index, line] of source.split('\n').entries()) {
      const match = line.match(/^test\(\s*('([^']*)'|"([^"]*)")/);
      if (!match) continue;
      const name = match[2] ?? match[3];
      if (!name.startsWith(namePrefix)) continue;
      tests.push({ id: `${file}::${name}`, file, name, line: index + 1, declaration: match[0], sha256: sha256(source),
        evidence_scope: 'source_only', fixture_scope: 'installed_framework_local_fixture_source',
        rerun: { program: 'node', args: ['--test', '--test-reporter=tap', file], cwd: '.' } });
    }
  }
  return { schema_version: 1, tests };
}

/** Capture selected inputs before execution. This is not a support promotion. */
export async function captureCertificationInputs({ family, language, sources, tests, binary, frameworkVersions, adapterVersion = '0.1.0', runtimeProtocol = 1 }) {
  const config = families.find(item => item.id === family)?.languages[language];
  if (!config) fail('unknown family/language');
  const unique = new Map(sources.map(source => [source.path, source]));
  if (unique.size !== sources.length) fail('duplicate source path');
  const files = await Promise.all([...unique.values()].map(async ({ path, role }) => ({ path, role, sha256: sha256(await repositoryFile(path)) })));
  files.sort((a, b) => a.path.localeCompare(b.path));
  const input = { schema_version: 1, evidence_class: 'certification_input_snapshot', family, language,
    required_cells_revision: sha256(JSON.stringify(requiredCells())), framework_versions: frameworkVersions,
    adapter_version: adapterVersion, runtime_protocol: runtimeProtocol,
    runtime: { binary_path: binary, binary_sha256: sha256(await readFile(binary)) },
    source_lock: { schema_version: 1, evidence_class: 'source_snapshot_not_execution', files }, test_catalog: tests };
  await validateCertificationInputs(input);
  return input;
}

export async function validateCertificationInputs(input) {
  if (input?.schema_version !== 1 || input.evidence_class !== 'certification_input_snapshot') fail('invalid input snapshot');
  if (input.required_cells_revision !== sha256(JSON.stringify(requiredCells()))) fail('required operation freeze changed');
  const config = families.find(item => item.id === input.family)?.languages[input.language];
  if (!config || input.framework_versions?.[config.framework] !== config.version || input.runtime_protocol !== 1 || input.adapter_version !== '0.1.0') fail('framework, adapter or protocol revision mismatch');
  const files = input.source_lock?.files;
  if (!Array.isArray(files) || !files.length || new Set(files.map(file => file.path)).size !== files.length) fail('missing or duplicate source hashes');
  const sources = new Map(files.map(file => [file.path, file]));
  for (const file of files) if (!hashPattern.test(file.sha256 ?? '') || sha256(await repositoryFile(file.path)) !== file.sha256) fail(`stale source hash: ${file.path}`);
  for (const path of [...config.source, ...config.lock]) if (!sources.has(path)) fail(`missing required source or lock: ${path}`);
  for (const role of ['adapter_source', 'sdk_source', 'runtime_source', 'dependency_lock', 'test_source']) if (!files.some(file => file.role === role)) fail(`missing ${role} hashes`);
  const versions = await dependencyVersions(config.lock);
  if (versions.get(config.framework) !== config.version) fail('framework pin is absent from the actual lock');
  for (const [name, version] of Object.entries(input.framework_versions)) if (versions.get(name) !== version) fail(`installed/locked version mismatch: ${name}`);
  const tests = input.test_catalog?.tests;
  if (!Array.isArray(tests) || !tests.length || new Set(tests.map(test => test.id)).size !== tests.length) fail('missing or duplicate exact tests');
  for (const test of tests) {
    if (test.id !== `${test.file}::${test.name}` || test.name.includes('${') || sources.get(test.file)?.sha256 !== test.sha256) fail(`unresolved or stale test: ${test.id}`);
    const lines = (await repositoryFile(test.file)).toString('utf8').split('\n');
    const declarationName = test.file.endsWith('.py') ? test.name.split('.').at(-1) : test.name;
    if (!lines[test.line - 1]?.includes(test.declaration) || !test.declaration.includes(declarationName)) fail(`test declaration changed: ${test.id}`);
  }
  if (!hashPattern.test(input.runtime?.binary_sha256 ?? '') || sha256(await readFile(input.runtime.binary_path)) !== input.runtime.binary_sha256) fail('runtime binary changed');
  return input;
}

/** Emitted by a native test after querying the actual local runtime. */
export function executionObservation(input, capabilities) {
  if (!capabilities?.runtime_build || capabilities.schema_version !== input.runtime_protocol) fail('missing observed runtime build/protocol');
  return { producer: 'caveman-middleware-execution-v1', family: input.family, language: input.language,
    framework_versions: input.framework_versions, adapter_version: input.adapter_version, runtime_protocol: input.runtime_protocol,
    runtime: { build: capabilities.runtime_build, binary_sha256: input.runtime.binary_sha256 },
    input_snapshot_sha256: digest(input), source_lock_sha256: digest(input.source_lock),
    test_catalog_sha256: digest(input.test_catalog), local_provider_fixture: true, external_inference_requests: 0,
    ...(process.env.CAVEMAN_MIDDLEWARE_REPLAY_NONCE ? { replay_nonce: process.env.CAVEMAN_MIDDLEWARE_REPLAY_NONCE } : {}) };
}

export function successfulTapTests(output) {
  if (typeof output !== 'string' || !/^1\.\.\d+\s*$/m.test(output) || !/^# fail 0\s*$/m.test(output) ||
      !/^# pass [1-9]\d*\s*$/m.test(output) || /^\s*not ok\b/m.test(output) || /^Bail out!/m.test(output) || /^# cancelled [1-9]/m.test(output)) fail('raw TAP is failed or incomplete');
  const passed = new Set();
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*ok \d+ - (.*)$/);
    if (match && !/\s+#\s*(?:SKIP|TODO)\b/i.test(match[1])) passed.add(match[1]);
  }
  if (!passed.size) fail('no exact passing TAP test names');
  return passed;
}

function executionRecords(output) {
  const records = [];
  for (const line of output.split('\n')) {
    const at = line.indexOf(executionPrefix);
    if (at >= 0) { try { records.push(JSON.parse(line.slice(at + executionPrefix.length))); } catch { fail('malformed native execution metadata'); } }
  }
  if (records.length !== 1) fail('one executing-test metadata record is required');
  return records[0];
}

function validateExecutionMetadata(input, execution) {
  if (execution.producer !== 'caveman-middleware-execution-v1' || execution.input_snapshot_sha256 !== digest(input) ||
      execution.source_lock_sha256 !== digest(input.source_lock) || execution.test_catalog_sha256 !== digest(input.test_catalog)) fail('execution input/source/test hashes do not match the snapshot');
  if (execution.family !== input.family || execution.language !== input.language || JSON.stringify(execution.framework_versions) !== JSON.stringify(input.framework_versions) ||
      execution.adapter_version !== input.adapter_version || execution.runtime_protocol !== input.runtime_protocol ||
      execution.runtime?.binary_sha256 !== input.runtime.binary_sha256 || !execution.runtime?.build ||
      execution.local_provider_fixture !== true || execution.external_inference_requests !== 0) fail('execution framework/runtime/local-fixture identity mismatch');
}

/** Inspect every frozen cell in this family; incomplete cells remain visible. */
export async function inspectNativeEvidence({ input, rawOutput }) {
  await validateCertificationInputs(input);
  const bytes = await repositoryFile(rawOutput), output = bytes.toString('utf8');
  const passedNames = successfulTapTests(output), execution = executionRecords(output);
  validateExecutionMetadata(input, execution);
  const known = new Map(input.test_catalog.tests.map(test => [test.id, test]));
  const observations = recordedObservations(output);
  const cells = requiredCells().filter(cell => cell.family === input.family && cell.language === input.language);
  const ids = new Set(cells.map(cell => cell.id));
  for (const item of observations) {
    if (!item.cell_id) continue;
    if (!ids.has(item.cell_id)) fail(`observation identifies an unexpected cell: ${item.cell_id}`);
    const test = known.get(item.test_id);
    if (!test || !passedNames.has(test.name)) fail(`observation is not backed by an exact passing test: ${item.test_id}`);
  }
  const coverage = cells.map(cell => {
    const journey = {}, missing = [];
    for (const assertion of mandatoryJourney) {
      const matching = observations.filter(item => item.cell_id === cell.id && item.assertion === assertion);
      const unique = new Set(matching.map(item => JSON.stringify(item)));
      if (matching.length !== 1) { missing.push(`${assertion}: ${matching.length ? unique.size > 1 ? 'conflicting observations' : 'duplicate observations' : 'no observation'}`); continue; }
      const item = matching[0], outcome = item.observation.outcome;
      const recoveryFree = ['transformed_provider_request', 'omitted_fact_requested', 'host_executes_exact_recovery'].includes(assertion);
      const passthrough = endpointPassthrough(cell);
      if (outcome === 'recovery_free') {
        const applicable = (cell.recovery === 'model_only' && recoveryFree) || (passthrough && (recoveryFree || assertion === 'real_tool_result') && endpointIdentity(item.observation));
        if (!applicable || !item.observation.reason || item.observation.recovery_requests !== 0 || item.observation.replacements !== 0) {
          missing.push(`${assertion}: no-recovery observation is inapplicable or incomplete`); continue;
        }
      } else if (outcome !== 'observed' || ((cell.recovery === 'model_only' || passthrough) && recoveryFree) || (passthrough && assertion === 'real_tool_result')) {
        missing.push(`${assertion}: expected an explicit applicable outcome`); continue;
      }
      journey[assertion] = { test_id: item.test_id, observation: item.observation };
    }
    if (endpointPassthrough(cell)) {
      const observed = journey.transformed_provider_request?.observation;
      for (const assertion of ['real_tool_result', 'omitted_fact_requested', 'host_executes_exact_recovery', 'off_baseline', 'optimizer_unavailable']) {
        const value = journey[assertion]?.observation;
        if (!value || !endpointIdentity(value) || ['request_sha256', 'response_sha256', 'provider_calls'].some(key => value[key] !== observed?.[key])) {
          missing.push(`${assertion}: endpoint passthrough identity or zero-traffic baseline is missing or differs`);
        }
      }
    }
    return { cell, complete: missing.length === 0, missing, journey,
      additional_observations: observations.filter(item => item.cell_id === cell.id && !mandatoryJourney.includes(item.assertion)) };
  });
  return { input, execution, raw_output: { path: rawOutput, sha256: sha256(bytes) }, coverage };
}

/** One exact cell per record; an incomplete cell is refused, never omitted. */
export function assembleNativeCertification(inspected, cellId) {
  const selected = inspected.coverage.find(item => item.cell.id === cellId);
  if (!selected) fail(`unknown requested operation: ${cellId}`);
  if (!selected.complete) fail(`${cellId}: ${selected.missing.join('; ')}`);
  const testIds = [...new Set(Object.values(selected.journey).map(item => item.test_id))].sort();
  const { input, execution } = inspected;
  return { schema_version: 1, producer: 'caveman-middleware-native-run-v1', evidence_class: 'native_fixture', cells: [cellId],
    framework_versions: input.framework_versions, adapter_version: input.adapter_version, runtime_protocol: input.runtime_protocol,
    runtime: { ...execution.runtime, source_lock_sha256: digest(input.source_lock) },
    tests: testIds.map(id => ({ id, result: 'passed' })), journey: selected.journey,
    local_provider_fixture: true, external_inference_requests: 0, raw_output: inspected.raw_output,
    input_snapshot_sha256: digest(input), test_catalog_sha256: digest(input.test_catalog),
    source_hashes: input.source_lock.files.filter(file => ['adapter_source', 'dependency_lock', 'test_source', 'executed_module'].includes(file.role)),
    independent_replay_required: true };
}

/** Pure matching step; only replayNativeCertifications supplies fresh process nonces. */
export function matchNativeReplay({ input, records, outputs }) {
  if (!records?.length || !outputs?.length) fail('replay requires candidate records and fresh process output');
  const known = new Map(input.test_catalog.tests.map(test => [test.id, test]));
  const parsed = outputs.map(({ file, output, nonce }) => {
    const execution = executionRecords(output); validateExecutionMetadata(input, execution);
    if (!nonce || execution.replay_nonce !== nonce) fail('replay output is not from this fresh process nonce');
    return { file, output, execution, passed: successfulTapTests(output), observations: recordedObservations(output) };
  });
  if (new Set(outputs.map(row => row.file)).size !== outputs.length || new Set(outputs.map(row => row.nonce)).size !== outputs.length) fail('duplicate replay process identity');
  const cells = new Set(), verified = [];
  for (const record of records) {
    if (record.cells?.length !== 1 || cells.has(record.cells[0])) fail('duplicate or unresolved replay cell');
    cells.add(record.cells[0]);
    if (record.input_snapshot_sha256 !== digest(input)) fail('candidate was assembled from different execution inputs');
    const declared = new Set(record.tests?.filter(test => test.result === 'passed').map(test => test.id));
    if (!declared.size || declared.size !== record.tests.length) fail('candidate tests are missing, duplicated or failed');
    for (const id of declared) {
      const test = known.get(id), run = test && parsed.find(output => output.file === test.file);
      if (!run || !run.passed.has(test.name)) fail(`replay did not pass exact test ${id}`);
    }
    for (const assertion of mandatoryJourney) {
      const expected = record.journey?.[assertion], test = known.get(expected?.test_id);
      const run = test && parsed.find(output => output.file === test.file);
      if (!expected?.observation || !declared.has(expected.test_id) || !run) fail(`candidate has a partial replay journey: ${assertion}`);
      const matches = run.observations.filter(item => item.cell_id === record.cells[0] && item.assertion === assertion);
      if (matches.length !== 1 || !hasObservation(run.output, { cell_id: record.cells[0], assertion, ...expected })) fail(`fresh replay observation is missing, duplicated or differs: ${record.cells[0]} ${assertion}`);
      if (run.execution.runtime.build !== record.runtime?.build) fail('fresh replay observed a different runtime build');
    }
    verified.push({ cell_id: record.cells[0], tests: [...declared], assertions: [...mandatoryJourney], result: 'passed' });
  }
  return verified;
}

function replayDriver(input, file) {
  const config = families.find(item => item.id === input.family)?.languages[input.language];
  if (!config?.tests.includes(file)) fail(`test is not an allowlisted native family driver: ${file}`);
  if (file.endsWith('.mjs')) return { program: process.execPath, args: ['--test', '--test-reporter=tap', file] };
  if (file.endsWith('.py') && file.startsWith('examples/middleware/')) {
    const family = file.split('/')[2];
    const driver = file === 'examples/middleware/litellm/composition_test.py' ? 'composition-python'
      : family === 'python-provider-sdks' ? 'python-provider' : 'python-framework';
    return { program: process.execPath, args: ['--test', '--test-reporter=tap', `packages/middleware/conformance/${driver}.test.mjs`], pythonFamily: family };
  }
  fail(`no allowlisted native replay driver for ${file}`);
}

async function writeReplayOutput(path, output) {
  const target = repositoryPath(path), parent = await realpath(dirname(target));
  if (outsideRepository(parent)) fail('replay output escaped repository');
  if ((await lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; }))?.isSymbolicLink()) fail('replay output is a symbolic link');
  await writeFile(target, output);
  return { path, sha256: sha256(output) };
}

/** Execute each known native test file once and verify every requested candidate. */
export async function replayNativeCertifications({ input, references, rawOutput }) {
  await validateCertificationInputs(input);
  if (!references?.length || new Set(references.map(ref => ref.path)).size !== references.length) fail('missing or duplicate replay references');
  repositoryPath(rawOutput);
  if (!rawOutput.endsWith('.tap')) fail('replay output must be a separate .tap artifact');
  const records = [], originalRuns = new Map();
  for (const ref of references) {
    const bytes = await repositoryFile(ref.path);
    if (!hashPattern.test(ref.sha256 ?? '') || sha256(bytes) !== ref.sha256) fail(`candidate artifact hash changed: ${ref.path}`);
    const record = JSON.parse(bytes.toString('utf8'));
    const original = record.raw_output?.path;
    if (!original || original === rawOutput) fail('replay output must be separate from the original run');
    if (!originalRuns.has(original)) originalRuns.set(original, await inspectNativeEvidence({ input, rawOutput: original }));
    const inspected = originalRuns.get(original);
    if (record.cells?.length !== 1 || JSON.stringify(record) !== JSON.stringify(assembleNativeCertification(inspected, record.cells[0]))) fail('candidate differs from its exact original observations or input hashes');
    records.push(record);
  }
  if (new Set(records.map(record => record.cells[0])).size !== records.length) fail('duplicate candidate operation');
  const catalog = new Map(input.test_catalog.tests.map(test => [test.id, test]));
  const files = [...new Set(records.flatMap(record => record.tests.map(test => catalog.get(test.id)?.file)))];
  const outputs = [], processes = [];
  for (const [index, file] of files.entries()) {
    const driver = replayDriver(input, file), nonce = randomUUID();
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      !/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|CLIENT_SECRET|SECRET_ACCESS_KEY|SESSION_TOKEN|GOOGLE_APPLICATION_CREDENTIALS|AWS_PROFILE|CAVEMAN_MASTRA_EVIDENCE|CAVEMAN_MIDDLEWARE_PACKAGED_TEST)/i.test(name)));
    env.CAVEMAN_MIDDLEWARE_TEST_BINARY = input.runtime.binary_path;
    env.CAVEMAN_MIDDLEWARE_REPLAY_NONCE = nonce;
    env.CAVEMAN_MIDDLEWARE_CERT_FAMILY = input.family;
    if (driver.pythonFamily) {
      if (!env.CAVEMAN_MIDDLEWARE_TEST_PYTHON || !(await stat(env.CAVEMAN_MIDDLEWARE_TEST_PYTHON).catch(() => null))?.isFile()) fail('Python replay requires its exact locked interpreter');
      env.CAVEMAN_MIDDLEWARE_TEST_FAMILY = driver.pythonFamily;
    }
    const path = files.length === 1 ? rawOutput : `${rawOutput}.${index + 1}.tap`;
    if (originalRuns.has(path) || references.some(ref => ref.path === path)) fail('replay output would overwrite its original evidence');
    const result = await new Promise((yes, no) => {
      const child = spawn(driver.program, driver.args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', exceeded = false;
      const timer = setTimeout(() => { exceeded = true; child.kill('SIGTERM'); }, 180_000);
      const capture = chunk => { output += chunk; if (output.length > 8 * 1024 * 1024) { exceeded = true; child.kill('SIGTERM'); } };
      child.stdout.on('data', capture); child.stderr.on('data', capture);
      child.on('error', error => { clearTimeout(timer); no(error); });
      child.on('close', code => { clearTimeout(timer); yes({ code, output, exceeded }); });
    });
    const raw = await writeReplayOutput(path, result.output);
    if (result.code !== 0 || result.exceeded) {
      const error = new Error(`Native certification refused: fresh replay exited ${result.code} (output/deadline exceeded: ${result.exceeded}); captured ${path}`);
      error.raw_output = raw; throw error;
    }
    await validateCertificationInputs(input);
    await inspectNativeEvidence({ input, rawOutput: path });
    outputs.push({ file, nonce, output: result.output });
    processes.push({ file, program: driver.program, args: driver.args, cwd: '.', replay_nonce: nonce, exit_code: result.code, raw_output: raw });
  }
  const verified = matchNativeReplay({ input, records, outputs });
  await validateCertificationInputs(input);
  for (const ref of references) if (sha256(await repositoryFile(ref.path)) !== ref.sha256) fail(`candidate artifact changed during replay: ${ref.path}`);
  return { schema_version: 1, producer: 'caveman-middleware-independent-replay-v1', evidence_class: 'native_fixture_replay',
    input_snapshot_sha256: digest(input), processes,
    certifications: verified.map((row, index) => ({ ...references[index], replayed_sha256: references[index].sha256, ...row })),
    verified_assertions: verified.reduce((total, row) => total + row.assertions.length, 0), support_promotion: false };
}

async function main(args) {
  const [inputPath, rawOutput, outputDirectory, ...cellIds] = args;
  if (!inputPath || !rawOutput || !outputDirectory) fail('usage: node certify.mjs INPUTS.json RAW.tap OUTPUT_DIRECTORY [EXACT_CELL_ID ...]');
  const input = JSON.parse((await repositoryFile(inputPath)).toString('utf8'));
  const inspected = await inspectNativeEvidence({ input, rawOutput });
  // Without explicit cells, inspect only. A caller must deliberately select
  // every candidate artifact; this command never updates operation manifests.
  const outputPath = repositoryPath(outputDirectory);
  let ancestor = outputPath;
  while (!(await lstat(ancestor).catch(error => { if (error.code === 'ENOENT') return null; throw error; }))) ancestor = dirname(ancestor);
  if (outsideRepository(await realpath(ancestor))) fail('output directory escaped repository');
  await mkdir(outputPath, { recursive: true });
  if (outsideRepository(await realpath(outputPath))) fail('output directory escaped repository');
  const summary = { evidence_class: 'candidate_coverage_not_promotion', input_snapshot_sha256: digest(input), raw_output: inspected.raw_output,
    cells: inspected.coverage.map(({ cell, complete, missing, additional_observations }) => ({ id: cell.id, backed: complete, missing, additional_observations })) };
  const records = cellIds.map(id => assembleNativeCertification(inspected, id));
  const save = async (name, value) => {
    const path = resolve(outputPath, name);
    if ((await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; }))?.isSymbolicLink()) fail(`output is a symbolic link: ${name}`);
    await writeFile(path, encoding(value));
  };
  for (const record of records) await save(`${sha256(record.cells[0]).slice(0, 16)}.json`, record);
  await save('coverage.json', summary);
  process.stdout.write(encoding({ backed: summary.cells.filter(cell => cell.backed).length, unbacked: summary.cells.filter(cell => !cell.backed), artifacts_written: records.length }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
