/**
 * Timeline view: renders the model's entries into the scrolling conversation area with keyed, incremental DOM updates.
 * Everything inside the conversation area belongs here; the shell owns the header, sidebar, composer and dialogs.
 */
import { h, clear, icon } from '../dom.js';
import { createModel } from './model.js';
import { renderTool } from './tools/index.js';
import { summarizeTool } from './tools/summaries.js';
import { renderRequest } from './requests.js';
import { renderMarkdown } from '../markdown.js';
import { formatDuration, formatTokens, truncateMiddle } from './format.js';
import { getLocale } from '../i18n.js';

/** Window event that asks every timeline to reload one session's snapshot. `detail: { sessionId }`. */
export const TIMELINE_RELOAD_EVENT = 'caw:timeline-reload';
const STICK_THRESHOLD_PX = 120;
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const BASE64_PATTERN = /^[A-Za-z0-9+/=\s]+$/;
const NOTE_COLLAPSE_CHARS = 160;
const GENERIC_JSON_LIMIT = 20000;

/** @typedef {{ t: (key: string, vars?: Record<string, unknown>) => string, api: any, store: any, actions: any, container: HTMLElement }} Env */

/**
 * Creates the timeline for the conversation area.
 * @param {{ container: HTMLElement, api: any, store: any, t: (key: string, vars?: Record<string, unknown>) => string, actions: any }} options
 */
