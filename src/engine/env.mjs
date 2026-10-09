// @ts-check
/**
 * Builds the environment handed to the Claude Code child process. Every gateway setting (`CAW_*`) and the Web token
 * are removed; everything else that is a string is passed through unchanged.
 */

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
  env.CLAUDE_AGENT_SDK_CLIENT_APP = clientApp;
  return env;
}
