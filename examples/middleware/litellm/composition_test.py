"""A real user ASGI app calls native LiteLLM beneath CavemanASGIMiddleware.

Only the provider HTTP response is local fixture data. The runtime, ASGI
projection, LiteLLM SDK/provider serialization, callbacks and recovery binding
execute their production implementations. The application owns auth and tools.
"""
import asyncio
import copy
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
import litellm
from caveman_cloud.middleware import MiddlewareRuntime, Scope
from caveman_middleware.asgi import ASGIContext, CavemanASGIMiddleware
from caveman_middleware.litellm import CavemanLiteLLM
from caveman_middleware._native import owner

ENDPOINT = os.environ["CAVEMAN_MIDDLEWARE_ENDPOINT"]
BINARY_SHA256 = hashlib.sha256(Path(os.environ["CAVEMAN_MIDDLEWARE_TEST_BINARY"]).read_bytes()).hexdigest()
COMPOSITION_LOCK_SHA256 = hashlib.sha256(Path(__file__).with_name("composition-requirements.lock").read_bytes()).hexdigest()
NATIVE_VERSIONS = {name: importlib.metadata.version(name) for name in ("litellm", "fastapi", "starlette", "orjson", "backoff", "redis")}
assert NATIVE_VERSIONS == {"litellm": "1.100.0", "fastapi": "0.141.1", "starlette": "1.6.0", "orjson": "3.12.0", "backoff": "2.2.1", "redis": "8.1.0"}
SOURCE = "".join(f"[INFO] reading row {i}: café 🌍 exact-value-{i:03d} verbose repeated details\r\n" for i in range(150))
FACT = "exact-value-074"
ROUTES = {"/v1/chat/completions": "openai-chat", "/v1/messages": "anthropic-messages"}


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def emit(test, provider, assertion, **observation):
    protocol = "openai-chat-completions" if provider == "openai" else "anthropic-messages"
    print("CAVEMAN_MIDDLEWARE_OBSERVATION " + json.dumps({
        "cell_id": f"F07|python|{provider}|{protocol}|asgi_composition|async|complete|unstructured|operator_bound",
        "assertion": assertion,
        "test_id": f"examples/middleware/litellm/composition_test.py::{type(test).__name__}.{test._testMethodName}",
        "observation": {"runtime_binary_sha256": BINARY_SHA256, "composition_lock_sha256": COMPOSITION_LOCK_SHA256, "native_versions": NATIVE_VERSIONS, **observation},
    }), flush=True)


class EvidenceRuntime(MiddlewareRuntime):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.plans, self.receipts = [], []

    def optimize(self, **kwargs):
        result = super().optimize(**kwargs)
        self.plans.append((kwargs, result))
        return result

    def observe_background(self, receipt):
        self.receipts.append(receipt)
        return super().observe_background(receipt)


def tool_text(body, provider, call_id):
    if provider == "openai":
        return next((m.get("content") for m in body["messages"] if m["role"] == "tool" and m["tool_call_id"] == call_id), None)
    for message in body["messages"]:
        if not isinstance(message["content"], list):
            continue
        for part in message["content"]:
            if part.get("type") == "tool_result" and part["tool_use_id"] == call_id:
                content = part["content"]
                return content if isinstance(content, str) else "".join(p.get("text", "") for p in content)
    return None


def response(provider, model, *, name=None, args=None, call_id=None, text=FACT):
    if provider == "openai":
        message = {"role": "assistant", "content": None if name else text}
        if name:
            message["tool_calls"] = [{"id": call_id, "type": "function", "function": {"name": name, "arguments": json.dumps(args or {})}}]
        return {"id": "chatcmpl_composition", "object": "chat.completion", "created": 1, "model": model,
                "choices": [{"index": 0, "message": message, "finish_reason": "tool_calls" if name else "stop"}],
                "usage": {"prompt_tokens": 1000, "completion_tokens": 20, "total_tokens": 1020}}
    return {"id": "msg_composition", "type": "message", "role": "assistant", "model": model,
            "content": [{"type": "tool_use", "id": call_id, "name": name, "input": args or {}}] if name else [{"type": "text", "text": text}],
            "stop_reason": "tool_use" if name else "end_turn", "stop_sequence": None,
            "usage": {"input_tokens": 1000, "output_tokens": 20}}


