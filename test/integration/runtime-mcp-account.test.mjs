/**
 * Integration tests: the MCP servers of a live session (POST /api/sessions/:id/mcp and /mcp/auth, with the status read
 * through the runtime's mcp view) and Claude Code's own sign-in (GET and DELETE /api/account, POST /api/account/login
 * and /login/code). A server's status follows its toggle, its reconnect and its sign-in. A sign-in completes only with
 * the code the sign-in page shows, and the gateway announces the account it signed in with.
 */
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { assertError, client, createLive, eventNamed, startTestServer } from './helpers.mjs';

/** The account the mock signs in with a Claude subscription. */
const SIGNED_IN_PRO = {
  email: 'demo@example.test',
  organization: 'Demo',
  subscriptionType: 'pro',
  apiProvider: 'firstParty',
};

/**
 * The state a sign-in address carries: the flow the code must answer.
 * @param {string} address
 * @returns {string|null}
 */
const stateOf = (address) => new URL(address).searchParams.get('state');

/**
 * The status of every server in an answer of POST /api/sessions/:id/mcp, by name.
 * @param {{mcpServers: Array<{name: string, status: string}>}} answer
 * @returns {Record<string, string>}
 */
const statusesIn = (answer) => Object.fromEntries(answer.mcpServers.map((server) => [server.name, server.status]));

/**
 * The status of every MCP server of a session, read through the runtime's mcp view.
 * @param {ReturnType<typeof client>} api
 * @param {string} sessionId
 * @returns {Promise<Record<string, string>>}
 */
async function statusesOf(api, sessionId) {
  const res = await api.get(`/api/sessions/${sessionId}/runtime/mcp`);
  assert.equal(res.status, 200, res.text);
  return Object.fromEntries(res.json.data.map((/** @type {{name: string, status: string}} */ server) => [
    server.name,
    server.status,
  ]));
}

/**
 * Starts the sign-in of the mock-oauth server of a session and completes it with the callback address the browser
 * lands on. Returns the answer that started the sign-in.
 * @param {ReturnType<typeof client>} api
 * @param {string} sessionId
 */
async function completeMcpSignIn(api, sessionId) {
  const pathname = `/api/sessions/${sessionId}/mcp/auth`;
  const started = await api.post(pathname, { server: 'mock-oauth', action: 'start' });
  assert.equal(started.status, 200, started.text);
  const callbackUrl = `http://localhost:53682/callback?code=mock-auth-code&state=${stateOf(started.json.authUrl)}`;
  const submitted = await api.post(pathname, { server: 'mock-oauth', action: 'callback', callbackUrl });
  assert.equal(submitted.status, 200, submitted.text);
  return started.json;
}

