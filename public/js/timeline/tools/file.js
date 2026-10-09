/**
 * Renderers for file tools: Read, Write, Edit, MultiEdit and NotebookEdit. Edits show a unified diff built from the
 * structured patch when the result carries one, otherwise from the old/new strings of the input.
 */

import { h } from '../../dom.js';
import { formatBytes } from '../format.js';
import {
  countChanges,
  diffLines,
  formatUnified,
  hunksFromStructuredPatch,
  numberedRows,
  splitDiffLines,
} from '../diff.js';
import {
  cappedList,
  chip,
  codeBlock,
  copyButton,
  errorBlock,
  imageNode,
  resultImages,
  statusOf,
  toolShell,
} from './shell.js';
import { displayPath, finiteNumber, isRecord, resultText, str } from './summaries.js';

const READ_PREVIEW_LINES = 30;
const WRITE_PREVIEW_LINES = 40;
const DIFF_COLLAPSE_ROWS = 24;
const NUMBERED_LINE = /^\s*(\d+)→(.*)$/;
const NOTEBOOK_MODES = new Set(['replace', 'insert', 'delete']);

/**
 * @typedef {{ label: string | null, hunks: import('../diff.js').DiffHunk[] }} DiffGroup
 */

/**
 * @param {import('./index.js').ToolCard} card
 * @param {import('./index.js').ToolContext} ctx
 * @returns {HTMLElement}
 */
export function render(card, ctx) {
  switch (card.name) {
    case 'Read':
      return renderRead(card, ctx);
    case 'Write':
      return renderWrite(card, ctx);
    case 'NotebookEdit':
      return renderNotebook(card, ctx);
    default:
      return renderEdit(card, ctx);
  }
}

/**
 * @param {import('./index.js').ToolCard} card
 * @param {import('./index.js').ToolContext} ctx
 * @returns {HTMLElement}
 */
function renderRead(card, ctx) {
  const { t } = ctx;
  const input = recordOf(card.input);
  const structured = recordOf(card.structured);
  const path = displayPath(input.file_path, ctx.cwd);
  const range = readRange(input);
  const filePath = str(input.file_path);
  return toolShell({
    iconName: 'file',
    title: 'Read',
    subtitle: range ? `${path}:${range}` : path,
    status: statusOf(card),
    body: () => readBody(card, input, structured, t),
    open: Boolean(ctx.open || card.pendingRequestId),
    actions: filePath ? [copyButton({ text: filePath, t, label: t('tools.file.copyPath') })] : [],
    t,
    family: 'file',
  });
}

/**
 * @param {import('./index.js').ToolCard} card
 * @param {Record<string, unknown>} input
 * @param {Record<string, unknown>} structured
 * @param {import('./index.js').Translate} t
 * @returns {HTMLElement}
 */
function readBody(card, input, structured, t) {
  const file = recordOf(structured.file);
  const meta = [];
  const range = readRange(input);
  if (range) meta.push(chip(t('tools.file.lines', { range }), { mono: true }));
  if (finiteNumber(file.totalLines) != null) {
    meta.push(chip(t('tools.file.totalLines', { count: file.totalLines })));
  }
  if (file.truncatedByTokenCap === true) meta.push(chip(t('tools.file.truncated'), { kind: 'warning' }));
  const parts = [];
  if (meta.length > 0) parts.push(h('div', { class: 'tool-meta' }, meta));
  parts.push(...readContent(card, structured, t));
  if (structured.type !== 'image' && !card.result?.isError) {
    parts.push(...resultImages(card.result, t('tools.file.image')));
  }
  return h('div', { class: 'tool-file' }, parts);
}

/**
 * @param {import('./index.js').ToolCard} card
 * @param {Record<string, unknown>} structured
 * @param {import('./index.js').Translate} t
 * @returns {Array<Node | null>}
 */
function readContent(card, structured, t) {
  if (card.result?.isError) return [errorBlock(resultText(card.result), t)];
  const file = recordOf(structured.file);
  if (structured.type === 'text' && typeof file.content === 'string') {
    const start = finiteNumber(file.startLine) ?? 1;
    const rows = splitDiffLines(file.content).map((text, index) => ({ no: start + index, text }));
    return [numberedView(rows, t, READ_PREVIEW_LINES)];
  }
  if (structured.type === 'image') {
    const image = imageNode(file.type, file.base64, t('tools.file.image'));
    return [image ?? note(t('tools.file.imageUnavailable'), t)];
  }
  if (structured.type === 'pdf') {
    return [note(t('tools.file.pdf', { size: formatBytes(finiteNumber(file.originalSize) ?? 0) }), t)];
  }
  if (structured.type === 'notebook') {
    const cells = Array.isArray(file.cells) ? file.cells.length : 0;
    return [note(t('tools.file.notebook', { count: cells }), t)];
  }
  if (structured.type === 'parts') {
    const count = finiteNumber(file.count) ?? 0;
    return [note(t('tools.file.pages', { count }), t)];
  }
  if (structured.type === 'file_unchanged') return [note(t('tools.file.unchanged'), t)];
  return [textPreview(resultText(card.result), t)];
}

