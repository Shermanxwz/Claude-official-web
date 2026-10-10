// @ts-check
/**
 * Folder trust in Claude Code's own record. Claude Code keeps a trust record per folder and, without it, ignores the
 * project allow rules of that folder. The gateway records trust through the runtime's own `set_cwd` handshake, from a
 * throwaway query that runs no turn: the handshake answers `needs_trust` for an untrusted folder, which is then
 * accepted with `trustAccepted`. A folder recorded during this gateway process is remembered; a failure is not.
 *
 * `startQuietQuery` is the one kind of query the gateway starts without a session: a probe here and the account query
 * (src/engine/account.mjs). Such a query never sends a prompt and keeps no session file.
 */

import fs from 'node:fs';
import path from 'node:path';
import { AsyncQueue } from './queue.mjs';
import { ControlTimeout, realpathOrNull, runtimeMethod } from './runtime-views.mjs';

/** @typedef {import('../contracts.mjs').EngineAdapter} EngineAdapter */
/** @typedef {import('../contracts.mjs').Config} Config */
/** @typedef {import('../contracts.mjs').Logger} Logger */
/** @typedef {import('../contracts.mjs').RuntimeTrust} RuntimeTrust */
/** @typedef {import('../contracts.mjs').SdkQuery} SdkQuery */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SDKUserMessage} SDKUserMessage */

export const PROBE_BUDGET_MS = 8000;
export const PROBE_DIR_NAME = 'trust-probe';

/**
 * A query that runs no turn.
 * @typedef {Object} QuietQuery
 * @property {SdkQuery} query
 * @property {() => void} close       ends the prompt, closes the query and aborts it; idempotent
 * @property {Promise<void>} stopped  resolves once close() has been called
 */

/**
 * @param {unknown} _value a message the caller does not need
 */
function discard(_value) {
  // Messages of a quiet query carry nothing the gateway uses.
}

/**
 * Starts a query that sends no prompt. Its folder is created first, its messages are discarded, and it loads only the
 * setting sources given.
 * @param {{engine: EngineAdapter, dir: string, settingSources: Array<'user'|'project'|'local'>,
 *   env: Record<string, string>, claudeBin: string|null}} options
 * @returns {Promise<QuietQuery>}
 */
export async function startQuietQuery({ engine, dir, settingSources, env, claudeBin }) {
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  /** @type {AsyncQueue<SDKUserMessage>} */
  const prompt = new AsyncQueue();
  const abort = new AbortController();
  const query = engine.query({
    prompt,
    options: {
      cwd: dir,
      persistSession: false,
      settingSources,
      env,
      abortController: abort,
      ...(claudeBin !== null ? { pathToClaudeCodeExecutable: claudeBin } : {}),
    },
  });
  void (async () => {
    try {
      for await (const message of query) discard(message);
    } catch {
      // The query ends with an error when it is closed; nothing else depends on it.
    }
  })();
  let closed = false;
  /** @type {() => void} */
  let markStopped = () => undefined;
  const stopped = new Promise((resolve) => {
    markStopped = () => resolve(undefined);
  });
  const close = () => {
    if (closed) return;
    closed = true;
    prompt.end();
    try {
      query.close();
    } catch {
      // The process may already have exited.
    }
    abort.abort();
    markStopped();
  };
  return { query, close, stopped };
}

/**
 * @param {unknown} value
 * @returns {{status?: unknown, directory?: unknown}}
 */
function answerOf(value) {
  if (value === null || typeof value !== 'object') return {};
  return /** @type {{status?: unknown, directory?: unknown}} */ (value);
}

/**
 * Runs the handshake on an open probe. `already` means the folder was already trusted. The runtime's request to trust
 * is accepted only for the folder asked for: a request that names another folder is refused and not recorded.
 * @param {SdkQuery} query
 * @param {string} dir the real path of the folder asked for
 * @param {Logger} log
 * @returns {Promise<RuntimeTrust>}
 */
