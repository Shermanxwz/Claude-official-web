/**
 * Integration tests: the unattended switch over HTTP (docs/PROTOCOL.md "Unattended mode"). They cover availability and
 * the profile rules, the saved value across restarts, a live session that follows the switch, and the answers the
 * gateway gives to the requests of a turn while the switch is on. The engine is the mock, so every turn is scripted.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  assertError, client, createLive, eventNamed, runTurn, sdkMessagesOf, startTestServer, turnResult,
} from './helpers.mjs';

/**
 * The text the assistant wrote in a session, joined.
 * @param {unknown[]} messages
 */
function textOf(messages) {
  return messages
    .filter((message) => message.type === 'assistant')
    .flatMap((message) => (message.message?.content ?? []).filter((block) => block.type === 'text'))
    .map((block) => block.text)
    .join('\n');
}

/**
 * Waits for the next request of one kind in a session, scanning the stream from `from`.
 * @param {any} events
 * @param {string} sessionId
 * @param {string} kind
 * @param {number} [from]
 * @returns {Promise<any>} the PendingRequest
 */
async function requestOf(events, sessionId, kind, from = 0) {
  const frame = await events.next((item) => item.event === 'request' && item.data.request.sessionId === sessionId
    && item.data.request.kind === kind, 5000, { from });
  return frame.data.request;
}

/**
 * Waits for the resolution of one request, scanning the stream from `from`.
 * @param {any} events
 * @param {string} requestId
 * @param {number} [from]
 * @returns {Promise<any>} the data of request_resolved
 */
async function resolutionOf(events, requestId, from = 0) {
  const frame = await events.next(eventNamed('request_resolved', { requestId }), 5000, { from });
  return frame.data;
}

