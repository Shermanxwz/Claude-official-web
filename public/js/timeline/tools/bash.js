/**
 * Renderer for shell tools: Bash, BashOutput, KillShell / KillBash / TaskStop and Monitor.
 */

import { h } from '../../dom.js';
import { formatDuration, stripAnsi } from '../format.js';
import { chip, codeBlock, copyButton, prettyJson, statusOf, toolShell } from './shell.js';
import { finiteNumber, firstLine, isRecord, resultText, str, truncate } from './summaries.js';

const TAIL_LINES = 40;
const SUBTITLE_MAX = 240;

const ICONS = {
  Bash: 'terminal',
  BashOutput: 'terminal',
  Monitor: 'monitor',
  KillShell: 'stop',
  KillBash: 'stop',
  TaskStop: 'stop',
};

/**
 * @param {import('./index.js').ToolCard} card
 * @param {import('./index.js').ToolContext} ctx
 * @returns {HTMLElement}
 */
export function render(card, ctx) {
  const input = isRecord(card.input) ? card.input : {};
  const structured = isRecord(card.structured) ? card.structured : null;
  const command = str(input.command);
  const { stdout, stderr } = splitOutput(card, structured);
  const output = stdout || stderr;
  const actions = [];
  if (command) actions.push(copyButton({ text: command, t: ctx.t, label: ctx.t('tools.bash.copyCommand') }));
  if (output) actions.push(copyButton({ text: output, t: ctx.t, label: ctx.t('tools.bash.copyOutput') }));
  return toolShell({
    iconName: ICONS[card.name] ?? 'terminal',
    title: card.name,
    subtitle: subtitleOf(card.name, input, command),
    status: statusOf(card),
    body: () => buildBody(card, input, structured, command, { stdout, stderr }, ctx.t),
    open: Boolean(ctx.open || card.pendingRequestId),
    actions,
    t: ctx.t,
    family: 'bash',
  });
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} input
 * @param {string} command
 * @returns {string}
 */
function subtitleOf(name, input, command) {
  if (name === 'Bash' || name === 'Monitor') {
    return truncate(str(input.description) || firstLine(command), SUBTITLE_MAX);
  }
  return str(input.bash_id) || str(input.shell_id) || str(input.task_id) || '';
}

/**
 * Stdout and stderr of a shell result. The structured payload wins; without it the result text is stdout, or stderr
 * when the result is an error.
 * @param {import('./index.js').ToolCard} card
 * @param {Record<string, unknown> | null} structured
 * @returns {{ stdout: string, stderr: string }}
 */
function splitOutput(card, structured) {
  if (structured && (typeof structured.stdout === 'string' || typeof structured.stderr === 'string')) {
    return { stdout: stripAnsi(str(structured.stdout)), stderr: stripAnsi(str(structured.stderr)) };
  }
  const text = stripAnsi(resultText(card.result));
  return card.result?.isError ? { stdout: '', stderr: text } : { stdout: text, stderr: '' };
}

/**
 * @param {import('./index.js').ToolCard} card
 * @param {Record<string, unknown>} input
 * @param {Record<string, unknown> | null} structured
 * @param {string} command
 * @param {{ stdout: string, stderr: string }} output
 * @param {import('./index.js').Translate} t
 * @returns {HTMLElement}
 */
function buildBody(card, input, structured, command, output, t) {
  const parts = [];
  const meta = metaChips(input, structured, t);
  if (meta.length > 0) parts.push(h('div', { class: 'tool-meta' }, meta));
  if (command) {
    parts.push(codeBlock(command, { className: 'tool-command', label: t('tools.bash.command') }));
  } else if (Object.keys(input).length > 0) {
    parts.push(codeBlock(prettyJson(input), { className: 'tool-command' }));
  }
  if (output.stdout) parts.push(outputBlock(output.stdout, '', t));
  if (output.stderr) {
    parts.push(
      h('div', { class: 'tool-stderr' }, [
        h('div', { class: 'tool-caption tool-caption-error', text: t('tools.bash.stderr') }),
        outputBlock(output.stderr, 'tool-code-stderr', t),
      ]),
    );
  }
  if (card.result && !output.stdout && !output.stderr) {
    parts.push(h('p', { class: 'tool-muted', text: t('tools.bash.noOutput') }));
  }
  return h('div', { class: 'tool-bash' }, parts);
}

/**
 * @param {Record<string, unknown>} input
 * @param {Record<string, unknown> | null} structured
 * @param {import('./index.js').Translate} t
 * @returns {HTMLElement[]}
 */
function metaChips(input, structured, t) {
  const chips = [];
  if (input.run_in_background === true) chips.push(chip(t('tools.bash.background'), { kind: 'accent' }));
  const timeout = finiteNumber(input.timeout);
  if (timeout != null) chips.push(chip(t('tools.bash.timeout', { duration: formatDuration(timeout) })));
  if (structured?.interrupted === true) chips.push(chip(t('tools.bash.interrupted'), { kind: 'warning' }));
  const timedOut = finiteNumber(structured?.timedOutAfterMs);
  if (timedOut != null) {
    chips.push(chip(t('tools.bash.timedOut', { duration: formatDuration(timedOut) }), { kind: 'warning' }));
  }
  const taskId = str(structured?.backgroundTaskId);
  if (taskId) chips.push(chip(t('tools.bash.taskId', { id: taskId }), { kind: 'accent', mono: true }));
  const interpretation = str(structured?.returnCodeInterpretation);
  if (interpretation) chips.push(chip(truncate(interpretation, 120)));
  const savedPath = str(structured?.persistedOutputPath);
  if (savedPath) chips.push(chip(t('tools.bash.savedOutput'), { title: savedPath }));
  return chips;
}

/**
 * Output text. Long output shows its last 40 lines with a control that reveals the rest.
 * @param {string} text
 * @param {string} className
 * @param {import('./index.js').Translate} t
 * @returns {HTMLElement}
 */
function outputBlock(text, className, t) {
  const full = text.replace(/\n$/, '');
  const lines = full.split('\n');
  if (lines.length <= TAIL_LINES) return codeBlock(full, { className: className || undefined });
  const tail = lines.slice(-TAIL_LINES).join('\n');
  const pre = codeBlock(tail, { className: className || undefined });
  const showAllLabel = t('tools.bash.showAll', { count: lines.length });
  let expanded = false;
  const toggle = h('button', {
    class: 'tool-more',
    attrs: { type: 'button' },
    text: showAllLabel,
    on: {
      click: () => {
        expanded = !expanded;
        pre.textContent = expanded ? full : tail;
        toggle.textContent = expanded ? t('tools.bash.showLess') : showAllLabel;
      },
    },
  });
  return h('div', { class: 'tool-output' }, [pre, toggle]);
}
