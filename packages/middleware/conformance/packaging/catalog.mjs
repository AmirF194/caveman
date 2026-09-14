/** Every public adapter gets an independent package consumer. */
const ts = (name, family = name, tests = ['conformance.test.mjs']) => ({
  id: `typescript-${name}`, language: 'typescript', name,
  example: `examples/middleware/${family}`, tests,
  locks: [`examples/middleware/${family}/package-lock.json`],
});
const py = (name, family = name, test = 'test_native.py') => ({
  id: `python-${name}`, language: 'python', name,
  example: `examples/middleware/${family}`, tests: [test],
  locks: [`examples/middleware/${family}/requirements.lock`],
});

export const cases = [
  { id: 'typescript-core', language: 'typescript', name: 'core', locks: [], tests: [] },
  ts('openai', 'provider-sdks', ['openai.test.mjs']),
  ts('anthropic', 'provider-sdks', ['anthropic.test.mjs']),
  ts('google', 'provider-sdks', ['google.test.mjs']),
  { ...ts('ai-sdk', 'ai-sdk', ['conformance.test.mjs', 'attestation.test.mjs']),
    locks: ['examples/middleware/ai-sdk/package-lock.json', 'examples/middleware/mastra/package-lock.json'],
    supplementaryDependencies: [{ name: '@ai-sdk/anthropic', version: '4.0.50', lock: 'examples/middleware/mastra/package-lock.json' }] },
  ts('langchain'), ts('strands'), ts('mastra'), ts('mcp'),
  { id: 'python-core', language: 'python', name: 'core', locks: [], tests: [] },
  { ...py('openai', 'python-provider-sdks'), tests: ['test_native.py', 'test_providers.py'] },
  { ...py('anthropic', 'python-provider-sdks'), tests: ['test_native.py', 'test_providers.py'] },
  { ...py('google'), locks: ['examples/middleware/python-provider-sdks/requirements.lock'] },
  py('langchain'), { ...py('litellm'), locks: ['examples/middleware/litellm/requirements.lock', 'examples/middleware/litellm/composition-requirements.lock'] },
  py('strands'), py('agno'), py('asgi'), py('mcp'),
  py('crewai'), py('pydantic-ai'), py('autogen'), py('llama-index'),
];

export const pythonImports = {
  core: ['caveman_cloud', 'caveman_cloud.middleware', 'caveman_middleware'],
  openai: ['openai', 'caveman_middleware.openai'],
  anthropic: ['anthropic', 'caveman_middleware.anthropic'],
  google: ['google.genai', 'caveman_middleware.google'],
  langchain: ['langchain', 'langgraph', 'caveman_middleware.langchain'],
  litellm: ['litellm', 'caveman_middleware.litellm'],
  strands: ['strands', 'caveman_middleware.strands'],
  agno: ['agno', 'caveman_middleware.agno'],
  asgi: ['fastapi', 'starlette', 'caveman_middleware.asgi'],
  mcp: ['mcp', 'caveman_middleware.mcp'],
  crewai: ['crewai', 'caveman_middleware.crewai'],
  'pydantic-ai': ['pydantic_ai', 'caveman_middleware.pydantic_ai'],
  autogen: ['autogen_agentchat', 'autogen_core', 'autogen_ext', 'caveman_middleware.autogen'],
  'llama-index': ['llama_index.core', 'caveman_middleware.llama_index'],
};

