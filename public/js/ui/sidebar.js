/**
 * Session sidebar: brand, new session, search, sessions grouped by project with live state, row menus, paging,
 * and a footer with settings, connection state and sign out. Rendering follows the store; the shell owns loading.
 */

import { h, clear, icon } from '../dom.js';
import { errorText } from '../api.js';
import { getLocale } from '../i18n.js';
import { openMenu } from './menu.js';
import { openForkDialog } from '../timeline/rewind.js';
import {
  deleteSessionFlow, refreshSessionList, renameSessionDialog, tagSessionDialog,
} from './panels.js';
import {
  filterSessions, formatRelativeTime, groupSessions, liveTone, mergeLive, sessionActivity, sessionCwd, sessionTitle,
} from './sidebar-model.js';

const PAGE_SIZE = 100;
const TIME_REFRESH_MS = 60 * 1000;

/**
 * @param {{
 *   container: HTMLElement,
 *   api: { get(path: string): Promise<any>, post(path: string, body?: unknown): Promise<any> },
 *   store: any,
 *   t: (key: string, vars?: Record<string, string | number>) => string,
 *   actions: any,
 * }} options
 * @returns {{ destroy(): void }}
 */
export function createSidebar({ container, api, store, t, actions }) {
  let destroyed = false;
  let query = '';
  let loadingMore = false;
  /** @type {Set<string>} */
  const collapsed = new Set();

  const logo = h('img', { class: 'sidebar-logo', attrs: { src: '/img/logo.svg', alt: '', width: 26, height: 26 } });
  const appNameEl = h('span', { class: 'sidebar-app' });
  const brand = h('div', { class: 'sidebar-brand' },
    logo,
    appNameEl,
    h('button', {
      class: 'btn btn-ghost btn-icon sidebar-close',
      attrs: { type: 'button', 'aria-label': t('shell.sidebar.close') },
      on: { click: () => setSidebarOpen(false) },
    }, icon('x')),
    h('button', {
      class: 'btn btn-ghost btn-icon sidebar-collapse',
      attrs: { type: 'button', 'aria-label': t('shell.sidebar.hide'), title: t('shell.sidebar.hide') },
      on: { click: () => setSidebarOpen(false) },
    }, icon('menu')));

  const newButton = h('button', {
    class: 'btn btn-primary btn-block sidebar-new',
    attrs: { type: 'button' },
    on: { click: () => actions.newSession() },
  }, icon('plus'), h('span', { text: t('shell.sidebar.newSession') }));

  const searchInput = h('input', {
    class: 'sidebar-search-input',
    attrs: {
      type: 'search',
      placeholder: t('shell.sidebar.search'),
      'aria-label': t('shell.sidebar.search'),
      autocomplete: 'off',
      spellcheck: false,
    },
    on: {
      input: () => {
        query = searchInput.value;
        renderList();
      },
    },
  });
  const search = h('label', { class: 'sidebar-search' }, icon('search'), searchInput);

  const listEl = h('nav', { class: 'sidebar-list', attrs: { 'aria-label': t('shell.sidebar.sessions') } });

  const connectionDot = h('span', { class: 'conn-dot', attrs: { 'aria-hidden': 'true' } });
  const connectionText = h('span', { class: 'conn-text' });
  const connectionEl = h('div', { class: 'sidebar-connection', attrs: { role: 'status' } },
    connectionDot, connectionText);

  const settingsButton = h('button', {
    class: 'btn btn-ghost btn-icon',
    attrs: { type: 'button', 'aria-label': t('shell.sidebar.settings'), title: t('shell.sidebar.settings') },
    on: { click: () => actions.openPanel('settings') },
  }, icon('settings'));
  const logoutButton = h('button', {
    class: 'btn btn-ghost btn-icon',
    attrs: { type: 'button', 'aria-label': t('shell.sidebar.logout'), title: t('shell.sidebar.logout') },
    on: { click: () => signOut() },
  }, icon('logout'));
  const footer = h('div', { class: 'sidebar-footer' }, connectionEl, settingsButton, logoutButton);

  container.replaceChildren(
    brand,
    h('div', { class: 'sidebar-top' }, newButton, search),
    listEl,
    footer,
  );

  /** @param {boolean} open */
  function setSidebarOpen(open) {
    const { prefs } = store.get();
    if (prefs.sidebarOpen !== open) store.set({ prefs: { ...prefs, sidebarOpen: open } });
  }

  function appName() {
    const state = store.get();
    return state.meta?.appName || state.auth?.appName || 'Agent Web';
  }

  async function signOut() {
    try {
      await api.post('/api/logout', {});
    } catch (err) {
      actions.toast(errorText(err, t), 'error');
      return;
    }
    const { auth } = store.get();
    store.set({ auth: { ...auth, authenticated: false } });
  }

  function profile() {
    return store.get().meta?.profile ?? store.get().auth?.profile ?? null;
  }

  function refreshAfterChange() {
    refreshSessionList({ api, store }).catch((err) => actions.toast(errorText(err, t), 'error'));
  }

  /**
   * @param {HTMLElement} anchor
   * @param {any} session
   */
  function openRowMenu(anchor, session) {
    const sessionId = session.sessionId;
    const live = store.get().live[sessionId] ?? session.live ?? null;
    const title = sessionTitle(session, t('shell.untitled'));
    const entries = [
      {
        label: t('shell.sidebar.rename'),
        icon: 'edit',
        onClick: () => renameSessionDialog({ api, t, sessionId, currentTitle: title, onDone: refreshAfterChange }),
      },
      {
        label: t('shell.sidebar.tag'),
        icon: 'list',
        onClick: () => tagSessionDialog({ api, t, sessionId, currentTag: session.tag ?? '', onDone: refreshAfterChange }),
      },
      {
        label: t('shell.sidebar.fork'),
        icon: 'fork',
        onClick: () => openForkDialog({ api, sessionId, upToMessageId: undefined, t, actions }),
      },
    ];
    if (profile() === 'full' && !live) {
      entries.push('separator', {
        label: t('shell.sidebar.delete'),
        icon: 'trash',
        danger: true,
        onClick: () => deleteSessionFlow({ api, store, t, actions, sessionId, title, onDone: refreshAfterChange }),
      });
    }
    openMenu(anchor, entries, { label: t('shell.sidebar.sessionActions') });
  }

  /**
   * @param {any} session
   * @param {string | null} activeId
   */
  function sessionRow(session, activeId) {
    const state = store.get();
    const live = state.live[session.sessionId] ?? session.live ?? null;
    const pendingCount = live?.pendingCount ?? state.pending[session.sessionId]?.length ?? 0;
    const tone = liveTone(live);
    const selected = session.sessionId === activeId;
    const title = sessionTitle(session, t('shell.untitled'));
    const when = formatRelativeTime(sessionActivity(session), {
      now: Date.now(),
      locale: getLocale(),
      justNow: t('common.time.justNow'),
    });

    const dot = tone
      ? h('span', {
        class: ['state-dot', `state-${tone}`],
        attrs: { title: t(`common.state.${live.state}`), 'aria-label': t(`common.state.${live.state}`), role: 'img' },
      })
      : null;

    const main = h('button', {
      class: 'session-main',
      attrs: {
        type: 'button',
        title: `${title}\n${sessionCwd(session)}`.trim(),
        'aria-current': selected ? 'true' : null,
        'data-focus-key': `${session.sessionId}:main`,
      },
      on: { click: () => actions.selectSession(session.sessionId) },
    },
    h('span', { class: 'session-line' }, dot, h('span', { class: 'session-title', text: title })),
    h('span', { class: 'session-meta' },
      session.tag ? h('span', { class: 'chip chip-tag', text: session.tag }) : null,
      h('span', { class: 'session-time', text: when }),
      pendingCount > 0
        ? h('span', { class: 'badge badge-attention', attrs: { title: t('shell.sidebar.pending', { count: pendingCount }) } },
          String(pendingCount))
        : null));

    const more = h('button', {
      class: 'btn btn-ghost btn-icon btn-sm session-more',
      attrs: {
        type: 'button',
        'aria-label': t('shell.sidebar.sessionActions'),
        'aria-haspopup': 'menu',
        'data-focus-key': `${session.sessionId}:more`,
      },
      on: { click: (event) => openRowMenu(/** @type {HTMLElement} */ (event.currentTarget), session) },
    }, icon('more'));

    return h('li', {
      class: ['session-row', selected ? 'is-active' : '', tone === 'running' ? 'is-running' : ''],
      dataset: { sessionId: session.sessionId },
    }, main, more);
  }

  /**
   * @param {{key: string, cwd: string|null, name: string|null, sessions: any[]}} group
   * @param {string | null} activeId
   * @param {boolean} searching
   */
  function groupSection(group, activeId, searching) {
    const isCollapsed = !searching && collapsed.has(group.key);
    const label = group.name ?? t('shell.sidebar.noProject');
    const header = h('button', {
      class: 'group-head',
      attrs: {
        type: 'button',
        'aria-expanded': String(!isCollapsed),
        title: group.cwd ?? label,
        'data-focus-key': `group:${group.key}`,
      },
      on: {
        click: () => {
          if (collapsed.has(group.key)) collapsed.delete(group.key);
          else collapsed.add(group.key);
          renderList();
        },
      },
    },
    icon(isCollapsed ? 'chevron-right' : 'chevron-down'),
    h('span', { class: 'group-name', text: label }),
    h('span', { class: 'group-count', text: String(group.sessions.length) }));
    const items = h('ul', { class: 'group-items', attrs: { hidden: isCollapsed } },
      group.sessions.map((session) => sessionRow(session, activeId)));
    return h('section', { class: 'session-group', attrs: { 'aria-label': label } }, header, items);
  }

  function skeleton() {
    return h('div', { class: 'sidebar-skeleton', attrs: { 'aria-hidden': 'true' } },
      [0, 1, 2, 3].map((i) => h('div', { class: 'skeleton skeleton-row', style: { width: `${88 - i * 9}%` } })));
  }

  function renderList() {
    if (destroyed) return;
    const state = store.get();
    const focused = /** @type {HTMLElement | null} */ (document.activeElement);
    const focusKey = focused && listEl.contains(focused) ? focused.dataset.focusKey ?? null : null;

    clear(listEl);
    if (!state.sessionsReady) {
      listEl.appendChild(skeleton());
      return;
    }

    const searching = query.trim() !== '';
    const visible = filterSessions(state.sessions, query);
    if (state.sessions.length === 0) {
      listEl.appendChild(h('div', { class: 'sidebar-empty' },
        icon('spark'),
        h('p', { class: 'sidebar-empty-title', text: t('shell.sidebar.emptyTitle') }),
        h('p', { class: 'sidebar-empty-text', text: t('shell.sidebar.emptyText') })));
    } else if (visible.length === 0) {
      listEl.appendChild(h('p', { class: 'sidebar-empty-text', text: t('shell.sidebar.noMatches') }));
    } else {
      for (const group of groupSessions(visible)) {
        listEl.appendChild(groupSection(group, state.currentSessionId, searching));
      }
    }

    if (state.sessionsHasMore && !searching) {
      const more = h('button', {
        class: 'btn btn-ghost btn-block sidebar-more',
        attrs: { type: 'button', disabled: loadingMore },
        on: { click: () => loadMore() },
      }, t('shell.sidebar.loadMore'));
      listEl.appendChild(more);
    }

    if (focusKey) {
      const selector = `[data-focus-key="${CSS.escape(focusKey)}"]`;
      listEl.querySelector(selector)?.focus({ preventScroll: true });
    }
  }

  function renderChrome() {
    if (destroyed) return;
    appNameEl.textContent = appName();
    const { connection } = store.get();
    connectionEl.dataset.state = connection;
    connectionText.textContent = t(`shell.connection.${connection}`);
  }

  async function loadMore() {
    if (loadingMore) return;
    loadingMore = true;
    renderList();
    try {
      const state = store.get();
      const offset = state.sessions.length;
      const data = await api.get(`/api/sessions?limit=${PAGE_SIZE}&offset=${offset}`);
      if (destroyed) return;
      const page = Array.isArray(data.sessions) ? data.sessions : [];
      const current = store.get();
      const known = new Set(current.sessions.map((session) => session.sessionId));
      store.set({
        sessions: [...current.sessions, ...page.filter((session) => !known.has(session.sessionId))],
        live: mergeLive(current.live, page),
        sessionsHasMore: page.length === PAGE_SIZE,
      });
    } catch (err) {
      actions.toast(errorText(err, t), 'error');
    } finally {
      loadingMore = false;
      renderList();
    }
  }

  renderChrome();
  renderList();

  const unsubscribe = store.subscribe((state, prev) => {
    if (destroyed) return;
    if (state.meta !== prev.meta || state.auth !== prev.auth || state.connection !== prev.connection) renderChrome();
    if (state.sessions !== prev.sessions || state.live !== prev.live || state.pending !== prev.pending
      || state.currentSessionId !== prev.currentSessionId || state.sessionsReady !== prev.sessionsReady
      || state.sessionsHasMore !== prev.sessionsHasMore) {
      renderList();
    }
  });

  const timeTimer = setInterval(() => {
    if (!destroyed) renderList();
  }, TIME_REFRESH_MS);

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearInterval(timeTimer);
      unsubscribe();
      clear(container);
    },
  };
}
