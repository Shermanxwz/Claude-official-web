/**
 * Shared DOM building blocks for every tool card: the card shell, status badge, copy button, chips, collapsible
 * sections, code blocks and capped lists. All DOM is built with h()/icon() and textContent; nothing is parsed as HTML.
 */

import { h, icon } from '../../dom.js';
import { t as defaultT } from '../../i18n.js';
import { openDialog } from '../../ui/dialog.js';
import { imageSource } from './images.js';

/** @typedef {'running' | 'done' | 'error' | 'waiting'} ToolStatus */
/** @typedef {(key: string, vars?: Record<string, string | number>) => string} Translate */

/**
 * Status of a tool card: waiting while its request waits for the user (the request card above the composer carries the
 * decision), error or done once it has a result, running while it runs.
 * @param {{ result?: { isError?: boolean } | null, running?: boolean, pendingRequestId?: string }} card
 * @returns {ToolStatus}
 */
export function statusOf(card) {
  if (card.pendingRequestId) return 'waiting';
  if (card.result) return card.result.isError ? 'error' : 'done';
  return card.running ? 'running' : 'done';
}

/** Action-log verbs (tools.verb.*) of the built-in tools; a name not listed here is shown as it is. */
const VERB_KEYS = Object.freeze({
  Read: 'tools.verb.read',
  Write: 'tools.verb.write',
  Edit: 'tools.verb.edit',
  MultiEdit: 'tools.verb.edit',
  NotebookEdit: 'tools.verb.notebook',
  Bash: 'tools.verb.run',
  BashOutput: 'tools.verb.output',
  Monitor: 'tools.verb.monitor',
  KillShell: 'tools.verb.stop',
  KillBash: 'tools.verb.stop',
  TaskStop: 'tools.verb.stop',
  Grep: 'tools.verb.search',
  Glob: 'tools.verb.find',
  LS: 'tools.verb.list',
  WebFetch: 'tools.verb.fetch',
  WebSearch: 'tools.verb.webSearch',
  Agent: 'tools.verb.agent',
  Task: 'tools.verb.agent',
  TodoWrite: 'tools.verb.todo',
  TaskCreate: 'tools.verb.todo',
  TaskUpdate: 'tools.verb.todo',
  TaskList: 'tools.verb.todo',
  TaskGet: 'tools.verb.todo',
  ExitPlanMode: 'tools.verb.plan',
  EnterPlanMode: 'tools.verb.plan',
});

/**
 * The verb a tool row starts with: "Read", "Run", "Search"… for a built-in tool, the tool's own name otherwise.
 * @param {string} name tool name as the runtime reports it
 * @param {Translate} translate
 * @returns {string}
 */
export function verbOf(name, translate = defaultT) {
  const key = Object.hasOwn(VERB_KEYS, name) ? VERB_KEYS[name] : null;
  if (key) return translate(key);
  return name || translate('tools.verb.tool');
}

/**
 * Collapsible tool row of the action log: a state glyph, the verb (sans), the target (mono, one line), the extras on
 * the right (a diff stat or a duration). `body` is either a Node or a function returning one. A function is called on
 * the first open (immediately when the row starts open) with the action toolbar, to which it may append controls.
 * @param {{
 *   title: string,
 *   subtitle?: string,
 *   status?: ToolStatus | null,
 *   body?: Node | ((toolbar: HTMLElement) => Node | null | undefined) | null,
 *   open?: boolean,
 *   actions?: HTMLElement[],
 *   extras?: HTMLElement[],
 *   t?: Translate,
 *   family?: string,
 * }} options `title` is the verb, `subtitle` the target, `extras` the chips placed at the right (diff counts, for
 * example)
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
    statusGlyph(status, translate),
    h('span', { class: 'tool-title', text: options.title }),
    options.subtitle ? h('span', { class: 'tool-subtitle', text: options.subtitle, title: options.subtitle }) : null,
    options.extras && options.extras.length > 0 ? h('span', { class: 'tool-extras' }, options.extras) : null,
    h('span', { class: 'tool-chevron', attrs: { 'aria-hidden': 'true' } }, icon('chevron-right')),
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
 * Icon-only copy button for the corner of a block. Its name is the label; after a copy it shows a check (or a cross)
 * for a moment, and the title says what happened.
 * @param {{ text: string, t?: Translate, label: string }} options
 * @returns {HTMLButtonElement}
 */
