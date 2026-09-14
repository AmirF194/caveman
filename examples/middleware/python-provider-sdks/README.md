# Native Python OpenAI and Anthropic SDK examples

These examples exercise the official native SDKs through deterministic local
HTTP/SSE providers and a real Caveman runtime. No paid inference is used.
The hash lock pins OpenAI **3.10.0**, Anthropic **1.4.0**, HTTPX2/HTTPCore2
**2.12.0**, and Pydantic **2.13.5**. This run used Python **3.13.5**.

Run from the repository root:

```sh
uv venv --python 3.13 /tmp/caveman-provider-example-venv
uv pip sync --python /tmp/caveman-provider-example-venv/bin/python --require-hashes examples/middleware/python-provider-sdks/requirements.lock
go -C proxy build -o /tmp/caveman-provider-example-proxy ./cmd/caveman-proxy
export CAVEMAN_MIDDLEWARE_TEST_PYTHON=/tmp/caveman-provider-example-venv/bin/python
export CAVEMAN_MIDDLEWARE_TEST_BINARY=/tmp/caveman-provider-example-proxy
node examples/middleware/python-provider-sdks/run_native.mjs --example
node examples/middleware/python-provider-sdks/run_native.mjs
node examples/middleware/python-provider-sdks/run_native.mjs --lifecycle
```

The launcher supplies local SDK/middleware imports, creates an isolated runtime
database, starts the real runtime, and stops it afterward. `example.py` shows
existing clients, raw-response helpers, complete application-owned OpenAI Chat
and Responses loops, and Anthropic's native tool runner. Every complete loop
recovers the exact Unicode/CRLF source and returns `retained-detail-70`.

## OpenAI construction with physical retry observations

Use the official public HTTP client/transport injection to observe every SDK
HTTP attempt. Configure the native transport and client with the application's
existing TLS, proxy, timeout, and hook settings, then pass the same Caveman
transport object to the adapter:

```python
import httpx2
from openai import AsyncOpenAI, DefaultAsyncHttpxClient
from caveman_middleware.openai import (
    CavemanAsyncOpenAITransport, with_caveman_openai,
)

transport = CavemanAsyncOpenAITransport(httpx2.AsyncHTTPTransport())
http_client = DefaultAsyncHttpxClient(transport=transport)
original = AsyncOpenAI(http_client=http_client)
client = with_caveman_openai(
    original, runtime=runtime, scope=scope, transport=transport,
)
```

For synchronous code, use `CavemanOpenAITransport`, `httpx2.HTTPTransport`,
`DefaultHttpxClient`, `OpenAI`, and `MiddlewareRuntime`. The adapter delegates
to the supplied transport and its native pool. It neither discovers private
client fields nor replaces existing pools or owns retries. Native request
hooks still run for each native attempt.

The outer operation chooses one model view. Each actual send gets a distinct
attempt ID, while native retries retain the logical call, plan, and exact
outgoing bytes. Failed attempts retain unknown usage; successful native usage
is recorded once. Native terminal SSE markers count as completion when the
SDK stops reading at `[DONE]`. Closing before a terminal marker is cancellation.

The existing-client helper also works without `transport=`, preserving native
helpers and request handling. That mode observes one native SDK operation;
SDK-internal retries are not individually visible. Supplying a transport that
the client does not actually use also falls back to operation observations.
Use the explicit construction above for physical-attempt accounting. If an
application replaces a clone's `http_client`, wrap it with the matching new
transport. Close the native client and middleware runtime at application exit.

## Native loops and recovery registration

Python OpenAI 3.10.0 exposes no native tool scheduler. Use
`with_caveman_openai_tools(original, runtime=runtime, scope=scope,
transport=transport, protocol=protocol, tools=definitions, functions=executors)`
for an application-owned loop. The protocol is `openai-chat` or
`openai-responses`; definitions use that native API's shape. Dispatch every
decoded function call through the returned immutable `functions` table and
pass the returned `tools` on native calls. Every `tools` access gives a fresh
definition list. The helper supplies the recovery function and leaves
scheduling, source-tool execution, and stored history with the application.

