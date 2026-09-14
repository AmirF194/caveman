"""Deterministic HTTP inference fixture; no framework or optimizer substitution."""
import hashlib
import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from crewai import LLM

SOURCE = "".join(f"[INFO] café 🌍 row {i} retained-detail-{i} long repeated diagnostic\r\n" for i in range(140))
FACT = "retained-detail-70"

class Provider:
    def __init__(self, *, parallel=False, repeat_read=False, structured=False, delegate_to=None, read_args=None, followups=0):
        self.parallel = parallel
        self.repeat_read, self.structured, self.delegate_to = repeat_read, structured, delegate_to
        self.read_args = read_args or {}
        self.followups = followups
        self.calls, self.errors, self.responses = [], [], []
        self.release = threading.Event()
        self.first_delta = threading.Event()
        self.cancel_entered = threading.Event()
        self.cancel_release = threading.Event()
        parent = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def handle(self):
                try:
                    super().handle()
                except (BrokenPipeError, ConnectionResetError):
                    pass  # Expected when the native client cancels a stream.

            def log_message(self, *_):
                pass

            def do_POST(self):
                try:
                    raw = self.rfile.read(int(self.headers["content-length"]))
                    body = json.loads(raw)
                    parent.calls.append({"path": self.path, "body": body, "raw": raw, "headers": dict(self.headers)})
                    anthropic = self.path.rstrip("/").endswith("messages")
                    users = [m.get("content") for m in body["messages"] if m["role"] == "user" and isinstance(m.get("content"), str)]
                    if users and users[-1] == "fail":
                        self.send_json({"error": {"message": "native failure", "type": "server_error"}}, 500)
                        return
                    if users and users[-1] == "cancel":
                        parent.cancel_entered.set()
                        parent.cancel_release.wait(5)
                    tools = body.get("tools", [])
                    names = [t["name"] if anthropic else t["function"]["name"] for t in tools]
                    if anthropic:
                        results = [p for m in body["messages"] if isinstance(m.get("content"), list)
                                   for p in m["content"] if p.get("type") == "tool_result"]
                        source = next((p["content"] for p in results if p["tool_use_id"] == "read-1"), None)
                        recovered = next((p["content"] for p in results if p["tool_use_id"] == "recover-1"), None)
                    else:
                        results = [m for m in body["messages"] if m["role"] == "tool"]
                        source = next((m["content"] for m in results if m["tool_call_id"] == "read-1"), None)
                        recovered = next((m["content"] for m in results if m["tool_call_id"] == "recover-1"), None)
                    result_ids = [p["tool_use_id"] if anthropic else p["tool_call_id"] for p in results]
                    function = None
                    text = "native"
                    if body.get("response_format") or body.get("output_config"):
                        text = json.dumps({"answer": FACT})
                    elif parent.delegate_to:
                        if "delegate-1" not in result_ids:
                            name = next(name for name in names if name.startswith("delegate_work"))
                            function = ("delegate-1", name, {"coworker": parent.delegate_to, "task": "Read the original diagnostic source", "context": "Delegated context café 🌍"})
                        else:
                            delegated = next(p["content"] for p in results if (p["tool_use_id"] if anthropic else p["tool_call_id"]) == "delegate-1")
                            assert delegated == FACT
                            text = FACT
                    elif source is None and "read_logs" in names:
                        function = ("read-1", "read_logs", parent.read_args)
                    elif source is not None:
                        handle = re.search(r"cmw_[a-f0-9]{48}", source)
                        if parent.repeat_read and "read-cache" not in result_ids:
                            function = ("read-cache", "read_logs", parent.read_args)
                        elif handle and recovered is None:
                            assert FACT not in source, "the recovery question must require omitted source content"
                            function = ("recover-1", "caveman_retrieve", {"handle": handle[0], "offset": 0, "limit": 262144, "query": ""})
                        else:
                            if recovered is not None:
                                page = json.loads(recovered)
                                assert page["text"].encode() == SOURCE.encode(), "native recovery lost exact UTF-8 source bytes"
                                assert page["complete"] is True
                                assert page["next_offset"] is None
                                assert page["original_sha256"] == hashlib.sha256(SOURCE.encode()).hexdigest()
                                assert page["source_id"], "recovery must preserve source identity"
                            else:
                                assert source == SOURCE
                            text = FACT
                    progress = sum(ident.startswith("progress-") for ident in result_ids)
                    if function is None and text == FACT and progress < parent.followups:
                        function = (f"progress-{progress}", "read_progress", {"index": progress})
                    if parent.structured and function is None:
                        text = json.dumps({"answer": FACT})
                    if anthropic:
                        self.anthropic_response(body, function, text)
                    else:
                        self.openai_response(body, function, text)
                except (BrokenPipeError, ConnectionResetError):
                    pass
                except BaseException as error:
                    parent.errors.append(f"{type(error).__name__}: {error}")
                    try:
                        self.send_json({"error": {"message": "local fixture assertion failed", "type": "server_error"}}, 500)
                    except (BrokenPipeError, ConnectionResetError):
                        pass

            def send_json(self, value, status=200):
                encoded = json.dumps(value, ensure_ascii=False).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def stream(self, before, after, gate=False):
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.send_header("content-length", str(len(before) + len(after)))
                self.end_headers()
                self.wfile.write(before)
                self.wfile.flush()
                parent.first_delta.set()
                if gate and not parent.release.wait(5):
                    parent.errors.append("native consumer did not receive a delta before provider completion was released")
                self.wfile.write(after)
                self.wfile.flush()

            def openai_response(self, body, function, text):
                parent.responses.append({"protocol": "openai", "function": function, "text": text, "stream": bool(body.get("stream"))})
                base = {"id": "chatcmpl-fixture", "created": 1, "model": body["model"]}
                tokens = {"prompt_tokens": 1000, "completion_tokens": 20, "total_tokens": 1020}
                message = {"role": "assistant", "content": text}
                stop = "stop"
                if function:
                    ident, name, args = function
                    message = {"role": "assistant", "content": None, "tool_calls": [{"id": ident, "type": "function",
                        "function": {"name": name, "arguments": json.dumps(args)}}]}
                    if parent.parallel and name == "read_logs":
                        message["tool_calls"].append({"id": "read-2", "type": "function", "function": {"name": "read_other", "arguments": "{}"}})
                    stop = "tool_calls"
                if not body.get("stream"):
                    self.send_json({**base, "object": "chat.completion", "choices": [{"index": 0, "message": message,
                        "finish_reason": stop, "logprobs": None}], "usage": tokens})
                    return

                def event(delta, finish=None, usage=None):
                    payload = {**base, "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
                    if usage:
                        payload["usage"] = usage
                    return ("data: " + json.dumps(payload) + "\n\n").encode()

                if function:
                    call = message["tool_calls"][0]
                    args = call["function"]["arguments"]
                    before = event({"role": "assistant", "tool_calls": [{"index": 0, **call, "function": {"name": call["function"]["name"], "arguments": args[:1]}}]})
                    after = event({"tool_calls": [{"index": 0, "function": {"arguments": args[1:]}}]})
                else:
                    before, after = event({"role": "assistant", "content": text[:3]}), event({"content": text[3:]})
                measured = not any(m.get("content") == "no_usage" for m in body["messages"])
                after += event({}, stop, tokens if measured else None) + b"data: [DONE]\n\n"
                self.stream(before, after, gate=function is None)

            def anthropic_response(self, body, function, text):
                parent.responses.append({"protocol": "anthropic", "function": function, "text": text, "stream": bool(body.get("stream"))})
                content = [{"type": "text", "text": text}]
                stop = "end_turn"
                if function:
                    ident, name, args = function
                    content = [{"type": "tool_use", "id": ident, "name": name, "input": args}]
                    if parent.parallel and name == "read_logs":
                        content.append({"type": "tool_use", "id": "read-2", "name": "read_other", "input": {}})
                    stop = "tool_use"
                message = {"id": "msg-fixture", "type": "message", "role": "assistant", "model": body["model"], "content": content,
                    "stop_reason": stop, "stop_sequence": None, "usage": {"input_tokens": 1000, "output_tokens": 20}}
                if not body.get("stream"):
                    self.send_json(message)
                    return

                def event(kind, **fields):
                    return ("event: " + kind + "\ndata: " + json.dumps({"type": kind, **fields}) + "\n\n").encode()

                before = event("message_start", message={**message, "content": [], "stop_reason": None})
                if function:
                    before += event("content_block_start", index=0, content_block={**content[0], "input": {}})
                    args = json.dumps(content[0]["input"])
                    before += event("content_block_delta", index=0, delta={"type": "input_json_delta", "partial_json": args[:1]})
                    after = event("content_block_delta", index=0, delta={"type": "input_json_delta", "partial_json": args[1:]})
                else:
                    before += event("content_block_start", index=0, content_block={"type": "text", "text": ""})
                    before += event("content_block_delta", index=0, delta={"type": "text_delta", "text": text[:3]})
                    after = event("content_block_delta", index=0, delta={"type": "text_delta", "text": text[3:]})
                after += event("content_block_stop", index=0)
                after += event("message_delta", delta={"stop_reason": stop, "stop_sequence": None}, usage={"output_tokens": 20})
                after += event("message_stop")
                self.stream(before, after, gate=function is None)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=0.01), daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def model(self, protocol="openai", **kwargs):
        model = "anthropic/claude-3-5-haiku-20241022" if protocol == "anthropic" else "openai/gpt-4o-mini"
        options = {"model": model, "api_key": "fixture-provider-key", "max_retries": 0, "timeout": 5, "temperature": 0.2, **kwargs}
        return LLM(base_url=self.url + ("" if protocol == "anthropic" else "/v1"), **options)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.release.set()
        self.cancel_release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)
