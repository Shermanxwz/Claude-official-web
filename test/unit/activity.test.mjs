import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { formatElapsed, todoSummary } from '../../public/js/ui/activity.js';

describe('formatElapsed', () => {
  test('counts whole seconds below a minute', () => {
    assert.equal(formatElapsed(0), '0s');
    assert.equal(formatElapsed(999), '0s');
    assert.equal(formatElapsed(1000), '1s');
    assert.equal(formatElapsed(59_999), '59s');
  });

  test('shows minutes with two-digit seconds below an hour', () => {
    assert.equal(formatElapsed(60_000), '1m 00s');
    assert.equal(formatElapsed(61_000), '1m 01s');
    assert.equal(formatElapsed(3_599_000), '59m 59s');
  });

  test('shows hours with two-digit minutes from an hour on', () => {
    assert.equal(formatElapsed(3_600_000), '1h 00m');
    assert.equal(formatElapsed(7_260_000), '2h 01m');
  });

  test('treats a missing, negative or infinite duration as zero', () => {
    assert.equal(formatElapsed(undefined), '0s');
    assert.equal(formatElapsed(NaN), '0s');
    assert.equal(formatElapsed(-5_000), '0s');
    assert.equal(formatElapsed(Infinity), '0s');
  });
});

describe('todoSummary', () => {
  test('is empty for no todos or a value that is not a list', () => {
    assert.deepEqual(todoSummary([]), { total: 0, done: 0, active: null, allDone: false });
    assert.deepEqual(todoSummary(undefined), { total: 0, done: 0, active: null, allDone: false });
  });

  test('counts completed todos and names the one in progress by its present form', () => {
    const summary = todoSummary([
      { status: 'completed', content: 'Read the code' },
      { status: 'in_progress', content: 'Run the tests', activeForm: 'Running the tests' },
      { status: 'pending', content: 'Ship' },
    ]);
    assert.deepEqual(summary, { total: 3, done: 1, active: 'Running the tests', allDone: false });
  });

  test('falls back to the content when the present form is empty', () => {
    const summary = todoSummary([{ status: 'in_progress', content: 'Fix the bug', activeForm: '' }]);
    assert.equal(summary.active, 'Fix the bug');
  });

  test('reports all done only when every todo is completed', () => {
    assert.deepEqual(todoSummary([{ status: 'completed' }, { status: 'completed' }]), {
      total: 2, done: 2, active: null, allDone: true,
    });
  });
});
