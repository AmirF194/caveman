# Caveman framework middleware

Native framework adapters for the local Caveman compression runtime. The host
framework keeps its models, tool loop, retries, streams, and conversation state.
Selected tool-result text is replaced only in the outbound model view.

This package is under development. Tested native versions are pinned in
`packages/middleware/conformance/upstream-lock.json` in the source repository.
Installed-framework tests use a real local Caveman runtime and local provider
fixtures; they do not establish hosted model quality or billing savings.

Install the adapter package and the exact native framework used by your app.
For the AI SDK example:

```sh
npm install @caveman-ai/sdk @caveman-ai/middleware ai@7.0.94 @ai-sdk/provider@4.0.11 @ai-sdk/openai@4.0.62
```

Framework versions are recorded in the package's `testedFrameworkVersions`
metadata and independently locked example environments. They are not global
npm peers: different optional adapters require incompatible provider SDK majors.
Installing the core packages therefore installs no framework. Each adapter
checks its native version before activation; an untested version keeps the
original native input and emits `unsupported_version`. Set `strict: true` on
the middleware runtime only when a pre-inference error is desired.

## AI SDK

```ts
import { createMiddlewareRuntime } from '@caveman-ai/sdk/middleware';
import { withCaveman } from '@caveman-ai/middleware/ai-sdk';
import { streamText } from 'ai';

const runtime = createMiddlewareRuntime({
  endpoint: 'http://127.0.0.1:8080',
  onReport: report => console.log(report.status, report.reason),
});
await runtime.ready();
const scope = {
  namespace: 'my-app', session_id: 'conversation-1',
  branch_id: 'main', cache_epoch: '0',
};
// Keep the application's existing model, tools, messages, and stop conditions.
const result = streamText(withCaveman(existingOptions, { runtime, scope }));
```

`withCaveman` registers a native `caveman_retrieve` tool. The public
`createCavemanMiddleware` model-only variant uses recovery-free transforms.
Neither variant changes the caller's stored messages. Close the shared runtime
when the application shuts down.

## OpenAI SDK

```ts
import { withCavemanOpenAI } from '@caveman-ai/middleware/openai';

const client = withCavemanOpenAI(existingOpenAIClient, {
  runtime, scope, fetch: existingFetch,
});
const runner = client.chat.completions.runTools(existingToolLoopOptions);
const answer = await runner.finalContent();
```

Pass the fetch function used by the existing client. The returned native client
preserves its public response helpers. `runTools` supplies the native recovery
executor. Ordinary generation calls remain recovery-free unless a native host
integration supplies its own verified executor. Server-held Responses histories
remain opaque.

## Runtime modes and evidence

- `off` delegates native calls and emits `disabled` reports without optimizer requests or receipts.
- `record` measures candidate reductions without replacing request text.
- `compress` requires recovery when the Engine transformation is lossy.

Optimizer failures send the original request and report unavailable cache
continuity. Measurements remain inferred; client-observed provider usage is
recorded separately. No inferred token reduction is called verified savings.

`onReport` receives immutable decision metadata after the adapter applies its
request view. Reports include status, reason, transform IDs, and replacement/
reuse counts, without original content. `runtime.lastReport` retains one latest
report across the shared runtime; it is not a conversation history. Callback
failures do not affect native inference. Passive delegates used by `off` and
untested versions preserve caller options and native results.

Run the source repository's
`packages/middleware/conformance/packaged-consumer.mjs` to build tarballs,
install an isolated consumer, type-check native integrations, and execute the
real runtime journeys from those installed artifacts.