export function createTimeline({ container, api, store, t, actions }) {
  const env = { container, api, store, t, actions };
  const refs = buildShell(container, t);
  const state = {
    sessionId: /** @type {string|null} */ (null),
    model: createModel(),
    liveState: /** @type {string|null} */ (null),
    pendingList: /** @type {Array<Record<string, any>>} */ ([]),
    loading: false,
    loadError: /** @type {null | 'error' | 'notFound'} */ (null),
    hasMore: false,
    oldestIndex: 0,
    loadingOlder: false,
    queue: /** @type {Array<[string, any]>} */ ([]),
    loadToken: 0,
    controller: /** @type {AbortController|null} */ (null),
    frame: 0,
    forceStick: true,
    renderedVersion: -1,
    destroyed: false,
  };
  const listStore = new Map();
  /** The open or closed state the user chose per details element (tool, work group, thinking), kept across renders. */
  const openState = new Map();
  const onScroll = () => {
    if (isNearBottom(refs.scroller)) showJump(refs, false);
  };
  const onJump = () => {
    scrollToBottom(refs.scroller);
    showJump(refs, false);
  };
  refs.scroller.addEventListener('scroll', onScroll, { passive: true });
  refs.jump.addEventListener('click', onJump);
  const ui = {
    env,
    openState,
    cwd: () => currentCwd(env, state.sessionId),
    sessionId: () => state.sessionId,
    renderChildren: (entries) => renderPlainEntries(ui, entries),
  };

  const scheduleRender = () => {
    if (state.frame || state.destroyed) return;
    state.frame = requestAnimationFrame(() => {
      state.frame = 0;
      render();
    });
  };

  const render = () => {
    if (state.destroyed) return;
    const stick = state.forceStick || isNearBottom(refs.scroller);
    const entries = state.model.getEntries();
    const items = entries.map((entry) => ({ key: entry.key, version: entry.version ?? 0, value: entry }));
    reconcile(refs.list, items, listStore, (entry, previous) => buildEntry(ui, entry, previous));
    markLatestRequest(refs.list);
    renderSlots(refs, state, ui, entries.length);
    if (stick) {
      scrollToBottom(refs.scroller);
      showJump(refs, false);
    } else if (state.renderedVersion !== state.model.getVersion()) {
      showJump(refs, true);
    }
    state.renderedVersion = state.model.getVersion();
    state.forceStick = false;
  };

  /**
   * @param {string} sessionId
   * @returns {Promise<{seq: number}|null>}
   */
  const load = async (sessionId) => {
    const sameSession = state.sessionId === sessionId;
    const carried = sameSession ? state.model.getPendingUserMessages() : [];
    if (!sameSession) openState.clear();
    state.controller?.abort();
    const controller = new AbortController();
    state.controller = controller;
    const token = ++state.loadToken;
    state.sessionId = sessionId;
    state.model = createModel();
    state.liveState = null;
    state.pendingList = [];
    state.loading = true;
    state.loadError = null;
    state.queue = [];
    state.hasMore = false;
    state.renderedVersion = -1;
    listStore.clear();
    clear(refs.list);
    state.forceStick = true;
    render();
    const encoded = encodeURIComponent(sessionId);
    try {
      const [detail, page] = await Promise.all([
        api.get(`/api/sessions/${encoded}`, { signal: controller.signal }),
        api.get(`/api/sessions/${encoded}/messages?tail=200`, { signal: controller.signal }),
      ]);
      if (state.destroyed || token !== state.loadToken) return null;
      state.model.loadTranscript(Array.isArray(page?.messages) ? page.messages : []);
      state.hasMore = Boolean(page?.hasMore);
      state.oldestIndex = Number.isFinite(page?.start) ? page.start : 0;
      for (const event of Array.isArray(detail?.liveEvents) ? detail.liveEvents : []) {
        state.model.applyLiveEvent(event?.msg);
      }
      state.pendingList = Array.isArray(detail?.pending) ? detail.pending : [];
      state.model.setPending(state.pendingList);
      state.liveState = detail?.live ? detail.live.state : 'closed';
      state.model.setSessionState(state.liveState);
      for (const entry of carried) restoreOptimistic(state.model, entry);
      state.loading = false;
      state.forceStick = true;
      const queued = state.queue;
      state.queue = [];
      for (const [type, data] of queued) applyEvent(type, data);
      render();
      return { seq: Number.isFinite(detail?.seq) ? detail.seq : 0 };
    } catch (err) {
      if (state.destroyed || token !== state.loadToken || err?.name === 'AbortError') return null;
      state.loading = false;
      state.loadError = err?.status === 404 ? 'notFound' : 'error';
      state.queue = [];
      render();
      return null;
    } finally {
      if (state.controller === controller) state.controller = null;
    }
  };

  /** @param {string} type @param {any} data */
  const applyEvent = (type, data) => {
    if (state.destroyed || !data) return;
    const eventSession = typeof data.sessionId === 'string' ? data.sessionId
      : (data.live && typeof data.live.sessionId === 'string' ? data.live.sessionId : null);
    if (state.loading && (type === 'sdk' || type === 'request' || type === 'request_resolved')) {
      state.queue.push([type, data]);
      return;
    }
    switch (type) {
      case 'sdk': {
        if (eventSession !== state.sessionId || !data.msg) return;
        state.model.applyLiveEvent(data.msg);
        break;
      }
      case 'request': {
        const request = data.request;
        if (!request || request.sessionId !== state.sessionId) return;
        state.pendingList = state.pendingList.filter((item) => item.id !== request.id).concat([request]);
        state.model.setPending(state.pendingList);
        break;
      }
      case 'request_resolved': {
        if (data.sessionId !== state.sessionId) return;
        state.pendingList = state.pendingList.filter((item) => item.id !== data.requestId);
        state.model.setPending(state.pendingList);
        state.model.resolvePending(data.requestId);
        break;
      }
      case 'message_accepted': {
        if (eventSession !== null && eventSession !== state.sessionId) return;
        state.model.markAccepted(String(data.clientMessageId ?? ''));
        break;
      }
      case 'message_failed': {
        if (eventSession !== null && eventSession !== state.sessionId) return;
        state.model.markFailed(String(data.clientMessageId ?? ''), data.error);
        break;
      }
      case 'session_state': {
        const sid = eventSession ?? state.sessionId;
        if (sid !== state.sessionId) return;
        state.liveState = data.live ? data.live.state : 'closed';
        state.model.setSessionState(state.liveState);
        break;
      }
      case 'resync': {
        if (state.sessionId) load(state.sessionId);
        return;
      }
      default:
        return;
    }
    scheduleRender();
  };

  /** @param {{clientMessageId: string, text: string, attachments?: unknown}} message */
  const addOptimisticUserMessage = ({ clientMessageId, text, attachments }) => {
    if (state.destroyed) return;
    state.model.addOptimistic({ clientMessageId, text, attachments });
    state.forceStick = true;
    scheduleRender();
  };

  /** Loads the page of transcript messages before the oldest loaded one, keeping the scroll position. */
  const loadOlder = async () => {
    if (!state.sessionId || !state.hasMore || state.loadingOlder || state.destroyed) return;
    state.loadingOlder = true;
    const sessionId = state.sessionId;
    const token = state.loadToken;
    const previousHeight = refs.scroller.scrollHeight;
    const previousTop = refs.scroller.scrollTop;
    render();
    try {
      const page = await api.get(`/api/sessions/${encodeURIComponent(sessionId)}/messages?before=${state.oldestIndex}&limit=200`);
      if (state.destroyed || token !== state.loadToken) return;
      state.model.prependTranscript(Array.isArray(page?.messages) ? page.messages : []);
      state.oldestIndex = Number.isFinite(page?.start) ? page.start : state.oldestIndex;
      state.hasMore = Boolean(page?.hasMore);
      state.forceStick = false;
      render();
      refs.scroller.scrollTop = previousTop + (refs.scroller.scrollHeight - previousHeight);
    } catch (err) {
      if (!state.destroyed && err?.name !== 'AbortError') actions.toast(t('cards.error.loadEarlier'), 'error');
    } finally {
      state.loadingOlder = false;
      if (!state.destroyed) render();
    }
  };

  ui.retry = () => {
    if (state.sessionId) load(state.sessionId);
  };
  ui.loadOlder = () => loadOlder();
  ui.discardOptimistic = (clientMessageId) => {
    state.model.discardOptimistic(clientMessageId);
    scheduleRender();
  };
  const onReload = (/** @type {any} */ event) => {
    const sessionId = event?.detail?.sessionId;
    if (typeof sessionId === 'string' && sessionId === state.sessionId) load(sessionId);
  };
  window.addEventListener(TIMELINE_RELOAD_EVENT, onReload);

  const destroy = () => {
    state.destroyed = true;
    state.controller?.abort();
    if (state.frame) cancelAnimationFrame(state.frame);
    refs.scroller.removeEventListener('scroll', onScroll);
    refs.jump.removeEventListener('click', onJump);
    window.removeEventListener(TIMELINE_RELOAD_EVENT, onReload);
    clear(container);
  };

  return {
    load,
    applyEvent,
    addOptimisticUserMessage,
    loadOlder,
    destroy,
    /** @returns {Array<{uuid: string, text: string, index: number}>} sent prompts available as rewind/fork targets */
    getUserMessages() {
      return state.model.getUserMessages();
    },
  };
}

