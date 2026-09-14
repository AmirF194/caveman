# Spec: Middleware runtime behavior

## Scope

These requirements define the shared behavior of every middleware adapter,
regardless of framework or language. They cover eligible context, original
content recovery, stable request construction, lifecycle, and truthful results.

## Requirements

### R1: Native request and response fidelity

Middleware changes only explicitly selected model-visible text leaves. It
preserves the surrounding native request and returns the host's native response.

Acceptance criteria:
- [ ] Roles, message order, tool-call IDs, tool arguments, tool schemas, structured
  output contracts, provider options, cache markers, reasoning/signatures,
  citations, media, attachments, and unknown fields survive unchanged.
- [ ] The only additive request material is explicitly registered recovery
  tooling and its stable instructions under R5. Existing schemas and their
  ordering are preserved; overhead is measured separately.
- [ ] User instructions, system/developer prompts, errors, required context, and
  opaque blocks are protected by default.
- [ ] Native objects are not round-tripped through a lossy common chat schema.
  Unknown object subclasses or unsupported content layouts pass through.
- [ ] Caller-owned history, tool return values, document stores, and framework
  checkpoints remain unchanged. The model-facing view may contain replacements.
- [ ] Raw-transport adapters preserve untouched wire bytes; model-level adapters
  preserve untouched native values and disclose that they cannot observe final
  provider serialization. Tests capture both layers where applicable.
- [ ] Temperature, model, endpoint, effort, retries, cache options, timeouts, and
  tool choice are identical with middleware on and off.

Dependencies: None.

### R2: Exactly one optimization owner per attempt

Nested application, framework, transport, gateway, and tool wrappers must not
compress or count the same transformation twice.

Acceptance criteria:
- [ ] Vercel plus a wrapped provider client, LangChain inside LangGraph, CrewAI
  using LiteLLM, and ASGI around LiteLLM each produce one selected owner and one
  transformation receipt per provider attempt.
- [ ] An explicitly configured Caveman inference proxy can be that owner. If
  middleware owns compression, its verified Caveman proxy route receives the
  existing request-wide pass-through control.
- [ ] Caveman control headers are never added to an unrelated provider endpoint.
  Untrusted inbound headers or content markers cannot select an owner or grant
  recovery access.
- [ ] Repeated optimization of identical scoped input returns the same chosen
  replacements. Reusing an idempotency key for different input is rejected.
- [ ] Different attempts remain visible even when replacements are reused;
  retries do not create fictitious additional unique-content reductions.

Dependencies: R6, R11.

### R3: One shared compression authority

Every adapter delegates eligible content to the Engine through the same
versioned runtime contract. The runtime never calls an inference provider.

Acceptance criteria:
- [ ] Identical scoped input and policy produce the same replacement bytes,
  recovery behavior, and token basis across Python and TypeScript fixtures.
- [ ] Capability discovery identifies runtime build, protocol revision,
  transforms, limits, recovery support, and persistence support.
- [ ] Unknown required protocol revisions or transform capabilities pass through
  with a reason; they are never guessed from a runtime version string.
- [ ] Provider authentication headers, HTTP clients, signing keys, and OAuth
  refresh material are not arguments to the optimization API.
- [ ] SDK single-payload compression remains backward compatible; middleware
  does not reinterpret that response as a complete conversation plan.

Dependencies: overview R4.

### R4: Eligibility is explicit and conservative

Initial lossy candidates are text tool results and explicitly selected RAG or
artifact text. Eligibility depends on adapter semantics, Engine capability,
recovery reachability, and cache state, not just content size.

Acceptance criteria:
- [ ] Only transforms advertised by the current Engine can be selected.
  Recovery-free operation requires an explicitly recovery-free capability;
  it does not invent a new "lossless" category.
- [ ] Unsupported, malformed, encoded, opaque, too-large, already compact, or
  protected input stays unchanged and has a specific skip reason.
- [ ] Tool outputs used programmatically are not replaced with strings merely
  because a model-facing rendering can be compressed.
- [ ] Local estimated reduction is positive after replacement markers and any
  newly required recovery instructions/schema overhead are included. If full
  request accounting is unavailable, publish only segment measurements and
  disclose unmeasured overhead; no request-level saving is claimed.
- [ ] Exact-enumeration, full-copy, patch-generation, and schema-sensitive
  fixtures either preserve all required content or remain recoverable under R5.
- [ ] Mode `record` emits no replacements and stores no originals in CCR;
  `off` sends no content to the runtime.

Dependencies: R1, R3, R5, R6.

### R5: Recovery is executable and exact

Lossy output is released only after originals are durably stored and a recovery
path is bound to the current application's actual tool loop or explicit reader.

Acceptance criteria:
- [ ] A schema named `caveman_retrieve`, without a registered implementation and
  matching runtime/session binding, does not enable lossy compression.
- [ ] The fixture model deliberately requests information absent from compressed
  output; the host runs recovery and receives exact original UTF-8 bytes.
