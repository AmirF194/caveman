import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

export async function startRuntime({ binary = process.env.CAVEMAN_MIDDLEWARE_TEST_BINARY, mode = 'compress', recoveryBytes } = {}) {
  if (!binary) throw new Error('Set CAVEMAN_MIDDLEWARE_TEST_BINARY to a freshly built caveman-proxy; no mocked runtime is substituted.');
  if (recoveryBytes !== undefined && (!Number.isSafeInteger(recoveryBytes) || recoveryBytes < 32768)) throw new Error('Invalid fixture recovery budget');
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const home = await mkdtemp(join(tmpdir(), 'caveman-middleware-'));
  const config = join(home, 'caveman.yaml');
  await writeFile(config, `listen: "127.0.0.1:${port}"\nmode: ${mode}\n`, { mode: 0o600 });
  const endpoint = `http://127.0.0.1:${port}`;
  let child, output = '', spawnError;
  async function start() {
    child = spawn(binary, ['serve'], { env: { ...process.env, CAVEMAN_HOME: home, CAVEMAN_CONFIG: config,
      CAVEMAN_DB: join(home, 'caveman.db'), CAVEMAN_CCR_DB: join(home, 'ccr.db'),
      ...(recoveryBytes === undefined ? {} : { CAVEMAN_CCR_MAX_BYTES: String(recoveryBytes) }),
      CAVEMAN_AUTH_TOKEN: '', CAVE_CAPTURE_DIR: '' }, stdio: ['ignore','pipe','pipe'] });
    child.stdout.on('data', data => { output += data.toString(); });
    child.stderr.on('data', data => { output += data.toString(); });
    spawnError=undefined;
    child.on('error', error => { output += error.message; spawnError=error; });
    const startupDeadline=Date.now()+20000;
    while(Date.now()<startupDeadline) {
      if (spawnError||child.exitCode !== null||child.signalCode!==null) throw new Error(`Runtime exited: ${output.slice(-2000)}`);
      try {
        const response = await fetch(endpoint+'/caveman/v1/middleware/capabilities',{signal:AbortSignal.timeout(500)});
        if (response.ok) {
          const caps = await response.json();
          if (caps.mode !== mode) throw new Error(`Runtime mode ${caps.mode}, expected ${mode}`);
          return;
        }
      } catch (error) { if (error.message.startsWith('Runtime mode')) throw error; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Runtime did not start: ${output.slice(-2000)}`);
  }
  async function stop() {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const ended = once(child, 'exit');
      child.kill('SIGTERM');
      const deadline=setTimeout(()=>child.kill('SIGKILL'),5000);
      try { await ended; } finally { clearTimeout(deadline); }
    }
  }
  try { await start(); } catch(error) { await stop(); throw error; }
  return { endpoint, home, get pid() { return child?.pid ?? null; }, stop, restart: async () => { await stop(); try { await start(); } catch(error) { await stop(); throw error; } } };
}