// -------------------------------------------------------------------------------------------------------------------
// Shell of the timeline area

/**
 * @param {HTMLElement} container
 * @param {(key: string) => string} t
 */
function buildShell(container, t) {
  clear(container);
  const list = h('div', { class: 'tl-list' });
  const head = h('div', { class: 'tl-head' });
  const tail = h('div', { class: 'tl-tail' });
  const column = h('div', { class: 'tl-col' }, head, list, tail);
  const scroller = h('div', { class: 'tl-scroll', attrs: { role: 'log', 'aria-relevant': 'additions' } }, column);
  const jump = h('button', {
    class: 'tl-jump',
    attrs: { type: 'button', hidden: true },
    text: t('cards.jumpLatest'),
  });
  const root = h('div', { class: 'tl-root' }, scroller, jump);
  container.append(root);
  return { root, scroller, column, list, head, tail, jump };
}

/** @param {{root: HTMLElement, jump: HTMLElement}} refs @param {boolean} visible */
function showJump(refs, visible) {
  refs.jump.hidden = !visible;
}

/** @param {HTMLElement} scroller */
function isNearBottom(scroller) {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < STICK_THRESHOLD_PX;
}

/** @param {HTMLElement} scroller */
function scrollToBottom(scroller) {
  scroller.scrollTop = scroller.scrollHeight;
}

/**
 * Head (load earlier), tail (running indicator, skeleton, empty or error state).
 * @param {ReturnType<typeof buildShell>} refs
 * @param {any} state
 * @param {any} ui
 * @param {number} entryCount
 */
function renderSlots(refs, state, ui, entryCount) {
  const { t } = ui.env;
  clear(refs.head);
  clear(refs.tail);
  if (state.hasMore && !state.loadError) {
    refs.head.append(h('button', {
      class: 'tl-load-earlier',
      attrs: { type: 'button', disabled: state.loadingOlder ? true : null, 'aria-busy': state.loadingOlder ? 'true' : null },
      text: state.loadingOlder ? t('cards.loadingEarlier') : t('cards.loadEarlier'),
      on: { click: () => ui.loadOlder?.() },
    }));
  }
  refs.scroller.setAttribute('aria-busy', state.loading ? 'true' : 'false');
  if (state.loadError === 'notFound') {
    refs.tail.append(stateBlock(t('cards.error.notFound'), null, 'info'));
    return;
  }
  if (state.loadError === 'error') {
    refs.tail.append(stateBlock(t('cards.error.load'), {
      label: t('cards.error.retry'),
      onClick: () => ui.retry?.(),
    }, 'alert'));
    return;
  }
  if (state.loading && entryCount === 0) {
    refs.tail.append(h('div', { class: 'tl-skeleton', attrs: { 'aria-hidden': 'true' } },
      h('div', { class: 'skel skel-short' }), h('div', { class: 'skel skel-long' }), h('div', { class: 'skel skel-mid' })));
    return;
  }
  if (!state.loading && entryCount === 0 && state.sessionId) {
    refs.tail.append(emptyState(t));
    return;
  }
  const run = state.model.getRunState();
  if (run.running && !state.loading) {
    const label = run.status === 'compacting' ? t('cards.running.compacting') : t('cards.running.working');
    refs.tail.append(h('div', { class: 'tl-running', attrs: { role: 'status' } },
      h('span', { class: 'tl-running-dot', attrs: { 'aria-hidden': 'true' } }),
      h('span', { class: 'shimmer', text: label })));
  }
}

/**
 * @param {string} text
 * @param {{label: string, onClick: () => void}|null} action
 * @param {'info'|'alert'} role
 */
function stateBlock(text, action, role) {
  return h('div', { class: 'tl-state', attrs: { role: role === 'alert' ? 'alert' : 'status' } },
    icon(role === 'alert' ? 'alert' : 'info'),
    h('p', { class: 'tl-state-text', text }),
    action ? h('button', { class: 'btn-ghost tl-state-action', attrs: { type: 'button' }, text: action.label, on: { click: action.onClick } }) : null);
}

/** @param {(key: string) => string} t */
function emptyState(t) {
  return h('div', { class: 'tl-empty' },
    h('div', { class: 'tl-empty-icon' }, icon('spark')),
    h('h2', { class: 'tl-empty-title', text: t('cards.empty.title') }),
    h('p', { class: 'tl-empty-lead', text: t('cards.empty.lead') }),
    h('ul', { class: 'tl-tips' },
      h('li', { text: t('cards.empty.tipSlash') }),
      h('li', { text: t('cards.empty.tipAt') }),
      h('li', { text: t('cards.empty.tipAttach') }),
      h('li', { text: t('cards.empty.tipMode') })));
}

