"""Exact F08 operations through installed Agno, real HTTP, and the Go runtime."""
import asyncio
import copy
import hashlib
import inspect
import json
import os
import re
from dataclasses import asdict
from pathlib import Path
from unittest.mock import patch

from agno.agent import Agent
from agno.models.message import Message
from agno.models.response import ModelResponse
from agno.run.agent import RunOutput
from agno.run.base import BaseRunOutputEvent
from agno.run.team import TeamRunOutput
from agno.tools.function import Function
from caveman_cloud.middleware import Scope
from caveman_middleware.agno import with_caveman_model
from caveman_middleware._native import owner
from evidence_runtime import EvidenceRuntime
from example import build
from _certification_fixture import Provider
from test_native import Answer, Fixture, SOURCE, model, text_content

FILE = "examples/middleware/agno/test_native.py"
FACT = "retained-detail-70"
HASH = hashlib.sha256(SOURCE.encode()).hexdigest()


def digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode()).hexdigest()


def provider_results(body, protocol):
    if protocol == "openai":
        names = {call["id"]: call["function"]["name"] for message in body["messages"] for call in message.get("tool_calls", [])}
        return {names[message["tool_call_id"]]: text_content(message["content"]) for message in body["messages"] if message["role"] == "tool"}
    names = {part["id"]: part["name"] for message in body["messages"] if isinstance(message["content"], list) for part in message["content"] if part["type"] == "tool_use"}
    return {names[part["tool_use_id"]]: text_content(part["content"]) for message in body["messages"] if isinstance(message["content"], list) for part in message["content"] if part["type"] == "tool_result"}


class ContinuationFixture(Fixture):
    """Force a second real application tool inside the same native Model loop."""
    def response(self, request):
        body = json.loads(request.content)
        results = provider_results(body, self.protocol)
        source = results.get("read_logs")
        if source and ("caveman_retrieve" in results or "cmw_" not in source) and "inspect_row" not in results:
            self.calls.append((request, body))
            original = json.loads(results["caveman_retrieve"])["text"] if "caveman_retrieve" in results else source
            assert original.encode() == SOURCE.encode()
            call = ("inspect-1", "inspect_row", {"row": 70})
            return self.openai_response(body, call, "") if self.protocol == "openai" else self.anthropic_response(body, call, "")
        if "inspect_row" in results:
            assert results["inspect_row"] == FACT
        return super().response(request)


class Application:
    def __init__(self, *, continuation):
        self.reads, self.inspections, self.callbacks, self.factories = [], [], [], []

        def read_logs(path: str = "fixture/diagnostics.log") -> str:
            """Read the original diagnostic source."""
            if path != "fixture/diagnostics.log":
                raise ValueError("Unexpected fixture path")
            self.reads.append(path)
            return SOURCE

        def inspect_row(row: int) -> str:
            """Inspect the retained diagnostic row."""
            if row != 70:
                raise ValueError("Unexpected fixture row")
            self.inspections.append(row)
            return FACT

        def after(fc, run_context):
            self.callbacks.append((fc, run_context))

        self.tools = [Function(name="read_logs", entrypoint=read_logs, post_hook=after)]
        if continuation:
            self.tools.append(Function(name="inspect_row", entrypoint=inspect_row, post_hook=after))

    def factory(self, run_context):
        self.factories.append(run_context)
        return self.tools


def setup(cell, mode):
    continuation = cell["method"] == "internal_model_continuation"
    fixture = (ContinuationFixture if continuation else Fixture)(cell["provider"], structured=cell["structured_output"], reasoning=cell["provider"] == "anthropic")
    if not cell["streaming"]:
        fixture.release.set()
    reports = []
    runtime = EvidenceRuntime(endpoint="http://127.0.0.1:1" if mode == "outage" else os.environ["CAVEMAN_MIDDLEWARE_ENDPOINT"],
        mode="off" if mode == "off" else "compress", deadline_ms=200 if mode == "outage" else 3000, on_report=reports.append)
    runtime.reports = reports
    return fixture, runtime, Application(continuation=continuation), Scope("agno-certification", digest(cell["id"] + mode), "branch", "epoch")


