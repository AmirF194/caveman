"""Native retrieval -> Document views -> provider -> scoped source reader."""
import asyncio
import copy
import hashlib
import json
import os
import re
import unittest
from pathlib import Path

import httpx2
from langchain.agents import create_agent
from langchain_core.documents import Document
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.retrievers import BaseRetriever
from langchain_core.tools import StructuredTool
from langchain_openai import ChatOpenAI
from langchain_anthropic import ChatAnthropic
from caveman_cloud.middleware import MiddlewareRuntime, Scope, MiddlewareError
from caveman_cloud.middleware.runtime import RECOVERY_SCHEMA
from caveman_middleware.langchain import CavemanDocumentCompressor, CavemanMiddleware
from python_fixture import ProviderServer
from test_providers import SOURCE, OpenAIFixture

ENDPOINT = os.environ["CAVEMAN_MIDDLEWARE_ENDPOINT"]
FINAL = "retained-detail-70 [source-a] [source-b]"


class FixtureRetriever(BaseRetriever):
    """Application retriever implemented through LangChain's public contract."""
    documents: list[Document]
    calls: list[str] = []

    def _get_relevant_documents(self, query, *, run_manager):
        self.calls.append(query)
        return self.documents

    async def _aget_relevant_documents(self, query, *, run_manager):
        await asyncio.sleep(0)
        self.calls.append(query)
        return self.documents


def documents():
    return [Document(id="source-a", page_content=SOURCE, metadata={"source": "a.md", "citation": {"page": 1}}),
            Document(id="source-b", page_content=SOURCE, metadata={"source": "b.md", "citation": {"page": 2}}),
            Document(id="source-c", page_content="Short supporting source.", metadata={"source": "c.md"})]


def view_json(values):
    return json.dumps([{"id": d.id, "metadata": d.metadata, "text": d.page_content} for d in values], ensure_ascii=False)


def record_evidence(mode, fixture, retriever, views):
    directory = os.environ.get("CAVEMAN_LANGCHAIN_EVIDENCE_DIR")
    if not directory:
        return
    def digest(value):
        return hashlib.sha256(value.encode()).hexdigest()
    record = {
        "schema_version": 1, "integration_id": "F05", "language": "python", "mode": mode,
        "provider": fixture.protocol, "evidence_class": "installed_framework_local_http_real_engine",
        "provider_calls": len(fixture.calls), "streaming_requests": sum(bool(c.get("stream")) for c in fixture.calls),
        "provider_request_json_sha256": [digest(json.dumps(c, sort_keys=True, ensure_ascii=False)) for c in fixture.calls],
        "original_documents_unchanged": retriever.documents == documents(),
        "native_document_copies": all(type(d) is Document for d in views[0]),
        "document_order": [d.id for d in views[0]], "metadata_preserved": [d.metadata for d in views[0]] == [d.metadata for d in documents()],
        "sources": [{"source_id": p["source_id"], "handle": p["handle"], "original_sha256": p["original_sha256"],
                     "recovered_sha256": digest(p["text"]), "recovered_utf8_bytes": len(p["text"].encode()), "complete": p["complete"],
                     "compressed_view_sha256": digest(views[0][i].page_content)} for i, p in enumerate(fixture.pages)],
        "text_before_provider_completion": fixture.released if mode == "async-stream" else None,
    }
    path = Path(directory)
    path.mkdir(parents=True, exist_ok=True)
    (path / f"python-{mode}-{fixture.protocol}.json").write_text(json.dumps(record, indent=2) + "\n")


