/**
 * Terminal panel: the interactive Claude Code TUI in the browser. A session terminal attaches to a live session (the
 * gateway locks the session, so the graphical view pauses until the terminal closes). A directory terminal starts a
 * fresh runtime in a workspace folder. xterm.js is loaded from the vendored copy on first use. Every node is built
 * with h()/icon(); terminal output only ever reaches xterm's write().
 */

import { h, icon } from './dom.js';
import { onLocaleChange } from './i18n.js';

/** @typedef {{sessionId: string} | {cwd: string}} TerminalTarget */
/** @typedef {(key: string, vars?: Record<string, string | number>) => string} Translate */
/** @typedef {{key: string, tone: string, vars?: Record<string, string | number>}} StatusText */

const XTERM_STYLESHEET = '/vendor/xterm/xterm.css';
const HEIGHT_KEY = 'caw.terminalHeight';
const MIN_HEIGHT = 160;
const MAX_HEIGHT_RATIO = 0.8;
const DEFAULT_HEIGHT_RATIO = 0.4;
const RESIZE_STEP = 16;
const STYLESHEET_WAIT_MS = 3000;
const INPUT_PIECE_CHARS = 4096;
const COLS = { min: 20, max: 500 };
const ROWS = { min: 5, max: 200 };
const SCROLLBACK = 5000;
const ACTIVE_TURN_STATES = new Set(['running', 'requires_action']);
const KNOWN_ERROR_CODES = new Set([
  'TOO_MANY_TERMINALS', 'SESSION_LOCKED', 'SESSION_NOT_FOUND', 'PATH_NOT_ALLOWED', 'ENGINE_UNAVAILABLE', 'INTERNAL',
  'FEATURE_DISABLED', 'FORBIDDEN', 'UNAUTHENTICATED',
]);
const THEME_TOKENS = {
  background: '--bg-sunken',
  foreground: '--fg',
  cursor: '--accent',
  selectionBackground: '--accent-soft',
};
/**
 * Keys offered on touch devices. `sequence` is exactly what a hardware key sends. Visible and accessible names are
 * translated under `terminal.keyLabel.<id>` and `terminal.key.<id>`.
 */
const KEYS = [
  { id: 'esc', sequence: '\x1b' },
  { id: 'tab', sequence: '\t' },
  { id: 'shiftTab', sequence: '\x1b[Z' },
  { id: 'ctrlC', sequence: '\x03' },
  { id: 'up', sequence: '\x1b[A' },
  { id: 'down', sequence: '\x1b[B' },
  { id: 'right', sequence: '\x1b[C' },
  { id: 'left', sequence: '\x1b[D' },
  { id: 'enter', sequence: '\r' },
];

/** @type {Promise<{Terminal: any, FitAddon: any}> | null} */
let xtermLoad = null;
/** @type {CanvasRenderingContext2D | null} */
let colorContext = null;

/**
 * Terminal panel controller. Only one terminal is open at a time; opening another replaces it.
 * @param {{container: HTMLElement, api: {get: (path: string) => Promise<any>},
 *   store: {get: () => any, subscribe: (fn: (next: any) => void) => () => void}, t: Translate}} deps
 * @returns {{open: (target: TerminalTarget) => void, close: () => void, isOpen: () => boolean, destroy: () => void}}
 */
export function createTerminalPanel({ container, api, store, t }) {
  /** @type {TerminalView | null} */
  let view = null;
  /** @type {HTMLElement | null} */
  let returnFocus = null;
  const unsubscribeLocale = onLocaleChange(() => view?.applyLabels());
  const unsubscribeStore = store.subscribe((next) => view?.refreshActivity(next));

  /** @param {TerminalTarget} target */
  function open(target) {
    const normalized = normalizeTarget(target);
    if (!normalized) return;
    if (view) {
      const previous = view;
      view = null;
      previous.dispose();
    } else {
      returnFocus = focusedElement();
    }
    const live = 'sessionId' in normalized ? store.get().live?.[normalized.sessionId] : null;
    view = new TerminalView({
      target: normalized,
      activeTurn: Boolean(live && ACTIVE_TURN_STATES.has(live.state)),
      container,
      api,
      t,
      onDismiss: close,
    });
    void view.start();
  }

  function close() {
    if (!view) return;
    const current = view;
    view = null;
    current.dispose();
    const back = returnFocus;
    returnFocus = null;
    if (back?.isConnected) back.focus();
  }

  return {
    open,
    close,
    isOpen: () => view !== null,
    destroy() {
      close();
      unsubscribeStore();
      unsubscribeLocale();
    },
  };
}

