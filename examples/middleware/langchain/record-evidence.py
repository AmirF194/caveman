"""Assemble the LangChain operation report from successful local native runs."""
import argparse
import datetime
import hashlib
import importlib.metadata as metadata
import json
import platform
import re
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--binary", required=True, type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parents[3]
example = root / "examples/middleware/langchain"
proof = example / "proof"
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()

# Keep useful output and timings without embedding a contributor's home paths.
for filename in ("python-native.tap", "typescript-native.tap"):
    path = proof / filename
    value = path.read_text().replace(str(root), "<repo>")
    value = re.sub(r"/private/var/folders/[^ ]+/caveman-middleware-langchain-venv", "<langchain-venv>", value)
    value = re.sub(r"/Users/[^/]+/\.local/share/uv/python/[^/]+", "<python-runtime>", value)
    path.write_text(value)

records = []
for path in sorted(proof.glob("*.json")):
    value = json.loads(path.read_text())
    assert value["provider_calls"] == 3
    assert all(value[k] for k in ("original_documents_unchanged", "native_document_copies", "metadata_preserved"))
    assert value["document_order"] == ["source-a", "source-b", "source-c"]
    assert [s["source_id"] for s in value["sources"]] == ["source-a", "source-b"]
    assert len({s["handle"] for s in value["sources"]}) == 2
    assert all(s["complete"] and s["original_sha256"] == s["recovered_sha256"] and s["recovered_utf8_bytes"] == 9860 for s in value["sources"])
    if value["mode"] == "async-stream":
        assert value["text_before_provider_completion"] and value["streaming_requests"] == 3
    records.append((path, value))
assert len(records) == 10
required = json.loads((root / "packages/middleware/conformance/support/required-cells.json").read_text())["cells"]
cells = [c for c in required if c["family"] == "F05" and c["method"] == "retriever.source_expansion"]
assert len(cells) == 6 and all(c["recovery"] == "operator_bound" for c in cells)
python_log = (proof / "python-native.tap").read_text()
ts_log = (proof / "typescript-native.tap").read_text()
assert "# Ran 9 tests" in python_log and "# OK" in python_log and "# fail 0" in python_log
assert "# tests 11" in ts_log and "# pass 11" in ts_log and "# fail 0" in ts_log

