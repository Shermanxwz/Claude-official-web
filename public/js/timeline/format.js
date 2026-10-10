/**
 * Pure formatting helpers shared by the timeline and tool cards. No DOM access; importable in Node.
 */

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\x9b[0-?]*[ -/]*[@-~]/g;

/**
 * Milliseconds as a short human duration: "850 ms", "2.4 s", "1m 15s", "1h 1m".
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '0 ms';
  if (value < 1000) return `${Math.round(value)} ms`;
  const seconds = value / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)} s`;
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const totalSeconds = Math.round(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * Token counts with a compact suffix: 980 -> "980", 12300 -> "12.3k", 1500000 -> "1.5M".
 * @param {number} n
 * @returns {string}
 */
export function formatTokens(n) {
  const value = Number(n);
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value < 1000) return String(Math.round(value));
  if (value < 999_950) return `${trimDecimal(value / 1000)}k`;
  return `${trimDecimal(value / 1_000_000)}M`;
}

/**
 * Byte counts: 512 -> "512 B", 1536 -> "1.5 KB", 5242880 -> "5.0 MB".
 * @param {number} n
 * @returns {string}
 */
export function formatBytes(n) {
  const value = Number(n);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let scaled = value / 1024;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  const digits = scaled < 10 ? 1 : 0;
  return `${scaled.toFixed(digits)} ${units[unit]}`;
}

/**
 * Localized relative time ("3 minutes ago", "2 分钟前") for an epoch-ms timestamp or Date.
 * @param {number|Date|string} ts
 * @param {string} locale  e.g. 'en' or 'zh-CN'
 * @param {number} [now]   epoch ms, defaults to Date.now()
 * @returns {string} empty string for invalid input
 */
export function relativeTime(ts, locale, now = Date.now()) {
  const time = ts instanceof Date ? ts.getTime() : typeof ts === 'string' ? Date.parse(ts) : Number(ts);
  if (!Number.isFinite(time)) return '';
  const diffSeconds = Math.round((time - now) / 1000);
  const absolute = Math.abs(diffSeconds);
  /** @type {Array<[number, Intl.RelativeTimeFormatUnit, number]>} */
  const steps = [
    [60, 'second', 1],
    [3600, 'minute', 60],
    [86_400, 'hour', 3600],
    [86_400 * 30, 'day', 86_400],
    [86_400 * 365, 'month', 86_400 * 30],
  ];
  /** @type {Intl.RelativeTimeFormatUnit} */
  let unit = 'year';
  let amount = Math.round(diffSeconds / (86_400 * 365));
  for (const [limit, name, divisor] of steps) {
    if (absolute < limit) {
      unit = name;
      amount = Math.round(diffSeconds / divisor);
      break;
    }
  }
  try {
    const formatter = new Intl.RelativeTimeFormat(locale || 'en', { numeric: 'auto' });
    return formatter.format(amount, unit);
  } catch {
    return `${amount} ${unit}`;
  }
}

/**
 * Shortens a string in the middle with an ellipsis, keeping whole code points.
 * @param {string} str
 * @param {number} max  maximum length in code points (including the ellipsis)
 * @returns {string}
 */
export function truncateMiddle(str, max) {
  const text = String(str ?? '');
  const limit = Math.floor(Number(max));
  const chars = Array.from(text);
  if (!Number.isFinite(limit) || limit <= 0) return '';
  if (chars.length <= limit) return text;
  if (limit <= 3) return chars.slice(0, limit).join('');
  const keep = limit - 1;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${chars.slice(0, head).join('')}…${tail > 0 ? chars.slice(chars.length - tail).join('') : ''}`;
}

/**
 * Removes ANSI escape sequences (colors, cursor moves, OSC links) from terminal output.
 * @param {string} str
 * @returns {string}
 */
export function stripAnsi(str) {
  return String(str ?? '').replace(ANSI_RE, '');
}

/**
 * The key of a count-aware message in a locale: `${base}.one` for the singular form, `${base}.other` for the rest.
 * Every locale file carries both forms; a locale without a separate singular (zh-CN) gives the same text for both.
 * @param {string} base  e.g. 'cards.task.tools'
 * @param {number} count
 * @param {string} locale  e.g. 'en' or 'zh-CN'
 * @returns {string}
 */
export function pluralKey(base, count, locale) {
  let form = count === 1 ? 'one' : 'other';
  try {
    form = new Intl.PluralRules(locale || 'en').select(Number(count));
  } catch {
    // Keep the English split when the locale tag is not usable.
  }
  return `${base}.${form === 'one' ? 'one' : 'other'}`;
}

/**
 * @param {number} value
 * @returns {string}
 */
function trimDecimal(value) {
  const fixed = value < 100 ? value.toFixed(1) : String(Math.round(value));
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}
