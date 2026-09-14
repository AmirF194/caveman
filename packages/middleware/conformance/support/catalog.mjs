/** Required scope, independent of implementation status and generated reports.
 * Do not remove a cell because its implementation or proof is missing.
 * A method combines a public entry point with a required observable contract.
 */
export const specificationFiles = [
  'spec-overview.md', 'spec-runtime.md', 'spec-adapters.md', 'spec-proof.md',
  'implementation-plan.md', 'sources.md',
].map(name => `context/specs/framework-middleware/${name}`);

export const requiredCounts = { requirements: 29, acceptance_items: 180, families: 16, family_languages: 23 };
export const operationCounts = { F01: 53, F02: 24, F03: 48, F04: 18, F05: 60, F06: 42, F07: 36, F08: 28, F09: 48, F10: 28, F11: 20, F12: 33, F13: 22, F14: 40, F15: 40, F16: 18 };
const py = 'packages/middleware/python/caveman_middleware/';
const ts = 'packages/middleware/typescript/src/';
const example = 'examples/middleware/';
const openai = ['openai', 'openai-chat-completions'];
const anthropic = ['anthropic', 'anthropic-messages'];
const providers = [openai, anthropic];

// Tuple: method, execution, streaming, structured_output, recovery.
const operation = (method, execution = 'async', streaming = false, structured_output = false, recovery = 'native_executor') =>
  ({ method, execution, streaming, structured_output, recovery });
const both = (method, streaming = false, structured_output = false, recovery = 'native_executor') =>
  ['sync', 'async'].map(execution => operation(method, execution, streaming, structured_output, recovery));
const asyncOnly = (methods, recovery = 'native_executor') => methods.map(method => operation(method, 'async', false, false, recovery));
const language = (framework, version, source, lock, tests, operations, extra = {}) =>
  ({ framework, version, source: [source].flat(), lock: [lock].flat(), tests: [tests].flat(), operations, ...extra });

