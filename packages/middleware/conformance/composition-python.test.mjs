import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { delimiter } from 'node:path';
import test from 'node:test';
import { startRuntime } from './runtime-fixture.mjs';

test('installed LiteLLM native ASGI composition conformance', { timeout: 90000 }, async t => {
  const python = process.env.CAVEMAN_MIDDLEWARE_TEST_PYTHON;
  if (!python) throw new Error('Set CAVEMAN_MIDDLEWARE_TEST_PYTHON to the exact hash-locked LiteLLM environment.');
  const runtime = await startRuntime(); t.after(runtime.stop);
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const child = spawn(python, [`${root}examples/middleware/litellm/composition_test.py`], {
    env: { ...process.env, CAVEMAN_MIDDLEWARE_ENDPOINT: runtime.endpoint,
      PYTHONPATH: ['packages/sdk/python', 'packages/middleware/python', 'packages/middleware/conformance'].map(path => root + path).join(delimiter) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk);
  child.stderr.on('data', chunk => stderr += chunk);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  if (code !== 0) throw new Error(`LiteLLM ASGI composition exited ${code}\n${stderr}\n${stdout}`);
  // Emit each original line separately. node:test escapes embedded newlines in
  // one diagnostic, which would make the observation JSON impossible to parse.
  for (const line of (stderr + stdout).split(/\r?\n/)) if (line) t.diagnostic(line);
});
