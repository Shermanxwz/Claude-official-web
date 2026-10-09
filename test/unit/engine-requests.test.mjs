import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { RequestRegistry, toPermissionResult, toElicitationResult } from '../../src/engine/requests.mjs';
import { AppError } from '../../src/contracts.mjs';

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const NOW = 1_700_000_000_000;

/** Registry wired to an event log; publish returns a running sequence number like the real hub. */
function harness() {
  const events = [];
  const registry = new RequestRegistry({
    publish: (event) => {
      events.push(event);
      return events.length;
    },
    now: () => NOW,
  });
  return { registry, events };
}

/** @param {Record<string, unknown>} [overrides] */
function permissionRequest(overrides = {}) {
  return {
    id: 'req-1',
    sessionId: S1,
    kind: 'permission',
    createdAt: 1,
    toolName: 'Bash',
    input: { command: 'ls' },
    suggestions: [
      {
        type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }], behavior: 'allow',
        destination: 'localSettings',
      },
      {
        type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'pwd' }], behavior: 'allow', destination: 'session',
      },
    ],
    ...overrides,
  };
}

/** @param {Record<string, unknown>} [overrides] */
function questionRequest(overrides = {}) {
  return { id: 'q-1', sessionId: S1, kind: 'question', createdAt: 1, toolName: 'AskUserQuestion',
    input: { questions: [{ question: 'Which?' }] }, ...overrides };
}

/** @param {Record<string, unknown>} [overrides] */
function planRequest(overrides = {}) {
  return { id: 'p-1', sessionId: S1, kind: 'plan', createdAt: 1, toolName: 'ExitPlanMode',
    input: { plan: '1. do it' }, ...overrides };
}

/** @param {Record<string, unknown>} [overrides] */
function elicitationRequest(overrides = {}) {
  return { id: 'e-1', sessionId: S1, kind: 'elicitation', createdAt: 1,
    elicitation: { serverName: 'docs', message: 'Name?', mode: 'form' }, ...overrides };
}

/** Asserts that fn throws an AppError with the given status and code. */
function assertAppError(fn, status, code) {
  assert.throws(fn, (error) => error instanceof AppError && error.status === status && error.code === code);
}

