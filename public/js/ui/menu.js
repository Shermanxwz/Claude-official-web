/**
 * Popover menus anchored to an element or to a point. Keyboard: ArrowUp/ArrowDown move (wrapping), Home/End jump,
 * Enter/Space activate, Escape and Tab close (Escape returns focus to the anchor). Pointer-down outside, a scroll
 * or a resize closes the menu. Only one menu is open at a time.
 */

import { h, icon } from '../dom.js';

/**
 * @typedef {Object} MenuItem
 * @property {string} label
 * @property {string} [icon]        icon name (see docs/FRONTEND.md)
 * @property {boolean} [danger]
 * @property {boolean} [disabled]
 * @property {string} [title]       tooltip, e.g. why the item is disabled
 * @property {boolean} [checked]    when given, the item is a checkable menu item
 * @property {() => void} [onClick]
 */

/** @typedef {MenuItem | 'separator'} MenuEntry */
/** @typedef {Element | {x: number, y: number}} MenuAnchor */

const VIEWPORT_MARGIN = 8;
const GAP = 6;

/** @type {{ close: (restoreFocus?: boolean) => void } | null} */
let active = null;

/**
 * @param {MenuAnchor} anchor
 * @returns {{left: number, right: number, top: number, bottom: number}}
 */
function anchorRect(anchor) {
  if (anchor instanceof Element) {
    const rect = anchor.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
  }
  return { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
}

/**
 * Place the menu inside the viewport: below the anchor when there is room, otherwise above it.
 * @param {HTMLElement} menu
 * @param {MenuAnchor} anchor
 */
function place(menu, anchor) {
  const rect = anchorRect(anchor);
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
  const viewportHeight = window.innerHeight;
  const isPoint = !(anchor instanceof Element);

  let left = isPoint ? rect.left : rect.right - width;
  left = Math.min(left, viewportWidth - width - VIEWPORT_MARGIN);
  left = Math.max(VIEWPORT_MARGIN, left);

  let top = rect.bottom + GAP;
  const fitsBelow = top + height <= viewportHeight - VIEWPORT_MARGIN;
  const fitsAbove = rect.top - GAP - height >= VIEWPORT_MARGIN;
  if (!fitsBelow && fitsAbove) top = rect.top - GAP - height;
  top = Math.min(top, viewportHeight - height - VIEWPORT_MARGIN);
  top = Math.max(VIEWPORT_MARGIN, top);

  menu.style.setProperty('left', `${Math.round(left)}px`);
  menu.style.setProperty('top', `${Math.round(top)}px`);
}

/**
 * @param {MenuEntry} entry
 * @param {(entry: MenuItem) => void} choose
 * @returns {HTMLElement}
 */
function renderEntry(entry, choose) {
  if (entry === 'separator') return h('div', { class: 'menu-separator', attrs: { role: 'separator' } });
  const checkable = entry.checked !== undefined;
  return h('button', {
    class: ['menu-item', entry.danger ? 'is-danger' : ''],
    attrs: {
      type: 'button',
      role: checkable ? 'menuitemcheckbox' : 'menuitem',
      disabled: entry.disabled,
      title: entry.title ?? null,
      'aria-checked': checkable ? String(entry.checked === true) : null,
      tabindex: '-1',
    },
    on: { click: () => choose(entry) },
  },
  entry.icon ? icon(entry.icon) : h('span', { class: 'menu-icon-slot', attrs: { 'aria-hidden': 'true' } }),
  h('span', { class: 'menu-label', text: entry.label }),
  checkable && entry.checked ? icon('check') : null);
}

/**
 * Open a menu. Returns a handle whose `close()` dismisses it (idempotent).
 * @param {MenuAnchor} anchor
 * @param {MenuEntry[]} items
 * @param {{label?: string}} [options]
 * @returns {{ close: (restoreFocus?: boolean) => void }}
 */
export function openMenu(anchor, items, { label } = {}) {
  if (active) active.close(false);
  const anchorElement = anchor instanceof Element ? anchor : null;
  const previouslyFocused = /** @type {HTMLElement | null} */ (document.activeElement);
  let closed = false;

  /** @type {(entry: MenuItem) => void} */
  const choose = (entry) => {
    if (entry.disabled) return;
    // Focus returns to the anchor before the action runs. A sheet or dialog that the action opens then remembers the
    // anchor, which is still on the page, rather than the menu item that was just removed.
    close(true);
    entry.onClick?.();
  };

  const menu = h('div', {
    class: 'menu',
    attrs: { role: 'menu', tabindex: '-1', 'aria-label': label ?? null },
  }, items.map((entry) => renderEntry(entry, choose)));

  /** @returns {HTMLButtonElement[]} */
  const enabledItems = () => /** @type {HTMLButtonElement[]} */ ([...menu.querySelectorAll('.menu-item:not([disabled])')]);

  /** @param {KeyboardEvent} event */
  const onKeydown = (event) => {
    const list = enabledItems();
    const index = list.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        list[(index + 1) % list.length]?.focus();
        break;
      case 'ArrowUp':
        event.preventDefault();
        list[(index - 1 + list.length) % list.length]?.focus();
        break;
      case 'Home':
        event.preventDefault();
        list[0]?.focus();
        break;
      case 'End':
        event.preventDefault();
        list[list.length - 1]?.focus();
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        close(true);
        break;
      case 'Tab':
        event.preventDefault();
        close(true);
        break;
      default:
        break;
    }
  };

  /** @param {PointerEvent} event */
  const onPointerDown = (event) => {
    const target = /** @type {Node} */ (event.target);
    if (menu.contains(target)) return;
    if (anchorElement && anchorElement.contains(target)) return;
    close(false);
  };

  /**
   * An element anchor is in view while any part of it is inside the viewport. A detached anchor is not.
   * @returns {boolean}
   */
  const anchorInView = () => {
    if (anchorElement && !anchorElement.isConnected) return false;
    const rect = anchorRect(anchor);
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    return rect.right >= 0 && rect.bottom >= 0 && rect.left <= viewportWidth && rect.top <= window.innerHeight;
  };

  /**
   * A scroll closes the menu only when its anchor has left the viewport. While the anchor is still visible the menu
   * follows it, so auto-scroll inside the timeline (.tl-scroll while a turn streams) keeps the menu open.
   * @param {Event} event
   */
  const onScrollOrResize = (event) => {
    if (event.type === 'scroll') {
      if (menu.contains(/** @type {Node} */ (event.target))) return;
      if (anchorInView()) {
        place(menu, anchor);
        return;
      }
    }
    close(false);
  };

  /** @param {boolean} restoreFocus */
  function close(restoreFocus = false) {
    if (closed) return;
    closed = true;
    document.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('scroll', onScrollOrResize, true);
    window.removeEventListener('resize', onScrollOrResize);
    menu.remove();
    if (active === handle) active = null;
    if (restoreFocus) {
      const target = anchorElement ?? previouslyFocused;
      if (target && target.isConnected && typeof target.focus === 'function') target.focus({ preventScroll: true });
    }
  }

  const handle = { close };
  active = handle;

  menu.addEventListener('keydown', onKeydown);
  document.body.appendChild(menu);
  place(menu, anchor);
  document.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('scroll', onScrollOrResize, { capture: true, passive: true });
  window.addEventListener('resize', onScrollOrResize);
  enabledItems()[0]?.focus({ preventScroll: true });

  return handle;
}

/** Close whichever menu is open, if any. */
export function closeMenu() {
  active?.close(false);
}
