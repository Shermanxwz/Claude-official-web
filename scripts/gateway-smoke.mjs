// @ts-check
/**
 * Validates a deployed gateway over the network: health, the unauthenticated session probe, login cookie attributes,
 * Origin enforcement, the authenticated meta (the production engine), the event stream (hello and heartbeat) and
 * logout revocation. It creates no sessions and runs no model turns, so it is safe to run against a live gateway.
 *
 *   CAW_GATEWAY_URL=https://claude.example.com CAW_GATEWAY_TOKEN=... node scripts/gateway-smoke.mjs
 *
 * Environment:
 *   CAW_GATEWAY_URL     required. The origin as clients reach it, for example https://claude.example.com
 *   CAW_GATEWAY_TOKEN   required. The gateway login token. It is never printed.
 *   CAW_GATEWAY_ORIGIN  optional. The Origin sent with writes. Defaults to the URL origin; set it when the public
 *                       origin the gateway is configured with (CAW_PUBLIC_ORIGIN) differs from the URL you test.
 */
import { SESSION_COOKIE } from '../src/contracts.mjs';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);
const FOREIGN_ORIGIN = 'https://origin-rejection.invalid';
const HELLO_TIMEOUT_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 15_000;

class SmokeError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'SmokeError';
  }
}

/**
 * @param {boolean} condition
 * @param {string} message
 * @returns {asserts condition}
 */
function expect(condition, message) {
  if (!condition) throw new SmokeError(message);
}

/**
 * @param {string} name
 * @returns {string}
 */
function requiredEnv(name) {
  const value = (process.env[name] ?? '').trim();
  if (!value) throw new SmokeError(`${name} is required`);
  return value;
}

/**
 * @param {string} value
 * @returns {boolean} true when the value is a canonical http(s) origin
 */
