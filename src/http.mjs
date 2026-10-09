// @ts-check
/**
 * HTTP helpers: JSON responses and bounded JSON bodies, error mapping, static file serving (with the vendored browser
 * libraries) and a small path router with typed parameters.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ACCESS_PROFILES, AppError } from './contracts.mjs';
import { secureHeaders } from './security.mjs';

/** @typedef {import('node:http').IncomingMessage} IncomingMessage */
/** @typedef {import('node:http').ServerResponse} ServerResponse */
/** @typedef {import('./contracts.mjs').Logger} Logger */
/** @typedef {import('./contracts.mjs').AccessProfile} AccessProfile */

const DEFAULT_READ_LIMIT = 1048576;
const JSON_SUBTYPE_RE = /^application\/[a-z0-9.!#$&^_+-]+\+json$/;

/**
 * @param {IncomingMessage} req
 * @returns {string} lower-cased media type without parameters
 */
function mediaTypeOf(req) {
  return String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
}

/**
 * Sends a JSON response. Security headers are applied by default; `headers` overrides them.
 * @param {ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string, string|number>} [headers]
 */
export function sendJson(res, status, body, headers = {}) {
  if (res.writableEnded) return;
  if (res.headersSent) {
    // The status line is already on the wire, so the only honest option is to cut the connection.
    res.destroy();
    return;
  }
  const payload = Buffer.from(JSON.stringify(body) ?? 'null');
  res.writeHead(status, {
    ...secureHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    ...headers,
  });
  res.end(payload);
}

/**
 * Maps an error to the documented `{ error: { code, message } }` body. Only AppError messages reach the client.
 * @param {ServerResponse} res
 * @param {unknown} err
 * @param {Logger} log
 * @param {Record<string, string|number>} [headers]
 */
export function sendError(res, err, log, headers = {}) {
  if (err instanceof AppError) {
    /** @type {Record<string, string|number>} */
    const extra = {};
    if (err.retryAfter !== undefined) extra['Retry-After'] = String(Math.max(1, Math.ceil(err.retryAfter)));
    // A rejected oversized body may still be in flight, so the connection must not be reused.
    if (err.status === 413) extra.Connection = 'close';
    if (err.status >= 500) log.warn('request failed', { status: err.status, code: err.code });
    sendJson(res, err.status, { error: { code: err.code, message: err.message } }, { ...extra, ...headers });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  log.error('request failed', { error: message, stack });
  sendJson(res, 500, { error: { code: 'INTERNAL', message: 'Internal error' } }, headers);
}

/**
 * True when the request declares or may carry a body.
 * @param {IncomingMessage} req
 * @returns {boolean}
 */
function mayHaveBody(req) {
  const length = req.headers['content-length'];
  if (length !== undefined) return Number(length) > 0;
  return req.headers['transfer-encoding'] !== undefined;
}

/**
 * Collects the request body, failing with 413 as soon as it exceeds the limit.
 * @param {IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<Buffer>}
 */
function collectBody(req, limit) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let settled = false;

    // The error listener stays attached: an error emitted after settling must not become an uncaught exception.
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('close', onClose);
    };
    /** @param {Error|null} error @param {Buffer} [value] */
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value ?? Buffer.alloc(0));
    };
    /** @param {Buffer} chunk */
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) {
        // Stop reading; the 413 response carries Connection: close so the rest of the upload is dropped.
        req.pause();
        settle(new AppError(413, 'PAYLOAD_TOO_LARGE', `Request body must be at most ${limit} bytes`));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => settle(null, Buffer.concat(chunks, size));
    const onError = () => settle(new AppError(400, 'BAD_REQUEST', 'Request body could not be read'));
    const onClose = () => settle(new AppError(400, 'BAD_REQUEST', 'Request body was incomplete'));

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
  });
}

/**
 * Reads a JSON object from the request body.
 * - No body → `{}`.
 * - Media type must be application/json or application/*+json (415 otherwise).
 * - Bodies over `limit` bytes → 413.
 * - Invalid JSON, or JSON that is not an object → 400.
 * @param {IncomingMessage} req
 * @param {number} [limit]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readJson(req, limit = DEFAULT_READ_LIMIT) {
  if (!mayHaveBody(req)) return {};
  const type = mediaTypeOf(req);
  if (type !== 'application/json' && !JSON_SUBTYPE_RE.test(type)) {
    throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'JSON requests require application/json or application/*+json');
  }
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    throw new AppError(413, 'PAYLOAD_TOO_LARGE', `Request body must be at most ${limit} bytes`);
  }
  const body = await collectBody(req, limit);
  if (body.length === 0) return {};
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    throw new AppError(400, 'BAD_REQUEST', 'Request body must be valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError(400, 'BAD_REQUEST', 'Request body must be a JSON object');
  }
  return /** @type {Record<string, unknown>} */ (parsed);
}

