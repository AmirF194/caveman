"""Actual Crew/Task journeys for each frozen F10 operation cell."""
from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import os
import re
import threading
from pathlib import Path
from dataclasses import asdict

from crewai import Agent, Crew, Task
from crewai.agents.crew_agent_executor import CrewAgentExecutor
from crewai.core.providers.human_input import reset_provider, set_provider
from crewai.crews.crew_output import CrewOutput
from crewai.events import LLMCallCompletedEvent, crewai_event_bus
from crewai.hooks import InterceptionPoint, get_hooks, on, unregister_hook
from crewai.tools import BaseTool
from crewai.types.streaming import CrewStreamingOutput, StreamChunk, StreamChunkType
from pydantic import PrivateAttr
from caveman_cloud.middleware import MiddlewareRuntime, Scope, MiddlewareError
from caveman_middleware.crewai import CavemanLLM, with_caveman_agent
from provider import SOURCE, FACT, Provider

TEST_FILE = "examples/middleware/crewai/test_native.py"
CELLS = json.loads(Path(__file__).with_name("certification-cells.json").read_text())["cells"]
ENDPOINT = os.environ["CAVEMAN_MIDDLEWARE_ENDPOINT"]


def digest(value):
    return hashlib.sha256((value if isinstance(value, str) else json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))).encode()).hexdigest()


def scope_for(cell, mode, suffix=""):
    return Scope("crewai-exact", digest(cell["id"] + mode + suffix))


class CapturedRuntime(MiddlewareRuntime):
    def __init__(self, mode):
        self.reports = []
        super().__init__(endpoint="http://127.0.0.1:1" if mode == "outage" else ENDPOINT, mode="off" if mode == "off" else "compress", deadline_ms=3000, on_report=self.reports.append)
        self.plans, self.pages, self.receipts = [], [], []

    def optimize(self, **options):
        result = super().optimize(**options)
        self.plans.append((options, result))
        return result

    def retrieve(self, scope, **args):
        page = super().retrieve(scope, **args)
        self.pages.append(page)
        return page

    def observe_background(self, receipt):
        self.receipts.append(receipt)
        return super().observe_background(receipt)


async def kickoff(crew, asynchronous):
    return await crew.akickoff() if asynchronous else await asyncio.to_thread(crew.kickoff)


def assert_source(test, app, cell, mode, server, runtime, agent, logs, *, source_calls=1, provider_calls=None):
    active = mode == "compress"
    test.assertEqual(len(logs._calls), source_calls)
    source_messages = [message for message in agent.agent_executor.messages if message.get("role") == "tool" and message.get("name") == "read_logs"]
    test.assertTrue(source_messages)
    test.assertTrue(all(message["content"] == SOURCE for message in source_messages))
    view = app.rendering(server.calls[1])
    if active:
        test.assertNotIn(FACT, view)
        handle = re.search(r"cmw_[a-f0-9]{48}", view)
        test.assertIsNotNone(handle)
        test.assertTrue(runtime.pages)
        calls = [response["function"] for response in server.responses if response["function"] and response["function"][1] == "caveman_retrieve"]
        test.assertEqual(len(calls), len(runtime.pages))
        test.assertTrue(all(any(page["handle"] == call[2]["handle"] for page in runtime.pages) for call in calls))
        for page in runtime.pages:
            test.assertEqual(page["text"].encode(), SOURCE.encode())
            test.assertEqual(page["original_sha256"], digest(SOURCE))
            test.assertTrue(page["complete"])
            test.assertIsNone(page["next_offset"])
            test.assertTrue(page["source_id"])
    else:
        test.assertEqual(view, SOURCE)
        test.assertEqual(runtime.pages, [])
        test.assertTrue(all(not result.replacements for _, result in runtime.plans))
    if provider_calls is not None:
        test.assertEqual(len(server.calls), provider_calls)
    test.assertEqual(server.errors, [])
    return view


