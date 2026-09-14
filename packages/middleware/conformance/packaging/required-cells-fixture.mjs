/** Package the exact operation catalog without the global evidence source lock. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
export const requiredCellsSource = 'packages/middleware/conformance/support/catalog.mjs';
export const requiredCellsDestination = 'required-cells.json';
const producer = 'packages/middleware/conformance/packaging/required-cells-fixture.mjs';
const kind = 'caveman-packaging-required-cells/v1';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => `${JSON.stringify(value, null, 2)}\n`;
const reference = async path => {
  assert(!isAbsolute(path) && !path.includes('\\') && path.split('/').every(part => part && part !== '.' && part !== '..'), 'Invalid catalog producer input');
  return { path, sha256: hash(await readFile(resolve(root, path))) };
};

/** Execute captured catalog bytes; the consumer receives only generated JSON. */
export async function requiredCellsSnapshot() {
  const source = await readFile(resolve(root, requiredCellsSource));
  const catalog = await import(`data:text/javascript;base64,${source.toString('base64')}`);
  const cells = catalog.requiredCells();
  assert(Array.isArray(cells) && cells.length > 0, 'Mandatory operation catalog is empty');
  const specification = await Promise.all(catalog.specificationFiles.map(reference));
  const provenance = { kind, producer: await reference(producer),
    catalog: { path: requiredCellsSource, sha256: hash(source) }, specification,
    cells_revision: hash(encode(cells)), specification_revision: hash(encode(specification)) };
  // A source mutation during capture must not be attached to earlier output.
  for (const input of [provenance.producer, provenance.catalog, ...specification])
    assert.deepEqual(await reference(input.path), input, `Catalog input changed during capture: ${input.path}`);
  const bytes = encode({ schema_version: 1, cells });
  return { bytes, sha256: hash(bytes), provenance };
}

export async function writeRequiredCellsFixture(copy) {
  const snapshot = await requiredCellsSnapshot();
  await writeFile(copy, snapshot.bytes, { flag: 'wx' });
  return { source: requiredCellsSource, original_sha256: snapshot.provenance.catalog.sha256,
    copy, copied_sha256: snapshot.sha256, generated: snapshot.provenance };
}

/** A saved count, hash or catalog label cannot stand in for the entire array. */
export async function verifyRequiredCellsFixture(record, { path, expectedCopy } = {}) {
  assert.equal(record?.source, requiredCellsSource, 'Generated fixture names another catalog');
  assert.equal(record.copy, expectedCopy, 'Generated fixture is not the consumer catalog path');
  const expected = await requiredCellsSnapshot();
  assert.equal(record.original_sha256, expected.provenance.catalog.sha256, 'Catalog source revision changed');
  assert.deepEqual(record.generated, expected.provenance, 'Generated fixture producer or scope revision differs');
  assert.equal(record.copied_sha256, expected.sha256, 'Generated fixture does not contain the complete canonical catalog');
  const bytes = await readFile(path);
  assert.equal(hash(bytes), record.copied_sha256, 'Generated fixture copy was substituted');
  assert.equal(bytes.toString('utf8'), expected.bytes, 'Generated fixture differs from current canonical cells');
}
