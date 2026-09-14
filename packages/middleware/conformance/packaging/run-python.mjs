/** Run the unchanged native Python fixture with installed packages only. */
import { spawn } from 'node:child_process';
import { startRuntime } from '../runtime-fixture.mjs';

if (process.env.PYTHONPATH || process.env.PYTHONHOME) throw new Error('Python source aliases are forbidden');
const [python, ...args] = process.argv.slice(2);
if (!python || args.length === 0) throw new Error('Usage: run-python.mjs PYTHON TEST [ARGS...]');
const runtime = await startRuntime();
let control = Promise.resolve(), pending = '';
const child = spawn(python, args, {
  cwd: process.cwd(),
  env: { ...process.env, CAVEMAN_MIDDLEWARE_ENDPOINT: runtime.endpoint, PYTHONNOUSERSITE: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stdout.on('data', chunk => {
  process.stdout.write(chunk); pending += chunk;
  while (pending.includes('\n')) {
    const end = pending.indexOf('\n'), line = pending.slice(0, end); pending = pending.slice(end + 1);
    try {
      if (JSON.parse(line).caveman_control === 'restart') control = control.then(async () => {
        await runtime.restart(); child.stdin.write('runtime-ready\n');
      });
    } catch { /* Native fixture output. */ }
  }
});
child.stderr.pipe(process.stderr);
let timedOut = false;
const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 240_000);
try {
  const code = await new Promise((yes, no) => { child.once('error', no); child.once('exit', yes); });
  await control;
  if (timedOut) throw new Error('Native Python fixture exceeded 240 seconds');
  process.exitCode = code === 0 ? 0 : 1;
} finally {
  clearTimeout(timer);
  if (child.exitCode === null) child.kill('SIGTERM');
  await runtime.stop();
}
