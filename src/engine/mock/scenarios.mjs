// @ts-check
/**
 * Deterministic turn scripts for the mock engine.
 *
 * A scenario is an async generator that yields the SDK messages of one turn. It receives a turn context from
 * query.mjs and uses only that context: it never touches the store, the filesystem or the clock directly. Every
 * wait goes through `ctx.pause`, `ctx.askPermission` or `ctx.elicitation`, which are the points where an interrupt
 * takes effect. This module also holds the message builders shared with query.mjs, so every SDK message the mock
 * produces is constructed in one place.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { BROWSER_MCP_SERVER } from '../../contracts.mjs';

/** @typedef {import('../../contracts.mjs').SDKMessage} SDKMessage */
/** @typedef {import('../../contracts.mjs').SDKUserMessage} SDKUserMessage */
/** @typedef {import('../../contracts.mjs').PermissionMode} PermissionMode */
/** @typedef {import('../../contracts.mjs').ElicitationRequest} ElicitationRequest */
/** @typedef {import('../../contracts.mjs').ElicitationResult} ElicitationResult */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SDKAssistantMessage} SDKAssistantMessage */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SDKAssistantMessage['message']} BetaMessage */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SDKPartialAssistantMessage} SDKPartialAssistantMessage */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SDKPartialAssistantMessage['event']} BetaStreamEvent */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SDKUserMessageReplay} SDKUserMessageReplay */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SDKStatusMessage} SDKStatusMessage */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').PermissionUpdate} PermissionUpdate */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SDKAPIRetryMessage} SDKAPIRetryMessage */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SDKSessionStateChangedMessage} SDKSessionStateChangedMessage */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SDKPermissionDeniedMessage} SDKPermissionDeniedMessage */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SDKRateLimitInfo} SDKRateLimitInfo */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').NonNullableUsage} NonNullableUsage */
/** @typedef {Exclude<SDKUserMessage['message']['content'], string>[number]} UserContentBlock */

/** Context-window numbers shared by the scenarios and the query. */
export const CONTEXT_MAX_TOKENS = 200000;
const BASE_PROMPT_TOKENS = 900;
const CACHE_READ_TOKENS = 2048;

/**
 * Raised by a scenario that must end the turn with an error result.
 */
export class ScenarioFailure extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ScenarioFailure';
  }
}

/**
 * @typedef {Object} PermissionDetail
 * @property {string} toolUseId
 * @property {string} [title]
 * @property {string} [displayName]
 * @property {string} [description]
 * @property {string} [decisionReason]
 * @property {string} [blockedPath]
 * @property {{name: string, source: string}} [mcpServer]
 * @property {PermissionUpdate[]} [suggestions]  the "always allow" choices offered with the request
 */

/**
 * `updatedPermissions` holds the suggestions the host returned with its approval, as it returned them.
 * `interrupt` is set when the user denied with "stop the turn", so the scenario must not continue.
 * @typedef {{allowed: true, input: Record<string, unknown>, updatedPermissions: PermissionUpdate[]} |
 *   {allowed: false, message: string, interrupt: boolean}} PermissionOutcome
 */

/**
 * @typedef {Object} SessionSummary
 * @property {string} model
 * @property {string} plan
 * @property {number} contextTokens
 * @property {number} contextMax
 * @property {Array<{name: string, tokens: number}>} contextRows
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} costUsd
 * @property {number} fiveHourUtilization   percent of the five-hour window
 */

/**
 * A foreground command or agent registered by foregroundTask. `moved` resolves with the task it became once a
 * backgroundTasks call moves it.
 * @typedef {{toolUseId: string, description: string, moved: Promise<{taskId: string}>}} ForegroundTask
 */

/**
 * @typedef {Object} TurnContext
 * @property {string} sessionId
 * @property {string} cwd
 * @property {string} model
 * @property {string} userText
 * @property {string} userMessageUuid
 * @property {string[]} userMessageUuids     every prompt the turn answers, in consumption order
 * @property {number} delayMs
 * @property {boolean} streamPartials        whether text is streamed as stream_event messages
 * @property {number} turnIndex              zero-based turn number inside the session
 * @property {(kind: 'message'|'tool'|'agent'|'hook'|'task') => string} nextId
 * @property {() => {uuid: `${string}-${string}-${string}-${string}-${string}`, session_id: string}} envelope
 * @property {() => number} now
 * @property {boolean} thinkingSummaries     the query was started with --thinking-display summarized
 * @property {(toolUseId: string, description: string, output?: string) => ForegroundTask} foregroundTask   registers
 *   a command that a backgroundTasks call may move, with the output it prints once it completes in the background;
 *   call it before the tool call is streamed
 * @property {(task: ForegroundTask) => AsyncGenerator<SDKMessage, {taskId: string}|null, unknown>} awaitBackground
 *   waits until the command is moved to the background (`{taskId}`) or the wait ends (`null`)
 * @property {string[]} dialogKinds          the dialog kinds the host renders (supportedDialogKinds)
 * @property {string|null} fallbackModel     the model a refused answer is retried on (option fallbackModel)
 * @property {(dialog: {kind: string, payload: Record<string, unknown>, toolUseId?: string}) =>
 *   AsyncGenerator<SDKMessage, 'retry_fallback'|'edit_prompt'|'cancelled'|null, unknown>} userDialog
 *   asks the host through onUserDialog; the result is what the host answered (cancelled when it did not answer)
 * @property {(uuids: string[]) => void} retract  removes messages from the transcript and the turn's answer
 * @property {(ms: number) => AsyncGenerator<SDKMessage, void, unknown>} pause
 * @property {(toolName: string, input: Record<string, unknown>, detail: PermissionDetail) =>
 *   AsyncGenerator<SDKMessage, PermissionOutcome, unknown>} askPermission
 * @property {(request: ElicitationRequest) => AsyncGenerator<SDKMessage, ElicitationResult, unknown>} elicitation
 * @property {(serverName: string) => boolean} mcpConnected
 * @property {() => SessionSummary} describeSession
 */

/**
 * What the message builders read: the envelope of a new message, the clock, the model and the prompts of the turn in
 * progress (none between turns). Session-level control messages are built from this shape, so the builders never need
 * a turn.
 * @typedef {Pick<TurnContext, 'envelope' | 'now' | 'model' | 'userMessageUuids'>} SessionView
 */

/**
 * One block of a model response. A thinking block carries its text (empty when the runtime omits summaries) and the
 * signature the runtime attaches to it.
 * @typedef {{type: 'text', text: string, chunks?: string[]} |
 *   {type: 'thinking', text: string, signature: string} |
 *   {type: 'tool_use', id: string, name: string, input: Record<string, unknown>}} ResponseBlock
 */

/**
 * @typedef {{name: string, matches: (text: string) => boolean,
 *   run: (ctx: TurnContext) => AsyncGenerator<SDKMessage, void, unknown>}} Scenario
 */

/**
 * Formats an integer with thousands separators (deterministic, locale independent).
 * @param {number} value
 * @returns {string}
 */
function formatCount(value) {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Left-aligns the first column and right-aligns the others.
 * @param {string[]} headers
 * @param {string[][]} rows
 * @returns {string}
 */
function table(headers, rows) {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => row[column].length)));
  /** @param {string[]} cells */
  const line = (cells) => cells
    .map((cell, column) => (column === 0 ? cell.padEnd(widths[column]) : cell.padStart(widths[column])))
    .join('   ')
    .trimEnd();
  return [line(headers), ...rows.map(line)].join('\n');
}

/**
 * @param {SessionSummary} summary
 * @returns {string}
 */
function formatContext(summary) {
  const percent = Math.round((summary.contextTokens / summary.contextMax) * 100);
  const rows = summary.contextRows.map((row) => [row.name, formatCount(row.tokens)]);
  return [
    'Context usage',
    `Model: ${summary.model}`,
    `Tokens: ${formatCount(summary.contextTokens)} / ${formatCount(summary.contextMax)} (${percent}%)`,
    '',
    table(['Category', 'Tokens'], rows),
  ].join('\n');
}

/**
 * @param {SessionSummary} summary
 * @returns {string}
 */
function formatUsage(summary) {
  return table(['Session usage', ''], [
    ['Plan', summary.plan],
    ['Input tokens', formatCount(summary.inputTokens)],
    ['Output tokens', formatCount(summary.outputTokens)],
    ['Cost', `$${summary.costUsd.toFixed(2)}`],
    ['Five-hour window', `${Math.round(summary.fiveHourUtilization)}% used`],
  ]);
}

/**
 * Splits text into chunks of 4 to 12 code points, following a fixed cycle so that streams look natural and repeat.
 * @param {string} text
 * @returns {string[]}
 */
export function chunkText(text) {
  const plan = [4, 7, 5, 9, 6, 12, 8, 10];
  const points = Array.from(text);
  /** @type {string[]} */
  const chunks = [];
  let index = 0;
  for (let step = 0; index < points.length; step += 1) {
    const size = plan[step % plan.length];
    chunks.push(points.slice(index, index + size).join(''));
    index += size;
  }
  return chunks;
}

/**
 * Sums usage counters of several responses. Fixed fields come from the first response.
 * @param {NonNullableUsage[]} list
 * @returns {NonNullableUsage}
 */
