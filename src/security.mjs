// @ts-check
/**
 * Security primitives shared by the HTTP layer and auth: response headers, exact origins, constant-time comparison,
 * HMAC-signed session tokens and sliding-window counters. No I/O.
 */

import crypto from 'node:crypto';

/** @typedef {import('node:http').IncomingMessage} IncomingMessage */

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "font-src 'self' data:",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

const SESSION_TOKEN_VERSION = 'v1';
const SESSION_TOKEN_MAX_LENGTH = 512;
const SESSION_RANDOM_RE = /^[A-Za-z0-9_-]{16,64}$/;
const SESSION_SIGNATURE_RE = /^[A-Za-z0-9_-]{43}$/;
const ISSUED_AT_RE = /^\d{1,16}$/;
const DEFAULT_MAX_REVOKED = 10000;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const LOOPBACK_HOST_RE = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?$/;

/**
 * Security headers applied to every response. Caller-supplied headers override the defaults.
 * @param {Record<string, string|number>} [extra]
 * @param {{https?: boolean}} [options] `https: true` adds Strict-Transport-Security
 * @returns {Record<string, string|number>}
 */
export function secureHeaders(extra = {}, { https = false } = {}) {
  return {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    ...(https ? { 'Strict-Transport-Security': 'max-age=15552000' } : {}),
    ...extra,
  };
}

/**
 * Returns the origin when `value` is already in the exact form a browser sends in the Origin header
 * (scheme://host[:port], lowercase host, no default port, no trailing slash). Returns '' otherwise.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalExactOrigin(value) {
  const text = String(value || '');
  if (!text) return '';
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return '';
  }
  const hasPath = parsed.pathname !== '/';
  const hasExtras = Boolean(parsed.search || parsed.hash || parsed.username || parsed.password);
  if (!['http:', 'https:'].includes(parsed.protocol) || hasPath || hasExtras) return '';
  // URL.origin removes a trailing slash and normalizes host casing and default ports. Non-canonical spellings are
  // rejected instead of normalized, because a setting that never matches the browser's Origin would silently
  // disable the origin check or omit the Secure cookie attribute.
  return text === parsed.origin ? parsed.origin : '';
}

/**
 * Checks the request's Origin header against the exact public origin, or against the Host header when no public
 * origin is configured.
 * @param {IncomingMessage} req
 * @param {string} [publicOrigin]
 * @returns {boolean}
 */
export function sameOrigin(req, publicOrigin = '') {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin === '') return false;
  if (publicOrigin) return origin === publicOrigin;
  const host = req.headers.host;
  if (typeof host !== 'string' || host === '') return false;
  const lowered = origin.toLowerCase();
  const expectedHost = host.toLowerCase();
  return lowered === `http://${expectedHost}` || lowered === `https://${expectedHost}`;
}

/**
 * Constant-time string comparison. Unequal lengths compare as unequal.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function safeEqualText(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * @param {number} [bytes]
 * @returns {string} base64url random token
 */
export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/**
 * @param {string} text
 * @returns {string} lowercase hex SHA-256 of the UTF-8 bytes of `text`
 */
export function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * @param {unknown} host
 * @returns {boolean} true for 127.0.0.1, ::1 and localhost
 */
export function isLoopbackHost(host) {
  const value = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  return value === '127.0.0.1' || value === '::1' || value === 'localhost';
}

/**
 * @param {string} origin
 * @returns {string} lowercase host[:port] of an origin, or '' when it does not parse
 */
