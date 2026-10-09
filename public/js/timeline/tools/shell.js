/**
 * Shared DOM building blocks for every tool card: the card shell, status badge, copy button, chips, collapsible
 * sections, code blocks and capped lists. All DOM is built with h()/icon() and textContent; nothing is parsed as HTML.
 */

import { h, icon } from '../../dom.js';
import { t as defaultT } from '../../i18n.js';

/** @typedef {'running' | 'done' | 'error' | 'waiting'} ToolStatus */
/** @typedef {(key: string, vars?: Record<string, string | number>) => string} Translate */

const STATUS_ICON = { done: 'check', error: 'alert', waiting: 'clock' };

/**
 * Status of a tool card. Returns null for a card that sits inside a permission request, where the request card carries
 * the state and the tool card shows no badge.
 * @param {{ result?: { isError?: boolean } | null, running?: boolean, pendingRequestId?: string }} card
 * @returns {ToolStatus | null}
 */
export function statusOf(card) {
  if (card.pendingRequestId) return null;
  if (card.result) return card.result.isError ? 'error' : 'done';
  return card.running ? 'running' : 'done';
}

/**
 * Collapsible tool card. `body` is either a Node or a function returning one; a function is called on the first open
 * (immediately when the card starts open).
 * @param {{
 *   iconName: string,
 *   title: string,
 *   subtitle?: string,
 *   status?: ToolStatus | null,
 *   body?: Node | (() => Node | null | undefined) | null,
 *   open?: boolean,
 *   actions?: HTMLElement[],
 *   extras?: HTMLElement[],
 *   t?: Translate,
 *   family?: string,
 * }} options `extras` are small chips placed after the subtitle (diff counts, for example)
 * @returns {HTMLDetailsElement}
 */
export function toolShell(options) {
  const translate = options.t ?? defaultT;
  const status = options.status ?? null;
  const details = h('details', {
    class: ['tool-card', status ? `tool-status-${status}` : 'tool-status-pending'],
    dataset: { toolFamily: options.family ?? null, toolStatus: status ?? 'pending' },
    attrs: { open: Boolean(options.open) },
  });
  const summary = h(
    'summary',
    { class: 'tool-head' },
    h('span', { class: 'tool-icon' }, icon(options.iconName)),
    h('span', { class: 'tool-title', text: options.title }),
    options.subtitle ? h('span', { class: 'tool-subtitle', text: options.subtitle, title: options.subtitle }) : null,
    options.extras ?? null,
    statusBadge(status, translate),
    h('span', { class: 'tool-chevron' }, icon('chevron-down')),
  );
  const host = h('div', { class: 'tool-body' });
  details.append(summary, host);
  attachBody(details, host, options.body, Boolean(options.open), options.actions ?? [], translate);
  return details;
}

/**
 * Copy-to-clipboard button with a short confirmation. Clipboard failures are reported in the label, never thrown.
 * @param {{ text: string, t?: Translate, label?: string }} options
 * @returns {HTMLButtonElement}
 */
export function copyButton({ text, t: translate = defaultT, label }) {
  const idle = translate('tools.copy');
  const labelEl = h('span', { text: idle });
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  return h(
    'button',
    {
      class: 'tool-action',
      attrs: { type: 'button', 'aria-label': label ?? idle },
      on: {
        click: async () => {
          let message = translate('tools.copied');
          try {
            await navigator.clipboard.writeText(text);
          } catch {
            message = translate('tools.copyFailed');
          }
          labelEl.textContent = message;
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            labelEl.textContent = idle;
            timer = null;
          }, 1500);
        },
      },
    },
    icon('copy'),
    labelEl,
  );
}

/**
 * Small pill used for flags, counts and identifiers.
 * @param {string} text
 * @param {{ kind?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger', title?: string, mono?: boolean }} [options]
 * @returns {HTMLElement}
 */
