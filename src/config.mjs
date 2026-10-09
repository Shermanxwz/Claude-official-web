// @ts-check
/**
 * Resolves the gateway configuration from CAW_* environment variables. Pure: nothing is created or written.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCESS_PROFILES, EFFORT_LEVELS, PERMISSION_MODES } from './contracts.mjs';
import { canonicalExactOrigin, isLoopbackHost } from './security.mjs';

/** @typedef {import('./contracts.mjs').Config} Config */
/** @typedef {import('./contracts.mjs').AccessProfile} AccessProfile */

/** Thrown for every invalid or inconsistent configuration value. The message names the variable. */
export class ConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const PACKAGE_JSON_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const HOST_RE = /^[A-Za-z0-9.:_[\]-]{1,255}$/;
const SHA256_HEX_RE = /^[0-9a-fA-F]{64}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const DIGITS_RE = /^\d+$/;
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];
const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * @param {string|undefined} raw
 * @returns {string|null} the trimmed value, or null when the variable is unset or blank
 */
function optionalText(raw) {
  if (raw === undefined) return null;
  const value = raw.trim();
  return value === '' ? null : value;
}

/**
 * @param {string} name
 * @param {string|undefined} raw
 * @param {boolean} fallback
 * @returns {boolean}
 */
function flag(name, raw, fallback) {
  const value = optionalText(raw);
  if (value === null) return fallback;
  const lowered = value.toLowerCase();
  if (lowered === '1' || lowered === 'true') return true;
  if (lowered === '0' || lowered === 'false') return false;
  throw new ConfigError(`${name} must be 0, 1, true or false`);
}

/**
 * @param {string} name
 * @param {string|undefined} raw
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function integer(name, raw, fallback, min, max) {
  const value = optionalText(raw);
  if (value === null) return fallback;
  const parsed = DIGITS_RE.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

/**
 * @param {string} name
 * @param {string|undefined} raw
 * @param {readonly string[]} allowed
 * @param {string|null} fallback
 * @returns {string|null}
 */
function choice(name, raw, allowed, fallback) {
  const value = optionalText(raw);
  if (value === null) return fallback;
  if (!allowed.includes(value)) throw new ConfigError(`${name} must be one of: ${allowed.join(', ')}`);
  return value;
}

/**
 * @param {string} name
 * @param {string} value
 * @param {number} maxChars
 * @returns {string}
 */
function plainText(name, value, maxChars) {
  if (CONTROL_RE.test(value)) throw new ConfigError(`${name} must not contain control characters`);
  if ([...value].length > maxChars) throw new ConfigError(`${name} must be at most ${maxChars} characters`);
  return value;
}

/**
 * @param {string} name
 * @param {string|undefined} raw
 * @returns {string[]} realpath'd, de-duplicated absolute directories
 */
function resolveRoots(name, raw, defaultRoot) {
  const value = optionalText(raw);
  const entries = value === null ? [defaultRoot] : value.split(':').map((entry) => entry.trim());
  /** @type {string[]} */
  const roots = [];
  for (const entry of entries) {
    if (entry === '') throw new ConfigError(`${name} must not contain empty entries`);
    if (!path.isAbsolute(entry)) throw new ConfigError(`${name} entries must be absolute paths: ${entry}`);
    let real;
    try {
      real = fs.realpathSync(entry);
    } catch {
      throw new ConfigError(`${name} entry does not exist: ${entry}`);
    }
    if (!fs.statSync(real).isDirectory()) throw new ConfigError(`${name} entry is not a directory: ${entry}`);
    roots.push(real);
  }
  return [...new Set(roots)];
}

/** The browser MCP command runs as one executable with arguments (docs/PROTOCOL.md "Browser tools"). */
const BROWSER_COMMAND_MAX_ITEMS = 32;
const BROWSER_COMMAND_MAX_CHARS = 1024;
const BARE_COMMAND_RE = /^[A-Za-z0-9._-]+$/;

/**
 * @param {string|undefined} raw
 * @returns {string[]|null} the command and its arguments, or null when unset
 */
function browserMcpCommandOf(raw) {
  const value = optionalText(raw);
  if (value === null) return null;
  const name = 'CAW_BROWSER_MCP_COMMAND';
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ConfigError(`${name} must be a JSON array of strings`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > BROWSER_COMMAND_MAX_ITEMS) {
    throw new ConfigError(`${name} must be a JSON array of 1 to ${BROWSER_COMMAND_MAX_ITEMS} strings`);
  }
  for (const item of parsed) {
    if (typeof item !== 'string' || item.length < 1 || item.length > BROWSER_COMMAND_MAX_CHARS) {
      throw new ConfigError(`${name} entries must be strings of 1 to ${BROWSER_COMMAND_MAX_CHARS} characters`);
    }
    if (CONTROL_RE.test(item)) throw new ConfigError(`${name} entries must not contain control characters`);
  }
  const [command] = parsed;
  if (!path.isAbsolute(command) && !BARE_COMMAND_RE.test(command)) {
    throw new ConfigError(`${name} must start with an absolute path or a bare command name`);
  }
  return [...parsed];
}

