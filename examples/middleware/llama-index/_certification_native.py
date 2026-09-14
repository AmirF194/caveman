"""Every F15 operation executes installed native LlamaIndex interfaces."""
import asyncio
import copy
import hashlib
import json
import os
from pathlib import Path

from llama_index.core import VectorStoreIndex
from llama_index.core.base.llms.types import ChatMessage, ChatResponse
from llama_index.core.base.response.schema import Response, StreamingResponse, AsyncStreamingResponse
from llama_index.core.embeddings import MockEmbedding
from llama_index.core.prompts import PromptTemplate
from llama_index.core.query_engine import RetrieverQueryEngine
from llama_index.core.response_synthesizers import get_response_synthesizer
from llama_index.core.schema import NodeRelationship, NodeWithScore, RelatedNodeInfo, TextNode
from llama_index.core.tools import FunctionTool, ToolOutput
from pydantic import Field

from caveman_cloud.middleware import Scope
from caveman_middleware.llama_index import CavemanNodePostprocessor, with_caveman_model, with_caveman_tools
from evidence_runtime import EvidenceRuntime
from _certification_fixture import Provider, SourceFixture
from _fixture import SOURCE
from source_reader import SourceExpansionSynthesizer
from test_native import Answer, close_clients, native_model

FILE = "examples/middleware/llama-index/test_native.py"
FACT = "retained-detail-70"
HASH = hashlib.sha256(SOURCE.encode()).hexdigest()


def digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode()).hexdigest()


def runtime_for(mode):
    reports = []
    runtime = EvidenceRuntime(endpoint="http://127.0.0.1:1" if mode == "outage" else os.environ["CAVEMAN_MIDDLEWARE_ENDPOINT"],
        mode="off" if mode == "off" else "compress", deadline_ms=200 if mode == "outage" else 3000, on_report=reports.append)
    runtime.reports = reports
    return runtime


def verify_reports(test, runtime, mode, count, adapter="llama-index"):
    test.assertEqual(len(runtime.reports), count)
    test.assertEqual(len({report.attempt_id for report in runtime.reports}), count)
    test.assertTrue(all(report.adapter == adapter for report in runtime.reports))
    test.assertEqual(sum(report.replacement_count for report in runtime.reports), sum(len(plan.replacements) for _, plan in runtime.plans))
    if mode == "off":
        test.assertTrue(all(report.status == "disabled" and not report.transform_ids for report in runtime.reports))
    return [report.status for report in runtime.reports]


def dump_history(history):
    return [message.model_dump(mode="json") for message in history]


def history_types(history):
    return [[type(block).__name__ for block in message.blocks] for message in history]


class TracedPostprocessor(CavemanNodePostprocessor):
    traces: list = Field(default_factory=list, exclude=True)

    def _postprocess_nodes(self, nodes, query_bundle=None):
        before = [node.model_dump() for node in nodes]
        result = super()._postprocess_nodes(nodes, query_bundle)
        self.traces.append((nodes, before, result))
        return result

    async def _apostprocess_nodes(self, nodes, query_bundle=None):
        before = [node.model_dump() for node in nodes]
        result = await super()._apostprocess_nodes(nodes, query_bundle)
        self.traces.append((nodes, before, result))
        return result


def source_tool(reads):
    def read_logs(path: str) -> str:
        """Read an application-approved diagnostic source."""
        assert path == "fixture/diagnostics.log"
        reads.append(path)
        return SOURCE
    return FunctionTool.from_defaults(read_logs)


def append_output(history, call, output):
    history.append(ChatMessage(role="tool", blocks=output.blocks, additional_kwargs={"tool_call_id": call.tool_id, "is_error": output.is_error}))


