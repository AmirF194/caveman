# MCP host adapter

Caveman can shorten text from MCP tools in the model's request while your host
keeps the original `CallToolResult`. The native MCP client still owns discovery,
authentication, JSON-RPC IDs, progress, cancellation and transport lifetime.

This package adds no MCP server. It uses the existing local Caveman runtime for
Engine compression and scoped recovery. The repository's existing Caveman MCP
server continues to own its `caveman_*` tools; their results are passed through.

## Python

Install `caveman-middleware[mcp]`. Use an existing, connected MCP 2.2.0 client:

```python
from caveman_cloud.middleware import AsyncMiddlewareRuntime, Scope
from caveman_middleware.mcp import CavemanMCPHost, bind_mcp_tool

runtime = AsyncMiddlewareRuntime(endpoint="http://127.0.0.1:8787")
host = CavemanMCPHost(
    runtime=runtime,
    scope=Scope(namespace="my-app", session_id="session-123", branch_id="main"),
    server_id="my-existing-server",
    protocol_version=client.protocol_version,
)
bindings = [bind_mcp_tool(client, tool) for tool in (await client.list_tools()).tools]
registered = host.register(bindings)
```

Register each returned definition **and its executor** in the host's actual
tool loop. Immediately before a provider call, pass original results through
`host.project_result(..., registered_tools=registered)` and use those copied
views in that request. A schema without the unchanged executable binding does
not authorize lossy compression. Name collisions retain the original tool.

[example.py](example.py) is a complete application-owned text-tool loop for
existing OpenAI or Anthropic clients, with optional native streaming. It retains
original results and provider history on every continuation. It does not map
arbitrary MCP media into provider formats; that mapping remains application code.

When persisting Python MCP values, use
`result.model_dump_json(by_alias=True, exclude_unset=True)` and restore with
`CallToolResult.model_validate_json(...)`. This preserves absent fields.
Explicit `structuredContent: null` is protected, like other structured content.

## TypeScript

Install `@caveman-ai/middleware`, `@caveman-ai/sdk`, and
`@modelcontextprotocol/sdk@1.30.0`. Import the host adapter from
`@caveman-ai/middleware/mcp`:

```typescript
import { CavemanMCPHost, bindMCPTool } from '@caveman-ai/middleware/mcp';

const host = new CavemanMCPHost({
  runtime,
  scope: { namespace: 'my-app', session_id: 'session-123', branch_id: 'main', cache_epoch: '0' },
  serverId: 'my-existing-server',
  protocolVersion: negotiatedProtocolVersion,
});
const registered = host.register((await client.listTools()).tools.map(tool => bindMCPTool(client, tool)));
```

Use the actual negotiated protocol version. The native HTTP transport exposes
`protocolVersion`; a stdio transport can observe the public
`setProtocolVersion(version)` callback during `Client.connect`, as shown in
[_client.mjs](_client.mjs). [example.mjs](example.mjs) runs the complete text-tool
loop and preserves original history.

Both APIs require the host's append-only original context manifest for each
projection. Reuse it across continuation and resume. A deliberate history edit
needs a new `cache_epoch`. Derive scope and server identity from trusted
application state, not tool arguments or provider output.

## Preserved boundaries

- Text views retain block ordering, annotations, metadata and original objects.
  Media, embedded resources, links and user-only text blocks are unchanged.
- Errors, output-schema results, structured content and incomplete result types
  are protected. Only successful, unstructured, assistant-visible text qualifies.
- Recovery executes locally through the scoped runtime binding. It never makes
  an extra outbound MCP `tools/call` or changes a remote server's tool inventory.
- `off`, `record`, unavailable runtime, missing executor and recovery collisions
  retain original content. Off mode registers no recovery tool.
- The result boundary cannot observe provider serialization, attempts, usage or
  cache hits. It reports prepared segment estimates; it makes no provider wire
  or actual token savings claim. The host owns provider retries and streaming.

## Native conformance

Build the existing binaries, then run the locked examples:

```sh
node packages/middleware/conformance/support/runtime-build.mjs --target=proxy --output=/tmp/caveman-mcp-proof-proxy
node packages/middleware/conformance/support/runtime-build.mjs --target=mcp --output=/tmp/caveman-mcp-proof-server
python3 packages/middleware/conformance/python-environment.py mcp
pnpm --filter @caveman-ai/sdk build
pnpm --filter @caveman-ai/middleware build
npm ci --prefix examples/middleware/mcp --ignore-scripts
export CAVEMAN_MIDDLEWARE_TEST_BINARY=/tmp/caveman-mcp-proof-proxy/caveman-proxy
export CAVEMAN_MIDDLEWARE_RUNTIME_PROVENANCE=/tmp/caveman-mcp-proof-proxy/build.json
export CAVEMAN_MCP_TEST_BINARY=/tmp/caveman-mcp-proof-server/caveman-mcp
export CAVEMAN_MCP_RUNTIME_PROVENANCE=/tmp/caveman-mcp-proof-server/build.json
# Use the exact Python path printed by python-environment.py.
export CAVEMAN_MIDDLEWARE_TEST_PYTHON=/path/printed/by/environment/script/bin/python
CAVEMAN_MIDDLEWARE_TEST_FAMILY=mcp node --test packages/middleware/conformance/python-framework.test.mjs
node --test examples/middleware/mcp/conformance.test.mjs
node examples/middleware/mcp/certify.mjs --language=typescript --output=examples/middleware/mcp/certification/typescript-new --replay
node examples/middleware/mcp/certify.mjs --language=python --output=examples/middleware/mcp/certification/python-new --replay
```

Use new, empty output directories. The build helper records the actual Go input
closure before and after compilation. Capture and fresh-process replay reject
changed source, locks, test declarations, or binaries.

Nineteen TypeScript tests and nine Python methods cover native stdio and authenticated Streamable HTTP,
OpenAI and Anthropic generation and streams, exact Unicode/CRLF recovery,
off/record/outage provider journeys, mixed resources and media, native progress
and cancellation, 20 turns with two Engine restarts, 100 interleaved scopes,
forged executors, cross-scope denial, and the existing Caveman MCP server.
The exact certification matrix contains 11 operations per language and eight
required observations per operation. Each run also checks immutable callback
reports and counts against the actual returned projection. Structured results
retain original content without recovery. Existing server tools continue to use
the server's own compression and recovery executor in every host mode.

The candidate artifacts and their 176 replayed assertions do not promote the
global support inventory by themselves. The separate inventory gate verifies
their freshness together with packaging and acceptance evidence.

The pinned Python client negotiates `2026-07-28` with its fixture. The pinned
TypeScript client negotiates `2025-11-25`. The existing Go MCP server negotiates
`2024-11-05`. These are separate interoperability cases, not an assertion that
every protocol version is supported. All providers are local protocol fixtures;
hosted model validation and provider billing evidence remain separate gates.
