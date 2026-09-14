/** Local native HTTP providers. Every tool result comes from the installed Strands executor. */
import assert from 'node:assert/strict';
import { createServer as createHTTP } from 'node:http';
import { createServer as createHTTP2 } from 'node:http2';
import { once } from 'node:events';
import { crc32 } from 'node:zlib';
import { BedrockModel } from '@strands-agents/sdk';
import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import { AnthropicModel } from '@strands-agents/sdk/models/anthropic';

export const FACT = 'retained-detail-70';
export const sources = Object.fromEntries(['read_logs', 'read_aux'].map(name => [name,
  Array.from({ length: 140 }, (_, i) => `[INFO] café 🌍 ${name} row ${i} retained-detail-${i} long repeated diagnostic\r\n`).join('')]));
export const handlePattern = /cmw_[a-f0-9]{48}/g;
export function nativeResults(body, protocol) {
  if (protocol === 'openai') return body.messages.filter(m => m.role === 'tool').map(m => ({ id: m.tool_call_id, text: m.content }));
  if (protocol === 'anthropic') return body.messages.flatMap(m => typeof m.content === 'string' ? [] : m.content.filter(p => p.type === 'tool_result')
    .map(p => ({ id: p.tool_use_id, text: typeof p.content === 'string' ? p.content : p.content.filter(v => v.type === 'text').map(v => v.text).join('') })));
  return body.messages.flatMap(m => m.content.filter(p => p.toolResult).map(({ toolResult: r }) => ({ id: r.toolUseId, text: r.content.map(p => p.text ?? '').join('') })));
}
export function nativeTools(body, protocol) {
  return protocol === 'openai' ? (body.tools ?? []).map(t => ({ name: t.function.name, schema: t.function.parameters }))
    : protocol === 'anthropic' ? (body.tools ?? []).map(t => ({ name: t.name, schema: t.input_schema }))
    : (body.toolConfig?.tools ?? []).map(t => ({ name: t.toolSpec.name, schema: t.toolSpec.inputSchema.json }));
}
function awsEvent(name, payload) {
  const headers = [];
  for (const [key, value] of Object.entries({ ':event-type': name, ':content-type': 'application/json', ':message-type': 'event' })) {
    const k = Buffer.from(key), v = Buffer.from(value), size = Buffer.alloc(2); size.writeUInt16BE(v.length);
    headers.push(Buffer.from([k.length]), k, Buffer.from([7]), size, v);
  }
  const h = Buffer.concat(headers), body = Buffer.from(JSON.stringify(payload)), prelude = Buffer.alloc(12);
  prelude.writeUInt32BE(16 + h.length + body.length); prelude.writeUInt32BE(h.length, 4); prelude.writeUInt32BE(crc32(prelude.subarray(0, 8)), 8);
  const frame = Buffer.concat([prelude, h, body]), checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(frame)); return Buffer.concat([frame, checksum]);
}

