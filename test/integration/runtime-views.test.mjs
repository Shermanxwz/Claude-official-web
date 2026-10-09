/**
 * Integration tests: the read-only runtime views (GET /api/sessions/:id/runtime and /runtime/:view). Each view is the
 * answer of one runtime control, shaped the way the gateway documents it. A session that is not live, a view the query
 * does not offer and an unknown view are refused. The settings view never shows the values of an env block.
 */
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { RUNTIME_VIEWS } from '../../src/contracts.mjs';
import { assertError, client, createLive, runTurn, startTestServer } from './helpers.mjs';

/** The settings the user's files define for every test of this file. */
const USER_SETTINGS = {
  permissions: {
    allow: ['Bash(npm test:*)'],
    ask: ['Bash(git push:*)'],
    deny: ['Read(./.env)'],
    defaultMode: 'acceptEdits',
  },
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo before' }] }] },
  env: { API_TOKEN: 'secret-value' },
};

describe('runtime views', { timeout: 120000 }, () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let server;
  /** @type {ReturnType<typeof client>} */
  let api;
  before(async () => {
    server = await startTestServer({}, { resolvedSettings: USER_SETTINGS });
    api = client(server.url);
    await api.login();
  });
  after(async () => {
    await server.close();
  });

  it('lists every view the runtime offers, and each view answers with its documented shape', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const pathname = `/api/sessions/${live.sessionId}/runtime`;
    const listed = await api.get(pathname);
    assert.equal(listed.status, 200);
    assert.deepEqual(new Set(listed.json.views), new Set(Object.keys(RUNTIME_VIEWS)));

    const view = async (name) => {
      const res = await api.get(`${pathname}/${name}`);
      assert.equal(res.status, 200, `${name}: ${res.text}`);
      assert.equal(res.json.view, name);
      assert.equal(typeof res.json.fetchedAt, 'number');
      return res.json.data;
    };

    const status = await view('status');
    const sessionRow = status.sections.flatMap((section) => section.rows).find((row) => row.label === 'Session ID');
    assert.equal(sessionRow.value, live.sessionId);

    const permissions = await view('permissions');
    assert.equal(permissions.state.originalCwd, live.cwd);
    assert.deepEqual(permissions.state.rules.map((rule) => rule.behavior), ['ask', 'deny'],
      'an allow rule counts only in a folder the runtime trusts');
    assert.equal(permissions.state.managedOnly, false);

    const hooks = await view('hooks');
    assert.deepEqual(hooks.events.map((event) => event.name), ['PreToolUse']);
    assert.equal(hooks.hooks[0].displayText, 'echo before');

    const skills = await view('skills');
    assert.ok(skills.skills.some((skill) => skill.name === 'code-review'));

    const sandbox = await view('sandbox');
    assert.equal(sandbox.enabled, false);

    assert.deepEqual(await view('plan'), { exists: false });

    const usage = await view('usage');
    assert.equal(usage.subscription_type, 'pro');
    assert.equal(usage.rate_limits_available, true);

    const account = await view('account');
    assert.equal(account.email, 'demo@example.com');

    const init = await view('init');
    assert.equal(init.current_permission_mode, 'acceptEdits', 'the settings default decides the starting mode');
    assert.ok(init.commands.some((command) => command.name === 'compact'));

    const mcp = await view('mcp');
    const byName = Object.fromEntries(mcp.map((server) => [server.name, server.status]));
    assert.deepEqual(byName, { github: 'connected', filesystem: 'failed', 'mock-oauth': 'needs-auth' });

    const chrome = await view('chrome');
    assert.equal(chrome.enabled, false);
  });

  it('the settings view shows the settings the files define, with the values of env blocks redacted', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const res = await api.get(`/api/sessions/${live.sessionId}/runtime/settings`);
    assert.equal(res.status, 200);
    assert.equal(res.json.data.effective.env.API_TOKEN, '[redacted]');
    assert.equal(res.text.includes('secret-value'), false, 'the secret never leaves the gateway');
    assert.equal(res.json.data.effective.permissions.defaultMode, 'acceptEdits');
    assert.ok(res.json.data.applied, 'the applied values are part of the view');
  });

  it('a view the runtime does not know is not found, and a session that is not live refuses its views', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const pathname = `/api/sessions/${live.sessionId}/runtime`;
    assertError(await api.get(`${pathname}/unknown-view`), 404, 'NOT_FOUND');
    assert.equal((await api.post(`/api/sessions/${live.sessionId}/close`, {})).status, 200);
    assertError(await api.get(`${pathname}/status`), 409, 'SESSION_NOT_LIVE');
    assertError(await api.get(pathname), 409, 'SESSION_NOT_LIVE');
  });

  it('the permissions view lists the folder rules once the folder is trusted and the session is opened again',
    async () => {
      const live = await createLive(api, { cwd: server.proj });
      const events = await api.events({ watch: live.sessionId, after: 0 });
      try {
        // A session is stored once it has a message, so only a session with a turn can be opened again.
        await runTurn(api, events, live.sessionId, 'Tell me something');
      } finally {
        events.close();
      }
      const before = await api.get(`/api/sessions/${live.sessionId}/runtime/permissions`);
      assert.equal(before.json.data.state.rules.some((rule) => rule.behavior === 'allow'), false);
      const trusted = await api.post('/api/fs/trust', { path: server.proj, trusted: true });
      assert.equal(trusted.json.runtimeTrust, 'accepted');
      await api.post(`/api/sessions/${live.sessionId}/close`, {});
      assert.equal((await api.post(`/api/sessions/${live.sessionId}/open`, {})).status, 200);
      const after = await api.get(`/api/sessions/${live.sessionId}/runtime/permissions`);
      assert.ok(after.json.data.state.rules.some((rule) => rule.behavior === 'allow'
        && rule.rule === 'Bash(npm test:*)'));
      assert.equal((await api.post('/api/fs/trust', { path: server.proj, trusted: false })).json.runtimeTrust,
        'skipped');
    });
});

describe('runtime views the query does not offer', { timeout: 120000 }, () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let server;
  /** @type {ReturnType<typeof client>} */
  let api;
  before(async () => {
    // The runtime of this gateway has no status control: its view is left out and refused.
    server = await startTestServer({}, {
      wrapEngine: (engine) => ({
        ...engine,
        query: (args) => {
          const query = engine.query(args);
          delete query.getStatus;
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

  it('leaves the view out of the list and answers feature unavailable for it', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const listed = await api.get(`/api/sessions/${live.sessionId}/runtime`);
    assert.equal(listed.json.views.includes('status'), false);
    assert.ok(listed.json.views.includes('permissions'));
    assertError(await api.get(`/api/sessions/${live.sessionId}/runtime/status`), 501, 'FEATURE_UNAVAILABLE');
  });
});
