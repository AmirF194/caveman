"""Exact F13 Python cells through installed clients and real runtime processes."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import re

import anthropic
import openai
from mcp.types import CallToolResult
from caveman_cloud.middleware import AsyncMiddlewareRuntime
from caveman_middleware.mcp import MCPToolBinding, bind_mcp_tool
from python_fixture import ProviderServer, restart_runtime
from _client import native_client
from _server import SOURCE
from _certification_provider import NativeProvider
from example import run_text_host
from test_native import host_for, scope, manifest

FILE = "examples/middleware/mcp/test_native.py"
FACT = "retained-detail-70"
CELLS = [cell for cell in json.loads(Path(__file__).with_name("certification-cells.json").read_text())["cells"] if cell["language"] == "python"]


def digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode()).hexdigest()


def normalize(text):
    return re.sub(r"cmw_[a-f0-9]{48}|ccr_[a-zA-Z0-9_-]+", "<OPAQUE_RECOVERY_HANDLE>", text)


def report_view(report):
    return {"status": report.status, "reason": report.reason, "adapter": report.adapter,
        "replacement_count": report.replacement_count, "reused_count": report.reused_count, "transform_ids": list(report.transform_ids),
        "logical_call_id_present": report.logical_call_id is not None, "attempt_id_present": report.attempt_id is not None}


def result_text(body, protocol, call_id):
    if protocol == "openai":
        return next(message["content"] for message in body["messages"] if message.get("tool_call_id") == call_id)
    return next(part["content"] for message in body["messages"] if isinstance(message["content"], list)
                for part in message["content"] if part.get("tool_use_id") == call_id)


def tracked_host(test, client, runtime, reports, projections, selected_scope=None):
    host = host_for(client, runtime, selected_scope=selected_scope)
    project = host.project_result

    async def tracked(original, **options):
        before, count = original.model_dump_json(by_alias=True), len(reports)
        result = await project(original, **options)
        test.assertEqual(original.model_dump_json(by_alias=True), before)
        test.assertEqual(len(reports), count + 1, "one callback for each native result projection")
        report = reports[-1]
        test.assertIs(runtime.last_report, report)
        test.assertIsInstance(report.transform_ids, tuple)
        test.assertNotIn(FACT, repr(report))
        changed = sum(part.type == "text" and part.text != getattr(original.content[index], "text", None) for index, part in enumerate(result.content))
        test.assertEqual(report.replacement_count, changed, "report counts the view actually returned")
        if changed:
            test.assertIn(report.status, ("applied", "reused"))
            test.assertEqual(report.adapter, "mcp")
            test.assertTrue(report.transform_ids)
        else:
            test.assertIn(report.status, ("disabled", "recorded", "skipped"))
            test.assertFalse(report.transform_ids)
        if runtime.mode == "off":
            test.assertEqual(report.status, "disabled")
        projections.append((original, result, report))
        return result

    host.project_result = tracked
    return host


async def native_details(test, cell, mode, client, bindings, runtime, reports, projections):
    selected = scope()
    host = tracked_host(test, client, runtime, reports, projections, selected)
    read = next(binding for binding in bindings if binding.tool.name == "read_logs")
    if cell["method"] == "native_result_identity_and_blocks":
        details = {}
        for name in ("mixed", "failure"):
            binding = next(binding for binding in bindings if binding.tool.name == name)
            original = await binding.execute({})
            view = await host.project_result(original, tool=binding.tool, call_id=name, context_manifest=manifest(original), registered_tools=host.register(bindings))
            test.assertEqual(view.meta, original.meta)
            test.assertEqual(view.is_error, original.is_error)
            if name == "mixed":
                test.assertEqual(len(view.content), 6)
                for index in range(1, 6):
                    test.assertIs(view.content[index], original.content[index])
                test.assertEqual(view.content[0].annotations, original.content[0].annotations)
            else:
                test.assertIs(view, original)
            details[name] = {"native_blocks": [part.type for part in original.content], "untouched_block_identities": 5 if name == "mixed" else 1,
                "is_error": view.is_error, "metadata_retained": True}
        return details
    if cell["method"] == "cancel_and_options":
        waiting = next(binding for binding in bindings if binding.tool.name == "wait_forever")
        started = asyncio.Event()
        async def progress(*_args):
            started.set()
        task = asyncio.create_task(waiting.execute({}, progress_callback=progress, read_timeout_seconds=2, meta={"native-option": "retained"}))
        await asyncio.wait_for(started.wait(), 2)
        task.cancel()
        with test.assertRaises(asyncio.CancelledError):
            await task
        original = await read.execute({})
        test.assertEqual(original.content[0].text, SOURCE)
        await host.project_result(original, tool=read.tool, call_id="after-cancel", context_manifest=manifest(original), registered_tools=host.register(bindings))
        return {"native_progress_before_cancel": True, "native_cancelled_error": True, "subsequent_call_exact_sha256": digest(original.content[0].text)}
    if cell["method"] == "twenty_turn_restart":
        original = await read.execute({})
        saved, history, first, current = original.model_dump_json(by_alias=True, exclude_unset=True), manifest(original), None, host
        for turn in range(20):
            if turn in (5, 15):
                await asyncio.to_thread(restart_runtime)
                current = tracked_host(test, client, runtime, reports, projections, selected)
            restored = CallToolResult.model_validate_json(saved)
            view = await current.project_result(restored, tool=read.tool, call_id="stable-call", context_manifest=history, registered_tools=current.register(bindings))
            encoded = view.model_dump_json(by_alias=True)
            if first is None:
                first = encoded
            test.assertEqual(encoded, first)
            test.assertEqual(restored.model_dump_json(by_alias=True, exclude_unset=True), saved)
            history.append({"id": "turn-" + str(turn), "sha256": digest("native continuation " + str(turn))})
        handle = re.search(r"cmw_[a-f0-9]{48}", view.content[0].text)
        if mode == "compress":
            test.assertIsNotNone(handle)
            recovered = await current.recovery.execute({"handle": handle[0]})
            test.assertEqual(json.loads(recovered.content[0].text)["text"], SOURCE)
            with test.assertRaises(Exception):
                await tracked_host(test, client, runtime, reports, projections).recovery.execute({"handle": handle[0]})
        else:
            test.assertIsNone(handle)
            test.assertEqual(view.content[0].text, SOURCE)
        return {"native_typed_roundtrips": 20, "runtime_process_restarts": 2, "identical_view_across_restarts": True,
                "original_sha256": digest(original.content[0].text), "cross_scope_denial": mode == "compress"}
    if cell["method"] == "host_recovery_registration" and mode == "compress":
        original = await read.execute({})
        registered, optimize = host.register(bindings), runtime.optimize
        test.assertIs(registered[-1], host.recovery)
        async def mutate_registry(**options):
            outcome = await optimize(**options)
            test.assertTrue(outcome.replacements)
            registered.pop()
            return outcome
        runtime.optimize = mutate_registry
        try:
            view = await host.project_result(original, tool=read.tool, call_id="registry-race", context_manifest=manifest(original), registered_tools=registered)
            test.assertIs(view, original)
            test.assertEqual(reports[-1].status, "skipped")
            test.assertEqual(reports[-1].reason, "recovery_unavailable")
            test.assertEqual(reports[-1].replacement_count, 0)
            return {"actual_executor_registered": True, "registry_changed_after_real_optimization": True, "original_restored": True, "final_report": report_view(reports[-1])}
        finally:
            runtime.optimize = optimize
    return {}


async def run(test, cell, protocol, mode):
    reports, projections, plans, runtime_requests, native_executions = [], [], [], [], []
    runtime = AsyncMiddlewareRuntime(endpoint="http://127.0.0.1:1" if mode == "outage" else os.environ["CAVEMAN_MIDDLEWARE_ENDPOINT"],
        mode=mode if mode in ("off", "record") else "compress", on_report=reports.append)
    optimize = runtime.optimize
    async def capture_plan(**options):
        outcome = await optimize(**options)
        plans.append(outcome)
        return outcome
    runtime.optimize = capture_plan
    http = runtime._runtime._http
    def capture_http(*args, **kwargs):
        runtime_requests.append(args[0])
        return http(*args, **kwargs)
    runtime._runtime._http = capture_http
    engine, structured = cell["method"] == "existing_server_interoperation", cell["structured_output"]
    name = "caveman_compress" if engine else "structured" if cell["method"] == "structuredContent_and_outputSchema" else "mixed_structured" if cell["method"] == "mixed_structured_text_protection" else "read_logs"
    expected_text = (lambda text: test.assertEqual(json.loads(text), {"source": SOURCE})) if name == "structured" else SOURCE + "protected explanation" if name == "mixed_structured" else SOURCE
    fixture = NativeProvider(protocol, tool_name=name, expected_text=expected_text, native_engine=engine,
        tool_arguments={"input": SOURCE} if engine else {"path": "fixture/diagnostics.log"} if name == "read_logs" else {})
    transport = "http" if cell["method"].startswith("streamable_http") else "stdio"
    try:
        if mode == "compress":
            await runtime.ready()
        async with native_client(transport, engine=engine) as (client, rows):
            negotiated = client.protocol_version
            test.assertEqual(negotiated, cell["protocol"][4:])
            bindings = []
            for tool in (await client.list_tools()).tools:
                native = bind_mcp_tool(client, tool)
                async def execute(arguments=None, _native=native, **options):
                    result = await _native.execute(arguments, **options)
                    native_executions.append((_native.tool.name, result))
                    return result
                bindings.append(MCPToolBinding(tool, execute))
            host = tracked_host(test, client, runtime, reports, projections)
            if engine:
                test.assertEqual(host.register(bindings), bindings)
                test.assertEqual(sum(binding.tool.name == "caveman_retrieve" for binding in bindings), 1)
            with ProviderServer(fixture) as server:
                provider = (openai.AsyncOpenAI(api_key="fixture", base_url=server.url + "/v1", max_retries=0) if protocol == "openai"
                            else anthropic.AsyncAnthropic(api_key="fixture", base_url=server.url, max_retries=0))
                chunks = []
                async def first(text):
                    if not chunks:
                        test.assertFalse(fixture.finished)
                    chunks.append(text)
                    fixture.release.set()
                try:
                    final, history, originals = await run_text_host(client=provider, model="fixture-model", protocol=protocol, host=host, tools=bindings,
                        prompt="Find retained-detail-70", stream=cell["streaming"], on_text=first)
                finally:
                    await provider.close()
                test.assertEqual(final, FACT)
                if cell["streaming"]:
                    test.assertEqual("".join(chunks), FACT)
                test.assertIs(originals[0][2], native_executions[0][1])
                test.assertFalse(server.errors, server.errors)
            if structured:
                original = originals[0][2]
                test.assertIn("structured_content", original.model_fields_set)
                if name == "structured":
                    test.assertIsNotNone(next(binding.tool for binding in bindings if binding.tool.name == name).output_schema)
                else:
                    test.assertEqual(original.structured_content, {"answer": FACT})
                test.assertTrue(all(view is original for original, view, _ in projections))
            details = {} if engine or structured else await native_details(test, cell, mode, client, bindings, runtime, reports, projections)
        active = engine or mode == "compress" and not structured
        test.assertEqual(len(fixture.calls), 3 if active else 2)
        test.assertEqual(len(originals), 2 if active else 1)
        test.assertTrue(any(tool_name == name for tool_name, _ in native_executions))
        test.assertEqual(fixture.calls[0][1]["tools"], fixture.calls[-1][1]["tools"])
        test.assertTrue(all(request.headers["x-native-option"] == "preserved" for request, _ in fixture.calls))
        wire_source = result_text(fixture.calls[1][1], protocol, "read-1")
        recovered_hash = shortened = None
        if active:
            request = fixture.responses[1]
            test.assertEqual(request["name"], "caveman_retrieve")
            result = originals[1][2]
            recovered = result.content[0].text if engine else json.loads(result.content[0].text)["text"]
            test.assertEqual(recovered.encode(), SOURCE.encode())
            recovered_hash = digest(recovered)
            shortened = json.loads(wire_source)["compressed"] if engine else wire_source
            test.assertNotIn(FACT, shortened)
            test.assertLess(len(shortened.encode()), len(SOURCE.encode()))
            test.assertEqual(json.loads(wire_source)["recovery_handle"] if engine else re.search(r"cmw_[a-f0-9]{48}", wire_source)[0],
                request["args"]["recovery_handle" if engine else "handle"])
        elif callable(expected_text):
            expected_text(wire_source)
        else:
            test.assertEqual(wire_source, expected_text)
        if not engine and not structured:
            test.assertEqual(originals[0][2].content[0].text, SOURCE)
        if mode == "off":
            test.assertEqual(runtime_requests, [])
            test.assertEqual(plans, [])
        if engine or structured:
            test.assertEqual(plans, [])
        if mode == "outage" and not engine and not structured:
            test.assertIn("capabilities", runtime_requests)
        if transport == "http":
            calls = [row for row in rows if row["body"] and row["body"].get("method") == "tools/call"]
            test.assertEqual(len(calls), len(native_executions))
            test.assertTrue(all(row["headers"]["x-native-mcp"] == "preserved" and row["headers"]["mcp-protocol-version"] == negotiated for row in calls))
            test.assertEqual(len({row["body"]["id"] for row in calls}), len(calls))
        return {"protocol": protocol, "transport": transport, "mode": mode, "final": final, "provider_calls": len(fixture.calls), "native_source_tool": name,
            "native_tool_calls": [name for name, _ in native_executions], "negotiated_protocol": negotiated,
            "recovery_owner": "existing_native_caveman_mcp_server" if engine else "registered_host_local_executor" if active else "none",
            "middleware_projection_calls": len(reports), "callback_reports": [report_view(report) for report in reports],
            "source_result_identity_preserved": True, "native_history_sha256": digest(normalize(json.dumps(history, ensure_ascii=False, separators=(",", ":")))),
            "source_sha256": digest(SOURCE), "transformed_request_sha256": digest(normalize(fixture.calls[1][0].content.decode())),
            "provider_tool_result_sha256": digest(normalize(wire_source)), "shortened_sha256": digest(normalize(shortened)) if shortened else None,
            "omitted_fact_absent": active, "recovery_requests": int(active), "exact_recovered_sha256": recovered_hash,
            "native_options_and_schemas_preserved": True, "native_stream_before_eof": cell["streaming"], "runtime_requests": runtime_requests,
            "protected_result_identity": structured or engine, "native_details": details}
    finally:
        fixture.release.set()
        await runtime.aclose()


async def certify_cells(test):
    test.assertEqual(len(CELLS), 11)
    for cell in CELLS:
        with test.subTest(cell=cell["id"]):
            method = cell["method"]
            providers = ("openai", "anthropic") if method in ("stdio.call_tool", "streamable_http.call_tool", "stdio.host_stream", "streamable_http.host_stream") else ("openai",)
            rows = []
            for protocol in providers:
                controls = {mode: await run(test, cell, protocol, mode) for mode in ("compress", "off", "outage")}
                for baseline in (controls["off"], controls["outage"]):
                    test.assertEqual(baseline["final"], controls["compress"]["final"])
                    test.assertEqual(baseline["source_sha256"], controls["compress"]["source_sha256"])
                    test.assertTrue(baseline["source_result_identity_preserved"])
                    if cell["structured_output"] or method == "existing_server_interoperation":
                        test.assertEqual(baseline["provider_tool_result_sha256"], controls["compress"]["provider_tool_result_sha256"])
                rows.append(controls)
            if method == "host_recovery_registration":
                recorded = await run(test, cell, "openai", "record")
                test.assertTrue(any(report["status"] == "recorded" for report in recorded["callback_reports"]))
                rows[0]["compress"]["record_mode"] = recorded
            active = [row["compress"] for row in rows]
            observed = lambda values: {"outcome": "observed", "native_runs": values}
            free = {"outcome": "recovery_free", "reason": "native MCP structuredContent/outputSchema contract", "native_result_identity_preserved": True,
                "recovery_requests": 0, "replacements": 0, "original_source_sha256": digest(SOURCE)} if cell["recovery"] == "model_only" else None
            observations = {
                "native_application": observed([{ "method": method, "protocol": row["protocol"], "transport": row["transport"], "negotiated_protocol": row["negotiated_protocol"],
                    "native_entry_point": "installed MCP Client.call_tool and application-owned native provider loop", "recovery_owner": row["recovery_owner"]} for row in active]),
                "real_tool_result": observed([{ "source_tool": row["native_source_tool"], "native_tool_calls": row["native_tool_calls"], "source_sha256": row["source_sha256"], "source_result_identity_preserved": True} for row in active]),
                "transformed_provider_request": free or observed([{ "transformed_request_sha256": row["transformed_request_sha256"], "shortened_sha256": row["shortened_sha256"], "omitted_fact_absent": row["omitted_fact_absent"], "recovery_owner": row["recovery_owner"]} for row in active]),
                "omitted_fact_requested": free or observed([{ "native_provider_recovery_requests": row["recovery_requests"], "exact_view_handle_requested": True, "recovery_owner": row["recovery_owner"]} for row in active]),
                "host_executes_exact_recovery": free or observed([{ "exact_recovered_sha256": row["exact_recovered_sha256"], "source_sha256": row["source_sha256"], "recovery_owner": row["recovery_owner"]} for row in active]),
                "native_result_history_events_and_call_count": observed(active), "off_baseline": observed([row["off"] for row in rows]), "optimizer_unavailable": observed([row["outage"] for row in rows])}
            name = ".".join(test.id().split(".")[-2:])
            for assertion, observation in observations.items():
                print("CAVEMAN_MIDDLEWARE_OBSERVATION " + json.dumps({"cell_id": cell["id"], "test_id": FILE + "::" + name,
                    "assertion": assertion, "observation": observation}, separators=(",", ":")), flush=True)
