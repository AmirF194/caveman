"""F15 conformance with installed LlamaIndex and local HTTP provider fixtures."""
from __future__ import annotations

import asyncio
import copy
import json
import os
import threading
import unittest
import uuid
from unittest.mock import patch

from llama_index.core import VectorStoreIndex
from llama_index.core.agent.workflow import AgentInput, AgentOutput, AgentStream, ToolCall, ToolCallResult
from llama_index.core.base.llms.types import ChatMessage, ChatResponse, TextBlock, ToolCallBlock
from llama_index.core.base.response.schema import AsyncStreamingResponse, Response, StreamingResponse
from llama_index.core.embeddings import MockEmbedding
from llama_index.core.llms import LLM
from llama_index.core.memory import ChatMemoryBuffer
from llama_index.core.prompts import PromptTemplate
from llama_index.core.query_engine import CitationQueryEngine, RetrieverQueryEngine
from llama_index.core.response_synthesizers import get_response_synthesizer
from llama_index.core.schema import NodeRelationship, NodeWithScore, RelatedNodeInfo, TextNode
from llama_index.core.tools import FunctionTool, ToolOutput
from llama_index.core.workflow import Context
from llama_index.llms.openai import OpenAI
from llama_index.llms.anthropic import Anthropic
from openai import OpenAI as OpenAIClient, AsyncOpenAI as AsyncOpenAIClient
from pydantic import BaseModel

from caveman_cloud.middleware import MiddlewareError, MiddlewareRuntime, Scope
from caveman_middleware._native import owner
from caveman_middleware.llama_index import CavemanFunctionAgent, CavemanLLM, CavemanNodePostprocessor, with_caveman_model
from evidence_runtime import EvidenceRuntime
from python_fixture import ProviderServer, restart_runtime
from _fixture import Fixture, SOURCE

ENDPOINT = os.environ["CAVEMAN_MIDDLEWARE_ENDPOINT"]


class Answer(BaseModel):
    """A typed answer."""
    answer: int


def native_model(server, protocol):
    if protocol == "openai":
        sync = OpenAIClient(api_key="fixture-key", base_url=server.url + "/v1", max_retries=0)
        async_ = AsyncOpenAIClient(api_key="fixture-key", base_url=server.url + "/v1", max_retries=0)
        native = OpenAI(model="gpt-4o-mini", api_key="fixture-key", api_base=server.url + "/v1", max_retries=0,
            openai_client=sync, async_openai_client=async_, temperature=0.3, timeout=5)
        return native, sync, async_
    return Anthropic(model="claude-sonnet-4-20250514", api_key="fixture-key", base_url=server.url,
                     max_retries=0, timeout=5, temperature=0.3), None, None


async def close_clients(clients):
    _, sync, async_ = clients
    if sync:
        sync.close()
    if async_:
        await async_.close()


def scope():
    return Scope("llama-" + str(uuid.uuid4()), "conversation", "main", "0")


def read_logs(path: str) -> str:
    """Read the selected diagnostic log."""
    assert path == "fixture/diagnostics.log"
    return SOURCE


def read_more(path: str) -> str:
    """Read a second diagnostic log."""
    assert path == "fixture/diagnostics.log"
    return SOURCE


def source_history():
    return [ChatMessage(role="user", content="Find the exact missing log detail"),
            ChatMessage(role="assistant", blocks=[ToolCallBlock(tool_call_id="read-1", tool_name="read_logs", tool_kwargs={"path": "fixture/diagnostics.log"})]),
            ChatMessage(role="tool", content=SOURCE, additional_kwargs={"tool_call_id": "read-1", "is_error": False})]


class GatedRuntime(EvidenceRuntime):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.entered, self.release = threading.Event(), threading.Event()

    def optimize(self, **kwargs):
        self.entered.set()
        self.release.wait(5)
        return super().optimize(**kwargs)


