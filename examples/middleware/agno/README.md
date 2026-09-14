# Agno middleware

This example uses Agno 3.0.9, OpenAI Python 2.54.0, and Anthropic Python 0.125.0.
Agno keeps its own Agent/Team loop, tools, provider clients, retries, and native
responses. Caveman sends selected tool-result text to a separately configured
compression runtime; that runtime does not call the model provider.

Install the built middleware and SDK wheels, then the adapter dependencies:

```sh
python -m pip install 'caveman-middleware[agno]==0.1.0' 'openai==2.54.0' 'anthropic==0.125.0'
```

The package is under development. This command describes the consumer package
interface, not a claim that this version has been published. The hash-locked
local fixture environment is created with
`python3 packages/middleware/conformance/python-environment.py agno` from the
repository root.

## Existing model and native tool loop

Start the local Caveman compression runtime and set
`CAVEMAN_MIDDLEWARE_ENDPOINT` to its explicit endpoint. Selected content can
contain sensitive text. A remote endpoint requires HTTPS and explicit
`allow_remote_content=True`; a shared bearer credential represents shared
authority.

```python
import functools
import os

from agno.agent import Agent
from agno.models.openai import OpenAIChat
from openai import OpenAI
from caveman_cloud.middleware import MiddlewareRuntime
from caveman_middleware.agno import with_caveman_agent, scope_from_run


def read_logs() -> str:
    """Read the complete diagnostic source."""
    with open("diagnostics.log", encoding="utf-8", newline="") as source:
        return source.read()


with OpenAI() as client, MiddlewareRuntime(
    endpoint=os.environ["CAVEMAN_MIDDLEWARE_ENDPOINT"],
    on_report=lambda report: print(report.status, report.reason),
) as runtime:
    model = OpenAIChat(id=os.environ["OPENAI_MODEL"], client=client)
    agent = Agent(**with_caveman_agent(
        {"model": model, "tools": [read_logs], "telemetry": False},
        runtime=runtime,
        scope=functools.partial(scope_from_run, namespace="my-application"),
    ))
    result = agent.run("Read the log and retrieve original details if needed", session_id="investigation-17")
    print(result.content)
    print(runtime.last_report)
```

`with_caveman_agent` also accepts native Team constructor options. A callable
tool factory keeps its native signature. `run`, `arun`, and their `stream=True`
forms use the same registration. Supply the corresponding native async provider
client for async calls, and close it through the application's usual lifecycle.
The caller owns the existing clients and the shared runtime.

Recovery executes through a native `Function`; its model-visible arguments
contain only a handle, offset, limit, and optional query. Runtime identity and
scope stay outside the schema. Native per-run Function copies must retain the
registered entrypoint and schema before lossy compression is enabled. Existing
tool-name collisions, external tools, confirmation gates, forced tool choices,
and structured response formats disable recovery-dependent transformations.
Application tool hooks and guardrails continue to run in Agno.

The request view changes selected native `Message.content` leaves only. Original
tool results and Agent/Team history remain original. Reasoning, signatures,
media, provider data, tool arguments, and native structured response contracts
are retained. Unknown message subclasses, opaque layouts, and Agno's separately
compressed tool results pass through conservatively. Every supplied primary,
reasoning, parser, output, follow-up, and fallback model is delegated; a separate
reasoning Agent should receive its own bundle.

## Model-only callers

```python
from caveman_cloud.middleware import Scope
from caveman_middleware.agno import with_caveman_model

wrapped = with_caveman_model(model, runtime=runtime, scope=Scope("my-application", "session-17"))
response = wrapped.response(messages)
```

Model-only wrapping registers no recovery executor. It remains usable when
recovery is unavailable and does not release unrecoverable lossy replacements.
Use `mode="off"` to transfer no content to the optimizer and keep native
provider input. `mode="record"` produces no replacements.
Optimizer outages preserve original input; provider retry policy stays native.

An optional runtime `on_report` callback receives one metadata report for each
wrapped native provider call, including internal tool continuations. Reports
describe the view passed to the native provider method. Disabled calls and
unsupported input shapes still report their reason without sending content to
the optimizer. `runtime.last_report` retains the latest value across calls
using that runtime. It is `None` before the first report and is not a per-run
history.

