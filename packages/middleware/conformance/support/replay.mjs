/** Independent local replay, using cataloged test files rather than artifact commands. */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { root, json } from './inventory.mjs';
import { hasObservation } from './observations.mjs';
import { mandatoryJourney } from './catalog.mjs';

export function certificationReferences(inventory) {
  const references = new Map();
  for (const row of inventory.manifests.filter(row => ['conformant', 'provider_tested'].includes(row.state))) {
    for (const ref of row.evidence.filter(ref => ref.kind === 'native_fixture')) references.set(ref.sha256, { path: ref.artifact, sha256: ref.sha256 });
  }
  for (const item of inventory.traceability.requirements.flatMap(requirement => requirement.acceptance).filter(item => item.state === 'conformant')) {
    for (const ref of item.proof ?? []) references.set(ref.sha256, ref);
  }
  return [...references.values()];
}

function localEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|CLIENT_SECRET|SECRET_ACCESS_KEY|SESSION_TOKEN|GOOGLE_APPLICATION_CREDENTIALS|AWS_PROFILE)/i.test(name)));
}

async function run(program, args, cwd, env, timeout = 180_000) {
  return new Promise((yes, no) => {
    const child = spawn(program, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', exceeded = false;
    const timer = setTimeout(() => { child.kill('SIGTERM'); exceeded = true; }, timeout);
    const capture = chunk => {
      output += chunk;
      if (output.length > 8 * 1024 * 1024) { exceeded = true; child.kill('SIGTERM'); }
    };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    child.on('error', error => { clearTimeout(timer); no(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || exceeded) return no(new Error(`local proof replay failed (${program}, exit ${code}, bounded output/deadline ${exceeded})`));
      yes(output);
    });
  });
}

export async function replayCertification(ref, inventory) {
  const record = await json(ref.path);
  const known = new Map(inventory.tests.tests.map(test => [test.id, test]));
  if (!record.tests?.length || record.tests.some(test => !known.has(test.id))) throw new Error('Replay requires known exact tests');
  const tests = record.tests.map(test => known.get(test.id));
  const outputByFile = new Map();
  for (const file of new Set(tests.map(test => test.file))) {
    const env = localEnvironment();
    let program, args, cwd = root;
    if (file.endsWith('.mjs')) {
      program = process.execPath;
      args = [...(file === 'packages/middleware/conformance/stream-memory.test.mjs' ? ['--expose-gc'] : []), '--test', '--test-reporter=tap', file];
    } else if (file.endsWith('.py') && file.startsWith('examples/middleware/')) {
      const family = file.split('/')[2];
      const python = process.env.CAVEMAN_MIDDLEWARE_TEST_PYTHON;
      if (!python || !(await stat(python).catch(() => null))?.isFile()) throw new Error(`Set CAVEMAN_MIDDLEWARE_TEST_PYTHON to the ${family} exact-lock Python environment for independent replay`);
      env.CAVEMAN_MIDDLEWARE_TEST_PYTHON = python;
      env.CAVEMAN_MIDDLEWARE_TEST_FAMILY = family;
      program = process.execPath;
      const driver = file === 'examples/middleware/litellm/composition_test.py' ? 'composition-python'
        : family === 'python-provider-sdks' ? 'python-provider' : 'python-framework';
      args = ['--test', '--test-reporter=tap', `packages/middleware/conformance/${driver}.test.mjs`];
    } else if (file.endsWith('.go') && file.startsWith('proxy/')) {
      program = 'go'; cwd = resolve(root, 'proxy');
      args = ['test', '-count=1', '-json', `./${file.split('/').slice(1, -1).join('/')}`];
    } else if (file === 'packages/sdk/python/tests/test_middleware.py') {
      program = process.env.CAVEMAN_MIDDLEWARE_TEST_PYTHON ?? 'python3';
      env.PYTHONPATH = resolve(root, 'packages/sdk/python');
      args = ['-m', 'unittest', '-v', 'packages/sdk/python/tests/test_middleware.py'];
    } else throw new Error(`No allowlisted local replay driver for ${file}`);
    outputByFile.set(file, await run(program, args, cwd, env));
  }
  for (const test of tests) {
    const output = outputByFile.get(test.file);
    if (!output.includes(test.name)) throw new Error(`Replay did not execute exact named test ${test.id}`);
    if (test.file.endsWith('.mjs') || test.file.startsWith('examples/')) {
      if (!/# fail 0\b/.test(output) || !/# pass [1-9]\d*\b/.test(output) || /^not ok /m.test(output)) throw new Error(`Incomplete or failed TAP replay for ${test.file}`);
    } else if (test.file.endsWith('.go')) {
      const passed = output.split('\n').some(line => {
        try { const event = JSON.parse(line); return event.Action === 'pass' && event.Test === test.name; } catch { return false; }
      });
      if (!passed) throw new Error(`Go replay did not pass ${test.name}`);
    } else if (!/\nOK\b/.test(output)) throw new Error(`Python replay did not pass ${test.file}`);
  }
  const output = [...outputByFile.values()].join('\n');
  for (const cell of record.cells ?? []) {
    for (const assertion of mandatoryJourney) {
      if (!hasObservation(output, { cell_id: cell, assertion, ...record.journey?.[assertion] })) {
        throw new Error(`Fresh test replay did not emit ${assertion} for ${cell}; a passing test or saved success field is not proof of this journey`);
      }
    }
  }
  for (const acceptance of record.acceptance_items ?? []) {
    if (!hasObservation(output, { acceptance_id: acceptance, assertion: acceptance, ...record.criterion_assertions?.[acceptance] })) {
      throw new Error(`Fresh test replay did not emit the complete acceptance observation ${acceptance}`);
    }
  }
  return ref.sha256;
}
