// @ts-check
/**
 * EngineHost: owns one live Claude Agent SDK query per open session, the pending interactive requests of those
 * queries, the bounded event ring of each query, and the session-file operations the gateway exposes. The SDK
 * itself is reached only through the EngineAdapter injected by src/server.mjs.
 */

import { randomUUID } from 'node:crypto';
import { AppError, EFFORT_LEVELS, PERMISSION_MODES, isUuid } from '../contracts.mjs';
import { AsyncQueue } from './queue.mjs';
import { RequestRegistry, toElicitationResult, toPermissionResult } from './requests.mjs';
import { engineEnv } from './env.mjs';

/** @typedef {import('../contracts.mjs').EngineHostApi} EngineHostApi */
/** @typedef {import('../contracts.mjs').EngineAdapter} EngineAdapter */
/** @typedef {import('../contracts.mjs').Config} Config */
/** @typedef {import('../contracts.mjs').Logger} Logger */
/** @typedef {import('../contracts.mjs').Publish} Publish */
/** @typedef {import('../contracts.mjs').LiveInfo} LiveInfo */
/** @typedef {import('../contracts.mjs').LiveState} LiveState */
/** @typedef {import('../contracts.mjs').LiveEvent} LiveEvent */
/** @typedef {import('../contracts.mjs').PendingRequest} PendingRequest */
/** @typedef {import('../contracts.mjs').SessionSettings} SessionSettings */
/** @typedef {import('../contracts.mjs').SessionSummary} SessionSummary */
/** @typedef {import('../contracts.mjs').SessionDetail} SessionDetail */
/** @typedef {import('../contracts.mjs').Capabilities} Capabilities */
/** @typedef {import('../contracts.mjs').SdkQuery} SdkQuery */
/** @typedef {import('../contracts.mjs').SdkOptions} SdkOptions */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SDKMessage} SDKMessage */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SDKUserMessage} SDKUserMessage */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SDKSystemMessage} SDKSystemMessage */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SDKSessionInfo} SDKSessionInfo */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SessionMessage} SessionMessage */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').PermissionMode} PermissionMode */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').EffortLevel} EffortLevel */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').CanUseTool} CanUseTool */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').OnElicitation} OnElicitation */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').RewindFilesResult} RewindFilesResult */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').McpServerStatus} McpServerStatus */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SlashCommand} SlashCommand */
/** @typedef {import('node:crypto').UUID} UUID */
/** @typedef {SessionMessage & {index: number}} IndexedMessage */

const IDLE_SWEEP_MS = 60_000;
const EVENT_RING_MAX_ITEMS = 2000;
const EVENT_RING_MAX_BYTES = 4 * 1024 * 1024;
const CAPABILITIES_TTL_MS = 30_000;
const CAPABILITIES_REMEMBER_MAX = 100;
const CLIENT_MESSAGE_TTL_MS = 10 * 60_000;
const CLIENT_MESSAGE_MAX = 2000;
const CLOSE_WAIT_MS = 3000;
const TRANSCRIPT_CACHE_MAX = 32;
const PENDING_SETTINGS_MAX = 5000;
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 500;
const DEFAULT_TRANSCRIPT_LIMIT = 200;
const MAX_TRANSCRIPT_LIMIT = 1000;
const TITLE_MAX = 200;
const TAG_MAX = 100;
const ID_MAX = 200;
const MAX_IMAGES = 10;
const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const REWIND_MODES = ['code', 'conversation', 'both'];
const MODEL_RE = /^[\x21-\x7e]{1,200}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const ENGINE_UNAVAILABLE_RE = /spawn|ENOENT|not found|Native CLI binary|log ?in|authenticat|api key|credential/i;
const CONTROL_TIMEOUT_MS = 10_000;
const TIMEOUT_MESSAGE = 'The Claude Code runtime did not respond in time.';
const CREDENTIALS_MESSAGE = 'Claude Code credentials were rejected. Log in again on the server: run `claude` and use '
  + '/login.';
/** Errors of the authentication class: the runtime's credentials were rejected. Billing and rate limits are not. */
const AUTH_ERRORS = ['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required'];

/**
 * Per-session state of one live query.
 * @typedef {Object} LiveRecord
 * @property {string} sessionId
 * @property {string} cwd
 * @property {SdkQuery|null} query
 * @property {AsyncQueue<SDKUserMessage>} input
 * @property {AbortController} abort
 * @property {LiveState} state
 * @property {string|null} model
 * @property {PermissionMode} permissionMode
 * @property {EffortLevel|null} effort
 * @property {string|null} title
 * @property {number} lastActivity
 * @property {EventRing} events
 * @property {SDKSystemMessage|null} init
 * @property {{code: string, message: string}|null} error
 * @property {string|null} claudeCodeVersion
 * @property {{at: number, value: Capabilities}|null} capsCache
 * @property {SlashCommand[]|null} commands
 * @property {Promise<void>|null} pump
 * @property {boolean} closing      set when the gateway closes the query; its end is never an error
 * @property {string|null} published   last published LiveInfo, without lastActivity
 * @property {boolean} trusted      project settings, hooks and MCP servers of cwd are loaded by this query
 * @property {boolean} credentialsRejected   the runtime rejected its credentials; the notice was published
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** @param {string} message */
function badRequest(message) {
  return new AppError(400, 'BAD_REQUEST', message);
}

/** @param {string} message */
function invalid(message) {
  return new AppError(422, 'INVALID_ARGUMENT', message);
}

/** @param {string} message */
function engineError(message) {
  return new AppError(502, 'ENGINE_ERROR', message);
}

/** @param {string} message */
function cannotRewind(message) {
  return new AppError(422, 'CANNOT_REWIND', message);
}

/**
 * The first line of a text, at most 300 characters, or the fallback when there is none.
 * @param {unknown} text
 * @param {string} fallback
 * @returns {string}
 */
function firstLine(text, fallback) {
  const line = (typeof text === 'string' ? text : '').split('\n')[0].trim().slice(0, 300);
  return line || fallback;
}

function sessionLocked() {
  return new AppError(409, 'SESSION_LOCKED', 'The terminal is using this session.');
}

function sessionNotFound() {
  return new AppError(404, 'SESSION_NOT_FOUND', 'Session not found.');
}

function sessionNotLive() {
  return new AppError(409, 'SESSION_NOT_LIVE', 'The session is not open. Open it first.');
}

function outsideRoots() {
  return new AppError(422, 'PATH_NOT_ALLOWED', 'The folder is outside the workspace roots.');
}

/** @param {unknown} sessionId */
function requireSessionId(sessionId) {
  if (!isUuid(sessionId)) throw badRequest('The session id is not valid.');
}

/** @param {unknown} error */
function errorName(error) {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * @param {readonly unknown[]} list
 * @param {unknown} value
 */
function includes(list, value) {
  return list.includes(value);
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {number} max
 * @returns {string} trimmed text
 */
function parseText(value, field, max) {
  if (typeof value !== 'string') throw badRequest(`${field} must be a string.`);
  const text = value.trim();
  if (text.length > max) throw invalid(`${field} must be at most ${max} characters.`);
  return text;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @param {number} min
 * @param {number} max
 * @returns {number|undefined}
 */
function parseInteger(value, name, min, max) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < min || /** @type {number} */ (value) > max) {
    throw badRequest(`${name} must be an integer between ${min} and ${max}.`);
  }
  return /** @type {number} */ (value);
}

/**
 * Identifiers that travel in bodies and paths: request, task, agent and server names, message ids.
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function parseToken(value, label) {
  if (typeof value !== 'string' || value === '' || value.length > ID_MAX) throw badRequest(`${label} is not valid.`);
  return value;
}

/**
 * @param {unknown} action
 * @returns {{kind: 'toggle'|'reconnect', enabled: boolean}}
 */
function parseMcpAction(action) {
  if (!isPlainObject(action)) throw badRequest('The MCP action must be an object.');
  const kind = action.action;
  if (kind !== 'toggle' && kind !== 'reconnect') throw invalid('The MCP action must be toggle or reconnect.');
  if (action.enabled !== undefined && typeof action.enabled !== 'boolean') {
    throw badRequest('enabled must be a boolean.');
  }
  return { kind, enabled: action.enabled === undefined ? true : /** @type {boolean} */ (action.enabled) };
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function parseModel(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !MODEL_RE.test(value)) throw invalid('The model is not valid.');
  return value;
}

/**
 * @param {unknown} value
 * @returns {PermissionMode}
 */
function parsePermissionMode(value) {
  if (!includes(PERMISSION_MODES, value)) throw invalid('The permission mode is not supported.');
  return /** @type {PermissionMode} */ (value);
}

/**
 * @param {unknown} value
 * @returns {EffortLevel|null}
 */
function parseEffort(value) {
  if (value === null) return null;
  if (!includes(EFFORT_LEVELS, value)) throw invalid('The effort level is not supported.');
  return /** @type {EffortLevel} */ (value);
}

/**
 * Validates the settings a caller supplied. Only keys that are present in the input are returned.
 * @param {unknown} input
 * @returns {SessionSettings}
 */
function parseSettings(input) {
  if (input === undefined || input === null) return {};
  if (!isPlainObject(input)) throw badRequest('The settings must be an object.');
  /** @type {SessionSettings} */
  const settings = {};
  if (input.model !== undefined) settings.model = parseModel(input.model);
  if (input.permissionMode !== undefined) settings.permissionMode = parsePermissionMode(input.permissionMode);
  if (input.effort !== undefined) settings.effort = parseEffort(input.effort);
  return settings;
}

/**
 * @param {{limit?: unknown, offset?: unknown}} page
 * @returns {{limit: number, offset: number}}
 */
function parsePage({ limit, offset }) {
  return {
    limit: parseInteger(limit, 'limit', 1, MAX_PAGE_LIMIT) ?? DEFAULT_PAGE_LIMIT,
    offset: parseInteger(offset, 'offset', 0, Number.MAX_SAFE_INTEGER) ?? 0,
  };
}

/**
 * Transcript window: `before` + `limit` returns the messages just before an index; otherwise the last `tail`.
 * @param {{tail?: unknown, before?: unknown, limit?: unknown}} window
 * @returns {{before: number|undefined, count: number}}
 */
function parseWindow({ tail, before, limit }) {
  const beforeIndex = parseInteger(before, 'before', 0, Number.MAX_SAFE_INTEGER);
  const count = parseInteger(limit, 'limit', 1, MAX_TRANSCRIPT_LIMIT);
  if (beforeIndex !== undefined) return { before: beforeIndex, count: count ?? DEFAULT_TRANSCRIPT_LIMIT };
  const tailCount = parseInteger(tail, 'tail', 1, MAX_TRANSCRIPT_LIMIT);
  return { before: undefined, count: tailCount ?? count ?? DEFAULT_TRANSCRIPT_LIMIT };
}

/**
 * @param {unknown} value
 * @returns {Array<{mediaType: string, data: string}>}
 */
function parseImages(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_IMAGES) throw badRequest('The images must be a short list.');
  return value.map((image) => {
    const valid = isPlainObject(image) && includes(IMAGE_MEDIA_TYPES, image.mediaType)
      && typeof image.data === 'string' && BASE64_RE.test(image.data);
    if (!valid) throw badRequest('Each image needs a supported media type and base64 data.');
    return { mediaType: /** @type {string} */ (image.mediaType), data: /** @type {string} */ (image.data) };
  });
}