export const families = [
  { id: 'F01', name: 'OpenAI SDK', providers: [openai, ['openai', 'openai-responses']], languages: {
    python: language('openai', '3.10.0', `${py}openai.py`, `${example}python-provider-sdks/requirements.lock`, `${example}python-provider-sdks/test_providers.py`, [
      ...both('create', false, false, 'model_only'), ...both('create.stream', true, false, 'model_only'),
      ...both('with_raw_response.create', false, false, 'model_only'), ...both('with_streaming_response.create', true, false, 'model_only'),
      ...both('parse', false, true, 'model_only'), ...both('application_tool_loop'),
      ...both('cancel', true, false, 'model_only'), ...both('server_history_reference', false, false, 'model_only'),
      ...both('unrelated_endpoint_passthrough', false, false, 'not_applicable'),
    ]),
    typescript: language('openai', '7.12.1', `${ts}openai.ts`, `${example}provider-sdks/package-lock.json`, `${example}provider-sdks/openai.test.mjs`, [
      operation('create', 'async', false, false, 'model_only'), operation('create.stream', 'async', true, false, 'model_only'),
      operation('asResponse', 'async', false, false, 'model_only'), operation('withResponse', 'async', false, false, 'model_only'),
      operation('parse', 'async', false, true, 'model_only'), operation('native_tool_loop'),
      operation('native_tool_loop.stream', 'async', true), operation('cancel', 'async', true, false, 'model_only'),
      operation('server_history_reference', 'async', false, false, 'model_only'),
      operation('unrelated_endpoint_passthrough', 'async', false, false, 'not_applicable'),
    ]),
  } },
  { id: 'F02', name: 'Anthropic SDK', providers: [anthropic], languages: {
    python: language('anthropic', '1.4.0', `${py}anthropic.py`, `${example}python-provider-sdks/requirements.lock`, `${example}python-provider-sdks/test_providers.py`, [
      ...both('messages.create', false, false, 'model_only'), ...both('messages.create.stream', true, false, 'model_only'),
      ...both('messages.stream', true, false, 'model_only'), ...both('messages.raw_response', false, false, 'model_only'),
      ...both('application_tool_loop'), ...both('application_tool_loop.stream', true),
      ...both('cancel', true, false, 'model_only'), ...both('count_tokens.passthrough', false, false, 'not_applicable'),
    ]),
    typescript: language('@anthropic-ai/sdk', '0.124.0', `${ts}anthropic.ts`, `${example}provider-sdks/package-lock.json`, `${example}provider-sdks/anthropic.test.mjs`, [
      operation('messages.create', 'async', false, false, 'model_only'), operation('messages.create.stream', 'async', true, false, 'model_only'),
      operation('messages.stream', 'async', true, false, 'model_only'), operation('messages.raw_response', 'async', false, false, 'model_only'),
      operation('beta.messages.toolRunner'), operation('beta.messages.toolRunner.stream', 'async', true),
      operation('cancel', 'async', true, false, 'model_only'), operation('countTokens.passthrough', 'async', false, false, 'not_applicable'),
    ]),
  } },
  { id: 'F03', name: 'Google GenAI SDK', providers: [['google', 'google-generate-content'], ['vertex', 'google-generate-content']], languages: {
    python: language('google-genai', '2.22.0', [`${py}google.py`, `${py}_google_wire.py`], `${example}python-provider-sdks/requirements.lock`, `${example}google/test_native.py`, [
      ...both('models.generate_content'), ...both('models.generate_content_stream', true),
      ...both('chats.send_message'), ...both('chats.send_message_stream', true),
      ...both('models.generate_content.structured', false, true, 'model_only'),
      ...both('cached_content.opaque', false, false, 'model_only'), ...both('client_auth_and_configuration'),
      ...both('cancel_and_close', true),
    ]),
    typescript: language('@google/genai', '2.21.0', `${ts}google.ts`, `${example}provider-sdks/package-lock.json`, `${example}provider-sdks/google.test.mjs`, [
      operation('models.generateContent'), operation('models.generateContentStream', 'async', true),
      operation('chats.sendMessage'), operation('chats.sendMessageStream', 'async', true),
      operation('models.generateContent.structured', 'async', false, true, 'model_only'),
      operation('cachedContent.opaque', 'async', false, false, 'model_only'), operation('client_auth_and_configuration'),
      operation('cancel_and_close', 'async', true),
    ]),
  } },
  { id: 'F04', name: 'Vercel AI SDK', providers, languages: {
    typescript: language('ai', '7.0.94', [`${ts}ai-sdk.ts`, `${ts}transport.ts`],
      [`${example}ai-sdk/package-lock.json`, `${example}mastra/package-lock.json`],
      [`${example}ai-sdk/conformance.test.mjs`, `${example}ai-sdk/composition.test.mjs`], [
      operation('generateText'), operation('streamText', 'async', true),
      operation('generateText.structured', 'async', false, true, 'model_only'), operation('streamText.structured', 'async', true, true, 'model_only'),
      operation('public_tool_loop'), operation('public_tool_loop.stream', 'async', true),
      operation('wrapLanguageModel.model_only', 'async', false, false, 'model_only'),
      operation('nested_provider_client_ownership'), operation('cancel_and_close', 'async', true),
    ]),
  } },
  { id: 'F05', name: 'LangChain', providers, languages: {
    python: language('langchain', '1.4.0', `${py}langchain.py`, `${example}langchain/requirements.lock`, `${example}langchain/test_native.py`, [
      ...both('agent.invoke'), ...both('agent.stream', true), ...both('chat_model.invoke', false, false, 'model_only'),
      operation('chat_model.batch', 'batch', false, false, 'model_only'), operation('chat_model.abatch', 'batch', false, false, 'model_only'),
      ...both('chat_model.stream', true, false, 'model_only'), ...both('chat_model.bind_tools', false, false, 'model_only'),
      ...both('chat_model.with_structured_output', false, true, 'model_only'), ...both('callbacks_and_request_config'),
      ...both('document_compressor', false, false, 'model_only'), ...both('retriever.source_expansion', false, false, 'operator_bound'),
    ]),
    typescript: language('langchain', '1.5.10', [`${ts}langchain.ts`, `${ts}langchain-model.ts`], `${example}langchain/package-lock.json`, `${example}langchain/conformance.test.mjs`, [
      operation('agent.invoke'), operation('agent.stream', 'async', true), operation('chat_model.invoke', 'async', false, false, 'model_only'),
      operation('chat_model.batch', 'batch', false, false, 'model_only'), operation('chat_model.stream', 'async', true, false, 'model_only'),
      operation('chat_model.bindTools', 'async', false, false, 'model_only'), operation('chat_model.withStructuredOutput', 'async', false, true, 'model_only'),
      operation('callbacks_and_request_config'), operation('document_compressor', 'async', false, false, 'model_only'),
      operation('retriever.source_expansion', 'async', false, false, 'operator_bound'),
    ]),
  } },
  { id: 'F06', name: 'LangGraph', providers, languages: {
    python: language('langgraph', '1.2.11', `${py}langchain.py`, `${example}langchain/requirements.lock`, `${example}langchain/test_native.py`, [
      ...both('graph.invoke'), ...both('graph.stream', true), ...both('checkpoint_resume_after_restart'),
      ...both('branch_and_history_edit'), ...both('interrupt_and_reducers'), ...both('parallel_tool_batch'), ...both('interleaved_thread_identity'),
    ]),
    typescript: language('@langchain/langgraph', '1.4.14', `${ts}langchain.ts`, `${example}langchain/package-lock.json`, `${example}langchain/conformance.test.mjs`, [
      operation('graph.invoke'), operation('graph.stream', 'async', true), ...asyncOnly([
        'checkpoint_resume_after_restart', 'branch_and_history_edit', 'interrupt_and_reducers', 'parallel_tool_batch', 'interleaved_thread_identity',
      ]),
    ]),
  } },
  { id: 'F07', name: 'LiteLLM SDK and Proxy', providers, languages: {
    python: language('litellm', '1.100.0', [`${py}litellm.py`, `${py}asgi.py`],
      [`${example}litellm/requirements.lock`, `${example}litellm/composition-requirements.lock`],
      [`${example}litellm/test_native.py`, `${example}litellm/composition_test.py`], [
      operation('sdk.completion', 'sync', false, false, 'model_only'), operation('sdk.acompletion', 'async', false, false, 'model_only'),
      operation('sdk.completion.stream', 'sync', true, false, 'model_only'), operation('sdk.acompletion.stream', 'async', true, false, 'model_only'),
      operation('sdk.responses', 'sync', false, false, 'model_only'), operation('sdk.aresponses', 'async', false, false, 'model_only'),
      operation('sdk.responses.stream', 'sync', true, false, 'model_only'), operation('sdk.aresponses.stream', 'async', true, false, 'model_only'),
      ...both('sdk.structured_output', false, true, 'model_only'), ...both('router.retry_and_fallback', false, false, 'operator_bound'),
      operation('proxy.completion', 'async', false, false, 'operator_bound'), operation('proxy.completion.stream', 'async', true, false, 'operator_bound'),
      operation('proxy.responses', 'async', false, false, 'operator_bound'), operation('proxy.responses.stream', 'async', true, false, 'operator_bound'),
      operation('proxy.auth_guardrail_order', 'async', false, false, 'operator_bound'),
      operation('asgi_composition', 'async', false, false, 'operator_bound'),
    ]),
  } },
  { id: 'F08', name: 'Agno', providers, languages: {
    python: language('agno', '3.0.9', `${py}agno.py`, `${example}agno/requirements.lock`, `${example}agno/test_native.py`, [
      ...both('agent.run'), ...both('agent.run.stream', true), ...both('agent.run.structured', false, true, 'model_only'),
      ...both('team.run'), ...both('internal_model_continuation'), ...both('cancel_and_close', true),
      ...both('model_only', false, false, 'model_only'),
    ]),
  } },
  { id: 'F09', name: 'Strands', providers: [...providers, ['bedrock', 'bedrock-converse']], languages: {
    python: language('strands-agents', '1.55.0', `${py}strands.py`, `${example}strands/requirements.lock`, `${example}strands/test_native.py`, [
      operation('agent.__call__', 'sync'), operation('agent.invoke_async'), operation('agent.stream_async', 'async', true),
      operation('model.stream', 'async', true), operation('model.structured_output', 'async', true, true, 'model_only'),
      ...asyncOnly(['parallel_tool_batch', 'resumed_session', 'every_model_continuation']), operation('cancel_and_close', 'async', true),
    ]),
    typescript: language('@strands-agents/sdk', '1.17.0', `${ts}strands.ts`, `${example}strands/package-lock.json`, `${example}strands/conformance.test.mjs`, [
      operation('agent.invoke'), operation('agent.stream', 'async', true), operation('model.structured_output', 'async', true, true, 'model_only'),
      ...asyncOnly(['parallel_tool_batch', 'resumed_session', 'every_model_continuation']), operation('cancel_and_close', 'async', true),
    ]),
  } },
  { id: 'F10', name: 'CrewAI', providers, languages: {
    python: language('crewai', '1.15.20', `${py}crewai.py`, `${example}crewai/requirements.lock`, `${example}crewai/test_native.py`, [
      ...both('crew.kickoff'), ...both('crew.kickoff.stream', true), ...both('crew.kickoff.structured', false, true, 'model_only'),
      ...both('task_delegation_and_human_input'), ...both('tool_arguments_results_and_cache'),
      ...both('scoped_registration_cleanup'), ...both('litellm_composition'),
    ]),
  } },
  { id: 'F11', name: 'AutoGen', providers, languages: {
    python: language('autogen-agentchat', '0.7.5', `${py}autogen.py`, `${example}autogen/requirements.lock`, `${example}autogen/test_native.py`, [
      operation('ChatCompletionClient.create', 'async', false, false, 'model_only'), operation('ChatCompletionClient.create_stream', 'async', true, false, 'model_only'),
      operation('ChatCompletionClient.structured_output', 'async', false, true, 'model_only'),
      operation('AssistantAgent.run'), operation('AssistantAgent.run_stream', 'async', true),
      ...asyncOnly(['workbench_recovery', 'parallel_tools_and_multiple_workbenches', 'multiagent_contexts', 'serialization_and_configuration']),
      operation('cancel_and_close', 'async', true),
    ]),
  } },
  { id: 'F12', name: 'ASGI / FastAPI / Starlette', providers: [openai, ['openai', 'openai-responses'], anthropic], languages: {
    python: language('fastapi', '0.141.1', `${py}asgi.py`, `${example}asgi/requirements.lock`, `${example}asgi/test_native.py`, [
      operation('fastapi.allowlisted_post', 'transport', false, false, 'operator_bound'), operation('fastapi.allowlisted_post.sse', 'transport', true, false, 'operator_bound'),
      operation('starlette.allowlisted_post', 'transport', false, false, 'operator_bound'), operation('starlette.allowlisted_post.sse', 'transport', true, false, 'operator_bound'),
      operation('structured_output', 'transport', false, true, 'model_only'),
      ...['split_request_chunks', 'early_disconnect', 'oversized_body_replay', 'auth_guardrail_order', 'encoded_body_passthrough', 'unrelated_route_lifespan_websocket_passthrough']
        .map(method => operation(method, 'transport', false, false, 'operator_bound')),
    ]),
  } },
  { id: 'F13', name: 'MCP', providers: [['host', 'mcp-2025-11-25']], languages: {
    python: language('mcp', '2.2.0', `${py}mcp.py`, `${example}mcp/requirements.lock`, `${example}mcp/test_native.py`, [
      ...asyncOnly(['stdio.call_tool', 'streamable_http.call_tool', 'host_recovery_registration', 'native_result_identity_and_blocks']),
      operation('stdio.host_stream', 'async', true), operation('streamable_http.host_stream', 'async', true),
      ...asyncOnly(['cancel_and_options', 'twenty_turn_restart', 'existing_server_interoperation']),
      operation('structuredContent_and_outputSchema', 'async', false, true, 'model_only'),
      operation('mixed_structured_text_protection', 'async', false, true, 'model_only'),
    ], { serialization_visibility: 'host_result', protocol: 'mcp-2026-07-28' }),
    typescript: language('@modelcontextprotocol/sdk', '1.30.0', `${ts}mcp.ts`, `${example}mcp/package-lock.json`, `${example}mcp/conformance.test.mjs`, [
      ...asyncOnly(['stdio.call_tool', 'streamable_http.call_tool', 'host_recovery_registration', 'native_result_identity_and_blocks']),
      operation('stdio.host_stream', 'async', true), operation('streamable_http.host_stream', 'async', true),
      ...asyncOnly(['cancel_and_options', 'twenty_turn_restart', 'existing_server_interoperation']),
      operation('structuredContent_and_outputSchema', 'async', false, true, 'model_only'),
      operation('mixed_structured_text_protection', 'async', false, true, 'model_only'),
    ], { serialization_visibility: 'host_result', protocol: 'mcp-2025-11-25' }),
  } },
  { id: 'F14', name: 'Pydantic AI', providers, languages: {
    python: language('pydantic-ai', '2.42.0', `${py}pydantic_ai.py`, `${example}pydantic-ai/requirements.lock`, `${example}pydantic-ai/test_native.py`, [
      ...both('Agent.run'), ...both('Agent.run_stream', true), ...both('Agent.run.typed', false, true, 'model_only'),
      ...both('Agent.run_stream.typed', true, true, 'model_only'), ...both('RetryPromptPart_and_ToolReturnPart'),
      ...both('dependencies_usage_and_capabilities'), ...both('history_resume'), ...both('every_model_continuation'),
      ...both('cancel_and_close', true), ...both('model_only', false, false, 'model_only'),
    ]),
  } },
  { id: 'F15', name: 'LlamaIndex', providers, languages: {
    python: language('llama-index-core', '0.14.24', `${py}llama_index.py`, `${example}llama-index/requirements.lock`, `${example}llama-index/test_native.py`, [
      ...both('query', false, false, 'operator_bound'), ...both('query.stream', true, false, 'operator_bound'),
      ...both('node_postprocessor', false, false, 'operator_bound'), ...both('node_postprocessor.no_expansion', false, false, 'model_only'),
      ...both('source_identity_scores_metadata_and_citations', false, false, 'operator_bound'),
      ...both('LLM.chat'), ...both('LLM.stream_chat', true), ...both('LLM.complete', false, false, 'model_only'),
      ...both('LLM.stream_complete', true, false, 'model_only'), ...both('LLM.structured_output', false, true, 'model_only'),
    ]),
  } },
  { id: 'F16', name: 'Mastra', providers, languages: {
    typescript: language('@mastra/core', '1.65.0', `${ts}mastra.ts`, `${example}mastra/package-lock.json`, `${example}mastra/conformance.test.mjs`, [
      operation('agent.generate'), operation('agent.stream', 'async', true), operation('agent.structured_output', 'async', false, true, 'model_only'),
      ...asyncOnly(['processLLMRequest.every_step', 'MessageList_memory_and_UI_history', 'workflow_suspend_resume', 'native_tool_execution', 'nested_AI_SDK_ownership']),
      operation('cancel_and_close', 'async', true),
    ]),
  } },
];

