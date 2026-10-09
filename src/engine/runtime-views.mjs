// @ts-check
/**
 * Helpers behind the runtime's own screens and files: feature detection of the runtime methods that have no public
 * typings, the timeout of a control call, the read-only views (their arguments and the redaction of settings), the
 * export name, the memory files the runtime lists and their atomic save, and the mapping of a few runtime answers
 * (file suggestions, interrupt receipts). Nothing here keeps state; every answer is passed on as data.
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AppError, RUNTIME_VIEWS } from '../contracts.mjs';

/** @typedef {import('../contracts.mjs').SdkQuery} SdkQuery */

export const CONTROL_TIMEOUT_MS = 10_000;
export const TIMEOUT_MESSAGE = 'The Claude Code runtime did not respond in time.';
export const MEMORY_MAX_BYTES = 262_144;
export const MEMORY_FILE_NAMES = ['CLAUDE.md', 'CLAUDE.local.md'];
const REDACTED = '[redacted]';
const EXPORT_NAME_RE = /[^A-Za-z0-9._-]/g;

/** A control call of the runtime that did not settle within its time limit. */
export class ControlTimeout extends Error {
  constructor() {
    super(TIMEOUT_MESSAGE);
    this.name = 'ControlTimeout';
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * The first line of a text, at most 300 characters, or the fallback when there is none.
 * @param {unknown} text
 * @param {string} fallback
 * @returns {string}
 */
export function firstLine(text, fallback) {
  const line = (typeof text === 'string' ? text : '').split('\n')[0].trim().slice(0, 300);
  return line || fallback;
}

/**
 * Runs one control call of the runtime and rejects with ControlTimeout when it does not settle in time.
 * @template T
 * @param {() => Promise<T>} call
 * @param {number} [ms]
 * @returns {Promise<T>}
 */
export async function withTimeout(call, ms = CONTROL_TIMEOUT_MS) {
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new ControlTimeout()), ms);
  });
  try {
    return await Promise.race([call(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A runtime method of the query, bound to it, or null when the installed runtime does not offer it. The returned
 * function always answers with a promise: a synchronous throw becomes a rejection.
 * @param {SdkQuery|null|undefined} query
 * @param {string} name
 * @returns {((...args: unknown[]) => Promise<unknown>)|null}
 */
export function runtimeMethod(query, name) {
  if (!query) return null;
  const value = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (query))[name];
  if (typeof value !== 'function') return null;
  return async (...args) => value.apply(query, args);
}

/**
 * The runtime views a query offers: those whose method is present (docs/PROTOCOL.md "Runtime views").
 * @param {SdkQuery} query
 * @returns {string[]}
 */
export function availableViews(query) {
  return Object.keys(RUNTIME_VIEWS).filter((name) => runtimeMethod(query, RUNTIME_VIEWS[name].method) !== null);
}

/**
 * The arguments of a view's runtime call. The usage view skips the scan of local transcripts.
 * @param {string} view
 * @returns {unknown[]}
 */
export function viewArguments(view) {
  return view === 'usage' ? [{ skipBehaviors: true }] : [];
}

/**
 * A deep copy of runtime settings in which every value stored under an `env` key is replaced by "[redacted]".
 * @param {unknown} value
 * @returns {unknown}
 */
export function redactSettings(value) {
  if (Array.isArray(value)) return value.map((item) => redactSettings(item));
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    key === 'env' ? redactEnvironment(item) : redactSettings(item),
  ]));
}

/**
 * @param {unknown} env
 * @returns {unknown}
 */
function redactEnvironment(env) {
  if (!isPlainObject(env)) return REDACTED;
  return Object.fromEntries(Object.keys(env).map((name) => [name, REDACTED]));
}

/**
 * The download name of an exported conversation: the runtime's default name reduced to letters, digits, dot,
 * underscore and hyphen, without leading dots, and ending in .txt.
 * @param {unknown} value
 * @returns {string}
 */
export function exportFilename(value) {
  const reduced = (typeof value === 'string' ? value : '').replace(EXPORT_NAME_RE, '').replace(/^\.+/, '');
  if (reduced === '') return 'conversation.txt';
  return reduced.endsWith('.txt') ? reduced : `${reduced}.txt`;
}

