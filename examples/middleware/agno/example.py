"""Keep Agno's existing model, tools, and native Agent or Team loop."""
import functools

from agno.agent import Agent
from agno.team import Team
from caveman_middleware.agno import scope_from_run, with_caveman_agent


def build(existing_model, runtime, *, tools, namespace, team=False, **options):
    settings = {"model": existing_model, "tools": tools, "telemetry": False, **options}
    if team:
        settings.setdefault("members", [])
    return (Team if team else Agent)(**with_caveman_agent(settings, runtime=runtime,
        scope=functools.partial(scope_from_run, namespace=namespace)))
