// @ts-check
/**
 * The plain-data answers of the mock's runtime controls: the permission mode a query starts in, the MCP servers a
 * session is configured with and the status each reports, the window of a task's output, the answer to a side
 * question, the refusal dialog's result and the address an MCP sign-in opens. Each function takes plain values and
 * returns plain values; the query only wires them to its session state.
 */
import { BROWSER_MCP_SERVER, PERMISSION_MODES } from '../../contracts.mjs';

/** @typedef {import('../../contracts.mjs').PermissionMode} PermissionMode */

/** The output a get_task_output answer keeps: the last 8 KiB of it, as the runtime keeps it. */
export const TASK_OUTPUT_LIMIT = 8 * 1024;
/** The port of the runtime's own localhost callback, used when a sign-in names no redirect address. */
export const LOCAL_CALLBACK_PORT = 53682;
/** How long the runtime's @ index takes to warm up after a query starts, in milliseconds. */
export const FILE_INDEX_WARMUP_MS = 1500;
/** The answer a refusal dialog keeps when the user does not choose: the refusal stands. */
const DIALOG_RESULTS = /** @type {const} */ (['retry_fallback', 'edit_prompt', 'cancelled']);

/**
 * One configured MCP server as the mock tracks it. Its status follows from these fields (see serverStatusOf).
 * @typedef {Object} McpEntry
 * @property {boolean} enabled
 * @property {string} transport                 stdio, http, sse or sdk
 * @property {boolean} reachable                the server connects once it is enabled and needs no sign-in
 * @property {boolean} oauth                    the server connects only after a sign-in
 * @property {boolean} authorized               the sign-in completed
 * @property {boolean} dynamic                  the server was set through setMcpServers or the mcpServers option
 * @property {McpTool[]} tools                  the tools the server offers once it is connected
 */

/**
 * @typedef {Object} McpTool
 * @property {string} name
 * @property {string} description
 * @property {boolean} readOnly
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * An MCP server entry with the defaults of a server that connects.
 * @param {Partial<McpEntry>} fields
 * @returns {McpEntry}
 */
export function serverEntry(fields) {
  return {
    enabled: true,
    transport: 'stdio',
    reachable: true,
    oauth: false,
    authorized: false,
    dynamic: false,
    tools: [],
    ...fields,
  };
}

/** @type {McpTool} */
const SEARCH_ISSUES = {
  name: 'search_issues',
  description: 'Search issues in the connected repository',
  readOnly: true,
};
/** @type {McpTool} */
const WHOAMI = { name: 'whoami', description: 'Report the account the server signed in with', readOnly: true };
/** @type {McpTool[]} */
const BROWSER_TOOLS = [
  { name: 'browser_navigate', description: 'Navigate the browser to a URL', readOnly: false },
  { name: 'browser_take_screenshot', description: 'Take a screenshot of the current page', readOnly: true },
];

/**
 * The servers every session is configured with: github connects, filesystem fails to start as a misconfigured server
 * would, and mock-oauth needs a sign-in before it connects.
 * @returns {Map<string, McpEntry>}
 */
export function builtInServers() {
  return new Map([
    ['github', serverEntry({ transport: 'http', tools: [SEARCH_ISSUES] })],
    ['filesystem', serverEntry({ reachable: false })],
    ['mock-oauth', serverEntry({ transport: 'http', oauth: true, tools: [WHOAMI] })],
  ]);
}

/**
 * The entry of a server that setMcpServers (or the mcpServers option) configured. The browser server offers the browser
 * tools; any other server connects without tools.
 * @param {string} name
 * @param {unknown} config
 * @returns {McpEntry}
 */
export function dynamicServerOf(name, config) {
  const transport = isRecord(config) && typeof config.type === 'string' ? config.type : 'stdio';
  return serverEntry({
    transport,
    dynamic: true,
    tools: name === BROWSER_MCP_SERVER ? [...BROWSER_TOOLS] : [],
  });
}

/**
 * The status an MCP server reports: disabled, waiting for its sign-in, connected, or failed to start.
 * @param {McpEntry} server
 * @returns {{status: 'disabled'|'needs-auth'|'connected'|'failed', error?: string}}
 */
export function serverStatusOf(server) {
  if (!server.enabled) return { status: 'disabled' };
  if (server.oauth && !server.authorized) return { status: 'needs-auth' };
  if (server.reachable) return { status: 'connected' };
  return { status: 'failed', error: 'spawn npx ENOENT' };
}

