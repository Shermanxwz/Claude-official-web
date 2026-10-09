/**
 * Modal dialogs: aria-modal, labelled by their title, focus trapped, Escape and backdrop close, focus restored
 * to the element that opened them.
 *
 * Action semantics: `onClick({ close })` runs when the button is pressed. The dialog closes afterwards unless the
 * action sets `keepOpen: true`. When `onClick` returns a promise, the button is disabled until it settles and the
 * dialog closes only on success.
 */

import { h, icon } from '../dom.js';
import { t } from '../i18n.js';

/**
 * @typedef {Object} DialogAction
 * @property {string} label
 * @property {'primary'|'danger'|'secondary'} [kind]
 * @property {boolean} [disabled]
 * @property {boolean} [keepOpen]
 * @property {(ctx: {close: () => void}) => void | Promise<unknown>} [onClick]
 */

/**
 * @typedef {Object} OpenDialogOptions
 * @property {string} title
 * @property {Node | string} [body]
 * @property {DialogAction[]} [actions]
 * @property {() => void} [onClose]
 * @property {boolean} [dismissible]   default true: Escape and backdrop close the dialog
 * @property {'sm'|'md'|'lg'} [size]
 */

/**
 * @typedef {Object} DialogEntry
 * @property {HTMLElement} backdrop
 * @property {HTMLElement} dialog
 * @property {boolean} dismissible
 * @property {() => void} close
 */

/** @type {DialogEntry[]} */
const stack = [];
let scrollLocks = 0;
let keyListenerInstalled = false;
let idCounter = 0;

function applyScrollLock() {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('is-locked', scrollLocks > 0);
}

/**
 * Prevent page scrolling while an overlay is open. Returns the matching unlock function.
 * @returns {() => void}
 */
export function lockScroll() {
  scrollLocks += 1;
  applyScrollLock();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    scrollLocks = Math.max(0, scrollLocks - 1);
    applyScrollLock();
  };
}

/** @returns {boolean} true while at least one dialog is open */
export function hasOpenDialog() {
  return stack.length > 0;
}

/** Close every open dialog, top first (used when the signed-in view is torn down). */
export function closeAllDialogs() {
  for (const entry of [...stack].reverse()) entry.close();
}

/**
 * @param {HTMLElement} root
 * @returns {HTMLElement[]}
 */
function focusableWithin(root) {
  const selector = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), '
    + 'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return [...root.querySelectorAll(selector)].filter((el) => el.getClientRects().length > 0);
}

/** @param {KeyboardEvent} event */
function onDocumentKeydown(event) {
  const top = stack[stack.length - 1];
  if (!top) return;
  if (event.key === 'Escape') {
    if (!top.dismissible) return;
    event.preventDefault();
    top.close();
    return;
  }
  if (event.key === 'Tab') {
    const items = focusableWithin(top.dialog);
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = /** @type {HTMLElement} */ (document.activeElement);
    const inside = top.dialog.contains(active);
    if (event.shiftKey && (!inside || active === first)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (!inside || active === last)) {
      event.preventDefault();
      first.focus();
    }
    return;
  }
  // keyCode 229 is the IME commit Enter on Safari, where isComposing is already false by the time keydown fires.
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    const target = event.target;
    const plainInput = target instanceof HTMLInputElement
      && !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'color', 'range'].includes(target.type);
    if (!plainInput || !top.dialog.contains(target)) return;
    const primary = top.dialog.querySelector('.dialog-footer .btn-primary:not([disabled])')
      ?? top.dialog.querySelector('.dialog-footer .btn-danger:not([disabled])');
    if (primary) {
      event.preventDefault();
      primary.click();
    }
  }
}

function ensureKeyListener() {
  if (keyListenerInstalled) return;
  keyListenerInstalled = true;
  document.addEventListener('keydown', onDocumentKeydown);
}

function releaseKeyListener() {
  if (!keyListenerInstalled || stack.length > 0) return;
  keyListenerInstalled = false;
  document.removeEventListener('keydown', onDocumentKeydown);
}

/**
 * @param {DialogAction} action
 * @param {(button: HTMLButtonElement, action: DialogAction) => void} onPress
 * @returns {HTMLButtonElement}
 */
function actionButton(action, onPress) {
  const kind = action.kind ?? 'secondary';
  const className = kind === 'primary' ? 'btn btn-primary' : kind === 'danger' ? 'btn btn-danger' : 'btn btn-secondary';
  const button = /** @type {HTMLButtonElement} */ (h('button', {
    class: className,
    attrs: { type: 'button', disabled: action.disabled },
    text: action.label,
  }));
  button.addEventListener('click', () => onPress(button, action));
  return button;
}

