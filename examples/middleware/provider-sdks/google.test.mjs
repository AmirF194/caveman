import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { OAuth2Client } from 'google-auth-library';
import { createMiddlewareRuntime } from '../../../packages/sdk/typescript/dist/middleware/index.js';
import { CavemanGoogleGenAI } from '../../../packages/middleware/typescript/dist/google.js';
import { startRuntime } from '../../../packages/middleware/conformance/runtime-fixture.mjs';
import { certifyGoogleCells } from './google-certification-native.mjs';

// The fixture workspace uses npm while the adapter workspace uses pnpm. Load
// the exact SDK instance used by this native subclass for instanceof checks.
// The packed-consumer suite uses normal package imports in one installation.
const { GoogleGenAI, Chat, GenerateContentResponse } = await import('../../../packages/middleware/typescript/node_modules/@google/genai/dist/node/index.mjs');

test('F03 native Google exact operation journeys preserve source and cancellation', {timeout:90000}, async t => {
  const service = await startRuntime(); t.after(service.stop);
  await certifyGoogleCells(t, 'google', service.endpoint, { GoogleGenAI, Chat, GenerateContentResponse });
});

test('F03 native Vertex exact operation journeys preserve OAuth configuration and source', {timeout:90000}, async t => {
  const service = await startRuntime(); t.after(service.stop);
  await certifyGoogleCells(t, 'vertex', service.endpoint, { GoogleGenAI, Chat, GenerateContentResponse });
});

const source = Array.from({ length: 160 }, (_, i) => `[INFO] café 🌍 row ${i} omitted-detail-${i} verbose repeated diagnostic data\r\n`).join('');
const usage = { promptTokenCount: 1000, candidatesTokenCount: 20, cachedContentTokenCount: 200, thoughtsTokenCount: 3, totalTokenCount: 1023 };
const scope = id => ({ namespace: 'native-google', session_id: id, branch_id: 'main', cache_epoch: '0' });
const response = (parts, terminal = true) => ({ candidates: [{ content: { role: 'model', parts }, ...(terminal ? { finishReason: 'STOP' } : {}), index: 0 }], ...(terminal ? { usageMetadata: usage } : {}), modelVersion: 'native-fixture-model', responseId: 'google-native-response' });
const results = body => body.contents.flatMap(content => content.parts ?? []).filter(part => part.functionResponse).map(part => part.functionResponse);

async function provider(t) {
  const state = { calls: [], errors: [], released: false, closed: false, release: null };
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8'), body = JSON.parse(raw);
    state.calls.push({ body, raw, headers: req.headers, url: req.url });
    try {
      if (req.url.includes('failure')) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 503, message: 'native fixture failure', status: 'UNAVAILABLE' } })); return; }
      let parts;
      if (req.url.includes('helpers') || req.url.includes('cancel')) parts = [{ text: 'native' }];
      else {
        const values = results(body), read = values.find(value => value.name === 'read_logs');
        if (!read) parts = [{ functionCall: { name: 'read_logs', args: {} }, thoughtSignature: 'c2lnbmF0dXJl' }];
        else {
          const shortened = read.response.output, handle = shortened.match(/cmw_[a-f0-9]{48}/)?.[0];
          if (req.url.includes('baseline')) { assert.equal(shortened, source); parts = [{ text: 'omitted-detail-80' }]; }
          else {
            assert.ok(handle, 'native Google AFC tool output is shortened');
            assert.ok(!shortened.includes('omitted-detail-80'));
            assert.ok(body.tools.flatMap(tool => tool.functionDeclarations ?? []).some(tool => tool.name === 'caveman_retrieve'));
            const recovered = values.find(value => value.name === 'caveman_retrieve');
            if (!recovered) parts = [{ functionCall: { name: 'caveman_retrieve', args: { handle } } }];
            else { assert.equal(recovered.response.output.text, source); parts = [{ text: 'omitted-detail-80' }]; }
          }
        }
      }
      if (!req.url.includes('streamGenerateContent')) { res.writeHead(200, { 'content-type': 'application/json', 'x-fixture': 'google-native' }); res.end(JSON.stringify(response(parts))); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-fixture': 'google-native' });
      if (parts[0].text && !req.url.includes('baseline')) {
        res.on('close', () => { state.closed = true; state.release?.(); });
        res.write(`data: ${JSON.stringify(response([{ text: 'first-' }], false))}\n\n`);
        await new Promise(resolve => { state.release = () => { state.released = true; resolve(); }; });
      }
      res.end(`data: ${JSON.stringify(response(parts))}\n\n`);
    } catch (error) { state.errors.push(error.message); res.destroy(error); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { state.release?.(); server.closeAllConnections(); server.close(resolve); }));
  return { ...state, state, options: { apiKey: 'local-google-token', httpOptions: { baseUrl: `http://127.0.0.1:${server.address().port}`, retryOptions: { attempts: 1 } } } };
}