class Provider:
    def __init__(self, provider):
        self.provider, self.calls, self.errors = provider, [], []
        self.release, self.first = threading.Event(), threading.Event()
        parent = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                try:
                    wire = self.rfile.read(int(self.headers["content-length"]))
                    body = json.loads(wire)
                    parent.calls.append({"path": self.path, "body": body, "wire_sha256": hashlib.sha256(wire).hexdigest(), "headers": dict(self.headers)})
                    if "failure" in body["model"]:
                        self.send_response(503); self.send_header("content-type", "application/json"); self.end_headers()
                        self.wfile.write(json.dumps({"type": "error", "error": {"type": "api_error", "message": "composition provider failure"}}).encode())
                        return
                    if body.get("stream"):
                        self.send_response(200); self.send_header("content-type", "text/event-stream"); self.end_headers()
                        if provider == "openai":
                            def send(text, finish=None):
                                chunk = {"id": "chatcmpl_stream", "object": "chat.completion.chunk", "created": 1, "model": body["model"],
                                         "choices": [{"index": 0, "delta": {} if text is None else {"content": text}, "finish_reason": finish}]}
                                if finish:
                                    chunk["usage"] = {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12}
                                self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode()); self.wfile.flush()
                            send("first"); parent.first.set(); parent.release.wait(10)
                            send("-last"); send(None, "stop"); self.wfile.write(b"data: [DONE]\n\n"); self.wfile.flush()
                        else:
                            def send(kind, **payload):
                                self.wfile.write((f"event: {kind}\ndata: " + json.dumps({"type": kind, **payload}) + "\n\n").encode()); self.wfile.flush()
                            send("message_start", message={"id": "msg_stream", "type": "message", "role": "assistant", "model": body["model"], "content": [], "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 10, "output_tokens": 0}})
                            send("content_block_start", index=0, content_block={"type": "text", "text": ""})
                            send("content_block_delta", index=0, delta={"type": "text_delta", "text": "first"}); parent.first.set(); parent.release.wait(10)
                            send("content_block_delta", index=0, delta={"type": "text_delta", "text": "-last"})
                            send("content_block_stop", index=0)
                            send("message_delta", delta={"stop_reason": "end_turn", "stop_sequence": None}, usage={"output_tokens": 2})
                            send("message_stop")
                        return
                    logs = tool_text(body, provider, "read-1")
                    if logs is None:
                        payload = response(provider, body["model"], name="read_logs", call_id="read-1")
                    else:
                        handle = re.search(r"cmw_[a-f0-9]{48}", logs)
                        if handle:
                            assert FACT not in logs, "requested fact must have been omitted"
                            recovered = tool_text(body, provider, "recover-1")
                            if recovered is None:
                                payload = response(provider, body["model"], name="caveman_retrieve", args={"handle": handle[0]}, call_id="recover-1")
                            else:
                                page = json.loads(recovered)
                                assert page["text"] == SOURCE and page["complete"] is True
                                payload = response(provider, body["model"])
                        else:
                            assert logs == SOURCE
                            payload = response(provider, body["model"])
                    self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers()
                    self.wfile.write(json.dumps(payload).encode())
                except (BrokenPipeError, ConnectionResetError):
                    pass
                except BaseException as error:
                    parent.errors.append(repr(error))
                    self.close_connection = True

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/v1"

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.release.set(); self.server.shutdown(); self.server.server_close(); self.thread.join(5)


async def read_body(receive):
    parts = []
    while True:
        event = await receive()
        if event["type"] != "http.request":
            raise asyncio.CancelledError()
        parts.append(event.get("body", b""))
        if not event.get("more_body", False):
            return b"".join(parts)


async def send_json(send, value, status=200):
    await send({"type": "http.response.start", "status": status, "headers": [(b"content-type", b"application/json")]})
    await send({"type": "http.response.body", "body": json.dumps(value, ensure_ascii=False).encode(), "more_body": False})


async def invoke(app, path, body, *, authorization=b"trusted-host-key", on_send=None):
    wire = json.dumps(body, ensure_ascii=False).encode()
    events = [{"type": "http.request", "body": wire[:37], "more_body": True}, {"type": "http.request", "body": wire[37:], "more_body": False}]
    sent = []
    scope = {"type": "http", "asgi": {"version": "3.0", "spec_version": "2.4"}, "http_version": "1.1", "method": "POST", "path": path,
             "scheme": "http", "raw_path": path.encode(), "query_string": b"", "root_path": "", "server": ("fixture", 80), "client": ("127.0.0.1", 1),
             "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(wire)).encode()), (b"authorization", authorization),
                         (b"x-caveman-namespace", b"untrusted-spoof"), (b"x-native", b"preserved")]}
    async def receive():
        if events:
            return events.pop(0)
        await asyncio.Future()
    async def send(event):
        sent.append(event)
        if on_send:
            await on_send(event)
    await app(scope, receive, send)
    return sent


class NativeApplication:
    """Ordinary ASGI application: native LiteLLM routes and real tool registry."""
    def __init__(self, provider, server, runtime, bridge, bound):
        self.provider, self.server, self.runtime, self.bridge, self.bound = provider, server, runtime, bridge, bound
        self.binding = runtime.recovery(bound)
        self.registry = {"read_logs": self.read_logs, "caveman_retrieve": self.binding.execute}
        self.executions, self.recovered, self.native_calls, self.native_types = [], [], [], []
        self.auth_order, self.guarded_bodies, self.contexts, self.closed_streams = [], [], [], 0

    async def read_logs(self, _args):
        return SOURCE

    def context(self, scope):
        assert scope["state"]["principal"] == "trusted-user"
        assert self.auth_order[-2:] == ["authenticated", "original_guard"]
        self.auth_order.append("scope_resolved"); self.contexts.append(self.bound)
        return ASGIContext(self.bound, self.binding)

    def with_middleware(self):
        projected = CavemanASGIMiddleware(self, runtime=self.runtime, routes=ROUTES, resolve_context=self.context)

        async def authenticated_original_guard(scope, receive, send):
            if dict(scope["headers"]).get(b"authorization") != b"trusted-host-key":
                return await send_json(send, {"error": "unauthorized"}, 401)
            self.auth_order.append("authenticated")
            wire = await read_body(receive)
            if b"BLOCK_ORIGINAL" in wire:
                return await send_json(send, {"error": "original content denied"}, 403)
            self.guarded_bodies.append(json.loads(wire)); self.auth_order.append("original_guard")
            scope = {**scope, "state": {"principal": "trusted-user"}}
            pending = [{"type": "http.request", "body": wire, "more_body": False}]
            async def replay():
                return pending.pop(0) if pending else await receive()
            return await projected(scope, replay, send)
        return authenticated_original_guard

    async def __call__(self, scope, receive, send):
        body = json.loads(await read_body(receive))
        if scope["path"].startswith("/tools/"):
            name = scope["path"].split("/")[-1]
            self.executions.append(name)
            value = await self.registry[name](body)
            if name == "caveman_retrieve":
                self.recovered.append(value)
            return await send_json(send, value)
        self.native_calls.append({"body": copy.deepcopy(body), "owner": owner.get(), "headers": scope["headers"]})
        common = {"api_key": "local-fixture", "api_base": self.server.url, "max_retries": 0}
        if self.provider == "openai":
            result = await self.bridge.acompletion(scope=self.bound, **body, **common)
        else:
            # LiteLLM's public native Anthropic Messages API retains this route's
            # protocol. CavemanLiteLLM's registered callback remains installed;
            # no unsupported completion wrapper or fixture translation is used.
            result = await litellm.anthropic_messages(**body, **common, custom_llm_provider="anthropic")
        self.native_types.append(type(result).__name__)
        if not body.get("stream"):
            if self.provider == "openai":
                assert isinstance(result, litellm.ModelResponse)
                result = result.model_dump(mode="json")
            else:
                assert type(result) is dict and result["type"] == "message"
            return await send_json(send, result)
        await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"text/event-stream")]})
        assert callable(getattr(result, "aclose", None)), "the native stream must expose awaited close"
        try:
            async for chunk in result:
                if self.provider == "openai":
                    data = ("data: " + chunk.model_dump_json() + "\n\n").encode()
                else:
                    data = chunk if isinstance(chunk, bytes) else chunk.encode()
                await send({"type": "http.response.body", "body": data, "more_body": True})
        finally:
            await result.aclose()
            self.closed_streams += 1
        await send({"type": "http.response.body", "body": b"data: [DONE]\n\n" if self.provider == "openai" else b"", "more_body": False})

    def initial_request(self, *, stream=False, failure=False):
        def schema(name, description, inputs):
            native = {"name": name, "description": description, "parameters" if self.provider == "openai" else "input_schema": inputs}
            return {"type": "function", "function": native} if self.provider == "openai" else native
        model = f"{self.provider}/failure" if failure else "claude-sonnet-4-20250514" if self.provider == "anthropic" else "openai/fixture-model"
        body = {"model": model, "messages": [{"role": "user", "content": "Read logs and recover exact row 74."}],
                "tools": [schema("read_logs", "Read exact source logs.", {"type": "object", "properties": {}, "additionalProperties": False}),
                          schema(self.binding.name, self.binding.description, dict(self.binding.input_schema))], "stream": stream}
        if self.provider == "anthropic":
            body["max_tokens"] = 100
        return body

    async def run_loop(self, app):
        path = "/v1/chat/completions" if self.provider == "openai" else "/v1/messages"
        body = self.initial_request()
        for _ in range(5):
            before = copy.deepcopy(body)
            events = await invoke(app, path, body)
            assert body == before, "host request/history must not be mutated"
            native = json.loads(b"".join(e.get("body", b"") for e in events))
            if self.provider == "openai":
                message = native["choices"][0]["message"]
                body["messages"].append(message)
                calls = [(c["id"], c["function"]["name"], json.loads(c["function"]["arguments"])) for c in message.get("tool_calls") or []]
                text = message.get("content")
            else:
                body["messages"].append({"role": "assistant", "content": native["content"]})
                calls = [(p["id"], p["name"], p["input"]) for p in native["content"] if p["type"] == "tool_use"]
                text = "".join(p["text"] for p in native["content"] if p["type"] == "text")
            if not calls:
                return text, body["messages"]
            for call_id, name, args in calls:
                events = await invoke(app, f"/tools/{name}", args)
                value = json.loads(b"".join(e.get("body", b"") for e in events))
                content = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
                if self.provider == "openai":
                    body["messages"].append({"role": "tool", "tool_call_id": call_id, "content": content})
                else:
                    body["messages"].append({"role": "user", "content": [{"type": "tool_result", "tool_use_id": call_id, "content": content}]})
        raise AssertionError("native host loop exceeded bounded steps")


