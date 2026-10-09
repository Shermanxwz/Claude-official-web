// @ts-check
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { EventHub } from '../../src/events.mjs';

const BOOT = 'boot-1';
const LOGGER = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const WATCH_A = '6f1c2a4e-1111-4a6b-8c9d-0123456789ab';
const WATCH_B = '6f1c2a4e-2222-4a6b-8c9d-0123456789ab';

/**
 * In-memory stand-in for ServerResponse. `writeResult` controls what write() reports, which is how tests model a
 * client whose socket buffer is full.
 */
class FakeResponse extends EventEmitter {
  /** @type {number|undefined} */
  statusCode;
  /** @type {Record<string, unknown>|undefined} */
  headers;
  /** @type {string[]} */
  chunks = [];
  writeResult = true;
  destroyed = false;
  writableEnded = false;
  socket = null;

  /**
   * @param {number} status
   * @param {Record<string, unknown>} headers
   */
  writeHead(status, headers) {
    this.statusCode = status;
    this.headers = headers;
    return this;
  }

  /** @param {string|Buffer} chunk */
  write(chunk) {
    this.chunks.push(String(chunk));
    return this.writeResult;
  }

  /** @param {string} [chunk] */
  end(chunk) {
    if (chunk) this.chunks.push(String(chunk));
    this.writableEnded = true;
  }

  destroy() {
    this.destroyed = true;
    this.emit('close');
  }

  /** Simulates the browser going away. */
  disconnect() {
    this.emit('close');
  }

  /** @returns {string} everything written so far */
  get body() {
    return this.chunks.join('');
  }

  /**
   * @returns {Array<{id?: string, event?: string, data?: string}>} parsed SSE frames (comments are skipped)
   */
  get frames() {
    return this.body.split('\n\n').filter((block) => block.trim() !== '' && !block.startsWith(':')).map((block) => {
      /** @type {{id?: string, event?: string, data?: string}} */
      const frame = {};
      for (const line of block.split('\n')) {
        const index = line.indexOf(': ');
        const key = line.slice(0, index);
        const value = line.slice(index + 2);
        if (key === 'id') frame.id = value;
        if (key === 'event') frame.event = value;
        if (key === 'data') frame.data = value;
      }
      return frame;
    });
  }
}

/**
 * @param {Partial<ConstructorParameters<typeof EventHub>[0]>} [options]
 */
function hub(options = {}) {
  return new EventHub({ bootId: BOOT, version: '1.2.3', log: LOGGER, heartbeatMs: 60000, ...options });
}

/**
 * @param {EventHub} events
 * @param {Parameters<EventHub['attach']>[2]} [options]
 */
function connect(events, options = {}) {
  const res = new FakeResponse();
  events.attach(/** @type {any} */ ({}), /** @type {any} */ (res), { clientAddress: '198.51.100.1', ...options });
  return res;
}

/** @param {number} ms */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('EventHub.publish', () => {
  it('sequences events from 1 and reports the last sequence', () => {
    const events = hub();
    assert.equal(events.lastSeq, 0);
    assert.equal(events.publish({ type: 'sessions_changed', data: { reason: 'a' } }), 1);
    assert.equal(events.publish({ type: 'notice', data: { level: 'info' } }), 2);
    assert.equal(events.lastSeq, 2);
    events.close();
  });

  it('rejects unknown types, hub-owned control frames, scoped events without a session and bad data', () => {
    const events = hub();
    assert.throws(() => events.publish({ type: 'nope', data: {} }), TypeError);
    for (const type of ['hello', 'heartbeat', 'resync']) {
      assert.throws(() => events.publish({ type, data: {} }), TypeError, type);
    }
    assert.throws(() => events.publish({ type: 'sdk', data: {} }), TypeError);
    for (const data of [null, [], 'text', 3]) {
      assert.throws(() => events.publish({ type: 'notice', data: /** @type {any} */ (data) }), TypeError);
    }
    assert.equal(events.lastSeq, 0);
    events.close();
  });

  it('validates constructor arguments', () => {
    assert.throws(() => hub({ bufferSize: 0 }), TypeError);
    assert.throws(() => hub({ clientMaxBytes: 0 }), TypeError);
  });
});

