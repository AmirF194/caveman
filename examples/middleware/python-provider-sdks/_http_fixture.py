"""Deterministic provider HTTP, including native SSE and observable socket close."""
from __future__ import annotations

import json
import re
import select
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SOURCE = "".join(f"[INFO] café 🌍 row {i} retained-detail-{i} long repeated diagnostic\r\n" for i in range(140))
FACT = "retained-detail-70"
USAGE = {"input_tokens": 1000, "output_tokens": 20, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 0}


def history(protocol):
    if protocol == "openai-chat":
        return [{"role": "user", "content": "Read source"}, {"role": "assistant", "content": None, "tool_calls": [{"id": "read-1", "type": "function", "function": {"name": "read_logs", "arguments": "{}"}}]}, {"role": "tool", "tool_call_id": "read-1", "content": SOURCE}]
    if protocol == "openai-responses":
        return [{"role": "user", "content": "Read source"}, {"type": "function_call", "call_id": "read-1", "name": "read_logs", "arguments": "{}"}, {"type": "function_call_output", "call_id": "read-1", "output": SOURCE}]
    return [{"role": "user", "content": "Read source"}, {"role": "assistant", "content": [{"type": "tool_use", "id": "read-1", "name": "read_logs", "input": {}}]}, {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "read-1", "content": SOURCE}]}]


def definitions(protocol):
    native = {"name": "read_logs", "description": "Read source", "parameters": {"type": "object", "properties": {}, "additionalProperties": False}}
    if protocol == "openai-chat":
        return [{"type": "function", "function": native}]
    if protocol == "openai-responses":
        return [{"type": "function", **native}]
    return [{"name": native["name"], "description": native["description"], "input_schema": native["parameters"]}]


def results(body, protocol):
    if protocol == "openai-chat":
        return {message["tool_call_id"]: message["content"] for message in body.get("messages", []) if message.get("role") == "tool"}
    if protocol == "openai-responses":
        return {item["call_id"]: item["output"] for item in body.get("input", []) if isinstance(item, dict) and item.get("type") == "function_call_output"}
    return {part["tool_use_id"]: part["content"] for message in body.get("messages", []) if isinstance(message.get("content"), list) for part in message["content"] if isinstance(part, dict) and part.get("type") == "tool_result"}


