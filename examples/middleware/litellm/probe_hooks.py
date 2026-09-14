"""Installed LiteLLM hook feasibility, with actual local provider HTTP capture."""
import asyncio
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.metadata import version

os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
import litellm
from litellm.integrations.custom_logger import CustomLogger

calls = []
class Provider(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass
    def do_POST(self):
        calls.append(json.loads(self.rfile.read(int(self.headers["content-length"]))))
        body = json.dumps({"id": "fixture", "object": "chat.completion", "created": 1, "model": "fixture-model", "choices": [{"index": 0, "message": {"role": "assistant", "content": "fixture"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 5, "completion_tokens": 1, "total_tokens": 6}}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class Probe(CustomLogger):
    def __init__(self):
        super().__init__()
        self.calls = 0
    async def async_pre_call_deployment_hook(self, kwargs, call_type):
        self.calls += 1
        return {**kwargs, "messages": [{"role": "user", "content": "native hook changed this"}]}


async def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    probe = Probe()
    litellm.callbacks.append(probe)
    params = dict(model="openai/fixture-model", api_key="local-fixture", api_base=f"http://127.0.0.1:{server.server_address[1]}/v1", messages=[{"role": "user", "content": "original"}], max_retries=0)
    try:
        litellm.completion(**params)
        assert probe.calls == 0 and calls[-1]["messages"][0]["content"] == "original"
        await litellm.acompletion(**params)
        assert probe.calls == 1 and calls[-1]["messages"][0]["content"] == "native hook changed this"
        assert params["messages"][0]["content"] == "original"
        print(json.dumps({"evidence_class": "native_hook_probe", "litellm": version("litellm"), "openai": version("openai"),
            "sync_deployment_mutation_hook_calls": 0, "async_deployment_mutation_hook_calls": 1, "native_provider_http_calls": len(calls), "hosted_provider_tested": False}))
    finally:
        litellm.callbacks.remove(probe)
        server.shutdown()
        server.server_close()
        thread.join()


asyncio.run(main())
