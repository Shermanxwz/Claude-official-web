/**
 * Harness shared by the integration tests. Every test file starts a real gateway (startServer) on a random loopback
 * port with the deterministic mock engine, talks to it over HTTP with a cookie-aware client and reads its
 * Server-Sent Events. Nothing here changes product code.
 *
 * Pacing: startServer reads CAW_MOCK_DELAY_MS from the env it is given. The harness builds the mock adapter itself,
 * with the pacing of the test env, because it also passes backgroundTiming and wrapEngine, and hands the adapter over
 * through the documented `engine` option.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config.mjs';
import { createMockAdapter } from '../../src/engine/mock/index.mjs';
import { createLogger } from '../../src/log.mjs';
import { startServer } from '../../src/server.mjs';

export const TOKEN = 'integration-test-token-123456';
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PACKAGE_VERSION = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
export const CONTENT_SECURITY_POLICY = "default-src 'self'; img-src 'self' data: blob:; "
  + "style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self' data:; "
  + "frame-src 'none'; frame-ancestors 'none'; object-src 'none'; worker-src 'self'; manifest-src 'self'; "
  + "base-uri 'none'; form-action 'self'";
export const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=()';
export const CLAUDE_CODE_VERSION = '2.1.295-mock';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIXTURE_FILES = {
  'package.json': '{\n  "name": "demo-app",\n  "version": "1.0.0"\n}\n',
  'src/app.js': "const port = 3000;\n\napp.listen(port);\n",
  'src/util/helpers.js': 'export const add = (a, b) => a + b;\n',
  'node_modules/left-pad/app.js': 'module.exports = {};\n',
  '.git/config': '[core]\n',
};

/**
 * @param {string} dir
 * @param {Record<string, string>} files relative path -> content
 */
