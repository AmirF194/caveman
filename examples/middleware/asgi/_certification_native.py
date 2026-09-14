"""Native SDKs through actual FastAPI/Starlette routes and a local Uvicorn socket."""
from __future__ import annotations

import asyncio
import copy
import gzip
import hashlib
import json
import os
import re
import socket
from collections import Counter
from contextlib import asynccontextmanager
from dataclasses import FrozenInstanceError, asdict
from pathlib import Path

import anthropic
import httpx2
import openai
from openai.lib.streaming.chat import AsyncChatCompletionStream
from fastapi import FastAPI, Request
from pydantic import BaseModel
from starlette.applications import Starlette
from starlette.requests import ClientDisconnect
from starlette.responses import Response, StreamingResponse
from starlette.routing import Route, WebSocketRoute
import uvicorn

from caveman_cloud.middleware import Scope
from caveman_middleware.asgi import ASGIContext, CavemanASGIMiddleware
from evidence_runtime import EvidenceRuntime
from _http_fixture import FACT, SOURCE, Provider, definitions, results
from test_native import ROUTES, invoke

TEST_FILE = "examples/middleware/asgi/test_native.py"
PATHS = {value: key for key, value in ROUTES.items()}


def sha(value):
    wire = value if isinstance(value, bytes) else (value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))).encode()
    return hashlib.sha256(wire).hexdigest()


SOURCE_SHA = sha(SOURCE)


class Answer(BaseModel):
    answer: int


def runtime_for(mode, reports):
    return EvidenceRuntime(endpoint="http://127.0.0.1:1" if mode == "outage" else os.environ["CAVEMAN_MIDDLEWARE_ENDPOINT"],
                           mode="off" if mode == "off" else "compress", on_report=reports.append, deadline_ms=1000)


def report_summary(test, runtime, reports, count, mode):
    test.assertEqual(len(reports), count)
    test.assertIs(runtime.last_report, reports[-1])
    fields = {"schema_version", "status", "reason", "transform_ids", "replacement_count", "reused_count", "adapter", "logical_call_id", "attempt_id"}
    for report in reports:
        test.assertEqual(set(asdict(report)), fields)
        test.assertEqual(report.adapter, "asgi")
        with test.assertRaises(FrozenInstanceError):
            report.status = "forged"
        plan = next((plan for _, plan in runtime.plans if plan.request and plan.request["attempt_id"] == report.attempt_id
                     and plan.request["logical_call_id"] == report.logical_call_id), None)
        replacements = plan.replacements if plan else ()
        status = "disabled" if mode == "off" else ("reused" if all(item.get("reused") for item in replacements) else "applied") if replacements else "skipped"
        test.assertEqual(report.status, status)
        test.assertEqual(report.replacement_count, len(replacements))
        test.assertEqual(report.transform_ids, tuple(sorted({item["transform_id"] for item in replacements})))
        test.assertNotIn(SOURCE, repr(report))
    if mode == "off":
        test.assertEqual(runtime.plans, [])
        test.assertEqual(runtime.receipts, [])
    return {"count": count, "statuses": dict(sorted(Counter(report.status for report in reports).items())),
            "replacement_counts": [report.replacement_count for report in reports], "metadata_only": True}


