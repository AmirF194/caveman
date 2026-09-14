import { sha256 } from '../../../packages/sdk/typescript/dist/middleware/index.js';

const textContent = result => result.content.filter(part => part.type === 'text').map(part => part.text).join('');

/** Application-owned text-tool example. Existing provider and MCP clients keep
 * their native transports. Store originals; create transient views at dispatch. */
export async function runTextHost({ client, model, protocol, host, tools, prompt, stream = false, onText }) {
  const registered = host.register(tools), byName = new Map(registered.map(binding => [binding.tool.name, binding]));
  const nativeTools = registered.map(({ tool }) => protocol === 'openai'
    ? { type: 'function', function: { name: tool.name, description: tool.description ?? '', parameters: tool.inputSchema } }
    : { name: tool.name, description: tool.description ?? '', input_schema: tool.inputSchema });
  const messages = [{ role: 'user', content: prompt }], originals = [];
  for (let turn = 0; turn < 12; turn++) {
    const contextManifest = await Promise.all(messages.map(async (message, i) => ({ id: `message-${i}`, sha256: await sha256(JSON.stringify(message)) })));
    const view = structuredClone(messages);
    for (const entry of originals) {
      const projected = await host.projectResult(entry.result, { tool: byName.get(entry.name).tool, callId: entry.id, contextManifest, registeredTools: registered });
      if (protocol === 'openai') view[entry.index].content = textContent(projected);
      else view[entry.index].content[0].content = textContent(projected);
    }
    const options = { model, messages: view, tools: nativeTools };
    const requestOptions = { headers: { 'x-native-option': 'preserved' } };
    let calls, final;
    if (protocol === 'openai') {
      if (stream) {
        final = ''; const pending = new Map();
        const nativeStream = await client.chat.completions.create({ ...options, stream: true }, requestOptions);
        for await (const chunk of nativeStream) for (const choice of chunk.choices) {
          if (choice.delta.content) { final += choice.delta.content; await onText?.(choice.delta.content); }
          for (const part of choice.delta.tool_calls ?? []) {
            if (!pending.has(part.index)) pending.set(part.index, { id: '', type: 'function', function: { name: '', arguments: '' } });
            const call = pending.get(part.index);
            if (part.id) call.id = part.id;
            if (part.function) { call.function.name += part.function.name ?? ''; call.function.arguments += part.function.arguments ?? ''; }
          }
        }
        const nativeCalls = [...pending.values()];
        messages.push({ role: 'assistant', content: final || null, ...(nativeCalls.length ? { tool_calls: nativeCalls } : {}) });
        calls = nativeCalls.map(call => ({ id: call.id, name: call.function.name, args: JSON.parse(call.function.arguments) }));
      } else {
        const response = await client.chat.completions.create(options, requestOptions), message = response.choices[0].message;
        messages.push(message); final = message.content;
        calls = (message.tool_calls ?? []).map(call => ({ id: call.id, name: call.function.name, args: JSON.parse(call.function.arguments) }));
      }
    } else {
      options.max_tokens = 2048;
      let response;
      if (stream) {
        const nativeStream = client.messages.stream(options, requestOptions);
        for await (const event of nativeStream) if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') await onText?.(event.delta.text);
        response = await nativeStream.finalMessage();
      } else response = await client.messages.create(options, requestOptions);
      messages.push({ role: 'assistant', content: response.content });
      final = response.content.filter(part => part.type === 'text').map(part => part.text).join('');
      calls = response.content.filter(part => part.type === 'tool_use').map(part => ({ id: part.id, name: part.name, args: part.input }));
    }
    if (!calls.length) return { final, messages, originals };
    for (const call of calls) {
      const result = await byName.get(call.name).execute(call.args);
      originals.push({ ...call, index: messages.length, result });
      messages.push(protocol === 'openai' ? { role: 'tool', tool_call_id: call.id, content: textContent(result) }
        : { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: textContent(result), is_error: !!result.isError }] });
    }
  }
  throw new Error('Application provider-call budget exhausted');
}
