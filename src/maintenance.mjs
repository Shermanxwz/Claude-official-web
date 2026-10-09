// @ts-check

/** @typedef {import('./contracts.mjs').Config} Config */
/** @typedef {import('./contracts.mjs').Logger} Logger */
/** @typedef {import('./contracts.mjs').AttachmentsApi} AttachmentsApi */
/** @typedef {import('./contracts.mjs').EngineHostApi} EngineHostApi */

/**
 * @typedef {Object} Maintenance
 * @property {() => void} stop      clears both timers; a run already in progress finishes normally
 * @property {() => Promise<void>} runOnce   removes expired uploads now; never rejects
 */

/**
 * @param {unknown} err
 * @returns {string}
 */
function errorCode(err) {
  return err && typeof err === 'object' && 'code' in err ? String(err.code) : 'UNKNOWN';
}

/**
 * Starts the periodic housekeeping: the first run after `initialDelayMs`, then every `intervalMs`. Both timers are
 * unref-ed so they never keep the process alive. Failures are logged (error code only) and never thrown.
 * @param {{
 *   config: Config,
 *   log: Logger,
 *   attachments: AttachmentsApi,
 *   engineHost?: EngineHostApi,
 *   intervalMs?: number,
 *   initialDelayMs?: number,
 * }} options  `engineHost` is accepted for the integrator's wiring; runOnce does not use it
 * @returns {Maintenance}
 */
export function startMaintenance({ config, log, attachments, intervalMs = 3600000, initialDelayMs = 5000 }) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0 || !Number.isFinite(initialDelayMs) || initialDelayMs < 0) {
    throw new TypeError('intervalMs must be a positive number and initialDelayMs a non-negative number');
  }

  /** @type {Promise<void>|null} */
  let active = null;

  /** @returns {Promise<void>} */
  function runOnce() {
    if (active === null) {
      active = (async () => {
        try {
          const { removed } = await attachments.cleanup();
          log.info('upload maintenance finished', { removed, retentionDays: config.uploadRetentionDays });
        } catch (err) {
          log.error('upload maintenance failed', { code: errorCode(err) });
        }
      })().finally(() => {
        active = null;
      });
    }
    return active;
  }

  const initial = setTimeout(() => {
    void runOnce();
  }, initialDelayMs);
  const periodic = setInterval(() => {
    void runOnce();
  }, intervalMs);
  initial.unref();
  periodic.unref();

  return {
    stop() {
      clearTimeout(initial);
      clearInterval(periodic);
    },
    runOnce,
  };
}
