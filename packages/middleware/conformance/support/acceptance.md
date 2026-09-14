# Shared runtime acceptance evidence

`acceptance.mjs` executes the real Go Engine, persistent stores, and middleware
HTTP handler. It discovers eleven literal test declarations and requires all 25
criterion observations from each of two native parent processes with fresh challenges.
Each run captures the actual executable, Go build provenance, compiled source
closure, exact specification text, test declarations, producer dependencies,
stdout, and stderr. Source and build identity must match before and after each
execution. Each parent also captures three child test processes for the restart
fixture. A separate verifier executes another fresh parent and its children.

The current decomposition has **9 covered, 15 partial, and 156 missing** criteria
out of 180. The mapping retains the complete text and outstanding work for every
criterion. Component counts do not change a partial criterion into a complete
one. No framework support or provider-quality status is promoted by this run.

| Covered criterion | Executed behavior |
| --- | --- |
| `runtime.R2.AC04` | Identical scoped replay preserves chosen replacements; changed original content under the same idempotency key is rejected. |
| `runtime.R5.AC05` | Bounded pages reconstruct exact UTF-8 bytes; bounded search is labeled as an excerpt; original identity and explicit continuation fields remain present. Invalid ranges and oversized requests are rejected. |
| `runtime.R6.AC02` | Twenty turns append twenty distinct originals. After the seed process exits, two separate workers reopen both stores and reproduce all earlier replacement bytes and recovery markers at each synchronized turn. |
| `runtime.R6.AC03` | Twelve concurrent requests across two runtime/store instances converge on one choice. A separate read-only database connection sees the committed choice before each response body is written. |
| `runtime.R9.AC01` | Authenticated principal and application namespace boundaries resist cross-scope recovery. |
| `runtime.R9.AC04` | Scoped grants authorize existing originals; a guessed global CCR hash does not. |
| `runtime.R11.AC03` | Reusing replacements or adding a new citation source for the same bytes does not add another unique-content credit. Repeated estimates keep their segment/tokenizer/overhead labels. |
| `runtime.R12.AC04` | Two documents containing identical bytes retain different source identities in exact recovery results. |
| `proof.R3.AC04` | One hundred interleaved scopes exactly recover and reuse their own content. Other principals and namespaces cannot reuse their frozen replacements; recovery also rejects global hash guesses and unauthenticated access. |

The restart fixture executes a seed child for turns 0–9, waits for its actual
exit, then opens worker A and worker B as separate processes against the same
stores for turns 10–19. Both workers reach each turn's prepare gate before either
is released. The parent compares 335 earlier replacements and receives 365 exact
recoveries. Raw child stdout, exit results, executable hashes, PIDs, fresh
challenges, and parent gate order are checked by the verifier. This is runtime
replacement stability; it makes no native-framework or provider-prefix claim.

The separate durable-winner fixture still uses two instances in one process.
The capacity fixture reopens only the CCR store and keeps the replacement store
open. Neither fixture advances through the advertised retention period;
`runtime.R5.AC07` remains partial. Capability
discovery still returns `runtime_build: development` in the shared fixture;
external executable provenance does not turn that value into a build identifier.

The new capture lives in `acceptance-restart-evidence/`. The earlier
`acceptance-evidence/` capture remains unchanged at 7 covered, 15 partial, and
158 missing. Its source snapshot predates this change and is historical evidence.

## Reproduce

Use the Go toolchain required by the root `go.mod`. The build helper accepts
`CAVEMAN_MIDDLEWARE_GO` for an explicit Go executable and
`CAVEMAN_MIDDLEWARE_BUILD_GOCACHE` for a writable cache. Each output directory
must be new; captures are never overwritten.

```sh
node packages/middleware/conformance/support/runtime-build.mjs \
  --target=middleware-tests --output=/tmp/acceptance-build

node packages/middleware/conformance/support/acceptance.mjs \
  --binary=/tmp/acceptance-build/middleware.test \
  --provenance=/tmp/acceptance-build/build.json \
  --output=/tmp/acceptance-evidence

CAVEMAN_MIDDLEWARE_ACCEPTANCE_REPORT=/tmp/acceptance-evidence/report.json \
  node --test packages/middleware/conformance/support/acceptance.test.mjs

node packages/middleware/conformance/support/acceptance.mjs \
  --verify=/tmp/acceptance-evidence/report.json \
  --output=/tmp/acceptance-verification
```

The 17 adversarial checks reject altered metrics, omitted or duplicated tests,
forged test/source associations, missing or reused challenges, modified raw logs,
stale source/build identity, forged child execution or restart order, changed
frozen markers, missing original recoveries, and inflated criterion coverage. Set the report
environment variable to include live provenance and replay checks. Without it,
the tests parse the repository capture and explicitly skip those three live
checks. Historical artifact validation is never reported as a fresh execution.
Fresh verification needs the recorded executable and build artifacts; another
machine must build and capture its own evidence.

## Next mechanism scopes

1. **Retention and broader history transitions** (`runtime.R5.AC07`,
   `proof.R3.AC03`): exercise the documented retention interval across a resumed
   session and capacity pressure. The twenty-turn process fixture now proves
   restart and stable earlier choices across separate workers, but does not
   exercise missing state, policy upgrades, deliberate history edits, or branch
   isolation. Its raw responses do not observe each concurrent durable commit
   before the response body is written.
2. **Identity changes and revoked history** (`runtime.R6.AC01`,
   `runtime.R6.AC05`–`AC07`, `runtime.R5.AC08`): vary each identity field, policy,
   and serialization revision; prove behavior for old frozen views. Existing
   expiry/deletion tests reject old handles, but do not prove a native caller
   rebuilding from retained originals while an old marker-only caller fails.
3. **Native request, ownership, and retry proof** (`runtime.R1`, `runtime.R2`,
   `runtime.R7`, `runtime.R8`): connect exact, current native certification
   observations to the relevant criterion components. Require the captured
   provider bytes and actual callback/attempt assertions where the criterion
   asks for them; a related test name or an eight-step journey count is
   insufficient. Keep missing portions explicit.
4. **Product build identity** (`runtime.R3.AC02`): prove the identifier returned
   by the actual product initialization path. `Config.Build` accepts an injected
   value already; injecting a hash only in a test proves that injection path,
   not identification of ordinary product builds.
