import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCompletion,
  detectTrigger,
  draftKey,
  effortLevelsFor,
  effortModelFor,
  filterCommands,
  findModelInfo,
  formatBytes,
  isSendShortcut,
  mergeCommands,
  modelSelectPlan,
} from '../../public/js/ui/composer-logic.js';

describe('detectTrigger', () => {
  test('opens the slash palette with an empty query right after a leading slash', () => {
    assert.deepEqual(detectTrigger('/', 1), { type: 'slash', query: '', start: 0 });
  });

  test('returns the slash query typed up to the caret', () => {
    assert.deepEqual(detectTrigger('/mo', 3), { type: 'slash', query: 'mo', start: 0 });
  });

  test('uses only the text before the caret for the slash query', () => {
    assert.deepEqual(detectTrigger('/mo', 1), { type: 'slash', query: '', start: 0 });
  });

  test('ignores a slash that is not the first character', () => {
    assert.equal(detectTrigger('ask /mo', 7), null);
    assert.equal(detectTrigger('a/b', 3), null);
  });

  test('closes the slash palette once a space is typed after the command name', () => {
    assert.equal(detectTrigger('/model now', 10), null);
    assert.equal(detectTrigger('/model ', 7), null);
  });

  test('opens the mention palette at the start of the text', () => {
    assert.deepEqual(detectTrigger('@', 1), { type: 'mention', query: '', start: 0 });
  });

  test('does not open the mention palette when the caret is before the @', () => {
    assert.equal(detectTrigger('@', 0), null);
  });

  test('opens the mention palette after a space and reports its start index', () => {
    assert.deepEqual(detectTrigger('hello @src', 10), { type: 'mention', query: 'src', start: 6 });
  });

  test('opens the mention palette after a newline', () => {
    assert.deepEqual(detectTrigger('a\n@file', 7), { type: 'mention', query: 'file', start: 2 });
  });

  test('opens the mention palette after a slash command that already has arguments', () => {
    assert.deepEqual(detectTrigger('/compact @sr', 12), { type: 'mention', query: 'sr', start: 9 });
  });

  test('ignores an @ inside a word such as an email address', () => {
    assert.equal(detectTrigger('email@x.com', 11), null);
    assert.equal(detectTrigger('foo @bar@baz', 12), null);
  });

  test('ignores a doubled @ because the first one is not at a token start', () => {
    assert.equal(detectTrigger('@@x', 3), null);
  });

  test('closes the mention palette once whitespace follows the query', () => {
    assert.equal(detectTrigger('hi @x ', 6), null);
  });

  test('honours a caret in the middle of the text', () => {
    assert.deepEqual(detectTrigger('x @abc def', 5), { type: 'mention', query: 'ab', start: 2 });
    assert.deepEqual(detectTrigger('/model', 3), { type: 'slash', query: 'mo', start: 0 });
  });

  test('clamps the caret to the text length and treats a non-finite caret as the end', () => {
    assert.deepEqual(detectTrigger('/mo', 99), { type: 'slash', query: 'mo', start: 0 });
    assert.deepEqual(detectTrigger('@ab', Number.NaN), { type: 'mention', query: 'ab', start: 0 });
    assert.equal(detectTrigger('/mo', -5), null);
  });

  test('returns null for a multi-line slash query and for non-string text', () => {
    assert.equal(detectTrigger('/mo\nmore', 8), null);
    assert.equal(detectTrigger(null, 0), null);
    assert.equal(detectTrigger(undefined, 0), null);
  });

  test('returns null when no trigger is present', () => {
    assert.equal(detectTrigger('plain text', 10), null);
    assert.equal(detectTrigger('', 0), null);
  });
});

describe('applyCompletion', () => {
  test('replaces a slash command and keeps the caret after the inserted text', () => {
    const trigger = { type: 'slash', query: 'mo', start: 0 };
    assert.deepEqual(applyCompletion('/mo', trigger, 3, '/model '), { text: '/model ', caret: 7 });
  });

  test('does not double a space when the text after the caret already starts with whitespace', () => {
    const trigger = { type: 'slash', query: 'mo', start: 0 };
    assert.deepEqual(applyCompletion('/mo tail', trigger, 3, '/model '), { text: '/model tail', caret: 6 });
  });

  test('replaces a mention in the middle of the text and keeps what follows', () => {
    const trigger = { type: 'mention', query: 'sr', start: 3 };
    assert.deepEqual(applyCompletion('hi @sr tail', trigger, 6, '@src/a.js '),
      { text: 'hi @src/a.js tail', caret: 12 });
  });

  test('keeps the trailing space when nothing follows the caret', () => {
    const trigger = { type: 'mention', query: '', start: 0 };
    assert.deepEqual(applyCompletion('@', trigger, 1, '@a.ts '), { text: '@a.ts ', caret: 6 });
  });

  test('clamps an out-of-range caret to the end of the text', () => {
    const trigger = { type: 'mention', query: 'a', start: 0 };
    assert.deepEqual(applyCompletion('@a', trigger, 50, '@x '), { text: '@x ', caret: 3 });
  });
});

