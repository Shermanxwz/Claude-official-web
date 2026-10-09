// @ts-check
/**
 * Authentication and authorization: token login with per-address throttling, HMAC-signed HttpOnly session cookies
 * whose revocations survive restarts, exact-Origin checks and access-profile gates.
 */

import crypto from 'node:crypto';
import net from 'node:net';
import { ACCESS_PROFILES, AppError, SESSION_COOKIE } from './contracts.mjs';
import { readJson, sendJson } from './http.mjs';
import { SessionStore, SlidingWindowCounter, safeEqualText, sameOrigin, sha256Hex } from './security.mjs';

/** @typedef {import('node:http').IncomingMessage} IncomingMessage */
/** @typedef {import('node:http').ServerResponse} ServerResponse */
/** @typedef {import('./contracts.mjs').Config} Config */
/** @typedef {import('./contracts.mjs').Logger} Logger */
/** @typedef {import('./contracts.mjs').AccessProfile} AccessProfile */
/** @typedef {import('./state.mjs').StateStore} StateStore */

/**
 * @typedef {Object} AuthApi
 * @property {(req: IncomingMessage) => {authenticated: boolean, authRequired: boolean, profile: AccessProfile|null,
 *   appName: string, version: string, bootId: string}} sessionInfo
 * @property {(req: IncomingMessage) => {profile: AccessProfile}|null} authenticate
 * @property {(req: IncomingMessage, res: ServerResponse) => Promise<void>} login
 * @property {(req: IncomingMessage, res: ServerResponse) => Promise<void>} logout
 * @property {(req: IncomingMessage) => void} checkOrigin
 * @property {(actual: AccessProfile|null, needed: AccessProfile) => void} requireProfile
 * @property {(req: IncomingMessage) => string} clientAddress
 */

const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_BODY_LIMIT = 8192;
const MAX_TOKEN_CHARS = 1024;
const SESSION_KEY_LABEL = 'caw-session-v1';
const REVOCATION_STATE = 'revoked-sessions';

/**
 * SHA-256 digest of the login token, used to derive the plaintext-mode signing secret.
 * @param {Config} config
 * @returns {Buffer}
 */
function tokenDigest(config) {
  if (config.tokenSha256 !== '') return Buffer.from(config.tokenSha256, 'hex');
  return crypto.createHash('sha256').update(config.token, 'utf8').digest();
}

/**
 * Derives the session-signing secret from the token digest. Changing the token invalidates every session.
 * @param {Buffer} digest
 * @returns {Buffer}
 */
function sessionSigningSecret(digest) {
  return crypto.createHmac('sha256', digest).update(SESSION_KEY_LABEL).digest();
}

/**
 * Session-signing secret for this process. With a plaintext CAW_TOKEN the secret is derived from the token so sessions
 * survive restarts. With CAW_TOKEN_SHA256 the digest sits in the service's environment file, which the agent's OS user
 * can read; deriving the secret from it would let anyone holding that file forge sessions without knowing the token.
 * Hash mode therefore signs with a random secret that exists only in memory, so sessions end when the gateway
 * restarts.
 * @param {Config} config
 * @returns {Buffer}
 */
function sessionSecretFor(config) {
  if (config.tokenSha256 !== '') return crypto.randomBytes(32);
  return sessionSigningSecret(tokenDigest(config));
}

/**
 * @param {IncomingMessage} req
 * @returns {string[]} every value of the session cookie in the request
 */
function sessionCookieValues(req) {
  const header = req.headers.cookie;
  if (typeof header !== 'string' || header === '') return [];
  const values = [];
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    if (part.slice(0, index).trim() === SESSION_COOKIE) values.push(part.slice(index + 1).trim());
  }
  return values;
}

/**
 * @param {Config} config
 * @param {{log: Logger, bootId: string, now?: () => number, stateStore?: StateStore, maxRevoked?: number}} deps
 *   `stateStore` persists the session revocations across restarts; without it they are kept in memory only.
 *   `maxRevoked` bounds the revocation list; the default suits production.
 * @returns {Promise<AuthApi>}
 */
