"""Repeat native/wrapped cleanup in isolated event loops; retain SDK diagnostics."""
import asyncio
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import traceback

from _http_fixture import Provider
from test_native import client_for, kwargs, resource, runtime_for, wrap


async def run_case(protocol, wrapped, helper, action, errors):
    def exception_handler(_, context):
        error = context.get("exception")
        errors.append({"message": context.get("message"), "exception": repr(error),
                       "generator": getattr(context.get("asyncgen"), "__qualname__", None),
                       "frames": [{"file": Path(frame.filename).name, "function": frame.name, "line": frame.lineno} for frame in traceback.extract_tb(error.__traceback__)] if error else []})
    asyncio.get_running_loop().set_exception_handler(exception_handler)
    with Provider(protocol, pause="first") as provider:
        runtime, plans, receipts = runtime_for(True)
        async with runtime, client_for(provider, True) as original:
            await runtime.ready()
            client = wrap(original, runtime, protocol, f"lifecycle-{protocol}-{helper}-{action}") if wrapped else original
            manager = resource(client, protocol).stream(**kwargs(protocol)) if helper else None
            stream = await manager.__aenter__() if manager else await resource(client, protocol).create(**kwargs(protocol), stream=True)
            iterator = stream.__aiter__()
            await anext(iterator)
            if action == "task_cancel":
                pending = asyncio.create_task(anext(iterator))
                await asyncio.sleep(0.01)
                pending.cancel()
                try:
                    await pending
                    raise AssertionError("a gated native read unexpectedly completed")
                except asyncio.CancelledError:
                    pass
            elif manager:
                await manager.__aexit__(None, None, None)
            else:
                await stream.close()
            closed = await asyncio.to_thread(provider.peer_closed)
            row = {"protocol": protocol, "wrapped": wrapped, "helper": helper, "action": action, "provider_requests": len(provider.calls),
                   "peer_closed_before_release": closed and not provider.release.is_set(),
                   "receipt_events": [receipt["event_kind"] for receipt in receipts],
                   "terminal_usage": [receipt["usage"] for receipt in receipts if receipt["event_kind"] != "dispatch_intent"]}
            await stream.close()
            if manager and action == "task_cancel":
                await manager.__aexit__(None, None, None)
            return row


def main():
    rows = []
    for protocol in ("openai-chat", "openai-responses", "anthropic-messages"):
        for wrapped in (False, True):
            for helper in (False, True):
                for action in ("close", "task_cancel"):
                    for repetition in range(3):
                        errors = []
                        row = asyncio.run(run_case(protocol, wrapped, helper, action, errors), debug=True)
                        row.update(repetition=repetition, shutdown_diagnostics=errors)
                        rows.append(row)
    evidence = {"evidence_class": "installed_native_sdk_lifecycle_comparison", "versions": {name: importlib.metadata.version(name) for name in ("openai", "anthropic", "httpx2", "httpcore2")},
                "runtime_sha256": hashlib.sha256(Path(os.environ["CAVEMAN_MIDDLEWARE_TEST_BINARY"]).read_bytes()).hexdigest(), "observations": rows}
    Path(__file__).with_name("lifecycle-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
    print(json.dumps({"cases": len(rows), "peer_closed_before_release": sum(row["peer_closed_before_release"] for row in rows),
                      "native_shutdown_diagnostics": sum(len(row["shutdown_diagnostics"]) for row in rows if not row["wrapped"]),
                      "wrapped_shutdown_diagnostics": sum(len(row["shutdown_diagnostics"]) for row in rows if row["wrapped"])}))
    assert all(row["provider_requests"] == 1 and row["peer_closed_before_release"] for row in rows)
    assert all(row["terminal_usage"] == [None] and row["receipt_events"] == ["dispatch_intent", "cancelled"] for row in rows if row["wrapped"])


if __name__ == "__main__":
    main()
