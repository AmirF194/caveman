"""Installed AutoGen clients and AssistantAgent tools against real local HTTP.

The inference server is deterministic; compression and recovery use the real
Engine process started by the shared Node conformance harness.
"""
from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import os
import re
import threading
import unittest
import warnings
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.metadata import version

import openai
if version("openai") == "3.10.0":
    import httpx2 as provider_http
else:
    import httpx as provider_http
from autogen_agentchat.agents import AssistantAgent
from autogen_agentchat.base import TaskResult
from autogen_agentchat.messages import ModelClientStreamingChunkEvent, TextMessage, ToolCallExecutionEvent, ToolCallRequestEvent
from autogen_agentchat.teams import RoundRobinGroupChat
from autogen_core import CancellationToken, FunctionCall
from autogen_core.models import AssistantMessage, ChatCompletionClient, CreateResult, FunctionExecutionResult, FunctionExecutionResultMessage, SystemMessage, UserMessage
from autogen_core.tools import BaseStreamTool, FunctionTool, StaticStreamWorkbench, TextResultContent, ToolResult, Workbench
from autogen_ext.models.anthropic import AnthropicChatCompletionClient
from autogen_ext.models.openai import OpenAIChatCompletionClient
from pydantic import BaseModel

from caveman_cloud.middleware import Scope
from caveman_middleware.autogen import CavemanChatCompletionClient, CavemanWorkbench, component_runtimes, with_caveman_agent, with_caveman_model
from evidence_runtime import EvidenceRuntime

ENDPOINT = os.environ["CAVEMAN_MIDDLEWARE_ENDPOINT"]
SOURCE = "".join(f"[INFO] café 🌍 row {i} retained-detail-{i} long repeated diagnostic\r\n" for i in range(140))
FACT = "retained-detail-70"
MODEL_INFO = {"vision": True, "function_calling": True, "json_output": True, "structured_output": True, "family": "unknown"}


def read_logs() -> str:
    """Read the original diagnostic source."""
    return "".join(f"[INFO] café 🌍 row {i} retained-detail-{i} long repeated diagnostic\r\n" for i in range(140))


def read_other() -> str:
    """Read a distinct source that happens to contain identical bytes."""
    return SOURCE


def collision(handle: str) -> str:
    """An application-owned tool with the reserved name."""
    return "application-owned"


class Answer(BaseModel):
    answer: int


class NoArguments(BaseModel):
    pass


class ProgressTool(BaseStreamTool[NoArguments, TextMessage, str]):
    def __init__(self):
        super().__init__(NoArguments, str, "read_logs", "Read original source with native progress events")

    async def run(self, args, cancellation_token):
        return SOURCE

    async def run_stream(self, args, cancellation_token):
        yield TextMessage(content="source ready", source="read_logs")
        yield SOURCE


class StatefulWorkbench(StaticStreamWorkbench):
    """Application-owned native workbench; all tool work stays in AutoGen."""
    def __init__(self, tools):
        super().__init__(tools)
        self.calls, self.starts, self.stops, self.resets = [], 0, 0, 0

    async def call_tool_stream(self, name, arguments=None, cancellation_token=None, call_id=None):
        self.calls.append({"name": name, "arguments": dict(arguments or {}), "call_id": call_id})
        async for event in super().call_tool_stream(name, arguments, cancellation_token, call_id):
            yield event

    async def start(self):
        self.starts += 1

    async def stop(self):
        self.stops += 1

    async def reset(self):
        self.resets += 1

    async def save_state(self):
        return {"calls": copy.deepcopy(self.calls)}

    async def load_state(self, state):
        self.calls = copy.deepcopy(state["calls"])


class CaptureHTTPClient(provider_http.AsyncClient):
    """Observe the real SDK transport through its public send method."""
    def __init__(self):
        super().__init__()
        self.responses = []

    async def send(self, *args, **kwargs):
        response = await super().send(*args, **kwargs)
        self.responses.append(response)
        return response


