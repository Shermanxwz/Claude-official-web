// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AppError } from '../../src/contracts.mjs';
import { createAuth } from '../../src/auth.mjs';
import { loadConfig } from '../../src/config.mjs';
import { sendError, sendJson } from '../../src/http.mjs';

const TOKEN = 'correct-horse-battery';
const BOOT = 'boot-under-test';
const LOGGER = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** @type {string} */
let root = '';

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'caw-auth-'));
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * @param {Record<string, string>} [extra]
 */
function configFor(extra = {}) {
  return loadConfig({
    HOME: root,
    CAW_WORKSPACE_ROOTS: root,
    CAW_STATE_DIR: path.join(root, 'state'),
    CAW_TOKEN: TOKEN,
    ...extra,
  }, { packageVersion: '1.2.3' });
}

/**
 * Controllable clock.
 * @param {number} [start]
 */
function clock(start = 2000000000000) {
  let current = start;
  return {
    now: () => current,
    advance: (/** @type {number} */ ms) => {
      current += ms;
    },
  };
}

/**
 * Starts a server exposing the auth module the way app.mjs uses it.
 * @param {ReturnType<typeof createAuth>} auth
 * @returns {Promise<{port: number, close: () => Promise<void>}>}
 */
function startAuthServer(auth) {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/api/session') {
        sendJson(res, 200, auth.sessionInfo(req));
      } else if (req.method === 'POST' && req.url === '/api/login') {
        await auth.login(req, res);
      } else if (req.method === 'POST' && req.url === '/api/logout') {
        if (!auth.authenticate(req)) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue');
        auth.checkOrigin(req);
        auth.logout(req, res);
      } else if (req.method === 'GET' && req.url === '/whoami') {
        const actor = auth.authenticate(req);
        if (!actor) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue');
        sendJson(res, 200, { profile: actor.profile });
      } else if (req.method === 'GET' && req.url === '/client') {
        sendJson(res, 200, { address: auth.clientAddress(req) });
      } else {
        sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'missing' } });
      }
    } catch (error) {
      sendError(res, error, LOGGER);
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = /** @type {import('node:net').AddressInfo} */ (server.address());
      resolve({
        port: address.port,
        close: () => new Promise((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
      });
    });
  });
}

/**
 * @param {number} port
 * @param {string} method
 * @param {string} target
 * @param {{headers?: Record<string, string>, body?: unknown}} [options]
 * @returns {Promise<{status: number, headers: http.IncomingHttpHeaders, json: any}>}
 */
