import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { hasObservation } from './observations.mjs';
import { families, requiredCells, cellKey, requiredCounts, operationCounts, specificationFiles, mandatoryJourney, knownImplementationGaps, providerSdkNames } from './catalog.mjs';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
export const supportPath = 'packages/middleware/conformance/support';
export const matrixPath = 'docs/technical/framework-middleware-support.md';
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const json = async path => JSON.parse(await readFile(resolve(root, path), 'utf8'));
export const fileHash = async path => sha256(await readFile(resolve(root, path)));
const stable = value => JSON.stringify(value);
const allStates = ['missing', 'implemented', 'conformant', 'provider_tested', 'not_applicable'];

export async function dependencyVersions(paths) {
  const versions = new Map();
  for (const path of paths) {
    const raw = await readFile(resolve(root, path), 'utf8').catch(() => '');
    if (path.endsWith('package-lock.json') && raw) {
      const lock = JSON.parse(raw);
      for (const [key, entry] of Object.entries(lock.packages ?? {})) {
        if (key.startsWith('node_modules/') && !key.slice(13).includes('/node_modules/') && entry.version) versions.set(key.slice(13), entry.version);
      }
    } else if (path.endsWith('requirements.lock')) {
      for (const match of raw.matchAll(/^([a-zA-Z0-9._-]+)(?:\[[^\]]+\])?==([^\s\\]+)\s*\\?$/gm)) versions.set(match[1].replaceAll('_', '-'), match[2]);
    } else if (path.endsWith('pnpm-lock.yaml')) {
      for (const match of raw.matchAll(/^  ['"]?(@?[^\s:'"]+)@([^\s:'"]+)['"]?:\s*$/gm)) {
        const version = match[2].split('(')[0];
        if (!versions.has(match[1])) versions.set(match[1], version);
      }
    }
  }
  return versions;
}

export async function providerVersions(config, provider) {
  const versions = await dependencyVersions(config.lock);
  return Object.fromEntries((providerSdkNames[provider] ?? []).filter(name => versions.has(name)).map(name => [name, versions.get(name)]));
}

