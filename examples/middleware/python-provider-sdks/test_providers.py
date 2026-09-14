"""Real pinned SDKs, real Go compression service, native local provider seams."""
import asyncio
import copy
import json
import os
import re
import unittest

import anthropic
import httpx2
import openai
from pydantic import BaseModel
from anthropic.lib.tools import BetaBuiltinFunctionTool, BetaAsyncBuiltinFunctionTool, BetaToolRunner, BetaAsyncToolRunner
from caveman_cloud.middleware import MiddlewareRuntime, AsyncMiddlewareRuntime, Scope
from caveman_middleware.anthropic import with_caveman_anthropic
from caveman_middleware.openai import with_caveman_openai

SOURCE = "".join(f"[INFO] café 🌍 row {i} retained-detail-{i} long repeated diagnostic\r\n" for i in range(140))
ENDPOINT = os.environ["CAVEMAN_MIDDLEWARE_ENDPOINT"]


class SourceTool(BetaBuiltinFunctionTool):
    def to_dict(self):
        return {"name": "read_logs", "description": "Read logs", "input_schema": {"type": "object", "properties": {}}}
    def call(self, input):
        return SOURCE


class AsyncSourceTool(BetaAsyncBuiltinFunctionTool):
    def to_dict(self):
        return SourceTool().to_dict()
    async def call(self, input):
        return SOURCE


class AnthropicFixture:
    def __init__(self):
        self.calls = []
        self.finished = False
        self.released = False

    def response(self, request):
        body = json.loads(request.content)
        self.calls.append((request, body))
        if request.url.path.endswith("count_tokens"):
            return httpx2.Response(200, json={"input_tokens": 7})
        results = [p for m in body["messages"] if isinstance(m["content"], list) for p in m["content"] if p["type"] == "tool_result"]
        source = next((p for p in results if p["tool_use_id"] == "read-1"), None)
        stop = "end_turn"
        if body["model"] == "helpers":
            content = [{"type": "text", "text": "native"}]
        elif source is None:
            content = [{"type": "tool_use", "id": "read-1", "name": "read_logs", "input": {}}]
            stop = "tool_use"
        else:
            handle = re.search(r"cmw_[a-f0-9]{48}", source["content"])
            assert handle, "native Python source tool result was not compressed"
            assert "retained-detail-70" not in source["content"]
            recovered = next((p for p in results if p["tool_use_id"] == "recover-1"), None)
            if recovered is None:
                content = [{"type": "tool_use", "id": "recover-1", "name": "caveman_retrieve", "input": {"handle": handle[0]}}]
                stop = "tool_use"
            else:
                assert json.loads(recovered["content"])["text"] == SOURCE
                content = [{"type": "text", "text": "retained-detail-70"}]
        message = {"id": "msg-fixture", "type": "message", "role": "assistant", "model": "fixture-model", "content": content,
                   "stop_reason": stop, "stop_sequence": None, "usage": {"input_tokens": 1000, "output_tokens": 20, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 0}}
        if not body.get("stream"):
            return httpx2.Response(200, json=message, headers={"request-id": "fixture-anthropic"})
        def event(kind, **fields):
            return ("event: " + kind + "\ndata: " + json.dumps({"type": kind, **fields}) + "\n\n").encode()
        fixture = self
        class Bytes(httpx2.SyncByteStream):
            def __iter__(self):
                yield event("message_start", message={**message, "content": [], "stop_reason": None})
                part = content[0]
                if part["type"] == "tool_use":
                    yield event("content_block_start", index=0, content_block={**part, "input": {}})
                    yield event("content_block_delta", index=0, delta={"type": "input_json_delta", "partial_json": json.dumps(part["input"])})
                else:
                    yield event("content_block_start", index=0, content_block={"type": "text", "text": ""})
                    yield event("content_block_delta", index=0, delta={"type": "text_delta", "text": "retained-"})
                    assert fixture.released, "native stream buffered beyond consumer demand"
                    fixture.finished = True
                    yield event("content_block_delta", index=0, delta={"type": "text_delta", "text": "detail-70"})
                yield event("content_block_stop", index=0)
                yield event("message_delta", delta={"stop_reason": stop, "stop_sequence": None}, usage={"output_tokens": 20})
                yield event("message_stop")
        return httpx2.Response(200, stream=Bytes(), headers={"content-type": "text/event-stream"})

    async def async_response(self, request):
        response = self.response(request)
        if response.is_stream_consumed:
            return response
        sync_stream = response.stream
        class Bytes(httpx2.AsyncByteStream):
            async def __aiter__(self):
                for chunk in sync_stream:
                    await asyncio.sleep(0)
                    yield chunk
            async def aclose(self):
                sync_stream.close()
        response.stream = Bytes()
        return response