def agent_for(cell, native, runtime, app, scope):
    team = cell["method"] == "team.run"
    return build(native, runtime, tools=app.factory if team else app.tools, namespace=scope.namespace, team=team,
        id="native-owner", session_id=scope.session_id, user_id="native-user",
        metadata={"caveman_branch_id": scope.branch_id, "caveman_cache_epoch": scope.cache_epoch},
        **({"output_schema": Answer} if cell["structured_output"] else {}))


def stored(messages):
    return [message for message in messages if message.role == "tool" and message.tool_call_id == "read-1"]


def verify(test, cell, mode, fixture, runtime, app, scope, result, output, messages, events, *, first=False, closed=None, cancelled=None):
    active = mode == "compress" and cell["recovery"] == "native_executor"
    partial = cell["method"] == "cancel_and_close"
    standalone = cell["method"] == "model_only"
    continued = cell["method"] == "internal_model_continuation"
    sources = [message.content for message in stored(messages)] if messages is not None else [event.tool.result for event in events if event.event == "ToolCallCompleted" and event.tool.tool_name == "read_logs"]
    test.assertEqual(len(sources), 1)
    test.assertEqual(sources[0].encode(), SOURCE.encode())
    test.assertEqual(app.reads, ["fixture/diagnostics.log"])
    test.assertEqual(app.inspections, [70] if continued else [])
    source_callbacks = [fc for fc, _ in app.callbacks if fc.function.name == "read_logs"]
    test.assertEqual(len(source_callbacks), 1)
    test.assertIs(source_callbacks[0].result, SOURCE)
    test.assertEqual(source_callbacks[0].arguments, {"path": "fixture/diagnostics.log"})
    if not standalone:
        test.assertTrue(all(context.session_id == scope.session_id for _, context in app.callbacks))
    if cell["method"] == "team.run":
        test.assertEqual(len(app.factories), 1)
        test.assertEqual(app.factories[0].session_id, scope.session_id)
        test.assertIsInstance(result, TeamRunOutput)
        test.assertEqual(result.team_id, "native-owner")
    elif not standalone and not partial:
        test.assertIsInstance(result, RunOutput)
        test.assertEqual(result.agent_id, "native-owner")
    recovered = [message.content for message in messages if message.role == "tool" and message.tool_name == "caveman_retrieve"] if messages is not None else [event.tool.result for event in events if event.event == "ToolCallCompleted" and event.tool.tool_name == "caveman_retrieve"]
    test.assertEqual(len(recovered), int(active))
    on_wire = [provider_results(body, cell["provider"]) for _, body in fixture.calls]
    if active:
        original = json.loads(recovered[0])["text"]
        test.assertEqual(original.encode(), SOURCE.encode())
        compressed = [row["read_logs"] for row in on_wire if "read_logs" in row and re.search(r"cmw_[a-f0-9]{48}", row["read_logs"])]
        test.assertTrue(compressed)
        test.assertTrue(all(FACT not in text for text in compressed))
        test.assertTrue(any(plan.replacements for _, plan in runtime.plans))
    else:
        original = None
        test.assertTrue(any(row.get("read_logs") == SOURCE for row in on_wire))
        test.assertFalse(any(plan.replacements for _, plan in runtime.plans))
    test.assertEqual(output, {"answer": 42} if cell["structured_output"] else FACT[:9] if partial else FACT)
    test.assertTrue(all(body["temperature"] == 0.2 for _, body in fixture.calls))
    if cell["provider"] == "openai":
        test.assertTrue(all(body["reasoning_effort"] == "low" and request.headers["x-native-option"] == "preserved" for request, body in fixture.calls))
    else:
        blocks = [part for _, body in fixture.calls for message in body["messages"] if isinstance(message["content"], list) for part in message["content"]]
        test.assertIn({"type": "thinking", "thinking": "native reasoning", "signature": "signed-fixture-signature"}, blocks)
    if cell["structured_output"]:
        test.assertTrue(all(body.get("response_format") or body.get("output_config") or body.get("output_format") for _, body in fixture.calls))
        test.assertTrue(all("caveman_retrieve" not in json.dumps(body["tools"]) for _, body in fixture.calls))
    expected = 3 if standalone else 2 + int(active) + int(continued)
    intercepted = 1 if standalone else expected
    test.assertEqual(len(fixture.calls), expected)
    test.assertEqual(len(runtime.plans), 0 if mode == "off" else intercepted)
    test.assertEqual(len(runtime.reports), intercepted)
    test.assertEqual(len({report.attempt_id for report in runtime.reports}), intercepted)
    test.assertTrue(all(report.adapter == "agno" for report in runtime.reports))
    test.assertEqual(sum(report.replacement_count for report in runtime.reports), sum(len(plan.replacements) for _, plan in runtime.plans))
    if mode == "off":
        test.assertTrue(all(report.status == "disabled" and not report.transform_ids for report in runtime.reports))
        test.assertFalse(runtime.receipts)
    else:
        test.assertEqual(len([receipt for receipt in runtime.receipts if receipt["event_kind"] == "dispatch_intent"]), intercepted)
        completed = [receipt for receipt in runtime.receipts if receipt["event_kind"] == "completed"]
        test.assertEqual(len(completed), intercepted - int(partial))
        test.assertTrue(all(receipt["usage"]["output_tokens"] == 20 for receipt in completed))
        test.assertTrue(all(receipt["scope"] == asdict(scope) for receipt in runtime.receipts))
        if partial:
            test.assertEqual(runtime.receipts[-1]["event_kind"], "cancelled")
            test.assertIsNone(runtime.receipts[-1]["usage"])
    if cell["streaming"]:
        test.assertTrue(first)
        test.assertTrue(all(isinstance(event, BaseRunOutputEvent) for event in events))
        test.assertEqual(events[0].event, "RunStarted")
        tool_events = [event.tool.tool_name for event in events if event.event == "ToolCallCompleted"]
        test.assertEqual(tool_events, ["read_logs", "caveman_retrieve"] if active else ["read_logs"])
        if not partial:
            test.assertEqual(events[-1].event, "RunCompleted")
    test.assertIsNone(owner.get())
    return {"final_value": output, "native_type": type(result).__name__, "provider_calls": len(fixture.calls),
        "source_executions": len(app.reads), "source_sha256": HASH, "stored_source_sha256": digest(sources[0]),
        "source_observed_in": "native_tool_completed_event" if messages is None else "native_run_history",
        "recovered_sha256": digest(original) if original is not None else None, "recovery_requests": len(recovered),
        "replacements": sum(len(plan.replacements) for _, plan in runtime.plans), "optimize_invocations": len(runtime.plans),
        "native_call_reports": [report.status for report in runtime.reports], "source_callback_identity_preserved": True,
        "tool_callbacks": [fc.function.name for fc, _ in app.callbacks], "internal_continuation_executions": len(app.inspections),
        "native_events": [event.event for event in events], "first_before_fixture_eof": first,
        "peer_eof_before_release": closed, "cancellation": cancelled,
        "provider_stream_flags": [bool(body.get("stream")) for _, body in fixture.calls],
        "model_only_last_request_sha256": digest(fixture.calls[-1][0].content) if standalone else None}


