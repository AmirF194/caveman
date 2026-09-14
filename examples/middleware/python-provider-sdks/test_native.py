"""Pinned provider SDK APIs against deterministic HTTP, with a real Go runtime."""
from __future__ import annotations

import asyncio
import copy
import hashlib
import importlib.metadata
import inspect
import json
import os
from pathlib import Path
import sys
import unittest
from contextlib import AsyncExitStack
from unittest.mock import patch

import anthropic
import openai
import httpx2
from openai.lib.streaming.chat import AsyncChatCompletionStream
from pydantic import BaseModel
from caveman_cloud.middleware import AsyncMiddlewareRuntime, MiddlewareRuntime, MiddlewareError, Scope
from caveman_middleware.anthropic import with_caveman_anthropic
from caveman_middleware.openai import with_caveman_openai, with_caveman_openai_tools, CavemanOpenAITransport, CavemanAsyncOpenAITransport
from _http_fixture import Provider, SOURCE, FACT, definitions, history
from test_providers import SourceTool, AsyncSourceTool

ENDPOINT = os.environ["CAVEMAN_MIDDLEWARE_ENDPOINT"]
RECORDS = []
SHUTDOWN_DIAGNOSTICS = []


class Answer(BaseModel):
    answer: int


def record(protocol, execution, operation, provider, plans, **extra):
    RECORDS.append({"protocol": protocol, "execution": execution, "operation": operation,
                    "provider_requests": len(provider.calls), "optimization_calls": len(plans),
                    "bound_calls": sum(bool(options.get("binding")) for options, _ in plans),
                    "replacement_calls": sum(bool(result.replacements) for _, result in plans), **extra})


def runtime_for(async_client=False, mode="compress", on_diagnostic=None, deadline_ms=1000, on_report=None):
    runtime = (AsyncMiddlewareRuntime if async_client else MiddlewareRuntime)(endpoint="http://127.0.0.1:1" if mode == "outage" else ENDPOINT,
                 mode="off" if mode == "off" else "compress", deadline_ms=200 if mode == "outage" else deadline_ms, on_diagnostic=on_diagnostic, on_report=on_report)
    plans, receipts = [], []
    optimize, observe = runtime.optimize, runtime.observe_background
    if async_client:
        async def run(**options):
            result = await optimize(**options)
            plans.append((options, result))
            return result
    else:
        def run(**options):
            result = optimize(**options)
            plans.append((options, result))
            return result
    runtime.optimize = run
    def observed(receipt):
        receipts.append(receipt)
        return observe(receipt)
    runtime.observe_background = observed
    return runtime, plans, receipts


def client_for(provider, async_client=False, *, transport=None, max_retries=0, event_hooks=None):
    if provider.protocol.startswith("openai"):
        options = {"http_client": (openai.DefaultAsyncHttpxClient if async_client else openai.DefaultHttpxClient)(transport=transport, event_hooks=event_hooks)} if transport is not None else {}
        return (openai.AsyncOpenAI if async_client else openai.OpenAI)(api_key="fixture", base_url=provider.url + "/v1", max_retries=max_retries, timeout=3, **options)
    return (anthropic.AsyncAnthropic if async_client else anthropic.Anthropic)(api_key="fixture", base_url=provider.url, max_retries=0, timeout=3)


def wrap(client, runtime, protocol, name):
    return (with_caveman_openai if protocol.startswith("openai") else with_caveman_anthropic)(client, runtime=runtime, scope=Scope("provider-http", name))


def resource(client, protocol):
    return client.chat.completions if protocol == "openai-chat" else client.responses if protocol == "openai-responses" else client.messages


def kwargs(protocol, model="helpers", messages=None):
    messages = history(protocol) if messages is None else messages
    return {"model": model, "input" if protocol == "openai-responses" else "messages": messages, **({"max_tokens": 100} if protocol == "anthropic-messages" else {})}


def native_text(result, protocol):
    return result.choices[0].message.content if protocol == "openai-chat" else result.output_text if protocol == "openai-responses" else result.content[0].text


def append_response(messages, response, protocol):
    if protocol == "openai-chat":
        message = response.choices[0].message
        messages.append(message.model_dump(exclude_none=True))
        return [(call.id, call.function.name, json.loads(call.function.arguments)) for call in message.tool_calls or []]
    if protocol == "openai-responses":
        messages.extend(item.model_dump(exclude_none=True) for item in response.output)
        return [(item.call_id, item.name, json.loads(item.arguments)) for item in response.output if item.type == "function_call"]
    raise AssertionError(protocol)


def append_result(messages, protocol, call_id, value):
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    messages.append({"role": "tool", "tool_call_id": call_id, "content": text} if protocol == "openai-chat" else {"type": "function_call_output", "call_id": call_id, "output": text})


def assert_physical_attempts(test, provider, plans, receipts, outcome):
    test.assertEqual(len(plans), 1, "SDK retries reuse one prepared view")
    test.assertTrue(plans[0][1].replacements)
    test.assertEqual([receipt["event_kind"] for receipt in receipts], ["dispatch_intent", "failed", "dispatch_intent", "completed" if outcome == "success" else "failed"])
    test.assertEqual(len({receipt["logical_call_id"] for receipt in receipts}), 1)
    test.assertEqual(len({receipt["attempt_id"] for receipt in receipts}), 2)
    test.assertEqual(receipts[0]["attempt_id"], receipts[1]["attempt_id"])
    test.assertEqual(receipts[2]["attempt_id"], receipts[3]["attempt_id"])
    test.assertIsNotNone(receipts[0]["plan_id"])
    test.assertEqual(len({receipt["plan_id"] for receipt in receipts}), 1)
    test.assertTrue(all(receipt["usage"] is None for receipt in receipts[:-1]))
    if outcome == "success":
        test.assertEqual(receipts[-1]["usage"]["output_tokens"], 20)
    else:
        test.assertIsNone(receipts[-1]["usage"])
    expected_hash = hashlib.sha256(provider.calls[0]["raw"].encode()).hexdigest()
    test.assertTrue(all(receipt["provider_request_sha256"] == expected_hash for receipt in receipts))