describe('MCP servers of a live session', { timeout: 120000 }, () => {
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

  it('turns a server off and on, and answers the status of every server', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const pathname = `/api/sessions/${live.sessionId}/mcp`;
    const off = await api.post(pathname, { server: 'github', action: 'toggle', enabled: false });
    assert.equal(off.status, 200, off.text);
    assert.deepEqual(statusesIn(off.json), { github: 'disabled', filesystem: 'failed', 'mock-oauth': 'needs-auth' });
    assert.equal('warning' in off.json, false, 'a toggle that finds its server has no warning');
    // Without an enabled flag the server is turned on.
    const on = await api.post(pathname, { server: 'github', action: 'toggle' });
    assert.equal(statusesIn(on.json).github, 'connected');
    const github = on.json.mcpServers.find((/** @type {{name: string}} */ entry) => entry.name === 'github');
    assert.deepEqual(github.tools.map((/** @type {{name: string}} */ tool) => tool.name), ['search_issues']);
  });

  it('reconnects a server: an enabled one answers its status, a disabled one is refused', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const pathname = `/api/sessions/${live.sessionId}/mcp`;
    const reconnected = await api.post(pathname, { server: 'filesystem', action: 'reconnect' });
    assert.equal(reconnected.status, 200, reconnected.text);
    assert.equal(statusesIn(reconnected.json).filesystem, 'failed', 'the server still cannot start');
    await api.post(pathname, { server: 'github', action: 'toggle', enabled: false });
    assertError(await api.post(pathname, { server: 'github', action: 'reconnect' }), 502, 'ENGINE_ERROR');
  });

  it('sets the permission mode of a server; a server that is not connected is named in a warning', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const pathname = `/api/sessions/${live.sessionId}/mcp`;
    const set = await api.post(pathname, { server: 'github', action: 'permission-mode', mode: 'auto' });
    assert.equal(set.status, 200, set.text);
    assert.equal('warning' in set.json, false);
    const cleared = await api.post(pathname, { server: 'github', action: 'permission-mode', mode: null });
    assert.equal('warning' in cleared.json, false, 'null clears the override without a warning');
    const absent = await api.post(pathname, { server: 'filesystem', action: 'permission-mode', mode: 'default' });
    assert.equal(absent.status, 200, absent.text);
    assert.equal(absent.json.warning, 'No MCP server named "filesystem" is connected.');
    assert.equal(absent.json.mcpServers.length, 3, 'the answer still lists every server');
    assertError(await api.post(pathname, { server: 'github', action: 'permission-mode', mode: 'bypassPermissions' }),
      422, 'INVALID_ARGUMENT');
    assertError(await api.post(pathname, { server: 'github', action: 'permission-mode' }), 422, 'INVALID_ARGUMENT');
  });

  it('refuses a malformed MCP action, and a server the runtime does not know cannot be changed', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const pathname = `/api/sessions/${live.sessionId}/mcp`;
    assertError(await api.post(pathname, { server: 'github', action: 'delete' }), 422, 'INVALID_ARGUMENT');
    assertError(await api.post(pathname, { server: '  ', action: 'toggle' }), 400, 'BAD_REQUEST');
    assertError(await api.post(pathname, { server: 'github', action: 'toggle', enabled: 'yes' }), 400, 'BAD_REQUEST');
    assertError(await api.post(pathname, { server: 'nope', action: 'toggle', enabled: false }), 502, 'ENGINE_ERROR');
  });

  it('an MCP action on a session that is not live is refused', async () => {
    const live = await createLive(api, { cwd: server.proj });
    assert.equal((await api.post(`/api/sessions/${live.sessionId}/close`, {})).status, 200);
    assertError(await api.post(`/api/sessions/${live.sessionId}/mcp`, { server: 'github', action: 'reconnect' }),
      409, 'SESSION_NOT_LIVE');
    assertError(await api.post(`/api/sessions/${live.sessionId}/mcp/auth`, { server: 'mock-oauth', action: 'start' }),
      409, 'SESSION_NOT_LIVE');
  });
});

