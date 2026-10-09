/**
 * Renderers for search and listing tools: Grep, Glob and LS. Results are capped at 200 rows with a "show more" control.
 */

import { h } from '../../dom.js';
import { cappedList, chip, copyButton, errorBlock, statusOf, toolShell } from './shell.js';
import { displayPath, finiteNumber, globCount, grepStats, isRecord, resultText, str, truncate } from './summaries.js';

const ROW_LIMIT = 200;
const SUBTITLE_MAX = 240;

/**
 * @param {import('./index.js').ToolCard} card
 * @param {import('./index.js').ToolContext} ctx
 * @returns {HTMLElement}
 */
export function render(card, ctx) {
  switch (card.name) {
    case 'Glob':
      return renderGlob(card, ctx);
    case 'LS':
      return renderLs(card, ctx);
    default:
      return renderGrep(card, ctx);
  }
}

/**
 * @param {import('./index.js').ToolCard} card
 * @param {import('./index.js').ToolContext} ctx
 * @returns {HTMLElement}
 */
function renderGrep(card, ctx) {
  const { t } = ctx;
  const input = recordOf(card.input);
  const structured = recordOf(card.structured);
  const stats = grepStats(input, card.result ?? undefined, structured);
  const rows = grepRows(card, structured, stats.mode, ctx.cwd);
  const pattern = str(input.pattern);
  return toolShell({
    iconName: 'search',
    title: 'Grep',
    subtitle: truncate(pattern, SUBTITLE_MAX),
    status: statusOf(card),
    body: () => {
      const meta = grepFlags(input, ctx.cwd, t);
      return searchBody(card, rows, meta, t);
    },
    open: Boolean(ctx.open || card.pendingRequestId),
    actions: rows.length > 0 ? [copyButton({ text: rows.join('\n'), t, label: t('tools.search.copyResults') })] : [],
    extras: stats.count != null ? [countChip(stats.mode, stats.count, t)] : [],
    t,
    family: 'search',
  });
}

/**
 * @param {import('./index.js').ToolCard} card
 * @param {import('./index.js').ToolContext} ctx
 * @returns {HTMLElement}
 */
function renderGlob(card, ctx) {
  const { t } = ctx;
  const input = recordOf(card.input);
  const structured = recordOf(card.structured);
  const rows = globRows(card, structured, ctx.cwd);
  const count = globCount(card.result ?? undefined, structured);
  const extras = [];
  if (count != null) extras.push(chip(countText(t, 'files', count)));
  if (structured.truncated === true) extras.push(chip(t('tools.search.truncated'), { kind: 'warning' }));
  return toolShell({
    iconName: 'search',
    title: 'Glob',
    subtitle: truncate(str(input.pattern), SUBTITLE_MAX),
    status: statusOf(card),
    body: () => {
      const meta = [];
      const scope = displayPath(input.path, ctx.cwd);
      if (scope && scope !== '.') meta.push(chip(`${t('tools.search.flag.path')}: ${scope}`, { mono: true }));
      const total = finiteNumber(structured.totalMatches);
      if (total != null && count != null && total > count) {
        meta.push(chip(t('tools.search.ofTotal', { shown: count, total })));
      }
      return searchBody(card, rows, meta, t);
    },
    open: Boolean(ctx.open || card.pendingRequestId),
    actions: rows.length > 0 ? [copyButton({ text: rows.join('\n'), t, label: t('tools.search.copyResults') })] : [],
    extras,
    t,
    family: 'search',
  });
}

/**
 * @param {import('./index.js').ToolCard} card
 * @param {import('./index.js').ToolContext} ctx
 * @returns {HTMLElement}
 */
function renderLs(card, ctx) {
  const { t } = ctx;
  const input = recordOf(card.input);
  const rows = listingRows(card);
  return toolShell({
    iconName: 'folder',
    title: 'LS',
    subtitle: displayPath(input.path, ctx.cwd) || '.',
    status: statusOf(card),
    body: () => searchBody(card, rows, [], t),
    open: Boolean(ctx.open || card.pendingRequestId),
    actions: rows.length > 0 ? [copyButton({ text: rows.join('\n'), t, label: t('tools.search.copyResults') })] : [],
    t,
    family: 'search',
  });
}

/**
 * Rows of a Grep result: file names, matching lines or per-file counts, depending on the output mode.
 * @param {import('./index.js').ToolCard} card
 * @param {Record<string, unknown>} structured
 * @param {'content' | 'count' | 'files_with_matches'} mode
 * @param {unknown} cwd
 * @returns {string[]}
 */
function grepRows(card, structured, mode, cwd) {
  if (!card.result && !structured.filenames) return [];
  if (mode === 'files_with_matches') {
    if (Array.isArray(structured.filenames) && structured.filenames.length > 0) {
      return structured.filenames.filter((name) => typeof name === 'string').map((name) => displayPath(name, cwd));
    }
    return nonEmptyLines(resultText(card.result)).map((line) => displayPath(line, cwd));
  }
  const text = typeof structured.content === 'string' ? structured.content : resultText(card.result);
  return nonEmptyLines(text).map((line) => shortenIn(line, cwd));
}