class Gateway:
    """Application-owned HTTP forwarding, authentication, and original-body guard.

    The application already forwards its LLM route. Caveman adds no inference
    hop. The fixture's guard records native client bytes before the projection.
    """
    def __init__(self, test, provider, runtime, binding, framework, *, split=False):
        self.test, self.provider, self.protocol = test, provider, provider.protocol
        self.incoming, self.forwarded, self.native_chunks, self.resolved, self.errors = [], [], [], [], []
        self.path = PATHS[self.protocol]
        self.http = httpx2.AsyncClient(timeout=5, trust_env=False)

        async def endpoint(request: Request):
            wire = await request.body()
            self.forwarded.append(wire)
            headers = [(key, value) for key, value in request.scope["headers"] if key.lower() not in
                       (b"host", b"content-length", b"transfer-encoding", b"connection")]
            response = await self.http.send(self.http.build_request("POST", provider.url + self.path, content=wire, headers=headers), stream=True)
            response_headers = {key: value for key, value in response.headers.items() if key.lower() not in ("connection", "transfer-encoding")}
            if "text/event-stream" in response.headers.get("content-type", ""):
                async def chunks():
                    try:
                        async for chunk in response.aiter_raw():
                            yield chunk
                    finally:
                        await response.aclose()
                return StreamingResponse(chunks(), status_code=response.status_code, headers=response_headers)
            try:
                return Response(await response.aread(), status_code=response.status_code, headers=response_headers)
            finally:
                await response.aclose()

        if framework == "fastapi":
            native = FastAPI()
            native.add_api_route(self.path, endpoint, methods=["POST"])
        else:
            native = Starlette(routes=[Route(self.path, endpoint, methods=["POST"])])

        async def tapped(scope, receive, send):
            received = []
            self.native_chunks.append(received)
            async def observe():
                message = await receive()
                received.append(message)
                return message
            return await native(scope, observe, send)

        def resolve(scope):
            test.assertEqual(scope["state"]["principal"], "fixture-native-client")
            self.resolved.append(scope["path"])
            return ASGIContext(binding.scope, binding)

        middleware = CavemanASGIMiddleware(tapped, runtime=runtime, routes={self.path: self.protocol}, resolve_context=resolve)

        async def auth_and_original_guard(scope, receive, send):
            consumed = []
            while True:
                message = await receive()
                consumed.append(message)
                if not message.get("more_body", False):
                    break
            wire = b"".join(message.get("body", b"") for message in consumed)
            self.incoming.append(wire)
            original_source = results(json.loads(wire), self.protocol).get("read-1")
            if original_source is not None:
                test.assertEqual(original_source, SOURCE)
            if not any(key.lower() in (b"authorization", b"x-api-key") for key, _ in scope["headers"]) or b"blocked-original" in wire:
                return await Response("native guard denied", status_code=403)(scope, receive, send)
            if split:
                # Force real ASGI boundaries, including a split inside UTF-8.
                cut = wire.find("🌍".encode()) + 2
                cut = cut if cut > 2 else len(wire) // 2
                consumed = [{"type": "http.request", "body": wire[:cut], "more_body": True},
                            {"type": "http.request", "body": wire[cut:], "more_body": False}]
            queue = list(consumed)
            async def replay():
                return queue.pop(0) if queue else await receive()
            return await middleware({**scope, "state": {"principal": "fixture-native-client"}}, replay, send)

        async def app(scope, receive, send):
            try:
                return await auth_and_original_guard(scope, receive, send)
            except Exception as error:
                self.errors.append(error)
                raise
        self.app = app

    async def __aenter__(self):
        self.socket = socket.socket()
        self.socket.bind(("127.0.0.1", 0))
        self.socket.listen()
        self.url = f"http://127.0.0.1:{self.socket.getsockname()[1]}"
        self.server = uvicorn.Server(uvicorn.Config(self.app, log_level="critical", access_log=False, lifespan="off", ws="none", timeout_graceful_shutdown=3))
        self.task = asyncio.create_task(self.server.serve(sockets=[self.socket]))
        async def started():
            while not self.server.started:
                if self.task.done():
                    await self.task
                    raise AssertionError("Uvicorn stopped before accepting native clients")
                await asyncio.sleep(0.001)
        await asyncio.wait_for(started(), 5)
        return self

    async def __aexit__(self, *_):
        self.provider.release.set()
        self.server.should_exit = True
        try:
            await asyncio.wait_for(self.task, 5)
        finally:
            await self.http.aclose()
            self.socket.close()
        if self.errors:
            raise AssertionError("Native gateway failed") from self.errors[0]


