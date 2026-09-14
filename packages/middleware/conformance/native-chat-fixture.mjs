/** Native OpenAI-compatible local HTTP fixture. No external provider is used. */
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';

export async function nativeChatFixture(handler) {
  const active = new Set(), sockets = new Set(), errors = [], recent = [];
  let requests = 0, bytes = 0;
  const server = createServer(async (request, response) => {
    active.add(response);
    response.once('close', () => active.delete(response));
    response.once('finish', () => active.delete(response));
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const wire = Buffer.concat(chunks), body = JSON.parse(wire);
      requests++; bytes += wire.length;
      recent.push({ model: body.model, stream: body.stream === true, bytes: wire.length,
        sha256: createHash('sha256').update(wire).digest('hex') });
      if (recent.length > 128) recent.shift();
      await handler(body, response, requests);
    } catch (error) {
      if (!response.destroyed) { errors.push(String(error.message)); response.destroy(error); }
    }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`, errors,
    stats: () => ({ requests, uploaded_bytes: bytes, active_responses: active.size, open_sockets: sockets.size, recent: [...recent] }),
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }),
  };
}

export function chatChunk(body, delta, finish = null, usage) {
  return `data: ${JSON.stringify({ id: 'chatcmpl-native-fixture', object: 'chat.completion.chunk', created: 1, model: body.model,
    choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
}

export async function writeChunk(response, chunk) {
  if (response.destroyed) return false;
  if (response.write(chunk)) return true;
  return new Promise(resolve => {
    const clear = () => { response.off('drain', drained); response.off('close', closed); response.off('error', closed); };
    const drained = () => { clear(); resolve(true); };
    const closed = () => { clear(); resolve(false); };
    response.once('drain', drained); response.once('close', closed); response.once('error', closed);
  });
}

export function startSSE(response) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
}

export async function chatResponse(body, response, { text = null, calls = [] } = {}) {
  const usage = { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020 };
  const finish = calls.length ? 'tool_calls' : 'stop';
  const toolCalls = calls.map(({ name, input, id }) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(input) } }));
  if (body.stream) {
    startSSE(response);
    if (!await writeChunk(response, chatChunk(body, { role: 'assistant', ...(calls.length ? {
      tool_calls: toolCalls.map((call, index) => ({ index, ...call, function: { ...call.function, arguments: '' } })),
    } : { content: text }) }))) return;
    // Tool arguments are separate native deltas, not preassembled helper input.
    for (const [index, call] of toolCalls.entries()) {
      if (!await writeChunk(response, chatChunk(body, { tool_calls: [{ index, function: { arguments: call.function.arguments } }] }))) return;
    }
    if (!await writeChunk(response, chatChunk(body, {}, finish, usage))) return;
    response.end('data: [DONE]\n\n');
  } else {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ id: 'chatcmpl-native-fixture', object: 'chat.completion', created: 1, model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: text, ...(calls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: finish, logprobs: null }], usage }));
  }
}
