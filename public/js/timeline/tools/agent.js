/**
 * Renderer for subagent tools: Agent and Task. The prompt and the final answer are Markdown; the nested activity is the
 * timeline rendering of the subagent's messages (ctx.renderChildren), which opens while the agent is running.
 */

import { h } from '../../dom.js';
import { formatDuration, formatTokens } from '../format.js';
import {
  backgroundAction,
  chip,
  copyButton,
  errorBlock,
  linkAction,
  markdownBlock,
  mutedNote,
  section,
  statusOf,
  toolShell,
  verbOf,
} from './shell.js';
import { finiteNumber, firstLine, isRecord, resultText, str, summarizeTool, truncate } from './summaries.js';

const SUBTITLE_MAX = 240;
const ACTIVITY_MAX = 160;

/**
 * @param {import('./index.js').ToolCard} card
 * @param {import('./index.js').ToolContext} ctx
 * @returns {HTMLElement}
 */
export function render(card, ctx) {
  const { t } = ctx;
  const input = recordOf(card.input);
  const structured = recordOf(card.structured);
  const subagent = str(input.subagent_type);
  const finalText = resultText(structured) || resultText(card.result);
  const extras = subagent ? [chip(subagent, { kind: 'accent', mono: true })] : [];
  const actions = [];
  if (finalText && !card.result?.isError) {
    actions.push(copyButton({ text: finalText, t, label: t('tools.agent.copyResult') }));
  }
  const session = remoteSessionLink(structured, t);
  if (session) actions.push(session);
  const background = backgroundAction(card, ctx);
  if (background) actions.push(background);
  return toolShell({
    title: verbOf(card.name, t),
    subtitle: truncate(firstLine(input.description) || subagent, SUBTITLE_MAX),
    status: statusOf(card),
    body: () => agentBody(card, input, structured, finalText, ctx),
    open: Boolean(ctx.open),
    actions,
    extras,
    t,
    family: 'agent',
  });
}

/**
 * @param {import('./index.js').ToolCard} card
 * @param {Record<string, unknown>} input
 * @param {Record<string, unknown>} structured
 * @param {string} finalText
 * @param {import('./index.js').ToolContext} ctx
 * @returns {HTMLElement}
 */
function agentBody(card, input, structured, finalText, ctx) {
  const { t } = ctx;
  const parts = [];
  const meta = agentMeta(input, structured, t);
  if (meta.length > 0) parts.push(h('div', { class: 'tool-meta' }, meta));
  const prompt = str(input.prompt) || str(structured.prompt);
  if (prompt) {
    parts.push(section({ title: t('tools.agent.prompt'), body: () => markdownBlock(prompt, ctx.renderMarkdown) }));
  }
  const children = Array.isArray(card.children) ? card.children : [];
  if (children.length > 0 || card.running) {
    parts.push(
      section({
        title: t('tools.agent.activity'),
        count: children.length,
        subtitle: card.running ? latestActivity(children, ctx) : '',
        open: card.running,
        className: 'tool-activity',
        body: () => (children.length > 0 ? ctx.renderChildren(children) : mutedNote(t('tools.agent.noActivity'))),
      }),
    );
  }
  if (card.result?.isError) {
    parts.push(errorBlock(resultText(card.result), t));
  } else if (finalText) {
    parts.push(markdownBlock(finalText, ctx.renderMarkdown));
  } else if (structured.status === 'async_launched') {
    parts.push(mutedNote(t('tools.agent.asyncLaunched')));
  }
  return h('div', { class: 'tool-agent' }, parts);
}

/**
 * Totals reported by the subagent and how it was launched.
 * @param {Record<string, unknown>} input
 * @param {Record<string, unknown>} structured
 * @param {import('./index.js').Translate} t
 * @returns {HTMLElement[]}
 */
function agentMeta(input, structured, t) {
  const chips = [];
  const toolUses = finiteNumber(structured.totalToolUseCount);
  if (toolUses != null) chips.push(chip(t('tools.agent.toolUses', { count: toolUses })));
  const duration = finiteNumber(structured.totalDurationMs);
  if (duration != null) chips.push(chip(formatDuration(duration), { mono: true }));
  const tokens = finiteNumber(structured.totalTokens);
  if (tokens != null) chips.push(chip(t('tools.agent.tokens', { count: formatTokens(tokens) })));
  const model = str(structured.resolvedModel) || str(input.model);
  if (model) chips.push(chip(model, { mono: true }));
  if (input.run_in_background === true || structured.status === 'async_launched') {
    chips.push(chip(t('tools.agent.background'), { kind: 'accent' }));
  }
  if (str(input.isolation)) chips.push(chip(t('tools.agent.isolation', { mode: str(input.isolation) })));
  return chips;
}

/**
 * Link to the cloud session of a remotely launched agent, when it is an https URL.
 * @param {Record<string, unknown>} structured
 * @param {import('./index.js').Translate} t
 * @returns {HTMLElement | null}
 */
function remoteSessionLink(structured, t) {
  if (structured.status !== 'remote_launched') return null;
  try {
    const url = new URL(str(structured.sessionUrl));
    if (url.protocol !== 'https:') return null;
    return linkAction(url.href, t('tools.agent.openSession'));
  } catch {
    return null;
  }
}

/**
 * One-line description of the subagent's most recent step, for the header of the activity section.
 * @param {unknown[]} children
 * @param {import('./index.js').ToolContext} ctx
 * @returns {string}
 */
function latestActivity(children, ctx) {
  for (let index = children.length - 1; index >= 0; index--) {
    const label = entryLabel(children[index], ctx);
    if (label) return label;
  }
  return '';
}

/**
 * Label of a nested flow entry: the last tool call of a work group, the last text of an assistant message, or a tool
 * call itself. Other entry kinds have no activity line.
 * @param {unknown} entry
 * @param {import('./index.js').ToolContext} ctx
 * @returns {string}
 */
function entryLabel(entry, ctx) {
  if (!isRecord(entry)) return '';
  if (entry.kind === 'work' && Array.isArray(entry.items)) {
    return lastLabel(entry.items, (item) => toolLabel(item, ctx));
  }
  if (entry.kind === 'assistant' && Array.isArray(entry.blocks)) {
    return lastLabel(entry.blocks, (block) =>
      isRecord(block) && block.kind === 'text' && typeof block.text === 'string'
        ? truncate(firstLine(block.text), ACTIVITY_MAX)
        : '',
    );
  }
  return toolLabel(entry, ctx);
}

/**
 * @param {unknown[]} items
 * @param {(item: unknown) => string} labelOf
 * @returns {string}
 */
function lastLabel(items, labelOf) {
  for (let index = items.length - 1; index >= 0; index--) {
    const label = labelOf(items[index]);
    if (label) return label;
  }
  return '';
}

/**
 * @param {unknown} item
 * @param {import('./index.js').ToolContext} ctx
 * @returns {string}
 */
function toolLabel(item, ctx) {
  if (!isRecord(item) || item.kind !== 'tool' || typeof item.name !== 'string') return '';
  return truncate(summarizeTool(item.name, item.input, item.result, ctx.t, ctx.cwd), ACTIVITY_MAX);
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function recordOf(value) {
  return isRecord(value) ? value : {};
}