def report_summary(test, runtime, provider_calls):
    test.assertEqual(len(runtime.reports), provider_calls, "Exactly one metadata report per actual native provider attempt")
    test.assertIs(runtime.last_report, runtime.reports[-1])
    test.assertEqual(len({report.attempt_id for report in runtime.reports}), provider_calls)
    test.assertTrue(all(report.adapter == "crewai" for report in runtime.reports))
    test.assertNotIn(SOURCE, json.dumps([asdict(report) for report in runtime.reports]))
    test.assertEqual(sum(report.replacement_count for report in runtime.reports), sum(len(result.replacements) for _, result in runtime.plans))
    if runtime.mode == "off":
        test.assertTrue(all(report.status == "disabled" for report in runtime.reports))
        test.assertEqual(runtime.plans, [])
        test.assertEqual(runtime.receipts, [])
    elif any(result.replacements for _, result in runtime.plans):
        test.assertTrue(any(report.status == "applied" for report in runtime.reports))
        test.assertTrue(any(report.status == "reused" for report in runtime.reports))
    return {"count": len(runtime.reports), "statuses": sorted(report.status for report in runtime.reports),
            "replacement_count": sum(report.replacement_count for report in runtime.reports), "unique_attempt_ids": True, "source_content_absent": True}


def summary(test, server, runtime, *, view=None, source_executions=1, extra=None, stream_events=None, native_type="CrewOutput", native_value=FACT, provider_calls=None, report_calls=None):
    test.assertTrue(crewai_event_bus.flush(timeout=3))
    dispatch = [receipt for receipt in runtime.receipts if receipt["event_kind"] == "dispatch_intent"]
    completed = [receipt for receipt in runtime.receipts if receipt["event_kind"] == "completed"]
    test.assertEqual(len(dispatch), len(runtime.plans))
    test.assertEqual(len(completed), len(runtime.plans))
    return {"provider_calls": len(server.calls) if provider_calls is None else provider_calls, "source_executions": source_executions, "source_sha256": digest(SOURCE), "source_bytes": len(SOURCE.encode()),
            "recovery_requests": len(runtime.pages), "replacements": sum(len(result.replacements) for _, result in runtime.plans), "native_type": native_type, "native_value": native_value,
            "original_history": True, "view_sha256": digest(re.sub(r"cmw_[a-f0-9]{48}", "cmw_OPAQUE_HANDLE", view)) if view is not None else None,
            "recovered_sources": sorted([{"source_id": page["source_id"], "sha256": digest(page["text"]), "utf8_bytes": len(page["text"].encode()), "complete": page["complete"]} for page in runtime.pages], key=lambda value: value["source_id"]),
            "stream_events": stream_events or [], "extra": {"dispatch_receipts": len(dispatch), "completed_receipts": len(completed), "completions_with_unknown_usage": sum(receipt["usage"] is None for receipt in completed),
                "native_reports": report_summary(test, runtime, len(server.calls) if report_calls is None else report_calls), **(extra or {})}}


async def collect_stream(test, output, server, agent, task, asynchronous):
    test.assertIsInstance(output, CrewStreamingOutput)
    chunks, first = [], False
    def consume(chunk):
        nonlocal first
        test.assertIsInstance(chunk, StreamChunk)
        chunks.append(chunk)
        if chunk.chunk_type == StreamChunkType.TEXT and chunk.content:
            if not first:
                test.assertFalse(server.release.is_set())
                test.assertFalse(output.is_completed)
                test.assertEqual(chunk.content, FACT[:3])
                first = True
                server.release.set()
    if asynchronous:
        async def drain():
            async for chunk in output:
                consume(chunk)
        await asyncio.wait_for(drain(), 8)
    else:
        def drain():
            for chunk in output:
                consume(chunk)
        await asyncio.wait_for(asyncio.to_thread(drain), 8)
    test.assertTrue(first)
    test.assertEqual(output.result.raw, FACT)
    test.assertEqual(output.get_full_text(), FACT)
    test.assertTrue(all(chunk.agent_id in ("", str(agent.id)) and chunk.task_id in ("", str(task.id)) for chunk in chunks))
    return [{"type": chunk.chunk_type.value, "tool": chunk.tool_call.tool_name if chunk.tool_call else None, "text": chunk.content if chunk.chunk_type == StreamChunkType.TEXT else None} for chunk in chunks]


class OtherTool(BaseTool):
    name: str = "read_other"
    description: str = "Read independent context"
    _calls: list = PrivateAttr(default_factory=list)

    def _run(self):
        self._calls.append({})
        return "Unchanged other tool result café 🌍"