export async function createAuth(config, { log, bootId, now = Date.now, stateStore, maxRevoked }) {
  const secure = config.publicOrigin.startsWith('https://');
  const maxAgeSeconds = Math.floor(config.sessionTtlMs / 1000);
  const failures = new SlidingWindowCounter({ max: LOGIN_MAX_FAILURES, windowMs: LOGIN_WINDOW_MS, now });
  /** Null when authentication is disabled: no cookie is issued or checked then. */
  const sessions = config.requireAuth
    ? new SessionStore({ secret: sessionSecretFor(config), ttlMs: config.sessionTtlMs, now, maxRevoked })
    : null;
  if (sessions && stateStore) sessions.importState(await stateStore.read(REVOCATION_STATE, null));
  /** Writes are chained so that the newest snapshot always lands last. */
  let persisted = Promise.resolve();

  /** @returns {Promise<void>} resolves once the current revocation list is on disk (or the failure is logged) */
  function persistRevocations() {
    if (!sessions || !stateStore) return Promise.resolve();
    persisted = persisted.then(async () => {
      try {
        await stateStore.write(REVOCATION_STATE, sessions.exportState());
      } catch (error) {
        log.error('could not persist session revocations', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    return persisted;
  }

  /**
   * @param {string} value
   * @returns {string}
   */
  function cookieHeader(value) {
    const attributes = [`${SESSION_COOKIE}=${value}`, 'HttpOnly', 'SameSite=Strict', 'Path=/',
      `Max-Age=${value === '' ? 0 : maxAgeSeconds}`];
    if (secure) attributes.push('Secure');
    return attributes.join('; ');
  }

  /**
   * With trustProxy, the address comes from CF-Connecting-IP, then X-Real-IP, then the last X-Forwarded-For hop. The
   * first hop is never used: the client sends it. Values that are not IP addresses are ignored.
   * @param {IncomingMessage} req
   * @returns {string}
   */
  function clientAddress(req) {
    if (config.trustProxy) {
      for (const name of ['cf-connecting-ip', 'x-real-ip']) {
        const value = req.headers[name];
        const candidate = typeof value === 'string' ? value.trim() : '';
        if (net.isIP(candidate)) return candidate.toLowerCase();
      }
      const forwarded = req.headers['x-forwarded-for'];
      if (typeof forwarded === 'string') {
        const hops = forwarded.split(',');
        const last = hops[hops.length - 1].trim();
        if (net.isIP(last)) return last.toLowerCase();
      }
    }
    return req.socket.remoteAddress || 'unknown';
  }

  /**
   * @param {IncomingMessage} req
   * @returns {{profile: AccessProfile}|null}
   */
  function authenticate(req) {
    if (!config.requireAuth) return { profile: config.profile };
    const valid = sessionCookieValues(req).some((token) => sessions.has(token));
    return valid ? { profile: config.profile } : null;
  }

  /**
   * @param {IncomingMessage} req
   */
  function checkOrigin(req) {
    if (!sameOrigin(req, config.publicOrigin)) {
      throw new AppError(403, 'ORIGIN_REJECTED', 'The request origin is not allowed');
    }
  }

  /**
   * @param {AccessProfile|null} actual
   * @param {AccessProfile} needed
   */
  function requireProfile(actual, needed) {
    const neededRank = ACCESS_PROFILES.indexOf(needed);
    if (neededRank < 0) throw new TypeError(`Unknown access profile: ${needed}`);
    if (ACCESS_PROFILES.indexOf(/** @type {AccessProfile} */ (actual)) < neededRank) {
      throw new AppError(403, 'FORBIDDEN', `This action requires the ${needed} access profile`);
    }
  }

  return {
    sessionInfo(req) {
      const auth = authenticate(req);
      return {
        authenticated: auth !== null,
        authRequired: config.requireAuth,
        profile: auth ? auth.profile : null,
        appName: config.appName,
        version: config.version,
        bootId,
      };
    },

    authenticate,

    async login(req, res) {
      checkOrigin(req);
      if (!config.requireAuth) {
        sendJson(res, 200, { ok: true });
        return;
      }
      const address = clientAddress(req);
      const retryAfter = failures.retryAfterSeconds(address);
      if (retryAfter > 0) {
        log.warn('login rate limited', { retryAfter });
        throw new AppError(429, 'RATE_LIMITED', 'Too many failed sign-in attempts. Try again later.', { retryAfter });
      }
      const body = await readJson(req, LOGIN_BODY_LIMIT);
      if (typeof body.token !== 'string' || body.token.length > MAX_TOKEN_CHARS) {
        throw new AppError(400, 'BAD_REQUEST', `Field token must be a string of at most ${MAX_TOKEN_CHARS} characters`);
      }
      const matches = config.tokenSha256 !== ''
        ? safeEqualText(sha256Hex(body.token), config.tokenSha256)
        : safeEqualText(body.token, config.token);
      if (!matches) {
        failures.hit(address);
        log.warn('login rejected');
        throw new AppError(401, 'INVALID_TOKEN', 'The login token is not valid');
      }
      failures.reset(address);
      log.info('session started');
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(sessions.create()) });
    },

    async logout(req, res) {
      if (sessions) {
        for (const token of sessionCookieValues(req)) sessions.revoke(token);
        log.info('session ended');
        await persistRevocations();
      }
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader('') });
    },

    checkOrigin,
    requireProfile,
    clientAddress,
  };
}