/**
 * @param {import('./index.js').ToolCard} card
 * @param {Record<string, unknown>} structured
 * @param {unknown} cwd
 * @returns {string[]}
 */
function globRows(card, structured, cwd) {
  if (Array.isArray(structured.filenames) && structured.filenames.length > 0) {
    return structured.filenames.filter((name) => typeof name === 'string').map((name) => displayPath(name, cwd));
  }
  return nonEmptyLines(resultText(card.result)).map((line) => displayPath(line, cwd));
}

/**
 * @param {import('./index.js').ToolCard} card
 * @returns {string[]}
 */
function listingRows(card) {
  return nonEmptyLines(resultText(card.result));
}

/**
 * Flag chips for the Grep input (path, glob, type, mode, case, context, limits).
 * @param {Record<string, unknown>} input
 * @param {unknown} cwd
 * @param {import('./index.js').Translate} t
 * @returns {HTMLElement[]}
 */
function grepFlags(input, cwd, t) {
  const chips = [];
  const labelled = (key, value, options = {}) => {
    const label = `${t(`tools.search.flag.${key}`)}: ${value}`;
    chips.push(chip(label, { mono: options.mono === true, title: options.title }));
  };
  const scope = displayPath(input.path, cwd);
  if (scope && scope !== '.') labelled('path', scope, { mono: true, title: str(input.path) });
  if (str(input.glob)) labelled('glob', str(input.glob), { mono: true });
  if (str(input.type)) labelled('type', str(input.type), { mono: true });
  if (input.output_mode === 'content' || input.output_mode === 'count') labelled('mode', input.output_mode);
  if (input['-i'] === true) chips.push(chip(t('tools.search.flag.ignoreCase')));
  if (input.multiline === true) chips.push(chip(t('tools.search.flag.multiline')));
  const around = finiteNumber(input.context) ?? finiteNumber(input['-C']);
  const before = finiteNumber(input['-B']);
  const after = finiteNumber(input['-A']);
  if (around != null) labelled('context', `±${around}`);
  if (before != null) labelled('before', String(before));
  if (after != null) labelled('after', String(after));
  if (finiteNumber(input.head_limit) != null) labelled('limit', String(input.head_limit));
  if (finiteNumber(input.offset) != null) labelled('offset', String(input.offset));
  return chips;
}

/**
 * @param {import('./index.js').ToolCard} card
 * @param {string[]} rows
 * @param {HTMLElement[]} meta
 * @param {import('./index.js').Translate} t
 * @returns {HTMLElement}
 */
function searchBody(card, rows, meta, t) {
  const parts = [];
  if (card.result?.isError) parts.push(errorBlock(resultText(card.result), t));
  if (meta.length > 0) parts.push(h('div', { class: 'tool-meta' }, meta));
  if (rows.length > 0) {
    parts.push(
      h('div', { class: 'tool-scroll' }, [
        cappedList({
          items: rows,
          limit: ROW_LIMIT,
          renderItem: (line) => h('div', { class: 'tool-row', text: line }),
          moreLabel: t('tools.search.showMore', { count: rows.length - ROW_LIMIT }),
          className: 'tool-rows',
        }),
      ]),
    );
  } else if (card.result && !card.result.isError) {
    parts.push(h('p', { class: 'tool-muted', text: t('tools.search.noResults') }));
  }
  return h('div', { class: 'tool-search' }, parts);
}

/**
 * @param {'content' | 'count' | 'files_with_matches'} mode
 * @param {number} count
 * @param {import('./index.js').Translate} t
 * @returns {HTMLElement}
 */
function countChip(mode, count, t) {
  return chip(countText(t, mode === 'files_with_matches' ? 'files' : 'matches', count), { kind: 'accent' });
}

/**
 * "1 file" / "N files" and the matches equivalents.
 * @param {import('./index.js').Translate} t
 * @param {'files' | 'matches'} noun
 * @param {number} count
 * @returns {string}
 */
function countText(t, noun, count) {
  return count === 1 ? t(`tools.search.one.${noun}`) : t(`tools.search.${noun}`, { count });
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function nonEmptyLines(text) {
  return text.split(/\r?\n/).filter((line) => line.trim() !== '');
}

/**
 * Removes the working directory prefix from absolute paths inside a line of grep output.
 * @param {string} line
 * @param {unknown} cwd
 * @returns {string}
 */
function shortenIn(line, cwd) {
  const root = str(cwd).replace(/[\\/]+$/, '');
  return root ? line.split(`${root}/`).join('') : line;
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function recordOf(value) {
  return isRecord(value) ? value : {};
}
