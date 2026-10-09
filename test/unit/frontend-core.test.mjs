/**
 * Unit tests for the browser core, run in Node without a DOM: i18n and the shared locale catalogs, the API client
 * and its error mapping, the SSE reconnect schedule, the store and its preferences, and the sidebar's pure helpers.
 * Browser globals (fetch, EventSource, crypto, queueMicrotask) are replaced only inside the tests that need them,
 * and restored before the next test starts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  getLocale,
  normalizeLocale,
  onLocaleChange,
  registerMessages,
  setLocale,
  t,
} from '../../public/js/i18n.js';
import '../../public/js/locales/en.core.js';
import '../../public/js/locales/zh-CN.core.js';
import {
  ApiError,
  EVENT_TYPES,
  api,
  connectEvents,
  createUuid,
  errorText,
  reconnectDelayMs,
} from '../../public/js/api.js';
import {
  FONT_SIZES,
  THEMES,
  createStore,
  defaultPrefs,
  normalizePrefs,
  store,
} from '../../public/js/store.js';
import {
  filterSessions,
  formatClock,
  formatRelativeTime,
  groupSessions,
  liveTone,
  mergeLive,
  projectName,
  queryTerms,
  retitledState,
  sessionActivity,
  sessionCwd,
  sessionTitle,
} from '../../public/js/ui/sidebar-model.js';
import { accountFacts, validSignInCode } from '../../public/js/ui/account.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const CATALOG_EN = new URL('../../public/js/locales/en.core.js', import.meta.url);
const CATALOG_ZH = new URL('../../public/js/locales/zh-CN.core.js', import.meta.url);

/** Modules whose literal shell.* and common.* keys must exist in both catalogs. */
const OWNED_MODULES = [
  '../../public/js/main.js',
  '../../public/js/api.js',
  '../../public/js/store.js',
  '../../public/js/ui/app-shell.js',
  '../../public/js/ui/sidebar.js',
  '../../public/js/ui/login.js',
  '../../public/js/ui/new-session.js',
  '../../public/js/ui/dialog.js',
  '../../public/js/ui/toasts.js',
  '../../public/js/ui/menu.js',
  '../../public/js/ui/panels.js',
  '../../public/js/ui/runtime-panels.js',
  '../../public/js/ui/devtools.js',
  '../../public/js/ui/quick-switcher.js',
  '../../public/js/ui/account.js',
];

/** Every error code in docs/PROTOCOL.md, plus NETWORK for requests that never reached the gateway. */
const PROTOCOL_ERROR_CODES = [
  'NETWORK', 'BAD_REQUEST', 'UNAUTHENTICATED', 'INVALID_TOKEN', 'ORIGIN_REJECTED', 'FORBIDDEN', 'NOT_FOUND',
  'SESSION_NOT_FOUND', 'REQUEST_NOT_FOUND', 'SESSION_LOCKED', 'SESSION_NOT_LIVE', 'CONFLICT', 'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE', 'PATH_NOT_ALLOWED', 'INVALID_ARGUMENT', 'CANNOT_REWIND', 'RATE_LIMITED',
  'TOO_MANY_SESSIONS', 'INTERNAL', 'FEATURE_DISABLED', 'ENGINE_ERROR', 'ENGINE_UNAVAILABLE',
  'HOST_REJECTED', 'TOO_MANY_STREAMS',
];

registerMessages('en', {
  'test.greeting': 'Hello {name}',
  'test.repeat': '{name} and {name}',
  'test.total': 'Total: {n}',
  'test.english': 'English only',
  'test.both': 'English value',
});
registerMessages('zh-CN', {
  'test.greeting': '你好，{name}',
  'test.both': '中文值',
});

/** Run `fn` with queueMicrotask swapped for a recorder, so deferred rethrows can be inspected instead of crashing. */
function captureMicrotasks(fn) {
  const queued = [];
  const original = globalThis.queueMicrotask;
  globalThis.queueMicrotask = (callback) => {
    queued.push(callback);
  };
  try {
    fn();
  } finally {
    globalThis.queueMicrotask = original;
  }
  return queued;
}

/**
 * Replace a global for the current test. The returned function restores the original property, or removes the
 * global again when there was none.
 */
function stubGlobal(name, value) {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  return () => {
    if (original) Object.defineProperty(globalThis, name, original);
    else delete globalThis[name];
  };
}

/** Route every fetch through `handler` and record each call. */
function stubFetch(ctx, handler) {
  const calls = [];
  ctx.after(stubGlobal('fetch', async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }));
  return calls;
}

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/**
 * Stand-in EventSource. Each instance is recorded, and the test drives open, error and frame events by hand.
 */
function stubEventSource(ctx) {
  const streams = [];
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.closed = false;
      this.onopen = null;
      this.onerror = null;
      this.listeners = new Map();
      streams.push(this);
    }

    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(listener);
    }

    close() {
      this.closed = true;
    }

    /** The connection opened. */
    open() {
      this.onopen?.({ type: 'open' });
    }

    /** The connection failed. */
    fail() {
      this.onerror?.({ type: 'error' });
    }

    /** A frame arrived with raw `data` and SSE id `lastEventId`. */
    frame(type, data, lastEventId = '') {
      for (const listener of this.listeners.get(type) ?? []) listener({ type, data, lastEventId });
    }
  }
  ctx.after(stubGlobal('EventSource', FakeEventSource));
  return streams;
}