describe('RequestRegistry lifecycle', () => {
  test('create publishes the request and respond resolves it with the body', async () => {
    const { registry, events } = harness();
    const pending = registry.create(permissionRequest(), new AbortController().signal);
    assert.deepEqual(events, [
      { type: 'request', sessionId: S1, data: { request: permissionRequest() } },
    ]);
    registry.respond(S1, 'req-1', { decision: 'allow' });
    assert.deepEqual(await pending, { body: { decision: 'allow' } });
    assert.deepEqual(events[1], {
      type: 'request_resolved',
      sessionId: S1,
      data: { sessionId: S1, requestId: 'req-1', outcome: 'allowed' },
    });
    assert.equal(registry.count(S1), 0);
  });

  test('respond to an unknown id or another session is 404 REQUEST_NOT_FOUND', async () => {
    const { registry } = harness();
    const controller = new AbortController();
    const pending = registry.create(permissionRequest(), controller.signal);
    assertAppError(() => registry.respond(S1, 'missing', { decision: 'allow' }), 404, 'REQUEST_NOT_FOUND');
    assertAppError(() => registry.respond(S2, 'req-1', { decision: 'allow' }), 404, 'REQUEST_NOT_FOUND');
    assertAppError(() => registry.respond('not-a-session', 'req-1', { decision: 'allow' }), 404, 'REQUEST_NOT_FOUND');
    controller.abort();
    assert.deepEqual(await pending, { cancelled: true });
  });

  test('a second response to the same request is 404 once it settled', async () => {
    const { registry } = harness();
    const pending = registry.create(permissionRequest(), new AbortController().signal);
    registry.respond(S1, 'req-1', { decision: 'deny' });
    await pending;
    assertAppError(() => registry.respond(S1, 'req-1', { decision: 'allow' }), 404, 'REQUEST_NOT_FOUND');
  });

  test('an invalid body is rejected with 400 and the request stays pending', async () => {
    const { registry, events } = harness();
    const pending = registry.create(permissionRequest(), new AbortController().signal);
    assertAppError(() => registry.respond(S1, 'req-1', { decision: 'maybe' }), 400, 'BAD_REQUEST');
    assert.equal(registry.count(S1), 1);
    assert.equal(events.length, 1);
    registry.respond(S1, 'req-1', { decision: 'allow' });
    assert.deepEqual(await pending, { body: { decision: 'allow' } });
  });

  test('a settled request no longer reacts to its abort signal', async () => {
    const { registry, events } = harness();
    const controller = new AbortController();
    const pending = registry.create(permissionRequest(), controller.signal);
    registry.respond(S1, 'req-1', { decision: 'allow' });
    await pending;
    controller.abort();
    assert.equal(events.length, 2);
  });

  test('aborting the signal resolves cancelled, removes the request and publishes the outcome', async () => {
    const { registry, events } = harness();
    const controller = new AbortController();
    const pending = registry.create(permissionRequest(), controller.signal);
    controller.abort();
    assert.deepEqual(await pending, { cancelled: true });
    assert.equal(registry.count(S1), 0);
    assert.deepEqual(events[1], {
      type: 'request_resolved',
      sessionId: S1,
      data: { sessionId: S1, requestId: 'req-1', outcome: 'cancelled' },
    });
  });

  test('a signal that is already aborted resolves cancelled without publishing anything', async () => {
    const { registry, events } = harness();
    const controller = new AbortController();
    controller.abort();
    assert.deepEqual(await registry.create(permissionRequest(), controller.signal), { cancelled: true });
    assert.equal(events.length, 0);
    assert.equal(registry.count(S1), 0);
  });

  test('create without a signal stays pending until responded', async () => {
    const { registry } = harness();
    const pending = registry.create(permissionRequest());
    assert.equal(registry.count(S1), 1);
    registry.respond(S1, 'req-1', { decision: 'deny', message: 'no' });
    assert.deepEqual(await pending, { body: { decision: 'deny', message: 'no' } });
  });

  test('createdAt defaults to the injected clock when the request lacks it', () => {
    const { registry, events } = harness();
    registry.create(permissionRequest({ createdAt: undefined }));
    assert.equal(events[0].data.request.createdAt, NOW);
  });

  test('duplicate ids are refused within a session but allowed across sessions', () => {
    const { registry } = harness();
    registry.create(permissionRequest());
    assert.throws(() => registry.create(permissionRequest()), /already exists/);
    assert.doesNotThrow(() => registry.create(permissionRequest({ sessionId: S2 })));
    assert.equal(registry.has(S1, 'req-1'), true);
    assert.equal(registry.has(S2, 'req-1'), true);
  });

  test('create rejects requests without an id or session id', () => {
    const { registry } = harness();
    assert.throws(() => registry.create(permissionRequest({ id: '' })), TypeError);
    assert.throws(() => registry.create(permissionRequest({ sessionId: undefined })), TypeError);
  });

  test('list, count and has report pending requests per session in creation order', () => {
    const { registry } = harness();
    registry.create(permissionRequest({ id: 'a' }));
    registry.create(permissionRequest({ id: 'b' }));
    registry.create(permissionRequest({ id: 'c', sessionId: S2 }));
    assert.deepEqual(registry.list(S1).map((r) => r.id), ['a', 'b']);
    assert.deepEqual(registry.list(S2).map((r) => r.id), ['c']);
    assert.deepEqual(registry.list('33333333-3333-4333-8333-333333333333'), []);
    assert.equal(registry.count(S1), 2);
    assert.equal(registry.has(S1, 'c'), false);
  });

  test('cancelSession cancels only that session and returns how many were cancelled', async () => {
    const { registry, events } = harness();
    const first = registry.create(permissionRequest({ id: 'a' }));
    const second = registry.create(questionRequest({ id: 'b' }));
    const other = registry.create(planRequest({ id: 'c', sessionId: S2 }));
    assert.equal(registry.cancelSession(S1), 2);
    assert.deepEqual(await first, { cancelled: true });
    assert.deepEqual(await second, { cancelled: true });
    assert.equal(registry.count(S1), 0);
    assert.equal(registry.count(S2), 1);
    assert.equal(events.filter((e) => e.type === 'request_resolved' && e.data.outcome === 'cancelled').length, 2);
    assert.equal(registry.cancelSession(S1), 0);
    registry.respond(S2, 'c', { decision: 'approve' });
    assert.deepEqual(await other, { body: { decision: 'approve' } });
  });

  test('cancelAll cancels every session', async () => {
    const { registry, events } = harness();
    const a = registry.create(permissionRequest({ id: 'a' }));
    const b = registry.create(elicitationRequest({ id: 'b', sessionId: S2 }));
    registry.cancelAll();
    assert.deepEqual(await a, { cancelled: true });
    assert.deepEqual(await b, { cancelled: true });
    assert.equal(registry.count(S1) + registry.count(S2), 0);
    assert.equal(events.filter((e) => e.type === 'request_resolved').length, 2);
  });
});

