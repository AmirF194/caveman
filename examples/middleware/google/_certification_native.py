"""Every frozen Google/Vertex operation uses the actual installed native SDK."""
import asyncio
import copy
import hashlib
import inspect
import json
import os
from pathlib import Path

import httpx
from google import genai
from google.genai import types
from google.oauth2.credentials import Credentials
from pydantic import BaseModel
from caveman_cloud.middleware import MiddlewareRuntime, Scope
from caveman_middleware.google import CavemanGoogleTransport, CavemanGoogleAsyncTransport, with_caveman_google, with_caveman_google_chat
from _certification_fixture import Provider, SOURCE, FACT, values

FILE = "examples/middleware/google/test_native.py"
HASH = hashlib.sha256(SOURCE.encode()).hexdigest()


def digest(value):
    data = value if isinstance(value, str) else json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(data.encode()).hexdigest()


def plain(value):
    return value.model_dump(mode="json", by_alias=True, exclude_none=True) if hasattr(value, "model_dump") else value


def history_values(history):
    return values({"contents": [plain(content) for content in history]})


def event_kind(event):
    return ["function_call:" + part.function_call.name if part.function_call else "function_response:" + part.function_response.name if part.function_response else "text" if part.text is not None else "opaque" for candidate in event.candidates or [] for part in candidate.content.parts or []]


async def resolved(value):
    return await value if inspect.isawaitable(value) else value


class Answer(BaseModel):
    answer: str


class RecordedRuntime(MiddlewareRuntime):
    def __init__(self, **options):
        self.reports = []
        super().__init__(on_report=self.reports.append, **options)
        self.plans, self.receipts = [], []
    def optimize(self, **options):
        value = super().optimize(**options)
        self.plans.append((options, value))
        return value
    def observe_background(self, receipt):
        self.receipts.append(receipt)
        return super().observe_background(receipt)


def client_options(provider, vertex):
    return {"vertexai": True, "project": "fixture-project", "location": "europe-west4", "credentials": Credentials(token="local-fixture-oauth")} if vertex else {"api_key": "local-google-token"}


