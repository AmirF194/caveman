"""Exact F14 cells through installed Pydantic AI, real HTTP, and the Go runtime."""
import asyncio
import hashlib
import json
import os
from contextlib import nullcontext
from pathlib import Path

from pydantic_ai import Agent, CancellationToken, NativeOutput
from pydantic_ai.exceptions import RunCancelled
from pydantic_ai.messages import ModelMessagesTypeAdapter, ModelResponse, RetryPromptPart, ThinkingPart, ToolCallPart, ToolReturnPart
from pydantic_ai.models import ModelRequestParameters
from caveman_cloud.middleware import Scope
from caveman_middleware.pydantic_ai import with_caveman_model
from evidence_runtime import EvidenceRuntime
from _certification_fixture import Provider
from _fixture import Fixture, NativePauseFixture, SOURCE, text_content
from test_native import Answer, Dependencies, ObserveOriginal, close_sync, make, model, read_logs

FILE = "examples/middleware/pydantic-ai/test_native.py"
FACT = "retained-detail-70"
HASH = hashlib.sha256(SOURCE.encode()).hexdigest()


def digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode()).hexdigest()


def runtime_for(mode):
    reports = []
    runtime = EvidenceRuntime(endpoint="http://127.0.0.1:1" if mode == "outage" else os.environ["CAVEMAN_MIDDLEWARE_ENDPOINT"],
        mode="off" if mode == "off" else "compress", deadline_ms=200 if mode == "outage" else 3000, on_report=reports.append)
    runtime.reports = reports
    return runtime


def parts(history, kind, name=None):
    return [part for message in history for part in message.parts if type(part) is kind and (name is None or part.tool_name == name)]


def provider_results(body, protocol):
    if protocol == "openai":
        names = {call["id"]: call["function"]["name"] for message in body["messages"] for call in message.get("tool_calls", [])}
        return {names[message["tool_call_id"]]: text_content(message["content"]) for message in body["messages"] if message["role"] == "tool"}
    names = {part["id"]: part["name"] for message in body["messages"] if isinstance(message["content"], list) for part in message["content"] if part["type"] == "tool_use"}
    return {names[part["tool_use_id"]]: text_content(part["content"]) for message in body["messages"] if isinstance(message["content"], list) for part in message["content"] if part["type"] == "tool_result"}


