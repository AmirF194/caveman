# Spec: Framework middleware proof and release

## Scope

This specification defines what must be demonstrated before middleware is
called supported, provider-tested, or complete. Most checks are deterministic,
local, and free. Real-provider comparisons are separate, explicitly budgeted
runs, not an implicit consequence of executing the local test suite.

## Requirements

### R1: Contract conformance is shared

Schemas and language bindings have one fixture authority.

Acceptance criteria:
- [ ] Every wire object has a versioned schema, valid vectors, and malformed
  vectors. Both SDKs execute the same vectors, not duplicated hand-written cases.
- [ ] IDs, enum values, field presence, original/replacement digests, limits,
  skip reasons, scope separation, and receipt transitions have exact assertions.
- [ ] Existing SDK parity tests and exported API tests still pass unchanged
  except for intentional additive middleware exports.
- [ ] All normative requirements and F01-F16 acceptance items map to a named
  test or bounded benchmark in a traceability manifest. No acceptance checkbox
  is marked passed solely because its implementation exists.

Dependencies: overview R4; runtime R3; adapters R2.

### R2: Real framework conformance

Use the installed, exact-pinned framework and real public model/client APIs.
Only the remote inference provider is replaced by a deterministic local server
or a documented native testing model where no HTTP adapter is involved.

For each mandatory family/language/operation, the journey is:

1. Construct the original application with its native model, tools, and history.
2. Enable Caveman and call a tool producing a large deterministic result.
3. Capture the next model request and prove an eligible transformation occurred.
4. Have the fixture model request a fact absent from the compressed rendering.
5. Let the framework execute recovery, then issue its normal continuation.
6. Validate exact final answer, original recovery bytes, unchanged original
   history, native response type, complete event order, and provider call count.
7. Repeat with compression disabled and with the optimizer unavailable.

Acceptance criteria:
- [ ] The journey passes through the native framework loop; directly calling an
  adapter helper with a dictionary does not qualify.
- [ ] Supported sync, async, streaming, batch, tool, and structured-output paths
  satisfy both the journey and their F01-F16 method-specific assertions.
- [ ] Model-only and RAG-only integrations additionally prove their explicit
  no-recovery behavior; they never advertise unrecoverable lossy output.
- [ ] The stream fixture gates headers, first chunk, tool deltas, and completion
  independently and checks early close and cancellation.
- [ ] Native testing models prove hook behavior only. Provider serialization
  claims require the actual provider client's local HTTP capture as well.
- [ ] Every run records framework/SDK/runtime/package revisions and source/lock
  digests. Fake replacement framework classes cannot earn `conformant` status.

Dependencies: adapters R1-R6; runtime R1-R12.

### R3: Adversarial and composition coverage

Shared correctness gates cover the conditions most likely to turn smaller
context into incorrect answers, lost cache reuse, or duplicate inference.

Acceptance criteria:
- [ ] Semantic corpus includes JSON enumeration and arithmetic, code copied
  exactly, patches, CSV anomalies, YAML drift, long logs, citations, distinct
  documents with identical text, Unicode, and data whose key fact must be recovered.
- [ ] Malformed/native-unknown blocks, signed thinking, images, audio references,
  forced tools, refusal/error responses, encoded HTTP bodies, and small/no-op
  inputs are preserved according to runtime R1/R4.
- [ ] Twenty-turn tests cover stable prefixes, restart, missing state, policy
  upgrade, deliberate history edit, branch isolation, and concurrent first writes.
- [ ] One hundred interleaved scoped sessions cannot retrieve or reuse another
  trust scope's content. Guessing a CCR hash or changing a namespace does not
  cross the authorization boundary.
- [ ] Recovery name collision, schema-only fake registration, storage full,
  deletion/expiry, missing pages, malformed optimizer replies, timeouts, and
  optimizer shutdown produce defined outcomes without hanging or replaying tools.
- [ ] All four compositions from runtime R2 run through native frameworks, with
  a single optimizer owner, intact auth/guardrails, and deduplicated receipts.
- [ ] Provider timeout after upload and stream interruption never cause an
  additional middleware-owned inference attempt.

Dependencies: runtime R2, R5-R9; adapters R5.

### R4: Performance has a measured budget

These are acceptance targets, not claims about current implementation. Record
host CPU, memory, OS, runtime versions, fixture sizes, concurrency, and warmup.

Acceptance criteria:
- [ ] On a dedicated host with at least four CPU cores and 8 GiB RAM, after 100
  warmup calls, 1,000 calls at concurrency 16 with a 100 KiB candidate body have
  p95 adapter-only overhead at most 5 ms. This excludes Engine/IPC time and is
  reported alongside, never in place of, total overhead.
- [ ] The same run has p95 local optimize round-trip at most 50 ms and fewer
  than 1% deadline/capacity bypasses. Queue time is included. A fast no-op run
  cannot substitute for a corpus containing real compression.
- [ ] The default 100 ms optimization deadline bounds pre-dispatch delay plus
  scheduler tolerance of 25 ms under this fixture; provider generation receives
  no added total deadline.
- [ ] A 10,000-event, 64 MiB response stream uses at most 1 MiB additional
  middleware buffering, excluding the host/provider client and caller's own
  accumulation. First-event forwarding is independently checked.
