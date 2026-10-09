/**
 * Pure line-diff helpers for the tool cards. No DOM access; unit-tested in Node.
 *
 * A hunk uses unified-diff conventions: `oldStart`/`newStart` are 1-based, except that an empty range starts at the
 * line before its insertion point (0 for a new file). Every entry of `lines` is a context line (' '), a removed line
 * ('-') or an added line ('+'), followed by the line text without a line terminator.
 */

/**
 * @typedef {{ oldStart: number, oldLines: number, newStart: number, newLines: number, lines: string[] }} DiffHunk
 */

/**
 * @typedef {{ type: ' ' | '-' | '+', text: string, oldNo: number | null, newNo: number | null }} DiffRow
 */

export const DIFF_CONTEXT_LINES = 3;
export const DIFF_MAX_TOTAL_LINES = 4000;

/**
 * Split text into lines. CRLF and LF both end a line; one trailing line terminator does not add an empty line.
 * Non-string input is treated as empty text.
 * @param {unknown} text
 * @returns {string[]}
 */
export function splitDiffLines(text) {
  const value = typeof text === 'string' ? text : '';
  const lines = value.replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Compute the hunks that turn `oldText` into `newText`, with up to three context lines around each change.
 * Identical inputs give no hunks. When the two inputs together exceed 4 000 lines, the whole old text is shown as one
 * removal followed by the whole new text as one addition, instead of spending time on a full comparison.
 * @param {unknown} oldText
 * @param {unknown} newText
 * @returns {DiffHunk[]}
 */
export function diffLines(oldText, newText) {
  const a = splitDiffLines(oldText);
  const b = splitDiffLines(newText);
  if (sameLines(a, b)) return [];
  if (a.length + b.length > DIFF_MAX_TOTAL_LINES) return replaceHunk(a, b);
  return buildHunks(editScript(a, b));
}

/**
 * Normalize the SDK `structuredPatch` shape. Its lines already carry the ' ', '-' or '+' prefix; the
 * "\ No newline at end of file" markers are dropped, and counts are recomputed from the lines.
 * @param {unknown} patch
 * @returns {DiffHunk[]}
 */
export function hunksFromStructuredPatch(patch) {
  if (!Array.isArray(patch)) return [];
  /** @type {DiffHunk[]} */
  const hunks = [];
  for (const entry of patch) {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.lines)) continue;
    const lines = [];
    for (const raw of entry.lines) {
      if (typeof raw !== 'string' || raw.startsWith('\\')) continue;
      const prefix = raw[0];
      lines.push(prefix === '+' || prefix === '-' || prefix === ' ' ? raw : ` ${raw}`);
    }
    if (lines.length === 0) continue;
    const oldLines = lines.filter((line) => line[0] !== '+').length;
    const newLines = lines.filter((line) => line[0] !== '-').length;
    hunks.push({
      oldStart: toCount(entry.oldStart),
      oldLines,
      newStart: toCount(entry.newStart),
      newLines,
      lines,
    });
  }
  return hunks;
}

/**
 * Count added and removed lines across hunks.
 * @param {unknown} hunks
 * @returns {{ added: number, removed: number }}
 */
export function countChanges(hunks) {
  let added = 0;
  let removed = 0;
  if (!Array.isArray(hunks)) return { added, removed };
  for (const hunk of hunks) {
    if (!hunk || !Array.isArray(hunk.lines)) continue;
    for (const line of hunk.lines) {
      if (typeof line !== 'string') continue;
      if (line[0] === '+') added++;
      else if (line[0] === '-') removed++;
    }
  }
  return { added, removed };
}

/**
 * Render hunks as a unified diff string (no trailing newline). Empty input gives an empty string.
 * @param {unknown} hunks
 * @returns {string}
 */
export function formatUnified(hunks) {
  if (!Array.isArray(hunks)) return '';
  const out = [];
  for (const hunk of hunks) {
    if (!hunk || !Array.isArray(hunk.lines)) continue;
    out.push(`@@ -${formatRange(hunk.oldStart, hunk.oldLines)} +${formatRange(hunk.newStart, hunk.newLines)} @@`);
    for (const line of hunk.lines) out.push(String(line));
  }
  return out.join('\n');
}

/**
 * Turn one hunk into display rows with old and new line numbers. Removed rows have no new number and added rows have
 * no old number.
 * @param {DiffHunk} hunk
 * @returns {DiffRow[]}
 */
