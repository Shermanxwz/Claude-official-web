/**
 * Pure helpers for the session sidebar: project grouping, search, titles, activity order and relative time.
 * No DOM access, so every function here is unit-tested in Node (test/unit/frontend-core.test.mjs).
 */

/**
 * @typedef {Object} LiveLike
 * @property {string} [sessionId]
 * @property {string} [cwd]
 * @property {string} [state]
 * @property {string|null} [title]
 * @property {number} [pendingCount]
 * @property {number} [lastActivity]
 */

/**
 * @typedef {Object} SessionLike
 * @property {string} sessionId
 * @property {string} [summary]
 * @property {number} [lastModified]
 * @property {string} [customTitle]
 * @property {string} [firstPrompt]
 * @property {string} [cwd]
 * @property {string} [tag]
 * @property {LiveLike|null} [live]
 */

/**
 * @typedef {Object} SessionGroup
 * @property {string} key       full cwd, or '' for sessions without a known directory
 * @property {string|null} cwd
 * @property {string|null} name basename of cwd (the project name)
 * @property {SessionLike[]} sessions most recent first
 * @property {number} latest    activity timestamp of the most recent session
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** @param {unknown} value @returns {string} */
function singleLine(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/**
 * Project name for a directory: its last path segment ("/work/acme/" → "acme").
 * @param {string | null | undefined} cwd
 * @returns {string}
 */
export function projectName(cwd) {
  if (!cwd) return '';
  const parts = String(cwd).split(/[\\/]+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : String(cwd);
}

/**
 * The text shown for a session: custom title, then live title, summary, first prompt; otherwise `untitled`.
 * @param {SessionLike} session
 * @param {string} untitled
 * @returns {string}
 */
export function sessionTitle(session, untitled) {
  const candidates = [session.customTitle, session.live?.title, session.summary, session.firstPrompt];
  for (const candidate of candidates) {
    const text = singleLine(candidate);
    if (text) return text;
  }
  return untitled;
}

/**
 * Timestamp used for ordering: last modification of the transcript, else the live activity time.
 * @param {SessionLike} session
 * @returns {number}
 */
export function sessionActivity(session) {
  const modified = Number(session.lastModified);
  if (Number.isFinite(modified) && modified > 0) return modified;
  const last = Number(session.live?.lastActivity);
  return Number.isFinite(last) ? last : 0;
}

/**
 * Directory of a session: the persisted cwd, else the live cwd.
 * @param {SessionLike} session
 * @returns {string}
 */
export function sessionCwd(session) {
  return session.cwd || session.live?.cwd || '';
}

/**
 * Group sessions by project directory. Groups are ordered by their most recent session; sessions inside a group
 * are ordered most recent first.
 * @param {SessionLike[]} sessions
 * @returns {SessionGroup[]}
 */
export function groupSessions(sessions) {
  /** @type {Map<string, SessionGroup>} */
  const groups = new Map();
  for (const session of sessions) {
    const cwd = sessionCwd(session);
    let group = groups.get(cwd);
    if (!group) {
      group = { key: cwd, cwd: cwd || null, name: cwd ? projectName(cwd) : null, sessions: [], latest: 0 };
      groups.set(cwd, group);
    }
    group.sessions.push(session);
    group.latest = Math.max(group.latest, sessionActivity(session));
  }
  const result = [...groups.values()];
  for (const group of result) group.sessions.sort((a, b) => sessionActivity(b) - sessionActivity(a));
  result.sort((a, b) => b.latest - a.latest || a.key.localeCompare(b.key));
  return result;
}

/**
 * Search terms: whitespace-separated, lower-cased. Every term must match (AND).
 * @param {string | null | undefined} query
 * @returns {string[]}
 */
export function queryTerms(query) {
  return String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * @param {SessionLike} session
 * @returns {string}
 */
function searchableText(session) {
  return [session.customTitle, session.live?.title, session.summary, session.firstPrompt, session.cwd,
    session.live?.cwd, session.tag].filter(Boolean).join('\n').toLowerCase();
}

/**
 * Case-insensitive search over title, summary, first prompt, directory and tag.
 * @param {SessionLike[]} sessions
 * @param {string | null | undefined} query
 * @returns {SessionLike[]}
 */
export function filterSessions(sessions, query) {
  const terms = queryTerms(query);
  if (terms.length === 0) return sessions;
  return sessions.filter((session) => {
    const text = searchableText(session);
    return terms.every((term) => text.includes(term));
  });
}

/**
 * Update a live-session map from a page of session summaries: summaries with a live entry set it, summaries
 * without one remove it. Sessions outside the page are untouched. Returns a new object.
 * @param {Record<string, LiveLike>} live
 * @param {SessionLike[]} sessions
 * @returns {Record<string, LiveLike>}
 */
export function mergeLive(live, sessions) {
  const next = { ...live };
  for (const session of sessions) {
    if (session.live) next[session.sessionId] = session.live;
    else delete next[session.sessionId];
  }
  return next;
}

/**
 * Visual tone of a live session's state dot.
 * @param {LiveLike | null | undefined} live
 * @returns {'running'|'attention'|'error'|'starting'|'idle'|'muted'|null}
 */
export function liveTone(live) {
  if (!live) return null;
  switch (live.state) {
    case 'running':
      return 'running';
    case 'requires_action':
      return 'attention';
    case 'error':
      return 'error';
    case 'starting':
      return 'starting';
    case 'closing':
      return 'muted';
    default:
      return 'idle';
  }
}

const rtfCache = new Map();

/** @param {string} locale */
function relativeFormatter(locale) {
  let formatter = rtfCache.get(locale);
  if (!formatter) {
    formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    rtfCache.set(locale, formatter);
  }
  return formatter;
}

/**
 * Human relative time: "now", "3 minutes ago", "yesterday", then a short calendar date after a week.
 * Future timestamps (clock skew) count as now.
 * @param {number} timestamp milliseconds since epoch
 * @param {{now?: number, locale?: string, justNow?: string}} [options]
 * @returns {string}
 */
export function formatRelativeTime(timestamp, { now = Date.now(), locale = 'en', justNow = 'now' } = {}) {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const intlLocale = locale === 'zh-CN' ? 'zh-CN' : 'en';
  const elapsed = Math.max(0, now - ts);
  if (elapsed < 45 * 1000) return justNow;
  const rtf = relativeFormatter(intlLocale);
  if (elapsed < HOUR_MS) return rtf.format(-Math.round(elapsed / MINUTE_MS), 'minute');
  if (elapsed < DAY_MS) return rtf.format(-Math.round(elapsed / HOUR_MS), 'hour');
  if (elapsed < 7 * DAY_MS) return rtf.format(-Math.round(elapsed / DAY_MS), 'day');
  const date = new Date(ts);
  const sameYear = new Date(now).getFullYear() === date.getFullYear();
  const options = sameYear
    ? { month: 'short', day: 'numeric' }
    : { year: 'numeric', month: 'short', day: 'numeric' };
  return new Intl.DateTimeFormat(intlLocale, /** @type {Intl.DateTimeFormatOptions} */ (options)).format(date);
}

/**
 * Local clock time, such as a rate-limit reset.
 * @param {number} timestamp milliseconds since epoch
 * @param {string} [locale]
 * @returns {string}
 */
export function formatClock(timestamp, locale = 'en') {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const intlLocale = locale === 'zh-CN' ? 'zh-CN' : 'en';
  return new Intl.DateTimeFormat(intlLocale, { hour: 'numeric', minute: '2-digit' }).format(new Date(ts));
}
