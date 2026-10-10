/**
 * Side sheets (right column on desktop, bottom sheet on mobile): session details, capabilities, context usage,
 * background tasks and settings. Also the session dialogs shared with the sidebar (rename, tag, delete) and the
 * session-list refresh helper.
 */

import { h, clear, icon } from '../dom.js';
import { ApiError, errorText } from '../api.js';
import { getLocale, onLocaleChange, setLocale } from '../i18n.js';
import { THEMES, FONT_SIZES } from '../store.js';
import { confirmDialog, hasOpenDialog, lockScroll, openDialog } from './dialog.js';
import { formatClock, mergeLive, sessionTitle } from './sidebar-model.js';
import { mountRuntimePanel } from './runtime-panels.js';
import { mountDeveloperPanel } from './devtools.js';
import { mountAccountSection, planLabel, providerLabel } from './account.js';
import { newerUnattended, normalizeUnattended, unattendedSwitch } from '../unattended.js';

const PANEL_NAMES = ['session', 'capabilities', 'context', 'tasks', 'settings', 'runtime', 'developer'];
/** Task states that can still produce output. */
const RUNNING_TASK_STATES = ['running', 'pending', 'paused'];
/** Task kinds that have a shell-style output (agents do not). */
const OUTPUT_TASK_TYPES = ['local_bash', 'monitor'];
const TASK_OUTPUT_REFRESH_MS = 2000;
const MCP_POLL_MS = 3000;
const MCP_POLL_LIMIT_MS = 5 * 60 * 1000;
/** Permission overrides for an MCP server (POST /mcp, action permission-mode), in the order the select lists them. */
const MCP_OVERRIDES = ['default', 'auto', ''];
const LOCALES = [{ value: 'en', label: 'English' }, { value: 'zh-CN', label: '简体中文' }];
const SESSION_PAGE = 100;
/** How a held plugin reload may change the language server tools (cacheImpact.lspToolChange of the reload answer). */
const LSP_TOOL_CHANGES = ['adds', 'may-add', 'removes', 'may-remove'];

/**
 * One MCP server's sign-in as this page runs it: the link, whether the runtime expects the pasted callback address,
 * the field's draft and the request in flight.
 * @typedef {{startedAt: number, authUrl: string, callbackExpected: boolean, draft: string, busy: boolean, error: string}} McpFlow
 */

/**
 * @param {string} value
 * @returns {boolean} true for an http(s) address of at most 4 096 characters
 */
function isHttpUrl(value) {
  if (value === '' || value.length > 4096) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** @type {{ name: string, close: () => void } | null} */
let activeSheet = null;

/**
 * Load the first page of the session list into the store (keeps the length already shown, at least 100).
 * @param {{ api: { get(path: string): Promise<any> }, store: any }} options
 * @returns {Promise<void>}
 */
export async function refreshSessionList({ api, store }) {
  const shown = store.get().sessions.length;
  const limit = Math.min(500, Math.max(SESSION_PAGE, shown));
  const data = await api.get(`/api/sessions?limit=${limit}&offset=0`);
  const page = Array.isArray(data.sessions) ? data.sessions : [];
  store.set({
    sessions: page,
    live: mergeLive(store.get().live, page),
    sessionsHasMore: page.length === limit,
    sessionsReady: true,
  });
}

/**
 * Copy text to the clipboard. Falls back to a selection-based copy where the async clipboard API is unavailable
 * (plain HTTP on a LAN address is not a secure context).
 * @param {string} text
 * @returns {Promise<void>}
 */
async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Permission denied: try the selection fallback below.
    }
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.className = 'sr-only';
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('Copy failed');
}

/**
 * @param {string} message
 * @returns {HTMLElement}
 */
function note(message) {
  return h('p', { class: 'sheet-note', text: message });
}

/**
 * @param {string} title
 * @param {...any} children
 * @returns {HTMLElement}
 */
function section(title, ...children) {
  return h('section', { class: 'sheet-section' }, h('h3', { class: 'sheet-section-title', text: title }), children);
}

/**
 * A section that `openPanel(name, deps, {section})` can scroll to. `key` names it; the title is shown as usual.
 * @param {string} key
 * @param {string} title
 * @param {...any} children
 * @returns {HTMLElement}
 */
function keyedSection(key, title, ...children) {
  const el = section(title, ...children);
  el.dataset.section = key;
  return el;
}

/**
 * @param {string} label
 * @param {unknown} value
 * @param {{mono?: boolean, copy?: (value: string) => void}} [options]
 * @returns {HTMLElement}
 */
function kvRow(label, value, { mono = false, copy } = {}) {
  const text = value == null || value === '' ? '—' : String(value);
  return h('div', { class: 'kv-row' },
    h('span', { class: 'kv-label', text: label }),
    h('span', { class: ['kv-value', mono ? 'mono' : ''], attrs: { title: text } }, text),
    copy && text !== '—' ? h('button', {
      class: 'btn btn-ghost btn-icon btn-sm',
      attrs: { type: 'button', 'aria-label': copy.label },
      on: { click: () => copy.run(text) },
    }, icon('copy')) : null);
}

/**
 * @param {string} label
 * @param {string} tone
 * @returns {HTMLElement}
 */
function statusChip(label, tone = 'muted') {
  return h('span', { class: `chip chip-${tone}`, text: label });
}

/**
 * Segmented control (single choice).
 * @param {string} label
 * @param {Array<{value: string, label: string}>} options
 * @param {string} current
 * @param {(value: string) => void} onPick
 */
function segmented(label, options, current, onPick) {
  const buttons = options.map((option) => h('button', {
    class: 'seg-btn',
    attrs: { type: 'button', 'aria-pressed': String(option.value === current), 'data-value': option.value },
    on: { click: () => onPick(option.value) },
    text: option.label,
  }));
  const group = h('div', { class: 'seg', attrs: { role: 'group', 'aria-label': label } }, buttons);
  return {
    el: group,
    sync(value) {
      for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.value === value));
    },
  };
}

/**
 * @param {string} label
 * @param {boolean} checked
 * @param {(next: boolean) => void} onChange
 */
function switchControl(label, checked, onChange) {
  const button = h('button', {
    class: 'switch',
    attrs: { type: 'button', role: 'switch', 'aria-checked': String(checked), 'aria-label': label },
    on: { click: () => onChange(button.getAttribute('aria-checked') !== 'true') },
  }, h('span', { class: 'switch-thumb', attrs: { 'aria-hidden': 'true' } }));
  return {
    el: button,
    sync(value) {
      button.setAttribute('aria-checked', String(value));
    },
  };
}

/**
 * Rename a session (PATCH title). Calls onDone after a successful save.
 * @param {{api: {patch(path: string, body: unknown): Promise<any>}, t: Function, sessionId: string,
 *   currentTitle?: string, onDone?: () => void}} options
 */
export function renameSessionDialog({ api, t, sessionId, currentTitle = '', onDone }) {
  const input = h('input', {
    class: 'input',
    attrs: { type: 'text', maxlength: 200, autocomplete: 'off', 'aria-label': t('shell.rename.label') },
  });
  input.value = currentTitle;
  const error = h('p', { class: 'form-error', attrs: { role: 'alert' } });
  error.hidden = true;
  /** @type {{close: () => void} | null} */
  let handle = null;
  const body = h('div', { class: 'form-stack' },
    h('label', { class: 'field' },
      h('span', { class: 'field-label', text: t('shell.rename.label') }),
      input),
    error);
  handle = openDialog({
    title: t('shell.rename.title'),
    body,
    size: 'sm',
    actions: [
      { label: t('common.cancel'), kind: 'secondary' },
      {
        label: t('common.save'),
        kind: 'primary',
        keepOpen: true,
        onClick: async () => {
          const title = input.value.trim();
          if (!title) {
            error.textContent = t('shell.rename.empty');
            error.hidden = false;
            input.focus();
            return;
          }
          try {
            await api.patch(`/api/sessions/${encodeURIComponent(sessionId)}`, { title });
            handle?.close();
            onDone?.();
          } catch (err) {
            error.textContent = errorText(err, t);
            error.hidden = false;
          }
        },
      },
    ],
  });
  input.select();
  return handle;
}

/**
 * Set or clear a session tag (PATCH tag). Calls onDone after a successful save.
 * @param {{api: {patch(path: string, body: unknown): Promise<any>}, t: Function, sessionId: string,
 *   currentTag?: string, onDone?: () => void}} options
 */
export function tagSessionDialog({ api, t, sessionId, currentTag = '', onDone }) {
  const input = h('input', {
    class: 'input',
    attrs: {
      type: 'text',
      maxlength: 64,
      autocomplete: 'off',
      placeholder: t('shell.tag.placeholder'),
      'aria-label': t('shell.tag.label'),
    },
  });
  input.value = currentTag;
  const error = h('p', { class: 'form-error', attrs: { role: 'alert' } });
  error.hidden = true;
  /** @type {{close: () => void} | null} */
  let handle = null;
  const body = h('div', { class: 'form-stack' },
    h('label', { class: 'field' },
      h('span', { class: 'field-label', text: t('shell.tag.label') }),
      input),
    h('p', { class: 'field-hint', text: t('shell.tag.hint') }),
    error);
  handle = openDialog({
    title: t('shell.tag.title'),
    body,
    size: 'sm',
    actions: [
      { label: t('common.cancel'), kind: 'secondary' },
      {
        label: t('common.save'),
        kind: 'primary',
        keepOpen: true,
        onClick: async () => {
          const tag = input.value.trim();
          try {
            await api.patch(`/api/sessions/${encodeURIComponent(sessionId)}`, { tag: tag || null });
            handle?.close();
            onDone?.();
          } catch (err) {
            error.textContent = errorText(err, t);
            error.hidden = false;
          }
        },
      },
    ],
  });
  input.select();
  return handle;
}

/**
 * Confirm and delete a persisted (not live) session. Clears the selection when it was the current session.
 * @param {{
 *   api: {del(path: string): Promise<any>},
 *   store: any,
 *   t: Function,
 *   actions: {selectSession(id: string | null): unknown, toast(message: string, level?: string): unknown},
 *   sessionId: string,
 *   title?: string,
 *   onDone?: () => void,
 * }} options
 * @returns {Promise<boolean>} true when the session was deleted
 */
