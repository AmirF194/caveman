"""Exact Python F05/F06 operations, with observations only after native assertions."""
import asyncio
import copy
import inspect
import json
import os
import re
import threading
from pathlib import Path
from dataclasses import asdict

from pydantic import BaseModel
from langchain.agents import create_agent
from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.documents import Document
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, ToolMessage
from langchain_core.retrievers import BaseRetriever
from langchain_core.tools import StructuredTool
from langchain_openai import ChatOpenAI
from langchain_anthropic import ChatAnthropic
from langgraph.checkpoint.memory import InMemorySaver
from caveman_cloud.middleware import MiddlewareRuntime, MiddlewareError
from caveman_middleware.langchain import with_caveman_agent, with_caveman_model, scope_from_config, CavemanDocumentCompressor
from python_fixture import ProviderServer, restart_runtime
from _certification_fixture import SOURCE, FACT, EDITED, digest, source_results, result_id, NativeProvider

TEST_FILE = "examples/middleware/langchain/test_native.py"
CELLS = json.loads(Path(__file__).with_name("certification-cells.json").read_text())["cells"]
ENDPOINT = os.environ["CAVEMAN_MIDDLEWARE_ENDPOINT"]


class Answer(BaseModel):
    answer: str


class CapturedRuntime(MiddlewareRuntime):
    def __init__(self, mode):
        self.reports = []
        super().__init__(endpoint="http://127.0.0.1:1" if mode == "outage" else ENDPOINT, mode="off" if mode == "off" else "compress", deadline_ms=3000, on_report=self.reports.append)
        self.plans, self.pages, self.receipts = [], [], []

    def optimize(self, **options):
        result = super().optimize(**options)
        self.plans.append((options, result))
        return result

    def retrieve(self, scope, **args):
        page = super().retrieve(scope, **args)
        self.pages.append(page)
        return page

    def observe_background(self, receipt):
        self.receipts.append(receipt)
        return super().observe_background(receipt)


def report_summary(test, runtime, calls, *, rag=False):
    test.assertEqual(len(runtime.reports), calls, "Exactly one report for each actual native model or document-compressor call")
    test.assertIs(runtime.last_report, runtime.reports[-1])
    if not rag:
        test.assertEqual(len({report.attempt_id for report in runtime.reports}), calls)
    test.assertTrue(all(report.adapter == ("langchain-rag" if rag else "langchain") for report in runtime.reports))
    test.assertNotIn(SOURCE, json.dumps([asdict(report) for report in runtime.reports]))
    test.assertEqual(sum(report.replacement_count for report in runtime.reports), sum(len(result.replacements) for _, result in runtime.plans))
    if runtime.mode == "off":
        test.assertTrue(all(report.status == "disabled" for report in runtime.reports))
        test.assertEqual(runtime.plans, [])
        test.assertEqual(runtime.receipts, [])
    elif any(result.replacements for _, result in runtime.plans):
        test.assertTrue(any(report.status == "applied" for report in runtime.reports))
        if not rag:
            test.assertTrue(any(report.status == "reused" for report in runtime.reports))
    return {"count": len(runtime.reports), "statuses": sorted(report.status for report in runtime.reports),
            "replacement_count": sum(report.replacement_count for report in runtime.reports), "source_content_absent": True}


def scoped(config):
    return scope_from_config(config, namespace="langchain-exact-python")


def config_for(cell, suffix=""):
    return {"configurable": {"thread_id": digest(cell["id"] + suffix)}, "tags": ["native-caller-tag"], "metadata": {"caller": "unchanged"}}


def input_for(suffix):
    return {"messages": [HumanMessage(content="Read row 70 " + suffix, id="caller-" + suffix)]}


def native_text(message):
    return message.content if isinstance(message.content, str) else "".join(part.get("text", "") for part in message.content if part.get("type") == "text")


def documents():
    return [Document(id="source-a", page_content=SOURCE, metadata={"citation": "a.md", "page": 1}), Document(id="source-b", page_content=SOURCE, metadata={"citation": "b.md", "page": 2}), Document(id="source-c", page_content="Short source.", metadata={"citation": "c.md"})]


def doc_view(values):
    return [{"id": d.id, "text": d.page_content, "metadata": d.metadata} for d in values]


