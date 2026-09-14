import assert from 'node:assert/strict';
import test from 'node:test';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createMiddlewareRuntime, sha256 } from '../../../packages/sdk/typescript/dist/middleware/index.js';
import { CavemanMCPHost, bindMCPTool } from '../../../packages/middleware/typescript/dist/mcp.js';
import { startRuntime } from '../../../packages/middleware/conformance/runtime-fixture.mjs';
import { nativeClient } from './_client.mjs';
import { providerFixture, SOURCE } from './_provider.mjs';
import { runTextHost } from './example.mjs';
import { certifyCell } from './certification-native.mjs';

const scope = () => ({ namespace: `native-mcp-${crypto.randomUUID()}`, session_id: 'session', branch_id: 'main', cache_epoch: '0' });
const manifest = async result => [{ id: 'original-result', sha256: await sha256(JSON.stringify(result)) }];
const makeHost = (runtime, protocolVersion, selected = scope()) => new CavemanMCPHost({ runtime, scope: selected, serverId: 'native-fixture', protocolVersion });
async function setup(client, runtime, protocolVersion) {
  const bindings = (await client.listTools()).tools.map(tool => bindMCPTool(client, tool));
  return { host: makeHost(runtime, protocolVersion), bindings };
}

test('native MCP stdio/HTTP OpenAI/Anthropic generation and streaming recovery journeys', { timeout: 60000 }, async t => {
  const service = await startRuntime(); t.after(service.stop);
  for (const transport of ['stdio', 'http']) for (const protocol of ['openai', 'anthropic']) for (const stream of [false, true]) {
    const runtime = createMiddlewareRuntime({ endpoint: service.endpoint });
    const provider = await providerFixture(protocol);
    try {
      const captured = await nativeClient(transport, async (mcp, protocolVersion) => {
        assert.ok(protocolVersion); t.diagnostic(`MCP ${transport}/${protocol}/${stream ? 'stream' : 'generate'} negotiated ${protocolVersion}`);
        const { host, bindings } = await setup(mcp, runtime, protocolVersion);
        const client = protocol === 'openai' ? new OpenAI({ apiKey: 'fixture', baseURL: provider.url + '/v1', maxRetries: 0 })
          : new Anthropic({ apiKey: 'fixture', baseURL: provider.url, maxRetries: 0 });
        let text = '';
        const result = await runTextHost({ client, model: 'fixture-model', protocol, host, tools: bindings, prompt: 'Find retained-detail-70', stream,
          onText: chunk => { if (!text) { assert.equal(provider.state.finished, false); provider.state.release(); } text += chunk; } });
        assert.equal(result.final, 'retained-detail-70');
        assert.equal(provider.state.calls.length, 3, `${transport}/${protocol}/${stream}`);
        assert.deepEqual(result.originals.map(item => item.name), ['read_logs', 'caveman_retrieve']);
        assert.equal(result.originals[0].result.content[0].text, SOURCE);
        const page = JSON.parse(result.originals[1].result.content[0].text);
        assert.equal(page.text, SOURCE); assert.equal(page.complete, true);
        assert.ok(JSON.stringify(result.messages).includes(JSON.stringify(SOURCE).slice(1, -1)));
        assert.deepEqual(provider.state.calls[0].body.tools, provider.state.calls[2].body.tools);
        assert.ok(provider.state.calls.every(call => call.headers['x-native-option'] === 'preserved'));
        assert.deepEqual(provider.state.errors, []);
        if (stream) assert.equal(text, result.final);
      });
      if (transport === 'http') {
        const calls = captured.rows.filter(row => row.body?.method === 'tools/call');
        assert.equal(calls.length, 1); assert.equal(calls[0].body.params.name, 'read_logs');
        assert.equal(typeof calls[0].body.id, 'number');
        assert.equal(calls[0].headers['x-native-mcp'], 'preserved');
        assert.equal(calls[0].headers['mcp-protocol-version'], captured.protocolVersion);
      }
    } finally { runtime.close(); await provider.close(); }
  }
});

test('native mixed media, resources, annotations, output schemas and errors preserve values', { timeout: 30000 }, async t => {
  const service = await startRuntime(); t.after(service.stop);
  for (const kind of ['stdio', 'http']) {
    const runtime = createMiddlewareRuntime({ endpoint: service.endpoint });
    try { await nativeClient(kind, async (client, protocolVersion) => {
      const { host, bindings } = await setup(client, runtime, protocolVersion), registeredTools = host.register(bindings), contextManifest = [];
      for (const binding of bindings) {
        if (binding.tool.name === 'wait_forever') continue;
        const original = await binding.execute({}), before = structuredClone(original);
        contextManifest.push({ id: binding.tool.name, sha256: await sha256(JSON.stringify(original)) });
        const view = await host.projectResult(original, { tool: binding.tool, callId: binding.tool.name, contextManifest, registeredTools });
        assert.deepEqual(original, before); assert.deepEqual(view._meta, original._meta); assert.equal(view.isError, original.isError);
        if (['structured', 'mixed_structured', 'failure'].includes(binding.tool.name)) assert.equal(view, original);
        else { assert.notEqual(view.content[0].text, SOURCE); assert.deepEqual(view.content[0].annotations, original.content[0].annotations); }
        if (binding.tool.name === 'mixed') for (let i = 1; i < 6; i++) assert.equal(view.content[i], original.content[i]);
      }
    }); } finally { runtime.close(); }
  }
});

