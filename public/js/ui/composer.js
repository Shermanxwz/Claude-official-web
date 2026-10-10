import { errorText } from '../api.js';
import { clear, h, icon } from '../dom.js';
import {
  applyCompletion, detachChip, detectTrigger, draftKey, escapeAction, filterCommands, formatBytes, HISTORY_IDLE,
  isSendShortcut, joinRestoredText, keyDecision, mergeCommands, modeShortKey, modeWordKey, parseSideQuestion,
  promptHistory, runtimeHasCommand, stepHistory,
} from './composer-logic.js';
import { createRunningLine, createTodoBar } from './activity.js';
import { createSideQuestion } from './side-question.js';
import { hasOpenDialog } from './dialog.js';
import { openMenu } from './menu.js';
import { highlightText, openPalette } from './palette.js';
import { renderMarkdown } from '../markdown.js';

/**
 * Message composer: auto-growing input, send and stop, attachments (paste, drop, picker) uploaded as they are added,
 * per-session drafts, the `/` command and `@` file palettes, the permission mode footer, prompt history (↑ ↓), the side
 * question overlay, and the running line and todo bar above the field. Sending goes through `actions.sendMessage`.
 */

const BUSY_STATES = ['running', 'requires_action'];
const DRAFT_DEBOUNCE_MS = 400;
const MENTION_DEBOUNCE_MS = 120;
const MENTION_LIMIT = 50;
const MODE_FLASH_MS = 2000;
const SENT_HISTORY_LIMIT = 100;
const MOBILE_QUERY = '(max-width: 767.98px)';
const COARSE_QUERY = '(pointer: coarse)';
/** Narrow or touch layouts, which get the short placeholder because the command and file hint does not fit there. */
const COMPACT_QUERY = `${MOBILE_QUERY}, ${COARSE_QUERY}`;

/**
 * Commands the GUI implements, as the palette lists them (docs/FRONTEND.md). Picking one runs its panel or action;
 * typed text is never a GUI command, except `/btw <question>` when the runtime has no `btw` command.
 */
const GUI_COMMANDS = [
  { id: 'model', name: 'model' },
  { id: 'permissions', name: 'permissions' },
  { id: 'effort', name: 'effort' },
  { id: 'fast', name: 'fast' },
  { id: 'rewind', name: 'rewind' },
  { id: 'fork', name: 'fork' },
  { id: 'rename', name: 'rename' },
  { id: 'mcp', name: 'mcp' },
  { id: 'terminal', name: 'terminal', needsTerminal: true },
  { id: 'status', name: 'status' },
  { id: 'hooks', name: 'hooks' },
  { id: 'memory', name: 'memory' },
  { id: 'usage', name: 'usage' },
  { id: 'export', name: 'export' },
  { id: 'btw', name: 'btw' },
  { id: 'login', name: 'login' },
  { id: 'add-dir', name: 'add-dir' },
  { id: 'devtools', name: 'devtools' },
];
const HEADER_CONTROLS = { model: '.hdr-model', effort: '.hdr-effort' };
/** Permission modes the footer menu offers; bypassPermissions only when the server allows it (meta.features.bypass). */
const MODE_CHOICES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk'];

/**
 * @typedef {Object} Chip
 * @property {File} file
 * @property {string} name
 * @property {number} size
 * @property {string} mediaType
 * @property {'image'|'file'} kind
 * @property {'uploading'|'done'|'error'} status
 * @property {number} progress          0..1 while uploading
 * @property {string|null} path         absolute path returned by the upload
 * @property {string|null} error        localized message when status is 'error'; null if a remount cut the upload short
 * @property {boolean} retryable
 * @property {string|null} previewUrl   object URL for image thumbnails
 * @property {AbortController|null} controller
 * @property {{root: HTMLElement, fill: HTMLElement, meta: HTMLElement}|null} el
 */

/**
 * Per-session composer state that outlives a mount: the attachments waiting to be sent, the suggestion and the prompts
 * sent from this page (for ↑). A composer that is remounted, for example after a language change, finds what the
 * previous one left. An object URL is released only when its chip is removed or sent.
 * @type {Map<string, {chips: Chip[], suggestion: string|null, sent: string[]}>}
 */
const records = new Map();

/**
 * Composers on screen. A send that fails after its composer was replaced hands its text to the composer that shows the
 * session.
 * @type {Set<(id: string, text: string) => boolean>}
 */
const mounts = new Set();

/**
 * @param {string} id
 * @param {string} text
 * @returns {boolean} whether a mounted composer shows the session and took the text
 */
function restoreIntoMounted(id, text) {
  for (const restore of mounts) {
    if (restore(id, text)) return true;
  }
  return false;
}

/** @param {string} query */
function matchesMedia(query) {
  return globalThis.matchMedia?.(query).matches === true;
}

/**
 * Reports whether a media query matches now and whenever it changes. Returns the function that stops the watch.
 * @param {string} query
 * @param {(matches: boolean) => void} onChange
 * @returns {() => void}
 */
function watchQuery(query, onChange) {
  const list = globalThis.matchMedia?.(query);
  if (!list) {
    onChange(false);
    return () => {};
  }
  const listener = () => onChange(list.matches);
  listener();
  list.addEventListener('change', listener);
  return () => list.removeEventListener('change', listener);
}

