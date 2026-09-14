"""Installed CrewAI Crews/Tasks, real HTTP SDKs, and the real Engine runtime."""
from __future__ import annotations

import asyncio
import copy
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from contextlib import nullcontext
from unittest.mock import patch
from importlib.metadata import version
from pathlib import Path

os.environ["OTEL_SDK_DISABLED"] = "true"
os.environ["CREWAI_DISABLE_TELEMETRY"] = "true"
os.environ["CREWAI_TRACING_ENABLED"] = "false"
os.environ["CREWAI_TESTING"] = "true"
os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "true"
os.environ["LITELLM_MODE"] = "PRODUCTION"
os.environ["PYTHON_DOTENV_DISABLED"] = "true"
STORAGE = tempfile.TemporaryDirectory(prefix="caveman-crewai-native-")
os.environ["CREWAI_STORAGE_DIR"] = STORAGE.name

from crewai import Agent, Crew, Task
from crewai.agents.crew_agent_executor import CrewAgentExecutor
from crewai.core.providers.human_input import SyncHumanInputProvider, reset_provider, set_provider
from crewai.crews.crew_output import CrewOutput
from crewai.events import LLMCallCompletedEvent, crewai_event_bus
from crewai.hooks import HookAborted, InterceptionPoint, get_hooks, on, unregister_hook
from crewai.llms.base_llm import call_stop_override
from crewai.tools import BaseTool
from crewai.types.streaming import CrewStreamingOutput, StreamChunk, StreamChunkType
from pydantic import BaseModel, PrivateAttr

from caveman_cloud.middleware import Scope
from caveman_middleware.crewai import CavemanLLM, with_caveman_agent, with_caveman_llm
from evidence_runtime import EvidenceRuntime
from provider import FACT, SOURCE, Provider

ENDPOINT = os.environ["CAVEMAN_MIDDLEWARE_ENDPOINT"]


class ReadLogs(BaseTool):
    name: str = "read_logs"
    description: str = "Read the original diagnostic source"
    _calls: list = PrivateAttr(default_factory=list)

    def _run(self, key: str | None = None) -> str:
        self._calls.append({"key": key} if key is not None else {})
        return SOURCE


def rendering(call):
    if call["path"].endswith("messages"):
        return next(part["content"] for message in call["body"]["messages"] if isinstance(message.get("content"), list)
                    for part in message["content"] if part.get("type") == "tool_result" and part["tool_use_id"] == "read-1")
    return next(message["content"] for message in call["body"]["messages"] if message.get("tool_call_id") == "read-1")


def make_crew(server, runtime, scope, protocol="openai", *, stream=False, llm_options=None, agent_options=None, task_options=None, crew_options=None):
    tool = ReadLogs()
    original = dict(role="Source reader", goal="Read the source and answer the requested fact", backstory="Preserve exact source evidence",
                    llm=server.model(protocol, stream=stream, **(llm_options or {})), tools=[tool], allow_delegation=False, verbose=False,
                    max_iter=6, max_retry_limit=0)
    original.update(agent_options or {})
    options = with_caveman_agent(original, runtime=runtime, scope=scope)
    agent = Agent(**options)
    task = Task(description=f"Read the logs and report {FACT}. Use exact original source if needed.", expected_output="The exact requested fact", agent=agent, **(task_options or {}))
    crew = Crew(agents=[agent], tasks=[task], verbose=False, tracing=False, **(crew_options or {}))
    return crew, task, agent, tool, original, options


def close_model(options):
    if isinstance(options["llm"], CavemanLLM):
        options["llm"].close()


class Answer(BaseModel):
    answer: str


class ScriptedFeedback(SyncHumanInputProvider):
    """Replace human I/O only; the installed native feedback loop is unchanged."""
    def __init__(self):
        self.answers = iter(["Human feedback café 🌍: preserve exact source", ""])
        self.crews = []

    def _prompt_input(self, crew):
        self.crews.append(crew)
        return next(self.answers)

    async def _prompt_input_async(self, crew):
        return self._prompt_input(crew)