def verify(test, cell, mode, fixture, runtime, result, output, deps, observer, *, history_before=None, restored=None, first_before_eof=False, closed=False):
    structured, cancelled = cell["structured_output"], cell["method"] == "cancel_and_close"
    active = mode == "compress" and cell["recovery"] == "native_executor"
    history = result.all_messages() if hasattr(result, "all_messages") else restored
    source = parts(history, ToolReturnPart, "read_logs")
    test.assertTrue(source)
    test.assertTrue(all(part.content.encode() == SOURCE.encode() for part in source))
    serialized = ModelMessagesTypeAdapter.dump_json(history)
    test.assertEqual(ModelMessagesTypeAdapter.dump_json(ModelMessagesTypeAdapter.validate_json(serialized)), serialized)
    if restored is not None and history_before is not None:
        test.assertEqual(ModelMessagesTypeAdapter.dump_json(restored), history_before)
    if observer is not None:
        observed = [part for _, request in observer.contexts for part in parts(request.messages, ToolReturnPart, "read_logs")]
        test.assertTrue(observed)
        test.assertTrue(any(part is source[0] for part in observed))
    recovered = parts(history, ToolReturnPart, "caveman_retrieve")
    test.assertEqual(len(recovered), int(active))
    if active:
        test.assertEqual(recovered[0].content["text"].encode(), SOURCE.encode())
        test.assertEqual(recovered[0].content["source_id"], source[0].tool_call_id)
        shortened = [provider_results(body, cell["provider"])["read_logs"] for _, body in fixture.calls if "read_logs" in provider_results(body, cell["provider"]) and "cmw_" in provider_results(body, cell["provider"])["read_logs"]]
        test.assertTrue(shortened)
        test.assertTrue(all(FACT not in text for text in shortened))
        test.assertTrue(any(plan.replacements for _, plan in runtime.plans))
    else:
        test.assertFalse(any(plan.replacements for _, plan in runtime.plans))
        test.assertTrue(any(provider_results(body, cell["provider"]).get("read_logs") == SOURCE for _, body in fixture.calls))
    test.assertEqual(output, {"answer": 42} if structured else FACT[:9] if cancelled else FACT)
    test.assertTrue(all(ctx.deps is deps for ctx, _ in deps.calls))
    test.assertTrue(all(request.headers["x-native-option"] == "preserved" and body["temperature"] == 0.2 for request, body in fixture.calls))
    retry = cell["method"] == "RetryPromptPart_and_ToolReturnPart" or (cell["method"] == "every_model_continuation" and cell["provider"] == "openai")
    test.assertEqual([ctx.retry for ctx, _ in deps.calls], [0, 1] if retry else [0])
    retry_parts = parts(history, RetryPromptPart)
    test.assertEqual(len(retry_parts), int(retry))
    if retry:
        test.assertIn("retry-guard", retry_parts[0].content)
    pause = cell["method"] == "every_model_continuation" and cell["provider"] == "anthropic"
    if pause:
        test.assertTrue(any(part.signature == "signed-pause-signature" for part in parts(history, ThinkingPart)))
    expected = 2 + int(active) + int(retry) + int(pause) + int(cell["method"] == "history_resume")
    if cell["method"] == "model_only":
        expected = 3
    test.assertEqual(len(fixture.calls), expected)
    expected_plans = 1 if cell["method"] == "model_only" else expected
    test.assertEqual(len(runtime.plans), 0 if mode == "off" else expected_plans)
    test.assertEqual(len(runtime.reports), expected_plans)
    test.assertEqual(len({report.attempt_id for report in runtime.reports}), expected_plans)
    test.assertTrue(all(report.adapter == "pydantic-ai" for report in runtime.reports))
    test.assertEqual(sum(report.replacement_count for report in runtime.reports), sum(len(plan.replacements) for _, plan in runtime.plans))
    if mode == "off":
        test.assertTrue(all(report.status == "disabled" and not report.transform_ids for report in runtime.reports))
    completed = [receipt for receipt in runtime.receipts if receipt["event_kind"] == "completed"]
    if mode == "off":
        test.assertFalse(runtime.receipts)
    else:
        test.assertEqual(len(completed), expected_plans - int(cancelled))
        test.assertTrue(all(receipt["usage"]["output_tokens"] == 20 for receipt in completed))
    if cancelled and mode != "off":
        test.assertEqual(runtime.receipts[-1]["event_kind"], "cancelled")
        test.assertIsNone(runtime.receipts[-1]["usage"])
    body_sources = [provider_results(body, cell["provider"]).get("read_logs") for _, body in fixture.calls]
    return {"final_value": output, "native_type": type(result).__name__, "provider_calls": len(fixture.calls),
        "source_executions": len(deps.calls), "source_sha256": HASH, "stored_source_sha256": digest(source[0].content),
        "recovered_sha256": digest(recovered[0].content["text"]) if recovered else None,
        "recovery_requests": len(recovered), "replacements": sum(len(plan.replacements) for _, plan in runtime.plans),
        "optimize_invocations": len(runtime.plans), "native_call_reports": [report.status for report in runtime.reports],
        "history_types": [type(part).__name__ for message in history for part in message.parts],
        "source_identity_preserved": True, "typed_history_roundtrip": True, "dependency_identity_preserved": True,
        "retry_parts": len(retry_parts), "provider_pause": pause, "resumed_history_unchanged": cell["method"] == "history_resume",
        "first_before_fixture_eof": first_before_eof, "peer_eof_before_release": closed,
        "provider_stream_flags": [bool(body.get("stream")) for _, body in fixture.calls],
        "model_only_last_request_sha256": digest(fixture.calls[-1][0].content) if cell["method"] == "model_only" else None}


