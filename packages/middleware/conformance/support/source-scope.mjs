/** Owned native imports and literal fixture inputs, independent of saved claims. */
import { readFile, readdir, stat, realpath } from 'node:fs/promises';
import { dirname, resolve, relative, sep } from 'node:path';
import { root } from './inventory.mjs';
import { families } from './catalog.mjs';

const exists = path => stat(resolve(root, path)).then(value => value.isFile()).catch(() => false);
const fail = message => { throw new Error(`Native source scope refused: ${message}`); };
const normalize = path => relative(root, resolve(root, path)).split(sep).join('/');

function role(path) {
  if (/packages\/(?:middleware|sdk)\/typescript\/dist\//.test(path)) return 'executed_module';
  if (/^packages\/middleware\/(?:typescript\/src|python\/caveman_middleware)\//.test(path)) return 'adapter_source';
  if (/^packages\/sdk\/(?:typescript\/src|python\/caveman_cloud)\//.test(path)) return 'sdk_source';
  if (/(?:package-lock\.json|requirements\.lock)$/.test(path)) return 'dependency_lock';
  if (/(?:package\.json|pyproject\.toml)$/.test(path)) return 'package_or_fixture';
  return 'test_source';
}

async function resolveFile(path, source) {
  path = normalize(path);
  if (path === '..' || path.startsWith('../')) fail(`import escaped repository: ${path}`);
  const paths = [path];
  if (path.endsWith('.js') && source.endsWith('.ts')) paths.unshift(path.slice(0, -3) + '.ts');
  if (!/\.[a-z]+$/.test(path)) paths.push(`${path}.py`, `${path}/__init__.py`, `${path}.ts`, `${path}.js`, `${path}.mjs`);
  for (const candidate of paths) if (await exists(candidate)) return candidate;
  return null;
}

async function javascriptImports(path, text) {
  const specifiers = new Set();
  const patterns = [
    /^\s*(?:import|export)\s+(?:type\s+)?[^;]*?\bfrom\s*['"]([^'"]+)['"]/gm,
    /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /^\s*import\s*['"]([^'"]+)['"]/gm,
    /new\s+URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g,
  ];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) specifiers.add(match[1]);
  const files = [];
  for (const specifier of specifiers) {
    if (specifier.startsWith('.')) {
      const selected = await resolveFile(resolve(root, dirname(path), specifier), path);
      if (!selected && /\.(?:mjs|js|ts|json|py)$/.test(specifier)) fail(`unresolved owned import in ${path}: ${specifier}`);
      if (selected) files.push(selected);
    } else if (specifier === '@caveman-ai/sdk/middleware') files.push('packages/sdk/typescript/src/middleware/index.ts', 'packages/sdk/typescript/dist/middleware/index.js');
    else if (specifier.startsWith('@caveman-ai/middleware/')) {
      const name = specifier.slice('@caveman-ai/middleware/'.length);
      if (!/^[a-z][a-z-]*$/.test(name)) fail(`unresolved native adapter export ${specifier}`);
      files.push(`packages/middleware/typescript/src/${name}.ts`, `packages/middleware/typescript/dist/${name}.js`);
    }
  }
  return files;
}

async function pythonImports(path, text) {
  const files = [], imports = [];
  for (const match of text.matchAll(/^\s*from\s+([.\w]+)\s+import\s+([^\n]+)/gm)) {
    imports.push(match[1]);
    if (/^\.+$/.test(match[1])) for (const name of match[2].replace(/[()]/g, '').split(',')) {
      const value = name.trim().split(/\s+as\s+/)[0];
      if (/^\w+$/.test(value)) imports.push(match[1] + value);
    }
  }
  for (const match of text.matchAll(/^\s*import\s+([\w., ]+)/gm)) for (const name of match[1].split(',')) imports.push(name.trim().split(/\s+as\s+/)[0]);
  const roots = [dirname(path), 'packages/middleware/conformance', 'examples/middleware/python-provider-sdks'];
  for (const specifier of imports) {
    const leading = specifier.match(/^\.+/)?.[0].length ?? 0;
    let candidates;
    if (leading) candidates = [resolve(root, dirname(path), ...Array(leading - 1).fill('..'), specifier.slice(leading).replaceAll('.', '/'))];
    else if (specifier === 'caveman_cloud' || specifier.startsWith('caveman_cloud.')) {
      candidates = ['packages/sdk/python/' + specifier.replaceAll('.', '/')];
      files.push('packages/sdk/python/caveman_cloud/__init__.py');
    } else if (specifier === 'caveman_middleware' || specifier.startsWith('caveman_middleware.')) {
      candidates = ['packages/middleware/python/' + specifier.replaceAll('.', '/')];
      files.push('packages/middleware/python/caveman_middleware/__init__.py');
    } else candidates = roots.map(directory => `${directory}/${specifier.replaceAll('.', '/')}`);
    for (const candidate of candidates) {
      const selected = await resolveFile(candidate, path);
      if (selected) { files.push(selected); break; }
    }
  }
  for (const match of text.matchAll(/\.with_name\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (/^\s*\.(?:write_text|write_bytes|unlink)\s*\(/.test(text.slice(match.index + match[0].length))) continue;
    const selected = await resolveFile(`${dirname(path)}/${match[1]}`, path);
    if (selected) files.push(selected);
  }
  return files;
}

/** Required imports are derived from the reviewed family/test entry points. */
export async function requiredNativeSources({ family, language, tests }) {
  const config = families.find(item => item.id === family)?.languages[language];
  if (!config || !tests?.length || tests.some(file => !config.tests.includes(file))) fail('unknown family or native test entry point');
  const languagePath = language === 'typescript' ? 'typescript' : 'python';
  const manifest = language === 'typescript' ? 'package.json' : 'pyproject.toml';
  const queue = [...config.source, ...config.lock, ...tests,
    `packages/middleware/${languagePath}/${manifest}`, `packages/sdk/${languagePath}/${manifest}`,
    'packages/middleware/conformance/runtime-fixture.mjs',
    'packages/middleware/conformance/support/source-scope.mjs', 'packages/middleware/conformance/support/runtime-build.mjs'];
  if (language === 'typescript') {
    for (const name of await readdir(resolve(root, 'packages/sdk/typescript/src/middleware'))) if (name.endsWith('.ts')) queue.push(`packages/sdk/typescript/src/middleware/${name}`);
  } else {
    queue.push('packages/sdk/python/caveman_cloud/__init__.py', 'packages/middleware/python/caveman_middleware/__init__.py');
    for (const name of await readdir(resolve(root, 'packages/sdk/python/caveman_cloud/middleware'))) if (name.endsWith('.py')) queue.push(`packages/sdk/python/caveman_cloud/middleware/${name}`);
    queue.push('packages/middleware/conformance/python_fixture.py', 'packages/middleware/conformance/evidence_runtime.py',
      family === 'F01' || family === 'F02' ? 'packages/middleware/conformance/python-provider.test.mjs' : 'packages/middleware/conformance/python-framework.test.mjs');
    if (family === 'F13') queue.push('examples/middleware/pydantic-ai/_fixture.py');
  }
  const selected = new Set();
  while (queue.length) {
    const path = normalize(queue.shift());
    if (selected.has(path)) continue;
    if (!(await exists(path))) fail(`required owned input is absent: ${path}`);
    const actual = await realpath(resolve(root, path));
    if (relative(root, actual).startsWith(`..${sep}`)) fail(`owned input is a symlink outside repository: ${path}`);
    selected.add(path);
    if (/^packages\/(?:middleware|sdk)\/typescript\/dist\/.+\.js$/.test(path)) {
      const source = path.replace('/dist/', '/src/').replace(/\.js$/, '.ts');
      if (await exists(source)) queue.push(source);
    }
    if (/^packages\/(?:middleware|sdk)\/typescript\/src\/.+\.ts$/.test(path) && !path.endsWith('.d.ts')) {
      const executed = path.replace('/src/', '/dist/').replace(/\.ts$/, '.js');
      if (await exists(executed)) queue.push(executed);
    }
    const text = await readFile(resolve(root, path), 'utf8');
    if (/\.(?:mjs|js|ts)$/.test(path)) queue.push(...await javascriptImports(path, text));
    if (path.endsWith('.py')) queue.push(...await pythonImports(path, text));
  }
  return [...selected].sort().map(path => ({ path, role: role(path) }));
}
