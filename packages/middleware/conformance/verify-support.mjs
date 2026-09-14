#!/usr/bin/env node
/** Validate inventory truth separately from completion. Never makes live-provider calls. */
import { readFile } from 'node:fs/promises';
import { loadInventory } from './support/inventory.mjs';
import { validateQualifiedInventory } from './support/qualified-inventory.mjs';

const values = Object.fromEntries(process.argv.slice(2).filter(arg => arg.includes('=')).map(arg => arg.replace(/^--/, '').split(/=(.*)/s, 2)));
const flags = new Set(process.argv.slice(2).filter(arg => !arg.includes('=')));
const allowed = new Set(['--json', '--audit-completion', '--replay']);
try {
  for (const flag of flags) if (!allowed.has(flag)) throw new Error(`Unknown argument ${flag}`);
  for (const key of Object.keys(values)) if (!['python-map', 'replay-output'].includes(key)) throw new Error(`Unknown argument --${key}`);
  const inventory = await loadInventory();
  const pythonByScope = values['python-map'] ? JSON.parse(await readFile(values['python-map'], 'utf8')) : {};
  if (!pythonByScope || Array.isArray(pythonByScope) || typeof pythonByScope !== 'object' ||
      Object.entries(pythonByScope).some(([scope, path]) => !/^F\d{2}:python$/.test(scope) || typeof path !== 'string' || !path)) throw new Error('Python map must map exact Fxx:python scopes to interpreter paths');
  const result = await validateQualifiedInventory(inventory, { replay: flags.has('--replay'), pythonByScope, output: values['replay-output'] });
  if (flags.has('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Support inventory ${result.valid ? 'valid' : 'INVALID'}: ${result.counts.operations} required operation cells, ${result.counts.requirements} requirements, ${result.counts.acceptance_items} acceptance items.`);
    console.log(`States: ${result.counts.implemented} implemented, ${result.counts.missing} missing, ${result.counts.conformant} conformant, ${result.counts.provider_tested} provider_tested, ${result.counts.not_applicable} not_applicable.`);
    for (const error of result.errors.slice(0, 20)) console.error(`- ${error}`);
    if (result.errors.length > 20) console.error(`${result.errors.length - 20} additional validation errors; use --json.`);
    if (flags.has('--audit-completion')) {
      console.log(`Full completion ${result.completion.complete ? 'PASS' : 'FAIL'}: ${result.completion.operations.length} operation proof gaps; ${result.completion.acceptance.length} acceptance proof gaps; ${result.completion.release_gates.length} open release gates.`);
      for (const gate of result.completion.release_gates) console.log(`- ${gate.id} [${gate.state}]: ${gate.description}`);
    }
  }
  process.exitCode = !result.valid || (flags.has('--audit-completion') && !result.completion.complete) ? 1 : 0;
} catch (error) {
  console.error(`Support inventory validation failed: ${error.message}`);
  process.exitCode = 1;
}
