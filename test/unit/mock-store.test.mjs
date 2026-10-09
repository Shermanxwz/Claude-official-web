// Tests for the in-memory session store (createMemoryStore in src/engine/mock/store.mjs), which a query that does not
// persist its session uses. It keeps records in a Map and never touches the disk.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore, newRecord } from '../../src/engine/mock/store.mjs';

const FIRST = '0b6f6a52-2d2e-4f7a-9d8e-1a2b3c4d5e6f';
const SECOND = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
/** A time in the far future, so the records order by their own stamps rather than the wall clock. */
const FUTURE = 5e12;

describe('createMemoryStore', () => {
  test('a created record reads back, and each read is a copy of the stored record', () => {
    const store = createMemoryStore();
    store.create(newRecord({ sessionId: FIRST, cwd: '/work/app', now: FUTURE }));
    const read = store.read(FIRST);
    assert.equal(read.cwd, '/work/app');
    read.cwd = '/elsewhere';
    assert.equal(store.read(FIRST).cwd, '/work/app');
    assert.equal(store.read(SECOND), undefined);
  });

  test('a session id must be a lowercase UUID, and each id is created once', () => {
    const store = createMemoryStore();
    assert.throws(() => store.create(newRecord({ sessionId: 'not-a-uuid', cwd: '/w' })),
      { name: 'TypeError', message: 'Session id must be a lowercase UUID' });
    assert.throws(() => store.create(newRecord({ sessionId: FIRST.toUpperCase(), cwd: '/w' })),
      { name: 'TypeError', message: 'Session id must be a lowercase UUID' });
    store.create(newRecord({ sessionId: FIRST, cwd: '/w' }));
    assert.throws(() => store.create(newRecord({ sessionId: FIRST, cwd: '/w' })),
      { name: 'Error', message: 'Session already exists' });
  });

  test('an update applies the change and stamps the record later than it was', () => {
    const store = createMemoryStore();
    const created = store.create(newRecord({ sessionId: FIRST, cwd: '/w', now: FUTURE }));
    const updated = store.update(FIRST, (record) => {
      record.customTitle = 'Renamed';
    });
    assert.equal(updated.customTitle, 'Renamed');
    assert.equal(store.read(FIRST).customTitle, 'Renamed');
    assert.equal(updated.lastModified, created.lastModified + 1, 'the stamp moves on even when the clock stands still');
  });

  test('an update of a missing record, or with the wrong folder, is refused as not found', () => {
    const store = createMemoryStore();
    store.create(newRecord({ sessionId: FIRST, cwd: '/w' }));
    assert.throws(() => store.update(SECOND, () => {}), { message: 'Session not found' });
    assert.throws(() => store.update(FIRST, () => {}, '/other'), { message: 'Session not found' });
    assert.doesNotThrow(() => store.update(FIRST, () => {}, '/w'));
  });

  test('findLatest returns the most recently modified record of the folder, and none for an unknown folder', () => {
    const store = createMemoryStore();
    store.create(newRecord({ sessionId: FIRST, cwd: '/w', now: FUTURE }));
    store.create(newRecord({ sessionId: SECOND, cwd: '/w', now: FUTURE + 10 }));
    store.create(newRecord({ sessionId: '11111111-2222-4333-8444-555555555555', cwd: '/other', now: FUTURE + 20 }));
    assert.equal(store.findLatest('/w').sessionId, SECOND);
    store.update(FIRST, (record) => {
      record.lastModified = FUTURE + 100;
    });
    assert.equal(store.findLatest('/w').sessionId, FIRST, 'an update makes a record the latest');
    assert.equal(store.findLatest('/nowhere'), undefined);
  });
});
