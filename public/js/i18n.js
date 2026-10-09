/**
 * Translation registry and locale state.
 *
 * Importable in Node (unit tests): nothing touches `document` or `localStorage` at import time, and every
 * browser-only access is guarded and wrapped so that a blocked or missing storage never breaks rendering.
 */

/** @typedef {'en' | 'zh-CN'} Locale */

const STORAGE_KEY = 'caw.locale';
const DEFAULT_LOCALE = 'en';

/** @type {Record<Locale, Record<string, string>>} */
const tables = { en: Object.create(null), 'zh-CN': Object.create(null) };

/** @type {Set<(locale: Locale) => void>} */
const listeners = new Set();

/**
 * Map any language tag onto a supported locale. Returns null when the tag is not supported.
 * @param {unknown} value
 * @returns {Locale | null}
 */
export function normalizeLocale(value) {
  if (typeof value !== 'string') return null;
  const tag = value.trim().replace('_', '-').toLowerCase();
  if (tag === 'zh' || tag.startsWith('zh-')) return 'zh-CN';
  if (tag === 'en' || tag.startsWith('en-')) return 'en';
  return null;
}

/** @returns {Locale | null} */
function readStoredLocale() {
  try {
    if (typeof localStorage === 'undefined') return null;
    return normalizeLocale(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

/** @param {Locale} locale */
function writeStoredLocale(locale) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // Storage is blocked (private window, disabled site data): the locale still applies for this page view.
  }
}

/** @param {Locale} locale */
function syncDocumentLanguage(locale) {
  if (typeof document !== 'undefined' && document.documentElement) document.documentElement.lang = locale;
}

/** @returns {Locale} */
function detectLocale() {
  const stored = readStoredLocale();
  if (stored) return stored;
  const browser = typeof navigator !== 'undefined' ? normalizeLocale(navigator.language) : null;
  return browser ?? DEFAULT_LOCALE;
}

/** @type {Locale} */
let current = detectLocale();
syncDocumentLanguage(current);

/**
 * Register (merge) messages for one locale. Keys are flat, dotted, namespaced strings.
 * @param {Locale} locale
 * @param {Record<string, string>} messages
 */
export function registerMessages(locale, messages) {
  const table = tables[locale];
  if (!table) throw new TypeError(`Unsupported locale: ${locale}`);
  for (const [key, value] of Object.entries(messages)) table[key] = value;
}

/**
 * Translate a key in the active locale, falling back to English, then to the key itself.
 * `{name}` placeholders are replaced from `vars`; unknown placeholders are left untouched.
 * @param {string} key
 * @param {Record<string, string | number>} [vars]
 * @returns {string}
 */
export function t(key, vars) {
  const message = tables[current][key] ?? tables[DEFAULT_LOCALE][key];
  if (message === undefined) return key;
  if (!vars) return message;
  return message.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match);
}

/** @returns {Locale} */
export function getLocale() {
  return current;
}

/**
 * Switch the active locale, mark the document language and notify listeners.
 * @param {string} next
 */
export function setLocale(next) {
  const locale = normalizeLocale(next) ?? DEFAULT_LOCALE;
  if (locale === current) {
    syncDocumentLanguage(locale);
    return;
  }
  current = locale;
  syncDocumentLanguage(locale);
  writeStoredLocale(locale);
  for (const listener of [...listeners]) {
    try {
      listener(locale);
    } catch (err) {
      queueMicrotask(() => {
        throw err;
      });
    }
  }
}

/**
 * @param {(locale: Locale) => void} fn
 * @returns {() => void} unsubscribe
 */
export function onLocaleChange(fn) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
