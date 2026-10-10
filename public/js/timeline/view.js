/**
 * Timeline view: renders the model's entries into the scrolling conversation area with keyed, incremental DOM updates.
 * Everything inside the conversation area belongs here; the shell owns the header, sidebar, composer and dialogs.
 */
import { h, clear, icon } from '../dom.js';
import { errorText } from '../api.js';
import { createModel } from './model.js';
import { renderTool } from './tools/index.js';
import { describeActivity } from './tools/summaries.js';
import { renderRequest } from './requests.js';
import { renderMarkdown } from '../markdown.js';
import { formatDuration, formatTokens, truncateMiddle, pluralKey } from './format.js';
import { getLocale } from '../i18n.js';

/** Window event that asks every timeline to reload one session's snapshot. `detail: { sessionId }`. */
export const TIMELINE_RELOAD_EVENT = 'caw:timeline-reload';
const STICK_THRESHOLD_PX = 120;
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const BASE64_PATTERN = /^[A-Za-z0-9+/=\s]+$/;
const NOTE_COLLAPSE_CHARS = 160;
const GENERIC_JSON_LIMIT = 20000;
/** Event types that wait in the queue while the session's history loads, then replay in order. */
const QUEUED_WHILE_LOADING = new Set(['sdk', 'request', 'request_resolved', 'notice', 'message_cancelled']);

/**
 * @typedef {Object} Env
 * @property {(key: string, vars?: Record<string, unknown>) => string} t
 * @property {any} api
 * @property {any} store
 * @property {any} actions
 * @property {HTMLElement} container
 */

/**
 * Creates the timeline for the conversation area. `onTodos` and `onActivity` receive the composer's todo list and
 * running line; each is called only when its value changed (and once on the first render).
 * @param {{
 *   container: HTMLElement,
 *   api: any,
 *   store: any,
 *   t: (key: string, vars?: Record<string, unknown>) => string,
 *   actions: any,
 *   onTodos?: ((todos: Array<Record<string, any>>|null) => void)|null,
 *   onActivity?: ((activity: Record<string, any>|null) => void)|null,
 * }} options
 */
