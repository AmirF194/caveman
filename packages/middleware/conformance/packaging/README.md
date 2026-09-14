# Installed middleware package checks

Run every public adapter from real npm tarballs and Python wheels in separate,
temporary consumers. The matrix contains eight TypeScript exports, thirteen
Python extras, and one core consumer containing only the two Caveman packages
for each language.

The harness does not publish packages or call paid inference. Native framework
tests use loopback provider fixtures and freshly built Caveman runtime binaries.
Installed package paths must resolve inside the consumer. No workspace package
alias, editable wheel, `PYTHONPATH`, `--no-deps`, `--force`, or peer-resolution
bypass is used.

## Native macOS or Linux

From the repository root, first build the native fixture binaries:

```sh
node packages/middleware/conformance/support/runtime-build.mjs --target=proxy --output=/tmp/caveman-packaging-proxy
node packages/middleware/conformance/support/runtime-build.mjs --target=mcp --output=/tmp/caveman-packaging-mcp
```

Then run the complete matrix with Node 22.13 or later, Python 3.13 or later,
pnpm 10.14.0, and uv available:

```sh
CAVEMAN_MIDDLEWARE_TEST_BINARY=/tmp/caveman-packaging-proxy/caveman-proxy \
CAVEMAN_MIDDLEWARE_RUNTIME_PROVENANCE=/tmp/caveman-packaging-proxy/build.json \
CAVEMAN_MCP_TEST_BINARY=/tmp/caveman-packaging-mcp/caveman-mcp \
CAVEMAN_MCP_RUNTIME_PROVENANCE=/tmp/caveman-packaging-mcp/build.json \
CAVEMAN_PACKAGING_PYTHON=/absolute/path/to/python3.13 \
node packages/middleware/conformance/packaged-consumer.mjs \
  --output=/tmp/caveman-packaging-new-run
```

The output directory must be empty. `--list` prints every case. To rerun a
bounded subset, pass comma-separated case IDs:

```sh
CAVEMAN_MIDDLEWARE_TEST_BINARY=/tmp/caveman-packaging-proxy/caveman-proxy \
CAVEMAN_MIDDLEWARE_RUNTIME_PROVENANCE=/tmp/caveman-packaging-proxy/build.json \
node packages/middleware/conformance/packaged-consumer.mjs \
  --only=typescript-core,typescript-openai,python-core,python-openai \
  --output=/tmp/caveman-packaging-subset
```

The default deletes each completed consumer's installed dependencies and owned
package caches, retaining artifacts, copied fixtures, lockfiles, type consumers,
import-origin reports, and command logs. This bounds disk use to one consumer.
Input runtime binaries are copied into the output and hashed before the first
install. Tests execute those owned snapshots throughout the run.
Keep the build helper's `build.json` and raw provenance beside each input
binary. Before any package build, resolver, install, or consumer test, the runner
validates that provenance and resolves the actual Go dependency closure again.
It rejects changed executables, missing provenance, changed compiled sources,
newly selected compiled inputs, and a different native platform or architecture.
It preserves the original build report, command output, current closure, and
source bytes under `runtime-provenance/`. The copied build report is unchanged.
The Linux wrapper also validates the native closure before starting the runner.
Use `--keep-consumers` only when enough disk space is available. A case refuses
to start an install with less than 1 GiB free. Optional
`CAVEMAN_PACKAGING_UV_CACHE` and `CAVEMAN_PACKAGING_NPM_CACHE` select existing
public package caches; the harness never deletes explicitly supplied caches.

## Exact runtime floors in native Linux containers

`linux.mjs` uses Docker and exact official Node 22.13.0, Python 3.13.0, and Go
1.26.5 image digests. The package image contains the official Node binary,
Python, Go, npm, and pinned uv. Container names and labels are unique to the run.
Repository and artifact inputs are read-only. No host credentials, Docker
socket, or published ports are passed into a container. Only its own temporary
outputs are writable. Existing containers and images are not removed.

Prepare the environment and compile fresh Go binaries **inside Linux**:

```sh
CAVEMAN_PACKAGING_GO_MOD_CACHE="$(go env GOMODCACHE)" \
node packages/middleware/conformance/packaging/linux.mjs \
  --prepare-only --output=/tmp/caveman-packaging-linux
```

The optional existing module cache is mounted read-only and checked with
`go mod verify`. Without it, a new module cache is created in the owned output.
Prepared verification uses the existing module cache with `GOPROXY=off`; checksum
verification remains enabled.
The frozen runtime build helper records the native platform and architecture,
compiler/linker hashes, actual `go list -deps -json` dependency closures, selected
source and embedded-file hashes, module verification before and after compilation,
executable hashes, and image inspection output. A change to a compiled input
during a build fails its provenance check. Every retry retains the earlier attempt.
A failed preparation can be retried
with `--prepared=/tmp/caveman-packaging-linux --prepare-only`.
If external cleanup removes the owned package image, a prepared run rebuilds it
from its unchanged recorded Dockerfile and exact image digests. Prepared native
binary and provenance hashes are checked again before use. Before each matrix,
the native Go dependency closure is resolved again inside the exact image and
compared with the proven build, including newly added compiled inputs. Earlier
v1 environments remain historical evidence; prepare a new output for this v2 gate.
The matrix mounts the retained native build provenance read-only at its original
container paths. Its writable consumer output and Go cache use a separate mount.

