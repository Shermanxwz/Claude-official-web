/**
 * Fallback renderer for tools without a dedicated family: the tool name, its input as collapsible pretty JSON, and its
 * result as text (or pretty JSON when the result has no text). Never throws on unexpected data.
 */

import { h } from '../../dom.js';
import {
  codeBlock,
  copyButton,
  errorBlock,
  mutedNote,
  prettyJson,
  resultImages,
  section,
  statusOf,
  toolShell,
} from './shell.js';
import { resultText, str } from './summaries.js';

/**
 * @param {import('./index.js').ToolCard} card
 * @param {import('./index.js').ToolContext} ctx
 * @returns {HTMLElement}
 */
export function render(card, ctx) {
  const { t } = ctx;
  const pending = Boolean(card.pendingRequestId);
  const text = resultText(card.result) || (card.structured != null ? prettyJson(card.structured) : '');
  const failed = card.result?.isError === true;
  return toolShell({
    title: str(card.name) || t('tools.generic.unnamed'),
    status: statusOf(card),
    body: () => {
      const inputText = prettyJson(card.input);
      const inputBody = inputText
        ? codeBlock(inputText, { className: 'tool-code-json' })
        : mutedNote(t('tools.generic.noInput'));
      const parts = [section({ title: t('tools.generic.input'), open: pending, body: inputBody })];
      if (failed) {
        parts.push(errorBlock(text, t));
      } else {
        if (text) parts.push(codeBlock(text));
        parts.push(...resultImages(card.result, t('tools.generic.image')));
      }
      return h('div', { class: 'tool-generic' }, parts);
    },
    open: Boolean(ctx.open),
    actions: text && !failed ? [copyButton({ text, t, label: t('tools.copyResult') })] : [],
    t,
    family: 'generic',
  });
}