function readTool() {
  const original = { functionResponse: { name: 'read_logs', response: { output: source, metadata: { source: 'diagnostic.log', retained: true } } } };
  return { original, tool: {
    async tool() { return { functionDeclarations: [{ name: 'read_logs', description: 'Read diagnostics', parametersJsonSchema: { type: 'object', properties: {} } }] }; },
    async callTool(calls) { return calls.some(call => call.name === 'read_logs') ? [original] : []; },
  } };
}

for (const operation of ['generate', 'stream', 'chat', 'chat-stream']) test(`Google native ${operation} AFC recovers original source without changing history`, { timeout: 30000 }, async t => {
  const service = await startRuntime(); t.after(service.stop);
  const runtime = createMiddlewareRuntime({ endpoint: service.endpoint }); t.after(() => runtime.close()); await runtime.ready();
  const fixture = await provider(t), client = new CavemanGoogleGenAI(fixture.options, { runtime, scope: scope(operation) });
  assert.ok(client instanceof GoogleGenAI);
  const read = readTool(), config = { tools: [read.tool], temperature: 0.2, systemInstruction: 'Read exact logs.', safetySettings: [{ category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' }] };
  const input = [{ role: 'user', parts: [{ text: 'Find omitted-detail-80.' }] }], before = structuredClone(input);
  const chat = operation.startsWith('chat') ? client.chats.create({ model: 'fixture-model', config, history: [] }) : null;
  if (chat) assert.ok(chat instanceof Chat);
  if (operation.endsWith('stream') || operation === 'stream') {
    const stream = chat ? await chat.sendMessageStream({ message: input[0].parts }) : await client.models.generateContentStream({ model: 'fixture-model', contents: input, config });
    const events = [];
    for await (const chunk of stream) {
      assert.ok(chunk instanceof GenerateContentResponse); events.push(chunk);
      if (chunk.candidates?.[0]?.content?.parts?.[0]?.text === 'first-') { assert.equal(fixture.state.released, false, 'first chunk arrives before provider completion'); fixture.state.release(); }
    }
    assert.equal(events.at(-1).text, 'omitted-detail-80');
    assert.equal(events.filter(event => event.functionCalls?.length).length, 2);
  } else {
    const result = chat ? await chat.sendMessage({ message: input[0].parts }) : await client.models.generateContent({ model: 'fixture-model', contents: input, config });
    assert.ok(result instanceof GenerateContentResponse); assert.equal(result.text, 'omitted-detail-80');
    assert.equal(result.usageMetadata.thoughtsTokenCount, 3);
    if (!chat) assert.equal(results({ contents: result.automaticFunctionCallingHistory }).find(value => value.name === 'read_logs').response.output, source);
  }
  assert.equal(fixture.state.calls.length, 3); assert.deepEqual(fixture.state.errors, []);
  assert.deepEqual(input, before); assert.equal(config.tools.length, 1); assert.equal(read.original.functionResponse.response.output, source);
  const second = fixture.state.calls[1].body;
  assert.equal(second.contents[1].parts[0].thoughtSignature, 'c2lnbmF0dXJl');
  assert.deepEqual(second.tools, fixture.state.calls[2].body.tools);
  assert.ok(fixture.state.calls.every(call => call.headers['x-goog-api-key'] === 'local-google-token' && !call.headers['x-cave-transforms']));
  if (chat) assert.equal(results({ contents: chat.getHistory() }).find(value => value.name === 'read_logs').response.output, source);
});

test('Google model-only, cached/unknown/media, structured and forced-tool requests keep native contracts', { timeout: 30000 }, async t => {
  const service = await startRuntime(); t.after(service.stop);
  const runtime = createMiddlewareRuntime({ endpoint: service.endpoint }); t.after(() => runtime.close()); await runtime.ready();
  const fixture = await provider(t), original = new GoogleGenAI(fixture.options), client = new CavemanGoogleGenAI(fixture.options, { runtime, scope: scope('protected') });
  const binding = runtime.recovery(scope('protected'));
  const contents = [{ role: 'model', parts: [{ functionCall: { name: 'read_logs', args: {} }, thoughtSignature: 'c2ln' }] }, { role: 'user', parts: [{ functionResponse: { name: 'read_logs', response: { output: source } } }, { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } }, { fileData: { mimeType: 'audio/wav', fileUri: 'gs://fixture/audio.wav' } }] }];
  for (const config of [
    { tools: [{ functionDeclarations: [{ name: binding.name, description: binding.description, parametersJsonSchema: binding.inputSchema }] }] },
    { cachedContent: 'cachedContents/opaque-provider-id' },
    { responseMimeType: 'application/json', responseJsonSchema: { type: 'object', properties: { answer: { type: 'string' } } } },
    { tools: [readTool().tool], toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['read_logs'] } }, automaticFunctionCalling: { disable: true } },
    { httpOptions: { extraBody: { futureGoogleField: { untouched: ['value', 7] } } } },
  ]) {
    const params = { model: 'helpers', contents, config };
    await original.models.generateContent(params); const baseline = fixture.state.calls.at(-1).raw;
    const result = await client.models.generateContent(params); assert.ok(result instanceof GenerateContentResponse);
    assert.equal(fixture.state.calls.at(-1).raw, baseline, 'untouched native serialized request is byte-identical');
    assert.equal(results(fixture.state.calls.at(-1).body)[0].response.output, source);
  }
  assert.deepEqual(fixture.state.errors, []);
});

