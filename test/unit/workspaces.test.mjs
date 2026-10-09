// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it, mock } from 'node:test';
import { AppError } from '../../src/contracts.mjs';
import { createWorkspaces } from '../../src/workspaces.mjs';

const BIG_FILE_COUNT = 20500;
const DEPTH_CHAIN_LENGTH = 13;

/**
 * @param {unknown} value
 * @returns {any}
 */
const untyped = (value) => value;

/**
 * @param {Promise<unknown>} promise
 * @param {number} status
 * @param {string} code
 */
function assertAppError(promise, status, code) {
  return assert.rejects(promise, (err) => err instanceof AppError && err.status === status && err.code === code);
}

/**
 * @param {string} file
 * @param {string} [text]
 */
async function writeText(file, text = 'x') {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, text);
}

/** @param {string[]} dirs */
async function mkdirAll(dirs) {
  await Promise.all(dirs.map((dir) => fs.promises.mkdir(dir, { recursive: true })));
}

/**
 * Roots `ws` and `ws2`, a sibling `ws-evil` that shares the prefix, and an `outside` directory that is no root.
 * @param {string} base
 */
async function buildContainment(base) {
  const ws = path.join(base, 'ws');
  const ws2 = path.join(base, 'ws2');
  const outside = path.join(base, 'outside');
  await mkdirAll([
    path.join(ws, 'proj', '.git'), path.join(ws, 'proj', 'src', 'deep'), path.join(ws, 'plain'),
    path.join(ws, 'pkg'), path.join(ws, 'claude-dir', '.claude'), path.join(ws, 'docs-md'),
    path.join(ws, '.hidden'), path.join(ws, 'zeta'), path.join(ws, 'Alpha'), path.join(ws, 'beta'),
    path.join(ws, 'item10'), path.join(ws, 'item2'), path.join(ws2, 'inner'), path.join(outside, 'secret'),
    path.join(base, 'ws-evil'),
  ]);
  await writeText(path.join(ws, 'proj', 'src', 'index.mjs'));
  await writeText(path.join(ws, 'pkg', 'package.json'), '{}');
  await writeText(path.join(ws, 'docs-md', 'CLAUDE.md'), '# notes');
  await writeText(path.join(ws, 'file.txt'));
  await writeText(path.join(ws, '.hidden', 'inside.txt'));
  await writeText(path.join(ws2, 'package.json'), '{}');
  await writeText(path.join(outside, 'file.txt'));
  await fs.promises.symlink(path.join(ws, 'plain'), path.join(ws, 'link-in'));
  await fs.promises.symlink(path.join('..', 'outside'), path.join(ws, 'link-out'));
  await fs.promises.symlink(path.join(ws, 'nowhere'), path.join(ws, 'link-broken'));
  await fs.promises.symlink(path.join(ws, 'file.txt'), path.join(ws, 'link-file'));
  return { ws, ws2, outside };
}

/**
 * Root `m` for mkdir tests: an existing directory, an existing file, a symlink to it and a symlink leaving the root.
 * @param {string} base
 * @param {string} outside
 */
async function buildMutable(base, outside) {
  const root = path.join(base, 'm');
  await mkdirAll([path.join(root, 'exists-dir')]);
  await writeText(path.join(root, 'exists-file'));
  await fs.promises.symlink(path.join(root, 'exists-dir'), path.join(root, 'link-in'));
  await fs.promises.symlink(outside, path.join(root, 'link-out'));
  return root;
}

/**
 * Root `s` for search tests with hidden, skipped and symlinked entries.
 * @param {string} base
 */
