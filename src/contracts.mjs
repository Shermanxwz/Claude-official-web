// @ts-check
/**
 * Shared contracts for the gateway. Every backend module imports types and constants from here.
 * Changing this file is an integration decision (see docs/ENGINEERING.md).
 */

/** @typedef {import('@anthropic-ai/claude-agent-sdk').SDKMessage} SDKMessage */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SDKUserMessage} SDKUserMessage */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SDKSystemMessage} SDKSystemMessage */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SDKSessionInfo} SDKSessionInfo */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SessionMessage} SessionMessage */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').Options} SdkOptions */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').Query} SdkQuery */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').PermissionMode} PermissionMode */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').EffortLevel} EffortLevel */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').PermissionResult} PermissionResult */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').PermissionUpdate} PermissionUpdate */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').ElicitationRequest} ElicitationRequest */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').ElicitationResult} ElicitationResult */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SlashCommand} SlashCommand */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').ModelInfo} ModelInfo */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').AgentInfo} AgentInfo */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').AccountInfo} AccountInfo */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').McpServerStatus} McpServerStatus */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').RewindFilesResult} RewindFilesResult */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SDKControlGetContextUsageResponse} ContextUsage */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').ListSessionsOptions} ListSessionsOptions */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').GetSessionMessagesOptions} GetSessionMessagesOptions */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').GetSessionInfoOptions} GetSessionInfoOptions */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').ForkSessionOptions} ForkSessionOptions */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').ForkSessionResult} ForkSessionResult */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SessionMutationOptions} SessionMutationOptions */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').ResolveSettingsOptions} ResolveSettingsOptions */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').ResolvedSettings} ResolvedSettings */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').FastModeState} FastModeState */

export const PERMISSION_MODES = /** @type {const} */ (['default', 'acceptEdits', 'plan', 'auto', 'dontAsk',
  'bypassPermissions']);
export const EFFORT_LEVELS = /** @type {const} */ (['low', 'medium', 'high', 'xhigh', 'max']);
export const ACCESS_PROFILES = /** @type {const} */ (['read', 'standard', 'full']);
export const LIVE_STATES = /** @type {const} */ (['starting', 'idle', 'running', 'requires_action', 'closing',
  'error']);
export const REQUEST_KINDS = /** @type {const} */ (['permission', 'question', 'plan', 'elicitation', 'dialog']);
export const EVENT_TYPES = /** @type {const} */ (['hello', 'heartbeat', 'resync', 'sessions_changed',
  'session_state', 'sdk', 'request', 'request_resolved', 'message_accepted', 'message_cancelled', 'account_changed',
  'notice', 'terminal_state']);
/** Dialog kinds of the runtime's request_user_dialog that the gateway renders (declared as supportedDialogKinds). */
export const DIALOG_KINDS = /** @type {const} */ (['refusal_fallback_prompt']);
/** Answers of a refusal_fallback_prompt dialog. */
export const REFUSAL_DIALOG_RESULTS = /** @type {const} */ (['retry_fallback', 'edit_prompt', 'cancelled']);

/**
 * Read-only runtime views (docs/PROTOCOL.md "Runtime views"): name → method of the live SDK query, the access
 * profile a client needs, and the control timeout. A view is offered only when the query has the method.
 * @type {Readonly<Record<string, {method: string, profile: 'read'|'standard'|'full', timeoutMs: number}>>}
 */
