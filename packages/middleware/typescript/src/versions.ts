import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { MiddlewareRuntime } from '@caveman-ai/sdk/middleware';

// Framework peers cannot be declared globally: independently selectable native
// adapters can require mutually incompatible optional provider SDK versions.
// Consumers install their selected native framework; exact support is checked
// at its entry point before any history, tool, or transport is changed.
const require = createRequire(import.meta.url);
const installed = new Map<string, string | null>();
export function installedFrameworkVersion(name: string, entry = name): string | null {
  const key = `${name}:${entry}`;
  if (installed.has(key)) return installed.get(key)!;
  let version: string | null = null;
  try {
    let directory = dirname(require.resolve(entry));
    for (let depth = 0; depth < 16; depth++) {
      try {
        const metadata = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
        if (metadata.name === name && typeof metadata.version === 'string') { version = metadata.version; break; }
      } catch { /* Entry points may be several directories below their package. */ }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  } catch { /* Missing or unreadable framework metadata cannot certify a version. */ }
  if (installed.size >= 32) installed.clear();
  installed.set(key, version);
  return version;
}

/** Pure version check for adapters retaining a passive per-call delegate. */
export function matchesFramework(name: string, expected: string, entry = name): boolean {
  return installedFrameworkVersion(name, entry) === expected;
}

export function supportsFramework(runtime: MiddlewareRuntime, name: string, expected: string, entry = name): boolean {
  if (runtime.mode === 'off') return false;
  if (matchesFramework(name, expected, entry)) return true;
  runtime.decline('unsupported_version');
  return false;
}