class SyncNative(unittest.TestCase):
    def test_explicit_native_transport_observes_every_sdk_retry(self):
        for protocol in ("openai-chat", "openai-responses"):
            for streaming in (False, True):
                for outcome in ("success", "exhausted", *(["broken_stream"] if streaming else [])):
                    baseline_error = None
                    for wrapped in (False, True):
                        with self.subTest(protocol=protocol, streaming=streaming, outcome=outcome, wrapped=wrapped), Provider(protocol, transient_failures=2 if outcome == "exhausted" else 1, broken_stream=outcome == "broken_stream") as provider:
                            runtime, plans, receipts = runtime_for()
                            transport = CavemanOpenAITransport(httpx2.HTTPTransport())
                            hooks = []
                            with runtime, client_for(provider, transport=transport, max_retries=1, event_hooks={"request": [lambda request: hooks.append(request.headers["x-stainless-retry-count"])]}) as original:
                                runtime.ready()
                                bundle = with_caveman_openai_tools(original, runtime=runtime, scope=Scope("provider-http", f"retry-sync-{protocol}-{streaming}-{outcome}"), transport=transport,
                                    protocol=protocol, tools=definitions(protocol), functions={"read_logs": lambda _: SOURCE}) if wrapped else None
                                client = bundle.client.with_options(timeout=2) if wrapped else original
                                error = None
                                try:
                                    result = resource(client, protocol).create(**kwargs(protocol), tools=bundle.tools if wrapped else definitions(protocol), stream=streaming)
                                    if streaming:
                                        try:
                                            list(result)
                                        finally:
                                            result.close()
                                    else:
                                        self.assertEqual(native_text(result, protocol), "native")
                                except Exception as caught:
                                    error = type(caught).__name__
                                if not wrapped:
                                    baseline_error = error
                                else:
                                    self.assertEqual(error, baseline_error)
                                self.assertEqual(error is None, outcome == "success")
                                self.assertEqual(len(provider.calls), 2)
                                self.assertEqual(hooks, ["0", "1"])
                                self.assertEqual([call["headers"]["x-stainless-retry-count"] for call in provider.calls], ["0", "1"])
                                self.assertEqual(provider.calls[0]["raw"], provider.calls[1]["raw"])
                                if wrapped:
                                    assert_physical_attempts(self, provider, plans, receipts, outcome)
                                self.assertEqual(provider.errors, [])
                                record(protocol, "sync", "physical_sdk_retry.stream" if streaming else "physical_sdk_retry", provider, plans, wrapped=wrapped, outcome=outcome,
                                    error_class=error, physical_attempt_ids=list(dict.fromkeys(receipt["attempt_id"] for receipt in receipts)), events=[receipt["event_kind"] for receipt in receipts], stable_wire=True)
    def test_native_generation_raw_parse_stream_helpers_and_copy(self):
        for protocol in ("openai-chat", "openai-responses", "anthropic-messages"):
            with self.subTest(protocol=protocol), Provider(protocol) as provider:
                runtime, plans, receipts = runtime_for()
                with runtime, client_for(provider) as original:
                    runtime.ready()
                    client = wrap(original, runtime, protocol, "helpers-sync-" + protocol)
                    api = resource(client, protocol)
                    before = history(protocol)
                    args = kwargs(protocol, messages=before)
                    result = api.create(**args, extra_headers={"x-native-option": "kept"})
                    self.assertEqual(native_text(result, protocol), "native")
                    self.assertIsInstance(result, openai.types.chat.ChatCompletion if protocol == "openai-chat" else openai.types.responses.Response if protocol == "openai-responses" else anthropic.types.Message)
                    raw = api.with_raw_response.create(**args)
                    self.assertEqual(raw.status_code, 200)
                    self.assertEqual(native_text(raw.parse(), protocol), "native")
                    with api.with_streaming_response.create(**args) as raw_stream:
                        self.assertIsInstance(raw_stream.read(), bytes)
                        self.assertEqual(native_text(raw_stream.parse(), protocol), "native")
                    chunks = api.create(**args, stream=True)
                    self.assertGreater(len(list(chunks)), 2)
                    chunks.close()
                    parsed_args = {**args, "model": "parse", "text_format" if protocol == "openai-responses" else "output_format" if protocol == "anthropic-messages" else "response_format": Answer}
                    parsed = api.parse(**parsed_args)
                    output = parsed.choices[0].message.parsed if protocol == "openai-chat" else parsed.output_parsed if protocol == "openai-responses" else parsed.parsed_output
                    self.assertEqual(output, Answer(answer=42))
                    with api.stream(**args) as stream:
                        events = list(stream)
                        final = stream.get_final_completion() if protocol == "openai-chat" else stream.get_final_response() if protocol == "openai-responses" else stream.get_final_message()
                        self.assertEqual(native_text(final, protocol), "native")
                        self.assertGreater(len(events), 2)
                    with resource(original, protocol).stream(**args) as baseline_stream:
                        baseline_events = list(baseline_stream)
                    self.assertEqual([getattr(event, "type", None) for event in events], [getattr(event, "type", None) for event in baseline_events])
                    for clone in (client.copy(timeout=2), client.with_options(timeout=2)):
                        start = len(plans)
                        self.assertEqual(native_text(resource(clone, protocol).create(**args), protocol), "native")
                        self.assertEqual(len(plans), start + 1)
                    self.assertEqual(before, history(protocol))
                    self.assertTrue(all(not result.replacements for _, result in plans), "model-only calls cannot lose unrecoverable content")
                    self.assertTrue(all(call["body"].get("input" if protocol == "openai-responses" else "messages") == before for call in provider.calls))
                    self.assertEqual(provider.calls[0]["headers"]["x-native-option"], "kept")
                    self.assertTrue(any(receipt.get("usage", {}).get("output_tokens") == 20 for receipt in receipts if receipt.get("usage")))
                    self.assertEqual(provider.errors, [])
                    record(protocol, "sync", "native_helpers", provider, plans, native_event_order=[getattr(event, "type", None) for event in events], native_event_order_equal=True, immutable_history=True)

    def test_openai_application_owned_loops_create_and_native_stream(self):
        for protocol in ("openai-chat", "openai-responses"):
            for mode in ("compress", "off", "outage"):
                for streaming in (False, True):
                    with self.subTest(protocol=protocol, mode=mode, streaming=streaming), Provider(protocol) as provider:
                        runtime, plans, _ = runtime_for(mode=mode)
                        with runtime, client_for(provider) as original:
                            if mode == "compress":
                                runtime.ready()
                            calls = []
                            source_definitions = definitions(protocol)
                            bundle = with_caveman_openai_tools(original, runtime=runtime, scope=Scope("provider-http", f"app-sync-{protocol}-{mode}-{streaming}"), protocol=protocol,
                                       tools=source_definitions, functions={"read_logs": lambda args: calls.append(args) or SOURCE})
                            self.assertEqual(source_definitions, definitions(protocol))
                            with self.assertRaises(TypeError):
                                bundle.functions["read_logs"] = lambda _: "fake"
                            messages = [{"role": "user", "content": "Read source and recover row 70"}]
                            recovered = None
                            for _ in range(5):
                                args = kwargs(protocol, model="loop", messages=messages)
                                args["tools"] = bundle.tools
                                if streaming:
                                    with resource(bundle.client, protocol).stream(**args) as stream:
                                        list(stream)
                                        result = stream.get_final_completion() if protocol == "openai-chat" else stream.get_final_response()
                                else:
                                    result = resource(bundle.client, protocol).create(**args)
                                tools = append_response(messages, result, protocol)
                                if not tools:
                                    break
                                for call_id, name, arguments in tools:
                                    value = bundle.functions[name](arguments)
                                    if name == "caveman_retrieve":
                                        recovered = value["text"]
                                    append_result(messages, protocol, call_id, value)
                            self.assertEqual(native_text(result, protocol), FACT)
                            self.assertEqual(calls, [{}])
                            self.assertEqual(len(provider.calls), 3 if mode == "compress" else 2, [(bool(options.get("binding")), len(options.get("candidates", [])), outcome.status, outcome.reason) for options, outcome in plans])
                            if mode == "compress":
                                self.assertEqual(recovered, SOURCE)
                                self.assertTrue(any(outcome.replacements for _, outcome in plans))
                            else:
                                self.assertIsNone(recovered)
                            self.assertEqual(provider.errors, [])
                            record(protocol, "sync", "application_tool_loop.stream" if streaming else "application_tool_loop", provider, plans, mode=mode, final=FACT, recovered_exact=recovered == SOURCE, source_calls=len(calls))

    def test_anthropic_native_tool_runner_modes_and_beta_options(self):
        for mode in ("compress", "off", "outage"):
            for streaming in (False, True):
                with self.subTest(mode=mode, streaming=streaming), Provider("anthropic-messages") as provider:
                    runtime, plans, _ = runtime_for(mode=mode)
                    with runtime, client_for(provider) as original:
                        if mode == "compress":
                            runtime.ready()
                        client = wrap(original, runtime, provider.protocol, f"runner-sync-{mode}-{streaming}").with_options(timeout=2)
                        messages = [{"role": "user", "content": "Read source and recover row 70"}]
                        before = copy.deepcopy(messages)
                        runner = client.beta.messages.tool_runner(model="loop", max_tokens=100, max_iterations=5, messages=messages, tools=[SourceTool()], stream=streaming,
                            betas=["fixture-beta"], system=[{"type": "text", "text": "original system", "cache_control": {"type": "ephemeral"}}], thinking={"type": "enabled", "budget_tokens": 1024})
                        if streaming:
                            for stream in runner:
                                list(stream)
                                final = stream.get_final_message()
                        else:
                            final = runner.until_done()
                        self.assertEqual(final.content[0].text, FACT)
                        self.assertEqual(messages, before)
                        self.assertEqual(len(provider.calls), 3 if mode == "compress" else 2)
                        self.assertTrue(all("fixture-beta" in call["headers"]["anthropic-beta"] for call in provider.calls))
                        self.assertTrue(all(call["body"]["thinking"]["budget_tokens"] == 1024 for call in provider.calls))
                        self.assertEqual(provider.errors, [])
                        record(provider.protocol, "sync", "beta.messages.tool_runner.stream" if streaming else "beta.messages.tool_runner", provider, plans, mode=mode, final=FACT, immutable_history=True)

    def test_native_close_before_fixture_eof_matches_baseline(self):
        for protocol in ("openai-chat", "openai-responses", "anthropic-messages"):
            for wrapped in (False, True):
                with self.subTest(protocol=protocol, wrapped=wrapped), Provider(protocol, pause="first") as provider:
                    runtime, plans, receipts = runtime_for()
                    with runtime, client_for(provider) as original:
                        runtime.ready()
                        client = wrap(original, runtime, protocol, "close-sync-" + protocol) if wrapped else original
                        stream = resource(client, protocol).create(**kwargs(protocol), stream=True)
                        next(stream)
                        self.assertFalse(provider.release.is_set())
                        stream.close()
                        self.assertTrue(provider.peer_closed(), "native close must release provider before fixture EOF")
                        if wrapped:
                            self.assertTrue(any(receipt["event_kind"] == "cancelled" and receipt["usage"] is None for receipt in receipts))
                        record(protocol, "sync", "close_before_eof", provider, plans, wrapped=wrapped, peer_closed_before_release=True)