export const RUNTIME_VIEWS = Object.freeze({
  status: Object.freeze({ method: 'getStatus', profile: 'standard', timeoutMs: 10000 }),
  permissions: Object.freeze({ method: 'listPermissionRules', profile: 'read', timeoutMs: 10000 }),
  hooks: Object.freeze({ method: 'getHooksListing', profile: 'standard', timeoutMs: 10000 }),
  settings: Object.freeze({ method: 'getSettings', profile: 'full', timeoutMs: 10000 }),
  skills: Object.freeze({ method: 'getSkillsDialog', profile: 'read', timeoutMs: 10000 }),
  sandbox: Object.freeze({ method: 'getSandboxDialog', profile: 'read', timeoutMs: 10000 }),
  plan: Object.freeze({ method: 'getPlan', profile: 'read', timeoutMs: 10000 }),
  usage: Object.freeze({ method: 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET', profile: 'read',
    timeoutMs: 15000 }),
  account: Object.freeze({ method: 'accountInfo', profile: 'read', timeoutMs: 10000 }),
  init: Object.freeze({ method: 'initializationResult', profile: 'standard', timeoutMs: 10000 }),
  mcp: Object.freeze({ method: 'mcpServerStatus', profile: 'read', timeoutMs: 10000 }),
  chrome: Object.freeze({ method: 'getChromeDialog', profile: 'read', timeoutMs: 10000 }),
});
/** Name of the operator's browser MCP server when a session attaches it (docs/PROTOCOL.md "Browser tools"). */
export const BROWSER_MCP_SERVER = 'browser';
/** Event types delivered only to clients watching the event's session. */
export const SESSION_SCOPED_EVENTS = /** @type {const} */ (['sdk']);
export const UPLOAD_DIR_NAME = '.caw-uploads';
export const SESSION_COOKIE = 'caw_session';

/**
 * @typedef {'read'|'standard'|'full'} AccessProfile
 * @typedef {'starting'|'idle'|'running'|'requires_action'|'closing'|'error'} LiveState
 * @typedef {'permission'|'question'|'plan'|'elicitation'|'dialog'} RequestKind
 * @typedef {'accepted'|'already'|'failed'|'skipped'} RuntimeTrust
 */

/**
 * Resolved runtime configuration (see src/config.mjs).
 * @typedef {Object} Config
 * @property {string} host
 * @property {number} port
 * @property {boolean} requireAuth
 * @property {string} token                plaintext login token ('' when only tokenSha256 is configured)
 * @property {string} tokenSha256           lowercase hex SHA-256 of the login token ('' when token is configured)
 * @property {string} publicOrigin           canonical exact origin or ''
 * @property {AccessProfile} profile
 * @property {string} appName
 * @property {string} version               package.json version
 * @property {string[]} roots               realpath'd absolute workspace roots
 * @property {string} stateDir
 * @property {'sdk'|'mock'} engine
 * @property {string|null} claudeBin        pathToClaudeCodeExecutable override
 * @property {{model: string|null, permissionMode: PermissionMode|null, effort: EffortLevel|null,
 *   fallbackModel: string|null}} defaults   permissionMode null (default) = Claude Code's settings decide
 * @property {boolean} terminal
 * @property {boolean} allowBypass
 * @property {boolean} chrome               CAW_CHROME=1: queries start with the CLI's --chrome flag
 * @property {string[]|null} browserMcpCommand   CAW_BROWSER_MCP_COMMAND (command + args), null when unset
 * @property {boolean} backgroundTasksDisabled   CLAUDE_CODE_DISABLE_BACKGROUND_TASKS is set (non-empty, not 0/false)
 *   in the environment the gateway was started with, which the runtime inherits
 * @property {number} idleTimeoutMs
 * @property {number} maxLiveSessions
 * @property {number} uploadMaxBytes
 * @property {number} imageMaxBytes
 * @property {number} uploadRetentionDays
 * @property {number} sessionTtlMs
 * @property {boolean} trustProxy
 * @property {'debug'|'info'|'warn'|'error'} logLevel
 */