describe('filterCommands', () => {
  const commands = [
    { name: 'compact', aliases: ['c'] },
    { name: 'context', aliases: [] },
    { name: 'cost', aliases: ['usage'] },
    { name: 'model', aliases: [] },
    { name: 'review', aliases: [] },
    { name: 'mcp', aliases: [] },
  ];

  test('keeps the given order and returns a copy for an empty query', () => {
    const result = filterCommands(commands, '');
    assert.deepEqual(result.map((c) => c.name), commands.map((c) => c.name));
    assert.notEqual(result, commands);
  });

  test('ranks name prefixes first and keeps the original order between equal scores', () => {
    assert.deepEqual(filterCommands(commands, 'co').map((c) => c.name), ['compact', 'context', 'cost']);
  });

  test('ranks name substrings after prefixes', () => {
    assert.deepEqual(filterCommands(commands, 'c').map((c) => c.name), ['compact', 'context', 'cost', 'mcp']);
  });

  test('matches aliases', () => {
    assert.deepEqual(filterCommands(commands, 'usage').map((c) => c.name), ['cost']);
  });

  test('puts an exact name match before a longer name that starts with the query', () => {
    const items = [{ name: 'mod', aliases: [] }, { name: 'model', aliases: [] }, { name: 'mode', aliases: [] }];
    assert.deepEqual(filterCommands(items, 'mode').map((c) => c.name), ['mode', 'model']);
  });

  test('ranks a name prefix above an alias prefix', () => {
    const items = [{ name: 'zz', aliases: ['rev'] }, { name: 'review', aliases: [] }];
    assert.deepEqual(filterCommands(items, 'rev').map((c) => c.name), ['review', 'zz']);
  });

  test('ranks a substring above a fuzzy match', () => {
    const items = [{ name: 'w-i-n-d', aliases: [] }, { name: 'rewind', aliases: [] }];
    assert.deepEqual(filterCommands(items, 'wind').map((c) => c.name), ['rewind', 'w-i-n-d']);
  });

  test('orders fuzzy matches by how tightly the characters cluster', () => {
    const items = [{ name: 'clear-tasks', aliases: [] }, { name: 'cat-tools', aliases: [] },
      { name: 'context', aliases: [] }];
    assert.deepEqual(filterCommands(items, 'ct').map((c) => c.name), ['cat-tools', 'context', 'clear-tasks']);
  });

  test('is case-insensitive and trims surrounding spaces', () => {
    assert.deepEqual(filterCommands([{ name: 'model', aliases: [] }], ' MODEL ').map((c) => c.name), ['model']);
  });

  test('returns an empty list when nothing matches or the items are not an array', () => {
    assert.deepEqual(filterCommands(commands, 'zzz'), []);
    assert.deepEqual(filterCommands(null, 'x'), []);
  });
});

