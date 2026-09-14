"""Exact frozen provider-operation journeys; observations follow native assertions."""
from __future__ import annotations

import asyncio
import copy
import hashlib
import inspect
import json
import os
from dataclasses import FrozenInstanceError
from pathlib import Path
from contextlib import AsyncExitStack

import httpx2
from caveman_cloud.middleware import Scope
from caveman_middleware.openai import with_caveman_openai, with_caveman_openai_tools, CavemanOpenAITransport, CavemanAsyncOpenAITransport
from caveman_middleware.anthropic import with_caveman_anthropic
from _http_fixture import Provider, SOURCE, FACT, definitions, results
from test_native import Answer, append_response, append_result, client_for, kwargs, native_text, resource, runtime_for
from test_providers import SourceTool, AsyncSourceTool

ROOT = Path(__file__).resolve().parents[3]
TEST_FILE = "examples/middleware/python-provider-sdks/test_providers.py"
SOURCE_HASH = hashlib.sha256(SOURCE.encode()).hexdigest()


def digest(value):
    return hashlib.sha256((value if isinstance(value, str) else json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))).encode()).hexdigest()


def report_evidence(test, runtime, reports, plans, receipts, count, mode):
    test.assertEqual(len(reports), count, "one report per wrapped physical provider attempt")
    test.assertIs(runtime.last_report, reports[-1])
    for report in reports:
        with test.assertRaises(FrozenInstanceError):
            report.status = "forged"
        replacements = next((result.replacements for _, result in plans if result.request and result.request.get("logical_call_id") == report.logical_call_id and result.request.get("attempt_id") == report.attempt_id), ())
        expected = "disabled" if mode == "off" else ("reused" if all(item.get("reused") for item in replacements) else "applied") if replacements else "skipped"
        test.assertEqual(report.status, expected)
        test.assertEqual(report.replacement_count, len(replacements))
        test.assertEqual(report.transform_ids, tuple(sorted({item["transform_id"] for item in replacements})))
        test.assertNotIn(SOURCE, repr(report))
    if mode == "off":
        test.assertEqual(plans, [])
        test.assertEqual(receipts, [])
    return {"count": count, "statuses": [report.status for report in reports], "replacement_counts": [report.replacement_count for report in reports], "metadata_only": True}


async def resolved(value):
    return await value if inspect.isawaitable(value) else value


def event_name(event):
    return getattr(event, "type", getattr(event, "object", type(event).__name__))


async def collect(stream, asynchronous):
    return [event async for event in stream] if asynchronous else list(stream)


async def enter(stack, value, asynchronous):
    return await stack.enter_async_context(value) if asynchronous else stack.enter_context(value)


async def source_history(test, original, protocol, asynchronous, source_calls):
    messages = [{"role": "user", "content": "Read source and recover row 70"}]
    reply = await resolved(resource(original, protocol).create(**kwargs(protocol, "loop", messages), tools=definitions(protocol)))
    if protocol.startswith("openai"):
        calls = append_response(messages, reply, protocol)
        test.assertEqual(calls, [("read-1", "read_logs", {})])
        value = await AsyncSourceTool().call({}) if asynchronous else SourceTool().call({})
        source_calls.append(value)
        append_result(messages, protocol, "read-1", value)
    else:
        tool = reply.content[0]
        test.assertEqual((tool.type, tool.id, tool.name, tool.input), ("tool_use", "read-1", "read_logs", {}))
        value = await AsyncSourceTool().call(tool.input) if asynchronous else SourceTool().call(tool.input)
        source_calls.append(value)
        messages.extend([{"role": "assistant", "content": [tool.model_dump(exclude_none=True)]}, {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tool.id, "content": value}]}])
    test.assertEqual(value, SOURCE)
    return messages, getattr(reply, "id", None)