def verify_loop(test, cell, mode, fixture, runtime, history, outputs, reads, response, events, first_before):
    active = mode == "compress"
    source = [output for call, output in outputs if call.tool_name == "read_logs"]
    recovered = [json.loads(output.content) for call, output in outputs if call.tool_name == "caveman_retrieve"]
    test.assertEqual(len(reads), 1)
    test.assertEqual(len(source), 1)
    test.assertEqual(source[0].raw_output.encode(), SOURCE.encode())
    test.assertEqual(source[0].content.encode(), SOURCE.encode())
    test.assertTrue(any(message.content == SOURCE for message in history))
    test.assertEqual(response.message.content, FACT)
    test.assertEqual(len(fixture.calls), 3 if active else 2)
    test.assertEqual(len(recovered), int(active))
    if active:
        test.assertEqual(recovered[0]["text"].encode(), SOURCE.encode())
        test.assertEqual(recovered[0]["source_id"], "read-1")
        test.assertTrue(fixture.recovered)
        test.assertTrue(any(plan.replacements for _, plan in runtime.plans))
    else:
        test.assertFalse(any(plan.replacements for _, plan in runtime.plans))
    test.assertEqual(len(runtime.plans), 0 if mode == "off" else len(fixture.calls))
    reports = verify_reports(test, runtime, mode, len(fixture.calls))
    if cell["streaming"]:
        test.assertTrue(first_before)
        test.assertTrue(events)
    return {"final_value": response.message.content, "native_type": type(response).__name__, "provider_calls": len(fixture.calls),
        "source_executions": len(reads), "source_sha256": HASH, "stored_source_sha256": digest(source[0].content),
        "recovered_sha256": [digest(page["text"]) for page in recovered], "recovery_requests": len(recovered),
        "replacements": sum(len(plan.replacements) for _, plan in runtime.plans), "optimize_invocations": len(runtime.plans),
        "native_history_types": history_types(history), "native_call_reports": reports, "native_event_types": events, "first_before_fixture_eof": first_before,
        "source_output_native_type": type(source[0]).__name__, "original_history_unchanged_at_each_call": True,
        "execution_owner": "application_public_native_llm_loop", "native_scheduler_added": False}


async def llm_loop(test, cell, mode):
    fixture, runtime, reads = SourceFixture(cell["provider"]), runtime_for(mode), []
    if cell["streaming"]:
        fixture.release.clear()
    with Provider(fixture) as server:
        clients = native_model(server, cell["provider"])
        try:
            if mode == "compress":
                await runtime.as_async().ready()
            bundle = with_caveman_tools(clients[0], runtime=runtime, scope=Scope("llama-certification", digest(cell["id"] + mode)), tools=[source_tool(reads)])
            history, outputs, events = [ChatMessage(role="user", content="Find the exact diagnostic fact")], [], []
            first_before = False
            for _ in range(6):
                before = dump_history(history)
                if cell["streaming"]:
                    if cell["execution"] == "async":
                        async for response in await bundle.model.astream_chat_with_tools(bundle.tools, chat_history=history):
                            events.append(type(response).__name__)
                            if response.delta and not first_before:
                                first_before = not fixture.finished
                                test.assertTrue(first_before)
                                fixture.release.set()
                    else:
                        for response in bundle.model.stream_chat_with_tools(bundle.tools, chat_history=history):
                            events.append(type(response).__name__)
                            if response.delta and not first_before:
                                first_before = not fixture.finished
                                test.assertTrue(first_before)
                                fixture.release.set()
                else:
                    response = await bundle.model.achat_with_tools(bundle.tools, chat_history=history) if cell["execution"] == "async" else bundle.model.chat_with_tools(bundle.tools, chat_history=history)
                test.assertIsInstance(response, ChatResponse)
                test.assertEqual(dump_history(history), before)
                calls = bundle.model.get_tool_calls_from_response(response, error_on_no_tool_call=False)
                history.append(response.message)
                if not calls:
                    break
                for call in calls:
                    output = await bundle.aexecute(call) if cell["execution"] == "async" else bundle.execute(call)
                    test.assertIsInstance(output, ToolOutput)
                    outputs.append((call, output))
                    append_output(history, call, output)
            else:
                test.fail("Native application loop exceeded its call budget")
            result = verify_loop(test, cell, mode, fixture, runtime, history, outputs, reads, response, events, first_before)
            test.assertEqual(server.errors, [])
            return result
        finally:
            fixture.release.set()
            await close_clients(clients)
            runtime.close()


