"""Loopback provider wire fixtures for installed native Strands provider models."""
import json
import re
import select
import socket
import struct
import threading
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import boto3
from botocore.config import Config
from strands.models import BedrockModel
from strands.models.openai import OpenAIModel
from strands.models.anthropic import AnthropicModel

FACT = "retained-detail-70"
SOURCES = {name: "".join(f"[INFO] café 🌍 {name} row {i} retained-detail-{i} long repeated diagnostic\r\n" for i in range(140))
           for name in ("read_logs", "read_aux")}
HANDLE = re.compile(r"cmw_[a-f0-9]{48}")


def native_results(body, protocol):
    if protocol == "openai":
        return [{"id": m["tool_call_id"], "text": m["content"]} for m in body["messages"] if m["role"] == "tool"]
    if protocol == "anthropic":
        return [{"id": p["tool_use_id"], "text": p["content"] if isinstance(p["content"], str)
                 else "".join(v["text"] for v in p["content"] if v["type"] == "text")}
                for m in body["messages"] if isinstance(m["content"], list) for p in m["content"] if p["type"] == "tool_result"]
    return [{"id": p["toolResult"]["toolUseId"], "text": "".join(v.get("text", "") for v in p["toolResult"]["content"])}
            for m in body["messages"] for p in m["content"] if "toolResult" in p]


