"""Compare native and delegated stream cleanup at the local server socket."""
import asyncio
import gc
import hashlib
import inspect
import json
import os
import select
import socket
import warnings
from importlib.metadata import version
from pathlib import Path

os.environ.setdefault("CAVEMAN_MIDDLEWARE_ENDPOINT", "http://127.0.0.1:1")

from caveman_cloud.middleware import MiddlewareRuntime, Scope
from caveman_middleware.llama_index import CavemanLLM
from llama_index.core.llms import ChatMessage
from python_fixture import ProviderServer
from _fixture import Fixture
from test_native import native_model, close_clients


class ObservedServer(ProviderServer):
    def __init__(self, fixture):
        super().__init__(fixture)
        self.connections = []
        original = self.server.RequestHandlerClass
        connections = self.connections

        class Handler(original):
            def setup(self):
                super().setup()
                connections.append(self.connection)

        self.server.RequestHandlerClass = Handler

    def peer_closed(self):
        if not self.connections:
            return False
        connection = self.connections[-1]
        try:
            if connection.fileno() == -1:
                return True
            return bool(select.select([connection], [], [], 0)[0]) and connection.recv(1, socket.MSG_PEEK) == b""
        except (ConnectionResetError, OSError):
            return True


async def main():
    evidence = {"schema_version": 1, "evidence_class": "local_native_stream_lifecycle", "hosted_inference_calls": 0,
        "adapter_source_sha256": hashlib.sha256(Path(inspect.getfile(CavemanLLM)).read_bytes()).hexdigest(),
        "versions": {name: version(name) for name in ("llama-index-core", "llama-index-llms-openai", "llama-index-llms-anthropic", "openai", "anthropic", "httpx")},
        "socket_observation_ms": 200, "runs": []}
    loop = asyncio.get_running_loop()
    loop_errors = []
    loop.set_exception_handler(lambda _, context: loop_errors.append({"message": context.get("message"), "exception_type": type(context.get("exception")).__name__}))
    with warnings.catch_warnings(record=True) as recorded:
        warnings.simplefilter("always", ResourceWarning)
        for protocol in ("openai", "anthropic"):
            for wrapped in (False, True):
                for mode in ("sync_close", "async_close", "async_cancel"):
                    with ObservedServer(Fixture(protocol)) as server:
                        server.fixture.release.clear()
                        runtime, clients = MiddlewareRuntime(mode="off"), native_model(server, protocol)
                        llm = CavemanLLM(clients[0], runtime=runtime, scope=Scope("llama-probe", "lifecycle")) if wrapped else clients[0]
                        row = {"protocol": protocol, "wrapped": wrapped, "operation": mode}
                        iterator = None
                        try:
                            messages = [ChatMessage(content="Answer")]
                            iterator = llm.stream_chat(messages) if mode == "sync_close" else await llm.astream_chat(messages)
                            first = next(iterator) if mode == "sync_close" else await anext(iterator)
                            row["first_response_type"] = type(first).__name__
                            row["first_before_fixture_completion"] = not server.fixture.finished
                            if mode == "sync_close":
                                iterator.close()
                            elif mode == "async_close":
                                await iterator.aclose()
                            else:
                                pending = asyncio.create_task(anext(iterator))
                                await asyncio.sleep(0.02)
                                pending.cancel()
                                try:
                                    await pending
                                except asyncio.CancelledError:
                                    row["cancelled_error_propagated"] = True
                                await iterator.aclose()
                            for _ in range(10):
                                if server.peer_closed():
                                    break
                                await asyncio.sleep(0.02)
                            row["peer_eof_before_fixture_release"] = server.peer_closed()
                            row["provider_requests"] = len(server.fixture.calls)
                        except Exception as error:
                            row["error"] = {"type": type(error).__name__, "message": str(error)[:200]}
                        finally:
                            server.fixture.release.set()
                            await close_clients(clients)
                            runtime.close()
                            iterator, llm, clients = None, None, None
                            gc.collect()
                            await asyncio.sleep(0.03)
                        row["fixture_errors"] = server.errors
                        evidence["runs"].append(row)
        gc.collect()
        await asyncio.sleep(0.1)
        evidence["resource_warnings"] = [str(item.message)[:200] for item in recorded if issubclass(item.category, ResourceWarning)]
    evidence["event_loop_errors"] = loop_errors
    path = Path(__file__).with_name("lifecycle-evidence.json")
    path.write_text(json.dumps(evidence, indent=2) + "\n")
    print(json.dumps(evidence, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
