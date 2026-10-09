/**
 * Quick switcher (⌘K / Ctrl+K): one list of sessions, panels and GUI commands, matched fuzzily on their labels and
 * details, plus a "Search message text" row that runs the gateway's deep search (GET /api/sessions/search) and lists
 * the matches with their snippets. The matcher and the ranking are pure (unit-tested in Node); the dialog is DOM code.
 */

import { h, clear, icon } from '../dom.js';
import { errorText } from '../api.js';
import { getLocale } from '../i18n.js';
import { formatRelativeTime, projectName, sessionActivity, sessionTitle } from './sidebar-model.js';
import { openDialog } from './dialog.js';

/** Characters that start a new word when they come before a match. */
const WORD_BREAK = /[\s\-_./:\\]/;
const SEARCH_MIN_CHARS = 2;
const SEARCH_LIMIT = 20;
const RECENT_LIMIT = 8;

/**
 * Subsequence match of one term: every character of `term` appears in `text` in order. Scores reward consecutive
 * characters, word starts and exact or prefix matches. Returns null when the term does not match.
 * @param {string} term
 * @param {string} text
 * @returns {{score: number, ranges: Array<[number, number]>} | null}
 */
export function fuzzyMatch(term, text) {
  const needle = String(term ?? '').trim().toLowerCase();
  if (needle === '') return { score: 0, ranges: [] };
  const haystack = String(text ?? '').toLowerCase();
  const chars = [...needle];
  let score = 0;
  let from = 0;
  let previous = -2;
  /** @type {number[]} */
  const hits = [];
  for (const ch of chars) {
    const index = haystack.indexOf(ch, from);
    if (index < 0) return null;
    let bonus = 1;
    if (index === previous + 1) bonus += 4;
    if (index === 0 || WORD_BREAK.test(haystack[index - 1])) bonus += 3;
    score += bonus - Math.min(2, (index - from) * 0.25);
    hits.push(index);
    previous = index;
    from = index + 1;
  }
  if (haystack === needle) score += 30;
  else if (haystack.startsWith(needle)) score += 15;
  else if (haystack.includes(needle)) score += 8;
  return { score, ranges: mergeHits(hits) };
}

/**
 * Consecutive hit indexes as [start, end) ranges.
 * @param {number[]} hits ascending indexes
 * @returns {Array<[number, number]>}
 */
function mergeHits(hits) {
  /** @type {Array<[number, number]>} */
  const ranges = [];
  for (const index of hits) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === index) last[1] = index + 1;
    else ranges.push([index, index + 1]);
  }
  return ranges;
}

/**
 * Every whitespace-separated term must match. The ranges of all terms are merged.
 * @param {string} query
 * @param {string} text
 * @returns {{score: number, ranges: Array<[number, number]>} | null}
 */
export function matchTerms(query, text) {
  const terms = String(query ?? '').trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return { score: 0, ranges: [] };
  let score = 0;
  /** @type {Array<[number, number]>} */
  const ranges = [];
  for (const term of terms) {
    const match = fuzzyMatch(term, text);
    if (!match) return null;
    score += match.score;
    ranges.push(...match.ranges);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  return { score, ranges: mergeRanges(ranges) };
}

/**
 * @param {Array<[number, number]>} ranges sorted by start
 * @returns {Array<[number, number]>}
 */
function mergeRanges(ranges) {
  /** @type {Array<[number, number]>} */
  const merged = [];
  for (const [start, end] of ranges) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/**
 * Every case-insensitive occurrence of `query` in `text`, as [start, end) ranges. Used for message snippets.
 * @param {string} text
 * @param {string} query
 * @returns {Array<[number, number]>}
 */
export function substringRanges(text, query) {
  const needle = String(query ?? '').trim().toLowerCase();
  const haystack = String(text ?? '').toLowerCase();
  /** @type {Array<[number, number]>} */
  const ranges = [];
  if (needle === '') return ranges;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    ranges.push([index, index + needle.length]);
    index = haystack.indexOf(needle, index + needle.length);
  }
  return ranges;
}

/**
 * Highlight ranges for a query of one or more words: every occurrence of every word, merged and in order. The search
 * matches words anywhere in a message, so the words are marked one by one, not as one phrase.
 * @param {string} text
 * @param {string} query
 * @returns {Array<[number, number]>} sorted, non-overlapping
 */
export function termRanges(text, query) {
  const found = String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean)
    .flatMap((term) => substringRanges(text, term));
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  /** @type {Array<[number, number]>} */
  const merged = [];
  for (const [start, end] of found) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/**
 * Splits text into plain and highlighted pieces, so that highlights become `<mark>` nodes (never HTML strings).
 * @param {string} text
 * @param {Array<[number, number]>} ranges sorted, non-overlapping
 * @returns {Array<{text: string, hit: boolean}>}
 */
export function segmentText(text, ranges) {
  const source = String(text ?? '');
  /** @type {Array<{text: string, hit: boolean}>} */
  const segments = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    const from = Math.max(cursor, Math.min(start, source.length));
    const to = Math.min(end, source.length);
    if (from > cursor) segments.push({ text: source.slice(cursor, from), hit: false });
    if (to > from) segments.push({ text: source.slice(from, to), hit: true });
    cursor = Math.max(cursor, to);
  }
  if (cursor < source.length) segments.push({ text: source.slice(cursor), hit: false });
  return segments;
}

