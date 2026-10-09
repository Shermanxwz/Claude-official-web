/**
 * Bootstrap: registers every locale message module, applies preferences to the document, checks the session and
 * shows either the sign-in view or the application shell. An unreachable gateway gets a localized error page.
 */

import './locales/en.core.js';
import './locales/zh-CN.core.js';
import './locales/en.composer.js';
import './locales/zh-CN.composer.js';
import './locales/en.cards.js';
import './locales/zh-CN.cards.js';
import './locales/en.tools.js';
import './locales/zh-CN.tools.js';
import './locales/en.terminal.js';
import './locales/zh-CN.terminal.js';

import { h, clear, icon } from './dom.js';
import { api, errorText } from './api.js';
import { store } from './store.js';
import { getLocale, onLocaleChange, setLocale, t } from './i18n.js';
import { createAppShell } from './ui/app-shell.js';
import { createLogin } from './ui/login.js';

const appRoot = document.getElementById('app');
const DEFAULT_APP_NAME = 'Agent Web';

/** @type {{ kind: 'login' | 'shell', handle: { destroy(): void } } | null} */
let view = null;
/** @type {string | null} */
let fatalMessage = null;
let checking = false;

/** @param {{theme: string, fontSize: string, locale: string | null}} prefs */
function applyPrefs(prefs) {
  const root = document.documentElement;
  root.dataset.theme = prefs.theme;
  root.dataset.fontSize = prefs.fontSize;
  if (prefs.locale && prefs.locale !== getLocale()) setLocale(prefs.locale);
}

function appName() {
  const { auth, meta } = store.get();
  return meta?.appName || auth?.appName || DEFAULT_APP_NAME;
}

function destroyView() {
  if (!view) return;
  const current = view;
  view = null;
  current.handle.destroy();
}

function renderLoading() {
  destroyView();
  fatalMessage = null;
  clear(appRoot);
  appRoot.append(h('main', { class: 'boot-page' },
    h('span', { class: 'spinner spinner-lg', attrs: { role: 'status', 'aria-label': t('common.loading') } })));
}

/** @param {string} message */
function renderFatal(message) {
  destroyView();
  fatalMessage = message;
  clear(appRoot);
  appRoot.append(h('main', { class: 'fatal-page' },
    h('section', { class: 'fatal-card', attrs: { role: 'alert' } },
      h('img', { class: 'fatal-logo', attrs: { src: '/img/logo.svg', alt: '', width: 44, height: 44 } }),
      h('h1', { class: 'fatal-title', text: t('shell.fatal.title') }),
      h('p', { class: 'fatal-text', text: message }),
      h('button', {
        class: 'btn btn-primary',
        attrs: { type: 'button' },
        on: { click: () => bootSession() },
      }, icon('refresh'), h('span', { text: t('common.retry') })))));
}

/** Show the view that matches the current authentication state. */
function render() {
  if (fatalMessage !== null || checking) return;
  const wanted = store.get().auth.authenticated ? 'shell' : 'login';
  if (view && view.kind === wanted) return;
  destroyView();
  clear(appRoot);
  if (wanted === 'shell') {
    view = { kind: 'shell', handle: createAppShell({ root: appRoot, api, store, t }) };
    return;
  }
  document.title = appName();
  view = {
    kind: 'login',
    handle: createLogin({ container: appRoot, api, store, t, onAuthenticated: () => bootSession() }),
  };
}

/** Read /api/session and move to the matching view. */
async function bootSession() {
  if (checking) return;
  checking = true;
  if (view === null) renderLoading();
  try {
    const session = await api.get('/api/session');
    checking = false;
    store.set({
      auth: {
        authenticated: session.authenticated === true,
        authRequired: session.authRequired === true,
        profile: session.profile ?? null,
        appName: typeof session.appName === 'string' ? session.appName : '',
        version: typeof session.version === 'string' ? session.version : '',
        bootId: typeof session.bootId === 'string' ? session.bootId : '',
      },
    });
    fatalMessage = null;
    render();
  } catch (err) {
    checking = false;
    renderFatal(errorText(err, t));
  }
}

applyPrefs(store.get().prefs);

store.subscribe((state, prev) => {
  if (state.prefs !== prev.prefs) applyPrefs(state.prefs);
  if (state.auth.authenticated !== prev.auth.authenticated) render();
});

onLocaleChange(() => {
  if (fatalMessage !== null) renderFatal(fatalMessage);
  else if (view?.kind === 'login') document.title = appName();
});

renderLoading();
bootSession();
