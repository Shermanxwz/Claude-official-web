// @ts-check
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { startMaintenance } from '../../src/maintenance.mjs';

/**
 * @param {unknown} value
 * @returns {any}
 */
const untyped = (value) => value;

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

function createLog() {
  /** @type {Array<{level: string, message: string, fields: Record<string, unknown>}>} */
  const entries = [];
  /** @param {string} level */
  const record = (level) => (/** @type {string} */ message, /** @type {Record<string, unknown>} */ fields = {}) => {
    entries.push({ level, message, fields });
  };
  return { entries, debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') };
}

/**
 * @param {() => Promise<{removed: number}>} cleanup
 */
function fakeAttachments(cleanup) {
  return untyped({ cleanup });
}

describe('startMaintenance', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('runOnce removes expired uploads and logs only the count and retention window', async () => {
    const log = createLog();
    let calls = 0;
    const attachments = fakeAttachments(async () => {
      calls += 1;
      return { removed: 3 };
    });
    const maintenance = startMaintenance({
      config: untyped({ uploadRetentionDays: 7 }), log, attachments, initialDelayMs: 60000, intervalMs: 60000,
    });
    try {
      await maintenance.runOnce();
    } finally {
      maintenance.stop();
    }
    assert.equal(calls, 1);
    assert.deepEqual(log.entries, [{
      level: 'info', message: 'upload maintenance finished', fields: { removed: 3, retentionDays: 7 },
    }]);
  });

  it('runOnce logs failures with the error code only and never rejects', async () => {
    const log = createLog();
    const failing = fakeAttachments(async () => {
      throw Object.assign(new Error('EACCES: permission denied, unlink /secret/place/file.txt'), { code: 'EACCES' });
    });
    const syncFailing = untyped({
      cleanup: () => {
        throw new Error('boom');
      },
    });
    const maintenance = startMaintenance({
      config: untyped({ uploadRetentionDays: 7 }), log, attachments: failing, initialDelayMs: 60000, intervalMs: 60000,
    });
    try {
      await maintenance.runOnce();
      assert.deepEqual(log.entries.map((entry) => entry.fields), [{ code: 'EACCES' }]);
      assert.equal(JSON.stringify(log.entries).includes('/secret/place'), false);

      const other = startMaintenance({
        config: untyped({ uploadRetentionDays: 7 }),
        log,
        attachments: syncFailing,
        initialDelayMs: 60000,
        intervalMs: 60000,
      });
      try {
        await other.runOnce();
      } finally {
        other.stop();
      }
      assert.equal(log.entries.at(-1)?.fields.code, 'UNKNOWN');
    } finally {
      maintenance.stop();
    }
  });

  it('shares one run between overlapping runOnce calls and starts a new run afterwards', async () => {
    const log = createLog();
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = () => resolve(undefined);
    });
    let calls = 0;
    const attachments = fakeAttachments(async () => {
      calls += 1;
      await gate;
      return { removed: 0 };
    });
    const maintenance = startMaintenance({
      config: untyped({ uploadRetentionDays: 7 }), log, attachments, initialDelayMs: 60000, intervalMs: 60000,
    });
    try {
      const first = maintenance.runOnce();
      const second = maintenance.runOnce();
      assert.equal(first, second);
      release();
      await Promise.all([first, second]);
      assert.equal(calls, 1);
      await maintenance.runOnce();
      assert.equal(calls, 2);
    } finally {
      maintenance.stop();
    }
  });

  it('runs after the initial delay and then on every interval until stop()', async () => {
    const log = createLog();
    let runs = 0;
    const attachments = fakeAttachments(async () => {
      runs += 1;
      return { removed: 0 };
    });
    const maintenance = startMaintenance({
      config: untyped({ uploadRetentionDays: 7 }), log, attachments, initialDelayMs: 5, intervalMs: 5,
    });
    await sleep(80);
    maintenance.stop();
    assert.ok(runs >= 2, `expected at least two runs, saw ${runs}`);
    const settled = runs;
    await sleep(40);
    assert.equal(runs, settled);
  });

  it('schedules unref-ed timers and clears them on stop()', async () => {
    const timeoutSpy = mock.method(globalThis, 'setTimeout');
    const intervalSpy = mock.method(globalThis, 'setInterval');
    const clearTimeoutSpy = mock.method(globalThis, 'clearTimeout');
    const clearIntervalSpy = mock.method(globalThis, 'clearInterval');
    const attachments = fakeAttachments(async () => ({ removed: 0 }));
    const maintenance = startMaintenance({
      config: untyped({ uploadRetentionDays: 7 }),
      log: createLog(),
      attachments,
      initialDelayMs: 61001,
      intervalMs: 61003,
    });

    const initial = timeoutSpy.mock.calls.find((call) => call.arguments[1] === 61001)?.result;
    const periodic = intervalSpy.mock.calls.find((call) => call.arguments[1] === 61003)?.result;
    assert.ok(initial && periodic);
    assert.equal(initial.hasRef(), false);
    assert.equal(periodic.hasRef(), false);

    maintenance.stop();
    assert.ok(clearTimeoutSpy.mock.calls.some((call) => call.arguments[0] === initial));
    assert.ok(clearIntervalSpy.mock.calls.some((call) => call.arguments[0] === periodic));
  });

  it('uses a five second initial delay and an hourly interval by default', () => {
    const timeoutSpy = mock.method(globalThis, 'setTimeout');
    const intervalSpy = mock.method(globalThis, 'setInterval');
    const maintenance = startMaintenance({
      config: untyped({ uploadRetentionDays: 7 }),
      log: createLog(),
      attachments: fakeAttachments(async () => ({ removed: 0 })),
    });
    try {
      assert.ok(timeoutSpy.mock.calls.some((call) => call.arguments[1] === 5000));
      assert.ok(intervalSpy.mock.calls.some((call) => call.arguments[1] === 3600000));
    } finally {
      maintenance.stop();
    }
  });

  it('rejects invalid timing options before scheduling anything', () => {
    const base = {
      config: untyped({ uploadRetentionDays: 7 }),
      log: createLog(),
      attachments: fakeAttachments(async () => ({ removed: 0 })),
    };
    assert.throws(() => startMaintenance({ ...base, intervalMs: 0 }), TypeError);
    assert.throws(() => startMaintenance({ ...base, intervalMs: Number.NaN }), TypeError);
    assert.throws(() => startMaintenance({ ...base, initialDelayMs: -1 }), TypeError);
    assert.throws(() => startMaintenance({ ...base, initialDelayMs: Number.POSITIVE_INFINITY }), TypeError);
  });
});
