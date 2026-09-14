"""Existing LlamaIndex models and source tools retain their native interfaces."""
from caveman_cloud.middleware import Scope
from caveman_middleware.llama_index import CavemanFunctionAgent, CavemanNodePostprocessor, with_caveman_model
from llama_index.core.tools import FunctionTool


def build_agent(existing_llm, runtime, *, namespace, session_id, read_logs):
    return CavemanFunctionAgent(
        llm=existing_llm,
        runtime=runtime,
        scope=Scope(namespace, session_id),
        tools=[FunctionTool.from_defaults(read_logs)],
        system_prompt="Use the supplied tools to inspect logs and recover exact source text when needed.",
        streaming=True,
    )


def build_query_engine(index, existing_llm, runtime, *, namespace, query_id, streaming=False):
    scope = Scope(namespace, query_id)
    return index.as_query_engine(
        llm=with_caveman_model(existing_llm, runtime=runtime, scope=scope),
        node_postprocessors=[CavemanNodePostprocessor(runtime=runtime, scope=scope)],
        streaming=streaming,
        similarity_top_k=2,
    )