function writeTree(dir, files) {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

/**
 * Starts a gateway with its own temporary workspace, state directory and home directory.
 *
 * The workspace root holds the project `proj` (package.json, src/app.js, src/util/helpers.js and two directories the
 * file search must skip). `outside` is a directory that is not a workspace root.
 * @param {Record<string, string>} [overrides] environment variables that replace the defaults
 * @param {{wrapEngine?: (engine: import('../../src/contracts.mjs').EngineAdapter) =>
 *   import('../../src/contracts.mjs').EngineAdapter,
 *   backgroundTiming?: {waitMs?: number, runMs?: number}}} [options] backgroundTiming shortens how long a foreground
 *   command waits to be moved and how long a background command runs in the mock
 */
export async function startTestServer(overrides = {}, { wrapEngine, backgroundTiming } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caw-it-')));
  const root = path.join(base, 'workspace');
  const proj = path.join(root, 'proj');
  const outside = path.join(base, 'outside');
  const stateDir = path.join(base, 'state');
  const home = path.join(base, 'home');
  /** @type {Awaited<ReturnType<typeof startServer>>|null} */
  let running = null;
  try {
    writeTree(proj, FIXTURE_FILES);
    fs.mkdirSync(outside, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(home, { recursive: true });
    const env = {
      HOME: home,
      CAW_ENGINE: 'mock',
      CAW_MOCK_DELAY_MS: '0',
      CAW_REQUIRE_AUTH: '1',
      CAW_TOKEN: TOKEN,
      CAW_WORKSPACE_ROOTS: root,
      CAW_STATE_DIR: stateDir,
      CAW_LOG_LEVEL: 'error',
      ...overrides,
    };
    const config = loadConfig(env);
    const log = createLogger({ level: 'error' });
    const mock = createMockAdapter({ config, log, delayMs: Number(env.CAW_MOCK_DELAY_MS), backgroundTiming });
    const engine = wrapEngine ? wrapEngine(mock) : mock;
    running = await startServer({ env, engine, listenHost: '127.0.0.1', listenPort: 0 });
    const { url, events, engineHost } = running;
    const handle = running;
    let closing = null;
    return {
      url,
      origin: url,
      root,
      proj,
      outside,
      stateDir,
      env,
      events,
      engineHost,
      close() {
        closing ??= handle.close().finally(() => fs.rmSync(base, { recursive: true, force: true }));
        return closing;
      },
    };
  } catch (error) {
    if (running) await running.close();
    fs.rmSync(base, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Raw bodies (Buffer, string) are sent as they are; anything else is sent as JSON. The caller's Content-Type wins.
 * @param {unknown} body
 * @returns {{buffer: Buffer, type: string}|null}
 */
function encodeBody(body) {
  if (body === undefined) return null;
  if (Buffer.isBuffer(body)) return { buffer: body, type: 'application/octet-stream' };
  if (typeof body === 'string') return { buffer: Buffer.from(body, 'utf8'), type: 'text/plain; charset=utf-8' };
  return { buffer: Buffer.from(JSON.stringify(body), 'utf8'), type: 'application/json' };
}

/**
 * @param {string|undefined} contentType
 * @param {string} text
 * @returns {unknown} the parsed JSON body, or null when the response is not JSON
 */
function parseJsonBody(contentType, text) {
  if (!/application\/json/i.test(contentType ?? '') || text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Parses one SSE block (the lines between two blank lines). Comment lines are ignored; an unparsable data payload is
 * kept as `invalid` so the test that receives it fails with the raw text in view.
 * @param {string} block
 * @returns {{id: string|undefined, event: string, data: any, invalid: boolean, raw: string}|null}
 */
function parseFrame(block) {
  /** @type {string|undefined} */
  let id;
  /** @type {string|undefined} */
  let event;
  /** @type {string[]} */
  const data = [];
  let fields = false;
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    fields = true;
    const colon = line.indexOf(':');
    const name = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (name === 'id') id = value;
    else if (name === 'event') event = value;
    else if (name === 'data') data.push(value);
  }
  if (!fields) return null;
  const raw = data.join('\n');
  try {
    return { id, event: event ?? 'message', data: JSON.parse(raw), invalid: false, raw };
  } catch {
    return { id, event: event ?? 'message', data: undefined, invalid: true, raw };
  }
}

/**
 * Wraps an open SSE response: buffers every frame, and resolves waiters as frames arrive.
 * @param {http.ClientRequest} req
 * @param {http.IncomingMessage} res
 */
function wrapStream(req, res) {
  res.setEncoding('utf8');
  /** @type {Array<{id: string|undefined, event: string, data: any, invalid: boolean, raw: string}>} */
  const received = [];
  /** @type {Set<{predicate: (event: any) => boolean, resolve: (event: any) => void, reject: (error: Error) => void,
   *   timer: ReturnType<typeof setTimeout>|null}>} */
  const waiters = new Set();
  let pending = '';
  /** @type {Error|null} */
  let finished = null;

  /** @param {Error} reason */
  const finish = (reason) => {
    if (finished) return;
    finished = reason;
    for (const waiter of waiters) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(reason);
    }
    waiters.clear();
  };
  /** @param {{id: string|undefined, event: string, data: any, invalid: boolean, raw: string}} frame */
  const deliver = (frame) => {
    received.push(frame);
    for (const waiter of waiters) {
      if (!waiter.predicate(frame)) continue;
      waiters.delete(waiter);
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(frame);
    }
  };

  res.on('data', (/** @type {string} */ chunk) => {
    pending += chunk;
    let end = pending.indexOf('\n\n');
    while (end !== -1) {
      const frame = parseFrame(pending.slice(0, end));
      pending = pending.slice(end + 2);
      if (frame) deliver(frame);
      end = pending.indexOf('\n\n');
    }
  });
  res.on('end', () => finish(new Error('the event stream ended')));
  res.on('error', (error) => finish(error));
  res.on('close', () => finish(new Error('the event stream was closed')));

  return {
    status: res.statusCode ?? 0,
    headers: res.headers,
    /** @returns {Array<{id: string|undefined, event: string, data: any, invalid: boolean, raw: string}>} */
    all: () => [...received],
    /** @returns {number} frames received so far; a mark for `next(..., {from})` */
    count: () => received.length,
    /**
     * Resolves with the first frame that matches, buffered or future. Rejects after `timeoutMs`.
     * @param {(event: any) => boolean} predicate
     * @param {number} [timeoutMs]
     * @param {{from?: number}} [options] start scanning the buffer at this index
     */
    next(predicate, timeoutMs = 5000, { from = 0 } = {}) {
      for (let index = from; index < received.length; index += 1) {
        if (predicate(received[index])) return Promise.resolve(received[index]);
      }
      if (finished) return Promise.reject(finished);
      return new Promise((resolve, reject) => {
        /** @type {{predicate: (event: any) => boolean, resolve: (event: any) => void, reject: (error: Error) => void,
         *   timer: ReturnType<typeof setTimeout>|null}} */
        const waiter = { predicate, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          waiters.delete(waiter);
          const seen = received.slice(-12).map((frame) => frame.event).join(', ') || '(none)';
          reject(new Error(`timed out after ${timeoutMs} ms waiting for an event; last events: ${seen}`));
        }, timeoutMs);
        waiters.add(waiter);
      });
    },
    close() {
      req.destroy();
    },
  };
}

/**
 * A cookie-aware HTTP client for one gateway. The caw_session cookie is captured from Set-Cookie and sent back on
 * every request. Every request carries `Origin` equal to the gateway origin unless `origin` says otherwise (`null`
 * omits the header). Headers in `headers` replace the defaults.
 * @param {string} url gateway base URL, e.g. http://127.0.0.1:4180
 */
export function client(url) {
  const target = new URL(url);
  const origin = target.origin;
  /** @type {string|null} */
  let cookie = null;

  /**
   * @param {string} method
   * @param {string} pathname
   * @param {{body?: unknown, origin?: string|null, headers?: Record<string, string>}} [options]
   * @returns {Promise<{status: number, headers: http.IncomingHttpHeaders, text: string, json: any}>}
   */
  function send(method, pathname, { body, origin: originOverride, headers = {} } = {}) {
    const requestHeaders = { Accept: 'application/json, text/plain, */*', ...headers };
    const payload = encodeBody(body);
    if (payload && requestHeaders['Content-Type'] === undefined) requestHeaders['Content-Type'] = payload.type;
    if (payload && requestHeaders['Transfer-Encoding'] === undefined) {
      requestHeaders['Content-Length'] = String(payload.buffer.length);
    }
    if (originOverride !== null) requestHeaders.Origin = originOverride ?? origin;
    if (cookie !== null && requestHeaders.Cookie === undefined) requestHeaders.Cookie = cookie;
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: target.hostname,
        port: Number(target.port),
        path: pathname,
        method,
        headers: requestHeaders,
        agent: false,
      }, (res) => {
        /** @type {Buffer[]} */
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          absorbCookies(res.headers['set-cookie']);
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text,
            json: parseJsonBody(res.headers['content-type'], text),
          });
        });
      });
      req.setTimeout(15000, () => req.destroy(new Error(`${method} ${pathname} timed out`)));
      req.on('error', reject);
      if (payload) req.end(payload.buffer);
      else req.end();
    });
  }

  /** @param {string[]|undefined} setCookies */
  function absorbCookies(setCookies) {
    for (const raw of setCookies ?? []) {
      const [pair, ...attributes] = raw.split(';').map((part) => part.trim());
      const eq = pair.indexOf('=');
      if (pair.slice(0, eq) !== 'caw_session') continue;
      const value = pair.slice(eq + 1);
      const expired = attributes.some((attribute) => /^max-age=0$/i.test(attribute));
      cookie = value === '' || expired ? null : `caw_session=${value}`;
    }
  }

  /** @type {{
   *   readonly cookie: string|null,
   *   readonly origin: string,
   *   get: (pathname: string, options?: object) => ReturnType<typeof send>,
   *   post: (pathname: string, body?: unknown, options?: object) => ReturnType<typeof send>,
   *   patch: (pathname: string, body?: unknown, options?: object) => ReturnType<typeof send>,
   *   del: (pathname: string, body?: unknown, options?: object) => ReturnType<typeof send>,
   *   login: (token?: string, options?: object) => ReturnType<typeof send>,
   *   events: (options?: {watch?: string, after?: number, lastEventId?: string}) => Promise<EventStream>
   * }} */
  const api = {
    /** @returns {string|null} the Cookie header value the client sends, or null when signed out */
    get cookie() {
      return cookie;
    },
    /** The gateway origin; requests send it as Origin unless a test overrides it. */
    origin,
    get(pathname, options) {
      return send('GET', pathname, options);
    },
    post(pathname, body, options) {
      return send('POST', pathname, { ...options, body });
    },
    patch(pathname, body, options) {
      return send('PATCH', pathname, { ...options, body });
    },
    del(pathname, body, options) {
      return send('DELETE', pathname, { ...options, body });
    },
    login(token = TOKEN, options) {
      return send('POST', '/api/login', { ...options, body: { token } });
    },
    events(options) {
      return openEvents(api, options);
    },
  };
  return api;
}

