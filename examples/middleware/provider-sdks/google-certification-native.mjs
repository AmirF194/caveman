/** Native Google/Vertex AFC operations against a deterministic loopback provider. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { OAuth2Client } from 'google-auth-library';
import { createMiddlewareRuntime } from '../../../packages/sdk/typescript/dist/middleware/index.js';
import { CavemanGoogleGenAI } from '../../../packages/middleware/typescript/dist/google.js';
import { beginNativeCertification, emitJourney } from './google-certification-evidence.mjs';

const SOURCE = Array.from({ length: 160 }, (_, i) => `[INFO] café 🌍 row ${i} retained-detail-${i} verbose repeated diagnostic data\r\n`).join('');
const FACT = 'retained-detail-80';
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const HASH = digest(SOURCE);
const values = contents => Object.fromEntries(contents.flatMap(content => content.parts ?? []).filter(part => part.functionResponse).map(part => [part.functionResponse.name, part.functionResponse.response]));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const eventKinds = chunk => (chunk.candidates ?? []).flatMap(candidate => candidate.content?.parts ?? []).map(part => part.functionCall ? `function_call:${part.functionCall.name}` : part.functionResponse ? `function_response:${part.functionResponse.name}` : typeof part.text === 'string' ? 'text' : 'opaque');
const response = (parts, terminal = true) => ({ candidates: [{ content: { role: 'model', parts }, ...(terminal ? { finishReason: 'STOP' } : {}), index: 0 }],
  ...(terminal ? { usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 20, cachedContentTokenCount: 200, thoughtsTokenCount: 3, totalTokenCount: 1023 } } : {}), responseId: 'google-certification-fixture', modelVersion: 'native-fixture-model' });

async function providerFixture(cancelled) {
  const calls = [], errors = [], closures = [], release = deferred(); let released = !cancelled;
  if (released) release.resolve();
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf8'), body = JSON.parse(raw), closure = deferred();
      calls.push({ body, raw, headers: req.headers, path: req.url }); closures.push(closure);
      res.on('close', () => closure.resolve({ beforeRelease: !released }));
      const found = values(body.contents); let parts;
      if (req.url.includes('fixture-structured')) parts = [{ text: JSON.stringify({ answer: FACT }) }];
      else if (req.url.includes('fixture-cached')) parts = [{ text: 'native-cached' }];
      else if (!found.read_logs) parts = [{ functionCall: { name: 'read_logs', args: {} }, thoughtSignature: 'c2lnbmF0dXJl' }];
      else {
        const projected = found.read_logs.output, handle = projected.match(/cmw_[a-f0-9]{48}/)?.[0];
        if (handle && !found.caveman_retrieve) {
          assert.ok(!projected.includes(FACT)); assert.ok(body.tools.flatMap(tool => tool.functionDeclarations ?? []).some(tool => tool.name === 'caveman_retrieve'));
          parts = [{ functionCall: { name: 'caveman_retrieve', args: { handle } } }];
        } else { assert.equal(found.caveman_retrieve ? found.caveman_retrieve.output.text : projected, SOURCE); parts = [{ text: FACT }]; }
      }
      const streaming = req.url.includes('streamGenerateContent'); res.writeHead(200, { 'content-type': streaming ? 'text/event-stream' : 'application/json', 'x-fixture': 'google-certification' });
      if (!streaming) return res.end(JSON.stringify(response(parts)));
      const send = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
      if (typeof parts[0].text === 'string') { send(response(parts, false)); await release.promise; send(response([{ text: '' }])); }
      else send(response(parts));
      res.end();
    } catch (error) { errors.push(error.message); res.destroy(error); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { calls, errors, closures, url: `http://127.0.0.1:${server.address().port}`, get released() { return released; },
    async close() { released = true; release.resolve(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

function tool(executions) {
  const original = { functionResponse: { name: 'read_logs', response: { output: SOURCE, metadata: { source: 'diagnostic.log' } } } };
  return { original, callable: {
    async tool() { return { functionDeclarations: [{ name: 'read_logs', description: 'Read diagnostics', parametersJsonSchema: { type: 'object', properties: {} } }] }; },
    async callTool(calls) { const selected = calls.filter(call => call.name === 'read_logs'); for (const call of selected) executions.push(call.args); return selected.map(() => original); },
  } };
}
function nativeOptions(provider, vertex) {
  const httpOptions = { baseUrl: provider.url, headers: { 'x-original-option': 'preserved' }, retryOptions: { attempts: 1 } };
  if (!vertex) return { apiKey: 'local-google-token', httpOptions };
  const authClient = new OAuth2Client(); authClient.setCredentials({ access_token: 'local-fixture-oauth', expiry_date: Date.now() + 3600000 });
  return { vertexai: true, project: 'fixture-project', location: 'europe-west4', googleAuthOptions: { authClient }, httpOptions };
}

async function runCase(cell, mode, endpoint, nativeTypes) {
  const { GoogleGenAI, GenerateContentResponse, Chat } = nativeTypes;
  const vertex = cell.provider === 'vertex', cancelled = cell.method === 'cancel_and_close', modelOnly = cell.recovery === 'model_only', structured = cell.structured_output, cached = cell.method === 'cachedContent.opaque';
  const provider = await providerFixture(cancelled), plans = [], receipts = [], reports = [];
  const runtime = createMiddlewareRuntime({ endpoint: mode === 'outage' ? 'http://127.0.0.1:1' : endpoint, mode: mode === 'off' ? 'off' : 'compress', deadlineMs: mode === 'outage' ? 200 : 3000, onReport: report => reports.push(report) });
  const optimize = runtime.optimize.bind(runtime), observe = runtime.observe.bind(runtime);
  runtime.optimize = async options => { const value = await optimize(options); plans.push({ options, value }); return value; };
  runtime.observe = receipt => { receipts.push(receipt); return observe(receipt); };
  try {
    if (mode === 'compress') await runtime.ready();
    const options = nativeOptions(provider, vertex), original = new GoogleGenAI(options), client = new CavemanGoogleGenAI(options, { runtime, scope: { namespace: 'google-certification', session_id: digest(cell.id + mode), branch_id: 'main', cache_epoch: '0' } });
    assert.ok(client instanceof GoogleGenAI); if (vertex) assert.equal(client.vertexai, true);
    const sourceCalls = [], source = tool(sourceCalls), contents = [{ role: 'user', parts: [{ text: 'Find retained-detail-80.' }] }];
    let config = { tools: [source.callable], temperature: 0.2, systemInstruction: 'Read exact logs.', safetySettings: [{ category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' }] };
    if (modelOnly) {
      const result = await original.models.generateContent({ model: 'fixture-read', contents, config: { tools: [await source.callable.tool()], automaticFunctionCalling: { disable: true } } });
      assert.deepEqual(result.functionCalls.map(call => ({ name: call.name, args: call.args })), [{ name: 'read_logs', args: {} }]);
      contents.push(result.candidates[0].content, { role: 'user', parts: await source.callable.callTool(result.functionCalls) });
      config = structured ? { responseMimeType: 'application/json', responseJsonSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } } : { cachedContent: 'cachedContents/opaque-fixture' };
    }
    const before = structuredClone(contents), model = structured ? 'fixture-structured' : cached ? 'fixture-cached' : 'fixture-loop';
    const chat = cell.method.startsWith('chats.') ? client.chats.create({ model, config }) : null;
    if (chat) assert.ok(chat instanceof Chat);
    let result, final, retained; const events = [];
    if (cell.streaming) {
      const abort = new AbortController(), selectedConfig = cancelled ? { ...config, abortSignal: abort.signal } : config;
      const stream = chat ? await chat.sendMessageStream({ message: contents[0].parts }) : await client.models.generateContentStream({ model, contents, config: selectedConfig });
      for await (const event of stream) {
        assert.ok(event instanceof GenerateContentResponse); events.push(event);
        if (cancelled && event.candidates?.[0]?.content?.parts?.some(part => part.text === FACT)) {
          abort.abort(); await stream.return(); break;
        }
      }
      result = events.at(-1); final = events.flatMap(event => event.candidates ?? []).flatMap(candidate => candidate.content?.parts ?? []).filter(part => typeof part.text === 'string').map(part => part.text).join('');
      retained = chat ? chat.getHistory() : events.flatMap(event => event.candidates ?? []).map(candidate => candidate.content).filter(Boolean);
      if (cancelled) {
        assert.equal(provider.released, false);
        const closed = await Promise.race([provider.closures.at(-1).promise, new Promise(resolve => setTimeout(() => resolve(null), 500))]);
        assert.equal(closed?.beforeRelease, true);
        if (mode === 'compress') { assert.equal(receipts.at(-1).event_kind, 'cancelled'); assert.equal(receipts.at(-1).usage, null); }
      }
    } else {
      result = chat ? await chat.sendMessage({ message: contents[0].parts }) : await client.models.generateContent({ model, contents, config });
      assert.ok(result instanceof GenerateContentResponse); final = structured ? JSON.parse(result.text) : result.text;
      retained = modelOnly ? contents : chat ? chat.getHistory() : result.automaticFunctionCallingHistory;
    }
    assert.deepEqual(final, structured ? { answer: FACT } : cached ? 'native-cached' : FACT); assert.deepEqual(sourceCalls, [{}]);
    assert.deepEqual(contents, before); assert.equal(source.original.functionResponse.response.output, SOURCE); if (!modelOnly) assert.deepEqual(config.tools, [source.callable]);
    const history = values(retained); assert.equal(history.read_logs.output, SOURCE); assert.deepEqual(provider.errors, []);
    assert.equal(provider.calls.length, modelOnly || mode !== 'compress' ? 2 : 3);
    const projected = values(provider.calls[1].body.contents).read_logs.output, recovered = values(provider.calls.at(-1).body.contents).caveman_retrieve;
    if (modelOnly || mode !== 'compress') { assert.equal(projected, SOURCE); assert.equal(recovered, undefined); assert.ok(plans.every(plan => plan.value.replacements.length === 0)); }
    else { assert.ok(!projected.includes(FACT) && projected.includes('cmw_')); assert.equal(recovered.output.text, SOURCE); assert.ok(plans.some(plan => plan.value.replacements.length)); }
    if (modelOnly) assert.ok(plans.every(plan => plan.options.binding === null));
    if (cached) { assert.equal(plans.length, 0); assert.ok(provider.calls.at(-1).body.cachedContent.endsWith('opaque-fixture')); }
    if (mode === 'off') assert.equal(plans.length, 0);
    if (mode === 'outage' && !cached) assert.ok(plans.some(plan => plan.value.reason === 'runtime_unavailable'));
    const expectedReports = provider.calls.length - Number(modelOnly);
    assert.equal(reports.length, expectedReports);
    assert.equal(new Set(reports.map(report => report.attempt_id)).size, expectedReports);
    assert.ok(reports.every(report => report.adapter === 'google-sdk' && Object.isFrozen(report)));
    assert.equal(reports.reduce((sum, report) => sum + report.replacement_count, 0), plans.reduce((sum, plan) => sum + plan.value.replacements.length, 0));
    if (mode === 'off') assert.ok(reports.every(report => report.status === 'disabled' && report.transform_ids.length === 0));
    for (const call of provider.calls) {
      assert.equal(call.headers['x-original-option'], 'preserved'); assert.equal(vertex ? call.headers.authorization : call.headers['x-goog-api-key'], vertex ? 'Bearer local-fixture-oauth' : 'local-google-token');
      if (!modelOnly) { assert.equal(call.body.generationConfig.temperature, 0.2); assert.equal(call.body.systemInstruction.parts[0].text, 'Read exact logs.'); }
    }
    if (!modelOnly) assert.equal(provider.calls[1].body.contents[1].parts[0].thoughtSignature, 'c2lnbmF0dXJl');
    return { final_value: final, native_type: result.constructor.name, event_order: events.map(eventKinds), provider_calls: provider.calls.length,
      source_executions: sourceCalls.length, stored_source_sha256: digest(history.read_logs.output), optimize_invocations: plans.length, native_call_reports: reports.map(report => report.status), recovery_requests: Number(recovered !== undefined),
      replacements: plans.reduce((n, plan) => n + plan.value.replacements.length, 0), recovered_sha256: recovered ? digest(recovered.output.text) : null,
      request_sha256: modelOnly ? digest(provider.calls.at(-1).raw) : null, native_input_sha256: digest(before), cancelled_before_fixture_eof: cancelled,
      lifecycle_action: cancelled ? 'native_abort_signal_then_return' : 'complete', auth_modes: provider.calls.map(() => vertex ? 'oauth_fixture' : 'api_key_fixture'),
      provider_paths: provider.calls.map(call => call.path), configured_vertex: vertex,
      history_surface: modelOnly ? 'input_function_response' : chat ? 'native_chat_history' : cell.streaming ? 'native_stream_function_response_event' : 'automatic_function_calling_history' };
  } finally { runtime.close(); await provider.close(); }
}

export async function certifyGoogleCells(t, provider, endpoint, nativeTypes) {
  const response = await fetch(`${endpoint}/caveman/v1/middleware/capabilities`); assert.equal(response.status, 200); await beginNativeCertification(t, await response.json());
  const fixture = JSON.parse(await readFile(new URL('./google-certification-cells.json', import.meta.url), 'utf8'));
  if (process.env.CAVEMAN_MIDDLEWARE_PACKAGED_TEST !== '1') {
    const { requiredCells } = await import('../../../packages/middleware/conformance/support/catalog.mjs');
    assert.deepEqual(fixture.cells, requiredCells().filter(cell => cell.family === 'F03' && cell.language === 'typescript'));
  }
  const cells = fixture.cells.filter(cell => cell.provider === provider); assert.equal(cells.length, 8);
  for (const cell of cells) {
    const rows = {}; for (const mode of ['compress', 'off', 'outage']) rows[mode] = await runCase(cell, mode, endpoint, nativeTypes);
    const { compress: current, off, outage: unavailable } = rows; assert.deepEqual(current.final_value, off.final_value); assert.deepEqual(current.final_value, unavailable.final_value);
    let noRecovery;
    if (cell.recovery === 'model_only') {
      for (const baseline of [off, unavailable]) { assert.equal(current.request_sha256, baseline.request_sha256); assert.deepEqual(current.event_order, baseline.event_order); }
      noRecovery = { outcome: 'recovery_free', reason: cell.method === 'cachedContent.opaque' ? 'opaque cached content' : 'native structured-output contract', recovery_requests: 0, replacements: 0, original_provider_source_sha256: HASH, request_sha256: current.request_sha256 };
    }
    const fields = (row, keys) => Object.fromEntries(keys.map(key => [key, row[key]]));
    const baseline = row => ({ outcome: 'observed', ...fields(row, ['final_value', 'provider_calls', 'optimize_invocations', 'native_call_reports', 'recovery_requests', 'stored_source_sha256', 'cancelled_before_fixture_eof', 'lifecycle_action']) });
    emitJourney(t, cell, {
      native_application: { outcome: 'observed', method: cell.method, execution: 'async', provider, execution_owner: noRecovery ? 'application_source_dispatch' : 'native_afc', live_provider_auth_verified: false, ...fields(current, ['auth_modes', 'provider_paths', 'configured_vertex']) },
      real_tool_result: { outcome: 'observed', executor: 'read_logs', executions: current.source_executions, sha256: HASH, utf8_bytes: Buffer.byteLength(SOURCE) },
      transformed_provider_request: noRecovery ?? { outcome: 'observed', replacement_count: current.replacements, omitted_fact_absent: true, stored_source_sha256: current.stored_source_sha256 },
      omitted_fact_requested: noRecovery ?? { outcome: 'observed', fact: FACT, native_recovery_function: 'caveman_retrieve', recovery_requests: current.recovery_requests },
      host_executes_exact_recovery: noRecovery ?? { outcome: 'observed', execution_owner: 'native_afc', source_sha256: HASH, recovered_sha256: current.recovered_sha256 },
      native_result_history_events_and_call_count: { outcome: 'observed', ...fields(current, ['native_type', 'final_value', 'event_order', 'provider_calls', 'native_call_reports', 'stored_source_sha256', 'native_input_sha256', 'history_surface', 'cancelled_before_fixture_eof', 'lifecycle_action']) },
      off_baseline: baseline(off), optimizer_unavailable: baseline(unavailable),
    });
  }
}