class Provider:
    def __init__(self, protocol, *, pause=None, transient_failures=0, broken_stream=False):
        self.protocol, self.calls, self.errors, self.responses = protocol, [], [], []
        self.headers_sent = threading.Event()
        self.first_sent = threading.Event()
        self.release = threading.Event()
        self.pause = pause
        if pause is None:
            self.release.set()
        self.sockets = []
        parent = self
        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            def log_message(self, *_):
                pass
            def do_GET(self):
                self.respond()
            def do_DELETE(self):
                self.respond()
            def do_POST(self):
                self.respond()
            def respond(self):
                try:
                    raw = self.rfile.read(int(self.headers.get("content-length", "0")))
                    try:
                        body = json.loads(raw) if raw else {}
                    except ValueError:
                        body = {}
                    parent.calls.append({"method": self.command, "path": self.path, "body": body, "raw": raw.decode("utf-8", "replace"), "headers": dict(self.headers)})
                    parent.sockets.append(self.connection)
                    self.close_connection = True
                    path = self.path.split("?", 1)[0]
                    if len(parent.calls) <= transient_failures:
                        return self.send_json({"error": {"type": "server_error", "message": "deterministic retryable failure"}}, 503)
                    if body.get("model") == "failure":
                        return self.send_json({"error": {"type": "invalid_request_error", "message": "deterministic native failure"}}, 400)
                    if path.endswith("count_tokens") or path.endswith("input_tokens"):
                        return self.send_json({"input_tokens": 7})
                    if path.endswith("/batches"):
                        return self.send_json({"id": "batch_fixture", "object": "batch", "type": "message_batch", "status": "validating", "processing_status": "in_progress", "request_counts": {"processing": 1, "succeeded": 0, "errored": 0, "canceled": 0, "expired": 0}})
                    if path.endswith("/embeddings"):
                        return self.send_json({"object": "list", "data": [{"object": "embedding", "index": 0, "embedding": [1.0, 2.0]}], "model": "fixture-model", "usage": {"prompt_tokens": 7, "total_tokens": 7}})
                    if self.command == "GET" or path.endswith("/cancel"):
                        return self.send_json(parent.response(body, text="native"))
                    if path.endswith("/compact"):
                        return self.send_json({"id": "compact_fixture", "object": "response.compaction", "created_at": 1, "output": [{"type": "compaction", "id": "opaque_compaction", "encrypted_content": "opaque-signed-payload"}], "usage": {"input_tokens": 7, "output_tokens": 2, "total_tokens": 9}})
                    answer, call = parent.answer(body)
                    result = parent.response(body, text=answer, call=call)
                    if not body.get("stream"):
                        return self.send_json(result)
                    self.send_response(200)
                    self.send_header("content-type", "text/event-stream")
                    self.send_header("connection", "close")
                    self.send_header("x-request-id", "fixture-openai")
                    self.send_header("request-id", "fixture-anthropic")
                    if broken_stream:
                        self.send_header("content-length", "1000000")
                    self.end_headers()
                    self.wfile.flush()
                    parent.headers_sent.set()
                    if parent.pause == "headers":
                        parent.release.wait(5)
                    for index, event in enumerate(parent.events(result)):
                        self.wfile.write(event)
                        self.wfile.flush()
                        if index == 0:
                            parent.first_sent.set()
                            if parent.pause == "first":
                                parent.release.wait(5)
                        if broken_stream and index == 1:
                            return
                    return
                except (BrokenPipeError, ConnectionResetError):
                    pass
                except BaseException as error:
                    parent.errors.append(repr(error))
            def send_json(self, value, status=200):
                payload = json.dumps(value, ensure_ascii=False).encode()
                parent.responses.append({"status": status, "raw": payload.decode()})
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(payload)))
                self.send_header("connection", "close")
                self.send_header("x-request-id", "fixture-openai")
                self.send_header("request-id", "fixture-anthropic")
                if status == 503:
                    self.send_header("retry-after-ms", "1")
                self.end_headers()
                self.wfile.write(payload)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def answer(self, body):
        if body.get("model") == "parse":
            return '{"answer":42}', None
        if body.get("model") != "loop":
            return "native", None
        found = results(body, self.protocol)
        if "read-1" not in found:
            return None, ("read_logs", "read-1", {})
        source = found["read-1"]
        handle = re.search(r"cmw_[a-f0-9]{48}", source) if isinstance(source, str) else None
        if handle and "recover-1" not in found:
            assert FACT not in source
            return None, ("caveman_retrieve", "recover-1", {"handle": handle[0]})
        if "recover-1" in found:
            assert json.loads(found["recover-1"])["text"] == SOURCE
        else:
            assert source == SOURCE
        return FACT, None

    def response(self, body, *, text, call=None):
        index = len(self.calls)
        if self.protocol == "openai-chat":
            return {"id": f"chatcmpl_{index}", "object": "chat.completion", "created": 1, "model": "fixture-model", "choices": [{"index": 0, "message": {"role": "assistant", "content": text, **({"tool_calls": [{"type": "function", "id": call[1], "function": {"name": call[0], "arguments": json.dumps(call[2])}}]} if call else {})}, "finish_reason": "tool_calls" if call else "stop", "logprobs": None}], "usage": {"prompt_tokens": 1000, "completion_tokens": 20, "total_tokens": 1020, "prompt_tokens_details": {"cached_tokens": 100}}}
        if self.protocol == "openai-responses":
            item = {"id": "fc_" + call[1], "type": "function_call", "call_id": call[1], "name": call[0], "arguments": json.dumps(call[2]), "status": "completed"} if call else {"id": "msg_output", "type": "message", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": text, "annotations": [], "logprobs": []}]}
            return {"id": f"resp_{index}", "object": "response", "created_at": 1, "status": "completed", "model": "fixture-model", "output": [item], "usage": {"input_tokens": 1000, "output_tokens": 20, "total_tokens": 1020, "input_tokens_details": {"cached_tokens": 100}, "output_tokens_details": {"reasoning_tokens": 0}}, "error": None, "incomplete_details": None}
        content = [{"type": "tool_use", "id": call[1], "name": call[0], "input": call[2]}] if call else [{"type": "text", "text": text}]
        return {"id": f"msg_{index}", "type": "message", "role": "assistant", "model": "claude-sonnet-4-6", "content": content, "stop_reason": "tool_use" if call else "end_turn", "stop_sequence": None, "usage": USAGE}

    def events(self, result):
        def event(kind, **fields):
            value = {"type": kind, **fields}
            return f"event: {kind}\ndata: {json.dumps(value)}\n\n".encode()
        if self.protocol == "openai-chat":
            choice = result["choices"][0]
            message = choice["message"]
            common = {"id": result["id"], "object": "chat.completion.chunk", "created": 1, "model": result["model"]}
            deltas = [{"role": "assistant"}]
            if message.get("tool_calls"):
                tool = message["tool_calls"][0]
                args = tool["function"]["arguments"]
                deltas += [{"tool_calls": [{"index": 0, "id": tool["id"], "type": "function", "function": {"name": tool["function"]["name"], "arguments": args[:1]}}]}, {"tool_calls": [{"index": 0, "function": {"arguments": args[1:]}}]}]
            else:
                text = message["content"]
                deltas += [{"content": text[:3]}, {"content": text[3:]}]
            for delta in deltas:
                yield ("data: " + json.dumps({**common, "choices": [{"index": 0, "delta": delta, "finish_reason": None}]}) + "\n\n").encode()
            yield ("data: " + json.dumps({**common, "choices": [{"index": 0, "delta": {}, "finish_reason": choice["finish_reason"]}], "usage": result["usage"]}) + "\n\n").encode()
            yield b"data: [DONE]\n\n"
            return
        if self.protocol == "openai-responses":
            sequence = 0
            def response_event(kind, **fields):
                nonlocal sequence
                sequence += 1
                return event(kind, sequence_number=sequence, **fields)
            item = result["output"][0]
            yield response_event("response.created", response={**result, "status": "in_progress", "output": [], "usage": None})
            yield response_event("response.output_item.added", output_index=0, item={**item, **({"arguments": ""} if item["type"] == "function_call" else {"content": []}), "status": "in_progress"})
            if item["type"] == "function_call":
                args = item["arguments"]
                for delta in [args[:1], args[1:]]:
                    yield response_event("response.function_call_arguments.delta", output_index=0, item_id=item["id"], delta=delta)
                yield response_event("response.function_call_arguments.done", output_index=0, item_id=item["id"], name=item["name"], arguments=args)
            else:
                part = item["content"][0]
                yield response_event("response.content_part.added", output_index=0, item_id=item["id"], content_index=0, part={**part, "text": ""})
                for delta in [part["text"][:3], part["text"][3:]]:
                    yield response_event("response.output_text.delta", output_index=0, item_id=item["id"], content_index=0, delta=delta, logprobs=[])
                yield response_event("response.output_text.done", output_index=0, item_id=item["id"], content_index=0, text=part["text"], logprobs=[])
                yield response_event("response.content_part.done", output_index=0, item_id=item["id"], content_index=0, part=part)
            yield response_event("response.output_item.done", output_index=0, item=item)
            yield response_event("response.completed", response=result)
            return
        part = result["content"][0]
        yield event("message_start", message={**result, "content": [], "stop_reason": None})
        yield event("content_block_start", index=0, content_block={**part, **({"input": {}} if part["type"] == "tool_use" else {"text": ""})})
        value = json.dumps(part["input"]) if part["type"] == "tool_use" else part["text"]
        for delta in [value[:1], value[1:]]:
            yield event("content_block_delta", index=0, delta={"type": "input_json_delta", "partial_json": delta} if part["type"] == "tool_use" else {"type": "text_delta", "text": delta})
        yield event("content_block_stop", index=0)
        yield event("message_delta", delta={"stop_reason": result["stop_reason"], "stop_sequence": None}, usage={"output_tokens": 20})
        yield event("message_stop")

    def peer_closed(self, timeout=0.2):
        connection = self.sockets[-1]
        try:
            if connection.fileno() < 0:
                return True
            readable, _, _ = select.select([connection], [], [], timeout)
            return bool(readable) and connection.recv(1, socket.MSG_PEEK) == b""
        except (OSError, ValueError):
            return True

    def close(self):
        self.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)
    def __enter__(self):
        return self
    def __exit__(self, *_):
        self.close()
