/**
 * Integration tests: what happens around a turn. The output of a background command by its task id, a queued message
 * cancelled by its id, the interrupt receipt (the messages still queued, or cancelled with cancelQueued), the side
 * question (one at a time, opened on demand), and the refusal dialog that asks before a refused answer is retried on
 * the fallback model.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it, before, after } from 'node:test';
import {
  assertError,
  client,
  createLive,
  eventNamed,
  runTurn,
  startTestServer,
  turnResult,
} from './helpers.mjs';

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

/** @param {any} msg */
const systemOf = (msg, /** @type {string} */ subtype) => msg.type === 'system' && msg.subtype === subtype;

/** @param {any} msg */
const callsTool = (msg) => msg.type === 'assistant' && msg.message.content.some((block) => block.type === 'tool_use');

/** A streamed text delta: the answer to a slow prompt has started. */
const isTextDelta = (/** @type {any} */ msg) => msg.type === 'stream_event' && msg.event.type === 'content_block_delta';

/** The dialog request of one session, as the gateway publishes it. */
const dialogOf = (/** @type {string} */ sessionId) => (/** @type {any} */ frame) => frame.event === 'request'
  && frame.data?.request?.kind === 'dialog' && frame.data.request.sessionId === sessionId;

describe('background output, queued messages and interrupts', { timeout: 120000 }, () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let server;
  /** @type {ReturnType<typeof client>} */
  let api;
  before(async () => {
    // A slow answer streams a chunk every 80 ms, so a turn lasts long enough to queue and interrupt. A background build
    // runs for 1.5 s once it has been moved.
    server = await startTestServer({ CAW_MOCK_DELAY_MS: '20' }, {
      backgroundTiming: { waitMs: 5000, runMs: 1500 },
    });
    api = client(server.url);
    await api.login();
  });
  after(async () => {
    await server.close();
  });

  it('serves the output of a background command by its task id, and refuses a task the session does not have',
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
        assert.deepEqual((await api.post(`/api/sessions/${sessionId}/background`, { toolUseId: toolUse.id })).json,
          { backgrounded: true });
        const listed = await events.next(sdkWhere(sessionId, (msg) => systemOf(msg, 'background_tasks_changed')
          && msg.tasks.length === 1), 5000);
        const taskId = listed.data.msg.tasks[0].task_id;
        const pathname = `/api/sessions/${sessionId}/tasks/${taskId}/output`;

        assert.deepEqual((await api.get(pathname)).json, { output: '', totalBytes: 0, truncated: false },
          'nothing has been written while the build runs');
        await events.next(turnResult(sessionId, clientMessageId), 5000);
        await events.next(sdkWhere(sessionId, (msg) => systemOf(msg, 'task_notification')), 5000);
        assert.deepEqual((await api.get(pathname)).json, {
          output: 'Build succeeded\n',
          totalBytes: 16,
          truncated: false,
        });
        assertError(await api.get(`/api/sessions/${sessionId}/tasks/task_mock_unknown/output`), 404, 'NOT_FOUND');
      } finally {
        events.close();
      }
    });

  it('cancels a queued message by its id once; a second cancel finds nothing to cancel', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const sessionId = live.sessionId;
    const events = await api.events({ watch: sessionId, after: 0 });
    try {
      const running = randomUUID();
      assert.equal((await api.post(`/api/sessions/${sessionId}/messages`, {
        clientMessageId: running,
        text: 'answer slowly',
      })).status, 200);
      await events.next(sdkWhere(sessionId, isTextDelta), 5000);
      const queued = randomUUID();
      assert.equal((await api.post(`/api/sessions/${sessionId}/messages`, {
        clientMessageId: queued,
        text: 'Tell me something',
      })).status, 200);
      await events.next(eventNamed('message_accepted', { sessionId, clientMessageId: queued }), 5000);

      assert.deepEqual((await api.del(`/api/sessions/${sessionId}/queued/${queued}`)).json, { cancelled: true });
      await events.next(eventNamed('message_cancelled', { sessionId, clientMessageId: queued }), 5000);
      assert.deepEqual((await api.del(`/api/sessions/${sessionId}/queued/${queued}`)).json, { cancelled: false });

      assert.deepEqual((await api.post(`/api/sessions/${sessionId}/interrupt`, {})).json,
        { ok: true, stillQueued: [], cancelled: [] });
      await events.next(turnResult(sessionId, running), 5000);
      await sleep(200);
      assert.equal(events.all().some(turnResult(sessionId, queued)), false, 'the cancelled message never runs');
    } finally {
      events.close();
    }
  });

  it('the interrupt receipt names the messages still queued, and they run after the interrupted turn', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const sessionId = live.sessionId;
    const events = await api.events({ watch: sessionId, after: 0 });
    try {
      const running = randomUUID();
      await api.post(`/api/sessions/${sessionId}/messages`, { clientMessageId: running, text: 'answer slowly' });
      await events.next(sdkWhere(sessionId, isTextDelta), 5000);
      const queued = randomUUID();
      await api.post(`/api/sessions/${sessionId}/messages`, { clientMessageId: queued, text: 'Tell me something' });
      await events.next(eventNamed('message_accepted', { sessionId, clientMessageId: queued }), 5000);

      const receipt = await api.post(`/api/sessions/${sessionId}/interrupt`, {});
      assert.deepEqual(receipt.json, { ok: true, stillQueued: [queued], cancelled: [] });
      const interrupted = await events.next(turnResult(sessionId, running), 5000);
      assert.equal(interrupted.data.msg.user_message_uuid, running);
      const next = await events.next(turnResult(sessionId, queued), 10000);
      assert.equal(next.data.msg.subtype, 'success');
    } finally {
      events.close();
    }
  });

  it('interrupt with cancelQueued drops every queued message, and announces each one as cancelled', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const sessionId = live.sessionId;
    const events = await api.events({ watch: sessionId, after: 0 });
    try {
      const running = randomUUID();
      await api.post(`/api/sessions/${sessionId}/messages`, { clientMessageId: running, text: 'answer slowly' });
      await events.next(sdkWhere(sessionId, isTextDelta), 5000);
      const first = randomUUID();
      const second = randomUUID();
      for (const clientMessageId of [first, second]) {
        await api.post(`/api/sessions/${sessionId}/messages`, { clientMessageId, text: 'Tell me something' });
        await events.next(eventNamed('message_accepted', { sessionId, clientMessageId }), 5000);
      }

      const receipt = await api.post(`/api/sessions/${sessionId}/interrupt`, { cancelQueued: true });
      assert.deepEqual(receipt.json, { ok: true, stillQueued: [], cancelled: [first, second] });
      await events.next(eventNamed('message_cancelled', { sessionId, clientMessageId: first }), 5000);
      await events.next(eventNamed('message_cancelled', { sessionId, clientMessageId: second }), 5000);
      await events.next(turnResult(sessionId, running), 5000);
      await sleep(200);
      assert.equal(events.all().some(turnResult(sessionId, first)), false);
      assert.equal(events.all().some(turnResult(sessionId, second)), false);
    } finally {
      events.close();
    }
  });

  it('a session that is not live has an empty interrupt receipt, and its queue cannot be cancelled', async () => {
    const live = await createLive(api, { cwd: server.proj });
    assert.equal((await api.post(`/api/sessions/${live.sessionId}/close`, {})).status, 200);
    assert.deepEqual((await api.post(`/api/sessions/${live.sessionId}/interrupt`, {})).json,
      { ok: true, stillQueued: [], cancelled: [] });
    assertError(await api.del(`/api/sessions/${live.sessionId}/queued/${randomUUID()}`), 409, 'SESSION_NOT_LIVE');
  });
});