/** One open terminal: DOM, xterm instance, WebSocket and layout. Disposed as a whole when closed. */
class TerminalView {
  /**
   * @param {{target: TerminalTarget, activeTurn: boolean, container: HTMLElement, api: {get: (path: string) => any},
   *   t: Translate, onDismiss: () => void}} options
   */
  constructor({ target, activeTurn, container, api, t, onDismiss }) {
    this.target = target;
    this.isSession = 'sessionId' in target;
    /** Whether the session has a running turn; kept current by refreshActivity(). */
    this.activeTurn = activeTurn;
    this.api = api;
    this.t = t;
    this.onDismiss = onDismiss;
    /** @type {StatusText | null} */
    this.status = null;
    this.disposed = false;
    this.loading = false;
    /** @type {any} */
    this.term = null;
    /** @type {any} */
    this.fit = null;
    /** @type {WebSocket | null} */
    this.socket = null;
    this.socketOpened = false;
    this.socketEnded = false;
    /** @type {{cols: number, rows: number} | null} */
    this.lastSize = null;
    this.height = 0;
    this.fitFrame = 0;
    /** @type {ResizeObserver | null} */
    this.resizeObserver = null;
    /** @type {MutationObserver | null} */
    this.themeObserver = null;
    /** @type {MediaQueryList | null} */
    this.colorScheme = null;
    this.buildDom();
    container.append(this.root);
    this.applyHeight(storedHeight());
    this.applyLabels();
    this.setStatus('terminal.status.connecting', 'busy');
    this.updateControls();
    window.addEventListener('resize', this.onWindowResize);
    window.visualViewport?.addEventListener('resize', this.onViewportChange);
    window.visualViewport?.addEventListener('scroll', this.onViewportChange);
  }

  onWindowResize = () => {
    this.applyHeight(this.height);
    this.syncViewport();
  };

  onViewportChange = () => this.syncViewport();

  onColorSchemeChange = () => this.applyTheme();

  buildDom() {
    const isSession = this.isSession;
    const els = {};
    els.resizer = h('div', {
      class: 'terminal-resizer',
      attrs: { role: 'separator', 'aria-orientation': 'horizontal', tabindex: '0' },
      on: { pointerdown: (event) => this.onResizeStart(event), keydown: (event) => this.onResizeKey(event) },
    });
    els.title = h('span', { class: 'terminal-title-text' });
    const label = targetLabel(this.target);
    els.target = h('code', { class: 'terminal-target', text: label, attrs: { title: label } });
    els.status = h('span', { class: 'terminal-status', attrs: { role: 'status', 'aria-live': 'polite' } });
    els.reconnectLabel = h('span', { class: 'terminal-btn-label' });
    els.reconnect = h('button', {
      class: 'btn btn-secondary btn-sm terminal-reconnect',
      attrs: { type: 'button', hidden: true },
      on: { click: () => this.reconnect() },
    }, icon('refresh'), els.reconnectLabel);
    els.closeLabel = h('span', { class: 'terminal-btn-label' });
    els.close = h('button', {
      class: 'btn btn-ghost btn-sm terminal-close',
      attrs: { type: 'button' },
      on: { click: () => this.onDismiss() },
    }, icon('x'), els.closeLabel);
    const header = h('header', { class: 'terminal-header' },
      h('div', { class: 'terminal-title' }, icon('terminal'), els.title),
      els.target,
      els.status,
      els.reconnect,
      els.close);
    els.bannerText = h('p', { class: 'terminal-banner-text' });
    els.bannerNote = h('p', { class: 'terminal-banner-note' });
    els.banner = h('div', { class: 'terminal-banner' }, icon('lock'),
      h('div', { class: 'terminal-banner-body' }, els.bannerText, els.bannerNote));
    els.screen = h('div', { class: 'terminal-screen' });
    els.ime = h('input', {
      class: 'terminal-ime',
      attrs: {
        type: 'text',
        autocomplete: 'off',
        autocapitalize: 'off',
        autocorrect: 'off',
        spellcheck: 'false',
        enterkeyhint: 'send',
      },
      on: { keydown: (event) => this.onImeKeydown(event) },
    });
    els.keys = KEYS.map((key) => ({
      key,
      el: h('button', {
        class: 'terminal-key',
        attrs: { type: 'button' },
        on: {
          // Keeps focus (and the on-screen keyboard) where it is.
          pointerdown: (event) => event.preventDefault(),
          click: () => this.sendInput(key.sequence),
        },
      }),
    }));
    els.keyRow = h('div', { class: 'terminal-key-row', attrs: { role: 'toolbar' } }, els.keys.map((item) => item.el));
    els.keyBar = h('div', { class: 'terminal-keys' }, els.keyRow, els.ime);
    this.els = els;
    this.root = h('section', {
      class: 'terminal-panel',
      dataset: { kind: isSession ? 'session' : 'directory' },
    }, els.resizer, header, els.banner, els.screen, els.keyBar);
  }

