# Framework middleware support

Generated from the required-cell inventory and per-operation manifests checked by `verify-support.mjs`. Do not edit this report directly.

Full middleware is incomplete. The inventory covers 558 required operation cells across 16 families and 23 family/language pairs, plus 29 normative requirements and 180 acceptance items.

558 cells have an implementation seam, 0 are missing, 0 are conformant, and 0 are provider-tested. 0 acceptance items have accepted complete proof.

`implemented` records inspected source only. Test names and existing local evidence are candidate proof, not certification. No row inherits certification from a wrapped adapter. Registry pins identify intended test versions; they do not assert that this inventory reran those versions.

`conformant` requires the installed-framework journey, including the disabled and unavailable-optimizer baselines, with matching operation scope, exact tests, native execution output, and source/lock hashes. The validator requires independent replay before accepting certification. `provider_tested` also requires real provider/model/SDK/date/usage evidence. A local HTTP fixture does not prove live provider authentication, provider cache hits, invoice savings, or production compatibility.

`not_applicable` is reserved for an upstream-absent API established by a versioned source excerpt. A required but unimplemented method stays `missing`. Unsupported installed versions must produce the separate `unsupported_version` runtime outcome; no version range is certified here.

Method keys combine public entry points with required behavior (for example cancellation, checkpoint resume, or source expansion). They are inventory labels, not additional exported SDK functions. Python `sync` and `async` rows refer to the corresponding native entry points. The provider/protocol column identifies required fixture coverage, including currently untested combinations.

The recovery and persistence columns describe the required integration contract. They do not certify that a missing or implemented row satisfies it. Model-only paths must prove their recovery-free behavior; lossy agent paths need the real host executor.

Run from the repository root:

```sh
node packages/middleware/conformance/verify-support.mjs
node --test packages/middleware/conformance/support/verify-support.test.mjs
node packages/middleware/conformance/verify-support.mjs --audit-completion
```

The first command validates an honest incomplete inventory. The completion audit intentionally exits nonzero while mandatory proof or release gates remain open. `--json` returns the complete machine-readable gap report. Add `--replay` when validating future certified rows. No command here launches live-provider traffic.

After implementation or tests change, run `node packages/middleware/conformance/support/build-source-inventory.mjs` to capture a new source snapshot and regenerate this page. This source-only command resets operation certification; it never promotes a row from a success field.

## Blocking proof

- **native_journeys (incomplete):** Native candidates exist across all 16 families. Each conformant manifest row must come from its exact scoped source/build inputs and a fresh independent replay. Remaining required Strands behavior and complete family acceptance remain open.
- **shared_correctness (incomplete):** The native Go acceptance producer distinguishes fully covered criteria from partial components. Complete cross-framework fidelity, recovery, process/worker stability, isolation, failure and accounting proof is still required; source locators never promote a criterion.
- **composition (incomplete):** The four named native compositions have executing fixtures. Complete owner, auth/guardrail, attempt and receipt criteria require explicit scoped acceptance evidence beyond an operation journey.
- **performance (incomplete):** The latest retained native candidate used 1000 measured calls per phase at concurrency 16. Adapter-only p95 is 1.0071660000003249 ms; cold optimize p95 is 42.791625000000295 ms; warm p95 is 34.46837500000129 ms. Cold/warm bypass fractions are 0/0. Dedicated host: no. Historical failures remain retained. Complete dedicated-host, pre-dispatch deadline and overload criteria are not certified by these candidate measurements.
- **stream_and_soak (incomplete):** Retained native stream and 30-minute soak runs include resource counters, storage samples and graphs. They remain scoped candidates until their complete source/build inputs and exact lifecycle, buffering and retention criteria are accepted.
- **packaging (incomplete):** The harness contains 23 isolated consumers per platform and requires actual native build provenance before packaging. Complete current-source macOS and Linux reports, docs execution and every packaging criterion still need final qualification. Native Windows remains uncertified.
- **live_provider_record (missing):** No accepted live-provider coverage record exists. Auth, endpoint, model/version/date, streaming/recovery, and usage completeness need their own bounded, explicitly authorized runs. Local fixtures are not cloud-auth evidence.
- **task_comparison (incomplete):** The harness contains 24 frozen tasks, native common-intersection arms, rotation/cache strata, independent oracles and budget controls. Actual paid task outcomes and redacted provider receipts are absent. No provider-cost superiority or quality-equivalence claim is supported.

## Family summary

| Family | Languages | Implemented | Missing | Conformant | Provider tested | Upstream absent |
|---|---|---:|---:|---:|---:|---:|
| F01 OpenAI SDK | python, typescript | 53 | 0 | 0 | 0 | 0 |
| F02 Anthropic SDK | python, typescript | 24 | 0 | 0 | 0 | 0 |
| F03 Google GenAI SDK | python, typescript | 48 | 0 | 0 | 0 | 0 |
| F04 Vercel AI SDK | typescript | 18 | 0 | 0 | 0 | 0 |
| F05 LangChain | python, typescript | 60 | 0 | 0 | 0 | 0 |
| F06 LangGraph | python, typescript | 42 | 0 | 0 | 0 | 0 |
| F07 LiteLLM SDK and Proxy | python | 36 | 0 | 0 | 0 | 0 |
| F08 Agno | python | 28 | 0 | 0 | 0 | 0 |
| F09 Strands | python, typescript | 48 | 0 | 0 | 0 | 0 |
| F10 CrewAI | python | 28 | 0 | 0 | 0 | 0 |
| F11 AutoGen | python | 20 | 0 | 0 | 0 | 0 |
| F12 ASGI / FastAPI / Starlette | python | 33 | 0 | 0 | 0 | 0 |
| F13 MCP | python, typescript | 22 | 0 | 0 | 0 | 0 |
| F14 Pydantic AI | python | 40 | 0 | 0 | 0 | 0 |
| F15 LlamaIndex | python | 40 | 0 | 0 | 0 | 0 |
| F16 Mastra | typescript | 18 | 0 | 0 | 0 | 0 |

## Source and traceability

- [Required operation cells](../../packages/middleware/conformance/support/required-cells.json) freeze every mandatory cell against the six specification files.
- [Requirement traceability](../../packages/middleware/conformance/support/traceability.json) contains the exact text and line of all 180 acceptance items, exact related test names, and missing proof. A related test is not a complete acceptance result.
- [Test catalog](../../packages/middleware/conformance/support/test-catalog.json) records source hashes, declaration lines, fixture scope, and rerun instructions. Dynamic test cases retain their declared template and its concrete case names.
- [Source lock](../../packages/middleware/conformance/support/source-lock.json) binds adapter, SDK, runtime, test, schema, and dependency-lock files. Stale hashes fail validation.
- [Existing reports](../../packages/middleware/conformance/support/reports.json) classify legacy local artifacts. Handwritten evidence summaries cannot certify an operation.

Inventory revision: `3b29d267ef9821d25ef16adfecf736e0c7a80802e4d0b705a718ac03c04e84a7`. Specification acceptance counts: overview 16, runtime 77, adapters 43, proof 44.

## Operation matrix

All rows require scoped durable replacement state. `native_executor` means recovery must execute in the host loop; `operator_bound` means an explicit trusted reader/client binding is required; `model_only` means the default must remain recovery-free. Serialization visibility records the layer where a future test must observe the request; source-only rows provide no byte-stability certification.

<details><summary>F01 OpenAI SDK</summary>

| Language / pinned framework | Provider / protocol | Required operation | Execution | Stream | Structured | Recovery | Required visibility | State |
|---|---|---|---|---|---|---|---|---|
| python / openai 3.10.0 | openai / openai-chat-completions | create | sync | no | no | model_only | provider_http | implemented |
| python / openai 3.10.0 | openai / openai-chat-completions | create | async | no | no | model_only | provider_http | implemented |
| python / openai 3.10.0 | openai / openai-chat-completions | create.stream | sync | yes | no | model_only | provider_http | implemented |
| python / openai 3.10.0 | openai / openai-chat-completions | create.stream | async | yes | no | model_only | provider_http | implemented |
| python / openai 3.10.0 | openai / openai-chat-completions | with_raw_response.create | sync | no | no | model_only | provider_http | implemented |
| python / openai 3.10.0 | openai / openai-chat-completions | with_raw_response.create | async | no | no | model_only | provider_http | implemented |
| python / openai 3.10.0 | openai / openai-chat-completions | with_streaming_response.create | sync | yes | no | model_only | provider_http | implemented |
| python / openai 3.10.0 | openai / openai-chat-completions | with_streaming_response.create | async | yes | no | model_only | provider_http | implemented |
| python / openai 3.10.0 | openai / openai-chat-completions | parse | sync | no | yes | model_only | provider_http | implemented |
| python / openai 3.10.0 | openai / openai-chat-completions | parse | async | no | yes | model_only | provider_http | implemented |
| python / openai 3.10.0 | openai / openai-chat-completions | application_tool_loop | sync | no | no | native_executor | provider_http | implemented |
| python / openai 3.10.0 | openai / openai-chat-completions | application_tool_loop | async | no | no | native_executor | provider_http | implemented |
| python / openai 3.10.0 | openai / openai-chat-completions | cancel | sync | yes | no | model_only | provider_http | implemented |
| python / openai 3.10.0 | openai / openai-chat-completions | cancel | async | yes | no | model_only | provider_http | implemented |
| python / openai 3.10.0 | openai / openai-chat-completions | unrelated_endpoint_passthrough | sync | no | no | not_applicable | provider_http | implemented |
| python / openai 3.10.0 | openai / openai-chat-completions | unrelated_endpoint_passthrough | async | no | no | not_applicable | provider_http | implemented |
| python / openai 3.10.0 | openai / openai-responses | create | sync | no | no | model_only | provider_http | implemented |
| python / openai 3.10.0 | openai / openai-responses | create | async | no | no | model_only | provider_http | implemented |
| python / openai 3.10.0 | openai / openai-responses | create.stream | sync | yes | no | model_only | provider_http | implemented |
| python / openai 3.10.0 | openai / openai-responses | create.stream | async | yes | no | model_only | provider_http | implemented |
| python / openai 3.10.0 | openai / openai-responses | with_raw_response.create | sync | no | no | model_only | provider_http | implemented |
| python / openai 3.10.0 | openai / openai-responses | with_raw_response.create | async | no | no | model_only | provider_http | implemented |
| python / openai 3.10.0 | openai / openai-responses | with_streaming_response.create | sync | yes | no | model_only | provider_http | implemented |
| python / openai 3.10.0 | openai / openai-responses | with_streaming_response.create | async | yes | no | model_only | provider_http | implemented |
| python / openai 3.10.0 | openai / openai-responses | parse | sync | no | yes | model_only | provider_http | implemented |
| python / openai 3.10.0 | openai / openai-responses | parse | async | no | yes | model_only | provider_http | implemented |
| python / openai 3.10.0 | openai / openai-responses | application_tool_loop | sync | no | no | native_executor | provider_http | implemented |
| python / openai 3.10.0 | openai / openai-responses | application_tool_loop | async | no | no | native_executor | provider_http | implemented |
| python / openai 3.10.0 | openai / openai-responses | cancel | sync | yes | no | model_only | provider_http | implemented |
| python / openai 3.10.0 | openai / openai-responses | cancel | async | yes | no | model_only | provider_http | implemented |
| python / openai 3.10.0 | openai / openai-responses | server_history_reference | sync | no | no | model_only | provider_http | implemented |
| python / openai 3.10.0 | openai / openai-responses | server_history_reference | async | no | no | model_only | provider_http | implemented |
| python / openai 3.10.0 | openai / openai-responses | unrelated_endpoint_passthrough | sync | no | no | not_applicable | provider_http | implemented |
| python / openai 3.10.0 | openai / openai-responses | unrelated_endpoint_passthrough | async | no | no | not_applicable | provider_http | implemented |
| typescript / openai 7.12.1 | openai / openai-chat-completions | create | async | no | no | model_only | provider_http | implemented |
| typescript / openai 7.12.1 | openai / openai-chat-completions | create.stream | async | yes | no | model_only | provider_http | implemented |
| typescript / openai 7.12.1 | openai / openai-chat-completions | asResponse | async | no | no | model_only | provider_http | implemented |
| typescript / openai 7.12.1 | openai / openai-chat-completions | withResponse | async | no | no | model_only | provider_http | implemented |
| typescript / openai 7.12.1 | openai / openai-chat-completions | parse | async | no | yes | model_only | provider_http | implemented |
| typescript / openai 7.12.1 | openai / openai-chat-completions | native_tool_loop | async | no | no | native_executor | provider_http | implemented |
| typescript / openai 7.12.1 | openai / openai-chat-completions | native_tool_loop.stream | async | yes | no | native_executor | provider_http | implemented |
| typescript / openai 7.12.1 | openai / openai-chat-completions | cancel | async | yes | no | model_only | provider_http | implemented |
| typescript / openai 7.12.1 | openai / openai-chat-completions | unrelated_endpoint_passthrough | async | no | no | not_applicable | provider_http | implemented |
| typescript / openai 7.12.1 | openai / openai-responses | create | async | no | no | model_only | provider_http | implemented |
| typescript / openai 7.12.1 | openai / openai-responses | create.stream | async | yes | no | model_only | provider_http | implemented |
| typescript / openai 7.12.1 | openai / openai-responses | asResponse | async | no | no | model_only | provider_http | implemented |
| typescript / openai 7.12.1 | openai / openai-responses | withResponse | async | no | no | model_only | provider_http | implemented |
| typescript / openai 7.12.1 | openai / openai-responses | parse | async | no | yes | model_only | provider_http | implemented |
| typescript / openai 7.12.1 | openai / openai-responses | native_tool_loop | async | no | no | native_executor | provider_http | implemented |
| typescript / openai 7.12.1 | openai / openai-responses | native_tool_loop.stream | async | yes | no | native_executor | provider_http | implemented |
| typescript / openai 7.12.1 | openai / openai-responses | cancel | async | yes | no | model_only | provider_http | implemented |
| typescript / openai 7.12.1 | openai / openai-responses | server_history_reference | async | no | no | model_only | provider_http | implemented |
| typescript / openai 7.12.1 | openai / openai-responses | unrelated_endpoint_passthrough | async | no | no | not_applicable | provider_http | implemented |