async def async_case(test, cell, mode):
    fixture, runtime, app, scope = setup(cell, mode)
    with Provider(fixture) as server:
        native, client = model(server, cell["provider"], asynchronous=True)
        iterator = None
        try:
            if mode == "compress":
                await runtime.as_async().ready()
            agent = agent_for(cell, native, runtime, app, scope)
            first, closed, cancelled, events = False, None, None, []
            if cell["method"] == "model_only":
                initial = await Agent(model=native, tools=app.tools, telemetry=False).arun("Read source")
                messages = initial.messages
                snapshot = copy.deepcopy(messages)
                result = await with_caveman_model(native, runtime=runtime, scope=scope).aresponse(messages.copy())
                test.assertIsInstance(result, ModelResponse)
                test.assertEqual(messages, snapshot)
                output = result.content
            elif cell["streaming"]:
                iterator = agent.arun("Read source", stream=True, stream_events=True, yield_run_output=True)
                chunks = []
                result = None
                async for event in iterator:
                    if isinstance(event, RunOutput):
                        result = event
                        continue
                    events.append(event)
                    if event.event == "RunContent" and event.content:
                        if not chunks:
                            first = not fixture.finished
                            test.assertTrue(first)
                        chunks.append(event.content)
                        if cell["method"] == "cancel_and_close":
                            async def remaining():
                                async for following in iterator:
                                    events.append(following)
                            pending = asyncio.create_task(remaining())
                            await asyncio.sleep(0)
                            test.assertFalse(pending.done())
                            pending.cancel()
                            with test.assertRaises(asyncio.CancelledError):
                                await pending
                            cancelled = "CancelledError"
                            await iterator.aclose()
                            test.assertFalse(fixture.release.is_set())
                            closed = await asyncio.to_thread(server.peer_closed)
                            test.assertTrue(closed)
                            break
                        fixture.release.set()
                output = "".join(chunks)
                result = result or events[-1]
                messages = result.messages if isinstance(result, RunOutput) else None
            else:
                result = await agent.arun("Read source")
                output = result.content.model_dump() if cell["structured_output"] else result.content
                messages = result.messages
            row = verify(test, cell, mode, fixture, runtime, app, scope, result, output, messages, events, first=first, closed=closed, cancelled=cancelled)
            test.assertEqual(server.errors, [])
            return row
        finally:
            fixture.release.set()
            if iterator is not None:
                await iterator.aclose()
            await client.close()
            runtime.close()


