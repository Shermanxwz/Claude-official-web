/**
 * Integration tests: the options a session starts with and the settings a live session takes (POST /api/sessions,
 * /open and /settings), the folder trust the runtime records (GET and POST /api/fs/trust), the browser tools that need
 * the operator's browser server, the bypass guard, and the feature flags of GET /api/meta.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, before, after } from 'node:test';
import { assertError, client, createLive, eventNamed, runTurn, startTestServer, turnResult } from './helpers.mjs';

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A predicate over the SDK messages of one session.
 * @param {string} sessionId
 * @param {(msg: any) => boolean} predicate
 */
function sdkWhere(sessionId, predicate) {
  return (/** @type {any} */ frame) => frame.event === 'sdk' && frame.data?.sessionId === sessionId
    && predicate(frame.data.msg);
}

/** A streamed text delta: the answer to a slow prompt has started. */
const isTextDelta = (/** @type {any} */ msg) => msg.type === 'stream_event' && msg.event.type === 'content_block_delta';

/** The operator's browser MCP server, as CAW_BROWSER_MCP_COMMAND names it. */
const BROWSER_COMMAND = JSON.stringify(['mock-browser-mcp', '--headless']);

/**
 * The MCP servers of a live session, from the runtime's mcp view.
 * @param {ReturnType<typeof client>} api
 * @param {string} sessionId
 * @returns {Promise<Array<{name: string, status: string, tools: Array<{name: string}>}>>}
 */
async function mcpServersOf(api, sessionId) {
  const res = await api.get(`/api/sessions/${sessionId}/runtime/mcp`);
  assert.equal(res.status, 200, res.text);
  return res.json.data;
}

/**
 * The session as the gateway reports it, with its live state when it is open.
 * @param {ReturnType<typeof client>} api
 * @param {string} sessionId
 */
async function sessionOf(api, sessionId) {
  const res = await api.get(`/api/sessions/${sessionId}`);
  assert.equal(res.status, 200, res.text);
  return res.json;
}

/**
 * The live session once its initialize handshake is answered: the live state leaves `starting` then, before any prompt.
 * Claude Code reports its mode, model and version with system/init, which comes with the first prompt (see
 * firstPrompt), so until then the live session shows only what the user chose, or null.
 * @param {ReturnType<typeof client>} api
 * @param {string} sessionId
 * @returns {Promise<any>}
 */
async function readyLive(api, sessionId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const live = (await sessionOf(api, sessionId)).live;
    if (live !== null && live.state !== 'starting') return live;
    await sleep(50);
  }
  assert.fail('the session did not become ready');
}

/**
 * Sends the first prompt of a session and waits for its turn to end. system/init comes with that prompt, so after this
 * the live session reports what the runtime started in.
 * @param {ReturnType<typeof client>} api
 * @param {string} sessionId
 */
async function firstPrompt(api, sessionId) {
  const events = await api.events({ watch: sessionId, after: 0 });
  try {
    await runTurn(api, events, sessionId, 'Tell me something');
  } finally {
    events.close();
  }
}

