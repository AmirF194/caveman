"""Compare native AutoGen stream finalization with and without middleware.

Only local fixture HTTP is used. A known upstream httpcore2 finalizer warning
is reported as evidence rather than presented as successful cleanup.
"""
import asyncio
import json
import os

os.environ.setdefault("CAVEMAN_MIDDLEWARE_ENDPOINT", "http://127.0.0.1:1")

from test_native import CaptureHTTPClient, Provider, UserMessage
from caveman_cloud.middleware import MiddlewareRuntime, Scope
from caveman_middleware.autogen import with_caveman_model


def probe(wrapped):
    result = {"wrapped": wrapped, "finalization_errors": []}

    async def execute():
        def observe(loop, context):
            error = context.get("exception")
            result["finalization_errors"].append({"type": type(error).__name__, "message": str(error)})

        asyncio.get_running_loop().set_exception_handler(observe)
        with Provider() as server, MiddlewareRuntime(endpoint=os.environ["CAVEMAN_MIDDLEWARE_ENDPOINT"]) as runtime:
            transport = CaptureHTTPClient()
            client = server.model(http_client=transport)
            if wrapped:
                client = with_caveman_model(client, runtime=runtime, scope=Scope("autogen", "lifecycle-probe"))
            stream = client.create_stream([UserMessage(content="plain", source="user")])
            result["first_event"] = await anext(stream)
            pending = asyncio.create_task(anext(stream))
            await asyncio.sleep(0)
            pending.cancel()
            try:
                await pending
            except asyncio.CancelledError:
                result["cancelled"] = True
            await stream.aclose()
            result["iterator_closed"] = stream.ag_frame is None
            server.release.set()
            await client.close()
            result["transport_closed"] = transport.is_closed
            result["provider_calls"] = len(server.calls)
            result["provider_errors"] = server.errors

    asyncio.run(execute())
    return result


if __name__ == "__main__":
    results = [probe(False), probe(True)]
    print(json.dumps(results, indent=2))
    for result in results:
        assert result["cancelled"] and result["iterator_closed"] and result["transport_closed"]
        assert result["provider_calls"] == 1 and not result["provider_errors"]
        assert all(error == {"type": "RuntimeError", "message": "generator didn't stop after athrow()"}
                   for error in result["finalization_errors"]), "Unexpected native lifecycle failure"
