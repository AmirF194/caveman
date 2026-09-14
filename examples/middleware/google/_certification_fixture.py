"""Google/Vertex wire fixture with an observable socket and no external inference."""
import json
import re
import select
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SOURCE = "".join(f"[INFO] café 🌍 row {i} retained-detail-{i} verbose repeated diagnostic data\r\n" for i in range(160))
FACT = "retained-detail-80"


def values(body):
    return {part["functionResponse"]["name"]: part["functionResponse"]["response"] for content in body.get("contents", []) for part in content.get("parts", []) if "functionResponse" in part}


def response(parts, terminal=True):
    return {"candidates": [{"content": {"role": "model", "parts": parts}, **({"finishReason": "STOP"} if terminal else {}), "index": 0}],
        **({"usageMetadata": {"promptTokenCount": 1000, "candidatesTokenCount": 20, "cachedContentTokenCount": 200, "thoughtsTokenCount": 3, "totalTokenCount": 1023}} if terminal else {}),
        "responseId": "google-certification-fixture", "modelVersion": "native-fixture-model"}


class Provider:
    def __init__(self, cancel=False):
        self.calls, self.errors, self.sockets = [], [], []
        self.cancel, self.release = cancel, threading.Event()
        if not cancel:
            self.release.set()
        owner = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            def log_message(self, *_):
                pass
            def do_POST(self):
                try:
                    raw = self.rfile.read(int(self.headers.get("content-length", "0")))
                    body = json.loads(raw)
                    owner.calls.append({"body": body, "raw": raw.decode(), "headers": dict(self.headers), "path": self.path})
                    owner.sockets.append(self.connection)
                    found, parts = values(body), None
                    if "fixture-structured" in self.path:
                        parts = [{"text": json.dumps({"answer": FACT}, separators=(",", ":"))}]
                    elif "fixture-cached" in self.path:
                        parts = [{"text": "native-cached"}]
                    elif "read_logs" not in found:
                        parts = [{"functionCall": {"name": "read_logs", "args": {}}, "thoughtSignature": "c2lnbmF0dXJl"}]
                    else:
                        projected = found["read_logs"]["result"]
                        handle = re.search(r"cmw_[a-f0-9]{48}", projected)
                        if handle and "caveman_retrieve" not in found:
                            assert FACT not in projected
                            assert any(declaration["name"] == "caveman_retrieve" for tool in body["tools"] for declaration in tool.get("functionDeclarations", []))
                            parts = [{"functionCall": {"name": "caveman_retrieve", "args": {"handle": handle[0]}}}]
                        else:
                            if "caveman_retrieve" in found:
                                assert found["caveman_retrieve"]["result"]["text"] == SOURCE
                            else:
                                assert projected == SOURCE
                            parts = [{"text": FACT}]
                    self.send_response(200)
                    streaming = "streamGenerateContent" in self.path
                    self.send_header("content-type", "text/event-stream" if streaming else "application/json")
                    self.send_header("connection", "close")
                    self.send_header("x-fixture", "google-certification")
                    self.end_headers()
                    self.close_connection = True
                    def send(value):
                        payload = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
                        self.wfile.write(b"data: " + payload + b"\n\n" if streaming else payload)
                        self.wfile.flush()
                    if streaming and "text" in parts[0]:
                        send(response(parts, False))
                        owner.release.wait(timeout=10)
                        send(response([{"text": ""}]))
                    else:
                        send(response(parts))
                except (BrokenPipeError, ConnectionResetError):
                    pass
                except BaseException as error:
                    owner.errors.append(str(error))
                    self.close_connection = True

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=0.01), daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def peer_closed(self):
        selected = self.sockets[-1]
        deadline = time.monotonic() + 0.5
        while time.monotonic() < deadline:
            try:
                if select.select([selected], [], [], 0.01)[0] and selected.recv(1, socket.MSG_PEEK) == b"":
                    return True
            except (OSError, ValueError):
                return selected.fileno() < 0
        return False

    def close(self):
        self.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
