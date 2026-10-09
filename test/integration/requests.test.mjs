/**
 * Integration tests: pending requests (permission, question, plan and MCP elicitation) from the moment the engine asks
 * until the browser answers, including validation, cancellation and the answer each kind hands back to the engine.
 * The engine is wrapped so that the test can read the exact result the gateway returns to canUseTool.
 */
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it, before, after } from 'node:test';
import {
  assertError,
  client,
  createLive,
  eventNamed,
  sdkMessagesOf,
  startTestServer,
  turnResult,
} from './helpers.mjs';

/**
 * Records every result the gateway returns to canUseTool, keyed by the request id the engine was given.
 * @param {Array<{requestId: string|undefined, result: any}>} recorded
 */
function recordingEngine(recorded) {
  return (engine) => ({
    ...engine,
    query(args) {
      const options = { ...args.options };
      const ask = options.canUseTool;
      if (typeof ask === 'function') {
        options.canUseTool = async (toolName, input, context) => {
          const result = await ask(toolName, input, context);
          recorded.push({ requestId: context?.requestId, result });
          return result;
        };
      }
      return engine.query({ ...args, options });
    },
  });
}

/** @param {unknown[]} messages the SDK messages of a session */
function textOf(messages) {
  return messages
    .filter((message) => message.type === 'assistant')
    .flatMap((message) => (message.message?.content ?? []).filter((block) => block.type === 'text'))
    .map((block) => block.text)
    .join('\n');
}

/**
 * Sends one message and returns its clientMessageId, without waiting for the turn.
 * @param {ReturnType<typeof client>} api
 * @param {string} sessionId
 * @param {string} text
 */
async function send(api, sessionId, text) {
  const clientMessageId = randomUUID();
  const res = await api.post(`/api/sessions/${sessionId}/messages`, { clientMessageId, text });
  assert.equal(res.status, 200, res.text);
  return clientMessageId;
}

/**
 * Waits for the next pending request of a session that arrives after `mark`.
 * @param {any} events stream of the test
 * @param {string} sessionId
 * @param {number} mark value of events.count() before the message was sent
 * @param {string} [kind]
 * @returns {Promise<any>} the PendingRequest
 */
async function nextRequest(events, sessionId, mark, kind) {
  const frame = await events.next((item) => item.event === 'request' && item.data.request.sessionId === sessionId
    && (kind === undefined || item.data.request.kind === kind), 5000, { from: mark });
  return frame.data.request;
}