describe('mergeCommands', () => {
  const sdk = [
    { name: 'compact', description: 'Compact', argumentHint: '[instructions]', aliases: ['c'] },
    { name: 'model', description: 'Switch model', builtin: true },
    { name: 'my-skill', description: 'Custom', argumentHint: '<file>' },
  ];
  const gui = [
    { id: 'model', name: 'model', description: 'Pick a model' },
    { id: 'rewind', name: 'rewind', description: 'Rewind' },
    { id: 'effort', name: 'effort', description: 'Effort' },
    { id: 'c-gui', name: 'c', description: 'Duplicate of an alias' },
  ];

  test('lists GUI commands first, then Claude Code commands in their original order', () => {
    const merged = mergeCommands(sdk, gui);
    assert.deepEqual(merged.map((c) => c.name), ['rewind', 'effort', 'compact', 'model', 'my-skill']);
  });

  test('drops GUI commands whose name is already a Claude Code command or alias', () => {
    const names = mergeCommands(sdk, gui).filter((c) => c.source === 'gui').map((c) => c.name);
    assert.deepEqual(names, ['rewind', 'effort']);
  });

  test('never lists the same name twice', () => {
    const merged = mergeCommands(sdk, gui);
    const lower = merged.map((c) => c.name.toLowerCase());
    assert.equal(new Set(lower).size, lower.length);
  });

  test('keeps Claude Code metadata and defaults missing fields', () => {
    const merged = mergeCommands(sdk, gui);
    const compact = merged.find((c) => c.name === 'compact');
    const model = merged.find((c) => c.name === 'model');
    const mySkill = merged.find((c) => c.name === 'my-skill');
    assert.equal(compact.source, 'sdk');
    assert.equal(compact.argumentHint, '[instructions]');
    assert.deepEqual(compact.aliases, ['c']);
    assert.equal(model.builtin, true);
    assert.equal(mySkill.builtin, false);
    assert.deepEqual(mySkill.aliases, []);
  });

  test('carries the GUI identifier on GUI rows', () => {
    const rewind = mergeCommands(sdk, gui).find((c) => c.name === 'rewind');
    assert.equal(rewind.source, 'gui');
    assert.equal(rewind.guiId, 'rewind');
  });

  test('treats names case-insensitively and compares aliases too', () => {
    const merged = mergeCommands([{ name: 'Model' }], [{ id: 'model', name: 'model' }]);
    assert.deepEqual(merged.map((c) => c.name), ['Model']);
    const aliased = mergeCommands([{ name: 'x', aliases: ['REW'] }], [{ id: 'rew', name: 'rew' }]);
    assert.deepEqual(aliased.map((c) => c.name), ['x']);
  });

  test('ignores malformed Claude Code entries', () => {
    assert.deepEqual(mergeCommands([null, { name: '' }, { description: 'no name' }, { name: 42 }], []), []);
  });

  test('returns GUI commands alone when the Claude Code list is missing', () => {
    const merged = mergeCommands(undefined, [{ id: 'a', name: 'alpha', description: 'A' }]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].name, 'alpha');
    assert.equal(merged[0].source, 'gui');
  });
});

describe('effortLevelsFor', () => {
  test('returns no levels for a missing model or one without effort support', () => {
    assert.deepEqual(effortLevelsFor(null), []);
    assert.deepEqual(effortLevelsFor(undefined), []);
    assert.deepEqual(effortLevelsFor({ supportsEffort: false, supportedEffortLevels: ['low'] }), []);
  });

  test('returns no levels when effort is supported but no level list is given', () => {
    assert.deepEqual(effortLevelsFor({ supportsEffort: true }), []);
    assert.deepEqual(effortLevelsFor({}), []);
  });

  test('returns the supported levels in canonical order', () => {
    assert.deepEqual(effortLevelsFor({ supportsEffort: true, supportedEffortLevels: ['max', 'low', 'high'] }),
      ['low', 'high', 'max']);
  });

  test('drops unknown level names', () => {
    assert.deepEqual(effortLevelsFor({ supportedEffortLevels: ['bogus', 'medium'] }), ['medium']);
  });
});