def setup(cell, mode):
    pause = cell["method"] == "every_model_continuation" and cell["provider"] == "anthropic"
    fixture = NativePauseFixture(cell["provider"], suspended=True) if pause else Fixture(cell["provider"], structured=cell["structured_output"])
    if cell["structured_output"] or not cell["streaming"]:
        fixture.release.set()
    retry = cell["method"] == "RetryPromptPart_and_ToolReturnPart" or (cell["method"] == "every_model_continuation" and cell["provider"] == "openai")
    return fixture, runtime_for(mode), Dependencies(retry=retry), ObserveOriginal(), Scope("pydantic-certification", digest(cell["id"] + mode))


async def async_case(test, cell, mode):
    fixture, runtime, deps, observer, scope = setup(cell, mode)
    with Provider(fixture) as server:
        native, client = model(server, cell["provider"])
        try:
            if mode == "compress":
                await runtime.as_async().ready()
            agent = make(native, runtime, scope=scope, capabilities=[observer], output_type=NativeOutput(Answer) if cell["structured_output"] else str)
            options = dict(deps=deps, conversation_id="conversation", metadata={"caveman_branch_id": "branch", "caveman_cache_epoch": "epoch"})
            first = closed = False
            restored = history_before = None
            if cell["method"] == "model_only":
                initial = await Agent(native, tools=[read_logs], deps_type=Dependencies).run("Find detail", **options)
                restored = initial.all_messages()
                history_before = ModelMessagesTypeAdapter.dump_json(restored)
                result = await with_caveman_model(native, runtime=runtime, scope=scope).request(restored, None, ModelRequestParameters())
                output, observer = result.parts[0].content, None
            elif cell["streaming"]:
                async with agent.run_stream("Find detail", **options) as result:
                    if cell["structured_output"]:
                        output = (await result.get_output()).model_dump()
                    else:
                        chunks = []
                        async for chunk in result.stream_text(delta=True, debounce_by=None):
                            if chunk and not chunks:
                                first = not fixture.finished
                                test.assertTrue(first)
                                if cell["method"] == "cancel_and_close":
                                    chunks.append(chunk)
                                    await result.cancel()
                                    break
                                fixture.release.set()
                            chunks.append(chunk)
                        output = "".join(chunks)
                if cell["method"] == "cancel_and_close":
                    test.assertFalse(fixture.release.is_set())
                    closed = await asyncio.to_thread(server.peer_closed)
                    test.assertTrue(closed)
            else:
                result = await agent.run("Find detail", **options)
                if cell["method"] == "history_resume":
                    history_before = result.all_messages_json()
                    restored = ModelMessagesTypeAdapter.validate_json(history_before)
                    result = await agent.run("Continue", message_history=restored, **options)
                output = result.output.model_dump() if cell["structured_output"] else result.output
            row = verify(test, cell, mode, fixture, runtime, result, output, deps, observer, history_before=history_before, restored=restored, first_before_eof=first, closed=closed)
            test.assertEqual(server.errors, [])
            return row
        finally:
            fixture.release.set()
            await client.close()
            runtime.close()


def sync_case(test, cell, mode):
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    fixture, runtime, deps, observer, scope = setup(cell, mode)
    with Provider(fixture) as server:
        native, client = model(server, cell["provider"])
        try:
            if mode == "compress":
                runtime.ready()
            agent = make(native, runtime, scope=scope, capabilities=[observer], output_type=NativeOutput(Answer) if cell["structured_output"] else str)
            options = dict(deps=deps, conversation_id="conversation", metadata={"caveman_branch_id": "branch", "caveman_cache_epoch": "epoch"})
            first = closed = False
            restored = history_before = None
            if cell["method"] == "model_only":
                initial = Agent(native, tools=[read_logs], deps_type=Dependencies).run_sync("Find detail", **options)
                restored = initial.all_messages()
                history_before = ModelMessagesTypeAdapter.dump_json(restored)
                result = loop.run_until_complete(with_caveman_model(native, runtime=runtime, scope=scope).request(restored, None, ModelRequestParameters()))
                output, observer = result.parts[0].content, None
            elif cell["streaming"]:
                token = CancellationToken()
                expected_error = test.assertRaises(RunCancelled) if cell["method"] == "cancel_and_close" else nullcontext()
                with expected_error:
                    with agent.run_stream_sync("Find detail", cancellation_token=token, **options) as result:
                        if cell["structured_output"]:
                            output = result.get_output().model_dump()
                        else:
                            chunks = []
                            for chunk in result.stream_text(delta=True, debounce_by=None):
                                if chunk and not chunks:
                                    first = not fixture.finished
                                    test.assertTrue(first)
                                    if cell["method"] == "cancel_and_close":
                                        chunks.append(chunk)
                                        token.cancel()
                                        break
                                    fixture.release.set()
                                chunks.append(chunk)
                            output = "".join(chunks)
                if cell["method"] == "cancel_and_close":
                    test.assertFalse(fixture.release.is_set())
                    closed = server.peer_closed()
                    test.assertTrue(closed)
            else:
                result = agent.run_sync("Find detail", **options)
                if cell["method"] == "history_resume":
                    history_before = result.all_messages_json()
                    restored = ModelMessagesTypeAdapter.validate_json(history_before)
                    result = agent.run_sync("Continue", message_history=restored, **options)
                output = result.output.model_dump() if cell["structured_output"] else result.output
            row = verify(test, cell, mode, fixture, runtime, result, output, deps, observer, history_before=history_before, restored=restored, first_before_eof=first, closed=closed)
            test.assertEqual(server.errors, [])
            return row
        finally:
            fixture.release.set()
            close_sync(client)
            runtime.close()


