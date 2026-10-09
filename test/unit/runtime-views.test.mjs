import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONTROL_TIMEOUT_MS, ControlTimeout, MEMORY_FILE_NAMES, MEMORY_MAX_BYTES, TIMEOUT_MESSAGE, availableViews,
  exportFilename, fileSuggestionsOf, firstLine, interruptReceipt, isEditableMemoryFile, isPlainObject, isWebUrl,
  listedMemoryFiles, realpathOrNull, redactSettings, runtimeMethod, sameDirectory, stringsOf, viewArguments,
  withTimeout, writeMemoryFile,
} from '../../src/engine/runtime-views.mjs';
import { AppError } from '../../src/contracts.mjs';

const ROOT = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'caw-views-'));
after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

/** A small layout: a workspace root, a home folder with a .claude folder, a second home without one, and an outside. */
function layout() {
  const base = fs.mkdtempSync(path.join(ROOT, 'layout-'));
  const work = path.join(base, 'work');
  const home = path.join(base, 'home');
  const bare = path.join(base, 'bare');
  const outside = path.join(base, 'outside');
  for (const dir of [work, path.join(home, '.claude'), bare, outside]) fs.mkdirSync(dir, { recursive: true });
  return {
    base, work, home, bare, outside,
    locations: { roots: [work], home },
    bareLocations: { roots: [work], home: bare },
  };
}

describe('control calls', () => {
  test('withTimeout answers the call, or a ControlTimeout when the call does not settle in time', async () => {
    assert.equal(await withTimeout(async () => 'done', 50), 'done');
    await assert.rejects(withTimeout(() => new Promise(() => {}), 5), (error) => error instanceof ControlTimeout
      && error.message === TIMEOUT_MESSAGE && error.name === 'ControlTimeout');
    await assert.rejects(withTimeout(() => {
      throw new Error('sync failure');
    }), /sync failure/);
    assert.equal(CONTROL_TIMEOUT_MS, 10000);
  });

  test('runtimeMethod is null for a missing query or method, and binds the method to the query', async () => {
    assert.equal(runtimeMethod(null, 'getStatus'), null);
    assert.equal(runtimeMethod(undefined, 'getStatus'), null);
    assert.equal(runtimeMethod({ getStatus: 'not a function' }, 'getStatus'), null);
    const query = { base: 3, add(value) { return this.base + value; } };
    assert.equal(await runtimeMethod(query, 'add')(4), 7);
    const broken = { fail() { throw new Error('boom'); } };
    await assert.rejects(runtimeMethod(broken, 'fail')(), /boom/);
  });

  test('availableViews lists the views whose runtime method the query has, in the order of the view table', () => {
    const query = {
      getStatus() {},
      getSettings() {},
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {},
      initializationResult() {},
    };
    assert.deepEqual(availableViews(query), ['status', 'settings', 'usage', 'init']);
    assert.deepEqual(availableViews({}), []);
  });

  test('the usage view skips the scan of local transcripts, and the other views take no arguments', () => {
    assert.deepEqual(viewArguments('usage'), [{ skipBehaviors: true }]);
    assert.deepEqual(viewArguments('status'), []);
  });
});

