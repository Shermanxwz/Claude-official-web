// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createStateStore } from '../../src/state.mjs';

const MAX_STATE_BYTES = 16 * 1024 * 1024;

describe('createStateStore', () => {
  /** @type {string} */
  let root;

  before(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'caw-state-test-'));
  });

  after(async () => {
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  /** @returns {Promise<string>} */
  async function caseDir() {
    return fs.promises.mkdtemp(path.join(root, 'case-'));
  }

  it('rejects a relative state directory', () => {
    assert.throws(() => createStateStore('relative/state'), TypeError);
    assert.throws(() => createStateStore(/** @type {any} */ (undefined)), TypeError);
  });

  it('round-trips a JSON value and creates missing directories with mode 0700', async () => {
    const dir = path.join(await caseDir(), 'nested', 'state');
    const store = createStateStore(dir);
    const value = { dirs: [{ path: '/work/a', createdAt: 1700000000000 }] };

    await store.write('uploads', value);

    assert.deepEqual(await store.read('uploads', null), value);
    assert.equal((await fs.promises.stat(dir)).mode & 0o777, 0o700);
    assert.equal((await fs.promises.stat(path.join(dir, 'uploads.json'))).mode & 0o777, 0o600);
  });

  it('does not create the state directory when reading', async () => {
    const dir = path.join(await caseDir(), 'absent');
    const store = createStateStore(dir);

    assert.equal(await store.read('anything', 7), 7);
    await assert.rejects(fs.promises.stat(dir), { code: 'ENOENT' });
  });

  it('returns the fallback for a missing file', async () => {
    const store = createStateStore(await caseDir());
    assert.deepEqual(await store.read('missing', { x: 1 }), { x: 1 });
  });

  it('returns the fallback for corrupt JSON', async () => {
    const dir = await caseDir();
    await fs.promises.writeFile(path.join(dir, 'broken.json'), '{"dirs": [', 'utf8');
    assert.equal(await createStateStore(dir).read('broken', 'fallback'), 'fallback');
  });

  it('returns the fallback when a directory sits where the file should be', async () => {
    const dir = await caseDir();
    await fs.promises.mkdir(path.join(dir, 'shape.json'));
    assert.equal(await createStateStore(dir).read('shape', 'fallback'), 'fallback');
  });

  it('returns the fallback for a file above the size cap without reading it', async () => {
    const dir = await caseDir();
    const file = path.join(dir, 'huge.json');
    await fs.promises.writeFile(file, '[]', 'utf8');
    await fs.promises.truncate(file, MAX_STATE_BYTES + 1);
    assert.equal(await createStateStore(dir).read('huge', 'fallback'), 'fallback');
  });

  it('replaces the previous value and leaves no temporary files behind', async () => {
    const dir = await caseDir();
    const store = createStateStore(dir);

    await store.write('x', { version: 1 });
    await store.write('x', { version: 2 });

    assert.deepEqual(await store.read('x', null), { version: 2 });
    assert.deepEqual(await fs.promises.readdir(dir), ['x.json']);
  });

  it('keeps the previous value when the new value cannot be serialized', async () => {
    const dir = await caseDir();
    const store = createStateStore(dir);
    await store.write('keep', { ok: 1 });

    /** @type {Record<string, unknown>} */
    const circular = {};
    circular.self = circular;

    await assert.rejects(store.write('keep', circular), TypeError);
    assert.deepEqual(await store.read('keep', null), { ok: 1 });
    assert.deepEqual(await fs.promises.readdir(dir), ['keep.json']);
  });

  it('rejects undefined as a value', async () => {
    const store = createStateStore(await caseDir());
    await assert.rejects(store.write('empty', undefined), TypeError);
  });

  it('validates state names on read and on write', async () => {
    const store = createStateStore(await caseDir());
    const invalid = [
      '', 'Upper', 'a/b', '../escape', 'with space', 'dot.name', 'x'.repeat(65), 'ünï', null, 42,
    ];
    for (const name of invalid) {
      await assert.rejects(store.read(/** @type {any} */ (name), 0), TypeError, `read ${String(name)}`);
      await assert.rejects(store.write(/** @type {any} */ (name), 1), TypeError, `write ${String(name)}`);
    }
  });

  it('accepts names at the length boundary and with digits and hyphens', async () => {
    const dir = await caseDir();
    const store = createStateStore(dir);
    for (const name of ['a', 'a-1', 'x'.repeat(64)]) {
      await store.write(name, name.length);
      assert.equal(await store.read(name, null), name.length);
    }
  });

  it('keeps the file valid under concurrent writes', async () => {
    const dir = await caseDir();
    const store = createStateStore(dir);

    await Promise.all(Array.from({ length: 25 }, (_, i) => store.write('counter', { i })));

    const final = await store.read('counter', null);
    assert.equal(typeof final.i, 'number');
    assert.ok(final.i >= 0 && final.i < 25);
    assert.deepEqual(await fs.promises.readdir(dir), ['counter.json']);
  });
});
