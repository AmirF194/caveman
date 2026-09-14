"""Pinned LiteLLM SDK/Router calls with native local provider HTTP capture."""
import asyncio
import copy
import json
import os
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
import litellm
from caveman_cloud.middleware import MiddlewareRuntime, Scope
from caveman_middleware.litellm import CavemanLiteLLM

ENDPOINT = os.environ["CAVEMAN_MIDDLEWARE_ENDPOINT"]
SOURCE = "".join(f"[INFO] row {i} retained-detail-{i} long repeated diagnostic\r\n" for i in range(140))
MESSAGES = [{"role": "user", "content": "Read source"}, {"role": "assistant", "content": None,
    "tool_calls": [{"id": "read-1", "type": "function", "function": {"name": "read_logs", "arguments": "{}"}}]},
    {"role": "tool", "tool_call_id": "read-1", "content": SOURCE}]


class EvidenceRuntime(MiddlewareRuntime):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.plans, self.receipts = [], []
    def optimize(self, **kwargs):
        result = super().optimize(**kwargs)
        self.plans.append((kwargs["model"], result))
        return result
    def observe_background(self, receipt):
        self.receipts.append(receipt)
        return super().observe_background(receipt)


class Provider:
    def __init__(self):
        self.calls, self.errors = [], []
        self.release = threading.Event()
        parent = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass
            def do_POST(self):
                try:
                    body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                    parent.calls.append((self.path, body, dict(self.headers)))
                    if body["model"] == "failure":
                        payload = {"error": {"message": "fixture unavailable", "type": "server_error"}}
                        self.send_response(503)
                    elif self.path.endswith("/responses"):
                        payload = {"id": "resp_fixture", "object": "response", "created_at": 1, "status": "completed", "error": None,
                            "incomplete_details": None, "instructions": None, "model": body["model"], "output": [{"id": "msg_1", "type": "message", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": "native", "annotations": []}]}],
                            "parallel_tool_calls": True, "temperature": 1, "tool_choice": "auto", "tools": [], "top_p": 1,
                            "usage": {"input_tokens": 100, "output_tokens": 4, "total_tokens": 104}}
                        self.send_response(200)
                    else:
                        payload = {"id": "chatcmpl_fixture", "object": "chat.completion", "created": 1, "model": body["model"],
                            "choices": [{"index": 0, "message": {"role": "assistant", "content": "native"}, "finish_reason": "stop"}],
                            "usage": {"prompt_tokens": 100, "completion_tokens": 4, "total_tokens": 104}}
                        self.send_response(200)
                    if body.get("stream"):
                        self.send_header("content-type", "text/event-stream"); self.end_headers()
                        for text in ("nat", "ive"):
                            chunk = {**payload, "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {"content": text}, "finish_reason": None}]}
                            self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode()); self.wfile.flush()
                            if text == "nat":
                                parent.release.wait(5)
                        chunk = {**payload, "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}
                        self.wfile.write(("data: " + json.dumps(chunk) + "\n\ndata: [DONE]\n\n").encode()); self.wfile.flush()
                    else:
                        self.send_header("content-type", "application/json"); self.end_headers()
                        self.wfile.write(json.dumps(payload).encode())
                except (BrokenPipeError, ConnectionResetError):
                    pass
                except BaseException as error:
                    parent.errors.append(str(error))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/v1"
    def __enter__(self):
        return self
    def __exit__(self, *_):
        self.release.set(); self.server.shutdown(); self.server.server_close(); self.thread.join(5)
    def params(self, **extra):
        return dict(model="openai/fixture-model", api_key="fixture-key", api_base=self.url, max_retries=0, **extra)


class NativeLiteLLM(unittest.TestCase):
    def test_sync_native_types_messages_responses_and_unrelated_call_isolation(self):
        with Provider() as server, EvidenceRuntime(endpoint=ENDPOINT) as runtime, CavemanLiteLLM(runtime=runtime) as bridge:
            runtime.ready(); scope = Scope("litellm", "sync")
            original = copy.deepcopy(MESSAGES)
            litellm.completion(**server.params(messages=MESSAGES))
            baseline = copy.deepcopy(server.calls[-1][1]["messages"])
            response = bridge.completion(scope=scope, **server.params(messages=MESSAGES, metadata={"team": "caller"}))
            self.assertIsInstance(response, litellm.ModelResponse)
            self.assertEqual(response.choices[0].message.content, "native")
            self.assertEqual(MESSAGES, original)
            self.assertEqual(server.calls[-1][1]["messages"], baseline)
            self.assertEqual(runtime.plans[-1][1].reason, "recovery_unavailable")
            before = len(runtime.plans)
            litellm.completion(**server.params(messages=MESSAGES))
            self.assertEqual(len(runtime.plans), before)
            inputs = [{"type": "function_call", "call_id": "read-1", "name": "read_logs", "arguments": "{}"},
                      {"type": "function_call_output", "call_id": "read-1", "output": SOURCE}]
            result = bridge.responses(scope=Scope("litellm", "responses"), **server.params(input=inputs))
            self.assertEqual(result.output[0].content[0].text, "native")
            self.assertEqual(server.calls[-1][1]["input"], inputs)
            self.assertEqual(server.errors, [])
        self.assertNotIn(bridge, litellm.callbacks)

    def test_off_outage_and_native_stream_first_chunk(self):
        with Provider() as server:
            litellm.completion(**server.params(messages=MESSAGES))
            baseline = copy.deepcopy(server.calls[-1][1]["messages"])
            for mode, endpoint in (("off", ENDPOINT), ("compress", "http://127.0.0.1:1")):
                with EvidenceRuntime(endpoint=endpoint, mode=mode) as runtime, CavemanLiteLLM(runtime=runtime) as bridge:
                    result = bridge.completion(scope=Scope("litellm", mode), **server.params(messages=MESSAGES))
                    self.assertEqual(result.choices[0].message.content, "native")
                    self.assertEqual(server.calls[-1][1]["messages"], baseline)
            with EvidenceRuntime(endpoint=ENDPOINT) as runtime, CavemanLiteLLM(runtime=runtime) as bridge:
                stream = bridge.completion(scope=Scope("litellm", "stream"), **server.params(messages=MESSAGES, stream=True))
                self.assertIsInstance(stream, litellm.CustomStreamWrapper)
                first = next(stream)
                self.assertEqual(first.choices[0].delta.content, "nat")
                server.release.set()
                self.assertEqual("nat" + "".join(c.choices[0].delta.content or "" for c in stream if c.choices), "native")
                self.assertEqual(server.errors, [])


class AsyncNativeLiteLLM(unittest.IsolatedAsyncioTestCase):
    async def test_async_scopes_stream_responses_and_cleanup(self):
        with Provider() as server, EvidenceRuntime(endpoint=ENDPOINT) as runtime, CavemanLiteLLM(runtime=runtime) as bridge:
            runtime.ready()
            replies = await asyncio.gather(*(bridge.acompletion(scope=Scope("litellm", f"async-{i}"), **server.params(messages=MESSAGES)) for i in range(3)))
            self.assertEqual([r.choices[0].message.content for r in replies], ["native"] * 3)
            self.assertEqual(len(runtime.plans), 3)
            self.assertEqual(len({r["scope"]["session_id"] for r in runtime.receipts}), 3)
            stream = await bridge.acompletion(scope=Scope("litellm", "async-stream"), **server.params(messages=MESSAGES, stream=True))
            self.assertIsInstance(stream, litellm.CustomStreamWrapper)
            first = await anext(stream)
            self.assertEqual(first.choices[0].delta.content, "nat")
            server.release.set()
            rest = [c async for c in stream]
            self.assertEqual("nat" + "".join(c.choices[0].delta.content or "" for c in rest if c.choices), "native")
            result = await bridge.aresponses(scope=Scope("litellm", "async-responses"), **server.params(input="Hello"))
            self.assertEqual(result.output[0].content[0].text, "native")
            self.assertEqual(server.errors, [])

    async def test_native_router_fallback_rechecks_selected_model_and_records_attempts(self):
        with Provider() as server, EvidenceRuntime(endpoint=ENDPOINT) as runtime:
            router = litellm.Router(model_list=[{"model_name": "primary", "litellm_params": server.params() | {"model": "openai/failure"}},
                {"model_name": "backup", "litellm_params": server.params()}], fallbacks=[{"primary": ["backup"]}], num_retries=0)
            try:
                with CavemanLiteLLM(runtime=runtime, client=router) as bridge:
                    response = await bridge.acompletion(scope=Scope("litellm", "fallback"), model="primary", messages=MESSAGES)
                    self.assertEqual(response.choices[0].message.content, "native")
                    self.assertEqual([c[1]["model"] for c in server.calls], ["failure", "fixture-model"])
                    self.assertEqual([p[0]["id"] for p in runtime.plans], ["openai/failure", "openai/fixture-model"])
                    events = [r["event_kind"] for r in runtime.receipts]
                    self.assertEqual(events.count("dispatch_intent"), 2)
                    self.assertEqual(events.count("failed"), 1)
                    self.assertEqual(events.count("completed"), 1)
                    self.assertEqual(server.errors, [])
            finally:
                router.reset()


class LiteLLMCertification(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        asyncio.get_running_loop().set_debug(False)

    async def test_public_sync_router_guard_order_strict_and_concurrent_isolation(self):
        from _router_cases import public_sync_guards
        await public_sync_guards(self)

    async def test_passive_native_results_callbacks_and_concurrent_registration_cleanup(self):
        from _passive_cases import passive_cases
        await passive_cases(self)

    async def test_f07_openai_exact_journeys(self):
        from _certification_native import certify_provider
        await certify_provider(self, "openai")

    async def test_f07_anthropic_exact_journeys(self):
        from _certification_native import certify_provider
        await certify_provider(self, "anthropic")


if __name__ == "__main__":
    from _test_result import ReportingResult
    unittest.main(verbosity=2, testRunner=unittest.TextTestRunner(verbosity=2, resultclass=ReportingResult))
