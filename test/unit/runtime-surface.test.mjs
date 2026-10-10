// Keeps src/engine/runtime-surface.mjs honest against the gateway source: every method the gateway calls by name
// is listed, and every listed undeclared method is still called. `npm run contract` checks the SDK itself.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME_VIEWS } from '../../src/contracts.mjs';
import { RUNTIME_SURFACE } from '../../src/engine/runtime-surface.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
/**
 * A call that names its runtime method as a string literal: runtimeMethod(query, 'name') or methodOf(query, 'name').
 */
const LITERAL_CALL = /\b(?:runtimeMethod|methodOf)\(\s*[^,()]+,\s*'([A-Za-z_$][\w$]*)'/g;
const SOURCE_OF_KIND = {
  'query-method': 'sdk.d.ts',
  'query-option': 'sdk.d.ts',
  'sdk-export': 'sdk.d.ts',
  'sdk-method': 'sdk.mjs',
  'sdk-option': 'sdk.mjs',
  'sdk-env': 'sdk.mjs',
  'cli-flag': 'binary',
  env: 'binary',
  stream: 'binary',
  dialog: 'binary',
};

/**
 * @param {string} dir
 * @returns {string[]} every .mjs file below dir
 */
function modulesIn(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return modulesIn(file);
    return entry.name.endsWith('.mjs') ? [file] : [];
  });
}

/** @returns {Set<string>} the method names the gateway source calls by a literal name */
function literalCallNames() {
  const names = new Set();
  for (const file of modulesIn(SRC)) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(LITERAL_CALL)) names.add(match[1]);
  }
  return names;
}

const viewMethods = new Set(Object.values(RUNTIME_VIEWS).map((view) => view.method));
const listedMethods = new Set(
  RUNTIME_SURFACE.filter((entry) => entry.kind === 'query-method' || entry.kind === 'sdk-method')
    .map((entry) => entry.name),
);

describe('runtime surface list', () => {
  test('lists every runtime method that the gateway calls by name through runtimeMethod() or methodOf()', () => {
    const called = literalCallNames();
    assert.ok(called.size >= 10, `the scan found only ${called.size} literal calls`);
    assert.deepEqual([...called].filter((name) => !listedMethods.has(name)), [],
      'add each missing method to src/engine/runtime-surface.mjs');
  });

  test('lists every method of the runtime views, which the views call through a variable', () => {
    assert.deepEqual([...viewMethods].filter((name) => !listedMethods.has(name)), []);
  });

  test('lists no undeclared method that the gateway no longer calls', () => {
    const called = literalCallNames();
    const stale = RUNTIME_SURFACE.filter((entry) => entry.kind === 'sdk-method')
      .map((entry) => entry.name)
      .filter((name) => !called.has(name) && !viewMethods.has(name));
    assert.deepEqual(stale, []);
  });

  test('gives each entry a source that matches its kind, and a unique name per kind', () => {
    const seen = new Set();
    for (const entry of RUNTIME_SURFACE) {
      assert.equal(entry.source, SOURCE_OF_KIND[entry.kind],
        `${entry.kind} ${entry.name} is checked in the wrong source`);
      const key = `${entry.kind} ${entry.name}`;
      assert.equal(seen.has(key), false, `${key} is listed twice`);
      seen.add(key);
      assert.ok(entry.used.length > 0, `${key} says where the gateway uses it`);
      if (entry.wire !== undefined) {
        assert.ok(['sdk-method', 'sdk-option'].includes(entry.kind), `${key} has a wire name but is not an SDK call`);
      }
    }
  });
});