/** @typedef {ReturnType<typeof client>} Client */
/** @typedef {ReturnType<typeof wrapStream>} EventStream */

/**
 * Opens GET /api/events. Resolves once the response headers arrive; the stream buffers every frame from then on.
 * `after` replays buffered events with a larger sequence number, as the browser does on reconnect.
 * @param {Client} api signed-in client
 * @param {{watch?: string, after?: number, lastEventId?: string}} [options]
 * @returns {Promise<ReturnType<typeof wrapStream>>}
 */
export function openEvents(api, { watch, after, lastEventId } = {}) {
  const query = new URLSearchParams();
  if (watch !== undefined) query.set('watch', watch);
  if (after !== undefined) query.set('after', String(after));
  const pathname = `/api/events${query.size > 0 ? `?${query}` : ''}`;
  const headers = { Accept: 'text/event-stream' };
  if (api.cookie !== null) headers.Cookie = api.cookie;
  if (lastEventId !== undefined) headers['Last-Event-ID'] = lastEventId;
  const target = new URL(api.origin ?? '');
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: target.hostname,
      port: Number(target.port),
      path: pathname,
      method: 'GET',
      headers,
      agent: false,
    }, (res) => {
      if (res.statusCode !== 200) {
        /** @type {Buffer[]} */
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          reject(new Error(`event stream refused with ${res.statusCode}: ${Buffer.concat(chunks).toString('utf8')}`));
        });
        return;
      }
      resolve(wrapStream(req, res));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Parses the sequence number of an SSE id (`<bootId>:<seq>`).
 * @param {string|undefined} id
 * @returns {number}
 */
