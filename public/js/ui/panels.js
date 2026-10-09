/**
 * Side sheets (right column on desktop, bottom sheet on mobile): session details, capabilities, context usage,
 * background tasks and settings. Also the session dialogs shared with the sidebar (rename, tag, delete) and the
 * session-list refresh helper.
 */

import { h, clear, icon } from '../dom.js';
import { errorText } from '../api.js';
import { getLocale, onLocaleChange, setLocale } from '../i18n.js';
import { THEMES, FONT_SIZES } from '../store.js';
import { confirmDialog, hasOpenDialog, lockScroll, openDialog } from './dialog.js';
import { mergeLive, sessionTitle } from './sidebar-model.js';

const PANEL_NAMES = ['session', 'capabilities', 'context', 'tasks', 'settings'];
const LOCALES = [{ value: 'en', label: 'English' }, { value: 'zh-CN', label: '简体中文' }];
const SESSION_PAGE = 100;
/** How a held plugin reload may change the language server tools (cacheImpact.lspToolChange of the reload answer). */
const LSP_TOOL_CHANGES = ['adds', 'may-add', 'removes', 'may-remove'];

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
    runtimeEl.append(
      kvRow(t('shell.session.state'), live ? t(`common.state.${live.state}`) : t('shell.session.notRunning')),
      kvRow(t('shell.session.model'), live?.model ?? defaults.model ?? null),
      kvRow(t('shell.session.mode'), t(`common.mode.${mode}`)),
      kvRow(t('shell.session.effort'), effort ? t(`common.effort.${effort}`) : t('common.effort.default')),
      live?.claudeCodeVersion ? kvRow(t('shell.session.version'), live.claudeCodeVersion, { mono: true }) : null,
    );

    const profile = state.meta?.profile ?? state.auth?.profile ?? null;
    const canFork = profile !== 'read';
    const canDelete = profile === 'full' && !live;
    const canTerminal = state.meta?.features?.terminal === true && profile === 'full';
    clear(actionsEl);
    actionsEl.append(
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
    );
  }

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
  return unsubscribe;
}

/**
 * Button used inside sheets.
 * @param {string} label
 * @param {string} iconName
 * @param {() => unknown} onClick
 * @param {{danger?: boolean}} [options]
 */
