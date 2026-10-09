/**
 * Integration tests: the controls of a live session (settings, interrupt, slash commands, MCP servers, reload,
 * capabilities, context usage, rewind, subagents and task stops). Each test talks to a real gateway whose engine is the
 * deterministic mock.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it, before, after } from 'node:test';
import {
  assertError,
  client,
  createLive,
  runTurn,
  sdkMessage,
  sdkMessagesOf,
  startTestServer,
  turnResult,
} from './helpers.mjs';

/**
 * @param {ReturnType<typeof client>} api
 * @param {string} sessionId
 * @returns {Promise<any[]>} the stored transcript, oldest first
 */
async function transcriptOf(api, sessionId) {
  return (await api.get(`/api/sessions/${sessionId}/messages?tail=1000`)).json.messages;
}

describe('controls: settings', { timeout: 120000 }, () => {
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

  it('applies model, effort and permission mode to a live session at once, and clears them with null', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const sessionId = live.sessionId;
    const changed = await api.post(`/api/sessions/${sessionId}/settings`, {
      model: 'claude-opus-mock',
      effort: 'high',
      permissionMode: 'acceptEdits',
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.json.live.model, 'claude-opus-mock');
    assert.equal(changed.json.live.effort, 'high');
    assert.equal(changed.json.live.permissionMode, 'acceptEdits');
    const detail = (await api.get(`/api/sessions/${sessionId}`)).json.live;
    assert.equal(detail.model, 'claude-opus-mock');
    assert.equal(detail.effort, 'high');
    assert.equal(detail.permissionMode, 'acceptEdits');

    const cleared = await api.post(`/api/sessions/${sessionId}/settings`, { effort: null, model: null });
    assert.equal(cleared.json.live.effort, null);
    assert.equal(cleared.json.live.model, null);
  });

  it('refuses invalid settings: unknown enums are 422 INVALID_ARGUMENT, wrong types are 400 BAD_REQUEST', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const pathname = `/api/sessions/${live.sessionId}/settings`;
    assertError(await api.post(pathname, { permissionMode: 'turbo' }), 422, 'INVALID_ARGUMENT');
    assertError(await api.post(pathname, { effort: 'extreme' }), 422, 'INVALID_ARGUMENT');
    assertError(await api.post(pathname, { model: '' }), 400, 'BAD_REQUEST');
    assertError(await api.post(pathname, { model: 42 }), 400, 'BAD_REQUEST');
    assert.equal((await api.post(pathname, { effort: 'xhigh' })).json.live.effort, 'xhigh');
  });

  it('remembers settings sent to a closed session and applies them when it opens', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const sessionId = live.sessionId;
    const events = await api.events({ watch: sessionId, after: 0 });
    try {
      await runTurn(api, events, sessionId, 'Persist the session');
    } finally {
      events.close();
    }
    assert.deepEqual((await api.post(`/api/sessions/${sessionId}/close`)).json, { ok: true });
    const remembered = await api.post(`/api/sessions/${sessionId}/settings`, {
      model: 'remembered-model',
      effort: 'low',
      permissionMode: 'acceptEdits',
    });
    assert.equal(remembered.status, 200);
    assert.equal(remembered.json.live, null, 'a closed session has no live state to report');

    const opened = await api.post(`/api/sessions/${sessionId}/open`, {});
    assert.equal(opened.json.live.model, 'remembered-model');
    assert.equal(opened.json.live.effort, 'low');
    assert.equal(opened.json.live.permissionMode, 'acceptEdits');
    await api.post(`/api/sessions/${sessionId}/close`);

    const explicit = await api.post(`/api/sessions/${sessionId}/open`, { effort: 'max' });
    assert.equal(explicit.json.live.effort, 'max', 'settings given to open win over the remembered ones');
    assert.equal(explicit.json.live.model, 'remembered-model', 'the others are still remembered');
  });

  it('applies settings given to open to a session that is already live', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const opened = await api.post(`/api/sessions/${live.sessionId}/open`, { model: 'opened-model' });
    assert.equal(opened.status, 200);
    assert.equal(opened.json.live.sessionId, live.sessionId);
    assert.equal(opened.json.live.model, 'opened-model');
  });
});

