"""Pinned Agno loops and provider clients against deterministic local HTTP."""
import asyncio
import copy
import functools
import json
import os
import re
import threading
import unittest
import uuid
import weakref
from concurrent.futures import ThreadPoolExecutor

import anthropic
import httpx
import openai
from agno.agent import Agent
from agno.models.anthropic import Claude
from agno.models.message import Message
from agno.models.openai import OpenAIChat
from agno.models.response import ModelResponse
from agno.run.agent import RunOutput
from agno.run.base import BaseRunOutputEvent
from agno.run.cancel import cancel_run
from agno.team import Team
from agno.tools.function import Function
from pydantic import BaseModel

from caveman_cloud.middleware import Scope
from caveman_middleware.agno import with_caveman_agent, with_caveman_model, scope_from_run
from caveman_middleware._native import owner
from evidence_runtime import EvidenceRuntime
from python_fixture import ProviderServer

ENDPOINT = os.environ["CAVEMAN_MIDDLEWARE_ENDPOINT"]
SOURCE = "".join(f"[INFO] café 🌍 row {i} retained-detail-{i} long repeated diagnostic\r\n" for i in range(140))
NAMESPACES = weakref.WeakKeyDictionary()


def read_logs(path: str = "fixture/diagnostics.log") -> str:
    """Read the original diagnostic source."""
    if path != "fixture/diagnostics.log":
        raise ValueError("Unexpected fixture source")
    return SOURCE


class Answer(BaseModel):
    answer: int


class GatedRuntime(EvidenceRuntime):
    """Pause before the real runtime request to expose the cancellation boundary."""
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.entered, self.release = threading.Event(), threading.Event()

    def optimize(self, **kwargs):
        self.entered.set()
        if not self.release.wait(5):
            raise AssertionError("test did not release its optimization gate")
        return super().optimize(**kwargs)


def text_content(content):
    if isinstance(content, str):
        return content
    return "".join(part["text"] for part in (content or []) if part.get("type") == "text")


