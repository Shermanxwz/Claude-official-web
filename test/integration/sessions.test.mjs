/**
 * Integration tests: the session lifecycle over HTTP (create, open, close, delete), the message queue and its duplicate
 * rule, transcript paging, listing, rename, tag and fork, and the live-session limit. Every test talks to a real
 * gateway with the deterministic mock engine.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it, before, after } from 'node:test';
import {
  assertError,
  CLAUDE_CODE_VERSION,
  client,
  createLive,
  eventNamed,
  isUuid,
  openEvents,
  runTurn,
  sdkMessagesOf,
  seqOf,
  startTestServer,
  turnResult,
} from './helpers.mjs';

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

/**
 * Polls GET /api/sessions/:id until the live query reports the wanted state.
 * @param {ReturnType<typeof client>} api
 * @param {string} sessionId
 * @param {string} state
 */
async function waitForState(api, sessionId, state) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const res = await api.get(`/api/sessions/${sessionId}`);
    if (res.json.live?.state === state) return res.json.live;
    if (Date.now() > deadline) assert.fail(`session ${sessionId} did not reach ${state}: ${res.text}`);
    await sleep(10);
  }
}

describe('sessions: lifecycle', { timeout: 120000 }, () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let server;
  /** @type {ReturnType<typeof client>} */
  let api;
  before(async () => {
    server = await startTestServer();
    api = client(server.url);
    await api.login();
  });
  after(async () => {
    await server.close();
  });

  it('creates a live session with a gateway-assigned UUID and the documented LiveInfo', async () => {
    const res = await api.post('/api/sessions', { cwd: server.proj, title: 'Integration run' });
    assert.equal(res.status, 200);
    const live = res.json.live;
    assert.deepEqual(Object.keys(live).sort(), ['backgroundTasks', 'claudeCodeVersion', 'cwd', 'effort', 'error',
      'fastMode', 'fastModeDisabledReason', 'fastModeState', 'lastActivity', 'lockedBy', 'model', 'pendingCount',
      'permissionMode', 'sessionId', 'state', 'title', 'trusted']);
    assert.equal(live.backgroundTasks, 0);
    assert.equal(live.fastMode, null, 'the settings files decide until the host requests fast mode');
    assert.ok(isUuid(live.sessionId));
    assert.equal(live.cwd, server.proj);
    assert.ok(['starting', 'idle'].includes(live.state), live.state);
    assert.equal(live.permissionMode, 'default');
    assert.equal(live.title, 'Integration run');
    assert.equal(live.lockedBy, null);
    assert.equal(live.pendingCount, 0);
    assert.equal(live.error, null);
  });

  it('announces a new session on the global stream with sessions_changed and session_state', async () => {
    const events = await api.events({ after: 0 });
    try {
      const live = await createLive(api, { cwd: server.proj });
      const changed = await events.next((frame) => frame.event === 'sessions_changed'
        && frame.data.sessionId === live.sessionId);
      assert.equal(changed.data.reason, 'created');
      const state = await events.next((frame) => frame.event === 'session_state'
        && frame.data.live?.sessionId === live.sessionId);
      assert.equal(state.data.live.cwd, server.proj);
    } finally {
      events.close();
    }
  });

  it('streams the turn of one message to the watching client and ends it with a successful result', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const sessionId = live.sessionId;
    const events = await api.events({ watch: sessionId, after: 0 });
    try {
      const turn = await runTurn(api, events, sessionId, 'Summarise the project');
      assert.deepEqual(turn.accepted, { accepted: true, duplicate: false });
      const messages = sdkMessagesOf(events, sessionId);
      assert.equal(messages[0].type, 'system');
      assert.equal(messages[0].subtype, 'init');
      assert.equal(messages[0].claude_code_version, CLAUDE_CODE_VERSION);
      assert.ok(messages.some((msg) => msg.type === 'stream_event'), 'the answer streams as partial messages');
      assert.ok(messages.some((msg) => msg.type === 'assistant'), 'the answer ends as an assistant message');
      const result = turn.result;
      assert.equal(result.type, 'result');
      assert.equal(result.subtype, 'success');
      assert.equal(result.is_error, false);
      assert.equal(result.user_message_uuid, turn.clientMessageId);
      assert.ok(messages.indexOf(result) > messages.indexOf(messages.find((msg) => msg.type === 'assistant')),
        'the result closes the turn after its answer');
      const seqs = events.all().filter((frame) => frame.event === 'sdk').map((frame) => seqOf(frame.id));
      for (let index = 1; index < seqs.length; index += 1) {
        assert.ok(seqs[index] > seqs[index - 1], 'sequence numbers only grow');
      }
      const accepted = await events.next(eventNamed('message_accepted', { clientMessageId: turn.clientMessageId }));
      assert.equal(accepted.data.sessionId, sessionId);
    } finally {
      events.close();
    }
  });

  it('accepts a repeated clientMessageId without sending it to the engine again', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const sessionId = live.sessionId;
    const events = await api.events({ watch: sessionId, after: 0 });
    try {
      const first = await runTurn(api, events, sessionId, 'First message');
      const repeat = await api.post(`/api/sessions/${sessionId}/messages`, {
        clientMessageId: first.clientMessageId,
        text: 'First message',
      });
      assert.equal(repeat.status, 200);
      assert.deepEqual(repeat.json, { accepted: true, duplicate: true });
      const second = await runTurn(api, events, sessionId, 'Second message');
      assert.equal(second.accepted.duplicate, false);
      const transcript = await api.get(`/api/sessions/${sessionId}/messages?tail=1000`);
      const copies = transcript.json.messages.filter((message) => message.type === 'user'
        && message.uuid === first.clientMessageId);
      assert.equal(copies.length, 1, 'the repeated message is stored once');
      const results = sdkMessagesOf(events, sessionId).filter((msg) => msg.type === 'result');
      assert.equal(results.length, 2, 'one turn per distinct message');
    } finally {
      events.close();
    }
  });

  it('refuses a message that has no UUID, or no text and no attachments, with 400 BAD_REQUEST', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const pathname = `/api/sessions/${live.sessionId}/messages`;
    assertError(await api.post(pathname, { clientMessageId: 'not-a-uuid', text: 'hi' }), 400, 'BAD_REQUEST');
    assertError(await api.post(pathname, { clientMessageId: randomUUID(), text: '   ' }), 400, 'BAD_REQUEST');
    assertError(await api.post(pathname, { clientMessageId: randomUUID() }), 400, 'BAD_REQUEST');
  });

  it('does not reserve the clientMessageId of a message that was refused', async () => {
    const clientMessageId = randomUUID();
    assertError(await api.post(`/api/sessions/${randomUUID()}/messages`, { clientMessageId, text: 'hi' }),
      404, 'SESSION_NOT_FOUND');
    const live = await createLive(api, { cwd: server.proj });
    const res = await api.post(`/api/sessions/${live.sessionId}/messages`, { clientMessageId, text: 'hi' });
    assert.deepEqual(res.json, { accepted: true, duplicate: false });
  });

  it('lists the sessions of a folder newest first, including live sessions that have no file yet', async () => {
    const first = await createLive(api, { cwd: server.proj, title: 'Listed first' });
    await sleep(5);
    const second = await createLive(api, { cwd: server.proj, title: 'Listed second' });
    const res = await api.get(`/api/sessions?cwd=${encodeURIComponent(server.proj)}&limit=100`);
    assert.equal(res.status, 200);
    const ids = res.json.sessions.map((session) => session.sessionId);
    assert.ok(ids.includes(first.sessionId) && ids.includes(second.sessionId));
    for (let index = 1; index < res.json.sessions.length; index += 1) {
      assert.ok(res.json.sessions[index - 1].lastModified >= res.json.sessions[index].lastModified,
        'sorted by lastModified, newest first');
    }
    const summary = res.json.sessions.find((session) => session.sessionId === second.sessionId);
    assert.equal(summary.live.sessionId, second.sessionId);
    const page = await api.get(`/api/sessions?cwd=${encodeURIComponent(server.proj)}&limit=1`);
    assert.equal(page.json.sessions.length, 1);
    assertError(await api.get('/api/sessions?limit=0'), 400, 'BAD_REQUEST');
  });

  it('reports the snapshot of a session: info, live state, pending requests, live events and init', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const sessionId = live.sessionId;
    const events = await api.events({ watch: sessionId, after: 0 });
    try {
      await runTurn(api, events, sessionId, 'Snapshot please');
      const snapshot = (await api.get(`/api/sessions/${sessionId}`)).json;
      assert.deepEqual(Object.keys(snapshot).sort(), ['info', 'init', 'live', 'liveEvents', 'pending', 'seq']);
      assert.equal(snapshot.info.sessionId, sessionId);
      assert.equal(snapshot.info.cwd, server.proj);
      assert.equal(snapshot.live.sessionId, sessionId);
      assert.deepEqual(snapshot.pending, []);
      assert.equal(snapshot.init.type, 'system');
      assert.equal(snapshot.init.subtype, 'init');
      assert.ok(snapshot.liveEvents.length > 0);
      for (const item of snapshot.liveEvents) {
        assert.equal(typeof item.seq, 'number');
        assert.equal(typeof item.msg.type, 'string');
      }
      assert.ok(snapshot.seq >= snapshot.liveEvents.at(-1).seq);
    } finally {
      events.close();
    }
  });

  it('pages the transcript with tail, before and limit, and reports the indexes', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const sessionId = live.sessionId;
    const events = await api.events({ watch: sessionId, after: 0 });
    try {
      for (const text of ['Page one', 'Page two', 'Page three']) await runTurn(api, events, sessionId, text);
      const all = (await api.get(`/api/sessions/${sessionId}/messages?tail=1000`)).json;
      const total = all.total;
      assert.ok(total >= 6, `three turns leave at least six messages, got ${total}`);
      assert.equal(all.messages.length, total);
      assert.equal(all.start, 0);
      assert.equal(all.hasMore, false);
      assert.deepEqual(all.messages.map((message) => message.index), Array.from({ length: total }, (_, i) => i));

      const tail = (await api.get(`/api/sessions/${sessionId}/messages?tail=2`)).json;
      assert.equal(tail.total, total);
      assert.equal(tail.start, total - 2);
      assert.equal(tail.hasMore, true);
      assert.deepEqual(tail.messages.map((message) => message.index), [total - 2, total - 1]);

      const before = (await api.get(`/api/sessions/${sessionId}/messages?before=5&limit=2`)).json;
      assert.equal(before.start, 3);
      assert.deepEqual(before.messages.map((message) => message.index), [3, 4]);
      assert.equal(before.hasMore, true);

      const head = (await api.get(`/api/sessions/${sessionId}/messages?before=2&limit=50`)).json;
      assert.equal(head.start, 0);
      assert.deepEqual(head.messages.map((message) => message.index), [0, 1]);
      assert.equal(head.hasMore, false);

      assertError(await api.get(`/api/sessions/${sessionId}/messages?tail=0`), 400, 'BAD_REQUEST');
      assertError(await api.get(`/api/sessions/${sessionId}/messages?tail=2&before=3`), 400, 'BAD_REQUEST');
      assertError(await api.get(`/api/sessions/${sessionId}/messages?limit=5`), 400, 'BAD_REQUEST');
    } finally {
      events.close();
    }
  });

  it('answers 400 for a malformed session id and 404 for a session that does not exist', async () => {
    const unknown = randomUUID();
    assertError(await api.get('/api/sessions/not-a-uuid'), 400, 'BAD_REQUEST');
    assertError(await api.get(`/api/sessions/${unknown}`), 404, 'SESSION_NOT_FOUND');
    assertError(await api.get(`/api/sessions/${unknown}/messages`), 404, 'SESSION_NOT_FOUND');
    assertError(await api.post(`/api/sessions/${unknown}/open`, {}), 404, 'SESSION_NOT_FOUND');
    assertError(await api.post(`/api/sessions/${unknown}/fork`, {}), 404, 'SESSION_NOT_FOUND');
    assertError(await api.patch(`/api/sessions/${unknown}`, { title: 'x' }), 404, 'SESSION_NOT_FOUND');
    assertError(await api.post('/api/sessions/not-a-uuid/messages', { clientMessageId: randomUUID(), text: 'x' }),
      400, 'BAD_REQUEST');
  });

  it('refuses to create a session outside the workspace roots or in a file, with 422 PATH_NOT_ALLOWED', async () => {
    assertError(await api.post('/api/sessions', { cwd: server.outside }), 422, 'PATH_NOT_ALLOWED');
    assertError(await api.post('/api/sessions', { cwd: `${server.proj}/src/app.js` }), 422, 'PATH_NOT_ALLOWED');
    assertError(await api.post('/api/sessions', {}), 400, 'BAD_REQUEST');
  });

  it('renames and tags a session, clears the tag with null and validates the body', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const sessionId = live.sessionId;
    const events = await api.events({ watch: sessionId, after: 0 });
    try {
      await runTurn(api, events, sessionId, 'Name me');
      assert.deepEqual((await api.patch(`/api/sessions/${sessionId}`, { title: 'Renamed run' })).json, { ok: true });
      const renamed = (await api.get(`/api/sessions/${sessionId}`)).json;
      assert.equal(renamed.info.customTitle, 'Renamed run');
      assert.equal(renamed.live.title, 'Renamed run');
      assert.equal((await api.patch(`/api/sessions/${sessionId}`, { tag: 'wip' })).status, 200);
      assert.equal((await api.get(`/api/sessions/${sessionId}`)).json.info.tag, 'wip');
      assert.equal((await api.patch(`/api/sessions/${sessionId}`, { tag: null })).status, 200);
      assert.equal((await api.get(`/api/sessions/${sessionId}`)).json.info.tag, undefined);
      assertError(await api.patch(`/api/sessions/${sessionId}`, {}), 400, 'BAD_REQUEST');
      assertError(await api.patch(`/api/sessions/${sessionId}`, { title: '' }), 400, 'BAD_REQUEST');
      assertError(await api.patch(`/api/sessions/${sessionId}`, { title: 42 }), 400, 'BAD_REQUEST');
    } finally {
      events.close();
    }
  });

  it('forks a session up to a message, and leaves the source session as it was', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const sessionId = live.sessionId;
    const events = await api.events({ watch: sessionId, after: 0 });
    try {
      const first = await runTurn(api, events, sessionId, 'Fork after this');
      await runTurn(api, events, sessionId, 'Not in the fork');
      const sourceBefore = (await api.get(`/api/sessions/${sessionId}/messages?tail=1000`)).json;
      const fork = await api.post(`/api/sessions/${sessionId}/fork`, {
        upToMessageId: first.clientMessageId,
        title: 'Forked here',
      });
      assert.equal(fork.status, 200);
      const forkId = fork.json.sessionId;
      assert.ok(isUuid(forkId));
      assert.notEqual(forkId, sessionId);
      const copy = (await api.get(`/api/sessions/${forkId}/messages?tail=1000`)).json;
      assert.deepEqual(copy.messages.filter((message) => message.type === 'user').map((message) => message.uuid),
        [first.clientMessageId]);
      const forkDetail = (await api.get(`/api/sessions/${forkId}`)).json;
      assert.equal(forkDetail.info.customTitle, 'Forked here');
      assert.equal(forkDetail.info.cwd, server.proj);
      assert.equal(forkDetail.live, null, 'a fork starts closed');
      const sourceAfter = (await api.get(`/api/sessions/${sessionId}/messages?tail=1000`)).json;
      assert.equal(sourceAfter.total, sourceBefore.total);
    } finally {
      events.close();
    }
  });

  it('closes a live session, announces it, and reopens it so that it takes a new message', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const sessionId = live.sessionId;
    const events = await api.events({ watch: sessionId, after: 0 });
    try {
      await runTurn(api, events, sessionId, 'Before the close');
      assert.deepEqual((await api.post(`/api/sessions/${sessionId}/close`)).json, { ok: true });
      const announced = await events.next((frame) => frame.event === 'session_state'
        && frame.data.sessionId === sessionId && frame.data.live === null);
      assert.equal(announced.data.live, null);
      assert.equal((await api.get(`/api/sessions/${sessionId}`)).json.live, null);
      const reopened = await api.post(`/api/sessions/${sessionId}/open`, {});
      assert.equal(reopened.status, 200);
      assert.equal(reopened.json.live.sessionId, sessionId);
      const turn = await runTurn(api, events, sessionId, 'After the reopen');
      assert.equal(turn.result.subtype, 'success');
      await api.post(`/api/sessions/${sessionId}/close`);
      // A message sent to a closed session opens it first.
      const direct = await runTurn(api, events, sessionId, 'Sent to a closed session');
      assert.equal(direct.result.subtype, 'success');
      assert.equal((await api.get(`/api/sessions/${sessionId}`)).json.live.sessionId, sessionId);
    } finally {
      events.close();
    }
  });

  it('deletes a closed session, and answers 409 CONFLICT while the session is live', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const sessionId = live.sessionId;
    const events = await api.events({ watch: sessionId, after: 0 });
    try {
      await runTurn(api, events, sessionId, 'Delete me later');
      assertError(await api.del(`/api/sessions/${sessionId}`), 409, 'CONFLICT');
      await api.post(`/api/sessions/${sessionId}/close`);
      assert.deepEqual((await api.del(`/api/sessions/${sessionId}`)).json, { ok: true });
      assertError(await api.get(`/api/sessions/${sessionId}`), 404, 'SESSION_NOT_FOUND');
      assertError(await api.del(`/api/sessions/${sessionId}`), 404, 'SESSION_NOT_FOUND');
    } finally {
      events.close();
    }
  });

  it('answers 409 SESSION_NOT_LIVE for the actions that need a live query', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const sessionId = live.sessionId;
    const events = await api.events({ watch: sessionId, after: 0 });
    try {
      await runTurn(api, events, sessionId, 'Then close');
      await api.post(`/api/sessions/${sessionId}/close`);
      assertError(await api.get(`/api/sessions/${sessionId}/context`), 409, 'SESSION_NOT_LIVE');
      assertError(await api.post(`/api/sessions/${sessionId}/reload`, { what: 'plugins' }), 409, 'SESSION_NOT_LIVE');
      assertError(await api.post(`/api/sessions/${sessionId}/mcp`, { server: 'github', action: 'reconnect' }),
        409, 'SESSION_NOT_LIVE');
      assertError(await api.post(`/api/sessions/${sessionId}/tasks/task-1/stop`), 409, 'SESSION_NOT_LIVE');
    } finally {
      events.close();
    }
  });
});

