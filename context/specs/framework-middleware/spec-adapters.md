# Spec: Framework adapters

## Scope

This specification defines the required integration families, their native
extension points, and the tests that distinguish working middleware from an
importable wrapper. All runtime requirements apply to every family. Extension
points below are grounded in [sources.md](sources.md); exact dependency versions
must be pinned and exercised before an adapter is advertised.

## Requirements

### R1: Required framework coverage

Each row is a required deliverable. Python means both sync and async where the
framework exposes both. TypeScript means its native async and streaming paths.
An upstream-absent method is explicitly `not_applicable` with a source reference;
an unimplemented upstream method is `missing`, never `not_applicable`.

| ID | Family and required languages | Native integration contract | Family-specific acceptance, in addition to runtime R1-R12 |
|---|---|---|---|
| F01 | OpenAI SDK: Python, TypeScript | Instance-scoped transport/client integration for Chat Completions and Responses; preserve the official SDK object and public helpers | [ ] Blocking/async create, streaming, raw-response helpers, structured output, function calls, and cancellation match baseline. Responses `input` items and `previous_response_id` remain native; server-held history is never treated as locally inspectable. Unrelated SDK endpoints remain untouched. |
| F02 | Anthropic SDK: Python, TypeScript | Instance-scoped Messages integration, including native stream helpers | [ ] `messages.create` and native streaming helper paths preserve tool-use/result pairs, cache markers, thinking/signatures, beta options, usage, and native errors. Token-count endpoints remain unchanged. Recovery works inside an application-owned tool loop. |
| F03 | Google GenAI SDK: Python, TypeScript | Native generate-content and stream-generation integration | [ ] `contents`/`parts`, function calls/responses, safety settings, system instructions, cached-content references, media, and usage remain native. Provider-client auth/Vertex configuration remains untouched. Unknown cached content stays opaque. |
| F04 | Vercel AI SDK: TypeScript | `wrapLanguageModel` middleware plus a recovery-tool bundle | [ ] `generateText`, `streamText`, structured output, and the pinned SDK's public tool-loop API execute with native response types. Tool results from later steps are optimized too. Provider options and middleware ordering survive. Nested F01/F02 ownership is exactly once. |
| F05 | LangChain: Python, TypeScript | Native agent middleware; public chat-model integration for non-agent callers; document-compressor/retriever integration | [ ] Invoke, async invoke, batch, stream, tool binding, structured output, callbacks, and per-request configuration survive. Each batch item has separate scope. A document view retains IDs, metadata, order, and source expansion. No LangSmith callback is mistaken for a pre-model mutation hook. |
| F06 | LangGraph: Python, TypeScript | Reuse F05/model middleware at model nodes; checkpoint-aware scope binding and recovery in the existing tool node | [ ] Two interleaved thread IDs, checkpoint resume after runtime restart, graph branching, interrupts, reducers, and parallel tool calls preserve state. Stored graph history stays original. A second invocation resumes the same replacement lineage without a second graph scheduler. |
| F07 | LiteLLM: Python SDK and Proxy | Request/deployment mutation hooks for supported async paths; explicit instance-scoped call wrapper where a sync SDK path lacks a mutation hook | [ ] `completion`, `acompletion`, Responses equivalents, streams, routing, retries, and fallbacks keep LiteLLM as the only inference hop. Proxy virtual-key/team identity is preserved. A forced fallback checks the new model's capabilities and reports both attempts. SDK logging-only callbacks do not qualify as compression. |
| F08 | Agno: Python | Native model delegate and tool registration; request-specific hooks only where they cover every model call | [ ] Run/arun and both streaming variants preserve native ModelResponse/RunOutput events, structured responses, tools, reasoning options, and agent/team session identity. Every internal model continuation is covered. An AgentOS HTTP middleware example alone does not satisfy this row. |
| F09 | Strands: Python, TypeScript | Native model/hook/plugin integration bundling scoped recovery tools | [ ] Every model invocation, streamed continuation, concurrent tool batch, cancellation, early generator close, and resumed session passes. Structured-output invocations are separately tested: documented hook gaps require a lower model wrapper, not a claim that the hook covered them. |
| F10 | CrewAI: Python | Scoped model-call hooks and model-facing tool-result integration | [ ] Crew and task identity, delegated work, tool arguments/results, human input, cache behavior, and structured final output survive. Registering/unregistering Caveman cannot affect another crew in the same process. When CrewAI uses LiteLLM, F07 owns optimization or yields explicitly. |
| F11 | AutoGen: Python | Public ChatCompletionClient delegate, plus workbench/tool integration for recovery | [ ] `create`, `create_stream`, tool schemas, final CreateResult, usage, cancellation, close, serialization/configuration, and multi-agent contexts match baseline. Recovery completes inside the actual workbench loop; changing a final tool-summary formatter is insufficient. |
| F12 | ASGI / FastAPI / Starlette: Python | Pure ASGI middleware for explicitly configured LLM HTTP routes | [ ] Exact allowlisted POST paths and protocol schemas are transformed; ordinary application routes, lifespan, WebSockets, encoded bodies, and unrelated JSON pass through. Split request chunks, early disconnect, oversized-body replay, response headers, and SSE flush are preserved. Auth runs before scope selection or compression. |
| F13 | MCP: Python and TypeScript host adapters, reusing Caveman's existing compression/recovery server | Native tool-result text integration and host registration of scoped recovery | [ ] Stdio and Streamable HTTP hosts retain tool IDs, names, errors, content block ordering, resources, annotations, and media. `structuredContent`/outputSchema contracts are unchanged; ambiguous mixed text/structured results are protected. No second Browse driver or MCP protocol implementation is introduced. |
| F14 | Pydantic AI: Python | Public history-processing capability and/or model wrapper, with native tool registration | [ ] Sync, async, streaming, typed results, RetryPromptPart/tool-return parts, dependencies, run usage, and existing capabilities survive. The pinned public extension covers every model continuation; original typed history remains reconstructible. |
| F15 | LlamaIndex: Python | Native node postprocessor for RAG text plus a public LLM delegate for conversation/tool flows | [ ] Sync/async query and streaming synthesis retain NodeWithScore identity, score, source nodes, metadata, and citation correctness. Repeated queries do not mutate cached/indexed nodes. Lossy RAG needs explicit source expansion; an ordinary answer synthesizer without recovery uses recovery-free transforms. |
| F16 | Mastra: TypeScript | Native outbound-request processor and recovery tool; reuse F04 where its model path applies | [ ] `processLLMRequest` or the pinned equivalent covers each outbound call while preserving MessageList, memory, UI history, workflow suspend/resume, tool execution, and structured output. `processInput` alone cannot claim continuation coverage. Nested AI SDK middleware is counted once. |

