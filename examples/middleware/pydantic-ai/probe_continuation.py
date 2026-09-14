"""Native and middleware Anthropic pause_turn behavior, with local HTTP only."""
import asyncio
import hashlib
import json
import os
from importlib.metadata import version
from pathlib import Path

import pydantic_ai
from test_native import Agent, Dependencies, EvidenceRuntime, Fixture, ProviderServer, SOURCE, make, model, read_logs
from _fixture import NativePauseFixture


async def probe(pause_content, variant, streaming):
    wrapped = variant == "middleware_recovery_after_pause"
    fixture = (Fixture("anthropic", suspended=True, pause_content=pause_content) if wrapped else
               NativePauseFixture("anthropic", suspended=True, pause_content=pause_content,
                                  tool_after_pause=variant == "native_tool_after_pause"))
    fixture.release.set()
    with ProviderServer(fixture) as server, EvidenceRuntime(endpoint=os.environ["CAVEMAN_MIDDLEWARE_ENDPOINT"]) as runtime:
        native, client = model(server, "anthropic")
        try:
            agent = make(native, runtime) if wrapped else Agent(native, tools=[read_logs], deps_type=Dependencies)
            deps = Dependencies()
            if streaming:
                async with agent.run_stream("Answer", deps=deps) as result:
                    output = await result.get_output()
            else:
                result = await agent.run("Answer", deps=deps)
                output = result.output
            recovered = [p.content for m in result.all_messages() for p in m.parts
                         if type(p).__name__ == "ToolReturnPart" and p.tool_name == "caveman_retrieve"]
            return {"pause_content": pause_content, "variant": variant, "wrapped": wrapped,
                "streaming": streaming, "output": output, "provider_calls": len(fixture.calls),
                "optimization_plans": len(runtime.plans), "source_tool_executions": len(deps.calls),
                "native_logical_requests": result.usage.requests, "native_output_tokens": result.usage.output_tokens,
                "recovery_exact": all(isinstance(r, dict) and r.get("text") == SOURCE for r in recovered) if recovered else None,
                "tool_returns": [p.tool_name for m in result.all_messages() for p in m.parts if type(p).__name__ == "ToolReturnPart"],
                "responses": [{"state": m.state, "parts": [type(p).__name__ for p in m.parts],
                               "texts": [p.content[:80] for p in m.parts if type(p).__name__ == "TextPart"]}
                              for m in result.all_messages() if getattr(m, "kind", None) == "response"],
                "fixture_errors": server.errors}
        finally:
            await client.close()


async def main():
    rows = []
    for pause_content in ("thinking", "text"):
        for variant in ("native_text_after_pause", "native_tool_after_pause", "middleware_recovery_after_pause"):
            for streaming in (False, True):
                rows.append(await probe(pause_content, variant, streaming))
    root = Path(pydantic_ai.__file__).parent
    result = {"evidence_class": "native_continuation_diagnostic", "hosted_inference_calls": 0,
        "runtime_binary_sha256": hashlib.sha256(Path(os.environ["CAVEMAN_MIDDLEWARE_TEST_BINARY"]).read_bytes()).hexdigest()
                                 if os.environ.get("CAVEMAN_MIDDLEWARE_TEST_BINARY") else None,
        "versions": {name: version(name) for name in ("pydantic-ai", "openai", "anthropic", "httpx2", "httpcore2")},
        "source_sha256": {name: hashlib.sha256((root / name).read_bytes()).hexdigest()
                          for name in ("_agent_graph.py", "models/_continuation.py", "models/anthropic.py")},
        "cases": rows,
        "limitation": "With visible pause text followed by a tool request, native and wrapped run_stream execute the tool but return the earlier text without a final provider request using its result. Thinking-only pauses and nonstreaming tool continuations complete."}
    Path(__file__).with_name("continuation-evidence.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
