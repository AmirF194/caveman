import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startRuntime } from '../../../packages/middleware/conformance/runtime-fixture.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const python = process.env.CAVEMAN_MIDDLEWARE_TEST_PYTHON;
if (!python) throw new Error('Set CAVEMAN_MIDDLEWARE_TEST_PYTHON to the hash-locked Python provider environment.');
const runtime = await startRuntime();
const lifecycle = process.argv[2] === '--lifecycle';
const example = process.argv[2] === '--example';
try {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(python, [fileURLToPath(new URL(lifecycle ? './probe_lifecycle.py' : example ? './example.py' : './test_native.py', import.meta.url)), ...process.argv.slice(lifecycle || example ? 3 : 2)], {
      cwd: root, env: { ...process.env, CAVEMAN_MIDDLEWARE_ENDPOINT: runtime.endpoint,
        PYTHONPATH: ['packages/sdk/python', 'packages/middleware/python'].map(path => root + path).join(':') }, stdio: 'inherit',
    });
    child.on('error', reject); child.on('exit', resolve);
  });
  process.exitCode = code || 0;
} finally { await runtime.stop(); }