/**
 * @param {unknown} message
 * @returns {{clientMessageId: string, text: string, images: Array<{mediaType: string, data: string}>}}
 */
function parseMessage(message) {
  if (!isPlainObject(message)) throw badRequest('The message must be an object.');
  if (!isUuid(message.clientMessageId)) throw badRequest('The clientMessageId must be a UUID.');
  if (typeof message.text !== 'string') throw badRequest('The text must be a string.');
  const images = parseImages(message.images);
  if (message.text.trim() === '' && images.length === 0) throw badRequest('The message is empty.');
  return { clientMessageId: message.clientMessageId, text: message.text, images };
}

/**
 * Builds the streaming-input user message the SDK consumes.
 * @param {string} sessionId
 * @param {string} clientMessageId
 * @param {string} text
 * @param {Array<{mediaType: string, data: string}>} images
 * @returns {SDKUserMessage}
 */
function buildUserMessage(sessionId, clientMessageId, text, images) {
  /** @type {Array<Record<string, unknown>>} */
  const blocks = images.map((image) => ({
    type: 'image',
    source: { type: 'base64', media_type: image.mediaType, data: image.data },
  }));
  if (text.trim() !== '') blocks.push({ type: 'text', text });
  return /** @type {SDKUserMessage} */ ({
    type: 'user',
    message: { role: 'user', content: images.length > 0 ? blocks : text },
    parent_tool_use_id: null,
    uuid: /** @type {UUID} */ (clientMessageId),
    session_id: sessionId,
  });
}

/**
 * Classifies a failure of the engine. Setup problems (missing binary, no login) are reported as unavailable; the
 * message is reduced to its first line so no transcript content leaks into notices.
 * @param {unknown} error
 * @returns {{code: 'ENGINE_UNAVAILABLE'|'ENGINE_ERROR', message: string}}
 */
function describeEngineFailure(error) {
  const full = error instanceof Error ? error.message : String(error ?? '');
  const code = ENGINE_UNAVAILABLE_RE.test(full) ? 'ENGINE_UNAVAILABLE' : 'ENGINE_ERROR';
  return { code, message: firstLine(full, 'Claude Code stopped unexpectedly.') };
}

/**
 * Resolves when the promise settles or after `ms`, whichever comes first. Never rejects.
 * @param {Promise<unknown>} promise
 * @param {number} ms
 * @returns {Promise<void>}
 */
function settleWithin(promise, ms) {
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([promise.then(() => undefined, () => undefined), timeout])
    .finally(() => clearTimeout(timer));
}

/** A control call of the runtime that did not settle within CONTROL_TIMEOUT_MS. */
class ControlTimeout extends Error {
  constructor() {
    super(TIMEOUT_MESSAGE);
    this.name = 'ControlTimeout';
  }
}

/**
 * Runs one control call of the runtime and rejects with ControlTimeout when it does not settle in time.
 * @template T
 * @param {() => Promise<T>} call
 * @param {number} [ms]
 * @returns {Promise<T>}
 */
