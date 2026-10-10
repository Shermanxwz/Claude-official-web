// @ts-check
/**
 * The gateway-wide unattended switch (docs/PROTOCOL.md "Unattended mode"): whether it is available, whether it is on,
 * and the value saved in <stateDir>/unattended.json. The engine host reads `enabled()` synchronously, so the effective
 * value is kept in memory and written through on every change.
 */

import { AppError } from './contracts.mjs';

/** @typedef {import('./contracts.mjs').Config} Config */
/** @typedef {import('./contracts.mjs').UnattendedState} UnattendedState */
/** @typedef {import('./state.mjs').StateStore} StateStore */

const STATE_NAME = 'unattended';

/**
 * @typedef {Object} UnattendedSwitch
 * @property {() => Promise<void>} load   reads the saved value; called once at startup, before any request
 * @property {() => boolean} enabled      the effective value: false while the switch is unavailable
 * @property {() => UnattendedState} state
 * @property {(enabled: boolean) => Promise<{changed: boolean, state: UnattendedState}>} set
 *   saves the value and reports whether the effective value moved. Every call writes the state file. Calls run one
 *   after the other. Throws AppError 501 FEATURE_DISABLED while the switch is unavailable.
 */

/**
 * @typedef {Object} UnattendedService     what the HTTP routes need (src/app.mjs)
 * @property {() => UnattendedState} state
 * @property {(enabled: boolean) => Promise<UnattendedState>} set
 */

/**
 * The saved record, when the file holds a valid one. Anything else counts as no saved value.
 * @param {unknown} value
 * @returns {{enabled: boolean, changedAt: number|null}|null}
 */
function savedOf(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const { enabled, changedAt } = /** @type {Record<string, unknown>} */ (value);
  if (typeof enabled !== 'boolean') return null;
  if (changedAt === null) return { enabled, changedAt: null };
  if (typeof changedAt !== 'number' || !Number.isFinite(changedAt)) return null;
  return { enabled, changedAt };
}

/**
 * Why the switch cannot be on: the access profile is not full, or neither CAW_ALLOW_BYPASS nor CAW_UNATTENDED is set.
 * @param {Config} config
 * @returns {null|'not-allowed'|'profile'} null when the switch is available
 */
function unavailableReason(config) {
  if (config.profile !== 'full') return 'profile';
  return config.allowBypass ? null : 'not-allowed';
}

/**
 * @param {{config: Config, stateStore: StateStore, now?: () => number}} options
 * @returns {UnattendedSwitch}
 */
export function createUnattendedSwitch({ config, stateStore, now = Date.now }) {
  const reason = unavailableReason(config);
  const available = reason === null;
  /** @type {{enabled: boolean, changedAt: number|null}|null} */
  let saved = null;
  /** Writes run one after the other, so each call compares with the value the previous one saved. */
  let queue = Promise.resolve();

  /** @returns {boolean} */
  const enabled = () => available && (saved === null ? config.unattendedDefault : saved.enabled);

  /** @returns {UnattendedState} */
  const state = () => ({
    available,
    enabled: enabled(),
    reason,
    changedAt: saved?.changedAt ?? null,
  });

  /** @param {boolean} next */
  async function save(next) {
    if (!available) {
      throw new AppError(501, 'FEATURE_DISABLED', 'The unattended mode is not available on this gateway.');
    }
    const before = enabled();
    const changed = before !== next;
    const record = { enabled: next, changedAt: changed ? now() : (saved?.changedAt ?? null) };
    await stateStore.write(STATE_NAME, record);
    saved = record;
    return { changed, state: state() };
  }

  return {
    async load() {
      saved = savedOf(await stateStore.read(STATE_NAME, null));
    },
    enabled,
    state,
    set(next) {
      const run = queue.then(() => save(next));
      queue = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}