export function chip(text, options = {}) {
  return h('span', {
    class: ['tool-chip', options.kind ? `tool-chip-${options.kind}` : null, options.mono ? 'tool-chip-mono' : null],
    text,
    title: options.title ?? text,
  });
}

/**
 * Collapsible section inside a card (prompt, nested activity, plan, raw output). Shares the lazy-body rule of
 * toolShell. `subtitle` is a one-line muted hint shown in the header, such as the latest activity of a subagent.
 * @param {{
 *   title: string,
 *   body?: Node | (() => Node | null | undefined) | null,
 *   open?: boolean,
 *   count?: string | number | null,
 *   subtitle?: string,
 *   className?: string,
 * }} options
 * @returns {HTMLDetailsElement}
 */
export function section(options) {
  const details = h('details', {
    class: ['tool-section', options.className ?? null],
    attrs: { open: Boolean(options.open) },
  });
  const summary = h(
    'summary',
    { class: 'tool-section-head' },
    h('span', { class: 'tool-section-chevron' }, icon('chevron-right')),
    h('span', { class: 'tool-section-title', text: options.title }),
    options.subtitle ? h('span', { class: 'tool-section-sub', text: options.subtitle, title: options.subtitle }) : null,
    options.count != null ? chip(String(options.count)) : null,
  );
  const host = h('div', { class: 'tool-section-body' });
  details.append(summary, host);
  attachBody(details, host, options.body, Boolean(options.open), [], defaultT);
  return details;
}

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const BASE64 = /^[A-Za-z0-9+/=\r\n]+$/;

/**
 * Inline image from base64 data, shown through a data: URL (allowed by the CSP). Returns null for an unsupported
 * media type or data that is not base64.
 * @param {unknown} mediaType
 * @param {unknown} data
 * @param {string} alt
 * @returns {HTMLElement | null}
 */
export function imageNode(mediaType, data, alt) {
  if (typeof mediaType !== 'string' || !IMAGE_TYPES.has(mediaType)) return null;
  if (typeof data !== 'string' || data === '' || !BASE64.test(data)) return null;
  return h('img', {
    class: 'tool-image',
    attrs: { src: `data:${mediaType};base64,${data}`, alt, loading: 'lazy', decoding: 'async' },
  });
}

/**
 * Images attached to a tool result (`result.images`, base64 with a media type), as inline images.
 * @param {{ images?: unknown } | null | undefined} result
 * @param {string} alt
 * @returns {HTMLElement[]}
 */
export function resultImages(result, alt) {
  const images = Array.isArray(result?.images) ? result.images : [];
  /** @type {HTMLElement[]} */
  const nodes = [];
  for (const image of images) {
    if (!image || typeof image !== 'object') continue;
    const { mediaType, data } = /** @type {{ mediaType?: unknown, data?: unknown }} */ (image);
    const node = imageNode(mediaType, data, alt);
    if (node) nodes.push(node);
  }
  return nodes;
}

/**
 * Model output rendered through the sanitized Markdown renderer (never through innerHTML).
 * @param {string} text
 * @param {(text: string) => HTMLElement} renderMarkdown
 * @returns {HTMLElement}
 */
export function markdownBlock(text, renderMarkdown) {
  return h('div', { class: 'tool-markdown' }, renderMarkdown(text));
}

/**
 * Muted one-line note, such as "No output" or a state description.
 * @param {string} text
 * @returns {HTMLElement}
 */
export function mutedNote(text) {
  return h('p', { class: 'tool-muted', text });
}

/**
 * Error text of a failed tool result, shown in the error color under a caption. Returns null when there is no error.
 * @param {string} text
 * @param {Translate} translate
 * @returns {HTMLElement | null}
 */
export function errorBlock(text, translate = defaultT) {
  if (!text) return null;
  return h('div', { class: 'tool-error' }, [
    h('div', { class: 'tool-caption tool-caption-error', text: translate('tools.error') }),
    codeBlock(text, { className: 'tool-code-error' }),
  ]);
}