describe('RequestRegistry permission bodies', () => {
  const valid = [
    { decision: 'allow' },
    { decision: 'allow', updatedInput: { command: 'pwd' }, message: 'ok', interrupt: false },
    { decision: 'allow_always' },
    { decision: 'allow_always', suggestionIndexes: [1] },
    { decision: 'allow_always', suggestionIndexes: [] },
    { decision: 'deny' },
    { decision: 'deny', message: 'no thanks', interrupt: true },
    { decision: 'deny', message: 'x'.repeat(2000) },
  ];
  for (const body of valid) {
    test(`accepts ${JSON.stringify(body).slice(0, 80)}`, () => {
      const { registry } = harness();
      const pending = registry.create(permissionRequest());
      registry.respond(S1, 'req-1', body);
      return pending.then((outcome) => assert.ok('body' in outcome));
    });
  }

  const invalid = [
    null, 'allow', ['allow'], 42,
    {},
    { decision: 'maybe' },
    { decision: 'allow', unexpected: 1 },
    { decision: 'deny', message: 42 },
    { decision: 'deny', message: 'x'.repeat(2001) },
    { decision: 'allow', updatedInput: [] },
    { decision: 'allow', updatedInput: 'command' },
    { decision: 'allow', updatedInput: null },
    { decision: 'allow', interrupt: 'yes' },
    { decision: 'allow_always', suggestionIndexes: [2] },
    { decision: 'allow_always', suggestionIndexes: [0, 0] },
    { decision: 'allow_always', suggestionIndexes: [-1] },
    { decision: 'allow_always', suggestionIndexes: [0.5] },
    { decision: 'allow_always', suggestionIndexes: ['0'] },
    { decision: 'allow_always', suggestionIndexes: 0 },
  ];
  for (const body of invalid) {
    test(`rejects ${JSON.stringify(body)}`, () => {
      const { registry } = harness();
      registry.create(permissionRequest());
      assertAppError(() => registry.respond(S1, 'req-1', body), 400, 'BAD_REQUEST');
      assert.equal(registry.count(S1), 1);
    });
  }

  test('allow_always is refused when the request suppresses the always-allow rule', () => {
    const { registry } = harness();
    registry.create(permissionRequest({ suppressAlwaysAllowRule: true }));
    assertAppError(() => registry.respond(S1, 'req-1', { decision: 'allow_always' }), 400, 'BAD_REQUEST');
    registry.respond(S1, 'req-1', { decision: 'allow' });
  });

  test('suggestion indexes are checked against the suggestions the request offers', () => {
    const { registry } = harness();
    registry.create(permissionRequest({ suggestions: [] }));
    assertAppError(() => registry.respond(S1, 'req-1', { decision: 'allow_always', suggestionIndexes: [0] }),
      400, 'BAD_REQUEST');
  });

  test('the stored body keeps only the validated fields', async () => {
    const { registry } = harness();
    const pending = registry.create(permissionRequest());
    registry.respond(S1, 'req-1', { decision: 'deny', message: 'nope', interrupt: true });
    assert.deepEqual(await pending, { body: { decision: 'deny', message: 'nope', interrupt: true } });
  });

  test('outcome names: allow and allow_always are allowed, deny is denied', async () => {
    const outcomes = {};
    for (const decision of ['allow', 'allow_always', 'deny']) {
      const { registry, events } = harness();
      const pending = registry.create(permissionRequest());
      registry.respond(S1, 'req-1', { decision });
      await pending;
      outcomes[decision] = events[1].data.outcome;
    }
    assert.deepEqual(outcomes, { allow: 'allowed', allow_always: 'allowed', deny: 'denied' });
  });
});

