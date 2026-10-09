// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AppError } from '../../src/contracts.mjs';
import { createRouter, parseUrl, readJson, sendError, sendJson, serveStatic } from '../../src/http.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @type {Array<{level: string, msg: string, fields?: Record<string, unknown>}>} */
let logs = [];
const log = {
  debug: () => {},
  info: () => {},
  warn: (/** @type {string} */ msg, /** @type {Record<string, unknown>} */ fields) => {
    logs.push({ level: 'warn', msg, fields });
  },
  error: (/** @type {string} */ msg, /** @type {Record<string, unknown>} */ fields) => {
    logs.push({ level: 'error', msg, fields });
  },
};

/**
 * Starts a throwaway HTTP server on an ephemeral loopback port.
 * @param {(req: http.IncomingMessage, res: http.ServerResponse) => unknown} handler
 * @returns {Promise<{port: number, close: () => Promise<void>}>}
 */
function startServer(handler) {
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => sendError(res, error, log));
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
 * @param {{method?: string, path?: string, headers?: Record<string, string>, body?: string|Buffer|null,
 *   chunks?: string[]}} [options]
 * @returns {Promise<{status: number, headers: http.IncomingHttpHeaders, body: Buffer}>}
 */
function send(port, { method = 'GET', path: target = '/', headers = {}, body = null, chunks } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ agent: false, host: '127.0.0.1', port, method, path: target, headers }, (res) => {
      /** @type {Buffer[]} */
      const parts = [];
      res.on('data', (chunk) => parts.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts) }));
    });
    req.on('error', reject);
    if (chunks) {
      for (const chunk of chunks) req.write(chunk);
      req.end();
    } else {
      req.end(body ?? undefined);
    }
  });
}

/** @param {Buffer} buffer */
const text = (buffer) => buffer.toString('utf8');

describe('readJson', () => {
  /** @param {number} [limit] */
  async function echoServer(limit) {
    return startServer(async (req, res) => {
      const body = await readJson(req, limit);
      sendJson(res, 200, { body });
    });
  }

  it('returns an empty object when there is no body', async () => {
    const server = await echoServer();
    try {
      const response = await send(server.port, { method: 'POST' });
      assert.equal(response.status, 200);
      assert.deepEqual(JSON.parse(text(response.body)).body, {});
    } finally {
      await server.close();
    }
  });

  it('parses JSON objects for application/json and application/*+json media types', async () => {
    const server = await echoServer();
    try {
      for (const contentType of ['application/json', 'application/json; charset=utf-8',
        'application/vnd.api+json', 'Application/JSON']) {
        const response = await send(server.port, {
          method: 'POST', headers: { 'Content-Type': contentType }, body: '{"a":1}',
        });
        assert.equal(response.status, 200, contentType);
        assert.deepEqual(JSON.parse(text(response.body)).body, { a: 1 }, contentType);
      }
    } finally {
      await server.close();
    }
  });

  it('returns 415 for other media types', async () => {
    const server = await echoServer();
    try {
      for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'application/+json', 'json']) {
        const response = await send(server.port, {
          method: 'POST', headers: { 'Content-Type': contentType }, body: '{}',
        });
        assert.equal(response.status, 415, contentType);
        assert.equal(JSON.parse(text(response.body)).error.code, 'UNSUPPORTED_MEDIA_TYPE');
      }
    } finally {
      await server.close();
    }
  });

  it('returns 400 for invalid JSON and for JSON that is not an object', async () => {
    const server = await echoServer();
    try {
      for (const body of ['{', 'not json', '[1,2]', 'null', '"text"', '42', 'true']) {
        const response = await send(server.port, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
        });
        assert.equal(response.status, 400, body);
        assert.equal(JSON.parse(text(response.body)).error.code, 'BAD_REQUEST', body);
      }
    } finally {
      await server.close();
    }
  });

  it('treats an explicitly empty body as {} even with a JSON media type', async () => {
    const server = await echoServer();
    try {
      const response = await send(server.port, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '0' },
      });
      assert.deepEqual(JSON.parse(text(response.body)).body, {});
    } finally {
      await server.close();
    }
  });

  it('returns 413 when the declared length exceeds the limit, without reading the body', async () => {
    const server = await echoServer(16);
    try {
      const response = await send(server.port, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'x'.repeat(200) }),
      });
      assert.equal(response.status, 413);
      assert.equal(response.headers.connection, 'close');
      assert.equal(JSON.parse(text(response.body)).error.code, 'PAYLOAD_TOO_LARGE');
    } finally {
      await server.close();
    }
  });

  it('returns 413 for chunked bodies that grow beyond the limit while streaming', async () => {
    const server = await echoServer(16);
    try {
      const response = await send(server.port, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
        chunks: ['{"text":"', 'aaaaaaaaaaaaaaaaaaaa', '"}'],
      });
      assert.equal(response.status, 413);
    } finally {
      await server.close();
    }
  });

  it('accepts a body exactly at the limit', async () => {
    const body = JSON.stringify({ k: 'v' });
    const server = await echoServer(body.length);
    try {
      const response = await send(server.port, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
      });
      assert.equal(response.status, 200);
    } finally {
      await server.close();
    }
  });
});