const MODELS = [
  { value: 'default', resolvedModel: 'claude-sonnet-4-5-20250929', displayName: 'Default (recommended)',
    description: 'Account default' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-4-5-20250929', displayName: 'Sonnet', description: 'Balanced',
    supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
  { value: 'opus', resolvedModel: 'claude-opus-4-1-20250805', displayName: 'Opus', description: 'Most capable',
    supportsEffort: true, supportedEffortLevels: ['low', 'high', 'max'] },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku' },
];
const LABELS = { defaultLabel: 'Account default', currentLabel: (id) => `Current: ${id}` };

describe('findModelInfo', () => {
  test('matches an alias by value, ignoring case and surrounding spaces', () => {
    assert.equal(findModelInfo(MODELS, 'Opus').value, 'opus');
    assert.equal(findModelInfo(MODELS, '  haiku ').value, 'haiku');
  });

  test('maps a concrete id to the alias that resolves to it, preferring the named alias over default', () => {
    assert.equal(findModelInfo(MODELS, 'claude-sonnet-4-5-20250929').value, 'sonnet');
  });

  test('matches resolvedModel case-insensitively', () => {
    assert.equal(findModelInfo(MODELS, 'CLAUDE-OPUS-4-1-20250805').value, 'opus');
  });

  test('treats an id that extends resolvedModel at a suffix boundary as that model', () => {
    assert.equal(findModelInfo(MODELS, 'claude-sonnet-4-5-20250929[1m]').value, 'sonnet');
    assert.equal(findModelInfo(MODELS, 'claude-opus-4-1-20250805@vertex').value, 'opus');
  });

  test('does not match a resolvedModel that is only a partial run of digits', () => {
    const models = [{ value: 'sonnet', resolvedModel: 'claude-sonnet-4-5' }];
    assert.equal(findModelInfo(models, 'claude-sonnet-4-50'), null);
    assert.equal(findModelInfo(models, 'claude-sonnet-4-5-20250929').value, 'sonnet');
  });

  test('prefers the longest resolvedModel when several are prefixes of the id', () => {
    const models = [
      { value: 'sonnet', resolvedModel: 'claude-sonnet-4-5' },
      { value: 'sonnet-dated', resolvedModel: 'claude-sonnet-4-5-20250929' },
    ];
    assert.equal(findModelInfo(models, 'claude-sonnet-4-5-20250929-beta').value, 'sonnet-dated');
  });

  test('prefers a value match over a resolvedModel match', () => {
    const models = [
      { value: 'sonnet', resolvedModel: 'claude-x' },
      { value: 'other', resolvedModel: 'sonnet' },
    ];
    assert.equal(findModelInfo(models, 'sonnet').value, 'sonnet');
  });

  test('returns null for an empty key, an unknown id or a missing list', () => {
    assert.equal(findModelInfo(MODELS, null), null);
    assert.equal(findModelInfo(MODELS, '   '), null);
    assert.equal(findModelInfo(MODELS, 'gpt-4o'), null);
    assert.equal(findModelInfo(null, 'sonnet'), null);
  });

  test('skips malformed rows', () => {
    const models = [null, { value: 3 }, { value: 'opus', resolvedModel: 'claude-opus-4-1-20250805' }];
    assert.equal(findModelInfo(models, 'opus').value, 'opus');
    assert.equal(findModelInfo(models, 'claude-opus-4-1-20250805').value, 'opus');
  });
});

describe('modelSelectPlan', () => {
  test('lists the account default first, then each model, and selects the row a concrete id resolves to', () => {
    const plan = modelSelectPlan(MODELS, 'claude-sonnet-4-5-20250929', LABELS);
    assert.equal(plan.value, 'sonnet');
    assert.equal(plan.match.value, 'sonnet');
    assert.deepEqual(plan.options.map((option) => option.value), ['', 'default', 'sonnet', 'opus', 'haiku']);
    assert.deepEqual(plan.options[0], { value: '', label: 'Account default', title: '' });
  });

  test('uses display names and descriptions, falling back to the alias', () => {
    const plan = modelSelectPlan(MODELS, 'opus', LABELS);
    assert.deepEqual(plan.options[3], { value: 'opus', label: 'Opus', title: 'Most capable' });
    assert.deepEqual(plan.options[4], { value: 'haiku', label: 'Haiku', title: '' });
    const bare = modelSelectPlan([{ value: 'sonnet' }], 'sonnet', LABELS);
    assert.deepEqual(bare.options[1], { value: 'sonnet', label: 'sonnet', title: '' });
  });

  test('selects the account default when no model is set', () => {
    for (const current of [null, undefined, '', '   ']) {
      const plan = modelSelectPlan(MODELS, current, LABELS);
      assert.equal(plan.value, '');
      assert.equal(plan.match, null);
      assert.equal(plan.options.length, MODELS.length + 1);
      assert.equal(plan.options[0].value, '');
    }
  });

  test('adds an unlisted id as the first, selected option', () => {
    const plan = modelSelectPlan(MODELS, 'claude-mystery-1', LABELS);
    assert.equal(plan.value, 'claude-mystery-1');
    assert.equal(plan.match, null);
    assert.deepEqual(plan.options[0],
      { value: 'claude-mystery-1', label: 'Current: claude-mystery-1', title: 'claude-mystery-1' });
    assert.equal(plan.options[1].value, '');
  });

  test('always includes an option whose value is the selected value', () => {
    for (const current of [null, '', 'sonnet', 'SONNET', 'claude-sonnet-4-5-20250929', 'claude-mystery-1']) {
      const plan = modelSelectPlan(MODELS, current, LABELS);
      assert.ok(plan.options.some((option) => option.value === plan.value), `no option for ${current}`);
    }
  });

  test('drops rows without a value and keeps the raw id selectable when the list is empty', () => {
    const plan = modelSelectPlan([{ value: '' }, { displayName: 'Nameless' }, { value: 'opus' }], null, LABELS);
    assert.deepEqual(plan.options.map((option) => option.value), ['', 'opus']);
    const empty = modelSelectPlan([], 'claude-x', LABELS);
    assert.deepEqual(empty.options.map((option) => option.value), ['claude-x', '']);
    assert.equal(empty.value, 'claude-x');
  });
});

describe('effortModelFor', () => {
  test('uses the session model when one is set', () => {
    assert.equal(effortModelFor(MODELS, 'claude-opus-4-1-20250805', 'sonnet').value, 'opus');
    assert.equal(effortModelFor(MODELS, 'opus', 'sonnet').value, 'opus');
  });

  test('falls back to the account default when no session model is set', () => {
    assert.equal(effortModelFor(MODELS, null, 'sonnet').value, 'sonnet');
    assert.equal(effortModelFor(MODELS, '   ', 'opus').value, 'opus');
  });

  test('does not substitute the default for a session model that is not listed', () => {
    assert.equal(effortModelFor(MODELS, 'claude-mystery-1', 'sonnet'), null);
  });

  test('returns null when neither the session nor the account default is known', () => {
    assert.equal(effortModelFor(MODELS, null, null), null);
    assert.equal(effortModelFor(MODELS, undefined, undefined), null);
  });

  test('feeds effortLevelsFor so the effort levels follow the model in use', () => {
    const opus = effortModelFor(MODELS, 'claude-opus-4-1-20250805', 'sonnet');
    const fallback = effortModelFor(MODELS, null, 'sonnet');
    assert.deepEqual(effortLevelsFor(opus), ['low', 'high', 'max']);
    assert.deepEqual(effortLevelsFor(fallback), ['low', 'medium', 'high']);
    assert.deepEqual(effortLevelsFor(effortModelFor(MODELS, 'claude-mystery-1', 'sonnet')), []);
  });
});

describe('draftKey', () => {
  test('namespaces the draft by session id', () => {
    assert.equal(draftKey('8f1c2d3e-0000-4000-8000-000000000001'), 'caw.draft.8f1c2d3e-0000-4000-8000-000000000001');
  });

  test('returns null for ids that cannot be stored', () => {
    assert.equal(draftKey(''), null);
    assert.equal(draftKey(null), null);
    assert.equal(draftKey(undefined), null);
    assert.equal(draftKey(42), null);
  });
});

describe('formatBytes', () => {
  test('formats bytes without decimals', () => {
    assert.equal(formatBytes(1), '1 B');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1023), '1023 B');
  });

  test('uses one decimal below ten units and whole numbers from ten units up', () => {
    assert.equal(formatBytes(1024), '1.0 KB');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(10240), '10 KB');
    assert.equal(formatBytes(25 * 1024 * 1024), '25 MB');
    assert.equal(formatBytes(1.5 * 1024 * 1024 * 1024), '1.5 GB');
  });

  test('rolls over to the next unit when rounding would print 1024', () => {
    assert.equal(formatBytes(1023.6), '1.0 KB');
    assert.equal(formatBytes(1048575), '1.0 MB');
  });

  test('reaches terabytes and stops there', () => {
    assert.equal(formatBytes(1024 ** 4), '1.0 TB');
    assert.equal(formatBytes(1024 ** 5), '1024 TB');
  });

  test('treats zero, negative and non-finite values as zero bytes', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(-1), '0 B');
    assert.equal(formatBytes(Number.NaN), '0 B');
    assert.equal(formatBytes(Number.POSITIVE_INFINITY), '0 B');
  });
});