export function sumUsage(list) {
  const total = usageOf({ input: 0, output: 0 });
  for (const usage of list) {
    total.input_tokens += usage.input_tokens;
    total.output_tokens += usage.output_tokens;
    total.cache_read_input_tokens += usage.cache_read_input_tokens;
    total.cache_creation_input_tokens += usage.cache_creation_input_tokens;
    total.server_tool_use.web_search_requests += usage.server_tool_use.web_search_requests;
    total.server_tool_use.web_fetch_requests += usage.server_tool_use.web_fetch_requests;
  }
  return total;
}

/**
 * @param {{input: number, output: number, cacheRead?: number, cacheCreate?: number, webSearch?: number,
 *   webFetch?: number}} counts
 * @returns {NonNullableUsage}
 */
export function usageOf({ input, output, cacheRead = 0, cacheCreate = 0, webSearch = 0, webFetch = 0 }) {
  return {
    cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: cacheCreate },
    cache_creation_input_tokens: cacheCreate,
    cache_read_input_tokens: cacheRead,
    fallback_credit: null,
    inference_geo: 'global',
    input_tokens: input,
    iterations: [],
    output_tokens: output,
    output_tokens_details: { thinking_tokens: 0 },
    server_tool_use: { web_fetch_requests: webFetch, web_search_requests: webSearch },
    service_tier: 'standard',
    speed: 'standard',
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A status notice. It carries the uuids of the prompts its turn answers, so a client can attach it to that turn; a
 * notice sent between turns carries an empty list.
 * @param {SessionView} ctx
 * @param {'compacting'|'requesting'|null} status
 * @param {{permissionMode?: PermissionMode, compact_result?: 'success'|'failed'}} [extra]
 * @returns {SDKStatusMessage & {user_message_uuids: string[]}}
 */
export function statusMessage(ctx, status, extra = {}) {
  return {
    type: 'system',
    subtype: 'status',
    status,
    ...extra,
    user_message_uuids: [...ctx.userMessageUuids],
    ...ctx.envelope(),
  };
}

/**
 * Messages the runtime sends that the SDK typings do not declare yet. Each shape is typed here and cast to SDKMessage
 * at the builder boundary, so the rest of the mock treats them like any other message.
 * @typedef {{type: 'command_lifecycle', command_uuid: string, state: 'queued'|'started'|'completed'|'cancelled',
 *   uuid: string, session_id: string}} CommandLifecycleMessage
 * @typedef {{type: 'system', subtype: 'task_summary', detail: string, uuid: string,
 *   session_id: string}} TaskSummaryMessage
 * @typedef {{type: 'system', subtype: 'post_turn_summary', summarizes_uuid: string,
 *   status_category: 'review_ready', status_detail: string, needs_action: string, uuid: string,
 *   session_id: string}} PostTurnSummaryMessage
 * @typedef {{type: 'system', subtype: 'session_title_changed', title: string, uuid: string,
 *   session_id: string}} SessionTitleChangedMessage
 * @typedef {{type: 'autocompact_state', value: {enabled: boolean, effective_window: number, threshold: number,
 *   enforced: boolean, source: string}, uuid: string, session_id: string}} AutocompactStateMessage
 * @typedef {{type: 'active_goal', value: null, uuid: string, session_id: string}} ActiveGoalMessage
 * @typedef {CommandLifecycleMessage | TaskSummaryMessage | PostTurnSummaryMessage | SessionTitleChangedMessage |
 *   AutocompactStateMessage | ActiveGoalMessage} RuntimeMessage
 */

/** Context tokens at which the runtime compacts the conversation by itself. */
export const AUTOCOMPACT_THRESHOLD_TOKENS = 167000;

/**
 * @param {RuntimeMessage} message
 * @returns {SDKMessage}
 */
function asSdk(message) {
  return /** @type {SDKMessage} */ (/** @type {unknown} */ (message));
}

/**
 * The lifecycle of one prompt: queued when it is accepted, started when its turn begins, completed after its result.
 * @param {SessionView} ctx
 * @param {string} commandUuid uuid of the prompt message
 * @param {'queued'|'started'|'completed'|'cancelled'} state
 * @returns {SDKMessage}
 */
export function commandLifecycle(ctx, commandUuid, state) {
  return asSdk({ type: 'command_lifecycle', command_uuid: commandUuid, state, ...ctx.envelope() });
}

/**
 * A one-line description of a tool that is about to run. Subagent tool calls get none, because their progress is
 * reported in task_progress.
 * @param {SessionView} ctx
 * @param {string} detail
 * @returns {SDKMessage}
 */
export function taskSummary(ctx, detail) {
  return asSdk({ type: 'system', subtype: 'task_summary', detail, ...ctx.envelope() });
}

/**
 * The one-line result of a turn, sent after its result message.
 * @param {SessionView} ctx
 * @param {{summarizes: string, detail: string}} summary  summarizes: uuid of the turn's last assistant message
 * @returns {SDKMessage}
 */
export function postTurnSummary(ctx, { summarizes, detail }) {
  return asSdk({
    type: 'system',
    subtype: 'post_turn_summary',
    summarizes_uuid: summarizes,
    status_category: 'review_ready',
    status_detail: detail,
    needs_action: '',
    ...ctx.envelope(),
  });
}

/**
 * The title that the first turn gives a session without a custom title.
 * @param {SessionView} ctx
 * @param {string} title
 * @returns {SDKMessage}
 */
export function sessionTitleChanged(ctx, title) {
  return asSdk({ type: 'system', subtype: 'session_title_changed', title, ...ctx.envelope() });
}

/**
 * The autocompact settings, sent once after init.
 * @param {SessionView} ctx
 * @returns {SDKMessage}
 */
export function autocompactState(ctx) {
  return asSdk({
    type: 'autocompact_state',
    value: {
      enabled: true,
      effective_window: CONTEXT_MAX_TOKENS,
      threshold: AUTOCOMPACT_THRESHOLD_TOKENS,
      enforced: true,
      source: 'clientdata',
    },
    ...ctx.envelope(),
  });
}

/**
 * The goal state, sent once after init. The mock never sets a goal, so the value is null.
 * @param {SessionView} ctx
 * @returns {SDKMessage}
 */
export function activeGoal(ctx) {
  return asSdk({ type: 'active_goal', value: null, ...ctx.envelope() });
}

/**
 * The first sentence of the first prose paragraph of a reply, for a one-line summary. Headings, quotes and code
 * fences are skipped, and the sentence is cut at 160 characters.
 * @param {string} text
 * @returns {string} empty when the reply has no prose
 */
export function sentenceOf(text) {
  const paragraphs = text.split(/\n\s*\n/).map((part) => part.trim()).filter((part) => part !== '');
  const prose = paragraphs.find((part) => !/^(#|>|```)/.test(part)) ?? '';
  const flat = prose.replace(/\s+/g, ' ');
  const match = /^(.*?[.!?])(\s|$)/.exec(flat);
  const points = Array.from(match ? match[1] : flat);
  return points.length > 160 ? `${points.slice(0, 157).join('')}...` : points.join('');
}

/**
 * @param {SessionView} ctx
 * @param {'idle'|'running'|'requires_action'} state
 * @returns {SDKSessionStateChangedMessage}
 */
export function stateChanged(ctx, state) {
  return { type: 'system', subtype: 'session_state_changed', state, ...ctx.envelope() };
}

/**
 * The echo of a user prompt that the session has consumed.
 * @param {SDKUserMessage} prompt
 * @param {string} sessionId
 * @returns {SDKUserMessageReplay}
 */
export function userReplay(prompt, sessionId) {
  return {
    type: 'user',
    message: prompt.message,
    parent_tool_use_id: null,
    isReplay: true,
    uuid: prompt.uuid,
    session_id: sessionId,
  };
}

/**
 * A user message that the runtime writes itself, such as the interruption marker.
 * @param {TurnContext} ctx
 * @param {string} text
 * @returns {SDKUserMessage}
 */
export function syntheticUser(ctx, text) {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    isSynthetic: true,
    parent_tool_use_id: null,
    ...ctx.envelope(),
  };
}

/**
 * @param {SessionView} ctx
 * @param {{toolName: string, toolUseId: string, message: string, reason: string}} args
 * @returns {SDKPermissionDeniedMessage}
 */
export function permissionDenied(ctx, { toolName, toolUseId, message, reason }) {
  return {
    type: 'system',
    subtype: 'permission_denied',
    tool_name: toolName,
    tool_use_id: toolUseId,
    decision_reason_type: reason,
    message,
    ...ctx.envelope(),
  };
}

/**
 * A tool_result block inside a user message. Subagent results carry `parentToolUseId` and `agentId`. The content is
 * text, or a list of text and image blocks (an MCP tool's screenshot, for example).
 * @param {TurnContext} ctx
 * @param {{toolUseId: string, content: string|Array<{type: 'text', text: string}|{type: 'image',
 *   source: {type: 'base64', media_type: 'image/jpeg'|'image/png'|'image/gif'|'image/webp', data: string}}>,
 *   isError?: boolean, toolUseResult?: unknown, parentToolUseId?: string|null, agentId?: string|null}} args
 * @returns {SDKUserMessage}
 */
export function toolResult(ctx, {
  toolUseId, content, isError = false, toolUseResult, parentToolUseId = null, agentId = null,
}) {
  /** @type {Extract<UserContentBlock, {type: 'tool_result'}>} */
  const block = { type: 'tool_result', tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) };
  return {
    type: 'user',
    message: { role: 'user', content: [block] },
    parent_tool_use_id: parentToolUseId,
    ...(toolUseResult === undefined ? {} : { tool_use_result: toolUseResult }),
    ...(agentId ? { agent_id: agentId } : {}),
    ...ctx.envelope(),
  };
}

/**
 * @param {TurnContext} ctx
 * @param {string} toolUseId
 * @param {string} toolName
 * @param {number} elapsedSeconds
 * @returns {import('@anthropic-ai/claude-agent-sdk').SDKToolProgressMessage}
 */
export function toolProgress(ctx, toolUseId, toolName, elapsedSeconds) {
  return {
    type: 'tool_progress',
    tool_use_id: toolUseId,
    tool_name: toolName,
    parent_tool_use_id: null,
    elapsed_time_seconds: elapsedSeconds,
    ...ctx.envelope(),
  };
}

/**
 * @param {TurnContext} ctx
 * @param {string} summary
 * @param {string[]} toolUseIds
 * @returns {import('@anthropic-ai/claude-agent-sdk').SDKToolUseSummaryMessage}
 */
export function toolUseSummary(ctx, summary, toolUseIds) {
  return { type: 'tool_use_summary', summary, preceding_tool_use_ids: toolUseIds, ...ctx.envelope() };
}

/**
 * @param {TurnContext} ctx
 * @param {{trigger: 'manual'|'auto', pre_tokens: number, post_tokens?: number}} metadata
 * @returns {import('@anthropic-ai/claude-agent-sdk').SDKCompactBoundaryMessage}
 */
export function compactBoundary(ctx, metadata) {
  return { type: 'system', subtype: 'compact_boundary', compact_metadata: metadata, ...ctx.envelope() };
}

/**
 * @param {TurnContext} ctx
 * @param {string} content
 * @returns {import('@anthropic-ai/claude-agent-sdk').SDKLocalCommandOutputMessage}
 */
export function localCommandOutput(ctx, content) {
  return { type: 'system', subtype: 'local_command_output', content, ...ctx.envelope() };
}

/**
 * @param {TurnContext} ctx
 * @returns {import('@anthropic-ai/claude-agent-sdk').SDKConversationResetMessage}
 */
export function conversationReset(ctx) {
  return {
    type: 'conversation_reset',
    new_conversation_id: randomUUID(),
    trigger: 'clear',
    user_message_uuid: ctx.userMessageUuid,
    timestamp: new Date(ctx.now()).toISOString(),
    ...ctx.envelope(),
  };
}

/**
 * @param {TurnContext} ctx
 * @param {string} key
 * @param {string} text
 * @param {'low'|'medium'|'high'} priority
 * @returns {import('@anthropic-ai/claude-agent-sdk').SDKNotificationMessage}
 */
export function notification(ctx, key, text, priority) {
  return { type: 'system', subtype: 'notification', key, text, priority, ...ctx.envelope() };
}

/**
 * @param {TurnContext} ctx
 * @param {string} content
 * @param {'info'|'notice'|'suggestion'|'warning'} level
 * @returns {import('@anthropic-ai/claude-agent-sdk').SDKInformationalMessage}
 */
export function informational(ctx, content, level) {
  return { type: 'system', subtype: 'informational', content, level, ...ctx.envelope() };
}

/**
 * @param {TurnContext} ctx
 * @param {{hookId: string, hookName: string, hookEvent: string}} hook
 * @returns {import('@anthropic-ai/claude-agent-sdk').SDKHookStartedMessage}
 */
export function hookStarted(ctx, { hookId, hookName, hookEvent }) {
  return {
    type: 'system', subtype: 'hook_started', hook_id: hookId, hook_name: hookName, hook_event: hookEvent,
    ...ctx.envelope(),
  };
}

/**
 * @param {TurnContext} ctx
 * @param {{hookId: string, hookName: string, hookEvent: string, stdout: string}} hook
 * @returns {import('@anthropic-ai/claude-agent-sdk').SDKHookProgressMessage}
 */
export function hookProgress(ctx, { hookId, hookName, hookEvent, stdout }) {
  return {
    type: 'system',
    subtype: 'hook_progress',
    hook_id: hookId,
    hook_name: hookName,
    hook_event: hookEvent,
    stdout,
    stderr: '',
    output: stdout,
    ...ctx.envelope(),
  };
}

/**
 * @param {TurnContext} ctx
 * @param {{hookId: string, hookName: string, hookEvent: string, stdout: string}} hook
 * @returns {import('@anthropic-ai/claude-agent-sdk').SDKHookResponseMessage}
 */
export function hookResponse(ctx, { hookId, hookName, hookEvent, stdout }) {
  return {
    type: 'system',
    subtype: 'hook_response',
    hook_id: hookId,
    hook_name: hookName,
    hook_event: hookEvent,
    stdout,
    stderr: '',
    output: stdout,
    exit_code: 0,
    outcome: 'success',
    ...ctx.envelope(),
  };
}

/**
 * @param {TurnContext} ctx
 * @param {{taskId: string, toolUseId: string, description: string, subagentType: string}} task
 * @returns {import('@anthropic-ai/claude-agent-sdk').SDKTaskStartedMessage}
 */
export function taskStarted(ctx, { taskId, toolUseId, description, subagentType }) {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: taskId,
    tool_use_id: toolUseId,
    description,
    subagent_type: subagentType,
    task_type: 'local_agent',
    is_backgrounded: false,
    spawn_depth: 1,
    ...ctx.envelope(),
  };
}

