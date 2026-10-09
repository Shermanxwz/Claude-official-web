// @ts-check
/**
 * The deterministic mock engine: an EngineAdapter that imitates the SDK's query() and session functions without
 * any model or network. Demo mode, the integration tests and the browser tests use it. Sessions are stored under
 * <stateDir>/mock-sessions; query() runs the scripted scenarios of ./scenarios.mjs.
 */
import { join } from 'node:path';
import { createMockQuery } from './query.mjs';
import { createMockStore } from './store.mjs';

/** @typedef {import('../../contracts.mjs').EngineAdapter} EngineAdapter */
/** @typedef {import('../../contracts.mjs').Config} Config */
/** @typedef {import('../../contracts.mjs').Logger} Logger */

/** Pause between streamed chunks when nothing else is configured. */
export const DEFAULT_DELAY_MS = 12;
/** Upper bound of the pacing: longer pauses would make the scripted turns unbearably slow. */
export const MAX_DELAY_MS = 10000;

/**
 * Validates a pacing value: an integer number of milliseconds from 0 to MAX_DELAY_MS.
 * @param {unknown} value
 * @returns {number}
 */
export function delayFromValue(value) {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value.trim()) : value;
  if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed < 0 || parsed > MAX_DELAY_MS) {
    throw new RangeError(`The mock delay must be an integer from 0 to ${MAX_DELAY_MS} milliseconds.`);
  }
  return parsed;
}

/**
 * The pacing in effect: an explicit value wins, then CAW_MOCK_DELAY_MS, then the default. A blank environment value
 * counts as unset.
 * @param {unknown} explicit
 * @returns {number}
 */
export function resolveDelay(explicit) {
  if (explicit !== undefined) return delayFromValue(explicit);
  const raw = process.env.CAW_MOCK_DELAY_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_DELAY_MS;
  return delayFromValue(raw.trim());
}

/**
 * Creates the mock EngineAdapter.
 * @param {{config: Config, log: Logger, delayMs?: number|string}} options
 * @returns {EngineAdapter}
 */
export function createMockAdapter({ config, log, delayMs }) {
  const pace = resolveDelay(delayMs);
  const store = createMockStore(join(config.stateDir, 'mock-sessions'));
  log.info('engine adapter ready', { engine: 'mock', sdkVersion: 'mock', delayMs: pace });
  return {
    kind: 'mock',
    sdkVersion: 'mock',
    query: ({ prompt, options }) => createMockQuery({ prompt, options, store, delayMs: pace, log }),
    listSessions: (options) => store.listSessions(options),
    getSessionMessages: (sessionId, options) => store.getSessionMessages(sessionId, options),
    getSessionInfo: (sessionId, options) => store.getSessionInfo(sessionId, options),
    renameSession: (sessionId, title, options) => store.renameSession(sessionId, title, options),
    tagSession: (sessionId, tag, options) => store.tagSession(sessionId, tag, options),
    forkSession: (sessionId, options) => store.forkSession(sessionId, options),
    deleteSession: (sessionId, options) => store.deleteSession(sessionId, options),
    listSubagents: (sessionId) => store.listSubagents(sessionId),
    getSubagentMessages: (sessionId, agentId) => store.getSubagentMessages(sessionId, agentId),
  };
}