[Operation manifests and exact evidence references](../../packages/middleware/conformance/support/manifests/F01.json)

</details>

<details><summary>F02 Anthropic SDK</summary>

| Language / pinned framework | Provider / protocol | Required operation | Execution | Stream | Structured | Recovery | Required visibility | State |
|---|---|---|---|---|---|---|---|---|
| python / anthropic 1.4.0 | anthropic / anthropic-messages | messages.create | sync | no | no | model_only | provider_http | implemented |
| python / anthropic 1.4.0 | anthropic / anthropic-messages | messages.create | async | no | no | model_only | provider_http | implemented |
| python / anthropic 1.4.0 | anthropic / anthropic-messages | messages.create.stream | sync | yes | no | model_only | provider_http | implemented |
| python / anthropic 1.4.0 | anthropic / anthropic-messages | messages.create.stream | async | yes | no | model_only | provider_http | implemented |
| python / anthropic 1.4.0 | anthropic / anthropic-messages | messages.stream | sync | yes | no | model_only | provider_http | implemented |
| python / anthropic 1.4.0 | anthropic / anthropic-messages | messages.stream | async | yes | no | model_only | provider_http | implemented |
| python / anthropic 1.4.0 | anthropic / anthropic-messages | messages.raw_response | sync | no | no | model_only | provider_http | implemented |
| python / anthropic 1.4.0 | anthropic / anthropic-messages | messages.raw_response | async | no | no | model_only | provider_http | implemented |
| python / anthropic 1.4.0 | anthropic / anthropic-messages | application_tool_loop | sync | no | no | native_executor | provider_http | implemented |
| python / anthropic 1.4.0 | anthropic / anthropic-messages | application_tool_loop | async | no | no | native_executor | provider_http | implemented |
| python / anthropic 1.4.0 | anthropic / anthropic-messages | application_tool_loop.stream | sync | yes | no | native_executor | provider_http | implemented |
| python / anthropic 1.4.0 | anthropic / anthropic-messages | application_tool_loop.stream | async | yes | no | native_executor | provider_http | implemented |
| python / anthropic 1.4.0 | anthropic / anthropic-messages | cancel | sync | yes | no | model_only | provider_http | implemented |
| python / anthropic 1.4.0 | anthropic / anthropic-messages | cancel | async | yes | no | model_only | provider_http | implemented |
| python / anthropic 1.4.0 | anthropic / anthropic-messages | count_tokens.passthrough | sync | no | no | not_applicable | provider_http | implemented |
| python / anthropic 1.4.0 | anthropic / anthropic-messages | count_tokens.passthrough | async | no | no | not_applicable | provider_http | implemented |
| typescript / @anthropic-ai/sdk 0.124.0 | anthropic / anthropic-messages | messages.create | async | no | no | model_only | provider_http | implemented |
| typescript / @anthropic-ai/sdk 0.124.0 | anthropic / anthropic-messages | messages.create.stream | async | yes | no | model_only | provider_http | implemented |
| typescript / @anthropic-ai/sdk 0.124.0 | anthropic / anthropic-messages | messages.stream | async | yes | no | model_only | provider_http | implemented |
| typescript / @anthropic-ai/sdk 0.124.0 | anthropic / anthropic-messages | messages.raw_response | async | no | no | model_only | provider_http | implemented |
| typescript / @anthropic-ai/sdk 0.124.0 | anthropic / anthropic-messages | beta.messages.toolRunner | async | no | no | native_executor | provider_http | implemented |
| typescript / @anthropic-ai/sdk 0.124.0 | anthropic / anthropic-messages | beta.messages.toolRunner.stream | async | yes | no | native_executor | provider_http | implemented |
| typescript / @anthropic-ai/sdk 0.124.0 | anthropic / anthropic-messages | cancel | async | yes | no | model_only | provider_http | implemented |
| typescript / @anthropic-ai/sdk 0.124.0 | anthropic / anthropic-messages | countTokens.passthrough | async | no | no | not_applicable | provider_http | implemented |

[Operation manifests and exact evidence references](../../packages/middleware/conformance/support/manifests/F02.json)

</details>

<details><summary>F03 Google GenAI SDK</summary>

| Language / pinned framework | Provider / protocol | Required operation | Execution | Stream | Structured | Recovery | Required visibility | State |
|---|---|---|---|---|---|---|---|---|
| python / google-genai 2.22.0 | google / google-generate-content | models.generate_content | sync | no | no | native_executor | provider_http | implemented |
| python / google-genai 2.22.0 | google / google-generate-content | models.generate_content | async | no | no | native_executor | provider_http | implemented |
| python / google-genai 2.22.0 | google / google-generate-content | models.generate_content_stream | sync | yes | no | native_executor | provider_http | implemented |
| python / google-genai 2.22.0 | google / google-generate-content | models.generate_content_stream | async | yes | no | native_executor | provider_http | implemented |
| python / google-genai 2.22.0 | google / google-generate-content | chats.send_message | sync | no | no | native_executor | provider_http | implemented |
| python / google-genai 2.22.0 | google / google-generate-content | chats.send_message | async | no | no | native_executor | provider_http | implemented |
| python / google-genai 2.22.0 | google / google-generate-content | chats.send_message_stream | sync | yes | no | native_executor | provider_http | implemented |
| python / google-genai 2.22.0 | google / google-generate-content | chats.send_message_stream | async | yes | no | native_executor | provider_http | implemented |
| python / google-genai 2.22.0 | google / google-generate-content | models.generate_content.structured | sync | no | yes | model_only | provider_http | implemented |
| python / google-genai 2.22.0 | google / google-generate-content | models.generate_content.structured | async | no | yes | model_only | provider_http | implemented |
| python / google-genai 2.22.0 | google / google-generate-content | cached_content.opaque | sync | no | no | model_only | provider_http | implemented |
| python / google-genai 2.22.0 | google / google-generate-content | cached_content.opaque | async | no | no | model_only | provider_http | implemented |
| python / google-genai 2.22.0 | google / google-generate-content | client_auth_and_configuration | sync | no | no | native_executor | provider_http | implemented |
| python / google-genai 2.22.0 | google / google-generate-content | client_auth_and_configuration | async | no | no | native_executor | provider_http | implemented |
| python / google-genai 2.22.0 | google / google-generate-content | cancel_and_close | sync | yes | no | native_executor | provider_http | implemented |
| python / google-genai 2.22.0 | google / google-generate-content | cancel_and_close | async | yes | no | native_executor | provider_http | implemented |
| python / google-genai 2.22.0 | vertex / google-generate-content | models.generate_content | sync | no | no | native_executor | provider_http | implemented |
| python / google-genai 2.22.0 | vertex / google-generate-content | models.generate_content | async | no | no | native_executor | provider_http | implemented |
| python / google-genai 2.22.0 | vertex / google-generate-content | models.generate_content_stream | sync | yes | no | native_executor | provider_http | implemented |
| python / google-genai 2.22.0 | vertex / google-generate-content | models.generate_content_stream | async | yes | no | native_executor | provider_http | implemented |
| python / google-genai 2.22.0 | vertex / google-generate-content | chats.send_message | sync | no | no | native_executor | provider_http | implemented |
| python / google-genai 2.22.0 | vertex / google-generate-content | chats.send_message | async | no | no | native_executor | provider_http | implemented |
| python / google-genai 2.22.0 | vertex / google-generate-content | chats.send_message_stream | sync | yes | no | native_executor | provider_http | implemented |
| python / google-genai 2.22.0 | vertex / google-generate-content | chats.send_message_stream | async | yes | no | native_executor | provider_http | implemented |
| python / google-genai 2.22.0 | vertex / google-generate-content | models.generate_content.structured | sync | no | yes | model_only | provider_http | implemented |
| python / google-genai 2.22.0 | vertex / google-generate-content | models.generate_content.structured | async | no | yes | model_only | provider_http | implemented |
| python / google-genai 2.22.0 | vertex / google-generate-content | cached_content.opaque | sync | no | no | model_only | provider_http | implemented |
| python / google-genai 2.22.0 | vertex / google-generate-content | cached_content.opaque | async | no | no | model_only | provider_http | implemented |
| python / google-genai 2.22.0 | vertex / google-generate-content | client_auth_and_configuration | sync | no | no | native_executor | provider_http | implemented |
| python / google-genai 2.22.0 | vertex / google-generate-content | client_auth_and_configuration | async | no | no | native_executor | provider_http | implemented |
| python / google-genai 2.22.0 | vertex / google-generate-content | cancel_and_close | sync | yes | no | native_executor | provider_http | implemented |
| python / google-genai 2.22.0 | vertex / google-generate-content | cancel_and_close | async | yes | no | native_executor | provider_http | implemented |
| typescript / @google/genai 2.21.0 | google / google-generate-content | models.generateContent | async | no | no | native_executor | provider_http | implemented |
| typescript / @google/genai 2.21.0 | google / google-generate-content | models.generateContentStream | async | yes | no | native_executor | provider_http | implemented |
| typescript / @google/genai 2.21.0 | google / google-generate-content | chats.sendMessage | async | no | no | native_executor | provider_http | implemented |
| typescript / @google/genai 2.21.0 | google / google-generate-content | chats.sendMessageStream | async | yes | no | native_executor | provider_http | implemented |
| typescript / @google/genai 2.21.0 | google / google-generate-content | models.generateContent.structured | async | no | yes | model_only | provider_http | implemented |
| typescript / @google/genai 2.21.0 | google / google-generate-content | cachedContent.opaque | async | no | no | model_only | provider_http | implemented |
| typescript / @google/genai 2.21.0 | google / google-generate-content | client_auth_and_configuration | async | no | no | native_executor | provider_http | implemented |
| typescript / @google/genai 2.21.0 | google / google-generate-content | cancel_and_close | async | yes | no | native_executor | provider_http | implemented |
| typescript / @google/genai 2.21.0 | vertex / google-generate-content | models.generateContent | async | no | no | native_executor | provider_http | implemented |
| typescript / @google/genai 2.21.0 | vertex / google-generate-content | models.generateContentStream | async | yes | no | native_executor | provider_http | implemented |
| typescript / @google/genai 2.21.0 | vertex / google-generate-content | chats.sendMessage | async | no | no | native_executor | provider_http | implemented |
| typescript / @google/genai 2.21.0 | vertex / google-generate-content | chats.sendMessageStream | async | yes | no | native_executor | provider_http | implemented |
| typescript / @google/genai 2.21.0 | vertex / google-generate-content | models.generateContent.structured | async | no | yes | model_only | provider_http | implemented |
| typescript / @google/genai 2.21.0 | vertex / google-generate-content | cachedContent.opaque | async | no | no | model_only | provider_http | implemented |
| typescript / @google/genai 2.21.0 | vertex / google-generate-content | client_auth_and_configuration | async | no | no | native_executor | provider_http | implemented |
| typescript / @google/genai 2.21.0 | vertex / google-generate-content | cancel_and_close | async | yes | no | native_executor | provider_http | implemented |

