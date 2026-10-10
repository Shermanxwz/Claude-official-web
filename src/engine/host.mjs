// @ts-check
/**
 * EngineHost: owns one live Claude Agent SDK query per open session, the pending interactive requests of those
 * queries, the bounded event ring of each query, and the session-file operations the gateway exposes. The SDK
 * itself is reached only through the EngineAdapter injected by src/server.mjs.
 */

import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  AppError, BROWSER_MCP_SERVER, DIALOG_KINDS, EFFORT_LEVELS, PERMISSION_MODES, RUNTIME_VIEWS, isUuid,
} from '../contracts.mjs';
import { AsyncQueue } from './queue.mjs';
import {
  RequestRegistry, refusalDialogOf, toDialogResult, toElicitationResult, toPermissionResult,
} from './requests.mjs';
import { engineEnv } from './env.mjs';
import { createRuntimeTrust } from './trust.mjs';
import {
  ControlTimeout, MEMORY_MAX_BYTES, TIMEOUT_MESSAGE, availableViews, exportFilename, fileSuggestionsOf, firstLine,
  interruptReceipt, isEditableMemoryFile, isPlainObject, isWebUrl, listedMemoryFiles, redactMcpServers, redactView,
  runtimeMethod, sameDirectory, viewArguments, withTimeout, writeMemoryFile,
} from './runtime-views.mjs';
import {
  applyWindow, countAfterCompaction, emptyContextMeter, endCompaction, estimateAfterCompaction, fillUsed,
  isCompactPrompt, isNewerCall, isSubagentMessage, observeUsage, postTokensOf, recordCompaction, snapshotContextMeter,
  startCompaction, transcriptContextOf, usageTokens,
} from './context-meter.mjs';

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
/** @typedef {import('../contracts.mjs').ReloadResult} ReloadResult */
/** @typedef {import('../contracts.mjs').SessionSummary} SessionSummary */
/** @typedef {import('../contracts.mjs').SessionDetail} SessionDetail */
/** @typedef {import('../contracts.mjs').Capabilities} Capabilities */
/** @typedef {import('../contracts.mjs').SdkQuery} SdkQuery */
/** @typedef {import('../contracts.mjs').SdkOptions} SdkOptions */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SDKMessage} SDKMessage */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SDKUserMessage} SDKUserMessage */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SDKSystemMessage} SDKSystemMessage */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SDKStatusMessage} SDKStatusMessage */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SDKCompactBoundaryMessage} SDKCompactBoundaryMessage */
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
/** @typedef {import('../contracts.mjs').RuntimeTrust} RuntimeTrust */
/** @typedef {import('../contracts.mjs').MemoryFile} MemoryFile */
/** @typedef {import('../contracts.mjs').ContextUsage} ContextUsage */
/** @typedef {import('../contracts.mjs').ContextMeter} ContextMeter */
/** @typedef {import('./context-meter.mjs').CallUsage} CallUsage */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').McpServerConfig} McpServerConfig */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').OnUserDialog} OnUserDialog */
/** @typedef {ReturnType<typeof sideAnswerOf>} SideAnswer */

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
/** The settings lookup that decides the thinking-summary overlay gives up after this long and adds the overlay. */
const SETTINGS_LOOKUP_MS = 2000;
/** How long a starting session waits for the initialize handshake before it stops waiting (see #awaitReady). */
const READY_WAIT_MS = 60_000;
const RELOAD_TARGETS = ['plugins', 'skills', 'output-styles'];
const LSP_TOOL_CHANGES = ['adds', 'may-add', 'removes', 'may-remove'];
const FAST_MODE_STATES = ['off', 'cooldown', 'on'];
const CACHE_IMPACT_MAX = 50;
const CACHE_IMPACT_NAME_MAX = 200;
const OUTPUT_STYLE_MAX = 100;
const BACKGROUND_DISABLED_MESSAGE = 'Background tasks are disabled for this runtime.';
const CREDENTIALS_MESSAGE = 'Claude Code credentials were rejected. Log in again on the server: run `claude` and use '
  + '/login.';