class Provider:
    def __init__(self, *, parallel=False):
        self.parallel = parallel
        self.calls, self.errors = [], []
        self.release = threading.Event()
        self.cancel_entered = threading.Event()
        self.cancel_release = threading.Event()
        parent = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def handle(self):
                try:
                    super().handle()
                except (BrokenPipeError, ConnectionResetError):
                    pass  # Expected when the native client cancels a stream.

            def log_message(self, *_):
                pass

            def do_POST(self):
                try:
                    raw = self.rfile.read(int(self.headers["content-length"]))
                    body = json.loads(raw)
                    parent.calls.append({"path": self.path, "body": body, "raw": raw, "headers": dict(self.headers)})
                    anthropic = self.path.rstrip("/").endswith("messages")
                    users = [m.get("content") for m in body["messages"] if m["role"] == "user" and isinstance(m.get("content"), str)]
                    if users and users[-1] == "fail":
                        self.send_json({"error": {"message": "native failure", "type": "server_error"}}, 500)
                        return
                    if users and users[-1] == "cancel":
                        parent.cancel_entered.set()
                        parent.cancel_release.wait(5)
                    tools = body.get("tools", [])
                    names = [t["name"] if anthropic else t["function"]["name"] for t in tools]
                    if anthropic:
                        results = [p for m in body["messages"] if isinstance(m.get("content"), list)
                                   for p in m["content"] if p.get("type") == "tool_result"]
                        source = next((p["content"] for p in results if p["tool_use_id"] == "read-1"), None)
                        recovered = next((p["content"] for p in results if p["tool_use_id"] == "recover-1"), None)
                    else:
                        results = [m for m in body["messages"] if m["role"] == "tool"]
                        source = next((m["content"] for m in results if m["tool_call_id"] == "read-1"), None)
                        recovered = next((m["content"] for m in results if m["tool_call_id"] == "recover-1"), None)
                    function = None
                    text = "native"
                    if body.get("response_format"):
                        text = '{"answer":42}'
                    elif source is None and "read_logs" in names:
                        function = ("read-1", "read_logs", {})
                    elif source is not None:
                        handle = re.search(r"cmw_[a-f0-9]{48}", source)
                        if handle and recovered is None:
                            assert FACT not in source, "the recovery question must require omitted source content"
                            function = ("recover-1", "caveman_retrieve", {"handle": handle[0], "offset": 0, "limit": 262144, "query": ""})
                        else:
                            if recovered is not None:
                                page = json.loads(recovered)
                                assert page["text"].encode() == SOURCE.encode(), "native recovery lost exact UTF-8 source bytes"
                                assert page["complete"] is True
                                assert page["next_offset"] is None
                                assert page["original_sha256"] == hashlib.sha256(SOURCE.encode()).hexdigest()
                                assert page["source_id"], "recovery must preserve source identity"
                            else:
                                assert source == SOURCE
                            text = FACT
                    if anthropic:
                        self.anthropic_response(body, function, text)
                    else:
                        self.openai_response(body, function, text)
                except (BrokenPipeError, ConnectionResetError):
                    pass
                except BaseException as error:
                    parent.errors.append(f"{type(error).__name__}: {error}")
                    try:
                        self.send_json({"error": {"message": "local fixture assertion failed", "type": "server_error"}}, 500)
                    except (BrokenPipeError, ConnectionResetError):
                        pass

            def send_json(self, value, status=200):
                encoded = json.dumps(value, ensure_ascii=False).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def stream(self, before, after, gate=False):
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.send_header("content-length", str(len(before) + len(after)))
                self.end_headers()
                self.wfile.write(before)
                self.wfile.flush()
                if gate and not parent.release.wait(5):
                    parent.errors.append("native consumer did not receive a delta before provider completion was released")
                self.wfile.write(after)
                self.wfile.flush()

            def openai_response(self, body, function, text):
                base = {"id": "chatcmpl-fixture", "created": 1, "model": body["model"]}
                tokens = {"prompt_tokens": 1000, "completion_tokens": 20, "total_tokens": 1020}
                message = {"role": "assistant", "content": text}
                stop = "stop"
                if function:
                    ident, name, args = function
                    message = {"role": "assistant", "content": None, "tool_calls": [{"id": ident, "type": "function",
                        "function": {"name": name, "arguments": json.dumps(args)}}]}
                    if parent.parallel and name == "read_logs":
                        message["tool_calls"].append({"id": "read-2", "type": "function", "function": {"name": "read_other", "arguments": "{}"}})
                    stop = "tool_calls"
                if not body.get("stream"):
                    self.send_json({**base, "object": "chat.completion", "choices": [{"index": 0, "message": message,
                        "finish_reason": stop, "logprobs": None}], "usage": tokens})
                    return

                def event(delta, finish=None, usage=None):
                    payload = {**base, "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
                    if usage:
                        payload["usage"] = usage
                    return ("data: " + json.dumps(payload) + "\n\n").encode()

                if function:
                    call = message["tool_calls"][0]
                    args = call["function"]["arguments"]
                    before = event({"role": "assistant", "tool_calls": [{"index": 0, **call, "function": {"name": call["function"]["name"], "arguments": args[:1]}}]})
                    after = event({"tool_calls": [{"index": 0, "function": {"arguments": args[1:]}}]})
                else:
                    before, after = event({"role": "assistant", "content": text[:3]}), event({"content": text[3:]})
                measured = not any(m.get("content") == "no_usage" for m in body["messages"])
                after += event({}, stop, tokens if measured else None) + b"data: [DONE]\n\n"
                self.stream(before, after, gate=function is None)

            def anthropic_response(self, body, function, text):
                content = [{"type": "text", "text": text}]
                stop = "end_turn"
                if function:
                    ident, name, args = function
                    content = [{"type": "tool_use", "id": ident, "name": name, "input": args}]
                    if parent.parallel and name == "read_logs":
                        content.append({"type": "tool_use", "id": "read-2", "name": "read_other", "input": {}})
                    stop = "tool_use"
                message = {"id": "msg-fixture", "type": "message", "role": "assistant", "model": body["model"], "content": content,
                    "stop_reason": stop, "stop_sequence": None, "usage": {"input_tokens": 1000, "output_tokens": 20}}
                if not body.get("stream"):
                    self.send_json(message)
                    return

                def event(kind, **fields):
                    return ("event: " + kind + "\ndata: " + json.dumps({"type": kind, **fields}) + "\n\n").encode()

                before = event("message_start", message={**message, "content": [], "stop_reason": None})
                if function:
                    before += event("content_block_start", index=0, content_block={**content[0], "input": {}})
                    args = json.dumps(content[0]["input"])
                    before += event("content_block_delta", index=0, delta={"type": "input_json_delta", "partial_json": args[:1]})
                    after = event("content_block_delta", index=0, delta={"type": "input_json_delta", "partial_json": args[1:]})
                else:
                    before += event("content_block_start", index=0, content_block={"type": "text", "text": ""})
                    before += event("content_block_delta", index=0, delta={"type": "text_delta", "text": text[:3]})
                    after = event("content_block_delta", index=0, delta={"type": "text_delta", "text": text[3:]})
                after += event("content_block_stop", index=0)
                after += event("message_delta", delta={"stop_reason": stop, "stop_sequence": None}, usage={"output_tokens": 20})
                after += event("message_stop")
                self.stream(before, after, gate=function is None)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=0.01), daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def model(self, protocol="openai", **kwargs):
        options = {"model": f"fixture-{protocol}-model", "model_info": MODEL_INFO, "api_key": "fixture-provider-key", "max_retries": 0, "temperature": 0.2, **kwargs}
        if protocol == "anthropic":
            return AnthropicChatCompletionClient(base_url=self.url, **options)
        return OpenAIChatCompletionClient(base_url=self.url + "/v1", **options)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.release.set()
        self.cancel_release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)


