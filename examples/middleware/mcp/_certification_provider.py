"""Native provider HTTP responses for configurable, actually executed MCP tools."""
import json
import re

from test_native import Fixture
from _server import SOURCE


class NativeProvider(Fixture):
    def __init__(self, protocol, *, tool_name="read_logs", tool_arguments=None, expected_text=SOURCE, native_engine=False):
        super().__init__(protocol)
        self.tool_name, self.native_engine, self.expected_text = tool_name, native_engine, expected_text
        self.tool_arguments = tool_arguments if tool_arguments is not None else {"path": "fixture/diagnostics.log"}
        self.responses = []

    def response(self, request):
        body = json.loads(request.content)
        self.calls.append((request, body))
        assert len(self.calls) <= 12, "native fixture provider-call budget"
        if self.protocol == "openai":
            results = {message["tool_call_id"]: message["content"] for message in body["messages"] if message["role"] == "tool"}
        else:
            results = {part["tool_use_id"]: part["content"] for message in body["messages"] if isinstance(message["content"], list)
                       for part in message["content"] if part["type"] == "tool_result"}
        call, final = None, "retained-detail-70"
        if "read-1" not in results:
            call = ("read-1", self.tool_name, self.tool_arguments)
        else:
            original = results["read-1"]
            native = json.loads(original) if self.native_engine else None
            handle = native["recovery_handle"] if self.native_engine else re.search(r"cmw_[a-f0-9]{48}", original)
            if handle and "recover-1" not in results:
                assert "retained-detail-70" not in (native["compressed"] if self.native_engine else original)
                call = ("recover-1", "caveman_retrieve", {"recovery_handle": handle} if self.native_engine else {"handle": handle[0]})
            else:
                text = (results["recover-1"] if self.native_engine else json.loads(results["recover-1"])["text"]) if "recover-1" in results else original
                if callable(self.expected_text):
                    self.expected_text(text)
                else:
                    assert text.encode() == self.expected_text.encode(), "exact native source/recovery bytes"
        self.responses.append({"id": call[0], "name": call[1], "args": call[2]} if call else {"final": final})
        return self.openai_response(body, call, final) if self.protocol == "openai" else self.anthropic_response(body, call, final)