After a successful native artifact build by the main harness, run the same
artifacts at the exact Linux runtime floors:

```sh
node packages/middleware/conformance/packaging/linux.mjs \
  --prepared=/tmp/caveman-packaging-linux \
  --artifacts=/tmp/caveman-packaging-new-run/artifacts
```

This checks `source-provenance.json` against both the supplied artifact hashes
and current source for the selected package consumers before installing anything.
`--only` can select individual cases. A TypeScript-only run may reuse unchanged
TypeScript artifacts while Python source changes; the report names the verified
package roots and any unselected source differences. The TypeScript MCP case
also verifies the Python package source used by its native server fixture.
The original producer provenance is retained. Linux failures remain failures, including resource limits
and missing platform wheels. Cross compilation alone does not satisfy this run.

## Evidence and limits

`report.json` contains exact platform versions, package source hashes, harness
hashes, artifact hashes, original example locks, resolved wheel installation
locks, copied fixture hashes, installed import origins, commands, exit codes,
and hashed raw logs. Every case contributes its own result. A failed stage or
a selected package source change yields a nonzero overall exit. The Linux wrapper
also writes `linux-environment.json` with image and native build provenance.

Python extras are installed and imported by themselves first, using their real
wheel metadata. The example's exact lock is then added through the resolver for
native execution. Thus example-only dependencies cannot conceal a broken extra.
TypeScript installs its exact example lock and verifies that artifact/tooling
installation did not change any existing package version or integrity.
The AI SDK consumer also installs `@ai-sdk/anthropic@4.0.50` normally for its
Anthropic native cases. Its version and integrity come from the Mastra example
lock; every original AI SDK lock pin must remain unchanged.
`fixtures.mjs` lists each native entry point and the local files it loads. The
consumer copies that inventory, including subprocess fixtures and provenance
data. Native fixtures import installed packages; consumer probes and type samples
use public entries. Fixture provenance
reads and the Mastra unsupported-version fixture use installed artifact files;
the report retains hashes of both original fixtures and transformed copies.
Fixture failures and public runtime diagnostics are logged without weakening
their assertions. Mastra uses its explicit installed-package provenance mode;
repository certification imports are redirected to an unavailable local path.
Both Python provider consumers execute `test_native.py` and `test_providers.py`
in separate native test stages, including guards that exercise both protocols.
Their certification helper reads the copied mandatory-cell catalog beside the
fixture; the report records the original catalog and transformed helper hashes.

TypeScript checks public consumer calls with the example's existing Node types
and TypeScript 5.9.3 when no compiler is already locked. `skipLibCheck` excludes
upstream declaration bodies. Python checks `py.typed`, installed syntax, and
public consumer calls using hash-locked mypy 1.19.1 in a separate tooling
environment; untyped upstream imports and imported library internals are not
rechecked. Native fixture tests supply the runtime behavior proof.

Passing these checks proves the recorded local platform, artifact, framework
versions, and fixtures. It does not prove hosted provider behavior, publishing,
every operating system, or framework versions absent from the recorded locks.

## Verify complete coverage after clean reruns

Use `verify.mjs` to check the latest attempt for every consumer on each expected
platform. It verifies canonical artifact bytes, current package and fixture
inputs, copied fixtures, public type samples, logs, lockfiles, and native binary
hashes. Earlier failures remain in the input reports and the verification's
attempt history. A later failure cannot be concealed by an earlier pass.
Earlier runs copied entire example directories and the shared Python provider
fixture into unrelated consumers. Verification names unused copies and checks
their recorded bytes. Current-source checks cover every execution input in
`fixtures.mjs`; a required input missing from an older run fails verification.

```sh
node packages/middleware/conformance/packaging/verify.mjs \
  --platforms=darwin,linux \
  --artifacts=/tmp/caveman-packaging-new-run/artifacts \
  --report=/tmp/caveman-packaging-new-run/report.json \
  --report=/tmp/caveman-packaging-rerun/report.json \
  --report=/tmp/caveman-packaging-linux/run-RUN_ID/consumers/report.json \
  --output=/tmp/caveman-packaging-verified.json
```

Pass only completed runs made by this harness. Missing cases, stale fixture
inputs, mixed artifact or runtime hashes, and failed latest attempts return a
nonzero exit. Container evidence paths are mapped back to their retained host
report directory for verification.