// -------------------------------------------------------------------------------------------------------------------
// Keyed reconciliation

/**
 * Brings `parent`'s children in line with `items`. Items whose version did not change keep their element; `build`
 * receives the previous element so containers can patch themselves in place.
 * @param {HTMLElement} parent
 * @param {Array<{key: string, version: number, value: any}>} items
 * @param {Map<string, {version: number, el: HTMLElement}>} store
 * @param {(value: any, previous: HTMLElement|null) => HTMLElement} build
 */
function reconcile(parent, items, store, build) {
  /** @type {Map<string, {version: number, el: HTMLElement}>} */
  const next = new Map();
  /** @type {HTMLElement[]} */
  const nodes = [];
  for (const item of items) {
    const previous = store.get(item.key);
    let node;
    if (previous && previous.version === item.version) {
      node = previous.el;
    } else {
      node = build(item.value, previous ? previous.el : null);
      if (previous && previous.el !== node && previous.el.parentNode === parent) previous.el.remove();
    }
    next.set(item.key, { version: item.version, el: node });
    nodes.push(node);
  }
  for (const [key, previous] of store) {
    if (!next.has(key) && previous.el.parentNode === parent) previous.el.remove();
  }
  store.clear();
  for (const [key, value] of next) store.set(key, value);
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    const anchor = parent.childNodes[index] ?? null;
    if (anchor !== node) parent.insertBefore(node, anchor);
  }
}

/** Marks the newest request card, which sticks above the composer on phones. @param {HTMLElement} list */
function markLatestRequest(list) {
  const slots = list.querySelectorAll(':scope > .request-slot');
  slots.forEach((slot, index) => slot.classList.toggle('is-latest', index === slots.length - 1));
}

/** @param {any} image @returns {boolean} true for a base64 image of a type the browser shows as an image */
function isRenderableImage(image) {
  return Boolean(image) && IMAGE_MEDIA_TYPES.has(image.mediaType)
    && typeof image.data === 'string' && BASE64_PATTERN.test(image.data);
}

/** Per-element stores for nested keyed children, kept in a WeakMap so they go away with the element. */
const subStores = new WeakMap();

/**
 * @param {HTMLElement} el
 * @param {string} name
 * @returns {Map<string, {version: number, el: HTMLElement}>}
 */
function subStore(el, name) {
  let stores = subStores.get(el);
  if (!stores) {
    stores = new Map();
    subStores.set(el, stores);
  }
  let store = stores.get(name);
  if (!store) {
    store = new Map();
    stores.set(name, store);
  }
  return store;
}

/**
 * Gives a details element the open state the user chose for `key`, or `defaultOpen` while the user has not touched
 * it. A toggle is recorded only when it differs from the default, so a re-rendered element keeps what the user chose.
 * @param {HTMLDetailsElement} details
 * @param {Map<string, boolean>} store
 * @param {string} key
 * @param {boolean} defaultOpen
 */
function syncOpen(details, store, key, defaultOpen) {
  details.__openKey = key;
  details.__openDefault = defaultOpen;
  const wanted = store.has(key) ? store.get(key) === true : defaultOpen;
  if (details.open !== wanted) details.open = wanted;
  if (details.__openWired) return;
  details.__openWired = true;
  details.addEventListener('toggle', () => {
    if (details.open === details.__openDefault) store.delete(details.__openKey);
    else store.set(details.__openKey, details.open);
  });
}

/**
 * @param {(key: string, vars?: Record<string, unknown>) => string} t
 * @param {number} count
 * @returns {string} "1 turn" or "N turns", in the plural form of the active locale
 */
function turnCount(t, count) {
  let form = count === 1 ? 'one' : 'other';
  try {
    form = new Intl.PluralRules(getLocale()).select(count);
  } catch {
    // Keep the English-style split when the locale tag is not usable.
  }
  return t(form === 'one' ? 'cards.result.turns.one' : 'cards.result.turns.other', { count });
}

// -------------------------------------------------------------------------------------------------------------------
// Entry rendering

/**
 * @param {any} ui
 * @param {Record<string, any>} entry
 * @param {HTMLElement|null} previous
 * @returns {HTMLElement}
 */
function buildEntry(ui, entry, previous) {
  switch (entry.kind) {
    case 'user': return userEl(ui, entry);
    case 'assistant': return assistantEl(ui, entry, previous);
    case 'work': return workEl(ui, entry, previous);
    case 'notice': return noticeEl(ui, entry);
    case 'divider': return dividerEl(ui, entry);
    case 'command-output': return commandEl(ui, entry);
    case 'result': return resultEl(ui, entry);
    case 'request': return requestEl(ui, entry);
    default: return genericEl(entry.label ?? entry.kind, entry.raw, ui);
  }
}

/** Renders children (subagent cards) without keyed reuse; they are small and rebuilt with their card. */
function renderPlainEntries(ui, entries) {
  const wrap = h('div', { class: 'sub-entries' });
  for (const entry of Array.isArray(entries) ? entries : []) {
    wrap.append(buildEntry(ui, entry, null));
  }
  return wrap;
}