export function cellKey(cell) {
  return [cell.family, cell.language, cell.provider, cell.protocol, cell.method, cell.execution,
    cell.streaming ? 'stream' : 'complete', cell.structured_output ? 'structured' : 'unstructured', cell.recovery].join('|');
}

export function requiredCells() {
  return families.flatMap(family => Object.entries(family.languages).flatMap(([languageName, config]) =>
    family.providers.flatMap(([provider, baseProtocol]) => config.operations.filter(op =>
      !(family.id === 'F01' && op.method === 'server_history_reference' && baseProtocol !== 'openai-responses')).map(op => {
      let protocol = config.protocol ?? baseProtocol;
      if (family.id === 'F07' && op.method.includes('responses')) protocol = 'openai-responses';
      if (family.id === 'F13' && op.method === 'existing_server_interoperation') protocol = 'mcp-2024-11-05';
      const cell = { family: family.id, language: languageName, provider, protocol, ...op };
      return { id: cellKey(cell), ...cell, requirement: `adapters.R1.${family.id}`, required: true };
    }))));
}

export const sharedTestPaths = [
  'proxy/internal/middleware/runtime_test.go', 'proxy/internal/middleware/benchmark_test.go',
  'proxy/internal/store/middleware_test.go', 'packages/sdk/typescript/tests/middleware.runtime.mjs',
  'packages/sdk/python/tests/test_middleware.py', 'packages/middleware/typescript/tests/wire.test.mjs',
  'packages/middleware/conformance/client-parity.test.mjs',
  'packages/middleware/conformance/composition-python.test.mjs',
  'packages/middleware/conformance/support/verify-support.test.mjs',
];

