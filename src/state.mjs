// @ts-check
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const NAME_RE = /^[a-z0-9-]{1,64}$/;
/** State files are small bookkeeping records; anything larger is treated as corrupt. */
const MAX_STATE_BYTES = 16 * 1024 * 1024;

/**
 * @typedef {Object} StateStore
 * @property {<T>(name: string, fallback: T) => Promise<T>} read
 *   Returns the parsed JSON of `<stateDir>/<name>.json`, or `fallback` when the file is missing, unreadable, too large
 *   or not valid JSON. Never throws for I/O or content problems; an invalid `name` throws a TypeError.
 * @property {(name: string, value: unknown) => Promise<void>} write
 *   Atomically replaces `<stateDir>/<name>.json` (temp file in the same directory, fsync, rename). Creates the state
 *   directory with mode 0700 on demand. Throws for an invalid `name` or a value that is not JSON-serializable.
 */

/**
 * @param {string} name
 * @returns {string}
 */
function fileName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new TypeError('state name must match /^[a-z0-9-]{1,64}$/');
  }
  return `${name}.json`;
}

/**
 * @param {string} stateDir absolute directory that holds the JSON state files
 * @returns {StateStore}
 */
export function createStateStore(stateDir) {
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) {
    throw new TypeError('stateDir must be an absolute path');
  }
  const dir = path.resolve(stateDir);

  return {
    /**
     * @template T
     * @param {string} name
     * @param {T} fallback
     * @returns {Promise<T>}
     */
    async read(name, fallback) {
      const file = path.join(dir, fileName(name));
      try {
        const stat = await fs.promises.stat(file);
        if (!stat.isFile() || stat.size > MAX_STATE_BYTES) {
          return fallback;
        }
        return JSON.parse(await fs.promises.readFile(file, 'utf8'));
      } catch {
        return fallback;
      }
    },

    /**
     * @param {string} name
     * @param {unknown} value
     * @returns {Promise<void>}
     */
    async write(name, value) {
      const file = path.join(dir, fileName(name));
      const json = JSON.stringify(value);
      if (json === undefined) {
        throw new TypeError('state value must be JSON-serializable');
      }
      await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
      const tmp = path.join(dir, `.${name}.${randomBytes(8).toString('hex')}.tmp`);
      /** @type {fs.promises.FileHandle|undefined} */
      let handle;
      try {
        handle = await fs.promises.open(tmp, 'wx', 0o600);
        await handle.writeFile(json, 'utf8');
        await handle.sync();
        await handle.close();
        handle = undefined;
        await fs.promises.rename(tmp, file);
      } catch (err) {
        if (handle) {
          await handle.close().catch(() => {});
        }
        await fs.promises.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
    },
  };
}