export async function deleteSessionFlow({ api, store, t, actions, sessionId, title = '', onDone }) {
  const confirmed = await confirmDialog({
    title: t('shell.delete.title'),
    message: t('shell.delete.message', { title: title || t('shell.untitled') }),
    danger: true,
    confirmLabel: t('shell.delete.confirm'),
  });
  if (!confirmed) return false;
  try {
    await api.del(`/api/sessions/${encodeURIComponent(sessionId)}`);
  } catch (err) {
    actions.toast(errorText(err, t), 'error');
    return false;
  }
  const state = store.get();
  store.set({ sessions: state.sessions.filter((session) => session.sessionId !== sessionId) });
  if (state.currentSessionId === sessionId) actions.selectSession(null);
  actions.toast(t('shell.delete.done'), 'success');
  onDone?.();
  return true;
}

/** Close the open side sheet, if any. */
export function closePanel() {
  activeSheet?.close();
}

/** @returns {boolean} true while a side sheet is open */
export function hasOpenSheet() {
  return activeSheet !== null;
}

/**
 * A chooser for one folder inside the workspace roots (GET /api/fs/dirs). `onPick` gets the folder the user is browsing
 * when "Use this folder" is pressed.
 * @param {{api: any, t: (key: string, vars?: Record<string, unknown>) => string, start: string | null,
 *   onPick: (path: string) => void}} options
 */
export function pickFolderDialog({ api, t, start, onPick }) {
  /** @type {string | null} */
  let current = null;
  /** @type {string | null} */
  let parent = null;
  /** @type {Array<{name: string, path: string, isProject: boolean}>} */
  let entries = [];
  let token = 0;
  const pathEl = h('span', { class: 'dir-path mono' });
  const errorEl = h('p', { class: 'form-error', attrs: { role: 'alert' } });
  errorEl.hidden = true;
  const listEl = h('ul', { class: 'dir-list', attrs: { 'aria-label': t('shell.session.pickFolder') } });
  const upButton = h('button', {
    class: 'btn btn-ghost btn-icon btn-sm dir-up',
    attrs: { type: 'button', 'aria-label': t('shell.newSession.up') },
    on: { click: () => { if (parent !== null) load(parent); } },
  }, icon('chevron-right'));

  function render() {
    pathEl.textContent = current ?? t('shell.newSession.roots');
    pathEl.title = current ?? '';
    upButton.disabled = parent === null;
    clear(listEl);
    if (entries.length === 0) {
      listEl.append(h('li', { class: 'dir-empty', text: current === null ? t('shell.newSession.noRoots') : t('shell.newSession.noFolders') }));
      return;
    }
    for (const entry of entries) {
      listEl.append(h('li', { class: 'dir-item' }, h('button', {
        class: 'dir-row',
        attrs: { type: 'button', title: entry.path },
        on: { click: () => load(entry.path) },
      },
      icon('folder'),
      h('span', { class: 'dir-name', text: entry.name }),
      entry.isProject ? h('span', { class: 'badge badge-accent', text: t('shell.newSession.project') }) : null,
      icon('chevron-right'))));
    }
  }

  /** @param {string | null} path */
  async function load(path) {
    const request = ++token;
    try {
      const query = path ? `?path=${encodeURIComponent(path)}` : '';
      const data = await api.get(`/api/fs/dirs${query}`);
      if (request !== token) return;
      current = typeof data.path === 'string' ? data.path : null;
      parent = typeof data.parent === 'string' ? data.parent : null;
      entries = Array.isArray(data.entries) ? data.entries : [];
      errorEl.hidden = true;
    } catch (err) {
      if (request !== token) return;
      errorEl.textContent = errorText(err, t);
      errorEl.hidden = false;
    }
    render();
  }

  const body = h('div', { class: 'dir-browser' },
    h('div', { class: 'dir-toolbar' }, upButton, pathEl),
    listEl,
    errorEl);
  /** @type {{close: () => void} | null} */
  let handle = null;
  handle = openDialog({
    title: t('shell.session.pickFolder'),
    body,
    size: 'md',
    actions: [
      { label: t('common.cancel'), kind: 'secondary' },
      {
        label: t('shell.session.useFolder'),
        kind: 'primary',
        keepOpen: true,
        onClick: () => {
          if (current === null) return;
          onPick(current);
          handle?.close();
        },
      },
    ],
  });
  load(start);
  return handle;
}

/**
 * The session settings the runtime applies to the live query (or keeps for the next open): additional folders, the
 * main agent, the fallback model and browser tools. Every change posts the settings and reports the runtime's answer.
 * @param {{api: any, store: any, t: (key: string, vars?: Record<string, unknown>) => string, actions: any,
 *   sessionId: string}} ctx
 * @returns {{el: HTMLElement, dispose: () => void}}
 */
