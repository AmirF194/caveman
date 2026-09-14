"""Local native HTTP capture and runtime restart control for framework tests."""
from __future__ import annotations

import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def restart_runtime():
    print(json.dumps({"caveman_control": "restart"}), flush=True)
    if sys.stdin.readline().strip() != "runtime-ready":
        raise RuntimeError("conformance host did not confirm the runtime restart")


class ProviderServer:
    def __init__(self, fixture):
        try:
            import httpx2 as httpx
        except ModuleNotFoundError:
            import httpx
        self.fixture, self.errors = fixture, []
        parent = self
        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            def log_message(self, *_):
                pass
            def do_POST(self):
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
                    chunks = [response.content] if response.is_stream_consumed else response.iter_raw()
                    for chunk in chunks:
                        self.wfile.write(chunk)
                        self.wfile.flush()
                        if b'"text": "retained-"' in chunk or b'"content": "nat"' in chunk:
                            deadline = time.monotonic() + 5
                            while not fixture.released and time.monotonic() < deadline:
                                time.sleep(0.005)
                    response.close()
                except (BrokenPipeError, ConnectionResetError):
                    pass  # Native cancellation may close an intentionally gated stream.
                except BaseException as error:
                    parent.errors.append(str(error))
                    self.close_connection = True
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