describe('controls: turns and slash commands', { timeout: 120000 }, () => {
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

  it('answers /context and /usage as local command output, and /context reports the live query', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const sessionId = live.sessionId;
    const events = await api.events({ watch: sessionId, after: 0 });
    try {
      await runTurn(api, events, sessionId, '/context');
      const output = sdkMessagesOf(events, sessionId).filter((msg) => msg.type === 'system'
        && msg.subtype === 'local_command_output');
      assert.equal(output.length, 1);
      assert.match(JSON.stringify(output[0]), /context/i);

      await runTurn(api, events, sessionId, '/usage');
      const usage = sdkMessagesOf(events, sessionId).filter((msg) => msg.type === 'system'
        && msg.subtype === 'local_command_output');
      assert.equal(usage.length, 2);

      const context = await api.get(`/api/sessions/${sessionId}/context`);
      assert.equal(context.status, 200);
      assert.ok(Array.isArray(context.json.categories));
      assert.ok(context.json.categories.length > 0);
      assert.ok(context.json.categories.every((item) => typeof item.name === 'string'
        && typeof item.tokens === 'number'));
    } finally {
      events.close();
    }
  });

  it('runs /compact with a status and a compact boundary, and keeps the boundary in the transcript', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const sessionId = live.sessionId;
    const events = await api.events({ watch: sessionId, after: 0 });
    try {
      await runTurn(api, events, sessionId, 'Give me some history first');
      await runTurn(api, events, sessionId, '/compact');
      const messages = sdkMessagesOf(events, sessionId);
      const boundary = messages.find((msg) => msg.type === 'system' && msg.subtype === 'compact_boundary');
      assert.ok(boundary, 'the turn reports a compact boundary');
      assert.ok(messages.some((msg) => msg.type === 'system' && msg.subtype === 'status'
        && msg.status === 'compacting'));
      const stored = await transcriptOf(api, sessionId);
      assert.ok(stored.some((msg) => msg.type === 'system'), 'the boundary is stored with the transcript');
    } finally {
      events.close();
    }
  });

  it('runs /clear as a conversation reset that is kept in the transcript', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const sessionId = live.sessionId;
    const events = await api.events({ watch: sessionId, after: 0 });
    try {
      await runTurn(api, events, sessionId, 'Something to forget');
      await runTurn(api, events, sessionId, '/clear');
      assert.ok(sdkMessagesOf(events, sessionId).some((msg) => msg.type === 'conversation_reset'));
      const stored = await transcriptOf(api, sessionId);
      assert.equal(stored.at(-1).type, 'system', 'the reset is the last entry of the transcript');
    } finally {
      events.close();
    }
  });

  it('ends a failing turn with an error result, and the session stays open for the next message', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const sessionId = live.sessionId;
    const events = await api.events({ watch: sessionId, after: 0 });
    try {
      const failed = await runTurn(api, events, sessionId, 'Trigger an error');
      assert.equal(failed.result.type, 'result');
      assert.equal(failed.result.subtype, 'error_during_execution');
      assert.equal(failed.result.is_error, true);
      const state = (await api.get(`/api/sessions/${sessionId}`)).json.live;
      assert.ok(state, 'the query is still open');
      assert.equal(state.state, 'idle');
      const next = await runTurn(api, events, sessionId, 'A turn after the failure');
      assert.equal(next.result.subtype, 'success');
    } finally {
      events.close();
    }
  });

  it('answers 200 for an interrupt that has nothing to stop, and 200 for a session that is not open', async () => {
    const live = await createLive(api, { cwd: server.proj });
    assert.deepEqual((await api.post(`/api/sessions/${live.sessionId}/interrupt`)).json, { ok: true });
    assert.deepEqual((await api.post(`/api/sessions/${randomUUID()}/interrupt`)).json, { ok: true });
  });

  it('reports the subagents of a session and their transcripts, and refuses malformed agent ids', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const sessionId = live.sessionId;
    const events = await api.events({ watch: sessionId, after: 0 });
    try {
      await runTurn(api, events, sessionId, 'Ask an agent to explore');
      const listed = (await api.get(`/api/sessions/${sessionId}/subagents`)).json;
      assert.equal(listed.agents.length, 1);
      const [agentId] = listed.agents;
      const transcript = (await api.get(`/api/sessions/${sessionId}/subagents/${agentId}/messages`)).json;
      assert.ok(transcript.messages.length > 0);
      assert.ok(transcript.messages.every((msg) => msg.parent_tool_use_id !== undefined || msg.type !== undefined));
      assertError(await api.get(`/api/sessions/${sessionId}/subagents/bad%20id/messages`), 400, 'BAD_REQUEST');
    } finally {
      events.close();
    }
  });

  it('accepts a task stop for a task the session does not run', async () => {
    const live = await createLive(api, { cwd: server.proj });
    assert.deepEqual((await api.post(`/api/sessions/${live.sessionId}/tasks/task-none/stop`)).json, { ok: true });
    assertError(await api.post(`/api/sessions/${live.sessionId}/tasks/bad%20id/stop`), 400, 'BAD_REQUEST');
  });
});

