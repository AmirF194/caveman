"""Native FastAPI/Starlette ASGI paths and an application-owned recovery loop."""
import asyncio
import copy
import json
import os
import re
import tracemalloc
import unittest

from fastapi import FastAPI, Request
from starlette.applications import Starlette
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Route, WebSocketRoute

from caveman_cloud.middleware import Scope
from caveman_middleware.asgi import ASGIContext, CavemanASGIMiddleware
from caveman_middleware._native import owner
from evidence_runtime import EvidenceRuntime

ENDPOINT = os.environ["CAVEMAN_MIDDLEWARE_ENDPOINT"]
SOURCE = "".join(f"[INFO] café 🌍 row {i} exact-detail-{i} long repeated diagnostic\r\n" for i in range(140))
ROUTES = {"/v1/chat/completions": "openai-chat", "/v1/responses": "openai-responses", "/v1/messages": "anthropic-messages"}


async def invoke(app, path, body=b"", *, chunks=None, extra_headers=(), method="POST", send_callback=None, scope_update=None):
    events = list(chunks) if chunks is not None else [{"type": "http.request", "body": body, "more_body": False}]
    sent = []
    scope = {"type": "http", "asgi": {"version": "3.0", "spec_version": "2.4"}, "http_version": "1.1", "scheme": "http",
             "method": method, "path": path, "raw_path": path.encode(), "query_string": b"native=keep", "root_path": "",
             "headers": [(b"content-type", b"application/json"), *extra_headers], "server": ("fixture", 80), "client": ("127.0.0.1", 1)}
    scope.update(scope_update or {})
    waiting = asyncio.Event()
    async def receive():
        if events:
            return events.pop(0)
        await waiting.wait()
        return {"type": "http.disconnect"}
    async def send(event):
        sent.append(event)
        if send_callback:
            await send_callback(event)
    await app(scope, receive, send)
    return sent


def tool_schema(binding, protocol):
    native = {"name": binding.name, "description": binding.description,
              "input_schema" if protocol == "anthropic-messages" else "parameters": dict(binding.input_schema)}
    return {"type": "function", "function": native} if protocol == "openai-chat" else native


def request_body(protocol, binding, text=SOURCE):
    tools = [tool_schema(binding, protocol)]
    if protocol == "openai-chat":
        return {"model": "native-model", "messages": [{"role": "assistant", "tool_calls": [{"id": "read-1", "type": "function", "function": {"name": "read_logs", "arguments": "{}"}}]},
               {"role": "tool", "tool_call_id": "read-1", "content": text}], "tools": tools, "parallel_tool_calls": True}
    if protocol == "openai-responses":
        return {"model": "native-model", "input": [{"type": "function_call", "call_id": "read-1", "name": "read_logs", "arguments": "{}"},
                {"type": "function_call_output", "call_id": "read-1", "output": text}], "tools": tools, "instructions": "protected"}
    return {"model": "native-model", "max_tokens": 100, "system": [{"type": "text", "text": "protected", "cache_control": {"type": "ephemeral"}}],
            "messages": [{"role": "assistant", "content": [{"type": "thinking", "thinking": "preserve", "signature": "signed"}, {"type": "tool_use", "id": "read-1", "name": "read_logs", "input": {}}]},
                         {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "read-1", "content": text}]}], "tools": tools}


def source_text(body, protocol):
    if protocol == "openai-chat":
        return body["messages"][1]["content"]
    if protocol == "openai-responses":
        return body["input"][1]["output"]
    return body["messages"][1]["content"][0]["content"]