describe('EventHub.attach', () => {
  it('opens an event stream with the required headers and the caller security headers', () => {
    const events = hub();
    const res = connect(events, { headers: { 'X-Frame-Options': 'DENY' } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers?.['Content-Type'], 'text/event-stream; charset=utf-8');
    assert.equal(res.headers?.['Cache-Control'], 'no-store');
    assert.equal(res.headers?.Connection, 'keep-alive');
    assert.equal(res.headers?.['X-Accel-Buffering'], 'no');
    assert.equal(res.headers?.['X-Frame-Options'], 'DENY');
    events.close();
  });

  it('starts with a comment and the hello frame carrying bootId, version and seq', () => {
    const events = hub();
    events.publish({ type: 'notice', data: { level: 'info' } });
    const res = connect(events);
    assert.ok(res.body.startsWith(':ok\n\nid: boot-1:1\nevent: hello\n'
      + 'data: {"bootId":"boot-1","version":"1.2.3","seq":1}\n\n'));
    assert.equal(events.clientCount, 1);
    res.disconnect();
    assert.equal(events.clientCount, 0);
    events.close();
  });

  it('formats event frames with the boot-scoped id, the event type and JSON data', () => {
    const events = hub();
    const res = connect(events);
    events.publish({ type: 'sessions_changed', data: { reason: 'created', sessionId: WATCH_A } });
    const [hello, event] = res.frames;
    assert.equal(hello.event, 'hello');
    assert.deepEqual(event, {
      id: 'boot-1:1',
      event: 'sessions_changed',
      data: JSON.stringify({ reason: 'created', sessionId: WATCH_A }),
    });
    assert.ok(res.body.endsWith(`id: boot-1:1\nevent: sessions_changed\ndata: ${JSON.stringify({
      reason: 'created', sessionId: WATCH_A,
    })}\n\n`));
    events.close();
  });

  it('answers 503 once the hub is closed', () => {
    const events = hub();
    events.close();
    const res = connect(events);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body, 'The server is shutting down');
  });
});

describe('EventHub stream limits', () => {
  it('refuses the 65th stream with 429 TOO_MANY_STREAMS before any header or frame is written', () => {
    const events = hub();
    for (let index = 0; index < 64; index += 1) connect(events, { clientAddress: `10.0.0.${index + 1}` });
    assert.equal(events.clientCount, 64);
    const refused = new FakeResponse();
    assert.throws(() => events.attach({}, /** @type {any} */ (refused), { clientAddress: '10.0.1.1' }),
      (error) => error.status === 429 && error.code === 'TOO_MANY_STREAMS');
    assert.equal(refused.statusCode, undefined, 'no status line was written');
    assert.deepEqual(refused.chunks, []);
    assert.equal(events.clientCount, 64);
    events.close();
  });

  it('allows 16 streams per client address and refuses the 17th from that address only', () => {
    const events = hub();
    for (let index = 0; index < 16; index += 1) connect(events, { clientAddress: '203.0.113.7' });
    assert.throws(() => connect(events, { clientAddress: '203.0.113.7' }),
      (error) => error.status === 429 && error.code === 'TOO_MANY_STREAMS');
    assert.doesNotThrow(() => connect(events, { clientAddress: '203.0.113.8' }));
    assert.equal(events.clientCount, 17);
    events.close();
  });

  it('frees capacity when a stream closes, once per stream, for both limits', () => {
    const events = hub();
    const streams = Array.from({ length: 16 }, () => connect(events, { clientAddress: '203.0.113.7' }));
    assert.throws(() => connect(events, { clientAddress: '203.0.113.7' }), /TOO_MANY_STREAMS|Too many/);
    streams[0].disconnect();
    streams[0].disconnect();
    assert.equal(events.clientCount, 15);
    assert.doesNotThrow(() => connect(events, { clientAddress: '203.0.113.7' }));
    assert.throws(() => connect(events, { clientAddress: '203.0.113.7' }));
    events.close();
  });

  it('applies the configured limits and rejects invalid ones', () => {
    const small = hub({ maxStreams: 1, maxStreamsPerClient: 1 });
    connect(small, { clientAddress: '10.1.1.1' });
    assert.throws(() => connect(small, { clientAddress: '10.1.1.2' }), (error) => error.status === 429);
    small.close();
    assert.throws(() => hub({ maxStreams: 0 }), TypeError);
    assert.throws(() => hub({ maxStreamsPerClient: 1.5 }), TypeError);
  });
});

