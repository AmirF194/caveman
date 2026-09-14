"""Actual local HTTP responses with observable cancellation before fixture EOF."""
import json
import select
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import httpx


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
