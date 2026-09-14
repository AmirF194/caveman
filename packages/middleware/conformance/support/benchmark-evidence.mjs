/** Full owned TypeScript package inputs plus the proven compiled runtime. */
import { readFile, readdir, realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { root, sha256 } from './inventory.mjs';
import { runtimeBuildSources } from './runtime-build.mjs';

async function packageModules(directory, selected) {
  const entries = await readdir(resolve(root, directory), { withFileTypes: true });
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Benchmark input cannot be a symlink: ${path}`);
    if (entry.isDirectory()) await packageModules(path, selected);
    else if (/\.(?:ts|js)$/.test(entry.name)) selected.add(path);
  }
}

export async function captureBenchmarkInputs({ files, binary }) {
  const build = await runtimeBuildSources({ binary });
  const selected = new Set([...files, ...build.sources.map(item => item.path),
    'packages/middleware/conformance/support/benchmark-evidence.mjs',
    'packages/middleware/conformance/support/runtime-build.mjs',
    'packages/middleware/conformance/support/inventory.mjs',
    'packages/middleware/conformance/support/catalog.mjs',
    'packages/middleware/conformance/support/observations.mjs',
    'packages/middleware/typescript/package.json', 'packages/middleware/typescript/tsconfig.json',
    'packages/sdk/typescript/package.json', 'packages/sdk/typescript/tsconfig.json']);
  for (const directory of ['packages/middleware/typescript/src', 'packages/middleware/typescript/dist',
                           'packages/sdk/typescript/src', 'packages/sdk/typescript/dist']) await packageModules(directory, selected);
  const sources = [];
  for (const path of [...selected].sort()) {
    const actual = await realpath(resolve(root, path));
    if (relative(root, actual).startsWith(`..${sep}`)) throw new Error(`Benchmark input escaped repository: ${path}`);
    sources.push({ path, sha256: sha256(await readFile(actual)) });
  }
  return { schema_version: 1, producer: 'caveman-benchmark-inputs-v1',
    scope: 'Complete owned TypeScript package source and emitted modules, benchmark fixtures, and actual compiled Go dependency closure; includes unused package modules.',
    runtime_build_provenance: build.reference, runtime_binary: { path: resolve(binary), sha256: sha256(await readFile(binary)) },
    sources, source_manifest_sha256: sha256(JSON.stringify(sources)) };
}
