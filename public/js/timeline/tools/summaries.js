/**
 * Pure helpers shared by the tool renderers and the work-group headers. No DOM access; unit-tested in Node.
 *
 * `summarizeTool` returns a one-line label. English base strings are used when no translator is given. With a
 * translator `t(key, vars)`, the `tools.summary.*` keys are used, and a key the translator does not know falls back to
 * the English base string.
 */

import { countChanges, diffLines, hunksFromStructuredPatch, splitDiffLines } from '../diff.js';

/** @typedef {(key: string, vars?: Record<string, string | number>) => string} Translate */

const BASE = {
  bash: 'Ran {command}',
  bashOutput: 'Read background output',
  stopTask: 'Stopped background task',
  monitor: 'Monitor: {description}',
  read: 'Read {path}',
  write: 'Wrote {path} (+{added})',
  writePlain: 'Wrote {path}',
  edit: 'Edited {path} (+{added} −{removed})',
  editPlain: 'Edited {path}',
  notebook: 'Edited notebook {path}',
  grepMatches: 'Searched “{pattern}” — {count} matches',
  grepOneMatch: 'Searched “{pattern}” — 1 match',
  grepFiles: 'Searched “{pattern}” — {count} files',
  grepOneFile: 'Searched “{pattern}” — 1 file',
  grepPlain: 'Searched “{pattern}”',
  globFiles: 'Glob “{pattern}” — {count} files',
  globOneFile: 'Glob “{pattern}” — 1 file',
  globPlain: 'Glob “{pattern}”',
  ls: 'Listed {path}',
  fetch: 'Fetched {domain}',
  webSearch: 'Searched the web: {query}',
  agent: 'Agent: {description}',
  todos: 'Updated todos ({done}/{total})',
  todosPlain: 'Updated todos',
  taskCreate: 'Created task: {subject}',
  taskUpdate: 'Updated task {taskId}',
  taskGet: 'Read task {taskId}',
  taskList: 'Listed tasks',
  plan: 'Proposed a plan',
  enterPlan: 'Entered plan mode',
  mcp: '{server} · {tool}',
};

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function str(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
export function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Shorten text to `max` UTF-16 units, ending with an ellipsis when it is cut.
 * @param {unknown} text
 * @param {number} [max]
 * @returns {string}
 */
export function truncate(text, max = 80) {
  const value = str(text);
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

/**
 * First non-blank line, trimmed.
 * @param {unknown} text
 * @returns {string}
 */
export function firstLine(text) {
  return str(text).split(/\r?\n/).find((line) => line.trim() !== '')?.trim() ?? '';
}

/**
 * Path shown relative to the session working directory when it lies inside that directory.
 * @param {unknown} filePath
 * @param {unknown} [cwd]
 * @returns {string}
 */
export function displayPath(filePath, cwd) {
  const path = str(filePath);
  const root = str(cwd).replace(/[\\/]+$/, '');
  if (!path || !root) return path;
  if (path === root) return '.';
  for (const sep of ['/', '\\']) {
    if (path.startsWith(root + sep)) return path.slice(root.length + 1);
  }
  return path;
}

/**
 * Host name of a URL without a leading "www.", or the truncated input when it is not a URL.
 * @param {unknown} url
 * @returns {string}
 */
export function domainOf(url) {
  const raw = str(url).trim();
  try {
    const host = new URL(raw).hostname.replace(/^www\./, '');
    return host || truncate(raw, 60);
  } catch {
    return truncate(raw, 60);
  }
}

/**
 * Split an MCP tool name `mcp__<server>__<tool>`. A malformed name yields an empty server.
 * @param {unknown} name
 * @returns {{ server: string, tool: string }}
 */
export function parseMcpToolName(name) {
  const rest = str(name).replace(/^mcp__/, '');
  const cut = rest.indexOf('__');
  if (cut <= 0) return { server: '', tool: rest };
  return { server: rest.slice(0, cut), tool: rest.slice(cut + 2) };
}

/**
 * Text of a tool result: a plain string, or the joined text blocks of `{ content }` (a string or a block array).
 * Image and other non-text blocks are skipped.
 * @param {unknown} result
 * @returns {string}
 */
export function resultText(result) {
  if (typeof result === 'string') return result;
  if (!isRecord(result)) return '';
  const { content } = result;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter((text) => text !== '')
    .join('\n');
}

/**
 * Number of lines in a text, where a single trailing line break does not start a new line.
 * @param {string} text
 * @returns {number}
 */
function countLines(text) {
  return splitDiffLines(text).length;
}

/**
 * One-line label for a tool call, for work-group headers and card subtitles. Never throws: unexpected input yields a
 * label built from what is usable, or the tool name.
 * @param {unknown} name
 * @param {unknown} input
 * @param {unknown} [result] the card's `{ content, isError }` result, its `structured` payload, or a string
 * @param {Translate | null} [t]
 * @param {unknown} [cwd] session working directory, used to shorten paths
 * @returns {string}
 */
export function summarizeTool(name, input, result, t, cwd) {
  const tool = str(name);
  const args = isRecord(input) ? input : {};
  const data = isRecord(result) ? result : {};
  const tr = (/** @type {string} */ key, /** @type {Record<string, string | number>} */ vars) =>
    translate(t, key, vars);
  if (tool.startsWith('mcp__')) {
    const { server, tool: mcpTool } = parseMcpToolName(tool);
    return server ? tr('mcp', { server, tool: mcpTool || server }) : tool;
  }
  switch (tool) {
    case 'Bash': {
      const command = truncate(firstLine(args.command), 72);
      return command ? tr('bash', { command }) : tool;
    }
    case 'BashOutput':
      return tr('bashOutput', {});
    case 'KillShell':
    case 'KillBash':
    case 'TaskStop':
      return tr('stopTask', {});
    case 'Monitor': {
      const description = truncate(firstLine(args.description), 72);
      return description ? tr('monitor', { description }) : tool;
    }
    case 'Read':
      return displayPath(args.file_path, cwd) ? tr('read', { path: displayPath(args.file_path, cwd) }) : tool;
    case 'Write':
      return summarizeWrite(args, cwd, tr, tool);
    case 'Edit':
    case 'MultiEdit':
      return summarizeEdit(tool, args, data, cwd, tr);
    case 'NotebookEdit': {
      const path = displayPath(args.notebook_path, cwd);
      return path ? tr('notebook', { path }) : tool;
    }
    case 'Grep':
      return summarizeGrep(args, result, tr, tool);
    case 'Glob':
      return summarizeGlob(args, result, tr, tool);
    case 'LS':
      return tr('ls', { path: displayPath(args.path, cwd) || '.' });
    case 'WebFetch': {
      const domain = domainOf(args.url);
      return domain ? tr('fetch', { domain }) : tool;
    }
    case 'WebSearch': {
      const query = truncate(firstLine(args.query), 80);
      return query ? tr('webSearch', { query }) : tool;
    }
    case 'Agent':
    case 'Task': {
      const description = truncate(firstLine(args.description), 72) || str(args.subagent_type);
      return description ? tr('agent', { description }) : tool;
    }
    case 'TodoWrite':
      return summarizeTodos(args.todos, tr);
    case 'TaskCreate': {
      const subject = truncate(firstLine(args.subject), 72);
      return subject ? tr('taskCreate', { subject }) : tool;
    }
    case 'TaskUpdate': {
      const taskId = str(args.taskId);
      return taskId ? tr('taskUpdate', { taskId }) : tool;
    }
    case 'TaskGet': {
      const taskId = str(args.taskId);
      return taskId ? tr('taskGet', { taskId }) : tool;
    }
    case 'TaskList':
      return tr('taskList', {});
    case 'ExitPlanMode':
      return tr('plan', {});
    case 'EnterPlanMode':
      return tr('enterPlan', {});
    default:
      return tool;
  }
}

/**
 * Added and removed line counts of an Edit or MultiEdit: the structured patch when the result carries one, otherwise
 * the diff of the input strings. Null when neither is available.
 * @param {string} tool
 * @param {Record<string, unknown>} args
 * @param {Record<string, unknown>} data
 * @returns {{ added: number, removed: number } | null}
 */
function editCounts(tool, args, data) {
  const patch = hunksFromStructuredPatch(data.structuredPatch);
  if (patch.length > 0) return countChanges(patch);
  const pairs = tool === 'MultiEdit' && Array.isArray(args.edits) ? args.edits : [args];
  let added = 0;
  let removed = 0;
  let seen = false;
  for (const pair of pairs) {
    if (!isRecord(pair) || typeof pair.old_string !== 'string' || typeof pair.new_string !== 'string') continue;
    seen = true;
    const change = countChanges(diffLines(pair.old_string, pair.new_string));
    added += change.added;
    removed += change.removed;
  }
  return seen ? { added, removed } : null;
}

/**
 * @param {Record<string, unknown>} args
 * @param {unknown} cwd
 * @param {(key: string, vars?: Record<string, string | number>) => string} tr
 * @param {string} tool
 * @returns {string}
 */
function summarizeWrite(args, cwd, tr, tool) {
  const path = displayPath(args.file_path, cwd);
  if (!path) return tool;
  if (typeof args.content !== 'string') return tr('writePlain', { path });
  return tr('write', { path, added: countLines(args.content) });
}

/**
 * @param {string} tool
 * @param {Record<string, unknown>} args
 * @param {Record<string, unknown>} data
 * @param {unknown} cwd
 * @param {(key: string, vars?: Record<string, string | number>) => string} tr
 * @returns {string}
 */
function summarizeEdit(tool, args, data, cwd, tr) {
  const path = displayPath(args.file_path, cwd);
  if (!path) return tool;
  const counts = editCounts(tool, args, data);
  return counts == null
    ? tr('editPlain', { path })
    : tr('edit', { path, added: counts.added, removed: counts.removed });
}

/**
 * Output mode and match count of a Grep call. Counts come from the structured payload when present, otherwise from the
 * result text. `count` is null until a result exists.
 * @param {unknown} input
 * @param {unknown} result the card's `{ content, isError }` result, or a string
 * @param {unknown} [structured] the SDK `tool_use_result` payload
 * @returns {{ mode: 'content' | 'count' | 'files_with_matches', count: number | null }}
 */
export function grepStats(input, result, structured) {
  const args = isRecord(input) ? input : {};
  const data = isRecord(structured) ? structured : isRecord(result) ? result : {};
  const mode = args.output_mode === 'content' || args.output_mode === 'count' ? args.output_mode : 'files_with_matches';
  if (result == null) return { mode, count: null };
  const text = resultText(result);
  if (mode === 'files_with_matches') {
    return { mode, count: finiteNumber(data.numFiles) ?? countNonEmptyLines(text) };
  }
  if (mode === 'count') return { mode, count: finiteNumber(data.numMatches) ?? sumCountColumns(text) };
  return { mode, count: finiteNumber(data.numLines) ?? countNonEmptyLines(text) };
}

/**
 * Number of files a Glob call matched, or null until a result exists.
 * @param {unknown} result
 * @param {unknown} [structured]
 * @returns {number | null}
 */
export function globCount(result, structured) {
  if (result == null) return null;
  const data = isRecord(structured) ? structured : isRecord(result) ? result : {};
  return finiteNumber(data.numFiles) ?? (Array.isArray(data.filenames) ? data.filenames.length : null);
}

/**
 * @param {Record<string, unknown>} args
 * @param {unknown} result
 * @param {(key: string, vars?: Record<string, string | number>) => string} tr
 * @param {string} tool
 * @returns {string}
 */
function summarizeGrep(args, result, tr, tool) {
  const pattern = truncate(firstLine(args.pattern), 60);
  if (!pattern) return tool;
  const { mode, count } = grepStats(args, result);
  if (count == null) return tr('grepPlain', { pattern });
  if (mode === 'files_with_matches') {
    return count === 1 ? tr('grepOneFile', { pattern }) : tr('grepFiles', { pattern, count });
  }
  return count === 1 ? tr('grepOneMatch', { pattern }) : tr('grepMatches', { pattern, count });
}

/**
 * @param {Record<string, unknown>} args
 * @param {unknown} result
 * @param {(key: string, vars?: Record<string, string | number>) => string} tr
 * @param {string} tool
 * @returns {string}
 */
function summarizeGlob(args, result, tr, tool) {
  const pattern = truncate(firstLine(args.pattern), 60);
  if (!pattern) return tool;
  const count = globCount(result);
  if (count == null) return tr('globPlain', { pattern });
  return count === 1 ? tr('globOneFile', { pattern }) : tr('globFiles', { pattern, count });
}

/**
 * @param {unknown} todos
 * @param {(key: string, vars?: Record<string, string | number>) => string} tr
 * @returns {string}
 */
function summarizeTodos(todos, tr) {
  if (!Array.isArray(todos)) return tr('todosPlain', {});
  const done = todos.filter((todo) => isRecord(todo) && todo.status === 'completed').length;
  return tr('todos', { done, total: todos.length });
}

/**
 * @param {string} text
 * @returns {number}
 */
function countNonEmptyLines(text) {
  return text.split(/\r?\n/).filter((line) => line.trim() !== '').length;
}

/**
 * Sum of the trailing counts printed by Grep's count mode (`path:N`).
 * @param {string} text
 * @returns {number}
 */
function sumCountColumns(text) {
  let total = 0;
  for (const line of text.split(/\r?\n/)) {
    const match = /:(\d+)\s*$/.exec(line);
    if (match) total += Number(match[1]);
  }
  return total;
}

/**
 * @param {Translate | null | undefined} t
 * @param {string} key
 * @param {Record<string, string | number>} [vars]
 * @returns {string}
 */
function translate(t, key, vars = {}) {
  const fallback = Object.prototype.hasOwnProperty.call(BASE, key) ? BASE[/** @type {keyof typeof BASE} */ (key)] : key;
  if (typeof t === 'function') {
    const localized = t(`tools.summary.${key}`, vars);
    if (typeof localized === 'string' && localized !== `tools.summary.${key}`) return localized;
  }
  return fill(fallback, vars);
}

/**
 * @param {string} template
 * @param {Record<string, string | number>} [vars]
 * @returns {string}
 */
function fill(template, vars = {}) {
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}