function call(port, method, target, { headers = {}, body } = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const resolved = Object.fromEntries(Object.entries(headers).map(([name, value]) => [
    name,
    name.toLowerCase() === 'origin' && value === SAME_ORIGIN ? `http://127.0.0.1:${port}` : value,
  ]));
  return new Promise((resolve, reject) => {
    const req = http.request({
      agent: false,
      host: '127.0.0.1',
      port,
      method,
      path: target,
      headers: {
        ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...resolved,
      },
    }, (res) => {
      /** @type {Buffer[]} */
      const parts = [];
      res.on('data', (chunk) => parts.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        resolve({ status: res.statusCode ?? 0, headers: res.headers, json: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/** Replaced by call() with the origin of the test server, which has an ephemeral port. */
const SAME_ORIGIN = '@same-origin';
const ORIGIN = { Origin: SAME_ORIGIN };

/**
 * @param {import('node:http').IncomingHttpHeaders} headers
 * @returns {string[]}
 */
function setCookies(headers) {
  const value = headers['set-cookie'];
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * @param {string} setCookie
 * @returns {string} the name=value pair of a Set-Cookie header
 */
function pairOf(setCookie) {
  return setCookie.split(';')[0];
}

describe('sessionInfo', () => {
  it('describes an anonymous client when no session cookie is present', async () => {
    const auth = createAuth(configFor(), { log: LOGGER, bootId: BOOT });
    const server = await startAuthServer(auth);
    try {
      const response = await call(server.port, 'GET', '/api/session');
      assert.deepEqual(response.json, {
        authenticated: false,
        authRequired: true,
        profile: null,
        appName: 'Agent Web',
        version: '1.2.3',
        bootId: BOOT,
      });
    } finally {
      await server.close();
    }
  });
});

describe('login', () => {
  it('issues an HttpOnly, SameSite=Strict session cookie for the correct token', async () => {
    const auth = createAuth(configFor(), { log: LOGGER, bootId: BOOT });
    const server = await startAuthServer(auth);
    try {
      const response = await call(server.port, 'POST', '/api/login', { headers: ORIGIN, body: { token: TOKEN } });
      assert.equal(response.status, 200);
      assert.deepEqual(response.json, { ok: true });
      const [cookie] = setCookies(response.headers);
      assert.match(cookie, /^caw_session=v1\.\d+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43};/);
      assert.match(cookie, /; HttpOnly/);
      assert.match(cookie, /; SameSite=Strict/);
      assert.match(cookie, /; Path=\//);
      assert.match(cookie, /; Max-Age=604800/);
      assert.doesNotMatch(cookie, /; Secure/);

      const session = await call(server.port, 'GET', '/api/session', { headers: { Cookie: pairOf(cookie) } });
      assert.equal(session.json.authenticated, true);
      assert.equal(session.json.profile, 'full');
    } finally {
      await server.close();
    }
  });

  it('adds Secure to the cookie when the public origin is https', async () => {
    const config = configFor({ CAW_PUBLIC_ORIGIN: 'https://gw.example' });
    const auth = createAuth(config, { log: LOGGER, bootId: BOOT });
    const server = await startAuthServer(auth);
    try {
      const response = await call(server.port, 'POST', '/api/login', {
        headers: { Origin: 'https://gw.example' }, body: { token: TOKEN },
      });
      assert.match(setCookies(response.headers)[0], /; Secure$/);
    } finally {
      await server.close();
    }
  });

  it('rejects a wrong token with 401 and sets no cookie', async () => {
    const auth = createAuth(configFor(), { log: LOGGER, bootId: BOOT });
    const server = await startAuthServer(auth);
    try {
      const response = await call(server.port, 'POST', '/api/login', { headers: ORIGIN, body: { token: 'nope' } });
      assert.equal(response.status, 401);
      assert.equal(response.json.error.code, 'INVALID_TOKEN');
      assert.deepEqual(setCookies(response.headers), []);
    } finally {
      await server.close();
    }
  });

  it('answers 400 for a missing, non-string or oversized token without counting it as a failure', async () => {
    const auth = createAuth(configFor(), { log: LOGGER, bootId: BOOT });
    const server = await startAuthServer(auth);
    try {
      assert.equal((await call(server.port, 'POST', '/api/login', { headers: ORIGIN, body: {} })).status, 400);
      const nonString = await call(server.port, 'POST', '/api/login', { headers: ORIGIN, body: { token: 7 } });
      assert.equal(nonString.status, 400);
      const oversized = 'x'.repeat(1025);
      assert.equal((await call(server.port, 'POST', '/api/login', {
        headers: ORIGIN, body: { token: oversized },
      })).status, 400);
    } finally {
      await server.close();
    }
  });

  it('requires an Origin that matches the public origin, or the Host when none is configured', async () => {
    const auth = createAuth(configFor({ CAW_PUBLIC_ORIGIN: 'https://gw.example' }), { log: LOGGER, bootId: BOOT });
    const server = await startAuthServer(auth);
    try {
      const missing = await call(server.port, 'POST', '/api/login', { body: { token: TOKEN } });
      assert.equal(missing.status, 403);
      assert.equal(missing.json.error.code, 'ORIGIN_REJECTED');
      const wrong = await call(server.port, 'POST', '/api/login', {
        headers: { Origin: 'https://evil.example' }, body: { token: TOKEN },
      });
      assert.equal(wrong.status, 403);
    } finally {
      await server.close();
    }

    const hostBased = createAuth(configFor(), { log: LOGGER, bootId: BOOT });
    const second = await startAuthServer(hostBased);
    try {
      const sameHost = await call(second.port, 'POST', '/api/login', {
        headers: { Origin: `http://127.0.0.1:${second.port}` }, body: { token: TOKEN },
      });
      assert.equal(sameHost.status, 200);
      const crossHost = await call(second.port, 'POST', '/api/login', {
        headers: { Origin: 'http://attacker.example' }, body: { token: TOKEN },
      });
      assert.equal(crossHost.status, 403);
    } finally {
      await second.close();
    }
  });

  it('throttles failed attempts: 10 per 10 minutes, then 429 with Retry-After until the window slides', async () => {
    const time = clock();
    const auth = createAuth(configFor(), { log: LOGGER, bootId: BOOT, now: time.now });
    const server = await startAuthServer(auth);
    try {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const failed = await call(server.port, 'POST', '/api/login', { headers: ORIGIN, body: { token: 'bad' } });
        assert.equal(failed.status, 401);
      }
      const limited = await call(server.port, 'POST', '/api/login', { headers: ORIGIN, body: { token: TOKEN } });
      assert.equal(limited.status, 429);
      assert.equal(limited.json.error.code, 'RATE_LIMITED');
      assert.equal(limited.headers['retry-after'], '600');

      time.advance(600001);
      const restored = await call(server.port, 'POST', '/api/login', { headers: ORIGIN, body: { token: TOKEN } });
      assert.equal(restored.status, 200);
    } finally {
      await server.close();
    }
  });

  it('resets the failure count after a successful login', async () => {
    const auth = createAuth(configFor(), { log: LOGGER, bootId: BOOT, now: clock().now });
    const server = await startAuthServer(auth);
    try {
      for (let round = 0; round < 2; round += 1) {
        for (let attempt = 0; attempt < 9; attempt += 1) {
          await call(server.port, 'POST', '/api/login', { headers: ORIGIN, body: { token: 'bad' } });
        }
        const accepted = await call(server.port, 'POST', '/api/login', { headers: ORIGIN, body: { token: TOKEN } });
        assert.equal(accepted.status, 200);
      }
    } finally {
      await server.close();
    }
  });

  it('counts failures per client address when a trusted proxy supplies X-Forwarded-For', async () => {
    const auth = createAuth(configFor({ CAW_TRUST_PROXY: '1' }), { log: LOGGER, bootId: BOOT, now: clock().now });
    const server = await startAuthServer(auth);
    try {
      const forwarded = (/** @type {string} */ address) => ({ ...ORIGIN, 'X-Forwarded-For': `${address}, 10.0.0.1` });
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await call(server.port, 'POST', '/api/login', { headers: forwarded('203.0.113.9'), body: { token: 'bad' } });
      }
      assert.equal((await call(server.port, 'POST', '/api/login', {
        headers: forwarded('203.0.113.9'), body: { token: TOKEN },
      })).status, 429);
      assert.equal((await call(server.port, 'POST', '/api/login', {
        headers: forwarded('203.0.113.10'), body: { token: TOKEN },
      })).status, 200);
    } finally {
      await server.close();
    }
  });

  it('skips token checks and returns ok without a cookie when authentication is disabled', async () => {
    const config = configFor({ CAW_REQUIRE_AUTH: '0', CAW_TOKEN: '' });
    const auth = createAuth(config, { log: LOGGER, bootId: BOOT });
    const server = await startAuthServer(auth);
    try {
      const response = await call(server.port, 'POST', '/api/login', { headers: ORIGIN, body: { token: 'anything' } });
      assert.equal(response.status, 200);
      assert.deepEqual(response.json, { ok: true });
      assert.deepEqual(setCookies(response.headers), []);
      const session = await call(server.port, 'GET', '/api/session');
      assert.deepEqual([session.json.authenticated, session.json.authRequired, session.json.profile],
        [true, false, 'full']);
    } finally {
      await server.close();
    }
  });
});

describe('logout and session validity', () => {
  it('revokes the cookie and clears it on the client', async () => {
    const auth = createAuth(configFor(), { log: LOGGER, bootId: BOOT, now: clock().now });
    const server = await startAuthServer(auth);
    try {
      const login = await call(server.port, 'POST', '/api/login', { headers: ORIGIN, body: { token: TOKEN } });
      const pair = pairOf(setCookies(login.headers)[0]);
      assert.equal((await call(server.port, 'GET', '/whoami', { headers: { Cookie: pair } })).status, 200);

      const logout = await call(server.port, 'POST', '/api/logout', { headers: { ...ORIGIN, Cookie: pair } });
      assert.equal(logout.status, 200);
      assert.deepEqual(logout.json, { ok: true });
      const cleared = setCookies(logout.headers)[0];
      assert.match(cleared, /^caw_session=;/);
      assert.match(cleared, /Max-Age=0/);
      assert.match(cleared, /HttpOnly/);

      assert.equal((await call(server.port, 'GET', '/whoami', { headers: { Cookie: pair } })).status, 401);
    } finally {
      await server.close();
    }
  });

  it('requires a session to log out and an allowed origin', async () => {
    const auth = createAuth(configFor(), { log: LOGGER, bootId: BOOT, now: clock().now });
    const server = await startAuthServer(auth);
    try {
      assert.equal((await call(server.port, 'POST', '/api/logout', { headers: ORIGIN })).status, 401);
      const login = await call(server.port, 'POST', '/api/login', { headers: ORIGIN, body: { token: TOKEN } });
      const pair = pairOf(setCookies(login.headers)[0]);
      const crossOrigin = await call(server.port, 'POST', '/api/logout', {
        headers: { Origin: 'http://evil.example', Cookie: pair },
      });
      assert.equal(crossOrigin.status, 403);
    } finally {
      await server.close();
    }
  });

  it('keeps sessions valid across restarts with the same token and rejects other tokens', async () => {
    const time = clock();
    const first = createAuth(configFor(), { log: LOGGER, bootId: 'boot-a', now: time.now });
    const server = await startAuthServer(first);
    const login = await call(server.port, 'POST', '/api/login', { headers: ORIGIN, body: { token: TOKEN } });
    const cookie = pairOf(setCookies(login.headers)[0]);
    await server.close();

    const restarted = createAuth(configFor(), { log: LOGGER, bootId: 'boot-b', now: time.now });
    const restartedServer = await startAuthServer(restarted);
    try {
      const decoys = `theme=dark; caw_session=v1.1.bogus.bogus; ${cookie}`;
      assert.equal((await call(restartedServer.port, 'GET', '/whoami', { headers: { Cookie: decoys } })).status, 200);
    } finally {
      await restartedServer.close();
    }

    const rotated = createAuth(configFor({ CAW_TOKEN: 'a-different-token-123' }), {
      log: LOGGER, bootId: 'boot-c', now: time.now,
    });
    const rotatedServer = await startAuthServer(rotated);
    try {
      assert.equal((await call(rotatedServer.port, 'GET', '/whoami', { headers: { Cookie: cookie } })).status, 401);
    } finally {
      await rotatedServer.close();
    }
  });

  it('finds the session among several cookies and ignores look-alike names', () => {
    const time = clock();
    const auth = createAuth(configFor(), { log: LOGGER, bootId: BOOT, now: time.now });
    /** @param {string} cookie */
    const fake = (cookie) => /** @type {any} */ ({ headers: { cookie }, socket: { remoteAddress: '::1' } });
    assert.equal(auth.authenticate(fake('theme=dark')), null);
    assert.equal(auth.authenticate(fake('xcaw_session=v1.1.abc.def')), null);
    assert.equal(auth.authenticate(fake('caw_session=v1.1.abc.def; caw_session=nonsense')), null);
  });

  it('returns the configured profile for an authenticated request and null otherwise', () => {
    const auth = createAuth(configFor({ CAW_ACCESS_PROFILE: 'standard' }), { log: LOGGER, bootId: BOOT });
    assert.equal(auth.authenticate(/** @type {any} */ ({ headers: {}, socket: {} })), null);
    assert.deepEqual(createAuth(configFor({ CAW_REQUIRE_AUTH: '0', CAW_TOKEN: '', CAW_ACCESS_PROFILE: 'read' }), {
      log: LOGGER, bootId: BOOT,
    }).authenticate(/** @type {any} */ ({ headers: {}, socket: {} })), { profile: 'read' });
  });
});

describe('checkOrigin', () => {
  /** @param {Record<string, string>} headers */
  const req = (headers) => /** @type {any} */ ({ headers, socket: { remoteAddress: '127.0.0.1' } });

  it('requires an Origin header in every case', () => {
    const auth = createAuth(configFor(), { log: LOGGER, bootId: BOOT });
    assert.throws(() => auth.checkOrigin(req({ host: '127.0.0.1:4180' })),
      (error) => error instanceof AppError && error.status === 403 && error.code === 'ORIGIN_REJECTED');
  });

  it('compares with the configured public origin when one is set', () => {
    const auth = createAuth(configFor({ CAW_PUBLIC_ORIGIN: 'https://gw.example' }), { log: LOGGER, bootId: BOOT });
    assert.doesNotThrow(() => auth.checkOrigin(req({ origin: 'https://gw.example', host: 'internal:4180' })));
    assert.throws(() => auth.checkOrigin(req({ origin: 'http://internal:4180', host: 'internal:4180' })),
      AppError);
  });

  it('compares with the Host header when no public origin is set', () => {
    const auth = createAuth(configFor(), { log: LOGGER, bootId: BOOT });
    assert.doesNotThrow(() => auth.checkOrigin(req({ origin: 'http://127.0.0.1:4180', host: '127.0.0.1:4180' })));
    assert.throws(() => auth.checkOrigin(req({ origin: 'http://127.0.0.1:9999', host: '127.0.0.1:4180' })), AppError);
  });
});

describe('requireProfile', () => {
  const auth = createAuth(configFor(), { log: LOGGER, bootId: BOOT });

  it('orders read < standard < full and lets higher profiles satisfy lower requirements', () => {
    assert.doesNotThrow(() => auth.requireProfile('read', 'read'));
    assert.doesNotThrow(() => auth.requireProfile('standard', 'read'));
    assert.doesNotThrow(() => auth.requireProfile('full', 'standard'));
    assert.doesNotThrow(() => auth.requireProfile('full', 'full'));
  });

  it('answers 403 FORBIDDEN when the profile is too low or missing', () => {
    assert.throws(() => auth.requireProfile('read', 'standard'),
      (error) => error instanceof AppError && error.status === 403 && error.code === 'FORBIDDEN');
    assert.throws(() => auth.requireProfile('standard', 'full'), AppError);
    assert.throws(() => auth.requireProfile(null, 'read'), AppError);
  });

  it('rejects an unknown required profile as a programming error', () => {
    assert.throws(() => auth.requireProfile('full', /** @type {any} */ ('admin')), TypeError);
  });
});

describe('clientAddress', () => {
  /**
   * @param {Record<string, string>} extra
   */
  async function addressFor(extra) {
    const config = configFor({ CAW_TRUST_PROXY: extra.trust ?? '0' });
    const auth = createAuth(config, { log: LOGGER, bootId: BOOT });
    const server = await startAuthServer(auth);
    try {
      const headers = extra.forwarded ? { 'X-Forwarded-For': extra.forwarded } : {};
      const response = await call(server.port, 'GET', '/client', { headers });
      return response.json.address;
    } finally {
      await server.close();
    }
  }

  it('uses the socket address and ignores X-Forwarded-For unless the proxy is trusted', async () => {
    assert.equal(await addressFor({ forwarded: '198.51.100.7' }), '127.0.0.1');
  });

  it('uses the first X-Forwarded-For hop when the proxy is trusted, and ignores malformed hops', async () => {
    assert.equal(await addressFor({ trust: '1', forwarded: '198.51.100.7, 10.0.0.2' }), '198.51.100.7');
    assert.equal(await addressFor({ trust: '1', forwarded: '2001:DB8::1' }), '2001:db8::1');
    assert.equal(await addressFor({ trust: '1', forwarded: '<script>' }), '127.0.0.1');
  });
});

describe('authentication disabled', () => {
  it('treats every request as the configured profile and clears cookies on logout', async () => {
    const auth = createAuth(configFor({ CAW_REQUIRE_AUTH: '0', CAW_TOKEN: '', CAW_ACCESS_PROFILE: 'standard' }), {
      log: LOGGER, bootId: BOOT,
    });
    const server = await startAuthServer(auth);
    try {
      const whoami = await call(server.port, 'GET', '/whoami');
      assert.deepEqual(whoami.json, { profile: 'standard' });
      const logout = await call(server.port, 'POST', '/api/logout', { headers: ORIGIN });
      assert.equal(logout.status, 200);
      assert.match(setCookies(logout.headers)[0], /Max-Age=0/);
    } finally {
      await server.close();
    }
  });
});