def client_for(protocol, gateway):
    cls = openai.AsyncOpenAI if protocol.startswith("openai") else anthropic.AsyncAnthropic
    return cls(api_key="fixture", base_url=gateway.url + ("/v1" if protocol.startswith("openai") else ""), max_retries=0, timeout=5)


def api_for(client, protocol):
    return client.chat.completions if protocol == "openai-chat" else client.responses if protocol == "openai-responses" else client.messages


def parameters(protocol, messages, tools, *, model="loop"):
    return {"model": model, "input" if protocol == "openai-responses" else "messages": messages, "tools": tools,
            "extra_headers": {"x-native-option": "preserved"}, **({"max_tokens": 100} if protocol == "anthropic-messages" else {})}


def binding_schema(binding, protocol):
    native = {"name": binding.name, "description": binding.description,
              "input_schema" if protocol == "anthropic-messages" else "parameters": dict(binding.input_schema)}
    return {"type": "function", "function": native} if protocol == "openai-chat" else {"type": "function", **native} if protocol == "openai-responses" else native


def append_reply(messages, reply, protocol):
    if protocol == "openai-chat":
        message = reply.choices[0].message
        messages.append(message.model_dump(exclude_none=True))
        return [(call.id, call.function.name, json.loads(call.function.arguments)) for call in message.tool_calls or []]
    if protocol == "openai-responses":
        messages.extend(item.model_dump(exclude_none=True) for item in reply.output)
        return [(item.call_id, item.name, json.loads(item.arguments)) for item in reply.output if item.type == "function_call"]
    messages.append({"role": "assistant", "content": [part.model_dump(exclude_none=True) for part in reply.content]})
    return [(part.id, part.name, part.input) for part in reply.content if part.type == "tool_use"]


def append_result(messages, protocol, call_id, value):
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    item = {"role": "tool", "tool_call_id": call_id, "content": text} if protocol == "openai-chat" else \
           {"type": "function_call_output", "call_id": call_id, "output": text} if protocol == "openai-responses" else \
           {"role": "user", "content": [{"type": "tool_result", "tool_use_id": call_id, "content": text}]}
    messages.append(item)


def text_of(reply, protocol):
    return reply.choices[0].message.content if protocol == "openai-chat" else reply.output_text if protocol == "openai-responses" else reply.content[0].text


async def native_call(test, api, params, protocol, provider, streaming):
    before = copy.deepcopy(params)
    events = []
    if streaming:
        provider.release.clear()
        # The low-level chat stream permits ordinary function schemas. Use the
        # SDK's native accumulator without asking its strict auto-parse helper.
        manager = AsyncChatCompletionStream(raw_stream=await api.create(**params, stream=True), response_format=openai.omit,
                                            input_tools=params["tools"]) if protocol == "openai-chat" else api.stream(**params)
        async with manager as stream:
            first = await asyncio.wait_for(anext(stream.__aiter__()), 3)
            events.append(first.type)
            test.assertFalse(provider.release.is_set(), "native first event must arrive while upstream EOF is blocked")
            provider.release.set()
            events.extend([event.type async for event in stream])
            reply = await (stream.get_final_completion() if protocol == "openai-chat" else stream.get_final_response() if protocol == "openai-responses" else stream.get_final_message())
        test.assertGreater(len(events), 2)
    else:
        reply = await api.create(**params)
    test.assertEqual(params, before)
    expected = openai.types.chat.ChatCompletion if protocol == "openai-chat" else openai.types.responses.Response if protocol == "openai-responses" else anthropic.types.Message
    test.assertIsInstance(reply, expected)
    return reply, events


