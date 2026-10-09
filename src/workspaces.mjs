// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { AppError, UPLOAD_DIR_NAME } from './contracts.mjs';

/** @typedef {import('./contracts.mjs').Config} Config */
/** @typedef {import('./contracts.mjs').WorkspacesApi} WorkspacesApi */
/** @typedef {import('./state.mjs').StateStore} StateStore */

/**
 * @typedef {Object} Containment
 * @property {string[]} roots                                     realpath'd absolute roots
 * @property {(real: string) => boolean} contains                 true when `real` equals a root or lies below one
 * @property {(p: unknown) => Promise<string|null>} realpathInside realpath of `p` when it exists and is contained
 * @property {(p: unknown) => Promise<string>} resolveDir          realpath of an existing contained directory
 */

/**
 * @typedef {Object} SearchEntry
 * @property {string} rel
 * @property {'file'|'dir'} type
 * @property {number} mtimeMs
 */

const MAX_LIST_ENTRIES = 500;
const PROJECT_MARKERS = ['.git', '.claude', 'CLAUDE.md', 'package.json'];
const DIR_NAME_RE = /^[A-Za-z0-9._ -]{1,100}$/;
const SEARCH_SKIP_NAMES = new Set(['.git', 'node_modules', UPLOAD_DIR_NAME]);
const SEARCH_MAX_VISITED = 20000;
const SEARCH_MAX_DEPTH = 12;
const SEARCH_MAX_QUERY = 256;
const SEARCH_DEFAULT_LIMIT = 50;
const SEARCH_MAX_LIMIT = 200;
const WORD_BOUNDARIES = new Set(['/', '.', '-', '_', ' ']);
const TRUST_STATE = 'trusted-dirs';
const TRUST_LIMIT = 1000;
const PATH_MAX_LENGTH = 4096;

/** @returns {AppError} */
function notAllowed() {
  return new AppError(422, 'PATH_NOT_ALLOWED', 'path is not an existing directory inside a workspace root');
}

/**
 * @param {unknown} err
 * @returns {string|undefined}
 */
function errnoOf(err) {
  return err && typeof err === 'object' && 'code' in err ? String(err.code) : undefined;
}

/**
 * @param {string} p
 * @returns {Promise<import('node:fs').Stats|null>}
 */
function statOrNull(p) {
  return fs.promises.stat(p).catch(() => null);
}

/**
 * @param {string[]} configRoots
 * @returns {Containment}
 */
function createContainment(configRoots) {
  if (!Array.isArray(configRoots)) {
    throw new TypeError('config.roots must be an array of absolute paths');
  }
  const roots = configRoots.map((root) => {
    if (typeof root !== 'string' || !path.isAbsolute(root)) {
      throw new TypeError('workspace roots must be absolute paths');
    }
    return path.resolve(root);
  });
  const prefixes = roots.map((root) => (root.endsWith(path.sep) ? root : root + path.sep));

  /** @param {string} real */
  const contains = (real) => roots.includes(real) || prefixes.some((prefix) => real.startsWith(prefix));

  /**
   * Never throws: a missing path, a relative path, a path with NUL bytes or a path outside the roots yields null.
   * @param {unknown} p
   * @returns {Promise<string|null>}
   */
  async function realpathInside(p) {
    if (typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0')) {
      return null;
    }
    try {
      const real = await fs.promises.realpath(p);
      return contains(real) ? real : null;
    } catch {
      return null;
    }
  }

  /**
   * @param {unknown} p
   * @returns {Promise<string>}
   */
  async function resolveDir(p) {
    const real = await realpathInside(p);
    if (real === null) {
      throw notAllowed();
    }
    const stat = await statOrNull(real);
    if (stat === null || !stat.isDirectory()) {
      throw notAllowed();
    }
    return real;
  }

  return { roots, contains, realpathInside, resolveDir };
}

/**
 * @param {string} dir
 * @returns {Promise<boolean>}
 */
async function isProjectDir(dir) {
  const found = await Promise.all(PROJECT_MARKERS.map((marker) => statOrNull(path.join(dir, marker))));
  return found.some((stat) => stat !== null);
}

/**
 * @param {Containment} containment
 * @param {import('node:fs').Dirent} dirent
 * @param {string} abs
 * @returns {Promise<boolean>}
 */
