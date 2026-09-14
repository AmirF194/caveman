# Mastra middleware

Before: a large successful text tool result enters every model continuation.
After: the model sees a smaller view and can call `caveman_retrieve` for the
exact original. Your existing Mastra Agent still runs its tools, memory,
processors, retries, and workflows.

The tested versions are `@mastra/core` **1.65.0**, `ai` **7.0.94**,
`@ai-sdk/openai` **4.0.62**, and `@ai-sdk/anthropic` **4.0.50**. The native
provider coverage is OpenAI Chat Completions and Anthropic Messages. Use Node
22.13 or later and install the SDK and middleware packages from local build
artifacts; this example does not imply an npm release has been published.

## Existing Agent

Use `withCavemanMastra` around the Agent your application already owns. Keep
the wrapper for that Agent's lifetime. Read scope fields from authenticated
application context, and keep them stable across a conversation's turns.

```typescript
import type { Agent } from '@mastra/core/agent';
import { createMiddlewareRuntime } from '@caveman-ai/sdk/middleware';
import { withCavemanMastra } from '@caveman-ai/middleware/mastra';

const runtime = createMiddlewareRuntime({
  endpoint: 'http://127.0.0.1:8787',
  onDiagnostic: event => console.info('Caveman:', event.code),
});
await runtime.ready();

export function instrument(existingAgent: Agent) {
  return withCavemanMastra(existingAgent, {
    runtime,
    scope: ({ requestContext }) => {
      const namespace = requestContext?.get('authenticated-namespace');
      const session = requestContext?.get('conversation-id');
      const branch = requestContext?.get('conversation-branch');
      if (typeof namespace !== 'string' || typeof session !== 'string' ||
          typeof branch !== 'string') throw new Error('Missing trusted scope');
      return {
        namespace, session_id: session, branch_id: branch, cache_epoch: '0',
      };
    },
  });
}

// Existing application calls keep their native options and return types:
// const agent = instrument(existingAgent);
// const answer = await agent.generate(messages, { requestContext, memory });
// const output = await agent.stream(messages, {
//   requestContext, memory, abortSignal: controller.signal,
// });
// for await (const text of output.textStream) process.stdout.write(text);

// After all application calls finish:
// runtime.close();
```

Configured and per-call processors keep their native precedence. The wrapper
resolves the Agent's public default options and preserves the selected
`prepareStep` callback. Mastra invokes that callback after input processors;
Caveman then checks its final executable tool table. Replacing a tool map,
changing the recovery executor or output conversion, removing the tool, or
switching to an unrelated model prevents lossy recovery. Each invocation has
its own processor state, including concurrent calls on one Agent.

`processLLMRequest` authorizes a temporary provider view on every continuation.
The application input, MessageList, memory, and UI history retain the original
text. The wrapper returns Mastra's native output and does not create another
agent loop. A nested Caveman AI SDK model wrapper yields to the Mastra owner.

The lower-level `createCavemanMastraProcessor` observes calls without adding a
lossy recovery grant: `processLLMRequest` alone cannot prove which executor
Mastra will call. Use the Agent wrapper for recoverable compression.

`mode: 'off'` uses passive native delegates, sends no content to the optimizer,
and registers no recovery tool. `mode: 'record'` registers no recovery tool
and releases no replacement. An unavailable optimizer passes native
content through. Structured output, forced tools, and an existing
`caveman_retrieve` name preserve the application's contract. Unknown installed
Mastra versions use a passive entry-point delegate with an `unsupported_version`
diagnostic; only explicitly requested `strict: true` raises an error. The
original Agent and original call arguments remain unchanged.

The runtime's optional `onReport` callback receives one immutable metadata
report per native attempt, including disabled and skipped calls. `lastReport`
retains the latest report. Applied and reused counts describe replacements
actually installed in the provider view. Reports contain no source text and
perform no I/O; callback failures do not change native results.

## Reproduce the local proof

From the repository root, install the workspace and pinned native example,
build the packages, and compile a local runtime:

```sh
pnpm install --frozen-lockfile
npm ci --prefix examples/middleware/mastra
npm run build --prefix packages/sdk/typescript
npm run build --prefix packages/middleware/typescript
mkdir -p dist
go build -C proxy -o ../dist/caveman-proxy ./cmd/caveman-proxy
```

Run the native demonstration for both generation and streaming:

```sh
CAVEMAN_MIDDLEWARE_TEST_BINARY="$PWD/dist/caveman-proxy" \
node --test --test-name-pattern='native loop recovers' \
  examples/middleware/mastra/conformance.test.mjs
```

