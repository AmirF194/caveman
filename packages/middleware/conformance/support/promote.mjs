/** Scoped native promotion. Global source inventory and acceptance are untouched. */
import { readFile, realpath, readdir, mkdir, writeFile, lstat } from 'node:fs/promises';
import { resolve, relative, dirname, basename, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, sha256, providerVersions } from './inventory.mjs';
import { families, requiredCells, mandatoryJourney, cellKey } from './catalog.mjs';
import { validateCertificationInputs, inspectNativeEvidence, assembleNativeCertification, matchNativeReplay, replayNativeCertifications } from './certify.mjs';
import { requiredNativeSources } from './source-scope.mjs';
import { runtimeBuildSources } from './runtime-build.mjs';

const encode = value => `${JSON.stringify(value, null, 2)}\n`;
const digest = value => sha256(encode(value));
const hashPattern = /^[a-f0-9]{64}$/;
const fail = message => { throw new Error(`Native promotion refused: ${message}`); };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const freshBundles = new WeakSet();
const freeze = value => {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
};

function repositoryPath(path) {
  if (typeof path !== 'string' || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) fail(`invalid repository artifact path ${path}`);
  return resolve(root, path);
}

async function artifact(reference) {
  if (!reference?.path || !hashPattern.test(reference.sha256 ?? '')) fail('missing exact artifact reference');
  const target = await realpath(repositoryPath(reference.path));
  if (relative(root, target).startsWith(`..${sep}`)) fail(`artifact escaped repository: ${reference.path}`);
  const bytes = await readFile(target);
  if (sha256(bytes) !== reference.sha256) fail(`stale or tampered artifact: ${reference.path}`);
  return bytes;
}

async function reference(path) {
  repositoryPath(path);
  const sha256 = digestBytes(await readFile(resolve(root, path)));
  const ref = { path, sha256 };
  await artifact(ref);
  return ref;
}
const digestBytes = bytes => sha256(bytes);

/** Pure coverage check, after required paths are derived independently. */
export function assertScopedInputCoverage(input, { sources, runtimeSources }) {
  const files = input.source_lock?.files;
  if (!Array.isArray(files) || !files.length || new Set(files.map(file => file.path)).size !== files.length) fail('missing or duplicate scoped source files');
  const index = new Map(files.map(file => [file.path, file]));
  for (const expected of [...sources, ...runtimeSources]) {
    const actual = index.get(expected.path);
    if (!actual || actual.role !== expected.role || !hashPattern.test(actual.sha256 ?? '')) fail(`missing required ${expected.role}: ${expected.path}`);
    if (expected.sha256 && actual.sha256 !== expected.sha256) fail(`runtime build/source mismatch: ${expected.path}`);
  }
  const built = new Set(runtimeSources.map(file => file.path));
  for (const file of files.filter(file => file.role === 'runtime_source')) if (!built.has(file.path)) fail(`runtime source was not in this executable's build: ${file.path}`);
  if (!input.runtime?.build_provenance?.path || !hashPattern.test(input.runtime.build_provenance.sha256 ?? '')) fail('missing actual runtime build provenance');
  return index;
}

