import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDuration,
  formatTokens,
  formatBytes,
  relativeTime,
  truncateMiddle,
  stripAnsi,
} from '../../public/js/timeline/format.js';

test('formatDuration renders milliseconds, seconds, minutes and hours', () => {
  assert.equal(formatDuration(0), '0 ms');
  assert.equal(formatDuration(850), '850 ms');
  assert.equal(formatDuration(2400), '2.4 s');
  assert.equal(formatDuration(15000), '15 s');
  assert.equal(formatDuration(75000), '1m 15s');
  assert.equal(formatDuration(3_700_000), '1h 1m');
});

test('formatDuration tolerates invalid input', () => {
  assert.equal(formatDuration(NaN), '0 ms');
  assert.equal(formatDuration(-5), '0 ms');
  assert.equal(formatDuration(undefined), '0 ms');
  assert.equal(formatDuration('abc'), '0 ms');
});

test('formatTokens uses compact k and M suffixes', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(980), '980');
  assert.equal(formatTokens(1000), '1k');
  assert.equal(formatTokens(12300), '12.3k');
  assert.equal(formatTokens(123400), '123k');
  assert.equal(formatTokens(999000), '999k');
  assert.equal(formatTokens(999960), '1M');
  assert.equal(formatTokens(1_500_000), '1.5M');
  assert.equal(formatTokens(-3), '0');
  assert.equal(formatTokens(Infinity), '0');
});

test('formatBytes scales through B, KB, MB, GB and TB', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatBytes(20 * 1024 * 1024), '20 MB');
  assert.equal(formatBytes(3 * 1024 ** 3), '3.0 GB');
  assert.equal(formatBytes(2 * 1024 ** 5), '2048 TB');
  assert.equal(formatBytes(NaN), '0 B');
});

test('relativeTime formats past and future offsets per locale', () => {
  const now = Date.UTC(2026, 9, 9, 12, 0, 0);
  assert.equal(relativeTime(now - 3 * 60_000, 'en', now), '3 minutes ago');
  assert.equal(relativeTime(now + 2 * 3600_000, 'en', now), 'in 2 hours');
  assert.equal(relativeTime(now - 1 * 86_400_000, 'en', now), 'yesterday');
  assert.equal(relativeTime(now - 3 * 60_000, 'zh-CN', now), '3分钟前');
  assert.equal(relativeTime(new Date(now - 30_000), 'en', now), '30 seconds ago');
  assert.equal(relativeTime(new Date(now).toISOString(), 'en', now), 'now');
});

test('relativeTime returns an empty string for invalid timestamps', () => {
  assert.equal(relativeTime(NaN, 'en'), '');
  assert.equal(relativeTime('not a date', 'en'), '');
  assert.equal(relativeTime(undefined, 'en'), '');
});

test('truncateMiddle keeps head and tail and never splits code points', () => {
  assert.equal(truncateMiddle('short', 10), 'short');
  assert.equal(truncateMiddle('abcdefghijklmnop', 8), 'abcd…nop');
  assert.equal(truncateMiddle('abcdefghijklmnop', 8).length, 8);
  assert.equal(truncateMiddle('\u{1F600}\u{1F600}\u{1F600}\u{1F600}', 3), '\u{1F600}\u{1F600}\u{1F600}');
  assert.equal(truncateMiddle('abc', 0), '');
  assert.equal(truncateMiddle(null, 5), '');
  const emoji = Array.from('\u{1F600}'.repeat(10));
  const cut = truncateMiddle(emoji.join(''), 5);
  assert.equal(Array.from(cut).length, 5);
});

test('stripAnsi removes colors, cursor sequences and OSC hyperlinks', () => {
  assert.equal(stripAnsi('\u001b[31mred\u001b[0m text'), 'red text');
  assert.equal(stripAnsi('\u001b[2K\u001b[1Gline'), 'line');
  assert.equal(stripAnsi('\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007'), 'link');
  assert.equal(stripAnsi('plain'), 'plain');
  assert.equal(stripAnsi(undefined), '');
});