describe('isSendShortcut', () => {
  test('sends on a plain Enter for fine pointers', () => {
    assert.equal(isSendShortcut({ key: 'Enter' }), true);
    assert.equal(isSendShortcut({ key: 'Enter', isComposing: false }), true);
  });

  test('does not send on a plain Enter for touch devices', () => {
    assert.equal(isSendShortcut({ key: 'Enter' }, { coarse: true }), false);
  });

  test('keeps Shift+Enter and Alt+Enter for a newline', () => {
    assert.equal(isSendShortcut({ key: 'Enter', shiftKey: true }), false);
    assert.equal(isSendShortcut({ key: 'Enter', altKey: true }), false);
  });

  test('always sends on Ctrl/Cmd+Enter, including on touch devices', () => {
    assert.equal(isSendShortcut({ key: 'Enter', ctrlKey: true }), true);
    assert.equal(isSendShortcut({ key: 'Enter', metaKey: true }, { coarse: true }), true);
  });

  test('never sends while an IME composition is active', () => {
    assert.equal(isSendShortcut({ key: 'Enter', isComposing: true }), false);
    assert.equal(isSendShortcut({ key: 'Enter', keyCode: 229 }), false);
    assert.equal(isSendShortcut({ key: 'Enter', isComposing: true, ctrlKey: true }), false);
    assert.equal(isSendShortcut({ key: 'Enter', keyCode: 229, metaKey: true }, { coarse: true }), false);
  });

  test('ignores other keys and missing events', () => {
    assert.equal(isSendShortcut({ key: 'a' }), false);
    assert.equal(isSendShortcut(null), false);
    assert.equal(isSendShortcut(undefined), false);
  });
});