def sync_case(test, cell, mode):
    fixture, runtime, app, scope = setup(cell, mode)
    with Provider(fixture) as server:
        native, client = model(server, cell["provider"])
        iterator = None
        try:
            if mode == "compress":
                runtime.ready()
            agent = agent_for(cell, native, runtime, app, scope)
            first, closed, cancelled, events = False, None, None, []
            if cell["method"] == "model_only":
                initial = Agent(model=native, tools=app.tools, telemetry=False).run("Read source")
                messages = initial.messages
                snapshot = copy.deepcopy(messages)
                result = with_caveman_model(native, runtime=runtime, scope=scope).response(messages.copy())
                test.assertIsInstance(result, ModelResponse)
                test.assertEqual(messages, snapshot)
                output = result.content
            elif cell["streaming"]:
                iterator = agent.run("Read source", stream=True, stream_events=True, yield_run_output=True)
                chunks = []
                result = None
                for event in iterator:
                    if isinstance(event, RunOutput):
                        result = event
                        continue
                    events.append(event)
                    if event.event == "RunContent" and event.content:
                        if not chunks:
                            first = not fixture.finished
                            test.assertTrue(first)
                        chunks.append(event.content)
                        if cell["method"] == "cancel_and_close":
                            iterator.close()
                            test.assertEqual(inspect.getgeneratorstate(iterator), inspect.GEN_CLOSED)
                            test.assertFalse(fixture.release.is_set())
                            closed = server.peer_closed()
                            cancelled = "GeneratorExit"
                            break
                        fixture.release.set()
                output = "".join(chunks)
                result = result or events[-1]
                messages = result.messages if isinstance(result, RunOutput) else None
            else:
                result = agent.run("Read source")
                output = result.content.model_dump() if cell["structured_output"] else result.content
                messages = result.messages
            row = verify(test, cell, mode, fixture, runtime, app, scope, result, output, messages, events, first=first, closed=closed, cancelled=cancelled)
            test.assertEqual(server.errors, [])
            return row
        finally:
            fixture.release.set()
            if iterator is not None:
                iterator.close()
            client.close()
            runtime.close()


def emit(test, cell, journey):
    name = ".".join(test.id().split(".")[-2:])
    for assertion, observation in journey.items():
        print("CAVEMAN_MIDDLEWARE_OBSERVATION " + json.dumps({"cell_id": cell["id"], "test_id": FILE + "::" + name, "assertion": assertion, "observation": observation}, separators=(",", ":")), flush=True)


