# Framework middleware implementation status

Goal: implement the entire [framework middleware specification](../specs/framework-middleware/spec-overview.md).
Status: active. All 16 adapter families have implementation source. Native
coverage varies; the full specification is not certified.

## Delivery state

| Unit | State | Evidence / remaining work |
|---|---|---|
| W0 contracts and upstream pins | Implemented; audit expanding | Upstream pins and hashes, protocol/support schemas, native extension probes, and shared validation fixtures exist. Compatibility exceptions have separate locked baselines. |
| W1 runtime and language clients | Implemented; proof expanding | Go runtime/store and both SDK protocol suites pass, including durable recovery, first-writer choices, deadlines and truthful unavailable-cache diagnostics. Full performance gates currently fail. |
| W2 complete AI SDK slice | First native and packaged oracle passed | Installed AI SDK 7 tool loop compresses, forces exact retrieval, streams before EOF, preserves caller history, and reuses after process restart. Clean tarball consumer passes native type-check and three AI SDK/OpenAI journeys. Remaining F04 method/adversarial coverage stays in the full matrix. |
| W3 core framework families | Implemented; proof expanding | F01/F02/F04/F05/F06/F07 have installed native tests. Complete operation coverage, explicit RAG source expansion and some composed paths remain. |
| W4 parity families | Implemented; proof expanding | F03/F08-F13 have adapter source and native tests. MCP passes eight suites per language, including stdio/HTTP, 100 scopes and restart. Agno lifecycle compatibility remains unresolved. CrewAI native execution evidence is being finalized. |
| W5 additional frameworks | Implemented; proof expanding | F14-F16 have native tests. Pydantic AI suspended continuation and transport lifecycle checks need resolution. LlamaIndex baseline typed-stream/helper/lifecycle gaps remain explicit. Mastra documentation and final evidence need completion. |
| W6 release proof | Incomplete | Initial tarball consumer passed; full isolated package matrix, 1000-request performance, 30-minute soak and optional hosted-provider evidence remain. |

## Decisions

- Preserve all pre-existing dirty files. Add middleware routes without rewriting
  provider forwarding, auth, or user work.
- Reuse Engine, CCR, and existing durable store authority. New scoped recovery
  grants are above the Engine's content-addressed handles.
- Existing SDK zero-dependency contracts remain; frameworks live in optional
  adapter packages. No private Agent SDK dependency.
- Hosted provider tests require explicit opt-in and a positive spending cap.
  Default validation is local; no live economic claim will be inferred from it.
- Completion requires all 16 families, 29 requirements, and 180 acceptance items
  to be audited against current execution evidence. This status is not that audit.

## Worktree baseline

Source HEAD at start: `ed615c72d9710c1e694ece3d7973fb47de4f1023`.
Existing changes include CLI, proxy config/auth/deployment/provider docs and
binary release/CI files, plus AWS credential chain files. The six specification
documents were written earlier in this task. No existing edits were reverted.

## Current evidence

- `packages/middleware/conformance/packaged-consumer.mjs`: initial packed SDK and adapter
  tarballs installed into a clean npm consumer; native types and three journeys
  passed. Latest complete run predates the Anthropic export addition, which needs
  inclusion in the next package audit.
- `examples/middleware/provider-sdks/anthropic.test.mjs`: native lazy tool runner,
  exact recovery, request helpers, preserved system/cache/thinking/beta fields,
  and streaming before EOF pass against a real local runtime.
- `examples/middleware/mcp/{test_native.py,conformance.test.mjs}`: eight suites
  per language pass against real native MCP clients, local provider servers and
  the Go Engine runtime. This includes 20-turn/two-restart stable views and 100
  interleaved scopes. Provider serialization and usage remain host-owned.
- `examples/middleware/asgi/test_native.py`: six native FastAPI/Starlette suites
  cover exact routes, original authorization/guard checks, malformed/oversized
  request replay and bounded streaming under backpressure and cancellation.
- SDK receipts now have a bounded background sink so sync provider response
  delivery does not wait on receipt network calls.

## Next acceptance oracle

Finish the exact support inventory, close native behavior gaps, run every
required composition and clean package consumer, and meet the performance and
soak gates. Hosted-provider tests require explicit opt-in and a positive spend
cap; local protocol fixtures do not establish provider economics.