function sessionSettings({ api, store, t, actions, sessionId }) {
  const el = h('div', { class: 'session-settings' });
  let busy = false;
  let disposed = false;
  let restartRequired = false;
  /** @type {any} */
  let caps = store.get().capabilities[sessionId] ?? null;
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/settings`;

  const profile = () => store.get().meta?.profile ?? store.get().auth?.profile ?? 'read';
  const liveInfo = () => store.get().live[sessionId] ?? null;

  /** @param {unknown} err */
  function settingsFailure(err) {
    if (err instanceof ApiError && err.code === 'CONFLICT') return t('shell.session.busy');
    return errorText(err, t);
  }

  /**
   * @param {Record<string, unknown>} body
   * @param {string} message shown when the runtime accepted the change
   */
  async function post(body, message) {
    busy = true;
    render();
    try {
      const answer = await api.post(path, body);
      if (disposed) return;
      if (answer?.live) store.set({ live: { ...store.get().live, [sessionId]: answer.live } });
      if (typeof answer?.restartRequired === 'boolean') restartRequired = answer.restartRequired;
      actions.toast(message, 'success');
    } catch (err) {
      if (!disposed) actions.toast(settingsFailure(err), 'error');
    } finally {
      busy = false;
      if (!disposed) render();
    }
  }

  /** @param {string[]} next */
  async function changeFolders(next) {
    if (!(await actions.confirmEndBackground(sessionId))) return;
    await post({ additionalDirectories: next }, t('shell.session.foldersSaved'));
  }

  /** @param {string} value */
  function changeAgent(value) {
    const name = value.trim();
    return post({ agent: name === '' ? null : name },
      name === '' ? t('shell.session.agentCleared') : t('shell.session.agentSet', { agent: name }));
  }

  /** @param {string} value */
  function changeFallback(value) {
    return post({ fallbackModel: value === '' ? null : value },
      value === '' ? t('shell.session.fallbackCleared') : t('shell.session.fallbackSet', { model: value }));
  }

  /** @param {boolean} next */
  function changeBrowser(next) {
    return post({ browserTools: next },
      next ? t('shell.session.browserOn') : t('shell.session.browserOff'));
  }

  function addFolder() {
    const live = liveInfo();
    const current = Array.isArray(live?.additionalDirectories) ? live.additionalDirectories : [];
    const summary = store.get().sessions.find((session) => session.sessionId === sessionId);
    pickFolderDialog({
      api,
      t,
      start: live?.cwd || summary?.cwd || null,
      onPick: (picked) => {
        if (current.includes(picked)) {
          actions.toast(t('shell.session.folderListed'), 'info');
          return;
        }
        changeFolders([...current, picked]);
      },
    });
  }

  function render() {
    if (disposed) return;
    clear(el);
    const live = liveInfo();
    const readOnly = profile() === 'read';
    const locked = readOnly || busy || !live;
    const note = !live
      ? h('p', { class: 'sheet-note', text: t('shell.session.openToEdit') })
      : readOnly ? h('p', { class: 'sheet-note', text: t('shell.caps.readOnly') }) : null;

    const dirs = Array.isArray(live?.additionalDirectories) ? live.additionalDirectories : [];
    const folders = keyedSection('directories', t('shell.session.folders'),
      note,
      dirs.length === 0
        ? h('p', { class: 'sheet-note', text: t('shell.session.noFolders') })
        : h('ul', { class: 'item-list' }, dirs.map((dir) => h('li', { class: 'item item-compact' },
          h('span', { class: 'item-name mono', text: dir, attrs: { title: dir } }),
          h('button', {
            class: 'btn btn-ghost btn-icon btn-sm',
            attrs: { type: 'button', 'aria-label': t('shell.session.removeFolder', { path: dir }), disabled: locked },
            on: { click: () => changeFolders(dirs.filter((item) => item !== dir)) },
          }, icon('x'))))),
      h('div', { class: 'sheet-inline' },
        h('button', {
          class: 'btn btn-secondary btn-sm',
          attrs: { type: 'button', disabled: locked },
          on: { click: () => addFolder() },
        }, icon('plus'), h('span', { text: t('shell.session.addFolder') }))));

    const agents = Array.isArray(caps?.agents)
      ? caps.agents.map((agent) => agent?.name).filter((name) => typeof name === 'string' && name !== '')
      : null;
    const agentNow = typeof live?.agent === 'string' ? live.agent : '';
    let agentControl;
    if (agents) {
      const names = [...new Set([...agents, ...(agentNow ? [agentNow] : [])])];
      const select = h('select', {
        class: 'select',
        attrs: { 'aria-label': t('shell.session.agent'), disabled: locked },
        on: { change: (event) => changeAgent(/** @type {HTMLSelectElement} */ (event.currentTarget).value) },
      }, [h('option', { attrs: { value: '' }, text: t('shell.session.noAgent') }),
        ...names.map((name) => h('option', { attrs: { value: name }, text: name }))]);
      select.value = agentNow;
      agentControl = select;
    } else {
      const input = h('input', {
        class: 'input mono',
        attrs: {
          type: 'text',
          maxlength: 200,
          autocomplete: 'off',
          spellcheck: false,
          placeholder: t('shell.session.agentPlaceholder'),
          'aria-label': t('shell.session.agent'),
          disabled: locked,
        },
        on: { keydown: (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            changeAgent(/** @type {HTMLInputElement} */ (event.currentTarget).value);
          }
        } },
      });
      input.value = agentNow;
      agentControl = h('div', { class: 'sheet-inline' }, input,
        h('button', {
          class: 'btn btn-secondary btn-sm',
          attrs: { type: 'button', disabled: locked },
          on: { click: () => changeAgent(input.value) },
        }, t('common.save')));
    }
    const agentSection = keyedSection('agent', t('shell.session.agent'),
      agentControl,
      h('p', { class: 'field-hint', text: t('shell.session.agentHint') }));

    const models = Array.isArray(caps?.models) ? caps.models : [];
    const fallbackNow = typeof live?.fallbackModel === 'string'
      ? live.fallbackModel
      : (store.get().meta?.defaults?.fallbackModel ?? '');
    const fallbackOptions = [h('option', { attrs: { value: '' }, text: t('shell.session.noFallback') })];
    const seen = new Set(['']);
    for (const model of models) {
      if (typeof model?.value !== 'string' || seen.has(model.value)) continue;
      seen.add(model.value);
      fallbackOptions.push(h('option', { attrs: { value: model.value }, text: model.displayName || model.value }));
    }
    if (fallbackNow && !seen.has(fallbackNow)) fallbackOptions.push(h('option', { attrs: { value: fallbackNow }, text: fallbackNow }));
    const fallbackSelect = h('select', {
      class: 'select',
      attrs: { 'aria-label': t('shell.session.fallback'), disabled: locked },
      on: { change: (event) => changeFallback(/** @type {HTMLSelectElement} */ (event.currentTarget).value) },
    }, fallbackOptions);
    fallbackSelect.value = fallbackNow;
    const fallbackSection = keyedSection('fallback', t('shell.session.fallback'),
      fallbackSelect,
      h('p', { class: 'field-hint', text: t('shell.session.fallbackHint') }),
      restartRequired && live
        ? h('div', { class: 'sheet-inline' },
          h('p', { class: 'sheet-note', text: t('shell.session.restartNote') }),
          h('button', {
            class: 'btn btn-primary btn-sm',
            attrs: { type: 'button', disabled: busy },
            on: { click: async () => {
              await actions.restartSession();
              restartRequired = false;
              if (!disposed) render();
            } },
          }, icon('refresh'), h('span', { text: t('shell.session.restart') })))
        : null);

    const features = store.get().meta?.features ?? {};
    const browserSection = features.browserTools === true && profile() === 'full'
      ? keyedSection('browser', t('shell.session.browser'),
        h('div', { class: 'settings-row' },
          h('span', { class: 'settings-label', text: t('shell.session.browserLabel') }),
          switchControl(t('shell.session.browser'), live?.browserTools === true, (next) => changeBrowser(next)).el))
      : null;

    el.append(...[folders, agentSection, fallbackSection, browserSection].filter(Boolean));
  }

  const unsubscribe = store.subscribe((state, prev) => {
    if (state.live !== prev.live || state.meta !== prev.meta || state.auth !== prev.auth) render();
  });
  // The capabilities carry the agent and model lists. Opening the panel reads them once, unless they are cached.
  if (!caps) {
    api.get(`/api/sessions/${encodeURIComponent(sessionId)}/capabilities`).then((fresh) => {
      if (disposed) return;
      caps = fresh;
      store.set({ capabilities: { ...store.get().capabilities, [sessionId]: fresh } });
      render();
    }, () => {});
  }
  render();
  return {
    el,
    dispose() {
      disposed = true;
      unsubscribe();
    },
  };
}

/**
 * @param {Record<string, any>} ctx
 * @returns {(() => void) | undefined}
 */
function sessionPanel({ body, api, store, t, actions, close, reload }) {
  const sessionId = store.get().currentSessionId;
  if (!sessionId) {
    body.appendChild(note(t('shell.panel.noSession')));
    return undefined;
  }
  const initial = store.get().sessions.find((session) => session.sessionId === sessionId) ?? { sessionId };
  const cwd = initial.cwd || store.get().live[sessionId]?.cwd || '';

  const titleInput = h('input', {
    class: 'input',
    attrs: {
      type: 'text',
      maxlength: 200,
      autocomplete: 'off',
      placeholder: sessionTitle(initial, t('shell.untitled')),
      'aria-label': t('shell.session.title'),
    },
  });
  titleInput.value = initial.customTitle ?? '';
  const tagInput = h('input', {
    class: 'input',
    attrs: {
      type: 'text',
      maxlength: 64,
      autocomplete: 'off',
      placeholder: t('shell.tag.placeholder'),
      'aria-label': t('shell.tag.label'),
    },
  });
  tagInput.value = initial.tag ?? '';

  /** @param {string} message @param {string} level */
  const reportError = (message, level) => actions.toast(message, level);

  async function saveTitle() {
    const title = titleInput.value.trim();
    if (!title) {
      reportError(t('shell.rename.empty'), 'warning');
      return;
    }
    try {
      await api.patch(`/api/sessions/${encodeURIComponent(sessionId)}`, { title });
      reportError(t('shell.session.saved'), 'success');
      await refreshSessionList({ api, store });
    } catch (err) {
      reportError(errorText(err, t), 'error');
    }
  }

  async function saveTag() {
    const tag = tagInput.value.trim();
    try {
      await api.patch(`/api/sessions/${encodeURIComponent(sessionId)}`, { tag: tag || null });
      reportError(t('shell.session.saved'), 'success');
      await refreshSessionList({ api, store });
    } catch (err) {
      reportError(errorText(err, t), 'error');
    }
  }

  const copy = (/** @type {string} */ label) => ({
    label,
    run: async (/** @type {string} */ value) => {
      try {
        await copyText(value);
        reportError(t('common.copied'), 'success');
      } catch {
        reportError(t('common.copyFailed'), 'error');
      }
    },
  });

  const runtimeEl = h('div', { class: 'kv-list' });
  const actionsEl = h('div', { class: 'sheet-actions' });

  function renderRuntime() {
    const state = store.get();
    const live = state.live[sessionId] ?? null;
    const defaults = state.meta?.defaults ?? {};
    const mode = live?.permissionMode ?? defaults.permissionMode ?? 'default';
    const effort = live?.effort ?? null;
    clear(runtimeEl);
    // Node.append turns a null argument into the text "null", so the optional rows are filtered out first.
    runtimeEl.append(...[
      kvRow(t('shell.session.state'), live ? t(`common.state.${live.state}`) : t('shell.session.notRunning')),
      kvRow(t('shell.session.model'), live?.model ?? defaults.model ?? null),
      kvRow(t('shell.session.mode'), t(`common.mode.${mode}`)),
      kvRow(t('shell.session.effort'), effort ? t(`common.effort.${effort}`) : t('common.effort.default')),
      live?.claudeCodeVersion ? kvRow(t('shell.session.version'), live.claudeCodeVersion, { mono: true }) : null,
    ].filter(Boolean));

    const profile = state.meta?.profile ?? state.auth?.profile ?? null;
    const canFork = profile !== 'read';
    const canDelete = profile === 'full' && !live;
    const canTerminal = state.meta?.features?.terminal === true && profile === 'full';
    clear(actionsEl);
    actionsEl.append(...[
      canFork ? actionButton(t('shell.session.fork'), 'fork', () => {
        close();
        actions.openFork();
      }) : null,
      canFork ? actionButton(t('shell.session.rewind'), 'rewind', () => {
        close();
        actions.openRewind();
      }) : null,
      canTerminal ? actionButton(t('shell.session.terminal'), 'terminal', () => {
        close();
        actions.openTerminal();
      }) : null,
      actionButton(t('shell.session.export'), 'download', () => actions.exportConversation(), { disabled: !live }),
      live ? null : note(t('shell.session.openToExport')),
      live && canFork ? actionButton(t('shell.session.closeLive'), 'stop', async () => {
        if (actions.confirmEndBackground && !(await actions.confirmEndBackground(sessionId))) return;
        try {
          await api.post(`/api/sessions/${encodeURIComponent(sessionId)}/close`, {});
        } catch (err) {
          reportError(errorText(err, t), 'error');
          return;
        }
        reportError(t('shell.session.closed'), 'success');
        // The sidebar state dot and the Delete availability come from the session list, so reload it now.
        refreshSessionList({ api, store }).catch((err) => reportError(errorText(err, t), 'error'));
      }) : null,
      canDelete ? actionButton(t('shell.session.delete'), 'trash', () => {
        deleteSessionFlow({
          api,
          store,
          t,
          actions,
          sessionId,
          title: sessionTitle(initial, t('shell.untitled')),
          onDone: () => close(),
        });
      }, { danger: true }) : null,
    ].filter(Boolean));
  }

  const settings = sessionSettings({ api, store, t, actions, sessionId });
  body.append(
    section(t('shell.session.name'),
      h('form', {
        class: 'form-stack',
        on: { submit: (event) => { event.preventDefault(); saveTitle(); } },
      },
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: t('shell.session.title') }), titleInput),
      h('div', { class: 'sheet-inline' },
        h('button', { class: 'btn btn-secondary btn-sm', attrs: { type: 'submit' } }, t('common.save')))),
      h('form', {
        class: 'form-stack',
        on: { submit: (event) => { event.preventDefault(); saveTag(); } },
      },
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: t('shell.session.tag') }), tagInput),
      h('div', { class: 'sheet-inline' },
        h('button', { class: 'btn btn-secondary btn-sm', attrs: { type: 'submit' } }, t('common.save'))))),
    section(t('shell.session.details'),
      kvRow(t('shell.session.directory'), cwd, { mono: true, copy: copy(t('shell.session.copyDirectory')) }),
      kvRow(t('shell.session.id'), sessionId, { mono: true, copy: copy(t('shell.session.copyId')) })),
    section(t('shell.session.runtime'), runtimeEl),
    settings.el,
    section(t('shell.session.actions'), actionsEl),
  );

  renderRuntime();

  const unsubscribe = store.subscribe((state, prev) => {
    if (state.currentSessionId !== prev.currentSessionId) {
      reload();
      return;
    }
    if (state.live !== prev.live || state.meta !== prev.meta) renderRuntime();
  });
  return () => {
    unsubscribe();
    settings.dispose();
  };
}

/**
 * Button used inside sheets.
 * @param {string} label
 * @param {string} iconName
 * @param {() => unknown} onClick
 * @param {{danger?: boolean}} [options]
 */
function actionButton(label, iconName, onClick, { danger = false, disabled = false } = {}) {
  return h('button', {
    class: ['btn', danger ? 'btn-danger' : 'btn-secondary', 'btn-block', 'sheet-action'],
    attrs: { type: 'button', disabled },
    on: { click: () => onClick() },
  }, icon(iconName), h('span', { text: label }));
}

/**
 * Localized label for a key, or `fallback` when the key has no translation.
 * @param {(key: string) => string} t
 * @param {string} key
 * @param {string} fallback
 * @returns {string}
 */
function labelOr(t, key, fallback) {
  const text = t(key);
  return text === key ? fallback : text;
}

/**
 * @param {string} status MCP server status
 * @returns {'success'|'danger'|'muted'|'warning'}
 */
function mcpTone(status) {
  if (status === 'connected') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'disabled') return 'muted';
  return 'warning';
}

/**
 * @param {string} message
 * @param {(() => void) | null} onRetry
 * @param {(key: string) => string} t
 * @returns {HTMLElement}
 */
function errorBlock(message, onRetry, t) {
  return h('div', { class: 'sheet-error', attrs: { role: 'alert' } },
    h('p', { text: message }),
    onRetry ? h('button', { class: 'btn btn-secondary btn-sm', attrs: { type: 'button' }, on: { click: onRetry } },
      icon('refresh'), h('span', { text: t('common.retry') })) : null);
}

/** @param {Record<string, any>} ctx */
function capabilitiesPanel({ body, api, store, t, actions, reload }) {
  const sessionId = store.get().currentSessionId;
  if (!sessionId) {
    body.appendChild(note(t('shell.panel.noSession')));
    return undefined;
  }
  let caps = store.get().capabilities[sessionId] ?? null;
  let skills = null;
  let loading = true;
  let failure = '';
  /** A reload is in flight: the reload buttons wait for it. */
  let reloading = false;
  /** An output style change is in flight: the select waits for it. */
  let styleBusy = false;
  const base = `/api/sessions/${encodeURIComponent(sessionId)}`;
  /** The MCP sign-ins this page started, by server name (see startAuth). @type {Map<string, McpFlow>} */
  const flows = new Map();
  /** Permission overrides picked in this page view: the runtime does not report them back. */
  const overrides = new Map();
  /** The server whose control takes the focus after the next render, or ''. */
  let focusTarget = '';
  let pollTimer = 0;
  let polling = false;
  let disposed = false;
  const content = h('div', { class: 'caps' });
  body.appendChild(content);

  function setCaps(next) {
    caps = next;
    store.set({ capabilities: { ...store.get().capabilities, [sessionId]: next } });
  }

  async function load() {
    loading = true;
    failure = '';
    render();
    try {
      const [fresh, detail] = await Promise.all([
        api.get(`/api/sessions/${encodeURIComponent(sessionId)}/capabilities`),
        api.get(`/api/sessions/${encodeURIComponent(sessionId)}`).catch(() => null),
      ]);
      setCaps(fresh);
      skills = Array.isArray(detail?.init?.skills) ? detail.init.skills : null;
    } catch (err) {
      failure = errorText(err, t);
    } finally {
      loading = false;
      render();
    }
  }

  async function mcpAction(server, request) {
    try {
      const result = await api.post(`${base}/mcp`, { server, ...request });
      if (disposed) return;
      setCaps({ ...caps, mcpServers: Array.isArray(result.mcpServers) ? result.mcpServers : caps.mcpServers });
      render();
    } catch (err) {
      if (!disposed) actions.toast(errorText(err, t), 'error');
    }
  }

  /** @param {string} name */
  function serverNamed(name) {
    return (Array.isArray(caps?.mcpServers) ? caps.mcpServers : []).find((server) => server.name === name) ?? null;
  }

  /** @param {Record<string, any> | null} value */
  function mcpStatusKey(value) {
    return (Array.isArray(value?.mcpServers) ? value.mcpServers : [])
      .map((server) => `${server.name}=${server.status}`)
      .join('|');
  }

  /** Why the MCP controls cannot act, or '' when they can: a read-only viewer, or a session that is not live. */
  function mcpLockReason() {
    const { live, readOnly } = controlsOf(store.get());
    if (readOnly) return t('shell.caps.readOnly');
    if (!live) return t('shell.mcp.openToChange');
    return '';
  }

  function ensurePolling() {
    if (pollTimer || disposed || flows.size === 0) return;
    pollTimer = setInterval(pollFlows, MCP_POLL_MS);
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = 0;
  }

  /**
   * Reads the capabilities and ends the sign-ins whose server connected or that ran out of time. Redraws only when a
   * server status or a flow changed, so the paste field keeps its focus while the page waits.
   */
  async function pollFlows() {
    if (polling || disposed) return;
    polling = true;
    /** @type {Record<string, any> | null} */
    let fresh = null;
    try {
      fresh = await api.get(`${base}/capabilities`);
    } catch {
      // Read again on the next tick; the time limit below still ends the flow.
    }
    polling = false;
    if (disposed) return;
    const before = mcpStatusKey(caps);
    if (fresh) setCaps(fresh);
    let changed = mcpStatusKey(caps) !== before;
    const now = Date.now();
    for (const [name, flow] of [...flows]) {
      if (fresh && serverNamed(name)?.status === 'connected') {
        flows.delete(name);
        actions.toast(t('shell.mcp.connected', { server: name }), 'success');
        changed = true;
      } else if (now - flow.startedAt >= MCP_POLL_LIMIT_MS) {
        flows.delete(name);
        actions.toast(t('shell.mcp.timeout', { server: name }), 'warning');
        changed = true;
      }
    }
    if (flows.size === 0) stopPolling();
    if (changed) render();
  }

  /**
   * Starts the server's sign-in (POST /mcp/auth, action start). The link opens in a new tab. When the runtime expects
   * the address the browser lands on, the row gets a field for it. Every open sign-in is followed until the server
   * connects or five minutes pass.
   * @param {string} name
   */
  async function startAuth(name) {
    if (disposed || flows.has(name)) return;
    /** @type {McpFlow} */
    const flow = { startedAt: Date.now(), authUrl: '', callbackExpected: false, draft: '', busy: true, error: '' };
    flows.set(name, flow);
    render();
    try {
      const answer = await api.post(`${base}/mcp/auth`, { server: name, action: 'start' });
      if (disposed || flows.get(name) !== flow) return;
      if (answer?.requiresUserAction === false) {
        flows.delete(name);
        actions.toast(t('shell.mcp.nothingToDo', { server: name }), 'info');
        await refreshCaps();
        return;
      }
      flow.authUrl = typeof answer?.authUrl === 'string' ? answer.authUrl : '';
      flow.callbackExpected = answer?.callbackExpected === true;
      flow.busy = false;
      focusTarget = name;
      ensurePolling();
    } catch (err) {
      if (disposed) return;
      flows.delete(name);
      actions.toast(errorText(err, t), 'error');
    }
    if (!disposed) render();
  }

  /** @param {string} name */
  function cancelFlow(name) {
    flows.delete(name);
    if (flows.size === 0) stopPolling();
    render();
  }

  /**
   * Sends the address the browser landed on (POST /mcp/auth, action callback). The flow ends when the server connects.
   * @param {string} name
   */
  async function submitCallback(name) {
    const flow = flows.get(name);
    if (!flow || flow.busy) return;
    const value = flow.draft.trim();
    if (!isHttpUrl(value)) {
      flow.error = t('shell.mcp.badCallback');
      focusTarget = name;
      render();
      return;
    }
    flow.busy = true;
    flow.error = '';
    render();
    try {
      await api.post(`${base}/mcp/auth`, { server: name, action: 'callback', callbackUrl: value });
      if (disposed || flows.get(name) !== flow) return;
      flow.draft = '';
      pollFlows();
    } catch (err) {
      if (disposed || flows.get(name) !== flow) return;
      flow.error = errorText(err, t);
    }
    if (disposed || flows.get(name) !== flow) return;
    flow.busy = false;
    focusTarget = name;
    render();
  }

  /**
   * Forgets the server's stored sign-in (POST /mcp/auth, action clear), after the user confirms.
   * @param {string} name
   */
  async function clearAuth(name) {
    const confirmed = await confirmDialog({
      title: t('shell.mcp.clearTitle', { server: name }),
      message: t('shell.mcp.clearMessage', { server: name }),
      danger: true,
      confirmLabel: t('shell.mcp.clearConfirm'),
      cancelLabel: t('common.cancel'),
    });
    if (!confirmed || disposed) return;
    try {
      await api.post(`${base}/mcp/auth`, { server: name, action: 'clear' });
      if (disposed) return;
      flows.delete(name);
      actions.toast(t('shell.mcp.cleared', { server: name }), 'success');
      await refreshCaps();
    } catch (err) {
      if (!disposed) actions.toast(errorText(err, t), 'error');
    }
  }

  /**
   * Pins the server's permission override (POST /mcp, action permission-mode); '' clears it. The runtime only tightens
   * bypass and auto modes with it, and does not report it back, so the select keeps the value picked here.
   * @param {string} name
   * @param {string} mode
   */
  async function setOverride(name, mode) {
    const before = overrides.get(name) ?? '';
    overrides.set(name, mode);
    try {
      const answer = await api.post(`${base}/mcp`, {
        server: name,
        action: 'permission-mode',
        mode: mode === '' ? null : mode,
      });
      if (disposed) return;
      if (Array.isArray(answer?.mcpServers)) setCaps({ ...caps, mcpServers: answer.mcpServers });
      if (typeof answer?.warning === 'string' && answer.warning !== '') {
        actions.toast(answer.warning, 'warning');
      } else {
        actions.toast(t('shell.mcp.overrideSet', { server: name, mode: t(`shell.mcp.override.${mode || 'none'}`) }),
          'success');
      }
    } catch (err) {
      if (disposed) return;
      overrides.set(name, before);
      actions.toast(errorText(err, t), 'error');
    }
    if (!disposed) render();
  }

  /** Reads the capabilities again and redraws. */
  async function refreshCaps() {
    const fresh = await api.get(`${base}/capabilities`);
    if (disposed) return;
    setCaps(fresh);
    render();
  }

  /**
   * What the controls depend on: the session's live info (for trust) and whether the viewer may only read.
   * @param {Record<string, any>} state
   */
  function controlsOf(state) {
    const live = state.live?.[sessionId] ?? null;
    const profile = state.auth?.profile ?? state.meta?.profile ?? 'full';
    return { live, readOnly: profile === 'read', trusted: live?.trusted === true };
  }

  /** @param {Record<string, any>} state */
  function controlKey(state) {
    const { live, readOnly, trusted } = controlsOf(state);
    return `${Boolean(live)}|${trusted}|${readOnly}`;
  }

  /**
   * Runs one reload. Skills and output styles apply at once. The runtime holds a plugin reload when applying it would
   * change the tools the prompt cache depends on: the user is asked first, and confirming repeats the reload with force.
   * @param {'plugins'|'skills'|'output-styles'} what
   * @param {boolean} [force]
   */
  async function reloadWhat(what, force = false) {
    reloading = true;
    render();
    try {
      const answer = await api.post(`/api/sessions/${encodeURIComponent(sessionId)}/reload`,
        force ? { what, force: true } : { what });
      if (answer?.held === true) {
        reloading = false;
        render();
        const confirmed = await confirmDialog({
          title: t('shell.caps.heldTitle'),
          message: heldMessage(answer.cacheImpact),
          confirmLabel: t('shell.caps.reloadAnyway'),
          cancelLabel: t('common.cancel'),
        });
        if (confirmed) await reloadWhat('plugins', true);
        return;
      }
      actions.toast(t('shell.caps.reloaded'), 'success');
      await load();
    } catch (err) {
      actions.toast(errorText(err, t), 'error');
    } finally {
      reloading = false;
      render();
    }
  }

  /**
   * What a held plugin reload would change. Names come from plugins, so they are shown as text only.
   * @param {{mcpServersAdded?: unknown, mcpServersRemoved?: unknown, lspToolChange?: unknown} | null | undefined} impact
   * @returns {HTMLElement}
   */
  function heldMessage(impact) {
    const names = (value) => (Array.isArray(value) ? value.filter((name) => typeof name === 'string') : []);
    const added = names(impact?.mcpServersAdded);
    const removed = names(impact?.mcpServersRemoved);
    const lsp = typeof impact?.lspToolChange === 'string' && LSP_TOOL_CHANGES.includes(impact.lspToolChange)
      ? impact.lspToolChange : '';
    return h('div', { class: 'held-reload' },
      h('p', { class: 'dialog-text', text: t('shell.caps.heldText') }),
      added.length > 0 ? heldNames(t('shell.caps.heldAdded'), added) : null,
      removed.length > 0 ? heldNames(t('shell.caps.heldRemoved'), removed) : null,
      lsp ? h('p', { class: 'dialog-text', text: t(`shell.caps.lsp.${lsp}`) }) : null);
  }

  /**
   * @param {string} label
   * @param {string[]} items
   */
  function heldNames(label, items) {
    return h('div', null,
      h('p', { class: 'sheet-note', text: label }),
      h('ul', { class: 'item-list' }, items.map((item) => h('li', { class: 'item mono', text: item }))));
  }

  /**
   * Sets the output style of the live session. The select is disabled while the request runs. A refusal is a toast,
   * and the select then shows the style still in force.
   * @param {string} style
   */
  async function changeStyle(style) {
    if (!caps || !style || styleBusy) return;
    styleBusy = true;
    render();
    try {
      const result = await api.post(`/api/sessions/${encodeURIComponent(sessionId)}/output-style`, { style });
      const applied = typeof result?.outputStyle === 'string' ? result.outputStyle : style;
      setCaps({
        ...caps,
        outputStyle: applied,
        availableOutputStyles: Array.isArray(result?.availableOutputStyles)
          ? result.availableOutputStyles
          : caps.availableOutputStyles,
      });
      actions.toast(t('shell.caps.styleSet', { style: applied }), 'success');
    } catch (err) {
      actions.toast(errorText(err, t), 'error');
    } finally {
      styleBusy = false;
      render();
    }
  }

  /**
   * The output style select. Changing the style needs a live session in a trusted folder; otherwise the select is
   * disabled and a note says what to do.
   * @param {string[]} styles
   * @returns {HTMLElement}
   */
  function styleControl(styles) {
    const { live, readOnly, trusted } = controlsOf(store.get());
    const current = typeof caps?.outputStyle === 'string' ? caps.outputStyle : '';
    const offered = styles.filter((style) => typeof style === 'string' && style !== '');
    const options = [];
    if (current === '') options.push(h('option', { attrs: { value: '' }, text: t('shell.caps.styleUnset') }));
    else if (!offered.includes(current)) options.push(h('option', { attrs: { value: current }, text: current }));
    for (const style of offered) options.push(h('option', { attrs: { value: style }, text: style }));
    const select = h('select', {
      class: 'select',
      attrs: { 'aria-label': t('shell.caps.outputStyle') },
      on: { change: (event) => changeStyle(/** @type {HTMLSelectElement} */ (event.target).value) },
    }, options);
    select.value = current;
    select.disabled = !live || !trusted || readOnly || styleBusy || offered.length === 0;
    let reason = '';
    if (readOnly) reason = t('shell.caps.readOnly');
    else if (!live) reason = t('shell.caps.styleOpen');
    else if (!trusted) reason = t('shell.caps.styleTrust');
    else if (offered.length === 0) reason = t('shell.caps.noStyles');
    return h('div', { class: 'sheet-inline' }, select, reason ? note(reason) : null);
  }

  /** The reload buttons. They need a live session the viewer may act on, and wait while a reload runs. */
  function reloadSection() {
    const { live, readOnly } = controlsOf(store.get());
    const enabled = Boolean(live) && !readOnly && !reloading;
    let reason = '';
    if (readOnly) reason = t('shell.caps.readOnly');
    else if (!live) reason = t('shell.caps.openToReload');
    const targets = [['plugins', 'shell.caps.reloadPlugins'], ['skills', 'shell.caps.reloadSkills'],
      ['output-styles', 'shell.caps.reloadStyles']];
    const buttons = targets.map(([what, labelKey]) => h('button', {
      class: 'btn btn-secondary btn-sm',
      attrs: { type: 'button' },
      disabled: !enabled,
      on: { click: () => reloadWhat(what) },
    }, icon('refresh'), h('span', { text: t(labelKey) })));
    return section(t('shell.caps.reload'),
      reason ? note(reason) : null,
      h('div', { class: 'sheet-inline' }, buttons));
  }

  /**
   * The sign-in in progress for one server: the link, the field for the address the browser lands on (when the runtime
   * expects it) and the wait note.
   * @param {string} name
   * @param {McpFlow} flow
   * @param {boolean} locked
   */
  function authFlow(name, flow, locked) {
    const paste = flow.callbackExpected
      ? h('input', {
        class: 'input mono',
        attrs: {
          type: 'text',
          autocomplete: 'off',
          autocapitalize: 'none',
          spellcheck: false,
          placeholder: t('shell.mcp.pastePlaceholder'),
          'aria-label': t('shell.mcp.pasteLabel'),
          disabled: flow.busy || locked,
          'data-mcp-focus': name,
        },
        on: {
          input: (event) => {
            flow.draft = /** @type {HTMLInputElement} */ (event.currentTarget).value;
          },
          keydown: (event) => {
            if (event.key === 'Enter' && !event.isComposing) {
              event.preventDefault();
              submitCallback(name);
            }
          },
        },
      })
      : null;
    if (paste) paste.value = flow.draft;
    return h('div', { class: 'mcp-auth' },
      h('p', { class: 'sheet-note', text: flow.callbackExpected ? t('shell.mcp.authNoteCallback') : t('shell.mcp.authNote') }),
      flow.authUrl
        ? h('a', {
          class: 'btn btn-secondary btn-sm',
          attrs: {
            href: flow.authUrl,
            target: '_blank',
            rel: 'noopener noreferrer',
            'data-mcp-focus': paste ? null : name,
          },
        }, icon('external'), h('span', { text: t('shell.mcp.openAuth') }))
        : null,
      paste ? h('label', { class: 'field' }, h('span', { class: 'field-label', text: t('shell.mcp.pasteLabel') }), paste) : null,
      flow.error ? h('p', { class: 'form-error', attrs: { role: 'alert' }, text: flow.error }) : null,
      h('p', { class: 'field-hint', attrs: { role: 'status' }, text: t('shell.mcp.waiting', { server: name }) }),
      h('div', { class: 'sheet-inline' },
        paste ? h('button', {
          class: 'btn btn-primary btn-sm',
          attrs: { type: 'button', disabled: flow.busy || locked },
          on: { click: () => submitCallback(name) },
        }, t('shell.mcp.submit')) : null,
        h('button', {
          class: 'btn btn-ghost btn-sm',
          attrs: { type: 'button' },
          on: { click: () => cancelFlow(name) },
        }, t('common.cancel'))));
  }

  /**
   * One MCP server: status, error, tools, the controls the runtime offers, the sign-in in progress and the permission
   * override. Every control waits while `locked`.
   * @param {Record<string, any>} server
   * @param {boolean} locked
   */
  function mcpRow(server, locked) {
    const name = String(server.name);
    const disabled = server.status === 'disabled';
    const tools = Array.isArray(server.tools) ? server.tools.length : 0;
    const flow = flows.get(name) ?? null;
    const remote = server.config?.type === 'http' || server.config?.type === 'sse';
    const select = h('select', {
      class: 'select',
      attrs: { 'aria-label': t('shell.mcp.overrideFor', { server: name }), disabled: locked },
      on: { change: (event) => setOverride(name, /** @type {HTMLSelectElement} */ (event.currentTarget).value) },
    }, MCP_OVERRIDES.map((mode) => h('option', {
      attrs: { value: mode },
      text: t(`shell.mcp.override.${mode || 'none'}`),
    })));
    select.value = overrides.get(name) ?? '';
    return h('li', { class: 'item' },
      h('div', { class: 'item-head' },
        h('span', { class: 'mono item-name', text: name }),
        statusChip(labelOr(t, `shell.mcp.status.${server.status}`, String(server.status)), mcpTone(server.status))),
      server.error ? h('p', { class: 'item-error', text: server.error }) : null,
      h('div', { class: 'item-meta' },
        server.serverInfo ? h('span', { class: 'mono', text: `${server.serverInfo.name} ${server.serverInfo.version}` }) : null,
        tools > 0 ? h('span', { text: t(tools === 1 ? 'shell.caps.toolCount.one' : 'shell.caps.toolCount.other', { count: tools }) }) : null),
      flow ? authFlow(name, flow, locked) : null,
      h('div', { class: 'item-actions' },
        h('button', {
          class: 'btn btn-secondary btn-sm',
          attrs: { type: 'button', disabled: locked },
          on: { click: () => mcpAction(name, { action: 'toggle', enabled: disabled }) },
        }, disabled ? t('shell.caps.enable') : t('shell.caps.disable')),
        h('button', {
          class: 'btn btn-ghost btn-sm',
          attrs: { type: 'button', disabled: locked || disabled },
          on: { click: () => mcpAction(name, { action: 'reconnect' }) },
        }, icon('refresh'), h('span', { text: t('shell.caps.reconnect') })),
        server.status === 'needs-auth' && !flow ? h('button', {
          class: 'btn btn-primary btn-sm',
          attrs: { type: 'button', disabled: locked },
          on: { click: () => startAuth(name) },
        }, icon('unlock'), h('span', { text: t('shell.mcp.authenticate') })) : null,
        remote && !disabled && !flow ? h('button', {
          class: 'btn btn-ghost btn-sm',
          attrs: { type: 'button', disabled: locked },
          on: { click: () => clearAuth(name) },
        }, icon('lock'), h('span', { text: t('shell.mcp.clear') })) : null),
      h('label', { class: 'mcp-override' },
        h('span', { class: 'field-label', text: t('shell.mcp.override') }),
        select));
  }

  /**
   * @param {Array<Record<string, any>>} servers
   * @param {boolean} locked
   */
  function mcpList(servers, locked) {
    if (servers.length === 0) return note(t('shell.caps.noServers'));
    return h('ul', { class: 'item-list' }, servers.map((server) => mcpRow(server, locked)));
  }

  function accountRows(account) {
    if (!account) return note(t('shell.caps.noAccount'));
    return h('div', { class: 'kv-list' },
      kvRow(t('shell.caps.email'), account.email ?? null, { mono: true }),
      kvRow(t('shell.caps.organization'), account.organization ?? null),
      kvRow(t('shell.caps.subscription'), planLabel(account.subscriptionType)),
      kvRow(t('shell.caps.provider'), providerLabel(account.apiProvider)));
  }

  function listOrNote(items, emptyText, renderItem) {
    if (items.length === 0) return note(emptyText);
    return h('ul', { class: 'item-list' }, items.map(renderItem));
  }

  function render() {
    clear(content);
    if (loading && !caps) {
      content.append(h('div', { class: 'skeleton-stack', attrs: { 'aria-hidden': 'true' } },
        [0, 1, 2].map(() => h('div', { class: 'skeleton skeleton-block' }))));
      return;
    }
    if (failure) {
      content.append(errorBlock(failure, load, t));
      return;
    }
    if (!caps) return;
    if (caps.stale) content.append(note(t('shell.caps.stale')));
    const mcpReason = mcpLockReason();
    const styles = Array.isArray(caps.availableOutputStyles) ? caps.availableOutputStyles : [];
    content.append(
      section(t('shell.caps.account'), accountRows(caps.account)),
      section(t('shell.caps.outputStyle'), styleControl(styles)),
      keyedSection('mcp', t('shell.caps.mcp'),
        mcpReason ? note(mcpReason) : null,
        mcpList(caps.mcpServers ?? [], mcpReason !== ''),
        (caps.mcpServers ?? []).length > 0 ? h('p', { class: 'field-hint', text: t('shell.mcp.overrideHint') }) : null),
      section(t('shell.caps.agents'), listOrNote(caps.agents ?? [], t('shell.caps.noAgents'), (agent) =>
        h('li', { class: 'item' },
          h('div', { class: 'item-head' },
            h('span', { class: 'item-name', text: agent.name }),
            agent.model ? statusChip(agent.model, 'muted') : null),
          agent.description ? h('p', { class: 'item-desc', text: agent.description }) : null))),
      section(t('shell.caps.commands'), listOrNote(caps.commands ?? [], t('shell.caps.noCommands'), (command) =>
        h('li', { class: 'item' },
          h('div', { class: 'item-head' },
            h('span', { class: 'mono item-name', text: `/${command.name}` }),
            command.argumentHint ? h('span', { class: 'mono item-hint', text: command.argumentHint }) : null),
          command.description ? h('p', { class: 'item-desc', text: command.description }) : null))),
      section(t('shell.caps.skills'), skills === null
        ? note(t('shell.caps.skillsUnknown'))
        : skills.length === 0
          ? note(t('shell.caps.noSkills'))
          : h('div', { class: 'chip-row' }, skills.map((skill) => statusChip(String(skill), 'accent')))),
      reloadSection(),
    );
    if (focusTarget) {
      const target = content.querySelector(`[data-mcp-focus="${CSS.escape(focusTarget)}"]`);
      focusTarget = '';
      target?.focus({ preventScroll: true });
    }
  }

  const unsubscribe = store.subscribe((state, prev) => {
    if (state.currentSessionId !== prev.currentSessionId) {
      reload();
      return;
    }
    if (controlKey(state) === controlKey(prev)) return;
    // Going live loads the capabilities of the live session; any other change only moves the controls.
    if (controlsOf(state).live && !controlsOf(prev).live) load();
    else render();
  });

  render();
  load();
  return () => {
    disposed = true;
    stopPolling();
    unsubscribe();
  };
}

/**
 * @param {Record<string, any>} ctx
 * @returns {(() => void) | undefined}
 */
function contextPanel({ body, api, store, t, actions, reload }) {
  const sessionId = store.get().currentSessionId;
  if (!sessionId) {
    body.appendChild(note(t('shell.panel.noSession')));
    return undefined;
  }
  const number = new Intl.NumberFormat(getLocale());
  let usage = null;
  let loading = true;
  /** @type {{code?: string, message: string} | null} */
  let failure = null;
  const content = h('div', { class: 'context' });
  body.appendChild(content);

  async function load() {
    loading = true;
    failure = null;
    render();
    try {
      usage = await api.get(`/api/sessions/${encodeURIComponent(sessionId)}/context`);
    } catch (err) {
      usage = null;
      failure = { code: err?.code, message: errorText(err, t) };
    } finally {
      loading = false;
      render();
    }
  }

  async function openSession() {
    try {
      await api.post(`/api/sessions/${encodeURIComponent(sessionId)}/open`, {});
      await load();
    } catch (err) {
      actions.toast(errorText(err, t), 'error');
    }
  }

  function render() {
    clear(content);
    if (loading) {
      content.append(h('div', { class: 'skeleton-stack', attrs: { 'aria-hidden': 'true' } },
        [0, 1].map(() => h('div', { class: 'skeleton skeleton-block' }))));
      return;
    }
    if (failure) {
      if (failure.code === 'SESSION_NOT_LIVE') {
        content.append(note(t('shell.context.notLive')),
          h('button', { class: 'btn btn-primary btn-block', attrs: { type: 'button' }, on: { click: openSession } },
            t('shell.context.open')));
      } else {
        content.append(errorBlock(failure.message, load, t));
      }
      return;
    }
    if (!usage) return;
    const total = Number(usage.totalTokens) || 0;
    const max = Number(usage.maxTokens) || 0;
    const percent = max > 0 ? (total / max) * 100 : Number(usage.percentage) || 0;
    const clamped = Math.min(100, Math.max(0, percent));
    const categories = Array.isArray(usage.categories) ? usage.categories : [];
    const threshold = typeof usage.autoCompactThreshold === 'number' ? usage.autoCompactThreshold : null;

    content.append(...[
      h('div', { class: 'context-summary' },
        h('div', { class: 'context-figure' },
          h('span', { class: 'context-number', text: `${number.format(total)}` }),
          h('span', { class: 'context-of', text: t('shell.context.of', { max: number.format(max) }) })),
        h('span', { class: 'context-percent', text: t('shell.context.percent', { percent: Math.round(percent) }) })),
      h('div', {
        class: 'progress',
        attrs: {
          role: 'progressbar',
          'aria-label': t('shell.context.title'),
          'aria-valuemin': 0,
          'aria-valuemax': 100,
          'aria-valuenow': Math.round(clamped),
        },
      }, h('div', { class: 'progress-bar', style: { width: `${clamped}%` } })),
      threshold !== null
        ? note(t('shell.context.autoCompact', {
          tokens: number.format(threshold),
          state: usage.isAutoCompactEnabled ? t('common.enabled') : t('common.disabled'),
        }))
        : null,
      section(t('shell.context.categories'),
        categories.length === 0 ? note(t('shell.context.noCategories')) : h('ul', { class: 'bar-list' },
          categories.map((category) => {
            const tokens = Number(category.tokens) || 0;
            const width = max > 0 ? Math.min(100, (tokens / max) * 100) : 0;
            const muted = category.kind === 'free' || category.kind === 'buffer';
            return h('li', { class: ['bar-row', muted ? 'is-muted' : ''] },
              h('div', { class: 'bar-head' },
                h('span', { text: category.name }),
                h('span', { class: 'mono', text: number.format(tokens) })),
              h('div', { class: 'bar-track' }, h('div', { class: 'bar-fill', style: { width: `${width}%` } })));
          }))),
      Array.isArray(usage.memoryFiles) && usage.memoryFiles.length > 0
        ? section(t('shell.context.memory'), h('ul', { class: 'item-list' }, usage.memoryFiles.slice(0, 30).map(
          (file) => h('li', { class: 'item item-compact' },
            h('span', { class: 'mono item-name', text: file.path, attrs: { title: file.path } }),
            h('span', { class: 'item-hint', text: number.format(Number(file.tokens) || 0) })))))
        : null,
      h('div', { class: 'sheet-actions' },
        h('button', { class: 'btn btn-secondary btn-block', attrs: { type: 'button' }, on: { click: load } },
          icon('refresh'), h('span', { text: t('shell.context.refresh') }))),
    ].filter(Boolean));
  }

  const unsubscribe = store.subscribe((state, prev) => {
    if (state.currentSessionId !== prev.currentSessionId) reload();
  });
  load();
  return unsubscribe;
}

/**
 * @param {Record<string, any>} ctx
 * @returns {(() => void) | undefined}
 */
function tasksPanel({ body, api, store, t, actions, reload }) {
  const sessionId = store.get().currentSessionId;
  if (!sessionId) {
    body.appendChild(note(t('shell.panel.noSession')));
    return undefined;
  }
  const content = h('div', { class: 'tasks' });
  body.appendChild(content);

  async function stop(taskId) {
    try {
      await api.post(`/api/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}/stop`, {});
      actions.toast(t('shell.tasks.stopping'), 'info');
    } catch (err) {
      actions.toast(errorText(err, t), 'error');
    }
  }

  /**
   * The row's buttons: the output of a shell or Monitor task (agents have none), and Stop while the task runs.
   * @param {string} taskId
   * @param {Record<string, any>} task
   * @param {boolean} running
   */
  function taskControls(taskId, task, running) {
    const buttons = [];
    if (OUTPUT_TASK_TYPES.includes(task.taskType)) {
      buttons.push(h('button', {
        class: 'btn btn-secondary btn-sm',
        attrs: { type: 'button' },
        on: { click: () => actions.showTaskOutput(taskId) },
      }, icon('file'), h('span', { text: t('shell.tasks.output') })));
    }
    if (running) {
      buttons.push(h('button', {
        class: 'btn btn-danger btn-sm',
        attrs: { type: 'button' },
        on: { click: () => stop(taskId) },
      }, icon('stop'), h('span', { text: t('shell.tasks.stop') })));
    }
    return buttons.length > 0 ? h('div', { class: 'item-actions' }, buttons) : null;
  }

  function render() {
    clear(content);
    const tasks = Object.entries(store.get().tasks[sessionId] ?? {});
    if (tasks.length === 0) {
      content.append(note(t('shell.tasks.empty')));
      return;
    }
    content.append(h('ul', { class: 'item-list' }, tasks.map(([taskId, task]) => {
      const running = task.status === 'running' || task.status === 'pending' || task.status === 'paused';
      const statusLabel = labelOr(t, `shell.tasks.status.${task.status}`, String(task.status));
      const tone = task.status === 'completed' ? 'success'
        : task.status === 'failed' || task.status === 'killed' ? 'danger'
          : running ? 'accent' : 'muted';
      return h('li', { class: 'item' },
        h('div', { class: 'item-head' },
          h('span', { class: 'item-name', text: task.description || taskId }),
          statusChip(statusLabel, tone)),
        task.summary ? h('p', { class: 'item-desc', text: task.summary }) : null,
        h('div', { class: 'item-meta' },
          task.lastToolName ? h('span', { class: 'mono', text: task.lastToolName }) : null,
          h('span', { class: 'mono', text: taskId, attrs: { title: taskId } })),
        taskControls(taskId, task, running));
    })));
  }

  const unsubscribe = store.subscribe((state, prev) => {
    if (state.currentSessionId !== prev.currentSessionId) {
      reload();
      return;
    }
    if (state.tasks !== prev.tasks) render();
  });
  render();
  return unsubscribe;
}

/**
 * @param {Record<string, any>} ctx
 * @returns {(() => void) | undefined}
 */
function settingsPanel({ body, api, store, t, actions }) {
  const meta = store.get().meta ?? {};
  const auth = store.get().auth ?? {};
  const prefs = () => store.get().prefs;
  const setPrefs = (/** @type {Record<string, unknown>} */ patch) => {
    store.set({ prefs: { ...prefs(), ...patch } });
  };

  const themeControl = segmented(t('shell.settings.theme'), THEMES.map((value) => ({
    value,
    label: t(`shell.settings.theme.${value}`),
  })), prefs().theme, (value) => setPrefs({ theme: value }));

  const fontControl = segmented(t('shell.settings.fontSize'), FONT_SIZES.map((value) => ({
    value,
    label: t(`shell.settings.fontSize.${value}`),
  })), prefs().fontSize, (value) => setPrefs({ fontSize: value }));

  const localeSelect = h('select', {
    class: 'select',
    attrs: { 'aria-label': t('shell.settings.language') },
    dataset: { focusKey: 'locale' },
    on: {
      change: (event) => {
        const value = /** @type {HTMLSelectElement} */ (event.target).value;
        setPrefs({ locale: value });
        setLocale(value);
      },
    },
  }, LOCALES.map((locale) => h('option', { attrs: { value: locale.value }, text: locale.label })));
  localeSelect.value = getLocale();

  const notifyControl = switchControl(t('shell.settings.notifications'), prefs().notify === true, async (next) => {
    if (!next) {
      setPrefs({ notify: false });
      notifyControl.sync(false);
      return;
    }
    if (typeof Notification === 'undefined') {
      actions.toast(t('shell.settings.notifyUnsupported'), 'warning');
      notifyControl.sync(false);
      return;
    }
    let permission = Notification.permission;
    if (permission === 'default') {
      try {
        permission = await Notification.requestPermission();
      } catch {
        permission = 'denied';
      }
    }
    if (permission !== 'granted') {
      actions.toast(t('shell.settings.notifyDenied'), 'warning');
      notifyControl.sync(false);
      return;
    }
    setPrefs({ notify: true });
    notifyControl.sync(true);
  });

  const runtimeEventsControl = switchControl(t('shell.settings.runtimeEvents'), prefs().showRuntimeEvents === true,
    (next) => {
      setPrefs({ showRuntimeEvents: next });
      runtimeEventsControl.sync(next);
    });

  // Unattended mode is gateway-wide (docs/PROTOCOL.md): only the full access profile may switch it, and turning it on
  // asks first. Turning it off needs no question.
  let unattendedBusy = false;
  const unattendedReason = h('p', { class: 'field-hint', attrs: { role: 'status' } });
  const unattendedControl = switchControl(t('shell.settings.unattended'), false, (next) => {
    if (next) confirmUnattended();
    else putUnattended(false);
  });
  const syncUnattended = () => {
    const state = store.get();
    const view = unattendedSwitch(state.unattended, state.auth?.profile ?? state.meta?.profile ?? null);
    unattendedControl.sync(view.checked);
    unattendedControl.el.disabled = view.disabled || unattendedBusy;
    const reasonText = view.reason === 'profile' ? t('shell.settings.unattended.profile')
      : view.reason === 'not-allowed' ? t('shell.settings.unattended.notAllowed') : '';
    unattendedReason.textContent = reasonText;
    unattendedReason.hidden = reasonText === '';
  };

  /** Writes the switch. The answer is the gateway's state after the change, newer than any earlier one. */
  async function putUnattended(/** @type {boolean} */ enabled) {
    unattendedBusy = true;
    syncUnattended();
    try {
      const answer = await api.setUnattended(enabled);
      store.set({ unattended: newerUnattended(store.get().unattended, normalizeUnattended(answer)) });
    } catch (err) {
      actions.toast(errorText(err, t), 'error');
    } finally {
      unattendedBusy = false;
      syncUnattended();
    }
  }

  /** Turning unattended mode on: a dialog says what it does; its primary button switches it. */
  function confirmUnattended() {
    openDialog({
      title: t('shell.unattended.confirmTitle'),
      body: h('p', { class: 'dialog-text', text: t('shell.unattended.confirmBody') }),
      size: 'sm',
      actions: [
        { label: t('common.cancel'), kind: 'secondary' },
        { label: t('shell.unattended.confirm'), kind: 'primary', onClick: () => putUnattended(true) },
      ],
    });
  }

  const accountEl = h('div', { class: 'account' });
  const disposeAccount = mountAccountSection(accountEl, { api, store, t, actions });

  body.append(
    section(t('shell.settings.appearance'),
      h('div', { class: 'settings-row' }, h('span', { class: 'settings-label', text: t('shell.settings.theme') }),
        themeControl.el),
      h('div', { class: 'settings-row' }, h('span', { class: 'settings-label', text: t('shell.settings.fontSize') }),
        fontControl.el)),
    section(t('shell.settings.language'),
      h('div', { class: 'settings-row' }, localeSelect)),
    section(t('shell.settings.behavior'),
      h('div', { class: 'settings-row' },
        h('span', { class: 'settings-label', text: t('shell.settings.notifications') }),
        notifyControl.el),
      h('p', { class: 'field-hint', text: t('shell.settings.notificationsHint') })),
    keyedSection('permissions', t('shell.settings.permissions'),
      h('div', { class: 'settings-row' },
        h('span', { class: 'settings-label', text: t('shell.settings.unattended') }),
        unattendedControl.el),
      h('p', { class: 'field-hint', text: t('shell.settings.unattendedHint') }),
      unattendedReason),
    section(t('shell.settings.troubleshooting'),
      h('div', { class: 'settings-row' },
        h('span', { class: 'settings-label', text: t('shell.settings.runtimeEvents') }),
        runtimeEventsControl.el),
      h('p', { class: 'field-hint', text: t('shell.settings.runtimeEventsHint') })),
    section(t('shell.settings.about'),
      kvRow(t('shell.settings.app'), meta.appName ?? auth.appName ?? null),
      kvRow(t('shell.settings.version'), meta.version ?? auth.version ?? null, { mono: true }),
      kvRow(t('shell.settings.engine'), meta.engine ?? null, { mono: true }),
      kvRow(t('shell.settings.sdkVersion'), meta.sdkVersion ?? null, { mono: true }),
      kvRow(t('shell.settings.claudeCodeVersion'), meta.claudeCodeVersion ?? null, { mono: true }),
      kvRow(t('shell.settings.profile'), meta.profile ?? auth.profile ?? null, { mono: true })),
    keyedSection('account', t('shell.settings.account'), accountEl),
  );

  syncUnattended();
  // The current state from the gateway, in case the page has missed a change.
  api.unattended()
    .then((answer) => store.set({ unattended: newerUnattended(store.get().unattended, normalizeUnattended(answer)) }))
    .catch(() => {});

  const unsubscribe = store.subscribe((state, prev) => {
    if (state.unattended !== prev.unattended || state.auth !== prev.auth || state.meta !== prev.meta) syncUnattended();
    if (state.prefs === prev.prefs) return;
    themeControl.sync(state.prefs.theme);
    fontControl.sync(state.prefs.fontSize);
    notifyControl.sync(state.prefs.notify === true);
    runtimeEventsControl.sync(state.prefs.showRuntimeEvents === true);
  });
  return () => {
    unsubscribe();
    disposeAccount();
  };
}

/**
 * The output of one shell or Monitor task of the live session (GET /tasks/:taskId/output), in a dialog. The end of the
 * output stays in view. While the task runs it is read again every two seconds, and once more when it ends.
 * @param {{api: any, store: any, t: (key: string, vars?: Record<string, unknown>) => string, sessionId: string,
 *   taskId: string}} options
 * @returns {{close: () => void} | null}
 */
export function openTaskOutput({ api, store, t, sessionId, taskId }) {
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}/output`;
  const taskNow = () => store.get().tasks[sessionId]?.[taskId] ?? null;
  const isRunning = (/** @type {string | null} */ status) => RUNNING_TASK_STATES.includes(status ?? '');
  const name = taskNow()?.description || taskId;
  const status = h('p', { class: 'field-hint', attrs: { role: 'status' } });
  const errorEl = h('p', { class: 'form-error', attrs: { role: 'alert' } });
  errorEl.hidden = true;
  const output = h('pre', {
    class: 'task-output mono',
    attrs: { tabindex: '0', 'aria-label': t('shell.tasks.outputOf', { name }) },
  });
  const body = h('div', { class: 'form-stack' }, status, errorEl, output);
  let disposed = false;
  let inFlight = false;
  let loaded = false;
  let timer = 0;
  let lastStatus = taskNow()?.status ?? null;
  /** A read was asked for while one was in flight: it runs once that one ends (so the final output is not missed). */
  let again = false;

  /** Reads the output again. The end stays in view when the reader was already there. */
  async function refresh() {
    if (disposed) return;
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    const atEnd = output.scrollHeight - output.scrollTop - output.clientHeight < 24;
    try {
      const answer = await api.get(path);
      if (disposed) return;
      const text = typeof answer?.output === 'string' ? answer.output : '';
      output.classList.toggle('is-empty', text === '');
      output.textContent = text === '' ? t('shell.tasks.noOutput') : text;
      errorEl.hidden = true;
      const parts = [];
      if (answer?.truncated === true) parts.push(t('shell.tasks.truncated'));
      parts.push(t('shell.tasks.updated', { time: formatClock(Date.now(), getLocale()) }));
      status.textContent = parts.join(' · ');
      if (!loaded || atEnd) output.scrollTop = output.scrollHeight;
      loaded = true;
    } catch (err) {
      if (disposed) return;
      errorEl.textContent = errorText(err, t);
      errorEl.hidden = false;
    } finally {
      inFlight = false;
      if (again && !disposed) {
        again = false;
        refresh();
      }
    }
  }

  function schedule() {
    if (disposed) return;
    if (isRunning(taskNow()?.status ?? null)) {
      if (!timer) timer = setInterval(refresh, TASK_OUTPUT_REFRESH_MS);
    } else if (timer) {
      clearInterval(timer);
      timer = 0;
    }
  }

  const unsubscribe = store.subscribe((state, prev) => {
    if (state.tasks === prev.tasks) return;
    const nowStatus = taskNow()?.status ?? null;
    // The task ended: read its final output once.
    if (isRunning(lastStatus) && !isRunning(nowStatus)) refresh();
    lastStatus = nowStatus;
    schedule();
  });

  const handle = openDialog({
    title: t('shell.tasks.outputTitle', { name }),
    body,
    size: 'lg',
    onClose: () => {
      disposed = true;
      if (timer) clearInterval(timer);
      timer = 0;
      unsubscribe();
    },
    actions: [
      { label: t('shell.tasks.refresh'), kind: 'secondary', keepOpen: true, onClick: () => refresh() },
      { label: t('common.close'), kind: 'primary' },
    ],
  });
  refresh();
  schedule();
  return handle;
}