async def target_method(test, cell, client, provider, messages, response_id):
    protocol = "openai-chat" if cell["protocol"] == "openai-chat-completions" else cell["protocol"]
    asynchronous = cell["execution"] == "async"
    method, api, params = cell["method"], resource(client, protocol), kwargs(protocol, messages=messages)
    events = []
    if method in ("create", "messages.create"):
        value = await resolved(api.create(**params))
        answer = native_text(value, protocol)
    elif method in ("create.stream", "messages.create.stream"):
        value = await resolved(api.create(**params, stream=True))
        try:
            chunks = await collect(value, asynchronous)
        finally:
            await resolved(value.close())
        events = [event_name(event) for event in chunks]
        text = "".join(event.choices[0].delta.content or "" for event in chunks if event.choices) if protocol == "openai-chat" else \
            "".join(event.delta for event in chunks if event.type == "response.output_text.delta") if protocol == "openai-responses" else \
            "".join(event.delta.text for event in chunks if event.type == "content_block_delta" and event.delta.type == "text_delta")
        test.assertGreater(len(events), 2)
        answer = text
    elif method in ("with_raw_response.create", "messages.raw_response"):
        raw = await resolved(api.with_raw_response.create(**params))
        test.assertEqual(raw.status_code, 200)
        value = await resolved(raw.parse())
        answer = native_text(value, protocol)
    elif method == "with_streaming_response.create":
        async with AsyncExitStack() as stack:
            raw = await enter(stack, api.with_streaming_response.create(**params), asynchronous)
            test.assertIsInstance(await resolved(raw.read()), bytes)
            value = await resolved(raw.parse())
            answer = native_text(value, protocol)
    elif method == "parse":
        value = await resolved(api.parse(**{**params, "model": "parse", "response_format" if protocol == "openai-chat" else "text_format": Answer}))
        parsed = value.choices[0].message.parsed if protocol == "openai-chat" else value.output_parsed
        test.assertEqual(parsed, Answer(answer=42))
        answer = {"answer": parsed.answer}
    elif method == "messages.stream":
        async with AsyncExitStack() as stack:
            value = await enter(stack, api.stream(**params), asynchronous)
            chunks = await collect(value, asynchronous)
            final = await resolved(value.get_final_message())
            answer = native_text(final, protocol)
            events = [event_name(event) for event in chunks]
            test.assertGreater(len(events), 2)
    elif method == "cancel":
        value = await resolved(api.create(**params, stream=True))
        iterator = value.__aiter__() if asynchronous else iter(value)
        first = await anext(iterator) if asynchronous else next(iterator)
        events = [event_name(first)]
        await resolved(value.close())
        test.assertFalse(provider.release.is_set())
        test.assertTrue(await asyncio.to_thread(provider.peer_closed))
        answer = "cancelled_before_fixture_eof"
    elif method == "server_history_reference":
        for reference in ({"previous_response_id": response_id}, {"conversation": "conv-fixture"}, {"conversation": {"id": "conv-fixture"}}):
            value = await resolved(api.create(model="helpers", input=[messages[-1]], **reference))
            test.assertEqual(native_text(value, protocol), "native")
            test.assertEqual(provider.calls[-1]["body"]["input"], [messages[-1]])
            for key, entry in reference.items():
                test.assertEqual(provider.calls[-1]["body"][key], entry)
        answer = "native"
    elif method == "unrelated_endpoint_passthrough":
        value = await resolved(client.embeddings.create(model="fixture-embedding", input=SOURCE, encoding_format="float"))
        test.assertEqual(value.data[0].embedding, [1.0, 2.0])
        answer = value.data[0].embedding
    elif method == "count_tokens.passthrough":
        value = await resolved(client.messages.count_tokens(model="helpers", messages=messages))
        test.assertEqual(value.input_tokens, 7)
        answer = {"input_tokens": value.input_tokens}
    else:
        raise AssertionError("No executing native method for " + cell["id"])
    if method not in ("parse", "cancel", "unrelated_endpoint_passthrough", "count_tokens.passthrough"):
        test.assertEqual(answer, "native")
    return {"native_type": type(value).__name__, "value": answer, "events": events}