- [ ] Tool registration is stable before the first model call. It does not append
  a different schema or instruction on later turns. Existing name collisions
  disable lossy compression rather than replace another tool.
- [ ] Recovery tool calls/results never enter compression recursively. The host
  retains tool permissions, approvals, max-step limits, and execution ordering.
- [ ] Recovery supports bounded query and exact byte-range/page access. Search
  results are labeled excerpts; partial output exposes `complete:false`, total
  length, original hash, and a continuation. No partial page claims to be the
  complete original. Page boundaries do not corrupt UTF-8.
- [ ] Unknown, unauthorized, deleted, and unavailable handles produce typed
  recovery failures; they never trigger a guessed summary, source fetch, or
  automatic re-execution of the original tool.
- [ ] Originals referenced by live replacement state remain available across
  restarts and documented session retention. Capacity pressure stops new lossy
  transforms instead of evicting referenced originals.
- [ ] Explicit expiry/deletion invalidates associated replacements. A resumed
  caller with original history can rebuild from originals; a caller holding only
  expired markers receives a recovery error and cannot claim successful recovery.
- [ ] Read-only RAG pipelines may supply an explicit source expansion callback.
  Without one, they use only recovery-free transforms. A receipt alone is not an
  executable recovery path.

Dependencies: R9.

### R6: Stable replacements across turns and workers

The runtime retains the exact replacement chosen for a logical content segment.
New compression applies only where the adapter establishes eligibility; frozen
content can only reuse a previously chosen replacement.

Acceptance criteria:
- [ ] The stable identity includes authenticated trust scope, session, branch,
  cache epoch, adapter serialization revision, policy/transform revision, and
  original-content digest. Tenant, branch, or policy changes cannot alias it.
- [ ] Twenty append-only turns reproduce earlier replacement bytes exactly,
  including markers, after process restart and across concurrent workers.
- [ ] Concurrent requests for the same identity converge on one durable winner
  before either receives a replacement. They cannot receive competing outputs.
- [ ] The application retains a consistent session identity through a
  conversation; creating a new identity per model call fails cache conformance.
- [ ] Forked graph states have separate branch identities. Editing or truncating
  historical input is detected and starts a declared new epoch or passes through.
- [ ] Runtime/policy upgrades do not silently replace old frozen content.
  Mappings either remain available under their original revision or require an
  explicit epoch reset with a cache-rebuild diagnostic.
- [ ] Missing state never reconstructs "what was sent" from a different input.
  Known local overlays may be replayed during runtime failure; otherwise original
  input is used and cache continuity is marked unavailable. Availability fallback
  can incur a cache miss and must not be described as cache-stable.
- [ ] Native-message stability and actual provider-prefix byte stability are
  distinct evidence fields. Only captured final provider serialization supports
  the latter. Provider cache-hit counters remain separately observed evidence.

Dependencies: R1, R2, R5.

### R7: Streaming and cancellation belong to the host

Optimization finishes before the affected model call. Responses stream through
the host's normal protocol and lifecycle without a hidden recovery loop.

Acceptance criteria:
- [ ] Text, reasoning, tool-call deltas, usage, provider errors, unknown events,
  and terminal signals retain their native values and order.
- [ ] A gated provider fixture delivers its first event before its final event
  is released; middleware does not buffer the complete generation.
- [ ] Backpressure is preserved. A slow consumer cannot cause an unbounded
  middleware event queue or eagerly drain the provider response.
- [ ] Abort/cancel before dispatch causes zero provider requests. Cancellation
  during optimization does not fall back into a fresh provider call.
- [ ] Early iterator close, context-manager exit, exceptions, and client
  disconnect release middleware-owned resources and propagate host cancellation.
- [ ] Incomplete streams retain incomplete usage status. Middleware does not
  fabricate a clean final response or consume tools behind the framework.

Dependencies: R1, R8.

### R8: Optimization failures do not duplicate inference

Before dispatch, ordinary optimization failures use original input. After
dispatch, the host client remains the sole retry and fallback authority.

Acceptance criteria:
- [ ] Runtime timeout, unreachable endpoint, malformed response, invalid patch,
  storage failure, capacity exhaustion, or failed capability checks preserve the
  original request and invoke the provider once in availability mode.
- [ ] Every patch is validated against its segment ID, original digest, allowed
  operation, and replacement digest before any native input is changed. A failed
  plan validation discards the entire plan, not half its replacements.
- [ ] Provider 4xx/5xx, partial upload, lost response headers, and truncated streams
  do not cause middleware to issue its own original-body retry. Existing proxy
  retry semantics are not copied into framework wrappers.
- [ ] Host retries reuse stable chosen replacements but keep distinct attempt
  identities. Host model/endpoint fallback rechecks capabilities for that route.
- [ ] Strict diagnostics fail before dispatch with a typed capability error.
  Authentication failure at the runtime itself never returns another scope's data.
- [ ] Error reports contain bounded codes and safe metadata, not raw input or
  provider exception bodies that might contain secrets.

Dependencies: R2, R6, R7, R9.

### R9: Trust scope and content access are explicit

