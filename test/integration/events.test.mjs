/**
 * Integration tests: the Server-Sent Events stream. Covers the hello frame and headers, the scoping of session events,
 * replay with `after` and Last-Event-ID, resync for cursors the gateway cannot honour, the replay buffer limit and the
 * heartbeat. The heartbeat test drives the interval with the test runner's mocked clock; the other tests use real time.
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import { describe, it, before, after, mock } from 'node:test';
import {
  assertSecurityHeaders,
  client,
  createLive,
  eventNamed,
  PACKAGE_VERSION,
  runTurn,
  seqOf,
  startTestServer,
} from './helpers.mjs';

/** Frames that are protocol bookkeeping rather than events: they never take part in a replay comparison. */
const BOOKKEEPING = new Set(['hello', 'heartbeat', 'resync']);

/**
 * @param {Array<{id: string|undefined, event: string}>} frames
 * @returns {string[]} the ids of the replayable frames, in order
 */
function eventIds(frames) {
  return frames.filter((frame) => !BOOKKEEPING.has(frame.event)).map((frame) => frame.id);
}

describe('events: stream', { timeout: 120000 }, () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let server;
  /** @type {ReturnType<typeof client>} */
  let api;
  /** @type {string} */
  let bootId;
  before(async () => {
    server = await startTestServer();
    api = client(server.url);
    await api.login();
    bootId = (await api.get('/api/session')).json.bootId;
  });
  after(async () => {
    await server.close();
  });

  it('opens with a hello frame naming the boot, version and sequence, and the stream headers', async () => {
    const stream = await api.events();
    try {
      assert.equal(stream.status, 200);
      assert.equal(stream.headers['content-type'], 'text/event-stream; charset=utf-8');
      assert.equal(stream.headers['cache-control'], 'no-store');
      assert.equal(stream.headers['x-accel-buffering'], 'no');
      assertSecurityHeaders({ headers: stream.headers });
      const hello = await stream.next((frame) => frame.event === 'hello');
      assert.equal(stream.all()[0].event, 'hello', 'hello is the first event of every connection');
      assert.deepEqual(Object.keys(hello.data).sort(), ['bootId', 'seq', 'version']);
      assert.equal(hello.data.bootId, bootId);
      assert.equal(hello.data.version, PACKAGE_VERSION);
      assert.equal(typeof hello.data.seq, 'number');
      assert.equal(hello.id, `${bootId}:${hello.data.seq}`);
    } finally {
      stream.close();
    }
  });

  it('refuses the stream without a session, and a malformed watch or cursor with 400', async () => {
    await assert.rejects(client(server.url).events(), /refused with 401.*UNAUTHENTICATED/s);
    await assert.rejects(api.events({ watch: 'not-a-uuid' }), /refused with 400.*BAD_REQUEST/s);
    await assert.rejects(api.events({ after: -1 }), /refused with 400.*BAD_REQUEST/s);
    await assert.rejects(api.events({ after: 1.5 }), /refused with 400.*BAD_REQUEST/s);
  });

  it('delivers session events only to the client watching that session, and global events to everyone', async () => {
    const first = await createLive(api, { cwd: server.proj });
    const second = await createLive(api, { cwd: server.proj });
    const watchingFirst = await api.events({ watch: first.sessionId, after: 0 });
    const watchingSecond = await api.events({ watch: second.sessionId, after: 0 });
    const global = await api.events({ after: 0 });
    try {
      await runTurn(api, watchingFirst, first.sessionId, 'Scoped to the first session');
      await watchingFirst.next(eventNamed('message_accepted'));
      await global.next(eventNamed('message_accepted'));
      await watchingSecond.next(eventNamed('sessions_changed', { sessionId: second.sessionId }));

      const sdkFirst = watchingFirst.all().filter((frame) => frame.event === 'sdk');
      assert.ok(sdkFirst.length > 0);
      assert.ok(sdkFirst.every((frame) => frame.data.sessionId === first.sessionId));

      const sdkSecond = watchingSecond.all().filter((frame) => frame.event === 'sdk');
      assert.ok(sdkSecond.every((frame) => frame.data.sessionId === second.sessionId),
        'the second watcher sees only its own session');
      assert.equal(sdkSecond.filter((frame) => frame.data.msg?.type === 'result').length, 0);

      assert.equal(global.all().filter((frame) => frame.event === 'sdk').length, 0,
        'a client that watches nothing receives no SDK messages');
      assert.ok(global.all().some((frame) => frame.event === 'session_state'), 'session state is global');
      assert.ok(watchingSecond.all().some((frame) => frame.event === 'message_accepted'
        && frame.data.sessionId === first.sessionId), 'message acceptance is global');
    } finally {
      watchingFirst.close();
      watchingSecond.close();
      global.close();
    }
  });

  it('replays exactly the events after the cursor, in order, as the live stream delivered them', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const reference = await api.events({ watch: live.sessionId, after: 0 });
    try {
      await runTurn(api, reference, live.sessionId, 'Replay this turn');
      const expected = reference.all().filter((frame) => !BOOKKEEPING.has(frame.event));
      assert.ok(expected.length > 5, 'the turn produced events to replay');
      const cut = seqOf(expected[Math.floor(expected.length / 3)].id);
      const lastId = expected.at(-1).id;

      const replay = await api.events({ watch: live.sessionId, after: cut });
      try {
        // The hello frame carries the head id too, so the wait skips it and ends on the last replayed frame.
        await replay.next((frame) => frame.id === lastId && frame.event !== 'hello', 5000);
        const replayed = eventIds(replay.all());
        const wanted = expected.filter((frame) => seqOf(frame.id) > cut).map((frame) => frame.id);
        assert.deepEqual(replayed, wanted);
        assert.ok(replay.all().every((frame) => frame.event !== 'resync'), 'nothing was lost: no resync');
      } finally {
        replay.close();
      }
    } finally {
      reference.close();
    }
  });

  it('honours Last-Event-ID the same way as after, which is how a browser resumes a stream', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const reference = await api.events({ watch: live.sessionId, after: 0 });
    try {
      await runTurn(api, reference, live.sessionId, 'Resume this turn');
      const expected = reference.all().filter((frame) => !BOOKKEEPING.has(frame.event));
      const cut = seqOf(expected[1].id);
      const lastId = expected.at(-1).id;
      const resumed = await api.events({ watch: live.sessionId, lastEventId: `${bootId}:${cut}` });
      try {
        await resumed.next((frame) => frame.id === lastId && frame.event !== 'hello', 5000);
        assert.deepEqual(eventIds(resumed.all()), expected.filter((frame) => seqOf(frame.id) > cut)
          .map((frame) => frame.id));
      } finally {
        resumed.close();
      }
    } finally {
      reference.close();
    }
  });

  it('sends resync with a reason when the cursor belongs to another boot, is ahead, or is malformed', async () => {
    const cases = [
      { options: { lastEventId: `00000000-0000-4000-8000-000000000000:3` }, reason: 'boot' },
      { options: { lastEventId: `${bootId}:99999999` }, reason: 'boot' },
      { options: { after: 999999999 }, reason: 'boot' },
      { options: { lastEventId: 'not-a-cursor' }, reason: 'gap' },
      { options: { lastEventId: `${bootId}:-4` }, reason: 'gap' },
    ];
    for (const { options, reason } of cases) {
      const stream = await api.events(options);
      try {
        const resync = await stream.next((frame) => frame.event === 'resync');
        assert.equal(resync.data.reason, reason, JSON.stringify(options));
        assert.equal(stream.all()[1].event, 'resync', 'resync follows hello directly');
      } finally {
        stream.close();
      }
    }
  });

  it('delivers a notice to every client, even when it names a session', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const watching = await api.events({ watch: live.sessionId, after: 0 });
    const other = await api.events({ after: 0 });
    try {
      const mark = watching.count();
      server.events.publish({
        type: 'notice',
        sessionId: live.sessionId,
        data: { sessionId: live.sessionId, level: 'warning', code: 'TEST_NOTICE', message: 'Visible to all' },
      });
      const seen = await watching.next(eventNamed('notice', { code: 'TEST_NOTICE' }), 5000, { from: mark });
      const seenElsewhere = await other.next(eventNamed('notice', { code: 'TEST_NOTICE' }));
      assert.equal(seen.data.level, 'warning');
      assert.equal(seenElsewhere.id, seen.id);
    } finally {
      watching.close();
      other.close();
    }
  });
});

