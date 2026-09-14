# Framework middleware sources and current seams

Reviewed 2026-09-09. Upstream documentation describes extension points, not
Caveman implementation or certification. Exact package versions and source
locks must be captured by implementation unit W0 before adapter code is written.

## Caveman sources inspected

Source snapshot: `ed615c72d9710c1e694ece3d7973fb47de4f1023`, with pre-existing
local work. This specification adds documents only and does not reconcile or
publish that work.

| Source | Observed behavior and implication |
|---|---|
| [Root instructions](../../../CLAUDE.md) | Engine/proxy and application SDK sources live here; Agent SDK and Browse have separate owners. |
| [Engine API](../../../engine/engine.go) | Existing compressor selection, token counting, unchanged-input fallback, and CCR requirement are reusable authority. |
| [Engine overview](../../../engine/README.md) | Local compression, registry, runtime license, and bounded persistent CCR behavior are documented. |
| [Gateway interfaces and route table](../../../proxy/internal/gateway/server.go) | Compression, recovery, prefix stabilization, and authentication seams exist. Local middleware optimize/retrieve HTTP routes are absent. |
| [Gateway compression path](../../../proxy/internal/gateway/proxy.go) | Extracts eligible blocks, reuses stable replacements, stores originals, and applies markers before forwarding. |
| [Persistent replacement store](../../../proxy/internal/store/prefix_cache.go) | Existing durable original-to-replacement storage; scope extension and middleware authorization remain new work. |
| [Prefix tests](../../../proxy/internal/gateway/prefix_stability_test.go) | Ten-turn, restart, concurrency, missing-cache, and eviction behavior have regression coverage. |
| [Protocol reliability contract](../../../docs/technical/proxy-reliability.md) | Response forwarding and no-ambiguous-replay invariants must survive new middleware routes. |
| [TypeScript SDK](../../../packages/sdk/typescript/src/index.ts) | Gateway-backed single-payload compression, trace/exporter, assembly and related APIs; no native framework middleware export. |
| [TypeScript SDK manifest](../../../packages/sdk/typescript/package.json) | `@caveman-ai/sdk`, MIT, no runtime dependencies, Node >=22.13. |
| [Python SDK manifest](../../../packages/sdk/python/pyproject.toml) | `caveman-sdk`, `caveman_cloud` import, MIT, stdlib-only, Python >=3.13. |
| [Context IR](../../../packages/shared/contracts/schemas/context-ir.schema.json) | Existing kind, cache-region, privacy, safety, and recovery vocabulary. Its required token count must not encode unknown as invented zero. |
| [Transform capabilities](../../../packages/shared/contracts/schemas/transform-capability.schema.json) | Existing transform identity, safety, determinism, recovery, and conformance contract. |
| [MCP package](../../../mcp/package.json) | Existing compression/recovery launcher; reuse its Engine-backed server rather than create another MCP protocol runtime. |
| [Accounting](../../../docs/technical/stats-accounting.md) | Request estimates, actual usage, API equivalents, and saved dollars are distinct. |
| [Existing comparison](../../../docs/WRAP-BENCHMARK.md) | Pinned tool-output benchmark; no public raw harness in this checkout and no authority for current framework savings claims. |

Some older descriptive SDK docs still discuss historical agent package copies.
Repository routing instructions take precedence. This plan depends on the public
application SDK/Engine contracts, not those historical runtime copies.

## Headroom comparison snapshot

