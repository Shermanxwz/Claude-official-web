// @ts-check
/**
 * Builds the environment handed to the Claude Code child process. Every gateway setting (`CAW_*`) and the Web token
 * are removed; everything else that is a string is passed through unchanged, and RUNTIME_DEFAULTS are added where the
 * host does not set them. The terminal's child process gets the same defaults (src/terminal.mjs).
 */

/**
 * What the gateway gives the runtime unless the host environment already sets the name, to any value. An operator opts
 * out by setting the name, even to an empty string.
 * - DISABLE_AUTOUPDATER: the gateway runs the Claude Code version it was verified with (`npm run upgrade:runtime`), so
 *   the runtime never replaces itself with a version nobody has checked.
 * - CLAUDE_CODE_STARTUP_FAILURE_RESULTS: a known startup failure arrives as a structured result with
 *   `startup_failure_reason`, so the gateway can show its fix instead of stderr text alone (docs/PROTOCOL.md).
 */
export const RUNTIME_DEFAULTS = Object.freeze({
  DISABLE_AUTOUPDATER: '1',
  CLAUDE_CODE_STARTUP_FAILURE_RESULTS: '1',
});

/**
 * @param {Record<string, string | undefined>} source  usually process.env
 * @param {{clientApp: string}} options
 * @returns {Record<string, string>}
 */
export function engineEnv(source = process.env, { clientApp }) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value !== 'string' || name.startsWith('CAW_')) continue;
    env[name] = value;
  }
  withRuntimeDefaults(env, source);
  env.CLAUDE_AGENT_SDK_CLIENT_APP = clientApp;
  return env;
}

/**
 * Adds every RUNTIME_DEFAULTS name that `source` does not set to `env`, which is changed in place and returned.
 * @param {Record<string, string>} env  a fresh object built for the child process
 * @param {Record<string, string | undefined>} source  the host environment the child inherits from
 * @returns {Record<string, string>}
 */
export function withRuntimeDefaults(env, source) {
  for (const [name, value] of Object.entries(RUNTIME_DEFAULTS)) {
    if (source[name] === undefined) env[name] = value;
  }
  return env;
}