function actionButton(label, iconName, onClick, { danger = false } = {}) {
  return h('button', {
    class: ['btn', danger ? 'btn-danger' : 'btn-secondary', 'btn-block', 'sheet-action'],
    attrs: { type: 'button' },
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
      const result = await api.post(`/api/sessions/${encodeURIComponent(sessionId)}/mcp`, { server, ...request });
      setCaps({ ...caps, mcpServers: Array.isArray(result.mcpServers) ? result.mcpServers : caps.mcpServers });
      render();
    } catch (err) {
      actions.toast(errorText(err, t), 'error');
    }
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

  function mcpList(servers) {
    if (servers.length === 0) return note(t('shell.caps.noServers'));
    return h('ul', { class: 'item-list' }, servers.map((server) => {
      const disabled = server.status === 'disabled';
      const tools = Array.isArray(server.tools) ? server.tools.length : 0;
      return h('li', { class: 'item' },
        h('div', { class: 'item-head' },
          h('span', { class: 'mono item-name', text: server.name }),
          statusChip(labelOr(t, `shell.mcp.status.${server.status}`, String(server.status)),
            mcpTone(server.status))),
        server.error ? h('p', { class: 'item-error', text: server.error }) : null,
        h('div', { class: 'item-meta' },
          server.serverInfo ? h('span', { class: 'mono', text: `${server.serverInfo.name} ${server.serverInfo.version}` }) : null,
          tools > 0 ? h('span', { text: t('shell.caps.toolCount', { count: tools }) }) : null),
        h('div', { class: 'item-actions' },
          h('button', {
            class: 'btn btn-secondary btn-sm',
            attrs: { type: 'button' },
            on: { click: () => mcpAction(server.name, { action: 'toggle', enabled: disabled }) },
          }, disabled ? t('shell.caps.enable') : t('shell.caps.disable')),
          h('button', {
            class: 'btn btn-ghost btn-sm',
            attrs: { type: 'button', disabled },
            on: { click: () => mcpAction(server.name, { action: 'reconnect' }) },
          }, icon('refresh'), h('span', { text: t('shell.caps.reconnect') }))));
    }));
  }

  function accountRows(account) {
    if (!account) return note(t('shell.caps.noAccount'));
    return h('div', { class: 'kv-list' },
      kvRow(t('shell.caps.email'), account.email ?? null, { mono: true }),
      kvRow(t('shell.caps.organization'), account.organization ?? null),
      kvRow(t('shell.caps.subscription'), account.subscriptionType ?? null),
      kvRow(t('shell.caps.provider'), account.apiProvider ?? null));
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
    const styles = Array.isArray(caps.availableOutputStyles) ? caps.availableOutputStyles : [];
    content.append(
      section(t('shell.caps.account'), accountRows(caps.account)),
      section(t('shell.caps.outputStyle'), styleControl(styles)),
      section(t('shell.caps.mcp'), mcpList(caps.mcpServers ?? [])),
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
  return unsubscribe;
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

    content.append(
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
    );
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
        running ? h('div', { class: 'item-actions' },
          h('button', {
            class: 'btn btn-danger btn-sm',
            attrs: { type: 'button' },
            on: { click: () => stop(taskId) },
          }, icon('stop'), h('span', { text: t('shell.tasks.stop') }))) : null);
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

  const signOut = h('button', {
    class: 'btn btn-danger btn-block',
    attrs: { type: 'button' },
    on: {
      click: async () => {
        try {
          await api.post('/api/logout', {});
        } catch (err) {
          actions.toast(errorText(err, t), 'error');
          return;
        }
        store.set({ auth: { ...store.get().auth, authenticated: false } });
      },
    },
  }, icon('logout'), h('span', { text: t('shell.settings.signOut') }));

  body.append(
    section(t('shell.settings.appearance'),
      h('div', { class: 'settings-row' }, h('span', { class: 'settings-label', text: t('shell.settings.theme') }),
        themeControl.el),
      h('div', { class: 'settings-row' }, h('span', { class: 'settings-label', text: t('shell.settings.fontSize') }),
        fontControl.el)),
    section(t('shell.settings.language'),
      h('div', { class: 'settings-row' }, h('span', { class: 'settings-label', text: t('shell.settings.language') }),
        localeSelect)),
    section(t('shell.settings.behavior'),
      h('div', { class: 'settings-row' },
        h('span', { class: 'settings-label', text: t('shell.settings.notifications') }),
        notifyControl.el),
      h('p', { class: 'field-hint', text: t('shell.settings.notificationsHint') })),
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
    section(t('shell.settings.account'), signOut),
  );

  const unsubscribe = store.subscribe((state, prev) => {
    if (state.prefs === prev.prefs) return;
    themeControl.sync(state.prefs.theme);
    fontControl.sync(state.prefs.fontSize);
    notifyControl.sync(state.prefs.notify === true);
    runtimeEventsControl.sync(state.prefs.showRuntimeEvents === true);
  });
  return unsubscribe;
}

const PANELS = {
  session: sessionPanel,
  capabilities: capabilitiesPanel,
  context: contextPanel,
  tasks: tasksPanel,
  settings: settingsPanel,
};

/**
 * Open a side sheet. Opening another sheet replaces the current one. The sheet re-renders when the language
 * changes and closes on Escape, scrim click or its close button.
 * @param {'session'|'capabilities'|'context'|'tasks'|'settings'} name
 * @param {{ api: any, store: any, t: Function, actions: any }} deps
 * @returns {{ close: () => void, name: string }}
 */
export function openPanel(name, { api, store, t, actions }) {
  if (!PANEL_NAMES.includes(name)) throw new TypeError(`Unknown panel: ${name}`);
  activeSheet?.close();
  const previouslyFocused = /** @type {HTMLElement | null} */ (document.activeElement);
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

  function mountBody() {
    if (disposeBody) disposeBody();
    disposeBody = null;
    clear(bodyEl);
    titleEl.textContent = t(`shell.panel.${name}`);
    const dispose = PANELS[name]({ body: bodyEl, api, store, t, actions, close, reload: mountBody });
    disposeBody = typeof dispose === 'function' ? dispose : null;
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
    if (disposeBody) disposeBody();
    disposeBody = null;
    if (disposeLocale) disposeLocale();
    disposeLocale = null;
    document.removeEventListener('keydown', onKeydown);
    unlockScroll();
    layer.remove();
    if (activeSheet === handle) activeSheet = null;
    if (previouslyFocused && previouslyFocused.isConnected) previouslyFocused.focus({ preventScroll: true });
  }

  const handle = { close, name };
  activeSheet = handle;
  document.body.appendChild(layer);
  document.addEventListener('keydown', onKeydown);
  mountBody();
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
