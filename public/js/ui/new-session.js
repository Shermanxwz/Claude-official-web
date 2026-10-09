/**
 * New-session dialog: browse workspace roots, pick a folder (or create one), set an optional title, model,
 * permission mode and effort, then start a live session and select it.
 */

import { h, clear, icon } from '../dom.js';
import { errorText } from '../api.js';
import { openDialog } from './dialog.js';

const LAST_CWD_KEY = 'caw.lastCwd';
const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const FOLDER_NAME_RE = /^[A-Za-z0-9._ -]{1,100}$/;

/** @returns {string | null} */
function readLastCwd() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(LAST_CWD_KEY);
  } catch {
    return null;
  }
}

/** @param {string} cwd */
function rememberCwd(cwd) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(LAST_CWD_KEY, cwd);
  } catch {
    // Storage unavailable: the dialog simply starts at the roots next time.
  }
}

/**
 * @param {string} path
 * @param {string[]} roots
 */
function isWithinRoots(path, roots) {
  return roots.some((root) => path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}\\`));
}

/**
 * @param {{
 *   api: { get(path: string): Promise<any>, post(path: string, body?: unknown): Promise<any> },
 *   store: { get(): any },
 *   t: (key: string, vars?: Record<string, string | number>) => string,
 *   actions: { selectSession(id: string): unknown },
 * }} options
 * @returns {{ close: () => void, element: HTMLElement }}
 */
export function openNewSessionDialog({ api, store, t, actions }) {
  const meta = store.get().meta;
  const roots = Array.isArray(meta?.roots) ? meta.roots : [];
  const bypassAllowed = meta?.features?.bypass === true;
  const modes = PERMISSION_MODES.filter((mode) => mode !== 'bypassPermissions' || bypassAllowed);

  /** @type {string | null} */
  let currentPath = null;
  /** @type {string | null} */
  let parentPath = null;
  /** @type {Array<{name: string, path: string, isProject: boolean}>} */
  let entries = [];
  let loadToken = 0;
  let creating = false;
  let browsing = false;

  const pathEl = h('span', { class: 'dir-path mono' });
  const listEl = h('ul', { class: 'dir-list', attrs: { 'aria-label': t('shell.newSession.folders') } });
  const upButton = h('button', {
    class: 'btn btn-ghost btn-sm dir-up',
    attrs: { type: 'button', 'aria-label': t('shell.newSession.up') },
    on: { click: () => load(parentPath) },
  }, icon('chevron-right'), h('span', { text: t('shell.newSession.up') }));

  const folderNameInput = h('input', {
    class: 'input',
    attrs: {
      type: 'text',
      maxlength: 100,
      placeholder: t('shell.newSession.folderPlaceholder'),
      'aria-label': t('shell.newSession.folderPlaceholder'),
      autocomplete: 'off',
      spellcheck: false,
    },
    on: {
      keydown: (/** @type {KeyboardEvent} */ event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          createFolder();
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          toggleNewFolder(false);
        }
      },
    },
  });
  const folderCreateButton = h('button', {
    class: 'btn btn-secondary btn-sm',
    attrs: { type: 'button' },
    on: { click: () => createFolder() },
  }, t('shell.newSession.createFolder'));
  const newFolderRow = h('div', { class: 'dir-new-row', attrs: { hidden: true } }, folderNameInput, folderCreateButton);
  const newFolderButton = h('button', {
    class: 'btn btn-ghost btn-sm',
    attrs: { type: 'button', 'aria-expanded': 'false' },
    on: { click: () => toggleNewFolder() },
  }, icon('plus'), h('span', { text: t('shell.newSession.newFolder') }));

  const titleInput = h('input', {
    class: 'input',
    attrs: { type: 'text', maxlength: 200, autocomplete: 'off', placeholder: t('shell.newSession.titlePlaceholder') },
  });

  const modelOptions = collectModelOptions(store.get().capabilities, meta?.defaults?.model);
  const modelInput = h('input', {
    class: 'input',
    attrs: {
      type: 'text',
      list: 'new-session-models',
      autocomplete: 'off',
      spellcheck: false,
      placeholder: meta?.defaults?.model ?? t('shell.newSession.modelDefault'),
    },
  });
  const datalist = h('datalist', { attrs: { id: 'new-session-models' } },
    modelOptions.map((value) => h('option', { attrs: { value } })));

  const modeHint = h('p', { class: 'field-hint' });
  const modeSelect = h('select', {
    class: 'select',
    on: { change: () => syncModeHint() },
  }, modes.map((mode) => h('option', {
    attrs: { value: mode, selected: mode === (meta?.defaults?.permissionMode ?? 'default') },
    text: t(`common.mode.${mode}`),
  })));

  const effortSelect = h('select', { class: 'select' },
    h('option', { attrs: { value: '', selected: !meta?.defaults?.effort }, text: t('common.effort.default') }),
    EFFORT_LEVELS.map((level) => h('option', {
      attrs: { value: level, selected: meta?.defaults?.effort === level },
      text: t(`common.effort.${level}`),
    })));

  const errorEl = h('p', { class: 'form-error', attrs: { role: 'alert' } });
  errorEl.hidden = true;

  function syncModeHint() {
    modeHint.textContent = t(`common.mode.${modeSelect.value}.hint`);
  }
  syncModeHint();

  /** @param {string} message */
  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = message === '';
  }

  /** @param {boolean} [force] */
  function toggleNewFolder(force) {
    const open = force ?? newFolderRow.hidden;
    newFolderRow.hidden = !open;
    newFolderButton.setAttribute('aria-expanded', String(open));
    if (open) {
      folderNameInput.value = '';
      folderNameInput.focus();
    }
  }

  /** @param {boolean} busy */
  function setBrowsing(busy) {
    browsing = busy;
    listEl.setAttribute('aria-busy', String(busy));
    syncActions();
  }

  function syncActions() {
    upButton.disabled = browsing || currentPath === null;
    newFolderButton.disabled = browsing || currentPath === null;
    const createButton = dialogHandle?.element.querySelector('.dialog-footer .btn-primary');
    if (createButton instanceof HTMLButtonElement) createButton.disabled = creating || browsing || currentPath === null;
  }

  function renderBrowser() {
    pathEl.textContent = currentPath ?? t('shell.newSession.roots');
    pathEl.title = currentPath ?? '';
    clear(listEl);
    if (entries.length === 0) {
      listEl.appendChild(h('li', {
        class: 'dir-empty',
        text: currentPath === null ? t('shell.newSession.noRoots') : t('shell.newSession.noFolders'),
      }));
      return;
    }
    for (const entry of entries) {
      listEl.appendChild(h('li', { class: 'dir-item' }, h('button', {
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
    const token = ++loadToken;
    setBrowsing(true);
    try {
      const query = path ? `?path=${encodeURIComponent(path)}` : '';
      const data = await api.get(`/api/fs/dirs${query}`);
      if (token !== loadToken) return;
      currentPath = typeof data.path === 'string' ? data.path : null;
      parentPath = typeof data.parent === 'string' ? data.parent : null;
      entries = Array.isArray(data.entries) ? data.entries : [];
      showError('');
      renderBrowser();
    } catch (err) {
      if (token !== loadToken) return;
      showError(errorText(err, t));
    } finally {
      if (token === loadToken) setBrowsing(false);
    }
  }

  async function createFolder() {
    const name = folderNameInput.value.trim();
    if (!currentPath || creating || browsing) return;
    if (!FOLDER_NAME_RE.test(name) || name === '.' || name === '..') {
      showError(t('shell.newSession.folderInvalid'));
      folderNameInput.focus();
      return;
    }
    folderCreateButton.disabled = true;
    try {
      const created = await api.post('/api/fs/mkdir', { parent: currentPath, name });
      toggleNewFolder(false);
      await load(created.path);
    } catch (err) {
      showError(errorText(err, t));
    } finally {
      folderCreateButton.disabled = false;
    }
  }

  /** @returns {Promise<void>} */
  async function create() {
    if (creating || !currentPath) return;
    creating = true;
    syncActions();
    showError('');
    const body = { cwd: currentPath, permissionMode: modeSelect.value };
    const title = titleInput.value.trim();
    const model = modelInput.value.trim();
    if (title) body.title = title;
    if (model) body.model = model;
    if (effortSelect.value) body.effort = effortSelect.value;
    try {
      const { live } = await api.post('/api/sessions', body);
      rememberCwd(currentPath);
      dialogHandle?.close();
      await actions.selectSession(live.sessionId);
    } catch (err) {
      showError(errorText(err, t));
    } finally {
      creating = false;
      syncActions();
    }
  }

  const body = h('div', { class: 'newsession' },
    h('div', { class: 'field' },
      h('span', { class: 'field-label', text: t('shell.newSession.folder') }),
      h('div', { class: 'dir-browser' },
        h('div', { class: 'dir-toolbar' }, upButton, pathEl, newFolderButton),
        newFolderRow,
        listEl)),
    h('div', { class: 'newsession-grid' },
      h('label', { class: 'field' },
        h('span', { class: 'field-label', text: t('shell.newSession.name') }),
        titleInput),
      h('label', { class: 'field' },
        h('span', { class: 'field-label', text: t('shell.newSession.model') }),
        modelInput,
        datalist)),
    h('div', { class: 'newsession-grid' },
      h('label', { class: 'field' },
        h('span', { class: 'field-label', text: t('shell.newSession.permissionMode') }),
        modeSelect,
        modeHint),
      h('label', { class: 'field' },
        h('span', { class: 'field-label', text: t('shell.newSession.effort') }),
        effortSelect)),
    errorEl);

  /** @type {{ close: () => void, element: HTMLElement } | null} */
  let dialogHandle = null;

  dialogHandle = openDialog({
    title: t('shell.newSession.title'),
    size: 'lg',
    body,
    actions: [
      { label: t('common.cancel'), kind: 'secondary' },
      { label: t('shell.newSession.create'), kind: 'primary', keepOpen: true, onClick: () => create() },
    ],
  });

  const remembered = readLastCwd();
  const startPath = remembered && isWithinRoots(remembered, roots)
    ? remembered
    : (roots.length === 1 ? roots[0] : null);
  syncActions();
  load(startPath).then(() => {
    if (currentPath === null && startPath !== null) return load(null);
    return undefined;
  });

  return dialogHandle;
}

/**
 * Model names suggested in the model field: every model reported by a cached capability set, plus the default.
 * @param {Record<string, { models?: Array<{ value?: string }> }>} capabilities
 * @param {string | null | undefined} fallback
 * @returns {string[]}
 */
function collectModelOptions(capabilities, fallback) {
  const values = new Set();
  for (const entry of Object.values(capabilities ?? {})) {
    for (const model of entry?.models ?? []) {
      if (typeof model?.value === 'string' && model.value) values.add(model.value);
    }
  }
  if (fallback) values.add(fallback);
  return [...values];
}
