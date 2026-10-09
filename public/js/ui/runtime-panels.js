/**
 * Runtime panel: the read-only views of the live runtime (the data behind the terminal's /status, /permissions, /hooks,
 * /memory, /usage, /skills, /sandbox, /config and Claude in Chrome), shown as tabs. Values from the runtime are text,
 * never HTML. The helpers at the top are pure and run in Node (unit tests); the panel below them is DOM code.
 */

import { h, clear, icon } from '../dom.js';
import { errorText } from '../api.js';
import { getLocale } from '../i18n.js';

/** @typedef {'read'|'standard'|'full'} Profile */

const PROFILE_RANK = /** @type {Record<string, number>} */ ({ read: 0, standard: 1, full: 2 });

/** The access profile each runtime view needs (docs/PROTOCOL.md, runtime views table). */
export const RUNTIME_VIEW_PROFILE = /** @type {Record<string, Profile>} */ (Object.freeze({
  status: 'standard',
  permissions: 'read',
  hooks: 'standard',
  settings: 'full',
  skills: 'read',
  sandbox: 'read',
  plan: 'read',
  usage: 'read',
  account: 'read',
  init: 'standard',
  mcp: 'read',
  chrome: 'read',
}));

/** @param {unknown} profile @returns {number} 0 read, 1 standard, 2 full; unknown profiles count as read */
export function profileRank(profile) {
  return PROFILE_RANK[String(profile)] ?? 0;
}

/** Tabs of the runtime panel, in display order. */
export const RUNTIME_TABS = Object.freeze([
  'status', 'permissions', 'hooks', 'memory', 'usage', 'skills', 'sandbox', 'settings', 'chrome',
]);

/** The runtime view behind each tab (memory reads GET /memory instead). */
const TAB_VIEW = /** @type {Record<string, string | null>} */ ({
  status: 'status',
  permissions: 'permissions',
  hooks: 'hooks',
  memory: null,
  usage: 'usage',
  skills: 'skills',
  sandbox: 'sandbox',
  settings: 'settings',
  chrome: 'chrome',
});

const TAB_PROFILE = /** @type {Record<string, Profile>} */ ({
  status: 'standard',
  permissions: 'read',
  hooks: 'standard',
  memory: 'read',
  usage: 'read',
  skills: 'read',
  sandbox: 'read',
  settings: 'full',
  chrome: 'read',
});

/**
 * The tabs this viewer can open: the view must be offered by the installed runtime, the profile must allow it, and
 * Claude in Chrome needs the gateway flag.
 * @param {{views?: string[], profile?: string, chrome?: boolean}} input
 * @returns {string[]}
 */
export function runtimeTabs({ views = [], profile = 'read', chrome = false } = {}) {
  return RUNTIME_TABS.filter((tab) => {
    const view = TAB_VIEW[tab];
    if (view !== null && !views.includes(view)) return false;
    if (profileRank(profile) < profileRank(TAB_PROFILE[tab])) return false;
    if (tab === 'chrome') return chrome === true;
    return true;
  });
}

/** Permission modes in Shift+Tab order. `bypassPermissions` joins the cycle only when the gateway allows it. */
export const PERMISSION_CYCLE = Object.freeze(['default', 'acceptEdits', 'plan', 'auto']);

/**
 * The next permission mode for Shift+Tab (the terminal's order). From a mode outside the cycle (dontAsk, unknown,
 * null) the next mode is acceptEdits.
 * @param {string | null | undefined} current
 * @param {{bypass?: boolean}} [options] bypass: the gateway allows bypassPermissions
 * @returns {string}
 */
export function nextPermissionMode(current, { bypass = false } = {}) {
  const cycle = bypass ? [...PERMISSION_CYCLE, 'bypassPermissions'] : [...PERMISSION_CYCLE];
  const index = cycle.indexOf(/** @type {string} */ (current));
  if (index < 0) return 'acceptEdits';
  return cycle[(index + 1) % cycle.length];
}

/** @param {unknown} value @returns {string} */
function text(value) {
  return typeof value === 'string' ? value : '';
}

