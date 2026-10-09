/**
 * Unit tests for the developer console's event log: the bounded ring buffer, the per-entry summary and the filters.
 * The panel markup is DOM code and is covered by the e2e suite.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  LOG_ENTRY_MAX_BYTES,
  createEventLog,
  distinctTypes,
  eventSubtype,
  filterEntries,
  formatBytes,
  summarizeEvent,
  utf8Length,
} from '../../public/js/ui/devtools.js';

describe('utf8Length', () => {
  it('counts bytes, not characters', () => {
    assert.equal(utf8Length('abc'), 3);
    assert.equal(utf8Length('é'), 2);
    assert.equal(utf8Length('😀'), 4);
  });
});

describe('eventSubtype', () => {
  it('names an SDK message by its type and subtype', () => {
    assert.equal(eventSubtype('sdk', { msg: { type: 'system', subtype: 'init' } }), 'system/init');
    assert.equal(eventSubtype('sdk', { msg: { type: 'assistant' } }), 'assistant');
    assert.equal(eventSubtype('sdk', { msg: {} }), null);
  });

  it('takes the label from the gateway event that carries one', () => {
    assert.equal(eventSubtype('request', { request: { kind: 'permission' } }), 'permission');
    assert.equal(eventSubtype('request_resolved', { outcome: 'allow' }), 'allow');
    assert.equal(eventSubtype('notice', { code: 'SESSION_NOT_LIVE' }), 'SESSION_NOT_LIVE');
    assert.equal(eventSubtype('session_state', { live: { state: 'running' } }), 'running');
    assert.equal(eventSubtype('session_state', { live: null }), 'closed');
    assert.equal(eventSubtype('message_cancelled', { reason: 'interrupted' }), 'interrupted');
  });

  it('returns null when the event has no label', () => {
    assert.equal(eventSubtype('heartbeat', null), null);
    assert.equal(eventSubtype('heartbeat', { ok: true }), null);
  });
});

describe('summarizeEvent', () => {
  it('keeps the payload of an event within the size limit', () => {
    const { entry, size } = summarizeEvent('notice', { code: 'X' }, 1000);
    assert.deepEqual(entry, { at: 1000, type: 'notice', subtype: 'X', bytes: 12, data: { code: 'X' } });
    assert.equal(size, 12);
  });

  it('keeps only the envelope of an oversized event, and counts that instead', () => {
    const big = { text: 'x'.repeat(LOG_ENTRY_MAX_BYTES + 1) };
    const { entry, size } = summarizeEvent('sdk', big, 5);
    assert.equal(entry.omitted, true);
    assert.equal(entry.data, undefined);
    assert.equal(entry.type, 'sdk');
    assert.ok(entry.bytes > LOG_ENTRY_MAX_BYTES);
    assert.ok(size < 200, `summary should be small, got ${size}`);
  });
});

describe('createEventLog', () => {
  it('keeps the newest entries when the count limit is reached', () => {
    const log = createEventLog({ maxEntries: 3, maxBytes: 100000, now: () => 7 });
    for (const n of [1, 2, 3, 4]) log.record('tick', { n });
    assert.deepEqual(log.entries().map((entry) => entry.data.n), [2, 3, 4]);
    assert.equal(log.entries()[0].at, 7);
    assert.equal(log.bytes(), 3 * '{"n":2}'.length);
  });

  it('drops the oldest entries while the byte budget is exceeded', () => {
    const log = createEventLog({ maxEntries: 100, maxBytes: 100, now: () => 1 });
    const payload = 'y'.repeat(40);
    log.record('blob', payload);
    log.record('blob', payload);
    assert.equal(log.entries().length, 2);
    log.record('blob', payload);
    assert.equal(log.entries().length, 2);
    assert.ok(log.bytes() <= 100);
  });

  it('tells its listeners after each change, and stops when unsubscribed', () => {
    const log = createEventLog({ now: () => 1 });
    let calls = 0;
    const unsubscribe = log.subscribe(() => {
      calls += 1;
    });
    log.record('a', {});
    log.record('b', {});
    assert.equal(calls, 2);
    unsubscribe();
    log.record('c', {});
    assert.equal(calls, 2);
  });

  it('empties the log and its byte count when cleared', () => {
    const log = createEventLog({ now: () => 1 });
    log.record('a', { v: 1 });
    log.clear();
    assert.deepEqual(log.entries(), []);
    assert.equal(log.bytes(), 0);
  });
});

describe('filters and labels', () => {
  const entries = [{ type: 'sdk' }, { type: 'notice' }, { type: 'sdk' }];

  it('filters by type, and keeps everything for the all-types choice', () => {
    assert.equal(filterEntries(entries, 'sdk').length, 2);
    assert.equal(filterEntries(entries, 'notice').length, 1);
    assert.equal(filterEntries(entries, 'all').length, 3);
  });

  it('lists each type once, in the order it first appears', () => {
    assert.deepEqual(distinctTypes([{ type: 'b' }, { type: 'a' }, { type: 'b' }]), ['b', 'a']);
  });

  it('formats byte counts in the largest sensible unit', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
  });
});
