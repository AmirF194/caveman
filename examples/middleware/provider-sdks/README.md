# Native OpenAI and Anthropic SDK examples

These examples use the installed official SDKs and a real Caveman runtime. The
provider responses come from deterministic HTTP/SSE fixtures on loopback. They
require no provider credentials and make no hosted-model or billing claim.

The exact JavaScript dependencies are OpenAI **7.12.1** and Anthropic
**0.124.0**, recorded in `package-lock.json`. This run used Node **22.22.2**.
Use the repository's `pnpm@10.14.0` workspace install to prepare the local SDK
and middleware packages, then run from the repository root:

```sh
npm ci --prefix examples/middleware/provider-sdks
npm run build --prefix packages/sdk/typescript
npm run build --prefix packages/middleware/typescript
go -C proxy build -o /tmp/caveman-provider-example-proxy ./cmd/caveman-proxy
export CAVEMAN_MIDDLEWARE_TEST_BINARY=/tmp/caveman-provider-example-proxy
node examples/middleware/provider-sdks/example.mjs
node --test examples/middleware/provider-sdks/openai.test.mjs examples/middleware/provider-sdks/anthropic.test.mjs
```

`example.mjs` demonstrates an existing native client, native raw-response
helpers, complete Chat Completions and Responses application loops, and the
Anthropic native tool runner. Each complete loop reads the log, receives a
shortened model view, executes `caveman_retrieve`, recovers the exact Unicode
and CRLF source, and returns `retained-detail-70`.

## Integrate an existing client

```ts
import { withCavemanOpenAI } from '@caveman-ai/middleware/openai';
import { withCavemanAnthropic } from '@caveman-ai/middleware/anthropic';

const openai = withCavemanOpenAI(existingOpenAI, {
  runtime, scope, fetch: originalFetch,
});
const anthropic = withCavemanAnthropic(existingAnthropic, {
  runtime, scope, fetch: originalFetch,
});
```

Pass the actual fetch function used to construct the original client. The
returned objects retain native `APIPromise`, `withResponse`, `asResponse`,
`parse`, stream helpers, and `withOptions`. Native auth, HTTP options, retries,
and custom fetch remain in the native path. Perform original-content
authorization and policy checks before calling the wrapped client. A fetch
hook downstream of projection receives the outgoing model view.

Ordinary model calls use recovery-free transforms. A schema named
`caveman_retrieve` cannot grant recovery. OpenAI Chat's native `runTools` and
Anthropic's native `beta.messages.toolRunner` receive a real immutable executor
from the adapter and retain the SDK's scheduler.

OpenAI Responses has no tool scheduler at these pins. For an application-owned
loop, use `withCavemanOpenAITools(existingClient, { runtime, scope, fetch,
protocol, tools, functions })`, where `protocol` is `openai-chat` or
`openai-responses`. Keep using the returned native `client`, fresh `tools`
definitions, and immutable `functions` table for every function dispatch.
The helper adds one recovery executor; it does not schedule application tools.

## Verified behavior and boundaries

The 14 original native tests cover raw and parsed responses, streaming event order
against the native baseline, client cloning, complete and streamed loops,
`off` and unavailable-runtime fallback, exact source recovery, actual socket
close before fixture EOF, executor/schema substitutions, duplicate names,
in-flight executor changes, forced tools, and structured output.

Changed or missing recovery contracts, forced output, and duplicate tool names
disable lossy projection. Ordinary text requires a unique prior native call
and one matching result. Unknown contracts, errors, unmatched or duplicate
calls/results, cited content, and mixed media remain intact. Anthropic signed
thinking, system/cache blocks, and unrelated token-count/batch endpoints are
preserved. Responses `previous_response_id` and `conversation` references,
retrieve/cancel, and compaction pass through because their hidden history is
not available to the adapter. Signed or encoded request bodies pass through.

Untested SDK versions use a passive native client clone and emit
`unsupported_version`; runtime `strict: true` makes that a pre-inference error.
The native tests use exact pins. They do not certify another SDK version.

Set `onReport` when creating the runtime to receive immutable status, reason,
transform IDs, and replacement/reuse counts after the actual request decision.
The transport reports each visible provider attempt, including native retries.
`runtime.lastReport` retains only the latest metadata event. Reports contain no
original text; callback failures do not affect native results. `off` uses the
same native transport path and emits `disabled`, with no optimizer requests or
receipts and no mutation of the original client or caller options.

`openai-native-evidence.json` and `anthropic-native-evidence.json` contain
native case observations, source hashes, versions, and the runtime hash.
Read them with the test runner's exit status; a partial failed run can still
write observations. Usage is SDK-observed fixture data. Estimated reductions
are inferred, and verified saved dollars remain zero.

## Exact operation candidates and replay

Two additional native tests execute all 19 frozen OpenAI operations and all
8 frozen Anthropic operations. Each operation runs with compression, `off`,
and an unavailable runtime. An actual SDK tool call produces the source result
before model-only helpers run. Those helpers explicitly prove recovery-free
behavior. Tool loops omit row 70 from a provider request, execute the registered
recovery function, and compare recovered UTF-8 bytes with the stored source.
The Responses loop records application ownership because this SDK has no
native tool scheduler.

After the setup above, produce the candidates and replay every observation in
a fresh process:

```sh
node examples/middleware/provider-sdks/certify.mjs F01 --replay
node examples/middleware/provider-sdks/certify.mjs F02 --replay
```

Keep `CAVEMAN_MIDDLEWARE_TEST_BINARY` set to the built runtime. The family
directories under `certification/` contain exact input hashes, raw native TAP,
one candidate per operation, coverage, and the fresh replay report. Candidates
are not shared support-manifest promotions. Clean package consumers run the
same operation fixtures using `certification-cells.json`; source execution
checks that its operations still match the frozen shared catalog.
