import { errorText } from '../api.js';
import { getLocale } from '../i18n.js';
import { clear, h, icon } from '../dom.js';
import { effortLevelsFor, effortModelFor, modelSelectPlan } from './composer-logic.js';
import { openDialog } from './dialog.js';
import { openMenu } from './menu.js';

/**
 * Session header: title, working directory, model / permission / effort controls, context meter, state badge and the
 * overflow menu. It renders from the store and changes settings through `actions.updateSettings`, showing the new
 * value at once and rolling it back when the request fails.
 */

const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk'];
const CONTEXT_WARN_PERCENT = 80;
const MOBILE_QUERY = '(max-width: 767.98px)';

/** @type {Map<string, Intl.NumberFormat>} */
const countFormatters = new Map();

/**
 * @param {number} value
 * @param {string} locale
 * @returns {string}
 */
function formatCount(value, locale) {
  let formatter = countFormatters.get(locale);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });
    countFormatters.set(locale, formatter);
  }
  return formatter.format(value);
}

/**
 * Turns SDKControlGetContextUsageResponse into the meter's view, or null when no usable figure is present.
 * @param {string} id
 * @param {any} usage
 * @returns {{id: string, percent: number, used: number, max: number}|null}
 */
function toContextView(id, usage) {
  const used = Number(usage?.totalTokens);
  const max = Number(usage?.maxTokens);
  let percent = Number(usage?.percentage);
  if (!Number.isFinite(percent)) percent = max > 0 ? (used / max) * 100 : Number.NaN;
  if (!Number.isFinite(percent)) return null;
  return {
    id,
    percent: Math.min(100, Math.max(0, percent)),
    used: Number.isFinite(used) ? used : 0,
    max: Number.isFinite(max) ? max : 0,
  };
}

/**
 * Replaces the text of `el` with `full`, shortened in the middle with an ellipsis until it fits its box.
 * The start and the end of the path are kept, with more of the end (the project folder) preserved.
 * @param {HTMLElement} el
 * @param {string} full
 */
function fitMiddle(el, full) {
  el.textContent = full;
  el.title = full;
  if (!full || el.scrollWidth <= el.clientWidth) return;
  let lo = 0;
  let hi = full.length;
  let best = '…';
  while (lo < hi) {
    const keep = Math.ceil((lo + hi) / 2);
    const head = Math.ceil(keep * 0.4);
    const tail = keep - head;
    const candidate = `${full.slice(0, head)}…${full.slice(full.length - tail)}`;
    el.textContent = candidate;
    if (el.scrollWidth <= el.clientWidth) {
      lo = keep;
      best = candidate;
    } else {
      hi = keep - 1;
    }
  }
  el.textContent = best;
}

/**
 * Rebuilds a select only when its option list changes, so an open dropdown is not disturbed by unrelated store updates.
 * @param {HTMLSelectElement} select
 * @param {Array<{value: string, label: string, title?: string}>} options
 * @param {string} selected
 */
function fillSelect(select, options, selected) {
  const signature = JSON.stringify(options);
  if (select.dataset.sig !== signature) {
    clear(select);
    for (const option of options) {
      select.appendChild(h('option', {
        attrs: { value: option.value, title: option.title || null },
        text: option.label,
      }));
    }
    select.dataset.sig = signature;
  }
  if (select.value !== selected) select.value = selected;
}

/**
 * @typedef {Object} HeaderDeps
 * @property {HTMLElement} container
 * @property {{get: (path: string) => Promise<any>}} api
 * @property {{get: () => any, set: (partial: object) => void, subscribe: (fn: () => void) => () => void}} store
 * @property {(key: string, vars?: Record<string, unknown>) => string} t
 * @property {Record<string, (...args: any[]) => any>} actions
 */

/**
 * @param {HeaderDeps} deps
 * @returns {{setSession: (sessionId: string|null) => void, destroy: () => void}}
 */
