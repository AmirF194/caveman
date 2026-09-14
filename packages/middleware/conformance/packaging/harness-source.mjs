/** Exact package-runner imports plus explicitly executed non-module resources. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const base = 'packages/middleware/conformance/packaging';
// Native example sources/locks are separately derived from catalog.mjs and
// fixtures.mjs. These are the runner's direct subprocess/data entry points.
const entryPoints = ['packages/middleware/conformance/packaged-consumer.mjs',
  `${base}/probe.py`, `${base}/run-python.mjs`, `${base}/type-requirements.lock`,
  'packages/middleware/conformance/support/catalog.mjs'];
const linuxEntryPoints = [`${base}/linux.mjs`, `${base}/linux-native.mjs`, `${base}/Dockerfile`];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function captureHarnessSources({ platform = process.platform } = {}) {
  assert(['darwin', 'linux', 'win32'].includes(platform), 'Unknown package execution platform');
  const pending = [...entryPoints, ...(platform === 'linux' ? linuxEntryPoints : [])], found = new Map();
  while (pending.length) {
    const source = pending.pop();
    if (found.has(source)) continue;
    const path = resolve(root, source), rel = relative(root, path);
    assert(rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep), 'Harness import escaped the repository');
    const bytes = await readFile(path); found.set(source, hash(bytes));
    if (!source.endsWith('.mjs')) continue;
    // Only static module imports load when these entry points run. Other
    // runtime-build exports contain dynamic certification imports that this
    // packaging path does not call; their own producer owns those closures.
    for (const match of bytes.toString('utf8').matchAll(/^\s*import\s+(?:[^;]*?\s+from\s*)?['"]([^'"]+)['"]\s*;?/gm)) {
      if (!match[1].startsWith('.')) continue;
      const dependency = relative(root, resolve(dirname(path), match[1])).split(sep).join('/');
      pending.push(dependency);
    }
  }
  return Object.fromEntries([...found].sort(([a], [b]) => a.localeCompare(b)));
}

export async function verifyHarnessSources(recorded, options) {
  const current = await captureHarnessSources(options);
  assert(recorded && typeof recorded === 'object' && !Array.isArray(recorded), 'Missing executed harness sources');
  assert.deepEqual(Object.keys(recorded).sort(), Object.keys(current).sort(), 'Executed harness source set was omitted or expanded');
  assert.deepEqual(recorded, current, 'Executed harness source revision changed or was forged');
}