files = [
    "packages/middleware/python/caveman_middleware/langchain.py",
    "packages/middleware/typescript/src/langchain.ts",
    "packages/middleware/typescript/src/langchain-model.ts",
    "packages/middleware/python/caveman_middleware/_native.py",
    "packages/middleware/typescript/src/common.ts",
    "packages/sdk/python/caveman_cloud/middleware/runtime.py",
    "packages/sdk/python/caveman_cloud/middleware/async_runtime.py",
    "packages/sdk/python/caveman_cloud/middleware/types.py",
    "packages/sdk/typescript/src/middleware/runtime.ts",
    "packages/middleware/conformance/python_fixture.py",
    "packages/middleware/conformance/runtime-fixture.mjs",
    *["examples/middleware/langchain/" + name for name in (
        "test_native.py", "test_source_expansion.py", "conformance.test.mjs", "source-expansion.test.mjs",
        "README.md", "requirements.in", "requirements.lock", "package.json", "package-lock.json", "record-evidence.py")],
]
py_packages = ["langchain", "langchain-core", "langgraph", "langchain-openai", "langchain-anthropic", "openai", "anthropic", "httpx2", "pydantic"]
ts_packages = ["langchain", "@langchain/core", "@langchain/langgraph", "@langchain/openai", "@langchain/anthropic", "openai", "@anthropic-ai/sdk"]
report = {
    "schema_version": 1, "integration_id": "F05", "operation": "retriever.source_expansion", "state": "implemented", "family_complete": False,
    "evidence_class": "installed_framework_local_http_real_engine", "recorded_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "host": {"system": platform.system(), "release": platform.release(), "machine": platform.machine(), "python": platform.python_version(), "node": subprocess.check_output(["node", "--version"], text=True).strip()},
    "versions": {"python": {p: metadata.version(p) for p in py_packages}, "typescript": {p: json.loads((example / "node_modules" / p / "package.json").read_text())["version"] for p in ts_packages}},
    "runtime": {"artifact": "locally_built_development_binary", "sha256": sha(args.binary), "protocol_version": 1},
    "source_revision": {"head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(), "working_tree": "uncommitted implementation; exact tested content identified by source digests"},
    "required_operation_cells": [{"id": c["id"], "state": "local_native_verified", "proof": f"examples/middleware/langchain/proof/{c['language']}-{c['execution']}-{c['provider']}.json"} for c in cells],
    "conformance": {
        "python": {"command": "CAVEMAN_LANGCHAIN_EVIDENCE_DIR=examples/middleware/langchain/proof CAVEMAN_MIDDLEWARE_TEST_FAMILY=langchain CAVEMAN_MIDDLEWARE_TEST_PYTHON=<locked-langchain-venv>/bin/python CAVEMAN_MIDDLEWARE_TEST_BINARY=<fresh-development-binary> node --test packages/middleware/conformance/python-framework.test.mjs", "exit_code": 0, "unittest_tests": 9, "unittest_seconds": float(re.search(r"# Ran 9 tests in ([0-9.]+)s", python_log)[1]), "log": "examples/middleware/langchain/proof/python-native.tap"},
        "typescript": {"command": "CAVEMAN_LANGCHAIN_EVIDENCE_DIR=examples/middleware/langchain/proof CAVEMAN_MIDDLEWARE_TEST_BINARY=<fresh-development-binary> node --test examples/middleware/langchain/conformance.test.mjs", "exit_code": 0, "tests": 11, "duration_ms": float(re.findall(r"# duration_ms ([0-9.]+)", ts_log)[-1]), "log": "examples/middleware/langchain/proof/typescript-native.tap"},
        "build": {"command": "npm run build", "directory": "packages/middleware/typescript", "exit_code": 0},
        "log_normalization": "Only local workspace and interpreter paths were replaced with placeholders; test output and timings are otherwise preserved.",
        "inference": "deterministic_loopback_only",
    },
    "proven": [
        "Real BaseRetriever invokes application retrieval; native StructuredTool carries compressed Document views to native ChatOpenAI and ChatAnthropic clients.",
        "Native tool nodes execute the registered runtime-owned reader and recover the removed fact from each duplicate-text source before the provider returns the cited final answer.",
        "Original retriever Documents and native tool artifacts stay full; Document class, IDs, metadata, and order survive in views.",
        "Two equal 9860-byte UTF-8 sources retain distinct handles and source IDs; exact recovery and bounded paging preserve Unicode and CRLF bytes.",
        "Cross-branch reader access returns the typed not_found error.",
        "No reader, off, record, optimizer outage, schema-only, flag, callback, copied binding, other-runtime binding, and other-scope binding produce no lossy grant.",
        "Python mutated RecoveryBinding schema/executor and both languages mutated native recovery tool schema/description/executor/public-call behavior cannot keep authorizing lossy provider views.",
        "OpenAI and Anthropic native async RAG streams in both languages deliver a first text chunk before provider completion.",
        "Existing native agent checkpoint, restart, branch, interrupt, model helper, batch, and original-view tests remain green.",
    ],
    "additional_stream_proofs": [str(path.relative_to(root)) for path, value in records if value["mode"] == "async-stream"],
    "limitations": [
        "The application explicitly registers the source reader. The compressor validates runtime ownership and scope; it does not inspect an arbitrary downstream application loop.",
        "Normal completion and first text delivery are proven for native RAG streams. Early close and active cancellation cleanup are not established by this artifact.",
        "This operation proof does not establish all F05 family gates, paid-provider quality, invoice savings, or performance acceptance.",
    ],
    "source_sha256": {path: sha(root / path) for path in files},
    "proof_sha256": {str(path.relative_to(root)): sha(path) for path in sorted(proof.iterdir()) if path.is_file()},
}
for cell in report["required_operation_cells"]:
    assert (root / cell["proof"]).is_file()
(example / "evidence.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps({"native_operation_cells": len(cells), "stream_proofs": len(report["additional_stream_proofs"]), "source_digests": len(report["source_sha256"]), "proof_digests": len(report["proof_sha256"])}))