async def run_case(test, cell, mode):
    asynchronous, cancelled, vertex = cell["execution"] == "async", cell["method"] == "cancel_and_close", cell["provider"] == "vertex"
    model_only, structured, cached = cell["recovery"] == "model_only", cell["structured_output"], cell["method"] == "cached_content.opaque"
    runtime = RecordedRuntime(endpoint="http://127.0.0.1:1" if mode == "outage" else os.environ["CAVEMAN_MIDDLEWARE_ENDPOINT"], mode="off" if mode == "off" else "compress", deadline_ms=200 if mode == "outage" else 3000)
    source_calls = []
    def read_logs() -> str:
        """Read diagnostic logs."""
        source_calls.append({})
        return SOURCE
    with Provider(cancelled) as provider:
        selected_scope = Scope("google-certification", digest(cell["id"] + mode))
        if mode == "compress":
            await resolved(runtime.as_async().ready() if asynchronous else runtime.ready())
        transport = CavemanGoogleTransport(runtime=runtime, scope=selected_scope, provider_base_url=provider.url)
        atransport = CavemanGoogleAsyncTransport(runtime=runtime, scope=selected_scope, provider_base_url=provider.url)
        http, ahttp = httpx.Client(transport=transport), httpx.AsyncClient(transport=atransport)
        options = client_options(provider, vertex)
        http_options = types.HttpOptions(base_url=provider.url, headers={"x-original-option": "preserved"}, retry_options=types.HttpRetryOptions(attempts=1), httpx_client=http, httpx_async_client=ahttp)
        original = genai.Client(**options, http_options=types.HttpOptions(base_url=provider.url, headers={"x-original-option": "preserved"}, retry_options=types.HttpRetryOptions(attempts=1)))
        client = with_caveman_google(genai.Client(**options, http_options=http_options), runtime=runtime, scope=selected_scope)
        try:
            test.assertIsInstance(client, genai.Client)
            config = types.GenerateContentConfig(tools=[read_logs], temperature=0.2, system_instruction="Read exact logs.", safety_settings=[types.SafetySetting(category="HARM_CATEGORY_HATE_SPEECH", threshold="BLOCK_ONLY_HIGH")])
            contents = [types.Content(role="user", parts=[types.Part(text="Find retained-detail-80.")])]
            if model_only:
                source_model = original.aio.models if asynchronous else original.models
                reply = await resolved(source_model.generate_content(model="fixture-read", contents=contents, config=types.GenerateContentConfig(tools=[types.Tool(function_declarations=[types.FunctionDeclaration(name="read_logs", description="Read diagnostics", parameters_json_schema={"type": "object", "properties": {}})])], automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True))))
                call = reply.function_calls[0]
                test.assertEqual((call.name, call.args), ("read_logs", {}))
                contents.extend([reply.candidates[0].content, types.Content(role="user", parts=[types.Part.from_function_response(name=call.name, response={"result": read_logs()})])])
                config = types.GenerateContentConfig(response_mime_type="application/json", response_schema=Answer) if structured else types.GenerateContentConfig(cached_content="cachedContents/opaque-fixture")
            before = copy.deepcopy(contents)
            config_before = copy.deepcopy(config)
            chat_path = cell["method"].startswith("chats.")
            model = "fixture-structured" if structured else "fixture-cached" if cached else "fixture-loop"
            native = client.aio if asynchronous else client
            chat = with_caveman_google_chat(native.chats.create(model=model, config=config), runtime=runtime, scope=selected_scope, config=config) if chat_path else None
            events, result = [], None
            if cell["streaming"]:
                stream = await resolved(chat.send_message_stream(contents[0].parts) if chat else native.models.generate_content_stream(model=model, contents=contents, config=config))
                if asynchronous:
                    async for event in stream:
                        test.assertIsInstance(event, types.GenerateContentResponse)
                        events.append(event)
                        if cancelled and any(part.text == FACT for candidate in event.candidates or [] for part in candidate.content.parts or []):
                            pending = asyncio.create_task(anext(stream))
                            await asyncio.sleep(0.02)
                            test.assertFalse(pending.done())
                            pending.cancel()
                            with test.assertRaises(asyncio.CancelledError):
                                await pending
                            await stream.aclose()
                            break
                else:
                    for event in stream:
                        test.assertIsInstance(event, types.GenerateContentResponse)
                        events.append(event)
                        if cancelled and any(part.text == FACT for candidate in event.candidates or [] for part in candidate.content.parts or []):
                            stream.close()
                            break
                result = events[-1]
                final = "".join(part.text for event in events for candidate in event.candidates or [] for part in candidate.content.parts or [] if part.text)
                if cancelled:
                    test.assertFalse(provider.release.is_set())
                    test.assertTrue(await asyncio.to_thread(provider.peer_closed))
                    if mode == "compress":
                        test.assertEqual(runtime.receipts[-1]["event_kind"], "cancelled")
                        test.assertIsNone(runtime.receipts[-1]["usage"])
                retained = chat.get_history() if chat else result.automatic_function_calling_history
            else:
                result = await resolved(chat.send_message(contents[0].parts) if chat else native.models.generate_content(model=model, contents=contents, config=config))
                test.assertIsInstance(result, types.GenerateContentResponse)
                final = result.parsed.model_dump() if structured else result.text
                if structured:
                    test.assertIsInstance(result.parsed, Answer)
                retained = contents if model_only else chat.get_history() if chat else result.automatic_function_calling_history
            expected = {"answer": FACT} if structured else "native-cached" if cached else FACT
            test.assertEqual(final, expected)
            test.assertEqual(contents, before)
            test.assertEqual(config.model_dump(exclude={"http_options"}), config_before.model_dump(exclude={"http_options"}))
            test.assertEqual(source_calls, [{}])
            test.assertEqual(provider.errors, [])
            history = history_values(retained)
            test.assertEqual(history["read_logs"]["result"], SOURCE)
            test.assertEqual(len(provider.calls), 2 if model_only or mode != "compress" else 3)
            projected = values(provider.calls[1]["body"])["read_logs"]["result"]
            recovered = values(provider.calls[-1]["body"]).get("caveman_retrieve")
            if model_only or mode != "compress":
                test.assertEqual(projected, SOURCE)
                test.assertIsNone(recovered)
                test.assertTrue(all(not result.replacements for _, result in runtime.plans))
            else:
                test.assertNotIn(FACT, projected)
                test.assertIn("cmw_", projected)
                test.assertEqual(recovered["result"]["text"], SOURCE)
                test.assertTrue(any(result.replacements for _, result in runtime.plans))
            if cached:
                test.assertEqual(runtime.plans, [])
                test.assertTrue(provider.calls[-1]["body"]["cachedContent"].endswith("opaque-fixture"))
            if model_only:
                test.assertTrue(all(options["binding"] is None for options, _ in runtime.plans))
            if mode == "off":
                test.assertTrue(all(result.status == "off" for _, result in runtime.plans))
            if mode == "outage" and not cached:
                test.assertTrue(any(result.reason == "runtime_unavailable" for _, result in runtime.plans))
            expected_reports = len(provider.calls) - int(model_only)
            test.assertEqual(len(runtime.reports), expected_reports)
            test.assertEqual(len({report.attempt_id for report in runtime.reports}), expected_reports)
            test.assertTrue(all(report.adapter == "google-sdk" for report in runtime.reports))
            test.assertEqual(sum(report.replacement_count for report in runtime.reports), sum(len(plan.replacements) for _, plan in runtime.plans))
            if mode == "off":
                test.assertTrue(all(report.status == "disabled" and not report.transform_ids for report in runtime.reports))
            auth = []
            for call in provider.calls:
                headers = {key.lower(): value for key, value in call["headers"].items()}
                test.assertEqual(headers["x-original-option"], "preserved")
                test.assertEqual(headers.get("authorization") if vertex else headers.get("x-goog-api-key"), "Bearer local-fixture-oauth" if vertex else "local-google-token")
                auth.append("oauth_fixture" if vertex else "api_key_fixture")
            if not model_only:
                test.assertTrue(all(call["body"]["generationConfig"]["temperature"] == 0.2 for call in provider.calls))
                test.assertTrue(all(call["body"]["systemInstruction"]["parts"][0]["text"] == "Read exact logs." for call in provider.calls))
                test.assertEqual(provider.calls[1]["body"]["contents"][1]["parts"][0]["thoughtSignature"], "c2lnbmF0dXJl")
            return {"final_value": final, "native_type": type(result).__name__, "event_order": [event_kind(event) for event in events],
                "provider_calls": len(provider.calls), "source_executions": len(source_calls), "source_sha256": HASH, "stored_source_sha256": digest(history["read_logs"]["result"]),
                "optimize_invocations": len(runtime.plans), "native_call_reports": [report.status for report in runtime.reports],
                "recovery_requests": int(recovered is not None), "replacements": sum(len(result.replacements) for _, result in runtime.plans),
                "recovered_sha256": digest(recovered["result"]["text"]) if recovered else None, "request_sha256": digest(provider.calls[-1]["raw"]) if model_only else None,
                "native_input_sha256": digest([plain(content) for content in before]), "cancelled_before_fixture_eof": cancelled,
                "lifecycle_action": "native_task_cancel_then_aclose" if cancelled and asynchronous else "native_generator_close" if cancelled else "complete",
                "auth_modes": auth, "provider_paths": [call["path"] for call in provider.calls], "configured_vertex": vertex,
                "history_surface": "input_function_response" if model_only else "native_chat_history" if chat else "automatic_function_calling_history",
                "native_usage_headers": config.http_options.headers if config.http_options else None}
        finally:
            provider.release.set()
            await original.aio.aclose(); original.close()
            await client.aio.aclose(); client.close(); http.close(); await ahttp.aclose()
            runtime.close()


