/**
 * Account section of Settings: who is signed in to Claude Code, and the runtime's own sign-in flow (the same one the
 * terminal's /login runs). The gateway never reads or writes credentials; it only relays the sign-in steps. Signing
 * out is not offered here: the terminal's /logout does it.
 */

import { h, clear, icon } from '../dom.js';
import { ApiError, errorText } from '../api.js';

/**
 * Rows that describe the signed-in account. Values are shown as text.
 * @param {Record<string, unknown> | null | undefined} account
 * @returns {Array<{label: string, value: string}>}
 */
export function accountFacts(account) {
  if (!account || typeof account !== 'object') return [];
  const facts = [];
  const add = (label, value) => {
    if (typeof value === 'string' && value !== '') facts.push({ label, value });
  };
  add('email', account.email);
  add('organization', account.organization);
  add('subscription', account.subscriptionType);
  add('provider', account.apiProvider);
  return facts;
}

/**
 * Splits a pasted sign-in code the way the gateway expects it: `<authorizationCode>#<state>`, both parts non-empty.
 * Returns null for anything else, so the form can refuse it before a request is made.
 * @param {string} value
 * @returns {string | null} the trimmed code, or null
 */
export function validSignInCode(value) {
  const code = String(value ?? '').trim();
  const parts = code.split('#');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') return null;
  return code;
}

/**
 * Mounts the account section into `container`. Returns the teardown function.
 * @param {HTMLElement} container
 * @param {{ api: any, store: any, t: (key: string, vars?: Record<string, unknown>) => string, actions: any }} deps
 * @returns {() => void}
 */