async def boundary_case(test, method, protocol, mode, wire):
    """Run the named ASGI edge with original SDK bytes, separate from eligible traffic."""
    if method not in ("early_disconnect", "oversized_body_replay", "auth_guardrail_order", "encoded_body_passthrough", "unrelated_route_lifespan_websocket_passthrough"):
        return None
    reports, observed, resolved, lifecycle = [], [], [], []
    with runtime_for(mode, reports) as sync:
        runtime = sync.as_async()
        binding = runtime.recovery(Scope("asgi-boundary", sha(protocol + method + mode)))
        async def endpoint(request):
            try:
                body = await request.body()
                observed.append(body)
                return Response(body, headers={"x-native-response": "untouched"})
            except ClientDisconnect:
                observed.append("native-disconnect")
                return Response("native disconnect", status_code=499)
        async def websocket(ws):
            await ws.accept()
            await ws.send_text("native websocket")
            await ws.close()
        @asynccontextmanager
        async def lifespan(_app):
            lifecycle.append("startup")
            yield
            lifecycle.append("shutdown")
        native = Starlette(routes=[Route(PATHS[protocol], endpoint, methods=["POST"]), Route("/ordinary", endpoint, methods=["POST"]), WebSocketRoute("/ws", websocket)], lifespan=lifespan)
        def context(_scope):
            resolved.append(True)
            return ASGIContext(binding.scope, binding)
        wrapped = CavemanASGIMiddleware(native, runtime=runtime, routes={PATHS[protocol]: protocol}, resolve_context=context,
                                       max_body_bytes=128 if method == "oversized_body_replay" else 2 << 20)
        path, request, headers = PATHS[protocol], wire, []
        if method == "early_disconnect":
            incoming = [{"type": "http.request", "body": wire[:37], "more_body": True}, {"type": "http.disconnect"}]
        elif method == "oversized_body_replay":
            test.assertGreater(len(wire), 128)
            incoming = [{"type": "http.request", "body": wire[i:i+71], "more_body": i+71 < len(wire)} for i in range(0, len(wire), 71)]
        else:
            if method == "encoded_body_passthrough":
                request = gzip.compress(wire, mtime=0)
                headers = [(b"content-encoding", b"gzip")]
            elif method == "unrelated_route_lifespan_websocket_passthrough":
                path = "/ordinary"
            incoming = [{"type": "http.request", "body": request, "more_body": False}]
        if method == "auth_guardrail_order":
            async def guarded(scope, receive, send):
                message = await receive()
                if (b"authorization", b"valid") not in scope["headers"] or b"blocked-original" in message["body"]:
                    return await Response("native guard denied", status_code=403)(scope, receive, send)
                return await wrapped(scope, receive, send)
            for extra in ([], [(b"authorization", b"valid")]):
                events = await invoke(guarded, path, wire + b"blocked-original", extra_headers=extra)
                test.assertEqual(events[0]["status"], 403)
                test.assertEqual(b"".join(event.get("body", b"") for event in events), b"native guard denied")
            test.assertEqual(resolved, [])
            test.assertEqual(observed, [])
            test.assertEqual(reports, [])
            edge = {"rejections": 2, "scope_resolutions": 0, "native_app_dispatches": 0, "status": 403}
        else:
            baseline = await invoke(native, path, chunks=copy.deepcopy(incoming), extra_headers=headers)
            events = await invoke(wrapped, path, chunks=copy.deepcopy(incoming), extra_headers=headers)
            test.assertEqual(events, baseline)
            test.assertEqual(observed[-1], "native-disconnect" if method == "early_disconnect" else request)
            test.assertEqual(observed[-1], observed[-2])
            edge = {"input_chunks": len(incoming), "original_request_sha256": sha(request), "response_sha256": sha(b"".join(event.get("body", b"") for event in events)),
                    "status": events[0]["status"], "native_event_identity": True, "reports": len(reports)}
            if method == "unrelated_route_lifespan_websocket_passthrough":
                async def invoke_surface(app, scope, inputs):
                    queue, sent = list(inputs), []
                    async def receive():
                        return queue.pop(0)
                    async def send(event):
                        sent.append(event)
                    await app(scope, receive, send)
                    return sent
                for scope, incoming in [({"type": "lifespan", "asgi": {"version": "3.0"}, "state": {}}, [{"type": "lifespan.startup"}, {"type": "lifespan.shutdown"}]),
                                        ({"type": "websocket", "path": "/ws", "scheme": "ws", "headers": [], "query_string": b"", "root_path": "", "subprotocols": []}, [{"type": "websocket.connect"}])]:
                    baseline = await invoke_surface(native, copy.deepcopy(scope), incoming)
                    test.assertEqual(await invoke_surface(wrapped, copy.deepcopy(scope), incoming), baseline)
                test.assertEqual(lifecycle, ["startup", "shutdown", "startup", "shutdown"])
                edge.update(lifespan_native=True, websocket_native=True)
            test.assertTrue(all(report.status == ("disabled" if mode == "off" else "skipped") for report in reports))
        test.assertEqual(sync.plans, [])
        test.assertEqual(sync.receipts, [])
        return {"outcome": "observed", "method": method, "role": "named boundary control; eligible route journey measured separately", "optimizer_requests": 0, "replacements": 0, **edge}