def read_tool(reads, parallel=False):
    barrier, entered = threading.Barrier(2), asyncio.Event()

    def read_logs(slot: int):
        entry = {"slot": slot, "text": SOURCE}
        reads.append(entry)
        if parallel:
            barrier.wait(timeout=5)
            entry["overlap"] = True
        return SOURCE

    async def aread_logs(slot: int):
        entry = {"slot": slot, "text": SOURCE}
        reads.append(entry)
        if parallel:
            if len(reads) == 2:
                entered.set()
            await asyncio.wait_for(entered.wait(), timeout=5)
            entry["overlap"] = True
        return SOURCE

    return StructuredTool.from_function(func=read_logs, coroutine=aread_logs, name="read_logs", description="Read original application logs.")


def model_for(protocol, server, model="loop"):
    if protocol == "openai":
        return ChatOpenAI(model=model, api_key="fixture", base_url=server.url + "/v1", max_retries=0, use_responses_api=False)
    return ChatAnthropic(model_name=model, api_key="fixture", base_url=server.url, max_retries=0, max_tokens_to_sample=200)


async def resolved(value):
    return await value if inspect.isawaitable(value) else value


async def invoke(agent, messages, config, asynchronous):
    return await agent.ainvoke(messages, config) if asynchronous else agent.invoke(messages, config)


async def state(agent, config, asynchronous):
    return await agent.aget_state(config) if asynchronous else agent.get_state(config)


async def collect_native(test, stream, provider, graph, asynchronous):
    answer, events = "", []
    def consume(value):
        nonlocal answer
        message = value[0] if graph else value
        if not isinstance(message, AIMessage):
            return
        events.append(type(message).__name__)
        part = native_text(message)
        if part == "retained-":
            test.assertFalse(provider.finished)
            provider.released = True
        answer += part
    if asynchronous:
        async for value in stream:
            consume(value)
    else:
        for value in stream:
            consume(value)
    test.assertEqual(answer, FACT)
    test.assertGreater(len(events), 1)
    test.assertTrue(provider.finished)
    return events


async def model_case(test, cell, mode, server):
    fixture, protocol = server.fixture, cell["provider"]
    fixture.reset(compressed=False)
    asynchronous = cell["execution"] == "async" or cell["method"] == "chat_model.abatch"
    with CapturedRuntime(mode) as runtime:
        reads = []
        reader = read_tool(reads)
        bootstrap = create_agent(model=model_for(protocol, server, "bootstrap"), tools=[reader])
        original = await invoke(bootstrap, input_for("bootstrap"), None, asynchronous)
        messages = original["messages"][:-1]
        before = copy.deepcopy(messages)
        native = with_caveman_model(model_for(protocol, server, "structured" if cell["structured_output"] else "model"), runtime=runtime, scope=scoped)
        config, start, events = config_for(cell), len(fixture.calls), []
        method = cell["method"]
        if method == "chat_model.invoke":
            value = await invoke(native, messages, config, asynchronous)
        elif method == "chat_model.batch":
            value = native.batch([messages, messages], [config, config_for(cell, "-batch")])
        elif method == "chat_model.abatch":
            value = await native.abatch([messages, messages], [config, config_for(cell, "-batch")])
        elif method == "chat_model.bind_tools":
            value = await invoke(native.bind_tools([reader]), messages, config, asynchronous)
        elif method == "chat_model.with_structured_output":
            value = await invoke(native.with_structured_output(Answer), messages, config, asynchronous)
        elif method == "chat_model.stream":
            stream = native.astream(messages, config) if asynchronous else native.stream(messages, config)
            events = await collect_native(test, stream, fixture, False, asynchronous)
            value = FACT
        else:
            raise AssertionError("No actual native model operation " + method)
        if cell["structured_output"]:
            test.assertEqual(value, Answer(answer=FACT))
        elif isinstance(value, list):
            test.assertTrue(all(isinstance(item, AIMessage) for item in value))
            test.assertEqual([native_text(item) for item in value], [FACT, FACT])
        elif not cell["streaming"]:
            test.assertIsInstance(value, AIMessage)
            test.assertEqual(native_text(value), FACT)
        target = fixture.calls[start:]
        test.assertEqual(len(target), 2 if cell["execution"] == "batch" else 1)
        test.assertEqual(reads, [{"slot": 0, "text": SOURCE}])
        test.assertEqual(messages, before)
        for body in target:
            test.assertEqual(next(part["content"] for part in source_results(body, protocol) if result_id(part) == "read-1"), SOURCE)
        test.assertTrue(all(not result.replacements and options.get("binding") is None for options, result in runtime.plans))
        test.assertEqual(runtime.pages, [])
        test.assertEqual(server.errors, [])
        if cell["execution"] == "batch" and mode != "off":
            test.assertEqual(len(set(options["scope"].session_id for options, _ in runtime.plans)), 2, "Each actual native batch item resolves its own scope")
        return {"source_executions": 1, "provider_calls": len(fixture.calls), "target_provider_calls": len(target), "recovery_requests": 0, "replacements": 0,
                "target_request_sha256": sorted(digest(body) for body in target), "source_sha256": digest(SOURCE), "source_bytes": len(SOURCE.encode()), "original_history": True,
                "native_type": "Answer" if cell["structured_output"] else "AIMessage[]" if isinstance(value, list) else "AIMessageChunk stream" if cell["streaming"] else type(value).__name__,
                "native_value": {"answer": value.answer} if cell["structured_output"] else FACT, "stream_events": events, "stream_delivered_before_eof": cell["streaming"],
                "extra": {"native_reports": report_summary(test, runtime, len(target)), **({"separate_batch_item_scopes": True} if cell["execution"] == "batch" else {})}}


