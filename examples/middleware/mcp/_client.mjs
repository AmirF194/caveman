import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('_server.py', import.meta.url));
class NegotiatedStdio extends StdioClientTransport {
  setProtocolVersion(version) { this.protocolVersion = version; }
}

export async function nativeClient(kind, callback, { engine = false } = {}) {
  const python = process.env.CAVEMAN_MIDDLEWARE_TEST_PYTHON;
  if (!python) throw new Error('Set the exact installed MCP Python fixture environment');
  const client = new Client({ name: 'native-typescript-host', version: '1.0.0' });
  let transport, child, capture, stderr = '';
  try {
    if (kind === 'stdio') {
      if (engine && !process.env.CAVEMAN_MCP_TEST_BINARY) throw new Error('Set a freshly built existing Caveman MCP server');
      transport = new NegotiatedStdio(engine ? { command: process.env.CAVEMAN_MCP_TEST_BINARY, env: { CAVEMAN_MCP_EPHEMERAL: '1' } }
        : { command: python, args: [fixture], stderr: 'pipe' });
    } else {
      const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
      const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
      capture = join(await mkdtemp(join(tmpdir(), 'mcp-http-')), 'requests.jsonl');
      child = spawn(python, [fixture, 'http', String(port), capture], { stdio: ['ignore', 'ignore', 'pipe'] });
      child.stderr.on('data', data => { stderr += data; });
      const base = `http://127.0.0.1:${port}`;
      let ready = false;
      for (let i = 0; i < 100; i++) {
        if (child.exitCode !== null) throw new Error(stderr);
        try { if ((await fetch(base + '/ready')).ok) { ready = true; break; } } catch { /* native startup */ }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      if (!ready) throw new Error('Native MCP HTTP fixture failed to start');
      transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
        requestInit: { headers: { authorization: 'Bearer fixture-mcp-token', 'x-native-mcp': 'preserved' } },
      });
    }
    await client.connect(transport);
    const result = await callback(client, transport.protocolVersion);
    await client.close();
    const rows = capture ? (await readFile(capture, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    return { result, rows, protocolVersion: transport.protocolVersion };
  } finally {
    await client.close();
    if (child && child.exitCode === null) { const ended = once(child, 'exit'); child.kill('SIGTERM'); await ended; }
  }
}
