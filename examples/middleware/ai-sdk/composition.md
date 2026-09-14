# Native AI SDK and provider transport composition

`composition.test.mjs` proves the native AI SDK provider fetch seam for OpenAI
Chat Completions and Anthropic Messages. AI SDK uses its own provider packages;
it does not instantiate the official OpenAI or Anthropic SDK client classes.

The fixture supplies the public `createCavemanFetch` export from
`@caveman-ai/middleware/openai` to `createOpenAI({ fetch })` and
`createAnthropic({ fetch })`. Both native client adapters use that same transport
implementation. AI SDK's `withCaveman` owns the request and registered recovery
executor; the nested transport yields optimization and receipt ownership, and
records the final provider wire hash. The fixture checks one optimizer call per
native model call and compares each completion receipt's hash with the bytes
received by the local provider.

The native `generateText` loop calls a real application `read_logs` executor,
receives an omitted-fact recovery request, executes the registered
`binding.execute`, and returns the exact original UTF-8 content. It checks
unchanged caller history, native step and call counts, off mode, optimizer
outage, gated streaming, consumer cancellation through the public native model
stream, and a provider failure with retries disabled.

Build the TypeScript SDK and middleware first, and install both existing exact
example locks. The Anthropic provider dependency is loaded from the existing
Mastra environment (`@ai-sdk/anthropic` 4.0.50); this fixture does not claim that
the ordinary AI SDK example manifest includes Anthropic.

```sh
npm ci --prefix examples/middleware/ai-sdk
npm ci --prefix examples/middleware/mastra
export CAVEMAN_MIDDLEWARE_TEST_BINARY=/absolute/path/to/fresh/caveman-proxy
node --test examples/middleware/ai-sdk/composition.test.mjs
```

The runtime binary is built from the current `proxy` module. Tests start the
actual runtime and only substitute the provider HTTP responses. No paid
inference runs. `CAVEMAN_MIDDLEWARE_OBSERVATION` lines include the binary SHA-256,
the exact static test name, scoped cell ID, and the assertions exercised by
that execution. These are local native-fixture observations; they do not claim
live provider or invoice verification.
