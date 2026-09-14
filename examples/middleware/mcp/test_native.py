"""Installed MCP transports, native provider loops, and real Engine recovery."""
import asyncio
import copy
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import unittest
import uuid

import anthropic
import openai
from mcp import Client, StdioServerParameters
from mcp.types import CallToolResult, TextContent

from caveman_cloud.middleware import AsyncMiddlewareRuntime, Scope, sha256
from caveman_middleware.mcp import CavemanMCPHost, MCPToolBinding, bind_mcp_tool
from caveman_middleware._native import owner
from python_fixture import ProviderServer, restart_runtime
from _client import native_client
from _server import SOURCE
from example import run_text_host

spec = importlib.util.spec_from_file_location("mcp_provider_fixture", Path(__file__).parents[1] / "pydantic-ai/_fixture.py")
fixture_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture_module)
Fixture = fixture_module.Fixture
ENDPOINT = os.environ["CAVEMAN_MIDDLEWARE_ENDPOINT"]


def scope(**kwargs):
    return Scope(namespace="mcp-" + str(uuid.uuid4()), session_id="native-session", branch_id="main", **kwargs)


def manifest(result):
    return [{"id": "original-result", "sha256": sha256(result.model_dump_json(by_alias=True))}]


def host_for(client, runtime, *, selected_scope=None):
    return CavemanMCPHost(runtime=runtime, scope=selected_scope or scope(), server_id="native-fixture",
                          protocol_version=client.protocol_version)


async def setup(client, runtime, *, selected_scope=None):
    bindings = [bind_mcp_tool(client, tool) for tool in (await client.list_tools()).tools]
    host = host_for(client, runtime, selected_scope=selected_scope)
    return host, bindings


