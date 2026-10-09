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

export const PERMISSION_MODES = /** @type {const} */ (['default', 'acceptEdits', 'plan', 'auto', 'dontAsk',
  'bypassPermissions']);
export const EFFORT_LEVELS = /** @type {const} */ (['low', 'medium', 'high', 'xhigh', 'max']);
export const ACCESS_PROFILES = /** @type {const} */ (['read', 'standard', 'full']);
export const LIVE_STATES = /** @type {const} */ (['starting', 'idle', 'running', 'requires_action', 'closing',
  'error']);
export const REQUEST_KINDS = /** @type {const} */ (['permission', 'question', 'plan', 'elicitation']);
export const EVENT_TYPES = /** @type {const} */ (['hello', 'heartbeat', 'resync', 'sessions_changed',
  'session_state', 'sdk', 'request', 'request_resolved', 'message_accepted', 'notice', 'terminal_state']);
/** Event types delivered only to clients watching the event's session. */
export const SESSION_SCOPED_EVENTS = /** @type {const} */ (['sdk']);
export const UPLOAD_DIR_NAME = '.caw-uploads';
export const SESSION_COOKIE = 'caw_session';

/**
 * @typedef {'read'|'standard'|'full'} AccessProfile
 * @typedef {'starting'|'idle'|'running'|'requires_action'|'closing'|'error'} LiveState
 * @typedef {'permission'|'question'|'plan'|'elicitation'} RequestKind
 */

/**
 * Resolved runtime configuration (see src/config.mjs).
 * @typedef {Object} Config
 * @property {string} host
 * @property {number} port
 * @property {boolean} requireAuth
 * @property {string} token
 * @property {string} publicOrigin           canonical exact origin or ''
 * @property {AccessProfile} profile
 * @property {string} appName
 * @property {string} version               package.json version
 * @property {string[]} roots               realpath'd absolute workspace roots
 * @property {string} stateDir
 * @property {'sdk'|'mock'} engine
 * @property {string|null} claudeBin        pathToClaudeCodeExecutable override
 * @property {{model: string|null, permissionMode: PermissionMode, effort: EffortLevel|null}} defaults
 * @property {boolean} terminal
 * @property {boolean} allowBypass
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
 * @property {PermissionMode} permissionMode
 * @property {EffortLevel|null} effort
 * @property {string|null} title
 * @property {'terminal'|null} lockedBy
 * @property {number} pendingCount
 * @property {number} lastActivity
 * @property {string|null} claudeCodeVersion
 * @property {{code: string, message: string}|null} error
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
 * @typedef {Object} SessionSettings
 * @property {string|null} [model]
 * @property {PermissionMode} [permissionMode]
 * @property {EffortLevel|null} [effort]
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
 * @property {(sessionId: string) => Promise<void>} interrupt
 * @property {(sessionId: string, settings: SessionSettings) => Promise<LiveInfo|null>} updateSettings
 * @property {(sessionId: string, requestId: string, body: Record<string, unknown>) => Promise<void>} respond
 * @property {(sessionId: string) => Promise<ContextUsage>} getContextUsage
 * @property {(sessionId: string) => Promise<Capabilities>} getCapabilities
 * @property {(sessionId: string, server: string, action: {action: 'toggle'|'reconnect', enabled?: boolean}) =>
 *   Promise<McpServerStatus[]>} mcpAction
 * @property {(sessionId: string, what: 'plugins'|'skills') => Promise<void>} reload
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