Inspected public source at
[`e67b3c8a29443a60d6b0018fb22f525c5cd7e709`](https://github.com/headroomlabs-ai/headroom/tree/e67b3c8a29443a60d6b0018fb22f525c5cd7e709),
version 0.37.0. Its integration tree includes LangChain/LangGraph, Agno, Strands,
CrewAI, AutoGen, LiteLLM callbacks, ASGI, and MCP. The TypeScript SDK adds Vercel,
OpenAI, Anthropic, and Gemini integrations. This establishes the comparison
inventory, not successful coverage of every upstream method.

| Inspected area | Design implication |
|---|---|
| [Python integrations](https://github.com/headroomlabs-ai/headroom/tree/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/integrations) | Include native model, tool, retriever, and gateway seams; a callback list alone is insufficient. |
| [TypeScript adapters](https://github.com/headroomlabs-ai/headroom/tree/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/sdk/typescript/src/adapters) | Independently consumable framework subpaths are useful. Preserve native formats rather than copy common-format round trips. |
| [Compression proof harness](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/benchmarks/index_proof_table.py) | Publish rerunnable artifacts; an offline compression table is still different from task-quality/provider-cost proof. |

No Headroom code is copied by this specification. Pydantic AI, LlamaIndex, and
Mastra are explicit scope additions, not claims about that inspected inventory.

## Primary upstream extension references

These links were consulted for API direction. They are not substitutes for the
installed-version probes and source locks required in W0.

| Family | Primary source | Constraint captured in the specification |
|---|---|---|
| OpenAI SDK | [TypeScript](https://github.com/openai/openai-node), [Python](https://github.com/openai/openai-python) | Keep native client transport, streaming, response helpers, and retry ownership. |
| Anthropic SDK | [Python SDK](https://github.com/anthropics/anthropic-sdk-python) | Preserve Messages/native streaming and content blocks; pin both language SDKs before implementation. |
| Google GenAI SDK | [JavaScript SDK](https://github.com/googleapis/js-genai) | Keep native contents/parts and Google/Vertex client configuration. Python's exact extension point is a W0 probe. |
| Vercel AI SDK | [Language model middleware](https://ai-sdk.dev/docs/ai-sdk-core/middleware) | Use public model middleware; verify the installed specification revision and call-option types. |
| LangChain | [Python middleware](https://docs.langchain.com/oss/python/langchain/middleware/custom), [TypeScript middleware](https://docs.langchain.com/oss/javascript/langchain/middleware/custom), [middleware reference](https://reference.langchain.com/python/langchain/middleware) | Model-call and tool-call hooks are distinct; add native model/retriever coverage beyond the agent hook. Each language requires its own installed-version probe. |
| LangGraph | [LangChain context engineering](https://docs.langchain.com/oss/python/langchain/context-engineering) | Reuse model/tool boundaries and retain graph checkpoint ownership; no second graph engine. |
| LiteLLM | [Custom callbacks](https://docs.litellm.ai/docs/observability/custom_callback) | Documentation distinguishes proxy-only request mutation from SDK logging, and lists per-deployment async hooks. Test sync and async separately. |
| Agno | [Model base source](https://github.com/agno-agi/agno/blob/main/libs/agno/agno/models/base.py), [running agents](https://docs.agno.com/agents/running-agents), [AgentOS middleware](https://docs.agno.com/agent-os/usage/middleware/custom-middleware) | HTTP middleware around AgentOS is different from model-request compression. Pin and exercise the public model-delegate signature in W0. |
| Strands | [Hooks](https://strandsagents.com/docs/user-guide/concepts/agents/hooks/), [Python hook events](https://strandsagents.com/docs/api/python/strands.hooks.events/), [plugins](https://strandsagents.com/docs/user-guide/concepts/plugins/) | Bind real model/tool events. The Python reference excludes structured-output invocations from BeforeModelCallEvent; verify coverage through another public seam. |
| CrewAI | [LLM hooks, versioned page](https://docs.crewai.com/v1.15.20/en/learn/llm-hooks) | Current docs expose PRE_MODEL_CALL/POST_MODEL_CALL; legacy decorators are compatibility paths. Test scope and per-continuation execution. |
| AutoGen | [ChatCompletionClient](https://microsoft.github.io/autogen/stable/reference/python/autogen_core.models.html) | Preserve create/create_stream, cancellation, native CreateResult and client lifecycle. |
| ASGI | [HTTP/WebSocket message specification](https://asgi.readthedocs.io/en/latest/specs/www.html) | Preserve request chunk/disconnect behavior, headers, and response messages; do not assume one receive call contains the whole body. |
| MCP | [2025-11-25 schema](https://modelcontextprotocol.io/specification/2025-11-25/schema) | Keep content blocks, structuredContent, outputSchema, isError, and metadata intact. Negotiate and record the actual host protocol revision. |
| Pydantic AI | [Process History](https://pydantic.dev/docs/ai/capabilities/process-history/), [message history](https://pydantic.dev/docs/ai/core-concepts/message-history/) | Current docs use the ProcessHistory capability. Do not hard-code an older history_processors constructor API from memory. |
| LlamaIndex | [Node postprocessors](https://developers.llamaindex.ai/python/framework/module_guides/querying/node_postprocessors/) | A native RAG seam exists; preserving source identity and exact expansion is an additional Caveman requirement. |
| Mastra | [Processors](https://mastra.ai/docs/agents/processors) | processInput runs once; processInputStep runs each step; processLLMRequest changes outbound prompt without persisting it into stored MessageList/history. |

ASGI wire replay and MCP native result handling require those protocol versions
and exact host SDKs in W0's source lock. Their Headroom adapters establish
comparison inventory only; they are not protocol authorities.

## Evidence limits

This work writes a proposal. It does not install or test the 16 frameworks,
create a runtime API, certify package names, validate real cloud credentials,
or run a new cost comparison. The source checks identify reusable components,
real extension points, and the specific implementation probes still required.