/** @param {any} ui @param {Record<string, any>} entry */
function userEl(ui, entry) {
  const { t, actions } = ui.env;
  const status = typeof entry.status === 'string' ? entry.status : 'sent';
  const article = h('article', {
    class: ['msg', 'msg-user', status !== 'sent' && `is-${status}`],
    dataset: { kind: 'user', status },
    attrs: { 'aria-label': t('cards.you') },
  });
  const bubble = h('div', { class: 'msg-bubble' });
  if (entry.text) bubble.append(h('div', { class: 'msg-text', text: entry.text }));
  const images = Array.isArray(entry.images) ? entry.images.filter(isRenderableImage) : [];
  if (images.length > 0) {
    bubble.append(h('div', { class: 'msg-images' }, images.map((image) => h('img', {
      class: 'msg-image',
      attrs: { src: `data:${image.mediaType};base64,${image.data}`, alt: t('cards.image'), loading: 'lazy' },
    }))));
  }
  if (Array.isArray(entry.attachments) && entry.attachments.length > 0) {
    bubble.append(h('div', { class: 'msg-files' }, entry.attachments.map((file) => h('span', {
      class: 'file-chip',
      attrs: { title: file.path },
    }, icon(file.kind === 'image' ? 'image' : 'file'), h('span', { text: truncateMiddle(file.name, 40) })))));
  }
  article.append(bubble);

  if (status === 'sending' || status === 'queued') {
    article.append(h('div', { class: 'msg-status', attrs: { role: 'status' } },
      h('span', { text: status === 'queued' ? t('cards.user.queued') : t('cards.user.sending') })));
  }
  if (status === 'failed') {
    article.append(h('div', { class: 'msg-failed', attrs: { role: 'alert' } },
      icon('alert'),
      h('span', { class: 'msg-failed-text', text: t('cards.user.failed', { error: entry.error ?? '' }) }),
      h('button', {
        class: 'btn-ghost',
        attrs: { type: 'button' },
        text: t('cards.user.retry'),
        on: {
          click: () => {
            ui.discardOptimistic(entry.clientMessageId);
            actions.sendMessage({
              text: entry.text,
              attachments: (entry.attachments ?? []).map((file) => ({ path: file.path, name: file.name, kind: file.kind })),
            });
          },
        },
      }),
      h('button', {
        class: 'btn-ghost',
        attrs: { type: 'button' },
        text: t('cards.user.discard'),
        on: { click: () => ui.discardOptimistic?.(entry.clientMessageId) },
      })));
  }

  if (entry.uuid && status === 'sent') {
    article.append(h('div', { class: 'msg-actions', attrs: { role: 'toolbar', 'aria-label': t('cards.actions') } },
      actionButton(t('cards.action.copy'), 'copy', () => copyText(ui, entry.text)),
      actionButton(t('cards.action.rewind'), 'rewind', () => actions.openRewind(entry.uuid), t('cards.action.rewindTitle')),
      actionButton(t('cards.action.fork'), 'fork', () => actions.openFork(entry.uuid), t('cards.action.forkTitle'))));
    article.addEventListener('click', (event) => {
      const target = event.target;
      if (target instanceof Element && target.closest('button, a, img, .file-chip')) return;
      article.classList.toggle('is-actions');
    });
  }
  return article;
}

/**
 * @param {string} label
 * @param {string} iconName
 * @param {() => void} onClick
 * @param {string} [title]
 */
function actionButton(label, iconName, onClick, title) {
  return h('button', {
    class: 'msg-action',
    attrs: { type: 'button', 'aria-label': title ?? label, title: title ?? label },
    on: { click: onClick },
  }, icon(iconName), h('span', { text: label }));
}

/**
 * @param {any} ui
 * @param {string} text
 */
async function copyText(ui, text) {
  const { t, actions } = ui.env;
  try {
    await navigator.clipboard.writeText(text);
    actions.toast(t('cards.copied'), 'info');
  } catch {
    actions.toast(t('cards.copyFailed'), 'error');
  }
}

/** @param {any} ui @param {Record<string, any>} entry @param {HTMLElement|null} previous */
function assistantEl(ui, entry, previous) {
  const { t } = ui.env;
  const article = previous && previous.dataset.kind === 'assistant'
    ? previous
    : h('article', { class: 'msg msg-assistant', dataset: { kind: 'assistant' } });
  article.classList.toggle('is-streaming', Boolean(entry.streaming));
  article.classList.toggle('is-aborted', Boolean(entry.aborted));
  let body = article.querySelector(':scope > .msg-body');
  if (!body) {
    body = h('div', { class: 'msg-body' });
    article.append(body);
  }
  const blocks = Array.isArray(entry.blocks) ? entry.blocks : [];
  reconcile(body, blocks.map((block) => ({ key: block.key, version: block.version ?? 0, value: block })),
    subStore(article, 'blocks'), (block) => blockEl(ui, block));
  let notes = article.querySelector(':scope > .msg-notes');
  if (!notes) {
    notes = h('div', { class: 'msg-notes' });
    article.append(notes);
  }
  clear(notes);
  if (entry.error) {
    notes.append(h('div', { class: 'msg-note is-error', attrs: { role: 'alert' } }, icon('alert'),
      h('span', { text: t('cards.notice.assistantError', { error: String(entry.error) }) })));
  }
  if (entry.aborted) {
    notes.append(h('div', { class: 'msg-note is-muted' }, icon('x'), h('span', { text: t('cards.interrupted') })));
  }
  const text = blocks.filter((block) => block.kind === 'text').map((block) => block.text).join('\n\n');
  let actions = article.querySelector(':scope > .msg-actions');
  if (text && !entry.streaming) {
    if (!actions) {
      actions = h('div', { class: 'msg-actions', attrs: { role: 'toolbar', 'aria-label': t('cards.actions') } });
      article.append(actions);
    }
    clear(actions);
    actions.append(actionButton(t('cards.action.copy'), 'copy', () => copyText(ui, text)));
  } else if (actions) {
    actions.remove();
  }
  return article;
}