Dependencies: runtime R1-R12; proof R2, R3.

### R2: Capability manifests are exact

Each adapter publishes a machine-readable support manifest rather than a broad
claim that it works with any framework model.

Acceptance criteria:
- [ ] Each manifest identifies integration ID, package/version, exact tested
  framework/provider-SDK versions, runtime protocol revisions, and evidence paths.
- [ ] Support is recorded by operation, provider/protocol, execution mode,
  streaming, structured output, recovery, persistence, and serialization visibility.
- [ ] Each required operation has one state: `missing`, `implemented`,
  `conformant`, `provider_tested`, or `not_applicable`. Unsupported versions have
  a separate explicit `unsupported_version` outcome.
- [ ] `conformant` requires the installed-framework journey in proof R2.
  `provider_tested` additionally names the real provider/model/version/date.
- [ ] No adapter inherits certification from another merely because it calls
  that adapter internally. Composition itself is tested.
- [ ] Unknown provider/model names are preserved. They never fall back to a
  hard-coded model for capability, context-limit, tokenizer, or pricing claims.

Dependencies: overview R3; proof R1, R2, R6.

### R3: Native ergonomics and types

An adapter feels like the host framework's own extension. It introduces a shared
runtime connection and request scope, not a second application programming model.

Acceptance criteria:
- [ ] TypeScript examples compile against real framework types without `any`
  casts at the documented integration boundary. Python examples use real native
  classes and validate returned types.
- [ ] SDK helpers such as stream accumulators, response context managers,
  callback managers, `.bind_tools`, and `.with_structured_output` retain their
  behavior on every method advertised by the adapter.
