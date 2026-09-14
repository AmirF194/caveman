"""Exact Strands native entry points with real local runtime and provider protocols."""
import asyncio
import copy
import hashlib
import json
import os
import threading
import uuid
from dataclasses import FrozenInstanceError
from pathlib import Path

from pydantic import BaseModel
from strands import Agent, tool
from strands.hooks import BeforeModelCallEvent, AfterInvocationEvent
from strands.event_loop.streaming import process_stream
from strands.tools.executors import ConcurrentToolExecutor
from caveman_cloud.middleware import Scope
from caveman_middleware.strands import with_caveman_agent, with_caveman_model
from evidence_runtime import EvidenceRuntime
from python_fixture import restart_runtime
from _certification_provider import Provider, SOURCES, FACT, HANDLE, native_results, native_tools

CELLS = json.loads(Path(__file__).with_name("certification-cells.json").read_text())["cells"]
TEST_ID = "examples/middleware/strands/test_native.py::AsyncNativeStrands.test_certifies_exact_f09_native_operations"
ENDPOINT = os.environ["CAVEMAN_MIDDLEWARE_ENDPOINT"]


class Answer(BaseModel):
    answer: int


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def normalized(value):
    # Native tracking UUIDs and observed first-byte clocks vary across independent
    # executions. Keep their relationships and validate their real shapes before
    # normalizing only the evidence copy; original messages remain untouched.
    tracking_ids = {}

    def stable(item):
        if isinstance(item, list):
            return [stable(child) for child in item]
        if not isinstance(item, dict):
            return item
        view = {key: stable(child) for key, child in item.items()}
        if item.get("role") in ("user", "assistant", "system") and isinstance(item.get("content"), list):
            if "tracking_id" in item:
                tracking = item["tracking_id"]
                assert isinstance(tracking, str) and str(uuid.UUID(tracking)) == tracking
                view["tracking_id"] = tracking_ids.setdefault(tracking, f"<NATIVE_TRACKING_ID_{len(tracking_ids)}>")
            metrics = item.get("metadata", {}).get("metrics", {})
            if "timeToFirstByteMs" in metrics:
                assert isinstance(metrics["timeToFirstByteMs"], (int, float)) and metrics["timeToFirstByteMs"] >= 0
                view["metadata"]["metrics"]["timeToFirstByteMs"] = "<OBSERVED_NONNEGATIVE_FIRST_BYTE_MS>"
        return view

    return HANDLE.sub("<OPAQUE_RECOVERY_HANDLE>", json.dumps(stable(value), ensure_ascii=False, separators=(",", ":"), sort_keys=True))


def report_view(report):
    return {"status": report.status, "reason": report.reason, "adapter": report.adapter, "replacement_count": report.replacement_count,
            "reused_count": report.reused_count, "transform_ids": list(report.transform_ids),
            "logical_call_id_present": report.logical_call_id is not None, "attempt_id_present": report.attempt_id is not None}


def original_results(agent):
    return [p["toolResult"] for m in agent.messages for p in m["content"] if "toolResult" in p and p["toolResult"]["toolUseId"].startswith("read-")]