def emit(test, cell, journey):
    name = ".".join(test.id().split(".")[-2:])
    for assertion, observation in journey.items():
        print("CAVEMAN_MIDDLEWARE_OBSERVATION " + json.dumps({"cell_id": cell["id"], "test_id": FILE + "::" + name, "assertion": assertion, "observation": observation}, separators=(",", ":")), flush=True)


async def certify_cells(test, provider, execution):
    cells = [cell for cell in json.loads(Path(__file__).with_name("certification-cells.json").read_text())["cells"] if cell["provider"] == provider and cell["execution"] == execution]
    test.assertEqual(len(cells), 10)
    for cell in cells:
        with test.subTest(cell=cell["id"]):
            rows = {mode: await async_case(test, cell, mode) if execution == "async" else await asyncio.to_thread(sync_case, test, cell, mode) for mode in ("compress", "off", "outage")}
            active, off, unavailable = rows["compress"], rows["off"], rows["outage"]
            for baseline in (off, unavailable):
                test.assertEqual(active["final_value"], baseline["final_value"])
                test.assertEqual(active["source_executions"], baseline["source_executions"])
                test.assertEqual(active["source_identity_preserved"], baseline["source_identity_preserved"])
                test.assertEqual(baseline["recovery_requests"], 0)
                if cell["recovery"] == "model_only":
                    test.assertEqual(active["history_types"], baseline["history_types"])
                    test.assertEqual(active["model_only_last_request_sha256"], baseline["model_only_last_request_sha256"])
            free = {"outcome": "recovery_free", "reason": "native typed-output contract" if cell["structured_output"] else "standalone model has no native executor", "recovery_requests": 0, "replacements": 0, "original_source_sha256": HASH} if cell["recovery"] == "model_only" else None
            observed = lambda row: {"outcome": "observed", **row}
            emit(test, cell, {
                "native_application": {"outcome": "observed", "method": cell["method"], "execution": execution, "provider": provider, "execution_owner": "native_pydantic_agent", "native_sync_model_bridge": cell["method"] == "model_only" and execution == "sync"},
                "real_tool_result": {"outcome": "observed", "executor": "read_logs", "source_executions": active["source_executions"], "source_sha256": HASH, "utf8_bytes": len(SOURCE.encode())},
                "transformed_provider_request": free or {"outcome": "observed", "replacement_count": active["replacements"], "omitted_fact_absent": True, "stored_source_sha256": active["stored_source_sha256"]},
                "omitted_fact_requested": free or {"outcome": "observed", "fact": FACT, "native_recovery_function": "caveman_retrieve", "recovery_requests": active["recovery_requests"]},
                "host_executes_exact_recovery": free or {"outcome": "observed", "execution_owner": "native_pydantic_agent", "source_sha256": HASH, "recovered_sha256": active["recovered_sha256"]},
                "native_result_history_events_and_call_count": observed(active), "off_baseline": observed(off), "optimizer_unavailable": observed(unavailable),
            })
