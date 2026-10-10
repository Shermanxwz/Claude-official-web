/**
 * Context meter and compaction: the pure parts behind the header's context ring, the running line, the conversation's
 * compaction row and divider, and the context panel's live section (docs/PROTOCOL.md, "Context meter and compaction").
 * No DOM access, so the percent, tone, tooltip and divider text run unchanged in Node (test/unit/context.test.mjs).
 */

/** Share of the auto-compact point (the window when automatic compaction is off) where the meter turns attention. */
const ATTENTION_SHARE = 0.85;
/** Share of the window where the meter turns danger. */
const DANGER_SHARE = 0.95;
const TOKENS_PER_THOUSAND = 1000;
/** Counts from this value on read as millions: 999 960 is still "1000.0k" otherwise. */
const MILLION_FROM = 999_950;

/** @type {Map<string, Intl.NumberFormat>} */
const countFormatters = new Map();

/**
 * @typedef {'auto'|'manual'} Trigger
 * @typedef {{trigger: Trigger, preTokens: number, postTokens: number|null, durationMs: number|null, at: number}}
 *   LastCompaction
 * @typedef {{used: number|null, max: number|null, autoCompactAt: number|null, autoCompact: boolean|null,
 *   source: string|null, compacting: {since: number, trigger: Trigger|null}|null,
 *   lastCompaction: LastCompaction|null}} ContextMeter   (LiveInfo.context)
 * @typedef {'normal'|'attention'|'danger'} Tone
 * @typedef {{used: number, max: number, percent: number, fill: number, tone: Tone, autoCompact: boolean|null,
 *   autoCompactAt: number|null, tickPercent: number|null, compacting: boolean}} MeterView
 * @typedef {(key: string, vars?: Record<string, string|number>) => string} Translate
 */

/** @param {unknown} value @returns {number|null} the value when it is a finite number */
function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** @param {unknown} value @returns {number|null} the value when it is a finite number of zero or more */
function nonNegativeOrNull(value) {
  const number = finiteOrNull(value);
  return number !== null && number >= 0 ? number : null;
}

/**
 * The meter's figures from LiveInfo.context, or null while the window or the used tokens are unknown (the ring stays
 * hidden then). `fill` is the percent the ring draws (0 to 100); `percent` is the real share, which may pass 100.
 * @param {ContextMeter|null|undefined} context
 * @returns {MeterView|null}
 */
export function meterView(context) {
  if (!context || typeof context !== 'object') return null;
  const used = finiteOrNull(context.used);
  const max = finiteOrNull(context.max);
  if (used === null || max === null || max <= 0) return null;
  const threshold = finiteOrNull(context.autoCompactAt);
  const autoCompactAt = threshold !== null && threshold > 0 ? threshold : null;
  const percent = (Math.max(0, used) / max) * 100;
  return {
    used,
    max,
    percent,
    fill: Math.min(100, percent),
    tone: meterTone(used, max, autoCompactAt),
    autoCompact: typeof context.autoCompact === 'boolean' ? context.autoCompact : null,
    autoCompactAt,
    tickPercent: autoCompactAt !== null && autoCompactAt < max ? (autoCompactAt / max) * 100 : null,
    compacting: Boolean(context.compacting),
  };
}

/**
 * normal below 85 % of the auto-compact point (of the window when automatic compaction is off), attention from there,
 * danger from 95 % of the window. Tokens decide, so a figure past the window reads as danger.
 * @param {number} used
 * @param {number} max
 * @param {number|null} autoCompactAt
 * @returns {Tone}
 */
export function meterTone(used, max, autoCompactAt) {
  if (used >= max * DANGER_SHARE) return 'danger';
  if (used >= (autoCompactAt ?? max) * ATTENTION_SHARE) return 'attention';
  return 'normal';
}

/**
 * @param {number} value
 * @param {string} locale
 * @returns {string} a count with digit grouping, "38,416" in English and Chinese
 */
function formatCount(value, locale) {
  let formatter = countFormatters.get(locale);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale);
    countFormatters.set(locale, formatter);
  }
  return formatter.format(value);
}

/**
 * The ring's tooltip, which is also its accessible name: the figures, then what the meter does next. While a compaction
 * runs the last sentence says so, because the figure is the one from before it.
 * @param {MeterView} meter
 * @param {{t: Translate, locale: string}} options
 * @returns {string}
 */
export function meterTooltip(meter, { t, locale }) {
  const vars = {
    used: formatCount(meter.used, locale),
    max: formatCount(meter.max, locale),
    percent: Math.round(meter.percent),
  };
  if (meter.compacting) return t('header.context.tip.compacting', vars);
  if (meter.autoCompactAt !== null) {
    return t('header.context.tip.auto', { ...vars, tokens: formatCount(meter.autoCompactAt, locale) });
  }
  if (meter.autoCompact === false) return t('header.context.tip.off', vars);
  return t('header.context.tip.plain', vars);
}

/**
 * A token count with one decimal and a unit: 980 -> "980", 103509 -> "103.5k", 1960 -> "2.0k", 1500000 -> "1.5M".
 * Divider text uses this form, so the sizes of a compaction read the same in both languages.
 * @param {number} count
 * @returns {string}
 */