Recovery access is authorized independently of knowing a content hash, session
name, or framework run ID. The local single-operator deployment does not pretend
to provide multi-tenant authorization.

Acceptance criteria:
- [ ] Authenticated runtime identity determines the trust boundary. A namespace
  separates application state but cannot grant access to another principal.
- [ ] Requests cannot set a tenant ID that overrides the server's authenticated
  scope. LiteLLM team scope comes from its trusted auth context, not user JSON.
- [ ] A shared runtime either has an authenticated per-principal resolver or uses
  separate instances per trust boundary. Shared bearer possession means shared
  authority and is documented as such.
- [ ] Framework-facing handles are scoped grants to existing CCR objects, not
  unauthenticated access to a global content-hash lookup.
- [ ] Only selected candidate content is transferred. Unselected messages/media
  and provider credentials are excluded from runtime requests and telemetry.
  The user is told that selected content itself can contain sensitive text.
- [ ] Remote content transfer requires explicit endpoint configuration and
  opt-in. Redirects cannot move content or runtime credentials to another origin.
- [ ] Local service routes reject cross-origin browser access and unauthorized
  shared-listener access. Optimization routes do not accept arbitrary fetch URLs.
- [ ] No raw content is logged/exported by default. Retention, deletion, and
  restart behavior are visible before enabling persistent recovery.

Dependencies: overview R2, R4.

### R10: Bounded overhead and lifecycle

Middleware has bounded memory, content transfer, queues, and optimization wait.
It does not impose a new generation deadline.

Acceptance criteria:
- [ ] Defaults are a 100 ms optimization deadline, 2 MiB serialized optimize
  request cap, 512 KiB candidate segment cap, and 256 KiB recovery page cap.
  Cap/deadline handling preserves original requests and records skip reasons.
- [ ] The shared deadline covers batching/queueing as well as runtime work;
  independent per-segment waits cannot multiply it by the number of segments.
- [ ] Python synchronous and asynchronous paths are explicit. Async operations
  never run blocking network work on the event loop; any executor is bounded and
  closed through application lifecycle.
- [ ] No subprocess, runtime discovery scan, or framework import occurs on each
  token, stream chunk, or model call after initialization.
- [ ] An optimization circuit breaker reports bypass while open and performs
  bounded probes; it does not retry failed provider requests.
- [ ] Large HTTP bodies that are bypassed remain streamable to the host; the
  adapter does not buffer beyond its cap merely to discover it cannot compress.

Dependencies: R7, R8; proof R4.

### R11: Measurements reflect their actual evidence

Receipts distinguish proposed transformations, attempted dispatch, completed
provider usage, unique content reduction, and repeated-request effects.

Acceptance criteria:
- [ ] A prepared plan without a provider call records no provider usage, spend,
  or observed saving. A dispatch-intent event is not proof of provider delivery.
- [ ] Token estimates name the tokenizer and scope (`segment` or `request`).
  Actual usage retains provider/SDK provenance and completeness. Unknown is not
  silently recorded as zero measured usage.
- [ ] A reused replacement does not rebook unique-content reduction. It can
  contribute to a separately labeled per-request token estimate when measurable.
- [ ] Required recovery tools, markers, all recovery calls, retries, output,
  reasoning, cache writes/reads, and optimization overhead enter task comparisons.
- [ ] Usage is recorded once per observed provider attempt even if multiple
  callbacks see its terminal event. Missing final usage remains incomplete.
- [ ] Local savings basis remains `inferred`; verified saved dollars remain zero.
  Subscription traffic never acquires fictional marginal API savings.
- [ ] Price-weighted API estimates require known pricing/provenance. They remain
  separate from invoices and from provider-causal savings claims.

Dependencies: R2, R7; proof R6.

### R12: RAG and tool provenance remain usable

Compression changes a rendering of retained content; it does not silently change
which documents, tools, or records the application selected.

Acceptance criteria:
- [ ] Document IDs, ordering, scores, metadata, source references, and original
  text remain available; returned compressed views do not mutate the index.
- [ ] Citation offsets into originals are not applied to shortened text. Native
  offset citations either retain a mapping backed by proof or protect the text
  from transformation.
- [ ] Original selected document/record collections and required tool registries
  remain intact. Middleware does not select fewer items or re-rank them to hit a
  target ratio. Elided text is an explicitly recoverable rendering under R5;
  changing the selected collection requires a separate explicit API and policy.
- [ ] Recovery returns the original source identity along with original content;
  two documents with identical text retain distinct citation identities.

Dependencies: R1, R4, R5.

## Out of scope

Inference routing, model selection, tool authorization, application memory,
semantic response caching, and producing new output text remain host-owned.
This spec does not create a new Context IR or compressor implementation.

## Cross-references

- Every [adapter family](spec-adapters.md#r1-required-framework-coverage) implements
  these requirements through its native extension point.
- [Proof R1-R6](spec-proof.md) define shared acceptance runs.
- [Implementation plan](implementation-plan.md) proposes the concrete protocol
  and package split while preserving these behavioral requirements.