describe('sessions: live limit', { timeout: 120000 }, () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let server;
  /** @type {ReturnType<typeof client>} */
  let api;
  before(async () => {
    server = await startTestServer({ CAW_MAX_LIVE_SESSIONS: '1' });
    api = client(server.url);
    await api.login();
  });
  after(async () => {
    await server.close();
  });

  it('answers 429 TOO_MANY_SESSIONS while the only live session is busy, and evicts it once idle', async () => {
    const busy = await createLive(api, { cwd: server.proj });
    const events = await api.events({ watch: busy.sessionId, after: 0 });
    try {
      // A tool call waits for a permission answer, so the session is busy and cannot be evicted.
      const clientMessageId = randomUUID();
      const sent = await api.post(`/api/sessions/${busy.sessionId}/messages`, {
        clientMessageId,
        text: 'Please run a tool',
      });
      assert.equal(sent.status, 200);
      const request = await events.next((frame) => frame.event === 'request'
        && frame.data.request.sessionId === busy.sessionId);
      assert.equal((await waitForState(api, busy.sessionId, 'requires_action')).pendingCount, 1);
      assertError(await api.post('/api/sessions', { cwd: server.proj }), 429, 'TOO_MANY_SESSIONS');

      const answered = await api.post(`/api/sessions/${busy.sessionId}/requests/${request.data.request.id}`, {
        decision: 'deny',
      });
      assert.deepEqual(answered.json, { ok: true });
      const finished = await events.next(turnResult(busy.sessionId, clientMessageId));
      assert.equal(finished.data.msg.type, 'result');

      const replacement = await createLive(api, { cwd: server.proj });
      assert.notEqual(replacement.sessionId, busy.sessionId);
      const evicted = (await api.get(`/api/sessions/${busy.sessionId}`)).json;
      assert.equal(evicted.live, null, 'the idle session was closed to make room');
      assert.ok(evicted.info, 'closing keeps the session on disk');
    } finally {
      events.close();
    }
  });
});