async function isDirectoryEntry(containment, dirent, abs) {
  if (dirent.isDirectory()) {
    return true;
  }
  if (!dirent.isSymbolicLink()) {
    return false;
  }
  const target = await containment.realpathInside(abs);
  const stat = target === null ? null : await statOrNull(target);
  return stat !== null && stat.isDirectory();
}

/**
 * @param {Containment} containment
 * @param {string} dir realpath of a contained directory
 * @returns {string|null}
 */
function parentOf(containment, dir) {
  if (containment.roots.includes(dir)) {
    return null;
  }
  const parent = path.dirname(dir);
  return parent !== dir && containment.contains(parent) ? parent : null;
}

/**
 * @param {string} dir
 * @returns {Promise<import('node:fs').Dirent[]>}
 */
async function readDirents(dir) {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = errnoOf(err);
    if (code === 'EACCES' || code === 'EPERM') {
      throw new AppError(422, 'PATH_NOT_ALLOWED', 'directory cannot be read');
    }
    throw err;
  }
}

/**
 * @param {{name: string}} a
 * @param {{name: string}} b
 * @returns {number}
 */
function byName(a, b) {
  return a.name.localeCompare(b.name, 'en', { numeric: true });
}

/**
 * @param {Containment} containment
 * @param {string|null|undefined} p
 * @returns {Promise<{path: string|null, parent: string|null,
 *   entries: Array<{name: string, path: string, isProject: boolean}>}>}
 */
async function listDirs(containment, p) {
  if (p === undefined || p === null) {
    const entries = await Promise.all(containment.roots.map(async (root) => ({
      name: path.basename(root) || root,
      path: root,
      isProject: await isProjectDir(root),
    })));
    return { path: null, parent: null, entries };
  }
  const dir = await containment.resolveDir(p);
  const sorted = (await readDirents(dir)).filter((dirent) => !dirent.name.startsWith('.')).sort(byName);
  /** @type {Array<{name: string, path: string}>} */
  const picked = [];
  for (const dirent of sorted) {
    if (picked.length === MAX_LIST_ENTRIES) {
      break;
    }
    const abs = path.join(dir, dirent.name);
    if (await isDirectoryEntry(containment, dirent, abs)) {
      picked.push({ name: dirent.name, path: abs });
    }
  }
  const entries = await Promise.all(picked.map(async (entry) => ({
    ...entry,
    isProject: await isProjectDir(entry.path),
  })));
  return { path: dir, parent: parentOf(containment, dir), entries };
}

/**
 * @param {unknown} name
 * @returns {boolean}
 */
function isValidDirName(name) {
  return typeof name === 'string' && DIR_NAME_RE.test(name) && name !== '.' && name !== '..' && name === name.trim();
}

/**
 * @param {Containment} containment
 * @param {string} parent
 * @param {string} name
 * @returns {Promise<{path: string}>}
 */
async function makeDirectory(containment, parent, name) {
  if (!isValidDirName(name)) {
    throw new AppError(422, 'INVALID_ARGUMENT',
      'name must be 1-100 characters from A-Z, a-z, 0-9, ".", "_", "-" or space, not "." or "..", '
      + 'and without leading or trailing spaces');
  }
  const dir = await containment.resolveDir(parent);
  const target = path.join(dir, name);
  try {
    await fs.promises.mkdir(target, { mode: 0o755 });
  } catch (err) {
    const code = errnoOf(err);
    if (code === 'EEXIST') {
      throw new AppError(409, 'CONFLICT', 'a file or directory with this name already exists');
    }
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
      throw new AppError(422, 'PATH_NOT_ALLOWED', 'parent directory is not writable');
    }
    throw err;
  }
  const real = await containment.realpathInside(target);
  if (real === null) {
    throw notAllowed();
  }
  return { path: real };
}

/**
 * @param {unknown} q
 * @returns {string} trimmed, lower-cased query; '' means "recently modified files"
 */
function normalizeQuery(q) {
  if (q === undefined || q === null) {
    return '';
  }
  if (typeof q !== 'string') {
    throw new AppError(422, 'INVALID_ARGUMENT', 'q must be a string');
  }
  const query = q.trim();
  if (query.length > SEARCH_MAX_QUERY) {
    throw new AppError(422, 'INVALID_ARGUMENT', `q must be at most ${SEARCH_MAX_QUERY} characters`);
  }
  return query.toLowerCase();
}