async def model_case(test, cell, mode):
    fixture, runtime, reads = SourceFixture(cell["provider"]), runtime_for(mode), []
    with Provider(fixture) as server:
        clients = native_model(server, cell["provider"])
        try:
            original = clients[0]
            source = source_tool(reads)
            first = await original.achat_with_tools([source], user_msg="Read the source") if cell["execution"] == "async" else original.chat_with_tools([source], user_msg="Read the source")
            call = original.get_tool_calls_from_response(first)[0]
            output = await source.acall(**call.tool_kwargs) if cell["execution"] == "async" else source.call(**call.tool_kwargs)
            test.assertEqual((call.tool_name, output.content), ("read_logs", SOURCE))
            history = [first.message]
            append_output(history, call, output)
            before = dump_history(history)
            llm = with_caveman_model(original, runtime=runtime, scope=Scope("llama-certification", digest(cell["id"] + mode)))
            prompt = "Find the source fact.\n" + output.content
            events = []
            if cell["structured_output"]:
                result = await llm.astructured_predict(Answer, PromptTemplate(prompt)) if cell["execution"] == "async" else llm.structured_predict(Answer, PromptTemplate(prompt))
                value = result.model_dump()
                test.assertEqual(value, {"answer": 42})
            elif cell["streaming"]:
                fixture.release.clear()
                first_before = False
                if cell["execution"] == "async":
                    async for result in await llm.astream_complete(prompt, formatted=True):
                        events.append(type(result).__name__)
                        if result.delta and not first_before:
                            first_before = not fixture.finished
                            test.assertTrue(first_before)
                            fixture.release.set()
                else:
                    for result in llm.stream_complete(prompt, formatted=True):
                        events.append(type(result).__name__)
                        if result.delta and not first_before:
                            first_before = not fixture.finished
                            test.assertTrue(first_before)
                            fixture.release.set()
                value = result.text
                test.assertEqual(value, FACT + " [1] [2]")
            else:
                result = await llm.acomplete(prompt, formatted=True) if cell["execution"] == "async" else llm.complete(prompt, formatted=True)
                value = result.text
                test.assertEqual(value, FACT + " [1] [2]")
            test.assertEqual(dump_history(history), before)
            test.assertEqual(len(reads), 1)
            test.assertEqual(len(fixture.calls), 2)
            test.assertTrue(any(SOURCE in json.dumps(body, ensure_ascii=False).replace("\\r", "\r").replace("\\n", "\n") for _, body in fixture.calls))
            test.assertFalse(any(plan.replacements for _, plan in runtime.plans))
            reports = verify_reports(test, runtime, mode, 1)
            test.assertEqual(server.errors, [])
            return {"final_value": value, "native_type": type(result).__name__, "provider_calls": len(fixture.calls), "source_executions": len(reads),
                "source_sha256": HASH, "stored_source_sha256": digest(output.content), "recovered_sha256": [], "recovery_requests": 0, "replacements": 0,
                "optimize_invocations": len(runtime.plans), "native_call_reports": reports, "native_history_types": history_types(history), "native_event_types": events,
                "first_before_fixture_eof": cell["streaming"], "original_history_unchanged_at_each_call": True,
                "execution_owner": "application_public_native_model_helper", "request_sha256": digest(fixture.calls[-1][0].content)}
        finally:
            fixture.release.set()
            await close_clients(clients)
            runtime.close()