class NativeCrewAI(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        asyncio.get_running_loop().set_debug(False)

    async def test_native_crew_lossy_recovery_sync_async_stream_off_outage(self):
        for protocol in ("openai", "anthropic"):
            for execution in ("kickoff", "akickoff", "native_acall"):
                asynchronous = execution != "kickoff"
                for streaming in (False, True):
                    for mode, endpoint in (("compress", ENDPOINT), ("off", ENDPOINT), ("compress", "http://127.0.0.1:1")):
                        with self.subTest(protocol=protocol, execution=execution, stream=streaming, mode=mode, available=endpoint == ENDPOINT), Provider() as server, EvidenceRuntime(endpoint=endpoint, mode=mode) as runtime:
                            server.release.set()
                            if endpoint == ENDPOINT and mode != "off":
                                runtime.ready()
                            scope = Scope("crewai", f"native-{protocol}-{execution}-{streaming}-{mode}-{server.url}")
                            crew, task, agent, tool, original, options = make_crew(server, runtime, scope, protocol, stream=streaming,
                                agent_options={"executor_class": CrewAgentExecutor} if execution == "native_acall" else None)
                            try:
                                result = await crew.akickoff() if asynchronous else await asyncio.to_thread(crew.kickoff)
                                self.assertIsInstance(result, CrewOutput)
                                self.assertEqual(result.raw, FACT)
                                self.assertEqual(task.output.raw, FACT)
                                self.assertIs(task.agent, agent)
                                self.assertIs(agent.crew, crew)
                                self.assertEqual(tool._calls, [{}])
                                self.assertEqual(original["tools"], [tool])
                                self.assertEqual(server.errors, [])
                                self.assertTrue(crewai_event_bus.flush(timeout=3))
                                active = mode == "compress" and endpoint == ENDPOINT
                                self.assertEqual(len(server.calls), 3 if active else 2)
                                self.assertEqual(len(runtime.plans), 0 if mode == "off" else len(server.calls))
                                if active:
                                    self.assertNotIn(FACT, rendering(server.calls[1]))
                                    self.assertIn("cmw_", rendering(server.calls[1]))
                                    self.assertTrue(any(outcome.replacements for _, outcome in runtime.plans))
                                    completes = [receipt for receipt in runtime.receipts if receipt["event_kind"] == "completed"]
                                    self.assertEqual(len(completes), len(server.calls))
                                    if protocol == "anthropic" and streaming:
                                        self.assertEqual(sum(receipt["usage"] is None for receipt in completes), 2)
                                    else:
                                        self.assertTrue(all(receipt["usage"] and receipt["usage"]["input_tokens"] == 1000 for receipt in completes))
                                else:
                                    self.assertEqual(rendering(server.calls[1]), SOURCE)
                                self.assertEqual(next(message["content"] for message in agent.agent_executor.messages if message.get("tool_call_id") == "read-1"), SOURCE)
                            finally:
                                close_model(options)

    async def test_hooks_are_identity_scoped_concurrent_and_exception_safe(self):
        seen = []

        @on(InterceptionPoint.PRE_MODEL_CALL)
        def application_hook(context):
            seen.append((context.crew, context.task, context.agent, context.llm))

        before = get_hooks(InterceptionPoint.PRE_MODEL_CALL)
        try:
            with Provider() as left, Provider() as right, EvidenceRuntime(endpoint=ENDPOINT) as runtime, EvidenceRuntime(endpoint=ENDPOINT, mode="off") as disabled:
                left.release.set()
                right.release.set()
                runtime.ready()
                active = make_crew(left, runtime, Scope("crewai", "isolated-active"))
                baseline = make_crew(right, disabled, Scope("crewai", "isolated-baseline"))
                self.assertEqual(len(get_hooks(InterceptionPoint.PRE_MODEL_CALL)), len(before) + 1)
                try:
                    results = await asyncio.gather(active[0].akickoff(), baseline[0].akickoff())
                    self.assertEqual([result.raw for result in results], [FACT, FACT])
                    self.assertEqual([len(left.calls), len(right.calls)], [3, 2])
                    self.assertEqual(rendering(right.calls[1]), SOURCE)
                    self.assertEqual(len(runtime.plans), 3)
                    self.assertEqual(len(disabled.plans), 0)
                    self.assertTrue(all(crew is active[0] and task is active[1] and agent is active[2]
                                        for crew, task, agent, llm in seen if llm is active[-1]["llm"]))
                finally:
                    close_model(active[-1])
                self.assertEqual(get_hooks(InterceptionPoint.PRE_MODEL_CALL), before)
                self.assertEqual(await active[-1]["llm"].acall("native"), "native")
                self.assertEqual(len(runtime.plans), 3)
                self.assertEqual(left.errors + right.errors, [])
        finally:
            unregister_hook(InterceptionPoint.PRE_MODEL_CALL, application_hook)

    async def test_native_parallel_tools_cache_arguments_and_structured_final(self):
        class OtherTool(BaseTool):
            name: str = "read_other"
            description: str = "Read independent context"
            _calls: list = PrivateAttr(default_factory=list)

            def _run(self):
                self._calls.append({})
                return "Unchanged other tool result café 🌍"

        for protocol in ("openai", "anthropic"):
            for asynchronous in (False, True):
                with self.subTest(protocol=protocol, asynchronous=asynchronous), Provider(parallel=True, repeat_read=True, structured=True, read_args={"key": "logs/café 🌍"}) as server, EvidenceRuntime(endpoint=ENDPOINT) as runtime:
                    server.release.set()
                    runtime.ready()
                    logs, other = ReadLogs(), OtherTool()
                    crew, task, agent, _, _, options = make_crew(server, runtime, Scope("crewai", f"cache-{protocol}-{asynchronous}"), protocol,
                        agent_options={"tools": [logs, other]}, task_options={"output_pydantic": Answer}, crew_options={"cache": True})
                    try:
                        result = await crew.akickoff() if asynchronous else await asyncio.to_thread(crew.kickoff)
                        self.assertIsInstance(result.pydantic, Answer)
                        self.assertEqual(result.pydantic.answer, FACT)
                        self.assertEqual(logs._calls, [{"key": "logs/café 🌍"}])
                        self.assertEqual(other._calls, [{}])
                        self.assertEqual(agent.tools_handler.cache.read(tool="read_logs", input=json.dumps({"key": "logs/café 🌍"})), SOURCE)
                        history = agent.agent_executor.messages
                        tool_results = [message for message in history if message["role"] == "tool"]
                        self.assertEqual([message["content"] for message in tool_results if message["name"] == "read_logs"], [SOURCE, SOURCE])
                        self.assertEqual(next(message["content"] for message in tool_results if message["name"] == "read_other"), "Unchanged other tool result café 🌍")
                        self.assertEqual(len(server.calls), 4)
                        self.assertEqual(len(runtime.plans), 4)
                        self.assertEqual(rendering(server.calls[1]), rendering(server.calls[2]))
                        self.assertNotIn(FACT, rendering(server.calls[1]))
                        self.assertEqual(server.errors, [])
                    finally:
                        close_model(options)

    async def test_native_human_feedback_preserves_original_messages(self):
        for asynchronous in (False, True):
            with self.subTest(asynchronous=asynchronous), Provider() as server, EvidenceRuntime(endpoint=ENDPOINT) as runtime:
                server.release.set()
                runtime.ready()
                feedback = ScriptedFeedback()
                token = set_provider(feedback)
                crew, _, agent, _, _, options = make_crew(server, runtime, Scope("crewai", f"human-{asynchronous}"), task_options={"human_input": True})
                try:
                    result = await crew.akickoff() if asynchronous else await asyncio.to_thread(crew.kickoff)
                    self.assertEqual(result.raw, FACT)
                    self.assertEqual(feedback.crews, [crew, crew])
                    self.assertEqual(len(server.calls), 4)
                    self.assertTrue(any("Human feedback café 🌍" in str(message.get("content")) for message in agent.agent_executor.messages))
                    self.assertEqual(rendering(server.calls[1]), rendering(server.calls[3]))
                    self.assertEqual(server.errors, [])
                finally:
                    reset_provider(token)
                    close_model(options)

    async def test_native_delegated_work_keeps_crew_task_and_scopes(self):
        for asynchronous in (False, True):
            with self.subTest(asynchronous=asynchronous), Provider(delegate_to="Source reader") as manager_server, Provider() as worker_server, EvidenceRuntime(endpoint=ENDPOINT) as runtime:
                manager_server.release.set()
                worker_server.release.set()
                runtime.ready()
                _, _, worker, logs, _, worker_options = make_crew(worker_server, runtime, Scope("crewai", f"worker-{asynchronous}"))
                manager_options = with_caveman_agent(dict(role="Coordinator", goal="Delegate source reading", backstory="Use the source reader",
                    llm=manager_server.model(), allow_delegation=True, verbose=False, max_retry_limit=0), runtime=runtime, scope=Scope("crewai", f"manager-{asynchronous}"))
                manager = Agent(**manager_options)
                task = Task(description="Delegate source reading and return its exact result", expected_output=FACT, agent=manager)
                crew = Crew(agents=[manager, worker], tasks=[task], verbose=False, tracing=False)
                try:
                    result = await crew.akickoff() if asynchronous else await asyncio.to_thread(crew.kickoff)
                    self.assertEqual(result.raw, FACT)
                    self.assertEqual([len(manager_server.calls), len(worker_server.calls)], [2, 3])
                    self.assertEqual(logs._calls, [{}])
                    self.assertIs(worker.agent_executor.crew, crew)
                    self.assertIs(worker.agent_executor.task.agent, worker)
                    self.assertIsNot(worker.agent_executor.task, task)
                    self.assertIn("Delegated context café 🌍", str(worker.agent_executor.messages))
                    self.assertEqual({receipt["scope"]["session_id"] for receipt in runtime.receipts}, {f"worker-{asynchronous}", f"manager-{asynchronous}"})
                    self.assertEqual(manager_server.errors + worker_server.errors, [])
                finally:
                    close_model(manager_options)
                    close_model(worker_options)

    async def test_no_tools_preserves_native_structured_response_contract(self):
        for protocol in ("openai", "anthropic"):
            for asynchronous in (False, True):
                bodies = []
                for mode in ("off", "compress"):
                    with self.subTest(protocol=protocol, asynchronous=asynchronous, mode=mode), Provider(structured=True) as server, EvidenceRuntime(endpoint=ENDPOINT, mode=mode) as runtime:
                        server.release.set()
                        crew, _, _, _, _, options = make_crew(server, runtime, Scope("crewai", f"typed-{protocol}-{asynchronous}-{mode}"), protocol,
                            agent_options={"tools": []}, task_options={"response_model": Answer})
                        try:
                            result = await crew.akickoff() if asynchronous else await asyncio.to_thread(crew.kickoff)
                            self.assertEqual(json.loads(result.raw), {"answer": FACT})
                            self.assertEqual(options["tools"], [])
                            self.assertEqual(len(server.calls), 1)
                            bodies.append(server.calls[0]["body"])
                            self.assertEqual(server.errors, [])
                        finally:
                            close_model(options)
                self.assertEqual(bodies[0], bodies[1])

    async def test_model_only_no_recovery_and_native_stop_options(self):
        for protocol in ("openai", "anthropic"):
            with self.subTest(protocol=protocol), Provider() as server, EvidenceRuntime(endpoint=ENDPOINT) as runtime:
                server.release.set()
                runtime.ready()
                native = server.model(protocol)
                wrapped = with_caveman_llm(native, runtime=runtime, scope=Scope("crewai", f"model-only-{protocol}"))
                messages = [{"role": "user", "content": "Read source"},
                    {"role": "assistant", "content": None, "tool_calls": [{"id": "read-1", "type": "function", "function": {"name": "read_logs", "arguments": "{}"}}]},
                    {"role": "tool", "name": "read_logs", "tool_call_id": "read-1", "content": SOURCE}]
                original = copy.deepcopy(messages)
                try:
                    with call_stop_override(native, ["stop-marker"]):
                        expected = await native.acall(messages)
                    with call_stop_override(wrapped, ["stop-marker"]):
                        result = await wrapped.acall(messages)
                    self.assertEqual(expected, result)
                    self.assertEqual(server.calls[0]["body"], server.calls[1]["body"])
                    self.assertEqual(messages, original)
                    self.assertEqual(rendering(server.calls[1]), SOURCE)
                    self.assertFalse(runtime.plans[0][1].replacements)
                    self.assertEqual(wrapped.get_token_usage_summary(), native.get_token_usage_summary())
                    self.assertEqual(native.stop, [])
                    self.assertEqual(server.errors, [])
                finally:
                    wrapped.close()

    async def test_native_crew_stream_delivers_deltas_before_completion(self):
        for protocol in ("openai", "anthropic"):
            for asynchronous in (False, True):
                with self.subTest(protocol=protocol, asynchronous=asynchronous), Provider() as server, EvidenceRuntime(endpoint=ENDPOINT) as runtime:
                    runtime.ready()
                    crew, task, agent, _, _, options = make_crew(server, runtime, Scope("crewai", f"stream-{protocol}-{asynchronous}"), protocol, crew_options={"stream": True})
                    try:
                        output = await crew.akickoff() if asynchronous else crew.kickoff()
                        self.assertIsInstance(output, CrewStreamingOutput)
                        chunks = []

                        def observe(chunk):
                            self.assertIsInstance(chunk, StreamChunk)
                            chunks.append(chunk)
                            if chunk.chunk_type == StreamChunkType.TEXT and chunk.content:
                                if not server.release.is_set():
                                    self.assertFalse(output.is_completed)
                                    self.assertEqual(chunk.content, FACT[:3])
                                server.release.set()

                        if asynchronous:
                            async def consume():
                                async for chunk in output:
                                    observe(chunk)
                            await asyncio.wait_for(consume(), 4)
                        else:
                            def consume():
                                for chunk in output:
                                    observe(chunk)
                            await asyncio.wait_for(asyncio.to_thread(consume), 4)
                        self.assertEqual(output.result.raw, FACT)
                        self.assertEqual(output.get_full_text(), FACT)
                        repetitions = 2 if protocol == "openai" else 3
                        self.assertEqual([chunk.tool_call.tool_name for chunk in chunks if chunk.tool_call and chunk.tool_call.tool_name], ["read_logs"] * repetitions + ["caveman_retrieve"] * repetitions)
                        self.assertTrue(all(chunk.agent_id in ("", str(agent.id)) and chunk.task_id in ("", str(task.id)) for chunk in chunks), [(chunk.agent_id, chunk.task_id) for chunk in chunks])
                        self.assertEqual(len(server.calls), 3)
                        self.assertEqual(server.errors, [])
                    finally:
                        server.release.set()
                        close_model(options)

    async def test_public_async_executor_stream_close_cancels_native_inference(self):
        for protocol in ("openai", "anthropic"):
            for mode in ("off", "compress"):
                with self.subTest(protocol=protocol, mode=mode), Provider() as server, EvidenceRuntime(endpoint=ENDPOINT, mode=mode) as runtime:
                    if mode != "off":
                        runtime.ready()
                    crew, _, _, _, _, options = make_crew(server, runtime, Scope("crewai", f"cancel-stream-{protocol}-{mode}"), protocol,
                        agent_options={"executor_class": CrewAgentExecutor}, crew_options={"stream": True})
                    try:
                        output = await crew.akickoff()
                        iterator = output.__aiter__()
                        while True:
                            chunk = await asyncio.wait_for(anext(iterator), 3)
                            if chunk.chunk_type == StreamChunkType.TEXT and chunk.content:
                                break
                        self.assertFalse(server.release.is_set())
                        await asyncio.wait_for(output.aclose(), 1)
                        await iterator.aclose()
                        self.assertTrue(output.is_cancelled)
                        self.assertEqual(len(server.calls), 3 if mode == "compress" else 2)
                        if mode != "off":
                            self.assertEqual(sum(receipt["event_kind"] == "cancelled" for receipt in runtime.receipts), 1, [receipt["event_kind"] for receipt in runtime.receipts])
                        server.release.set()
                        self.assertEqual(server.errors, [])
                    finally:
                        server.release.set()
                        close_model(options)

    async def test_default_executor_stream_close_preserves_native_worker_limit(self):
        # The default Flow executor invokes BaseLLM.call in a worker thread.
        # Its async stream can close, but upstream cannot cancel that thread.
        for mode in ("off", "compress"):
            with self.subTest(mode=mode), Provider() as server, EvidenceRuntime(endpoint=ENDPOINT, mode=mode) as runtime:
                if mode != "off":
                    runtime.ready()
                crew, _, _, _, _, options = make_crew(server, runtime, Scope("crewai", f"native-close-{mode}"), crew_options={"stream": True})
                completed = threading.Event()
                native = options["llm"].delegate if isinstance(options["llm"], CavemanLLM) else options["llm"]

                @crewai_event_bus.on(LLMCallCompletedEvent)
                def finished(source, event):
                    if source is native and event.response == FACT:
                        completed.set()

                try:
                    output = await crew.akickoff()
                    iterator = output.__aiter__()
                    while True:
                        chunk = await asyncio.wait_for(anext(iterator), 3)
                        if chunk.chunk_type == StreamChunkType.TEXT and chunk.content:
                            break
                    await asyncio.wait_for(output.aclose(), 1)
                    await iterator.aclose()
                    self.assertTrue(output.is_cancelled)
                    self.assertFalse(completed.is_set())
                    self.assertFalse(server.release.is_set())
                    server.release.set()
                    self.assertTrue(await asyncio.to_thread(completed.wait, 3))
                    self.assertTrue(crewai_event_bus.flush(timeout=3))
                    self.assertEqual(len(server.calls), 3 if mode == "compress" else 2)
                    if mode == "compress":
                        self.assertEqual(sum(receipt["event_kind"] == "completed" for receipt in runtime.receipts), 3)
                    self.assertEqual(server.errors, [])
                finally:
                    server.release.set()
                    crewai_event_bus.off(LLMCallCompletedEvent, finished)
                    close_model(options)

    async def test_native_provider_error_and_cancellation_never_retry(self):
        for protocol in ("openai", "anthropic"):
            with self.subTest(protocol=protocol), Provider() as server, EvidenceRuntime(endpoint=ENDPOINT) as runtime:
                server.release.set()
                runtime.ready()
                wrapped = CavemanLLM(server.model(protocol), runtime=runtime, scope=Scope("crewai", f"failure-{protocol}"))
                try:
                    cancelled = asyncio.create_task(wrapped.acall([{"role": "user", "content": "native"}]))
                    cancelled.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await cancelled
                    self.assertEqual(len(server.calls), 0)
                    with self.assertRaises(Exception):
                        await wrapped.acall([{"role": "user", "content": "fail"}])
                    self.assertEqual(len(server.calls), 1)
                    cancelled = asyncio.create_task(wrapped.acall([{"role": "user", "content": "cancel"}]))
                    self.assertTrue(await asyncio.to_thread(server.cancel_entered.wait, 3))
                    cancelled.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await cancelled
                    self.assertEqual(len(server.calls), 2)
                    self.assertEqual([receipt["event_kind"] for receipt in runtime.receipts], ["dispatch_intent", "failed", "dispatch_intent", "cancelled"])
                finally:
                    server.cancel_release.set()
                    wrapped.close()

    async def test_colliding_tool_forced_choice_and_record_are_recovery_free(self):
        class PretendRecovery(BaseTool):
            name: str = "caveman_retrieve"
            description: str = "This tool is not a registered Caveman recovery executor"

            def _run(self, handle: str):
                raise AssertionError("A colliding tool must not receive Caveman handles")

        for case in ("collision", "forced", "record"):
            with self.subTest(case=case), Provider() as server, EvidenceRuntime(endpoint=ENDPOINT, mode="record" if case == "record" else "compress") as runtime:
                server.release.set()
                runtime.ready()
                logs = ReadLogs()
                agent_options = {"tools": [logs, PretendRecovery()]} if case == "collision" else {"tools": [logs]}
                llm_options = {"tool_choice": {"type": "function", "function": {"name": "read_logs"}}} if case == "forced" else None
                crew, _, _, _, original, options = make_crew(server, runtime, Scope("crewai", case), agent_options=agent_options, llm_options=llm_options)
                try:
                    self.assertEqual(options["tools"], original["tools"])
                    result = await crew.akickoff()
                    self.assertEqual(result.raw, FACT)
                    self.assertEqual(len(server.calls), 2)
                    self.assertEqual(rendering(server.calls[1]), SOURCE)
                    self.assertFalse(any(outcome.replacements for _, outcome in runtime.plans))
                    if case == "forced":
                        # CrewAI 1.15.20 itself normalizes native OpenAI tool
                        # choice to auto; the adapter must keep that baseline.
                        self.assertTrue(all(call["body"]["tool_choice"] == "auto" for call in server.calls))
                    self.assertEqual(server.errors, [])
                finally:
                    close_model(options)

    async def test_native_litellm_composition_has_one_selected_owner(self):
        import litellm
        from caveman_middleware._native import owner
        from caveman_middleware.litellm import CavemanLiteLLM

        class ObservedLiteLLM(CavemanLiteLLM):
            def __init__(self, **kwargs):
                super().__init__(**kwargs)
                self.observed_owners = []
                self.deployment_owners = []

            def log_pre_api_call(self, model, messages, kwargs):
                self.observed_owners.append(owner.get())

            async def async_pre_call_deployment_hook(self, kwargs, call_type):
                self.deployment_owners.append(owner.get())
                return await super().async_pre_call_deployment_hook(kwargs, call_type)

        for asynchronous in (False, True):
            with self.subTest(asynchronous=asynchronous), Provider() as server, EvidenceRuntime(endpoint=ENDPOINT) as outer_runtime, EvidenceRuntime(endpoint=ENDPOINT) as inner_runtime:
                outer_runtime.ready()
                server.release.set()
                scope = Scope("crewai", f"litellm-{asynchronous}")
                inner = ObservedLiteLLM(runtime=inner_runtime, proxy_scope=lambda _auth, _data: scope)
                # The public operator hook issues the registration. A copied
                # model-supplied metadata key cannot authorize this operation.
                registered = await inner.async_pre_call_hook(None, None, {}, "acompletion")
                crew, _, agent, _, _, options = make_crew(server, outer_runtime, scope,
                    llm_options={"is_litellm": True, "metadata": registered["metadata"], "callbacks": [inner]},
                    agent_options={"executor_class": CrewAgentExecutor} if asynchronous else None)

                @on(InterceptionPoint.PRE_MODEL_CALL)
                def retain_application_callback(context):
                    # CrewAI's native LiteLLM path installs executor.callbacks
                    # per call. Its public scoped hook keeps this application's
                    # explicitly configured callback in that native list.
                    if context.llm is options["llm"] and inner not in context.executor.callbacks:
                        context.executor.callbacks.append(inner)

                try:
                    with inner:
                        result = await crew.akickoff() if asynchronous else await asyncio.to_thread(crew.kickoff)
                    self.assertTrue(options["llm"].delegate.is_litellm)
                    self.assertEqual(result.raw, FACT)
                    self.assertEqual(len(server.calls), 3)
                    self.assertEqual(len(outer_runtime.plans), 3)
                    self.assertEqual(inner_runtime.plans, [])
                    self.assertEqual(inner_runtime.receipts, [])
                    observed = inner.deployment_owners if asynchronous else inner.observed_owners
                    self.assertEqual(len(observed), 3)
                    self.assertTrue(all(attempt is not None and attempt.runtime is outer_runtime for attempt in observed))
                    self.assertEqual(len({attempt.attempt_id for attempt in observed}), 3)
                    self.assertNotIn(FACT, rendering(server.calls[1]))
                    self.assertTrue(crewai_event_bus.flush(timeout=3))
                    self.assertEqual(sum(receipt["event_kind"] == "completed" for receipt in outer_runtime.receipts), 3)
                    self.assertEqual(sum(receipt["event_kind"] == "completed" and receipt["usage"] is None for receipt in outer_runtime.receipts), 2)
                    self.assertFalse(any(callback is inner for callback in litellm.callbacks))
                    self.assertEqual(server.errors, [])
                finally:
                    unregister_hook(InterceptionPoint.PRE_MODEL_CALL, retain_application_callback)
                    inner.close()
                    close_model(options)

    async def test_native_original_content_policy_runs_before_optimization(self):
        for endpoint in (ENDPOINT, "http://127.0.0.1:1"):
            with self.subTest(available=endpoint == ENDPOINT), Provider() as server, EvidenceRuntime(endpoint=endpoint) as runtime:
                server.release.set()
                if endpoint == ENDPOINT:
                    runtime.ready()
                baseline = get_hooks(InterceptionPoint.PRE_MODEL_CALL)
                crew, _, _, logs, _, options = make_crew(server, runtime, Scope("crewai", f"policy-{endpoint}"))
                rejected = []

                @on(InterceptionPoint.PRE_MODEL_CALL)
                def original_content_policy(context):
                    if context.llm is options["llm"] and any(message.get("content") == SOURCE for message in context.messages):
                        rejected.append(True)
                        raise HookAborted("original_source_denied")

                try:
                    with self.assertRaises(HookAborted):
                        await crew.akickoff()
                    self.assertEqual(rejected, [True])
                    self.assertEqual(logs._calls, [{}])
                    self.assertEqual(len(server.calls), 1)
                    self.assertEqual(len(runtime.plans), 1)
                    self.assertFalse(any(outcome.replacements for _, outcome in runtime.plans))
                finally:
                    unregister_hook(InterceptionPoint.PRE_MODEL_CALL, original_content_policy)
                    close_model(options)
                self.assertEqual(get_hooks(InterceptionPoint.PRE_MODEL_CALL), baseline)

    async def test_async_optimization_cancellation_never_dispatches_provider(self):
        class GatedRuntime(EvidenceRuntime):
            def __init__(self, **kwargs):
                super().__init__(**kwargs)
                self.entered, self.release, self.finished = threading.Event(), threading.Event(), threading.Event()

            def optimize(self, **kwargs):
                self.entered.set()
                self.release.wait(3)
                try:
                    return super().optimize(**kwargs)
                finally:
                    self.finished.set()

        with Provider() as server, GatedRuntime(endpoint=ENDPOINT) as runtime:
            runtime.ready()
            wrapped = CavemanLLM(server.model(), runtime=runtime, scope=Scope("crewai", "cancel-optimization"))
            try:
                operation = asyncio.create_task(wrapped.acall([{"role": "user", "content": "native"}]))
                self.assertTrue(await asyncio.to_thread(runtime.entered.wait, 3))
                operation.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await operation
                runtime.release.set()
                self.assertTrue(await asyncio.to_thread(runtime.finished.wait, 3))
                self.assertEqual(server.calls, [])
                self.assertEqual(runtime.receipts, [])
            finally:
                runtime.release.set()
                wrapped.close()

    async def test_twenty_native_continuations_keep_replacement_after_runtime_restart(self):
        class Progress(BaseTool):
            name: str = "read_progress"
            description: str = "Read the next progress record"
            _calls: list = PrivateAttr(default_factory=list)

            def _run(self, index: int):
                assert index == len(self._calls)
                self._calls.append(index)
                if index == 9:
                    print(json.dumps({"caveman_control": "restart"}), flush=True)
                    assert sys.stdin.readline().strip() == "runtime-ready"
                return f"Progress record {index}"

        with Provider(followups=20) as server, EvidenceRuntime(endpoint=ENDPOINT) as runtime:
            server.release.set()
            runtime.ready()
            logs, progress = ReadLogs(), Progress()
            crew, _, agent, _, _, options = make_crew(server, runtime, Scope("crewai", "twenty-turn-restart"),
                agent_options={"tools": [logs, progress], "max_iter": 27})
            try:
                result = await crew.akickoff()
                self.assertEqual(result.raw, FACT)
                self.assertEqual(progress._calls, list(range(20)))
                self.assertEqual(logs._calls, [{}])
                self.assertEqual(len(server.calls), 23)
                views = [rendering(call).encode() for call in server.calls[1:]]
                self.assertTrue(all(view == views[0] for view in views))
                self.assertNotIn(FACT.encode(), views[0])
                self.assertEqual(next(message["content"] for message in agent.agent_executor.messages if message.get("tool_call_id") == "read-1"), SOURCE)
                self.assertEqual(server.errors, [])
            finally:
                close_model(options)

    async def test_documented_local_demo_runs_without_paid_inference(self):
        for protocol, mode in (("openai", "compress"), ("anthropic", "compress"), ("openai", "off")):
            with self.subTest(protocol=protocol, mode=mode):
                result = await asyncio.to_thread(subprocess.run,
                    [sys.executable, str(Path(__file__).with_name("demo.py")), "--runtime", ENDPOINT, "--provider", protocol, "--mode", mode],
                    check=True, text=True, capture_output=True, timeout=20)
                output = json.loads(result.stdout.strip().splitlines()[-1])
                self.assertEqual(output["answer"], FACT)
                self.assertEqual(output["response_type"], "CrewOutput")
                self.assertEqual(output["provider_calls"], 3 if mode == "compress" else 2, output)
                self.assertEqual(output["provider_inference"], "deterministic_loopback_only")


from _certification_native import CapturedRuntime, run_certification
from _test_result import ReportingResult


class CrewAIReports(unittest.IsolatedAsyncioTestCase):
    async def test_passive_reports_preserve_native_calls_errors_and_hook_registration(self):
        from openai import InternalServerError

        for mode in ("off", "unsupported", "opaque"):
            with self.subTest(mode=mode), Provider() as server, CapturedRuntime("off" if mode == "off" else "compress") as runtime:
                server.release.set()
                unexpected = []
                def no_io(*args, **kwargs):
                    unexpected.append(True)
                    raise AssertionError("A passive native report cannot make runtime requests")
                runtime._http = no_io
                baseline = get_hooks(InterceptionPoint.PRE_MODEL_CALL)
                native = server.model()
                gate = patch("caveman_middleware.crewai.matches_framework", return_value=False) if mode == "unsupported" else nullcontext()
                with gate:
                    wrapper = with_caveman_llm(native, runtime=runtime, scope=Scope("report-test", mode))
                    try:
                        self.assertEqual(runtime.reports, [], "Construction cannot report a call that has not occurred")
                        if mode != "opaque":
                            self.assertEqual(get_hooks(InterceptionPoint.PRE_MODEL_CALL), baseline)
                        self.assertEqual(await asyncio.to_thread(native.call, "native"), "native")
                        self.assertEqual(await asyncio.to_thread(wrapper.call, "native"), "native")
                        self.assertEqual(await wrapper.acall("native"), "native")
                        self.assertTrue(all(call["body"] == server.calls[0]["body"] for call in server.calls))
                        with self.assertRaises(InternalServerError):
                            await wrapper.acall("fail")
                        self.assertEqual(len(server.calls), 4)
                        self.assertEqual(len(runtime.reports), 3)
                        reason = "disabled" if mode == "off" else "unsupported_version" if mode == "unsupported" else "unsupported_shape"
                        self.assertTrue(all(report.reason == reason and report.replacement_count == 0 for report in runtime.reports))
                        self.assertTrue(all(report.status == ("disabled" if mode == "off" else "skipped") for report in runtime.reports))
                        self.assertEqual(len({report.attempt_id for report in runtime.reports}), 3)
                        self.assertIs(runtime.last_report, runtime.reports[-1])
                        self.assertEqual(runtime.plans, [])
                        self.assertEqual(runtime.receipts, [])
                        self.assertEqual(unexpected, [])
                        self.assertEqual(server.errors, [])
                    finally:
                        wrapper.close()
                self.assertEqual(get_hooks(InterceptionPoint.PRE_MODEL_CALL), baseline)


class CrewAICertification(unittest.IsolatedAsyncioTestCase):
    async def test_f10_openai_exact_journeys(self):
        await run_certification(self, "openai", sys.modules[__name__])

    async def test_f10_anthropic_exact_journeys(self):
        await run_certification(self, "anthropic", sys.modules[__name__])


if __name__ == "__main__":
    print(json.dumps({"framework": version("crewai"), "openai": version("openai"), "anthropic": version("anthropic"), "litellm": version("litellm")}))
    unittest.main(testRunner=unittest.TextTestRunner(verbosity=2, resultclass=ReportingResult))