The fixture starts real Mastra, real provider SDKs, and a real local Caveman
runtime. A deterministic HTTP fixture asks the Agent to read 160 log lines,
requests omitted content through the native recovery tool, and checks the
exact Unicode and CRLF original before answering. It makes three provider
requests; off, record, and outage controls use the original source in two.
No paid model inference is used.

Run every conformance scenario and regenerate the machine-readable proof:

```sh
CAVEMAN_MIDDLEWARE_TEST_BINARY="$PWD/dist/caveman-proxy" \
CAVEMAN_MASTRA_EVIDENCE=examples/middleware/mastra/native-proof.json \
node --test examples/middleware/mastra/conformance.test.mjs \
  > examples/middleware/mastra/native-conformance.tap 2>&1
```

[The initial implementation run](./native-conformance.tap) and
[protocol and lifecycle evidence](./native-proof.json) include runtime,
adapter, and dependency-lock hashes. Coverage includes both native providers,
exact recovery, structured output, original memory/UI content, workflow
suspend/resume, twenty turns through two runtime restarts, scope rejection,
executor mutations, callback overrides, provider retry accounting, protected
content, version guards, and stream lifecycle. The functional fixture uses a
1,000 ms optimizer deadline to tolerate local scheduling contention; it is not
a latency benchmark and does not change the runtime client's production
default.

## Replayable operation evidence

The suite also contains eighteen literal tests for the nine required Mastra
operations on OpenAI and Anthropic. Each operation runs its own compression,
off, and optimizer-outage scenarios. Observations are emitted only after the
native assertions pass. Structured output records its full-source,
recovery-free behavior, including a real native tool read before the typed
continuation.

Create candidates and independently replay every complete record:

```sh
node packages/middleware/conformance/support/runtime-build.mjs --output=/absolute/runtime-build
CAVEMAN_MIDDLEWARE_TEST_BINARY=/absolute/runtime-build/caveman-proxy \
CAVEMAN_MIDDLEWARE_RUNTIME_PROVENANCE=/absolute/runtime-build/build.json \
CAVEMAN_MIDDLEWARE_CERT_OUTPUT_SUFFIX=reporting-v2 \
node examples/middleware/mastra/certify.mjs --replay
node --test packages/middleware/conformance/support/certify.test.mjs
```

[The operation run](./certification/reporting-v2/native.tap) contains all 57 tests.
[Coverage](./certification/reporting-v2/coverage.json) records eighteen complete candidates.
The `cancel_and_close` cells preserve native listener-detach behavior and
measure explicit cancellation on both stream surfaces. Their probes check
actual reader locks, pending reads, middleware work counters, native events,
original history, and one cancellation receipt with unknown usage. They do
not claim that closing a Mastra iterator stops its native generation.
Each candidate names its exact test and original/recovered byte hashes.
[The input snapshot](./certification/reporting-v2/inputs.json)
pins installed framework versions, source and compiled-module hashes, the
lockfile, and the runtime binary. The assembler rejects failed runs, missing
observations, changed inputs, and observations from unexecuted tests.

[Independent replay](./certification/reporting-v2/replay.json) binds all 144 required
observations to one fresh native process and its [raw output](./certification/reporting-v2/native-replay.tap).
A process nonce prevents reusing an earlier run, and a failed replay retains
its raw output for diagnosis. Matching a saved success field cannot certify a
candidate.

Candidates do not promote the shared support inventory. Promotion requires a
current inventory source lock and successful independent replay. The packaged
consumer harness sets `CAVEMAN_MIDDLEWARE_PACKAGED_TEST=1` to emit installed
artifact runtime metadata and the same native observations without importing
repository source helpers; that mode cannot issue source certifications.

## Native limits

Mastra 1.65.0 `textStream` and `fullStream` detach their event listener when an
iterator is closed. That action alone does not stop an active provider request.
Both the original Agent and wrapper demonstrate this behavior. To stop
generation, pass an `AbortSignal` and abort its controller. The fixture checks
that active abort closes the provider socket and records one cancellation with
unknown usage. A first text chunk is observed before the provider is released.
An early iterator close is not reported as provider completion or cancellation.

This Mastra version also erases an imported `error-text` discriminator while
building its MessageList. The wrapper recognizes incoming errors before that
conversion and retains bounded hashes to protect the same text on later memory
turns. It protects native error markers too. Rebuild wrappers when rebuilding
Agents; already-normalized external history that has lost all error metadata
cannot have that metadata reconstructed by middleware.

These artifacts prove local framework and protocol behavior. They do not prove
live-provider output quality, cache hits, saved dollars, native Windows
execution, every optional Mastra feature, or sustained performance. Provider
credentials and inference remain application-owned. Use separate authenticated
runtime principals or separate runtimes across trust boundaries; scope names
alone are not authentication. Recovery storage and retention belong to the
configured runtime.