/** @param {unknown} value @returns {number} */
function count(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/** @param {unknown} value @returns {string[]} */
function strings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

/**
 * Pretty JSON for display and copying. Never throws: values JSON cannot represent are shown as their string form.
 * @param {unknown} value
 * @returns {string}
 */
export function prettyJson(value) {
  try {
    const json = JSON.stringify(value ?? null, null, 2);
    return json === undefined ? 'null' : json;
  } catch {
    return String(value);
  }
}

/**
 * Utilization in percent, clamped to 0..100, or null when the runtime did not report one.
 * @param {unknown} value
 * @returns {number | null}
 */
export function percentOf(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : null;
}

const WINDOW_KEYS = /** @type {Array<[string, string]>} */ ([
  ['five_hour', 'shell.runtime.usage.window.five_hour'],
  ['seven_day', 'shell.runtime.usage.window.seven_day'],
  ['seven_day_sonnet', 'shell.runtime.usage.window.seven_day_sonnet'],
  ['seven_day_opus', 'shell.runtime.usage.window.seven_day_opus'],
  ['seven_day_oauth_apps', 'shell.runtime.usage.window.seven_day_oauth_apps'],
]);

/**
 * The plan windows of a usage answer, in a fixed order, then the per-model windows. Each row carries either a
 * translation key (`labelKey`) or a name that came from the runtime (`label`, shown as text).
 * @param {unknown} rateLimits `rate_limits` of the usage view
 * @returns {Array<{key: string, labelKey: string | null, label: string, utilization: number | null, resetsAt: string | null}>}
 */
export function usageWindows(rateLimits) {
  if (!rateLimits || typeof rateLimits !== 'object') return [];
  const source = /** @type {Record<string, any>} */ (rateLimits);
  const rows = [];
  for (const [key, labelKey] of WINDOW_KEYS) {
    const entry = source[key];
    if (entry && typeof entry === 'object') rows.push(windowRow(key, entry, labelKey, ''));
  }
  if (Array.isArray(source.model_scoped)) {
    for (const entry of source.model_scoped) {
      if (!entry || typeof entry !== 'object') continue;
      const name = text(entry.display_name);
      rows.push(windowRow(`model:${name}`, entry, null, name));
    }
  }
  return rows;
}

/**
 * @param {string} key
 * @param {Record<string, any>} entry
 * @param {string | null} labelKey
 * @param {string} label
 */
function windowRow(key, entry, labelKey, label) {
  return {
    key,
    labelKey,
    label,
    utilization: percentOf(entry.utilization),
    resetsAt: typeof entry.resets_at === 'string' ? entry.resets_at : null,
  };
}

/**
 * Dollar amount for display. Amounts below one cent show as "<$0.01"; missing numbers show a dash.
 * @param {unknown} value
 * @param {string} [locale]
 * @returns {string}
 */
export function formatUsd(value, locale = 'en') {
  if (value === null || value === undefined || value === '') return '—';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  const formatter = new Intl.NumberFormat(locale === 'zh-CN' ? 'zh-CN' : 'en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (amount > 0 && amount < 0.01) return `<${formatter.format(0.01)}`;
  return formatter.format(amount);
}

/**
 * Duration for display, with localized unit words.
 * @param {unknown} value milliseconds
 * @param {{ms?: string, s?: string, min?: string, h?: string}} [units]
 * @returns {string}
 */
export function formatDurationMs(value, units = {}) {
  const ms = Number(value);
  if (value === null || value === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  const unit = { ms: 'ms', s: 's', min: 'min', h: 'h', ...units };
  if (ms < 1000) return `${Math.round(ms)} ${unit.ms}`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} ${unit.s}`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} ${unit.min} ${Math.floor(seconds % 60)} ${unit.s}`;
  return `${Math.floor(minutes / 60)} ${unit.h} ${minutes % 60} ${unit.min}`;
}

/**
 * Local date and time of a reset, or '' when the runtime sent no valid time.
 * @param {unknown} iso
 * @param {string} [locale]
 * @returns {string}
 */
export function formatResetTime(iso, locale = 'en') {
  const time = Date.parse(typeof iso === 'string' ? iso : '');
  if (!Number.isFinite(time)) return '';
  const intlLocale = locale === 'zh-CN' ? 'zh-CN' : 'en';
  return new Intl.DateTimeFormat(intlLocale, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(time));
}

/**
 * Settings answer as text: the effective settings, and each source file's content.
 * @param {any} data `{effective, sources, applied}` of the settings view
 * @returns {{effective: string, sources: Array<{source: string, text: string}>}}
 */
export function settingsDocument(data) {
  const sources = Array.isArray(data?.sources) ? data.sources : [];
  return {
    effective: prettyJson(data?.effective ?? null),
    sources: sources.map((entry) => ({
      source: text(entry?.source),
      text: prettyJson(entry?.settings ?? null),
    })),
  };
}

/** Settings sources the panel translates; any other source shows its runtime name. */
const SOURCE_KEYS = /** @type {Record<string, string>} */ ({
  userSettings: 'user',
  projectSettings: 'project',
  localSettings: 'local',
  policySettings: 'policy',
  flagSettings: 'flag',
});

/** @param {string} source @returns {string | null} translation key suffix */
export function sourceKey(source) {
  return SOURCE_KEYS[source] ?? null;
}

const BEHAVIORS = ['allow', 'ask', 'deny'];

/**
 * Permission rules as table rows. The description is kept as prefix and emphasis, so the emphasised part can be bold.
 * @param {any} data the permissions view: `{state: {rules, workspaceDirectories, originalCwd, managedOnly}}`
 */
export function permissionRows(data) {
  const state = data && typeof data === 'object' ? (data.state ?? data) : {};
  const rules = Array.isArray(state.rules) ? state.rules : [];
  return {
    rows: rules.map((rule) => {
      const description = rule?.description;
      const prefix = typeof description === 'string' ? description : text(description?.prefix);
      return {
        behavior: BEHAVIORS.includes(rule?.behavior) ? rule.behavior : 'unknown',
        rule: text(rule?.rule),
        source: text(rule?.source),
        prefix,
        emphasis: typeof description === 'string' ? '' : text(description?.emphasis),
        editable: rule?.editability === 'persistent',
      };
    }),
    managedOnly: state.managedOnly === true,
    originalCwd: text(state.originalCwd),
    workspaceDirectories: strings(state.workspaceDirectories),
  };
}

/**
 * Hooks answer: the events with their hook counts, and every configured hook.
 * @param {any} data the hooks view: `{events, hooks, eventCatalog, policy}`
 */
export function hooksDocument(data) {
  const events = Array.isArray(data?.events) ? data.events : [];
  const hooks = Array.isArray(data?.hooks) ? data.hooks : [];
  return {
    events: events.map((event) => ({
      name: text(event?.name),
      summary: text(event?.summary),
      count: count(event?.hookCount),
    })),
    hooks: hooks.map((hook) => ({
      event: text(hook?.event),
      matcher: text(hook?.matcher),
      type: text(hook?.type),
      command: text(hook?.commandText) || text(hook?.displayText),
      source: text(hook?.sourceLabel) || text(hook?.source),
      disabled: hook?.disabled === true,
    })),
  };
}

/**
 * Status answer: titled sections of label and value rows.
 * @param {any} data
 */
export function statusSections(data) {
  const sections = Array.isArray(data?.sections) ? data.sections : [];
  return sections.map((section) => ({
    title: text(section?.title),
    rows: (Array.isArray(section?.rows) ? section.rows : []).map((row) => ({
      label: text(row?.label),
      value: row?.value === null || row?.value === undefined ? '' : String(row.value),
    })),
  }));
}

/**
 * Sandbox answer: support, mode, dependency problems and the restriction lists that have entries.
 * @param {any} data
 */
export function sandboxDocument(data) {
  const restrictions = data?.restrictions && typeof data.restrictions === 'object' ? data.restrictions : {};
  return {
    supported: data?.supported === true,
    enabled: data?.enabled === true,
    locked: data?.locked === true,
    mode: text(data?.mode),
    errors: strings(data?.dependencies?.errors),
    warnings: strings(data?.dependencies?.warnings),
    excluded: strings(data?.excluded_commands),
    restrictions: Object.entries(restrictions)
      .filter(([, values]) => Array.isArray(values) && values.length > 0)
      .map(([key, values]) => ({ key, values: strings(values) })),
  };
}

/**
 * Memory answer: the files with their content, and the automatic memory status texts.
 * @param {any} data `{files, folders, autoMemory, autoDream}` of GET /memory
 */
export function memoryDocument(data) {
  const files = Array.isArray(data?.files) ? data.files : [];
  return {
    files: files.map((file) => ({
      label: text(file?.label),
      path: text(file?.path),
      description: text(file?.description),
      exists: file?.exists === true,
      content: typeof file?.content === 'string' ? file.content : null,
      truncated: file?.truncated === true,
      editable: file?.editable === true,
    })),
    autoMemory: autoStatus(data?.autoMemory ?? data?.auto_memory),
    autoDream: autoStatus(data?.autoDream ?? data?.auto_dream),
  };
}

/** @param {unknown} value @returns {string} */
function autoStatus(value) {
  return value && typeof value === 'object' ? text(/** @type {any} */ (value).status) : '';
}

/**
 * Skills answer: name and description per skill.
 * @param {any} data `{skills}` of the skills view
 */
export function skillRows(data) {
  const skills = Array.isArray(data?.skills) ? data.skills : [];
  return skills.map((skill) => ({
    name: text(skill?.name) || text(skill?.display_name),
    description: text(skill?.description),
  }));
}

/**
 * Usage answer: session totals, lines changed, per-model cost, and the plan windows.
 * @param {any} data the usage view
 */
export function usageDocument(data) {
  const session = data?.session && typeof data.session === 'object' ? data.session : {};
  const models = session.model_usage && typeof session.model_usage === 'object' ? session.model_usage : {};
  return {
    costUsd: session.total_cost_usd,
    apiDurationMs: session.total_api_duration_ms,
    durationMs: session.total_duration_ms,
    linesAdded: count(session.total_lines_added),
    linesRemoved: count(session.total_lines_removed),
    models: Object.entries(models).map(([name, usage]) => ({
      name,
      costUsd: usage && typeof usage === 'object' ? /** @type {any} */ (usage).costUSD ?? null : null,
    })),
    ratesAvailable: data?.rate_limits_available === true,
    windows: usageWindows(data?.rate_limits),
  };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Panel                                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * @param {string} label
 * @param {unknown} value
 * @param {{mono?: boolean}} [options]
 */
function row(label, value, { mono = false } = {}) {
  const shown = value === null || value === undefined || value === '' ? '—' : String(value);
  return h('div', { class: 'kv-row' },
    h('span', { class: 'kv-label', text: label }),
    h('span', { class: ['kv-value', mono ? 'mono' : ''], attrs: { title: shown } }, shown));
}

/** @param {string} message */
function note(message) {
  return h('p', { class: 'sheet-note', text: message });
}

/** @param {string} title @param {...any} children */
function block(title, ...children) {
  return h('section', { class: 'sheet-section' }, h('h3', { class: 'sheet-section-title', text: title }), children);
}

/**
 * Mounts the runtime panel into `body`. Returns the teardown function.
 * @param {{ body: HTMLElement, api: any, store: any, t: (key: string, vars?: Record<string, unknown>) => string,
 *   actions: any, opts?: {tab?: string} }} ctx
 * @returns {() => void}
 */
export function mountRuntimePanel({ body, api, store, t, actions, opts = {} }) {
  let disposed = false;
  /** @type {Array<() => void>} */
  const disposers = [];
  const locale = () => getLocale();
  const sessionPath = () => `/api/sessions/${encodeURIComponent(store.get().currentSessionId ?? '')}`;
  const profile = () => store.get().meta?.profile ?? store.get().auth?.profile ?? 'read';
  const units = () => ({
    ms: t('shell.runtime.unit.ms'),
    s: t('shell.runtime.unit.s'),
    min: t('shell.runtime.unit.min'),
    h: t('shell.runtime.unit.h'),
  });

  /** @type {string[] | null} */
  let views = null;
  /** @type {any} */
  let viewsError = null;
  let loadingViews = false;
  let active = typeof opts.tab === 'string' ? opts.tab : 'status';
  /** @type {Record<string, {data: any, fetchedAt: number}>} */
  const cache = {};
  /** @type {Record<string, any>} */
  const failures = {};
  /** @type {Record<string, boolean>} */
  const loading = {};
  /** The memory file the user saved: the session must restart to read it. */
  let restartNeeded = false;

  const tabList = h('div', {
    class: 'runtime-tabs',
    attrs: { role: 'tablist', 'aria-label': t('shell.panel.runtime') },
    on: { keydown: (event) => onTabKey(event) },
  });
  const stage = h('div', { class: 'runtime-stage', attrs: { role: 'tabpanel' } });
  const updated = h('span', { class: 'runtime-updated' });
  const refreshButton = h('button', {
    class: 'btn btn-secondary btn-sm',
    attrs: { type: 'button' },
    on: { click: () => refresh() },
  }, icon('refresh'), h('span', { text: t('shell.runtime.refresh') }));
  const foot = h('div', { class: 'runtime-foot' }, refreshButton, updated);
  body.append(tabList, stage, foot);

  /** @param {KeyboardEvent} event */
  function onTabKey(event) {
    const tabs = availableTabs();
    const index = tabs.indexOf(active);
    if (index < 0) return;
    let next = -1;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    event.preventDefault();
    select(tabs[next]);
    tabList.querySelector(`[data-tab="${tabs[next]}"]`)?.focus();
  }

  function availableTabs() {
    if (views === null) return [];
    return runtimeTabs({
      views,
      profile: profile(),
      chrome: store.get().meta?.features?.chrome === true,
    });
  }

  function renderTabs() {
    const tabs = availableTabs();
    if (!tabs.includes(active) && tabs.length > 0) active = tabs[0];
    clear(tabList);
    for (const tab of tabs) {
      const selected = tab === active;
      tabList.append(h('button', {
        class: ['runtime-tab', selected ? 'is-active' : ''],
        attrs: {
          type: 'button',
          role: 'tab',
          'aria-selected': String(selected),
          tabindex: selected ? '0' : '-1',
          'data-tab': tab,
          id: `runtime-tab-${tab}`,
          'aria-controls': 'runtime-stage',
        },
        on: { click: () => select(tab) },
      }, t(`shell.runtime.tab.${tab}`)));
    }
    revealActiveTab();
    stage.id = 'runtime-stage';
    stage.setAttribute('aria-labelledby', `runtime-tab-${active}`);
  }

  /** Scrolls the tab strip sideways until the selected tab is fully visible: a phone shows only part of the row. */
  function revealActiveTab() {
    const tab = tabList.querySelector('[aria-selected="true"]');
    if (!(tab instanceof HTMLElement)) return;
    const strip = tabList.getBoundingClientRect();
    const box = tab.getBoundingClientRect();
    if (box.left < strip.left) tabList.scrollLeft -= strip.left - box.left;
    else if (box.right > strip.right) tabList.scrollLeft += box.right - strip.right;
  }

  /** @param {string} tab */
  function select(tab) {
    if (tab === active && cache[tab]) return;
    active = tab;
    renderTabs();
    loadTab(tab);
  }

  function refresh() {
    if (views === null) loadViews();
    else loadTab(active, { force: true });
  }

  async function loadViews() {
    if (loadingViews || disposed) return;
    loadingViews = true;
    viewsError = null;
    renderStage();
    try {
      const answer = await api.get(`${sessionPath()}/runtime`);
      if (disposed) return;
      views = Array.isArray(answer?.views) ? answer.views.filter((name) => typeof name === 'string') : [];
      loadingViews = false;
      renderTabs();
      if (availableTabs().length > 0) loadTab(active);
      else renderStage();
    } catch (err) {
      if (disposed) return;
      loadingViews = false;
      views = null;
      viewsError = err;
      renderTabs();
      renderStage();
    }
  }

  /**
   * Fetches one tab's data. The memory tab reads GET /memory; the others read their runtime view.
   * @param {string} tab
   * @param {{force?: boolean}} [options]
   */
  async function loadTab(tab, { force = false } = {}) {
    if (disposed || views === null) return;
    if (!force && cache[tab]) {
      renderStage();
      return;
    }
    if (loading[tab]) return;
    loading[tab] = true;
    delete failures[tab];
    renderStage();
    const path = tab === 'memory' ? `${sessionPath()}/memory` : `${sessionPath()}/runtime/${TAB_VIEW[tab]}`;
    try {
      const answer = await api.get(path);
      if (disposed) return;
      cache[tab] = tab === 'memory'
        ? { data: answer, fetchedAt: Date.now() }
        : { data: answer?.data ?? null, fetchedAt: Number(answer?.fetchedAt) || Date.now() };
    } catch (err) {
      if (disposed) return;
      failures[tab] = err;
    } finally {
      loading[tab] = false;
    }
    if (!disposed && tab === active) renderStage();
  }

  /** Opens the session (POST /open) after a 409, then reads the views again. */
  async function openSession() {
    try {
      await api.post(`${sessionPath()}/open`, {});
    } catch (err) {
      actions.toast(errorText(err, t), 'error');
      return;
    }
    if (disposed) return;
    for (const key of Object.keys(cache)) delete cache[key];
    for (const key of Object.keys(failures)) delete failures[key];
    loadViews();
  }

  /** @param {any} err */
  function failureBlock(err) {
    const retry = () => loadTab(active, { force: true });
    if (err?.code === 'SESSION_NOT_LIVE') {
      return h('div', { class: 'sheet-error runtime-error', attrs: { role: 'alert' } },
        h('p', { text: t('shell.runtime.notLive') }),
        h('button', {
          class: 'btn btn-primary btn-sm',
          attrs: { type: 'button' },
          on: { click: () => openSession() },
        }, icon('play'), h('span', { text: t('shell.runtime.open') })));
    }
    if (err?.code === 'FEATURE_UNAVAILABLE') {
      return h('div', { class: 'sheet-note runtime-unavailable' },
        h('p', { text: t('shell.runtime.unavailable') }),
        terminalOffered()
          ? h('button', {
            class: 'btn btn-secondary btn-sm',
            attrs: { type: 'button' },
            on: { click: () => actions.openTerminal() },
          }, icon('terminal'), h('span', { text: t('shell.runtime.terminal') }))
          : null);
    }
    return h('div', { class: 'sheet-error', attrs: { role: 'alert' } },
      h('p', { text: errorText(err, t) }),
      h('button', { class: 'btn btn-secondary btn-sm', attrs: { type: 'button' }, on: { click: retry } },
        icon('refresh'), h('span', { text: t('common.retry') })));
  }

  /** The terminal tab is a way out of a 501 only when this viewer may open it. */
  function terminalOffered() {
    const features = store.get().meta?.features ?? {};
    return features.terminal === true && profile() === 'full';
  }

  function renderStage() {
    if (disposed) return;
    clear(stage);
    updated.textContent = '';
    refreshButton.disabled = loadingViews || loading[active] === true;

    if (views === null) {
      if (loadingViews) {
        stage.append(skeleton());
        return;
      }
      stage.append(viewsError ? failureBlock(viewsError) : skeleton());
      return;
    }
    if (availableTabs().length === 0) {
      stage.append(note(t('shell.runtime.noTabs')));
      return;
    }
    if (failures[active]) {
      stage.append(failureBlock(failures[active]));
      return;
    }
    const entry = cache[active];
    if (!entry) {
      stage.append(skeleton());
      return;
    }
    updated.textContent = t('shell.runtime.updated', { time: clock(entry.fetchedAt) });
    stage.append(renderers[active](entry.data));
  }

  /** @param {number} timestamp */
  function clock(timestamp) {
    return new Intl.DateTimeFormat(locale() === 'zh-CN' ? 'zh-CN' : 'en-US', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(new Date(timestamp));
  }

  function skeleton() {
    return h('div', { class: 'skeleton-stack', attrs: { 'aria-hidden': 'true' } },
      [0, 1].map(() => h('div', { class: 'skeleton skeleton-block' })));
  }

  /** @type {Record<string, (data: any) => HTMLElement>} */
  const renderers = {
    status: (data) => {
      const sections = statusSections(data);
      if (sections.length === 0) return note(t('shell.runtime.status.none'));
      return h('div', { class: 'runtime-body' }, sections.map((section) => block(section.title,
        h('div', { class: 'kv-list' }, section.rows.map((item) => row(item.label, item.value))))));
    },
    permissions: (data) => {
      const doc = permissionRows(data);
      const head = h('thead', null, h('tr', null,
        h('th', { attrs: { scope: 'col' }, text: t('shell.runtime.col.behavior') }),
        h('th', { attrs: { scope: 'col' }, text: t('shell.runtime.col.rule') }),
        h('th', { attrs: { scope: 'col' }, text: t('shell.runtime.col.source') })));
      const bodyRows = doc.rows.map((item) => {
        const description = item.prefix || item.emphasis
          ? h('p', { class: 'table-desc' }, item.prefix, item.emphasis ? h('strong', { text: item.emphasis }) : null)
          : null;
        return h('tr', null,
          h('td', null, h('span', {
            class: ['chip', `chip-${behaviorTone(item.behavior)}`],
            text: t(`shell.runtime.behavior.${item.behavior}`),
          })),
          h('td', null, h('code', { class: 'mono table-rule', text: item.rule }), description),
          h('td', { class: 'table-source', text: sourceLabel(item.source) }));
      });
      const table = h('table', { class: 'table' }, head, h('tbody', null, bodyRows));
      return h('div', { class: 'runtime-body' },
        note(t('shell.runtime.permissions.note')),
        doc.managedOnly ? note(t('shell.runtime.permissions.managed')) : null,
        doc.rows.length === 0 ? note(t('shell.runtime.permissions.none')) : table);
    },
    hooks: (data) => {
      const doc = hooksDocument(data);
      return h('div', { class: 'runtime-body' },
        block(t('shell.runtime.hooks.events'),
          doc.events.length === 0
            ? note(t('shell.runtime.hooks.noEvents'))
            : h('ul', { class: 'item-list' }, doc.events.map((event) => h('li', {
              class: ['item', 'item-compact', event.count === 0 ? 'is-muted' : ''],
            },
            h('span', { class: 'item-name mono', text: event.name }),
            h('span', { class: 'item-hint', text: event.count > 0 ? t(event.count === 1 ? 'shell.runtime.hooks.count.one' : 'shell.runtime.hooks.count.other', { count: event.count }) : event.summary })))) ),
        block(t('shell.runtime.hooks.list'),
          doc.hooks.length === 0
            ? note(t('shell.runtime.hooks.none'))
            : h('ul', { class: 'item-list' }, doc.hooks.map((hook) => h('li', {
              class: ['item', hook.disabled ? 'is-muted' : ''],
            },
            h('div', { class: 'item-head' },
              h('span', { class: 'item-name mono', text: hook.event }),
              hook.disabled ? h('span', { class: 'chip chip-muted', text: t('shell.runtime.hooks.disabled') }) : null),
            hook.matcher ? h('div', { class: 'item-meta' }, h('span', { text: `${t('shell.runtime.hooks.matcher')}: ` }), h('span', { class: 'mono', text: hook.matcher })) : null,
            hook.command ? h('code', { class: 'mono hook-command', text: hook.command }) : null,
            h('div', { class: 'item-meta' },
              hook.type ? h('span', { text: hook.type }) : null,
              hook.source ? h('span', { text: hook.source }) : null))))));
    },
    memory: (data) => renderMemory(data),
    usage: (data) => renderUsage(data),
    skills: (data) => {
      const skills = skillRows(data);
      if (skills.length === 0) return note(t('shell.runtime.skills.none'));
      return h('ul', { class: 'item-list runtime-body' }, skills.map((skill) => h('li', { class: 'item item-compact' },
        h('span', { class: 'item-name mono', text: skill.name }),
        skill.description ? h('span', { class: 'item-desc', text: skill.description }) : null)));
    },
    sandbox: (data) => {
      const doc = sandboxDocument(data);
      return h('div', { class: 'runtime-body' },
        h('div', { class: 'kv-list' },
          row(t('shell.runtime.sandbox.supported'), yesNo(doc.supported)),
          row(t('shell.runtime.sandbox.enabled'), yesNo(doc.enabled)),
          row(t('shell.runtime.sandbox.locked'), yesNo(doc.locked)),
          row(t('shell.runtime.sandbox.mode'), doc.mode || '—', { mono: true })),
        doc.errors.length > 0 ? block(t('shell.runtime.sandbox.errors'), listOf(doc.errors)) : null,
        doc.warnings.length > 0 ? block(t('shell.runtime.sandbox.warnings'), listOf(doc.warnings)) : null,
        doc.excluded.length > 0 ? block(t('shell.runtime.sandbox.excluded'), listOf(doc.excluded)) : null,
        doc.restrictions.length > 0
          ? block(t('shell.runtime.sandbox.restrictions'), doc.restrictions.map((entry) => h('div', { class: 'sandbox-rule' },
            h('span', { class: 'kv-label', text: restrictionLabel(entry.key) }),
            listOf(entry.values))))
          : null);
    },
    settings: (data) => {
      const doc = settingsDocument(data);
      return h('div', { class: 'runtime-body' },
        block(t('shell.runtime.settings.effective'),
          h('pre', { class: 'devtools-json mono', attrs: { tabindex: '0' }, text: doc.effective })),
        doc.sources.length > 0
          ? block(t('shell.runtime.settings.sources'), doc.sources.map((entry) => h('div', { class: 'settings-source' },
            h('p', { class: 'field-label', text: sourceLabel(entry.source) }),
            h('pre', { class: 'devtools-json mono', attrs: { tabindex: '0' }, text: entry.text }))))
          : null);
    },
    chrome: (data) => h('div', { class: 'runtime-body' },
      note(t('shell.runtime.chrome.note')),
      h('pre', { class: 'devtools-json mono', attrs: { tabindex: '0' }, text: prettyJson(data) })),
  };

  /** @param {boolean} value */
  function yesNo(value) {
    return value ? t('common.yes') : t('common.no');
  }

  /** @param {string[]} items */
  function listOf(items) {
    return h('ul', { class: 'item-list' }, items.map((item) => h('li', { class: 'item item-compact mono', text: item })));
  }

  /** @param {string} key */
  function restrictionLabel(key) {
    const label = t(`shell.runtime.sandbox.r.${key}`);
    return label === `shell.runtime.sandbox.r.${key}` ? key : label;
  }

  /** @param {string} behavior */
  function behaviorTone(behavior) {
    if (behavior === 'allow') return 'success';
    if (behavior === 'deny') return 'danger';
    if (behavior === 'ask') return 'warning';
    return 'muted';
  }

  /** @param {string} source */
  function sourceLabel(source) {
    const key = sourceKey(source);
    if (key === null) return source;
    return t(`shell.runtime.settings.source.${key}`);
  }

  /** @param {any} data */
  function renderMemory(data) {
    const doc = memoryDocument(data);
    const save = async (file, content, panelButton) => {
      panelButton.disabled = true;
      try {
        await api.put(`${sessionPath()}/memory`, { path: file.path, content });
        // Keep the cached answer in step, so a re-render shows what was saved.
        const raw = Array.isArray(cache.memory?.data?.files)
          ? cache.memory.data.files.find((entry) => entry?.path === file.path)
          : null;
        if (raw) {
          raw.content = content;
          raw.exists = true;
        }
        restartNeeded = true;
        actions.toast(t('shell.runtime.memory.saved'), 'success');
        if (!disposed) renderStage();
      } catch (err) {
        actions.toast(errorText(err, t), 'error');
      } finally {
        panelButton.disabled = false;
      }
    };
    const children = [note(t('shell.runtime.memory.note'))];
    if (restartNeeded) {
      children.push(h('div', { class: 'runtime-restart sheet-inline' },
        h('p', { class: 'sheet-note', text: t('shell.runtime.memory.restartHint') }),
        h('button', {
          class: 'btn btn-primary btn-sm',
          attrs: { type: 'button' },
          on: { click: async () => {
            await actions.restartSession();
            restartNeeded = false;
            if (!disposed) renderStage();
          } },
        }, icon('refresh'), h('span', { text: t('shell.runtime.memory.restart') }))));
    }
    if (doc.files.length === 0) children.push(note(t('shell.runtime.memory.none')));
    for (const file of doc.files) {
      const status = file.exists
        ? h('span', { class: 'chip chip-accent', text: t('shell.runtime.memory.exists') })
        : h('span', { class: 'chip chip-muted', text: t('shell.runtime.memory.missing') });
      const head = h('div', { class: 'item-head' },
        h('span', { class: 'item-name', text: file.label || file.path }), status);
      const pathLine = h('p', { class: 'item-meta mono', text: file.path, attrs: { title: file.path } });
      const description = file.description ? h('p', { class: 'item-desc', text: file.description }) : null;
      if (file.editable) {
        const textarea = h('textarea', {
          class: 'textarea mono runtime-memory',
          attrs: { 'aria-label': `${file.label || file.path}`, spellcheck: false, rows: 10 },
        });
        textarea.value = file.content ?? '';
        const saveButton = h('button', {
          class: 'btn btn-primary btn-sm',
          attrs: { type: 'button' },
          on: { click: () => save(file, textarea.value, saveButton) },
        }, t('shell.runtime.memory.save'));
        const unreadable = file.exists && file.content === null;
        children.push(h('section', { class: 'memory-file' }, head, pathLine, description,
          unreadable ? note(t('shell.runtime.memory.unreadable')) : h('label', { class: 'field' }, textarea),
          unreadable ? null : h('div', { class: 'sheet-inline' }, saveButton),
          file.truncated ? note(t('shell.runtime.memory.truncated')) : null));
      } else {
        children.push(h('section', { class: 'memory-file' }, head, pathLine, description,
          file.content !== null
            ? h('pre', { class: 'devtools-json mono', attrs: { tabindex: '0' }, text: file.content })
            : note(file.exists ? t('shell.runtime.memory.unreadable') : t('shell.runtime.memory.missing')),
          file.truncated ? note(t('shell.runtime.memory.truncated')) : null));
      }
    }
    if (doc.autoMemory) children.push(note(doc.autoMemory));
    if (doc.autoDream) children.push(note(doc.autoDream));
    return h('div', { class: 'runtime-body' }, children);
  }

  /** @param {any} data */
  function renderUsage(data) {
    const doc = usageDocument(data);
    const number = new Intl.NumberFormat(locale() === 'zh-CN' ? 'zh-CN' : 'en-US');
    const plan = !doc.ratesAvailable
      ? note(t('shell.runtime.usage.noPlan'))
      : doc.windows.length === 0
        ? note(t('shell.runtime.usage.noWindows'))
        : h('ul', { class: 'bar-list' }, doc.windows.map((entry) => {
          const percent = entry.utilization;
          const resets = formatResetTime(entry.resetsAt, locale());
          return h('li', { class: 'bar-row' },
            h('div', { class: 'bar-head' },
              h('span', { text: entry.labelKey ? t(entry.labelKey) : entry.label }),
              h('span', { class: 'mono', text: percent === null ? '—' : t('shell.runtime.usage.used', { percent: Math.round(percent) }) })),
            h('div', {
              class: 'bar-track',
              attrs: { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': percent === null ? null : Math.round(percent) },
            }, h('div', { class: 'bar-fill', style: { width: `${percent ?? 0}%` } })),
            resets ? h('span', { class: 'item-hint', text: t('shell.runtime.usage.resets', { time: resets }) }) : null);
        }));
    return h('div', { class: 'runtime-body' },
      block(t('shell.runtime.usage.session'),
        h('div', { class: 'kv-list' },
          row(t('shell.runtime.usage.cost'), formatUsd(doc.costUsd, locale())),
          row(t('shell.runtime.usage.apiTime'), formatDurationMs(doc.apiDurationMs, units())),
          row(t('shell.runtime.usage.totalTime'), formatDurationMs(doc.durationMs, units())),
          row(t('shell.runtime.usage.lines'), `+${number.format(doc.linesAdded)} −${number.format(doc.linesRemoved)}`))),
      block(t('shell.runtime.usage.plan'), plan),
      doc.models.length > 0
        ? block(t('shell.runtime.usage.models'), h('div', { class: 'kv-list' },
          doc.models.map((model) => row(model.name, formatUsd(model.costUsd, locale()), { mono: true }))))
        : null);
  }

  renderTabs();
  renderStage();
  loadViews();

  const unsubscribe = store.subscribe((state, prev) => {
    if (state.currentSessionId !== prev.currentSessionId) {
      for (const key of Object.keys(cache)) delete cache[key];
      for (const key of Object.keys(failures)) delete failures[key];
      views = null;
      viewsError = null;
      restartNeeded = false;
      loadViews();
    }
  });
  disposers.push(unsubscribe);

  return () => {
    disposed = true;
    for (const dispose of disposers) dispose();
  };
}
