/** Capture source coverage only. This command cannot issue a certification. */
import { readFile, readdir, writeFile, mkdir, stat, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  families, requiredCells, requiredCounts, specificationFiles, sharedTestPaths, requirementTestHints, knownImplementationGaps,
} from './catalog.mjs';
import { root, supportPath, matrixPath, sha256, fileHash, parseSpecification, renderMatrix, providerVersions } from './inventory.mjs';
import { requiredNativeSources } from './source-scope.mjs';
import { captureRuntimeClosure } from './runtime-build.mjs';

const exists = async path => stat(resolve(root, path)).then(value => value.isFile()).catch(() => false);
const writeJSON = async (path, value) => writeFile(resolve(root, path), `${JSON.stringify(value, null, 2)}\n`);
async function walk(path) {
  const result = [];
  for (const entry of await readdir(resolve(root, path), { withFileTypes: true }).catch(() => [])) {
    if (entry.name.startsWith('.') || ['node_modules', 'dist', '__pycache__'].includes(entry.name)) continue;
    const child = `${path}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await walk(child));
    else if (entry.isFile()) result.push(child);
  }
  return result.sort();
}

const configs = families.flatMap(family => Object.values(family.languages));
const testPaths = [...new Set([...sharedTestPaths, ...configs.flatMap(config => config.tests),
  'proxy/internal/middleware/acceptance_test.go',
  'packages/sdk/typescript/tests/middleware-reports.runtime.mjs',
  'packages/sdk/python/tests/test_middleware_reports.py',
  'packages/middleware/conformance/support/acceptance.test.mjs',
  'packages/middleware/conformance/support/certify.test.mjs',
  'packages/middleware/conformance/support/promote.test.mjs',
  'packages/middleware/conformance/support/qualified-inventory.test.mjs',
  'packages/middleware/conformance/support/apply-support.test.mjs',
  'packages/middleware/conformance/support/runtime-build.test.mjs',
  'packages/middleware/conformance/support/source-scope.test.mjs',
  'packages/middleware/conformance/packaging/native-provenance.test.mjs',
  'packages/middleware/conformance/hosted-native.test.mjs',
  'packages/middleware/conformance/stream-memory.test.mjs',
])].sort();
const allTests = [];
function rerun(file) {
  if (file === 'examples/middleware/ai-sdk/composition.test.mjs') return {
    program: 'node', args: ['--test', file], cwd: '.',
    setup: 'Build packages/sdk/typescript and packages/middleware/typescript; install both examples/middleware/ai-sdk/package-lock.json and examples/middleware/mastra/package-lock.json for the pinned native OpenAI and Anthropic provider fetch composition.',
  };
  if (['examples/middleware/litellm/composition_test.py', 'packages/middleware/conformance/composition-python.test.mjs'].includes(file)) return {
    program: 'node', args: ['--test', 'packages/middleware/conformance/composition-python.test.mjs'], cwd: '.',
    env: { CAVEMAN_MIDDLEWARE_TEST_PYTHON: '<python executable from the exact composition hash-locked environment>' },
    setup: 'Install examples/middleware/litellm/composition-requirements.lock into an isolated Python >=3.13 environment. The runner starts the real local runtime and substitutes only provider HTTP responses.',
  };
  if (file.endsWith('.mjs')) return { program: 'node', args: ['--test', file], cwd: '.', setup: 'Build packages/sdk/typescript and packages/middleware/typescript; install the exact example lock first.' };
  if (file.endsWith('.go')) return { program: 'go', args: ['test', '-count=1', `./${file.split('/').slice(1, -1).join('/')}`], cwd: file.split('/')[0], setup: 'Use the checked-in Go module and sum files.' };
  const family = file.match(/^examples\/middleware\/([^/]+)\//)?.[1];
  if (family) return {
    program: 'node', args: ['--test', family === 'python-provider-sdks' ? 'packages/middleware/conformance/python-provider.test.mjs' : 'packages/middleware/conformance/python-framework.test.mjs'], cwd: '.',
    env: { CAVEMAN_MIDDLEWARE_TEST_FAMILY: family, CAVEMAN_MIDDLEWARE_TEST_PYTHON: '<python executable from the exact hash-locked environment>' },
    setup: 'Install this example requirements.lock into an isolated Python >=3.13 environment. The runner starts the real local runtime and substitutes only provider fixtures.',
  };
  return { program: 'python3', args: ['-m', 'unittest', file.replace(/\.py$/, '').replaceAll('/', '.')], cwd: '.', setup: 'Set PYTHONPATH=packages/sdk/python and use the SDK runtime floor.' };
}
const templateCases = {
  'Google native ${operation} AFC recovers original source without changing history': ['generate', 'stream', 'chat', 'chat-stream'].map(operation => ({ operation })),
  'Google ${mode} preserves all native AFC methods and provider call count': ['off', 'outage'].map(mode => ({ mode })),
  'Mastra ${family} ${operation} native loop recovers original bytes and preserves memory/UI history': ['openai', 'anthropic'].flatMap(family => ['generate', 'stream'].map(operation => ({ family, operation }))),
  'Mastra ${family} ${mode} preserves native generation and streaming call counts': ['openai', 'anthropic'].flatMap(family => ['off', 'outage'].map(mode => ({ family, mode }))),
  'Mastra ${family} structured output, forced tools and schema-only collision preserve native requests': ['openai', 'anthropic'].map(family => ({ family })),
  'Mastra ${family} abort, early close and native failure never replay inference': ['openai', 'anthropic'].map(family => ({ family })),
};

for (const file of testPaths) {
  if (!(await exists(file))) continue;
  const source = await readFile(resolve(root, file), 'utf8');
  const digest = sha256(source);
  let currentClass = '';
  for (const [index, line] of source.split('\n').entries()) {
    const klass = line.match(/^class (\w+).*:/);
    if (klass) currentClass = klass[1];
    let names = [], declaration, template;
    const python = line.match(/^\s*(?:async )?def (test_\w+)\(/);
    const go = line.match(/^func ((?:Test|Benchmark)\w+)\(/);
    const node = line.match(/\btest\(\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)/);
    if (python) { names = [`${currentClass}.${python[1]}`]; declaration = `def ${python[1]}(`; }
    if (go) { names = [go[1]]; declaration = `func ${go[1]}(`; }
    if (node) {
      template = node[1] ?? node[2] ?? node[3]; declaration = node[0];
      names = templateCases[template]?.map(values => template.replace(/\$\{(\w+)\}/g, (_, key) => values[key])) ?? [template];
    }
    for (const name of names) allTests.push({
      id: `${file}::${name}`, file, name, line: index + 1, declaration, sha256: digest,
      evidence_scope: 'source_only', fixture_scope: file.startsWith('examples/') ? 'installed_framework_local_fixture_source' : 'local_contract_or_validator_source',
      ...(template?.includes('${') ? { declared_template: template, concrete_case_resolved: !name.includes('${') } : {}),
      rerun: rerun(file),
    });
  }
}

const files = new Map();
async function add(path, role) {
  if (await exists(path)) files.set(path, { path, sha256: await fileHash(path), role });
}
for (const path of specificationFiles) await add(path, 'specification');
for (const path of await walk('proxy/internal/middleware')) if (/\.(go|json)$/.test(path)) await add(path, 'runtime_source');
for (const path of await walk('proxy/internal/store')) if (/\.go$/.test(path)) await add(path, 'runtime_source');
for (const path of await walk('engine')) if (/\.(go|mod|sum)$/.test(path)) await add(path, 'runtime_source');
for (const path of await walk('mcp')) if (/\.(go|mod|sum)$/.test(path)) await add(path, 'runtime_source');
for (const path of ['proxy/go.mod', 'proxy/go.sum', 'proxy/cmd/caveman-proxy/main.go', 'proxy/internal/standalone/middleware.go']) await add(path, 'runtime_source');
for (const path of [...await walk('packages/sdk/typescript/src/middleware'), ...await walk('packages/sdk/python/caveman_cloud/middleware')]) await add(path, 'sdk_source');
for (const path of [...await walk('packages/middleware/typescript/src'), ...await walk('packages/middleware/python/caveman_middleware')]) await add(path, 'adapter_source');
for (const config of configs) for (const lock of config.lock) await add(lock, 'dependency_lock');
for (const path of ['packages/middleware/typescript/package.json', 'packages/middleware/python/pyproject.toml', 'packages/sdk/typescript/package.json', 'packages/sdk/python/pyproject.toml', 'packages/sdk/parity/middleware.fixtures.json']) await add(path, 'package_or_fixture');
for (const path of await walk('packages/shared/contracts/schemas')) if (/middleware-.*\.schema\.json$/.test(path)) await add(path, 'contract_schema');
await add('packages/middleware/conformance/upstream-lock.json', 'upstream_registry_metadata');
for (const path of [...testPaths, 'packages/middleware/conformance/runtime-fixture.mjs', 'packages/middleware/conformance/python-framework.test.mjs', 'packages/middleware/conformance/python-provider.test.mjs', 'packages/middleware/conformance/performance.mjs', 'packages/middleware/conformance/packaged-consumer.mjs']) await add(path, 'test_source');
// The global source inventory includes every current native entry point and
// its owned imports. These remain source locators, never execution evidence.
for (const family of families) for (const [language, config] of Object.entries(family.languages)) {
  for (const source of await requiredNativeSources({ family: family.id, language, tests: config.tests })) await add(source.path, source.role);
}
// Resolve actual compiler-selected sources and embeds, including root module
// files and shared dependencies outside the former directory globs.
for (const target of ['proxy', 'mcp']) {
  const output = await mkdtemp(resolve(tmpdir(), `caveman-inventory-${target}-`));
  const closure = await captureRuntimeClosure({ target, output });
  for (const source of closure.files) await add(source.path, 'runtime_source');
}
for (const directory of ['packages/middleware/conformance/support', 'packages/middleware/conformance/packaging']) {
  for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
    if (entry.isFile() && /\.(?:mjs|py)$/.test(entry.name)) await add(`${directory}/${entry.name}`, 'test_source');
  }
}
for (const path of ['packages/middleware/conformance/support/release-gates.json',
  'packages/middleware/conformance/support/acceptance-criteria.json',
  'packages/middleware/conformance/verify-support.mjs',
  'packages/middleware/conformance/soak.mjs', 'packages/middleware/conformance/soak-storage.py',
  'packages/middleware/conformance/plot-soak.py']) await add(path, 'test_source');
const sources = { schema_version: 1, evidence_class: 'source_snapshot_not_execution', files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)) };

const specification = await Promise.all(specificationFiles.map(async path => ({ path, sha256: await fileHash(path) })));
const cells = requiredCells();
const frozen = {
  schema_version: 1, revision: sha256(JSON.stringify({ specification, cells })),
  counts: { ...requiredCounts, operation_cells: cells.length }, specification, cells,
  source_lock: { path: `${supportPath}/source-lock.json`, sha256: sha256(`${JSON.stringify(sources, null, 2)}\n`) },
};

function relatedOperationTests(cell, config) {
  let candidates = allTests.filter(test => config.tests.includes(test.file));
  if (cell.family === 'F01' && cell.language === 'python') candidates = candidates.filter(test => test.name.includes('openai'));
  if (cell.family === 'F02' && cell.language === 'python') candidates = candidates.filter(test => test.name.includes('anthropic'));
  if (cell.family === 'F04' && cell.method === 'nested_provider_client_ownership') {
    return candidates.filter(test => test.file === 'examples/middleware/ai-sdk/composition.test.mjs' && test.name.includes(`AI SDK ${cell.provider} `)).map(test => test.id);
  }
  if (cell.family === 'F07' && cell.method === 'asgi_composition') {
    return candidates.filter(test => test.file === 'examples/middleware/litellm/composition_test.py' && test.name.includes(`test_${cell.provider}_`)).map(test => test.id);
  }
  // Composition fixtures locate their exact composed cells. Their presence does
  // not establish all other methods, providers or proxy deployment contracts.
  candidates = candidates.filter(test => !['examples/middleware/ai-sdk/composition.test.mjs', 'examples/middleware/litellm/composition_test.py'].includes(test.file));
  if (cell.family === 'F04' && cell.provider === 'anthropic') return [];
  if (cell.family === 'F07' && (cell.provider === 'anthropic' || cell.method.startsWith('proxy.'))) return [];
  if (cell.family === 'F09' && cell.provider !== 'bedrock') return [];
  if (cell.family === 'F03' && cell.provider === 'vertex') candidates = candidates.filter(test => /vertex/i.test(test.name));
  if (cell.family === 'F16') candidates = candidates.filter(test => !/Mastra (openai|anthropic) /.test(test.name) || test.name.includes(`Mastra ${cell.provider} `));
  if (['F05', 'F06'].includes(cell.family) && cell.provider === 'anthropic') candidates = candidates.filter(test => /anthropic/i.test(test.name));
  const words = cell.method.split(/[._]/).filter(word => word.length > 3 && !['model', 'native', 'agent'].includes(word));
  const matching = candidates.filter(test => words.some(word => test.name.toLowerCase().includes(word.toLowerCase())));
  return (matching.length ? matching : candidates).slice(0, 4).map(test => test.id);
}
const manifests = [];
for (const cell of cells) {
  const config = families.find(family => family.id === cell.family).languages[cell.language];
  const sourceExists = config.source.every(path => files.has(path));
  const implementationGap = knownImplementationGaps[`${cell.family}:${cell.method}`];
  const tests = relatedOperationTests(cell, config);
  const references = [...config.source, ...config.lock, 'packages/middleware/conformance/upstream-lock.json', ...tests.map(id => allTests.find(test => test.id === id).file)];
  const providerSDKs = await providerVersions(config, cell.provider);
  const limitations = [
    'No accepted, independently replayed execution record proves the full seven-step installed-framework journey for this exact operation cell.',
    implementationGap ?? (sourceExists ? 'Implemented records the inspected native adapter seam only; method/provider behavior and all matching acceptance criteria remain unverified.' : 'The required adapter source is absent from this snapshot; this mandatory cell remains missing.'),
    tests.length ? 'Listed tests are related source coverage, not a claim that this operation or its entire journey passed. No fixture result is upgraded to live-provider proof.' : 'No exact native test source was identified for this operation/provider cell.',
    'No live-provider, complete packaged-consumer, native OS distribution, provider cache-hit, or economic certification is claimed.',
  ];
  if (!Object.keys(providerSDKs).length) limitations.push(cell.family === 'F07' && cell.method === 'asgi_composition' && cell.provider === 'anthropic'
    ? 'This native composition uses the pinned LiteLLM Anthropic Messages API and HTTPX transport directly; it does not instantiate a standalone Anthropic SDK client.'
    : 'No matching provider SDK pin was found in this cell dependency lock; provider-path proof is missing.');
  if (cell.family === 'F13') limitations.push('The protocol names the actual native-host/server negotiation: Python SDK 2.2 uses 2026-07-28, TypeScript SDK 1.30 uses 2025-11-25, and the existing Engine MCP server uses 2024-11-05. Host-result handling does not establish provider-wire or usage evidence.');
  const starlette = cell.family === 'F12' && cell.method.startsWith('starlette.');
  manifests.push({
    schema_version: 1, family: cell.family, language: cell.language,
    framework: starlette ? 'starlette' : config.framework, version: starlette ? '1.6.0' : config.version,
    method: cell.method, runtime_protocol: 1, state: sourceExists && !implementationGap ? 'implemented' : 'missing',
    adapter_package: cell.language === 'python' ? 'caveman-middleware' : '@caveman-ai/middleware', adapter_version: '0.1.0',
    provider: cell.provider, protocol: cell.protocol, provider_sdk_versions: providerSDKs,
    execution: cell.execution, streaming: cell.streaming, structured_output: cell.structured_output,
    recovery: cell.recovery, persistence: 'scoped_durable',
    serialization_visibility: config.serialization_visibility ?? (['F01', 'F02', 'F03', 'F12'].includes(cell.family) ? 'provider_http' : 'native_model'),
    evidence: [...new Set(references)].filter(path => files.has(path)).map(path => ({ kind: path.endsWith('upstream-lock.json') ? 'upstream_source' : 'source_probe', artifact: path, sha256: files.get(path).sha256 })),
    tests, limitations,
  });
}

const requirements = await parseSpecification();
if (requirements.length !== 29 || requirements.flatMap(requirement => requirement.acceptance).length !== 180) throw new Error('Specification cardinality changed; review the scope instead of silently regenerating.');
const traceability = { schema_version: 1, evidence_class: 'source_traceability_not_acceptance', requirements: requirements.map(requirement => ({
  ...requirement,
  acceptance: requirement.acceptance.map(item => {
    let tests;
    if (item.id.startsWith('adapters.R1.F')) {
      const family = families.find(family => item.id.endsWith(family.id));
      const paths = Object.values(family.languages).flatMap(config => config.tests);
      tests = allTests.filter(test => paths.includes(test.file)).map(test => test.id);
    } else {
      const hints = requirementTestHints[requirement.id] ?? [];
      tests = allTests.filter(test => hints.some(hint => test.name.toLowerCase().includes(hint.toLowerCase()))).slice(0, 12).map(test => test.id);
    }
    return {
      ...item, state: tests.length ? 'implemented' : 'missing', tests, proof: [],
      source_coverage: tests.length ? 'Related test declarations are locators for further verification. They may cover only part of this criterion and are not accepted execution evidence.' : 'No matching named test or bounded benchmark was identified.',
      missing_proof: `No accepted execution artifact proves this complete acceptance item: ${item.text}`,
    };
  }),
})) };

const legacyPaths = (await walk('examples/middleware')).filter(path => /(?:evidence|compatibility)\.json$/.test(path));
const performancePath = 'packages/middleware/conformance/evidence/performance-reporting-v1.json';
if (await exists(performancePath)) legacyPaths.push(performancePath);
for (const path of (await walk('packages/middleware/conformance/evidence')).filter(path => path.endsWith('.json'))) legacyPaths.push(path);
const acceptancePath = `${supportPath}/acceptance-evidence/report.json`;
if (await exists(acceptancePath)) legacyPaths.push(acceptancePath);
const artifacts = await Promise.all([...new Set(legacyPaths)].sort().map(async path => ({ path, sha256: await fileHash(path),
  classification: path === performancePath ? 'local_runtime_performance_native_candidate' : 'retained_local_candidate_not_accepted_certification' })));
const performance = await exists(performancePath) ? JSON.parse(await readFile(resolve(root, performancePath), 'utf8')) : null;
const reports = { schema_version: 1, artifacts, gates: [
  { id: 'native_journeys', state: 'incomplete', priority: 1, description: 'Native candidates exist across all 16 families. Each conformant manifest row must come from its exact scoped source/build inputs and a fresh independent replay. Remaining required Strands behavior and complete family acceptance remain open.' },
  { id: 'shared_correctness', state: 'incomplete', priority: 1, description: 'The native Go acceptance producer distinguishes fully covered criteria from partial components. Complete cross-framework fidelity, recovery, process/worker stability, isolation, failure and accounting proof is still required; source locators never promote a criterion.' },
  { id: 'composition', state: 'incomplete', priority: 1, description: 'The four named native compositions have executing fixtures. Complete owner, auth/guardrail, attempt and receipt criteria require explicit scoped acceptance evidence beyond an operation journey.' },
  { id: 'performance', state: !performance ? 'missing' : Object.values(performance.gates ?? {}).some(value => value === false) ? 'failed' : 'incomplete', priority: 1,
    description: performance ? `The latest retained native candidate used ${performance.cold?.requests ?? 'unknown'} measured calls per phase at concurrency ${performance.concurrency}. Adapter-only p95 is ${performance.adapter_only?.p95_ms ?? 'unknown'} ms; cold optimize p95 is ${performance.cold?.p95_ms ?? 'unknown'} ms; warm p95 is ${performance.warm?.p95_ms ?? 'unknown'} ms. Cold/warm bypass fractions are ${performance.cold?.bypass_fraction ?? 'unknown'}/${performance.warm?.bypass_fraction ?? 'unknown'}. Dedicated host: ${performance.dedicated_host === true ? 'yes' : 'no'}. Historical failures remain retained. Complete dedicated-host, pre-dispatch deadline and overload criteria are not certified by these candidate measurements.` : 'No complete dedicated-host performance run has been recorded.' },
  { id: 'stream_and_soak', state: 'incomplete', priority: 2, description: 'Retained native stream and 30-minute soak runs include resource counters, storage samples and graphs. They remain scoped candidates until their complete source/build inputs and exact lifecycle, buffering and retention criteria are accepted.' },
  { id: 'packaging', state: 'incomplete', priority: 2, description: 'The harness contains 23 isolated consumers per platform and requires actual native build provenance before packaging. Complete current-source macOS and Linux reports, docs execution and every packaging criterion still need final qualification. Native Windows remains uncertified.' },
  { id: 'live_provider_record', state: 'missing', priority: 3, description: 'No accepted live-provider coverage record exists. Auth, endpoint, model/version/date, streaming/recovery, and usage completeness need their own bounded, explicitly authorized runs. Local fixtures are not cloud-auth evidence.' },
  { id: 'task_comparison', state: 'incomplete', priority: 3, description: 'The harness contains 24 frozen tasks, native common-intersection arms, rotation/cache strata, independent oracles and budget controls. Actual paid task outcomes and redacted provider receipts are absent. No provider-cost superiority or quality-equivalence claim is supported.' },
] };
const tests = { schema_version: 1, evidence_class: 'test_source_inventory', tests: allTests };
const inventory = { frozen, traceability, tests, sources, reports, manifests };
await mkdir(resolve(root, `${supportPath}/manifests`), { recursive: true });
for (const [name, value] of Object.entries({ 'required-cells': frozen, 'traceability': traceability, 'test-catalog': tests, 'source-lock': sources, reports })) await writeJSON(`${supportPath}/${name}.json`, value);
for (const family of families) await writeJSON(`${supportPath}/manifests/${family.id}.json`, manifests.filter(row => row.family === family.id));
await writeFile(resolve(root, matrixPath), renderMatrix(inventory));
console.log(`Source inventory written: ${cells.length} required cells; 29 requirements; 180 acceptance items; ${allTests.length} exact test declarations. No certification granted.`);
