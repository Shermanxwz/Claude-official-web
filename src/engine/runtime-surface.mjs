// @ts-check
/**
 * The runtime surface the gateway relies on, as one list. It holds every Claude Agent SDK and Claude Code name the
 * gateway calls or reads that sdk.d.ts does not declare, and the declared Query methods, query() options and exports
 * the gateway uses, so that an SDK upgrade which removes or renames one of them fails `npm run contract` instead of
 * failing in a session. docs/ENGINEERING.md ("Runtime contract and upgrades") describes the process.
 *
 * Each entry names the source where its name is checked (scripts/runtime-contract.mjs):
 * - `sdk.d.ts`: the declaration file (kinds query-method, query-option, sdk-export).
 * - `sdk.mjs`: the SDK's own implementation (kinds sdk-method, sdk-option, sdk-env).
 * - `binary`: the bundled Claude Code executable (kinds cli-flag, env, stream, dialog).
 * A `wire` name is a control request subtype or option key that the SDK sends to the runtime; it is checked in the
 * binary. test/unit/runtime-surface.test.mjs fails when a method the gateway calls by name is missing from this list.
 */

/**
 * @typedef {'query-method'|'query-option'|'sdk-export'|'sdk-method'|'sdk-option'|'sdk-env'|'cli-flag'|'env'|'stream'
 *   |'dialog'} SurfaceKind
 * @typedef {'sdk.d.ts'|'sdk.mjs'|'binary'} SurfaceSource
 * @typedef {{name: string, kind: SurfaceKind, source: SurfaceSource, wire?: string, used: string}} SurfaceEntry
 */

/**
 * @param {SurfaceKind} kind
 * @param {SurfaceSource} source
 * @param {string} used where the gateway uses these names
 * @param {string[]} names
 * @returns {SurfaceEntry[]}
 */
function declaredGroup(kind, source, used, names) {
  return names.map((name) => ({ name, kind, source, used }));
}