describe('events: replay buffer', { timeout: 120000 }, () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let server;
  /** @type {ReturnType<typeof client>} */
  let api;
  before(async () => {
    server = await startTestServer();
    api = client(server.url);
    await api.login();
    for (let index = 1; index <= 5005; index += 1) {
      server.events.publish({
        type: 'notice',
        data: { level: 'info', code: 'BULK', message: `bulk ${index}` },
      });
    }
  });
  after(async () => {
    await server.close();
  });

  it('keeps the newest 5000 events: an older cursor gets resync gap, a cursor at the edge replays everything after it',
    async () => {
      const older = await api.events({ after: 0 });
      try {
        const resync = await older.next((frame) => frame.event === 'resync');
        assert.equal(resync.data.reason, 'gap');
        assert.equal(older.all().filter((frame) => frame.event === 'notice').length, 0,
          'nothing older than the buffer is replayed');
      } finally {
        older.close();
      }

      const edge = await api.events({ after: 5 });
      try {
        const last = await edge.next((frame) => frame.event === 'notice' && frame.data.message === 'bulk 5005');
        assert.equal(seqOf(last.id), 5005);
        const notices = edge.all().filter((frame) => frame.event === 'notice');
        assert.equal(notices.length, 5000);
        assert.equal(seqOf(notices[0].id), 6);
        assert.equal(edge.all().some((frame) => frame.event === 'resync'), false,
          'the cursor is still inside the buffer');
      } finally {
        edge.close();
      }

      const tail = await api.events({ after: 5004 });
      try {
        const last = await tail.next((frame) => frame.event === 'notice');
        assert.equal(seqOf(last.id), 5005);
        assert.equal(tail.all().filter((frame) => frame.event === 'notice').length, 1);
      } finally {
        tail.close();
      }
    });
});

