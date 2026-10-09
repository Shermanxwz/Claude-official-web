/**
 * Integration tests: the file mention search (GET /api/fs/search) and the conversation search
 * (GET /api/sessions/search). The file search answers from the runtime's @ index for a live session in the folder it
 * asks about, once the index has warmed up; before that, and for any other session or folder, the gateway's own walk
 * answers. The conversation search matches titles first, then the text of the transcripts.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, before, after } from 'node:test';
import { assertError, client, createLive, runTurn, startTestServer } from './helpers.mjs';

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long the runtime's @ index takes to warm up after a query starts (the mock's FILE_INDEX_WARMUP_MS). */
const WARMUP_MS = 1500;

/** @param {string} value */
const enc = (value) => encodeURIComponent(value);

describe('file mention search', { timeout: 120000 }, () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let server;
  /** @type {ReturnType<typeof client>} */
  let api;
  /** A folder inside the workspace roots that is not the project. */
  let other = '';
  before(async () => {
    server = await startTestServer();
    api = client(server.url);
    await api.login();
    other = path.join(server.root, 'other');
    fs.mkdirSync(other);
  });
  after(async () => {
    await server.close();
  });

  it('answers from the gateway while the runtime index warms up, and from the runtime once it has', async () => {
    const openedAt = Date.now();
    const live = await createLive(api, { cwd: server.proj });
    const query = `/api/fs/search?cwd=${enc(server.proj)}&q=util&session=${live.sessionId}`;
    const early = await api.get(query);
    assert.equal(early.status, 200, early.text);
    // The index answers nothing for 1.5 s after the query starts, so the gateway answers while that window is open.
    // The check runs only while the window is certainly open; the window opens no earlier than the request.
    if (Date.now() - openedAt < 1000) {
      assert.equal(early.json.source, 'gateway');
      assert.ok(early.json.results.some((/** @type {{path: string}} */ entry) => entry.path === 'src/util/helpers.js'));
    }

    await sleep(Math.max(0, openedAt + WARMUP_MS + 100 - Date.now()));
    const warm = await api.get(query);
    assert.equal(warm.status, 200, warm.text);
    assert.equal(warm.json.source, 'runtime');
    // The runtime lists a folder with a trailing slash; the answer carries it as a folder type, without the slash.
    assert.deepEqual(warm.json.results, [
      { path: 'src/util', type: 'dir' },
      { path: 'src/util/helpers.js', type: 'file' },
    ]);
    const limited = await api.get(`${query}&limit=1`);
    assert.deepEqual(limited.json.results, [{ path: 'src/util', type: 'dir' }]);
  });

  it('a query the runtime answers with nothing falls back to the gateway', async () => {
    const live = await createLive(api, { cwd: server.proj });
    await sleep(WARMUP_MS + 100);
    const res = await api.get(`/api/fs/search?cwd=${enc(server.proj)}&q=zzz-no-such-file&session=${live.sessionId}`);
    assert.equal(res.json.source, 'gateway');
    assert.deepEqual(res.json.results, []);
  });

  it('a session in another folder, a session that is not live and an unknown session answer from the gateway',
    async () => {
      const elsewhere = await createLive(api, { cwd: other });
      await sleep(WARMUP_MS + 100);
      const query = (/** @type {string} */ id) => `/api/fs/search?cwd=${enc(server.proj)}&q=util&session=${id}`;
      assert.equal((await api.get(query(elsewhere.sessionId))).json.source, 'gateway');
      const closed = await createLive(api, { cwd: server.proj });
      assert.equal((await api.post(`/api/sessions/${closed.sessionId}/close`, {})).status, 200);
      assert.equal((await api.get(query(closed.sessionId))).json.source, 'gateway');
      assert.equal((await api.get(query(randomUUID()))).json.source, 'gateway');
    });

  it('a runtime index that answers after the 1.5 s limit is not waited for', async () => {
    const slow = await startTestServer({}, {
      wrapEngine: (engine) => ({
        ...engine,
        query: (args) => {
          const query = engine.query(args);
          const request = query.request;
          query.request = async (/** @type {any} */ payload) => {
            if (payload?.subtype === 'file_suggestions') await sleep(2000);
            return request(payload);
          };
          return query;
        },
      }),
    });
    try {
      const api2 = client(slow.url);
      await api2.login();
      const live = await createLive(api2, { cwd: slow.proj });
      await sleep(WARMUP_MS + 100);
      const res = await api2.get(`/api/fs/search?cwd=${enc(slow.proj)}&q=util&session=${live.sessionId}`);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.source, 'gateway');
    } finally {
      await slow.close();
    }
  });

  it('without a session the gateway answers, and a folder outside the roots is refused', async () => {
    const res = await api.get(`/api/fs/search?cwd=${enc(server.proj)}&q=app`);
    assert.equal(res.json.source, 'gateway');
    assert.ok(res.json.results.some((/** @type {{path: string}} */ entry) => entry.path === 'src/app.js'));
    assertError(await api.get(`/api/fs/search?cwd=${enc(server.outside)}&q=app`), 422, 'PATH_NOT_ALLOWED');
  });

  it('refuses a session id that is not a UUID, a query over 200 characters and a limit out of range', async () => {
    const base = `/api/fs/search?cwd=${enc(server.proj)}`;
    assertError(await api.get(`${base}&q=app&session=not-a-session`), 400, 'BAD_REQUEST');
    assertError(await api.get(`${base}&q=${'a'.repeat(201)}`), 400, 'BAD_REQUEST');
    assertError(await api.get(`${base}&q=app&limit=0`), 400, 'BAD_REQUEST');
    assertError(await api.get(`${base}&q=app&limit=201`), 400, 'BAD_REQUEST');
  });
});

