/**
 * The composer's running line and pinned todo bar (docs/FRONTEND.md, conversation owner). Both sit in the composer's
 * column above the field and in its flow, so they never cover a request card in the conversation. The elapsed time
 * ticks once a second while a turn runs; reduced motion stops the arc glyph (CSS).
 */
import { h, clear, icon } from '../dom.js';
import { formatTokens } from '../timeline/format.js';

const TICK_MS = 1000;
const SECOND_MS = 1000;
const MINUTE_S = 60;
const HOUR_S = 3600;

/**
 * @typedef {(key: string, vars?: Record<string, string | number>) => string} Translate
 * @typedef {{content: string, activeForm: string, status: 'pending'|'in_progress'|'completed'}} Todo
 * @typedef {{
 *   running: boolean, startedAt: number, text: string|null, outputTokens: number, queued: number, waiting: boolean
 * }} Activity
 */

/**
 * Elapsed time as the running line shows it: "12s" up to a minute, "1m 05s" up to an hour, then "1h 02m".
 * @param {number} ms
 * @returns {string}
 */
export function formatElapsed(ms) {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / SECOND_MS) : 0;
  if (total < MINUTE_S) return `${total}s`;
  if (total < HOUR_S) return `${Math.floor(total / MINUTE_S)}m ${pad(total % MINUTE_S)}s`;
  return `${Math.floor(total / HOUR_S)}h ${pad(Math.floor((total % HOUR_S) / MINUTE_S))}m`;
}

/** @param {number} value */
function pad(value) {
  return String(value).padStart(2, '0');
}

/**
 * What the todo bar counts: done and total items, the activeForm of the item in progress and whether all are done.
 * @param {Todo[] | null | undefined} todos
 * @returns {{total: number, done: number, active: string|null, allDone: boolean}}
 */
export function todoSummary(todos) {
  const list = Array.isArray(todos) ? todos : [];
  const done = list.filter((todo) => todo.status === 'completed').length;
  const current = list.find((todo) => todo.status === 'in_progress') ?? null;
  return {
    total: list.length,
    done,
    active: current ? (current.activeForm || current.content) : null,
    allDone: list.length > 0 && done === list.length,
  };
}

/**
 * The running line: an arc glyph, the running tool or the runtime's activity (or "Working"), the elapsed time, the
 * output tokens, and "Esc to stop" on a pointer device.
 * @param {{ t: Translate, coarse: boolean }} options
 */
export function createRunningLine({ t, coarse }) {
  const textEl = h('span', { class: 'activity-text' });
  const timeEl = h('span', { class: 'activity-time' });
  const tokensEl = h('span', { class: 'activity-tokens' });
  const element = h('div', {
    class: 'composer-activity',
    attrs: { role: 'group', 'aria-label': t('composer.activity.label'), hidden: true },
  },
  h('span', { class: 'activity-glyph', attrs: { 'aria-hidden': 'true' } }, h('span', { class: 'activity-arc' })),
  textEl,
  timeEl,
  tokensEl,
  coarse ? null : h('span', { class: 'activity-hint', text: t('composer.activity.escToStop') }));
  /** @type {Activity|null} */
  let current = null;
  /** @type {ReturnType<typeof setInterval>|null} */
  let timer = null;

  const paint = () => {
    if (!current) return;
    // A request that waits for the user replaces the runtime's activity: the glyph becomes the waiting dot (DESIGN).
    const waiting = current.waiting === true;
    element.classList.toggle('is-waiting', waiting);
    let text = current.text && current.text.trim() ? current.text.trim() : t('composer.activity.working');
    if (waiting) text = t('composer.activity.waiting');
    textEl.textContent = text;
    textEl.title = text;
    timeEl.textContent = current.startedAt > 0 ? formatElapsed(Date.now() - current.startedAt) : '';
    tokensEl.textContent = current.outputTokens > 0
      ? t('composer.activity.tokens', { count: formatTokens(current.outputTokens) })
      : '';
  };
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  return {
    element,
    /** @param {Activity|null} activity */
    update(activity) {
      current = activity && activity.running ? activity : null;
      element.hidden = !current;
      if (!current) {
        stop();
        return;
      }
      paint();
      if (!timer) timer = setInterval(paint, TICK_MS);
    },
    destroy() {
      stop();
      current = null;
    },
  };
}

/**
 * The pinned todo bar: "{done}/{total}" and the activeForm of the item in progress. A click expands the checklist with
 * a status mark per item. Shown while the list has items and is not all done, or while a turn runs.
 * @param {{ t: Translate }} options
 */
export function createTodoBar({ t }) {
  let expanded = false;
  const countEl = h('span', { class: 'todo-count' });
  const activeEl = h('span', { class: 'todo-active' });
  const listEl = h('ol', { class: 'todo-list', attrs: { hidden: true } });
  const toggle = h('button', {
    class: 'todo-toggle',
    attrs: { type: 'button', 'aria-expanded': 'false', 'aria-label': t('composer.todo.toggle') },
    on: { click: () => setExpanded(!expanded) },
  }, icon('list'), countEl, activeEl, icon('chevron-down'));
  const element = h('div', { class: 'composer-todos', attrs: { hidden: true } }, toggle, listEl);

  /** @param {boolean} next */
  function setExpanded(next) {
    expanded = next;
    toggle.setAttribute('aria-expanded', next ? 'true' : 'false');
    listEl.hidden = !next;
  }

  return {
    element,
    /**
     * @param {Todo[] | null} todos
     * @param {boolean} running
     */
    update(todos, running) {
      const summary = todoSummary(todos);
      const visible = summary.total > 0 && (!summary.allDone || running);
      element.hidden = !visible;
      if (!visible) return;
      countEl.textContent = `${summary.done}/${summary.total}`;
      activeEl.textContent = summary.active ?? '';
      clear(listEl);
      for (const todo of todos ?? []) {
        const label = todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content;
        const status = t(`composer.todo.status.${todo.status}`);
        listEl.append(h('li', { class: ['todo-item', `is-${todo.status}`], attrs: { title: status } },
          todo.status === 'completed'
            ? icon('check')
            : h('span', { class: 'todo-mark', attrs: { 'aria-hidden': 'true' } }),
          h('span', { class: 'todo-label', text: label }),
          h('span', { class: 'visually-hidden', text: status })));
      }
    },
  };
}
