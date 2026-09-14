# Pydantic AI middleware

This example pins Pydantic AI 2.42.0, OpenAI Python 3.11.0, and Anthropic Python
1.4.0, with httpx2/httpcore2 2.12.0. Pydantic AI owns the run loop, tools, dependencies, retries, capabilities,
provider clients, and typed results. Caveman creates a separate view of selected
plain tool-return text immediately before each native model request.

Install the built SDK and middleware wheels with the adapter dependencies:

```sh
python -m pip install 'caveman-middleware[pydantic-ai]==0.1.0' 'openai==3.11.0' 'anthropic==1.4.0' 'httpx2==2.12.0'
```

These packages are under development; this is the consumer interface, not a
publication claim. Create the exact local test environment with
`python3 packages/middleware/conformance/python-environment.py pydantic-ai`.
The adjacent `requirements.lock` records all dependency hashes.

## Existing model and complete native tool loop

`example.py` supplies a native `Agent` with a dependency-backed source tool.
Your application provides its existing model, runtime connection, and source:

```python
import asyncio
import os

from openai import AsyncOpenAI
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider
from caveman_cloud.middleware import MiddlewareRuntime
from example import LogSource, build_agent


async def main():
    async with AsyncOpenAI() as client:
        with MiddlewareRuntime(
            endpoint=os.environ["CAVEMAN_MIDDLEWARE_ENDPOINT"],
            on_report=lambda report: print(report.status, report.reason),
        ) as runtime:
            model = OpenAIChatModel(
                os.environ["OPENAI_MODEL"],
                provider=OpenAIProvider(openai_client=client),
            )
            agent = build_agent(model, runtime, namespace="my-application")
            with open("diagnostics.log", encoding="utf-8", newline="") as source:
                result = await agent.run(
                    "Read the source and recover original details when needed",
                    deps=LogSource(source.read()),
                    conversation_id="investigation-17",
                )
            print(result.output)
            print(result.usage)
            print(runtime.last_report)


asyncio.run(main())
```

This application snippet makes an ordinary provider call when run with your
credentials. The conformance command below uses local fixtures and no hosted
inference. For an Anthropic model, pass your existing `AnthropicModel` to the
same `build_agent` function. Keep the application’s native client lifecycle.
`agent.run_sync`, `agent.run`, `agent.run_stream_sync`, and `agent.run_stream`
all use the same capability. Typed `NativeOutput` responses keep their native
schema and recovery-free transformations.

To add this to an existing Agent constructor directly:

```python
import functools
from caveman_middleware.pydantic_ai import CavemanCapability, scope_from_run

capability = CavemanCapability(
    runtime=runtime,
    scope=functools.partial(scope_from_run, namespace="my-application"),
)
# Include capability in your existing Agent(..., capabilities=[..., capability]).
```

The capability wraps the model selected for each request, including ordinary
tool continuations and Anthropic suspended-response continuations. Existing
capabilities, dependency objects, usage limits, tool validation, and original
content guardrails still run in Pydantic AI. The native recovery tool contains
only a handle, offset, limit, and optional query. The adapter checks the current
prepared tool’s actual source toolset, validator, function, and schema before
allowing lossy output. Fake tools, name collisions, filtered or approval-gated
tools, forced choices, and structured output cannot authorize lossiness.

