# Native ASGI middleware

This adapter is for exact LLM JSON POST routes in an existing ASGI application.
FastAPI 0.141.1 and Starlette 1.6.0 are the current local native test pins. The
adapter itself has no ASGI server dependency and does not create an inference
client or tool scheduler.

Install built development wheels into a clean environment:

```sh
python -m pip install ./caveman_sdk-1.0.0-py3-none-any.whl \
  './caveman_middleware-0.1.0-py3-none-any.whl[asgi]'
```

Create one `AsyncMiddlewareRuntime` at application startup, call `ready()`, and
call `aclose()` at shutdown. Run the local `caveman-proxy serve` with its
configuration set to `mode: compress`; the default record runtime cannot be
overridden by a caller. Configure runtime authentication with `token=` when
the local runtime requires it.

Add the projection **inside** existing authentication and original-body guards:

```python
from caveman_cloud.middleware import AsyncMiddlewareRuntime
from caveman_middleware.asgi import ASGIContext, CavemanASGIMiddleware

runtime = AsyncMiddlewareRuntime(
    endpoint="http://127.0.0.1:8787",
    on_report=lambda report: print(report.status, report.reason),
)

def context_from_auth(scope):
    # These values were created by the application's authentication layer.
    state = scope["state"]
    return ASGIContext(
        scope=state["caveman_scope"],
        recovery=state.get("registered_recovery_binding"),
    )

projected_app = CavemanASGIMiddleware(
    existing_llm_app,
    runtime=runtime,
    routes={
        "/v1/chat/completions": "openai-chat",
        "/v1/responses": "openai-responses",
        "/v1/messages": "anthropic-messages",
    },
    resolve_context=context_from_auth,
)
# Wrap projected_app with the application's existing authentication and
# original-content guard middleware. Keep their policies and error handling.
```

`registered_recovery_binding` must be the actual `runtime.recovery(scope)`
binding whose `execute` function the application's tool loop executes. The
current model request must contain its exact generated native tool schema and
permit automatic tool selection. A tool-shaped JSON object, caller header, or
model wrapper alone cannot enable lossy compression. Without this operator
binding, requests retain original text and emit `recovery_unavailable` diagnostics.

`mode="off"` emits a `disabled` report and bypasses the adapter before body
consumption or scope resolution. `record` sends only
eligible text for local measurement, without storing originals or replacing
content. Runtime outages replay original request bytes and chunks. Authentication
and guards retain control; the middleware never turns their rejection into a
provider retry. Nested Caveman provider/framework adapters see one optimizer
owner. Do not use these routes for ordinary application JSON bodies.

`on_report` receives immutable metadata after the actual projection decision:
status, reason, transform IDs, and replacement/reuse counts. It contains no
original content. `runtime.last_report` retains the latest event across the
shared runtime, without a report history. Callback failures do not alter the
native response. Auth rejections outside this middleware produce no report.

Encoded/signed bodies, duplicate JSON keys, non-finite values, unknown messages,
oversized bodies, and unconfigured routes are passed through. Request buffering
is capped at 2 MiB/256 chunks by default. SSE messages are forwarded individually
with ASGI backpressure. Usage parsing has a 64 KiB buffer cap; larger usage
frames remain unobserved rather than fabricating counts. Lifespan, WebSockets,
response headers, native errors, and cancellation remain host-owned. Request
framing headers change only when replacement bytes require a new length.

Run the real-runtime native conformance suite:

```sh
python3 packages/middleware/conformance/python-environment.py asgi
CAVEMAN_MIDDLEWARE_TEST_BINARY=/absolute/path/caveman-proxy \
CAVEMAN_MIDDLEWARE_TEST_PYTHON=/absolute/path/asgi-venv/bin/python \
CAVEMAN_MIDDLEWARE_TEST_FAMILY=asgi \
node --test packages/middleware/conformance/python-framework.test.mjs
```

The tests run native OpenAI 3.10.0 and Anthropic 1.4.0 clients through actual
FastAPI/Starlette applications on a local Uvicorn 0.52.4 socket. All 33 required
operation cases have compression, off, and runtime-outage runs. Eligible routes
execute an application-owned source/recovery loop; typed calls retain original
source. SDK event types, first events before upstream EOF, exact source bytes,
original caller history, and native error classes/status/headers are asserted.

Named disconnect, oversized, auth, encoded-body, and unrelated-route cases
include separate original-byte boundary controls. Their eligible-route journey
does not claim compression of an encoded body or a disconnected request.
Direct ASGI tests also verify send backpressure, cancellation, lifespan,
WebSockets, and a 64 MiB/10,000-event stream. Native client/server dependencies
belong to this test fixture; the adapter creates no server or inference client.

Capture and independently replay the exact native operation observations:

```sh
CAVEMAN_MIDDLEWARE_TEST_PYTHON=/absolute/path/asgi-venv/bin/python \
CAVEMAN_MIDDLEWARE_TEST_BINARY=/absolute/path/caveman-proxy \
CAVEMAN_MIDDLEWARE_RUNTIME_PROVENANCE=/absolute/path/build.json \
CAVEMAN_MIDDLEWARE_CERT_OUTPUT_SUFFIX=my-run \
node examples/middleware/asgi/certify.mjs --replay
```

The provenance must come from the conformance runtime builder's actual compiled
Go dependency closure. These local native results do not establish hosted
quality, provider billing savings, native Windows behavior, or a production
multi-worker deployment.