export function createTimeline({ container, api, store, t, actions, onTodos = null, onActivity = null }) {
  const env = { container, api, store, t, actions };
  const refs = buildShell(container, t);
  /** Names the running tool for the activity line, in the viewer's language and the session's folder. */
  const describeTool = (/** @type {Record<string, any>} */ tool) => describeActivity(
    tool.name, tool.input, t, currentCwd(env, state.sessionId));
  const newModel = () => createModel({ describeTool });
  const state = {
    sessionId: /** @type {string|null} */ (null),
    model: newModel(),
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
    /** whether the last render showed the diagnostic rows of unknown message types */
    runtimeShown: false,
    /** the last todos and activity sent to the composer, as JSON (undefined until the first render) */
    publishedTodos: /** @type {string|undefined} */ (undefined),
    publishedActivity: /** @type {string|undefined} */ (undefined),
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
  /**
   * The terminal's Ctrl+B for one foreground tool call: the command or subagent it started keeps running in the
   * background while the turn goes on. `backgrounded: false` means it had already finished; failures are toasts.
   * @param {string} toolUseId
   */
  const backgroundTool = async (toolUseId) => {
    const sessionId = state.sessionId;
    if (!sessionId) return;
    try {
      const result = await api.post(`/api/sessions/${encodeURIComponent(sessionId)}/background`, { toolUseId });
      if (result?.backgrounded !== true) actions.toast(t('cards.background.gone'), 'info');
    } catch (err) {
      actions.toast(errorText(err, t), 'error');
    }
  };
  const ui = {
    env,
    openState,
    cwd: () => currentCwd(env, state.sessionId),
    sessionId: () => state.sessionId,
    renderChildren: (entries) => renderPlainEntries(ui, entries),
    background: backgroundTool,
  };

  const scheduleRender = () => {
    if (state.frame || state.destroyed) return;
    state.frame = requestAnimationFrame(() => {
      state.frame = 0;
      render();
    });
  };

  // The runtime-events preference shows or hides the diagnostic rows. The store reports every change, and the timeline
  // re-renders only when its reading of the preference actually changed.
  const unsubscribePrefs = store && typeof store.subscribe === 'function'
    ? store.subscribe(() => {
      if (runtimeEventsShown(env) !== state.runtimeShown) scheduleRender();
    })
    : null;

  /** The newest request card sticks above the composer on phones; the jump pill sits above that card (--tl-dock). */
  /** @type {Element|null} */
  let dockSlot = null;
  /** @type {ResizeObserver|null} */
  const dockSize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => syncDock()) : null;
  const syncDock = () => {
    const slot = refs.list.querySelector(':scope > .request-slot.is-latest');
    if (slot !== dockSlot) {
      if (dockSlot) dockSize?.unobserve(dockSlot);
      dockSlot = slot;
      if (slot) dockSize?.observe(slot);
    }
    refs.root.style.setProperty('--tl-dock', `${slot ? slot.offsetHeight : 0}px`);
  };

  const render = () => {
    if (state.destroyed) return;
    const stick = state.forceStick || isNearBottom(refs.scroller);
    state.runtimeShown = runtimeEventsShown(env);
    const entries = state.model.getEntries().filter((entry) => state.runtimeShown || !isDiagnostic(entry));
    const items = entries.map((entry) => ({ key: entry.key, version: entry.version ?? 0, value: entry }));
    reconcile(refs.list, items, listStore, (entry, previous) => buildEntry(ui, entry, previous));
    markLatestRequest(refs.list);
    syncDock();
    renderSlots(refs, state, ui, entries.length);
    publishSummary();
    if (stick) {
      scrollToBottom(refs.scroller);
      showJump(refs, false);
    } else if (state.renderedVersion !== state.model.getVersion()) {
      showJump(refs, true);
    }
    state.renderedVersion = state.model.getVersion();
    state.forceStick = false;
  };

  /** Sends the composer the latest todos and the running line, each only when it changed since the last send. */
  const publishSummary = () => {
    const todos = state.model.getTodos();
    const todosKey = JSON.stringify(todos);
    if (todosKey !== state.publishedTodos) {
      state.publishedTodos = todosKey;
      if (onTodos) onTodos(todos);
    }
    const activity = activityOf(state.model, t);
    const activityKey = JSON.stringify(activity);
    if (activityKey !== state.publishedActivity) {
      state.publishedActivity = activityKey;
      if (onActivity) onActivity(activity);
    }
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
    state.model = newModel();
    // The composer was reset for the new session, so the first render sends its todos and activity again.
    state.publishedTodos = undefined;
    state.publishedActivity = undefined;
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
    if (state.loading && QUEUED_WHILE_LOADING.has(type)) {
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
        // The model evicts what a resolved dialog retracted before the pending list drops the request.
        state.model.resolvePending(data.requestId);
        state.pendingList = state.pendingList.filter((item) => item.id !== data.requestId);
        state.model.setPending(state.pendingList);
        break;
      }
      case 'message_cancelled': {
        if (eventSession !== null && eventSession !== state.sessionId) return;
        state.model.cancelQueued(String(data.clientMessageId ?? ''));
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
      case 'notice': {
        // An engine that cannot run shows inline in the session's timeline too, not only as the shell's toast.
        if (data.code !== 'ENGINE_UNAVAILABLE') return;
        if (eventSession !== null && eventSession !== state.sessionId) return;
        state.model.applyNotice({ code: 'ENGINE_UNAVAILABLE', level: 'error', text: '' });
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

  /**
   * The top-most entry the reader sees, with its key and its distance from the top of the viewport. A replay rebuilds
   * the elements, so the key is what still identifies the entry afterwards.
   * @returns {{key: string, offset: number}|null}
   */
  const anchorAt = () => {
    const viewTop = refs.scroller.getBoundingClientRect().top;
    for (const el of refs.list.children) {
      const rect = el.getBoundingClientRect();
      if (rect.bottom <= viewTop) continue;
      for (const [key, stored] of listStore) {
        if (stored.el === el) return { key, offset: rect.top - viewTop };
      }
      return null;
    }
    return null;
  };

  /**
   * Puts the anchor entry back where the reader had it after older entries were added above it. Without a usable anchor
   * the scroll moves by the height that was added.
   * @param {{key: string, offset: number}|null} anchor
   * @param {{previousTop: number, previousHeight: number}} before
   */
  const restoreAnchor = (anchor, before) => {
    const { scroller } = refs;
    const stored = anchor ? listStore.get(anchor.key) : undefined;
    if (anchor && stored && stored.el.isConnected) {
      const offset = stored.el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTop += offset - anchor.offset;
      return;
    }
    scroller.scrollTop = before.previousTop + (scroller.scrollHeight - before.previousHeight);
  };

  /** Loads the page of transcript messages before the oldest loaded one, keeping the scroll position. */
  const loadOlder = async () => {
    if (!state.sessionId || !state.hasMore || state.loadingOlder || state.destroyed) return;
    state.loadingOlder = true;
    const sessionId = state.sessionId;
    const token = state.loadToken;
    render();
    const previousHeight = refs.scroller.scrollHeight;
    const previousTop = refs.scroller.scrollTop;
    const anchor = anchorAt();
    // The browser's own scroll anchoring would adjust the position again after the prepend; the restore below does it.
    refs.scroller.style.overflowAnchor = 'none';
    try {
      const page = await api.get(
        `/api/sessions/${encodeURIComponent(sessionId)}/messages?before=${state.oldestIndex}&limit=200`,
      );
      if (state.destroyed || token !== state.loadToken) return;
      state.model.prependTranscript(Array.isArray(page?.messages) ? page.messages : []);
      state.oldestIndex = Number.isFinite(page?.start) ? page.start : state.oldestIndex;
      state.hasMore = Boolean(page?.hasMore);
      state.forceStick = false;
      render();
      restoreAnchor(anchor, { previousTop, previousHeight });
    } catch (err) {
      if (!state.destroyed && err?.name !== 'AbortError') actions.toast(t('cards.error.loadEarlier'), 'error');
    } finally {
      refs.scroller.style.overflowAnchor = '';
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
  /**
   * A queued message the runtime dropped leaves the timeline at once, as the message_cancelled event would remove it.
   */
  ui.dropQueued = (clientMessageId) => {
    state.model.cancelQueued(clientMessageId);
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
    dockSize?.disconnect();
    unsubscribePrefs?.();
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
      attrs: {
        type: 'button', disabled: state.loadingOlder ? true : null, 'aria-busy': state.loadingOlder ? 'true' : null,
      },
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
      h('div', { class: 'skel skel-short' }), h('div', { class: 'skel skel-long' }),
        h('div', { class: 'skel skel-mid' })));
    return;
  }
  if (!state.loading && entryCount === 0 && state.sessionId) {
    refs.tail.append(emptyState(t));
  }
  // A running turn shows its line above the composer (the composer's activity bar), not in the timeline.
}

/**
 * The running turn as the composer's activity line shows it. A compaction says so instead of naming the last tool.
 * @param {ReturnType<typeof createModel>} model
 * @param {(key: string) => string} t
 * @returns {Record<string, any>|null}
 */
function activityOf(model, t) {
  const activity = model.getActivity();
  if (!activity) return null;
  return model.getRunState().status === 'compacting' ? { ...activity, text: t('cards.running.compacting') } : activity;
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
    action
      ? h('button', { class: 'btn-ghost tl-state-action', attrs: { type: 'button' }, text: action.label,
        on: { click: action.onClick } })
      : null);
}

/** @param {(key: string) => string} t */
function emptyState(t) {
  return h('div', { class: 'tl-empty' },
    h('div', { class: 'tl-empty-icon' }, icon('spark')),
    h('h2', { class: 'tl-empty-title', text: t('cards.empty.title') }),
    h('p', { class: 'tl-empty-lead', text: t('cards.empty.lead') }));
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
  return t(pluralKey('cards.result.turns', count, getLocale()), { count });
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
    case 'withdrawn': return withdrawnEl(ui);
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

  if (status === 'sending') {
    article.append(h('div', { class: 'msg-status', attrs: { role: 'status' } },
      h('span', { text: t('cards.user.sending') })));
  }
  if (status === 'queued') {
    article.append(h('div', { class: 'msg-status is-queued', attrs: { role: 'status' } },
      h('span', { class: 'msg-status-label', text: t('cards.user.queued') }),
      h('button', {
        class: 'btn-ghost msg-cancel',
        attrs: { type: 'button' },
        text: t('cards.user.cancel'),
        on: { click: () => cancelQueuedMessage(ui, entry) },
      })));
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
            // The retry keeps the id of the failed message, so the gateway can tell a repeat from a new message.
            actions.sendMessage({
              text: entry.text,
              attachments: (entry.attachments ?? []).map((file) => ({
                path: file.path, name: file.name, kind: file.kind,
              })),
              clientMessageId: entry.clientMessageId,
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
      actionButton(t('cards.action.rewind'), 'rewind', () => actions.openRewind(entry.uuid),
        t('cards.action.rewindTitle')),
      actionButton(t('cards.action.fork'), 'fork', () => actions.openFork(entry.uuid), t('cards.action.forkTitle'))));
    article.addEventListener('click', tapToggleActions);
  }
  return article;
}

/**
 * A message's toolbar has no hover on touch screens, so a tap on the message shows it and a second tap hides it. Taps
 * on controls, links, images, files and code keep their own action. Pointer devices use hover and focus only.
 * @param {Event} event
 */
function tapToggleActions(event) {
  const article = event.currentTarget;
  if (!(article instanceof HTMLElement) || !article.querySelector(':scope > .msg-actions')) return;
  if (globalThis.matchMedia?.('(hover: none)').matches !== true) return;
  const target = event.target;
  if (target instanceof Element && target.closest('button, a, img, .file-chip, pre')) return;
  article.classList.toggle('is-actions');
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

/**
 * Asks the runtime to drop a message that waits behind a running turn. The bubble leaves when the runtime dropped it;
 * a message that already started stays, and the user is told so.
 * @param {any} ui
 * @param {Record<string, any>} entry
 */
async function cancelQueuedMessage(ui, entry) {
  const { t, actions } = ui.env;
  try {
    const dropped = await actions.cancelQueued(entry.clientMessageId);
    if (dropped === true) ui.dropQueued(entry.clientMessageId);
    else actions.toast(t('cards.user.cancelTooLate'), 'info');
  } catch (error) {
    actions.toast(errorText(error, t), 'error');
  }
}

/** @param {any} ui @param {Record<string, any>} entry @param {HTMLElement|null} previous */
function assistantEl(ui, entry, previous) {
  const { t } = ui.env;
  const article = previous && previous.dataset.kind === 'assistant'
    ? previous
    : h('article', { class: 'msg msg-assistant', dataset: { kind: 'assistant' }, on: { click: tapToggleActions } });
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
      // Without summaries (or when the model redacted the reasoning) there is no text to open: a plain label says so.
      if (!block.text) return thinkingLabel(ui, block);
      const details = h('details', {
        class: ['thinking', block.streaming && 'is-streaming'], dataset: { kind: 'thinking' },
      },
        h('summary', { class: 'thinking-summary' }, icon('brain'),
          h('span', { class: block.streaming ? 'shimmer' : null, text: t('cards.thinking') })),
        h('div', { class: 'thinking-body', text: block.text }));
      syncOpen(details, ui.openState, `thinking:${block.key}`, false);
      return details;
    }
    case 'tool-draft':
      return h('div', { class: 'draft-tool', dataset: { kind: 'tool-draft' } },
        h('div', { class: 'draft-tool-head' }, icon('tool'),
          h('span', { class: 'draft-tool-name', text: block.name }),
          h('span', { class: 'shimmer', text: t('cards.draft.writing') })),
        h('pre', { class: 'draft-tool-body', text: truncateMiddle(block.partial, 2000) }));
    default:
      return genericEl(block.label ?? 'block', block.raw, ui);
  }
}

/**
 * A run of progress rows with no tool step: the rows themselves, without a collapsible header.
 * @param {any} ui
 * @param {Record<string, any>} entry
 * @param {HTMLElement|null} previous
 */
function rowsEl(ui, entry, previous) {
  const box = previous && previous.tagName === 'DIV' && previous.dataset.kind === 'work'
    ? previous
    : h('div', { class: 'work-rows', dataset: { kind: 'work' } });
  box.dataset.key = entry.key;
  reconcile(box, entry.items.map((item) => ({ key: item.key, version: item.version ?? 0, value: item })),
    subStore(box, 'items'), (item) => itemEl(ui, item));
  return box;
}

/** @param {any} ui @param {Record<string, any>} entry @param {HTMLElement|null} previous */
function workEl(ui, entry, previous) {
  const { t } = ui.env;
  // Progress rows with no tool step (a hook, a task) show as rows: a group header would read "0 steps".
  if (!entry.items.some((item) => item.kind === 'tool')) return rowsEl(ui, entry, previous);
  const details = previous && previous.tagName === 'DETAILS' && previous.dataset.kind === 'work'
    ? previous
    : h('details', { class: 'work', dataset: { kind: 'work' } });
  details.dataset.key = entry.key;
  details.dataset.state = entry.running ? 'running' : 'done';
  details.classList.toggle('is-running', Boolean(entry.running));
  syncOpen(details, ui.openState, entry.key, Boolean(entry.open));

  const tools = entry.items.filter((item) => item.kind === 'tool');
  const runningTool = tools.find((item) => item.running);
  const label = entry.label ||
    (tools.length === 1 ? t('cards.work.step') : t('cards.work.steps', { count: tools.length }));
  const summary = h('summary', { class: 'work-summary' },
    icon('layers'),
    h('span', { class: 'work-label', text: label }),
    entry.label && tools.length > 0 ? h('span', { class: 'work-count', text: String(tools.length) }) : null,
    entry.running ? runningHeader(ui, runningTool) : null);
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

/**
 * The running state of a group header: the arc and what the running tool does, or the waiting dot while that tool waits
 * for the user (the request card above the composer carries the decision).
 * @param {any} ui
 * @param {Record<string, any>|undefined} tool
 */
function runningHeader(ui, tool) {
  const { t } = ui.env;
  const waiting = Boolean(tool && tool.pendingRequestId);
  const glyph = waiting
    ? h('span', { class: 'tool-glyph is-waiting', attrs: { 'aria-hidden': 'true' } })
    : h('span', { class: 'tool-glyph is-running', attrs: { 'aria-hidden': 'true' } }, h('span', { class: 'tool-arc' }));
  const text = waiting ? t('tools.status.waiting') : runningToolText(ui, tool);
  return h('span', { class: 'work-running', attrs: { role: 'status' } },
    glyph,
    h('span', { class: 'work-running-text', text }));
}

/**
 * What the running tool of a group does, in the present tense ("Editing src/app.js"), and its elapsed time.
 * @param {any} ui
 * @param {Record<string, any>|undefined} tool
 */
function runningToolText(ui, tool) {
  const { t } = ui.env;
  if (!tool) return t('cards.work.running', { summary: '' });
  let summary = '';
  try {
    summary = describeActivity(tool.name, tool.input, t, currentCwd(ui.env, ui.sessionId()));
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
    // A row that waits for a decision stays closed: the request card docked above the composer shows its preview.
    open: Boolean(item.running && !item.pendingRequestId),
    background: backgroundAvailable(ui.env, ui.sessionId()) ? ui.background : undefined,
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
  if (row.rowKind === 'withdrawn') return withdrawnEl(ui);
  if (row.rowKind === 'notice') return noticeEl(ui, row);
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
        h('div', {
          class: 'work-row-title', text: t('cards.hook.title', { name: row.hookName, event: row.hookEvent }),
        }),
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
    if (typeof row.toolUses === 'number') {
      details.push(t(pluralKey('cards.task.tools', row.toolUses, getLocale()), { count: row.toolUses }));
    }
    if (typeof row.durationMs === 'number') details.push(formatDuration(row.durationMs));
    return h('div', {
      class: ['work-row', 'is-task', failed && 'is-error'], dataset: { kind: 'task', status },
      attrs: { role: 'status' },
    },
      icon(done ? (failed ? 'alert' : 'check') : 'clock'),
      h('div', { class: 'work-row-body' },
        h('div', { class: 'work-row-title', text: row.description || row.summary || t('cards.task.untitled') }),
        h('div', { class: 'work-row-hint', text: [stateText, ...details].join(' · ') }),
        // A finished agent's summary is its own report, written in Markdown like any reply.
        row.summary && row.description ? h('div', { class: 'work-row-text' }, renderMarkdown(row.summary)) : null,
        row.error ? h('div', { class: 'work-row-text is-error', text: row.error }) : null));
  }
  return genericEl(row.rowKind ?? 'row', row, ui);
}

/** @param {any} ui @param {Record<string, any>} entry */
function noticeEl(ui, entry) {
  const { t, actions } = ui.env;
  const level = entry.level || 'info';
  const text = noticeText(ui, entry);
  const iconName = level === 'error' ? 'alert' : level === 'warning' ? 'alert' : level === 'muted' ? 'info' : 'info';
  const body = (entry.code === 'user-meta' || entry.code === 'agent-message') && text.length > NOTE_COLLAPSE_CHARS
    ? h('details', { class: 'notice-collapse' },
      h('summary', { text: t('cards.notice.note') }),
      h('div', { class: 'notice-text', text }))
    : h('div', { class: 'notice-text', text });
  // A refused prompt can be edited and sent again: the rewind dialog opens on that message.
  const refused = entry.code === 'refusal-no-fallback' && typeof entry.vars?.refused === 'string'
    ? entry.vars.refused
    : null;
  // A retry says what happens in its line; the raw error of the failed request waits under it, collapsed.
  const cause = entry.code === 'api-retry' && entry.vars?.error ? String(entry.vars.error) : '';
  return h('div', {
    class: ['notice', `is-${level}`],
    dataset: { kind: 'notice', code: entry.code },
    attrs: { role: level === 'error' ? 'alert' : 'status' },
  }, icon(iconName), body, refused ? h('button', {
    class: 'btn btn-ghost btn-sm notice-action',
    attrs: { type: 'button' },
    text: t('cards.refusal.editRetry'),
    on: { click: () => actions.openRewind(refused) },
  }) : null, cause ? h('details', { class: 'notice-collapse' },
    h('summary', { text: t('cards.notice.errorDetail') }),
    h('div', { class: 'notice-detail', text: cause })) : null);
}

/**
 * The line a response leaves behind when a fallback model retracted it. Muted, and it takes no part in the transcript.
 * @param {any} ui
 */
function withdrawnEl(ui) {
  const { t } = ui.env;
  return h('div', { class: 'withdrawn', dataset: { kind: 'withdrawn' }, attrs: { role: 'status' } },
    icon('x'), h('span', { text: t('cards.withdrawn') }));
}

/** @param {any} ui @param {Record<string, any>} entry */
function noticeText(ui, entry) {
  const { t } = ui.env;
  const vars = entry.vars ?? {};
  switch (entry.code) {
    case 'refusal-fallback': return entry.text || t('cards.refusal.fallbackDefault');
    case 'refusal-no-fallback': return entry.text || t('cards.refusal.noFallbackDefault');
    case 'plugin-install': return pluginInstallText(ui, vars);
    case 'elicitation-complete':
      return t('cards.elicitation.done', { server: vars.server || t('cards.request.unknownServer') });
    case 'api-retry': {
      const seconds = Number.isFinite(vars.delayMs) ? Math.max(1, Math.round(vars.delayMs / 1000)) : 0;
      return t('cards.notice.apiRetry', { attempt: vars.attempt ?? '?', max: vars.max ?? '?', seconds });
    }
    case 'memory-recall': {
      const count = Number.isFinite(vars.count) ? vars.count : 0;
      return t(pluralKey('cards.notice.memory', count, getLocale()), { count });
    }
    case 'ENGINE_UNAVAILABLE':
      return t('common.error.ENGINE_UNAVAILABLE');
    case 'assistant-error':
      return t('cards.notice.assistantError', { error: String(vars.error ?? '') });
    case 'compact-failed':
      return entry.text ? `${t('cards.notice.compactFailed')}: ${entry.text}` : t('cards.notice.compactFailed');
    case 'agent-message': return t('cards.notice.agentMessage', { text: entry.text || '' });
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
  else if (Number.isFinite(entry.preTokens))
      label = t('cards.divider.compacted', { tokens: formatTokens(entry.preTokens) });
  else label = t('cards.divider.compactedPlain');
  return h('div', {
    class: ['divider', `is-${entry.variant}`], dataset: { kind: 'divider' },
    attrs: { role: 'separator', 'aria-label': label },
  },
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
  let sentence;
  if (variant === 'interrupted') sentence = t('cards.result.interrupted');
  else if (variant === 'error') sentence = t('cards.result.error', { reason: subtypeLabel(ui, entry.subtype) });
  else sentence = doneSentence(t, entry);
  const denials = Array.isArray(entry.permissionDenials) ? entry.permissionDenials : [];
  const errors = Array.isArray(entry.errors) ? entry.errors : [];
  return h('div', { class: ['turn-result', `is-${variant}`], dataset: { kind: 'result' } },
    h('div', { class: 'turn-result-line' },
      icon(variant === 'error' ? 'alert' : variant === 'interrupted' ? 'x' : 'check'),
      h('span', { text: sentence })),
    errors.length > 0
      ? h('ul', { class: 'turn-errors' }, errors.map((message) => h('li', { text: String(message) })))
      : null,
    denials.length > 0 ? h('div', { class: 'turn-denials', text: t('cards.result.denied', {
      count: denials.length,
      tools: denials.map((denial) => denial.toolName).filter(Boolean).join(', '),
    }) }) : null);
}

/**
 * The turn footer of a successful turn as one sentence: "Done in 0.9 s, 3 turns" (no separators between facts).
 * @param {(key: string, vars?: Record<string, unknown>) => string} t
 * @param {Record<string, any>} entry
 * @returns {string}
 */
function doneSentence(t, entry) {
  const turns = Number.isFinite(entry.numTurns) && entry.numTurns > 0 ? turnCount(t, entry.numTurns) : '';
  const duration = Number.isFinite(entry.durationMs) ? formatDuration(entry.durationMs) : '';
  if (duration && turns) return t('cards.result.doneWithTurns', { duration, turns });
  if (duration) return t('cards.result.doneIn', { duration });
  if (turns) return t('cards.result.doneTurns', { turns });
  return t('cards.result.done');
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
    // A refused prompt comes back into the composer when the user chooses to edit it (dialog cards only).
    prompt: typeof entry.prompt === 'string' ? entry.prompt : '',
    insertPrompt: (text) => ui.env.actions.insertIntoComposer(text),
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

/**
 * A thinking block with no text: a muted label, not a disclosure. A redacted block explains itself in its tooltip.
 * @param {any} ui
 * @param {Record<string, any>} block
 */
function thinkingLabel(ui, block) {
  const { t } = ui.env;
  return h('div', {
    class: 'thinking-label',
    dataset: { kind: 'thinking' },
    attrs: block.redacted ? { title: t('cards.thinking.redacted') } : {},
  }, icon('brain'), h('span', { text: t('cards.thinking') }));
}

/**
 * Text of one headless plugin installation step.
 * @param {any} ui
 * @param {Record<string, any>} vars  status, name and error of the step
 * @returns {string}
 */
function pluginInstallText(ui, vars) {
  const { t } = ui.env;
  const name = typeof vars.name === 'string' ? vars.name : '';
  const error = typeof vars.error === 'string' ? vars.error : '';
  switch (vars.status) {
    case 'started': return t('cards.plugin.started');
    case 'installed': return name ? t('cards.plugin.installed', { name }) : t('cards.plugin.installedAny');
    case 'failed':
      if (name && error) return t('cards.plugin.failed', { name, error });
      if (name) return t('cards.plugin.failedName', { name });
      return error ? t('cards.plugin.failedAny', { error }) : t('cards.plugin.failedPlain');
    case 'completed': return t('cards.plugin.completed');
    default: return t('cards.plugin.update');
  }
}

/**
 * Whether tool cards may offer "Run in background": the session is live, the viewer may act (the profile is not read)
 * and the server runs background tasks (meta.features.backgroundTasks).
 * @param {Env} env
 * @param {string|null} sessionId
 * @returns {boolean}
 */
function backgroundAvailable(env, sessionId) {
  if (!sessionId) return false;
  try {
    const state = env.store.get();
    const profile = state.auth?.profile ?? state.meta?.profile ?? null;
    return Boolean(state.live?.[sessionId]) && profile !== 'read' && state.meta?.features?.backgroundTasks === true;
  } catch {
    return false;
  }
}

/**
 * Whether the user chose to see runtime diagnostics: the rows of message types and subtypes the timeline does not know.
 * @param {Env} env
 * @returns {boolean}
 */
function runtimeEventsShown(env) {
  try {
    return env.store.get()?.prefs?.showRuntimeEvents === true;
  } catch {
    return false;
  }
}

/** @param {Record<string, any>} entry @returns {boolean} true for an unknown type or subtype kept for diagnostics */
function isDiagnostic(entry) {
  return entry.kind === 'generic' && entry.diagnostic === true;
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
