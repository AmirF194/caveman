# Native three-arm comparison harness

Default execution is an offline plan: no provider imports, credential reads or
external inference. Local fixtures exercise real installed LangChain,
LangGraph, OpenAI, Caveman and Headroom code. They validate this harness and do
not measure provider quality, compatibility or economic benefit.

The hosted comparison uses `langchain.agents.create_agent`, `ChatOpenAI`,
`with_caveman_agent`, and Headroom's public `HeadroomChatModel`. Each arm uses the
same native agent scheduler and application tools. The optimizer runs at the
native model-call extension layer. There is no Headroom proxy arm.

## Frozen experiment

`corpus.json` contains 24 original CC0 tasks, six each for coding, multi-step
tool work, citation-checked RAG and structured data. Small, no-op and negative
cases stay in the aggregate. `corpus.sha256` prevents unnoticed fixture changes;
`corpus.py` records their construction and is not run automatically.

Every task runs three rotated arm orders. Each task/arm/rotation uses an isolated
worker process with a cold run followed by a warm run: 432 task runs in total.
Application files and conversation history reset between the two runs, while
the native agent and optimizer instance remain alive. The fixed scope salt is
the first system-message content and the OpenAI `prompt_cache_key`. Different
arms and repetitions use distinct scope identities. A scheduled warm run is
not a claimed cache hit: only observed provider usage establishes that.

Each run allows ten physical provider calls, 24 application tool calls, 2,048
output tokens per call and 16 KiB of coding edits. The parent terminates a
stratum after 120 seconds and a task pair after 270 seconds, including startup;
each HTTP request retains a 30-second client timeout.
All arms use native SDK retry limit zero. Model, reasoning effort, application
tool schemas, permissions, fixtures and limits remain fixed. Caveman's recovery
tool is an explicit additional native tool; its request and output costs count.

Application tools can list/read the in-memory task files, write `solution.py`,
and run public checks. Hidden checks never appear in tool definitions or
responses. Coding oracles accept a restricted pure-Python function subset,
reject imports, I/O and reflection, and run in a separate child with a two-second
CPU limit and five-second wall limit. Linux supports a 256 MiB address-space
limit; macOS uses sampled child RSS because its `RLIMIT_AS` setter rejects this
limit. The result records which mechanism ran. This is a constrained task
oracle, not a general-purpose sandbox for arbitrary programs.

## Install and run local controls

The common dependency intersection is Python 3.14. Headroom 0.37.0's upstream
Python marker excludes LiteLLM there. On Python 3.13 the frozen OpenAI 3.10.0
and Headroom's LiteLLM dependency do not resolve together. No `--no-deps`
installation or source-package substitution is used to hide that conflict.

From the repository root, build the SDK and middleware wheels and retain their
paths and SHA256 values. Then use a new isolated environment:

```sh
uv venv --python 3.14 /tmp/caveman-hosted-env
uv pip install --python /tmp/caveman-hosted-env/bin/python --require-hashes \
  -r packages/middleware/conformance/hosted/requirements.lock
uv pip install --python /tmp/caveman-hosted-env/bin/python \
  /absolute/path/caveman_sdk-1.0.0-py3-none-any.whl \
  /absolute/path/caveman_middleware-0.1.0-py3-none-any.whl
python3 packages/middleware/conformance/hosted/run.py --output /tmp/caveman-hosted-plan
python3 packages/middleware/conformance/hosted/test_harness.py
CAVEMAN_MIDDLEWARE_TEST_BINARY=/absolute/path/caveman-proxy \
CAVEMAN_MIDDLEWARE_HOSTED_TEST_PYTHON=/tmp/caveman-hosted-env/bin/python \
  node --test packages/middleware/conformance/hosted-native.test.mjs
```

Local controls need loopback sockets and permission to observe their own child
process RSS. The native tests run all three arms in separate processes, force
actual SDK streaming and Caveman recovery, check cache-scope separation and raw
usage redaction, and prove a budget stop, missing usage and an HTTP 503 cannot
dispatch another provider request. Only the remote provider is a fixture.

## Hosted execution requires explicit authorization

