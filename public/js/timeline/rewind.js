/**
 * Rewind and fork dialogs for the timeline. Both call the gateway (docs/PROTOCOL.md) and report failures inside the
 * dialog, so the choice can be corrected without reopening it. Nothing here uses innerHTML.
 */
import { h, clear } from '../dom.js';
import { errorText } from '../api.js';
import { openDialog } from '../ui/dialog.js';
import { truncateMiddle, pluralKey } from './format.js';
import { getLocale } from '../i18n.js';
import { isRecord } from './tools/summaries.js';
import { TIMELINE_RELOAD_EVENT } from './view.js';

const MODES = Object.freeze(['both', 'conversation', 'code']);
const MODE_KEYS = Object.freeze({
  both: { label: 'cards.rewind.mode.both', hint: 'cards.rewind.mode.bothHint' },
  conversation: { label: 'cards.rewind.mode.conversation', hint: 'cards.rewind.mode.conversationHint' },
  code: { label: 'cards.rewind.mode.code', hint: 'cards.rewind.mode.codeHint' },
});
const LISTED_FILES = 12;
const PATH_LIMIT = 90;
const TITLE_LIMIT = 200;

let dialogCounter = 0;

/** @typedef {(key: string, vars?: Record<string, string | number>) => string} Translate */
/** @typedef {{ post: (path: string, body?: unknown) => Promise<any> }} ApiClient */
/**
 * @typedef {Object} Actions
 * @property {(message: string, level?: string) => void} toast
 * @property {(sessionId: string) => unknown} selectSession
 */
/**
 * @typedef {{ ok: true, files: string[], insertions: number, deletions: number }} PreviewOk
 * @typedef {{ ok: false, reason: string }} PreviewFailed
 * @typedef {PreviewOk | PreviewFailed} Preview
 */

/**
 * Opens the rewind dialog for one sent prompt. Code rewinds show a dry-run preview first; nothing changes until the
 * user confirms.
 * @param {{ api: ApiClient, sessionId: string, userMessageId: string | null, t: Translate, actions: Actions }} options
 */