async def ordinary_case(test, cell, mode, app):
    asynchronous, streaming = cell["execution"] == "async", cell["streaming"]
    cache = cell["method"] == "tool_arguments_results_and_cache"
    with Provider(parallel=cache, repeat_read=cache, read_args={"key": "logs/café 🌍"} if cache else None) as server, CapturedRuntime(mode) as runtime:
        if not streaming:
            server.release.set()
        logs, other = app.ReadLogs(), OtherTool()
        crew, task, agent, ordinary_logs, original, options = app.make_crew(server, runtime, scope_for(cell, mode), cell["provider"],
            agent_options={"tools": [logs, other]} if cache else None, crew_options={"stream": True} if streaming else {"cache": True})
        if not cache:
            logs = ordinary_logs
        before = list(original["tools"])
        try:
            value = await kickoff(crew, asynchronous)
            events = await collect_stream(test, value, server, agent, task, asynchronous) if streaming else []
            output = value.result if streaming else value
            test.assertIsInstance(output, CrewOutput)
            test.assertEqual(output.raw, FACT)
            test.assertEqual(task.output.raw, FACT)
            test.assertIs(task.agent, agent)
            test.assertIs(agent.crew, crew)
            test.assertEqual(original["tools"], before)
            expected_calls = (4 if cache else 3) if mode == "compress" else (3 if cache else 2)
            view = assert_source(test, app, cell, mode, server, runtime, agent, logs, provider_calls=expected_calls)
            test.assertEqual(logs._calls, [{"key": "logs/café 🌍"}] if cache else [{}])
            extra = {"crew_task_agent_identity_preserved": True, "executor_type": type(agent.agent_executor).__name__, "first_text_before_provider_completion": streaming}
            if cache:
                test.assertEqual(other._calls, [{}])
                test.assertEqual(agent.tools_handler.cache.read(tool="read_logs", input=json.dumps({"key": "logs/café 🌍"})), SOURCE)
                history = [message for message in agent.agent_executor.messages if message["role"] == "tool"]
                test.assertEqual([message["content"] for message in history if message["name"] == "read_logs"], [SOURCE, SOURCE])
                test.assertEqual(next(message["content"] for message in history if message["name"] == "read_other"), "Unchanged other tool result café 🌍")
                test.assertEqual(app.rendering(server.calls[1]), app.rendering(server.calls[2]))
                extra.update(native_source_cache_hit=True, native_source_executions=1, source_tool_result_count=2, exact_unicode_tool_arguments=True, independent_tool_result_preserved=True)
            if streaming:
                repeats = 2 if cell["provider"] == "openai" else 3
                expected = ["read_logs"] * repeats + (["caveman_retrieve"] * repeats if mode == "compress" else [])
                test.assertEqual([event["tool"] for event in events if event["tool"]], expected)
            return summary(test, server, runtime, view=view, extra=extra, stream_events=events, native_type=type(value).__name__)
        finally:
            server.release.set()
            app.close_model(options)


async def structured_case(test, cell, mode, app):
    asynchronous = cell["execution"] == "async"
    # Obtain source through a real native tool run, then the application carries
    # that result into the actual typed Task's input. The typed task has no tools.
    with Provider() as bootstrap_server, CapturedRuntime("off") as bootstrap_runtime:
        bootstrap_server.release.set()
        bootstrap = app.make_crew(bootstrap_server, bootstrap_runtime, scope_for(cell, mode, "-bootstrap"), cell["provider"])
        try:
            test.assertEqual((await kickoff(bootstrap[0], asynchronous)).raw, FACT)
            source = next(message["content"] for message in bootstrap[2].agent_executor.messages if message.get("tool_call_id") == "read-1")
            test.assertEqual(source, SOURCE)
            test.assertEqual(bootstrap[3]._calls, [{}])
            test.assertEqual(len(bootstrap_server.calls), 2)
            test.assertEqual(bootstrap_server.errors, [])
        finally:
            app.close_model(bootstrap[-1])
    with Provider(structured=True) as server, CapturedRuntime(mode) as runtime:
        server.release.set()
        crew, task, agent, _, _, options = app.make_crew(server, runtime, scope_for(cell, mode), cell["provider"], agent_options={"tools": []}, task_options={"response_model": app.Answer})
        task.description = "Read the original source supplied by the application and return the requested typed answer:\n" + source
        before = task.description
        try:
            value = await kickoff(crew, asynchronous)
            test.assertIsInstance(value, CrewOutput)
            test.assertEqual(json.loads(value.raw), {"answer": FACT})
            test.assertEqual(task.description, before)
            test.assertEqual(options["tools"], [])
            test.assertEqual(len(server.calls), 1)
            test.assertIn(SOURCE, json.dumps(server.calls[0]["body"], ensure_ascii=False).replace("\\r", "\r").replace("\\n", "\n"))
            test.assertTrue(all(not result.replacements and options["binding"] is None for options, result in runtime.plans))
            test.assertEqual(runtime.pages, [])
            test.assertEqual(server.errors, [])
            record = summary(test, server, runtime, native_value={"answer": FACT}, provider_calls=3, extra={"typed_provider_calls": 1, "native_tool_bootstrap_calls": 2, "application_carries_original_tool_result": True, "native_typed_task_without_tools": True})
            record["typed_request_sha256"] = digest(server.calls[0]["body"])
            return record
        finally:
            app.close_model(options)


