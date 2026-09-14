# Caveman Python middleware

Native framework integrations over `caveman_cloud.middleware`. Frameworks keep
their models, tool loops, stream types, retries, and stored conversation state.
Each framework is an optional extra; the core connection remains stdlib-only.

This package is under development. Native conformance uses pinned upstream
packages and a real local Caveman runtime. Hosted quality and cost certification
are separate from these local tests.

Install the matching framework extra, create a shared `MiddlewareRuntime` or
`AsyncMiddlewareRuntime`, and give each conversation an explicit `Scope`.
Call `close()` or `aclose()` on the runtime at application shutdown. Original
provider clients and caller-owned message histories are preserved.

`off` delegates native calls and emits `disabled` reports without optimizer
requests or receipts. `record` measures without replacement.
`compress` requires a registered recovery executor for lossy transforms.
Unavailable optimization passes original content and reports unavailable cache
continuity. Token estimates do not establish verified billing savings.

Set `on_report=` on the runtime for immutable decision metadata: status, reason,
transform IDs, and replacement/reuse counts, without original content. The
synchronous callback runs after the adapter decides which request view to use;
callback exceptions do not affect inference. `runtime.last_report` retains the
latest report across the shared runtime, without a report history. Passive
delegates used by `off` and untested versions preserve caller options and native
results.
