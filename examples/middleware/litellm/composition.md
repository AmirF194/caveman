# Native ASGI and LiteLLM composition

`composition_test.py` runs an actual user ASGI application inside
`CavemanASGIMiddleware`. The OpenAI route calls `CavemanLiteLLM.acompletion`,
which delegates to the installed native LiteLLM SDK. The Anthropic route calls
LiteLLM's public native `anthropic_messages` API. That route keeps Anthropic
message shapes throughout; the fixture contains no provider message translator.
The registered Caveman LiteLLM callback is active around both routes.

The application's outer middleware authenticates the request and inspects its
original content before the server-owned scope resolver runs. HTTP namespace
headers cannot select that scope. The host's own `/tools/read_logs` and
`/tools/caveman_retrieve` routes dispatch its real tool registry; recovery uses
the exact runtime `binding.execute` supplied to the ASGI context.

For each provider, the test runs the real host tool loop, captures the native
provider HTTP request, requests a fact omitted by compression, and verifies
exact UTF-8 recovery and unchanged caller history. It checks one ASGI optimizer
owner per native model call, native result types, receipt and call counts, off
mode, optimizer outage, auth and original-content rejection, a first stream
chunk before EOF, native stream close on cancellation, and failure without a
second provider request.

Use the dedicated lock. LiteLLM 1.100.0's native Anthropic Messages streaming
loads proxy helpers that import FastAPI, Starlette, orjson, backoff and redis.
The ordinary SDK example lock does not include those imports. The composition
lock installs `litellm[proxy]` and the pinned native dependencies needed by the
actual Proxy and ASGI fixtures. No Redis service is used.

From the repository root, with a fresh runtime binary:

```sh
uv venv /private/tmp/caveman-middleware-litellm-composition-venv --python 3.13
uv pip sync examples/middleware/litellm/composition-requirements.lock \
  --python /private/tmp/caveman-middleware-litellm-composition-venv/bin/python \
  --require-hashes
export CAVEMAN_MIDDLEWARE_TEST_BINARY=/absolute/path/to/fresh/caveman-proxy
export CAVEMAN_MIDDLEWARE_TEST_PYTHON=/private/tmp/caveman-middleware-litellm-composition-venv/bin/python
node --test packages/middleware/conformance/composition-python.test.mjs
```

The runner starts the actual local Go runtime and substitutes only provider
HTTP responses. It preserves the ordinary LiteLLM SDK environment. No paid
inference runs. `CAVEMAN_MIDDLEWARE_OBSERVATION` lines contain the exact static
test name, scoped cell ID, runtime binary hash, native LiteLLM version and the
assertions exercised by that execution. These are local native-fixture
observations; they do not claim live provider or invoice verification.