/** @param {any} ui @param {Record<string, any>} block */
function blockEl(ui, block) {
  const { t } = ui.env;
  switch (block.kind) {
    case 'text':
      return renderMarkdown(block.text);
    case 'thinking': {
      const body = block.redacted ? t('cards.thinking.redacted') : block.text;
      const details = h('details', { class: ['thinking', block.streaming && 'is-streaming'], dataset: { kind: 'thinking' } },
        h('summary', { class: 'thinking-summary' }, icon('brain'),
          h('span', { class: block.streaming ? 'shimmer' : null, text: t('cards.thinking') })),
        h('div', { class: 'thinking-body', text: body }));
      syncOpen(details, ui.openState, `thinking:${block.key}`, false);
      return details;
    }
    case 'tool-draft':
      return h('div', { class: 'draft-tool', dataset: { kind: 'tool-draft' } },
        h('div', { class: 'draft-tool-head' }, icon('tool'),
          h('span', { class: 'draft-tool-name', text: block.name }), h('span', { class: 'shimmer', text: t('cards.draft.writing') })),
        h('pre', { class: 'draft-tool-body', text: truncateMiddle(block.partial, 2000) }));
    default:
      return genericEl(block.label ?? 'block', block.raw, ui);
  }
}

/** @param {any} ui @param {Record<string, any>} entry @param {HTMLElement|null} previous */
function workEl(ui, entry, previous) {
  const { t } = ui.env;
  const details = previous && previous.dataset.kind === 'work'
    ? previous
    : h('details', { class: 'work', dataset: { kind: 'work' } });
  details.dataset.key = entry.key;
  details.dataset.state = entry.running ? 'running' : 'done';
  details.classList.toggle('is-running', Boolean(entry.running));
  syncOpen(details, ui.openState, entry.key, Boolean(entry.open));

  const tools = entry.items.filter((item) => item.kind === 'tool');
  const runningTool = tools.find((item) => item.running);
  const label = entry.label || (tools.length === 1 ? t('cards.work.step') : t('cards.work.steps', { count: tools.length }));
  const summary = h('summary', { class: 'work-summary' },
    icon('layers'),
    h('span', { class: 'work-label', text: label }),
    entry.label && tools.length > 0 ? h('span', { class: 'work-count', text: String(tools.length) }) : null,
    entry.running ? h('span', { class: 'work-running', attrs: { role: 'status' } },
      h('span', { class: 'tl-running-dot', attrs: { 'aria-hidden': 'true' } }),
      h('span', { class: 'shimmer', text: runningToolText(ui, runningTool) })) : null);
  let body = details.querySelector(':scope > .work-body');
  const first = details.firstElementChild;
  if (first && first.tagName === 'SUMMARY') first.replaceWith(summary);
  else details.prepend(summary);
  if (!body) {
    body = h('div', { class: 'work-body' });
    details.append(body);
  }
  reconcile(body, entry.items.map((item) => ({ key: item.key, version: item.version ?? 0, value: item })),
    subStore(details, 'items'), (item) => itemEl(ui, item));
  return details;
}

/** @param {any} ui @param {Record<string, any>|undefined} tool */
function runningToolText(ui, tool) {
  const { t } = ui.env;
  if (!tool) return t('cards.work.running', { summary: '' });
  let summary = '';
  try {
    summary = summarizeTool(tool.name, tool.input, tool.result, t, currentCwd(ui.env, ui.sessionId()));
  } catch {
    summary = tool.name;
  }
  const elapsed = typeof tool.elapsedSeconds === 'number' && tool.elapsedSeconds >= 1
    ? ` · ${formatDuration(tool.elapsedSeconds * 1000)}` : '';
  return `${summary}${elapsed}`.trim();
}

/** @param {any} ui @param {Record<string, any>} item */
function itemEl(ui, item) {
  if (item.kind === 'row') return rowEl(ui, item);
  const wrap = h('div', { class: 'work-item', dataset: { tool: item.name, key: item.key } });
  const context = {
    t: ui.env.t,
    renderMarkdown,
    sessionId: ui.sessionId(),
    cwd: ui.cwd(),
    renderChildren: ui.renderChildren,
    open: Boolean(item.running || item.pendingRequestId),
  };
  try {
    const card = renderTool(item, context);
    wrap.append(card);
    // The card's own default (open while it runs or waits for a decision) applies until the user toggles it.
    if (card && card.tagName === 'DETAILS') syncOpen(card, ui.openState, `tool:${item.id}`, card.open);
  } catch {
    wrap.append(genericEl(item.name, item, ui));
  }
  return wrap;
}