describe('an MCP sign-in address the gateway will not open', { timeout: 120000 }, () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let server;
  /** @type {ReturnType<typeof client>} */
  let api;
  before(async () => {
    // The runtime answers a sign-in with an address that is not a web address.
    server = await startTestServer({}, {
      wrapEngine: (engine) => ({
        ...engine,
        query: (args) => {
          const query = engine.query(args);
          query.mcpAuthenticate = async () => ({ authUrl: 'javascript:alert(1)', requiresUserAction: true });
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

  it('answers an engine error, and gives no address', async () => {
    const live = await createLive(api, { cwd: server.proj });
    assertError(await api.post(`/api/sessions/${live.sessionId}/mcp/auth`, { server: 'mock-oauth', action: 'start' }),
      502, 'ENGINE_ERROR');
  });
});

describe('MCP sign-in of a server', { timeout: 120000 }, () => {
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

  it('starts the sign-in of a server, and the callback address that comes back completes it', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const pathname = `/api/sessions/${live.sessionId}/mcp/auth`;
    const started = await api.post(pathname, { server: 'mock-oauth', action: 'start' });
    assert.equal(started.status, 200, started.text);
    assert.match(started.json.authUrl, /^https:\/\/mcp-auth\.example\.test\/authorize\?server=mock-oauth&state=/);
    assert.equal(started.json.requiresUserAction, true);
    assert.equal(started.json.callbackExpected, true);
    assert.equal(started.json.redirectScheme, 'localhost');
    assert.equal(started.json.callbackPort, 53682);
    assert.equal((await statusesOf(api, live.sessionId))['mock-oauth'], 'needs-auth', 'not signed in yet');

    const callbackUrl = `http://localhost:53682/callback?code=mock-auth-code&state=${stateOf(started.json.authUrl)}`;
    const submitted = await api.post(pathname, { server: 'mock-oauth', action: 'callback', callbackUrl });
    assert.deepEqual(submitted.json, { ok: true });
    assert.equal((await statusesOf(api, live.sessionId))['mock-oauth'], 'connected');
  });

  it('a signed-in server needs no sign-in again, and clearing its sign-in asks for one', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const pathname = `/api/sessions/${live.sessionId}/mcp/auth`;
    await completeMcpSignIn(api, live.sessionId);
    assert.deepEqual((await api.post(pathname, { server: 'mock-oauth', action: 'start' })).json, {
      authUrl: null,
      requiresUserAction: false,
      callbackExpected: false,
      redirectScheme: null,
      callbackPort: null,
    });
    assert.deepEqual((await api.post(pathname, { server: 'mock-oauth', action: 'clear' })).json, { ok: true });
    assert.equal((await statusesOf(api, live.sessionId))['mock-oauth'], 'needs-auth');
  });

  it('a server without OAuth needs no sign-in', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const started = await api.post(`/api/sessions/${live.sessionId}/mcp/auth`, { server: 'github', action: 'start' });
    assert.equal(started.status, 200, started.text);
    assert.equal(started.json.authUrl, null);
    assert.equal(started.json.requiresUserAction, false);
  });

  it('a callback must be a web address that carries the state and the code of the flow', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const pathname = `/api/sessions/${live.sessionId}/mcp/auth`;
    const started = await api.post(pathname, { server: 'mock-oauth', action: 'start' });
    const state = stateOf(started.json.authUrl);
    const callback = (/** @type {string|undefined} */ callbackUrl) => api.post(pathname, {
      server: 'mock-oauth',
      action: 'callback',
      ...(callbackUrl === undefined ? {} : { callbackUrl }),
    });
    assertError(await callback(undefined), 400, 'BAD_REQUEST');
    assertError(await callback(`ftp://localhost/callback?code=x&state=${state}`), 400, 'BAD_REQUEST');
    assertError(await callback(`http://localhost/?${'a'.repeat(4096)}`), 400, 'BAD_REQUEST');
    assertError(await callback('http://localhost:53682/callback?code=x&state=not-the-state'), 502, 'ENGINE_ERROR');
    assertError(await callback(`http://localhost:53682/callback?state=${state}`), 502, 'ENGINE_ERROR');
  });

  it('a server that cannot sign in, and an unknown server, answer an engine error', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const pathname = `/api/sessions/${live.sessionId}/mcp/auth`;
    assertError(await api.post(pathname, { server: 'filesystem', action: 'start' }), 502, 'ENGINE_ERROR');
    assertError(await api.post(pathname, { server: 'nope', action: 'start' }), 502, 'ENGINE_ERROR');
    assertError(await api.post(pathname, { server: 'mock-oauth', action: 'refresh' }), 422, 'INVALID_ARGUMENT');
  });
});

describe('sign-in to Claude Code', { timeout: 120000 }, () => {
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

  it('reads the account the runtime has, with no sign-in in progress', async () => {
    const res = await api.get('/api/account');
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json, {
      account: { email: 'demo@example.com', subscriptionType: 'pro', apiProvider: 'firstParty' },
      signInPending: false,
    });
  });

  it('a sign-in opens a flow with its sign-in addresses, and the code the page shows completes it', async () => {
    const started = await api.post('/api/account/login', { method: 'claudeai' });
    assert.equal(started.status, 200, started.text);
    assert.match(started.json.manualUrl, /^https:\/\/claude\.ai\/oauth\/authorize\?/);
    assert.match(started.json.automaticUrl, /^https:\/\/claude\.ai\/oauth\/authorize\?.*redirect=localhost/);
    assert.equal((await api.get('/api/account')).json.signInPending, true);
    const state = stateOf(started.json.manualUrl);
    const joined = await api.post('/api/account/login', { method: 'claudeai' });
    assert.equal(joined.json.manualUrl, started.json.manualUrl, 'the same method joins the flow in progress');
    const events = await api.events({ after: 0 });
    try {
      const completed = await api.post('/api/account/login/code', { code: `mock-code#${state}` });
      assert.equal(completed.status, 200, completed.text);
      assert.deepEqual(completed.json, { account: SIGNED_IN_PRO });
      const changed = await events.next(eventNamed('account_changed'), 5000);
      assert.deepEqual(changed.data, { account: SIGNED_IN_PRO });
    } finally {
      events.close();
    }
    assert.deepEqual((await api.get('/api/account')).json, { account: SIGNED_IN_PRO, signInPending: false });
  });

  it('a code that is not an authorization code and a state is refused before the runtime is asked', async () => {
    assertError(await api.post('/api/account/login/code', { code: 'mock-code' }), 422, 'INVALID_ARGUMENT');
    assertError(await api.post('/api/account/login/code', { code: '#state' }), 422, 'INVALID_ARGUMENT');
    assertError(await api.post('/api/account/login/code', {}), 422, 'INVALID_ARGUMENT');
  });

  it('completing a sign-in that is not in progress conflicts', async () => {
    assertError(await api.post('/api/account/login/code', { code: 'mock-code#abc' }), 409, 'CONFLICT');
  });

  it('a wrong code leaves the sign-in open for another try, and the right code then completes it', async () => {
    const started = await api.post('/api/account/login', { method: 'console' });
    assert.equal(started.status, 200, started.text);
    assert.match(started.json.manualUrl, /^https:\/\/console-login\.example\.test\/oauth\/authorize\?/);
    const state = stateOf(started.json.manualUrl);
    assertError(await api.post('/api/account/login/code', { code: `wrong-code#${state}` }), 502, 'ENGINE_ERROR');
    assertError(await api.post('/api/account/login/code', { code: `mock-code#not-the-state` }), 502, 'ENGINE_ERROR');
    assert.equal((await api.get('/api/account')).json.signInPending, true);
    const completed = await api.post('/api/account/login/code', { code: `mock-code#${state}` });
    assert.equal(completed.status, 200, completed.text);
    assert.equal(completed.json.account.subscriptionType, 'Claude API');
    assert.equal((await api.get('/api/account')).json.account.subscriptionType, 'Claude API');
  });

  it('a sign-in for the other method replaces the flow in progress, so the old code no longer completes it',
    async () => {
      const first = await api.post('/api/account/login', { method: 'claudeai' });
      const second = await api.post('/api/account/login', { method: 'console' });
      const oldState = stateOf(first.json.manualUrl);
      const newState = stateOf(second.json.manualUrl);
      assert.notEqual(newState, oldState);
      assertError(await api.post('/api/account/login/code', { code: `mock-code#${oldState}` }), 502, 'ENGINE_ERROR');
      const completed = await api.post('/api/account/login/code', { code: `mock-code#${newState}` });
      assert.equal(completed.status, 200, completed.text);
      assert.equal(completed.json.account.subscriptionType, 'Claude API');
    });

  it('cancelling a sign-in abandons it: its code no longer completes it', async () => {
    const started = await api.post('/api/account/login', { method: 'claudeai' });
    const state = stateOf(started.json.manualUrl);
    assert.deepEqual((await api.del('/api/account/login')).json, { ok: true });
    assert.equal((await api.get('/api/account')).json.signInPending, false);
    assertError(await api.post('/api/account/login/code', { code: `mock-code#${state}` }), 409, 'CONFLICT');
    assert.deepEqual((await api.del('/api/account/login')).json, { ok: true }, 'cancelling again changes nothing');
  });

  it('a sign-in method other than claude.ai or console is refused before the runtime is asked', async () => {
    // The account module checks the method and answers 400 for any other value (the protocol names only the two).
    assertError(await api.post('/api/account/login', { method: 'github' }), 400, 'BAD_REQUEST');
    assertError(await api.post('/api/account/login', {}), 400, 'BAD_REQUEST');
    assert.equal((await api.get('/api/account')).json.signInPending, false, 'no sign-in was started');
  });
});