class AsyncNative(unittest.IsolatedAsyncioTestCase):
    async def test_explicit_native_transport_observes_every_sdk_retry(self):
        for protocol in ("openai-chat", "openai-responses"):
            for streaming in (False, True):
                for outcome in ("success", "exhausted", *(["broken_stream"] if streaming else [])):
                    baseline_error = None
                    for wrapped in (False, True):
                        with self.subTest(protocol=protocol, streaming=streaming, outcome=outcome, wrapped=wrapped), Provider(protocol, transient_failures=2 if outcome == "exhausted" else 1, broken_stream=outcome == "broken_stream") as provider:
                            runtime, plans, receipts = runtime_for(True)
                            transport = CavemanAsyncOpenAITransport(httpx2.AsyncHTTPTransport())
                            hooks = []
                            async def request_hook(request):
                                hooks.append(request.headers["x-stainless-retry-count"])
                            async with runtime, client_for(provider, True, transport=transport, max_retries=1, event_hooks={"request": [request_hook]}) as original:
                                await runtime.ready()
                                bundle = with_caveman_openai_tools(original, runtime=runtime, scope=Scope("provider-http", f"retry-async-{protocol}-{streaming}-{outcome}"), transport=transport,
                                    protocol=protocol, tools=definitions(protocol), functions={"read_logs": lambda _: SOURCE}) if wrapped else None
                                client = bundle.client.with_options(timeout=2) if wrapped else original
                                error = None
                                try:
                                    result = await resource(client, protocol).create(**kwargs(protocol), tools=bundle.tools if wrapped else definitions(protocol), stream=streaming)
                                    if streaming:
                                        try:
                                            [chunk async for chunk in result]
                                        finally:
                                            await result.close()
                                    else:
                                        self.assertEqual(native_text(result, protocol), "native")
                                except Exception as caught:
                                    error = type(caught).__name__
                                if not wrapped:
                                    baseline_error = error
                                else:
                                    self.assertEqual(error, baseline_error)
                                self.assertEqual(error is None, outcome == "success")
                                self.assertEqual(len(provider.calls), 2)
                                self.assertEqual(hooks, ["0", "1"])
                                self.assertEqual([call["headers"]["x-stainless-retry-count"] for call in provider.calls], ["0", "1"])
                                self.assertEqual(provider.calls[0]["raw"], provider.calls[1]["raw"])
                                if wrapped:
                                    assert_physical_attempts(self, provider, plans, receipts, outcome)
                                self.assertEqual(provider.errors, [])
                                record(protocol, "async", "physical_sdk_retry.stream" if streaming else "physical_sdk_retry", provider, plans, wrapped=wrapped, outcome=outcome,
                                    error_class=error, physical_attempt_ids=list(dict.fromkeys(receipt["attempt_id"] for receipt in receipts)), events=[receipt["event_kind"] for receipt in receipts], stable_wire=True)

    async def test_explicit_native_transport_stream_cancellation_before_fixture_eof(self):
        for protocol in ("openai-chat", "openai-responses"):
            for action in ("close", "task_cancel"):
                with self.subTest(protocol=protocol, action=action), Provider(protocol, pause="first") as provider:
                    runtime, plans, receipts = runtime_for(True)
                    transport = CavemanAsyncOpenAITransport(httpx2.AsyncHTTPTransport())
                    async with runtime, client_for(provider, True, transport=transport) as original:
                        await runtime.ready()
                        client = with_caveman_openai(original, runtime=runtime, scope=Scope("provider-http", "physical-cancel-" + protocol + action), transport=transport)
                        stream = await resource(client, protocol).create(**kwargs(protocol), stream=True)
                        iterator = stream.__aiter__()
                        await anext(iterator)
                        if action == "task_cancel":
                            pending = asyncio.create_task(anext(iterator))
                            await asyncio.sleep(0)
                            pending.cancel()
                            with self.assertRaises(asyncio.CancelledError):
                                await pending
                        else:
                            await stream.close()
                        self.assertFalse(provider.release.is_set())
                        self.assertTrue(await asyncio.to_thread(provider.peer_closed))
                        self.assertEqual([receipt["event_kind"] for receipt in receipts], ["dispatch_intent", "cancelled"])
                        self.assertTrue(all(receipt["usage"] is None for receipt in receipts))
                        self.assertEqual(len({receipt["attempt_id"] for receipt in receipts}), 1)
                        await stream.close()
                        record(protocol, "async", "physical_transport_" + action, provider, plans, peer_closed_before_release=True, physical_attempts=1, terminal_usage=None)

    async def asyncSetUp(self):
        asyncio.get_running_loop().set_exception_handler(lambda _, context: SHUTDOWN_DIAGNOSTICS.append({"test": self.id(), "message": context.get("message"), "exception": repr(context.get("exception")), "generator": getattr(context.get("asyncgen"), "__qualname__", None)}))

    async def test_opaque_history_signed_encoded_unknown_and_unrelated_routes(self):
        for async_client in (False, True):
            for protocol in ("openai-chat", "openai-responses", "anthropic-messages"):
                with self.subTest(protocol=protocol, async_client=async_client), Provider(protocol) as provider:
                    runtime, plans, receipts = runtime_for(async_client)
                    async with AsyncExitStack() as stack:
                        if async_client:
                            await stack.enter_async_context(runtime)
                            original = await stack.enter_async_context(client_for(provider, True))
                            await runtime.ready()
                        else:
                            stack.enter_context(runtime)
                            original = stack.enter_context(client_for(provider))
                            runtime.ready()
                        client = wrap(original, runtime, protocol, f"preservation-{protocol}-{async_client}")
                        api = resource(client, protocol)
                        async def call(method, **args):
                            result = method(**args)
                            return await result if inspect.isawaitable(result) else result
                        # Actual provider bytes are compared to the native baseline.
                        for headers in ({"signature": "fixture-signature"}, {"content-encoding": "identity"}, {"dpop": "opaque-proof"}, {"authorization": "Signature keyId=fixture"}, {"content-type": "application/custom-json"}):
                            args = {**kwargs(protocol), "extra_headers": headers}
                            await call(resource(original, protocol).create, **args)
                            baseline = provider.calls[-1]["raw"]
                            count = len(plans)
                            await call(api.create, **args)
                            self.assertEqual(provider.calls[-1]["raw"], baseline)
                            self.assertEqual(len(plans), count)
                        args = {**kwargs(protocol), "extra_body": {"native_future_contract": {"signed": "opaque"}}}
                        await call(resource(original, protocol).create, **args)
                        baseline = provider.calls[-1]["raw"]
                        count = len(plans)
                        await call(api.create, **args)
                        self.assertEqual(provider.calls[-1]["raw"], baseline)
                        self.assertEqual(len(plans), count)
                        if protocol == "openai-responses":
                            for reference in ({"previous_response_id": "resp_opaque"}, {"conversation": "conv_opaque"}, {"conversation": {"id": "conv_opaque"}}):
                                count = len(plans)
                                await call(api.create, **kwargs(protocol), **reference)
                                self.assertEqual(len(plans), count)
                                self.assertEqual(provider.calls[-1]["body"]["input"], history(protocol))
                                self.assertTrue(all(provider.calls[-1]["body"][key] == value for key, value in reference.items()))
                            count = len(plans)
                            await call(api.retrieve, response_id="resp_opaque")
                            await call(api.cancel, response_id="resp_opaque")
                            await call(api.compact, model="helpers", input=history(protocol))
                            self.assertEqual(len(plans), count)
                        elif protocol == "openai-chat":
                            count = len(plans)
                            await call(client.embeddings.create, model="fixture-embedding", input=SOURCE, encoding_format="float")
                            await call(client.batches.create, completion_window="24h", endpoint="/v1/chat/completions", input_file_id="file_opaque")
                            self.assertEqual(len(plans), count)
                        else:
                            count = len(plans)
                            self.assertEqual((await call(api.count_tokens, model="helpers", messages=history(protocol))).input_tokens, 7)
                            await call(api.batches.create, requests=[{"custom_id": "batch-1", "params": kwargs(protocol)}])
                            self.assertEqual(len(plans), count)
                        error_type = openai.BadRequestError if protocol.startswith("openai") else anthropic.BadRequestError
                        caught = []
                        for target in (resource(original, protocol), api):
                            with self.assertRaises(error_type) as raised:
                                await call(target.create, **kwargs(protocol, model="failure"))
                            caught.append((raised.exception.status_code, raised.exception.body))
                        self.assertEqual(caught[0], caught[1])
                        self.assertEqual(sum(entry["body"].get("model") == "failure" for entry in provider.calls), 2)
                        self.assertEqual(provider.errors, [])
                        record(protocol, "async" if async_client else "sync", "opaque_signed_unrelated_and_errors", provider, plans, native_bytes_equal=True, error_type=error_type.__name__)

    async def test_native_candidate_shapes_are_protected_before_optimization(self):
        for protocol in ("openai-chat", "openai-responses", "anthropic-messages"):
            with self.subTest(protocol=protocol), Provider(protocol) as provider:
                runtime, plans, _ = runtime_for(True)
                async with runtime, client_for(provider, True) as original:
                    await runtime.ready()
                    client = wrap(original, runtime, protocol, "shapes-" + protocol)
                    for variant in ("unmatched", "before_call", "duplicate_call", "duplicate_result", "unknown_result_contract", "unknown_call_contract", "error", "citations", "mixed_media"):
                        messages = history(protocol)
                        source_message = messages[2]
                        if protocol == "openai-chat":
                            result = source_message
                            function = messages[1]["tool_calls"][0]
                            result_id, content = "tool_call_id", "content"
                        elif protocol == "openai-responses":
                            result, function = source_message, messages[1]
                            result_id, content = "call_id", "output"
                        else:
                            result, function = source_message["content"][0], messages[1]["content"][0]
                            result_id, content = "tool_use_id", "content"
                        if variant == "unmatched":
                            result[result_id] = "unknown-id"
                        elif variant == "before_call":
                            messages[1], messages[2] = messages[2], messages[1]
                        elif variant == "duplicate_call":
                            messages.insert(2, copy.deepcopy(messages[1]))
                        elif variant == "duplicate_result":
                            messages.append(copy.deepcopy(messages[2]))
                        elif variant == "unknown_result_contract":
                            result["future_contract"] = {"signed": "opaque"}
                        elif variant == "unknown_call_contract":
                            function["future_contract"] = {"signed": "opaque"}
                        elif variant == "error":
                            result["is_error"] = True
                        elif variant == "citations":
                            result[content] = [{"type": "text", "text": SOURCE, "citations": []}]
                        elif variant == "mixed_media":
                            result[content] = [{"type": "text", "text": SOURCE}, {"type": "image", "source": {"type": "url", "url": "https://example.invalid/image.png"}}]
                        start = len(plans)
                        await resource(client, protocol).create(**kwargs(protocol, messages=messages))
                        candidates = [candidate for options, _ in plans[start:] for candidate in options["candidates"]]
                        self.assertEqual(len(candidates), 0, f"{protocol}: {variant}")
                        self.assertEqual(provider.calls[-1]["body"]["input" if protocol == "openai-responses" else "messages"], messages)
                    record(protocol, "async", "protected_native_shapes", provider, plans, protected_cases=9)

    async def test_unsupported_version_delegates_native_calls_with_reports_and_no_added_tools(self):
        for async_client in (False, True):
            for protocol in ("openai-chat", "anthropic-messages"):
                with self.subTest(protocol=protocol, async_client=async_client), Provider(protocol) as provider:
                    diagnostics, reports = [], []
                    runtime, plans, receipts = runtime_for(async_client, on_diagnostic=diagnostics.append, on_report=reports.append)
                    module = "caveman_middleware.openai" if protocol.startswith("openai") else "caveman_middleware.anthropic"
                    async with AsyncExitStack() as stack:
                        if async_client:
                            await stack.enter_async_context(runtime)
                            original = await stack.enter_async_context(client_for(provider, True))
                        else:
                            stack.enter_context(runtime)
                            original = stack.enter_context(client_for(provider))
                        params = kwargs(protocol)
                        before = copy.deepcopy(params)
                        baseline = resource(original, protocol).create(**params)
                        baseline = await baseline if inspect.isawaitable(baseline) else baseline
                        with patch(module + ".__version__", "0.0.0-untested"):
                            client = wrap(original, runtime, protocol, "unsupported")
                            self.assertIs(type(client), type(original))
                            result = resource(client, protocol).create(**params)
                            result = await result if inspect.isawaitable(result) else result
                            self.assertIs(type(result), type(baseline))
                            self.assertEqual(native_text(result, protocol), native_text(baseline, protocol))
                            self.assertEqual(provider.calls[-1]["raw"], provider.calls[0]["raw"])
                            self.assertEqual(params, before)
                            if protocol.startswith("openai"):
                                bundle = with_caveman_openai_tools(original, runtime=runtime, scope=Scope("provider-http", "unsupported-bundle"), protocol=protocol, tools=definitions(protocol), functions={"read_logs": lambda _: SOURCE})
                                self.assertIs(type(bundle.client), type(original))
                                self.assertEqual(bundle.tools, definitions(protocol))
                                self.assertEqual(list(bundle.functions), ["read_logs"])
                        self.assertEqual(plans, [])
                        self.assertEqual(receipts, [])
                        self.assertEqual(len(reports), 1)
                        self.assertEqual((reports[0].status, reports[0].reason, reports[0].replacement_count), ("skipped", "unsupported_version", 0))
                        self.assertIs(runtime.last_report, reports[0])
                        self.assertTrue(any(entry.get("code") == "unsupported_version" for entry in diagnostics), diagnostics)
                        strict_runtime = (AsyncMiddlewareRuntime if async_client else MiddlewareRuntime)(endpoint=ENDPOINT, strict=True)
                        if async_client:
                            await stack.enter_async_context(strict_runtime)
                        else:
                            stack.enter_context(strict_runtime)
                        with patch(module + ".__version__", "0.0.0-untested"), self.assertRaises(MiddlewareError):
                            wrap(original, strict_runtime, protocol, "strict-unsupported")
                        record(protocol, "async" if async_client else "sync", "unsupported_version", provider, plans, native_client_class=True, original_request_unchanged=True, no_tool_injection=True, reports=1)

    async def test_real_dispatch_registration_rejects_altered_schemas_and_forced_output(self):
        for protocol in ("openai-chat", "openai-responses", "anthropic-messages"):
            with self.subTest(protocol=protocol), Provider(protocol) as provider:
                runtime, plans, receipts = runtime_for(True)
                async with runtime, client_for(provider, True) as original:
                    await runtime.ready()
                    client = wrap(original, runtime, protocol, "attestation-" + protocol)
                    variants = ["model_only_schema", "missing_recovery", "changed_name", "changed_schema", "changed_description", "duplicate_recovery", "duplicate_source", "forced_tool", "structured_output"]
                    if protocol == "anthropic-messages":
                        variants.append("tool_removal")
                    for variant in variants:
                        with self.subTest(variant=variant):
                            params = kwargs(protocol)
                            if protocol.startswith("openai"):
                                bundle = with_caveman_openai_tools(original, runtime=runtime, scope=Scope("provider-http", "attestation-" + protocol + variant), protocol=protocol,
                                    tools=definitions(protocol), functions={"read_logs": lambda _: SOURCE})
                                tools = bundle.tools
                                native = resource(client if variant == "model_only_schema" else bundle.client, protocol)
                            else:
                                runner = client.beta.messages.tool_runner(**params, tools=[AsyncSourceTool()], max_iterations=1)
                                captured = []
                                runner.set_messages_params(lambda current: captured.append(current) or current)
                                params = {**captured[0]}
                                tools = copy.deepcopy(params["tools"])
                            recovery = next(tool["function"] if protocol == "openai-chat" else tool for tool in tools if (tool["function"]["name"] if protocol == "openai-chat" else tool["name"]) == "caveman_retrieve")
                            key = "parameters" if protocol.startswith("openai") else "input_schema"
                            if variant == "missing_recovery":
                                tools = tools[:-1]
                            elif variant == "changed_name":
                                recovery["name"] = "different_recovery"
                            elif variant == "changed_schema":
                                recovery[key] = {"type": "object", "properties": {}}
                            elif variant == "changed_description":
                                recovery["description"] = "Different executor contract"
                            elif variant == "duplicate_recovery":
                                tools.append(copy.deepcopy(tools[-1]))
                            elif variant == "duplicate_source":
                                tools.append(copy.deepcopy(tools[0]))
                            elif variant == "forced_tool":
                                params["tool_choice"] = {"type": "tool", "name": "read_logs"} if protocol == "anthropic-messages" else {"type": "function", "function": {"name": "read_logs"}} if protocol == "openai-chat" else {"type": "function", "name": "read_logs"}
                            elif variant == "structured_output":
                                if protocol == "openai-chat":
                                    params["response_format"] = {"type": "json_object"}
                                elif protocol == "openai-responses":
                                    params["text"] = {"format": {"type": "json_schema", "name": "answer", "schema": {"type": "object", "properties": {"answer": {"type": "string"}}, "required": ["answer"], "additionalProperties": False}, "strict": True}}
                                else:
                                    params["output_config"] = {"format": {"type": "json_schema", "schema": {"type": "object", "properties": {}}}}
                            elif variant == "tool_removal":
                                params["messages"] = [*params["messages"], {"role": "user", "content": [{"type": "tool_removal", "name": "caveman_retrieve"}]}]
                            params["tools"] = tools
                            start = len(plans)
                            if protocol.startswith("openai"):
                                await native.create(**params)
                            elif variant == "model_only_schema":
                                await client.messages.create(**kwargs(protocol), tools=tools)
                            else:
                                runner.set_messages_params(params)
                                await runner.until_done()
                            self.assertEqual(len(plans), start + 1)
                            self.assertIsNone(plans[-1][0]["binding"], variant)
                            self.assertFalse(plans[-1][1].replacements, variant)
                            self.assertEqual(provider.calls[-1]["body"]["input" if protocol == "openai-responses" else "messages"][2], history(protocol)[2])
                    record(protocol, "async", "executor_registration", provider, plans, protected_cases=variants, native_registry_unchanged=True)

    async def test_binding_mutation_during_optimization_discards_projection_and_receipt_plan(self):
        for protocol in ("openai-chat", "openai-responses", "anthropic-messages"):
            with self.subTest(protocol=protocol), Provider(protocol) as provider:
                runtime, plans, receipts = runtime_for(True)
                async with runtime, client_for(provider, True) as original:
                    await runtime.ready()
                    optimize = runtime.optimize
                    async def mutate(**options):
                        result = await optimize(**options)
                        self.assertTrue(result.replacements)
                        options["binding"].input_schema["properties"]["handle"]["type"] = "number"
                        return result
                    runtime.optimize = mutate
                    if protocol.startswith("openai"):
                        bundle = with_caveman_openai_tools(original, runtime=runtime, scope=Scope("provider-http", "race-" + protocol), protocol=protocol,
                            tools=definitions(protocol), functions={"read_logs": lambda _: SOURCE})
                        await resource(bundle.client, protocol).create(**kwargs(protocol), tools=bundle.tools)
                    else:
                        runner = wrap(original, runtime, protocol, "race-anthropic").beta.messages.tool_runner(**kwargs(protocol), tools=[AsyncSourceTool()], max_iterations=1)
                        await runner.until_done()
                    self.assertEqual(provider.calls[-1]["body"]["input" if protocol == "openai-responses" else "messages"], history(protocol))
                    self.assertTrue(receipts)
                    self.assertTrue(all(receipt["plan_id"] is None for receipt in receipts))
                    record(protocol, "async", "in_flight_binding_mutation", provider, plans, original_history=True, discarded_projection_receipt_plan=None)

    async def test_native_async_chat_stream_requires_strict_function_tools(self):
        with Provider("openai-chat") as provider:
            runtime, plans, _ = runtime_for(True)
            async with runtime, client_for(provider, True) as original:
                await runtime.ready()
                errors = []
                for client in (original, wrap(original, runtime, provider.protocol, "native-strict-stream")):
                    with self.assertRaises(ValueError) as caught:
                        async with client.chat.completions.stream(**kwargs(provider.protocol), tools=definitions(provider.protocol)):
                            self.fail("Native async stream helper must reject non-strict tools")
                    errors.append(str(caught.exception))
                self.assertEqual(errors[0], errors[1])
                self.assertIn("strict", errors[0])
                self.assertEqual(provider.calls, [])
                self.assertEqual(plans, [])
                record(provider.protocol, "async", "native_stream_non_strict_tool_restriction", provider, plans, native_error=errors[0], wrapped_error_equal=True)

    async def test_native_generation_raw_parse_stream_helpers_and_copy(self):
        for protocol in ("openai-chat", "openai-responses", "anthropic-messages"):
            with self.subTest(protocol=protocol), Provider(protocol) as provider:
                runtime, plans, receipts = runtime_for(True)
                async with runtime, client_for(provider, True) as original:
                    await runtime.ready()
                    client = wrap(original, runtime, protocol, "helpers-async-" + protocol)
                    api, args = resource(client, protocol), kwargs(protocol)
                    self.assertEqual(native_text(await api.create(**args), protocol), "native")
                    raw = await api.with_raw_response.create(**args)
                    parsed_raw = raw.parse()
                    if inspect.isawaitable(parsed_raw):
                        parsed_raw = await parsed_raw
                    self.assertEqual(native_text(parsed_raw, protocol), "native")
                    async with api.with_streaming_response.create(**args) as raw_stream:
                        self.assertIsInstance(await raw_stream.read(), bytes)
                        self.assertEqual(native_text(await raw_stream.parse(), protocol), "native")
                    chunks = await api.create(**args, stream=True)
                    self.assertGreater(len([chunk async for chunk in chunks]), 2)
                    await chunks.close()
                    parsed = await api.parse(**{**args, "model": "parse", "text_format" if protocol == "openai-responses" else "output_format" if protocol == "anthropic-messages" else "response_format": Answer})
                    output = parsed.choices[0].message.parsed if protocol == "openai-chat" else parsed.output_parsed if protocol == "openai-responses" else parsed.parsed_output
                    self.assertEqual(output, Answer(answer=42))
                    async with api.stream(**args) as stream:
                        events = [event async for event in stream]
                        final = await stream.get_final_completion() if protocol == "openai-chat" else await stream.get_final_response() if protocol == "openai-responses" else await stream.get_final_message()
                        self.assertEqual(native_text(final, protocol), "native")
                        self.assertGreater(len(events), 2)
                    async with resource(original, protocol).stream(**args) as baseline_stream:
                        baseline_events = [event async for event in baseline_stream]
                    self.assertEqual([getattr(event, "type", None) for event in events], [getattr(event, "type", None) for event in baseline_events])
                    for clone in (client.copy(timeout=2), client.with_options(timeout=2)):
                        start = len(plans)
                        await resource(clone, protocol).create(**args)
                        self.assertEqual(len(plans), start + 1)
                    self.assertTrue(all(not result.replacements for _, result in plans))
                    self.assertEqual(provider.errors, [])
                    record(protocol, "async", "native_helpers", provider, plans, native_event_order=[getattr(event, "type", None) for event in events], native_event_order_equal=True)

    async def test_openai_application_owned_loops_create_and_native_stream(self):
        for protocol in ("openai-chat", "openai-responses"):
            for mode in ("compress", "off", "outage"):
                for streaming in (False, True):
                    with self.subTest(protocol=protocol, mode=mode, streaming=streaming), Provider(protocol) as provider:
                        runtime, plans, _ = runtime_for(True, mode)
                        async with runtime, client_for(provider, True) as original:
                            if mode == "compress":
                                await runtime.ready()
                            calls = []
                            async def source(arguments):
                                calls.append(arguments)
                                return SOURCE
                            bundle = with_caveman_openai_tools(original, runtime=runtime, scope=Scope("provider-http", f"app-async-{protocol}-{mode}-{streaming}"), protocol=protocol,
                                       tools=definitions(protocol), functions={"read_logs": source})
                            messages = [{"role": "user", "content": "Read source and recover row 70"}]
                            recovered = None
                            for _ in range(5):
                                args = {**kwargs(protocol, model="loop", messages=messages), "tools": bundle.tools}
                                if streaming and protocol == "openai-chat":
                                    # The pinned async resource .stream() accepts
                                    # strict tools only. Native create(stream=True)
                                    # and its public accumulator support ordinary
                                    # function tools without changing their schema.
                                    raw = await resource(bundle.client, protocol).create(**args, stream=True)
                                    async with AsyncChatCompletionStream(raw_stream=raw, response_format=openai.omit, input_tools=bundle.tools) as stream:
                                        [event async for event in stream]
                                        result = await stream.get_final_completion()
                                elif streaming:
                                    async with resource(bundle.client, protocol).stream(**args) as stream:
                                        [event async for event in stream]
                                        result = await stream.get_final_completion() if protocol == "openai-chat" else await stream.get_final_response()
                                else:
                                    result = await resource(bundle.client, protocol).create(**args)
                                tools = append_response(messages, result, protocol)
                                if not tools:
                                    break
                                for call_id, name, arguments in tools:
                                    value = await bundle.functions[name](arguments)
                                    if name == "caveman_retrieve":
                                        recovered = value["text"]
                                    append_result(messages, protocol, call_id, value)
                            self.assertEqual(native_text(result, protocol), FACT)
                            self.assertEqual(calls, [{}])
                            self.assertEqual(len(provider.calls), 3 if mode == "compress" else 2, [(bool(options.get("binding")), len(options.get("candidates", [])), outcome.status, outcome.reason) for options, outcome in plans])
                            if mode == "compress":
                                self.assertEqual(recovered, SOURCE)
                            else:
                                self.assertIsNone(recovered)
                            self.assertEqual(provider.errors, [])
                            record(protocol, "async", "application_tool_loop.stream" if streaming else "application_tool_loop", provider, plans, mode=mode, final=FACT, recovered_exact=recovered == SOURCE)

    async def test_anthropic_native_tool_runner_modes(self):
        for mode in ("compress", "off", "outage"):
            for streaming in (False, True):
                with self.subTest(mode=mode, streaming=streaming), Provider("anthropic-messages") as provider:
                    runtime, plans, _ = runtime_for(True, mode)
                    async with runtime, client_for(provider, True) as original:
                        if mode == "compress":
                            await runtime.ready()
                        client = wrap(original, runtime, provider.protocol, f"runner-async-{mode}-{streaming}").with_options(timeout=2)
                        runner = client.beta.messages.tool_runner(model="loop", max_tokens=100, max_iterations=5, messages=[{"role": "user", "content": "Read source"}], tools=[AsyncSourceTool()], stream=streaming)
                        if streaming:
                            async for stream in runner:
                                [event async for event in stream]
                                final = await stream.get_final_message()
                        else:
                            final = await runner.until_done()
                        self.assertEqual(final.content[0].text, FACT)
                        self.assertEqual(len(provider.calls), 3 if mode == "compress" else 2)
                        self.assertEqual(provider.errors, [])
                        record(provider.protocol, "async", "beta.messages.tool_runner.stream" if streaming else "beta.messages.tool_runner", provider, plans, mode=mode, final=FACT)

    async def test_native_close_and_task_cancel_before_fixture_eof(self):
        for protocol in ("openai-chat", "openai-responses", "anthropic-messages"):
            for wrapped in (False, True):
                for action in ("close", "task_cancel"):
                    with self.subTest(protocol=protocol, wrapped=wrapped, action=action), Provider(protocol, pause="first") as provider:
                        runtime, plans, receipts = runtime_for(True)
                        async with runtime, client_for(provider, True) as original:
                            await runtime.ready()
                            client = wrap(original, runtime, protocol, "close-async-" + protocol + action) if wrapped else original
                            stream = await resource(client, protocol).create(**kwargs(protocol), stream=True)
                            await anext(stream)
                            if action == "task_cancel":
                                pending = asyncio.create_task(anext(stream))
                                await asyncio.sleep(0.01)
                                pending.cancel()
                                with self.assertRaises(asyncio.CancelledError):
                                    await pending
                            else:
                                await stream.close()
                            self.assertFalse(provider.release.is_set())
                            self.assertTrue(await asyncio.to_thread(provider.peer_closed), "native cancellation must release provider before fixture EOF")
                            if wrapped:
                                self.assertTrue(any(receipt["event_kind"] == "cancelled" and receipt["usage"] is None for receipt in receipts))
                            await stream.close()
                            record(protocol, "async", action + "_before_eof", provider, plans, wrapped=wrapped, peer_closed_before_release=True)


