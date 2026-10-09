import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  countChanges,
  diffLines,
  formatUnified,
  hunksFromStructuredPatch,
  numberedRows,
  splitDiffLines,
} from '../../public/js/timeline/diff.js';

/** @param {number} count @param {string} prefix */
function numbered(count, prefix = 'l') {
  return Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`).join('\n');
}

test('identical texts produce no hunks', () => {
  assert.deepEqual(diffLines('a\nb', 'a\nb'), []);
  assert.deepEqual(diffLines('', ''), []);
  assert.deepEqual(diffLines(null, undefined), []);
});

test('a single trailing newline does not create a difference', () => {
  assert.deepEqual(diffLines('a\nb\n', 'a\nb'), []);
});

test('pure addition into an empty file starts at zero', () => {
  assert.deepEqual(diffLines('', 'a\nb'), [
    { oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+a', '+b'] },
  ]);
});

test('pure deletion to an empty file starts at zero on the new side', () => {
  assert.deepEqual(diffLines('a\nb', ''), [
    { oldStart: 1, oldLines: 2, newStart: 0, newLines: 0, lines: ['-a', '-b'] },
  ]);
});

test('a single replaced line is one removal and one addition with context', () => {
  const hunks = diffLines('a\nb\nc\nd\ne\nf\ng\nh', 'a\nb\nc\nD\ne\nf\ng\nh');
  assert.deepEqual(hunks, [
    {
      oldStart: 1,
      oldLines: 7,
      newStart: 1,
      newLines: 7,
      lines: [' a', ' b', ' c', '-d', '+D', ' e', ' f', ' g'],
    },
  ]);
});

test('mixed insertions and deletions keep line order', () => {
  const hunks = diffLines('keep\nold1\nold2\ntail', 'keep\nnew1\ntail\nextra');
  assert.equal(hunks.length, 1);
  assert.deepEqual(hunks[0].lines, [' keep', '-old1', '-old2', '+new1', ' tail', '+extra']);
  assert.equal(hunks[0].oldLines, 4);
  assert.equal(hunks[0].newLines, 4);
});

test('changes closer than twice the context merge into one hunk', () => {
  const oldText = numbered(10);
  const newText = ['l1', 'l2', 'l3', 'X', 'l5', 'l6', 'l7', 'Y', 'l9', 'l10'].join('\n');
  const hunks = diffLines(oldText, newText);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].oldStart, 1);
  assert.equal(hunks[0].oldLines, 10);
  assert.equal(hunks[0].newLines, 10);
});

test('distant changes produce separate hunks with their own context', () => {
  const oldText = numbered(22);
  const lines = oldText.split('\n');
  lines[1] = 'X2';
  lines[18] = 'Y19';
  const hunks = diffLines(oldText, lines.join('\n'));
  assert.equal(hunks.length, 2);
  assert.deepEqual(hunks[0], {
    oldStart: 1,
    oldLines: 5,
    newStart: 1,
    newLines: 5,
    lines: [' l1', '-l2', '+X2', ' l3', ' l4', ' l5'],
  });
  assert.deepEqual(hunks[1], {
    oldStart: 16,
    oldLines: 7,
    newStart: 16,
    newLines: 7,
    lines: [' l16', ' l17', ' l18', '-l19', '+Y19', ' l20', ' l21', ' l22'],
  });
});

test('CRLF and LF line endings compare equal and carry no carriage returns', () => {
  assert.deepEqual(splitDiffLines('a\r\nb\r\n'), ['a', 'b']);
  const hunks = diffLines('a\r\nb\r\n', 'a\r\nc\r\n');
  assert.deepEqual(hunks, [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' a', '-b', '+c'] }]);
  assert.deepEqual(diffLines('a\r\nb', 'a\nb'), []);
});

test('non-string input is treated as empty text', () => {
  assert.deepEqual(splitDiffLines(42), []);
  assert.deepEqual(diffLines(undefined, 'x'), [
    { oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+x'] },
  ]);
});

test('inputs over 4000 lines in total fall back to one replace hunk', () => {
  const oldText = numbered(2001, 'x');
  const newText = numbered(2001, 'y');
  const hunks = diffLines(oldText, newText);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].oldStart, 1);
  assert.equal(hunks[0].oldLines, 2001);
  assert.equal(hunks[0].newLines, 2001);
  assert.equal(hunks[0].lines.length, 4002);
  assert.equal(hunks[0].lines[0], '-x1');
  assert.equal(hunks[0].lines[2001], '+y1');
});

test('large identical inputs are still reported as unchanged', () => {
  const text = numbered(3000);
  assert.deepEqual(diffLines(text, text), []);
});

test('structuredPatch hunks are normalized and their counts recomputed', () => {
  const patch = [
    {
      oldStart: 2,
      oldLines: 9,
      newStart: 2,
      newLines: 9,
      lines: [' keep', '-old', '+new', '\\ No newline at end of file', '+more', 'bare'],
    },
  ];
  assert.deepEqual(hunksFromStructuredPatch(patch), [
    { oldStart: 2, oldLines: 3, newStart: 2, newLines: 4, lines: [' keep', '-old', '+new', '+more', ' bare'] },
  ]);
});

test('structuredPatch normalization tolerates malformed entries', () => {
  assert.deepEqual(hunksFromStructuredPatch(null), []);
  assert.deepEqual(hunksFromStructuredPatch('nope'), []);
  const messy = [null, { lines: 'x' }, { oldStart: 'a', lines: [] }, { lines: [1, '-z'] }];
  assert.deepEqual(hunksFromStructuredPatch(messy), [
    { oldStart: 0, oldLines: 1, newStart: 0, newLines: 0, lines: ['-z'] },
  ]);
});

test('counts report added and removed lines', () => {
  const hunks = diffLines('a\nb\nc', 'a\nB\nc\nd');
  assert.deepEqual(countChanges(hunks), { added: 2, removed: 1 });
  assert.deepEqual(countChanges([]), { added: 0, removed: 0 });
  assert.deepEqual(countChanges(null), { added: 0, removed: 0 });
  assert.deepEqual(countChanges([{ lines: [' ctx', '+x', 7] }]), { added: 1, removed: 0 });
});

test('unified output uses git-style ranges', () => {
  assert.equal(formatUnified(diffLines('', 'a\nb')), '@@ -0,0 +1,2 @@\n+a\n+b');
  assert.equal(formatUnified(diffLines('x', 'y')), '@@ -1 +1 @@\n-x\n+y');
  assert.equal(formatUnified([]), '');
  assert.equal(formatUnified(undefined), '');
});

test('numbered rows track old and new line numbers', () => {
  const [hunk] = diffLines('a\nb\nc\nd\ne\nf\ng\nh', 'a\nb\nc\nD\ne\nf\ng\nh');
  const rows = numberedRows(hunk);
  assert.deepEqual(rows[0], { type: ' ', text: 'a', oldNo: 1, newNo: 1 });
  assert.deepEqual(rows[3], { type: '-', text: 'd', oldNo: 4, newNo: null });
  assert.deepEqual(rows[4], { type: '+', text: 'D', oldNo: null, newNo: 4 });
  assert.deepEqual(rows[5], { type: ' ', text: 'e', oldNo: 5, newNo: 5 });
  assert.equal(rows.length, 8);
});

test('numbered rows never throw on odd hunks', () => {
  assert.deepEqual(numberedRows({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: [] }), []);
  assert.deepEqual(numberedRows({ oldStart: 3, oldLines: 0, newStart: 3, newLines: 0, lines: [42, 'plain'] }), [
    { type: ' ', text: '', oldNo: 3, newNo: 3 },
    { type: ' ', text: 'plain', oldNo: 4, newNo: 4 },
  ]);
});
