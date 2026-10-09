/**
 * Sign-in view: one token field. Rate-limited attempts show a live countdown from Retry-After.
 */

import { h, clear, icon } from '../dom.js';
import { ApiError, errorText } from '../api.js';
import { onLocaleChange } from '../i18n.js';

/**
 * @typedef {'empty' | 'rate' | 'text'} ErrorKind
 */

/**
 * @param {{
 *   container: HTMLElement,
 *   api: { post(path: string, body?: unknown): Promise<any> },
 *   store: { get(): any },
 *   t: (key: string, vars?: Record<string, string | number>) => string,
 *   onAuthenticated: () => void | Promise<void>,
 * }} options
 * @returns {{ destroy(): void }}
 */
export function createLogin({ container, api, store, t, onAuthenticated }) {
  let destroyed = false;
  let busy = false;
  let draft = '';
  let retrySeconds = 0;
  /** @type {ReturnType<typeof setInterval> | null} */
  let countdown = null;
  /** @type {ErrorKind | null} */
  let errorKind = null;
  let errorMessage = '';

  /** @type {HTMLInputElement | null} */
  let input = null;
  /** @type {HTMLButtonElement | null} */
  let submitButton = null;
  /** @type {HTMLElement | null} */
  let errorEl = null;

  const appName = store.get().auth?.appName || store.get().meta?.appName || 'Agent Web';

  function currentErrorText() {
    if (errorKind === 'rate') return t('common.error.RATE_LIMITED', { seconds: retrySeconds });
    if (errorKind === 'empty') return t('shell.login.empty');
    return errorMessage;
  }

  function renderError() {
    if (!errorEl) return;
    const text = errorKind ? currentErrorText() : '';
    errorEl.textContent = text;
    errorEl.hidden = text === '';
  }

  function syncSubmit() {
    if (!submitButton) return;
    submitButton.disabled = busy || retrySeconds > 0;
    submitButton.setAttribute('aria-busy', String(busy));
  }

  function stopCountdown() {
    if (countdown !== null) clearInterval(countdown);
    countdown = null;
  }

  /** @param {number} seconds */
  function startCountdown(seconds) {
    stopCountdown();
    retrySeconds = Math.max(1, Math.ceil(seconds));
    errorKind = 'rate';
    renderError();
    syncSubmit();
    countdown = setInterval(() => {
      if (destroyed) {
        stopCountdown();
        return;
      }
      retrySeconds -= 1;
      if (retrySeconds <= 0) {
        stopCountdown();
        retrySeconds = 0;
        errorKind = null;
      }
      renderError();
      syncSubmit();
    }, 1000);
  }

  /** @param {Event} event */
  async function submit(event) {
    event.preventDefault();
    if (busy || retrySeconds > 0 || !input) return;
    const token = input.value.trim();
    if (!token) {
      errorKind = 'empty';
      renderError();
      input.focus();
      return;
    }
    busy = true;
    errorKind = null;
    renderError();
    syncSubmit();
    try {
      await api.post('/api/login', { token });
      if (destroyed) return;
      draft = '';
      busy = false;
      syncSubmit();
      await onAuthenticated();
    } catch (err) {
      if (destroyed) return;
      if (err instanceof ApiError && err.code === 'RATE_LIMITED') {
        startCountdown(err.retryAfter ?? 60);
      } else {
        errorKind = 'text';
        errorMessage = errorText(err, t);
        renderError();
      }
      input?.select();
    } finally {
      if (!destroyed) {
        busy = false;
        syncSubmit();
      }
    }
  }

  function mount() {
    clear(container);
    input = /** @type {HTMLInputElement} */ (h('input', {
      class: 'input login-token',
      attrs: {
        type: 'password',
        name: 'token',
        autocomplete: 'current-password',
        autocapitalize: 'none',
        autocorrect: 'off',
        spellcheck: false,
        required: true,
        'aria-describedby': 'login-error',
        placeholder: t('shell.login.placeholder'),
        'aria-label': t('shell.login.tokenLabel'),
      },
      on: { input: () => { draft = input?.value ?? ''; } },
    }));
    input.value = draft;

    errorEl = h('p', { class: 'login-error', attrs: { id: 'login-error', role: 'alert' } });

    submitButton = /** @type {HTMLButtonElement} */ (h('button', {
      class: 'btn btn-primary btn-lg btn-block',
      attrs: { type: 'submit' },
    }, t('shell.login.submit')));

    const form = h('form', {
      class: 'login-form',
      attrs: { novalidate: true },
      on: { submit },
    },
    h('label', { class: 'field' },
      h('span', { class: 'field-label', text: t('shell.login.tokenLabel') }),
      input),
    errorEl,
    submitButton);

    const card = h('section', { class: 'login-card', attrs: { 'aria-labelledby': 'login-title' } },
      h('div', { class: 'login-brand' },
        h('img', { class: 'login-logo', attrs: { src: '/img/logo.svg', alt: '', width: 44, height: 44 } }),
        h('span', { class: 'login-app', text: appName })),
      h('h1', { class: 'login-title', attrs: { id: 'login-title' }, text: t('shell.login.title') }),
      h('p', { class: 'login-subtitle', text: t('shell.login.subtitle') }),
      form,
      h('p', { class: 'login-footnote' }, icon('lock'), h('span', { text: t('shell.login.footnote') })));

    container.appendChild(h('main', { class: 'login-page' }, card));
    renderError();
    syncSubmit();
  }

  mount();
  const unsubscribe = onLocaleChange(() => {
    if (!destroyed) mount();
  });

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopCountdown();
      unsubscribe();
      clear(container);
    },
  };
}
