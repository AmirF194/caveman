# Native Strands examples

The fixtures invoke the installed Strands agent, model, tool registry, provider
clients, streaming parsers, and session APIs. They use the real local Caveman
Engine with its default 100 ms optimization budget. Local HTTP providers supply
OpenAI Chat Completions, Anthropic Messages, and signed Bedrock Converse streams.

The exact F09 matrix contains 27 Python cells and 21 TypeScript cells. Every
operation runs with compression enabled, off, and an unavailable runtime. The
checks retain original tool results, request recovery of a detail absent from
the compressed view, execute the native recovery tool, and compare byte-exact
Unicode and CRLF content. They also check provider call counts, native hooks,
immutable callback reports, and report counts against the actual provider view.

Python covers `Agent.__call__`, `invoke_async`, `stream_async`, `Model.stream`,
`Model.structured_output`, concurrent tools, resumed history, hook continuations,
and cancellation/close behavior. TypeScript covers `Agent.invoke`, `Agent.stream`,
typed output, concurrent tools, native snapshots, hook continuations, and
cancellation/close behavior. Its catalog label `model.structured_output` means
the actual public `Agent.invoke(prompt, { structuredOutputSchema })` path through
`Model.stream`; Strands TypeScript has no literal `Model.structured_output`
method. Forced structured output remains recovery-free in both languages.

Run from the repository root with Node 22.13 or later and Python 3.13 or later:

```sh
node packages/middleware/conformance/support/runtime-build.mjs --target=proxy --output=/tmp/caveman-strands-runtime
python3 packages/middleware/conformance/python-environment.py strands
pnpm --filter @caveman-ai/sdk build
pnpm --filter @caveman-ai/middleware build
npm ci --prefix examples/middleware/strands --ignore-scripts
export CAVEMAN_MIDDLEWARE_TEST_BINARY=/tmp/caveman-strands-runtime/caveman-proxy
export CAVEMAN_MIDDLEWARE_RUNTIME_PROVENANCE=/tmp/caveman-strands-runtime/build.json
# Use the exact Python path printed by python-environment.py.
export CAVEMAN_MIDDLEWARE_TEST_PYTHON=/path/printed/by/environment/script/bin/python
CAVEMAN_MIDDLEWARE_TEST_FAMILY=strands node --test packages/middleware/conformance/python-framework.test.mjs
node --test examples/middleware/strands/conformance.test.mjs
node examples/middleware/strands/certify.mjs --language=python --output=examples/middleware/strands/certification/python-new --replay
node examples/middleware/strands/certify.mjs --language=typescript --output=examples/middleware/strands/certification/typescript-new --replay --allow-known-upstream-blocker
```

Use new empty capture directories. Native capture binds test declarations,
installed versions, locks, source files, and the actual Go build closure to raw
output. Independent replay starts new processes and compares all eight required
observations for each backed cell. Evidence copies normalize opaque recovery
handles and native message tracking identifiers. Python also validates and
normalizes native first-byte timing metadata. The original history and real
recovery handle relationships are checked before normalization.

Current limitations are explicit:

- `@strands-agents/sdk@1.17.0` loses the first tool in the tested legal OpenAI
  parallel tool stream. The bounded unwrapped/native and middleware controls
  reproduce the same loss. That required cell stays unbacked; the flag above
  permits a partial candidate report and does not mark it complete.
- TypeScript abort closes the tested OpenAI and Bedrock transports before the
  fixture releases EOF. Anthropic does not. Early generator return completes
  but leaves the transport open for all three providers in the tested interval.
- Python cancellation leaves the tested transports open before the fixture
  releases its next chunk. Early `aclose` closes OpenAI and Anthropic; Bedrock remains open
  in the tested interval. These results match unwrapped native controls.
- Python's native event-loop generators emitted OpenTelemetry context-detach
  errors during generator cleanup. The raw diagnostic archive retains them.
  Passing journey assertions does not establish clean resource teardown.

The current diagnostic archive is
[`certification/diagnostics-reporting-v2/summary.json`](certification/diagnostics-reporting-v2/summary.json).
It preserves uncaptured execution output. The Python evidence normalizer changed
after that run. Fresh final capture and independent replay are still required;
older `typescript-reporting-v1` artifacts are historical. None of these local
fixtures proves hosted inference, billing, or global support promotion.