describe('controls: capabilities, MCP and reload', { timeout: 120000 }, () => {
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

  it('describes a live session with fresh capabilities: commands, models, agents and MCP servers', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const res = await api.get(`/api/sessions/${live.sessionId}/capabilities`);
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.json).sort(), ['account', 'agents', 'availableOutputStyles', 'commands',
      'mcpServers', 'models', 'outputStyle', 'stale']);
    assert.equal(res.json.stale, false);
    assert.ok(res.json.commands.length > 0);
    assert.ok(res.json.models.length > 0);
    assert.ok(res.json.agents.length > 0);
    assert.ok(res.json.mcpServers.some((server) => server.name === 'github'));
    assert.ok(Array.isArray(res.json.availableOutputStyles));
  });

  it('keeps the last capabilities of a folder for a closed session, marked stale', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const events = await api.events({ watch: live.sessionId, after: 0 });
    try {
      await runTurn(api, events, live.sessionId, 'Remember the capabilities');
    } finally {
      events.close();
    }
    const fresh = (await api.get(`/api/sessions/${live.sessionId}/capabilities`)).json;
    assert.equal(fresh.stale, false);
    assert.equal((await api.post(`/api/sessions/${live.sessionId}/close`)).status, 200);
    const stale = (await api.get(`/api/sessions/${live.sessionId}/capabilities`)).json;
    assert.equal(stale.stale, true);
    assert.deepEqual(stale.commands, fresh.commands);
  });

  it('switches an MCP server off, reconnects it and switches it on again', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const pathname = `/api/sessions/${live.sessionId}/mcp`;
    const off = await api.post(pathname, { server: 'github', action: 'toggle', enabled: false });
    assert.equal(off.status, 200);
    assert.equal(off.json.mcpServers.find((item) => item.name === 'github').status, 'disabled');
    assertError(await api.post(pathname, { server: 'github', action: 'reconnect' }), 502, 'ENGINE_ERROR');
    const on = await api.post(pathname, { server: 'github', action: 'toggle', enabled: true });
    assert.equal(on.json.mcpServers.find((item) => item.name === 'github').status, 'connected');
    const reconnected = await api.post(pathname, { server: 'github', action: 'reconnect' });
    assert.equal(reconnected.json.mcpServers.find((item) => item.name === 'github').status, 'connected');
    const failing = await api.post(pathname, { server: 'filesystem', action: 'reconnect' });
    const filesystem = failing.json.mcpServers.find((item) => item.name === 'filesystem');
    assert.equal(filesystem.status, 'failed');
    assert.equal(typeof filesystem.error, 'string');
  });

  it('refuses malformed MCP requests and answers 502 ENGINE_ERROR for a server the session does not know', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const pathname = `/api/sessions/${live.sessionId}/mcp`;
    assertError(await api.post(pathname, { server: 'github', action: 'restart' }), 422, 'INVALID_ARGUMENT');
    assertError(await api.post(pathname, { server: '', action: 'reconnect' }), 400, 'BAD_REQUEST');
    assertError(await api.post(pathname, { server: 'github', action: 'toggle', enabled: 'yes' }), 400,
      'BAD_REQUEST');
    assertError(await api.post(pathname, { server: 'no-such-server', action: 'toggle', enabled: true }), 502,
      'ENGINE_ERROR');
  });

  it('reloads plugins and skills of a live session, and refuses any other target', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const pathname = `/api/sessions/${live.sessionId}/reload`;
    assert.deepEqual((await api.post(pathname, { what: 'plugins' })).json, { ok: true });
    assert.deepEqual((await api.post(pathname, { what: 'skills' })).json, { ok: true });
    assertError(await api.post(pathname, { what: 'hooks' }), 422, 'INVALID_ARGUMENT');
  });
});

