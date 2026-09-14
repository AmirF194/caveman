"""Pinned Google SDK AFC loops against local HTTP and the real Go runtime."""
import asyncio
import copy
import json
import os
import re
import unittest

import httpx
import httpx2
from google.oauth2.credentials import Credentials
from google import genai
from google.genai import types
from google.genai.chats import Chat, AsyncChat
from caveman_cloud.middleware import Scope
from caveman_middleware.google import CavemanGoogleTransport, CavemanGoogleAsyncTransport, with_caveman_google, with_caveman_google_chat
from evidence_runtime import EvidenceRuntime
from python_fixture import ProviderServer
from example import answer_from_logs

SOURCE = "".join(f"[INFO] café 🌍 row {i} retained-detail-{i} verbose repeated diagnostic data\r\n" for i in range(160))
ENDPOINT = os.environ["CAVEMAN_MIDDLEWARE_ENDPOINT"]


def read_logs() -> str:
    """Read diagnostic logs."""
    return SOURCE


def values(body):
    return [part["functionResponse"] for content in body["contents"] for part in content.get("parts", []) if "functionResponse" in part]


class GoogleFixture:
    def __init__(self):
        self.calls, self.released, self.closed = [], False, False

    def response(self, request):
        body = json.loads(request.content)
        self.calls.append((request, body))
        if "failure" in str(request.url):
            return httpx2.Response(503, json={"error": {"code": 503, "status": "UNAVAILABLE", "message": "native fixture failure"}})
        results = values(body)
        read = next((value for value in results if value["name"] == "read_logs"), None)
        if "helpers" in str(request.url):
            parts = [{"text": "native"}]
        elif read is None:
            parts = [{"functionCall": {"name": "read_logs", "args": {}}, "thoughtSignature": "c2lnbmF0dXJl"}]
        elif "baseline" in str(request.url):
            assert read["response"]["result"] == SOURCE
            parts = [{"text": "retained-detail-80"}]
        else:
            shortened = read["response"]["result"]
            handle = re.search(r"cmw_[a-f0-9]{48}", shortened)
            assert handle, "native Google AFC source was not compressed"
            assert "retained-detail-80" not in shortened
            recovered = next((value for value in results if value["name"] == "caveman_retrieve"), None)
            if recovered is None:
                parts = [{"functionCall": {"name": "caveman_retrieve", "args": {"handle": handle[0]}}}]
            else:
                assert recovered["response"]["result"]["text"] == SOURCE
                parts = [{"text": "retained-detail-80"}]

        def response(parts, terminal=True):
            return {"candidates": [{"content": {"role": "model", "parts": parts}, **({"finishReason": "STOP"} if terminal else {}), "index": 0}],
                    **({"usageMetadata": {"promptTokenCount": 1000, "candidatesTokenCount": 20, "cachedContentTokenCount": 200, "thoughtsTokenCount": 3}} if terminal else {}), "responseId": "google-native-fixture"}

        if "streamGenerateContent" not in str(request.url):
            return httpx2.Response(200, json=response(parts), headers={"x-fixture": "google-native"})
        fixture = self
        class Bytes(httpx2.SyncByteStream):
            def __iter__(self):
                if "text" in parts[0] and "baseline" not in str(request.url):
                    yield ("data: " + json.dumps(response([{"text": "retained-"}], False)) + "\n\n").encode()
                    assert fixture.released, "Google buffered beyond first chunk before the caller released completion"
                yield ("data: " + json.dumps(response(parts)) + "\n\n").encode()
            def close(self):
                fixture.closed = True
        return httpx2.Response(200, stream=Bytes(), headers={"content-type": "text/event-stream"})


def native_client(server, runtime, scope):
    sync = httpx.Client(transport=CavemanGoogleTransport(runtime=runtime, scope=scope, provider_base_url=server.url))
    asynchronous = httpx.AsyncClient(transport=CavemanGoogleAsyncTransport(runtime=runtime, scope=scope, provider_base_url=server.url))
    client = genai.Client(api_key="local-google-token", http_options=types.HttpOptions(base_url=server.url, retry_options=types.HttpRetryOptions(attempts=1), httpx_client=sync, httpx_async_client=asynchronous))
    return with_caveman_google(client, runtime=runtime, scope=scope), sync, asynchronous


def history_values(history):
    return values({"contents": [content.model_dump(mode="json", by_alias=True, exclude_none=True) for content in history]})


