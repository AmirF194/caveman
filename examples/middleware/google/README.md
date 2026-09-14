# Google GenAI native middleware

Tested against `@google/genai==2.21.0` and `google-genai==2.22.0`. The local
fixtures call the installed SDKs and the actual Caveman Engine service. Google
responses, automatic function calling (AFC), and chat history remain native.
No paid provider calls are part of these checks.

## Install and runtime

```sh
npm install @caveman-ai/sdk @caveman-ai/middleware @google/genai@2.21.0
python -m pip install 'caveman-middleware[google]'
```

These packages are development artifacts until published. Use the repository's
packed-consumer gate to install the built tarballs and wheels. Build and run the
Caveman runtime separately; the fixture binary is not an installed release.

The runtime connection is application-owned and reused across calls. The default
endpoint is local. A remote endpoint needs explicit runtime opt-in. Only selected
tool-result text goes to the optimizer, and that text can contain sensitive data.
Provider credentials never go to the optimizer. Close the runtime and any
application-owned HTTP clients at shutdown.

## TypeScript

```ts
import { createMiddlewareRuntime } from '@caveman-ai/sdk/middleware';
import { CavemanGoogleGenAI } from '@caveman-ai/middleware/google';

const runtime = createMiddlewareRuntime({
  endpoint: 'http://127.0.0.1:8787',
  onReport: report => console.log(report.status, report.reason),
});
await runtime.ready();
const scope = { namespace: 'my-app', session_id: 'conversation-1', branch_id: 'main', cache_epoch: '0' };

// Reuse the exact options previously supplied to new GoogleGenAI(...).
const client = new CavemanGoogleGenAI(existingGoogleOptions, { runtime, scope });
const response = await client.models.generateContent(existingRequest);
console.log(runtime.lastReport);
// Application shutdown:
await runtime.close();
```

The SDK has no public clone or custom-fetch option for generate-content APIs.
This constructor accepts the original `GoogleGenAIOptions`, including Vertex
settings, and builds native `Models` and `Chats` through their public
constructors. It delegates the SDK's protected API client without modifying its
private fields. Already-created clients must be reconstructed from their
original options. Other SDK modules retain their native behavior.

Use native `CallableTool` objects for AFC. Caveman appends its real recovery
executor when the call can offer it. The native SDK executes the tool loop. The
fully typed [example](example.ts) uses ordinary package imports and has no
application loop or casts at the integration boundary.

`generateContent`, `generateContentStream`, `chat.sendMessage`, and
`chat.sendMessageStream` are exercised with recovery. Native `GenerateContentResponse`
objects and getters remain available. Early stream return cancels its native
request; a caller's abort signal is forwarded.

The request seam is before SDK-owned HTTP retries. Chosen replacement bytes stay
stable during a native retry, but individual internal HTTP retry attempts are
not observable through this public seam. Receipts describe SDK requests; they do
not establish the number of internal retries or their cost. An explicit
`httpOptions.extraBody` causes an unchanged request because the SDK merges it
after the interception point.

## Python

```python
import httpx
from google import genai
from google.genai import types
from caveman_cloud.middleware import MiddlewareRuntime, Scope
from caveman_middleware.google import (
    CavemanGoogleTransport, CavemanGoogleAsyncTransport,
    with_caveman_google, with_caveman_google_chat,
)

runtime = MiddlewareRuntime(
    endpoint='http://127.0.0.1:8787',
    on_report=lambda report: print(report.status, report.reason),
)
runtime.ready()
scope = Scope('my-app', 'conversation-1')
provider_base_url = 'https://generativelanguage.googleapis.com'
http = httpx.Client(transport=CavemanGoogleTransport(
    runtime=runtime, scope=scope, provider_base_url=provider_base_url))
async_http = httpx.AsyncClient(transport=CavemanGoogleAsyncTransport(
    runtime=runtime, scope=scope, provider_base_url=provider_base_url))
client = genai.Client(
    **{**existingGoogleOptions, 'http_options': existingHttpOptions.model_copy(
        update={'httpx_client': http, 'httpx_async_client': async_http})},
)
with_caveman_google(client, runtime=runtime, scope=scope)

# For a native Chat, pass the same default config used to construct it.
chat = with_caveman_google_chat(
    client.chats.create(model=model, config=existingConfig),
    runtime=runtime, scope=scope, config=existingConfig,
)
response = chat.send_message(question)
print(runtime.last_report)
# Application shutdown: client.close(), http.close(),
# await client.aio.aclose(), await async_http.aclose(), runtime.close().
```