/** Source-local checks never compare a scoped execution digest to a global hash. */
export async function validateScopedInputs(input) {
  await validateCertificationInputs(input);
  const tests = [...new Set(input.test_catalog.tests.map(test => test.file))];
  const sources = await requiredNativeSources({ family: input.family, language: input.language, tests });
  const provenance = input.runtime?.build_provenance;
  if (!provenance?.path || !hashPattern.test(provenance.sha256 ?? '')) fail('missing actual runtime build provenance');
  const proxy = await runtimeBuildSources({ provenance: provenance.path, binary: input.runtime.binary_path });
  if (proxy.reference.sha256 !== provenance.sha256 || proxy.binary.sha256 !== input.runtime.binary_sha256) fail('runtime build provenance differs from executing inputs');
  const runtimeSources = [...proxy.sources];
  const auxiliaries = input.runtime.auxiliary_builds ?? [];
  if (new Set(auxiliaries.map(item => item.name)).size !== auxiliaries.length || auxiliaries.some(item => item.name !== 'mcp')) fail('duplicate or unknown auxiliary runtime');
  if ((input.family === 'F13') !== (auxiliaries.length === 1)) fail('MCP cells require their separate actual native MCP build');
  for (const auxiliary of auxiliaries) {
    const mcp = await runtimeBuildSources({ provenance: auxiliary.build_provenance?.path, binary: auxiliary.binary_path, target: 'mcp' });
    if (mcp.reference.sha256 !== auxiliary.build_provenance?.sha256 || mcp.binary.sha256 !== auxiliary.binary_sha256) fail('MCP build provenance differs from executing inputs');
    runtimeSources.push(...mcp.sources);
  }
  const uniqueRuntime = [...new Map(runtimeSources.map(file => [file.path, file])).values()];
  assertScopedInputCoverage(input, { sources, runtimeSources: uniqueRuntime });
  const manifest = input.language === 'typescript' ? 'packages/middleware/typescript/package.json' : 'packages/middleware/python/pyproject.toml';
  const text = await readFile(resolve(root, manifest), 'utf8');
  const version = manifest.endsWith('.json') ? JSON.parse(text).version : text.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (version !== input.adapter_version) fail('adapter version differs from its hashed package manifest');
  return { sources, runtimeSources: uniqueRuntime };
}

/** Candidates must be exact assembly of the original passing observations. */
export function assertOriginalCandidate(record, inspected) {
  if (record?.cells?.length !== 1 || !equal(record, assembleNativeCertification(inspected, record.cells[0]))) fail('candidate differs from original observed assertions, tests or scoped inputs');
  return record;
}

async function inspectCandidates({ input: inputRef, candidates }) {
  if (!candidates?.length || new Set(candidates.map(ref => ref.path)).size !== candidates.length || new Set(candidates.map(ref => ref.sha256)).size !== candidates.length) fail('missing or duplicate candidate references');
  const input = JSON.parse((await artifact(inputRef)).toString('utf8'));
  await validateScopedInputs(input);
  const records = [], originalRuns = new Map();
  for (const ref of candidates) {
    const record = JSON.parse((await artifact(ref)).toString('utf8'));
    if (!record.raw_output?.path) fail('candidate lacks its original execution output');
    await artifact(record.raw_output);
    if (!originalRuns.has(record.raw_output.path)) originalRuns.set(record.raw_output.path, await inspectNativeEvidence({ input, rawOutput: record.raw_output.path }));
    assertOriginalCandidate(record, originalRuns.get(record.raw_output.path));
    records.push(record);
  }
  if (new Set(records.map(record => record.cells[0])).size !== records.length) fail('duplicate candidate operation cell');
  return { input, inputRef, candidates, records };
}

