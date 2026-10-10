/**
 * Markdown rendering for model output. marked produces HTML, DOMPurify sanitizes it into a DocumentFragment, and a
 * post-processing pass hardens links and images, adds code-block headers and wraps tables. Nothing here uses innerHTML.
 */
import { Marked } from '/vendor/marked.esm.js';
import DOMPurify from '/vendor/purify.es.mjs';
import { h } from './dom.js';
import { t, getLocale } from './i18n.js';

const CACHE_LIMIT = 200;
const COPY_FEEDBACK_MS = 1600;
const SAFE_IMAGE_DATA_URI = /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i;
const URI_REGEXP = /^(?:https?:|mailto:|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$)|data:image\/(?:png|jpeg|gif|webp);base64,)/i;
const FORBID_TAGS = ['style', 'iframe', 'form', 'input', 'button', 'textarea', 'select', 'object', 'embed', 'script'];
const FORBID_ATTR = ['style', 'srcset'];

const marked = new Marked({ gfm: true, breaks: false });
/** @type {Map<string, DocumentFragment>} */
const cache = new Map();

/**
 * Renders Markdown into a sanitized, styled element. Never throws; malformed input falls back to plain text.
 * @param {string} text
 * @returns {HTMLElement} a div.md element
 */
export function renderMarkdown(text) {
  const source = typeof text === 'string' ? text : String(text ?? '');
  const root = h('div', { class: 'md' });
  root.addEventListener('click', onRootClick);
  try {
    const key = `${currentLocale()}\u0000${source}`;
    let fragment = cache.get(key);
    if (fragment) {
      cache.delete(key);
    } else {
      fragment = build(source);
    }
    cache.set(key, fragment);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
    root.append(fragment.cloneNode(true));
  } catch {
    root.textContent = source;
  }
  return root;
}

/** @returns {string} */
function currentLocale() {
  try {
    return getLocale();
  } catch {
    return 'en';
  }
}

/**
 * @param {string} source
 * @returns {DocumentFragment}
 */
function build(source) {
  const html = marked.parse(source, { async: false });
  const fragment = DOMPurify.sanitize(String(html), {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_URI_REGEXP: URI_REGEXP,
    FORBID_TAGS,
    FORBID_ATTR,
  });
  if (!(fragment instanceof DocumentFragment)) throw new TypeError('sanitizer did not return a fragment');
  finish(fragment);
  return fragment;
}

/**
 * @param {DocumentFragment} fragment
 */
function finish(fragment) {
  for (const anchor of Array.from(fragment.querySelectorAll('a[href]'))) {
    const href = anchor.getAttribute('href') ?? '';
    if (/^data:/i.test(href)) {
      anchor.removeAttribute('href');
      continue;
    }
    anchor.setAttribute('target', '_blank');
    anchor.setAttribute('rel', 'noopener noreferrer');
  }

  // Model output never loads images from the network: a remote or same-origin image becomes a link the user can follow.
  for (const image of Array.from(fragment.querySelectorAll('img'))) {
    const src = image.getAttribute('src') ?? '';
    if (/^data:/i.test(src)) {
      if (!SAFE_IMAGE_DATA_URI.test(src)) image.remove();
      continue;
    }
    if (!src) {
      image.remove();
      continue;
    }
    const link = document.createElement('a');
    link.setAttribute('href', src);
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
    link.textContent = image.getAttribute('alt') || src;
    image.replaceWith(link);
  }

  for (const pre of Array.from(fragment.querySelectorAll('pre'))) {
    const code = pre.querySelector('code');
    const language = languageOf(code);
    const wrapper = document.createElement('div');
    wrapper.className = 'code-block';
    const header = h('div', { class: 'code-head' },
      h('span', { class: 'code-lang', text: language || t('cards.code.plain') }),
      h('button', { class: 'code-copy', attrs: { type: 'button' }, text: t('cards.code.copy') }));
    pre.replaceWith(wrapper);
    wrapper.append(header, pre);
  }

  for (const table of Array.from(fragment.querySelectorAll('table'))) {
    const wrapper = document.createElement('div');
    wrapper.className = 'md-table-wrap';
    table.replaceWith(wrapper);
    wrapper.append(table);
  }
}

/**
 * @param {Element|null} code
 * @returns {string}
 */
function languageOf(code) {
  if (!code) return '';
  const match = /(?:^|\s)language-([a-z0-9_+#.-]{1,24})/i.exec(code.getAttribute('class') ?? '');
  return match ? match[1].toLowerCase() : '';
}

/**
 * Copy buttons are wired by delegation so cached fragments can be cloned safely.
 * @param {MouseEvent} event
 */
function onRootClick(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest('.code-copy');
  if (!button) return;
  const block = button.closest('.code-block');
  const pre = block ? block.querySelector('pre') : null;
  const text = pre ? pre.textContent ?? '' : '';
  copyText(text).then((ok) => flashButton(button, ok ? t('cards.code.copied') : t('cards.code.copyFailed')));
}

/**
 * @param {string} text
 * @returns {Promise<boolean>}
 */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {Element} button
 * @param {string} message
 */
function flashButton(button, message) {
  const original = button.getAttribute('data-label') ?? button.textContent ?? '';
  if (!button.hasAttribute('data-label')) button.setAttribute('data-label', original);
  button.textContent = message;
  button.classList.add('is-done');
  setTimeout(() => {
    button.textContent = button.getAttribute('data-label') ?? original;
    button.classList.remove('is-done');
  }, COPY_FEEDBACK_MS);
}