/** Errors of the authentication class: the runtime's credentials were rejected. Billing and rate limits are not. */
const AUTH_ERRORS = ['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required'];
const AGENT_MAX = 200;
const WEB_PROTOCOLS = ['http:', 'https:'];
const ADDITIONAL_DIRECTORIES_MAX = 20;
const SIDE_QUESTION_MAX = 4000;
const SIDE_QUESTION_MS = 120_000;
const FILE_SUGGESTIONS_MS = 1500;
const CONTEXT_FULL_MS = 30_000;
const PATH_MAX = 4096;
const URL_MAX = 4096;
const AUTH_URL_MAX = 8192;
const UNKNOWN_TASK = 'no shell or Monitor task';
const BROWSER_DISABLED_MESSAGE = 'Browser tools are not configured on this gateway (CAW_BROWSER_MCP_COMMAND).';
const BYPASS_REFUSED_MESSAGE = 'Bypass permissions is disabled on this gateway, so the session runs in default mode.';
const BYPASS_FAILED_MESSAGE = 'Bypass permissions could not be turned off, so the session was closed.';
const TRUST_NOTICE_MESSAGE = 'Claude Code did not record this folder as trusted, so its project settings may not '
  + 'apply. Trust the folder in the terminal tab.';

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
 * @property {PermissionMode|null} permissionMode   null until system/init reports the mode
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
 * @property {boolean|null} fastMode   fast mode requested for the session; null = the settings decide
 * @property {import('../contracts.mjs').FastModeState|null} fastModeState   last state the runtime reported
 * @property {string|null} fastModeDisabledReason   reason from the same report, null when nothing blocks it
 * @property {number} backgroundTasks   live non-ambient background tasks of this query
 * @property {string|null} agent            main-thread agent the query runs as (option `agent`)
 * @property {string[]} additionalDirectories   extra working directories, without the cwd
 * @property {string|null} fallbackModel    fallback model the query started with
 * @property {boolean} browserTools         the operator's browser MCP server is attached
 * @property {boolean} unattended           the unattended switch is applied to this query (docs/PROTOCOL.md)
 * @property {PermissionMode|null} modeBeforeUnattended   the mode the query runs in when the switch is off; while
 *   the switch is on, the mode the session chose. null means not known: the query returns to default
 * @property {ContextMeter} context         the live context meter and compaction state (docs/PROTOCOL.md)
 * @property {CallUsage|null} contextCall   the API call whose usage streams into the meter
 * @property {number|null} contextFixed     the fixed part of the context (the summary's totalTokens) at the last read
 * @property {boolean} compactPrompt        the prompt that started the running turn is a /compact command
 * @property {boolean} resumed              the query resumes a session file, whose transcript may record usage
 */

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
 * An output style name: a string of 1 to OUTPUT_STYLE_MAX characters once trimmed.
 * @param {unknown} value
 * @returns {string}
 */
function parseOutputStyle(value) {
  if (typeof value !== 'string') throw badRequest('The output style must be a string.');
  const text = value.trim();
  if (text === '' || text.length > OUTPUT_STYLE_MAX) {
    throw badRequest(`The output style must be 1 to ${OUTPUT_STYLE_MAX} characters.`);
  }
  return text;
}

/**
 * @param {unknown} action
 * @returns {{kind: 'toggle'|'reconnect'|'permission-mode', enabled: boolean, mode: 'default'|'auto'|null}}
 */
function parseMcpAction(action) {
  if (!isPlainObject(action)) throw badRequest('The MCP action must be an object.');
  const kind = action.action;
  if (kind !== 'toggle' && kind !== 'reconnect' && kind !== 'permission-mode') {
    throw invalid('The MCP action must be toggle, reconnect or permission-mode.');
  }
  if (action.enabled !== undefined && typeof action.enabled !== 'boolean') {
    throw badRequest('enabled must be a boolean.');
  }
  const enabled = action.enabled === undefined ? true : /** @type {boolean} */ (action.enabled);
  if (kind !== 'permission-mode') return { kind, enabled, mode: null };
  if (action.mode !== 'default' && action.mode !== 'auto' && action.mode !== null) {
    throw invalid('The MCP permission mode must be default, auto or null.');
  }
  return { kind, enabled, mode: /** @type {'default'|'auto'|null} */ (action.mode) };
}

/**
 * @param {unknown} action
 * @returns {{kind: 'start'|'callback'|'clear', callbackUrl: string|null}}
 */
function parseMcpAuth(action) {
  if (!isPlainObject(action)) throw badRequest('The MCP authentication action must be an object.');
  const kind = action.action;
  if (kind !== 'start' && kind !== 'callback' && kind !== 'clear') {
    throw invalid('The MCP authentication action must be start, callback or clear.');
  }
  if (kind !== 'callback') return { kind, callbackUrl: null };
  if (!isWebUrl(action.callbackUrl, URL_MAX, WEB_PROTOCOLS)) {
    throw badRequest('The callback address must be an http or https address of at most 4096 characters.');
  }
  return { kind, callbackUrl: /** @type {string} */ (action.callbackUrl) };
}

/**
 * @param {unknown} value
 * @returns {'summary'|'full'}
 */
function parseDetail(value) {
  if (value === undefined || value === 'summary') return 'summary';
  if (value === 'full') return 'full';
  throw badRequest('detail must be summary or full.');
}

/**
 * @param {unknown} value
 * @returns {string} the trimmed question
 */
function parseQuestion(value) {
  if (typeof value !== 'string') throw badRequest('The question must be a string.');
  const text = value.trim();
  if (text === '' || text.length > SIDE_QUESTION_MAX) {
    throw badRequest(`The question must be 1 to ${SIDE_QUESTION_MAX} characters.`);
  }
  return text;
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
 * @returns {PermissionMode|null} null: Claude Code's settings decide
 */
function parsePermissionMode(value) {
  if (value === null) return null;
  if (!includes(PERMISSION_MODES, value)) throw invalid('The permission mode is not supported.');
  return /** @type {PermissionMode} */ (value);
}

/**
 * @param {unknown} value
 * @returns {string|null} null clears the main-thread agent
 */
function parseAgent(value) {
  if (value === null) return null;
  const text = parseText(value, 'The agent', AGENT_MAX);
  if (text === '') throw invalid(`The agent must be 1 to ${AGENT_MAX} characters.`);
  return text;
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function parseFallbackModel(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !MODEL_RE.test(value)) throw invalid('The fallback model is not valid.');
  return value;
}

/**
 * The additional folders as sent: a list of at most ADDITIONAL_DIRECTORIES_MAX paths. They are resolved by the caller.
 * @param {unknown} value
 * @returns {string[]}
 */
function parseDirectories(value) {
  if (!Array.isArray(value)) throw badRequest('additionalDirectories must be a list of folders.');
  if (value.length > ADDITIONAL_DIRECTORIES_MAX) {
    throw invalid(`additionalDirectories must list at most ${ADDITIONAL_DIRECTORIES_MAX} folders.`);
  }
  return value.map((item) => {
    if (typeof item !== 'string' || item === '' || item.length > PATH_MAX) {
      throw badRequest('Each additional directory must be a path.');
    }
    return item;
  });
}

/**
 * @param {unknown} value
 * @param {boolean} available the operator configured the browser MCP server (CAW_BROWSER_MCP_COMMAND)
 * @returns {boolean}
 */
function parseBrowserTools(value, available) {
  if (typeof value !== 'boolean') throw badRequest('browserTools must be a boolean.');
  if (!available) throw new AppError(501, 'FEATURE_DISABLED', BROWSER_DISABLED_MESSAGE);
  return value;
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
 * @param {unknown} value
 * @returns {boolean|null}
 */
function parseFastMode(value) {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  throw invalid('The fast mode must be true, false or null.');
}

/**
 * Validates the settings a caller supplied. Only keys that are present in the input are returned. Additional folders
 * are returned as sent; the caller resolves them.
 * @param {unknown} input
 * @param {boolean} browserAvailable the operator configured the browser MCP server
 * @returns {SessionSettings}
 */
function parseSettings(input, browserAvailable) {
  if (input === undefined || input === null) return {};
  if (!isPlainObject(input)) throw badRequest('The settings must be an object.');
  /** @type {SessionSettings} */
  const settings = {};
  if (input.model !== undefined) settings.model = parseModel(input.model);
  if (input.permissionMode !== undefined) settings.permissionMode = parsePermissionMode(input.permissionMode);
  if (input.effort !== undefined) settings.effort = parseEffort(input.effort);
  if (input.fastMode !== undefined) settings.fastMode = parseFastMode(input.fastMode);
  if (input.agent !== undefined) settings.agent = parseAgent(input.agent);
  if (input.additionalDirectories !== undefined) {
    settings.additionalDirectories = parseDirectories(input.additionalDirectories);
  }
  if (input.fallbackModel !== undefined) settings.fallbackModel = parseFallbackModel(input.fallbackModel);
  if (input.browserTools !== undefined) {
    settings.browserTools = parseBrowserTools(input.browserTools, browserAvailable);
  }
  return settings;
}

/**
 * The working folder is not one of a query's additional directories.
 * @param {string[]} dirs
 * @param {string} cwd
 * @returns {string[]}
 */
function dirsForCwd(dirs, cwd) {
  return dirs.filter((dir) => dir !== cwd);
}

/**
 * @param {string[]} a
 * @param {string[]} b
 * @returns {boolean}
 */
function sameList(a, b) {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/**
 * The CLI flags a query starts with: thinking summaries (see #wantsThinkingSummaries) and Claude in Chrome.
 * @param {boolean} summaries
 * @param {boolean} chrome
 * @returns {Record<string, string|null>|undefined}
 */
function cliFlagsOf(summaries, chrome) {
  /** @type {Record<string, string|null>} */
  const flags = {};
  if (summaries) flags['thinking-display'] = 'summarized';
  if (chrome) flags.chrome = null;
  return Object.keys(flags).length > 0 ? flags : undefined;
}

/**
 * The runtime's interrupt. Its public typing takes no argument; the cancel_queued option is passed through it.
 * @param {SdkQuery} query
 * @param {boolean} cancelQueued
 * @returns {Promise<unknown>} the receipt, undefined on runtimes without one
 */
function interruptRuntime(query, cancelQueued) {
  const control = /** @type {{interrupt: (options?: {cancelQueued: true}) => Promise<unknown>}} */ (
    /** @type {unknown} */ (query));
  return cancelQueued ? control.interrupt({ cancelQueued: true }) : control.interrupt();
}

/**
 * The flag-settings layer takes keys that the public typing does not declare (the main-thread agent).
 * @param {SdkQuery} query
 * @param {Record<string, unknown>} flags
 * @returns {Promise<void>}
 */
function applyFlags(query, flags) {
  return query.applyFlagSettings(/** @type {Parameters<SdkQuery['applyFlagSettings']>[0]} */ (
    /** @type {unknown} */ (flags)));
}

/**
 * @param {unknown} answer what askSideQuestion answered: null, or the response with its refusal fallback
 * @returns {{response: string|null, synthetic: boolean,
 *   refusalFallback: {originalModel: string, fallbackModel: string}|null}}
 */
function sideAnswerOf(answer) {
  const source = isPlainObject(answer) ? answer : {};
  /** @type {Record<string, unknown>} */
  const fallback = isPlainObject(source.refusalFallback) ? source.refusalFallback : {};
  const models = typeof fallback.originalModel === 'string' && typeof fallback.fallbackModel === 'string';
  return {
    response: typeof source.response === 'string' ? source.response : null,
    synthetic: source.synthetic === true,
    refusalFallback: models
      ? {
        originalModel: /** @type {string} */ (fallback.originalModel),
        fallbackModel: /** @type {string} */ (fallback.fallbackModel),
      }
      : null,
  };
}

/**
 * A runtime method of a live query, bound to it. A method the installed runtime does not offer is refused as
 * unavailable.
 * @param {SdkQuery|null|undefined} query
 * @param {string} name
 * @param {string} message
 * @returns {(...args: unknown[]) => Promise<unknown>}
 */
function methodOf(query, name, message) {
  const call = runtimeMethod(query, name);
  if (call === null) throw unavailable(message);
  return call;
}

/**
 * @param {string} message
 * @returns {AppError}
 */
function unavailable(message) {
  return new AppError(501, 'FEATURE_UNAVAILABLE', message);
}

/** @param {unknown} error @returns {string} */
function messageOf(error) {
  return error instanceof Error ? error.message : '';
}

/**
 * A failed MCP authentication call. A timeout keeps its own message; anything else answers with the runtime's first
 * line.
 * @param {unknown} error
 * @param {string} fallback
 * @returns {AppError}
 */
function authFailure(error, fallback) {
  if (error instanceof ControlTimeout) return engineError(TIMEOUT_MESSAGE);
  return new AppError(502, 'ENGINE_ERROR', firstLine(messageOf(error), fallback));
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

/**
 * Names a runtime reports for a held reload. Plugin-authored, so only strings are kept, at most
 * CACHE_IMPACT_MAX of them and each cut to CACHE_IMPACT_NAME_MAX characters.
 * @param {unknown} value
 * @returns {string[]}
 */
function namesOf(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((name) => typeof name === 'string')
    .slice(0, CACHE_IMPACT_MAX)
    .map((name) => name.slice(0, CACHE_IMPACT_NAME_MAX));
}

/**
 * What applying a held plugin reload would change in the tool list, in the gateway's shape.
 * @param {unknown} impact the cache_impact of the runtime answer
 * @returns {{mcpServersAdded: string[], mcpServersRemoved: string[],
 *   lspToolChange: 'adds'|'may-add'|'removes'|'may-remove'|null}}
 */
function cacheImpactOf(impact) {
  const source = isPlainObject(impact) ? impact : {};
  const lsp = source.lsp_tool_change;
  return {
    mcpServersAdded: namesOf(source.mcp_servers_added),
    mcpServersRemoved: namesOf(source.mcp_servers_removed),
    lspToolChange: includes(LSP_TOOL_CHANGES, lsp)
      ? /** @type {'adds'|'may-add'|'removes'|'may-remove'} */ (lsp)
      : null,
  };
}

/**
 * The output style names a runtime reports that a client can also select: non-blank strings within the length that
 * `POST /output-style` accepts.
 * @param {unknown} value
 * @returns {string[]}
 */
function outputStylesOf(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((name) => typeof name === 'string' && name.trim() !== '' && name.length <= OUTPUT_STYLE_MAX);
}

/**
 * The filesystem settings sources a query loads: folders the owner trusted load their project and local settings too.
 * @param {boolean} trusted
 * @returns {Array<'user'|'project'|'local'>}
 */
function settingSourcesOf(trusted) {
  return trusted ? ['user', 'project', 'local'] : ['user'];
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
  /** @type {(p: string) => Promise<string>} resolves an additional folder inside the roots, or throws */
  #resolveDir;
  /** @type {string} the home folder whose `.claude` folder holds the user's memory */
  #homeDir;
  /** @type {ReturnType<typeof createRuntimeTrust>} */
  #trust;
  /** @type {Set<string>} folders whose failed trust handshake has been published */
  #trustNoticed = new Set();
  /** @type {Set<string>} sessions with a side question in flight */
  #sideQuestions = new Set();
  /** @type {() => boolean} the unattended switch: its effective value, read synchronously */
  #unattended;
  /** @type {Promise<void>} the switch changes applied to the live queries, one after the other */
  #unattendedTail = Promise.resolve();

  /**
   * Folder trust decides which setting sources a query loads. Without `isTrustedCwd` every folder is untrusted.
   * `resolveDir` resolves an additional folder to a real folder inside the workspace roots and throws when it cannot.
   * `unattended` reports whether the unattended switch is on (default: off).
   * @param {{engine: EngineAdapter, config: Config, log: Logger, publish: Publish, getSeq: () => number,
   *   isAllowedCwd: (p: string) => Promise<boolean>, isTrustedCwd?: (p: string) => Promise<boolean>,
   *   resolveDir?: (p: string) => Promise<string>, homeDir?: string, now?: () => number,
   *   unattended?: () => boolean}} options
   */
  constructor({
    engine, config, log, publish, getSeq, isAllowedCwd, isTrustedCwd = async () => false,
    resolveDir = async () => {
      throw outsideRoots();
    },
    homeDir = os.homedir(), now = Date.now, unattended = () => false,
  }) {
    this.#engine = engine;
    this.#config = config;
    this.#log = log;
    this.#publish = publish;
    this.#getSeq = getSeq;
    this.#isAllowedCwd = isAllowedCwd;
    this.#isTrustedCwd = isTrustedCwd;
    this.#resolveDir = resolveDir;
    this.#homeDir = homeDir;
    this.#now = now;
    this.#unattended = unattended;
    this.#trust = createRuntimeTrust({ engine, config, log, env: () => this.#queryEnv() });
    this.#requests = new RequestRegistry({
      publish: (event) => {
        const seq = this.#publish(event);
        if (event.type === 'request' || event.type === 'request_resolved') this.#syncSession(event.sessionId);
        return seq;
      },
      now,
      allowBypass: config.allowBypass === true,
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
    if (cwd === undefined) return (await this.#allSessions()).slice(page.offset, page.offset + page.limit);
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
   * Every session inside an allowed workspace and every live one, newest first. The runtime is asked once.
   * @returns {Promise<SessionSummary[]>}
   */
  async #allSessions() {
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
    return sessions;
  }

  /**
   * Every session the gateway lists, newest first, from one listing of the runtime (the session search reads it once).
   * @returns {Promise<SessionSummary[]>}
   */
  listAllSessions() {
    return this.#allSessions();
  }

  /**
   * The stored info and the live detail of a session. `now` is the gateway's clock when it answered, so a client can
   * convert the gateway times it holds (such as the start of a compaction) to its own clock.
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
      now: this.#now(),
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
      // The capabilities reach every profile, so MCP server configs lose their secrets as in the mcp view.
      mcpServers: /** @type {McpServerStatus[]} */ (redactMcpServers(mcpServers)),
      outputStyle: init.output_style ?? null,
      availableOutputStyles: outputStylesOf(init.available_output_styles),
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
      fastMode: live.fastMode,
      fastModeState: live.fastModeState,
      fastModeDisabledReason: live.fastModeDisabledReason,
      backgroundTasks: live.backgroundTasks,
      agent: live.agent,
      additionalDirectories: live.additionalDirectories,
      fallbackModel: live.fallbackModel,
      browserTools: live.browserTools,
      context: snapshotContextMeter(live.context),
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
   * @param {unknown} cwd
   * @returns {Promise<boolean>} whether the folder lies inside an allowed workspace root
   */
  async #withinRoots(cwd) {
    return typeof cwd === 'string' && cwd !== '' && (await this.#isAllowed(cwd));
  }

  /**
   * A live query whose folder no longer lies inside the workspace roots (a symlink swapped in after it started, for
   * example) is closed, and its session answers as not found from then on. Never waits for the lifecycle queue.
   * @param {LiveRecord} live
   * @returns {Promise<LiveRecord>}
   */
  async #liveInRoots(live) {
    if (await this.#withinRoots(live.cwd)) return live;
    await this.#detach(live, { publish: true });
    throw sessionNotFound();
  }

  /**
   * The open query of a session, or undefined when it is not open, for the routes that act on open sessions. A
   * query outside the roots is closed, and a session whose file lies outside them answers as not found. Any other
   * session that is not open keeps the answer of its route.
   * @param {string} sessionId
   * @returns {Promise<LiveRecord|undefined>}
   */
  async #openLive(sessionId) {
    const live = this.#live.get(sessionId);
    if (live) return this.#liveInRoots(live);
    const info = await this.#readInfoOrNull(sessionId);
    if (info && !(await this.#withinRoots(info.cwd))) throw sessionNotFound();
    return undefined;
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
   * The file and the live query of a session, each withheld when its folder is outside the workspace roots. A live
   * query outside the roots is closed first (see #liveInRoots). Throws SESSION_NOT_FOUND when neither is visible.
   * With `lenient`, a file that cannot be read counts as no file.
   * @param {string} sessionId
   * @param {boolean} [lenient]
   * @returns {Promise<{info: SDKSessionInfo|null, live: LiveRecord|null}>}
   */
  async #scopeOf(sessionId, lenient = false) {
    const found = lenient ? await this.#readInfoOrNull(sessionId) : await this.#readInfo(sessionId);
    const info = found && (await this.#withinRoots(found.cwd)) ? found : null;
    const current = this.#live.get(sessionId) ?? null;
    const live = current ? await this.#liveInRoots(current) : null;
    if (!info && !live) throw sessionNotFound();
    return { info, live };
  }

  /**
   * Starts the query of a new or an existing session. The caller has validated the working directory and read its
   * trust. A session that is already open is refused, so two queries never share one id.
   * @param {{mode: 'new'|'resume', sessionId: string|null, cwd: string, trusted: boolean, title?: string,
   *   settings: SessionSettings, resumeSessionAt?: string}} start
   * @returns {Promise<LiveRecord>}
   */
  async #startQuery({ mode, sessionId, cwd, trusted, title, settings, resumeSessionAt }) {
    const id = mode === 'new' ? randomUUID() : /** @type {string} */ (sessionId);
    this.#assertStartable(id);
    const resolved = this.#resolveSettings(mode === 'new' ? null : id, settings, cwd);
    // The settings the query will load are read before the query exists. Nothing is registered until the answer is in,
    // and the start is checked again afterwards, because a shutdown or a start of the same id may have run meanwhile.
    const summaries = await this.#wantsThinkingSummaries(id, cwd, trusted === true);
    if (trusted === true) await this.#syncRuntimeTrust(cwd, id);
    this.#assertStartable(id);
    this.#makeRoom();
    // While the unattended switch is on, every query starts in bypassPermissions. The mode the session chose stays the
    // one it returns to when the switch turns off.
    const unattended = this.#unattended();
    const startMode = unattended ? /** @type {PermissionMode} */ ('bypassPermissions') : resolved.permissionMode;
    /** @type {LiveRecord} */
    const live = {
      sessionId: id,
      cwd,
      query: null,
      input: new AsyncQueue(),
      abort: new AbortController(),
      state: 'starting',
      model: resolved.model,
      // An explicitly chosen mode is what the runtime starts in; without one, Claude Code's settings decide and
      // system/init reports the result.
      permissionMode: startMode,
      unattended,
      modeBeforeUnattended: unattended ? resolved.permissionMode : null,
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
      fastMode: resolved.fastMode,
      fastModeState: null,
      fastModeDisabledReason: null,
      backgroundTasks: 0,
      agent: resolved.agent,
      additionalDirectories: resolved.additionalDirectories,
      fallbackModel: resolved.fallbackModel,
      browserTools: resolved.browserTools,
      context: emptyContextMeter(),
      contextCall: null,
      contextFixed: null,
      compactPrompt: false,
      resumed: mode === 'resume',
    };
    const options = this.#queryOptions(live, { mode, resumeSessionAt, summaries, startMode });
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
    void this.#awaitReady(live);
    return live;
  }

  /**
   * Claude Code answers the SDK's initialize handshake as soon as its process is up, but sends system/init only with
   * the first prompt of a streaming session. A new or resumed session is therefore ready, and shown as idle, once the
   * handshake is answered (`initializationResult()`, which makes no model call); model, mode and version stay as they
   * are until system/init reports them. The context window is read then too (see #refreshContext). A handshake that
   * fails or never comes changes nothing: the pump reports the failure.
   * @param {LiveRecord} live
   */
  async #awaitReady(live) {
    try {
      await withTimeout(() => /** @type {SdkQuery} */ (live.query).initializationResult(), READY_WAIT_MS);
    } catch (error) {
      this.#log.debug('initialize handshake not answered', { sessionId: live.sessionId, reason: errorName(error) });
      return;
    }
    if (live.state === 'starting') this.#setState(live, 'idle');
    void this.#refreshContext(live, { transcript: live.resumed });
  }

  /**
   * Refuses a start of a session that is shutting down or already open. Checked before and after every wait.
   * @param {string} id
   */
  #assertStartable(id) {
    if (this.#stopped) throw new AppError(503, 'ENGINE_UNAVAILABLE', 'The gateway is shutting down.');
    if (this.#live.has(id)) throw new AppError(409, 'CONFLICT', 'The session is already open.');
  }

  /**
   * Whether the query asks for thinking summaries. Claude Code reads the showThinkingSummaries setting only in its
   * interactive terminal; a non-interactive session (every SDK query) sends thinking without text unless the display is
   * given explicitly, so the gateway passes `--thinking-display summarized` to show what the terminal shows. A setting
   * that turns summaries off (`showThinkingSummaries: false` in any file the query loads) is honored. A failed or slow
   * lookup asks for them; the failure is logged without any content.
   * @param {string} sessionId
   * @param {string} cwd
   * @param {boolean} trusted
   * @returns {Promise<boolean>}
   */
  async #wantsThinkingSummaries(sessionId, cwd, trusted) {
    try {
      const resolved = await withTimeout(
        () => this.#engine.resolveSettings({ cwd, settingSources: settingSourcesOf(trusted) }),
        SETTINGS_LOOKUP_MS,
      );
      return resolved.effective?.showThinkingSummaries !== false;
    } catch (error) {
      this.#log.debug('settings lookup failed; thinking summaries requested', {
        sessionId,
        reason: errorName(error),
      });
      return true;
    }
  }

  /**
   * Options of one query. Keys that do not apply are omitted instead of being set to undefined.
   * @param {LiveRecord} live
   * @param {{mode: 'new'|'resume', resumeSessionAt: string|undefined, summaries: boolean,
   *   startMode: PermissionMode|null}} start   summaries: the query asks for thinking summaries (see
   *   #wantsThinkingSummaries); startMode: the mode the query starts in, null when Claude Code's settings decide
   * @returns {SdkOptions}
   */
  #queryOptions(live, { mode, resumeSessionAt, summaries, startMode }) {
    const { claudeBin, allowBypass, chrome } = this.#config;
    const flags = cliFlagsOf(summaries, chrome === true);
    return {
      cwd: live.cwd,
      abortController: live.abort,
      ...(mode === 'new' ? { sessionId: live.sessionId } : { resume: live.sessionId }),
      ...(mode === 'new' && live.title ? { title: live.title } : {}),
      ...(resumeSessionAt ? { resumeSessionAt } : {}),
      ...(live.model !== null ? { model: live.model } : {}),
      ...(startMode !== null ? { permissionMode: startMode } : {}),
      ...(live.effort !== null ? { effort: live.effort } : {}),
      ...(live.agent !== null ? { agent: live.agent } : {}),
      ...(live.additionalDirectories.length > 0 ? { additionalDirectories: live.additionalDirectories } : {}),
      ...(live.fallbackModel !== null ? { fallbackModel: live.fallbackModel } : {}),
      ...(live.browserTools ? { mcpServers: this.#browserServers() } : {}),
      allowDangerouslySkipPermissions: allowBypass,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      tools: { type: 'preset', preset: 'claude_code' },
      settingSources: settingSourcesOf(live.trusted),
      includePartialMessages: true,
      includeHookEvents: true,
      promptSuggestions: true,
      agentProgressSummaries: true,
      enableFileCheckpointing: true,
      perTaskStopAffordance: true,
      // --thinking-display and --chrome. The `thinking` option would also force the thinking type, which the runtime
      // otherwise derives from the model and the user's settings.
      ...(flags ? { extraArgs: flags } : {}),
      ...(typeof live.fastMode === 'boolean' ? { settings: { fastMode: live.fastMode } } : {}),
      toolConfig: { askUserQuestion: { previewFormat: 'markdown' } },
      canUseTool: this.#canUseTool(live),
      onElicitation: this.#onElicitation(live),
      onUserDialog: this.#onUserDialog(live),
      supportedDialogKinds: [...DIALOG_KINDS],
      env: this.#queryEnv(),
      ...(typeof claudeBin === 'string' ? { pathToClaudeCodeExecutable: claudeBin } : {}),
      stderr: (data) => this.#log.debug('engine stderr', { bytes: data.length }),
    };
  }

  /**
   * Explicit arguments win over the settings remembered for the session, which win over the configured defaults.
   * @param {string|null} sessionId
   * @param {SessionSettings} args
   * @param {string} cwd the folder of the query, which is never one of its additional directories
   * @returns {{model: string|null, permissionMode: PermissionMode|null, effort: EffortLevel|null,
   *   fastMode: boolean|null, agent: string|null, additionalDirectories: string[], fallbackModel: string|null,
   *   browserTools: boolean}}
   */
  #resolveSettings(sessionId, args, cwd) {
    const remembered = sessionId === null ? {} : this.#pending.get(sessionId) ?? {};
    const { defaults } = this.#config;
    /** @param {keyof SessionSettings} key @param {unknown} fallback */
    const pick = (key, fallback) => {
      if (args[key] !== undefined) return args[key];
      if (remembered[key] !== undefined) return remembered[key];
      return fallback;
    };
    const resolved = {
      model: /** @type {string|null} */ (pick('model', defaults.model ?? null)),
      permissionMode: /** @type {PermissionMode|null} */ (pick('permissionMode', defaults.permissionMode ?? null)),
      effort: /** @type {EffortLevel|null} */ (pick('effort', defaults.effort ?? null)),
      fastMode: /** @type {boolean|null} */ (pick('fastMode', null)),
      agent: /** @type {string|null} */ (pick('agent', null)),
      additionalDirectories: dirsForCwd(/** @type {string[]} */ (pick('additionalDirectories', [])), cwd),
      fallbackModel: /** @type {string|null} */ (pick('fallbackModel', defaults.fallbackModel ?? null)),
      browserTools: pick('browserTools', false) === true,
    };
    this.#assertBypassAllowed(resolved.permissionMode);
    return resolved;
  }

  /**
   * The runtime's query environment: the gateway's own environment without its CAW_ variables, plus the client name.
   * @returns {Record<string, string>}
   */
  #queryEnv() {
    return engineEnv(process.env, { clientApp: `claude-official-web/${this.#config.version}` });
  }

  /** @returns {boolean} the operator configured the browser MCP server */
  #browserAvailable() {
    return Array.isArray(this.#config.browserMcpCommand);
  }

  /**
   * The operator's browser MCP server as the runtime's stdio server config.
   * @returns {Record<string, McpServerConfig>}
   */
  #browserServers() {
    const [command, ...args] = this.#config.browserMcpCommand ?? [];
    if (!command) return {};
    return { [BROWSER_MCP_SERVER]: /** @type {McpServerConfig} */ ({ type: 'stdio', command, args }) };
  }

  /**
   * Resolves the additional folders of a session to real folders inside the workspace roots, without duplicates.
   * @param {string[]} list
   * @returns {Promise<string[]>}
   */
  async #resolveDirectories(list) {
    /** @type {string[]} */
    const resolved = [];
    for (const dir of list) {
      if (!path.isAbsolute(dir)) throw outsideRoots();
      const real = await this.#resolveDir(dir).catch(() => {
        throw outsideRoots();
      });
      if (!resolved.includes(real)) resolved.push(real);
    }
    return resolved;
  }

  /**
   * Records the folder's trust in Claude Code's own record before a query of a trusted folder starts (see trust.mjs).
   * A failure is published once per folder as a warning; the session starts anyway.
   * @param {string} cwd
   * @param {string} sessionId
   */
  async #syncRuntimeTrust(cwd, sessionId) {
    if ((await this.#trust.record(cwd)) !== 'failed' || this.#trustNoticed.has(cwd)) return;
    this.#trustNoticed.add(cwd);
    this.#publish({
      type: 'notice',
      sessionId,
      data: { sessionId, level: 'warning', code: 'RUNTIME_TRUST', message: TRUST_NOTICE_MESSAGE },
    });
  }

  /**
   * Answers the runtime's dialogs. Only the refusal fallback prompt is declared, so a dialog of any other kind, or one
   * without both model names, is cancelled at once.
   * @param {LiveRecord} live
   * @returns {OnUserDialog}
   */
  #onUserDialog(live) {
    return async (request, options) => {
      const dialog = refusalDialogOf(request);
      if (dialog === null) return { behavior: 'cancelled' };
      const pending = /** @type {PendingRequest} */ (omitUndefined({
        id: this.#requestId(live.sessionId, options.requestId),
        sessionId: live.sessionId,
        kind: 'dialog',
        createdAt: this.#now(),
        toolUseId: request.toolUseID,
        dialog,
      }));
      const outcome = await this.#awaitRequest(live, pending, options.signal);
      return toDialogResult(outcome);
    };
  }

  /**
   * A query that reports bypass permissions while the gateway does not allow them is set back to default at once.
   * @param {LiveRecord} live
   */
  #guardBypass(live) {
    if (live.permissionMode === 'bypassPermissions' && !this.#config.allowBypass) void this.#refuseBypass(live);
  }

  /**
   * Sets the query back to default mode and publishes a notice. When the runtime refuses that, the session is closed
   * rather than left running in bypass mode.
   * @param {LiveRecord} live
   */
  async #refuseBypass(live) {
    if (live.closing || !live.query) return;
    try {
      await withTimeout(() => live.query.setPermissionMode('default'));
      live.permissionMode = 'default';
      this.#publish({
        type: 'notice',
        sessionId: live.sessionId,
        data: { sessionId: live.sessionId, level: 'warning', code: 'BYPASS_REFUSED', message: BYPASS_REFUSED_MESSAGE },
      });
      this.#sync(live);
    } catch (error) {
      this.#log.warn('could not turn off bypass permissions', { sessionId: live.sessionId, reason: errorName(error) });
      this.#publish({
        type: 'notice',
        sessionId: live.sessionId,
        data: { sessionId: live.sessionId, level: 'error', code: 'BYPASS_REFUSED', message: BYPASS_FAILED_MESSAGE },
      });
      await this.#detach(live, { publish: true });
    }
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
      if (live.backgroundTasks > 0 || this.#opening.has(live.sessionId)) continue;
      if (victim === null || live.lastActivity < victim.lastActivity) victim = live;
    }
    if (victim === null) {
      throw new AppError(429, 'TOO_MANY_SESSIONS', 'Too many sessions are running. Stop one and try again.');
    }
    this.#log.info('closing the least recently used idle session', { sessionId: victim.sessionId });
    void this.#detach(victim, { publish: true });
  }

  /**
   * Returns the live query of a session, starting it when needed. Concurrent callers share one start. A query outside
   * the roots is closed and answered as not found (see #openLive).
   * @param {string} sessionId
   * @param {SessionSettings} [settings]
   * @returns {Promise<LiveRecord>}
   */
  #ensureLive(sessionId, settings = {}) {
    const live = this.#live.get(sessionId);
    if (live && !this.#opening.has(sessionId)) return this.#liveInRoots(live);
    return this.#exclusive(sessionId, async () => {
      const current = await this.#openLive(sessionId);
      return current ?? this.#resumeLive(sessionId, settings);
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
   * The open query of a session, inside the roots (see #openLive). Not open answers SESSION_NOT_LIVE.
   * @param {string} sessionId
   * @returns {Promise<LiveRecord>}
   */
  async #requireLive(sessionId) {
    const live = await this.#openLive(sessionId);
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
    // A query that is being closed publishes nothing more, not even what it sends while it stops.
    if (live.closing) return;
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
        // The turn is over, so the next turn starts with a prompt of its own (see sendMessage).
        live.compactPrompt = false;
        this.#applyFastModeReport(live, msg);
        // A finished turn changes the session file (first prompt, summary, modification time); let every client
        // refresh its session list, which is how a brand-new untitled session gets its summary in the sidebar.
        this.#publish({ type: 'sessions_changed', data: { reason: 'activity', sessionId: live.sessionId } });
        return;
      case 'assistant':
      case 'stream_event':
        live.contextCall = observeUsage(live.context, live.contextCall, msg);
        live.lastActivity = this.#now();
        return;
      case 'user':
        live.lastActivity = this.#now();
        return;
      default:
        return;
    }
  }

  /**
   * Keeps the fast mode state the runtime reports with an init or a result message. A message without a known state
   * changes nothing; the reason is taken from the same message and is null when it has none.
   * @param {LiveRecord} live
   * @param {{fast_mode_state?: unknown, fast_mode_disabled_reason?: unknown}} msg
   */
  #applyFastModeReport(live, msg) {
    if (!includes(FAST_MODE_STATES, msg.fast_mode_state)) return;
    live.fastModeState = /** @type {import('../contracts.mjs').FastModeState} */ (msg.fast_mode_state);
    live.fastModeDisabledReason = typeof msg.fast_mode_disabled_reason === 'string'
      ? msg.fast_mode_disabled_reason
      : null;
  }

  /**
   * Keeps the title the runtime reports for a session after its first turn, then tells every client so the sidebars
   * follow it. The title is trimmed and capped like a title the user typed; an empty one changes nothing.
   * @param {LiveRecord} live
   * @param {unknown} msg
   */
  #applyTitle(live, msg) {
    const reported = isPlainObject(msg) ? msg.title : undefined;
    const title = typeof reported === 'string' ? reported.trim().slice(0, TITLE_MAX) : '';
    if (title === '') return;
    live.title = title;
    this.#sync(live);
    this.#publishSessionsChanged('title', live.sessionId);
  }

  /**
   * @param {LiveRecord} live
   * @param {Extract<SDKMessage, {type: 'system'}>} msg
   */
  #applySystemMessage(live, msg) {
    // The SDK types do not declare this subtype yet, so it is compared as a plain string.
    if (/** @type {string} */ (msg.subtype) === 'session_title_changed') {
      this.#applyTitle(live, msg);
      return;
    }
    switch (msg.subtype) {
      case 'init':
        live.init = msg;
        live.model = msg.model ?? live.model;
        live.permissionMode = msg.permissionMode ?? null;
        live.effort = msg.effort ?? live.effort;
        live.claudeCodeVersion = msg.claude_code_version;
        if (msg.claude_code_version) this.#lastClaudeCodeVersion = msg.claude_code_version;
        if (live.state === 'starting') live.state = 'idle';
        this.#applyFastModeReport(live, msg);
        this.#guardBypass(live);
        return;
      case 'background_tasks_changed':
        // The set replaces the previous one; ambient tasks (watchers, skip-transcript work) are not activity. A message
        // without a task list changes nothing.
        if (!Array.isArray(msg.tasks)) return;
        live.backgroundTasks = msg.tasks.filter((task) => isPlainObject(task) && task.ambient !== true).length;
        return;
      case 'session_state_changed':
        if (!live.closing) {
          const waiting = msg.state === 'idle' && this.#requests.count(live.sessionId) > 0;
          live.state = waiting ? 'requires_action' : msg.state;
        }
        return;
      case 'status':
        if (msg.permissionMode) {
          live.permissionMode = msg.permissionMode;
          this.#guardBypass(live);
        }
        this.#applyCompactionStatus(live, msg);
        return;
      case 'compact_boundary':
        this.#applyCompactBoundary(live, msg);
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
   * Whether the query is still the open one of its session and not being closed.
   * @param {LiveRecord} live
   * @returns {boolean}
   */
  #isCurrent(live) {
    return this.#live.get(live.sessionId) === live && !live.closing;
  }

  /**
   * The compacting state of the meter. 'compacting' starts it, with the trigger the turn's prompt implies; the status
   * that follows (null, with or without a result) ends it, and a failed compaction also refreshes the window, as a
   * finished one does at its boundary. A subagent's status changes nothing.
   * @param {LiveRecord} live
   * @param {SDKStatusMessage} msg
   */
  #applyCompactionStatus(live, msg) {
    if (isSubagentMessage(msg)) return;
    if (msg.status === 'compacting') {
      startCompaction(live.context, this.#now(), live.compactPrompt ? 'manual' : null);
      return;
    }
    if (msg.status === 'requesting') return;
    endCompaction(live.context);
    if (msg.compact_result === 'failed') void this.#refreshContext(live, { transcript: false });
  }

  /**
   * A finished compaction: the boundary records what it did. The size the stream reported before it no longer holds, so
   * `used` takes the estimate of the context right after the compaction, and the context is then counted in full.
   * @param {LiveRecord} live
   * @param {SDKCompactBoundaryMessage} msg
   */
  #applyCompactBoundary(live, msg) {
    if (isSubagentMessage(msg)) return;
    recordCompaction(live.context, msg.compact_metadata, this.#now());
    const postTokens = postTokensOf(msg.compact_metadata);
    estimateAfterCompaction(live.context, live.contextFixed, postTokens);
    void this.#countAfterCompaction(live, live.contextCall, postTokens);
  }

  /**
   * After a compaction the context is counted in full (getContextUsage, full detail, 30 s). The count replaces `used`
   * unless an API call has started since the boundary (its usage is newer), and the window and threshold are read from
   * the same answer. When the count fails, the window comes from the summary, and the estimate stands unless a newer
   * call has reported. Never fills from apiUsage, which describes a call from before the compaction. Never rejects.
   * @param {LiveRecord} live
   * @param {CallUsage|null} callAtBoundary the API call the stream reported last before the boundary
   * @param {number|null} postTokens post_tokens of the boundary, for the estimate when the count fails
   * @returns {Promise<void>}
   */
  async #countAfterCompaction(live, callAtBoundary, postTokens) {
    /** @type {ContextUsage|null} */
    let full = null;
    try {
      const query = /** @type {SdkQuery} */ (live.query);
      const answer = await withTimeout(() => query.getContextUsage({ detail: 'full' }), CONTEXT_FULL_MS);
      full = answer !== null && typeof answer === 'object' ? answer : null;
    } catch (error) {
      this.#log.debug('context not counted after a compaction', {
        sessionId: live.sessionId,
        reason: errorName(error),
      });
    }
    if (!this.#isCurrent(live)) return;
    if (full !== null) {
      applyWindow(live.context, full);
      countAfterCompaction(live.context, full.totalTokens, isNewerCall(live.contextCall, callAtBoundary));
    } else {
      const summary = await this.#contextSummary(live);
      if (!this.#isCurrent(live)) return;
      if (summary !== null) {
        applyWindow(live.context, summary);
        if (!isNewerCall(live.contextCall, callAtBoundary)) {
          estimateAfterCompaction(live.context, summary.totalTokens, postTokens);
        }
      }
    }
    this.#sync(live);
  }

  /**
   * Reads the window of a session from its runtime (getContextUsage, summary detail, 10 s): the maximum, the threshold
   * and the auto-compact switch. Until the stream has reported an API call, `used` comes from the last call the runtime
   * reports, else from the last call of the transcript (resumed sessions only), else from the fixed part of the
   * context. After a compaction apiUsage describes a call from before it, so it is not used then, and until a call
   * reports the estimate stays the fixed part plus what the compaction left. A transcript whose last compaction has no
   * call after it counts the context in full instead (see #countAfterCompaction). Publishes when the meter changed. A
   * failure keeps the values the meter had and is logged at debug level. Never rejects.
   * @param {LiveRecord} live
   * @param {{transcript: boolean}} options transcript: read the session file for the last call (a resumed session)
   * @returns {Promise<void>}
   */
  async #refreshContext(live, { transcript }) {
    const summary = await this.#contextSummary(live);
    if (!this.#isCurrent(live)) return;
    if (summary !== null) {
      applyWindow(live.context, summary);
      if (live.context.lastCompaction === null) fillUsed(live.context, usageTokens(summary.apiUsage), 'api-usage');
    }
    let compacted = false;
    if (transcript && live.context.source === null) {
      const found = await this.#transcriptContext(live);
      if (!this.#isCurrent(live)) return;
      fillUsed(live.context, found.tokens, 'transcript');
      compacted = found.tokens === null && found.compacted;
    }
    if (summary !== null) {
      const last = live.context.lastCompaction;
      if (last !== null && live.context.source === 'estimate') {
        estimateAfterCompaction(live.context, summary.totalTokens, last.postTokens);
      } else {
        fillUsed(live.context, summary.totalTokens, 'estimate');
      }
    }
    this.#sync(live);
    if (compacted) void this.#countAfterCompaction(live, live.contextCall, null);
  }

  /**
   * The summary of the context usage, or null when the runtime does not answer in time or answers with no object. The
   * summary leaves the conversation out, so its total is the fixed part of the context: it is kept as contextFixed.
   * @param {LiveRecord} live
   * @returns {Promise<ContextUsage|null>}
   */
  async #contextSummary(live) {
    try {
      const query = /** @type {SdkQuery} */ (live.query);
      const answer = await withTimeout(() => query.getContextUsage({ detail: 'summary' }));
      const summary = answer !== null && typeof answer === 'object' ? answer : null;
      if (summary !== null) live.contextFixed = summary.totalTokens;
      return summary;
    } catch (error) {
      this.#log.debug('context usage not read', { sessionId: live.sessionId, reason: errorName(error) });
      return null;
    }
  }

  /**
   * What the session file says about the context of a resumed session (see transcriptContextOf), read through the
   * transcript path the history uses (the cache of #transcript answers a second read). Nothing is known when the file
   * is missing, unreadable or has neither a call nor a compaction.
   * @param {LiveRecord} live
   * @returns {Promise<{tokens: number|null, compacted: boolean}>}
   */
  async #transcriptContext(live) {
    try {
      const info = await this.#readInfoOrNull(live.sessionId);
      return transcriptContextOf(await this.#transcript(live.sessionId, info));
    } catch (error) {
      this.#log.debug('transcript usage not read', { sessionId: live.sessionId, reason: errorName(error) });
      return { tokens: null, compacted: false };
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
    // A query that has ended reports no background tasks, so nothing keeps its session from being closed.
    live.backgroundTasks = 0;
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
        const auto = outcome.auto === true;
        setImmediate(() => {
          void this.#applyPlanMode(live, nextMode, auto);
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
    // While unattended mode is on, the gateway answers the request at once (after it is published), so the session
    // never waits for a person and is never shown as requiring action.
    const automatic = this.#unattended();
    if (!automatic) this.#setState(live, 'requires_action');
    const pending = this.#requests.create(request, signal);
    if (automatic) this.#requests.answerAutomatically(live.sessionId, request.id);
    const outcome = await pending;
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
   * Applies the mode a plan approval asked for, after the approval has been answered to the SDK. While the switch holds
   * the query in bypass, a person's choice is kept for when the switch turns off; an automatic approval (which asks for
   * bypass) is applied only while the switch is still on.
   * @param {LiveRecord} live
   * @param {PermissionMode} nextMode
   * @param {boolean} auto the gateway gave the approval (unattended mode)
   */
  async #applyPlanMode(live, nextMode, auto) {
    if (this.#live.get(live.sessionId) !== live || live.closing || !live.query) return;
    if (live.unattended && !auto) {
      this.#chooseWhileUnattended(live, nextMode);
      return;
    }
    if (!live.unattended && auto) return;
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

  /**
   * Applies the unattended switch to every live query, after the switch has changed (docs/PROTOCOL.md "Unattended
   * mode"). Turning it on sets each query to bypassPermissions and answers the requests already waiting; turning it off
   * returns each query to the mode it had. Calls run one after the other, and the state is read when each one runs, so
   * switching twice quickly ends in the value saved last. Queries run in parallel; a failure is logged and does not
   * stop the others.
   * @returns {Promise<void>}
   */
  applyUnattended() {
    const run = this.#unattendedTail.then(() => this.#applyUnattendedNow());
    this.#unattendedTail = run.catch(() => {});
    return run;
  }

  /** @returns {Promise<void>} */
  async #applyUnattendedNow() {
    const on = this.#unattended();
    const lives = [...this.#live.values()].filter((live) => !live.closing && live.query);
    await Promise.all(lives.map((live) => this.#applyUnattendedTo(live, on)));
  }

  /**
   * @param {LiveRecord} live
   * @param {boolean} on the switch's value when the change was made
   * @returns {Promise<void>} never rejects
   */
  async #applyUnattendedTo(live, on) {
    try {
      await (on ? this.#switchOn(live) : this.#switchOff(live));
    } catch (error) {
      this.#log.warn('could not apply the unattended mode to a session', {
        sessionId: live.sessionId,
        reason: errorName(error),
      });
    }
  }

  /**
   * Holds one query in bypassPermissions, remembering the mode it runs now as the one it returns to, and answers the
   * requests it already has. A query the switch already holds keeps the mode it returns to.
   * @param {LiveRecord} live
   * @returns {Promise<void>}
   */
  async #switchOn(live) {
    if (!live.unattended) {
      live.unattended = true;
      live.modeBeforeUnattended = live.permissionMode;
      await this.#setRuntimeMode(live, 'bypassPermissions');
    }
    this.#answerPendingAutomatically(live.sessionId);
  }

  /**
   * Returns one query to the mode it had before the switch held it. If the runtime refuses that, the query is closed
   * rather than left in bypass mode with the switch off.
   * @param {LiveRecord} live
   * @returns {Promise<void>}
   */
  async #switchOff(live) {
    if (!live.unattended) return;
    live.unattended = false;
    const target = live.modeBeforeUnattended ?? 'default';
    live.modeBeforeUnattended = null;
    const restored = await this.#setRuntimeMode(live, target);
    if (!restored && !live.closing) await this.#detach(live, { publish: true });
  }

  /**
   * Sets the permission mode of a live query. A failure is logged with the error name only.
   * @param {LiveRecord} live
   * @param {PermissionMode} mode
   * @returns {Promise<boolean>} whether the runtime took the mode
   */
  async #setRuntimeMode(live, mode) {
    try {
      await withTimeout(() => /** @type {SdkQuery} */ (live.query).setPermissionMode(mode));
      live.permissionMode = mode;
      return true;
    } catch (error) {
      this.#log.warn('could not change the permission mode of a session', {
        sessionId: live.sessionId,
        reason: errorName(error),
      });
      return false;
    } finally {
      this.#sync(live);
    }
  }

  /**
   * Answers every request of a session that is still waiting, with the gateway's own answers.
   * @param {string} sessionId
   */
  #answerPendingAutomatically(sessionId) {
    for (const request of this.#requests.list(sessionId)) this.#requests.answerAutomatically(sessionId, request.id);
  }

  /**
   * A mode a person chooses while the switch holds a query in bypass is kept for when the switch turns off. The query
   * keeps running in bypass.
   * @param {LiveRecord} live
   * @param {PermissionMode} mode
   */
  #chooseWhileUnattended(live, mode) {
    live.modeBeforeUnattended = mode;
    this.#remember(live.sessionId, { permissionMode: mode });
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
   * @param {number} [ms]     the time limit; the control timeout when omitted
   * @returns {Promise<T>}
   */
  async #control(sessionId, call, message, ms) {
    try {
      return await withTimeout(call, ms);
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
  async createSession({ cwd, title, ...rest }) {
    if (typeof cwd !== 'string' || cwd === '') throw badRequest('The cwd must be a path.');
    const settings = parseSettings(rest, this.#browserAvailable());
    const titleText = title === undefined ? '' : parseText(title, 'title', TITLE_MAX);
    if (!(await this.#withinRoots(cwd))) throw outsideRoots();
    if (settings.additionalDirectories !== undefined) {
      settings.additionalDirectories = await this.#resolveDirectories(settings.additionalDirectories);
    }
    const trusted = await this.#trustOf(cwd);
    const live = await this.#startQuery({
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
    const parsed = parseSettings(settings, this.#browserAvailable());
    if (parsed.permissionMode !== undefined) this.#assertBypassAllowed(parsed.permissionMode);
    if (parsed.additionalDirectories !== undefined) {
      parsed.additionalDirectories = await this.#resolveDirectories(parsed.additionalDirectories);
    }
    this.#assertNotLocked(sessionId);
    // Registered at once, so a close or lock that is requested after this open waits for it.
    const live = await this.#exclusive(sessionId, async () => {
      const current = await this.#openLive(sessionId);
      if (!current) return this.#resumeLive(sessionId, parsed);
      return (await this.#applySettings(current, parsed)).record;
    });
    return this.#info(live);
  }

  /**
   * Closes the live query of a session. Pending requests are cancelled. Closing a session that is not open is a no-op,
   * unless its file lies outside the roots, which answers as not found.
   * @param {string} sessionId
   */
  async closeSession(sessionId) {
    requireSessionId(sessionId);
    await this.#exclusive(sessionId, async () => {
      const live = await this.#openLive(sessionId);
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
      // A prompt that finds no turn running starts one, and a compaction in that turn is manual when the prompt is
      // /compact. A prompt sent while a turn runs waits behind it and starts none.
      if (live.state !== 'running' && live.state !== 'requires_action') live.compactPrompt = isCompactPrompt(text);
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
   * Interrupts the running turn. Not open means nothing is running, so it is a no-op. With `cancelQueued` the runtime
   * also drops the messages queued behind the turn; each one it drops is published as message_cancelled.
   * @param {string} sessionId
   * @param {{cancelQueued?: boolean}} [options]
   * @returns {Promise<{stillQueued: string[], cancelled: string[]}>}
   */
  async interrupt(sessionId, { cancelQueued } = {}) {
    requireSessionId(sessionId);
    if (cancelQueued !== undefined && typeof cancelQueued !== 'boolean') {
      throw badRequest('cancelQueued must be a boolean.');
    }
    const live = await this.#openLive(sessionId);
    if (!live) return { stillQueued: [], cancelled: [] };
    const receipt = await this.#control(sessionId, () => interruptRuntime(live.query, cancelQueued === true),
      'The turn could not be interrupted.');
    const outcome = interruptReceipt(receipt);
    for (const clientMessageId of outcome.cancelled) {
      this.#publish({ type: 'message_cancelled', data: { sessionId, clientMessageId } });
    }
    return outcome;
  }

  /**
   * Removes one message that waits in the runtime's queue behind a running turn.
   * @param {string} sessionId
   * @param {string} clientMessageId
   * @returns {Promise<{cancelled: boolean}>}
   */
  async cancelQueued(sessionId, clientMessageId) {
    requireSessionId(sessionId);
    if (!isUuid(clientMessageId)) throw badRequest('The clientMessageId must be a UUID.');
    const live = await this.#requireLive(sessionId);
    const cancel = methodOf(live.query, 'cancelAsyncMessage', 'This runtime cannot cancel a queued message.');
    const cancelled = await this.#control(sessionId, () => cancel(clientMessageId),
      'The queued message could not be cancelled.');
    if (cancelled !== true) return { cancelled: false };
    this.#publish({ type: 'message_cancelled', data: { sessionId, clientMessageId } });
    return { cancelled: true };
  }

  /**
   * Applies the given settings to the live query and remembers them for the next start. Settings of a session that
   * is not open are only remembered. Runs in the session's lifecycle queue, so it waits for an open or a restart.
   * @param {string} sessionId
   * @param {SessionSettings} settings
   * @returns {Promise<{live: LiveInfo|null, restartRequired: boolean}>}
   */
  async updateSettings(sessionId, settings) {
    requireSessionId(sessionId);
    const parsed = parseSettings(settings, this.#browserAvailable());
    if (parsed.permissionMode !== undefined) this.#assertBypassAllowed(parsed.permissionMode);
    if (parsed.additionalDirectories !== undefined) {
      parsed.additionalDirectories = await this.#resolveDirectories(parsed.additionalDirectories);
    }
    return this.#exclusive(sessionId, () => this.#updateNow(sessionId, parsed));
  }

  /**
   * @param {string} sessionId
   * @param {SessionSettings} parsed
   * @returns {Promise<{live: LiveInfo|null, restartRequired: boolean}>}
   */
  async #updateNow(sessionId, parsed) {
    const live = await this.#openLive(sessionId);
    if (!live) {
      await this.#scopeOf(sessionId, true);
      this.#remember(sessionId, parsed);
      return { live: null, restartRequired: false };
    }
    const applied = await this.#applySettings(live, parsed);
    return { live: this.#info(applied.record), restartRequired: applied.restartRequired };
  }

  /**
   * Applies settings to a live query and remembers them. A change of the additional folders restarts the query, at the
   * end and only between turns. A change of the fallback model is remembered and takes effect at the next start.
   * @param {LiveRecord} live
   * @param {SessionSettings} parsed
   * @returns {Promise<{record: LiveRecord, restartRequired: boolean}>}
   */
  async #applySettings(live, parsed) {
    const { sessionId } = live;
    if (parsed.permissionMode === null) {
      throw badRequest('Null (settings decide) applies only to a session that is not open.');
    }
    const folders = parsed.additionalDirectories === undefined
      ? null
      : dirsForCwd(parsed.additionalDirectories, live.cwd);
    const restart = folders !== null && !sameList(folders, live.additionalDirectories);
    if (restart) this.#assertRestartable(live);
    if (parsed.model !== undefined) {
      const model = parsed.model;
      await this.#control(sessionId, () => live.query.setModel(model ?? undefined),
        'The model could not be changed.');
      live.model = model;
      this.#remember(sessionId, { model });
      this.#sync(live);
      // The window may belong to the new model, so it is read again.
      void this.#refreshContext(live, { transcript: false });
    }
    if (parsed.permissionMode !== undefined) {
      const mode = parsed.permissionMode;
      if (live.unattended) {
        // The query keeps running in bypassPermissions; the mode is the one it returns to when the switch turns off.
        this.#chooseWhileUnattended(live, mode);
      } else {
        await this.#control(sessionId, () => live.query.setPermissionMode(mode),
          'The permission mode could not be changed.');
        live.permissionMode = mode;
        this.#remember(sessionId, { permissionMode: mode });
        this.#sync(live);
      }
    }
    if (parsed.effort !== undefined) {
      const effort = parsed.effort;
      await this.#control(sessionId, () => live.query.applyFlagSettings({ effortLevel: effort }),
        'The effort level could not be changed.');
      live.effort = effort;
      this.#remember(sessionId, { effort });
      this.#sync(live);
    }
    if (parsed.fastMode !== undefined) {
      const fastMode = parsed.fastMode;
      await this.#control(sessionId, () => live.query.applyFlagSettings({ fastMode }),
        'The fast mode could not be changed.');
      live.fastMode = fastMode;
      this.#remember(sessionId, { fastMode });
      this.#sync(live);
    }
    if (parsed.agent !== undefined) await this.#applyAgent(live, parsed.agent);
    if (parsed.browserTools !== undefined) await this.#applyBrowserTools(live, parsed.browserTools);
    const fallback = parsed.fallbackModel;
    const restartRequired = fallback !== undefined && fallback !== live.fallbackModel;
    if (fallback !== undefined) this.#remember(sessionId, { fallbackModel: fallback });
    if (folders !== null) this.#remember(sessionId, { additionalDirectories: folders });
    if (!restart) return { record: live, restartRequired };
    const record = await this.#restartNow(sessionId, undefined, { additionalDirectories: folders });
    return { record, restartRequired: false };
  }

  /**
   * A rewind changes the files or restarts the query, and a restart would drop the turn that is still running. Every
   * rewind, a dry run included, waits until the running turn has stopped and no request is waiting.
   * @param {string} sessionId
   */
  #assertRewindable(sessionId) {
    const live = this.#live.get(sessionId);
    if (live === undefined) return;
    if (live.state === 'running' || live.state === 'requires_action' || this.#requests.count(sessionId) > 0) {
      throw new AppError(409, 'CONFLICT', 'Stop the running turn before rewinding this session.');
    }
  }

  /**
   * A query can restart only between turns, with no request waiting.
   * @param {LiveRecord} live
   */
  #assertRestartable(live) {
    if (live.state === 'running' || live.state === 'requires_action' || this.#requests.count(live.sessionId) > 0) {
      throw new AppError(409, 'CONFLICT', 'Wait for the turn to finish before changing the folders of this session.');
    }
  }

  /**
   * Changes the main-thread agent of a live query. The runtime's answer to a name it refuses is shown.
   * @param {LiveRecord} live
   * @param {string|null} agent
   */
  async #applyAgent(live, agent) {
    try {
      await withTimeout(() => applyFlags(live.query, { agent }));
    } catch (error) {
      if (error instanceof ControlTimeout) throw engineError(TIMEOUT_MESSAGE);
      throw invalid(firstLine(messageOf(error), 'The agent could not be changed.'));
    }
    live.agent = agent;
    this.#remember(live.sessionId, { agent });
    this.#sync(live);
  }

  /**
   * Attaches or detaches the operator's browser MCP server of a live query.
   * @param {LiveRecord} live
   * @param {boolean} enabled
   */
  async #applyBrowserTools(live, enabled) {
    const servers = enabled ? this.#browserServers() : {};
    await this.#control(live.sessionId, () => live.query.setMcpServers(servers),
      'The browser tools could not be changed.');
    live.browserTools = enabled;
    live.capsCache = null;
    this.#remember(live.sessionId, { browserTools: enabled });
    this.#sync(live);
  }

  /**
   * Answers a pending request. Validation happens in the registry; an invalid answer leaves the request pending. A
   * session outside the roots answers as not found.
   * @param {string} sessionId
   * @param {string} requestId
   * @param {Record<string, unknown>} body
   */
  async respond(sessionId, requestId, body) {
    requireSessionId(sessionId);
    const id = parseToken(requestId, 'The request id');
    await this.#openLive(sessionId);
    this.#requests.respond(sessionId, id, body);
  }

  /**
   * The context usage of a live session. `full` counts each category with the token-count API and has its own limit.
   * @param {string} sessionId
   * @param {'summary'|'full'} [detail]
   * @returns {Promise<ContextUsage>}
   */
  async getContextUsage(sessionId, detail) {
    requireSessionId(sessionId);
    const mode = parseDetail(detail);
    const live = await this.#requireLive(sessionId);
    return this.#control(sessionId, () => live.query.getContextUsage({ detail: mode }),
      'The context usage could not be read.', mode === 'full' ? CONTEXT_FULL_MS : undefined);
  }

  /**
   * Toggles, reconnects or sets the permission-mode override of one MCP server of a live session, and returns the
   * status of all servers. `warning` is the runtime's note when no connected server has that name.
   * @param {string} sessionId
   * @param {string} server
   * @param {{action: 'toggle'|'reconnect'|'permission-mode', enabled?: boolean, mode?: 'default'|'auto'|null}} action
   * @returns {Promise<{mcpServers: McpServerStatus[], warning?: string}>}
   */
  async mcpAction(sessionId, server, action) {
    requireSessionId(sessionId);
    const name = parseToken(server, 'The server name');
    const { kind, enabled, mode } = parseMcpAction(action);
    const live = await this.#requireLive(sessionId);
    /** @type {string|undefined} */
    let warning;
    if (kind === 'permission-mode') {
      const answer = await this.#control(sessionId, () => live.query.setMcpPermissionModeOverride(name, mode),
        'The MCP permission mode could not be changed.');
      warning = typeof answer?.warning === 'string' ? answer.warning : undefined;
    } else if (kind === 'toggle') {
      await this.#control(sessionId, () => live.query.toggleMcpServer(name, enabled),
        'The MCP server could not be updated.');
    } else {
      await this.#control(sessionId, () => live.query.reconnectMcpServer(name),
        'The MCP server could not be updated.');
    }
    live.capsCache = null;
    const status = await this.#control(sessionId, () => live.query.mcpServerStatus(),
      'The MCP server status could not be read.');
    const mcpServers = /** @type {McpServerStatus[]} */ (redactMcpServers(status));
    return warning === undefined ? { mcpServers } : { mcpServers, warning };
  }

  /**
   * The terminal's /mcp authentication of one server: start the sign-in, submit the address the browser landed on, or
   * clear the stored credentials.
   * @param {string} sessionId
   * @param {string} server
   * @param {{action: 'start'|'callback'|'clear', callbackUrl?: string}} action
   * @returns {Promise<Record<string, unknown>>}
   */
  async mcpAuth(sessionId, server, action) {
    requireSessionId(sessionId);
    const name = parseToken(server, 'The server name');
    const { kind, callbackUrl } = parseMcpAuth(action);
    const live = await this.#requireLive(sessionId);
    /** @type {Record<string, unknown>} */
    let answer;
    if (kind === 'start') answer = await this.#mcpStart(live, name);
    else if (kind === 'callback') answer = await this.#mcpCallback(live, name, callbackUrl);
    else answer = await this.#mcpClear(live, name);
    live.capsCache = null;
    return answer;
  }

  /**
   * The runtime views the live query offers (see RUNTIME_VIEWS).
   * @param {string} sessionId
   * @returns {Promise<{views: string[]}>}
   */
  async runtimeViews(sessionId) {
    requireSessionId(sessionId);
    const live = await this.#requireLive(sessionId);
    return { views: availableViews(live.query) };
  }

  /**
   * One read-only runtime view. The caller has checked the access profile of the view.
   * @param {string} sessionId
   * @param {string} view
   * @returns {Promise<{view: string, data: unknown, fetchedAt: number}>}
   */
  async runtimeView(sessionId, view) {
    requireSessionId(sessionId);
    if (!Object.hasOwn(RUNTIME_VIEWS, view)) throw new AppError(404, 'NOT_FOUND', 'The runtime view is not known.');
    const spec = RUNTIME_VIEWS[view];
    const live = await this.#requireLive(sessionId);
    const call = methodOf(live.query, spec.method, 'This runtime does not offer this view.');
    const answer = await this.#control(sessionId, () => call(...viewArguments(view)),
      'The runtime view could not be read.', spec.timeoutMs);
    return { view, data: redactView(view, answer), fetchedAt: this.#now() };
  }

  /**
   * The memory files the runtime lists for the live session, each with its content up to the size limit.
   * @param {string} sessionId
   * @returns {Promise<{files: MemoryFile[], folders: unknown[], autoMemory: unknown, autoDream: unknown}>}
   */
  async getMemory(sessionId) {
    requireSessionId(sessionId);
    const live = await this.#requireLive(sessionId);
    const dialog = await this.#memoryDialog(live);
    const files = await Promise.all(listedMemoryFiles(dialog).map((file) => this.#memoryFile(live, file)));
    const source = isPlainObject(dialog) ? dialog : {};
    return {
      files,
      folders: Array.isArray(source.folders) ? source.folders : [],
      autoMemory: source.auto_memory ?? null,
      autoDream: source.auto_dream ?? null,
    };
  }

  /**
   * Saves one memory file that the runtime lists for the live session as editable.
   * @param {string} sessionId
   * @param {string} file
   * @param {string} content
   * @returns {Promise<{bytes: number}>}
   */
  async writeMemory(sessionId, file, content) {
    requireSessionId(sessionId);
    if (typeof file !== 'string' || file === '' || file.length > PATH_MAX) {
      throw badRequest('The memory file is not valid.');
    }
    if (typeof content !== 'string') throw badRequest('The content must be a string.');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MEMORY_MAX_BYTES) {
      throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'The memory file is larger than 256 KiB.');
    }
    const live = await this.#requireLive(sessionId);
    const listed = listedMemoryFiles(await this.#memoryDialog(live)).some((entry) => entry.path === file);
    if (!listed) throw new AppError(422, 'PATH_NOT_ALLOWED', 'This memory file cannot be saved.');
    try {
      await writeMemoryFile(file, content, this.#memoryLocations());
    } catch (error) {
      if (error instanceof AppError) throw error;
      this.#log.warn('saving a memory file failed', { sessionId, reason: errorName(error) });
      throw new AppError(500, 'INTERNAL', 'The memory file could not be saved.');
    }
    return { bytes };
  }

  /**
   * The conversation as plain text, under the runtime's own file name.
   * @param {string} sessionId
   * @returns {Promise<{text: string, filename: string}>}
   */
  async exportConversation(sessionId) {
    requireSessionId(sessionId);
    const live = await this.#requireLive(sessionId);
    const exportCall = methodOf(live.query, 'exportConversation', 'This runtime cannot export the conversation.');
    const answer = await this.#control(sessionId, () => exportCall(), 'The conversation could not be exported.');
    const source = isPlainObject(answer) ? answer : {};
    return {
      text: typeof source.text === 'string' ? source.text : '',
      filename: exportFilename(source.default_filename),
    };
  }

  /**
   * The end of the output of a shell or Monitor task of the live session.
   * @param {string} sessionId
   * @param {string} taskId
   * @returns {Promise<{output: string, totalBytes: number, truncated: boolean}>}
   */
  async taskOutput(sessionId, taskId) {
    requireSessionId(sessionId);
    const id = parseToken(taskId, 'The task id');
    const live = await this.#requireLive(sessionId);
    const read = methodOf(live.query, 'getTaskOutput', 'This runtime cannot read task output.');
    let answer;
    try {
      answer = await withTimeout(() => read(id));
    } catch (error) {
      const reason = messageOf(error);
      if (reason.includes(UNKNOWN_TASK)) throw new AppError(404, 'NOT_FOUND', firstLine(reason, 'Task not found.'));
      throw this.#failure(sessionId, error, 'The task output could not be read.');
    }
    const source = isPlainObject(answer) ? answer : {};
    return {
      output: typeof source.output === 'string' ? source.output : '',
      totalBytes: typeof source.total_bytes === 'number' ? source.total_bytes : 0,
      truncated: source.truncated === true,
    };
  }

  /**
   * A side question, answered by the model without a turn in the transcript. One at a time per session.
   * @param {string} sessionId
   * @param {string} question
   * @returns {Promise<SideAnswer>}
   */
  async sideQuestion(sessionId, question) {
    requireSessionId(sessionId);
    const text = parseQuestion(question);
    this.#assertNotLocked(sessionId);
    if (this.#sideQuestions.has(sessionId)) {
      throw new AppError(409, 'CONFLICT', 'A side question is already being answered.');
    }
    this.#sideQuestions.add(sessionId);
    try {
      const live = await this.#ensureLive(sessionId);
      const ask = methodOf(live.query, 'askSideQuestion', 'This runtime cannot answer side questions.');
      let answer;
      try {
        answer = await withTimeout(() => ask(text), SIDE_QUESTION_MS);
      } catch (error) {
        throw this.#failure(sessionId, error, 'The side question could not be answered.');
      }
      return sideAnswerOf(answer);
    } finally {
      this.#sideQuestions.delete(sessionId);
    }
  }

  /**
   * The runtime's `@` index for a live session in its own folder, through its generic control call. Null when the
   * runtime cannot answer: not live, another folder, the call is missing, fails or times out, or finds nothing.
   * @param {string} sessionId
   * @param {string} cwd
   * @param {string} query
   * @param {number} limit
   * @returns {Promise<Array<{path: string, type: 'file'|'dir'}>|null>}
   */
  async fileSuggestions(sessionId, cwd, query, limit) {
    const live = this.#live.get(sessionId);
    if (!live || live.closing) return null;
    if (!(await sameDirectory(live.cwd, cwd)) || !(await this.#withinRoots(live.cwd))) return null;
    const request = runtimeMethod(live.query, 'request');
    if (request === null) return null;
    try {
      const answer = await withTimeout(() => request({ subtype: 'file_suggestions', query }), FILE_SUGGESTIONS_MS);
      const results = fileSuggestionsOf(answer, limit);
      return results.length > 0 ? results : null;
    } catch (error) {
      this.#log.debug('file suggestions failed', { sessionId, reason: errorName(error) });
      return null;
    }
  }

  /**
   * Records a folder's trust in Claude Code's own record (see trust.mjs). The caller has checked the folder.
   * @param {string} dir
   * @returns {Promise<RuntimeTrust>}
   */
  recordRuntimeTrust(dir) {
    return this.#trust.record(dir);
  }

  /**
   * The query of a live session that is not closing, for reads that need no particular session (the account).
   * @returns {SdkQuery|null}
   */
  anyLiveQuery() {
    for (const live of this.#live.values()) {
      if (!live.closing && live.query) return live.query;
    }
    return null;
  }

  /** Drops every cached capability answer, after the signed-in account changed. */
  forgetCapabilities() {
    this.#capsGlobal = null;
    this.#capsByCwd.clear();
    for (const live of this.#live.values()) live.capsCache = null;
  }

  /**
   * @param {LiveRecord} live
   * @param {string} name
   * @returns {Promise<Record<string, unknown>>}
   */
  async #mcpStart(live, name) {
    const start = methodOf(live.query, 'mcpAuthenticate', 'This runtime cannot authenticate MCP servers.');
    const answer = await this.#authCall(live, () => start(name));
    const source = isPlainObject(answer) ? answer : {};
    const hasAddress = source.authUrl !== undefined && source.authUrl !== null;
    if (hasAddress && !isWebUrl(source.authUrl, AUTH_URL_MAX, WEB_PROTOCOLS)) {
      throw engineError('The sign-in address of the server is not usable.');
    }
    return {
      authUrl: hasAddress ? source.authUrl : null,
      requiresUserAction: source.requiresUserAction === true,
      callbackExpected: source.callbackExpected === true,
      redirectScheme: source.redirectScheme === 'localhost' || source.redirectScheme === 'custom'
        ? source.redirectScheme
        : null,
      callbackPort: typeof source.callbackPort === 'number' ? source.callbackPort : null,
    };
  }

  /**
   * @param {LiveRecord} live
   * @param {string} name
   * @param {string|null} callbackUrl
   * @returns {Promise<Record<string, unknown>>}
   */
  async #mcpCallback(live, name, callbackUrl) {
    const submit = methodOf(live.query, 'mcpSubmitOAuthCallbackUrl', 'This runtime cannot complete MCP sign-in.');
    await this.#authCall(live, () => submit(name, callbackUrl));
    return { ok: true };
  }

  /**
   * @param {LiveRecord} live
   * @param {string} name
   * @returns {Promise<Record<string, unknown>>}
   */
  async #mcpClear(live, name) {
    const clear = methodOf(live.query, 'mcpClearAuth', 'This runtime cannot clear MCP credentials.');
    await this.#authCall(live, () => clear(name));
    return { ok: true };
  }

  /**
   * One MCP authentication call under the control timeout. A failure is logged without its content.
   * @param {LiveRecord} live
   * @param {() => Promise<unknown>} call
   * @returns {Promise<unknown>}
   */
  async #authCall(live, call) {
    try {
      return await withTimeout(call);
    } catch (error) {
      this.#log.warn('MCP authentication call failed', { sessionId: live.sessionId, reason: errorName(error) });
      throw authFailure(error, 'The server could not be authenticated.');
    }
  }

  /**
   * @param {LiveRecord} live
   * @returns {Promise<unknown>} the runtime's memory dialog
   */
  async #memoryDialog(live) {
    const dialog = methodOf(live.query, 'getMemoryDialog', 'This runtime does not list memory files.');
    return this.#control(live.sessionId, () => dialog(), 'The memory files could not be read.');
  }

  /**
   * One listed memory file with its content. A file the runtime refuses to read has no content.
   * @param {LiveRecord} live
   * @param {{kind: string, path: string, label: string, description: string, exists: boolean}} file
   * @returns {Promise<MemoryFile>}
   */
  async #memoryFile(live, file) {
    const read = methodOf(live.query, 'readFile', 'This runtime cannot read memory files.');
    const answer = await withTimeout(() => read(file.path, { maxBytes: MEMORY_MAX_BYTES })).catch(() => null);
    const source = isPlainObject(answer) ? answer : {};
    return {
      kind: file.kind,
      path: file.path,
      label: file.label,
      description: file.description,
      exists: file.exists,
      content: typeof source.contents === 'string' ? source.contents : null,
      truncated: source.truncated === true,
      editable: await isEditableMemoryFile(file.path, this.#memoryLocations()),
    };
  }

  /** @returns {{roots: string[], home: string}} where the gateway may save memory files */
  #memoryLocations() {
    return { roots: this.#config.roots, home: this.#homeDir };
  }

  /**
   * Reloads plugins, skills or output styles of a live session, as the terminal's reload commands do. Plugins are held
   * when applying them would change the tool list the prompt cache depends on, unless `force` is set.
   * @param {string} sessionId
   * @param {'plugins'|'skills'|'output-styles'} what
   * @param {{force?: boolean}} [options]
   * @returns {Promise<ReloadResult>}
   */
  async reload(sessionId, what, { force } = {}) {
    requireSessionId(sessionId);
    if (!includes(RELOAD_TARGETS, what)) throw invalid('The reload target must be plugins, skills or output-styles.');
    if (force !== undefined && (typeof force !== 'boolean' || what !== 'plugins')) {
      throw badRequest('force is a boolean and applies to plugins only.');
    }
    const live = await this.#requireLive(sessionId);
    if (what === 'plugins') return this.#reloadPlugins(live, force === true);
    if (what === 'output-styles') return this.#reloadOutputStyles(live);
    await this.#control(sessionId, () => live.query.reloadSkills(), 'The session could not be reloaded.');
    live.capsCache = null;
    return { ok: true };
  }

  /**
   * @param {LiveRecord} live
   * @param {boolean} force
   * @returns {Promise<ReloadResult>}
   */
  async #reloadPlugins(live, force) {
    const answer = await this.#control(live.sessionId,
      () => (force ? live.query.reloadPlugins() : live.query.reloadPlugins({ holdOnCacheImpact: true })),
      'The session could not be reloaded.');
    if (answer?.held === true) {
      // Nothing was applied, so the capabilities the session reports are still right and stay cached.
      return { ok: false, held: true, cacheImpact: cacheImpactOf(answer.cache_impact) };
    }
    live.capsCache = null;
    return { ok: true };
  }

  /**
   * @param {LiveRecord} live
   * @returns {Promise<ReloadResult>}
   */
  async #reloadOutputStyles(live) {
    const answer = await this.#control(live.sessionId, () => live.query.reloadOutputStyles(),
      'The output styles could not be reloaded.');
    const availableOutputStyles = outputStylesOf(answer?.available_output_styles);
    live.capsCache = null;
    this.#patchRemembered(live.cwd, { availableOutputStyles });
    return { ok: true, availableOutputStyles };
  }

  /**
   * Applies a change to the capabilities last known for a folder, when there are any.
   * @param {string} cwd
   * @param {Partial<Capabilities>} patch
   */
  #patchRemembered(cwd, patch) {
    const remembered = this.#capsByCwd.get(cwd);
    if (remembered) this.#capsByCwd.set(cwd, { ...remembered, ...patch });
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
    this.#assertRewindable(sessionId);
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
    this.#assertRewindable(sessionId);
    const resumeAt = mode === 'code' ? undefined : await this.#rewindTarget(sessionId, messageId, info);
    /** @type {{files?: RewindFilesResult, conversation?: {resumeAt: string}}} */
    const result = {};
    if (mode !== 'conversation') {
      const live = (await this.#openLive(sessionId)) ?? (await this.#resumeLive(sessionId, {}));
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
   * Stops the live query of a session, if any, and starts it again with the settings it had, changed by `overrides`,
   * and at an earlier entry of the conversation when `resumeAt` is given. The stop is not reported as the end of the
   * session, and the old query is fully stopped before the new one starts. Runs inside the session's lifecycle queue,
   * so it never waits for the session again.
   * @param {string} sessionId
   * @param {string|undefined} resumeAt
   * @param {SessionSettings} [overrides]
   * @returns {Promise<LiveRecord>}
   */
  async #restartNow(sessionId, resumeAt, overrides = {}) {
    const previous = await this.#openLive(sessionId);
    /** @type {string} */
    let cwd;
    /** @type {SessionSettings} */
    let settings = overrides;
    if (previous) {
      cwd = previous.cwd;
      const remembered = this.#pending.get(sessionId) ?? {};
      // The mode the session chose, not the one the unattended switch holds the query in (see LiveRecord).
      const chosen = previous.unattended ? previous.modeBeforeUnattended : previous.permissionMode;
      settings = {
        model: previous.model,
        // A null mode is not passed, so the settings the session remembers, or Claude Code's own, decide.
        ...(chosen !== null ? { permissionMode: chosen } : {}),
        effort: previous.effort,
        fastMode: previous.fastMode,
        agent: previous.agent,
        additionalDirectories: previous.additionalDirectories,
        // A fallback model changed while the query runs is only remembered; the restart is what applies it.
        fallbackModel: remembered.fallbackModel !== undefined ? remembered.fallbackModel : previous.fallbackModel,
        browserTools: previous.browserTools,
        ...overrides,
      };
      await this.#detach(previous, { publish: false });
    } else {
      const { info } = await this.#scopeOf(sessionId);
      cwd = /** @type {string} */ (info?.cwd);
    }
    this.#assertNotLocked(sessionId);
    const trusted = await this.#trustOf(cwd);
    this.#assertNotLocked(sessionId);
    return this.#startQuery({ mode: 'resume', sessionId, cwd, trusted, settings, resumeSessionAt: resumeAt });
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
    const live = await this.#requireLive(sessionId);
    await this.#control(sessionId, () => live.query.stopTask(id), 'The task could not be stopped.');
  }

  /**
   * Moves the foreground Bash command or subagent that one tool call started to the background, or every foreground
   * task without an id: the terminal's Ctrl+B. The blocked tool call returns at once and the turn goes on.
   * @param {string} sessionId
   * @param {string} [toolUseId]
   * @returns {Promise<{backgrounded: boolean}>}
   */
  async backgroundTasks(sessionId, toolUseId) {
    requireSessionId(sessionId);
    const id = toolUseId === undefined ? undefined : parseToken(toolUseId, 'The tool use id');
    this.#assertNotLocked(sessionId);
    const live = await this.#requireLive(sessionId);
    if (this.#config.backgroundTasksDisabled) {
      throw new AppError(501, 'FEATURE_DISABLED', BACKGROUND_DISABLED_MESSAGE);
    }
    const backgrounded = await this.#control(sessionId, () => live.query.backgroundTasks(id),
      'The tasks could not be moved to the background.');
    return { backgrounded: backgrounded === true };
  }

  /**
   * Changes the output style of a live session through the runtime's own settings writer (the terminal's /config):
   * the project's local settings, which the runtime loads only for a trusted folder.
   * @param {string} sessionId
   * @param {string} style
   * @returns {Promise<{outputStyle: string, availableOutputStyles: string[]}>}
   */
  async setOutputStyle(sessionId, style) {
    requireSessionId(sessionId);
    const name = parseOutputStyle(style);
    this.#assertNotLocked(sessionId);
    const live = await this.#requireLive(sessionId);
    if (!live.trusted) throw new AppError(409, 'CONFLICT', 'Trust this folder to change its output style.');
    const capabilities = await this.#liveCapabilities(live);
    // Capabilities the runtime did not answer for are the last known ones; a style check against them would blame the
    // client for the runtime's silence.
    if (capabilities.stale) throw engineError('The output styles could not be read.');
    if (!capabilities.availableOutputStyles.includes(name)) {
      throw invalid('The output style is not one of the styles this session offers.');
    }
    await this.#control(sessionId, () => live.query.updateSettings('localSettings', { outputStyle: name }),
      'The output style could not be changed.');
    if (live.capsCache) {
      live.capsCache = { ...live.capsCache, value: { ...live.capsCache.value, outputStyle: name } };
    }
    this.#patchRemembered(live.cwd, { outputStyle: name });
    return { outputStyle: name, availableOutputStyles: [...capabilities.availableOutputStyles] };
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
   * Closes live sessions that have been idle, without pending requests, for longer than the idle timeout. Live queries
   * whose folder left the workspace roots are closed too, whether or not anything still touches them.
   * @param {number} [now]
   * @returns {Promise<number>} how many sessions were closed
   */
  async sweepIdle(now = this.#now()) {
    const timeout = this.#config.idleTimeoutMs;
    const outside = await this.#closeOutsideRoots();
    if (outside > 0) this.#log.info('closed sessions outside the roots', { count: outside });
    const idle = [...this.#live.values()].filter((live) => live.state === 'idle'
      && this.#requests.count(live.sessionId) === 0
      && live.backgroundTasks === 0
      && !this.#opening.has(live.sessionId)
      && now - live.lastActivity > timeout);
    await Promise.all(idle.map((live) => this.#detach(live, { publish: true })));
    if (idle.length > 0) this.#log.info('closed idle sessions', { count: idle.length });
    return outside + idle.length;
  }

  /**
   * Closes every live query whose folder is outside the workspace roots. Sessions with a lifecycle operation in flight
   * are left to that operation, which checks the roots itself.
   * @returns {Promise<number>} how many queries were closed
   */
  async #closeOutsideRoots() {
    const outside = [];
    for (const live of [...this.#live.values()]) {
      if (!(await this.#withinRoots(live.cwd))) outside.push(live);
    }
    const stale = outside.filter((live) => this.#live.get(live.sessionId) === live
      && !this.#opening.has(live.sessionId));
    await Promise.all(stale.map((live) => this.#detach(live, { publish: true })));
    return stale.length;
  }

  /**
   * Stops the sweep, closes every live query, stops the trust probes in flight and cancels every pending request.
   * Safe to call twice.
   */
  async shutdown() {
    clearInterval(this.#sweepTimer);
    this.#stopped = true;
    this.#requests.cancelAll();
    await Promise.all([...this.#live.values()].map((live) => this.#detach(live, { publish: true })));
    await this.#trust.close();
  }
}