describe('folder trust', { timeout: 120000 }, () => {
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

  it('a folder is trusted when the owner says so, and the runtime records that trust', async () => {
    const folder = server.proj;
    const query = `/api/fs/trust?path=${encodeURIComponent(folder)}`;
    assert.deepEqual((await api.get(query)).json, { path: folder, trusted: false });
    const trusted = await api.post('/api/fs/trust', { path: folder, trusted: true });
    assert.equal(trusted.status, 200, trusted.text);
    assert.deepEqual(trusted.json, { path: folder, trusted: true, runtimeTrust: 'accepted' });
    assert.deepEqual((await api.get(query)).json, { path: folder, trusted: true });
    // The runtime's answer is kept for the life of the gateway, so the folder is not recorded again: the folder is
    // trusted already.
    assert.equal((await api.post('/api/fs/trust', { path: folder, trusted: true })).json.runtimeTrust, 'already');
  });

  it('a folder whose trust is withdrawn is skipped by the runtime', async () => {
    const folder = server.proj;
    assert.deepEqual((await api.post('/api/fs/trust', { path: folder, trusted: false })).json,
      { path: folder, trusted: false, runtimeTrust: 'skipped' });
    assert.deepEqual((await api.get(`/api/fs/trust?path=${encodeURIComponent(folder)}`)).json,
      { path: folder, trusted: false });
  });

  it('a session in a trusted folder is trusted, and one in a folder never trusted is not', async () => {
    await api.post('/api/fs/trust', { path: server.proj, trusted: true });
    const trusted = await createLive(api, { cwd: server.proj });
    assert.equal(trusted.trusted, true);
    const other = path.join(server.root, 'untrusted');
    fs.mkdirSync(other);
    const untrusted = await createLive(api, { cwd: other });
    assert.equal(untrusted.trusted, false);
  });

  it('trusting a folder trusts the folders inside it, and withdrawing it withdraws that', async () => {
    assert.equal((await api.post('/api/fs/trust', { path: server.root, trusted: true })).json.trusted, true);
    const inside = await createLive(api, { cwd: server.proj });
    assert.equal(inside.trusted, true);
    assert.equal((await api.post('/api/fs/trust', { path: server.root, trusted: false })).json.trusted, false);
  });

  it('a folder outside the workspace roots is never trusted, and a trust flag that is not a boolean is refused',
    async () => {
      assert.deepEqual((await api.get(`/api/fs/trust?path=${encodeURIComponent(server.outside)}`)).json,
        { path: server.outside, trusted: false });
      assertError(await api.post('/api/fs/trust', { path: server.outside, trusted: true }), 422, 'PATH_NOT_ALLOWED');
      assertError(await api.post('/api/fs/trust', { path: server.proj, trusted: 'yes' }), 400, 'BAD_REQUEST');
    });
});