async def delegation_case(test, cell, mode, app):
    asynchronous = cell["execution"] == "async"
    with Provider(delegate_to="Source reader") as manager_server, Provider() as worker_server, CapturedRuntime(mode) as runtime:
        manager_server.release.set()
        worker_server.release.set()
        worker_scope, manager_scope = scope_for(cell, mode, "-worker"), scope_for(cell, mode, "-manager")
        _, _, worker, logs, _, worker_options = app.make_crew(worker_server, runtime, worker_scope, cell["provider"])
        manager_options = with_caveman_agent(dict(role="Coordinator", goal="Delegate source reading", backstory="Use the source reader", llm=manager_server.model(cell["provider"]), allow_delegation=True, verbose=False, max_retry_limit=0), runtime=runtime, scope=manager_scope)
        manager = Agent(**manager_options)
        task = Task(description="Delegate source reading and return its exact result", expected_output=FACT, agent=manager, human_input=True)
        crew = Crew(agents=[manager, worker], tasks=[task], verbose=False, tracing=False)
        feedback = app.ScriptedFeedback()
        token = set_provider(feedback)
        try:
            value = await kickoff(crew, asynchronous)
            test.assertEqual(value.raw, FACT)
            test.assertEqual(feedback.crews, [crew, crew])
            test.assertTrue(any("Human feedback café 🌍" in str(message.get("content")) for message in manager.agent_executor.messages))
            test.assertEqual([len(manager_server.calls), len(worker_server.calls)], [3, 3 if mode == "compress" else 2])
            test.assertIs(worker.agent_executor.crew, crew)
            test.assertIs(worker.agent_executor.task.agent, worker)
            test.assertIsNot(worker.agent_executor.task, task)
            test.assertIn("Delegated context café 🌍", str(worker.agent_executor.messages))
            test.assertEqual(manager_server.errors, [])
            view = assert_source(test, app, cell, mode, worker_server, runtime, worker, logs)
            if mode != "off":
                test.assertEqual({receipt["scope"]["session_id"] for receipt in runtime.receipts}, {worker_scope.session_id, manager_scope.session_id})
            if mode == "compress":
                with test.assertRaises(MiddlewareError) as error:
                    runtime.recovery(manager_scope).execute({"handle": runtime.pages[0]["handle"]})
                test.assertEqual(error.exception.code, "not_found")
            return summary(test, worker_server, runtime, view=view, provider_calls=len(manager_server.calls) + len(worker_server.calls), report_calls=len(manager_server.calls) + len(worker_server.calls),
                           extra={"native_delegation_calls": 1, "native_human_prompts": 2, "worker_task_is_distinct": True, "same_crew_identity": True, "human_feedback_preserved": True, "trusted_worker_and_manager_scopes": 2, "cross_scope_recovery_denied": mode == "compress"})
        finally:
            reset_provider(token)
            app.close_model(manager_options)
            app.close_model(worker_options)


