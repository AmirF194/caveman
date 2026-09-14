"""Existing clients and complete loops; all inference stays on local fixtures."""
import asyncio
import json
import os

import anthropic
import openai
import httpx2
from caveman_cloud.middleware import AsyncMiddlewareRuntime, Scope
from caveman_middleware.openai import with_caveman_openai, with_caveman_openai_tools, CavemanAsyncOpenAITransport
from caveman_middleware.anthropic import with_caveman_anthropic
from _http_fixture import Provider, SOURCE, FACT, definitions, history


class ReadLogs(anthropic.lib.tools.BetaAsyncBuiltinFunctionTool):
    def to_dict(self):
        return definitions("anthropic-messages")[0]

    async def call(self, input):
        return SOURCE


async def main():
    async with AsyncMiddlewareRuntime(endpoint=os.environ["CAVEMAN_MIDDLEWARE_ENDPOINT"], deadline_ms=1000) as runtime:
        await runtime.ready()
        for protocol in ("openai-chat", "openai-responses"):
            with Provider(protocol) as provider:
                transport = CavemanAsyncOpenAITransport(httpx2.AsyncHTTPTransport())
                http_client = openai.DefaultAsyncHttpxClient(transport=transport)
                async with openai.AsyncOpenAI(api_key="local-fixture", base_url=provider.url + "/v1", max_retries=0, http_client=http_client) as existing_client:
                    scope = Scope("provider-example", protocol)
                    client = with_caveman_openai(existing_client, runtime=runtime, scope=scope, transport=transport)
                    api = client.chat.completions if protocol == "openai-chat" else client.responses
                    content_key = "messages" if protocol == "openai-chat" else "input"
                    # Perform the application's original auth/content guards first.
                    raw = await api.with_raw_response.create(model="helpers", **{content_key: history(protocol)})
                    assert raw.status_code == 200

                    async def read_logs(arguments):
                        return SOURCE
                    loop = with_caveman_openai_tools(existing_client, runtime=runtime, scope=scope, protocol=protocol, transport=transport,
                        tools=definitions(protocol), functions={"read_logs": read_logs})
                    api = loop.client.chat.completions if protocol == "openai-chat" else loop.client.responses
                    messages = [{"role": "user", "content": "Read source and recover row 70"}]
                    final = None
                    # The application owns this scheduler and dispatches every function.
                    for _ in range(5):
                        response = await api.create(model="loop", tools=loop.tools, **{content_key: messages})
                        if protocol == "openai-chat":
                            message = response.choices[0].message
                            calls = [(call.id, call.function.name, call.function.arguments) for call in message.tool_calls or []]
                            messages.append(message.model_dump(exclude_none=True))
                            final = message.content
                        else:
                            calls = [(call.call_id, call.name, call.arguments) for call in response.output if call.type == "function_call"]
                            messages.extend(item.model_dump(exclude_none=True) for item in response.output)
                            final = response.output_text
                        if not calls:
                            break
                        for call_id, name, arguments in calls:
                            value = await loop.functions[name](json.loads(arguments))
                            text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
                            messages.append({"role": "tool", "tool_call_id": call_id, "content": text} if protocol == "openai-chat" else
                                {"type": "function_call_output", "call_id": call_id, "output": text})
                    assert final == FACT and not provider.errors
                    print(json.dumps({"protocol": protocol, "native_raw_status": raw.status_code, "application_loop_final": final}))

        with Provider("anthropic-messages") as provider:
            async with anthropic.AsyncAnthropic(api_key="local-fixture", base_url=provider.url, max_retries=0) as existing_client:
                client = with_caveman_anthropic(existing_client, runtime=runtime, scope=Scope("provider-example", "anthropic"))
                raw = await client.messages.with_raw_response.create(model="helpers", max_tokens=100, messages=history("anthropic-messages"))
                runner = client.beta.messages.tool_runner(model="loop", max_tokens=100, max_iterations=5,
                    messages=[{"role": "user", "content": "Read source and recover row 70"}], tools=[ReadLogs()])
                final = await runner.until_done()
                assert final.content[0].text == FACT and not provider.errors
                print(json.dumps({"protocol": "anthropic-messages", "native_raw_status": raw.status_code, "native_runner_final": final.content[0].text}))


if __name__ == "__main__":
    asyncio.run(main())