describe('EventHub delivery scope', () => {
  it('delivers global events to every client', () => {
    const events = hub();
    const a = connect(events, { watch: WATCH_A });
    const b = connect(events);
    events.publish({ type: 'request_resolved', data: { sessionId: WATCH_B, requestId: 'r', outcome: 'allowed' } });
    assert.equal(a.frames.filter((f) => f.event === 'request_resolved').length, 1);
    assert.equal(b.frames.filter((f) => f.event === 'request_resolved').length, 1);
    events.close();
  });

  it('delivers sdk events only to clients watching their session', () => {
    const events = hub();
    const watching = connect(events, { watch: WATCH_A });
    const other = connect(events, { watch: WATCH_B });
    const anonymous = connect(events);
    events.publish({ type: 'sdk', sessionId: WATCH_A, data: { sessionId: WATCH_A, msg: { type: 'result' } } });
    assert.equal(watching.frames.filter((f) => f.event === 'sdk').length, 1);
    assert.equal(other.frames.filter((f) => f.event === 'sdk').length, 0);
    assert.equal(anonymous.frames.filter((f) => f.event === 'sdk').length, 0);
    events.close();
  });

  it('removes clients whose response emits an error', () => {
    const events = hub();
    const res = connect(events);
    res.emit('error', new Error('socket reset'));
    assert.equal(events.clientCount, 0);
    events.close();
  });
});

describe('EventHub replay and resync', () => {
  /** @param {EventHub} events @param {number} count */
  function publishNotices(events, count) {
    for (let index = 0; index < count; index += 1) {
      events.publish({ type: 'notice', data: { level: 'info', code: `n${index + 1}`, message: 'm' } });
    }
  }

  it('replays buffered events after the numeric cursor', () => {
    const events = hub();
    publishNotices(events, 5);
    const res = connect(events, { after: 2 });
    const replayed = res.frames.filter((f) => f.event === 'notice').map((f) => f.id);
    assert.deepEqual(replayed, ['boot-1:3', 'boot-1:4', 'boot-1:5']);
    assert.equal(res.frames.some((f) => f.event === 'resync'), false);
    events.close();
  });

  it('prefers Last-Event-ID over the after parameter and replays only the newer events', () => {
    const events = hub();
    publishNotices(events, 5);
    const res = connect(events, { after: 0, lastEventId: 'boot-1:4' });
    assert.deepEqual(res.frames.filter((f) => f.event === 'notice').map((f) => f.id), ['boot-1:5']);
    events.close();
  });

  it('sends no replay and no resync without a cursor', () => {
    const events = hub();
    publishNotices(events, 3);
    const res = connect(events);
    assert.deepEqual(res.frames.map((f) => f.event), ['hello']);
    events.close();
  });

  it('sends resync boot when the cursor belongs to another boot', () => {
    const events = hub();
    publishNotices(events, 3);
    const res = connect(events, { lastEventId: 'other-boot:2' });
    assert.deepEqual(res.frames.map((f) => f.event), ['hello', 'resync']);
    assert.equal(res.frames[1].data, JSON.stringify({ reason: 'boot' }));
    events.close();
  });

  it('sends resync boot when the cursor is ahead of this process', () => {
    const events = hub();
    publishNotices(events, 5);
    assert.equal(connect(events, { after: 99 }).frames[1].data, JSON.stringify({ reason: 'boot' }));
    events.close();
  });

  it('sends resync gap when events after the cursor were evicted from the buffer', () => {
    const events = hub({ bufferSize: 3 });
    publishNotices(events, 5);
    const gap = connect(events, { after: 0 });
    assert.deepEqual(gap.frames.map((f) => f.event), ['hello', 'resync']);
    assert.equal(gap.frames[1].data, JSON.stringify({ reason: 'gap' }));

    const edge = connect(events, { after: 2 });
    assert.deepEqual(edge.frames.filter((f) => f.event === 'notice').map((f) => f.id),
      ['boot-1:3', 'boot-1:4', 'boot-1:5']);
    events.close();
  });

  it('treats malformed cursors as a gap', () => {
    const events = hub();
    publishNotices(events, 2);
    assert.equal(connect(events, { lastEventId: 'garbage' }).frames[1].data, JSON.stringify({ reason: 'gap' }));
    assert.equal(connect(events, { after: -1 }).frames[1].data, JSON.stringify({ reason: 'gap' }));
    assert.equal(connect(events, { after: 1.5 }).frames[1].data, JSON.stringify({ reason: 'gap' }));
    events.close();
  });

  it('wraps the ring buffer correctly after many events', () => {
    const events = hub({ bufferSize: 3 });
    publishNotices(events, 10);
    const res = connect(events, { after: 7 });
    assert.deepEqual(res.frames.filter((f) => f.event === 'notice').map((f) => f.id),
      ['boot-1:8', 'boot-1:9', 'boot-1:10']);
    events.close();
  });

  it('replays only the events the client is allowed to see', () => {
    const events = hub();
    events.publish({ type: 'sdk', sessionId: WATCH_B, data: { sessionId: WATCH_B, msg: { n: 1 } } });
    events.publish({ type: 'notice', data: { level: 'info', code: 'g', message: 'm' } });
    events.publish({ type: 'sdk', sessionId: WATCH_A, data: { sessionId: WATCH_A, msg: { n: 2 } } });
    const res = connect(events, { after: 0, watch: WATCH_A });
    assert.deepEqual(res.frames.filter((f) => f.event !== 'hello').map((f) => f.event), ['notice', 'sdk']);
    events.close();
  });
});

