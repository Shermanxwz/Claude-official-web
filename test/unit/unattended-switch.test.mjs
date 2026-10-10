// Tests for the unattended switch (src/unattended.mjs): when it is available and why not, the saved value and what
// stands in for it, and how a change is saved, stamped and serialized. The state store is a fake, except for the
// persistence test, which uses the real state store in a temporary directory.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUnattendedSwitch } from '../../src/unattended.mjs';
import { createStateStore } from '../../src/state.mjs';
import { AppError } from '../../src/contracts.mjs';

const NOW = 1_700_000_000_000;

/** @param {Record<string, unknown>} [over] */
function configWith(over = {}) {
  return { profile: 'full', allowBypass: true, unattendedDefault: false, ...over };
}

/**
 * A state store that keeps one record in memory and remembers every write. `initial` is the record already saved.
 * @param {unknown} [initial]
 */
function memoryStore(initial = undefined) {
  /** @type {unknown[]} */
  const writes = [];
  let record = initial;
  return {
    writes,
    get record() {
      return record;
    },
    async read(name, fallback) {
      assert.equal(name, 'unattended');
      return record === undefined ? fallback : structuredClone(record);
    },
    async write(name, value) {
      assert.equal(name, 'unattended');
      writes.push(structuredClone(value));
      record = structuredClone(value);
    },
  };
}

/** @param {unknown} error */
function isFeatureDisabled(error) {
  return error instanceof AppError && error.status === 501 && error.code === 'FEATURE_DISABLED';
}

describe('unattended switch availability', () => {
  test('a profile other than full makes the switch unavailable, and the profile is the reason even without bypass',
    async () => {
      for (const config of [configWith({ profile: 'standard', allowBypass: false }),
        configWith({ profile: 'read', allowBypass: true })]) {
        const sw = createUnattendedSwitch({ config, stateStore: memoryStore() });
        await sw.load();
        assert.deepEqual(sw.state(), { available: false, enabled: false, reason: 'profile', changedAt: null });
        assert.equal(sw.enabled(), false);
        await assert.rejects(sw.set(true), isFeatureDisabled);
      }
    });

  test('without bypass the switch is unavailable with not-allowed as the reason, and set is refused', async () => {
    const store = memoryStore({ enabled: true, changedAt: 3 });
    const sw = createUnattendedSwitch({ config: configWith({ allowBypass: false }), stateStore: store });
    await sw.load();
    assert.deepEqual(sw.state(), { available: false, enabled: false, reason: 'not-allowed', changedAt: 3 });
    await assert.rejects(sw.set(false), isFeatureDisabled);
    assert.deepEqual(store.writes, []);
  });

  test('an unavailable switch keeps the saved value in the file and writes nothing at load', async () => {
    const store = memoryStore({ enabled: true, changedAt: 7 });
    const sw = createUnattendedSwitch({ config: configWith({ allowBypass: false }), stateStore: store });
    await sw.load();
    assert.equal(sw.enabled(), false);
    assert.deepEqual(store.writes, []);
    assert.deepEqual(store.record, { enabled: true, changedAt: 7 });
    const later = createUnattendedSwitch({ config: configWith(), stateStore: store });
    await later.load();
    assert.equal(later.enabled(), true, 'the saved value applies once bypass is allowed again');
  });
});

describe('unattended switch saved value', () => {
  test('without a saved value the switch starts as CAW_UNATTENDED says; a saved value overrides it', async () => {
    const byDefault = createUnattendedSwitch({
      config: configWith({ unattendedDefault: true }), stateStore: memoryStore(),
    });
    await byDefault.load();
    assert.deepEqual(byDefault.state(), { available: true, enabled: true, reason: null, changedAt: null });

    const saved = createUnattendedSwitch({
      config: configWith({ unattendedDefault: true }), stateStore: memoryStore({ enabled: false, changedAt: 5 }),
    });
    await saved.load();
    assert.deepEqual(saved.state(), { available: true, enabled: false, reason: null, changedAt: 5 });
  });

  test('a saved record that is not valid counts as no saved value', async () => {
    const invalid = ['on', null, [], { enabled: 'yes' }, { enabled: true, changedAt: 'now' },
      { enabled: true, changedAt: Number.POSITIVE_INFINITY }, { changedAt: 4 }];
    for (const value of invalid) {
      const sw = createUnattendedSwitch({
        config: configWith({ unattendedDefault: true }), stateStore: memoryStore(value),
      });
      await sw.load();
      assert.deepEqual(sw.state(), { available: true, enabled: true, reason: null, changedAt: null },
        JSON.stringify(value));
    }
  });

  test('the switch uses the unattended state name, and the saved record is {enabled, changedAt}', async () => {
    const store = memoryStore();
    const sw = createUnattendedSwitch({ config: configWith(), stateStore: store, now: () => NOW });
    await sw.load();
    await sw.set(true);
    assert.deepEqual(store.record, { enabled: true, changedAt: NOW });
  });
});