async def rag_case(test, cell, mode):
    fixture, runtime = SourceFixture(cell["provider"], rag=True), runtime_for(mode)
    expansion = cell["recovery"] == "operator_bound"
    active = expansion and mode == "compress"
    if cell["streaming"]:
        fixture.release.clear()
    with Provider(fixture) as server:
        clients = native_model(server, cell["provider"])
        originals = [TextNode(id_=f"source-{index}", text=SOURCE, metadata={"source_id": f"source-{index}", "file": f"log-{index}.txt", "citation": index + 1},
            relationships={NodeRelationship.SOURCE: RelatedNodeInfo(node_id=f"document-{index}")}) for index in range(2)]
        before = [node.model_dump() for node in originals]
        try:
            if mode == "compress":
                await runtime.as_async().ready()
            scope = Scope("llama-certification", digest(cell["id"] + mode))
            reader = (runtime.as_async() if cell["execution"] == "async" else runtime).recovery(scope)
            processor = TracedPostprocessor(runtime=runtime, scope=scope, source_expansion=reader if expansion else None)
            index = VectorStoreIndex(originals, embed_model=MockEmbedding(embed_dim=4))
            cached = {key: value.model_dump() for key, value in index.docstore.docs.items()}
            retriever = index.as_retriever(similarity_top_k=2)
            synthesizer = SourceExpansionSynthesizer(llm=clients[0], source_expansion=reader, streaming=cell["streaming"]) if expansion else get_response_synthesizer(llm=clients[0], response_mode="simple_summarize")
            engine = RetrieverQueryEngine(retriever=retriever, node_postprocessors=[processor], response_synthesizer=synthesizer)
            repeats = 2 if cell["method"] == "source_identity_scores_metadata_and_citations" else 1
            events, first_before = [], False
            for _ in range(repeats):
                if cell["method"].startswith("node_postprocessor"):
                    nodes = await retriever.aretrieve("Find the source fact") if cell["execution"] == "async" else retriever.retrieve("Find the source fact")
                    view = await processor.apostprocess_nodes(nodes, query_str="Find the source fact") if cell["execution"] == "async" else processor.postprocess_nodes(nodes, query_str="Find the source fact")
                    response = await synthesizer.asynthesize("Find the source fact", nodes=view) if cell["execution"] == "async" else synthesizer.synthesize("Find the source fact", nodes=view)
                else:
                    response = await engine.aquery("Find the source fact") if cell["execution"] == "async" else engine.query("Find the source fact")
                if isinstance(response, AsyncStreamingResponse):
                    chunks = []
                    async for chunk in response.async_response_gen():
                        events.append(type(chunk).__name__)
                        if chunk and not first_before:
                            first_before = not fixture.finished
                            test.assertTrue(first_before)
                            fixture.release.set()
                        chunks.append(chunk)
                    value = "".join(chunks)
                elif isinstance(response, StreamingResponse):
                    chunks = []
                    for chunk in response.response_gen:
                        events.append(type(chunk).__name__)
                        if chunk and not first_before:
                            first_before = not fixture.finished
                            test.assertTrue(first_before)
                            fixture.release.set()
                        chunks.append(chunk)
                    value = "".join(chunks)
                else:
                    test.assertIsInstance(response, Response)
                    value = str(response)
                test.assertEqual(value, FACT + " [1] [2]")
                nodes, snapshot, view = processor.traces[-1]
                test.assertEqual([node.model_dump() for node in nodes], snapshot)
                test.assertEqual(len(view), 2)
                test.assertEqual(len(response.source_nodes), 2)
                for number, (original, projected, retained) in enumerate(zip(nodes, view, response.source_nodes), 1):
                    test.assertIs(retained, projected)
                    test.assertEqual(projected.node.node_id, original.node.node_id)
                    test.assertEqual(projected.score, original.score)
                    test.assertEqual(projected.node.metadata, original.node.metadata)
                    test.assertEqual(projected.node.relationships, original.node.relationships)
                    test.assertEqual(original.node.metadata["citation"], number)
                    test.assertEqual(original.node.text.encode(), SOURCE.encode())
                    if active:
                        test.assertIsNot(projected, original)
                        test.assertNotIn(FACT, projected.node.text)
                        test.assertIn("cmw_", projected.node.text)
                    else:
                        test.assertIs(projected, original)
                test.assertEqual([node.model_dump() for node in originals], before)
                test.assertEqual({key: value.model_dump() for key, value in index.docstore.docs.items()}, cached)
            test.assertEqual(len(processor.traces), repeats)
            reports = verify_reports(test, runtime, mode, repeats, "llama-index-rag")
            test.assertEqual(len(fixture.calls), repeats * (2 if active else 1))
            test.assertEqual(len(fixture.recovered), 2 * repeats if active else 0)
            if active:
                for call, output in synthesizer.tool_outputs:
                    test.assertIsInstance(output, ToolOutput)
                    page = json.loads(output.content)
                    test.assertEqual(page["handle"], call.tool_kwargs["handle"])
                    test.assertEqual(page["text"].encode(), SOURCE.encode())
                test.assertEqual(sorted({page["source_id"] for page in fixture.recovered}), ["source-0", "source-1"])
            else:
                test.assertFalse(any(plan.replacements for _, plan in runtime.plans))
            test.assertEqual(server.errors, [])
            return {"final_value": value, "native_type": type(response).__name__, "provider_calls": len(fixture.calls),
                "source_executions": len(processor.traces), "source_sha256": HASH, "stored_source_sha256": digest(originals[0].text),
                "recovered_sha256": [digest(page["text"]) for page in fixture.recovered], "recovery_requests": len(fixture.recovered),
                "replacements": sum(len(plan.replacements) for _, plan in runtime.plans), "optimize_invocations": len(runtime.plans), "native_call_reports": reports,
                "source_ids": [node.node.node_id for node in response.source_nodes], "source_scores": [node.score for node in response.source_nodes],
                "metadata_order_and_citations_preserved": True, "original_and_indexed_nodes_unchanged": True, "native_result_source_identity": True,
                "native_event_types": events, "first_before_fixture_eof": first_before, "query_repetitions": repeats,
                "request_sha256": digest(fixture.calls[-1][0].content) if not expansion else None,
                "execution_owner": "application_native_source_expansion_synthesizer" if expansion else "native_recovery_free_synthesizer"}
        finally:
            fixture.release.set()
            await close_clients(clients)
            runtime.close()


