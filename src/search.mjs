// @ts-check
/**
 * Conversation search (`GET /api/sessions/search`). Every session the gateway lists is matched on its title, summary
 * and first prompt first. Then the transcripts of the most recently modified sessions that did not match are read,
 * within an overall time budget, and their user and assistant text is searched. Matching is a case-insensitive
 * substring test.
 */

import { AppError } from './contracts.mjs';

/** @typedef {import('./contracts.mjs').SessionSearchResult} SessionSearchResult */
/** @typedef {import('./contracts.mjs').SessionSearchResponse} SessionSearchResponse */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SDKSessionInfo} SDKSessionInfo */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SessionMessage} SessionMessage */

const QUERY_MIN = 2;
const QUERY_MAX = 200;
/**
 * How many of the most recently modified unmatched sessions a search reads. Every answer reports it as `scanLimit`, so
 * the client never has to know the number.
 */
const SCAN_SESSIONS = 50;
const SCAN_MESSAGES = 4000;
const SNIPPETS_MAX = 3;
const SNIPPET_MAX = 160;
const SNIPPET_LEAD = 60;
const BUDGET_MS = 5000;

/**
 * @typedef {SDKSessionInfo & {live?: unknown}} ListedSession
 * @typedef {Object} SearchDependencies
 * @property {() => Promise<ListedSession[]>} listAll   every session the gateway lists, in one listing, newest first
 * @property {(sessionId: string) => Promise<SessionMessage[]>} getSessionMessages
 * @property {() => number} [now]       clock in milliseconds; injectable for tests
 * @property {number} [budgetMs]        overall budget of the content scan
 */

/**
 * Validates the query: 2 to 200 characters once trimmed. Returns it lower-cased.
 * @param {unknown} raw
 * @returns {string}
 */
export function parseSearchQuery(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const length = [...text].length;
  if (length < QUERY_MIN || length > QUERY_MAX) {
    throw new AppError(400, 'BAD_REQUEST', `q must be ${QUERY_MIN} to ${QUERY_MAX} characters`);
  }
  return text.toLowerCase();
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isText(value) {
  return typeof value === 'string' && value !== '';
}

/**
 * The fields a title match looks at, in order of preference.
 * @param {ListedSession} session
 * @returns {string[]}
 */
function titleFields(session) {
  return [session.customTitle, session.summary, session.firstPrompt].filter(isText);
}

/**
 * @param {ListedSession} session
 * @returns {string|null}
 */
function titleOf(session) {
  return titleFields(session)[0] ?? null;
}

/**
 * The text blocks of a message's content: plain string content, or the `text` blocks of a content array.
 * @param {unknown} message
 * @returns {string[]}
 */
function textsOf(message) {
  const content = message !== null && typeof message === 'object' && 'content' in message
    ? /** @type {{content: unknown}} */ (message).content
    : undefined;
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text'
      && typeof block.text === 'string')
    .map((block) => block.text);
}

/**
 * A window of at most SNIPPET_MAX characters around the first match in a text, whitespace collapsed.
 * @param {string} text
 * @param {string} needle lower-cased
 * @returns {string|null}
 */
function snippetIn(text, needle) {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = flat.toLowerCase().indexOf(needle);
  if (at === -1) return null;
  const start = Math.max(0, at - SNIPPET_LEAD);
  return flat.slice(start, start + SNIPPET_MAX);
}

/**
 * Up to SNIPPETS_MAX snippets from the last SCAN_MESSAGES messages of a transcript. Only user and assistant messages
 * are searched.
 * @param {SessionMessage[]} messages
 * @param {string} needle
 * @returns {string[]}
 */
function snippetsOf(messages, needle) {
  /** @type {string[]} */
  const snippets = [];
  for (const message of messages.slice(-SCAN_MESSAGES)) {
    if (message.type !== 'user' && message.type !== 'assistant') continue;
    for (const text of textsOf(message.message)) {
      const snippet = snippetIn(text, needle);
      if (snippet === null) continue;
      snippets.push(snippet);
      if (snippets.length === SNIPPETS_MAX) return snippets;
    }
  }
  return snippets;
}

/**
 * @param {ListedSession} session
 * @param {'title'|'content'} matchedIn
 * @param {string[]} snippets
 * @returns {SessionSearchResult}
 */
function resultOf(session, matchedIn, snippets) {
  return {
    sessionId: session.sessionId,
    cwd: typeof session.cwd === 'string' ? session.cwd : null,
    title: titleOf(session),
    lastModified: session.lastModified,
    matchedIn,
    snippets,
  };
}

/**
 * @param {SearchDependencies} deps
 * @returns {{search: (q: unknown, limit: number) => Promise<SessionSearchResponse>}}
 */
export function createSessionSearch({ listAll, getSessionMessages, now = Date.now, budgetMs = BUDGET_MS }) {
  return {
    /**
     * @param {unknown} q
     * @param {number} limit 1 to 50
     * @returns {Promise<SessionSearchResponse>}
     */
    async search(q, limit) {
      const needle = parseSearchQuery(q);
      const started = now();
      const sessions = await listAll();
      /** @type {SessionSearchResult[]} */
      const results = [];
      /** @type {ListedSession[]} */
      const unmatched = [];
      for (const session of sessions) {
        if (titleFields(session).some((field) => field.toLowerCase().includes(needle))) {
          results.push(resultOf(session, 'title', []));
        } else {
          unmatched.push(session);
        }
      }
      unmatched.sort((a, b) => b.lastModified - a.lastModified);
      let scanned = 0;
      // Sessions beyond the cap are not read at all, so the answer is partial whether or not the budget runs out.
      let truncated = unmatched.length > SCAN_SESSIONS;
      for (const session of unmatched.slice(0, SCAN_SESSIONS)) {
        if (now() - started > budgetMs) {
          truncated = true;
          break;
        }
        const messages = await readOrNull(getSessionMessages, session.sessionId);
        if (messages === null) continue;
        scanned += 1;
        const snippets = snippetsOf(messages, needle);
        if (snippets.length > 0) results.push(resultOf(session, 'content', snippets));
      }
      results.sort((a, b) => b.lastModified - a.lastModified);
      return { results: results.slice(0, limit), scanned, truncated, scanLimit: SCAN_SESSIONS };
    },
  };
}

/**
 * A transcript that cannot be read is skipped rather than failing the whole search.
 * @param {(sessionId: string) => Promise<SessionMessage[]>} read
 * @param {string} sessionId
 * @returns {Promise<SessionMessage[]|null>}
 */
async function readOrNull(read, sessionId) {
  try {
    return await read(sessionId);
  } catch {
    return null;
  }
}
