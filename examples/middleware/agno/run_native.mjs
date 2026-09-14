import { spawn } from 'node:child_process';
import { startRuntime } from '../../../packages/middleware/conformance/runtime-fixture.mjs';

const runtime = await startRuntime();
try {
  const child = spawn(process.env.CAVEMAN_MIDDLEWARE_TEST_PYTHON, ['examples/middleware/agno/test_native.py', ...process.argv.slice(2)], {
    env: { ...process.env, CAVEMAN_MIDDLEWARE_ENDPOINT: runtime.endpoint,
      PYTHONPATH: 'packages/sdk/python:packages/middleware/python:packages/middleware/conformance' }, stdio: 'inherit',
  });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  if (code !== 0) process.exitCode = code ?? 1;
} finally { await runtime.stop(); }