class ApplicationRetriever(BaseRetriever):
    documents: list[Document]
    calls: list[str] = []

    def _get_relevant_documents(self, query, *, run_manager):
        self.calls.append(query)
        return self.documents

    async def _aget_relevant_documents(self, query, *, run_manager):
        self.calls.append(query)
        return self.documents


async def rag_case(test, cell, mode, server):
    fixture, protocol = server.fixture, cell["provider"]
    asynchronous, expansion = cell["execution"] == "async", cell["recovery"] == "operator_bound"
    compressed = expansion and mode == "compress"
    fixture.reset(compressed=compressed, rag=True)
    with CapturedRuntime(mode) as runtime:
        scope = scoped(config_for(cell))
        retriever = ApplicationRetriever(documents=documents())
        views = []
        reader = (runtime.as_async() if asynchronous else runtime).recovery(scope)
        compressor = CavemanDocumentCompressor(runtime=runtime, scope=scope, source_expansion=reader if expansion else None)

        def search(query: str):
            original = retriever.invoke(query)
            view = compressor.compress_documents(original, query)
            views.append(view)
            return json.dumps(doc_view(view), ensure_ascii=False), original

        async def asearch(query: str):
            original = await retriever.ainvoke(query)
            view = await compressor.acompress_documents(original, query)
            views.append(view)
            return json.dumps(doc_view(view), ensure_ascii=False), original

        def expand(handle: str, offset: int = 0, limit: int = 262144, query: str = ""):
            return json.dumps(reader.execute(dict(handle=handle, offset=offset, limit=limit, query=query)), ensure_ascii=False)

        async def aexpand(handle: str, offset: int = 0, limit: int = 262144, query: str = ""):
            return json.dumps(await reader.execute(dict(handle=handle, offset=offset, limit=limit, query=query)), ensure_ascii=False)

        search_tool = StructuredTool.from_function(func=search, coroutine=asearch, name="search_documents", description="Search original application documents.", response_format="content_and_artifact")
        expand_tool = StructuredTool.from_function(func=expand, coroutine=aexpand, name=reader.name, description=reader.description, args_schema=copy.deepcopy(reader.input_schema))
        agent = create_agent(model=model_for(protocol, server), tools=[search_tool, *([expand_tool] if expansion else [])])
        value = await invoke(agent, input_for("rag"), config_for(cell), asynchronous)
        test.assertEqual(native_text(value["messages"][-1]), FACT)
        test.assertEqual(len(retriever.calls), 1)
        test.assertEqual(retriever.documents, documents())
        test.assertTrue(all(type(d) is Document for d in views[0]))
        test.assertEqual([(d.id, d.metadata) for d in views[0]], [(d.id, d.metadata) for d in documents()])
        test.assertEqual(next(message.artifact for message in value["messages"] if isinstance(message, ToolMessage) and message.name == "search_documents"), documents())
        test.assertEqual(len(fixture.calls), 3 if compressed else 2)
        test.assertEqual(len(runtime.pages), 2 if compressed else 0)
        if compressed:
            test.assertEqual(sorted(page["source_id"] for page in runtime.pages), ["source-a", "source-b"])
            test.assertEqual(len(set(page["handle"] for page in runtime.pages)), 2)
            for page in runtime.pages:
                test.assertEqual(page["text"], SOURCE)
        else:
            test.assertEqual(views[0], retriever.documents)
            test.assertTrue(all(not result.replacements for _, result in runtime.plans))
        test.assertEqual(server.errors, [])
        return {"source_executions": 1, "provider_calls": len(fixture.calls), "recovery_requests": len(runtime.pages), "replacements": sum(len(result.replacements) for _, result in runtime.plans), "source_sha256": digest(SOURCE), "source_bytes": len(SOURCE.encode()), "original_history": True,
                "native_type": "Document[] and native agent ToolMessage.artifact", "native_value": FACT, "stream_events": [], "stream_delivered_before_eof": False,
                **({"target_request_sha256": [digest(body) for body in fixture.calls]} if cell["recovery"] == "model_only" else {}),
                "recovery_sources": sorted([{"source_id": page["source_id"], "sha256": digest(page["text"]), "utf8_bytes": len(page["text"].encode()), "complete": page["complete"]} for page in runtime.pages], key=lambda item: item["source_id"]),
                "view_sha256": [digest(re.sub(r"cmw_[a-f0-9]{48}", "cmw_OPAQUE_HANDLE", document.page_content)) for document in views[0][:2]],
                "extra": {"document_ids": [d.id for d in views[0]], "metadata_preserved": True, "original_artifact_preserved": True, "duplicate_text_sources_distinct": compressed, "native_reports": report_summary(test, runtime, len(views), rag=True)},
                "requested_handles_match": compressed and all(any(page["handle"] == call["args"]["handle"] for page in runtime.pages) for response in fixture.responses for call in response["calls"] if call["name"] == "caveman_retrieve")}