class GoogleSync(unittest.TestCase):
    def test_documented_example_preserves_options_and_closes_transport(self):
        with EvidenceRuntime(endpoint=ENDPOINT) as runtime:
            runtime.ready()
            fixture = GoogleFixture()
            closed = []
            class OriginalTransport(httpx.HTTPTransport):
                def close(self):
                    closed.append(True)
                    super().close()
            with ProviderServer(fixture) as server:
                transport = OriginalTransport()
                options = {
                    "api_key": "local-google-token",
                    "http_options": types.HttpOptions(
                        base_url=server.url,
                        retry_options=types.HttpRetryOptions(attempts=1),
                        headers={"x-existing-client": "preserved"},
                        client_args={"transport": transport, "timeout": 10},
                    ),
                }
                result = answer_from_logs(native_options=options, provider_base_url=server.url, runtime=runtime,
                                          scope=Scope("google-python", "documented-example"), model="fixture-model",
                                          source=SOURCE, question="Find retained-detail-80.")
                self.assertIsInstance(result, types.GenerateContentResponse)
                self.assertEqual(result.text, "retained-detail-80")
                self.assertEqual(len(fixture.calls), 3)
                self.assertTrue(all(request.headers["x-existing-client"] == "preserved" for request, _ in fixture.calls))
                self.assertIs(options["http_options"].client_args["transport"], transport)
                self.assertIsNone(options["http_options"].httpx_client)
                self.assertTrue(closed)
                self.assertEqual(server.errors, [])

    def test_generate_chat_and_stream_journeys(self):
        for operation in ("generate", "stream", "chat", "chat-stream"):
            with self.subTest(operation=operation), EvidenceRuntime(endpoint=ENDPOINT) as runtime:
                runtime.ready()
                fixture = GoogleFixture()
                with ProviderServer(fixture) as server:
                    scope = Scope("google-python", operation)
                    client, http, ahttp = native_client(server, runtime, scope)
                    try:
                        config = types.GenerateContentConfig(tools=[read_logs], temperature=0.2, system_instruction="Read exact logs.", safety_settings=[types.SafetySetting(category="HARM_CATEGORY_HATE_SPEECH", threshold="BLOCK_ONLY_HIGH")])
                        contents = [types.Content(role="user", parts=[types.Part(text="Find retained-detail-80.")])]
                        before = copy.deepcopy(contents)
                        chat = with_caveman_google_chat(client.chats.create(model="fixture-model", config=config), runtime=runtime, scope=scope, config=config) if operation.startswith("chat") else None
                        if chat:
                            self.assertIsInstance(chat, Chat)
                        if operation.endswith("stream") or operation == "stream":
                            stream = chat.send_message_stream("Find retained-detail-80.") if chat else client.models.generate_content_stream(model="fixture-model", contents=contents, config=config)
                            events = []
                            for event in stream:
                                self.assertIsInstance(event, types.GenerateContentResponse)
                                events.append(event)
                                if event.candidates and event.candidates[0].content.parts[0].text == "retained-":
                                    self.assertFalse(fixture.released)
                                    fixture.released = True
                            self.assertEqual(events[-1].text, "retained-detail-80")
                        else:
                            result = chat.send_message("Find retained-detail-80.") if chat else client.models.generate_content(model="fixture-model", contents=contents, config=config)
                            self.assertIsInstance(result, types.GenerateContentResponse)
                            self.assertEqual(result.text, "retained-detail-80")
                            self.assertEqual(result.usage_metadata.thoughts_token_count, 3)
                            if not chat:
                                self.assertEqual(next(value for value in history_values(result.automatic_function_calling_history) if value["name"] == "read_logs")["response"]["result"], SOURCE)
                        self.assertEqual(contents, before)
                        self.assertEqual(config.tools, [read_logs])
                        self.assertEqual(len(fixture.calls), 3)
                        self.assertEqual(server.errors, [])
                        self.assertEqual(fixture.calls[1][1]["contents"][1]["parts"][0]["thoughtSignature"], "c2lnbmF0dXJl")
                        self.assertEqual(fixture.calls[1][1]["tools"], fixture.calls[2][1]["tools"])
                        self.assertTrue(all(request.headers["x-goog-api-key"] == "local-google-token" for request, _ in fixture.calls))
                        self.assertEqual(sum(receipt["event_kind"] == "dispatch_intent" for receipt in runtime.receipts), 3)
                        self.assertEqual(sum(receipt["event_kind"] == "completed" for receipt in runtime.receipts), 3)
                        self.assertTrue(any(outcome.replacements for _, outcome in runtime.plans))
                        if chat:
                            self.assertEqual(next(value for value in history_values(chat.get_history()) if value["name"] == "read_logs")["response"]["result"], SOURCE)
                    finally:
                        client.close(); http.close(); asyncio.run(ahttp.aclose())

    def test_off_outage_and_native_failure(self):
        for mode in ("off", "outage"):
            with self.subTest(mode=mode), EvidenceRuntime(endpoint="http://127.0.0.1:1", mode="off" if mode == "off" else "compress") as runtime:
                fixture = GoogleFixture()
                with ProviderServer(fixture) as server:
                    client, http, ahttp = native_client(server, runtime, Scope("google-python", mode))
                    try:
                        for operation in ("generate", "stream", "chat", "chat-stream"):
                            config = {"tools": [read_logs]}
                            chat = with_caveman_google_chat(client.chats.create(model="baseline", config=config), runtime=runtime, scope=Scope("google-python", mode), config=config)
                            if operation.endswith("stream"):
                                stream = chat.send_message_stream("Read logs.") if operation.startswith("chat") else client.models.generate_content_stream(model="baseline", contents="Read logs.", config=config)
                                result = list(stream)[-1]
                            else:
                                result = chat.send_message("Read logs.") if operation == "chat" else client.models.generate_content(model="baseline", contents="Read logs.", config=config)
                            self.assertEqual(result.text, "retained-detail-80")
                        self.assertEqual(len(fixture.calls), 8)
                        with self.assertRaises(genai.errors.ServerError):
                            client.models.generate_content(model="failure", contents="fail")
                        self.assertEqual(len(fixture.calls), 9)
                        self.assertEqual(server.errors, [])
                    finally:
                        client.close(); http.close(); asyncio.run(ahttp.aclose())

    def test_model_only_cached_media_unknown_and_structured_preserve_wire(self):
        with EvidenceRuntime(endpoint=ENDPOINT) as runtime:
            runtime.ready()
            fixture = GoogleFixture()
            with ProviderServer(fixture) as server:
                client, http, ahttp = native_client(server, runtime, Scope("google-python", "protected"))
                original = genai.Client(api_key="local-google-token", http_options={"base_url": server.url, "retry_options": {"attempts": 1}})
                contents = [types.Content(role="model", parts=[types.Part(function_call=types.FunctionCall(name="read_logs", args={}), thought_signature=b"signature")]), types.Content(role="user", parts=[types.Part.from_function_response(name="read_logs", response={"result": SOURCE}), types.Part.from_bytes(data=b"\x89PNG\r\n\x1a\n", mime_type="image/png"), types.Part.from_uri(file_uri="gs://fixture/audio.wav", mime_type="audio/wav")])]
                try:
                    for config in ({}, {"cached_content": "cachedContents/opaque"}, {"response_mime_type": "application/json", "response_json_schema": {"type": "object", "properties": {"answer": {"type": "string"}}}}, {"tools": [read_logs], "toolConfig": {"functionCallingConfig": {"mode": "ANY", "allowedFunctionNames": ["read_logs"]}}, "automaticFunctionCalling": {"disable": True}}, {"tools": [{"function_declarations": [{"name": "caveman_retrieve", "parameters_json_schema": {"type": "object", "properties": {"handle": {"type": "string"}}}}]}]}, {"http_options": {"extra_body": {"futureGoogleField": {"untouched": ["value", 7]}}}}):
                        original.models.generate_content(model="helpers", contents=contents, config=config)
                        baseline = fixture.calls[-1][0].content
                        result = client.models.generate_content(model="helpers", contents=contents, config=config)
                        self.assertIsInstance(result, types.GenerateContentResponse)
                        self.assertEqual(fixture.calls[-1][0].content, baseline)
                        self.assertEqual(values(fixture.calls[-1][1])[0]["response"]["result"], SOURCE)
                    self.assertEqual(server.errors, [])
                finally:
                    original.close(); client.close(); http.close(); asyncio.run(ahttp.aclose())

    def test_native_vertex_oauth_and_early_stream_close(self):
        with EvidenceRuntime(endpoint=ENDPOINT) as runtime:
            runtime.ready()
            fixture = GoogleFixture()
            with ProviderServer(fixture) as server:
                scope = Scope("google-python", "vertex-close")
                closed = []
                class ClosingTransport(httpx.HTTPTransport):
                    def handle_request(self, request):
                        response = super().handle_request(request)
                        original = response.stream
                        class Bytes(httpx.SyncByteStream):
                            def __iter__(self):
                                yield from original
                            def close(self):
                                closed.append(True)
                                original.close()
                        response.stream = Bytes()
                        return response
                http = httpx.Client(transport=CavemanGoogleTransport(runtime=runtime, scope=scope, provider_base_url=server.url, transport=ClosingTransport()))
                native_options = {"vertexai": True, "project": "fixture-project", "location": "europe-west4", "credentials": Credentials(token="local-fixture-oauth")}
                original = genai.Client(**native_options, http_options={"base_url": server.url, "retry_options": {"attempts": 1}})
                client = with_caveman_google(genai.Client(**native_options, http_options=types.HttpOptions(base_url=server.url, httpx_client=http, retry_options=types.HttpRetryOptions(attempts=1))), runtime=runtime, scope=scope)
                try:
                    original.models.generate_content(model="helpers", contents="Native Vertex auth seam.")
                    baseline = fixture.calls[-1][0]
                    result = client.models.generate_content(model="helpers", contents="Native Vertex auth seam.")
                    changed = fixture.calls[-1][0]
                    self.assertIsInstance(result, types.GenerateContentResponse)
                    self.assertEqual(changed.content, baseline.content)
                    self.assertEqual(str(changed.url), str(baseline.url))
                    self.assertEqual(changed.headers["authorization"], "Bearer local-fixture-oauth")
                    self.assertEqual(changed.headers["authorization"], baseline.headers["authorization"])
                    closed.clear()
                    stream = client.models.generate_content_stream(model="helpers", contents="Stream first chunk.")
                    self.assertEqual(next(stream).text, "retained-")
                    self.assertFalse(fixture.released)
                    stream.close()
                    self.assertTrue(closed)
                    self.assertEqual(runtime.receipts[-1]["event_kind"], "cancelled")
                    self.assertEqual(len(fixture.calls), 3)
                    fixture.released = True
                finally:
                    fixture.released = True
                    original.close(); client.close(); http.close()