async def route_case(test, cell, mode):
    protocol = "openai-chat" if cell["protocol"] == "openai-chat-completions" else cell["protocol"]
    method, streaming = cell["method"], cell["streaming"]
    structured, reports = method == "structured_output", []
    framework = "starlette" if method.startswith("starlette") or method in ("early_disconnect", "oversized_body_replay", "encoded_body_passthrough", "unrelated_route_lifespan_websocket_passthrough") else "fastapi"
    with Provider(protocol, pause="first" if streaming else None) as provider, runtime_for(mode, reports) as sync:
        runtime = sync.as_async()
        if mode == "compress":
            await runtime.ready()
        binding = runtime.recovery(Scope("asgi-native", sha(cell["id"] + mode)))
        tools = [*definitions(protocol), binding_schema(binding, protocol)]
        messages, source_calls, recovered, event_types = [{"role": "user", "content": "Read source and recover row 70"}], [], [], []
        async with Gateway(test, provider, runtime, binding, framework, split=method == "split_request_chunks") as gateway, client_for(protocol, gateway) as client:
            api = api_for(client, protocol)
            while True:
                if structured and source_calls:
                    params = parameters(protocol, messages, [], model="parse")
                    key = "response_format" if protocol == "openai-chat" else "text_format" if protocol == "openai-responses" else "output_format"
                    frozen = copy.deepcopy(params)
                    reply = await api.parse(**params, **{key: Answer})
                    parsed = reply.choices[0].message.parsed if protocol == "openai-chat" else reply.output_parsed if protocol == "openai-responses" else reply.parsed_output
                    test.assertEqual(parsed, Answer(answer=42))
                    test.assertEqual(params, frozen)
                    answer = str(parsed.answer)
                    break
                reply, events = await native_call(test, api, parameters(protocol, messages, tools), protocol, provider, streaming)
                event_types.append(events)
                calls = append_reply(messages, reply, protocol)
                if not calls:
                    answer = text_of(reply, protocol)
                    test.assertEqual(answer, FACT)
                    break
                test.assertLessEqual(len(provider.calls), 3)
                for call_id, name, arguments in calls:
                    if name == "read_logs":
                        test.assertEqual(arguments, {})
                        value = SOURCE
                        source_calls.append(value)
                    else:
                        test.assertEqual(name, "caveman_retrieve")
                        value = await binding.execute(arguments)
                        test.assertEqual(value["text"], SOURCE)
                        recovered.append(value)
                    append_result(messages, protocol, call_id, value)
            lossy = mode == "compress" and not structured
            expected_calls = 3 if lossy else 2
            test.assertEqual(len(provider.calls), expected_calls,
                             f"native route {cell['id']} {mode}: plans={[(plan.status, plan.reason) for _, plan in sync.plans]}; "
                             f"reports={[(report.status, report.reason) for report in reports]}")
            test.assertEqual(source_calls, [SOURCE])
            test.assertEqual(len(recovered), int(lossy))
            stored = results({"input" if protocol == "openai-responses" else "messages": messages}, protocol)
            test.assertEqual(stored["read-1"], SOURCE)
            projected = results(provider.calls[1]["body"], protocol)["read-1"]
            test.assertEqual(projected != SOURCE, lossy)
            if lossy:
                test.assertNotIn(FACT, projected)
                test.assertRegex(projected, r"cmw_[a-f0-9]{48}")
            test.assertEqual(provider.errors, [])
            test.assertEqual(len(gateway.forwarded), expected_calls)
            test.assertEqual(len(gateway.incoming), expected_calls)
            for call, wire in zip(provider.calls, gateway.forwarded):
                test.assertEqual(call["raw"].encode(), wire)
                headers = {key.lower(): value for key, value in call["headers"].items()}
                test.assertEqual(headers["x-native-option"], "preserved")
                test.assertEqual(int(headers["content-length"]), len(wire))
            original_wire = gateway.incoming[1]
            test.assertEqual(results(json.loads(original_wire), protocol)["read-1"], SOURCE)
            test.assertEqual(len(gateway.resolved), 0 if mode == "off" else expected_calls)
            chunk_counts = [len([item for item in queue if item["type"] == "http.request"]) for queue in gateway.native_chunks]
            if method == "split_request_chunks":
                test.assertEqual(chunk_counts[1], 1 if lossy else 2)
            if streaming:
                test.assertEqual(len(event_types), expected_calls)
                test.assertTrue(all(len(events) > 2 for events in event_types))
            summary = {"outcome": "observed", "framework": framework, "native_type": type(reply).__name__, "answer_sha256": sha(answer),
                       "provider_calls": expected_calls, "source_executions": len(source_calls), "source_sha256": SOURCE_SHA, "stored_source_sha256": sha(stored["read-1"]),
                       "recovery_requests": len(recovered), "recovered_sha256": sha(recovered[0]["text"]) if recovered else None,
                       "projection_requests": sum(results(call["body"], protocol).get("read-1", SOURCE) != SOURCE for call in provider.calls),
                       "view_sha256": sha(re.sub(r"cmw_[a-f0-9]{48}", "<OPAQUE_RECOVERY_HANDLE>", projected)), "original_request_sha256": sha(original_wire),
                       "event_types": event_types, "first_event_before_eof_count": expected_calls if streaming else 0,
                       "native_request_chunks": chunk_counts if method == "split_request_chunks" else None,
                       "original_body_auth_first": True, "native_options_and_headers_preserved": True,
                       "native_reports": report_summary(test, sync, reports, expected_calls, mode)}
        summary["boundary_control"] = await boundary_case(test, method, protocol, mode, original_wire)
        return summary