class Callbacks(BaseCallbackHandler):
    def __init__(self):
        self.calls = []

    def on_chat_model_start(self, serialized, messages, *, run_id, tags=None, metadata=None, **kwargs):
        self.calls.append({"tags": tags, "metadata": metadata})


async def agent_case(test, cell, mode, server):
    fixture, protocol = server.fixture, cell["provider"]
    asynchronous, compressed = cell["execution"] == "async", mode == "compress"
    method, parallel, interleaved = cell["method"], cell["method"] == "parallel_tool_batch", cell["method"] == "interleaved_thread_identity"
    fixture.reset(compressed=compressed, parallel=parallel)
    with CapturedRuntime(mode) as runtime:
        reads, callbacks = [], Callbacks()
        model = with_caveman_model(model_for(protocol, server), runtime=runtime, scope=scoped)
        options = dict(model=model, tools=[read_tool(reads, parallel)], checkpointer=InMemorySaver())
        if method == "interrupt_and_reducers":
            options["interrupt_before"] = ["tools"]
        agent = create_agent(**with_caveman_agent(options, runtime=runtime, scope=scoped))
        config = {**config_for(cell), "callbacks": [callbacks]}
        original = input_for("main")
        before = copy.deepcopy(original)
        events, extra = [], {}
        if cell["streaming"]:
            stream = agent.astream(original, config, stream_mode="messages") if asynchronous else agent.stream(original, config, stream_mode="messages")
            events = await collect_native(test, stream, fixture, True, asynchronous)
            value = (await state(agent, config, asynchronous)).values
        elif interleaved:
            other = config_for(cell, "-other")
            if asynchronous:
                values = await asyncio.gather(agent.ainvoke(original, config), agent.ainvoke(input_for("other"), other))
            else:
                # Two actual synchronous graph calls run on independent host threads.
                values = await asyncio.gather(asyncio.to_thread(agent.invoke, original, config), asyncio.to_thread(agent.invoke, input_for("other"), other))
            test.assertEqual([native_text(result["messages"][-1]) for result in values], [FACT, FACT])
            for cfg in (config, other):
                test.assertEqual(next(message.content for message in (await state(agent, cfg, asynchronous)).values["messages"] if isinstance(message, ToolMessage) and message.name == "read_logs"), SOURCE)
            if compressed:
                test.assertEqual(len(set(page["handle"] for page in runtime.pages)), 2)
            value = values[0]
            extra = {"interleaved_threads": 2, "independent_checkpoint_sources": True, "independent_scoped_grants": compressed}
        elif method == "interrupt_and_reducers":
            value = await invoke(agent, original, config, asynchronous)
            interrupts = 0
            while (await state(agent, config, asynchronous)).next:
                test.assertEqual((await state(agent, config, asynchronous)).next, ("tools",))
                interrupts += 1
                test.assertEqual(len(reads), 0 if interrupts == 1 else 1)
                value = await invoke(agent, None, config, asynchronous)
                test.assertLessEqual(interrupts, 2)
            test.assertEqual(interrupts, 2 if compressed else 1)
            extra = {"native_interrupts": interrupts, "source_and_recovery_resume_through_native_tool_node": compressed, "native_reducer_message_ids_unique": len(set(message.id for message in value["messages"])) == len(value["messages"])}
            test.assertTrue(extra["native_reducer_message_ids_unique"])
        else:
            value = await invoke(agent, original, config, asynchronous)
        test.assertEqual(native_text(value["messages"][-1]), FACT)
        test.assertEqual(original, before)
        saved = await state(agent, config, asynchronous)
        test.assertEqual(next(message.content for message in saved.values["messages"] if isinstance(message, ToolMessage) and message.name == "read_logs"), SOURCE)
        if method == "checkpoint_resume_after_restart":
            previous = next(part["content"] for part in source_results(fixture.calls[1], protocol) if result_id(part) == "read-1")
            restart_runtime()
            value = await invoke(agent, {"messages": [HumanMessage(content="Repeat from checkpoint", id="repeat-original")]}, config, asynchronous)
            test.assertEqual(native_text(value["messages"][-1]), FACT)
            test.assertEqual(next(part["content"] for part in source_results(fixture.calls[-1], protocol) if result_id(part) == "read-1"), previous)
            extra = {"checkpoint_resumed": True, "actual_runtime_process_restart_acknowledged": True, "original_source_preserved": True, "same_view_after_restart": True}
        if method == "branch_and_history_edit":
            original_tool = next(message for message in saved.values["messages"] if isinstance(message, ToolMessage) and message.name == "read_logs")
            edited = original_tool.model_copy(update={"content": EDITED})
            branch = await agent.aupdate_state(saved.config, {"messages": [edited]}) if asynchronous else agent.update_state(saved.config, {"messages": [edited]})
            fork = {"configurable": {**branch["configurable"], "caveman_branch_id": "application-branch"}}
            fixture.expected_source = EDITED
            value = await invoke(agent, {"messages": [HumanMessage(content="Read edited history", id="edited-question")]}, fork, asynchronous)
            test.assertEqual(native_text(value["messages"][-1]), FACT)
            test.assertEqual(next(message.content for message in (await state(agent, fork, asynchronous)).values["messages"] if isinstance(message, ToolMessage) and message.name == "read_logs"), EDITED)
            test.assertEqual(next(message.content for message in (await state(agent, saved.config, asynchronous)).values["messages"] if isinstance(message, ToolMessage) and message.name == "read_logs"), SOURCE)
            if compressed:
                test.assertEqual(runtime.pages[-1]["text"], EDITED)
                test.assertNotEqual(runtime.pages[0]["handle"], runtime.pages[-1]["handle"])
                with test.assertRaises(MiddlewareError) as error:
                    runtime.recovery(scoped(config)).execute({"handle": runtime.pages[-1]["handle"]})
                test.assertEqual(error.exception.code, "not_found")
            extra = {"native_history_edit": True, "old_checkpoint_source_preserved": True, "edited_source_sha256": digest(EDITED), "native_message_reducer_replaced_same_id": sum(message.id == original_tool.id for message in value["messages"]) == 1, "branch_grant_isolated": compressed}
            test.assertTrue(extra["native_message_reducer_replaced_same_id"])
        source_calls = 2 if parallel or interleaved else 1
        base_calls = 3 if compressed else 2
        expected_calls = base_calls * 2 if interleaved else base_calls + 1 if method == "checkpoint_resume_after_restart" else base_calls + (2 if compressed else 1) if method == "branch_and_history_edit" else base_calls
        test.assertEqual(len(reads), source_calls)
        test.assertTrue(all(read["text"] == SOURCE for read in reads))
        test.assertEqual(len(fixture.calls), expected_calls)
        test.assertEqual(len(runtime.pages), (2 if parallel or interleaved or method == "branch_and_history_edit" else 1) if compressed else 0)
        for page in runtime.pages:
            test.assertIn(page["text"], (SOURCE, EDITED))
            test.assertEqual(page["original_sha256"], digest(page["text"]))
            test.assertTrue(page["complete"])
        test.assertEqual(server.errors, [])
        test.assertGreaterEqual(len(callbacks.calls), base_calls)
        test.assertTrue(all("native-caller-tag" in call["tags"] and call["metadata"]["caller"] == "unchanged" for call in callbacks.calls))
        if parallel:
            test.assertEqual(sorted(read["slot"] for read in reads), [0, 1])
            test.assertTrue(all(read["overlap"] for read in reads))
            test.assertEqual(sum(isinstance(message, ToolMessage) and message.name == "read_logs" for message in value["messages"]), 2)
            extra = {"native_parallel_source_calls": 2, "source_executors_overlapped": True, "native_parallel_recovery_calls": len(runtime.pages), "two_native_tool_messages": True}
        definitions = [[item for item in body.get("tools", []) if item.get("function", item).get("name") == "read_logs"] for body in fixture.calls]
        test.assertTrue(all(definition == definitions[0] for definition in definitions))
        dispatch = sum(receipt["event_kind"] == "dispatch_intent" for receipt in runtime.receipts)
        complete = sum(receipt["event_kind"] == "completed" for receipt in runtime.receipts)
        test.assertEqual(dispatch, 0 if mode == "off" else expected_calls)
        test.assertEqual(complete, 0 if mode == "off" else expected_calls)
        if not compressed:
            test.assertTrue(all(not result.replacements for _, result in runtime.plans))
        views = [part["content"] for body in fixture.calls for part in source_results(body, protocol) if re.fullmatch("read-[12]", result_id(part) or "")]
        return {"source_executions": source_calls, "provider_calls": expected_calls, "recovery_requests": len(runtime.pages), "replacements": sum(len(result.replacements) for _, result in runtime.plans), "source_sha256": digest(SOURCE), "source_bytes": len(SOURCE.encode()), "original_history": True,
                "native_type": type(agent).__name__ + " result with native messages", "native_value": FACT, "stream_events": events, "stream_delivered_before_eof": cell["streaming"],
                "recovery_sources": sorted([{"source_id": page["source_id"], "sha256": digest(page["text"]), "utf8_bytes": len(page["text"].encode()), "complete": page["complete"]} for page in runtime.pages], key=lambda item: (item["sha256"], item["source_id"])),
                "view_sha256": [digest(re.sub(r"cmw_[a-f0-9]{48}", "cmw_OPAQUE_HANDLE", views[0]))],
                "requested_handles_match": compressed and all(any(page["handle"] == call["args"]["handle"] for page in runtime.pages) for response in fixture.responses for call in response["calls"] if call["name"] == "caveman_retrieve"),
                "extra": {**extra, "callbacks_and_tags_preserved": True, "source_tool_schema_preserved": True, "dispatch_receipts": dispatch, "completed_receipts": complete, "nested_model_owner_single": len(runtime.plans) == expected_calls, "native_reports": report_summary(test, runtime, expected_calls)}}