class GoogleAsync(unittest.IsolatedAsyncioTestCase):
    async def test_generate_chat_and_stream_journeys(self):
        for operation in ("generate", "stream", "chat", "chat-stream"):
            with self.subTest(operation=operation), EvidenceRuntime(endpoint=ENDPOINT) as runtime:
                await runtime.as_async().ready()
                fixture = GoogleFixture()
                with ProviderServer(fixture) as server:
                    scope = Scope("google-python", "async-" + operation)
                    client, http, ahttp = native_client(server, runtime, scope)
                    try:
                        config = types.GenerateContentConfig(tools=[read_logs], system_instruction="Read exact logs.")
                        contents = [types.Content(role="user", parts=[types.Part(text="Find retained-detail-80.")])]
                        before = copy.deepcopy(contents)
                        chat = with_caveman_google_chat(client.aio.chats.create(model="fixture-model", config=config), runtime=runtime, scope=scope, config=config) if operation.startswith("chat") else None
                        if chat:
                            self.assertIsInstance(chat, AsyncChat)
                        if operation.endswith("stream") or operation == "stream":
                            stream = await chat.send_message_stream("Find retained-detail-80.") if chat else await client.aio.models.generate_content_stream(model="fixture-model", contents=contents, config=config)
                            events = []
                            async for event in stream:
                                self.assertIsInstance(event, types.GenerateContentResponse)
                                events.append(event)
                                if event.candidates and event.candidates[0].content.parts[0].text == "retained-":
                                    self.assertFalse(fixture.released)
                                    fixture.released = True
                            self.assertEqual(events[-1].text, "retained-detail-80")
                        else:
                            result = await chat.send_message("Find retained-detail-80.") if chat else await client.aio.models.generate_content(model="fixture-model", contents=contents, config=config)
                            self.assertIsInstance(result, types.GenerateContentResponse)
                            self.assertEqual(result.text, "retained-detail-80")
                        self.assertEqual(contents, before)
                        self.assertEqual(config.tools, [read_logs])
                        self.assertEqual(len(fixture.calls), 3)
                        self.assertEqual(server.errors, [])
                        self.assertEqual(sum(receipt["event_kind"] == "completed" for receipt in runtime.receipts), 3)
                        if chat:
                            self.assertEqual(next(value for value in history_values(chat.get_history()) if value["name"] == "read_logs")["response"]["result"], SOURCE)
                    finally:
                        await client.aio.aclose(); client.close(); http.close(); await ahttp.aclose()

    async def test_off_outage_all_native_methods(self):
        for mode in ("off", "outage"):
            with self.subTest(mode=mode), EvidenceRuntime(endpoint="http://127.0.0.1:1", mode="off" if mode == "off" else "compress") as runtime:
                fixture = GoogleFixture()
                with ProviderServer(fixture) as server:
                    scope = Scope("google-python", "async-" + mode)
                    client, http, ahttp = native_client(server, runtime, scope)
                    try:
                        for operation in ("generate", "stream", "chat", "chat-stream"):
                            config = {"tools": [read_logs]}
                            chat = with_caveman_google_chat(client.aio.chats.create(model="baseline", config=config), runtime=runtime, scope=scope, config=config)
                            if operation.endswith("stream"):
                                stream = await chat.send_message_stream("Read logs.") if operation.startswith("chat") else await client.aio.models.generate_content_stream(model="baseline", contents="Read logs.", config=config)
                                result = [event async for event in stream][-1]
                            else:
                                result = await chat.send_message("Read logs.") if operation == "chat" else await client.aio.models.generate_content(model="baseline", contents="Read logs.", config=config)
                            self.assertEqual(result.text, "retained-detail-80")
                        self.assertEqual(len(fixture.calls), 8)
                        with self.assertRaises(genai.errors.ServerError):
                            await client.aio.models.generate_content(model="failure", contents="fail")
                        self.assertEqual(len(fixture.calls), 9)
                        self.assertEqual(server.errors, [])
                    finally:
                        await client.aio.aclose(); client.close(); http.close(); await ahttp.aclose()

    async def test_async_stream_close_and_cancel_close_native_transport(self):
        for operation in ("close", "cancel"):
            with self.subTest(operation=operation), EvidenceRuntime(endpoint=ENDPOINT) as runtime:
                await runtime.as_async().ready()
                fixture = GoogleFixture()
                with ProviderServer(fixture) as server:
                    scope, closed = Scope("google-python", "async-" + operation), []
                    class ClosingTransport(httpx.AsyncHTTPTransport):
                        async def handle_async_request(self, request):
                            response = await super().handle_async_request(request)
                            original = response.stream
                            class Bytes(httpx.AsyncByteStream):
                                async def __aiter__(self):
                                    async for chunk in original:
                                        yield chunk
                                async def aclose(self):
                                    closed.append(True)
                                    await original.aclose()
                            response.stream = Bytes()
                            return response
                    http = httpx.AsyncClient(transport=CavemanGoogleAsyncTransport(runtime=runtime, scope=scope, provider_base_url=server.url, transport=ClosingTransport()))
                    client = with_caveman_google(genai.Client(api_key="local-google-token", http_options=types.HttpOptions(base_url=server.url, httpx_async_client=http, retry_options=types.HttpRetryOptions(attempts=1))), runtime=runtime, scope=scope)
                    try:
                        stream = await client.aio.models.generate_content_stream(model="helpers", contents="Read first chunk.")
                        self.assertEqual((await anext(stream)).text, "retained-")
                        self.assertFalse(fixture.released)
                        if operation == "close":
                            await stream.aclose()
                        else:
                            pending = asyncio.create_task(anext(stream))
                            await asyncio.sleep(0)
                            pending.cancel()
                            with self.assertRaises(asyncio.CancelledError):
                                await pending
                        self.assertTrue(closed)
                        self.assertEqual(runtime.receipts[-1]["event_kind"], "cancelled")
                        self.assertEqual(len(fixture.calls), 1)
                    finally:
                        fixture.released = True
                        await client.aio.aclose(); client.close(); await http.aclose()


class GoogleCertification(unittest.IsolatedAsyncioTestCase):
    async def test_google_sync_exact_operation_journeys(self):
        from _certification_native import certify_cells
        await certify_cells(self, "google", "sync")

    async def test_google_async_exact_operation_journeys(self):
        from _certification_native import certify_cells
        await certify_cells(self, "google", "async")

    async def test_vertex_sync_exact_operation_journeys(self):
        from _certification_native import certify_cells
        await certify_cells(self, "vertex", "sync")

    async def test_vertex_async_exact_operation_journeys(self):
        from _certification_native import certify_cells
        await certify_cells(self, "vertex", "async")


if __name__ == "__main__":
    from _test_result import ReportingResult
    unittest.main(verbosity=2, testRunner=unittest.TextTestRunner(verbosity=2, resultclass=ReportingResult))
