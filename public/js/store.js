/**
 * Application state container. `set` shallow-merges top-level keys and notifies subscribers synchronously; a
 * subscriber that throws never prevents the others from running (the error is rethrown asynchronously).
 */

import { normalizeLocale } from './i18n.js';

/** @typedef {'system'|'light'|'dark'} Theme */
/** @typedef {'sm'|'md'|'lg'} FontSize */

/**
 * @typedef {Object} Prefs
 * @property {Theme} theme
 * @property {string|null} locale       null = follow the browser (see i18n.js)
 * @property {FontSize} fontSize
 * @property {boolean} notify           browser notifications for requests and finished turns
 * @property {boolean} showRuntimeEvents  raw runtime messages the UI does not render natively (for troubleshooting)
 * @property {boolean} sidebarOpen      not persisted: desktop sidebar visibility / mobile drawer state
 */

export const THEMES = /** @type {const} */ (['system', 'light', 'dark']);
export const FONT_SIZES = /** @type {const} */ (['sm', 'md', 'lg']);

const PREFS_KEY = 'caw.prefs';

/** @returns {Prefs} */
export function defaultPrefs() {
  return {
    theme: 'system', locale: null, fontSize: 'md', notify: false, showRuntimeEvents: false, sidebarOpen: true,
  };
}

/**
 * Keep only valid, persisted preference values; anything unknown falls back to `base`.
 * @param {unknown} raw
 * @param {Prefs} base
 * @returns {Prefs}
 */
export function normalizePrefs(raw, base = defaultPrefs()) {
  const input = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
  return {
    theme: THEMES.includes(/** @type {Theme} */ (input.theme)) ? /** @type {Theme} */ (input.theme) : base.theme,
    locale: normalizeLocale(input.locale) ?? base.locale,
    fontSize: FONT_SIZES.includes(/** @type {FontSize} */ (input.fontSize))
      ? /** @type {FontSize} */ (input.fontSize)
      : base.fontSize,
    notify: typeof input.notify === 'boolean' ? input.notify : base.notify,
    showRuntimeEvents: typeof input.showRuntimeEvents === 'boolean'
      ? input.showRuntimeEvents
      : base.showRuntimeEvents,
    sidebarOpen: base.sidebarOpen,
  };
}

/** @returns {Partial<Prefs>} */
function loadPrefs() {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? normalizePrefs(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

/** @param {Prefs} prefs */
function savePrefs(prefs) {
  try {
    if (typeof localStorage === 'undefined') return;
    const { sidebarOpen: _transient, ...persisted } = prefs;
    localStorage.setItem(PREFS_KEY, JSON.stringify(persisted));
  } catch {
    // Storage unavailable: preferences still apply for this page view.
  }
}

/**
 * @param {Record<string, unknown>} initial
 */
export function createStore(initial) {
  /** @type {Record<string, any>} */
  let state = initial;
  /** @type {Set<(next: any, prev: any) => void>} */
  const subscribers = new Set();

  const store = {
    /** @returns {any} */
    get() {
      return state;
    },
    /** @param {Record<string, unknown>} partial */
    set(partial) {
      const prev = state;
      const changed = Object.keys(partial).some((key) => !Object.is(prev[key], partial[key]));
      if (!changed) return;
      state = { ...prev, ...partial };
      if ('prefs' in partial) savePrefs(state.prefs);
      for (const fn of [...subscribers]) {
        try {
          fn(state, prev);
        } catch (err) {
          queueMicrotask(() => {
            throw err;
          });
        }
      }
    },
    /**
     * @param {(state: any) => Record<string, unknown> | null | undefined} fn
     */
    update(fn) {
      const patch = fn(state);
      if (patch) store.set(patch);
    },
    /**
     * @param {(next: any, prev: any) => void} fn
     * @returns {() => void}
     */
    subscribe(fn) {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
  };
  return store;
}

/** The single application store. */
export const store = createStore({
  auth: { authenticated: false, authRequired: false, profile: null, appName: '', version: '', bootId: '' },
  meta: null,
  connection: 'connecting',
  sessions: [],
  sessionsReady: false,
  sessionsHasMore: false,
  live: {},
  pending: {},
  currentSessionId: null,
  capabilities: {},
  terminal: {},
  tasks: {},
  prefs: { ...defaultPrefs(), ...loadPrefs() },
});