describe('options a session starts with, and settings of a live session', { timeout: 120000 }, () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let server;
  /** @type {ReturnType<typeof client>} */
  let api;
  /** An extra folder inside the workspace roots. */
  let extra = '';
  before(async () => {
    // The user's settings default the mode to acceptEdits.
    server = await startTestServer({}, { resolvedSettings: { permissions: { defaultMode: 'acceptEdits' } } });
    api = client(server.url);
    await api.login();
    extra = path.join(server.root, 'extra');
    fs.mkdirSync(extra);
  });
  after(async () => {
    await server.close();
  });

  it('starts in the mode the settings default to, unless the request names a mode', async () => {
    const byDefault = await createLive(api, { cwd: server.proj });
    // Before the first prompt the runtime has not reported a mode, so the live session has none to show.
    assert.equal((await readyLive(api, byDefault.sessionId)).permissionMode, null);
    await firstPrompt(api, byDefault.sessionId);
    assert.equal((await readyLive(api, byDefault.sessionId)).permissionMode, 'acceptEdits');
    const named = await createLive(api, { cwd: server.proj, permissionMode: 'plan' });
    assert.equal((await readyLive(api, named.sessionId)).permissionMode, 'plan', 'the mode chosen is shown at once');
    await firstPrompt(api, named.sessionId);
    assert.equal((await readyLive(api, named.sessionId)).permissionMode, 'plan', 'and the runtime reports the same');
  });

  it('starts with a main-thread agent, extra folders and a fallback model', async () => {
    const live = await createLive(api, {
      cwd: server.proj,
      agent: 'Explore',
      additionalDirectories: [extra],
      fallbackModel: 'claude-haiku-mock',
    });
    assert.equal(live.agent, 'Explore');
    assert.deepEqual(live.additionalDirectories, [extra]);
    assert.equal(live.fallbackModel, 'claude-haiku-mock');
  });

  it('refuses a start request whose settings are not valid', async () => {
    const base = { cwd: server.proj };
    assertError(await api.post('/api/sessions', { ...base, additionalDirectories: [server.outside] }),
      422, 'PATH_NOT_ALLOWED');
    assertError(await api.post('/api/sessions', { ...base, additionalDirectories: 'extra' }), 400, 'BAD_REQUEST');
    assertError(await api.post('/api/sessions', { ...base, permissionMode: 'yolo' }), 422, 'INVALID_ARGUMENT');
    assertError(await api.post('/api/sessions', { ...base, effort: 'turbo' }), 422, 'INVALID_ARGUMENT');
    assertError(await api.post('/api/sessions', { ...base, fastMode: 'yes' }), 422, 'INVALID_ARGUMENT');
    assertError(await api.post('/api/sessions', { ...base, model: 'two words' }), 422, 'INVALID_ARGUMENT');
    assertError(await api.post('/api/sessions', { ...base, agent: '' }), 400, 'BAD_REQUEST');
  });

  it('a live session takes a new agent, and clears it with null', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const set = await api.post(`/api/sessions/${live.sessionId}/settings`, { agent: 'Plan' });
    assert.equal(set.status, 200, set.text);
    assert.equal(set.json.live.agent, 'Plan');
    assert.equal(set.json.restartRequired, false);
    assert.equal((await api.post(`/api/sessions/${live.sessionId}/settings`, { agent: null })).json.live.agent, null);
    assertError(await api.post(`/api/sessions/${live.sessionId}/settings`, { agent: '' }), 400, 'BAD_REQUEST');
  });

  it('a new fallback model is reported as needing a restart, and the next start uses it', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const events = await api.events({ watch: live.sessionId, after: 0 });
    try {
      await runTurn(api, events, live.sessionId, 'Tell me something');
    } finally {
      events.close();
    }
    const changed = await api.post(`/api/sessions/${live.sessionId}/settings`, { fallbackModel: 'claude-haiku-mock' });
    assert.equal(changed.status, 200, changed.text);
    assert.equal(changed.json.restartRequired, true, 'the open query keeps the fallback it started with');
    assert.equal((await api.post(`/api/sessions/${live.sessionId}/close`, {})).status, 200);
    const reopened = await api.post(`/api/sessions/${live.sessionId}/open`, {});
    assert.equal(reopened.status, 200, reopened.text);
    assert.equal(reopened.json.live.fallbackModel, 'claude-haiku-mock');
  });

  it('a live session takes a new permission mode, and refuses null, which only a closed session accepts', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const set = await api.post(`/api/sessions/${live.sessionId}/settings`, { permissionMode: 'plan' });
    assert.equal(set.status, 200, set.text);
    assert.equal(set.json.live.permissionMode, 'plan');
    assertError(await api.post(`/api/sessions/${live.sessionId}/settings`, { permissionMode: null }), 400,
      'BAD_REQUEST');
    assertError(await api.post(`/api/sessions/${live.sessionId}/settings`, { permissionMode: 'yolo' }), 422,
      'INVALID_ARGUMENT');
  });

  it('a closed session remembers the settings it is given, and its next open starts with them', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const events = await api.events({ watch: live.sessionId, after: 0 });
    try {
      await runTurn(api, events, live.sessionId, 'Tell me something');
    } finally {
      events.close();
    }
    assert.equal((await api.post(`/api/sessions/${live.sessionId}/close`, {})).status, 200);
    const remembered = await api.post(`/api/sessions/${live.sessionId}/settings`, {
      permissionMode: 'plan',
      agent: 'Plan',
    });
    assert.deepEqual(remembered.json, { live: null, restartRequired: false });
    const reopened = await api.post(`/api/sessions/${live.sessionId}/open`, {});
    assert.equal(reopened.status, 200, reopened.text);
    assert.equal(reopened.json.live.permissionMode, 'plan');
    assert.equal(reopened.json.live.agent, 'Plan');
  });

  it('extra folders restart the query between turns, and cannot change while a turn runs', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const sessionId = live.sessionId;
    const events = await api.events({ watch: sessionId, after: 0 });
    try {
      // A slow answer keeps the session running until its text starts to stream.
      const clientMessageId = randomUUID();
      assert.equal((await api.post(`/api/sessions/${sessionId}/messages`, {
        clientMessageId,
        text: 'answer slowly',
      })).status, 200);
      await events.next(sdkWhere(sessionId, isTextDelta), 5000);
      assertError(await api.post(`/api/sessions/${sessionId}/settings`, { additionalDirectories: [extra] }),
        409, 'CONFLICT');
      await events.next(turnResult(sessionId, clientMessageId), 10000);

      const changed = await api.post(`/api/sessions/${sessionId}/settings`, { additionalDirectories: [extra] });
      assert.equal(changed.status, 200, changed.text);
      assert.equal(changed.json.live.sessionId, sessionId, 'the session keeps its identity across the restart');
      assert.deepEqual(changed.json.live.additionalDirectories, [extra]);
      assert.equal(changed.json.restartRequired, false);
    } finally {
      events.close();
    }
  });
});

