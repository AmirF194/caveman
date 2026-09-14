"""Native transport setup; no Caveman behavior in this fixture helper."""
import asyncio
from contextlib import asynccontextmanager
import json
import os
from pathlib import Path
import socket
import sys
import tempfile

import httpx2
from mcp import Client, StdioServerParameters
from mcp.client.streamable_http import streamable_http_client

SERVER = Path(__file__).with_name("_server.py")


@asynccontextmanager
async def native_client(transport, *, engine=False):
    if transport == "stdio":
        parameters = (StdioServerParameters(command=os.environ["CAVEMAN_MCP_TEST_BINARY"], env={"CAVEMAN_MCP_EPHEMERAL": "1"})
                      if engine else StdioServerParameters(command=sys.executable, args=[str(SERVER)]))
        async with Client(parameters) as client:
            yield client, []
        return
    if engine:
        raise ValueError("The existing Caveman MCP binary exposes stdio")
    with tempfile.TemporaryDirectory(prefix="mcp-http-") as directory:
        capture = Path(directory) / "requests.jsonl"
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        child = await asyncio.create_subprocess_exec(sys.executable, str(SERVER), "http", str(port), str(capture),
                         stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
        rows = []
        try:
            async with httpx2.AsyncClient(headers={"authorization": "Bearer fixture-mcp-token", "x-native-mcp": "preserved"}) as http:
                for _ in range(100):
                    if child.returncode is not None:
                        raise RuntimeError((await child.stderr.read()).decode())
                    try:
                        if (await http.get(f"http://127.0.0.1:{port}/ready")).status_code == 200:
                            break
                    except httpx2.ConnectError:
                        await asyncio.sleep(0.02)
                else:
                    raise RuntimeError("native MCP HTTP fixture did not start")
                async with Client(streamable_http_client(f"http://127.0.0.1:{port}/mcp", http_client=http)) as client:
                    yield client, rows
                rows.extend(json.loads(line) for line in capture.read_text().splitlines())
        finally:
            if child.returncode is None:
                child.terminate()
            await asyncio.wait_for(child.communicate(), 5)
