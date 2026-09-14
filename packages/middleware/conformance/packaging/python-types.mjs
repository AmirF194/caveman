/** Static consumer calls only; fixtures independently execute the same public APIs. */
const common = `from caveman_cloud.middleware import MiddlewareRuntime, AsyncMiddlewareRuntime, Scope
runtime: MiddlewareRuntime = MiddlewareRuntime(mode="off")
async_runtime: AsyncMiddlewareRuntime = AsyncMiddlewareRuntime(mode="off")
scope: Scope = Scope(namespace="type-consumer", session_id="1", branch_id="main")
`;
const bodies = {
  core: `binding = runtime.recovery(scope)
restored: str = binding.execute({"handle": "fixture"})
`,
  openai: `from openai import OpenAI, AsyncOpenAI, DefaultHttpxClient, DefaultAsyncHttpxClient
from openai.types.chat import ChatCompletion
from httpx2 import HTTPTransport, AsyncHTTPTransport
from caveman_middleware.openai import with_caveman_openai, CavemanOpenAITransport, CavemanAsyncOpenAITransport
transport = CavemanOpenAITransport(HTTPTransport())
client: OpenAI = with_caveman_openai(OpenAI(api_key="fixture", http_client=DefaultHttpxClient(transport=transport)), runtime=runtime, scope=scope, transport=transport)
response: ChatCompletion = client.chat.completions.create(model="fixture", messages=[])
async_transport = CavemanAsyncOpenAITransport(AsyncHTTPTransport())
async_client: AsyncOpenAI = with_caveman_openai(AsyncOpenAI(api_key="fixture", http_client=DefaultAsyncHttpxClient(transport=async_transport)), runtime=async_runtime, scope=scope, transport=async_transport)
async def typed_completion() -> ChatCompletion:
    return await async_client.chat.completions.create(model="fixture", messages=[])
`,
  anthropic: `from anthropic import Anthropic
from anthropic.types import Message
from caveman_middleware.anthropic import with_caveman_anthropic
client: Anthropic = with_caveman_anthropic(Anthropic(api_key="fixture"), runtime=runtime, scope=scope)
response: Message = client.messages.create(model="fixture", max_tokens=1, messages=[])
`,
  google: `from google import genai
from google.genai import types
from caveman_middleware.google import with_caveman_google
client: genai.Client = with_caveman_google(genai.Client(api_key="fixture"), runtime=runtime, scope=scope)
response: types.GenerateContentResponse = client.models.generate_content(model="fixture", contents="test")
`,
  langchain: `from langchain_core.language_models import BaseChatModel
from langchain_openai import ChatOpenAI
from caveman_middleware.langchain import with_caveman_model, CavemanMiddleware
model: BaseChatModel = with_caveman_model(ChatOpenAI(), runtime=runtime, scope=scope)
middleware: CavemanMiddleware = CavemanMiddleware(runtime=runtime, scope=scope)
`,
  litellm: `from caveman_middleware.litellm import CavemanLiteLLM
middleware: CavemanLiteLLM = CavemanLiteLLM(runtime=async_runtime)
response = middleware.completion(scope=scope, model="openai/fixture", messages=[])
`,
  strands: `from strands.models import BedrockModel
from strands.models.model import Model
from caveman_middleware.strands import with_caveman_model
model: Model = with_caveman_model(BedrockModel(model_id="fixture"), runtime=runtime, scope=scope)
`,
  agno: `from agno.models.openai import OpenAIChat
from agno.models.base import Model
from caveman_middleware.agno import with_caveman_model
model: Model = with_caveman_model(OpenAIChat(id="fixture"), runtime=runtime, scope=scope)
`,
  asgi: `from typing import Any
from caveman_middleware.asgi import ASGIContext, CavemanASGIMiddleware
async def app(request: Any, receive: Any, send: Any) -> None:
    await send({"type": "http.response.start", "status": 200, "headers": []})
middleware = CavemanASGIMiddleware(app, runtime=async_runtime, routes={"/v1/chat/completions": "openai-chat"}, resolve_context=lambda request: ASGIContext(scope))
`,
  mcp: `from caveman_middleware.mcp import CavemanMCPHost, MCPToolBinding
host = CavemanMCPHost(runtime=async_runtime, scope=scope, server_id="fixture", protocol_version="2025-11-25")
recovery: MCPToolBinding = host.recovery
`,
  crewai: `from crewai import LLM
from crewai.llms.base_llm import BaseLLM
from caveman_middleware.crewai import with_caveman_llm
model: BaseLLM = with_caveman_llm(LLM(model="openai/fixture"), runtime=runtime, scope=scope)
`,
  'pydantic-ai': `from pydantic_ai.models import Model
from pydantic_ai.models.openai import OpenAIChatModel
from caveman_middleware.pydantic_ai import with_caveman_model, CavemanCapability
model: Model = with_caveman_model(OpenAIChatModel("fixture"), runtime=async_runtime, scope=scope)
capability = CavemanCapability(runtime=async_runtime, scope=scope)
`,
  autogen: `from autogen_core.models import ChatCompletionClient
from autogen_ext.models.openai import OpenAIChatCompletionClient
from caveman_middleware.autogen import with_caveman_model
model: ChatCompletionClient = with_caveman_model(OpenAIChatCompletionClient(model="gpt-4o", api_key="fixture"), runtime=async_runtime, scope=scope)
`,
  'llama-index': `from llama_index.core.llms import LLM
from llama_index.llms.openai import OpenAI
from caveman_middleware.llama_index import with_caveman_model
model: LLM = with_caveman_model(OpenAI(model="fixture"), runtime=runtime, scope=scope)
`,
};
export function pythonConsumer(name) {
  if (!bodies[name]) throw new Error(`No Python consumer for ${name}`);
  return common + bodies[name];
}