def emit(test, cell, journey):
    name = ".".join(test.id().split(".")[-2:])
    for assertion, observation in journey.items():
        print("CAVEMAN_MIDDLEWARE_OBSERVATION " + json.dumps({"cell_id": cell["id"], "test_id": FILE + "::" + name, "assertion": assertion, "observation": observation}, separators=(",", ":")), flush=True)


async def certify_cells(test, provider, execution):
    cells = [cell for cell in json.loads(Path(__file__).with_name("certification-cells.json").read_text())["cells"] if cell["provider"] == provider and cell["execution"] == execution]
    test.assertEqual(len(cells), 10)
    for cell in cells:
        with test.subTest(cell=cell["id"]):
            run = rag_case if not cell["method"].startswith("LLM.") else model_case if cell["recovery"] == "model_only" else llm_loop
            rows = {mode: await run(test, cell, mode) for mode in ("compress", "off", "outage")}
            active, off, unavailable = rows["compress"], rows["off"], rows["outage"]
            for baseline in (off, unavailable):
                test.assertEqual(active["final_value"], baseline["final_value"])
                test.assertEqual(active["source_executions"], baseline["source_executions"])
                test.assertEqual(baseline["recovery_requests"], 0)
                if cell["recovery"] == "model_only":
                    test.assertEqual(active.get("request_sha256"), baseline.get("request_sha256"))
                    test.assertEqual(active["native_event_types"], baseline["native_event_types"])
            free = {"outcome": "recovery_free", "reason": "no registered source expansion" if cell["method"] == "node_postprocessor.no_expansion" else "native structured-output contract" if cell["structured_output"] else "standalone completion has no native executor", "recovery_requests": 0, "replacements": 0, "original_source_sha256": HASH} if cell["recovery"] == "model_only" else None
            observed = lambda row: {"outcome": "observed", **row}
            emit(test, cell, {
                "native_application": {"outcome": "observed", "method": cell["method"], "execution": execution, "provider": provider, "execution_owner": active["execution_owner"], "native_scheduler_added": False},
                "real_tool_result": {"outcome": "observed", "executor": "native_index_retrieval" if not cell["method"].startswith("LLM.") else "native_read_logs_tool", "source_executions": active["source_executions"], "source_sha256": HASH, "utf8_bytes": len(SOURCE.encode())},
                "transformed_provider_request": free or {"outcome": "observed", "replacement_count": active["replacements"], "omitted_fact_absent": True, "stored_source_sha256": active["stored_source_sha256"]},
                "omitted_fact_requested": free or {"outcome": "observed", "fact": FACT, "native_recovery_function": "caveman_retrieve", "recovery_requests": active["recovery_requests"]},
                "host_executes_exact_recovery": free or {"outcome": "observed", "execution_owner": active["execution_owner"], "source_sha256": HASH, "recovered_sha256": active["recovered_sha256"]},
                "native_result_history_events_and_call_count": observed(active), "off_baseline": observed(off), "optimizer_unavailable": observed(unavailable),
            })
