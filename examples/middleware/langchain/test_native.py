"""Real create_agent, provider models, checkpoints and native tool nodes."""
import asyncio
import copy
import json
import os
import re
import unittest
from contextlib import nullcontext
from unittest.mock import patch

import httpx2
from langchain.agents import create_agent
from langchain.agents.middleware import AgentMiddleware
from langchain_core.documents import Document
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from langchain_anthropic import ChatAnthropic
from langgraph.checkpoint.memory import InMemorySaver
from caveman_cloud.middleware import MiddlewareRuntime, Scope
from caveman_middleware.langchain import with_caveman_agent, with_caveman_model, scope_from_config, CavemanDocumentCompressor
from python_fixture import ProviderServer, restart_runtime
from test_providers import AnthropicFixture, OpenAIFixture, SOURCE, Answer

ENDPOINT = os.environ["CAVEMAN_MIDDLEWARE_ENDPOINT"]


class OpenAILoopFixture(OpenAIFixture):
    def response(self, request):
        body = json.loads(request.content)
        if body["model"] in ("helpers", "parse", "failure"):
            return super().response(request)
        self.calls.append((request, body))
        source = next((m for m in body["messages"] if m["role"] == "tool" and m.get("tool_call_id") == "read-1"), None)
        function, content = None, None
        if source is None:
            function = {"id": "read-1", "type": "function", "function": {"name": "read_logs", "arguments": "{}"}}
        else:
            handle = re.search(r"cmw_[a-f0-9]{48}", source["content"])
            assert handle, "LangChain provider request did not contain an optimized tool result"
            assert "retained-detail-70" not in source["content"]
            recovered = next((m for m in body["messages"] if m["role"] == "tool" and m.get("tool_call_id") == "recover-1"), None)
            if recovered is None:
                function = {"id": "recover-1", "type": "function", "function": {"name": "caveman_retrieve", "arguments": json.dumps({"handle": handle[0]})}}
            else:
                assert json.loads(recovered["content"])["text"] == SOURCE
                content = "retained-detail-70"
        message = {"role": "assistant", "content": content}
        if function:
            message["tool_calls"] = [function]
        return httpx2.Response(200, json={"id": "chatcmpl-fixture", "object": "chat.completion", "created": 1, "model": "fixture-model",
            "choices": [{"index": 0, "message": message, "finish_reason": "tool_calls" if function else "stop", "logprobs": None}],
            "usage": {"prompt_tokens": 1000, "completion_tokens": 20, "total_tokens": 1020}})


@tool
def read_logs() -> str:
    """Read original diagnostic logs."""
    return SOURCE


def scoped(config):
    return scope_from_config(config, namespace="langchain-native")