async def model_case(test, cell, endpoint, mode):
    protocol = "openai-chat" if cell["protocol"] == "openai-chat-completions" else cell["protocol"]
    asynchronous = cell["execution"] == "async"
    with Provider(protocol, pause="first" if cell["method"] == "cancel" else None) as provider:
        reports = []
        runtime, plans, receipts = runtime_for(asynchronous, mode, deadline_ms=3000, on_report=reports.append)
        async with AsyncExitStack() as stack:
            await enter(stack, runtime, asynchronous)
            if mode == "compress":
                await resolved(runtime.ready())
            transport = (CavemanAsyncOpenAITransport(httpx2.AsyncHTTPTransport()) if asynchronous else CavemanOpenAITransport(httpx2.HTTPTransport())) if protocol.startswith("openai") else None
            original = await enter(stack, client_for(provider, asynchronous, transport=transport), asynchronous)
            scope = Scope("provider-certification", digest(cell["id"] + mode))
            client = with_caveman_openai(original, runtime=runtime, scope=scope, transport=transport) if protocol.startswith("openai") else with_caveman_anthropic(original, runtime=runtime, scope=scope)
            source_calls = []
            messages, response_id = await source_history(test, original, protocol, asynchronous, source_calls)
            before = copy.deepcopy(messages)
            output = await target_method(test, cell, client, provider, messages, response_id)
            test.assertEqual(messages, before)
            test.assertEqual(source_calls, [SOURCE])
            test.assertEqual(provider.errors, [])
            test.assertTrue(all(not result.replacements for _, result in plans))
            test.assertTrue(all(options["binding"] is None for options, _ in plans))
            body = provider.calls[-1]["body"]
            test.assertIn(SOURCE, json.dumps(body, ensure_ascii=False).replace("\\r", "\r").replace("\\n", "\n"))
            no_optimizer = cell["method"] in ("server_history_reference", "unrelated_endpoint_passthrough", "count_tokens.passthrough") or mode == "off"
            test.assertEqual(len(plans), 0 if no_optimizer else 1)
            if mode == "outage" and plans:
                test.assertEqual(plans[-1][1].status, "bypassed")
                test.assertEqual(plans[-1][1].reason, "runtime_unavailable")
            return {"output": output, "reports": report_evidence(test, runtime, reports, plans, receipts, len(provider.calls) - 1, mode), "source_executions": len(source_calls), "provider_calls": len(provider.calls), "optimizer_requests": len(plans),
                "recovery_requests": 0, "replacements": 0, "request_sha256": digest(provider.calls[-1]["raw"]),
                "response_sha256": digest(provider.responses[-1]["raw"]) if provider.responses and cell["recovery"] == "not_applicable" else None,
                "history_sha256": digest(before), "original_provider_text": True, "native_socket_closed_before_eof": cell["method"] == "cancel"}


