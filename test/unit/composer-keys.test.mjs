import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HISTORY_IDLE,
  historyKeyAction,
  keyDecision,
  promptHistory,
  stepHistory,
} from '../../public/js/ui/composer-logic.js';

const idle = { paletteOpen: false, browsing: false, running: false, blocked: false, text: '', caret: 0 };

describe('historyKeyAction', () => {
  test('walks back from the first line of an empty field', () => {
    assert.equal(historyKeyAction({ key: 'ArrowUp' }, { text: '', caret: 0, browsing: false }), 'prev');
  });

  test('does not walk back from a typed prompt unless a recalled prompt is showing', () => {
    assert.equal(historyKeyAction({ key: 'ArrowUp' }, { text: 'one line', caret: 4, browsing: false }), null);
    assert.equal(historyKeyAction({ key: 'ArrowUp' }, { text: 'a\nb', caret: 0, browsing: true }), 'prev');
  });

  test('walks back only from the first line of a recalled prompt', () => {
    assert.equal(historyKeyAction({ key: 'ArrowUp' }, { text: 'a\nb', caret: 3, browsing: true }), null);
  });

  test('walks forward from the last line of a recalled prompt only', () => {
    assert.equal(historyKeyAction({ key: 'ArrowDown' }, { text: 'a\nb', caret: 2, browsing: true }), 'next');
    assert.equal(historyKeyAction({ key: 'ArrowDown' }, { text: 'a\nb', caret: 1, browsing: true }), null);
    assert.equal(historyKeyAction({ key: 'ArrowDown' }, { text: '', caret: 0, browsing: false }), null);
  });

  test('never walks with a modifier key, another key or no event', () => {
    assert.equal(historyKeyAction({ key: 'ArrowUp', shiftKey: true }, { text: '', caret: 0, browsing: false }), null);
    assert.equal(historyKeyAction({ key: 'ArrowUp', metaKey: true }, { text: '', caret: 0, browsing: false }), null);
    assert.equal(historyKeyAction({ key: 'a' }, { text: '', caret: 0, browsing: true }), null);
    assert.equal(historyKeyAction(null, { text: '', caret: 0, browsing: true }), null);
  });

  test('clamps a caret outside the text', () => {
    assert.equal(historyKeyAction({ key: 'ArrowUp' }, { text: '', caret: 9, browsing: false }), 'prev');
  });
});

describe('stepHistory', () => {
  const entries = ['third', 'second', 'first'];

  test('going back remembers the draft and walks to older prompts, stopping at the oldest', () => {
    const one = stepHistory(HISTORY_IDLE, 'prev', entries, 'typing');
    assert.deepEqual(one, { state: { index: 0, draft: 'typing' }, text: 'third' });
    const two = stepHistory(one.state, 'prev', entries, 'third');
    assert.deepEqual(two, { state: { index: 1, draft: 'typing' }, text: 'second' });
    const three = stepHistory(two.state, 'prev', entries, 'second');
    const four = stepHistory(three.state, 'prev', entries, 'first');
    assert.equal(four.text, 'first');
    const clamped = stepHistory(four.state, 'prev', entries, 'first');
    assert.deepEqual(clamped, { state: { index: 2, draft: 'typing' }, text: 'first' });
  });

  test('going forward walks back toward newer prompts and restores the draft past the newest', () => {
    const state = { index: 1, draft: 'typing' };
    assert.deepEqual(stepHistory(state, 'next', entries, 'second'), {
      state: { index: 0, draft: 'typing' }, text: 'third',
    });
    const restored = stepHistory({ index: 0, draft: 'typing' }, 'next', entries, 'third');
    assert.deepEqual(restored, { state: { index: -1, draft: '' }, text: 'typing' });
  });

  test('does nothing forward while the field holds the user\'s own text, or with no history', () => {
    assert.equal(stepHistory(HISTORY_IDLE, 'next', entries, 'x'), null);
    assert.equal(stepHistory(HISTORY_IDLE, 'prev', [], 'x'), null);
    assert.equal(stepHistory(HISTORY_IDLE, 'sideways', entries, 'x'), null);
  });
});

describe('promptHistory', () => {
  test('lists the transcript newest first without repeating the entry before it', () => {
    assert.deepEqual(promptHistory(['a', 'b', 'b', 'c'], []), ['c', 'b', 'a']);
  });

  test('adds prompts sent from this page that the transcript does not show yet, as the newest', () => {
    assert.deepEqual(promptHistory(['a'], ['b']), ['b', 'a']);
  });

  test('does not repeat a sent prompt the transcript already shows', () => {
    assert.deepEqual(promptHistory(['a', 'b'], ['b']), ['b', 'a']);
  });

  test('drops blank entries and tolerates missing lists', () => {
    assert.deepEqual(promptHistory(['', '  ', 'x'], []), ['x']);
    assert.deepEqual(promptHistory(undefined, undefined), []);
  });
});

describe('keyDecision', () => {
  test('Shift+Tab cycles the mode before anything else, even with the palette open', () => {
    assert.equal(keyDecision({ key: 'Tab', shiftKey: true }, { ...idle, paletteOpen: true }), 'mode-cycle');
  });

  test('leaves every key to the palette while it is open', () => {
    assert.equal(keyDecision({ key: 'Escape' }, { ...idle, paletteOpen: true }), null);
    assert.equal(keyDecision({ key: 'ArrowUp' }, { ...idle, paletteOpen: true, text: '', caret: 0 }), null);
  });

  test('Escape is the composer\'s own decision when no palette is open', () => {
    assert.equal(keyDecision({ key: 'Escape' }, { ...idle, running: true }), 'escape');
    assert.equal(keyDecision({ key: 'Escape' }, idle), 'escape');
  });

  test('arrows walk the history when the walk applies', () => {
    assert.equal(keyDecision({ key: 'ArrowUp' }, { ...idle, text: '', caret: 0 }), 'history-prev');
    assert.equal(keyDecision({ key: 'ArrowDown' }, { ...idle, text: 'a\nb', caret: 2, browsing: true }), 'history-next');
    assert.equal(keyDecision({ key: 'ArrowUp' }, { ...idle, text: 'typed', caret: 5 }), null);
  });

  test('other keys are left to the field', () => {
    assert.equal(keyDecision({ key: 'Enter' }, idle), null);
    assert.equal(keyDecision(null, idle), null);
  });
});