class NativeLlamaIndex(unittest.TestCase):
    def test_native_agent_recovery_disabled_and_outage(self):
        async def run():
            for protocol in ("openai", "anthropic"):
                for mode in ("compress", "off", "outage", "record"):
                    for streaming in (False, True):
                        with self.subTest(protocol=protocol, mode=mode, streaming=streaming), ProviderServer(Fixture(protocol)) as server:
                            runtime = EvidenceRuntime(endpoint="http://127.0.0.1:1" if mode == "outage" else ENDPOINT,
                                mode=mode if mode in ("off", "record") else "compress")
                            clients = native_model(server, protocol)
                            original_tools = [FunctionTool.from_defaults(read_logs)]
                            original = [ChatMessage(role="user", content="Earlier context stays exact")]
                            before = [message.model_dump() for message in original]
                            try:
                                agent = CavemanFunctionAgent(llm=clients[0], tools=original_tools, runtime=runtime, scope=scope(), streaming=streaming)
                                self.assertEqual(len(original_tools), 1)
                                memory = ChatMemoryBuffer.from_defaults(token_limit=20000)
                                handler = agent.run("Answer", chat_history=original, memory=memory, max_iterations=6)
                                events = [event async for event in handler.stream_events()]
                                result = await handler
                                self.assertIsInstance(result, AgentOutput)
                                self.assertEqual(result.response.content, "retained-detail-70")
                                self.assertEqual([message.model_dump() for message in original], before)
                                self.assertTrue(any(message.content == SOURCE for message in memory.get_all()))
                                calls = [event for event in events if isinstance(event, ToolCall)]
                                self.assertEqual(calls[0].tool_name, "read_logs")
                                source_result = next(event for event in events if isinstance(event, ToolCallResult) and event.tool_name == "read_logs")
                                self.assertEqual(source_result.tool_output.raw_output, SOURCE)
                                self.assertEqual(source_result.tool_output.content, SOURCE)
                                self.assertTrue(any(isinstance(event, AgentInput) for event in events))
                                self.assertEqual(len(server.fixture.calls), 3 if mode == "compress" else 2)
                                if mode == "compress":
                                    self.assertEqual([event.tool_name for event in calls], ["read_logs", "caveman_retrieve"])
                                    self.assertTrue(server.fixture.recovered)
                                    self.assertTrue(any(p.replacements for _, p in runtime.plans))
                                    self.assertEqual(server.fixture.recovered[0]["source_id"], "read-1")
                                else:
                                    self.assertFalse(any(p.replacements for _, p in runtime.plans))
                                if mode == "off":
                                    self.assertFalse(runtime.plans)
                                    self.assertFalse(runtime.receipts)
                                completed = [r for r in runtime.receipts if r["event_kind"] == "completed"]
                                self.assertEqual(len(completed), 0 if mode == "off" else len(server.fixture.calls))
                                for receipt in completed:
                                    self.assertIsNotNone(receipt["usage"])
                                    self.assertTrue(receipt["usage"]["complete"])
                                    self.assertEqual(receipt["usage"]["input_tokens"], 1000)
                                    self.assertEqual(receipt["usage"]["output_tokens"], 20)
                                self.assertIsNone(owner.get())
                                self.assertFalse(server.errors, server.errors)
                            finally:
                                await close_clients(clients)
                                runtime.close()
        asyncio.run(run())

    def test_parallel_native_tools_keep_distinct_recovery_identity(self):
        async def run():
            for protocol in ("openai", "anthropic"):
                for streaming in (False, True):
                    with self.subTest(protocol=protocol, streaming=streaming), ProviderServer(Fixture(protocol, multi=True)) as server:
                        runtime, clients = EvidenceRuntime(endpoint=ENDPOINT), native_model(server, protocol)
                        try:
                            agent = CavemanFunctionAgent(llm=clients[0], tools=[read_logs, read_more], runtime=runtime, scope=scope(), streaming=streaming)
                            handler = agent.run("Answer", max_iterations=6)
                            events = [event async for event in handler.stream_events()]
                            result = await handler
                            self.assertEqual(result.response.content, "retained-detail-70")
                            self.assertEqual(len(server.fixture.calls), 3)
                            self.assertEqual({page["source_id"] for page in server.fixture.recovered}, {"read-1", "read-2"})
                            self.assertEqual(len({page["handle"] for page in server.fixture.recovered}), 2)
                            self.assertEqual(len([e for e in events if isinstance(e, ToolCallResult)]), 4)
                            self.assertFalse(server.errors, server.errors)
                        finally:
                            await close_clients(clients)
                            runtime.close()
        asyncio.run(run())

    def test_shared_native_model_concurrent_scopes_are_isolated(self):
        async def run():
            with ProviderServer(Fixture("openai")) as server:
                clients, runtime = native_model(server, "openai"), EvidenceRuntime(endpoint=ENDPOINT)
                scopes = [scope(), scope()]
                native_dump = clients[0].model_dump()
                try:
                    agents = [CavemanFunctionAgent(llm=clients[0], tools=[read_logs], runtime=runtime, scope=selected, streaming=False) for selected in scopes]
                    async def execute(agent):
                        return await agent.run("Answer", max_iterations=6)
                    results = await asyncio.gather(*(execute(agent) for agent in agents))
                    self.assertEqual([r.response.content for r in results], ["retained-detail-70"] * 2)
                    self.assertEqual(clients[0].model_dump(), native_dump)
                    self.assertEqual(len(server.fixture.calls), 6)
                    self.assertEqual({r["scope"]["namespace"] for r in runtime.receipts}, {s.namespace for s in scopes})
                    plans = [p for _, p in runtime.plans if p.replacements]
                    first = next(p for p in plans if p.request["scope"]["namespace"] == scopes[0].namespace)
                    handle = first.replacements[0]["recovery_handle"]
                    with self.assertRaises(MiddlewareError):
                        await runtime.as_async().retrieve(scopes[1], handle=handle)
                    self.assertIsNone(owner.get())
                    self.assertFalse(server.errors, server.errors)
                finally:
                    await close_clients(clients)
                    runtime.close()
        asyncio.run(run())

    def test_provider_body_override_disables_recovery_before_continuation(self):
        async def run():
            for protocol in ("openai", "anthropic"):
                with self.subTest(protocol=protocol), ProviderServer(Fixture(protocol)) as server:
                    clients, runtime = native_model(server, protocol), EvidenceRuntime(endpoint=ENDPOINT)
                    try:
                        def source(path: str) -> str:
                            """Read a diagnostic source."""
                            clients[0].additional_kwargs = {"extra_body": {"tools": [], "tool_choice": "none" if protocol == "openai" else {"type": "none"}}}
                            return read_logs(path)
                        agent = CavemanFunctionAgent(llm=clients[0], tools=[FunctionTool.from_defaults(source, name="read_logs")], runtime=runtime, scope=scope(), streaming=False)
                        result = await agent.run("Answer", max_iterations=4)
                        self.assertEqual(result.response.content, "retained-detail-70")
                        self.assertEqual(server.fixture.calls[1][1]["tools"], [])
                        self.assertEqual(len(server.fixture.calls), 2)
                        self.assertFalse(any(p.replacements for _, p in runtime.plans))
                        self.assertTrue(any(p.reason == "recovery_unavailable" for _, p in runtime.plans))
                        self.assertFalse(server.errors, server.errors)
                    finally:
                        await close_clients(clients)
                        runtime.close()
        asyncio.run(run())

    def test_native_result_guardrail_sees_original_even_during_outage(self):
        class GuardedAgent(CavemanFunctionAgent):
            async def handle_tool_call_results(self, ctx, results, memory):
                if any(result.tool_output.raw_output == SOURCE for result in results):
                    raise ValueError("application source guardrail denied")
                return await super().handle_tool_call_results(ctx, results, memory)
        async def run():
            for endpoint in (ENDPOINT, "http://127.0.0.1:1"):
                with ProviderServer(Fixture("openai")) as server:
                    clients, runtime = native_model(server, "openai"), EvidenceRuntime(endpoint=endpoint)
                    try:
                        agent = GuardedAgent(llm=clients[0], tools=[read_logs], runtime=runtime, scope=scope(), streaming=False)
                        with self.assertRaisesRegex(ValueError, "application source guardrail denied"):
                            await agent.run("Answer", max_iterations=4)
                        self.assertEqual(len(server.fixture.calls), 1)
                        self.assertFalse(any(p.replacements for _, p in runtime.plans))
                    finally:
                        await close_clients(clients)
                        runtime.close()
        asyncio.run(run())

    def test_model_only_native_methods_and_no_schema_only_recovery(self):
        async def run():
            for protocol in ("openai", "anthropic"):
                with self.subTest(protocol=protocol), ProviderServer(Fixture(protocol)) as server:
                    clients, runtime = native_model(server, protocol), EvidenceRuntime(endpoint=ENDPOINT)
                    try:
                        llm = with_caveman_model(clients[0], runtime=runtime, scope=scope())
                        self.assertIsInstance(llm, LLM)
                        original = source_history()
                        before = [m.model_dump() for m in original]
                        tool = FunctionTool.from_defaults(read_logs)
                        for async_, streaming, with_tools in [(a, s, t) for a in (False, True) for s in (False, True) for t in (False, True)]:
                            prefix = "a" if async_ else ""
                            method = getattr(llm, prefix + ("stream_chat" if streaming else "chat") + ("_with_tools" if with_tools else ""))
                            kwargs = {"tools": [tool], "chat_history": original} if with_tools else {"messages": original}
                            result = await method(**kwargs) if async_ else method(**kwargs)
                            if streaming:
                                chunks = [item async for item in result] if async_ else list(result)
                                result = chunks[-1]
                            self.assertIsInstance(result, ChatResponse)
                            self.assertEqual(result.message.content, "retained-detail-70")
                        self.assertEqual([m.model_dump() for m in original], before)
                        self.assertFalse(any(p.replacements for _, p in runtime.plans))
                        self.assertTrue(any(p.reason == "recovery_unavailable" for _, p in runtime.plans))
                        self.assertEqual(len(server.fixture.calls), 8)
                        # An exact schema with a different callable is still not a native registration.
                        bundle = CavemanFunctionAgent(llm=clients[0], tools=[], runtime=runtime, scope=scope()).caveman_recovery
                        fake = FunctionTool(fn=lambda **kwargs: "fake", metadata=bundle.metadata)
                        await llm.achat_with_tools([tool, fake], chat_history=original)
                        self.assertFalse(runtime.plans[-1][1].replacements)
                        self.assertFalse(server.errors, server.errors)
                    finally:
                        await close_clients(clients)
                        runtime.close()
        asyncio.run(run())

    def test_sync_async_structured_output_is_native(self):
        async def run():
            for protocol in ("openai", "anthropic"):
                with self.subTest(protocol=protocol), ProviderServer(Fixture(protocol)) as server:
                    clients, runtime = native_model(server, protocol), EvidenceRuntime(endpoint=ENDPOINT)
                    try:
                        llm = with_caveman_model(clients[0], runtime=runtime, scope=scope())
                        result = llm.structured_predict(Answer, PromptTemplate("Return an Answer"))
                        self.assertEqual(result, Answer(answer=42))
                        result = await llm.astructured_predict(Answer, PromptTemplate("Return an Answer"))
                        self.assertEqual(result, Answer(answer=42))
                        structured = llm.as_structured_llm(Answer)
                        response = structured.chat([ChatMessage(content="Return an Answer")])
                        self.assertIsInstance(response.raw, Answer)
                        response = await structured.achat([ChatMessage(content="Return an Answer")])
                        self.assertIsInstance(response.raw, Answer)
                        chunks = list(llm.stream_structured_predict(Answer, PromptTemplate("Return an Answer")))
                        if protocol == "openai":
                            self.assertEqual(chunks[-1].answer, 42)
                        else:
                            # Native core 0.14.24 ignores Anthropic ToolCallBlock
                            # in its structured-stream parser. Preserve parity;
                            # evidence explicitly leaves this operation blocked.
                            native_chunks = list(clients[0].stream_structured_predict(Answer, PromptTemplate("Return an Answer")))
                            self.assertIsNone(native_chunks[-1].answer)
                            self.assertEqual(chunks[-1].model_dump(), native_chunks[-1].model_dump())
                        chunks = [item async for item in await llm.astream_structured_predict(Answer, PromptTemplate("Return an Answer"))]
                        if protocol == "openai":
                            self.assertEqual(chunks[-1].answer, 42)
                        else:
                            native_chunks = [item async for item in await clients[0].astream_structured_predict(Answer, PromptTemplate("Return an Answer"))]
                            self.assertIsNone(native_chunks[-1].answer)
                            self.assertEqual(chunks[-1].model_dump(), native_chunks[-1].model_dump())
                        self.assertFalse(any(p.replacements for _, p in runtime.plans))
                        self.assertEqual(len(server.fixture.calls), 6 if protocol == "openai" else 8)
                        self.assertFalse(server.errors, server.errors)
                    finally:
                        await close_clients(clients)
                        runtime.close()
        asyncio.run(run())

    def test_twenty_native_turns_and_serialized_restart_keep_replacement_bytes(self):
        async def run():
            for protocol in ("openai", "anthropic"):
                with self.subTest(protocol=protocol), ProviderServer(Fixture(protocol)) as server:
                    clients = native_model(server, protocol)
                    runtime = EvidenceRuntime(endpoint=ENDPOINT)
                    current_scope = scope()
                    try:
                        def agent_for(connection):
                            return CavemanFunctionAgent(llm=clients[0], tools=[read_logs], runtime=connection,
                                scope=current_scope, streaming=False)
                        agent = agent_for(runtime)
                        context = Context(agent)
                        memory = ChatMemoryBuffer.from_defaults(token_limit=80000)
                        result = await agent.run("Answer", ctx=context, memory=memory, max_iterations=6)
                        self.assertEqual(result.response.content, "retained-detail-70")
                        first_replacement = next(p.replacements[0]["text"] for _, p in runtime.plans if p.replacements)
                        first_wire = server.fixture.calls[1][1]["messages"]
                        for turn in range(1, 20):
                            if turn == 10:
                                state = json.loads(json.dumps(context.to_dict()))
                                runtime.close()
                                restart_runtime()
                                runtime = EvidenceRuntime(endpoint=ENDPOINT)
                                agent = agent_for(runtime)
                                context = Context.from_dict(agent, state)
                            result = await agent.run(f"Continue {turn}", ctx=context, max_iterations=3)
                            self.assertEqual(result.response.content, "retained-detail-70")
                            candidate = [p for _, p in runtime.plans if p.replacements][-1]
                            self.assertEqual(candidate.replacements[0]["text"], first_replacement)
                            wire = server.fixture.calls[-1][1]["messages"]
                            # Compare native provider serialization of the prefix;
                            # middleware does not claim provider cache-hit evidence.
                            self.assertEqual(wire[:len(first_wire)], first_wire)
                        self.assertEqual(len(server.fixture.calls), 22)
                        self.assertFalse(server.errors, server.errors)
                    finally:
                        await close_clients(clients)
                        runtime.close()
        asyncio.run(run())

    def test_native_citation_query_engine_keeps_source_mapping(self):
        async def run():
            with ProviderServer(Fixture("openai")) as server:
                clients, runtime = native_model(server, "openai"), EvidenceRuntime(endpoint=ENDPOINT)
                nodes = [TextNode(id_=f"source-{i}", text=SOURCE, metadata={"file": f"source-{i}.log"},
                    relationships={NodeRelationship.SOURCE: RelatedNodeInfo(node_id=f"document-{i}")}) for i in range(2)]
                before = [node.model_dump() for node in nodes]
                try:
                    index = VectorStoreIndex(nodes, embed_model=MockEmbedding(embed_dim=4))
                    llm = with_caveman_model(clients[0], runtime=runtime, scope=scope())
                    processor = CavemanNodePostprocessor(runtime=runtime, scope=scope())
                    engine = CitationQueryEngine(retriever=index.as_retriever(similarity_top_k=2), llm=llm,
                        citation_chunk_size=20000, node_postprocessors=[processor],
                        response_synthesizer=get_response_synthesizer(llm=llm, response_mode="simple_summarize"))
                    result = await engine.aquery("Find the cited detail")
                    self.assertEqual(str(result), "retained-detail-70 [1] [2]")
                    self.assertEqual(len(result.source_nodes), 2)
                    for number, (source, original) in enumerate(zip(result.source_nodes, nodes), 1):
                        self.assertTrue(source.node.text.startswith(f"Source {number}:\n"))
                        self.assertEqual(source.node.metadata, original.metadata)
                        self.assertEqual(source.node.relationships, original.relationships)
                        self.assertIn("retained-detail-70", source.node.text)
                        self.assertIsNotNone(source.score)
                    self.assertEqual([node.model_dump() for node in nodes], before)
                    self.assertFalse(any(p.replacements for _, p in runtime.plans))
                finally:
                    await close_clients(clients)
                    runtime.close()
        asyncio.run(run())

    def test_native_completion_helpers_keep_objects_and_options(self):
        async def run():
            for protocol in ("openai", "anthropic"):
                with self.subTest(protocol=protocol), ProviderServer(Fixture(protocol)) as server:
                    clients, runtime = native_model(server, protocol), EvidenceRuntime(endpoint=ENDPOINT)
                    try:
                        llm = with_caveman_model(clients[0], runtime=runtime, scope=scope())
                        baseline = clients[0].complete("Answer", formatted=True)
                        def fields(response):
                            return type(response), response.text, response.delta, response.additional_kwargs, response.raw
                        self.assertEqual(fields(llm.complete("Answer", formatted=True)), fields(baseline))
                        self.assertEqual(fields(await llm.acomplete("Answer", formatted=True)), fields(baseline))
                        baseline_chunks = list(clients[0].stream_complete("Answer", formatted=True))
                        self.assertEqual([fields(c) for c in llm.stream_complete("Answer", formatted=True)], [fields(c) for c in baseline_chunks])
                        chunks = [c async for c in await llm.astream_complete("Answer", formatted=True)]
                        self.assertEqual(chunks[-1].text, "native")
                        for _, request in server.fixture.calls:
                            self.assertEqual(request["temperature"], 0.3)
                        self.assertFalse(runtime.plans)
                        self.assertEqual(len(server.fixture.calls), 6)
                    finally:
                        await close_clients(clients)
                        runtime.close()
        asyncio.run(run())

    def test_native_anthropic_signed_thinking_is_unchanged(self):
        async def run():
            for streaming in (False, True):
                with self.subTest(streaming=streaming), ProviderServer(Fixture("anthropic", reasoning=True)) as server:
                    reports = []
                    clients, runtime = native_model(server, "anthropic"), EvidenceRuntime(endpoint=ENDPOINT, on_report=reports.append)
                    try:
                        clients[0].thinking_dict = {"type": "enabled", "budget_tokens": 1024}
                        agent = CavemanFunctionAgent(llm=clients[0], tools=[read_logs], runtime=runtime, scope=scope(), streaming=streaming)
                        result = await agent.run("Answer", max_iterations=6)
                        self.assertEqual(result.response.content, "retained-detail-70")
                        signed = [part for message in server.fixture.calls[1][1]["messages"] if isinstance(message["content"], list)
                                  for part in message["content"] if part["type"] == "thinking"]
                        self.assertEqual(signed, [{"type": "thinking", "thinking": "native reasoning", "signature": "fixture-native-signature"}])
                        self.assertEqual(server.fixture.calls[1][1]["thinking"], clients[0].thinking_dict)
                        self.assertTrue(server.fixture.recovered, json.dumps({
                            "streaming": streaming, "provider_calls": len(server.fixture.calls),
                            "plans": [{"status": plan.status, "reason": plan.reason, "replacements": len(plan.replacements)}
                                      for _, plan in runtime.plans],
                            "reports": [{"status": report.status, "reason": report.reason,
                                         "replacements": report.replacement_count} for report in reports],
                        }, sort_keys=True))
                        self.assertFalse(server.errors, server.errors)
                    finally:
                        await close_clients(clients)
                        runtime.close()
        asyncio.run(run())

    def test_rag_queries_retain_cached_nodes_scores_metadata_and_citations(self):
        async def run():
            for protocol in ("openai", "anthropic"):
                for streaming in (False, True):
                    with self.subTest(protocol=protocol, streaming=streaming), ProviderServer(Fixture(protocol)) as server:
                        clients, runtime = native_model(server, protocol), EvidenceRuntime(endpoint=ENDPOINT)
                        originals = [TextNode(id_=f"node-{i}", text=SOURCE, metadata={"source": f"log-{i}.txt", "rank": i},
                            relationships={NodeRelationship.SOURCE: RelatedNodeInfo(node_id=f"doc-{i}")}) for i in range(2)]
                        before = [n.model_dump() for n in originals]
                        try:
                            index = VectorStoreIndex(originals, embed_model=MockEmbedding(embed_dim=4))
                            cached_before = {key: value.model_dump() for key, value in index.docstore.docs.items()}
                            llm = with_caveman_model(clients[0], runtime=runtime, scope=scope())
                            processor = CavemanNodePostprocessor(runtime=runtime, scope=scope())
                            engine = RetrieverQueryEngine(retriever=index.as_retriever(similarity_top_k=2), node_postprocessors=[processor],
                                response_synthesizer=get_response_synthesizer(llm=llm, response_mode="simple_summarize", streaming=streaming))
                            selected = index.as_retriever(similarity_top_k=2).retrieve("Find detail 70")
                            for query_async in (False, True, False, True):
                                response = await engine.aquery("Find detail 70") if query_async else engine.query("Find detail 70")
                                if isinstance(response, AsyncStreamingResponse):
                                    answer = "".join([part async for part in response.async_response_gen()])
                                elif isinstance(response, StreamingResponse):
                                    answer = "".join(response.response_gen)
                                else:
                                    self.assertIsInstance(response, Response)
                                    answer = str(response)
                                self.assertEqual(answer, "retained-detail-70 [1] [2]")
                                self.assertEqual(len(response.source_nodes), 2)
                                for source, expected in zip(response.source_nodes, selected):
                                    self.assertIsInstance(source, NodeWithScore)
                                    self.assertEqual(source.node.node_id, expected.node.node_id)
                                    self.assertEqual(source.node.metadata, expected.node.metadata)
                                    self.assertEqual(source.node.relationships, expected.node.relationships)
                                    self.assertEqual(source.score, expected.score)
                                    self.assertIn("retained-detail-70", source.node.text)
                            self.assertEqual([n.model_dump() for n in originals], before)
                            self.assertEqual({key: value.model_dump() for key, value in index.docstore.docs.items()}, cached_before)
                            self.assertFalse(any(p.replacements for _, p in runtime.plans))
                            self.assertTrue(any(p.reason == "recovery_unavailable" for _, p in runtime.plans))
                            self.assertEqual(len(server.fixture.calls), 4)
                            self.assertFalse(server.errors, server.errors)
                        finally:
                            await close_clients(clients)
                            runtime.close()
        asyncio.run(run())

    def test_offset_citations_and_unknown_node_subclasses_are_protected(self):
        class UnknownNode(TextNode):
            custom: str = "opaque"
        runtime = EvidenceRuntime(endpoint=ENDPOINT)
        try:
            processor = CavemanNodePostprocessor(runtime=runtime, scope=scope())
            nodes = [NodeWithScore(node=TextNode(text=SOURCE, start_char_idx=0, end_char_idx=len(SOURCE)), score=0.9),
                     NodeWithScore(node=UnknownNode(text=SOURCE), score=0.8)]
            view = processor.postprocess_nodes(nodes, query_str="Keep exact citations")
            self.assertTrue(all(a is b for a, b in zip(view, nodes)))
            self.assertEqual(runtime.plans[-1][1].reason, "no_candidate")
        finally:
            runtime.close()

    def test_native_name_collision_and_tool_errors_never_enable_lossiness(self):
        async def run():
            for protocol in ("openai", "anthropic"):
                for error in (False, True):
                    with self.subTest(protocol=protocol, error=error), ProviderServer(Fixture(protocol)) as server:
                        clients, runtime = native_model(server, protocol), EvidenceRuntime(endpoint=ENDPOINT)
                        try:
                            source = FunctionTool.from_defaults(read_logs,
                                callback=(lambda text: ToolOutput(content=text, tool_name="read_logs", raw_input={}, raw_output=text, is_error=True)) if error else None)
                            fake = FunctionTool.from_defaults(lambda handle: "fake", name="caveman_retrieve")
                            agent = CavemanFunctionAgent(llm=clients[0], tools=[source] if error else [source, fake], runtime=runtime, scope=scope(), streaming=False)
                            result = await agent.run("Answer", max_iterations=4)
                            self.assertEqual(result.response.content, "retained-detail-70")
                            self.assertEqual(len(server.fixture.calls), 2)
                            self.assertFalse(any(p.replacements for _, p in runtime.plans))
                            self.assertEqual(len([t for t in agent.tools if t.metadata.name == "caveman_retrieve"]), 1)
                            self.assertFalse(server.errors, server.errors)
                        finally:
                            await close_clients(clients)
                            runtime.close()
        asyncio.run(run())

    def test_gated_native_agent_stream_preserves_first_event_and_tool_deltas(self):
        async def run():
            for protocol in ("openai", "anthropic"):
                with self.subTest(protocol=protocol), ProviderServer(Fixture(protocol)) as server:
                    server.fixture.release.clear()
                    server.fixture.release_tools.clear()
                    runtime, clients = EvidenceRuntime(endpoint=ENDPOINT), native_model(server, protocol)
                    try:
                        agent = CavemanFunctionAgent(llm=clients[0], tools=[read_logs], runtime=runtime, scope=scope(), streaming=True)
                        handler = agent.run("Answer", max_iterations=6)
                        events = []
                        async def consume():
                            async for event in handler.stream_events():
                                events.append(event)
                                if isinstance(event, AgentStream) and event.tool_calls:
                                    server.fixture.release_tools.set()
                                if isinstance(event, AgentStream) and event.delta and not server.fixture.release.is_set():
                                    self.assertFalse(server.fixture.finished)
                                    server.fixture.release.set()
                        await asyncio.wait_for(consume(), timeout=12)
                        self.assertEqual((await handler).response.content, "retained-detail-70")
                        self.assertEqual(len(server.fixture.calls), 3)
                        self.assertTrue(any(isinstance(e, AgentStream) and e.tool_calls for e in events))
                        self.assertFalse(server.errors, server.errors)
                    finally:
                        server.fixture.release.set()
                        server.fixture.release_tools.set()
                        await close_clients(clients)
                        runtime.close()
        asyncio.run(run())

    def test_cancellation_during_optimizer_prevents_provider_dispatch(self):
        async def run():
            for streaming in (False, True):
                with ProviderServer(Fixture("openai")) as server:
                    runtime, clients = GatedRuntime(endpoint=ENDPOINT), native_model(server, "openai")
                    try:
                        llm = with_caveman_model(clients[0], runtime=runtime, scope=scope())
                        async def generate():
                            if streaming:
                                iterator = await llm.astream_chat(source_history())
                                await anext(iterator)
                            else:
                                await llm.achat(source_history())
                        task = asyncio.create_task(generate())
                        self.assertTrue(await asyncio.to_thread(runtime.entered.wait, 3))
                        task.cancel()
                        with self.assertRaises(asyncio.CancelledError):
                            await task
                        self.assertEqual(len(server.fixture.calls), 0)
                        self.assertTrue(any(r["event_kind"] == "cancelled" for r in runtime.receipts))
                        self.assertIsNone(owner.get())
                    finally:
                        runtime.release.set()
                        await close_clients(clients)
                        runtime.close()
        asyncio.run(run())

    def test_stream_close_and_cancel_are_incomplete_without_extra_requests(self):
        async def run():
            for protocol in ("openai", "anthropic"):
                for async_ in (False, True):
                    with self.subTest(protocol=protocol, async_=async_), ProviderServer(Fixture(protocol)) as server:
                        server.fixture.release.clear()
                        runtime, clients = EvidenceRuntime(endpoint=ENDPOINT), native_model(server, protocol)
                        try:
                            llm = with_caveman_model(clients[0], runtime=runtime, scope=scope())
                            messages = [ChatMessage(content="Answer")]
                            iterator = await llm.astream_chat(messages) if async_ else llm.stream_chat(messages)
                            response = await anext(iterator) if async_ else next(iterator)
                            self.assertIsInstance(response, ChatResponse)
                            self.assertFalse(server.fixture.finished)
                            if async_:
                                await iterator.aclose()
                            else:
                                iterator.close()
                            self.assertEqual(len(server.fixture.calls), 1)
                            self.assertTrue(any(r["event_kind"] == "cancelled" and r["usage"] is None for r in runtime.receipts))
                            self.assertFalse(any(r["event_kind"] == "completed" for r in runtime.receipts))
                            self.assertIsNone(owner.get())
                        finally:
                            server.fixture.release.set()
                            await close_clients(clients)
                            runtime.close()
        asyncio.run(run())

    def test_provider_errors_are_native_and_never_retry_original(self):
        async def run():
            for protocol in ("openai", "anthropic"):
                for async_ in (False, True):
                    with self.subTest(protocol=protocol, async_=async_), ProviderServer(Fixture(protocol, failure=True)) as server:
                        runtime, clients = EvidenceRuntime(endpoint=ENDPOINT), native_model(server, protocol)
                        try:
                            llm = with_caveman_model(clients[0], runtime=runtime, scope=scope())
                            with self.assertRaises(Exception) as error:
                                if async_:
                                    await llm.achat(source_history())
                                else:
                                    llm.chat(source_history())
                            self.assertEqual(type(error.exception).__name__, "InternalServerError")
                            self.assertEqual(len(server.fixture.calls), 1)
                            self.assertEqual(len([r for r in runtime.receipts if r["event_kind"] == "failed"]), 1)
                        finally:
                            await close_clients(clients)
                            runtime.close()
        asyncio.run(run())

    def test_exact_versions_and_documented_example(self):
        from example import build_agent
        diagnostics = []
        runtime = MiddlewareRuntime(on_diagnostic=diagnostics.append)
        try:
            with patch("caveman_middleware._versions.installed_version", return_value="999"):
                processor = CavemanNodePostprocessor(runtime=runtime, scope=scope())
                nodes = [NodeWithScore(node=TextNode(text=SOURCE, id_="untested-version"))]
                self.assertIs(processor.postprocess_nodes(nodes), nodes)
                self.assertEqual(diagnostics, [{"code": "unsupported_version", "cache_continuity": "unavailable"}])
        finally:
            runtime.close()
        async def run():
            with ProviderServer(Fixture("openai")) as server:
                runtime, clients = EvidenceRuntime(endpoint=ENDPOINT), native_model(server, "openai")
                try:
                    agent = build_agent(clients[0], runtime, namespace="example-" + str(uuid.uuid4()), session_id="example", read_logs=read_logs)
                    result = await agent.run("Answer", max_iterations=6)
                    self.assertEqual(result.response.content, "retained-detail-70")
                    self.assertEqual(len(server.fixture.calls), 3)
                finally:
                    await close_clients(clients)
                    runtime.close()
        asyncio.run(run())


