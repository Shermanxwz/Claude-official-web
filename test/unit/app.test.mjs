// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../../src/app.mjs';
import { createAuth } from '../../src/auth.mjs';
import { loadConfig } from '../../src/config.mjs';
import { AppError } from '../../src/contracts.mjs';
import { EventHub } from '../../src/events.mjs';
import { createLogger } from '../../src/log.mjs';

const TOKEN = 'app-test-token-123';
const BOOT = 'boot-app';
const SESSION = '6f1c2a4e-0000-4a6b-8c9d-0123456789ab';
const OTHER = '6f1c2a4e-1111-4a6b-8c9d-0123456789ab';
const CLIENT_ID = '7a9b3c5d-2222-4e7f-9a0b-0123456789ab';
const NEW_SESSION = '8b0c4d6e-3333-4f80-8b1c-0123456789ab';

/** @type {string} */
let root = '';
/** @type {string} */
let publicDir = '';

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'caw-app-'));
  publicDir = path.join(root, 'public');
  fs.mkdirSync(path.join(publicDir, 'css'), { recursive: true });
  fs.writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><title>Agent Web</title>');
  fs.writeFileSync(path.join(publicDir, 'css', 'app.css'), ':root{--bg:#fff}');
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * @param {string} sessionId
 * @param {Record<string, unknown>} [extra]
 */
function liveInfo(sessionId, extra = {}) {
  return {
    sessionId, cwd: root, state: 'idle', model: null, permissionMode: 'default', effort: null, title: null,
    lockedBy: null, pendingCount: 0, lastActivity: 0, claudeCodeVersion: null, error: null, ...extra,
  };
}

const HOST_METHODS = ['listSessions', 'getSession', 'getTranscript', 'createSession', 'openSession', 'closeSession',
  'sendMessage', 'interrupt', 'cancelQueued', 'updateSettings', 'respond', 'getContextUsage', 'getCapabilities',
  'mcpAction', 'mcpAuth', 'runtimeViews', 'runtimeView', 'getMemory', 'writeMemory', 'exportConversation', 'taskOutput',
  'sideQuestion', 'fileSuggestions', 'recordRuntimeTrust', 'reload', 'rewind', 'fork', 'rename', 'tag', 'deleteSession',
  'stopTask', 'listSubagents', 'getSubagentMessages', 'sessionCwd', 'backgroundTasks', 'setOutputStyle'];

/**
 * Engine host double: records every call and answers with canned values. Tests override `replies` to force errors.
 */
function makeEngineHost() {
  /** @type {Array<{name: string, args: any[]}>} */
  const calls = [];
  /** @type {Record<string, (...args: any[]) => unknown>} */
  const replies = {
    listSessions: () => [],
    getSession: () => ({ info: null, live: null, pending: [], liveEvents: [], seq: 0, init: null }),
    getTranscript: () => ({ messages: [], total: 0, start: 0, hasMore: false }),
    createSession: () => liveInfo(NEW_SESSION),
    openSession: (/** @type {string} */ id) => liveInfo(id),
    closeSession: () => undefined,
    sendMessage: () => ({ accepted: true, duplicate: false }),
    interrupt: () => ({ stillQueued: [], cancelled: [] }),
    cancelQueued: () => ({ cancelled: true }),
    updateSettings: () => ({ live: null, restartRequired: false }),
    respond: () => undefined,
    getContextUsage: () => ({ totalTokens: 0 }),
    getCapabilities: () => ({
      stale: false, commands: [], models: [], agents: [], account: null, mcpServers: [], outputStyle: null,
      availableOutputStyles: [],
    }),
    mcpAction: () => ({ mcpServers: [] }),
    mcpAuth: () => ({ ok: true }),
    runtimeViews: () => ({ views: ['status', 'settings'] }),
    runtimeView: (/** @type {string} */ _id, /** @type {string} */ view) => ({ view, data: {}, fetchedAt: 1 }),
    getMemory: () => ({ files: [], folders: [], autoMemory: null, autoDream: null }),
    writeMemory: () => ({ bytes: 5 }),
    exportConversation: () => ({ text: 'hi', filename: 'conversation.txt' }),
    taskOutput: () => ({ output: 'out', totalBytes: 3, truncated: false }),
    sideQuestion: () => ({ response: 'Yes.', synthetic: false, refusalFallback: null }),
    fileSuggestions: () => null,
    recordRuntimeTrust: () => 'accepted',
    reload: () => ({ ok: true }),
    rewind: () => ({ conversation: { resumeAt: 'u-prev' } }),
    fork: () => ({ sessionId: NEW_SESSION }),
    rename: () => undefined,
    tag: () => undefined,
    deleteSession: () => undefined,
    stopTask: () => undefined,
    listSubagents: () => ['agent-1'],
    getSubagentMessages: () => [],
    sessionCwd: () => root,
    backgroundTasks: () => ({ backgrounded: true }),
    setOutputStyle: (/** @type {string} */ _id, /** @type {string} */ style) => ({
      outputStyle: style,
      availableOutputStyles: ['default', style],
    }),
  };
  /** @type {any} */
  const host = { calls, replies, live: /** @type {unknown[]} */ ([]), allLive: () => host.live };
  for (const name of HOST_METHODS) {
    host[name] = async (/** @type {any[]} */ ...args) => {
      calls.push({ name, args });
      return replies[name](...args);
    };
  }
  return host;
}

function makeWorkspaces() {
  /** @type {Array<{name: string, args: any[]}>} */
  const calls = [];
  const record = (/** @type {string} */ name, /** @type {any[]} */ ...args) => calls.push({ name, args });
  /** @type {Set<string>} */
  const trusted = new Set();
  return {
    calls,
    roots: [root],
    resolveDir: async (/** @type {string} */ p) => {
      record('resolveDir', p);
      if (p.includes('outside')) throw new AppError(422, 'PATH_NOT_ALLOWED', 'Path is outside the workspace roots');
      return p;
    },
    isInsideRoots: async () => true,
    listDirs: async (/** @type {string|null} */ p) => {
      record('listDirs', p);
      return { path: p ?? null, parent: null, entries: [] };
    },
    mkdir: async (/** @type {string} */ parent, /** @type {string} */ name) => {
      record('mkdir', parent, name);
      return { path: path.join(parent, name) };
    },
    search: async (/** @type {string} */ cwd, /** @type {string} */ q, /** @type {number} */ limit) => {
      record('search', cwd, q, limit);
      return { results: [] };
    },
    isTrusted: async (/** @type {string} */ p) => {
      record('isTrusted', p);
      return trusted.has(p);
    },
    setTrusted: async (/** @type {string} */ p, /** @type {boolean} */ value) => {
      record('setTrusted', p, value);
      if (value) trusted.add(p);
      else trusted.delete(p);
      return { path: p, trusted: value };
    },
  };
}

/**
 * Account double: the runtime's sign-in answers, recorded in `calls`.
 */
function makeAccount() {
  /** @type {Array<{name: string, args: any[]}>} */
  const calls = [];
  return {
    calls,
    status: async () => {
      calls.push({ name: 'status', args: [] });
      return { account: null, signInPending: false };
    },
    startLogin: async (/** @type {string} */ method) => {
      // Like the real account service, any method other than the two sign-in methods is a 400.
      if (method !== 'claudeai' && method !== 'console') {
        throw new AppError(400, 'BAD_REQUEST', 'The sign-in method is not valid.');
      }
      calls.push({ name: 'startLogin', args: [method] });
      return { manualUrl: 'https://claude.ai/oauth/code', automaticUrl: null };
    },
    completeLogin: async (/** @type {string} */ code) => {
      calls.push({ name: 'completeLogin', args: [code] });
      return { account: { email: 'dev@example.com' } };
    },
    cancelLogin: async () => {
      calls.push({ name: 'cancelLogin', args: [] });
    },
    close: async () => {},
  };
}

