/**
 * Unit tests for unattended mode in the browser (public/js/unattended.js and what it feeds): the switch state, the
 * attention delay that keeps an auto-answered request out of sight, the timeline's auto records, the store fields, the
 * API helpers, the mode labels and the locale keys. Run in Node without a DOM; timers are injected, never waited for.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ATTENTION_DELAY_MS,
  attentionState,
  createAttentionTracker,
  modeCycleAllowed,
  newerUnattended,
  normalizeUnattended,
  unattendedSwitch,
  waitingBySession,
  waitingCount,
} from '../../public/js/unattended.js';
import { createModel } from '../../public/js/timeline/model.js';
import { toolTarget } from '../../public/js/timeline/tools/summaries.js';
import { createStore, store as appStore } from '../../public/js/store.js';
import { api } from '../../public/js/api.js';
import { modeShortKey, modeWordKey } from '../../public/js/ui/composer-logic.js';
import { getLocale, setLocale, t } from '../../public/js/i18n.js';
import '../../public/js/locales/en.core.js';
import '../../public/js/locales/zh-CN.core.js';
import '../../public/js/locales/en.composer.js';
import '../../public/js/locales/zh-CN.composer.js';
import '../../public/js/locales/en.cards.js';
import '../../public/js/locales/zh-CN.cards.js';

const ON = { available: true, enabled: true, reason: null, changedAt: 100 };
const OFF = { available: true, enabled: false, reason: null, changedAt: 50 };

/** A fake timer: `setTimer` records the callback, `fire` runs it, `clearTimer` drops it. */
function fakeTimers() {
  const timers = new Map();
  let next = 0;
  return {
    timers,
    setTimer(fn, ms) {
      next += 1;
      timers.set(next, { fn, ms });
      return next;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    fire(id) {
      const entry = timers.get(id);
      timers.delete(id);
      entry.fn();
    },
  };
}

describe('normalizeUnattended', () => {
  it('keeps a valid state and never reports enabled while unavailable', () => {
    assert.deepEqual(normalizeUnattended(ON), ON);
    assert.deepEqual(normalizeUnattended({ available: false, enabled: true, reason: 'not-allowed', changedAt: null }), {
      available: false, enabled: false, reason: 'not-allowed', changedAt: null,
    });
  });

  it('drops an unknown reason and a non-numeric change time, and rejects non-objects', () => {
    assert.deepEqual(normalizeUnattended({ available: true, enabled: false, reason: 'other', changedAt: '5' }), {
      available: true, enabled: false, reason: null, changedAt: null,
    });
    assert.equal(normalizeUnattended(null), null);
    assert.equal(normalizeUnattended('on'), null);
    assert.equal(normalizeUnattended(undefined), null);
  });
});

describe('newerUnattended', () => {
  it('takes the state that changed last, so an old answer cannot undo a change', () => {
    assert.equal(newerUnattended(ON, OFF), ON);
    assert.equal(newerUnattended(OFF, ON), ON);
  });

  it('keeps the current state for a missing incoming one, and takes the incoming one when nothing is current', () => {
    assert.equal(newerUnattended(ON, null), ON);
    assert.equal(newerUnattended(null, OFF), OFF);
    assert.equal(newerUnattended(undefined, null), null);
  });

  it('prefers the incoming state on a tie', () => {
    const tie = { ...OFF, changedAt: ON.changedAt };
    assert.equal(newerUnattended(ON, tie), tie);
  });
});

describe('unattendedSwitch', () => {
  it('is disabled and empty before the state is known', () => {
    assert.deepEqual(unattendedSwitch(null, 'full'), { checked: false, disabled: true, reason: null });
  });

  it('lets the full access profile switch it on this gateway', () => {
    assert.deepEqual(unattendedSwitch(OFF, 'full'), { checked: false, disabled: false, reason: null });
    assert.deepEqual(unattendedSwitch(ON, 'full'), { checked: true, disabled: false, reason: null });
  });

  it('shows the other profiles the switch read-only, with the profile as the reason', () => {
    assert.deepEqual(unattendedSwitch(ON, 'standard'), { checked: true, disabled: true, reason: 'profile' });
    assert.deepEqual(unattendedSwitch(OFF, 'read'), { checked: false, disabled: true, reason: 'profile' });
  });

  it('gives the gateway reason when bypass is not allowed here', () => {
    const blocked = { available: false, enabled: false, reason: 'not-allowed', changedAt: null };
    assert.deepEqual(unattendedSwitch(blocked, 'full'), { checked: false, disabled: true, reason: 'not-allowed' });
  });
});

describe('modeCycleAllowed', () => {
  it('forbids a change of the permission mode only while unattended mode is on', () => {
    assert.equal(modeCycleAllowed(ON), false);
    assert.equal(modeCycleAllowed(OFF), true);
    assert.equal(modeCycleAllowed(null), true);
  });
});

describe('attention counts', () => {
  it('counts settled requests per session and leaves out the sessions with none', () => {
    const pending = { s1: [{ id: 'a' }, { id: 'b' }], s2: [{ id: 'c' }], s3: 'not a list' };
    assert.deepEqual(waitingBySession(pending, (id) => id !== 'b'), { s1: 1, s2: 1 });
    assert.deepEqual(waitingBySession(pending, () => false), {});
  });

  it('counts a session the page has seen requests of by its settled ones, else by the gateway count', () => {
    const state = {
      pending: { s1: [{ id: 'a' }] }, attention: { s1: 0 }, live: { s1: { pendingCount: 1 } },
    };
    assert.equal(waitingCount(state, 's1'), 0, 'a request still inside the delay does not count');
    assert.equal(waitingCount({ ...state, attention: { s1: 1 } }, 's1'), 1);
    assert.equal(waitingCount({ pending: {}, attention: {}, live: { s2: { pendingCount: 2 } } }, 's2'), 2);
    assert.equal(waitingCount({ pending: {}, attention: {}, live: { s2: { pendingCount: 'x' } } }, 's2'), 0);
  });

  it('shows "running" instead of "requires_action" while no request has waited for the user', () => {
    assert.equal(attentionState({ state: 'requires_action' }, 0), 'running');
    assert.equal(attentionState({ state: 'requires_action' }, 2), 'requires_action');
    assert.equal(attentionState({ state: 'idle' }, 0), 'idle');
    assert.equal(attentionState(null, 0), null);
  });
});

describe('createAttentionTracker', () => {
  it('settles a request once its delay has run out unanswered', () => {
    const timers = fakeTimers();
    const settled = [];
    const tracker = createAttentionTracker({
      onSettle: (request) => settled.push(request.id), setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    });
    assert.equal(tracker.arrived({ id: 'r1' }), true);
    assert.equal(tracker.arrived({ id: 'r1' }), false, 'a second arrival of the same request starts nothing');
    const [[id, entry]] = [...timers.timers.entries()];
    assert.equal(entry.ms, ATTENTION_DELAY_MS);
    assert.equal(tracker.isSettled('r1'), false);
    timers.fire(id);
    assert.deepEqual(settled, ['r1']);
    assert.equal(tracker.isSettled('r1'), true);
  });

  it('settles nothing for a request the gateway resolves inside the delay', () => {
    const timers = fakeTimers();
    const settled = [];
    const tracker = createAttentionTracker({
      onSettle: (request) => settled.push(request.id), setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    });
    tracker.arrived({ id: 'r1' });
    assert.equal(tracker.resolved('r1'), false);
    assert.equal(timers.timers.size, 0, 'the delay is cancelled');
    assert.deepEqual(settled, []);
  });

  it('reports a resolved request that had settled, so the caller knows it was waiting', () => {
    const timers = fakeTimers();
    const tracker = createAttentionTracker({ setTimer: timers.setTimer, clearTimer: timers.clearTimer });
    tracker.arrived({ id: 'r1' });
    timers.fire([...timers.timers.keys()][0]);
    assert.equal(tracker.resolved('r1'), true);
    assert.equal(tracker.isSettled('r1'), false);
  });

  it('counts a snapshot request at once without a signal, and cancels its running delay', () => {
    const timers = fakeTimers();
    const settled = [];
    const tracker = createAttentionTracker({
      onSettle: (request) => settled.push(request.id), setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    });
    tracker.arrived({ id: 'r1' });
    tracker.settleNow([{ id: 'r1' }, { id: 'r2' }, { notAnId: true }]);
    assert.equal(timers.timers.size, 0);
    assert.equal(tracker.isSettled('r1'), true);
    assert.equal(tracker.isSettled('r2'), true);
    assert.deepEqual(settled, []);
  });

  it('forgets settled requests that are no longer kept, and resets everything', () => {
    const timers = fakeTimers();
    const tracker = createAttentionTracker({ setTimer: timers.setTimer, clearTimer: timers.clearTimer });
    tracker.settleNow([{ id: 'a' }, { id: 'b' }]);
    tracker.arrived({ id: 'c' });
    tracker.prune(new Set(['a']));
    assert.equal(tracker.isSettled('a'), true);
    assert.equal(tracker.isSettled('b'), false);
    tracker.reset();
    assert.equal(tracker.isSettled('a'), false);
    assert.equal(timers.timers.size, 0, 'a reset drops the running delays too');
  });
});

describe('timeline model: automatic answers', () => {
  const SESSION = 's1';
  const assistantWithTool = {
    type: 'assistant',
    uuid: 'a1',
    session_id: SESSION,
    message: {
      id: 'msg1',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tool1', name: 'Bash', input: { command: 'npm test' } }],
    },
  };

  function entriesOf(model) {
    return model.getEntries().flatMap((entry) => (entry.kind === 'work' ? entry.items : [entry]));
  }

  it('keeps a request out of the render until it has waited for the user', () => {
    const model = createModel({ now: () => 1 });
    model.applyLiveEvent(assistantWithTool);
    const request = { id: 'r1', sessionId: SESSION, kind: 'permission', toolName: 'Bash', toolUseId: 'tool1' };
    assert.equal(model.addPending(request), true);
    assert.equal(model.addPending(request), false, 'a repeated request is known already');
    assert.equal(model.getEntries().some((entry) => entry.kind === 'request'), false);
    assert.equal(model.getActivity()?.waiting ?? false, false, 'no "waiting" signal from a request still in its delay');
    model.settlePending('r1');
    assert.equal(model.getEntries().some((entry) => entry.kind === 'request'), true);
    assert.equal(model.getActivity()?.waiting, true);
  });

  it('turns a request the gateway answered on its own into one auto record, with no card', () => {
    const model = createModel({ now: () => 1 });
    model.applyLiveEvent(assistantWithTool);
    model.addPending({ id: 'r1', sessionId: SESSION, kind: 'permission', toolName: 'Bash', toolUseId: 'tool1',
      input: { command: 'npm test' } });
    model.resolvePending('r1', { auto: true });
    assert.equal(model.getEntries().some((entry) => entry.kind === 'request'), false);
    const autos = entriesOf(model).filter((entry) => entry.kind === 'auto');
    assert.equal(autos.length, 1);
    assert.equal(autos[0].requestKind, 'permission');
    assert.equal(autos[0].toolName, 'Bash');
    assert.deepEqual(autos[0].input, { command: 'npm test' });
    // The record lands in the flow of the tool it answers, so the tool's group keeps it in order.
    const tool = entriesOf(model).find((entry) => entry.kind === 'tool');
    assert.equal(tool?.id, 'tool1');
    assert.equal(model.getActivity()?.waiting ?? false, false);
  });

  it('leaves no record for a request resolved by the user or dropped inside its delay', () => {
    const model = createModel({ now: () => 1 });
    model.applyLiveEvent(assistantWithTool);
    model.addPending({ id: 'r1', sessionId: SESSION, kind: 'permission', toolName: 'Bash', toolUseId: 'tool1' });
    model.resolvePending('r1');
    model.addPending({ id: 'r2', sessionId: SESSION, kind: 'question', input: { questions: [] } });
    model.resolvePending('r2', { auto: false });
    assert.equal(entriesOf(model).some((entry) => entry.kind === 'auto'), false);
    assert.equal(model.getEntries().some((entry) => entry.kind === 'request'), false);
  });

  it('keeps the question an automatic answer replied to, for the record to show it collapsed', () => {
    const model = createModel({ now: () => 1 });
    model.addPending({
      id: 'q1', sessionId: SESSION, kind: 'question',
      input: { questions: [{ question: 'Which database?' }, { question: 'Which port?' }] },
    });
    model.resolvePending('q1', { auto: true });
    const [record] = model.getEntries().filter((entry) => entry.kind === 'auto');
    assert.equal(record.requestKind, 'question');
    assert.equal(record.questionText, 'Which database?\n\nWhich port?');
  });

  it('leaves a question unattended mode answered out of the turn\'s denied list', () => {
    const model = createModel({ now: () => 1 });
    model.applyLiveEvent({ type: 'user', uuid: 'u1', session_id: SESSION,
      message: { role: 'user', content: 'ask me first' }, parent_tool_use_id: null });
    model.applyLiveEvent({
      type: 'assistant', uuid: 'a2', session_id: SESSION, parent_tool_use_id: null,
      message: { id: 'msg2', role: 'assistant',
        content: [{ type: 'tool_use', id: 'ask1', name: 'AskUserQuestion', input: { questions: [] } }] },
    });
    model.addPending({ id: 'q2', sessionId: SESSION, kind: 'question', toolName: 'AskUserQuestion', toolUseId: 'ask1',
      input: { questions: [{ question: 'Which colour?' }] } });
    model.resolvePending('q2', { auto: true });
    model.applyLiveEvent({
      type: 'result', subtype: 'success', uuid: 'r9', session_id: SESSION, is_error: false, num_turns: 2,
      duration_ms: 10, permission_denials: [
        { tool_name: 'AskUserQuestion', tool_use_id: 'ask1', tool_input: {} },
        { tool_name: 'Bash', tool_use_id: 'bash9', tool_input: {} },
      ],
    });
    const [result] = model.getEntries().filter((entry) => entry.kind === 'result');
    assert.deepEqual(result.permissionDenials, [{ toolName: 'Bash' }],
      'the answered question is recorded as answered, and a real denial stays');
  });

  it('records the server of a form the gateway declined', () => {
    const model = createModel({ now: () => 1 });
    model.addPending({ id: 'e1', sessionId: SESSION, kind: 'elicitation', mcpServer: { name: 'notes', source: 'p' } });
    model.resolvePending('e1', { auto: true });
    const [record] = model.getEntries().filter((entry) => entry.kind === 'auto');
    assert.equal(record.requestKind, 'elicitation');
    assert.equal(record.serverName, 'notes');
  });

  it('shows a snapshot request at once, since it has waited already', () => {
    const model = createModel({ now: () => 1 });
    model.setPending([{ id: 'p1', sessionId: SESSION, kind: 'plan', input: {} }]);
    assert.equal(model.getEntries().some((entry) => entry.kind === 'request'), true);
  });
});

describe('toolTarget', () => {
  it('names the target a tool acts on, shortened to the session folder', () => {
    assert.equal(toolTarget('Edit', { file_path: '/work/app/src/a.js' }, '/work/app'), 'src/a.js');
    assert.equal(toolTarget('Bash', { command: 'npm test\nnpm run check' }), 'npm test');
    assert.equal(toolTarget('Grep', { pattern: 'fetchUser' }), 'fetchUser');
    assert.equal(toolTarget('WebFetch', { url: 'https://www.example.com/x' }), 'example.com');
  });

  it('has no target for an MCP tool or a missing input', () => {
    assert.equal(toolTarget('mcp__notes__save', { path: 'x' }), '');
    assert.equal(toolTarget('Bash', null), '');
  });
});

describe('store fields', () => {
  it('starts without a known unattended state and without any attention', () => {
    const fresh = createStore({ unattended: null, attention: {} });
    assert.equal(fresh.get().unattended, null);
    assert.deepEqual(fresh.get().attention, {});
    assert.equal(appStore.get().unattended, null);
    assert.deepEqual(appStore.get().attention, {});
  });

  it('notifies subscribers when the switch or the attention counts change', () => {
    const fresh = createStore({ unattended: null, attention: {} });
    const seen = [];
    fresh.subscribe((state) => seen.push(state.unattended?.enabled ?? null));
    fresh.set({ unattended: ON });
    fresh.set({ unattended: ON });
    assert.deepEqual(seen, [true]);
  });
});

describe('api helpers for the switch', () => {
  it('reads the state with GET and writes it with PUT and a JSON body', async (ctx) => {
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(ON), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    ctx.after(() => {
      globalThis.fetch = original;
    });
    assert.deepEqual(await api.unattended(), ON);
    assert.deepEqual(await api.setUnattended(true), ON);
    assert.equal(calls[0].url, '/api/unattended');
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[1].url, '/api/unattended');
    assert.equal(calls[1].init.method, 'PUT');
    assert.equal(calls[1].init.body, JSON.stringify({ enabled: true }));
  });
});