describe('unattended switch changes', () => {
  test('set saves the value, reports the change and stamps the time of the change only', async () => {
    let now = NOW;
    const store = memoryStore();
    const sw = createUnattendedSwitch({ config: configWith(), stateStore: store, now: () => now });
    await sw.load();
    assert.deepEqual(await sw.set(true), {
      changed: true, state: { available: true, enabled: true, reason: null, changedAt: NOW },
    });
    now += 1000;
    assert.deepEqual(await sw.set(true), {
      changed: false, state: { available: true, enabled: true, reason: null, changedAt: NOW },
    });
    assert.deepEqual(store.writes.at(-1), { enabled: true, changedAt: NOW }, 'every call writes the state file');
    assert.equal(store.writes.length, 2);
    now += 1000;
    assert.deepEqual(await sw.set(false), {
      changed: true, state: { available: true, enabled: false, reason: null, changedAt: NOW + 2000 },
    });
    assert.equal(sw.enabled(), false);
  });

  test('a value equal to the default is not a change and leaves changedAt empty', async () => {
    const store = memoryStore();
    const sw = createUnattendedSwitch({ config: configWith({ unattendedDefault: true }), stateStore: store });
    await sw.load();
    assert.deepEqual(await sw.set(true), {
      changed: false, state: { available: true, enabled: true, reason: null, changedAt: null },
    });
    assert.deepEqual(store.record, { enabled: true, changedAt: null });
  });

  test('calls run one after the other, so each compares with the value the one before it saved', async () => {
    const store = memoryStore();
    const sw = createUnattendedSwitch({ config: configWith(), stateStore: store, now: () => NOW });
    await sw.load();
    const [first, second] = await Promise.all([sw.set(true), sw.set(false)]);
    assert.equal(first.changed, true);
    assert.equal(second.changed, true);
    assert.equal(first.state.enabled, true);
    assert.equal(second.state.enabled, false);
    assert.deepEqual(store.writes.map((record) => record.enabled), [true, false]);
    assert.equal(sw.enabled(), false);
  });

  test('a failed write leaves the value in effect as it was, and the next change still runs', async () => {
    let failNext = true;
    /** @type {Record<string, unknown>|null} */
    let record = null;
    const store = {
      async read(_name, fallback) {
        return record ?? fallback;
      },
      async write(_name, value) {
        if (failNext) {
          failNext = false;
          throw new Error('disk full at /home/claude/state');
        }
        record = value;
      },
    };
    const sw = createUnattendedSwitch({ config: configWith(), stateStore: store, now: () => NOW });
    await sw.load();
    await assert.rejects(sw.set(true), /disk full/);
    assert.equal(sw.enabled(), false);
    assert.equal(sw.state().changedAt, null);
    assert.deepEqual(await sw.set(true), {
      changed: true, state: { available: true, enabled: true, reason: null, changedAt: NOW },
    });
  });

  test('the value survives a restart through the state file of the real store', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caw-unattended-'));
    try {
      const first = createUnattendedSwitch({ config: configWith(), stateStore: createStateStore(dir), now: () => NOW });
      await first.load();
      await first.set(true);
      const second = createUnattendedSwitch({ config: configWith(), stateStore: createStateStore(dir) });
      await second.load();
      assert.deepEqual(second.state(), { available: true, enabled: true, reason: null, changedAt: NOW });
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'unattended.json'), 'utf8')),
        { enabled: true, changedAt: NOW });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