class RAGFixture:
    def __init__(self, protocol, compressed=True):
        self.protocol, self.compressed = protocol, compressed
        self.calls, self.pages, self.handles = [], [], []
        self.released, self.finished = False, False

    def response(self, request):
        body = json.loads(request.content)
        self.calls.append(body)
        results = ([m for m in body["messages"] if m["role"] == "tool"] if self.protocol == "openai" else
                   [p for m in body["messages"] if isinstance(m["content"], list) for p in m["content"] if p["type"] == "tool_result"])
        key = "tool_call_id" if self.protocol == "openai" else "tool_use_id"
        result = next((m for m in results if m[key] == "search-1"), None)
        calls, text = [], None
        if result is None:
            calls = [{"id": "search-1", "name": "search_documents", "args": {"query": "What is row 70?"}}]
        else:
            views = json.loads(result["content"])
            assert [d["id"] for d in views] == ["source-a", "source-b", "source-c"]
            assert [d["metadata"] for d in views] == [d.metadata for d in documents()]
            if not self.compressed:
                assert [d["text"] for d in views] == [d.page_content for d in documents()]
                text = FINAL
            else:
                self.handles = [re.search(r"cmw_[a-f0-9]{48}", d["text"])[0] for d in views[:2]]
                assert len(set(self.handles)) == 2, "duplicate content must retain distinct source grants"
                assert all("retained-detail-70" not in d["text"] for d in views[:2])
                assert views[2]["text"] == documents()[2].page_content
                recovered = [next((m for m in results if m[key] == f"expand-{i}"), None) for i in range(2)]
                if not all(recovered):
                    calls = [{"id": f"expand-{i}", "name": "caveman_retrieve", "args": {"handle": handle}} for i, handle in enumerate(self.handles)]
                else:
                    self.pages = [json.loads(m["content"]) for m in recovered]
                    assert [p["source_id"] for p in self.pages] == ["source-a", "source-b"]
                    assert all(p["text"].encode() == SOURCE.encode() and p["complete"] for p in self.pages)
                    assert all(p["original_sha256"] == hashlib.sha256(SOURCE.encode()).hexdigest() for p in self.pages)
                    text = FINAL
        if self.protocol == "openai":
            message = {"role": "assistant", "content": text}
            if calls:
                message["tool_calls"] = [{"id": c["id"], "type": "function", "function": {"name": c["name"], "arguments": json.dumps(c["args"])}} for c in calls]
            response = {"id": "rag-fixture", "object": "chat.completion", "model": body["model"], "created": 1,
                        "choices": [{"index": 0, "message": message, "finish_reason": "tool_calls" if calls else "stop", "logprobs": None}],
                        "usage": {"prompt_tokens": 1000, "completion_tokens": 20, "total_tokens": 1020}}
        else:
            response = {"id": "rag-fixture", "type": "message", "role": "assistant", "model": body["model"],
                        "content": [{"type": "tool_use", "id": c["id"], "name": c["name"], "input": c["args"]} for c in calls] if calls else [{"type": "text", "text": text}],
                        "stop_reason": "tool_use" if calls else "end_turn", "stop_sequence": None, "usage": {"input_tokens": 1000, "output_tokens": 20}}
        if not body.get("stream"):
            return httpx2.Response(200, json=response)
        fixture = self

        class Bytes(httpx2.SyncByteStream):
            def __iter__(self):
                def event(kind, **fields):
                    return ("event: " + kind + "\ndata: " + json.dumps({"type": kind, **fields}) + "\n\n").encode()
                if fixture.protocol == "openai":
                    base = {"id": "rag-fixture", "object": "chat.completion.chunk", "created": 1, "model": body["model"]}
                    def chunk(delta, finish=None):
                        return ("data: " + json.dumps({**base, "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}) + "\n\n").encode()
                    if calls:
                        yield chunk({"role": "assistant", "tool_calls": [{"index": i, "id": c["id"], "type": "function", "function": {"name": c["name"], "arguments": json.dumps(c["args"])}} for i, c in enumerate(calls)]})
                    else:
                        yield chunk({"role": "assistant", "content": "retained-"})
                        # ProviderServer gates this chunk until the consumer releases it.
                        import time
                        deadline = time.monotonic() + 5
                        while not fixture.released and time.monotonic() < deadline:
                            time.sleep(0.005)
                        assert fixture.released, "native agent stream buffered the final provider response"
                        fixture.finished = True
                        yield chunk({"content": "detail-70 [source-a] [source-b]"})
                    yield chunk({}, "tool_calls" if calls else "stop")
                    yield b"data: [DONE]\n\n"
                else:
                    yield event("message_start", message={**response, "content": [], "stop_reason": None})
                    for i, part in enumerate(response["content"]):
                        if part["type"] == "tool_use":
                            yield event("content_block_start", index=i, content_block={**part, "input": {}})
                            yield event("content_block_delta", index=i, delta={"type": "input_json_delta", "partial_json": json.dumps(part["input"])})
                        else:
                            yield event("content_block_start", index=i, content_block={"type": "text", "text": ""})
                            yield event("content_block_delta", index=i, delta={"type": "text_delta", "text": "retained-"})
                            assert fixture.released, "native agent stream buffered the final provider response"
                            fixture.finished = True
                            yield event("content_block_delta", index=i, delta={"type": "text_delta", "text": "detail-70 [source-a] [source-b]"})
                        yield event("content_block_stop", index=i)
                    yield event("message_delta", delta={"stop_reason": response["stop_reason"], "stop_sequence": None}, usage={"output_tokens": 20})
                    yield event("message_stop")
        return httpx2.Response(200, stream=Bytes(), headers={"content-type": "text/event-stream"})


def model_for(protocol, server):
    if protocol == "openai":
        return ChatOpenAI(model="rag-model", api_key="fixture", base_url=server.url + "/v1", max_retries=0, use_responses_api=False)
    return ChatAnthropic(model_name="rag-model", api_key="fixture", base_url=server.url, max_retries=0, max_tokens_to_sample=200)


def rag_agent(runtime, scope, model, *, asynchronous=False, expansion=True):
    retriever = FixtureRetriever(documents=documents())
    reader = (runtime.as_async() if asynchronous else runtime).recovery(scope)
    compressor = CavemanDocumentCompressor(runtime=runtime, scope=scope, source_expansion=reader if expansion else None)
    views = []

    def search(query: str):
        original = retriever.invoke(query)
        view = compressor.compress_documents(original, query)
        views.append(view)
        return view_json(view), original

    async def asearch(query: str):
        original = await retriever.ainvoke(query)
        view = await compressor.acompress_documents(original, query)
        views.append(view)
        return view_json(view), original

    def expand(handle: str, offset: int = 0, limit: int = 262144, query: str = ""):
        return json.dumps(reader.execute(dict(handle=handle, offset=offset, limit=limit, query=query)), ensure_ascii=False)

    async def aexpand(handle: str, offset: int = 0, limit: int = 262144, query: str = ""):
        return json.dumps(await reader.execute(dict(handle=handle, offset=offset, limit=limit, query=query)), ensure_ascii=False)

    search_tool = StructuredTool.from_function(func=search, coroutine=asearch, name="search_documents", description="Search application sources.", response_format="content_and_artifact")
    reader_tool = StructuredTool.from_function(func=expand, coroutine=aexpand, name=reader.name, description=reader.description, args_schema=copy.deepcopy(reader.input_schema))
    agent = create_agent(model=model, tools=[search_tool, *([reader_tool] if expansion else [])])
    return agent, retriever, views, reader


class SourceExpansion(unittest.TestCase):
    def assert_documents(self, result, retriever, views):
        self.assertEqual(result["messages"][-1].content, FINAL)
        self.assertEqual(retriever.documents, documents())
        artifact = next(m.artifact for m in result["messages"] if isinstance(m, ToolMessage) and m.name == "search_documents")
        self.assertEqual(artifact, documents())
        self.assertTrue(all(type(d) is Document for d in views[0]))
        self.assertEqual([d.id for d in views[0]], [d.id for d in documents()])
        self.assertEqual([d.metadata for d in views[0]], [d.metadata for d in documents()])

    def test_sync_native_rag_both_providers_and_exact_paging(self):
        for protocol in ("openai", "anthropic"):
            with self.subTest(protocol=protocol), MiddlewareRuntime(endpoint=ENDPOINT, deadline_ms=1000) as runtime:
                fixture = RAGFixture(protocol)
                with ProviderServer(fixture) as server:
                    scope = Scope("langchain-rag", "sync-" + protocol)
                    agent, retriever, views, reader = rag_agent(runtime, scope, model_for(protocol, server))
                    result = agent.invoke({"messages": [HumanMessage("Find row 70 with both citations")]})
                    self.assert_documents(result, retriever, views)
                    self.assertEqual(len(fixture.calls), 3)
                    chunks, offset = [], 0
                    while offset is not None:
                        page = reader.execute({"handle": fixture.handles[0], "offset": offset, "limit": 1021})
                        chunks.append(page["text"])
                        offset = page["next_offset"]
                    self.assertEqual("".join(chunks).encode(), SOURCE.encode())
                    with self.assertRaises(MiddlewareError) as error:
                        runtime.recovery(Scope(scope.namespace, scope.session_id, "other")).execute({"handle": fixture.handles[0]})
                    self.assertEqual(error.exception.code, "not_found")
                    self.assertEqual(server.errors, [])
                    record_evidence("sync", fixture, retriever, views)

    def test_default_and_invalid_expansion_never_grant_lossy_documents(self):
        with MiddlewareRuntime(endpoint=ENDPOINT, deadline_ms=1000) as runtime, MiddlewareRuntime(endpoint=ENDPOINT) as other:
            scope = Scope("langchain-rag", "invalid")
            changed_schema = runtime.recovery(scope)
            changed_schema.input_schema["properties"]["handle"]["type"] = "integer"
            changed_executor = runtime.recovery(scope)
            object.__setattr__(changed_executor, "execute", lambda args: SOURCE)
            invalid = [None, True, copy.deepcopy(RECOVERY_SCHEMA), lambda args: SOURCE,
                       copy.copy(runtime.recovery(scope)), changed_schema, changed_executor,
                       other.recovery(scope), runtime.recovery(Scope(scope.namespace, "different"))]
            for value in invalid:
                with self.subTest(expansion=type(value).__name__):
                    docs = documents()
                    view = CavemanDocumentCompressor(runtime=runtime, scope=scope, source_expansion=value).compress_documents(docs, "row 70")
                    self.assertEqual(view, docs)
                    self.assertTrue(all(a is b for a, b in zip(view, docs)))
            for mode, endpoint in (("off", ENDPOINT), ("record", ENDPOINT), ("compress", "http://127.0.0.1:1")):
                with MiddlewareRuntime(endpoint=endpoint, mode=mode) as control:
                    reader = control.recovery(scope)
                    docs = documents()
                    self.assertEqual(CavemanDocumentCompressor(runtime=control, scope=scope, source_expansion=reader).compress_documents(docs, "row70"), docs)

    def test_mutated_native_recovery_contract_does_not_authorize_lossiness(self):
        mutations = {
            "name": lambda t: setattr(t, "name", "other_reader"),
            "description": lambda t: setattr(t, "description", "Changed contract"),
            "schema": lambda t: t.args_schema["properties"]["handle"].update(type="integer"),
            "func": lambda t: setattr(t, "func", lambda **kwargs: "unrelated"),
            "coroutine": lambda t: setattr(t, "coroutine", None),
            "invoke": lambda t: object.__setattr__(t, "invoke", lambda *args, **kwargs: "unrelated"),
        }
        with MiddlewareRuntime(endpoint=ENDPOINT, deadline_ms=1000) as runtime:
            for name, mutate in mutations.items():
                with self.subTest(mutation=name):
                    fixture = OpenAIFixture()
                    with ProviderServer(fixture) as server:
                        middleware = CavemanMiddleware(runtime=runtime, scope=Scope("langchain-attestation", name))
                        mutate(middleware.recovery_tool)
                        model = ChatOpenAI(model="helpers", api_key="fixture", base_url=server.url + "/v1", max_retries=0, use_responses_api=False)
                        agent = create_agent(model=model, tools=[middleware.recovery_tool], middleware=[middleware])
                        history = [HumanMessage("Read"), AIMessage(content="", tool_calls=[{"name": "read_logs", "args": {}, "id": "read-1", "type": "tool_call"}]), ToolMessage(content=SOURCE, tool_call_id="read-1", name="read_logs")]
                        agent.invoke({"messages": history})
                        self.assertEqual(fixture.calls[-1][1]["messages"][-1]["content"], SOURCE)
                        self.assertEqual(server.errors, [])
            self.assertEqual(RECOVERY_SCHEMA["properties"]["handle"]["type"], "string")


class AsyncSourceExpansion(unittest.IsolatedAsyncioTestCase):
    async def test_async_native_rag_both_providers(self):
        for protocol in ("openai", "anthropic"):
            with self.subTest(protocol=protocol), MiddlewareRuntime(endpoint=ENDPOINT, deadline_ms=1000) as runtime:
                fixture = RAGFixture(protocol)
                with ProviderServer(fixture) as server:
                    agent, retriever, views, _ = rag_agent(runtime, Scope("langchain-rag", "async-" + protocol), model_for(protocol, server), asynchronous=True)
                    result = await agent.ainvoke({"messages": [HumanMessage("Find row 70 with both citations")]})
                    SourceExpansion().assert_documents(result, retriever, views)
                    self.assertEqual(len(fixture.calls), 3)
                    self.assertEqual(server.errors, [])
                    record_evidence("async", fixture, retriever, views)

    async def test_native_agent_stream_delivers_text_before_provider_completion(self):
        for protocol in ("openai", "anthropic"):
            with self.subTest(protocol=protocol), MiddlewareRuntime(endpoint=ENDPOINT, deadline_ms=1000) as runtime:
                fixture = RAGFixture(protocol)
                with ProviderServer(fixture) as server:
                    agent, retriever, views, _ = rag_agent(runtime, Scope("langchain-rag", "stream-" + protocol), model_for(protocol, server), asynchronous=True)
                    text = ""
                    async for message, _ in agent.astream({"messages": [HumanMessage("Find row 70 with both citations")]}, stream_mode="messages"):
                        if not isinstance(message, AIMessage):
                            continue
                        value = message.content if isinstance(message.content, str) else "".join(p.get("text", "") for p in message.content if p.get("type") == "text")
                        if value == "retained-":
                            self.assertFalse(fixture.finished)
                            fixture.released = True
                        text += value
                    self.assertEqual(text, FINAL)
                    self.assertEqual(retriever.documents, documents())
                    self.assertEqual([d.id for d in views[0]], ["source-a", "source-b", "source-c"])
                    self.assertTrue(fixture.finished)
                    self.assertEqual(server.errors, [])
                    record_evidence("async-stream", fixture, retriever, views)