class NativeASGILiteLLMComposition(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        asyncio.get_running_loop().set_debug(False)

    async def journey(self, provider):
        for mode in ("compress", "off", "outage"):
            with self.subTest(provider=provider, mode=mode), Provider(provider) as server, EvidenceRuntime(
                    endpoint="http://127.0.0.1:1" if mode == "outage" else ENDPOINT, mode="off" if mode == "off" else "compress") as sync:
                runtime = sync.as_async()
                if mode == "compress":
                    await runtime.ready()
                with CavemanLiteLLM(runtime=runtime) as bridge:
                    bound = Scope("composition", f"asgi-litellm-{provider}-{mode}")
                    host = NativeApplication(provider, server, runtime, bridge, bound)
                    app = host.with_middleware()
                    answer, history = await host.run_loop(app)
                    self.assertEqual(answer, FACT); self.assertEqual(tool_text({"messages": history}, provider, "read-1"), SOURCE)
                    calls = 3 if mode == "compress" else 2
                    self.assertEqual(len(server.calls), calls); self.assertEqual(len(host.native_calls), calls)
                    self.assertEqual(host.executions, ["read_logs", "caveman_retrieve"] if mode == "compress" else ["read_logs"])
                    for request in host.native_calls:
                        self.assertIn((b"x-native", b"preserved"), request["headers"])
                    self.assertEqual(server.errors, [])
                    if mode == "compress":
                        self.assertEqual(len(sync.plans), calls)
                        self.assertEqual({options["adapter"].id for options, _ in sync.plans}, {"asgi"})
                        self.assertTrue(all(c["owner"] is not None for c in host.native_calls))
                        self.assertEqual([r["event_kind"] for r in sync.receipts].count("dispatch_intent"), calls)
                        self.assertEqual([r["event_kind"] for r in sync.receipts].count("completed"), calls)
                        self.assertTrue(all(r["scope"]["namespace"] == "composition" for r in sync.receipts))
                        self.assertEqual(host.recovered[0]["text"], SOURCE); self.assertTrue(host.recovered[0]["complete"])
                        compressed = tool_text(server.calls[1]["body"], provider, "read-1")
                        self.assertIn("cmw_", compressed); self.assertNotIn(FACT, compressed)
                        self.assertEqual(tool_text(host.guarded_bodies[2], provider, "read-1"), SOURCE)
                        for assertion in ("native_application", "real_tool_result", "transformed_provider_request", "omitted_fact_requested", "host_executes_exact_recovery", "native_result_history_events_and_call_count"):
                            emit(self, provider, assertion, provider_name=provider, native_api="bridge.acompletion" if provider == "openai" else "litellm.anthropic_messages",
                                 native_calls=calls, optimize_calls=len(sync.plans), optimizer_owner="asgi", original_sha256=digest(SOURCE), recovered_sha256=digest(host.recovered[0]["text"]),
                                 auth_before_scope=True, original_guard_before_projection=True, host_executor="ASGI tool route registered binding.execute", native_result_types=host.native_types)
                    else:
                        self.assertEqual(tool_text(server.calls[-1]["body"], provider, "read-1"), SOURCE)
                        if mode == "off":
                            self.assertEqual(sync.plans, []); self.assertEqual(host.contexts, [])
                        emit(self, provider, "off_baseline" if mode == "off" else "optimizer_unavailable", native_calls=calls, original_reaches_provider=True, answer=answer, optimize_calls=len(sync.plans))
                self.assertNotIn(bridge, litellm.callbacks)

    async def test_openai_native_asgi_litellm_exact_recovery_off_outage(self):
        await self.journey("openai")

    async def test_anthropic_native_asgi_litellm_exact_recovery_off_outage(self):
        await self.journey("anthropic")

    async def lifecycle(self, provider):
        with Provider(provider) as server, EvidenceRuntime(endpoint=ENDPOINT) as sync:
            runtime = sync.as_async(); await runtime.ready()
            with CavemanLiteLLM(runtime=runtime) as bridge:
                host = NativeApplication(provider, server, runtime, bridge, Scope("composition", f"asgi-litellm-{provider}-lifecycle"))
                app = host.with_middleware(); path = "/v1/chat/completions" if provider == "openai" else "/v1/messages"
                denied = await invoke(app, path, host.initial_request(), authorization=b"untrusted")
                self.assertEqual(denied[0]["status"], 401)
                guarded = host.initial_request(); guarded["messages"][0]["content"] = "BLOCK_ORIGINAL"
                blocked = await invoke(app, path, guarded)
                self.assertEqual(blocked[0]["status"], 403)
                self.assertEqual(host.contexts, []); self.assertEqual(sync.plans, []); self.assertEqual(server.calls, [])
                first = asyncio.Event()
                async def on_send(event):
                    if b"first" in event.get("body", b""):
                        first.set()
                task = asyncio.create_task(invoke(app, path, host.initial_request(stream=True), on_send=on_send))
                waiter = asyncio.create_task(first.wait())
                done, _ = await asyncio.wait((task, waiter), timeout=5, return_when=asyncio.FIRST_COMPLETED)
                if task in done:
                    await task
                if not waiter.done():
                    waiter.cancel(); task.cancel()
                    await asyncio.gather(waiter, task, return_exceptions=True)
                    self.fail("native first chunk did not arrive before provider EOF")
                self.assertFalse(task.done()); self.assertFalse(server.release.is_set())
                server.release.set(); events = await asyncio.wait_for(task, 5)
                self.assertIn(b"-last", b"".join(e.get("body", b"") for e in events))
                self.assertEqual(host.closed_streams, 1)
                self.assertEqual([r["event_kind"] for r in sync.receipts].count("completed"), 1)
                before = len(server.calls)
                with self.assertRaises(Exception) as failure:
                    await invoke(app, path, host.initial_request(failure=True))
                self.assertIn("composition provider failure", str(failure.exception)); self.assertEqual(len(server.calls) - before, 1)
                self.assertEqual([r["event_kind"] for r in sync.receipts].count("failed"), 1)
            with Provider(provider) as cancel_server, CavemanLiteLLM(runtime=runtime) as bridge:
                cancel_host = NativeApplication(provider, cancel_server, runtime, bridge, Scope("composition", f"asgi-litellm-{provider}-cancel"))
                async def cancel_on_first(event):
                    if b"first" in event.get("body", b""):
                        raise asyncio.CancelledError()
                with self.assertRaises(asyncio.CancelledError):
                    await asyncio.wait_for(invoke(cancel_host.with_middleware(), path, cancel_host.initial_request(stream=True), on_send=cancel_on_first), 5)
                self.assertEqual(cancel_host.closed_streams, 1); self.assertEqual(len(cancel_server.calls), 1)
                self.assertEqual([r["event_kind"] for r in sync.receipts].count("cancelled"), 1)
                self.assertIsNone(owner.get()); self.assertEqual(cancel_server.errors, [])
            self.assertEqual(server.errors, [])
            emit(self, provider, "native_stream_failure_cancel_and_auth", first_chunk_before_eof=True, native_failure_calls=1, cancellation_receipts=1,
                 auth_rejection_status=401, original_guard_rejection_status=403, rejected_requests_optimized=0, native_stream_closed=True,
                 native_stream_type=host.native_types[0], native_cancel_stream_type=cancel_host.native_types[0], underlying_close_awaited=True)

    async def test_openai_native_asgi_litellm_stream_cancel_failure_and_auth(self):
        await self.lifecycle("openai")

    async def test_anthropic_native_asgi_litellm_stream_cancel_failure_and_auth(self):
        await self.lifecycle("anthropic")


if __name__ == "__main__":
    unittest.main(verbosity=2)