class OpenAIFixture:
    def __init__(self):
        self.calls, self.closed, self.released = [], False, False

    def response(self, request):
        body = json.loads(request.content)
        self.calls.append((request, body))
        if body.get("model") == "failure":
            return httpx2.Response(500, json={"error": {"message": "native failure", "type": "server_error"}})
        if request.url.path.endswith("responses"):
            return httpx2.Response(200, json={"id": "resp-fixture", "object": "response", "created_at": 1, "status": "completed", "model": "fixture-model", "output": [], "usage": {"input_tokens": 10, "output_tokens": 2, "total_tokens": 12}})
        content = '{"answer":42}' if body["model"] == "parse" else "native"
        completion = {"id": "chatcmpl-fixture", "object": "chat.completion", "created": 1, "model": "fixture-model", "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop", "logprobs": None}],
                      "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12}}
        if not body.get("stream"):
            return httpx2.Response(200, json=completion, headers={"x-request-id": "fixture-openai"})
        fixture = self
        class Bytes(httpx2.SyncByteStream):
            def __iter__(self):
                chunk = {"id": "chatcmpl-fixture", "object": "chat.completion.chunk", "created": 1, "model": "fixture-model"}
                yield ("data: " + json.dumps({**chunk, "choices": [{"index": 0, "delta": {"role": "assistant", "content": "nat"}, "finish_reason": None}]}) + "\n\n").encode()
                assert fixture.released, "OpenAI stream consumed beyond demand"
                yield ("data: " + json.dumps({**chunk, "choices": [{"index": 0, "delta": {"content": "ive"}, "finish_reason": "stop"}], "usage": completion["usage"]}) + "\n\n").encode()
                yield b"data: [DONE]\n\n"
            def close(self):
                fixture.closed = True
        return httpx2.Response(200, stream=Bytes(), headers={"content-type": "text/event-stream"})

    async def async_response(self, request):
        response = self.response(request)
        if response.is_stream_consumed:
            return response
        original = response.stream
        class Bytes(httpx2.AsyncByteStream):
            async def __aiter__(self):
                for chunk in original:
                    await asyncio.sleep(0)
                    yield chunk
            async def aclose(self):
                original.close()
        response.stream = Bytes()
        return response


