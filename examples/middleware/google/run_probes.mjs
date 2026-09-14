import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startRuntime } from '../../../packages/middleware/conformance/runtime-fixture.mjs';

const python = process.env.CAVEMAN_MIDDLEWARE_TEST_PYTHON;
if (!python) throw new Error('Set CAVEMAN_MIDDLEWARE_TEST_PYTHON to the exact Google SDK environment');
const root = fileURLToPath(new URL('../../../', import.meta.url)), service = await startRuntime();
try {
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(python, [fileURLToPath(new URL('./probe_suspended_close.py', import.meta.url))], {
      cwd: root, env: { ...process.env, CAVEMAN_MIDDLEWARE_ENDPOINT: service.endpoint, PYTHONPATH: `${root}packages/sdk/python:${root}packages/middleware/python` }, stdio: 'inherit' });
    child.on('error', reject); child.on('close', resolve);
  });
} finally { await service.stop(); }
