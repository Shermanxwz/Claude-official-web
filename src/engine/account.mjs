// @ts-check
/**
 * Claude Code's own sign-in (`/login`), run by the runtime; the gateway never reads or writes credentials. Calls go to
 * a live session's query when one exists for reading the account. A sign-in always runs on the gateway's own account
 * query, so a session restart cannot end the flow. That query is started on demand in `<stateDir>/account`, loads only
 * the user settings, and is closed after five minutes without use and right after a sign-in completes.
 */

import path from 'node:path';
import { AppError } from '../contracts.mjs';
import { startQuietQuery } from './trust.mjs';
import {
  ControlTimeout, TIMEOUT_MESSAGE, firstLine, isPlainObject, isWebUrl, runtimeMethod, withTimeout,
} from './runtime-views.mjs';

/** @typedef {import('../contracts.mjs').AccountApi} AccountApi */
/** @typedef {import('../contracts.mjs').EngineAdapter} EngineAdapter */
/** @typedef {import('../contracts.mjs').Config} Config */
/** @typedef {import('../contracts.mjs').Logger} Logger */
/** @typedef {import('../contracts.mjs').Publish} Publish */
/** @typedef {import('../contracts.mjs').SdkQuery} SdkQuery */
/** @typedef {import('./trust.mjs').QuietQuery} QuietQuery */
/** @typedef {import('../contracts.mjs').AccountInfo} AccountInfo */

export const ACCOUNT_IDLE_MS = 5 * 60_000;
const START_TIMEOUT_MS = 10_000;
const COMPLETE_TIMEOUT_MS = 120_000;
const CODE_MAX = 2048;
const URL_MAX = 4096;
const LOGIN_BLOCKED = 'Login blocked';
const LOGIN_METHODS = ['claudeai', 'console'];

/**
 * @typedef {Object} AccountOptions
 * @property {EngineAdapter} engine
 * @property {Config} config
 * @property {Logger} log
 * @property {Publish} publish
 * @property {() => Record<string, string>} env
 * @property {() => SdkQuery|null} liveQuery   the query of a live session, when one is open (read-only use)
 * @property {() => void} onSignedIn          drops the capability caches after a sign-in
 * @property {number} [idleMs]
 */

/**
 * @param {unknown} answer
 * @returns {boolean} whether an account answer names an account (an object with any non-empty field)
 */
function namesAccount(answer) {
  return isPlainObject(answer) && Object.values(answer).some((value) => value !== null && value !== undefined
    && value !== '');
}

/**
 * @param {string} code
 * @returns {[string, string]} the authorization code and the state
 * @throws {AppError} 422 when the code is not `<authorizationCode>#<state>` with two non-empty parts
 */
function splitCode(code) {
  const text = typeof code === 'string' ? code.trim() : '';
  const parts = text.length <= CODE_MAX ? text.split('#') : [];
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    throw new AppError(422, 'INVALID_ARGUMENT', 'Invalid code. Please make sure the full code was copied');
  }
  return [parts[0], parts[1]];
}

/**
 * Maps a failed sign-in call: policy refusals keep the runtime's message, everything else is a safe engine error.
 * @param {unknown} error
 * @param {string} message
 * @returns {AppError}
 */
function signInFailure(error, message) {
  const text = error instanceof Error ? error.message : '';
  if (text.includes(LOGIN_BLOCKED)) return new AppError(403, 'FORBIDDEN', firstLine(text, message));
  if (error instanceof ControlTimeout) return new AppError(502, 'ENGINE_ERROR', TIMEOUT_MESSAGE);
  return new AppError(502, 'ENGINE_ERROR', message);
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string} an https address; anything else is a runtime failure
 */
function httpsAddress(value, name) {
  if (!isWebUrl(value, URL_MAX, ['https:'])) {
    throw new AppError(502, 'ENGINE_ERROR', `The sign-in returned no usable ${name}.`);
  }
  return /** @type {string} */ (value);
}

/** @param {string} message @returns {AppError} */
function unavailable(message) {
  return new AppError(501, 'FEATURE_UNAVAILABLE', message);
}

/**
 * Claude Code's sign-in through the runtime. One dedicated query serves the flow; live sessions only answer the
 * account read.
 * @implements {AccountApi}
 */
export class Account {
  /** @type {AccountOptions} */
  #options;
  /** @type {QuietQuery|null} */
  #quiet = null;
  /** @type {Promise<void>|null} */
  #opening = null;
  /** @type {'claudeai'|'console'|null} the method of the sign-in in progress */
  #flow = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  #timer = null;
  #closed = false;

  /** @param {AccountOptions} options */
  constructor(options) {
    this.#options = options;
  }

  /**
   * The account read by `GET /api/account`. `signInPending` is true while a sign-in is in progress.
   * @returns {Promise<{account: AccountInfo|null, signInPending: boolean}>}
   */
  async status() {
    const live = this.#options.liveQuery();
    const query = live ?? (await this.#dedicated()).query;
    const answer = await this.#read(query);
    return {
      account: namesAccount(answer) ? /** @type {AccountInfo} */ (answer) : null,
      signInPending: this.#flow !== null,
    };
  }

  /**
   * @param {SdkQuery} query
   * @returns {Promise<unknown>}
   */
  async #read(query) {
    try {
      return await withTimeout(() => query.accountInfo(), START_TIMEOUT_MS);
    } catch (error) {
      this.#options.log.warn('reading the account failed', { reason: errorName(error) });
      throw new AppError(502, 'ENGINE_ERROR', error instanceof ControlTimeout
        ? TIMEOUT_MESSAGE : 'The account could not be read.');
    }
  }