[Operation manifests and exact evidence references](../../packages/middleware/conformance/support/manifests/F03.json)

</details>

<details><summary>F04 Vercel AI SDK</summary>

| Language / pinned framework | Provider / protocol | Required operation | Execution | Stream | Structured | Recovery | Required visibility | State |
|---|---|---|---|---|---|---|---|---|
| typescript / ai 7.0.94 | openai / openai-chat-completions | generateText | async | no | no | native_executor | native_model | implemented |
| typescript / ai 7.0.94 | openai / openai-chat-completions | streamText | async | yes | no | native_executor | native_model | implemented |
| typescript / ai 7.0.94 | openai / openai-chat-completions | generateText.structured | async | no | yes | model_only | native_model | implemented |
| typescript / ai 7.0.94 | openai / openai-chat-completions | streamText.structured | async | yes | yes | model_only | native_model | implemented |
| typescript / ai 7.0.94 | openai / openai-chat-completions | public_tool_loop | async | no | no | native_executor | native_model | implemented |
| typescript / ai 7.0.94 | openai / openai-chat-completions | public_tool_loop.stream | async | yes | no | native_executor | native_model | implemented |
| typescript / ai 7.0.94 | openai / openai-chat-completions | wrapLanguageModel.model_only | async | no | no | model_only | native_model | implemented |
| typescript / ai 7.0.94 | openai / openai-chat-completions | nested_provider_client_ownership | async | no | no | native_executor | native_model | implemented |
| typescript / ai 7.0.94 | openai / openai-chat-completions | cancel_and_close | async | yes | no | native_executor | native_model | implemented |
| typescript / ai 7.0.94 | anthropic / anthropic-messages | generateText | async | no | no | native_executor | native_model | implemented |
| typescript / ai 7.0.94 | anthropic / anthropic-messages | streamText | async | yes | no | native_executor | native_model | implemented |
| typescript / ai 7.0.94 | anthropic / anthropic-messages | generateText.structured | async | no | yes | model_only | native_model | implemented |
| typescript / ai 7.0.94 | anthropic / anthropic-messages | streamText.structured | async | yes | yes | model_only | native_model | implemented |
| typescript / ai 7.0.94 | anthropic / anthropic-messages | public_tool_loop | async | no | no | native_executor | native_model | implemented |
| typescript / ai 7.0.94 | anthropic / anthropic-messages | public_tool_loop.stream | async | yes | no | native_executor | native_model | implemented |
| typescript / ai 7.0.94 | anthropic / anthropic-messages | wrapLanguageModel.model_only | async | no | no | model_only | native_model | implemented |
| typescript / ai 7.0.94 | anthropic / anthropic-messages | nested_provider_client_ownership | async | no | no | native_executor | native_model | implemented |
| typescript / ai 7.0.94 | anthropic / anthropic-messages | cancel_and_close | async | yes | no | native_executor | native_model | implemented |

[Operation manifests and exact evidence references](../../packages/middleware/conformance/support/manifests/F04.json)

</details>

<details><summary>F05 LangChain</summary>

| Language / pinned framework | Provider / protocol | Required operation | Execution | Stream | Structured | Recovery | Required visibility | State |
|---|---|---|---|---|---|---|---|---|
| python / langchain 1.4.0 | openai / openai-chat-completions | agent.invoke | sync | no | no | native_executor | native_model | implemented |
| python / langchain 1.4.0 | openai / openai-chat-completions | agent.invoke | async | no | no | native_executor | native_model | implemented |
| python / langchain 1.4.0 | openai / openai-chat-completions | agent.stream | sync | yes | no | native_executor | native_model | implemented |
| python / langchain 1.4.0 | openai / openai-chat-completions | agent.stream | async | yes | no | native_executor | native_model | implemented |
| python / langchain 1.4.0 | openai / openai-chat-completions | chat_model.invoke | sync | no | no | model_only | native_model | implemented |
| python / langchain 1.4.0 | openai / openai-chat-completions | chat_model.invoke | async | no | no | model_only | native_model | implemented |
| python / langchain 1.4.0 | openai / openai-chat-completions | chat_model.batch | batch | no | no | model_only | native_model | implemented |
| python / langchain 1.4.0 | openai / openai-chat-completions | chat_model.abatch | batch | no | no | model_only | native_model | implemented |
| python / langchain 1.4.0 | openai / openai-chat-completions | chat_model.stream | sync | yes | no | model_only | native_model | implemented |
| python / langchain 1.4.0 | openai / openai-chat-completions | chat_model.stream | async | yes | no | model_only | native_model | implemented |
| python / langchain 1.4.0 | openai / openai-chat-completions | chat_model.bind_tools | sync | no | no | model_only | native_model | implemented |
| python / langchain 1.4.0 | openai / openai-chat-completions | chat_model.bind_tools | async | no | no | model_only | native_model | implemented |
| python / langchain 1.4.0 | openai / openai-chat-completions | chat_model.with_structured_output | sync | no | yes | model_only | native_model | implemented |
| python / langchain 1.4.0 | openai / openai-chat-completions | chat_model.with_structured_output | async | no | yes | model_only | native_model | implemented |
| python / langchain 1.4.0 | openai / openai-chat-completions | callbacks_and_request_config | sync | no | no | native_executor | native_model | implemented |
| python / langchain 1.4.0 | openai / openai-chat-completions | callbacks_and_request_config | async | no | no | native_executor | native_model | implemented |
| python / langchain 1.4.0 | openai / openai-chat-completions | document_compressor | sync | no | no | model_only | native_model | implemented |
| python / langchain 1.4.0 | openai / openai-chat-completions | document_compressor | async | no | no | model_only | native_model | implemented |
| python / langchain 1.4.0 | openai / openai-chat-completions | retriever.source_expansion | sync | no | no | operator_bound | native_model | implemented |
| python / langchain 1.4.0 | openai / openai-chat-completions | retriever.source_expansion | async | no | no | operator_bound | native_model | implemented |
| python / langchain 1.4.0 | anthropic / anthropic-messages | agent.invoke | sync | no | no | native_executor | native_model | implemented |
| python / langchain 1.4.0 | anthropic / anthropic-messages | agent.invoke | async | no | no | native_executor | native_model | implemented |
| python / langchain 1.4.0 | anthropic / anthropic-messages | agent.stream | sync | yes | no | native_executor | native_model | implemented |
| python / langchain 1.4.0 | anthropic / anthropic-messages | agent.stream | async | yes | no | native_executor | native_model | implemented |
| python / langchain 1.4.0 | anthropic / anthropic-messages | chat_model.invoke | sync | no | no | model_only | native_model | implemented |
| python / langchain 1.4.0 | anthropic / anthropic-messages | chat_model.invoke | async | no | no | model_only | native_model | implemented |
| python / langchain 1.4.0 | anthropic / anthropic-messages | chat_model.batch | batch | no | no | model_only | native_model | implemented |
| python / langchain 1.4.0 | anthropic / anthropic-messages | chat_model.abatch | batch | no | no | model_only | native_model | implemented |
| python / langchain 1.4.0 | anthropic / anthropic-messages | chat_model.stream | sync | yes | no | model_only | native_model | implemented |
| python / langchain 1.4.0 | anthropic / anthropic-messages | chat_model.stream | async | yes | no | model_only | native_model | implemented |
| python / langchain 1.4.0 | anthropic / anthropic-messages | chat_model.bind_tools | sync | no | no | model_only | native_model | implemented |
| python / langchain 1.4.0 | anthropic / anthropic-messages | chat_model.bind_tools | async | no | no | model_only | native_model | implemented |
| python / langchain 1.4.0 | anthropic / anthropic-messages | chat_model.with_structured_output | sync | no | yes | model_only | native_model | implemented |
| python / langchain 1.4.0 | anthropic / anthropic-messages | chat_model.with_structured_output | async | no | yes | model_only | native_model | implemented |
| python / langchain 1.4.0 | anthropic / anthropic-messages | callbacks_and_request_config | sync | no | no | native_executor | native_model | implemented |
| python / langchain 1.4.0 | anthropic / anthropic-messages | callbacks_and_request_config | async | no | no | native_executor | native_model | implemented |
| python / langchain 1.4.0 | anthropic / anthropic-messages | document_compressor | sync | no | no | model_only | native_model | implemented |
| python / langchain 1.4.0 | anthropic / anthropic-messages | document_compressor | async | no | no | model_only | native_model | implemented |
| python / langchain 1.4.0 | anthropic / anthropic-messages | retriever.source_expansion | sync | no | no | operator_bound | native_model | implemented |
| python / langchain 1.4.0 | anthropic / anthropic-messages | retriever.source_expansion | async | no | no | operator_bound | native_model | implemented |
| typescript / langchain 1.5.10 | openai / openai-chat-completions | agent.invoke | async | no | no | native_executor | native_model | implemented |
| typescript / langchain 1.5.10 | openai / openai-chat-completions | agent.stream | async | yes | no | native_executor | native_model | implemented |
| typescript / langchain 1.5.10 | openai / openai-chat-completions | chat_model.invoke | async | no | no | model_only | native_model | implemented |
| typescript / langchain 1.5.10 | openai / openai-chat-completions | chat_model.batch | batch | no | no | model_only | native_model | implemented |
| typescript / langchain 1.5.10 | openai / openai-chat-completions | chat_model.stream | async | yes | no | model_only | native_model | implemented |
| typescript / langchain 1.5.10 | openai / openai-chat-completions | chat_model.bindTools | async | no | no | model_only | native_model | implemented |
| typescript / langchain 1.5.10 | openai / openai-chat-completions | chat_model.withStructuredOutput | async | no | yes | model_only | native_model | implemented |
| typescript / langchain 1.5.10 | openai / openai-chat-completions | callbacks_and_request_config | async | no | no | native_executor | native_model | implemented |
| typescript / langchain 1.5.10 | openai / openai-chat-completions | document_compressor | async | no | no | model_only | native_model | implemented |
| typescript / langchain 1.5.10 | openai / openai-chat-completions | retriever.source_expansion | async | no | no | operator_bound | native_model | implemented |
| typescript / langchain 1.5.10 | anthropic / anthropic-messages | agent.invoke | async | no | no | native_executor | native_model | implemented |
| typescript / langchain 1.5.10 | anthropic / anthropic-messages | agent.stream | async | yes | no | native_executor | native_model | implemented |
| typescript / langchain 1.5.10 | anthropic / anthropic-messages | chat_model.invoke | async | no | no | model_only | native_model | implemented |
| typescript / langchain 1.5.10 | anthropic / anthropic-messages | chat_model.batch | batch | no | no | model_only | native_model | implemented |
| typescript / langchain 1.5.10 | anthropic / anthropic-messages | chat_model.stream | async | yes | no | model_only | native_model | implemented |
| typescript / langchain 1.5.10 | anthropic / anthropic-messages | chat_model.bindTools | async | no | no | model_only | native_model | implemented |
| typescript / langchain 1.5.10 | anthropic / anthropic-messages | chat_model.withStructuredOutput | async | no | yes | model_only | native_model | implemented |
| typescript / langchain 1.5.10 | anthropic / anthropic-messages | callbacks_and_request_config | async | no | no | native_executor | native_model | implemented |
| typescript / langchain 1.5.10 | anthropic / anthropic-messages | document_compressor | async | no | no | model_only | native_model | implemented |
| typescript / langchain 1.5.10 | anthropic / anthropic-messages | retriever.source_expansion | async | no | no | operator_bound | native_model | implemented |

