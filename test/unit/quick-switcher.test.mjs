/**
 * Unit tests for the quick switcher's pure helpers: fuzzy and term matching, the highlight ranges used for <mark>, the
 * ranking of entries by group, and the platform-aware shortcut labels. The dialog itself is DOM code and is covered by
 * the e2e suite.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  SEARCH_LIMIT,
  SEARCH_MIN_CHARS,
  fuzzyMatch,
  matchTerms,
  rankEntries,
  searchRowVisible,
  segmentText,
  shortcutLabel,
  substringRanges,
  termRanges,
} from '../../public/js/ui/quick-switcher.js';

describe('fuzzyMatch', () => {
  it('matches the letters in order, ignoring case, and reports where each one landed', () => {
    const match = fuzzyMatch('ssn', 'Session name');
    assert.ok(match);
    assert.deepEqual(match.ranges, [[0, 1], [2, 3], [6, 7]]);
  });

  it('returns null when a letter is missing or out of order', () => {
    assert.equal(fuzzyMatch('zz', 'abc'), null);
    assert.equal(fuzzyMatch('ba', 'ab'), null);
  });
});

describe('matchTerms', () => {
  it('matches every whitespace-separated term as a substring', () => {
    const match = matchTerms('new sess', 'New session');
    assert.ok(match);
    assert.deepEqual(match.ranges, [[0, 3], [4, 8]]);
    assert.ok(match.score > 0);
  });

  it('rejects the text when any term is missing', () => {
    assert.equal(matchTerms('new xyz', 'New session'), null);
  });
});

describe('substringRanges and segmentText', () => {
  it('finds every case-insensitive occurrence of the query', () => {
    assert.deepEqual(substringRanges('Hello hello', 'hel'), [[0, 3], [6, 9]]);
    assert.deepEqual(substringRanges('abc', ''), []);
  });

  it('splits text into hit and non-hit segments that cover the whole text', () => {
    assert.deepEqual(segmentText('Hello hello', [[0, 5]]), [
      { text: 'Hello', hit: true },
      { text: ' hello', hit: false },
    ]);
    assert.deepEqual(segmentText('plain', []), [{ text: 'plain', hit: false }]);
  });
});

describe('termRanges', () => {
  it('marks every word of the query wherever it appears, merged and in order', () => {
    assert.deepEqual(termRanges('Sidebar search and search', 'search sidebar'), [[0, 7], [8, 14], [19, 25]]);
    assert.deepEqual(termRanges('abcdef', 'bcd cde'), [[1, 5]]);
    assert.deepEqual(termRanges('nothing here', '   '), []);
  });
});

describe('searchRowVisible', () => {
  it('shows the deep search row from the second character on', () => {
    assert.equal(SEARCH_MIN_CHARS, 2);
    assert.equal(searchRowVisible('a'), false);
    assert.equal(searchRowVisible(' a '), false);
    assert.equal(searchRowVisible('ab'), true);
  });

  it('caps a search at a fixed number of results', () => {
    assert.equal(SEARCH_LIMIT, 20);
  });
});

describe('rankEntries', () => {
  const entries = [
    { id: 's1', group: 'sessions', label: 'Refactor auth' },
    { id: 's2', group: 'sessions', label: 'Session notes' },
    { id: 'p1', group: 'panels', label: 'Session' },
    { id: 'c1', group: 'commands', label: 'New session' },
  ];

  it('keeps the groups in order: sessions, then panels, then commands', () => {
    const ids = rankEntries('', entries).map((entry) => entry.id);
    assert.deepEqual(ids, ['s1', 's2', 'p1', 'c1']);
  });

  it('keeps only matching entries, best match first within a group, and marks the label ranges', () => {
    const ranked = rankEntries('ses', entries);
    assert.deepEqual(ranked.map((entry) => entry.id), ['s2', 'p1', 'c1']);
    assert.ok(ranked[0].labelRanges.length > 0);
  });

  it('finds nothing for a query that matches no label or detail', () => {
    assert.deepEqual(rankEntries('qqqq', entries), []);
  });
});

describe('shortcutLabel', () => {
  it('uses the Command symbols on Apple platforms', () => {
    assert.equal(shortcutLabel('k', { apple: true }), '⌘K');
    assert.equal(shortcutLabel('o', { shift: true, apple: true }), '⌘⇧O');
  });

  it('spells the Control modifier out elsewhere', () => {
    assert.equal(shortcutLabel('k', { apple: false }), 'Ctrl+K');
    assert.equal(shortcutLabel('o', { shift: true, apple: false }), 'Ctrl+Shift+O');
  });
});
