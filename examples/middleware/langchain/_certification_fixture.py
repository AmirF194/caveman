"""Local HTTP responses for real LangChain provider clients; no native APIs are replaced."""
import hashlib
import json
import re
import time

import httpx2

SOURCE = "".join(f"[INFO] café 🌍 row {i} retained-detail-{i} long repeated diagnostic\r\n" for i in range(140))
FACT = "retained-detail-70"
EDITED = SOURCE + "[INFO] application edited this source after checkpoint\r\n"


def digest(value):
    text = value if isinstance(value, str) else json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(text.encode()).hexdigest()


def source_results(body, protocol):
    return [message for message in body["messages"] if message["role"] == "tool"] if protocol == "openai" else [part for message in body["messages"] if isinstance(message["content"], list) for part in message["content"] if part["type"] == "tool_result"]


def result_id(part):
    return part.get("tool_call_id", part.get("tool_use_id"))


class NativeProvider:
    def __init__(self, protocol):
        self.protocol = protocol
        self.reset()

    def reset(self, *, compressed=False, parallel=False, rag=False):
        self.calls, self.responses, self.handles = [], [], []
        self.compressed, self.parallel, self.rag = compressed, parallel, rag
        self.expected_source = SOURCE
        self.released, self.finished = False, False
        self.streamed = 0

    def response(self, request):
        body = json.loads(request.content)
        self.calls.append(body)
        history = source_results(body, self.protocol)
        count = 2 if self.parallel else 1
        sources = [part for part in history if result_id(part) == "search-1"] if self.rag else [part for part in history if re.fullmatch("read-[12]", result_id(part) or "")]
        calls, answer = [], None
        if body["model"] == "structured":
            schema = next((item for item in body.get("tools", []) if item.get("function", item).get("name") != "read_logs"), None)
            if schema and not (body.get("response_format") or body.get("output_config")):
                calls = [{"id": "typed-1", "name": schema.get("function", schema)["name"], "args": {"answer": FACT}}]
            else:
                answer = json.dumps({"answer": FACT})
        elif body["model"] == "model":
            answer = FACT
        elif len(sources) < count:
            calls = [{"id": "search-1", "name": "search_documents", "args": {"query": "Read row 70"}}] if self.rag else [{"id": f"read-{index + 1}", "name": "read_logs", "args": {"slot": index}} for index in range(count)]
        else:
            values = [d["text"] for d in json.loads(sources[0]["content"])[:2]] if self.rag else [part["content"] for part in sources]
            if not self.compressed or body["model"] == "bootstrap":
                assert all(value == self.expected_source for value in values)
                answer = FACT
            else:
                handles = [re.search(r"cmw_[a-f0-9]{48}", value) for value in values]
                assert all(handles), "Actual native provider request contains scoped source views"
                assert all(FACT not in value for value in values), "The requested fact is omitted from each view"
                handles = [match[0] for match in handles]
                assert len(set(handles)) == len(handles)
                self.handles.extend(handles)
                for index, handle in enumerate(handles):
                    page = None
                    for part in history:
                        try:
                            candidate = json.loads(part["content"])
                            if isinstance(candidate, dict) and candidate.get("handle") == handle:
                                page = candidate
                                break
                        except (ValueError, TypeError):
                            pass
                    if page is None:
                        calls.append({"id": f"recover-{len(body['messages'])}-{index}", "name": "caveman_retrieve", "args": {"handle": handle}})
                    else:
                        assert page["text"] == self.expected_source
                        assert page["original_sha256"] == digest(self.expected_source) and page["complete"]
                if not calls:
                    answer = FACT
        self.responses.append({"calls": calls, "answer": answer})
        reply_id = f"native-cert-{len(self.calls)}"
        if self.protocol == "openai":
            message = {"role": "assistant", "content": answer}
            if calls:
                message["tool_calls"] = [{"id": call["id"], "type": "function", "function": {"name": call["name"], "arguments": json.dumps(call["args"])}} for call in calls]
            response = {"id": reply_id, "object": "chat.completion", "created": 1, "model": body["model"], "choices": [{"index": 0, "message": message, "finish_reason": "tool_calls" if calls else "stop", "logprobs": None}], "usage": {"prompt_tokens": 1000, "completion_tokens": 20, "total_tokens": 1020}}
        else:
            response = {"id": reply_id, "type": "message", "role": "assistant", "model": body["model"], "content": [{"type": "tool_use", "id": call["id"], "name": call["name"], "input": call["args"]} for call in calls] if calls else [{"type": "text", "text": answer}], "stop_reason": "tool_use" if calls else "end_turn", "stop_sequence": None, "usage": {"input_tokens": 1000, "output_tokens": 20}}
        if not body.get("stream"):
            return httpx2.Response(200, json=response)
        self.streamed += 1
        parent = self

        class Bytes(httpx2.SyncByteStream):
            def __iter__(self):
                def gate():
                    deadline = time.monotonic() + 10
                    while not parent.released and time.monotonic() < deadline:
                        time.sleep(0.002)
                    assert parent.released, "The actual native consumer receives text before provider EOF"
                    parent.finished = True

                def event(kind, **fields):
                    return ("event: " + kind + "\ndata: " + json.dumps({"type": kind, **fields}) + "\n\n").encode()

                if parent.protocol == "openai":
                    base = {"id": reply_id, "object": "chat.completion.chunk", "created": 1, "model": body["model"]}
                    def chunk(delta, finish=None):
                        return ("data: " + json.dumps({**base, "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}) + "\n\n").encode()
                    if calls:
                        yield chunk({"role": "assistant", "tool_calls": [{"index": index, "id": call["id"], "type": "function", "function": {"name": call["name"], "arguments": json.dumps(call["args"])}} for index, call in enumerate(calls)]})
                    else:
                        yield chunk({"role": "assistant", "content": "retained-"})
                        gate()
                        yield chunk({"content": "detail-70"})
                    yield chunk({}, "tool_calls" if calls else "stop")
                    yield b"data: [DONE]\n\n"
                else:
                    yield event("message_start", message={**response, "content": [], "stop_reason": None})
                    for index, part in enumerate(response["content"]):
                        if part["type"] == "tool_use":
                            yield event("content_block_start", index=index, content_block={**part, "input": {}})
                            yield event("content_block_delta", index=index, delta={"type": "input_json_delta", "partial_json": json.dumps(part["input"])})
                        else:
                            yield event("content_block_start", index=index, content_block={"type": "text", "text": ""})
                            yield event("content_block_delta", index=index, delta={"type": "text_delta", "text": "retained-"})
                            gate()
                            yield event("content_block_delta", index=index, delta={"type": "text_delta", "text": "detail-70"})
                        yield event("content_block_stop", index=index)
                    yield event("message_delta", delta={"stop_reason": response["stop_reason"], "stop_sequence": None}, usage={"output_tokens": 20})
                    yield event("message_stop")
        return httpx2.Response(200, stream=Bytes(), headers={"content-type": "text/event-stream"})