describe('controls: rewind', { timeout: 120000 }, () => {
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

  /**
   * Starts a session with three turns. Returns the ids of its three user messages.
   */
  async function threeTurns() {
    const live = await createLive(api, { cwd: server.proj });
    const events = await api.events({ watch: live.sessionId, after: 0 });
    try {
      const first = await runTurn(api, events, live.sessionId, 'First rewind turn');
      const second = await runTurn(api, events, live.sessionId, 'Second rewind turn');
      const third = await runTurn(api, events, live.sessionId, 'Third rewind turn');
      return { sessionId: live.sessionId, events, ids: [first, second, third].map((turn) => turn.clientMessageId) };
    } catch (error) {
      events.close();
      throw error;
    }
  }

  it('rewinds the files in code mode: a dry run reports the change and changes nothing', async () => {
    const { sessionId, events, ids } = await threeTurns();
    try {
      const before = await transcriptOf(api, sessionId);
      const dry = await api.post(`/api/sessions/${sessionId}/rewind`, {
        userMessageId: ids[1],
        mode: 'code',
        dryRun: true,
      });
      assert.equal(dry.status, 200);
      assert.deepEqual(Object.keys(dry.json), ['files']);
      assert.deepEqual(dry.json.files, { canRewind: true, filesChanged: ['src/app.js'], insertions: 3, deletions: 1 });
      assert.equal((await transcriptOf(api, sessionId)).length, before.length);

      const real = await api.post(`/api/sessions/${sessionId}/rewind`, { userMessageId: ids[1], mode: 'code' });
      assert.deepEqual(real.json.files, dry.json.files);
      assert.equal((await transcriptOf(api, sessionId)).length, before.length, 'code mode leaves the conversation');
    } finally {
      events.close();
    }
  });

  it('opens a closed session when a code rewind needs its query', async () => {
    const { sessionId, events, ids } = await threeTurns();
    try {
      assert.equal((await api.post(`/api/sessions/${sessionId}/close`)).status, 200);
      const rewound = await api.post(`/api/sessions/${sessionId}/rewind`, {
        userMessageId: ids[1],
        mode: 'code',
        dryRun: true,
      });
      assert.equal(rewound.status, 200);
      assert.equal(rewound.json.files.canRewind, true);
      assert.equal((await api.get(`/api/sessions/${sessionId}`)).json.live.sessionId, sessionId);
    } finally {
      events.close();
    }
  });

  it('refuses a code rewind to an unknown message with 422 CANNOT_REWIND, and an unknown mode', async () => {
    const { sessionId, events } = await threeTurns();
    try {
      const pathname = `/api/sessions/${sessionId}/rewind`;
      assertError(await api.post(pathname, { userMessageId: randomUUID(), mode: 'code' }), 422, 'CANNOT_REWIND');
      assertError(await api.post(pathname, { userMessageId: randomUUID(), mode: 'sideways' }), 422,
        'INVALID_ARGUMENT');
      assertError(await api.post(pathname, { mode: 'code' }), 400, 'BAD_REQUEST');
    } finally {
      events.close();
    }
  });

  it('rewinds the conversation to just before a message, and the later turns leave the transcript', async () => {
    const { sessionId, events, ids } = await threeTurns();
    try {
      const before = await transcriptOf(api, sessionId);
      const target = before.findIndex((message) => message.uuid === ids[1]);
      assert.ok(target > 0, 'the second message is in the transcript');
      const dry = await api.post(`/api/sessions/${sessionId}/rewind`, {
        userMessageId: ids[1],
        mode: 'conversation',
        dryRun: true,
      });
      assert.deepEqual(Object.keys(dry.json), ['conversation']);
      assert.equal(dry.json.conversation.resumeAt, before[target - 1].uuid);
      assert.equal((await transcriptOf(api, sessionId)).length, before.length, 'a dry run changes nothing');

      const real = await api.post(`/api/sessions/${sessionId}/rewind`, { userMessageId: ids[1], mode: 'conversation' });
      assert.equal(real.status, 200);
      assert.deepEqual(real.json, { conversation: { resumeAt: before[target - 1].uuid } });
      const after = await transcriptOf(api, sessionId);
      assert.equal(after.length, target, 'the transcript now ends just before the rewound message');
      assert.ok(!after.some((message) => message.uuid === ids[1]));
      assert.equal((await api.get(`/api/sessions/${sessionId}`)).json.live.sessionId, sessionId);

      const next = await runTurn(api, events, sessionId, 'A turn after the rewind');
      assert.equal(next.result.subtype, 'success');
    } finally {
      events.close();
    }
  });

  it('refuses a conversation rewind to the first message or to an assistant message', async () => {
    const { sessionId, events, ids } = await threeTurns();
    try {
      const transcript = await transcriptOf(api, sessionId);
      const assistant = transcript.find((message) => message.type === 'assistant');
      const pathname = `/api/sessions/${sessionId}/rewind`;
      assertError(await api.post(pathname, { userMessageId: ids[0], mode: 'conversation' }), 422, 'CANNOT_REWIND');
      assertError(await api.post(pathname, { userMessageId: assistant.uuid, mode: 'conversation' }), 422,
        'CANNOT_REWIND');
      assert.equal((await transcriptOf(api, sessionId)).length, transcript.length, 'nothing changed');
    } finally {
      events.close();
    }
  });

  it('rewinds both files and conversation in one call', async () => {
    const { sessionId, events, ids } = await threeTurns();
    try {
      const both = await api.post(`/api/sessions/${sessionId}/rewind`, { userMessageId: ids[2], mode: 'both' });
      assert.equal(both.status, 200);
      assert.deepEqual(Object.keys(both.json).sort(), ['conversation', 'files']);
      assert.equal(both.json.files.canRewind, true);
      assert.equal(typeof both.json.conversation.resumeAt, 'string');
    } finally {
      events.close();
    }
  });
});

