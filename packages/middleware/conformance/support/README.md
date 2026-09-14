# Framework support inventory

This directory records required scope and current source coverage. The generated
operation manifests obey the shared middleware-support schema. They are not a
release certificate. `verify-support.mjs` accepts honest incomplete coverage;
`--audit-completion` exits nonzero while any required proof remains open.

Run from the repository root:

```sh
node packages/middleware/conformance/support/build-source-inventory.mjs
node packages/middleware/conformance/verify-support.mjs
node --test packages/middleware/conformance/support/verify-support.test.mjs
node packages/middleware/conformance/verify-support.mjs --audit-completion --json
```

The source capture command deliberately resets certification to `implemented`
or `missing`. It never imports a framework, runs a provider, or promotes a row
from an existing `evidence.json`. Run it after concurrent edits settle. Source,
test declaration, lock, and specification changes invalidate the old snapshot.

`catalog.mjs` freezes public method and behavior cells across the required
language/provider/protocol axes. All shared requirements still apply to every
operation; the method list does not replace the 180 exact acceptance items in
`traceability.json`. `knownImplementationGaps` records inspected omissions
without removing their mandatory cells. Resolve the implementation before
removing a gap note. The public Markdown matrix is generated from the same data.

Test names in manifests and traceability are related source locators. Some cover
only part of a criterion. No row becomes conformant because a matching string
or a test file exists. When promoting a row, review and narrow its named test
mapping to the operation actually exercised.

Certification needs a `native_fixture` JSON artifact with producer
`caveman-middleware-native-run-v1`, exact `cells`, `framework_versions`,
`adapter_version`, `runtime_protocol`, `runtime.build`, the actual runtime
`binary_sha256`, and `runtime.source_lock_sha256`. It records named `tests` with
passing results, a hashed `raw_output` file, and each assertion in
`catalog.mjs::mandatoryJourney`. The artifact must state
`local_provider_fixture:true` and `external_inference_requests:0`.

Each `journey` assertion contains `test_id` and an `observation` object with
concrete observed values such as original/recovered digests or request counts.
The executing test emits the matching JSON object on a line starting with
`CAVEMAN_MIDDLEWARE_OBSERVATION `, with `cell_id`, `assertion`, `test_id`, and
`observation`. A TAP pass is not itself a journey observation. A copied assertion
or handwritten success field does not qualify: `--replay` executes cataloged
test files again and requires the same scoped observations in the new output.
Native suites produce per-operation candidates and independent replay output;
neither artifact alone changes the shared support matrix.

`promote.mjs` validates the exact source/build inputs, original observations,
and a fresh native replay before creating reviewable operation rows. It does
not write shared manifests. `apply-support.mjs` then independently replays the
proposed rows before applying them and regenerating the public matrix:

```sh
node packages/middleware/conformance/support/promote.mjs \
  --inputs=examples/middleware/FRAMEWORK/certification/RUN/inputs.json \
  --coverage=examples/middleware/FRAMEWORK/certification/RUN/coverage.json \
  --output=packages/middleware/conformance/support/evidence/PROMOTION

node packages/middleware/conformance/support/apply-support.mjs \
  --promotion=packages/middleware/conformance/support/evidence/PROMOTION/promotion.json \
  --python-map=/tmp/exact-python-interpreters.json

node packages/middleware/conformance/verify-support.mjs --replay \
  --python-map=/tmp/exact-python-interpreters.json
```

Replace the uppercase path components with an actual framework capture and a
new output directory. For Python, also pass `--python=EXACT_INTERPRETER` to
`promote.mjs`; the JSON map used by application and verification maps scopes
such as `"F01:python"` to those exact interpreter paths. Multiple `--promotion`
arguments may be applied together. Native replay output defaults to a new
ignored directory below `.artifacts/middleware-support/`; `--replay-output`
selects an explicit new repository directory. Invalid candidates and concurrent
inventory edits abort application before shared manifests are changed.

Shared runtime acceptance uses the separate
[whole-criterion mapping and native producer](acceptance.md). Supplying its
report as `--acceptance=PATH` applies only completely observed criteria after a
new native execution. Partial components remain partial. Release gates have
exhaustive membership in `release-gates.json`; accepting an operation or a
criterion never automatically passes a release gate. The qualified validator
rejects saved pass flags and caller-provided hash sets as execution evidence.

`--replay` uses local test drivers and removes provider credential variables from
their environment. It never executes commands supplied by an artifact and has
no live-provider runner. Python replay requires
an explicit interpreter for each family/language scope. `provider_tested`
additionally requires a separate real-provider artifact with
provider/model/version/date/endpoint/auth data, explicit opt-in, a positive
budget, complete usage status, and hashed raw receipts. The local fixture run
still has to pass independently. The qualified application path currently
refuses `provider_tested`; local native promotions cannot create that state.

`not_applicable` requires a versioned `upstream_api_absence` record identifying
the exact cell, framework, version, method, immutable source URL/revision,
excerpt, and reason. Registry metadata cannot prove an API is absent.

The validator imports Ajv from the existing shared-contract package. Install the
workspace dependencies before running it. No new runtime dependency or framework
dependency is added by the inventory.
