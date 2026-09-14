"""Native negative boundaries for the explicit source-reader and tool bundle."""
import asyncio
import copy
import json
from dataclasses import replace

from llama_index.core.base.llms.types import ChatMessage
from llama_index.core.query_engine import RetrieverQueryEngine
from llama_index.core.response_synthesizers import get_response_synthesizer
from llama_index.core.retrievers import BaseRetriever
from llama_index.core.schema import NodeWithScore, TextNode
from llama_index.core.tools import FunctionTool

from caveman_cloud.middleware import Scope
from caveman_middleware.llama_index import CavemanNodePostprocessor, with_caveman_tools
from _certification_fixture import Provider, SourceFixture
from _certification_native import runtime_for, source_tool, append_output, digest
from _fixture import SOURCE
from test_native import native_model, close_clients


class NativeRetriever(BaseRetriever):
    def __init__(self, nodes):
        super().__init__()
        self.nodes = nodes
    def _retrieve(self, query_bundle):
        return self.nodes


async def reader_boundaries(test):
    for asynchronous in (False, True):
        for variant in ("absent", "schema_only", "foreign_runtime", "foreign_scope", "changed_schema", "changed_execute", "offsets", "citations", "changed_after_optimize", "scope_changed_after_optimize", "scope_error_after_optimize", "reader_replaced_after_optimize"):
            with test.subTest(asynchronous=asynchronous, variant=variant), Provider(SourceFixture("openai", rag=True)) as server:
                runtime, foreign = runtime_for("compress"), runtime_for("compress")
                clients = native_model(server, "openai")
                scope = Scope("llama-reader-attestation", digest(variant + str(asynchronous)))
                binding = (runtime.as_async() if asynchronous else runtime).recovery(scope)
                reader = binding
                if variant == "absent":
                    reader = None
                elif variant == "schema_only":
                    reader = {"name": binding.name, "input_schema": binding.input_schema, "execute": binding.execute}
                elif variant == "foreign_runtime":
                    reader = foreign.recovery(scope)
                elif variant == "foreign_scope":
                    reader = runtime.recovery(Scope(scope.namespace, "another-session"))
                elif variant == "changed_schema":
                    binding.input_schema["properties"]["handle"]["type"] = "number"
                elif variant == "changed_execute":
                    reader = replace(binding, execute=lambda *_: "fake")
                nodes = [NodeWithScore(node=TextNode(id_=f"source-{index}", text=SOURCE, metadata={"file": f"log-{index}.txt"}), score=0.9 - index / 10) for index in range(2)]
                if variant == "offsets":
                    for node in nodes:
                        node.node.start_char_idx, node.node.end_char_idx = 0, len(SOURCE)
                elif variant == "citations":
                    for node in nodes:
                        node.node.metadata["citations"] = [{"start": 0, "end": 8}]
                before = [node.model_dump() for node in nodes]
                processor = CavemanNodePostprocessor(runtime=runtime, scope=scope, source_expansion=reader)
                observed_plan = []
                if variant.endswith("after_optimize"):
                    optimize = runtime.optimize
                    def mutate(**options):
                        result = optimize(**options)
                        observed_plan.append(result)
                        if variant == "changed_after_optimize":
                            binding.input_schema["properties"]["handle"]["type"] = "number"
                        elif variant == "scope_changed_after_optimize":
                            processor.scope = Scope(scope.namespace, "changed-session")
                        elif variant == "scope_error_after_optimize":
                            def invalid_scope(_):
                                raise ValueError("scope became unavailable")
                            processor.scope = invalid_scope
                        else:
                            processor.source_expansion = runtime.recovery(scope)
                        return result
                    runtime.optimize = mutate
                try:
                    await runtime.as_async().ready()
                    engine = RetrieverQueryEngine(retriever=NativeRetriever(nodes), node_postprocessors=[processor],
                        response_synthesizer=get_response_synthesizer(llm=clients[0], response_mode="simple_summarize"))
                    result = await engine.aquery("Find the source fact") if asynchronous else engine.query("Find the source fact")
                    test.assertEqual(str(result), "retained-detail-70 [1] [2]")
                    test.assertEqual([node.model_dump() for node in nodes], before)
                    test.assertTrue(all(actual is original for actual, original in zip(result.source_nodes, nodes)))
                    test.assertEqual(len(server.fixture.calls), 1)
                    test.assertNotIn("cmw_", json.dumps(server.fixture.calls[0][1]))
                    test.assertFalse(server.fixture.recovered)
                    if observed_plan:
                        test.assertTrue(observed_plan[0].replacements, "race must invalidate an actually optimized view")
                        test.assertEqual(runtime.reports[-1].status, "skipped")
                        test.assertEqual(runtime.reports[-1].reason, "recovery_unavailable")
                        test.assertEqual(runtime.reports[-1].replacement_count, 0)
                    else:
                        test.assertFalse(any(plan.replacements for _, plan in runtime.plans))
                    test.assertEqual(server.errors, [])
                finally:
                    await close_clients(clients)
                    runtime.close()
                    foreign.close()


