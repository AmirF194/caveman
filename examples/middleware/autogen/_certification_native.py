"""Exact AutoGen operation journeys over native agents, clients and workbenches."""
from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import os
import re
from collections import Counter
from dataclasses import asdict
from pathlib import Path

from autogen_agentchat.agents import AssistantAgent
from autogen_agentchat.base import TaskResult
from autogen_agentchat.messages import ModelClientStreamingChunkEvent, TextMessage, ToolCallExecutionEvent, ToolCallRequestEvent
from autogen_agentchat.teams import RoundRobinGroupChat
from autogen_core import CancellationToken
from autogen_core.model_context import UnboundedChatCompletionContext
from autogen_core.models import ChatCompletionClient, CreateResult, UserMessage
from autogen_core.tools import FunctionTool
from caveman_cloud.middleware import Scope
from caveman_middleware.autogen import component_runtimes, with_caveman_agent, with_caveman_model
from evidence_runtime import EvidenceRuntime
from test_native import Answer, CaptureHTTPClient, FACT, Provider, ProgressTool, SOURCE, StatefulWorkbench, read_logs, read_other, source_rendering

TEST_FILE = "examples/middleware/autogen/test_native.py"
SOURCE_SHA = hashlib.sha256(SOURCE.encode()).hexdigest()


def sha(value):
    return hashlib.sha256((value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))).encode()).hexdigest()


def native_messages(state):
    return state["llm_context"]["messages"]


def originals(state):
    return [result for message in native_messages(state) if message["type"] == "FunctionExecutionResultMessage"
            for result in message["content"] if result["name"] in ("read_logs", "read_other")]


def reports_observed(test, runtime, reports, calls, mode):
    test.assertEqual(len(reports), calls)
    test.assertIs(runtime.last_report, reports[-1])
    fields = {"schema_version", "status", "reason", "transform_ids", "replacement_count", "reused_count", "adapter", "logical_call_id", "attempt_id"}
    for report in reports:
        test.assertEqual(set(asdict(report)), fields)
        test.assertEqual(report.adapter, "autogen")
        plan = next((plan for _, plan in runtime.plans if plan.request and plan.request["attempt_id"] == report.attempt_id), None)
        replacements = plan.replacements if plan else ()
        expected = "disabled" if mode == "off" else ("reused" if all(item.get("reused") for item in replacements) else "applied") if replacements else "skipped"
        test.assertEqual(report.status, expected)
        test.assertEqual(report.replacement_count, len(replacements))
        test.assertEqual(report.transform_ids, tuple(sorted({item["transform_id"] for item in replacements})))
        test.assertNotIn(SOURCE, repr(report))
    if mode == "off":
        test.assertEqual(runtime.plans, [])
        test.assertEqual(runtime.receipts, [])
    return {"count": len(reports), "statuses": dict(sorted(Counter(report.status for report in reports).items())),
            "replacement_counts": sorted(report.replacement_count for report in reports), "metadata_only": True}


def runtime_for(mode, reports):
    return EvidenceRuntime(endpoint="http://127.0.0.1:1" if mode == "outage" else os.environ["CAVEMAN_MIDDLEWARE_ENDPOINT"],
                           mode="off" if mode == "off" else "compress", on_report=reports.append, deadline_ms=1000)