  /** Re-applies every translated string (also after a locale change). */
  applyLabels() {
    const { els, t } = this;
    const title = t('terminal.title');
    els.title.textContent = title;
    this.root.setAttribute('aria-label', title);
    els.resizer.setAttribute('aria-label', t('terminal.resize'));
    els.close.setAttribute('aria-label', t('terminal.close'));
    els.closeLabel.textContent = t('terminal.close');
    els.reconnectLabel.textContent = t('terminal.reconnect');
    els.bannerText.textContent = t('terminal.lockedBanner');
    els.bannerNote.textContent = t('terminal.runningWarning');
    els.keyRow.setAttribute('aria-label', t('terminal.keysLabel'));
    els.ime.setAttribute('aria-label', t('terminal.imeLabel'));
    els.ime.setAttribute('placeholder', t('terminal.imePlaceholder'));
    for (const item of els.keys) {
      item.el.textContent = t(`terminal.keyLabel.${item.key.id}`);
      item.el.setAttribute('aria-label', t(`terminal.key.${item.key.id}`));
    }
    this.renderStatus();
  }

  async start() {
    this.loading = true;
    this.updateControls();
    /** @type {{Terminal: any, FitAddon: any} | null} */
    let modules = null;
    try {
      [modules] = await Promise.all([loadXterm(), waitForStylesheet()]);
    } catch {
      modules = null;
    }
    this.loading = false;
    if (this.disposed || this.term !== null) return;
    if (!modules) {
      this.setStatus('terminal.status.loadFailed', 'error');
      this.updateControls();
      return;
    }
    this.mountTerminal(modules);
    this.connect();
    this.term.focus();
  }