async def loop_case(test, cell, mode):
    protocol = "openai-chat" if cell["protocol"] == "openai-chat-completions" else cell["protocol"]
    asynchronous, streaming = cell["execution"] == "async", cell["streaming"]
    with Provider(protocol) as provider:
        reports = []
        runtime, plans, receipts = runtime_for(asynchronous, mode, deadline_ms=3000, on_report=reports.append)
        async with AsyncExitStack() as stack:
            await enter(stack, runtime, asynchronous)
            if mode == "compress":
                await resolved(runtime.ready())
            transport = (CavemanAsyncOpenAITransport(httpx2.AsyncHTTPTransport()) if asynchronous else CavemanOpenAITransport(httpx2.HTTPTransport())) if protocol.startswith("openai") else None
            original = await enter(stack, client_for(provider, asynchronous, transport=transport), asynchronous)
            scope = Scope("provider-certification", digest(cell["id"] + mode))
            source_calls, event_types = [], []
            if protocol.startswith("openai"):
                def read_logs(arguments):
                    source_calls.append(arguments)
                    return SOURCE
                async def aread_logs(arguments):
                    return read_logs(arguments)
                bundle = with_caveman_openai_tools(original, runtime=runtime, scope=scope, transport=transport, protocol=protocol,
                    tools=definitions(protocol), functions={"read_logs": aread_logs if asynchronous else read_logs})
                messages = [{"role": "user", "content": "Read source and recover row 70"}]
                for _ in range(5):
                    result = await resolved(resource(bundle.client, protocol).create(**kwargs(protocol, "loop", messages), tools=bundle.tools))
                    calls = append_response(messages, result, protocol)
                    if not calls:
                        break
                    for call_id, name, arguments in calls:
                        value = await resolved(bundle.functions[name](arguments))
                        append_result(messages, protocol, call_id, value)
                final = native_text(result, protocol)
                stored = results({"messages" if protocol == "openai-chat" else "input": messages}, protocol)
                execution_owner = "application"
            else:
                class TracedSource(SourceTool):
                    def call(self, input):
                        source_calls.append(input)
                        return super().call(input)
                class TracedAsyncSource(AsyncSourceTool):
                    async def call(self, input):
                        source_calls.append(input)
                        return await super().call(input)
                client = with_caveman_anthropic(original, runtime=runtime, scope=scope)
                messages = [{"role": "user", "content": "Read source and recover row 70"}]
                before = copy.deepcopy(messages)
                runner = client.beta.messages.tool_runner(model="loop", max_tokens=100, messages=messages, tools=[TracedAsyncSource() if asynchronous else TracedSource()], max_iterations=5, stream=streaming)
                if streaming:
                    if asynchronous:
                        async for stream in runner:
                            event_types.append([event_name(event) for event in await collect(stream, True)])
                            result = await stream.get_final_message()
                    else:
                        for stream in runner:
                            event_types.append([event_name(event) for event in await collect(stream, False)])
                            result = stream.get_final_message()
                else:
                    result = await resolved(runner.until_done())
                final = result.content[0].text
                captured = []
                runner.set_messages_params(lambda params: captured.append(params) or params)
                stored = results(captured[0], protocol)
                test.assertEqual(messages, before)
                execution_owner = "native_tool_runner"
            test.assertEqual(final, FACT)
            test.assertEqual(source_calls, [{}])
            test.assertEqual(stored["read-1"], SOURCE)
            test.assertEqual(len(provider.calls), 3 if mode == "compress" else 2)
            test.assertEqual(provider.errors, [])
            projected = results(provider.calls[1]["body"], protocol)["read-1"]
            test.assertEqual(mode == "compress", projected != SOURCE)
            recovered = results(provider.calls[-1]["body"], protocol).get("recover-1")
            if mode == "compress":
                test.assertNotIn(FACT, projected)
                test.assertIn("cmw_", projected)
                test.assertEqual(json.loads(recovered)["text"], SOURCE)
                test.assertTrue(any(result.replacements for _, result in plans))
            else:
                test.assertIsNone(recovered)
                test.assertTrue(all(not result.replacements for _, result in plans))
                test.assertEqual(len(plans), 0 if mode == "off" else 2)
                if mode == "outage":
                    test.assertTrue(any(result.reason == "runtime_unavailable" for _, result in plans))
            return {"reports": report_evidence(test, runtime, reports, plans, receipts, len(provider.calls), mode), "execution_owner": execution_owner, "upstream_scheduler_available": protocol == "anthropic-messages",
                "native_type": type(result).__name__, "value": final, "events": event_types, "source_executions": len(source_calls), "source_sha256": SOURCE_HASH,
                "provider_calls": len(provider.calls), "optimizer_requests": len(plans), "recovery_requests": int(recovered is not None),
                "transformed_provider_requests": sum(results(call["body"], protocol).get("read-1", SOURCE) != SOURCE for call in provider.calls),
                "recovered_sha256": digest(json.loads(recovered)["text"]) if recovered else None, "stored_source_sha256": digest(stored["read-1"])}


def emit(test, cell, assertion, observation):
    if os.environ.get("CAVEMAN_MIDDLEWARE_CERT_FAMILY") not in (None, cell["family"]):
        return
    name = ".".join(test.id().split(".")[-2:])
    print("CAVEMAN_MIDDLEWARE_OBSERVATION " + json.dumps({"cell_id": cell["id"], "test_id": TEST_FILE + "::" + name, "assertion": assertion, "observation": observation}, separators=(",", ":")), flush=True)