describe('sessions: least recently used eviction', { timeout: 120000 }, () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let server;
  /** @type {ReturnType<typeof client>} */
  let api;
  before(async () => {
    server = await startTestServer({ CAW_MAX_LIVE_SESSIONS: '2' });
    api = client(server.url);
    await api.login();
  });
  after(async () => {
    await server.close();
  });

  it('closes the least recently active idle session when a third one starts', async () => {
    const first = await createLive(api, { cwd: server.proj });
    await waitForState(api, first.sessionId, 'idle');
    const second = await createLive(api, { cwd: server.proj });
    await waitForState(api, second.sessionId, 'idle');
    const secondEvents = await api.events({ watch: second.sessionId, after: 0 });
    const firstEvents = await api.events({ watch: first.sessionId, after: 0 });
    try {
      // Turns give both sessions a file and set their activity: the second session is touched first, the first last.
      await runTurn(api, secondEvents, second.sessionId, 'Touch the second session');
      await sleep(15);
      await runTurn(api, firstEvents, first.sessionId, 'Touch the first session');
    } finally {
      secondEvents.close();
      firstEvents.close();
    }
    const third = await createLive(api, { cwd: server.proj });
    const evicted = (await api.get(`/api/sessions/${second.sessionId}`)).json;
    assert.equal(evicted.live, null, 'the least recently active session was closed');
    assert.ok(evicted.info, 'it is still on disk');
    assert.equal((await api.get(`/api/sessions/${first.sessionId}`)).json.live.sessionId, first.sessionId);
    assert.equal((await api.get(`/api/sessions/${third.sessionId}`)).json.live.sessionId, third.sessionId);
  });
});