describe('sign-in to Claude Code needs the full access profile', { timeout: 120000 }, () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let server;
  /** @type {ReturnType<typeof client>} */
  let api;
  before(async () => {
    server = await startTestServer({ CAW_ACCESS_PROFILE: 'standard' });
    api = client(server.url);
    await api.login();
  });
  after(async () => {
    await server.close();
  });

  it('a standard profile reads the account, but cannot start, complete or cancel a sign-in', async () => {
    assert.equal((await api.get('/api/account')).status, 200);
    assertError(await api.post('/api/account/login', { method: 'claudeai' }), 403, 'FORBIDDEN');
    assertError(await api.post('/api/account/login/code', { code: 'mock-code#abc' }), 403, 'FORBIDDEN');
    assertError(await api.del('/api/account/login'), 403, 'FORBIDDEN');
  });
});

describe('a sign-in the runtime refuses, or answers without an https address', { timeout: 120000 }, () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let server;
  /** @type {ReturnType<typeof client>} */
  let api;
  before(async () => {
    server = await startTestServer({}, {
      wrapEngine: (engine) => ({
        ...engine,
        query: (args) => {
          const query = engine.query(args);
          query.claudeAuthenticate = async (/** @type {boolean} */ loginWithClaudeAi) => {
            if (loginWithClaudeAi) return { manualUrl: 'http://claude.ai/oauth/authorize', automaticUrl: null };
            throw new Error('Login blocked by managed settings.');
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

  it('an address that is not https is an engine error, and no sign-in is left in progress', async () => {
    assertError(await api.post('/api/account/login', { method: 'claudeai' }), 502, 'ENGINE_ERROR');
    assert.equal((await api.get('/api/account')).json.signInPending, false);
  });

  it('a policy refusal is forbidden, with the runtime\'s message', async () => {
    const refused = await api.post('/api/account/login', { method: 'console' });
    assertError(refused, 403, 'FORBIDDEN');
    assert.match(refused.json.error.message, /Login blocked/);
  });
});