/**
 * @param {TurnContext} ctx
 * @param {{taskId: string, toolUseId: string, description: string, totalTokens: number, toolUses: number,
 *   durationMs: number, lastToolName: string, summary: string}} progress
 * @returns {import('@anthropic-ai/claude-agent-sdk').SDKTaskProgressMessage}
 */
export function taskProgress(ctx, progress) {
  return {
    type: 'system',
    subtype: 'task_progress',
    task_id: progress.taskId,
    tool_use_id: progress.toolUseId,
    description: progress.description,
    usage: { total_tokens: progress.totalTokens, tool_uses: progress.toolUses, duration_ms: progress.durationMs },
    last_tool_name: progress.lastToolName,
    summary: progress.summary,
    ...ctx.envelope(),
  };
}

/**
 * @param {SessionView} ctx
 * @param {{taskId: string, toolUseId: string, summary: string, totalTokens: number, toolUses: number,
 *   durationMs: number, status?: 'completed'|'stopped', outputFile?: string}} task
 * @returns {import('@anthropic-ai/claude-agent-sdk').SDKTaskNotificationMessage}
 */
export function taskNotification(ctx, task) {
  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: task.taskId,
    tool_use_id: task.toolUseId,
    status: task.status ?? 'completed',
    output_file: task.outputFile ?? '',
    summary: task.summary,
    usage: { total_tokens: task.totalTokens, tool_uses: task.toolUses, duration_ms: task.durationMs },
    ...ctx.envelope(),
  };
}

/** How long a foreground command waits to be moved to the background before it finishes on its own. */
export const BACKGROUND_WAIT_MS = 20000;
/** How long a backgrounded command runs in the mock before it reports its completion. */
export const BACKGROUND_RUN_MS = 1500;

/**
 * The file a backgrounded command writes its output to.
 * @param {string} taskId
 * @returns {string}
 */
export function outputFileOf(taskId) {
  return `/tmp/mock-tasks/${taskId}.output`;
}

/**
 * A foreground Bash command that was moved to the background: its task starts in the background.
 * @param {SessionView} ctx
 * @param {{taskId: string, toolUseId: string, description: string}} task
 * @returns {import('@anthropic-ai/claude-agent-sdk').SDKTaskStartedMessage}
 */
export function bashTaskStarted(ctx, { taskId, toolUseId, description }) {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: taskId,
    tool_use_id: toolUseId,
    description,
    task_type: 'local_bash',
    is_backgrounded: true,
    ...ctx.envelope(),
  };
}

/**
 * The full set of live background tasks after a change. Replace semantics: the set is the whole list.
 * @param {SessionView} ctx
 * @param {Array<{taskId: string, description: string}>} tasks
 * @returns {import('@anthropic-ai/claude-agent-sdk').SDKBackgroundTasksChangedMessage}
 */
export function backgroundTasksChanged(ctx, tasks) {
  return {
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: tasks.map((task) => ({ task_id: task.taskId, task_type: 'local_bash', description: task.description })),
    ...ctx.envelope(),
  };
}

/**
 * The refusal of the primary model when no fallback model is configured.
 * @param {TurnContext} ctx
 * @returns {import('@anthropic-ai/claude-agent-sdk').SDKModelRefusalNoFallbackMessage}
 */
export function modelRefusalNoFallback(ctx) {
  return {
    type: 'system',
    subtype: 'model_refusal_no_fallback',
    original_model: REFUSED_MODEL,
    request_id: null,
    refused_user_message_uuid: ctx.userMessageUuid,
    content: 'Claude Opus (mock) declined this request. No fallback model is configured.',
    ...ctx.envelope(),
  };
}

/** The model whose answers the mock's refusals decline. */
const REFUSED_MODEL = 'claude-opus-mock';
/** The fallback model a refused answer is retried on when the query names none. */
const DEFAULT_FALLBACK_MODEL = 'claude-sonnet-mock';
/** The names the notices give the mock's models. */
const MODEL_LABELS = {
  'claude-opus-mock': 'Claude Opus',
  'claude-sonnet-mock': 'Claude Sonnet',
  'claude-haiku-mock': 'Claude Haiku',
};

/**
 * @param {string} model
 * @returns {string} the name a notice gives the model
 */
