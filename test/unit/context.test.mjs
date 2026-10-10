import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  compactingStart, compactionText, elapsedSeconds, formatSeconds, formatTokenCount, lastCompactionDetails, meterTone,
  meterTooltip, meterView, sessionCompactingStart,
} from '../../public/js/context.js';
import { setLocale, t } from '../../public/js/i18n.js';
import '../../public/js/locales/en.cards.js';
import '../../public/js/locales/zh-CN.cards.js';
import '../../public/js/locales/en.composer.js';
import '../../public/js/locales/zh-CN.composer.js';
import '../../public/js/locales/en.core.js';
import '../../public/js/locales/zh-CN.core.js';

/** A LiveInfo.context with the sample figures: a 100 000-token window, automatic compaction at 67 000. */
const meter = (overrides = {}) => ({
  used: 38_416,
  max: 100_000,
  autoCompactAt: 67_000,
  autoCompact: true,
  source: 'stream',
  compacting: null,
  lastCompaction: null,
  ...overrides,
});

/** The meter view of a context, for the tooltip tests. */
const viewOf = (overrides) => meterView(meter(overrides));

describe('meterView', () => {
  test('is null while the window size or the used tokens are unknown', () => {
    assert.equal(meterView(null), null);
    assert.equal(meterView(undefined), null);
    assert.equal(meterView(meter({ used: null })), null);
    assert.equal(meterView(meter({ max: null })), null);
    assert.equal(meterView(meter({ max: 0 })), null);
  });

  test('gives the share of the window in use, and the fill the ring draws', () => {
    const view = meterView(meter());
    assert.equal(Math.round(view.percent), 38);
    assert.equal(view.fill, view.percent);
    assert.equal(meterView(meter({ used: 103_509 })).percent > 100, true, 'the real share may pass 100');
    assert.equal(meterView(meter({ used: 103_509 })).fill, 100, 'the ring stops at a full circle');
  });

  test('places the tick where automatic compaction starts, and none when it is off', () => {
    assert.equal(meterView(meter()).tickPercent, 67);
    assert.equal(meterView(meter({ autoCompactAt: null, autoCompact: false })).tickPercent, null);
    const past = meterView(meter({ autoCompactAt: 120_000 })).tickPercent;
    assert.equal(past, null, 'a point past the window has no tick');
  });

  test('reports whether automatic compaction is on, and whether a compaction runs', () => {
    assert.equal(meterView(meter({ autoCompactAt: null, autoCompact: false })).autoCompact, false);
    assert.equal(meterView(meter({ autoCompact: null })).autoCompact, null);
    assert.equal(meterView(meter({ compacting: { since: 1, trigger: 'auto' } })).compacting, true);
    assert.equal(meterView(meter()).compacting, false);
  });
});

describe('meterTone', () => {
  test('is normal below 85 % of the auto-compact point, attention from there', () => {
    assert.equal(meterTone(56_949, 100_000, 67_000), 'normal');
    assert.equal(meterTone(56_950, 100_000, 67_000), 'attention');
    assert.equal(meterTone(66_000, 100_000, 67_000), 'attention');
  });

  test('is danger from 95 % of the window, whatever the auto-compact point', () => {
    assert.equal(meterTone(94_999, 100_000, 67_000), 'attention');
    assert.equal(meterTone(95_000, 100_000, 67_000), 'danger');
    assert.equal(meterTone(103_509, 100_000, null), 'danger');
  });

  test('measures attention against the window when automatic compaction is off', () => {
    assert.equal(meterTone(84_999, 100_000, null), 'normal');
    assert.equal(meterTone(85_000, 100_000, null), 'attention');
  });
});