export async function parseSpecification() {
  const requirements = [];
  for (const path of specificationFiles.filter(path => /\/spec-/.test(path))) {
    const scope = path.match(/spec-(.+)\.md$/)[1].replace('overview', 'overview');
    const lines = (await readFile(resolve(root, path), 'utf8')).split('\n');
    let current;
    for (let index = 0; index < lines.length; index++) {
      const heading = lines[index].match(/^### (R\d+): (.+)$/);
      if (heading) {
        current = { id: `${scope}.${heading[1]}`, title: heading[2], path, line: index + 1, acceptance: [] };
        requirements.push(current);
      }
      if (!current) continue;
      const family = lines[index].match(/^\| (F\d{2}) \|.*?\| \[ \] (.*?) \|$/);
      if (family) {
        current.acceptance.push({ id: `${current.id}.${family[1]}`, text: family[2], path, line: index + 1 });
        continue;
      }
      const checkbox = lines[index].match(/^- \[ \] (.+)$/);
      if (!checkbox) continue;
      const line = index + 1;
      let text = checkbox[1];
      while (index + 1 < lines.length && /^  \S/.test(lines[index + 1])) text += ` ${lines[++index].trim()}`;
      current.acceptance.push({ id: `${current.id}.AC${String(current.acceptance.length + 1).padStart(2, '0')}`, text, path, line });
    }
  }
  return requirements;
}

export async function loadInventory() {
  const [frozen, traceability, tests, sources, reports] = await Promise.all([
    json(`${supportPath}/required-cells.json`), json(`${supportPath}/traceability.json`),
    json(`${supportPath}/test-catalog.json`), json(`${supportPath}/source-lock.json`), json(`${supportPath}/reports.json`),
  ]);
  const manifests = (await Promise.all(families.map(family => json(`${supportPath}/manifests/${family.id}.json`)))).flat();
  return { frozen, traceability, tests, sources, reports, manifests };
}

export function completionGaps(inventory) {
  const { manifests, traceability, reports } = inventory;
  const operations = manifests.filter(row => !['conformant', 'provider_tested', 'not_applicable'].includes(row.state));
  const acceptance = traceability.requirements.flatMap(requirement => requirement.acceptance).filter(item => item.state !== 'conformant');
  return {
    complete: operations.length === 0 && acceptance.length === 0 && reports.gates.every(gate => gate.state === 'passed'),
    operations: operations.map(row => ({ id: cellKey(row), state: row.state, missing_proof: row.limitations[0] })),
    acceptance: acceptance.map(item => ({ id: item.id, state: item.state, missing_proof: item.missing_proof })),
    release_gates: reports.gates.filter(gate => gate.state !== 'passed'),
  };
}

function safe(value) { return String(value).replaceAll('|', '\\|').replaceAll('\n', ' '); }
function counts(rows) { return Object.fromEntries(allStates.map(state => [state, rows.filter(row => row.state === state).length])); }

export function renderMatrix(inventory) {
  const { manifests, frozen, traceability, reports } = inventory;
  const stateCounts = counts(manifests);
  const acceptance = traceability.requirements.flatMap(requirement => requirement.acceptance);
  const lines = [
    '# Framework middleware support', '',
    'Generated from the required-cell inventory and per-operation manifests checked by `verify-support.mjs`. Do not edit this report directly.', '',
    `Full middleware is incomplete. The inventory covers ${manifests.length} required operation cells across 16 families and 23 family/language pairs, plus 29 normative requirements and 180 acceptance items.`, '',
    `${stateCounts.implemented} cells have an implementation seam, ${stateCounts.missing} are missing, ${stateCounts.conformant} are conformant, and ${stateCounts.provider_tested} are provider-tested. ${acceptance.filter(item => item.state === 'conformant').length} acceptance items have accepted complete proof.`, '',
    '`implemented` records inspected source only. Test names and existing local evidence are candidate proof, not certification. No row inherits certification from a wrapped adapter. Registry pins identify intended test versions; they do not assert that this inventory reran those versions.', '',
    '`conformant` requires the installed-framework journey, including the disabled and unavailable-optimizer baselines, with matching operation scope, exact tests, native execution output, and source/lock hashes. The validator requires independent replay before accepting certification. `provider_tested` also requires real provider/model/SDK/date/usage evidence. A local HTTP fixture does not prove live provider authentication, provider cache hits, invoice savings, or production compatibility.', '',
    '`not_applicable` is reserved for an upstream-absent API established by a versioned source excerpt. A required but unimplemented method stays `missing`. Unsupported installed versions must produce the separate `unsupported_version` runtime outcome; no version range is certified here.', '',
    'Method keys combine public entry points with required behavior (for example cancellation, checkpoint resume, or source expansion). They are inventory labels, not additional exported SDK functions. Python `sync` and `async` rows refer to the corresponding native entry points. The provider/protocol column identifies required fixture coverage, including currently untested combinations.', '',
    'The recovery and persistence columns describe the required integration contract. They do not certify that a missing or implemented row satisfies it. Model-only paths must prove their recovery-free behavior; lossy agent paths need the real host executor.', '',
    'Run from the repository root:', '',
    '```sh', 'node packages/middleware/conformance/verify-support.mjs',
    'node --test packages/middleware/conformance/support/verify-support.test.mjs',
    'node packages/middleware/conformance/verify-support.mjs --audit-completion', '```', '',
    'The first command validates an honest incomplete inventory. The completion audit intentionally exits nonzero while mandatory proof or release gates remain open. `--json` returns the complete machine-readable gap report. Add `--replay` when validating future certified rows. No command here launches live-provider traffic.', '',
    'After implementation or tests change, run `node packages/middleware/conformance/support/build-source-inventory.mjs` to capture a new source snapshot and regenerate this page. This source-only command resets operation certification; it never promotes a row from a success field.', '',
    '## Blocking proof', '',
  ];
  for (const gate of reports.gates.filter(gate => gate.state !== 'passed')) lines.push(`- **${safe(gate.id)} (${gate.state}):** ${gate.description}`);
  lines.push('', '## Family summary', '', '| Family | Languages | Implemented | Missing | Conformant | Provider tested | Upstream absent |', '|---|---|---:|---:|---:|---:|---:|');
  for (const family of families) {
    const summary = counts(manifests.filter(row => row.family === family.id));
    lines.push(`| ${family.id} ${family.name} | ${Object.keys(family.languages).join(', ')} | ${summary.implemented} | ${summary.missing} | ${summary.conformant} | ${summary.provider_tested} | ${summary.not_applicable} |`);
  }
  lines.push('', '## Source and traceability', '',
    `- [Required operation cells](../../${supportPath}/required-cells.json) freeze every mandatory cell against the six specification files.`,
    `- [Requirement traceability](../../${supportPath}/traceability.json) contains the exact text and line of all 180 acceptance items, exact related test names, and missing proof. A related test is not a complete acceptance result.`,
    `- [Test catalog](../../${supportPath}/test-catalog.json) records source hashes, declaration lines, fixture scope, and rerun instructions. Dynamic test cases retain their declared template and its concrete case names.`,
    `- [Source lock](../../${supportPath}/source-lock.json) binds adapter, SDK, runtime, test, schema, and dependency-lock files. Stale hashes fail validation.`,
    `- [Existing reports](../../${supportPath}/reports.json) classify legacy local artifacts. Handwritten evidence summaries cannot certify an operation.`,
    '', 'Inventory revision: `' + frozen.revision + '`. Specification acceptance counts: overview 16, runtime 77, adapters 43, proof 44.', '',
    '## Operation matrix', '',
    'All rows require scoped durable replacement state. `native_executor` means recovery must execute in the host loop; `operator_bound` means an explicit trusted reader/client binding is required; `model_only` means the default must remain recovery-free. Serialization visibility records the layer where a future test must observe the request; source-only rows provide no byte-stability certification.', '',
  );
  for (const family of families) {
    lines.push(`<details><summary>${family.id} ${family.name}</summary>`, '',
      '| Language / pinned framework | Provider / protocol | Required operation | Execution | Stream | Structured | Recovery | Required visibility | State |',
      '|---|---|---|---|---|---|---|---|---|');
    for (const row of manifests.filter(row => row.family === family.id)) {
      lines.push(`| ${row.language} / ${safe(row.framework)} ${row.version} | ${safe(row.provider)} / ${safe(row.protocol)} | ${safe(row.method)} | ${row.execution} | ${row.streaming ? 'yes' : 'no'} | ${row.structured_output ? 'yes' : 'no'} | ${row.recovery} | ${row.serialization_visibility} | ${row.state} |`);
    }
    lines.push('', `[Operation manifests and exact evidence references](../../${supportPath}/manifests/${family.id}.json)`, '', '</details>', '');
  }
  return `${lines.join('\n')}\n`;
}

export async function validateInventory(inventory, { checkDocs = true, replayed = new Set() } = {}) {
  const errors = [];
  const add = (condition, message) => { if (!condition) errors.push(message); };
  const { frozen, manifests, tests, sources, traceability, reports } = inventory;
  const expected = requiredCells();
  const expectedKeys = new Set(expected.map(cell => cell.id));
  add(expected.length === Object.values(operationCounts).reduce((sum, count) => sum + count, 0), 'required catalog operation count changed without a reviewed freeze');
  for (const family of families) add(expected.filter(cell => cell.family === family.id).length === operationCounts[family.id], `${family.id}: required catalog count drift`);
  add(stable(frozen.cells) === stable(expected), 'required-cell freeze differs from mandatory catalog; omitted or changed cells are not allowed');
  add(frozen.counts.requirements === requiredCounts.requirements && frozen.counts.acceptance_items === requiredCounts.acceptance_items, 'requirement counts changed');
  add(frozen.counts.operation_cells === expected.length, 'required-cell count mismatch');
  add(new Set(manifests.map(cellKey)).size === manifests.length, 'duplicate operation cell');
  add(manifests.length === expected.length, `mandatory operation count mismatch: expected ${expected.length}, found ${manifests.length}`);
  for (const cell of expected) add(manifests.some(row => cellKey(row) === cell.id), `missing mandatory cell ${cell.id}`);
  for (const row of manifests) add(expectedKeys.has(cellKey(row)), `unexpected or changed mandatory cell ${cellKey(row)}`);

  const seenArtifacts = new Map();
  async function artifact(ref, label) {
    if (!ref || typeof ref.path !== 'string' || !/^[a-f0-9]{64}$/.test(ref.sha256 ?? '')) { errors.push(`${label}: missing source/artifact digest`); return false; }
    if (ref.path.includes('\\') || ref.path.startsWith('/') || ref.path.split('/').some(part => part === '..' || !part)) { errors.push(`${label}: artifact path must stay in repository`); return false; }
    const key = `${ref.path}:${ref.sha256}`;
    if (seenArtifacts.has(key)) return seenArtifacts.get(key);
    let valid = false;
    try {
      const actual = await realpath(resolve(root, ref.path));
      if (relative(root, actual).startsWith(`..${sep}`) || actual === root) throw new Error('artifact escaped repository');
      valid = await fileHash(ref.path) === ref.sha256;
      add(valid, `${label}: stale sha256 for ${ref.path}`);
    } catch { errors.push(`${label}: missing source/artifact ${ref.path}`); }
    seenArtifacts.set(key, valid);
    return valid;
  }
  for (const spec of frozen.specification) await artifact(spec, 'specification');
  await artifact(frozen.source_lock, 'frozen source lock');
  add(frozen.source_lock?.sha256 === sha256(`${JSON.stringify(sources, null, 2)}\n`), 'source lock differs from the frozen source inventory');
  add(stable(frozen.specification.map(item => item.path).sort()) === stable([...specificationFiles].sort()), 'missing specification source lock');
  const sourceIndex = new Map(sources.files.map(file => [file.path, file]));
  add(sourceIndex.size === sources.files.length, 'duplicate source lock');
  for (const ref of sources.files) await artifact(ref, 'source lock');
  const requiredSourceRoles = ['runtime_source', 'sdk_source', 'adapter_source', 'dependency_lock', 'contract_schema', 'test_source', 'upstream_registry_metadata'];
  for (const role of requiredSourceRoles) add(sources.files.some(file => file.role === role), `missing source lock role ${role}`);

  const require = createRequire(resolve(root, 'packages/shared/contracts/package.json'));
  const Ajv2020 = require('ajv/dist/2020.js').default;
  const schemaDir = 'packages/shared/contracts/schemas';
  const schemas = await Promise.all((await readdir(resolve(root, schemaDir))).filter(name => name.endsWith('.schema.json')).map(name => json(`${schemaDir}/${name}`)));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(schemas);
  const validateSupport = ajv.getSchema('https://caveman.so/schemas/middleware-support.schema.json');
  const testIndex = new Map(tests.tests.map(test => [test.id, test]));
  add(testIndex.size === tests.tests.length, 'duplicate named test');
  for (const test of tests.tests) {
    await artifact({ path: test.file, sha256: test.sha256 }, `test ${test.id}`);
    add(sourceIndex.get(test.file)?.sha256 === test.sha256, `${test.id}: missing matching test source lock`);
    try {
      const lines = (await readFile(resolve(root, test.file), 'utf8')).split('\n');
      add(lines[test.line - 1]?.includes(test.declaration), `${test.id}: test declaration/name no longer exists at recorded line`);
    } catch { /* Missing file was already reported. */ }
    add(test.evidence_scope === 'source_only', `${test.id}: test source cannot claim execution evidence`);
    add(typeof test.name === 'string' && test.name.length > 0 && test.rerun?.program && Array.isArray(test.rerun.args), `${test.id}: exact test and rerun command required`);
  }

  async function executedEvidence(ref, row, kind = 'native_fixture') {
    await artifact({ path: ref.artifact, sha256: ref.sha256 }, `${cellKey(row)} evidence`);
    let record;
    try { record = await json(ref.artifact); } catch { errors.push(`${cellKey(row)}: execution evidence must be structured runner output`); return; }
    const label = `${cellKey(row)} ${kind}`;
    add(record.producer === 'caveman-middleware-native-run-v1', `${label}: handwritten success fields are not execution proof`);
    add(record.evidence_class === kind, `${label}: wrong evidence class`);
    add(record.cells?.includes(cellKey(row)), `${label}: evidence does not cover this exact operation cell`);
    add(record.framework_versions?.[row.framework] === row.version && record.adapter_version === row.adapter_version && record.runtime_protocol === row.runtime_protocol,
      `${label}: framework/adapter/protocol revisions do not match`);
    add(record.runtime?.build && /^[a-f0-9]{64}$/.test(record.runtime?.binary_sha256 ?? ''), `${label}: missing actual runtime binary revision`);
    add(typeof record.runtime?.source_lock_sha256 === 'string' && record.runtime.source_lock_sha256 === sha256(`${JSON.stringify(sources, null, 2)}\n`), `${label}: stale or missing run source lock`);
    add(record.tests?.length > 0 && record.tests.every(test => testIndex.has(test.id) && test.result === 'passed'), `${label}: missing real named passing tests`);
    const covered = new Set(record.tests?.map(test => test.id) ?? []);
    add(row.tests.length > 0 && row.tests.every(id => covered.has(id)), `${label}: named operation tests were not all executed`);
    for (const field of mandatoryJourney) add(record.journey?.[field]?.test_id && covered.has(record.journey[field].test_id) && record.journey[field].observation,
      `${label}: missing observed journey assertion ${field}`);
    add(record.local_provider_fixture === true && record.external_inference_requests === 0, `${label}: native conformance must use a local fixture`);
    if (record.raw_output) {
      await artifact(record.raw_output, `${label} raw execution output`);
      try {
        const output = await readFile(resolve(root, record.raw_output.path), 'utf8');
        add(/# fail 0\b/.test(output) && /# pass [1-9]\d*\b/.test(output) && !/^not ok /m.test(output), `${label}: test runner output is absent, failed, skipped-only, or incomplete`);
        for (const test of record.tests ?? []) add(output.includes(testIndex.get(test.id)?.name ?? '\u0000'), `${label}: raw output does not contain exact test ${test.id}`);
        for (const assertion of mandatoryJourney) add(hasObservation(output, { cell_id: cellKey(row), assertion, ...record.journey?.[assertion] }),
          `${label}: raw execution did not emit the claimed ${assertion} observation for this operation`);
      } catch { /* Artifact error above. */ }
    } else errors.push(`${label}: missing raw test runner output`);
    add(replayed.has(ref.sha256), `${label}: independent native test replay is required; source or a saved success field cannot certify a cell (use --replay)`);
  }

  const dependencyCache = new Map();
  for (const row of manifests) {
    const key = cellKey(row);
    const schemaValid = validateSupport(row);
    add(schemaValid, `${key}: support schema rejected row: ${ajv.errorsText(validateSupport.errors)}`);
    add(allStates.includes(row.state), `${key}: invalid support state`);
    if (!schemaValid) continue;
    add(!knownImplementationGaps[`${row.family}:${row.method}`] || row.state === 'missing', `${key}: known implementation gap cannot be presented as implemented or certified`);
    add(row.limitations.length > 0, `${key}: limitations must distinguish evidence scope`);
    const config = families.find(family => family.id === row.family)?.languages[row.language];
    if (!config) continue;
    const expectedVersion = row.family === 'F12' && row.method.startsWith('starlette.') ? '1.6.0' : config.version;
    const expectedFramework = row.family === 'F12' && row.method.startsWith('starlette.') ? 'starlette' : config.framework;
    add(row.framework === expectedFramework && row.version === expectedVersion, `${key}: pinned framework version changed`);
    const dependencyKey = config.lock.join('|');
    if (!dependencyCache.has(dependencyKey)) dependencyCache.set(dependencyKey, await dependencyVersions(config.lock));
    const dependencies = dependencyCache.get(dependencyKey);
    add(dependencies.get(row.framework) === row.version, `${key}: framework version is not pinned by the actual dependency lock`);
    const expectedProviderVersions = Object.fromEntries((providerSdkNames[row.provider] ?? []).filter(name => dependencies.has(name)).map(name => [name, dependencies.get(name)]));
    add(stable(row.provider_sdk_versions) === stable(expectedProviderVersions), `${key}: provider SDK versions differ from actual dependency lock`);
    const locks = config.lock.filter(path => sourceIndex.has(path));
    add(locks.length === config.lock.length, `${key}: missing dependency source lock`);
    for (const lock of locks) add(row.evidence.some(ref => ref.artifact === lock && ref.sha256 === sourceIndex.get(lock).sha256), `${key}: missing exact dependency lock evidence`);
    if (row.state !== 'missing' && row.state !== 'not_applicable') {
      add(config.source.every(path => sourceIndex.has(path)), `${key}: implemented row has no implementation source lock`);
      for (const path of config.source) add(row.evidence.some(ref => ref.artifact === path && ref.sha256 === sourceIndex.get(path)?.sha256), `${key}: missing implementation source evidence`);
    }
    add(row.tests.every(id => testIndex.has(id)), `${key}: unknown test name`);
    for (const ref of row.evidence) {
      await artifact({ path: ref.artifact, sha256: ref.sha256 }, `${key} evidence`);
      if (ref.kind === 'source_probe' || ref.kind === 'upstream_source') add(sourceIndex.get(ref.artifact)?.sha256 === ref.sha256, `${key}: evidence has no matching source lock`);
    }
    if (['conformant', 'provider_tested'].includes(row.state)) {
      const native = row.evidence.filter(ref => ref.kind === 'native_fixture');
      add(native.length > 0, `${key}: certification requires native execution evidence`);
      for (const ref of native) await executedEvidence(ref, row);
    }
    if (row.state === 'provider_tested') {
      const live = row.evidence.filter(ref => ref.kind === 'provider_live');
      add(live.length > 0, `${key}: provider_tested requires real provider evidence`);
      for (const ref of live) {
        let record;
        try { record = await json(ref.artifact); } catch { errors.push(`${key}: invalid live provider artifact`); continue; }
        add(record.evidence_class === 'provider_live' && record.provider === row.provider && record.model && record.model_version && record.date && record.endpoint && record.auth_class,
          `${key}: missing exact provider/model/version/date/endpoint/auth evidence`);
        add(record.explicit_opt_in === true && record.maximum_spend_usd > 0 && record.usage_completeness && record.raw_receipts?.length > 0,
          `${key}: missing budget opt-in or actual provider receipts`);
        for (const receipt of record.raw_receipts ?? []) await artifact(receipt, `${key} provider receipt`);
      }
    }
    if (row.state === 'not_applicable') {
      const upstream = row.evidence.filter(ref => ref.kind === 'upstream_source');
      add(upstream.length > 0, `${key}: not_applicable requires versioned upstream absence proof`);
      let absent = false;
      for (const ref of upstream) {
        try {
          const record = await json(ref.artifact);
          if (record.evidence_class === 'upstream_api_absence' && record.framework === row.framework && record.version === row.version && record.method === row.method &&
            record.source_url && record.source_revision && record.excerpt && record.reason && record.cells?.includes(key)) absent = true;
        } catch { /* Registry metadata or local source is not absence proof. */ }
      }
      add(absent, `${key}: upstream metadata or an unimplemented method does not establish API absence`);
    }
  }

  const specification = await parseSpecification();
  add(specification.length === 29 && specification.flatMap(requirement => requirement.acceptance).length === 180, 'live specification does not contain the frozen 29 requirements and 180 acceptance items');
  add(traceability.requirements.length === specification.length, 'traceability omitted a normative requirement');
  const acceptanceIds = new Set();
  for (const requirement of specification) {
    const trace = traceability.requirements.find(item => item.id === requirement.id);
    if (!trace) { errors.push(`missing normative requirement ${requirement.id}`); continue; }
    add(trace.acceptance.length === requirement.acceptance.length, `${requirement.id}: omitted acceptance item`);
    for (const criterion of requirement.acceptance) {
      const item = trace.acceptance.find(candidate => candidate.id === criterion.id);
      if (!item) { errors.push(`missing acceptance item ${criterion.id}`); continue; }
      add(!acceptanceIds.has(item.id), `duplicate acceptance item ${item.id}`); acceptanceIds.add(item.id);
      add(item.text === criterion.text && item.path === criterion.path && item.line === criterion.line, `${item.id}: stale or weakened requirement text/reference`);
      add(['missing', 'implemented', 'conformant'].includes(item.state), `${item.id}: invalid traceability state`);
      add(Array.isArray(item.tests) && item.tests.every(id => testIndex.has(id)), `${item.id}: exact named tests required`);
      add(item.state === 'conformant' || (typeof item.missing_proof === 'string' && item.missing_proof.length > 20), `${item.id}: missing proof must be explicit`);
      if (item.state === 'conformant') {
        add(item.proof?.length > 0 && item.tests.length > 0, `${item.id}: implementation is not accepted proof`);
        for (const ref of item.proof ?? []) {
          await artifact(ref, `${item.id} proof`);
          const record = await json(ref.path).catch(() => ({}));
          add(record.producer === 'caveman-middleware-native-run-v1' && record.acceptance_items?.includes(item.id) && replayed.has(ref.sha256), `${item.id}: accepted proof must identify this criterion and pass independent replay`);
          add(record.runtime?.source_lock_sha256 === sha256(`${JSON.stringify(sources, null, 2)}\n`), `${item.id}: stale or missing proof source lock`);
          const covered = new Set(record.tests?.filter(test => test.result === 'passed' && testIndex.has(test.id)).map(test => test.id));
          add(item.tests.length > 0 && item.tests.every(id => covered.has(id)), `${item.id}: proof does not execute every named acceptance test`);
          add(record.criterion_assertions?.[item.id]?.test_id && covered.has(record.criterion_assertions[item.id].test_id) && record.criterion_assertions[item.id].observation,
            `${item.id}: proof needs a test-backed observation of the complete criterion`);
          if (record.raw_output) {
            await artifact(record.raw_output, `${item.id} raw execution output`);
            const output = await readFile(resolve(root, record.raw_output.path), 'utf8').catch(() => '');
            add(hasObservation(output, { acceptance_id: item.id, assertion: item.id, ...record.criterion_assertions?.[item.id] }),
              `${item.id}: raw execution did not emit the claimed acceptance observation`);
          } else errors.push(`${item.id}: missing raw execution output`);
        }
      }
    }
  }
  add(acceptanceIds.size === 180, 'traceability does not cover all 180 acceptance items');
  for (const report of reports.artifacts) await artifact(report, 'existing evidence report');
  const requiredGates = ['native_journeys', 'shared_correctness', 'composition', 'performance', 'stream_and_soak', 'packaging', 'live_provider_record', 'task_comparison'];
  add(requiredGates.every(id => reports.gates.some(gate => gate.id === id)), 'completion report omitted a mandatory proof gate');
  for (const gate of reports.gates) {
    add(['missing', 'incomplete', 'failed', 'passed'].includes(gate.state), `${gate.id}: invalid release gate state`);
    if (gate.state === 'passed') add(gate.acceptance_items?.length > 0 && gate.acceptance_items.every(id =>
      traceability.requirements.flatMap(requirement => requirement.acceptance).some(item => item.id === id && item.state === 'conformant')),
    `${gate.id}: passing release gate requires corresponding accepted requirement proof`);
  }
  if (checkDocs) add((await readFile(resolve(root, matrixPath), 'utf8').catch(() => '')) === renderMatrix(inventory), 'public support matrix is stale; regenerate from the same manifests');
  return { valid: errors.length === 0, errors, counts: { operations: expected.length, requirements: specification.length, acceptance_items: acceptanceIds.size, ...counts(manifests) }, completion: completionGaps(inventory) };
}