/**
 * Whether the "Search message text" row is offered for a query.
 * @param {string} query
 */
export function searchRowVisible(query) {
  return String(query ?? '').trim().length >= SEARCH_MIN_CHARS;
}

/**
 * @typedef {Object} SwitcherEntry
 * @property {string} id
 * @property {'sessions'|'panels'|'commands'} group
 * @property {string} label
 * @property {string} [detail]  second line, matched too (for example the project)
 * @property {string} [hint]    right-aligned text that is not matched (for example the time)
 */

/**
 * Entries that match the query, best first within each group. Groups keep their order. With an empty query every
 * entry is kept in its given order (sessions are already in recency order).
 * @param {string} query
 * @param {SwitcherEntry[]} entries
 * @returns {Array<SwitcherEntry & {labelRanges: Array<[number, number]>}>}
 */
export function rankEntries(query, entries) {
  const trimmed = String(query ?? '').trim();
  const groups = ['sessions', 'panels', 'commands'];
  /** @type {Array<SwitcherEntry & {labelRanges: Array<[number, number]>}>} */
  const out = [];
  for (const group of groups) {
    const scored = [];
    for (const [order, entry] of entries.entries()) {
      if (entry.group !== group) continue;
      if (trimmed === '') {
        scored.push({ entry: { ...entry, labelRanges: [] }, score: 0, order });
        continue;
      }
      const onLabel = matchTerms(trimmed, entry.label);
      const onDetail = entry.detail ? matchTerms(trimmed, entry.detail) : null;
      if (!onLabel && !onDetail) continue;
      const score = (onLabel ? onLabel.score + 100 : 0) + (onDetail ? onDetail.score * 0.5 : 0);
      scored.push({ entry: { ...entry, labelRanges: onLabel ? onLabel.ranges : [] }, score, order });
    }
    scored.sort((a, b) => b.score - a.score || a.order - b.order);
    for (const item of scored) out.push(item.entry);
  }
  return out;
}

/**
 * The recent sessions shown with an empty query.
 * @param {SwitcherEntry[]} entries
 */
