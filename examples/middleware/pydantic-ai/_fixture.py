"""Native SDK HTTP protocol fixtures; no provider inference is made."""
import json
import re
import threading
import httpx2

SOURCE = "".join(f"[INFO] café 🌍 row {i} retained-detail-{i} long repeated diagnostic\r\n" for i in range(140))

def text_content(content):
    if isinstance(content, str):
        return content
    return "".join(part["text"] for part in (content or []) if part.get("type") == "text")


class Fixture:
    def __init__(self, protocol, *, structured=False, reasoning=False, suspended=False, pause_content="thinking"):
        self.protocol, self.structured, self.reasoning = protocol, structured, reasoning
        self.suspended = suspended
        self.pause_content = pause_content
        self.calls = []
        self.release = threading.Event()
        self.finished = False

    @property
    def released(self):
        return self.release.is_set()

    def response(self, request):
        body = json.loads(request.content)
        self.calls.append((request, body))
        if len(self.calls) > 12:
            raise AssertionError("native fixture exceeded its provider-call budget")
        if request.url.path.endswith("count_tokens"):
            return httpx2.Response(200, json={"input_tokens": 7})
        if body["model"] == "failure":
            return httpx2.Response(500, json={"error": {"message": "native failure", "type": "server_error"}})
        if self.protocol == "openai":
            ids = {call["id"]: call["function"]["name"] for message in body["messages"] for call in message.get("tool_calls", [])}
            results = {ids.get(message["tool_call_id"]): message["content"] for message in body["messages"] if message["role"] == "tool"}
            names = [tool.get("function", {}).get("name") for tool in body.get("tools", [])]
        else:
            ids = {part["id"]: part["name"] for message in body["messages"] if isinstance(message["content"], list)
                   for part in message["content"] if part["type"] == "tool_use"}
            results = {ids.get(part["tool_use_id"]): part["content"] for message in body["messages"] if isinstance(message["content"], list)
                       for part in message["content"] if part["type"] == "tool_result"}
            names = [tool.get("name") for tool in body.get("tools", [])]
        if "read_logs" in results and "retry-guard" in text_content(results["read_logs"]):
            results.pop("read_logs")
        call = None
        content = '{"answer":42}' if self.structured else "native"
        if "read_logs" not in results and "read_logs" in names and body.get("tool_choice") != "none":
            call = ("read-" + str(len(self.calls)), "read_logs", {"path": "fixture/diagnostics.log"})
        elif "read_logs" in results:
            source = text_content(results["read_logs"])
            handle = re.search(r"cmw_[a-f0-9]{48}", source)
            if handle and "caveman_retrieve" not in results:
                assert "retained-detail-70" not in source, "forced fact must be absent from the compressed view"
                call = ("recover-1", "caveman_retrieve", {"handle": handle[0]})
            else:
                original = json.loads(text_content(results["caveman_retrieve"]))["text"] if "caveman_retrieve" in results else source
                assert original.encode() == SOURCE.encode(), "recovery must return exact Unicode/CRLF bytes"
                content = '{"answer":42}' if self.structured else "retained-detail-70"
        if self.protocol == "openai":
            return self.openai_response(body, call, content)
        return self.anthropic_response(body, call, content)

    def openai_response(self, body, call, content):
        message = {"role": "assistant", "content": None if call else content}
        if call:
            message["tool_calls"] = [{"id": call[0], "type": "function", "function": {"name": call[1], "arguments": json.dumps(call[2])}}]
        stop = "tool_calls" if call else "stop"
        usage = {"prompt_tokens": 1000, "completion_tokens": 20, "total_tokens": 1020,
                 "prompt_tokens_details": {"cached_tokens": 100}, "completion_tokens_details": {"reasoning_tokens": 3}}
        envelope = {"id": "chatcmpl-fixture-" + str(len(self.calls)), "object": "chat.completion", "created": 1, "model": body["model"]}
        if not body.get("stream"):
            return httpx2.Response(200, json={**envelope, "choices": [{"index": 0, "message": message, "finish_reason": stop}], "usage": usage})
        fixture = self
        class Bytes(httpx2.SyncByteStream):
            def __iter__(self):
                def event(delta, finish=None, stats=None):
                    result = {**envelope, "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
                    if stats:
                        result["usage"] = stats
                    return ("data: " + json.dumps(result) + "\n\n").encode()
                if call:
                    args = json.dumps(call[2])
                    yield event({"role": "assistant", "tool_calls": [{"index": 0, "id": call[0], "type": "function", "function": {"name": call[1], "arguments": args[:1]}}]})
                    yield event({"tool_calls": [{"index": 0, "function": {"arguments": args[1:]}}]})
                else:
                    yield event({"role": "assistant", "content": content[:9]})
                    assert fixture.release.wait(5), "first native content event was buffered"
                    yield event({"content": content[9:]})
                    fixture.finished = True
                yield event({}, stop, usage)
                yield b"data: [DONE]\n\n"
        return httpx2.Response(200, stream=Bytes(), headers={"content-type": "text/event-stream"})

    def anthropic_response(self, body, call, text):
        content = [{"type": "tool_use", "id": call[0], "name": call[1], "input": call[2]}] if call else [{"type": "text", "text": text}]
        if self.reasoning and call and call[0] == "read-1":
            content.insert(0, {"type": "thinking", "thinking": "native reasoning", "signature": "signed-fixture-signature"})
        stop = "tool_use" if call else "end_turn"
        if self.suspended and call and call[1] == "caveman_retrieve":
            self.suspended = False
            stop = "pause_turn"
            call = None
            text = "Continue native reasoning"
            content = ([{"type": "text", "text": text}] if self.pause_content == "text" else
                       [{"type": "thinking", "thinking": text, "signature": "signed-pause-signature"}])

        usage = {"input_tokens": 1000, "output_tokens": 20, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 0}
        # A fresh pause_turn continuation is a new request, with a new message
        # id. Reusing an id would model polling one existing background job.
        message = {"id": "msg-fixture-" + str(len(self.calls)), "type": "message", "role": "assistant", "model": body["model"],
                   "content": content, "stop_reason": stop, "stop_sequence": None, "usage": usage}
        if not body.get("stream"):
            return httpx2.Response(200, json=message)
        fixture = self
        class Bytes(httpx2.SyncByteStream):
            def __iter__(self):
                def event(kind, **fields):
                    return ("event: " + kind + "\ndata: " + json.dumps({"type": kind, **fields}) + "\n\n").encode()
                yield event("message_start", message={**message, "content": [], "stop_reason": None, "usage": {**usage, "output_tokens": 0}})
                for index, part in enumerate(content):
                    if part["type"] == "tool_use":
                        args = json.dumps(part["input"])
                        yield event("content_block_start", index=index, content_block={**part, "input": {}})
                        for chunk in (args[:1], args[1:]):
                            yield event("content_block_delta", index=index, delta={"type": "input_json_delta", "partial_json": chunk})
                    elif part["type"] == "thinking":
                        yield event("content_block_start", index=index, content_block={"type": "thinking", "thinking": "", "signature": ""})
                        yield event("content_block_delta", index=index, delta={"type": "thinking_delta", "thinking": part["thinking"]})
                        yield event("content_block_delta", index=index, delta={"type": "signature_delta", "signature": part["signature"]})
                    else:
                        yield event("content_block_start", index=index, content_block={"type": "text", "text": ""})
                        yield event("content_block_delta", index=index, delta={"type": "text_delta", "text": text[:9]})
                        assert fixture.release.wait(5), "first native content event was buffered"
                        yield event("content_block_delta", index=index, delta={"type": "text_delta", "text": text[9:]})
                        fixture.finished = True
                    yield event("content_block_stop", index=index)
                yield event("message_delta", delta={"stop_reason": stop, "stop_sequence": None}, usage={"output_tokens": 20})
                yield event("message_stop")
        return httpx2.Response(200, stream=Bytes(), headers={"content-type": "text/event-stream"})


class NativePauseFixture(Fixture):
    """Unwrapped baseline with a pause before another native source tool call."""
    def __init__(self, *args, tool_after_pause=False, **kwargs):
        super().__init__(*args, **kwargs)
        self.tool_after_pause, self.paused = tool_after_pause, False

    def anthropic_response(self, body, call, text):
        if self.suspended and call is None and text == "retained-detail-70":
            # Reuse the pause branch; it emits no recovery tool invocation.
            call = ("pause-fixture", "caveman_retrieve", {})
            self.paused = True
        elif self.paused and self.tool_after_pause:
            self.tool_after_pause = False
            call = ("read-after-pause", "read_logs", {"path": "fixture/diagnostics.log"})
        return super().anthropic_response(body, call, text)