describe('sendJson and sendError', () => {
  it('writes status, JSON body, content length and the security headers', async () => {
    const server = await startServer((req, res) => sendJson(res, 201, { ok: true, n: 1 }));
    try {
      const response = await send(server.port);
      assert.equal(response.status, 201);
      assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
      assert.equal(response.headers['content-length'], String(response.body.length));
      assert.deepEqual(JSON.parse(text(response.body)), { ok: true, n: 1 });
      assert.equal(response.headers['x-frame-options'], 'DENY');
      assert.match(String(response.headers['content-security-policy']), /default-src 'self'/);
    } finally {
      await server.close();
    }
  });

  it('lets callers override headers and tolerates an undefined body', async () => {
    const server = await startServer((req, res) => {
      sendJson(res, 200, undefined, { 'Cache-Control': 'private', 'X-Extra': 'yes' });
    });
    try {
      const response = await send(server.port);
      assert.equal(response.headers['cache-control'], 'private');
      assert.equal(response.headers['x-extra'], 'yes');
      assert.equal(text(response.body), 'null');
    } finally {
      await server.close();
    }
  });

  it('maps AppError to its status, code and message', async () => {
    const server = await startServer((req, res) => {
      sendError(res, new AppError(404, 'SESSION_NOT_FOUND', 'No such session'), log);
    });
    try {
      const response = await send(server.port);
      assert.equal(response.status, 404);
      assert.deepEqual(JSON.parse(text(response.body)), {
        error: { code: 'SESSION_NOT_FOUND', message: 'No such session' },
      });
    } finally {
      await server.close();
    }
  });

  it('sets Retry-After from AppError.retryAfter, rounded up and at least one second', async () => {
    const server = await startServer((req, res) => {
      sendError(res, new AppError(429, 'RATE_LIMITED', 'slow down', { retryAfter: 41.2 }), log);
    });
    try {
      assert.equal((await send(server.port)).headers['retry-after'], '42');
    } finally {
      await server.close();
    }
    const other = await startServer((req, res) => {
      sendError(res, new AppError(429, 'RATE_LIMITED', 'slow down', { retryAfter: 0 }), log);
    });
    try {
      assert.equal((await send(other.port)).headers['retry-after'], '1');
    } finally {
      await other.close();
    }
  });

  it('closes the connection for 413 responses', async () => {
    const server = await startServer((req, res) => {
      sendError(res, new AppError(413, 'PAYLOAD_TOO_LARGE', 'too big'), log);
    });
    try {
      assert.equal((await send(server.port)).headers.connection, 'close');
    } finally {
      await server.close();
    }
  });

  it('answers unexpected errors with a generic 500 and logs the details without leaking them', async () => {
    logs = [];
    const server = await startServer((req, res) => {
      sendError(res, new Error('database path /secret/file exploded'), log);
    });
    try {
      const response = await send(server.port);
      assert.equal(response.status, 500);
      const body = JSON.parse(text(response.body));
      assert.deepEqual(body, { error: { code: 'INTERNAL', message: 'Internal error' } });
      const entry = logs.find((item) => item.msg === 'request failed');
      assert.equal(entry?.level, 'error');
      assert.equal(entry?.fields?.error, 'database path /secret/file exploded');
      assert.equal(typeof entry?.fields?.stack, 'string');
    } finally {
      await server.close();
    }
  });

  it('treats non-Error throwables as internal errors and logs server-side AppErrors as warnings', async () => {
    logs = [];
    const server = await startServer((req, res) => sendError(res, 'plain string failure', log));
    try {
      assert.equal((await send(server.port)).status, 500);
      assert.equal(logs.at(-1)?.fields?.error, 'plain string failure');
    } finally {
      await server.close();
    }
    logs = [];
    const second = await startServer((req, res) => {
      sendError(res, new AppError(502, 'ENGINE_ERROR', 'Claude Code failed'), log);
    });
    try {
      assert.equal((await send(second.port)).status, 502);
      assert.equal(logs.at(-1)?.level, 'warn');
    } finally {
      await second.close();
    }
  });
});

