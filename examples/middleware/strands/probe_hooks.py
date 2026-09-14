"""Real Strands/Bedrock calls to a local signed HTTP fixture, no AWS account."""
import asyncio
import json
import threading
import warnings
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.metadata import version

import boto3
from pydantic import BaseModel
from strands import Agent
from strands.hooks import BeforeModelCallEvent
from strands.models import BedrockModel

calls = []
class Provider(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        calls.append((body, self.headers.get("authorization", "")))
        tools = body.get("toolConfig", {}).get("tools", [])
        content = [{"text": "native fixture"}]
        if tools:
            content = [{"toolUse": {"toolUseId": "typed-result", "name": tools[0]["toolSpec"]["name"], "input": {"answer": 42}}}]
        payload = json.dumps({"output": {"message": {"role": "assistant", "content": content}}, "stopReason": "tool_use" if tools else "end_turn",
            "usage": {"inputTokens": 5, "outputTokens": 2, "totalTokens": 7}, "metrics": {"latencyMs": 1}}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


class Answer(BaseModel):
    answer: int


async def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        model = BedrockModel(boto_session=boto3.Session(aws_access_key_id="local-fixture", aws_secret_access_key="local-fixture", region_name="us-east-1"),
            endpoint_url=f"http://127.0.0.1:{server.server_address[1]}", model_id="anthropic.fixture-v1", streaming=False)
        agent = Agent(model=model, callback_handler=None)
        observed = []
        agent.add_hook(lambda event: observed.append(event), BeforeModelCallEvent)
        await agent.invoke_async("Native normal call")
        assert len(observed) == 1
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            result = await agent.structured_output_async(Answer, "Return 42")
        assert result.answer == 42 and len(observed) == 1
        assert len(calls) == 2 and all(auth.startswith("AWS4-HMAC-SHA256 ") for _, auth in calls)
        print(json.dumps({"evidence_class": "native_hook_probe", "strands-agents": version("strands-agents"), "boto3": version("boto3"),
            "normal_before_model_hook_calls": 1, "legacy_structured_output_before_model_hook_calls": 0,
            "signed_native_bedrock_http_calls": 2, "hosted_provider_tested": False}))
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


asyncio.run(main())