def history():
    return [SystemMessage(content="Preserve original instructions"), UserMessage(content="Read source", source="user"),
        AssistantMessage(content=[FunctionCall(id="read-1", name="read_logs", arguments="{}")], source="reader"),
        FunctionExecutionResultMessage(content=[FunctionExecutionResult(content=SOURCE, call_id="read-1", name="read_logs", is_error=False)])]


def source_rendering(call):
    body = call["body"]
    if call["path"].endswith("messages"):
        return next(p["content"] for m in body["messages"] if isinstance(m["content"], list)
                    for p in m["content"] if p.get("type") == "tool_result" and p["tool_use_id"] == "read-1")
    return next(m["content"] for m in body["messages"] if m.get("tool_call_id") == "read-1")


class NativeAutoGen(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        # The public application API runs without unittest's expensive debug
        # stack capture on every streamed native future. Keep the runtime's
        # normal 100 ms deadline; lifecycle/cancellation assertions stay explicit.
        asyncio.get_running_loop().set_debug(False)

    async def test_reports_protect_reordered_duplicate_and_late_override_results(self):
        reports = []
        with Provider() as server, EvidenceRuntime(endpoint=ENDPOINT, on_report=reports.append) as runtime:
            runtime.ready()
            client = with_caveman_model(server.model(), runtime=runtime, scope=Scope("autogen", "report-protection"))
            workbench = CavemanWorkbench(StaticStreamWorkbench([FunctionTool(read_logs, "Read source", strict=True)]), runtime=runtime, scope=client.scope)
            try:
                tools = await workbench.list_tools()
                original = history()
                for label, messages in (("before-call", [original[0], original[1], original[3], original[2]]),
                                        ("duplicate", [*original, copy.deepcopy(original[-1])])):
                    before = copy.deepcopy(messages)
                    start = len(runtime.plans)
                    await client.create(messages, tools=tools)
                    self.assertEqual(messages, before)
                    self.assertEqual(source_rendering(server.calls[-1]), SOURCE)
                    self.assertTrue(all(not plan.replacements for _, plan in runtime.plans[start:]), label)
                    self.assertEqual(reports[-1].status, "skipped")
                extra = {"extra_body": {}}
                optimize = runtime.optimize
                def mutate(**kwargs):
                    result = optimize(**kwargs)
                    self.assertTrue(result.replacements)
                    extra["extra_body"]["tool_choice"] = "none"
                    return result
                runtime.optimize = mutate
                await client.create(original, tools=tools, extra_create_args=extra)
                self.assertEqual(server.calls[-1]["body"]["tool_choice"], "none")
                self.assertEqual(source_rendering(server.calls[-1]), SOURCE)
                self.assertEqual((reports[-1].status, reports[-1].reason, reports[-1].replacement_count), ("skipped", "recovery_unavailable", 0))
                self.assertTrue(all(receipt["plan_id"] is None for receipt in runtime.receipts[-2:]))
                runtime.optimize = optimize
                pre_cancelled = CancellationToken()
                pre_cancelled.cancel()
                for streaming in (False, True):
                    with self.assertRaises(asyncio.CancelledError):
                        if streaming:
                            await anext(client.create_stream(original, cancellation_token=pre_cancelled))
                        else:
                            await client.create(original, cancellation_token=pre_cancelled)
                    self.assertEqual((reports[-1].status, reports[-1].reason), ("skipped", "cancelled"))
                self.assertEqual(len(reports), 5)
                self.assertEqual(len(server.calls), 3)
                self.assertEqual(server.errors, [])
            finally:
                await client.close()
                await workbench.stop()

    async def test_openai_anthropic_native_workbench_recovery_stream_off_and_outage(self):
        for protocol in ("openai", "anthropic"):
            for streaming in (False, True):
                for mode, endpoint in (("compress", ENDPOINT), ("off", ENDPOINT), ("compress", "http://127.0.0.1:1")):
                    with self.subTest(protocol=protocol, streaming=streaming, mode=mode, available=endpoint == ENDPOINT), Provider() as server, EvidenceRuntime(endpoint=endpoint, mode=mode) as runtime:
                        if endpoint == ENDPOINT and mode != "off":
                            runtime.ready()
                        tools = [read_logs]
                        options = dict(name="reader", model_client=server.model(protocol), tools=tools, max_tool_iterations=4,
                                       model_client_stream=streaming, reflect_on_tool_use=True, system_message="Original system instructions")
                        before = dict(options)
                        adapted = with_caveman_agent(options, runtime=runtime, scope=Scope("autogen", f"{protocol}-{streaming}-{mode}-{endpoint.rsplit(':',1)[-1]}"))
                        agent = AssistantAgent(**adapted)
                        events = []
                        if streaming:
                            async for event in agent.run_stream(task="Read logs and recover row 70"):
                                events.append(event)
                                if isinstance(event, ModelClientStreamingChunkEvent):
                                    self.assertFalse(server.release.is_set()) if not any(isinstance(e, ModelClientStreamingChunkEvent) for e in events[:-1]) else None
                                    server.release.set()
                            result = events[-1]
                        else:
                            result = await agent.run(task="Read logs and recover row 70")
                            events = result.messages
                        self.assertIsInstance(result, TaskResult)
                        self.assertIsInstance(result.messages[-1], TextMessage)
                        self.assertEqual(result.messages[-1].content, FACT)
                        self.assertEqual(options, before)
                        self.assertEqual(tools, [read_logs])
                        saved = await agent.save_state()
                        saved_results = [r for m in saved["llm_context"]["messages"] if m["type"] == "FunctionExecutionResultMessage" for r in m["content"]]
                        self.assertEqual(next(r["content"] for r in saved_results if r["name"] == "read_logs"), SOURCE)
                        optimized = mode == "compress" and endpoint == ENDPOINT
                        self.assertEqual(len(server.calls), 3 if optimized else 2, [(p.status, p.reason) for _, p in runtime.plans])
                        self.assertEqual(any(plan.status == "optimized" for _, plan in runtime.plans), optimized)
                        requests = [e for e in events if isinstance(e, ToolCallRequestEvent)]
                        executions = [e for e in events if isinstance(e, ToolCallExecutionEvent)]
                        self.assertEqual([e.content[0].name for e in requests], ["read_logs", "caveman_retrieve"] if optimized else ["read_logs"])
                        self.assertEqual([e.content[0].name for e in executions], [e.content[0].name for e in requests])
                        if optimized:
                            self.assertEqual(json.loads(executions[1].content[0].content)["text"], SOURCE)
                            self.assertNotIn(FACT, source_rendering(server.calls[1]))
                            self.assertTrue(all(c["body"]["tools"] == server.calls[0]["body"]["tools"] for c in server.calls))
                        else:
                            self.assertEqual(source_rendering(server.calls[-1]), SOURCE)
                        self.assertTrue(all(c["body"]["temperature"] == 0.2 for c in server.calls))
                        self.assertTrue(all("caveman" not in k.lower() for c in server.calls for k in c["headers"]))
                        for call in server.calls:
                            headers = {key.lower(): value for key, value in call["headers"].items()}
                            self.assertEqual(headers.get("x-api-key") if protocol == "anthropic" else headers.get("authorization"),
                                             "fixture-provider-key" if protocol == "anthropic" else "Bearer fixture-provider-key")
                        for _, plan in runtime.plans:
                            if plan.request:
                                sent = json.dumps(plan.request)
                                self.assertNotIn("fixture-provider-key", sent)
                                self.assertNotIn("Original system instructions", sent)
                        self.assertEqual(adapted["model_client"].actual_usage().prompt_tokens, len(server.calls) * 1000)
                        completed = [r for r in runtime.receipts if r["event_kind"] == "completed"]
                        if mode != "off":
                            self.assertEqual(len(completed), len(server.calls))
                            self.assertTrue(all(r["usage"]["complete"] for r in completed))
                        await adapted["model_client"].close()
                        if adapted.get("workbench"):
                            await adapted["workbench"].stop()
                        self.assertEqual(server.errors, [])

    async def test_model_only_fake_schema_forced_tools_typed_output_original_objects_and_errors(self):
        with Provider() as server, EvidenceRuntime(endpoint=ENDPOINT) as runtime:
            runtime.ready()
            original = server.model()
            client = with_caveman_model(original, runtime=runtime, scope=Scope("autogen", "direct"))
            self.assertIsInstance(client, ChatCompletionClient)
            messages, tools = history(), [FunctionTool(read_logs, "Read source", strict=True)]
            before = copy.deepcopy(messages)
            result = await client.create(messages, tools=tools, extra_create_args={"temperature": 0.6, "seed": 77})
            self.assertIsInstance(result, CreateResult)
            self.assertEqual(result.content, FACT)
            self.assertEqual(messages, before)
            self.assertEqual(source_rendering(server.calls[-1]), SOURCE)
            self.assertEqual(server.calls[-1]["body"]["seed"], 77)
            self.assertEqual(server.calls[-1]["body"]["temperature"], 0.6)
            self.assertTrue(any(plan.reason == "recovery_unavailable" for _, plan in runtime.plans))
            workbench = CavemanWorkbench(StaticStreamWorkbench(tools), runtime=runtime, scope=client.scope)
            registered = await workbench.list_tools()
            schema_copy = copy.deepcopy(dict(registered[-1]))
            await client.create(messages, tools=[*tools, schema_copy])
            self.assertEqual(source_rendering(server.calls[-1]), SOURCE, "a copied schema is not registration")
            for choice in ("none", tools[0]):
                await client.create(messages, tools=registered, tool_choice=choice)
                self.assertEqual(source_rendering(server.calls[-1]), SOURCE)
            typed = await client.create(messages, tools=registered, json_output=Answer)
            self.assertEqual(Answer.model_validate_json(typed.content), Answer(answer=42))
            self.assertEqual(source_rendering(server.calls[-1]), SOURCE)
            # Foreign runtime/session schemas cannot grant access to this model.
            other = CavemanWorkbench(StaticStreamWorkbench(tools), runtime=runtime, scope=Scope("autogen", "foreign"))
            await client.create(messages, tools=await other.list_tools())
            self.assertEqual(source_rendering(server.calls[-1]), SOURCE)
            duplicate = CavemanWorkbench(StaticStreamWorkbench([*tools, FunctionTool(collision, "Caller tool", name="caveman_retrieve")]), runtime=runtime, scope=client.scope)
            duplicated = await duplicate.list_tools()
            self.assertEqual(sum(t["name"] == "caveman_retrieve" for t in duplicated), 1)
            await client.create(messages, tools=duplicated)
            self.assertEqual(source_rendering(server.calls[-1]), SOURCE)
            foreign_result = await duplicate.call_tool("caveman_retrieve", {"handle": "caller"})
            self.assertEqual(foreign_result.to_text(), "application-owned")
            across_workbenches = CavemanWorkbench([StaticStreamWorkbench(tools), StaticStreamWorkbench([FunctionTool(collision, "Caller tool", name="caveman_retrieve")])], runtime=runtime, scope=client.scope)
            self.assertEqual(sum(t["name"] == "caveman_retrieve" for t in await across_workbenches.list_tools()), 1)
            self.assertFalse(across_workbenches.recovery_enabled)
            self.assertEqual((await across_workbenches.call_tool("caveman_retrieve", {"handle": "caller"})).to_text(), "application-owned")
            error_messages = [*messages[:-1], messages[-1].model_copy(update={"content": [messages[-1].content[0].model_copy(update={"is_error": True})]})]
            await client.create(error_messages, tools=registered)
            self.assertEqual(source_rendering(server.calls[-1]), SOURCE)
            self.assertEqual(error_messages[-1].content[0].is_error, True)
            with self.assertRaises(openai.InternalServerError):
                await client.create([UserMessage(content="fail", source="user")])
            self.assertEqual(sum(any(m.get("content") == "fail" for m in c["body"]["messages"]) for c in server.calls), 1)
            self.assertEqual(client.model_info, original.model_info)
            self.assertEqual(client.actual_usage(), original.actual_usage())
            self.assertEqual(client.total_usage(), original.total_usage())
            self.assertEqual(messages, before)
            await client.close()
            self.assertEqual(server.errors, [])

    async def test_native_token_helpers_and_component_workbench_configuration(self):
        with Provider() as server, EvidenceRuntime(endpoint=ENDPOINT) as runtime:
            native = server.model(model="gpt-4o")
            client = with_caveman_model(native, runtime=runtime, scope=Scope("autogen", "count"))
            messages = [UserMessage(content="Count this text", source="user")]
            tools = [FunctionTool(read_logs, "Read logs")]
            self.assertEqual(client.count_tokens(messages, tools=tools), native.count_tokens(messages, tools=tools))
            self.assertEqual(client.remaining_tokens(messages, tools=tools), native.remaining_tokens(messages, tools=tools))
            workbench = CavemanWorkbench([StaticStreamWorkbench(tools), StaticStreamWorkbench([])], runtime=runtime, scope=client.scope)
            config = workbench.dump_component()
            with component_runtimes({"default": runtime}) as loaded:
                restored = Workbench.load_component(config)
            self.assertIsInstance(restored, CavemanWorkbench)
            self.assertEqual(await restored.list_tools(), await workbench.list_tools())
            # AutoGen reconstructs FunctionTool source with exec. A second
            # dump cannot inspect that source, including without middleware.
            baseline = Workbench.load_component(config.config["workbench"][0])
            with self.assertRaisesRegex(OSError, "could not get source code"):
                baseline.dump_component()
            with self.assertRaisesRegex(OSError, "could not get source code"):
                restored.dump_component()
            self.assertEqual(loaded, [restored])
            loaded_tool_result = await restored.call_tool("read_logs", {})
            self.assertEqual(loaded_tool_result.to_text(), SOURCE)
            self.assertEqual(server.calls, [], "token helpers must not generate provider requests")
            await client.close()
            await restored.stop()

    async def test_native_parallel_tool_batch_progress_events_and_multiple_workbenches(self):
        for protocol in ("openai", "anthropic"):
            with self.subTest(protocol=protocol):
                await self.parallel_workbench_journey(protocol)

    async def parallel_workbench_journey(self, protocol):
        with Provider(parallel=True) as server, EvidenceRuntime(endpoint=ENDPOINT) as runtime:
            runtime.ready()
            source = StatefulWorkbench([ProgressTool()])
            second = StatefulWorkbench([FunctionTool(read_other, "Read other source")])
            native_workbenches = [source, second]
            original_options = dict(name="parallel_reader", model_client=server.model(protocol), workbench=native_workbenches, max_tool_iterations=4)
            options = with_caveman_agent(original_options, runtime=runtime, scope=Scope("autogen", f"parallel-tools-{protocol}"))
            workbench = options["workbench"]
            async with workbench:
                agent = AssistantAgent(**options)
                events = [event async for event in agent.run_stream(task="Read both sources and recover row 70")]
                self.assertEqual(events[-1].messages[-1].content, FACT)
                self.assertEqual(len(server.calls), 3)
                request = next(e for e in events if isinstance(e, ToolCallRequestEvent))
                self.assertEqual([call.id for call in request.content], ["read-1", "read-2"])
                self.assertTrue(any(isinstance(e, TextMessage) and e.content == "source ready" and e.source == "read_logs" for e in events))
                self.assertEqual(source.calls, [{"name": "read_logs", "arguments": {}, "call_id": "read-1"}])
                self.assertEqual(second.calls, [{"name": "read_other", "arguments": {}, "call_id": "read-2"}])
                optimized = next(plan for _, plan in runtime.plans if plan.replacements)
                self.assertEqual(len(optimized.replacements), 2)
                self.assertEqual(len({r["source_id"] for r in optimized.replacements}), 2)
                self.assertEqual(len({r["recovery_handle"] for r in optimized.replacements}), 2)
                self.assertEqual(sum(r["unique_original"] for r in optimized.replacements), 1)
                state = await workbench.save_state()
                before = copy.deepcopy(state)
                await workbench.reset()
                await workbench.load_state(state)
                self.assertEqual(state, before)
                self.assertEqual(await workbench.save_state(), state)
                self.assertEqual([source.starts, second.starts, source.resets, second.resets], [1, 1, 1, 1])
                saved = await agent.save_state()
                originals = [r for m in saved["llm_context"]["messages"] if m["type"] == "FunctionExecutionResultMessage" for r in m["content"] if r["name"] in ("read_logs", "read_other")]
                self.assertEqual([r["content"] for r in originals], [SOURCE, SOURCE])
            self.assertEqual([source.stops, second.stops], [1, 1])
            self.assertIs(original_options["workbench"], native_workbenches)
            self.assertEqual(native_workbenches, [source, second])
            await options["model_client"].close()
            self.assertEqual(server.errors, [])

    async def test_native_stream_final_result_missing_usage_and_early_close(self):
        with Provider() as server, EvidenceRuntime(endpoint=ENDPOINT) as runtime:
            transport = CaptureHTTPClient()
            original = server.model(http_client=transport)
            client = with_caveman_model(original, runtime=runtime, scope=Scope("autogen", "stream-values"))
            messages = [UserMessage(content="plain", source="user")]
            stream = client.create_stream(messages)
            self.assertEqual(await anext(stream), "nat")
            self.assertFalse(server.release.is_set())
            server.release.set()
            tail = [event async for event in stream]
            self.assertEqual(tail[0], "ive")
            self.assertIsInstance(tail[-1], CreateResult)
            self.assertEqual(tail[-1].content, "native")
            self.assertEqual(tail[-1].usage.prompt_tokens, 1000)
            self.assertTrue(runtime.receipts[-1]["usage"]["complete"])
            without_usage = [event async for event in client.create_stream([UserMessage(content="no_usage", source="user")])]
            self.assertIsInstance(without_usage[-1], CreateResult)
            self.assertEqual(without_usage[-1].usage.prompt_tokens, 0, "preserve AutoGen's native missing-usage default")
            self.assertIsNone(runtime.receipts[-1]["usage"], "do not publish native zero defaults as measured usage")
            early = client.create_stream(messages)
            await anext(early)
            await early.aclose()
            self.assertIsNone(early.ag_frame)
            self.assertEqual(runtime.receipts[-1]["event_kind"], "cancelled")
            await client.close()
            self.assertTrue(transport.is_closed)
            self.assertEqual(server.errors, [])

    async def test_native_multiagent_scopes_component_config_restart_and_twenty_turn_prefix(self):
        with Provider() as server, EvidenceRuntime(endpoint=ENDPOINT, token=None) as runtime:
            runtime.ready()
            options = [with_caveman_agent(dict(name=name, model_client=server.model(), tools=[read_logs], max_tool_iterations=4),
                runtime=runtime, scope=Scope("autogen-team", name)) for name in ("reader_a", "reader_b")]
            agents = [AssistantAgent(**o) for o in options]
            results = await asyncio.gather(*(a.run(task="Read logs and recover row 70") for a in agents))
            self.assertEqual([r.messages[-1].content for r in results], [FACT, FACT])
            compressed = [source_rendering(c) for c in server.calls if any(m.get("role") == "tool" and m.get("tool_call_id") == "read-1" for m in c["body"]["messages"])]
            self.assertEqual(len(set(compressed)), 2, "separate agents must hold separate scoped grants")
            saved = await agents[0].save_state()
            config = agents[0].dump_component()
            encoded = config.model_dump_json()
            self.assertNotIn("recovery_binding", encoded)
            self.assertNotIn("cmw_", encoded)
            with self.assertRaisesRegex(ValueError, "Bind runtime"):
                AssistantAgent.load_component(config)
            with component_runtimes({"default": runtime}) as loaded_components:
                loaded = AssistantAgent.load_component(config)
            await loaded.load_state(saved)
            print(json.dumps({"caveman_control": "restart"}), flush=True)
            self.assertEqual(input().strip(), "runtime-ready")
            frozen = None
            for i in range(20):
                again = await loaded.run(task=f"Repeat recovered row, turn {i}")
                self.assertEqual(again.messages[-1].content, FACT)
                rendering = source_rendering(server.calls[-1])
                self.assertIn(rendering, compressed)
                if frozen is not None:
                    self.assertEqual(rendering, frozen)
                frozen = rendering
            retained = await loaded.save_state()
            source = next(r for m in retained["llm_context"]["messages"] if m["type"] == "FunctionExecutionResultMessage" for r in m["content"] if r["name"] == "read_logs")
            self.assertEqual(source["content"], SOURCE)
            # This is the native team scheduler. Its propagated peer context and
            # agent sources remain intact under the same model delegates.
            team = RoundRobinGroupChat(agents, max_turns=2)
            team_result = await team.run(task="Repeat the recovered fact in each agent")
            self.assertEqual([m.source for m in team_result.messages[-2:]], ["reader_a", "reader_b"])
            self.assertEqual([m.content for m in team_result.messages[-2:]], [FACT, FACT])
            for o in options:
                await o["model_client"].close()
                await o["workbench"].stop()
            restored = next(c for c in loaded_components if isinstance(c, ChatCompletionClient))
            self.assertEqual(restored.model_client.dump_component(), options[0]["model_client"].model_client.dump_component())
            for component in loaded_components:
                if isinstance(component, ChatCompletionClient):
                    await component.close()
                else:
                    await component.stop()
            self.assertEqual(server.errors, [])

    async def test_native_cancellation_before_dispatch_during_stream_and_client_close(self):
        with Provider() as server, EvidenceRuntime(endpoint=ENDPOINT) as runtime:
            transport = CaptureHTTPClient()
            original = server.model(http_client=transport)
            client = with_caveman_model(original, runtime=runtime, scope=Scope("autogen", "cancel"))
            token = CancellationToken()
            token.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await client.create(history(), cancellation_token=token)
            with self.assertRaises(asyncio.CancelledError):
                await anext(client.create_stream(history(), cancellation_token=token))
            self.assertEqual(server.calls, [])
            cancellation = CancellationToken()
            pending = asyncio.create_task(client.create([UserMessage(content="cancel", source="user")], cancellation_token=cancellation))
            self.assertTrue(await asyncio.to_thread(server.cancel_entered.wait, 2))
            cancellation.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await pending
            server.cancel_release.set()
            self.assertEqual(len(server.calls), 1)
            cancellation = CancellationToken()
            stream = client.create_stream([UserMessage(content="plain", source="user")], cancellation_token=cancellation)
            first = await asyncio.wait_for(anext(stream), 2)
            self.assertEqual(first, "nat")
            self.assertFalse(server.release.is_set())
            pending = asyncio.create_task(anext(stream))
            await asyncio.sleep(0)
            cancellation.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await pending
            await stream.aclose()
            self.assertIsNone(stream.ag_frame)
            server.release.set()
            self.assertEqual(len(server.calls), 2)
            self.assertFalse(any(r["event_kind"] == "completed" for r in runtime.receipts))
            await client.close()
            self.assertTrue(transport.is_closed)
            self.assertEqual(server.errors, [])

    async def test_native_cancellation_during_real_runtime_optimization_never_dispatches(self):
        entered, release = threading.Event(), threading.Event()

        class PausedRuntime(EvidenceRuntime):
            def optimize(self, **options):
                entered.set()
                release.wait(1)
                return super().optimize(**options)

        with Provider() as server, PausedRuntime(endpoint=ENDPOINT) as runtime:
            runtime.ready()
            client = with_caveman_model(server.model(), runtime=runtime, scope=Scope("autogen", "cancel-optimize"))
            token = CancellationToken()
            pending = asyncio.create_task(client.create(history(), cancellation_token=token))
            self.assertTrue(await asyncio.to_thread(entered.wait, 1))
            try:
                token.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await pending
                self.assertEqual(server.calls, [], "cancelled optimization cannot fall back into inference")
            finally:
                release.set()
                await client.close()


class NativeAutoGenCertification(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        asyncio.get_running_loop().set_debug(False)

    async def test_openai_exact_operation_journeys(self):
        from _certification_native import certify_cells
        await certify_cells(self, "openai")

    async def test_anthropic_exact_operation_journeys(self):
        from _certification_native import certify_cells
        await certify_cells(self, "anthropic")


if __name__ == "__main__":
    from _test_result import ReportingResult
    warnings.filterwarnings("ignore", message="Resolved model mismatch.*")
    unittest.main(verbosity=2, testRunner=unittest.TextTestRunner(resultclass=ReportingResult, verbosity=2))
