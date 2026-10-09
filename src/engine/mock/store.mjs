// @ts-check
/**
 * File-backed session store for the mock engine.
 *
 * Each session is one JSON document at `<dir>/<sessionId>.json`. The directory is created with mode 0700 and every
 * file with mode 0600. Writes go to a temporary file in the same directory that is renamed over the target, so a
 * reader never observes a partial document. The synchronous helpers (`read`, `create`, `update`) complete each
 * read-modify-write before any other engine call can interleave, because the mock runs inside one process.
 *
 * Transcript entries follow the SessionMessage shape. User and assistant entries keep their Messages API payload in
 * `message`. Persisted system entries (compact boundaries, local command output, informational notices and conversation
 * resets) keep the SDK payload in `message` (with `type`/`subtype`, without `uuid`) so readers can tell them apart.
 */
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { isUuid } from '../../contracts.mjs';

/** @typedef {import('../../contracts.mjs').SDKSessionInfo} SDKSessionInfo */

export const RECORD_VERSION = 1;

/**
 * One transcript or subagent entry. `message` is the Messages API payload for user and assistant entries.
 * @typedef {Object} MockEntry
 * @property {'user'|'assistant'|'system'} type
 * @property {string} uuid
 * @property {string} session_id
 * @property {any} message
 * @property {string|null} parent_tool_use_id
 * @property {string|null} parent_agent_id
 */

/**
 * The JSON document stored for one session.
 * @typedef {Object} MockSessionRecord
 * @property {number} version
 * @property {string} sessionId
 * @property {string} cwd
 * @property {string|null} customTitle
 * @property {string|null} tag
 * @property {number} createdAt
 * @property {number} lastModified
 * @property {string|null} firstPrompt
 * @property {string|null} generatedTitle   title the first turn gave a session without a custom title
 * @property {MockEntry[]} transcript
 * @property {Record<string, MockEntry[]>} subagents
 * @property {Record<string, number>} counters   per-session id counters used by the scenarios
 */

/**
 * @param {any} value
 * @returns {value is Record<string, any>}
 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isNullableString(value) {
  return value === null || typeof value === 'string';
}

/**
 * @param {any} entry
 * @returns {boolean}
 */
function isEntry(entry) {
  return isObject(entry) &&
    (entry.type === 'user' || entry.type === 'assistant' || entry.type === 'system') &&
    typeof entry.uuid === 'string' &&
    typeof entry.session_id === 'string' &&
    'message' in entry &&
    (entry.parent_tool_use_id === null || typeof entry.parent_tool_use_id === 'string') &&
    (entry.parent_agent_id === null || typeof entry.parent_agent_id === 'string');
}

/**
 * @param {any} data
 * @param {string} key
 * @returns {data is MockSessionRecord}
 */
function isRecord(data, key) {
  return isObject(data) &&
    data.version === RECORD_VERSION &&
    data.sessionId === key &&
    typeof data.cwd === 'string' && data.cwd !== '' &&
    isNullableString(data.customTitle) &&
    isNullableString(data.tag) &&
    isNullableString(data.firstPrompt) &&
    (data.generatedTitle === undefined || isNullableString(data.generatedTitle)) &&
    Number.isFinite(data.createdAt) &&
    Number.isFinite(data.lastModified) &&
    Array.isArray(data.transcript) && data.transcript.every(isEntry) &&
    isObject(data.subagents) &&
    Object.values(data.subagents).every((list) => Array.isArray(list) && list.every(isEntry)) &&
    isObject(data.counters) && Object.values(data.counters).every((n) => Number.isFinite(n));
}

/**
 * @param {string} key
 * @returns {Error}
 */
function invalidFile(key) {
  return new Error(`Mock session file is invalid: ${key}`);
}

/**
 * @param {string} raw
 * @param {string} key
 * @returns {MockSessionRecord}
 */
function parseRecord(raw, key) {
  /** @type {any} */
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw invalidFile(key);
  }
  if (!isRecord(data, key)) throw invalidFile(key);
  // Files written before generated titles existed have no such field.
  if (data.generatedTitle === undefined) data.generatedTitle = null;
  return data;
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isNotFound(error) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/**
 * Title or tag text: a non-empty string after trimming.
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function requireText(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

/**
 * @param {{limit?: number, offset?: number}} options
 * @returns {{limit: number|undefined, offset: number}}
 */