describe('parseUrl', () => {
  it('parses origin-form targets', () => {
    const url = parseUrl(/** @type {any} */ ({ url: '/api/sessions?limit=5' }));
    assert.equal(url.pathname, '/api/sessions');
    assert.equal(url.searchParams.get('limit'), '5');
  });

  it('rejects absolute, scheme-relative, backslash and control-character targets', () => {
    for (const target of ['http://example.com/x', '//evil.example/x', '/a\\b', '/a\u0001b', 'relative', undefined]) {
      assert.throws(() => parseUrl(/** @type {any} */ ({ url: target })),
        (error) => error instanceof AppError && error.status === 400, String(target));
    }
  });
});

describe('createRouter', () => {
  const handler = () => 'ok';

  it('matches parameterized patterns and decodes parameters', () => {
    const router = createRouter();
    router.add('POST', '/api/sessions/:id/requests/:requestId', handler, { profile: 'standard' });
    const matched = router.match('POST', '/api/sessions/abc/requests/req%201%2Fx');
    assert.ok(matched && 'route' in matched);
    assert.deepEqual(matched.params, { id: 'abc', requestId: 'req 1/x' });
    assert.equal(matched.route.profile, 'standard');
    assert.equal(matched.route.method, 'POST');
  });

  it('matches literal routes exactly and returns null for unknown paths', () => {
    const router = createRouter();
    router.add('GET', '/api/meta', handler, { profile: 'read' });
    assert.ok(router.match('GET', '/api/meta'));
    assert.equal(router.match('GET', '/api/meta/'), null);
    assert.equal(router.match('GET', '/api'), null);
    assert.equal(router.match('GET', '/api/metadata'), null);
  });

  it('reports method mismatches for known paths', () => {
    const router = createRouter();
    router.add('GET', '/api/meta', handler);
    assert.deepEqual(router.match('POST', '/api/meta'), { methodMismatch: true });
    assert.deepEqual(router.match('HEAD', '/api/meta'), { methodMismatch: true });
  });

  it('does not match empty parameter segments', () => {
    const router = createRouter();
    router.add('GET', '/api/sessions/:id', handler);
    assert.equal(router.match('GET', '/api/sessions/'), null);
  });

  it('answers 400 for malformed escapes only on routes that actually match', () => {
    const router = createRouter();
    router.add('GET', '/api/sessions/:id', handler);
    router.add('GET', '/api/a/:id/b', handler);
    assert.throws(() => router.match('GET', '/api/sessions/%E0%A4%A'),
      (error) => error instanceof AppError && error.status === 400);
    assert.equal(router.match('GET', '/api/a/%E0%A4%A/c'), null);
  });

  it('validates registrations', () => {
    const router = createRouter();
    router.add('get', '/api/x', handler);
    assert.ok(router.match('GET', '/api/x'));
    assert.throws(() => router.add('GET', '/api/x', handler), TypeError);
    assert.throws(() => router.add('G T', '/api/y', handler), TypeError);
    assert.throws(() => router.add('GET', 'api/y', handler), TypeError);
    assert.throws(() => router.add('GET', '/api/y', handler, { profile: /** @type {any} */ ('admin') }), TypeError);
  });
});