export async function providerFixture(protocol, { parallel = false, gateText = false } = {}) {
  const state = { calls: [], actions: [], errors: [], handles: {}, gateReleased: !gateText, closedBeforeEOF: false, resume: false, structured: false, structuredSeen: 0 };
  let release; const gate = new Promise(resolve => release = resolve);
  const releaseGate = () => { state.gateReleased = true; release(); };
  if (!gateText) releaseGate();
  const wait = async response => {
    if (state.gateReleased) return;
    let timer, closed;
    try {
      await Promise.race([gate, new Promise(resolve => { closed = () => { state.closedBeforeEOF = true; resolve(); }; response.once('close', closed); }),
        new Promise((_, reject) => timer = setTimeout(() => reject(new Error('Native Strands consumer did not receive the first delta before provider EOF')), 4000))]);
    } finally { clearTimeout(timer); if (closed) response.off('close', closed); }
  };
  const choose = body => {
    const tools = nativeTools(body, protocol), results = nativeResults(body, protocol);
    const typed = tools.find(t => !['read_logs', 'read_aux', 'caveman_retrieve'].includes(t.name));
    if (state.structured) {
      assert.ok(typed, 'Native structured schema must reach the provider');
      assert.ok(typed.schema.properties.answer);
      assert.equal(tools.some(t => t.name === 'caveman_retrieve'), false);
      for (const result of results.filter(r => r.id.startsWith('read-'))) assert.equal(result.text, sources[result.id === 'read-1' ? 'read_logs' : 'read_aux']);
      state.structuredSeen++;
      const choice = protocol === 'bedrock' ? body.toolConfig?.toolChoice : body.tool_choice;
      if (!choice || choice === 'auto' || choice.type === 'auto') return { text: 'schema-ready' };
      state.actions.push({ type: 'structured', schema: typed.schema, choice });
      return { calls: [{ id: 'typed-1', name: typed.name, input: { answer: 42 } }] };
    }
    if (!results.some(r => r.id === 'read-1')) return { calls: [
      { id: 'read-1', name: 'read_logs', input: { marker: 'native-main' } },
      ...(parallel ? [{ id: 'read-2', name: 'read_aux', input: { marker: 'native-aux' } }] : []),
    ] };
    for (const [id, name] of [['read-1', 'read_logs'], ...(parallel ? [['read-2', 'read_aux']] : [])]) {
      const result = results.find(r => r.id === id); assert.ok(result, `Native result ${id}`);
      const found = result.text.match(handlePattern)?.[0];
      const recovered = results.find(r => r.id === `recover-${id}`);
      if (found) {
        assert.equal(result.text.includes(FACT), false); state.handles[id] = found;
        if (!recovered) { state.actions.push({ type: 'recover', source: id, handle: found }); return { calls: [{ id: `recover-${id}`, name: 'caveman_retrieve', input: { handle: found } }] }; }
        assert.equal(JSON.parse(recovered.text).text, sources[name]);
      } else assert.equal(result.text, sources[name]);
    }
    if (state.resume && state.handles['read-1'] && !results.some(r => r.id === 'recover-resume')) {
      state.actions.push({ type: 'recover_resume', source: 'read-1', handle: state.handles['read-1'] });
      return { calls: [{ id: 'recover-resume', name: 'caveman_retrieve', input: { handle: state.handles['read-1'] } }] };
    }
    const resumed = results.find(r => r.id === 'recover-resume'); if (resumed) assert.equal(JSON.parse(resumed.text).text, sources.read_logs);
    return { text: FACT };
  };
  const handler = async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)); state.calls.push({ path: request.url, body, headers: request.headers });
      assert.ok(state.calls.length <= 8, 'Bounded native fixture refused an unexpected provider loop');
      if (protocol === 'bedrock') { assert.match(request.headers.authorization, /^AWS4-HMAC-SHA256 /); assert.match(request.headers['user-agent'], /native-fixture/); }
      else {
        assert.equal(request.headers['x-native-strands'], 'preserved');
        assert.equal(request.url, protocol === 'openai' ? '/v1/chat/completions' : '/v1/messages');
        assert.equal(protocol === 'openai' ? request.headers.authorization : request.headers['x-api-key'], protocol === 'openai' ? 'Bearer fixture' : 'fixture');
      }
      const answer = choose(body), calls = answer.calls;
      state.actions.push({ type: calls ? 'tool_calls' : 'text', ids: calls?.map(c => c.id) ?? [], value: answer.text ?? null });
      response.writeHead(200, { 'content-type': protocol === 'bedrock' ? 'application/vnd.amazon.eventstream' : 'text/event-stream',
        ...(protocol === 'bedrock' ? {} : { connection: 'close' }) });
      if (protocol === 'openai') {
        const send = (delta, finish_reason = null, extra = {}) => response.write(`data: ${JSON.stringify({ id: 'chat-native', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`);
        send({ role: 'assistant' });
        if (calls) for (const [index, call] of calls.entries()) send({ tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } }] });
        else { send({ content: answer.text.slice(0, 9) }); await wait(response); send({ content: answer.text.slice(9) }); }
        send({}, calls ? 'tool_calls' : 'stop', { usage: { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020 } });
        response.end('data: [DONE]\n\n');
      } else if (protocol === 'anthropic') {
        const send = (type, value) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
        send('message_start', { message: { id: 'msg-native', type: 'message', role: 'assistant', model: 'fixture-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 0 } } });
        if (calls) for (const [index, call] of calls.entries()) {
          send('content_block_start', { index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } });
          send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } }); send('content_block_stop', { index });
        } else {
          send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }); send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: answer.text.slice(0, 9) } });
          await wait(response); send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: answer.text.slice(9) } }); send('content_block_stop', { index: 0 });
        }
        send('message_delta', { delta: { stop_reason: calls ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } }); send('message_stop', {}); response.end();
      } else {
        const send = (name, value) => response.write(awsEvent(name, value));
        send('messageStart', { role: 'assistant' });
        if (calls) for (const [index, call] of calls.entries()) {
          send('contentBlockStart', { contentBlockIndex: index, start: { toolUse: { toolUseId: call.id, name: call.name } } });
          send('contentBlockDelta', { contentBlockIndex: index, delta: { toolUse: { input: JSON.stringify(call.input) } } }); send('contentBlockStop', { contentBlockIndex: index });
        } else { send('contentBlockDelta', { contentBlockIndex: 0, delta: { text: answer.text.slice(0, 9) } }); await wait(response);
          send('contentBlockDelta', { contentBlockIndex: 0, delta: { text: answer.text.slice(9) } }); send('contentBlockStop', { contentBlockIndex: 0 }); }
        send('messageStop', { stopReason: calls ? 'tool_use' : 'end_turn' }); send('metadata', { usage: { inputTokens: 1000, outputTokens: 20, totalTokens: 1020 }, metrics: { latencyMs: 1 } }); response.end();
      }
    } catch (error) { state.errors.push(error.message); response.destroy(error); }
  };
  const server = (protocol === 'bedrock' ? createHTTP2 : createHTTP)(handler), sessions = new Set();
  server.on('session', session => { sessions.add(session); session.once('close', () => sessions.delete(session)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  return { state, url, release: releaseGate,
    model() {
      const clientConfig = { baseURL: url + '/v1', apiKey: 'fixture', maxRetries: 0, defaultHeaders: { 'x-native-strands': 'preserved' } };
      if (protocol === 'openai') return new OpenAIModel({ api: 'chat', modelId: 'fixture-model', apiKey: 'fixture', maxTokens: 256, clientConfig });
      if (protocol === 'anthropic') return new AnthropicModel({ modelId: 'fixture-model', apiKey: 'fixture', maxTokens: 256, clientConfig: { ...clientConfig, baseURL: url } });
      return new BedrockModel({ modelId: 'anthropic.fixture-v1', region: 'us-east-1', maxTokens: 256,
        clientConfig: { endpoint: url, credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' }, maxAttempts: 1, customUserAgent: 'native-fixture' } });
    },
    async close() { releaseGate(); for (const session of sessions) session.destroy(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); },
  };
}