function pageOf(options) {
  const { limit, offset = 0 } = options;
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 0)) {
    throw new TypeError('limit must be a non-negative integer');
  }
  if (!(Number.isInteger(offset) && offset >= 0)) throw new TypeError('offset must be a non-negative integer');
  return { limit, offset };
}

/**
 * The SDK summary: the custom title, otherwise the title the first turn gave, otherwise the first prompt. Empty when
 * none exists yet.
 * @param {MockSessionRecord} record
 * @returns {string}
 */
export function summaryOf(record) {
  return record.customTitle || record.generatedTitle || record.firstPrompt || '';
}

/**
 * @param {MockSessionRecord} record
 * @param {number} fileSize
 * @returns {SDKSessionInfo}
 */
function toInfo(record, fileSize) {
  /** @type {SDKSessionInfo} */
  const info = {
    sessionId: record.sessionId,
    summary: summaryOf(record),
    lastModified: record.lastModified,
    fileSize,
    cwd: record.cwd,
    createdAt: record.createdAt,
  };
  if (record.customTitle) info.customTitle = record.customTitle;
  if (record.firstPrompt) info.firstPrompt = record.firstPrompt;
  if (record.tag) info.tag = record.tag;
  return info;
}

/**
 * Newest first: lastModified, then createdAt, then sessionId.
 * @param {{record: MockSessionRecord}} a
 * @param {{record: MockSessionRecord}} b
 * @returns {number}
 */
function newestFirst(a, b) {
  return b.record.lastModified - a.record.lastModified ||
    b.record.createdAt - a.record.createdAt ||
    (a.record.sessionId < b.record.sessionId ? -1 : a.record.sessionId > b.record.sessionId ? 1 : 0);
}

/**
 * Collects the ids of top-level tool_use blocks in the transcript.
 * @param {MockEntry[]} transcript
 * @returns {Set<string>}
 */
function topLevelToolUseIds(transcript) {
  const ids = new Set();
  for (const entry of transcript) {
    if (entry.type !== 'assistant' || entry.parent_tool_use_id !== null) continue;
    const content = Array.isArray(entry.message?.content) ? entry.message.content : [];
    for (const block of content) {
      if (block?.type === 'tool_use' && typeof block.id === 'string') ids.add(block.id);
    }
  }
  return ids;
}

/**
 * Builds a new session record with empty transcript and counters.
 * @param {{sessionId: string, cwd: string, customTitle?: string|null, now?: number}} args
 * @returns {MockSessionRecord}
 */
export function newRecord({ sessionId, cwd, customTitle = null, now = Date.now() }) {
  return {
    version: RECORD_VERSION,
    sessionId,
    cwd,
    customTitle,
    tag: null,
    createdAt: now,
    lastModified: now,
    firstPrompt: null,
    generatedTitle: null,
    transcript: [],
    subagents: {},
    counters: {},
  };
}

/**
 * Copies the transcript up to and including `upToMessageId` (all of it when omitted) together with the subagent
 * transcripts whose Agent tool call survives in the copy. Pure: the record is not modified.
 * @param {MockSessionRecord} record
 * @param {string} [upToMessageId]
 * @returns {{transcript: MockEntry[], subagents: Record<string, MockEntry[]>}}
 */
export function sliceRecord(record, upToMessageId) {
  let end = record.transcript.length;
  if (upToMessageId !== undefined) {
    const index = record.transcript.findIndex((entry) => entry.uuid === upToMessageId);
    if (index < 0) throw new Error('Message not found in session');
    end = index + 1;
  }
  const transcript = structuredClone(record.transcript.slice(0, end));
  const toolUseIds = topLevelToolUseIds(transcript);
  /** @type {Record<string, MockEntry[]>} */
  const subagents = {};
  for (const [agentId, messages] of Object.entries(record.subagents)) {
    const parent = messages[0]?.parent_tool_use_id;
    if (parent && toolUseIds.has(parent)) subagents[agentId] = structuredClone(messages);
  }
  return { transcript, subagents };
}

/**
 * Creates the file-backed session store.
 * @param {string} dir directory for the session files; created with mode 0700 when missing
 */
