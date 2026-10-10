/**
 * New-session dialog: browse workspace roots, pick a folder (or create one), set an optional title, model, permission
 * mode and effort, then start a live session and select it. The Advanced disclosure holds the agent, additional
 * directories, a fallback model and the browser tools. A permission mode left at "Follow Claude Code settings" is not
 * sent, so the runtime applies the settings exactly as the terminal does.
 */

import { h, clear, icon } from '../dom.js';
import { errorText } from '../api.js';
import { openDialog } from './dialog.js';

const LAST_CWD_KEY = 'caw.lastCwd';
const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const FOLDER_NAME_RE = /^[A-Za-z0-9._ -]{1,100}$/;
/** At most this many additional directories (docs/PROTOCOL.md, SessionSettings). */
const ADDITIONAL_DIRECTORY_LIMIT = 20;

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

/** @returns {boolean} true when no element holds the focus, which is what a re-rendered or disabled control leaves */
function focusIsLost() {
  return document.activeElement === null || document.activeElement === document.body;
}

/**
 * Moves the focus to the first of `targets` that takes it. A disabled button does not, so the next one is tried.
 * @param {Array<HTMLElement | null | undefined>} targets in order of preference
 */
function focusFirstOf(targets) {
  for (const target of targets) {
    if (!target?.isConnected) continue;
    target.focus({ preventScroll: true });
    if (document.activeElement === target) return;
  }
}

/**
 * Where the focus goes after a folder list was drawn again because the user acted on it. `focus.row` is the path of the
 * row that was activated, or of the folder that was left: that row when the new list has it, else the first row, else
 * the fallbacks in order. The focus moves only while it is still the list's own: it fell to the page body, or it is on
 * the list or one of the fallbacks. A focus the user moved elsewhere stays where it is.
 * @param {HTMLElement} list
 * @param {{row: string | null} | null} focus null when the list is drawn without the user's action
 * @param {Array<HTMLElement | null | undefined>} fallbacks
 */