describe('serveStatic', () => {
  /** @type {string} */
  let root = '';
  /** @type {string} */
  let publicDir = '';

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'caw-static-'));
    publicDir = path.join(root, 'public');
    fs.mkdirSync(path.join(publicDir, 'css'), { recursive: true });
    fs.mkdirSync(path.join(publicDir, 'js'));
    fs.mkdirSync(path.join(publicDir, 'img', 'icons'), { recursive: true });
    fs.mkdirSync(path.join(publicDir, 'nested'));
    fs.writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><title>app</title>');
    fs.writeFileSync(path.join(publicDir, 'css', 'app.css'), 'body{color:#111}');
    fs.writeFileSync(path.join(publicDir, 'js', 'main.js'), 'export const ok = true;');
    fs.writeFileSync(path.join(publicDir, 'img', 'icons', 'send.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    fs.writeFileSync(path.join(publicDir, 'data.bin'), 'binary');
    fs.writeFileSync(path.join(publicDir, '.secret'), 'hidden');
    fs.writeFileSync(path.join(root, 'outside.txt'), 'outside the public directory');
    fs.symlinkSync(path.join(root, 'outside.txt'), path.join(publicDir, 'escape.txt'));
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** @param {{https?: boolean}} [options] */
  function staticServer({ https = false } = {}) {
    return startServer(async (req, res) => {
      if (!(await serveStatic(req, res, { publicDir, https }))) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
      }
    });
  }

  it('serves index.html for the root and for /index.html without caching', async () => {
    const server = await staticServer();
    try {
      for (const target of ['/', '/index.html']) {
        const response = await send(server.port, { path: target });
        assert.equal(response.status, 200, target);
        assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
        assert.equal(response.headers['cache-control'], 'no-store');
        assert.match(text(response.body), /<!doctype html>/);
      }
    } finally {
      await server.close();
    }
  });

  it('serves assets with their content types and a no-cache policy', async () => {
    const server = await staticServer();
    try {
      const css = await send(server.port, { path: '/css/app.css?v=1' });
      assert.equal(css.status, 200);
      assert.equal(css.headers['content-type'], 'text/css; charset=utf-8');
      assert.equal(css.headers['cache-control'], 'no-cache');
      assert.equal(text(css.body), 'body{color:#111}');

      const js = await send(server.port, { path: '/js/main.js' });
      assert.equal(js.headers['content-type'], 'text/javascript; charset=utf-8');

      const svg = await send(server.port, { path: '/img/icons/send.svg' });
      assert.equal(svg.headers['content-type'], 'image/svg+xml');
    } finally {
      await server.close();
    }
  });

  it('answers HEAD with headers only', async () => {
    const server = await staticServer();
    try {
      const response = await send(server.port, { method: 'HEAD', path: '/css/app.css' });
      assert.equal(response.status, 200);
      assert.equal(response.headers['content-length'], String(Buffer.byteLength('body{color:#111}')));
      assert.equal(response.body.length, 0);
    } finally {
      await server.close();
    }
  });

  it('adds HSTS only for https deployments', async () => {
    const plain = await staticServer();
    const secure = await staticServer({ https: true });
    try {
      assert.equal((await send(plain.port, { path: '/' })).headers['strict-transport-security'], undefined);
      assert.equal((await send(secure.port, { path: '/' })).headers['strict-transport-security'],
        'max-age=15552000');
    } finally {
      await plain.close();
      await secure.close();
    }
  });

  it('refuses non-GET methods, traversal, hidden and symlinked files, and unknown types', async () => {
    const server = await staticServer();
    try {
      const refused = [
        ['POST', '/css/app.css'],
        ['GET', '/%2e%2e/outside.txt'],
        ['GET', '/..%2foutside.txt'],
        ['GET', '/css/%2e%2e%2f%2e%2e%2foutside.txt'],
        ['GET', '/%5c..%5coutside.txt'],
        ['GET', '/.secret'],
        ['GET', '/css/.hidden'],
        ['GET', '/css/'],
        ['GET', '/nested'],
        ['GET', '/data.bin'],
        ['GET', '/escape.txt'],
        ['GET', '/%00'],
        ['GET', '/%E0%A4%A'],
        ['GET', '/vendor/unknown.js'],
        ['GET', '/missing.css'],
      ];
      for (const [method, target] of refused) {
        const response = await send(server.port, { method, path: target });
        assert.equal(response.status, 404, `${method} ${target}`);
        assert.equal(text(response.body), 'not found', `${method} ${target}`);
      }
    } finally {
      await server.close();
    }
  });

  it('serves the vendored browser libraries from node_modules with the right types', async () => {
    const server = await staticServer();
    const vendored = [
      ['/vendor/marked.esm.js', 'marked/lib/marked.esm.js', 'text/javascript; charset=utf-8'],
      ['/vendor/purify.es.mjs', 'dompurify/dist/purify.es.mjs', 'text/javascript; charset=utf-8'],
      ['/vendor/xterm/xterm.mjs', '@xterm/xterm/lib/xterm.mjs', 'text/javascript; charset=utf-8'],
      ['/vendor/xterm/xterm.css', '@xterm/xterm/css/xterm.css', 'text/css; charset=utf-8'],
      ['/vendor/xterm/addon-fit.mjs', '@xterm/addon-fit/lib/addon-fit.mjs', 'text/javascript; charset=utf-8'],
    ];
    try {
      for (const [target, file, contentType] of vendored) {
        const response = await send(server.port, { path: target });
        assert.equal(response.status, 200, target);
        assert.equal(response.headers['content-type'], contentType, target);
        const expected = fs.readFileSync(path.join(REPO, 'node_modules', file));
        assert.ok(response.body.equals(expected), `${target} body matches ${file}`);
      }
    } finally {
      await server.close();
    }
  });
});