export function createMockStore(dir) {
  if (typeof dir !== 'string' || dir.trim() === '') throw new TypeError('createMockStore needs a directory');
  const root = resolve(dir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);

  /**
   * @param {string} sessionId
   * @returns {string|null} canonical lowercase id, or null when the value is not a UUID
   */
  function keyOf(sessionId) {
    return typeof sessionId === 'string' && isUuid(sessionId) ? sessionId.toLowerCase() : null;
  }

  /**
   * @param {string} key
   * @returns {string}
   */
  function pathOf(key) {
    return join(root, `${key}.json`);
  }

  /**
   * @param {string} sessionId
   * @returns {{record: MockSessionRecord, fileSize: number}|undefined}
   */
  function load(sessionId) {
    const key = keyOf(sessionId);
    if (key === null) return undefined;
    let raw;
    try {
      raw = readFileSync(pathOf(key), 'utf8');
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    return { record: parseRecord(raw, key), fileSize: Buffer.byteLength(raw) };
  }

  /**
   * Writes the record atomically: temporary file (mode 0600) in the same directory, then rename.
   * @param {MockSessionRecord} record
   */
  function save(record) {
    const target = pathOf(record.sessionId);
    const temp = join(root, `.${record.sessionId}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temp, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
      renameSync(temp, target);
    } catch (error) {
      removeQuietly(temp);
      throw error;
    }
  }

  /**
   * @param {string} path
   */
  function removeQuietly(path) {
    try {
      unlinkSync(path);
    } catch (error) {
      // The temporary file may never have been created; the original error is the one to report.
      if (!isNotFound(error)) throw error;
    }
  }

  /**
   * @param {MockSessionRecord} record
   */
  function stamp(record) {
    record.lastModified = Math.max(Date.now(), record.lastModified + 1);
  }

  /**
   * Creates a record file. Fails when the id is already stored.
   * @param {MockSessionRecord} record
   * @returns {MockSessionRecord}
   */
  function create(record) {
    if (keyOf(record.sessionId) !== record.sessionId) throw new TypeError('Session id must be a lowercase UUID');
    if (existsSync(pathOf(record.sessionId))) throw new Error('Session already exists');
    stamp(record);
    save(record);
    return record;
  }

  /**
   * @param {string} sessionId
   * @returns {MockSessionRecord|undefined}
   */
  function read(sessionId) {
    return load(sessionId)?.record;
  }

  /**
   * Read-modify-write of one record. `mutate` changes the record in place. A `dir` that names another project
   * directory counts as not found, as in the SDK.
   * @param {string} sessionId
   * @param {(record: MockSessionRecord) => void} mutate
   * @param {string} [dir]
   * @returns {MockSessionRecord}
   */
  function update(sessionId, mutate, dir) {
    const entry = load(sessionId);
    if (!entry || (dir !== undefined && entry.record.cwd !== dir)) throw new Error('Session not found');
    mutate(entry.record);
    stamp(entry.record);
    save(entry.record);
    return entry.record;
  }

  /**
   * Every stored record, newest first.
   * @returns {Array<{record: MockSessionRecord, fileSize: number}>}
   */
  function allEntries() {
    /** @type {Array<{record: MockSessionRecord, fileSize: number}>} */
    const entries = [];
    for (const name of readdirSync(root)) {
      if (!name.endsWith('.json')) continue;
      const entry = load(name.slice(0, -'.json'.length));
      if (entry) entries.push(entry);
    }
    return entries.sort(newestFirst);
  }

  /**
   * The most recently modified session whose cwd equals `cwd`, with or without a summary.
   * @param {string} cwd
   * @returns {MockSessionRecord|undefined}
   */
  function findLatest(cwd) {
    return allEntries().find((entry) => entry.record.cwd === cwd)?.record;
  }

  /**
   * SDK listSessions. `dir` is an exact cwd filter. Sessions without a summary are not listed yet, as in the SDK.
   * @param {{dir?: string, limit?: number, offset?: number}} [options]
   * @returns {Promise<SDKSessionInfo[]>}
   */
  async function listSessions(options = {}) {
    const { limit, offset } = pageOf(options);
    const visible = allEntries().filter((entry) =>
      (options.dir === undefined || entry.record.cwd === options.dir) && summaryOf(entry.record) !== '');
    const end = limit === undefined ? undefined : offset + limit;
    return visible.slice(offset, end).map((entry) => toInfo(entry.record, entry.fileSize));
  }

  /**
   * SDK getSessionInfo. Resolves undefined for unknown sessions and for sessions without a summary.
   * @param {string} sessionId
   * @param {{dir?: string}} [options]
   * @returns {Promise<SDKSessionInfo|undefined>}
   */
  async function getSessionInfo(sessionId, options = {}) {
    const entry = load(sessionId);
    if (!entry || summaryOf(entry.record) === '') return undefined;
    if (options.dir !== undefined && entry.record.cwd !== options.dir) return undefined;
    return toInfo(entry.record, entry.fileSize);
  }

  /**
   * SDK getSessionMessages. Resolves an empty list for unknown sessions.
   * @param {string} sessionId
   * @param {{dir?: string, limit?: number, offset?: number, includeSystemMessages?: boolean}} [options]
   * @returns {Promise<MockEntry[]>}
   */
  async function getSessionMessages(sessionId, options = {}) {
    const { limit, offset } = pageOf(options);
    const entry = load(sessionId);
    if (!entry || (options.dir !== undefined && entry.record.cwd !== options.dir)) return [];
    const messages = entry.record.transcript.filter((message) =>
      options.includeSystemMessages === true || message.type !== 'system');
    const end = limit === undefined ? undefined : offset + limit;
    return messages.slice(offset, end);
  }

  /**
   * SDK renameSession.
   * @param {string} sessionId
   * @param {string} title
   * @param {{dir?: string}} [options]
   */
  async function renameSession(sessionId, title, options = {}) {
    const customTitle = requireText(title, 'title');
    update(sessionId, (record) => {
      record.customTitle = customTitle;
    }, options.dir);
  }

  /**
   * SDK tagSession. `null` removes the tag.
   * @param {string} sessionId
   * @param {string|null} tag
   * @param {{dir?: string}} [options]
   */
  async function tagSession(sessionId, tag, options = {}) {
    const next = tag === null ? null : requireText(tag, 'tag');
    update(sessionId, (record) => {
      record.tag = next;
    }, options.dir);
  }

  /**
   * SDK forkSession. The fork gets a new id, a copy of the transcript up to `upToMessageId` (inclusive) and the
   * subagent transcripts that are still referenced.
   * @param {string} sessionId
   * @param {{dir?: string, upToMessageId?: string, title?: string}} [options]
   * @returns {Promise<{sessionId: string}>}
   */
  async function forkSession(sessionId, options = {}) {
    const source = read(sessionId);
    if (!source || (options.dir !== undefined && source.cwd !== options.dir)) throw new Error('Session not found');
    const base = source.customTitle ?? source.firstPrompt;
    const customTitle = options.title !== undefined
      ? requireText(options.title, 'title')
      : (base ? `${base} (fork)` : null);
    const cut = sliceRecord(source, options.upToMessageId);
    const fork = newRecord({ sessionId: randomUUID(), cwd: source.cwd, customTitle });
    fork.firstPrompt = source.firstPrompt;
    fork.transcript = cut.transcript;
    fork.subagents = cut.subagents;
    fork.counters = { ...source.counters };
    create(fork);
    return { sessionId: fork.sessionId };
  }

  /**
   * SDK deleteSession.
   * @param {string} sessionId
   * @param {{dir?: string}} [options]
   */
  async function deleteSession(sessionId, options = {}) {
    const key = keyOf(sessionId);
    if (key === null || !existsSync(pathOf(key))) throw new Error('Session not found');
    if (options.dir !== undefined && load(key)?.record.cwd !== options.dir) throw new Error('Session not found');
    unlinkSync(pathOf(key));
  }

  /**
   * SDK listSubagents. Empty for unknown sessions, and for a `dir` that is not the session's directory.
   * @param {string} sessionId
   * @param {{dir?: string}} [options]
   * @returns {Promise<string[]>}
   */
  async function listSubagents(sessionId, options = {}) {
    const entry = load(sessionId);
    if (!entry || (options.dir !== undefined && entry.record.cwd !== options.dir)) return [];
    return Object.keys(entry.record.subagents);
  }

  /**
   * SDK getSubagentMessages. Empty for unknown sessions or agents, and for a `dir` that is not the session's directory.
   * @param {string} sessionId
   * @param {string} agentId
   * @param {{dir?: string}} [options]
   * @returns {Promise<MockEntry[]>}
   */
  async function getSubagentMessages(sessionId, agentId, options = {}) {
    const entry = load(sessionId);
    if (!entry || (options.dir !== undefined && entry.record.cwd !== options.dir)) return [];
    if (!Object.hasOwn(entry.record.subagents, agentId)) return [];
    return entry.record.subagents[agentId];
  }

  return {
    dir: root,
    listSessions,
    getSessionInfo,
    getSessionMessages,
    renameSession,
    tagSession,
    forkSession,
    deleteSession,
    listSubagents,
    getSubagentMessages,
    read,
    create,
    update,
    findLatest,
  };
}

/** @typedef {ReturnType<typeof createMockStore>} MockStore */