describe('RequestRegistry question bodies', () => {
  test('accepts answers with and without a free-text response', async () => {
    const { registry, events } = harness();
    const first = registry.create(questionRequest({ id: 'q-a' }));
    registry.respond(S1, 'q-a', { answers: { 'Which?': 'A' } });
    assert.deepEqual(await first, { body: { answers: { 'Which?': 'A' } } });
    assert.equal(events[1].data.outcome, 'answered');

    const second = registry.create(questionRequest({ id: 'q-b' }));
    registry.respond(S1, 'q-b', { answers: { 'Pick many': ['A', 'B'] }, response: 'thanks' });
    assert.deepEqual(await second, { body: { answers: { 'Pick many': ['A', 'B'] }, response: 'thanks' } });
  });

  test('accepts a decline and reports it as denied', async () => {
    const { registry, events } = harness();
    const pending = registry.create(questionRequest());
    registry.respond(S1, 'q-1', { decline: true });
    assert.deepEqual(await pending, { body: { decline: true } });
    assert.equal(events[1].data.outcome, 'denied');
  });

  const invalid = [
    { decline: false },
    { decline: true, answers: {} },
    { answers: {} , extra: true },
    {},
    { answers: 'A' },
    { answers: ['A'] },
    { answers: null },
    { answers: { question: 1 } },
    { answers: { question: null } },
    { answers: { question: ['A', 2] } },
    { answers: { question: 'A' }, response: 5 },
    { answers: { question: 'A' }, response: 'x'.repeat(10001) },
  ];
  for (const body of invalid) {
    test(`rejects ${JSON.stringify(body)}`, () => {
      const { registry } = harness();
      registry.create(questionRequest());
      assertAppError(() => registry.respond(S1, 'q-1', body), 400, 'BAD_REQUEST');
      assert.equal(registry.count(S1), 1);
    });
  }

  test('answers keep a key named __proto__ as ordinary data', async () => {
    const { registry } = harness();
    const pending = registry.create(questionRequest());
    registry.respond(S1, 'q-1', JSON.parse('{"answers":{"__proto__":"polluted"}}'));
    const outcome = await pending;
    assert.equal(Object.getPrototypeOf(outcome.body.answers), Object.prototype);
    assert.equal(outcome.body.answers.__proto__, 'polluted');
  });
});

describe('RequestRegistry plan bodies', () => {
  const valid = [
    { decision: 'approve' },
    { decision: 'approve', nextMode: 'acceptEdits' },
    { decision: 'approve', nextMode: 'auto', message: 'go' },
    { decision: 'reject', message: 'revise the second step' },
    { decision: 'approve', message: 'x'.repeat(10000) },
  ];
  for (const body of valid) {
    test(`accepts ${JSON.stringify(body).slice(0, 80)}`, async () => {
      const { registry } = harness();
      const pending = registry.create(planRequest());
      registry.respond(S1, 'p-1', body);
      assert.deepEqual(await pending, { body });
    });
  }

  const invalid = [
    {}, { decision: 'maybe' }, { decision: 'approve', nextMode: 'plan' }, { decision: 'approve', nextMode: null },
    { decision: 'reject', message: 'x'.repeat(10001) }, { decision: 'approve', extra: true },
  ];
  for (const body of invalid) {
    test(`rejects ${JSON.stringify(body)}`, () => {
      const { registry } = harness();
      registry.create(planRequest());
      assertAppError(() => registry.respond(S1, 'p-1', body), 400, 'BAD_REQUEST');
    });
  }

  test('approve is allowed and reject is denied', async () => {
    const { registry, events } = harness();
    const approved = registry.create(planRequest({ id: 'p-a' }));
    registry.respond(S1, 'p-a', { decision: 'approve' });
    await approved;
    const rejected = registry.create(planRequest({ id: 'p-b' }));
    registry.respond(S1, 'p-b', { decision: 'reject' });
    await rejected;
    assert.equal(events[1].data.outcome, 'allowed');
    assert.equal(events[3].data.outcome, 'denied');
  });
});

