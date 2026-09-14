import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { startRuntime } from './runtime-fixture.mjs';

test('installed three-arm native comparison harness remains local and metered', { timeout: 180000 }, async t => {
  const python = process.env.CAVEMAN_MIDDLEWARE_HOSTED_TEST_PYTHON;
  if (!python) throw new Error('Set CAVEMAN_MIDDLEWARE_HOSTED_TEST_PYTHON to the hash-locked Python3.14 environment with built middleware wheels.');
  const service = await startRuntime();
  t.after(service.stop);
  const source = fileURLToPath(new URL('./hosted/test_native.py', import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AWS_PROFILE|PYTHONPATH)/i.test(key)));
  const child = spawn(python, [source], { env: { ...env, CAVEMAN_MIDDLEWARE_ENDPOINT: service.endpoint }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', value => output += value);
  child.stderr.on('data', value => output += value);
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  for (const line of output.split('\n')) if (line) t.diagnostic(line);
  if (code !== 0) throw new Error(`Native comparison-harness controls failed (${code})`);
});
