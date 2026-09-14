"""Application-owned source reading through native LlamaIndex public APIs.

The application chooses the loop and its budget. Middleware only supplies the
node view; the installed LLM still serializes calls and parses native tools.
"""
import inspect
import json

from llama_index.core.base.llms.types import ChatMessage
from llama_index.core.response_synthesizers.base import BaseSynthesizer
from llama_index.core.tools import FunctionTool


def recovery_tool(reader):
    """Install this runtime-owned binding's execute callable in a native tool."""
    def expand(handle: str, offset: int = 0, limit: int = 262144, query: str = "") -> str:
        page = reader.execute(dict(handle=handle, offset=offset, limit=limit, query=query))
        if inspect.isawaitable(page):
            raise TypeError("Synchronous synthesis requires a synchronous source reader")
        return json.dumps(page, ensure_ascii=False)

    async def aexpand(handle: str, offset: int = 0, limit: int = 262144, query: str = "") -> str:
        page = reader.execute(dict(handle=handle, offset=offset, limit=limit, query=query))
        return json.dumps(await page if inspect.isawaitable(page) else page, ensure_ascii=False)

    return FunctionTool.from_defaults(fn=expand, async_fn=aexpand, name=reader.name, description=reader.description)


class SourceExpansionSynthesizer(BaseSynthesizer):
    """An example application reader installed in a native query engine."""
    def __init__(self, *, llm, source_expansion, streaming=False):
        super().__init__(llm=llm, streaming=streaming)
        self.source_expansion = source_expansion
        self.tools = (recovery_tool(source_expansion),)
        self.histories, self.tool_outputs = [], []

    def _get_prompts(self):
        return {}

    def _update_prompts(self, prompts):
        if prompts:
            raise ValueError("This application reader has no configurable prompt templates")

    def messages(self, query_str, text_chunks):
        messages = [ChatMessage(role="user", content=query_str + "\n\n" + "\n\n".join(text_chunks))]
        self.histories.append(messages)
        return messages

    def get_response(self, query_str, text_chunks, **kwargs):
        responses = self._run(self.messages(query_str, text_chunks))
        return responses if self._streaming else "".join(responses)

    async def aget_response(self, query_str, text_chunks, **kwargs):
        responses = self._arun(self.messages(query_str, text_chunks))
        return responses if self._streaming else "".join([text async for text in responses])

    def _run(self, messages):
        for _ in range(6):
            if self._streaming:
                for response in self._llm.stream_chat_with_tools(self.tools, chat_history=messages, allow_parallel_tool_calls=True):
                    if response.delta:
                        yield response.delta
            else:
                response = self._llm.chat_with_tools(self.tools, chat_history=messages, allow_parallel_tool_calls=True)
            messages.append(response.message)
            calls = self._llm.get_tool_calls_from_response(response, error_on_no_tool_call=False)
            if not calls:
                if not self._streaming:
                    yield response.message.content or ""
                return
            for call in calls:
                if call.tool_name != self.source_expansion.name:
                    raise ValueError("Unregistered source reader")
                output = self.tools[0].call(**call.tool_kwargs)
                self.tool_outputs.append((call, output))
                messages.append(ChatMessage(role="tool", blocks=output.blocks, additional_kwargs={"tool_call_id": call.tool_id, "is_error": output.is_error}))
        raise RuntimeError("Application source-reading call budget exceeded")

    async def _arun(self, messages):
        for _ in range(6):
            if self._streaming:
                async for response in await self._llm.astream_chat_with_tools(self.tools, chat_history=messages, allow_parallel_tool_calls=True):
                    if response.delta:
                        yield response.delta
            else:
                response = await self._llm.achat_with_tools(self.tools, chat_history=messages, allow_parallel_tool_calls=True)
            messages.append(response.message)
            calls = self._llm.get_tool_calls_from_response(response, error_on_no_tool_call=False)
            if not calls:
                if not self._streaming:
                    yield response.message.content or ""
                return
            for call in calls:
                if call.tool_name != self.source_expansion.name:
                    raise ValueError("Unregistered source reader")
                output = await self.tools[0].acall(**call.tool_kwargs)
                self.tool_outputs.append((call, output))
                messages.append(ChatMessage(role="tool", blocks=output.blocks, additional_kwargs={"tool_call_id": call.tool_id, "is_error": output.is_error}))
        raise RuntimeError("Application source-reading call budget exceeded")
