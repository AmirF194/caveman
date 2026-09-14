"""Installed Pydantic AI runs, real provider SDKs, and the local Go runtime."""
import asyncio
import copy
import functools
import json
import os
import threading
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor

import anthropic
import openai
from pydantic import BaseModel
from pydantic_ai import Agent, CancellationToken, ModelRetry, NativeOutput, RunContext, Tool
from pydantic_ai.capabilities import AbstractCapability, PrepareTools, ProcessHistory
from pydantic_ai.exceptions import UserError
from pydantic_ai.messages import (
    ModelMessagesTypeAdapter, ModelRequest, ModelResponse, RetryPromptPart,
    TextPart, ThinkingPart, ToolCallPart, ToolReturnPart, UserPromptPart,
)
from pydantic_ai.models import ModelRequestParameters, StreamedResponse
from pydantic_ai.models.anthropic import AnthropicModel
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.anthropic import AnthropicProvider
from pydantic_ai.providers.openai import OpenAIProvider
from pydantic_ai.run import AgentRunResult
from pydantic_ai.toolsets import FunctionToolset

from caveman_cloud.middleware import Scope
from caveman_cloud.middleware.runtime import RECOVERY_DESCRIPTION, RECOVERY_SCHEMA
from caveman_middleware.pydantic_ai import CavemanCapability, with_caveman_model, scope_from_run
from caveman_middleware._native import owner
from evidence_runtime import EvidenceRuntime
from python_fixture import ProviderServer
from _fixture import Fixture, NativePauseFixture, SOURCE

ENDPOINT = os.environ["CAVEMAN_MIDDLEWARE_ENDPOINT"]


class Answer(BaseModel):
    answer: int


class Dependencies:
    def __init__(self, *, retry=False):
        self.retry = retry
        self.calls = []


def read_logs(ctx: RunContext[Dependencies], path: str = "fixture/diagnostics.log") -> str:
    """Read the diagnostic source, preserving the native run dependencies."""
    assert path == "fixture/diagnostics.log"
    ctx.deps.calls.append((ctx, path))
    if ctx.deps.retry and ctx.retry == 0:
        raise ModelRetry("retry-guard: repeat this tool call with the same path")
    return SOURCE


def model(server, protocol, *, name=None):
    if protocol == "openai":
        client = openai.AsyncOpenAI(api_key="fixture", base_url=server.url + "/v1", max_retries=0, timeout=3)
        native = OpenAIChatModel(name or "gpt-fixture", provider=OpenAIProvider(openai_client=client),
            settings={"temperature": 0.2, "openai_reasoning_effort": "low", "extra_headers": {"x-native-option": "preserved"}})
    else:
        client = anthropic.AsyncAnthropic(api_key="fixture", base_url=server.url, max_retries=0, timeout=3)
        native = AnthropicModel(name or "claude-sonnet-4-6", provider=AnthropicProvider(anthropic_client=client),
            settings={"temperature": 0.2, "max_tokens": 2048, "extra_headers": {"x-native-option": "preserved"}})
    return native, client


def make(native, runtime, *, capabilities=(), output_type=str, tools=None, scope=None, **kwargs):
    scope = scope or functools.partial(scope_from_run, namespace="pydantic-" + str(uuid.uuid4()))
    cap = CavemanCapability(runtime=runtime, scope=scope)
    return Agent(native, tools=[read_logs] if tools is None else tools, deps_type=Dependencies,
                 capabilities=[*capabilities, cap], output_type=output_type, **kwargs)


def close_sync(client):
    try:
        loop = asyncio.get_event_loop()
    except RuntimeError:
        asyncio.run(client.close())
        return
    try:
        loop.run_until_complete(client.close())
        loop.run_until_complete(loop.shutdown_asyncgens())
    finally:
        loop.close()
        asyncio.set_event_loop(None)


def source_history():
    return [ModelRequest([UserPromptPart("Read the source")]),
            ModelResponse([ToolCallPart("read_logs", {"path": "fixture/diagnostics.log"}, tool_call_id="read-history")]),
            ModelRequest([ToolReturnPart("read_logs", SOURCE, tool_call_id="read-history")])]


class ObserveOriginal(AbstractCapability):
    def __init__(self, *, deny=False):
        self.contexts, self.deny = [], deny

    async def before_model_request(self, ctx, request_context):
        self.contexts.append((ctx, request_context))
        for message in request_context.messages:
            for part in message.parts:
                if type(part) is ToolReturnPart and part.tool_name == "read_logs":
                    assert part.content == SOURCE
                    if self.deny:
                        raise ValueError("original-content guard denied")
        return request_context