export function recentEntries(entries) {
  return entries.slice(0, RECENT_LIMIT);
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Dialog                                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

/** @type {{close: () => void} | null} */
let open = null;

/** @returns {boolean} true while the switcher is open */
export function quickSwitcherOpen() {
  return open !== null;
}

/**
 * Opens the switcher. `commands` are {id, label, detail?, run} values that the caller builds (localized labels).
 * @param {{
 *   api: any, store: any, t: (key: string, vars?: Record<string, unknown>) => string, actions: any,
 *   commands: Array<{id: string, label: string, detail?: string, run: () => unknown}>,
 *   panels: Array<{id: string, label: string, run: () => unknown}>,
 * }} deps
 * @returns {{close: () => void} | null} null when the switcher is already open
 */
export function openQuickSwitcher(deps) {
  if (open) return null;
  const { api, store, t, actions } = deps;
  const locale = () => getLocale();

  /** @type {Map<string, () => unknown>} */
  const runners = new Map();
  /** @type {Array<{entry: SwitcherEntry, run: () => unknown}>} */
  const sessionItems = (store.get().sessions ?? []).map((session) => {
    const title = sessionTitle(session, t('shell.untitled'));
    const id = `session:${session.sessionId}`;
    const run = () => actions.selectSession(session.sessionId);
    return {
      entry: {
        id,
        group: 'sessions',
        label: title,
        detail: projectName(session.cwd || session.live?.cwd || ''),
        hint: formatRelativeTime(sessionActivity(session), { now: Date.now(), locale: locale(), justNow: t('common.time.justNow') }),
      },
      run,
    };
  });
  /** @type {SwitcherEntry[]} */
  const entries = [
    ...sessionItems.map((item) => item.entry),
    ...deps.panels.map((panel) => ({ id: `panel:${panel.id}`, group: /** @type {const} */ ('panels'), label: panel.label })),
    ...deps.commands.map((command) => ({
      id: `command:${command.id}`,
      group: /** @type {const} */ ('commands'),
      label: command.label,
      detail: command.detail,
    })),
  ];
  for (const item of sessionItems) runners.set(item.entry.id, item.run);
  for (const panel of deps.panels) runners.set(`panel:${panel.id}`, panel.run);
  for (const command of deps.commands) runners.set(`command:${command.id}`, command.run);

  const input = h('input', {
    class: 'input switcher-input',
    attrs: {
      type: 'text',
      role: 'combobox',
      'aria-expanded': 'true',
      'aria-controls': 'switcher-list',
      'aria-autocomplete': 'list',
      autocomplete: 'off',
      spellcheck: false,
      placeholder: t('shell.switcher.placeholder'),
      'aria-label': t('shell.switcher.placeholder'),
    },
  });
  const list = h('ul', {
    class: 'switcher-list',
    attrs: { id: 'switcher-list', role: 'listbox', 'aria-label': t('shell.switcher.results') },
  });
  const status = h('p', { class: 'switcher-status', attrs: { role: 'status' } });
  const panel = h('div', { class: 'switcher-body' }, input, status, list);

  /** @type {Array<{kind: 'entry'|'search', entry?: SwitcherEntry & {labelRanges?: Array<[number,number]>}}>} */
  let options = [];
  let active = 0;
  /** @type {{query: string, state: 'idle'|'loading'|'done'|'error', results: any[], error: string} | null} */
  let deep = null;
  let closed = false;
  let searchToken = 0;

  function close() {
    if (closed) return;
    closed = true;
    searchToken += 1;
    open = null;
    handle.close();
  }

  /**
   * @param {string} text
   * @param {Array<[number, number]>} ranges
   * @returns {HTMLElement}
   */
  function highlighted(text, ranges, className = 'switcher-label') {
    const segments = segmentText(text, ranges);
    return h('span', { class: className },
      segments.map((segment) => (segment.hit ? h('mark', { text: segment.text }) : segment.text)));
  }

  /** @param {number} index */
  function setActive(index) {
    if (options.length === 0) return;
    active = (index + options.length) % options.length;
    for (const [position, node] of [...list.querySelectorAll('[role="option"]')].entries()) {
      const selected = position === active;
      node.setAttribute('aria-selected', String(selected));
      if (selected) {
        node.scrollIntoView?.({ block: 'nearest' });
        input.setAttribute('aria-activedescendant', node.id);
      }
    }
  }

  /** @param {number} index */
  function runOption(index) {
    const option = options[index];
    if (!option) return;
    if (option.kind === 'search') {
      runDeepSearch(input.value.trim());
      return;
    }
    const runner = runners.get(option.entry?.id ?? '');
    close();
    try {
      runner?.();
    } catch (err) {
      actions.toast(errorText(err, t), 'error');
    }
  }

  /** @param {string} id */
  function optionNode(id, selected, children) {
    return h('li', {
      class: ['switcher-option', selected ? 'is-active' : ''],
      attrs: { id, role: 'option', 'aria-selected': String(selected) },
      on: {
        mousemove: () => {
          const index = [...list.querySelectorAll('[role="option"]')].findIndex((node) => node.id === id);
          if (index >= 0 && index !== active) setActive(index);
        },
        click: () => {
          const index = [...list.querySelectorAll('[role="option"]')].findIndex((node) => node.id === id);
          if (index >= 0) runOption(index);
        },
      },
    }, children);
  }

  function renderList() {
    const query = input.value;
    clear(list);
    options = [];
    if (deep && deep.query !== query.trim()) deep = null;
    if (deep) {
      renderDeep();
      return;
    }
    const ranked = query.trim() === ''
      ? recentEntries(entries.filter((entry) => entry.group === 'sessions'))
        .concat(entries.filter((entry) => entry.group !== 'sessions'))
        .map((entry) => ({ ...entry, labelRanges: [] }))
      : rankEntries(query, entries);
    for (const entry of ranked) options.push({ kind: 'entry', entry });
    if (searchRowVisible(query)) options.push({ kind: 'search' });
    if (options.length === 0) {
      status.textContent = t('shell.switcher.none');
      active = 0;
      return;
    }
    status.textContent = '';
    let previousGroup = '';
    options.forEach((option, index) => {
      if (option.kind === 'search') {
        list.append(optionNode('switcher-opt-search', index === active, [
          h('span', { class: 'switcher-search-icon' }, icon('search')),
          h('span', { class: 'switcher-label', text: t('shell.switcher.searchMessages') }),
          h('span', { class: 'switcher-detail', text: `“${query.trim()}”` }),
        ]));
        return;
      }
      const entry = option.entry;
      if (entry.group !== previousGroup) {
        previousGroup = entry.group;
        list.append(h('li', { class: 'switcher-group', attrs: { role: 'presentation' }, text: t(`shell.switcher.group.${entry.group}`) }));
      }
      list.append(optionNode(`switcher-opt-${index}`, index === active, [
        icon(entry.group === 'sessions' ? 'spark' : entry.group === 'panels' ? 'layers' : 'command'),
        highlighted(entry.label, entry.labelRanges ?? []),
        entry.detail ? h('span', { class: 'switcher-detail', text: entry.detail }) : null,
        entry.hint ? h('span', { class: 'switcher-hint', text: entry.hint }) : null,
      ]));
    });
    setActive(Math.min(active, options.length - 1));
  }

  /** @param {string} query */
  async function runDeepSearch(query) {
    const token = ++searchToken;
    deep = { query, state: 'loading', results: [], error: '' };
    renderDeep();
    try {
      const answer = await api.get(`/api/sessions/search?q=${encodeURIComponent(query)}&limit=${SEARCH_LIMIT}`);
      if (closed || token !== searchToken) return;
      deep = { query, state: 'done', results: Array.isArray(answer?.results) ? answer.results : [], error: '' };
    } catch (err) {
      if (closed || token !== searchToken) return;
      deep = { query, state: 'error', results: [], error: errorText(err, t) };
    }
    renderDeep();
  }

  function renderDeep() {
    clear(list);
    options = [];
    if (!deep) return;
    if (deep.state === 'loading') {
      status.textContent = t('shell.switcher.searching');
      return;
    }
    if (deep.state === 'error') {
      status.textContent = deep.error;
      return;
    }
    if (deep.results.length === 0) {
      status.textContent = t('shell.switcher.noMessages');
      return;
    }
    const key = deep.results.length === 1 ? 'shell.switcher.messageResults.one' : 'shell.switcher.messageResults.other';
    status.textContent = t(key, { count: deep.results.length });
    deep.results.forEach((result, index) => {
      const id = `switcher-result-${index}`;
      options.push({ kind: 'entry', entry: { id, group: 'sessions', label: '' } });
      const snippets = Array.isArray(result.snippets) ? result.snippets.slice(0, 3) : [];
      list.append(optionNode(id, index === active, [
        h('span', { class: 'switcher-result-head' },
          h('span', { class: 'switcher-label', text: result.title || t('shell.untitled') }),
          h('span', { class: 'switcher-detail', text: projectName(result.cwd || '') }),
          h('span', { class: 'switcher-hint', text: formatRelativeTime(result.lastModified, {
            now: Date.now(), locale: locale(), justNow: t('common.time.justNow'),
          }) })),
        ...snippets.map((snippet) => h('span', { class: 'switcher-snippet' },
          segmentText(String(snippet), termRanges(String(snippet), deep?.query ?? '')).map((segment) => (
            segment.hit ? h('mark', { text: segment.text }) : segment.text)))),
      ]));
      runners.set(id, () => actions.selectSession(result.sessionId));
    });
    setActive(Math.min(active, options.length - 1));
  }

  input.addEventListener('input', () => {
    active = 0;
    renderList();
  });
  input.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive(active + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(active - 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (deep && deep.state === 'done' && deep.results.length > 0) {
        const result = deep.results[active];
        if (result) {
          close();
          actions.selectSession(result.sessionId);
        }
        return;
      }
      if (options.length > 0) runOption(active);
    }
  });

  const handle = openDialog({
    title: t('shell.switcher.title'),
    titleHidden: true,
    body: panel,
    size: 'lg',
    placement: 'top',
    className: 'switcher',
    onClose: () => {
      closed = true;
      searchToken += 1;
      open = null;
    },
  });
  open = handle;
  renderList();
  input.focus({ preventScroll: true });
  return handle;
}

/** @returns {boolean} true on Apple devices, where the shortcuts use ⌘ rather than Ctrl */
export function isApplePlatform() {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/.test(`${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`);
}

/**
 * A shortcut as the platform shows it: ⌘K on Apple devices, Ctrl+K elsewhere (shift adds ⇧ or Shift+).
 * @param {string} key a letter
 * @param {{shift?: boolean, apple?: boolean}} [options]
 * @returns {string}
 */
export function shortcutLabel(key, { shift = false, apple = isApplePlatform() } = {}) {
  const letter = key.toUpperCase();
  return apple ? `⌘${shift ? '⇧' : ''}${letter}` : `Ctrl+${shift ? 'Shift+' : ''}${letter}`;
}

export { SEARCH_MIN_CHARS, SEARCH_LIMIT };