export function seqOf(id) {
  assert.ok(id, 'the frame has no id');
  const colon = id.lastIndexOf(':');
  return Number(id.slice(colon + 1));
}

/**
 * Predicate for an SDK message of one session.
 * @param {string} sessionId
 * @param {string} type SDK message type, e.g. 'stream_event'
 * @param {string} [subtype] SDK message subtype, e.g. 'init'
 */
export function sdkMessage(sessionId, type, subtype) {
  return (/** @type {any} */ frame) => frame.event === 'sdk' && frame.data?.sessionId === sessionId
    && frame.data.msg?.type === type && (subtype === undefined || frame.data.msg.subtype === subtype);
}

/**
 * Predicate for the result that closes the turn of one message.
 * @param {string} sessionId
 * @param {string} clientMessageId
 */
export function turnResult(sessionId, clientMessageId) {
  return (/** @type {any} */ frame) => frame.event === 'sdk' && frame.data?.sessionId === sessionId
    && frame.data.msg?.type === 'result' && frame.data.msg.user_message_uuid === clientMessageId;
}

/**
 * Predicate for a global event (anything but `sdk`) with an exact data match on the given keys.
 * @param {string} event
 * @param {Record<string, unknown>} [match]
 */
export function eventNamed(event, match = {}) {
  return (/** @type {any} */ frame) => frame.event === event
    && Object.entries(match).every(([key, value]) => frame.data?.[key] === value);
}

/**
 * Sends one user message and waits for the result of its turn.
 * @param {Client} api
 * @param {ReturnType<typeof wrapStream>} events stream watching the session
 * @param {string} sessionId
 * @param {string} text
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{clientMessageId: string, accepted: any, result: any}>}
 */
export async function runTurn(api, events, sessionId, text, { timeoutMs = 10000 } = {}) {
  const clientMessageId = randomUUID();
  const accepted = await api.post(`/api/sessions/${sessionId}/messages`, { clientMessageId, text });
  assert.equal(accepted.status, 200, `message refused: ${accepted.text}`);
  const frame = await events.next(turnResult(sessionId, clientMessageId), timeoutMs);
  return { clientMessageId, accepted: accepted.json, result: frame.data.msg };
}

/**
 * Creates a live session and returns its LiveInfo.
 * @param {Client} api
 * @param {Record<string, unknown>} body
 */
export async function createLive(api, body) {
  const res = await api.post('/api/sessions', body);
  assert.equal(res.status, 200, `session not created: ${res.text}`);
  return res.json.live;
}

/**
 * Asserts a documented error response.
 * @param {{status: number, json: any, text: string}} res
 * @param {number} status
 * @param {string} code
 */
export function assertError(res, status, code) {
  assert.equal(res.status, status, `expected HTTP ${status} ${code}, got ${res.status}: ${res.text}`);
  assert.equal(res.json?.error?.code, code, `expected error code ${code}, got: ${res.text}`);
  assert.equal(typeof res.json.error.message, 'string');
}

/**
 * Asserts the headers that every gateway response carries (HTML, JSON, errors, streams). Plain HTTP never gets HSTS.
 * @param {{headers: Record<string, unknown>}} res
 */
export function assertSecurityHeaders(res) {
  assert.equal(res.headers['content-security-policy'], CONTENT_SECURITY_POLICY);
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.equal(res.headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(res.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(res.headers['permissions-policy'], PERMISSIONS_POLICY);
  assert.equal(res.headers['strict-transport-security'], undefined);
}

/** @param {string} value */
export function isUuid(value) {
  return UUID_RE.test(value);
}

/**
 * The SDK messages of one session seen by a stream, oldest first.
 * @param {ReturnType<typeof wrapStream>} events
 * @param {string} sessionId
 */
export function sdkMessagesOf(events, sessionId) {
  return events.all()
    .filter((frame) => frame.event === 'sdk' && frame.data?.sessionId === sessionId)
    .map((frame) => frame.data.msg);
}
