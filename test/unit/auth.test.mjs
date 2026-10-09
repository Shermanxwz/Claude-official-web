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
import { sha256Hex } from '../../src/security.mjs';

const TOKEN = 'correct-horse-battery';
const BOOT = 'boot-under-test';
const LOGGER = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const REVOCATIONS = 'revoked-sessions';

/** @typedef {Awaited<ReturnType<typeof createAuth>>} Auth */

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
 * In-memory stand-in for the state store: same read/write contract, JSON copies on both sides.
 */
function memoryStore() {
  /** @type {Map<string, string>} */
  const files = new Map();
  return {
    files,
    /** @param {string} name */
    async read(name, /** @type {unknown} */ fallback) {
      return files.has(name) ? JSON.parse(/** @type {string} */ (files.get(name))) : fallback;
    },
    /**
     * @param {string} name
     * @param {unknown} value
     */
    async write(name, value) {
      files.set(name, JSON.stringify(value));
    },
  };
}

/**
 * Starts a server exposing the auth module the way app.mjs uses it.
 * @param {Auth} auth
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
        await auth.logout(req, res);
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

/**
 * @param {string} pair caw_session=<value>
 * @returns {string} the cookie value
 */
function valueOf(pair) {
  return pair.slice('caw_session='.length);
}

/**
 * Logs in through the HTTP surface and returns the name=value pair of the issued cookie.
 * @param {number} port
 */
async function loginCookie(port) {
  const login = await call(port, 'POST', '/api/login', { headers: ORIGIN, body: { token: TOKEN } });
  assert.equal(login.status, 200);
  return pairOf(setCookies(login.headers)[0]);
}