/**
 * Preview of a result text in the runtime's numbered form ("    12→content"). Unnumbered lines are not content.
 * @param {string} text
 * @param {import('./index.js').Translate} t
 * @returns {Node | null}
 */
function textPreview(text, t) {
  if (!text) return null;
  /** @type {Array<{ no: number, text: string }>} */
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const match = NUMBERED_LINE.exec(line);
    if (match) rows.push({ no: Number(match[1]), text: match[2] });
  }
  if (rows.length > 0) return numberedView(rows, t, READ_PREVIEW_LINES);
  return codeBlock(text);
}

/**
 * @param {import('./index.js').ToolCard} card
 * @param {import('./index.js').ToolContext} ctx
 * @returns {HTMLElement}
 */
function renderWrite(card, ctx) {
  const { t } = ctx;
  const input = recordOf(card.input);
  const structured = recordOf(card.structured);
  const content = str(input.content);
  const lines = splitDiffLines(content);
  const patch = structured.type === 'update' ? hunksFromStructuredPatch(structured.structuredPatch) : [];
  const counts = patch.length > 0 ? countChanges(patch) : { added: lines.length, removed: 0 };
  const groups = patch.length > 0 ? [{ label: null, hunks: patch }] : [];
  const filePath = str(input.file_path);
  return toolShell({
    iconName: 'file',
    title: 'Write',
    subtitle: displayPath(input.file_path, ctx.cwd),
    status: statusOf(card),
    body: () => {
      const meta = [chip(t(structured.type === 'update' ? 'tools.file.updated' : 'tools.file.created'))];
      if (structured.staged === true) meta.push(chip(t('tools.file.staged'), { kind: 'warning' }));
      if (structured.userModified === true) meta.push(chip(t('tools.file.userModified'), { kind: 'accent' }));
      const parts = [h('div', { class: 'tool-meta' }, meta)];
      if (groups.length > 0) {
        parts.push(diffView(groups, t));
      } else if (lines.length > 0) {
        const rows = lines.map((text, index) => ({ no: index + 1, text }));
        parts.push(numberedView(rows, t, WRITE_PREVIEW_LINES));
      } else {
        parts.push(note(t('tools.file.emptyFile'), t));
      }
      if (card.result?.isError) parts.push(errorBlock(resultText(card.result), t));
      return h('div', { class: 'tool-file' }, parts);
    },
    open: Boolean(ctx.open || card.pendingRequestId),
    actions: filePath ? [copyButton({ text: filePath, t, label: t('tools.file.copyPath') })] : [],
    extras: diffStat(counts, t),
    t,
    family: 'file',
  });
}

/**
 * @param {import('./index.js').ToolCard} card
 * @param {import('./index.js').ToolContext} ctx
 * @returns {HTMLElement}
 */
function renderEdit(card, ctx) {
  const { t } = ctx;
  const input = recordOf(card.input);
  const structured = recordOf(card.structured);
  const groups = editGroups(card.name, input, structured, t);
  const counts = totalCounts(groups);
  const filePath = str(input.file_path);
  return toolShell({
    iconName: 'edit',
    title: card.name === 'MultiEdit' ? 'MultiEdit' : 'Edit',
    subtitle: displayPath(input.file_path, ctx.cwd),
    status: statusOf(card),
    body: () => editBody(card, input, structured, groups, t),
    open: Boolean(ctx.open || card.pendingRequestId),
    actions: filePath ? [copyButton({ text: filePath, t, label: t('tools.file.copyPath') })] : [],
    extras: counts.added + counts.removed > 0 ? diffStat(counts, t) : [],
    t,
    family: 'file',
  });
}

/**
 * @param {import('./index.js').ToolCard} card
 * @param {Record<string, unknown>} input
 * @param {Record<string, unknown>} structured
 * @param {DiffGroup[]} groups
 * @param {import('./index.js').Translate} t
 * @returns {HTMLElement}
 */