function labelOf(model) {
  return MODEL_LABELS[model] ?? model;
}

/**
 * A refused response that was retried on the fallback model. The retracted messages leave the transcript.
 * @param {TurnContext} ctx
 * @param {{retracted: string[], originalModel: string, fallbackModel: string}} refusal
 * @returns {import('@anthropic-ai/claude-agent-sdk').SDKModelRefusalFallbackMessage}
 */
export function modelRefusalFallback(ctx, { retracted, originalModel, fallbackModel }) {
  const content = `${labelOf(originalModel)} (mock) declined this request, so it was retried with `
    + `${labelOf(fallbackModel)} (mock).`;
  return {
    type: 'system',
    subtype: 'model_refusal_fallback',
    trigger: 'refusal',
    direction: 'retry',
    scope: 'session',
    original_model: originalModel,
    fallback_model: fallbackModel,
    request_id: null,
    retracted_message_uuids: retracted,
    refused_user_message_uuid: ctx.userMessageUuid,
    content,
    ...ctx.envelope(),
  };
}

/**
 * One step of a headless plugin installation.
 * @param {SessionView} ctx
 * @param {{status: 'started'|'installed'|'completed', name?: string}} step
 * @returns {import('@anthropic-ai/claude-agent-sdk').SDKPluginInstallMessage}
 */
export function pluginInstall(ctx, { status, name }) {
  return {
    type: 'system',
    subtype: 'plugin_install',
    status,
    ...(name === undefined ? {} : { name }),
    ...ctx.envelope(),
  };
}

/**
 * @param {TurnContext} ctx
 * @param {SDKRateLimitInfo} info
 * @returns {import('@anthropic-ai/claude-agent-sdk').SDKRateLimitEvent}
 */
export function rateLimitEvent(ctx, info) {
  return { type: 'rate_limit_event', rate_limit_info: info, ...ctx.envelope() };
}

/**
 * A system notice that a failed model request is being retried.
 * @param {TurnContext} ctx
 * @param {{attempt: number, maxRetries: number, retryDelayMs: number, errorStatus: number|null,
 *   error: SDKAPIRetryMessage['error']}} retry
 * @returns {SDKAPIRetryMessage}
 */
function apiRetry(ctx, { attempt, maxRetries, retryDelayMs, errorStatus, error }) {
  return {
    type: 'system',
    subtype: 'api_retry',
    attempt,
    max_retries: maxRetries,
    retry_delay_ms: retryDelayMs,
    error_status: errorStatus,
    error,
    ...ctx.envelope(),
  };
}

/**
 * @param {TurnContext} ctx
 * @param {string} suggestion
 * @returns {import('@anthropic-ai/claude-agent-sdk').SDKPromptSuggestionMessage}
 */
export function promptSuggestion(ctx, suggestion) {
  return { type: 'prompt_suggestion', suggestion, ...ctx.envelope() };
}

/**
 * The Messages API envelope that every block of one response shares.
 * @param {SessionView} ctx
 * @param {string} id
 * @param {NonNullableUsage} usage
 * @param {BetaMessage['stop_reason']} [stopReason]
 * @returns {BetaMessage}
 */
function messageShell(ctx, id, usage, stopReason = null) {
  return {
    id,
    type: 'message',
    role: 'assistant',
    model: ctx.model,
    content: [],
    stop_reason: stopReason,
    stop_sequence: null,
    container: null,
    context_management: null,
    diagnostics: null,
    stop_details: null,
    usage,
  };
}

/**
 * @param {TurnContext} ctx
 * @param {BetaStreamEvent} event
 * @returns {SDKPartialAssistantMessage}
 */
function streamEvent(ctx, event) {
  return {
    type: 'stream_event',
    event,
    parent_tool_use_id: null,
    user_message_uuid: ctx.userMessageUuid,
    ...ctx.envelope(),
  };
}

/**
 * One completed content block group as an assistant message. Blocks of one response share the message id. The message
 * carries the uuid of the prompt its turn answers.
 * @param {TurnContext} ctx
 * @param {{id: string, content: BetaMessage['content'], usage: NonNullableUsage,
 *   stopReason?: BetaMessage['stop_reason'], parentToolUseId: string|null, agentId: string|null,
 *   aborted?: boolean}} args
 * @returns {SDKAssistantMessage}
 */
export function assistantMessage(ctx, {
  id, content, usage, stopReason = null, parentToolUseId, agentId, aborted = false,
}) {
  /** @type {SDKAssistantMessage} */
  const message = {
    type: 'assistant',
    message: { ...messageShell(ctx, id, usage, stopReason), content },
    parent_tool_use_id: parentToolUseId,
    ...(agentId ? { agent_id: agentId } : {}),
    user_message_uuid: ctx.userMessageUuid,
    ...ctx.envelope(),
  };
  if (aborted) message.aborted = true;
  return message;
}

/**
 * @param {NonNullableUsage} usage
 * @returns {Extract<BetaStreamEvent, {type: 'message_delta'}>['usage']}
 */
function deltaUsageOf(usage) {
  return {
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens,
    fallback_credit: null,
    input_tokens: usage.input_tokens,
    iterations: [],
    output_tokens: usage.output_tokens,
    output_tokens_details: usage.output_tokens_details,
    server_tool_use: usage.server_tool_use,
  };
}

/**
 * @param {TurnContext} ctx
 * @param {ResponseBlock} block
 * @returns {BetaMessage['content'][number]}
 */
function contentBlockOf(ctx, block) {
  if (block.type === 'text') return { type: 'text', text: block.text, citations: null };
  if (block.type === 'thinking') return { type: 'thinking', thinking: block.text, signature: block.signature };
  return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
}

/**
 * @param {TurnContext} ctx
 * @param {ResponseBlock[]} blocks
 * @returns {NonNullableUsage}
 */
function responseUsage(ctx, blocks) {
  const outputText = blocks
    .map((block) => (block.type === 'tool_use' ? JSON.stringify(block.input) : block.text))
    .join('');
  return usageOf({
    input: BASE_PROMPT_TOKENS + Math.ceil(ctx.userText.length / 4) + ctx.turnIndex * 350,
    output: Math.max(1, Math.ceil(outputText.length / 4)),
    cacheRead: CACHE_READ_TOKENS,
    webSearch: blocks.filter((block) => block.type === 'tool_use' && block.name === 'WebSearch').length,
    webFetch: blocks.filter((block) => block.type === 'tool_use' && block.name === 'WebFetch').length,
  });
}

/**
 * Streams one model response, then yields each completed block as an assistant message sharing the response id.
 * Text is streamed in chunks as stream_event messages when partial messages are enabled. Each chunk is paced with
 * `ctx.pause`, so an interrupt takes effect at the next chunk.
 * @param {TurnContext} ctx
 * @param {ResponseBlock[]} blocks
 * @param {{stopReason?: 'end_turn'|'tool_use'|'refusal', stream?: boolean, parentToolUseId?: string|null,
 *   agentId?: string|null, pacing?: number}} [options]
 * @returns {AsyncGenerator<SDKMessage, string, unknown>} the response message id
 */
export async function* modelResponse(ctx, blocks, options = {}) {
  const parentToolUseId = options.parentToolUseId ?? null;
  const agentId = options.agentId ?? null;
  const streamed = options.stream !== false && ctx.streamPartials && parentToolUseId === null;
  const stopReason = options.stopReason ?? 'end_turn';
  const pacing = options.pacing ?? ctx.delayMs;
  const id = ctx.nextId('message');
  const usage = responseUsage(ctx, blocks);
  if (streamed) {
    yield streamEvent(ctx, {
      type: 'message_start',
      message: { ...messageShell(ctx, id, { ...usage, output_tokens: 1 }) },
    });
    for (const [index, block] of blocks.entries()) {
      if (block.type === 'text') {
        yield streamEvent(ctx, {
          type: 'content_block_start',
          index,
          content_block: { type: 'text', text: '', citations: null },
        });
        for (const chunk of block.chunks ?? chunkText(block.text)) {
          yield* ctx.pause(pacing);
          yield streamEvent(ctx, { type: 'content_block_delta', index, delta: { type: 'text_delta', text: chunk } });
        }
      } else if (block.type === 'thinking') {
        yield streamEvent(ctx, {
          type: 'content_block_start',
          index,
          content_block: { type: 'thinking', thinking: '', signature: '' },
        });
        if (block.text !== '') {
          yield* ctx.pause(pacing);
          yield streamEvent(ctx, {
            type: 'content_block_delta',
            index,
            delta: { type: 'thinking_delta', thinking: block.text, estimated_tokens: null },
          });
        }
        yield streamEvent(ctx, {
          type: 'content_block_delta',
          index,
          delta: { type: 'signature_delta', signature: block.signature },
        });
      } else {
        yield streamEvent(ctx, {
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
        });
        yield* ctx.pause(pacing);
        yield streamEvent(ctx, {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
        });
      }
      yield streamEvent(ctx, { type: 'content_block_stop', index });
    }
    yield streamEvent(ctx, {
      type: 'message_delta',
      delta: { container: null, stop_details: null, stop_reason: stopReason, stop_sequence: null },
      usage: deltaUsageOf(usage),
      context_management: null,
    });
    yield streamEvent(ctx, { type: 'message_stop' });
  } else {
    yield* ctx.pause(pacing);
  }
  for (const [index, block] of blocks.entries()) {
    yield assistantMessage(ctx, {
      id,
      content: [contentBlockOf(ctx, block)],
      usage,
      stopReason: index === blocks.length - 1 ? stopReason : null,
      parentToolUseId,
      agentId,
    });
  }
  return id;
}

