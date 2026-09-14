"""Actual local HTTP responses with observable cancellation before fixture EOF."""
import json
import select
import socket
import threading
import time
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import httpx
from _fixture import Fixture, SOURCE, text_content


class SourceFixture(Fixture):
    def __init__(self, protocol, *, rag=False):
        super().__init__(protocol)
        self.rag = rag

    def response(self, request):
        if not self.rag:
            return super().response(request)
        body = json.loads(request.content)
        self.calls.append((request, body))
        assert len(self.calls) <= 12, "source reader exceeded the provider budget"
        original_view = "\n\n".join(text_content(message["content"]) for message in body["messages"] if message["role"] in ("user", "system"))
        handles = list(dict.fromkeys(re.findall(r"cmw_[a-f0-9]{48}", original_view)))
        if self.protocol == "openai":
            pages = [json.loads(text_content(message["content"])) for message in body["messages"] if message["role"] == "tool"]
        else:
            pages = [json.loads(text_content(part["content"])) for message in body["messages"] if isinstance(message["content"], list) for part in message["content"] if part["type"] == "tool_result"]
        missing = [handle for handle in handles if not any(page["handle"] == handle for page in pages)]
        calls = [(f"expand-{index}", "caveman_retrieve", {"handle": handle}) for index, handle in enumerate(missing)]
        if handles:
            assert "retained-detail-70" not in original_view, "source view still includes the forced omitted fact"
            assert len(handles) == 2, f"expected two distinct source handles, observed {len(handles)}"
            for page in pages:
                assert page["text"].encode() == SOURCE.encode()
                assert page["complete"] is True and page["next_offset"] is None
            if not missing:
                assert len(pages) == 2
                self.recovered.extend(pages)
        else:
            # Native simple_summarize may rebuild whitespace while preparing
            # its prompt. The original nodes and exact mode-to-mode wire body
            # are independently asserted by the native operation test.
            assert "retained-detail-70" in original_view, "native source view lost the required fact"
        content = "retained-detail-70 [1] [2]"
        return self._openai(body, calls, content) if self.protocol == "openai" else self._anthropic(body, calls, content)


class Provider:
    def __init__(self, fixture):
        self.fixture, self.errors, self.connections = fixture, [], []
        parent = self
        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            def log_message(self, *_):
                pass
            def do_POST(self):
                parent.connections.append(self.connection)
                try:
                    body = self.rfile.read(int(self.headers.get("content-length", "0")))
                    request = httpx.Request("POST", "http://provider.local" + self.path, headers=dict(self.headers), content=body)
                    response = fixture.response(request)
                    self.send_response(response.status_code)
                    for key, value in response.headers.items():
                        self.send_header(key, value)
                    self.send_header("connection", "close")
                    self.end_headers()
                    self.close_connection = True
                    for chunk in ([response.content] if response.is_stream_consumed else response.iter_raw()):
                        self.wfile.write(chunk)
                        self.wfile.flush()
                    response.close()
                except (BrokenPipeError, ConnectionResetError):
                    pass
                except BaseException as error:
                    parent.errors.append(str(error))
                    print("CAVEMAN_NATIVE_FIXTURE_ERROR " + repr(error), flush=True)
                    self.close_connection = True
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=0.02), daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def peer_closed(self, timeout=0.2):
        deadline = time.monotonic() + timeout
        while self.connections:
            connection = self.connections[-1]
            try:
                if connection.fileno() == -1 or (select.select([connection], [], [], 0)[0] and connection.recv(1, socket.MSG_PEEK) == b""):
                    return True
            except (OSError, ConnectionResetError):
                return True
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.005)
        return False

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.fixture.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
