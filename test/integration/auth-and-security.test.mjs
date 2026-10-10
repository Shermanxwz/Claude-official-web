/**
 * Integration tests: login, cookies, Origin checks, access profiles, security headers, static files and the terminal
 * upgrade gate. Every test talks to a real gateway over HTTP; the engine is the deterministic mock.
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import { describe, it, before, after } from 'node:test';
import { startServer } from '../../src/server.mjs';
import {
  assertError,
  assertSecurityHeaders,
  client,
  createLive,
  isUuid,
  PACKAGE_VERSION,
  runTurn,
  startTestServer,
  TOKEN,
} from './helpers.mjs';

/**
 * Sends a WebSocket upgrade request for the terminal over a raw socket and resolves with the status line.
 * @param {string} url gateway base URL
 * @param {Record<string, string>} headers extra request headers (Cookie, Origin)
 * @returns {Promise<string>} e.g. "HTTP/1.1 501 Not Implemented"
 */
function terminalUpgrade(url, headers = {}) {
  const target = new URL(url);
  const lines = [
    'GET /api/terminal HTTP/1.1',
    `Host: ${target.host}`,
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    '',
    '',
  ];
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(target.port), target.hostname);
    let received = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('the terminal upgrade got no answer'));
    }, 5000);
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      received += chunk;
      if (received.includes('\r\n')) {
        clearTimeout(timer);
        socket.destroy();
        resolve(received.split('\r\n')[0]);
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      if (!received.includes('\r\n')) reject(new Error('the socket closed without a status line'));
    });
    socket.write(lines.join('\r\n'));
  });
}