describe('sessionInfo', () => {
  it('describes an anonymous client when no session cookie is present', async () => {
    const auth = await createAuth(configFor(), { log: LOGGER, bootId: BOOT });
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
    const auth = await createAuth(configFor(), { log: LOGGER, bootId: BOOT });
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
    const auth = await createAuth(config, { log: LOGGER, bootId: BOOT });
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
    const auth = await createAuth(configFor(), { log: LOGGER, bootId: BOOT });
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
    const auth = await createAuth(configFor(), { log: LOGGER, bootId: BOOT });
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
    const auth = await createAuth(configFor({ CAW_PUBLIC_ORIGIN: 'https://gw.example' }), {
      log: LOGGER, bootId: BOOT,
    });
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

    const hostBased = await createAuth(configFor(), { log: LOGGER, bootId: BOOT });
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
    const auth = await createAuth(configFor(), { log: LOGGER, bootId: BOOT, now: time.now });
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
    const auth = await createAuth(configFor(), { log: LOGGER, bootId: BOOT, now: clock().now });
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

  it('counts failures per client address taken from the trusted proxy, not from a spoofed first hop', async () => {
    const auth = await createAuth(configFor({ CAW_TRUST_PROXY: '1' }), {
      log: LOGGER, bootId: BOOT, now: clock().now,
    });
    const server = await startAuthServer(auth);
    try {
      // The client can prepend anything; the proxy appends the address it saw, which is the last hop.
      const forwarded = (/** @type {string} */ address) => ({ ...ORIGIN, 'X-Forwarded-For': `10.9.9.9, ${address}` });
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await call(server.port, 'POST', '/api/login', { headers: forwarded('203.0.113.9'), body: { token: 'bad' } });
      }
      assert.equal((await call(server.port, 'POST', '/api/login', {
        headers: { ...ORIGIN, 'X-Forwarded-For': `198.51.100.1, 203.0.113.9` }, body: { token: TOKEN },
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
    const auth = await createAuth(config, { log: LOGGER, bootId: BOOT });
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

  it('verifies logins against CAW_TOKEN_SHA256 without the plaintext token being configured', async () => {
    const config = configFor({ CAW_TOKEN: '', CAW_TOKEN_SHA256: sha256Hex(TOKEN) });
    const auth = await createAuth(config, { log: LOGGER, bootId: BOOT, now: clock().now });
    const server = await startAuthServer(auth);
    try {
      assert.equal(config.token, '');
      const wrong = await call(server.port, 'POST', '/api/login', {
        headers: ORIGIN, body: { token: 'not-the-token' },
      });
      assert.equal(wrong.status, 401);
      const right = await call(server.port, 'POST', '/api/login', { headers: ORIGIN, body: { token: TOKEN } });
      assert.equal(right.status, 200);
      assert.equal((await call(server.port, 'GET', '/whoami', {
        headers: { Cookie: pairOf(setCookies(right.headers)[0]) },
      })).status, 200);
    } finally {
      await server.close();
    }
  });
});

describe('logout and session validity', () => {
  it('revokes the cookie and clears it on the client', async () => {
    const auth = await createAuth(configFor(), { log: LOGGER, bootId: BOOT, now: clock().now });
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
    const auth = await createAuth(configFor(), { log: LOGGER, bootId: BOOT, now: clock().now });
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
    const first = await createAuth(configFor(), { log: LOGGER, bootId: 'boot-a', now: time.now });
    const server = await startAuthServer(first);
    const login = await call(server.port, 'POST', '/api/login', { headers: ORIGIN, body: { token: TOKEN } });
    const cookie = pairOf(setCookies(login.headers)[0]);
    await server.close();

    const restarted = await createAuth(configFor(), { log: LOGGER, bootId: 'boot-b', now: time.now });
    const restartedServer = await startAuthServer(restarted);
    try {
      const decoys = `theme=dark; caw_session=v1.1.bogus.bogus; ${cookie}`;
      assert.equal((await call(restartedServer.port, 'GET', '/whoami', { headers: { Cookie: decoys } })).status, 200);
    } finally {
      await restartedServer.close();
    }

    const rotated = await createAuth(configFor({ CAW_TOKEN: 'a-different-token-123' }), {
      log: LOGGER, bootId: 'boot-c', now: time.now,
    });
    const rotatedServer = await startAuthServer(rotated);
    try {
      assert.equal((await call(rotatedServer.port, 'GET', '/whoami', { headers: { Cookie: cookie } })).status, 401);
    } finally {
      await rotatedServer.close();
    }
  });

  it('never derives hash-mode session secrets from the stored digest', async () => {
    const time = clock();
    const digestConfig = configFor({ CAW_TOKEN: '', CAW_TOKEN_SHA256: sha256Hex(TOKEN) });
    const byToken = await createAuth(configFor(), { log: LOGGER, bootId: 'boot-t', now: time.now });
    const tokenServer = await startAuthServer(byToken);
    const tokenCookie = await loginCookie(tokenServer.port);
    await tokenServer.close();

    const firstDigest = await createAuth(digestConfig, { log: LOGGER, bootId: 'boot-d1', now: time.now });
    const firstServer = await startAuthServer(firstDigest);
    let digestCookie;
    try {
      assert.equal((await call(firstServer.port, 'GET', '/whoami', { headers: { Cookie: tokenCookie } })).status, 401,
        'a cookie signed with the token-derived secret is not accepted in hash mode');
      digestCookie = await loginCookie(firstServer.port);
      assert.equal((await call(firstServer.port, 'GET', '/whoami', { headers: { Cookie: digestCookie } })).status,
        200, 'logging in with the token still works in hash mode');
    } finally {
      await firstServer.close();
    }

    const restarted = await createAuth(digestConfig, { log: LOGGER, bootId: 'boot-d2', now: time.now });
    const restartedServer = await startAuthServer(restarted);
    try {
      assert.equal((await call(restartedServer.port, 'GET', '/whoami', { headers: { Cookie: digestCookie } })).status,
        401, 'hash-mode sessions end with the process, so a stored digest can never mint a valid cookie');
    } finally {
      await restartedServer.close();
    }
  });

  it('persists revocations so a logged-out cookie stays dead after a restart, without storing the cookie', async () => {
    const time = clock();
    const store = memoryStore();
    const first = await createAuth(configFor(), { log: LOGGER, bootId: 'boot-a', now: time.now, stateStore: store });
    const server = await startAuthServer(first);
    const cookie = await loginCookie(server.port);
    const logout = await call(server.port, 'POST', '/api/logout', { headers: { ...ORIGIN, Cookie: cookie } });
    assert.equal(logout.status, 200);
    await server.close();

    const persisted = store.files.get(REVOCATIONS);
    assert.ok(persisted, 'the revocation list is written on logout');
    assert.equal(persisted.includes(valueOf(cookie)), false, 'the cookie value itself must not be stored');
    assert.deepEqual(Object.keys(JSON.parse(persisted).entries), [sha256Hex(valueOf(cookie))]);

    const restarted = await createAuth(configFor(), {
      log: LOGGER, bootId: 'boot-b', now: time.now, stateStore: store,
    });
    const restartedServer = await startAuthServer(restarted);
    try {
      assert.equal((await call(restartedServer.port, 'GET', '/whoami', { headers: { Cookie: cookie } })).status, 401);
    } finally {
      await restartedServer.close();
    }
  });

  it('applies persisted revocations to the matching cookie only, ignoring expired and malformed entries', async () => {
    const time = clock();
    const issuer = await createAuth(configFor(), { log: LOGGER, bootId: BOOT, now: time.now });
    const server = await startAuthServer(issuer);
    const revoked = await loginCookie(server.port);
    const expired = await loginCookie(server.port);
    const live = await loginCookie(server.port);
    await server.close();

    const store = memoryStore();
    store.files.set(REVOCATIONS, JSON.stringify({ entries: {
      [sha256Hex(valueOf(revoked))]: time.now() + 60000,
      [sha256Hex(valueOf(expired))]: time.now() - 1,
      'not-a-digest': time.now() + 60000,
      [sha256Hex(valueOf(live)).toUpperCase()]: time.now() + 60000,
    } }));
    const restored = await createAuth(configFor(), { log: LOGGER, bootId: 'boot-r', now: time.now, stateStore: store });
    const restoredServer = await startAuthServer(restored);
    try {
      const check = (/** @type {string} */ cookie) => call(restoredServer.port, 'GET', '/whoami', {
        headers: { Cookie: cookie },
      });
      assert.equal((await check(revoked)).status, 401);
      assert.equal((await check(expired)).status, 200);
      assert.equal((await check(live)).status, 200);
    } finally {
      await restoredServer.close();
    }
  });

  it('starts normally from a corrupt revocation file', async () => {
    const store = memoryStore();
    store.files.set(REVOCATIONS, '"garbage"');
    const auth = await createAuth(configFor(), { log: LOGGER, bootId: BOOT, now: clock().now, stateStore: store });
    assert.equal(auth.authenticate(/** @type {any} */ ({ headers: {}, socket: {} })), null);
  });

  it('still logs out in memory and reports the failure when the revocation cannot be written', async () => {
    const errors = /** @type {string[]} */ ([]);
    const logger = { ...LOGGER, error: (/** @type {string} */ message) => errors.push(message) };
    const store = { read: async (/** @type {string} */ _name, /** @type {unknown} */ fallback) => fallback,
      write: async () => {
        throw new Error('disk full');
      } };
    const auth = await createAuth(configFor(), { log: logger, bootId: BOOT, now: clock().now, stateStore: store });
    const server = await startAuthServer(auth);
    try {
      const cookie = await loginCookie(server.port);
      const logout = await call(server.port, 'POST', '/api/logout', { headers: { ...ORIGIN, Cookie: cookie } });
      assert.equal(logout.status, 200);
      assert.deepEqual(errors, ['could not persist session revocations']);
      assert.equal((await call(server.port, 'GET', '/whoami', { headers: { Cookie: cookie } })).status, 401);
    } finally {
      await server.close();
    }
  });

  it('finds the session among several cookies and ignores look-alike names', async () => {
    const time = clock();
    const auth = await createAuth(configFor(), { log: LOGGER, bootId: BOOT, now: time.now });
    /** @param {string} cookie */
    const fake = (cookie) => /** @type {any} */ ({ headers: { cookie }, socket: { remoteAddress: '::1' } });
    assert.equal(auth.authenticate(fake('theme=dark')), null);
    assert.equal(auth.authenticate(fake('xcaw_session=v1.1.abc.def')), null);
    assert.equal(auth.authenticate(fake('caw_session=v1.1.abc.def; caw_session=nonsense')), null);
  });

  it('returns the configured profile for an authenticated request and null otherwise', async () => {
    const auth = await createAuth(configFor({ CAW_ACCESS_PROFILE: 'standard' }), { log: LOGGER, bootId: BOOT });
    assert.equal(auth.authenticate(/** @type {any} */ ({ headers: {}, socket: {} })), null);
    const open = await createAuth(configFor({ CAW_REQUIRE_AUTH: '0', CAW_TOKEN: '', CAW_ACCESS_PROFILE: 'read' }), {
      log: LOGGER, bootId: BOOT,
    });
    assert.deepEqual(open.authenticate(/** @type {any} */ ({ headers: {}, socket: {} })), { profile: 'read' });
  });
});

describe('checkOrigin', () => {
  /** @param {Record<string, string>} headers */
  const req = (headers) => /** @type {any} */ ({ headers, socket: { remoteAddress: '127.0.0.1' } });

  it('requires an Origin header in every case', async () => {
    const auth = await createAuth(configFor(), { log: LOGGER, bootId: BOOT });
    assert.throws(() => auth.checkOrigin(req({ host: '127.0.0.1:4180' })),
      (error) => error instanceof AppError && error.status === 403 && error.code === 'ORIGIN_REJECTED');
  });

  it('compares with the configured public origin when one is set', async () => {
    const auth = await createAuth(configFor({ CAW_PUBLIC_ORIGIN: 'https://gw.example' }), {
      log: LOGGER, bootId: BOOT,
    });
    assert.doesNotThrow(() => auth.checkOrigin(req({ origin: 'https://gw.example', host: 'internal:4180' })));
    assert.throws(() => auth.checkOrigin(req({ origin: 'http://internal:4180', host: 'internal:4180' })),
      AppError);
  });

  it('compares with the Host header when no public origin is set', async () => {
    const auth = await createAuth(configFor(), { log: LOGGER, bootId: BOOT });
    assert.doesNotThrow(() => auth.checkOrigin(req({ origin: 'http://127.0.0.1:4180', host: '127.0.0.1:4180' })));
    assert.throws(() => auth.checkOrigin(req({ origin: 'http://127.0.0.1:9999', host: '127.0.0.1:4180' })), AppError);
  });
});

describe('requireProfile', () => {
  /** @type {Auth} */
  let auth;
  before(async () => {
    auth = await createAuth(configFor(), { log: LOGGER, bootId: BOOT });
  });

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
   * @param {{trust?: string, headers?: Record<string, string>}} options
   */
  async function addressFor({ trust = '0', headers = {} }) {
    const auth = await createAuth(configFor({ CAW_TRUST_PROXY: trust }), { log: LOGGER, bootId: BOOT });
    const server = await startAuthServer(auth);
    try {
      const response = await call(server.port, 'GET', '/client', { headers });
      return response.json.address;
    } finally {
      await server.close();
    }
  }

  it('uses the socket address and ignores forwarding headers unless the proxy is trusted', async () => {
    const headers = {
      'X-Forwarded-For': '198.51.100.7', 'X-Real-IP': '198.51.100.8', 'CF-Connecting-IP': '198.51.100.9',
    };
    assert.equal(await addressFor({ headers }), '127.0.0.1');
  });

  it('prefers CF-Connecting-IP, then X-Real-IP, then the last X-Forwarded-For hop', async () => {
    const all = {
      'CF-Connecting-IP': '198.51.100.1', 'X-Real-IP': '198.51.100.2', 'X-Forwarded-For': '203.0.113.5, 198.51.100.9',
    };
    assert.equal(await addressFor({ trust: '1', headers: all }), '198.51.100.1');
    const noCloudflare = { 'X-Real-IP': '198.51.100.2', 'X-Forwarded-For': '203.0.113.5, 198.51.100.9' };
    assert.equal(await addressFor({ trust: '1', headers: noCloudflare }), '198.51.100.2');
    const onlyForwarded = { 'X-Forwarded-For': '203.0.113.5, 198.51.100.9' };
    assert.equal(await addressFor({ trust: '1', headers: onlyForwarded }), '198.51.100.9');
  });

  it('never uses the first X-Forwarded-For hop, and falls back past values that are not IP addresses', async () => {
    assert.equal(await addressFor({ trust: '1', headers: { 'X-Forwarded-For': '198.51.100.7, 10.0.0.2' } }),
      '10.0.0.2');
    const junk = { 'X-Forwarded-For': '198.51.100.7, <script>' };
    assert.equal(await addressFor({ trust: '1', headers: junk }), '127.0.0.1');
    assert.equal(await addressFor({ trust: '1', headers: { 'CF-Connecting-IP': 'nope', 'X-Real-IP': '2001:DB8::1' } }),
      '2001:db8::1');
    assert.equal(await addressFor({ trust: '1', headers: { 'CF-Connecting-IP': '198.51.100.1, 10.0.0.2' } }),
      '127.0.0.1');
  });
});

describe('authentication disabled', () => {
  it('treats every request as the configured profile and clears cookies on logout', async () => {
    const auth = await createAuth(configFor({ CAW_REQUIRE_AUTH: '0', CAW_TOKEN: '', CAW_ACCESS_PROFILE: 'standard' }), {
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
