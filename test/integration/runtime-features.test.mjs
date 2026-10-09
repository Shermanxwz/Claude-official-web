/**
 * Integration tests: the runtime features the gateway drives through the SDK's own interfaces. Background tasks (Ctrl+B
 * and the counts they keep), output styles, plugin reloads that are held until forced, fast mode, and the thinking
 * summaries the settings overlay asks for. Each test talks to a real gateway whose engine is the deterministic mock,
 * which answers these features the way the runtime does.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it, before, after } from 'node:test';
import {
  assertError,
  client,
  createLive,
  runTurn,
  sdkMessagesOf,
  startTestServer,
  turnResult,
} from './helpers.mjs';

const THINKING_SUMMARY = 'The request is simple, so I will answer it directly.';

/**
 * A predicate over the SDK messages of one session.
 * @param {string} sessionId
 * @param {(msg: any) => boolean} predicate
 */
function sdkWhere(sessionId, predicate) {
  return (/** @type {any} */ frame) => frame.event === 'sdk' && frame.data?.sessionId === sessionId
    && predicate(frame.data.msg);
}

/**
 * @param {any} msg
 * @param {string} subtype
 */
function systemOf(msg, subtype) {
  return msg.type === 'system' && msg.subtype === subtype;
}

/** @param {any} msg */
function callsTool(msg) {
  return msg.type === 'assistant' && msg.message.content.some((block) => block.type === 'tool_use');
}

/**
 * The text of the first thinking block of the messages, or null when there is none.
 * @param {any[]} messages
 */
function thinkingTextOf(messages) {
  const block = messages
    .filter((msg) => msg.type === 'assistant')
    .flatMap((msg) => msg.message.content)
    .find((item) => item.type === 'thinking');
  return block ? block.thinking : null;
}

describe('runtime: background tasks', { timeout: 120000 }, () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let server;
  /** @type {ReturnType<typeof client>} */
  let api;
  before(async () => {
    // A command waits up to 5 s for the move, so a slow test machine cannot miss it; once moved it runs for 1.5 s, long
    // enough to read the count while it runs.
    server = await startTestServer({}, { backgroundTiming: { waitMs: 5000, runMs: 1500 } });
    api = client(server.url);
    await api.login();
  });
  after(async () => {
    await server.close();
  });

  it('advertises background tasks in meta, and moves nothing while no command runs', async () => {
    assert.equal((await api.get('/api/meta')).json.features.backgroundTasks, true);
    const live = await createLive(api, { cwd: server.proj });
    const pathname = `/api/sessions/${live.sessionId}/background`;
    assert.deepEqual((await api.post(pathname, {})).json, { backgrounded: false });
    assertError(await api.post(pathname, { toolUseId: 'not valid' }), 400, 'BAD_REQUEST');
  });

  it('moves a running build to the background, counts it while it runs and clears the count when it completes',
    async () => {
      const live = await createLive(api, { cwd: server.proj });
      const sessionId = live.sessionId;
      const events = await api.events({ watch: sessionId, after: 0 });
      try {
        const clientMessageId = randomUUID();
        const accepted = await api.post(`/api/sessions/${sessionId}/messages`, {
          clientMessageId,
          text: 'start a background build',
        });
        assert.equal(accepted.status, 200);
        const call = await events.next(sdkWhere(sessionId, callsTool), 5000);
        const toolUse = call.data.msg.message.content.find((block) => block.type === 'tool_use');
        const moved = await api.post(`/api/sessions/${sessionId}/background`, { toolUseId: toolUse.id });
        assert.deepEqual(moved.json, { backgrounded: true });

        const listed = await events.next(sdkWhere(sessionId, (msg) => systemOf(msg, 'background_tasks_changed')
          && msg.tasks.length === 1), 5000);
        const taskId = listed.data.msg.tasks[0].task_id;
        assert.equal((await api.get(`/api/sessions/${sessionId}`)).json.live.backgroundTasks, 1);

        const finished = await events.next(turnResult(sessionId, clientMessageId), 5000);
        assert.equal(finished.data.msg.subtype, 'success');
        const notice = await events.next(sdkWhere(sessionId, (msg) => systemOf(msg, 'task_notification')), 5000);
        assert.equal(notice.data.msg.task_id, taskId);
        assert.equal(notice.data.msg.status, 'completed');
        await events.next(sdkWhere(sessionId, (msg) => systemOf(msg, 'background_tasks_changed')
          && msg.tasks.length === 0), 5000);
        assert.equal((await api.get(`/api/sessions/${sessionId}`)).json.live.backgroundTasks, 0);
        assert.deepEqual((await api.post(`/api/sessions/${sessionId}/background`, {})).json, { backgrounded: false });
      } finally {
        events.close();
      }
    });
});