describe('auth and security', { timeout: 120000 }, () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let server;
  before(async () => {
    server = await startTestServer();
  });
  after(async () => {
    await server.close();
  });

  it('answers /healthz without a session, with the security headers', async () => {
    const res = await client(server.url).get('/healthz');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true });
    assert.match(res.headers['content-type'], /^application\/json/);
    assertSecurityHeaders(res);
  });

  it('reports the signed-out state of GET /api/session before login', async () => {
    const res = await client(server.url).get('/api/session');
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.json).sort(), ['appName', 'authRequired', 'authenticated', 'bootId', 'profile',
      'version']);
    assert.equal(res.json.authenticated, false);
    assert.equal(res.json.authRequired, true);
    assert.equal(res.json.profile, null);
    assert.equal(res.json.appName, 'Agent Web');
    assert.equal(res.json.version, PACKAGE_VERSION);
    assert.ok(isUuid(res.json.bootId));
  });

  it('refuses the wrong login token with 401 INVALID_TOKEN and sets no cookie', async () => {
    const api = client(server.url);
    const res = await api.login('wrong-token-value-000000');
    assertError(res, 401, 'INVALID_TOKEN');
    assert.equal(res.headers['set-cookie'], undefined);
    assert.equal(api.cookie, null);
  });

  it('answers 400 BAD_REQUEST for a login body that is not a JSON object with a string token', async () => {
    const api = client(server.url);
    assertError(await api.post('/api/login', { token: 12345 }), 400, 'BAD_REQUEST');
    assertError(await api.post('/api/login', '{not json', { headers: { 'Content-Type': 'application/json' } }),
      400, 'BAD_REQUEST');
  });

  it('answers 413 for a login body over the 8 KiB limit', async () => {
    assertError(await client(server.url).post('/api/login', { token: 'x'.repeat(9000) }), 413, 'PAYLOAD_TOO_LARGE');
  });

  it('logs in with the token and sets a hardened session cookie', async () => {
    const api = client(server.url);
    const res = await api.login();
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true });
    assert.equal(res.headers['set-cookie'].length, 1);
    const [pair, ...attributes] = res.headers['set-cookie'][0].split('; ');
    assert.match(pair, /^caw_session=v1\.\d{1,16}\.[A-Za-z0-9_-]{16,64}\.[A-Za-z0-9_-]{43}$/);
    assert.ok(attributes.includes('HttpOnly'));
    assert.ok(attributes.includes('SameSite=Strict'));
    assert.ok(attributes.includes('Path=/'));
    assert.ok(attributes.includes('Max-Age=604800'), attributes.join(' | '));
    assert.ok(!attributes.includes('Secure'), 'a plain HTTP gateway must not mark the cookie Secure');
    assert.equal(api.cookie, pair);
  });

  it('reports the signed-in state and the full profile after login', async () => {
    const api = client(server.url);
    await api.login();
    const res = await api.get('/api/session');
    assert.equal(res.json.authenticated, true);
    assert.equal(res.json.profile, 'full');
  });

  it('answers 401 UNAUTHENTICATED for profile routes without a session, public routes excepted', async () => {
    const api = client(server.url);
    assertError(await api.get('/api/meta'), 401, 'UNAUTHENTICATED');
    assertError(await api.get('/api/sessions'), 401, 'UNAUTHENTICATED');
    assertError(await api.get('/api/events'), 401, 'UNAUTHENTICATED');
    assertError(await api.post('/api/sessions', { cwd: server.proj }), 401, 'UNAUTHENTICATED');
  });

  it('refuses forged, tampered and foreign cookies with 401', async () => {
    const api = client(server.url);
    await api.login();
    const genuine = api.cookie;
    const last = genuine.slice(-1) === 'A' ? 'B' : 'A';
    const tampered = `${genuine.slice(0, -1)}${last}`;
    assertError(await api.get('/api/meta', { headers: { Cookie: tampered } }), 401, 'UNAUTHENTICATED');
    assertError(await api.get('/api/meta', { headers: { Cookie: 'caw_session=v1.1.abcdefghijklmnop.forged' } }),
      401, 'UNAUTHENTICATED');
    assertError(await api.get('/api/meta', { headers: { Cookie: 'other=1' } }), 401, 'UNAUTHENTICATED');
  });

  it('lets reads through without an Origin header and refuses writes without one', async () => {
    const api = client(server.url);
    await api.login();
    assert.equal((await api.get('/api/meta', { origin: null })).status, 200);
    assertError(await api.post('/api/sessions', { cwd: server.proj }, { origin: null }), 403, 'ORIGIN_REJECTED');
    assertError(await api.post('/api/login', { token: TOKEN }, { origin: null }), 403, 'ORIGIN_REJECTED');
    assertError(await api.post('/api/logout', undefined, { origin: null }), 403, 'ORIGIN_REJECTED');
  });

  it('refuses writes from a foreign or near-miss Origin with 403 ORIGIN_REJECTED', async () => {
    const api = client(server.url);
    await api.login();
    const port = new URL(server.url).port;
    const refused = [
      'http://evil.example',
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}.evil.example`,
      `http://127.0.0.1:${port}/`,
      `ftp://127.0.0.1:${port}`,
      'null',
    ];
    for (const origin of refused) {
      assertError(await api.post('/api/sessions', { cwd: server.proj }, { origin }), 403, 'ORIGIN_REJECTED');
    }
    // The Origin may name the Host with either scheme, because a TLS terminator in front may change the scheme.
    const secure = await api.post('/api/sessions', { cwd: server.proj }, { origin: `https://127.0.0.1:${port}` });
    assert.equal(secure.status, 200);
    assert.equal(secure.json.live.cwd, server.proj);
  });

  it('logs out: the old cookie stops working and the response clears it', async () => {
    const api = client(server.url);
    await api.login();
    const old = api.cookie;
    const res = await api.post('/api/logout');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true });
    assert.match(res.headers['set-cookie'][0], /^caw_session=; HttpOnly; SameSite=Strict; Path=\/; Max-Age=0$/);
    assert.equal(api.cookie, null);
    assertError(await api.get('/api/meta'), 401, 'UNAUTHENTICATED');
    assertError(await api.get('/api/meta', { headers: { Cookie: old } }), 401, 'UNAUTHENTICATED');
    assert.equal((await api.get('/api/session')).json.authenticated, false);
  });

  it('describes the gateway in GET /api/meta with the documented shape and defaults', async () => {
    // A gateway that has not started a session yet has no Claude Code version to report.
    const fresh = await startTestServer();
    try {
      const api = client(fresh.url);
      await api.login();
      const res = await api.get('/api/meta');
      assert.equal(res.status, 200);
      assert.deepEqual(Object.keys(res.json).sort(), ['appName', 'bootId', 'claudeCodeVersion', 'defaults', 'engine',
        'features', 'limits', 'profile', 'roots', 'sdkVersion', 'version']);
      assert.equal(res.json.appName, 'Agent Web');
      assert.equal(res.json.version, PACKAGE_VERSION);
      assert.equal(res.json.engine, 'mock');
      assert.equal(res.json.sdkVersion, 'mock');
      assert.equal(res.json.claudeCodeVersion, null, 'no session has been started on this gateway yet');
      assert.equal(res.json.profile, 'full');
      assert.deepEqual(res.json.roots, [fresh.root]);
      assert.deepEqual(res.json.defaults, { model: null, permissionMode: null, effort: null, fallbackModel: null });
      assert.deepEqual(res.json.features, { terminal: false, bypass: false, uploads: true, backgroundTasks: true,
        accountLogin: true, browserTools: false, chrome: false });
      assert.deepEqual(res.json.limits, { uploadMaxBytes: 26214400, imageMaxBytes: 5242880, maxLiveSessions: 4 });
      assert.equal(res.json.bootId, (await client(fresh.url).get('/api/session')).json.bootId);
    } finally {
      await fresh.close();
    }
  });

  it('sends the same security headers on HTML, JSON, error and static responses', async () => {
    const api = client(server.url);
    const html = await api.get('/');
    assert.equal(html.status, 200);
    assert.equal(html.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(html.headers['cache-control'], 'no-store');
    assert.match(html.text, /^<!doctype html>/i);
    assertSecurityHeaders(html);
    assertSecurityHeaders(await api.get('/api/session'));
    assertSecurityHeaders(await api.get('/api/meta'));
    const missing = await api.get('/no-such-file.txt');
    assert.equal(missing.status, 404);
    assert.equal(missing.text, 'Not found');
    assertSecurityHeaders(missing);
    const script = await api.get('/js/main.js');
    assert.equal(script.headers['cache-control'], 'no-cache');
    assertSecurityHeaders(script);
  });

  it('serves the app and the vendored libraries with the expected MIME types', async () => {
    const api = client(server.url);
    const cases = [
      ['/js/main.js', 'text/javascript; charset=utf-8'],
      ['/css/app.css', 'text/css; charset=utf-8'],
      ['/favicon.svg', 'image/svg+xml'],
      ['/manifest.webmanifest', 'application/manifest+json'],
      ['/vendor/marked.esm.js', 'text/javascript; charset=utf-8'],
      ['/vendor/purify.es.mjs', 'text/javascript; charset=utf-8'],
      ['/vendor/xterm/xterm.mjs', 'text/javascript; charset=utf-8'],
      ['/vendor/xterm/xterm.css', 'text/css; charset=utf-8'],
      ['/vendor/xterm/addon-fit.mjs', 'text/javascript; charset=utf-8'],
    ];
    for (const [pathname, type] of cases) {
      const res = await api.get(pathname);
      assert.equal(res.status, 200, pathname);
      assert.equal(res.headers['content-type'], type, pathname);
      assert.ok(res.text.length > 0, `${pathname} has a body`);
    }
  });

  it('answers 404 to traversal attempts, even when the target file exists outside public/', async () => {
    const api = client(server.url);
    // Every target below resolves to the repository's package.json or a path outside public/.
    const targets = ['/..%2fpackage.json', '/%2e%2e%2fpackage.json', '/js/..%2F..%2Fpackage.json',
      '/js/..%5c..%5cpackage.json', '/js/%2e%2e/%2e%2e/package.json', '/vendor/../../package.json',
      '/%2e%2e%2fsrc%2fapp.mjs', '/.env', '/%00index.html'];
    for (const pathname of targets) {
      const res = await api.get(pathname);
      assert.equal(res.status, 404, pathname);
      assertSecurityHeaders(res);
    }
  });

  it('rejects malformed request targets with 400 and unknown API routes with 404', async () => {
    const api = client(server.url);
    assertError(await api.get('//package.json'), 400, 'BAD_REQUEST');
    assertError(await api.get('/js\\main.js'), 400, 'BAD_REQUEST');
    assertError(await api.get('/api/no-such-route'), 404, 'NOT_FOUND');
    assertError(await api.del('/api/meta'), 404, 'NOT_FOUND');
  });

  it('refuses the terminal upgrade with 501 while the terminal is disabled', async () => {
    const api = client(server.url);
    await api.login();
    const status = await terminalUpgrade(server.url, { Cookie: api.cookie, Origin: server.origin });
    assert.equal(status, 'HTTP/1.1 501 Not Implemented');
  });

  it('refuses the terminal upgrade without a session with 401 and from a foreign origin with 403', async () => {
    const api = client(server.url);
    await api.login();
    assert.equal(await terminalUpgrade(server.url, { Origin: server.origin }), 'HTTP/1.1 401 Unauthorized');
    assert.equal(await terminalUpgrade(server.url, { Cookie: api.cookie, Origin: 'http://evil.example' }),
      'HTTP/1.1 403 Forbidden');
  });
});

