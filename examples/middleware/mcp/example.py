"""Application-owned MCP tool loop using existing native clients and histories."""
import copy
import json

from caveman_cloud.middleware import sha256


def content_text(result):
    # This example uses a text-only application tool. Multimodal applications
    # keep their own native provider mapping; Caveman does not perform it.
    return "".join(part.text for part in result.content if part.type == "text")


async def run_text_host(*, client, model, protocol, host, tools, prompt,
                        stream=False, on_text=None, originals=None):
    """Keep original MCP results and provider history; project only at dispatch."""
    registered = host.register(tools)
    by_name = {binding.tool.name: binding for binding in registered}
    definitions = [{"name": binding.tool.name, "description": binding.tool.description or "",
                    "input_schema": binding.tool.input_schema} for binding in registered]
    native_tools = ([{"type": "function", "function": {"name": item["name"], "description": item["description"],
                      "parameters": item["input_schema"]}} for item in definitions]
                    if protocol == "openai" else definitions)
    messages = [{"role": "user", "content": prompt}]
    stored = [] if originals is None else originals
    locations = []
    for _ in range(12):
        manifest = [{"id": "message-" + str(i), "sha256": sha256(json.dumps(message, ensure_ascii=False, separators=(",", ":")))}
                    for i, message in enumerate(messages)]
        view = copy.deepcopy(messages)
        for index, tool_name, call_id, original in locations:
            projected = await host.project_result(original, tool=by_name[tool_name].tool, call_id=call_id,
                                context_manifest=manifest, registered_tools=registered)
            if protocol == "openai":
                view[index]["content"] = content_text(projected)
            else:
                view[index]["content"][0]["content"] = content_text(projected)
        options = {"model": model, "messages": view, "tools": native_tools,
                   "extra_headers": {"x-native-option": "preserved"}}
        if protocol == "openai":
            if stream:
                final, pending = "", {}
                async with await client.chat.completions.create(**options, stream=True) as native_stream:
                    async for chunk in native_stream:
                        for choice in chunk.choices:
                            if choice.delta.content:
                                final += choice.delta.content
                                if on_text:
                                    await on_text(choice.delta.content)
                            for part in choice.delta.tool_calls or []:
                                call = pending.setdefault(part.index, {"id": "", "type": "function", "function": {"name": "", "arguments": ""}})
                                if part.id:
                                    call["id"] = part.id
                                if part.function:
                                    call["function"]["name"] += part.function.name or ""
                                    call["function"]["arguments"] += part.function.arguments or ""
                native_calls = list(pending.values())
                messages.append({"role": "assistant", "content": final or None, **({"tool_calls": native_calls} if native_calls else {})})
                calls = [(call["id"], call["function"]["name"], json.loads(call["function"]["arguments"])) for call in native_calls]
            else:
                response = await client.chat.completions.create(**options)
                message = response.choices[0].message
                messages.append(message.model_dump(exclude_none=True))
                calls = [(call.id, call.function.name, json.loads(call.function.arguments)) for call in message.tool_calls or []]
                final = message.content
        else:
            options["max_tokens"] = 2048
            if stream:
                async with client.messages.stream(**options) as native_stream:
                    async for text in native_stream.text_stream:
                        if on_text:
                            await on_text(text)
                    response = await native_stream.get_final_message()
            else:
                response = await client.messages.create(**options)
            messages.append({"role": "assistant", "content": [part.model_dump(exclude_none=True) for part in response.content]})
            calls = [(part.id, part.name, part.input) for part in response.content if part.type == "tool_use"]
            final = "".join(part.text for part in response.content if part.type == "text")
        if not calls:
            return final, messages, stored
        for call_id, tool_name, arguments in calls:
            result = await by_name[tool_name].execute(arguments)
            stored.append((tool_name, call_id, result))
            locations.append((len(messages), tool_name, call_id, result))
            if protocol == "openai":
                messages.append({"role": "tool", "tool_call_id": call_id, "content": content_text(result)})
            else:
                messages.append({"role": "user", "content": [{"type": "tool_result", "tool_use_id": call_id,
                                                             "content": content_text(result), "is_error": bool(result.is_error)}]})
    raise RuntimeError("Application provider-call budget exhausted")