test('recovery requires the actual unchanged executor; off, record, outage and protected contracts retain originals', { timeout: 30000 }, async t => {
  const service = await startRuntime(); t.after(service.stop);
  await nativeClient('stdio', async (client, protocolVersion) => {
    const tool = (await client.listTools()).tools.find(tool => tool.name === 'read_logs'), original = await client.callTool({ name: tool.name, arguments: {} });
    for (const variant of ['schema-only', 'collision', 'other-scope', 'mutated-name', 'mutated-execute', 'filtered', 'off', 'record', 'outage']) {
      const runtime = createMiddlewareRuntime({ endpoint: variant === 'outage' ? 'http://127.0.0.1:1' : service.endpoint,
        mode: ['off', 'record'].includes(variant) ? variant : 'compress' });
      try {
        const host = makeHost(runtime, protocolVersion), fake = { tool: structuredClone(host.recovery.tool), execute: async () => original };
        let registeredTools = host.register([]);
        if (variant === 'schema-only') registeredTools = [fake];
        if (variant === 'collision') { registeredTools = host.register([fake]); assert.deepEqual(registeredTools, [fake]); }
        if (variant === 'other-scope') registeredTools = [makeHost(runtime, protocolVersion).recovery];
        if (variant === 'filtered') registeredTools = [];
        if (variant === 'mutated-name') host.recovery.tool.name = 'different_recovery';
        if (variant === 'mutated-execute') host.recovery.execute = fake.execute;
        const view = await host.projectResult(original, { tool, callId: 'call', contextManifest: await manifest(original), registeredTools });
        assert.equal(view.content[0].text, SOURCE, variant);
      } finally { runtime.close(); }
    }
    const runtime = createMiddlewareRuntime({ endpoint: service.endpoint });
    try {
      const host = makeHost(runtime, protocolVersion);
      for (const result of [{ ...original, structuredContent: null }, { ...original, resultType: 'input_required' }]) {
        assert.equal(await host.projectResult(result, { tool, callId: 'protected', contextManifest: await manifest(result), registeredTools: [host.recovery] }), result);
      }
      const controller = new AbortController(); controller.abort();
      await assert.rejects(host.projectResult(original, { tool, callId: 'cancelled', contextManifest: [], signal: controller.signal }), { name: 'AbortError' });
    } finally { runtime.close(); }
  });
});

test('twenty-turn native serialization and Engine restart preserve choices and scoped recovery', { timeout: 30000 }, async t => {
  const service = await startRuntime(); t.after(service.stop);
  const runtime = createMiddlewareRuntime({ endpoint: service.endpoint }); t.after(() => runtime.close());
  await nativeClient('stdio', async (client, protocolVersion) => {
    const selected = scope(), binding = bindMCPTool(client, (await client.listTools()).tools.find(tool => tool.name === 'read_logs'));
    let host = makeHost(runtime, protocolVersion, selected);
    const original = await binding.execute({}), saved = JSON.stringify(original), contextManifest = await manifest(original);
    let first, view;
    for (let turn = 0; turn < 20; turn++) {
      if ([5, 15].includes(turn)) { await service.restart(); host = makeHost(runtime, protocolVersion, selected); }
      const restored = CallToolResultSchema.parse(JSON.parse(saved));
      view = await host.projectResult(restored, { tool: binding.tool, callId: 'stable-call', contextManifest, registeredTools: host.register([binding]) });
      first ??= JSON.stringify(view); assert.equal(JSON.stringify(view), first); assert.equal(JSON.stringify(restored), saved);
      contextManifest.push({ id: `turn-${turn}`, sha256: await sha256(`continuation ${turn}`) });
    }
    const handle = view.content[0].text.match(/cmw_[a-f0-9]{48}/)?.[0]; assert.ok(handle);
    const recovered = await host.recovery.execute({ handle }); assert.equal(JSON.parse(recovered.content[0].text).text, SOURCE);
    await assert.rejects(makeHost(runtime, protocolVersion).recovery.execute({ handle }));
  });
});

test('native MCP tool cancellation and transport options retain the connection', { timeout: 15000 }, async () => {
  for (const kind of ['stdio', 'http']) await nativeClient(kind, async client => {
    const tools = (await client.listTools()).tools, binding = bindMCPTool(client, tools.find(tool => tool.name === 'wait_forever'));
    let ready; const started = new Promise(resolve => { ready = resolve; });
    const controller = new AbortController();
    const waiting = binding.execute({}, { signal: controller.signal, onprogress: ready, timeout: 2000 });
    const rejected = assert.rejects(waiting);
    await started; controller.abort(); await rejected;
    assert.equal((await bindMCPTool(client, tools.find(tool => tool.name === 'read_logs')).execute({})).content[0].text, SOURCE);
  });
});