describe('login throttling', { timeout: 60000 }, () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let server;
  before(async () => {
    server = await startTestServer();
  });
  after(async () => {
    await server.close();
  });

  it('answers 429 RATE_LIMITED with Retry-After after ten failed attempts, even for the right token', async () => {
    const api = client(server.url);
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      assertError(await api.login('wrong-token-value-000000'), 401, 'INVALID_TOKEN');
    }
    const limited = await api.login(TOKEN);
    assertError(limited, 429, 'RATE_LIMITED');
    const retryAfter = Number(limited.headers['retry-after']);
    assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 600,
      `Retry-After was ${limited.headers['retry-after']}`);
    assert.equal(api.cookie, null);
    assert.equal((await api.get('/api/session')).status, 200, 'reads stay available while sign-in is throttled');
  });
});

describe('public origin and secure cookies', { timeout: 60000 }, () => {
  const PUBLIC_ORIGIN = 'https://gateway.example.test';
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let server;
  before(async () => {
    server = await startTestServer({ CAW_PUBLIC_ORIGIN: PUBLIC_ORIGIN });
  });
  after(async () => {
    await server.close();
  });

  it('accepts only the configured public origin and marks the cookie Secure', async () => {
    const api = client(server.url);
    const res = await api.login(TOKEN, { origin: PUBLIC_ORIGIN });
    assert.equal(res.status, 200);
    assert.ok(res.headers['set-cookie'][0].split('; ').includes('Secure'));
    assertError(await api.login(TOKEN), 403, 'ORIGIN_REJECTED');
    assertError(await api.post('/api/logout', undefined, { origin: server.origin }), 403, 'ORIGIN_REJECTED');
  });

  it('adds Strict-Transport-Security to responses when the public origin is https', async () => {
    const res = await client(server.url).get('/healthz');
    assert.equal(res.headers['strict-transport-security'], 'max-age=15552000');
  });
});