class Fixture:
    def __init__(self, protocol, *, structured=False, reasoning=False):
        self.protocol, self.structured, self.reasoning = protocol, structured, reasoning
        self.calls = []
        self.release = threading.Event()
        self.finished = False

    @property
    def released(self):
        return self.release.is_set()

    def response(self, request):
        body = json.loads(request.content)
        self.calls.append((request, body))
        if len(self.calls) > 12:
            raise AssertionError("native fixture exceeded its provider-call budget")
        if request.url.path.endswith("count_tokens"):
            return httpx.Response(200, json={"input_tokens": 7})
        if body["model"] == "failure":
            return httpx.Response(500, json={"error": {"message": "native failure", "type": "server_error"}})
        if self.protocol == "openai":
            ids = {call["id"]: call["function"]["name"] for message in body["messages"] for call in message.get("tool_calls", [])}
            results = {ids.get(message["tool_call_id"]): message["content"] for message in body["messages"] if message["role"] == "tool"}
            names = [tool.get("function", {}).get("name") for tool in body.get("tools", [])]
        else:
            ids = {part["id"]: part["name"] for message in body["messages"] if isinstance(message["content"], list)
                   for part in message["content"] if part["type"] == "tool_use"}
            results = {ids.get(part["tool_use_id"]): part["content"] for message in body["messages"] if isinstance(message["content"], list)
                       for part in message["content"] if part["type"] == "tool_result"}
            names = [tool.get("name") for tool in body.get("tools", [])]
        call = None
        content = '{"answer":42}' if self.structured else "native"
        if "read_logs" not in results and "read_logs" in names and body.get("tool_choice") != "none":
            call = ("read-1", "read_logs", {"path": "fixture/diagnostics.log"})
        elif "read_logs" in results:
            source = text_content(results["read_logs"])
            handle = re.search(r"cmw_[a-f0-9]{48}", source)
            if handle and "caveman_retrieve" not in results:
                assert "retained-detail-70" not in source, "forced fact must be absent from the compressed view"
                call = ("recover-1", "caveman_retrieve", {"handle": handle[0]})
            else:
                original = json.loads(text_content(results["caveman_retrieve"]))["text"] if "caveman_retrieve" in results else source
                assert original.encode() == SOURCE.encode(), "recovery must return exact Unicode/CRLF bytes"
                content = '{"answer":42}' if self.structured else "retained-detail-70"
        if self.protocol == "openai":
            return self.openai_response(body, call, content)
        return self.anthropic_response(body, call, content)

    def openai_response(self, body, call, content):
        message = {"role": "assistant", "content": None if call else content}
        if call:
            message["tool_calls"] = [{"id": call[0], "type": "function", "function": {"name": call[1], "arguments": json.dumps(call[2])}}]
        stop = "tool_calls" if call else "stop"
        usage = {"prompt_tokens": 1000, "completion_tokens": 20, "total_tokens": 1020,
                 "prompt_tokens_details": {"cached_tokens": 100}, "completion_tokens_details": {"reasoning_tokens": 3}}
        envelope = {"id": "chatcmpl-fixture", "object": "chat.completion", "created": 1, "model": body["model"]}
        if not body.get("stream"):
            return httpx.Response(200, json={**envelope, "choices": [{"index": 0, "message": message, "finish_reason": stop}], "usage": usage})
        fixture = self
        class Bytes(httpx.SyncByteStream):
            def __iter__(self):
                def event(delta, finish=None, stats=None):
                    result = {**envelope, "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
                    if stats:
                        result["usage"] = stats
                    return ("data: " + json.dumps(result) + "\n\n").encode()
                if call:
                    args = json.dumps(call[2])
                    yield event({"role": "assistant", "tool_calls": [{"index": 0, "id": call[0], "type": "function", "function": {"name": call[1], "arguments": args[:1]}}]})
                    yield event({"tool_calls": [{"index": 0, "function": {"arguments": args[1:]}}]})
                else:
                    yield event({"role": "assistant", "content": content[:9]})
                    assert fixture.release.wait(5), "first native content event was buffered"
                    yield event({"content": content[9:]})
                    fixture.finished = True
                yield event({}, stop, usage)
                yield b"data: [DONE]\n\n"
        return httpx.Response(200, stream=Bytes(), headers={"content-type": "text/event-stream"})

    def anthropic_response(self, body, call, text):
        content = [{"type": "tool_use", "id": call[0], "name": call[1], "input": call[2]}] if call else [{"type": "text", "text": text}]
        if self.reasoning and call and call[0] == "read-1":
            content.insert(0, {"type": "thinking", "thinking": "native reasoning", "signature": "signed-fixture-signature"})
        stop = "tool_use" if call else "end_turn"
        usage = {"input_tokens": 1000, "output_tokens": 20, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 0}
        message = {"id": "msg-fixture", "type": "message", "role": "assistant", "model": body["model"],
                   "content": content, "stop_reason": stop, "stop_sequence": None, "usage": usage}
        if not body.get("stream"):
            return httpx.Response(200, json=message)
        fixture = self
        class Bytes(httpx.SyncByteStream):
            def __iter__(self):
                def event(kind, **fields):
                    return ("event: " + kind + "\ndata: " + json.dumps({"type": kind, **fields}) + "\n\n").encode()
                yield event("message_start", message={**message, "content": [], "stop_reason": None, "usage": {**usage, "output_tokens": 0}})
                for index, part in enumerate(content):
                    if part["type"] == "tool_use":
                        args = json.dumps(part["input"])
                        yield event("content_block_start", index=index, content_block={**part, "input": {}})
                        for chunk in (args[:1], args[1:]):
                            yield event("content_block_delta", index=index, delta={"type": "input_json_delta", "partial_json": chunk})
                    elif part["type"] == "thinking":
                        yield event("content_block_start", index=index, content_block={"type": "thinking", "thinking": "", "signature": ""})
                        yield event("content_block_delta", index=index, delta={"type": "thinking_delta", "thinking": part["thinking"]})
                        yield event("content_block_delta", index=index, delta={"type": "signature_delta", "signature": part["signature"]})
                    else:
                        yield event("content_block_start", index=index, content_block={"type": "text", "text": ""})
                        yield event("content_block_delta", index=index, delta={"type": "text_delta", "text": text[:9]})
                        assert fixture.release.wait(5), "first native content event was buffered"
                        yield event("content_block_delta", index=index, delta={"type": "text_delta", "text": text[9:]})
                        fixture.finished = True
                    yield event("content_block_stop", index=index)
                yield event("message_delta", delta={"stop_reason": stop, "stop_sequence": None}, usage={"output_tokens": 20})
                yield event("message_stop")
        return httpx.Response(200, stream=Bytes(), headers={"content-type": "text/event-stream"})


def model(server, protocol, *, asynchronous=False, model_id=None):
    if protocol == "openai":
        client = (openai.AsyncOpenAI if asynchronous else openai.OpenAI)(api_key="fixture", base_url=server.url + "/v1", max_retries=0, timeout=3)
        return OpenAIChat(id=model_id or "gpt-fixture", **{"async_client" if asynchronous else "client": client},
                          temperature=0.2, reasoning_effort="low", extra_headers={"x-native-option": "preserved"}), client
    client = (anthropic.AsyncAnthropic if asynchronous else anthropic.Anthropic)(api_key="fixture", base_url=server.url, max_retries=0, timeout=3)
    return Claude(id=model_id or "claude-sonnet-4-6", **{"async_client" if asynchronous else "client": client},
                  temperature=0.2, max_tokens=2048, cache_system_prompt=False), client


def create(native, runtime, *, session="native-session", team=False, **options):
    settings = dict(model=native, tools=[read_logs], session_id=session, user_id="native-user", id="native-owner",
                    telemetry=False, **({"members": []} if team else {}))
    settings.update(options)
    scope = functools.partial(scope_from_run, namespace=NAMESPACES.setdefault(runtime, "agno-" + str(uuid.uuid4())))
    return (Team if team else Agent)(**with_caveman_agent(settings, runtime=runtime, scope=scope))


class NativeAgno(unittest.TestCase):
    def test_native_async_lifecycle_controls_preserve_cleanup_and_usage(self):
        from probe_lifecycle import collect, validate
        results = collect(endpoint=ENDPOINT)
        self.assertEqual(len(results), 24)
        self.assertEqual(validate(results), [])

    def assert_journey(self, fixture, server, runtime, result):
        self.assertEqual(result.content, "retained-detail-70")
        self.assertEqual(result.session_id, "native-session")
        self.assertEqual(len(fixture.calls), 3, [(p.status, p.reason) for _, p in runtime.plans])
        self.assertEqual(len(runtime.plans), 3, "every native continuation is intercepted")
        self.assertTrue(any(plan.status == "optimized" for _, plan in runtime.plans))
        self.assertEqual(next(message.content for message in result.messages if message.tool_call_id == "read-1"), SOURCE)
        self.assertEqual(next(tool.result for tool in result.tools if tool.tool_name == "read_logs"), SOURCE)
        self.assertEqual(result.tools[0].tool_args, {"path": "fixture/diagnostics.log"})
        self.assertEqual([tool.tool_name for tool in result.tools], ["read_logs", "caveman_retrieve"])
        self.assertEqual(fixture.calls[0][1]["tools"], fixture.calls[1][1]["tools"])
        self.assertEqual(fixture.calls[1][1]["tools"], fixture.calls[2][1]["tools"])
        self.assertEqual(len([r for r in runtime.receipts if r["event_kind"] == "completed"]), 3)
        self.assertTrue(all(r["usage"]["complete"] for r in runtime.receipts if r["event_kind"] == "completed"))
        self.assertEqual(server.errors, [])
        self.assertIsNone(owner.get())

    def test_run_recovery_native_history_options_and_signed_thinking(self):
        for protocol in ("openai", "anthropic"):
            with self.subTest(protocol=protocol):
                fixture = Fixture(protocol, reasoning=protocol == "anthropic")
                with ProviderServer(fixture) as server, EvidenceRuntime(endpoint=ENDPOINT) as runtime:
                    runtime.ready()
                    native, client = model(server, protocol)
                    try:
                        agent = create(native, runtime)
                        result = agent.run("Read logs and recover row 70")
                        self.assertIsInstance(result, RunOutput)
                        self.assertEqual(result.agent_id, "native-owner")
                        self.assert_journey(fixture, server, runtime, result)
                        self.assertTrue(all(body["temperature"] == 0.2 for _, body in fixture.calls))
                        if protocol == "openai":
                            self.assertTrue(all(body["reasoning_effort"] == "low" for _, body in fixture.calls))
                            self.assertTrue(all(request.headers["x-native-option"] == "preserved" for request, _ in fixture.calls))
                        else:
                            blocks = [part for message in fixture.calls[1][1]["messages"] if isinstance(message["content"], list) for part in message["content"]]
                            self.assertIn({"type": "thinking", "thinking": "native reasoning", "signature": "signed-fixture-signature"}, blocks)
                    finally:
                        client.close()

    def test_run_stream_native_events_first_content_before_completion(self):
        for protocol in ("openai", "anthropic"):
            with self.subTest(protocol=protocol):
                fixture = Fixture(protocol)
                with ProviderServer(fixture) as server, EvidenceRuntime(endpoint=ENDPOINT) as runtime:
                    runtime.ready(); native, client = model(server, protocol)
                    try:
                        events, text = [], ""
                        for event in create(native, runtime).run("Read source", stream=True, stream_events=True):
                            self.assertIsInstance(event, BaseRunOutputEvent)
                            events.append(event)
                            if event.event == "RunContent" and event.content:
                                text += event.content
                                if text == "retained-":
                                    self.assertFalse(fixture.finished)
                                    fixture.release.set()
                        self.assertEqual(text, "retained-detail-70")
                        self.assertEqual(events[0].event, "RunStarted")
                        self.assertEqual(events[-1].event, "RunCompleted")
                        self.assertEqual([e.tool.tool_name for e in events if e.event == "ToolCallCompleted"], ["read_logs", "caveman_retrieve"])
                        self.assertEqual(len(fixture.calls), 3)
                        self.assertEqual(len(runtime.plans), 3)
                        self.assertEqual(server.errors, [])
                    finally:
                        fixture.release.set(); client.close()

    def test_off_record_outage_and_structured_output_preserve_originals(self):
        for protocol in ("openai", "anthropic"):
            for mode, endpoint in (("off", ENDPOINT), ("record", ENDPOINT), ("compress", "http://127.0.0.1:1"), ("structured", ENDPOINT)):
                with self.subTest(protocol=protocol, mode=mode):
                    fixture = Fixture(protocol, structured=mode == "structured")
                    with ProviderServer(fixture) as server, EvidenceRuntime(endpoint=endpoint, mode="compress" if mode == "structured" else mode) as runtime:
                        native, client = model(server, protocol)
                        try:
                            result = create(native, runtime, **({"output_schema": Answer} if mode == "structured" else {})).run("Read source")
                            self.assertEqual(result.content, Answer(answer=42) if mode == "structured" else "retained-detail-70")
                            self.assertEqual(len(fixture.calls), 2)
                            self.assertEqual(next(m.content for m in result.messages if m.tool_call_id == "read-1"), SOURCE)
                            self.assertTrue(all(not plan.replacements for _, plan in runtime.plans))
                            if mode == "off":
                                self.assertEqual(runtime.plans, [])
                            if mode == "structured":
                                self.assertTrue(all("caveman_retrieve" not in json.dumps(body["tools"]) for _, body in fixture.calls))
                                body = fixture.calls[-1][1]
                                self.assertTrue(body.get("response_format") or body.get("output_config") or body.get("output_format"))
                            self.assertEqual(server.errors, [])
                        finally:
                            client.close()

    def test_model_only_and_fake_registration_are_recovery_free(self):
        messages = [Message(role="user", content="Read source"), Message(role="assistant", tool_calls=[{
            "id": "read-1", "type": "function", "function": {"name": "read_logs", "arguments": "{}"}}]),
            Message(role="tool", tool_call_id="read-1", tool_name="read_logs", content=SOURCE)]
        for protocol in ("openai", "anthropic"):
            fixture = Fixture(protocol)
            with ProviderServer(fixture) as server, EvidenceRuntime(endpoint=ENDPOINT) as runtime:
                runtime.ready(); native, client = model(server, protocol)
                try:
                    before = copy.deepcopy(messages)
                    result = with_caveman_model(native, runtime=runtime, scope=Scope("agno", "model-only")).response(messages.copy())
                    self.assertIsInstance(result, ModelResponse)
                    self.assertEqual(messages, before)
                    self.assertFalse(runtime.plans[-1][1].replacements)
                    fake = Function(name="caveman_retrieve", entrypoint=lambda handle: "fake")
                    result = create(native, runtime, tools=[read_logs, fake]).run("Read source")
                    self.assertEqual(result.content, "retained-detail-70")
                    options = with_caveman_agent({"model": native, "tools": [read_logs], "telemetry": False},
                                                runtime=runtime, scope=Scope("agno", "schema-lookalike"))
                    fake = options["tools"][-1].model_copy()
                    fake.entrypoint = lambda handle: "schema-only fake"
                    options["tools"] = [read_logs, fake]
                    result = Agent(**options).run("Read source")
                    self.assertEqual(result.content, "retained-detail-70")
                    self.assertTrue(all(not plan.replacements for _, plan in runtime.plans))
                    self.assertEqual(len(fixture.calls), 5)
                    self.assertEqual(server.errors, [])
                finally:
                    client.close()

    def test_team_identity_and_dynamic_native_tool_factory(self):
        fixture = Fixture("openai")
        with ProviderServer(fixture) as server, EvidenceRuntime(endpoint=ENDPOINT) as runtime:
            runtime.ready(); native, client = model(server, "openai")
            try:
                calls = []
                def factory(run_context):
                    calls.append(run_context.session_id)
                    return [read_logs]
                result = create(native, runtime, team=True, tools=factory).run("Read source")
                self.assertEqual(result.team_id, "native-owner")
                self.assertEqual(calls, ["native-session"])
                self.assert_journey(fixture, server, runtime, result)
            finally:
                client.close()

    def test_native_cancel_run_during_optimization_dispatches_no_provider_call(self):
        fixture = Fixture("openai")
        with ProviderServer(fixture) as server, GatedRuntime(endpoint=ENDPOINT) as runtime, ThreadPoolExecutor(max_workers=1) as worker:
            runtime.ready(); native, client = model(server, "openai")
            try:
                agent = create(native, runtime)
                future = worker.submit(agent.run, "No provider call after cancellation", run_id="agno-cancel-sync")
                self.assertTrue(runtime.entered.wait(3))
                self.assertTrue(cancel_run("agno-cancel-sync"))
                runtime.release.set()
                result = future.result(timeout=3)
                self.assertEqual(result.status.value, "CANCELLED")
                self.assertEqual(fixture.calls, [])
                self.assertFalse(any(r["event_kind"] == "dispatch_intent" for r in runtime.receipts))
                self.assertEqual(server.errors, [])
            finally:
                runtime.release.set(); client.close()

    def test_native_model_stream_close_keeps_usage_incomplete(self):
        for protocol in ("openai", "anthropic"):
            fixture = Fixture(protocol)
            with ProviderServer(fixture) as server, EvidenceRuntime(endpoint=ENDPOINT) as runtime:
                native, client = model(server, protocol)
                wrapped = with_caveman_model(native, runtime=runtime, scope=Scope("agno-close", protocol))
                iterator = wrapped.response_stream([Message(role="user", content="Return native")])
                try:
                    first = next(event for event in iterator if event.content)
                    self.assertIsInstance(first, ModelResponse)
                    self.assertEqual(first.content, "native")
                    self.assertFalse(fixture.finished)
                    iterator.close()
                    self.assertEqual(runtime.receipts[-1]["event_kind"], "cancelled")
                    self.assertIsNone(runtime.receipts[-1]["usage"])
                    self.assertEqual(len(fixture.calls), 1)
                    self.assertIsNone(owner.get())
                finally:
                    fixture.release.set(); iterator.close(); client.close()


class AsyncNativeAgno(unittest.IsolatedAsyncioTestCase):
    async def test_arun_structured_and_optimizer_outage_use_native_provider_schemas(self):
        for protocol in ("openai", "anthropic"):
            for endpoint in (ENDPOINT, "http://127.0.0.1:1"):
                fixture = Fixture(protocol, structured=True)
                with ProviderServer(fixture) as server, EvidenceRuntime(endpoint=endpoint) as runtime:
                    native, client = model(server, protocol, asynchronous=True)
                    try:
                        result = await create(native, runtime, output_schema=Answer).arun("Read source then return 42")
                        self.assertIsInstance(result, RunOutput)
                        self.assertEqual(result.content, Answer(answer=42))
                        self.assertEqual(len(fixture.calls), 2)
                        self.assertEqual(next(m.content for m in result.messages if m.tool_call_id == "read-1"), SOURCE)
                        self.assertTrue(all(not plan.replacements for _, plan in runtime.plans))
                        self.assertTrue(all("caveman_retrieve" not in json.dumps(body["tools"]) for _, body in fixture.calls))
                        self.assertEqual(server.errors, [])
                    finally:
                        await client.close()

    async def test_task_cancel_during_optimization_never_falls_back_to_provider(self):
        for streaming in (False, True):
            fixture = Fixture("openai")
            with ProviderServer(fixture) as server, GatedRuntime(endpoint=ENDPOINT) as runtime:
                runtime.ready(); native, client = model(server, "openai", asynchronous=True)
                iterator = None
                try:
                    agent = create(native, runtime)
                    if streaming:
                        iterator = agent.arun("Cancelled source", stream=True, stream_events=False)
                        task = asyncio.create_task(anext(iterator))
                    else:
                        task = asyncio.create_task(agent.arun("Cancelled source"))
                    self.assertTrue(await asyncio.to_thread(runtime.entered.wait, 3))
                    task.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await task
                    runtime.release.set()
                    await runtime.as_async().aclose()
                    self.assertEqual(fixture.calls, [])
                    self.assertFalse(any(r["event_kind"] == "dispatch_intent" for r in runtime.receipts))
                    self.assertIsNone(owner.get())
                finally:
                    runtime.release.set()
                    if iterator:
                        await iterator.aclose()
                    await client.close()

    async def test_native_async_model_stream_close_keeps_usage_incomplete(self):
        for protocol in ("openai", "anthropic"):
            fixture = Fixture(protocol)
            with ProviderServer(fixture) as server, EvidenceRuntime(endpoint=ENDPOINT) as runtime:
                native, client = model(server, protocol, asynchronous=True)
                wrapped = with_caveman_model(native, runtime=runtime, scope=Scope("agno-async-close", protocol))
                iterator = wrapped.aresponse_stream([Message(role="user", content="Return native")])
                try:
                    async for event in iterator:
                        if event.content:
                            self.assertEqual(event.content, "native")
                            break
                    self.assertFalse(fixture.finished)
                    await iterator.aclose()
                    self.assertEqual(runtime.receipts[-1]["event_kind"], "cancelled")
                    self.assertIsNone(runtime.receipts[-1]["usage"])
                    self.assertEqual(len(fixture.calls), 1)
                    self.assertIsNone(owner.get())
                finally:
                    fixture.release.set(); await iterator.aclose(); await client.close()

    async def test_arun_concurrent_native_sessions_and_recovery(self):
        for protocol in ("openai", "anthropic"):
            fixture = Fixture(protocol)
            with ProviderServer(fixture) as server, EvidenceRuntime(endpoint=ENDPOINT) as runtime:
                runtime.ready(); native, client = model(server, protocol, asynchronous=True)
                try:
                    agents = [create(native, runtime, session=f"async-{i}") for i in range(2)]
                    results = await asyncio.gather(*(agent.arun("Read source") for agent in agents))
                    self.assertEqual([result.content for result in results], ["retained-detail-70"] * 2)
                    self.assertEqual([result.session_id for result in results], ["async-0", "async-1"])
                    self.assertEqual(len(fixture.calls), 6, [(p.status, p.reason) for _, p in runtime.plans])
                    self.assertEqual(len(runtime.plans), 6)
                    self.assertEqual({r["scope"]["session_id"] for r in runtime.receipts}, {"async-0", "async-1"})
                    self.assertEqual(len({handle for _, plan in runtime.plans for replacement in plan.replacements
                                          for handle in re.findall(r"cmw_[a-f0-9]{48}", replacement["text"])}), 2)
                    self.assertTrue(all(next(m.content for m in result.messages if m.tool_call_id == "read-1") == SOURCE for result in results))
                    self.assertEqual(server.errors, [])
                    self.assertIsNone(owner.get())
                finally:
                    await client.close()

    async def test_arun_stream_native_recovery_and_first_chunk(self):
        for protocol in ("openai", "anthropic"):
            fixture = Fixture(protocol)
            with ProviderServer(fixture) as server, EvidenceRuntime(endpoint=ENDPOINT) as runtime:
                runtime.ready(); native, client = model(server, protocol, asynchronous=True)
                try:
                    text, events = "", []
                    async for event in create(native, runtime).arun("Read source", stream=True, stream_events=True):
                        self.assertIsInstance(event, BaseRunOutputEvent)
                        events.append(event)
                        if event.event == "RunContent" and event.content:
                            text += event.content
                            if text == "retained-":
                                self.assertFalse(fixture.finished)
                                fixture.release.set()
                    self.assertEqual(text, "retained-detail-70")
                    self.assertEqual(events[0].event, "RunStarted")
                    self.assertEqual(events[-1].event, "RunCompleted")
                    self.assertEqual([e.tool.tool_name for e in events if e.event == "ToolCallCompleted"], ["read_logs", "caveman_retrieve"])
                    self.assertEqual(len(fixture.calls), 3)
                    self.assertEqual(len(runtime.plans), 3)
                    self.assertEqual(server.errors, [])
                    self.assertIsNone(owner.get())
                finally:
                    fixture.release.set(); await client.close()


class AgnoCertification(unittest.IsolatedAsyncioTestCase):
    async def test_sync_passive_calls_report_once_without_optimizer_content(self):
        from _certification_native import passive_reports
        await passive_reports(self, "sync")

    async def test_async_passive_calls_report_once_without_optimizer_content(self):
        from _certification_native import passive_reports
        await passive_reports(self, "async")

    async def test_openai_sync_exact_operation_journeys(self):
        from _certification_native import certify_cells
        await certify_cells(self, "openai", "sync")

    async def test_openai_async_exact_operation_journeys(self):
        from _certification_native import certify_cells
        await certify_cells(self, "openai", "async")

    async def test_anthropic_sync_exact_operation_journeys(self):
        from _certification_native import certify_cells
        await certify_cells(self, "anthropic", "sync")

    async def test_anthropic_async_exact_operation_journeys(self):
        from _certification_native import certify_cells
        await certify_cells(self, "anthropic", "async")


if __name__ == "__main__":
    from _test_result import ReportingResult
    unittest.main(verbosity=2, testRunner=unittest.TextTestRunner(verbosity=2, resultclass=ReportingResult))