async def cleanup_case(test, cell, mode, app):
    asynchronous, seen = cell["execution"] == "async", []

    @on(InterceptionPoint.PRE_MODEL_CALL)
    def application_hook(context):
        seen.append((context.crew, context.task, context.agent, context.llm))

    before = get_hooks(InterceptionPoint.PRE_MODEL_CALL)
    try:
        with Provider() as left, Provider() as right, CapturedRuntime(mode) as runtime, CapturedRuntime("off") as disabled:
            left.release.set()
            right.release.set()
            active = app.make_crew(left, runtime, scope_for(cell, mode), cell["provider"])
            unrelated = app.make_crew(right, disabled, scope_for(cell, mode, "-unrelated"), cell["provider"])
            test.assertEqual(len(get_hooks(InterceptionPoint.PRE_MODEL_CALL)), len(before) + (0 if mode == "off" else 1))
            try:
                values = await asyncio.gather(kickoff(active[0], asynchronous), kickoff(unrelated[0], asynchronous))
                test.assertEqual([value.raw for value in values], [FACT, FACT])
                test.assertEqual([len(left.calls), len(right.calls)], [3 if mode == "compress" else 2, 2])
                test.assertEqual(app.rendering(right.calls[1]), SOURCE)
                test.assertEqual(disabled.plans, [])
                test.assertEqual(unrelated[3]._calls, [{}])
                test.assertTrue(all(crew is active[0] and task is active[1] and agent is active[2] for crew, task, agent, llm in seen if llm is active[-1]["llm"]))
                test.assertTrue(any(llm is active[-1]["llm"] for _, _, _, llm in seen))
                view = assert_source(test, app, cell, mode, left, runtime, active[2], active[3])
                count = len(runtime.plans)
                app.close_model(active[-1])
                test.assertEqual(get_hooks(InterceptionPoint.PRE_MODEL_CALL), before)
                # A caller-owned native provider remains usable after wrapper cleanup.
                result = await active[-1]["llm"].acall("native") if asynchronous else await asyncio.to_thread(active[-1]["llm"].call, "native")
                test.assertEqual(result, "native")
                test.assertEqual(len(runtime.plans), count)
                test.assertEqual(right.errors + left.errors, [])
                return summary(test, left, runtime, view=view, source_executions=2, provider_calls=len(left.calls) + len(right.calls),
                               extra={"concurrent_unrelated_crew_calls": 2, "unrelated_original_source": True, "hook_context_matches_exact_crew_task_agent_llm": True, "own_hook_removed_application_hook_preserved": True, "closed_wrapper_delegates_to_original_provider": True})
            finally:
                app.close_model(active[-1])
                app.close_model(unrelated[-1])
    finally:
        unregister_hook(InterceptionPoint.PRE_MODEL_CALL, application_hook)


async def litellm_case(test, cell, mode, app):
    import litellm
    from caveman_middleware._native import owner
    from caveman_middleware.litellm import CavemanLiteLLM

    class ObservedLiteLLM(CavemanLiteLLM):
        def __init__(self, **kwargs):
            super().__init__(**kwargs)
            self.observed_owners, self.deployment_owners = [], []

        def log_pre_api_call(self, model, messages, kwargs):
            self.observed_owners.append(owner.get())

        async def async_pre_call_deployment_hook(self, kwargs, call_type):
            self.deployment_owners.append(owner.get())
            return await super().async_pre_call_deployment_hook(kwargs, call_type)

    asynchronous = cell["execution"] == "async"
    with Provider() as server, CapturedRuntime(mode) as outer, CapturedRuntime("off" if mode == "off" else mode) as inner_runtime:
        server.release.set()
        scope = scope_for(cell, mode)
        inner = ObservedLiteLLM(runtime=inner_runtime, proxy_scope=lambda _auth, _data: scope)
        registered = await inner.async_pre_call_hook(None, None, {}, "acompletion")
        # The pinned LiteLLM cost map no longer advertises tool support for
        # the old Haiku fixture model. Use its real supported Anthropic route.
        model_options = {"is_litellm": True, "metadata": registered.get("metadata", {}), "callbacks": [inner]}
        if cell["provider"] == "anthropic":
            model_options["model"] = "anthropic/claude-sonnet-4-20250514"
        crew, _, agent, logs, _, options = app.make_crew(server, outer, scope, cell["provider"], llm_options=model_options, agent_options={"executor_class": CrewAgentExecutor} if asynchronous else None)
        native = options["llm"].delegate if isinstance(options["llm"], CavemanLLM) else options["llm"]
        test.assertTrue(native.is_litellm)
        test.assertTrue(native.supports_function_calling())

        @on(InterceptionPoint.PRE_MODEL_CALL)
        def retain_application_callback(context):
            if context.llm is options["llm"] and inner not in context.executor.callbacks:
                context.executor.callbacks.append(inner)

        try:
            with inner:
                value = await kickoff(crew, asynchronous)
            test.assertEqual(value.raw, FACT)
            expected_calls = 3 if mode == "compress" else 2
            view = assert_source(test, app, cell, mode, server, outer, agent, logs, provider_calls=expected_calls)
            test.assertEqual(len(outer.plans), 0 if mode == "off" else expected_calls)
            test.assertEqual(inner_runtime.plans, [])
            test.assertEqual(inner_runtime.receipts, [])
            observed = inner.deployment_owners if asynchronous else inner.observed_owners
            test.assertEqual(len(observed), expected_calls)
            test.assertTrue(all(attempt is not None and attempt.runtime is outer for attempt in observed))
            test.assertTrue(all(attempt.passive == (mode == "off") for attempt in observed))
            test.assertEqual(len({attempt.attempt_id for attempt in observed}), expected_calls)
            test.assertFalse(any(callback is inner for callback in litellm.callbacks))
            return summary(test, server, outer, view=view, extra={"native_litellm_provider_calls": expected_calls, "inner_optimizer_plans": 0, "inner_receipts": 0, "selected_outer_owner_per_attempt": True, "off_owner_is_passive": mode == "off", "registered_callback_removed": True, "native_function_calling_supported": True, "executor_type": type(agent.agent_executor).__name__})
        finally:
            unregister_hook(InterceptionPoint.PRE_MODEL_CALL, retain_application_callback)
            inner.close()
            app.close_model(options)