describe('meterTooltip', () => {
  test('gives the figures and the automatic point in English', () => {
    setLocale('en');
    const text = meterTooltip(viewOf(), { t, locale: 'en' });
    assert.equal(text, '38,416 of 100,000 tokens (38%). Compacts automatically at 67,000.');
  });

  test('says when automatic compaction is off', () => {
    setLocale('en');
    const text = meterTooltip(viewOf({ autoCompactAt: null, autoCompact: false }), { t, locale: 'en' });
    assert.equal(text, '38,416 of 100,000 tokens (38%). Automatic compaction is off.');
  });

  test('says what runs while a compaction runs, in place of the automatic point', () => {
    setLocale('en');
    const text = meterTooltip(viewOf({ compacting: { since: 1, trigger: null } }), { t, locale: 'en' });
    assert.equal(text, '38,416 of 100,000 tokens (38%). Compacting the conversation…');
  });

  test('adds no sentence about compaction when the session does not say whether it is on', () => {
    setLocale('en');
    const text = meterTooltip(viewOf({ autoCompactAt: null, autoCompact: null }), { t, locale: 'en' });
    assert.equal(text, '38,416 of 100,000 tokens (38%).');
  });

  test('reads the same figures in Chinese, with digit grouping and the full-width punctuation', () => {
    setLocale('zh-CN');
    try {
      assert.equal(meterTooltip(viewOf(), { t, locale: 'zh-CN' }),
        '已用 38,416 / 100,000 个 token（38%）。达到 67,000 时自动压缩。');
      assert.equal(meterTooltip(viewOf({ autoCompactAt: null, autoCompact: false }), { t, locale: 'zh-CN' }),
        '已用 38,416 / 100,000 个 token（38%）。自动压缩已关闭。');
      assert.equal(meterTooltip(viewOf({ compacting: { since: 1, trigger: null } }), { t, locale: 'zh-CN' }),
        '已用 38,416 / 100,000 个 token（38%）。正在压缩对话…');
    } finally {
      setLocale('en');
    }
  });
});

describe('formatting of token counts and seconds', () => {
  test('counts keep one decimal in thousands and millions, as the divider shows them', () => {
    assert.equal(formatTokenCount(980), '980');
    assert.equal(formatTokenCount(1960), '2.0k');
    assert.equal(formatTokenCount(2069), '2.1k');
    assert.equal(formatTokenCount(39_200), '39.2k');
    assert.equal(formatTokenCount(103_509), '103.5k');
    assert.equal(formatTokenCount(999_960), '1.0M', 'the thousands never read as 1000.0k');
    assert.equal(formatTokenCount(1_500_000), '1.5M');
    assert.equal(formatTokenCount(-5), '0');
    assert.equal(formatTokenCount(Number.NaN), '0');
  });

  test('a duration in seconds keeps one decimal: 10515 ms is 10.5', () => {
    assert.equal(formatSeconds(10_515), '10.5');
    assert.equal(formatSeconds(6_765), '6.8');
    assert.equal(formatSeconds(3_000), '3.0');
    assert.equal(formatSeconds(undefined), '0.0');
  });

  test('the running line counts whole seconds since the start, and never goes negative', () => {
    assert.equal(elapsedSeconds(1000, 13_400), 12);
    assert.equal(elapsedSeconds(1000, 1999), 0);
    assert.equal(elapsedSeconds(5000, 1000), 0);
    assert.equal(elapsedSeconds(Number.NaN, 1000), 0);
  });

  test('a start that is not known counts nothing, rather than the time since the epoch', () => {
    assert.equal(elapsedSeconds(null, 1_000_000), 0);
    assert.equal(elapsedSeconds(undefined, 1_000_000), 0);
  });
});

