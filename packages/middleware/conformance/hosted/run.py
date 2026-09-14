"""Default: offline schedule. Hosted requests require opt-in, prices and budget."""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import multiprocessing
import os
from pathlib import Path
import platform
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid
from datetime import datetime, timezone

from budget import Budget, BudgetExhausted, Refusal, authorize

HERE = Path(__file__).resolve().parent
ARMS = ("direct", "caveman", "headroom")


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def corpus():
    path = HERE / "corpus.json"
    if sha(path) != (HERE / "corpus.sha256").read_text().strip():
        raise Refusal("Frozen corpus digest mismatch; do not silently regenerate benchmark tasks")
    value = json.loads(path.read_text())
    if len(value["tasks"]) != 24 or len({task["id"] for task in value["tasks"]}) != 24:
        raise Refusal("The frozen corpus must contain exactly 24 distinct tasks")
    return value["tasks"]


def schedule(tasks, rotations=3):
    if type(rotations) is not int or not 3 <= rotations <= 30:
        raise Refusal("At least three rotated repetitions are required (maximum 30)")
    return [{"task_id": task["id"], "arm": ARMS[(index + rotation + order) % 3], "rotation": rotation,
             "strata": ["cold", "warm"]}
            for rotation in range(rotations) for index, task in enumerate(tasks) for order in range(3)]


def start_runtime(binary, output):
    binary = Path(binary).resolve(strict=True)
    snapshot = output / "runtime" / "caveman-proxy"
    snapshot.parent.mkdir()
    shutil.copy2(binary, snapshot)
    server_socket = socket.socket()
    server_socket.bind(("127.0.0.1", 0))
    port = server_socket.getsockname()[1]
    server_socket.close()
    home = output / "runtime" / "state"
    home.mkdir()
    config = home / "caveman.yaml"
    config.write_text(f'listen: "127.0.0.1:{port}"\nmode: compress\n')
    log = (output / "runtime" / "server.log").open("w")
    env = {key: value for key, value in os.environ.items() if not any(word in key.upper() for word in ("TOKEN", "SECRET", "API_KEY", "PASSWORD", "CREDENTIAL", "AWS_PROFILE"))}
    env.update(CAVEMAN_HOME=str(home), CAVEMAN_CONFIG=str(config), CAVEMAN_DB=str(home / "caveman.db"),
               CAVEMAN_CCR_DB=str(home / "ccr.db"), CAVEMAN_CCR_MAX_BYTES=str(16 << 20), CAVE_CAPTURE_DIR="", CAVEMAN_AUTH_TOKEN="")
    process = subprocess.Popen([str(snapshot), "serve"], env=env, stdout=log, stderr=subprocess.STDOUT)
    endpoint = f"http://127.0.0.1:{port}"
    try:
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline and process.poll() is None:
            try:
                with urllib.request.urlopen(endpoint + "/caveman/v1/middleware/capabilities", timeout=.5) as response:
                    capabilities = json.load(response)
                return process, log, endpoint, {"sha256": sha(snapshot), "capabilities": capabilities}
            except (OSError, ValueError):
                time.sleep(.05)
        raise Refusal("Isolated runtime did not start")
    except BaseException:
        process.terminate()
        process.wait(timeout=5)
        log.close()
        raise


