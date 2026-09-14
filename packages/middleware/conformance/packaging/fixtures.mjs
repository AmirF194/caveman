/** Files loaded by each native entry point in its installed consumer. */
const companions = {
  typescript: {
    openai: ['native-fixture.mjs', 'certification-native.mjs', 'certification-evidence.mjs', 'certification-cells.json'],
    anthropic: ['native-fixture.mjs', 'certification-native.mjs', 'certification-evidence.mjs', 'certification-cells.json'],
    google: ['google-certification-native.mjs', 'google-certification-evidence.mjs', 'google-certification-cells.json'],
    'ai-sdk': ['certification-native.mjs', 'certification-evidence.mjs'],
    langchain: ['source-expansion.test.mjs', 'certification-native.mjs', 'certification-evidence.mjs', 'certification-cells.json'],
    strands: ['certification-native.mjs', 'certification-provider.mjs', 'upstream-native.mjs', 'certification-evidence.mjs', 'certification-cells.json'],
    mastra: ['certification-evidence.mjs'],
    mcp: ['_client.mjs', '_provider.mjs', 'example.mjs', '_server.py', 'certification-native.mjs', 'certification-evidence.mjs', 'certification-cells.json'],
  },
  python: {
    openai: ['_http_fixture.py', '_certification_native.py', '_test_result.py'],
    anthropic: ['_http_fixture.py', '_certification_native.py', '_test_result.py'],
    google: ['example.py', '_certification_native.py', '_certification_fixture.py', '_test_result.py', 'certification-cells.json'],
    langchain: ['test_source_expansion.py', '_certification_native.py', '_certification_fixture.py', '_test_result.py', 'certification-cells.json'],
    litellm: ['_provider.py', '_certification_native.py', '_router_cases.py', '_proxy_cases.py', '_passive_cases.py', '_asgi_case.py', '_test_result.py', 'certification-cells.json', 'composition_test.py'],
    strands: ['_certification_native.py', '_certification_provider.py', '_test_result.py', 'certification-cells.json'],
    agno: ['example.py', '_certification_native.py', '_certification_fixture.py', '_test_result.py', 'certification-cells.json', 'probe_lifecycle.py', 'lifecycle.py'],
    asgi: ['_certification_native.py', '_test_result.py', 'certification-cells.json'],
    mcp: ['_client.py', '_server.py', 'example.py', '_certification_native.py', '_certification_provider.py', '_test_result.py', 'certification-cells.json'],
    crewai: ['provider.py', 'demo.py', '_certification_native.py', '_test_result.py', 'certification-cells.json'],
    'pydantic-ai': ['example.py', '_fixture.py', '_certification_native.py', '_certification_fixture.py', '_test_result.py', 'certification-cells.json'],
    autogen: ['_certification_native.py', '_test_result.py', 'certification-cells.json'],
    'llama-index': ['example.py', '_fixture.py', 'source_reader.py', '_attestation.py', '_certification_native.py', '_certification_fixture.py', '_test_result.py', 'certification-cells.json'],
  },
};
export function nativeFixtures(definition) {
  if (!definition.example) return [];
  const extra = companions[definition.language][definition.name];
  if (!extra) throw new Error(`Missing native fixture inventory for ${definition.id}`);
  const files = [...definition.tests, ...extra].map(name => ({ source: `${definition.example}/${name}`, destination: name }));
  files.push({ source: 'packages/middleware/conformance/runtime-fixture.mjs', destination: 'runtime-fixture.mjs' });
  if (definition.language === 'python') {
    files.push({ source: definition.locks[0], destination: 'requirements.lock' },
      { source: 'packages/middleware/conformance/packaging/run-python.mjs', destination: 'run-python.mjs' });
    for (const name of ['evidence_runtime.py', 'python_fixture.py'])
      files.push({ source: `packages/middleware/conformance/${name}`, destination: name });
    if (definition.name === 'langchain') files.push({ source: 'examples/middleware/python-provider-sdks/test_providers.py', destination: 'test_providers.py' });
    if (definition.name === 'asgi') files.push({ source: 'examples/middleware/python-provider-sdks/_http_fixture.py', destination: '_http_fixture.py' });
    if (definition.name === 'mcp') files.push({ source: 'examples/middleware/pydantic-ai/_fixture.py', destination: 'mcp_provider_fixture.py' });
    if (['openai', 'anthropic'].includes(definition.name)) files.push({ source: 'packages/middleware/conformance/support/required-cells.json', destination: 'required-cells.json' });
  }
  return files;
}