/**
 * The partial assistant message of a response that an interrupt cut short. It keeps the text streamed so far and
 * carries `aborted: true`, as the runtime does. It has no content when nothing was streamed yet.
 * @param {TurnContext} ctx
 * @param {{id: string, text: string, parentToolUseId: string|null, agentId: string|null}} partial
 * @returns {SDKAssistantMessage}
 */
export function interruptedMessage(ctx, { id, text, parentToolUseId, agentId }) {
  return assistantMessage(ctx, {
    id,
    content: text === '' ? [] : [{ type: 'text', text, citations: null }],
    usage: usageOf({ input: 0, output: 0 }),
    parentToolUseId,
    agentId,
    aborted: true,
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Fixed content
// ---------------------------------------------------------------------------------------------------------------------

const APP_LINES = [
  "import express from 'express';",
  '',
  'const app = express();',
  'const port = 3000;',
  '',
  "app.get('/', (req, res) => {",
  "  res.send('Hello from the demo app');",
  '});',
  '',
  "app.get('/health', (req, res) => {",
  '  res.json({ ok: true });',
  '});',
  '',
  'app.listen(port, () => {',
  '  process.stdout.write(`Listening on ${port}\\n`);',
  '});',
];
const APP_JS = `${APP_LINES.join('\n')}\n`;

const LS_OUTPUT = [
  'total 48',
  'drwxr-xr-x  6 demo demo 4096 Oct  9 10:00 .',
  'drwxr-xr-x  3 demo demo 4096 Oct  9 09:55 ..',
  '-rw-r--r--  1 demo demo  220 Oct  9 10:00 .gitignore',
  '-rw-r--r--  1 demo demo  612 Oct  9 10:00 README.md',
  '-rw-r--r--  1 demo demo  384 Oct  9 10:00 package.json',
  'drwxr-xr-x  2 demo demo 4096 Oct  9 10:00 src',
  'drwxr-xr-x  2 demo demo 4096 Oct  9 10:00 test',
].join('\n');

const SEARCH_TEXT = [
  'Web search results for query: "claude agent sdk session files"',
  '',
  '- [Session storage](https://example.com/docs): sessions are stored as JSON transcripts, one file per session.',
  '- [Managing sessions](https://example.com/blog/sessions): resume, fork, rename and tag sessions from the SDK.',
].join('\n');

const FETCH_TEXT = 'Sessions are persisted as transcripts per project directory. Resume one with the resume option, '
  + 'and fork it at any message with upToMessageId.';

/**
 * Shows a text with its line numbers, the way the Read tool does.
 * @param {string[]} lines
 * @returns {string}
 */
function numberLines(lines) {
  return lines.map((line, index) => `${String(index + 1).padStart(6)}\t${line}`).join('\n');
}

/**
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function excerptOf(text, max) {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') return '(empty message)';
  const points = Array.from(flat);
  return points.length > max ? `${points.slice(0, max).join('')}...` : flat;
}

/**
 * @param {string} userText
 * @returns {string}
 */
function markdownAnswer(userText) {
  return [
    '## Mock answer',
    '',
    `> ${excerptOf(userText, 80)}`,
    '',
    'This reply comes from the deterministic mock engine. It streams text in small chunks, persists the transcript and',
    'can exercise every card type. Try `tool`, `edit`, `question`, `plan`, `todo`, `agent`, `web`, `mcp` or `elicit`.',
    '',
    '- Approvals appear as request cards that you can allow or deny.',
    '- Transcripts are stored as JSON files in the state directory.',
    '- Slash commands `/compact`, `/context`, `/usage` and `/clear` have their own results.',
    '',
    '```js',
    'function greet(name) {',
    '  return `Hello, ${name}!`;',
    '}',
    '```',
    '',
    'Set `CAW_ENGINE=sdk` to answer with the real Claude Code runtime.',
  ].join('\n');
}

/**
 * @param {ElicitationResult|null} result
 * @returns {string}
 */
function describeElicitation(result) {
  if (result?.action === 'accept') {
    const content = result.content ?? {};
    const username = typeof content.username === 'string' ? content.username.slice(0, 64) : 'unknown user';
    const remember = content.remember === true ? ' (remembered)' : '';
    return `Signed in as ${username}${remember}. I will continue with GitHub access.`;
  }
  if (result?.action === 'decline') return 'You declined to sign in, so I will continue without GitHub access.';
  return 'The sign-in was cancelled, so I will continue without GitHub access.';
}

// ---------------------------------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------------------------------

/** Default answer: a Markdown reply that quotes the user's text. */
async function* answerScenario(ctx) {
  yield* modelResponse(ctx, [{ type: 'text', text: markdownAnswer(ctx.userText) }]);
}

/** @type {Scenario['run']} */
async function* compactScenario(ctx) {
  yield statusMessage(ctx, 'compacting');
  yield* ctx.pause(ctx.delayMs * 2);
  yield compactBoundary(ctx, { trigger: 'manual', pre_tokens: 12000, post_tokens: 3400 });
  yield statusMessage(ctx, null, { compact_result: 'success' });
}

/** @type {Scenario['run']} */
async function* contextScenario(ctx) {
  yield localCommandOutput(ctx, formatContext(ctx.describeSession()));
}

/** @type {Scenario['run']} */
async function* usageScenario(ctx) {
  yield localCommandOutput(ctx, formatUsage(ctx.describeSession()));
}

/** @type {Scenario['run']} */
async function* clearScenario(ctx) {
  yield conversationReset(ctx);
}

/** @type {Scenario['run']} */
async function* bashScenario(ctx) {
  const toolUseId = ctx.nextId('tool');
  const input = { command: 'ls -la', description: 'List project files' };
  yield* modelResponse(ctx, [
    { type: 'text', text: 'Let me look at the project.' },
    { type: 'tool_use', id: toolUseId, name: 'Bash', input },
  ], { stopReason: 'tool_use' });
  /** @type {PermissionUpdate[]} */
  const suggestions = [
    {
      type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }], behavior: 'allow',
      destination: 'localSettings',
    },
    { type: 'addDirectories', directories: [join(ctx.cwd, '..')], destination: 'session' },
  ];
  // The summary comes before the ask, so it names the step the permission request is about.
  yield taskSummary(ctx, `Running ${input.command}`);
  const decision = yield* ctx.askPermission('Bash', input, {
    toolUseId,
    title: 'Claude wants to run ls -la',
    displayName: 'Run command',
    description: 'Lists the files in the project directory',
    suggestions,
  });
  if (decision.allowed === false) {
    yield toolResult(ctx, { toolUseId, content: decision.message, isError: true });
    // Nothing runs after a denial: an empty summary clears the line that named the command.
    yield taskSummary(ctx, '');
    yield* modelResponse(ctx, [{ type: 'text', text: "Understood, I won't run that command." }]);
    return;
  }
  yield toolProgress(ctx, toolUseId, 'Bash', 1);
  yield* ctx.pause(ctx.delayMs);
  yield toolResult(ctx, {
    toolUseId,
    content: LS_OUTPUT,
    toolUseResult: {
      stdout: LS_OUTPUT,
      stderr: '',
      interrupted: false,
      updatedPermissions: decision.updatedPermissions,
    },
  });
  yield toolUseSummary(ctx, 'Listed project files', [toolUseId]);
  yield* modelResponse(ctx, [{
    type: 'text',
    text: 'The project has a `src` folder, a `test` folder, a README and a `package.json`.',
  }]);
}

/** @type {Scenario['run']} */
async function* editScenario(ctx) {
  const readId = ctx.nextId('tool');
  const filePath = join(ctx.cwd, 'src', 'app.js');
  yield* modelResponse(ctx, [
    { type: 'text', text: 'I will read the server entry point first.' },
    { type: 'tool_use', id: readId, name: 'Read', input: { file_path: filePath } },
  ], { stopReason: 'tool_use' });
  yield taskSummary(ctx, 'Reading src/app.js');
  yield toolResult(ctx, {
    toolUseId: readId,
    content: numberLines(APP_LINES),
    toolUseResult: {
      type: 'text',
      file: { filePath, content: APP_JS, numLines: APP_LINES.length, startLine: 1, totalLines: APP_LINES.length },
    },
  });
  const editId = ctx.nextId('tool');
  const edit = {
    file_path: filePath,
    old_string: 'const port = 3000;',
    new_string: 'const port = Number(process.env.PORT) || 3000;',
    replace_all: false,
  };
  yield* modelResponse(ctx, [
    { type: 'text', text: 'The port is hard-coded. I will read it from the environment.' },
    { type: 'tool_use', id: editId, name: 'Edit', input: edit },
  ], { stopReason: 'tool_use' });
  // The summary comes before the ask, so it names the step the permission request is about.
  yield taskSummary(ctx, 'Editing src/app.js');
  const decision = yield* ctx.askPermission('Edit', edit, {
    toolUseId: editId,
    title: 'Claude wants to edit src/app.js',
    displayName: 'Edit file',
    description: 'Replaces one line in the server entry point',
    blockedPath: filePath,
  });
  if (decision.allowed === false) {
    yield toolResult(ctx, { toolUseId: editId, content: decision.message, isError: true });
    // Nothing runs after a denial: an empty summary clears the line that named the edit.
    yield taskSummary(ctx, '');
    yield* modelResponse(ctx, [{ type: 'text', text: "I'll leave the file unchanged." }]);
    return;
  }
  yield toolResult(ctx, {
    toolUseId: editId,
    content: `The file ${filePath} has been updated successfully.`,
    toolUseResult: {
      filePath,
      oldString: edit.old_string,
      newString: edit.new_string,
      originalFile: APP_JS,
      structuredPatch: [{
        oldStart: 3,
        oldLines: 3,
        newStart: 3,
        newLines: 3,
        lines: [' const app = express();', `-${edit.old_string}`, `+${edit.new_string}`, ' '],
      }],
      userModified: false,
      replaceAll: false,
    },
  });
  yield* modelResponse(ctx, [{
    type: 'text',
    text: 'Done. The port now reads from `PORT` and falls back to 3000.',
  }]);
}

/** @type {Scenario['run']} */
async function* questionScenario(ctx) {
  const toolUseId = ctx.nextId('tool');
  const questions = [
    {
      question: 'Which authentication method should the demo use?',
      header: 'Auth method',
      multiSelect: false,
      options: [
        {
          label: 'Magic link', description: 'Passwordless sign-in by email',
          preview: '```text\nemail -> link -> session\n```',
        },
        {
          label: 'Password', description: 'Classic email and password',
          preview: '```text\nemail + password -> session\n```',
        },
      ],
    },
    {
      question: 'Which features should be enabled?',
      header: 'Features',
      multiSelect: true,
      options: [
        { label: 'Dark mode', description: 'Follow the system theme', preview: '**Dark mode** uses the dark palette.' },
        { label: 'Audit log', description: 'Record administrator actions', preview: '- who\n- what\n- when' },
        { label: 'Exports', description: 'Download data as CSV' },
      ],
    },
  ];
  const input = { questions };
  yield* modelResponse(ctx, [
    { type: 'text', text: 'I need two decisions before I continue.' },
    { type: 'tool_use', id: toolUseId, name: 'AskUserQuestion', input },
  ], { stopReason: 'tool_use' });
  // The summary comes before the ask, so it names the step the question belongs to.
  yield taskSummary(ctx, `Asking ${questions.length} questions`);
  const decision = yield* ctx.askPermission('AskUserQuestion', input, {
    toolUseId,
    title: 'Claude has questions for you',
    displayName: 'Ask user',
    description: 'Answer the questions to continue',
  });
  if (decision.allowed === false) {
    yield toolResult(ctx, { toolUseId, content: decision.message, isError: true });
    // Nothing runs after a refusal: an empty summary clears the line that named the questions.
    yield taskSummary(ctx, '');
    yield* modelResponse(ctx, [{ type: 'text', text: 'No problem, I will continue with sensible defaults.' }]);
    return;
  }
  const given = decision.input.answers && typeof decision.input.answers === 'object' ? decision.input.answers : {};
  /** @type {Record<string, string>} */
  const answers = {};
  for (const item of questions) {
    const value = given[item.question];
    const text = Array.isArray(value) ? value.join(', ') : typeof value === 'string' ? value : '';
    answers[item.question] = text === '' ? '(no answer)' : text;
  }
  const pairs = questions.map((item) => `"${item.question}"="${answers[item.question]}"`).join(', ');
  yield toolResult(ctx, {
    toolUseId,
    content: `User has answered your questions: ${pairs}. You can now continue with the user's answers in mind.`,
    toolUseResult: { questions, answers },
  });
  const [auth, features] = questions.map((item) => answers[item.question]);
  yield* modelResponse(ctx, [{
    type: 'text',
    text: `Thanks. I will use ${auth} for sign-in and enable ${features}.`,
  }]);
}

/** @type {Scenario['run']} */
async function* planScenario(ctx) {
  yield statusMessage(ctx, null, { permissionMode: 'plan' });
  const toolUseId = ctx.nextId('tool');
  const plan = [
    '# Plan',
    '',
    '1. Read the existing routes and tests.',
    '2. Add the missing handler with input validation.',
    '3. Run the test suite and update the docs.',
  ].join('\n');
  yield* modelResponse(ctx, [
    { type: 'text', text: 'I will explore the codebase before proposing a plan. The routes and tests come first.' },
    { type: 'tool_use', id: toolUseId, name: 'ExitPlanMode', input: { plan } },
  ], { stopReason: 'tool_use' });
  // The summary comes before the ask, so it names the step the approval belongs to.
  yield taskSummary(ctx, 'Presenting the plan for approval');
  const decision = yield* ctx.askPermission('ExitPlanMode', { plan }, {
    toolUseId,
    title: 'Claude has a plan ready',
    displayName: 'Review plan',
    description: 'Approve the plan to start implementing it',
  });
  if (decision.allowed === false) {
    yield toolResult(ctx, { toolUseId, content: decision.message, isError: true });
    // Nothing runs after a rejection: an empty summary clears the line that named the plan.
    yield taskSummary(ctx, '');
    yield* modelResponse(ctx, [{ type: 'text', text: "Understood — I'll revise the plan." }]);
    return;
  }
  yield toolResult(ctx, {
    toolUseId,
    content: 'User has approved your plan. You can now start coding.',
    toolUseResult: { plan, isAgent: false },
  });
  yield* modelResponse(ctx, [{ type: 'text', text: 'Plan approved — implementing.' }]);
}

/** @type {Scenario['run']} */
async function* todoScenario(ctx) {
  const toolUseId = ctx.nextId('tool');
  const todos = [
    { content: 'Read the existing routes', status: 'completed', activeForm: 'Reading the existing routes' },
    {
      content: 'Add validation to the create handler', status: 'in_progress',
      activeForm: 'Adding validation to the create handler',
    },
    { content: 'Write unit tests', status: 'pending', activeForm: 'Writing unit tests' },
    { content: 'Update the changelog', status: 'pending', activeForm: 'Updating the changelog' },
  ];
  yield* modelResponse(ctx, [
    { type: 'text', text: 'I will track the work in a checklist.' },
    { type: 'tool_use', id: toolUseId, name: 'TodoWrite', input: { todos } },
  ], { stopReason: 'tool_use' });
  yield taskSummary(ctx, 'Updating the todo list');
  yield toolResult(ctx, {
    toolUseId,
    content: 'Todos have been modified successfully. Ensure that you continue to use the todo list to track '
      + 'your progress. Please proceed with the current tasks if applicable',
    toolUseResult: { oldTodos: [], newTodos: todos },
  });
  yield* modelResponse(ctx, [{
    type: 'text',
    text: 'The checklist is up to date: one item is done and one is in progress.',
  }]);
}

/** @type {Scenario['run']} */
async function* agentScenario(ctx) {
  const toolUseId = ctx.nextId('tool');
  const agentId = ctx.nextId('agent');
  const description = 'Explore the codebase';
  const prompt = 'Find where routes are defined';
  yield* modelResponse(ctx, [
    { type: 'text', text: 'I will ask an Explore agent to find the routes.' },
    { type: 'tool_use', id: toolUseId, name: 'Agent', input: { description, prompt, subagent_type: 'Explore' } },
  ], { stopReason: 'tool_use' });
  yield taskSummary(ctx, 'Running the Explore agent');
  yield taskStarted(ctx, { taskId: agentId, toolUseId, description, subagentType: 'Explore' });

  const nested = { parentToolUseId: toolUseId, agentId };
  yield* modelResponse(ctx, [{ type: 'text', text: 'Searching the source tree for route definitions.' }], {
    ...nested,
    stream: false,
  });
  const grepId = ctx.nextId('tool');
  const grepInput = { pattern: 'app\\.(get|post|use)\\(', path: 'src', output_mode: 'files_with_matches' };
  yield* modelResponse(ctx, [{ type: 'tool_use', id: grepId, name: 'Grep', input: grepInput }], {
    ...nested,
    stream: false,
    stopReason: 'tool_use',
  });
  yield toolResult(ctx, {
    toolUseId: grepId,
    content: 'src/routes/index.js\nsrc/routes/api.js',
    toolUseResult: { mode: 'files_with_matches', numFiles: 2, filenames: ['src/routes/index.js', 'src/routes/api.js'] },
    parentToolUseId: toolUseId,
    agentId,
  });
  const found = 'Found route definitions in src/routes/index.js and src/routes/api.js.';
  yield* modelResponse(ctx, [{ type: 'text', text: found }], { ...nested, stream: false });
  yield taskProgress(ctx, {
    taskId: agentId,
    toolUseId,
    description,
    totalTokens: 1820,
    toolUses: 1,
    durationMs: 900,
    lastToolName: 'Grep',
    summary: 'Searching src for route definitions',
  });
  yield taskNotification(ctx, {
    taskId: agentId,
    toolUseId,
    summary: 'Found route definitions in 2 files',
    totalTokens: 1820,
    toolUses: 1,
    durationMs: 900,
  });
  yield toolResult(ctx, {
    toolUseId,
    content: found,
    toolUseResult: {
      agentId,
      agentType: 'Explore',
      content: [{ type: 'text', text: found }],
      totalToolUseCount: 1,
      totalDurationMs: 900,
      totalTokens: 1820,
      usage: {
        input_tokens: 1400,
        output_tokens: 420,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        server_tool_use: null,
        service_tier: 'standard',
        cache_creation: null,
      },
    },
  });
  yield* modelResponse(ctx, [{
    type: 'text',
    text: 'The routes are defined in `src/routes/index.js` and `src/routes/api.js`.',
  }]);
}

/** @type {Scenario['run']} */
async function* webScenario(ctx) {
  const searchId = ctx.nextId('tool');
  const query = 'claude agent sdk session files';
  yield* modelResponse(ctx, [
    { type: 'text', text: 'I will search for the current documentation first.' },
    { type: 'tool_use', id: searchId, name: 'WebSearch', input: { query } },
  ], { stopReason: 'tool_use' });
  yield taskSummary(ctx, `Searching the web for "${query}"`);
  yield toolProgress(ctx, searchId, 'WebSearch', 1);
  yield* ctx.pause(ctx.delayMs);
  yield toolResult(ctx, {
    toolUseId: searchId,
    content: SEARCH_TEXT,
    toolUseResult: {
      query,
      results: [{
        tool_use_id: searchId,
        content: [
          {
            title: 'Session storage', url: 'https://example.com/docs',
            snippet: 'Sessions are stored as JSON transcripts.',
          },
          {
            title: 'Managing sessions', url: 'https://example.com/blog/sessions',
            snippet: 'Resume, fork and rename sessions.',
          },
        ],
      }],
      durationSeconds: 1.2,
    },
  });

  const fetchId = ctx.nextId('tool');
  const url = 'https://example.com/docs';
  const prompt = 'Summarize how sessions are stored';
  yield* modelResponse(ctx, [
    { type: 'text', text: 'Let me read the documentation page.' },
    { type: 'tool_use', id: fetchId, name: 'WebFetch', input: { url, prompt } },
  ], { stopReason: 'tool_use' });
  yield taskSummary(ctx, `Fetching ${url}`);
  yield toolProgress(ctx, fetchId, 'WebFetch', 1);
  yield* ctx.pause(ctx.delayMs);
  yield toolResult(ctx, {
    toolUseId: fetchId,
    content: FETCH_TEXT,
    toolUseResult: { bytes: FETCH_TEXT.length, code: 200, codeText: 'OK', result: FETCH_TEXT, durationMs: 800, url },
  });
  yield* modelResponse(ctx, [{
    type: 'text',
    text: 'Sessions are stored as one transcript file each. '
      + 'See the [session storage guide](https://example.com/docs) for details.',
  }]);
}

/** @type {Scenario['run']} */
async function* mcpScenario(ctx) {
  const toolUseId = ctx.nextId('tool');
  const name = 'mcp__github__search_issues';
  const input = { query: 'is:open label:bug' };
  if (!ctx.mcpConnected('github')) {
    yield* modelResponse(ctx, [{
      type: 'text',
      text: 'The GitHub server is disabled, so I cannot search issues right now.',
    }]);
    return;
  }
  yield* modelResponse(ctx, [
    { type: 'text', text: 'I will check the open bug reports on GitHub.' },
    { type: 'tool_use', id: toolUseId, name, input },
  ], { stopReason: 'tool_use' });
  // The summary comes before the ask, so it names the step the permission request is about.
  yield taskSummary(ctx, 'Searching GitHub issues');
  const decision = yield* ctx.askPermission(name, input, {
    toolUseId,
    mcpServer: { name: 'github', source: 'user' },
    title: 'Claude wants to search GitHub issues',
    displayName: 'github: search_issues',
    description: 'Read-only search in the connected repository',
  });
  if (decision.allowed === false) {
    yield toolResult(ctx, { toolUseId, content: decision.message, isError: true });
    // Nothing runs after a denial: an empty summary clears the line that named the search.
    yield taskSummary(ctx, '');
    yield* modelResponse(ctx, [{ type: 'text', text: 'Okay, I will not query GitHub.' }]);
    return;
  }
  yield toolProgress(ctx, toolUseId, name, 1);
  yield* ctx.pause(ctx.delayMs);
  yield toolResult(ctx, {
    toolUseId,
    content: JSON.stringify({
      total_count: 2,
      items: [
        { number: 41, title: 'Crash on empty input', state: 'open' },
        { number: 37, title: 'Typo in the README', state: 'open' },
      ],
    }),
  });
  yield* modelResponse(ctx, [{
    type: 'text',
    text: 'I found 2 open bug reports: #41 "Crash on empty input" and #37 "Typo in the README".',
  }]);
}

/** @type {Scenario['run']} */
async function* elicitScenario(ctx) {
  yield* modelResponse(ctx, [{ type: 'text', text: 'I need you to sign in to GitHub before I can continue.' }]);
  const result = yield* ctx.elicitation({
    serverName: 'github',
    message: 'Sign in to GitHub to continue',
    mode: 'form',
    requestedSchema: {
      type: 'object',
      properties: {
        username: { type: 'string', title: 'Username' },
        remember: { type: 'boolean', title: 'Remember me', default: true },
      },
      required: ['username'],
    },
  });
  yield* modelResponse(ctx, [{ type: 'text', text: describeElicitation(result) }]);
}

/** @type {Scenario['run']} */
async function* notifyScenario(ctx) {
  yield notification(ctx, 'mock', 'Background build finished', 'medium');
  yield informational(ctx, 'Mock informational notice', 'notice');
  yield* modelResponse(ctx, [{ type: 'text', text: 'The background build finished. Nothing else is pending.' }]);
}

/** @type {Scenario['run']} */
async function* rateScenario(ctx) {
  yield rateLimitEvent(ctx, {
    status: 'allowed_warning',
    rateLimitType: 'five_hour',
    utilization: 0.85,
    resetsAt: Math.floor(ctx.now() / 1000) + 3600,
  });
  yield* modelResponse(ctx, [{
    type: 'text',
    text: 'You have used 85% of your five-hour usage window. Responses may slow down if you keep going.',
  }]);
}

/** @type {Scenario['run']} */
async function* hookScenario(ctx) {
  const toolUseId = ctx.nextId('tool');
  const hookId = ctx.nextId('hook');
  const input = { command: 'git status --short', description: 'Show changed files' };
  const hook = { hookId, hookName: 'PreToolUse:Bash', hookEvent: 'PreToolUse' };
  yield* modelResponse(ctx, [
    { type: 'text', text: 'I will check the working tree. A pre-tool hook runs first.' },
    { type: 'tool_use', id: toolUseId, name: 'Bash', input },
  ], { stopReason: 'tool_use' });
  yield hookStarted(ctx, hook);
  yield hookProgress(ctx, { ...hook, stdout: 'Checking the command against the policy...\n' });
  yield hookResponse(ctx, { ...hook, stdout: 'Policy check passed.\n' });
  yield taskSummary(ctx, `Running ${input.command}`);
  yield toolProgress(ctx, toolUseId, 'Bash', 1);
  yield* ctx.pause(ctx.delayMs);
  yield toolResult(ctx, {
    toolUseId,
    content: ' M src/app.js',
    toolUseResult: { stdout: ' M src/app.js', stderr: '', interrupted: false },
  });
  yield* modelResponse(ctx, [{ type: 'text', text: 'One file has uncommitted changes: `src/app.js`.' }]);
}

/** @type {Scenario['run']} */
async function* errorScenario() {
  throw new ScenarioFailure('Mock failure requested');
}

/**
 * A rejected API key: the request is retried twice with a 401, then the turn fails with the sign-in hint.
 * @type {Scenario['run']}
 */
async function* authScenario(ctx) {
  const error = 'authentication_failed';
  yield apiRetry(ctx, { attempt: 1, maxRetries: 2, retryDelayMs: 500, errorStatus: 401, error });
  yield* ctx.pause(ctx.delayMs);
  yield apiRetry(ctx, { attempt: 2, maxRetries: 2, retryDelayMs: 1000, errorStatus: 401, error });
  yield* ctx.pause(ctx.delayMs);
  throw new ScenarioFailure('Invalid API key · Please run /login');
}

/** @type {Scenario['run']} */
async function* slowScenario(ctx) {
  const chunks = Array.from({ length: 60 }, (_, index) => `Part ${index + 1} of 60. `);
  yield* modelResponse(ctx, [{ type: 'text', text: chunks.join(''), chunks }], {
    pacing: Math.max(ctx.delayMs * 4, 50),
  });
}

/**
 * Extended thinking: a thinking block, then the answer. The thinking text is kept only when summaries are requested.
 */
/** @type {Scenario['run']} */
async function* thinkScenario(ctx) {
  const reasoning = ctx.thinkingSummaries ? 'The request is simple, so I will answer it directly.' : '';
  yield* modelResponse(ctx, [
    { type: 'thinking', text: reasoning, signature: 'mock-thinking-signature' },
    { type: 'text', text: 'Here is the answer, reached after thinking it through.' },
  ]);
}

/** A build that can be moved to the background (Ctrl+B) while the turn goes on. */
/** @type {Scenario['run']} */
async function* backgroundScenario(ctx) {
  const toolUseId = ctx.nextId('tool');
  const description = 'Build the project';
  const input = { command: 'npm run build', description };
  const foreground = ctx.foregroundTask(toolUseId, description, 'Build succeeded\n');
  yield* modelResponse(ctx, [
    { type: 'text', text: 'Starting the build.' },
    { type: 'tool_use', id: toolUseId, name: 'Bash', input },
  ], { stopReason: 'tool_use' });
  yield taskSummary(ctx, `Running ${input.command}`);
  yield toolProgress(ctx, toolUseId, 'Bash', 1);
  const moved = yield* ctx.awaitBackground(foreground);
  if (moved === null) {
    yield toolResult(ctx, {
      toolUseId,
      content: 'Build succeeded',
      toolUseResult: { stdout: 'Build succeeded', stderr: '', interrupted: false },
    });
    yield* modelResponse(ctx, [{ type: 'text', text: 'The build finished and succeeded.' }]);
    return;
  }
  yield toolResult(ctx, {
    toolUseId,
    content: `Command running in background with ID: ${moved.taskId}. `
      + `Output is being written to: ${outputFileOf(moved.taskId)}`,
  });
  yield bashTaskStarted(ctx, { taskId: moved.taskId, toolUseId, description });
  yield* modelResponse(ctx, [{
    type: 'text',
    text: 'The build is running in the background. I will report when it finishes.',
  }]);
}

/**
 * The primary model refuses and no fallback model is configured: the refused answer stays, with the notice after it.
 */
/** @type {Scenario['run']} */
async function* refusalNoFallbackScenario(ctx) {
  yield* modelResponse(ctx, [{ type: 'text', text: "I can't help with that request." }], { stopReason: 'refusal' });
  yield modelRefusalNoFallback(ctx);
}

/** What the primary model answers when it refuses, and what the fallback model answers instead. */
const REFUSED_ANSWER = "I can't help with that request.";
const FALLBACK_ANSWER = 'Here is the answer from the fallback model.';
/** The dialog kind the runtime asks the host with before it retries a refused answer. */
const REFUSAL_DIALOG = 'refusal_fallback_prompt';

/**
 * The primary model's refused answer, streamed through the turn.
 * @param {TurnContext} ctx
 * @returns {AsyncGenerator<SDKMessage, string, unknown>} the uuid of the refused message
 */
async function* refusedAnswer(ctx) {
  let refusedUuid = '';
  for await (const message of modelResponse(ctx, [{ type: 'text', text: REFUSED_ANSWER }], { stopReason: 'refusal' })) {
    if (message.type === 'assistant') refusedUuid = message.uuid;
    yield message;
  }
  return refusedUuid;
}

/**
 * The retry on the fallback model, in the runtime's order: the fallback's answer names the refused one in `supersedes`
 * (a host evicts it on arrival), and the end-of-turn notice lists it again in `retracted_message_uuids`.
 * @param {TurnContext} ctx
 * @param {string} refusedUuid
 * @param {string} fallbackModel
 * @returns {AsyncGenerator<SDKMessage, void, unknown>}
 */
async function* answerOnFallback(ctx, refusedUuid, fallbackModel) {
  for await (const message of modelResponse(ctx, [{ type: 'text', text: FALLBACK_ANSWER }])) {
    yield message.type === 'assistant'
      ? { ...message, supersedes: [/** @type {import('node:crypto').UUID} */ (refusedUuid)] }
      : message;
  }
  yield modelRefusalFallback(ctx, { retracted: [refusedUuid], originalModel: REFUSED_MODEL, fallbackModel });
}

/**
 * The primary model refuses and the turn is retried on the fallback model without asking. The fallback is the model
 * the query names, or the default one.
 * @type {Scenario['run']}
 */
async function* refusalScenario(ctx) {
  const refusedUuid = yield* refusedAnswer(ctx);
  yield* answerOnFallback(ctx, refusedUuid, ctx.fallbackModel ?? DEFAULT_FALLBACK_MODEL);
}

/**
 * The primary model refuses and the runtime asks the host before it retries (a refusal_fallback_prompt dialog). The
 * answer decides: retry_fallback retries on the fallback model; edit_prompt retracts the refused answer and ends the
 * turn, so the prompt can be edited and sent again; cancelled keeps the refusal with the notice that no fallback ran.
 * A host that does not render the dialog gets that same notice.
 * @type {Scenario['run']}
 */
async function* refusalPromptScenario(ctx) {
  const refusedUuid = yield* refusedAnswer(ctx);
  if (!ctx.dialogKinds.includes(REFUSAL_DIALOG)) {
    yield modelRefusalNoFallback(ctx);
    return;
  }
  const fallbackModel = ctx.fallbackModel ?? DEFAULT_FALLBACK_MODEL;
  const answer = yield* ctx.userDialog({
    kind: REFUSAL_DIALOG,
    payload: {
      originalModel: REFUSED_MODEL,
      fallbackModel,
      guidanceText: 'The primary model declined this request. Retry it on the fallback model or edit the prompt.',
      retractedMessageUuids: [refusedUuid],
    },
  });
  if (answer === 'retry_fallback') {
    yield* answerOnFallback(ctx, refusedUuid, fallbackModel);
    return;
  }
  if (answer === 'edit_prompt') {
    ctx.retract([refusedUuid]);
    return;
  }
  yield modelRefusalNoFallback(ctx);
}

/** A 16 by 16 pixel PNG: the screenshot the browser server returns in the mock. */
const SCREENSHOT_PNG = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAH0lEQVR4nGOQ9/cjCTHI+/tpV1UQiUY1jGoYaA0kIQ'
  + 'BstwZU6KpsRgAAAABJRU5ErkJggg==';

/**
 * A screenshot taken through the browser MCP server, which a session attaches as `browser`. The tool result carries the
 * screenshot as an image block. Without that server the answer says so, and no tool runs.
 * @type {Scenario['run']}
 */
async function* browseScenario(ctx) {
  if (!ctx.mcpConnected(BROWSER_MCP_SERVER)) {
    yield* modelResponse(ctx, [
      { type: 'text', text: 'The browser server is not connected, so there is no screenshot.' },
    ]);
    return;
  }
  const toolUseId = ctx.nextId('tool');
  yield* modelResponse(ctx, [
    { type: 'text', text: 'Taking a screenshot of the page.' },
    { type: 'tool_use', id: toolUseId, name: 'mcp__browser__browser_take_screenshot', input: { type: 'png' } },
  ], { stopReason: 'tool_use' });
  yield toolResult(ctx, {
    toolUseId,
    content: [
      { type: 'text', text: 'Screenshot of the page.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: SCREENSHOT_PNG } },
    ],
  });
  yield* modelResponse(ctx, [{ type: 'text', text: 'The screenshot is above.' }]);
}

/** A headless plugin installation that finishes before the answer. */
/** @type {Scenario['run']} */
async function* pluginScenario(ctx) {
  yield pluginInstall(ctx, { status: 'started' });
  yield pluginInstall(ctx, { status: 'installed', name: 'demo-plugin' });
  yield pluginInstall(ctx, { status: 'completed' });
  yield* modelResponse(ctx, [{ type: 'text', text: 'Plugins are ready.' }]);
}

/**
 * Keyword match on word starts, so that "generate" does not select the rate scenario.
 * @param {string} word
 * @returns {(text: string) => boolean}
 */
function keyword(word) {
  const pattern = new RegExp(`\\b${word}`, 'i');
  return (text) => pattern.test(text);
}

/**
 * Ordered table: the first match wins. Slash commands match by prefix, keywords by word start.
 * @type {Scenario[]}
 */
const SCENARIOS = [
  { name: 'compact', matches: (text) => /^\/compact(\s|$)/i.test(text), run: compactScenario },
  { name: 'context', matches: (text) => /^\/context(\s|$)/i.test(text), run: contextScenario },
  { name: 'usage', matches: (text) => /^\/usage(\s|$)/i.test(text), run: usageScenario },
  { name: 'clear', matches: (text) => /^\/clear(\s|$)/i.test(text), run: clearScenario },
  { name: 'browse', matches: keyword('browse'), run: browseScenario },
  { name: 'tool', matches: keyword('tool'), run: bashScenario },
  { name: 'edit', matches: keyword('edit'), run: editScenario },
  { name: 'question', matches: keyword('question'), run: questionScenario },
  { name: 'plan', matches: keyword('plan'), run: planScenario },
  { name: 'todo', matches: keyword('todo'), run: todoScenario },
  { name: 'agent', matches: keyword('agent'), run: agentScenario },
  { name: 'web', matches: keyword('web'), run: webScenario },
  { name: 'mcp', matches: keyword('mcp'), run: mcpScenario },
  { name: 'elicit', matches: keyword('elicit'), run: elicitScenario },
  { name: 'notify', matches: keyword('notif'), run: notifyScenario },
  { name: 'rate', matches: keyword('rate'), run: rateScenario },
  { name: 'hook', matches: keyword('hook'), run: hookScenario },
  { name: 'auth', matches: keyword('auth'), run: authScenario },
  { name: 'error', matches: keyword('error'), run: errorScenario },
  { name: 'slow', matches: keyword('slow'), run: slowScenario },
  { name: 'think', matches: keyword('think'), run: thinkScenario },
  { name: 'background', matches: keyword('background'), run: backgroundScenario },
  { name: 'refusal-none', matches: keyword('refusal-none'), run: refusalNoFallbackScenario },
  { name: 'refusal-prompt', matches: keyword('refusal-prompt'), run: refusalPromptScenario },
  { name: 'refusal', matches: keyword('refusal'), run: refusalScenario },
  { name: 'plugin', matches: keyword('plugin'), run: pluginScenario },
  { name: 'default', matches: () => true, run: answerScenario },
];

/**
 * Chooses the scenario for a user's text.
 * @param {string} text
 * @returns {Scenario}
 */
export function selectScenario(text) {
  const trimmed = text.trim();
  const scenario = SCENARIOS.find((candidate) => candidate.matches(trimmed));
  if (!scenario) throw new Error('No scenario matches');
  return scenario;
}

/** Names of the scenarios, in match order. */
export const SCENARIO_NAMES = SCENARIOS.map((scenario) => scenario.name);
