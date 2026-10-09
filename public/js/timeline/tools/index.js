/**
 * Tool card dispatch: chooses the renderer family for a tool call. A family that throws on unexpected data falls
 * back to the generic card, so a tool call always renders.
 */

import { h } from '../../dom.js';
import { render as renderAgent } from './agent.js';
import { render as renderBash } from './bash.js';
import { render as renderFile } from './file.js';
import { render as renderGeneric } from './generic.js';
import { render as renderMcp } from './mcp.js';
import { render as renderPlan } from './plan.js';
import { render as renderSearch } from './search.js';
import { render as renderTodo } from './todo.js';
import { render as renderWeb } from './web.js';

/** @typedef {(key: string, vars?: Record<string, string | number>) => string} Translate */

/**
 * A tool call as the timeline holds it. `result` is the matching tool_result (text in `content`, images as base64 in
 * `images`); `structured` is the SDK `tool_use_result` payload when one is known.
 * @typedef {{
 *   id?: string,
 *   name: string,
 *   input?: unknown,
 *   result?: { content?: unknown, isError?: boolean, images?: Array<{ mediaType: string, data: string }> } | null,
 *   structured?: unknown,
 *   children?: unknown[],
 *   running: boolean,
 *   pendingRequestId?: string,
 * }} ToolCard
 */

/**
 * @typedef {{
 *   t: Translate,
 *   renderMarkdown: (text: string) => HTMLElement,
 *   sessionId: string | null,
 *   cwd: string | null,
 *   renderChildren: (entries: unknown[]) => HTMLElement,
 *   open: boolean,
 * }} ToolContext
 */

/** @type {Map<string, (card: ToolCard, ctx: ToolContext) => HTMLElement>} */
const FAMILIES = new Map([
  ['Bash', renderBash],
  ['BashOutput', renderBash],
  ['KillShell', renderBash],
  ['KillBash', renderBash],
  ['TaskStop', renderBash],
  ['Monitor', renderBash],
  ['Read', renderFile],
  ['Write', renderFile],
  ['Edit', renderFile],
  ['MultiEdit', renderFile],
  ['NotebookEdit', renderFile],
  ['Grep', renderSearch],
  ['Glob', renderSearch],
  ['LS', renderSearch],
  ['WebFetch', renderWeb],
  ['WebSearch', renderWeb],
  ['Agent', renderAgent],
  ['Task', renderAgent],
  ['TodoWrite', renderTodo],
  ['TaskCreate', renderTodo],
  ['TaskUpdate', renderTodo],
  ['TaskList', renderTodo],
  ['TaskGet', renderTodo],
  ['ExitPlanMode', renderPlan],
  ['EnterPlanMode', renderPlan],
]);

/**
 * Renders one tool card with the family for its name. MCP tools (`mcp__<server>__<tool>`) use the MCP family; unknown
 * names use the generic card.
 * @param {ToolCard} card
 * @param {ToolContext} ctx
 * @returns {HTMLElement}
 */
export function renderTool(card, ctx) {
  const name = typeof card?.name === 'string' ? card.name : '';
  const family = name.startsWith('mcp__') ? renderMcp : (FAMILIES.get(name) ?? renderGeneric);
  try {
    return family(card, ctx);
  } catch (error) {
    console.error('tool renderer failed; showing the generic card', name, error);
    return renderFallback(card, ctx);
  }
}

/**
 * Last resort when even the generic card fails: a bare card that names the tool.
 * @param {ToolCard} card
 * @param {ToolContext} ctx
 * @returns {HTMLElement}
 */
function renderFallback(card, ctx) {
  try {
    return renderGeneric(card, ctx);
  } catch (error) {
    console.error('generic tool card failed', error);
    return h('div', { class: 'tool-card tool-status-error', text: typeof card?.name === 'string' ? card.name : '' });
  }
}