function isCanonicalOrigin(value) {
  try {
    const parsed = new URL(value);
    return parsed.origin === value && ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * @returns {{base: URL, origin: string, token: string}}
 */
function readTarget() {
  const rawUrl = requiredEnv('CAW_GATEWAY_URL');
  /** @type {URL} */
  let base;
  try {
    base = new URL(rawUrl);
  } catch {
    throw new SmokeError('CAW_GATEWAY_URL is not a valid URL');
  }
  expect(['http:', 'https:'].includes(base.protocol), 'CAW_GATEWAY_URL must use http or https');
  expect(!base.username && !base.password && !base.search && !base.hash && base.pathname === '/',
    'CAW_GATEWAY_URL must be an origin without credentials, path, query or fragment');
  expect(base.protocol === 'https:' || LOOPBACK_HOSTS.has(base.hostname),
    'a non-loopback gateway must be served over https');

  const origin = (process.env.CAW_GATEWAY_ORIGIN ?? '').trim() || base.origin;
  expect(isCanonicalOrigin(origin), 'CAW_GATEWAY_ORIGIN must be a canonical origin such as https://claude.example.com');

  const token = requiredEnv('CAW_GATEWAY_TOKEN');
  expect(token.length >= 16, 'CAW_GATEWAY_TOKEN must be at least 16 characters');
  return { base, origin, token };
}

/**
 * @param {string} text
 * @returns {any} parsed JSON, or null when the body is empty or not JSON
 */
function parseBody(text) {
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * @param {URL} base
 * @param {string} method
 * @param {string} pathname
 * @param {{headers?: Record<string, string>, body?: unknown}} [options]
 * @returns {Promise<{status: number, headers: Headers, body: any}>}
 */
async function send(base, method, pathname, options = {}) {
  /** @type {Record<string, string>} */
  const headers = { ...(options.headers ?? {}) };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(new URL(pathname, base), {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { status: response.status, headers: response.headers, body: parseBody(await response.text()) };
}

/**
 * @param {{status: number, body: any}} response
 * @returns {string} status and stable error code, never the body
 */
function describe(response) {
  const code = response.body?.error?.code;
  return code ? `HTTP ${response.status} ${code}` : `HTTP ${response.status}`;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  if (!(error instanceof Error)) return String(error);
  const cause = /** @type {{code?: unknown}} */ (error.cause ?? {});
  return typeof cause.code === 'string' ? `${error.message} (${cause.code})` : error.message;
}

/**
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader
 * @param {number} timeoutMs
 * @param {string} label
 * @returns {Promise<{done: boolean, value?: Uint8Array}>}
 */
async function readWithin(reader, timeoutMs, label) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  /** @type {Promise<never>} */
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new SmokeError(`timed out waiting for ${label}`)), timeoutMs);
  });
  try {
    return await Promise.race([reader.read(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} frame one SSE frame without its terminating blank line
 * @returns {{type: string, data: any} | null}
 */
function parseFrame(frame) {
  let type = 'message';
  /** @type {string[]} */
  const data = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) type = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  return data.length > 0 ? { type, data: JSON.parse(data.join('\n')) } : null;
}

/**
 * @param {Response} response an open text/event-stream response
 */
function createEventReader(response) {
  if (!response.body) throw new SmokeError('the event stream has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    /**
     * @param {(event: {type: string, data: any}) => boolean} predicate
     * @param {number} timeoutMs
     * @param {string} label
     * @returns {Promise<{type: string, data: any}>}
     */
    async waitFor(predicate, timeoutMs, label) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary !== -1) {
          const event = parseFrame(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          if (event && predicate(event)) return event;
          continue;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new SmokeError(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${label}`);
        const chunk = await readWithin(reader, remaining, label);
        if (chunk.done) throw new SmokeError(`the event stream closed before ${label}`);
        buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, '\n');
      }
    },
    async close() {
      try {
        await reader.cancel();
      } catch {
        // The stream had already ended.
      }
    },
  };
}

/**
 * @param {URL} base
 * @param {string} cookie
 */
async function openEvents(base, cookie) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  /** @type {Response} */
  let response;
  try {
    response = await fetch(new URL('/api/events', base), {
      headers: { cookie, accept: 'text/event-stream' },
      redirect: 'error',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  expect(response.ok, `the event stream returned HTTP ${response.status}`);
  expect((response.headers.get('content-type') ?? '').startsWith('text/event-stream'),
    'the event stream did not answer with text/event-stream');
  return createEventReader(response);
}

/**
 * @returns {Promise<Record<string, unknown>>} the validation summary
 */
async function run() {
  const { base, origin, token } = readTarget();
  const secure = base.protocol === 'https:';
  /** @type {string[]} */
  const checks = [];
  /** @type {string} */
  let cookie = '';
  let loggedOut = false;
  /** @type {Awaited<ReturnType<typeof openEvents>> | null} */
  let events = null;

  try {
    const health = await send(base, 'GET', '/healthz');
    expect(health.status === 200 && health.body?.ok === true, `GET /healthz returned ${describe(health)}`);
    checks.push('healthz');

    const probe = await send(base, 'GET', '/api/session');
    expect(probe.status === 200, `GET /api/session returned ${describe(probe)}`);
    expect(probe.body?.authRequired === true, 'the gateway does not require authentication; set CAW_REQUIRE_AUTH=1');
    expect(probe.body?.authenticated === false, 'an unauthenticated probe reports an authenticated session');
    expect(typeof probe.body?.bootId === 'string' && probe.body.bootId.length > 0, 'GET /api/session has no bootId');
    const bootId = probe.body.bootId;
    checks.push('session-probe');

    const login = await send(base, 'POST', '/api/login', { headers: { origin }, body: { token } });
    expect(login.status === 200 && login.body?.ok === true, `login returned ${describe(login)}`);
    const issued = login.headers.getSetCookie().find((value) => value.startsWith(`${SESSION_COOKIE}=`)) ?? '';
    expect(issued !== '', 'login did not set the session cookie');
    expect(/;\s*HttpOnly\s*(?:;|$)/i.test(issued), 'the session cookie is missing HttpOnly');
    expect(/;\s*SameSite=Strict\s*(?:;|$)/i.test(issued), 'the session cookie is missing SameSite=Strict');
    if (secure) expect(/;\s*Secure\s*(?:;|$)/i.test(issued), 'the session cookie is missing Secure on an https origin');
    cookie = issued.split(';', 1)[0];
    checks.push('login-cookie-attributes');

    const foreign = await send(base, 'POST', '/api/login', {
      headers: { origin: FOREIGN_ORIGIN },
      body: { token: 'origin-probe' },
    });
    expect(foreign.status === 403 && foreign.body?.error?.code === 'ORIGIN_REJECTED',
      `a write with a foreign Origin returned ${describe(foreign)}, expected 403 ORIGIN_REJECTED`);
    checks.push('origin-enforced');

    const meta = await send(base, 'GET', '/api/meta', { headers: { cookie } });
    expect(meta.status === 200, `GET /api/meta returned ${describe(meta)} after login`);
    expect(meta.body?.bootId === bootId, 'GET /api/meta reports a different gateway boot than the session probe');
    expect(meta.body?.engine === 'sdk', `the deployed gateway uses engine ${meta.body?.engine}; production requires sdk`);
    checks.push('meta');

    events = await openEvents(base, cookie);
    const hello = await events.waitFor((event) => event.type === 'hello', HELLO_TIMEOUT_MS, 'the SSE hello event');
    expect(hello.data?.bootId === bootId, 'the event stream belongs to a different gateway boot');
    checks.push('sse-hello');
    await events.waitFor((event) => event.type === 'heartbeat', HEARTBEAT_TIMEOUT_MS, 'the SSE heartbeat event');
    checks.push('sse-heartbeat');
    await events.close();
    events = null;

    const logout = await send(base, 'POST', '/api/logout', { headers: { origin, cookie } });
    expect(logout.status === 200 && logout.body?.ok === true, `logout returned ${describe(logout)}`);
    loggedOut = true;
    const revoked = await send(base, 'GET', '/api/meta', { headers: { cookie } });
    expect(revoked.status === 401 && revoked.body?.error?.code === 'UNAUTHENTICATED',
      `after logout GET /api/meta returned ${describe(revoked)}, expected 401 UNAUTHENTICATED`);
    checks.push('logout-revokes-session');

    return {
      ok: true,
      target: base.origin,
      tls: secure,
      origin,
      version: meta.body.version,
      engine: meta.body.engine,
      profile: meta.body.profile,
      sdkVersion: meta.body.sdkVersion,
      claudeCodeVersion: meta.body.claudeCodeVersion,
      features: meta.body.features,
      checks,
      at: new Date().toISOString(),
    };
  } finally {
    if (events) await events.close();
    if (cookie && !loggedOut) {
      await send(base, 'POST', '/api/logout', { headers: { origin, cookie } }).catch(() => undefined);
    }
  }
}

/** @returns {Promise<number>} process exit code */
async function main() {
  try {
    const summary = await run();
    console.log(JSON.stringify(summary, null, 2));
    console.log('GATEWAY_VALIDATED');
    return 0;
  } catch (error) {
    console.error(`GATEWAY_SMOKE_FAILED: ${describeError(error)}`);
    return 1;
  }
}

process.exitCode = await main();