/**
 * @param {unknown} value
 * @returns {string[]} the string items of a list; anything else is dropped
 */
export function stringsOf(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

/**
 * The interrupt receipt of the runtime: the uuids of the queued messages that will still run and of those it cancelled.
 * @param {unknown} receipt
 * @returns {{stillQueued: string[], cancelled: string[]}}
 */
export function interruptReceipt(receipt) {
  const source = isPlainObject(receipt) ? receipt : {};
  return { stillQueued: stringsOf(source.still_queued), cancelled: stringsOf(source.cancelled) };
}

/**
 * Entries of a runtime file_suggestions answer, relative to the folder. A trailing slash marks a folder; absolute
 * paths, paths with a `..` segment and empty paths are dropped; the list is capped at `limit`.
 * @param {unknown} answer the envelope of the request, or its response already unwrapped
 * @param {number} limit
 * @returns {Array<{path: string, type: 'file'|'dir'}>}
 */
export function fileSuggestionsOf(answer, limit) {
  const envelope = isPlainObject(answer) ? answer : {};
  const body = isPlainObject(envelope.response) ? envelope.response : envelope;
  const list = Array.isArray(body.suggestions) ? body.suggestions : [];
  /** @type {Array<{path: string, type: 'file'|'dir'}>} */
  const results = [];
  for (const item of list) {
    if (results.length >= limit) break;
    const entry = suggestionOf(isPlainObject(item) ? item.path : undefined);
    if (entry !== null) results.push(entry);
  }
  return results;
}

/**
 * @param {unknown} raw
 * @returns {{path: string, type: 'file'|'dir'}|null}
 */
function suggestionOf(raw) {
  if (typeof raw !== 'string') return null;
  const isDir = raw.endsWith('/');
  const name = isDir ? raw.slice(0, -1) : raw;
  if (name === '' || path.isAbsolute(name) || name.includes('\u0000') || name.split('/').includes('..')) return null;
  return { path: name, type: isDir ? 'dir' : 'file' };
}

/**
 * Whether a value is an absolute URL of at most `maxLength` characters whose scheme is one of `protocols`.
 * @param {unknown} value
 * @param {number} maxLength
 * @param {readonly string[]} protocols e.g. ['http:', 'https:']
 * @returns {boolean}
 */
export function isWebUrl(value, maxLength, protocols) {
  if (typeof value !== 'string' || value.length > maxLength) return false;
  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * @param {string} p
 * @returns {Promise<string|null>} the real path, or null when it does not exist or cannot be resolved
 */
export async function realpathOrNull(p) {
  try {
    return await fs.promises.realpath(p);
  } catch {
    return null;
  }
}

/**
 * @param {string} p
 * @returns {Promise<fs.Stats|null>} the attributes of the entry itself (a symbolic link is not followed)
 */
async function lstatOrNull(p) {
  try {
    return await fs.promises.lstat(p);
  } catch {
    return null;
  }
}

/**
 * Whether two folders are the same folder once resolved. Either one missing counts as different.
 * @param {string} a
 * @param {string} b
 * @returns {Promise<boolean>}
 */
export async function sameDirectory(a, b) {
  const [realA, realB] = await Promise.all([realpathOrNull(a), realpathOrNull(b)]);
  return realA !== null && realA === realB;
}

/**
 * @param {string} real an absolute real path
 * @param {readonly string[]} directories real directories
 * @returns {boolean} true when `real` equals one of them or lies below one
 */
function isInside(real, directories) {
  return directories.some((dir) => real === dir || real.startsWith(dir + path.sep));
}

/**
 * The memory files the runtime lists for a session, with the fields the gateway passes on. Entries without a path are
 * dropped.
 * @param {unknown} dialog the answer of getMemoryDialog
 * @returns {Array<{kind: string, path: string, label: string, description: string, exists: boolean}>}
 */
export function listedMemoryFiles(dialog) {
  const files = isPlainObject(dialog) && Array.isArray(dialog.files) ? dialog.files : [];
  /** @type {Array<{kind: string, path: string, label: string, description: string, exists: boolean}>} */
  const listed = [];
  for (const entry of files) {
    if (!isPlainObject(entry) || typeof entry.path !== 'string' || entry.path === '') continue;
    listed.push({
      kind: typeof entry.kind === 'string' ? entry.kind : '',
      path: entry.path,
      label: typeof entry.label === 'string' ? entry.label : '',
      description: typeof entry.description === 'string' ? entry.description : '',
      exists: entry.exists === true,
    });
  }
  return listed;
}

/**
 * Where the gateway may save memory files: the workspace roots and the user's `.claude` folder (both real paths).
 * @typedef {Object} MemoryLocations
 * @property {string[]} roots
 * @property {string} home   the home directory whose `.claude` folder holds the user's memory and state
 */

/**
 * Whether the gateway may save a memory file the runtime lists: a CLAUDE.md or CLAUDE.local.md that is not a symbolic
 * link, and whose real path (for a missing file, its parent's) lies inside a workspace root or inside `$HOME/.claude`.
 * A missing parent counts only when it lies under `$HOME/.claude`; writing creates it there.
 * @param {string} file
 * @param {MemoryLocations} locations
 * @returns {Promise<boolean>}
 */
export async function isEditableMemoryFile(file, { roots, home }) {
  if (!path.isAbsolute(file) || !MEMORY_FILE_NAMES.includes(path.basename(file))) return false;
  const claudeHome = path.join(home, '.claude');
  const realClaudeHome = await realpathOrNull(claudeHome);
  const allowed = realClaudeHome === null ? roots : [...roots, realClaudeHome];
  const existing = await lstatOrNull(file);
  if (existing !== null) {
    // lstat reports a symbolic link as a link, so a link is never a regular file here.
    if (!existing.isFile()) return false;
    const real = await realpathOrNull(file);
    return real !== null && isInside(real, allowed);
  }
  const parent = path.dirname(file);
  const realParent = await realpathOrNull(parent);
  if (realParent !== null) return isInside(realParent, allowed);
  return isCreatableUnder(path.resolve(parent), claudeHome, home);
}

/**
 * A missing folder may be created only under `$HOME/.claude`: the nearest existing ancestor must be the home folder
 * (when `.claude` is missing too) or lie inside the real `.claude` folder.
 * @param {string} dir absolute, lexically resolved
 * @param {string} claudeHome
 * @param {string} home
 * @returns {Promise<boolean>}
 */
async function isCreatableUnder(dir, claudeHome, home) {
  if (!isInside(dir, [claudeHome])) return false;
  const nearest = await nearestRealpath(dir);
  if (nearest === null) return false;
  const realHome = await realpathOrNull(home);
  const realClaudeHome = await realpathOrNull(claudeHome);
  if (realClaudeHome !== null) return isInside(nearest, [realClaudeHome]);
  return realHome !== null && nearest === realHome;
}

/**
 * @param {string} p
 * @returns {Promise<string|null>} the real path of the nearest existing ancestor of `p` (or of `p` itself)
 */
async function nearestRealpath(p) {
  let current = p;
  for (;;) {
    const real = await realpathOrNull(current);
    if (real !== null) return real;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Saves a memory file atomically: the content goes to a temporary file in the same folder, which is then renamed over
 * the file. An existing file keeps its mode; a new one gets 0644. A missing folder under `$HOME/.claude` is created
 * with mode 0700. Nothing is written unless the file is editable (see isEditableMemoryFile).
 * @param {string} file
 * @param {string} content
 * @param {MemoryLocations} locations
 * @returns {Promise<void>}
 */
export async function writeMemoryFile(file, content, locations) {
  if (!(await isEditableMemoryFile(file, locations))) {
    throw new AppError(422, 'PATH_NOT_ALLOWED', 'This memory file cannot be saved.');
  }
  const dir = path.dirname(file);
  const existing = await lstatOrNull(file);
  const mode = existing === null ? 0o644 : existing.mode & 0o777;
  if ((await realpathOrNull(dir)) === null) await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const handle = await fs.promises.open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.rename(temp, file);
  } catch (error) {
    await fs.promises.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}
