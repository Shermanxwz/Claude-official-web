/**
 * Minimal DOM helpers shared by every browser module. No innerHTML is ever used here.
 */

const PROP_SKIP = new Set(['class', 'dataset', 'attrs', 'on', 'style', 'text']);

/**
 * Create an element.
 * @param {string} tag
 * @param {Record<string, any> | null} [props]
 * @param {...(Node | string | number | null | undefined | false | Array<any>)} children
 * @returns {HTMLElement}
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    if (props.class) el.className = Array.isArray(props.class) ? props.class.filter(Boolean).join(' ') : props.class;
    if (props.dataset) for (const [k, v] of Object.entries(props.dataset)) if (v != null) el.dataset[k] = String(v);
    if (props.attrs) {
      for (const [k, v] of Object.entries(props.attrs)) {
        if (v === false || v == null) continue;
        el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    if (props.style) for (const [k, v] of Object.entries(props.style)) el.style.setProperty(k, String(v));
    if (props.on) for (const [k, fn] of Object.entries(props.on)) if (typeof fn === 'function') el.addEventListener(k, fn);
    if (props.text != null) el.textContent = String(props.text);
    for (const [k, v] of Object.entries(props)) {
      if (PROP_SKIP.has(k) || v === undefined) continue;
      // @ts-ignore - assigning known DOM properties (id, title, type, value, disabled, hidden, tabIndex...)
      el[k] = v;
    }
  }
  appendChildren(el, children);
  return el;
}

/**
 * @param {Node} parent
 * @param {Array<any>} children
 */
function appendChildren(parent, children) {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) appendChildren(parent, child);
    else if (child instanceof Node) parent.appendChild(child);
    else parent.appendChild(document.createTextNode(String(child)));
  }
}

/**
 * Remove every child of an element.
 * @param {Element} el
 */
export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/**
 * Decorative icon drawn by CSS (`.icon-<name>` → mask-image of /img/icons/<name>.svg, colored by currentColor).
 * @param {string} name
 * @returns {HTMLElement}
 */
export function icon(name) {
  return h('span', { class: `icon icon-${name}`, attrs: { 'aria-hidden': 'true' } });
}