describe('controls: interrupt', { timeout: 120000 }, () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let server;
  /** @type {ReturnType<typeof client>} */
  let api;
  before(async () => {
    // The paced mock writes the long "slow" answer slowly enough to interrupt it in the middle.
    server = await startTestServer({ CAW_MOCK_DELAY_MS: '40' });
    api = client(server.url);
    await api.login();
  });
  after(async () => {
    await server.close();
  });

  it('stops a running turn in the middle of its answer and leaves the session ready for the next message', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const sessionId = live.sessionId;
    const events = await api.events({ watch: sessionId, after: 0 });
    try {
      const clientMessageId = randomUUID();
      await api.post(`/api/sessions/${sessionId}/messages`, { clientMessageId, text: 'Write something slow' });
      await events.next(sdkMessage(sessionId, 'stream_event'), 5000);
      const started = Date.now();
      assert.deepEqual((await api.post(`/api/sessions/${sessionId}/interrupt`)).json, { ok: true });
      const finished = await events.next(turnResult(sessionId, clientMessageId), 5000);
      assert.equal(finished.data.msg.type, 'result');
      assert.ok(Date.now() - started < 3000, 'the turn stopped well before its paced end');
      const deadline = Date.now() + 5000;
      while ((await api.get(`/api/sessions/${sessionId}`)).json.live.state !== 'idle') {
        assert.ok(Date.now() < deadline, 'the session returned to idle');
        await new Promise((resolve) => {
          setTimeout(resolve, 10);
        });
      }
      const next = await api.post(`/api/sessions/${sessionId}/messages`, {
        clientMessageId: randomUUID(),
        text: '/usage',
      });
      assert.equal(next.status, 200);
      assert.equal(next.json.duplicate, false);
    } finally {
      events.close();
    }
  });
});