if __name__ == "__main__":
    from _test_result import ReportingResult
    program = unittest.main(verbosity=2, exit=False, testRunner=unittest.TextTestRunner(verbosity=2, resultclass=ReportingResult))
    root = Path(__file__).resolve().parents[3]
    paths = [Path(__file__), Path(__file__).with_name("_http_fixture.py"), Path(__file__).with_name("requirements.lock"), root / "packages/middleware/python/caveman_middleware/openai.py", root / "packages/middleware/python/caveman_middleware/anthropic.py", root / "packages/middleware/python/caveman_middleware/_httpx2.py", root / "packages/middleware/python/caveman_middleware/_native.py"]
    evidence = {"evidence_class": "installed_provider_sdk_with_deterministic_http", "passed": program.result.wasSuccessful(), "test_count": program.result.testsRun,
        "versions": {name: importlib.metadata.version(name) for name in ("openai", "anthropic", "httpx2", "httpcore2", "pydantic")},
        "runtime_sha256": hashlib.sha256(Path(os.environ["CAVEMAN_MIDDLEWARE_TEST_BINARY"]).read_bytes()).hexdigest() if os.environ.get("CAVEMAN_MIDDLEWARE_TEST_BINARY") else None,
        "source_sha256": hashlib.sha256(SOURCE.encode()).hexdigest(), "files": {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths}, "observations": RECORDS, "shutdown_diagnostics": SHUTDOWN_DIAGNOSTICS}
    Path(__file__).with_name("native-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
    sys.exit(not program.result.wasSuccessful())
