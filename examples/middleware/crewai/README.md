# CrewAI middleware

Wrap an existing CrewAI model and keep CrewAI's own crew, task, tool, and human
feedback loops. Successful text tool results can become smaller model-facing
views. The original tool result, cache entry, and message history stay intact.
CrewAI executes `caveman_retrieve` when the model needs omitted source text.

The exact tested dependencies are CrewAI **1.15.20**, LiteLLM **1.100.0**, OpenAI
**2.54.0**, and Anthropic **0.73.0**. Other framework versions return
`unsupported_version`; these results do not certify every CrewAI provider.
Install the built SDK wheel and middleware wheel with its `crewai` extra:

```sh
uv pip install /path/to/caveman_sdk-1.0.0-py3-none-any.whl \
  '/path/to/caveman_middleware-0.1.0-py3-none-any.whl[crewai]'
```

The wheel paths refer to local build artifacts. They are not a claim that this
middleware release is published. Python 3.13 or later is required by this
middleware package; importing its core SDK does not import CrewAI.

## Existing application

Use an application-owned native `LLM` or `BaseLLM`, your existing `BaseTool`
instances, and a stable scope for that agent's conversation. Create the wrapper
before constructing the agent so CrewAI's executor sees its scoped hook.

```python
from crewai import Agent, Crew, Task
from caveman_cloud.middleware import MiddlewareRuntime, Scope
from caveman_middleware.crewai import CavemanLLM, with_caveman_agent


def run(existing_llm, read_source_tool, session_id):
    diagnostics = []
    with MiddlewareRuntime(
        endpoint="http://127.0.0.1:8787",
        on_diagnostic=diagnostics.append,
    ) as runtime:
        options = with_caveman_agent(
            {
                "role": "Source reader",
                "goal": "Answer from the original source",
                "backstory": "Recover exact evidence when needed",
                "llm": existing_llm,
                "tools": [read_source_tool],
                "allow_delegation": False,
                "max_iter": 6,
            },
            runtime=runtime,
            scope=Scope("my-application", session_id),
        )
        agent = Agent(**options)
        task = Task(
            description="Read the source and recover the exact requested detail",
            expected_output="An answer supported by original evidence",
            agent=agent,
        )
        crew = Crew(agents=[agent], tasks=[task])
        try:
            return crew.kickoff()
        finally:
            if isinstance(options["llm"], CavemanLLM):
                options["llm"].close()
```

The result is CrewAI's native `CrewOutput`. `await crew.akickoff()` and
`Crew(..., stream=True)` keep their native return types. The application owns
the native provider client and runtime lifecycle. Close the wrapper after its
calls finish; it unregisters only its own hook and usage listener.

`mode="off"` preserves native calls and sends no content to the optimizer. Its
passive delegate installs no native hooks or recovery tools. `mode="record"`
adds no recovery tool and releases no replacement.
Use `with_caveman_llm(existing_llm, runtime=..., scope=...)` for model-only calls;
without a matching native executor, lossy candidates stay original. An existing
`caveman_retrieve` name is preserved and disables Caveman recovery.

Pass `on_report=callback` to `MiddlewareRuntime` to receive one immutable report
per native provider attempt. `runtime.last_report` retains the latest report.
Reports describe applied or reused replacements, skips, recording, and disabled
calls without source text. Off and unsupported delegates report without
optimizer or receipt I/O. Callback errors do not change native results or
exceptions. Nested LiteLLM callbacks yield to the same owner.

The helper adds recovery only when an existing source tool can produce eligible
content. A tool-free agent retains CrewAI's native typed-response path. Known
forced-tool and provider structured-output settings also disable recovery
registration. CrewAI itself may normalize provider options: its native OpenAI
completion path replaces tool choice with `auto` in this pinned version.
Middleware preserves that upstream behavior and does not reinterpret it.

The public pre-model hook attests the actual executor, agent, and task. It never
rewrites stored messages. Existing original-content policy hooks finish before
the copied model view is prepared. Recovery results, tool errors, typed tool
results, and frozen cache prefixes are protected or reuse an existing choice.

## Local demonstration and proof

From the repository root, build and start the development runtime in one
terminal. Keep its temporary state directory for the life of the example:

```sh
mkdir -p dist
go build -C proxy -o ../dist/caveman-proxy ./cmd/caveman-proxy
CAVEMAN_CREWAI_DEMO_DIR="$(mktemp -d)"
printf 'listen: "127.0.0.1:8787"\nmode: compress\n' > "$CAVEMAN_CREWAI_DEMO_DIR/caveman.yaml"
CAVEMAN_HOME="$CAVEMAN_CREWAI_DEMO_DIR" \
CAVEMAN_CONFIG="$CAVEMAN_CREWAI_DEMO_DIR/caveman.yaml" \
CAVEMAN_AUTH_TOKEN="" dist/caveman-proxy serve
```