/**
 * Parses the request target. Only origin-form targets are accepted; scheme-relative, backslash and control-character
 * targets are rejected before any routing or file access happens.
 * @param {IncomingMessage} req
 * @returns {URL}
 * @throws {AppError} 400 BAD_REQUEST
 */
export function parseUrl(req) {
  const target = typeof req.url === 'string' ? req.url : '';
  if (!target.startsWith('/') || target.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(target)) {
    throw new AppError(400, 'BAD_REQUEST', 'Malformed request target');
  }
  return new URL(target, 'http://localhost');
}

/* ----------------------------------------------------------------------------------------------------------------- */
/* Static files                                                                                                      */
/* ----------------------------------------------------------------------------------------------------------------- */

/** Browser libraries served from node_modules: public URL -> [package name, file inside the package]. */
const VENDOR_FILES = new Map([
  ['/vendor/marked.esm.js', ['marked', 'lib/marked.esm.js']],
  ['/vendor/purify.es.mjs', ['dompurify', 'dist/purify.es.mjs']],
  ['/vendor/xterm/xterm.mjs', ['@xterm/xterm', 'lib/xterm.mjs']],
  ['/vendor/xterm/xterm.css', ['@xterm/xterm', 'css/xterm.css']],
  ['/vendor/xterm/addon-fit.mjs', ['@xterm/addon-fit', 'lib/addon-fit.mjs']],
]);

const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.ico', 'image/x-icon'],
  ['.json', 'application/json'],
  ['.map', 'application/json'],
  ['.webmanifest', 'application/manifest+json'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

const requireFromHere = createRequire(import.meta.url);
/** @type {Map<string, string>} */
const packageRoots = new Map();

/**
 * Finds the directory of an installed package. Walks up from the resolved entry point to the package.json whose
 * `name` matches, which also works for packages that do not export ./package.json.
 * @param {string} name
 * @returns {string}
 */
function packageRootOf(name) {
  const cached = packageRoots.get(name);
  if (cached) return cached;
  let dir = path.dirname(requireFromHere.resolve(name));
  for (;;) {
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest)) {
      try {
        if (JSON.parse(fs.readFileSync(manifest, 'utf8')).name === name) {
          packageRoots.set(name, dir);
          return dir;
        }
      } catch {
        // A nested, unreadable manifest is not the package root; keep walking upwards.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`Cannot locate the installed package ${name}`);
    dir = parent;
  }
}

/**
 * Maps a request path to a file that may be served, or null.
 * @param {string} pathname decoded request path
 * @param {string} publicDir
 * @returns {{file: string, root: string}|null}
 */
function staticTarget(pathname, publicDir) {
  if (pathname.includes('\u0000') || pathname.includes('\\')) return null;
  const vendor = VENDOR_FILES.get(pathname);
  if (vendor) {
    const [name, file] = vendor;
    const root = packageRootOf(name);
    return { file: path.join(root, file), root };
  }
  if (pathname === '/') return { file: path.join(publicDir, 'index.html'), root: publicDir };
  if (!pathname.startsWith('/')) return null;
  const segments = pathname.slice(1).split('/');
  if (segments.some((segment) => segment === '' || segment.startsWith('.'))) return null;
  return { file: path.join(publicDir, ...segments), root: publicDir };
}

/**
 * Serves a GET or HEAD request from the public directory or the vendored libraries.
 * Returns false when the request is not a servable file, so the caller can answer 404.
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @param {{publicDir: string, https?: boolean}} options
 * @returns {Promise<boolean>}
 */
export async function serveStatic(req, res, { publicDir, https = false }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let pathname;
  try {
    pathname = decodeURIComponent(parseUrl(req).pathname);
  } catch {
    return false;
  }
  const target = staticTarget(pathname, publicDir);
  if (!target) return false;
  const ext = path.extname(target.file).toLowerCase();
  const contentType = CONTENT_TYPES.get(ext);
  if (!contentType) return false;

  let realRoot;
  let realFile;
  try {
    realRoot = await fs.promises.realpath(target.root);
    realFile = await fs.promises.realpath(target.file);
  } catch {
    return false;
  }
  if (realFile !== realRoot && !realFile.startsWith(realRoot + path.sep)) return false;
  const stat = await fs.promises.stat(realFile);
  if (!stat.isFile()) return false;

  res.writeHead(200, secureHeaders({
    'Content-Type': contentType,
    'Content-Length': stat.size,
    'Cache-Control': ext === '.html' ? 'no-store' : 'no-cache',
  }, { https }));
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  try {
    await pipeline(fs.createReadStream(realFile), res);
  } catch {
    // The client went away mid-transfer; the stream is already closed.
    res.destroy();
  }
  return true;
}

/* ----------------------------------------------------------------------------------------------------------------- */
/* Router                                                                                                            */
/* ----------------------------------------------------------------------------------------------------------------- */

/**
 * @typedef {Object} Route
 * @property {string} method
 * @property {string} pattern
 * @property {string[]} segments
 * @property {Function} handler
 * @property {AccessProfile|undefined} profile
 */

/**
 * Decodes one path parameter.
 * @param {string} raw
 * @returns {string}
 */
function decodeParam(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new AppError(400, 'BAD_REQUEST', 'Malformed path parameter');
  }
}