/** Recompute the saved replay's claims from exact nonce-bound native output. */
export function assertReplayRecord({ input, replay, references, records, outputs }) {
  if (replay?.schema_version !== 1 || replay.producer !== 'caveman-middleware-independent-replay-v1' || replay.evidence_class !== 'native_fixture_replay' || replay.input_snapshot_sha256 !== digest(input) || replay.support_promotion !== false) fail('replay has different scoped inputs, producer or promotion scope');
  if (!Array.isArray(replay.processes) || replay.processes.length !== outputs.length || replay.processes.some(process => process.exit_code !== 0 || !process.replay_nonce)) fail('missing or failed fresh replay process');
  if (new Set(replay.processes.map(process => process.file)).size !== replay.processes.length || new Set(replay.processes.map(process => process.replay_nonce)).size !== replay.processes.length || new Set(replay.processes.map(process => process.raw_output?.path)).size !== replay.processes.length) fail('duplicate replay process, nonce or output');
  for (const process of replay.processes) {
    const config = families.find(family => family.id === input.family)?.languages[input.language];
    if (!config?.tests.includes(process.file) || process.cwd !== '.' || !/^node(?:\.exe)?$/.test(basename(process.program ?? ''))) fail('replay did not use an allowlisted native driver');
    const folder = process.file.split('/')[2];
    const driver = process.file === 'examples/middleware/litellm/composition_test.py' ? 'composition-python' : folder === 'python-provider-sdks' ? 'python-provider' : 'python-framework';
    const expectedArgs = ['--test', '--test-reporter=tap', process.file.endsWith('.mjs') ? process.file : `packages/middleware/conformance/${driver}.test.mjs`];
    if (!equal(process.args, expectedArgs)) fail('replay command differs from the allowlisted native driver');
    const output = outputs.find(row => row.file === process.file);
    if (!output || output.nonce !== process.replay_nonce || digestBytes(output.output) !== process.raw_output?.sha256) fail('replay process/output identity mismatch');
  }
  const verified = matchNativeReplay({ input, records, outputs });
  const expected = verified.map((row, index) => ({ ...references[index], replayed_sha256: references[index].sha256, ...row }));
  if (!equal(replay.certifications, expected) || replay.verified_assertions !== expected.length * mandatoryJourney.length) fail('saved replay claims differ from actual complete replay observations');
  return verified;
}

async function replayOutputs(replay) {
  const outputs = [];
  for (const process of replay.processes ?? []) outputs.push({ file: process.file, nonce: process.replay_nonce,
    output: (await artifact(process.raw_output)).toString('utf8') });
  return outputs;
}

async function withReplayEnvironment(input, python, operation) {
  if (input.language === 'python' && !python) fail('this Python family needs its explicit exact-lock interpreter');
  const names = ['CAVEMAN_MIDDLEWARE_RUNTIME_PROVENANCE', 'CAVEMAN_MIDDLEWARE_TEST_BINARY', 'CAVEMAN_MIDDLEWARE_TEST_PYTHON', 'CAVEMAN_MCP_RUNTIME_PROVENANCE', 'CAVEMAN_MCP_TEST_BINARY'];
  const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.CAVEMAN_MIDDLEWARE_RUNTIME_PROVENANCE = input.runtime.build_provenance.path;
  process.env.CAVEMAN_MIDDLEWARE_TEST_BINARY = input.runtime.binary_path;
  if (input.language === 'python') {
    process.env.CAVEMAN_MIDDLEWARE_TEST_PYTHON = python;
  }
  const mcp = input.runtime.auxiliary_builds?.find(item => item.name === 'mcp');
  if (mcp) { process.env.CAVEMAN_MCP_RUNTIME_PROVENANCE = mcp.build_provenance.path; process.env.CAVEMAN_MCP_TEST_BINARY = mcp.binary_path; }
  try { return await operation(); }
  finally { for (const name of names) { if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name]; } }
}

async function save(path, value) {
  const target = repositoryPath(path);
  if ((await lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; }))?.isSymbolicLink()) fail('output is a symlink');
  await writeFile(target, encode(value), { flag: 'wx' });
  return { path, sha256: digest(value) };
}

async function emptyOutput(path) {
  const target = repositoryPath(path);
  if ((await readdir(target).catch(error => { if (error.code === 'ENOENT') return []; throw error; })).length) fail('promotion output must be empty');
  let ancestor = target;
  while (!(await lstat(ancestor).catch(error => { if (error.code === 'ENOENT') return null; throw error; }))) ancestor = dirname(ancestor);
  if (relative(root, await realpath(ancestor)).startsWith(`..${sep}`)) fail('promotion output ancestor escaped repository');
  await mkdir(target, { recursive: true });
  if (relative(root, await realpath(target)).startsWith(`..${sep}`)) fail('promotion output escaped repository');
}