- [ ] A 30-minute interleaved-session soak returns active task/stream counters to
  zero after close and does not retain completed-scope payloads beyond the
  configured retention/capacity policy. Memory/storage graphs are retained.
- [ ] Slow-runtime and overload tests trip bounded bypass rather than grow
  unbounded work queues or multiply per-segment deadlines.

Dependencies: runtime R7, R10.

### R5: Packaged consumers and docs work

Testing inside the workspace is insufficient for independently installed users.

Acceptance criteria:
- [ ] Each TypeScript export is installed from its packed tarball into a clean
  consumer; each Python distribution/extra is installed from a built wheel into
  a clean environment. Examples use no repository aliases or workspace links.
- [ ] Importing the core SDK installs no framework, torch/model runtime, or
  private package. Importing one adapter does not require unrelated frameworks.
- [ ] Both languages support their declared interpreter/runtime floor. Existing
  SDK floors remain explicit; raising/lowering them is not hidden in middleware.
- [ ] Every advertised minimum/maximum framework version has passing conformance
  evidence. Start with exact tested versions; broaden ranges only after tests.
- [ ] Linux and macOS packaged examples pass; native Windows proves lifecycle,
  transport, paths, and cancellation before Windows is labeled supported.
- [ ] Documentation snippets compile/run against the built packages and show
  install, runtime setup, existing app integration, recovery, diagnostics,
  opt-out, and shutdown. They label unavailable operations and recovery limits.
- [ ] Runtime binary/container source, version, checksum, and license are known.
  A development binary is not represented as an installed release artifact.

Dependencies: overview R1, R4; adapters R2, R3.

### R6: Task and provider evidence remain separate

Provider compatibility and economic benefit require actual provider calls.
The test runner defaults to zero external inference traffic.

Acceptance criteria:
- [ ] Hosted runs require explicit provider opt-in and a positive maximum spend
  budget. Missing either causes a local refusal before obtaining credentials or
  making provider requests. Budget exhaustion stops scheduling new calls.
- [ ] A live smoke records the exact framework, SDK, runtime, provider endpoint,
  model, auth class, date, stream result, recovery outcome, and usage completeness.
  Bedrock/Vertex auth and native Windows need their own evidence.
- [ ] The comparison corpus contains at least 24 frozen tasks: coding changes
  with hidden tests, multi-step tool work, RAG with citation checks, and
  structured-data tasks. Small/no-op and negative cases remain in the aggregate.
- [ ] Direct, Caveman middleware, and Headroom use the same framework/native
  extension layer on their common supported intersection. A missing rival
  adapter is reported as a coverage gap, not an invented zero or forced proxy arm.
- [ ] Every task has at least three rotated repetitions, with provider/model,
  effort, tools, permissions, data, and task limits fixed. Cold-cache and
  warm-cache runs are separate strata; arm cache identities do not contaminate
  one another. Version/source/dependency locks accompany every arm.
- [ ] Primary outcomes are task pass rate and total provider cost per passed
  task, including the cost of failures, retries, and recovery. Also publish
  latency, output/reasoning tokens, cache buckets, host overhead, and uncertainty.
- [ ] No universal percentage is required for launch. A superiority claim needs
  no more than a 2 percentage-point observed pass-rate loss, a task-clustered
  95% lower confidence bound on pass-rate difference of at least -2 points, and
  a 95% lower bound on cost reduction above zero. Insufficient sample size earns
  "inconclusive," not "same quality." Expand pre-registered trials if needed.
- [ ] Publish runnable harness, redistributable fixtures, raw redacted receipts,
  oracle definitions, exclusions, artifact hashes, and exact rerun instructions.
  List-price calculations remain labeled estimates; invoices are separate.

Dependencies: runtime R11; adapters R2; overview R2.

### R7: Completion has a finite gate

The full middleware release is complete only when every required matrix entry
has executable proof and usable package distribution.

Acceptance criteria:
- [ ] All F01-F16 required language/method cells are at least `conformant`;
  upstream-absent cells have explicit sourced `not_applicable` explanations.
- [ ] Shared contracts, semantic/recovery/cache/isolation tests, composition
  tests, performance budgets, and packaged examples pass.
- [ ] The public support matrix is generated from the same manifests CI checks.
  Source-only, conformant, and real-provider-tested states remain distinct.
- [ ] No unresolved correctness/security failure is hidden by marking a method
  unsupported if that method is required by F01-F16.
- [ ] The release records live-provider coverage and any remaining uncertified
  combinations. "Full middleware" describes integration coverage, not blanket
  production certification or proved economic superiority.
- [ ] Package publishing follows existing release policy; spec completion does
  not itself authorize a publish, live deployment, or paid benchmark.

Dependencies: R1-R6; overview R1-R4; adapters R1-R6; runtime R1-R12.

## Out of scope

Fabricated model answers presented as live evidence, token-only winner claims,
unbounded hosted sweeps, registry publication during specification work, or
certification inherited from an old proxy benchmark.

## Cross-references

- [Framework requirements](spec-adapters.md) define the mandatory matrix.
- [Runtime requirements](spec-runtime.md) supply the invariants under test.
- [Implementation plan](implementation-plan.md) stages proof with each slice.