  /** @param {{Terminal: any, FitAddon: any}} modules */
  mountTerminal({ Terminal, FitAddon }) {
    this.term = new Terminal({
      fontFamily: readToken('--font-mono') || 'monospace',
      fontSize: isTouchDevice() ? 14 : 13,
      cursorBlink: true,
      scrollback: SCROLLBACK,
      theme: readTheme(),
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(this.els.screen);
    this.term.onData((data) => this.sendInput(data));
    this.term.onResize(() => this.sendResize(false));
    this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
    this.resizeObserver.observe(this.els.screen);
    this.themeObserver = new MutationObserver(() => this.applyTheme());
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    this.colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
    this.colorScheme.addEventListener('change', this.onColorSchemeChange);
    this.scheduleFit();
    this.syncViewport();
  }

  connect() {
    const query = this.isSession
      ? new URLSearchParams({ sessionId: this.target.sessionId })
      : new URLSearchParams({ cwd: this.target.cwd });
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${window.location.host}/api/terminal?${query}`);
    this.socket = socket;
    this.socketOpened = false;
    this.socketEnded = false;
    this.setStatus('terminal.status.connecting', 'busy');
    socket.addEventListener('open', () => this.onSocketOpen(socket));
    socket.addEventListener('message', (event) => {
      if (this.socket === socket) this.onFrame(event.data);
    });
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.onSocketClosed();
    });
    this.updateControls();
  }

  /** @param {WebSocket} socket */
  onSocketOpen(socket) {
    if (this.socket !== socket) return;
    this.socketOpened = true;
    this.setStatus('terminal.status.connected', 'ok');
    this.sendResize(true);
    this.updateControls();
  }

  /** @param {unknown} raw */
  onFrame(raw) {
    /** @type {any} */
    let frame;
    try {
      frame = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!frame || typeof frame !== 'object') return;
    if (frame.type === 'output') {
      if (typeof frame.data === 'string' && this.term) this.term.write(frame.data);
    } else if (frame.type === 'exit') {
      this.socketEnded = true;
      this.setStatus('terminal.status.exited', 'muted', { code: String(frame.code) });
      this.updateControls();
    } else if (frame.type === 'error') {
      // BAD_REQUEST means this client sent something the gateway refused; the process keeps running.
      if (frame.code === 'BAD_REQUEST') return;
      this.socketEnded = true;
      this.setErrorStatus(frame.code);
      this.updateControls();
    }
  }

  onSocketClosed() {
    if (this.disposed) return;
    if (!this.socketOpened) {
      void this.diagnoseFailure();
      return;
    }
    if (!this.socketEnded) {
      this.socketEnded = true;
      this.setStatus('terminal.status.disconnected', 'error');
    }
    this.updateControls();
  }

  /**
   * The browser reports a refused WebSocket upgrade without a reason, so ask the gateway why.
   */
  async diagnoseFailure() {
    this.setStatus('terminal.status.failed', 'error');
    this.updateControls();
    /** @type {any} */
    let meta = null;
    try {
      meta = await this.api.get('/api/meta');
    } catch (err) {
      if (this.disposed || this.socket !== null) return;
      if (err?.code === 'UNAUTHENTICATED') this.setErrorStatus('UNAUTHENTICATED');
      return;
    }
    if (this.disposed || this.socket !== null) return;
    if (meta?.features?.terminal === false) this.setErrorStatus('FEATURE_DISABLED');
    else if (meta && meta.profile !== 'full') this.setErrorStatus('FORBIDDEN');
  }

  reconnect() {
    if (this.disposed || this.socket !== null || this.loading) return;
    if (this.term === null) {
      void this.start();
      return;
    }
    this.term.write(`\r\n\x1b[2m${this.t('terminal.restarted')}\x1b[0m\r\n`);
    this.connect();
  }

  /** @param {string} data */
  sendInput(data) {
    for (const piece of splitInput(data)) this.sendFrame({ type: 'input', data: piece });
  }

  /** @param {boolean} force send even when the size did not change (after every (re)connect) */
  sendResize(force) {
    if (!this.term || !this.isSocketOpen()) return;
    const cols = clampInt(this.term.cols, COLS);
    const rows = clampInt(this.term.rows, ROWS);
    if (!force && this.lastSize?.cols === cols && this.lastSize?.rows === rows) return;
    this.lastSize = { cols, rows };
    this.sendFrame({ type: 'resize', cols, rows });
  }

  /** @param {Record<string, unknown>} frame */
  sendFrame(frame) {
    if (this.isSocketOpen()) this.socket?.send(JSON.stringify(frame));
  }

  isSocketOpen() {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  /** @param {KeyboardEvent} event */
  onImeKeydown(event) {
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    const text = this.els.ime.value;
    this.els.ime.value = '';
    this.sendInput(`${text}\r`);
  }

  scheduleFit() {
    if (this.fitFrame !== 0 || !this.fit) return;
    this.fitFrame = requestAnimationFrame(() => {
      this.fitFrame = 0;
      if (this.disposed || !this.fit) return;
      try {
        this.fit.fit();
      } catch {
        // The element has no layout yet; the next resize observation retries.
      }
    });
  }

  applyTheme() {
    if (this.term) this.term.options.theme = readTheme();
  }

  /** @param {number} px */
  applyHeight(px) {
    this.height = clampHeight(px);
    this.root.style.setProperty('--terminal-h', `${this.height}px`);
    const { resizer } = this.els;
    resizer.setAttribute('aria-valuemin', String(MIN_HEIGHT));
    resizer.setAttribute('aria-valuemax', String(maxHeight()));
    resizer.setAttribute('aria-valuenow', String(this.height));
  }

  syncViewport() {
    const viewport = window.visualViewport;
    if (!viewport) return;
    this.root.style.setProperty('--terminal-vh', `${Math.round(viewport.height)}px`);
    this.root.style.setProperty('--terminal-vtop', `${Math.round(viewport.offsetTop)}px`);
  }

  /** @param {PointerEvent} event */
  onResizeStart(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = this.els.resizer;
    handle.setPointerCapture?.(event.pointerId);
    const startY = event.clientY;
    const startHeight = this.height;
    const move = (moveEvent) => this.applyHeight(startHeight + (startY - moveEvent.clientY));
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      storeHeight(this.height);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  /** @param {KeyboardEvent} event */
  onResizeKey(event) {
    const delta = event.key === 'ArrowUp' ? RESIZE_STEP : event.key === 'ArrowDown' ? -RESIZE_STEP : 0;
    if (delta === 0) return;
    event.preventDefault();
    this.applyHeight(this.height + delta);
    storeHeight(this.height);
  }

  /**
   * @param {string} key
   * @param {string} tone
   * @param {Record<string, string | number>} [vars]
   */
  setStatus(key, tone, vars) {
    this.status = { key, tone, vars };
    this.renderStatus();
  }

  /** @param {unknown} code */
  setErrorStatus(code) {
    const name = typeof code === 'string' ? code : '';
    if (KNOWN_ERROR_CODES.has(name)) this.setStatus(`terminal.error.${name}`, 'error');
    else if (name) this.setStatus('terminal.error.generic', 'error', { code: name });
    else this.setStatus('terminal.error.unknown', 'error');
  }

  renderStatus() {
    const { status } = this;
    const el = this.els.status;
    el.textContent = status ? this.t(status.key, status.vars) : '';
    el.dataset.tone = status?.tone ?? '';
  }

  /** The banner shows while a session terminal holds its session; reconnect only serves directory terminals. */
  updateControls() {
    const holding = this.isSession && this.socketOpened && !this.socketEnded;
    this.els.banner.hidden = !holding;
    this.els.bannerNote.hidden = !(holding && this.activeTurn);
    this.els.reconnect.hidden = this.isSession || this.disposed || this.loading || this.socket !== null;
  }

  /** @param {{live?: Record<string, {state?: string} | undefined>}} state */
  refreshActivity(state) {
    if (!('sessionId' in this.target)) return;
    const live = state.live?.[this.target.sessionId];
    const active = Boolean(live && ACTIVE_TURN_STATES.has(String(live.state)));
    if (active === this.activeTurn) return;
    this.activeTurn = active;
    this.updateControls();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const socket = this.socket;
    this.socket = null;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      socket.close(1000, 'closed');
    }
    if (this.fitFrame !== 0) cancelAnimationFrame(this.fitFrame);
    this.resizeObserver?.disconnect();
    this.themeObserver?.disconnect();
    this.colorScheme?.removeEventListener('change', this.onColorSchemeChange);
    window.removeEventListener('resize', this.onWindowResize);
    window.visualViewport?.removeEventListener('resize', this.onViewportChange);
    window.visualViewport?.removeEventListener('scroll', this.onViewportChange);
    this.term?.dispose();
    this.term = null;
    this.fit = null;
    this.root.remove();
  }
}

/**
 * @param {unknown} target
 * @returns {TerminalTarget | null}
 */
function normalizeTarget(target) {
  if (!target || typeof target !== 'object') return null;
  const { sessionId, cwd } = /** @type {Record<string, unknown>} */ (target);
  if (typeof sessionId === 'string' && sessionId !== '') return { sessionId };
  if (typeof cwd === 'string' && cwd !== '') return { cwd };
  return null;
}

/** @param {TerminalTarget} target */
function targetLabel(target) {
  return 'sessionId' in target ? target.sessionId : target.cwd;
}

/** @returns {HTMLElement | null} */
function focusedElement() {
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : null;
}

/** @returns {Promise<{Terminal: any, FitAddon: any}>} */
function loadXterm() {
  if (!xtermLoad) {
    xtermLoad = Promise.all([import('/vendor/xterm/xterm.mjs'), import('/vendor/xterm/addon-fit.mjs')])
      .then(([xterm, fit]) => ({ Terminal: xterm.Terminal, FitAddon: fit.FitAddon }))
      .catch((err) => {
        xtermLoad = null;
        throw err;
      });
  }
  return xtermLoad;
}

/**
 * Makes sure the vendored xterm stylesheet is applied before the terminal measures its cells. Resolves even when the
 * stylesheet fails or is slow, so a broken asset degrades the layout instead of blocking the panel.
 * @returns {Promise<void>}
 */
function waitForStylesheet() {
  let link = document.querySelector(`link[href="${XTERM_STYLESHEET}"]`);
  if (!link) {
    link = h('link', { attrs: { rel: 'stylesheet', href: XTERM_STYLESHEET } });
    document.head.append(link);
  }
  const element = /** @type {HTMLLinkElement} */ (link);
  if (element.sheet) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, STYLESHEET_WAIT_MS);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const failed = () => {
      // Forget the failed link so that the next open requests the stylesheet again.
      element.remove();
      done();
    };
    element.addEventListener('load', done, { once: true });
    element.addEventListener('error', failed, { once: true });
  });
}

/** @returns {boolean} */
function isTouchDevice() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
}

/**
 * @param {string} name a CSS custom property
 * @returns {string}
 */
function readToken(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** @returns {Record<string, string>} */
function readTheme() {
  /** @type {Record<string, string>} */
  const theme = {};
  for (const [key, token] of Object.entries(THEME_TOKENS)) {
    const color = cssColor(readToken(token));
    if (color) theme[key] = color;
  }
  return theme;
}

/**
 * Converts any CSS color (including oklch or color-mix results) to an rgb()/rgba() string, which xterm accepts.
 * Returns null when the value is not a color.
 * @param {string} value
 * @returns {string | null}
 */
function cssColor(value) {
  if (!value) return null;
  colorContext ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!colorContext) return null;
  const sentinel = '#010203';
  colorContext.fillStyle = sentinel;
  colorContext.fillStyle = value;
  if (colorContext.fillStyle === sentinel && value.toLowerCase() !== sentinel) return null;
  colorContext.clearRect(0, 0, 1, 1);
  colorContext.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = colorContext.getImageData(0, 0, 1, 1).data;
  return a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
}

/**
 * Splits input into pieces that each fit comfortably in one gateway frame, never inside a surrogate pair.
 * @param {string} data
 * @returns {string[]}
 */
function splitInput(data) {
  const pieces = [];
  let start = 0;
  while (start < data.length) {
    let end = Math.min(data.length, start + INPUT_PIECE_CHARS);
    if (end < data.length && isHighSurrogate(data.charCodeAt(end - 1))) end -= 1;
    pieces.push(data.slice(start, end));
    start = end;
  }
  return pieces;
}

/** @param {number} code */
function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * @param {number} value
 * @param {{min: number, max: number}} range
 */
function clampInt(value, { min, max }) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : min;
}

function maxHeight() {
  return Math.max(MIN_HEIGHT, Math.floor(window.innerHeight * MAX_HEIGHT_RATIO));
}

/** @param {number} px */
function clampHeight(px) {
  return Math.round(Math.min(maxHeight(), Math.max(MIN_HEIGHT, px)));
}

/** The remembered panel height, or 40% of the window when none is stored (storage may be blocked). */
function storedHeight() {
  try {
    const value = Number(localStorage.getItem(HEIGHT_KEY));
    if (Number.isFinite(value) && value > 0) return value;
  } catch {
    // Storage is unavailable; use the default below.
  }
  return Math.round(window.innerHeight * DEFAULT_HEIGHT_RATIO);
}

/** @param {number} px */
function storeHeight(px) {
  try {
    localStorage.setItem(HEIGHT_KEY, String(px));
  } catch {
    // Storage is unavailable; the height is simply not remembered.
  }
}
