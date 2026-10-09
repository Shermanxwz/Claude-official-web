/**
 * Application shell: layout, the shared `actions` object, session selection (with the #/s/<id> hash), data loading,
 * SSE routing, notifications and banners. Parts (header, sidebar, timeline, composer, terminal) are mounted into
 * stable slots and rebuilt on language change while the event stream stays open.
 */

import { h, clear, icon } from '../dom.js';
import { connectEvents, createUuid, errorText } from '../api.js';
import { getLocale, onLocaleChange } from '../i18n.js';
import { createHeader } from './header.js';
import { createComposer } from './composer.js';
import { createSidebar } from './sidebar.js';
import { createToasts } from './toasts.js';
import { closeAllDialogs } from './dialog.js';
import { closeMenu } from './menu.js';
import { closePanel, openPanel, refreshSessionList, renameSessionDialog } from './panels.js';
import { openNewSessionDialog } from './new-session.js';
import { formatClock } from './sidebar-model.js';
import { createTimeline } from '../timeline/view.js';
import { openForkDialog, openRewindDialog } from '../timeline/rewind.js';
import { createTerminalPanel } from '../terminal.js';

const MOBILE_QUERY = '(max-width: 767.98px)';
const SESSIONS_DEBOUNCE_MS = 300;
const CONNECTION_GRACE_MS = 2000;
const FORWARDED_EVENTS = new Set(['message_accepted', 'sdk', 'request', 'request_resolved', 'session_state',
  'resync']);

/**
 * @param {string} hash
 * @returns {string | null}
 */
function parseHash(hash) {
  const match = /^#\/s\/([0-9a-fA-F-]{36})\/?$/.exec(hash ?? '');
  return match ? match[1] : null;
}

/**
 * @param {{
 *   root: HTMLElement,
 *   api: any,
 *   store: any,
 *   t: (key: string, vars?: Record<string, string | number>) => string,
 * }} options
 * @returns {{ destroy(): void }}
 */
