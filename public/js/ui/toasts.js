/**
 * Toast notifications in a polite live region. Errors stay longer than other levels; hovering or focusing a
 * toast pauses its timer; the newest toasts are kept when more than MAX_VISIBLE are open.
 */

import { h, icon } from '../dom.js';
import { t } from '../i18n.js';

/** @typedef {'info'|'success'|'warning'|'error'} ToastLevel */

const DURATION_MS = /** @type {Record<ToastLevel, number>} */ ({ info: 5000, success: 5000, warning: 5000, error: 8000 });
const ICONS = /** @type {Record<ToastLevel, string>} */ ({
  info: 'info', success: 'check', warning: 'alert', error: 'alert',
});
const MAX_VISIBLE = 4;
const LEAVE_MS = 180;

/**
 * @param {HTMLElement} container element that will host the toast region (positioned by CSS)
 * @returns {{
 *   toast(message: string | Node, level?: ToastLevel): { dismiss(): void },
 *   destroy(): void,
 * }}
 */
export function createToasts(container) {
  const region = h('div', {
    class: 'toast-region',
    attrs: { 'aria-live': 'polite', 'aria-label': t('shell.toasts.region') },
  });
  container.appendChild(region);

  /** @type {Set<() => void>} */
  const dismissers = new Set();

  /**
   * @param {string | Node} message
   * @param {ToastLevel} [level]
   */
  function toast(message, level = 'info') {
    const kind = Object.prototype.hasOwnProperty.call(DURATION_MS, level) ? level : 'info';
    let remaining = DURATION_MS[kind];
    let startedAt = 0;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;
    let dismissed = false;

    const closeButton = h('button', {
      class: 'btn btn-ghost btn-icon btn-sm toast-close',
      attrs: { type: 'button', 'aria-label': t('common.dismiss') },
      on: { click: () => dismiss() },
    }, icon('x'));

    const element = h('div', { class: ['toast', `toast-${kind}`] },
      icon(ICONS[kind]),
      h('div', { class: 'toast-message' }, message),
      closeButton);

    function startTimer() {
      startedAt = Date.now();
      timer = setTimeout(() => dismiss(), remaining);
    }

    function pause() {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
      remaining = Math.max(1000, remaining - (Date.now() - startedAt));
    }

    function resume() {
      if (dismissed || timer !== null) return;
      startTimer();
    }

    function dismiss() {
      if (dismissed) return;
      dismissed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      dismissers.delete(dismiss);
      element.classList.add('is-leaving');
      setTimeout(() => element.remove(), LEAVE_MS);
    }

    element.addEventListener('pointerenter', pause);
    element.addEventListener('pointerleave', resume);
    element.addEventListener('focusin', pause);
    element.addEventListener('focusout', resume);

    region.appendChild(element);
    dismissers.add(dismiss);
    startTimer();

    const visible = [...dismissers];
    for (const oldest of visible.slice(0, Math.max(0, visible.length - MAX_VISIBLE))) oldest();

    return { dismiss };
  }

  return {
    toast,
    destroy() {
      for (const dismissNow of [...dismissers]) dismissNow();
      region.remove();
    },
  };
}
