"""Add Caveman to an existing native Pydantic AI model and tool loop."""
import functools
from dataclasses import dataclass

from pydantic_ai import Agent, RunContext
from pydantic_ai.models import Model

from caveman_middleware.pydantic_ai import CavemanCapability, scope_from_run


@dataclass(frozen=True)
class LogSource:
    text: str


def read_logs(ctx: RunContext[LogSource], path: str = "fixture/diagnostics.log") -> str:
    """Return the application's original diagnostic source."""
    if path != "fixture/diagnostics.log":
        raise ValueError("Unknown diagnostic source")
    return ctx.deps.text


def build_agent(existing_model: Model, runtime, *, namespace: str) -> Agent[LogSource, str]:
    return Agent(existing_model, tools=[read_logs], deps_type=LogSource,
        capabilities=[CavemanCapability(runtime=runtime,
            scope=functools.partial(scope_from_run, namespace=namespace))])