[Operation manifests and exact evidence references](../../packages/middleware/conformance/support/manifests/F05.json)

</details>

<details><summary>F06 LangGraph</summary>

| Language / pinned framework | Provider / protocol | Required operation | Execution | Stream | Structured | Recovery | Required visibility | State |
|---|---|---|---|---|---|---|---|---|
| python / langgraph 1.2.11 | openai / openai-chat-completions | graph.invoke | sync | no | no | native_executor | native_model | implemented |
| python / langgraph 1.2.11 | openai / openai-chat-completions | graph.invoke | async | no | no | native_executor | native_model | implemented |
| python / langgraph 1.2.11 | openai / openai-chat-completions | graph.stream | sync | yes | no | native_executor | native_model | implemented |
| python / langgraph 1.2.11 | openai / openai-chat-completions | graph.stream | async | yes | no | native_executor | native_model | implemented |
| python / langgraph 1.2.11 | openai / openai-chat-completions | checkpoint_resume_after_restart | sync | no | no | native_executor | native_model | implemented |
| python / langgraph 1.2.11 | openai / openai-chat-completions | checkpoint_resume_after_restart | async | no | no | native_executor | native_model | implemented |
| python / langgraph 1.2.11 | openai / openai-chat-completions | branch_and_history_edit | sync | no | no | native_executor | native_model | implemented |
| python / langgraph 1.2.11 | openai / openai-chat-completions | branch_and_history_edit | async | no | no | native_executor | native_model | implemented |
| python / langgraph 1.2.11 | openai / openai-chat-completions | interrupt_and_reducers | sync | no | no | native_executor | native_model | implemented |
| python / langgraph 1.2.11 | openai / openai-chat-completions | interrupt_and_reducers | async | no | no | native_executor | native_model | implemented |
| python / langgraph 1.2.11 | openai / openai-chat-completions | parallel_tool_batch | sync | no | no | native_executor | native_model | implemented |
| python / langgraph 1.2.11 | openai / openai-chat-completions | parallel_tool_batch | async | no | no | native_executor | native_model | implemented |
| python / langgraph 1.2.11 | openai / openai-chat-completions | interleaved_thread_identity | sync | no | no | native_executor | native_model | implemented |
| python / langgraph 1.2.11 | openai / openai-chat-completions | interleaved_thread_identity | async | no | no | native_executor | native_model | implemented |
| python / langgraph 1.2.11 | anthropic / anthropic-messages | graph.invoke | sync | no | no | native_executor | native_model | implemented |
| python / langgraph 1.2.11 | anthropic / anthropic-messages | graph.invoke | async | no | no | native_executor | native_model | implemented |
| python / langgraph 1.2.11 | anthropic / anthropic-messages | graph.stream | sync | yes | no | native_executor | native_model | implemented |
| python / langgraph 1.2.11 | anthropic / anthropic-messages | graph.stream | async | yes | no | native_executor | native_model | implemented |
| python / langgraph 1.2.11 | anthropic / anthropic-messages | checkpoint_resume_after_restart | sync | no | no | native_executor | native_model | implemented |
| python / langgraph 1.2.11 | anthropic / anthropic-messages | checkpoint_resume_after_restart | async | no | no | native_executor | native_model | implemented |
| python / langgraph 1.2.11 | anthropic / anthropic-messages | branch_and_history_edit | sync | no | no | native_executor | native_model | implemented |
| python / langgraph 1.2.11 | anthropic / anthropic-messages | branch_and_history_edit | async | no | no | native_executor | native_model | implemented |
| python / langgraph 1.2.11 | anthropic / anthropic-messages | interrupt_and_reducers | sync | no | no | native_executor | native_model | implemented |
| python / langgraph 1.2.11 | anthropic / anthropic-messages | interrupt_and_reducers | async | no | no | native_executor | native_model | implemented |
| python / langgraph 1.2.11 | anthropic / anthropic-messages | parallel_tool_batch | sync | no | no | native_executor | native_model | implemented |
| python / langgraph 1.2.11 | anthropic / anthropic-messages | parallel_tool_batch | async | no | no | native_executor | native_model | implemented |
| python / langgraph 1.2.11 | anthropic / anthropic-messages | interleaved_thread_identity | sync | no | no | native_executor | native_model | implemented |
| python / langgraph 1.2.11 | anthropic / anthropic-messages | interleaved_thread_identity | async | no | no | native_executor | native_model | implemented |
| typescript / @langchain/langgraph 1.4.14 | openai / openai-chat-completions | graph.invoke | async | no | no | native_executor | native_model | implemented |
| typescript / @langchain/langgraph 1.4.14 | openai / openai-chat-completions | graph.stream | async | yes | no | native_executor | native_model | implemented |
| typescript / @langchain/langgraph 1.4.14 | openai / openai-chat-completions | checkpoint_resume_after_restart | async | no | no | native_executor | native_model | implemented |
| typescript / @langchain/langgraph 1.4.14 | openai / openai-chat-completions | branch_and_history_edit | async | no | no | native_executor | native_model | implemented |
| typescript / @langchain/langgraph 1.4.14 | openai / openai-chat-completions | interrupt_and_reducers | async | no | no | native_executor | native_model | implemented |
| typescript / @langchain/langgraph 1.4.14 | openai / openai-chat-completions | parallel_tool_batch | async | no | no | native_executor | native_model | implemented |
| typescript / @langchain/langgraph 1.4.14 | openai / openai-chat-completions | interleaved_thread_identity | async | no | no | native_executor | native_model | implemented |
| typescript / @langchain/langgraph 1.4.14 | anthropic / anthropic-messages | graph.invoke | async | no | no | native_executor | native_model | implemented |
| typescript / @langchain/langgraph 1.4.14 | anthropic / anthropic-messages | graph.stream | async | yes | no | native_executor | native_model | implemented |
| typescript / @langchain/langgraph 1.4.14 | anthropic / anthropic-messages | checkpoint_resume_after_restart | async | no | no | native_executor | native_model | implemented |
| typescript / @langchain/langgraph 1.4.14 | anthropic / anthropic-messages | branch_and_history_edit | async | no | no | native_executor | native_model | implemented |
| typescript / @langchain/langgraph 1.4.14 | anthropic / anthropic-messages | interrupt_and_reducers | async | no | no | native_executor | native_model | implemented |
| typescript / @langchain/langgraph 1.4.14 | anthropic / anthropic-messages | parallel_tool_batch | async | no | no | native_executor | native_model | implemented |
| typescript / @langchain/langgraph 1.4.14 | anthropic / anthropic-messages | interleaved_thread_identity | async | no | no | native_executor | native_model | implemented |

[Operation manifests and exact evidence references](../../packages/middleware/conformance/support/manifests/F06.json)

</details>

<details><summary>F07 LiteLLM SDK and Proxy</summary>

| Language / pinned framework | Provider / protocol | Required operation | Execution | Stream | Structured | Recovery | Required visibility | State |
|---|---|---|---|---|---|---|---|---|
| python / litellm 1.100.0 | openai / openai-chat-completions | sdk.completion | sync | no | no | model_only | native_model | implemented |
| python / litellm 1.100.0 | openai / openai-chat-completions | sdk.acompletion | async | no | no | model_only | native_model | implemented |
| python / litellm 1.100.0 | openai / openai-chat-completions | sdk.completion.stream | sync | yes | no | model_only | native_model | implemented |
| python / litellm 1.100.0 | openai / openai-chat-completions | sdk.acompletion.stream | async | yes | no | model_only | native_model | implemented |
| python / litellm 1.100.0 | openai / openai-responses | sdk.responses | sync | no | no | model_only | native_model | implemented |
| python / litellm 1.100.0 | openai / openai-responses | sdk.aresponses | async | no | no | model_only | native_model | implemented |
| python / litellm 1.100.0 | openai / openai-responses | sdk.responses.stream | sync | yes | no | model_only | native_model | implemented |
| python / litellm 1.100.0 | openai / openai-responses | sdk.aresponses.stream | async | yes | no | model_only | native_model | implemented |
| python / litellm 1.100.0 | openai / openai-chat-completions | sdk.structured_output | sync | no | yes | model_only | native_model | implemented |
| python / litellm 1.100.0 | openai / openai-chat-completions | sdk.structured_output | async | no | yes | model_only | native_model | implemented |
| python / litellm 1.100.0 | openai / openai-chat-completions | router.retry_and_fallback | sync | no | no | operator_bound | native_model | implemented |
| python / litellm 1.100.0 | openai / openai-chat-completions | router.retry_and_fallback | async | no | no | operator_bound | native_model | implemented |
| python / litellm 1.100.0 | openai / openai-chat-completions | proxy.completion | async | no | no | operator_bound | native_model | implemented |
| python / litellm 1.100.0 | openai / openai-chat-completions | proxy.completion.stream | async | yes | no | operator_bound | native_model | implemented |
| python / litellm 1.100.0 | openai / openai-responses | proxy.responses | async | no | no | operator_bound | native_model | implemented |
| python / litellm 1.100.0 | openai / openai-responses | proxy.responses.stream | async | yes | no | operator_bound | native_model | implemented |
| python / litellm 1.100.0 | openai / openai-chat-completions | proxy.auth_guardrail_order | async | no | no | operator_bound | native_model | implemented |
| python / litellm 1.100.0 | openai / openai-chat-completions | asgi_composition | async | no | no | operator_bound | native_model | implemented |
| python / litellm 1.100.0 | anthropic / anthropic-messages | sdk.completion | sync | no | no | model_only | native_model | implemented |
| python / litellm 1.100.0 | anthropic / anthropic-messages | sdk.acompletion | async | no | no | model_only | native_model | implemented |
| python / litellm 1.100.0 | anthropic / anthropic-messages | sdk.completion.stream | sync | yes | no | model_only | native_model | implemented |
| python / litellm 1.100.0 | anthropic / anthropic-messages | sdk.acompletion.stream | async | yes | no | model_only | native_model | implemented |
| python / litellm 1.100.0 | anthropic / openai-responses | sdk.responses | sync | no | no | model_only | native_model | implemented |
| python / litellm 1.100.0 | anthropic / openai-responses | sdk.aresponses | async | no | no | model_only | native_model | implemented |
| python / litellm 1.100.0 | anthropic / openai-responses | sdk.responses.stream | sync | yes | no | model_only | native_model | implemented |
| python / litellm 1.100.0 | anthropic / openai-responses | sdk.aresponses.stream | async | yes | no | model_only | native_model | implemented |
| python / litellm 1.100.0 | anthropic / anthropic-messages | sdk.structured_output | sync | no | yes | model_only | native_model | implemented |
| python / litellm 1.100.0 | anthropic / anthropic-messages | sdk.structured_output | async | no | yes | model_only | native_model | implemented |
| python / litellm 1.100.0 | anthropic / anthropic-messages | router.retry_and_fallback | sync | no | no | operator_bound | native_model | implemented |
| python / litellm 1.100.0 | anthropic / anthropic-messages | router.retry_and_fallback | async | no | no | operator_bound | native_model | implemented |
| python / litellm 1.100.0 | anthropic / anthropic-messages | proxy.completion | async | no | no | operator_bound | native_model | implemented |
| python / litellm 1.100.0 | anthropic / anthropic-messages | proxy.completion.stream | async | yes | no | operator_bound | native_model | implemented |
| python / litellm 1.100.0 | anthropic / openai-responses | proxy.responses | async | no | no | operator_bound | native_model | implemented |
| python / litellm 1.100.0 | anthropic / openai-responses | proxy.responses.stream | async | yes | no | operator_bound | native_model | implemented |
| python / litellm 1.100.0 | anthropic / anthropic-messages | proxy.auth_guardrail_order | async | no | no | operator_bound | native_model | implemented |
| python / litellm 1.100.0 | anthropic / anthropic-messages | asgi_composition | async | no | no | operator_bound | native_model | implemented |