describe('sessions: version reporting', { timeout: 60000 }, () => {
  it('keeps reporting the Claude Code version after the session that reported it closes', async () => {
    const server = await startTestServer();
    try {
      const api = client(server.url);
      await api.login();
      const live = await createLive(api, { cwd: server.proj });
      const events = await api.events({ watch: live.sessionId, after: 0 });
      try {
        await runTurn(api, events, live.sessionId, 'Report the version');
      } finally {
        events.close();
      }
      assert.equal((await api.post(`/api/sessions/${live.sessionId}/close`)).status, 200);
      const meta = await api.get('/api/meta');
      assert.equal(meta.json.claudeCodeVersion, CLAUDE_CODE_VERSION);
    } finally {
      await server.close();
    }
  });
});

describe('sessions: list freshness', { timeout: 60000 }, () => {
  it('announces sessions_changed after every finished turn so lists pick up new summaries', async () => {
    const server = await startTestServer();
    try {
      const api = client(server.url);
      await api.login();
      const live = await createLive(api, { cwd: server.proj });
      const events = await openEvents(api, { watch: live.sessionId });
      try {
        await events.next(eventNamed('hello'));
        await runTurn(api, events, live.sessionId, 'Summarize the project please');
        const changed = await events.next(eventNamed('sessions_changed', { reason: 'activity' }));
        assert.equal(changed.data.sessionId, live.sessionId);
        const listed = (await api.get('/api/sessions')).json.sessions.find((s) => s.sessionId === live.sessionId);
        assert.ok(listed, 'the session is listed after its first turn');
        assert.match(String(listed.firstPrompt ?? listed.summary ?? ''), /Summarize the project/);
      } finally {
        events.close();
      }
    } finally {
      await server.close();
    }
  });
});