async def certify_cells(test, provider, execution):
    cells = [cell for cell in json.loads(Path(__file__).with_name("certification-cells.json").read_text())["cells"] if cell["provider"] == provider and cell["execution"] == execution]
    test.assertEqual(len(cells), 7)
    for cell in cells:
        with test.subTest(cell=cell["id"]):
            rows = {mode: await async_case(test, cell, mode) if execution == "async" else await asyncio.to_thread(sync_case, test, cell, mode) for mode in ("compress", "off", "outage")}
            active, off, unavailable = rows["compress"], rows["off"], rows["outage"]
            for baseline in (off, unavailable):
                for key in ("final_value", "source_executions", "source_callback_identity_preserved", "internal_continuation_executions", "tool_callbacks", "peer_eof_before_release", "cancellation"):
                    test.assertEqual(active[key], baseline[key])
                test.assertEqual(baseline["recovery_requests"], 0)
                if cell["method"] == "model_only":
                    test.assertEqual(active["model_only_last_request_sha256"], baseline["model_only_last_request_sha256"])
            free = {"outcome": "recovery_free", "reason": "native typed-output contract" if cell["structured_output"] else "standalone model has no native executor", "recovery_requests": 0, "replacements": 0, "original_source_sha256": HASH} if cell["recovery"] == "model_only" else None
            observed = lambda row: {"outcome": "observed", **row}
            emit(test, cell, {
                "native_application": {"outcome": "observed", "method": cell["method"], "execution": execution, "provider": provider, "execution_owner": "native_agno_team" if cell["method"] == "team.run" else "native_agno_model" if cell["method"] == "model_only" else "native_agno_agent"},
                "real_tool_result": {"outcome": "observed", "executor": "read_logs", "source_executions": active["source_executions"], "source_sha256": HASH, "utf8_bytes": len(SOURCE.encode())},
                "transformed_provider_request": free or {"outcome": "observed", "replacement_count": active["replacements"], "omitted_fact_absent": True, "stored_source_sha256": active["stored_source_sha256"]},
                "omitted_fact_requested": free or {"outcome": "observed", "fact": FACT, "native_recovery_function": "caveman_retrieve", "recovery_requests": active["recovery_requests"]},
                "host_executes_exact_recovery": free or {"outcome": "observed", "execution_owner": "native_agno_team" if cell["method"] == "team.run" else "native_agno_model", "source_sha256": HASH, "recovered_sha256": active["recovered_sha256"]},
                "native_result_history_events_and_call_count": observed(active), "off_baseline": observed(off), "optimizer_unavailable": observed(unavailable),
            })


async def passive_reports(test, execution):
    """Disabled, unknown-version, and opaque native inputs still report dispatch."""
    class OpaqueMessage(Message):
        pass

    for protocol in ("openai", "anthropic"):
        for reason in ("disabled", "unsupported_version", "unsupported_shape"):
            for streaming in (False, True):
                with test.subTest(protocol=protocol, reason=reason, streaming=streaming):
                    fixture = Fixture(protocol)
                    fixture.release.set()
                    reports = []
                    with Provider(fixture) as server, EvidenceRuntime(endpoint=os.environ["CAVEMAN_MIDDLEWARE_ENDPOINT"], mode="off" if reason == "disabled" else "compress", on_report=reports.append) as runtime:
                        native, client = model(server, protocol, asynchronous=execution == "async")
                        messages = [Message(role="user", content="Read source"), Message(role="assistant", tool_calls=[{
                            "id": "read-1", "type": "function", "function": {"name": "read_logs", "arguments": "{}"}}]),
                            (OpaqueMessage if reason == "unsupported_shape" else Message)(role="tool", tool_call_id="read-1", tool_name="read_logs", content=SOURCE)]
                        before = copy.deepcopy(messages)
                        with patch("caveman_middleware.agno.matches_framework", return_value=reason != "unsupported_version"):
                            wrapped = with_caveman_model(native, runtime=runtime, scope=Scope("agno-passive", reason))
                        try:
                            if execution == "async":
                                if streaming:
                                    output = "".join([event.content or "" async for event in wrapped.aresponse_stream(messages.copy())])
                                else:
                                    output = (await wrapped.aresponse(messages.copy())).content
                            else:
                                if streaming:
                                    output = "".join(event.content or "" for event in wrapped.response_stream(messages.copy()))
                                else:
                                    output = wrapped.response(messages.copy()).content
                            test.assertEqual(output, FACT)
                            test.assertEqual(messages, before)
                            test.assertEqual(len(fixture.calls), 1)
                            test.assertEqual(provider_results(fixture.calls[0][1], protocol)["read_logs"], SOURCE)
                            test.assertEqual(runtime.plans, [])
                            test.assertEqual(runtime.receipts, [])
                            test.assertEqual(len(reports), 1)
                            test.assertEqual(reports[0].adapter, "agno")
                            test.assertEqual(reports[0].status, "disabled" if reason == "disabled" else "skipped")
                            test.assertEqual(reports[0].reason, reason)
                            test.assertEqual(reports[0].replacement_count, 0)
                            test.assertFalse(reports[0].transform_ids)
                            test.assertIsNone(owner.get())
                            test.assertEqual(server.errors, [])
                        finally:
                            if execution == "async":
                                await client.close()
                            else:
                                client.close()