describe('EventHub heartbeat', () => {
  it('sends heartbeats carrying the current sequence id without advancing the sequence', async () => {
    const events = hub({ heartbeatMs: 10 });
    events.publish({ type: 'notice', data: { level: 'info', code: 'x', message: 'y' } });
    const res = connect(events);
    await wait(60);
    const beats = res.frames.filter((f) => f.event === 'heartbeat');
    assert.ok(beats.length >= 2, `expected several heartbeats, saw ${beats.length}`);
    assert.equal(beats[0].id, 'boot-1:1');
    assert.equal(typeof JSON.parse(String(beats[0].data)).t, 'number');
    assert.equal(events.lastSeq, 1);
    events.close();
  });

  it('stops heartbeats when the hub closes', async () => {
    const events = hub({ heartbeatMs: 5 });
    const res = connect(events);
    events.close();
    const before = res.chunks.length;
    await wait(30);
    assert.equal(res.chunks.length, before);
  });
});

describe('EventHub backpressure', () => {
  it('disconnects a client whose blocked buffer grows beyond clientMaxBytes', () => {
    const events = hub({ clientMaxBytes: 200 });
    const res = connect(events);
    res.writeResult = false;
    events.publish({ type: 'notice', data: { level: 'info', code: 'a', message: 'x'.repeat(60) } });
    assert.equal(res.destroyed, false);
    for (let index = 0; index < 4 && !res.destroyed; index += 1) {
      events.publish({ type: 'notice', data: { level: 'info', code: 'b', message: 'y'.repeat(60) } });
    }
    assert.equal(res.destroyed, true);
    assert.equal(events.clientCount, 0);
    events.close();
  });

  it('resets the byte count on drain so a client that catches up is kept', () => {
    const events = hub({ clientMaxBytes: 200 });
    const res = connect(events);
    res.writeResult = false;
    events.publish({ type: 'notice', data: { level: 'info', code: 'a', message: 'x'.repeat(60) } });
    res.emit('drain');
    res.writeResult = true;
    for (let index = 0; index < 10; index += 1) {
      events.publish({ type: 'notice', data: { level: 'info', code: 'b', message: 'y'.repeat(60) } });
    }
    assert.equal(res.destroyed, false);
    assert.equal(events.clientCount, 1);
    events.close();
  });
});

describe('EventHub.close', () => {
  it('ends every stream, forgets the clients and keeps accepting publishes', () => {
    const events = hub();
    const a = connect(events);
    const b = connect(events, { watch: WATCH_A });
    events.close();
    assert.equal(a.writableEnded, true);
    assert.equal(b.writableEnded, true);
    assert.equal(events.clientCount, 0);
    assert.equal(events.publish({ type: 'notice', data: { level: 'info', code: 'late', message: 'm' } }), 1);
  });
});