describe('runtime: background tasks switched off', { timeout: 120000 }, () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let server;
  /** @type {ReturnType<typeof client>} */
  let api;
  before(async () => {
    server = await startTestServer({ CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' },
      { backgroundTiming: { waitMs: 50, runMs: 300 } });
    api = client(server.url);
    await api.login();
  });
  after(async () => {
    await server.close();
  });

  it('advertises the feature as off in meta, and refuses a move with 501 FEATURE_DISABLED', async () => {
    assert.equal((await api.get('/api/meta')).json.features.backgroundTasks, false);
    const live = await createLive(api, { cwd: server.proj });
    assertError(await api.post(`/api/sessions/${live.sessionId}/background`, {}), 501, 'FEATURE_DISABLED');
  });

  it('runs a build in the foreground, where no task is ever started or counted', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const sessionId = live.sessionId;
    const events = await api.events({ watch: sessionId, after: 0 });
    try {
      const { result } = await runTurn(api, events, sessionId, 'start a background build');
      assert.equal(result.subtype, 'success');
      const messages = sdkMessagesOf(events, sessionId);
      assert.equal(messages.some((msg) => systemOf(msg, 'task_started')), false);
      assert.equal(messages.some((msg) => systemOf(msg, 'background_tasks_changed')), false);
      assert.equal((await api.get(`/api/sessions/${sessionId}`)).json.live.backgroundTasks, 0);
    } finally {
      events.close();
    }
  });
});

describe('runtime: output styles', { timeout: 120000 }, () => {
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

  it('refuses a style change in a folder that is not trusted, with 409 CONFLICT', async () => {
    const live = await createLive(api, { cwd: server.proj });
    assert.equal(live.trusted, false);
    assertError(await api.post(`/api/sessions/${live.sessionId}/output-style`, { style: 'Learning' }), 409, 'CONFLICT');
  });

  it('changes the style of a trusted folder for its session, and refuses a style the session does not offer',
    async () => {
      assert.equal((await api.post('/api/fs/trust', { path: server.proj, trusted: true })).status, 200);
      const live = await createLive(api, { cwd: server.proj });
      assert.equal(live.trusted, true);
      const pathname = `/api/sessions/${live.sessionId}/output-style`;
      assert.deepEqual((await api.post(pathname, { style: 'Learning' })).json, {
        outputStyle: 'Learning',
        availableOutputStyles: ['default', 'Proactive', 'Concise', 'Explanatory', 'Learning'],
      });
      assert.equal((await api.get(`/api/sessions/${live.sessionId}/capabilities`)).json.outputStyle, 'Learning');
      assertError(await api.post(pathname, { style: 'poetic' }), 422, 'INVALID_ARGUMENT');
      assertError(await api.post(pathname, { style: '   ' }), 400, 'BAD_REQUEST');
    });
});

describe('runtime: plugin reloads', { timeout: 120000 }, () => {
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

  it('holds a reload that would change the tools until it is forced, and a reload with nothing pending applies at once',
    async () => {
      const live = await createLive(api, { cwd: server.proj });
      const sessionId = live.sessionId;
      const pathname = `/api/sessions/${sessionId}/reload`;
      const plugin = async () => (await api.get(`/api/sessions/${sessionId}/capabilities`)).json.mcpServers
        .find((item) => item.name === 'plugin:demo-plugin:docs');
      const events = await api.events({ watch: sessionId, after: 0 });
      try {
        const { result } = await runTurn(api, events, sessionId, 'install the plugin');
        assert.equal(result.subtype, 'success');

        assert.deepEqual((await api.post(pathname, { what: 'plugins' })).json, {
          ok: false,
          held: true,
          cacheImpact: { mcpServersAdded: ['plugin:demo-plugin:docs'], mcpServersRemoved: [], lspToolChange: null },
        });
        assert.equal(await plugin(), undefined, 'a held reload leaves the tools as they were');

        assert.deepEqual((await api.post(pathname, { what: 'plugins', force: true })).json, { ok: true });
        assert.equal((await plugin()).status, 'connected');
        assert.deepEqual((await api.post(pathname, { what: 'plugins' })).json, { ok: true });
      } finally {
        events.close();
      }
    });

  it('refuses force for any target but plugins', async () => {
    const live = await createLive(api, { cwd: server.proj });
    assertError(await api.post(`/api/sessions/${live.sessionId}/reload`, { what: 'skills', force: true }),
      400, 'BAD_REQUEST');
  });
});

