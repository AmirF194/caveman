"""Native Strands agent, real Boto signing and Converse/ConverseStream framing."""
import asyncio
import copy
import json
import os
import re
import struct
import threading
import unittest
import warnings
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import boto3
from pydantic import BaseModel
from strands import Agent, tool
from strands.hooks import BeforeModelCallEvent
from strands.models import BedrockModel
from caveman_cloud.middleware import Scope
from caveman_middleware.strands import with_caveman_agent, with_caveman_model
from evidence_runtime import EvidenceRuntime

ENDPOINT = os.environ["CAVEMAN_MIDDLEWARE_ENDPOINT"]
SOURCE = "".join(f"[INFO] café 🌍 row {i} retained-detail-{i} long repeated diagnostic\r\n" for i in range(140))


@tool
def read_logs() -> str:
    """Read the original diagnostic source."""
    return SOURCE


class Answer(BaseModel):
    answer: int


def aws_event(name, payload):
    headers = b""
    for key, value in ((":event-type", name), (":content-type", "application/json"), (":message-type", "event")):
        k, v = key.encode(), value.encode()
        headers += bytes([len(k)]) + k + b"\x07" + struct.pack(">H", len(v)) + v
    body = json.dumps(payload, ensure_ascii=False).encode()
    prelude = struct.pack(">II", 16 + len(headers) + len(body), len(headers))
    frame = prelude + struct.pack(">I", zlib.crc32(prelude)) + headers + body
    return frame + struct.pack(">I", zlib.crc32(frame))


class Provider:
    def __init__(self):
        self.calls, self.errors = [], []
        self.release = threading.Event()
        parent = self
        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            def log_message(self, *_):
                pass
            def do_POST(self):
                try:
                    body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                    parent.calls.append((self.path, body, self.headers.get("authorization", "")))
                    tools = body.get("toolConfig", {}).get("tools", [])
                    typed = next((t["toolSpec"] for t in tools if t["toolSpec"]["name"] not in ("read_logs", "caveman_retrieve")), None)
                    results = [p["toolResult"] for m in body["messages"] for p in m["content"] if "toolResult" in p]
                    source = next((r for r in results if r["toolUseId"] == "read-1"), None)
                    recovered = next((r for r in results if r["toolUseId"] == "recover-1"), None)
                    if typed:
                        content = [{"toolUse": {"toolUseId": "typed-1", "name": typed["name"], "input": {"answer": 42}}}]
                    elif source is None and any(t["toolSpec"]["name"] == "read_logs" for t in tools):
                        content = [{"toolUse": {"toolUseId": "read-1", "name": "read_logs", "input": {}}}]
                    elif source is not None:
                        text = source["content"][0]["text"]
                        handle = re.search(r"cmw_[a-f0-9]{48}", text)
                        if handle and not recovered:
                            assert "retained-detail-70" not in text
                            content = [{"toolUse": {"toolUseId": "recover-1", "name": "caveman_retrieve", "input": {"handle": handle[0]}}}]
                        else:
                            if recovered:
                                assert json.loads(recovered["content"][0]["text"])["text"] == SOURCE
                            else:
                                assert text == SOURCE
                            content = [{"text": "retained-detail-70"}]
                    else:
                        content = [{"text": "native"}]
                    stop = "tool_use" if "toolUse" in content[0] else "end_turn"
                    usage = {"inputTokens": 1000, "outputTokens": 20, "totalTokens": 1020}
                    self.send_response(200)
                    if self.path.endswith("converse-stream"):
                        self.send_header("content-type", "application/vnd.amazon.eventstream")
                        self.send_header("transfer-encoding", "chunked"); self.end_headers()
                        def send(name, value):
                            frame = aws_event(name, value)
                            self.wfile.write(f"{len(frame):x}\r\n".encode() + frame + b"\r\n"); self.wfile.flush()
                        send("messageStart", {"role": "assistant"})
                        if "toolUse" in content[0]:
                            call = content[0]["toolUse"]
                            send("contentBlockStart", {"contentBlockIndex": 0, "start": {"toolUse": {"toolUseId": call["toolUseId"], "name": call["name"]}}})
                            send("contentBlockDelta", {"contentBlockIndex": 0, "delta": {"toolUse": {"input": json.dumps(call["input"])}}})
                        else:
                            text = content[0]["text"]
                            send("contentBlockDelta", {"contentBlockIndex": 0, "delta": {"text": text[:9]}})
                            if not parent.release.wait(5):
                                parent.errors.append("Native consumer did not receive the first delta before the provider continuation deadline")
                            send("contentBlockDelta", {"contentBlockIndex": 0, "delta": {"text": text[9:]}})
                        send("contentBlockStop", {"contentBlockIndex": 0})
                        send("messageStop", {"stopReason": stop})
                        send("metadata", {"usage": usage, "metrics": {"latencyMs": 1}})
                        self.wfile.write(b"0\r\n\r\n"); self.wfile.flush()
                    else:
                        payload = json.dumps({"output": {"message": {"role": "assistant", "content": content}}, "stopReason": stop,
                            "usage": usage, "metrics": {"latencyMs": 1}}).encode()
                        self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(payload))); self.end_headers()
                        self.wfile.write(payload)
                except (BrokenPipeError, ConnectionResetError):
                    pass
                except BaseException as error:
                    parent.errors.append(str(error))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
    def model(self, streaming=False):
        return BedrockModel(boto_session=boto3.Session(aws_access_key_id="fixture", aws_secret_access_key="fixture", region_name="us-east-1"),
            endpoint_url=self.url, model_id="anthropic.fixture-v1", streaming=streaming)
    def __enter__(self):
        return self
    def __exit__(self, *_):
        self.release.set(); self.server.shutdown(); self.server.server_close(); self.thread.join(5)