/** @param {Chip} chip */
function revokeChip(chip) {
  if (chip.previewUrl && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(chip.previewUrl);
  chip.previewUrl = null;
}

/**
 * @param {Chip} chip
 * @param {(key: string, vars?: Record<string, unknown>) => string} t
 */
function chipStatusText(chip, t) {
  if (chip.status === 'uploading') return t('composer.attach.uploading', { percent: Math.round(chip.progress * 100) });
  if (chip.status === 'error') return chip.error ?? t('composer.attach.interrupted');
  return formatBytes(chip.size);
}

/**
 * @typedef {Object} ComposerDeps
 * @property {HTMLElement} container
 * @property {{get: (path: string, opts?: {signal?: AbortSignal}) => Promise<any>,
 *   upload: (cwd: string, file: Blob, name?: string, opts?: object) => Promise<any>}} api
 * @property {{get: () => any, set: (partial: object) => void, subscribe: (fn: () => void) => () => void}} store
 * @property {(key: string, vars?: Record<string, unknown>) => string} t
 * @property {Record<string, (...args: any[]) => any>} actions
 */

/**
 * @param {ComposerDeps} deps
 * @returns {{setSession: (id: string|null) => void, focus: () => void, insertText: (text: string) => void,
 *   setText: (text: string) => void, setSuggestion: (text: string|null) => void,
 *   setTodos: (todos: any[]|null) => void, setActivity: (activity: any) => void, destroy: () => void}}
 */
export function createComposer({ container, api, store, t, actions }) {
  const view = { id: /** @type {string|null} */ (null), disposed: false, capsRef: undefined, dragDepth: 0 };
  let palette = /** @type {ReturnType<typeof openPalette>|null} */ (null);
  let paletteKind = /** @type {'slash'|'mention'|null} */ (null);
  let mentionTimer = /** @type {ReturnType<typeof setTimeout>|null} */ (null);
  let mentionAbort = /** @type {AbortController|null} */ (null);
  let draftTimer = /** @type {ReturnType<typeof setTimeout>|null} */ (null);
  let historyState = HISTORY_IDLE;
  /** The footer's flash line after Shift+Tab; null while the footer shows the mode's words. */
  let flashText = /** @type {string|null} */ (null);
  let flashTimer = /** @type {ReturnType<typeof setTimeout>|null} */ (null);
  /** @type {any[]|null} */
  let todos = null;
  /** @type {{running: boolean, startedAt: number, text: string|null, outputTokens: number, queued: number}|null} */
  let activity = null;
  const coarse = matchesMedia(COARSE_QUERY);

  const emptyText = h('p', { class: 'composer-empty-text' });
  const emptyEl = h('div', { class: 'composer-empty' }, emptyText);

  const suggestionText = h('span', { class: 'composer-suggestion-text' });
  const suggestionEl = h('div', { class: 'composer-suggestion', hidden: true },
    h('button', {
      class: 'composer-suggestion-use',
      attrs: { type: 'button', title: t('composer.suggestion.use') },
      on: { click: useSuggestion },
    }, icon('spark'), suggestionText),
    h('button', {
      class: 'composer-icon-btn',
      attrs: { type: 'button', 'aria-label': t('composer.suggestion.dismiss') },
      on: { click: dismissSuggestion },
    }, icon('x')));

  const side = createSideQuestion({
    t,
    actions,
    renderMarkdown,
    onClose: (restoreFocus) => {
      if (restoreFocus && !view.disposed) input.focus();
    },
  });
  const runningLine = createRunningLine({ t, coarse });
  const todoBar = createTodoBar({ t });
  const noticeEl = h('div', { class: 'composer-notice', attrs: { role: 'status' }, hidden: true });
  const usageEl = h('div', { class: 'composer-usage', hidden: true });
  const queuedEl = h('div', { class: 'composer-queued', hidden: true, text: t('composer.queued') });
  const chipsEl = h('div', { class: 'composer-chips', attrs: { role: 'list' }, hidden: true });

  const input = /** @type {HTMLTextAreaElement} */ (h('textarea', {
    class: 'composer-input',
    attrs: {
      rows: 1,
      'aria-label': t('composer.label'),
      autocomplete: 'off',
      autocapitalize: 'sentences',
    },
    on: {
      input: onInput,
      keydown: onKeydown,
      keyup: onCaretKey,
      click: () => refreshPalette(),
      paste: onPaste,
      blur: onBlur,
    },
  }));
  const attachBtn = /** @type {HTMLButtonElement} */ (h('button', {
    class: 'composer-icon-btn composer-attach',
    attrs: { type: 'button', 'aria-label': t('composer.attach') },
    on: { click: () => fileInput.click() },
  }, icon('paperclip')));
  // A phone shows the short name (CSS hides the long one there); the tooltip always carries the full name.
  const modeText = h('span', { class: 'composer-mode-text' });
  const modeShort = h('span', { class: 'composer-mode-short' });
  const modeBtn = /** @type {HTMLButtonElement} */ (h('button', {
    class: 'composer-mode',
    attrs: { type: 'button', 'aria-haspopup': 'menu', title: t('composer.mode.title') },
    on: { click: () => openModeMenu() },
  }, modeText, modeShort));
  // On phones the label is hidden and the round button shows only its icon, so aria-label and title carry the name.
  const stopBtn = /** @type {HTMLButtonElement} */ (h('button', {
    class: 'composer-stop',
    attrs: { type: 'button', 'aria-label': t('composer.stop'), title: t('composer.stop'), hidden: true },
    on: {
      click: () => actions.interrupt(),
      contextmenu: (/** @type {MouseEvent} */ event) => {
        event.preventDefault();
        openStopMenu();
      },
    },
  }, icon('stop'), h('span', { class: 'btn-label', text: t('composer.stop') })));
  const stopMoreBtn = /** @type {HTMLButtonElement} */ (h('button', {
    class: 'composer-stop-more',
    attrs: { type: 'button', 'aria-label': t('composer.stopMenu'), 'aria-haspopup': 'menu', hidden: true },
    on: { click: () => openStopMenu() },
  }, icon('chevron-down')));
  const sendBtn = /** @type {HTMLButtonElement} */ (h('button', {
    class: 'composer-send',
    attrs: { type: 'button', 'aria-label': t('composer.send'), title: t('composer.send') },
    on: { click: () => send() },
  }, icon('send'), h('span', { class: 'btn-label', text: t('composer.send') })));
  // The group has its own border, so it is hidden with its buttons: an idle composer shows no empty pill.
  const stopGroup = h('div', { class: 'composer-stop-group', attrs: { hidden: true } }, stopBtn, stopMoreBtn);
  const footerEl = h('div', { class: 'composer-footer' },
    attachBtn,
    modeBtn,
    h('span', { class: 'composer-spacer', attrs: { 'aria-hidden': 'true' } }),
    h('div', { class: 'composer-actions' }, stopGroup, sendBtn));
  const box = h('div', { class: 'composer-box' }, input, footerEl);
  const dropEl = h('div', { class: 'composer-drop', hidden: true, attrs: { 'aria-hidden': 'true' } },
    icon('paperclip'), h('span', { text: t('composer.drop') }));
  const fileInput = /** @type {HTMLInputElement} */ (h('input', {
    attrs: { type: 'file', multiple: true, tabindex: '-1', 'aria-hidden': 'true', hidden: true },
    on: { change: onFilePicked },
  }));
  const shell = h('div', { class: 'composer-shell' },
    side.element, suggestionEl, todoBar.element, runningLine.element,
    noticeEl, usageEl, queuedEl, chipsEl, box, dropEl, fileInput);
  const root = h('section', { class: 'composer', attrs: { 'aria-label': t('composer.region') } }, emptyEl, shell);
  container.appendChild(root);

  root.addEventListener('dragenter', onDragEnter);
  root.addEventListener('dragover', onDragOver);
  root.addEventListener('dragleave', onDragLeave);
  root.addEventListener('drop', onDrop);
  const stopPlaceholderWatch = watchQuery(COMPACT_QUERY, (compact) => {
    input.placeholder = t(compact ? 'composer.placeholderShort' : 'composer.placeholder');
  });
  const unsubscribe = store.subscribe(onStoreChange);
  mounts.add(restoreText);
  sync();

  // ---- state

  /** @param {string} id */
  function recordFor(id) {
    let record = records.get(id);
    if (!record) {
      record = { chips: [], suggestion: null, sent: [] };
      records.set(id, record);
    }
    return record;
  }

  function currentRecord() {
    return view.id ? recordFor(view.id) : null;
  }

  /** Why the composer cannot take input right now, as a message key, or null. */
  function disabledReason() {
    if (!view.id) return 'composer.disabled.noSession';
    const s = store.get();
    const profile = s.auth?.profile ?? s.meta?.profile ?? 'full';
    if (profile === 'read') return 'composer.disabled.read';
    const live = s.live?.[view.id];
    if (live?.lockedBy === 'terminal' || s.terminal?.[view.id]?.attached) return 'composer.disabled.locked';
    return null;
  }

  function isBusy() {
    const state = view.id ? store.get().live?.[view.id]?.state : null;
    return BUSY_STATES.includes(state);
  }

  /** Whether a menu, a dialog or the side question is open, so that Escape belongs to it. */
  function overlayOpen() {
    return Boolean(document.querySelector('.menu')) || hasOpenDialog() || side.isOpen();
  }

  /** @returns {{chips: Chip[], uploading: boolean, failed: boolean, hasContent: boolean, canSend: boolean}} */
  function summary() {
    const chips = currentRecord()?.chips ?? [];
    const uploading = chips.some((chip) => chip.status === 'uploading');
    const failed = chips.some((chip) => chip.status === 'error');
    const hasContent = input.value.trim().length > 0 || chips.length > 0;
    const canSend = !disabledReason() && hasContent && !uploading && !failed;
    return { chips, uploading, failed, hasContent, canSend };
  }

  /** @param {string} id */
  function workspaceCwd(id) {
    const s = store.get();
    return s.live?.[id]?.cwd || (s.sessions ?? []).find((x) => x.sessionId === id)?.cwd || null;
  }

  function sync() {
    if (view.disposed) return;
    const s = store.get();
    const meta = s.meta ?? {};
    const profileRead = (s.auth?.profile ?? meta.profile) === 'read';
    const reason = disabledReason();
    const { chips, uploading, failed, hasContent, canSend } = summary();
    const busy = isBusy();
    const record = currentRecord();
    const text = input.value;
    const readOnly = reason === 'composer.disabled.read';

    // Without a session the welcome page offers the way in, so the composer stays out of its way. A read-only profile
    // keeps the one sentence that explains why no session can be started here.
    emptyText.textContent = t('composer.disabled.read');
    emptyEl.hidden = Boolean(view.id) || !profileRead;
    root.hidden = !view.id && !profileRead;
    shell.hidden = !view.id;
    if (!view.id) return;

    input.disabled = Boolean(reason);
    attachBtn.disabled = Boolean(reason) || meta.features?.uploads === false;
    modeBtn.disabled = Boolean(reason);
    sendBtn.disabled = !canSend;
    stopGroup.hidden = !busy || readOnly;
    stopBtn.hidden = !busy || readOnly;
    stopBtn.disabled = Boolean(reason);
    stopMoreBtn.hidden = !busy || readOnly;
    stopMoreBtn.disabled = Boolean(reason);
    queuedEl.hidden = !busy || !text.trim() || Boolean(reason);
    paintMode();

    const noticeKey = reason ?? (failed || uploading ? (hasContent ? 'composer.attach.blocked' : null) : null);
    noticeEl.hidden = !noticeKey;
    if (noticeKey) noticeEl.textContent = t(noticeKey);

    const suggestion = reason ? null : record?.suggestion ?? null;
    suggestionEl.hidden = !suggestion;
    if (suggestion && suggestionText.textContent !== suggestion) suggestionText.textContent = suggestion;

    chipsEl.hidden = chips.length === 0;
    sendBtn.title = failed || uploading ? t('composer.attach.blocked') : t('composer.send');
    updateUsage(s);
  }

  /** The footer's mode line: the mode in words, or the flash line for two seconds after Shift+Tab. */
  function paintMode() {
    const live = view.id ? store.get().live?.[view.id] : null;
    const mode = live?.permissionMode ?? null;
    const word = flashText ?? t(modeWordKey(mode));
    if (modeText.textContent !== word) modeText.textContent = word;
    const short = flashText ?? t(modeShortKey(mode));
    if (modeShort.textContent !== short) modeShort.textContent = short;
    const tooltip = `${t('composer.mode.title')}: ${t(modeWordKey(mode))}`;
    if (modeBtn.title !== tooltip) modeBtn.title = tooltip;
    footerEl.classList.toggle('is-flash', flashText !== null);
  }

  /** Shows the argument hint of a Claude Code command that has been typed without arguments yet. */
  function updateUsage(s) {
    const match = /^\/(\S+)\s$/u.exec(input.value);
    const command = match && !palette?.isOpen()
      ? (s.capabilities?.[view.id]?.commands ?? []).find((c) => c.name === match[1] && c.argumentHint)
      : null;
    usageEl.hidden = !command;
    if (command) usageEl.textContent = t('composer.usage', { command: command.name, hint: command.argumentHint });
  }

  function onStoreChange() {
    if (view.disposed) return;
    const caps = view.id ? store.get().capabilities?.[view.id] : undefined;
    const capsChanged = caps !== view.capsRef;
    view.capsRef = caps;
    if (capsChanged && palette?.isOpen() && paletteKind === 'slash') refreshPalette();
    sync();
  }

  // ---- running line, todo bar, permission mode

  /** @param {any[]|null} next */
  function applyTodos(next) {
    todos = Array.isArray(next) ? next : null;
    paintSummary();
  }

  /** @param {any} next */
  function applyActivity(next) {
    activity = next && typeof next === 'object' ? next : null;
    paintSummary();
    sync();
  }

  function paintSummary() {
    const running = Boolean(activity?.running);
    runningLine.update(activity);
    todoBar.update(todos, running);
  }

  /** Shift+Tab: the shell moves to the next permission mode and says which one it is now. */
  function cycleMode() {
    if (!view.id || disabledReason()) return;
    let next;
    try {
      next = Promise.resolve(actions.cyclePermissionMode?.());
    } catch (err) {
      next = Promise.reject(err);
    }
    next.then((mode) => {
      if (typeof mode !== 'string' || view.disposed) return;
      flashText = t('composer.mode.changed', { mode: t(modeWordKey(mode)) });
      clearTimeout(flashTimer ?? undefined);
      flashTimer = setTimeout(() => {
        flashTimer = null;
        flashText = null;
        paintMode();
      }, MODE_FLASH_MS);
      paintMode();
    }, (err) => actions.toast(errorText(err, t), 'error'));
  }

  function openModeMenu() {
    if (!view.id || disabledReason()) return;
    const meta = store.get().meta ?? {};
    const live = store.get().live?.[view.id];
    const current = live?.permissionMode ?? null;
    const modes = meta.features?.bypass ? [...MODE_CHOICES, 'bypassPermissions'] : MODE_CHOICES;
    openMenu(modeBtn, modes.map((mode) => ({
      label: t(modeWordKey(mode)),
      checked: mode === current,
      onClick: () => actions.updateSettings({ permissionMode: mode }),
    })), { label: t('composer.mode.title') });
  }

  /** The stop menu: "Stop", and "Stop and clear the queue" while a message waits behind the running turn. */
  function openStopMenu() {
    if (!view.id || !isBusy()) return;
    /** @type {Array<{label: string, icon: string, danger?: boolean, onClick: () => void}>} */
    const items = [{ label: t('composer.stop'), icon: 'stop', onClick: () => actions.interrupt() }];
    if ((activity?.queued ?? 0) > 0) {
      items.push({
        label: t('composer.stopClear'),
        icon: 'trash',
        danger: true,
        onClick: () => actions.interrupt({ cancelQueued: true }),
      });
    }
    openMenu(stopBtn, items, { label: t('composer.stopMenu') });
  }

  // ---- text and drafts

  function autosize() {
    input.style.height = 'auto';
    const max = Math.round(globalThis.innerHeight * 0.4);
    input.style.height = `${Math.min(input.scrollHeight, max)}px`;
    input.style.overflowY = input.scrollHeight > max ? 'auto' : 'hidden';
  }

  function onTextChanged() {
    autosize();
    scheduleDraftSave();
    sync();
  }

  /** @param {string} id @param {string} text */
  function saveDraft(id, text) {
    const key = draftKey(id);
    if (!key) return;
    try {
      if (text) localStorage.setItem(key, text);
      else localStorage.removeItem(key);
    } catch {
      // Storage can be blocked or full; drafts are a convenience, so the composer keeps working without them.
    }
  }

  /** @param {string} id */
  function loadDraft(id) {
    const key = draftKey(id);
    if (!key) return '';
    try {
      return localStorage.getItem(key) ?? '';
    } catch {
      return '';
    }
  }

  function scheduleDraftSave() {
    if (draftTimer) clearTimeout(draftTimer);
    const id = view.id;
    const text = input.value;
    draftTimer = setTimeout(() => {
      draftTimer = null;
      if (id) saveDraft(id, text);
    }, DRAFT_DEBOUNCE_MS);
  }

  function flushDraft() {
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = null;
    if (view.id) saveDraft(view.id, input.value);
  }

  // ---- keyboard and input

  function onInput() {
    // Typing is an edit: the field keeps what it shows and the history walk ends.
    historyState = HISTORY_IDLE;
    refreshPalette();
    onTextChanged();
  }

  /** @param {KeyboardEvent} event */
  function onCaretKey(event) {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) refreshPalette();
  }

  function onBlur() {
    closePalette();
    sync();
  }

  /** @param {KeyboardEvent} event */
  function onKeydown(event) {
    if (event.isComposing || event.keyCode === 229) return;
    if (palette?.isOpen()) {
      const plain = !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        palette.move(1);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        palette.move(-1);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closePalette();
        sync();
        return;
      }
      if ((event.key === 'Tab' && plain) || (event.key === 'Enter' && plain)) {
        if (palette.pick()) {
          event.preventDefault();
          return;
        }
      }
    }
    const action = keyDecision(event, {
      paletteOpen: Boolean(palette?.isOpen()),
      browsing: historyState.index >= 0,
      running: isBusy(),
      blocked: overlayOpen(),
      text: input.value,
      caret: input.selectionStart ?? 0,
    });
    switch (action) {
      case 'mode-cycle':
        event.preventDefault();
        cycleMode();
        return;
      case 'escape':
        onEscape(event);
        return;
      case 'history-prev':
        event.preventDefault();
        walkHistory('prev');
        return;
      case 'history-next':
        event.preventDefault();
        walkHistory('next');
        return;
      default:
        break;
    }
    if (isSendShortcut(event, { coarse: matchesMedia(COARSE_QUERY) })) {
      event.preventDefault();
      send();
    }
  }

  /** @param {KeyboardEvent} event */
  function onEscape(event) {
    event.preventDefault();
    const action = escapeAction({ browsing: historyState.index >= 0, running: isBusy(), blocked: overlayOpen() });
    if (action === 'leave-history') {
      input.value = historyState.draft;
      historyState = HISTORY_IDLE;
      onTextChanged();
      return;
    }
    if (action === 'interrupt') {
      actions.interrupt();
      return;
    }
    input.blur();
  }

  /** @param {'prev'|'next'} action */
  function walkHistory(action) {
    const id = view.id;
    if (!id) return;
    const result = stepHistory(historyState, action, historyEntries(id), input.value);
    if (!result) return;
    historyState = result.state;
    input.value = result.text;
    input.setSelectionRange(result.text.length, result.text.length);
    onTextChanged();
  }

  /**
   * The prompts ↑ recalls for a session, newest first: the user messages of the loaded transcript (through
   * actions.sessionPrompts, when the shell provides it) plus the prompts sent from this page.
   * @param {string} id
   * @returns {string[]}
   */
  function historyEntries(id) {
    const transcript = typeof actions.sessionPrompts === 'function' ? actions.sessionPrompts(id) : [];
    return promptHistory(Array.isArray(transcript) ? transcript : [], recordFor(id).sent);
  }

  /** @param {ClipboardEvent} event */
  function onPaste(event) {
    const files = event.clipboardData?.files;
    if (!files || files.length === 0 || disabledReason()) return;
    event.preventDefault();
    addFiles(Array.from(files));
  }

  // ---- palettes

  function refreshPalette() {
    if (view.disposed) return;
    const trigger = view.id && !input.disabled ? detectTrigger(input.value, input.selectionStart) : null;
    if (!trigger) {
      closePalette();
      sync();
      return;
    }
    if (trigger.type === 'slash') {
      if (!store.get().capabilities?.[view.id]) loadCommands(view.id);
      const rows = filterCommands(commandRows(view.id), trigger.query);
      showPalette('slash', rows, trigger.query, t('composer.slash.empty'));
      return;
    }
    if (paletteKind !== 'mention' || !palette?.isOpen()) {
      showPalette('mention', [], trigger.query, t('composer.mention.searching'));
    }
    scheduleMention(trigger.query);
  }

  /** @param {string} id */
  function commandRows(id) {
    const s = store.get();
    const meta = s.meta ?? {};
    const profile = s.auth?.profile ?? meta.profile ?? 'full';
    const terminalOn = meta.features?.terminal === true && profile === 'full';
    const gui = GUI_COMMANDS
      .filter((command) => !command.needsTerminal || terminalOn)
      .map((command) => ({ id: command.id, name: command.name, description: t(`composer.cmd.${command.id}`) }));
    return mergeCommands(s.capabilities?.[id]?.commands ?? [], gui);
  }

  /**
   * @param {'slash'|'mention'} kind
   * @param {Array<any>} rows
   * @param {string} query
   * @param {string} emptyText
   */
  function showPalette(kind, rows, query, emptyText) {
    if (palette?.isOpen() && paletteKind === kind) {
      palette.update(rows, query, emptyText);
      return;
    }
    closePalette();
    paletteKind = kind;
    palette = openPalette({
      anchor: shell,
      items: rows,
      onPick: (item) => pickRow(kind, item),
      renderItem: (item, q) => renderRow(kind, item, q),
      emptyText,
      label: t(kind === 'slash' ? 'composer.palette.commands' : 'composer.palette.files'),
      input,
      query,
    });
    if (kind === 'slash') {
      // The open palette's own element: the shortcut hint stays with it until it closes.
      const root = shell.querySelector(':scope > .palette');
      if (root && !root.querySelector('.palette-hint')) {
        root.append(h('p', { class: 'palette-hint', text: t('composer.palette.hint') }));
      }
    }
  }

  function closePalette() {
    if (mentionTimer) clearTimeout(mentionTimer);
    mentionTimer = null;
    mentionAbort?.abort();
    mentionAbort = null;
    palette?.close();
    palette = null;
    paletteKind = null;
  }

  /** @param {'slash'|'mention'} kind @param {any} item @param {string} query */
  function renderRow(kind, item, query) {
    if (kind === 'mention') {
      return [
        icon(item.type === 'dir' ? 'folder' : 'file'),
        h('span', { class: 'palette-path' }, highlightText(item.path, query)),
      ];
    }
    let badge = '';
    if (item.source === 'gui') badge = item.shadowed ? t('composer.palette.panel') : t('composer.palette.app');
    else if (item.builtin) badge = t('composer.palette.builtin');
    return [
      h('span', { class: 'palette-main' },
        h('span', { class: 'palette-name' }, '/', highlightText(item.name, query)),
        item.argumentHint ? h('span', { class: 'palette-args', text: item.argumentHint }) : null),
      h('span', { class: 'palette-desc', text: item.description }),
      badge ? h('span', { class: 'palette-badge', text: badge }) : null,
    ];
  }

  /** @param {'slash'|'mention'} kind @param {any} item */
  function pickRow(kind, item) {
    if (kind === 'mention') {
      replaceTrigger(`@${item.path} `);
      return;
    }
    // A GUI row runs its panel or action; a runtime row types the command, which the runtime then runs.
    if (item.source === 'gui') {
      input.value = '';
      closePalette();
      onTextChanged();
      runGuiCommand(item.guiId);
      return;
    }
    replaceTrigger(`/${item.name} `);
  }

  /** @param {string} replacement */
  function replaceTrigger(replacement) {
    const trigger = detectTrigger(input.value, input.selectionStart);
    closePalette();
    if (trigger) {
      const result = applyCompletion(input.value, trigger, input.selectionStart, replacement);
      input.value = result.text;
      input.setSelectionRange(result.caret, result.caret);
    }
    onTextChanged();
    input.focus();
  }

  /** @param {string} guiId */
  function runGuiCommand(guiId) {
    switch (guiId) {
      case 'model':
      case 'effort':
        focusHeaderSetting(guiId);
        break;
      case 'permissions':
        actions.openPanel('runtime', { tab: 'permissions' });
        break;
      case 'fast':
        toggleFast();
        break;
      case 'rewind':
        actions.openRewind();
        break;
      case 'fork':
        actions.openFork();
        break;
      case 'rename':
        actions.renameSession();
        break;
      case 'mcp':
        actions.openPanel('capabilities', { section: 'mcp' });
        break;
      case 'terminal':
        actions.openTerminal();
        break;
      case 'status':
      case 'hooks':
      case 'memory':
      case 'usage':
        actions.openPanel('runtime', { tab: guiId });
        break;
      case 'export':
        runAsync(() => actions.exportConversation());
        break;
      case 'btw':
        side.open(null);
        break;
      case 'login':
        actions.openPanel('settings', { section: 'account' });
        break;
      case 'add-dir':
        actions.openPanel('session', { section: 'directories' });
        break;
      case 'devtools':
        actions.openPanel('developer');
        break;
      default:
        break;
    }
  }

  /** @param {() => unknown} work a shell action that may reject; the rejection is reported as a toast */
  function runAsync(work) {
    Promise.resolve()
      .then(work)
      .catch((err) => actions.toast(errorText(err, t), 'error'));
  }

  /**
   * The GUI `/fast` command: flips fast mode the way the header toggle does. When the session's model does not offer
   * fast mode and nothing requests or runs it, the command says so instead.
   */
  /** The header owns the fast mode control, including a change still in flight, so `/fast` goes through it. */
  function toggleFast() {
    if (!view.id) return;
    if (!actions.toggleFastMode?.()) actions.toast(t('composer.fastUnavailable'), 'info');
  }

  /** @param {string} guiId */
  function focusHeaderSetting(guiId) {
    const header = /** @type {HTMLElement|null} */ (document.querySelector('.session-header'));
    const control = /** @type {HTMLSelectElement|null} */ (header?.querySelector(HEADER_CONTROLS[guiId]) ?? null);
    if (control && !control.hidden && !control.disabled) {
      control.focus();
      return;
    }
    const more = /** @type {HTMLElement|null} */ (header?.querySelector('.hdr-more') ?? null);
    if (more && matchesMedia(MOBILE_QUERY)) {
      more.click();
      return;
    }
    actions.toast(t('composer.settingUnavailable'), 'info');
  }

  /** @param {string} id */
  async function loadCommands(id) {
    try {
      const capabilities = await api.get(`/api/sessions/${encodeURIComponent(id)}/capabilities`);
      store.set({ capabilities: { ...store.get().capabilities, [id]: capabilities } });
    } catch {
      // The palette keeps offering the GUI commands; the next `/` retries.
    }
  }

  /** @param {string} query */
  function scheduleMention(query) {
    if (mentionTimer) clearTimeout(mentionTimer);
    mentionTimer = setTimeout(() => runMention(query), MENTION_DEBOUNCE_MS);
  }

  /** @param {string} query */
  async function runMention(query) {
    mentionTimer = null;
    mentionAbort?.abort();
    const controller = new AbortController();
    mentionAbort = controller;
    const id = view.id;
    const cwd = id ? workspaceCwd(id) : null;
    if (!cwd) {
      mentionAbort = null;
      showPalette('mention', [], query, t('composer.mention.unavailable'));
      sync();
      return;
    }
    // The session makes the runtime's own @ index answer first (docs/PROTOCOL.md, file search).
    const path = `/api/fs/search?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(query)}&limit=${MENTION_LIMIT}`
      + `&session=${encodeURIComponent(id ?? '')}`;
    try {
      const data = await api.get(path, { signal: controller.signal });
      if (controller.signal.aborted) return;
      mentionAbort = null;
      if (!stillTriggered('mention', query, id)) return;
      showPalette('mention', Array.isArray(data?.results) ? data.results : [], query, t('composer.mention.empty'));
    } catch (err) {
      if (controller.signal.aborted) return;
      mentionAbort = null;
      if (!stillTriggered('mention', query, id)) return;
      showPalette('mention', [], query, errorText(err, t));
    }
    sync();
  }

  /** @param {'slash'|'mention'} kind @param {string} query @param {string|null} id */
  function stillTriggered(kind, query, id) {
    if (view.id !== id) return false;
    const trigger = detectTrigger(input.value, input.selectionStart);
    return trigger?.type === kind && trigger.query === query;
  }

  // ---- sending

  function send() {
    const id = view.id;
    const { canSend, hasContent } = summary();
    if (!id || !canSend || !hasContent) return;
    const record = recordFor(id);
    const text = input.value.replace(/\s+$/u, '');
    // `/btw <question>` is the side question when the runtime has no btw command of its own; it never enters the
    // transcript.
    const question = parseSideQuestion(text);
    if (question !== null && !runtimeHasCommand(store.get().capabilities?.[id]?.commands, 'btw')) {
      historyState = HISTORY_IDLE;
      input.value = '';
      closePalette();
      saveDraft(id, '');
      onTextChanged();
      side.open(question);
      return;
    }
    const sent = record.chips;
    const attachments = sent
      .filter((chip) => chip.status === 'done')
      .map((chip) => ({ path: chip.path, name: chip.name, kind: chip.kind, mediaType: chip.mediaType }));
    record.chips = [];
    if (text.trim()) record.sent = [...record.sent, text].slice(-SENT_HISTORY_LIMIT);
    historyState = HISTORY_IDLE;
    input.value = '';
    closePalette();
    saveDraft(id, '');
    renderChips();
    onTextChanged();

    let pending;
    try {
      pending = Promise.resolve(actions.sendMessage({ text, attachments }));
    } catch (err) {
      pending = Promise.reject(err);
    }
    // The shell reports a rejected send itself (it resolves false and keeps the message in the timeline), so only an
    // unexpected rejection restores the text here.
    pending.then(
      () => {
        for (const chip of sent) revokeChip(chip);
      },
      (err) => restoreAfterFailure(id, text, sent, err),
    );
  }

  /**
   * Puts a message that failed to send back into this composer, when it shows the session that sent it.
   * @param {string} id
   * @param {string} text
   * @returns {boolean}
   */
  function restoreText(id, text) {
    if (view.disposed || view.id !== id) return false;
    input.value = joinRestoredText(text, input.value);
    renderChips();
    onTextChanged();
    return true;
  }

  /**
   * A send that the shell rejected unexpectedly: its attachments and text come back. A composer that shows the session
   * takes the text in place; otherwise the text is kept as that session's draft.
   * @param {string} id
   * @param {string} text
   * @param {Chip[]} chips
   * @param {unknown} err
   */
  function restoreAfterFailure(id, text, chips, err) {
    const record = recordFor(id);
    record.chips = [...chips, ...record.chips];
    if (!restoreIntoMounted(id, text) && text) saveDraft(id, joinRestoredText(text, loadDraft(id)));
    actions.toast(errorText(err, t), 'error');
    sync();
  }

  // ---- attachments

  /** @param {Array<File|Blob>} files */
  function addFiles(files) {
    const id = view.id;
    if (!id || disabledReason()) return;
    const meta = store.get().meta ?? {};
    if (meta.features?.uploads === false) {
      actions.toast(t('composer.attach.disabled'), 'info');
      return;
    }
    const record = recordFor(id);
    for (const file of files) {
      const named = /** @type {File} */ (file);
      const kind = named.type?.startsWith('image/') ? 'image' : 'file';
      /** @type {Chip} */
      const chip = {
        file: named,
        name: named.name || 'file',
        size: named.size,
        mediaType: named.type || 'application/octet-stream',
        kind,
        status: 'uploading',
        progress: 0,
        path: null,
        error: null,
        retryable: true,
        previewUrl: kind === 'image' && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(named) : null,
        controller: null,
        el: null,
      };
      record.chips.push(chip);
      const limits = meta.limits ?? {};
      if (kind === 'image' && limits.imageMaxBytes && named.size > limits.imageMaxBytes) {
        failChip(chip, t('composer.attach.imageTooLarge', { max: formatBytes(limits.imageMaxBytes) }), false);
      } else if (limits.uploadMaxBytes && named.size > limits.uploadMaxBytes) {
        failChip(chip, t('composer.attach.tooLarge', { max: formatBytes(limits.uploadMaxBytes) }), false);
      } else {
        startUpload(id, chip);
      }
    }
    if (view.id === id) renderChips();
    sync();
  }

  /**
   * @param {string} id
   * @param {Chip} chip
   */
  function startUpload(id, chip) {
    const cwd = workspaceCwd(id);
    if (!cwd) {
      failChip(chip, t('composer.attach.noCwd'), false);
      afterChipChange(id);
      return;
    }
    const controller = new AbortController();
    chip.controller = controller;
    chip.status = 'uploading';
    chip.progress = 0;
    chip.error = null;
    api.upload(cwd, chip.file, chip.name, {
      signal: controller.signal,
      onProgress: (fraction) => {
        chip.progress = fraction;
        if (view.id === id && chip.el) {
          chip.el.fill.style.setProperty('width', `${Math.round(fraction * 100)}%`);
          chip.el.meta.textContent = chipStatusText(chip, t);
        }
      },
    }).then((result) => {
      if (controller.signal.aborted) return;
      Object.assign(chip, {
        status: 'done',
        progress: 1,
        path: result.path,
        size: result.size,
        mediaType: result.mediaType,
        kind: result.kind,
        controller: null,
      });
      afterChipChange(id);
    }, (err) => {
      if (controller.signal.aborted) return;
      failChip(chip, errorText(err, t), true);
      afterChipChange(id);
    });
  }

  /**
   * @param {Chip} chip
   * @param {string} message
   * @param {boolean} retryable
   */
  function failChip(chip, message, retryable) {
    chip.status = 'error';
    chip.error = message;
    chip.retryable = retryable;
    chip.controller = null;
  }

  /** @param {string} id */
  function afterChipChange(id) {
    if (view.id === id) renderChips();
    sync();
  }

  /** @param {Chip} chip */
  function retryChip(chip) {
    const id = view.id;
    if (!id) return;
    startUpload(id, chip);
    renderChips();
    sync();
  }

  /** @param {Chip} chip */
  function removeChip(chip) {
    chip.controller?.abort();
    revokeChip(chip);
    const record = currentRecord();
    if (record) record.chips = record.chips.filter((candidate) => candidate !== chip);
    renderChips();
    sync();
  }

  function renderChips() {
    const chips = currentRecord()?.chips ?? [];
    clear(chipsEl);
    chipsEl.hidden = chips.length === 0;
    for (const chip of chips) chipsEl.appendChild(renderChip(chip));
  }

  /** @param {Chip} chip */
  function renderChip(chip) {
    const thumb = chip.previewUrl
      ? h('img', { class: 'chip-thumb', attrs: { src: chip.previewUrl, alt: '' } })
      : h('span', { class: 'chip-thumb chip-thumb-file', attrs: { 'aria-hidden': 'true' } },
        icon(chip.kind === 'image' ? 'image' : 'file'));
    const fill = h('span', { class: 'chip-fill' });
    const meta = h('span', { class: 'chip-meta', text: chipStatusText(chip, t) });
    const actionsEl = [];
    if (chip.status === 'error' && chip.retryable) {
      actionsEl.push(h('button', {
        class: 'chip-action',
        attrs: { type: 'button' },
        on: { click: () => retryChip(chip) },
      }, t('composer.attach.retry')));
    }
    const remove = h('button', {
      class: 'chip-remove',
      attrs: { type: 'button', 'aria-label': t('composer.attach.remove', { name: chip.name }) },
      on: { click: () => removeChip(chip) },
    }, icon('x'));
    const node = h('div', { class: `chip is-${chip.status}`, attrs: { role: 'listitem', title: chip.name } },
      thumb,
      h('span', { class: 'chip-body' },
        h('span', { class: 'chip-name', text: chip.name }),
        meta,
        chip.status === 'uploading'
          ? h('span', { class: 'chip-track', attrs: { 'aria-hidden': 'true' } }, fill)
          : null),
      actionsEl,
      remove);
    chip.el = { root: node, fill, meta };
    if (chip.status === 'uploading') fill.style.setProperty('width', `${Math.round(chip.progress * 100)}%`);
    return node;
  }

  function onFilePicked() {
    const files = Array.from(fileInput.files ?? []);
    fileInput.value = '';
    addFiles(files);
  }

  /** @param {DragEvent} event */
  function hasFiles(event) {
    return Array.from(event.dataTransfer?.types ?? []).includes('Files');
  }

  /** @param {boolean} visible */
  function showDrop(visible) {
    dropEl.hidden = !visible;
  }

  /** @param {DragEvent} event */
  function onDragEnter(event) {
    if (!hasFiles(event) || disabledReason()) return;
    event.preventDefault();
    view.dragDepth += 1;
    showDrop(true);
  }

  /** @param {DragEvent} event */
  function onDragOver(event) {
    if (!hasFiles(event) || disabledReason()) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  }

  /** @param {DragEvent} event */
  function onDragLeave(event) {
    if (!hasFiles(event)) return;
    view.dragDepth = Math.max(0, view.dragDepth - 1);
    if (view.dragDepth === 0) showDrop(false);
  }

  /** @param {DragEvent} event */
  function onDrop(event) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    view.dragDepth = 0;
    showDrop(false);
    if (!disabledReason() && event.dataTransfer?.files) addFiles(Array.from(event.dataTransfer.files));
  }

  // ---- suggestions

  function useSuggestion() {
    const record = currentRecord();
    if (!record?.suggestion || disabledReason()) return;
    const suggestion = record.suggestion;
    record.suggestion = null;
    input.value = input.value.trim() ? `${input.value.replace(/\s+$/u, '')}\n${suggestion}` : suggestion;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    onTextChanged();
  }

  function dismissSuggestion() {
    const record = currentRecord();
    if (record) record.suggestion = null;
    sync();
  }

  return {
    setSession(sessionId) {
      const next = typeof sessionId === 'string' && sessionId ? sessionId : null;
      if (next === view.id) {
        sync();
        return;
      }
      flushDraft();
      closePalette();
      side.close({ restoreFocus: false });
      historyState = HISTORY_IDLE;
      view.id = next;
      view.capsRef = next ? store.get().capabilities?.[next] : undefined;
      input.value = next ? loadDraft(next) : '';
      applyTodos(null);
      applyActivity(null);
      autosize();
      renderChips();
      sync();
    },
    focus() {
      if (!input.disabled) input.focus();
    },
    insertText(text) {
      if (typeof text !== 'string' || !text || disabledReason()) return;
      const start = input.selectionStart;
      const end = input.selectionEnd;
      input.setRangeText(text, start, end, 'end');
      input.focus();
      refreshPalette();
      onTextChanged();
    },
    /** Replaces the field's text (the refused prompt that an edit brings back, for example). */
    setText(text) {
      if (!view.id || disabledReason()) return;
      input.value = typeof text === 'string' ? text : '';
      historyState = HISTORY_IDLE;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      onTextChanged();
    },
    setSuggestion(text) {
      if (!view.id) return;
      recordFor(view.id).suggestion = typeof text === 'string' && text.trim() ? text : null;
      sync();
    },
    /** @param {any[]|null} list the latest todos of the session, or null */
    setTodos(list) {
      applyTodos(list);
    },
    /** @param {any} next the running turn (docs/FRONTEND.md activity), or null while idle */
    setActivity(next) {
      applyActivity(next);
    },
    destroy() {
      if (view.disposed) return;
      flushDraft();
      view.disposed = true;
      unsubscribe();
      stopPlaceholderWatch();
      mounts.delete(restoreText);
      if (mentionTimer) clearTimeout(mentionTimer);
      if (flashTimer) clearTimeout(flashTimer);
      closePalette();
      runningLine.destroy();
      side.close({ restoreFocus: false });
      // The chips outlive this composer with their thumbnails, so object URLs stay until a chip is removed or sent.
      for (const record of records.values()) {
        for (const chip of record.chips) detachChip(chip)?.abort();
      }
      root.remove();
    },
  };
}