async def native_errors(test):
    for protocol in PATHS:
        for framework in ("fastapi", "starlette"):
            for mode in ("compress", "off", "outage"):
                with test.subTest(protocol=protocol, framework=framework, mode=mode):
                    reports = []
                    with Provider(protocol) as provider, runtime_for(mode, reports) as sync:
                        runtime = sync.as_async()
                        binding = runtime.recovery(Scope("asgi-native-errors", sha(protocol + framework + mode)))
                        options = parameters(protocol, [{"role": "user", "content": "Native error"}], [], model="failure")
                        expected = openai.BadRequestError if protocol.startswith("openai") else anthropic.BadRequestError
                        async with client_for(protocol, provider) as direct:
                            with test.assertRaises(expected) as baseline:
                                await api_for(direct, protocol).create(**options)
                        async with Gateway(test, provider, runtime, binding, framework) as gateway, client_for(protocol, gateway) as client:
                            with test.assertRaises(expected) as observed:
                                await api_for(client, protocol).create(**options)
                            test.assertEqual(observed.exception.status_code, 400)
                            test.assertEqual(observed.exception.body, baseline.exception.body)
                            test.assertEqual(observed.exception.response.headers["x-request-id"], "fixture-openai")
                            test.assertEqual(len(provider.calls), 2)
                            test.assertEqual(provider.calls[0]["raw"], provider.calls[1]["raw"])
                            test.assertEqual(provider.errors, [])
                            report_summary(test, sync, reports, 1, mode)
                            if mode != "off":
                                test.assertEqual(sync.receipts[-1]["event_kind"], "failed")
                                test.assertIsNone(sync.receipts[-1]["usage"])