/** @param {any} ui @param {Record<string, any>} row */
function rowEl(ui, row) {
  const { t } = ui.env;
  if (row.rowKind === 'denied') {
    return h('div', { class: 'work-row is-denied', dataset: { kind: 'denied' }, attrs: { role: 'status' } },
      icon('shield'),
      h('div', { class: 'work-row-body' },
        h('div', { class: 'work-row-title', text: t('cards.denied.title', { tool: row.toolName || '?' }) }),
        row.message ? h('div', { class: 'work-row-text', text: row.message }) : null,
        row.reason ? h('div', { class: 'work-row-hint', text: row.reason }) : null));
  }
  if (row.rowKind === 'hook') {
    const status = String(row.status ?? 'running');
    const stateText = status === 'running' ? t('cards.hook.running')
      : status === 'success' ? t('cards.hook.success')
        : status === 'cancelled' ? t('cards.hook.cancelled') : t('cards.hook.error');
    const failed = status === 'error';
    return h('div', { class: ['work-row', 'is-hook', failed && 'is-error'], dataset: { kind: 'hook', status } },
      icon(failed ? 'alert' : 'plug'),
      h('div', { class: 'work-row-body' },
        h('div', { class: 'work-row-title', text: t('cards.hook.title', { name: row.hookName, event: row.hookEvent }) }),
        h('div', { class: 'work-row-hint', text: stateText }),
        row.output ? h('pre', { class: 'work-row-output', text: row.output }) : null));
  }
  if (row.rowKind === 'task') {
    const status = String(row.status ?? 'running');
    const done = status === 'completed' || status === 'failed' || status === 'stopped' || status === 'killed';
    const failed = status === 'failed';
    const stateText = status === 'running' || status === 'pending' ? t('cards.task.running')
      : status === 'completed' ? t('cards.task.completed')
        : status === 'failed' ? t('cards.task.failed') : t('cards.task.stopped');
    const details = [];
    if (typeof row.toolUses === 'number') details.push(t('cards.task.tools', { count: row.toolUses }));
    if (typeof row.durationMs === 'number') details.push(formatDuration(row.durationMs));
    return h('div', { class: ['work-row', 'is-task', failed && 'is-error'], dataset: { kind: 'task', status }, attrs: { role: 'status' } },
      icon(done ? (failed ? 'alert' : 'check') : 'clock'),
      h('div', { class: 'work-row-body' },
        h('div', { class: 'work-row-title', text: row.description || row.summary || t('cards.task.untitled') }),
        h('div', { class: 'work-row-hint', text: [stateText, ...details].join(' · ') }),
        row.summary && row.description ? h('div', { class: 'work-row-text', text: row.summary }) : null,
        row.error ? h('div', { class: 'work-row-text is-error', text: row.error }) : null));
  }
  return genericEl(row.rowKind ?? 'row', row, ui);
}

/** @param {any} ui @param {Record<string, any>} entry */
function noticeEl(ui, entry) {
  const { t } = ui.env;
  const level = entry.level || 'info';
  const text = noticeText(ui, entry);
  const iconName = level === 'error' ? 'alert' : level === 'warning' ? 'alert' : level === 'muted' ? 'info' : 'info';
  const body = entry.code === 'user-meta' && text.length > NOTE_COLLAPSE_CHARS
    ? h('details', { class: 'notice-collapse' },
      h('summary', { text: t('cards.notice.note') }),
      h('div', { class: 'notice-text', text }))
    : h('div', { class: 'notice-text', text });
  return h('div', {
    class: ['notice', `is-${level}`],
    dataset: { kind: 'notice', code: entry.code },
    attrs: { role: level === 'error' ? 'alert' : 'status' },
  }, icon(iconName), body);
}

/** @param {any} ui @param {Record<string, any>} entry */
function noticeText(ui, entry) {
  const { t } = ui.env;
  const vars = entry.vars ?? {};
  switch (entry.code) {
    case 'api-retry': {
      const seconds = Number.isFinite(vars.delayMs) ? Math.max(1, Math.round(vars.delayMs / 1000)) : 0;
      const base = t('cards.notice.apiRetry', { attempt: vars.attempt ?? '?', max: vars.max ?? '?', seconds });
      return vars.error ? `${base} · ${String(vars.error)}` : base;
    }
    case 'memory-recall':
      return t('cards.notice.memory', { count: vars.count ?? 0 });
    case 'assistant-error':
      return t('cards.notice.assistantError', { error: String(vars.error ?? '') });
    case 'compact-failed':
      return entry.text ? `${t('cards.notice.compactFailed')}: ${entry.text}` : t('cards.notice.compactFailed');
    case 'interrupted': return t('cards.notice.interrupted');
    case 'interrupted-tool': return t('cards.notice.interruptedTool');
    default:
      return entry.text || '';
  }
}