/**
 * The permission mode a query starts in: the mode passed as an option, otherwise the mode the settings default to, and
 * default when neither names one. A null option counts as not passed, as the gateway sends it.
 * @param {unknown} requested
 * @param {Record<string, unknown>} settings the settings the query loads, under the flag layer
 * @returns {PermissionMode}
 */
export function startModeOf(requested, settings) {
  if (requested !== undefined && requested !== null) return /** @type {PermissionMode} */ (requested);
  const permissions = isRecord(settings.permissions) ? settings.permissions : {};
  const configured = permissions.defaultMode;
  return PERMISSION_MODES.find((mode) => mode === configured) ?? 'default';
}

/**
 * The answer of get_task_output: the end of the output in at most TASK_OUTPUT_LIMIT bytes, its full size and whether
 * the start was cut off.
 * @param {string} text
 * @returns {{output: string, total_bytes: number, truncated: boolean}}
 */
export function taskOutputOf(text) {
  const bytes = Buffer.from(text, 'utf8');
  const truncated = bytes.length > TASK_OUTPUT_LIMIT;
  const kept = truncated ? bytes.subarray(bytes.length - TASK_OUTPUT_LIMIT) : bytes;
  return { output: kept.toString('utf8'), total_bytes: bytes.length, truncated };
}

/**
 * The mock's answer to a side question. A question that mentions a refusal is answered through the fallback model, so
 * the refusal path of the side question can be exercised.
 * @param {string} question
 * @returns {{response: string, synthetic: boolean,
 *   refusalFallback?: {originalModel: string, fallbackModel: string, content: string}}}
 */
export function sideAnswerOf(question) {
  const response = `Side answer: ${question.trim().slice(0, 200)}`;
  if (!/refus/i.test(question)) return { response, synthetic: false };
  return {
    response,
    synthetic: false,
    refusalFallback: { originalModel: 'claude-opus-mock', fallbackModel: 'claude-sonnet-mock', content: response },
  };
}

/**
 * The result a refusal-fallback dialog settled with. Anything other than a completed answer with a known result leaves
 * the refusal in place, which is the runtime's default.
 * @param {unknown} answer the host's onUserDialog answer
 * @returns {'retry_fallback'|'edit_prompt'|'cancelled'}
 */
export function dialogResultOf(answer) {
  if (!isRecord(answer) || answer.behavior !== 'completed') return 'cancelled';
  return DIALOG_RESULTS.find((result) => result === answer.result) ?? 'cancelled';
}

/**
 * The URL of a parsed address. Anything that is not an absolute URL is refused.
 * @param {string} text
 * @returns {URL}
 */
export function parseAddress(text) {
  try {
    return new URL(text);
  } catch {
    throw new TypeError('The address must be an absolute URL.');
  }
}

/**
 * Where an MCP sign-in returns to: the runtime's own localhost callback unless the caller names a redirect address. A
 * localhost address keeps its port (the callback port); any other address is a custom scheme.
 * @param {string|undefined} redirectUri
 * @returns {{redirectScheme: 'localhost'|'custom', callbackPort?: number}}
 */
export function redirectOf(redirectUri) {
  if (redirectUri === undefined) return { redirectScheme: 'localhost', callbackPort: LOCAL_CALLBACK_PORT };
  const url = parseAddress(redirectUri);
  if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
    return { redirectScheme: 'localhost', callbackPort: Number(url.port) || LOCAL_CALLBACK_PORT };
  }
  return { redirectScheme: 'custom' };
}

/**
 * The answer that starts an MCP sign-in: the address to open and the flow it opens.
 * @param {{serverName: string, state: string, redirectUri: string|undefined}} args
 */
export function mcpAuthorizationOf({ serverName, state, redirectUri }) {
  return {
    authUrl: `https://mcp-auth.example.test/authorize?server=${encodeURIComponent(serverName)}&state=${state}`,
    requiresUserAction: true,
    callbackExpected: true,
    state,
    ...redirectOf(redirectUri),
  };
}

/**
 * The plan windows an account has: every subscription has them, an API-key account has none.
 * @param {{subscriptionType?: string|null}} account
 * @returns {boolean}
 */
export function hasPlanLimitsOf(account) {
  return typeof account.subscriptionType === 'string' && account.subscriptionType !== 'Claude API';
}

/**
 * The login method row of /status.
 * @param {{subscriptionType?: string|null}} account
 * @returns {string}
 */
export function loginMethodOf(account) {
  return account.subscriptionType === 'Claude API' ? 'Claude API account' : 'claude.ai account';
}
