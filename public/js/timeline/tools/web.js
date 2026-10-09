/**
 * Renderers for web tools: WebSearch (result links) and WebFetch (page URL, prompt and rendered result).
 * Only http and https URLs become links; they open in a new tab without a referrer or opener.
 */

import { h, icon } from '../../dom.js';
import { formatBytes, formatDuration } from '../format.js';
import {
  cappedList,
  chip,
  copyButton,
  errorBlock,
  linkAction,
  markdownBlock,
  section,
  statusOf,
  toolShell,
} from './shell.js';
import { domainOf, finiteNumber, isRecord, resultText, str, truncate } from './summaries.js';

const LINK_LIMIT = 20;
const SUBTITLE_MAX = 240;
const MARKDOWN_LINK = /\[([^\]\n]{1,300})\]\((https?:\/\/[^\s)]+)\)/g;
const BARE_URL = /https?:\/\/[^\s<>"'`)\]]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/**
 * @typedef {{ href: string, title: string }} SearchLink
 */

/**
 * @param {import('./index.js').ToolCard} card
 * @param {import('./index.js').ToolContext} ctx
 * @returns {HTMLElement}
 */
export function render(card, ctx) {
  return card.name === 'WebFetch' ? renderFetch(card, ctx) : renderSearch(card, ctx);
}

/**
 * @param {import('./index.js').ToolCard} card
 * @param {import('./index.js').ToolContext} ctx
 * @returns {HTMLElement}
 */
function renderSearch(card, ctx) {
  const { t } = ctx;
  const input = recordOf(card.input);
  const structured = recordOf(card.structured);
  const query = str(input.query) || str(structured.query);
  const links = searchLinks(card, structured);
  const text = resultText(card.result);
  const extras = [];
  if (card.result && links.length > 0) extras.push(chip(countText(t, 'results', links.length)));
  return toolShell({
    iconName: 'globe',
    title: 'WebSearch',
    subtitle: truncate(query, SUBTITLE_MAX),
    status: statusOf(card),
    body: () => searchBody(card, links, text, structured, ctx),
    open: Boolean(ctx.open || card.pendingRequestId),
    actions: query ? [copyButton({ text: query, t, label: t('tools.web.copyQuery') })] : [],
    extras,
    t,
    family: 'web',
  });
}

/**
 * @param {import('./index.js').ToolCard} card
 * @param {SearchLink[]} links
 * @param {string} text
 * @param {Record<string, unknown>} structured
 * @param {import('./index.js').ToolContext} ctx
 * @returns {HTMLElement}
 */
function searchBody(card, links, text, structured, ctx) {
  const { t } = ctx;
  const parts = [];
  const meta = [];
  const searches = finiteNumber(structured.searchCount);
  if (searches != null) meta.push(chip(countText(t, 'searches', searches)));
  const seconds = finiteNumber(structured.durationSeconds);
  if (seconds != null) meta.push(chip(formatDuration(seconds * 1000), { mono: true }));
  if (meta.length > 0) parts.push(h('div', { class: 'tool-meta' }, meta));
  if (card.result?.isError) parts.push(errorBlock(text, t));
  if (links.length > 0) {
    parts.push(
      h('div', { class: 'tool-scroll' }, [
        cappedList({
          items: links,
          limit: LINK_LIMIT,
          renderItem: linkRow,
          moreLabel: t('tools.web.showMore', { count: links.length - LINK_LIMIT }),
          className: 'tool-links',
        }),
      ]),
    );
  }
  if (text && !card.result?.isError) {
    if (links.length === 0) {
      parts.push(markdownBlock(text, ctx.renderMarkdown));
    } else {
      parts.push(section({ title: t('tools.web.fullResult'), body: () => markdownBlock(text, ctx.renderMarkdown) }));
    }
  }
  return h('div', { class: 'tool-web' }, parts);
}

/**
 * @param {import('./index.js').ToolCard} card
 * @param {import('./index.js').ToolContext} ctx
 * @returns {HTMLElement}
 */
function renderFetch(card, ctx) {
  const { t } = ctx;
  const input = recordOf(card.input);
  const structured = recordOf(card.structured);
  const url = str(input.url) || str(structured.url);
  const href = safeHref(url);
  const domain = domainOf(url);
  const text = typeof structured.result === 'string' ? structured.result : resultText(card.result);
  const actions = [];
  if (href) {
    actions.push(linkAction(href, t('tools.web.openPage')));
    actions.push(copyButton({ text: href, t, label: t('tools.web.copyUrl') }));
  }
  return toolShell({
    iconName: 'globe',
    title: 'WebFetch',
    subtitle: truncate(url, SUBTITLE_MAX),
    status: statusOf(card),
    body: () => fetchBody(card, input, structured, text, ctx),
    open: Boolean(ctx.open || card.pendingRequestId),
    actions,
    extras: domain ? [chip(domain, { mono: true })] : [],
    t,
    family: 'web',
  });
}

/**
 * @param {import('./index.js').ToolCard} card
 * @param {Record<string, unknown>} input
 * @param {Record<string, unknown>} structured
 * @param {string} text
 * @param {import('./index.js').ToolContext} ctx
 * @returns {HTMLElement}
 */
function fetchBody(card, input, structured, text, ctx) {
  const { t } = ctx;
  const parts = [];
  const meta = [];
  const code = finiteNumber(structured.code);
  if (code != null) {
    const codeText = str(structured.codeText);
    const kind = code >= 200 && code < 300 ? 'success' : 'danger';
    meta.push(chip(codeText ? `${code} ${codeText}` : String(code), { kind, mono: true }));
  }
  const bytes = finiteNumber(structured.bytes);
  if (bytes != null) meta.push(chip(formatBytes(bytes), { mono: true }));
  const duration = finiteNumber(structured.durationMs);
  if (duration != null) meta.push(chip(formatDuration(duration), { mono: true }));
  if (meta.length > 0) parts.push(h('div', { class: 'tool-meta' }, meta));
  const prompt = str(input.prompt);
  if (prompt) {
    const promptBody = h('div', { class: 'tool-plain', text: prompt });
    parts.push(section({ title: t('tools.web.prompt'), body: promptBody }));
  }
  if (card.result?.isError) parts.push(errorBlock(text, t));
  else if (text) parts.push(markdownBlock(text, ctx.renderMarkdown));
  return h('div', { class: 'tool-web' }, parts);
}

/**
 * Links of a search result: the structured hits when present, otherwise links found in the result text.
 * @param {import('./index.js').ToolCard} card
 * @param {Record<string, unknown>} structured
 * @returns {SearchLink[]}
 */
function searchLinks(card, structured) {
  /** @type {SearchLink[]} */
  const links = [];
  const seen = new Set();
  const add = (raw, title) => {
    const href = safeHref(raw);
    if (!href || seen.has(href)) return;
    seen.add(href);
    links.push({ href, title: str(title).trim() });
  };
  if (Array.isArray(structured.results)) {
    for (const entry of structured.results) {
      if (!isRecord(entry) || !Array.isArray(entry.content)) continue;
      for (const hit of entry.content) if (isRecord(hit)) add(hit.url, hit.title);
    }
  }
  if (links.length === 0) {
    const text = resultText(card.result);
    for (const match of text.matchAll(MARKDOWN_LINK)) add(match[2], match[1]);
    for (const match of text.matchAll(BARE_URL)) add(match[0].replace(TRAILING_PUNCTUATION, ''), '');
  }
  return links;
}

/**
 * @param {SearchLink} link
 * @returns {HTMLElement}
 */
function linkRow(link) {
  const domain = domainOf(link.href);
  return h('div', { class: 'tool-link-row' }, [
    h('a', { class: 'tool-link', attrs: { href: link.href, target: '_blank', rel: 'noopener noreferrer' } }, [
      icon('external'),
      h('span', { class: 'tool-link-title', text: link.title || link.href }),
    ]),
    chip(domain, { mono: true, title: link.href }),
  ]);
}

/**
 * "1 result" / "N results" style counts.
 * @param {import('./index.js').Translate} t
 * @param {'results' | 'searches'} noun
 * @param {number} count
 * @returns {string}
 */
function countText(t, noun, count) {
  return count === 1 ? t(`tools.web.one.${noun}`) : t(`tools.web.${noun}`, { count });
}

/**
 * @param {unknown} raw
 * @returns {string | null}
 */
function safeHref(raw) {
  try {
    const url = new URL(str(raw).trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function recordOf(value) {
  return isRecord(value) ? value : {};
}