describe('browser tools', { timeout: 120000 }, () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let server;
  /** @type {ReturnType<typeof client>} */
  let api;
  before(async () => {
    server = await startTestServer({
      CAW_BROWSER_MCP_COMMAND: BROWSER_COMMAND,
      CAW_CHROME: '1',
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
      CAW_FALLBACK_MODEL: 'claude-sonnet-mock',
      CAW_DEFAULT_MODEL: 'claude-opus-mock',
      CAW_DEFAULT_EFFORT: 'high',
    });
    api = client(server.url);
    await api.login();
  });
  after(async () => {
    await server.close();
  });

  it('the meta answer reports the features and the defaults this gateway runs with', async () => {
    const meta = (await api.get('/api/meta')).json;
    assert.equal(meta.features.browserTools, true);
    assert.equal(meta.features.chrome, true);
    assert.equal(meta.features.backgroundTasks, false, 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS turns them off');
    assert.equal(meta.features.bypass, false, 'bypass needs CAW_ALLOW_BYPASS');
    assert.equal(meta.features.uploads, true);
    assert.equal(meta.features.accountLogin, true);
    assert.deepEqual(meta.defaults, {
      model: 'claude-opus-mock',
      permissionMode: null,
      effort: 'high',
      fallbackModel: 'claude-sonnet-mock',
    });
  });

  it('background tasks are refused while they are disabled', async () => {
    const live = await createLive(api, { cwd: server.proj });
    assertError(await api.post(`/api/sessions/${live.sessionId}/background`, {}), 501, 'FEATURE_DISABLED');
  });

  it('a session starts with the browser tools, which the runtime lists as a connected server', async () => {
    const live = await createLive(api, { cwd: server.proj, browserTools: true });
    assert.equal(live.browserTools, true);
    const browser = (await mcpServersOf(api, live.sessionId)).find((entry) => entry.name === 'browser');
    assert.equal(browser.status, 'connected');
    const tools = browser.tools.map((tool) => tool.name);
    assert.ok(tools.includes('browser_navigate'));
    assert.ok(tools.includes('browser_take_screenshot'));
  });

  it('a screenshot the browser server returns is an image block of its tool result in the transcript', async () => {
    const live = await createLive(api, { cwd: server.proj, browserTools: true });
    const events = await api.events({ watch: live.sessionId, after: 0 });
    try {
      await runTurn(api, events, live.sessionId, 'browse the page');
    } finally {
      events.close();
    }
    const transcript = (await api.get(`/api/sessions/${live.sessionId}/messages?tail=50`)).json.messages;
    const results = transcript
      .flatMap((/** @type {any} */ entry) => (Array.isArray(entry.message?.content) ? entry.message.content : []))
      .filter((/** @type {any} */ block) => block.type === 'tool_result');
    const image = results.flatMap((/** @type {any} */ block) => (Array.isArray(block.content) ? block.content : []))
      .find((/** @type {any} */ block) => block.type === 'image');
    assert.ok(image, 'the tool result carries an image block');
    assert.equal(image.source.type, 'base64');
    assert.equal(image.source.media_type, 'image/png');
    // The PNG signature is the eight bytes that start with the letters PNG.
    assert.equal(Buffer.from(image.source.data, 'base64').subarray(1, 4).toString('latin1'), 'PNG');
  });

  it('browser tools can be switched off and on for a live session, and take a boolean only', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const pathname = `/api/sessions/${live.sessionId}/settings`;
    const on = await api.post(pathname, { browserTools: true });
    assert.equal(on.json.live.browserTools, true);
    assert.ok((await mcpServersOf(api, live.sessionId)).some((entry) => entry.name === 'browser'));
    const off = await api.post(pathname, { browserTools: false });
    assert.equal(off.json.live.browserTools, false);
    assert.equal((await mcpServersOf(api, live.sessionId)).some((entry) => entry.name === 'browser'), false);
    assertError(await api.post(pathname, { browserTools: 'yes' }), 400, 'BAD_REQUEST');
  });
});