export function createHeader({ container, api, store, t, actions }) {
  const view = {
    id: /** @type {string|null} */ (null),
    cwd: '',
    liveState: /** @type {string|null} */ (null),
    ctx: /** @type {ReturnType<typeof toContextView>} */ (null),
    /** Settings chosen in the header that the live query has not confirmed yet (or that wait for the next open). */
    overrides: /** @type {Map<string, Record<string, unknown>>} */ (new Map()),
    options: { model: [], mode: [], effort: [] },
    /** The option values the header selects show, so the phone pickers mark the same choices. */
    selected: { model: '', mode: 'default', effort: '' },
    disposed: false,
  };

  const menuBtn = h('button', {
    class: 'hdr-icon-btn hdr-menu',
    attrs: { type: 'button', 'aria-label': t('header.toggleSidebar'), 'aria-expanded': 'false' },
    on: { click: toggleSidebar },
  }, icon('menu'));

  const titleText = h('span', { class: 'hdr-title-text' });
  const titleBtn = /** @type {HTMLButtonElement} */ (h('button', {
    class: 'hdr-title',
    attrs: { type: 'button', title: t('header.rename') },
    on: { click: () => actions.renameSession() },
  }, titleText));

  const cwdText = h('span', { class: 'hdr-cwd-text' });
  const cwdEl = h('div', { class: 'hdr-cwd' }, cwdText);
  const titles = h('div', { class: 'hdr-titles' }, titleBtn, cwdEl);
  const left = h('div', { class: 'hdr-left' }, menuBtn, titles);

  const modelSel = /** @type {HTMLSelectElement} */ (h('select', {
    class: 'hdr-select hdr-model',
    attrs: { 'aria-label': t('header.model') },
    on: { change: () => commitChange({ model: modelSel.value || null }) },
  }));
  const modeSel = /** @type {HTMLSelectElement} */ (h('select', {
    class: 'hdr-select hdr-mode',
    attrs: { 'aria-label': t('header.permissionMode') },
    on: { change: () => commitChange({ permissionMode: modeSel.value }) },
  }));
  const effortSel = /** @type {HTMLSelectElement} */ (h('select', {
    class: 'hdr-select hdr-effort',
    attrs: { 'aria-label': t('header.effortLabel') },
    on: { change: () => commitChange({ effort: effortSel.value || null }) },
  }));

  const ctxFill = h('span', { class: 'ctx-fill' });
  const ctxLabel = h('span', { class: 'ctx-label' });
  const ctxBtn = h('button', {
    class: 'ctx-meter',
    attrs: { type: 'button' },
    on: { click: () => actions.openPanel('context') },
  }, h('span', { class: 'ctx-track', attrs: { 'aria-hidden': 'true' } }, ctxFill), ctxLabel);

  const spinner = h('span', { class: 'state-spinner', attrs: { 'aria-hidden': 'true' } });
  const badgeText = h('span', { class: 'state-text' });
  const badge = h('span', { class: 'state-badge' }, spinner, badgeText);

  const moreBtn = h('button', {
    class: 'hdr-icon-btn hdr-more',
    attrs: { type: 'button', 'aria-haspopup': 'menu', 'aria-label': t('header.more') },
    on: { click: openOverflow },
  }, icon('more'));

  const controls = h('div', { class: 'hdr-controls' }, modelSel, modeSel, effortSel, ctxBtn);
  const right = h('div', { class: 'hdr-right' }, controls, badge, moreBtn);
  const root = h('header', { class: 'session-header' }, left, right);
  container.appendChild(root);

  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fitCwd()) : null;
  resizeObserver?.observe(cwdEl);
  const unsubscribe = store.subscribe(onStoreChange);

  function fitCwd() {
    if (view.cwd) fitMiddle(cwdText, view.cwd);
  }

  function toggleSidebar() {
    const prefs = store.get().prefs ?? {};
    store.set({ prefs: { ...prefs, sidebarOpen: !prefs.sidebarOpen } });
  }

  /**
   * Live settings first, then the defaults advertised by /api/meta; header changes made since are layered on top.
   * @param {string|null} id
   * @param {any} live
   * @param {any} meta
   */
  function effectiveSettings(id, live, meta) {
    const defaults = meta?.defaults ?? {};
    const base = live
      ? { model: live.model ?? null, permissionMode: live.permissionMode ?? 'default', effort: live.effort ?? null }
      : { model: defaults.model ?? null, permissionMode: defaults.permissionMode ?? 'default',
        effort: defaults.effort ?? null };
    return { ...base, ...(id ? view.overrides.get(id) : null) };
  }

  function sync() {
    if (view.disposed) return;
    const s = store.get();
    const meta = s.meta ?? null;
    const defaults = meta?.defaults ?? {};
    const id = view.id;
    const hasSession = Boolean(id);
    const live = id ? (s.live?.[id] ?? null) : null;
    const summary = id ? ((s.sessions ?? []).find((x) => x.sessionId === id) ?? null) : null;
    const profile = s.auth?.profile ?? meta?.profile ?? 'full';
    const readOnly = profile === 'read';
    const locked = Boolean(id && (live?.lockedBy === 'terminal' || s.terminal?.[id]?.attached));
    const editable = hasSession && !readOnly && !locked;

    root.classList.toggle('is-empty', !hasSession);
    if (hasSession) {
      titleText.textContent = live?.title || summary?.customTitle || summary?.summary || t('header.untitled');
      titleBtn.disabled = readOnly;
      const cwd = live?.cwd || summary?.cwd || '';
      cwdEl.hidden = !cwd;
      if (cwd !== view.cwd) {
        view.cwd = cwd;
        fitCwd();
      }
    } else {
      titleText.textContent = meta?.appName ?? '';
      titleBtn.disabled = true;
      cwdEl.hidden = true;
      view.cwd = '';
    }

    const badgeKey = !hasSession ? null : locked ? 'locked' : live ? live.state : 'closed';
    badge.hidden = !badgeKey;
    if (badgeKey) {
      badge.dataset.state = badgeKey;
      badgeText.textContent = t(`header.state.${badgeKey}`);
      spinner.hidden = badgeKey !== 'running';
      if (live?.error?.message) badge.title = live.error.message;
      else badge.removeAttribute('title');
    }

    const settings = effectiveSettings(id, live, meta);
    const models = Array.isArray(s.capabilities?.[id]?.models) ? s.capabilities[id].models : [];
    const modelPlan = modelSelectPlan(models, settings.model, {
      defaultLabel: t('header.defaultModel'),
      currentLabel: (modelId) => t('header.currentModel', { id: modelId }),
    });
    const levels = effortLevelsFor(effortModelFor(models, settings.model, defaults.model ?? null));

    const modes = meta?.features?.bypass ? [...PERMISSION_MODES, 'bypassPermissions'] : PERMISSION_MODES;
    const modeValue = settings.permissionMode;
    const modeOptions = modes.map((m) => ({
      value: m,
      label: t(`common.mode.${m}`),
      title: t(`common.mode.${m}.hint`),
    }));
    if (!modes.includes(modeValue)) modeOptions.push({ value: modeValue, label: modeValue, title: '' });

    const effortValue = settings.effort ?? '';
    const effortOptions = [{ value: '', label: t('header.effortDefault') }];
    for (const level of levels) effortOptions.push({ value: level, label: t(`header.effort.${level}`) });
    if (effortValue && !levels.includes(effortValue)) effortOptions.push({ value: effortValue, label: effortValue });

    fillSelect(modelSel, modelPlan.options, modelPlan.value);
    fillSelect(modeSel, modeOptions, modeValue);
    fillSelect(effortSel, effortOptions, effortValue);
    modelSel.disabled = !editable;
    modeSel.disabled = !editable;
    effortSel.disabled = !editable;
    modeSel.title = t(`common.mode.${modeValue}.hint`);
    effortSel.hidden = levels.length === 0;
    controls.hidden = !hasSession;
    view.options = { model: modelPlan.options, mode: modeOptions, effort: effortOptions.slice(1) };
    view.selected = { model: modelPlan.value, mode: modeValue, effort: effortValue };

    const ctxReady = Boolean(live && view.ctx && view.ctx.id === id);
    ctxBtn.hidden = !ctxReady;
    if (ctxReady) {
      const percent = Math.round(view.ctx.percent);
      const locale = getLocale();
      const tip = t('header.context.tooltip', {
        used: formatCount(view.ctx.used, locale),
        max: formatCount(view.ctx.max, locale),
        percent,
      });
      ctxFill.style.setProperty('width', `${view.ctx.percent}%`);
      ctxLabel.textContent = `${percent}%`;
      ctxBtn.classList.toggle('is-warning', view.ctx.percent >= CONTEXT_WARN_PERCENT);
      ctxBtn.title = tip;
      ctxBtn.setAttribute('aria-label', tip);
    }

    menuBtn.setAttribute('aria-expanded', String(Boolean(s.prefs?.sidebarOpen)));
  }

  /**
   * Writes a settings change: shows it at once, sends it, and rolls back only when the change is refused. The shell's
   * updateSettings resolves to false after it has shown the reason; to the live info when a live session took the
   * change, which the store then holds, so the overrides settle; and to null when a session that is not live saved it
   * for its next open, so the override stays. A throw counts as a refusal and gets a toast, although the shell does not
   * throw.
   * @param {Record<string, unknown>} patch
   */
  async function commitChange(patch) {
    const id = view.id;
    if (!id) return;
    const previous = { ...(view.overrides.get(id) ?? {}) };
    view.overrides.set(id, { ...previous, ...patch });
    sync();
    let refused = false;
    try {
      refused = (await actions.updateSettings(patch)) === false;
    } catch (err) {
      refused = true;
      actions.toast(errorText(err, t), 'error');
    }
    if (refused) restoreOverrides(id, patch, previous);
    else if (store.get().live?.[id]) settleOverrides(id, patch);
    sync();
  }

  /**
   * Drops the overrides that the live query now confirms.
   * @param {string} id
   * @param {Record<string, unknown>} patch
   */
  function settleOverrides(id, patch) {
    const current = { ...(view.overrides.get(id) ?? {}) };
    for (const key of Object.keys(patch)) {
      if (current[key] === patch[key]) delete current[key];
    }
    if (Object.keys(current).length) view.overrides.set(id, current);
    else view.overrides.delete(id);
  }

  /**
   * @param {string} id
   * @param {Record<string, unknown>} patch
   * @param {Record<string, unknown>} previous
   */
  function restoreOverrides(id, patch, previous) {
    const current = { ...(view.overrides.get(id) ?? {}) };
    for (const key of Object.keys(patch)) {
      if (key in previous) current[key] = previous[key];
      else delete current[key];
    }
    if (Object.keys(current).length) view.overrides.set(id, current);
    else view.overrides.delete(id);
  }

  async function loadCapabilities(id) {
    try {
      const capabilities = await api.get(`/api/sessions/${encodeURIComponent(id)}/capabilities`);
      store.set({ capabilities: { ...store.get().capabilities, [id]: capabilities } });
    } catch {
      // The cached model list stays in place; the next session switch or live transition retries.
    }
  }

  async function refreshContext(id) {
    try {
      const usage = await api.get(`/api/sessions/${encodeURIComponent(id)}/context`);
      if (view.disposed || view.id !== id) return;
      view.ctx = toContextView(id, usage);
    } catch {
      if (view.id === id) view.ctx = null;
    }
    sync();
  }

  function onStoreChange() {
    if (view.disposed) return;
    const id = view.id;
    if (id) {
      const live = store.get().live?.[id] ?? null;
      const now = live ? live.state : null;
      const before = view.liveState;
      if (now !== before) {
        view.liveState = now;
        if (!now) {
          view.ctx = null;
        } else if (!before) {
          view.overrides.delete(id);
          loadCapabilities(id);
          refreshContext(id);
        } else if (now === 'idle') {
          refreshContext(id);
        }
      }
    }
    sync();
  }

  /**
   * @param {string} labelKey
   * @param {string} iconName
   * @param {() => void} onSelect
   * @param {{disabled?: boolean, label?: string}} [extra]
   */
  function menuItem(labelKey, iconName, onSelect, extra = {}) {
    return { label: extra.label ?? t(labelKey), icon: iconName, disabled: Boolean(extra.disabled), onClick: onSelect };
  }

  /**
   * Small picker used for model, mode and effort on phones, where the header shows no selects.
   * @param {string} titleKey
   * @param {Array<{value: string, label: string, title?: string}>} options
   * @param {string} selected
   * @param {(value: string) => void} onChoose
   */
  function openChoice(titleKey, options, selected, onChoose) {
    /** @type {{close: () => void}|null} */
    let dialog = null;
    const list = h('div', { class: 'choice-list', attrs: { role: 'radiogroup', 'aria-label': t(titleKey) } },
      options.map((option) => h('button', {
        class: 'choice-item',
        attrs: { type: 'button', role: 'radio', 'aria-checked': option.value === selected ? 'true' : 'false' },
        on: {
          click: () => {
            dialog?.close();
            onChoose(option.value);
          },
        },
      },
      h('span', { class: 'choice-label', text: option.label }),
      option.title ? h('span', { class: 'choice-hint', text: option.title }) : null,
      option.value === selected ? icon('check') : null)));
    dialog = openDialog({
      title: t(titleKey),
      body: list,
      actions: [{ label: t('common.cancel'), kind: 'secondary' }],
    });
  }

  function openOverflow() {
    const s = store.get();
    const meta = s.meta ?? {};
    const profile = s.auth?.profile ?? meta.profile ?? 'full';
    const readOnly = profile === 'read';
    const id = view.id;
    const live = id ? (s.live?.[id] ?? null) : null;
    const locked = Boolean(id && (live?.lockedBy === 'terminal' || s.terminal?.[id]?.attached));
    const editable = Boolean(id) && !readOnly && !locked;
    const mobile = globalThis.matchMedia?.(MOBILE_QUERY)?.matches === true;
    /** @type {Array<any>} */
    const items = [];

    if (id) {
      items.push(menuItem('header.sessionInfo', 'info', () => actions.openPanel('session')));
      items.push(menuItem('header.capabilities', 'plug', () => actions.openPanel('capabilities')));
      items.push(menuItem('header.tasks', 'layers', () => actions.openPanel('tasks')));
      if (mobile) {
        const pick = (key, iconName, options, selected, onChoose) => items.push(menuItem(key, iconName, () => {
          openChoice(key, options, selected, onChoose);
        }, {
          disabled: !editable,
          label: `${t(key)}: ${options.find((o) => o.value === selected)?.label ?? selected}`,
        }));
        pick('header.model', 'cpu', view.options.model, view.selected.model,
          (value) => commitChange({ model: value || null }));
        pick('header.permissionMode', 'shield', view.options.mode, view.selected.mode,
          (value) => commitChange({ permissionMode: value }));
        if (view.options.effort.length > 0) {
          const effortChoices = [{ value: '', label: t('header.effortDefault') }, ...view.options.effort];
          pick('header.effortLabel', 'gauge', effortChoices, view.selected.effort,
            (value) => commitChange({ effort: value || null }));
        }
      }
      items.push('separator');
      items.push(menuItem('header.rewind', 'rewind', () => actions.openRewind(), { disabled: !editable }));
      items.push(menuItem('header.fork', 'fork', () => actions.openFork(), { disabled: !editable }));
      if (meta.features?.terminal && profile === 'full') {
        items.push(menuItem('header.terminal', 'terminal', () => actions.openTerminal(), { disabled: locked }));
      }
    }
    if (items.length > 0) items.push('separator');
    items.push(menuItem('header.settings', 'settings', () => actions.openPanel('settings')));
    openMenu(moreBtn, items, { label: t('header.more') });
  }

  sync();

  return {
    setSession(sessionId) {
      const next = typeof sessionId === 'string' && sessionId ? sessionId : null;
      const s = store.get();
      if (next !== view.id) {
        view.id = next;
        view.ctx = null;
        view.liveState = next ? (s.live?.[next]?.state ?? null) : null;
      }
      if (next) {
        loadCapabilities(next);
        if (view.liveState) refreshContext(next);
      }
      sync();
    },
    destroy() {
      view.disposed = true;
      unsubscribe();
      resizeObserver?.disconnect();
      root.remove();
    },
  };
}