/** @param {any} ui @param {Record<string, any>} entry */
function dividerEl(ui, entry) {
  const { t } = ui.env;
  let label;
  if (entry.variant === 'clear') label = t('cards.divider.cleared');
  else if (Number.isFinite(entry.preTokens)) label = t('cards.divider.compacted', { tokens: formatTokens(entry.preTokens) });
  else label = t('cards.divider.compactedPlain');
  return h('div', { class: ['divider', `is-${entry.variant}`], dataset: { kind: 'divider' }, attrs: { role: 'separator', 'aria-label': label } },
    h('span', { class: 'divider-label', text: label }));
}

/** @param {any} ui @param {Record<string, any>} entry */
function commandEl(ui, entry) {
  const { t } = ui.env;
  return h('div', { class: 'cmd-output', dataset: { kind: 'command-output' } },
    h('div', { class: 'cmd-head', text: t('cards.commandOutput') }),
    h('pre', { class: 'cmd-body', text: entry.text }));
}

/** @param {any} ui @param {Record<string, any>} entry */
function resultEl(ui, entry) {
  const { t } = ui.env;
  const variant = entry.interrupted ? 'interrupted' : entry.isError ? 'error' : 'done';
  let headline;
  if (variant === 'interrupted') headline = t('cards.result.interrupted');
  else if (variant === 'error') headline = t('cards.result.error', { reason: subtypeLabel(ui, entry.subtype) });
  else headline = t('cards.result.done');
  const facts = [headline];
  if (Number.isFinite(entry.durationMs)) facts.push(formatDuration(entry.durationMs));
  if (Number.isFinite(entry.numTurns) && entry.numTurns > 0) facts.push(turnCount(t, entry.numTurns));
  const denials = Array.isArray(entry.permissionDenials) ? entry.permissionDenials : [];
  const errors = Array.isArray(entry.errors) ? entry.errors : [];
  return h('div', { class: ['turn-result', `is-${variant}`], dataset: { kind: 'result' } },
    h('div', { class: 'turn-result-line' },
      icon(variant === 'error' ? 'alert' : variant === 'interrupted' ? 'x' : 'check'),
      h('span', { text: facts.join(' · ') })),
    errors.length > 0 ? h('ul', { class: 'turn-errors' }, errors.map((message) => h('li', { text: String(message) }))) : null,
    denials.length > 0 ? h('div', { class: 'turn-denials', text: t('cards.result.denied', {
      count: denials.length,
      tools: denials.map((denial) => denial.toolName).filter(Boolean).join(', '),
    }) }) : null);
}

/** @param {any} ui @param {string|null|undefined} subtype */
function subtypeLabel(ui, subtype) {
  const { t } = ui.env;
  switch (subtype) {
    case 'error_max_turns': return t('cards.result.maxTurns');
    case 'error_max_budget_usd': return t('cards.result.maxBudget');
    case 'error_max_structured_output_retries': return t('cards.result.structured');
    case 'error_during_execution': return t('cards.result.execution');
    default: return t('cards.result.unknown');
  }
}

/** @param {any} ui @param {Record<string, any>} entry */
function requestEl(ui, entry) {
  const request = entry.request;
  const slot = h('div', { class: 'request-slot', dataset: { kind: 'request', requestKind: request.kind } });
  slot.append(renderRequest(request, {
    api: ui.env.api,
    sessionId: request.sessionId ?? ui.sessionId(),
    t: ui.env.t,
    renderMarkdown,
    profile: ui.env.store.get()?.auth?.profile ?? null,
    toast: (message, level) => ui.env.actions.toast(message, level),
    cwd: ui.cwd(),
  }));
  return slot;
}

/** @param {string} label @param {unknown} raw @param {any} ui */
function genericEl(label, raw, ui) {
  const { t } = ui.env;
  let json;
  try {
    json = JSON.stringify(raw, null, 2) ?? String(raw);
  } catch {
    json = String(raw);
  }
  if (json.length > GENERIC_JSON_LIMIT) json = `${json.slice(0, GENERIC_JSON_LIMIT)}\n…`;
  return h('details', { class: 'generic', dataset: { kind: 'generic' } },
    h('summary', { class: 'generic-summary' },
      icon('cpu'),
      h('span', { class: 'generic-label', text: String(label) }),
      h('span', { class: 'generic-hint', text: t('cards.generic.hint') })),
    h('pre', { class: 'generic-body', text: json }));
}

/** @param {Env} env @param {string|null} sessionId */
function currentCwd(env, sessionId) {
  if (!sessionId) return null;
  try {
    const live = env.store.get()?.live?.[sessionId];
    return live && typeof live.cwd === 'string' ? live.cwd : null;
  } catch {
    return null;
  }
}

/**
 * Restores an optimistic message that was still pending before a reload of the same session.
 * @param {{ addOptimistic: Function, markAccepted: Function, markFailed: Function }} model
 * @param {Record<string, any>} entry
 */
function restoreOptimistic(model, entry) {
  model.addOptimistic({ clientMessageId: entry.clientMessageId, text: entry.text, attachments: entry.attachments });
  if (entry.accepted) model.markAccepted(entry.clientMessageId);
  if (entry.status === 'failed') model.markFailed(entry.clientMessageId, entry.error);
}