describe('requests', { timeout: 120000 }, () => {
  /** @type {Array<{requestId: string|undefined, result: any}>} */
  const recorded = [];
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let server;
  /** @type {ReturnType<typeof client>} */
  let api;
  before(async () => {
    server = await startTestServer({}, { wrapEngine: recordingEngine(recorded) });
    api = client(server.url);
    await api.login();
  });
  after(async () => {
    await server.close();
  });

  /**
   * @param {string} requestId the id of the pending request the answer was given for
   * @returns {any} the result the gateway gave the engine for that request
   */
  function answeredWith(requestId) {
    const entries = recorded.filter((item) => item.requestId === requestId);
    assert.equal(entries.length, 1, `expected one recorded answer for request ${requestId}`);
    return entries[0].result;
  }

  /**
   * Opens a session and a stream that watches it.
   * @returns {Promise<{sessionId: string, events: any}>}
   */
  async function openWatched() {
    const live = await createLive(api, { cwd: server.proj });
    const events = await api.events({ watch: live.sessionId, after: 0 });
    return { sessionId: live.sessionId, events };
  }

  it('pauses a tool call until the browser allows it, and shows the request to every client', async () => {
    const { sessionId, events } = await openWatched();
    const everyone = await api.events({ after: 0 });
    try {
      const mark = events.count();
      const clientMessageId = await send(api, sessionId, 'Please run a tool');
      const request = await nextRequest(events, sessionId, mark, 'permission');
      const globalRequest = await everyone.next((item) => item.event === 'request'
        && item.data.request.id === request.id);
      assert.equal(globalRequest.data.request.sessionId, sessionId);

      assert.equal(request.toolName, 'Bash');
      assert.deepEqual(request.input, { command: 'ls -la', description: 'List project files' });
      assert.equal(request.title, 'Claude wants to run ls -la');
      assert.equal(request.displayName, 'Run command');
      assert.equal(typeof request.toolUseId, 'string');
      assert.equal(request.suggestions.length, 2);
      assert.equal(typeof request.createdAt, 'number');

      const waiting = (await api.get(`/api/sessions/${sessionId}`)).json;
      assert.equal(waiting.live.state, 'requires_action');
      assert.equal(waiting.live.pendingCount, 1);
      assert.deepEqual(waiting.pending.map((item) => item.id), [request.id]);

      assert.deepEqual((await api.post(`/api/sessions/${sessionId}/requests/${request.id}`, { decision: 'allow' }))
        .json, { ok: true });
      const resolved = await events.next(eventNamed('request_resolved', { requestId: request.id }));
      assert.equal(resolved.data.outcome, 'allowed');
      assert.equal(resolved.data.sessionId, sessionId);
      const finished = await events.next(turnResult(sessionId, clientMessageId));
      assert.equal(finished.data.msg.subtype, 'success');
      assert.match(textOf(sdkMessagesOf(events, sessionId)), /src/);
      assert.deepEqual(answeredWith(request.id), {
        behavior: 'allow',
        updatedInput: { command: 'ls -la', description: 'List project files' },
      });
      assert.equal((await api.get(`/api/sessions/${sessionId}`)).json.pending.length, 0);
    } finally {
      events.close();
      everyone.close();
    }
  });

  it('hands a denial and its message back to the tool, and the turn carries on', async () => {
    const { sessionId, events } = await openWatched();
    try {
      const mark = events.count();
      const clientMessageId = await send(api, sessionId, 'Please run a tool');
      const request = await nextRequest(events, sessionId, mark, 'permission');
      assert.equal((await api.post(`/api/sessions/${sessionId}/requests/${request.id}`, {
        decision: 'deny',
        message: 'Not today',
      })).status, 200);
      assert.equal((await events.next(eventNamed('request_resolved', { requestId: request.id }))).data.outcome,
        'denied');
      await events.next(turnResult(sessionId, clientMessageId));
      assert.deepEqual(answeredWith(request.id), { behavior: 'deny', message: 'Not today', interrupt: false });
      assert.match(textOf(sdkMessagesOf(events, sessionId)), /Understood, I won't run that command\./);
    } finally {
      events.close();
    }
  });

  it('uses the default denial text and interrupts the turn when asked to', async () => {
    const { sessionId, events } = await openWatched();
    try {
      const mark = events.count();
      const clientMessageId = await send(api, sessionId, 'Please run a tool');
      const request = await nextRequest(events, sessionId, mark, 'permission');
      assert.equal((await api.post(`/api/sessions/${sessionId}/requests/${request.id}`, {
        decision: 'deny',
        interrupt: true,
      })).status, 200);
      const finished = await events.next(turnResult(sessionId, clientMessageId));
      assert.equal(finished.data.msg.type, 'result');
      assert.deepEqual(answeredWith(request.id), {
        behavior: 'deny',
        message: 'The user denied this action.',
        interrupt: true,
      });
    } finally {
      events.close();
    }
  });

  it('persists exactly the suggestions named by allow_always, and only allow rules when no index is given',
    async () => {
      const { sessionId, events } = await openWatched();
      try {
        const rule = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }], behavior: 'allow',
          destination: 'localSettings' };
        const directory = { type: 'addDirectories', directories: [path.dirname(server.proj)], destination: 'session' };
        const answers = [
          { indexes: [0], updated: [rule] },
          { indexes: [0, 1], updated: [rule, directory] },
          { indexes: [], updated: undefined },
          { indexes: undefined, updated: [rule] },
        ];
        for (const { indexes, updated } of answers) {
          const mark = events.count();
          const clientMessageId = await send(api, sessionId, 'Please run a tool');
          const request = await nextRequest(events, sessionId, mark, 'permission');
          const body = { decision: 'allow_always' };
          if (indexes !== undefined) body.suggestionIndexes = indexes;
          assert.equal((await api.post(`/api/sessions/${sessionId}/requests/${request.id}`, body)).status, 200);
          await events.next(turnResult(sessionId, clientMessageId));
          const result = answeredWith(request.id);
          assert.equal(result.behavior, 'allow');
          assert.deepEqual(request.suggestions, [rule, directory], 'the request offers a rule and a directory');
          if (updated === undefined) {
            assert.equal('updatedPermissions' in result, false, 'no suggestion was selected');
          } else {
            assert.deepEqual(result.updatedPermissions, updated);
          }
        }
      } finally {
        events.close();
      }
    });

  it('refuses a suggestion index that does not exist and keeps the request pending', async () => {
    const { sessionId, events } = await openWatched();
    try {
      const mark = events.count();
      const clientMessageId = await send(api, sessionId, 'Please run a tool');
      const request = await nextRequest(events, sessionId, mark, 'permission');
      const pathname = `/api/sessions/${sessionId}/requests/${request.id}`;
      assertError(await api.post(pathname, { decision: 'allow_always', suggestionIndexes: [2] }), 400, 'BAD_REQUEST');
      assertError(await api.post(pathname, { decision: 'allow_always', suggestionIndexes: [0, 0] }), 400,
        'BAD_REQUEST');
      assert.equal((await api.get(`/api/sessions/${sessionId}`)).json.pending.length, 1);
      assert.equal((await api.post(pathname, { decision: 'allow' })).status, 200);
      await events.next(turnResult(sessionId, clientMessageId));
    } finally {
      events.close();
    }
  });

  it('refuses malformed answers with 400 and leaves the request pending for a valid one', async () => {
    const { sessionId, events } = await openWatched();
    try {
      const mark = events.count();
      const clientMessageId = await send(api, sessionId, 'Please run a tool');
      const request = await nextRequest(events, sessionId, mark, 'permission');
      const pathname = `/api/sessions/${sessionId}/requests/${request.id}`;
      const malformed = [
        {},
        { decision: 'maybe' },
        { decision: 'allow', unexpected: true },
        { decision: 'allow', message: 5 },
        { decision: 'allow', updatedInput: ['not', 'an', 'object'] },
        { decision: 'deny', interrupt: 'yes' },
      ];
      for (const body of malformed) assertError(await api.post(pathname, body), 400, 'BAD_REQUEST');
      assert.equal((await api.get(`/api/sessions/${sessionId}`)).json.pending.length, 1);
      assert.equal((await api.post(pathname, { decision: 'allow' })).status, 200);
      await events.next(turnResult(sessionId, clientMessageId));
    } finally {
      events.close();
    }
  });

  it('answers 404 REQUEST_NOT_FOUND for an unknown request, and for one that was already answered', async () => {
    const { sessionId, events } = await openWatched();
    try {
      assertError(await api.post(`/api/sessions/${sessionId}/requests/no-such-request`, { decision: 'allow' }),
        404, 'REQUEST_NOT_FOUND');
      assertError(await api.post(`/api/sessions/${sessionId}/requests/bad%20id`, { decision: 'allow' }),
        400, 'BAD_REQUEST');
      const mark = events.count();
      const clientMessageId = await send(api, sessionId, 'Please run a tool');
      const request = await nextRequest(events, sessionId, mark, 'permission');
      const pathname = `/api/sessions/${sessionId}/requests/${request.id}`;
      assert.equal((await api.post(pathname, { decision: 'allow' })).status, 200);
      assertError(await api.post(pathname, { decision: 'allow' }), 404, 'REQUEST_NOT_FOUND');
      await events.next(turnResult(sessionId, clientMessageId));
    } finally {
      events.close();
    }
  });

  it('passes the chosen options of a question back to the tool', async () => {
    const { sessionId, events } = await openWatched();
    try {
      const mark = events.count();
      const clientMessageId = await send(api, sessionId, 'Please ask a question');
      const request = await nextRequest(events, sessionId, mark, 'question');
      assert.equal(request.toolName, 'AskUserQuestion');
      assert.equal(request.input.questions.length, 2);
      const [first, second] = request.input.questions.map((item) => item.question);
      assert.equal(first, 'Which authentication method should the demo use?');
      const answers = { [first]: 'Magic link', [second]: ['Dark mode', 'Exports'] };
      assert.equal((await api.post(`/api/sessions/${sessionId}/requests/${request.id}`, { answers })).status, 200);
      assert.equal((await events.next(eventNamed('request_resolved', { requestId: request.id }))).data.outcome,
        'answered');
      await events.next(turnResult(sessionId, clientMessageId));
      const result = answeredWith(request.id);
      assert.equal(result.behavior, 'allow');
      assert.deepEqual(result.updatedInput.answers, answers);
      assert.deepEqual(result.updatedInput.questions, request.input.questions);
      assert.match(textOf(sdkMessagesOf(events, sessionId)), /Magic link/);
    } finally {
      events.close();
    }
  });

  it('turns a declined question into a denial that tells the tool the user declined', async () => {
    const { sessionId, events } = await openWatched();
    try {
      const mark = events.count();
      const clientMessageId = await send(api, sessionId, 'Please ask a question');
      const request = await nextRequest(events, sessionId, mark, 'question');
      assert.equal((await api.post(`/api/sessions/${sessionId}/requests/${request.id}`, { decline: true })).status,
        200);
      assert.equal((await events.next(eventNamed('request_resolved', { requestId: request.id }))).data.outcome,
        'denied');
      await events.next(turnResult(sessionId, clientMessageId));
      assert.deepEqual(answeredWith(request.id), {
        behavior: 'deny',
        message: 'The user declined to answer.',
      });
      assert.match(textOf(sdkMessagesOf(events, sessionId)), /continue with sensible defaults/);
    } finally {
      events.close();
    }
  });

  it('switches the session to the mode chosen when a plan is approved', async () => {
    const { sessionId, events } = await openWatched();
    try {
      const mark = events.count();
      const clientMessageId = await send(api, sessionId, 'Please make a plan');
      const request = await nextRequest(events, sessionId, mark, 'plan');
      assert.match(request.input.plan, /^# Plan/);
      assert.equal((await api.post(`/api/sessions/${sessionId}/requests/${request.id}`, {
        decision: 'approve',
        nextMode: 'acceptEdits',
      })).status, 200);
      await events.next((item) => item.event === 'session_state' && item.data.live?.sessionId === sessionId
        && item.data.live.permissionMode === 'acceptEdits', 5000, { from: mark });
      await events.next(turnResult(sessionId, clientMessageId));
      assert.equal((await api.get(`/api/sessions/${sessionId}`)).json.live.permissionMode, 'acceptEdits');
      assert.deepEqual(answeredWith(request.id), { behavior: 'allow', updatedInput: request.input });
      assert.match(textOf(sdkMessagesOf(events, sessionId)), /Plan approved/);
    } finally {
      events.close();
    }
  });

  it('refuses a plan approval with an unknown next mode, and rejects a plan with feedback', async () => {
    const { sessionId, events } = await openWatched();
    try {
      const mark = events.count();
      const clientMessageId = await send(api, sessionId, 'Please make a plan');
      const request = await nextRequest(events, sessionId, mark, 'plan');
      const pathname = `/api/sessions/${sessionId}/requests/${request.id}`;
      assertError(await api.post(pathname, { decision: 'approve', nextMode: 'bypassPermissions' }), 400,
        'BAD_REQUEST');
      assertError(await api.post(pathname, { decision: 'maybe' }), 400, 'BAD_REQUEST');
      assert.equal((await api.post(pathname, { decision: 'reject', message: 'Split the work in two' })).status, 200);
      await events.next(turnResult(sessionId, clientMessageId));
      assert.deepEqual(answeredWith(request.id), { behavior: 'deny', message: 'Split the work in two' });
      assert.equal((await api.get(`/api/sessions/${sessionId}`)).json.live.permissionMode, 'plan');
      assert.match(textOf(sdkMessagesOf(events, sessionId)), /revise the plan/);
    } finally {
      events.close();
    }
  });

  it('returns the content of an accepted MCP elicitation to the server', async () => {
    const { sessionId, events } = await openWatched();
    try {
      const mark = events.count();
      const clientMessageId = await send(api, sessionId, 'Please elicit a sign-in');
      const request = await nextRequest(events, sessionId, mark, 'elicitation');
      assert.equal(request.elicitation.serverName, 'github');
      assert.equal(request.elicitation.mode, 'form');
      assert.equal(request.elicitation.message, 'Sign in to GitHub to continue');
      assert.deepEqual(Object.keys(request.elicitation.requestedSchema.properties), ['username', 'remember']);
      assertError(await api.post(`/api/sessions/${sessionId}/requests/${request.id}`, { action: 'maybe' }), 400,
        'BAD_REQUEST');
      assertError(await api.post(`/api/sessions/${sessionId}/requests/${request.id}`, {
        action: 'accept',
        content: { nested: { deep: true } },
      }), 400, 'BAD_REQUEST');
      assert.equal((await api.post(`/api/sessions/${sessionId}/requests/${request.id}`, {
        action: 'accept',
        content: { username: 'ada', remember: true },
      })).status, 200);
      assert.equal((await events.next(eventNamed('request_resolved', { requestId: request.id }))).data.outcome,
        'allowed');
      await events.next(turnResult(sessionId, clientMessageId));
      assert.match(textOf(sdkMessagesOf(events, sessionId)), /Signed in as ada \(remembered\)/);
    } finally {
      events.close();
    }
  });

  it('reports a declined and a cancelled elicitation as such', async () => {
    const { sessionId, events } = await openWatched();
    try {
      let mark = events.count();
      let clientMessageId = await send(api, sessionId, 'Please elicit a sign-in');
      let request = await nextRequest(events, sessionId, mark, 'elicitation');
      assert.equal((await api.post(`/api/sessions/${sessionId}/requests/${request.id}`, { action: 'decline' }))
        .status, 200);
      await events.next(turnResult(sessionId, clientMessageId));
      assert.match(textOf(sdkMessagesOf(events, sessionId)), /You declined to sign in/);

      mark = events.count();
      clientMessageId = await send(api, sessionId, 'Please elicit a sign-in');
      request = await nextRequest(events, sessionId, mark, 'elicitation');
      assert.equal((await api.post(`/api/sessions/${sessionId}/requests/${request.id}`, { action: 'cancel' }))
        .status, 200);
      await events.next(turnResult(sessionId, clientMessageId));
      assert.match(textOf(sdkMessagesOf(events, sessionId)), /The sign-in was cancelled/);
    } finally {
      events.close();
    }
  });

  it('asks permission for an MCP tool with the name of its server and the tool name', async () => {
    const { sessionId, events } = await openWatched();
    try {
      const mark = events.count();
      const clientMessageId = await send(api, sessionId, 'Please check the mcp server');
      const request = await nextRequest(events, sessionId, mark, 'permission');
      assert.equal(request.toolName, 'mcp__github__search_issues');
      assert.deepEqual(request.mcpServer, { name: 'github', source: 'user' });
      assert.equal(request.displayName, 'github: search_issues');
      assert.equal((await api.post(`/api/sessions/${sessionId}/requests/${request.id}`, { decision: 'allow' }))
        .status, 200);
      await events.next(turnResult(sessionId, clientMessageId));
      assert.match(textOf(sdkMessagesOf(events, sessionId)), /I found 2 open bug reports/);
    } finally {
      events.close();
    }
  });

  it('cancels the pending requests of a session that is closed, and reports them as cancelled', async () => {
    const { sessionId, events } = await openWatched();
    try {
      const mark = events.count();
      await send(api, sessionId, 'Please run a tool');
      const request = await nextRequest(events, sessionId, mark, 'permission');
      assert.equal((await api.post(`/api/sessions/${sessionId}/close`)).status, 200);
      const resolved = await events.next(eventNamed('request_resolved', { requestId: request.id }));
      assert.equal(resolved.data.outcome, 'cancelled');
      assert.equal(resolved.data.sessionId, sessionId);
      assert.equal(answeredWith(request.id).behavior, 'deny');
      assertError(await api.post(`/api/sessions/${sessionId}/requests/${request.id}`, { decision: 'allow' }), 404,
        'REQUEST_NOT_FOUND');
      assert.deepEqual((await api.get(`/api/sessions/${sessionId}`)).json.pending, []);
    } finally {
      events.close();
    }
  });
});
