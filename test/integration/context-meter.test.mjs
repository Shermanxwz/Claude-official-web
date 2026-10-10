/**
 * Integration tests: the context meter of a live session (LiveInfo.context) through the gateway and the deterministic
 * mock. A new session reports its window and the fixed overhead, a turn moves the meter to the size of its last call,
 * /compact and an automatic compaction are recorded with their triggers, the context route agrees with the meter, a
 * reopened session reads its last call from the transcript, and a reopened compacted session counts its context.
 */
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { client, createLive, runTurn, sdkMessagesOf, startTestServer } from './helpers.mjs';

/**
 * The LiveInfo of a session as each session_state frame of the stream carries it, oldest first.
 * @param {{all: () => any[]}} events
 * @param {string} sessionId
 * @returns {any[]}
 */
function livesOf(events, sessionId) {
  return events.all()
    .filter((frame) => frame.event === 'session_state' && frame.data?.live?.sessionId === sessionId)
    .map((frame) => frame.data.live);
}

/**
 * The tokens of the last main-thread call among some SDK messages: input, cache creation, cache read and output.
 * @param {any[]} messages
 * @returns {number}
 */
function lastCallTokensOf(messages) {
  const last = messages.filter((msg) => msg.type === 'assistant' && msg.parent_tool_use_id === null).at(-1);
  const usage = last.message.usage;
  return usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens + usage.output_tokens;
}

describe('context meter through the gateway', { timeout: 120000 }, () => {
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

  it('a new live session reports the window and the fixed overhead until its first call', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const sessionId = live.sessionId;
    const events = await api.events({ watch: sessionId, after: 0 });
    try {
      const frame = await events.next((f) => f.event === 'session_state'
        && f.data?.live?.context?.source === 'estimate', 10000);
      const meter = frame.data.live.context;
      assert.deepEqual([meter.max, meter.autoCompactAt, meter.autoCompact], [100000, 67000, true]);
      const summary = (await api.get(`/api/sessions/${sessionId}/context?detail=summary`)).json;
      assert.equal(summary.maxTokens, 100000);
      assert.equal(meter.used, summary.totalTokens, 'the first estimate is the summary total');
    } finally {
      events.close();
    }
  });

  it('a turn moves the meter to the size of its last call, as the stream reported it', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const sessionId = live.sessionId;
    const events = await api.events({ watch: sessionId, after: 0 });
    try {
      await runTurn(api, events, sessionId, 'Give me some history first');
      const meter = livesOf(events, sessionId).at(-1).context;
      assert.equal(meter.source, 'stream');
      assert.equal(meter.used, lastCallTokensOf(sdkMessagesOf(events, sessionId)));
      assert.ok(meter.used > 39116, 'the conversation is in the context');
    } finally {
      events.close();
    }
  });

  it('/compact shows the compaction as manual while it runs, and its boundary is the last compaction', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const sessionId = live.sessionId;
    const events = await api.events({ watch: sessionId, after: 0 });
    try {
      await runTurn(api, events, sessionId, 'Give me some history first');
      await runTurn(api, events, sessionId, '/compact');
      const lives = livesOf(events, sessionId);
      assert.ok(lives.some((l) => l.context.compacting?.trigger === 'manual'), 'the compaction shows while it runs');
      const meter = lives.at(-1).context;
      assert.equal(meter.compacting, null);
      assert.equal(meter.lastCompaction.trigger, 'manual');
      assert.equal(meter.lastCompaction.postTokens, 1960);
      assert.ok(meter.lastCompaction.preTokens > 39116, 'the compaction saw the conversation');
      const summary = (await api.get(`/api/sessions/${sessionId}/context?detail=summary`)).json;
      const full = (await api.get(`/api/sessions/${sessionId}/context?detail=full`)).json;
      assert.equal(full.totalTokens, summary.totalTokens + 1960, 'the summary replaces the conversation before it');
    } finally {
      events.close();
    }
  });

  it('an automatic compaction in the middle of a turn is recorded with its trigger and sizes', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const sessionId = live.sessionId;
    const events = await api.events({ watch: sessionId, after: 0 });
    try {
      await runTurn(api, events, sessionId, 'autocompact the long logs');
      const lives = livesOf(events, sessionId);
      assert.ok(lives.some((l) => l.context.compacting !== null && l.context.compacting.trigger === null),
        'the automatic compaction shows while it runs, without a trigger of its own');
      const meter = lives.at(-1).context;
      assert.equal(meter.compacting, null);
      assert.equal(meter.lastCompaction.trigger, 'auto');
      assert.equal(meter.lastCompaction.postTokens, 2069);
      assert.ok(meter.lastCompaction.preTokens > 67000, 'the reads passed the autocompact threshold');
    } finally {
      events.close();
    }
  });

  it('a reopened session reads its last call from the transcript', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const sessionId = live.sessionId;
    const events = await api.events({ watch: sessionId, after: 0 });
    try {
      await runTurn(api, events, sessionId, 'Give me some history first');
      const before = livesOf(events, sessionId).at(-1).context;
      assert.equal((await api.post(`/api/sessions/${sessionId}/close`, {})).status, 200);
      const reopened = await api.post(`/api/sessions/${sessionId}/open`, {});
      assert.equal(reopened.status, 200, reopened.text);
      const frame = await events.next((f) => f.event === 'session_state' && f.data?.live?.sessionId === sessionId
        && f.data.live.context?.source === 'transcript', 10000);
      assert.equal(frame.data.live.context.used, before.used, 'the transcript records the same last call');
    } finally {
      events.close();
    }
  });

  it('a reopened session after /compact counts its context in full, as no call has run since', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const sessionId = live.sessionId;
    const events = await api.events({ watch: sessionId, after: 0 });
    try {
      await runTurn(api, events, sessionId, 'Give me some history first');
      await runTurn(api, events, sessionId, '/compact');
      assert.equal((await api.post(`/api/sessions/${sessionId}/close`, {})).status, 200);
      const mark = events.count();
      const reopened = await api.post(`/api/sessions/${sessionId}/open`, {});
      assert.equal(reopened.status, 200, reopened.text);
      const frame = await events.next((f) => f.event === 'session_state' && f.data?.live?.sessionId === sessionId
        && f.data.live.context?.source === 'count', 10000, { from: mark });
      const full = (await api.get(`/api/sessions/${sessionId}/context?detail=full`)).json;
      assert.equal(frame.data.live.context.used, full.totalTokens, 'the count is the size the context route reports');
    } finally {
      events.close();
    }
  });
});