describe('authentication disabled on loopback', { timeout: 60000 }, () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let server;
  before(async () => {
    server = await startTestServer({ CAW_REQUIRE_AUTH: '0' });
  });
  after(async () => {
    await server.close();
  });

  it('treats every client as signed in, but still checks the Origin of writes', async () => {
    const api = client(server.url);
    const session = await api.get('/api/session');
    assert.equal(session.json.authRequired, false);
    assert.equal(session.json.authenticated, true);
    assert.equal(session.json.profile, 'full');
    assert.equal((await api.get('/api/meta')).status, 200);
    assertError(await api.post('/api/sessions', { cwd: server.proj }, { origin: null }), 403, 'ORIGIN_REJECTED');
  });
});

describe('session cookies across restarts', { timeout: 60000 }, () => {
  it('stay valid after a restart with the same token and stop working when the token changes', async () => {
    const first = await startTestServer();
    const api = client(first.url);
    await api.login();
    const cookie = api.cookie;
    const same = await startServer({ env: first.env, listenHost: '127.0.0.1', listenPort: 0 });
    const rotated = await startServer({
      env: { ...first.env, CAW_TOKEN: 'a-different-token-value-999' },
      listenHost: '127.0.0.1',
      listenPort: 0,
    });
    try {
      assert.equal((await client(same.url).get('/api/meta', { headers: { Cookie: cookie } })).status, 200);
      assertError(await client(rotated.url).get('/api/meta', { headers: { Cookie: cookie } }), 401,
        'UNAUTHENTICATED');
    } finally {
      await rotated.close();
      await same.close();
      await first.close();
    }
  });
});