describe('mode labels while unattended mode is on', () => {
  it('names the mode as unattended instead of the session mode', () => {
    assert.equal(modeWordKey('acceptEdits', { unattended: true }), 'composer.modeWord.unattended');
    assert.equal(modeShortKey('plan', { unattended: true }), 'composer.modeShort.unattended');
    assert.equal(modeWordKey('acceptEdits'), 'composer.modeWord.acceptEdits');
    assert.equal(modeShortKey('plan', { unattended: false }), 'composer.modeShort.plan');
  });
});

describe('unattended locale keys', () => {
  const KEYS = [
    'shell.settings.permissions', 'shell.settings.unattended', 'shell.settings.unattendedHint',
    'shell.settings.unattended.notAllowed', 'shell.settings.unattended.profile', 'shell.unattended.confirmTitle',
    'shell.unattended.confirmBody', 'shell.unattended.confirm', 'header.unattended', 'header.unattended.tip',
    'composer.modeWord.unattended', 'composer.modeShort.unattended', 'cards.auto.permission', 'cards.auto.question',
    'cards.auto.questionShow', 'cards.auto.plan', 'cards.auto.elicitation', 'cards.auto.dialog',
  ];

  it('translates every key in English and in Simplified Chinese', () => {
    const before = getLocale();
    try {
      for (const locale of ['en', 'zh-CN']) {
        setLocale(locale);
        for (const key of KEYS) assert.notEqual(t(key), key, `${locale} has ${key}`);
      }
    } finally {
      setLocale(before);
    }
  });
});