async function buildSearchTree(base) {
  const root = path.join(base, 's');
  const outsideDir = path.join(base, 'outside-dir');
  await mkdirAll([
    path.join(root, 'src', 'deep-nest'), path.join(root, 'test', 'unit'), path.join(root, 'docs'),
    path.join(root, 'node_modules', 'ws'), path.join(root, '.git'),
    path.join(root, '.caw-uploads', '20260101-abcdef12'), path.join(root, '.secret'), outsideDir,
  ]);
  const files = [
    'README.md', '.env', 'src/state.mjs', 'src/workspaces.mjs', 'src/attachments.mjs',
    'test/unit/state.test.mjs', 'test/unit/workspaces.test.mjs', 'docs/ws-notes.md',
    'node_modules/ws/index.js', '.git/config', '.caw-uploads/20260101-abcdef12/work.txt', '.secret/key.txt',
  ];
  for (const file of files) {
    await writeText(path.join(root, file));
  }
  await writeText(path.join(outsideDir, 'secret.md'));
  await fs.promises.symlink(path.join(root, 'src'), path.join(root, 'linkdir'));
  await fs.promises.symlink(outsideDir, path.join(root, 'outward'));
  await fs.promises.symlink(path.join(root, 'README.md'), path.join(root, 'linked-file.md'));
  await fs.promises.symlink(path.join(outsideDir, 'secret.md'), path.join(root, 'escape.md'));
  return { root, outsideDir };
}

/**
 * Root `d` with one file at every level of a directory chain, to exercise the depth limit.
 * @param {string} base
 */
async function buildDepthTree(base) {
  const root = path.join(base, 'd');
  let dir = root;
  for (let k = 1; k <= DEPTH_CHAIN_LENGTH; k += 1) {
    dir = path.join(dir, `d${k}`);
    await writeText(path.join(dir, `at-d${k}.txt`));
  }
  return root;
}

/**
 * Root `c` holding one directory with more entries than the walk may visit.
 * @param {string} base
 */
async function buildCapTree(base) {
  const root = path.join(base, 'c');
  const big = path.join(root, 'big');
  await fs.promises.mkdir(big, { recursive: true });
  for (let start = 0; start < BIG_FILE_COUNT; start += 1000) {
    const end = Math.min(start + 1000, BIG_FILE_COUNT);
    const files = [];
    for (let i = start; i < end; i += 1) {
      files.push(path.join(big, `f${String(i).padStart(5, '0')}.txt`));
    }
    await Promise.all(files.map((file) => fs.promises.writeFile(file, '')));
  }
  return root;
}

/**
 * Root `l` with 510 sub-directories and 20 files, to exercise the 500-entry listing cap.
 * @param {string} base
 */
async function buildListingCap(base) {
  const root = path.join(base, 'l');
  const dirs = [];
  for (let i = 0; i < 510; i += 1) {
    dirs.push(path.join(root, `d${String(i).padStart(3, '0')}`));
  }
  await mkdirAll(dirs);
  for (let i = 0; i < 20; i += 1) {
    await writeText(path.join(root, `a-file-${String(i).padStart(2, '0')}.txt`));
  }
  return root;
}