async def close_case(test, cell, mode, app):
    """Measure native close semantics on both public sync/async stream surfaces."""
    asynchronous = cell["execution"] == "async"
    with Provider() as server, CapturedRuntime(mode) as runtime:
        crew, _, _, _, _, options = app.make_crew(server, runtime, scope_for(cell, mode, "-close"), cell["provider"], crew_options={"stream": True})
        native = options["llm"].delegate if isinstance(options["llm"], CavemanLLM) else options["llm"]
        completed = threading.Event()

        @crewai_event_bus.on(LLMCallCompletedEvent)
        def finished(source, event):
            if source is native and event.response == FACT:
                completed.set()

        try:
            output = await kickoff(crew, asynchronous)
            test.assertIsInstance(output, CrewStreamingOutput)
            iterator = output.__aiter__() if asynchronous else iter(output)
            while True:
                chunk = await asyncio.wait_for(anext(iterator), 5) if asynchronous else await asyncio.wait_for(asyncio.to_thread(next, iterator), 5)
                if chunk.chunk_type == StreamChunkType.TEXT and chunk.content:
                    test.assertEqual(chunk.content, FACT[:3])
                    break
            test.assertFalse(server.release.is_set())
            test.assertFalse(completed.is_set())
            if asynchronous:
                await asyncio.wait_for(output.aclose(), 2)
                await iterator.aclose()
                close_returned_before_release = True
            else:
                closing = asyncio.create_task(asyncio.to_thread(output.close))
                deadline = asyncio.get_running_loop().time() + 2
                while not output.is_cancelled and asyncio.get_running_loop().time() < deadline:
                    await asyncio.sleep(0.002)
                test.assertTrue(output.is_cancelled)
                await asyncio.sleep(0.05)
                test.assertFalse(closing.done(), 'Native synchronous close joins the still-running provider worker')
                close_returned_before_release = False
            test.assertTrue(output.is_cancelled)
            test.assertFalse(completed.is_set())
            test.assertFalse(server.release.is_set())
            server.release.set()
            if not asynchronous:
                await asyncio.wait_for(closing, 5)
                await asyncio.to_thread(iterator.close)
            test.assertTrue(await asyncio.to_thread(completed.wait, 5))
            test.assertTrue(crewai_event_bus.flush(timeout=3))
            test.assertEqual(len(server.calls), 3 if mode == "compress" else 2)
            test.assertEqual(server.errors, [])
            reports = report_summary(test, runtime, len(server.calls))
            return {"surface": "CrewStreamingOutput.aclose" if asynchronous else "CrewStreamingOutput.close", "consumer_cancelled": True,
                    "close_returned_before_provider_release": close_returned_before_release,
                    "default_native_worker_completed_before_fixture_release": False, "default_native_worker_completed_after_fixture_release": True,
                    "native_provider_calls": len(server.calls), "native_reports": reports, "outcome": "observed_native_worker_limit"}
        finally:
            server.release.set()
            crewai_event_bus.off(LLMCallCompletedEvent, finished)
            app.close_model(options)