def observations(test, cell, runs):
    active, off, outage = runs
    test.assertEqual(active["native_value"], off["native_value"])
    test.assertEqual(active["native_value"], outage["native_value"])
    for baseline in (off, outage):
        test.assertEqual(baseline["recovery_requests"], 0)
        test.assertEqual(baseline["replacements"], 0)
        test.assertTrue(baseline["original_history"])
    free = cell["recovery"] == "model_only"
    if free:
        test.assertEqual(active["recovery_requests"], 0)
        test.assertEqual(active["replacements"], 0)
        if active.get("target_request_sha256"):
            test.assertEqual(active["target_request_sha256"], off["target_request_sha256"])
            test.assertEqual(active["target_request_sha256"], outage["target_request_sha256"])
    else:
        test.assertGreater(active["recovery_requests"], 0)
        test.assertGreater(active["replacements"], 0)
        test.assertTrue(active["requested_handles_match"])
    recovery_free = {"outcome": "recovery_free", "reason": "no_registered_source_expansion" if cell["method"] == "document_compressor" else "native_structured_model_without_executor" if cell["structured_output"] else "native_model_without_executor", "recovery_requests": 0, "replacements": 0, "original_source_sha256": active["source_sha256"]}
    return {
        "native_application": {"outcome": "observed", "method": cell["method"], "execution": cell["execution"], "native_type": active["native_type"], "local_http_provider": True},
        "real_tool_result": {"outcome": "observed", "source_executions": active["source_executions"], "source_sha256": active["source_sha256"], "source_utf8_bytes": active["source_bytes"], "native_executor": True},
        "transformed_provider_request": recovery_free if free else {"outcome": "observed", "replacements": active["replacements"], "view_sha256_normalizing_only_opaque_handles": active["view_sha256"], "omitted_fact": FACT, "fact_absent": True},
        "omitted_fact_requested": recovery_free if free else {"outcome": "observed", "requested_tool": "caveman_retrieve", "requests": active["recovery_requests"], "requested_handles_match_views": True},
        "host_executes_exact_recovery": recovery_free if free else {"outcome": "observed", "native_tool_executions": active["recovery_requests"], "original_sha256": active["source_sha256"], "original_utf8_bytes": active["source_bytes"], "recovered_sources": active["recovery_sources"], "exact_bytes": True, **({"edited_source_sha256": active["extra"]["edited_source_sha256"]} if "edited_source_sha256" in active["extra"] else {})},
        "native_result_history_events_and_call_count": {"outcome": "observed", "native_value": active["native_value"], "provider_calls": active["provider_calls"], "original_history": active["original_history"], "stream_events": active["stream_events"], "first_text_before_eof": active["stream_delivered_before_eof"], **active["extra"]},
        "off_baseline": {"outcome": "observed", "provider_calls": off["provider_calls"], "recovery_requests": 0, "replacements": 0, "native_value": off["native_value"], "original_history": True, "native_reports": off["extra"]["native_reports"], "same_target_request": bool(active.get("target_request_sha256"))},
        "optimizer_unavailable": {"outcome": "observed", "endpoint": "closed_loopback_port", "provider_calls": outage["provider_calls"], "recovery_requests": 0, "replacements": 0, "native_value": outage["native_value"], "original_history": True, "native_reports": outage["extra"]["native_reports"], "same_target_request": bool(active.get("target_request_sha256"))},
    }


async def run_certification(test, family, protocol):
    if os.environ.get("CAVEMAN_MIDDLEWARE_PACKAGED_TEST") != "1" and os.environ.get("CAVEMAN_MIDDLEWARE_CERT_FAMILY", "F05") != family:
        test.skipTest("Different family snapshot selected")
    selected = [cell for cell in CELLS if cell["family"] == family and cell["language"] == "python" and cell["provider"] == protocol]
    fixture = NativeProvider(protocol)
    with ProviderServer(fixture) as server:
        for cell in selected:
            run = rag_case if cell["method"] in ("document_compressor", "retriever.source_expansion") else model_case if cell["recovery"] == "model_only" else agent_case
            runs = []
            for mode in ("compress", "off", "outage"):
                runs.append(await run(test, cell, mode, server))
            for assertion, observation in observations(test, cell, runs).items():
                print("CAVEMAN_MIDDLEWARE_OBSERVATION " + json.dumps({"cell_id": cell["id"], "test_id": TEST_FILE + "::" + ".".join(test.id().split(".")[-2:]), "assertion": assertion, "observation": observation}, separators=(",", ":")), flush=True)