async def model_case(test, provider, method, mode):
    reports = []
    with Provider() as server, runtime_for(mode, reports) as runtime:
        native = server.model(provider)
        try:
            seed = AssistantAgent("native_source", model_client=native, tools=[read_logs], max_tool_iterations=4, reflect_on_tool_use=True)
            seeded = await seed.run(task="Read logs and recover row 70")
            test.assertEqual(seeded.messages[-1].content, FACT)
            source_events = [event for event in seeded.messages if isinstance(event, ToolCallExecutionEvent)]
            test.assertEqual([result.content for event in source_events for result in event.content], [SOURCE])
            state = await seed.save_state()
            context = UnboundedChatCompletionContext()
            await context.load_state(state["llm_context"])
            messages = [*await context.get_messages(), UserMessage(content="Use the retained source", source="user")]
            before = copy.deepcopy(messages)
            client = with_caveman_model(native, runtime=runtime, scope=Scope("autogen-cert", f"{provider}-{method}-{mode}"))
            tools = [FunctionTool(read_logs, "Read source", strict=True)]
            call_start = len(server.calls)
            native_error = None
            event_types = []
            if method == "ChatCompletionClient.structured_output" and provider == "anthropic":
                # AutoGen 0.7.5 explicitly rejects typed Anthropic output before
                # calling its SDK. Preserve that native exception, never emulate it.
                message = "Structured output is currently not supported for Anthropic models"
                with test.assertRaisesRegex(ValueError, message):
                    await native.create(messages, tools=tools, json_output=Answer)
                test.assertEqual(len(server.calls), call_start)
                with test.assertRaisesRegex(ValueError, message):
                    await client.create(messages, tools=tools, json_output=Answer)
                native_error = {"type": "ValueError", "message": message, "phase": "await native create before provider dispatch"}
                answer = None
            elif method == "ChatCompletionClient.create_stream":
                stream = client.create_stream(messages, tools=tools)
                first = await asyncio.wait_for(anext(stream), 3)
                test.assertEqual(first, FACT[:3])
                test.assertFalse(server.release.is_set())
                server.release.set()
                tail = [event async for event in stream]
                test.assertIsInstance(tail[-1], CreateResult)
                test.assertEqual(tail[-1].content, FACT)
                answer = tail[-1].content
                event_types = [type(event).__name__ for event in [first, *tail]]
            else:
                result = await client.create(messages, tools=tools, **({"json_output": Answer} if method.endswith("structured_output") else {}))
                test.assertIsInstance(result, CreateResult)
                if method.endswith("structured_output"):
                    test.assertEqual(Answer.model_validate_json(result.content), Answer(answer=42))
                else:
                    test.assertEqual(result.content, FACT)
                answer = result.content
            test.assertEqual(messages, before)
            test.assertEqual(len(server.calls) - call_start, 0 if native_error else 1)
            test.assertTrue(all(not plan.replacements for _, plan in runtime.plans))
            if native_error is None:
                test.assertEqual(source_rendering(server.calls[-1]), SOURCE)
            test.assertEqual(server.errors, [])
            return {"outcome": "observed", "answer_sha256": None if answer is None else sha(answer), "native_error": native_error, "provider_calls": len(server.calls),
                    "tested_provider_calls": len(server.calls) - call_start, "native_invocations": 1, "bootstrap_provider_calls": call_start,
                    "native_reports": reports_observed(test, runtime, reports, 1, mode), "source_executions": 1, "source_sha256": SOURCE_SHA,
                    "caller_history_unchanged": True, "request_sha256": None if native_error else sha(server.calls[-1]["body"]),
                    "stream_event_types": event_types, "first_chunk_before_eof": method.endswith("create_stream"), "replacements": 0, "recovery_requests": 0}
        finally:
            server.release.set()
            await native.close()