describe('plain values', () => {
  test('isPlainObject accepts object literals and null-prototype objects only', () => {
    assert.equal(isPlainObject({}), true);
    assert.equal(isPlainObject(Object.create(null)), true);
    assert.equal(isPlainObject([]), false);
    assert.equal(isPlainObject(null), false);
    assert.equal(isPlainObject(new Date()), false);
    assert.equal(isPlainObject('text'), false);
  });

  test('firstLine is the first line, trimmed and at most 300 characters, or the fallback when there is none', () => {
    assert.equal(firstLine('  Unknown agent: x\n    at /internal', 'fallback'), 'Unknown agent: x');
    assert.equal(firstLine('\nsecond line only', 'fallback'), 'fallback');
    assert.equal(firstLine(undefined, 'fallback'), 'fallback');
    assert.equal(firstLine('x'.repeat(400), 'fallback').length, 300);
  });

  test('redactSettings replaces the values of every env object at any depth and keeps the other values', () => {
    const settings = {
      effective: { model: 'sonnet', env: { ANTHROPIC_API_KEY: 'sk-live', HOME_DIR: '/home/u' } },
      sources: [{ source: 'projectSettings', settings: { env: { TOKEN: 'abc' }, showThinkingSummaries: false } }],
      applied: null,
      count: 3,
      odd: { env: ['not', 'an', 'object'] },
    };
    const redacted = redactSettings(settings);
    assert.deepEqual(redacted, {
      effective: { model: 'sonnet', env: { ANTHROPIC_API_KEY: '[redacted]', HOME_DIR: '[redacted]' } },
      sources: [{
        source: 'projectSettings',
        settings: { env: { TOKEN: '[redacted]' }, showThinkingSummaries: false },
      }],
      applied: null,
      count: 3,
      odd: { env: '[redacted]' },
    });
    assert.equal(settings.effective.env.ANTHROPIC_API_KEY, 'sk-live');
    assert.equal(redactSettings('plain'), 'plain');
  });

  test('exportFilename keeps letters, digits, dots, underscores and hyphens, and ends in .txt', () => {
    assert.equal(exportFilename('conversation-2026-10-09-174115.txt'), 'conversation-2026-10-09-174115.txt');
    assert.equal(exportFilename('../etc/x y.txt'), 'etcxy.txt');
    assert.equal(exportFilename('name'), 'name.txt');
    assert.equal(exportFilename('...'), 'conversation.txt');
    assert.equal(exportFilename(undefined), 'conversation.txt');
    assert.equal(exportFilename('?'), 'conversation.txt');
  });

  test('stringsOf keeps the strings of a list, and anything else is an empty list', () => {
    assert.deepEqual(stringsOf(['a', 1, null, 'b']), ['a', 'b']);
    assert.deepEqual(stringsOf('a'), []);
  });

  test('interruptReceipt maps the runtime receipt to camel case lists, and an absent receipt to empty lists', () => {
    assert.deepEqual(interruptReceipt({ still_queued: ['a', 1], cancelled: ['b'] }), {
      stillQueued: ['a'],
      cancelled: ['b'],
    });
    assert.deepEqual(interruptReceipt(undefined), { stillQueued: [], cancelled: [] });
    assert.deepEqual(interruptReceipt({ still_queued: 'a' }), { stillQueued: [], cancelled: [] });
  });

  test('isWebUrl accepts an absolute URL of an allowed scheme within the length limit only', () => {
    assert.equal(isWebUrl('https://auth.example.com/x', 4096, ['https:']), true);
    assert.equal(isWebUrl('http://localhost:53123/cb', 4096, ['http:', 'https:']), true);
    assert.equal(isWebUrl('http://localhost/cb', 4096, ['https:']), false);
    assert.equal(isWebUrl('javascript:alert(1)', 4096, ['http:', 'https:']), false);
    assert.equal(isWebUrl('/relative/path', 4096, ['http:', 'https:']), false);
    assert.equal(isWebUrl('https://a.example', 10, ['https:']), false);
    assert.equal(isWebUrl(42, 4096, ['https:']), false);
  });

  test('realpathOrNull resolves an existing path and answers null for a missing one', async () => {
    const dir = fs.mkdtempSync(path.join(ROOT, 'real-'));
    assert.equal(await realpathOrNull(dir), dir);
    assert.equal(await realpathOrNull(path.join(dir, 'missing')), null);
  });

  test('sameDirectory is true for two spellings of one folder, and false otherwise', async () => {
    const { work, outside } = layout();
    assert.equal(await sameDirectory(work, path.join(work, '.')), true);
    assert.equal(await sameDirectory(work, outside), false);
    assert.equal(await sameDirectory(work, path.join(work, 'missing')), false);
  });
});

describe('file suggestions', () => {
  test('the runtime envelope is unwrapped, folders end in a slash, and unusable paths are dropped', () => {
    const envelope = {
      subtype: 'success',
      response: {
        suggestions: [
          { path: 'src/host.mjs' },
          { path: 'src/' },
          { path: '/etc/passwd' },
          { path: '../outside.txt' },
          { path: 'a/../b' },
          { path: '' },
          { path: 'nul\u0000name' },
          'not an object',
        ],
      },
    };
    assert.deepEqual(fileSuggestionsOf(envelope, 10), [
      { path: 'src/host.mjs', type: 'file' },
      { path: 'src', type: 'dir' },
    ]);
  });

  test('the list is capped at the limit, an unwrapped answer works too, and anything else is empty', () => {
    const suggestions = [{ path: 'a' }, { path: 'b' }, { path: 'c' }];
    assert.deepEqual(fileSuggestionsOf({ suggestions }, 2).map((entry) => entry.path), ['a', 'b']);
    const unwrapped = fileSuggestionsOf({ response: 'nope', suggestions }, 5);
    assert.deepEqual(unwrapped.map((entry) => entry.path), ['a', 'b', 'c']);
    assert.deepEqual(fileSuggestionsOf(null, 5), []);
    assert.deepEqual(fileSuggestionsOf({ response: { suggestions: 'x' } }, 5), []);
  });
});