describe('unattended mode', { timeout: 120000 }, () => {
  it('reports the switch as unavailable without bypass, and refuses to change it with 501', async () => {
    const server = await startTestServer({});
    try {
      const api = client(server.url);
      await api.login();
      const state = await api.get('/api/unattended');
      assert.equal(state.status, 200);
      assert.deepEqual(state.json, { available: false, enabled: false, reason: 'not-allowed', changedAt: null });
      const meta = (await api.get('/api/meta')).json;
      assert.deepEqual(meta.features.unattended, state.json);
      assert.equal(meta.features.bypass, false);
      assertError(await api.put('/api/unattended', { enabled: true }), 501, 'FEATURE_DISABLED');
      assertError(await api.put('/api/unattended', { enabled: false }), 501, 'FEATURE_DISABLED');
    } finally {
      await server.close();
    }
  });

  it('available with CAW_ALLOW_BYPASS=1, and CAW_UNATTENDED=1 starts it on for new sessions', async () => {
    const allowed = await startTestServer({ CAW_ALLOW_BYPASS: '1' });
    try {
      const api = client(allowed.url);
      await api.login();
      assert.deepEqual((await api.get('/api/unattended')).json, {
        available: true, enabled: false, reason: null, changedAt: null,
      });
      assert.equal((await api.get('/api/meta')).json.features.bypass, true);
    } finally {
      await allowed.close();
    }

    const on = await startTestServer({ CAW_UNATTENDED: '1' });
    try {
      const api = client(on.url);
      await api.login();
      assert.deepEqual((await api.get('/api/unattended')).json, {
        available: true, enabled: true, reason: null, changedAt: null,
      });
      const live = await createLive(api, { cwd: on.proj });
      assert.equal(live.permissionMode, 'bypassPermissions');
    } finally {
      await on.close();
    }
  });

  it('PUT saves the switch and tells every client; repeating the same value is not a change', async () => {
    const server = await startTestServer({ CAW_ALLOW_BYPASS: '1' });
    try {
      const api = client(server.url);
      await api.login();
      const all = await api.events({ after: 0 });
      const on = await api.put('/api/unattended', { enabled: true });
      assert.equal(on.status, 200);
      assert.equal(on.json.enabled, true);
      assert.deepEqual({ ...on.json, changedAt: null }, {
        available: true, enabled: true, reason: null, changedAt: null,
      });
      assert.equal(typeof on.json.changedAt, 'number');
      assert.deepEqual((await all.next(eventNamed('unattended_changed', { enabled: true }))).data, on.json);

      const again = await api.put('/api/unattended', { enabled: true });
      assert.deepEqual(again.json, on.json);

      const off = await api.put('/api/unattended', { enabled: false });
      assert.equal(off.json.enabled, false);
      await all.next(eventNamed('unattended_changed', { enabled: false }));
      const changes = all.all().filter((frame) => frame.event === 'unattended_changed');
      assert.deepEqual(changes.map((frame) => frame.data.enabled), [true, false]);
      assert.deepEqual((await api.get('/api/unattended')).json, off.json);
    } finally {
      await server.close();
    }
  });

  it('PUT needs the full profile, invalid bodies are 400, and an anonymous client gets 401', async () => {
    const standard = await startTestServer({ CAW_ACCESS_PROFILE: 'standard' });
    const server = await startTestServer({ CAW_ALLOW_BYPASS: '1' });
    try {
      const reader = client(standard.url);
      await reader.login();
      assert.deepEqual((await reader.get('/api/unattended')).json, {
        available: false, enabled: false, reason: 'profile', changedAt: null,
      });
      assertError(await reader.put('/api/unattended', { enabled: true }), 403, 'FORBIDDEN');

      const api = client(server.url);
      await api.login();
      for (const body of [{}, { enabled: 'yes' }, { enabled: true, extra: 1 }, [true]]) {
        assertError(await api.put('/api/unattended', body), 400, 'BAD_REQUEST');
      }
      // A bare string is sent as text/plain, which the JSON routes refuse with 415; sent as JSON it is a 400.
      const asJson = { headers: { 'Content-Type': 'application/json' } };
      assertError(await api.put('/api/unattended', 'on', asJson), 400, 'BAD_REQUEST');
      assertError(await api.put('/api/unattended', null, asJson), 400, 'BAD_REQUEST');
      assert.equal((await api.get('/api/unattended')).json.enabled, false);

      const anonymous = client(server.url);
      assertError(await anonymous.get('/api/unattended'), 401, 'UNAUTHENTICATED');
      assertError(await anonymous.put('/api/unattended', { enabled: true }), 401, 'UNAUTHENTICATED');
    } finally {
      await standard.close();
      await server.close();
    }
  });

  it('a live session follows the switch: bypass while it is on, and its own mode once it is off', async () => {
    const server = await startTestServer({ CAW_ALLOW_BYPASS: '1' });
    try {
      const api = client(server.url);
      await api.login();
      const live = await createLive(api, { cwd: server.proj, permissionMode: 'acceptEdits' });
      const modeOf = async () => (await api.get(`/api/sessions/${live.sessionId}`)).json.live.permissionMode;
      assert.equal(await modeOf(), 'acceptEdits');
      await api.put('/api/unattended', { enabled: true });
      assert.equal(await modeOf(), 'bypassPermissions');
      await api.put('/api/unattended', { enabled: false });
      assert.equal(await modeOf(), 'acceptEdits');
    } finally {
      await server.close();
    }
  });

  it('a tool turn runs straight through while the switch is on: no request is shown, and the output reaches the reply',
    async () => {
      const server = await startTestServer({ CAW_ALLOW_BYPASS: '1' });
      try {
        const api = client(server.url);
        await api.login();
        await api.put('/api/unattended', { enabled: true });
        const live = await createLive(api, { cwd: server.proj });
        const events = await api.events({ watch: live.sessionId, after: 0 });
        const { result } = await runTurn(api, events, live.sessionId, 'Please run a tool');
        assert.equal(result.subtype, 'success');
        assert.equal(events.all().filter((frame) => frame.event === 'request').length, 0);
        assert.match(textOf(sdkMessagesOf(events, live.sessionId)), /src/);
      } finally {
        await server.close();
      }
    });

  it('a question, a plan and an MCP sign-in are answered by the gateway with auto: true, and each turn goes on',
    async () => {
      const server = await startTestServer({ CAW_ALLOW_BYPASS: '1' });
      try {
        const api = client(server.url);
        await api.login();
        await api.put('/api/unattended', { enabled: true });
        const live = await createLive(api, { cwd: server.proj });
        const events = await api.events({ watch: live.sessionId, after: 0 });
        const cases = [
          ['Please ask a question', 'question', 'denied', /No problem, I will continue with sensible defaults\./],
          ['Please make a plan', 'plan', 'allowed', /Plan approved — implementing\./],
          ['Please elicit a sign-in', 'elicitation', 'denied', /You declined to sign in/],
        ];
        for (const [text, kind, outcome, reply] of cases) {
          const mark = events.count();
          const { result } = await runTurn(api, events, live.sessionId, text);
          assert.equal(result.subtype, 'success', text);
          const request = await requestOf(events, live.sessionId, kind, mark);
          const resolved = await resolutionOf(events, request.id, mark);
          assert.equal(resolved.outcome, outcome, text);
          assert.equal(resolved.auto, true, text);
          assert.match(textOf(sdkMessagesOf(events, live.sessionId)), reply, text);
        }
        assert.equal((await api.get(`/api/sessions/${live.sessionId}`)).json.pending.length, 0);
      } finally {
        await server.close();
      }
    });

  it('a request that waits when the switch turns on is answered at once, and the turn finishes', async () => {
    const server = await startTestServer({ CAW_ALLOW_BYPASS: '1' });
    try {
      const api = client(server.url);
      await api.login();
      const live = await createLive(api, { cwd: server.proj });
      const events = await api.events({ watch: live.sessionId, after: 0 });
      const clientMessageId = randomUUID();
      const sent = await api.post(`/api/sessions/${live.sessionId}/messages`, {
        clientMessageId, text: 'Please run a tool',
      });
      assert.equal(sent.status, 200, sent.text);
      const request = await requestOf(events, live.sessionId, 'permission');
      assert.equal((await api.get(`/api/sessions/${live.sessionId}`)).json.live.state, 'requires_action');

      await api.put('/api/unattended', { enabled: true });
      const resolved = await resolutionOf(events, request.id);
      assert.equal(resolved.outcome, 'allowed');
      assert.equal(resolved.auto, true);
      const finished = await events.next(turnResult(live.sessionId, clientMessageId));
      assert.equal(finished.data.msg.subtype, 'success');
      assert.match(textOf(sdkMessagesOf(events, live.sessionId)), /src/);
    } finally {
      await server.close();
    }
  });

  it('turning the switch off gives approvals back: a tool turn asks again and the person answers', async () => {
    const server = await startTestServer({ CAW_ALLOW_BYPASS: '1' });
    try {
      const api = client(server.url);
      await api.login();
      await api.put('/api/unattended', { enabled: true });
      await api.put('/api/unattended', { enabled: false });
      const live = await createLive(api, { cwd: server.proj });
      const events = await api.events({ watch: live.sessionId, after: 0 });
      const clientMessageId = randomUUID();
      await api.post(`/api/sessions/${live.sessionId}/messages`, { clientMessageId, text: 'Please run a tool' });
      const request = await requestOf(events, live.sessionId, 'permission');
      const answered = await api.post(`/api/sessions/${live.sessionId}/requests/${request.id}`, {
        decision: 'deny', message: 'Not now',
      });
      assert.equal(answered.status, 200, answered.text);
      const resolved = await resolutionOf(events, request.id);
      assert.equal(resolved.outcome, 'denied');
      assert.equal('auto' in resolved, false);
      const finished = await events.next(turnResult(live.sessionId, clientMessageId));
      assert.equal(finished.data.msg.subtype, 'success');
    } finally {
      await server.close();
    }
  });

  it('the saved value survives a restart with the same state directory, and it overrides CAW_UNATTENDED', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caw-unattended-state-'));
    /** @type {Array<{close: () => Promise<void>}>} */
    const running = [];
    try {
      const first = await startTestServer({ CAW_UNATTENDED: '1', CAW_STATE_DIR: stateDir });
      running.push(first);
      let api = client(first.url);
      await api.login();
      assert.equal((await api.get('/api/unattended')).json.enabled, true, 'no saved value yet: CAW_UNATTENDED applies');
      const saved = (await api.put('/api/unattended', { enabled: false })).json;
      await first.close();
      running.pop();

      const second = await startTestServer({ CAW_UNATTENDED: '1', CAW_STATE_DIR: stateDir });
      running.push(second);
      api = client(second.url);
      await api.login();
      assert.deepEqual((await api.get('/api/unattended')).json, saved);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateDir, 'unattended.json'), 'utf8')),
        { enabled: false, changedAt: saved.changedAt });
    } finally {
      for (const server of running) await server.close();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