async def consume_agent(test, agent, server, *, action=None):
    cancel_signal = threading.Event()
    stream = agent.stream_async("Read original logs and recover the omitted detail.", cancel_signal=cancel_signal)
    text, event_types, result = "", [], None
    boundary, closed, returned_before, returned, return_requested, error_type = None, None, None, False, False, None

    async def release_boundary():
        nonlocal closed, returned_before
        await asyncio.sleep(0.1)
        closed = server.closed_before_eof
        if return_requested:
            returned_before = returned
        server.release.set()

    try:
        async for event in stream:
            event_types.extend(event)
            if "result" in event:
                result = event["result"]
            if "data" in event:
                text += event["data"]
                if text == "retained-":
                    test.assertFalse(server.release.is_set(), "native consumer saw a delta before provider EOF")
                    if action:
                        if action == "abort":
                            cancel_signal.set()
                        else:
                            return_requested = True
                        boundary = asyncio.create_task(release_boundary())
                        if return_requested:
                            await stream.aclose(); returned = True
                            break
                    else:
                        server.release.set()
    except asyncio.CancelledError:
        if not cancel_signal.is_set():
            raise
        error_type = "CancelledError"
    finally:
        await stream.aclose()
        if boundary:
            await boundary
    test.assertEqual(text, "retained-" if action else FACT)
    if not action:
        test.assertEqual(result.message["content"], [{"text": FACT}])
    return {"result": result, "event_types": sorted(set(event_types)), "first_delta_before_eof": True,
            "lifecycle": {"requested": cancel_signal.is_set(), "error_type": error_type, "provider_closed_before_release": closed,
                          "generator_return_requested": return_requested, "return_completed_before_release": returned_before}}


async def direct_model_stream(test, agent, server):
    """A bounded public Model caller uses the installed Strands parser and tool executor."""
    server.resume = True
    server.release.clear()
    stream_calls, native_recoveries, event_types, first = 0, 0, [], False
    while stream_calls < 2:
        stream_calls += 1
        specs = agent.tool_registry.get_all_tool_specs()
        message, stop = None, None
        async for event in process_stream(agent.model.stream(agent.messages, specs, agent.system_prompt,
                                                            invocation_state={"agent": agent, "native_marker": "preserved"})):
            event_types.extend(event)
            if event.get("data") == "retained-":
                test.assertFalse(server.release.is_set()); first = True; server.release.set()
            if "stop" in event:
                stop, message, _, _ = event["stop"]
        test.assertIsNotNone(message)
        if stop == "end_turn":
            test.assertEqual(message["content"], [{"text": FACT}])
            agent.messages.append(message)
            break
        test.assertEqual(stop, "tool_use")
        call = next(p["toolUse"] for p in message["content"] if "toolUse" in p)
        test.assertEqual(call["name"], "caveman_retrieve")
        test.assertEqual(call["input"]["handle"], server.handles["read-1"])
        executor = agent.tool_registry.registry[call["name"]]
        native_result = None
        async for event in executor.stream(call, {"agent": agent, "native_marker": "preserved"}):
            if isinstance(event, dict) and "tool_result" in event:
                native_result = event["tool_result"]
        test.assertIsNotNone(native_result)
        test.assertEqual(json.loads(native_result["content"][0]["text"])["text"], SOURCES["read_logs"])
        native_recoveries += 1
        agent.messages.extend([message, {"role": "user", "content": [{"toolResult": native_result}]}])
    test.assertTrue(first)
    return {"direct_model_stream_calls": stream_calls, "native_decorated_executor_calls": native_recoveries,
            "native_parser": "strands.event_loop.streaming.process_stream", "first_delta_before_eof": first, "native_event_types": sorted(set(event_types))}