/** @returns {string} */
function readPackageVersion() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
    if (typeof parsed.version === 'string' && parsed.version !== '') return parsed.version;
  } catch (error) {
    throw new ConfigError(`Cannot read the package version from package.json: ${error.message}`);
  }
  throw new ConfigError('package.json does not declare a version');
}

/**
 * Whether the runtime will be told to run without background tasks: CLAUDE_CODE_DISABLE_BACKGROUND_TASKS is set to a
 * non-empty value other than 0 or false. The runtime inherits this environment, so the gateway checks the same value.
 * @param {string|undefined} raw
 * @returns {boolean}
 */
function backgroundTasksDisabledIn(raw) {
  const value = optionalText(raw);
  if (value === null) return false;
  const lowered = value.toLowerCase();
  return lowered !== '0' && lowered !== 'false';
}

/**
 * @param {Record<string, string|undefined>} env
 * @returns {string}
 */
function resolveStateDir(env) {
  const explicit = optionalText(env.CAW_STATE_DIR);
  if (explicit !== null) {
    if (!path.isAbsolute(explicit)) throw new ConfigError('CAW_STATE_DIR must be an absolute path');
    return path.resolve(explicit);
  }
  const xdgState = optionalText(env.XDG_STATE_HOME);
  const base = xdgState !== null && path.isAbsolute(xdgState)
    ? xdgState
    : path.join(optionalText(env.HOME) ?? os.homedir(), '.local', 'state');
  return path.join(base, 'claude-official-web');
}

/**
 * @param {Record<string, string|undefined>} env
 * @returns {string|null}
 */
function resolveClaudeBin(env) {
  const raw = optionalText(env.CAW_CLAUDE_BIN);
  if (raw === null) return null;
  if (!path.isAbsolute(raw)) throw new ConfigError('CAW_CLAUDE_BIN must be an absolute path to the claude binary');
  let stat;
  try {
    stat = fs.statSync(raw);
  } catch {
    throw new ConfigError(`CAW_CLAUDE_BIN does not exist: ${raw}`);
  }
  if (!stat.isFile()) throw new ConfigError(`CAW_CLAUDE_BIN is not a file: ${raw}`);
  return path.resolve(raw);
}

/**
 * Resolves and validates the gateway configuration.
 * @param {Record<string, string|undefined>} [env]
 * @param {{packageVersion?: string}} [options]
 * @returns {Config}
 * @throws {ConfigError}
 */
