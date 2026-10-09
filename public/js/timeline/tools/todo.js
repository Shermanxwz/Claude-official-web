/**
 * Renderers for task tools: TodoWrite (checklist with progress) and TaskCreate, TaskUpdate, TaskGet, TaskList (compact
 * key/value rows).
 */

import { h } from '../../dom.js';
import { chip, errorBlock, keyValueList, mutedNote, prettyJson, statusOf, toolShell, cappedList, verbOf } from './shell.js';
import { firstLine, isRecord, resultText, str, truncate } from './summaries.js';

const MARKS = { pending: '○', in_progress: '◐', completed: '✓' };
const TASK_LIST_LIMIT = 50;

/**
 * @typedef {{ content: string, activeForm: string, status: 'pending' | 'in_progress' | 'completed' }} TodoItem
 */

/**
 * @param {import('./index.js').ToolCard} card
 * @param {import('./index.js').ToolContext} ctx
 * @returns {HTMLElement}
 */
export function render(card, ctx) {
  return card.name === 'TodoWrite' ? renderTodos(card, ctx) : renderTask(card, ctx);
}

/**
 * @param {import('./index.js').ToolCard} card
 * @param {import('./index.js').ToolContext} ctx
 * @returns {HTMLElement}
 */
function renderTodos(card, ctx) {
  const { t } = ctx;
  const input = recordOf(card.input);
  const structured = recordOf(card.structured);
  const todos = todoList(structured.newTodos) ?? todoList(input.todos) ?? [];
  const done = todos.filter((todo) => todo.status === 'completed').length;
  return toolShell({
    title: verbOf('TodoWrite', t),
    subtitle: todos.length > 0 ? `${done}/${todos.length}` : '',
    status: statusOf(card),
    body: () => todoBody(todos, done, t),
    open: Boolean(ctx.open),
    t,
    family: 'todo',
  });
}

/**
 * @param {TodoItem[]} todos
 * @param {number} done
 * @param {import('./index.js').Translate} t
 * @returns {HTMLElement}
 */
function todoBody(todos, done, t) {
  if (todos.length === 0) return mutedNote(t('tools.todo.empty'));
  const percent = Math.round((done / todos.length) * 100);
  return h('div', { class: 'tool-todos' }, [
    h(
      'div',
      {
        class: 'tool-progress',
        attrs: {
          role: 'progressbar',
          'aria-label': t('tools.todo.progress'),
          'aria-valuemin': '0',
          'aria-valuemax': String(todos.length),
          'aria-valuenow': String(done),
        },
      },
      [h('span', { class: 'tool-progress-bar', style: { width: `${percent}%` } })],
    ),
    h(
      'ul',
      { class: 'tool-todo-list' },
      todos.map((todo) => todoItem(todo, t)),
    ),
  ]);
}

/**
 * @param {TodoItem} todo
 * @param {import('./index.js').Translate} t
 * @returns {HTMLElement}
 */
function todoItem(todo, t) {
  const label = todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content;
  return h('li', { class: ['tool-todo', `is-${todo.status}`] }, [
    h('span', { class: 'tool-todo-mark', attrs: { 'aria-hidden': 'true' }, text: MARKS[todo.status] }),
    h('span', { class: 'tool-sr', text: t(`tools.todo.status.${todo.status}`) }),
    h('span', { class: 'tool-todo-text', text: label }),
  ]);
}

/**
 * @param {unknown} value
 * @returns {TodoItem[] | null}
 */
function todoList(value) {
  if (!Array.isArray(value)) return null;
  return value.filter(isRecord).map((item) => ({
    content: str(item.content),
    activeForm: str(item.activeForm),
    status: item.status === 'in_progress' || item.status === 'completed' ? item.status : 'pending',
  }));
}

/**
 * @param {import('./index.js').ToolCard} card
 * @param {import('./index.js').ToolContext} ctx
 * @returns {HTMLElement}
 */
function renderTask(card, ctx) {
  const { t } = ctx;
  const input = recordOf(card.input);
  const structured = recordOf(card.structured);
  return toolShell({
    title: verbOf(card.name, t),
    subtitle: taskSubtitle(card.name, input, structured, t),
    status: statusOf(card),
    body: () => taskBody(card, input, structured, t),
    open: Boolean(ctx.open),
    t,
    family: 'todo',
  });
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} input
 * @param {Record<string, unknown>} structured
 * @param {import('./index.js').Translate} t
 * @returns {string}
 */
function taskSubtitle(name, input, structured, t) {
  const taskId = str(input.taskId);
  if (name === 'TaskCreate') return truncate(firstLine(input.subject), 200);
  if (name === 'TaskUpdate') {
    const status = str(input.status);
    return taskId ? `#${taskId}${status ? ` → ${status}` : ''}` : '';
  }
  if (name === 'TaskGet') return taskId ? `#${taskId}` : '';
  if (name === 'TaskList' && Array.isArray(structured.tasks)) {
    return t('tools.todo.taskCount', { count: structured.tasks.length });
  }
  return '';
}