async def run(test, cell, mode, *, lifecycle_action="abort", unwrapped=False):
    method, protocol = cell["method"], cell["provider"]
    parallel, streamed = method == "parallel_tool_batch", method in ("agent.stream_async", "cancel_and_close")
    server = Provider(protocol, parallel=parallel, gate_text=streamed)
    reports, diagnostics, hooks, executions, source_refs, message_refs = [], [], [], [], {}, {}
    runtime = EvidenceRuntime(endpoint="http://127.0.0.1:1" if mode == "outage" else ENDPOINT,
                              mode="off" if mode == "off" else "compress", on_report=reports.append, on_diagnostic=diagnostics.append)
    selected_scope = Scope("f09-native-" + uuid.uuid4().hex, "session")
    barrier = asyncio.Event()

    def make_tool(name):
        @tool(name=name, description="Read original " + name)
        async def read(marker: str) -> str:
            test.assertEqual(marker, "native-main" if name == "read_logs" else "native-aux")
            executions.append(name)
            if parallel:
                if len(executions) == 2:
                    barrier.set()
                await asyncio.wait_for(barrier.wait(), 3)
            return SOURCES[name]
        return read

    tools = [make_tool(name) for name in (["read_logs", "read_aux"] if parallel else ["read_logs"])]

    def create(messages=None):
        options = {"model": server.model(), "tools": tools, "messages": messages or [], "system_prompt": "Keep native caller configuration.",
                   "callback_handler": None, "tool_executor": ConcurrentToolExecutor()}
        agent = Agent(**(options if unwrapped else with_caveman_agent(options, runtime=runtime, scope=selected_scope)))

        def before(event):
            test.assertIs(event.agent, agent)
            hooks.append(type(event).__name__)
            for message in agent.messages:
                tracking = message.get("tracking_id")
                if tracking is not None:
                    test.assertEqual(str(uuid.UUID(tracking)), tracking)
                    key = (id(agent), id(message))
                    if key in message_refs:
                        test.assertEqual(tracking, message_refs[key], "native message tracking ID remains stable")
                    message_refs[key] = tracking
            for original in original_results(agent):
                key = (id(agent), original["toolUseId"])
                if key in source_refs:
                    test.assertIs(original, source_refs[key], "native agent history retains the original result object")
                source_refs[key] = original
        agent.add_hook(before, BeforeModelCallEvent)
        return agent

    agent, hook_resumes, details = None, 0, {}
    try:
        if mode == "compress" and not unwrapped:
            await asyncio.to_thread(runtime.ready)
        agent = create()
        if method == "every_model_continuation":
            def resume(event):
                nonlocal hook_resumes
                if not hook_resumes:
                    hook_resumes += 1; server.resume = True
                    event.resume = "Recover the persisted source again."
            agent.add_hook(resume, AfterInvocationEvent)
        if method == "agent.__call__":
            result = await asyncio.to_thread(agent, "Read original logs and recover the omitted detail.")
            test.assertEqual(result.message["content"], [{"text": FACT}])
        elif streamed:
            details = await consume_agent(test, agent, server, action=lifecycle_action if method == "cancel_and_close" else None)
            result = details.pop("result")
        else:
            result = await agent.invoke_async("Read original logs and recover the omitted detail.")
            test.assertEqual(result.message["content"], [{"text": FACT}])
        for original in original_results(agent):
            test.assertEqual(original["content"][0]["text"], SOURCES["read_logs" if original["toolUseId"] == "read-1" else "read_aux"])
        phase_start = {"calls": len(server.calls), "reports": len(reports), "plans": len(runtime.plans)}
        if method == "model.stream":
            details.update(await direct_model_stream(test, agent, server))
        elif method == "model.structured_output":
            server.structured = True
            before = copy.deepcopy(agent.messages)
            typed_model = with_caveman_model(server.model(), runtime=runtime, scope=Scope(selected_scope.namespace, selected_scope.session_id, "typed", "1"))
            typed_events = [event async for event in typed_model.structured_output(Answer, agent.messages, agent.system_prompt)]
            test.assertEqual(typed_events[-1]["output"], Answer(answer=42))
            test.assertEqual(agent.messages, before)
            test.assertEqual(len(server.calls) - phase_start["calls"], 1)
            test.assertTrue(all(report.replacement_count == 0 for report in reports[phase_start["reports"]:]))
            test.assertTrue(all(not plan.replacements for _, plan in runtime.plans[phase_start["plans"]:]))
            details["typed"] = {"output": typed_events[-1]["output"].model_dump(), "native_calls": 1,
                "native_iterator_events": len(typed_events), "native_event_types": sorted({key for event in typed_events for key in event}),
                "schema": next(action["schema"] for action in server.actions if action["type"] == "structured"), "replacements": 0,
                "callback_reports": [report_view(report) for report in reports[phase_start["reports"]:]]}
        elif method == "resumed_session":
            persisted = json.dumps(agent.messages, ensure_ascii=False)
            await asyncio.to_thread(restart_runtime)
            if mode == "compress":
                await asyncio.to_thread(runtime.ready)
            agent = create(json.loads(persisted)); test.assertEqual(json.dumps(agent.messages, ensure_ascii=False), persisted)
            server.resume = True
            result = await agent.invoke_async("Recover the persisted source again.")
            test.assertEqual(result.message["content"], [{"text": FACT}])
            details["native_history_json_roundtrip"] = True; details["runtime_process_restarts"] = 1
        wire = server.calls[1]["body"]
        wire_source = next(r["text"] for r in native_results(wire, protocol) if r["id"] == "read-1")
        recoveries = [action for action in server.actions if action["type"].startswith("recover")]
        test.assertEqual(len(executions), 2 if parallel else 1)
        if unwrapped:
            test.assertEqual(reports, [])
        else:
            test.assertEqual(len(reports), len(server.calls), "one callback for every native model dispatch")
            test.assertIs(runtime.last_report, reports[-1])
            for index, report in enumerate(reports):
                test.assertEqual(report.schema_version, 1); test.assertIsInstance(report.transform_ids, tuple)
                with test.assertRaises((FrozenInstanceError, AttributeError)):
                    report.status = "forged"
                test.assertNotIn(FACT, repr(report)); test.assertEqual(report.adapter, "strands")
                changed = sum(r["id"].startswith("read-") and HANDLE.search(r["text"]) is not None for r in native_results(server.calls[index]["body"], protocol))
                test.assertEqual(report.replacement_count, changed, "report counts the native provider's actual view")
                test.assertIn(report.status, ("applied", "reused") if changed else ("skipped", "disabled"))
                if mode == "off":
                    test.assertEqual(report.status, "disabled")
        if mode == "compress" and not unwrapped:
            test.assertNotEqual(wire_source, SOURCES["read_logs"]); test.assertNotIn(FACT, wire_source)
            test.assertEqual(recoveries[0]["handle"], HANDLE.search(wire_source)[0])
            if method in ("resumed_session", "every_model_continuation", "model.stream"):
                test.assertTrue(any(action["type"] == "recover_resume" for action in recoveries))
            expected = 4 if parallel or method == "model.structured_output" else 5 if method in ("resumed_session", "every_model_continuation", "model.stream") else 3
        else:
            test.assertEqual(wire_source, SOURCES["read_logs"]); test.assertEqual(recoveries, [])
            expected = 3 if method in ("resumed_session", "every_model_continuation", "model.stream", "model.structured_output") else 2
            if mode == "off":
                test.assertEqual(runtime.plans, [])
        test.assertEqual(len(server.calls), expected)
        test.assertEqual(len(hooks), phase_start["calls"] if method in ("model.stream", "model.structured_output") else len(server.calls))
        test.assertEqual(server.errors, [])
        for message in agent.messages:
            key = (id(agent), id(message))
            if key in message_refs:
                test.assertEqual(message.get("tracking_id"), message_refs[key])
        if method == "every_model_continuation":
            test.assertEqual(hook_resumes, 1)
        return {"mode": "unwrapped" if unwrapped else mode, "method": method, "native_entry_point": "Model.stream + native process_stream + DecoratedFunctionTool.stream" if method == "model.stream" else method,
            "native_tool_calls": executions, "provider_calls": len(server.calls), "native_model_hook_calls": len(hooks),
            "source_sha256": digest(SOURCES["read_logs"]), "provider_source_sha256": digest(normalized(wire_source)), "transformed_request_sha256": digest(normalized(wire)),
            "omitted_fact_absent": FACT not in wire_source, "recovery_requests": len(recoveries), "recovered_source_sha256": digest(SOURCES["read_logs"]) if recoveries else None,
            "original_result_identity_preserved": True, "native_history_sha256": digest(normalized(agent.messages)), "callback_reports": [report_view(report) for report in reports],
            "native_tracking_ids_preserved": True,
            "evidence_normalization": ["opaque recovery handles", "native message tracking UUID relationships", "observed nonnegative first-byte timing"],
            "native_hook_resumes": hook_resumes, **details}
    except BaseException:
        print("CAVEMAN_MIDDLEWARE_FAILURE " + json.dumps({"family": "F09", "cell_id": cell["id"], "mode": mode,
            "lifecycle_action": lifecycle_action, "unwrapped": unwrapped, "provider_calls": len(server.calls),
            "native_tool_calls": executions, "callback_reports": [report_view(report) for report in reports], "diagnostics": diagnostics,
            "runtime_plans": [{"status": plan.status, "reason": plan.reason, "replacements": len(plan.replacements)} for _, plan in runtime.plans],
            "required_journey_complete": False}), flush=True)
        raise
    finally:
        await server.close()
        runtime.close()