function restoreListFocus(list, focus, fallbacks) {
  if (focus === null) return;
  const active = document.activeElement;
  if (!(focusIsLost() || list.contains(active) || fallbacks.includes(active))) return;
  const rows = [...list.querySelectorAll('.dir-row')];
  const preferred = focus.row === null ? undefined : rows.find((row) => row.dataset.path === focus.row);
  focusFirstOf([preferred, rows[0], ...fallbacks]);
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
  const profile = meta?.profile ?? store.get().auth?.profile ?? null;

  /** @type {string | null} */
  let currentPath = null;
  /** @type {string | null} */
  let parentPath = null;
  /** @type {Array<{name: string, path: string, isProject: boolean}>} */
  let entries = [];
  let loadToken = 0;
  let creating = false;
  let browsing = false;
  /** Additional directories chosen so far, in order. */
  /** @type {string[]} */
  const extraDirs = [];
  /** The folder the additional-directory browser shows, and what it lists. */
  let extraPath = /** @type {string | null} */ (null);
  let extraParent = /** @type {string | null} */ (null);
  /** @type {Array<{name: string, path: string, isProject: boolean}>} */
  let extraEntries = [];
  let extraToken = 0;

  const pathEl = h('span', { class: 'dir-path mono' });
  const listEl = h('ul', { class: 'dir-list', attrs: { 'aria-label': t('shell.newSession.folders') } });
  const upButton = h('button', {
    class: 'btn btn-ghost btn-sm dir-up',
    attrs: { type: 'button', 'aria-label': t('shell.newSession.up') },
    on: { click: () => load(parentPath, { row: currentPath }) },
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
        // Enter or Escape that commits an IME composition must neither create the folder nor close the row.
        if (event.isComposing || event.keyCode === 229) return;
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

  // "Follow Claude Code settings" is the default: the empty value leaves permissionMode out of the request.
  const modeHint = h('p', { class: 'field-hint' });
  const modeSelect = h('select', {
    class: 'select',
    attrs: { 'aria-describedby': 'new-session-mode-hint' },
    on: { change: () => syncModeHint() },
  },
  h('option', { attrs: { value: '', selected: true }, text: t('composer.modeWord.settings') }),
  modes.map((mode) => h('option', { attrs: { value: mode }, text: t(`common.mode.${mode}`) })));
  modeHint.id = 'new-session-mode-hint';

  const effortSelect = h('select', { class: 'select' },
    h('option', { attrs: { value: '', selected: !meta?.defaults?.effort }, text: t('common.effort.default') }),
    EFFORT_LEVELS.map((level) => h('option', {
      attrs: { value: level, selected: meta?.defaults?.effort === level },
      text: t(`common.effort.${level}`),
    })));

  // Advanced: the agent (a select of the known agents, free text when none is known), extra directories, a fallback
  // model (none by default) and the browser tools (full profile and a server that offers them).
  const agentNames = collectAgentNames(store.get().capabilities);
  const agentField = agentNames.length > 0
    ? h('select', { class: 'select', attrs: { id: 'new-session-agent' } },
      h('option', { attrs: { value: '', selected: true }, text: t('composer.advanced.noAgent') }),
      agentNames.map((name) => h('option', { attrs: { value: name }, text: name })))
    : h('input', {
      class: 'input',
      attrs: { id: 'new-session-agent', type: 'text', maxlength: 200, autocomplete: 'off', spellcheck: false,
        placeholder: t('composer.advanced.agentPlaceholder') },
    });
  const fallbackSelect = h('select', { class: 'select', attrs: { id: 'new-session-fallback' } },
    h('option', { attrs: { value: '', selected: true }, text: t('composer.advanced.noFallback') }),
    modelOptions.map((value) => h('option', { attrs: { value }, text: value })));
  const browserToolsBox = h('input', { attrs: { type: 'checkbox' } });
  const browserToolsRow = meta?.features?.browserTools === true && profile === 'full'
    ? h('label', { class: 'trust-check' }, browserToolsBox, h('span', { text: t('composer.advanced.browserTools') }))
    : null;

  const chipsEl = h('div', { class: 'dir-chips', attrs: { 'aria-label': t('composer.advanced.directories') } });
  const extraPathEl = h('span', { class: 'dir-extra-path mono' });
  const extraList = h('ul', { class: 'dir-list', attrs: { 'aria-label': t('composer.advanced.browse') } });
  const extraUp = h('button', {
    class: 'btn btn-ghost btn-sm',
    attrs: { type: 'button', 'aria-label': t('shell.newSession.up') },
    on: { click: () => loadExtra(extraParent, { row: extraPath }) },
  }, icon('chevron-right'), h('span', { text: t('shell.newSession.up') }));
  const extraAdd = h('button', {
    class: 'btn btn-secondary btn-sm',
    attrs: { type: 'button' },
    on: { click: () => addExtraDir(extraPath) },
  }, t('composer.advanced.addThis'));
  const extraBrowser = h('div', { class: 'dir-browser dir-browser-extra', attrs: { hidden: true } },
    h('div', { class: 'dir-toolbar' }, extraUp, extraPathEl, extraAdd),
    extraList);
  const extraToggle = h('button', {
    class: 'btn btn-ghost btn-sm',
    attrs: { type: 'button', 'aria-expanded': 'false' },
    on: { click: () => toggleExtraBrowser() },
  }, icon('folder'), h('span', { text: t('composer.advanced.addFolder') }));

  const errorEl = h('p', { class: 'form-error', attrs: { role: 'alert' } });
  errorEl.hidden = true;

  // Folder trust (docs/PROTOCOL.md): an untrusted folder starts with user settings only. The notice offers trust for
  // the folder on screen and trust is applied before the session starts. Read-profile viewers cannot change trust.
  const canTrust = profile !== 'read';
  /** @type {{path: string, trusted: boolean} | null} */
  let trustState = null;
  let trustToken = 0;
  const trustCheckbox = h('input', { attrs: { type: 'checkbox' } });
  trustCheckbox.checked = true;
  const trustNotice = h('div', { class: 'trust-notice' },
    icon('alert'),
    h('div', { class: 'trust-notice-body' },
      h('p', { class: 'trust-notice-title', text: t('shell.trust.noticeTitle') }),
      h('p', { class: 'trust-notice-text', text: t('shell.trust.noticeText') }),
      h('label', { class: 'trust-check' }, trustCheckbox, h('span', { text: t('shell.trust.checkbox') }))));
  trustNotice.hidden = true;

  function syncModeHint() {
    modeHint.textContent = modeSelect.value
      ? t(`common.mode.${modeSelect.value}.hint`)
      : t('composer.advanced.followHint');
  }
  syncModeHint();

  /** @param {string} message */
  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = message === '';
  }

  /** Show the notice only while the folder on screen is known to be untrusted. */
  function syncTrustNotice() {
    trustNotice.hidden = !(trustState !== null && !trustState.trusted && trustState.path === currentPath);
  }

  /** @param {string | null} path */
  async function refreshTrust(path) {
    const token = ++trustToken;
    trustState = null;
    syncTrustNotice();
    if (!path || !canTrust) return;
    try {
      const data = await api.get(`/api/fs/trust?path=${encodeURIComponent(path)}`);
      if (token !== trustToken) return;
      trustState = { path, trusted: data.trusted === true };
      trustCheckbox.checked = true;
    } catch (err) {
      if (token !== trustToken) return;
      showError(errorText(err, t));
    }
    syncTrustNotice();
  }

  /** @param {boolean} [force] */
  function toggleNewFolder(force) {
    const open = force ?? newFolderRow.hidden;
    // A row that hides while it holds the focus (Escape in its name field) hands the focus back to its button.
    const hadFocus = newFolderRow.contains(document.activeElement);
    newFolderRow.hidden = !open;
    newFolderButton.setAttribute('aria-expanded', String(open));
    if (open) {
      folderNameInput.value = '';
      folderNameInput.focus();
    } else if (hadFocus) {
      focusFirstOf([newFolderButton, upButton]);
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
        attrs: { type: 'button', title: entry.path, 'data-path': entry.path },
        on: { click: () => load(entry.path, { row: entry.path }) },
      },
      icon('folder'),
      h('span', { class: 'dir-name', text: entry.name }),
      entry.isProject ? h('span', { class: 'badge badge-accent', text: t('shell.newSession.project') }) : null,
      icon('chevron-right'))));
    }
  }

  /**
   * Lists a folder. `focus` is set when the user acted on the list (a row, or Up), and says where the focus goes once
   * the list is drawn again (see restoreListFocus). The focus moves after the buttons are enabled again, so Up can take
   * it.
   * @param {string | null} path
   * @param {{row: string | null} | null} [focus]
   */
  async function load(path, focus = null) {
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
      refreshTrust(currentPath);
    } catch (err) {
      if (token !== loadToken) return;
      showError(errorText(err, t));
    } finally {
      if (token === loadToken) {
        setBrowsing(false);
        restoreListFocus(listEl, focus, [upButton, newFolderButton, dialogCancel()]);
      }
    }
  }

  /** @returns {HTMLElement | null} the dialog's Cancel button, the last control that takes the focus after a list */
  function dialogCancel() {
    return dialogHandle?.element.querySelector('.dialog-footer .btn-secondary') ?? null;
  }

  /** Opens or closes the additional-directory browser; it starts at the folder the session starts in. */
  function toggleExtraBrowser() {
    const open = extraBrowser.hidden;
    extraBrowser.hidden = !open;
    extraToggle.setAttribute('aria-expanded', String(open));
    if (open) loadExtra(extraPath ?? currentPath ?? null);
  }

  /**
   * Lists a folder of the additional-directory browser. `focus` works as in load.
   * @param {string | null} path
   * @param {{row: string | null} | null} [focus]
   */
  async function loadExtra(path, focus = null) {
    const token = ++extraToken;
    try {
      const query = path ? `?path=${encodeURIComponent(path)}` : '';
      const data = await api.get(`/api/fs/dirs${query}`);
      if (token !== extraToken) return;
      extraPath = typeof data.path === 'string' ? data.path : null;
      extraParent = typeof data.parent === 'string' ? data.parent : null;
      extraEntries = Array.isArray(data.entries) ? data.entries : [];
      extraPathEl.textContent = extraPath ?? t('shell.newSession.roots');
      extraAdd.disabled = extraPath === null;
      extraUp.disabled = extraPath === null;
      clear(extraList);
      for (const entry of extraEntries) {
        extraList.appendChild(h('li', { class: 'dir-item' }, h('button', {
          class: 'dir-row',
          attrs: { type: 'button', title: entry.path, 'data-path': entry.path },
          on: { click: () => loadExtra(entry.path, { row: entry.path }) },
        }, icon('folder'), h('span', { class: 'dir-name', text: entry.name }), icon('chevron-right'))));
      }
      restoreListFocus(extraList, focus, [extraUp, extraAdd, extraToggle]);
    } catch (err) {
      if (token !== extraToken) return;
      showError(errorText(err, t));
    }
  }

  /**
   * Adds a folder to the additional directories: inside the roots, not the session folder itself, not listed yet, and
   * within the limit the runtime accepts.
   * @param {string | null} path
   */
  function addExtraDir(path) {
    if (!path || !currentPath) return;
    if (!isWithinRoots(path, roots) || path === currentPath) {
      showError(t('composer.advanced.notAllowed'));
      return;
    }
    if (extraDirs.includes(path)) return;
    if (extraDirs.length >= ADDITIONAL_DIRECTORY_LIMIT) {
      showError(t('composer.advanced.tooMany', { max: ADDITIONAL_DIRECTORY_LIMIT }));
      return;
    }
    extraDirs.push(path);
    showError('');
    renderChips();
  }

  /**
   * Removes a folder from the additional directories. Focus moves to the remove button now in the same place (the next
   * chip's, else the previous chip's), else to "Add folder", so it never falls back to the page.
   * @param {string} path
   */
  function removeExtraDir(path) {
    const index = extraDirs.indexOf(path);
    if (index >= 0) extraDirs.splice(index, 1);
    renderChips();
    const buttons = /** @type {HTMLButtonElement[]} */ ([...chipsEl.querySelectorAll('.dir-chip-remove')]);
    const next = buttons[Math.min(Math.max(index, 0), buttons.length - 1)] ?? extraToggle;
    next.focus();
  }

  function renderChips() {
    clear(chipsEl);
    if (extraDirs.length === 0) {
      chipsEl.hidden = true;
      return;
    }
    chipsEl.hidden = false;
    for (const path of extraDirs) {
      const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
      chipsEl.appendChild(h('span', { class: 'dir-chip', attrs: { title: path } },
        icon('folder'),
        h('span', { class: 'dir-chip-name', text: name }),
        h('button', {
          class: 'dir-chip-remove',
          attrs: { type: 'button', 'aria-label': t('composer.advanced.removeDir', { name }) },
          on: { click: () => removeExtraDir(path) },
        }, icon('x'))));
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
      await load(created.path, { row: null });
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
    /** @type {Record<string, unknown>} */
    const body = { cwd: currentPath };
    if (modeSelect.value) body.permissionMode = modeSelect.value;
    const title = titleInput.value.trim();
    const model = modelInput.value.trim();
    if (title) body.title = title;
    if (model) body.model = model;
    if (effortSelect.value) body.effort = effortSelect.value;
    const agent = agentField instanceof HTMLSelectElement || agentField instanceof HTMLInputElement
      ? agentField.value.trim() : '';
    if (agent) body.agent = agent;
    if (extraDirs.length > 0) body.additionalDirectories = [...extraDirs];
    if (fallbackSelect.value) body.fallbackModel = fallbackSelect.value;
    if (browserToolsRow && browserToolsBox.checked) body.browserTools = true;
    try {
      // Trust is applied before the session starts, so the new session loads the folder's project settings.
      if (trustState?.path === currentPath && !trustState.trusted && trustCheckbox.checked) {
        await api.post('/api/fs/trust', { path: currentPath, trusted: true });
        trustState = { path: currentPath, trusted: true };
        syncTrustNotice();
      }
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

  const advanced = h('details', { class: 'newsession-advanced' },
    h('summary', { class: 'newsession-advanced-toggle', text: t('composer.advanced.title') }),
    h('div', { class: 'newsession-grid' },
      h('label', { class: 'field', attrs: { for: 'new-session-agent' } },
        h('span', { class: 'field-label', text: t('composer.advanced.agent') }),
        agentField),
      h('label', { class: 'field', attrs: { for: 'new-session-fallback' } },
        h('span', { class: 'field-label', text: t('composer.advanced.fallback') }),
        fallbackSelect)),
    h('div', { class: 'field' },
      h('span', { class: 'field-label', text: t('composer.advanced.directories') }),
      chipsEl,
      h('div', { class: 'dir-browser-toggle' }, extraToggle),
      extraBrowser),
    browserToolsRow ? h('div', { class: 'field' }, browserToolsRow) : null);

  const body = h('div', { class: 'newsession' },
    h('div', { class: 'field' },
      h('span', { class: 'field-label', text: t('shell.newSession.folder') }),
      h('div', { class: 'dir-browser' },
        h('div', { class: 'dir-toolbar' }, upButton, pathEl, newFolderButton),
        newFolderRow,
        listEl),
      trustNotice),
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
    advanced,
    errorEl);

  /** @type {{ close: () => void, element: HTMLElement } | null} */
  let dialogHandle = null;

  // The controls start in the state they have before any folder is listed. This runs before the dialog opens, because
  // openDialog focuses the first enabled control: a button that is disabled a moment later would drop the focus.
  syncActions();
  dialogHandle = openDialog({
    title: t('shell.newSession.title'),
    size: 'lg',
    body,
    actions: [
      { label: t('common.cancel'), kind: 'secondary' },
      {
        label: t('shell.newSession.create'),
        kind: 'primary',
        keepOpen: true,
        // A function: the dialog reads it again when the call settles, so the state at that time decides.
        disabled: () => browsing || creating || currentPath === null,
        onClick: () => create(),
      },
    ],
  });

  renderChips();
  const remembered = readLastCwd();
  const startPath = remembered && isWithinRoots(remembered, roots)
    ? remembered
    : (roots.length === 1 ? roots[0] : null);
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

/**
 * Agent names from the cached capability sets (AgentInfo.name), in the order they were first seen. Empty when no set is
 * known, in which case the dialog takes free text.
 * @param {Record<string, { agents?: Array<{ name?: string }> }>} capabilities
 * @returns {string[]}
 */
function collectAgentNames(capabilities) {
  const names = new Set();
  for (const entry of Object.values(capabilities ?? {})) {
    for (const agent of entry?.agents ?? []) {
      if (typeof agent?.name === 'string' && agent.name.trim()) names.add(agent.name.trim());
    }
  }
  return [...names];
}