export function numberedRows(hunk) {
  /** @type {DiffRow[]} */
  const rows = [];
  let oldNo = toCount(hunk.oldStart);
  let newNo = toCount(hunk.newStart);
  for (const raw of Array.isArray(hunk.lines) ? hunk.lines : []) {
    const line = typeof raw === 'string' ? raw : '';
    const hasPrefix = line[0] === '+' || line[0] === '-' || line[0] === ' ';
    const type = hasPrefix ? /** @type {' ' | '-' | '+'} */ (line[0]) : ' ';
    const text = hasPrefix ? line.slice(1) : line;
    rows.push({
      type,
      text,
      oldNo: type === '+' ? null : oldNo,
      newNo: type === '-' ? null : newNo,
    });
    if (type !== '+') oldNo++;
    if (type !== '-') newNo++;
  }
  return rows;
}

/**
 * @typedef {{ op: ' ' | '-' | '+', text: string, oa: number, nb: number }} EditOp
 * `oa` is the old-side index of the line (or the old insertion point for '+'); `nb` the new-side index (or the new
 * insertion point for '-').
 */

/**
 * @param {string[]} a
 * @param {string[]} b
 * @returns {boolean}
 */
function sameLines(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * @param {string[]} a
 * @param {string[]} b
 * @returns {DiffHunk[]}
 */
function replaceHunk(a, b) {
  return [
    {
      oldStart: a.length > 0 ? 1 : 0,
      oldLines: a.length,
      newStart: b.length > 0 ? 1 : 0,
      newLines: b.length,
      lines: [...a.map((line) => `-${line}`), ...b.map((line) => `+${line}`)],
    },
  ];
}

/**
 * Line-level edit script: shared prefix and suffix are trimmed, then a longest-common-subsequence table decides the
 * middle. Table entries never exceed min(n, m) <= 2 000 here, so Uint16 storage is exact.
 * @param {string[]} a
 * @param {string[]} b
 * @returns {EditOp[]}
 */
function editScript(a, b) {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let aEnd = a.length;
  let bEnd = b.length;
  while (aEnd > prefix && bEnd > prefix && a[aEnd - 1] === b[bEnd - 1]) {
    aEnd--;
    bEnd--;
  }
  /** @type {EditOp[]} */
  const ops = [];
  let oi = 0;
  let ni = 0;
  /**
   * @param {' ' | '-' | '+'} op
   * @param {string} text
   */
  const push = (op, text) => {
    ops.push({ op, text, oa: oi, nb: ni });
    if (op !== '+') oi++;
    if (op !== '-') ni++;
  };
  for (let i = 0; i < prefix; i++) push(' ', a[i]);
  appendLcsOps(a.slice(prefix, aEnd), b.slice(prefix, bEnd), push);
  for (let i = aEnd; i < a.length; i++) push(' ', a[i]);
  return ops;
}

/**
 * @param {string[]} x
 * @param {string[]} y
 * @param {(op: ' ' | '-' | '+', text: string) => void} push
 */
function appendLcsOps(x, y, push) {
  const n = x.length;
  const m = y.length;
  const width = m + 1;
  const table = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        x[i] === y[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      push(' ', x[i]);
      i++;
      j++;
    } else if (j >= m || (i < n && table[(i + 1) * width + j] >= table[i * width + j + 1])) {
      push('-', x[i]);
      i++;
    } else {
      push('+', y[j]);
      j++;
    }
  }
}

/**
 * Group changed operations whose separating context is short enough for their hunks to touch, then cut each group
 * with context.
 * @param {EditOp[]} ops
 * @returns {DiffHunk[]}
 */
function buildHunks(ops) {
  /** @type {Array<[number, number]>} */
  const groups = [];
  /** @type {[number, number] | null} */
  let open = null;
  for (let idx = 0; idx < ops.length; idx++) {
    if (ops[idx].op === ' ') continue;
    if (open && idx - open[1] - 1 <= 2 * DIFF_CONTEXT_LINES) {
      open[1] = idx;
    } else {
      open = [idx, idx];
      groups.push(open);
    }
  }
  return groups.map(([first, last]) =>
    hunkFromOps(ops, Math.max(0, first - DIFF_CONTEXT_LINES), Math.min(ops.length - 1, last + DIFF_CONTEXT_LINES)),
  );
}

/**
 * @param {EditOp[]} ops
 * @param {number} from
 * @param {number} to inclusive
 * @returns {DiffHunk}
 */
function hunkFromOps(ops, from, to) {
  let oldLines = 0;
  let newLines = 0;
  const lines = [];
  for (let idx = from; idx <= to; idx++) {
    const { op, text } = ops[idx];
    if (op !== '+') oldLines++;
    if (op !== '-') newLines++;
    lines.push(op + text);
  }
  const first = ops[from];
  return {
    oldStart: oldLines > 0 ? first.oa + 1 : first.oa,
    oldLines,
    newStart: newLines > 0 ? first.nb + 1 : first.nb,
    newLines,
    lines,
  };
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function toCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

/**
 * @param {number} start
 * @param {number} count
 * @returns {string}
 */
function formatRange(start, count) {
  return count === 1 ? `${toCount(start)}` : `${toCount(start)},${toCount(count)}`;
}