describe('access profile read', { timeout: 60000 }, () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let server;
  before(async () => {
    server = await startTestServer({ CAW_ACCESS_PROFILE: 'read' });
  });
  after(async () => {
    await server.close();
  });

  it('allows reads, the event stream and logout', async () => {
    const api = client(server.url);
    await api.login();
    assert.equal((await api.get('/api/session')).json.profile, 'read');
    const meta = await api.get('/api/meta');
    assert.equal(meta.status, 200);
    assert.equal(meta.json.profile, 'read');
    assert.equal(meta.json.features.bypass, false);
    assert.equal((await api.get('/api/sessions')).status, 200);
    assert.equal((await api.get('/api/fs/dirs')).status, 200);
    const stream = await api.events({ after: 0 });
    assert.equal((await stream.next((frame) => frame.event === 'hello')).event, 'hello');
    stream.close();
    assert.equal((await api.post('/api/logout')).status, 200);
  });

  it('refuses every write with 403 FORBIDDEN, and checks the Origin before the profile', async () => {
    const api = client(server.url);
    await api.login();
    const sessionId = '00000000-0000-4000-8000-000000000001';
    assertError(await api.post('/api/sessions', { cwd: server.proj }), 403, 'FORBIDDEN');
    assertError(await api.post('/api/fs/mkdir', { parent: server.proj, name: 'docs' }), 403, 'FORBIDDEN');
    assertError(await api.post(`/api/attachments?cwd=${encodeURIComponent(server.proj)}`, Buffer.from('x'),
      { headers: { 'X-File-Name': 'a.txt' } }), 403, 'FORBIDDEN');
    assertError(await api.post(`/api/sessions/${sessionId}/messages`, { clientMessageId: sessionId, text: 'hi' }),
      403, 'FORBIDDEN');
    assertError(await api.post(`/api/sessions/${sessionId}/close`), 403, 'FORBIDDEN');
    assertError(await api.del(`/api/sessions/${sessionId}`), 403, 'FORBIDDEN');
    assertError(await api.patch(`/api/sessions/${sessionId}`, { title: 'x' }), 403, 'FORBIDDEN');
    assertError(await api.post(`/api/sessions/${sessionId}/requests/request-1`, { decision: 'allow' }), 403,
      'FORBIDDEN');
    assertError(await api.post('/api/sessions', { cwd: server.proj }, { origin: null }), 403, 'ORIGIN_REJECTED');
  });
});