class NativeLangChain(unittest.TestCase):
    def test_openai_graph_interleaved_threads_restart_branch_interrupt_and_native_tools(self):
        fixture = OpenAILoopFixture()
        with ProviderServer(fixture) as server, MiddlewareRuntime(endpoint=ENDPOINT) as runtime:
            runtime.ready()
            model = ChatOpenAI(model="fixture-model", api_key="fixture", base_url=server.url + "/v1", max_retries=0, use_responses_api=False)
            # A nested native model wrapper must yield to agent middleware.
            model = with_caveman_model(model, runtime=runtime, scope=scoped)
            checkpoint = InMemorySaver()
            config_a = {"configurable": {"thread_id": "thread-a"}}
            config_b = {"configurable": {"thread_id": "thread-b"}}
            options = with_caveman_agent(dict(model=model, tools=[read_logs], checkpointer=checkpoint), runtime=runtime, scope=scoped)
            agent = create_agent(**options)
            # LangGraph itself assigns missing message IDs. Preassign identity
            # so the mutation assertion isolates middleware from that baseline.
            original = {"messages": [HumanMessage("Read logs, recover row 70", id="user-original")]}
            before = copy.deepcopy(original)
            a = agent.invoke(original, config_a)
            b = agent.invoke(original, config_b)
            self.assertEqual(a["messages"][-1].content, "retained-detail-70")
            self.assertEqual(b["messages"][-1].content, "retained-detail-70")
            self.assertEqual(original, before)
            saved = agent.get_state(config_a)
            self.assertEqual(next(m.content for m in saved.values["messages"] if isinstance(m, ToolMessage) and m.name == "read_logs"), SOURCE)
            first_a = fixture.calls[1][1]["messages"][-1]["content"]
            first_b = fixture.calls[4][1]["messages"][-1]["content"]
            self.assertNotEqual(first_a, first_b, "independent threads cannot share scoped grants")
            restart_runtime()
            again = agent.invoke({"messages": [HumanMessage("Repeat recovered row")]}, config_a)
            self.assertEqual(again["messages"][-1].content, "retained-detail-70")
            resumed_source = next(m["content"] for m in fixture.calls[-1][1]["messages"] if m["role"] == "tool" and m.get("tool_call_id") == "read-1")
            self.assertEqual(resumed_source, first_a)
            branch_config = {"configurable": {**saved.config["configurable"], "caveman_branch_id": "fork"}}
            branch = agent.invoke({"messages": [HumanMessage("Branch question")]}, branch_config)
            self.assertEqual(branch["messages"][-1].content, "retained-detail-70")
            # Native interrupt/resume executes the same registered ToolNode.
            paused = create_agent(**with_caveman_agent(dict(model=model, tools=[read_logs], checkpointer=InMemorySaver(), interrupt_before=["tools"]), runtime=runtime, scope=scoped))
            paused_config = {"configurable": {"thread_id": "interrupted"}}
            paused.invoke(original, paused_config)
            self.assertEqual(paused.get_state(paused_config).next, ("tools",))
            paused.invoke(None, paused_config)
            # A second tool request is another native interrupt.
            result = paused.invoke(None, paused_config)
            self.assertEqual(result["messages"][-1].content, "retained-detail-70")
            self.assertEqual(server.errors, [])

    def test_anthropic_native_agent_and_recovery(self):
        fixture = AnthropicFixture()
        with ProviderServer(fixture) as server, MiddlewareRuntime(endpoint=ENDPOINT) as runtime:
            model = ChatAnthropic(model_name="fixture-model", api_key="fixture", base_url=server.url, max_retries=0, max_tokens_to_sample=100)
            agent = create_agent(**with_caveman_agent(dict(model=model, tools=[read_logs]), runtime=runtime, scope=Scope("langchain", "anthropic")))
            result = agent.invoke({"messages": [HumanMessage("Read source and recover")]})
            self.assertEqual(result["messages"][-1].content, "retained-detail-70")
            self.assertEqual(len(fixture.calls), 3)
            self.assertEqual(server.errors, [])

    def test_model_helpers_batch_callbacks_stream_and_rag_preserve_native_values(self):
        fixture = OpenAIFixture()
        with ProviderServer(fixture) as server, MiddlewareRuntime(endpoint=ENDPOINT) as runtime:
            model = ChatOpenAI(model="helpers", api_key="fixture", base_url=server.url + "/v1", max_retries=0, use_responses_api=False)
            native = with_caveman_model(model, runtime=runtime, scope=scoped)
            self.assertIsInstance(native, ChatOpenAI)
            self.assertIsNot(native, model)
            messages = [HumanMessage("Read"), AIMessage(content="", tool_calls=[{"name": "read_logs", "args": {}, "id": "read-1", "type": "tool_call"}]), ToolMessage(content=SOURCE, tool_call_id="read-1", name="read_logs", artifact={"source": "document-1"})]
            before = copy.deepcopy(messages)
            config = {"configurable": {"thread_id": "direct"}, "tags": ["caller-tag"], "metadata": {"original": True}}
            result = native.bind_tools([read_logs]).invoke(messages, config)
            self.assertIsInstance(result, AIMessage)
            self.assertEqual(messages, before)
            self.assertEqual(fixture.calls[-1][1]["messages"][-1]["content"], SOURCE)
            results = native.batch([messages, messages], [{"configurable": {"thread_id": "batch-a"}}, {"configurable": {"thread_id": "batch-b"}}])
            self.assertEqual([r.content for r in results], ["native", "native"])
            fixture.released = True
            self.assertEqual("".join(c.content for c in native.stream(messages, config)), "native")
            structured = with_caveman_model(model.model_copy(update={"model_name": "parse"}), runtime=runtime, scope=Scope("langchain", "structured"))
            self.assertEqual(structured.with_structured_output(Answer).invoke("Return an answer"), Answer(answer=42))
            docs = [Document(id="a", page_content=SOURCE, metadata={"source": "a"}), Document(id="b", page_content=SOURCE, metadata={"source": "b"})]
            compressor = CavemanDocumentCompressor(runtime=runtime, scope=Scope("langchain", "rag"))
            view = compressor.compress_documents(docs, "row 70")
            self.assertEqual(view, docs)
            self.assertEqual([d.id for d in view], ["a", "b"])
            self.assertEqual(server.errors, [])


