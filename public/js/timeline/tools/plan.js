/**
 * Renderers for plan-mode tools: ExitPlanMode (the proposed plan, as Markdown in a bordered scrollable block) and
 * EnterPlanMode (a compact row).
 */

import { h } from '../../dom.js';
import { chip, copyButton, errorBlock, markdownBlock, mutedNote, statusOf, toolShell } from './shell.js';
import { displayPath, isRecord, resultText, str } from './summaries.js';

/**
 * @param {import('./index.js').ToolCard} card
 * @param {import('./index.js').ToolContext} ctx
 * @returns {HTMLElement}
 */
export function render(card, ctx) {
  return card.name === 'EnterPlanMode' ? renderEnter(card, ctx) : renderExit(card, ctx);
}

/**
 * @param {import('./index.js').ToolCard} card
 * @param {import('./index.js').ToolContext} ctx
 * @returns {HTMLElement}
 */
function renderExit(card, ctx) {
  const { t } = ctx;
  const input = recordOf(card.input);
  const structured = recordOf(card.structured);
  const plan = str(structured.plan) || str(input.plan);
  const savedPath = displayPath(structured.filePath, ctx.cwd);
  return toolShell({
    iconName: 'layers',
    title: 'ExitPlanMode',
    subtitle: savedPath,
    status: statusOf(card),
    body: () => exitBody(card, structured, plan, ctx),
    open: Boolean(ctx.open || card.pendingRequestId),
    actions: plan ? [copyButton({ text: plan, t, label: t('tools.plan.copy') })] : [],
    extras: [chip(t('tools.plan.badge'), { kind: 'accent' })],
    t,
    family: 'plan',
  });
}

/**
 * @param {import('./index.js').ToolCard} card
 * @param {Record<string, unknown>} structured
 * @param {string} plan
 * @param {import('./index.js').ToolContext} ctx
 * @returns {HTMLElement}
 */
function exitBody(card, structured, plan, ctx) {
  const { t } = ctx;
  const parts = [];
  const meta = [];
  if (structured.planWasEdited === true) meta.push(chip(t('tools.plan.edited'), { kind: 'accent' }));
  if (structured.awaitingLeaderApproval === true) meta.push(chip(t('tools.plan.awaitingLeader'), { kind: 'warning' }));
  const savedPath = str(structured.filePath);
  if (savedPath) meta.push(chip(displayPath(savedPath, ctx.cwd), { mono: true, title: savedPath }));
  if (meta.length > 0) parts.push(h('div', { class: 'tool-meta' }, meta));
  if (card.result?.isError) {
    parts.push(errorBlock(resultText(card.result), t));
  } else if (plan) {
    parts.push(h('div', { class: 'tool-plan' }, [markdownBlock(plan, ctx.renderMarkdown)]));
  } else if (card.result) {
    parts.push(mutedNote(resultText(card.result) || t('tools.plan.empty')));
  } else {
    parts.push(mutedNote(t('tools.plan.pending')));
  }
  return h('div', { class: 'tool-plan-card' }, parts);
}

/**
 * @param {import('./index.js').ToolCard} card
 * @param {import('./index.js').ToolContext} ctx
 * @returns {HTMLElement}
 */
function renderEnter(card, ctx) {
  const { t } = ctx;
  const structured = recordOf(card.structured);
  const failed = card.result?.isError === true;
  const message = str(structured.message) || resultText(card.result);
  const body = () => (failed ? errorBlock(message, t) : mutedNote(message));
  return toolShell({
    iconName: 'layers',
    title: 'EnterPlanMode',
    status: statusOf(card),
    body: message ? body : null,
    open: Boolean(ctx.open || card.pendingRequestId),
    t,
    family: 'plan',
  });
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function recordOf(value) {
  return isRecord(value) ? value : {};
}