def openai_history():
    return [{"role": "user", "content": "Read source"}, {"role": "assistant", "content": None, "tool_calls": [{"id": "read-1", "type": "function", "function": {"name": "read_logs", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "read-1", "content": SOURCE}]


class Answer(BaseModel):
    answer: int


class ProviderConformance(unittest.TestCase):
    def test_openai_sync_native_helpers_original_view_and_stream(self):
        fixture = OpenAIFixture()
        with MiddlewareRuntime(endpoint=ENDPOINT) as runtime, httpx2.Client(transport=httpx2.MockTransport(fixture.response)) as transport:
            runtime.ready()
            original = openai.OpenAI(api_key="fixture", base_url="http://provider.local/v1", max_retries=0, http_client=transport)
            native = with_caveman_openai(original, runtime=runtime, scope=Scope("python", "openai-sync"))
            self.assertIsInstance(native, openai.OpenAI)
            self.assertIsNot(native, original)
            messages = openai_history()
            before = copy.deepcopy(messages)
            result = native.chat.completions.create(model="helpers", messages=messages, extra_headers={"x-custom": "kept"})
            self.assertIsInstance(result, openai.types.chat.ChatCompletion)
            self.assertEqual(fixture.calls[0][1]["messages"], before, "no executor means no lossy transformation")
            self.assertEqual(fixture.calls[0][0].headers["x-custom"], "kept")
            self.assertEqual(messages, before)
            raw = native.chat.completions.with_raw_response.create(model="helpers", messages=messages)
            self.assertEqual(raw.headers["x-request-id"], "fixture-openai")
            self.assertIsInstance(raw.parse(), openai.types.chat.ChatCompletion)
            parsed = native.chat.completions.parse(model="parse", messages=messages, response_format=Answer)
            self.assertEqual(parsed.choices[0].message.parsed, Answer(answer=42))
            with native.chat.completions.stream(model="helpers", messages=messages) as stream:
                text = ""
                for event in stream:
                    if event.type == "content.delta":
                        fixture.released = True
                        text += event.delta
                self.assertEqual(stream.get_final_completion().choices[0].message.content, "native")
                self.assertEqual(text, "native")
            self.assertTrue(fixture.closed)
            inputs = [{"type": "function_call_output", "call_id": "hidden-call", "output": SOURCE}]
            native.responses.create(model="helpers", previous_response_id="opaque-history", input=inputs)
            self.assertEqual(fixture.calls[-1][1]["input"], inputs)
            with self.assertRaises(openai.InternalServerError):
                native.chat.completions.create(model="failure", messages=messages)
            self.assertEqual(sum(b["model"] == "failure" for _, b in fixture.calls), 1)

    def test_anthropic_sync_native_loop_helpers_stream(self):
        fixture = AnthropicFixture()
        with MiddlewareRuntime(endpoint=ENDPOINT) as runtime, httpx2.Client(transport=httpx2.MockTransport(fixture.response)) as transport:
            runtime.ready()
            original = anthropic.Anthropic(api_key="fixture", base_url="http://provider.local", max_retries=0, http_client=transport)
            native = with_caveman_anthropic(original, runtime=runtime, scope=Scope("python", "anthropic-sync"))
            self.assertIsInstance(native, anthropic.Anthropic)
            messages = [{"role": "user", "content": "Read and recover logs"}]
            before = copy.deepcopy(messages)
            tools = [SourceTool()]
            params = dict(model="fixture-model", messages=messages, tools=tools, max_tokens=100, max_iterations=5, system=[{"type": "text", "text": "original system", "cache_control": {"type": "ephemeral"}}])
            runner = native.beta.messages.tool_runner(**params)
            self.assertIsInstance(runner, BetaToolRunner)
            self.assertEqual(len(fixture.calls), 0)
            self.assertEqual(runner.until_done().content[0].text, "retained-detail-70")
            self.assertEqual(messages, before)
            self.assertEqual(len(tools), 1)
            self.assertEqual(fixture.calls[1][1]["system"], params["system"])
            for _, body in fixture.calls:
                self.assertEqual(body["tools"], fixture.calls[0][1]["tools"])
            raw = native.messages.with_raw_response.create(model="helpers", max_tokens=10, messages=messages)
            self.assertEqual(raw.headers["request-id"], "fixture-anthropic")
            self.assertIsInstance(raw.parse(), anthropic.types.Message)
            self.assertEqual(native.messages.count_tokens(model="helpers", messages=messages).input_tokens, 7)
            streamed = with_caveman_anthropic(original, runtime=runtime, scope=Scope("python", "anthropic-sync-stream")).beta.messages.tool_runner(**params, stream=True)
            text = ""
            for stream in streamed:
                for chunk in stream.text_stream:
                    if not text:
                        self.assertFalse(fixture.finished)
                        fixture.released = True
                    text += chunk
                stream.get_final_message()
            self.assertEqual(text, "retained-detail-70")


class AsyncProviderConformance(unittest.IsolatedAsyncioTestCase):
    async def test_openai_async_native_helpers_stream_close_and_cancellation(self):
        fixture = OpenAIFixture()
        async with AsyncMiddlewareRuntime(endpoint=ENDPOINT) as runtime, httpx2.AsyncClient(transport=httpx2.MockTransport(fixture.async_response)) as transport:
            await runtime.ready()
            original = openai.AsyncOpenAI(api_key="fixture", base_url="http://provider.local/v1", max_retries=0, http_client=transport)
            native = with_caveman_openai(original, runtime=runtime, scope=Scope("python", "openai-async"))
            messages = openai_history()
            result = await native.chat.completions.parse(model="parse", messages=messages, response_format=Answer)
            self.assertEqual(result.choices[0].message.parsed, Answer(answer=42))
            raw = await native.chat.completions.with_raw_response.create(model="helpers", messages=messages)
            self.assertIsInstance(raw.parse(), openai.types.chat.ChatCompletion)
            async with native.chat.completions.stream(model="helpers", messages=messages) as stream:
                text = ""
                async for event in stream:
                    if event.type == "content.delta":
                        fixture.released = True
                        text += event.delta
                self.assertEqual((await stream.get_final_completion()).choices[0].message.content, text)
            fixture.closed = False
            early = await native.chat.completions.create(model="helpers", messages=messages, stream=True)
            await anext(early)
            await early.close()
            self.assertTrue(fixture.closed)
            self.assertEqual((await native.responses.create(model="helpers", input="native input")).id, "resp-fixture")
        entered = asyncio.Event()
        calls = []
        async def hanging(request):
            calls.append(request)
            entered.set()
            await asyncio.Future()
        async with AsyncMiddlewareRuntime(endpoint=ENDPOINT) as runtime, httpx2.AsyncClient(transport=httpx2.MockTransport(hanging)) as transport:
            native = with_caveman_openai(openai.AsyncOpenAI(api_key="fixture", base_url="http://provider.local/v1", max_retries=0, http_client=transport), runtime=runtime, scope=Scope("python", "openai-cancel"))
            pending = asyncio.create_task(native.chat.completions.create(model="helpers", messages=openai_history()))
            await entered.wait()
            pending.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await pending
            self.assertEqual(len(calls), 1, "cancellation cannot become a fresh model request")

    async def test_anthropic_async_native_loop_stream(self):
        fixture = AnthropicFixture()
        async with AsyncMiddlewareRuntime(endpoint=ENDPOINT) as runtime, httpx2.AsyncClient(transport=httpx2.MockTransport(fixture.async_response)) as transport:
            await runtime.ready()
            original = anthropic.AsyncAnthropic(api_key="fixture", base_url="http://provider.local", max_retries=0, http_client=transport)
            native = with_caveman_anthropic(original, runtime=runtime, scope=Scope("python", "anthropic-async"))
            messages = [{"role": "user", "content": "Read and recover logs"}]
            params = dict(model="fixture-model", messages=messages, tools=[AsyncSourceTool()], max_tokens=100, max_iterations=5)
            runner = native.beta.messages.tool_runner(**params)
            self.assertIsInstance(runner, BetaAsyncToolRunner)
            self.assertEqual((await runner.until_done()).content[0].text, "retained-detail-70")
            streamed = with_caveman_anthropic(original, runtime=runtime, scope=Scope("python", "anthropic-async-stream")).beta.messages.tool_runner(**params, stream=True)
            text = ""
            async for stream in streamed:
                async for chunk in stream.text_stream:
                    if not text:
                        self.assertFalse(fixture.finished)
                        fixture.released = True
                    text += chunk
                await stream.get_final_message()
            self.assertEqual(text, "retained-detail-70")


class ProviderJourney(unittest.IsolatedAsyncioTestCase):
    async def test_openai_f01_sync_executable_journeys(self):
        from _certification_native import certify_cells
        await certify_cells(self, "F01", "sync")

    async def test_openai_f01_async_executable_journeys(self):
        from _certification_native import certify_cells
        await certify_cells(self, "F01", "async")

    async def test_anthropic_f02_sync_executable_journeys(self):
        from _certification_native import certify_cells
        await certify_cells(self, "F02", "sync")

    async def test_anthropic_f02_async_executable_journeys(self):
        from _certification_native import certify_cells
        await certify_cells(self, "F02", "async")


if __name__ == "__main__":
    from _test_result import ReportingResult
    unittest.main(verbosity=2, testRunner=unittest.TextTestRunner(verbosity=2, resultclass=ReportingResult))