async function handshake(query, dir, log) {
  await query.initializationResult();
  const setCwd = runtimeMethod(query, 'setCwd');
  if (setCwd === null) return 'failed';
  const first = answerOf(await setCwd(dir));
  if (first.status === 'ok') return 'already';
  if (first.status !== 'needs_trust' || typeof first.directory !== 'string') return 'failed';
  if (!path.isAbsolute(first.directory) || (await realpathOrNull(first.directory)) !== dir) {
    log.warn('the runtime asked to trust another folder than the one requested; trust was not recorded',
      { reason: 'directory_mismatch' });
    return 'failed';
  }
  const accepted = answerOf(await setCwd(dir, { trustAccepted: true, trustedDirectory: first.directory }));
  return accepted.status === 'ok' ? 'accepted' : 'failed';
}

/**
 * Resolves to 'failed' after `ms`. The timer is cleared by the returned cancel function.
 * @param {number} ms
 * @returns {{promise: Promise<RuntimeTrust>, cancel: () => void}}
 */
function budgetOf(ms) {
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timer;
  const promise = new Promise((resolve) => {
    timer = setTimeout(() => resolve('failed'), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * The runtime trust recorder of one gateway process.
 * @param {{engine: EngineAdapter, config: Config, log: Logger, env: () => Record<string, string>,
 *   budgetMs?: number}} options
 * @returns {{record: (dir: string) => Promise<RuntimeTrust>, close: () => Promise<void>}}
 */
export function createRuntimeTrust({ engine, config, log, env, budgetMs = PROBE_BUDGET_MS }) {
  /** Real paths of the folders whose trust the runtime has recorded during this gateway process. */
  const recorded = new Set();
  /** @type {Map<string, Promise<RuntimeTrust>>} */
  const running = new Map();
  /** @type {Set<QuietQuery>} */
  const probes = new Set();
  let closed = false;

  /**
   * Records trust for one folder. Only the call that runs the handshake answers 'accepted' or 'failed' for it; every
   * later call, one that joins the handshake in flight included, finds the folder trusted and answers 'already'.
   * @param {string} dir
   * @returns {Promise<RuntimeTrust>}
   */
  async function record(dir) {
    const real = await realpathOrNull(dir);
    if (real === null) return 'failed';
    if (recorded.has(real)) return 'already';
    const pending = running.get(real);
    if (pending !== undefined) return (await pending) === 'failed' ? 'failed' : 'already';
    const attempt = probe(real).then((result) => {
      if (result !== 'failed') recorded.add(real);
      return result;
    }).finally(() => running.delete(real));
    running.set(real, attempt);
    return attempt;
  }

  /**
   * One handshake from a fresh probe, within the budget. The probe is always closed.
   * @param {string} dir
   * @returns {Promise<RuntimeTrust>}
   */
  async function probe(dir) {
    if (closed) return 'failed';
    let quiet;
    try {
      quiet = await startQuietQuery({
        engine,
        dir: path.join(config.stateDir, PROBE_DIR_NAME),
        settingSources: [],
        env: env(),
        claudeBin: config.claudeBin,
      });
    } catch (error) {
      log.warn('the runtime trust probe could not start', { reason: errorName(error) });
      return 'failed';
    }
    if (closed) {
      quiet.close();
      return 'failed';
    }
    probes.add(quiet);
    const budget = budgetOf(budgetMs);
    try {
      return await Promise.race([
        handshake(quiet.query, dir, log),
        quiet.stopped.then(() => /** @type {RuntimeTrust} */ ('failed')),
        budget.promise,
      ]);
    } catch (error) {
      log.warn('the runtime trust handshake failed', { reason: errorName(error) });
      return 'failed';
    } finally {
      budget.cancel();
      probes.delete(quiet);
      quiet.close();
    }
  }

  /** Stops every probe in flight and waits until each one has ended. */
  async function close() {
    closed = true;
    for (const quiet of [...probes]) quiet.close();
    await Promise.allSettled([...running.values()]);
  }

  return { record, close };
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorName(error) {
  if (error instanceof ControlTimeout) return 'timeout';
  return error instanceof Error ? error.name : typeof error;
}