Original `ModelRequest`, `ModelResponse`, `ToolReturnPart`, and retry history
remain available through `all_messages()` and `all_messages_json()`. Only the
provider view has replaced text. Reasoning/signatures, tool arguments, failure
parts, metadata, and non-string tool-return contracts remain native.
[ProcessHistory replaces stored run history](https://pydantic.dev/docs/ai/capabilities/process-history/),
so this adapter uses the public model delegate instead of registering a history
processor. Existing history processors remain in their original order.

## Scope, diagnostics, and model-only use

`scope_from_run` binds native `conversation_id` plus the application’s trusted
`caveman_branch_id` and `caveman_cache_epoch` run metadata. Runtime credentials
establish access authority; conversation names partition state. Reinstall the
capability when reconstructing an Agent after serialization. Runtime connections
and recovery executors are not serialized into native message history.

```python
from caveman_cloud.middleware import Scope
from caveman_middleware.pydantic_ai import with_caveman_model

wrapped = with_caveman_model(
    existing_model, runtime=runtime,
    scope=Scope("my-application", "conversation-17"),
)
response = await wrapped.request(messages, model_settings, model_request_parameters)
```

Model-only callers have no recovery executor. Lossy candidates report
`recovery_unavailable`. `mode="off"` sends no content to the optimizer;
`mode="record"` returns no replacements. Runtime outages preserve original
input. Supply `on_diagnostic=callback` to `MiddlewareRuntime` for runtime
outcomes. The caller closes the shared runtime and its provider clients.

Selected text is sent to the configured optimizer. Remote content requires
HTTPS and explicit `allow_remote_content=True`. This adapter sees typed native
messages, not final serialized provider bytes. Its estimates do not prove
provider cost savings. OpenAI Responses, other provider classes, custom model
subclasses, routing containers, and native compaction stay opaque to this
adapter until separately tested; their native model calls pass through.

## Local proof and remaining limits

```sh
CAVEMAN_MIDDLEWARE_TEST_FAMILY=pydantic-ai \
CAVEMAN_MIDDLEWARE_TEST_PYTHON="$(python3 -c 'import tempfile; print(tempfile.gettempdir()+"/caveman-middleware-pydantic-ai-venv/bin/python")')" \
CAVEMAN_MIDDLEWARE_TEST_BINARY=/path/to/caveman-proxy \
node --test packages/middleware/conformance/python-framework.test.mjs
```

The 17-test suite uses the real installed Agent and provider SDKs, local HTTP capture,
and a development Go runtime. Its forced recovery checks a fact absent from the
compressed view, exact recovered Unicode/CRLF bytes, native typed history,
dependencies, retries, usage, provider options, and first content before EOF.
It also exercises sync/async cancellation, early close, scope concurrency,
nested ownership, serialized-history resume, and guardrail denial during outage.

`compatibility.json` records the supported cases and exact limits. A thinking-only
Anthropic `pause_turn` followed by recovery completes through both `run` and
`run_stream`: four provider requests, four optimization plans, exact recovery,
preserved thinking signature, and 80 observed output tokens. Pydantic AI counts
the suspended chain as one logical request, so the run records three requests.

`continuation-evidence.json` also retains an upstream streaming limitation. When
the suspended segment contains visible text and its continuation requests a
tool, both native and wrapped `run_stream` execute that tool but return the
earlier text without requesting a final answer using its result. Native and
wrapped nonstreaming runs complete. The middleware preserves this behavior; it
does not replace Pydantic AI's run loop. Fresh fixture responses have unique
message IDs, so the test models new continuation requests rather than polling
an existing background job.

The lifecycle probes compare context exit, `stream.cancel()`, and active task
cancellation across both providers, native and wrapped. All 36 cases on each
tested HTTP stack observe socket EOF within 200 ms, before client close or
fixture release. Middleware cancellation receipts retain absent usage as null.
Both httpcore2 2.12.0 and 2.7.0 still intermittently raise
`RuntimeError: generator didn't stop after athrow()` during async-generator
shutdown, including unwrapped baselines. `lifecycle-evidence.json` and
`lifecycle-httpx27-evidence.json` retain the individual observations and traceback
locations. Socket closure is verified; clean generator shutdown remains an
upstream limitation.

Keep the current provider and HTTP pins. Pydantic AI 2.42.0 requires
OpenAI >=3.8.0, Anthropic >=1.3.0, and httpx2 >=2.7. The compatible 2.7 HTTP
comparison did not resolve shutdown warnings. Older OpenAI 2.x and Anthropic
0.x pins cannot satisfy this framework version's declared requirements.

Reproduce the diagnostics against the local runtime:

```sh
export CAVEMAN_MIDDLEWARE_TEST_PYTHON="$(python3 -c 'import tempfile; print(tempfile.gettempdir()+"/caveman-middleware-pydantic-ai-venv/bin/python")')"
export CAVEMAN_MIDDLEWARE_TEST_BINARY=/path/to/caveman-proxy
node examples/middleware/pydantic-ai/run_probes.mjs
```

To include the older compatible HTTP comparison without changing the locked
framework environment:

```sh
uv pip install --target /tmp/caveman-pydantic-httpx27 --no-deps 'httpx2==2.7.0' 'httpcore2==2.7.0'
CAVEMAN_MIDDLEWARE_TEST_HTTPX27_OVERLAY=/tmp/caveman-pydantic-httpx27 \
  node examples/middleware/pydantic-ai/run_probes.mjs
```

Hosted providers, native Windows, packaged-wheel installation, and cost
comparisons need separate evidence.

`on_report=lambda report: print(report.status, report.reason)` receives one
immutable metadata report per native model invocation, including off and
unsupported calls. Applied counts are emitted only after the native message
view and current recovery registration are checked. `runtime.last_report`
retains the latest value across calls using that runtime; it is `None` before
the first report and is not a per-run history. Reporting does not perform
network I/O.

The exact F14 matrix has 40 cells. Configure the locked environment, a freshly
built runtime and its `CAVEMAN_MIDDLEWARE_RUNTIME_PROVENANCE` build manifest,
then run `node examples/middleware/pydantic-ai/certify.mjs --replay`. The command
captures eight observations per cell and repeats them in a fresh process.
`certification/python/` contains source hashes, raw TAP and candidate coverage;
the command does not promote the shared support inventory.