export function createAppShell({ root, api, store, t }) {
  let destroyed = false;
  let bootToken = 0;
  let loadToken = 0;
  let lastBootId = null;
  let reloading = false;
  let bootError = '';
  /** @type {{ status: string, resetsAt?: number } | null} */
  let rateLimit = null;
  /** @type {{ level: 'info'|'error', text: string } | null} */
  let authNotice = null;
  let connectionLost = false;
  let wasOpen = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let offlineTimer = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let sessionsTimer = null;
  /** @type {ReturnType<typeof connectEvents> | null} */
  let events = null;

  /** @type {Partial<{header: any, composer: any, timeline: any, sidebar: any, terminal: any}>} */
  let parts = {};

  const mobileQuery = typeof window.matchMedia === 'function' ? window.matchMedia(MOBILE_QUERY) : null;

  const toastHost = h('div', { class: 'app-toasts' });
  const toasts = createToasts(toastHost);

  const sidebarEl = h('aside', { class: 'app-sidebar', attrs: { 'aria-label': t('shell.sidebar.label') } });
  const scrim = h('div', { class: 'app-scrim', attrs: { 'aria-hidden': 'true' }, on: { click: () => setSidebarOpen(false) } });
  const reopenButton = h('button', {
    class: 'btn btn-secondary btn-icon app-reopen',
    attrs: { type: 'button', 'aria-label': t('shell.sidebar.show'), title: t('shell.sidebar.show') },
    on: { click: () => setSidebarOpen(true) },
  }, icon('menu'));
  const headerSlot = h('header', { class: 'app-header-slot' });
  const bannerSlot = h('div', { class: 'app-banners' });
  const timelineSlot = h('div', { class: 'app-timeline-slot' });
  const welcomeHost = h('section', { class: 'welcome', attrs: { 'aria-live': 'polite' } });
  const terminalSlot = h('div', { class: 'app-terminal-slot' });
  const composerSlot = h('div', { class: 'app-composer-slot' });
  const main = h('main', { class: 'app-main', attrs: { id: 'main' } },
    reopenButton, headerSlot, bannerSlot, timelineSlot, terminalSlot, composerSlot);
  const layout = h('div', { class: 'app', dataset: { sidebar: 'open' } }, sidebarEl, scrim, main, toastHost);

  root.replaceChildren(layout);
  let timelineHost = h('div', { class: 'app-timeline' });
  timelineSlot.append(welcomeHost, timelineHost);

  function appName() {
    const state = store.get();
    return state.meta?.appName || state.auth?.appName || 'Agent Web';
  }

  function isMobile() {
    return mobileQuery ? mobileQuery.matches : false;
  }

  /** @param {boolean} open */
  function setSidebarOpen(open) {
    const { prefs } = store.get();
    if (prefs.sidebarOpen !== open) store.set({ prefs: { ...prefs, sidebarOpen: open } });
  }

  /**
   * @param {'info'|'success'|'warning'|'error'} level
   */
  function toast(message, level = 'info') {
    return toasts.toast(message, level);
  }

  function currentSessionId() {
    return store.get().currentSessionId;
  }

  /** @param {string | null} sessionId @param {'push'|'replace'|'none'} mode */
  function syncHash(sessionId, mode) {
    if (mode === 'none') return;
    const hash = sessionId ? `#/s/${sessionId}` : '';
    if (location.hash === hash || (!hash && !location.hash)) return;
    if (mode === 'push' && hash) {
      location.hash = hash;
      return;
    }
    history.replaceState(history.state, '', `${location.pathname}${location.search}${hash}`);
  }

  function renderWelcome() {
    clear(welcomeHost);
    const state = store.get();
    const hasSession = Boolean(state.currentSessionId);
    welcomeHost.hidden = hasSession;
    timelineHost.hidden = !hasSession;
    if (hasSession) return;
    if (bootError) {
      welcomeHost.append(
        h('p', { class: 'welcome-text', attrs: { role: 'alert' }, text: bootError }),
        h('button', {
          class: 'btn btn-secondary',
          attrs: { type: 'button' },
          on: { click: () => boot() },
        }, icon('refresh'), h('span', { text: t('common.retry') })));
      return;
    }
    welcomeHost.append(
      h('img', { class: 'welcome-logo', attrs: { src: '/img/logo.svg', alt: '', width: 56, height: 56 } }),
      h('h2', { class: 'welcome-title', text: t('shell.welcome.title') }),
      h('p', { class: 'welcome-text', text: state.sessions.length > 0 ? t('shell.welcome.pick') : t('shell.welcome.text') }),
      h('button', {
        class: 'btn btn-primary btn-lg',
        attrs: { type: 'button' },
        on: { click: () => actions.newSession() },
      }, icon('plus'), h('span', { text: t('shell.sidebar.newSession') })));
  }

  function mountParts() {
    timelineHost = h('div', { class: 'app-timeline' });
    timelineSlot.replaceChildren(welcomeHost, timelineHost);
    parts = {
      header: createHeader({ container: headerSlot, api, store, t, actions }),
      composer: createComposer({ container: composerSlot, api, store, t, actions }),
      timeline: createTimeline({ container: timelineHost, api, store, t, actions }),
      sidebar: createSidebar({ container: sidebarEl, api, store, t, actions }),
      terminal: createTerminalPanel({ container: terminalSlot, api, store, t }),
    };
    const id = currentSessionId();
    parts.header.setSession(id);
    parts.composer.setSession(id);
    renderWelcome();
    renderBanners();
  }

  function unmountParts() {
    for (const part of Object.values(parts)) part?.destroy?.();
    parts = {};
    clear(headerSlot);
    clear(composerSlot);
    clear(terminalSlot);
  }

  /** @param {string} sessionId */
  async function hydratePending(sessionId, token) {
    const live = store.get().live[sessionId];
    if (!live || !(live.pendingCount > 0)) return;
    const detail = await api.get(`/api/sessions/${encodeURIComponent(sessionId)}`);
    if (destroyed || token !== loadToken) return;
    store.set({ pending: { ...store.get().pending, [sessionId]: Array.isArray(detail.pending) ? detail.pending : [] } });
  }

  /**
   * Select a session: load its transcript, then watch its events from the snapshot's sequence number.
   * @param {string | null} sessionId
   * @param {{ history?: 'push' | 'replace' | 'none' }} [options]
   */
  async function selectSession(sessionId, { history = 'push' } = {}) {
    if (destroyed) return;
    if (sessionId === currentSessionId() && sessionId !== null) return;
    const token = ++loadToken;
    store.set({ currentSessionId: sessionId });
    rateLimit = null;
    authNotice = null;
    if (parts.terminal?.isOpen()) parts.terminal.close();
    parts.header?.setSession(sessionId);
    parts.composer?.setSession(sessionId);
    parts.composer?.setSuggestion(null);
    syncHash(sessionId, history);
    if (isMobile()) setSidebarOpen(false);
    renderWelcome();
    renderBanners();
    if (!sessionId) {
      events?.reconnect({ watch: null, after: null });
      return;
    }
    try {
      const result = await parts.timeline.load(sessionId);
      if (destroyed || token !== loadToken) return;
      events?.reconnect({ watch: sessionId, after: result?.seq ?? null });
      await hydratePending(sessionId, token);
    } catch (err) {
      if (destroyed || token !== loadToken) return;
      if (err?.code === 'SESSION_NOT_FOUND') {
        store.set({ currentSessionId: null });
        syncHash(null, 'replace');
        renderWelcome();
      }
      toast(errorText(err, t), 'error');
    }
  }

  /** @returns {Promise<string | null>} uuid of the most recent prompt written by the user */
  async function lastUserMessageId(sessionId) {
    const data = await api.get(`/api/sessions/${encodeURIComponent(sessionId)}/messages?tail=200`);
    const messages = Array.isArray(data.messages) ? data.messages : [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.type !== 'user' || typeof message.uuid !== 'string') continue;
      const content = message.message?.content;
      const isPrompt = typeof content === 'string'
        || (Array.isArray(content) && content.some((block) => block?.type === 'text'));
      if (isPrompt) return message.uuid;
    }
    return null;
  }

  /**
   * @param {{text: string, attachments?: Array<{path: string}>}} payload
   * @returns {Promise<boolean>}
   */
  async function sendMessage({ text, attachments = [] }) {
    const sessionId = currentSessionId();
    if (!sessionId) {
      toast(t('shell.send.noSession'), 'warning');
      return false;
    }
    const clientMessageId = createUuid();
    parts.timeline?.addOptimisticUserMessage({ clientMessageId, text, attachments });
    try {
      await api.post(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
        clientMessageId,
        text,
        attachments: attachments.length > 0 ? attachments.map((file) => ({ path: file.path })) : undefined,
      });
      return true;
    } catch (err) {
      const message = errorText(err, t);
      parts.timeline?.applyEvent('message_failed', { clientMessageId, error: message });
      toast(message, 'error');
      return false;
    }
  }

  async function interrupt() {
    const sessionId = currentSessionId();
    if (!sessionId) return;
    try {
      await api.post(`/api/sessions/${encodeURIComponent(sessionId)}/interrupt`, {});
    } catch (err) {
      toast(errorText(err, t), 'error');
    }
  }

  /** @param {{model?: string|null, permissionMode?: string, effort?: string|null}} settings */
  async function updateSettings(settings) {
    const sessionId = currentSessionId();
    if (!sessionId) return null;
    try {
      const result = await api.post(`/api/sessions/${encodeURIComponent(sessionId)}/settings`, settings);
      if (result?.live) store.set({ live: { ...store.get().live, [sessionId]: result.live } });
      return result?.live ?? null;
    } catch (err) {
      toast(errorText(err, t), 'error');
      return false;
    }
  }

  /** @param {string} [userMessageId] */
  async function openRewind(userMessageId) {
    const sessionId = currentSessionId();
    if (!sessionId) return;
    let target = userMessageId ?? null;
    if (!target) {
      try {
        target = await lastUserMessageId(sessionId);
      } catch (err) {
        toast(errorText(err, t), 'error');
        return;
      }
      if (!target) {
        toast(t('shell.rewind.none'), 'warning');
        return;
      }
    }
    openRewindDialog({ api, sessionId, userMessageId: target, t, actions });
  }

  /** @param {string} [upToMessageId] */
  function openFork(upToMessageId) {
    const sessionId = currentSessionId();
    if (!sessionId) return;
    openForkDialog({ api, sessionId, upToMessageId, t, actions });
  }

  function openTerminal() {
    const state = store.get();
    const profile = state.meta?.profile ?? state.auth?.profile ?? null;
    if (!state.meta?.features?.terminal || profile !== 'full') {
      toast(t('common.error.FEATURE_DISABLED'), 'warning');
      return;
    }
    const sessionId = currentSessionId();
    if (!sessionId) {
      toast(t('shell.terminal.noSession'), 'warning');
      return;
    }
    parts.terminal?.open({ sessionId });
  }

  function renameCurrent() {
    const sessionId = currentSessionId();
    if (!sessionId) return;
    const summary = store.get().sessions.find((session) => session.sessionId === sessionId);
    renameSessionDialog({
      api,
      t,
      sessionId,
      currentTitle: summary?.customTitle ?? '',
      onDone: () => refreshSessionList({ api, store }).catch((err) => toast(errorText(err, t), 'error')),
    });
  }

  /** @type {any} */
  const actions = {
    selectSession: (sessionId) => selectSession(sessionId ?? null),
    newSession: () => openNewSessionDialog({ api, store, t, actions }),
    sendMessage,
    interrupt,
    updateSettings,
    openRewind,
    openFork,
    openTerminal,
    openPanel: (name) => openPanel(name, { api, store, t, actions }),
    renameSession: renameCurrent,
    toast,
    insertIntoComposer: (text) => parts.composer?.insertText(text),
  };

  /**
   * Route one SSE event.
   * @param {string} type
   * @param {any} data
   */
  function handleEvent(type, data) {
    if (destroyed) return;
    switch (type) {
      case 'hello':
        if (lastBootId && data.bootId !== lastBootId) reloadAll();
        else lastBootId = data.bootId ?? lastBootId;
        break;
      case 'resync':
        reloadAll();
        break;
      case 'sessions_changed':
        scheduleSessionsRefresh();
        break;
      case 'session_state':
        onSessionState(data);
        break;
      case 'request':
        onRequest(data);
        break;
      case 'request_resolved':
        onRequestResolved(data);
        break;
      case 'notice':
        onNotice(data);
        break;
      case 'terminal_state':
        store.set({ terminal: { ...store.get().terminal, [data.sessionId]: data.attached === true } });
        break;
      case 'sdk':
        onSdk(data);
        break;
      default:
        break;
    }
    if (FORWARDED_EVENTS.has(type)) parts.timeline?.applyEvent(type, data);
  }

  function scheduleSessionsRefresh() {
    if (sessionsTimer !== null) clearTimeout(sessionsTimer);
    sessionsTimer = setTimeout(() => {
      sessionsTimer = null;
      refreshSessionList({ api, store }).catch((err) => toast(errorText(err, t), 'error'));
    }, SESSIONS_DEBOUNCE_MS);
  }

  /** @param {any} data */
  function onSessionState(data) {
    const info = data.live;
    const sessionId = info ? info.sessionId : data.sessionId;
    if (!sessionId) return;
    const live = { ...store.get().live };
    if (info) {
      live[sessionId] = info;
      store.set({ live });
      return;
    }
    delete live[sessionId];
    const pending = { ...store.get().pending };
    delete pending[sessionId];
    store.set({ live, pending });
  }

  /** @param {any} data */
  function onRequest(data) {
    const request = data.request;
    if (!request?.sessionId) return;
    const pending = store.get().pending;
    const list = pending[request.sessionId] ?? [];
    if (!list.some((item) => item.id === request.id)) {
      store.set({ pending: { ...pending, [request.sessionId]: [...list, request] } });
    }
    let body = t(`shell.notify.${request.kind}`);
    if (request.kind === 'permission' && request.toolName) {
      body = t('shell.notify.permission', { tool: request.toolName });
    }
    notifyIfHidden(appName(), body, `request-${request.id}`);
  }

  /** @param {any} data */
  function onRequestResolved(data) {
    if (!data.sessionId) return;
    const pending = store.get().pending;
    const list = pending[data.sessionId];
    if (!list) return;
    store.set({ pending: { ...pending, [data.sessionId]: list.filter((item) => item.id !== data.requestId) } });
  }

  /** @param {any} data */
  function onNotice(data) {
    const level = data.level === 'warning' || data.level === 'error' ? data.level : 'info';
    // Notice codes are protocol error codes (docs/PROTOCOL.md), so a known code shows its localized error text.
    const key = `common.error.${typeof data.code === 'string' ? data.code : ''}`;
    const localized = t(key);
    toast(localized !== key ? localized : String(data.message ?? ''), level);
  }

  /** @param {any} data */
  function onSdk(data) {
    const { sessionId, msg } = data;
    if (!msg || sessionId !== currentSessionId()) return;
    switch (msg.type) {
      case 'rate_limit_event':
        rateLimit = msg.rate_limit_info ?? null;
        renderBanners();
        break;
      case 'prompt_suggestion':
        parts.composer?.setSuggestion(typeof msg.suggestion === 'string' ? msg.suggestion : null);
        break;
      case 'auth_status':
        authNotice = msg.error
          ? { level: 'error', text: String(msg.error) }
          : msg.isAuthenticating ? { level: 'info', text: t('shell.auth.authenticating') } : null;
        renderBanners();
        break;
      case 'result':
        notifyIfHidden(appName(), t(msg.is_error ? 'shell.notify.turnFailed' : 'shell.notify.turnDone'),
          `turn-${sessionId}`);
        break;
      case 'system':
        onSystemMessage(sessionId, msg);
        break;
      default:
        break;
    }
  }

  /**
   * @param {string} sessionId
   * @param {any} msg
   */
  function onSystemMessage(sessionId, msg) {
    if (msg.subtype === 'notification') {
      const level = msg.priority === 'immediate' || msg.priority === 'high' ? 'warning' : 'info';
      toast(String(msg.text ?? ''), level);
      return;
    }
    if (typeof msg.subtype !== 'string' || !msg.subtype.startsWith('task_') || typeof msg.task_id !== 'string') return;
    const tasks = store.get().tasks[sessionId] ?? {};
    const previous = tasks[msg.task_id] ?? {};
    let patch = null;
    if (msg.subtype === 'task_started') {
      patch = { description: msg.description, status: 'running' };
    } else if (msg.subtype === 'task_progress') {
      patch = {
        description: msg.description ?? previous.description,
        status: 'running',
        summary: msg.summary ?? previous.summary,
        lastToolName: msg.last_tool_name ?? previous.lastToolName,
      };
    } else if (msg.subtype === 'task_notification') {
      patch = { status: msg.status, summary: msg.summary ?? previous.summary };
    } else if (msg.subtype === 'task_updated') {
      const update = msg.patch ?? {};
      patch = {
        status: update.status ?? previous.status,
        description: update.description ?? previous.description,
        summary: update.error ?? previous.summary,
      };
    }
    if (!patch) return;
    store.set({
      tasks: { ...store.get().tasks, [sessionId]: { ...tasks, [msg.task_id]: { ...previous, ...patch } } },
    });
  }

  /**
   * Browser notification when the page is hidden and the user opted in.
   * @param {string} title
   * @param {string} body
   * @param {string} tag
   */
  function notifyIfHidden(title, body, tag) {
    if (!document.hidden) return;
    const { prefs } = store.get();
    if (!prefs.notify || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    try {
      const note = new Notification(title, { body, tag, icon: '/favicon.svg' });
      note.onclick = () => {
        window.focus();
        note.close();
      };
    } catch {
      // Notifications are unavailable in this context (for example some mobile webviews).
    }
  }

  function pendingTotal() {
    return Object.values(store.get().live).reduce((sum, live) => sum + (live?.pendingCount ?? 0), 0);
  }

  function updateDocumentTitle() {
    const count = pendingTotal();
    const name = appName();
    document.title = count > 0 ? `(${count}) ${name}` : name;
  }

  function updateConnection(status) {
    if (status === 'open') {
      wasOpen = true;
      if (offlineTimer !== null) clearTimeout(offlineTimer);
      offlineTimer = null;
      if (connectionLost) {
        connectionLost = false;
        renderBanners();
      }
      return;
    }
    if (wasOpen && offlineTimer === null && !connectionLost) {
      offlineTimer = setTimeout(() => {
        offlineTimer = null;
        connectionLost = true;
        renderBanners();
      }, CONNECTION_GRACE_MS);
    }
  }

  /**
   * @param {'info'|'warning'|'danger'} level
   * @param {string} text
   * @param {() => void} [onDismiss]
   */
  function banner(level, text, onDismiss) {
    return h('div', { class: `banner banner-${level}`, attrs: { role: 'status' } },
      icon(level === 'info' ? 'info' : 'alert'),
      h('p', { class: 'banner-text', text }),
      onDismiss ? h('button', {
        class: 'btn btn-ghost btn-icon btn-sm',
        attrs: { type: 'button', 'aria-label': t('common.dismiss') },
        on: { click: onDismiss },
      }, icon('x')) : null);
  }

  function renderBanners() {
    clear(bannerSlot);
    if (connectionLost) bannerSlot.append(banner('warning', t('shell.connection.lost')));
    if (rateLimit && rateLimit.status !== 'allowed') {
      const reset = rateLimit.resetsAt ? formatClock(rateLimit.resetsAt * 1000, getLocale()) : '';
      const rejected = rateLimit.status === 'rejected';
      const text = reset
        ? t(rejected ? 'shell.rateLimit.rejectedAt' : 'shell.rateLimit.warningAt', { time: reset })
        : t(rejected ? 'shell.rateLimit.rejected' : 'shell.rateLimit.warning');
      bannerSlot.append(banner(rejected ? 'danger' : 'warning', text, () => {
        rateLimit = null;
        renderBanners();
      }));
    }
    if (authNotice) {
      const current = authNotice;
      bannerSlot.append(banner(current.level === 'error' ? 'danger' : 'info', current.text, () => {
        authNotice = null;
        renderBanners();
      }));
    }
  }

  async function reloadAll() {
    if (reloading || destroyed) return;
    reloading = true;
    try {
      const meta = await api.get('/api/meta');
      if (destroyed) return;
      lastBootId = meta.bootId ?? lastBootId;
      store.set({ meta });
      await refreshSessionList({ api, store });
      const sessionId = currentSessionId();
      if (sessionId && parts.timeline) {
        const token = ++loadToken;
        const result = await parts.timeline.load(sessionId);
        if (destroyed || token !== loadToken) return;
        events?.reconnect({ watch: sessionId, after: result?.seq ?? null });
      }
    } catch (err) {
      if (!destroyed) toast(errorText(err, t), 'error');
    } finally {
      reloading = false;
    }
  }

  /** Load meta and the session list, connect the event stream, then select the initial session. */
  async function boot() {
    const token = ++bootToken;
    bootError = '';
    renderWelcome();
    try {
      const meta = await api.get('/api/meta');
      if (destroyed || token !== bootToken) return;
      lastBootId = meta.bootId ?? null;
      store.set({ meta });
      if (!events) {
        events = connectEvents({
          watch: null,
          after: null,
          onEvent: handleEvent,
          onStatus: (status) => store.set({ connection: status }),
        });
      }
      updateDocumentTitle();
      await refreshSessionList({ api, store });
      if (destroyed || token !== bootToken) return;
      if (isMobile()) setSidebarOpen(false);
      const hashId = parseHash(location.hash);
      const first = store.get().sessions[0]?.sessionId ?? null;
      await selectSession(hashId ?? first, { history: hashId ? 'none' : 'replace' });
    } catch (err) {
      if (destroyed || token !== bootToken) return;
      bootError = errorText(err, t);
      renderWelcome();
    }
  }

  function applySidebarState() {
    const { prefs } = store.get();
    layout.dataset.sidebar = prefs.sidebarOpen ? 'open' : 'closed';
  }

  const onHashChange = () => {
    const sessionId = parseHash(location.hash);
    if (sessionId !== currentSessionId()) selectSession(sessionId, { history: 'none' });
  };
  const onViewportChange = () => {
    setSidebarOpen(!isMobile());
  };

  mountParts();
  onViewportChange();
  applySidebarState();
  const unsubscribeStore = store.subscribe((state, prev) => {
    if (destroyed) return;
    if (state.prefs !== prev.prefs) applySidebarState();
    if (state.live !== prev.live || state.pending !== prev.pending || state.meta !== prev.meta
      || state.auth !== prev.auth) {
      updateDocumentTitle();
    }
    if (state.connection !== prev.connection) updateConnection(state.connection);
    if (state.sessionsReady !== prev.sessionsReady || state.sessions !== prev.sessions
      || state.currentSessionId !== prev.currentSessionId) {
      renderWelcome();
    }
  });
  const unsubscribeLocale = onLocaleChange(() => {
    if (destroyed) return;
    const sessionId = currentSessionId();
    unmountParts();
    mountParts();
    if (sessionId && parts.timeline) {
      const token = ++loadToken;
      parts.timeline.load(sessionId).then((result) => {
        if (destroyed || token !== loadToken) return;
        events?.reconnect({ watch: sessionId, after: result?.seq ?? null });
      }, (err) => toast(errorText(err, t), 'error'));
    }
  });
  window.addEventListener('hashchange', onHashChange);
  mobileQuery?.addEventListener?.('change', onViewportChange);
  boot();

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      events?.close();
      events = null;
      if (sessionsTimer !== null) clearTimeout(sessionsTimer);
      if (offlineTimer !== null) clearTimeout(offlineTimer);
      unsubscribeStore();
      unsubscribeLocale();
      window.removeEventListener('hashchange', onHashChange);
      mobileQuery?.removeEventListener?.('change', onViewportChange);
      closePanel();
      closeAllDialogs();
      closeMenu();
      unmountParts();
      toasts.destroy();
      root.replaceChildren();
    },
  };
}