const PANELS = {
  session: sessionPanel,
  capabilities: capabilitiesPanel,
  context: contextPanel,
  tasks: tasksPanel,
  settings: settingsPanel,
  runtime: (ctx) => mountRuntimePanel(ctx),
  developer: (ctx) => mountDeveloperPanel(ctx),
};

/**
 * Where a closing sheet gives focus back: the element that had it when the sheet opened, while that element is still on
 * the page; otherwise the composer's text field, then the main region. Focus never falls back to the document body.
 * @param {Element | null} opener
 * @returns {HTMLElement | null}
 */
function focusReturnTarget(opener) {
  if (opener instanceof HTMLElement && opener.isConnected && opener !== document.body) return opener;
  const composer = document.querySelector('.app-composer-slot .composer-input');
  if (composer instanceof HTMLElement) return composer;
  const main = document.getElementById('main');
  return main instanceof HTMLElement ? main : null;
}

/**
 * Open a side sheet. Opening another sheet replaces the current one. The sheet re-renders when the language
 * changes and closes on Escape, scrim click or its close button. `opts.tab` picks the tab of the Runtime panel;
 * `opts.section` scrolls the sheet to the section with that key (for example `directories` in the session panel).
 * @param {'session'|'capabilities'|'context'|'tasks'|'settings'|'runtime'|'developer'} name
 * @param {{ api: any, store: any, t: Function, actions: any }} deps
 * @param {{ tab?: string, section?: string }} [opts]
 * @returns {{ close: () => void, name: string }}
 */
