/**
 * Developer console: the runtime's read-only views as raw JSON (pretty-printed, with a copy button) and a bounded log of
 * every SSE event this page received. The log is filled from page load (the app shell records each event), so the panel
 * shows what happened before it was opened. It lives in memory only and is cleared on reload.
 *
 * The ring buffer and the event summary are pure and run in Node (unit tests); the panel is the only DOM code.
 */

import { h, clear, icon } from '../dom.js';
import { errorText } from '../api.js';
import { getLocale } from '../i18n.js';
import { RUNTIME_VIEW_PROFILE, prettyJson, profileRank } from './runtime-panels.js';

/** At most this many events are kept, oldest dropped first. */
export const LOG_MAX_ENTRIES = 200;
/** The kept events never add up to more than this many bytes (JSON, UTF-8). */
export const LOG_MAX_BYTES = 1024 * 1024;
/** An event whose JSON is larger than this is kept as a summary `{type, subtype, bytes}` only. */
export const LOG_ENTRY_MAX_BYTES = 128 * 1024;

/**
 * UTF-8 length of a string.
 * @param {string} text
 * @returns {number}
 */
export function utf8Length(text) {
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(text).length;
  return text.length;
}

/**
 * The second-level label of an event: the SDK message type (and subtype) for `sdk` events, the reason, state, code or
 * kind for gateway events. Null when the event has none.
 * @param {string} type
 * @param {any} data
 * @returns {string | null}
 */
export function eventSubtype(type, data) {
  if (!data || typeof data !== 'object') return null;
  if (type === 'sdk') {
    const msg = data.msg;
    if (!msg || typeof msg.type !== 'string') return null;
    return typeof msg.subtype === 'string' ? `${msg.type}/${msg.subtype}` : msg.type;
  }
  if (type === 'request') return typeof data.request?.kind === 'string' ? data.request.kind : null;
  if (type === 'request_resolved') return typeof data.outcome === 'string' ? data.outcome : null;
  if (type === 'notice') return typeof data.code === 'string' ? data.code : null;
  if (type === 'session_state') {
    if (data.live && typeof data.live.state === 'string') return data.live.state;
    return data.live === null ? 'closed' : null;
  }
  if (typeof data.reason === 'string') return data.reason;
  return null;
}

/**
 * One log entry. Events within the size limit keep their data; larger ones keep only `{type, subtype, bytes, at}`.
 * `size` is what the entry counts against the byte budget.
 * @param {string} type
 * @param {unknown} data
 * @param {number} at milliseconds since epoch
 * @returns {{entry: {at: number, type: string, subtype: string | null, bytes: number, data?: unknown, omitted?: true}, size: number}}
 */
export function summarizeEvent(type, data, at) {
  let json = '';
  try {
    json = JSON.stringify(data) ?? '';
  } catch {
    json = '';
  }
  const bytes = utf8Length(json);
  const subtype = eventSubtype(type, data);
  if (bytes > LOG_ENTRY_MAX_BYTES) {
    const summary = { at, type, subtype, bytes, omitted: /** @type {const} */ (true) };
    return { entry: summary, size: utf8Length(JSON.stringify(summary)) };
  }
  return { entry: { at, type, subtype, bytes, data }, size: bytes };
}

/**
 * Bounded ring buffer of events. Oldest entries are dropped while the count or the byte budget is exceeded. Listeners
 * run after each change.
 * @param {{maxEntries?: number, maxBytes?: number, now?: () => number}} [options]
 */