class LlamaIndexCertification(unittest.IsolatedAsyncioTestCase):
    async def test_native_stream_helper_validation_phase_and_passive_reports(self):
        from unittest.mock import patch
        from caveman_middleware._versions import installed_version

        async def failure(llm, asynchronous):
            iterator, phase = None, "call"
            try:
                iterator = await llm.astream_structured_predict(Answer, None) if asynchronous else llm.stream_structured_predict(Answer, None)
                phase = "iteration"
                if asynchronous:
                    await anext(iterator)
                else:
                    next(iterator)
                self.fail("The native invalid prompt must fail")
            except Exception as error:
                return phase, type(error).__name__, str(error)
            finally:
                if iterator is not None:
                    if asynchronous:
                        await iterator.aclose()
                    else:
                        iterator.close()

        for protocol in ("openai", "anthropic"):
            with ProviderServer(Fixture(protocol)) as server:
                clients = native_model(server, protocol)
                try:
                    native = [await failure(clients[0], asynchronous) for asynchronous in (False, True)]
                    for mode in ("compress", "off", "unsupported"):
                        with self.subTest(protocol=protocol, mode=mode):
                            reports = []
                            runtime = EvidenceRuntime(endpoint=ENDPOINT, mode="off" if mode == "off" else "compress", on_report=reports.append)
                            def metadata(name):
                                return "unsupported-fixture-version" if mode == "unsupported" and name == "llama-index-core" else installed_version(name)
                            try:
                                with patch("caveman_middleware._versions.installed_version", side_effect=metadata):
                                    def unused_scope(_):
                                        self.fail("A passive helper must not resolve a content scope")
                                    llm = with_caveman_model(clients[0], runtime=runtime, scope=unused_scope)
                                    self.assertEqual(reports, [])
                                    actual = [await failure(llm, asynchronous) for asynchronous in (False, True)]
                                self.assertEqual(actual, native)
                                self.assertEqual(len(reports), 2)
                                self.assertEqual({report.status for report in reports}, {"disabled" if mode == "off" else "skipped"})
                                self.assertEqual({report.reason for report in reports}, {"disabled" if mode == "off" else "unsupported_version" if mode == "unsupported" else "structured_output"})
                                self.assertTrue(all(report.replacement_count == 0 for report in reports))
                                self.assertEqual(runtime.plans, [])
                                self.assertEqual(runtime.receipts, [])
                            finally:
                                runtime.close()
                    self.assertEqual(server.fixture.calls, [])
                finally:
                    await close_clients(clients)

    async def test_openai_sync_exact_operation_journeys(self):
        from _certification_native import certify_cells
        await certify_cells(self, "openai", "sync")

    async def test_openai_async_exact_operation_journeys(self):
        from _certification_native import certify_cells
        await certify_cells(self, "openai", "async")

    async def test_anthropic_sync_exact_operation_journeys(self):
        from _certification_native import certify_cells
        await certify_cells(self, "anthropic", "sync")

    async def test_anthropic_async_exact_operation_journeys(self):
        from _certification_native import certify_cells
        await certify_cells(self, "anthropic", "async")

    async def test_source_reader_binding_and_inflight_changes_keep_original_queries(self):
        from _attestation import reader_boundaries
        await reader_boundaries(self)

    async def test_native_executor_bundle_and_inflight_changes_preserve_model_calls(self):
        from _attestation import bundle_boundaries
        await bundle_boundaries(self)


if __name__ == "__main__":
    from _test_result import ReportingResult
    unittest.main(verbosity=2, testRunner=unittest.TextTestRunner(verbosity=2, resultclass=ReportingResult))
