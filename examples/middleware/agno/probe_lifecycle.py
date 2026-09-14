"""Compare native and wrapped Agno iterator, response, and socket lifetimes."""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import platform
from datetime import datetime, timezone
from importlib.metadata import PackageNotFoundError, distribution, version
from pathlib import Path

from lifecycle import observe_lifecycle

ROOT = Path(__file__).resolve().parents[3]


def collect(*, endpoint, rounds=1):
    cases = []
    for repetition in range(rounds):
        for protocol in ("openai", "anthropic"):
            for surface in ("model", "agent", "team"):
                for action in ("early_close", "task_cancel"):
                    for variant in ("baseline", "middleware"):
                        errors = []

                        async def run():
                            # Retain diagnostics through asyncio.run's generator
                            # shutdown, then make them part of the pass/fail gate.
                            asyncio.get_running_loop().set_exception_handler(
                                lambda loop, context: errors.append({"type": type(context.get("exception")).__name__,
                                    "message": str(context.get("exception")), "context": context.get("message")}))
                            return await observe_lifecycle(protocol, variant, action, surface, endpoint=endpoint)

                        result = asyncio.run(run(), debug=True)
                        cases.append({"repetition": repetition, **result, "shutdown_errors": errors})
    return cases


def validate(cases, *, require_clean_close=False):
    failures = []
    baselines = {(r["repetition"], r["protocol"], r["surface"], r["action"]): r for r in cases if r["variant"] == "baseline"}
    for result in cases:
        key = (result["repetition"], result["protocol"], result["surface"], result["action"])
        label = "/".join(map(str, (*key, result["variant"])))
        for field in ("stream_closed", "owner_clear", "peer_closed_after_client_close"):
            if result[field] is not True:
                failures.append(f"{label}: {field} must be true")
        if result["provider_calls"] != 1 or result["server_errors"] or result["shutdown_errors"]:
            failures.append(f"{label}: unexpected provider call count or captured lifecycle error")
        if result["action"] == "task_cancel":
            if (result["cancellation_result"] != "CancelledError" or not result["response_closed_before_client_close"]
                    or not result["peer_closed_before_client_close"]):
                failures.append(f"{label}: active cancellation did not close native inference")
        if require_clean_close and not (result["response_closed_before_client_close"] and result["peer_closed_before_client_close"]):
            failures.append(f"{label}: native early-close leaves the response or socket open")
        if result["variant"] == "middleware":
            baseline = baselines[key]
            for field in ("response_closed_before_client_close", "peer_closed_before_client_close"):
                if baseline[field] and not result[field]:
                    failures.append(f"{label}: wrapper regresses native {field}")
            if result["terminal_receipts"] != ["cancelled"] or result["receipt_usage"] != [None]:
                failures.append(f"{label}: interrupted inference needs one cancelled receipt with unknown usage")
        elif result["terminal_receipts"] or result["receipt_usage"]:
            failures.append(f"{label}: baseline unexpectedly emitted middleware receipts")
    return failures


def document(cases):
    versions = {}
    for name in ("agno", "openai", "anthropic", "httpx", "httpcore", "httpx2", "httpcore2", "anyio", "pydantic"):
        try:
            versions[name] = version(name)
        except PackageNotFoundError:
            pass
    sources = ["packages/middleware/python/caveman_middleware/agno.py",
               "examples/middleware/agno/lifecycle.py", "examples/middleware/agno/probe_lifecycle.py",
               "examples/middleware/agno/test_native.py"]
    dependency_lock = None
    for inputs in ("examples/middleware/agno/requirements.in", "examples/middleware/agno/compatibility/incompatible-requirements.in"):
        pins = (ROOT / inputs).read_text().splitlines()
        if all(f"{name}=={versions[name]}" in pins for name in ("agno", "openai", "anthropic")):
            dependency_lock = inputs.removesuffix(".in") + ".lock"
            sources.extend((inputs, dependency_lock))
            break
    upstream = ["agno/models/base.py", "agno/models/openai/chat.py", "agno/models/anthropic/claude.py",
                "agno/agent/_run.py", "agno/team/_run.py"]
    result = {"schema_version": 1, "integration_id": "F08", "evidence_class": "native_loopback_lifecycle_controls",
              "recorded_at": datetime.now(timezone.utc).isoformat(), "hosted_provider_tested": False,
              "versions": versions, "dependency_lock": dependency_lock,
              "platform": {"system": platform.system(), "machine": platform.machine(), "python": platform.python_version()},
              "asyncio_debug": True, "cases": cases, "validation_failures": validate(cases),
              "clean_close_failures": validate(cases, require_clean_close=True),
              "source_sha256": {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in sources},
              "upstream_source_sha256": {name: hashlib.sha256(distribution("agno").locate_file(name).read_bytes()).hexdigest() for name in upstream}}
    binary = os.environ.get("CAVEMAN_MIDDLEWARE_TEST_BINARY")
    if binary:
        result["runtime_sha256"] = hashlib.sha256(Path(binary).read_bytes()).hexdigest()
    result["state"] = "failed" if result["validation_failures"] else "pass_with_native_limitation" if result["clean_close_failures"] else "conformant"
    result["lifecycle_complete"] = not result["clean_close_failures"]
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rounds", type=int, default=1)
    parser.add_argument("--require-clean-close", action="store_true", help="Also fail on the native OpenAI early-close limitation")
    args = parser.parse_args()
    if not 1 <= args.rounds <= 10:
        parser.error("--rounds must be between 1 and 10")
    result = document(collect(endpoint=os.environ["CAVEMAN_MIDDLEWARE_ENDPOINT"], rounds=args.rounds))
    print(json.dumps(result, indent=2))
    raise SystemExit(bool(result["clean_close_failures"] if args.require_clean_close else result["validation_failures"]))


if __name__ == "__main__":
    main()
