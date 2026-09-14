/** Native operation journeys against local HTTP providers and the real Engine. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createAgent, humanInTheLoopMiddleware } from 'langchain';
import { MemorySaver, Command } from '@langchain/langgraph';
import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { HumanMessage, AIMessage, ToolMessage, isAIMessage } from '@langchain/core/messages';
import { BaseRetriever } from '@langchain/core/retrievers';
import { Document } from '@langchain/core/documents';
import { tool } from '@langchain/core/tools';
import { createMiddlewareRuntime } from '../../../packages/sdk/typescript/dist/middleware/index.js';
import { withCavemanAgent, withCavemanModel, scopeFromConfig, CavemanDocumentCompressor } from '../../../packages/middleware/typescript/dist/langchain.js';
import { startRuntime } from '../../../packages/middleware/conformance/runtime-fixture.mjs';
import { fixtureCells, packaged, selectedFamily, beginNativeCertification, emitJourney } from './certification-evidence.mjs';

const SOURCE = Array.from({ length: 140 }, (_, i) => `[INFO] café 🌍 row ${i} retained-detail-${i} long repeated diagnostic\r\n`).join('');
const FACT = 'retained-detail-70';
const EDITED = SOURCE + '[INFO] application edited this source after checkpoint\r\n';
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const viewDigest = value => digest(value.replace(/cmw_[a-f0-9]{48}/g, 'cmw_OPAQUE_HANDLE'));
const text = message => typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text).join('');
const docs = () => [new Document({ id: 'source-a', pageContent: SOURCE, metadata: { citation: 'a.md', page: 1 } }), new Document({ id: 'source-b', pageContent: SOURCE, metadata: { citation: 'b.md', page: 2 } }), new Document({ id: 'source-c', pageContent: 'Short source.', metadata: { citation: 'c.md' } })];
const docView = values => values.map(d => ({ id: d.id, text: d.pageContent, metadata: d.metadata }));
const results = (body, protocol) => protocol === 'openai' ? body.messages.filter(m => m.role === 'tool') : body.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(part => part.type === 'tool_result');
const resultId = part => part.tool_call_id ?? part.tool_use_id;

async function providerFixture(protocol, { compressed, parallel = false, rag = false } = {}) {
  const state = { calls: [], responses: [], errors: [], handles: [], expectedSource: SOURCE, released: false, finished: false, streamed: 0 };
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); state.calls.push(body);
      const history = results(body, protocol), count = parallel ? 2 : 1;
      const sourceResults = rag ? history.filter(part => resultId(part) === 'search-1') : history.filter(part => /^read-[12]$/.test(resultId(part)));
      let calls = [], answer = null;
      if (body.model === 'structured') {
        const schema = body.tools?.find(item => (item.function?.name ?? item.name) !== 'read_logs');
        if (schema && !(body.response_format || body.output_config)) calls = [{ id: 'typed-1', name: schema.function?.name ?? schema.name, args: { answer: FACT } }];
        else answer = JSON.stringify({ answer: FACT });
      } else if (body.model === 'model') answer = FACT;
      else if (sourceResults.length < count) calls = rag ? [{ id: 'search-1', name: 'search_documents', args: { query: 'Read row 70' } }] : Array.from({ length: count }, (_, index) => ({ id: `read-${index + 1}`, name: 'read_logs', args: { slot: index } }));
      else {
        const values = rag ? JSON.parse(sourceResults[0].content).slice(0, 2).map(d => d.text) : sourceResults.map(part => part.content);
        if (rag) assert.deepEqual(JSON.parse(sourceResults[0].content).map(d => [d.id, d.metadata]), docs().map(d => [d.id, d.metadata]));
        if (!compressed || body.model === 'bootstrap') {
          assert.ok(values.every(value => value === state.expectedSource)); answer = FACT;
        } else {
          const handles = values.map(value => value.match(/cmw_[a-f0-9]{48}/)?.[0]);
          assert.ok(handles.every(Boolean), 'The actual provider request contains scoped views');
          assert.ok(values.every(value => !value.includes(FACT)), 'The requested fact is absent from each view');
          if (handles.length > 1) assert.equal(new Set(handles).size, handles.length);
          state.handles.push(...handles);
          calls = handles.flatMap((handle, index) => {
            const recovered = history.find(part => { try { return JSON.parse(part.content).handle === handle; } catch { return false; } });
            if (!recovered) return [{ id: `recover-${body.messages.length}-${index}`, name: 'caveman_retrieve', args: { handle } }];
            const page = JSON.parse(recovered.content); assert.equal(page.text, state.expectedSource); assert.equal(page.original_sha256, digest(state.expectedSource)); assert.equal(page.complete, true);
            return [];
          });
          if (!calls.length) answer = FACT;
        }
      }
      state.responses.push({ calls, answer });
      const id = `native-cert-${state.calls.length}`;
      if (protocol === 'openai') {
        const base = { id, model: body.model, created: 1 };
        if (body.stream) {
          state.streamed++; res.writeHead(200, { 'content-type': 'text/event-stream' });
          const event = (delta, finish_reason = null) => `data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
          if (calls.length) res.write(event({ role: 'assistant', tool_calls: calls.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) }));
          else {
            res.write(event({ role: 'assistant', content: 'retained-' }));
            const deadline = Date.now() + 10000; while (!state.released && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
            assert.ok(state.released, 'Native consumer receives the first text before fixture EOF'); state.finished = true;
            res.write(event({ content: 'detail-70' }));
          }
          res.end(event({}, calls.length ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n'); return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: answer, ...(calls.length ? { tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : {}) }, finish_reason: calls.length ? 'tool_calls' : 'stop', logprobs: null }], usage: { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020 } }));
      } else {
        const message = { id, type: 'message', role: 'assistant', model: body.model, content: calls.length ? calls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.args })) : [{ type: 'text', text: answer }], stop_reason: calls.length ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 20 } };
        if (body.stream) {
          state.streamed++; res.writeHead(200, { 'content-type': 'text/event-stream' });
          const event = (type, fields = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
          res.write(event('message_start', { message: { ...message, content: [], stop_reason: null } }));
          for (const [index, part] of message.content.entries()) {
            if (part.type === 'tool_use') {
              res.write(event('content_block_start', { index, content_block: { ...part, input: {} } }));
              res.write(event('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(part.input) } }));
            } else {
              res.write(event('content_block_start', { index, content_block: { type: 'text', text: '' } }));
              res.write(event('content_block_delta', { index, delta: { type: 'text_delta', text: 'retained-' } }));
              const deadline = Date.now() + 10000; while (!state.released && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
              assert.ok(state.released, 'Native consumer receives the first text before fixture EOF'); state.finished = true;
              res.write(event('content_block_delta', { index, delta: { type: 'text_delta', text: 'detail-70' } }));
            }
            res.write(event('content_block_stop', { index }));
          }
          res.end(event('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 20 } }) + event('message_stop')); return;
        }
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(message));
      }
    } catch (error) { state.errors.push(error.stack); res.destroy(error); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { state, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

function modelFor(protocol, provider, model = 'loop') {
  return protocol === 'openai' ? new ChatOpenAI({ model, apiKey: 'fixture', configuration: { baseURL: provider.url + '/v1' }, maxRetries: 0, useResponsesApi: false }) : new ChatAnthropic({ model, apiKey: 'fixture', clientOptions: { baseURL: provider.url }, maxRetries: 0, maxTokens: 200 });
}
function capturedRuntime(service, mode) {
  const reports = [];
  const runtime = createMiddlewareRuntime({ endpoint: mode === 'outage' ? 'http://127.0.0.1:1' : service.endpoint, mode: mode === 'off' ? 'off' : 'compress', deadlineMs: 3000, onReport: report => reports.push(report) });
  const plans = [], pages = [], receipts = [];
  const optimize = runtime.optimize.bind(runtime), retrieve = runtime.retrieve.bind(runtime), observe = runtime.observe.bind(runtime);
  runtime.optimize = async options => { const result = await optimize(options); plans.push({ options, result }); return result; };
  runtime.retrieve = async (...args) => { const page = await retrieve(...args); pages.push(page); return page; };
  runtime.observe = async receipt => { receipts.push(receipt); return observe(receipt); };
  return { runtime, plans, pages, receipts, reports };
}
function reportSummary(capture, calls, rag = false) {
  const { runtime, reports, plans, receipts } = capture;
  assert.equal(reports.length, calls, 'Exactly one metadata report per native model or compressor call');
  assert.equal(runtime.lastReport, reports.at(-1));
  if (!rag) assert.equal(new Set(reports.map(report => report.attempt_id)).size, calls);
  assert.ok(reports.every(report => Object.isFrozen(report) && Object.isFrozen(report.transform_ids)));
  assert.ok(reports.every(report => report.adapter === (rag ? 'langchain-rag' : 'langchain')));
  assert.ok(!JSON.stringify(reports).includes(SOURCE));
  const replacements = plans.reduce((sum, plan) => sum + plan.result.replacements.length, 0);
  assert.equal(reports.reduce((sum, report) => sum + report.replacement_count, 0), replacements);
  if (runtime.mode === 'off') { assert.ok(reports.every(report => report.status === 'disabled')); assert.deepEqual(plans, []); assert.deepEqual(receipts, []); }
  else if (replacements) { assert.ok(reports.some(report => report.status === 'applied')); if (!rag) assert.ok(reports.some(report => report.status === 'reused')); }
  return { count: reports.length, statuses: reports.map(report => report.status).sort(), replacement_count: replacements, source_content_absent: true };
}
const configFor = (cell, suffix = '') => ({ configurable: { thread_id: digest(cell.id + suffix) }, tags: ['native-caller-tag'], metadata: { caller: 'unchanged' } });
const inputFor = suffix => ({ messages: [new HumanMessage({ content: 'Read row 70 ' + suffix, id: 'caller-' + suffix })] });
const scoped = config => scopeFromConfig(config, 'langchain-exact-ts');
function readTool(reads, parallel = false) {
  let release;
  const together = new Promise(resolve => { release = resolve; });
  return tool(async ({ slot }) => {
    const entry = { slot, text: SOURCE }; reads.push(entry);
    if (parallel) {
      if (reads.length === 2) release();
      let timer;
      try { await Promise.race([together, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Native tool batch did not overlap')), 5000); })]); }
      finally { clearTimeout(timer); }
      entry.overlap = true;
    }
    return SOURCE;
  }, { name: 'read_logs', description: 'Read original application logs.', schema: { type: 'object', properties: { slot: { type: 'integer' } }, required: ['slot'], additionalProperties: false } });
}
async function collectNative(stream, state, graph) {
  let answer = ''; const events = [];
  for await (const event of stream) {
    const message = graph ? event[0] : event;
    if (!isAIMessage(message)) continue;
    events.push(message.constructor.name);
    const value = text(message); if (value === 'retained-') { assert.equal(state.finished, false); state.released = true; }
    answer += value;
  }
  assert.equal(answer, FACT); assert.ok(events.length > 1); assert.equal(state.finished, true); return events;
}

async function modelCase(cell, mode, service) {
  const provider = await providerFixture(cell.provider, { compressed: false });
  const capture = capturedRuntime(service, mode), { runtime, plans, pages } = capture;
  try {
    const reads = [], reader = readTool(reads), bootstrap = createAgent({ model: modelFor(cell.provider, provider, 'bootstrap'), tools: [reader] });
    const original = await bootstrap.invoke(inputFor('bootstrap'));
    const messages = original.messages.slice(0, -1), before = messages.map(message => message.toDict());
    const native = withCavemanModel(modelFor(cell.provider, provider, cell.structured_output ? 'structured' : 'model'), { runtime, scope: scoped });
    const config = configFor(cell), start = provider.state.calls.length;
    let value, events = [];
    if (cell.method === 'chat_model.invoke') value = await native.invoke(messages, config);
    else if (cell.method === 'chat_model.batch') value = await native.batch([messages, messages], [config, configFor(cell, '-batch')]);
    else if (cell.method === 'chat_model.bindTools') value = await native.bindTools([reader]).invoke(messages, config);
    else if (cell.method === 'chat_model.withStructuredOutput') value = await native.withStructuredOutput({ title: 'Answer', type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false }, { name: 'Answer', ...(cell.provider === 'openai' ? { method: 'jsonSchema' } : {}) }).invoke(messages, config);
    else if (cell.method === 'chat_model.stream') { events = await collectNative(await native.stream(messages, config), provider.state, false); value = FACT; }
    else throw new Error(`No native model operation ${cell.method}`);
    if (cell.structured_output) assert.deepEqual(value, { answer: FACT });
    else if (Array.isArray(value)) assert.deepEqual(value.map(text), [FACT, FACT]);
    else if (!cell.streaming) { assert.ok(isAIMessage(value)); assert.equal(text(value), FACT); }
    assert.equal(reads.length, 1); assert.equal(reads[0].text, SOURCE); assert.deepEqual(messages.map(message => message.toDict()), before);
    const targetCalls = provider.state.calls.slice(start); assert.equal(targetCalls.length, cell.execution === 'batch' ? 2 : 1);
    for (const body of targetCalls) assert.equal(results(body, cell.provider).find(part => resultId(part) === 'read-1').content, SOURCE);
    assert.ok(plans.every(plan => plan.result.replacements.length === 0 && plan.options.binding === null)); assert.equal(pages.length, 0); assert.deepEqual(provider.state.errors, []);
    if (cell.execution === 'batch' && mode !== 'off') assert.equal(new Set(plans.map(plan => plan.options.scope.session_id)).size, 2, 'Each native batch item resolves its own scope');
    return { source_executions: 1, provider_calls: provider.state.calls.length, target_provider_calls: targetCalls.length, recovery_requests: 0, replacements: 0,
      target_request_sha256: targetCalls.map(body => digest(body)).sort(), source_sha256: digest(SOURCE), source_bytes: Buffer.byteLength(SOURCE), original_history: true,
      native_type: cell.structured_output ? 'structured_object' : Array.isArray(value) ? 'AIMessage[]' : cell.streaming ? 'AIMessageChunk stream' : value.constructor.name,
      native_value: cell.structured_output ? value : FACT, stream_events: events, stream_delivered_before_eof: cell.streaming,
      extra: { native_reports: reportSummary(capture, targetCalls.length), ...(cell.execution === 'batch' ? { separate_batch_item_scopes: true } : {}) } };
  } finally { await runtime.close(); await provider.close(); }
}

class ApplicationRetriever extends BaseRetriever {
  lc_namespace = ['application', 'certification-retriever']; documents = docs(); calls = [];
  async _getRelevantDocuments(query) { this.calls.push(query); return this.documents; }
}
async function ragCase(cell, mode, service) {
  const expansion = cell.recovery === 'operator_bound', compressed = expansion && mode === 'compress';
  const provider = await providerFixture(cell.provider, { compressed, rag: true });
  const capture = capturedRuntime(service, mode), { runtime, plans, pages } = capture;
  try {
    const config = configFor(cell), scope = scoped(config), retriever = new ApplicationRetriever({}), views = [], reader = runtime.recovery(scope);
    const compressor = new CavemanDocumentCompressor({ runtime, scope, ...(expansion ? { sourceExpansion: reader } : {}) });
    const search = tool(async ({ query }, config) => { const original = await retriever.invoke(query, config), view = await compressor.compressDocuments(original, query); views.push(view); return [JSON.stringify(docView(view)), original]; },
      { name: 'search_documents', description: 'Search original application documents.', responseFormat: 'content_and_artifact', schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } });
    const expand = tool(async (args, config) => JSON.stringify(await reader.execute(args, { signal: config?.signal })), { name: reader.name, description: reader.description, schema: structuredClone(reader.inputSchema) });
    const agent = createAgent({ model: modelFor(cell.provider, provider), tools: [search, ...(expansion ? [expand] : [])] });
    const value = await agent.invoke(inputFor('rag'), config); assert.equal(text(value.messages.at(-1)), FACT);
    assert.equal(retriever.calls.length, 1); assert.deepEqual(retriever.documents, docs()); assert.ok(views[0].every(d => d instanceof Document));
    assert.deepEqual(views[0].map(d => [d.id, d.metadata]), docs().map(d => [d.id, d.metadata]));
    assert.deepEqual(value.messages.find(message => message.name === 'search_documents').artifact, docs());
    assert.equal(provider.state.calls.length, compressed ? 3 : 2); assert.equal(pages.length, compressed ? 2 : 0); assert.deepEqual(provider.state.errors, []);
    if (compressed) { assert.deepEqual(pages.map(page => page.source_id).sort(), ['source-a', 'source-b']); assert.equal(new Set(pages.map(page => page.handle)).size, 2); for (const page of pages) assert.equal(page.text, SOURCE); }
    else { assert.deepEqual(views[0], retriever.documents); assert.ok(plans.every(plan => plan.result.replacements.length === 0)); }
    return { source_executions: 1, provider_calls: provider.state.calls.length, recovery_requests: pages.length, replacements: plans.reduce((sum, plan) => sum + plan.result.replacements.length, 0), source_sha256: digest(SOURCE), source_bytes: Buffer.byteLength(SOURCE), original_history: true,
      native_type: 'Document[] and native agent ToolMessage.artifact', native_value: FACT, stream_events: [], stream_delivered_before_eof: false,
      ...(cell.recovery === 'model_only' ? { target_request_sha256: provider.state.calls.map(body => digest(body)) } : {}),
      recovery_sources: pages.map(page => ({ source_id: page.source_id, sha256: digest(page.text), utf8_bytes: Buffer.byteLength(page.text), complete: page.complete })).sort((a, b) => a.source_id.localeCompare(b.source_id)),
      view_sha256: views[0].slice(0, 2).map(document => viewDigest(document.pageContent)), extra: { document_ids: views[0].map(d => d.id), metadata_preserved: true, original_artifact_preserved: true, duplicate_text_sources_distinct: compressed, native_reports: reportSummary(capture, views.length, true) },
      requested_handles_match: compressed && provider.state.responses.flatMap(response => response.calls).filter(call => call.name === 'caveman_retrieve').every(call => pages.some(page => page.handle === call.args.handle)) };
  } finally { await runtime.close(); await provider.close(); }
}

async function agentCase(cell, mode, service) {
  const compressed = mode === 'compress', parallel = cell.method === 'parallel_tool_batch', interleaved = cell.method === 'interleaved_thread_identity';
  const provider = await providerFixture(cell.provider, { compressed, parallel });
  const capture = capturedRuntime(service, mode), { runtime, plans, pages, receipts } = capture;
  try {
    const reads = [], callbacks = [], reader = readTool(reads, parallel), checkpoint = new MemorySaver();
    const model = withCavemanModel(modelFor(cell.provider, provider), { runtime, scope: scoped });
    const interrupt = cell.method === 'interrupt_and_reducers';
    const agent = createAgent(withCavemanAgent({ model, tools: [reader], checkpointer: checkpoint,
      ...(interrupt ? { middleware: [humanInTheLoopMiddleware({ interruptOn: { read_logs: true, caveman_retrieve: true } })] } : {}) }, { runtime, scope: scoped }));
    const config = { ...configFor(cell), callbacks: [{ handleChatModelStart(_model, _messages, _runId, _parent, _extra, tags, metadata) { callbacks.push({ tags, metadata }); } }] };
    const input = inputFor('main'), before = input.messages.map(message => message.toDict());
    let value, events = [], extra = {};
    if (cell.streaming) {
      events = await collectNative(await agent.stream(input, { ...config, streamMode: 'messages' }), provider.state, true);
      value = (await agent.getState(config)).values;
    } else if (interleaved) {
      const other = configFor(cell, '-other');
      const values = await Promise.all([agent.invoke(input, config), agent.invoke(inputFor('other'), other)]);
      assert.deepEqual(values.map(result => text(result.messages.at(-1))), [FACT, FACT]);
      for (const cfg of [config, other]) assert.equal((await agent.getState(cfg)).values.messages.find(message => message.name === 'read_logs').content, SOURCE);
      if (compressed) assert.equal(new Set(pages.map(page => page.handle)).size, 2);
      extra = { interleaved_threads: 2, independent_checkpoint_sources: true, independent_scoped_grants: compressed }; value = values[0];
    } else if (interrupt) {
      value = await agent.invoke(input, config); let interrupts = 0;
      while (value.__interrupt__?.length) {
        interrupts++; assert.equal(reads.length, interrupts === 1 ? 0 : 1);
        value = await agent.invoke(new Command({ resume: { decisions: [{ type: 'approve' }] } }), config);
        assert.ok(interrupts <= 2);
      }
      assert.equal(interrupts, compressed ? 2 : 1); extra = { native_interrupts: interrupts, approved_source_and_recovery: compressed, native_reducer_message_ids_unique: new Set(value.messages.map(message => message.id)).size === value.messages.length };
      assert.equal(extra.native_reducer_message_ids_unique, true);
    } else value = await agent.invoke(input, config);
    assert.equal(text(value.messages.at(-1)), FACT); assert.deepEqual(input.messages.map(message => message.toDict()), before);
    const saved = await agent.getState(config); assert.equal(saved.values.messages.find(message => message.name === 'read_logs').content, SOURCE);
    if (cell.method === 'checkpoint_resume_after_restart') {
      const oldPid = service.pid, previousView = results(provider.state.calls[1], cell.provider).find(part => resultId(part) === 'read-1').content;
      await service.restart(); assert.notEqual(service.pid, oldPid);
      value = await agent.invoke({ messages: [new HumanMessage({ content: 'Repeat from checkpoint', id: 'repeat-original' })] }, config);
      assert.equal(text(value.messages.at(-1)), FACT); assert.equal(results(provider.state.calls.at(-1), cell.provider).find(part => resultId(part) === 'read-1').content, previousView);
      extra = { checkpoint_resumed: true, actual_runtime_process_restarted: true, original_source_preserved: true, same_view_after_restart: true };
    }
    if (cell.method === 'branch_and_history_edit') {
      const originalTool = saved.values.messages.find(message => message.name === 'read_logs');
      const edited = new ToolMessage({ ...originalTool, content: EDITED });
      const branch = await agent.updateState(saved.config, { messages: [edited] });
      const fork = { configurable: { ...branch.configurable, caveman_branch_id: 'application-branch' } };
      provider.state.expectedSource = EDITED;
      value = await agent.invoke({ messages: [new HumanMessage({ content: 'Read edited history', id: 'edited-question' })] }, fork);
      assert.equal(text(value.messages.at(-1)), FACT);
      assert.equal((await agent.getState(fork)).values.messages.find(message => message.name === 'read_logs').content, EDITED);
      assert.equal((await agent.getState(saved.config)).values.messages.find(message => message.name === 'read_logs').content, SOURCE);
      if (compressed) { assert.equal(pages.at(-1).text, EDITED); assert.notEqual(pages[0].handle, pages.at(-1).handle); await assert.rejects(runtime.recovery(scoped(config)).execute({ handle: pages.at(-1).handle }), error => error.code === 'not_found'); }
      extra = { native_history_edit: true, old_checkpoint_source_preserved: true, edited_source_sha256: digest(EDITED), native_message_reducer_replaced_same_id: value.messages.filter(message => message.id === originalTool.id).length === 1, branch_grant_isolated: compressed };
      assert.equal(extra.native_message_reducer_replaced_same_id, true);
    }
    const sourceCalls = (parallel || interleaved) ? 2 : 1;
    const baseCalls = compressed ? 3 : 2;
    const expectedCalls = interleaved ? baseCalls * 2 : cell.method === 'checkpoint_resume_after_restart' ? baseCalls + 1 : cell.method === 'branch_and_history_edit' ? baseCalls + (compressed ? 2 : 1) : baseCalls;
    assert.equal(reads.length, sourceCalls); assert.ok(reads.every(read => read.text === SOURCE)); assert.equal(provider.state.calls.length, expectedCalls);
    assert.equal(pages.length, compressed ? (parallel || interleaved || cell.method === 'branch_and_history_edit') ? 2 : 1 : 0);
    for (const page of pages) { assert.ok([SOURCE, EDITED].includes(page.text)); assert.equal(page.original_sha256, digest(page.text)); assert.equal(page.complete, true); }
    assert.deepEqual(provider.state.errors, []);
    assert.ok(callbacks.length >= baseCalls); assert.ok(callbacks.every(entry => entry.tags.includes('native-caller-tag') && entry.metadata.caller === 'unchanged'));
    if (parallel) { assert.deepEqual(reads.map(read => read.slot).sort(), [0, 1]); assert.ok(reads.every(read => read.overlap)); assert.equal(value.messages.filter(message => message.name === 'read_logs').length, 2); extra = { native_parallel_source_calls: 2, source_executors_overlapped: true, native_parallel_recovery_calls: pages.length, two_native_tool_messages: true }; }
    const toolDefinitions = provider.state.calls.map(body => (body.tools ?? []).filter(item => (item.function?.name ?? item.name) === 'read_logs'));
    assert.ok(toolDefinitions.every(value => digest(value) === digest(toolDefinitions[0])));
    const dispatch = receipts.filter(receipt => receipt.event_kind === 'dispatch_intent').length, complete = receipts.filter(receipt => receipt.event_kind === 'completed').length;
    assert.equal(dispatch, mode === 'off' ? 0 : expectedCalls); assert.equal(complete, mode === 'off' ? 0 : expectedCalls);
    if (!compressed) assert.ok(plans.every(plan => plan.result.replacements.length === 0));
    const transformed = provider.state.calls.flatMap(body => results(body, cell.provider)).filter(part => /^read-[12]$/.test(resultId(part))).map(part => part.content);
    const firstView = transformed[0];
    return { source_executions: sourceCalls, provider_calls: expectedCalls, recovery_requests: pages.length, replacements: plans.reduce((sum, plan) => sum + plan.result.replacements.length, 0), source_sha256: digest(SOURCE), source_bytes: Buffer.byteLength(SOURCE), original_history: true,
      native_type: `${agent.constructor.name} result with native messages`, native_value: FACT, stream_events: events, stream_delivered_before_eof: cell.streaming,
      recovery_sources: pages.map(page => ({ source_id: page.source_id, sha256: digest(page.text), utf8_bytes: Buffer.byteLength(page.text), complete: page.complete })).sort((a, b) => a.sha256.localeCompare(b.sha256) || a.source_id.localeCompare(b.source_id)),
      view_sha256: [viewDigest(firstView)], requested_handles_match: compressed && provider.state.responses.flatMap(response => response.calls).filter(call => call.name === 'caveman_retrieve').every(call => pages.some(page => page.handle === call.args.handle)),
      extra: { ...extra, callbacks_and_tags_preserved: true, source_tool_schema_preserved: true, dispatch_receipts: dispatch, completed_receipts: complete, nested_model_owner_single: plans.length === expectedCalls, native_reports: reportSummary(capture, expectedCalls) } };
  } catch (error) { throw new Error(`${cell.id} (${mode}): ${error.message}; provider fixture errors: ${JSON.stringify(provider.state.errors)}`, { cause: error }); }
  finally { await runtime.close(); await provider.close(); }
}

function observations(cell, runs) {
  const [active, off, outage] = runs;
  assert.equal(off.native_value, cell.structured_output ? off.native_value : FACT); assert.deepEqual(active.native_value, off.native_value); assert.deepEqual(active.native_value, outage.native_value);
  for (const baseline of [off, outage]) { assert.equal(baseline.recovery_requests, 0); assert.equal(baseline.replacements, 0); assert.equal(baseline.original_history, true); }
  const free = cell.recovery === 'model_only';
  if (free) { assert.equal(active.recovery_requests, 0); assert.equal(active.replacements, 0); if (active.target_request_sha256) { assert.deepEqual(active.target_request_sha256, off.target_request_sha256); assert.deepEqual(active.target_request_sha256, outage.target_request_sha256); } }
  else { assert.ok(active.recovery_requests > 0); assert.equal(active.requested_handles_match, true); assert.ok(active.replacements > 0); }
  const recoveryFree = { outcome: 'recovery_free', reason: cell.method === 'document_compressor' ? 'no_registered_source_expansion' : cell.structured_output ? 'native_structured_model_without_executor' : 'native_model_without_executor', recovery_requests: 0, replacements: 0, original_source_sha256: active.source_sha256 };
  return {
    native_application: { outcome: 'observed', method: cell.method, execution: cell.execution, native_type: active.native_type, local_http_provider: true },
    real_tool_result: { outcome: 'observed', source_executions: active.source_executions, source_sha256: active.source_sha256, source_utf8_bytes: active.source_bytes, native_executor: true },
    transformed_provider_request: free ? recoveryFree : { outcome: 'observed', replacements: active.replacements, view_sha256_normalizing_only_opaque_handles: active.view_sha256, omitted_fact: FACT, fact_absent: true },
    omitted_fact_requested: free ? recoveryFree : { outcome: 'observed', requested_tool: 'caveman_retrieve', requests: active.recovery_requests, requested_handles_match_views: true },
    host_executes_exact_recovery: free ? recoveryFree : { outcome: 'observed', native_tool_executions: active.recovery_requests, original_sha256: active.source_sha256, original_utf8_bytes: active.source_bytes, recovered_sources: active.recovery_sources, exact_bytes: true, ...('edited_source_sha256' in active.extra ? { edited_source_sha256: active.extra.edited_source_sha256 } : {}) },
    native_result_history_events_and_call_count: { outcome: 'observed', native_value: active.native_value, provider_calls: active.provider_calls, original_history: active.original_history, stream_events: active.stream_events, first_text_before_eof: active.stream_delivered_before_eof, ...active.extra },
    off_baseline: { outcome: 'observed', provider_calls: off.provider_calls, recovery_requests: 0, replacements: 0, native_value: off.native_value, original_history: true, native_reports: off.extra.native_reports, same_target_request: active.target_request_sha256 ? true : undefined },
    optimizer_unavailable: { outcome: 'observed', endpoint: 'closed_loopback_port', provider_calls: outage.provider_calls, recovery_requests: 0, replacements: 0, native_value: outage.native_value, original_history: true, native_reports: outage.extra.native_reports, same_target_request: active.target_request_sha256 ? true : undefined },
  };
}

export async function runNativeCertification(t, family, provider) {
  if (!packaged && selectedFamily !== family) { t.skip(`Only ${selectedFamily} snapshot selected`); return; }
  const service = await startRuntime();
  try {
    const probe = createMiddlewareRuntime({ endpoint: service.endpoint, deadlineMs: 3000 });
    try { await beginNativeCertification(t, await probe.ready()); } finally { await probe.close(); }
    const cells = fixtureCells.filter(cell => cell.family === family && cell.language === 'typescript' && cell.provider === provider);
    for (const cell of cells) {
      const run = ['document_compressor', 'retriever.source_expansion'].includes(cell.method) ? ragCase : cell.recovery === 'model_only' ? modelCase : agentCase;
      const runs = []; for (const mode of ['compress', 'off', 'outage']) runs.push(await run(cell, mode, service));
      emitJourney(t, cell, observations(cell, runs));
    }
  } finally { await service.stop(); }
}