/**
 * @typedef {Object} LiveInfo
 * @property {string} sessionId
 * @property {string} cwd
 * @property {LiveState} state
 * @property {string|null} model
 * @property {PermissionMode|null} permissionMode   null until system/init reports the mode the runtime started in
 * @property {EffortLevel|null} effort
 * @property {string|null} title
 * @property {string|null} agent            main-thread agent the query runs as (option `agent`)
 * @property {string[]} additionalDirectories   extra working directories the query started with
 * @property {string|null} fallbackModel    fallback model the query started with
 * @property {boolean} browserTools         the operator's browser MCP server is attached
 * @property {'terminal'|null} lockedBy
 * @property {number} pendingCount
 * @property {number} lastActivity
 * @property {string|null} claudeCodeVersion
 * @property {{code: string, message: string}|null} error
 * @property {boolean} trusted              project settings, hooks, skills and MCP servers of cwd are loaded
 * @property {boolean|null} fastMode        fast mode the gateway requested (flag settings layer); null = settings decide
 * @property {FastModeState|null} fastModeState   what the runtime last reported (init or result); null = unknown
 * @property {string|null} fastModeDisabledReason   FastModeDisabledReason from the same report; null = nothing blocks
 * @property {number} backgroundTasks       live non-ambient background tasks (system/background_tasks_changed)
 */

/**
 * @typedef {Object} PendingRequest
 * @property {string} id
 * @property {string} sessionId
 * @property {RequestKind} kind
 * @property {number} createdAt
 * @property {string} [toolName]
 * @property {string} [toolUseId]
 * @property {string} [agentId]
 * @property {Record<string, unknown>} [input]
 * @property {string} [title]
 * @property {string} [displayName]
 * @property {string} [description]
 * @property {string} [decisionReason]
 * @property {string} [blockedPath]
 * @property {PermissionUpdate[]} [suggestions]
 * @property {boolean} [suppressAlwaysAllowRule]
 * @property {boolean} [defaultToNo]
 * @property {{name: string, source: string}} [mcpServer]
 * @property {ElicitationRequest} [elicitation]
 * @property {RefusalFallbackDialog} [dialog]   kind 'dialog' only
 */

/**
 * The runtime's request_user_dialog of kind 'refusal_fallback_prompt', copied as plain strings.
 * @typedef {Object} RefusalFallbackDialog
 * @property {'refusal_fallback_prompt'} dialogKind
 * @property {string} originalModel
 * @property {string} fallbackModel
 * @property {string|null} apiRefusalCategory
 * @property {string|null} guidanceText
 * @property {string[]} retractedMessageUuids
 */

/** @typedef {SDKSessionInfo & {live: LiveInfo|null}} SessionSummary */
/** @typedef {{seq: number, msg: SDKMessage}} LiveEvent */

/**
 * Gateway event before sequencing. `sessionId` is required for session-scoped events.
 * @typedef {Object} GatewayEvent
 * @property {typeof EVENT_TYPES[number]} type
 * @property {Record<string, unknown>} data
 * @property {string} [sessionId]
 */

/**
 * Publishes an event to all SSE clients and returns its global sequence number.
 * @typedef {(event: GatewayEvent) => number} Publish
 */

/**
 * @typedef {Object} Logger
 * @property {(msg: string, fields?: Record<string, unknown>) => void} debug
 * @property {(msg: string, fields?: Record<string, unknown>) => void} info
 * @property {(msg: string, fields?: Record<string, unknown>) => void} warn
 * @property {(msg: string, fields?: Record<string, unknown>) => void} error
 */