`with_caveman_anthropic(original, runtime=runtime, scope=scope)` preserves the
native `beta.messages.tool_runner` in sync/async and complete/streamed forms.
It injects a native builtin function object. The pinned Python runner snapshots
its executor table at construction; `set_messages_params` changes the next
request parameters without replacing that table. Altered schemas, duplicate
names, tool-removal blocks, and forced output disable lossy projection.

Model-only calls remain recovery-free. A tool schema alone cannot grant
recovery. Perform application authorization and original-content policy checks
before invoking the wrapped client. Existing Anthropic middleware retains its
order, with Caveman appended after it. OpenAI transport hooks receive the
outgoing model view and cannot substitute for earlier original-content checks.

## Native coverage and limits

The 17 native tests include sync/async raw, parsed, and streamed helpers;
event order compared with native baselines; client copies; complete tool loops;
`off`/runtime-outage fallback; native errors; preserved signed bodies and opaque
history; protected error/unknown/media/citation result shapes; schema and
executor boundaries; and changes during optimization. Responses
`previous_response_id` and `conversation` references pass through. Unrelated
embedding, batch, token-count, retrieve/cancel, and compaction APIs pass through.

Forty native/wrapped retry cases exercise Chat and Responses, sync and async,
503-to-success, exhausted retries, streamed retry success, and broken streams.
They verify two provider calls, distinct attempts, stable projected bytes and
plan, exactly one optimization, preserved hooks, native error classes, and
incomplete failed-attempt usage. Four additional transport cancellation cases
verify provider socket close before fixture release.

Native async Chat `.stream()` rejects non-strict function tools before HTTP.
The wrapper preserves the same native `ValueError`. The ordinary-schema async
tool-loop streaming example in the tests uses native `create(stream=True)` and
the public `AsyncChatCompletionStream` accumulator. Sync Chat `.stream()` and
both Responses stream helpers are covered directly.

The repeated lifecycle probe separately checks 72 combinations of protocol,
native/wrapped client, async direct stream/stream manager, and close/task
cancellation across three repetitions. Inspect `lifecycle-evidence.json` for its precise runtime hash
and shutdown diagnostics. The pinned HTTP stack can emit
`RuntimeError: generator didn't stop after athrow()` at event-loop shutdown in
both native and wrapped runs. Socket release before fixture EOF is measured
separately; a closed socket does not prove all async generators shut down cleanly.

`native-evidence.json` records the full suite result, versions, hashes, native
operations, and observations. Filtered unittest runs overwrite it with a partial
result; run the complete suite for final evidence. Untested framework versions
use a passive native client clone with `unsupported_version`, or raise before inference
when `strict=True`. The version-boundary test changes only the adapter's version
check and does not claim compatibility with another SDK. These local fixtures
establish mechanism behavior, not hosted model quality or invoice savings.

Configure `on_report=` on the runtime for immutable status, reason, transform
IDs, and replacement/reuse counts after each visible provider-attempt decision.
The event contains no original text. `runtime.last_report` retains only the
latest event across the shared runtime. Callback exceptions do not affect
inference. `off` emits `disabled` through the native client delegate, without
optimizer requests, receipts, or changes to caller-owned options and clients.

## Exact operation candidates and replay

The central provider driver runs the 17 native tests, four existing contract
tests, and four sync/async native journey tests. The journey tests execute all
34 frozen OpenAI cells and 16 Anthropic cells in compression, `off`, and
runtime-outage modes. Native tool calls produce the source result before each
model-only helper. Recovery-free helpers, opaque Responses history references,
and unrelated endpoints record their actual provider bytes and native output.
Application/native tool loops prove omitted-fact recovery and original history.

Using the locked Python environment and built runtime from the setup above:

```sh
node examples/middleware/python-provider-sdks/certify.mjs F01 --replay
node examples/middleware/python-provider-sdks/certify.mjs F02 --replay
```

Keep `CAVEMAN_MIDDLEWARE_TEST_PYTHON` and `CAVEMAN_MIDDLEWARE_TEST_BINARY` set.
Each family directory under `certification/` contains input hashes, raw native
TAP, one candidate per exact operation, and a fresh-process replay report. The
report checks all eight observations against the new execution. These commands
do not promote shared support manifests or certify hosted model quality.