def emit(test, cell, journey):
    name = ".".join(test.id().split(".")[-2:])
    for assertion, observation in journey.items():
        print("CAVEMAN_MIDDLEWARE_OBSERVATION " + json.dumps({"cell_id": cell["id"], "test_id": FILE + "::" + name, "assertion": assertion, "observation": observation}, separators=(",", ":")), flush=True)


async def certify_cells(test, provider, execution):
    fixture = json.loads(Path(__file__).with_name("certification-cells.json").read_text())
    cells = [cell for cell in fixture["cells"] if cell["provider"] == provider and cell["execution"] == execution]
    test.assertEqual(len(cells), 8)
    for cell in cells:
        with test.subTest(cell=cell["id"]):
            rows = {mode: await run_case(test, cell, mode) for mode in ("compress", "off", "outage")}
            current, off, unavailable = rows["compress"], rows["off"], rows["outage"]
            test.assertEqual(current["final_value"], off["final_value"])
            test.assertEqual(current["final_value"], unavailable["final_value"])
            test.assertEqual(current["native_usage_headers"], off["native_usage_headers"])
            test.assertEqual(current["native_usage_headers"], unavailable["native_usage_headers"])
            if cell["recovery"] == "model_only":
                for baseline in (off, unavailable):
                    test.assertEqual(current["request_sha256"], baseline["request_sha256"])
                    test.assertEqual(current["event_order"], baseline["event_order"])
                no_recovery = {"outcome": "recovery_free", "reason": "opaque cached content" if cell["method"] == "cached_content.opaque" else "native structured-output contract", "recovery_requests": 0, "replacements": 0, "original_provider_source_sha256": HASH, "request_sha256": current["request_sha256"]}
            else:
                no_recovery = None
            baseline = lambda row: {"outcome": "observed", **{key: row[key] for key in ("final_value", "provider_calls", "optimize_invocations", "native_call_reports", "recovery_requests", "stored_source_sha256", "cancelled_before_fixture_eof", "lifecycle_action")}}
            journey = {
                "native_application": {"outcome": "observed", "method": cell["method"], "execution": execution, "provider": provider, "execution_owner": "application_source_dispatch" if no_recovery else "native_afc", "live_provider_auth_verified": False, "auth_modes": current["auth_modes"], "provider_paths": current["provider_paths"], "configured_vertex": current["configured_vertex"]},
                "real_tool_result": {"outcome": "observed", "executor": "read_logs", "executions": current["source_executions"], "sha256": HASH, "utf8_bytes": len(SOURCE.encode())},
                "transformed_provider_request": no_recovery or {"outcome": "observed", "replacement_count": current["replacements"], "omitted_fact_absent": True, "stored_source_sha256": current["stored_source_sha256"]},
                "omitted_fact_requested": no_recovery or {"outcome": "observed", "fact": FACT, "native_recovery_function": "caveman_retrieve", "recovery_requests": current["recovery_requests"]},
                "host_executes_exact_recovery": no_recovery or {"outcome": "observed", "execution_owner": "native_afc", "source_sha256": HASH, "recovered_sha256": current["recovered_sha256"]},
                "native_result_history_events_and_call_count": {"outcome": "observed", **{key: current[key] for key in ("native_type", "final_value", "event_order", "provider_calls", "native_call_reports", "stored_source_sha256", "native_input_sha256", "history_surface", "cancelled_before_fixture_eof", "lifecycle_action")}},
                "off_baseline": baseline(off), "optimizer_unavailable": baseline(unavailable),
            }
            emit(test, cell, journey)