describe('events: heartbeat', { timeout: 60000 }, () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let server;
  /** @type {ReturnType<typeof client>} */
  let api;
  before(async () => {
    // The hub creates its interval when the server starts, so the mocked clock is enabled first.
    mock.timers.enable({ apis: ['setInterval'] });
    server = await startTestServer();
    api = client(server.url);
    await api.login();
  });
  after(async () => {
    await server.close();
    mock.timers.reset();
  });

  it('sends a heartbeat every 15 seconds, carrying the time, to every open stream', async () => {
    const stream = await api.events();
    try {
      await stream.next((frame) => frame.event === 'hello');
      mock.timers.tick(14999);
      await new Promise((resolve) => {
        setTimeout(resolve, 30);
      });
      assert.equal(stream.all().filter((frame) => frame.event === 'heartbeat').length, 0,
        'no heartbeat before 15 seconds');
      mock.timers.tick(1);
      const first = await stream.next((frame) => frame.event === 'heartbeat', 5000);
      assert.equal(typeof first.data.t, 'number');
      assert.equal(Object.keys(first.data).join(), 't');
      mock.timers.tick(15000);
      const second = await stream.next((frame) => frame.event === 'heartbeat', 5000, {
        from: stream.all().indexOf(first) + 1,
      });
      assert.equal(stream.all().filter((frame) => frame.event === 'heartbeat').length, 2);
      assert.equal(typeof second.data.t, 'number');
    } finally {
      stream.close();
    }
  });
});

describe('events: slow clients', { timeout: 120000 }, () => {
  it('disconnects a client that stops reading once more than 1 MiB is queued for it', async () => {
    const server = await startTestServer();
    const api = client(server.url);
    await api.login();
    const target = new URL(server.url);
    const socket = net.connect({ host: target.hostname, port: Number(target.port) });
    let received = 0;
    let closed = false;
    const finished = new Promise((resolve) => {
      socket.on('close', () => {
        closed = true;
        resolve();
      });
    });
    socket.on('error', () => {});
    socket.pause();
    socket.write(`GET /api/events HTTP/1.1\r\nHost: ${target.host}\r\nCookie: ${api.cookie}\r\n`
      + 'Accept: text/event-stream\r\n\r\n');
    try {
      // Let the gateway register the stream before the events are published.
      await new Promise((resolve) => {
        setTimeout(resolve, 200);
      });
      const count = 5000;
      const size = 8192;
      for (let index = 0; index < count; index += 1) {
        server.events.publish({ type: 'notice', data: { level: 'info', code: 'BULK', message: 'x'.repeat(size) } });
      }
      // Reading starts only now: until then the gateway had to queue everything it could not write.
      socket.on('data', (chunk) => {
        received += chunk.length;
      });
      socket.resume();
      /** @type {ReturnType<typeof setTimeout>|undefined} */
      let timer;
      const limit = new Promise((resolve) => {
        timer = setTimeout(resolve, 10000);
      });
      await Promise.race([finished, limit]);
      clearTimeout(timer);
      assert.equal(closed, true, 'the gateway ended the stream of the client that fell behind');
      assert.ok(received < count * size, `the client received ${received} of ${count * size} bytes`);
    } finally {
      socket.destroy();
      await server.close();
    }
  });
});