describe('conversation search', { timeout: 120000 }, () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let server;
  /** @type {ReturnType<typeof client>} */
  let api;
  /** The session of each prompt, in the order the prompts were sent. */
  const sessions = [];
  const PROMPTS = ['Migrate the ledger service', 'Look into the billing report', 'Describe the nightly export'];
  before(async () => {
    server = await startTestServer();
    api = client(server.url);
    await api.login();
    for (const prompt of PROMPTS) {
      const live = await createLive(api, { cwd: server.proj });
      const events = await api.events({ watch: live.sessionId, after: 0 });
      try {
        await runTurn(api, events, live.sessionId, prompt);
      } finally {
        events.close();
      }
      sessions.push({ sessionId: live.sessionId, prompt });
    }
  });
  after(async () => {
    await server.close();
  });

  it('matches a session by its title first, with no snippets', async () => {
    const res = await api.get('/api/sessions/search?q=ledger');
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.results.length, 1);
    const [match] = res.json.results;
    assert.equal(match.sessionId, sessions[0].sessionId);
    assert.equal(match.matchedIn, 'title');
    assert.equal(match.title, PROMPTS[0]);
    assert.deepEqual(match.snippets, []);
    assert.equal(typeof res.json.scanned, 'number');
    assert.equal(res.json.truncated, false);
  });

  it('matches the text of transcripts case-insensitively, with snippets of the answer', async () => {
    const res = await api.get(`/api/sessions/search?q=${enc('DETERMINISTIC MOCK ENGINE')}`);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(new Set(res.json.results.map((/** @type {{sessionId: string}} */ item) => item.sessionId)),
      new Set(sessions.map((session) => session.sessionId)));
    const modified = res.json.results.map((/** @type {{lastModified: number}} */ item) => item.lastModified);
    assert.deepEqual(modified, [...modified].sort((a, b) => b - a), 'newest first');
    for (const item of res.json.results) {
      assert.equal(item.matchedIn, 'content');
      assert.ok(item.snippets.length >= 1 && item.snippets.length <= 3);
      for (const snippet of item.snippets) {
        assert.ok(snippet.length <= 160, 'a snippet is at most 160 characters');
        assert.ok(snippet.toLowerCase().includes('deterministic mock engine'));
      }
      const prompt = sessions.find((session) => session.sessionId === item.sessionId).prompt;
      assert.equal(item.title, prompt, 'the title is the first prompt of the session');
    }
  });

  it('a limit keeps only the most recent matches', async () => {
    const res = await api.get(`/api/sessions/search?q=${enc('deterministic mock engine')}&limit=1`);
    assert.equal(res.json.results.length, 1);
  });

  it('a renamed session is found by its new title', async () => {
    const renamed = sessions[1].sessionId;
    assert.equal((await api.patch(`/api/sessions/${renamed}`, { title: 'Quarterly close' })).status, 200);
    const res = await api.get('/api/sessions/search?q=quarterly');
    assert.equal(res.json.results.length, 1);
    assert.equal(res.json.results[0].sessionId, renamed);
    assert.equal(res.json.results[0].matchedIn, 'title');
    assert.equal(res.json.results[0].title, 'Quarterly close');
  });

  it('refuses a query shorter than two characters, a missing query and a limit out of range', async () => {
    assertError(await api.get('/api/sessions/search?q=a'), 400, 'BAD_REQUEST');
    assertError(await api.get('/api/sessions/search?q=%20%20'), 400, 'BAD_REQUEST');
    assertError(await api.get('/api/sessions/search'), 400, 'BAD_REQUEST');
    assertError(await api.get('/api/sessions/search?q=export&limit=0'), 400, 'BAD_REQUEST');
    assertError(await api.get('/api/sessions/search?q=export&limit=51'), 400, 'BAD_REQUEST');
  });
});
