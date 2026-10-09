import { errorText } from '../api.js';
import { clear, h, icon } from '../dom.js';
import {
  applyCompletion, detachChip, detectTrigger, draftKey, filterCommands, formatBytes, isSendShortcut, joinRestoredText,
  mergeCommands,
} from './composer-logic.js';
import { highlightText, openPalette } from './palette.js';

/**
 * Message composer: auto-growing input, send and stop, attachments (paste, drop, picker) uploaded as they are added,
 * per-session drafts, and the `/` command and `@` file palettes. Sending goes through `actions.sendMessage`.
 */

const BUSY_STATES = ['running', 'requires_action'];
const DRAFT_DEBOUNCE_MS = 400;
const MENTION_DEBOUNCE_MS = 120;
const MENTION_LIMIT = 50;
const MOBILE_QUERY = '(max-width: 767.98px)';
const COARSE_QUERY = '(pointer: coarse)';
/** Narrow or touch layouts, which get the short placeholder because the command and file hint does not fit there. */
const COMPACT_QUERY = `${MOBILE_QUERY}, ${COARSE_QUERY}`;

/** Commands the GUI implements itself. A Claude Code command with the same name runs the GUI action instead. */
const GUI_COMMANDS = [
  { id: 'model', name: 'model' },
  { id: 'permissions', name: 'permissions' },
  { id: 'effort', name: 'effort' },
  { id: 'rewind', name: 'rewind' },
  { id: 'fork', name: 'fork' },
  { id: 'rename', name: 'rename' },
  { id: 'mcp', name: 'mcp' },
  { id: 'context', name: 'context' },
  { id: 'tasks', name: 'tasks' },
  { id: 'terminal', name: 'terminal', needsTerminal: true },
  { id: 'settings', name: 'settings' },
];
const GUI_BY_NAME = new Map(GUI_COMMANDS.map((command) => [command.name, command]));
const HEADER_CONTROLS = { model: '.hdr-model', permissions: '.hdr-mode', effort: '.hdr-effort' };

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
 * Per-session composer state that outlives a mount: the attachments waiting to be sent, the suggestion and the last
 * sent text. A composer that is remounted, for example after a language change, finds what the previous one left. An
 * object URL is released only when its chip is removed or sent.
 * @type {Map<string, {chips: Chip[], suggestion: string|null, lastSent: string}>}
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
 *   setSuggestion: (text: string|null) => void, destroy: () => void}}
 */