class NativeMCP(unittest.IsolatedAsyncioTestCase):
    async def test_certifies_exact_f13_native_operations(self):
        from _certification_native import certify_cells
        await certify_cells(self)

    async def test_provider_tool_loops_stdio_http_openai_anthropic_and_streams(self):
        for transport in ("stdio", "http"):
            for protocol in ("openai", "anthropic"):
                for stream in (False, True):
                    with self.subTest(transport=transport, protocol=protocol, stream=stream):
                        async with native_client(transport) as (mcp, rows), AsyncMiddlewareRuntime(endpoint=ENDPOINT) as runtime:
                            negotiated = mcp.protocol_version
                            host, bindings = await setup(mcp, runtime)
                            fixture = Fixture(protocol)
                            with ProviderServer(fixture) as server:
                                provider = (openai.AsyncOpenAI(api_key="fixture", base_url=server.url + "/v1", max_retries=0)
                                            if protocol == "openai" else anthropic.AsyncAnthropic(api_key="fixture", base_url=server.url, max_retries=0))
                                chunks = []
                                async def first(text):
                                    if not chunks:
                                        self.assertFalse(fixture.finished)
                                    chunks.append(text)
                                    fixture.release.set()
                                try:
                                    final, history, originals = await run_text_host(client=provider, model="native-fixture", protocol=protocol,
                                        host=host, tools=bindings, prompt="Find retained-detail-70", stream=stream, on_text=first)
                                finally:
                                    await provider.close()
                                self.assertEqual(final, "retained-detail-70")
                                self.assertEqual(len(fixture.calls), 3)
                                self.assertEqual([name for name, _, _ in originals], ["read_logs", "caveman_retrieve"])
                                self.assertEqual(originals[0][2].content[0].text.encode(), SOURCE.encode())
                                page = json.loads(originals[1][2].content[0].text)
                                self.assertEqual(page["text"].encode(), SOURCE.encode())
                                self.assertTrue(page["complete"])
                                self.assertIn(SOURCE, json.dumps(history, ensure_ascii=False).replace("\\r\\n", "\r\n"))
                                self.assertTrue(all(req.headers["x-native-option"] == "preserved" for req, _ in fixture.calls))
                                self.assertEqual(fixture.calls[0][1]["tools"], fixture.calls[-1][1]["tools"])
                                self.assertFalse(server.errors, server.errors)
                                if stream:
                                    self.assertEqual("".join(chunks), final)
                        if transport == "http":
                            calls = [row for row in rows if row["body"] and row["body"].get("method") == "tools/call"]
                            self.assertEqual(len(calls), 1, "recovery executes locally through scoped Engine recovery")
                            self.assertEqual(calls[0]["body"]["params"]["name"], "read_logs")
                            self.assertIn("id", calls[0]["body"])
                            self.assertEqual(calls[0]["headers"]["x-native-mcp"], "preserved")
                            self.assertEqual(calls[0]["headers"]["mcp-protocol-version"], negotiated)

    async def test_mixed_resources_annotations_media_and_native_errors(self):
        for transport in ("stdio", "http"):
            async with native_client(transport) as (client, _), AsyncMiddlewareRuntime(endpoint=ENDPOINT) as runtime:
                host, bindings = await setup(client, runtime)
                registered = host.register(bindings)
                history = []
                for binding in bindings:
                    if binding.tool.name == "wait_forever":
                        continue
                    original = await binding.execute({})
                    history.append({"id": "result-" + binding.tool.name, "sha256": sha256(original.model_dump_json(by_alias=True))})
                    before = original.model_dump_json(by_alias=True)
                    view = await host.project_result(original, tool=binding.tool, call_id="call-" + binding.tool.name,
                                    context_manifest=history, registered_tools=registered)
                    self.assertEqual(original.model_dump_json(by_alias=True), before)
                    self.assertEqual(view.meta, original.meta)
                    self.assertEqual(view.is_error, original.is_error)
                    if binding.tool.name in ("structured", "mixed_structured", "failure"):
                        self.assertIs(view, original)
                    else:
                        self.assertNotEqual(view.content[0].text, SOURCE)
                        self.assertEqual(view.content[0].annotations, original.content[0].annotations)
                        self.assertEqual(view.content[0].meta, original.content[0].meta)
                    if binding.tool.name == "mixed":
                        self.assertEqual(len(view.content), 6)
                        for i in range(1, 6):
                            self.assertIs(view.content[i], original.content[i])

    async def test_off_record_outage_fake_collision_and_mutated_definition(self):
        async with native_client("stdio") as (client, _):
            tool = (await client.list_tools()).tools[0]
            result = await client.call_tool(tool.name, {})
            for mode, endpoint in (("off", ENDPOINT), ("record", ENDPOINT), ("compress", "http://127.0.0.1:1")):
                async with AsyncMiddlewareRuntime(endpoint=endpoint, mode=mode) as runtime:
                    host = host_for(client, runtime)
                    view = await host.project_result(result, tool=tool, call_id="call", context_manifest=manifest(result), registered_tools=host.register([]))
                    self.assertIs(view, result)
                    if mode != "compress":
                        self.assertEqual(host.register([]), [])
            for variant in ("schema-only", "collision", "other-scope", "mutated", "filtered"):
                async with AsyncMiddlewareRuntime(endpoint=ENDPOINT) as runtime:
                    host = host_for(client, runtime)
                    fake = MCPToolBinding(host.recovery.tool.model_copy(deep=True), lambda _: None)
                    registered = ([fake] if variant == "schema-only" else host.register([fake]) if variant == "collision" else
                                  [host_for(client, runtime).recovery] if variant == "other-scope" else
                                  [] if variant == "filtered" else [host.recovery])
                    if variant == "mutated":
                        host.recovery.tool.name = "different_recovery_name"
                    view = await host.project_result(result, tool=tool, call_id="call", context_manifest=manifest(result), registered_tools=registered)
                    self.assertEqual(view.content[0].text, SOURCE, variant)
            async with AsyncMiddlewareRuntime(endpoint=ENDPOINT) as runtime:
                host = host_for(client, runtime)
                explicit_null = result.model_copy(update={"structured_content": None})
                self.assertIs(await host.project_result(explicit_null, tool=tool, call_id="call", context_manifest=manifest(result),
                              registered_tools=[host.recovery]), explicit_null)
                token = owner.set(object())
                try:
                    self.assertIs(await host.project_result(result, tool=tool, call_id="call", context_manifest=manifest(result),
                                  registered_tools=[host.recovery]), result)
                finally:
                    owner.reset(token)

    async def test_twenty_turn_resume_native_serialization_and_scoped_recovery(self):
        async with native_client("stdio") as (client, _), AsyncMiddlewareRuntime(endpoint=ENDPOINT) as runtime:
            selected = scope()
            host, bindings = await setup(client, runtime, selected_scope=selected)
            tool = bindings[0].tool
            original = await bindings[0].execute({})
            saved = original.model_dump_json(by_alias=True, exclude_unset=True)
            history = manifest(original)
            first = None
            for turn in range(20):
                if turn in (5, 15):
                    await asyncio.to_thread(restart_runtime)
                    host = host_for(client, runtime, selected_scope=selected)
                restored = CallToolResult.model_validate_json(saved)
                view = await host.project_result(restored, tool=tool, call_id="stable-call", context_manifest=history,
                                  registered_tools=host.register(bindings))
                encoded = view.model_dump_json(by_alias=True)
                if first is None:
                    first = encoded
                self.assertEqual(encoded, first)
                self.assertEqual(restored.model_dump_json(by_alias=True, exclude_unset=True), saved)
                history.append({"id": "turn-" + str(turn), "sha256": sha256("native continuation " + str(turn))})
            handle = re.search(r"cmw_[a-f0-9]{48}", view.content[0].text)[0]
            page = await host.recovery.execute({"handle": handle})
            self.assertEqual(json.loads(page.content[0].text)["text"].encode(), SOURCE.encode())
            with self.assertRaises(Exception):
                await host_for(client, runtime).recovery.execute({"handle": handle})

    async def test_native_tool_cancellation_and_options(self):
        for transport in ("stdio", "http"):
            async with native_client(transport) as (client, _):
                tools = {tool.name: tool for tool in (await client.list_tools()).tools}
                started = asyncio.Event()
                async def progress(*args):
                    started.set()
                binding = bind_mcp_tool(client, tools["wait_forever"])
                task = asyncio.create_task(binding.execute({}, progress_callback=progress, read_timeout_seconds=2, meta={"native-option": "retained"}))
                await asyncio.wait_for(started.wait(), 2)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
                result = await bind_mcp_tool(client, tools["read_logs"]).execute({})
                self.assertEqual(result.content[0].text, SOURCE)

    async def test_native_provider_loops_off_record_and_outage(self):
        for transport in ("stdio", "http"):
            async with native_client(transport) as (mcp, _):
                for mode in ("off", "record", "outage"):
                    for protocol in ("openai", "anthropic"):
                        async with AsyncMiddlewareRuntime(endpoint="http://127.0.0.1:1" if mode == "outage" else ENDPOINT,
                                  mode="compress" if mode == "outage" else mode) as runtime:
                            host, bindings = await setup(mcp, runtime)
                            fixture = Fixture(protocol)
                            with ProviderServer(fixture) as server:
                                provider = (openai.AsyncOpenAI(api_key="fixture", base_url=server.url + "/v1", max_retries=0)
                                            if protocol == "openai" else anthropic.AsyncAnthropic(api_key="fixture", base_url=server.url, max_retries=0))
                                try:
                                    final, _, originals = await run_text_host(client=provider, model="native-fixture", protocol=protocol,
                                        host=host, tools=bindings, prompt="Find retained-detail-70")
                                finally:
                                    await provider.close()
                                self.assertEqual(final, "retained-detail-70")
                                self.assertEqual(len(fixture.calls), 2)
                                self.assertEqual(len(originals), 1)
                                self.assertEqual(originals[0][2].content[0].text, SOURCE)
                                self.assertFalse(server.errors)

    async def test_one_hundred_interleaved_native_host_scopes(self):
        async with native_client("stdio") as (client, _), AsyncMiddlewareRuntime(endpoint=ENDPOINT) as runtime:
            tool = (await client.list_tools()).tools[0]
            result = await client.call_tool(tool.name, {})
            limit = asyncio.Semaphore(4)
            async def run_one(_):
                async with limit:
                    host = host_for(client, runtime)
                    view = await host.project_result(result, tool=tool, call_id="call", context_manifest=manifest(result), registered_tools=[host.recovery])
                    handle = re.search(r"cmw_[a-f0-9]{48}", view.content[0].text)
                    self.assertIsNotNone(handle)
                    page = await host.recovery.execute({"handle": handle[0]})
                    self.assertEqual(json.loads(page.content[0].text)["text"], SOURCE)
                    return handle[0]
            handles = await asyncio.gather(*(run_one(i) for i in range(100)))
            self.assertEqual(len(set(handles)), 100)

    async def test_existing_caveman_engine_server_interoperation(self):
        binary = os.environ.get("CAVEMAN_MCP_TEST_BINARY")
        self.assertTrue(binary, "Set a freshly built existing Caveman MCP server")
        async with Client(StdioServerParameters(command=binary, env={**os.environ, "CAVEMAN_MCP_EPHEMERAL": "1"})) as client:
            async with AsyncMiddlewareRuntime(endpoint=ENDPOINT) as runtime:
                host, bindings = await setup(client, runtime)
                names = [binding.tool.name for binding in bindings]
                self.assertIn("caveman_compress", names)
                self.assertIn("caveman_retrieve", names)
                self.assertEqual(host.register(bindings), bindings, "keep the existing server's recovery tool on collision")
                binding = next(binding for binding in bindings if binding.tool.name == "caveman_compress")
                result = await binding.execute({"input": SOURCE})
                self.assertFalse(result.is_error)
                view = await host.project_result(result, tool=binding.tool, call_id="engine", context_manifest=manifest(result), registered_tools=bindings)
                self.assertIs(view, result)


if __name__ == "__main__":
    from _test_result import ReportingResult
    unittest.main(testRunner=unittest.TextTestRunner(resultclass=ReportingResult))
