# LangChain and LangGraph middleware

The adapters retain LangChain's provider models, retrievers, tools, message
classes, and LangGraph scheduler. `with_caveman_agent` / `withCavemanAgent`
register native per-model middleware and a scoped recovery tool. The model-only
wrapper has no recovery executor and therefore remains recovery-free.

`CavemanDocumentCompressor` creates document views for the next model call.
Original retriever documents, IDs, metadata, order, and tool artifacts remain
available to the application. Without a source reader, compression cannot issue
lossy source grants.

## Explicit source expansion

Create a reader for the same runtime and scope, register its executor in your
application's actual reader path, and pass that binding to the compressor.
Booleans, schemas, callbacks, copied bindings, bindings from another runtime, and
bindings from another scope do not authorize lossy document views. The compressor
does not discover or run your application loop.

Python, using an existing native retriever and model:

```python
import copy
import json
from langchain.agents import create_agent
from langchain_core.tools import StructuredTool
from caveman_cloud.middleware import MiddlewareRuntime, Scope
from caveman_middleware.langchain import CavemanDocumentCompressor

runtime = MiddlewareRuntime(endpoint="http://127.0.0.1:8787")
scope = Scope("my-rag-app", "session-42")
reader = runtime.recovery(scope)
compressor = CavemanDocumentCompressor(
    runtime=runtime, scope=scope, source_expansion=reader,
)

def search(query: str):
    originals = retriever.invoke(query)
    views = compressor.compress_documents(originals, query)
    content = json.dumps([
        {"id": d.id, "metadata": d.metadata, "text": d.page_content}
        for d in views
    ])
    return content, originals

def expand(handle: str, offset: int = 0, limit: int = 262144, query: str = ""):
    return json.dumps(reader.execute({
        "handle": handle, "offset": offset, "limit": limit, "query": query,
    }))

search_tool = StructuredTool.from_function(
    search, name="search_documents", description="Search application sources.",
    response_format="content_and_artifact",
)
source_reader = StructuredTool.from_function(
    expand, name=reader.name, description=reader.description,
    args_schema=copy.deepcopy(reader.input_schema),
)
agent = create_agent(model=model, tools=[search_tool, source_reader])
# Keep runtime alive while the agent runs; runtime.close() releases its resources.
```

For async Python, use `runtime.as_async().recovery(scope)`, await
`retriever.ainvoke`, `compressor.acompress_documents`, and `reader.execute`, and
register the async functions with `StructuredTool.from_function(coroutine=...)`.
The [native tests](test_source_expansion.py) include complete sync and async
applications for `ChatOpenAI` and `ChatAnthropic`.

TypeScript uses the same application contract:

```typescript
const reader = runtime.recovery(scope);
const compressor = new CavemanDocumentCompressor({
  runtime, scope, sourceExpansion: reader,
});
const search = tool(async ({ query }, config) => {
  const originals = await retriever.invoke(query, config);
  const views = await compressor.compressDocuments(originals, query);
  return [JSON.stringify(views.map(d => ({
    id: d.id, metadata: d.metadata, text: d.pageContent,
  }))), originals];
}, {
  name: "search_documents", description: "Search application sources.",
  responseFormat: "content_and_artifact",
  schema: { type: "object", properties: { query: { type: "string" } },
            required: ["query"], additionalProperties: false },
});
const sourceReader = tool(async (args, config) =>
  JSON.stringify(await reader.execute(args, { signal: config?.signal })), {
    name: reader.name, description: reader.description,
    schema: structuredClone(reader.inputSchema),
  });
const agent = createAgent({ model, tools: [search, sourceReader] });
```

Recovery pages include `source_id`, `original_sha256`, byte offsets, and exact
source text. Follow `next_offset` with `query` omitted until it is `null` to read
the full source. Query responses are labeled excerpts. A handle from another
scope returns the typed `not_found` error. Duplicate text in different source
documents retains different handles and source IDs. Give documents stable IDs
to carry their identities across queries; documents without IDs use their batch
position as the source identity.

Native recovery tools have mutable public fields. Agent middleware rechecks the
tool name, description, full schema, executor, public call methods, and return
behavior before allowing a lossy provider view. Changing a tool's contract makes
that request recovery-free. Native schema validation uses an independent copy of
the SDK schema.

The runtime's optional `onReport` callback in TypeScript or `on_report` in Python
receives one immutable metadata report per native model call. Document
compressors report after applying the returned view. `lastReport` and
`last_report` retain the latest report. Applied and reused counts describe actual
replacement plans; disabled and skipped calls report without optimizer I/O.
Passive delegates leave the original model unchanged, and callback failures do
not alter native results or exceptions. Reports contain no source text.

## Local proof

Install the pinned example dependencies and build the TypeScript middleware.
Use a freshly built Caveman proxy and the locked Python LangChain environment:

```sh
CAVEMAN_MIDDLEWARE_TEST_BINARY=/path/to/caveman-proxy \
  node --test examples/middleware/langchain/conformance.test.mjs

CAVEMAN_MIDDLEWARE_TEST_BINARY=/path/to/caveman-proxy \
CAVEMAN_MIDDLEWARE_TEST_FAMILY=langchain \
CAVEMAN_MIDDLEWARE_TEST_PYTHON=/path/to/langchain-venv/bin/python \
  node --test packages/middleware/conformance/python-framework.test.mjs
```

The exact-operation fixture contains all 60 LangChain cells and 42 LangGraph
cells, across Python and TypeScript and both providers. Each cell executes its
own operation with compression enabled, disabled, and unavailable. The model
and default document-compressor paths explicitly report that recovery is absent;
their original provider requests match both controls. Agent and application RAG
paths execute the actual registered source reader.

Generate a separate input snapshot, native TAP run, candidate record for each
cell, and independent process replay for each family and language:

```sh
export CAVEMAN_MIDDLEWARE_TEST_BINARY=/path/to/caveman-proxy
export CAVEMAN_MIDDLEWARE_RUNTIME_PROVENANCE=/path/to/runtime-build/build.json
export CAVEMAN_MIDDLEWARE_TEST_PYTHON=/path/to/langchain-venv/bin/python
export CAVEMAN_MIDDLEWARE_CERT_OUTPUT_SUFFIX=reporting-v2
node examples/middleware/langchain/certify.mjs F05 python --replay
node examples/middleware/langchain/certify.mjs F05 typescript --replay
node examples/middleware/langchain/certify.mjs F06 python --replay
node examples/middleware/langchain/certify.mjs F06 typescript --replay
```

Records go into the four family/language directories under
`certification/reporting-v2`. The suffix preserves previous runs. Build the
runtime and its provenance together with
`node packages/middleware/conformance/support/runtime-build.mjs --output=/absolute/output/path`.
Assembly rejects missing assertions, failed tests, changed
sources or dependency locks, and a changed runtime binary. Replay requires a
fresh process nonce and the same eight observations for every candidate. These
files are candidate evidence; the shared support ledger is promoted separately.

The tests use installed frameworks and provider SDKs against loopback HTTP,
with the real Engine and CCR store. They verify exact UTF-8 recovery, original
checkpoint history, Engine restart, source edits through native reducers,
branch isolation, approval interrupts, overlapping native tool calls,
independent batch scopes, callbacks, and first text before provider completion.
The earlier `proof/` and `evidence.json` files retain the initial source-expansion
run. Local fixture evidence does not establish paid-provider quality, savings,
or native stream cancellation cleanup.