/**
 * Preformatted text. Text is set with textContent; long lines scroll inside the block, never the page.
 * @param {string} text
 * @param {{ className?: string, label?: string }} [options]
 * @returns {HTMLPreElement}
 */
export function codeBlock(text, options = {}) {
  return h('pre', {
    class: ['tool-code', options.className ?? null],
    attrs: { tabindex: '0', 'aria-label': options.label ?? null },
    text,
  });
}

/**
 * Renders at most `limit` items immediately; the rest are appended when the "more" button is pressed.
 * @template T
 * @param {{
 *   items: T[],
 *   limit: number,
 *   renderItem: (item: T, index: number) => Node,
 *   moreLabel: string,
 *   className?: string,
 * }} options
 * @returns {HTMLElement}
 */
export function cappedList(options) {
  const list = h('div', { class: ['tool-list', options.className ?? null] });
  const wrap = h('div', { class: 'tool-list-wrap' }, list);
  const { items, limit, renderItem } = options;
  items.slice(0, limit).forEach((item, index) => list.appendChild(renderItem(item, index)));
  if (items.length > limit) {
    const more = h('button', {
      class: 'tool-more',
      attrs: { type: 'button' },
      text: options.moreLabel,
      on: {
        click: () => {
          items.slice(limit).forEach((item, offset) => list.appendChild(renderItem(item, limit + offset)));
          more.remove();
        },
      },
    });
    wrap.appendChild(more);
  }
  return wrap;
}

/**
 * Key/value rows for structured inputs. Values are Nodes or strings.
 * @param {Array<[string, Node | string | null | undefined]>} rows
 * @returns {HTMLElement}
 */
export function keyValueList(rows) {
  return h(
    'dl',
    { class: 'tool-kv' },
    rows.map(([key, value]) => [
      h('dt', { text: key }),
      h('dd', null, value instanceof Node ? value : h('span', { text: value ?? '' })),
    ]),
  );
}

/**
 * JSON text for display. Never throws: cycles and unserializable values give a placeholder.
 * @param {unknown} value
 * @returns {string}
 */
export function prettyJson(value) {
  try {
    const text = JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item), 2);
    return text === undefined ? '' : text;
  } catch {
    return '[unserializable]';
  }
}

/**
 * Rendering of a card body: function bodies are built on demand, and action buttons go above the content. A body that
 * throws leaves a short note in place of its content, so one unexpected result never breaks the timeline.
 * @param {HTMLDetailsElement} details
 * @param {HTMLElement} host
 * @param {Node | (() => Node | null | undefined) | null | undefined} body
 * @param {boolean} eager build now instead of on first open
 * @param {HTMLElement[]} actions
 * @param {Translate} translate
 */
function attachBody(details, host, body, eager, actions, translate) {
  let built = false;
  const build = () => {
    if (built) return;
    built = true;
    try {
      if (actions.length > 0) host.appendChild(h('div', { class: 'tool-actions' }, actions));
      const node = typeof body === 'function' ? body() : body;
      if (node instanceof Node) host.appendChild(node);
    } catch (error) {
      console.error('tool card body failed', error);
      host.appendChild(mutedNote(translate('tools.bodyFailed')));
    }
  };
  if (eager || typeof body !== 'function') build();
  details.addEventListener('toggle', () => {
    if (details.open) build();
  });
}

/**
 * @param {ToolStatus | null} status
 * @param {Translate} translate
 * @returns {HTMLElement | null}
 */
function statusBadge(status, translate) {
  if (!status) return null;
  const mark =
    status === 'running'
      ? h('span', { class: 'tool-spinner', attrs: { 'aria-hidden': 'true' } })
      : icon(STATUS_ICON[status]);
  return h(
    'span',
    { class: ['tool-badge', `tool-badge-${status}`] },
    mark,
    h('span', { text: translate(`tools.status.${status}`) }),
  );
}
