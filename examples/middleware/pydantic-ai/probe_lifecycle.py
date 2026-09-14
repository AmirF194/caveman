"""Compare native and wrapped stream shutdown against local HTTP providers."""
import asyncio
import argparse
import hashlib
import inspect
import json
import os
import select
import socket
import traceback
import warnings
from importlib.metadata import version
from pathlib import Path

import httpcore2

os.environ.setdefault("CAVEMAN_MIDDLEWARE_ENDPOINT", "http://127.0.0.1:1")

from test_native import (
    EvidenceRuntime, Fixture, ModelRequest, ModelRequestParameters, ProviderServer,
    Scope, UserPromptPart, model, with_caveman_model,
)
from pydantic_ai.models import Model, StreamedResponse
from pydantic_ai.models.anthropic import AnthropicModel
from pydantic_ai.models.openai import OpenAIChatModel


class ObservedServer(ProviderServer):
    def __init__(self, fixture):
        super().__init__(fixture)
        self.connections = []
        original, connections = self.server.RequestHandlerClass, self.connections

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


def probe(protocol, variant, operation):
    errors = []
    row = {"protocol": protocol, "variant": variant, "operation": operation}

    async def run():
        def report_error(loop, context):
            exception = context.get("exception")
            errors.append({"type": type(exception).__name__, "message": str(exception),
                "frames": [f"{Path(frame.filename).parent.name}/{Path(frame.filename).name}:{frame.lineno}:{frame.name}"
                           for frame in traceback.extract_tb(exception.__traceback__)] if exception else []})
        asyncio.get_running_loop().set_exception_handler(report_error)
        with ObservedServer(Fixture(protocol)) as server, EvidenceRuntime(endpoint=os.environ["CAVEMAN_MIDDLEWARE_ENDPOINT"]) as runtime:
            native, client = model(server, protocol)
            wrapped = native if variant == "baseline" else with_caveman_model(native, runtime=runtime, scope=Scope("pydantic-close", protocol))
            try:
                async with wrapped.request_stream([ModelRequest([UserPromptPart("Answer")])], None, ModelRequestParameters()) as stream:
                    assert isinstance(stream, StreamedResponse)
                    iterator = stream.__aiter__()
                    event = await anext(iterator)
                    row["first_event_type"] = type(event).__name__
                    row["first_before_fixture_completion"] = not server.fixture.finished
                    assert not server.fixture.finished
                    if operation == "stream_cancel":
                        await stream.cancel()
                    elif operation == "task_cancel":
                        async def drain():
                            async for _ in iterator:
                                pass
                        pending = asyncio.create_task(drain())
                        await asyncio.sleep(0.02)
                        pending.cancel()
                        try:
                            await pending
                        except asyncio.CancelledError:
                            row["cancelled_error_propagated"] = True
                    assert stream.get().state != "complete"
                    row["native_state"] = stream.get().state
                for _ in range(10):
                    if server.peer_closed():
                        break
                    await asyncio.sleep(0.02)
                row["peer_eof_before_fixture_release"] = server.peer_closed()
                assert len(server.fixture.calls) == 1
                row["provider_requests"] = len(server.fixture.calls)
                if variant == "middleware":
                    assert runtime.receipts[-1]["event_kind"] == "cancelled"
                    assert runtime.receipts[-1]["usage"] is None
                    row["receipt_event"] = runtime.receipts[-1]["event_kind"]
                    row["receipt_usage"] = runtime.receipts[-1]["usage"]
            except Exception as error:
                row["error"] = {"type": type(error).__name__, "message": str(error)}
            finally:
                server.fixture.release.set()
                await client.close()
            row["fixture_errors"] = server.errors
    with warnings.catch_warnings(record=True) as recorded:
        warnings.simplefilter("always", ResourceWarning)
        asyncio.run(run(), debug=True)
        row["resource_warnings"] = [str(item.message)[:200] for item in recorded if issubclass(item.category, ResourceWarning)]
    row["shutdown_errors"] = errors
    return row


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path(__file__).with_name("lifecycle-evidence.json"))
    parser.add_argument("--repetitions", type=int, default=3)
    args = parser.parse_args()
    sources = {name: Path(inspect.getsourcefile(value)) for name, value in {
        "pydantic_ai.models": Model, "pydantic_ai.models.openai": OpenAIChatModel,
        "pydantic_ai.models.anthropic": AnthropicModel,
    }.items()}
    sources.update({"httpcore2/" + name: Path(httpcore2.__file__).parent / name
                    for name in ("_utils.py", "_async/connection_pool.py", "_async/http11.py")})
    evidence = {"evidence_class": "native_lifecycle_diagnostic", "hosted_provider_tested": False,
        "hosted_inference_calls": 0, "socket_observation_ms": 200,
        "runtime_binary_sha256": hashlib.sha256(Path(os.environ["CAVEMAN_MIDDLEWARE_TEST_BINARY"]).read_bytes()).hexdigest()
                                 if os.environ.get("CAVEMAN_MIDDLEWARE_TEST_BINARY") else None,
        "versions": {name: version(name) for name in ("pydantic-ai", "openai", "anthropic", "httpx2", "httpcore2")},
        "source_sha256": {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in sources.items()},
        "cases": [{"repetition": repetition, **probe(protocol, variant, operation)} for repetition in range(args.repetitions)
                  for protocol in ("openai", "anthropic") for variant in ("baseline", "middleware")
                  for operation in ("context_exit", "stream_cancel", "task_cancel")],
        "limitation": "Native and wrapped socket closure is recorded before client close or fixture release. Async-generator shutdown errors are reported independently of socket EOF and cancellation receipts."}
    args.output.write_text(json.dumps(evidence, indent=2) + "\n")
    print(json.dumps(evidence, indent=2))