export function openPanel(name, { api, store, t, actions }, opts = {}) {
  if (!PANEL_NAMES.includes(name)) throw new TypeError(`Unknown panel: ${name}`);
  activeSheet?.close();
  const opener = document.activeElement;
  const unlockScroll = lockScroll();

  const titleEl = h('h2', { class: 'sheet-title', attrs: { id: 'sheet-title' } });
  const bodyEl = h('div', { class: 'sheet-body' });
  const closeButton = h('button', {
    class: 'btn btn-ghost btn-icon',
    attrs: { type: 'button', 'aria-label': t('common.close') },
    on: { click: () => close() },
  }, icon('x'));
  const sheet = h('section', {
    class: 'sheet',
    attrs: {
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'sheet-title',
      'data-panel': name,
      tabindex: '-1',
    },
  }, h('header', { class: 'sheet-header' }, titleEl, closeButton), bodyEl);
  const scrim = h('div', { class: 'sheet-scrim', attrs: { 'aria-hidden': 'true' }, on: { click: () => close() } });
  const layer = h('div', { class: 'sheet-layer' }, scrim, sheet);

  /** @type {(() => void) | null} */
  let disposeBody = null;
  /** @type {(() => void) | null} */
  let disposeLocale = null;
  let closed = false;
  /** @type {MutationObserver | null} */
  let observer = null;

  function mountBody() {
    if (disposeBody) disposeBody();
    disposeBody = null;
    clear(bodyEl);
    titleEl.textContent = t(`shell.panel.${name}`);
    const dispose = PANELS[name]({ body: bodyEl, api, store, t, actions, close, reload: mountBody, opts });
    disposeBody = typeof dispose === 'function' ? dispose : null;
  }

  /** Scrolls to the requested section. Returns false while the section is not in the sheet. */
  function revealSection() {
    const target = bodyEl.querySelector(`[data-section="${CSS.escape(opts.section ?? '')}"]`);
    if (!target) return false;
    target.scrollIntoView({ block: 'start' });
    return true;
  }

  /** @param {KeyboardEvent} event */
  function onKeydown(event) {
    // A dialog opened from the sheet (for example the delete confirmation) owns the keyboard until it closes.
    if (hasOpenDialog()) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = /** @type {HTMLElement[]} */ ([...sheet.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
    )]);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const current = /** @type {HTMLElement} */ (document.activeElement);
    const inside = sheet.contains(current) && current !== sheet;
    if (event.shiftKey) {
      if (!inside || current === first) {
        event.preventDefault();
        last.focus();
      }
    } else if (!inside || current === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    observer?.disconnect();
    if (disposeBody) disposeBody();
    disposeBody = null;
    if (disposeLocale) disposeLocale();
    disposeLocale = null;
    document.removeEventListener('keydown', onKeydown);
    unlockScroll();
    layer.remove();
    if (activeSheet === handle) activeSheet = null;
    focusReturnTarget(opener)?.focus({ preventScroll: true });
  }

  const handle = { close, name };
  activeSheet = handle;
  document.body.appendChild(layer);
  document.addEventListener('keydown', onKeydown);
  mountBody();
  if (opts.section && !revealSection()) {
    // Some sections appear once their data has loaded: follow the body until the section shows up, for five seconds.
    observer = new MutationObserver(() => {
      if (revealSection()) observer?.disconnect();
    });
    observer.observe(bodyEl, { childList: true, subtree: true });
    setTimeout(() => observer?.disconnect(), 5000);
  }
  disposeLocale = onLocaleChange(() => {
    if (closed) return;
    // Re-rendering replaces the focused control, so focus the element with the same key afterwards.
    const focused = document.activeElement;
    const focusKey = focused instanceof HTMLElement && bodyEl.contains(focused) ? focused.dataset.focusKey : undefined;
    mountBody();
    closeButton.setAttribute('aria-label', t('common.close'));
    if (focusKey) bodyEl.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
  });
  sheet.focus({ preventScroll: true });
  return handle;
}
