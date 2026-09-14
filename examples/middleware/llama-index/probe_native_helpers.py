"""Record unwrapped/wrapped native helper defects independently of conformance."""
import asyncio
import hashlib
import inspect
import json
import os
from importlib.metadata import version
from pathlib import Path

os.environ.setdefault("CAVEMAN_MIDDLEWARE_ENDPOINT", "http://127.0.0.1:1")

from llama_index.core.program.utils import process_streaming_objects
from llama_index.core.prompts import PromptTemplate
from caveman_cloud.middleware import MiddlewareRuntime, Scope
from caveman_middleware.llama_index import CavemanLLM
from python_fixture import ProviderServer
from _fixture import Fixture
from test_native import Answer, native_model, close_clients


async def main():
    evidence = {"schema_version": 1, "evidence_class": "local_native_helper_parity", "hosted_inference_calls": 0,
        "versions": {name: version(name) for name in ("llama-index-core", "llama-index-llms-anthropic", "anthropic", "pydantic")},
        "adapter_source_sha256": hashlib.sha256(Path(inspect.getfile(CavemanLLM)).read_bytes()).hexdigest(),
        "structured_parser_sha256": hashlib.sha256(inspect.getsource(process_streaming_objects).encode()).hexdigest(), "runs": []}
    for wrapped in (False, True):
        with ProviderServer(Fixture("anthropic")) as server:
            runtime, clients = MiddlewareRuntime(mode="off"), native_model(server, "anthropic")
            try:
                llm = CavemanLLM(clients[0], runtime=runtime, scope=Scope("llama-probe", "helpers")) if wrapped else clients[0]
                result = llm.complete("Answer", formatted=True)
                try:
                    result.model_dump()
                    serialization = {"ok": True}
                except Exception as error:
                    serialization = {"ok": False, "error_type": type(error).__name__, "error": str(error)}
                sync = list(llm.stream_structured_predict(Answer, PromptTemplate("Return an Answer")))
                async_ = [item async for item in await llm.astream_structured_predict(Answer, PromptTemplate("Return an Answer"))]
                evidence["runs"].append({"wrapped": wrapped, "completion_type": type(result).__name__, "completion_serialization": serialization,
                    "sync_typed_stream_last": sync[-1].model_dump(), "async_typed_stream_last": async_[-1].model_dump(),
                    "http_provider_calls": len(server.fixture.calls), "http_fixture_errors": server.errors})
            finally:
                await close_clients(clients)
                runtime.close()
    path = Path(__file__).with_name("native-helper-evidence.json")
    path.write_text(json.dumps(evidence, indent=2) + "\n")
    print(json.dumps(evidence, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