/**
 * The surface of @anthropic-ai/claude-agent-sdk used by the gateway. Implemented by src/engine/sdk-adapter.mjs
 * (real SDK) and src/engine/mock/index.mjs (deterministic mock).
 * @typedef {Object} EngineAdapter
 * @property {'sdk'|'mock'} kind
 * @property {string|null} sdkVersion
 * @property {(params: {prompt: AsyncIterable<SDKUserMessage>, options: SdkOptions}) => SdkQuery} query
 * @property {(options?: ListSessionsOptions) => Promise<SDKSessionInfo[]>} listSessions
 * @property {(sessionId: string, options?: GetSessionMessagesOptions) => Promise<SessionMessage[]>} getSessionMessages
 * @property {(sessionId: string, options?: GetSessionInfoOptions) => Promise<SDKSessionInfo|undefined>} getSessionInfo
 * @property {(sessionId: string, title: string, options?: SessionMutationOptions) => Promise<void>} renameSession
 * @property {(sessionId: string, tag: string|null, options?: SessionMutationOptions) => Promise<void>} tagSession
 * @property {(sessionId: string, options?: ForkSessionOptions) => Promise<ForkSessionResult>} forkSession
 * @property {(sessionId: string, options?: SessionMutationOptions) => Promise<void>} deleteSession
 * @property {(sessionId: string) => Promise<string[]>} listSubagents
 * @property {(sessionId: string, agentId: string) => Promise<SessionMessage[]>} getSubagentMessages
 * @property {(options: ResolveSettingsOptions) => Promise<ResolvedSettings>} resolveSettings
 *   the settings cascade a query with these options would load (SDK `resolveSettings`, no process is spawned)
 */

/**
 * @typedef {Object} SessionDetail
 * @property {SDKSessionInfo|null} info
 * @property {LiveInfo|null} live
 * @property {PendingRequest[]} pending
 * @property {LiveEvent[]} liveEvents
 * @property {number} seq
 * @property {SDKSystemMessage|null} init
 */

/**
 * @typedef {Object} Capabilities
 * @property {boolean} stale
 * @property {SlashCommand[]} commands
 * @property {ModelInfo[]} models
 * @property {AgentInfo[]} agents
 * @property {AccountInfo|null} account
 * @property {McpServerStatus[]} mcpServers
 * @property {string|null} outputStyle
 * @property {string[]} availableOutputStyles
 */

/**
 * Answer of a reload: applied, or held by the runtime's prompt-cache check (plugins without `force`).
 * @typedef {{ok: true, availableOutputStyles?: string[]} | {ok: false, held: true, cacheImpact: {
 *   mcpServersAdded: string[], mcpServersRemoved: string[],
 *   lspToolChange: 'adds'|'may-add'|'removes'|'may-remove'|null}}} ReloadResult
 */

/**
 * @typedef {Object} SessionSettings
 * @property {string|null} [model]
 * @property {PermissionMode|null} [permissionMode]   null = not passed; Claude Code's settings decide
 * @property {EffortLevel|null} [effort]
 * @property {boolean|null} [fastMode]
 * @property {string|null} [agent]
 * @property {string[]} [additionalDirectories]
 * @property {string|null} [fallbackModel]
 * @property {boolean} [browserTools]
 */

/**
 * @typedef {Object} MemoryFile
 * @property {string} kind
 * @property {string} path
 * @property {string} label
 * @property {string} description
 * @property {boolean} exists
 * @property {string|null} content
 * @property {boolean} truncated
 * @property {boolean} editable
 */

/**
 * @typedef {Object} SessionSearchResult
 * @property {string} sessionId
 * @property {string|null} cwd
 * @property {string|null} title
 * @property {number} lastModified
 * @property {'title'|'content'} matchedIn
 * @property {string[]} snippets
 */

/**
 * Claude Code's own sign-in, run by the runtime (src/engine/account.mjs).
 * @typedef {Object} AccountApi
 * @property {() => Promise<{account: AccountInfo|null, signInPending: boolean}>} status
 * @property {(method: 'claudeai'|'console') => Promise<{manualUrl: string, automaticUrl: string|null}>} startLogin
 * @property {(code: string) => Promise<{account: AccountInfo}>} completeLogin
 * @property {() => Promise<void>} cancelLogin
 * @property {() => Promise<void>} close   ends the account query (shutdown)
 */