Copy `provider-config.example.json` outside this directory and replace every
`REQUIRED_...` field. It intentionally contains no default model or price.
Retain the authoritative pricing page bytes, record their hash and retrieval
date, and review all rates and the model's maximum input-token ceiling. The
reservation is only a valid upper bound when this operator-supplied ceiling and
price snapshot are correct. Set unsupported OpenAI cache-write rates to the
reviewed zero rate; do not use an unknown rate as zero.

The runner checks provider opt-in, a finite positive spend cap, pricing and
source hashes, exact installed versions and distribution payloads before it
reads the selected API-key environment variable. It rejects an existing output
directory. The following command makes paid requests and must only run after
the operator explicitly approves that provider, configuration and positive cap:

```sh
/tmp/caveman-hosted-env/bin/python packages/middleware/conformance/hosted/run.py \
  --run --provider openai --opt-in-provider openai \
  --max-spend-usd APPROVED_POSITIVE_USD_CAP \
  --config /absolute/path/provider-config.json \
  --pricing-source-file /absolute/path/retained-pricing-page.txt \
  --runtime-binary /absolute/path/caveman-proxy \
  --output /absolute/path/new-result-directory
```

The credential must already be available as `OPENAI_API_KEY`; never place it in
the configuration or command arguments. Workers remove unrelated credentials,
tracing and inherited provider/Headroom settings. Headroom configuration and
state use worker-owned temporary directories. Caveman uses an isolated runtime
binary copy and fresh local state; existing application state is not reused.

Before each physical HTTP send, the parent reserves worst-case input/output
cost. Actual complete usage replaces that reservation. Transport failure, cancellation,
missing cache buckets, unknown usage or a lost receipt retains the conservative
amount and stops new calls. Failed requests and model-requested recovery remain
in the total. A worker dying after settlement but before its receipt is written
still leaves a cost record in the parent journal.

`--task-id ID` selects a smoke subset; `--rotations N` allows three through 30
rotations. A subset cannot qualify for a corpus-level superiority claim. New
trials or corpus changes require a new frozen experiment, not selective removal
of failed tasks.

## Artifacts and interpretation

The output contains the plan, corpus/dependency/source hashes, configuration,
retained pricing source, every installed distribution's actual file hashes
(including native binaries), runtime identity, raw redacted receipt JSONL,
task-result JSONL and `report.json`. Request/response content and credentials
are not in receipts. They contain digests, byte counts, provider request IDs,
physical attempt IDs, native retry counts, timings and allowlisted numeric
usage fields. The source snapshot identifies exact installed Headroom payloads;
a version string alone is not represented as an audited Git revision.

Reports keep cold and warm strata separate and publish pass rate, total cost
per passed task including failures, latency, host overhead, output/reasoning
tokens and cache buckets. Missing usage stays unknown with its retained cost
bound. OpenAI cached input is a subset of prompt tokens; reasoning is a subset
of completion tokens, so neither is charged twice. See the official
[Chat Completions usage reference](https://developers.openai.com/api/reference/resources/chat).
The transport also has accounting controls for Anthropic's separate cache-read
and 5-minute/1-hour cache-write buckets, following the official
[prompt-caching usage definitions](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

Uncertainty resamples whole task clusters and keeps all rotations together.
Qualification requires observed quality loss no greater than two percentage
points, a 95% lower quality-difference bound of at least -2 points, and a 95%
lower cost-reduction bound above zero. A small all-success corpus retains an
unseen-discordance bound; it does not establish equivalent quality. Insufficient
evidence is `inconclusive`. All cost results are usage-times-price estimates,
not invoice-reconciled savings.

## Current coverage gaps

- The pinned public Headroom LangChain integration has no native recovery-tool
  registration. Its ordinary application source readers remain available;
  missing optimizer-specific recovery is recorded explicitly.
- Pinned `ChatAnthropic` 1.7.1 has no public HTTP-client injection for physical
  pre-dispatch reservations. `http_client` becomes an invalid provider payload
  field. This comparison refuses Anthropic before credentials; it does not
  replace private clients or substitute a proxy. Native F02 middleware tests
  remain a separate provider-SDK conformance surface.
- Bedrock, Vertex, Azure, OAuth, native Windows and dedicated-host performance
  require separate evidence. Local provider fixtures do not certify them.
- No hosted provider run or invoice reconciliation is supplied by these local
  controls. A real run needs the explicit opt-in and positive cap above.
