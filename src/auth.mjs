// @ts-check
/**
 * Authentication and authorization: token login with per-address throttling, HMAC-signed HttpOnly session cookies,
 * exact-Origin checks and access-profile gates.
 */

import crypto from 'node:crypto';
import { ACCESS_PROFILES, AppError, SESSION_COOKIE } from './contracts.mjs';
import { readJson, sendJson } from './http.mjs';
import { SessionStore, SlidingWindowCounter, safeEqualText, sameOrigin } from './security.mjs';

/** @typedef {import('node:http').IncomingMessage} IncomingMessage */
/** @typedef {import('node:http').ServerResponse} ServerResponse */
/** @typedef {import('./contracts.mjs').Config} Config */
/** @typedef {import('./contracts.mjs').Logger} Logger */
/** @typedef {import('./contracts.mjs').AccessProfile} AccessProfile */

/**
 * @typedef {Object} AuthApi
 * @property {(req: IncomingMessage) => {authenticated: boolean, authRequired: boolean, profile: AccessProfile|null,
 *   appName: string, version: string, bootId: string}} sessionInfo
 * @property {(req: IncomingMessage) => {profile: AccessProfile}|null} authenticate
 * @property {(req: IncomingMessage, res: ServerResponse) => Promise<void>} login
 * @property {(req: IncomingMessage, res: ServerResponse) => void} logout
 * @property {(req: IncomingMessage) => void} checkOrigin
 * @property {(actual: AccessProfile|null, needed: AccessProfile) => void} requireProfile
 * @property {(req: IncomingMessage) => string} clientAddress
 */

const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_BODY_LIMIT = 8192;
const MAX_TOKEN_CHARS = 1024;
const SESSION_KEY_LABEL = 'caw-session-v1';
const FORWARDED_ADDRESS_RE = /^[0-9A-Fa-f:.]{2,45}$/;

/**
 * Derives the session-signing key from the Web token, so sessions survive restarts and die when the token changes.
 * @param {string} token
 * @returns {Buffer}
 */
function sessionSigningKey(token) {
  return crypto.createHmac('sha256', token).update(SESSION_KEY_LABEL).digest();
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
 * @param {{log: Logger, bootId: string, now?: () => number}} deps
 * @returns {AuthApi}
 */
export function createAuth(config, { log, bootId, now = Date.now }) {
  const secure = config.publicOrigin.startsWith('https://');
  const maxAgeSeconds = Math.floor(config.sessionTtlMs / 1000);
  const sessions = new SessionStore({ secret: sessionSigningKey(config.token), ttlMs: config.sessionTtlMs, now });
  const failures = new SlidingWindowCounter({ max: LOGIN_MAX_FAILURES, windowMs: LOGIN_WINDOW_MS, now });

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
   * @param {IncomingMessage} req
   * @returns {string}
   */
  function clientAddress(req) {
    if (config.trustProxy) {
      const forwarded = req.headers['x-forwarded-for'];
      if (typeof forwarded === 'string') {
        const first = forwarded.split(',')[0].trim();
        if (FORWARDED_ADDRESS_RE.test(first)) return first.toLowerCase();
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
      if (!safeEqualText(body.token, config.token)) {
        failures.hit(address);
        log.warn('login rejected');
        throw new AppError(401, 'INVALID_TOKEN', 'The login token is not valid');
      }
      failures.reset(address);
      log.info('session started');
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(sessions.create()) });
    },

    logout(req, res) {
      if (config.requireAuth) {
        for (const token of sessionCookieValues(req)) sessions.revoke(token);
        log.info('session ended');
      }
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader('') });
    },

    checkOrigin,
    requireProfile,
    clientAddress,
  };
}