def observations(test, cell, runs):
    active, off, outage = runs
    test.assertEqual(active["native_value"], off["native_value"])
    test.assertEqual(active["native_value"], outage["native_value"])
    for baseline in (off, outage):
        test.assertEqual(baseline["recovery_requests"], 0)
        test.assertEqual(baseline["replacements"], 0)
        test.assertTrue(baseline["original_history"])
    free = cell["recovery"] == "model_only"
    if free:
        test.assertEqual(active["recovery_requests"], 0)
        test.assertEqual(active["replacements"], 0)
        test.assertEqual(active["typed_request_sha256"], off["typed_request_sha256"])
        test.assertEqual(active["typed_request_sha256"], outage["typed_request_sha256"])
    else:
        test.assertGreater(active["recovery_requests"], 0)
        test.assertGreater(active["replacements"], 0)
    recovery_free = {"outcome": "recovery_free", "reason": "native_typed_task_without_tool_executor", "recovery_requests": 0, "replacements": 0, "original_source_sha256": digest(SOURCE)}
    return {
        "native_application": {"outcome": "observed", "method": cell["method"], "execution": cell["execution"], "public_api": "Crew.akickoff" if cell["execution"] == "async" else "Crew.kickoff", "native_type": active["native_type"], "local_http_provider": True},
        "real_tool_result": {"outcome": "observed", "native_tool": "read_logs", "source_executions": active["source_executions"], "source_sha256": active["source_sha256"], "source_utf8_bytes": active["source_bytes"]},
        "transformed_provider_request": recovery_free if free else {"outcome": "observed", "replacements": active["replacements"], "view_sha256_normalizing_only_opaque_handles": active["view_sha256"], "omitted_fact": FACT, "fact_absent": True},
        "omitted_fact_requested": recovery_free if free else {"outcome": "observed", "requested_tool": "caveman_retrieve", "requests": active["recovery_requests"], "requested_handles_match_views": True},
        "host_executes_exact_recovery": recovery_free if free else {"outcome": "observed", "native_tool_executions": active["recovery_requests"], "recovered_sources": active["recovered_sources"], "exact_bytes": True},
        "native_result_history_events_and_call_count": {"outcome": "observed", "native_value": active["native_value"], "provider_calls": active["provider_calls"], "original_history": True, "stream_events": active["stream_events"], **active["extra"], **({"native_close": active["native_close"]} if cell["streaming"] else {})},
        "off_baseline": {"outcome": "observed", "provider_calls": off["provider_calls"], "recovery_requests": 0, "replacements": 0, "native_value": off["native_value"], "original_history": True, "native_reports": off["extra"]["native_reports"], **({"native_close": off["native_close"]} if cell["streaming"] else {})},
        "optimizer_unavailable": {"outcome": "observed", "endpoint": "closed_loopback_port", "provider_calls": outage["provider_calls"], "recovery_requests": 0, "replacements": 0, "native_value": outage["native_value"], "original_history": True, "native_reports": outage["extra"]["native_reports"], **({"native_close": outage["native_close"]} if cell["streaming"] else {})},
    }


async def run_certification(test, protocol, app):
    asyncio.get_running_loop().set_debug(False)
    functions = {"crew.kickoff.structured": structured_case, "task_delegation_and_human_input": delegation_case, "scoped_registration_cleanup": cleanup_case, "litellm_composition": litellm_case}
    for cell in [cell for cell in CELLS if cell["provider"] == protocol]:
        run, runs = functions.get(cell["method"], ordinary_case), []
        for mode in ("compress", "off", "outage"):
            value = await run(test, cell, mode, app)
            if cell["streaming"]:
                value["native_close"] = await close_case(test, cell, mode, app)
            runs.append(value)
        for assertion, observation in observations(test, cell, runs).items():
            print("CAVEMAN_MIDDLEWARE_OBSERVATION " + json.dumps({"cell_id": cell["id"], "test_id": TEST_FILE + "::" + ".".join(test.id().split(".")[-2:]), "assertion": assertion, "observation": observation}, separators=(",", ":")), flush=True)
