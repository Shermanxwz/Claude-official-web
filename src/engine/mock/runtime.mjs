// @ts-check
/**
 * The state the mock queries share, as the runtime shares its own records between sessions: the folders Claude Code
 * trusts (its per-folder trust record), the signed-in account and a sign-in in progress. With a directory the trust
 * record and the account persist across queries and restarts; without one they live in memory.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

/** @typedef {import('@anthropic-ai/claude-agent-sdk').AccountInfo} AccountInfo */

/** The account the mock starts signed in with: the demo account of earlier releases. */
export const DEFAULT_ACCOUNT = Object.freeze({
  email: 'demo@example.com',
  subscriptionType: 'pro',
  apiProvider: 'firstParty',
});
/** The only authorization code the mock sign-in accepts. */
export const LOGIN_CODE = 'mock-code';

const TRUST_FILE = 'trust.json';
const ACCOUNT_FILE = 'account.json';

/**
 * @typedef {Object} Deferred
 * @property {Promise<{account: AccountInfo}>} promise
 * @property {(value: {account: AccountInfo}) => void} resolve
 * @property {(reason: Error) => void} reject
 */

/**
 * A sign-in in progress. `owner` is the query that started it: closing that query abandons the sign-in.
 * @typedef {Object} LoginFlow
 * @property {'claudeai'|'console'} method
 * @property {string} state
 * @property {object} owner
 * @property {string} manualUrl
 * @property {string} automaticUrl
 * @property {Deferred} completion
 */

/**
 * @returns {Deferred}
 */
function deferred() {
  /** @type {(value: {account: AccountInfo}) => void} */
  let resolve = () => {};
  /** @type {(reason: Error) => void} */
  let reject = () => {};
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  // A sign-in that nobody waits for may still end abandoned; the rejection must not be reported as unhandled.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/**
 * Reads a JSON record. A missing or unreadable record reads as absent.
 * @param {string} path
 * @returns {any}
 */
function readRecord(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Writes a JSON record atomically: a temporary file (mode 0600) in the same directory, renamed over the target.
 * @param {string} dir
 * @param {string} name
 * @param {unknown} value
 */
function writeRecord(dir, name, value) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, name);
  const temp = join(dir, `.${name}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temp, target);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // The temporary file may never have been created; the original error is the one to report.
    }
    throw error;
  }
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function stringsOf(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && isAbsolute(item)) : [];
}

/**
 * The runtime state of the mock. The same object is shared by every query of one adapter.
 * @param {{dir?: string}} [options] directory of the persistent records; omitted: everything stays in memory
 */
export function createRuntimeState({ dir } = {}) {
  /** @type {string[]} */
  let memoryTrust = [];
  /** @type {AccountInfo|null} */
  let memoryAccount = null;
  /** @type {LoginFlow|null} */
  let login = null;

  /** @returns {string[]} */
  function trustedFolders() {
    if (dir === undefined) return [...memoryTrust];
    return stringsOf(readRecord(join(dir, TRUST_FILE))?.trusted);
  }

  /**
   * Whether the folder, or a folder above it, is trusted.
   * @param {string} path
   * @returns {boolean}
   */
  function isTrusted(path) {
    const target = resolve(path);
    return trustedFolders().some((folder) => {
      const base = resolve(folder);
      return target === base || target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
    });
  }

  /**
   * Records the folder as trusted (the runtime's trust dialog accepted).
   * @param {string} path
   */
  function trust(path) {
    const folder = resolve(path);
    const folders = trustedFolders();
    if (folders.includes(folder)) return;
    if (dir === undefined) {
      memoryTrust = [...folders, folder];
      return;
    }
    writeRecord(dir, TRUST_FILE, { trusted: [...folders, folder] });
  }

  /** @returns {AccountInfo} */
  function account() {
    if (dir === undefined) return { ...(memoryAccount ?? DEFAULT_ACCOUNT) };
    const stored = readRecord(join(dir, ACCOUNT_FILE))?.account;
    return { ...(stored !== null && typeof stored === 'object' ? stored : DEFAULT_ACCOUNT) };
  }

  /** @param {AccountInfo} next */
  function setAccount(next) {
    if (dir === undefined) {
      memoryAccount = { ...next };
      return;
    }
    writeRecord(dir, ACCOUNT_FILE, { account: next });
  }

  /**
   * Starts a sign-in. A sign-in in progress for the same method is joined; one for the other method is replaced.
   * @param {'claudeai'|'console'} method
   * @param {object} owner the query that runs the sign-in
   * @returns {{manualUrl: string, automaticUrl: string}}
   */
  function startLogin(method, owner) {
    if (login !== null && login.method === method) return login;
    if (login !== null) login.completion.reject(new Error('The sign-in was replaced by a new one.'));
    const state = randomUUID();
    const base = method === 'claudeai'
      ? 'https://claude.ai/oauth/authorize'
      : 'https://console-login.example.test/oauth/authorize';
    login = {
      method,
      state,
      owner,
      manualUrl: `${base}?code=true&state=${state}`,
      automaticUrl: `${base}?code=true&state=${state}&redirect=localhost`,
      completion: deferred(),
    };
    return login;
  }

  /**
   * Completes the sign-in with the code the sign-in page shows. A wrong code or state leaves the flow open for another
   * try.
   * @param {string} code
   * @param {string} state
   * @returns {{account: AccountInfo}}
   */
  function completeLogin(code, state) {
    if (login === null) throw new Error('No active claude_authenticate flow');
    if (state !== login.state) throw new Error('The sign-in state does not match this flow.');
    if (code !== LOGIN_CODE) throw new Error('The authorization code was not accepted.');
    const flow = login;
    login = null;
    const signedIn = {
      email: 'demo@example.test',
      organization: 'Demo',
      subscriptionType: flow.method === 'claudeai' ? 'pro' : 'Claude API',
      apiProvider: /** @type {const} */ ('firstParty'),
    };
    setAccount(signedIn);
    flow.completion.resolve({ account: signedIn });
    return { account: signedIn };
  }

  /**
   * Resolves once the sign-in in progress completes through its automatic address.
   * @returns {Promise<{account: AccountInfo}>}
   */
  function waitForLogin() {
    if (login === null) throw new Error('No active claude_authenticate flow');
    return login.completion.promise;
  }

  /**
   * Abandons the sign-in that the query started, when there is one. Called when that query closes.
   * @param {object} owner
   */
  function abandonLogin(owner) {
    if (login === null || login.owner !== owner) return;
    const flow = login;
    login = null;
    flow.completion.reject(new Error('The sign-in was abandoned.'));
  }

  /** @returns {LoginFlow|null} */
  function signInInProgress() {
    return login;
  }

  return {
    isTrusted,
    trust,
    account,
    setAccount,
    startLogin,
    completeLogin,
    waitForLogin,
    abandonLogin,
    signInInProgress,
  };
}

/** @typedef {ReturnType<typeof createRuntimeState>} RuntimeState */