async def agent_case(test, provider, method, mode):
    reports = []
    parallel = method == "parallel_tools_and_multiple_workbenches"
    streaming = method in ("AssistantAgent.run_stream", "cancel_and_close")
    with Provider(parallel=parallel) as server, runtime_for(mode, reports) as runtime:
        options, components, agents, streams = [], [], [], []
        transport = CaptureHTTPClient() if method == "cancel_and_close" else None
        try:
            scoped_count = 2 if method == "multiagent_contexts" else 1
            benches = []
            for index in range(scoped_count):
                native = server.model(provider, **({"http_client": transport} if transport else {}))
                original = dict(name=f"reader_{index}", model_client=native, max_tool_iterations=4,
                                model_client_stream=streaming, reflect_on_tool_use=True, system_message="Original system instructions")
                if method in ("workbench_recovery", "parallel_tools_and_multiple_workbenches"):
                    source = StatefulWorkbench([ProgressTool()])
                    current_benches = [source]
                    if parallel:
                        current_benches.append(StatefulWorkbench([FunctionTool(read_other, "Read other source")]))
                    benches.extend(current_benches)
                    original["workbench"] = current_benches if parallel else source
                else:
                    original["tools"] = [read_logs]
                before = dict(original)
                adapted = with_caveman_agent(original, runtime=runtime, scope=Scope("autogen-cert", f"{provider}-{method}-{mode}-{index}"))
                test.assertEqual(original, before)
                options.append(adapted)
                if adapted.get("workbench"):
                    bench = adapted["workbench"]
                    if isinstance(bench, list):
                        for item in bench:
                            await item.start()
                    else:
                        await bench.start()
                agents.append(AssistantAgent(**adapted))
            events = []
            if streaming:
                token = CancellationToken()
                stream = agents[0].run_stream(task="Read logs and recover row 70", cancellation_token=token)
                streams.append(stream)
                first_content = False
                async for event in stream:
                    events.append(event)
                    if isinstance(event, ModelClientStreamingChunkEvent):
                        if not first_content:
                            test.assertEqual(event.content, FACT[:3])
                            test.assertFalse(server.release.is_set())
                            first_content = True
                            if method == "cancel_and_close":
                                token.cancel()
                                break
                        server.release.set()
                test.assertTrue(first_content)
                if method == "cancel_and_close":
                    with test.assertRaises(asyncio.CancelledError):
                        await anext(stream)
                    await stream.aclose()
                    test.assertIsNone(stream.ag_frame)
                    final = "cancelled_before_fixture_eof"
                else:
                    test.assertIsInstance(events[-1], TaskResult)
                    final = events[-1].messages[-1].content
                    test.assertEqual(final, FACT)
            elif method in ("workbench_recovery", "parallel_tools_and_multiple_workbenches"):
                events = [event async for event in agents[0].run_stream(task="Read logs and recover row 70")]
                final = events[-1].messages[-1].content
                test.assertEqual(final, FACT)
            else:
                results = await asyncio.gather(*(agent.run(task="Read logs and recover row 70") for agent in agents))
                events = [event for result in results for event in result.messages]
                final = results[0].messages[-1].content
                test.assertEqual([result.messages[-1].content for result in results], [FACT] * scoped_count)
            source_results = [result for event in events if isinstance(event, ToolCallExecutionEvent) for result in event.content if result.name in ("read_logs", "read_other")]
            test.assertEqual([result.content for result in source_results], [SOURCE] * (2 if parallel else scoped_count))
            recovery_requests = [call for event in events if isinstance(event, ToolCallRequestEvent) for call in event.content if call.name == "caveman_retrieve"]
            recoveries = [result for event in events if isinstance(event, ToolCallExecutionEvent) for result in event.content if result.name == "caveman_retrieve"]
            test.assertEqual(len(recoveries), scoped_count if mode == "compress" else 0)
            test.assertEqual(len(recovery_requests), len(recoveries))
            for recovered in recoveries:
                page = json.loads(recovered.content)
                test.assertEqual(page["text"], SOURCE)
                test.assertTrue(page["complete"])
                test.assertEqual(page["original_sha256"], SOURCE_SHA)
            for bench in benches:
                test.assertEqual(len(bench.calls), 1)
                test.assertIn(bench.calls[0]["call_id"], ("read-1", "read-2"))
            if parallel:
                test.assertEqual([call.id for event in events if isinstance(event, ToolCallRequestEvent) for call in event.content][:2], ["read-1", "read-2"])
                test.assertTrue(any(isinstance(event, TextMessage) and event.content == "source ready" for event in events))
                if mode == "compress":
                    changed = next(plan for _, plan in runtime.plans if plan.replacements)
                    test.assertEqual(len(changed.replacements), 2)
                    test.assertEqual(len({item["source_id"] for item in changed.replacements}), 2)
                    test.assertEqual(len({item["recovery_handle"] for item in changed.replacements}), 2)
            states = [await agent.save_state() for agent in agents]
            test.assertEqual([result["content"] for state in states for result in originals(state)], [SOURCE] * (2 if parallel else scoped_count))
            extra_calls, native_team, restart, stable_turns = 0, False, False, 0
            if method == "multiagent_contexts":
                rendered = [source_rendering(call) for call in server.calls if any((message.get("role") == "tool" and message.get("tool_call_id") == "read-1") or
                    (isinstance(message.get("content"), list) and any(part.get("type") == "tool_result" and part.get("tool_use_id") == "read-1" for part in message["content"])) for message in call["body"]["messages"])]
                handles = {match[0] for text in rendered for match in re.finditer(r"cmw_[a-f0-9]{48}", text)}
                test.assertEqual(len(handles), 2 if mode == "compress" else 0)
                team = RoundRobinGroupChat(agents, max_turns=2)
                result = await team.run(task="Repeat the retained fact in each agent")
                test.assertEqual([message.source for message in result.messages[-2:]], ["reader_0", "reader_1"])
                test.assertEqual([message.content for message in result.messages[-2:]], [FACT, FACT])
                extra_calls, native_team = 2, True
            if method == "serialization_and_configuration":
                config = agents[0].dump_component()
                test.assertNotIn("cmw_", config.model_dump_json())
                test.assertNotIn("recovery_binding", config.model_dump_json())
                with component_runtimes({"default": runtime}) as loaded:
                    restored = AssistantAgent.load_component(config)
                components.extend(loaded)
                before = copy.deepcopy(states[0])
                await restored.load_state(states[0])
                test.assertEqual(states[0], before)
                print(json.dumps({"caveman_control": "restart"}), flush=True)
                test.assertEqual(input().strip(), "runtime-ready")
                restart = True
                rendered = source_rendering(server.calls[-1])
                for turn in range(20):
                    result = await restored.run(task=f"Repeat retained fact, turn {turn}")
                    test.assertEqual(result.messages[-1].content, FACT)
                    test.assertEqual(source_rendering(server.calls[-1]), rendered)
                    stable_turns += 1
                test.assertEqual([result["content"] for result in originals(await restored.save_state())], [SOURCE])
                extra_calls = 20
            expected_calls = scoped_count * (3 if mode == "compress" else 2) + extra_calls
            test.assertEqual(len(server.calls), expected_calls)
            test.assertEqual(server.errors, [])
            projected = []
            for call in server.calls:
                try:
                    content = source_rendering(call)
                except StopIteration:
                    continue
                if mode == "compress":
                    test.assertNotIn(FACT, content)
                    test.assertRegex(content, r"cmw_[a-f0-9]{48}")
                    projected.append(content)
                else:
                    test.assertEqual(content, SOURCE)
            native_reports = reports_observed(test, runtime, reports, expected_calls, mode)
            if method == "cancel_and_close":
                cancelled = [receipt for receipt in runtime.receipts if receipt["event_kind"] == "cancelled"]
                test.assertEqual(len(cancelled), 0 if mode == "off" else 1)
                test.assertTrue(all(receipt["usage"] is None for receipt in cancelled))
            return {"outcome": "observed", "answer_sha256": sha(final), "provider_calls": expected_calls, "source_executions": len(source_results),
                    "source_sha256": SOURCE_SHA, "recovery_requests": len(recoveries), "recovered_sha256": SOURCE_SHA if recoveries else None,
                    "projection_requests": len(projected), "normalized_views": sorted({sha(re.sub(r"cmw_[a-f0-9]{48}", "<OPAQUE_RECOVERY_HANDLE>", text)) for text in projected}),
                    "native_reports": native_reports, "native_event_types": sorted({type(event).__name__ for event in events}),
                    "caller_options_unchanged": True, "original_history_retained": True, "native_team": native_team,
                    "parallel_workbenches": len(benches), "runtime_process_restart": restart, "stable_continuation_turns": stable_turns,
                    "first_chunk_before_eof": streaming, "cancelled_before_eof": method == "cancel_and_close"}
        finally:
            server.release.set()
            for stream in streams:
                await stream.aclose()
            for item in options:
                await item["model_client"].close()
                workbenches = item.get("workbench", [])
                for workbench in workbenches if isinstance(workbenches, list) else [workbenches]:
                    await workbench.stop()
            for component in components:
                await component.close() if isinstance(component, ChatCompletionClient) else await component.stop()
            if transport is not None:
                test.assertTrue(transport.is_closed)