def native_tools(body, protocol):
    if protocol == "openai":
        return [{"name": t["function"]["name"], "schema": t["function"]["parameters"]} for t in body.get("tools", [])]
    if protocol == "anthropic":
        return [{"name": t["name"], "schema": t["input_schema"]} for t in body.get("tools", [])]
    return [{"name": t["toolSpec"]["name"], "schema": t["toolSpec"]["inputSchema"]["json"]} for t in body.get("toolConfig", {}).get("tools", [])]


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
    def __init__(self, protocol, *, parallel=False, gate_text=False):
        self.protocol, self.parallel = protocol, parallel
        self.calls, self.actions, self.errors, self.models = [], [], [], []
        self.handles, self.resume, self.structured = {}, False, False
        self.closed_before_eof = False
        self.release = threading.Event()
        if not gate_text:
            self.release.set()
        parent = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_):
                pass

            def do_POST(self):
                try:
                    body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                    parent.calls.append({"path": self.path, "body": body, "headers": dict(self.headers)})
                    assert len(parent.calls) <= 8, "Bounded native fixture refused an unexpected provider loop"
                    if protocol == "bedrock":
                        assert self.headers["authorization"].startswith("AWS4-HMAC-SHA256 ")
                        assert "native-fixture" in self.headers["user-agent"]
                        assert self.path.endswith(("/converse-stream", "/converse"))
                    else:
                        assert self.headers["x-native-strands"] == "preserved"
                        assert self.path == ("/v1/chat/completions" if protocol == "openai" else "/v1/messages")
                        assert (self.headers["authorization"] == "Bearer fixture" if protocol == "openai" else self.headers["x-api-key"] == "fixture")
                    answer = parent.choose(body)
                    calls = answer.get("calls")
                    parent.actions.append({"type": "tool_calls" if calls else "text", "ids": [c["id"] for c in calls] if calls else [], "value": answer.get("text")})
                    if protocol == "openai" and body.get("stream") is not True:
                        payload = {"id": "chat-native", "object": "chat.completion", "created": 1, "model": "fixture-model", "choices": [{"index": 0,
                            "message": {"role": "assistant", "content": answer["text"]}, "finish_reason": "stop"}],
                            "usage": {"prompt_tokens": 1000, "completion_tokens": 20, "total_tokens": 1020}}
                        data = json.dumps(payload).encode()
                        self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(data))); self.send_header("connection", "close"); self.end_headers(); self.wfile.write(data)
                        return
                    self.send_response(200)
                    self.send_header("content-type", "application/vnd.amazon.eventstream" if protocol == "bedrock" else "text/event-stream")
                    self.send_header("transfer-encoding", "chunked"); self.send_header("connection", "close"); self.end_headers()

                    def send(data):
                        data = data.encode() if isinstance(data, str) else data
                        self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n"); self.wfile.flush()

                    def wait():
                        for _ in range(400):
                            if parent.release.wait(0.01):
                                return
                            if select.select([self.connection], [], [], 0)[0]:
                                try:
                                    if self.connection.recv(1, socket.MSG_PEEK) == b"":
                                        parent.closed_before_eof = True
                                        return
                                except (ConnectionResetError, OSError):
                                    parent.closed_before_eof = True
                                    return
                        raise AssertionError("Native consumer did not release the provider after observing its first delta")

                    if protocol == "openai":
                        def event(delta, finish=None, **extra):
                            send("data: " + json.dumps({"id": "chat-native", "object": "chat.completion.chunk", "created": 1, "model": "fixture-model",
                                 "choices": [{"index": 0, "delta": delta, "finish_reason": finish}], **extra}) + "\n\n")
                        event({"role": "assistant"})
                        if calls:
                            for index, call in enumerate(calls):
                                event({"tool_calls": [{"index": index, "id": call["id"], "type": "function", "function": {"name": call["name"], "arguments": json.dumps(call["input"])}}]})
                        else:
                            event({"content": answer["text"][:9]}); wait(); event({"content": answer["text"][9:]})
                        event({}, "tool_calls" if calls else "stop", usage={"prompt_tokens": 1000, "completion_tokens": 20, "total_tokens": 1020}); send("data: [DONE]\n\n")
                    elif protocol == "anthropic":
                        def event(name, value):
                            send(f"event: {name}\ndata: " + json.dumps({"type": name, **value}) + "\n\n")
                        event("message_start", {"message": {"id": "msg-native", "type": "message", "role": "assistant", "model": "fixture-model", "content": [], "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 1000, "output_tokens": 0}}})
                        if calls:
                            for index, call in enumerate(calls):
                                event("content_block_start", {"index": index, "content_block": {"type": "tool_use", "id": call["id"], "name": call["name"], "input": {}}})
                                event("content_block_delta", {"index": index, "delta": {"type": "input_json_delta", "partial_json": json.dumps(call["input"])}}); event("content_block_stop", {"index": index})
                        else:
                            event("content_block_start", {"index": 0, "content_block": {"type": "text", "text": ""}})
                            event("content_block_delta", {"index": 0, "delta": {"type": "text_delta", "text": answer["text"][:9]}}); wait()
                            event("content_block_delta", {"index": 0, "delta": {"type": "text_delta", "text": answer["text"][9:]}}); event("content_block_stop", {"index": 0})
                        event("message_delta", {"delta": {"stop_reason": "tool_use" if calls else "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 20}}); event("message_stop", {})
                    else:
                        def event(name, value):
                            send(aws_event(name, value))
                        event("messageStart", {"role": "assistant"})
                        if calls:
                            for index, call in enumerate(calls):
                                event("contentBlockStart", {"contentBlockIndex": index, "start": {"toolUse": {"toolUseId": call["id"], "name": call["name"]}}})
                                event("contentBlockDelta", {"contentBlockIndex": index, "delta": {"toolUse": {"input": json.dumps(call["input"])}}}); event("contentBlockStop", {"contentBlockIndex": index})
                        else:
                            event("contentBlockDelta", {"contentBlockIndex": 0, "delta": {"text": answer["text"][:9]}}); wait()
                            event("contentBlockDelta", {"contentBlockIndex": 0, "delta": {"text": answer["text"][9:]}}); event("contentBlockStop", {"contentBlockIndex": 0})
                        event("messageStop", {"stopReason": "tool_use" if calls else "end_turn"}); event("metadata", {"usage": {"inputTokens": 1000, "outputTokens": 20, "totalTokens": 1020}, "metrics": {"latencyMs": 1}})
                    self.wfile.write(b"0\r\n\r\n"); self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    parent.closed_before_eof = not parent.release.is_set()
                except BaseException as error:
                    parent.errors.append(str(error))
                    self.close_connection = True

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=0.01), daemon=True); self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def choose(self, body):
        tools, results = native_tools(body, self.protocol), native_results(body, self.protocol)
        if self.structured:
            for result in results:
                if result["id"].startswith("read-"):
                    assert result["text"] == SOURCES["read_logs" if result["id"] == "read-1" else "read_aux"]
            assert not any(t["name"] == "caveman_retrieve" for t in tools)
            if self.protocol == "openai":
                schema = body["response_format"]["json_schema"]["schema"]
                assert schema["properties"]["answer"]["type"] == "integer"
                self.actions.append({"type": "structured", "schema": schema, "choice": body["response_format"]["type"]})
                return {"text": json.dumps({"answer": 42})}
            typed = next(t for t in tools if t["name"] not in ("read_logs", "read_aux", "caveman_retrieve"))
            choice = body.get("tool_choice") if self.protocol == "anthropic" else body["toolConfig"]["toolChoice"]
            assert "answer" in typed["schema"]["properties"]
            self.actions.append({"type": "structured", "schema": typed["schema"], "choice": choice})
            return {"calls": [{"id": "typed-1", "name": typed["name"], "input": {"answer": 42}}]}
        if not any(r["id"] == "read-1" for r in results):
            return {"calls": [{"id": "read-1", "name": "read_logs", "input": {"marker": "native-main"}},
                *([{"id": "read-2", "name": "read_aux", "input": {"marker": "native-aux"}}] if self.parallel else [])]}
        for source_id, name in [("read-1", "read_logs"), *([("read-2", "read_aux")] if self.parallel else [])]:
            result = next(r for r in results if r["id"] == source_id)
            handle = HANDLE.search(result["text"])
            recovered = next((r for r in results if r["id"] == f"recover-{source_id}"), None)
            if handle:
                assert FACT not in result["text"]
                self.handles[source_id] = handle[0]
                if recovered is None:
                    self.actions.append({"type": "recover", "source": source_id, "handle": handle[0]})
                    return {"calls": [{"id": f"recover-{source_id}", "name": "caveman_retrieve", "input": {"handle": handle[0]}}]}
                assert json.loads(recovered["text"])["text"] == SOURCES[name]
            else:
                assert result["text"] == SOURCES[name]
        if self.resume and self.handles.get("read-1") and not any(r["id"] == "recover-resume" for r in results):
            self.actions.append({"type": "recover_resume", "source": "read-1", "handle": self.handles["read-1"]})
            return {"calls": [{"id": "recover-resume", "name": "caveman_retrieve", "input": {"handle": self.handles["read-1"]}}]}
        resumed = next((r for r in results if r["id"] == "recover-resume"), None)
        if resumed:
            assert json.loads(resumed["text"])["text"] == SOURCES["read_logs"]
        return {"text": FACT}

    def model(self):
        args = {"api_key": "fixture", "base_url": self.url + ("/v1" if self.protocol == "openai" else ""), "max_retries": 0, "default_headers": {"x-native-strands": "preserved"}}
        if self.protocol == "openai":
            model = OpenAIModel(model_id="fixture-model", params={"max_tokens": 256}, client_args=args)
        elif self.protocol == "anthropic":
            model = AnthropicModel(model_id="fixture-model", max_tokens=256, client_args=args)
        else:
            model = BedrockModel(boto_session=boto3.Session(aws_access_key_id="fixture", aws_secret_access_key="fixture", region_name="us-east-1"),
                endpoint_url=self.url, model_id="anthropic.fixture-v1", streaming=True, max_tokens=256,
                boto_client_config=Config(user_agent_extra="native-fixture", retries={"max_attempts": 0}))
        self.models.append(model)
        return model

    async def close(self):
        self.release.set()
        self.server.shutdown(); self.server.server_close(); self.thread.join(2)
        for model in self.models:
            if self.protocol == "anthropic":
                await model.client.close()
            elif self.protocol == "bedrock":
                model.client.close()