[Operation manifests and exact evidence references](../../packages/middleware/conformance/support/manifests/F07.json)

</details>

<details><summary>F08 Agno</summary>

| Language / pinned framework | Provider / protocol | Required operation | Execution | Stream | Structured | Recovery | Required visibility | State |
|---|---|---|---|---|---|---|---|---|
| python / agno 3.0.9 | openai / openai-chat-completions | agent.run | sync | no | no | native_executor | native_model | implemented |
| python / agno 3.0.9 | openai / openai-chat-completions | agent.run | async | no | no | native_executor | native_model | implemented |
| python / agno 3.0.9 | openai / openai-chat-completions | agent.run.stream | sync | yes | no | native_executor | native_model | implemented |
| python / agno 3.0.9 | openai / openai-chat-completions | agent.run.stream | async | yes | no | native_executor | native_model | implemented |
| python / agno 3.0.9 | openai / openai-chat-completions | agent.run.structured | sync | no | yes | model_only | native_model | implemented |
| python / agno 3.0.9 | openai / openai-chat-completions | agent.run.structured | async | no | yes | model_only | native_model | implemented |
| python / agno 3.0.9 | openai / openai-chat-completions | team.run | sync | no | no | native_executor | native_model | implemented |
| python / agno 3.0.9 | openai / openai-chat-completions | team.run | async | no | no | native_executor | native_model | implemented |
| python / agno 3.0.9 | openai / openai-chat-completions | internal_model_continuation | sync | no | no | native_executor | native_model | implemented |
| python / agno 3.0.9 | openai / openai-chat-completions | internal_model_continuation | async | no | no | native_executor | native_model | implemented |
| python / agno 3.0.9 | openai / openai-chat-completions | cancel_and_close | sync | yes | no | native_executor | native_model | implemented |
| python / agno 3.0.9 | openai / openai-chat-completions | cancel_and_close | async | yes | no | native_executor | native_model | implemented |
| python / agno 3.0.9 | openai / openai-chat-completions | model_only | sync | no | no | model_only | native_model | implemented |
| python / agno 3.0.9 | openai / openai-chat-completions | model_only | async | no | no | model_only | native_model | implemented |
| python / agno 3.0.9 | anthropic / anthropic-messages | agent.run | sync | no | no | native_executor | native_model | implemented |
| python / agno 3.0.9 | anthropic / anthropic-messages | agent.run | async | no | no | native_executor | native_model | implemented |
| python / agno 3.0.9 | anthropic / anthropic-messages | agent.run.stream | sync | yes | no | native_executor | native_model | implemented |
| python / agno 3.0.9 | anthropic / anthropic-messages | agent.run.stream | async | yes | no | native_executor | native_model | implemented |
| python / agno 3.0.9 | anthropic / anthropic-messages | agent.run.structured | sync | no | yes | model_only | native_model | implemented |
| python / agno 3.0.9 | anthropic / anthropic-messages | agent.run.structured | async | no | yes | model_only | native_model | implemented |
| python / agno 3.0.9 | anthropic / anthropic-messages | team.run | sync | no | no | native_executor | native_model | implemented |
| python / agno 3.0.9 | anthropic / anthropic-messages | team.run | async | no | no | native_executor | native_model | implemented |
| python / agno 3.0.9 | anthropic / anthropic-messages | internal_model_continuation | sync | no | no | native_executor | native_model | implemented |
| python / agno 3.0.9 | anthropic / anthropic-messages | internal_model_continuation | async | no | no | native_executor | native_model | implemented |
| python / agno 3.0.9 | anthropic / anthropic-messages | cancel_and_close | sync | yes | no | native_executor | native_model | implemented |
| python / agno 3.0.9 | anthropic / anthropic-messages | cancel_and_close | async | yes | no | native_executor | native_model | implemented |
| python / agno 3.0.9 | anthropic / anthropic-messages | model_only | sync | no | no | model_only | native_model | implemented |
| python / agno 3.0.9 | anthropic / anthropic-messages | model_only | async | no | no | model_only | native_model | implemented |

[Operation manifests and exact evidence references](../../packages/middleware/conformance/support/manifests/F08.json)

</details>

<details><summary>F09 Strands</summary>

| Language / pinned framework | Provider / protocol | Required operation | Execution | Stream | Structured | Recovery | Required visibility | State |
|---|---|---|---|---|---|---|---|---|
| python / strands-agents 1.55.0 | openai / openai-chat-completions | agent.__call__ | sync | no | no | native_executor | native_model | implemented |
| python / strands-agents 1.55.0 | openai / openai-chat-completions | agent.invoke_async | async | no | no | native_executor | native_model | implemented |
| python / strands-agents 1.55.0 | openai / openai-chat-completions | agent.stream_async | async | yes | no | native_executor | native_model | implemented |
| python / strands-agents 1.55.0 | openai / openai-chat-completions | model.stream | async | yes | no | native_executor | native_model | implemented |
| python / strands-agents 1.55.0 | openai / openai-chat-completions | model.structured_output | async | yes | yes | model_only | native_model | implemented |
| python / strands-agents 1.55.0 | openai / openai-chat-completions | parallel_tool_batch | async | no | no | native_executor | native_model | implemented |
| python / strands-agents 1.55.0 | openai / openai-chat-completions | resumed_session | async | no | no | native_executor | native_model | implemented |
| python / strands-agents 1.55.0 | openai / openai-chat-completions | every_model_continuation | async | no | no | native_executor | native_model | implemented |
| python / strands-agents 1.55.0 | openai / openai-chat-completions | cancel_and_close | async | yes | no | native_executor | native_model | implemented |
| python / strands-agents 1.55.0 | anthropic / anthropic-messages | agent.__call__ | sync | no | no | native_executor | native_model | implemented |
| python / strands-agents 1.55.0 | anthropic / anthropic-messages | agent.invoke_async | async | no | no | native_executor | native_model | implemented |
| python / strands-agents 1.55.0 | anthropic / anthropic-messages | agent.stream_async | async | yes | no | native_executor | native_model | implemented |
| python / strands-agents 1.55.0 | anthropic / anthropic-messages | model.stream | async | yes | no | native_executor | native_model | implemented |
| python / strands-agents 1.55.0 | anthropic / anthropic-messages | model.structured_output | async | yes | yes | model_only | native_model | implemented |
| python / strands-agents 1.55.0 | anthropic / anthropic-messages | parallel_tool_batch | async | no | no | native_executor | native_model | implemented |
| python / strands-agents 1.55.0 | anthropic / anthropic-messages | resumed_session | async | no | no | native_executor | native_model | implemented |
| python / strands-agents 1.55.0 | anthropic / anthropic-messages | every_model_continuation | async | no | no | native_executor | native_model | implemented |
| python / strands-agents 1.55.0 | anthropic / anthropic-messages | cancel_and_close | async | yes | no | native_executor | native_model | implemented |
| python / strands-agents 1.55.0 | bedrock / bedrock-converse | agent.__call__ | sync | no | no | native_executor | native_model | implemented |
| python / strands-agents 1.55.0 | bedrock / bedrock-converse | agent.invoke_async | async | no | no | native_executor | native_model | implemented |
| python / strands-agents 1.55.0 | bedrock / bedrock-converse | agent.stream_async | async | yes | no | native_executor | native_model | implemented |
| python / strands-agents 1.55.0 | bedrock / bedrock-converse | model.stream | async | yes | no | native_executor | native_model | implemented |
| python / strands-agents 1.55.0 | bedrock / bedrock-converse | model.structured_output | async | yes | yes | model_only | native_model | implemented |
| python / strands-agents 1.55.0 | bedrock / bedrock-converse | parallel_tool_batch | async | no | no | native_executor | native_model | implemented |
| python / strands-agents 1.55.0 | bedrock / bedrock-converse | resumed_session | async | no | no | native_executor | native_model | implemented |
| python / strands-agents 1.55.0 | bedrock / bedrock-converse | every_model_continuation | async | no | no | native_executor | native_model | implemented |
| python / strands-agents 1.55.0 | bedrock / bedrock-converse | cancel_and_close | async | yes | no | native_executor | native_model | implemented |
| typescript / @strands-agents/sdk 1.17.0 | openai / openai-chat-completions | agent.invoke | async | no | no | native_executor | native_model | implemented |
| typescript / @strands-agents/sdk 1.17.0 | openai / openai-chat-completions | agent.stream | async | yes | no | native_executor | native_model | implemented |
| typescript / @strands-agents/sdk 1.17.0 | openai / openai-chat-completions | model.structured_output | async | yes | yes | model_only | native_model | implemented |
| typescript / @strands-agents/sdk 1.17.0 | openai / openai-chat-completions | parallel_tool_batch | async | no | no | native_executor | native_model | implemented |
| typescript / @strands-agents/sdk 1.17.0 | openai / openai-chat-completions | resumed_session | async | no | no | native_executor | native_model | implemented |
| typescript / @strands-agents/sdk 1.17.0 | openai / openai-chat-completions | every_model_continuation | async | no | no | native_executor | native_model | implemented |
| typescript / @strands-agents/sdk 1.17.0 | openai / openai-chat-completions | cancel_and_close | async | yes | no | native_executor | native_model | implemented |
| typescript / @strands-agents/sdk 1.17.0 | anthropic / anthropic-messages | agent.invoke | async | no | no | native_executor | native_model | implemented |
| typescript / @strands-agents/sdk 1.17.0 | anthropic / anthropic-messages | agent.stream | async | yes | no | native_executor | native_model | implemented |
| typescript / @strands-agents/sdk 1.17.0 | anthropic / anthropic-messages | model.structured_output | async | yes | yes | model_only | native_model | implemented |
| typescript / @strands-agents/sdk 1.17.0 | anthropic / anthropic-messages | parallel_tool_batch | async | no | no | native_executor | native_model | implemented |
| typescript / @strands-agents/sdk 1.17.0 | anthropic / anthropic-messages | resumed_session | async | no | no | native_executor | native_model | implemented |
| typescript / @strands-agents/sdk 1.17.0 | anthropic / anthropic-messages | every_model_continuation | async | no | no | native_executor | native_model | implemented |
| typescript / @strands-agents/sdk 1.17.0 | anthropic / anthropic-messages | cancel_and_close | async | yes | no | native_executor | native_model | implemented |
| typescript / @strands-agents/sdk 1.17.0 | bedrock / bedrock-converse | agent.invoke | async | no | no | native_executor | native_model | implemented |
| typescript / @strands-agents/sdk 1.17.0 | bedrock / bedrock-converse | agent.stream | async | yes | no | native_executor | native_model | implemented |
| typescript / @strands-agents/sdk 1.17.0 | bedrock / bedrock-converse | model.structured_output | async | yes | yes | model_only | native_model | implemented |
| typescript / @strands-agents/sdk 1.17.0 | bedrock / bedrock-converse | parallel_tool_batch | async | no | no | native_executor | native_model | implemented |
| typescript / @strands-agents/sdk 1.17.0 | bedrock / bedrock-converse | resumed_session | async | no | no | native_executor | native_model | implemented |
| typescript / @strands-agents/sdk 1.17.0 | bedrock / bedrock-converse | every_model_continuation | async | no | no | native_executor | native_model | implemented |
| typescript / @strands-agents/sdk 1.17.0 | bedrock / bedrock-converse | cancel_and_close | async | yes | no | native_executor | native_model | implemented |