export function openRewindDialog({ api, sessionId, userMessageId, t, actions }) {
  const uid = `rewind-${++dialogCounter}`;
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/rewind`;
  const hasTarget = typeof userMessageId === 'string' && userMessageId !== '';
  let mode = 'both';
  let busy = false;
  let previewToken = 0;
  /** @type {Preview | null} null while the dry run is in flight */
  let preview = null;

  const previewEl = h('div', { class: 'rewind-preview', attrs: { role: 'status', 'aria-live': 'polite' } });
  const errorEl = h('p', { class: 'rewind-error', attrs: { role: 'alert', hidden: true } });
  const radios = MODES.map((value) => h('input', {
    attrs: { type: 'radio', name: uid, value, checked: value === mode },
  }));
  const modeOptions = MODES.map((value, index) => h('label', { class: 'rewind-mode' },
    radios[index],
    h('span', { class: 'rewind-mode-body' },
      h('span', { class: 'rewind-mode-label', text: t(MODE_KEYS[value].label) }),
      h('span', { class: 'rewind-mode-hint', text: t(MODE_KEYS[value].hint) }))));
  for (const radio of radios) {
    radio.addEventListener('change', () => {
      if (radio.checked) selectMode(radio.value);
    });
  }

  const body = h('div', { class: 'rewind-form' },
    h('p', { class: 'dialog-text', text: t('cards.rewind.lead') }),
    h('fieldset', { class: 'rewind-modes' },
      h('legend', { class: 'field-label', text: t('cards.rewind.modeLegend') }),
      modeOptions),
    previewEl,
    errorEl);

  const handle = openDialog({
    title: t('cards.rewind.title'),
    body,
    actions: [
      { label: t('common.cancel'), kind: 'secondary' },
      { label: t('cards.rewind.confirm'), kind: 'danger', keepOpen: true, onClick: () => confirm() },
    ],
  });
  const confirmButton = handle.element.querySelector('.dialog-footer .btn-danger');

  /** @param {string} next */
  function selectMode(next) {
    mode = next;
    errorEl.hidden = true;
    refreshPreview();
  }

  function canRewind() {
    if (!hasTarget) return false;
    if (mode === 'conversation') return true;
    return preview !== null && preview.ok;
  }

  function updateControls() {
    if (confirmButton instanceof HTMLButtonElement) confirmButton.disabled = busy || !canRewind();
    for (const radio of radios) radio.disabled = busy;
  }

  async function refreshPreview() {
    const token = ++previewToken;
    preview = null;
    renderPreview();
    updateControls();
    if (!hasTarget || mode === 'conversation') return;
    try {
      const result = await api.post(path, { userMessageId, mode, dryRun: true });
      if (token !== previewToken) return;
      preview = summarize(result, t);
    } catch (error) {
      if (token !== previewToken) return;
      preview = { ok: false, reason: failureText(error, t) };
    }
    renderPreview();
    updateControls();
  }

  function renderPreview() {
    clear(previewEl);
    if (!hasTarget) {
      previewEl.append(h('p', { class: 'rewind-note is-error', text: t('cards.rewind.noTarget') }));
      return;
    }
    if (mode === 'conversation') {
      previewEl.append(h('p', { class: 'rewind-note', text: t('cards.rewind.conversationOnly') }));
      return;
    }
    const current = preview;
    if (current === null) {
      previewEl.append(h('p', { class: 'rewind-note shimmer', text: t('cards.rewind.checking') }));
      return;
    }
    if (current.ok === false) {
      previewEl.append(h('p', { class: 'rewind-note is-error', text: current.reason }));
      return;
    }
    const total = current.files.length;
    previewEl.append(h('p', {
      class: 'rewind-note',
      text: total === 0
        ? t('cards.rewind.preview.none')
        : t(pluralKey('cards.rewind.preview.summary', total, getLocale()),
          { files: total, insertions: current.insertions, deletions: current.deletions }),
    }));
    if (total > 0) {
      previewEl.append(h('ul', { class: 'rewind-files' }, current.files.slice(0, LISTED_FILES).map((file) => h('li', {},
        h('code', { text: truncateMiddle(file, PATH_LIMIT), attrs: { title: file } })))));
      if (total > LISTED_FILES) {
        previewEl.append(h('p', {
          class: 'rewind-note is-muted', text: t('cards.rewind.preview.more', { count: total - LISTED_FILES }),
        }));
      }
    }
    if (mode === 'both') previewEl.append(h('p', { class: 'rewind-note is-muted', text: t('cards.rewind.bothNote') }));
  }

  async function confirm() {
    if (busy || !canRewind()) return;
    // A conversation rewind restarts the session's query, which stops its background tasks.
    if (mode !== 'code' && actions.confirmEndBackground && !(await actions.confirmEndBackground(sessionId))) return;
    if (busy) return;
    busy = true;
    errorEl.hidden = true;
    updateControls();
    try {
      await api.post(path, { userMessageId, mode });
      handle.close();
      actions.toast(t('cards.rewind.done'), 'info');
      if (mode !== 'code') {
        // The transcript changed on the server: the timeline reloads its snapshot (view.js listens for this).
        window.dispatchEvent(new CustomEvent(TIMELINE_RELOAD_EVENT, { detail: { sessionId } }));
      }
    } catch (error) {
      errorEl.textContent = failureText(error, t);
      errorEl.hidden = false;
    } finally {
      busy = false;
      updateControls();
    }
  }

  updateControls();
  refreshPreview();
}

/**
 * Opens the fork dialog: a new session that starts from the conversation up to one prompt, or the whole conversation.
 * @param {{ api: ApiClient, sessionId: string, upToMessageId?: string | null, t: Translate, actions: Actions }} options
 */
export function openForkDialog({ api, sessionId, upToMessageId, t, actions }) {
  const uid = `fork-${++dialogCounter}`;
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/fork`;
  const upTo = typeof upToMessageId === 'string' && upToMessageId !== '' ? upToMessageId : null;
  const titleInput = h('input', {
    class: 'input',
    attrs: {
      id: `${uid}-title`,
      type: 'text',
      maxlength: TITLE_LIMIT,
      autocomplete: 'off',
      placeholder: t('cards.fork.titlePlaceholder'),
    },
  });
  const errorEl = h('p', { class: 'rewind-error', attrs: { role: 'alert', hidden: true } });
  const body = h('div', { class: 'rewind-form' },
    h('p', { class: 'dialog-text', text: t(upTo ? 'cards.fork.leadUpTo' : 'cards.fork.lead') }),
    h('label', { class: 'field', attrs: { for: `${uid}-title` } },
      h('span', { class: 'field-label', text: t('cards.fork.titleLabel') }),
      titleInput),
    errorEl);

  let busy = false;
  /** @type {{ close: () => void } | null} */
  let handle = null;
  const create = async () => {
    if (busy) return;
    busy = true;
    titleInput.disabled = true;
    errorEl.hidden = true;
    try {
      /** @type {Record<string, string>} */
      const payload = {};
      if (upTo) payload.upToMessageId = upTo;
      const title = titleInput.value.trim().slice(0, TITLE_LIMIT);
      if (title) payload.title = title;
      const result = await api.post(path, payload);
      const forkedId = isRecord(result) && typeof result.sessionId === 'string' ? result.sessionId : '';
      if (!forkedId) throw new Error('fork response without a session id');
      handle?.close();
      actions.toast(t('cards.fork.done'), 'info');
      actions.selectSession(forkedId);
    } catch (error) {
      errorEl.textContent = errorText(error, t);
      errorEl.hidden = false;
    } finally {
      busy = false;
      titleInput.disabled = false;
    }
  };
  handle = openDialog({
    title: t('cards.fork.title'),
    body,
    actions: [
      { label: t('common.cancel'), kind: 'secondary' },
      { label: t('cards.fork.confirm'), kind: 'primary', keepOpen: true, onClick: () => create() },
    ],
  });
}

/**
 * The text of a failed rewind request. A 409 CONFLICT carries the server's own reason (the turn still runs, for
 * example), and that reason says what to do, so it is shown as it is.
 * @param {unknown} error
 * @param {Translate} t
 * @returns {string}
 */
function failureText(error, t) {
  const message = error && typeof error.message === 'string' ? error.message.trim() : '';
  if (error && error.status === 409 && message) return message;
  return errorText(error, t);
}

/**
 * Turns a RewindFilesResult (dry run) into the preview state.
 * @param {unknown} result the response of POST /rewind with dryRun
 * @param {Translate} t
 * @returns {Preview}
 */
function summarize(result, t) {
  const files = isRecord(result) && isRecord(result.files) ? result.files : null;
  if (!files) return { ok: false, reason: t('cards.rewind.preview.unavailable') };
  if (files.canRewind !== true) {
    const reason = typeof files.error === 'string' ? files.error.trim() : '';
    return { ok: false, reason: reason || t('cards.rewind.preview.blocked') };
  }
  return {
    ok: true,
    files: Array.isArray(files.filesChanged) ? files.filesChanged.filter((file) => typeof file === 'string') : [],
    insertions: count(files.insertions),
    deletions: count(files.deletions),
  };
}

/** @param {unknown} value @returns {number} */
function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}
