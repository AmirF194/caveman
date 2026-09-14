import { spawn } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRuntime } from '../../../packages/middleware/conformance/runtime-fixture.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const python = process.env.CAVEMAN_MIDDLEWARE_TEST_PYTHON;
if (!python) throw new Error('Set CAVEMAN_MIDDLEWARE_TEST_PYTHON to the locked Pydantic AI environment.');
const runtime = await startRuntime();
const pythonPath = ['packages/sdk/python', 'packages/middleware/python', 'packages/middleware/conformance'].map(path => join(root, path));
const jobs = [{ file: 'probe_continuation.py' }, { file: 'probe_lifecycle.py' }];
const overlay = process.env.CAVEMAN_MIDDLEWARE_TEST_HTTPX27_OVERLAY;
if (overlay) jobs.push({ file: 'probe_lifecycle.py', overlay, args: ['--output', join(root, 'examples/middleware/pydantic-ai/lifecycle-httpx27-evidence.json')] });
try {
  for (const job of jobs) {
    const child = spawn(python, [join(root, 'examples/middleware/pydantic-ai', job.file), ...(job.args ?? [])], {
      env: { ...process.env, CAVEMAN_MIDDLEWARE_ENDPOINT: runtime.endpoint, PYTHONPATH: [job.overlay, ...pythonPath].filter(Boolean).join(delimiter) },
      stdio: 'inherit',
    });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    if (code !== 0) throw new Error(`${job.file} exited ${code}`);
  }
} finally {
  await runtime.stop();
}