class GatedRuntime(EvidenceRuntime):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.entered, self.release = threading.Event(), threading.Event()

    def optimize(self, **kwargs):
        self.entered.set()
        if not self.release.wait(5):
            raise AssertionError("test did not release optimization")
        return super().optimize(**kwargs)


class NativePydanticAI(unittest.TestCase):
    def assert_history(self, result):
        history = result.all_messages()
        sources = [part for message in history for part in message.parts
                   if type(part) is ToolReturnPart and part.tool_name == "read_logs"]
        self.assertTrue(sources)
        self.assertEqual(sources[-1].content.encode(), SOURCE.encode())
        restored = ModelMessagesTypeAdapter.validate_json(result.all_messages_json())
        self.assertEqual(ModelMessagesTypeAdapter.dump_json(restored), result.all_messages_json())
        self.assertEqual([type(message) for message in restored], [type(message) for message in history])

    def assert_journey(self, fixture, server, runtime, result, deps):
        self.assertIsInstance(result, AgentRunResult)
        self.assertEqual(result.output, "retained-detail-70")
        self.assertEqual(len(fixture.calls), 3, [(p.status, p.reason) for _, p in runtime.plans])
        self.assertEqual(len(runtime.plans), 3, "every native continuation must be intercepted")
        self.assertEqual(result.usage.requests, 3)
        self.assertEqual(result.usage.output_tokens, 60)
        self.assertGreater(result.usage.input_tokens, 0)
        self.assert_history(result)
        self.assertIs(deps.calls[0][0].deps, deps)
        self.assertEqual(deps.calls[0][0].conversation_id, "conversation")
        self.assertEqual(deps.calls[0][1], "fixture/diagnostics.log")
        self.assertTrue(any(outcome.replacements for _, outcome in runtime.plans))
        self.assertEqual(fixture.calls[0][1]["tools"], fixture.calls[-1][1]["tools"])
        self.assertTrue(all(request.headers["x-native-option"] == "preserved" for request, _ in fixture.calls))
        self.assertTrue(all(body["temperature"] == 0.2 for _, body in fixture.calls))
        self.assertFalse(server.errors, server.errors)
        finished = [r for r in runtime.receipts if r["event_kind"] == "completed"]
        self.assertEqual(len(finished), 3)
        self.assertTrue(all(r["usage"] and r["usage"]["complete"] for r in finished))

    def test_run_sync_both_providers_and_existing_capabilities(self):
        for protocol in ("openai", "anthropic"):
            with self.subTest(protocol=protocol), ProviderServer(Fixture(protocol, reasoning=True)) as server:
                runtime = EvidenceRuntime(endpoint=ENDPOINT)
                native, client = model(server, protocol)
                observer, deps = ObserveOriginal(), Dependencies()
                processor_calls = []
                def preserve(messages):
                    processor_calls.append(messages)
                    return messages
                try:
                    agent = make(native, runtime, capabilities=[observer, ProcessHistory(preserve)])
                    result = agent.run_sync("Find retained-detail-70", deps=deps, conversation_id="conversation")
                    self.assert_journey(server.fixture, server, runtime, result, deps)
                    self.assertEqual(len(observer.contexts), 3)
                    self.assertEqual(len(processor_calls), 3)
                    if protocol == "anthropic":
                        thinking = [p for m in result.all_messages() for p in m.parts if type(p) is ThinkingPart]
                        self.assertTrue(thinking)
                        self.assertEqual(thinking[0].signature, "signed-fixture-signature")
                finally:
                    close_sync(client)
                    runtime.close()

    def test_async_concurrent_scopes_and_nested_ownership(self):
        async def run():
            with ProviderServer(Fixture("openai")) as first, ProviderServer(Fixture("anthropic")) as second:
                runtime = EvidenceRuntime(endpoint=ENDPOINT)
                clients, tasks, instances = [], [], []
                try:
                    for server, protocol in ((first, "openai"), (second, "anthropic")):
                        native, client = model(server, protocol)
                        clients.append(client)
                        scope = Scope("pydantic-" + str(uuid.uuid4()), "conversation", protocol, "epoch")
                        wrapped = with_caveman_model(native, runtime=runtime, scope=scope)
                        deps = Dependencies()
                        instances.append((server, deps))
                        tasks.append(make(wrapped, runtime, scope=scope).run("Find detail", deps=deps, conversation_id="conversation"))
                    results = await asyncio.gather(*tasks)
                    self.assertEqual(len(runtime.plans), 6, "nested model wrapper must yield optimization ownership")
                    self.assertEqual({r["scope"]["branch_id"] for r in runtime.receipts}, {"openai", "anthropic"})
                    for result, (server, deps) in zip(results, instances):
                        self.assertEqual(result.output, "retained-detail-70")
                        self.assert_history(result)
                        self.assertEqual(len(server.fixture.calls), 3)
                        self.assertFalse(server.errors)
                    self.assertIsNone(owner.get())
                finally:
                    await asyncio.gather(*(client.close() for client in clients))
                    runtime.close()
        asyncio.run(run())

    def test_native_async_stream_flush_recovery_and_history(self):
        async def run():
            for protocol in ("openai", "anthropic"):
                with ProviderServer(Fixture(protocol)) as server:
                    runtime = EvidenceRuntime(endpoint=ENDPOINT)
                    native, client = model(server, protocol)
                    try:
                        async with make(native, runtime).run_stream("Find detail", deps=Dependencies(), conversation_id="conversation") as result:
                            chunks = []
                            async for chunk in result.stream_text(delta=True, debounce_by=None):
                                if chunk and not chunks:
                                    self.assertFalse(server.fixture.finished, "first native chunk must precede provider EOF")
                                    server.fixture.release.set()
                                chunks.append(chunk)
                            self.assertEqual("".join(chunks), "retained-detail-70")
                            self.assert_history(result)
                            self.assertEqual(result.usage.requests, 3)
                        self.assertEqual(len(runtime.plans), 3)
                        self.assertFalse(server.errors, server.errors)
                    finally:
                        server.fixture.release.set()
                        await client.close()
                        runtime.close()
        asyncio.run(run())

    def test_native_sync_stream_flush_and_recovery(self):
        for protocol in ("openai", "anthropic"):
            with self.subTest(protocol=protocol), ProviderServer(Fixture(protocol)) as server:
                runtime = EvidenceRuntime(endpoint=ENDPOINT)
                native, client = model(server, protocol)
                try:
                    with make(native, runtime).run_stream_sync("Find detail", deps=Dependencies(), conversation_id="conversation") as result:
                        chunks = []
                        for chunk in result.stream_text(delta=True, debounce_by=None):
                            if chunk and not chunks:
                                self.assertFalse(server.fixture.finished)
                                server.fixture.release.set()
                            chunks.append(chunk)
                        self.assertEqual("".join(chunks), "retained-detail-70")
                        self.assert_history(result)
                    self.assertEqual(len(runtime.plans), 3)
                    self.assertFalse(server.errors, server.errors)
                finally:
                    server.fixture.release.set()
                    close_sync(client)
                    runtime.close()

    def test_typed_sync_async_and_stream_results_keep_contract(self):
        async def async_run(protocol, streaming):
            with ProviderServer(Fixture(protocol, structured=True)) as server:
                server.fixture.release.set()
                runtime = EvidenceRuntime(endpoint=ENDPOINT)
                native, client = model(server, protocol)
                try:
                    agent = make(native, runtime, output_type=NativeOutput(Answer))
                    if streaming:
                        async with agent.run_stream("Answer", deps=Dependencies()) as result:
                            output = await result.get_output()
                    else:
                        result = await agent.run("Answer", deps=Dependencies())
                        output = result.output
                    self.assertEqual(output, Answer(answer=42))
                    self.assert_history(result)
                    self.assertFalse(any(p.replacements for _, p in runtime.plans))
                    self.assertEqual(len(server.fixture.calls), 2)
                    self.assertFalse(server.errors, server.errors)
                finally:
                    await client.close()
                    runtime.close()
        for protocol in ("openai", "anthropic"):
            for streaming in (False, True):
                with self.subTest(protocol=protocol, streaming=streaming):
                    asyncio.run(async_run(protocol, streaming))
            with ProviderServer(Fixture(protocol, structured=True)) as server:
                runtime = EvidenceRuntime(endpoint=ENDPOINT)
                native, client = model(server, protocol)
                try:
                    result = make(native, runtime, output_type=NativeOutput(Answer)).run_sync("Answer", deps=Dependencies())
                    self.assertEqual(result.output, Answer(answer=42))
                    self.assert_history(result)
                    self.assertFalse(any(p.replacements for _, p in runtime.plans))
                finally:
                    close_sync(client)
                    runtime.close()

    def test_model_only_off_record_outage_and_forced_choice(self):
        async def run():
            for protocol in ("openai", "anthropic"):
                for mode in ("model-only", "off", "record", "outage", "forced"):
                    with ProviderServer(Fixture(protocol)) as server:
                        runtime = EvidenceRuntime(endpoint="http://127.0.0.1:1" if mode == "outage" else ENDPOINT,
                                                  mode=mode if mode in ("off", "record") else "compress")
                        native, client = model(server, protocol)
                        try:
                            if mode in ("model-only", "forced"):
                                original = source_history()
                                encoded = ModelMessagesTypeAdapter.dump_json(original)
                                response = await with_caveman_model(native, runtime=runtime,
                                    scope=Scope("pydantic-" + str(uuid.uuid4()), "model", "main", "0")).request(
                                    original, {"tool_choice": "none"} if mode == "forced" else None, ModelRequestParameters())
                                self.assertIsInstance(response, ModelResponse)
                                self.assertEqual(response.parts[0].content, "retained-detail-70")
                                self.assertEqual(encoded, ModelMessagesTypeAdapter.dump_json(original))
                                self.assertTrue(any(p.reason == "recovery_unavailable" for _, p in runtime.plans))
                            else:
                                result = await make(native, runtime).run("Answer", deps=Dependencies())
                                self.assertEqual(result.output, "retained-detail-70")
                                self.assert_history(result)
                            self.assertFalse(any(p.replacements for _, p in runtime.plans))
                            self.assertFalse(server.errors, server.errors)
                        finally:
                            await client.close()
                            runtime.close()
        asyncio.run(run())

    def test_fake_recovery_collision_and_filtered_tools_are_safe(self):
        async def fake(handle: str, offset: int = 0, limit: int = 262144, query: str = ""):
            raise AssertionError("fake recovery must not be called")
        fake_tool = Tool.from_schema(fake, name="caveman_retrieve", description=RECOVERY_DESCRIPTION,
                                    json_schema=copy.deepcopy(RECOVERY_SCHEMA))
        class FakeRegistration(CavemanCapability):
            async def for_run(self, ctx):
                return self
        async def filter_recovery(ctx, tool_defs):
            return [tool for tool in tool_defs if tool.name != "caveman_retrieve"]
        async def run():
            for variant in ("fake", "collision", "filtered"):
                with ProviderServer(Fixture("openai")) as server:
                    runtime = EvidenceRuntime(endpoint=ENDPOINT)
                    native, client = model(server, "openai")
                    try:
                        if variant == "fake":
                            cap = FakeRegistration(runtime=runtime, scope=Scope("pydantic-" + str(uuid.uuid4()), "fake", "main", "0"))
                            cap.toolset = FunctionToolset([fake_tool], id="caveman-recovery")
                            agent = Agent(native, tools=[read_logs], capabilities=[cap])
                        else:
                            agent = make(native, runtime, tools=[read_logs, fake_tool] if variant == "collision" else None,
                                         capabilities=[PrepareTools(filter_recovery)] if variant == "filtered" else [])
                        if variant == "collision":
                            with self.assertRaises(UserError):
                                await agent.run("Answer", deps=Dependencies())
                            self.assertEqual(len(server.fixture.calls), 0)
                        else:
                            result = await agent.run("Answer", deps=Dependencies())
                            self.assertEqual(result.output, "retained-detail-70")
                            self.assertTrue(any(p.reason == "recovery_unavailable" for _, p in runtime.plans))
                        self.assertFalse(any(p.replacements for _, p in runtime.plans))
                    finally:
                        await client.close()
                        runtime.close()
        asyncio.run(run())

    def test_native_retry_prompt_dependencies_and_history(self):
        async def run():
            for protocol in ("openai", "anthropic"):
                with ProviderServer(Fixture(protocol)) as server:
                    runtime = EvidenceRuntime(endpoint=ENDPOINT)
                    native, client = model(server, protocol)
                    deps = Dependencies(retry=True)
                    try:
                        result = await make(native, runtime).run("Answer", deps=deps)
                        self.assertEqual(result.output, "retained-detail-70")
                        retries = [p for m in result.all_messages() for p in m.parts if type(p) is RetryPromptPart]
                        self.assertEqual(len(retries), 1)
                        self.assertIn("retry-guard", retries[0].content)
                        self.assertEqual([ctx.retry for ctx, _ in deps.calls], [0, 1])
                        self.assertEqual(len(runtime.plans), 4)
                        self.assert_history(result)
                        self.assertFalse(server.errors, server.errors)
                    finally:
                        await client.close()
                        runtime.close()
        asyncio.run(run())

    def test_original_guardrail_denial_with_runtime_outage(self):
        for endpoint in (ENDPOINT, "http://127.0.0.1:1"):
            with ProviderServer(Fixture("openai")) as server:
                runtime = EvidenceRuntime(endpoint=endpoint)
                native, client = model(server, "openai")
                try:
                    with self.assertRaisesRegex(ValueError, "original-content guard denied"):
                        make(native, runtime, capabilities=[ObserveOriginal(deny=True)]).run_sync("Answer", deps=Dependencies())
                    self.assertEqual(len(server.fixture.calls), 1)
                    self.assertEqual(len(runtime.plans), 1)
                    self.assertFalse(any(p.replacements for _, p in runtime.plans))
                finally:
                    close_sync(client)
                    runtime.close()

    def test_cancellation_during_optimization_prevents_dispatch(self):
        async def run():
            for streaming in (False, True):
                with ProviderServer(Fixture("openai")) as server:
                    runtime = GatedRuntime(endpoint=ENDPOINT)
                    native, client = model(server, "openai")
                    agent = make(native, runtime)
                    async def stream():
                        async with agent.run_stream("Answer", deps=Dependencies()) as result:
                            await result.get_output()
                    try:
                        task = asyncio.create_task(stream() if streaming else agent.run("Answer", deps=Dependencies()))
                        self.assertTrue(await asyncio.to_thread(runtime.entered.wait, 3))
                        task.cancel()
                        with self.assertRaises(asyncio.CancelledError):
                            await task
                        self.assertEqual(len(server.fixture.calls), 0)
                        self.assertTrue(any(r["event_kind"] == "cancelled" for r in runtime.receipts))
                        self.assertIsNone(owner.get())
                    finally:
                        runtime.release.set()
                        await client.close()
                        runtime.close()
        asyncio.run(run())

    def test_native_sync_cancellation_token(self):
        with ProviderServer(Fixture("openai")) as server:
            runtime = GatedRuntime(endpoint=ENDPOINT)
            native, client = model(server, "openai")
            token = CancellationToken()
            try:
                agent = make(native, runtime)
                def run_native():
                    loop = asyncio.new_event_loop()
                    asyncio.set_event_loop(loop)
                    try:
                        return agent.run_sync("Answer", deps=Dependencies(), cancellation_token=token)
                    finally:
                        loop.run_until_complete(loop.shutdown_asyncgens())
                        loop.close()
                        asyncio.set_event_loop(None)
                with ThreadPoolExecutor(max_workers=1) as executor:
                    task = executor.submit(run_native)
                    self.assertTrue(runtime.entered.wait(3))
                    token.cancel()
                    try:
                        task.result(timeout=3)
                    except BaseException as error:
                        self.assertIn("cancel", type(error).__name__.lower())
                    else:
                        self.fail("native cancellation token was not propagated")
                    self.assertEqual(len(server.fixture.calls), 0)
                    runtime.release.set()
            finally:
                runtime.release.set()
                close_sync(client)
                runtime.close()

    def test_native_stream_cancel_and_early_close_receipts(self):
        async def run():
            for protocol in ("openai", "anthropic"):
                for cancel in (False, True):
                    with ProviderServer(Fixture(protocol)) as server:
                        runtime = EvidenceRuntime(endpoint=ENDPOINT)
                        native, client = model(server, protocol)
                        try:
                            wrapped = with_caveman_model(native, runtime=runtime,
                                scope=Scope("pydantic-" + str(uuid.uuid4()), "stream", "main", "0"))
                            async with wrapped.request_stream([ModelRequest([UserPromptPart("Answer")])], None, ModelRequestParameters()) as stream:
                                self.assertIsInstance(stream, StreamedResponse)
                                await anext(stream.__aiter__())
                                self.assertFalse(server.fixture.finished)
                                if cancel:
                                    await stream.cancel()
                                self.assertNotEqual(stream.get().state, "complete")
                            self.assertTrue(any(r["event_kind"] == "cancelled" and r["usage"] is None for r in runtime.receipts))
                            self.assertFalse(any(r["event_kind"] == "completed" for r in runtime.receipts))
                            self.assertIsNone(owner.get())
                        finally:
                            server.fixture.release.set()
                            await client.close()
                            runtime.close()
        asyncio.run(run())

    def test_native_history_resume_after_serialization(self):
        async def run():
            with ProviderServer(Fixture("openai")) as server:
                runtime = EvidenceRuntime(endpoint=ENDPOINT)
                native, client = model(server, "openai")
                scope = functools.partial(scope_from_run, namespace="pydantic-" + str(uuid.uuid4()))
                try:
                    result = await make(native, runtime, scope=scope).run("Answer", deps=Dependencies(),
                        conversation_id="resumed", metadata={"caveman_branch_id": "branch-a", "caveman_cache_epoch": "epoch-1"})
                    original = result.all_messages_json()
                    history = ModelMessagesTypeAdapter.validate_json(original)
                    resumed = await make(native, runtime, scope=scope).run("Continue", deps=Dependencies(), message_history=history,
                        metadata={"caveman_branch_id": "branch-a", "caveman_cache_epoch": "epoch-1"})
                    self.assertEqual(resumed.output, "retained-detail-70")
                    self.assertEqual(ModelMessagesTypeAdapter.dump_json(history), original)
                    self.assertEqual(len(runtime.plans), 4)
                    self.assertEqual({r["scope"]["session_id"] for r in runtime.receipts}, {"resumed"})
                    self.assertEqual({r["scope"]["branch_id"] for r in runtime.receipts}, {"branch-a"})
                    self.assert_history(resumed)
                finally:
                    await client.close()
                    runtime.close()
        asyncio.run(run())

    def test_suspended_provider_continuation_is_also_wrapped(self):
        async def run():
            for streaming in (False, True):
                with self.subTest(streaming=streaming), ProviderServer(Fixture("anthropic", suspended=True)) as server:
                    server.fixture.release.set()
                    runtime = EvidenceRuntime(endpoint=ENDPOINT)
                    native, client = model(server, "anthropic")
                    try:
                        agent = make(native, runtime)
                        if streaming:
                            async with agent.run_stream("Answer", deps=Dependencies()) as result:
                                output = await result.get_output()
                        else:
                            result = await agent.run("Answer", deps=Dependencies())
                            output = result.output
                        self.assertEqual(output, "retained-detail-70")
                        self.assertEqual(len(server.fixture.calls), 4)
                        self.assertEqual(len(runtime.plans), 4)
                        self.assertEqual(result.usage.requests, 3, "native continuation remains one logical request")
                        self.assertEqual(result.usage.output_tokens, 80, "every fresh provider request contributes usage")
                        self.assert_history(result)
                        self.assertTrue(any(type(p) is ThinkingPart and p.signature == "signed-pause-signature"
                                            for m in result.all_messages() for p in m.parts))
                        completed = [r for r in runtime.receipts if r["event_kind"] == "completed"]
                        self.assertEqual(len(completed), 4)
                        self.assertTrue(all(r["usage"]["output_tokens"] == 20 for r in completed))
                        self.assertFalse(server.errors, server.errors)
                    finally:
                        await client.close()
                        runtime.close()
        asyncio.run(run())

    def test_visible_pause_text_stream_matches_native_early_final_limitation(self):
        async def run():
            outputs = []
            for wrapped in (False, True):
                fixture = (Fixture("anthropic", suspended=True, pause_content="text") if wrapped else
                           NativePauseFixture("anthropic", suspended=True, pause_content="text", tool_after_pause=True))
                with self.subTest(wrapped=wrapped), ProviderServer(fixture) as server:
                    fixture.release.set()
                    runtime = EvidenceRuntime(endpoint=ENDPOINT)
                    native, client = model(server, "anthropic")
                    deps = Dependencies()
                    try:
                        agent = make(native, runtime) if wrapped else Agent(native, tools=[read_logs], deps_type=Dependencies)
                        async with agent.run_stream("Answer", deps=deps) as result:
                            outputs.append(await result.get_output())
                        # Pydantic AI exposes the first text as a final result.
                        # Later tools execute, but their results are never sent
                        # in a final provider request by run_stream.
                        self.assertEqual(outputs[-1], "Continue native reasoning")
                        self.assertEqual(len(fixture.calls), 3)
                        self.assertEqual(len(deps.calls), 1 if wrapped else 2)
                        self.assertEqual(len(runtime.plans), 3 if wrapped else 0)
                        if wrapped:
                            recovered = [p for m in result.all_messages() for p in m.parts
                                         if type(p) is ToolReturnPart and p.tool_name == "caveman_retrieve"]
                            self.assertEqual(len(recovered), 1)
                            self.assertIsInstance(recovered[0].content, dict)
                            self.assertEqual(recovered[0].content["text"].encode(), SOURCE.encode())
                        self.assert_history(result)
                        self.assertFalse(server.errors, server.errors)
                    finally:
                        await client.close()
                        runtime.close()
            self.assertEqual(outputs[0], outputs[1])
        asyncio.run(run())

    def test_extra_provider_body_cannot_remove_recovery_after_gate(self):
        async def run():
            with ProviderServer(Fixture("openai")) as server:
                runtime = EvidenceRuntime(endpoint=ENDPOINT)
                native, client = model(server, "openai")
                try:
                    result = await make(native, runtime).run(None, deps=Dependencies(), message_history=source_history(),
                        model_settings={"extra_body": {"tool_choice": "none", "tools": []}})
                    self.assertEqual(result.output, "retained-detail-70")
                    self.assertEqual(server.fixture.calls[0][1]["tool_choice"], "none")
                    self.assertFalse(any(p.replacements for _, p in runtime.plans))
                    self.assertTrue(any(p.reason == "recovery_unavailable" for _, p in runtime.plans))
                finally:
                    await client.close()
                    runtime.close()
        asyncio.run(run())

    def test_documented_existing_model_example(self):
        from example import LogSource, build_agent
        async def run():
            with ProviderServer(Fixture("openai")) as server:
                runtime = EvidenceRuntime(endpoint=ENDPOINT)
                native, client = model(server, "openai")
                try:
                    agent = build_agent(native, runtime, namespace="pydantic-example-" + str(uuid.uuid4()))
                    self.assertIsInstance(agent, Agent)
                    result = await agent.run("Answer", deps=LogSource(SOURCE))
                    self.assertEqual(result.output, "retained-detail-70")
                    self.assertEqual(len(server.fixture.calls), 3)
                    self.assert_history(result)
                finally:
                    await client.close()
                    runtime.close()
        asyncio.run(run())