function editBody(card, input, structured, groups, t) {
  const meta = [];
  if (input.replace_all === true || structured.replaceAll === true) meta.push(chip(t('tools.file.replaceAll')));
  if (structured.userModified === true) meta.push(chip(t('tools.file.userModified'), { kind: 'accent' }));
  if (structured.staged === true) meta.push(chip(t('tools.file.staged'), { kind: 'warning' }));
  const parts = [];
  if (meta.length > 0) parts.push(h('div', { class: 'tool-meta' }, meta));
  if (card.result?.isError) parts.push(errorBlock(resultText(card.result), t));
  if (groups.some((group) => group.hunks.length > 0)) {
    parts.push(diffView(groups, t));
  } else if (!card.result?.isError) {
    parts.push(note(t('tools.file.noChanges'), t));
  }
  return h('div', { class: 'tool-file' }, parts);
}

/**
 * Diff groups for an Edit or MultiEdit: the structured patch when present, else diffs of the input strings (one group
 * per edit for MultiEdit, in sequence).
 * @param {string} name
 * @param {Record<string, unknown>} input
 * @param {Record<string, unknown>} structured
 * @param {import('./index.js').Translate} t
 * @returns {DiffGroup[]}
 */
function editGroups(name, input, structured, t) {
  const patch = hunksFromStructuredPatch(structured.structuredPatch);
  if (patch.length > 0) return [{ label: null, hunks: patch }];
  if (name !== 'MultiEdit') {
    return [{ label: null, hunks: diffLines(input.old_string, input.new_string) }];
  }
  const edits = Array.isArray(input.edits) ? input.edits : [];
  return edits
    .map((edit, index) => {
      const pair = recordOf(edit);
      return {
        label: t('tools.file.editStep', { index: index + 1 }),
        hunks: diffLines(pair.old_string, pair.new_string),
      };
    })
    .filter((group) => group.hunks.length > 0);
}

/**
 * @param {import('./index.js').ToolCard} card
 * @param {import('./index.js').ToolContext} ctx
 * @returns {HTMLElement}
 */
function renderNotebook(card, ctx) {
  const { t } = ctx;
  const input = recordOf(card.input);
  const structured = recordOf(card.structured);
  const newSource = typeof input.new_source === 'string' ? input.new_source : str(structured.new_source);
  const oldSource = typeof structured.old_source === 'string' ? structured.old_source : null;
  const cellId = str(structured.cell_id) || str(input.cell_id);
  const cellType = str(structured.cell_type) || str(input.cell_type);
  const requestedMode = str(structured.edit_mode) || str(input.edit_mode);
  const editMode = NOTEBOOK_MODES.has(requestedMode) ? requestedMode : 'replace';
  const notebookPath = str(input.notebook_path);
  return toolShell({
    iconName: 'layers',
    title: 'NotebookEdit',
    subtitle: displayPath(notebookPath, ctx.cwd),
    status: statusOf(card),
    body: () => {
      const meta = [chip(t(`tools.notebook.mode.${editMode}`), { kind: 'accent' })];
      if (cellType) meta.push(chip(cellType));
      if (cellId) meta.push(chip(cellId, { mono: true }));
      if (str(structured.language)) meta.push(chip(str(structured.language)));
      const parts = [h('div', { class: 'tool-meta' }, meta)];
      if (card.result?.isError) parts.push(errorBlock(str(structured.error) || resultText(card.result), t));
      if (editMode === 'delete') {
        parts.push(note(t('tools.notebook.deleted'), t));
      } else if (oldSource !== null && oldSource !== newSource) {
        parts.push(diffView([{ label: null, hunks: diffLines(oldSource, newSource) }], t));
      } else if (newSource) {
        parts.push(codeBlock(newSource, { label: t('tools.notebook.source') }));
      } else {
        parts.push(note(t('tools.notebook.emptySource'), t));
      }
      return h('div', { class: 'tool-file' }, parts);
    },
    open: Boolean(ctx.open || card.pendingRequestId),
    actions: newSource ? [copyButton({ text: newSource, t, label: t('tools.notebook.copySource') })] : [],
    t,
    family: 'file',
  });
}

/**
 * Line-numbered list with a "show all" control.
 * @param {Array<{ no: number, text: string }>} rows
 * @param {import('./index.js').Translate} t
 * @param {number} limit
 * @returns {HTMLElement}
 */
function numberedView(rows, t, limit) {
  return h('div', { class: 'tool-scroll' }, [
    cappedList({
      items: rows,
      limit,
      renderItem: (row) =>
        h('div', { class: 'tool-line' }, [
          h('span', { class: 'tool-ln', text: String(row.no) }),
          h('span', { class: 'tool-lc', text: row.text }),
        ]),
      moreLabel: t('tools.file.showAllLines', { count: rows.length }),
      className: 'tool-code-lines',
    }),
  ]);
}