- [ ] Public extension points are used. Private client field mutation, global
  monkey-patching, duck-typed fake base classes, and swallowed ImportErrors cannot
  serve as the implementation of a supported adapter.
- [ ] Missing optional dependencies produce a local install instruction when
  that adapter is imported, without breaking the core SDK or other adapters.
- [ ] Instance-owned registration is preferred. If a framework only has global
  hooks, an explicit scoped registration/unregistration contract is required,
  with concurrent unrelated-agent tests and exception-safe cleanup.
- [ ] Documentation provides both an existing-client integration and a complete
  tool-loop example where the framework supports them.

Dependencies: overview R1; runtime R1, R7; proof R5.

### R4: Recovery registration is part of the adapter

Each agent integration supplies a host-native recovery tool. A model-only
integration makes the limited recovery-free default explicit.

Acceptance criteria:
- [ ] The recovery bundle registers the real implementation, schema, request
  scope resolver, and runtime identity through public host APIs.
- [ ] The request adapter verifies that the current call contains the registered
  tool before enabling lossiness; a look-alike tool/schema fails the check.
- [ ] Shared gateway middleware accepts recovery only through an operator-bound
  capability supplied by the actual client integration. Arbitrary request
  headers asserting `recovery=true` do not enable it.
- [ ] Installing a model wrapper alone remains usable for inference and clearly
  reports `recovery_unavailable` when a lossy candidate is skipped.
- [ ] Invocation-local credentials/scope stay outside the model-visible tool
  schema, tool arguments, and stored conversation history.

Dependencies: runtime R5, R9; proof R2.

### R5: Gateways and framework composition preserve authority

Application routing, guardrails, approvals, billing, and retry ownership remain
unchanged. The optimizer receives the request after applicable authorization.

Acceptance criteria:
- [ ] Auth/tenant derivation and host security policies run on original content
  before optimization. If a mandatory downstream guardrail must inspect original
  content, middleware integration establishes that order or disables compression.
- [ ] LiteLLM retains virtual keys, provider selection, retries, budgets, logging,
  and response streaming. Caveman calls only its configured optimizer service.
- [ ] An application cannot bypass a guardrail by putting prohibited material in
  text that Caveman would elide. The composition fixture asserts the denial.
- [ ] A runtime outage does not bypass authentication or an existing guardrail.
  Fail-open behavior applies to optimization only.
- [ ] Model fallback, nested frameworks, and callback re-entry have isolated
  attempt state and no cross-request mutable configuration.

Dependencies: runtime R2, R8, R9.

### R6: Native provider coverage is qualified separately

Framework middleware can act before a provider client signs/serializes a request.
That is a different compatibility surface from routing through Caveman's proxy.

Acceptance criteria:
- [ ] F01/F02/F03 cover their owned public generation protocols; F04-F11 and
  F14-F16 exercise OpenAI and Anthropic model paths wherever the pinned framework
  supports them. Each supported alternative protocol is an additional matrix row.
- [ ] Strands exercises its native Bedrock path, and Google GenAI exercises its
  native Google path; cloud-auth live certification remains separately labeled.
- [ ] Bedrock/Vertex framework tests invoke the host's native client/auth/signing
  seam. Existing proxy pass-through behavior is unchanged and is not relabeled
  as proxy compression support.
- [ ] Client-side injection of tools never changes a forced tool choice or
  structured-output contract. If recovery cannot be offered under that contract,
  only recovery-free transformations are eligible.
- [ ] Hidden server-side histories and provider-native compaction remain opaque;
  middleware does not claim full-history optimization for Responses references
  or cached-content IDs it cannot inspect.

Dependencies: runtime R1, R4, R6; proof R2, R6.

## Out of scope

Adapters for unnamed frameworks, obsolete major versions, agent-runtime
migrations, provider feature emulation, custom orchestration, and additional
compressor algorithms. LlamaIndex TypeScript is not part of F15's initial
required language matrix; a future row needs its own native seam and evidence.

## Cross-references

- [Runtime requirements](spec-runtime.md) govern all mutation and lifecycle work.
- [Proof R2](spec-proof.md#r2-real-framework-conformance) supplies a common
  journey; F01-F16 add the checks needed for their native contracts.
- [Implementation plan](implementation-plan.md) assigns packages and waves.