describe('runtime: fast mode', { timeout: 120000 }, () => {
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

  it('reports fast mode as opted out until the host sets it, and follows the requested state', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const sessionId = live.sessionId;
    const pathname = `/api/sessions/${sessionId}/settings`;
    const liveState = async () => {
      const info = (await api.get(`/api/sessions/${sessionId}`)).json.live;
      return { requested: info.fastMode, state: info.fastModeState, reason: info.fastModeDisabledReason };
    };
    const events = await api.events({ watch: sessionId, after: 0 });
    try {
      await runTurn(api, events, sessionId, 'Tell me something');
      assert.deepEqual(await liveState(), { requested: null, state: 'off', reason: 'sdk_opt_in_required' });

      assert.equal((await api.post(pathname, { fastMode: true })).json.live.fastMode, true);
      await runTurn(api, events, sessionId, 'Tell me something');
      assert.deepEqual(await liveState(), { requested: true, state: 'off', reason: 'model_not_allowed' });

      await api.post(pathname, { model: 'claude-opus-mock' });
      await runTurn(api, events, sessionId, 'Tell me something');
      assert.deepEqual(await liveState(), { requested: true, state: 'on', reason: null });

      await api.post(pathname, { fastMode: false });
      await runTurn(api, events, sessionId, 'Tell me something');
      assert.deepEqual(await liveState(), { requested: false, state: 'off', reason: null });

      await api.post(pathname, { fastMode: null });
      await runTurn(api, events, sessionId, 'Tell me something');
      assert.deepEqual(await liveState(), { requested: null, state: 'off', reason: 'sdk_opt_in_required' });

      assertError(await api.post(pathname, { fastMode: 'yes' }), 422, 'INVALID_ARGUMENT');
    } finally {
      events.close();
    }
  });
});

describe('runtime: thinking summaries', { timeout: 120000 }, () => {
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

  it('asks for thinking summaries when the settings files do not turn them off', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const events = await api.events({ watch: live.sessionId, after: 0 });
    try {
      await runTurn(api, events, live.sessionId, 'think it through first');
      assert.equal(thinkingTextOf(sdkMessagesOf(events, live.sessionId)), THINKING_SUMMARY);
    } finally {
      events.close();
    }
  });

  it('honors settings files that turn thinking summaries off', async () => {
    const files = await startTestServer({}, {
      wrapEngine: (engine) => ({
        ...engine,
        resolveSettings: async () => ({ effective: { showThinkingSummaries: false }, provenance: {}, sources: [] }),
      }),
    });
    try {
      const api2 = client(files.url);
      await api2.login();
      const live = await createLive(api2, { cwd: files.proj });
      const events = await api2.events({ watch: live.sessionId, after: 0 });
      try {
        await runTurn(api2, events, live.sessionId, 'think it through first');
        assert.equal(thinkingTextOf(sdkMessagesOf(events, live.sessionId)), '');
      } finally {
        events.close();
      }
    } finally {
      await files.close();
    }
  });

  it('still asks for thinking summaries when the settings lookup fails', async () => {
    const broken = await startTestServer({}, {
      wrapEngine: (engine) => ({
        ...engine,
        resolveSettings: async () => {
          throw new Error('settings unreadable');
        },
      }),
    });
    try {
      const api2 = client(broken.url);
      await api2.login();
      const live = await createLive(api2, { cwd: broken.proj });
      const events = await api2.events({ watch: live.sessionId, after: 0 });
      try {
        await runTurn(api2, events, live.sessionId, 'think it through first');
        assert.equal(thinkingTextOf(sdkMessagesOf(events, live.sessionId)), THINKING_SUMMARY);
      } finally {
        events.close();
      }
    } finally {
      await broken.close();
    }
  });
});