// Inspected omissions. Resolving one requires implementing and reviewing its native
// contract; removing this note does not remove the required cell or proof gate.
export const knownImplementationGaps = {};

export const providerSdkNames = {
  openai: ['openai', '@ai-sdk/openai', '@langchain/openai', 'langchain-openai', 'llama-index-llms-openai'],
  anthropic: ['anthropic', '@anthropic-ai/sdk', '@ai-sdk/anthropic', '@langchain/anthropic', 'langchain-anthropic', 'llama-index-llms-anthropic'],
  google: ['google-genai', '@google/genai'], vertex: ['google-genai', '@google/genai', 'google-auth'],
  bedrock: ['boto3', 'botocore', '@aws-sdk/client-bedrock-runtime'], host: ['mcp', '@modelcontextprotocol/sdk'],
};

export const mandatoryJourney = [
  'native_application', 'real_tool_result', 'transformed_provider_request', 'omitted_fact_requested',
  'host_executes_exact_recovery', 'native_result_history_events_and_call_count', 'off_baseline', 'optimizer_unavailable',
];

// These are source locators, not claims that every criterion in a requirement passes.
export const requirementTestHints = {
  'overview.R1': ['native', 'helpers', 'documented'],
  'overview.R2': ['shared exact durable', 'endpoint_controls', 'off and endpoint', 'recovery'],
  'overview.R3': ['ConservativeModes', 'runtime delegates', 'off and pre-dispatch', 'fake_registration'],
  'overview.R4': ['shared middleware wire', 'test_shared_vectors', 'TypeScript and real Python'],
  'runtime.R1': ['wire patches', 'native recovery, errors', 'unmatched native', 'preserve_native_values', 'native_helpers', 'original_objects'],
  'runtime.R2': ['Idempotency', 'unique', 'nested_ownership', 'owns native retries', 'one native Mastra processor'],
  'runtime.R3': ['TypeScript and real Python', 'shared middleware wire', 'test_shared_vectors', 'test_delegation'],
  'runtime.R4': ['ConservativeModes', 'native recovery, errors', 'unmatched native', 'model_only', 'shared middleware wire'],
  'runtime.R5': ['ExactRecovery', 'ExpiryDeletion', 'fake_recovery', 'fake_registration', 'native_workbench_recovery', 'recovers exact', 'recovery pages'],
  'runtime.R6': ['TwentyTurns', 'ConcurrentWriters', 'graph_interleaved', 'checkpoint state', 'workflow suspend/resume', 'twenty_turn_prefix'],
  'runtime.R7': ['stream', 'cancel', 'close', 'cancellation'],
  'runtime.R8': ['invalid-plan', 'malformed response', 'outage', 'provider failure', 'circuit breaker', 'Idempotency'],
  'runtime.R9': ['ScopeAndBrowserAuthorization', 'scope', 'endpoint_controls', 'guards_run_before'],
  'runtime.R10': ['ProtocolLimits', 'queued_work_counts', 'io_does_not_block', 'deadline cancels', '64mib', 'oversized'],
  'runtime.R11': ['ProtocolLimitsAndReceipts', 'one native Mastra', 'owns native retries', 'usage_incomplete', 'final_result_missing_usage'],
  'runtime.R12': ['IdenticalDocuments', 'document views', 'rag_preserve', 'source_identity', 'citations'],
  'adapters.R2': ['support inventory'],
  'adapters.R3': ['helpers', 'native_token_helpers', 'documented', 'component', 'scoped_registration'],
  'adapters.R4': ['fake', 'collision', 'model_only', 'workbench_recovery', 'recovery_registration'],
  'adapters.R5': ['guardrail', 'guards_run_before', 'auth_and_original', 'router_fallback', 'nested_ownership'],
  'adapters.R6': ['Vertex', 'signed Bedrock', 'forced', 'cached', 'anthropic'],
  'proof.R1': ['shared middleware wire', 'test_shared_vectors', 'TypeScript and real Python', 'support inventory'],
  'proof.R2': ['native'],
  'proof.R3': ['TwentyTurns', 'ConcurrentWriters', 'ExactRecovery', 'ScopeAndBrowser', 'collision', 'guardrail'],
  'proof.R4': ['BenchmarkMiddlewarePreparation', '64mib', 'deadline cancels', 'queued_work_counts'],
  'proof.R5': ['packaged consumer', 'documented'],
  'proof.R6': [],
  'proof.R7': ['support inventory'],
};