async def certify_cells(test, protocol):
    catalog_protocol = "openai-chat-completions" if protocol == "openai-chat" else protocol
    cells = [cell for cell in json.loads(Path(__file__).with_name("certification-cells.json").read_text())["cells"] if cell["protocol"] == catalog_protocol]
    test.assertEqual(len(cells), 11)
    for cell in cells:
        with test.subTest(cell=cell["id"]):
            rows = {mode: await route_case(test, cell, mode) for mode in ("compress", "off", "outage")}
            current, off, outage = rows["compress"], rows["off"], rows["outage"]
            for row in (off, outage):
                test.assertEqual(current["answer_sha256"], row["answer_sha256"])
                test.assertEqual(current["native_type"], row["native_type"])
                test.assertEqual(current["original_request_sha256"], row["original_request_sha256"])
                test.assertEqual(row["recovery_requests"], 0)
                test.assertEqual(row["projection_requests"], 0)
            if cell["recovery"] == "model_only":
                test.assertEqual(current["projection_requests"], 0)
                free = {"outcome": "recovery_free", "reason": "Native typed output cannot call a recovery tool; original source remains provider-visible.", "recovery_requests": 0, "replacements": 0, "source_sha256": SOURCE_SHA}
                projected, omitted, recovered = free, free, free
            else:
                test.assertGreater(current["projection_requests"], 0)
                test.assertEqual(current["recovery_requests"], 1)
                projected = {"outcome": "observed", "role": "eligible LLM route; named passthrough boundaries have separate controls", "provider_requests": current["projection_requests"],
                             "normalized_view_sha256": current["view_sha256"], "normalization": "generated opaque recovery handles only", "omitted_fact_absent": True}
                omitted = {"outcome": "observed", "requested_tool": "caveman_retrieve", "requests": 1, "omitted_fact": FACT}
                recovered = {"outcome": "observed", "executor": "application-owned registered ASGI binding", "source_sha256": SOURCE_SHA, "recovered_sha256": current["recovered_sha256"], "complete": True}
            observations = {"native_application": {"outcome": "observed", "framework": current["framework"], "sdk": "anthropic" if protocol == "anthropic-messages" else "openai", "native_network_server": "uvicorn", "method": cell["method"]},
                            "real_tool_result": {"outcome": "observed", "executor": "application-owned read_logs", "executions": current["source_executions"], "source_sha256": SOURCE_SHA, "utf8_bytes": len(SOURCE.encode())},
                            "transformed_provider_request": projected, "omitted_fact_requested": omitted, "host_executes_exact_recovery": recovered,
                            "native_result_history_events_and_call_count": current, "off_baseline": off, "optimizer_unavailable": outage}
            name = ".".join(test.id().split(".")[-2:])
            for assertion, observation in observations.items():
                print("CAVEMAN_MIDDLEWARE_OBSERVATION " + json.dumps({"cell_id": cell["id"], "test_id": TEST_FILE + "::" + name, "assertion": assertion,
                      "observation": observation}, sort_keys=True, separators=(",", ":")), flush=True)
