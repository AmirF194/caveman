"""Real installed MCP server used only by local transport conformance tests."""
import asyncio
import json
import sys

from mcp.server.mcpserver import Context, MCPServer
from mcp.types import (Annotations, AudioContent, CallToolResult, EmbeddedResource,
                       ImageContent, ResourceLink, TextContent, TextResourceContents)

SOURCE = "".join(f"[INFO] café 🌍 row {i} retained-detail-{i} long repeated diagnostic\r\n" for i in range(140))
PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGZkAAAAASUVORK5CYII="
server = MCPServer("native-mcp-fixture", version="1.0.0")


@server.tool(structured_output=False, description="Read the diagnostic source.")
def read_logs(path: str = "fixture/diagnostics.log") -> CallToolResult:
    assert path == "fixture/diagnostics.log"
    return CallToolResult(content=[TextContent(type="text", text=SOURCE,
                          annotations=Annotations(audience=["assistant"], priority=0.5),
                          meta={"source": "diagnostics.log"})], meta={"native": "retained"})


@server.tool(structured_output=False)
def mixed() -> CallToolResult:
    return CallToolResult(content=[
        TextContent(type="text", text=SOURCE, annotations=Annotations(audience=["assistant"])),
        ImageContent(type="image", data=PNG, mime_type="image/png", meta={"native": 1}),
        AudioContent(type="audio", data="AAAA", mime_type="audio/wav"),
        EmbeddedResource(type="resource", resource=TextResourceContents(uri="file:///source.txt", text=SOURCE, mime_type="text/plain")),
        ResourceLink(type="resource_link", name="source", uri="https://example.invalid/source", description="Native link"),
        TextContent(type="text", text=SOURCE, annotations=Annotations(audience=["user"], priority=1)),
    ], meta={"native": {"order": [0, 1, 2, 3, 4, 5]}})


@server.tool()
def structured() -> dict[str, str]:
    return {"source": SOURCE}


@server.tool(structured_output=False)
def mixed_structured() -> CallToolResult:
    return CallToolResult(content=[TextContent(type="text", text=SOURCE),
        TextContent(type="text", text="protected explanation", annotations=Annotations(audience=["assistant"]))],
        structured_content={"answer": "retained-detail-70"}, meta={"native": "mixed-structured"})


@server.tool(structured_output=False)
def failure() -> CallToolResult:
    return CallToolResult(content=[TextContent(type="text", text=SOURCE)], is_error=True)


@server.tool(structured_output=False)
async def wait_forever(ctx: Context) -> str:
    await ctx.report_progress(1, 2, "native-started")
    await asyncio.Event().wait()
    return "unreachable"


class CaptureHTTP:
    def __init__(self, app, path):
        self.app, self.path = app, path

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        if scope["path"] == "/ready":
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b"ready"})
            return
        headers = {key.decode(): value.decode() for key, value in scope["headers"]}
        if headers.get("authorization") != "Bearer fixture-mcp-token":
            await send({"type": "http.response.start", "status": 401, "headers": []})
            await send({"type": "http.response.body", "body": b"unauthorized"})
            return
        body = bytearray()
        async def capture():
            message = await receive()
            body.extend(message.get("body", b""))
            if message["type"] == "http.request" and not message.get("more_body", False):
                with open(self.path, "a") as output:
                    output.write(json.dumps({"headers": headers, "body": json.loads(body) if body else None}) + "\n")
            return message
        await self.app(scope, capture, send)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "http":
        import uvicorn
        app = CaptureHTTP(server.streamable_http_app(), sys.argv[3])
        uvicorn.run(app, host="127.0.0.1", port=int(sys.argv[2]), log_level="error")
    else:
        server.run(transport="stdio")