async function freshReplay(bundle, { output, python }) {
  const replay = await withReplayEnvironment(bundle.input, python, () => replayNativeCertifications({ input: bundle.input,
    references: bundle.candidates, rawOutput: `${output}/native-replay.tap` }));
  const replayRef = await save(`${output}/replay.json`, replay);
  assertReplayRecord({ input: bundle.input, replay, references: bundle.candidates, records: bundle.records, outputs: await replayOutputs(replay) });
  await validateScopedInputs(bundle.input);
  await artifact(bundle.inputRef);
  for (const ref of bundle.candidates) await artifact(ref);
  const verified = { ...bundle, replay, replayRef };
  freshBundles.add(verified);
  return verified;
}

/** Only this process's actual successful replay may generate conformant rows. */
export async function promotedRows(bundle, proofRef) {
  if (!freshBundles.has(bundle)) fail('conformant rows require an actual fresh replay from this process');
  const config = families.find(family => family.id === bundle.input.family).languages[bundle.input.language];
  const cells = new Map(requiredCells().map(cell => [cell.id, cell]));
  const sources = new Map(bundle.input.source_lock.files.map(file => [file.path, file]));
  const rows = [];
  for (const [index, record] of bundle.records.entries()) {
    const cell = cells.get(record.cells[0]);
    if (!cell || cell.family !== bundle.input.family || cell.language !== bundle.input.language) fail('candidate claims another family or language');
    const starlette = cell.family === 'F12' && cell.method.startsWith('starlette.');
    const rowSources = [...new Set([...config.source, ...config.lock, ...record.tests.map(test => bundle.input.test_catalog.tests.find(item => item.id === test.id).file)])];
    rows.push({ schema_version: 1, family: cell.family, language: cell.language,
      framework: starlette ? 'starlette' : config.framework, version: starlette ? '1.6.0' : config.version,
      method: cell.method, runtime_protocol: bundle.input.runtime_protocol, state: 'conformant',
      adapter_package: cell.language === 'python' ? 'caveman-middleware' : '@caveman-ai/middleware', adapter_version: bundle.input.adapter_version,
      provider: cell.provider, protocol: cell.protocol, provider_sdk_versions: await providerVersions(config, cell.provider),
      execution: cell.execution, streaming: cell.streaming, structured_output: cell.structured_output, recovery: cell.recovery,
      persistence: 'scoped_durable', serialization_visibility: config.serialization_visibility ?? (['F01', 'F02', 'F03', 'F12'].includes(cell.family) ? 'provider_http' : 'native_model'),
      evidence: [...rowSources.map(path => ({ kind: 'source_probe', artifact: path, sha256: sources.get(path).sha256 })),
        { kind: 'native_fixture', artifact: bundle.candidates[index].path, sha256: bundle.candidates[index].sha256 },
        { kind: 'runtime_contract', artifact: proofRef.path, sha256: proofRef.sha256 }],
      tests: record.tests.map(test => test.id),
      limitations: ['This exact operation passed its installed-framework local-fixture journey and an independent fresh replay against the recorded scoped inputs and native runtime build.',
        'Only the named operation and observations are certified. Whole specification acceptance, other operations, live provider authentication, provider cache hits, invoices and economic superiority remain separate evidence.',
        'The runtime binary is a locally built development artifact. This proof is not a released binary, native Windows qualification or deployment certification.'] });
  }
  return rows;
}

/** Produce reviewable exact rows; never overwrite the shared support ledger. */
export async function promoteNativeGroup({ input, candidates, output, python }) {
  const bundle = await inspectCandidates({ input, candidates });
  await emptyOutput(output);
  const verified = await freshReplay(bundle, { output, python });
  const proof = { schema_version: 1, producer: 'caveman-middleware-scoped-native-proof-v1', evidence_class: 'scoped_native_support_proof',
    input, candidates, replay: verified.replayRef, input_snapshot_sha256: digest(bundle.input),
    source_lock_sha256: digest(bundle.input.source_lock), test_catalog_sha256: digest(bundle.input.test_catalog),
    runtime_build_provenance: bundle.input.runtime.build_provenance, cells: bundle.records.map(record => record.cells[0]),
    acceptance_items: [], provider_live: false };
  const proofRef = await save(`${output}/proof.json`, proof);
  const rows = await promotedRows(verified, proofRef);
  const rowsRef = await save(`${output}/rows.json`, rows);
  const report = { schema_version: 1, producer: 'caveman-middleware-scoped-promotion-v1', evidence_class: 'reviewable_native_support_promotion',
    scoped_execution_preserved: true, shared_inventory_mutated: false, proof: proofRef, rows: rowsRef,
    cells: rows.map(cellKey), exact_tests: [...new Set(rows.flatMap(row => row.tests))], verified_assertions: verified.replay.verified_assertions,
    acceptance_items: [], live_provider_promotions: 0 };
  await save(`${output}/promotion.json`, report);
  return report;
}