/**
 * Open a modal dialog.
 * @param {OpenDialogOptions} options
 * @returns {{ close: () => void, element: HTMLElement }}
 */
export function openDialog({ title, body, actions = [], onClose, dismissible = true, size = 'md' }) {
  if (typeof document === 'undefined') throw new Error('openDialog requires a browser document');
  const previouslyFocused = /** @type {HTMLElement | null} */ (document.activeElement);
  const titleId = `dialog-title-${++idCounter}`;
  let closed = false;
  let busy = false;
  let pointerDownOnBackdrop = false;

  /** @type {HTMLElement} */
  let backdrop;
  /** @type {DialogEntry} */
  let entry;

  function close() {
    if (closed) return;
    closed = true;
    const index = stack.indexOf(entry);
    if (index >= 0) stack.splice(index, 1);
    backdrop.remove();
    releaseKeyListener();
    if (previouslyFocused && previouslyFocused.isConnected) previouslyFocused.focus({ preventScroll: true });
    onClose?.();
  }

  /**
   * @param {HTMLButtonElement} button
   * @param {DialogAction} action
   */
  function run(button, action) {
    if (busy || closed) return;
    const result = action.onClick?.({ close });
    if (result && typeof (/** @type {Promise<unknown>} */ (result)).then === 'function') {
      busy = true;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      /** @type {Promise<unknown>} */ (result).then(
        () => {
          busy = false;
          button.disabled = action.disabled === true;
          button.removeAttribute('aria-busy');
          if (!action.keepOpen) close();
        },
        (err) => {
          busy = false;
          button.disabled = action.disabled === true;
          button.removeAttribute('aria-busy');
          queueMicrotask(() => {
            throw err;
          });
        },
      );
      return;
    }
    if (!action.keepOpen) close();
  }

  const closeButton = h('button', {
    class: 'btn btn-ghost btn-icon dialog-close',
    attrs: { type: 'button', 'aria-label': t('common.close') },
    on: { click: () => close() },
  }, icon('x'));

  const header = h('div', { class: 'dialog-header' },
    h('h2', { class: 'dialog-title', id: titleId, text: title }),
    closeButton);

  const bodyEl = h('div', { class: 'dialog-body' }, body ?? null);

  /** @type {HTMLElement | null} */
  let footer = null;
  if (actions.length > 0) {
    footer = h('div', { class: 'dialog-footer' }, actions.map((action) => actionButton(action, run)));
  }

  const dialog = h('div', {
    class: ['dialog', `dialog-${size}`],
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
  }, header, bodyEl, footer);

  backdrop = h('div', { class: 'dialog-backdrop' }, dialog);
  backdrop.addEventListener('pointerdown', (event) => {
    pointerDownOnBackdrop = event.target === backdrop;
  });
  backdrop.addEventListener('click', (event) => {
    if (pointerDownOnBackdrop && event.target === backdrop && dismissible) close();
    pointerDownOnBackdrop = false;
  });

  entry = { backdrop, dialog, dismissible, close };
  stack.push(entry);
  ensureKeyListener();
  document.body.appendChild(backdrop);
  applyScrollLock();

  const firstField = focusableWithin(bodyEl)[0] ?? (footer ? focusableWithin(footer)[0] : null);
  (firstField ?? dialog).focus({ preventScroll: true });

  return { close, element: dialog };
}

/**
 * Ask for confirmation. Resolves true only when the confirm button is pressed.
 * @param {{title: string, message?: string | Node, danger?: boolean, confirmLabel?: string, cancelLabel?: string}} options
 * @returns {Promise<boolean>}
 */
export function confirmDialog({ title, message, danger = false, confirmLabel, cancelLabel }) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (/** @type {boolean} */ value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const body = typeof message === 'string' ? h('p', { class: 'dialog-text', text: message }) : message;
    openDialog({
      title,
      body,
      size: 'sm',
      actions: [
        { label: cancelLabel ?? t('common.cancel'), kind: 'secondary', onClick: () => settle(false) },
        {
          label: confirmLabel ?? t('common.confirm'),
          kind: danger ? 'danger' : 'primary',
          onClick: () => settle(true),
        },
      ],
      onClose: () => settle(false),
    });
  });
}
