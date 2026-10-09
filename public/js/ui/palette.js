import { clear, h } from '../dom.js';

/**
 * Accessible listbox popover used by the composer for slash commands and file mentions. The owning input keeps the
 * keyboard: it calls move/pick/close, and the palette mirrors the active row through aria-activedescendant. Pointer
 * presses inside the popover do not move focus, so the textarea keeps its caret while a row is picked.
 */

let paletteSeq = 0;

/**
 * Splits text into plain strings and <mark> elements where the query matches. A contiguous (case-insensitive) match
 * wins; otherwise the query's characters are highlighted in order. Returns children that h() accepts.
 * @param {string} text
 * @param {string} query
 * @returns {Array<string|HTMLElement>}
 */
export function highlightText(text, query) {
  const value = String(text ?? '');
  const needle = String(query ?? '').trim().toLowerCase();
  if (!needle) return [value];
  const lower = value.toLowerCase();
  if (lower.length !== value.length) return [value];
  const marked = new Array(value.length).fill(false);
  const start = lower.indexOf(needle);
  if (start >= 0) {
    marked.fill(true, start, start + needle.length);
  } else {
    let from = 0;
    for (const ch of needle) {
      const at = lower.indexOf(ch, from);
      if (at < 0) return [value];
      marked[at] = true;
      from = at + 1;
    }
  }
  /** @type {Array<string|HTMLElement>} */
  const parts = [];
  let i = 0;
  while (i < value.length) {
    const hit = marked[i];
    let j = i;
    while (j < value.length && marked[j] === hit) j += 1;
    const slice = value.slice(i, j);
    parts.push(hit ? h('mark', { class: 'palette-match', text: slice }) : slice);
    i = j;
  }
  return parts;
}

/**
 * @typedef {Object} PaletteOptions
 * @property {HTMLElement} anchor                     element that receives the popover (it is positioned above it)
 * @property {Array<any>} items                       rows to show, already filtered and ordered
 * @property {(item: any) => void} onPick             called with the row that was chosen (keyboard or pointer)
 * @property {(item: any, query: string) => Node|Node[]|string} renderItem  content of one row
 * @property {string} emptyText                       shown when there are no rows
 * @property {string} [label]                         accessible name of the listbox
 * @property {HTMLTextAreaElement|HTMLInputElement} [input]  owning field; receives combobox ARIA while open
 * @property {string} [query]                         text to highlight inside rows
 */

/**
 * @typedef {Object} PaletteHandle
 * @property {(items: Array<any>, query?: string, emptyText?: string) => void} update  replace the rows; the first row
 *   becomes active
 * @property {(delta: number) => void} move                       moves the active row, wrapping around
 * @property {() => boolean} pick                                 picks the active row; false when there is none
 * @property {() => any} active                                   the active row, or null
 * @property {() => void} close                                   removes the popover and restores the field's ARIA
 * @property {() => boolean} isOpen
 */

/**
 * Opens a listbox popover above `anchor`.
 * @param {PaletteOptions} options
 * @returns {PaletteHandle}
 */
export function openPalette({ anchor, items, onPick, renderItem, emptyText, label, input, query = '' }) {
  const seq = ++paletteSeq;
  const listId = `caw-palette-${seq}-list`;
  const optionId = (/** @type {number} */ i) => `caw-palette-${seq}-opt-${i}`;
  const savedAttrs = input ? snapshotAttrs(input) : null;
  let rows = Array.isArray(items) ? items : [];
  let needle = typeof query === 'string' ? query : '';
  let index = 0;
  let open = true;

  const listEl = h('div', {
    class: 'palette-list',
    attrs: { role: 'listbox', id: listId, 'aria-label': label },
  });
  const emptyEl = h('div', { class: 'palette-empty', attrs: { role: 'status' }, text: emptyText });
  const root = h('div', {
    class: 'palette',
    attrs: { 'data-palette': '' },
    on: { pointerdown: keepFocus },
  }, listEl, emptyEl);

  /** @param {Event} event */
  function keepFocus(event) {
    event.preventDefault();
  }

  function syncInput() {
    if (!input) return;
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-haspopup', 'listbox');
    input.setAttribute('aria-expanded', open ? 'true' : 'false');
    input.setAttribute('aria-controls', listId);
    if (open && rows.length > 0) input.setAttribute('aria-activedescendant', optionId(index));
    else input.removeAttribute('aria-activedescendant');
  }

  function paint() {
    const options = listEl.children;
    for (let i = 0; i < options.length; i += 1) {
      const selected = i === index;
      options[i].classList.toggle('is-active', selected);
      options[i].setAttribute('aria-selected', selected ? 'true' : 'false');
    }
    syncInput();
  }

  function scrollActiveIntoView() {
    const row = listEl.children[index];
    if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
  }

  /** @param {number} i */
  function pickAt(i) {
    if (!open || i < 0 || i >= rows.length) return;
    index = i;
    paint();
    onPick(rows[i]);
  }

  function render() {
    clear(listEl);
    const empty = rows.length === 0;
    listEl.hidden = empty;
    emptyEl.hidden = !empty;
    rows.forEach((item, i) => {
      listEl.appendChild(h('div', {
        class: 'palette-option',
        attrs: { role: 'option', id: optionId(i), 'aria-selected': i === index ? 'true' : 'false' },
        dataset: { index: i },
        on: {
          click: () => pickAt(i),
          pointerenter: () => {
            if (index === i) return;
            index = i;
            paint();
          },
        },
      }, renderItem(item, needle)));
    });
    paint();
  }

  render();
  anchor.appendChild(root);
  syncInput();

  return {
    update(nextItems, nextQuery, nextEmptyText) {
      if (!open) return;
      rows = Array.isArray(nextItems) ? nextItems : [];
      if (typeof nextQuery === 'string') needle = nextQuery;
      if (typeof nextEmptyText === 'string') emptyEl.textContent = nextEmptyText;
      index = 0;
      render();
      listEl.scrollTop = 0;
    },
    move(delta) {
      if (!open || rows.length === 0) return;
      const count = rows.length;
      index = (((index + delta) % count) + count) % count;
      paint();
      scrollActiveIntoView();
    },
    pick() {
      if (!open || rows.length === 0) return false;
      pickAt(index);
      return true;
    },
    active() {
      return open && rows.length > 0 ? rows[index] : null;
    },
    close() {
      if (!open) return;
      open = false;
      root.remove();
      if (input && savedAttrs) restoreAttrs(input, savedAttrs);
    },
    isOpen() {
      return open;
    },
  };
}

const COMBOBOX_ATTRS = ['role', 'aria-autocomplete', 'aria-haspopup', 'aria-expanded', 'aria-controls',
  'aria-activedescendant'];

/**
 * @param {Element} el
 * @returns {Map<string, string|null>}
 */
function snapshotAttrs(el) {
  return new Map(COMBOBOX_ATTRS.map((name) => [name, el.getAttribute(name)]));
}

/**
 * @param {Element} el
 * @param {Map<string, string|null>} saved
 */
function restoreAttrs(el, saved) {
  for (const [name, value] of saved) {
    if (value == null) el.removeAttribute(name);
    else el.setAttribute(name, value);
  }
}