  /**
   * Starts the runtime's sign-in for a Claude subscription (`claudeai`) or an Anthropic Console account (`console`).
   * Asking again for the same method asks the runtime again on the same query; a sign-in for the other method closes
   * the query in progress and starts a new one.
   * @param {'claudeai'|'console'} method
   * @returns {Promise<{manualUrl: string, automaticUrl: string|null}>}
   */
  async startLogin(method) {
    if (!LOGIN_METHODS.includes(method)) throw new AppError(400, 'BAD_REQUEST', 'The sign-in method is not valid.');
    if (this.#flow !== null && this.#flow !== method) await this.#closeQuiet();
    const { query } = await this.#dedicated();
    const authenticate = runtimeMethod(query, 'claudeAuthenticate');
    if (authenticate === null) throw unavailable('This runtime cannot sign in from the gateway.');
    const message = 'The sign-in could not be started.';
    /** @type {Record<string, unknown>} */
    let answer;
    try {
      answer = /** @type {Record<string, unknown>} */ (await withTimeout(
        () => /** @type {Promise<Record<string, unknown>>} */ (authenticate(method === 'claudeai')),
        START_TIMEOUT_MS,
      ));
    } catch (error) {
      throw signInFailure(error, message);
    }
    const manualUrl = httpsAddress(answer?.manualUrl, 'sign-in address');
    const automaticUrl = answer?.automaticUrl === undefined || answer?.automaticUrl === null
      ? null
      : httpsAddress(answer.automaticUrl, 'automatic sign-in address');
    this.#flow = method;
    return { manualUrl, automaticUrl };
  }

  /**
   * Completes the sign-in with the code the sign-in page shows (`<authorizationCode>#<state>`). On success the
   * capability caches are dropped, the account query is closed and `account_changed` is published.
   * @param {string} code
   * @returns {Promise<{account: AccountInfo}>}
   */
  async completeLogin(code) {
    const [authorizationCode, state] = splitCode(code);
    if (this.#flow === null || this.#quiet === null) {
      throw new AppError(409, 'CONFLICT', 'No sign-in is in progress. Start a sign-in first.');
    }
    const callback = runtimeMethod(this.#quiet.query, 'claudeOAuthCallback');
    if (callback === null) throw unavailable('This runtime cannot complete a sign-in from the gateway.');
    const message = 'The sign-in could not be completed. Start the sign-in again.';
    /** @type {unknown} */
    let answer;
    try {
      answer = await withTimeout(() => callback(authorizationCode, state), COMPLETE_TIMEOUT_MS);
    } catch (error) {
      throw signInFailure(error, message);
    }
    const account = isPlainObject(answer) && isPlainObject(answer.account) ? answer.account : null;
    if (account === null) throw new AppError(502, 'ENGINE_ERROR', message);
    await this.#closeQuiet();
    this.#options.onSignedIn();
    this.#options.publish({ type: 'account_changed', data: { account } });
    return { account: /** @type {AccountInfo} */ (account) };
  }

  /** Abandons the sign-in in progress: the account query is closed. Nothing happens when none is open. */
  async cancelLogin() {
    await this.#closeQuiet();
  }

  /** Ends the account query for the gateway's shutdown. Later calls answer 503. */
  async close() {
    this.#closed = true;
    await this.#closeQuiet();
  }

  /**
   * The dedicated account query, started on first use and kept while it is used.
   * @returns {Promise<QuietQuery>}
   */
  async #dedicated() {
    if (this.#closed) throw new AppError(503, 'ENGINE_UNAVAILABLE', 'The gateway is shutting down.');
    if (this.#quiet === null) {
      this.#opening ??= this.#open();
      await this.#opening;
    }
    this.#touch();
    if (this.#quiet === null) throw new AppError(503, 'ENGINE_UNAVAILABLE', 'Claude Code is busy. Try again.');
    return this.#quiet;
  }

  /** Starts the account query. Runs once at a time. */
  async #open() {
    try {
      const { config, engine, env } = this.#options;
      const quiet = await startQuietQuery({
        engine,
        dir: path.join(config.stateDir, 'account'),
        settingSources: ['user'],
        env: env(),
        claudeBin: config.claudeBin,
      });
      if (this.#closed) {
        quiet.close();
        throw new AppError(503, 'ENGINE_UNAVAILABLE', 'The gateway is shutting down.');
      }
      this.#quiet = quiet;
    } catch (error) {
      if (error instanceof AppError) throw error;
      this.#options.log.warn('the account query could not start', { reason: errorName(error) });
      throw new AppError(503, 'ENGINE_UNAVAILABLE',
        'Claude Code is not available. Check its installation and sign-in.');
    } finally {
      this.#opening = null;
    }
  }

  /** Restarts the idle timer. The timer is unref'd so it never keeps the process alive. */
  #touch() {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      void this.#closeQuiet();
    }, this.#options.idleMs ?? ACCOUNT_IDLE_MS);
    this.#timer.unref?.();
  }

  /** Closes the account query and abandons the sign-in in progress. */
  async #closeQuiet() {
    const quiet = this.#quiet;
    this.#quiet = null;
    this.#flow = null;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    quiet?.close();
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorName(error) {
  if (error instanceof ControlTimeout) return 'timeout';
  return error instanceof Error ? error.name : typeof error;
}

/**
 * @param {AccountOptions} options
 * @returns {Account}
 */
export function createAccount(options) {
  return new Account(options);
}