describe('RequestRegistry elicitation bodies', () => {
  const valid = [
    { action: 'accept' },
    { action: 'accept', content: { name: 'Ada', count: 2, ok: true, tags: ['a', 'b'] } },
    { action: 'accept', content: {} },
    { action: 'decline' },
    { action: 'cancel' },
  ];
  for (const body of valid) {
    test(`accepts ${JSON.stringify(body)}`, () => {
      const { registry } = harness();
      registry.create(elicitationRequest());
      registry.respond(S1, 'e-1', body);
      assert.equal(registry.count(S1), 0);
    });
  }

  const invalid = [
    { action: 'maybe' }, { action: 'accept', content: 'x' }, { action: 'accept', content: { nested: { a: 1 } } },
    { action: 'accept', content: { n: Number.NaN } }, { action: 'accept', content: { arr: [1] } },
    { action: 'accept', content: { ok: null } }, { extra: 1 }, {},
  ];
  for (const body of invalid) {
    test(`rejects ${JSON.stringify(body)}`, () => {
      const { registry } = harness();
      registry.create(elicitationRequest());
      assertAppError(() => registry.respond(S1, 'e-1', body), 400, 'BAD_REQUEST');
    });
  }

  test('accept is allowed while decline and cancel are denied', async () => {
    const { registry, events } = harness();
    const accepted = registry.create(elicitationRequest({ id: 'e-a' }));
    registry.respond(S1, 'e-a', { action: 'accept', content: { name: 'Ada' } });
    assert.deepEqual(await accepted, { body: { action: 'accept', content: { name: 'Ada' } } });
    const declined = registry.create(elicitationRequest({ id: 'e-b' }));
    registry.respond(S1, 'e-b', { action: 'decline' });
    await declined;
    const cancelled = registry.create(elicitationRequest({ id: 'e-c' }));
    registry.respond(S1, 'e-c', { action: 'cancel' });
    await cancelled;
    assert.deepEqual(events.filter((e) => e.type === 'request_resolved').map((e) => e.data.outcome),
      ['allowed', 'denied', 'denied']);
  });
});

