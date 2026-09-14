# Native LiteLLM fixture

The fixture exercises 36 pinned LiteLLM 1.100.0 operation cells against local
OpenAI and Anthropic HTTP endpoints. Each operation runs with compression,
disabled middleware, and an unavailable optimizer. LiteLLM owns its SDK calls,
Router selection, retries, fallbacks, protocol translation, and stream objects.

The 20 SDK cells have no recovery executor. Their real application tool output
reaches the provider unchanged, including structured-output calls. The 16 Router,
Proxy, and ASGI cells use an application-owned tool registry: the native provider
asks to read the source, receives a shortened view, requests the omitted fact,
and invokes the registered recovery binding. The fixture checks exact UTF-8
recovery, original history, native result and event types, and provider counts.

The native Proxy cases call its actual FastAPI routes and authentication. A
policy callback inspects original content before the trusted scope resolver.
With no key database configured, LiteLLM returns HTTP 400 for an unknown virtual
key; the fixture verifies that policy, optimizer, and provider work did not run.
An authenticated request rejected by the original-content policy returns 403.

Register `CavemanLiteLLM` after original-content policy callbacks and keep its
context manager open while asynchronous calls or synchronous Router streams are
active. The sync Router path uses the public `log_pre_api_call` callback after
native deployment selection. Because LiteLLM swallows that callback's errors,
strict sync Router calls reject before any provider request with
`unsupported_sync_router_strict`.

`on_report` and `last_report` expose immutable metadata without source text or
extra requests. Active calls report each owned provider dispatch; disabled
calls report each public method invocation without installing SDK callbacks.
The tests cover unchanged passive results, native errors, callback failures,
concurrent runtime isolation, and removal of Caveman registrations.

Run from the repository root:

```sh
uv venv /private/tmp/caveman-litellm-native-venv --python 3.13
uv pip sync examples/middleware/litellm/composition-requirements.lock \
  --python /private/tmp/caveman-litellm-native-venv/bin/python --require-hashes
node packages/middleware/conformance/support/runtime-build.mjs \
  --output=/private/tmp/caveman-litellm-native-runtime
export CAVEMAN_MIDDLEWARE_TEST_PYTHON=/private/tmp/caveman-litellm-native-venv/bin/python
export CAVEMAN_MIDDLEWARE_TEST_BINARY=/private/tmp/caveman-litellm-native-runtime/caveman-proxy
export CAVEMAN_MIDDLEWARE_RUNTIME_PROVENANCE=/private/tmp/caveman-litellm-native-runtime/build.json
export CAVEMAN_MIDDLEWARE_CERT_OUTPUT_SUFFIX=local-run
node examples/middleware/litellm/certify.mjs --replay
```

Use a fresh output suffix to retain earlier runs. The producer binds candidate
records to actual passing native test results and hashes of source, dependency
locks, and the runtime build. A second process must reproduce every scoped
assertion before replay passes. The output is local native-fixture evidence;
it does not establish external-provider behavior or paid usage savings.

The complete fixture needs `composition-requirements.lock`, which includes
LiteLLM's proxy extras. No Redis service or paid inference is used. See
[the ASGI composition fixture](./composition.md) for the application routes.