test('native provider loops keep original results with off, record and runtime outage', { timeout: 30000 }, async t => {
  const service = await startRuntime(); t.after(service.stop);
  for (const transport of ['stdio', 'http']) await nativeClient(transport, async (mcp, protocolVersion) => {
    for (const mode of ['off', 'record', 'outage']) for (const protocol of ['openai', 'anthropic']) {
      const runtime = createMiddlewareRuntime({ endpoint: mode === 'outage' ? 'http://127.0.0.1:1' : service.endpoint, mode: mode === 'outage' ? 'compress' : mode });
      const provider = await providerFixture(protocol);
      try {
        const { host, bindings } = await setup(mcp, runtime, protocolVersion);
        const client = protocol === 'openai' ? new OpenAI({ apiKey: 'fixture', baseURL: provider.url + '/v1', maxRetries: 0 })
          : new Anthropic({ apiKey: 'fixture', baseURL: provider.url, maxRetries: 0 });
        const result = await runTextHost({ client, model: 'fixture-model', protocol, host, tools: bindings, prompt: 'Find retained-detail-70' });
        assert.equal(result.final, 'retained-detail-70'); assert.equal(provider.state.calls.length, 2);
        assert.equal(result.originals.length, 1); assert.equal(result.originals[0].result.content[0].text, SOURCE);
        assert.deepEqual(provider.state.errors, []);
      } finally { runtime.close(); await provider.close(); }
    }
  });
});

test('one hundred interleaved native MCP host scopes get distinct exact recovery grants', { timeout: 30000 }, async t => {
  const service = await startRuntime(); t.after(service.stop);
  const runtime = createMiddlewareRuntime({ endpoint: service.endpoint }); t.after(() => runtime.close());
  await nativeClient('stdio', async (client, protocolVersion) => {
    const tool = (await client.listTools()).tools.find(tool => tool.name === 'read_logs'), original = await client.callTool({ name: tool.name, arguments: {} });
    const contextManifest = await manifest(original), handles = [];
    let next = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (next++ < 100) {
        const host = makeHost(runtime, protocolVersion);
        const view = await host.projectResult(original, { tool, callId: 'call', contextManifest, registeredTools: [host.recovery] });
        const handle = view.content[0].text.match(/cmw_[a-f0-9]{48}/)?.[0]; assert.ok(handle);
        assert.equal(JSON.parse((await host.recovery.execute({ handle })).content[0].text).text, SOURCE);
        handles.push(handle);
      }
    }));
    assert.equal(new Set(handles).size, 100);
  });
});

test('existing Caveman MCP server remains authoritative for its own tools', { timeout: 15000 }, async t => {
  const service = await startRuntime(); t.after(service.stop);
  const runtime = createMiddlewareRuntime({ endpoint: service.endpoint }); t.after(() => runtime.close());
  await nativeClient('stdio', async (client, protocolVersion) => {
    const { host, bindings } = await setup(client, runtime, protocolVersion);
    assert.deepEqual(host.register(bindings), bindings);
    const binding = bindings.find(item => item.tool.name === 'caveman_compress'), result = await binding.execute({ input: SOURCE });
    assert.equal(result.isError, false);
    assert.equal(await host.projectResult(result, { tool: binding.tool, callId: 'engine', contextManifest: await manifest(result), registeredTools: bindings }), result);
  }, { engine: true });
});

test('MCP F13 stdio.call_tool', { timeout: 60000 }, async t => certifyCell(t, 'stdio.call_tool'));
test('MCP F13 streamable_http.call_tool', { timeout: 60000 }, async t => certifyCell(t, 'streamable_http.call_tool'));
test('MCP F13 host_recovery_registration', { timeout: 60000 }, async t => certifyCell(t, 'host_recovery_registration'));
test('MCP F13 native_result_identity_and_blocks', { timeout: 60000 }, async t => certifyCell(t, 'native_result_identity_and_blocks'));
test('MCP F13 stdio.host_stream', { timeout: 60000 }, async t => certifyCell(t, 'stdio.host_stream'));
test('MCP F13 streamable_http.host_stream', { timeout: 60000 }, async t => certifyCell(t, 'streamable_http.host_stream'));
test('MCP F13 cancel_and_options', { timeout: 60000 }, async t => certifyCell(t, 'cancel_and_options'));
test('MCP F13 twenty_turn_restart', { timeout: 60000 }, async t => certifyCell(t, 'twenty_turn_restart'));
test('MCP F13 existing_server_interoperation', { timeout: 60000 }, async t => certifyCell(t, 'existing_server_interoperation'));
test('MCP F13 structuredContent_and_outputSchema', { timeout: 60000 }, async t => certifyCell(t, 'structuredContent_and_outputSchema'));
test('MCP F13 mixed_structured_text_protection', { timeout: 60000 }, async t => certifyCell(t, 'mixed_structured_text_protection'));
