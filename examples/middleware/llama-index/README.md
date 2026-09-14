# LlamaIndex middleware

Use your existing LlamaIndex model, source tools, and index. Caveman prepares
separate model-facing text views; LlamaIndex retains the tool loop, provider
clients, native responses, conversation memory, source nodes, and retries.

The tested dependency set is `llama-index-core==0.14.24`,
`llama-index-llms-openai==0.8.1`, `llama-index-llms-anthropic==0.12.0`,
`openai==2.54.0`, and `anthropic==0.125.0`. The last pin matters: the unwrapped
Anthropic integration sends a `temperature` argument removed by Anthropic 1.4.0.
The native failure is recorded in `compatibility.json`.

Install the built SDK and middleware wheels with the LlamaIndex extra:

```sh
python -m pip install 'caveman-middleware[llama-index]==0.1.0'
```

The packages are under development; this command describes the consumer
interface and does not claim that a release has been published. The local
conformance environment is reproducible from `requirements.lock`:

```sh
python3 packages/middleware/conformance/python-environment.py llama-index
```

## Existing model and native agent

`CavemanFunctionAgent` extends native `FunctionAgent`. Pass the same model,
tools, and agent options that your application already uses:

```python
import asyncio
import os
from pathlib import Path

from caveman_cloud.middleware import MiddlewareRuntime
from llama_index.llms.openai import OpenAI
from example import build_agent


def read_logs(path: str) -> str:
    """Read an application-approved diagnostic log."""
    if path != "diagnostics.log":
        raise ValueError("Unknown diagnostic source")
    with Path(path).open(encoding="utf-8", newline="") as source:
        return source.read()


async def main():
    llm = OpenAI(model=os.environ["OPENAI_MODEL"])
    with MiddlewareRuntime(
        endpoint=os.environ["CAVEMAN_MIDDLEWARE_ENDPOINT"],
        on_diagnostic=lambda event: print(event["code"]),
        on_report=lambda report: print(report.status, report.reason),
    ) as runtime:
        agent = build_agent(
            llm, runtime, namespace="my-application",
            session_id="investigation-17", read_logs=read_logs,
        )
        result = await agent.run("Inspect diagnostics.log and find the exact detail")
        print(result.response.content)
        print(runtime.last_report)


asyncio.run(main())
```

This application snippet uses your configured provider when run. The local
conformance suite below uses HTTP fixtures and never calls a hosted model.
Pass an existing native `Anthropic` model through the same interface. Keep your
application's provider client lifecycle and close the shared Caveman runtime
at shutdown. Start a separately configured local Caveman runtime before use;
the test launcher starts its own development binary.

The native agent registers `caveman_retrieve` before its first model call.
Lossiness requires that exact callable, schema, scope, and runtime to remain
in the actual tool registry. A matching schema alone, a name collision, a forced
tool choice, a changed provider body, or structured output cannot grant recovery.
Only successful tool results are eligible. Native error results remain exact.

Recovery returns exact original UTF-8 text and its original tool-call identity.
Pages expose their total length and continuation; search results are excerpts.
Recovery outputs never enter compression recursively. Original tool outputs
and native memory stay available to application code. Native `stream_events()`
continues to emit tool requests, tool results, text deltas, and final output.
`FunctionAgent` has an async workflow API; it does not expose a separate sync
agent loop. The public LLM methods retain native sync and async APIs.

## Model-only and RAG use

```python
from caveman_cloud.middleware import Scope
from caveman_middleware.llama_index import (
    CavemanNodePostprocessor,
    with_caveman_model,
)

scope = Scope("my-application", "query-17")
llm = with_caveman_model(existing_llm, runtime=runtime, scope=scope)
engine = index.as_query_engine(
    llm=llm,
    node_postprocessors=[CavemanNodePostprocessor(runtime=runtime, scope=scope)],
    streaming=True,
)
response = engine.query("Find the cited detail")
```

Neither a standalone LLM delegate nor an ordinary answer synthesizer can execute
recovery. They only permit transforms explicitly advertised as recovery-free.
The current runtime's lossy log transform therefore leaves RAG text unchanged
and reports `recovery_unavailable` unless the application installs a source
reader. `source_reader.py` provides an application example based on native
`BaseSynthesizer` and `FunctionTool`:

```python
from source_reader import SourceExpansionSynthesizer

reader = runtime.recovery(scope)
processor = CavemanNodePostprocessor(
    runtime=runtime, scope=scope, source_expansion=reader,
)
synthesizer = SourceExpansionSynthesizer(
    llm=existing_llm, source_expansion=reader, streaming=True,
)
engine = index.as_query_engine(
    node_postprocessors=[processor], response_synthesizer=synthesizer,
)
```