function hostOfOrigin(origin) {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Decides whether a Host header may reach the gateway (DNS-rebinding protection). Loopback names are accepted on any
 * port; any other name must equal the host[:port] of the configured public origin exactly.
 * @param {unknown} hostHeader the raw Host header
 * @param {string} [publicOrigin] canonical public origin or ''
 * @returns {boolean}
 */
export function isAllowedHost(hostHeader, publicOrigin = '') {
  if (typeof hostHeader !== 'string' || hostHeader === '') return false;
  const host = hostHeader.toLowerCase();
  if (publicOrigin && host === hostOfOrigin(publicOrigin)) return true;
  const match = LOOPBACK_HOST_RE.exec(host);
  if (!match) return false;
  if (match[1] === undefined) return true;
  const port = Number(match[1]);
  return port >= 1 && port <= 65535;
}

/**
 * Issues and verifies HMAC-SHA256 signed session tokens of the form `v1.<issuedAt>.<random>.<signature>`.
 * Tokens are stateless: they survive a restart as long as the signing secret is unchanged. Revocations are keyed by
 * the SHA-256 of the cookie value, bounded by `maxRevoked` and forgotten once the token would have expired anyway.
 * The owner persists them with `revocations()` and loads them again with `restore()`.
 */
export class SessionStore {
  /** @type {Buffer} */
  #secret;
  /** @type {number} */
  #ttlMs;
  /** @type {() => number} */
  #now;
  /** @type {number} */
  #maxRevoked;
  /** @type {Map<string, number>} sha256(token) -> expiry timestamp (ms) */
  #revoked = new Map();

  /**
   * @param {{secret: string|Buffer, ttlMs: number, now?: () => number, maxRevoked?: number}} options
   */
  constructor({ secret, ttlMs, now = Date.now, maxRevoked = DEFAULT_MAX_REVOKED }) {
    const key = Buffer.from(secret);
    if (key.length === 0) throw new TypeError('SessionStore requires a non-empty secret');
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new TypeError('SessionStore ttlMs must be a positive integer');
    }
    this.#secret = key;
    this.#ttlMs = ttlMs;
    this.#now = now;
    this.#maxRevoked = maxRevoked;
  }

  /**
   * @param {string} payload
   * @returns {string}
   */
  #sign(payload) {
    return crypto.createHmac('sha256', this.#secret).update(payload).digest('base64url');
  }

  /**
   * Checks the format and the signature of a token.
   * @param {unknown} token
   * @returns {number|null} issuedAt when the signature is valid
   */
  #verify(token) {
    if (typeof token !== 'string' || token.length === 0 || token.length > SESSION_TOKEN_MAX_LENGTH) return null;
    const parts = token.split('.');
    if (parts.length !== 4 || parts[0] !== SESSION_TOKEN_VERSION) return null;
    const [, issued, random, signature] = parts;
    if (!ISSUED_AT_RE.test(issued) || !SESSION_RANDOM_RE.test(random) || !SESSION_SIGNATURE_RE.test(signature)) {
      return null;
    }
    const issuedAt = Number(issued);
    if (!Number.isSafeInteger(issuedAt)) return null;
    const expected = this.#sign(`${SESSION_TOKEN_VERSION}.${issued}.${random}`);
    return safeEqualText(expected, signature) ? issuedAt : null;
  }

  /** @returns {string} a new signed token issued now */
  create() {
    const issuedAt = Math.floor(this.#now());
    const payload = `${SESSION_TOKEN_VERSION}.${issuedAt}.${randomToken(18)}`;
    return `${payload}.${this.#sign(payload)}`;
  }

  /**
   * @param {unknown} token
   * @returns {boolean} true when the token is correctly signed, unexpired and not revoked
   */
  has(token) {
    const issuedAt = this.#verify(token);
    if (issuedAt === null) return false;
    const now = this.#now();
    if (issuedAt > now || issuedAt + this.#ttlMs <= now) return false;
    return !this.#revoked.has(sha256Hex(/** @type {string} */ (token)));
  }

  /**
   * Revokes a token until it would have expired. Tokens that are not correctly signed are ignored. When the list is
   * full, the revocation that expires first is dropped to make room.
   * @param {unknown} token
   */
  revoke(token) {
    const issuedAt = this.#verify(token);
    if (issuedAt === null) return;
    this.#pruneRevoked(this.#now());
    const key = sha256Hex(/** @type {string} */ (token));
    if (!this.#revoked.has(key) && this.#revoked.size >= this.#maxRevoked) this.#dropEarliest();
    this.#revoked.set(key, issuedAt + this.#ttlMs);
  }

  /**
   * Loads revocations persisted by `revocations()`. Malformed and already expired entries are ignored; when more than
   * `maxRevoked` remain, the ones that expire first are dropped.
   * @param {unknown} entries `{<sha256 hex of the cookie value>: expiresAt}`
   */
  restore(entries) {
    if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) return;
    const now = this.#now();
    const live = Object.entries(entries)
      .filter(([key, expiresAt]) => SHA256_HEX_RE.test(key) && Number.isSafeInteger(expiresAt) && expiresAt > now)
      .sort((a, b) => b[1] - a[1])
      .slice(0, this.#maxRevoked);
    for (const [key, expiresAt] of live) this.#revoked.set(key, expiresAt);
  }

  /** @returns {Record<string, number>} unexpired revocations keyed by the SHA-256 of the cookie value */
  revocations() {
    this.#pruneRevoked(this.#now());
    return Object.fromEntries(this.#revoked);
  }

  /** @param {number} now */
  #pruneRevoked(now) {
    for (const [key, expiresAt] of this.#revoked) {
      if (expiresAt <= now) this.#revoked.delete(key);
    }
  }

  #dropEarliest() {
    /** @type {[string, number]|undefined} */
    let earliest;
    for (const entry of this.#revoked) {
      if (earliest === undefined || entry[1] < earliest[1]) earliest = entry;
    }
    if (earliest !== undefined) this.#revoked.delete(earliest[0]);
  }

  /** @returns {number} number of tokens currently held in the revocation list */
  get revokedCount() {
    return this.#revoked.size;
  }
}

/**
 * Counts events per key inside a sliding time window. Used for login throttling.
 */
export class SlidingWindowCounter {
  /** @type {number} */
  #max;
  /** @type {number} */
  #windowMs;
  /** @type {number} */
  #maxKeys;
  /** @type {() => number} */
  #now;
  /** @type {Map<string, number[]>} key -> ascending event timestamps */
  #events = new Map();

  /**
   * @param {{max: number, windowMs: number, maxKeys?: number, now?: () => number}} options
   */
  constructor({ max, windowMs, maxKeys = 4096, now = Date.now }) {
    if (!Number.isSafeInteger(max) || max < 1) {
      throw new TypeError('SlidingWindowCounter max must be a positive integer');
    }
    if (!Number.isSafeInteger(windowMs) || windowMs < 1) {
      throw new TypeError('SlidingWindowCounter windowMs must be a positive integer');
    }
    this.#max = max;
    this.#windowMs = windowMs;
    this.#maxKeys = Math.max(1, maxKeys);
    this.#now = now;
  }

  /**
   * @param {string} key
   * @returns {number[]} fresh timestamps for the key (pruned in place)
   */
  #fresh(key) {
    const cutoff = this.#now() - this.#windowMs;
    const list = (this.#events.get(key) || []).filter((at) => at > cutoff);
    if (list.length) this.#events.set(key, list);
    else this.#events.delete(key);
    return list;
  }

  #makeRoom() {
    if (this.#events.size < this.#maxKeys) return;
    for (const key of [...this.#events.keys()]) this.#fresh(key);
    while (this.#events.size >= this.#maxKeys) {
      const oldest = this.#events.keys().next().value;
      if (oldest === undefined) break;
      this.#events.delete(oldest);
    }
  }

  /**
   * Records one event for the key.
   * @param {string} key
   * @returns {number} events for the key inside the window, including this one
   */
  hit(key) {
    const list = this.#fresh(key);
    if (!list.length) this.#makeRoom();
    list.push(this.#now());
    this.#events.set(key, list);
    return list.length;
  }

  /**
   * @param {string} key
   * @returns {number} events for the key inside the window
   */
  count(key) {
    return this.#fresh(key).length;
  }

  /**
   * @param {string} key
   */
  reset(key) {
    this.#events.delete(key);
  }

  /**
   * @param {string} key
   * @returns {number} seconds until the key is below the limit again; 0 when it is not limited
   */
  retryAfterSeconds(key) {
    const list = this.#fresh(key);
    if (list.length < this.#max) return 0;
    // The key becomes available once enough of its oldest events leave the window.
    const releasedAt = list[list.length - this.#max] + this.#windowMs;
    return Math.max(1, Math.ceil((releasedAt - this.#now()) / 1000));
  }
}