async def certify_cells(test, provider):
    cells = [cell for cell in json.loads(Path(__file__).with_name("certification-cells.json").read_text())["cells"] if cell["provider"] == provider]
    test.assertEqual(len(cells), 10)
    for cell in cells:
        with test.subTest(cell=cell["id"]):
            model_only = cell["recovery"] == "model_only"
            rows = {mode: await (model_case(test, provider, cell["method"], mode) if model_only else agent_case(test, provider, cell["method"], mode)) for mode in ("compress", "off", "outage")}
            current, off, outage = rows["compress"], rows["off"], rows["outage"]
            test.assertEqual(current["answer_sha256"], off["answer_sha256"])
            test.assertEqual(current["answer_sha256"], outage["answer_sha256"])
            source = {"outcome": "observed", "native_executor": "AutoGen FunctionTool or StaticStreamWorkbench", "executions": current["source_executions"], "source_sha256": SOURCE_SHA, "utf8_bytes": len(SOURCE.encode())}
            if model_only:
                for row in (off, outage):
                    test.assertEqual(current["request_sha256"], row["request_sha256"])
                    test.assertEqual(current["native_error"], row["native_error"])
                free = {"outcome": "recovery_free", "reason": "Model-only native clients have no recovery executor; typed Anthropic output retains the pinned native rejection." if current["native_error"] else "Model-only native client has no registered recovery executor.",
                        "recovery_requests": 0, "replacements": 0, "original_sha256": SOURCE_SHA, "native_error": current["native_error"]}
                projected, omitted, recovered = free, free, free
            else:
                test.assertGreater(current["projection_requests"], 0)
                test.assertGreater(current["recovery_requests"], 0)
                projected = {"outcome": "observed", "provider_requests": current["projection_requests"], "normalized_view_sha256": current["normalized_views"], "normalization": "replace generated opaque recovery handles only", "omitted_fact_absent": True}
                omitted = {"outcome": "observed", "native_requested_tool": "caveman_retrieve", "requests": current["recovery_requests"], "omitted_fact": FACT}
                recovered = {"outcome": "observed", "native_executor": "AutoGen registered CavemanWorkbench", "executions": current["recovery_requests"], "source_sha256": SOURCE_SHA, "recovered_sha256": current["recovered_sha256"], "complete": True}
            journey = {"native_application": {"outcome": "observed", "framework": "autogen-agentchat", "framework_version": "0.7.5", "method": cell["method"], "provider": provider},
                       "real_tool_result": source, "transformed_provider_request": projected, "omitted_fact_requested": omitted,
                       "host_executes_exact_recovery": recovered, "native_result_history_events_and_call_count": current,
                       "off_baseline": off, "optimizer_unavailable": outage}
            name = ".".join(test.id().split(".")[-2:])
            for assertion, observation in journey.items():
                print("CAVEMAN_MIDDLEWARE_OBSERVATION " + json.dumps({"cell_id": cell["id"], "test_id": TEST_FILE + "::" + name,
                      "assertion": assertion, "observation": observation}, sort_keys=True, separators=(",", ":")), flush=True)