describe('toPermissionResult', () => {
  const request = permissionRequest();
  const suggestions = request.suggestions;

  test('allow uses the body input, else the request input, else an empty object', () => {
    assert.deepEqual(toPermissionResult(request, { body: { decision: 'allow' } }),
      { behavior: 'allow', updatedInput: { command: 'ls' } });
    assert.deepEqual(toPermissionResult(request, { body: { decision: 'allow', updatedInput: { command: 'pwd' } } }),
      { behavior: 'allow', updatedInput: { command: 'pwd' } });
    assert.deepEqual(toPermissionResult(permissionRequest({ input: undefined }), { body: { decision: 'allow' } }),
      { behavior: 'allow', updatedInput: {} });
  });

  test('allow_always persists all suggestions by default', () => {
    assert.deepEqual(toPermissionResult(request, { body: { decision: 'allow_always' } }),
      { behavior: 'allow', updatedInput: { command: 'ls' }, updatedPermissions: suggestions });
  });

  test('allow_always persists only the selected suggestions in the order given', () => {
    const result = toPermissionResult(request, { body: { decision: 'allow_always', suggestionIndexes: [1] } });
    assert.deepEqual(result.updatedPermissions, [suggestions[1]]);
    const reordered = toPermissionResult(request, { body: { decision: 'allow_always', suggestionIndexes: [1, 0] } });
    assert.deepEqual(reordered.updatedPermissions, [suggestions[1], suggestions[0]]);
  });

  test('allow_always omits updatedPermissions when there is nothing to persist', () => {
    const none = permissionRequest({ suggestions: undefined });
    assert.deepEqual(toPermissionResult(none, { body: { decision: 'allow_always' } }),
      { behavior: 'allow', updatedInput: { command: 'ls' } });
    assert.deepEqual(toPermissionResult(request, { body: { decision: 'allow_always', suggestionIndexes: [] } }),
      { behavior: 'allow', updatedInput: { command: 'ls' } });
  });

  test('deny carries the default message and a false interrupt flag', () => {
    assert.deepEqual(toPermissionResult(request, { body: { decision: 'deny' } }),
      { behavior: 'deny', message: 'The user denied this action.', interrupt: false });
    assert.deepEqual(toPermissionResult(request, { body: { decision: 'deny', message: 'no', interrupt: true } }),
      { behavior: 'deny', message: 'no', interrupt: true });
  });

  test('question answers become the updated input, with the response only when non-empty', () => {
    const question = questionRequest();
    assert.deepEqual(toPermissionResult(question, { body: { answers: { 'Which?': 'A' } } }), {
      behavior: 'allow',
      updatedInput: { questions: [{ question: 'Which?' }], answers: { 'Which?': 'A' } },
    });
    assert.deepEqual(toPermissionResult(question, { body: { answers: { q: 'A' }, response: 'why' } }), {
      behavior: 'allow',
      updatedInput: { questions: [{ question: 'Which?' }], answers: { q: 'A' }, response: 'why' },
    });
    assert.deepEqual(toPermissionResult(question, { body: { answers: { q: 'A' }, response: '' } }).updatedInput,
      { questions: [{ question: 'Which?' }], answers: { q: 'A' } });
  });

  test('question decline is a deny with the decline message', () => {
    assert.deepEqual(toPermissionResult(questionRequest(), { body: { decline: true } }),
      { behavior: 'deny', message: 'The user declined to answer.' });
  });

  test('plan approve allows with the plan input and reject denies with the feedback', () => {
    assert.deepEqual(toPermissionResult(planRequest(), { body: { decision: 'approve' } }),
      { behavior: 'allow', updatedInput: { plan: '1. do it' } });
    assert.deepEqual(toPermissionResult(planRequest({ input: undefined }), { body: { decision: 'approve' } }),
      { behavior: 'allow', updatedInput: {} });
    assert.deepEqual(toPermissionResult(planRequest(), { body: { decision: 'reject', message: 'split step 2' } }),
      { behavior: 'deny', message: 'split step 2' });
    assert.deepEqual(toPermissionResult(planRequest(), { body: { decision: 'reject' } }),
      { behavior: 'deny', message: 'The user rejected the plan. Revise it.' });
  });

  test('cancelled outcomes deny with the cancellation message for every kind', () => {
    for (const req of [permissionRequest(), questionRequest(), planRequest()]) {
      assert.deepEqual(toPermissionResult(req, { cancelled: true }), {
        behavior: 'deny', message: 'Request cancelled.',
      });
    }
  });

  test('elicitation requests are refused by this mapper', () => {
    assert.throws(() => toPermissionResult(elicitationRequest(), { cancelled: true }), TypeError);
  });
});

describe('toElicitationResult', () => {
  test('cancelled becomes a cancel action', () => {
    assert.deepEqual(toElicitationResult({ cancelled: true }), { action: 'cancel' });
  });

  test('accept keeps the content when present and omits the key otherwise', () => {
    assert.deepEqual(toElicitationResult({ body: { action: 'accept', content: { name: 'Ada' } } }),
      { action: 'accept', content: { name: 'Ada' } });
    assert.deepEqual(toElicitationResult({ body: { action: 'accept' } }), { action: 'accept' });
  });

  test('decline and cancel actions pass through', () => {
    assert.deepEqual(toElicitationResult({ body: { action: 'decline' } }), { action: 'decline' });
    assert.deepEqual(toElicitationResult({ body: { action: 'cancel' } }), { action: 'cancel' });
  });
});