/**
 * Public surface of src/engine/host.mjs (class EngineHost). Every method throws AppError for expected failures.
 * @typedef {Object} EngineHostApi
 * @property {(opts?: {cwd?: string, limit?: number, offset?: number}) => Promise<SessionSummary[]>} listSessions
 * @property {(sessionId: string) => Promise<SessionDetail>} getSession
 * @property {(sessionId: string, opts: {tail?: number, before?: number, limit?: number}) =>
 *   Promise<{messages: Array<SessionMessage & {index: number}>, total: number, start: number, hasMore: boolean}>}
 *   getTranscript
 * @property {(opts: {cwd: string, title?: string} & SessionSettings) => Promise<LiveInfo>} createSession
 * @property {(sessionId: string, settings?: SessionSettings) => Promise<LiveInfo>} openSession
 * @property {(sessionId: string) => Promise<void>} closeSession
 * @property {(sessionId: string, msg: {clientMessageId: string, text: string,
 *   images?: Array<{mediaType: string, data: string}>}) => Promise<{accepted: true, duplicate: boolean}>} sendMessage
 * @property {(sessionId: string, opts?: {cancelQueued?: boolean}) =>
 *   Promise<{stillQueued: string[], cancelled: string[]}>} interrupt
 * @property {(sessionId: string, clientMessageId: string) => Promise<{cancelled: boolean}>} cancelQueued
 * @property {(sessionId: string, settings: SessionSettings) =>
 *   Promise<{live: LiveInfo|null, restartRequired: boolean}>} updateSettings
 * @property {(sessionId: string, requestId: string, body: Record<string, unknown>) => Promise<void>} respond
 * @property {(sessionId: string, detail?: 'summary'|'full') => Promise<ContextUsage>} getContextUsage
 * @property {(sessionId: string) => Promise<Capabilities>} getCapabilities
 * @property {(sessionId: string, server: string, action: {action: 'toggle'|'reconnect'|'permission-mode',
 *   enabled?: boolean, mode?: 'default'|'auto'|null}) => Promise<{mcpServers: McpServerStatus[], warning?: string}>}
 *   mcpAction
 * @property {(sessionId: string, server: string, action: {action: 'start'|'callback'|'clear', callbackUrl?: string}) =>
 *   Promise<Record<string, unknown>>} mcpAuth
 * @property {(sessionId: string) => Promise<{views: string[]}>} runtimeViews
 * @property {(sessionId: string, view: string) => Promise<{view: string, data: unknown, fetchedAt: number}>} runtimeView
 *   the caller (app.mjs) checks RUNTIME_VIEWS[view].profile first
 * @property {(sessionId: string) => Promise<{files: MemoryFile[], folders: unknown[], autoMemory: unknown,
 *   autoDream: unknown}>} getMemory
 * @property {(sessionId: string, path: string, content: string) => Promise<{bytes: number}>} writeMemory
 * @property {(sessionId: string) => Promise<{text: string, filename: string}>} exportConversation
 * @property {(sessionId: string, taskId: string) => Promise<{output: string, totalBytes: number, truncated: boolean}>}
 *   taskOutput
 * @property {(sessionId: string, question: string) => Promise<{response: string|null, synthetic: boolean,
 *   refusalFallback: {originalModel: string, fallbackModel: string}|null}>} sideQuestion
 * @property {(sessionId: string, cwd: string, query: string, limit: number) =>
 *   Promise<Array<{path: string, type: 'file'|'dir'}>|null>} fileSuggestions
 *   the runtime's @ index; null when it cannot answer (not live, other cwd, missing, failed, timed out or empty)
 * @property {(dir: string) => Promise<RuntimeTrust>} recordRuntimeTrust   the runtime's own trust handshake
 * @property {(sessionId: string, what: 'plugins'|'skills'|'output-styles', opts?: {force?: boolean}) =>
 *   Promise<ReloadResult>} reload
 * @property {(sessionId: string, toolUseId?: string) => Promise<{backgrounded: boolean}>} backgroundTasks
 *   moves foreground Bash commands and subagents to the background (the terminal's Ctrl+B)
 * @property {(sessionId: string, style: string) => Promise<{outputStyle: string, availableOutputStyles: string[]}>}
 *   setOutputStyle   writes the project's local settings through the runtime's own writer
 * @property {(sessionId: string, opts: {userMessageId: string, mode: 'code'|'conversation'|'both', dryRun?: boolean}) =>
 *   Promise<{files?: RewindFilesResult, conversation?: {resumeAt: string}}>} rewind
 * @property {(sessionId: string, opts: {upToMessageId?: string, title?: string}) => Promise<{sessionId: string}>} fork
 * @property {(sessionId: string, title: string) => Promise<void>} rename
 * @property {(sessionId: string, tag: string|null) => Promise<void>} tag
 * @property {(sessionId: string) => Promise<void>} deleteSession
 * @property {(sessionId: string, taskId: string) => Promise<void>} stopTask
 * @property {(sessionId: string) => Promise<string[]>} listSubagents
 * @property {(sessionId: string, agentId: string) => Promise<SessionMessage[]>} getSubagentMessages
 * @property {(sessionId: string) => Promise<string>} sessionCwd
 *   cwd of a live or persisted session (throws SESSION_NOT_FOUND)
 * @property {(sessionId: string) => Promise<() => void>} lockForTerminal
 *   closes the live query, marks the session locked and returns the release function
 * @property {(sessionId: string) => LiveInfo|null} liveInfo
 * @property {() => LiveInfo[]} allLive
 * @property {() => string|null} lastClaudeCodeVersion   version from the most recent init message, kept after close
 * @property {(now?: number) => Promise<number>} sweepIdle   closes idle sessions, returns how many were closed
 * @property {() => Promise<void>} shutdown
 */