describe('memory files', () => {
  test('listedMemoryFiles keeps the entries that have a path and fills in the other fields safely', () => {
    const listed = listedMemoryFiles({
      files: [
        { kind: 'project', path: '/a/CLAUDE.md', label: 'L', description: 'D', exists: true },
        { kind: 'x', path: '' },
        { kind: 'y' },
        'text',
        { path: '/b/CLAUDE.md', exists: 'yes' },
      ],
    });
    assert.deepEqual(listed, [
      { kind: 'project', path: '/a/CLAUDE.md', label: 'L', description: 'D', exists: true },
      { kind: '', path: '/b/CLAUDE.md', label: '', description: '', exists: false },
    ]);
    assert.deepEqual(listedMemoryFiles(null), []);
  });

  test('the memory file names and the byte limit are the documented ones', () => {
    assert.deepEqual(MEMORY_FILE_NAMES, ['CLAUDE.md', 'CLAUDE.local.md']);
    assert.equal(MEMORY_MAX_BYTES, 256 * 1024);
  });

  test('a CLAUDE.md inside a workspace root, or a missing one whose folder is there, is editable', async () => {
    const { work, locations } = layout();
    const existing = path.join(work, 'CLAUDE.md');
    fs.writeFileSync(existing, '# notes');
    assert.equal(await isEditableMemoryFile(existing, locations), true);
    assert.equal(await isEditableMemoryFile(path.join(work, 'CLAUDE.local.md'), locations), true);
  });

  test('other names, relative paths, folders, symbolic links and outside files are not editable', async () => {
    const { work, outside, home, locations } = layout();
    fs.writeFileSync(path.join(work, 'notes.md'), 'x');
    fs.writeFileSync(path.join(outside, 'CLAUDE.md'), 'x');
    fs.writeFileSync(path.join(work, 'real.md'), 'x');
    fs.symlinkSync(path.join(work, 'real.md'), path.join(work, 'CLAUDE.md'));
    fs.mkdirSync(path.join(work, 'folder', 'CLAUDE.md'), { recursive: true });
    assert.equal(await isEditableMemoryFile(path.join(work, 'notes.md'), locations), false);
    assert.equal(await isEditableMemoryFile('CLAUDE.md', locations), false);
    assert.equal(await isEditableMemoryFile(path.join(outside, 'CLAUDE.md'), locations), false);
    assert.equal(await isEditableMemoryFile(path.join(work, 'CLAUDE.md'), locations), false);
    assert.equal(await isEditableMemoryFile(path.join(work, 'folder', 'CLAUDE.md'), locations), false);
    assert.equal(await isEditableMemoryFile(path.join(home, 'CLAUDE.md'), locations), false);
    assert.equal(await isEditableMemoryFile(path.join(work, 'deep', 'missing', 'CLAUDE.md'), locations), false);
  });

  test('the user folder .claude is editable, and a missing folder under it may be created', async () => {
    const { home, bare, locations, bareLocations } = layout();
    const userFile = path.join(home, '.claude', 'CLAUDE.md');
    fs.writeFileSync(userFile, '# user');
    assert.equal(await isEditableMemoryFile(userFile, locations), true);
    const project = path.join(home, '.claude', 'projects', 'p1', 'CLAUDE.md');
    assert.equal(await isEditableMemoryFile(project, locations), true);
    assert.equal(await isEditableMemoryFile(path.join(bare, '.claude', 'CLAUDE.md'), bareLocations), true);
    assert.equal(await isEditableMemoryFile(path.join(bare, 'other', 'CLAUDE.md'), bareLocations), false);
  });

  test('writeMemoryFile saves atomically, keeps the mode of an existing file, and leaves no temp file', async () => {
    const { work, locations } = layout();
    const file = path.join(work, 'CLAUDE.md');
    fs.writeFileSync(file, 'old');
    fs.chmodSync(file, 0o600);
    await writeMemoryFile(file, '# new content', locations);
    assert.equal(fs.readFileSync(file, 'utf8'), '# new content');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(work).filter((name) => name.endsWith('.tmp')), []);
  });

  test('writeMemoryFile gives a new file mode 0644 and creates a missing folder only under .claude', async () => {
    const { work, home, locations } = layout();
    const fresh = path.join(work, 'CLAUDE.local.md');
    await writeMemoryFile(fresh, 'local', locations);
    assert.equal(fs.statSync(fresh).mode & 0o777, 0o644);
    const nested = path.join(home, '.claude', 'projects', 'p1', 'CLAUDE.md');
    await writeMemoryFile(nested, 'nested', locations);
    assert.equal(fs.readFileSync(nested, 'utf8'), 'nested');
    assert.equal(fs.statSync(path.join(home, '.claude', 'projects', 'p1')).mode & 0o777, 0o700);
  });

  test('writeMemoryFile refuses a file that is not editable, with 422, and writes nothing', async () => {
    const { outside, locations } = layout();
    const target = path.join(outside, 'CLAUDE.md');
    await assert.rejects(writeMemoryFile(target, 'x', locations), (error) => error instanceof AppError
      && error.status === 422 && error.code === 'PATH_NOT_ALLOWED');
    assert.equal(fs.existsSync(target), false);
    assert.deepEqual(fs.readdirSync(outside), []);
  });
});
