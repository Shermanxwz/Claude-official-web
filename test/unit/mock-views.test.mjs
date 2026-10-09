// Tests for the runtime views the mock answers with (src/engine/mock/views.mjs). The builders take plain data; the file
// index and the memory dialog read a temporary project folder that is removed afterwards.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chromeDialogOf,
  EVENT_CATALOG,
  exportFilenameOf,
  exportTextOf,
  fileSuggestionsOf,
  hooksListingOf,
  memoryDialogOf,
  permissionRulesOf,
  readDeniedBy,
  sandboxDialogOf,
  settingsOf,
  skillsDialogOf,
  statusOf,
} from '../../src/engine/mock/views.mjs';

/**
 * A project folder with a few files, removed when the test ends.
 * @param {import('node:test').TestContext} t
 * @returns {string}
 */
function projectFolder(t) {
  const dir = mkdtempSync(join(tmpdir(), 'caw-mock-views-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'src', 'Utils'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
  mkdirSync(join(dir, '.git'));
  writeFileSync(join(dir, 'src', 'app.js'), '');
  writeFileSync(join(dir, 'src', 'Utils', 'Helpers.ts'), '');
  writeFileSync(join(dir, 'README.md'), '');
  writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), '');
  writeFileSync(join(dir, '.git', 'config'), '');
  return dir;
}

describe('permission rules', () => {
  const fileSettings = {
    permissions: {
      allow: ['Bash(npm test:*)', 'Read'],
      ask: ['Bash(git push:*)'],
      deny: ['Read(./.env)'],
    },
  };

  test('allow rules count only in a trusted folder; ask and deny rules always apply', () => {
    const untrusted = permissionRulesOf({ fileSettings, trusted: false, cwd: '/w', additionalDirectories: [] });
    assert.deepEqual(untrusted.rules.map((rule) => [rule.behavior, rule.rule]), [
      ['ask', 'Bash(git push:*)'],
      ['deny', 'Read(./.env)'],
    ]);
    const trusted = permissionRulesOf({ fileSettings, trusted: true, cwd: '/w', additionalDirectories: [] });
    assert.deepEqual(trusted.rules.map((rule) => [rule.behavior, rule.rule]), [
      ['allow', 'Bash(npm test:*)'],
      ['allow', 'Read'],
      ['ask', 'Bash(git push:*)'],
      ['deny', 'Read(./.env)'],
    ]);
  });

  test('a Bash prefix rule carries the plain-language reading; other rules do not', () => {
    const { rules } = permissionRulesOf({ fileSettings, trusted: true, cwd: '/w', additionalDirectories: [] });
    assert.deepEqual(rules[0], {
      behavior: 'allow',
      source: 'projectSettings',
      rule: 'Bash(npm test:*)',
      description: { prefix: 'Any Bash command starting with ', emphasis: 'npm test' },
      editability: 'persistent',
    });
    assert.equal('description' in rules[1], false);
    assert.equal(rules[1].editability, 'persistent');
  });

  test('the answer lists the session folders and the original folder', () => {
    const answer = permissionRulesOf({
      fileSettings: {},
      trusted: true,
      cwd: '/w',
      additionalDirectories: ['/shared'],
    });
    assert.deepEqual(answer, {
      rules: [],
      workspaceDirectories: [{ path: '/shared', source: 'session' }],
      originalCwd: '/w',
      managedOnly: false,
    });
  });
});

describe('hooks listing', () => {
  test('each command hook is a row under its event; other hook types are not listed', () => {
    const listing = hooksListingOf({
      hooks: {
        PreToolUse: [{
          matcher: 'Bash',
          hooks: [{ type: 'command', command: 'echo before', timeout: 5 }, { type: 'prompt', prompt: 'x' }],
        }],
        Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }],
        Unknown: 'not a list',
      },
    });
    assert.deepEqual(listing.hooks.map((hook) => [hook.event, hook.matcher, hook.displayText, hook.timeout]), [
      ['PreToolUse', 'Bash', 'echo before', 5],
      ['Stop', '', 'echo done', 60],
    ]);
    assert.deepEqual(listing.events, [
      { name: 'PreToolUse', summary: 'Before tool execution', supportsMatcher: true, hookCount: 1 },
      { name: 'Stop', summary: 'Right before Claude concludes its response', supportsMatcher: false, hookCount: 1 },
    ]);
    assert.equal(listing.eventCatalog.length, EVENT_CATALOG.length);
    assert.deepEqual(listing.policy, {});
  });

  test('without hooks the listing is empty and still carries the catalog', () => {
    const listing = hooksListingOf({});
    assert.deepEqual(listing.events, []);
    assert.deepEqual(listing.hooks, []);
    assert.ok(listing.eventCatalog.some((entry) => entry.name === 'SessionStart'));
  });
});