class NativeASGITest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        asyncio.get_running_loop().set_debug(False)
        self.runtimes = []

    async def asyncTearDown(self):
        for runtime in self.runtimes:
            runtime.close()

    def runtime(self, mode="compress", outage=False):
        value = EvidenceRuntime(endpoint="http://127.0.0.1:1" if outage else ENDPOINT, mode=mode)
        self.runtimes.append(value)
        return value

    async def test_native_fastapi_three_protocol_recovery_loops_off_and_outage(self):
        for path, protocol in ROUTES.items():
            for mode in ("compress", "off", "outage"):
                with self.subTest(protocol=protocol, mode=mode):
                    sync = self.runtime("off" if mode == "off" else "compress", outage=mode == "outage")
                    runtime = sync.as_async()
                    if mode == "compress":
                        await runtime.ready()
                    bound = Scope("asgi", f"{protocol}-{mode}")
                    recovery = runtime.recovery(bound)
                    calls, recovered = [], []
                    native_app = FastAPI()

                    @native_app.post(path)
                    async def model(request: Request):
                        body = await request.json()
                        calls.append((body, request.scope["headers"], owner.get()))
                        text = source_text(body, protocol)
                        handle = re.search(r"cmw_[a-f0-9]{48}", text)
                        if handle:
                            self.assertNotIn("exact-detail-70", text)
                            if not recovered:
                                return {"tool_call": {"name": "caveman_retrieve", "arguments": {"handle": handle[0]}}}
                        else:
                            self.assertEqual(text, SOURCE)
                        return {"answer": "exact-detail-70", "usage": {"input_tokens": 100, "output_tokens": 10}}

                    @native_app.post("/tools/caveman_retrieve")
                    async def execute_tool(request: Request):
                        value = await recovery.execute(await request.json())
                        recovered.append(value)
                        return value

                    auth_calls = []
                    def resolve(scope):
                        self.assertEqual(scope["state"]["principal"], "trusted-user")
                        auth_calls.append(scope["path"])
                        return ASGIContext(bound, recovery)
                    app = CavemanASGIMiddleware(native_app, runtime=runtime, routes=ROUTES, resolve_context=resolve)
                    original = request_body(protocol, recovery)
                    frozen = copy.deepcopy(original)
                    wire = json.dumps(original, ensure_ascii=False).encode()
                    headers = [(b"content-length", str(len(wire)).encode()), (b"authorization", b"existing-auth"), (b"x-native", b"untouched")]
                    async def call_model():
                        chunks = [{"type": "http.request", "body": wire[:37], "more_body": True}, {"type": "http.request", "body": wire[37:], "more_body": False}]
                        events = await invoke(app, path, chunks=chunks, extra_headers=headers, scope_update={"state": {"principal": "trusted-user"}})
                        return json.loads(b"".join(e.get("body", b"") for e in events))
                    result = await call_model()
                    if "tool_call" in result:
                        events = await invoke(app, "/tools/caveman_retrieve", json.dumps(result["tool_call"]["arguments"]).encode())
                        self.assertEqual(json.loads(b"".join(e.get("body", b"") for e in events))["text"], SOURCE)
                        result = await call_model()
                    self.assertEqual(result["answer"], "exact-detail-70")
                    self.assertEqual(original, frozen)
                    self.assertEqual(len(calls), 2 if mode == "compress" else 1)
                    if mode == "compress":
                        self.assertEqual(len(recovered), 1)
                        self.assertEqual(calls[0][0], calls[1][0])
                        self.assertTrue(all(call[2] is not None for call in calls))
                        self.assertEqual([p.status for _, p in sync.plans], ["optimized", "optimized"])
                    self.assertIn((b"x-native", b"untouched"), calls[0][1])
                    self.assertIn((b"authorization", b"existing-auth"), calls[0][1])
                    if mode == "off":
                        self.assertFalse(auth_calls)
                        self.assertFalse(sync.plans)

    async def test_exact_paths_protocols_encoding_and_oversized_body_replay(self):
        sync = self.runtime()
        runtime = sync.as_async()
        calls, resolved = [], []
        async def endpoint(request):
            wire = await request.body()
            calls.append((wire, request.scope["headers"]))
            return Response(wire, media_type="application/octet-stream", headers={"x-native": "yes"})
        native_app = Starlette(routes=[Route("/{path:path}", endpoint, methods=["POST", "GET"])])
        def resolve(scope):
            resolved.append(scope["path"])
            return ASGIContext(Scope("asgi", "passthrough"))
        app = CavemanASGIMiddleware(native_app, runtime=runtime, routes=ROUTES, resolve_context=resolve, max_body_bytes=128)
        cases = [
            ("/ordinary", b'{"model":"x","messages":[]}', [], "POST"),
            ("/v1/chat/completions/", b"{}", [], "POST"),
            ("/v1/chat/completions", b"{}", [], "GET"),
            ("/v1/messages", b"compressed bytes", [(b"content-encoding", b"gzip")], "POST"),
            ("/v1/messages", b"signed bytes", [(b"signature", b"preserve")], "POST"),
            ("/v1/messages", b'{"model":"x","model":"y","messages":[]}', [], "POST"),
            ("/v1/messages", b'{"model":"x","messages":[],"n":NaN}', [], "POST"),
            ("/v1/messages", b"not json", [], "POST"),
            ("/v1/messages", b"\xff\xfe", [], "POST"),
            ("/v1/messages", b"x" * 1024, [], "POST"),
            ("/v1/messages", b"x" * 1024, [(b"content-length", b"1024")], "POST"),
        ]
        for path, body, headers, method in cases:
            with self.subTest(path=path, body=body[:40]):
                chunks = [{"type": "http.request", "body": body[i:i+31], "more_body": i+31 < len(body)} for i in range(0, len(body), 31)]
                events = await invoke(app, path, chunks=chunks, extra_headers=headers, method=method)
                self.assertEqual(calls[-1][0], body)
                self.assertEqual(b"".join(e.get("body", b"") for e in events), body)
                self.assertIn((b"x-native", b"yes"), events[0]["headers"])
        self.assertFalse(sync.plans)

    async def test_auth_and_original_content_guards_run_before_optimization(self):
        sync = self.runtime()
        runtime = sync.as_async()
        bound = Scope("asgi", "auth")
        binding = runtime.recovery(bound)
        native_app = FastAPI()
        calls = []
        @native_app.post("/v1/chat/completions")
        async def model(request: Request):
            calls.append(await request.body())
            return {"ok": True}
        def resolve(scope):
            self.assertTrue(scope["state"]["authorized"])
            return ASGIContext(bound, binding)
        middleware = CavemanASGIMiddleware(native_app, runtime=runtime, routes=ROUTES, resolve_context=resolve)
        async def auth_and_guard(scope, receive, send):
            message = await receive()
            if b"blocked-content" in message["body"] or (b"authorization", b"valid") not in scope["headers"]:
                return await Response("denied", status_code=403)(scope, receive, send)
            scope = {**scope, "state": {"authorized": True}}
            consumed = False
            async def replay():
                nonlocal consumed
                if not consumed:
                    consumed = True
                    return message
                return await receive()
            return await middleware(scope, replay, send)
        body = json.dumps(request_body("openai-chat", binding, SOURCE + "blocked-content")).encode()
        for headers in ([], [(b"authorization", b"valid")]):
            events = await invoke(auth_and_guard, "/v1/chat/completions", body, extra_headers=headers)
            self.assertEqual(events[0]["status"], 403)
        self.assertFalse(sync.plans)
        self.assertFalse(calls)

    async def test_starlette_sse_flush_backpressure_headers_and_cancellation(self):
        sync = self.runtime()
        runtime = sync.as_async()
        await runtime.ready()
        binding = runtime.recovery(Scope("asgi", "stream"))
        released, first = asyncio.Event(), asyncio.Event()
        closed, produced, forwarded = [], [], []
        async def endpoint(request):
            self.assertIn("cmw_", source_text(await request.json(), "openai-chat"))
            async def events():
                try:
                    produced.append(1)
                    yield b'data: {"choices":[{"delta":{"content":"first"}}]}\n\n'
                    await released.wait()
                    produced.append(2)
                    yield b'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n'
                    yield b'data: [DONE]\n\n'
                finally:
                    closed.append(True)
            return StreamingResponse(events(), media_type="text/event-stream", headers={"x-native": "stream"})
        native_app = Starlette(routes=[Route("/v1/chat/completions", endpoint, methods=["POST"])])
        app = CavemanASGIMiddleware(native_app, runtime=runtime, routes=ROUTES, resolve_context=lambda _: ASGIContext(binding.scope, binding))
        wire = json.dumps(request_body("openai-chat", binding)).encode()
        async def send(event):
            forwarded.append(event)
            if event.get("body", b"").startswith(b"data:"):
                first.set()
        running = asyncio.create_task(invoke(app, "/v1/chat/completions", wire, send_callback=send))
        await asyncio.wait_for(first.wait(), 2)
        self.assertEqual(produced, [1])
        self.assertFalse(running.done())
        self.assertIn((b"x-native", b"stream"), forwarded[0]["headers"])
        released.set()
        await running
        self.assertEqual(closed, [True])
        completed = [r for r in sync.receipts if r["event_kind"] == "completed"]
        self.assertEqual(completed[-1]["usage"]["input_tokens"], 10)
        self.assertTrue(completed[-1]["usage"]["complete"])
        first.clear(); released.clear(); produced.clear()
        running = asyncio.create_task(invoke(app, "/v1/chat/completions", wire, send_callback=send))
        await asyncio.wait_for(first.wait(), 2)
        running.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await running
        self.assertEqual(len(closed), 2)
        self.assertEqual(sync.receipts[-1]["event_kind"], "cancelled")
        self.assertIsNone(sync.receipts[-1]["usage"])

    async def test_lifespan_websocket_disconnect_and_model_only(self):
        sync = self.runtime()
        runtime = sync.as_async()
        calls = []
        async def endpoint(request):
            from starlette.requests import ClientDisconnect
            try:
                body = await request.body()
                calls.append(body)
                return Response(body)
            except ClientDisconnect:
                calls.append("disconnect")
                return Response(status_code=499)
        async def ws(websocket):
            await websocket.accept()
            await websocket.send_text("native websocket")
            await websocket.close()
        native = Starlette(routes=[Route("/v1/messages", endpoint, methods=["POST"]), WebSocketRoute("/ws", ws)])
        app = CavemanASGIMiddleware(native, runtime=runtime, routes=ROUTES, resolve_context=lambda _: ASGIContext(Scope("asgi", "model-only")))
        events = await invoke(app, "/v1/messages", chunks=[{"type": "http.request", "body": b"{", "more_body": True}, {"type": "http.disconnect"}])
        self.assertEqual(calls, ["disconnect"])
        self.assertEqual(events[0]["status"], 499)
        recovery = runtime.recovery(Scope("asgi", "fake-binding"))
        wire = json.dumps(request_body("anthropic-messages", recovery)).encode()
        await invoke(app, "/v1/messages", wire)
        self.assertEqual(calls[-1], wire)
        self.assertEqual(sync.plans[-1][1].reason, "recovery_unavailable")
        self.assertIsNone(owner.get())
        lifecycle = iter([{"type": "lifespan.startup"}, {"type": "lifespan.shutdown"}])
        sent = []
        async def receive_lifespan():
            return next(lifecycle)
        async def send(event):
            sent.append(event)
        await app({"type": "lifespan", "asgi": {"version": "3.0"}, "state": {}}, receive_lifespan, send)
        self.assertEqual([e["type"] for e in sent], ["lifespan.startup.complete", "lifespan.shutdown.complete"])
        incoming = iter([{"type": "websocket.connect"}])
        async def receive_ws():
            return next(incoming)
        await app({"type": "websocket", "path": "/ws", "scheme": "ws", "headers": [], "query_string": b"", "root_path": "", "subprotocols": []}, receive_ws, send)
        self.assertEqual(sent[-2]["text"], "native websocket")
        self.assertEqual(sent[-1]["type"], "websocket.close")

    async def test_64mib_10000_events_keep_bounded_buffering_and_backpressure(self):
        sync = self.runtime()
        runtime = sync.as_async()
        await runtime.ready()
        binding = runtime.recovery(Scope("asgi", "large-stream"))
        total_bytes, event_count = 64 << 20, 10000
        produced, first, release = [], asyncio.Event(), asyncio.Event()
        async def endpoint(request):
            await request.body()
            async def events():
                for i in range(event_count):
                    if i == 0:
                        produced.append(True)
                    size = total_bytes // event_count + (i < total_bytes % event_count)
                    prefix = b'data: {"choices":[{"delta":{"content":"'
                    suffix = b'"}}]}\n\n'
                    if i == event_count - 1:
                        prefix = b'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2},"padding":"'
                        suffix = b'"}\n\n'
                    yield prefix + b"x" * (size-len(prefix)-len(suffix)) + suffix
            return StreamingResponse(events(), media_type="text/event-stream")
        native = Starlette(routes=[Route("/v1/chat/completions", endpoint, methods=["POST"])])
        wrapped = CavemanASGIMiddleware(native, runtime=runtime, routes=ROUTES, resolve_context=lambda _: ASGIContext(binding.scope, binding))
        wire = json.dumps(request_body("openai-chat", binding)).encode()

        async def measure(app):
            sent_bytes, sent_events, delivered = 0, 0, False
            scope = {"type": "http", "asgi": {"version": "3.0", "spec_version": "2.4"}, "http_version": "1.1", "scheme": "http", "method": "POST",
                     "path": "/v1/chat/completions", "raw_path": b"/v1/chat/completions", "query_string": b"", "root_path": "", "headers": [(b"content-type", b"application/json")]}
            async def receive():
                nonlocal delivered
                if not delivered:
                    delivered = True
                    return {"type": "http.request", "body": wire}
                await asyncio.Event().wait()
            async def send(event):
                nonlocal sent_bytes, sent_events
                if event.get("body"):
                    sent_bytes += len(event["body"])
                    sent_events += 1
                    if sent_events == 1:
                        first.set()
                        await release.wait()
            tracemalloc.start()
            running = asyncio.create_task(app(scope, receive, send))
            await asyncio.wait_for(first.wait(), 3)
            self.assertEqual(sent_events, 1)
            self.assertFalse(running.done())
            release.set()
            await running
            _, peak = tracemalloc.get_traced_memory()
            tracemalloc.stop()
            first.clear(); release.clear()
            self.assertEqual(sent_events, event_count)
            self.assertEqual(sent_bytes, total_bytes)
            return peak

        baseline = await measure(native)
        wrapped_peak = await measure(wrapped)
        self.assertLess(wrapped_peak - baseline, 1 << 20)
        self.assertTrue(sync.receipts[-1]["usage"]["complete"])

    async def test_declined_inference_routes_keep_one_owner_and_report(self):
        from caveman_middleware._native import NativeSession
        for reason in ("off", "encoded", "oversized", "no_scope"):
            with self.subTest(reason=reason):
                reports = []
                sync = EvidenceRuntime(endpoint=ENDPOINT, mode="off" if reason == "off" else "compress", on_report=reports.append)
                self.runtimes.append(sync)
                runtime = sync.as_async()
                binding = runtime.recovery(Scope("asgi", "passive-owner-" + reason))
                received, native = [], FastAPI()
                @native.post("/v1/chat/completions")
                async def endpoint(request: Request):
                    incoming = await request.body()
                    received.append(incoming)
                    self.assertTrue(owner.get().passive)
                    session = NativeSession(runtime, binding.scope, adapter_id="nested-native", framework_version="fixture",
                                            protocol="openai-chat", binding=binding)
                    body = request_body("openai-chat", binding)
                    unchanged, attempt = await session.prepare_async(body)
                    self.assertIs(unchanged, body)
                    self.assertIsNone(attempt)
                    return Response(incoming)
                app = CavemanASGIMiddleware(native, runtime=runtime, routes=ROUTES,
                        resolve_context=lambda _: None if reason == "no_scope" else ASGIContext(binding.scope, binding),
                        max_body_bytes=128 if reason == "oversized" else 2 << 20)
                wire = json.dumps(request_body("openai-chat", binding)).encode()
                headers = [(b"content-encoding", b"gzip")] if reason == "encoded" else []
                events = await invoke(app, "/v1/chat/completions", wire, extra_headers=headers)
                self.assertEqual(received, [wire])
                self.assertEqual(b"".join(event.get("body", b"") for event in events), wire)
                self.assertEqual(len(reports), 1)
                self.assertEqual(reports[0].adapter, "asgi")
                self.assertEqual(reports[0].status, "disabled" if reason == "off" else "skipped")
                self.assertEqual(sync.plans, [])
                self.assertEqual(sync.receipts, [])
                self.assertIsNone(owner.get())


class NativeASGICertification(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        asyncio.get_running_loop().set_debug(False)

    async def test_openai_chat_exact_operation_journeys(self):
        from _certification_native import certify_cells
        await certify_cells(self, "openai-chat")

    async def test_openai_responses_exact_operation_journeys(self):
        from _certification_native import certify_cells
        await certify_cells(self, "openai-responses")

    async def test_anthropic_exact_operation_journeys(self):
        from _certification_native import certify_cells
        await certify_cells(self, "anthropic-messages")

    async def test_native_sdk_error_classes_status_headers_and_reports(self):
        from _certification_native import native_errors
        await native_errors(self)


if __name__ == "__main__":
    from _test_result import ReportingResult
    unittest.main(testRunner=unittest.TextTestRunner(resultclass=ReportingResult))