export function copyIconButton({ text, t: translate = defaultT, label }) {
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  const button = /** @type {HTMLButtonElement} */ (h('button', {
    class: 'tool-copy-icon',
    attrs: { type: 'button', 'aria-label': label, title: label },
    on: {
      click: async () => {
        let copied = true;
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          copied = false;
        }
        button.title = translate(copied ? 'tools.copied' : 'tools.copyFailed');
        button.replaceChildren(icon(copied ? 'check' : 'x'));
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          button.title = label;
          button.replaceChildren(icon('copy'));
          timer = null;
        }, 1500);
      },
    },
  }, icon('copy')));
  return button;
}

/**
 * Link styled as a toolbar action. It opens in a new tab without a referrer or opener; callers pass only http or https
 * URLs.
 * @param {string} href
 * @param {string} label
 * @returns {HTMLAnchorElement}
 */
export function linkAction(href, label) {
  return h(
    'a',
    { class: 'tool-action', attrs: { href, target: '_blank', rel: 'noopener noreferrer' } },
    icon('external'),
    h('span', { text: label }),
  );
}

/**
 * "Run in background" for a foreground task (a Bash command or a subagent) that is still running and has no result yet.
 * It moves that task to the background through `ctx.background`, and stays disabled until the request settles. The
 * control belongs to the action row of the card body, never to its summary, so a click does not toggle the details.
 * Returns null when the card does not offer it: no background access, no tool use id, not running, already answered,
 * waiting for a permission decision, or started with run_in_background.
 * @param {{ id?: string, running: boolean, result?: unknown, input?: unknown, pendingRequestId?: string }} card
 * @param {{ background?: (toolUseId: string) => Promise<void>, t?: Translate }} ctx
 * @returns {HTMLButtonElement | null}
 */