describe('side questions', { timeout: 120000 }, () => {
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

  it('answers a side question without a turn, and opens a session that is not live first', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const sessionId = live.sessionId;
    const events = await api.events({ watch: sessionId, after: 0 });
    try {
      // A session is stored once it has a message, so the session is given a turn before it is closed and reopened.
      await runTurn(api, events, sessionId, 'Tell me something');
    } finally {
      events.close();
    }
    const transcriptPath = `/api/sessions/${sessionId}/messages?tail=50`;
    const transcriptSize = async () => (await api.get(transcriptPath)).json.messages.length;
    const before = await transcriptSize();
    const pathname = `/api/sessions/${sessionId}/side-question`;
    const answer = await api.post(pathname, { question: 'What changed in the last turn?' });
    assert.equal(answer.status, 200, answer.text);
    assert.deepEqual(answer.json, {
      response: 'Side answer: What changed in the last turn?',
      synthetic: false,
      refusalFallback: null,
    });
    assert.equal(await transcriptSize(), before, 'the side question adds nothing to the transcript');
    assert.equal((await api.post(`/api/sessions/${sessionId}/close`, {})).status, 200);
    // A question about a refusal is answered through the fallback model, and reports both models.
    const refused = await api.post(pathname, { question: 'Why the refusal?' });
    assert.equal(refused.status, 200, refused.text);
    assert.deepEqual(refused.json.refusalFallback, {
      originalModel: 'claude-opus-mock',
      fallbackModel: 'claude-sonnet-mock',
    });
  });

  it('refuses an empty question and a question longer than 4000 characters', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const pathname = `/api/sessions/${live.sessionId}/side-question`;
    assertError(await api.post(pathname, { question: '   ' }), 400, 'BAD_REQUEST');
    assertError(await api.post(pathname, { question: 'x'.repeat(4001) }), 400, 'BAD_REQUEST');
  });
});