describe('settings view', () => {
  test('the effective settings are the file settings; the applied values follow the session', () => {
    const view = settingsOf({
      fileSettings: { model: 'x' },
      settingSources: ['project'],
      model: 'claude-haiku-mock',
      effort: null,
    });
    assert.deepEqual(view.effective, { model: 'x' });
    assert.deepEqual(view.sources, [{ source: 'projectSettings', settings: { model: 'x' } }]);
    assert.equal(view.applied.model, 'claude-haiku-mock');
    assert.equal(view.applied.effort, 'medium');
    const high = settingsOf({ fileSettings: {}, settingSources: [], model: 'm', effort: 'high' });
    assert.equal(high.applied.effort, 'high');
  });

  test('a session that loads no setting sources has no sources', () => {
    assert.deepEqual(settingsOf({ fileSettings: { a: 1 }, settingSources: [], model: 'm', effort: null }).sources, []);
  });
});

describe('memory dialog', () => {
  test('the project file is reported when it exists; the user file never is', (t) => {
    const cwd = projectFolder(t);
    assert.equal(memoryDialogOf({ cwd, home: cwd }).files[0].exists, false);
    writeFileSync(join(cwd, 'CLAUDE.md'), '# notes\n');
    const dialog = memoryDialogOf({ cwd, home: '/home/someone' });
    assert.deepEqual(dialog.files.map((file) => [file.kind, file.path, file.exists]), [
      ['project', join(cwd, 'CLAUDE.md'), true],
      ['user', join('/home/someone', '.claude', 'CLAUDE.md'), false],
    ]);
    assert.equal(dialog.auto_memory.enabled, false);
    assert.equal(dialog.auto_dream.shown, false);
  });
});

describe('skills, sandbox and chrome views', () => {
  test('the skills dialog lists each skill with its display name and description', () => {
    assert.deepEqual(skillsDialogOf([{ name: 'verify', description: 'Check the work' }]), {
      skills: [{ name: 'verify', display_name: 'verify', description: 'Check the work' }],
    });
  });

  test('the sandbox is off, and its runtime dependencies are reported missing', () => {
    const dialog = sandboxDialogOf();
    assert.equal(dialog.enabled, false);
    assert.equal(dialog.mode, 'disabled');
    assert.deepEqual(dialog.dependencies.errors, ['bubblewrap (bwrap) not installed', 'socat not installed']);
    assert.deepEqual(dialog.excluded_commands, []);
  });

  test('the chrome dialog follows whether the session starts with --chrome', () => {
    const on = chromeDialogOf(true);
    assert.equal(on.enabled, true);
    assert.equal(on.connected, true);
    assert.equal(on.selectedBrowser, 'Google Chrome');
    const off = chromeDialogOf(false);
    assert.equal(off.enabled, false);
    assert.equal(off.extensionInstalled, false);
    assert.equal(off.selectedBrowser, null);
  });
});

describe('status view', () => {
  const base = {
    sessionId: '0b6f6a52-2d2e-4f7a-9d8e-1a2b3c4d5e6f',
    cwd: '/work/app',
    model: 'claude-sonnet-mock',
    login: 'claude.ai account',
    agent: null,
    additionalDirectories: [],
    settingSources: [],
    version: '2.1.295-mock',
  };
  const rowsOf = (/** @type {any} */ view, /** @type {number} */ index) =>
    view.sections[index].rows.map((row) => [row.label, row.value]);

  test('the session rows always appear; the agent and the extra folders only when the session has them', () => {
    const rows = rowsOf(statusOf(base), 0);
    assert.deepEqual(rows.map(([label]) => label), [
      'Version', 'Session ID', 'Session kind', 'cwd', 'Login method', 'Anthropic base URL',
    ]);
    assert.deepEqual(rows[4], ['Login method', 'claude.ai account']);
  });

  test('the optional rows appear when the session names an agent or extra folders', () => {
    const view = statusOf({ ...base, agent: 'Explore', additionalDirectories: ['/a', '/b'] });
    const labels = rowsOf(view, 0).map(([label]) => label);
    assert.ok(labels.includes('Agent'));
    assert.deepEqual(rowsOf(view, 0).find(([label]) => label === 'Additional directories'), [
      'Additional directories',
      '/a, /b',
    ]);
  });

  test('the setting sources are named by what the session loads', () => {
    const sourcesOf = (/** @type {string[]} */ settingSources) =>
      rowsOf(statusOf({ ...base, settingSources }), 1).find(([label]) => label === 'Setting sources')[1];
    assert.equal(sourcesOf([]), 'None');
    assert.equal(sourcesOf(['project', 'user']), 'Shared project settings');
    assert.equal(sourcesOf(['user']), 'User settings only');
  });
});