export function loadConfig(env = process.env, { packageVersion } = {}) {
  const host = optionalText(env.CAW_HOST) ?? '127.0.0.1';
  if (!HOST_RE.test(host)) throw new ConfigError('CAW_HOST must be an IP address or host name without spaces');

  const port = integer('CAW_PORT', env.CAW_PORT, 4180, 1, 65535);
  const requireAuth = flag('CAW_REQUIRE_AUTH', env.CAW_REQUIRE_AUTH, true);
  if (!requireAuth && !isLoopbackHost(host)) {
    throw new ConfigError('CAW_REQUIRE_AUTH=0 is allowed only when CAW_HOST is 127.0.0.1, ::1 or localhost');
  }

  const token = env.CAW_TOKEN ?? '';
  const tokenSha256Raw = optionalText(env.CAW_TOKEN_SHA256);
  if (token !== '' && tokenSha256Raw !== null) {
    throw new ConfigError('set either CAW_TOKEN or CAW_TOKEN_SHA256, not both');
  }
  if (token !== '' && (token.length < 16 || token.length > 1024)) {
    throw new ConfigError('CAW_TOKEN must be between 16 and 1024 characters');
  }
  if (tokenSha256Raw !== null && !SHA256_HEX_RE.test(tokenSha256Raw)) {
    throw new ConfigError('CAW_TOKEN_SHA256 must be 64 hexadecimal characters (the SHA-256 of the login token)');
  }
  const tokenSha256 = tokenSha256Raw === null ? '' : tokenSha256Raw.toLowerCase();
  if (requireAuth && token === '' && tokenSha256 === '') {
    throw new ConfigError('CAW_TOKEN (at least 16 characters) or CAW_TOKEN_SHA256 is required when CAW_REQUIRE_AUTH=1');
  }

  const originRaw = optionalText(env.CAW_PUBLIC_ORIGIN);
  if (originRaw !== null && canonicalExactOrigin(originRaw) === '') {
    throw new ConfigError('CAW_PUBLIC_ORIGIN must be an exact http or https origin such as https://example.com '
      + '(no path, query, fragment, credentials or trailing slash)');
  }

  const profile = /** @type {AccessProfile} */ (choice('CAW_ACCESS_PROFILE', env.CAW_ACCESS_PROFILE,
    ACCESS_PROFILES, 'full'));
  const appNameRaw = optionalText(env.CAW_APP_NAME);
  const appName = appNameRaw === null ? 'Agent Web' : plainText('CAW_APP_NAME', appNameRaw, 60);

  const home = optionalText(env.HOME) ?? os.homedir();
  const roots = resolveRoots('CAW_WORKSPACE_ROOTS', env.CAW_WORKSPACE_ROOTS, home);
  const stateDir = resolveStateDir(env);

  const engine = /** @type {'sdk'|'mock'} */ (choice('CAW_ENGINE', env.CAW_ENGINE, ['sdk', 'mock'], 'sdk'));
  const claudeBin = resolveClaudeBin(env);

  const modelRaw = optionalText(env.CAW_DEFAULT_MODEL);
  const model = modelRaw === null ? null : plainText('CAW_DEFAULT_MODEL', modelRaw, 200);
  const allowBypass = flag('CAW_ALLOW_BYPASS', env.CAW_ALLOW_BYPASS, false);
  const permissionMode = /** @type {import('./contracts.mjs').Config['defaults']['permissionMode']} */ (
    choice('CAW_DEFAULT_PERMISSION_MODE', env.CAW_DEFAULT_PERMISSION_MODE, PERMISSION_MODES, null));
  if (permissionMode === 'bypassPermissions') {
    if (!allowBypass) {
      throw new ConfigError('CAW_DEFAULT_PERMISSION_MODE=bypassPermissions requires CAW_ALLOW_BYPASS=1');
    }
    if (profile !== 'full') {
      throw new ConfigError('CAW_DEFAULT_PERMISSION_MODE=bypassPermissions requires CAW_ACCESS_PROFILE=full');
    }
  }
  const effort = /** @type {import('./contracts.mjs').Config['defaults']['effort']} */ (
    choice('CAW_DEFAULT_EFFORT', env.CAW_DEFAULT_EFFORT, EFFORT_LEVELS, null));
  const fallbackModelRaw = optionalText(env.CAW_FALLBACK_MODEL);
  const fallbackModel = fallbackModelRaw === null ? null : plainText('CAW_FALLBACK_MODEL', fallbackModelRaw, 200);

  const sessionTtlHours = integer('CAW_SESSION_TTL_HOURS', env.CAW_SESSION_TTL_HOURS, 168, 1, 8760);

  return Object.freeze({
    host,
    port,
    requireAuth,
    token,
    tokenSha256,
    publicOrigin: originRaw ?? '',
    profile,
    appName,
    version: packageVersion || readPackageVersion(),
    roots,
    stateDir,
    engine,
    claudeBin,
    defaults: Object.freeze({ model, permissionMode, effort, fallbackModel }),
    terminal: flag('CAW_TERMINAL', env.CAW_TERMINAL, false),
    allowBypass,
    chrome: flag('CAW_CHROME', env.CAW_CHROME, false),
    browserMcpCommand: browserMcpCommandOf(env.CAW_BROWSER_MCP_COMMAND),
    backgroundTasksDisabled: backgroundTasksDisabledIn(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS),
    idleTimeoutMs: integer('CAW_IDLE_TIMEOUT_MS', env.CAW_IDLE_TIMEOUT_MS, 1800000, 60000, 86400000),
    maxLiveSessions: integer('CAW_MAX_LIVE_SESSIONS', env.CAW_MAX_LIVE_SESSIONS, 4, 1, 32),
    uploadMaxBytes: integer('CAW_UPLOAD_MAX_BYTES', env.CAW_UPLOAD_MAX_BYTES, 26214400, 1024, 1073741824),
    imageMaxBytes: integer('CAW_IMAGE_MAX_BYTES', env.CAW_IMAGE_MAX_BYTES, 5242880, 1024, 20971520),
    uploadRetentionDays: integer('CAW_UPLOAD_RETENTION_DAYS', env.CAW_UPLOAD_RETENTION_DAYS, 7, 1, 365),
    sessionTtlMs: sessionTtlHours * MS_PER_HOUR,
    trustProxy: flag('CAW_TRUST_PROXY', env.CAW_TRUST_PROXY, false),
    logLevel: /** @type {Config['logLevel']} */ (choice('CAW_LOG_LEVEL', env.CAW_LOG_LEVEL, LOG_LEVELS, 'info')),
  });
}
