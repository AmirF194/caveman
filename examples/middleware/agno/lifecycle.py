"""Observe real Agno stream and HTTP response lifetimes on a gated socket."""
from __future__ import annotations

import asyncio
import inspect
import json
import time
import uuid

import anthropic
import openai
from agno.agent import Agent
from agno.models.anthropic import Claude
from agno.models.message import Message
from agno.models.openai import OpenAIChat
from agno.team import Team

from caveman_cloud.middleware import Scope
from caveman_middleware.agno import with_caveman_agent, with_caveman_model
from caveman_middleware._native import owner
from evidence_runtime import EvidenceRuntime


class LifecycleServer:
    """Keep completion gated and observe EOF from the SDK's actual socket."""

    def __init__(self, protocol):
        self.protocol = protocol
        self.calls = []
        self.errors = []
        self.peer_closed = asyncio.Event()
        self.release = asyncio.Event()
        self.handlers = set()

    async def __aenter__(self):
        self.server = await asyncio.start_server(self.handle, "127.0.0.1", 0)
        self.url = f"http://127.0.0.1:{self.server.sockets[0].getsockname()[1]}"
        return self

    def first_events(self, body):
        if self.protocol == "openai":
            chunk = {"id": "chatcmpl-lifecycle", "object": "chat.completion.chunk", "created": 1,
                     "model": body["model"], "choices": [{"index": 0, "delta": {"role": "assistant", "content": "native"}, "finish_reason": None}]}
            return ("data: " + json.dumps(chunk) + "\n\n").encode()
        message = {"id": "msg-lifecycle", "type": "message", "role": "assistant", "model": body["model"],
                   "content": [], "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 100, "output_tokens": 0}}
        events = [
            ("message_start", {"message": message}),
            ("content_block_start", {"index": 0, "content_block": {"type": "text", "text": ""}}),
            ("content_block_delta", {"index": 0, "delta": {"type": "text_delta", "text": "native"}}),
        ]
        return "".join("event: " + kind + "\ndata: " + json.dumps({"type": kind, **fields}) + "\n\n" for kind, fields in events).encode()

    async def handle(self, reader, writer):
        task = asyncio.current_task()
        self.handlers.add(task)
        waiting = []
        try:
            header = await reader.readuntil(b"\r\n\r\n")
            length = next(int(line.partition(b":")[2]) for line in header.split(b"\r\n") if line.lower().startswith(b"content-length:"))
            body = json.loads(await reader.readexactly(length))
            assert body["stream"] is True
            self.calls.append(body)
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n" + self.first_events(body))
            await writer.drain()
            peer = asyncio.create_task(reader.read(1))
            released = asyncio.create_task(self.release.wait())
            waiting = [peer, released]
            done, _ = await asyncio.wait(waiting, return_when=asyncio.FIRST_COMPLETED)
            if peer in done and peer.result() == b"":
                self.peer_closed.set()
        except (ConnectionError, asyncio.IncompleteReadError):
            self.peer_closed.set()
        except BaseException as error:
            self.errors.append({"type": type(error).__name__, "message": str(error)})
        finally:
            for pending in waiting:
                if not pending.done():
                    pending.cancel()
            if waiting:
                await asyncio.gather(*waiting, return_exceptions=True)
            writer.close()
            await writer.wait_closed()
            self.handlers.discard(task)

    async def __aexit__(self, *_):
        self.release.set()
        self.server.close()
        await self.server.wait_closed()
        if self.handlers:
            await asyncio.gather(*self.handlers)


async def observe_lifecycle(protocol, variant, action, surface, *, endpoint, close_timeout=0.5):
    """No scheduler/transport replacement; the client response hook is read-only."""
    responses = []

    async def observed(response):
        responses.append(response)

    provider = openai if protocol == "openai" else anthropic
    client_type = provider.AsyncOpenAI if protocol == "openai" else provider.AsyncAnthropic
    async with LifecycleServer(protocol) as server, client_type(
        api_key="fixture-provider-key", base_url=server.url + ("/v1" if protocol == "openai" else ""),
        max_retries=0, timeout=3, http_client=provider.DefaultAsyncHttpxClient(event_hooks={"response": [observed]}),
    ) as client:
        native = (OpenAIChat(id="gpt-lifecycle", async_client=client) if protocol == "openai" else
                  Claude(id="claude-sonnet-4-6", async_client=client, cache_system_prompt=False))
        with EvidenceRuntime(endpoint=endpoint) as runtime:
            scope = Scope("agno-lifecycle", str(uuid.uuid4()))
            if surface == "model":
                selected = native if variant == "baseline" else with_caveman_model(native, runtime=runtime, scope=scope)
                stream = selected.aresponse_stream([Message(role="user", content="Return native")])
            else:
                options = {"model": native, "telemetry": False, "session_id": scope.session_id}
                if surface == "team":
                    options["members"] = []
                if variant == "middleware":
                    options = with_caveman_agent(options, runtime=runtime, scope=scope)
                agent = (Team if surface == "team" else Agent)(**options)
                stream = agent.arun("Return native", stream=True, stream_events=True)
            pending = None
            cancellation_result = None
            try:
                async for event in stream:
                    if getattr(event, "content", None):
                        assert event.content == "native"
                        break
                assert len(server.calls) == 1 and len(responses) == 1
                assert not responses[0].is_closed and not server.peer_closed.is_set()
                if action == "task_cancel":
                    entered = asyncio.Event()

                    async def read_remaining():
                        entered.set()
                        events = []
                        async for following in stream:
                            events.append(getattr(following, "event", type(following).__name__))
                        return events

                    pending = asyncio.create_task(read_remaining())
                    await entered.wait()
                    # Enter the native SDK's next read before cancelling its task.
                    await asyncio.sleep(0)
                    assert not pending.done()
                    pending.cancel()
                    try:
                        cancellation_events = await pending
                    except asyncio.CancelledError:
                        cancellation_result = "CancelledError"
                    except StopAsyncIteration:
                        cancellation_result = "StopAsyncIteration"
                    else:
                        cancellation_result = cancellation_events[-1] if cancellation_events else "StopAsyncIteration"
                else:
                    await stream.aclose()
                started = time.monotonic()
                try:
                    await asyncio.wait_for(server.peer_closed.wait(), timeout=close_timeout)
                except TimeoutError:
                    pass
                result = {"protocol": protocol, "variant": variant, "action": action, "surface": surface,
                          "provider_calls": len(server.calls), "stream_closed": inspect.getasyncgenstate(stream) == inspect.AGEN_CLOSED,
                          "cancellation_result": cancellation_result,
                          "response_closed_before_client_close": responses[0].is_closed,
                          "peer_closed_before_client_close": server.peer_closed.is_set(),
                          "close_observation_ms": round((time.monotonic() - started) * 1000, 3),
                          "terminal_receipts": [r["event_kind"] for r in runtime.receipts if r["event_kind"] != "dispatch_intent"],
                          "receipt_usage": [r["usage"] for r in runtime.receipts if r["event_kind"] != "dispatch_intent"],
                          "owner_clear": owner.get() is None, "server_errors": server.errors.copy()}
            finally:
                if pending and not pending.done():
                    pending.cancel()
                    await asyncio.gather(pending, return_exceptions=True)
                await stream.aclose()
                await client.close()
                await asyncio.wait_for(server.peer_closed.wait(), timeout=3)
            result["response_closed_after_client_close"] = responses[0].is_closed
            result["peer_closed_after_client_close"] = server.peer_closed.is_set()
            return result
