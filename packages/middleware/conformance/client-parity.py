"""Run real sync/async Python clients against the same durable choices as TS."""
import asyncio
import json
import sys
from pathlib import Path

from caveman_cloud.middleware import Adapter, AsyncMiddlewareRuntime, Candidate, MiddlewareError, MiddlewareRuntime, Scope, sha256


data = json.loads(Path(sys.argv[1]).read_text())
scope = Scope(**data["scope"])
options = dict(scope=scope, adapter=Adapter(**data["adapter"]), candidates=[Candidate(**data["candidate"])], manifest=data["manifest"])

with MiddlewareRuntime(endpoint=data["endpoint"]) as runtime:
    runtime.ready()
    choice = runtime.optimize(**options, binding=runtime.recovery(scope))
    assert choice.status == "optimized", choice.reason
    assert choice.replacements[0]["text"] == data["replacement"]
    assert choice.replacements[0]["reused"] is True
    assert choice.plan["measurement"]["unique_tokens_reduced"] == 0
    assert runtime.retrieve(scope, handle=choice.replacements[0]["recovery_handle"])["text"] == data["candidate"]["content"]
    try:
        runtime.retrieve(Scope("other", scope.session_id), handle=choice.replacements[0]["recovery_handle"])
        raise AssertionError("cross namespace recovery accepted")
    except MiddlewareError as error:
        assert error.code == "not_found", error.code


async def run():
    async with AsyncMiddlewareRuntime(endpoint=data["endpoint"]) as runtime:
        await runtime.ready()
        choice = await runtime.optimize(**options, binding=runtime.recovery(scope))
        assert choice.status == "optimized", choice.reason
        assert choice.replacements[0]["text"] == data["replacement"]
        pieces, offset = [], 0
        while True:
            page = await runtime.retrieve(scope, handle=choice.replacements[0]["recovery_handle"], offset=offset, limit=73)
            assert page["source_id"] == data["candidate"]["source_id"]
            pieces.append(page["text"])
            if page["next_offset"] is None:
                break
            assert page["complete"] is False
            offset = page["next_offset"]
        assert "".join(pieces) == data["candidate"]["content"]
        return {"status": "passed", "evidence": "local_runtime", "languages": ["typescript", "python_sync", "python_async"],
                "original_sha256": sha256("".join(pieces)), "replacement_sha256": choice.replacements[0]["sha256"], "pages": len(pieces)}


print(json.dumps(asyncio.run(run())))