/** Read a prior proof, verify all saved observations, then replay before use. */
export async function replayScopedProof(proofRef, { output, python } = {}) {
  const proof = JSON.parse((await artifact(proofRef)).toString('utf8'));
  if (proof.schema_version !== 1 || proof.producer !== 'caveman-middleware-scoped-native-proof-v1' || proof.evidence_class !== 'scoped_native_support_proof' || !Array.isArray(proof.acceptance_items) || proof.acceptance_items.length || proof.provider_live !== false) fail('wrong scoped proof class or inherited acceptance/provider claims');
  const bundle = await inspectCandidates({ input: proof.input, candidates: proof.candidates });
  if (proof.input_snapshot_sha256 !== digest(bundle.input) || proof.source_lock_sha256 !== digest(bundle.input.source_lock) || proof.test_catalog_sha256 !== digest(bundle.input.test_catalog) ||
    !equal(proof.runtime_build_provenance, bundle.input.runtime.build_provenance) || !equal(proof.cells, bundle.records.map(record => record.cells[0]))) fail('scoped proof changed input, build or cell identity');
  const savedReplay = JSON.parse((await artifact(proof.replay)).toString('utf8'));
  assertReplayRecord({ input: bundle.input, replay: savedReplay, references: bundle.candidates, records: bundle.records, outputs: await replayOutputs(savedReplay) });
  if (!output) fail('independent replay requires a new output directory');
  await emptyOutput(output);
  const verified = await freshReplay(bundle, { output, python });
  const replayed = freeze({ proof: { ...proofRef }, rows: await promotedRows(verified, proofRef), verified_assertions: verified.replay.verified_assertions,
    input: bundle.inputRef, source_lock_sha256: digest(bundle.input.source_lock), input_snapshot_sha256: digest(bundle.input),
    source_files: bundle.input.source_lock.files, test_catalog: bundle.input.test_catalog });
  freshBundles.add(replayed);
  return replayed;
}

/** Inventory callers may validate only exact rows earned by the replay above. */
export function assertPromotedRow(row, replayed) {
  if (!freshBundles.has(replayed)) fail('row validation requires an actual fresh scoped replay from this process');
  const exact = replayed.rows.find(item => cellKey(item) === cellKey(row));
  if (!exact || !equal(row, exact)) fail('manifest row differs from the exact replay-derived operation/tests/evidence');
  return row.evidence.find(item => item.kind === 'native_fixture').sha256;
}