describe('without the browser server, bypass and browser tools are refused', { timeout: 120000 }, () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let server;
  /** @type {ReturnType<typeof client>} */
  let api;
  before(async () => {
    // The user's settings default the mode to bypassPermissions, which this gateway does not allow.
    server = await startTestServer({}, { resolvedSettings: { permissions: { defaultMode: 'bypassPermissions' } } });
    api = client(server.url);
    await api.login();
  });
  after(async () => {
    await server.close();
  });

  it('the settings default to bypass, which is not allowed: the session starts in default mode, with a notice',
    async () => {
      const events = await api.events({ after: 0 });
      try {
        const live = await createLive(api, { cwd: server.proj });
        // The runtime reports bypass with system/init, which comes with the first prompt.
        assert.equal((await readyLive(api, live.sessionId)).permissionMode, null);
        await firstPrompt(api, live.sessionId);
        const notice = await events.next(eventNamed('notice', { code: 'BYPASS_REFUSED' }), 5000);
        assert.equal(notice.data.level, 'warning');
        assert.equal(notice.data.sessionId, live.sessionId);
        assert.equal((await readyLive(api, live.sessionId)).permissionMode, 'default');
      } finally {
        events.close();
      }
    });

  it('bypass permissions is refused for a new session, a live one and an open, while it is not allowed', async () => {
    assertError(await api.post('/api/sessions', { cwd: server.proj, permissionMode: 'bypassPermissions' }),
      501, 'FEATURE_DISABLED');
    const live = await createLive(api, { cwd: server.proj, permissionMode: 'default' });
    assertError(await api.post(`/api/sessions/${live.sessionId}/settings`, { permissionMode: 'bypassPermissions' }),
      501, 'FEATURE_DISABLED');
    assertError(await api.post(`/api/sessions/${live.sessionId}/open`, { permissionMode: 'bypassPermissions' }),
      501, 'FEATURE_DISABLED');
  });

  it('the meta answer says bypass and browser tools are off, and browser tools are refused for a session', async () => {
    const meta = (await api.get('/api/meta')).json;
    assert.equal(meta.features.bypass, false);
    assert.equal(meta.features.browserTools, false);
    assertError(await api.post('/api/sessions', { cwd: server.proj, browserTools: true }), 501, 'FEATURE_DISABLED');
    const live = await createLive(api, { cwd: server.proj });
    assertError(await api.post(`/api/sessions/${live.sessionId}/settings`, { browserTools: true }), 501,
      'FEATURE_DISABLED');
  });
});

describe('a bypass the runtime cannot leave closes the session', { timeout: 120000 }, () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let server;
  /** @type {ReturnType<typeof client>} */
  let api;
  before(async () => {
    server = await startTestServer({}, {
      resolvedSettings: { permissions: { defaultMode: 'bypassPermissions' } },
      wrapEngine: (engine) => ({
        ...engine,
        query: (args) => {
          const query = engine.query(args);
          // The runtime refuses every change of mode, so the gateway cannot take the session out of bypass.
          query.setPermissionMode = async () => {
            throw new Error('The permission mode cannot be changed.');
          };
          return query;
        },
      }),
    });
    api = client(server.url);
    await api.login();
  });
  after(async () => {
    await server.close();
  });

  it('the session is closed, and a notice says why', async () => {
    const events = await api.events({ after: 0 });
    try {
      const live = await createLive(api, { cwd: server.proj });
      // The runtime reports bypass with system/init, which comes with the first prompt. The refusal then closes the
      // session, so the prompt is only sent to make the runtime start; its turn is not awaited.
      const sent = await api.post(`/api/sessions/${live.sessionId}/messages`, {
        clientMessageId: randomUUID(),
        text: 'Tell me something',
      });
      assert.equal(sent.status, 200, sent.text);
      const notice = await events.next(eventNamed('notice', { code: 'BYPASS_REFUSED' }), 5000);
      assert.equal(notice.data.level, 'error');
      assert.equal(notice.data.sessionId, live.sessionId);
      // The session is closed once the runtime's refusal has run, which is after the notice is published.
      let closed = null;
      for (let attempt = 0; attempt < 100 && closed === null; attempt += 1) {
        const res = await api.get(`/api/sessions/${live.sessionId}/runtime`);
        if (res.status === 409) closed = res;
        else await sleep(50);
      }
      assert.ok(closed, 'the session was not closed');
      assertError(closed, 409, 'SESSION_NOT_LIVE');
    } finally {
      events.close();
    }
  });
});