export function createEventLog({ maxEntries = LOG_MAX_ENTRIES, maxBytes = LOG_MAX_BYTES, now = () => Date.now() } = {}) {
  /** @type {Array<{entry: ReturnType<typeof summarizeEvent>['entry'], size: number}>} */
  let items = [];
  let total = 0;
  /** @type {Set<() => void>} */
  const listeners = new Set();

  function notify() {
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch (err) {
        queueMicrotask(() => {
          throw err;
        });
      }
    }
  }

  return {
    /**
     * @param {string} type
     * @param {unknown} data
     * @returns {ReturnType<typeof summarizeEvent>['entry']}
     */
    record(type, data) {
      const { entry, size } = summarizeEvent(type, data, now());
      items.push({ entry, size });
      total += size;
      while (items.length > 1 && (items.length > maxEntries || total > maxBytes)) {
        total -= items[0].size;
        items.shift();
      }
      notify();
      return entry;
    },
    /** @returns {Array<ReturnType<typeof summarizeEvent>['entry']>} oldest first */
    entries() {
      return items.map((item) => item.entry);
    },
    /** @returns {number} bytes the kept entries count against the budget */
    bytes() {
      return total;
    },
    clear() {
      items = [];
      total = 0;
      notify();
    },
    /** @param {() => void} fn @returns {() => void} unsubscribe */
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

/** The log of this page view. Filled by app-shell from page load. */
export const eventLog = createEventLog();

const LOG_RENDER_MS = 250;

/**
 * Entries of one SSE type (`all` keeps every entry).
 * @param {Array<{type: string}>} entries
 * @param {string} type
 */
export function filterEntries(entries, type) {
  return type === 'all' || type === '' ? entries : entries.filter((entry) => entry.type === type);
}

/**
 * Distinct SSE types in first-seen order.
 * @param {Array<{type: string}>} entries
 * @returns {string[]}
 */
export function distinctTypes(entries) {
  return [...new Set(entries.map((entry) => entry.type))];
}

/**
 * Human size: bytes below 1 KB, then KB and MB with one decimal.
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '0 B';
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Local time with seconds, for log rows.
 * @param {number} timestamp
 * @param {string} [locale]
 */
function clockWithSeconds(timestamp, locale = 'en') {
  const intlLocale = locale === 'zh-CN' ? 'zh-CN' : 'en-US';
  return new Intl.DateTimeFormat(intlLocale, {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(timestamp));
}

/**
 * The developer panel body. Returns a function that tears it down.
 * @param {{ body: HTMLElement, api: any, store: any, t: (key: string, vars?: Record<string, unknown>) => string,
 *   actions: any, opts?: {tab?: string} }} ctx
 * @returns {() => void}
 */
export function mountDeveloperPanel({ body, api, store, t, actions }) {
  let disposed = false;
  const locale = () => getLocale();
  /** @type {Array<() => void>} */
  const disposers = [];

  // ---- Runtime view ----------------------------------------------------------------------------------------------
  const viewSelect = h('select', {
    class: 'select',
    attrs: { 'aria-label': t('shell.devtools.view') },
  });
  const viewOutput = h('pre', { class: 'devtools-json mono', attrs: { tabindex: '0' } });
  const viewStatus = h('p', { class: 'sheet-note', attrs: { role: 'status' } });
  const viewCopy = h('button', {
    class: 'btn btn-secondary btn-sm',
    attrs: { type: 'button', disabled: true },
    on: { click: () => copyView() },
  }, icon('copy'), h('span', { text: t('shell.devtools.copy') }));
  const viewBlock = h('div', { class: 'devtools-view' },
    h('div', { class: 'sheet-inline' }, viewSelect, viewCopy),
    viewStatus,
    viewOutput);

  let views = null;
  /** @type {string | null} */
  let viewText = null;
  let viewRequest = 0;

  /** @param {string} message */
  function viewError(message) {
    viewStatus.textContent = message;
    viewStatus.hidden = message === '';
  }

  async function copyView() {
    if (viewText === null) return;
    try {
      await navigator.clipboard.writeText(viewText);
      actions.toast(t('common.copied'), 'success');
    } catch {
      actions.toast(t('common.copyFailed'), 'error');
    }
  }

  /** @param {string} name */
  async function showView(name) {
    const sessionId = store.get().currentSessionId;
    if (!sessionId) return;
    const request = ++viewRequest;
    viewOutput.textContent = '';
    viewText = null;
    viewCopy.disabled = true;
    viewError(t('common.loading'));
    try {
      const answer = await api.get(`/api/sessions/${encodeURIComponent(sessionId)}/runtime/${encodeURIComponent(name)}`);
      if (disposed || request !== viewRequest) return;
      viewText = prettyJson(answer.data);
      viewOutput.textContent = viewText;
      viewCopy.disabled = false;
      viewError(t('shell.devtools.fetched', { time: clockWithSeconds(answer.fetchedAt || Date.now(), locale()) }));
    } catch (err) {
      if (disposed || request !== viewRequest) return;
      viewError(runtimeFailure(err));
    }
  }

  /** @param {any} err */
  function runtimeFailure(err) {
    if (err?.code === 'SESSION_NOT_LIVE') return t('shell.runtime.notLive');
    if (err?.code === 'FEATURE_UNAVAILABLE') return t('shell.runtime.unavailable');
    return errorText(err, t);
  }

  async function loadViews() {
    const sessionId = store.get().currentSessionId;
    if (!sessionId) return;
    try {
      const answer = await api.get(`/api/sessions/${encodeURIComponent(sessionId)}/runtime`);
      if (disposed) return;
      const profile = store.get().meta?.profile ?? store.get().auth?.profile ?? 'full';
      views = (Array.isArray(answer.views) ? answer.views : [])
        .filter((name) => profileRank(profile) >= profileRank(RUNTIME_VIEW_PROFILE[name] ?? 'read'));
      clear(viewSelect);
      for (const name of views) viewSelect.append(h('option', { attrs: { value: name }, text: name }));
      if (views.length === 0) {
        viewError(t('shell.devtools.noViews'));
        return;
      }
      showView(views[0]);
    } catch (err) {
      if (disposed) return;
      views = null;
      viewError(runtimeFailure(err));
      if (err?.code === 'SESSION_NOT_LIVE') {
        viewStatus.append(' ');
        viewStatus.append(h('button', {
          class: 'btn btn-secondary btn-sm',
          attrs: { type: 'button' },
          on: { click: () => openSession() },
        }, t('shell.context.open')));
      }
    }
  }

  async function openSession() {
    const sessionId = store.get().currentSessionId;
    if (!sessionId) return;
    try {
      await api.post(`/api/sessions/${encodeURIComponent(sessionId)}/open`, {});
      if (!disposed) loadViews();
    } catch (err) {
      actions.toast(errorText(err, t), 'error');
    }
  }

  viewSelect.addEventListener('change', () => showView(viewSelect.value));

  // ---- Event log -------------------------------------------------------------------------------------------------
  const filterSelect = h('select', {
    class: 'select',
    attrs: { 'aria-label': t('shell.devtools.filter') },
  });
  const logSummary = h('p', { class: 'sheet-note', attrs: { role: 'status' } });
  const logList = h('ul', { class: 'evt-list', attrs: { 'aria-label': t('shell.devtools.log') } });
  const clearButton = h('button', {
    class: 'btn btn-secondary btn-sm',
    attrs: { type: 'button' },
    on: { click: () => eventLog.clear() },
  }, icon('trash'), h('span', { text: t('shell.devtools.clear') }));
  let filter = 'all';

  /** @param {Array<{type: string}>} entries */
  function syncFilter(entries) {
    const types = distinctTypes(entries);
    const current = filter !== 'all' && !types.includes(filter) ? 'all' : filter;
    clear(filterSelect);
    filterSelect.append(h('option', { attrs: { value: 'all' }, text: t('shell.devtools.allTypes') }));
    for (const type of types) filterSelect.append(h('option', { attrs: { value: type }, text: type }));
    filterSelect.value = current;
    filter = current;
  }

  function renderLog() {
    const all = eventLog.entries();
    syncFilter(all);
    const shown = filterEntries(all, filter).slice().reverse();
    clear(logList);
    logSummary.textContent = t(all.length === 1 ? 'shell.devtools.summary.one' : 'shell.devtools.summary.other', {
      count: all.length,
      size: formatBytes(eventLog.bytes()),
    });
    if (shown.length === 0) {
      logList.append(h('li', { class: 'evt-empty', text: t('shell.devtools.empty') }));
      return;
    }
    for (const entry of shown) logList.append(logRow(entry));
  }

  /** @param {ReturnType<typeof eventLog.entries>[number]} entry */
  function logRow(entry) {
    const head = h('span', { class: 'evt-head' },
      h('span', { class: 'evt-time mono', text: clockWithSeconds(entry.at, locale()) }),
      h('span', { class: 'evt-type', text: entry.type }),
      entry.subtype ? h('span', { class: 'evt-sub mono', text: entry.subtype }) : null,
      h('span', { class: 'evt-size mono', text: formatBytes(entry.bytes) }));
    if (entry.omitted) {
      return h('li', { class: 'evt' }, head,
        h('p', { class: 'evt-note', text: t('shell.devtools.omitted') }));
    }
    let filled = false;
    const details = h('details', { class: 'evt-details' },
      h('summary', { text: t('shell.devtools.details') }),
      h('pre', { class: 'devtools-json mono' }));
    details.addEventListener('toggle', () => {
      if (!details.open || filled) return;
      filled = true;
      details.querySelector('pre').textContent = prettyJson(entry.data);
    });
    return h('li', { class: 'evt' }, head, details);
  }

  filterSelect.addEventListener('change', () => {
    filter = filterSelect.value;
    renderLog();
  });

  // Streams send many events a second: the list is redrawn at most four times a second while the panel is open.
  /** @type {ReturnType<typeof setTimeout> | null} */
  let logTimer = null;
  const unsubscribeLog = eventLog.subscribe(() => {
    if (disposed || logTimer !== null) return;
    logTimer = setTimeout(() => {
      logTimer = null;
      if (!disposed) renderLog();
    }, LOG_RENDER_MS);
  });
  disposers.push(unsubscribeLog, () => {
    if (logTimer !== null) clearTimeout(logTimer);
  });

  body.append(
    h('section', { class: 'sheet-section' },
      h('h3', { class: 'sheet-section-title', text: t('shell.devtools.views') }),
      h('p', { class: 'sheet-note', text: t('shell.devtools.viewsHint') }),
      viewBlock),
    h('section', { class: 'sheet-section' },
      h('h3', { class: 'sheet-section-title', text: t('shell.devtools.log') }),
      h('p', { class: 'sheet-note', text: t('shell.devtools.logHint') }),
      h('div', { class: 'sheet-inline' }, filterSelect, clearButton),
      logSummary,
      logList));

  // A session change re-reads the views of the new session.
  const unsubscribeStore = store.subscribe((state, prev) => {
    if (state.currentSessionId !== prev.currentSessionId) {
      views = null;
      loadViews();
    }
  });
  disposers.push(unsubscribeStore);

  renderLog();
  loadViews();

  return () => {
    disposed = true;
    for (const dispose of disposers) dispose();
  };
}