export function formatTokenCount(count) {
  const value = Math.max(0, Number(count) || 0);
  if (value < TOKENS_PER_THOUSAND) return String(Math.round(value));
  if (value < MILLION_FROM) return `${(value / TOKENS_PER_THOUSAND).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/**
 * Milliseconds as seconds with one decimal: 10515 -> "10.5".
 * @param {number} ms
 * @returns {string}
 */
export function formatSeconds(ms) {
  return (Math.max(0, Number(ms) || 0) / 1000).toFixed(1);
}

/**
 * Whole seconds that have passed since `since`, for the running line and the compacting row: 12400 -> 12. A start that
 * is not known (null) gives 0, so a row without one reads 0 s, not the time since the epoch.
 * @param {number|null|undefined} since epoch ms
 * @param {number} now epoch ms
 * @returns {number}
 */
export function elapsedSeconds(since, now) {
  if (!Number.isFinite(since)) return 0;
  const elapsed = Number(now) - Number(since);
  return Number.isFinite(elapsed) && elapsed > 0 ? Math.floor(elapsed / 1000) : 0;
}

/**
 * The divider's text for one compaction, from the boundary's metadata or from LiveInfo.context.lastCompaction. Parts
 * that are missing are dropped: no post-compaction size reads "Compacted automatically from 103.5k tokens".
 * @param {{trigger: Trigger|null, preTokens: number|null, postTokens: number|null, durationMs: number|null}} compaction
 * @param {Translate} t
 * @param {string} locale
 * @returns {string}
 */
export function compactionText(compaction, t, locale) {
  const head = t(headKey(compaction.trigger));
  const pre = nonNegativeOrNull(compaction.preTokens);
  const post = nonNegativeOrNull(compaction.postTokens);
  const duration = nonNegativeOrNull(compaction.durationMs);
  let tokens = null;
  if (pre !== null && post !== null) {
    tokens = t('cards.divider.pair', { before: formatTokenCount(pre), after: formatTokenCount(post) });
  } else if (pre !== null) {
    tokens = t('cards.divider.from', { before: formatTokenCount(pre) });
  } else if (post !== null) {
    tokens = t('cards.divider.to', { after: formatTokenCount(post) });
  }
  const seconds = duration !== null ? t('cards.divider.duration', { seconds: formatSeconds(duration) }) : null;
  let details = tokens ?? seconds;
  if (tokens && seconds) details = t('cards.divider.details', { tokens, duration: seconds });
  if (!details) return head;
  return t(pre !== null && post !== null ? 'cards.divider.withPair' : 'cards.divider.withDetails', { head, details });
}

/** @param {Trigger|null} trigger @returns {string} the divider's first words for the trigger */
function headKey(trigger) {
  if (trigger === 'auto') return 'cards.divider.auto';
  if (trigger === 'manual') return 'cards.divider.manual';
  return 'cards.divider.plain';
}

/**
 * The sizes of the session's last compaction, for the timeline's last compact divider when that divider has none: the
 * divider a transcript summary adds names no sizes, and a reload is where the session's own figures come in. Only the
 * last compact divider is looked at, so an older divider never takes a newer compaction's sizes. Null when the session
 * reports no compaction, when there is no compact divider, or when the last one already has its sizes.
 * @param {ContextMeter|null|undefined} context
 * @param {Array<Record<string, any>>} entries the timeline's entries, in order
 * @returns {{key: string, details: {trigger: Trigger|null, preTokens: number|null, postTokens: number|null,
 *   durationMs: number|null}}|null}
 */
export function lastCompactionDetails(context, entries) {
  const last = context?.lastCompaction;
  if (!last || typeof last !== 'object') return null;
  const dividers = entries.filter((entry) => entry.kind === 'divider' && entry.variant === 'compact');
  const divider = dividers[dividers.length - 1];
  if (!divider || Number.isFinite(divider.preTokens)) return null;
  return {
    key: divider.key,
    details: {
      trigger: last.trigger ?? null,
      preTokens: finiteOrNull(last.preTokens),
      postTokens: finiteOrNull(last.postTokens),
      durationMs: finiteOrNull(last.durationMs),
    },
  };
}

/**
 * When the compaction in progress started, in epoch ms. The timeline's own row knows it from the status it saw; after a
 * reload there is no row, and the session's start (LiveInfo.context.compacting.since) still names the compaction.
 * @param {number|null|undefined} rowSince the row's start, or null when the timeline shows none
 * @param {number|null|undefined} sessionSince the session's start, in this browser's clock (sessionCompactingStart)
 * @returns {number|null}
 */
export function compactingStart(rowSince, sessionSince) {
  if (Number.isFinite(rowSince)) return /** @type {number} */ (rowSince);
  return Number.isFinite(sessionSince) ? /** @type {number} */ (sessionSince) : null;
}

/**
 * When the compaction the session reports started, in this browser's clock. The session snapshot carries the gateway's
 * clock as `now`, and `clockOffset` is that clock minus this browser's, so the gateway's `since` less the offset is the
 * browser's time. Null while no compaction runs or its start is not known.
 * @param {ContextMeter|null|undefined} context
 * @param {number} clockOffset the gateway's clock minus this browser's clock, epoch ms
 * @returns {number|null}
 */
export function sessionCompactingStart(context, clockOffset) {
  const since = finiteOrNull(context?.compacting?.since);
  return since === null ? null : since - clockOffset;
}
