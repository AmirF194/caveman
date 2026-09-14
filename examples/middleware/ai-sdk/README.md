# Native AI SDK middleware example

The pinned environment uses `ai@7.0.94`, `@ai-sdk/provider@4.0.11`,
`@ai-sdk/openai@4.0.62`, `@ai-sdk/anthropic@4.0.50`, and `zod@4.3.6`.
The source fixture loads Anthropic from the separately locked Mastra example;
the packaged consumer installs that exact provider dependency normally.

Build the SDK and middleware packages before running source examples. Run the
compression runtime separately and keep one runtime client per application:

```ts
import { createMiddlewareRuntime } from '@caveman-ai/sdk/middleware';
import { withCaveman } from '@caveman-ai/middleware/ai-sdk';
import { streamText, ToolLoopAgent } from 'ai';

const runtime = createMiddlewareRuntime({
  endpoint: 'http://127.0.0.1:8080',
  onReport: report => console.log(report.status, report.reason),
});
await runtime.ready();
const scope = { namespace: 'app', session_id: conversationId, branch_id: 'main', cache_epoch: '0' };
const options = withCaveman(existingOptions, { runtime, scope });
const result = streamText(options);
// Alternatively, keep the same bundle in the SDK's public native agent:
const agent = new ToolLoopAgent(options);
const answer = await agent.generate({ messages: existingOptions.messages });
```

Use either native entry point for a call. `existingOptions` retains the
application's model, tools, messages, retry policy, and stop conditions.
`withCaveman` adds the real scoped recovery executor and its native callbacks.
Keep the returned bundle intact: replacing its tool table or dropping its
callbacks removes the evidence needed for lossy compression. A caller-owned
`caveman_retrieve` name collision preserves that tool and disables lossiness.
The original tool result remains in native response history; only the outbound
model view contains the shortened text and opaque recovery grant.

`createCavemanMiddleware({ runtime, scope })` with `wrapLanguageModel` is the
model-only integration. It has no executable registry and stays recovery-free.
Native `Output.object` contracts also remain recovery-free. Unsupported versions
return original input with `unsupported_version`; strict runtime diagnostics can
require a capability before dispatch. `mode: 'off'` uses a passive native model
delegate and emits `disabled` without optimizer requests or receipts. The
original options and tool objects remain unchanged.

`onReport` receives immutable metadata after each owned model request decision:
status, reason, transform IDs, and replacement/reuse counts, without source
content. `runtime.lastReport` holds one latest event across the runtime. Callback
failures do not affect native results. Nested Caveman adapters share the outer
decision and do not emit another report for that same native request.
Call `runtime.close()` during application shutdown. Abort generation using the
AI SDK's existing `AbortSignal`.

Run the exact native proof and its independent replay from the repository root:

```sh
CAVEMAN_MIDDLEWARE_TEST_BINARY=/absolute/path/to/caveman-proxy \
  node examples/middleware/ai-sdk/certify.mjs --replay
```

The [candidate coverage](certification/coverage.json) records all 18 frozen
operations with eight concrete observations per operation. Its
[independent replay](certification/replay.json) checks a fresh native process,
exact test names, source and dependency hashes, runtime identity, and matching
observations. Generate/stream and public `ToolLoopAgent` flows recover a fact
absent from the compressed view. Typed and model-only flows preserve complete
source bytes. Explicit active abort closes the provider stream, releases native
stream locks, leaves no runtime jobs pending, and records incomplete usage once.

These are installed-framework tests against local HTTP provider fixtures.
They do not establish live provider authentication, model quality, cache hits,
or invoice savings. Source candidates do not promote the public support matrix
on their own. [Composition proof](composition.md) covers nested provider ownership.