export function backgroundAction(card, ctx) {
  const run = ctx.background;
  if (typeof run !== 'function' || typeof card.id !== 'string' || card.id === '') return null;
  if (card.running !== true || card.result || card.pendingRequestId) return null;
  const input = card.input && typeof card.input === 'object' ? /** @type {Record<string, unknown>} */ (card.input) : {};
  if (input.run_in_background === true) return null;
  const translate = ctx.t ?? defaultT;
  const toolUseId = card.id;
  const button = /** @type {HTMLButtonElement} */ (
    h(
      'button',
      {
        class: 'tool-action tool-background',
        attrs: { type: 'button', title: translate('tools.background.hint') },
        on: {
          click: async () => {
            button.disabled = true;
            try {
              await run(toolUseId);
            } finally {
              button.disabled = false;
            }
          },
        },
      },
      icon('layers'),
      h('span', { text: translate('tools.background.run') }),
    )
  );
  return button;
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
 *   body?: Node | ((toolbar: HTMLElement) => Node | null | undefined) | null,
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

/**
 * Inline image from base64 data, shown through a data: URL (allowed by the CSP). The thumbnail is a button: a click
 * opens the image full size in a dialog. Returns null for a media type, encoding or size that images.js does not allow.
 * @param {unknown} mediaType
 * @param {unknown} data
 * @param {string} alt
 * @param {Translate} [translate]
 * @returns {HTMLElement | null}
 */
export function imageNode(mediaType, data, alt, translate = defaultT) {
  return imageButton(imageSource(mediaType, data), alt, translate);
}

/**
 * The thumbnail button of an image that images.js accepted (see imageNode). Null for no image.
 * @param {{ src: string } | null} image
 * @param {string} alt
 * @param {Translate} [translate]
 * @returns {HTMLElement | null}
 */
export function imageButton(image, alt, translate = defaultT) {
  if (!image) return null;
  const openLabel = translate('tools.image.open');
  return h('button', {
    class: 'tool-image-button',
    attrs: { type: 'button', title: openLabel, 'aria-label': `${alt}. ${openLabel}` },
    on: { click: () => openImageDialog(image.src, alt, translate) },
  }, h('img', {
    class: 'tool-image',
    attrs: { src: image.src, alt, loading: 'lazy', decoding: 'async' },
  }));
}

/**
 * The image at full size, in a dialog that closes on Escape or a click outside it.
 * @param {string} src data: URL of an allowed image
 * @param {string} alt
 * @param {Translate} translate
 */
function openImageDialog(src, alt, translate) {
  openDialog({
    title: alt,
    body: h('img', { class: 'tool-image-full', attrs: { src, alt } }),
    size: 'lg',
    className: 'tool-image-dialog',
    actions: [{ label: translate('tools.image.close'), kind: 'secondary' }],
  });
}

/**
 * Images attached to a tool result (`result.images`, base64 with a media type), as inline images.
 * @param {{ images?: unknown } | null | undefined} result
 * @param {string} alt
 * @param {Translate} [translate]
 * @returns {HTMLElement[]}
 */
export function resultImages(result, alt, translate = defaultT) {
  const images = Array.isArray(result?.images) ? result.images : [];
  /** @type {HTMLElement[]} */
  const nodes = [];
  for (const image of images) {
    if (!image || typeof image !== 'object') continue;
    const { mediaType, data } = /** @type {{ mediaType?: unknown, data?: unknown }} */ (image);
    const node = imageNode(mediaType, data, alt, translate);
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
 * Rendering of a card body: function bodies are built on demand. The action toolbar is one row above the content: the
 * `actions`, then any controls the body adds to the toolbar it receives. A body that throws leaves a short note in
 * place of its content, so one unexpected result never breaks the timeline.
 * @param {HTMLDetailsElement} details
 * @param {HTMLElement} host
 * @param {Node | ((toolbar: HTMLElement) => Node | null | undefined) | null | undefined} body
 * @param {boolean} eager build now instead of on first open
 * @param {HTMLElement[]} actions
 * @param {Translate} translate
 */
function attachBody(details, host, body, eager, actions, translate) {
  let built = false;
  const build = () => {
    if (built) return;
    built = true;
    const toolbar = h('div', { class: 'tool-actions' }, actions);
    try {
      const node = typeof body === 'function' ? body(toolbar) : body;
      appendToolbar(host, toolbar);
      if (node instanceof Node) host.appendChild(node);
    } catch (error) {
      console.error('tool card body failed', error);
      appendToolbar(host, toolbar);
      host.appendChild(mutedNote(translate('tools.bodyFailed')));
    }
  };
  if (eager || typeof body !== 'function') build();
  details.addEventListener('toggle', () => {
    if (details.open) build();
  });
}

/**
 * Appends the action toolbar above the card content when it has any controls.
 * @param {HTMLElement} host
 * @param {HTMLElement} toolbar
 */
function appendToolbar(host, toolbar) {
  if (toolbar.childNodes.length > 0) host.appendChild(toolbar);
}

/**
 * The state glyph at the start of a row: a rotating arc while running (static under reduced motion), a dot with a ring
 * while it waits for the user, an exclamation dot on error. A finished row has no glyph. The state is also named for
 * assistive technology.
 * @param {ToolStatus | null} status
 * @param {Translate} translate
 * @returns {HTMLElement}
 */
function statusGlyph(status, translate) {
  if (!status || status === 'done') {
    return h('span', { class: 'tool-glyph', attrs: { 'aria-hidden': 'true' } });
  }
  const label = translate(`tools.status.${status}`);
  return h(
    'span',
    { class: ['tool-glyph', `is-${status}`], attrs: { role: 'img', 'aria-label': label, title: label } },
    status === 'running' ? h('span', { class: 'tool-arc', attrs: { 'aria-hidden': 'true' } }) : null,
  );
}