`scope_from_run` uses the native session ID and optional trusted
`caveman_branch_id` / `caveman_cache_epoch` metadata. Session names separate
state; runtime credentials establish access authority. Reapply the bundle when
loading a serialized Agent or Team: native model configuration serialization
does not serialize runtime credentials, the connection, or recovery executors.
The delegate sees native Agno messages, not the final provider wire bytes.
Measurements are segment estimates; no verified monetary saving is claimed.

## Local evidence

Run against a freshly built development runtime:

```sh
CAVEMAN_MIDDLEWARE_TEST_FAMILY=agno \
CAVEMAN_MIDDLEWARE_TEST_PYTHON="$(python3 -c 'import tempfile; print(tempfile.gettempdir()+"/caveman-middleware-agno-venv/bin/python")')" \
CAVEMAN_MIDDLEWARE_TEST_BINARY=/path/to/caveman-proxy \
CAVEMAN_MIDDLEWARE_RUNTIME_PROVENANCE=/path/to/build.json \
node --test packages/middleware/conformance/python-framework.test.mjs
```

The fixture uses real installed Agno and real provider SDKs with local HTTP
capture. Its forced tool/recovery journey is deterministic conformance evidence,
not a live provider or economic benchmark. The test deliberately needs a fact
absent from the compressed view, checks exact recovered Unicode/CRLF bytes, and
gates first streamed content independently from completion. Native Windows and
hosted provider certification require separate evidence.

`certification-cells.json` freezes all 28 required Agno operations. The exact
journeys exercise both providers through sync and async Agent runs, streams,
native typed output, Team runs with dynamic tools, an extra internal application
tool continuation, cancellation or closure, and model-only calls. Every cell
compares compression with disabled mode and an unavailable optimizer. Native
tool post-hooks observe the original source object; final history or interrupted
stream events retain the original text. Per-call reports, options, signed
thinking, source recovery, and provider call counts are asserted from execution.

With the same environment variables, generate candidates and independently
replay them with `node examples/middleware/agno/certify.mjs --replay`. The output
under `certification/python/` contains the source and binary hashes, raw TAP,
operation observations, and replay result. Candidate coverage alone does not
promote a public support claim.

`probe_lifecycle.py` compares unwrapped and wrapped model, Agent, and Team
streams against a gated HTTP socket. It records the SDK response's public
`is_closed` state, socket EOF, native iterator closure, cancellation, receipt
usage, and errors emitted during asyncio generator shutdown.

| Async lifecycle operation | OpenAI 2.54.0 | Anthropic 0.125.0 |
| --- | --- | --- |
| Cancel and await a task actively reading the stream | Response and socket close | Response and socket close |
| Close a suspended iterator after its first text event | Iterator closes; response and socket remain open | Iterator, response, and socket close |

These results match native Agno for all three surfaces. Every wrapped
interruption records one cancelled receipt with unknown usage. The compatible
pins remove the generator-shutdown exceptions seen with OpenAI 3.10.0,
Anthropic 1.4.0, and httpcore2 2.12.0; the original dependency lock and failing
controls remain in `compatibility/` and `lifecycle-incompatible-evidence.json`.

OpenAI early-close remains a native limitation. Closing the application's
provider client releases the socket, but the adapter does not own that client.
Agno does not expose its nested SDK response stream at the Model invocation
boundary. Applications that need immediate transport cancellation should cancel
an actively reading task and await it. Iterator closure alone does not establish
that the provider request has stopped.

With the local runtime running and `CAVEMAN_MIDDLEWARE_ENDPOINT` set, run the
lifecycle comparison from the repository root:

```sh
AGNO_PYTHON="$(python3 -c 'import tempfile; print(tempfile.gettempdir()+"/caveman-middleware-agno-venv/bin/python")')"
PYTHONPATH=packages/sdk/python:packages/middleware/python:packages/middleware/conformance:examples/middleware/agno \
  "$AGNO_PYTHON" examples/middleware/agno/probe_lifecycle.py --rounds 3
```

The probe fails on shutdown errors, failed active cancellation, or a wrapper
regression. Add `--require-clean-close` to also fail on the native OpenAI
early-close limitation. `lifecycle-evidence.json` retains that failing strict
gate even when the baseline comparison passes. These local controls do not
certify native Windows, hosted providers, or sustained buffering and memory
budgets.
