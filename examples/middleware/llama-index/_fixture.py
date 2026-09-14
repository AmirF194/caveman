"""Local HTTP provider protocols for the installed native LlamaIndex clients."""
import json
import re
import threading

import httpx

SOURCE = "".join(f"[INFO] café 🌍 row {i} retained-detail-{i} long repeated diagnostic\r\n" for i in range(140))


def text_content(content):
    if isinstance(content, str):
        return content
    return "".join(part["text"] for part in (content or []) if part.get("type") == "text")


class Fixture:
    def __init__(self, protocol, *, multi=False, failure=False, reasoning=False):
        self.protocol, self.multi, self.failure, self.reasoning = protocol, multi, failure, reasoning
        self.calls, self.recovered = [], []
        self.release, self.release_tools = threading.Event(), threading.Event()
        self.release.set()
        self.release_tools.set()
        self.finished = False

    @property
    def released(self):
        return self.release.is_set()

    def response(self, request):
        body = json.loads(request.content)
        self.calls.append((request, body))
        assert len(self.calls) <= 80, "native fixture exceeded its provider-call budget"
        if self.failure:
            return httpx.Response(500, json={"error": {"message": "fixture provider failure", "type": "server_error"}})
        if self.protocol == "openai" and body.get("response_format", {}).get("type") == "json_schema":
            return self._openai(body, [], '{"answer":42}')
        if self.protocol == "openai":
            ids = {call["id"]: call["function"]["name"] for message in body["messages"] for call in message.get("tool_calls", [])}
            results = [(ids.get(message["tool_call_id"]), text_content(message["content"])) for message in body["messages"] if message["role"] == "tool"]
            names = [tool["function"]["name"] for tool in body.get("tools", [])]
        else:
            ids = {part["id"]: part["name"] for message in body["messages"] if isinstance(message["content"], list)
                   for part in message["content"] if part["type"] == "tool_use"}
            results = [(ids.get(part["tool_use_id"]), text_content(part["content"])) for message in body["messages"] if isinstance(message["content"], list)
                       for part in message["content"] if part["type"] == "tool_result"]
            names = [tool["name"] for tool in body.get("tools", [])]
        sources = [text for name, text in results if name in ("read_logs", "read_more")]
        pages = [json.loads(text) for name, text in results if name == "caveman_retrieve"]
        calls, content = [], "native"
        if names == ["Answer"]:
            calls = [("typed-1", "Answer", {"answer": 42})]
        elif "read_logs" in names and not sources:
            calls = [("read-1", "read_logs", {"path": "fixture/diagnostics.log"})]
            if self.multi:
                calls.append(("read-2", "read_more", {"path": "fixture/diagnostics.log"}))
        elif sources:
            for index, source in enumerate(sources):
                handle = re.search(r"cmw_[a-f0-9]{48}", source)
                if handle and not any(page["handle"] == handle[0] for page in pages):
                    assert "retained-detail-70" not in source, "recovery fact must be absent from optimized input"
                    calls.append((f"recover-{index}", "caveman_retrieve", {"handle": handle[0]}))
                elif handle:
                    page = next(page for page in pages if page["handle"] == handle[0])
                    assert page["text"].encode() == SOURCE.encode(), "recovery must return exact UTF-8/CRLF bytes"
                    assert page["complete"] is True and page["next_offset"] is None
                    self.recovered.append(page)
                else:
                    assert source.encode() == SOURCE.encode(), "baseline/outage source must remain exact"
            content = "retained-detail-70"
        elif "retained-detail-70" in json.dumps(body["messages"], ensure_ascii=False):
            content = "retained-detail-70 [1] [2]"
        if self.protocol == "openai":
            return self._openai(body, calls, content)
        return self._anthropic(body, calls, content)

    def _openai(self, body, calls, content):
        tools = [{"id": cid, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}} for cid, name, args in calls]
        message = {"role": "assistant", "content": None if calls else content}
        if calls:
            message["tool_calls"] = tools
        stop = "tool_calls" if calls else "stop"
        stats = {"prompt_tokens": 1000, "completion_tokens": 20, "total_tokens": 1020,
                 "prompt_tokens_details": {"cached_tokens": 100}, "completion_tokens_details": {"reasoning_tokens": 3}}
        envelope = {"id": "chatcmpl-fixture", "object": "chat.completion", "created": 1, "model": body["model"]}
        if not body.get("stream"):
            return httpx.Response(200, json={**envelope, "choices": [{"index": 0, "message": message, "finish_reason": stop}], "usage": stats})
        fixture = self
        class Bytes(httpx.SyncByteStream):
            def __iter__(self):
                def event(delta, finish=None, usage=None):
                    result = {**envelope, "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
                    if usage:
                        result["usage"] = usage
                    return ("data: " + json.dumps(result) + "\n\n").encode()
                if calls:
                    for index, tool in enumerate(tools):
                        args = tool["function"]["arguments"]
                        yield event({"tool_calls": [{**tool, "index": index, "function": {**tool["function"], "arguments": args[:1]}}]})
                        assert fixture.release_tools.wait(5), "tool delta buffered"
                        yield event({"tool_calls": [{"index": index, "function": {"arguments": args[1:]}}]})
                else:
                    yield event({"role": "assistant", "content": content[:7]})
                    assert fixture.release.wait(5), "first event buffered before native final response"
                    yield event({"content": content[7:]})
                    fixture.finished = True
                yield event({}, stop, stats)
                yield b"data: [DONE]\n\n"
        return httpx.Response(200, stream=Bytes(), headers={"content-type": "text/event-stream"})

    def _anthropic(self, body, calls, text):
        content = [{"type": "tool_use", "id": cid, "name": name, "input": args} for cid, name, args in calls] if calls else [{"type": "text", "text": text}]
        if self.reasoning and calls and calls[0][0] == "read-1":
            content.insert(0, {"type": "thinking", "thinking": "native reasoning", "signature": "fixture-native-signature"})
        stop = "tool_use" if calls else "end_turn"
        stats = {"input_tokens": 1000, "output_tokens": 20, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 0}
        message = {"id": "msg-fixture", "type": "message", "role": "assistant", "model": body["model"],
                   "content": content, "stop_reason": stop, "stop_sequence": None, "usage": stats}
        if not body.get("stream"):
            return httpx.Response(200, json=message)
        fixture = self
        class Bytes(httpx.SyncByteStream):
            def __iter__(self):
                def event(kind, **fields):
                    return ("event: " + kind + "\ndata: " + json.dumps({"type": kind, **fields}) + "\n\n").encode()
                yield event("message_start", message={**message, "content": [], "stop_reason": None, "usage": {**stats, "output_tokens": 0}})
                for index, part in enumerate(content):
                    if part["type"] == "tool_use":
                        args = json.dumps(part["input"])
                        yield event("content_block_start", index=index, content_block={**part, "input": {}})
                        yield event("content_block_delta", index=index, delta={"type": "input_json_delta", "partial_json": args[:1]})
                        assert fixture.release_tools.wait(5), "tool delta buffered"
                        yield event("content_block_delta", index=index, delta={"type": "input_json_delta", "partial_json": args[1:]})
                    elif part["type"] == "thinking":
                        yield event("content_block_start", index=index, content_block={"type": "thinking", "thinking": "", "signature": ""})
                        yield event("content_block_delta", index=index, delta={"type": "thinking_delta", "thinking": part["thinking"]})
                        yield event("content_block_delta", index=index, delta={"type": "signature_delta", "signature": part["signature"]})
                    else:
                        yield event("content_block_start", index=index, content_block={"type": "text", "text": ""})
                        yield event("content_block_delta", index=index, delta={"type": "text_delta", "text": text[:7]})
                        assert fixture.release.wait(5), "first event buffered before native final response"
                        yield event("content_block_delta", index=index, delta={"type": "text_delta", "text": text[7:]})
                        fixture.finished = True
                    yield event("content_block_stop", index=index)
                yield event("message_delta", delta={"stop_reason": stop, "stop_sequence": None}, usage={"output_tokens": 20})
                yield event("message_stop")
        return httpx.Response(200, stream=Bytes(), headers={"content-type": "text/event-stream"})