describe('compactionText', () => {
  const automatic = { trigger: 'auto', preTokens: 103_509, postTokens: 2069, durationMs: 10_515 };

  test('states the sizes and the time of an automatic compaction in English', () => {
    setLocale('en');
    assert.equal(compactionText(automatic, t, 'en'),
      'Compacted automatically: 103.5k tokens summarized into 2.1k in 10.5 s');
  });

  test('names a /compact that the user started', () => {
    setLocale('en');
    const manual = { trigger: 'manual', preTokens: 39_200, postTokens: 1960, durationMs: 6765 };
    assert.equal(compactionText(manual, t, 'en'),
      'Compacted with /compact: 39.2k tokens summarized into 2.0k in 6.8 s');
  });

  test('drops the parts that are missing', () => {
    setLocale('en');
    assert.equal(compactionText({ ...automatic, postTokens: null }, t, 'en'),
      'Compacted automatically from 103.5k tokens in 10.5 s');
    assert.equal(compactionText({ ...automatic, postTokens: null, durationMs: null }, t, 'en'),
      'Compacted automatically from 103.5k tokens');
    assert.equal(compactionText({ ...automatic, durationMs: null }, t, 'en'),
      'Compacted automatically: 103.5k tokens summarized into 2.1k');
    assert.equal(compactionText({ ...automatic, preTokens: null, postTokens: null }, t, 'en'),
      'Compacted automatically in 10.5 s');
    assert.equal(compactionText({ ...automatic, preTokens: null, postTokens: 2069 }, t, 'en'),
      'Compacted automatically into a summary of 2.1k tokens in 10.5 s');
    assert.equal(compactionText({ trigger: 'auto', preTokens: null, postTokens: null, durationMs: null }, t, 'en'),
      'Compacted automatically');
  });

  test('names a compaction whose trigger is not known as a plain context compaction', () => {
    setLocale('en');
    assert.equal(compactionText({ ...automatic, trigger: null }, t, 'en'),
      'Context compacted: 103.5k tokens summarized into 2.1k in 10.5 s');
  });

  test('reads the same sizes in Chinese, with the full-width colon and comma', () => {
    setLocale('zh-CN');
    try {
      assert.equal(compactionText(automatic, t, 'zh-CN'), '已自动压缩：103.5k 个 token 总结为 2.1k，用时 10.5 秒');
      const manual = { trigger: 'manual', preTokens: 39_200, postTokens: 1960, durationMs: 6765 };
      assert.equal(compactionText(manual, t, 'zh-CN'),
        '已通过 /compact 压缩：39.2k 个 token 总结为 2.0k，用时 6.8 秒');
      assert.equal(compactionText({ ...automatic, postTokens: null }, t, 'zh-CN'),
        '已自动压缩，压缩前 103.5k 个 token，用时 10.5 秒');
      assert.equal(compactionText({ ...automatic, preTokens: null, postTokens: null }, t, 'zh-CN'),
        '已自动压缩，用时 10.5 秒');
    } finally {
      setLocale('en');
    }
  });
});

describe('lastCompactionDetails', () => {
  const sizes = { trigger: 'auto', preTokens: 103_509, postTokens: 2069, durationMs: 10_515 };
  const last = { ...sizes, at: 1 };
  /** A compact divider a transcript summary added: it names no sizes. */
  const plain = {
    kind: 'divider', key: 'dv:plain', variant: 'compact', trigger: null, preTokens: null, postTokens: null,
    durationMs: null,
  };
  /** A compact divider with its own sizes, as a boundary leaves it. */
  const sized = {
    kind: 'divider', key: 'dv:sized', variant: 'compact', trigger: 'manual', preTokens: 39_200, postTokens: 1960,
    durationMs: 6765,
  };
  /** The sizes the session's last compaction gives to a timeline of these entries (lastCompactionDetails). */
  const reported = (entries) => lastCompactionDetails(meter({ lastCompaction: last }), entries);

  test('gives the session\'s last compaction to a last compact divider that has no sizes', () => {
    assert.deepEqual(reported([{ kind: 'user' }, plain]), { key: 'dv:plain', details: sizes });
  });

  test('keeps the sizes the session has no figure for as null', () => {
    const partial = meter({ lastCompaction: { ...last, postTokens: null, durationMs: null } });
    assert.deepEqual(lastCompactionDetails(partial, [plain]).details,
      { trigger: 'auto', preTokens: 103_509, postTokens: null, durationMs: null });
  });

  test('looks past the other dividers, which do not count as compactions', () => {
    const clear = { kind: 'divider', key: 'dv:clear', variant: 'clear', preTokens: null, trigger: null };
    const running = { kind: 'divider', key: 'cmp:1', variant: 'compacting', since: 5 };
    assert.equal(reported([plain, clear, running]).key, 'dv:plain');
  });

  test('gives nothing when the last compact divider already has its sizes', () => {
    assert.equal(reported([sized]), null);
  });

  test('does not give an older plain divider the sizes of a later one', () => {
    assert.equal(reported([plain, sized]), null);
  });

  test('gives nothing when the session reports no compaction, or the timeline shows no compact divider', () => {
    assert.equal(lastCompactionDetails(meter(), [plain]), null);
    assert.equal(lastCompactionDetails(null, [plain]), null);
    assert.equal(reported([{ kind: 'user' }]), null);
  });
});