export function createComposer({ container, api, store, t, actions }) {
  const view = { id: /** @type {string|null} */ (null), disposed: false, capsRef: undefined, dragDepth: 0 };
  let palette = /** @type {ReturnType<typeof openPalette>|null} */ (null);
  let paletteKind = /** @type {'slash'|'mention'|null} */ (null);
  let mentionTimer = /** @type {ReturnType<typeof setTimeout>|null} */ (null);
  let mentionAbort = /** @type {AbortController|null} */ (null);
  let draftTimer = /** @type {ReturnType<typeof setTimeout>|null} */ (null);

  const emptyText = h('p', { class: 'composer-empty-text', text: t('composer.emptyHint') });
  const newSessionBtn = /** @type {HTMLButtonElement} */ (h('button', {
    class: 'composer-cta',
    attrs: { type: 'button' },
    on: { click: () => actions.newSession() },
  }, icon('plus'), t('composer.newSession')));
  const emptyEl = h('div', { class: 'composer-empty' }, emptyText, newSessionBtn);

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
  // On phones the label is hidden and the round button shows only its icon, so aria-label and title carry the name.
  const stopBtn = /** @type {HTMLButtonElement} */ (h('button', {
    class: 'composer-stop',
    attrs: { type: 'button', 'aria-label': t('composer.stop'), title: t('composer.stop'), hidden: true },
    on: { click: () => actions.interrupt() },
  }, icon('stop'), h('span', { class: 'btn-label', text: t('composer.stop') })));
  const sendBtn = /** @type {HTMLButtonElement} */ (h('button', {
    class: 'composer-send',
    attrs: { type: 'button', 'aria-label': t('composer.send'), title: t('composer.send') },
    on: { click: () => send() },
  }, icon('send'), h('span', { class: 'btn-label', text: t('composer.send') })));
  const box = h('div', { class: 'composer-box' }, attachBtn, input,
    h('div', { class: 'composer-actions' }, stopBtn, sendBtn));
  const dropEl = h('div', { class: 'composer-drop', hidden: true, attrs: { 'aria-hidden': 'true' } },
    icon('paperclip'), h('span', { text: t('composer.drop') }));
  const fileInput = /** @type {HTMLInputElement} */ (h('input', {
    attrs: { type: 'file', multiple: true, tabindex: '-1', 'aria-hidden': 'true', hidden: true },
    on: { change: onFilePicked },
  }));
  const shell = h('div', { class: 'composer-shell' },
    suggestionEl, noticeEl, usageEl, queuedEl, chipsEl, box, dropEl, fileInput);
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
      record = { chips: [], suggestion: null, lastSent: '' };
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
    emptyText.textContent = t(profileRead ? 'composer.disabled.read' : 'composer.emptyHint');
    newSessionBtn.disabled = profileRead;
    const reason = disabledReason();
    const { chips, uploading, failed, hasContent, canSend } = summary();
    const busy = isBusy();
    const record = currentRecord();
    const text = input.value;
    const readOnly = reason === 'composer.disabled.read';

    root.classList.toggle('is-empty', !view.id);
    emptyEl.hidden = Boolean(view.id);
    shell.hidden = !view.id;
    if (!view.id) return;

    input.disabled = Boolean(reason);
    attachBtn.disabled = Boolean(reason) || meta.features?.uploads === false;
    sendBtn.disabled = !canSend;
    stopBtn.hidden = !busy || readOnly;
    stopBtn.disabled = Boolean(reason);
    queuedEl.hidden = !busy || !text.trim() || Boolean(reason);

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
    if (event.key === 'Escape') {
      event.preventDefault();
      input.blur();
      return;
    }
    if (event.key === 'ArrowUp' && !input.value && !event.shiftKey && !event.altKey) {
      const last = currentRecord()?.lastSent;
      if (last) {
        event.preventDefault();
        input.value = last;
        input.setSelectionRange(last.length, last.length);
        onTextChanged();
      }
      return;
    }
    if (isSendShortcut(event, { coarse: matchesMedia(COARSE_QUERY) })) {
      event.preventDefault();
      send();
    }
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
    const badge = item.source === 'gui' ? t('composer.palette.app') : item.builtin ? t('composer.palette.builtin') : '';
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
    const override = GUI_BY_NAME.get(item.name);
    const guiId = item.source === 'gui' ? item.guiId : override && guiAvailable(override) ? override.id : null;
    if (guiId) {
      input.value = '';
      closePalette();
      onTextChanged();
      runGuiCommand(guiId);
      return;
    }
    replaceTrigger(`/${item.name} `);
  }

  /** @param {{needsTerminal?: boolean}} command */
  function guiAvailable(command) {
    if (!command.needsTerminal) return true;
    const meta = store.get().meta ?? {};
    return meta.features?.terminal === true && (store.get().auth?.profile ?? meta.profile) === 'full';
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
      case 'permissions':
      case 'effort':
        focusHeaderSetting(guiId);
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
        actions.openPanel('capabilities');
        break;
      case 'context':
        actions.openPanel('context');
        break;
      case 'tasks':
        actions.openPanel('tasks');
        break;
      case 'terminal':
        actions.openTerminal();
        break;
      case 'settings':
        actions.openPanel('settings');
        break;
      default:
        break;
    }
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
    const path = `/api/fs/search?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(query)}&limit=${MENTION_LIMIT}`;
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
    const sent = record.chips;
    const attachments = sent
      .filter((chip) => chip.status === 'done')
      .map((chip) => ({ path: chip.path, name: chip.name, kind: chip.kind, mediaType: chip.mediaType }));
    record.chips = [];
    if (text.trim()) record.lastSent = text;
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
      view.id = next;
      view.capsRef = next ? store.get().capabilities?.[next] : undefined;
      input.value = next ? loadDraft(next) : '';
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
    setSuggestion(text) {
      if (!view.id) return;
      recordFor(view.id).suggestion = typeof text === 'string' && text.trim() ? text : null;
      sync();
    },
    destroy() {
      if (view.disposed) return;
      flushDraft();
      view.disposed = true;
      unsubscribe();
      stopPlaceholderWatch();
      mounts.delete(restoreText);
      if (mentionTimer) clearTimeout(mentionTimer);
      closePalette();
      // The chips outlive this composer with their thumbnails, so object URLs stay until a chip is removed or sent.
      for (const record of records.values()) {
        for (const chip of record.chips) detachChip(chip)?.abort();
      }
      root.remove();
    },
  };
}
