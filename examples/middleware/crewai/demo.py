"""Run an existing native CrewAI model with a source tool and scoped recovery.

The CLI uses a deterministic loopback inference fixture, never a paid provider.
"""
from __future__ import annotations

import argparse
import json
import os
import tempfile
import uuid

os.environ["OTEL_SDK_DISABLED"] = "true"
os.environ["CREWAI_DISABLE_TELEMETRY"] = "true"
os.environ["CREWAI_TRACING_ENABLED"] = "false"
os.environ["CREWAI_TESTING"] = "true"
os.environ["LITELLM_MODE"] = "PRODUCTION"
os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "true"
os.environ["PYTHON_DOTENV_DISABLED"] = "true"
STORAGE = tempfile.TemporaryDirectory(prefix="caveman-crewai-demo-")
os.environ["CREWAI_STORAGE_DIR"] = STORAGE.name

from crewai import Agent, BaseLLM, Crew, Task
from crewai.crews.crew_output import CrewOutput
from crewai.tools import BaseTool
from caveman_cloud.middleware import MiddlewareRuntime, Scope
from caveman_middleware.crewai import CavemanLLM, with_caveman_agent


def run(existing_llm: BaseLLM, source_tool: BaseTool, session_id: str, *, endpoint: str, mode="compress") -> tuple[CrewOutput, list]:
    diagnostics = []
    with MiddlewareRuntime(endpoint=endpoint, mode=mode, on_diagnostic=diagnostics.append) as runtime:
        options = with_caveman_agent(
            dict(role="Source reader", goal="Read and preserve exact source evidence", backstory="Use original evidence when requested",
                 llm=existing_llm, tools=[source_tool], allow_delegation=False, verbose=False, max_iter=6, max_retry_limit=0),
            runtime=runtime,
            scope=Scope("crewai-example", session_id),
        )
        # Register the wrapper before constructing the agent. CrewAI snapshots
        # hooks when creating its executor.
        agent = Agent(**options)
        task = Task(description="Read the logs and report retained-detail-70. Recover original source if needed.",
                    expected_output="The exact requested fact", agent=agent)
        crew = Crew(agents=[agent], tasks=[task], verbose=False, tracing=False)
        try:
            result = crew.kickoff()
            assert isinstance(result, CrewOutput)
            return result, diagnostics
        finally:
            if isinstance(options["llm"], CavemanLLM):
                options["llm"].close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", default=os.environ.get("CAVEMAN_MIDDLEWARE_ENDPOINT", "http://127.0.0.1:8787"))
    parser.add_argument("--provider", choices=("openai", "anthropic"), default="openai", help="Local fixture protocol")
    parser.add_argument("--mode", choices=("compress", "record", "off"), default="compress")
    args = parser.parse_args()
    from provider import Provider, SOURCE

    class ReadLogs(BaseTool):
        name: str = "read_logs"
        description: str = "Read the original diagnostic source"

        def _run(self):
            return SOURCE

    with Provider() as server:
        server.release.set()
        result, diagnostics = run(server.model(args.provider), ReadLogs(), f"local-demo-{uuid.uuid4()}", endpoint=args.runtime, mode=args.mode)
        assert not server.errors, server.errors
        print(json.dumps({"answer": result.raw, "response_type": type(result).__name__, "provider_calls": len(server.calls),
                          "provider_inference": "deterministic_loopback_only", "diagnostics": diagnostics}))


if __name__ == "__main__":
    main()