/**
 * Public surface of src/workspaces.mjs.
 * @typedef {Object} WorkspacesApi
 * @property {string[]} roots
 * @property {(p: string) => Promise<string>} resolveDir      realpath of an existing directory inside a root
 * @property {(p: string) => Promise<boolean>} isInsideRoots
 * @property {(p?: string|null) => Promise<{path: string|null, parent: string|null,
 *   entries: Array<{name: string, path: string, isProject: boolean}>}>} listDirs
 * @property {(parent: string, name: string) => Promise<{path: string}>} mkdir
 * @property {(cwd: string, q: string, limit?: number) =>
 *   Promise<{results: Array<{path: string, type: 'file'|'dir'}>}>} search
 * @property {(p: string) => Promise<boolean>} isTrusted
 *   true when the realpath equals or is inside a folder the owner trusted (never throws)
 * @property {(p: string, trusted: boolean) => Promise<{path: string, trusted: boolean}>} setTrusted
 *   records or removes trust for an existing directory inside the roots
 */

/**
 * Public surface of src/attachments.mjs.
 * @typedef {Object} AttachmentsApi
 * @property {(req: import('node:http').IncomingMessage, opts: {cwd: string, fileName: string, mediaType: string}) =>
 *   Promise<{path: string, name: string, size: number, mediaType: string, kind: 'image'|'file'}>} save
 * @property {(absPath: string, cwd: string) => Promise<{kind: 'image', mediaType: string, data: string}|
 *   {kind: 'file', path: string}>} resolveAttachment   validates the path belongs to <cwd>/.caw-uploads
 * @property {(now?: number) => Promise<{removed: number}>} cleanup
 */

/**
 * Public surface of src/terminal.mjs.
 * @typedef {Object} TerminalApi
 * @property {boolean} enabled
 * @property {string|null} disabledReason
 * @property {(req: import('node:http').IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => void}
 *   handleUpgrade   called by app.mjs after auth, Origin and profile checks passed
 * @property {() => Promise<void>} closeAll
 */

/**
 * Expected failure with an HTTP status and a stable error code (see docs/PROTOCOL.md).
 */
export class AppError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {{retryAfter?: number}} [extra]
   */
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.retryAfter = extra.retryAfter;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}