The application must install that exact binding's `execute` callable before
passing it to the postprocessor. A schema or foreign binding cannot enable
recovery. The adapter checks the reader, runtime and scope again after
optimization. If they changed, the native query receives original nodes.
For async-only runtimes, use `runtime.as_async().recovery(scope)` and the native
async query or synthesis methods.

An existing application that already schedules LLM tool calls can instead use
`with_caveman_tools(existing_llm, runtime=runtime, scope=scope, tools=tools)`.
Pass its immutable `tools` tuple to `bundle.model.chat_with_tools` or the native
async/streaming equivalent, parse `ToolSelection` with the native model, and
dispatch through `bundle.execute` or `bundle.aexecute`. Store the original
native `ToolOutput` in history. The bundle does not schedule model calls.

The postprocessor preserves selection order, scores, IDs, metadata, relationships,
and indexed/cached originals. Nodes with character offsets or citation metadata
are protected. Unknown node subclasses pass through. Native citation query
engines still create their own citation chunks and IDs; Caveman does not assign
original offsets to shortened text. Repeated queries do not modify the index.

`chat`, `achat`, their streaming variants, `chat_with_tools`, completion helpers,
and native structured-output helpers remain LlamaIndex operations. Model-only
history with no verifiable tool-success status is conservative; it does not
guess that error text is a successful tool result. Structured generation keeps
its native output schema. Unsupported provider classes pass through unchanged;
the adapter does not translate them into OpenAI or Anthropic messages.

Use a stable `Scope` for each conversation. Its branch and cache epoch belong
to the application. An agent scope resolver may read trusted native `Context`
state; it must return the same scope for model calls and recovery tools. When
restoring serialized native context, reconstruct the adapter with the same
scope and runtime configuration. Runtime credentials establish authority;
conversation names alone do not grant access.

`mode="off"` sends no content to the optimizer. `mode="record"` emits no
replacements. Runtime outage preserves original input; it does not trigger an
extra inference attempt. Selected text is transferred to the configured runtime.
Remote transfer requires HTTPS and explicit `allow_remote_content=True`.

Supply `on_report=lambda report: print(report.status, report.reason)` to the
runtime to observe each selected native call or node-postprocessor invocation.
Reports contain immutable metadata and describe the view actually applied.
Disabled, unsupported, structured-helper and opaque-payload calls report their
original fallback without optimizer I/O. `runtime.last_report` retains the
latest value across calls using that runtime; it is `None` before the first
report and is not a per-run history.

## Local proof

```sh
CAVEMAN_MIDDLEWARE_TEST_FAMILY=llama-index \
CAVEMAN_MIDDLEWARE_TEST_PYTHON="$(python3 -c 'import tempfile; print(tempfile.gettempdir()+"/caveman-middleware-llama-index-venv/bin/python")')" \
CAVEMAN_MIDDLEWARE_TEST_BINARY=/path/to/caveman-proxy \
node --test packages/middleware/conformance/python-framework.test.mjs
```

The suite uses installed LlamaIndex classes, both native provider SDKs, HTTP
request capture, and the real local Engine. It checks a deliberately omitted
fact, native recovery, exact Unicode/CRLF source bytes, tool identity, native
memory, off/outage/record modes, parallel tools, RAG provenance, typed output,
signed thinking, stream forwarding, cancellation, and twenty native turns across
a runtime restart. Evidence is local conformance, not a live-provider result.

The exact F15 matrix has 40 cells. With the locked environment, a freshly built
runtime and its `CAVEMAN_MIDDLEWARE_RUNTIME_PROVENANCE` build manifest configured,
run `node examples/middleware/llama-index/certify.mjs --replay` to capture all
eight observations per cell and repeat them in a fresh process. The generated
`certification/python/` input hashes, TAP and candidate coverage do not promote
the shared support inventory.

The adapter sees native messages before provider serialization. Captured fixture
requests prove the tested serialization paths; they do not prove live provider
cache hits, quality, or billing savings. This lane does not certify hosted
OpenAI/Anthropic, Bedrock/Vertex, native Windows, distribution installation,
the common performance budget, or paid task comparisons. Those gates remain
separate. A development runtime binary is not an installed release artifact.

Two native helper defects remain visible in `native-helper-evidence.json`:
Anthropic typed streaming returns an empty typed value in both the native and
wrapped runs, and `AnthropicCompletionResponse.model_dump()` raises a Pydantic
serializer error. These operations are not certified as successful typed
streaming or response serialization. Ordinary typed generation and public
completion fields pass the native checks.

`probe_lifecycle.py` compares unwrapped and wrapped streams at the server socket.
Both native providers fail to close the socket within 200 ms after generator
`close()`/`aclose()` while the provider is paused. Cancelling an active async
read propagates `CancelledError` and closes the socket in both runs. The adapter
closes the native iterator and records incomplete usage, but full early-close
transport cleanup remains uncertified. See `lifecycle-evidence.json` for exact
observations and resource warnings.