for (const mode of ['off', 'outage']) test(`Google ${mode} preserves all native AFC methods and provider call count`, { timeout: 30000 }, async t => {
  const runtime = createMiddlewareRuntime({ endpoint: 'http://127.0.0.1:1', mode: mode === 'off' ? 'off' : 'compress' }); t.after(() => runtime.close());
  const fixture = await provider(t), client = new CavemanGoogleGenAI(fixture.options, { runtime, scope: scope(mode) });
  for (const operation of ['generate', 'stream', 'chat', 'chat-stream']) {
    const config = { tools: [readTool().tool] }, chat = client.chats.create({ model: 'baseline', config });
    let result;
    if (operation.endsWith('stream')) {
      const stream = operation.startsWith('chat') ? await chat.sendMessageStream({ message: 'Read logs.' }) : await client.models.generateContentStream({ model: 'baseline', contents: 'Read logs.', config });
      for await (const chunk of stream) result = chunk;
    } else result = operation === 'chat' ? await chat.sendMessage({ message: 'Read logs.' }) : await client.models.generateContent({ model: 'baseline', contents: 'Read logs.', config });
    assert.equal(result.text, 'omitted-detail-80');
  }
  assert.equal(fixture.state.calls.length, 8); assert.deepEqual(fixture.state.errors, []);
});

test('Google Vertex uses native project, location and OAuth client without changing auth', { timeout: 30000 }, async t => {
  const service = await startRuntime(); t.after(service.stop);
  const runtime = createMiddlewareRuntime({ endpoint: service.endpoint }); t.after(() => runtime.close()); await runtime.ready();
  const fixture = await provider(t), authClient = new OAuth2Client();
  authClient.setCredentials({ access_token: 'local-fixture-oauth', expiry_date: Date.now() + 3600000 });
  const nativeOptions = { vertexai: true, project: 'fixture-project', location: 'europe-west4', googleAuthOptions: { authClient }, httpOptions: fixture.options.httpOptions };
  const baseline = new GoogleGenAI(nativeOptions), client = new CavemanGoogleGenAI(nativeOptions, { runtime, scope: scope('vertex') });
  const params = { model: 'helpers', contents: 'Native Vertex auth seam.' };
  await baseline.models.generateContent(params); const original = fixture.state.calls.at(-1);
  const result = await client.models.generateContent(params); const changed = fixture.state.calls.at(-1);
  assert.ok(result instanceof GenerateContentResponse); assert.equal(result.text, 'native');
  assert.equal(changed.raw, original.raw); assert.equal(changed.url, original.url);
  assert.equal(changed.headers.authorization, 'Bearer local-fixture-oauth');
  assert.equal(changed.headers.authorization, original.headers.authorization);
  assert.equal(client.vertexai, true); assert.deepEqual(fixture.state.errors, []);
});

test('Google native provider failure, early stream return and abort do not replay inference', { timeout: 30000 }, async t => {
  const runtime = createMiddlewareRuntime({ endpoint: 'http://127.0.0.1:1' }); t.after(() => runtime.close());
  const fixture = await provider(t), client = new CavemanGoogleGenAI(fixture.options, { runtime, scope: scope('cancel') });
  await assert.rejects(client.models.generateContent({ model: 'failure', contents: 'fail' }), error => error.status === 503);
  assert.equal(fixture.state.calls.length, 1);
  const stream = await client.models.generateContentStream({ model: 'cancel', contents: 'stream' });
  assert.equal((await stream.next()).value.text, 'first-'); assert.equal(fixture.state.released, false);
  await stream.return();
  for (let i = 0; i < 100 && !fixture.state.closed; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(fixture.state.closed, true); assert.equal(fixture.state.calls.length, 2);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(client.models.generateContent({ model: 'helpers', contents: 'never sent', config: { abortSignal: abort.signal } }), error => error.name === 'AbortError');
  assert.equal(fixture.state.calls.length, 2);
});