async def certify_cells(test, family, execution):
    cells = [cell for cell in json.loads((ROOT / "packages/middleware/conformance/support/required-cells.json").read_text())["cells"] if cell["family"] == family and cell["language"] == "python" and cell["execution"] == execution]
    test.assertEqual(len(cells), 17 if family == "F01" else 8)
    for cell in cells:
        with test.subTest(cell=cell["id"]):
            rows = {mode: await (loop_case(test, cell, mode) if cell["recovery"] == "native_executor" else model_case(test, cell, os.environ["CAVEMAN_MIDDLEWARE_ENDPOINT"], mode)) for mode in ("compress", "off", "outage")}
            current, off, unavailable = rows["compress"], rows["off"], rows["outage"]
            if cell["recovery"] == "native_executor":
                test.assertEqual(current["value"], off["value"])
                test.assertEqual(current["value"], unavailable["value"])
                journey = {
                    "native_application": {"outcome": "observed", "execution_owner": current["execution_owner"], "upstream_scheduler_available": current["upstream_scheduler_available"], "method": cell["method"], "execution": execution},
                    "real_tool_result": {"outcome": "observed", "executor": "read_logs", "executions": current["source_executions"], "utf8_bytes": len(SOURCE.encode()), "sha256": SOURCE_HASH},
                    "transformed_provider_request": {"outcome": "observed", "provider_requests_with_projection": current["transformed_provider_requests"], "omitted_fact_absent": True, "stored_source_sha256": current["stored_source_sha256"]},
                    "omitted_fact_requested": {"outcome": "observed", "requested_fact": FACT, "native_recovery_function": "caveman_retrieve", "recovery_requests": current["recovery_requests"]},
                    "host_executes_exact_recovery": {"outcome": "observed", "execution_owner": current["execution_owner"], "recovered_sha256": current["recovered_sha256"], "source_sha256": SOURCE_HASH},
                    "native_result_history_events_and_call_count": {"outcome": "observed", "native_type": current["native_type"], "final_value": current["value"], "event_order": current["events"], "provider_calls": current["provider_calls"], "stored_source_sha256": current["stored_source_sha256"]},
                    "off_baseline": {"outcome": "observed", "final_value": off["value"], "provider_calls": off["provider_calls"], "optimizer_requests": off["optimizer_requests"], "recovery_requests": off["recovery_requests"], "stored_source_sha256": off["stored_source_sha256"]},
                    "optimizer_unavailable": {"outcome": "observed", "final_value": unavailable["value"], "provider_calls": unavailable["provider_calls"], "optimizer_requests": unavailable["optimizer_requests"], "recovery_requests": unavailable["recovery_requests"], "stored_source_sha256": unavailable["stored_source_sha256"]},
                }
            else:
                test.assertEqual(current["output"], off["output"])
                test.assertEqual(current["output"], unavailable["output"])
                test.assertEqual(current["request_sha256"], off["request_sha256"])
                test.assertEqual(current["request_sha256"], unavailable["request_sha256"])
                test.assertEqual(current["provider_calls"], off["provider_calls"])
                test.assertEqual(current["provider_calls"], unavailable["provider_calls"])
                passthrough = cell["recovery"] == "not_applicable"
                no_recovery = {"outcome": "recovery_free", "reason": "non-generation endpoint preserves the native exchange" if passthrough else "native model-only operation has no registered recovery executor",
                    "recovery_requests": 0, "replacements": 0, **({"applicability": "endpoint_passthrough", "optimizer_requests": 0, "request_sha256": current["request_sha256"], "response_sha256": current["response_sha256"], "provider_calls": current["provider_calls"]} if passthrough else {"original_provider_text": current["original_provider_text"], "source_sha256": SOURCE_HASH})}
                if passthrough:
                    test.assertEqual(current["response_sha256"], off["response_sha256"])
                    test.assertEqual(current["response_sha256"], unavailable["response_sha256"])
                journey = {
                    "native_application": {"outcome": "observed", "method": cell["method"], "execution": execution, "official_sdk_client": True},
                    "real_tool_result": no_recovery if passthrough else {"outcome": "observed", "executor": "read_logs", "execution_owner": "application", "executions": current["source_executions"], "sha256": SOURCE_HASH, "utf8_bytes": len(SOURCE.encode())},
                    "transformed_provider_request": no_recovery, "omitted_fact_requested": no_recovery, "host_executes_exact_recovery": no_recovery,
                    "native_result_history_events_and_call_count": {"outcome": "observed", **current["output"], "provider_calls": current["provider_calls"], "original_history_sha256": current["history_sha256"], "native_socket_closed_before_eof": current["native_socket_closed_before_eof"]},
                    "off_baseline": {"outcome": "observed", "native_output": off["output"], **({"applicability": "endpoint_passthrough"} if passthrough else {}), **{key: off[key] for key in ("request_sha256", "response_sha256", "provider_calls", "optimizer_requests", "recovery_requests", "replacements")}},
                    "optimizer_unavailable": {"outcome": "observed", "native_output": unavailable["output"], **({"applicability": "endpoint_passthrough"} if passthrough else {}), **{key: unavailable[key] for key in ("request_sha256", "response_sha256", "provider_calls", "optimizer_requests", "recovery_requests", "replacements")}},
                }
            journey["native_result_history_events_and_call_count"]["native_reports"] = current["reports"]
            journey["off_baseline"]["native_reports"] = off["reports"]
            journey["optimizer_unavailable"]["native_reports"] = unavailable["reports"]
            for assertion, observation in journey.items():
                emit(test, cell, assertion, observation)