describe('workspaces', () => {
  /** @type {string} */
  let tmp;
  /** @type {{ws: string, ws2: string, outside: string, m: string, s: string, outsideDir: string, d: string,
   *   c: string, l: string}} */
  const fx = /** @type {any} */ ({});
  /** @type {ReturnType<typeof createWorkspaces>} */
  let workspaces;

  before(async () => {
    tmp = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'caw-workspaces-')));
    Object.assign(fx, await buildContainment(tmp));
    fx.m = await buildMutable(tmp, fx.outside);
    const search = await buildSearchTree(tmp);
    fx.s = search.root;
    fx.outsideDir = search.outsideDir;
    fx.d = await buildDepthTree(tmp);
    fx.c = await buildCapTree(tmp);
    fx.l = await buildListingCap(tmp);
    workspaces = createWorkspaces({ roots: [fx.ws, fx.ws2, fx.m, fx.s, fx.d, fx.c, fx.l] });
  });

  after(async () => {
    mock.restoreAll();
    await fs.promises.rm(tmp, { recursive: true, force: true });
  });

  describe('containment', () => {
    it('resolves roots and nested directories to their realpath', async () => {
      assert.equal(await workspaces.resolveDir(fx.ws), fx.ws);
      assert.equal(await workspaces.resolveDir(path.join(fx.ws, 'proj', 'src')), path.join(fx.ws, 'proj', 'src'));
      assert.equal(await workspaces.resolveDir(path.join(fx.ws2, 'inner')), path.join(fx.ws2, 'inner'));
      assert.equal(await workspaces.resolveDir(`${fx.ws}/plain/../proj`), path.join(fx.ws, 'proj'));
    });

    it('follows symlinks that stay inside a root and reports their target', async () => {
      assert.equal(await workspaces.resolveDir(path.join(fx.ws, 'link-in')), path.join(fx.ws, 'plain'));
    });

    it('rejects symlinks and dot segments that leave a root', async () => {
      await assertAppError(workspaces.resolveDir(path.join(fx.ws, 'link-out')), 422, 'PATH_NOT_ALLOWED');
      await assertAppError(workspaces.resolveDir(path.join(fx.ws, 'link-broken')), 422, 'PATH_NOT_ALLOWED');
      await assertAppError(workspaces.resolveDir(`${fx.ws}/../outside`), 422, 'PATH_NOT_ALLOWED');
    });

    it('rejects sibling directories whose names share a root prefix', async () => {
      await assertAppError(workspaces.resolveDir(`${tmp}/ws-evil`), 422, 'PATH_NOT_ALLOWED');
      await assertAppError(workspaces.resolveDir(`${tmp}/ws2x`), 422, 'PATH_NOT_ALLOWED');
    });

    it('rejects directories outside every root, the filesystem root and non-directories', async () => {
      await assertAppError(workspaces.resolveDir(fx.outside), 422, 'PATH_NOT_ALLOWED');
      await assertAppError(workspaces.resolveDir(path.join(fx.outside, 'secret')), 422, 'PATH_NOT_ALLOWED');
      await assertAppError(workspaces.resolveDir('/'), 422, 'PATH_NOT_ALLOWED');
      await assertAppError(workspaces.resolveDir(path.join(fx.ws, 'file.txt')), 422, 'PATH_NOT_ALLOWED');
      await assertAppError(workspaces.resolveDir(path.join(fx.ws, 'missing')), 422, 'PATH_NOT_ALLOWED');
    });

    it('rejects relative, empty, NUL-containing and non-string paths', async () => {
      await assertAppError(workspaces.resolveDir('relative/path'), 422, 'PATH_NOT_ALLOWED');
      await assertAppError(workspaces.resolveDir(fx.ws.slice(1)), 422, 'PATH_NOT_ALLOWED');
      await assertAppError(workspaces.resolveDir(''), 422, 'PATH_NOT_ALLOWED');
      await assertAppError(workspaces.resolveDir(`${fx.ws}\0`), 422, 'PATH_NOT_ALLOWED');
      await assertAppError(workspaces.resolveDir(untyped(undefined)), 422, 'PATH_NOT_ALLOWED');
      await assertAppError(workspaces.resolveDir(untyped(42)), 422, 'PATH_NOT_ALLOWED');
      await assertAppError(workspaces.resolveDir(untyped({})), 422, 'PATH_NOT_ALLOWED');
    });

    it('isInsideRoots mirrors the containment rule and never throws', async () => {
      assert.equal(await workspaces.isInsideRoots(fx.ws), true);
      assert.equal(await workspaces.isInsideRoots(path.join(fx.ws, 'proj', 'src')), true);
      assert.equal(await workspaces.isInsideRoots(path.join(fx.ws, 'link-in')), true);
      assert.equal(await workspaces.isInsideRoots(path.join(fx.ws2, 'package.json')), true);
      assert.equal(await workspaces.isInsideRoots(path.join(fx.ws, 'link-out')), false);
      assert.equal(await workspaces.isInsideRoots(path.join(fx.ws, 'missing')), false);
      assert.equal(await workspaces.isInsideRoots(`${tmp}/ws-evil`), false);
      assert.equal(await workspaces.isInsideRoots(fx.outside), false);
      assert.equal(await workspaces.isInsideRoots('relative'), false);
      assert.equal(await workspaces.isInsideRoots(`${fx.ws}\0`), false);
      assert.equal(await workspaces.isInsideRoots(untyped(undefined)), false);
      assert.equal(await workspaces.isInsideRoots(untyped(null)), false);
    });
  });

  describe('listDirs', () => {
    it('lists the roots with basenames and project flags when no path is given', async () => {
      const expected = {
        path: null,
        parent: null,
        entries: [
          { name: 'ws', path: fx.ws, isProject: false },
          { name: 'ws2', path: fx.ws2, isProject: true },
          { name: 'm', path: fx.m, isProject: false },
          { name: 's', path: fx.s, isProject: true },
          { name: 'd', path: fx.d, isProject: false },
          { name: 'c', path: fx.c, isProject: false },
          { name: 'l', path: fx.l, isProject: false },
        ],
      };
      assert.deepEqual(await workspaces.listDirs(), expected);
      assert.deepEqual(await workspaces.listDirs(null), expected);
    });

    it('lists only sub-directories, sorted with numeric collation, without hidden entries', async () => {
      const result = await workspaces.listDirs(fx.ws);
      assert.equal(result.path, fx.ws);
      assert.deepEqual(result.entries.map((entry) => entry.name), [
        'Alpha', 'beta', 'claude-dir', 'docs-md', 'item2', 'item10', 'link-in', 'pkg', 'plain', 'proj', 'zeta',
      ]);
    });

    it('marks directories holding .git, .claude, CLAUDE.md or package.json as projects', async () => {
      const result = await workspaces.listDirs(fx.ws);
      const flags = Object.fromEntries(result.entries.map((entry) => [entry.name, entry.isProject]));
      assert.deepEqual(flags, {
        Alpha: false, beta: false, 'claude-dir': true, 'docs-md': true, item2: false, item10: false,
        'link-in': false, pkg: true, plain: false, proj: true, zeta: false,
      });
    });

    it('keeps the logical path for symlinked entries and resolves a symlinked listing', async () => {
      const root = await workspaces.listDirs(fx.ws);
      const link = root.entries.find((entry) => entry.name === 'link-in');
      assert.equal(link?.path, path.join(fx.ws, 'link-in'));
      const viaLink = await workspaces.listDirs(path.join(fx.ws, 'link-in'));
      assert.equal(viaLink.path, path.join(fx.ws, 'plain'));
      assert.equal(viaLink.parent, fx.ws);
    });

    it('reports the parent inside the roots and nothing above a root', async () => {
      const proj = await workspaces.listDirs(path.join(fx.ws, 'proj'));
      assert.equal(proj.parent, fx.ws);
      assert.deepEqual(proj.entries.map((entry) => entry.path), [path.join(fx.ws, 'proj', 'src')]);
      const src = await workspaces.listDirs(path.join(fx.ws, 'proj', 'src'));
      assert.equal(src.parent, path.join(fx.ws, 'proj'));
      assert.equal((await workspaces.listDirs(fx.ws)).parent, null);
      assert.equal((await workspaces.listDirs(fx.ws2)).parent, null);
    });

    it('treats a root nested inside another root as a root', async () => {
      const nested = createWorkspaces({ roots: [fx.ws, path.join(fx.ws, 'proj')] });
      assert.equal((await nested.listDirs(path.join(fx.ws, 'proj'))).parent, null);
      assert.equal((await nested.listDirs(path.join(fx.ws, 'proj', 'src'))).parent, path.join(fx.ws, 'proj'));
    });

    it('rejects paths outside the roots, files, relative and empty paths', async () => {
      await assertAppError(workspaces.listDirs(fx.outside), 422, 'PATH_NOT_ALLOWED');
      await assertAppError(workspaces.listDirs(path.join(fx.ws, 'file.txt')), 422, 'PATH_NOT_ALLOWED');
      await assertAppError(workspaces.listDirs(`${fx.ws}/../outside`), 422, 'PATH_NOT_ALLOWED');
      await assertAppError(workspaces.listDirs('relative'), 422, 'PATH_NOT_ALLOWED');
      await assertAppError(workspaces.listDirs(''), 422, 'PATH_NOT_ALLOWED');
    });

    it('caps the listing at 500 directories and ignores files', async () => {
      const result = await workspaces.listDirs(fx.l);
      assert.equal(result.entries.length, 500);
      assert.equal(result.entries[0].name, 'd000');
      assert.equal(result.entries[499].name, 'd499');
    });
  });

  describe('mkdir', () => {
    it('creates a directory with mode 0755 and returns its realpath', async () => {
      const result = await workspaces.mkdir(fx.m, 'New Folder-1.v2');
      assert.deepEqual(result, { path: path.join(fx.m, 'New Folder-1.v2') });
      const stat = await fs.promises.stat(result.path);
      assert.ok(stat.isDirectory());
      assert.equal((stat.mode & 0o777) & ~0o755, 0);
      assert.equal(stat.mode & 0o700, 0o700);
    });

    it('accepts the length boundary and punctuation within the allowed set', async () => {
      const longName = 'x'.repeat(100);
      assert.equal((await workspaces.mkdir(fx.m, longName)).path, path.join(fx.m, longName));
      assert.equal((await workspaces.mkdir(fx.m, 'a b-c_d.e')).path, path.join(fx.m, 'a b-c_d.e'));
      assert.equal((await workspaces.mkdir(fx.m, '...')).path, path.join(fx.m, '...'));
    });

    it('rejects invalid names with INVALID_ARGUMENT', async () => {
      const invalid = [
        '', '.', '..', 'a/b', 'a\\b', ' lead', 'trail ', 'tab\there', 'new\nline', 'emoji\u{1F600}', 'Ünicode',
        'semi;colon', '$(id)', 'x'.repeat(101),
      ];
      for (const name of invalid) {
        await assertAppError(workspaces.mkdir(fx.m, name), 422, 'INVALID_ARGUMENT');
      }
      for (const name of [undefined, null, 7, {}]) {
        await assertAppError(workspaces.mkdir(fx.m, untyped(name)), 422, 'INVALID_ARGUMENT');
      }
    });

    it('returns 409 CONFLICT when a directory, a file or a symlink already has the name', async () => {
      await assertAppError(workspaces.mkdir(fx.m, 'exists-dir'), 409, 'CONFLICT');
      await assertAppError(workspaces.mkdir(fx.m, 'exists-file'), 409, 'CONFLICT');
      await assertAppError(workspaces.mkdir(fx.m, 'link-in'), 409, 'CONFLICT');
    });

    it('rejects parents that are outside the roots, files, missing or relative', async () => {
      await assertAppError(workspaces.mkdir(fx.outside, 'evil'), 422, 'PATH_NOT_ALLOWED');
      await assertAppError(workspaces.mkdir(path.join(fx.m, 'exists-file'), 'x'), 422, 'PATH_NOT_ALLOWED');
      await assertAppError(workspaces.mkdir(path.join(fx.m, 'nope'), 'x'), 422, 'PATH_NOT_ALLOWED');
      await assertAppError(workspaces.mkdir('relative', 'x'), 422, 'PATH_NOT_ALLOWED');
      await assertAppError(workspaces.mkdir(`${fx.m}/../outside`, 'x'), 422, 'PATH_NOT_ALLOWED');
      assert.equal(fs.existsSync(path.join(fx.outside, 'evil')), false);
    });

    it('creates inside the realpath of a symlinked parent that stays in the roots', async () => {
      const result = await workspaces.mkdir(path.join(fx.m, 'link-in'), 'via-link');
      assert.equal(result.path, path.join(fx.m, 'exists-dir', 'via-link'));
    });

    it('refuses a symlinked parent that leaves the roots', async () => {
      await assertAppError(workspaces.mkdir(path.join(fx.m, 'link-out'), 'x'), 422, 'PATH_NOT_ALLOWED');
      assert.equal(fs.existsSync(path.join(fx.outside, 'x')), false);
    });
  });

  describe('search', () => {
    it('ranks a basename prefix match above longer and weaker matches', async () => {
      const { results } = await workspaces.search(fx.s, 'state');
      assert.equal(results[0].path, 'src/state.mjs');
      assert.equal(results[0].type, 'file');
    });

    it('matches case-insensitively and by subsequence, and ranks basename prefixes first', async () => {
      const upper = await workspaces.search(fx.s, 'WS');
      assert.equal(upper.results[0].path, 'docs/ws-notes.md');
      const subsequence = await workspaces.search(fx.s, 'wsnotes');
      assert.ok(subsequence.results.some((entry) => entry.path === 'docs/ws-notes.md'));
    });

    it('returns matching directories with type dir', async () => {
      const { results } = await workspaces.search(fx.s, 'unit');
      assert.ok(results.some((entry) => entry.path === 'test/unit' && entry.type === 'dir'));
    });

    it('returns nothing for an unmatched query', async () => {
      assert.deepEqual((await workspaces.search(fx.s, 'zzqx')).results, []);
    });

    it('skips node_modules, .git, .caw-uploads and hidden directories', async () => {
      const paths = async (q) => (await workspaces.search(fx.s, q, 200)).results.map((entry) => entry.path);
      assert.equal((await paths('index')).some((p) => p.startsWith('node_modules')), false);
      assert.equal((await paths('config')).some((p) => p.startsWith('.git')), false);
      assert.equal((await paths('work')).some((p) => p.startsWith('.caw-uploads')), false);
      assert.equal((await paths('key')).some((p) => p.startsWith('.secret')), false);
    });

    it('includes hidden files that are not inside a skipped directory', async () => {
      const { results } = await workspaces.search(fx.s, 'env');
      assert.ok(results.some((entry) => entry.path === '.env' && entry.type === 'file'));
    });

    it('lists a symlinked directory as a leaf without descending into it', async () => {
      const attachments = await workspaces.search(fx.s, 'attachments', 200);
      assert.ok(attachments.results.some((entry) => entry.path === 'src/attachments.mjs'));
      assert.equal(attachments.results.some((entry) => entry.path.startsWith('linkdir/')), false);
      const link = await workspaces.search(fx.s, 'linkdir');
      assert.ok(link.results.some((entry) => entry.path === 'linkdir' && entry.type === 'dir'));
    });

    it('lists symlinked files only when their target stays inside the roots', async () => {
      const inside = await workspaces.search(fx.s, 'linked-file');
      assert.ok(inside.results.some((entry) => entry.path === 'linked-file.md' && entry.type === 'file'));
      assert.deepEqual((await workspaces.search(fx.s, 'escape')).results, []);
      assert.deepEqual((await workspaces.search(fx.s, 'outward')).results, []);
      const secret = await workspaces.search(fx.s, 'secret', 200);
      assert.equal(secret.results.some((entry) => entry.path.includes('outside-dir')), false);
    });

    it('returns only files for an empty query, most recently modified first', async () => {
      const now = Date.now() / 1000;
      await fs.promises.utimes(path.join(fx.s, 'README.md'), now + 300, now + 300);
      await fs.promises.utimes(path.join(fx.s, 'src', 'state.mjs'), now + 200, now + 200);
      await fs.promises.utimes(path.join(fx.s, 'src', 'workspaces.mjs'), now + 100, now + 100);
      for (const q of ['', undefined]) {
        const { results } = await workspaces.search(fx.s, untyped(q), 200);
        assert.ok(results.every((entry) => entry.type === 'file'));
        assert.ok(['README.md', 'linked-file.md'].includes(results[0].path));
        const paths = results.map((entry) => entry.path);
        assert.ok(paths.indexOf('src/state.mjs') < paths.indexOf('src/workspaces.mjs'));
        assert.ok(!paths.some((p) => p.startsWith('.caw-uploads') || p.startsWith('node_modules')));
      }
    });

    it('returns only relative paths that stay below the search directory', async () => {
      const { results } = await workspaces.search(fx.s, 'e', 200);
      for (const entry of results) {
        assert.equal(path.isAbsolute(entry.path), false);
        assert.equal(entry.path.split('/').includes('..'), false);
      }
    });

    it('rejects queries that are not strings or are longer than 256 characters', async () => {
      await assertAppError(workspaces.search(fx.s, 'a'.repeat(257)), 422, 'INVALID_ARGUMENT');
      await assertAppError(workspaces.search(fx.s, untyped(42)), 422, 'INVALID_ARGUMENT');
      await assertAppError(workspaces.search(fx.s, untyped({})), 422, 'INVALID_ARGUMENT');
    });

    it('validates the search directory', async () => {
      await assertAppError(workspaces.search(fx.outsideDir, 'a'), 422, 'PATH_NOT_ALLOWED');
      await assertAppError(workspaces.search(path.join(fx.s, 'README.md'), 'a'), 422, 'PATH_NOT_ALLOWED');
      await assertAppError(workspaces.search('relative', 'a'), 422, 'PATH_NOT_ALLOWED');
    });

    it('clamps the limit to 1-200 with a default of 50', async () => {
      assert.equal((await workspaces.search(fx.c, 'f0', 2)).results.length, 2);
      assert.equal((await workspaces.search(fx.c, 'f0', 2.9)).results.length, 2);
      assert.equal((await workspaces.search(fx.c, 'f0', 0)).results.length, 1);
      assert.equal((await workspaces.search(fx.c, 'f0', -5)).results.length, 1);
      assert.equal((await workspaces.search(fx.c, 'f0', Number.NaN)).results.length, 50);
      assert.equal((await workspaces.search(fx.c, 'f0')).results.length, 50);
      assert.equal((await workspaces.search(fx.c, 'f0', 1e9)).results.length, 200);
    });
  });

  describe('walk bounds', () => {
    it('lists entries up to depth 12 and never descends below it', async () => {
      const { results } = await workspaces.search(fx.d, 'at-d', 200);
      const paths = results.map((entry) => entry.path);
      assert.ok(paths.every((p) => p.split('/').length <= 12));
      assert.ok(paths.includes(['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9', 'd10', 'd11', 'at-d11.txt']
        .join('/')));
      assert.equal(paths.some((p) => p.endsWith('at-d12.txt')), false);
    });

    it('stops after 20 000 directory entries in total', async () => {
      const reads = { count: 0 };
      const original = fs.Dir.prototype.read;
      mock.method(fs.Dir.prototype, 'read', /** @this {unknown} */ async function countedRead(...args) {
        const dirent = await original.apply(this, args);
        if (dirent !== null) {
          reads.count += 1;
        }
        return dirent;
      });
      const { results } = await workspaces.search(fx.c, 'f0');
      assert.equal(reads.count, 20000);
      assert.equal(results.length, 50);
      mock.restoreAll();
    });
  });

  describe('configuration', () => {
    it('rejects roots that are not an array or not absolute', () => {
      assert.throws(() => createWorkspaces(untyped({ roots: 'x' })), TypeError);
      assert.throws(() => createWorkspaces({ roots: ['relative'] }), TypeError);
    });

    it('normalises trailing separators in roots', () => {
      const normalised = createWorkspaces({ roots: [`${fx.ws}/`] });
      assert.deepEqual(normalised.roots, [fx.ws]);
    });

    it('treats the filesystem root as a root when configured', async () => {
      const everything = createWorkspaces({ roots: ['/'] });
      assert.equal(await everything.isInsideRoots(fx.ws), true);
      assert.equal(await everything.resolveDir(fx.ws), fx.ws);
      assert.deepEqual((await everything.listDirs()).entries.map((entry) => [entry.name, entry.path]), [['/', '/']]);
    });

    it('rejects every path when no roots are configured', async () => {
      const none = createWorkspaces({ roots: [] });
      assert.equal(await none.isInsideRoots(fx.ws), false);
      await assertAppError(none.resolveDir(fx.ws), 422, 'PATH_NOT_ALLOWED');
    });
  });
});
