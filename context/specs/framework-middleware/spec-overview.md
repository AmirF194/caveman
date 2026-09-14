# Framework middleware

Status: proposed specification; implementation has not started.
Owner: Caveman public Engine, proxy, and application SDK maintainers.
Reviewed: 2026-09-09.

## Product outcome

An application keeps its framework, provider client, model, tool loop, storage,
and deployment. Adding Caveman compresses eligible context before inference,
keeps omitted content recoverable, and reports what happened. Removing Caveman
restores the original application without a migration.

The product is a middleware layer, not another agent framework. The default
runtime is local and requires no Caveman account. When an application already
uses LiteLLM or another gateway, that gateway retains its inference connection.

## Read this specification

| Document | Authority |
|---|---|
| [Runtime requirements](spec-runtime.md) | Content fidelity, recovery, cache stability, failures, isolation, accounting |
| [Framework requirements](spec-adapters.md) | Required integration matrix and framework-specific acceptance |
| [Proof and release requirements](spec-proof.md) | Executable conformance, performance, benchmarks, packaging, completion |
| [Implementation plan](implementation-plan.md) | Proposed packages, protocol, public API, ownership, delivery order |
| [Research and existing code](sources.md) | Current implementation evidence and upstream extension points |

Requirements describe observable behavior. Package names, HTTP paths, and code
examples in the implementation plan are proposed implementation decisions,
not existing APIs. Acceptance checkboxes begin unchecked deliberately.

## Scope

“Full framework middleware” means the following 16 named integration families,
with the language and method coverage in [spec-adapters.md](spec-adapters.md).
The list is finite; a generic base-URL example does not complete an adapter.

| Delivery wave | Required families |
|---|---|
| 1: core application paths | OpenAI SDK, Anthropic SDK, Vercel AI SDK, LangChain, LangGraph, LiteLLM |
| 2: complete the Headroom integration comparison | Google GenAI SDK, Agno, Strands, CrewAI, AutoGen, ASGI/FastAPI/Starlette, MCP |
| 3: additional application coverage | Pydantic AI, LlamaIndex, Mastra |

Wave order is sequencing, not permission to call wave 1 the complete product.
Headroom parity is a capability comparison; its implementation is not the
authority for Caveman's safety or API contracts.

## Current baseline

The review used Caveman `ed615c72d9710c1e694ece3d7973fb47de4f1023` with
pre-existing local edits, and Headroom 0.37.0 at
`e67b3c8a29443a60d6b0018fb22f525c5cd7e709`. This is a source snapshot, not a
release certification. See [sources.md](sources.md) for exact seams.

| Already present | Missing for this product |
|---|---|
| Local Engine with structural compressors and exact CCR storage | Framework-native extraction and safe application of replacements |
| Proxy prefix stabilization and provider adapters | A supported compression-only runtime API for framework middleware |
| Matching TypeScript/Python gateway SDKs | Async middleware clients and independently installable integrations |
| Context IR and transform capability schemas | Shared middleware request, replacement, and receipt contracts |
| Existing MCP compression/recovery tools | Framework tool registration and recovery conformance |
| Proxy/provider regression tests | Installed-framework, packaged-consumer, and matched task benchmarks |

The current SDK `compress()` sends one payload to `/sdk/v1/compress`; that does
not establish a local conversation middleware API. The standalone gateway's
route table does not currently expose that SDK endpoint.

## Requirements

### R1: Existing applications remain the entry point

The documented integration changes configuration or wraps a public framework
extension point. It must not require adopting a Caveman agent runtime.

Acceptance criteria:
- [ ] Each family has a runnable before/after example using the same host model,
  tools, output contract, and caller-owned history.
- [ ] The minimal application integration adds at most ten nonblank setup lines,
  excluding imports and the optional explicit recovery-tool registration.
- [ ] Removing the integration passes the original application's tests without
  history conversion, provider-key rotation, or configuration repair.
- [ ] Import and construction perform no network request, model download,
  subprocess launch, workspace scan, or mutation of global provider settings.

Dependencies: runtime R1, R2; adapters R1, R3; proof R5.

### R2: Local operation is complete

Compression and recovery work against an explicitly configured local runtime.
Provider authentication remains owned by the application's existing client.

Acceptance criteria:
- [ ] With external networking disabled, every adapter's conformance journey
  reaches a local provider fixture and recovers exact omitted bytes.
- [ ] Local integration requires no login, subscription, control plane, or
  telemetry upload to Caveman.
- [ ] Compression never introduces a second inference request or inference proxy.
- [ ] A separately configured remote compression service requires explicit
  content-transfer opt-in; local failure never switches to it automatically.

Dependencies: runtime R3, R9; proof R2.

### R3: Adoption does not hide inactivity

Default middleware mode is `compress`. Only eligible, supported operations
transform. A bare model/client wrapper without executable recovery uses only
transform capabilities that do not require recovery. `record` observes shape
without changing model input; `off` bypasses optimization and content capture.

Acceptance criteria:
- [ ] Each call reports `applied`, `reused`, `skipped`, `recorded`, or `disabled`
  with a machine-readable reason and the actual transform IDs.
- [ ] Unsupported framework versions and missing recovery produce original
  input plus a bounded diagnostic, not a success badge or exception by default.
- [ ] Diagnostic mode can require a named capability and fail before inference
  when it is unavailable; ordinary mode remains available by passing through.
- [ ] Tests distinguish a supported no-op input from an adapter that never ran.

Dependencies: runtime R4, R8, R11; adapters R2.

### R4: Existing ownership and licensing boundaries remain intact

Engine/proxy and application middleware belong in this repository. Agent
execution adapters belong in `JuliusBrussee/agent-sdk`; Browse driver, MCP,
and benchmark/plugin work specific to Browse belongs in `caveman-browse`.
Proprietary product and managed-control-plane code remain in their owners.

Acceptance criteria:
- [ ] Public middleware builds from this repository without private repository
  imports, copied private source, or a dependency on `@caveman-ai/agent`.
- [ ] All integrations invoke the same Engine authority; no Python or TypeScript
  reimplementation of compression, ranking, or savings calculation appears.
- [ ] Existing Context IR and transform capability vocabularies are reused;
  schema extensions are additive and have shared-language fixtures.
- [ ] Package manifests preserve current SDK dependency and license boundaries.
  Shipping an Engine binary or WASM artifact does not relabel it as MIT.

Dependencies: implementation plan; proof R1, R5.

## Out of scope

- A new tool loop, workflow engine, memory database, model router, retry policy,
  vector database, dashboard, or framework replacement.
- A new ML compressor or automatic reasoning-effort/verbosity changes. Existing
  provider options are preserved; middleware coverage is the work here.
- Automatic tool pruning, RAG document selection, or dropping conversation turns.
  These require separate semantic policies and quality gates.
- Browser-side provider credentials, realtime audio/video, arbitrary WebSocket
  rewriting, embeddings, image generation, batch jobs, and fine-tuning APIs.
- A claim that every model or provider supported by a framework is certified.
- Publishing packages, changing production applications, or buying model traffic
  as part of writing this specification.

## Completion

The specification is ready for implementation when requirements, protocol
decisions, owned work units, and proof gates are internally consistent.
The middleware product is complete only under [proof R7](spec-proof.md#r7-completion-has-a-finite-gate).
Neither this document nor a completed adapter scaffold proves that gate.

## Cross-references

- Depends on the repository's Engine, proxy, SDK, and accounting contracts;
  [sources.md](sources.md) identifies their current locations.
- Runtime R1-R12 apply to every family in adapters R1.
- Proof R1-R7 validate overview R1-R4 and the two domain specifications.