describe('sessionCompactingStart', () => {
  test('converts the gateway\'s start into this browser\'s clock with the offset between the two', () => {
    const context = meter({ compacting: { since: 10_000, trigger: 'auto' } });
    assert.equal(sessionCompactingStart(context, 2_000), 8_000, 'the gateway clock runs 2 s ahead');
    assert.equal(sessionCompactingStart(context, 0), 10_000);
    assert.equal(sessionCompactingStart(context, -500), 10_500);
  });

  test('is null while no compaction runs, or when its start is not known', () => {
    assert.equal(sessionCompactingStart(meter(), 0), null);
    assert.equal(sessionCompactingStart(meter({ compacting: { since: null, trigger: null } }), 0), null);
    assert.equal(sessionCompactingStart(null, 0), null);
  });

  test('counts the running compaction from the converted start, after a reload', () => {
    // The gateway started the compaction at its 15 000 ms, which this browser reads as 12 000 ms. At 17 000 ms it
    // has run for 5 s.
    const start = sessionCompactingStart(meter({ compacting: { since: 15_000, trigger: null } }), 3_000);
    assert.equal(start, 12_000);
    assert.equal(elapsedSeconds(start, 17_000), 5);
  });
});

describe('compactingStart', () => {
  test('is the timeline row\'s start when the row exists', () => {
    assert.equal(compactingStart(5000, 9000), 5000);
  });

  test('falls back to the session\'s start after a reload, when the timeline has no row', () => {
    assert.equal(compactingStart(null, 9000), 9000);
    assert.equal(compactingStart(undefined, 9000), 9000);
  });

  test('is null when neither names a start', () => {
    assert.equal(compactingStart(null, null), null);
    assert.equal(compactingStart(Number.NaN, undefined), null);
  });
});

describe('the catalogs cover the keys these modules use', () => {
  const sources = [
    '../../public/js/context.js',
    '../../public/js/timeline/view.js',
    '../../public/js/ui/header.js',
    '../../public/js/ui/activity.js',
    '../../public/js/ui/panels.js',
  ];
  /** @param {string} file a catalog, relative to this file @returns {Set<string>} the keys it defines */
  const catalogKeys = (file) => new Set([...readFileSync(new URL(file, import.meta.url), 'utf8')
    .matchAll(/^\s*'([^']+)'\s*:/gm)].map((match) => match[1]));
  const used = new Set(sources.flatMap((file) => [...readFileSync(new URL(file, import.meta.url), 'utf8')
    .matchAll(/'((?:cards|composer|header|shell)\.(?:compacting|divider|context|activity)[\w.]*)'/g)]
    .map((match) => match[1])));

  test('define every key used for the meter, the compaction and the running line in both languages', () => {
    const en = [
      '../../public/js/locales/en.cards.js',
      '../../public/js/locales/en.composer.js',
      '../../public/js/locales/en.core.js',
    ].flatMap((file) => [...catalogKeys(file)]);
    const zh = [
      '../../public/js/locales/zh-CN.cards.js',
      '../../public/js/locales/zh-CN.composer.js',
      '../../public/js/locales/zh-CN.core.js',
    ].flatMap((file) => [...catalogKeys(file)]);
    const missing = [];
    for (const key of used) {
      if (!en.includes(key)) missing.push(`en: ${key}`);
      if (!zh.includes(key)) missing.push(`zh-CN: ${key}`);
    }
    assert.ok(used.size > 20, `expected the keys of these modules, found ${used.size}`);
    assert.deepEqual(missing, []);
  });
});
