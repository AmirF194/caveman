import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

export const SOURCE = Array.from({ length: 140 }, (_, i) => `[INFO] café 🌍 row ${i} retained-detail-${i} long repeated diagnostic\r\n`).join('');

export async function providerFixture(protocol, { toolName = 'read_logs', toolArguments = { path: 'fixture/diagnostics.log' },
  expectedText = SOURCE, nativeEngine = false } = {}) {
  const state = { calls: [], responses: [], errors: [], release: null, finished: false };
  const server = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      state.calls.push({ body, headers: request.headers, wire: Buffer.concat(chunks).toString('utf8') });
      assert.ok(state.calls.length <= 12, 'native provider fixture budget');
      const results = protocol === 'openai' ? body.messages.filter(message => message.role === 'tool').map(message => ({ id: message.tool_call_id, text: message.content }))
        : body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(part => part.type === 'tool_result').map(part => ({ id: part.tool_use_id, text: part.content }));
      const original = results.find(item => item.id === 'read-1');
      let call, final = 'retained-detail-70';
      if (!original) call = { id: 'read-1', name: toolName, args: toolArguments };
      else {
        const native = nativeEngine ? JSON.parse(original.text) : null;
        const handle = nativeEngine ? native.recovery_handle : original.text.match(/cmw_[a-f0-9]{48}/)?.[0];
        const recovered = results.find(item => item.id === 'recover-1');
        if (handle && !recovered) {
          assert.ok(!(nativeEngine ? native.compressed : original.text).includes('retained-detail-70'));
          call = { id: 'recover-1', name: 'caveman_retrieve', args: nativeEngine ? { recovery_handle: handle } : { handle } };
        } else {
          const text = recovered ? nativeEngine ? recovered.text : JSON.parse(recovered.text).text : original.text;
          if (typeof expectedText === 'function') expectedText(text);
          else assert.equal(text, expectedText);
        }
      }
      state.responses.push(call ? structuredClone(call) : { final });
      if (protocol === 'openai') {
        const message = call ? { role: 'assistant', content: null, tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] }
          : { role: 'assistant', content: final };
        const envelope = { id: 'chatcmpl-native', object: 'chat.completion', created: 1, model: body.model };
        const usage = { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020 };
        if (!body.stream) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ...envelope, choices: [{ index: 0, message, finish_reason: call ? 'tool_calls' : 'stop' }], usage })); return; }
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ ...envelope, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage } : {}) })}\n\n`);
        if (call) {
          const args = JSON.stringify(call.args);
          send({ role: 'assistant', tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: args.slice(0, 1) } }] });
          send({ tool_calls: [{ index: 0, function: { arguments: args.slice(1) } }] });
        } else {
          send({ role: 'assistant', content: final.slice(0, 9) });
          await new Promise(resolve => { state.release = resolve; response.on('close', resolve); });
          state.finished = true; send({ content: final.slice(9) });
        }
        send({}, call ? 'tool_calls' : 'stop'); response.end('data: [DONE]\n\n');
      } else {
        const content = call ? [{ type: 'tool_use', id: call.id, name: call.name, input: call.args }] : [{ type: 'text', text: final }];
        const message = { id: 'msg-native', type: 'message', role: 'assistant', model: body.model, content, stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 20 } };
        if (!body.stream) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(message)); return; }
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (type, fields) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
        send('message_start', { message: { ...message, content: [], stop_reason: null } });
        if (call) {
          send('content_block_start', { index: 0, content_block: { ...content[0], input: {} } });
          const args = JSON.stringify(call.args);
          for (const part of [args.slice(0, 1), args.slice(1)]) send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: part } });
        } else {
          send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
          send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: final.slice(0, 9) } });
          await new Promise(resolve => { state.release = resolve; response.on('close', resolve); });
          state.finished = true;
          send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: final.slice(9) } });
        }
        send('content_block_stop', { index: 0 });
        send('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 20 } });
        send('message_stop', {}); response.end();
      }
    } catch (error) { state.errors.push(error.message); response.destroy(error); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { state, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { state.release?.(); server.closeAllConnections(); server.close(resolve); }) };
}
