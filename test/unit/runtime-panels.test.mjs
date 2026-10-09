/**
 * Unit tests for the runtime panel's pure helpers: the permission-mode cycle, which tabs a viewer may open, the usage
 * and sandbox documents, and the number and time formats. The panel itself is DOM code and is covered by the e2e suite.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  RUNTIME_TABS,
  formatDurationMs,
  formatResetTime,
  formatUsd,
  hooksDocument,
  memoryDocument,
  nextPermissionMode,
  percentOf,
  permissionRows,
  prettyJson,
  runtimeTabs,
  sandboxDocument,
  skillRows,
  sourceKey,
  usageDocument,
  usageWindows,
} from '../../public/js/ui/runtime-panels.js';

const ALL_VIEWS = ['status', 'permissions', 'hooks', 'usage', 'skills', 'sandbox', 'settings', 'chrome'];

describe('nextPermissionMode', () => {
  it('cycles the four base modes in Shift+Tab order and wraps to the first', () => {
    assert.equal(nextPermissionMode('default'), 'acceptEdits');
    assert.equal(nextPermissionMode('acceptEdits'), 'plan');
    assert.equal(nextPermissionMode('plan'), 'auto');
    assert.equal(nextPermissionMode('auto'), 'default');
  });

  it('adds bypassPermissions to the cycle only when the gateway allows it', () => {
    assert.equal(nextPermissionMode('auto', { bypass: true }), 'bypassPermissions');
    assert.equal(nextPermissionMode('bypassPermissions', { bypass: true }), 'default');
    assert.equal(nextPermissionMode('bypassPermissions'), 'acceptEdits');
  });

  it('starts again from accept edits for modes the cycle does not know', () => {
    for (const mode of ['dontAsk', null, 'mystery']) assert.equal(nextPermissionMode(mode), 'acceptEdits');
  });
});

describe('runtimeTabs', () => {
  it('offers every tab, in display order, for a full profile with the Chrome flag on', () => {
    assert.deepEqual(runtimeTabs({ views: ALL_VIEWS, profile: 'full', chrome: true }), [...RUNTIME_TABS]);
  });

  it('hides a tab whose runtime view is not offered, but keeps Memory, which reads its own endpoint', () => {
    assert.deepEqual(runtimeTabs({ views: ['status', 'usage'], profile: 'full', chrome: false }), ['status', 'memory', 'usage']);
  });

  it('keeps what a read profile may open and drops Status, Hooks and Settings', () => {
    assert.deepEqual(runtimeTabs({ views: ALL_VIEWS, profile: 'read', chrome: false }),
      ['permissions', 'memory', 'usage', 'skills', 'sandbox']);
  });

  it('shows Chrome only when the gateway flag is on', () => {
    assert.ok(runtimeTabs({ views: ['chrome'], profile: 'read', chrome: true }).includes('chrome'));
    assert.ok(!runtimeTabs({ views: ['chrome'], profile: 'read', chrome: false }).includes('chrome'));
  });
});

describe('number and time formats', () => {
  it('prints percentages only for finite numbers', () => {
    assert.equal(percentOf(42.4), 42.4);
    assert.equal(percentOf('x'), null);
    assert.equal(percentOf(null), null);
  });

  it('formats US dollars and shows a dash when the cost is unknown', () => {
    assert.equal(formatUsd(0.1234), '$0.12');
    assert.equal(formatUsd(null), '—');
    assert.match(formatUsd(12.5, 'zh-CN'), /12\.50/);
  });

  it('formats durations with the unit words it is given', () => {
    assert.equal(formatDurationMs(500), '500 ms');
    assert.equal(formatDurationMs(2500), '2.5 s');
    assert.equal(formatDurationMs(125000), '2 min 5 s');
    assert.equal(formatDurationMs(3700000), '1 h 1 min');
    assert.equal(formatDurationMs(2500, { s: 'sec' }), '2.5 sec');
  });

  it('shows an empty reset time for a value that is not a date', () => {
    assert.equal(formatResetTime('not a date', 'en'), '');
    assert.notEqual(formatResetTime('2026-10-09T12:00:00Z', 'en'), '');
  });

  it('pretty-prints JSON with two spaces', () => {
    assert.equal(prettyJson({ a: 1 }), '{\n  "a": 1\n}');
  });
});

describe('usage', () => {
  it('lists the rate-limit windows the runtime reports, in its order, and ignores unknown ones', () => {
    const windows = usageWindows({
      five_hour: { utilization: 42, resets_at: '2026-10-09T12:00:00Z' },
      seven_day: { utilization: 7.5, resets_at: null },
      unknown_window: { utilization: 1 },
    });
    assert.deepEqual(windows.map((window) => window.key), ['five_hour', 'seven_day']);
    assert.equal(windows[0].utilization, 42);
    assert.equal(windows[0].resetsAt, '2026-10-09T12:00:00Z');
    assert.equal(windows[0].labelKey, 'shell.runtime.usage.window.five_hour');
    assert.equal(windows[1].resetsAt, null);
  });

  it('reports no windows when the runtime sends none', () => {
    assert.deepEqual(usageWindows(null), []);
    assert.deepEqual(usageWindows(undefined), []);
  });

  it('reads the session totals and the rate limits from the usage view', () => {
    const doc = usageDocument({
      session: {
        total_cost_usd: 0.5,
        total_duration_ms: 1000,
        total_api_duration_ms: 800,
        total_lines_added: 3,
        total_lines_removed: 1,
        model_usage: { 'model-a': { costUSD: 0.5 } },
      },
      rate_limits: { five_hour: { utilization: 10, resets_at: null } },
      rate_limits_available: true,
    });
    assert.equal(doc.costUsd, 0.5);
    assert.equal(doc.durationMs, 1000);
    assert.equal(doc.apiDurationMs, 800);
    assert.equal(doc.linesAdded, 3);
    assert.equal(doc.linesRemoved, 1);
    assert.deepEqual(doc.models, [{ name: 'model-a', costUsd: 0.5 }]);
    assert.equal(doc.windows.length, 1);
    assert.equal(doc.ratesAvailable, true);
  });
});

describe('permissions, sandbox, memory, hooks and skills', () => {
  it('maps the setting sources to their short keys', () => {
    assert.equal(sourceKey('projectSettings'), 'project');
    assert.equal(sourceKey('policySettings'), 'policy');
    assert.equal(sourceKey('somethingNew'), null);
  });

  it('turns permission rules into rows, with unknown behaviors marked as such', () => {
    const doc = permissionRows({
      state: {
        rules: [
          {
            behavior: 'ask',
            source: 'projectSettings',
            rule: 'Bash(git push:*)',
            description: { prefix: 'Ask before ', emphasis: 'git push' },
          },
          { behavior: 'maybe', source: 'userSettings', rule: 'Read' },
        ],
        managedOnly: true,
      },
    });
    assert.equal(doc.rows.length, 2);
    assert.equal(doc.rows[0].behavior, 'ask');
    assert.equal(doc.rows[0].prefix, 'Ask before ');
    assert.equal(doc.rows[0].emphasis, 'git push');
    assert.equal(doc.rows[1].behavior, 'unknown');
    assert.equal(doc.managedOnly, true);
  });

  it('keeps only the sandbox restrictions that have entries', () => {
    const doc = sandboxDocument({
      supported: true,
      enabled: true,
      mode: 'auto',
      restrictions: { fs_deny_read: [], fs_allow_write: ['/tmp'], network_managed: false },
      dependencies: { errors: ['bad glob'], warnings: [] },
      excluded_commands: ['docker'],
    });
    assert.equal(doc.supported, true);
    assert.equal(doc.mode, 'auto');
    assert.deepEqual(doc.restrictions, [{ key: 'fs_allow_write', values: ['/tmp'] }]);
    assert.deepEqual(doc.errors, ['bad glob']);
    assert.deepEqual(doc.warnings, []);
    assert.deepEqual(doc.excluded, ['docker']);
  });

  it('describes each memory file with its path, status and content', () => {
    const doc = memoryDocument({
      files: [
        { label: 'Project', path: '/work/CLAUDE.md', exists: true, content: 'notes', truncated: false },
        { path: '/home/u/.claude/CLAUDE.md', exists: false },
      ],
    });
    assert.equal(doc.files.length, 2);
    assert.equal(doc.files[0].label, 'Project');
    assert.equal(doc.files[0].content, 'notes');
    assert.equal(doc.files[1].exists, false);
    assert.equal(doc.files[1].content, null);
  });

  it('lists hooks with their matcher and a readable source', () => {
    const doc = hooksDocument({
      events: [{ name: 'PreToolUse', hookCount: 0, summary: 'none' }],
      hooks: [{
        event: 'PostToolUse',
        matcher: 'Edit|Write',
        type: 'command',
        displayText: 'echo edited',
        disabled: false,
        source: 'projectSettings',
        sourceLabel: 'Project settings (.claude/settings.json)',
      }],
    });
    assert.equal(doc.events[0].name, 'PreToolUse');
    assert.equal(doc.events[0].count, 0);
    assert.equal(doc.hooks[0].matcher, 'Edit|Write');
    assert.equal(doc.hooks[0].command, 'echo edited');
    assert.equal(doc.hooks[0].source, 'Project settings (.claude/settings.json)');
  });

  it('maps skills to name and description rows', () => {
    assert.deepEqual(skillRows({ skills: [{ name: 'pdf', description: 'PDF tools' }] }), [{ name: 'pdf', description: 'PDF tools' }]);
  });
});