[Operation manifests and exact evidence references](../../packages/middleware/conformance/support/manifests/F09.json)

</details>

<details><summary>F10 CrewAI</summary>

| Language / pinned framework | Provider / protocol | Required operation | Execution | Stream | Structured | Recovery | Required visibility | State |
|---|---|---|---|---|---|---|---|---|
| python / crewai 1.15.20 | openai / openai-chat-completions | crew.kickoff | sync | no | no | native_executor | native_model | implemented |
| python / crewai 1.15.20 | openai / openai-chat-completions | crew.kickoff | async | no | no | native_executor | native_model | implemented |
| python / crewai 1.15.20 | openai / openai-chat-completions | crew.kickoff.stream | sync | yes | no | native_executor | native_model | implemented |
| python / crewai 1.15.20 | openai / openai-chat-completions | crew.kickoff.stream | async | yes | no | native_executor | native_model | implemented |
| python / crewai 1.15.20 | openai / openai-chat-completions | crew.kickoff.structured | sync | no | yes | model_only | native_model | implemented |
| python / crewai 1.15.20 | openai / openai-chat-completions | crew.kickoff.structured | async | no | yes | model_only | native_model | implemented |
| python / crewai 1.15.20 | openai / openai-chat-completions | task_delegation_and_human_input | sync | no | no | native_executor | native_model | implemented |
| python / crewai 1.15.20 | openai / openai-chat-completions | task_delegation_and_human_input | async | no | no | native_executor | native_model | implemented |
| python / crewai 1.15.20 | openai / openai-chat-completions | tool_arguments_results_and_cache | sync | no | no | native_executor | native_model | implemented |
| python / crewai 1.15.20 | openai / openai-chat-completions | tool_arguments_results_and_cache | async | no | no | native_executor | native_model | implemented |
| python / crewai 1.15.20 | openai / openai-chat-completions | scoped_registration_cleanup | sync | no | no | native_executor | native_model | implemented |
| python / crewai 1.15.20 | openai / openai-chat-completions | scoped_registration_cleanup | async | no | no | native_executor | native_model | implemented |
| python / crewai 1.15.20 | openai / openai-chat-completions | litellm_composition | sync | no | no | native_executor | native_model | implemented |
| python / crewai 1.15.20 | openai / openai-chat-completions | litellm_composition | async | no | no | native_executor | native_model | implemented |
| python / crewai 1.15.20 | anthropic / anthropic-messages | crew.kickoff | sync | no | no | native_executor | native_model | implemented |
| python / crewai 1.15.20 | anthropic / anthropic-messages | crew.kickoff | async | no | no | native_executor | native_model | implemented |
| python / crewai 1.15.20 | anthropic / anthropic-messages | crew.kickoff.stream | sync | yes | no | native_executor | native_model | implemented |
| python / crewai 1.15.20 | anthropic / anthropic-messages | crew.kickoff.stream | async | yes | no | native_executor | native_model | implemented |
| python / crewai 1.15.20 | anthropic / anthropic-messages | crew.kickoff.structured | sync | no | yes | model_only | native_model | implemented |
| python / crewai 1.15.20 | anthropic / anthropic-messages | crew.kickoff.structured | async | no | yes | model_only | native_model | implemented |
| python / crewai 1.15.20 | anthropic / anthropic-messages | task_delegation_and_human_input | sync | no | no | native_executor | native_model | implemented |
| python / crewai 1.15.20 | anthropic / anthropic-messages | task_delegation_and_human_input | async | no | no | native_executor | native_model | implemented |
| python / crewai 1.15.20 | anthropic / anthropic-messages | tool_arguments_results_and_cache | sync | no | no | native_executor | native_model | implemented |
| python / crewai 1.15.20 | anthropic / anthropic-messages | tool_arguments_results_and_cache | async | no | no | native_executor | native_model | implemented |
| python / crewai 1.15.20 | anthropic / anthropic-messages | scoped_registration_cleanup | sync | no | no | native_executor | native_model | implemented |
| python / crewai 1.15.20 | anthropic / anthropic-messages | scoped_registration_cleanup | async | no | no | native_executor | native_model | implemented |
| python / crewai 1.15.20 | anthropic / anthropic-messages | litellm_composition | sync | no | no | native_executor | native_model | implemented |
| python / crewai 1.15.20 | anthropic / anthropic-messages | litellm_composition | async | no | no | native_executor | native_model | implemented |

[Operation manifests and exact evidence references](../../packages/middleware/conformance/support/manifests/F10.json)

</details>

<details><summary>F11 AutoGen</summary>

| Language / pinned framework | Provider / protocol | Required operation | Execution | Stream | Structured | Recovery | Required visibility | State |
|---|---|---|---|---|---|---|---|---|
| python / autogen-agentchat 0.7.5 | openai / openai-chat-completions | ChatCompletionClient.create | async | no | no | model_only | native_model | implemented |
| python / autogen-agentchat 0.7.5 | openai / openai-chat-completions | ChatCompletionClient.create_stream | async | yes | no | model_only | native_model | implemented |
| python / autogen-agentchat 0.7.5 | openai / openai-chat-completions | ChatCompletionClient.structured_output | async | no | yes | model_only | native_model | implemented |
| python / autogen-agentchat 0.7.5 | openai / openai-chat-completions | AssistantAgent.run | async | no | no | native_executor | native_model | implemented |
| python / autogen-agentchat 0.7.5 | openai / openai-chat-completions | AssistantAgent.run_stream | async | yes | no | native_executor | native_model | implemented |
| python / autogen-agentchat 0.7.5 | openai / openai-chat-completions | workbench_recovery | async | no | no | native_executor | native_model | implemented |
| python / autogen-agentchat 0.7.5 | openai / openai-chat-completions | parallel_tools_and_multiple_workbenches | async | no | no | native_executor | native_model | implemented |
| python / autogen-agentchat 0.7.5 | openai / openai-chat-completions | multiagent_contexts | async | no | no | native_executor | native_model | implemented |
| python / autogen-agentchat 0.7.5 | openai / openai-chat-completions | serialization_and_configuration | async | no | no | native_executor | native_model | implemented |
| python / autogen-agentchat 0.7.5 | openai / openai-chat-completions | cancel_and_close | async | yes | no | native_executor | native_model | implemented |
| python / autogen-agentchat 0.7.5 | anthropic / anthropic-messages | ChatCompletionClient.create | async | no | no | model_only | native_model | implemented |
| python / autogen-agentchat 0.7.5 | anthropic / anthropic-messages | ChatCompletionClient.create_stream | async | yes | no | model_only | native_model | implemented |
| python / autogen-agentchat 0.7.5 | anthropic / anthropic-messages | ChatCompletionClient.structured_output | async | no | yes | model_only | native_model | implemented |
| python / autogen-agentchat 0.7.5 | anthropic / anthropic-messages | AssistantAgent.run | async | no | no | native_executor | native_model | implemented |
| python / autogen-agentchat 0.7.5 | anthropic / anthropic-messages | AssistantAgent.run_stream | async | yes | no | native_executor | native_model | implemented |
| python / autogen-agentchat 0.7.5 | anthropic / anthropic-messages | workbench_recovery | async | no | no | native_executor | native_model | implemented |
| python / autogen-agentchat 0.7.5 | anthropic / anthropic-messages | parallel_tools_and_multiple_workbenches | async | no | no | native_executor | native_model | implemented |
| python / autogen-agentchat 0.7.5 | anthropic / anthropic-messages | multiagent_contexts | async | no | no | native_executor | native_model | implemented |
| python / autogen-agentchat 0.7.5 | anthropic / anthropic-messages | serialization_and_configuration | async | no | no | native_executor | native_model | implemented |
| python / autogen-agentchat 0.7.5 | anthropic / anthropic-messages | cancel_and_close | async | yes | no | native_executor | native_model | implemented |

[Operation manifests and exact evidence references](../../packages/middleware/conformance/support/manifests/F11.json)

</details>

<details><summary>F12 ASGI / FastAPI / Starlette</summary>