def create(server, runtime, session, **kwargs):
    options = dict(model=server.model(kwargs.pop("streaming", False)), tools=[read_logs], callback_handler=None, **kwargs)
    return Agent(**with_caveman_agent(options, runtime=runtime, scope=Scope("strands", session)))


class NativeStrands(unittest.TestCase):
    def test_sync_native_recovery_and_original_history_then_off_and_outage(self):
        with Provider() as server, EvidenceRuntime(endpoint=ENDPOINT) as runtime:
            runtime.ready(); agent = create(server, runtime, "sync")
            result = agent("Read and recover row 70")
            self.assertEqual(result.message["content"], [{"text": "retained-detail-70"}])
            self.assertEqual(len(server.calls), 3)
            self.assertTrue(any(p.status == "optimized" for _, p in runtime.plans))
            saved = [p["toolResult"] for m in agent.messages for p in m["content"] if "toolResult" in p]
            self.assertEqual(next(r for r in saved if r["toolUseId"] == "read-1")["content"][0]["text"], SOURCE)
            self.assertTrue(all(auth.startswith("AWS4-HMAC-SHA256 ") for _, _, auth in server.calls))
            for mode, endpoint in (("off", ENDPOINT), ("compress", "http://127.0.0.1:1")):
                with EvidenceRuntime(endpoint=endpoint, mode=mode) as bypass:
                    before = len(server.calls)
                    self.assertEqual(create(server, bypass, mode)("Read source").message["content"], [{"text": "retained-detail-70"}])
                    self.assertEqual(len(server.calls) - before, 2)
            self.assertEqual(server.errors, [])

    def test_structured_output_gap_is_covered_without_changing_forced_schema(self):
        with Provider() as server, EvidenceRuntime(endpoint=ENDPOINT) as runtime:
            agent = create(server, runtime, "structured")
            events = []; agent.add_hook(lambda e: events.append(e), BeforeModelCallEvent)
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", DeprecationWarning)
                result = agent.structured_output(Answer, "Return 42")
            self.assertEqual(result, Answer(answer=42))
            self.assertEqual(events, [])
            self.assertEqual(len(runtime.plans), 1, "lower model wrapper covers the native hook gap")
            self.assertEqual(len(server.calls[0][1]["toolConfig"]["tools"]), 1)
            self.assertEqual(server.errors, [])


class AsyncNativeStrands(unittest.IsolatedAsyncioTestCase):
    async def test_certifies_exact_f09_native_operations(self):
        from _certification_native import certify_all
        await certify_all(self)

    async def test_async_agents_scope_isolation_and_native_stream_first_chunk(self):
        with Provider() as server, EvidenceRuntime(endpoint=ENDPOINT) as runtime:
            runtime.ready()
            agents = [create(server, runtime, f"async-{i}") for i in range(2)]
            results = await asyncio.gather(*(a.invoke_async("Read source") for a in agents))
            self.assertEqual([r.message["content"] for r in results], [[{"text": "retained-detail-70"}]] * 2)
            handles = {r["handle"] for _, p in runtime.plans for r in p.replacements if "handle" in r}
            self.assertEqual(len({r["scope"]["session_id"] for r in runtime.receipts}), 2)
            stream = create(server, runtime, "stream", streaming=True).stream_async("Read source")
            text, events = "", []
            async for event in stream:
                events.append(event)
                if "data" in event:
                    text += event["data"]
                    if text == "retained-":
                        self.assertFalse(server.release.is_set())
                        server.release.set()
            self.assertEqual(text, "retained-detail-70")
            self.assertTrue(any(path.endswith("converse-stream") for path, _, _ in server.calls))
            self.assertEqual(server.errors, [])


if __name__ == "__main__":
    from _test_result import ReportingResult
    unittest.main(verbosity=2, testRunner=unittest.TextTestRunner(verbosity=2, resultclass=ReportingResult))