describe('access profile standard', { timeout: 60000 }, () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let server;
  before(async () => {
    server = await startTestServer({ CAW_ACCESS_PROFILE: 'standard' });
  });
  after(async () => {
    await server.close();
  });

  it('allows sessions and files but refuses deleting sessions, the terminal and bypass mode', async () => {
    const api = client(server.url);
    await api.login();
    const meta = await api.get('/api/meta');
    assert.equal(meta.json.profile, 'standard');
    assert.equal(meta.json.features.bypass, false);
    const created = await api.post('/api/sessions', { cwd: server.proj });
    assert.equal(created.status, 200);
    const sessionId = created.json.live.sessionId;
    assertError(await api.del(`/api/sessions/${sessionId}`), 403, 'FORBIDDEN');
    assertError(await api.post('/api/sessions', { cwd: server.proj, permissionMode: 'bypassPermissions' }),
      501, 'FEATURE_DISABLED');
    assert.equal(await terminalUpgrade(server.url, { Cookie: api.cookie, Origin: server.origin }),
      'HTTP/1.1 403 Forbidden');
    assert.equal((await api.get(`/api/sessions/${sessionId}`)).status, 200, 'the refused delete left it in place');
  });
});

describe('bypass permissions', { timeout: 60000 }, () => {
  it('answers 501 FEATURE_DISABLED when CAW_ALLOW_BYPASS is off, also for settings', async () => {
    const server = await startTestServer();
    try {
      const api = client(server.url);
      await api.login();
      assertError(await api.post('/api/sessions', { cwd: server.proj, permissionMode: 'bypassPermissions' }),
        501, 'FEATURE_DISABLED');
      const created = await api.post('/api/sessions', { cwd: server.proj });
      assertError(await api.post(`/api/sessions/${created.json.live.sessionId}/settings`,
        { permissionMode: 'bypassPermissions' }), 501, 'FEATURE_DISABLED');
    } finally {
      await server.close();
    }
  });

  it('refuses to start with CAW_ALLOW_BYPASS on under the standard profile, so no route can reach bypass', async () => {
    // A server that starts anyway is closed at once, so a regression fails this test instead of hanging the run.
    const refusal = await startTestServer({ CAW_ACCESS_PROFILE: 'standard', CAW_ALLOW_BYPASS: '1' }).then(
      async (server) => {
        await server.close();
        return 'started';
      },
      (error) => error.message);
    assert.equal(refusal, 'CAW_ALLOW_BYPASS=1 requires CAW_ACCESS_PROFILE=full');
  });

  it('is accepted for the full profile when CAW_ALLOW_BYPASS is on, and advertised in meta', async () => {
    const server = await startTestServer({ CAW_ALLOW_BYPASS: '1' });
    try {
      const api = client(server.url);
      await api.login();
      assert.equal((await api.get('/api/meta')).json.features.bypass, true);
      const created = await api.post('/api/sessions', { cwd: server.proj, permissionMode: 'bypassPermissions' });
      assert.equal(created.status, 200);
      assert.equal(created.json.live.permissionMode, 'bypassPermissions');
    } finally {
      await server.close();
    }
  });
});

describe('configuration handed to startServer', { timeout: 60000 }, () => {
  it('paces the mock engine with CAW_MOCK_DELAY_MS from the env it is given', async () => {
    const base = await startTestServer();
    let running = null;
    try {
      running = await startServer({ env: base.env, listenHost: '127.0.0.1', listenPort: 0 });
      const api = client(running.url);
      await api.login();
      const live = await createLive(api, { cwd: base.proj });
      const events = await api.events({ watch: live.sessionId, after: 0 });
      try {
        const started = Date.now();
        await runTurn(api, events, live.sessionId, 'Hello there');
        const elapsed = Date.now() - started;
        assert.ok(elapsed < 500, `a default answer took ${elapsed} ms although CAW_MOCK_DELAY_MS is 0`);
      } finally {
        events.close();
      }
    } finally {
      if (running) await running.close();
      await base.close();
    }
  });
});