function makeAttachments() {
  /** @type {Array<{name: string, args: any[]}>} */
  const calls = [];
  return {
    calls,
    save: async (/** @type {http.IncomingMessage} */ req, /** @type {any} */ options) => {
      /** @type {Buffer[]} */
      const parts = [];
      for await (const chunk of req) parts.push(chunk);
      calls.push({ name: 'save', args: [options, Buffer.concat(parts).length] });
      return {
        path: path.join(options.cwd, '.caw-uploads', 'batch', options.fileName), name: options.fileName,
        size: Buffer.concat(parts).length, mediaType: options.mediaType, kind: 'file',
      };
    },
    resolveAttachment: async (/** @type {string} */ absPath, /** @type {string} */ cwd) => {
      calls.push({ name: 'resolveAttachment', args: [absPath, cwd] });
      if (absPath.endsWith('.png')) return { kind: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' };
      return { kind: 'file', path: absPath };
    },
    cleanup: async () => ({ removed: 0 }),
  };
}

/**
 * @param {boolean} enabled
 */
function makeTerminal(enabled) {
  /** @type {Array<{url: string|undefined}>} */
  const calls = [];
  return {
    calls,
    enabled,
    disabledReason: enabled ? null : 'CAW_TERMINAL is not 1',
    /**
     * @param {http.IncomingMessage} req
     * @param {net.Socket} socket
     */
    handleUpgrade(req, socket) {
      calls.push({ url: req.url });
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
      socket.destroy();
    },
    closeAll: async () => {},
  };
}

/**
 * @param {{profile?: 'read'|'standard'|'full', allowBypass?: boolean, terminal?: boolean, publicOrigin?: string,
 *   requireAuth?: boolean, backgroundTasksDisabled?: boolean, extraEnv?: Record<string, string>}} [options]
 */
async function startApp({ profile = 'full', allowBypass = false, terminal = false, publicOrigin = '',
  requireAuth = true, backgroundTasksDisabled = false, extraEnv = {} } = {}) {
  /** @type {Record<string, string>} */
  const env = {
    HOME: root,
    CAW_WORKSPACE_ROOTS: root,
    CAW_STATE_DIR: path.join(root, 'state'),
    CAW_ENGINE: 'mock',
    CAW_ACCESS_PROFILE: profile,
    CAW_ALLOW_BYPASS: allowBypass ? '1' : '0',
    CAW_TERMINAL: terminal ? '1' : '0',
  };
  if (requireAuth) env.CAW_TOKEN = TOKEN;
  else env.CAW_REQUIRE_AUTH = '0';
  if (backgroundTasksDisabled) env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
  if (publicOrigin) env.CAW_PUBLIC_ORIGIN = publicOrigin;
  Object.assign(env, extraEnv);
  const config = loadConfig(env, { packageVersion: '1.2.3' });
  /** @type {string[]} */
  const sink = [];
  const log = createLogger({ level: 'debug', stream: { write: (/** @type {string} */ line) => sink.push(line) } });
  const events = new EventHub({ bootId: BOOT, version: config.version, log, heartbeatMs: 60000 });
  const auth = await createAuth(config, { log, bootId: BOOT });
  const engineHost = makeEngineHost();
  const workspaces = makeWorkspaces();
  const attachments = makeAttachments();
  const terminalApi = makeTerminal(terminal);
  const account = makeAccount();
  const app = createApp({
    config, log, engine: { kind: 'mock', sdkVersion: '0.3.295' }, engineHost, events, auth, workspaces, attachments,
    terminal: terminalApi, account, bootId: BOOT, publicDir,
  });
  const server = http.createServer((req, res) => {
    void app.handleRequest(req, res);
  });
  server.on('upgrade', app.handleUpgrade);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    port: address.port,
    origin: publicOrigin || `http://127.0.0.1:${address.port}`,
    config,
    sink,
    events,
    engineHost,
    workspaces,
    attachments,
    terminal: terminalApi,
    account,
    cookie: '',
    /** @returns {Promise<void>} */
    close: () => new Promise((resolve) => {
      events.close();
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

/** @typedef {Awaited<ReturnType<typeof startApp>>} AppContext */

/**
 * Runs `fn` against a fresh gateway and always shuts it down.
 * @param {Parameters<typeof startApp>[0]} options
 * @param {(ctx: AppContext) => Promise<void>} fn
 */
async function withApp(options, fn) {
  const ctx = await startApp(options);
  try {
    await fn(ctx);
  } finally {
    await ctx.close();
  }
}

/**
 * @param {AppContext} ctx
 * @param {string} [token]
 */
async function login(ctx, token = TOKEN) {
  const response = await request(ctx, 'POST', '/api/login', { body: { token }, cookie: false });
  if (response.status === 200) ctx.cookie = String(response.headers['set-cookie']?.[0]).split(';')[0];
  return response;
}

/**
 * @param {AppContext} ctx
 * @param {string} method
 * @param {string} target
 * @param {{body?: unknown, raw?: string|Buffer, headers?: Record<string, string>, cookie?: boolean,
 *   origin?: boolean}} [options]
 * @returns {Promise<{status: number, headers: http.IncomingHttpHeaders, text: string, json: any}>}
 */
function request(ctx, method, target, { body, raw, headers = {}, cookie = true, origin = true } = {}) {
  const payload = raw !== undefined ? raw : (body === undefined ? undefined : JSON.stringify(body));
  /** @type {Record<string, string>} */
  const finalHeaders = {};
  if (body !== undefined && raw === undefined) finalHeaders['Content-Type'] = 'application/json';
  Object.assign(finalHeaders, headers);
  if (origin && method !== 'GET' && method !== 'HEAD' && !('Origin' in finalHeaders)) {
    finalHeaders.Origin = ctx.origin;
  }
  if (cookie && ctx.cookie && !('Cookie' in finalHeaders)) finalHeaders.Cookie = ctx.cookie;
  return new Promise((resolve, reject) => {
    const req = http.request({
      agent: false, host: '127.0.0.1', port: ctx.port, method, path: target, headers: finalHeaders,
    }, (res) => {
      /** @type {Buffer[]} */
      const parts = [];
      res.on('data', (chunk) => parts.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/**
 * Sends a raw request line and reads until the server closes the socket.
 * @param {number} port
 * @param {string} head
 * @returns {Promise<string>}
 */
function rawExchange(port, head) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    /** @type {Buffer[]} */
    const parts = [];
    socket.on('data', (chunk) => parts.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => resolve(Buffer.concat(parts).toString('utf8')));
    socket.write(head);
  });
}

/**
 * Builds a WebSocket upgrade request for the terminal. The Host header is the gateway's own address, as a browser
 * sends it, so the Host fallback of the origin check sees the real server.
 * @param {AppContext} ctx
 * @param {Record<string, string>} [extra]
 * @param {string} [origin]
 */
function upgradeHead(ctx, extra = {}, origin = ctx.origin) {
  const headers = {
    Host: `127.0.0.1:${ctx.port}`,
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
    Origin: origin,
    ...extra,
  };
  return `GET /api/terminal HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`;
}

const SECURITY_HEADER_NAMES = ['content-security-policy', 'x-frame-options', 'x-content-type-options',
  'referrer-policy', 'cross-origin-opener-policy', 'cross-origin-resource-policy', 'permissions-policy'];

/** @param {http.IncomingHttpHeaders} headers */
function assertSecurityHeaders(headers) {
  for (const name of SECURITY_HEADER_NAMES) assert.ok(headers[name], `missing ${name}`);
  assert.equal(headers['cache-control'], 'no-store');
}

describe('gateway basics', () => {
  it('answers /healthz without authentication and with the security headers', async () => {
    await withApp({}, async (ctx) => {
      const response = await request(ctx, 'GET', '/healthz', { cookie: false });
      assert.equal(response.status, 200);
      assert.deepEqual(response.json, { ok: true });
      assertSecurityHeaders(response.headers);
    });
  });

  it('serves the single-page shell and assets, and refuses everything else outside /api', async () => {
    await withApp({}, async (ctx) => {
      const shell = await request(ctx, 'GET', '/', { cookie: false });
      assert.equal(shell.status, 200);
      assert.equal(shell.headers['content-type'], 'text/html; charset=utf-8');
      assert.match(shell.text, /<title>Agent Web<\/title>/);
      assertSecurityHeaders(shell.headers);

      const css = await request(ctx, 'GET', '/css/app.css', { cookie: false });
      assert.equal(css.headers['content-type'], 'text/css; charset=utf-8');

      const missing = await request(ctx, 'GET', '/missing.txt', { cookie: false });
      assert.equal(missing.status, 404);
      assert.equal(missing.headers['content-type'], 'text/plain; charset=utf-8');
      assert.equal(missing.text, 'Not found');

      const posted = await request(ctx, 'POST', '/', { body: {}, cookie: false });
      assert.equal(posted.status, 404);
    });
  });

  it('describes the session without authentication', async () => {
    await withApp({}, async (ctx) => {
      const response = await request(ctx, 'GET', '/api/session', { cookie: false });
      assert.deepEqual(response.json, {
        authenticated: false, authRequired: true, profile: null, appName: 'Agent Web', version: '1.2.3',
        bootId: BOOT,
      });
    });
  });

  it('answers unknown API paths and wrong methods with 404 NOT_FOUND', async () => {
    await withApp({}, async (ctx) => {
      const unknown = await request(ctx, 'GET', '/api/unknown', { cookie: false });
      assert.equal(unknown.status, 404);
      assert.equal(unknown.json.error.code, 'NOT_FOUND');
      const wrongMethod = await request(ctx, 'PUT', '/api/session', { cookie: false, body: {} });
      assert.equal(wrongMethod.status, 404);
      assert.equal(wrongMethod.json.error.code, 'NOT_FOUND');
    });
  });

  it('rejects malformed request targets before routing', async () => {
    await withApp({}, async (ctx) => {
      const response = await request(ctx, 'GET', '//api/session', { cookie: false });
      assert.equal(response.status, 400);
      assert.equal(response.json.error.code, 'BAD_REQUEST');
    });
  });

  it('requires a session cookie for protected routes', async () => {
    await withApp({}, async (ctx) => {
      const response = await request(ctx, 'GET', '/api/sessions', { cookie: false });
      assert.equal(response.status, 401);
      assert.equal(response.json.error.code, 'UNAUTHENTICATED');
      assertSecurityHeaders(response.headers);
    });
  });

  it('logs in with the token, never logs it, and logs out by revoking the cookie', async () => {
    await withApp({}, async (ctx) => {
      const wrong = await login(ctx, 'wrong-token-value-xx');
      assert.equal(wrong.status, 401);
      assert.equal(wrong.json.error.code, 'INVALID_TOKEN');

      const rejectedOrigin = await request(ctx, 'POST', '/api/login', {
        body: { token: TOKEN }, cookie: false, origin: false,
      });
      assert.equal(rejectedOrigin.status, 403);
      assert.equal(rejectedOrigin.json.error.code, 'ORIGIN_REJECTED');

      const accepted = await login(ctx);
      assert.equal(accepted.status, 200);
      assert.deepEqual(accepted.json, { ok: true });
      assert.ok(ctx.cookie.startsWith('caw_session=v1.'));
      assert.equal(ctx.sink.join('').includes(TOKEN), false, 'the token must never reach the log');

      const session = await request(ctx, 'GET', '/api/session', { cookie: true });
      assert.equal(session.json.authenticated, true);
      assert.equal(session.json.profile, 'full');

      const logout = await request(ctx, 'POST', '/api/logout', {});
      assert.equal(logout.status, 200);
      assert.match(String(logout.headers['set-cookie']?.[0]), /Max-Age=0/);
      assert.equal((await request(ctx, 'GET', '/api/meta', {})).status, 401, 'the revoked cookie is refused');
    });
  });

  it('checks the Origin of authenticated writes before the profile', async () => {
    await withApp({ profile: 'read' }, async (ctx) => {
      await login(ctx);
      const crossSite = await request(ctx, 'POST', '/api/sessions', {
        body: { cwd: root }, headers: { Origin: 'http://evil.example' },
      });
      assert.equal(crossSite.status, 403);
      assert.equal(crossSite.json.error.code, 'ORIGIN_REJECTED');
      const noOrigin = await request(ctx, 'POST', '/api/sessions', { body: { cwd: root }, origin: false });
      assert.equal(noOrigin.status, 403);
    });
  });

  it('serves the session event stream only to authenticated clients', async () => {
    await withApp({}, async (ctx) => {
      const response = await request(ctx, 'GET', '/api/events', { cookie: false });
      assert.equal(response.status, 401);
    });
  });
});

describe('access profiles', () => {
  it('read allows queries and logout but rejects every write', async () => {
    await withApp({ profile: 'read' }, async (ctx) => {
      await login(ctx);
      assert.equal((await request(ctx, 'GET', '/api/sessions', {})).status, 200);
      assert.equal((await request(ctx, 'GET', `/api/sessions/${SESSION}`, {})).status, 200);
      const create = await request(ctx, 'POST', '/api/sessions', { body: { cwd: root } });
      assert.equal(create.status, 403);
      assert.equal(create.json.error.code, 'FORBIDDEN');
      assert.equal((await request(ctx, 'PATCH', `/api/sessions/${SESSION}`, { body: { title: 'x' } })).status, 403);
      assert.equal((await request(ctx, 'DELETE', `/api/sessions/${SESSION}`, {})).status, 403);
      assert.equal(ctx.engineHost.calls.some((call) => call.name === 'createSession'), false);
      assert.equal((await request(ctx, 'POST', '/api/logout', {})).status, 200);
    });
  });

  it('standard allows session work but not deletion or the terminal', async () => {
    await withApp({ profile: 'standard', terminal: true }, async (ctx) => {
      await login(ctx);
      assert.equal((await request(ctx, 'POST', '/api/sessions', { body: { cwd: root } })).status, 200);
      const removed = await request(ctx, 'DELETE', `/api/sessions/${SESSION}`, {});
      assert.equal(removed.status, 403);
      assert.equal(removed.json.error.code, 'FORBIDDEN');
      const terminalGet = await request(ctx, 'GET', '/api/terminal', {});
      assert.equal(terminalGet.status, 403);
    });
  });

  it('full allows deletion and reports the profile in meta', async () => {
    await withApp({ profile: 'full' }, async (ctx) => {
      await login(ctx);
      const removed = await request(ctx, 'DELETE', `/api/sessions/${SESSION}`, {});
      assert.deepEqual(removed.json, { ok: true });
      assert.deepEqual(ctx.engineHost.calls.at(-1), { name: 'deleteSession', args: [SESSION] });
      assert.equal((await request(ctx, 'GET', '/api/meta', {})).json.profile, 'full');
    });
  });
});

describe('input validation', () => {
  it('rejects session ids that are not UUIDs with 400', async () => {
    await withApp({}, async (ctx) => {
      await login(ctx);
      for (const target of ['/api/sessions/not-a-uuid', '/api/sessions/%E0%A4%A']) {
        const response = await request(ctx, 'GET', target, {});
        assert.equal(response.status, 400, target);
        assert.equal(response.json.error.code, 'BAD_REQUEST', target);
      }
    });
  });

  it('never routes a dot-segment escape to a session handler', async () => {
    await withApp({}, async (ctx) => {
      await login(ctx);
      // The WHATWG URL parser resolves %2e%2e to a parent segment, so the target becomes /api/ and no route matches.
      const response = await request(ctx, 'GET', '/api/sessions/%2e%2e', {});
      assert.equal(response.status, 404);
      assert.equal(response.json.error.code, 'NOT_FOUND');
      assert.equal(ctx.engineHost.calls.length, 0);
    });
  });

  it('validates message bodies: client id, text, attachments and emptiness', async () => {
    await withApp({}, async (ctx) => {
      await login(ctx);
      const base = `/api/sessions/${SESSION}/messages`;
      const cases = [
        { clientMessageId: 'not-a-uuid', text: 'hi' },
        { clientMessageId: CLIENT_ID },
        { clientMessageId: CLIENT_ID, text: 'x'.repeat(200001) },
        { clientMessageId: CLIENT_ID, text: 'hi', attachments: 'nope' },
        { clientMessageId: CLIENT_ID, text: 'hi', attachments: new Array(21).fill({ path: '/a' }) },
        { clientMessageId: CLIENT_ID, text: 'hi', attachments: [{ path: 7 }] },
        { clientMessageId: CLIENT_ID, text: '   ' },
      ];
      for (const body of cases) {
        const response = await request(ctx, 'POST', base, { body });
        assert.equal(response.status, 400, JSON.stringify(body).slice(0, 80));
      }
      assert.equal(ctx.engineHost.calls.some((call) => call.name === 'sendMessage'), false);
    });
  });

  it('rejects bad bodies: invalid JSON, non-objects, unsupported media types and oversized payloads', async () => {
    await withApp({}, async (ctx) => {
      await login(ctx);
      const target = `/api/sessions/${SESSION}/settings`;
      const jsonHeaders = { 'Content-Type': 'application/json' };
      const invalid = await request(ctx, 'POST', target, { raw: '{"model":', headers: jsonHeaders });
      assert.equal(invalid.status, 400);
      const list = await request(ctx, 'POST', target, { raw: '[1]', headers: jsonHeaders });
      assert.equal(list.status, 400);
      const form = await request(ctx, 'POST', target, { raw: 'a=1', headers: { 'Content-Type': 'text/plain' } });
      assert.equal(form.status, 415);
      const big = await request(ctx, 'POST', target, {
        raw: JSON.stringify({ model: 'x'.repeat(1024 * 1024 + 10) }), headers: { 'Content-Type': 'application/json' },
      });
      assert.equal(big.status, 413);
      assert.equal(big.json.error.code, 'PAYLOAD_TOO_LARGE');
    });
  });

  it('rejects unknown enum values with 422 INVALID_ARGUMENT', async () => {
    await withApp({}, async (ctx) => {
      await login(ctx);
      const sessionPath = `/api/sessions/${SESSION}`;
      const checks = [
        [`${sessionPath}/settings`, { permissionMode: 'nope' }],
        [`${sessionPath}/settings`, { effort: 'extreme' }],
        [`${sessionPath}/rewind`, { userMessageId: 'u1', mode: 'sideways' }],
        [`${sessionPath}/reload`, { what: 'hooks' }],
        [`${sessionPath}/mcp`, { server: 'github', action: 'delete' }],
        ['/api/sessions', { cwd: root, permissionMode: 'yolo' }],
      ];
      for (const [target, body] of checks) {
        const response = await request(ctx, 'POST', target, { body });
        assert.equal(response.status, 422, target);
        assert.equal(response.json.error.code, 'INVALID_ARGUMENT', target);
      }
    });
  });

  it('validates query parameters', async () => {
    await withApp({}, async (ctx) => {
      await login(ctx);
      const bad = [
        '/api/sessions?limit=0',
        '/api/sessions?limit=501',
        '/api/sessions?offset=-1',
        `/api/sessions/${SESSION}/messages?tail=5&before=3`,
        `/api/sessions/${SESSION}/messages?limit=5`,
        `/api/sessions/${SESSION}/messages?tail=0`,
        '/api/events?watch=bad',
        '/api/events?after=-1',
        '/api/fs/search?q=x',
        '/api/fs/search?cwd=/x&limit=500',
        '/api/fs/dirs?path=',
      ];
      for (const target of bad) {
        const response = await request(ctx, 'GET', target, {});
        if (target === '/api/fs/dirs?path=') {
          assert.equal(response.status, 200, 'an empty path lists the roots');
          continue;
        }
        assert.equal(response.status, 400, target);
      }
    });
  });

  it('validates folder names and rewind and fork inputs', async () => {
    await withApp({}, async (ctx) => {
      await login(ctx);
      for (const name of ['..', '.', 'a/b', 'x'.repeat(101), '']) {
        const response = await request(ctx, 'POST', '/api/fs/mkdir', { body: { parent: root, name } });
        assert.ok([400, 422].includes(response.status), `${name.slice(0, 10)} -> ${response.status}`);
      }
      const noChange = await request(ctx, 'PATCH', `/api/sessions/${SESSION}`, { body: {} });
      assert.equal(noChange.status, 400);
      const blankTitle = await request(ctx, 'PATCH', `/api/sessions/${SESSION}`, { body: { title: '  ' } });
      assert.equal(blankTitle.status, 400);
      const missingMode = await request(ctx, 'POST', `/api/sessions/${SESSION}/rewind`, {
        body: { userMessageId: 'u1' },
      });
      assert.equal(missingMode.status, 422);
    });
  });
});

describe('route mapping', () => {
  it('describes the deployment and remembers the Claude Code version once a session reports it', async () => {
    await withApp({ allowBypass: true, terminal: true }, async (ctx) => {
      await login(ctx);
      const first = (await request(ctx, 'GET', '/api/meta', {})).json;
      assert.equal(first.appName, 'Agent Web');
      assert.equal(first.version, '1.2.3');
      assert.equal(first.bootId, BOOT);
      assert.equal(first.engine, 'mock');
      assert.equal(first.sdkVersion, '0.3.295');
      assert.equal(first.claudeCodeVersion, null);
      assert.deepEqual(first.roots, ctx.config.roots);
      assert.deepEqual(first.defaults, { model: null, permissionMode: null, effort: null, fallbackModel: null });
      assert.deepEqual(first.features, {
        terminal: true,
        bypass: true,
        uploads: true,
        backgroundTasks: true,
        accountLogin: true,
        browserTools: false,
        chrome: false,
      });
      assert.deepEqual(first.limits, { uploadMaxBytes: 26214400, imageMaxBytes: 5242880, maxLiveSessions: 4 });

      ctx.engineHost.live = [liveInfo(SESSION, { claudeCodeVersion: '2.1.295' })];
      assert.equal((await request(ctx, 'GET', '/api/meta', {})).json.claudeCodeVersion, '2.1.295');
      ctx.engineHost.live = [liveInfo(OTHER, { claudeCodeVersion: null })];
      assert.equal((await request(ctx, 'GET', '/api/meta', {})).json.claudeCodeVersion, '2.1.295');
    });
  });

  it('lists sessions with default paging and forwards filters', async () => {
    await withApp({}, async (ctx) => {
      await login(ctx);
      assert.deepEqual((await request(ctx, 'GET', '/api/sessions', {})).json, { sessions: [] });
      await request(ctx, 'GET', `/api/sessions?cwd=${encodeURIComponent(root)}&limit=5&offset=10`, {});
      assert.deepEqual(ctx.engineHost.calls.map((call) => call.args[0]), [
        { limit: 100, offset: 0 },
        { cwd: root, limit: 5, offset: 10 },
      ]);
    });
  });

  it('returns session detail, transcript windows, context, capabilities and subagents', async () => {
    await withApp({}, async (ctx) => {
      await login(ctx);
      const detail = await request(ctx, 'GET', `/api/sessions/${SESSION}`, {});
      assert.deepEqual(Object.keys(detail.json).sort(), ['info', 'init', 'live', 'liveEvents', 'pending', 'seq']);
      assert.equal((await request(ctx, 'GET', `/api/sessions/${SESSION}/messages`, {})).json.total, 0);
      await request(ctx, 'GET', `/api/sessions/${SESSION}/messages?before=10&limit=50`, {});
      await request(ctx, 'GET', `/api/sessions/${SESSION}/messages?tail=20`, {});
      assert.deepEqual(ctx.engineHost.calls.filter((call) => call.name === 'getTranscript')
        .map((call) => call.args[1]), [{ tail: 200 }, { before: 10, limit: 50 }, { tail: 20 }]);
      assert.deepEqual((await request(ctx, 'GET', `/api/sessions/${SESSION}/context`, {})).json, { totalTokens: 0 });
      assert.equal((await request(ctx, 'GET', `/api/sessions/${SESSION}/capabilities`, {})).json.stale, false);
      const subagents = await request(ctx, 'GET', `/api/sessions/${SESSION}/subagents`, {});
      assert.deepEqual(subagents.json, { agents: ['agent-1'] });
      assert.deepEqual((await request(ctx, 'GET', `/api/sessions/${SESSION}/subagents/agent-1/messages`, {})).json,
        { messages: [] });
      assert.deepEqual(ctx.engineHost.calls.at(-1), { name: 'getSubagentMessages', args: [SESSION, 'agent-1'] });
    });
  });

  it('creates sessions after resolving the directory and passes only the settings the client sent', async () => {
    await withApp({}, async (ctx) => {
      await login(ctx);
      const created = await request(ctx, 'POST', '/api/sessions', {
        body: { cwd: root, title: 'Refactor', model: 'claude-sonnet-x', effort: 'high' },
      });
      assert.equal(created.status, 200);
      assert.equal(created.json.live.sessionId, NEW_SESSION);
      assert.deepEqual(ctx.workspaces.calls, [{ name: 'resolveDir', args: [root] }]);
      assert.deepEqual(ctx.engineHost.calls, [{
        name: 'createSession', args: [{ cwd: root, title: 'Refactor', model: 'claude-sonnet-x', effort: 'high' }],
      }]);
      await request(ctx, 'POST', '/api/sessions', { body: { cwd: root, model: null } });
      assert.deepEqual(ctx.engineHost.calls[1].args[0], { cwd: root, model: null });
    });
  });

  it('opens, closes, interrupts and updates the live session', async () => {
    await withApp({}, async (ctx) => {
      await login(ctx);
      const opened = await request(ctx, 'POST', `/api/sessions/${SESSION}/open`, { body: { model: 'm1' } });
      assert.equal(opened.json.live.sessionId, SESSION);
      await request(ctx, 'POST', `/api/sessions/${SESSION}/open`);
      assert.deepEqual(ctx.engineHost.calls.map((call) => call.args), [[SESSION, { model: 'm1' }], [SESSION, {}]]);
      assert.deepEqual((await request(ctx, 'POST', `/api/sessions/${SESSION}/close`)).json, { ok: true });
      assert.deepEqual((await request(ctx, 'POST', `/api/sessions/${SESSION}/interrupt`)).json, {
        ok: true, stillQueued: [], cancelled: [],
      });
      const settings = await request(ctx, 'POST', `/api/sessions/${SESSION}/settings`, {
        body: { effort: null, permissionMode: 'plan' },
      });
      assert.equal(settings.status, 200);
      assert.deepEqual(ctx.engineHost.calls.slice(-3), [
        { name: 'closeSession', args: [SESSION] },
        { name: 'interrupt', args: [SESSION, {}] },
        { name: 'updateSettings', args: [SESSION, { effort: null, permissionMode: 'plan' }] },
      ]);
    });
  });

  it('sends messages with image and file attachments resolved against the session directory', async () => {
    await withApp({}, async (ctx) => {
      await login(ctx);
      const image = path.join(root, '.caw-uploads', 'batch', 'shot.png');
      const file = path.join(root, '.caw-uploads', 'batch', 'notes.txt');
      const sent = await request(ctx, 'POST', `/api/sessions/${SESSION}/messages`, {
        body: { clientMessageId: CLIENT_ID, text: 'Look at these', attachments: [{ path: image }, { path: file }] },
      });
      assert.deepEqual(sent.json, { accepted: true, duplicate: false });
      const send = ctx.engineHost.calls.find((call) => call.name === 'sendMessage');
      assert.deepEqual(send.args, [SESSION, {
        clientMessageId: CLIENT_ID,
        text: `Look at these\n\nAttached file: ${file}`,
        images: [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }],
      }]);
      assert.deepEqual(ctx.attachments.calls.filter((call) => call.name === 'resolveAttachment')
        .map((call) => call.args), [[image, root], [file, root]]);

      const imageOnly = await request(ctx, 'POST', `/api/sessions/${SESSION}/messages`, {
        body: { clientMessageId: OTHER, text: '', attachments: [{ path: image }] },
      });
      assert.equal(imageOnly.status, 200);
    });
  });

  it('forwards MCP, reload, rewind, fork, respond and task-stop calls with their arguments', async () => {
    await withApp({}, async (ctx) => {
      await login(ctx);
      const base = `/api/sessions/${SESSION}`;
      assert.deepEqual((await request(ctx, 'POST', `${base}/mcp`, {
        body: { server: 'github', action: 'toggle', enabled: false },
      })).json, { mcpServers: [] });
      const reload = await request(ctx, 'POST', `${base}/reload`, { body: { what: 'plugins' } });
      assert.deepEqual(reload.json, { ok: true });
      assert.deepEqual((await request(ctx, 'POST', `${base}/rewind`, {
        body: { userMessageId: 'u-2', mode: 'both', dryRun: true },
      })).json, { conversation: { resumeAt: 'u-prev' } });
      assert.deepEqual((await request(ctx, 'POST', `${base}/fork`, {
        body: { upToMessageId: 'u-2', title: 'Branch' },
      })).json, { sessionId: NEW_SESSION });
      assert.deepEqual((await request(ctx, 'POST', `${base}/requests/req-1`, {
        body: { decision: 'allow', updatedInput: { a: 1 } },
      })).json, { ok: true });
      assert.deepEqual((await request(ctx, 'POST', `${base}/tasks/task.9:x/stop`)).json, { ok: true });
      assert.deepEqual(ctx.engineHost.calls.map((call) => [call.name, ...call.args]), [
        ['mcpAction', SESSION, 'github', { action: 'toggle', enabled: false }],
        ['reload', SESSION, 'plugins', {}],
        ['rewind', SESSION, { userMessageId: 'u-2', mode: 'both', dryRun: true }],
        ['fork', SESSION, { upToMessageId: 'u-2', title: 'Branch' }],
        ['respond', SESSION, 'req-1', { decision: 'allow', updatedInput: { a: 1 } }],
        ['stopTask', SESSION, 'task.9:x'],
      ]);
    });
  });

  it('renames and tags sessions with only the fields the client sent', async () => {
    await withApp({}, async (ctx) => {
      await login(ctx);
      assert.deepEqual((await request(ctx, 'PATCH', `/api/sessions/${SESSION}`, {
        body: { title: 'Renamed', tag: null },
      })).json, { ok: true });
      assert.deepEqual(ctx.engineHost.calls.map((call) => [call.name, ...call.args]), [
        ['rename', SESSION, 'Renamed'],
        ['tag', SESSION, null],
      ]);
    });
  });

  it('lists directories, searches files and creates folders inside the roots', async () => {
    await withApp({}, async (ctx) => {
      await login(ctx);
      assert.deepEqual((await request(ctx, 'GET', '/api/fs/dirs', {})).json, { path: null, parent: null, entries: [] });
      await request(ctx, 'GET', `/api/fs/dirs?path=${encodeURIComponent(root)}`, {});
      assert.deepEqual((await request(ctx, 'GET', `/api/fs/search?cwd=${encodeURIComponent(root)}&q=app`, {})).json,
        { results: [], source: 'gateway' });
      assert.deepEqual((await request(ctx, 'POST', '/api/fs/mkdir', {
        body: { parent: root, name: 'new-project' },
      })).json, { path: path.join(root, 'new-project') });
      assert.deepEqual(ctx.workspaces.calls.map((call) => [call.name, ...call.args]), [
        ['listDirs', null],
        ['listDirs', root],
        ['resolveDir', root],
        ['search', root, 'app', 50],
        ['mkdir', root, 'new-project'],
      ]);
    });
  });

  it('stores uploads under their decoded names, declared media type and the default type', async () => {
    await withApp({}, async (ctx) => {
      await login(ctx);
      const target = `/api/attachments?cwd=${encodeURIComponent(root)}`;
      const upload = await request(ctx, 'POST', target, {
        raw: Buffer.from('PNGDATA'),
        headers: { 'Content-Type': 'image/png; charset=binary', 'X-File-Name': encodeURIComponent('my shot é.png') },
      });
      assert.equal(upload.status, 200);
      assert.equal(upload.json.mediaType, 'image/png');
      assert.deepEqual(ctx.attachments.calls[0].args, [
        { cwd: root, fileName: 'my shot é.png', mediaType: 'image/png' }, 7,
      ]);
      await request(ctx, 'POST', target, { raw: 'x', headers: { 'X-File-Name': 'notes.txt' } });
      assert.deepEqual(ctx.attachments.calls[1].args[0], {
        cwd: root, fileName: 'notes.txt', mediaType: 'application/octet-stream',
      });
    });
  });

  it('rejects uploads with a missing, undecodable or malformed file name, media type or directory', async () => {
    await withApp({}, async (ctx) => {
      await login(ctx);
      const target = `/api/attachments?cwd=${encodeURIComponent(root)}`;
      const attempts = [
        [target, {}],
        [target, { 'X-File-Name': '%E0%A4%A' }],
        [target, { 'X-File-Name': 'a%2Fb.txt' }],
        [target, { 'X-File-Name': 'ok.txt', 'Content-Type': 'not a type' }],
        ['/api/attachments', { 'X-File-Name': 'ok.txt' }],
      ];
      for (const [url, headers] of attempts) {
        const response = await request(ctx, 'POST', url, { raw: 'x', headers });
        assert.equal(response.status, 400, `${url} ${JSON.stringify(headers)}`);
      }
      assert.equal(ctx.attachments.calls.length, 0);
    });
  });
});

describe('errors, feature gates and modes', () => {
  it('maps module AppErrors to their status and code, and hides unexpected failures', async () => {
    await withApp({}, async (ctx) => {
      await login(ctx);
      ctx.engineHost.replies.getSession = () => {
        throw new AppError(404, 'SESSION_NOT_FOUND', 'Session not found');
      };
      const missing = await request(ctx, 'GET', `/api/sessions/${SESSION}`, {});
      assert.equal(missing.status, 404);
      assert.deepEqual(missing.json, { error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' } });

      ctx.engineHost.replies.getSession = () => {
        throw new Error('/var/lib/secret/state exploded');
      };
      const internal = await request(ctx, 'GET', `/api/sessions/${SESSION}`, {});
      assert.equal(internal.status, 500);
      assert.deepEqual(internal.json, { error: { code: 'INTERNAL', message: 'Internal error' } });
      assert.equal(internal.text.includes('secret'), false);
      assert.ok(ctx.sink.join('').includes('request failed'));
    });
  });

  it('refuses sessions outside the workspace roots before touching the engine', async () => {
    await withApp({}, async (ctx) => {
      await login(ctx);
      const response = await request(ctx, 'POST', '/api/sessions', { body: { cwd: '/outside/project' } });
      assert.equal(response.status, 422);
      assert.equal(response.json.error.code, 'PATH_NOT_ALLOWED');
      assert.equal(ctx.engineHost.calls.length, 0);
    });
  });

  it('refuses bypassPermissions with 501 unless CAW_ALLOW_BYPASS=1', async () => {
    await withApp({ profile: 'full', allowBypass: false }, async (ctx) => {
      await login(ctx);
      const create = await request(ctx, 'POST', '/api/sessions', {
        body: { cwd: root, permissionMode: 'bypassPermissions' },
      });
      assert.equal(create.status, 501);
      assert.equal(create.json.error.code, 'FEATURE_DISABLED');
      const open = await request(ctx, 'POST', `/api/sessions/${SESSION}/open`, {
        body: { permissionMode: 'bypassPermissions' },
      });
      assert.equal(open.status, 501);
      const settings = await request(ctx, 'POST', `/api/sessions/${SESSION}/settings`, {
        body: { permissionMode: 'bypassPermissions' },
      });
      assert.equal(settings.status, 501);
      assert.equal(ctx.engineHost.calls.length, 0);
      assert.equal((await request(ctx, 'GET', '/api/meta', {})).json.features.bypass, false);
    });
  });

  it('refuses bypassPermissions below the full profile even when it is enabled', async () => {
    await withApp({ profile: 'standard', allowBypass: true }, async (ctx) => {
      await login(ctx);
      const response = await request(ctx, 'POST', '/api/sessions', {
        body: { cwd: root, permissionMode: 'bypassPermissions' },
      });
      assert.equal(response.status, 403);
      assert.equal(response.json.error.code, 'FORBIDDEN');
      assert.equal((await request(ctx, 'GET', '/api/meta', {})).json.features.bypass, false);
    });
  });

  it('allows bypassPermissions for the full profile when CAW_ALLOW_BYPASS=1', async () => {
    await withApp({ profile: 'full', allowBypass: true }, async (ctx) => {
      await login(ctx);
      const response = await request(ctx, 'POST', '/api/sessions', {
        body: { cwd: root, permissionMode: 'bypassPermissions' },
      });
      assert.equal(response.status, 200);
      assert.equal(ctx.engineHost.calls[0].args[0].permissionMode, 'bypassPermissions');
      assert.equal((await request(ctx, 'GET', '/api/meta', {})).json.features.bypass, true);
    });
  });

  it('applies security headers, including HSTS and the Secure cookie, for an https public origin', async () => {
    await withApp({ publicOrigin: 'https://gw.example' }, async (ctx) => {
      const responses = [
        await request(ctx, 'GET', '/healthz', { cookie: false }),
        await request(ctx, 'GET', '/api/nope', { cookie: false }),
        await request(ctx, 'GET', '/', { cookie: false }),
        await request(ctx, 'GET', '/api/session', { cookie: false }),
      ];
      for (const response of responses) {
        assertSecurityHeaders(response.headers);
        assert.equal(response.headers['strict-transport-security'], 'max-age=15552000');
      }
      const response = await login(ctx);
      assert.equal(response.status, 200);
      assert.match(String(response.headers['set-cookie']?.[0]), /; Secure/);
    });
  });

  it('works without a session when authentication is disabled, using the configured profile', async () => {
    await withApp({ requireAuth: false, profile: 'standard' }, async (ctx) => {
      const session = await request(ctx, 'GET', '/api/session', { cookie: false });
      assert.deepEqual([session.json.authenticated, session.json.authRequired, session.json.profile],
        [true, false, 'standard']);
      assert.equal((await request(ctx, 'GET', '/api/sessions', { cookie: false })).status, 200);
      const created = await request(ctx, 'POST', '/api/sessions', { body: { cwd: root }, cookie: false });
      assert.equal(created.status, 200);
    });
  });
});

/**
 * Opens an SSE stream and collects its text until closed. `waitFor` resolves once the pattern appears.
 * @param {AppContext} ctx
 * @param {string} target
 * @param {Record<string, string>} [headers]
 */
function openStream(ctx, target, headers = {}) {
  let text = '';
  /** @type {Array<{pattern: RegExp, resolve: () => void}>} */
  const waiters = [];
  const req = http.request({
    agent: false, host: '127.0.0.1', port: ctx.port, method: 'GET', path: target,
    headers: { Cookie: ctx.cookie, ...headers },
  }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      text += chunk;
      for (const waiter of [...waiters]) {
        if (waiter.pattern.test(text)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve();
        }
      }
    });
    res.on('error', () => {});
  });
  req.on('error', () => {});
  req.end();
  return {
    get text() {
      return text;
    },
    /**
     * @param {RegExp} pattern
     * @param {number} [timeoutMs]
     * @returns {Promise<void>}
     */
    waitFor(pattern, timeoutMs = 3000) {
      return new Promise((resolve, reject) => {
        if (pattern.test(text)) {
          resolve();
          return;
        }
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${pattern}`)), timeoutMs);
        waiters.push({
          pattern,
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
        });
      });
    },
    close() {
      req.destroy();
    },
  };
}

describe('event stream endpoint', () => {
  it('replays buffered events after Last-Event-ID and sends them as SSE frames', async () => {
    await withApp({}, async (ctx) => {
      await login(ctx);
      ctx.events.publish({ type: 'notice', data: { level: 'info', code: 'first', message: 'one' } });
      ctx.events.publish({ type: 'notice', data: { level: 'info', code: 'second', message: 'two' } });
      const stream = openStream(ctx, '/api/events', { 'Last-Event-ID': `${BOOT}:1` });
      await stream.waitFor(/"code":"second"[^\n]*\n\n/);
      stream.close();
      assert.ok(stream.text.startsWith(':ok\n\nid: boot-app:2\nevent: hello\n'));
      const frame = 'id: boot-app:2\nevent: notice\ndata: {"level":"info","code":"second","message":"two"}\n\n';
      assert.ok(stream.text.includes(frame));
      assert.equal(stream.text.includes('"code":"first"'), false);
    });
  });

  it('streams session events only to clients watching that session', async () => {
    await withApp({}, async (ctx) => {
      await login(ctx);
      const watching = openStream(ctx, `/api/events?watch=${SESSION}`);
      const other = openStream(ctx, `/api/events?watch=${OTHER}`);
      await watching.waitFor(/event: hello/);
      await other.waitFor(/event: hello/);
      ctx.events.publish({ type: 'sdk', sessionId: SESSION, data: { sessionId: SESSION, msg: { type: 'x', n: 42 } } });
      ctx.events.publish({ type: 'sessions_changed', data: { reason: 'after' } });
      await watching.waitFor(/event: sessions_changed/);
      await other.waitFor(/event: sessions_changed/);
      watching.close();
      other.close();
      assert.match(watching.text, /event: sdk\ndata: .*"n":42/);
      assert.equal(other.text.includes('"n":42'), false);
    });
  });

  it('answers invalid watch and after parameters with 400 and requires a session', async () => {
    await withApp({}, async (ctx) => {
      assert.equal((await request(ctx, 'GET', '/api/events', { cookie: false })).status, 401);
      await login(ctx);
      assert.equal((await request(ctx, 'GET', '/api/events?watch=nope', {})).status, 400);
      assert.equal((await request(ctx, 'GET', '/api/events?after=x', {})).status, 400);
    });
  });
});

describe('host validation', () => {
  it('answers 421 HOST_REJECTED for names that are neither loopback nor the public origin', async () => {
    await withApp({}, async (ctx) => {
      for (const target of ['/healthz', '/api/session', '/', '/api/meta']) {
        const response = await request(ctx, 'GET', target, { cookie: false, headers: { Host: 'evil.example' } });
        assert.equal(response.status, 421, target);
        assert.equal(response.json.error.code, 'HOST_REJECTED', target);
        assertSecurityHeaders(response.headers);
      }
      const loopback = await request(ctx, 'GET', '/healthz', { cookie: false, headers: { Host: 'LOCALHOST:9' } });
      assert.equal(loopback.status, 200);
      const lookalike = await request(ctx, 'GET', '/healthz', { cookie: false, headers: { Host: '127.0.0.1.nip.io' } });
      assert.equal(lookalike.status, 421);
    });
  });

  it('accepts exactly the host[:port] of CAW_PUBLIC_ORIGIN as well as loopback names', async () => {
    await withApp({ publicOrigin: 'https://gw.example:8443' }, async (ctx) => {
      const allowed = await request(ctx, 'GET', '/healthz', { cookie: false, headers: { Host: 'gw.example:8443' } });
      assert.equal(allowed.status, 200);
      const otherPort = await request(ctx, 'GET', '/healthz', { cookie: false, headers: { Host: 'gw.example:9443' } });
      assert.equal(otherPort.status, 421);
      const noPort = await request(ctx, 'GET', '/healthz', { cookie: false, headers: { Host: 'gw.example' } });
      assert.equal(noPort.status, 421);
    });
  });

  it('refuses a WebSocket upgrade with a foreign Host using a bare 421 status line', async () => {
    await withApp({ profile: 'full', terminal: true }, async (ctx) => {
      await login(ctx);
      const reply = await rawExchange(ctx.port, upgradeHead(ctx, { Cookie: ctx.cookie, Host: 'evil.example' }));
      assert.match(reply, /^HTTP\/1\.1 421 Misdirected Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n$/);
      assert.equal(ctx.terminal.calls.length, 0);
    });
  });
});

describe('workspace trust routes', () => {
  it('reports trust to read clients and changes it for standard and above', async () => {
    await withApp({ profile: 'standard' }, async (ctx) => {
      await login(ctx);
      const query = `/api/fs/trust?path=${encodeURIComponent(root)}`;
      assert.deepEqual((await request(ctx, 'GET', query, {})).json, { path: root, trusted: false });
      const trusted = await request(ctx, 'POST', '/api/fs/trust', { body: { path: root, trusted: true } });
      assert.deepEqual(trusted.json, { path: root, trusted: true, runtimeTrust: 'accepted' });
      assert.deepEqual((await request(ctx, 'GET', query, {})).json, { path: root, trusted: true });
      assert.deepEqual(ctx.workspaces.calls.filter((call) => call.name !== 'resolveDir').map((call) => call.name),
        ['isTrusted', 'setTrusted', 'isTrusted']);
    });
  });

  it('lets read clients query trust but not change it', async () => {
    await withApp({ profile: 'read' }, async (ctx) => {
      await login(ctx);
      assert.equal((await request(ctx, 'GET', `/api/fs/trust?path=${encodeURIComponent(root)}`, {})).status, 200);
      const change = await request(ctx, 'POST', '/api/fs/trust', { body: { path: root, trusted: true } });
      assert.equal(change.status, 403);
      assert.equal(change.json.error.code, 'FORBIDDEN');
      assert.equal(ctx.workspaces.calls.some((call) => call.name === 'setTrusted'), false);
    });
  });

  it('validates the path and the trusted flag', async () => {
    await withApp({}, async (ctx) => {
      await login(ctx);
      assert.equal((await request(ctx, 'GET', '/api/fs/trust', {})).status, 400);
      assert.equal((await request(ctx, 'POST', '/api/fs/trust', { body: { path: root } })).status, 400);
      assert.equal((await request(ctx, 'POST', '/api/fs/trust', { body: { path: root, trusted: 'yes' } })).status, 400);
      assert.equal((await request(ctx, 'POST', '/api/fs/trust', { body: { trusted: true } })).status, 400);
      assert.equal(ctx.workspaces.calls.length, 0);
    });
  });
});

describe('event stream limits over HTTP', () => {
  it('answers 429 TOO_MANY_STREAMS as JSON once one client address holds 16 streams', async () => {
    await withApp({}, async (ctx) => {
      await login(ctx);
      const streams = [];
      try {
        for (let index = 0; index < 16; index += 1) {
          const stream = openStream(ctx, '/api/events');
          streams.push(stream);
          await stream.waitFor(/event: hello/);
        }
        const refused = await request(ctx, 'GET', '/api/events', {});
        assert.equal(refused.status, 429);
        assert.equal(refused.json.error.code, 'TOO_MANY_STREAMS');
        assert.match(String(refused.headers['content-type']), /^application\/json/);
      } finally {
        for (const stream of streams) stream.close();
      }
    });
  });

  it('accepts a session page of up to 500 entries', async () => {
    await withApp({}, async (ctx) => {
      await login(ctx);
      assert.equal((await request(ctx, 'GET', '/api/sessions?limit=500', {})).status, 200);
      assert.equal(ctx.engineHost.calls.at(-1)?.args[0].limit, 500);
    });
  });
});

describe('terminal endpoint', () => {
  it('answers plain GET /api/terminal with 400 when the request is not a WebSocket upgrade', async () => {
    await withApp({ profile: 'full', terminal: true }, async (ctx) => {
      await login(ctx);
      const response = await request(ctx, 'GET', '/api/terminal', {});
      assert.equal(response.status, 400);
      assert.equal(response.json.error.code, 'BAD_REQUEST');
    });
  });

  it('upgrades only authenticated, same-origin, full-profile requests when the terminal is enabled', async () => {
    await withApp({ profile: 'full', terminal: true }, async (ctx) => {
      await login(ctx);
      const cookie = ctx.cookie;
      assert.match(await rawExchange(ctx.port, upgradeHead(ctx)),
        /^HTTP\/1\.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n$/);
      assert.match(await rawExchange(ctx.port, upgradeHead(ctx, { Cookie: cookie }, 'http://evil.example')),
        /^HTTP\/1\.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n$/);
      assert.equal(await rawExchange(ctx.port, upgradeHead(ctx, { Cookie: cookie })
        .replace('/api/terminal', '/api/other')), '');
      assert.equal(ctx.terminal.calls.length, 0);
      assert.match(await rawExchange(ctx.port, upgradeHead(ctx, { Cookie: cookie })),
        /^HTTP\/1\.1 101 Switching Protocols/);
      assert.equal(ctx.terminal.calls.length, 1);
    });
  });

  it('refuses the upgrade below the full profile and when the terminal is disabled', async () => {
    await withApp({ profile: 'standard', terminal: true }, async (ctx) => {
      await login(ctx);
      assert.match(await rawExchange(ctx.port, upgradeHead(ctx, { Cookie: ctx.cookie })),
        /^HTTP\/1\.1 403 Forbidden/);
      assert.equal(ctx.terminal.calls.length, 0);
    });
    await withApp({ profile: 'full', terminal: false }, async (ctx) => {
      await login(ctx);
      assert.match(await rawExchange(ctx.port, upgradeHead(ctx, { Cookie: ctx.cookie })),
        /^HTTP\/1\.1 501 Not Implemented/);
      assert.equal(ctx.terminal.calls.length, 0);
    });
  });
});

describe('runtime feature routes', () => {
  it('moves a tool call to the background for the standard profile, validates the id and refuses reads', async () => {
    await withApp({ profile: 'standard' }, async (ctx) => {
      await login(ctx);
      const base = `/api/sessions/${SESSION}/background`;
      assert.deepEqual((await request(ctx, 'POST', base, { body: { toolUseId: 'toolu_mock_1' } })).json,
        { backgrounded: true });
      assert.equal((await request(ctx, 'POST', base, {})).status, 200);
      assert.equal((await request(ctx, 'POST', base, { body: { toolUseId: 'not valid!' } })).status, 400);
      assert.deepEqual(ctx.engineHost.calls.filter((call) => call.name === 'backgroundTasks')
        .map((call) => call.args), [[SESSION, 'toolu_mock_1'], [SESSION, undefined]]);
    });
    await withApp({ profile: 'read' }, async (ctx) => {
      await login(ctx);
      assert.equal((await request(ctx, 'POST', `/api/sessions/${SESSION}/background`, {})).status, 403);
      assert.equal(ctx.engineHost.calls.some((call) => call.name === 'backgroundTasks'), false);
    });
  });

  it('changes the output style through the host and refuses a missing or non-text style', async () => {
    await withApp({ profile: 'standard' }, async (ctx) => {
      await login(ctx);
      const base = `/api/sessions/${SESSION}/output-style`;
      assert.deepEqual((await request(ctx, 'POST', base, { body: { style: 'learning' } })).json,
        { outputStyle: 'learning', availableOutputStyles: ['default', 'learning'] });
      assert.equal((await request(ctx, 'POST', base, { body: {} })).status, 400);
      assert.equal((await request(ctx, 'POST', base, { body: { style: 7 } })).status, 400);
      assert.deepEqual(ctx.engineHost.calls.filter((call) => call.name === 'setOutputStyle')
        .map((call) => call.args), [[SESSION, 'learning']]);
    });
  });

  it('reloads with force only when the client sends it, and validates the target and the flag', async () => {
    await withApp({ profile: 'standard' }, async (ctx) => {
      await login(ctx);
      const base = `/api/sessions/${SESSION}/reload`;
      assert.deepEqual((await request(ctx, 'POST', base, { body: { what: 'plugins', force: true } })).json,
        { ok: true });
      assert.equal((await request(ctx, 'POST', base, { body: { what: 'output-styles' } })).status, 200);
      assert.equal((await request(ctx, 'POST', base, { body: { what: 'hooks' } })).status, 422);
      assert.equal((await request(ctx, 'POST', base, { body: { what: 'plugins', force: 'yes' } })).status, 400);
      assert.deepEqual(ctx.engineHost.calls.filter((call) => call.name === 'reload').map((call) => call.args), [
        [SESSION, 'plugins', { force: true }],
        [SESSION, 'output-styles', {}],
      ]);
    });
  });

  it('takes fastMode as true, false or null in the settings and refuses other values before the host', async () => {
    await withApp({ profile: 'standard' }, async (ctx) => {
      await login(ctx);
      const base = `/api/sessions/${SESSION}/settings`;
      for (const fastMode of [true, false, null]) {
        assert.equal((await request(ctx, 'POST', base, { body: { fastMode } })).status, 200);
      }
      const refused = await request(ctx, 'POST', base, { body: { fastMode: 'on' } });
      assert.equal(refused.status, 422);
      assert.equal(refused.json.error.code, 'INVALID_ARGUMENT');
      assert.deepEqual(ctx.engineHost.calls.filter((call) => call.name === 'updateSettings')
        .map((call) => call.args), [[SESSION, { fastMode: true }], [SESSION, { fastMode: false }],
        [SESSION, { fastMode: null }]]);
    });
  });

  it('reports the background feature as off when the runtime disabled background tasks', async () => {
    await withApp({ backgroundTasksDisabled: true }, async (ctx) => {
      await login(ctx);
      assert.equal((await request(ctx, 'GET', '/api/meta', {})).json.features.backgroundTasks, false);
    });
  });
});

describe('session settings, queued messages and interrupts over HTTP', () => {
  it('forwards the interrupt option, and cancels a queued message by its id', async () => {
    await withApp({}, async (ctx) => {
      await login(ctx);
      const base = `/api/sessions/${SESSION}`;
      assert.deepEqual((await request(ctx, 'POST', `${base}/interrupt`, { body: { cancelQueued: true } })).json, {
        ok: true, stillQueued: [], cancelled: [],
      });
      assert.deepEqual(ctx.engineHost.calls.at(-1), { name: 'interrupt', args: [SESSION, { cancelQueued: true }] });
      assert.equal((await request(ctx, 'POST', `${base}/interrupt`, { body: { cancelQueued: 'yes' } })).status, 400);
      assert.deepEqual((await request(ctx, 'DELETE', `${base}/queued/${CLIENT_ID}`, {})).json, { cancelled: true });
      assert.deepEqual(ctx.engineHost.calls.at(-1), { name: 'cancelQueued', args: [SESSION, CLIENT_ID] });
    });
  });

  it('passes agent, folders, fallback model and browser tools on, and gates browser tools by profile', async () => {
    await withApp({}, async (ctx) => {
      await login(ctx);
      const body = { agent: 'reviewer', additionalDirectories: [root], fallbackModel: null, browserTools: false };
      assert.equal((await request(ctx, 'POST', `/api/sessions/${SESSION}/settings`, { body })).status, 200);
      assert.deepEqual(ctx.engineHost.calls.at(-1), { name: 'updateSettings', args: [SESSION, body] });
      const bad = await request(ctx, 'POST', `/api/sessions/${SESSION}/settings`, { body: { agent: 3 } });
      assert.equal(bad.status, 400);
      assert.equal((await request(ctx, 'POST', `/api/sessions/${SESSION}/settings`, {
        body: { additionalDirectories: 'x' },
      })).status, 400);
    });
    await withApp({ profile: 'standard' }, async (ctx) => {
      await login(ctx);
      const denied = await request(ctx, 'POST', `/api/sessions/${SESSION}/settings`, { body: { browserTools: true } });
      assert.equal(denied.status, 403);
      assert.equal(ctx.engineHost.calls.some((call) => call.name === 'updateSettings'), false);
      assert.equal((await request(ctx, 'POST', `/api/sessions/${SESSION}/settings`, { body: { model: 'm' } })).status,
        200);
    });
  });

  it('reports the browser tools and Claude in Chrome features the operator configured', async () => {
    const extraEnv = {
      CAW_BROWSER_MCP_COMMAND: JSON.stringify(['npx', '-y', '@playwright/mcp@0.0.40']),
      CAW_CHROME: '1',
    };
    await withApp({ extraEnv }, async (ctx) => {
      await login(ctx);
      const meta = (await request(ctx, 'GET', '/api/meta', {})).json;
      assert.equal(meta.features.browserTools, true);
      assert.equal(meta.features.chrome, true);
      assert.equal(meta.features.accountLogin, true);
    });
  });

  it('reads the context usage in the detail the client asked for', async () => {
    await withApp({}, async (ctx) => {
      await login(ctx);
      const base = `/api/sessions/${SESSION}/context`;
      assert.equal((await request(ctx, 'GET', base, {})).status, 200);
      assert.equal(ctx.engineHost.calls.at(-1).args[1], undefined);
      assert.equal((await request(ctx, 'GET', `${base}?detail=full`, {})).status, 200);
      assert.equal(ctx.engineHost.calls.at(-1).args[1], 'full');
      assert.equal((await request(ctx, 'GET', `${base}?detail=huge`, {})).status, 400);
    });
  });

  it('searches conversations on /api/sessions/search, which is not taken for a session id', async () => {
    await withApp({}, async (ctx) => {
      await login(ctx);
      const found = await request(ctx, 'GET', '/api/sessions/search?q=deploy&limit=5', {});
      assert.equal(found.status, 200);
      assert.deepEqual(found.json, { results: [], scanned: 0, truncated: false });
      assert.equal((await request(ctx, 'GET', '/api/sessions/search?q=a', {})).status, 400);
      assert.equal((await request(ctx, 'GET', '/api/sessions/search?q=deploy&limit=51', {})).status, 400);
      assert.equal(ctx.engineHost.calls.some((call) => call.name === 'getSession'), false);
    });
  });

  it('serves the runtime views to the profile that may read each one', async () => {
    await withApp({ profile: 'read' }, async (ctx) => {
      await login(ctx);
      const base = `/api/sessions/${SESSION}/runtime`;
      assert.deepEqual((await request(ctx, 'GET', base, {})).json, { views: ['status', 'settings'] });
      assert.equal((await request(ctx, 'GET', `${base}/permissions`, {})).status, 200);
      assert.equal((await request(ctx, 'GET', `${base}/status`, {})).status, 403);
      assert.equal((await request(ctx, 'GET', `${base}/nope`, {})).status, 404);
    });
    await withApp({}, async (ctx) => {
      await login(ctx);
      const answer = await request(ctx, 'GET', `/api/sessions/${SESSION}/runtime/settings`, {});
      assert.deepEqual(answer.json, { view: 'settings', data: {}, fetchedAt: 1 });
      assert.deepEqual(ctx.engineHost.calls.at(-1), { name: 'runtimeView', args: [SESSION, 'settings'] });
    });
  });

  it('reads memory files and saves one with its path and content checked', async () => {
    await withApp({}, async (ctx) => {
      await login(ctx);
      const base = `/api/sessions/${SESSION}/memory`;
      assert.deepEqual((await request(ctx, 'GET', base, {})).json, {
        files: [], folders: [], autoMemory: null, autoDream: null,
      });
      const target = path.join(root, 'CLAUDE.md');
      assert.deepEqual((await request(ctx, 'PUT', base, { body: { path: target, content: '# Notes' } })).json, {
        ok: true, bytes: 5,
      });
      assert.deepEqual(ctx.engineHost.calls.at(-1), { name: 'writeMemory', args: [SESSION, target, '# Notes'] });
      assert.equal((await request(ctx, 'PUT', base, { body: { path: target, content: 7 } })).status, 400);
      assert.equal((await request(ctx, 'PUT', base, { body: { path: '', content: 'x' } })).status, 400);
    });
  });

  it('answers side questions, exports the conversation and reads task output', async () => {
    await withApp({}, async (ctx) => {
      await login(ctx);
      const base = `/api/sessions/${SESSION}`;
      assert.deepEqual((await request(ctx, 'POST', `${base}/side-question`, { body: { question: 'Why?' } })).json, {
        response: 'Yes.', synthetic: false, refusalFallback: null,
      });
      assert.equal((await request(ctx, 'POST', `${base}/side-question`, { body: { question: 4 } })).status, 400);
      const exportReply = await request(ctx, 'GET', `${base}/export`, {});
      assert.deepEqual(exportReply.json, { text: 'hi', filename: 'conversation.txt' });
      assert.deepEqual((await request(ctx, 'GET', `${base}/tasks/bash.1/output`, {})).json, {
        output: 'out', totalBytes: 3, truncated: false,
      });
      assert.deepEqual(ctx.engineHost.calls.at(-1), { name: 'taskOutput', args: [SESSION, 'bash.1'] });
    });
  });

  it('forwards MCP permission modes and the sign-in actions, and refuses unknown values', async () => {
    await withApp({}, async (ctx) => {
      await login(ctx);
      const base = `/api/sessions/${SESSION}`;
      const mode = await request(ctx, 'POST', `${base}/mcp`, {
        body: { server: 'github', action: 'permission-mode', mode: 'auto' },
      });
      assert.deepEqual(mode.json, { mcpServers: [] });
      assert.deepEqual(ctx.engineHost.calls.at(-1), {
        name: 'mcpAction', args: [SESSION, 'github', { action: 'permission-mode', mode: 'auto' }],
      });
      assert.equal((await request(ctx, 'POST', `${base}/mcp`, {
        body: { server: 'github', action: 'permission-mode', mode: 'plan' },
      })).status, 422);
      assert.deepEqual((await request(ctx, 'POST', `${base}/mcp/auth`, {
        body: { server: 'github', action: 'start' },
      })).json, { ok: true });
      assert.deepEqual(ctx.engineHost.calls.at(-1), {
        name: 'mcpAuth', args: [SESSION, 'github', { action: 'start' }],
      });
      assert.equal((await request(ctx, 'POST', `${base}/mcp/auth`, {
        body: { server: 'github', action: 'open' },
      })).status, 422);
    });
  });

  it('serves the sign-in of Claude Code through the account service, at the full profile only', async () => {
    await withApp({}, async (ctx) => {
      await login(ctx);
      assert.deepEqual((await request(ctx, 'GET', '/api/account', {})).json, { account: null, signInPending: false });
      assert.deepEqual((await request(ctx, 'POST', '/api/account/login', { body: { method: 'claudeai' } })).json, {
        manualUrl: 'https://claude.ai/oauth/code', automaticUrl: null,
      });
      assert.equal((await request(ctx, 'POST', '/api/account/login', { body: { method: 'other' } })).status, 400);
      assert.deepEqual((await request(ctx, 'POST', '/api/account/login/code', { body: { code: 'abc#def' } })).json, {
        account: { email: 'dev@example.com' },
      });
      await request(ctx, 'POST', '/api/account/login/code', { body: { code: 42 } });
      assert.deepEqual((await request(ctx, 'DELETE', '/api/account/login', {})).json, { ok: true });
      assert.deepEqual(ctx.account.calls.map((call) => [call.name, ...call.args]), [
        ['status'],
        ['startLogin', 'claudeai'],
        ['completeLogin', 'abc#def'],
        ['completeLogin', ''],
        ['cancelLogin'],
      ]);
    });
    await withApp({ profile: 'standard' }, async (ctx) => {
      await login(ctx);
      assert.equal((await request(ctx, 'GET', '/api/account', {})).status, 200);
      assert.equal((await request(ctx, 'POST', '/api/account/login', { body: { method: 'claudeai' } })).status, 403);
      assert.equal((await request(ctx, 'DELETE', '/api/account/login', {})).status, 403);
    });
  });

  it('searches folders for the @ picker through the runtime when it answers, and the gateway otherwise', async () => {
    await withApp({}, async (ctx) => {
      await login(ctx);
      const query = `/api/fs/search?cwd=${encodeURIComponent(root)}&q=host&session=${SESSION}`;
      ctx.engineHost.replies.fileSuggestions = () => [{ path: 'src/host.mjs', type: 'file' }];
      assert.deepEqual((await request(ctx, 'GET', query, {})).json, {
        results: [{ path: 'src/host.mjs', type: 'file' }], source: 'runtime',
      });
      assert.deepEqual(ctx.engineHost.calls.at(-1), { name: 'fileSuggestions', args: [SESSION, root, 'host', 50] });
      ctx.engineHost.replies.fileSuggestions = () => null;
      assert.deepEqual((await request(ctx, 'GET', query, {})).json, { results: [], source: 'gateway' });
      const badSession = `/api/fs/search?cwd=${encodeURIComponent(root)}&session=nope`;
      assert.equal((await request(ctx, 'GET', badSession, {})).status, 400);
    });
  });

  it('records the runtime trust of a folder only when it is trusted, and answers skipped otherwise', async () => {
    await withApp({ profile: 'standard' }, async (ctx) => {
      await login(ctx);
      const untrust = await request(ctx, 'POST', '/api/fs/trust', { body: { path: root, trusted: false } });
      assert.deepEqual(untrust.json, { path: root, trusted: false, runtimeTrust: 'skipped' });
      assert.equal(ctx.engineHost.calls.some((call) => call.name === 'recordRuntimeTrust'), false);
      await request(ctx, 'POST', '/api/fs/trust', { body: { path: root, trusted: true } });
      assert.deepEqual(ctx.engineHost.calls.at(-1), { name: 'recordRuntimeTrust', args: [root] });
    });
  });
});