| Language / pinned framework | Provider / protocol | Required operation | Execution | Stream | Structured | Recovery | Required visibility | State |
|---|---|---|---|---|---|---|---|---|
| python / fastapi 0.141.1 | openai / openai-chat-completions | fastapi.allowlisted_post | transport | no | no | operator_bound | provider_http | implemented |
| python / fastapi 0.141.1 | openai / openai-chat-completions | fastapi.allowlisted_post.sse | transport | yes | no | operator_bound | provider_http | implemented |
| python / starlette 1.6.0 | openai / openai-chat-completions | starlette.allowlisted_post | transport | no | no | operator_bound | provider_http | implemented |
| python / starlette 1.6.0 | openai / openai-chat-completions | starlette.allowlisted_post.sse | transport | yes | no | operator_bound | provider_http | implemented |
| python / fastapi 0.141.1 | openai / openai-chat-completions | structured_output | transport | no | yes | model_only | provider_http | implemented |
| python / fastapi 0.141.1 | openai / openai-chat-completions | split_request_chunks | transport | no | no | operator_bound | provider_http | implemented |
| python / fastapi 0.141.1 | openai / openai-chat-completions | early_disconnect | transport | no | no | operator_bound | provider_http | implemented |
| python / fastapi 0.141.1 | openai / openai-chat-completions | oversized_body_replay | transport | no | no | operator_bound | provider_http | implemented |
| python / fastapi 0.141.1 | openai / openai-chat-completions | auth_guardrail_order | transport | no | no | operator_bound | provider_http | implemented |
| python / fastapi 0.141.1 | openai / openai-chat-completions | encoded_body_passthrough | transport | no | no | operator_bound | provider_http | implemented |
| python / fastapi 0.141.1 | openai / openai-chat-completions | unrelated_route_lifespan_websocket_passthrough | transport | no | no | operator_bound | provider_http | implemented |
| python / fastapi 0.141.1 | openai / openai-responses | fastapi.allowlisted_post | transport | no | no | operator_bound | provider_http | implemented |
| python / fastapi 0.141.1 | openai / openai-responses | fastapi.allowlisted_post.sse | transport | yes | no | operator_bound | provider_http | implemented |
| python / starlette 1.6.0 | openai / openai-responses | starlette.allowlisted_post | transport | no | no | operator_bound | provider_http | implemented |
| python / starlette 1.6.0 | openai / openai-responses | starlette.allowlisted_post.sse | transport | yes | no | operator_bound | provider_http | implemented |
| python / fastapi 0.141.1 | openai / openai-responses | structured_output | transport | no | yes | model_only | provider_http | implemented |
| python / fastapi 0.141.1 | openai / openai-responses | split_request_chunks | transport | no | no | operator_bound | provider_http | implemented |
| python / fastapi 0.141.1 | openai / openai-responses | early_disconnect | transport | no | no | operator_bound | provider_http | implemented |
| python / fastapi 0.141.1 | openai / openai-responses | oversized_body_replay | transport | no | no | operator_bound | provider_http | implemented |
| python / fastapi 0.141.1 | openai / openai-responses | auth_guardrail_order | transport | no | no | operator_bound | provider_http | implemented |
| python / fastapi 0.141.1 | openai / openai-responses | encoded_body_passthrough | transport | no | no | operator_bound | provider_http | implemented |
| python / fastapi 0.141.1 | openai / openai-responses | unrelated_route_lifespan_websocket_passthrough | transport | no | no | operator_bound | provider_http | implemented |
| python / fastapi 0.141.1 | anthropic / anthropic-messages | fastapi.allowlisted_post | transport | no | no | operator_bound | provider_http | implemented |
| python / fastapi 0.141.1 | anthropic / anthropic-messages | fastapi.allowlisted_post.sse | transport | yes | no | operator_bound | provider_http | implemented |
| python / starlette 1.6.0 | anthropic / anthropic-messages | starlette.allowlisted_post | transport | no | no | operator_bound | provider_http | implemented |
| python / starlette 1.6.0 | anthropic / anthropic-messages | starlette.allowlisted_post.sse | transport | yes | no | operator_bound | provider_http | implemented |
| python / fastapi 0.141.1 | anthropic / anthropic-messages | structured_output | transport | no | yes | model_only | provider_http | implemented |
| python / fastapi 0.141.1 | anthropic / anthropic-messages | split_request_chunks | transport | no | no | operator_bound | provider_http | implemented |
| python / fastapi 0.141.1 | anthropic / anthropic-messages | early_disconnect | transport | no | no | operator_bound | provider_http | implemented |
| python / fastapi 0.141.1 | anthropic / anthropic-messages | oversized_body_replay | transport | no | no | operator_bound | provider_http | implemented |
| python / fastapi 0.141.1 | anthropic / anthropic-messages | auth_guardrail_order | transport | no | no | operator_bound | provider_http | implemented |
| python / fastapi 0.141.1 | anthropic / anthropic-messages | encoded_body_passthrough | transport | no | no | operator_bound | provider_http | implemented |
| python / fastapi 0.141.1 | anthropic / anthropic-messages | unrelated_route_lifespan_websocket_passthrough | transport | no | no | operator_bound | provider_http | implemented |

[Operation manifests and exact evidence references](../../packages/middleware/conformance/support/manifests/F12.json)

</details>

<details><summary>F13 MCP</summary>

| Language / pinned framework | Provider / protocol | Required operation | Execution | Stream | Structured | Recovery | Required visibility | State |
|---|---|---|---|---|---|---|---|---|
| python / mcp 2.2.0 | host / mcp-2026-07-28 | stdio.call_tool | async | no | no | native_executor | host_result | implemented |
| python / mcp 2.2.0 | host / mcp-2026-07-28 | streamable_http.call_tool | async | no | no | native_executor | host_result | implemented |
| python / mcp 2.2.0 | host / mcp-2026-07-28 | host_recovery_registration | async | no | no | native_executor | host_result | implemented |
| python / mcp 2.2.0 | host / mcp-2026-07-28 | native_result_identity_and_blocks | async | no | no | native_executor | host_result | implemented |
| python / mcp 2.2.0 | host / mcp-2026-07-28 | stdio.host_stream | async | yes | no | native_executor | host_result | implemented |
| python / mcp 2.2.0 | host / mcp-2026-07-28 | streamable_http.host_stream | async | yes | no | native_executor | host_result | implemented |
| python / mcp 2.2.0 | host / mcp-2026-07-28 | cancel_and_options | async | no | no | native_executor | host_result | implemented |
| python / mcp 2.2.0 | host / mcp-2026-07-28 | twenty_turn_restart | async | no | no | native_executor | host_result | implemented |
| python / mcp 2.2.0 | host / mcp-2024-11-05 | existing_server_interoperation | async | no | no | native_executor | host_result | implemented |
| python / mcp 2.2.0 | host / mcp-2026-07-28 | structuredContent_and_outputSchema | async | no | yes | model_only | host_result | implemented |
| python / mcp 2.2.0 | host / mcp-2026-07-28 | mixed_structured_text_protection | async | no | yes | model_only | host_result | implemented |
| typescript / @modelcontextprotocol/sdk 1.30.0 | host / mcp-2025-11-25 | stdio.call_tool | async | no | no | native_executor | host_result | implemented |
| typescript / @modelcontextprotocol/sdk 1.30.0 | host / mcp-2025-11-25 | streamable_http.call_tool | async | no | no | native_executor | host_result | implemented |
| typescript / @modelcontextprotocol/sdk 1.30.0 | host / mcp-2025-11-25 | host_recovery_registration | async | no | no | native_executor | host_result | implemented |
| typescript / @modelcontextprotocol/sdk 1.30.0 | host / mcp-2025-11-25 | native_result_identity_and_blocks | async | no | no | native_executor | host_result | implemented |
| typescript / @modelcontextprotocol/sdk 1.30.0 | host / mcp-2025-11-25 | stdio.host_stream | async | yes | no | native_executor | host_result | implemented |
| typescript / @modelcontextprotocol/sdk 1.30.0 | host / mcp-2025-11-25 | streamable_http.host_stream | async | yes | no | native_executor | host_result | implemented |
| typescript / @modelcontextprotocol/sdk 1.30.0 | host / mcp-2025-11-25 | cancel_and_options | async | no | no | native_executor | host_result | implemented |
| typescript / @modelcontextprotocol/sdk 1.30.0 | host / mcp-2025-11-25 | twenty_turn_restart | async | no | no | native_executor | host_result | implemented |
| typescript / @modelcontextprotocol/sdk 1.30.0 | host / mcp-2024-11-05 | existing_server_interoperation | async | no | no | native_executor | host_result | implemented |
| typescript / @modelcontextprotocol/sdk 1.30.0 | host / mcp-2025-11-25 | structuredContent_and_outputSchema | async | no | yes | model_only | host_result | implemented |
| typescript / @modelcontextprotocol/sdk 1.30.0 | host / mcp-2025-11-25 | mixed_structured_text_protection | async | no | yes | model_only | host_result | implemented |

[Operation manifests and exact evidence references](../../packages/middleware/conformance/support/manifests/F13.json)

</details>

<details><summary>F14 Pydantic AI</summary>

| Language / pinned framework | Provider / protocol | Required operation | Execution | Stream | Structured | Recovery | Required visibility | State |
|---|---|---|---|---|---|---|---|---|
| python / pydantic-ai 2.42.0 | openai / openai-chat-completions | Agent.run | sync | no | no | native_executor | native_model | implemented |
| python / pydantic-ai 2.42.0 | openai / openai-chat-completions | Agent.run | async | no | no | native_executor | native_model | implemented |
| python / pydantic-ai 2.42.0 | openai / openai-chat-completions | Agent.run_stream | sync | yes | no | native_executor | native_model | implemented |
| python / pydantic-ai 2.42.0 | openai / openai-chat-completions | Agent.run_stream | async | yes | no | native_executor | native_model | implemented |
| python / pydantic-ai 2.42.0 | openai / openai-chat-completions | Agent.run.typed | sync | no | yes | model_only | native_model | implemented |
| python / pydantic-ai 2.42.0 | openai / openai-chat-completions | Agent.run.typed | async | no | yes | model_only | native_model | implemented |
| python / pydantic-ai 2.42.0 | openai / openai-chat-completions | Agent.run_stream.typed | sync | yes | yes | model_only | native_model | implemented |
| python / pydantic-ai 2.42.0 | openai / openai-chat-completions | Agent.run_stream.typed | async | yes | yes | model_only | native_model | implemented |
| python / pydantic-ai 2.42.0 | openai / openai-chat-completions | RetryPromptPart_and_ToolReturnPart | sync | no | no | native_executor | native_model | implemented |
| python / pydantic-ai 2.42.0 | openai / openai-chat-completions | RetryPromptPart_and_ToolReturnPart | async | no | no | native_executor | native_model | implemented |
| python / pydantic-ai 2.42.0 | openai / openai-chat-completions | dependencies_usage_and_capabilities | sync | no | no | native_executor | native_model | implemented |
| python / pydantic-ai 2.42.0 | openai / openai-chat-completions | dependencies_usage_and_capabilities | async | no | no | native_executor | native_model | implemented |
| python / pydantic-ai 2.42.0 | openai / openai-chat-completions | history_resume | sync | no | no | native_executor | native_model | implemented |
| python / pydantic-ai 2.42.0 | openai / openai-chat-completions | history_resume | async | no | no | native_executor | native_model | implemented |
| python / pydantic-ai 2.42.0 | openai / openai-chat-completions | every_model_continuation | sync | no | no | native_executor | native_model | implemented |
| python / pydantic-ai 2.42.0 | openai / openai-chat-completions | every_model_continuation | async | no | no | native_executor | native_model | implemented |
| python / pydantic-ai 2.42.0 | openai / openai-chat-completions | cancel_and_close | sync | yes | no | native_executor | native_model | implemented |
| python / pydantic-ai 2.42.0 | openai / openai-chat-completions | cancel_and_close | async | yes | no | native_executor | native_model | implemented |
| python / pydantic-ai 2.42.0 | openai / openai-chat-completions | model_only | sync | no | no | model_only | native_model | implemented |
| python / pydantic-ai 2.42.0 | openai / openai-chat-completions | model_only | async | no | no | model_only | native_model | implemented |
| python / pydantic-ai 2.42.0 | anthropic / anthropic-messages | Agent.run | sync | no | no | native_executor | native_model | implemented |
| python / pydantic-ai 2.42.0 | anthropic / anthropic-messages | Agent.run | async | no | no | native_executor | native_model | implemented |
| python / pydantic-ai 2.42.0 | anthropic / anthropic-messages | Agent.run_stream | sync | yes | no | native_executor | native_model | implemented |
| python / pydantic-ai 2.42.0 | anthropic / anthropic-messages | Agent.run_stream | async | yes | no | native_executor | native_model | implemented |
| python / pydantic-ai 2.42.0 | anthropic / anthropic-messages | Agent.run.typed | sync | no | yes | model_only | native_model | implemented |
| python / pydantic-ai 2.42.0 | anthropic / anthropic-messages | Agent.run.typed | async | no | yes | model_only | native_model | implemented |
| python / pydantic-ai 2.42.0 | anthropic / anthropic-messages | Agent.run_stream.typed | sync | yes | yes | model_only | native_model | implemented |
| python / pydantic-ai 2.42.0 | anthropic / anthropic-messages | Agent.run_stream.typed | async | yes | yes | model_only | native_model | implemented |
| python / pydantic-ai 2.42.0 | anthropic / anthropic-messages | RetryPromptPart_and_ToolReturnPart | sync | no | no | native_executor | native_model | implemented |
| python / pydantic-ai 2.42.0 | anthropic / anthropic-messages | RetryPromptPart_and_ToolReturnPart | async | no | no | native_executor | native_model | implemented |
| python / pydantic-ai 2.42.0 | anthropic / anthropic-messages | dependencies_usage_and_capabilities | sync | no | no | native_executor | native_model | implemented |
| python / pydantic-ai 2.42.0 | anthropic / anthropic-messages | dependencies_usage_and_capabilities | async | no | no | native_executor | native_model | implemented |
| python / pydantic-ai 2.42.0 | anthropic / anthropic-messages | history_resume | sync | no | no | native_executor | native_model | implemented |
| python / pydantic-ai 2.42.0 | anthropic / anthropic-messages | history_resume | async | no | no | native_executor | native_model | implemented |
| python / pydantic-ai 2.42.0 | anthropic / anthropic-messages | every_model_continuation | sync | no | no | native_executor | native_model | implemented |
| python / pydantic-ai 2.42.0 | anthropic / anthropic-messages | every_model_continuation | async | no | no | native_executor | native_model | implemented |
| python / pydantic-ai 2.42.0 | anthropic / anthropic-messages | cancel_and_close | sync | yes | no | native_executor | native_model | implemented |
| python / pydantic-ai 2.42.0 | anthropic / anthropic-messages | cancel_and_close | async | yes | no | native_executor | native_model | implemented |
| python / pydantic-ai 2.42.0 | anthropic / anthropic-messages | model_only | sync | no | no | model_only | native_model | implemented |
| python / pydantic-ai 2.42.0 | anthropic / anthropic-messages | model_only | async | no | no | model_only | native_model | implemented |