/** Batch each scoped proof once for an inventory, using an explicit Python map. */
export async function replayScopedManifestRows(manifests, { output, pythonByScope = {} } = {}) {
  const selected = manifests.filter(row => row.state === 'conformant');
  if (manifests.some(row => row.state === 'provider_tested')) fail('real-provider rows require their separate explicit live-proof integration');
  if (!selected.length || new Set(manifests.map(cellKey)).size !== manifests.length) fail('missing conformant rows or duplicate inventory cells');
  const groups = new Map();
  for (const row of selected) {
    const candidates = row.evidence.filter(ref => ref.kind === 'native_fixture');
    if (candidates.length !== 1) fail('one exact complete native candidate is required per promoted row');
    const proofs = [];
    for (const ref of row.evidence.filter(ref => ref.kind === 'runtime_contract')) {
      const reference = { path: ref.artifact, sha256: ref.sha256 };
      const proof = JSON.parse((await artifact(reference)).toString('utf8'));
      if (proof.producer === 'caveman-middleware-scoped-native-proof-v1' && proof.cells?.includes(cellKey(row)) &&
        proof.candidates?.some(item => item.path === candidates[0].artifact && item.sha256 === candidates[0].sha256)) proofs.push(reference);
    }
    if (proofs.length !== 1) fail(`missing or duplicate scoped proof for ${cellKey(row)}`);
    const key = `${proofs[0].path}:${proofs[0].sha256}`;
    if (!groups.has(key)) groups.set(key, { proof: proofs[0], rows: [], scope: `${row.family}:${row.language}` });
    const group = groups.get(key);
    if (group.scope !== `${row.family}:${row.language}`) fail('one proof cannot certify another family/language');
    group.rows.push(row);
  }
  await emptyOutput(output);
  const results = [], rows = [], executions = [];
  for (const [index, group] of [...groups.values()].entries()) {
    const replayed = await replayScopedProof(group.proof, { output: `${output}/scope-${index + 1}`, python: pythonByScope[group.scope] });
    for (const row of group.rows) {
      const candidate = assertPromotedRow(row, replayed);
      rows.push(JSON.parse(JSON.stringify(row)));
      executions.push({ candidate_sha256: candidate, source_lock_sha256: replayed.source_lock_sha256,
        input_snapshot_sha256: replayed.input_snapshot_sha256, proof: group.proof });
    }
    results.push(replayed);
  }
  const verified = freeze({ rows, executions, proofs: results, verified_assertions: results.reduce((sum, item) => sum + item.verified_assertions, 0) });
  freshBundles.add(verified);
  return verified;
}

/** Bridge for inventory.mjs: call this instead of trusting a caller's hash set. */
export function scopedExecutionForRow(row, reference, verified) {
  if (!freshBundles.has(verified) || !verified.executions) fail('inventory needs an actual fresh batch of scoped proof replays');
  const exact = verified.rows.find(item => cellKey(item) === cellKey(row));
  if (!exact || !equal(exact, row)) fail('inventory row differs from its fresh replay');
  const candidate = row.evidence.find(item => item.kind === 'native_fixture');
  if (candidate?.artifact !== reference.artifact || candidate.sha256 !== reference.sha256) fail('native reference differs from replay-derived row');
  const execution = verified.executions.find(item => item.candidate_sha256 === reference.sha256);
  if (!execution) fail('native candidate has no fresh scoped execution');
  return execution;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = Object.fromEntries(process.argv.slice(2).map(value => value.replace(/^--/, '').split(/=(.*)/s, 2)));
  (async () => {
    if (!args.inputs || !args.coverage || !args.output) fail('use --inputs=INPUTS.json --coverage=COVERAGE.json --output=NEW_REPOSITORY_DIRECTORY [--python=EXACT_INTERPRETER]');
    const input = await reference(args.inputs), coverageRef = await reference(args.coverage);
    const coverage = JSON.parse((await artifact(coverageRef)).toString('utf8'));
    const captured = JSON.parse((await artifact(input)).toString('utf8'));
    const required = requiredCells().filter(cell => cell.family === captured.family && cell.language === captured.language).map(cell => cell.id).sort();
    if (coverage.evidence_class !== 'candidate_coverage_not_promotion' || coverage.input_snapshot_sha256 !== digest(captured) ||
      !equal(coverage.cells?.map(cell => cell.id).sort(), required) || coverage.cells.some(cell => cell.backed !== true || cell.missing?.length || !cell.artifact)) fail('coverage must retain every exact required cell and its complete candidate');
    const report = await promoteNativeGroup({ input, candidates: coverage.cells.map(cell => cell.artifact), output: args.output, python: args.python });
    process.stdout.write(encode(report));
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
