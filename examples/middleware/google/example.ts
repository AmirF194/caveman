import type { CallableTool, GoogleGenAIOptions } from '@google/genai';
import type { MiddlewareRuntime, Scope } from '@caveman-ai/sdk/middleware';
import { CavemanGoogleGenAI } from '@caveman-ai/middleware/google';

/** Reuse the application's provider/auth options and model without changing them. */
export async function answerFromLogs(options: {
  nativeOptions: GoogleGenAIOptions;
  runtime: MiddlewareRuntime;
  scope: Scope;
  model: string;
  source: string;
  question: string;
}) {
  const readLogs: CallableTool = {
    async tool() {
      return { functionDeclarations: [{ name: 'read_logs', description: 'Read the diagnostic log.', parametersJsonSchema: { type: 'object', properties: {} } }] };
    },
    async callTool(calls) {
      return calls.filter(call => call.name === 'read_logs').map(call => ({ functionResponse: {
        name: 'read_logs', ...(call.id ? { id: call.id } : {}), response: { output: options.source },
      } }));
    },
  };
  const client = new CavemanGoogleGenAI(options.nativeOptions, { runtime: options.runtime, scope: options.scope });
  const chat = client.chats.create({ model: options.model, config: { tools: [readLogs] } });
  return chat.sendMessage({ message: options.question });
}
