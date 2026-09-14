# AutoGen middleware

The adapter wraps an existing AutoGen `ChatCompletionClient` and adds recovery
to its native workbench. AutoGen still executes tools, streams events, stores
original history, and decides when its tool loop stops.

The tested versions are AutoGen Core, AgentChat, and Extensions **0.7.5**,
OpenAI **2.54.0**, and Anthropic **0.125.0**. AutoGen 0.7.5 unconditionally passes
`temperature` to Anthropic; Anthropic 1.4.0 removed that argument and fails even
without middleware. The AutoGen extra therefore pins its compatible SDK.

Install the built middleware wheel with its `autogen` extra and the built SDK
wheel. The local conformance setup uses the same exact versions:

```sh
python packages/middleware/conformance/python-environment.py autogen
```

The core SDK has no AutoGen dependency. Importing this adapter without its
dependencies gives an instruction to install `caveman-middleware[autogen]`.

## Existing client and complete tool loop

Use your application's existing provider client, source function, and stable
session ID. The runtime must already be running. A model wrapper by itself is
recovery-free; the workbench provides the actual recovery executor.

```python
from autogen_agentchat.agents import AssistantAgent
from autogen_core.tools import FunctionTool, StaticStreamWorkbench
from caveman_cloud.middleware import MiddlewareRuntime, Scope
from caveman_middleware.autogen import with_caveman_agent


async def run(existing_client, read_source, session_id):
    reports = []
    with MiddlewareRuntime(
        endpoint="http://127.0.0.1:8787",
        on_report=reports.append,
    ) as runtime:
        workbench = StaticStreamWorkbench([
            FunctionTool(read_source, "Read the original source")
        ])
        options = with_caveman_agent(
            {
                "name": "reader",
                "model_client": existing_client,
                "workbench": workbench,
                "max_tool_iterations": 4,
                "model_client_stream": True,
            },
            runtime=runtime,
            scope=Scope("my-application", session_id),
        )
        agent = AssistantAgent(**options)
        try:
            async with options["workbench"]:
                async for event in agent.run_stream(
                    task="Read the source and recover the exact requested detail"
                ):
                    print(event)
        finally:
            await options["model_client"].close()
```

The same options work with `await agent.run(...)`. AutoGen's model interface is
asynchronous; it has no blocking `create` method. Existing tools, workbench
lists, provider configuration, and tool iteration limits remain native. The
example chooses four tool iterations explicitly; the adapter never changes
that limit. `mode="off"` uses a passive model delegate, preserves the caller's
options and tools, and emits one `disabled` report per native model invocation
without optimizer requests or receipts. `mode="record"` adds no recovery tool
and releases no replacement. Reports contain immutable status, reason, transform
IDs, and counts; they contain no original content. `runtime.last_report` retains
only the most recent report. A sink failure does not change native results.

For direct model callers, use `with_caveman_model(existing_client, runtime=...,
scope=...)`. It returns native `CreateResult` values and delegates token counts,
usage, streaming options, and `close`. Without a paired `CavemanWorkbench`,
lossy candidates receive `recovery_unavailable`. A copied recovery schema, a
different session's workbench, and a colliding tool name cannot enable lossiness.

The recovery schema is stable and strict so OpenAI's native structured-output
helper accepts it. Typed output and forced tool choices use recovery-free
transformations. Source tool arguments/results and model context remain
original; only the provider-facing copy of successful text results can change.
Recovered content and tool errors are protected from compression.

AutoGen 0.7.5 rejects Anthropic typed output with
`ValueError: Structured output is currently not supported for Anthropic models`
before provider dispatch. The wrapped client preserves that native rejection;
its conformance case proves error parity, not successful Anthropic typed generation.

## Persistence and configuration

Keep the same `Scope` while appending history. Use separate session or branch
identities for independent agents and branches. Save and load AutoGen's normal
state. Recovery originals and chosen replacements live in the configured
Engine store; preserving that store allows recovery after an Engine restart.

Native component dumps include the original provider component, scope, and an
application-owned runtime reference key. They do not contain runtime credentials
or grant identifiers. Rebind the runtime explicitly when loading a component:

```python
from autogen_agentchat.agents import AssistantAgent
from autogen_core.models import ChatCompletionClient
from caveman_middleware.autogen import component_runtimes

with component_runtimes({"default": runtime}) as loaded_components:
    restored_agent = AssistantAgent.load_component(saved_component)

await restored_agent.load_state(saved_state)
result = await restored_agent.run(task="Continue the existing conversation")

for component in loaded_components:
    if isinstance(component, ChatCompletionClient):
        await component.close()
    else:
        await component.stop()
```

The list exposes loaded delegates for application lifecycle cleanup because
AutoGen's `AssistantAgent` does not expose its nested model client publicly.
AutoGen's existing trust requirements for loading executable `FunctionTool`
configurations still apply. Runtime keys alone confer no recovery access.
AutoGen's `FunctionTool` can load its serialized source, but a second dump of
that loaded function raises its native `OSError: could not get source code`.
The wrapper preserves that behavior; retain the original saved component for
repeated configuration loading.

## Local proof and limits

Run the installed-framework conformance suite with a freshly built Engine:

```sh
CAVEMAN_MIDDLEWARE_TEST_FAMILY=autogen \
CAVEMAN_MIDDLEWARE_TEST_PYTHON=/absolute/path/to/autogen-venv/bin/python \
CAVEMAN_MIDDLEWARE_TEST_BINARY=/absolute/path/to/caveman-proxy \
node --test packages/middleware/conformance/python-framework.test.mjs
```

The tests use real installed AutoGen/provider clients, local OpenAI and Anthropic
HTTP servers, and the real compression service. They force source compression,
ask for an omitted fact, execute recovery in AutoGen's workbench, and verify
exact Unicode/CRLF bytes and the final answer. Off/outage, streaming, native
tool progress, parallel tool results, collisions, typed output, usage, token
helpers, component loading, cancellation, team contexts, and twenty append-only
turns across restart have separate assertions. Normal asyncio settings are used
with the unchanged default 100 ms optimization deadline.

Only selected tool-result text is sent to the runtime; provider credentials and
unselected instructions are excluded. Remote content transfer needs an explicit
HTTPS endpoint and `allow_remote_content=True`. A shared runtime bearer is shared
authority, so use separate runtimes or authenticated principals across trust
boundaries. The application owns runtime shutdown and retention settings.

This is local conformance, with no paid inference or savings certification.
The model delegate cannot observe hidden native client retries or final provider
serialization in a production call. The fixture separately captures provider
HTTP requests; receipt visibility remains `client_observed_sdk`. AutoGen replaces
missing stream usage with zero defaults; those native values are returned intact,
but Caveman records usage as unknown. Cached native results are not booked as
new provider usage.

The AutoGen extra pins OpenAI 2.54.0 because its native and wrapped stream
finalization probes both close cleanly. OpenAI 3.10.0/httpcore2 was rejected after
the unwrapped native client reproduced `generator didn't stop after athrow()`
during interrupted-stream finalization. `probe_lifecycle.py` and the compatibility
evidence retain both outcomes. Native Windows, live provider calls, packaged
cross-platform consumers, and shared sustained performance/soak gates need
separate evidence.

Native contracts: [ChatCompletionClient](https://microsoft.github.io/autogen/stable/reference/python/autogen_core.models.html),
[AutoGen tools and workbenches](https://microsoft.github.io/autogen/stable/reference/python/autogen_core.tools.html),
[Anthropic 0.125.0 distribution](https://pypi.org/project/anthropic/0.125.0/).