[Operation manifests and exact evidence references](../../packages/middleware/conformance/support/manifests/F14.json)

</details>

<details><summary>F15 LlamaIndex</summary>

| Language / pinned framework | Provider / protocol | Required operation | Execution | Stream | Structured | Recovery | Required visibility | State |
|---|---|---|---|---|---|---|---|---|
| python / llama-index-core 0.14.24 | openai / openai-chat-completions | query | sync | no | no | operator_bound | native_model | implemented |
| python / llama-index-core 0.14.24 | openai / openai-chat-completions | query | async | no | no | operator_bound | native_model | implemented |
| python / llama-index-core 0.14.24 | openai / openai-chat-completions | query.stream | sync | yes | no | operator_bound | native_model | implemented |
| python / llama-index-core 0.14.24 | openai / openai-chat-completions | query.stream | async | yes | no | operator_bound | native_model | implemented |
| python / llama-index-core 0.14.24 | openai / openai-chat-completions | node_postprocessor | sync | no | no | operator_bound | native_model | implemented |
| python / llama-index-core 0.14.24 | openai / openai-chat-completions | node_postprocessor | async | no | no | operator_bound | native_model | implemented |
| python / llama-index-core 0.14.24 | openai / openai-chat-completions | node_postprocessor.no_expansion | sync | no | no | model_only | native_model | implemented |
| python / llama-index-core 0.14.24 | openai / openai-chat-completions | node_postprocessor.no_expansion | async | no | no | model_only | native_model | implemented |
| python / llama-index-core 0.14.24 | openai / openai-chat-completions | source_identity_scores_metadata_and_citations | sync | no | no | operator_bound | native_model | implemented |
| python / llama-index-core 0.14.24 | openai / openai-chat-completions | source_identity_scores_metadata_and_citations | async | no | no | operator_bound | native_model | implemented |
| python / llama-index-core 0.14.24 | openai / openai-chat-completions | LLM.chat | sync | no | no | native_executor | native_model | implemented |
| python / llama-index-core 0.14.24 | openai / openai-chat-completions | LLM.chat | async | no | no | native_executor | native_model | implemented |
| python / llama-index-core 0.14.24 | openai / openai-chat-completions | LLM.stream_chat | sync | yes | no | native_executor | native_model | implemented |
| python / llama-index-core 0.14.24 | openai / openai-chat-completions | LLM.stream_chat | async | yes | no | native_executor | native_model | implemented |
| python / llama-index-core 0.14.24 | openai / openai-chat-completions | LLM.complete | sync | no | no | model_only | native_model | implemented |
| python / llama-index-core 0.14.24 | openai / openai-chat-completions | LLM.complete | async | no | no | model_only | native_model | implemented |
| python / llama-index-core 0.14.24 | openai / openai-chat-completions | LLM.stream_complete | sync | yes | no | model_only | native_model | implemented |
| python / llama-index-core 0.14.24 | openai / openai-chat-completions | LLM.stream_complete | async | yes | no | model_only | native_model | implemented |
| python / llama-index-core 0.14.24 | openai / openai-chat-completions | LLM.structured_output | sync | no | yes | model_only | native_model | implemented |
| python / llama-index-core 0.14.24 | openai / openai-chat-completions | LLM.structured_output | async | no | yes | model_only | native_model | implemented |
| python / llama-index-core 0.14.24 | anthropic / anthropic-messages | query | sync | no | no | operator_bound | native_model | implemented |
| python / llama-index-core 0.14.24 | anthropic / anthropic-messages | query | async | no | no | operator_bound | native_model | implemented |
| python / llama-index-core 0.14.24 | anthropic / anthropic-messages | query.stream | sync | yes | no | operator_bound | native_model | implemented |
| python / llama-index-core 0.14.24 | anthropic / anthropic-messages | query.stream | async | yes | no | operator_bound | native_model | implemented |
| python / llama-index-core 0.14.24 | anthropic / anthropic-messages | node_postprocessor | sync | no | no | operator_bound | native_model | implemented |
| python / llama-index-core 0.14.24 | anthropic / anthropic-messages | node_postprocessor | async | no | no | operator_bound | native_model | implemented |
| python / llama-index-core 0.14.24 | anthropic / anthropic-messages | node_postprocessor.no_expansion | sync | no | no | model_only | native_model | implemented |
| python / llama-index-core 0.14.24 | anthropic / anthropic-messages | node_postprocessor.no_expansion | async | no | no | model_only | native_model | implemented |
| python / llama-index-core 0.14.24 | anthropic / anthropic-messages | source_identity_scores_metadata_and_citations | sync | no | no | operator_bound | native_model | implemented |
| python / llama-index-core 0.14.24 | anthropic / anthropic-messages | source_identity_scores_metadata_and_citations | async | no | no | operator_bound | native_model | implemented |
| python / llama-index-core 0.14.24 | anthropic / anthropic-messages | LLM.chat | sync | no | no | native_executor | native_model | implemented |
| python / llama-index-core 0.14.24 | anthropic / anthropic-messages | LLM.chat | async | no | no | native_executor | native_model | implemented |
| python / llama-index-core 0.14.24 | anthropic / anthropic-messages | LLM.stream_chat | sync | yes | no | native_executor | native_model | implemented |
| python / llama-index-core 0.14.24 | anthropic / anthropic-messages | LLM.stream_chat | async | yes | no | native_executor | native_model | implemented |
| python / llama-index-core 0.14.24 | anthropic / anthropic-messages | LLM.complete | sync | no | no | model_only | native_model | implemented |
| python / llama-index-core 0.14.24 | anthropic / anthropic-messages | LLM.complete | async | no | no | model_only | native_model | implemented |
| python / llama-index-core 0.14.24 | anthropic / anthropic-messages | LLM.stream_complete | sync | yes | no | model_only | native_model | implemented |
| python / llama-index-core 0.14.24 | anthropic / anthropic-messages | LLM.stream_complete | async | yes | no | model_only | native_model | implemented |
| python / llama-index-core 0.14.24 | anthropic / anthropic-messages | LLM.structured_output | sync | no | yes | model_only | native_model | implemented |
| python / llama-index-core 0.14.24 | anthropic / anthropic-messages | LLM.structured_output | async | no | yes | model_only | native_model | implemented |

[Operation manifests and exact evidence references](../../packages/middleware/conformance/support/manifests/F15.json)

</details>

<details><summary>F16 Mastra</summary>

| Language / pinned framework | Provider / protocol | Required operation | Execution | Stream | Structured | Recovery | Required visibility | State |
|---|---|---|---|---|---|---|---|---|
| typescript / @mastra/core 1.65.0 | openai / openai-chat-completions | agent.generate | async | no | no | native_executor | native_model | implemented |
| typescript / @mastra/core 1.65.0 | openai / openai-chat-completions | agent.stream | async | yes | no | native_executor | native_model | implemented |
| typescript / @mastra/core 1.65.0 | openai / openai-chat-completions | agent.structured_output | async | no | yes | model_only | native_model | implemented |
| typescript / @mastra/core 1.65.0 | openai / openai-chat-completions | processLLMRequest.every_step | async | no | no | native_executor | native_model | implemented |
| typescript / @mastra/core 1.65.0 | openai / openai-chat-completions | MessageList_memory_and_UI_history | async | no | no | native_executor | native_model | implemented |
| typescript / @mastra/core 1.65.0 | openai / openai-chat-completions | workflow_suspend_resume | async | no | no | native_executor | native_model | implemented |
| typescript / @mastra/core 1.65.0 | openai / openai-chat-completions | native_tool_execution | async | no | no | native_executor | native_model | implemented |
| typescript / @mastra/core 1.65.0 | openai / openai-chat-completions | nested_AI_SDK_ownership | async | no | no | native_executor | native_model | implemented |
| typescript / @mastra/core 1.65.0 | openai / openai-chat-completions | cancel_and_close | async | yes | no | native_executor | native_model | implemented |
| typescript / @mastra/core 1.65.0 | anthropic / anthropic-messages | agent.generate | async | no | no | native_executor | native_model | implemented |
| typescript / @mastra/core 1.65.0 | anthropic / anthropic-messages | agent.stream | async | yes | no | native_executor | native_model | implemented |
| typescript / @mastra/core 1.65.0 | anthropic / anthropic-messages | agent.structured_output | async | no | yes | model_only | native_model | implemented |
| typescript / @mastra/core 1.65.0 | anthropic / anthropic-messages | processLLMRequest.every_step | async | no | no | native_executor | native_model | implemented |
| typescript / @mastra/core 1.65.0 | anthropic / anthropic-messages | MessageList_memory_and_UI_history | async | no | no | native_executor | native_model | implemented |
| typescript / @mastra/core 1.65.0 | anthropic / anthropic-messages | workflow_suspend_resume | async | no | no | native_executor | native_model | implemented |
| typescript / @mastra/core 1.65.0 | anthropic / anthropic-messages | native_tool_execution | async | no | no | native_executor | native_model | implemented |
| typescript / @mastra/core 1.65.0 | anthropic / anthropic-messages | nested_AI_SDK_ownership | async | no | no | native_executor | native_model | implemented |
| typescript / @mastra/core 1.65.0 | anthropic / anthropic-messages | cancel_and_close | async | yes | no | native_executor | native_model | implemented |

[Operation manifests and exact evidence references](../../packages/middleware/conformance/support/manifests/F16.json)

</details>

