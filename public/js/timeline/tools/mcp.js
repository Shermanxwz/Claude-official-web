/**
 * Renderer for MCP tools, named `mcp__<server>__<tool>`. The input is a key/value table (nested values as pretty JSON);
 * the result shows its text blocks, JSON, and inline images (data: URLs).
 */

import { h } from '../../dom.js';
import {
  chip,
  codeBlock,
  copyButton,
  errorBlock,
  imageButton,
  keyValueList,
  mutedNote,
  prettyJson,
  resultImages,
  statusOf,
  toolShell,
} from './shell.js';
import { imageFromBlock } from './images.js';
import { isRecord, parseMcpToolName, resultText, truncate } from './summaries.js';

const SUBTITLE_MAX = 240;

/**
 * @param {import('./index.js').ToolCard} card
 * @param {import('./index.js').ToolContext} ctx
 * @returns {HTMLElement}
 */
export function render(card, ctx) {
  const { t } = ctx;
  const input = recordOf(card.input);
  const { server, tool } = parseMcpToolName(card.name);
  const text = resultText(card.result);
  const copyable = text || (card.result ? prettyJson(card.result.content) : '');
  return toolShell({
    title: tool || card.name,
    subtitle: truncate(firstStringValue(input), SUBTITLE_MAX),
    status: statusOf(card),
    body: () => mcpBody(card, input, ctx),
    open: Boolean(ctx.open),
    actions: copyable ? [copyButton({ text: copyable, t, label: t('tools.mcp.copyResult') })] : [],
    extras: server ? [chip(server, { kind: 'accent', mono: true, title: t('tools.mcp.server') })] : [],
    t,
    family: 'mcp',
  });
}

/**
 * @param {import('./index.js').ToolCard} card
 * @param {Record<string, unknown>} input
 * @param {import('./index.js').ToolContext} ctx
 * @returns {HTMLElement}
 */
function mcpBody(card, input, ctx) {
  const { t } = ctx;
  const parts = [];
  const entries = Object.entries(input);
  if (entries.length === 0) {
    parts.push(mutedNote(t('tools.mcp.noInput')));
  } else {
    parts.push(keyValueList(entries.map(([key, value]) => [key, valueNode(value)])));
  }
  if (card.result?.isError) {
    parts.push(errorBlock(resultText(card.result) || prettyJson(card.result.content), t));
  } else {
    parts.push(...outputNodes(card, t), ...resultImages(card.result, t('tools.mcp.image')));
  }
  return h('div', { class: 'tool-mcp' }, parts);
}

/**
 * Nested inputs are shown as pretty JSON; primitives as text.
 * @param {unknown} value
 * @returns {Node | string}
 */
function valueNode(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return codeBlock(prettyJson(value), { className: 'tool-code-inline' });
}

/**
 * Result blocks: the content of the MCP result, or the structured payload when no content is present.
 * @param {import('./index.js').ToolCard} card
 * @param {import('./index.js').Translate} t
 * @returns {Node[]}
 */
function outputNodes(card, t) {
  if (!card.result) return [];
  const content = card.result.content;
  if (typeof content === 'string') return textOutput(content);
  if (Array.isArray(content)) return content.flatMap((block) => blockNodes(block, t));
  if (content != null) return [codeBlock(prettyJson(content))];
  return [];
}

/**
 * @param {unknown} block
 * @param {import('./index.js').Translate} t
 * @returns {Node[]}
 */
function blockNodes(block, t) {
  if (typeof block === 'string') return textOutput(block);
  if (!isRecord(block)) return [];
  if (block.type === 'text' && typeof block.text === 'string') return textOutput(block.text);
  if (block.type === 'image') {
    // Only a web image type within the size limit is shown; anything else says so instead of showing raw data.
    const image = imageButton(imageFromBlock(block), t('tools.mcp.image'), t);
    return [image ?? mutedNote(t('tools.mcp.imageUnavailable'))];
  }
  return [codeBlock(prettyJson(block))];
}

/**
 * Text output; JSON text is pretty-printed.
 * @param {string} text
 * @returns {Node[]}
 */
function textOutput(text) {
  if (text.trim() === '') return [];
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return [codeBlock(JSON.stringify(JSON.parse(trimmed), null, 2))];
    } catch {
      return [codeBlock(text)];
    }
  }
  return [codeBlock(text)];
}

/**
 * @param {Record<string, unknown>} input
 * @returns {string}
 */
function firstStringValue(input) {
  for (const value of Object.values(input)) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim().split(/\r?\n/)[0] ?? '';
  }
  return '';
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function recordOf(value) {
  return isRecord(value) ? value : {};
}