const preamble = `import { createMiddlewareRuntime, type Scope } from '@caveman-ai/sdk/middleware';
const runtime = createMiddlewareRuntime({ mode: 'off' });
const scope: Scope = { namespace: 'installed-consumer', session_id: '1', branch_id: 'main', cache_epoch: '0' };
`;
export function typescriptConsumer(name) {
  const bodies = {
    core: `import { Cave } from '@caveman-ai/sdk';
const sdk: typeof Cave = Cave; void [sdk, runtime, scope];`,
    openai: `import OpenAI from 'openai';
import { withCavemanOpenAI } from '@caveman-ai/middleware/openai';
const client: OpenAI = withCavemanOpenAI(new OpenAI({ apiKey: 'fixture' }), { runtime, scope, fetch });
void client.chat.completions.create({ model: 'fixture', messages: [] }).asResponse();`,
    anthropic: `import Anthropic from '@anthropic-ai/sdk';
import { withCavemanAnthropic } from '@caveman-ai/middleware/anthropic';
const client: Anthropic = withCavemanAnthropic(new Anthropic({ apiKey: 'fixture' }), { runtime, scope, fetch });
void client.messages.create({ model: 'fixture', max_tokens: 1, messages: [] }).asResponse();`,
    google: `import { GoogleGenAI } from '@google/genai';
import { CavemanGoogleGenAI } from '@caveman-ai/middleware/google';
const client: GoogleGenAI = new CavemanGoogleGenAI({ apiKey: 'fixture' }, { runtime, scope });
void client.models.generateContent({ model: 'fixture', contents: 'test' });`,
    'ai-sdk': `import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText, streamText, stepCountIs } from 'ai';
import { withCaveman } from '@caveman-ai/middleware/ai-sdk';
const input = withCaveman({ model: createOpenAI({ apiKey: 'fixture' }).chat('fixture'), prompt: 'test', stopWhen: stepCountIs(3) }, { runtime, scope });
const anthropicInput = withCaveman({ model: createAnthropic({ apiKey: 'fixture' })('fixture'), prompt: 'test', stopWhen: stepCountIs(3) }, { runtime, scope });
void [generateText(input), streamText(input), generateText(anthropicInput), streamText(anthropicInput)];`,
    langchain: `import { createAgent } from 'langchain';
import { ChatOpenAI } from '@langchain/openai';
import { withCavemanAgent, withCavemanModel, CavemanDocumentCompressor } from '@caveman-ai/middleware/langchain';
const model = withCavemanModel(new ChatOpenAI({ apiKey: 'fixture' }), { runtime, scope });
const agent = createAgent(withCavemanAgent({ model, tools: [] }, { runtime, scope }));
void [agent, new CavemanDocumentCompressor({ runtime, scope }).compressDocuments([], 'query')];`,
    strands: `import { Agent, BedrockModel } from '@strands-agents/sdk';
import { withCavemanStrands, withCavemanStrandsModel } from '@caveman-ai/middleware/strands';
const model = withCavemanStrandsModel(new BedrockModel({ modelId: 'fixture', region: 'us-east-1' }), { runtime, scope });
const agent: Agent = new Agent(withCavemanStrands({ model, tools: [] }, { runtime, scope })); void agent;`,
    mastra: `import type { Processor } from '@mastra/core/processors';
import { Agent } from '@mastra/core/agent';
import { createOpenAI } from '@ai-sdk/openai';
import { createCavemanMastraProcessor, withCavemanMastra } from '@caveman-ai/middleware/mastra';
const processor: Processor = createCavemanMastraProcessor({ runtime, scope });
const agent = withCavemanMastra(new Agent({ id: 'consumer', name: 'consumer', instructions: 'Read logs.', model: createOpenAI({ apiKey: 'fixture' }).chat('fixture') }), { runtime, scope });
void [processor, agent];`,
    mcp: `import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CavemanMCPHost, bindMCPTool } from '@caveman-ai/middleware/mcp';
const client = new Client({ name: 'consumer', version: '1' });
const host = new CavemanMCPHost({ runtime, scope, serverId: 'fixture', protocolVersion: '2025-11-25' });
void host.register([bindMCPTool(client, { name: 'read_logs', inputSchema: { type: 'object' } })]);`,
  };
  if (!bodies[name]) throw new Error(`No type consumer for ${name}`);
  return preamble + bodies[name] + '\n';
}
