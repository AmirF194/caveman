import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { startRuntime } from '../../../packages/middleware/conformance/runtime-fixture.mjs';

const runtime = await startRuntime();
try {
  const child = spawn(process.env.CAVEMAN_MIDDLEWARE_TEST_PYTHON, ['examples/middleware/llama-index/test_native.py', ...process.argv.slice(2)], {
    env: { ...process.env, CAVEMAN_MIDDLEWARE_ENDPOINT: runtime.endpoint,
      PYTHONPATH: 'packages/sdk/python:packages/middleware/python:packages/middleware/conformance' }, stdio: ['pipe', 'pipe', 'inherit'],
  });
  const output = (async () => {
    for await (const line of createInterface({ input: child.stdout })) {
      if (line === '{"caveman_control": "restart"}') {
        await runtime.restart();
        child.stdin.write('runtime-ready\n');
      } else process.stdout.write(line + '\n');
    }
  })();
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  await output;
  if (code !== 0) process.exitCode = code ?? 1;
} finally { await runtime.stop(); }