describe('one side question at a time', { timeout: 120000 }, () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let server;
  /** @type {ReturnType<typeof client>} */
  let api;
  before(async () => {
    // The runtime answers a side question slowly here, so a second one arrives while the first is being answered.
    server = await startTestServer({}, {
      wrapEngine: (engine) => ({
        ...engine,
        query: (args) => {
          const query = engine.query(args);
          const ask = query.askSideQuestion;
          query.askSideQuestion = async (...rest) => {
            await sleep(400);
            return ask(...rest);
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

  it('refuses a second side question while the first is still being answered', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const pathname = `/api/sessions/${live.sessionId}/side-question`;
    const first = api.post(pathname, { question: 'First?' });
    await sleep(100);
    assertError(await api.post(pathname, { question: 'Second?' }), 409, 'CONFLICT');
    const answered = await first;
    assert.equal(answered.status, 200);
    assert.equal(answered.json.response, 'Side answer: First?');
  });
});

describe('the refusal dialog', { timeout: 120000 }, () => {
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
   * Starts a turn that the model refuses, and waits for the runtime's refusal dialog.
   * @param {string} sessionId
   * @param {any} events
   * @returns {Promise<{clientMessageId: string, request: any}>}
   */
  async function refusedTurn(sessionId, events) {
    const clientMessageId = randomUUID();
    const accepted = await api.post(`/api/sessions/${sessionId}/messages`, {
      clientMessageId,
      text: 'refusal-prompt please',
    });
    assert.equal(accepted.status, 200, accepted.text);
    const pending = await events.next(dialogOf(sessionId), 5000);
    return { clientMessageId, request: pending.data.request };
  }

  it('the dialog names both models and the refused message; retrying answers on the fallback model', async () => {
    const live = await createLive(api, { cwd: server.proj, fallbackModel: 'claude-haiku-mock' });
    const sessionId = live.sessionId;
    const events = await api.events({ watch: sessionId, after: 0 });
    try {
      const { clientMessageId, request } = await refusedTurn(sessionId, events);
      assert.equal(request.dialog.dialogKind, 'refusal_fallback_prompt');
      assert.equal(request.dialog.originalModel, 'claude-opus-mock');
      assert.equal(request.dialog.fallbackModel, 'claude-haiku-mock');
      assert.equal(request.dialog.retractedMessageUuids.length, 1);
      assert.equal(typeof request.dialog.guidanceText, 'string');

      const pathname = `/api/sessions/${sessionId}/requests/${request.id}`;
      assertError(await api.post(pathname, { result: 'maybe' }), 422, 'INVALID_ARGUMENT');
      assert.deepEqual((await api.post(pathname, { result: 'retry_fallback' })).json, { ok: true });
      await events.next(eventNamed('request_resolved', { sessionId, requestId: request.id, outcome: 'answered' }),
        5000);

      const result = await events.next(turnResult(sessionId, clientMessageId), 10000);
      assert.equal(result.data.msg.subtype, 'success');
      const notice = await events.next(sdkWhere(sessionId, (msg) => systemOf(msg, 'model_refusal_fallback')), 5000);
      assert.equal(notice.data.msg.fallback_model, 'claude-haiku-mock');
    } finally {
      events.close();
    }
  });

  it('editing the prompt ends the turn and takes the refused answer out of the transcript', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const sessionId = live.sessionId;
    const events = await api.events({ watch: sessionId, after: 0 });
    try {
      const { clientMessageId, request } = await refusedTurn(sessionId, events);
      assert.deepEqual((await api.post(`/api/sessions/${sessionId}/requests/${request.id}`,
        { result: 'edit_prompt' })).json, { ok: true });
      const result = await events.next(turnResult(sessionId, clientMessageId), 10000);
      assert.equal(result.data.msg.subtype, 'success');
      const transcript = await api.get(`/api/sessions/${sessionId}/messages?tail=20`);
      assert.equal(transcript.status, 200);
      assert.equal(transcript.json.messages.some((message) => message.type === 'assistant'), false,
        'the refused answer is gone');
    } finally {
      events.close();
    }
  });

  it('cancelling the dialog keeps the refusal and says that no fallback ran', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const sessionId = live.sessionId;
    const events = await api.events({ watch: sessionId, after: 0 });
    try {
      const { clientMessageId, request } = await refusedTurn(sessionId, events);
      assert.deepEqual((await api.post(`/api/sessions/${sessionId}/requests/${request.id}`,
        { result: 'cancelled' })).json, { ok: true });
      const notice = await events.next(sdkWhere(sessionId, (msg) => systemOf(msg, 'model_refusal_no_fallback')), 10000);
      assert.equal(notice.data.msg.refused_user_message_uuid, clientMessageId);
      const result = await events.next(turnResult(sessionId, clientMessageId), 10000);
      assert.equal(result.data.msg.subtype, 'success');
    } finally {
      events.close();
    }
  });
});