In another terminal, run the following demo using the environment with the
built wheels installed. It runs real CrewAI and real provider SDKs against a
deterministic local HTTP server. It makes no paid inference calls:

```sh
python examples/middleware/crewai/demo.py --runtime http://127.0.0.1:8787
python examples/middleware/crewai/demo.py --runtime http://127.0.0.1:8787 --provider anthropic
python examples/middleware/crewai/demo.py --runtime http://127.0.0.1:8787 --mode off
```

With an available optimizer, the fixture needs three provider calls: read the
source, request exact recovery, and answer. Off or outage uses the original
source in two calls. This checks behavior, not model quality or economic savings.
Diagnostics report optimizer bypasses. A remote runtime requires an explicit
HTTPS endpoint and `allow_remote_content=True`; selected tool text may contain
sensitive content. A shared bearer grants shared runtime authority, so isolate
trust boundaries through distinct authenticated principals or separate runtimes.

The hash-locked environment and full native suite can be recreated with:

```sh
python packages/middleware/conformance/python-environment.py crewai
CAVEMAN_MIDDLEWARE_TEST_FAMILY=crewai \
CAVEMAN_MIDDLEWARE_TEST_PYTHON=/absolute/path/to/crewai-venv/bin/python \
CAVEMAN_MIDDLEWARE_TEST_BINARY=/absolute/path/to/fresh-caveman-proxy \
node --test packages/middleware/conformance/python-framework.test.mjs
```

The suite checks OpenAI and Anthropic serialization, exact Unicode/CRLF
recovery, off/outage behavior, original history, native structured output,
concurrent unrelated crews, delegated work, human feedback, parallel tools,
tool cache entries and arguments, first stream events before completion,
provider errors, cancellation, twenty continuations across runtime restart,
and native LiteLLM composition with a single optimizer owner. LiteLLM retains
its inference hop, callback machinery, and native options. The composition
fixture keeps the application's registered callback in CrewAI's public
executor callback list; CrewAI otherwise replaces that list per call.

The exact-operation fixture runs all 28 CrewAI cells with compression, off, and
an unavailable optimizer. It also checks one immutable report per native
provider attempt, with applied and reused counts from actual provider views.
The Anthropic LiteLLM path uses `claude-sonnet-4-20250514`, whose native tool
support is present in the pinned LiteLLM model map.

Build a runtime with provenance, then produce candidates and run independent
native replay:

```sh
node packages/middleware/conformance/support/runtime-build.mjs --output=/absolute/runtime-build
CAVEMAN_MIDDLEWARE_TEST_BINARY=/absolute/runtime-build/caveman-proxy \
CAVEMAN_MIDDLEWARE_RUNTIME_PROVENANCE=/absolute/runtime-build/build.json \
CAVEMAN_MIDDLEWARE_TEST_PYTHON=/absolute/path/to/crewai-venv/bin/python \
CAVEMAN_MIDDLEWARE_CERT_OUTPUT_SUFFIX=reporting-v2 \
node examples/middleware/crewai/certify.mjs --replay
```

Artifacts are written to `certification/reporting-v2`. Input snapshots include
the runtime's actual compiled source closure, installed versions, dependency
locks, and executed test sources. Candidates require eight observed assertions
per cell and a fresh native process replay; the shared support ledger is
promoted separately.

## Explicit limits

CrewAI 1.15.20 defaults to `experimental.AgentExecutor`. Even through
`akickoff`, that executor runs synchronous model calls in a worker. Closing its
async stream cancels the consumer but cannot stop an in-flight synchronous
provider call. The suite reproduces this with native and wrapped models.
The still-public, deprecated `CrewAgentExecutor` invokes `BaseLLM.acall`; its
native async cancellation and recovery are tested separately. The adapter
does not change your executor or add a scheduler. Full default-executor
cancellation and bounded stream buffering remain uncertified.

CrewAI omits completed-call events for LiteLLM tool-call responses and native
Anthropic streamed tool-use responses. Caveman records completed responses
with unknown usage for these paths rather than subtracting shared cumulative
counters. Native stream events may also omit task IDs. Native values remain
unchanged. Production model delegates cannot see final provider bytes or hidden
SDK retries; local HTTP capture supplies serialization evidence only for the
tested fixtures. No provider cache-hit or saved-dollar claim is made.

Keep a distinct stable `Scope` for each agent conversation or branch. Active
wrappers cannot be serialized through `to_config_dict`; rebuild them from the
application's provider configuration and trusted runtime. Automatic crew copies,
checkpoint serialization, live providers, native Windows, clean wheel consumers
on every required platform, and sustained performance/soak budgets need
separate proof. Recovery storage and retention belong to the configured runtime.