/**
 * Unified diff with old and new line-number gutters, hunk headers and add/delete row backgrounds.
 * @param {DiffGroup[]} groups
 * @param {import('./index.js').Translate} t
 * @returns {HTMLElement}
 */
function diffView(groups, t) {
  const scroller = h('div', { class: 'tool-diff' });
  let rowCount = 0;
  for (const group of groups) {
    if (group.label) scroller.appendChild(h('div', { class: 'tool-diff-label', text: group.label }));
    for (const hunk of group.hunks) {
      scroller.appendChild(h('div', { class: 'tool-hunk', text: formatUnified([hunk]).split('\n')[0] }));
      for (const row of numberedRows(hunk)) {
        scroller.appendChild(diffRow(row));
        rowCount++;
      }
    }
  }
  return h('div', { class: 'tool-diff-view' }, [diffBar(scroller, rowCount, t), scroller]);
}

/**
 * @param {import('../diff.js').DiffRow} row
 * @returns {HTMLElement}
 */
function diffRow(row) {
  const kind = row.type === '+' ? 'is-add' : row.type === '-' ? 'is-del' : 'is-ctx';
  return h('div', { class: ['tool-diff-row', kind] }, [
    h('span', { class: 'tool-ln', text: row.oldNo == null ? '' : String(row.oldNo) }),
    h('span', { class: 'tool-ln', text: row.newNo == null ? '' : String(row.newNo) }),
    h('span', { class: 'tool-sign', text: row.type, attrs: { 'aria-hidden': 'true' } }),
    h('span', { class: 'tool-dc', text: row.text }),
  ]);
}

/**
 * Word-wrap toggle and, for long diffs, an expand toggle that lifts the 420 px height limit.
 * @param {HTMLElement} scroller
 * @param {number} rowCount
 * @param {import('./index.js').Translate} t
 * @returns {HTMLElement}
 */
function diffBar(scroller, rowCount, t) {
  const wrap = h('button', {
    class: 'tool-action',
    attrs: { type: 'button', 'aria-pressed': 'false' },
    text: t('tools.file.wrap'),
  });
  wrap.addEventListener('click', () => {
    const on = !scroller.classList.contains('is-wrap');
    scroller.classList.toggle('is-wrap', on);
    wrap.setAttribute('aria-pressed', String(on));
  });
  const controls = [wrap];
  if (rowCount > DIFF_COLLAPSE_ROWS) {
    const expand = h('button', {
      class: 'tool-action',
      attrs: { type: 'button', 'aria-expanded': 'false' },
      text: t('tools.file.expand'),
    });
    expand.addEventListener('click', () => {
      const on = !scroller.classList.contains('is-expanded');
      scroller.classList.toggle('is-expanded', on);
      expand.setAttribute('aria-expanded', String(on));
      expand.textContent = t(on ? 'tools.file.collapse' : 'tools.file.expand');
    });
    controls.push(expand);
  }
  return h('div', { class: 'tool-diff-bar' }, controls);
}

/**
 * @param {{ added: number, removed: number }} counts
 * @param {import('./index.js').Translate} t
 * @returns {HTMLElement[]}
 */
function diffStat(counts, t) {
  const added = { kind: 'success', mono: true, title: t('tools.file.addedLines', { count: counts.added }) };
  const removed = { kind: 'danger', mono: true, title: t('tools.file.removedLines', { count: counts.removed }) };
  return [chip(`+${counts.added}`, added), chip(`−${counts.removed}`, removed)];
}

/**
 * @param {DiffGroup[]} groups
 * @returns {{ added: number, removed: number }}
 */
function totalCounts(groups) {
  let added = 0;
  let removed = 0;
  for (const group of groups) {
    const counts = countChanges(group.hunks);
    added += counts.added;
    removed += counts.removed;
  }
  return { added, removed };
}

/**
 * @param {Record<string, unknown>} input
 * @returns {string}
 */
function readRange(input) {
  const offset = finiteNumber(input.offset);
  const limit = finiteNumber(input.limit);
  if (offset == null && limit == null) return '';
  const start = offset ?? 1;
  return limit != null ? `${start}-${start + limit - 1}` : `${start}-`;
}

/**
 * @param {string} text
 * @param {import('./index.js').Translate} t
 * @returns {HTMLElement}
 */
function note(text, t) {
  return h('p', { class: 'tool-muted', text: text || t('tools.file.empty') });
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function recordOf(value) {
  return isRecord(value) ? value : {};
}