Here `existingHttpOptions` is the application's native `HttpOptions` object.
Construct the HTTPX clients with the application's existing HTTPX arguments,
hooks, proxy and transport settings. Keep timeout, retry, and Vertex options.
`provider_base_url` allowlists
the actual provider origin and path prefix. Set it to the configured Vertex
endpoint when using Vertex. For an existing custom HTTP transport, pass it as
`transport=` to the corresponding Caveman transport. Configure existing
authorization and original-content request hooks on the HTTPX client; those
hooks execute before optimization. Existing HTTP clients cannot have their
private transport replaced after construction.

The client helper registers native model AFC on that instance's public methods.
Python chats own a separate AFC loop, so wrap the native `Chat` or `AsyncChat`
explicitly and pass its original default config. A config supplied to an
individual send overrides that default. The [complete example](example.py)
preserves other `HttpOptions` and closes the application-owned HTTP client.

Sync and async generate, stream, chat, and chat stream paths are exercised. The
async transport uses the shared runtime's bounded async connection. Cancellation
and generator closure close the observed native response stream. Python's
HTTPX seam observes each native HTTP attempt separately.

## Limits and evidence

Model-only calls remain usable with original input. Recovery requires a real,
registered native executor in the current invocation. A matching tool schema
alone cannot enable lossy output. Forced tool choices and structured-output
contracts keep the original request. `cached_content` / `cachedContent` makes
the entire request opaque to optimization; server-held content is never inferred
from its ID. Images, audio/file references, thought signatures, errors, and
structured tool return values are preserved. Only string `output` or `result`
leaves in matched function responses are candidates.

The shared runtime handles unavailable/disabled optimization without duplicating
inference. Set runtime mode to `off` for opt-out. Optimizer receipts and
diagnostics use shared SDK contracts. Missing provider usage remains unknown;
local token estimates are inferred and do not establish paid savings.

```sh
CAVEMAN_MIDDLEWARE_TEST_BINARY=/path/to/caveman-proxy \
  node --test examples/middleware/provider-sdks/google.test.mjs

CAVEMAN_MIDDLEWARE_TEST_BINARY=/path/to/caveman-proxy \
  CAVEMAN_MIDDLEWARE_TEST_PYTHON=/path/to/pinned/python \
  CAVEMAN_MIDDLEWARE_TEST_FAMILY=google \
  node --test packages/middleware/conformance/python-framework.test.mjs
```

The tests require loopback listeners. They do not certify live Gemini/Vertex
auth, mTLS, native Windows, or provider pricing. Performance budgets, packaged
consumers, and live-provider coverage are separate release gates.

Native API references: [Google TypeScript CallableTool](https://googleapis.github.io/js-genai/release_docs/interfaces/types.CallableTool.html),
[Google TypeScript SDK](https://github.com/googleapis/js-genai), and
[Google Python SDK](https://github.com/googleapis/python-genai).

## Exact operation evidence

The additional native journey tests execute all 48 frozen Google and Vertex
operation cells: 32 Python sync/async cells and 16 TypeScript cells. Every cell
runs with compression, `off`, and an unavailable optimizer. The source result
comes from an actual native tool call and executor. Recovery compares the
omitted fact and exact UTF-8 bytes with native AFC/chat history or native
function-response stream events. Structured and cached-content operations
explicitly remain recovery-free. Vertex uses the native project/location and
OAuth client path with fixture credentials; this is not live Google auth proof.

With the exact locked environments and runtime binary configured:

```sh
node examples/middleware/google/certify.mjs python --replay
node examples/middleware/google/certify.mjs typescript --replay
node examples/middleware/google/run_probes.mjs
```

`certification/python/` and `certification/typescript/` contain input hashes,
native and fresh-process replay TAP, per-cell candidates, and coverage reports.
The commands do not promote the shared support inventory. The local
`certification-cells.json` fixtures let clean package consumers run the same
operations without importing repository support code.

Cancellation proof names its actual mechanism: Python async task cancellation
followed by `aclose()`, Python sync generator close, or TypeScript native abort
signal followed by iterator return. `lifecycle-evidence.json` separately measures
suspended Python async AFC `aclose()` with no task cancellation. At these pins,
the native SDK and `off` mode can retain the response socket after suspended
generator closure; active middleware modes close it with the generator. The
probe records socket EOF after stream close, native SDK client close, and
application-owned HTTP client close, before the fixture releases completion.
These cleanup actions remain distinct observations.

Runtime `on_report` (Python) or `onReport` (TypeScript) receives immutable
metadata for each wrapped request, including each native AFC step. Python's
transport reports each HTTP attempt; TypeScript reports SDK invocations and
cannot observe their internal HTTP retries. The report describes the applied
view; off and opaque cached-history calls also report their original fallback
without sending content to the optimizer. `runtime.last_report` (Python) or
`runtime.lastReport` (TypeScript) retains the latest value across calls using
that runtime. It is empty before the first report and is not a per-run history.
Reporting itself performs no network I/O.
The exact-cell tests verify report counts against actual provider requests and
replacement counts against the native request views.