async function withTimeout(call, ms = CONTROL_TIMEOUT_MS) {
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new ControlTimeout()), ms);
  });
  try {
    return await Promise.race([call(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether an SDK message reports rejected credentials. Other retries and errors are not credential failures.
 * @param {SDKMessage} msg
 * @returns {boolean}
 */
function isCredentialFailure(msg) {
  if (msg.type === 'system' && msg.subtype === 'api_retry') return AUTH_ERRORS.includes(msg.error);
  return msg.type === 'assistant' && AUTH_ERRORS.includes(msg.error);
}

/**
 * @template {Record<string, unknown>} T
 * @param {T} object
 * @returns {Partial<T>}
 */
function omitUndefined(object) {
  const defined = Object.entries(object).filter(([, value]) => value !== undefined);
  return /** @type {Partial<T>} */ (Object.fromEntries(defined));
}

/** @param {Array<{lastModified: number}>} sessions */
function sortByRecency(sessions) {
  sessions.sort((a, b) => b.lastModified - a.lastModified);
}

/**
 * Size of an event in the ring, measured by its JSON length.
 * @param {unknown} msg
 */
function measure(msg) {
  try {
    return JSON.stringify(msg).length;
  } catch {
    return 1024;
  }
}

/**
 * Bounded buffer of the most recent SDK messages of one query: at most EVENT_RING_MAX_ITEMS entries and about
 * EVENT_RING_MAX_BYTES of JSON; the oldest entries are dropped first.
 */
class EventRing {
  /** @type {Array<{seq: number, msg: SDKMessage, bytes: number}>} */
  #items = [];
  #bytes = 0;

  /**
   * @param {number} seq
   * @param {SDKMessage} msg
   */
  push(seq, msg) {
    const bytes = measure(msg);
    this.#items.push({ seq, msg, bytes });
    this.#bytes += bytes;
    while (this.#items.length > 0
      && (this.#items.length > EVENT_RING_MAX_ITEMS || this.#bytes > EVENT_RING_MAX_BYTES)) {
      const dropped = /** @type {{bytes: number}} */ (this.#items.shift());
      this.#bytes -= dropped.bytes;
    }
  }

  /** @returns {LiveEvent[]} oldest first */
  snapshot() {
    return this.#items.map(({ seq, msg }) => ({ seq, msg }));
  }
}

/** @param {Capabilities} value @param {boolean} stale */
function withStale(value, stale) {
  return { ...value, stale };
}

/** @param {boolean} stale @returns {Capabilities} */
function emptyCapabilities(stale) {
  return {
    stale,
    commands: [],
    models: [],
    agents: [],
    account: null,
    mcpServers: [],
    outputStyle: null,
    availableOutputStyles: [],
  };
}

/**
 * Owns every live query, the pending interactive requests, the settings remembered per session, and the caches of
 * session files and capabilities. Every expected failure is thrown as an AppError.
 * @implements {EngineHostApi}
 */
export class EngineHost {
  /** @type {EngineAdapter} */
  #engine;
  /** @type {Config} */
  #config;
  /** @type {Logger} */
  #log;
  /** @type {Publish} */
  #publish;
  /** @type {() => number} */
  #getSeq;
  /** @type {(p: string) => Promise<boolean>} */
  #isAllowedCwd;
  /** @type {(p: string) => Promise<boolean>} */
  #isTrustedCwd;
  /** @type {() => number} */
  #now;
  /** @type {RequestRegistry} */
  #requests;
  /** @type {Map<string, LiveRecord>} */
  #live = new Map();
  /** @type {Map<string, Promise<void>>} the last lifecycle operation of each session that is still in flight */
  #opening = new Map();
  /** @type {Map<string, Partial<SessionSettings>>} */
  #pending = new Map();
  /** @type {Map<string, symbol>} */
  #locks = new Map();
  /** @type {Map<string, number>} */
  #messageIds = new Map();
  /** @type {Map<string, {key: string, messages: IndexedMessage[]}>} */
  #transcripts = new Map();
  /** @type {Map<string, Capabilities>} */
  #capsByCwd = new Map();
  /** @type {Capabilities|null} */
  #capsGlobal = null;
  /** @type {ReturnType<typeof setInterval>} */
  #sweepTimer;
  #stopped = false;
  /** @type {string|null} last Claude Code version reported by any init message */
  #lastClaudeCodeVersion = null;

  /**
   * Folder trust decides which setting sources a query loads. Without `isTrustedCwd` every folder is untrusted.
   * @param {{engine: EngineAdapter, config: Config, log: Logger, publish: Publish, getSeq: () => number,
   *   isAllowedCwd: (p: string) => Promise<boolean>, isTrustedCwd?: (p: string) => Promise<boolean>,
   *   now?: () => number}} options
   */
  constructor({
    engine, config, log, publish, getSeq, isAllowedCwd, isTrustedCwd = async () => false, now = Date.now,
  }) {
    this.#engine = engine;
    this.#config = config;
    this.#log = log;
    this.#publish = publish;
    this.#getSeq = getSeq;
    this.#isAllowedCwd = isAllowedCwd;
    this.#isTrustedCwd = isTrustedCwd;
    this.#now = now;
    this.#requests = new RequestRegistry({
      publish: (event) => {
        const seq = this.#publish(event);
        if (event.type === 'request' || event.type === 'request_resolved') this.#syncSession(event.sessionId);
        return seq;
      },
      now,
    });
    this.#sweepTimer = setInterval(() => {
      this.sweepIdle().catch((error) => this.#log.warn('idle sweep failed', { reason: errorName(error) }));
    }, IDLE_SWEEP_MS);
    this.#sweepTimer.unref();
  }

  /**
   * Persisted sessions merged with live ones, newest first. Without `cwd` only sessions inside an allowed workspace
   * are listed, and only live sessions can appear without a working directory.
   * @param {{cwd?: string, limit?: number, offset?: number}} [options]
   * @returns {Promise<SessionSummary[]>}
   */
  async listSessions({ cwd, limit, offset } = {}) {
    const page = parsePage({ limit, offset });
    if (cwd === undefined) return this.#allSessions(page);
    if (typeof cwd !== 'string' || cwd === '') throw badRequest('The cwd must be a path.');
    if (!(await this.#withinRoots(cwd))) throw outsideRoots();
    const found = await this.#engineList({ dir: cwd, limit: page.limit, offset: page.offset });
    const sessions = found.map((info) => this.#summary(info));
    if (page.offset === 0) {
      const listed = new Set(sessions.map((session) => session.sessionId));
      for (const live of [...this.#live.values()]) {
        if (live.cwd === cwd && !listed.has(live.sessionId)) sessions.push(this.#liveSummary(live));
      }
    }
    sortByRecency(sessions);
    return sessions.slice(0, page.limit);
  }

  /**
   * @param {{offset: number, limit: number}} page
   * @returns {Promise<SessionSummary[]>}
   */
  async #allSessions(page) {
    const found = await this.#engineList({});
    /** @type {Map<string, boolean>} */
    const allowed = new Map();
    /** @type {SessionSummary[]} */
    const sessions = [];
    for (const info of found) {
      if (info.cwd && (await this.#cwdAllowed(info.cwd, allowed))) sessions.push(this.#summary(info));
    }
    const listed = new Set(sessions.map((session) => session.sessionId));
    for (const live of [...this.#live.values()]) {
      if (!listed.has(live.sessionId) && (await this.#cwdAllowed(live.cwd, allowed))) {
        sessions.push(this.#liveSummary(live));
      }
    }
    sortByRecency(sessions);
    return sessions.slice(page.offset, page.offset + page.limit);
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<SessionDetail>}
   */
  async getSession(sessionId) {
    requireSessionId(sessionId);
    const { info, live } = await this.#scopeOf(sessionId, true);
    return {
      info,
      live: live ? this.#info(live) : null,
      pending: live ? this.#requests.list(sessionId) : [],
      liveEvents: live ? live.events.snapshot() : [],
      seq: this.#getSeq(),
      init: live ? live.init : null,
    };
  }

  /**
   * @param {string} sessionId
   * @param {{tail?: number, before?: number, limit?: number}} [options]
   */
  async getTranscript(sessionId, options = {}) {
    requireSessionId(sessionId);
    const { before, count } = parseWindow(options);
    const { info } = await this.#scopeOf(sessionId);
    const indexed = await this.#transcript(sessionId, info);
    const total = indexed.length;
    const end = before === undefined ? total : Math.min(before, total);
    const start = before === undefined ? Math.max(0, total - count) : Math.max(0, end - count);
    return { messages: indexed.slice(start, end), total, start, hasMore: start > 0 };
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<string>}
   */
  async sessionCwd(sessionId) {
    requireSessionId(sessionId);
    const { info, live } = await this.#scopeOf(sessionId);
    const cwd = live?.cwd ?? info?.cwd;
    if (!cwd) throw sessionNotFound();
    return cwd;
  }

  /**
   * Claude Code version from the most recent init message of any session, kept after sessions close.
   * @returns {string|null}
   */
  lastClaudeCodeVersion() {
    return this.#lastClaudeCodeVersion;
  }

  /**
   * @param {string} sessionId
   * @returns {LiveInfo|null}
   */
  liveInfo(sessionId) {
    const live = this.#live.get(sessionId);
    return live ? this.#info(live) : null;
  }

  /** @returns {LiveInfo[]} */
  allLive() {
    return [...this.#live.values()].map((live) => this.#info(live));
  }

  /**
   * Live sessions answer from the query (cached for 30 s). Other sessions answer with the last known capabilities of
   * their folder, or of any folder, marked stale.
   * @param {string} sessionId
   * @returns {Promise<Capabilities>}
   */
  async getCapabilities(sessionId) {
    requireSessionId(sessionId);
    const { info, live } = await this.#scopeOf(sessionId);
    if (live) return this.#liveCapabilities(live);
    return this.#rememberedFor(info?.cwd ?? null);
  }

  /**
   * @param {LiveRecord} live
   * @returns {Promise<Capabilities>}
   */
  async #liveCapabilities(live) {
    const cached = live.capsCache;
    if (cached && this.#now() - cached.at < CAPABILITIES_TTL_MS) return withStale(cached.value, false);
    const [init, mcpServers] = await Promise.all([
      this.#attempt(live, () => live.query.initializationResult()),
      this.#attempt(live, () => live.query.mcpServerStatus()),
    ]);
    if (init === undefined || mcpServers === undefined) return this.#lastKnown(live);
    /** @type {Capabilities} */
    const value = {
      stale: false,
      commands: init.commands ?? live.commands ?? [],
      models: init.models ?? [],
      agents: init.agents ?? [],
      account: init.account ?? null,
      mcpServers,
      outputStyle: init.output_style ?? null,
      availableOutputStyles: init.available_output_styles ?? [],
    };
    if (this.#live.get(live.sessionId) === live) live.capsCache = { at: this.#now(), value };
    this.#rememberCapabilities(live.cwd, value);
    return withStale(value, false);
  }

  /**
   * Runs one capability query under the control timeout. A failure or a timeout yields undefined, and the capabilities
   * then fall back to the last known value.
   * @template T
   * @param {LiveRecord} live
   * @param {() => Promise<T>} call
   * @returns {Promise<T|undefined>}
   */
  async #attempt(live, call) {
    try {
      return await withTimeout(call);
    } catch (error) {
      this.#log.debug('capability query failed', { sessionId: live.sessionId, reason: errorName(error) });
      return undefined;
    }
  }

  /**
   * @param {string} cwd
   * @param {Capabilities} value
   */
  #rememberCapabilities(cwd, value) {
    this.#capsGlobal = value;
    if (!cwd) return;
    this.#capsByCwd.delete(cwd);
    this.#capsByCwd.set(cwd, value);
    while (this.#capsByCwd.size > CAPABILITIES_REMEMBER_MAX) {
      this.#capsByCwd.delete(this.#capsByCwd.keys().next().value);
    }
  }

  /**
   * The last known capabilities of a folder, or of any folder, or empty lists. Always marked stale.
   * @param {string|null} cwd
   * @returns {Capabilities}
   */
  #rememberedFor(cwd) {
    const remembered = (cwd ? this.#capsByCwd.get(cwd) : undefined) ?? this.#capsGlobal;
    return remembered ? withStale(remembered, true) : emptyCapabilities(true);
  }

  /**
   * The answer of a live session when the runtime does not answer: the last known capabilities of its folder, with the
   * commands the session announced last. Always marked stale.
   * @param {LiveRecord} live
   * @returns {Capabilities}
   */
  #lastKnown(live) {
    const base = this.#rememberedFor(live.cwd);
    return live.commands === null ? base : { ...base, commands: live.commands };
  }

  /**
   * @param {LiveRecord} live
   * @returns {LiveInfo}
   */
  #info(live) {
    return {
      sessionId: live.sessionId,
      cwd: live.cwd,
      state: live.state,
      model: live.model,
      permissionMode: live.permissionMode,
      effort: live.effort,
      title: live.title,
      lockedBy: this.#locks.has(live.sessionId) ? 'terminal' : null,
      pendingCount: this.#requests.count(live.sessionId),
      lastActivity: live.lastActivity,
      claudeCodeVersion: live.claudeCodeVersion,
      error: live.error,
      trusted: live.trusted,
    };
  }

  /**
   * @param {SDKSessionInfo} info
   * @returns {SessionSummary}
   */
  #summary(info) {
    return { ...info, live: this.liveInfo(info.sessionId) };
  }

  /**
   * @param {LiveRecord} live
   * @returns {SessionSummary}
   */
  #liveSummary(live) {
    return /** @type {SessionSummary} */ (omitUndefined({
      sessionId: live.sessionId,
      summary: live.title ?? '',
      lastModified: live.lastActivity,
      cwd: live.cwd,
      customTitle: live.title ?? undefined,
      live: this.#info(live),
    }));
  }

  /**
   * @param {{dir?: string, limit?: number, offset?: number}} options
   * @returns {Promise<SDKSessionInfo[]>}
   */
  async #engineList(options) {
    try {
      return await this.#engine.listSessions(options);
    } catch (error) {
      this.#log.warn('listing sessions failed', { reason: errorName(error) });
      throw engineError('Claude Code could not list the sessions.');
    }
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<SDKSessionInfo|null>}
   */
  async #readInfo(sessionId) {
    try {
      return (await this.#engine.getSessionInfo(sessionId)) ?? null;
    } catch (error) {
      this.#log.warn('reading a session failed', { reason: errorName(error) });
      throw engineError('Claude Code could not read the session.');
    }
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<SDKSessionInfo|null>}
   */
  async #readInfoOrNull(sessionId) {
    try {
      return (await this.#engine.getSessionInfo(sessionId)) ?? null;
    } catch (error) {
      this.#log.warn('reading a session failed', { reason: errorName(error) });
      return null;
    }
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<SessionMessage[]>}
   */
  async #loadMessages(sessionId) {
    try {
      return await this.#engine.getSessionMessages(sessionId, { includeSystemMessages: true });
    } catch (error) {
      this.#log.warn('reading a transcript failed', { reason: errorName(error) });
      throw engineError('Claude Code could not read the transcript.');
    }
  }

  /**
   * The full transcript of a session with message indexes. Cached until the session file changes.
   * @param {string} sessionId
   * @param {SDKSessionInfo|null} info the session file, already checked to lie inside the roots
   * @returns {Promise<IndexedMessage[]>}
   */
  async #transcript(sessionId, info) {
    const key = info ? `${info.lastModified}:${info.fileSize ?? ''}` : 'live';
    const cached = this.#transcripts.get(sessionId);
    if (cached?.key === key) return cached.messages;
    const messages = info ? await this.#loadMessages(sessionId) : [];
    const indexed = messages.map((message, index) => ({ ...message, index }));
    this.#transcripts.delete(sessionId);
    this.#transcripts.set(sessionId, { key, messages: indexed });
    while (this.#transcripts.size > TRANSCRIPT_CACHE_MAX) {
      this.#transcripts.delete(this.#transcripts.keys().next().value);
    }
    return indexed;
  }

  /**
   * @param {string} cwd
   * @returns {Promise<boolean>}
   */
  async #isAllowed(cwd) {
    try {
      return (await this.#isAllowedCwd(cwd)) === true;
    } catch {
      return false;
    }
  }

  /**
   * @param {string} cwd
   * @param {Map<string, boolean>} cache
   * @returns {Promise<boolean>}
   */
  async #cwdAllowed(cwd, cache) {
    if (!cache.has(cwd)) cache.set(cwd, await this.#isAllowed(cwd));
    return cache.get(cwd) === true;
  }

  /**
   * Runs one lifecycle operation of a session after the operations already queued for it. The operation is registered
   * synchronously, before its first await, so every caller that arrives later waits for it. Work run here must never
   * wait for the same session again, or it would wait for itself.
   * @template T
   * @param {string} sessionId
   * @param {() => Promise<T>} work
   * @returns {Promise<T>}
   */
  #exclusive(sessionId, work) {
    const earlier = this.#opening.get(sessionId) ?? Promise.resolve();
    const run = earlier.then(work);
    const settled = run.then(() => undefined, () => undefined);
    this.#opening.set(sessionId, settled);
    void settled.then(() => {
      if (this.#opening.get(sessionId) === settled) this.#opening.delete(sessionId);
    });
    return run;
  }

  /**
   * Resolves once every lifecycle operation queued for the session so far has finished.
   * @param {string} sessionId
   * @returns {Promise<void>}
   */
  async #settled(sessionId) {
    for (let pending = this.#opening.get(sessionId); pending; pending = this.#opening.get(sessionId)) {
      await pending;
    }
  }

  /**
   * @param {unknown} cwd
   * @returns {Promise<boolean>} whether the folder lies inside an allowed workspace root
   */
  async #withinRoots(cwd) {
    return typeof cwd === 'string' && cwd !== '' && (await this.#isAllowed(cwd));
  }

  /**
   * Whether the folder is trusted. Fails closed: an error from the trust check means untrusted.
   * @param {string} cwd
   * @returns {Promise<boolean>}
   */
  async #trustOf(cwd) {
    try {
      return (await this.#isTrustedCwd(cwd)) === true;
    } catch {
      return false;
    }
  }

  /**
   * The file and the live query of a session, each withheld when its folder is outside the workspace roots. Throws
   * SESSION_NOT_FOUND when neither is visible. With `lenient`, a file that cannot be read counts as no file.
   * @param {string} sessionId
   * @param {boolean} [lenient]
   * @returns {Promise<{info: SDKSessionInfo|null, live: LiveRecord|null}>}
   */
  async #scopeOf(sessionId, lenient = false) {
    const found = lenient ? await this.#readInfoOrNull(sessionId) : await this.#readInfo(sessionId);
    const info = found && (await this.#withinRoots(found.cwd)) ? found : null;
    const current = this.#live.get(sessionId) ?? null;
    const live = current && (await this.#withinRoots(current.cwd)) ? current : null;
    if (!info && !live) throw sessionNotFound();
    return { info, live };
  }

  /**
   * Starts the query of a new or an existing session. The caller has validated the working directory and read its
   * trust. A session that is already open is refused, so two queries never share one id.
   * @param {{mode: 'new'|'resume', sessionId: string|null, cwd: string, trusted: boolean, title?: string,
   *   settings: SessionSettings, resumeSessionAt?: string}} start
   * @returns {LiveRecord}
   */
  #startQuery({ mode, sessionId, cwd, trusted, title, settings, resumeSessionAt }) {
    if (this.#stopped) throw new AppError(503, 'ENGINE_UNAVAILABLE', 'The gateway is shutting down.');
    const id = mode === 'new' ? randomUUID() : /** @type {string} */ (sessionId);
    if (this.#live.has(id)) throw new AppError(409, 'CONFLICT', 'The session is already open.');
    const resolved = this.#resolveSettings(mode === 'new' ? null : id, settings);
    this.#makeRoom();
    /** @type {LiveRecord} */
    const live = {
      sessionId: id,
      cwd,
      query: null,
      input: new AsyncQueue(),
      abort: new AbortController(),
      state: 'starting',
      model: resolved.model,
      permissionMode: resolved.permissionMode,
      effort: resolved.effort,
      title: title ?? null,
      lastActivity: this.#now(),
      events: new EventRing(),
      init: null,
      error: null,
      claudeCodeVersion: null,
      capsCache: null,
      commands: null,
      pump: null,
      closing: false,
      published: null,
      trusted: trusted === true,
      credentialsRejected: false,
    };
    const options = this.#queryOptions(live, mode, resumeSessionAt);
    try {
      live.query = this.#engine.query({ prompt: live.input, options });
    } catch (error) {
      const { code } = describeEngineFailure(error);
      this.#log.warn('engine could not start a session', { sessionId: id, code });
      throw code === 'ENGINE_UNAVAILABLE'
        ? new AppError(503, code, 'Claude Code is not available. Check its installation and sign-in.')
        : engineError('Claude Code could not start the session.');
    }
    this.#live.set(id, live);
    this.#remember(id, settings);
    live.pump = this.#pump(live);
    this.#sync(live);
    return live;
  }

  /**
   * Options of one query. Keys that do not apply are omitted instead of being set to undefined.
   * @param {LiveRecord} live
   * @param {'new'|'resume'} mode
   * @param {string|undefined} resumeSessionAt
   * @returns {SdkOptions}
   */
  #queryOptions(live, mode, resumeSessionAt) {
    const { claudeBin, allowBypass, version } = this.#config;
    return {
      cwd: live.cwd,
      abortController: live.abort,
      ...(mode === 'new' ? { sessionId: live.sessionId } : { resume: live.sessionId }),
      ...(mode === 'new' && live.title ? { title: live.title } : {}),
      ...(resumeSessionAt ? { resumeSessionAt } : {}),
      ...(live.model !== null ? { model: live.model } : {}),
      permissionMode: live.permissionMode,
      ...(live.effort !== null ? { effort: live.effort } : {}),
      allowDangerouslySkipPermissions: allowBypass,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      tools: { type: 'preset', preset: 'claude_code' },
      settingSources: live.trusted ? ['user', 'project', 'local'] : ['user'],
      includePartialMessages: true,
      includeHookEvents: true,
      promptSuggestions: true,
      agentProgressSummaries: true,
      enableFileCheckpointing: true,
      toolConfig: { askUserQuestion: { previewFormat: 'markdown' } },
      canUseTool: this.#canUseTool(live),
      onElicitation: this.#onElicitation(live),
      env: engineEnv(process.env, { clientApp: `claude-official-web/${version}` }),
      ...(typeof claudeBin === 'string' ? { pathToClaudeCodeExecutable: claudeBin } : {}),
      stderr: (data) => this.#log.debug('engine stderr', { bytes: data.length }),
    };
  }

  /**
   * Explicit arguments win over the settings remembered for the session, which win over the configured defaults.
   * @param {string|null} sessionId
   * @param {SessionSettings} args
   * @returns {{model: string|null, permissionMode: PermissionMode, effort: EffortLevel|null}}
   */
  #resolveSettings(sessionId, args) {
    const remembered = sessionId === null ? {} : this.#pending.get(sessionId) ?? {};
    const { defaults } = this.#config;
    /** @param {'model'|'permissionMode'|'effort'} key @param {unknown} fallback */
    const pick = (key, fallback) => {
      if (args[key] !== undefined) return args[key];
      if (remembered[key] !== undefined) return remembered[key];
      return fallback;
    };
    const resolved = {
      model: /** @type {string|null} */ (pick('model', defaults.model)),
      permissionMode: /** @type {PermissionMode} */ (pick('permissionMode', defaults.permissionMode)),
      effort: /** @type {EffortLevel|null} */ (pick('effort', defaults.effort)),
    };
    this.#assertBypassAllowed(resolved.permissionMode);
    return resolved;
  }

  /** @param {PermissionMode} mode */
  #assertBypassAllowed(mode) {
    if (mode === 'bypassPermissions' && !this.#config.allowBypass) {
      throw new AppError(501, 'FEATURE_DISABLED', 'Bypass permissions mode is disabled on this gateway.');
    }
  }

  /**
   * Remembers the settings that were requested explicitly, so the next start of the session keeps them.
   * @param {string} sessionId
   * @param {SessionSettings} settings
   */
  #remember(sessionId, settings) {
    if (Object.keys(settings).length === 0) return;
    const merged = { ...this.#pending.get(sessionId), ...settings };
    this.#pending.delete(sessionId);
    this.#pending.set(sessionId, merged);
    while (this.#pending.size > PENDING_SETTINGS_MAX) {
      this.#pending.delete(this.#pending.keys().next().value);
    }
  }

  /**
   * Makes room for one more live query by closing the least recently active idle session without pending requests.
   * @throws {AppError} 429 TOO_MANY_SESSIONS when every live session is busy
   */
  #makeRoom() {
    if (this.#live.size < this.#config.maxLiveSessions) return;
    /** @type {LiveRecord|null} */
    let victim = null;
    for (const live of this.#live.values()) {
      if (live.state !== 'idle' || this.#requests.count(live.sessionId) > 0) continue;
      if (this.#opening.has(live.sessionId)) continue;
      if (victim === null || live.lastActivity < victim.lastActivity) victim = live;
    }
    if (victim === null) {
      throw new AppError(429, 'TOO_MANY_SESSIONS', 'Too many sessions are running. Stop one and try again.');
    }
    this.#log.info('closing the least recently used idle session', { sessionId: victim.sessionId });
    void this.#detach(victim, { publish: true });
  }

  /**
   * Returns the live query of a session, starting it when needed. Concurrent callers share one start.
   * @param {string} sessionId
   * @param {SessionSettings} [settings]
   * @returns {Promise<LiveRecord>}
   */
  #ensureLive(sessionId, settings = {}) {
    const live = this.#live.get(sessionId);
    if (live && !this.#opening.has(sessionId)) return Promise.resolve(live);
    return this.#exclusive(sessionId, async () => {
      return this.#live.get(sessionId) ?? this.#resumeLive(sessionId, settings);
    });
  }

  /**
   * Starts the query of a session that is not open. Runs inside the session's lifecycle queue.
   * @param {string} sessionId
   * @param {SessionSettings} settings
   * @returns {Promise<LiveRecord>}
   */
  async #resumeLive(sessionId, settings) {
    this.#assertNotLocked(sessionId);
    const info = await this.#readInfo(sessionId);
    if (!info) throw sessionNotFound();
    await this.#assertResumable(info);
    this.#assertNotLocked(sessionId);
    const existing = this.#live.get(sessionId);
    if (existing) return existing;
    const trusted = await this.#trustOf(info.cwd);
    this.#assertNotLocked(sessionId);
    return this.#startQuery({ mode: 'resume', sessionId, cwd: info.cwd, trusted, settings });
  }

  /** @param {string} sessionId */
  #assertNotLocked(sessionId) {
    if (this.#locks.has(sessionId)) throw sessionLocked();
  }

  /**
   * A session whose folder is outside the workspace roots does not exist for the gateway.
   * @param {SDKSessionInfo} info
   */
  async #assertResumable(info) {
    if (!(await this.#withinRoots(info.cwd))) throw sessionNotFound();
  }

  /**
   * @param {string} sessionId
   * @returns {LiveRecord}
   */
  #requireLive(sessionId) {
    const live = this.#live.get(sessionId);
    if (!live) throw sessionNotLive();
    return live;
  }

  /**
   * Reads the SDK messages of one query until it ends. Never rejects: the outcome is handled by #finish.
   * @param {LiveRecord} live
   * @returns {Promise<void>}
   */
  async #pump(live) {
    let failed = false;
    /** @type {unknown} */
    let failure;
    try {
      for await (const msg of live.query) this.#onMessage(live, msg);
    } catch (error) {
      failed = true;
      failure = error;
    }
    this.#finish(live, failed, failure);
  }

  /**
   * @param {LiveRecord} live
   * @param {SDKMessage} msg
   */
  #onMessage(live, msg) {
    this.#applyMessage(live, msg);
    const seq = this.#publish({ type: 'sdk', sessionId: live.sessionId, data: { sessionId: live.sessionId, msg } });
    live.events.push(seq, msg);
    this.#sync(live);
    if (isCredentialFailure(msg)) this.#rejectCredentials(live);
  }

  /**
   * The runtime rejected its credentials. The session carries the error, and one notice is published per query.
   * The query itself is left alone: the user fixes the login and reopens the session.
   * @param {LiveRecord} live
   */
  #rejectCredentials(live) {
    if (live.credentialsRejected || live.closing) return;
    live.credentialsRejected = true;
    live.error = { code: 'ENGINE_UNAVAILABLE', message: CREDENTIALS_MESSAGE };
    this.#log.warn('the runtime rejected its credentials', { sessionId: live.sessionId });
    this.#publish({
      type: 'notice',
      sessionId: live.sessionId,
      data: { sessionId: live.sessionId, level: 'error', code: 'ENGINE_UNAVAILABLE', message: CREDENTIALS_MESSAGE },
    });
    this.#sync(live);
  }

  /**
   * Keeps the LiveInfo fields in step with the messages the query produces.
   * @param {LiveRecord} live
   * @param {SDKMessage} msg
   */
  #applyMessage(live, msg) {
    switch (msg.type) {
      case 'system':
        this.#applySystemMessage(live, msg);
        return;
      case 'result':
        if (!live.closing && this.#requests.count(live.sessionId) === 0) live.state = 'idle';
        return;
      case 'assistant':
      case 'stream_event':
      case 'user':
        live.lastActivity = this.#now();
        return;
      default:
        return;
    }
  }

  /**
   * @param {LiveRecord} live
   * @param {Extract<SDKMessage, {type: 'system'}>} msg
   */
  #applySystemMessage(live, msg) {
    switch (msg.subtype) {
      case 'init':
        live.init = msg;
        live.model = msg.model ?? live.model;
        live.permissionMode = msg.permissionMode;
        live.effort = msg.effort ?? live.effort;
        live.claudeCodeVersion = msg.claude_code_version;
        if (msg.claude_code_version) this.#lastClaudeCodeVersion = msg.claude_code_version;
        if (live.state === 'starting') live.state = 'idle';
        return;
      case 'session_state_changed':
        if (!live.closing) {
          const waiting = msg.state === 'idle' && this.#requests.count(live.sessionId) > 0;
          live.state = waiting ? 'requires_action' : msg.state;
        }
        return;
      case 'status':
        if (msg.permissionMode) live.permissionMode = msg.permissionMode;
        return;
      case 'commands_changed':
        live.commands = msg.commands;
        if (live.capsCache) {
          live.capsCache = { ...live.capsCache, value: { ...live.capsCache.value, commands: msg.commands } };
        }
        return;
      default:
        return;
    }
  }

  /**
   * Runs when a query ends for any reason: removes its record, cancels its requests and reports real failures.
   * A query the gateway closed on purpose is never reported.
   * @param {LiveRecord} live
   * @param {boolean} failed
   * @param {unknown} failure
   */
  #finish(live, failed, failure) {
    const current = this.#live.get(live.sessionId) === live;
    if (current) this.#live.delete(live.sessionId);
    live.state = 'closing';
    // Ending the input lets sendMessage see that a query which ended by itself no longer takes messages.
    live.input.end();
    // A query that was replaced has already cancelled its requests; the session id may belong to the new query now.
    if (current) this.#requests.cancelSession(live.sessionId);
    if (failed && !live.closing) this.#reportFailure(live, failure);
    if (current) this.#publish({ type: 'session_state', data: { sessionId: live.sessionId, live: null } });
  }

  /**
   * @param {LiveRecord} live
   * @param {unknown} failure
   */
  #reportFailure(live, failure) {
    const { code, message } = describeEngineFailure(failure);
    live.error = { code, message };
    this.#log.warn('session stopped with an error', { sessionId: live.sessionId, code });
    this.#publish({
      type: 'notice',
      sessionId: live.sessionId,
      data: { sessionId: live.sessionId, level: 'error', code, message },
    });
  }

  /**
   * Stops a query on purpose. The record is removed before the first await; the pump gets up to CLOSE_WAIT_MS to
   * finish so that the session file is no longer written when this resolves.
   * @param {LiveRecord} live
   * @param {{publish: boolean}} options
   * @returns {Promise<void>}
   */
  async #detach(live, { publish }) {
    const removed = this.#live.get(live.sessionId) === live;
    if (removed) this.#live.delete(live.sessionId);
    live.closing = true;
    live.state = 'closing';
    this.#requests.cancelSession(live.sessionId);
    live.input.end();
    try {
      live.query?.close();
    } catch (error) {
      this.#log.debug('closing a query failed', { sessionId: live.sessionId, reason: errorName(error) });
    }
    live.abort.abort();
    if (publish && removed) this.#publish({ type: 'session_state', data: { sessionId: live.sessionId, live: null } });
    await settleWithin(live.pump ?? Promise.resolve(), CLOSE_WAIT_MS);
  }

  /**
   * Publishes the LiveInfo of a session when anything other than lastActivity changed.
   * @param {LiveRecord} live
   */
  #sync(live) {
    if (this.#live.get(live.sessionId) !== live) return;
    const info = this.#info(live);
    const key = JSON.stringify({ ...info, lastActivity: 0 });
    if (key === live.published) return;
    live.published = key;
    this.#publish({ type: 'session_state', data: { live: info } });
  }

  /** @param {string} sessionId */
  #syncSession(sessionId) {
    const live = this.#live.get(sessionId);
    if (live) this.#sync(live);
  }

  /**
   * @param {LiveRecord} live
   * @param {LiveState} state
   */
  #setState(live, state) {
    if (this.#live.get(live.sessionId) !== live || live.closing) return;
    live.state = state;
    this.#sync(live);
  }

  /**
   * @param {string} reason
   * @param {string} sessionId
   */
  #publishSessionsChanged(reason, sessionId) {
    this.#publish({ type: 'sessions_changed', data: { reason, sessionId } });
  }

  /**
   * Permission callback of one query. Questions and plan approvals are requests of their own kind.
   * @param {LiveRecord} live
   * @returns {CanUseTool}
   */
  #canUseTool(live) {
    return async (toolName, input, options) => {
      const kind = toolName === 'AskUserQuestion' ? 'question' : toolName === 'ExitPlanMode' ? 'plan' : 'permission';
      const request = this.#pendingRequest(live, kind, options, { toolName, input });
      const outcome = await this.#awaitRequest(live, request, options.signal);
      const result = toPermissionResult(request, outcome);
      if (kind === 'plan' && 'body' in outcome && outcome.body.decision === 'approve' && outcome.body.nextMode) {
        const nextMode = /** @type {PermissionMode} */ (outcome.body.nextMode);
        setImmediate(() => {
          void this.#applyPlanMode(live, nextMode);
        });
      }
      return result;
    };
  }

  /**
   * @param {LiveRecord} live
   * @returns {OnElicitation}
   */
  #onElicitation(live) {
    return async (elicitation, options) => {
      const request = this.#elicitationRequest(live, elicitation, options);
      const outcome = await this.#awaitRequest(live, request, options.signal);
      return toElicitationResult(outcome);
    };
  }

  /**
   * @param {LiveRecord} live
   * @param {'permission'|'question'|'plan'} kind
   * @param {Parameters<CanUseTool>[2]} options
   * @param {{toolName: string, input: Record<string, unknown>}} fields
   * @returns {PendingRequest}
   */
  #pendingRequest(live, kind, options, { toolName, input }) {
    return /** @type {PendingRequest} */ (omitUndefined({
      id: this.#requestId(live.sessionId, options.requestId),
      sessionId: live.sessionId,
      kind,
      createdAt: this.#now(),
      toolName,
      toolUseId: options.toolUseID,
      agentId: options.agentID,
      input,
      title: options.title,
      displayName: options.displayName,
      description: options.description,
      decisionReason: options.decisionReason,
      blockedPath: options.blockedPath,
      suggestions: options.suggestions,
      suppressAlwaysAllowRule: options.suppressAlwaysAllowRule,
      defaultToNo: options.defaultToNo,
      mcpServer: options.mcpServer,
    }));
  }

  /**
   * @param {LiveRecord} live
   * @param {import('@anthropic-ai/claude-agent-sdk').ElicitationRequest} elicitation
   * @param {{requestId: string}} options
   * @returns {PendingRequest}
   */
  #elicitationRequest(live, elicitation, options) {
    return /** @type {PendingRequest} */ (omitUndefined({
      id: this.#requestId(live.sessionId, options.requestId),
      sessionId: live.sessionId,
      kind: 'elicitation',
      createdAt: this.#now(),
      elicitation,
      title: elicitation.title,
      displayName: elicitation.displayName,
      description: elicitation.description,
    }));
  }

  /**
   * Holds the query until the browser answers, the SDK aborts the request, or the session closes. While the request
   * waits the session reports requires_action.
   * @param {LiveRecord} live
   * @param {PendingRequest} request
   * @param {AbortSignal} signal
   */
  async #awaitRequest(live, request, signal) {
    this.#setState(live, 'requires_action');
    const outcome = await this.#requests.create(request, signal);
    if (this.#requests.count(live.sessionId) === 0) this.#setState(live, 'running');
    return outcome;
  }

  /**
   * The SDK's request id is kept when it is usable and not pending already; otherwise a fresh id is used.
   * @param {string} sessionId
   * @param {unknown} candidate
   * @returns {string}
   */
  #requestId(sessionId, candidate) {
    if (typeof candidate === 'string' && candidate !== ''
      && candidate.length <= ID_MAX && !this.#requests.has(sessionId, candidate)) {
      return candidate;
    }
    return randomUUID();
  }

  /**
   * Applies the mode a plan approval asked for. It runs after the approval has been answered to the SDK.
   * @param {LiveRecord} live
   * @param {PermissionMode} nextMode
   */
  async #applyPlanMode(live, nextMode) {
    if (this.#live.get(live.sessionId) !== live || live.closing || !live.query) return;
    try {
      await withTimeout(() => live.query.setPermissionMode(nextMode));
      live.permissionMode = nextMode;
      this.#sync(live);
    } catch (error) {
      this.#log.warn('could not apply the mode chosen with the plan', {
        sessionId: live.sessionId,
        reason: errorName(error),
      });
    }
  }

  /** @param {string} clientMessageId @returns {boolean} */
  #isDuplicateMessage(clientMessageId) {
    this.#pruneMessageIds();
    return this.#messageIds.has(clientMessageId);
  }

  /** @param {string} clientMessageId */
  #reserveMessageId(clientMessageId) {
    this.#messageIds.set(clientMessageId, this.#now());
    while (this.#messageIds.size > CLIENT_MESSAGE_MAX) {
      this.#messageIds.delete(this.#messageIds.keys().next().value);
    }
  }

  #pruneMessageIds() {
    const cutoff = this.#now() - CLIENT_MESSAGE_TTL_MS;
    for (const [id, at] of this.#messageIds) {
      if (at > cutoff) break;
      this.#messageIds.delete(id);
    }
  }

  /**
   * Logs an engine failure without any content and returns the safe error to report.
   * @param {string} sessionId
   * @param {unknown} error
   * @param {string} message
   * @returns {AppError}
   */
  #failure(sessionId, error, message) {
    this.#log.warn('engine call failed', { sessionId, reason: errorName(error) });
    return engineError(error instanceof ControlTimeout ? TIMEOUT_MESSAGE : message);
  }

  /**
   * Runs one control call of the runtime under the control timeout. A timeout answers with its own safe message.
   * @template T
   * @param {string} sessionId
   * @param {() => Promise<T>} call
   * @param {string} message  the safe message for any other failure
   * @returns {Promise<T>}
   */
  async #control(sessionId, call, message) {
    try {
      return await withTimeout(call);
    } catch (error) {
      throw this.#failure(sessionId, error, message);
    }
  }

  /**
   * Runs one engine call whose result is not needed.
   * @param {string} sessionId
   * @param {() => Promise<unknown>} call
   * @param {string} message
   */
  async #engineCall(sessionId, call, message) {
    try {
      await call();
    } catch (error) {
      throw this.#failure(sessionId, error, message);
    }
  }

  /**
   * Starts a new live session with a gateway-assigned id. The caller has validated the working directory.
   * @param {{cwd: string, title?: string} & SessionSettings} options
   * @returns {Promise<LiveInfo>}
   */
  async createSession({ cwd, title, model, permissionMode, effort }) {
    if (typeof cwd !== 'string' || cwd === '') throw badRequest('The cwd must be a path.');
    const settings = parseSettings({ model, permissionMode, effort });
    const titleText = title === undefined ? '' : parseText(title, 'title', TITLE_MAX);
    if (!(await this.#withinRoots(cwd))) throw outsideRoots();
    const trusted = await this.#trustOf(cwd);
    const live = this.#startQuery({
      mode: 'new',
      sessionId: null,
      cwd,
      trusted,
      title: titleText || undefined,
      settings,
    });
    this.#publishSessionsChanged('created', live.sessionId);
    return this.#info(live);
  }

  /**
   * Opens a session in a live query. When it is already open, the settings are applied to that query instead.
   * @param {string} sessionId
   * @param {SessionSettings} [settings]
   * @returns {Promise<LiveInfo>}
   */
  async openSession(sessionId, settings) {
    requireSessionId(sessionId);
    const parsed = parseSettings(settings);
    if (parsed.permissionMode !== undefined) this.#assertBypassAllowed(parsed.permissionMode);
    this.#assertNotLocked(sessionId);
    // Registered at once, so a close or lock that is requested after this open waits for it.
    const live = await this.#exclusive(sessionId, async () => {
      const current = this.#live.get(sessionId);
      if (!current) return this.#resumeLive(sessionId, parsed);
      await this.#applySettings(current, parsed);
      return current;
    });
    return this.#info(live);
  }

  /**
   * Closes the live query of a session. Pending requests are cancelled. Closing a session that is not open is a no-op.
   * @param {string} sessionId
   */
  async closeSession(sessionId) {
    requireSessionId(sessionId);
    await this.#exclusive(sessionId, async () => {
      const live = this.#live.get(sessionId);
      if (live) await this.#detach(live, { publish: true });
    });
  }

  /**
   * Queues a user message on the live query, opening the session first when needed. A clientMessageId seen within
   * the last 10 minutes is accepted without being sent again.
   * @param {string} sessionId
   * @param {{clientMessageId: string, text: string, images?: Array<{mediaType: string, data: string}>}} message
   * @returns {Promise<{accepted: true, duplicate: boolean}>}
   */
  async sendMessage(sessionId, message) {
    requireSessionId(sessionId);
    const { clientMessageId, text, images } = parseMessage(message);
    this.#assertNotLocked(sessionId);
    if (this.#isDuplicateMessage(clientMessageId)) return { accepted: true, duplicate: true };
    this.#reserveMessageId(clientMessageId);
    try {
      const live = await this.#ensureLive(sessionId);
      if (live.input.ended) {
        throw new AppError(409, 'SESSION_NOT_LIVE', 'The session stopped. Send the message again.');
      }
      live.input.push(buildUserMessage(live.sessionId, clientMessageId, text, images));
      if (this.#requests.count(live.sessionId) === 0) this.#setState(live, 'running');
    } catch (error) {
      this.#messageIds.delete(clientMessageId);
      throw error;
    }
    this.#publish({ type: 'message_accepted', data: { sessionId, clientMessageId } });
    return { accepted: true, duplicate: false };
  }

  /**
   * Interrupts the running turn. Not open means nothing is running, so it is a no-op.
   * @param {string} sessionId
   */
  async interrupt(sessionId) {
    requireSessionId(sessionId);
    const live = this.#live.get(sessionId);
    if (!live) return;
    await this.#control(sessionId, () => live.query.interrupt(), 'The turn could not be interrupted.');
  }

  /**
   * Applies the given settings to the live query and remembers them for the next start. Settings of a session that
   * is not open are only remembered.
   * @param {string} sessionId
   * @param {SessionSettings} settings
   * @returns {Promise<LiveInfo|null>}
   */
  async updateSettings(sessionId, settings) {
    requireSessionId(sessionId);
    const parsed = parseSettings(settings);
    if (parsed.permissionMode !== undefined) this.#assertBypassAllowed(parsed.permissionMode);
    await this.#settled(sessionId);
    const live = this.#live.get(sessionId);
    if (!live) {
      await this.#scopeOf(sessionId, true);
      this.#remember(sessionId, parsed);
      return null;
    }
    return this.#applySettings(live, parsed);
  }

  /**
   * Applies settings to a live query and remembers them. Runs inside the session's lifecycle queue, or after it.
   * @param {LiveRecord} live
   * @param {SessionSettings} parsed
   * @returns {Promise<LiveInfo>}
   */
  async #applySettings(live, parsed) {
    const { sessionId } = live;
    if (parsed.model !== undefined) {
      const model = parsed.model;
      await this.#control(sessionId, () => live.query.setModel(model ?? undefined),
        'The model could not be changed.');
      live.model = model;
      this.#remember(sessionId, { model });
      this.#sync(live);
    }
    if (parsed.permissionMode !== undefined) {
      const mode = parsed.permissionMode;
      await this.#control(sessionId, () => live.query.setPermissionMode(mode),
        'The permission mode could not be changed.');
      live.permissionMode = mode;
      this.#remember(sessionId, { permissionMode: mode });
      this.#sync(live);
    }
    if (parsed.effort !== undefined) {
      const effort = parsed.effort;
      await this.#control(sessionId, () => live.query.applyFlagSettings({ effortLevel: effort }),
        'The effort level could not be changed.');
      live.effort = effort;
      this.#remember(sessionId, { effort });
      this.#sync(live);
    }
    return this.#info(live);
  }

  /**
   * Answers a pending request. Validation happens in the registry; an invalid answer leaves the request pending.
   * @param {string} sessionId
   * @param {string} requestId
   * @param {Record<string, unknown>} body
   */
  async respond(sessionId, requestId, body) {
    requireSessionId(sessionId);
    this.#requests.respond(sessionId, parseToken(requestId, 'The request id'), body);
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<import('../contracts.mjs').ContextUsage>}
   */
  async getContextUsage(sessionId) {
    requireSessionId(sessionId);
    const live = this.#requireLive(sessionId);
    return this.#control(sessionId, () => live.query.getContextUsage({ detail: 'summary' }),
      'The context usage could not be read.');
  }

  /**
   * Toggles or reconnects one MCP server of a live session and returns the status of all servers.
   * @param {string} sessionId
   * @param {string} server
   * @param {{action: 'toggle'|'reconnect', enabled?: boolean}} action
   * @returns {Promise<McpServerStatus[]>}
   */
  async mcpAction(sessionId, server, action) {
    requireSessionId(sessionId);
    const name = parseToken(server, 'The server name');
    const { kind, enabled } = parseMcpAction(action);
    const live = this.#requireLive(sessionId);
    await this.#control(sessionId, () => (kind === 'toggle'
      ? live.query.toggleMcpServer(name, enabled)
      : live.query.reconnectMcpServer(name)), 'The MCP server could not be updated.');
    live.capsCache = null;
    return this.#control(sessionId, () => live.query.mcpServerStatus(),
      'The MCP server status could not be read.');
  }

  /**
   * Reloads plugins or skills of a live session.
   * @param {string} sessionId
   * @param {'plugins'|'skills'} what
   */
  async reload(sessionId, what) {
    requireSessionId(sessionId);
    if (what !== 'plugins' && what !== 'skills') throw invalid('The reload target must be plugins or skills.');
    const live = this.#requireLive(sessionId);
    /** @type {() => Promise<unknown>} */
    const reload = () => (what === 'plugins' ? live.query.reloadPlugins() : live.query.reloadSkills());
    await this.#control(sessionId, reload, 'The session could not be reloaded.');
    live.capsCache = null;
  }

  /**
   * Rewinds the files, the conversation, or both to just before a user message. Every check runs before any change,
   * so a refused rewind leaves the session untouched. `dryRun` never changes anything. A rewind that changes state
   * runs in the session's lifecycle queue, so sends and opens that arrive meanwhile wait for the restarted query.
   * @param {string} sessionId
   * @param {{userMessageId: string, mode: 'code'|'conversation'|'both', dryRun?: boolean}} options
   * @returns {Promise<{files?: RewindFilesResult, conversation?: {resumeAt: string}}>}
   */
  async rewind(sessionId, { userMessageId, mode, dryRun }) {
    requireSessionId(sessionId);
    const messageId = parseToken(userMessageId, 'The message id');
    if (!includes(REWIND_MODES, mode)) throw invalid('The rewind mode must be code, conversation or both.');
    if (dryRun !== undefined && typeof dryRun !== 'boolean') throw badRequest('dryRun must be a boolean.');
    this.#assertNotLocked(sessionId);
    if (dryRun === true) return this.#previewRewind(sessionId, messageId, mode);
    return this.#exclusive(sessionId, () => this.#applyRewind(sessionId, messageId, mode));
  }

  /**
   * The outcome of a rewind without changing anything. The query is opened when it is not live yet.
   * @param {string} sessionId
   * @param {string} messageId
   * @param {'code'|'conversation'|'both'} mode
   * @returns {Promise<{files?: RewindFilesResult, conversation?: {resumeAt: string}}>}
   */
  async #previewRewind(sessionId, messageId, mode) {
    const { info } = await this.#scopeOf(sessionId);
    const resumeAt = mode === 'code' ? undefined : await this.#rewindTarget(sessionId, messageId, info);
    /** @type {{files?: RewindFilesResult, conversation?: {resumeAt: string}}} */
    const result = {};
    if (mode !== 'conversation') {
      const live = await this.#ensureLive(sessionId);
      result.files = await this.#rewindFiles(live, messageId, true);
    }
    if (mode !== 'code') result.conversation = { resumeAt };
    return result;
  }

  /**
   * A rewind that changes state. Runs inside the session's lifecycle queue: the files are rewound first, then the
   * conversation restarts at the entry before the message.
   * @param {string} sessionId
   * @param {string} messageId
   * @param {'code'|'conversation'|'both'} mode
   * @returns {Promise<{files?: RewindFilesResult, conversation?: {resumeAt: string}}>}
   */
  async #applyRewind(sessionId, messageId, mode) {
    this.#assertNotLocked(sessionId);
    const { info } = await this.#scopeOf(sessionId);
    const resumeAt = mode === 'code' ? undefined : await this.#rewindTarget(sessionId, messageId, info);
    /** @type {{files?: RewindFilesResult, conversation?: {resumeAt: string}}} */
    const result = {};
    if (mode !== 'conversation') {
      const live = this.#live.get(sessionId) ?? await this.#resumeLive(sessionId, {});
      result.files = await this.#rewindFiles(live, messageId, false);
    }
    if (mode !== 'code') {
      await this.#restartNow(sessionId, resumeAt);
      result.conversation = { resumeAt };
      this.#publishSessionsChanged('rewind', sessionId);
    }
    return result;
  }

  /**
   * Rewinds the files to just before a message. A refused rewind changes nothing.
   * @param {LiveRecord} live
   * @param {string} messageId
   * @param {boolean} preview
   * @returns {Promise<RewindFilesResult>}
   */
  async #rewindFiles(live, messageId, preview) {
    const files = await this.#control(live.sessionId,
      () => live.query.rewindFiles(messageId, { dryRun: preview }), 'The files could not be rewound.');
    if (!files.canRewind && !preview) {
      throw cannotRewind(firstLine(files.error, 'The files cannot be rewound to this message.'));
    }
    return files;
  }

  /**
   * The transcript entry just before the target message, which is where a conversation rewind resumes.
   * @param {string} sessionId
   * @param {string} messageId
   * @param {SDKSessionInfo|null} info
   * @returns {Promise<string>}
   */
  async #rewindTarget(sessionId, messageId, info) {
    const transcript = await this.#transcript(sessionId, info);
    const index = transcript.findIndex((message) => message.uuid === messageId);
    if (index < 1 || transcript[index].type !== 'user') throw cannotRewind('This message cannot be rewound to.');
    return transcript[index - 1].uuid;
  }

  /**
   * Stops the live query of a session, if any, and starts it again at an earlier entry of the conversation. The
   * stop is not reported as the end of the session, and the old query is fully stopped before the new one starts.
   * Runs inside the session's lifecycle queue, so it never waits for the session again.
   * @param {string} sessionId
   * @param {string} resumeAt
   */
  async #restartNow(sessionId, resumeAt) {
    const previous = this.#live.get(sessionId);
    /** @type {string} */
    let cwd;
    /** @type {SessionSettings} */
    let settings = {};
    if (previous) {
      cwd = previous.cwd;
      settings = { model: previous.model, permissionMode: previous.permissionMode, effort: previous.effort };
      await this.#detach(previous, { publish: false });
    } else {
      const { info } = await this.#scopeOf(sessionId);
      cwd = /** @type {string} */ (info?.cwd);
    }
    this.#assertNotLocked(sessionId);
    const trusted = await this.#trustOf(cwd);
    this.#assertNotLocked(sessionId);
    this.#startQuery({ mode: 'resume', sessionId, cwd, trusted, settings, resumeSessionAt: resumeAt });
  }

  /**
   * Forks a session into a new one, optionally up to a message.
   * @param {string} sessionId
   * @param {{upToMessageId?: string, title?: string}} [options]
   * @returns {Promise<{sessionId: string}>}
   */
  async fork(sessionId, { upToMessageId, title } = {}) {
    requireSessionId(sessionId);
    const upTo = upToMessageId === undefined ? undefined : parseToken(upToMessageId, 'The message id');
    const titleText = title === undefined ? undefined : parseText(title, 'title', TITLE_MAX) || undefined;
    const { info } = await this.#scopeOf(sessionId);
    if (!info) throw sessionNotFound();
    /** @type {import('@anthropic-ai/claude-agent-sdk').ForkSessionResult} */
    let forked;
    try {
      forked = await this.#engine.forkSession(sessionId, omitUndefined({ upToMessageId: upTo, title: titleText }));
    } catch (error) {
      throw this.#failure(sessionId, error, 'Claude Code could not fork the session.');
    }
    this.#publishSessionsChanged('fork', forked.sessionId);
    return { sessionId: forked.sessionId };
  }

  /**
   * Renames a session. A live session takes the new title at once.
   * @param {string} sessionId
   * @param {string} title
   */
  async rename(sessionId, title) {
    requireSessionId(sessionId);
    const text = parseText(title, 'title', TITLE_MAX);
    if (text === '') throw invalid('The title must not be empty.');
    const { info, live } = await this.#scopeOf(sessionId);
    if (info) {
      await this.#engineCall(sessionId, () => this.#engine.renameSession(sessionId, text),
        'The session could not be renamed.');
    }
    if (live) {
      live.title = text;
      this.#sync(live);
    }
    this.#publishSessionsChanged('renamed', sessionId);
  }

  /**
   * Sets or clears the tag of a session. An empty tag clears it.
   * @param {string} sessionId
   * @param {string|null} tag
   */
  async tag(sessionId, tag) {
    requireSessionId(sessionId);
    const value = tag === null ? null : parseText(tag, 'tag', TAG_MAX) || null;
    const { info } = await this.#scopeOf(sessionId);
    if (info) {
      await this.#engineCall(sessionId, () => this.#engine.tagSession(sessionId, value),
        'The session could not be tagged.');
    }
    this.#publishSessionsChanged('tagged', sessionId);
  }

  /**
   * Deletes a session file. Open or terminal-held sessions cannot be deleted.
   * @param {string} sessionId
   */
  async deleteSession(sessionId) {
    requireSessionId(sessionId);
    await this.#scopeOf(sessionId);
    this.#assertNotLocked(sessionId);
    if (this.#live.has(sessionId) || this.#opening.has(sessionId)) {
      throw new AppError(409, 'CONFLICT', 'Close the session before deleting it.');
    }
    // Registered before the first await, so no send or open can start a query on the file while it is removed.
    await this.#exclusive(sessionId, () => this.#engineCall(sessionId, () => this.#engine.deleteSession(sessionId),
      'The session could not be deleted.'));
    this.#transcripts.delete(sessionId);
    this.#pending.delete(sessionId);
    this.#publishSessionsChanged('deleted', sessionId);
  }

  /**
   * @param {string} sessionId
   * @param {string} taskId
   */
  async stopTask(sessionId, taskId) {
    requireSessionId(sessionId);
    const id = parseToken(taskId, 'The task id');
    const live = this.#requireLive(sessionId);
    await this.#control(sessionId, () => live.query.stopTask(id), 'The task could not be stopped.');
  }

  /** @param {string} sessionId @returns {Promise<string[]>} */
  async listSubagents(sessionId) {
    requireSessionId(sessionId);
    await this.#scopeOf(sessionId);
    try {
      return await this.#engine.listSubagents(sessionId);
    } catch (error) {
      throw this.#failure(sessionId, error, 'The subagents could not be listed.');
    }
  }

  /**
   * @param {string} sessionId
   * @param {string} agentId
   * @returns {Promise<SessionMessage[]>}
   */
  async getSubagentMessages(sessionId, agentId) {
    requireSessionId(sessionId);
    const id = parseToken(agentId, 'The agent id');
    await this.#scopeOf(sessionId);
    try {
      return await this.#engine.getSubagentMessages(sessionId, id);
    } catch (error) {
      throw this.#failure(sessionId, error, 'The subagent messages could not be read.');
    }
  }

  /**
   * Gives the terminal exclusive use of a session. The live query is closed, and no query starts for the session until
   * the returned release function runs. Release is idempotent.
   * @param {string} sessionId
   * @returns {Promise<() => void>}
   */
  async lockForTerminal(sessionId) {
    requireSessionId(sessionId);
    this.#assertNotLocked(sessionId);
    return this.#exclusive(sessionId, async () => {
      await this.#scopeOf(sessionId, true);
      this.#assertNotLocked(sessionId);
      const token = Symbol(sessionId);
      this.#locks.set(sessionId, token);
      const live = this.#live.get(sessionId);
      if (live) await this.#detach(live, { publish: true });
      return () => {
        if (this.#locks.get(sessionId) === token) this.#locks.delete(sessionId);
      };
    });
  }

  /**
   * Closes live sessions that have been idle, without pending requests, for longer than the idle timeout.
   * @param {number} [now]
   * @returns {Promise<number>} how many sessions were closed
   */
  async sweepIdle(now = this.#now()) {
    const timeout = this.#config.idleTimeoutMs;
    const idle = [...this.#live.values()].filter((live) => live.state === 'idle'
      && this.#requests.count(live.sessionId) === 0
      && !this.#opening.has(live.sessionId)
      && now - live.lastActivity > timeout);
    await Promise.all(idle.map((live) => this.#detach(live, { publish: true })));
    if (idle.length > 0) this.#log.info('closed idle sessions', { count: idle.length });
    return idle.length;
  }

  /** Stops the sweep, closes every live query and cancels every pending request. Safe to call twice. */
  async shutdown() {
    clearInterval(this.#sweepTimer);
    this.#stopped = true;
    this.#requests.cancelAll();
    await Promise.all([...this.#live.values()].map((live) => this.#detach(live, { publish: true })));
  }
}