/**
 * @param {string[]} patternSegments
 * @param {string[]} pathSegments
 * @returns {Record<string, string>|null}
 */
function matchSegments(patternSegments, pathSegments) {
  if (patternSegments.length !== pathSegments.length) return null;
  for (let index = 0; index < patternSegments.length; index += 1) {
    const expected = patternSegments[index];
    const actual = pathSegments[index];
    if (expected.startsWith(':')) {
      if (actual === '') return null;
    } else if (expected !== actual) {
      return null;
    }
  }
  // Decode only after the whole pattern matched: a malformed escape on a non-matching route must stay a 404.
  /** @type {Record<string, string>} */
  const params = {};
  patternSegments.forEach((expected, index) => {
    if (expected.startsWith(':')) params[expected.slice(1)] = decodeParam(pathSegments[index]);
  });
  return params;
}

/**
 * @param {string} pathname
 * @returns {string[]}
 */
function splitPath(pathname) {
  return pathname === '/' ? [] : pathname.slice(1).split('/');
}

/**
 * Creates a router for method + path-pattern routes such as `/api/sessions/:id/requests/:requestId`.
 * Route handlers are registered with an optional access profile that the caller enforces.
 */
export function createRouter() {
  /** @type {Route[]} */
  const routes = [];
  return {
    /**
     * @param {string} method
     * @param {string} pattern
     * @param {Function} handler
     * @param {{profile?: AccessProfile}} [options]
     */
    add(method, pattern, handler, { profile } = {}) {
      const upper = String(method).toUpperCase();
      if (!/^[A-Z]+$/.test(upper)) throw new TypeError(`Invalid HTTP method: ${method}`);
      if (!pattern.startsWith('/')) throw new TypeError(`Route pattern must start with /: ${pattern}`);
      if (profile !== undefined && !ACCESS_PROFILES.includes(profile)) {
        throw new TypeError(`Unknown access profile for ${upper} ${pattern}: ${profile}`);
      }
      if (routes.some((route) => route.method === upper && route.pattern === pattern)) {
        throw new TypeError(`Duplicate route ${upper} ${pattern}`);
      }
      routes.push({ method: upper, pattern, segments: splitPath(pattern), handler, profile });
    },
    /**
     * @param {string} method
     * @param {string} pathname
     * @returns {{route: Route, params: Record<string, string>}|{methodMismatch: true}|null}
     * @throws {AppError} 400 BAD_REQUEST when a matched path parameter is malformed
     */
    match(method, pathname) {
      const upper = String(method).toUpperCase();
      const pathSegments = splitPath(pathname);
      let pathMatched = false;
      for (const route of routes) {
        const params = matchSegments(route.segments, pathSegments);
        if (!params) continue;
        if (route.method === upper) return { route, params };
        pathMatched = true;
      }
      return pathMatched ? { methodMismatch: true } : null;
    },
  };
}