describe('export', () => {
  test('prompts are quoted, answer text is kept, and tool results and nested messages are left out', () => {
    const text = exportTextOf([
      { type: 'user', parent_tool_use_id: null, message: { content: 'First line\nSecond line' } },
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'thinking', thinking: 'hidden' },
            { type: 'text', text: 'Answer one.' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
          ],
        },
      },
      {
        type: 'user',
        parent_tool_use_id: null,
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'out' }] },
      },
      { type: 'assistant', parent_tool_use_id: 'agent-1', message: { content: [{ type: 'text', text: 'Nested' }] } },
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: '   ' }, { type: 'text', text: 'Answer two.' }] },
      },
    ]);
    assert.equal(text, '> First line\n> Second line\n\nAnswer one.\n\nAnswer two.\n');
  });

  test('an empty conversation exports as an empty text', () => {
    assert.equal(exportTextOf([]), '');
  });

  test('the default file name carries the local date and time to the second', () => {
    assert.equal(exportFilenameOf(new Date(2026, 0, 2, 3, 4, 5)), 'conversation-2026-01-02-030405.txt');
  });
});

describe('file suggestions', () => {
  test('an empty query lists the top-level entries; folders end in a slash and skipped folders are absent', (t) => {
    const cwd = projectFolder(t);
    assert.deepEqual(fileSuggestionsOf(cwd, ''), [{ path: 'README.md' }, { path: 'src/' }]);
  });

  test('a query matches paths containing it, ignoring case, and descends into folders to find them', (t) => {
    const cwd = projectFolder(t);
    assert.deepEqual(fileSuggestionsOf(cwd, 'app'), [{ path: 'src/app.js' }]);
    assert.deepEqual(fileSuggestionsOf(cwd, 'HELPERS'), [{ path: 'src/Utils/Helpers.ts' }]);
    assert.deepEqual(fileSuggestionsOf(cwd, 'utils'), [{ path: 'src/Utils/' }, { path: 'src/Utils/Helpers.ts' }]);
  });

  test('the skipped folders are never searched, and a missing folder has no suggestions', (t) => {
    const cwd = projectFolder(t);
    assert.deepEqual(fileSuggestionsOf(cwd, 'pkg'), []);
    assert.deepEqual(fileSuggestionsOf(cwd, 'config'), []);
    assert.deepEqual(fileSuggestionsOf(join(cwd, 'missing'), ''), []);
  });
});

describe('read deny rules', () => {
  const fileSettings = {
    permissions: {
      deny: ['Read(./secrets/**)', 'Read(./.env)', 'Read(**/*.pem)', 'Bash(rm:*)'],
    },
  };
  const cwd = '/work/app';

  test('a pattern that starts with ./ is relative to the session folder', () => {
    assert.equal(readDeniedBy(fileSettings, cwd, '/work/app/secrets/keys/a.txt'), true);
    assert.equal(readDeniedBy(fileSettings, cwd, '/work/app/.env'), true);
    assert.equal(readDeniedBy(fileSettings, cwd, '/work/app/.env.local'), false);
    assert.equal(readDeniedBy(fileSettings, cwd, '/work/app/secrets'), false);
  });

  test('any other pattern is matched against the absolute path', () => {
    assert.equal(readDeniedBy(fileSettings, cwd, '/work/app/certs/server.pem'), true);
    assert.equal(readDeniedBy(fileSettings, cwd, '/work/app/src/app.js'), false);
  });

  test('rules other than Read do not deny a read, and no rules deny nothing', () => {
    assert.equal(readDeniedBy({ permissions: { deny: ['Bash(rm:*)'] } }, cwd, '/work/app/rm'), false);
    assert.equal(readDeniedBy({}, cwd, '/work/app/.env'), false);
  });
});