/** Every entry of the runtime surface, in the order the contract report prints them. */
export const RUNTIME_SURFACE = Object.freeze(/** @type {SurfaceEntry[]} */ ([
  ...declaredGroup('query-method', 'sdk.d.ts', 'host.mjs, account.mjs, trust.mjs, contracts.mjs RUNTIME_VIEWS', [
    'accountInfo', 'applyFlagSettings', 'backgroundTasks', 'close', 'getContextUsage', 'initializationResult',
    'interrupt', 'mcpServerStatus', 'readFile', 'reconnectMcpServer', 'reloadOutputStyles', 'reloadPlugins',
    'reloadSkills', 'rewindFiles', 'setMcpPermissionModeOverride', 'setMcpServers', 'setModel', 'setPermissionMode',
    'stopTask', 'toggleMcpServer', 'updateSettings', 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET',
  ]),
  ...declaredGroup('query-option', 'sdk.d.ts', 'host.mjs #queryOptions and #queryEnv', [
    'abortController', 'additionalDirectories', 'agent', 'agentProgressSummaries', 'allowDangerouslySkipPermissions',
    'canUseTool', 'cwd', 'effort', 'enableFileCheckpointing', 'env', 'extraArgs', 'fallbackModel',
    'includeHookEvents', 'includePartialMessages', 'mcpServers', 'model', 'onElicitation', 'onUserDialog',
    'pathToClaudeCodeExecutable', 'perTaskStopAffordance', 'permissionMode', 'promptSuggestions', 'resume',
    'resumeSessionAt', 'sessionId', 'settingSources', 'settings', 'stderr', 'supportedDialogKinds', 'systemPrompt',
    'title', 'toolConfig', 'tools',
  ]),
  ...declaredGroup('sdk-export', 'sdk.d.ts', 'sdk-adapter.mjs', [
    'query', 'listSessions', 'getSessionInfo', 'getSessionMessages', 'getSubagentMessages', 'listSubagents',
    'renameSession', 'tagSession', 'forkSession', 'deleteSession', 'resolveSettings',
  ]),
  // Query methods that sdk.d.ts does not declare. sdk.mjs defines each one and sends the control request in `wire`.
  { name: 'getStatus', kind: 'sdk-method', source: 'sdk.mjs', wire: 'get_status', used: 'contracts.mjs RUNTIME_VIEWS' },
  {
    name: 'listPermissionRules', kind: 'sdk-method', source: 'sdk.mjs', wire: 'list_permission_rules',
    used: 'contracts.mjs RUNTIME_VIEWS',
  },
  {
    name: 'getHooksListing', kind: 'sdk-method', source: 'sdk.mjs', wire: 'get_hooks_listing',
    used: 'contracts.mjs RUNTIME_VIEWS',
  },
  {
    name: 'getSettings', kind: 'sdk-method', source: 'sdk.mjs', wire: 'get_settings',
    used: 'contracts.mjs RUNTIME_VIEWS',
  },
  {
    name: 'getSkillsDialog', kind: 'sdk-method', source: 'sdk.mjs', wire: 'get_skills_dialog',
    used: 'contracts.mjs RUNTIME_VIEWS',
  },
  {
    name: 'getSandboxDialog', kind: 'sdk-method', source: 'sdk.mjs', wire: 'get_sandbox_dialog',
    used: 'contracts.mjs RUNTIME_VIEWS',
  },
  { name: 'getPlan', kind: 'sdk-method', source: 'sdk.mjs', wire: 'get_plan', used: 'contracts.mjs RUNTIME_VIEWS' },
  {
    name: 'getChromeDialog', kind: 'sdk-method', source: 'sdk.mjs', wire: 'get_chrome_dialog',
    used: 'contracts.mjs RUNTIME_VIEWS',
  },
  {
    name: 'getMemoryDialog', kind: 'sdk-method', source: 'sdk.mjs', wire: 'get_memory_dialog',
    used: 'host.mjs memory',
  },
  {
    name: 'exportConversation', kind: 'sdk-method', source: 'sdk.mjs', wire: 'export_conversation',
    used: 'host.mjs exportConversation',
  },
  {
    name: 'getTaskOutput', kind: 'sdk-method', source: 'sdk.mjs', wire: 'get_task_output',
    used: 'host.mjs task output',
  },
  {
    name: 'cancelAsyncMessage', kind: 'sdk-method', source: 'sdk.mjs', wire: 'cancel_async_message',
    used: 'host.mjs cancelQueued',
  },
  {
    name: 'askSideQuestion', kind: 'sdk-method', source: 'sdk.mjs', wire: 'side_question',
    used: 'host.mjs side question',
  },
  { name: 'setCwd', kind: 'sdk-method', source: 'sdk.mjs', wire: 'set_cwd', used: 'trust.mjs handshake' },
  {
    name: 'claudeAuthenticate', kind: 'sdk-method', source: 'sdk.mjs', wire: 'claude_authenticate',
    used: 'account.mjs sign-in',
  },
  {
    name: 'claudeOAuthCallback', kind: 'sdk-method', source: 'sdk.mjs', wire: 'claude_oauth_callback',
    used: 'account.mjs sign-in',
  },
  {
    name: 'mcpAuthenticate', kind: 'sdk-method', source: 'sdk.mjs', wire: 'mcp_authenticate',
    used: 'host.mjs MCP sign-in',
  },
  {
    name: 'mcpSubmitOAuthCallbackUrl', kind: 'sdk-method', source: 'sdk.mjs', wire: 'mcp_oauth_callback_url',
    used: 'host.mjs MCP sign-in',
  },
  { name: 'mcpClearAuth', kind: 'sdk-method', source: 'sdk.mjs', wire: 'mcp_clear_auth', used: 'host.mjs MCP sign-in' },
  {
    name: 'request', kind: 'sdk-method', source: 'sdk.mjs', wire: 'file_suggestions',
    used: 'host.mjs file suggestions',
  },
  // Undeclared option of the interrupt control request (the declared interrupt() takes no argument).
  { name: 'cancelQueued', kind: 'sdk-option', source: 'sdk.mjs', wire: 'cancel_queued', used: 'host.mjs interrupt' },
  { name: 'CLAUDE_AGENT_SDK_CLIENT_APP', kind: 'sdk-env', source: 'sdk.mjs', used: 'env.mjs engineEnv' },
  // Command-line flags the gateway passes through extraArgs (or the terminal's argument list).
  { name: '--thinking-display', kind: 'cli-flag', source: 'binary', used: 'host.mjs cliFlagsOf' },
  { name: '--chrome', kind: 'cli-flag', source: 'binary', used: 'host.mjs cliFlagsOf (CAW_CHROME)' },
  { name: '--resume', kind: 'cli-flag', source: 'binary', used: 'terminal.mjs launch' },
  // Environment names the runtime reads, which the gateway sets or passes on.
  { name: 'DISABLE_AUTOUPDATER', kind: 'env', source: 'binary', used: 'env.mjs RUNTIME_DEFAULTS' },
  {
    name: 'CLAUDE_CODE_STARTUP_FAILURE_RESULTS', kind: 'env', source: 'binary', used: 'env.mjs RUNTIME_DEFAULTS',
  },
  {
    name: 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS', kind: 'env', source: 'binary',
    used: 'config.mjs backgroundTasksDisabled',
  },
  { name: 'IS_SANDBOX', kind: 'env', source: 'binary', used: 'contracts.mjs BYPASS_ROOT_MESSAGE' },
  // Stream message types and system subtypes that the browser or the host renders and sdk.d.ts does not declare.
  { name: 'command_lifecycle', kind: 'stream', source: 'binary', used: 'public/js/timeline/model.js' },
  { name: 'autocompact_state', kind: 'stream', source: 'binary', used: 'public/js/timeline/model.js' },
  { name: 'session_title_changed', kind: 'stream', source: 'binary', used: 'host.mjs, public/js/ui/app-shell.js' },
  { name: 'task_summary', kind: 'stream', source: 'binary', used: 'public/js/timeline/model.js' },
  { name: 'post_turn_summary', kind: 'stream', source: 'binary', used: 'public/js/timeline/model.js' },
  // Dialog kind and the payload keys the refusal dialog reads (request_user_dialog payload is typed as a record).
  { name: 'refusal_fallback_prompt', kind: 'dialog', source: 'binary', used: 'requests.mjs refusalDialogOf' },
  { name: 'originalModel', kind: 'dialog', source: 'binary', used: 'requests.mjs refusalDialogOf' },
  { name: 'fallbackModel', kind: 'dialog', source: 'binary', used: 'requests.mjs refusalDialogOf' },
  { name: 'apiRefusalCategory', kind: 'dialog', source: 'binary', used: 'requests.mjs refusalDialogOf' },
  { name: 'guidanceText', kind: 'dialog', source: 'binary', used: 'requests.mjs refusalDialogOf' },
  { name: 'retractedMessageUuids', kind: 'dialog', source: 'binary', used: 'requests.mjs refusalDialogOf' },
]));