async def certify_all(test):
    selected = os.environ.get("CAVEMAN_STRANDS_CERT_CELL", "")
    for cell in CELLS:
        if cell["language"] != "python" or selected and selected not in cell["id"]:
            continue
        with test.subTest(cell=cell["id"]):
            controls = {mode: await run(test, cell, mode) for mode in ("compress", "off", "outage")}
            active = controls["compress"]
            test.assertEqual(active["native_tool_calls"], controls["off"]["native_tool_calls"])
            test.assertEqual(active["native_tool_calls"], controls["outage"]["native_tool_calls"])
            if cell["method"] == "cancel_and_close":
                baseline = await run(test, cell, "off", unwrapped=True)
                for result in controls.values():
                    test.assertEqual(result["lifecycle"], baseline["lifecycle"])
                active["unwrapped_native_cancellation"] = baseline["lifecycle"]
                active["strict_transport_cancellation_passed"] = baseline["lifecycle"]["provider_closed_before_release"]
                early = {mode: await run(test, cell, mode, lifecycle_action="return") for mode in ("compress", "off", "outage")}
                early_baseline = await run(test, cell, "off", lifecycle_action="return", unwrapped=True)
                for result in early.values():
                    test.assertEqual(result["lifecycle"], early_baseline["lifecycle"])
                active["early_generator_close"] = {"unwrapped": early_baseline["lifecycle"], **early}
                active["strict_transport_early_close_passed"] = early_baseline["lifecycle"]["provider_closed_before_release"]
            observed = lambda value: {"outcome": "observed", **value}
            free = {"outcome": "recovery_free", "reason": "native Model.structured_output contract", "replacements": 0, "recovery_requests": 0,
                    "typed": active.get("typed")} if cell["structured_output"] else None
            observations = {
                "native_application": observed({"provider": cell["provider"], "method": cell["method"], "native_entry_point": active["native_entry_point"]}),
                "real_tool_result": observed({"native_tool_calls": active["native_tool_calls"], "source_sha256": active["source_sha256"], "native_result_identity_preserved": True}),
                "transformed_provider_request": free or observed({"request_sha256": active["transformed_request_sha256"], "provider_source_sha256": active["provider_source_sha256"], "omitted_fact_absent": active["omitted_fact_absent"]}),
                "omitted_fact_requested": free or observed({"native_recovery_calls": active["recovery_requests"], "exact_wire_handle_requested": True}),
                "host_executes_exact_recovery": free or observed({"source_sha256": active["source_sha256"], "exact_recovered_sha256": active["recovered_source_sha256"], "native_executor": "Strands decorated tools"}),
                "native_result_history_events_and_call_count": observed(active), "off_baseline": observed(controls["off"]), "optimizer_unavailable": observed(controls["outage"]),
            }
            for assertion, observation in observations.items():
                print("CAVEMAN_MIDDLEWARE_OBSERVATION " + json.dumps({"cell_id": cell["id"], "test_id": TEST_ID, "assertion": assertion, "observation": observation}), flush=True)