/**
 * @param {unknown} limit
 * @returns {number}
 */
function clampLimit(limit) {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    return SEARCH_DEFAULT_LIMIT;
  }
  return Math.min(SEARCH_MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

/**
 * Classifies one entry of the search walk. Symlinks are resolved and must stay inside the roots; a symlinked directory
 * is listed as a leaf but is never descended into. Hidden directories are not listed.
 * @param {Containment} containment
 * @param {import('node:fs').Dirent} dirent
 * @param {string} abs
 * @param {boolean} needMtime
 * @returns {Promise<{type: 'file'|'dir', mtimeMs: number}|null>}
 */
async function classifyEntry(containment, dirent, abs, needMtime) {
  if (SEARCH_SKIP_NAMES.has(dirent.name)) {
    return null;
  }
  /** @type {import('node:fs').Stats|null} */
  let stat = null;
  /** @type {'file'|'dir'|null} */
  let type = null;
  if (dirent.isSymbolicLink()) {
    const target = await containment.realpathInside(abs);
    stat = target === null ? null : await statOrNull(target);
    if (stat !== null && stat.isFile()) {
      type = 'file';
    } else if (stat !== null && stat.isDirectory()) {
      type = 'dir';
    }
  } else if (dirent.isFile()) {
    type = 'file';
  } else if (dirent.isDirectory()) {
    type = 'dir';
  }
  if (type === null || (type === 'dir' && dirent.name.startsWith('.'))) {
    return null;
  }
  let mtimeMs = 0;
  if (type === 'file' && needMtime) {
    stat = stat ?? (await statOrNull(abs));
    if (stat === null) {
      return null;
    }
    mtimeMs = stat.mtimeMs;
  }
  return { type, mtimeMs };
}

/**
 * Breadth-first walk of `base`. Symlinked directories are never followed, depth is limited to SEARCH_MAX_DEPTH and at
 * most SEARCH_MAX_VISITED directory entries are examined in total.
 * @param {Containment} containment
 * @param {string} base
 * @param {boolean} needMtime
 * @returns {Promise<SearchEntry[]>}
 */
async function walkEntries(containment, base, needMtime) {
  /** @type {SearchEntry[]} */
  const found = [];
  /** @type {Array<{abs: string, rel: string, depth: number}>} */
  const queue = [{ abs: base, rel: '', depth: 0 }];
  let visited = 0;
  for (let next = 0; next < queue.length && visited < SEARCH_MAX_VISITED; next += 1) {
    const current = queue[next];
    const dir = await openDirOrNull(current.abs);
    if (dir === null) {
      continue;
    }
    try {
      while (visited < SEARCH_MAX_VISITED) {
        const dirent = await readNextOrNull(dir);
        if (dirent === null) {
          break;
        }
        visited += 1;
        const abs = path.join(current.abs, dirent.name);
        const entry = await classifyEntry(containment, dirent, abs, needMtime);
        if (entry === null) {
          continue;
        }
        const rel = current.rel === '' ? dirent.name : `${current.rel}/${dirent.name}`;
        found.push({ rel, ...entry });
        if (entry.type === 'dir' && !dirent.isSymbolicLink() && current.depth + 1 < SEARCH_MAX_DEPTH) {
          queue.push({ abs, rel, depth: current.depth + 1 });
        }
      }
    } finally {
      await dir.close();
    }
  }
  return found;
}

/**
 * @param {string} dir
 * @returns {Promise<import('node:fs').Dir|null>}
 */
async function openDirOrNull(dir) {
  try {
    return await fs.promises.opendir(dir);
  } catch {
    return null;
  }
}

/**
 * A read error ends the listing of that directory; the walk continues with the next one.
 * @param {import('node:fs').Dir} dir
 * @returns {Promise<import('node:fs').Dirent|null>}
 */
async function readNextOrNull(dir) {
  try {
    return await dir.read();
  } catch {
    return null;
  }
}

/**
 * Greedy left-to-right match of every code point of `query` inside `text`.
 * @param {string} text
 * @param {string} query
 * @returns {number[]|null} positions of the matched code units, or null when `query` is not a subsequence
 */
function subsequencePositions(text, query) {
  /** @type {number[]} */
  const positions = [];
  let from = 0;
  for (const ch of query) {
    const at = text.indexOf(ch, from);
    if (at === -1) {
      return null;
    }
    positions.push(at);
    from = at + ch.length;
  }
  return positions;
}

/**
 * Scores a case-insensitive subsequence match. Rewards word-start and contiguous matches, basename matches and prefix
 * matches; penalises gaps and long paths.
 * @param {string} rel relative path with '/' separators
 * @param {string} query lower-cased, non-empty
 * @returns {number|null} null when `query` does not match `rel`
 */
function scoreEntry(rel, query) {
  const text = rel.toLowerCase();
  const positions = subsequencePositions(text, query);
  if (positions === null) {
    return null;
  }
  const baseStart = text.lastIndexOf('/') + 1;
  const base = text.slice(baseStart);
  let score = 0;
  for (let i = 0; i < positions.length; i += 1) {
    const at = positions[i];
    score += 1;
    if (i > 0 && at === positions[i - 1] + 1) {
      score += 5;
    }
    if (at === 0 || WORD_BOUNDARIES.has(text[at - 1])) {
      score += 4;
    }
  }
  const gaps = positions[positions.length - 1] - positions[0] + 1 - positions.length;
  score -= gaps;
  if (base === query) {
    score += 100;
  } else if (base.startsWith(query)) {
    score += 60;
  } else if (base.includes(query)) {
    score += 40;
  } else if (positions[0] >= baseStart) {
    score += 20;
  }
  if (text.startsWith(query)) {
    score += 50;
  }
  return score - text.length * 0.1;
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareText(a, b) {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/**
 * @param {SearchEntry[]} entries
 * @param {string} query lower-cased; '' selects the most recently modified files
 * @returns {SearchEntry[]}
 */
function rankEntries(entries, query) {
  if (query === '') {
    return entries
      .filter((entry) => entry.type === 'file')
      .sort((a, b) => b.mtimeMs - a.mtimeMs || compareText(a.rel, b.rel));
  }
  return entries
    .map((entry) => ({ entry, score: scoreEntry(entry.rel, query) }))
    .filter((item) => item.score !== null)
    .sort((a, b) => b.score - a.score
      || a.entry.rel.length - b.entry.rel.length
      || compareText(a.entry.rel, b.entry.rel))
    .map((item) => item.entry);
}

/**
 * @param {Containment} containment
 * @param {string} cwd
 * @param {unknown} q
 * @param {number} [limit]
 * @returns {Promise<{results: Array<{path: string, type: 'file'|'dir'}>}>}
 */
async function searchFiles(containment, cwd, q, limit) {
  const query = normalizeQuery(q);
  const max = clampLimit(limit);
  const base = await containment.resolveDir(cwd);
  const entries = await walkEntries(containment, base, query === '');
  const ranked = rankEntries(entries, query).slice(0, max);
  return { results: ranked.map((entry) => ({ path: entry.rel, type: entry.type })) };
}

/**
 * @param {string} dir
 * @returns {string}
 */
function prefixOf(dir) {
  return dir.endsWith(path.sep) ? dir : dir + path.sep;
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isStoredDir(value) {
  return typeof value === 'string' && value.length <= PATH_MAX_LENGTH && path.isAbsolute(value)
    && !value.includes('\0');
}

/**
 * Unique entries, oldest first; when there are more than TRUST_LIMIT the newest are kept.
 * @param {Iterable<unknown>} values
 * @returns {string[]}
 */
function normalizeStoredDirs(values) {
  /** @type {Map<string, true>} */
  const unique = new Map();
  for (const value of values) {
    if (isStoredDir(value)) {
      unique.delete(value);
      unique.set(value, true);
    }
  }
  return [...unique.keys()].slice(-TRUST_LIMIT);
}

/**
 * @param {string[]} dirs
 * @param {string} dir
 * @returns {string[]} the list with `dir` at the newest position
 */
function withNewest(dirs, dir) {
  return [...dirs.filter((entry) => entry !== dir), dir].slice(-TRUST_LIMIT);
}

/**
 * Serialised, cached list of trusted folders. Without a state store the list lives in memory only.
 * @param {StateStore|undefined} stateStore
 */
function createTrustStore(stateStore) {
  /** @type {Promise<string[]>|null} */
  let current = null;
  /** @type {Promise<void>} */
  let queue = Promise.resolve();

  /** @returns {Promise<string[]>} */
  function load() {
    current ??= stateStore ? readStoredTrust(stateStore) : Promise.resolve([]);
    return current;
  }

  /**
   * @param {(dirs: string[]) => string[]} change
   * @returns {Promise<void>}
   */
  function update(change) {
    const run = queue.then(async () => {
      const next = change(await load());
      if (stateStore) {
        await stateStore.write(TRUST_STATE, { dirs: next });
      }
      current = Promise.resolve(next);
    });
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  return { load, update };
}

/**
 * A missing or corrupt record reads as an empty list.
 * @param {StateStore} stateStore
 * @returns {Promise<string[]>}
 */
async function readStoredTrust(stateStore) {
  const state = await stateStore.read(TRUST_STATE, { dirs: /** @type {unknown[]} */ ([]) });
  return normalizeStoredDirs(Array.isArray(state?.dirs) ? state.dirs : []);
}

/**
 * A trusted entry counts only while it still resolves to the same directory; removed or replaced entries are ignored.
 * @param {string} dir
 * @returns {Promise<boolean>}
 */
async function isLiveDirectory(dir) {
  try {
    const real = await fs.promises.realpath(dir);
    return real === dir && (await fs.promises.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * @param {Containment} containment
 * @param {ReturnType<typeof createTrustStore>} trust
 * @param {unknown} p
 * @returns {Promise<boolean>} true when the realpath equals or lies below a trusted folder; never throws
 */
async function isTrustedPath(containment, trust, p) {
  try {
    const real = await containment.realpathInside(p);
    if (real === null) {
      return false;
    }
    for (const entry of await trust.load()) {
      if ((real === entry || real.startsWith(prefixOf(entry))) && (await isLiveDirectory(entry))) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Records or removes trust for a folder inside the roots. Returns the effective trust afterwards, so a folder that is
 * still covered by a trusted parent reports true.
 * @param {Containment} containment
 * @param {ReturnType<typeof createTrustStore>} trust
 * @param {unknown} p
 * @param {unknown} trusted
 * @returns {Promise<{path: string, trusted: boolean}>}
 */
async function setTrustedDir(containment, trust, p, trusted) {
  if (typeof trusted !== 'boolean') {
    throw new AppError(422, 'INVALID_ARGUMENT', 'trusted must be a boolean');
  }
  const dir = await containment.resolveDir(p);
  await trust.update((dirs) => (trusted ? withNewest(dirs, dir) : dirs.filter((entry) => entry !== dir)));
  return { path: dir, trusted: await isTrustedPath(containment, trust, dir) };
}

/**
 * Workspace filesystem services: root containment, directory browsing, directory creation, file mention search and
 * folder trust. Every path the caller supplies is resolved with realpath and must stay inside a configured root.
 * @param {Config} config
 * @param {{stateStore?: StateStore}} [options] trust is kept in `stateStore` under 'trusted-dirs' when given, else in
 *   memory
 * @returns {WorkspacesApi}
 */
export function createWorkspaces(config, { stateStore } = {}) {
  if (stateStore !== undefined && (typeof stateStore?.read !== 'function' || typeof stateStore?.write !== 'function')) {
    throw new TypeError('stateStore must provide read and write');
  }
  const containment = createContainment(config.roots);
  const trust = createTrustStore(stateStore);
  return {
    roots: [...containment.roots],
    resolveDir: (p) => containment.resolveDir(p),
    isInsideRoots: async (p) => (await containment.realpathInside(p)) !== null,
    listDirs: (p) => listDirs(containment, p),
    mkdir: (parent, name) => makeDirectory(containment, parent, name),
    search: (cwd, q, limit) => searchFiles(containment, cwd, q, limit),
    isTrusted: (p) => isTrustedPath(containment, trust, p),
    setTrusted: (p, trusted) => setTrustedDir(containment, trust, p, trusted),
  };
}
