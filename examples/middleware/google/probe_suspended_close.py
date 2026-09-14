"""Measure suspended async generator close separately from client cleanup."""
import asyncio
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path

import httpx
from google import genai
from google.genai import types
from google.oauth2.credentials import Credentials
from caveman_cloud.middleware import MiddlewareRuntime, Scope
from caveman_middleware.google import CavemanGoogleAsyncTransport, with_caveman_google
from _certification_fixture import Provider, SOURCE, FACT


async def observed_case(provider_name, mode, repetition):
    with Provider(cancel=True) as provider:
        runtime = MiddlewareRuntime(endpoint="http://127.0.0.1:1" if mode == "outage" else os.environ["CAVEMAN_MIDDLEWARE_ENDPOINT"], mode="off" if mode in ("native", "off") else "compress", deadline_ms=200 if mode == "outage" else 3000)
        scope = Scope("google-suspended-close", f"{provider_name}-{mode}-{repetition}")
        if mode == "compress":
            await runtime.as_async().ready()
        transport = httpx.AsyncHTTPTransport() if mode == "native" else CavemanGoogleAsyncTransport(runtime=runtime, scope=scope, provider_base_url=provider.url)
        http = httpx.AsyncClient(transport=transport)
        options = {"vertexai": True, "project": "fixture-project", "location": "europe-west4", "credentials": Credentials(token="local-fixture-oauth")} if provider_name == "vertex" else {"api_key": "local-google-token"}
        client = genai.Client(**options, http_options=types.HttpOptions(base_url=provider.url, httpx_async_client=http, retry_options=types.HttpRetryOptions(attempts=1)))
        if mode != "native":
            with_caveman_google(client, runtime=runtime, scope=scope)
        calls = []
        def read_logs() -> str:
            """Read diagnostic logs."""
            calls.append({})
            return SOURCE
        try:
            stream = await client.aio.models.generate_content_stream(model="fixture-loop", contents="Find retained-detail-80.", config=types.GenerateContentConfig(tools=[read_logs]))
            found = False
            async for event in stream:
                if any(part.text == FACT for candidate in event.candidates or [] for part in candidate.content.parts or []):
                    found = True
                    break
            assert found and calls == [{}]
            assert len(provider.calls) == (3 if mode == "compress" else 2)
            await stream.aclose()
            after_stream_close = await asyncio.to_thread(provider.peer_closed)
            assert not provider.release.is_set()
            await client.aio.aclose()
            after_client_close = await asyncio.to_thread(provider.peer_closed)
            await http.aclose()
            after_http_close = await asyncio.to_thread(provider.peer_closed)
            assert after_http_close and not provider.release.is_set(), (provider_name, mode, after_stream_close, after_client_close, after_http_close)
            assert provider.errors == []
            return {"provider": provider_name, "mode": mode, "repetition": repetition, "provider_calls": len(provider.calls),
                "source_executions": len(calls), "native_stream_aclose": True,
                "socket_eof_after_stream_aclose_before_client_close": after_stream_close,
                "socket_eof_after_native_client_aclose_before_fixture_eof": after_client_close,
                "socket_eof_after_application_http_client_aclose_before_fixture_eof": after_http_close,
                "live_provider_auth_verified": False}
        finally:
            provider.release.set()
            await client.aio.aclose(); client.close(); await http.aclose(); runtime.close()


async def main():
    rows = [await observed_case(provider, mode, repetition) for repetition in range(3) for provider in ("google", "vertex") for mode in ("native", "off", "compress", "outage")]
    root = Path(__file__).resolve().parents[3]
    sources = [Path(__file__), Path(__file__).with_name("_certification_fixture.py"), root / "packages/middleware/python/caveman_middleware/google.py", root / "examples/middleware/python-provider-sdks/requirements.lock"]
    report = {"evidence_class": "installed_native_sdk_local_lifecycle_observation", "versions": {name: importlib.metadata.version(name) for name in ("google-genai", "google-auth", "httpx")},
        "runtime_sha256": hashlib.sha256(Path(os.environ["CAVEMAN_MIDDLEWARE_TEST_BINARY"]).read_bytes()).hexdigest(),
        "source_hashes": {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest() for path in sources},
        "external_inference_requests": 0, "observations": rows}
    Path(__file__).with_name("lifecycle-evidence.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"cases": len(rows), "native_or_off_stream_only_eof": sum(row["socket_eof_after_stream_aclose_before_client_close"] for row in rows if row["mode"] in ("native", "off")),
        "wrapped_active_stream_only_eof": sum(row["socket_eof_after_stream_aclose_before_client_close"] for row in rows if row["mode"] in ("compress", "outage")),
        "all_native_client_close_eof": all(row["socket_eof_after_native_client_aclose_before_fixture_eof"] for row in rows),
        "all_application_http_client_close_eof": all(row["socket_eof_after_application_http_client_aclose_before_fixture_eof"] for row in rows)}))


if __name__ == "__main__":
    asyncio.run(main())
