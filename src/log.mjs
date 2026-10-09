// @ts-check
/**
 * Structured JSON logger. One line per entry. Fields that could carry secrets or user content are dropped by name.
 */

const LEVELS = /** @type {const} */ ({ debug: 10, info: 20, warn: 30, error: 40 });

const DROPPED_KEYS = new Set(['token', 'cookie', 'authorization', 'password', 'text', 'prompt', 'content', 'data']);

/**
 * @param {Record<string, unknown>} fields
 * @returns {Record<string, unknown>}
 */
function scrub(fields) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    if (DROPPED_KEYS.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stringify(value) {
  try {
    return JSON.stringify(value, (_key, item) => {
      if (typeof item === 'bigint') return item.toString();
      if (item instanceof Error) return { name: item.name, message: item.message };
      return item;
    });
  } catch {
    return '{"level":"error","msg":"log entry could not be serialized"}';
  }
}

/**
 * @param {{level?: 'debug'|'info'|'warn'|'error', stream?: {write: (chunk: string) => unknown}}} [options]
 * @returns {import('./contracts.mjs').Logger}
 */
export function createLogger({ level = 'info', stream = process.stderr } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  /**
   * @param {keyof typeof LEVELS} entryLevel
   * @param {string} msg
   * @param {Record<string, unknown>} [fields]
   */
  function write(entryLevel, msg, fields = {}) {
    try {
      if (LEVELS[entryLevel] < threshold) return;
      /** @type {Record<string, unknown>} */
      const entry = { t: new Date().toISOString(), level: entryLevel, msg: String(msg) };
      for (const [key, value] of Object.entries(scrub(fields && typeof fields === 'object' ? fields : {}))) {
        if (!(key in entry)) entry[key] = value;
      }
      const line = stringify(entry);
      stream.write(`${line}\n`);
    } catch {
      // Logging must never break the request path.
    }
  }

  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
  };
}