class PydanticCertification(unittest.IsolatedAsyncioTestCase):
    async def test_native_request_settings_changed_during_optimization_keep_original_source(self):
        for protocol in ("openai", "anthropic"):
            with self.subTest(protocol=protocol), ProviderServer(Fixture(protocol)) as server:
                server.fixture.release.set()
                reports = []
                runtime = EvidenceRuntime(endpoint=ENDPOINT, deadline_ms=3000, on_report=reports.append)
                native, client = model(server, protocol)
                observer, changes = ObserveOriginal(), []
                optimize = runtime.optimize
                def mutate(**options):
                    result = optimize(**options)
                    if result.replacements and not changes:
                        request = observer.contexts[-1][1]
                        request.model_settings["extra_body"] = {"tool_choice": "none" if protocol == "openai" else {"type": "none"}}
                        changes.append(result)
                    return result
                runtime.optimize = mutate
                try:
                    await runtime.as_async().ready()
                    agent = make(native, runtime, capabilities=[observer])
                    result = await agent.run("Read the source", deps=Dependencies(), conversation_id="request-settings",
                                             model_settings={"extra_body": {}})
                    self.assertTrue(changes, "The test must invalidate an actual replacement plan")
                    self.assertEqual(result.output, "retained-detail-70")
                    self.assertEqual(len(server.fixture.calls), 2)
                    from _certification_native import provider_results
                    self.assertEqual(provider_results(server.fixture.calls[-1][1], protocol)["read_logs"], SOURCE)
                    self.assertEqual(reports[-1].status, "skipped")
                    self.assertEqual(reports[-1].reason, "recovery_unavailable")
                    self.assertEqual(reports[-1].replacement_count, 0)
                    self.assertIsNone(runtime.receipts[-1]["plan_id"])
                    self.assertEqual(server.errors, [])
                finally:
                    await client.close()
                    runtime.close()

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


if __name__ == "__main__":
    from _test_result import ReportingResult
    unittest.main(verbosity=2, testRunner=unittest.TextTestRunner(verbosity=2, resultclass=ReportingResult))