/** Message keys defined in a catalog source file. Every entry starts a line as `'key':`. */
function keysOf(url) {
  return new Set([...readFileSync(url, 'utf8').matchAll(/^\s*'([^']+)'\s*:/gm)].map((match) => match[1]));
}

describe('i18n', () => {
  it('maps language tags onto the two supported locales', () => {
    assert.equal(normalizeLocale('zh'), 'zh-CN');
    assert.equal(normalizeLocale('zh-CN'), 'zh-CN');
    assert.equal(normalizeLocale('zh_TW'), 'zh-CN');
    assert.equal(normalizeLocale('  ZH-hans-CN '), 'zh-CN');
    assert.equal(normalizeLocale('en'), 'en');
    assert.equal(normalizeLocale('en_US'), 'en');
    assert.equal(normalizeLocale('EN-gb'), 'en');
  });

  it('returns null for unsupported or non-string tags', () => {
    assert.equal(normalizeLocale('fr-FR'), null);
    assert.equal(normalizeLocale('english'), null);
    assert.equal(normalizeLocale('zhuang'), null);
    assert.equal(normalizeLocale(''), null);
    assert.equal(normalizeLocale(undefined), null);
    assert.equal(normalizeLocale(null), null);
    assert.equal(normalizeLocale(42), null);
  });

  it('interpolates named placeholders, including repeats and numbers', () => {
    setLocale('en');
    assert.equal(t('test.greeting', { name: 'Ada' }), 'Hello Ada');
    assert.equal(t('test.repeat', { name: 'Ada' }), 'Ada and Ada');
    assert.equal(t('test.total', { n: 0 }), 'Total: 0');
    assert.equal(t('test.total', { n: 1200 }), 'Total: 1200');
  });

  it('inserts values literally, without reading replacement patterns such as $&', () => {
    setLocale('en');
    assert.equal(t('test.greeting', { name: '$&$1' }), 'Hello $&$1');
  });

  it('leaves placeholders without a value in place, and returns the template when no values are given', () => {
    setLocale('en');
    assert.equal(t('test.greeting'), 'Hello {name}');
    assert.equal(t('test.greeting', {}), 'Hello {name}');
    assert.equal(t('test.greeting', { other: 'x' }), 'Hello {name}');
  });

  it('uses the active locale and falls back to English for keys the active locale lacks', () => {
    setLocale('zh-CN');
    assert.equal(t('test.greeting', { name: 'Ada' }), '你好，Ada');
    assert.equal(t('test.both'), '中文值');
    assert.equal(t('test.english'), 'English only');
    setLocale('en');
    assert.equal(t('test.both'), 'English value');
  });

  it('returns the key itself when no locale defines it, even with values supplied', () => {
    setLocale('en');
    assert.equal(t('test.missing.key'), 'test.missing.key');
    assert.equal(t('test.missing.key', { a: 1 }), 'test.missing.key');
  });

  it('merges registrations per locale and rejects unsupported locales', () => {
    registerMessages('en', { 'test.merge.a': 'A' });
    registerMessages('en', { 'test.merge.b': 'B' });
    setLocale('en');
    assert.equal(t('test.merge.a'), 'A');
    assert.equal(t('test.merge.b'), 'B');
    assert.throws(() => registerMessages('fr', {}), TypeError);
  });

  it('normalizes the locale on change, notifies only real changes, and stops after unsubscribe', (ctx) => {
    setLocale('en');
    const seen = [];
    const off = onLocaleChange((locale) => seen.push(locale));
    ctx.after(off);
    setLocale('zh_TW');
    assert.equal(getLocale(), 'zh-CN');
    setLocale('zh-CN');
    setLocale('xx');
    assert.equal(getLocale(), 'en');
    off();
    setLocale('zh-CN');
    assert.deepEqual(seen, ['zh-CN', 'en']);
    setLocale('en');
  });

  it('keeps notifying other listeners when one throws, and reports that error asynchronously', () => {
    setLocale('en');
    const boom = new Error('listener failed');
    const seen = [];
    const offThrowing = onLocaleChange(() => {
      throw boom;
    });
    const offOther = onLocaleChange((locale) => seen.push(locale));
    try {
      const queued = captureMicrotasks(() => setLocale('zh-CN'));
      assert.deepEqual(seen, ['zh-CN']);
      assert.equal(queued.length, 1);
      assert.throws(() => queued[0](), (error) => error === boom);
    } finally {
      offThrowing();
      offOther();
      setLocale('en');
    }
  });
});

describe('shared catalogs (common.* and shell.*)', () => {
  it('define the same keys in English and Chinese', () => {
    const en = keysOf(CATALOG_EN);
    const zh = keysOf(CATALOG_ZH);
    assert.ok(en.size > 200, `expected the full catalog, found ${en.size} keys`);
    assert.deepEqual([...en].filter((key) => !zh.has(key)).sort(), []);
    assert.deepEqual([...zh].filter((key) => !en.has(key)).sort(), []);
  });

  it('keep the same {placeholders} in both languages', () => {
    const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(',');
    const mismatches = [];
    for (const key of keysOf(CATALOG_EN)) {
      setLocale('en');
      const english = placeholders(t(key));
      setLocale('zh-CN');
      const chinese = placeholders(t(key));
      if (english !== chinese) mismatches.push(`${key}: [${english}] vs [${chinese}]`);
    }
    setLocale('en');
    assert.deepEqual(mismatches, []);
  });

  it('have a message for every protocol error code in both languages', () => {
    const en = keysOf(CATALOG_EN);
    const zh = keysOf(CATALOG_ZH);
    for (const code of PROTOCOL_ERROR_CODES) {
      assert.ok(en.has(`common.error.${code}`), `en is missing common.error.${code}`);
      assert.ok(zh.has(`common.error.${code}`), `zh-CN is missing common.error.${code}`);
    }
  });

  it('cover every shell.* and common.* key that the owned modules use', () => {
    const en = keysOf(CATALOG_EN);
    const zh = keysOf(CATALOG_ZH);
    /** A key ending in '.' is a dynamic prefix such as 'shell.caps.' + kind, so any key under it will do. */
    const defined = (set, key) => (key.endsWith('.') ? [...set].some((entry) => entry.startsWith(key)) : set.has(key));
    const missing = [];
    for (const file of OWNED_MODULES) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      const literal = [...source.matchAll(/'((?:shell|common)\.[\w.-]*)'/g)].map((match) => match[1]);
      const templated = [...source.matchAll(/`((?:shell|common)\.[\w.-]*?)\$\{/g)].map((match) => match[1]);
      for (const key of [...literal, ...templated]) {
        if (!defined(en, key)) missing.push(`en: ${key} (${file})`);
        if (!defined(zh, key)) missing.push(`zh-CN: ${key} (${file})`);
      }
    }
    assert.deepEqual(missing, []);
  });
});

describe('errorText', () => {
  it('asks the translator for common.error.<CODE> and passes the retry delay', () => {
    const calls = [];
    const text = errorText(new ApiError(429, 'RATE_LIMITED', 'Slow down', 12), (key, vars) => {
      calls.push([key, vars]);
      return `translated ${key}`;
    });
    assert.equal(text, 'translated common.error.RATE_LIMITED');
    assert.deepEqual(calls, [['common.error.RATE_LIMITED', { seconds: 12 }]]);
  });

  it('localizes rate limits with the wait in seconds, in both languages', () => {
    setLocale('en');
    assert.equal(errorText(new ApiError(429, 'RATE_LIMITED', 'x', 7), t), 'Too many attempts. Try again in 7 seconds.');
    setLocale('zh-CN');
    assert.equal(errorText(new ApiError(429, 'RATE_LIMITED', 'x', 7), t), '尝试次数过多，7 秒后再试。');
    setLocale('en');
  });

  it('localizes requests that never reached the gateway', () => {
    setLocale('en');
    assert.equal(errorText(new ApiError(0, 'NETWORK', 'Network request failed'), t), t('common.error.NETWORK'));
  });

  it('uses the server message for a code the client does not know', () => {
    setLocale('en');
    assert.equal(
      errorText(new ApiError(422, 'SOMETHING_NEW', 'The model name is not known.'), t),
      'The model name is not known.',
    );
  });

  it('shows the generic line when there is no usable message, and never a raw error message', () => {
    setLocale('en');
    const generic = t('common.error.INTERNAL');
    assert.equal(errorText(new ApiError(500, 'SOMETHING_NEW', ''), t), generic);
    assert.equal(errorText(new Error('password is hunter2'), t), generic);
    assert.equal(errorText('plain string', t), generic);
  });
});

describe('ApiError and event types', () => {
  it('carries status, code, message and the retry delay', () => {
    const error = new ApiError(429, 'RATE_LIMITED', 'Slow down', 3);
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'ApiError');
    assert.equal(error.status, 429);
    assert.equal(error.code, 'RATE_LIMITED');
    assert.equal(error.message, 'Slow down');
    assert.equal(error.retryAfter, 3);
  });

  it('lists the thirteen event types from docs/PROTOCOL.md, and the list is frozen', () => {
    assert.deepEqual([...EVENT_TYPES].sort(), [
      'account_changed', 'heartbeat', 'hello', 'message_accepted', 'message_cancelled', 'notice', 'request',
      'request_resolved', 'resync', 'sdk', 'session_state', 'sessions_changed', 'terminal_state',
    ]);
    assert.equal(Object.isFrozen(EVENT_TYPES), true);
  });
});

describe('reconnectDelayMs', () => {
  it('doubles from one second and stops at thirty seconds', () => {
    assert.deepEqual(
      [0, 1, 2, 3, 4, 5, 6, 7].map((attempt) => reconnectDelayMs(attempt)),
      [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000],
    );
  });

  it('treats invalid attempt numbers as the first attempt and never exceeds the cap', () => {
    assert.equal(reconnectDelayMs(-3), 1000);
    assert.equal(reconnectDelayMs(Number.NaN), 1000);
    assert.equal(reconnectDelayMs(Number.POSITIVE_INFINITY), 1000);
    assert.equal(reconnectDelayMs(2.9), 4000);
    assert.equal(reconnectDelayMs(1e9), 30000);
  });
});

describe('createUuid', () => {
  const VERSION_4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('returns distinct RFC 4122 version 4 identifiers', () => {
    const ids = new Set(Array.from({ length: 200 }, () => createUuid()));
    assert.equal(ids.size, 200);
    for (const id of ids) assert.match(id, VERSION_4);
  });

  it('builds a version 4 identifier from getRandomValues when randomUUID is unavailable', (ctx) => {
    ctx.after(stubGlobal('crypto', {
      getRandomValues(bytes) {
        bytes.set(Uint8Array.from(bytes, (_, index) => index * 17));
        return bytes;
      },
    }));
    assert.equal(createUuid(), '00112233-4455-4677-8899-aabbccddeeff');
  });
});

describe('api client', () => {
  it('sends GET requests with same-origin credentials and resolves the parsed JSON', async (ctx) => {
    const calls = stubFetch(ctx, () => jsonResponse(200, { authenticated: true }));
    const controller = new AbortController();
    assert.deepEqual(await api.get('/api/session', { signal: controller.signal }), { authenticated: true });
    const [call] = calls;
    assert.equal(call.url, '/api/session');
    assert.equal(call.init.method, 'GET');
    assert.equal(call.init.credentials, 'same-origin');
    assert.equal(call.init.signal, controller.signal);
    assert.equal(call.init.headers.Accept, 'application/json');
  });

  it('resolves null for an empty success body', async (ctx) => {
    stubFetch(ctx, () => new Response(null, { status: 204 }));
    assert.equal(await api.del('/api/sessions/s1'), null);
  });

  it('sends PUT with a JSON body, like the memory save route expects', async (ctx) => {
    const calls = stubFetch(ctx, () => jsonResponse(200, { ok: true, bytes: 7 }));
    assert.deepEqual(await api.put('/api/sessions/s1/memory', { path: '/w/CLAUDE.md', content: 'hi' }), {
      ok: true, bytes: 7,
    });
    assert.equal(calls[0].init.method, 'PUT');
    assert.equal(calls[0].init.body, '{"path":"/w/CLAUDE.md","content":"hi"}');
    assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  });

  it('posts JSON bodies, and sends an empty object when no body is given', async (ctx) => {
    const calls = stubFetch(ctx, () => jsonResponse(200, { ok: true }));
    await api.post('/api/login', { token: 'abc' });
    await api.post('/api/logout');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.body, '{"token":"abc"}');
    assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
    assert.equal(calls[1].init.body, '{}');
  });

  it('turns a protocol error body and its Retry-After header into an ApiError', async (ctx) => {
    stubFetch(ctx, () => jsonResponse(
      429,
      { error: { code: 'RATE_LIMITED', message: 'Slow down.' } },
      { 'Retry-After': '7' },
    ));
    await assert.rejects(api.post('/api/login', { token: 'x' }), (error) => {
      assert.ok(error instanceof ApiError);
      assert.deepEqual([error.status, error.code, error.message, error.retryAfter], [429, 'RATE_LIMITED', 'Slow down.', 7]);
      return true;
    });
  });

  it('rounds Retry-After up and ignores values that are not a non-negative number', async (ctx) => {
    const retryHeaders = ['1.2', 'soon', '-3'];
    stubFetch(ctx, () => jsonResponse(
      429,
      { error: { code: 'RATE_LIMITED', message: 'Slow down.' } },
      { 'Retry-After': retryHeaders.shift() },
    ));
    const seen = [];
    for (let i = 0; i < 3; i += 1) {
      const error = await api.get('/api/session').catch((reason) => reason);
      seen.push(error.retryAfter);
    }
    assert.deepEqual(seen, [2, undefined, undefined]);
  });

  it('derives the code from the HTTP status when the body is not a protocol error', async (ctx) => {
    let httpStatus = 0;
    stubFetch(ctx, () => new Response('<html>gateway</html>', { status: httpStatus }));
    for (const [status, expected] of [[404, 'NOT_FOUND'], [413, 'PAYLOAD_TOO_LARGE'], [503, 'INTERNAL']]) {
      httpStatus = status;
      const error = await api.get('/api/x').catch((reason) => reason);
      assert.equal(error.code, expected);
      assert.equal(error.status, status);
      assert.equal(error.message, `HTTP ${status}`);
    }
  });

  it('clears the authenticated flag on 401 UNAUTHENTICATED', async (ctx) => {
    const original = store.get().auth;
    ctx.after(() => store.set({ auth: original }));
    store.set({ auth: { ...original, authenticated: true } });
    stubFetch(ctx, () => jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'Sign in again.' } }));
    await assert.rejects(api.get('/api/session'), { code: 'UNAUTHENTICATED' });
    assert.equal(store.get().auth.authenticated, false);
  });

  it('leaves the session alone for other 401 codes such as a wrong token', async (ctx) => {
    const original = store.get().auth;
    ctx.after(() => store.set({ auth: original }));
    store.set({ auth: { ...original, authenticated: true } });
    stubFetch(ctx, () => jsonResponse(401, { error: { code: 'INVALID_TOKEN', message: 'Wrong token.' } }));
    await assert.rejects(api.post('/api/login', { token: 'bad' }), { code: 'INVALID_TOKEN' });
    assert.equal(store.get().auth.authenticated, true);
  });

  it('reports a request that never reached the gateway as NETWORK', async (ctx) => {
    stubFetch(ctx, () => {
      throw new TypeError('fetch failed');
    });
    await assert.rejects(
      api.get('/api/session'),
      (error) => error instanceof ApiError && error.code === 'NETWORK' && error.status === 0,
    );
  });

  it('reports a response body that cannot be read as NETWORK', async (ctx) => {
    stubFetch(ctx, () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => {
        throw new TypeError('socket reset');
      },
    }));
    await assert.rejects(api.get('/api/session'), { code: 'NETWORK' });
  });

  it('lets an aborted request reject with its AbortError, not an ApiError', async (ctx) => {
    stubFetch(ctx, () => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    });
    await assert.rejects(
      api.get('/api/session'),
      (error) => !(error instanceof ApiError) && error.name === 'AbortError',
    );
  });

  it('uploads the raw file to the attachments endpoint with a percent-encoded name', async (ctx) => {
    const calls = stubFetch(ctx, () => jsonResponse(201, {
      path: '/work/acme/.caw-uploads/a.txt',
      name: 'notes é.txt',
      size: 2,
      mediaType: 'text/plain',
      kind: 'file',
    }));
    const blob = new Blob(['hi'], { type: 'text/plain' });
    const result = await api.upload('/work/acme', blob, 'notes é.txt');
    assert.equal(result.kind, 'file');
    assert.equal(calls[0].url, '/api/attachments?cwd=%2Fwork%2Facme');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.body, blob);
    assert.equal(calls[0].init.headers['Content-Type'], 'text/plain');
    assert.equal(calls[0].init.headers['X-File-Name'], 'notes%20%C3%A9.txt');
  });

  it('takes the file name from a File, falls back to "file", and the type to application/octet-stream', async (ctx) => {
    const calls = stubFetch(ctx, () => jsonResponse(201, {
      path: '/w/x', name: 'x', size: 1, mediaType: 'application/octet-stream', kind: 'file',
    }));
    await api.upload('/w', new File(['x'], 'photo one.png', { type: 'image/png' }));
    await api.upload('/w', new Blob(['x']));
    assert.equal(calls[0].init.headers['X-File-Name'], 'photo%20one.png');
    assert.equal(calls[0].init.headers['Content-Type'], 'image/png');
    assert.equal(calls[1].init.headers['X-File-Name'], 'file');
    assert.equal(calls[1].init.headers['Content-Type'], 'application/octet-stream');
  });
});

describe('connectEvents (SSE client)', () => {
  it('opens /api/events with the watch target and resume cursor, then reports connecting and open', (ctx) => {
    const streams = stubEventSource(ctx);
    ctx.mock.timers.enable({ apis: ['setTimeout'] });
    const statuses = [];
    const stream = connectEvents({
      watch: 's1',
      after: 5,
      onEvent() {},
      onStatus: (status) => statuses.push(status),
    });
    assert.equal(streams[0].url, '/api/events?watch=s1&after=5');
    assert.deepEqual(statuses, ['connecting']);
    streams[0].open();
    assert.deepEqual(statuses, ['connecting', 'open']);
    stream.close();
  });

  it('uses the bare endpoint when there is no watch target or cursor', (ctx) => {
    const streams = stubEventSource(ctx);
    ctx.mock.timers.enable({ apis: ['setTimeout'] });
    const stream = connectEvents({ onEvent() {} });
    assert.equal(streams[0].url, '/api/events');
    stream.close();
  });

  it('reconnects after 1 s, 2 s, 4 s and so on, and never waits more than 30 s', (ctx) => {
    const streams = stubEventSource(ctx);
    ctx.mock.timers.enable({ apis: ['setTimeout'] });
    const stream = connectEvents({ onEvent() {} });
    const delays = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
    delays.forEach((delay, index) => {
      const before = streams.length;
      streams.at(-1).fail();
      ctx.mock.timers.tick(delay - 1);
      assert.equal(streams.length, before, `attempt ${index}: no reconnect before ${delay} ms`);
      ctx.mock.timers.tick(1);
      assert.equal(streams.length, before + 1, `attempt ${index}: reconnect exactly at ${delay} ms`);
    });
    stream.close();
  });

  it('resets the backoff when a hello frame arrives', (ctx) => {
    const streams = stubEventSource(ctx);
    ctx.mock.timers.enable({ apis: ['setTimeout'] });
    const stream = connectEvents({ onEvent() {} });
    streams[0].fail();
    ctx.mock.timers.tick(SECOND);
    streams[1].fail();
    ctx.mock.timers.tick(2 * SECOND);
    assert.equal(streams.length, 3);
    streams[2].frame('hello', JSON.stringify({ bootId: 'b2', version: '1', seq: 0 }), 'b2:0');
    streams[2].fail();
    ctx.mock.timers.tick(SECOND - 1);
    assert.equal(streams.length, 3);
    ctx.mock.timers.tick(1);
    assert.equal(streams.length, 4);
    stream.close();
  });

  it('keeps backing off after an open that has not yet received hello', (ctx) => {
    const streams = stubEventSource(ctx);
    ctx.mock.timers.enable({ apis: ['setTimeout'] });
    const stream = connectEvents({ onEvent() {} });
    streams[0].fail();
    ctx.mock.timers.tick(SECOND);
    streams[1].open();
    streams[1].fail();
    ctx.mock.timers.tick(2 * SECOND - 1);
    assert.equal(streams.length, 2);
    ctx.mock.timers.tick(1);
    assert.equal(streams.length, 3);
    stream.close();
  });

  it('treats 45 s without any frame as a stall and reconnects', (ctx) => {
    const streams = stubEventSource(ctx);
    ctx.mock.timers.enable({ apis: ['setTimeout'] });
    const stream = connectEvents({ onEvent() {} });
    streams[0].open();
    ctx.mock.timers.tick(30 * SECOND);
    streams[0].frame('heartbeat', '{"t":1}', 'boot:1');
    ctx.mock.timers.tick(45 * SECOND - 1);
    assert.equal(streams.length, 1);
    ctx.mock.timers.tick(1);
    assert.equal(streams[0].closed, true);
    ctx.mock.timers.tick(SECOND - 1);
    assert.equal(streams.length, 1);
    ctx.mock.timers.tick(1);
    assert.equal(streams.length, 2);
    stream.close();
  });

  it('resumes from the highest sequence number seen', (ctx) => {
    const streams = stubEventSource(ctx);
    ctx.mock.timers.enable({ apis: ['setTimeout'] });
    const stream = connectEvents({ watch: 's1', onEvent() {} });
    streams[0].open();
    streams[0].frame('sdk', '{"n":1}', 'boot-a:41');
    streams[0].frame('sdk', '{"n":2}', 'boot-a:42');
    streams[0].frame('sdk', '{"n":0}', 'boot-a:40');
    streams[0].fail();
    ctx.mock.timers.tick(SECOND);
    assert.equal(streams[1].url, '/api/events?watch=s1&after=42');
    stream.close();
  });

  it('skips a malformed frame but still advances the resume cursor past it', (ctx) => {
    const streams = stubEventSource(ctx);
    ctx.mock.timers.enable({ apis: ['setTimeout'] });
    const received = [];
    const stream = connectEvents({ onEvent: (type, data) => received.push([type, data]) });
    streams[0].open();
    streams[0].frame('sdk', '{not json', 'boot:4');
    streams[0].frame('sdk', '{"kind":"ok"}', 'boot:5');
    streams[0].frame('notice', 'also not json', 'boot:6');
    assert.deepEqual(received, [['sdk', { kind: 'ok' }]]);
    streams[0].fail();
    ctx.mock.timers.tick(SECOND);
    assert.equal(streams[1].url, '/api/events?after=6');
    stream.close();
  });

  it('keeps the stream alive when an event handler throws', (ctx) => {
    const streams = stubEventSource(ctx);
    ctx.mock.timers.enable({ apis: ['setTimeout'] });
    const received = [];
    const stream = connectEvents({
      onEvent(type) {
        if (type === 'sdk') throw new Error('handler bug');
        received.push(type);
      },
    });
    streams[0].open();
    const queued = captureMicrotasks(() => streams[0].frame('sdk', '{}', 'boot:1'));
    streams[0].frame('notice', '{}', 'boot:2');
    assert.deepEqual(received, ['notice']);
    assert.equal(queued.length, 1);
    assert.throws(() => queued[0](), /handler bug/);
    stream.close();
  });

  it('reconnect() cancels the pending retry and reopens at once on the new target', (ctx) => {
    const streams = stubEventSource(ctx);
    ctx.mock.timers.enable({ apis: ['setTimeout'] });
    const stream = connectEvents({ watch: 's1', onEvent() {} });
    streams[0].fail();
    stream.reconnect({ watch: 's2', after: 9 });
    assert.equal(streams.length, 2);
    assert.equal(streams[1].url, '/api/events?watch=s2&after=9');
    assert.equal(streams[0].closed, true);
    ctx.mock.timers.tick(5 * SECOND);
    assert.equal(streams.length, 2, 'the cancelled retry must not open a third stream');
    stream.close();
  });

  it('close() stops reconnection and ignores frames from the closed stream', (ctx) => {
    const streams = stubEventSource(ctx);
    ctx.mock.timers.enable({ apis: ['setTimeout'] });
    const statuses = [];
    const received = [];
    const stream = connectEvents({
      onEvent: (type) => received.push(type),
      onStatus: (status) => statuses.push(status),
    });
    streams[0].open();
    streams[0].frame('hello', '{"bootId":"b","version":"1","seq":0}', 'b:0');
    streams[0].fail();
    stream.close();
    stream.close();
    ctx.mock.timers.tick(MINUTE);
    assert.equal(streams.length, 1, 'no reconnect after close');
    assert.equal(streams[0].closed, true);
    streams[0].frame('sdk', '{}', 'b:1');
    assert.deepEqual(received, ['hello']);
    assert.equal(statuses.at(-1), 'closed');
  });
});

describe('createStore', () => {
  it('shallow-merges patches and keeps untouched values by reference', () => {
    const local = createStore({ a: 1, nested: { x: 1 }, b: 2 });
    const nested = local.get().nested;
    local.set({ a: 3 });
    assert.deepEqual(local.get(), { a: 3, nested: { x: 1 }, b: 2 });
    assert.equal(local.get().nested, nested);
  });

  it('does not notify when no value actually changes', () => {
    const local = createStore({ a: 1 });
    let calls = 0;
    local.subscribe(() => {
      calls += 1;
    });
    local.set({ a: 1 });
    local.set({});
    assert.equal(calls, 0);
    local.set({ a: 2 });
    assert.equal(calls, 1);
  });

  it('gives subscribers the next and the previous state', () => {
    const local = createStore({ a: 1 });
    const seen = [];
    local.subscribe((next, prev) => seen.push([next.a, prev.a]));
    local.set({ a: 2 });
    assert.deepEqual(seen, [[2, 1]]);
  });

  it('stops notifying a subscriber after it unsubscribes', () => {
    const local = createStore({ a: 1 });
    let calls = 0;
    const off = local.subscribe(() => {
      calls += 1;
    });
    local.set({ a: 2 });
    off();
    local.set({ a: 3 });
    assert.equal(calls, 1);
  });

  it('update() applies only the patch its callback returns', () => {
    const local = createStore({ a: 1 });
    local.update(() => null);
    assert.equal(local.get().a, 1);
    local.update((state) => ({ a: state.a + 1 }));
    assert.equal(local.get().a, 2);
  });

  it('keeps notifying other subscribers when one throws, and reports that error asynchronously', () => {
    const local = createStore({ a: 1 });
    const boom = new Error('subscriber failed');
    const seen = [];
    local.subscribe(() => {
      throw boom;
    });
    local.subscribe((next) => seen.push(next.a));
    const queued = captureMicrotasks(() => local.set({ a: 2 }));
    assert.deepEqual(seen, [2]);
    assert.equal(queued.length, 1);
    assert.throws(() => queued[0](), (error) => error === boom);
  });
});

describe('preferences and the application store', () => {
  it('starts with no account loaded, and keeps the account shape for the settings section', () => {
    assert.equal(store.get().account, null);
    const local = createStore({ account: null });
    local.set({ account: { account: { email: 'a@example.com' }, signInPending: false } });
    assert.deepEqual(local.get().account, { account: { email: 'a@example.com' }, signInPending: false });
  });

  it('exposes the valid choices and the defaults', () => {
    assert.deepEqual([...THEMES], ['system', 'light', 'dark']);
    assert.deepEqual([...FONT_SIZES], ['sm', 'md', 'lg']);
    assert.deepEqual(defaultPrefs(), {
      theme: 'system', locale: null, fontSize: 'md', notify: false, showRuntimeEvents: false, sidebarOpen: true,
    });
  });

  it('returns the defaults for missing or non-object input', () => {
    assert.deepEqual(normalizePrefs(null), defaultPrefs());
    assert.deepEqual(normalizePrefs(undefined), defaultPrefs());
    assert.deepEqual(normalizePrefs('dark'), defaultPrefs());
  });

  it('keeps valid stored values and normalizes the locale tag', () => {
    assert.deepEqual(
      normalizePrefs({ theme: 'dark', locale: 'zh_TW', fontSize: 'lg', notify: true, showRuntimeEvents: true }),
      { theme: 'dark', locale: 'zh-CN', fontSize: 'lg', notify: true, showRuntimeEvents: true, sidebarOpen: true },
    );
  });

  it('replaces invalid stored values with the base values', () => {
    assert.deepEqual(
      normalizePrefs({ theme: 'blue', locale: 'fr-FR', fontSize: 'xl', notify: 'yes', showRuntimeEvents: 'on' }),
      defaultPrefs(),
    );
  });

  it('never restores sidebarOpen from storage', () => {
    const base = { ...defaultPrefs(), sidebarOpen: false };
    assert.equal(normalizePrefs({ sidebarOpen: true }, base).sidebarOpen, false);
  });

  it('fills missing fields from the supplied base', () => {
    const base = { theme: 'light', locale: 'en', fontSize: 'sm', notify: true, showRuntimeEvents: false, sidebarOpen: true };
    assert.deepEqual(normalizePrefs({ theme: 'dark' }, base), { ...base, theme: 'dark' });
  });

  it('has every documented top-level key, and saves preference changes without storage', () => {
    const state = store.get();
    for (const key of [
      'auth', 'meta', 'connection', 'sessions', 'sessionsReady', 'sessionsHasMore', 'live', 'pending',
      'currentSessionId', 'capabilities', 'terminal', 'tasks', 'prefs',
    ]) {
      assert.ok(Object.hasOwn(state, key), `missing ${key}`);
    }
    assert.ok(THEMES.includes(state.prefs.theme));
    const before = state.prefs;
    store.set({ prefs: { ...before, fontSize: 'lg' } });
    assert.equal(store.get().prefs.fontSize, 'lg');
    store.set({ prefs: before });
    assert.equal(store.get().prefs.fontSize, before.fontSize);
  });
});

describe('retitledState', () => {
  const state = () => ({
    sessions: [
      { sessionId: 'a', summary: 'Old title', live: { title: null, state: 'idle' } },
      { sessionId: 'b', summary: 'Named', customTitle: 'Mine', live: { title: 'Mine', state: 'idle' } },
      { sessionId: 'c', summary: 'Other', live: { title: 'Live', state: 'running' } },
    ],
    live: {
      a: { title: null, state: 'idle' },
      c: { title: 'Live', state: 'running' },
    },
  });

  it('writes the auto title to the summary and leaves an unset live title alone', () => {
    const patch = retitledState(state(), 'a', '  Refactor the parser  ');
    assert.equal(sessionTitle(patch.sessions[0], 'U'), 'Refactor the parser');
    assert.equal(patch.sessions[1].summary, 'Named');
    assert.equal(patch.live, undefined);
  });

  it('moves a live title that is already set, in the rows and in the live map', () => {
    const patch = retitledState(state(), 'c', 'Fixing the build');
    assert.equal(sessionTitle(patch.sessions[2], 'U'), 'Fixing the build');
    assert.equal(patch.live.c.title, 'Fixing the build');
    assert.equal(patch.live.c.state, 'running');
    assert.equal(patch.live.a.title, null);
  });

  it('keeps a custom title visible', () => {
    const patch = retitledState(state(), 'b', 'Auto title');
    assert.equal(sessionTitle(patch.sessions[1], 'U'), 'Mine');
    assert.equal(patch.live, undefined);
  });

  it('returns null when there is nothing to change', () => {
    assert.equal(retitledState(state(), 'a', '   '), null);
    assert.equal(retitledState(state(), 'a', 42), null);
    assert.equal(retitledState(state(), 'missing', 'Title'), null);
  });
});

describe('sidebar-model', () => {
  const ids = (sessions) => sessions.map((session) => session.sessionId);

  describe('projectName and sessionCwd', () => {
    it('uses the last path segment as the project name', () => {
      assert.equal(projectName('/work/acme'), 'acme');
      assert.equal(projectName('/work/acme/'), 'acme');
      assert.equal(projectName('C:\\Users\\dev\\app'), 'app');
    });

    it('returns an empty string when there is no directory', () => {
      assert.equal(projectName(''), '');
      assert.equal(projectName(null), '');
      assert.equal(projectName(undefined), '');
    });

    it('prefers the persisted cwd over the live cwd', () => {
      assert.equal(sessionCwd({ sessionId: 's', cwd: '/a', live: { cwd: '/b' } }), '/a');
      assert.equal(sessionCwd({ sessionId: 's', live: { cwd: '/b' } }), '/b');
      assert.equal(sessionCwd({ sessionId: 's' }), '');
    });
  });

  describe('sessionTitle', () => {
    it('prefers the custom title, then the live title, the summary and the first prompt', () => {
      const full = {
        sessionId: 's',
        customTitle: ' Renamed  \n chat ',
        live: { title: 'Live' },
        summary: 'Sum',
        firstPrompt: 'First',
      };
      assert.equal(sessionTitle(full, 'Untitled'), 'Renamed chat');
      assert.equal(sessionTitle({ sessionId: 's', live: { title: '  Live\tTitle ' }, summary: 'Sum' }, 'U'), 'Live Title');
      assert.equal(sessionTitle({ sessionId: 's', summary: 'Sum', firstPrompt: 'First' }, 'U'), 'Sum');
      assert.equal(sessionTitle({ sessionId: 's', firstPrompt: 'Fix the\n  build' }, 'U'), 'Fix the build');
    });

    it('skips blank candidates and falls back to the untitled label', () => {
      const blanks = { sessionId: 's', customTitle: '   ', live: { title: null }, summary: '', firstPrompt: 'Hello' };
      assert.equal(sessionTitle(blanks, 'Untitled'), 'Hello');
      assert.equal(sessionTitle({ sessionId: 's' }, 'Untitled'), 'Untitled');
    });
  });

  describe('sessionActivity', () => {
    it('orders by transcript modification time, falling back to live activity, then zero', () => {
      assert.equal(sessionActivity({ sessionId: 's', lastModified: 500, live: { lastActivity: 900 } }), 500);
      assert.equal(sessionActivity({ sessionId: 's', lastModified: 0, live: { lastActivity: 900 } }), 900);
      assert.equal(sessionActivity({ sessionId: 's', live: { lastActivity: 900 } }), 900);
      assert.equal(sessionActivity({ sessionId: 's', lastModified: 'bad' }), 0);
      assert.equal(sessionActivity({ sessionId: 's' }), 0);
    });
  });

  describe('groupSessions', () => {
    it('groups by directory, newest group first, newest session first inside each group', () => {
      const groups = groupSessions([
        { sessionId: 'a1', cwd: '/work/acme', lastModified: 100 },
        { sessionId: 'b1', cwd: '/work/beta', lastModified: 300 },
        { sessionId: 'a2', cwd: '/work/acme', lastModified: 250 },
        { sessionId: 'n1', lastModified: 200 },
        { sessionId: 'a3', cwd: '/work/acme', live: { cwd: '/work/acme', lastActivity: 400 } },
      ]);
      assert.deepEqual(groups.map((group) => group.key), ['/work/acme', '/work/beta', '']);
      assert.deepEqual(groups.map((group) => group.name), ['acme', 'beta', null]);
      assert.deepEqual(groups.map((group) => group.cwd), ['/work/acme', '/work/beta', null]);
      assert.deepEqual(ids(groups[0].sessions), ['a3', 'a2', 'a1']);
      assert.equal(groups[0].latest, 400);
    });

    it('breaks ties between groups by directory key', () => {
      const groups = groupSessions([
        { sessionId: 'z', cwd: '/z', lastModified: 50 },
        { sessionId: 'a', cwd: '/a', lastModified: 50 },
      ]);
      assert.deepEqual(groups.map((group) => group.key), ['/a', '/z']);
    });

    it('returns no groups for no sessions', () => {
      assert.deepEqual(groupSessions([]), []);
    });
  });

  describe('search', () => {
    const sample = [
      { sessionId: '1', customTitle: 'Fix login redirect', cwd: '/work/acme', tag: 'urgent' },
      { sessionId: '2', summary: 'Refactor the API client', firstPrompt: 'Clean up fetch helpers', cwd: '/work/beta' },
      { sessionId: '3', firstPrompt: 'Write release notes', live: { title: 'Notes', cwd: '/home/dev/docs' } },
      { sessionId: '4' },
    ];

    it('splits queries on whitespace and lower-cases them', () => {
      assert.deepEqual(queryTerms('  Fix   API\tbug '), ['fix', 'api', 'bug']);
      assert.deepEqual(queryTerms(''), []);
      assert.deepEqual(queryTerms(null), []);
      assert.deepEqual(queryTerms(undefined), []);
    });

    it('returns every session for a blank query', () => {
      assert.deepEqual(filterSessions(sample, ''), sample);
      assert.deepEqual(filterSessions(sample, '   '), sample);
    });

    it('matches case-insensitively across title, summary, prompt, directory, live directory and tag', () => {
      assert.deepEqual(ids(filterSessions(sample, 'LOGIN')), ['1']);
      assert.deepEqual(ids(filterSessions(sample, 'api')), ['2']);
      assert.deepEqual(ids(filterSessions(sample, 'fetch')), ['2']);
      assert.deepEqual(ids(filterSessions(sample, 'acme')), ['1']);
      assert.deepEqual(ids(filterSessions(sample, 'urgent')), ['1']);
      assert.deepEqual(ids(filterSessions(sample, 'docs')), ['3']);
      assert.deepEqual(ids(filterSessions(sample, 'notes')), ['3']);
    });

    it('requires every term to match', () => {
      assert.deepEqual(ids(filterSessions(sample, 'api client')), ['2']);
      assert.deepEqual(ids(filterSessions(sample, 'api login')), []);
      assert.deepEqual(ids(filterSessions(sample, 'work beta')), ['2']);
    });
  });

  describe('mergeLive', () => {
    it('sets live entries from the page, removes ones no longer live, and leaves other sessions alone', () => {
      const live = { s1: { state: 'running' }, s2: { state: 'idle' }, s9: { state: 'running' } };
      const page = [
        { sessionId: 's1', live: { state: 'requires_action' } },
        { sessionId: 's2' },
        { sessionId: 's3', live: { state: 'starting' } },
      ];
      const next = mergeLive(live, page);
      assert.deepEqual(next, {
        s1: { state: 'requires_action' },
        s3: { state: 'starting' },
        s9: { state: 'running' },
      });
      assert.notEqual(next, live);
      assert.deepEqual(live.s1, { state: 'running' }, 'the input map is not mutated');
    });
  });

  describe('liveTone', () => {
    it('maps every live state to a state-dot tone', () => {
      assert.equal(liveTone(null), null);
      assert.equal(liveTone(undefined), null);
      assert.equal(liveTone({ state: 'running' }), 'running');
      assert.equal(liveTone({ state: 'requires_action' }), 'attention');
      assert.equal(liveTone({ state: 'error' }), 'error');
      assert.equal(liveTone({ state: 'starting' }), 'starting');
      assert.equal(liveTone({ state: 'closing' }), 'muted');
      assert.equal(liveTone({ state: 'idle' }), 'idle');
    });

    it('treats an unknown or missing state as idle', () => {
      assert.equal(liveTone({ state: 'something_new' }), 'idle');
      assert.equal(liveTone({}), 'idle');
    });
  });

  describe('formatRelativeTime', () => {
    const NOW = new Date(2026, 9, 9, 12, 0, 0).getTime();
    const ago = (ms) => NOW - ms;
    const en = { now: NOW, locale: 'en', justNow: 'Just now' };
    const zh = { now: NOW, locale: 'zh-CN', justNow: '刚刚' };

    it('says "just now" for the first 45 seconds and for timestamps in the future', () => {
      assert.equal(formatRelativeTime(ago(0), en), 'Just now');
      assert.equal(formatRelativeTime(ago(44 * SECOND), en), 'Just now');
      assert.equal(formatRelativeTime(NOW + 5 * MINUTE, en), 'Just now');
    });

    it('counts minutes and hours in English', () => {
      assert.equal(formatRelativeTime(ago(MINUTE), en), '1 minute ago');
      assert.equal(formatRelativeTime(ago(3 * MINUTE), en), '3 minutes ago');
      assert.equal(formatRelativeTime(ago(2 * HOUR), en), '2 hours ago');
    });

    it('says "yesterday" and counts days up to a week in English', () => {
      assert.equal(formatRelativeTime(ago(DAY), en), 'yesterday');
      assert.equal(formatRelativeTime(ago(3 * DAY), en), '3 days ago');
    });

    it('switches to a calendar date after a week, with the year only when it differs', () => {
      assert.equal(formatRelativeTime(ago(8 * DAY), en), 'Oct 1');
      assert.equal(formatRelativeTime(new Date(2025, 11, 31, 12).getTime(), en), 'Dec 31, 2025');
    });

    it('uses Chinese text for the same ranges', () => {
      assert.equal(formatRelativeTime(ago(10 * SECOND), zh), '刚刚');
      assert.equal(formatRelativeTime(ago(3 * MINUTE), zh), '3分钟前');
      assert.equal(formatRelativeTime(ago(2 * HOUR), zh), '2小时前');
      assert.equal(formatRelativeTime(ago(DAY), zh), '昨天');
      assert.equal(formatRelativeTime(ago(3 * DAY), zh), '3天前');
      assert.equal(formatRelativeTime(ago(8 * DAY), zh), '10月1日');
      assert.equal(formatRelativeTime(new Date(2025, 11, 31, 12).getTime(), zh), '2025年12月31日');
    });

    it('falls back to English for a locale it does not know', () => {
      assert.equal(formatRelativeTime(ago(3 * MINUTE), { now: NOW, locale: 'fr', justNow: 'Just now' }), '3 minutes ago');
    });

    it('returns an empty string for missing or invalid timestamps', () => {
      for (const value of [undefined, null, 0, -5, Number.NaN, 'soon']) {
        assert.equal(formatRelativeTime(value, { now: NOW }), '');
      }
    });
  });

  describe('formatClock', () => {
    const afternoon = new Date(2026, 9, 9, 14, 5).getTime();

    it('formats the local clock time in each locale', () => {
      assert.equal(formatClock(afternoon, 'en').replace(/\s/g, ' '), '2:05 PM');
      assert.equal(formatClock(afternoon, 'zh-CN'), '14:05');
    });

    it('returns an empty string for invalid timestamps', () => {
      assert.equal(formatClock(Number.NaN), '');
      assert.equal(formatClock(0), '');
    });
  });
});

describe('account section helpers', () => {
  it('lists the signed-in account facts that have text, in a fixed order', () => {
    assert.deepEqual(accountFacts({ email: 'a@example.com', organization: '', subscriptionType: 'Max', apiProvider: 'firstParty' }), [
      { label: 'email', value: 'a@example.com' },
      { label: 'subscription', value: 'Max' },
      { label: 'provider', value: 'firstParty' },
    ]);
    assert.deepEqual(accountFacts(null), []);
  });

  it('accepts only a sign-in code with a non-empty part on each side of the #', () => {
    assert.equal(validSignInCode(' mock-code#state-1 '), 'mock-code#state-1');
    assert.equal(validSignInCode('no-separator'), null);
    assert.equal(validSignInCode('#state-only'), null);
    assert.equal(validSignInCode('code-only#'), null);
    assert.equal(validSignInCode('a#b#c'), null);
    assert.equal(validSignInCode(undefined), null);
  });
});