export function mountAccountSection(container, { api, store, t, actions }) {
  let disposed = false;
  /** @type {{manualUrl: string} | null} the sign-in this page started and has not finished */
  let flow = null;
  /** The last sign-in that completed in this page view: the note asks to reopen sessions. */
  let signedInAs = '';
  /** @type {string} */
  let error = '';
  let busy = false;
  /** The code as typed, kept across re-renders. */
  let draft = '';

  const profile = () => store.get().meta?.profile ?? store.get().auth?.profile ?? 'read';
  const canSignIn = () => profile() === 'full' && store.get().meta?.features?.accountLogin === true;

  /** @param {unknown} err */
  function failure(err) {
    if (err instanceof ApiError && err.code === 'INVALID_ARGUMENT') return t('shell.account.invalidCode');
    if (err instanceof ApiError && err.code === 'CONFLICT') return t('shell.account.noFlow');
    if (err instanceof ApiError && err.code === 'FORBIDDEN' && err.message) return err.message;
    return errorText(err, t);
  }

  async function start(method) {
    if (busy || !canSignIn()) return;
    busy = true;
    error = '';
    signedInAs = '';
    render();
    try {
      const answer = await api.post('/api/account/login', { method });
      if (disposed) return;
      flow = { manualUrl: typeof answer?.manualUrl === 'string' ? answer.manualUrl : '' };
    } catch (err) {
      if (disposed) return;
      error = failure(err);
    } finally {
      busy = false;
      if (!disposed) render();
    }
  }

  /** @param {HTMLInputElement} input */
  async function submit(input) {
    draft = input.value;
    const code = validSignInCode(draft);
    if (code === null) {
      error = t('shell.account.invalidCode');
      render();
      container.querySelector('.account-code')?.focus();
      return;
    }
    busy = true;
    error = '';
    render();
    try {
      const answer = await api.post('/api/account/login/code', { code });
      if (disposed) return;
      const account = answer?.account ?? null;
      store.set({ account: { account, signInPending: false } });
      signedInAs = typeof account?.email === 'string' && account.email !== '' ? account.email : t('shell.account.you');
      flow = null;
      draft = '';
      actions.toast(t('shell.account.signedIn', { email: signedInAs }), 'success');
    } catch (err) {
      if (disposed) return;
      error = failure(err);
    } finally {
      busy = false;
      if (!disposed) render();
    }
  }

  async function cancel() {
    busy = true;
    render();
    try {
      await api.del('/api/account/login');
    } catch (err) {
      if (!disposed) actions.toast(failure(err), 'error');
    } finally {
      busy = false;
      flow = null;
      if (!disposed) render();
    }
  }

  function signInControls() {
    if (!canSignIn()) {
      return h('p', { class: 'sheet-note', text: profile() === 'full'
        ? t('shell.account.unavailable') : t('shell.account.needsFull') });
    }
    const current = store.get().account;
    const pending = current?.signInPending === true;
    if (flow === null && !pending) {
      return h('div', { class: 'sheet-inline' },
        h('button', {
          class: 'btn btn-secondary btn-sm',
          attrs: { type: 'button', disabled: busy },
          on: { click: () => start('claudeai') },
        }, icon('spark'), h('span', { text: t('shell.account.signInClaude') })),
        h('button', {
          class: 'btn btn-secondary btn-sm',
          attrs: { type: 'button', disabled: busy },
          on: { click: () => start('console') },
        }, icon('cpu'), h('span', { text: t('shell.account.signInConsole') })));
    }
    const steps = [];
    if (flow !== null && flow.manualUrl) {
      steps.push(h('li', { class: 'account-step' },
        h('p', { class: 'account-step-title', text: t('shell.account.step1') }),
        h('a', {
          class: 'btn btn-secondary btn-sm account-link',
          attrs: { href: flow.manualUrl, target: '_blank', rel: 'noopener noreferrer' },
        }, icon('external'), h('span', { text: t('shell.account.openPage') }))));
    }
    const input = h('input', {
      class: 'input mono account-code',
      attrs: {
        type: 'text',
        autocomplete: 'off',
        autocapitalize: 'none',
        autocorrect: 'off',
        spellcheck: false,
        'aria-label': t('shell.account.codeLabel'),
        placeholder: t('shell.account.codePlaceholder'),
      },
      on: {
        input: () => {
          draft = input.value;
        },
        keydown: (event) => {
          if (event.key === 'Enter' && !event.isComposing) {
            event.preventDefault();
            submit(/** @type {HTMLInputElement} */ (event.currentTarget));
          }
        },
      },
    });
    input.value = draft;
    steps.push(h('li', { class: 'account-step' },
      h('p', { class: 'account-step-title', text: t('shell.account.step2') }),
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: t('shell.account.codeLabel') }), input),
      h('div', { class: 'sheet-inline' },
        h('button', {
          class: 'btn btn-primary btn-sm',
          attrs: { type: 'button', disabled: busy },
          on: { click: () => submit(input) },
        }, t('shell.account.submit')),
        h('button', {
          class: 'btn btn-secondary btn-sm',
          attrs: { type: 'button', disabled: busy },
          on: { click: () => cancel() },
        }, t('common.cancel')))));
    return h('div', { class: 'account-flow' },
      h('p', { class: 'sheet-note', text: flow === null ? t('shell.account.pendingNote') : t('shell.account.flowNote') }),
      h('ol', { class: 'account-steps' }, steps));
  }

  function render() {
    if (disposed) return;
    clear(container);
    const state = store.get().account;
    const account = state?.account ?? null;
    const facts = accountFacts(account);
    if (state === null || state === undefined) {
      container.append(h('p', { class: 'sheet-note', text: t('common.loading') }));
      return;
    }
    if (account) {
      container.append(h('div', { class: 'kv-list' },
        h('div', { class: 'kv-row' },
          h('span', { class: 'kv-label', text: t('shell.account.status') }),
          h('span', { class: 'chip chip-success', text: t('shell.account.statusSigned') })),
        ...facts.map((fact) => h('div', { class: 'kv-row' },
          h('span', { class: 'kv-label', text: t(`shell.account.fact.${fact.label}`) }),
          h('span', { class: ['kv-value', fact.label === 'email' ? 'mono' : ''], attrs: { title: fact.value } }, fact.value)))));
    } else if (state.failed === true) {
      container.append(h('p', { class: 'form-error', attrs: { role: 'alert' }, text: t('shell.account.loadFailed') }));
    } else {
      container.append(h('p', { class: 'sheet-note', text: t('shell.account.notSignedIn') }));
    }
    if (signedInAs) container.append(h('p', { class: 'sheet-note account-reopen', attrs: { role: 'status' }, text: t('shell.account.reopen') }));
    container.append(signInControls());
    if (error) container.append(h('p', { class: 'form-error', attrs: { role: 'alert' }, text: error }));
    container.append(h('p', { class: 'field-hint', text: t('shell.account.logoutNote') }));
  }

  const unsubscribe = store.subscribe((state, prev) => {
    if (state.account !== prev.account || state.meta !== prev.meta || state.auth !== prev.auth) render();
  });
  render();
  return () => {
    disposed = true;
    unsubscribe();
  };
}