class AsyncNativeLangChain(unittest.IsolatedAsyncioTestCase):
    async def test_passive_reports_preserve_native_model_calls_streams_and_errors(self):
        from openai import InternalServerError

        for mode in ("off", "unsupported", "opaque"):
            reports, unexpected = [], []
            fixture = OpenAIFixture()
            with self.subTest(mode=mode), ProviderServer(fixture) as server, MiddlewareRuntime(endpoint=ENDPOINT, mode="off" if mode == "off" else "compress", on_report=reports.append) as runtime:
                def no_io(*args, **kwargs):
                    unexpected.append(True)
                    raise AssertionError("A passive report cannot perform optimizer or receipt I/O")
                runtime._http = no_io
                def unused_scope(_config):
                    raise AssertionError("A passive call must not resolve a trusted recovery scope")
                source = object()
                messages = [HumanMessage(content="native", additional_kwargs={"local_opaque": source} if mode == "opaque" else {})]
                original = ChatOpenAI(model="helpers", api_key="fixture", base_url=server.url + "/v1", max_retries=0, use_responses_api=False)
                gate = patch("caveman_middleware.langchain._supported", return_value=False) if mode == "unsupported" else nullcontext()
                with gate:
                    native = with_caveman_model(original, runtime=runtime, scope=unused_scope)
                    self.assertEqual(reports, [])
                    self.assertEqual((await original.ainvoke(messages)).content, "native")
                    self.assertEqual((await native.ainvoke(messages)).content, "native")
                    self.assertEqual((await asyncio.to_thread(native.invoke, messages)).content, "native")
                    self.assertTrue(all(body == fixture.calls[0][1] for _, body in fixture.calls))
                    fixture.released = True
                    self.assertEqual("".join([chunk.content async for chunk in native.astream(messages)]), "native")
                    failure = with_caveman_model(original.model_copy(update={"model_name": "failure"}), runtime=runtime, scope=unused_scope)
                    with self.assertRaises(InternalServerError):
                        await failure.ainvoke(messages)
                    self.assertEqual(len(fixture.calls), 5)
                    self.assertEqual(len(reports), 4)
                    reason = "disabled" if mode == "off" else "unsupported_version" if mode == "unsupported" else "unsupported_shape"
                    self.assertTrue(all(report.reason == reason and report.replacement_count == 0 for report in reports))
                    self.assertTrue(all(report.status == ("disabled" if mode == "off" else "skipped") for report in reports))
                    self.assertEqual(len({report.attempt_id for report in reports}), 4)
                    self.assertIs(runtime.last_report, reports[-1])
                    self.assertEqual(unexpected, [])
                    self.assertEqual(server.errors, [])
                    if mode == "opaque":
                        self.assertIs(messages[0].additional_kwargs["local_opaque"], source)

    async def test_async_graph_and_interleaved_tool_nodes(self):
        fixture = OpenAILoopFixture()
        with ProviderServer(fixture) as server, MiddlewareRuntime(endpoint=ENDPOINT) as runtime:
            model = ChatOpenAI(model="fixture-model", api_key="fixture", base_url=server.url + "/v1", max_retries=0, use_responses_api=False)
            agent = create_agent(**with_caveman_agent(dict(model=model, tools=[read_logs], checkpointer=InMemorySaver()), runtime=runtime, scope=scoped))
            results = await asyncio.gather(*(agent.ainvoke({"messages": [HumanMessage("Read source and recover")]}, {"configurable": {"thread_id": f"async-{i}"}}) for i in range(2)))
            self.assertEqual([r["messages"][-1].content for r in results], ["retained-detail-70"] * 2)
            self.assertEqual(server.errors, [])


from test_source_expansion import SourceExpansion, AsyncSourceExpansion
from _certification_native import run_certification
from _test_result import ReportingResult


class LangChainCertification(unittest.IsolatedAsyncioTestCase):
    async def test_f05_openai_exact_journeys(self):
        await run_certification(self, "F05", "openai")

    async def test_f05_anthropic_exact_journeys(self):
        await run_certification(self, "F05", "anthropic")

    async def test_f06_openai_exact_journeys(self):
        await run_certification(self, "F06", "openai")

    async def test_f06_anthropic_exact_journeys(self):
        await run_certification(self, "F06", "anthropic")


if __name__ == "__main__":
    unittest.main(verbosity=2, testRunner=unittest.TextTestRunner(verbosity=2, resultclass=ReportingResult))