/**
 * @param {import('./index.js').ToolCard} card
 * @param {Record<string, unknown>} input
 * @param {Record<string, unknown>} structured
 * @param {import('./index.js').Translate} t
 * @returns {HTMLElement}
 */
function taskBody(card, input, structured, t) {
  const parts = [];
  const errorText = str(structured.error) || (card.result?.isError ? resultText(card.result) : '');
  if (errorText) parts.push(errorBlock(errorText, t));
  switch (card.name) {
    case 'TaskCreate':
      parts.push(keyValueList(createRows(input, structured, t)));
      break;
    case 'TaskUpdate':
      parts.push(keyValueList(updateRows(input, structured, t)));
      break;
    case 'TaskGet':
      parts.push(getBody(structured, t));
      break;
    case 'TaskList':
      parts.push(listBody(structured, t));
      break;
    default:
      if (Object.keys(input).length > 0) parts.push(keyValueList([['input', prettyJson(input)]]));
  }
  return h('div', { class: 'tool-tasks' }, parts);
}

/**
 * @param {Record<string, unknown>} input
 * @param {Record<string, unknown>} structured
 * @param {import('./index.js').Translate} t
 * @returns {Array<[string, string]>}
 */
function createRows(input, structured, t) {
  const task = recordOf(structured.task);
  return present([
    [t('tools.todo.field.id'), str(task.id)],
    [t('tools.todo.field.subject'), str(input.subject)],
    [t('tools.todo.field.description'), str(input.description)],
    [t('tools.todo.field.activeForm'), str(input.activeForm)],
    [t('tools.todo.field.metadata'), isRecord(input.metadata) ? prettyJson(input.metadata) : ''],
  ]);
}

/**
 * @param {Record<string, unknown>} input
 * @param {Record<string, unknown>} structured
 * @param {import('./index.js').Translate} t
 * @returns {Array<[string, string]>}
 */
function updateRows(input, structured, t) {
  const change = recordOf(structured.statusChange);
  const statusText = change.from != null || change.to != null ? `${str(change.from)} → ${str(change.to)}` : '';
  return present([
    [t('tools.todo.field.id'), str(input.taskId) || str(structured.taskId)],
    [t('tools.todo.field.status'), statusText || str(input.status)],
    [t('tools.todo.field.updatedFields'), listText(structured.updatedFields)],
    [t('tools.todo.field.subject'), str(input.subject)],
    [t('tools.todo.field.owner'), str(input.owner)],
    [t('tools.todo.field.addBlocks'), listText(input.addBlocks)],
    [t('tools.todo.field.addBlockedBy'), listText(input.addBlockedBy)],
  ]);
}

/**
 * @param {Record<string, unknown>} structured
 * @param {import('./index.js').Translate} t
 * @returns {HTMLElement}
 */
function getBody(structured, t) {
  const task = isRecord(structured.task) ? structured.task : null;
  if (!task) return mutedNote(t('tools.todo.notFound'));
  return keyValueList(
    present([
      [t('tools.todo.field.id'), str(task.id)],
      [t('tools.todo.field.subject'), str(task.subject)],
      [t('tools.todo.field.status'), str(task.status)],
      [t('tools.todo.field.description'), str(task.description)],
      [t('tools.todo.field.blocks'), listText(task.blocks)],
      [t('tools.todo.field.blockedBy'), listText(task.blockedBy)],
    ]),
  );
}

/**
 * @param {Record<string, unknown>} structured
 * @param {import('./index.js').Translate} t
 * @returns {HTMLElement}
 */
function listBody(structured, t) {
  const tasks = Array.isArray(structured.tasks) ? structured.tasks.filter(isRecord) : [];
  if (tasks.length === 0) return mutedNote(t('tools.todo.noTasks'));
  return cappedList({
    items: tasks,
    limit: TASK_LIST_LIMIT,
    renderItem: (task) =>
      h('div', { class: 'tool-task-row' }, [
        chip(`#${str(task.id)}`, { mono: true }),
        h('span', { class: 'tool-task-subject', text: str(task.subject) }),
        chip(str(task.status) || 'pending', { kind: task.status === 'completed' ? 'success' : 'neutral' }),
        str(task.owner) ? chip(str(task.owner)) : null,
        listText(task.blockedBy) ? chip(`${t('tools.todo.field.blockedBy')}: ${listText(task.blockedBy)}`) : null,
      ]),
    moreLabel: t('tools.todo.showMore', { count: tasks.length - TASK_LIST_LIMIT }),
    className: 'tool-task-list',
  });
}

/**
 * Keeps only rows with a value.
 * @param {Array<[string, string]>} rows
 * @returns {Array<[string, string]>}
 */
function present(rows) {
  return rows.filter(([, value]) => value !== '');
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function listText(value) {
  if (!Array.isArray(value)) return '';
  return value.filter((item) => typeof item === 'string' || typeof item === 'number').join(', ');
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function recordOf(value) {
  return isRecord(value) ? value : {};
}