def execute_job(arguments, budget, write_receipt, write_result):
    from native import worker
    context = multiprocessing.get_context("spawn")
    parent, child = context.Pipe()
    process = context.Process(target=worker, args=(child, arguments))
    process.start()
    child.close()
    pending = set()
    settled_without_receipt = {}
    failure = None
    deadline = time.monotonic() + 2 * arguments["task"]["limits"]["wall_seconds"] + 30
    stratum_deadline, active_stratum = None, None
    try:
        while time.monotonic() < deadline:
            if stratum_deadline is not None and time.monotonic() >= stratum_deadline:
                failure = {"reason": "stratum_wall_deadline", "stratum": active_stratum}
                break
            if not parent.poll(.1):
                if not process.is_alive():
                    failure = {"reason": "worker_exit_without_completion", "exit_code": process.exitcode}
                    break
                continue
            try:
                message = parent.recv()
            except EOFError:
                failure = {"reason": "worker_control_eof"}
                break
            kind = message.get("type")
            if kind == "stratum_started":
                expected = "cold" if active_stratum is None else "warm" if active_stratum == "cold" else None
                if message.get("stratum") != expected:
                    raise Refusal("Worker stratum order differs from the frozen schedule")
                active_stratum = expected
                stratum_deadline = time.monotonic() + arguments["task"]["limits"]["wall_seconds"]
            elif kind == "reserve":
                try:
                    amount = budget.reserve(message["attempt_id"])
                    pending.add(message["attempt_id"])
                    parent.send({"reservation": str(amount)})
                except Refusal as error:
                    parent.send({"refusal": str(error)})
            elif kind == "settle":
                if message["attempt_id"] not in pending:
                    raise Refusal("Worker attempted to settle an unreserved provider request")
                pricing = budget.settle(message["attempt_id"], message["usage"])
                pending.remove(message["attempt_id"])
                settled_without_receipt[message["attempt_id"]] = pricing
                parent.send(pricing)
            elif kind == "receipt":
                if message["value"]["attempt_id"] not in settled_without_receipt:
                    raise Refusal("Worker receipt has no unique settled reservation")
                write_receipt(message["value"])
                del settled_without_receipt[message["value"]["attempt_id"]]
            elif kind == "result":
                write_result(message["value"])
            elif kind == "coverage_failure":
                failure = {"reason": "native_arm_could_not_execute", "error_class": message["error_class"]}
                break
            elif kind == "done":
                break
            else:
                raise Refusal("Invalid worker control message")
        else:
            failure = {"reason": "worker_wall_deadline"}
    finally:
        if process.is_alive():
            process.join(1)
        if process.is_alive():
            process.terminate()
            process.join(5)
        for attempt_id in pending:
            pricing = budget.settle(attempt_id, None)
            write_receipt({"attempt_id": attempt_id, **pricing, "event": "receipt_lost",
                           "evidence_class": "unsettled_reservation", "provider_dispatch_status": "unknown",
                           "task_id": arguments["task"]["id"], "arm": arguments["arm"], "rotation": arguments["rotation"]})
        for attempt_id, pricing in settled_without_receipt.items():
            write_receipt({"attempt_id": attempt_id, **pricing, "event": "receipt_lost",
                           "evidence_class": "settled_reservation_without_transport_receipt", "provider_dispatch_status": "unknown",
                           "task_id": arguments["task"]["id"], "arm": arguments["arm"], "rotation": arguments["rotation"]})
        parent.close()
    return failure


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true")
    parser.add_argument("--provider", choices=("openai", "anthropic"))
    parser.add_argument("--opt-in-provider", action="append", default=[])
    parser.add_argument("--max-spend-usd")
    parser.add_argument("--config", type=Path)
    parser.add_argument("--pricing-source-file", type=Path)
    parser.add_argument("--runtime-binary", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--rotations", type=int, default=3)
    parser.add_argument("--task-id", action="append", default=[])
    args = parser.parse_args(argv)
    tasks = corpus()
    if args.task_id:
        unknown = set(args.task_id) - {task["id"] for task in tasks}
        if unknown:
            raise Refusal("Unknown frozen task ID")
        tasks = [task for task in tasks if task["id"] in args.task_id]
    jobs = schedule(tasks, args.rotations)
    plan = {"schema_version": 1, "mode": "hosted" if args.run else "offline_plan",
            "tasks": len(tasks), "rotations": args.rotations, "arms": list(ARMS),
            "scheduled_task_runs": len(jobs) * 2, "corpus_sha256": sha(HERE / "corpus.json"),
            "dependency_lock_sha256": sha(HERE / "requirements.lock"), "jobs": jobs,
            "external_inference_requests": 0, "provider_credentials_obtained": False,
            "common_layer": "LangChain create_agent and native model-call extension points",
            "native_sdk_retry_limit": 0, "provider_auth_coverage": "direct API-key endpoints only",
            "coverage_gaps": ["Headroom LangChain adapter has no native recovery-tool registration in the pinned public integration", "Pinned ChatAnthropic has no public HTTP transport injection for pre-dispatch spend reservation; hosted comparison is OpenAI Chat only", "Bedrock, Vertex, Azure, OAuth and native Windows need separate records"]}
    if not args.run:
        if args.output:
            args.output.mkdir(parents=True, exist_ok=True)
            (args.output / "plan.json").write_text(json.dumps(plan, indent=2) + "\n")
        print(json.dumps({key: value for key, value in plan.items() if key != "jobs"}, indent=2))
        return 0
    # Refuse missing opt-in and budget before reading any credential or importing
    # frameworks. A pricing file alone cannot authorize a paid request.
    if args.provider not in args.opt_in_provider:
        raise Refusal("Hosted execution requires explicit opt-in for the selected provider")
    from budget import decimal
    decimal(args.max_spend_usd, "maximum spend", positive=True)
    if args.provider != "openai":
        raise Refusal("Pinned ChatAnthropic has no public HTTP transport injection for pre-dispatch spend reservation; this comparison provider is a coverage gap")
    if not args.config or not args.pricing_source_file or not args.runtime_binary or not args.output:
        raise Refusal("Hosted execution also requires config, retained pricing source, runtime binary and output directory")
    config = json.loads(args.config.read_text())
    cap, prices = authorize(args.provider, args.opt_in_provider, args.max_spend_usd, config)
    if sha(args.pricing_source_file) != config["pricing_source"]["sha256"]:
        raise Refusal("Retained pricing source digest does not match the reviewed configuration")
    from native import versions
    installed = versions()
    from provenance import distribution_provenance
    provenance = distribution_provenance()
    if args.output.exists():
        raise Refusal("Use a new output directory; prior run evidence must not be overwritten")
    args.output.mkdir(parents=True)
    shutil.copy2(args.config, args.output / "provider-config.json")
    shutil.copy2(args.pricing_source_file, args.output / "pricing-source.txt")
    (args.output / "plan.json").write_text(json.dumps(plan, indent=2) + "\n")
    (args.output / "installed-provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
    api_key = os.environ.get("OPENAI_API_KEY" if args.provider == "openai" else "ANTHROPIC_API_KEY")
    if not api_key:
        raise Refusal("Explicitly authorized provider API key is unavailable")
    budget = Budget(cap, prices)
    process, runtime_log, endpoint, runtime_record = start_runtime(args.runtime_binary, args.output)
    results, receipts, gaps = [], [], []
    run_id = str(uuid.uuid4())
    started = datetime.now(timezone.utc).isoformat()
    def append(path, rows, value):
        rows.append(value)
        with path.open("a") as output:
            output.write(json.dumps(value, ensure_ascii=False) + "\n")
            output.flush()
    try:
        for job in jobs:
            if budget.halted or budget.committed + prices.reservation > cap:
                break
            task = next(task for task in tasks if task["id"] == job["task_id"])
            failure = execute_job({"task": task, "arm": job["arm"], "rotation": job["rotation"], "run_id": run_id,
                                   "config": config, "api_key": api_key, "endpoint": endpoint}, budget,
                                  lambda value: append(args.output / "receipts.jsonl", receipts, value),
                                  lambda value: append(args.output / "results.jsonl", results, value))
            if failure:
                gaps.append({**job, **failure})
            print(json.dumps({"task": job["task_id"], "arm": job["arm"], "rotation": job["rotation"],
                              "committed_upper_bound_usd": str(budget.committed), "coverage_failure": failure}), flush=True)
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill(); process.wait(timeout=5)
        runtime_log.close()
        from report import report
        summary = report(results, receipts, jobs)
        summary.update(run_id=run_id, started_at=started, finished_at=datetime.now(timezone.utc).isoformat(),
                       provider=config, runtime=runtime_record, framework_versions=installed,
                       installed_provenance_sha256=sha(args.output / "installed-provenance.json"),
                       host={"python": sys.version, "platform": platform.platform(), "machine": platform.machine()},
                       source_hashes={path.name: sha(path) for path in HERE.iterdir() if path.is_file() and path.suffix in (".py", ".lock", ".json", ".sha256")},
                       maximum_spend_usd=str(cap), committed_upper_bound_usd=str(budget.committed),
                       budget_stopped=budget.halted or budget.committed + prices.reservation > cap, coverage_failures=gaps,
                       external_inference_requests=sum(row.get("evidence_class") == "real_provider_receipt" for row in receipts))
        (args.output / "report.json").write_text(json.dumps(summary, indent=2) + "\n")
    return 0 if summary["full_scheduled_matrix_observed"] and not gaps else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Refusal as error:
        print(json.dumps({"status": "refused", "reason": str(error)}), file=sys.stderr)
        raise SystemExit(2)