describe('bypass permissions when the gateway allows it', { timeout: 120000 }, () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let server;
  /** @type {ReturnType<typeof client>} */
  let api;
  before(async () => {
    server = await startTestServer({ CAW_ALLOW_BYPASS: '1' });
    api = client(server.url);
    await api.login();
  });
  after(async () => {
    await server.close();
  });

  it('the meta answer says bypass is on, and a session starts in bypass mode without a notice', async () => {
    assert.equal((await api.get('/api/meta')).json.features.bypass, true);
    const live = await createLive(api, { cwd: server.proj, permissionMode: 'bypassPermissions' });
    const events = await api.events({ watch: live.sessionId, after: 0 });
    try {
      assert.equal((await readyLive(api, live.sessionId)).permissionMode, 'bypassPermissions');
      await runTurn(api, events, live.sessionId, 'Tell me something');
      assert.equal((await readyLive(api, live.sessionId)).permissionMode, 'bypassPermissions');
      assert.equal(events.all().some(eventNamed('notice', { code: 'BYPASS_REFUSED' })), false);
    } finally {
      events.close();
    }
  });
});

describe('a folder the runtime cannot record', { timeout: 120000 }, () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let server;
  /** @type {ReturnType<typeof client>} */
  let api;
  before(async () => {
    // The trust probe cannot start, so the runtime records no trust for any folder.
    server = await startTestServer({}, {
      wrapEngine: (engine) => ({
        ...engine,
        query: (args) => {
          if (String(args.options?.cwd ?? '').endsWith('trust-probe')) throw new Error('The probe cannot start.');
          return engine.query(args);
        },
      }),
    });
    api = client(server.url);
    await api.login();
  });
  after(async () => {
    await server.close();
  });

  it('is reported as failed, and a session in it starts with a warning notice', async () => {
    const trusted = await api.post('/api/fs/trust', { path: server.proj, trusted: true });
    assert.deepEqual(trusted.json, { path: server.proj, trusted: true, runtimeTrust: 'failed' });
    const events = await api.events({ after: 0 });
    try {
      const live = await createLive(api, { cwd: server.proj });
      const notice = await events.next(eventNamed('notice', { code: 'RUNTIME_TRUST' }), 5000);
      assert.equal(notice.data.level, 'warning');
      assert.equal(notice.data.sessionId, live.sessionId);
      assert.equal(live.trusted, true, 'the session still starts, trusted by the gateway');
    } finally {
      events.close();
    }
  });
});

describe('a standard profile cannot attach browser tools', { timeout: 120000 }, () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let server;
  /** @type {ReturnType<typeof client>} */
  let api;
  before(async () => {
    server = await startTestServer({ CAW_ACCESS_PROFILE: 'standard', CAW_BROWSER_MCP_COMMAND: BROWSER_COMMAND });
    api = client(server.url);
    await api.login();
  });
  after(async () => {
    await server.close();
  });

  it('a session with browser tools is forbidden, and one without them starts', async () => {
    assert.equal((await api.get('/api/meta')).json.profile, 'standard');
    assertError(await api.post('/api/sessions', { cwd: server.proj, browserTools: true }), 403, 'FORBIDDEN');
    const live = await createLive(api, { cwd: server.proj, permissionMode: 'plan' });
    assert.equal((await readyLive(api, live.sessionId)).permissionMode, 'plan');
    assertError(await api.post(`/api/sessions/${live.sessionId}/settings`, { browserTools: true }), 403, 'FORBIDDEN');
  });
});