async def bundle_boundaries(test):
    for asynchronous in (False, True):
        for variant in ("intact", "removed", "substituted", "duplicate", "forced", "changed_after_optimize", "body_changed_after_optimize"):
            with test.subTest(asynchronous=asynchronous, variant=variant), Provider(SourceFixture("openai")) as server:
                runtime, reads = runtime_for("compress"), []
                clients = native_model(server, "openai")
                try:
                    await runtime.as_async().ready()
                    bundle = with_caveman_tools(clients[0], runtime=runtime, scope=Scope("llama-bundle-attestation", digest(variant + str(asynchronous))), tools=[source_tool(reads)])
                    with test.assertRaises(AttributeError):
                        bundle.tools[-1]._fn = lambda **kwargs: "fake"
                    with test.assertRaises(AttributeError):
                        bundle.tools[-1].metadata.description = "fake"
                    copied_schema = bundle.tools[-1].metadata.get_parameters_dict()
                    copied_schema["properties"]["handle"]["type"] = "number"
                    test.assertEqual(bundle.tools[-1].metadata.get_parameters_dict()["properties"]["handle"]["type"], "string")
                    offered = list(bundle.tools)
                    history = [ChatMessage(role="user", content="Read the source")]
                    first = await bundle.model.achat_with_tools(offered, chat_history=history) if asynchronous else bundle.model.chat_with_tools(offered, chat_history=history)
                    call = bundle.model.get_tool_calls_from_response(first)[0]
                    output = await bundle.aexecute(call) if asynchronous else bundle.execute(call)
                    history.append(first.message)
                    append_output(history, call, output)
                    before = copy.deepcopy(history)
                    if variant == "removed":
                        offered.pop()
                    elif variant == "substituted":
                        offered[-1] = FunctionTool(fn=lambda **kwargs: "fake", metadata=bundle.tools[-1].metadata)
                    elif variant == "duplicate":
                        offered.append(bundle.tools[-1])
                    if variant.endswith("after_optimize"):
                        optimize = runtime.optimize
                        def mutate(**options):
                            result = optimize(**options)
                            test.assertTrue(result.replacements)
                            if variant == "body_changed_after_optimize":
                                clients[0].additional_kwargs = {"extra_body": {"tool_choice": "none"}}
                            else:
                                offered.pop()
                            return result
                        runtime.optimize = mutate
                    kwargs = {"tool_choice": "none"} if variant == "forced" else {}
                    response = await bundle.model.achat_with_tools(offered, chat_history=history, **kwargs) if asynchronous else bundle.model.chat_with_tools(offered, chat_history=history, **kwargs)
                    test.assertEqual(history, before)
                    test.assertEqual(len(reads), 1)
                    if variant == "intact":
                        recovery = bundle.model.get_tool_calls_from_response(response)[0]
                        test.assertEqual(recovery.tool_name, "caveman_retrieve")
                        recovered = await bundle.aexecute(recovery) if asynchronous else bundle.execute(recovery)
                        test.assertEqual(json.loads(recovered.content)["text"], SOURCE)
                    else:
                        test.assertEqual(response.message.content, "retained-detail-70")
                        test.assertNotIn("cmw_", json.dumps(server.fixture.calls[-1][1]["messages"]))
                        if variant.endswith("after_optimize"):
                            test.assertIsNone(runtime.receipts[-1]["plan_id"])
                            test.assertEqual(runtime.reports[-1].status, "skipped")
                            test.assertEqual(runtime.reports[-1].reason, "recovery_unavailable")
                            test.assertEqual(runtime.reports[-1].replacement_count, 0)
                        else:
                            test.assertFalse(any(plan.replacements for _, plan in runtime.plans))
                    test.assertEqual(server.errors, [])
                finally:
                    await close_clients(clients)
                    runtime.close()
    with Provider(SourceFixture("openai")) as server:
        runtime, clients = runtime_for("compress"), native_model(server, "openai")
        try:
            original = source_tool([])
            for tools in ([original, original], [FunctionTool.from_defaults(lambda: "fake", name="caveman_retrieve")]):
                with test.assertRaises(ValueError):
                    with_caveman_tools(clients[0], runtime=runtime, scope=Scope("llama-bundle", "invalid"), tools=tools)
            test.assertEqual(server.fixture.calls, [])
        finally:
            await close_clients(clients)
            runtime.close()
