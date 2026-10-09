// @ts-check
/**
 * The mock Query: one streaming session that behaves like the SDK's query() for the surface the gateway uses.
 *
 * The session is a pull-based async generator. Every wait (for the next prompt, a pause in a scenario, a permission
 * answer, an elicitation) goes through `waitFor`, which also drains the control outbox, so control methods such as
 * setPermissionMode take effect while the generator is suspended. Two abort controllers model the two kinds of stop:
 * the session controller ends the query (close, abortController, return), the turn controller interrupts the running
 * turn (interrupt). A turn that is interrupted still ends with a well-formed sequence: partial text is closed with an
 * aborted assistant message, open tool calls get a tool_result, and one error result closes the turn.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { EFFORT_LEVELS, isUuid, PERMISSION_MODES } from '../../contracts.mjs';
import {
  builtInServers,
  dialogResultOf,
  dynamicServerOf,
  FILE_INDEX_WARMUP_MS,
  hasPlanLimitsOf,
  loginMethodOf,
  mcpAuthorizationOf,
  parseAddress,
  serverEntry,
  serverStatusOf,
  sideAnswerOf,
  startModeOf,
  taskOutputOf,
} from './answers.mjs';
import {
  activeGoal,
  autocompactState,
  backgroundTasksChanged,
  BACKGROUND_RUN_MS,
  BACKGROUND_WAIT_MS,
  commandLifecycle,
  CONTEXT_MAX_TOKENS,
  interruptedMessage,
  outputFileOf,
  permissionDenied,
  postTurnSummary,
  promptSuggestion,
  ScenarioFailure,
  selectScenario,
  sentenceOf,
  sessionTitleChanged,
  stateChanged,
  statusMessage,
  syntheticUser,
  taskNotification,
  toolResult,
  usageOf,
} from './scenarios.mjs';
import { createMemoryStore, newRecord, sliceRecord } from './store.mjs';
import { createRuntimeState } from './runtime.mjs';
import {
  chromeDialogOf,
  exportFilenameOf,
  exportTextOf,
  fileSuggestionsOf,
  hooksListingOf,
  memoryDialogOf,
  permissionRulesOf,
  readDeniedBy,
  sandboxDialogOf,
  settingsOf,
  skillsDialogOf,
  statusOf,
} from './views.mjs';

/** @typedef {import('../../contracts.mjs').SDKMessage} SDKMessage */
/** @typedef {import('../../contracts.mjs').SDKUserMessage} SDKUserMessage */
/** @typedef {import('../../contracts.mjs').SdkOptions} SdkOptions */
/** @typedef {import('../../contracts.mjs').SdkQuery} SdkQuery */
/** @typedef {import('../../contracts.mjs').PermissionMode} PermissionMode */
/** @typedef {import('../../contracts.mjs').EffortLevel} EffortLevel */
/** @typedef {import('../../contracts.mjs').ElicitationRequest} ElicitationRequest */
/** @typedef {import('../../contracts.mjs').ElicitationResult} ElicitationResult */
/** @typedef {import('../../contracts.mjs').Logger} Logger */
/** @typedef {import('../../contracts.mjs').SDKSessionInfo} SDKSessionInfo */
/** @typedef {import('./store.mjs').RecordStore} RecordStore */
/** @typedef {import('./store.mjs').MockSessionRecord} MockSessionRecord */
/** @typedef {import('./runtime.mjs').RuntimeState} RuntimeState */
/** @typedef {import('./answers.mjs').McpEntry} McpEntry */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').OnUserDialog} OnUserDialog */
/** @typedef {import('./store.mjs').MockEntry} MockEntry */
/** @typedef {import('./scenarios.mjs').SessionView} SessionView */
/** @typedef {import('./scenarios.mjs').TurnContext} TurnContext */
/** @typedef {import('./scenarios.mjs').PermissionOutcome} PermissionOutcome */
/** @typedef {import('./scenarios.mjs').PermissionDetail} PermissionDetail */
/** @typedef {import('./scenarios.mjs').SessionSummary} SessionSummary */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SDKResultMessage} SDKResultMessage */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SDKAssistantMessage} SDKAssistantMessage */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SDKSystemMessage} SDKSystemMessage */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SDKPartialAssistantMessage} SDKPartialAssistantMessage */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SDKPermissionDenial} SDKPermissionDenial */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').PermissionUpdate} PermissionUpdate */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').CanUseTool} CanUseTool */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').OnElicitation} OnElicitation */
/**
 * Usage of one model response, as the turn result counts it.
 * @typedef {{model: string, input: number, output: number, cacheRead: number, cacheCreate: number,
 *   webSearch: number, webFetch: number, topLevel: boolean}} ResponseUsage
 */

/** @typedef {import('@anthropic-ai/claude-agent-sdk').NonNullableUsage} NonNullableUsage */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').ModelUsage} ModelUsage */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SDKControlInterruptResponse} SDKControlInterruptResponse */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SDKControlInitializeResponse} SDKControlInitializeResponse */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SDKControlGetContextUsageResponse} ContextUsageResponse */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SDKControlGetUsageResponse} UsageResponse */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').RewindFilesResult} RewindFilesResult */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SlashCommand} SlashCommand */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').ModelInfo} ModelInfo */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').AgentInfo} AgentInfo */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').AccountInfo} AccountInfo */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').McpServerStatus} McpServerStatus */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SDKControlReadFileResponse} ReadFileResponse */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SDKControlReloadPluginsResponse} ReloadPluginsResponse */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').FastModeState} FastModeState */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').FastModeDisabledReason} FastModeDisabledReason */
/** @typedef {import('./scenarios.mjs').ForegroundTask} ForegroundTask */

export const MODEL_DEFAULT = 'claude-sonnet-mock';
export const CLAUDE_CODE_VERSION = '2.1.295-mock';

/** The tool names the mock advertises in system/init. */
const TOOL_NAMES = ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'TodoWrite', 'Agent',
  'AskUserQuestion', 'ExitPlanMode'];
/** Tools that acceptEdits mode runs without asking. */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** The output styles Claude Code 2.1.x ships, with the names it reports. */
const OUTPUT_STYLES = ['default', 'Proactive', 'Concise', 'Explanatory', 'Learning'];
/** The filesystem settings sources a query loads when settingSources is omitted. */
const SETTING_SOURCES = ['user', 'project', 'local'];
const SUGGESTIONS = [
  'Show me the project structure',
  'Run the test suite',
  'Summarize what changed in this session',
];

/**
 * Ends the running turn on purpose. `terminalReason` becomes the result's terminal_reason.
 */
export class TurnStop extends Error {
  /** @param {'aborted_streaming'|'aborted_tools'} terminalReason @param {string} message */
  constructor(terminalReason, message) {
    super(message);
    this.name = 'TurnStop';
    this.terminalReason = terminalReason;
  }
}

/** Ends the whole query: close(), the abortController of the options, or return(). */
export class SessionClosed extends Error {
  constructor() {
    super('The query was closed.');
    this.name = 'SessionClosed';
  }
}

/**
 * Returns a UUID derived from the session id and a sequence number, so message ids are stable for one session.
 * @param {string} sessionId
 * @param {number} sequence
 * @returns {`${string}-${string}-${string}-${string}-${string}`}
 */
export function uuidFor(sessionId, sequence) {
  const hex = createHash('sha256').update(`${sessionId}:${sequence}`).digest('hex');
  const variant = ((Number.parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16);
  const first = hex.slice(0, 8);
  const second = hex.slice(8, 12);
  const third = `4${hex.slice(13, 16)}`;
  const fourth = `${variant}${hex.slice(18, 20)}`;
  const fifth = hex.slice(20, 32);
  return `${first}-${second}-${third}-${fourth}-${fifth}`;
}

/**
 * A promise that can be resolved from outside, used as a wakeup signal.
 * @returns {{promise: Promise<void>, wake: () => void}}
 */
function signalPair() {
  /** @type {() => void} */
  let wake = () => {};
  const promise = new Promise((resolveSignal) => {
    wake = () => resolveSignal(undefined);
  });
  return { promise, wake };
}

/**
 * Resolves after `ms` milliseconds, or rejects with the signal's reason as soon as the signal aborts.
 * @param {number} ms
 * @param {AbortSignal} signal
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  return new Promise((resolveSleep, rejectSleep) => {
    if (signal.aborted) {
      rejectSleep(signal.reason);
      return;
    }
    /** @type {ReturnType<typeof setTimeout>} */
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      rejectSleep(signal.reason);
    };
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolveSleep();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Multiplexes several prompt sources (the initial prompt and every streamInput call) into one queue. The session
 * finishes once every source has ended and the queue is empty.
 */
class InputQueue {
  constructor() {
    /** @type {LinkedPrompt[]} */
    this.items = [];
    /** @type {number} */
    this.open = 0;
    /** @type {Array<(result: IteratorResult<LinkedPrompt, void>) => void>} */
    this.takers = [];
    /** @type {unknown} */
    this.failure = undefined;
  }

  /** @param {LinkedPrompt} message */
  push(message) {
    const taker = this.takers.shift();
    if (taker) taker({ done: false, value: message });
    else this.items.push(message);
  }

  /** Registers one more source that will be pumped into the queue. */
  attach() {
    this.open += 1;
  }

  /** Called when one source has ended. */
  detach() {
    this.open -= 1;
    if (this.open > 0) return;
    for (const taker of this.takers.splice(0)) taker({ done: true, value: undefined });
  }

  /**
   * A prompt source failed: waiting and future takes reject with the error.
   * @param {unknown} error
   */
  fail(error) {
    this.failure = error;
    for (const taker of this.takers.splice(0)) taker({ done: true, value: undefined });
  }

  /**
   * Removes and returns every prompt that is already waiting, without waiting for more.
   * @returns {LinkedPrompt[]}
   */
  drainWaiting() {
    return this.items.splice(0);
  }

  /**
   * The uuids of the prompts that wait behind the running turn, in order.
   * @returns {string[]}
   */
  waiting() {
    return this.items.map((prompt) => prompt.uuid);
  }

  /**
   * Removes one waiting prompt. False when no waiting prompt has that uuid: it is running already, or it is unknown.
   * @param {string} uuid
   * @returns {boolean}
   */
  remove(uuid) {
    const index = this.items.findIndex((prompt) => prompt.uuid === uuid);
    if (index < 0) return false;
    this.items.splice(index, 1);
    return true;
  }

  /**
   * Removes every waiting prompt and returns their uuids.
   * @returns {string[]}
   */
  cancelAll() {
    return this.items.splice(0).map((prompt) => prompt.uuid);
  }

  /** @returns {Promise<IteratorResult<LinkedPrompt, void>>} */
  take() {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    const next = this.items.shift();
    if (next !== undefined) return Promise.resolve({ done: false, value: next });
    if (this.open === 0) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolveTake, rejectTake) => {
      this.takers.push((result) => (this.failure === undefined ? resolveTake(result) : rejectTake(this.failure)));
    });
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a value is an SDK user message: type 'user' with a message whose role is 'user'.
 * @param {unknown} value
 * @returns {value is SDKUserMessage}
 */
export function isUserMessage(value) {
  return isObject(value) && value.type === 'user' && isObject(value.message) && value.message.role === 'user';
}

/**
 * Text of a user prompt: its string content, or the text blocks joined in order. Images are not text.
 * @param {SDKUserMessage} message
 * @returns {string}
 */
export function promptText(message) {
  const content = message.message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/**
 * A prompt given as a plain string becomes one user message, as the SDK does.
 * @param {string} text
 * @returns {AsyncGenerator<SDKUserMessage, void, unknown>}
 */
async function* singlePrompt(text) {
  yield {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
  };
}

/**
 * Pacing of the background tasks: the wait of a foreground command and the run of a background one, in milliseconds.
 * @typedef {{waitMs?: number, runMs?: number}} BackgroundTiming
 */

/**
 * A foreground task as the session keeps it: the scenario's handle, the resolver a backgroundTasks call uses and the
 * output the command writes once it completes in the background.
 * @typedef {ForegroundTask & {resolve: (task: {taskId: string}) => void, output: string}} ForegroundEntry
 */
/**
 * A task running in the background. Its completion is scheduled on `timer`, which ends early when the task is stopped.
 * @typedef {{taskId: string, toolUseId: string, description: string, output: string, startedAt: number,
 *   timer: ReturnType<typeof setTimeout>}} BackgroundTask
 */

/**
 * Mutable state shared by the session generator, the scenarios and the control methods.
 * @typedef {Object} SessionCore
 * @property {string} sessionId
 * @property {string} cwd
 * @property {string} home the HOME the query runs with (the user's ~/.claude is read under it)
 * @property {string} model
 * @property {PermissionMode} permissionMode
 * @property {EffortLevel|null} effort
 * @property {string} outputStyle
 * @property {number} delayMs
 * @property {RecordStore} store
 * @property {RuntimeState} runtime                 the trust record, account and sign-in the queries share
 * @property {Logger|undefined} log
 * @property {AbortController} sessionAbort         ends the query
 * @property {AbortController|null} turnAbort       interrupts the running turn
 * @property {SDKMessage[]} outbox                  control messages waiting for the consumer
 * @property {() => Promise<void>} changed          resolves when the outbox or the session changes
 * @property {() => void} notify
 * @property {number} sequence                      uuid sequence of the session
 * @property {Record<string, number>} counters      id counters, persisted with the record
 * @property {number} turnIndex                     completed turns
 * @property {Record<string, ModelUsage>} modelUsage  cumulative per model, as the result reports it
 * @property {number} fiveHourUtilization           percent of the five-hour window, from rate_limit_event
 * @property {Map<string, McpEntry>} mcp            every configured server, by name
 * @property {Map<string, {state: string}>} mcpFlows  sign-ins in progress, by server name
 * @property {string|null} agent                    the main-thread agent (option agent, or applyFlagSettings)
 * @property {string[]} additionalDirectories       extra working directories (option additionalDirectories)
 * @property {string|null} fallbackModel            the model a refused answer is retried on (option fallbackModel)
 * @property {string[]} dialogKinds                 dialog kinds the host renders (option supportedDialogKinds)
 * @property {boolean} chrome                       the query starts with the CLI's --chrome flag
 * @property {number} fileIndexReadyAt              time (ms) from which the @ index answers
 * @property {Map<string, string>} shellOutputs     output of every shell task that ran in the background, by task id
 * @property {Map<string, {toolUseId: string, stopped: boolean}>} tasks
 * @property {Set<string>} stoppedToolUseIds        tool_use ids whose task was stopped
 * @property {string[]} userMessageUuids            prompts the turn in progress answers; empty between turns
 * @property {Record<string, unknown>} flagSettings the flag layer: the settings option, then applyFlagSettings
 * @property {Record<string, unknown>} fileSettings the settings the user's files define, under the flag layer
 * @property {string[]} settingSources              the filesystem sources the query loads
 * @property {boolean} perTaskStopAffordance        an interrupt keeps the background tasks when true
 * @property {string|null} thinkingDisplay          the --thinking-display flag (extraArgs); a non-interactive runtime
 *   sends thinking text only when it is 'summarized', whatever showThinkingSummaries says
 * @property {boolean} backgroundDisabled           the runtime refuses background tasks
 * @property {{waitMs: number, runMs: number}} backgroundTiming   how long a foreground command waits to be moved, and
 *   how long a background command runs in the mock
 * @property {Map<string, ForegroundEntry>} foreground   commands and agents that a backgroundTasks call can move
 * @property {Map<string, BackgroundTask>} background    tasks running in the background, by task id
 * @property {Set<string>} pendingPlugins           plugins installed but not applied by a reload yet
 * @property {Set<string>} appliedPlugins           plugins a reload applied
 * @property {boolean} closed
 */

/**
 * Yields the control messages queued by control methods and the state changes of the session, until the awaited
 * promise settles. Checks the signal first, so an aborted wait never returns a value.
 * @template T
 * @param {SessionCore} core
 * @param {Promise<T>} promise
 * @param {AbortSignal} signal
 * @returns {AsyncGenerator<SDKMessage, T, unknown>}
 */
export async function* waitFor(core, promise, signal) {
  /** @type {{done: boolean, ok: boolean, value?: T, error?: unknown}} */
  const outcome = { done: false, ok: true };
  const settled = promise.then(
    (value) => {
      outcome.done = true;
      outcome.value = value;
    },
    (error) => {
      outcome.done = true;
      outcome.ok = false;
      outcome.error = error;
    },
  );
  /** @type {() => void} */
  let wakeOnAbort = () => {};
  const aborted = new Promise((resolveAbort) => {
    wakeOnAbort = () => resolveAbort(undefined);
  });
  signal.addEventListener('abort', wakeOnAbort, { once: true });
  try {
    for (;;) {
      while (core.outbox.length > 0) {
        const message = core.outbox.shift();
        if (message !== undefined) yield message;
      }
      if (signal.aborted) throw signal.reason;
      if (outcome.done) {
        if (outcome.ok) return /** @type {T} */ (outcome.value);
        throw outcome.error;
      }
      await Promise.race([core.changed(), settled, aborted]);
    }
  } finally {
    signal.removeEventListener('abort', wakeOnAbort);
  }
}

/**
 * Pumps one prompt source into the queue. Each prompt passes through `accept` first, which links it and announces it.
 * The source counts as open until it ends or the session stops.
 * @param {InputQueue} queue
 * @param {AsyncIterable<unknown>} source
 * @param {AbortSignal} signal
 * @param {(message: SDKUserMessage) => LinkedPrompt} accept
 * @returns {Promise<void>}
 */
async function pumpSource(queue, source, signal, accept) {
  queue.attach();
  try {
    for await (const message of source) {
      if (signal.aborted) break;
      if (!isUserMessage(message)) throw new TypeError('The prompt must yield SDK user messages.');
      queue.push(accept(message));
    }
  } finally {
    queue.detach();
  }
}

/**
 * Rejects option values that the SDK would reject, before any session is started.
 * @param {SdkOptions} options
 * @returns {void}
 */
export function validateOptions(options) {
  if (!isObject(options)) throw new TypeError('The query options must be an object.');
  const { sessionId, resume, resumeSessionAt, forkSession, continue: continueLatest, permissionMode, effort, model,
    cwd, title, settings, perTaskStopAffordance, settingSources, extraArgs } = options;
  if (sessionId !== undefined && (typeof sessionId !== 'string' || !isUuid(sessionId))) {
    throw new TypeError('sessionId must be a UUID.');
  }
  if (resume !== undefined && (typeof resume !== 'string' || !isUuid(resume))) {
    throw new TypeError('resume must be a session UUID.');
  }
  if (resume !== undefined && continueLatest === true) throw new TypeError('resume and continue are exclusive.');
  if (resumeSessionAt !== undefined && (typeof resumeSessionAt !== 'string' || resumeSessionAt === '')) {
    throw new TypeError('resumeSessionAt must be a message uuid.');
  }
  if (resumeSessionAt !== undefined && resume === undefined && continueLatest !== true) {
    throw new TypeError('resumeSessionAt needs resume or continue.');
  }
  if (sessionId !== undefined && (resume !== undefined || continueLatest === true) && forkSession !== true) {
    throw new TypeError('sessionId combined with resume or continue needs forkSession.');
  }
  if (permissionMode !== undefined && permissionMode !== null &&
    !PERMISSION_MODES.some((mode) => mode === permissionMode)) {
    throw new TypeError(`Unknown permission mode: ${String(permissionMode)}`);
  }
  if (effort !== undefined && effort !== null && !EFFORT_LEVELS.some((level) => level === effort)) {
    throw new TypeError(`Unknown effort level: ${String(effort)}`);
  }
  if (model !== undefined && (typeof model !== 'string' || model.trim() === '')) {
    throw new TypeError('model must be a non-empty string.');
  }
  if (cwd !== undefined && (typeof cwd !== 'string' || !isAbsolute(cwd))) {
    throw new TypeError('cwd must be an absolute path.');
  }
  if (title !== undefined && (typeof title !== 'string' || title.trim() === '')) {
    throw new TypeError('title must be a non-empty string.');
  }
  if (settings !== undefined && !isObject(settings)) throw new TypeError('settings must be an object.');
  if (extraArgs !== undefined && (!isObject(extraArgs) || Object.values(extraArgs)
    .some((value) => value !== null && typeof value !== 'string'))) {
    throw new TypeError('extraArgs must map flag names to strings or null.');
  }
  if (perTaskStopAffordance !== undefined && typeof perTaskStopAffordance !== 'boolean') {
    throw new TypeError('perTaskStopAffordance must be a boolean.');
  }
  if (settingSources !== undefined && (!Array.isArray(settingSources)
    || settingSources.some((source) => !SETTING_SOURCES.some((known) => known === source)))) {
    throw new TypeError(`settingSources must only list ${SETTING_SOURCES.join(', ')}.`);
  }
  validateRuntimeOptions(options);
}

/**
 * Rejects the options that shape the runtime answers: the dialog kinds (which need their callback), the agent, the
 * extra directories, the fallback model, the MCP servers and the persistence flag.
 * @param {SdkOptions} options
 * @returns {void}
 */
function validateRuntimeOptions(options) {
  const { supportedDialogKinds, onUserDialog, persistSession, agent, additionalDirectories, fallbackModel, mcpServers,
    allowDangerouslySkipPermissions } = options;
  if (supportedDialogKinds !== undefined && (!Array.isArray(supportedDialogKinds)
    || supportedDialogKinds.some((kind) => typeof kind !== 'string'))) {
    throw new TypeError('supportedDialogKinds must be a list of strings.');
  }
  if (Array.isArray(supportedDialogKinds) && supportedDialogKinds.length > 0 && typeof onUserDialog !== 'function') {
    throw new TypeError('supportedDialogKinds requires onUserDialog.');
  }
  if (persistSession !== undefined && typeof persistSession !== 'boolean') {
    throw new TypeError('persistSession must be a boolean.');
  }
  if (agent !== undefined && (typeof agent !== 'string' || agent.trim() === '')) {
    throw new TypeError('agent must be a non-empty string.');
  }
  if (additionalDirectories !== undefined && (!Array.isArray(additionalDirectories)
    || additionalDirectories.some((dir) => typeof dir !== 'string' || !isAbsolute(dir)))) {
    throw new TypeError('additionalDirectories must be a list of absolute paths.');
  }
  if (fallbackModel !== undefined && (typeof fallbackModel !== 'string' || fallbackModel.trim() === '')) {
    throw new TypeError('fallbackModel must be a non-empty string.');
  }
  if (mcpServers !== undefined && !isObject(mcpServers)) throw new TypeError('mcpServers must be an object.');
  if (allowDangerouslySkipPermissions !== undefined && typeof allowDangerouslySkipPermissions !== 'boolean') {
    throw new TypeError('allowDangerouslySkipPermissions must be a boolean.');
  }
}

/**
 * Opens the record the query runs on.
 * - new: a record with options.sessionId, or a random UUID.
 * - resume: the stored record with that id; its cwd must match, otherwise the session is not found.
 * - continue: the most recent record of cwd.
 * - forkSession: a new record copied from the source, cut at resumeSessionAt; the source is not changed.
 * - resumeSessionAt without a fork: the stored record is cut at that message, so later turns continue from there.
 * @param {{store: RecordStore, options: SdkOptions, cwd: string, now: number}} args
 * @returns {MockSessionRecord}
 */
export function openRecord({ store, options, cwd, now }) {
  const resumeId = typeof options.resume === 'string' ? options.resume.toLowerCase() : undefined;
  const continueLatest = options.continue === true;
  if (resumeId === undefined && !continueLatest) {
    const sessionId = typeof options.sessionId === 'string' ? options.sessionId.toLowerCase() : randomUUID();
    return store.create(newRecord({
      sessionId,
      cwd,
      customTitle: typeof options.title === 'string' ? options.title : null,
      now,
    }));
  }
  const source = resumeId !== undefined ? store.read(resumeId) : store.findLatest(cwd);
  if (!source || source.cwd !== cwd) {
    throw new Error(resumeId !== undefined
      ? `No conversation found with session ID: ${resumeId}`
      : 'No conversation found to continue.');
  }
  if (options.forkSession === true) {
    const cut = sliceRecord(source, options.resumeSessionAt);
    const forked = newRecord({
      sessionId: typeof options.sessionId === 'string' ? options.sessionId.toLowerCase() : randomUUID(),
      cwd,
      customTitle: typeof options.title === 'string' ? options.title : source.customTitle,
      now,
    });
    forked.firstPrompt = source.firstPrompt;
    forked.generatedTitle = source.generatedTitle;
    forked.transcript = cut.transcript;
    forked.subagents = cut.subagents;
    forked.counters = { ...source.counters };
    return store.create(forked);
  }
  if (options.resumeSessionAt !== undefined) {
    const cut = sliceRecord(source, options.resumeSessionAt);
    return store.update(source.sessionId, (record) => {
      record.transcript = cut.transcript;
      record.subagents = cut.subagents;
    });
  }
  return source;
}

/**
 * Id prefixes used by the scenarios, one counter per kind so that ids never repeat inside a session.
 * @type {Record<'message'|'tool'|'agent'|'hook'|'task', string>}
 */
const ID_PREFIX = {
  message: 'msg_mock_',
  tool: 'toolu_mock_',
  agent: 'agent_mock_',
  hook: 'hook_mock_',
  task: 'task_mock_',
};

/**
 * The thinking display a query was started with: the value of `--thinking-display` in extraArgs, or null.
 * @param {unknown} extraArgs
 * @returns {string|null}
 */
function thinkingDisplayOf(extraArgs) {
  if (!isObject(extraArgs)) return null;
  const value = extraArgs['thinking-display'];
  return typeof value === 'string' ? value : null;
}

/**
 * The servers a session starts with: the built-in ones, then the servers the mcpServers option names.
 * @param {Record<string, unknown>|undefined} mcpServers
 * @returns {Map<string, McpEntry>}
 */
function configuredServersOf(mcpServers) {
  const servers = builtInServers();
  for (const [name, config] of Object.entries(mcpServers ?? {})) servers.set(name, dynamicServerOf(name, config));
  return servers;
}

/**
 * The status of a configured server by name: undefined when no server has that name.
 * @param {SessionCore} core
 * @param {string} serverName
 * @returns {string|undefined}
 */
export function statusNamed(core, serverName) {
  const server = core.mcp.get(serverName);
  return server === undefined ? undefined : serverStatusOf(server).status;
}

/**
 * Builds the shared state of one session from its stored record.
 * @param {{record: MockSessionRecord, options: SdkOptions, store: RecordStore, delayMs: number, log: Logger|undefined,
 *   fileSettings: Record<string, unknown>, backgroundDisabled: boolean, backgroundTiming: BackgroundTiming,
 *   runtime: RuntimeState}} args
 * @returns {SessionCore}
 */
export function createCore({
  record, options, store, delayMs, log, fileSettings, backgroundDisabled, backgroundTiming, runtime,
}) {
  const { uuid: uuidSequence = 0, ...counters } = record.counters;
  const settingSources = Array.isArray(options.settingSources) ? [...options.settingSources] : [...SETTING_SOURCES];
  const loaded = settingSources.length > 0 ? { ...fileSettings } : {};
  const flagLayer = isObject(options.settings) ? options.settings : {};
  let pending = signalPair();
  /** @type {SessionCore} */
  const core = {
    sessionId: record.sessionId,
    cwd: record.cwd,
    home: typeof options.env?.HOME === 'string' && options.env.HOME !== '' ? options.env.HOME : homedir(),
    model: typeof options.model === 'string' ? options.model : MODEL_DEFAULT,
    permissionMode: startModeOf(options.permissionMode, { ...loaded, ...flagLayer }),
    effort: options.effort ?? null,
    outputStyle: 'default',
    delayMs,
    store,
    log,
    sessionAbort: new AbortController(),
    turnAbort: null,
    outbox: [],
    changed: () => pending.promise,
    notify: () => {
      const previous = pending;
      pending = signalPair();
      previous.wake();
    },
    sequence: uuidSequence,
    counters,
    turnIndex: countPrompts(record),
    modelUsage: {},
    fiveHourUtilization: 0,
    runtime,
    mcp: configuredServersOf(options.mcpServers),
    mcpFlows: new Map(),
    agent: typeof options.agent === 'string' ? options.agent : null,
    additionalDirectories: Array.isArray(options.additionalDirectories) ? [...options.additionalDirectories] : [],
    fallbackModel: typeof options.fallbackModel === 'string' ? options.fallbackModel : null,
    dialogKinds: Array.isArray(options.supportedDialogKinds) ? [...options.supportedDialogKinds] : [],
    chrome: isObject(options.extraArgs) && Object.hasOwn(options.extraArgs, 'chrome'),
    fileIndexReadyAt: Date.now() + FILE_INDEX_WARMUP_MS,
    shellOutputs: new Map(),
    tasks: new Map(),
    stoppedToolUseIds: new Set(),
    userMessageUuids: [],
    flagSettings: { ...flagLayer },
    fileSettings: loaded,
    settingSources,
    perTaskStopAffordance: options.perTaskStopAffordance === true,
    thinkingDisplay: thinkingDisplayOf(options.extraArgs),
    backgroundDisabled,
    backgroundTiming: {
      waitMs: backgroundTiming.waitMs ?? BACKGROUND_WAIT_MS,
      runMs: backgroundTiming.runMs ?? BACKGROUND_RUN_MS,
    },
    foreground: new Map(),
    background: new Map(),
    pendingPlugins: new Set(),
    appliedPlugins: new Set(),
    closed: false,
  };
  return core;
}

/**
 * The next id of one kind, such as `toolu_mock_3`.
 * @param {SessionCore} core
 * @param {'message'|'tool'|'agent'|'hook'|'task'} kind
 * @returns {string}
 */
export function nextId(core, kind) {
  const count = (core.counters[kind] ?? 0) + 1;
  core.counters[kind] = count;
  return `${ID_PREFIX[kind]}${count}`;
}

/**
 * The uuid and session id of a new message. Uuids come from the session id and a sequence, so they are stable.
 * @param {SessionCore} core
 * @returns {{uuid: `${string}-${string}-${string}-${string}-${string}`, session_id: string}}
 */
export function envelopeOf(core) {
  core.sequence += 1;
  return { uuid: uuidFor(core.sessionId, core.sequence), session_id: core.sessionId };
}

/**
 * Writes the transcript changes of one step together with the id counters. The record is re-read first, so the
 * write always starts from what the store holds.
 * @param {SessionCore} core
 * @param {(record: MockSessionRecord) => void} mutate
 * @returns {void}
 */
export function persist(core, mutate) {
  core.store.update(core.sessionId, (record) => {
    mutate(record);
    record.counters = { ...core.counters, uuid: core.sequence };
  });
}

/**
 * Whether a transcript entry is a prompt typed by the user, as opposed to a tool result.
 * @param {MockEntry} entry
 * @returns {boolean}
 */
export function isPromptEntry(entry) {
  if (entry.type !== 'user') return false;
  const content = entry.message?.content;
  if (typeof content === 'string') return true;
  return Array.isArray(content) && content.some((block) => block?.type === 'text');
}

/**
 * Number of prompts stored in a record; the next turn index.
 * @param {MockSessionRecord} record
 * @returns {number}
 */
export function countPrompts(record) {
  return record.transcript.filter(isPromptEntry).length;
}

/**
 * Follows the messages of one turn as they pass the runner. It remembers streamed drafts that have no final message,
 * tool calls without a result and running tasks, so an interrupted turn can be closed cleanly.
 */
export class TurnObserver {
  constructor() {
    /** @type {Map<string, {text: string, parentToolUseId: string|null, agentId: string|null}>} */
    this.drafts = new Map();
    /** @type {string|null} */
    this.currentDraft = null;
    /** @type {Map<string, {parentToolUseId: string|null, agentId: string|null}>} tool_use id -> origin */
    this.openTools = new Map();
    /** @type {Map<string, string>} task id -> tool_use id of the Agent call */
    this.runningTasks = new Map();
    /** @type {Map<string, ResponseUsage>} */
    this.responses = new Map();
    /** @type {string|null} stop reason announced by message_delta, applied when the response finishes */
    this.pendingStop = null;
    /** @type {string|null} */
    this.stopReason = null;
    /** @type {string|null} uuid of the last top-level assistant message, which the turn summary names */
    this.lastAssistantUuid = null;
    /** @type {string|null} uuid of the top-level message whose text is the turn's answer */
    this.finalUuid = null;
    this.finalText = '';
  }

  /**
   * Forgets the answer of messages that were retracted from the transcript: when the turn's answer is one of them, the
   * turn ends without an answer. Their usage stays counted, because the model did produce them.
   * @param {string[]} uuids
   * @returns {void}
   */
  forget(uuids) {
    if (this.finalUuid === null || !uuids.includes(this.finalUuid)) return;
    this.finalUuid = null;
    this.finalText = '';
    this.stopReason = null;
  }

  /**
   * Records what one yielded message means for the turn.
   * @param {SDKMessage} message
   * @returns {void}
   */
  see(message) {
    switch (message.type) {
      case 'stream_event':
        this.#seeStream(message);
        return;
      case 'assistant':
        this.#seeAssistant(message);
        return;
      case 'user':
        for (const block of userBlocks(message)) {
          if (block.type === 'tool_result') this.openTools.delete(block.tool_use_id);
        }
        return;
      case 'system':
        if (message.subtype === 'task_started') this.runningTasks.set(message.task_id, message.tool_use_id);
        if (message.subtype === 'task_notification') this.runningTasks.delete(message.task_id);
        return;
      default:
        return;
    }
  }

  /** @param {SDKPartialAssistantMessage} message */
  #seeStream(message) {
    const { event } = message;
    if (event.type === 'message_start') {
      this.drafts.set(event.message.id, { text: '', parentToolUseId: message.parent_tool_use_id, agentId: null });
      this.currentDraft = event.message.id;
      this.pendingStop = null;
    } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      const draft = this.currentDraft === null ? undefined : this.drafts.get(this.currentDraft);
      if (draft) draft.text += event.delta.text;
    } else if (event.type === 'message_delta') {
      this.pendingStop = event.delta.stop_reason;
    }
  }

  /** @param {SDKAssistantMessage} message */
  #seeAssistant(message) {
    const { id, content, stop_reason: announced, usage } = message.message;
    const topLevel = message.parent_tool_use_id === null;
    this.drafts.delete(id);
    if (!this.responses.has(id)) {
      this.responses.set(id, {
        model: message.message.model,
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        cacheCreate: usage.cache_creation_input_tokens ?? 0,
        webSearch: usage.server_tool_use?.web_search_requests ?? 0,
        webFetch: usage.server_tool_use?.web_fetch_requests ?? 0,
        topLevel,
      });
    }
    for (const block of content) {
      if (block.type === 'tool_use') {
        this.openTools.set(block.id, {
          parentToolUseId: message.parent_tool_use_id,
          agentId: message.agent_id ?? null,
        });
      }
      if (topLevel && block.type === 'text') {
        this.finalText = block.text;
        this.finalUuid = message.uuid;
      }
    }
    if (topLevel) {
      this.lastAssistantUuid = message.uuid;
      this.stopReason = announced ?? this.pendingStop ?? this.stopReason;
      this.pendingStop = null;
    }
  }

  /**
   * Streamed drafts that never got a final assistant message: the text of an interrupted response.
   * @returns {Array<{id: string, text: string, parentToolUseId: string|null, agentId: string|null}>}
   */
  openDrafts() {
    return [...this.drafts].map(([id, draft]) => ({ id, ...draft }));
  }

  /**
   * Tool calls that have no result yet, newest first, so nested calls are closed before their parent.
   * @returns {Array<{toolUseId: string, parentToolUseId: string|null, agentId: string|null}>}
   */
  openToolCalls() {
    return [...this.openTools]
      .map(([toolUseId, origin]) => ({ toolUseId, ...origin }))
      .reverse();
  }
}

/**
 * The content blocks of a user message, as a list.
 * @param {SDKUserMessage} message
 * @returns {Array<{type: string, tool_use_id?: string}>}
 */
function userBlocks(message) {
  const content = message.message.content;
  return Array.isArray(content) ? content : [];
}

/**
 * What one turn needs from the query options and its own abort controller.
 * @typedef {Object} TurnState
 * @property {AbortController} controller                     interrupts this turn
 * @property {AbortSignal} signal                             aborted by interrupt or when the session ends
 * @property {CanUseTool|undefined} canUseTool
 * @property {OnElicitation|undefined} onElicitation
 * @property {OnUserDialog|undefined} onUserDialog            the host's dialog callback, when it renders dialogs
 * @property {SDKPermissionDenial[]} denials                  denied tool calls of this turn
 * @property {number} startedAt
 * @property {string} userMessageUuid                         uuid of the batch's last prompt, as the SDK reports it
 * @property {string[]} userMessageUuids                      every prompt the turn answers, in consumption order
 */

/**
 * A prompt that has a uuid: the gateway sets it to the client message id, and the mock assigns one when it is missing.
 * @typedef {SDKUserMessage & {uuid: string}} LinkedPrompt
 */

/** Context rows that do not change while a session runs, in tokens. */
const FIXED_CONTEXT_ROWS = [
  { name: 'System prompt', tokens: 2400 },
  { name: 'System tools', tokens: 9200 },
  { name: 'Memory files', tokens: 640 },
];
const GITHUB_TOOL_TOKENS = 1200;

/**
 * Estimated tokens of the messages since the last compaction (about four characters per token).
 * @param {MockSessionRecord} record
 * @returns {number}
 */
export function messageTokensOf(record) {
  let start = 0;
  record.transcript.forEach((entry, index) => {
    if (entry.type === 'system' && entry.message?.subtype === 'compact_boundary') start = index + 1;
  });
  return record.transcript
    .slice(start)
    .filter((entry) => entry.type !== 'system')
    .reduce((sum, entry) => sum + Math.ceil(JSON.stringify(entry.message).length / 4), 0);
}

/**
 * The /context and /usage view of the session: fixed rows, the messages since the last compaction, and totals.
 * @param {SessionCore} core
 * @returns {SessionSummary}
 */
export function describeSessionOf(core) {
  const record = core.store.read(core.sessionId);
  const messageTokens = record ? messageTokensOf(record) : 0;
  const rows = [
    ...FIXED_CONTEXT_ROWS,
    ...(statusNamed(core, 'github') === 'connected' ? [{ name: 'MCP tools', tokens: GITHUB_TOOL_TOKENS }] : []),
    { name: 'Messages', tokens: messageTokens },
  ];
  const used = rows.reduce((sum, row) => sum + row.tokens, 0);
  const models = Object.values(core.modelUsage);
  const total = (/** @type {(model: ModelUsage) => number} */ pick) =>
    models.reduce((sum, model) => sum + pick(model), 0);
  return {
    model: core.model,
    plan: 'Pro',
    contextTokens: used,
    contextMax: CONTEXT_MAX_TOKENS,
    contextRows: [...rows, { name: 'Free space', tokens: Math.max(0, CONTEXT_MAX_TOKENS - used) }],
    inputTokens: total((model) => model.inputTokens),
    outputTokens: total((model) => model.outputTokens),
    costUsd: total((model) => model.costUSD),
    fiveHourUtilization: core.fiveHourUtilization,
  };
}

/**
 * The view of the session that builders use outside a turn.
 * @param {SessionCore} core
 * @returns {SessionView}
 */
export function sessionView(core) {
  return {
    envelope: () => envelopeOf(core),
    now: () => Date.now(),
    model: core.model,
    userMessageUuids: [...core.userMessageUuids],
  };
}

/**
 * Asks whether a tool call may run. The permission mode decides first: bypassPermissions allows everything,
 * acceptEdits allows edit tools and dontAsk denies. Without a canUseTool callback nothing can be asked, so the call is
 * denied, as the SDK does without a prompt tool. Otherwise the callback answers, and its request ends with the turn.
 * @param {SessionCore} core
 * @param {TurnState} turn
 * @param {string} toolName
 * @param {Record<string, unknown>} input
 * @param {PermissionDetail} detail
 * @returns {AsyncGenerator<SDKMessage, PermissionOutcome, unknown>}
 */
export async function* askPermission(core, turn, toolName, input, detail) {
  const view = sessionView(core);
  const mode = core.permissionMode;
  if (mode === 'bypassPermissions' || (mode === 'acceptEdits' && EDIT_TOOLS.has(toolName))) {
    return { allowed: true, input, updatedPermissions: [] };
  }
  if (mode === 'dontAsk' || turn.canUseTool === undefined) {
    const reason = mode === 'dontAsk' ? 'dontAsk' : 'no_prompt_tool';
    const message = mode === 'dontAsk'
      ? `Permission to use ${toolName} was denied because the session is in dontAsk mode.`
      : `Permission to use ${toolName} was denied because no permission prompt is available.`;
    turn.denials.push({ tool_name: toolName, tool_use_id: detail.toolUseId, tool_input: input });
    yield permissionDenied(view, { toolName, toolUseId: detail.toolUseId, message, reason });
    return { allowed: false, message, interrupt: false };
  }
  /** @type {PermissionUpdate[]} */
  const suggestions = detail.suggestions ?? [
    { type: 'addRules', rules: [{ toolName }], behavior: 'allow', destination: 'localSettings' },
  ];
  const canUseTool = turn.canUseTool;
  yield stateChanged(view, 'requires_action');
  const decision = yield* waitFor(core, Promise.resolve().then(() => canUseTool(toolName, input, {
    signal: turn.signal,
    toolUseID: detail.toolUseId,
    requestId: randomUUID(),
    title: detail.title,
    displayName: detail.displayName,
    description: detail.description,
    decisionReason: detail.decisionReason,
    blockedPath: detail.blockedPath,
    mcpServer: detail.mcpServer,
    suggestions,
  })), turn.signal);
  yield stateChanged(view, 'running');
  if (decision.behavior === 'allow') {
    return {
      allowed: true,
      input: decision.updatedInput ?? input,
      updatedPermissions: [...(decision.updatedPermissions ?? [])],
    };
  }
  turn.denials.push({ tool_name: toolName, tool_use_id: detail.toolUseId, tool_input: input });
  if (decision.interrupt === true) throw new TurnStop('aborted_tools', decision.message);
  return { allowed: false, message: decision.message, interrupt: false };
}

/**
 * Asks the user for an MCP elicitation through onElicitation. Without that callback the request is cancelled.
 * @param {SessionCore} core
 * @param {TurnState} turn
 * @param {ElicitationRequest} request
 * @returns {AsyncGenerator<SDKMessage, ElicitationResult, unknown>}
 */
export async function* elicitationOf(core, turn, request) {
  if (turn.onElicitation === undefined) return { action: 'cancel' };
  const onElicitation = turn.onElicitation;
  const view = sessionView(core);
  yield stateChanged(view, 'requires_action');
  const requestId = randomUUID();
  const result = yield* waitFor(core, Promise.resolve().then(() => onElicitation(request, {
    signal: turn.signal,
    requestId,
  })), turn.signal);
  yield stateChanged(view, 'running');
  return result ?? { action: 'cancel' };
}

/**
 * Asks the host through onUserDialog and waits for its answer. The answer is the dialog's result: retry_fallback,
 * edit_prompt or cancelled. Without a callback nothing is asked and the result is null.
 * @param {SessionCore} core
 * @param {TurnState} turn
 * @param {{kind: string, payload: Record<string, unknown>, toolUseId?: string}} dialog
 * @returns {AsyncGenerator<SDKMessage, 'retry_fallback'|'edit_prompt'|'cancelled'|null, unknown>}
 */
export async function* userDialogOf(core, turn, { kind, payload, toolUseId }) {
  if (turn.onUserDialog === undefined) return null;
  const onUserDialog = turn.onUserDialog;
  const view = sessionView(core);
  yield stateChanged(view, 'requires_action');
  const requestId = randomUUID();
  const answer = yield* waitFor(core, Promise.resolve().then(() => onUserDialog({
    dialogKind: kind,
    payload,
    toolUseID: toolUseId,
  }, { signal: turn.signal, requestId })), turn.signal);
  yield stateChanged(view, 'running');
  return dialogResultOf(answer);
}

/**
 * The context one scenario reads for one turn.
 * @param {{core: SessionCore, turn: TurnState, userText: string, streamPartials: boolean,
 *   observer: TurnObserver}} args
 * @returns {TurnContext}
 */
export function turnContextOf({ core, turn, userText, streamPartials, observer }) {
  return {
    sessionId: core.sessionId,
    cwd: core.cwd,
    model: core.model,
    userText,
    userMessageUuid: turn.userMessageUuid,
    userMessageUuids: [...turn.userMessageUuids],
    delayMs: core.delayMs,
    streamPartials,
    turnIndex: core.turnIndex,
    nextId: (kind) => nextId(core, kind),
    envelope: () => envelopeOf(core),
    now: () => Date.now(),
    pause: (ms) => {
      const wait = sleep(ms, turn.signal);
      wait.catch(() => {});
      return waitFor(core, wait, turn.signal);
    },
    askPermission: (toolName, input, detail) => askPermission(core, turn, toolName, input, detail),
    elicitation: (request) => elicitationOf(core, turn, request),
    mcpConnected: (serverName) => statusNamed(core, serverName) === 'connected',
    describeSession: () => describeSessionOf(core),
    thinkingSummaries: core.thinkingDisplay === 'summarized',
    foregroundTask: (toolUseId, description, output) => foregroundTaskOf(core, toolUseId, description, output),
    awaitBackground: (task) => awaitBackgroundOf(core, turn, task),
    dialogKinds: [...core.dialogKinds],
    fallbackModel: core.fallbackModel,
    userDialog: (dialog) => userDialogOf(core, turn, dialog),
    retract: (uuids) => {
      evictRetracted(core, uuids);
      observer.forget(uuids);
    },
  };
}

/**
 * Removes the refused messages that a fallback retracted from the transcript, as the SDK evicts them on arrival.
 * @param {SessionCore} core
 * @param {string[]} uuids
 * @returns {void}
 */
function evictRetracted(core, uuids) {
  if (uuids.length === 0) return;
  const retracted = new Set(uuids);
  persist(core, (record) => {
    record.transcript = record.transcript.filter((entry) => !retracted.has(entry.uuid));
  });
}

/**
 * Registers a Bash command or an agent as a foreground task. A backgroundTasks call can move it while the turn waits.
 * The registration is made before the tool call streams, so a request that arrives early is not lost.
 * @param {SessionCore} core
 * @param {string} toolUseId
 * @param {string} description
 * @param {string} [output] what the command prints when it completes in the background
 * @returns {ForegroundEntry}
 */
export function foregroundTaskOf(core, toolUseId, description, output = '') {
  /** @type {(task: {taskId: string}) => void} */
  let resolve = () => {};
  /** @type {Promise<{taskId: string}>} */
  const moved = new Promise((resolveMoved) => {
    resolve = resolveMoved;
  });
  /** @type {ForegroundEntry} */
  const entry = { toolUseId, description, moved, resolve, output };
  core.foreground.set(toolUseId, entry);
  return entry;
}

/**
 * Waits until a foreground task is moved to the background. Resolves with the new task, or with null when the wait
 * ends first, in which case the command finishes in the foreground. The wait ends with the turn.
 * @param {SessionCore} core
 * @param {TurnState} turn
 * @param {ForegroundTask} task
 * @returns {AsyncGenerator<SDKMessage, {taskId: string}|null, unknown>}
 */
export async function* awaitBackgroundOf(core, turn, task) {
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timer;
  /** @type {Promise<null>} */
  const timeout = new Promise((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(null), core.backgroundTiming.waitMs);
  });
  try {
    return yield* waitFor(core, Promise.race([task.moved, timeout]), turn.signal);
  } finally {
    clearTimeout(timer);
    if (core.foreground.get(task.toolUseId) === task) core.foreground.delete(task.toolUseId);
  }
}

/**
 * Starts a shell task in the background. Its output is kept for get_task_output from the start. Its completion is
 * scheduled, and the end of the session clears the schedule.
 * @param {SessionCore} core
 * @param {{taskId: string, toolUseId: string, description: string, output: string}} task
 * @returns {void}
 */
function startBackground(core, { taskId, toolUseId, description, output }) {
  const timer = setTimeout(() => {
    const notice = endBackground(core, taskId, 'completed', `Background command "${description}" completed`);
    if (notice === null) return;
    core.outbox.push(notice, backgroundTasksChanged(sessionView(core), backgroundListOf(core)));
    core.notify();
  }, core.backgroundTiming.runMs);
  core.background.set(taskId, { taskId, toolUseId, description, output, startedAt: Date.now(), timer });
  core.shellOutputs.set(taskId, '');
  core.sessionAbort.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
}

/**
 * Ends a background task: it leaves the set, its schedule is cleared and its terminal notice is returned.
 * @param {SessionCore} core
 * @param {string} taskId
 * @param {'completed'|'stopped'} status
 * @param {string} summary
 * @returns {SDKMessage|null}
 */
function endBackground(core, taskId, status, summary) {
  const task = core.background.get(taskId);
  if (task === undefined) return null;
  clearTimeout(task.timer);
  core.background.delete(taskId);
  if (status === 'completed') core.shellOutputs.set(taskId, task.output);
  return taskNotification(sessionView(core), {
    taskId,
    toolUseId: task.toolUseId,
    summary,
    totalTokens: 0,
    toolUses: 0,
    durationMs: Math.max(0, Date.now() - task.startedAt),
    status,
    outputFile: outputFileOf(taskId),
  });
}

/**
 * The live background tasks, in the shape background_tasks_changed lists them.
 * @param {SessionCore} core
 * @returns {Array<{taskId: string, description: string}>}
 */
function backgroundListOf(core) {
  return [...core.background.values()].map((task) => ({ taskId: task.taskId, description: task.description }));
}

/**
 * The settings a query runs with: the settings the user's files define, under the flag layer. A null in the flag layer
 * means the files decide, as applyFlagSettings({fastMode: null}) does.
 * @param {SessionCore} core
 * @returns {Record<string, unknown>}
 */
export function effectiveSettingsOf(core) {
  const flags = Object.entries(core.flagSettings).filter(([, value]) => value !== null && value !== undefined);
  return { ...core.fileSettings, ...Object.fromEntries(flags) };
}

/**
 * Whether a model serves fast mode, matched by its alias or its resolved id.
 * @param {string} model
 * @returns {boolean}
 */
function supportsFastMode(model) {
  return MODELS.some((entry) => entry.supportsFastMode === true
    && (entry.value === model || entry.resolvedModel === model));
}

/**
 * The fast mode fields of system/init and of every result. An SDK session is opted out until the host sets fastMode in
 * the flag layer (sdk_opt_in_required); null hands the decision to the user's files; a model without fast mode reports
 * model_not_allowed; otherwise the state is on or off.
 * @param {SessionCore} core
 * @returns {{fast_mode_state: FastModeState, fast_mode_disabled_reason?: FastModeDisabledReason}}
 */
export function fastModeFieldsOf(core) {
  const flag = core.flagSettings.fastMode;
  const requested = typeof flag === 'boolean' ? flag : (flag === null ? core.fileSettings.fastMode : undefined);
  if (requested === false) return { fast_mode_state: 'off' };
  if (typeof requested !== 'boolean') {
    return { fast_mode_state: 'off', fast_mode_disabled_reason: 'sdk_opt_in_required' };
  }
  if (!supportsFastMode(core.model)) return { fast_mode_state: 'off', fast_mode_disabled_reason: 'model_not_allowed' };
  return { fast_mode_state: 'on' };
}

/**
 * The MCP server a plugin contributes, named the way the runtime scopes plugin servers.
 * @param {string} plugin
 * @returns {string}
 */
function pluginServerOf(plugin) {
  return `plugin:${plugin}:docs`;
}

/**
 * What applying the pending plugins would change in the tool list: the plugin servers they register.
 * @param {SessionCore} core
 * @returns {{mcp_servers_added: string[], mcp_servers_removed: string[], lsp_tool_change: null}}
 */
function cacheImpactOf(core) {
  return {
    mcp_servers_added: [...core.pendingPlugins].map(pluginServerOf),
    mcp_servers_removed: [],
    lsp_tool_change: null,
  };
}

/**
 * The lists a reload answers with: what the session has now.
 * @param {SessionCore} core
 * @returns {Omit<ReloadPluginsResponse, 'held' | 'cache_impact'>}
 */
function reloadListsOf(core) {
  return {
    commands: COMMANDS.map((command) => ({ ...command })),
    agents: AGENTS.map((agent) => ({ ...agent })),
    plugins: [...core.appliedPlugins].map((name) => ({
      name,
      path: `/mock/plugins/${name}`,
      source: 'mock',
      version: '1.0.0',
    })),
    mcpServers: mcpStatusOf(core),
    error_count: 0,
  };
}

/**
 * Applies the pending plugins: their servers connect and the plugins join the session.
 * @param {SessionCore} core
 * @returns {void}
 */
function applyPluginReload(core) {
  for (const plugin of core.pendingPlugins) {
    core.mcp.set(pluginServerOf(plugin), serverEntry({ transport: 'stdio' }));
    core.appliedPlugins.add(plugin);
  }
  core.pendingPlugins.clear();
}

/**
 * Starts a turn: its own controller, linked to the session so that closing the session also stops the turn.
 * @param {SessionCore} core
 * @param {SdkOptions} options
 * @param {string[]} userMessageUuids uuids of the prompts the turn answers, in consumption order (never empty)
 * @returns {TurnState}
 */
export function beginTurn(core, options, userMessageUuids) {
  const controller = new AbortController();
  core.turnAbort = controller;
  return {
    controller,
    signal: AbortSignal.any([core.sessionAbort.signal, controller.signal]),
    canUseTool: options.canUseTool,
    onElicitation: options.onElicitation,
    onUserDialog: options.onUserDialog,
    denials: [],
    startedAt: Date.now(),
    userMessageUuid: userMessageUuids[userMessageUuids.length - 1],
    userMessageUuids: [...userMessageUuids],
  };
}

/** System entries that a reader shows later; everything else is live-only. */
const PERSISTED_SYSTEM_SUBTYPES = new Set(['compact_boundary', 'local_command_output', 'informational']);

/**
 * Stores what a transcript keeps: user and assistant messages, the system entries a reader shows later and the
 * conversation resets. Top-level messages go to the transcript, subagent messages to their own list. Stream events,
 * results and live notices are not stored.
 * @param {SessionCore} core
 * @param {SDKMessage} message
 * @returns {void}
 */
export function persistIfNeeded(core, message) {
  if (message.type === 'system' && message.subtype === 'model_refusal_fallback') {
    evictRetracted(core, message.retracted_message_uuids ?? []);
    return;
  }
  /** @type {MockEntry|null} */
  let entry = null;
  if (message.type === 'assistant' || message.type === 'user') {
    entry = {
      type: message.type,
      uuid: message.uuid ?? envelopeOf(core).uuid,
      session_id: core.sessionId,
      message: message.message,
      parent_tool_use_id: message.parent_tool_use_id,
      parent_agent_id: null,
    };
  } else if (message.type === 'system' && PERSISTED_SYSTEM_SUBTYPES.has(message.subtype)) {
    entry = {
      type: 'system',
      uuid: message.uuid,
      session_id: core.sessionId,
      message: { ...message, uuid: undefined, session_id: undefined },
      parent_tool_use_id: null,
      parent_agent_id: null,
    };
  } else if (message.type === 'conversation_reset') {
    entry = {
      type: 'system',
      uuid: message.uuid,
      session_id: core.sessionId,
      message: { ...message, uuid: undefined, session_id: undefined },
      parent_tool_use_id: null,
      parent_agent_id: null,
    };
  }
  if (entry === null) return;
  const stored = entry;
  const agentId = 'agent_id' in message && typeof message.agent_id === 'string' ? message.agent_id : null;
  const subagentKey = agentId ?? (stored.parent_tool_use_id !== null ? stored.parent_tool_use_id : null);
  persist(core, (record) => {
    if (subagentKey === null || message.type === 'system' || message.type === 'conversation_reset') {
      record.transcript.push(stored);
      return;
    }
    record.subagents[subagentKey] = [...(record.subagents[subagentKey] ?? []), stored];
  });
}

/**
 * Adds one turn's model responses to the cumulative per-model totals of the session.
 * @param {SessionCore} core
 * @param {TurnObserver} observer
 * @returns {void}
 */
export function addUsage(core, observer) {
  for (const response of observer.responses.values()) {
    const current = core.modelUsage[response.model] ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0,
      contextWindow: CONTEXT_MAX_TOKENS,
      maxOutputTokens: 64000,
    };
    core.modelUsage[response.model] = {
      ...current,
      inputTokens: current.inputTokens + response.input,
      outputTokens: current.outputTokens + response.output,
      cacheReadInputTokens: current.cacheReadInputTokens + response.cacheRead,
      cacheCreationInputTokens: current.cacheCreationInputTokens + response.cacheCreate,
      webSearchRequests: current.webSearchRequests + response.webSearch,
    };
  }
}

/**
 * The turn's usage counted over the main loop, which is the usage the result reports per turn.
 * @param {TurnObserver} observer
 * @returns {NonNullableUsage}
 */
export function turnUsageOf(observer) {
  const main = [...observer.responses.values()].filter((response) => response.topLevel);
  const sum = (/** @type {(response: ResponseUsage) => number} */ pick) =>
    main.reduce((total, response) => total + pick(response), 0);
  return usageOf({
    input: sum((response) => response.input),
    output: sum((response) => response.output),
    cacheRead: sum((response) => response.cacheRead),
    cacheCreate: sum((response) => response.cacheCreate),
    webSearch: sum((response) => response.webSearch),
    webFetch: sum((response) => response.webFetch),
  });
}

/**
 * The result message that closes a turn. Success carries the final text; errors carry their reason and terminal_reason.
 * @param {SessionCore} core
 * @param {TurnState} turn
 * @param {TurnObserver} observer
 * @param {{error: string|null, terminalReason: 'aborted_streaming'|'aborted_tools'|'model_error'|null}} outcome
 * @returns {SDKResultMessage}
 */
export function resultOf(core, turn, observer, outcome) {
  const durationMs = Math.max(0, Date.now() - turn.startedAt);
  const common = {
    duration_ms: durationMs,
    duration_api_ms: durationMs,
    num_turns: [...observer.responses.values()].filter((response) => response.topLevel).length,
    total_cost_usd: 0,
    usage: turnUsageOf(observer),
    modelUsage: Object.fromEntries(Object.entries(core.modelUsage).map(([model, value]) => [model, { ...value }])),
    permission_denials: [...turn.denials],
    uuid: envelopeOf(core).uuid,
    session_id: core.sessionId,
    user_message_uuid: turn.userMessageUuid,
    user_message_uuids: [...turn.userMessageUuids],
    ...fastModeFieldsOf(core),
  };
  if (outcome.error === null) {
    return {
      type: 'result',
      subtype: 'success',
      ...common,
      is_error: false,
      result: observer.finalText,
      stop_reason: observer.stopReason,
      terminal_reason: 'completed',
    };
  }
  return {
    type: 'result',
    subtype: 'error_during_execution',
    ...common,
    is_error: true,
    stop_reason: null,
    errors: [outcome.error],
    terminal_reason: outcome.terminalReason,
  };
}

/** Text of the tool result that closes a tool call an interrupt cut off. */
const INTERRUPTED_TOOL_TEXT = '[Request interrupted by user for tool use]';

/**
 * Closes an interrupted turn: the partial text gets an aborted message, open tool calls and running tasks get their
 * terminal messages and the interruption marker is written. The caller then yields the error result.
 * @param {SessionCore} core
 * @param {TurnContext} ctx
 * @param {TurnState} turn
 * @param {TurnObserver} observer
 * @param {(message: SDKMessage) => SDKMessage} seen
 * @returns {Generator<SDKMessage, void, unknown>}
 */
export function* closeInterruptedTurn(core, ctx, turn, observer, seen) {
  for (const draft of observer.openDrafts()) {
    yield seen(interruptedMessage(ctx, { id: draft.id, text: draft.text, parentToolUseId: draft.parentToolUseId,
      agentId: draft.agentId }));
  }
  for (const call of observer.openToolCalls()) {
    yield seen(toolResult(ctx, {
      toolUseId: call.toolUseId,
      content: INTERRUPTED_TOOL_TEXT,
      isError: true,
      parentToolUseId: call.parentToolUseId,
      agentId: call.agentId,
    }));
  }
  for (const [taskId, task] of core.tasks) {
    if (task.stopped) continue;
    core.tasks.delete(taskId);
    yield seen(taskNotification(ctx, {
      taskId,
      toolUseId: task.toolUseId,
      summary: 'Stopped by the interrupt',
      totalTokens: 0,
      toolUses: 0,
      durationMs: Math.max(0, Date.now() - turn.startedAt),
      status: 'stopped',
    }));
  }
  if (!core.perTaskStopAffordance && core.background.size > 0) {
    // Without perTaskStopAffordance, an interrupt also stops the background tasks.
    for (const taskId of [...core.background.keys()]) {
      const notice = endBackground(core, taskId, 'stopped', 'Stopped by the interrupt');
      if (notice !== null) yield seen(notice);
    }
    yield seen(backgroundTasksChanged(ctx, backgroundListOf(core)));
  }
  yield seen(syntheticUser(ctx, '[Request interrupted by user]'));
}

/**
 * Runs one turn: selects the scenario for the prompt, yields its messages through the observer and closes the turn.
 * A session that closes mid-turn ends silently, as the SDK does after close().
 * @param {SessionCore} core
 * @param {SdkOptions} options
 * @param {LinkedPrompt[]} prompts the prompts the turn answers, in consumption order (never empty)
 * @param {boolean} streamPartials
 * @returns {AsyncGenerator<SDKMessage, void, unknown>}
 */
export async function* runTurn(core, options, prompts, streamPartials) {
  const turn = beginTurn(core, options, prompts.map((prompt) => prompt.uuid));
  core.userMessageUuids = [...turn.userMessageUuids];
  const observer = new TurnObserver();
  const text = prompts.map((prompt) => promptText(prompt)).join('\n\n');
  const scenario = selectScenario(text);
  const ctx = turnContextOf({ core, turn, userText: text, streamPartials, observer });
  /** @param {SDKMessage} message */
  const seen = (message) => {
    observer.see(message);
    if (message.type === 'rate_limit_event' && message.rate_limit_info.rateLimitType === 'five_hour' &&
      typeof message.rate_limit_info.utilization === 'number') {
      core.fiveHourUtilization = message.rate_limit_info.utilization * 100;
    }
    // A background shell is not part of the turn, so an interrupt leaves it running.
    if (message.type === 'system' && message.subtype === 'task_started' && message.task_type !== 'local_bash') {
      core.tasks.set(message.task_id, { toolUseId: message.tool_use_id, stopped: false });
    }
    if (message.type === 'system' && message.subtype === 'task_notification') core.tasks.delete(message.task_id);
    if (message.type === 'system' && message.subtype === 'plugin_install' && message.status === 'installed') {
      if (message.name !== undefined) core.pendingPlugins.add(message.name);
    }
    persistIfNeeded(core, message);
    return message;
  };
  for (const prompt of prompts) yield seen(commandLifecycle(ctx, prompt.uuid, 'started'));
  yield seen(stateChanged(ctx, 'running'));
  /** @type {SDKResultMessage} */
  let result;
  try {
    for await (const message of scenario.run(ctx)) {
      const parent = parentToolUseIdOf(message);
      if (parent !== null && core.stoppedToolUseIds.has(parent)) continue;
      yield seen(message);
    }
    addUsage(core, observer);
    core.turnIndex += 1;
    result = resultOf(core, turn, observer, { error: null, terminalReason: null });
  } catch (error) {
    if (error instanceof SessionClosed || core.sessionAbort.signal.aborted) return;
    if (error instanceof TurnStop) {
      addUsage(core, observer);
      core.turnIndex += 1;
      yield* closeInterruptedTurn(core, ctx, turn, observer, seen);
      result = resultOf(core, turn, observer, { error: 'Interrupted', terminalReason: error.terminalReason });
    } else if (error instanceof ScenarioFailure) {
      addUsage(core, observer);
      core.turnIndex += 1;
      result = resultOf(core, turn, observer, { error: error.message, terminalReason: 'model_error' });
    } else {
      throw error;
    }
  } finally {
    core.turnAbort = null;
    core.userMessageUuids = [];
    core.foreground.clear();
  }
  yield seen(result);
  yield seen(postTurnSummary(ctx, {
    summarizes: observer.lastAssistantUuid ?? result.uuid,
    detail: statusDetailOf(result),
  }));
  for (const prompt of prompts) yield seen(commandLifecycle(ctx, prompt.uuid, 'completed'));
  const title = generatedTitleOf(core);
  if (title !== null) {
    persist(core, (record) => {
      record.generatedTitle = title;
    });
    yield seen(sessionTitleChanged(ctx, title));
  }
  if (result.subtype === 'success') {
    yield seen(promptSuggestion(ctx, SUGGESTIONS[core.turnIndex % SUGGESTIONS.length]));
  }
  yield seen(stateChanged(ctx, 'idle'));
}

/**
 * The one-line status of a finished turn: the first sentence of its reply, or why the turn did not finish.
 * @param {SDKResultMessage} result
 * @returns {string}
 */
function statusDetailOf(result) {
  if (result.subtype === 'success') return sentenceOf(result.result) || 'Turn completed.';
  if (result.terminal_reason === 'model_error') return `Turn failed: ${result.errors[0]}.`;
  return 'Turn was interrupted.';
}

/**
 * The title a session takes from its first prompt when it has neither a custom title nor a generated one: the first
 * eight words, at most 60 characters. Null when there is nothing to name yet.
 * @param {SessionCore} core
 * @returns {string|null}
 */
function generatedTitleOf(core) {
  const record = core.store.read(core.sessionId);
  if (!record || record.customTitle || record.generatedTitle || record.firstPrompt === null) return null;
  const words = Array.from(record.firstPrompt.split(' ').slice(0, 8).join(' '));
  return words.length > 60 ? `${words.slice(0, 57).join('')}...` : words.join('');
}

/**
 * The parent tool_use id of a message, or null for messages that have none.
 * @param {SDKMessage} message
 * @returns {string|null}
 */
export function parentToolUseIdOf(message) {
  return 'parent_tool_use_id' in message && typeof message.parent_tool_use_id === 'string'
    ? message.parent_tool_use_id
    : null;
}

/** Slash commands the mock advertises, as the SDK lists them. */
export const COMMANDS = [
  { name: 'compact', description: 'Clear conversation history but keep a summary in context',
    argumentHint: '<instructions>', builtin: true },
  { name: 'clear', description: 'Clear conversation history and free up context', argumentHint: '', builtin: true },
  { name: 'context', description: 'Show current context usage', argumentHint: '', builtin: true },
  { name: 'usage', description: 'Show session cost, token usage and plan limits', argumentHint: '', builtin: true },
  { name: 'init', description: 'Initialize a new CLAUDE.md file with codebase documentation',
    argumentHint: '', builtin: true },
  { name: 'review', description: 'Review a pull request', argumentHint: '<pr number>', builtin: true },
  { name: 'code-review', description: 'Review the current changes for bugs and style issues', argumentHint: '<files>' },
  { name: 'verify', description: 'Check that the project builds and its tests pass', argumentHint: '' },
  { name: 'deploy-check', description: 'Check a deployment plan before it ships', argumentHint: '<environment>' },
];

/** The skills the mock advertises (they are commands without the builtin flag). */
const SKILL_NAMES = ['code-review', 'verify', 'deploy-check'];

/** @type {AgentInfo[]} */
export const AGENTS = [
  { name: 'general-purpose',
    description: 'General-purpose agent for researching complex questions and multi-step tasks' },
  { name: 'Explore', description: 'Fast agent for exploring codebases and answering questions about them' },
  { name: 'Plan', description: 'Software architect agent for designing implementation plans' },
];

/**
 * The model aliases a client can pick. `resolvedModel` is the wire id each alias stands for, so a host can match the
 * model of the init message against the alias row.
 * @type {ModelInfo[]}
 */
export const MODELS = [
  {
    value: 'default',
    resolvedModel: 'claude-sonnet-mock',
    displayName: 'Default (recommended)',
    description: 'Balanced model for everyday coding work',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high'],
  },
  {
    value: 'opus',
    resolvedModel: 'claude-opus-mock',
    displayName: 'Opus',
    description: 'Most capable model for complex, long-running work',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsFastMode: true,
  },
  {
    value: 'sonnet',
    resolvedModel: 'claude-sonnet-mock',
    displayName: 'Sonnet',
    description: 'Fast and capable model for most coding tasks',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high'],
  },
  {
    value: 'haiku',
    resolvedModel: 'claude-haiku-mock',
    displayName: 'Haiku',
    description: 'Fastest model for simple, well-defined tasks',
    supportsEffort: false,
  },
];

/**
 * The system/init message that opens every session.
 * @param {SessionCore} core
 * @returns {SDKSystemMessage}
 */
export function initMessage(core) {
  return {
    type: 'system',
    subtype: 'init',
    apiKeySource: 'none',
    claude_code_version: CLAUDE_CODE_VERSION,
    cwd: core.cwd,
    tools: [...TOOL_NAMES],
    mcp_servers: [...core.mcp].map(([name, server]) => ({ name, status: serverStatusOf(server).status })),
    model: core.model,
    permissionMode: core.permissionMode,
    slash_commands: COMMANDS.map((command) => command.name),
    output_style: core.outputStyle,
    skills: [...SKILL_NAMES],
    plugins: [],
    agents: AGENTS.map((agent) => agent.name),
    effort: core.effort,
    capabilities: ['interrupt_receipt_v1'],
    ...fastModeFieldsOf(core),
    ...envelopeOf(core),
  };
}

/**
 * Stores a prompt as the next user entry and, for the first prompt, as the session's first prompt.
 * @param {SessionCore} core
 * @param {SDKUserMessage} prompt
 * @returns {void}
 */
export function persistPrompt(core, prompt) {
  const text = promptText(prompt).replace(/\s+/g, ' ').trim();
  const uuid = typeof prompt.uuid === 'string' ? prompt.uuid : envelopeOf(core).uuid;
  persist(core, (record) => {
    record.transcript.push({
      type: 'user',
      uuid,
      session_id: core.sessionId,
      message: prompt.message,
      parent_tool_use_id: null,
      parent_agent_id: null,
    });
    if (record.firstPrompt === null && text !== '') record.firstPrompt = text.slice(0, 200);
  });
}

/**
 * A prompt with a uuid: the one the host sent (the gateway sets it to the client message id), or a new one when it sent
 * none.
 * @param {SessionCore} core
 * @param {SDKUserMessage} prompt
 * @returns {LinkedPrompt}
 */
function linkedPrompt(core, prompt) {
  const uuid = typeof prompt.uuid === 'string' ? prompt.uuid : envelopeOf(core).uuid;
  return { ...prompt, uuid };
}

/**
 * Accepts one prompt into the session's queue. The prompt gets its uuid, and its queued state waits in the outbox like
 * every control message, so the consumer sees it on its next pull.
 * @param {SessionCore} core
 * @param {SDKUserMessage} message
 * @returns {LinkedPrompt}
 */
function acceptPrompt(core, message) {
  const prompt = linkedPrompt(core, message);
  core.outbox.push(commandLifecycle(sessionView(core), prompt.uuid, 'queued'));
  core.notify();
  return prompt;
}

/**
 * Resolves once no background task runs. Every change of the session wakes the check.
 * @param {SessionCore} core
 * @returns {Promise<void>}
 */
async function backgroundIdle(core) {
  while (core.background.size > 0) await core.changed();
}

/**
 * The session generator: init, the autocompact and goal settings, then one turn per batch of prompts, until the prompts
 * end or the session closes. A batch is the prompt that was taken plus every prompt already waiting behind it, so
 * prompts sent close together are answered by one turn. Control messages are yielded while the session waits for its
 * next prompt.
 * @param {SessionCore} core
 * @param {InputQueue} queue
 * @param {SdkOptions} options
 * @returns {AsyncGenerator<SDKMessage, void, unknown>}
 */
export async function* sessionLoop(core, queue, options) {
  try {
    const view = sessionView(core);
    yield initMessage(core);
    yield autocompactState(view);
    yield activeGoal(view);
    for (;;) {
      const next = yield* waitFor(core, queue.take(), core.sessionAbort.signal);
      if (next.done === true) {
        // The prompts have ended, but background work still reports: the session stays open until it finishes.
        yield* waitFor(core, backgroundIdle(core), core.sessionAbort.signal);
        break;
      }
      // One macrotask lets the pump deliver the prompts the host already pushed.
      yield* waitFor(core, new Promise((resolveTick) => setImmediate(resolveTick)), core.sessionAbort.signal);
      const batch = [next.value, ...queue.drainWaiting()];
      /** @type {LinkedPrompt[]} */
      const answered = [];
      for (const prompt of batch) {
        persistPrompt(core, prompt);
        if (prompt.shouldQuery !== false) {
          answered.push(prompt);
        } else {
          // A prompt that does not query has no turn, so it starts and completes at once.
          yield commandLifecycle(view, prompt.uuid, 'started');
          yield commandLifecycle(view, prompt.uuid, 'completed');
        }
      }
      if (answered.length === 0) continue;
      yield* runTurn(core, options, answered, options.includePartialMessages === true);
    }
  } catch (error) {
    if (!(error instanceof SessionClosed)) throw error;
  } finally {
    core.closed = true;
    core.log?.debug('mock session ended', { sessionId: core.sessionId });
  }
}

/** The HTML a mock MCP resource answers with. */
const MCP_UI_HTML = '<!doctype html><title>Mock resource</title><p>A static resource from the mock MCP server.</p>';

/**
 * One context category row of the /context breakdown.
 * @param {string} name
 * @param {number} tokens
 * @param {string} color
 * @param {'used'|'free'|'buffer'} kind
 * @returns {ContextUsageResponse['categories'][number]}
 */
function category(name, tokens, color, kind) {
  return { name, tokens, color, kind };
}

/**
 * @param {SessionCore} core
 * @param {string} serverName
 * @returns {McpEntry}
 */
export function serverOf(core, serverName) {
  const server = core.mcp.get(serverName);
  if (server === undefined) throw new Error(`No MCP server named ${serverName}`);
  return server;
}

/**
 * SDK-shaped status of every configured server. A server lists its tools only while it is connected.
 * @param {SessionCore} core
 * @returns {McpServerStatus[]}
 */
export function mcpStatusOf(core) {
  return [...core.mcp].map(([name, server]) => {
    const { status, error } = serverStatusOf(server);
    return {
      name,
      status,
      ...(error === undefined ? {} : { error }),
      scope: 'user',
      source: 'user',
      tools: status === 'connected'
        ? server.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          annotations: { readOnly: tool.readOnly },
        }))
        : [],
    };
  });
}

/**
 * Initialization result: the lists a client shows before the first turn, the account, the permission mode the runtime
 * started in and the other fields the runtime reports with it.
 * @param {SessionCore} core
 * @param {AccountInfo} account
 * @returns {SDKControlInitializeResponse & Record<string, unknown>}
 */
export function initializationOf(core, account) {
  return {
    account,
    agents: AGENTS.map((agent) => ({ ...agent })),
    analytics_disabled: false,
    available_output_styles: [...OUTPUT_STYLES],
    capabilities: ['ui_surface_v1'],
    commands: COMMANDS.map((command) => ({ ...command })),
    current_permission_mode: core.permissionMode,
    ...fastModeFieldsOf(core),
    feedback_mode: 'off',
    ide_rc_auto_enable_gate: false,
    models: MODELS.map((model) => ({ ...model })),
    output_style: core.outputStyle,
    pid: process.pid,
    remote_control_auto_connect_default: false,
    remote_control_auto_enable: false,
    remote_control_auto_on_by_default: false,
    remote_control_available: false,
    session_state: 'idle',
    user_output_styles_dir: '/mock/output-styles',
  };
}

/**
 * The /context breakdown in the SDK's response shape. Rows come from describeSessionOf, so /context and the
 * control method always agree.
 * @param {SessionCore} core
 * @returns {ContextUsageResponse}
 */
export function contextUsageOf(core) {
  const summary = describeSessionOf(core);
  const percentage = Math.round((summary.contextTokens / summary.contextMax) * 1000) / 10;
  const usedSquares = Math.round(percentage);
  const githubConnected = statusNamed(core, 'github') === 'connected';
  const categories = [
    ...summary.contextRows
      .filter((row) => row.name !== 'Free space')
      .map((row) => category(row.name, row.tokens, 'blue', 'used')),
    category('Free space', summary.contextRows.find((row) => row.name === 'Free space')?.tokens ?? 0, 'gray', 'free'),
    category('Autocompact buffer', 33000, 'amber', 'buffer'),
  ];
  const squareTokens = Math.round(summary.contextMax / 100);
  const gridRows = Array.from({ length: 10 }, (_, row) => Array.from({ length: 10 }, (_, column) => {
    const index = row * 10 + column;
    const filled = index < usedSquares;
    return {
      color: filled ? 'blue' : 'gray',
      isFilled: filled,
      categoryName: filled ? 'Messages' : 'Free space',
      tokens: squareTokens,
      percentage: 1,
      squareFullness: filled ? 1 : 0,
    };
  }));
  const totals = Object.values(core.modelUsage);
  const sumOf = (/** @type {(model: ModelUsage) => number} */ pick) =>
    totals.reduce((sum, model) => sum + pick(model), 0);
  const hasUsage = totals.length > 0;
  return {
    categories,
    totalTokens: summary.contextTokens,
    maxTokens: summary.contextMax,
    rawMaxTokens: summary.contextMax,
    percentage,
    gridRows,
    model: core.model,
    memoryFiles: [{ path: join(core.cwd, 'CLAUDE.md'), type: 'project', tokens: 640 }],
    mcpTools: githubConnected
      ? [{ name: 'search_issues', serverName: 'github', tokens: GITHUB_TOOL_TOKENS, isLoaded: true }]
      : [],
    agents: AGENTS.map((agent) => ({ agentType: agent.name, source: 'built-in', tokens: 120 })),
    autoCompactThreshold: summary.contextMax - 33000,
    isAutoCompactEnabled: true,
    apiUsage: hasUsage
      ? {
        input_tokens: sumOf((model) => model.inputTokens),
        output_tokens: sumOf((model) => model.outputTokens),
        cache_creation_input_tokens: sumOf((model) => model.cacheCreationInputTokens),
        cache_read_input_tokens: sumOf((model) => model.cacheReadInputTokens),
      }
      : null,
  };
}

/**
 * The /usage data in the SDK's response shape. Only an account with a plan has rate limits, which follow the five-hour
 * utilization of the session. The behaviors scan reads real transcripts, so the mock always answers it with null.
 * @param {SessionCore} core
 * @param {AccountInfo} account
 * @returns {UsageResponse}
 */
export function usageResponseOf(core, account) {
  const summary = describeSessionOf(core);
  const resetsAt = (/** @type {number} */ hours) => new Date(Date.now() + hours * 3600_000).toISOString();
  const limited = hasPlanLimitsOf(account);
  return {
    session: {
      total_cost_usd: summary.costUsd,
      total_api_duration_ms: 0,
      total_duration_ms: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
      model_usage: Object.fromEntries(Object.entries(core.modelUsage).map(([model, value]) => [model, { ...value }])),
    },
    subscription_type: limited ? account.subscriptionType ?? null : null,
    rate_limits_available: limited,
    rate_limits: limited
      ? {
        five_hour: { utilization: core.fiveHourUtilization, resets_at: resetsAt(1) },
        seven_day: { utilization: 31, resets_at: resetsAt(72) },
      }
      : null,
    behaviors: null,
  };
}

/**
 * Every Query member except the iterator protocol.
 * @typedef {Omit<SdkQuery, 'next' | 'return' | 'throw' | typeof Symbol.asyncIterator>} ControlMethods
 */

/**
 * The controls the mock adds to the SDK's Query. Most of them the SDK ships without public typings: the gateway reaches
 * them by feature detection, and their answers follow the runtime's shapes.
 * @typedef {Object} RuntimeControls
 * @property {() => Promise<{sections: Array<{title: string, rows: Array<{label: string, value: string}>}>}>} getStatus
 * @property {() => Promise<{state: Record<string, unknown>}>} listPermissionRules
 * @property {() => Promise<Record<string, unknown>>} getHooksListing
 * @property {() => Promise<Record<string, unknown>>} getSettings
 * @property {() => Promise<Record<string, unknown>>} getSkillsDialog
 * @property {() => Promise<Record<string, unknown>>} getSandboxDialog
 * @property {() => Promise<{exists: boolean}>} getPlan
 * @property {() => Promise<Record<string, unknown>>} getChromeDialog
 * @property {() => Promise<Record<string, unknown>>} getMemoryDialog
 * @property {() => Promise<{text: string, default_filename: string}>} exportConversation
 * @property {(taskId: string) => Promise<{output: string, total_bytes: number, truncated: boolean}>} getTaskOutput
 * @property {(uuid: string) => Promise<boolean>} cancelAsyncMessage
 * @property {(question: string, options?: {history?: unknown[], signal?: AbortSignal}) =>
 *   Promise<Record<string, unknown>|null>} askSideQuestion
 * @property {(target: string, options?: {trustAccepted?: boolean, trustedDirectory?: string}) =>
 *   Promise<Record<string, unknown>>} setCwd
 * @property {(payload: {subtype: string, query?: string}) => Promise<Record<string, unknown>>} request
 * @property {(loginWithClaudeAi: boolean) => Promise<{manualUrl: string, automaticUrl: string}>} claudeAuthenticate
 * @property {(authorizationCode: string, state: string) => Promise<{account: AccountInfo}>} claudeOAuthCallback
 * @property {() => Promise<{account: AccountInfo}>} claudeOAuthWaitForCompletion
 * @property {(serverName: string, redirectUri?: string) => Promise<Record<string, unknown>>} mcpAuthenticate
 * @property {(serverName: string, callbackUrl: string) => Promise<Record<string, unknown>>} mcpSubmitOAuthCallbackUrl
 * @property {(serverName: string) => Promise<{message: string}>} mcpClearAuth
 */

/**
 * Builds the control methods of one query. Each call first checks that the query is open, so a closed query rejects
 * every control call. Methods that change the session queue a status message for the consumer.
 * @param {{open: () => SessionCore, isClosed: () => boolean, close: () => void, queue: InputQueue,
 *   store: RecordStore, runtime: RuntimeState, owner: object}} deps owner is the query that runs the sign-ins
 * @returns {ControlMethods & RuntimeControls}
 */
export function createControls({ open, isClosed, close, queue, store, runtime, owner }) {
  /** @returns {SessionCore} */
  const live = () => {
    if (isClosed()) throw new Error('The query is closed.');
    return open();
  };
  /**
   * Queues a status message for the consumer and wakes the session if it is waiting.
   * @param {SessionCore} current
   * @param {PermissionMode} permissionMode
   */
  const announce = (current, permissionMode) => {
    current.outbox.push(statusMessage(sessionView(current), null, { permissionMode }));
    current.notify();
  };
  return {
    interrupt: async (options) => {
      const current = live();
      current.turnAbort?.abort(new TurnStop('aborted_streaming', 'Interrupted by user'));
      if (!(isObject(options) && options.cancelQueued === true)) return { still_queued: queue.waiting() };
      const cancelled = queue.cancelAll();
      for (const uuid of cancelled) announceCancelled(current, uuid);
      return { still_queued: [], cancelled };
    },
    setPermissionMode: async (mode) => {
      const current = live();
      if (!PERMISSION_MODES.some((candidate) => candidate === mode)) {
        throw new TypeError(`Unknown permission mode: ${String(mode)}`);
      }
      current.permissionMode = mode;
      announce(current, mode);
    },
    setMcpPermissionModeOverride: async (serverName, mode) => {
      const current = live();
      if (mode !== 'default' && mode !== 'auto' && mode !== null) {
        throw new TypeError('mode must be default, auto or null.');
      }
      if (statusNamed(current, serverName) !== 'connected') {
        return { warning: `No MCP server named "${serverName}" is connected.` };
      }
      return {};
    },
    setModel: async (model) => {
      const current = live();
      if (model !== undefined && (typeof model !== 'string' || model.trim() === '')) {
        throw new TypeError('model must be a non-empty string.');
      }
      current.model = model ?? MODEL_DEFAULT;
      announce(current, current.permissionMode);
    },
    setMaxThinkingTokens: async (maxThinkingTokens) => {
      live();
      if (maxThinkingTokens !== null && !(Number.isInteger(maxThinkingTokens) && maxThinkingTokens >= 0)) {
        throw new TypeError('maxThinkingTokens must be a non-negative integer or null.');
      }
    },
    applyFlagSettings: async (settings) => {
      const current = live();
      if (!isObject(settings)) throw new TypeError('settings must be an object.');
      const level = settings.effortLevel;
      if (level !== undefined) {
        if (level !== null && !EFFORT_LEVELS.some((candidate) => candidate === level)) {
          throw new TypeError(`Unknown effort level: ${String(level)}`);
        }
        current.effort = level;
      }
      if (typeof settings.model === 'string') current.model = settings.model;
      if (settings.model === null) current.model = MODEL_DEFAULT;
      if (settings.fastMode !== undefined) {
        if (settings.fastMode !== null && typeof settings.fastMode !== 'boolean') {
          throw new TypeError('fastMode must be a boolean or null.');
        }
        current.flagSettings.fastMode = settings.fastMode;
      }
      if (settings.agent !== undefined) {
        if (settings.agent !== null && (typeof settings.agent !== 'string' || settings.agent.trim() === '')) {
          throw new TypeError('agent must be a non-empty string or null.');
        }
        current.agent = settings.agent;
      }
      announce(current, current.permissionMode);
    },
    updateSettings: async (source, settings) => {
      const current = live();
      if (source !== 'localSettings' && source !== 'userSettings') throw new TypeError('Unknown settings source.');
      if (!isObject(settings)) throw new TypeError('settings must be an object.');
      for (const [key, value] of Object.entries(settings)) {
        if (typeof value !== 'string') throw new TypeError(`${key} must be a string.`);
      }
      if (source === 'localSettings' && !current.settingSources.includes('local')) {
        throw new Error('Local settings are not loaded for this session.');
      }
      if (source === 'localSettings' && typeof settings.outputStyle === 'string') {
        if (!OUTPUT_STYLES.some((style) => style === settings.outputStyle)) {
          throw new TypeError(`Unknown output style: ${settings.outputStyle}`);
        }
        current.outputStyle = settings.outputStyle;
      }
    },
    initializationResult: async () => initializationOf(live(), runtime.account()),
    reinitialize: async () => initializationOf(live(), runtime.account()),
    supportedCommands: async () => {
      live();
      return COMMANDS.map((command) => ({ ...command }));
    },
    supportedModels: async () => {
      live();
      return MODELS.map((model) => ({ ...model }));
    },
    supportedAgents: async () => {
      live();
      return AGENTS.map((agent) => ({ ...agent }));
    },
    mcpServerStatus: async () => mcpStatusOf(live()),
    getContextUsage: async () => contextUsageOf(live()),
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => usageResponseOf(live(), runtime.account()),
    accountInfo: async () => {
      live();
      return runtime.account();
    },
    readFile: async (path, options) => {
      const current = live();
      if (typeof path !== 'string' || path === '') throw new TypeError('path must be a non-empty string.');
      const absPath = resolve(current.cwd, path);
      const rel = relative(current.cwd, absPath);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
      if (readDeniedBy(effectiveSettingsOf(current), current.cwd, absPath)) return null;
      if (!existsSync(absPath) || !statSync(absPath).isFile()) return null;
      const maxBytes = options?.maxBytes ?? 1024 * 1024;
      if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new TypeError('maxBytes must be a positive integer.');
      const buffer = readFileSync(absPath);
      const truncated = buffer.length > maxBytes;
      const bytes = truncated ? buffer.subarray(0, maxBytes) : buffer;
      const base64 = options?.encoding === 'base64';
      /** @type {ReadFileResponse} */
      const response = {
        contents: bytes.toString(base64 ? 'base64' : 'utf8'),
        absPath,
        ...(truncated ? { truncated: true } : {}),
        ...(base64 ? { encoding: 'base64' } : {}),
      };
      return response;
    },
    seedReadState: async (path, mtime) => {
      live();
      if (typeof path !== 'string' || !Number.isFinite(mtime)) {
        throw new TypeError('seedReadState needs a path and an mtime.');
      }
    },
    reloadPlugins: async (options) => {
      const current = live();
      const hold = options?.holdOnCacheImpact === true;
      // The check the terminal's /reload-plugins makes: once a turn has run, the prompt cache depends on the tool list.
      if (hold && current.pendingPlugins.size > 0 && current.turnIndex > 0) {
        return { ...reloadListsOf(current), held: true, cache_impact: cacheImpactOf(current) };
      }
      applyPluginReload(current);
      return { ...reloadListsOf(current), ...(hold ? { held: false } : {}) };
    },
    reloadSkills: async () => {
      live();
      const skills = COMMANDS.filter((command) => SKILL_NAMES.includes(command.name));
      return { skills: skills.map((command) => ({ ...command })) };
    },
    reloadOutputStyles: async () => {
      live();
      return { available_output_styles: [...OUTPUT_STYLES] };
    },
    rewindFiles: async (userMessageId) => {
      const current = live();
      if (typeof userMessageId !== 'string' || userMessageId === '') {
        throw new TypeError('userMessageId must be a message uuid.');
      }
      const record = store.read(current.sessionId);
      const known = record?.transcript.some((entry) => isPromptEntry(entry) && entry.uuid === userMessageId) === true;
      return known
        ? { canRewind: true, filesChanged: ['src/app.js'], insertions: 3, deletions: 1 }
        : { canRewind: false, error: 'No checkpoint for that message' };
    },
    reconnectMcpServer: async (serverName) => {
      const current = live();
      const server = serverOf(current, serverName);
      if (!server.enabled) throw new Error(`MCP server ${serverName} is disabled.`);
      // A reconnect re-reads the server's reachability, which the entry already holds: the status follows from it.
    },
    toggleMcpServer: async (serverName, enabled) => {
      const current = live();
      const server = serverOf(current, serverName);
      if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean.');
      server.enabled = enabled;
    },
    readMcpResource: async (serverName, uri) => {
      const current = live();
      const server = serverOf(current, serverName);
      if (serverStatusOf(server).status !== 'connected') throw new Error(`MCP server ${serverName} is not connected.`);
      if (typeof uri !== 'string' || !uri.startsWith('ui://')) throw new TypeError('uri must use the ui:// scheme.');
      return { contents: [{ uri, mimeType: 'text/html', text: MCP_UI_HTML }] };
    },
    setMcpServers: async (servers) => {
      const current = live();
      if (!isObject(servers)) throw new TypeError('servers must be an object.');
      const previous = [...current.mcp].filter(([, server]) => server.dynamic).map(([name]) => name);
      const added = Object.keys(servers).filter((name) => !previous.includes(name));
      const removed = previous.filter((name) => !Object.hasOwn(servers, name));
      for (const name of removed) current.mcp.delete(name);
      for (const [name, config] of Object.entries(servers)) current.mcp.set(name, dynamicServerOf(name, config));
      return { added, removed, errors: {} };
    },
    streamInput: async (stream) => {
      const current = live();
      if (!isObject(stream) || typeof stream[Symbol.asyncIterator] !== 'function') {
        throw new TypeError('streamInput needs an async iterable of user messages.');
      }
      await pumpSource(queue, stream, current.sessionAbort.signal, (message) => acceptPrompt(current, message));
    },
    stopTask: async (taskId) => {
      const current = live();
      const notice = endBackground(current, taskId, 'stopped', 'Stopped by request');
      if (notice !== null) {
        current.outbox.push(notice, backgroundTasksChanged(sessionView(current), backgroundListOf(current)));
        current.notify();
        return;
      }
      const task = current.tasks.get(taskId);
      if (task === undefined || task.stopped) return;
      task.stopped = true;
      current.stoppedToolUseIds.add(task.toolUseId);
      current.outbox.push(taskNotification(sessionView(current), {
        taskId,
        toolUseId: task.toolUseId,
        summary: 'Stopped by request',
        totalTokens: 0,
        toolUses: 0,
        durationMs: 0,
        status: 'stopped',
      }));
      current.notify();
    },
    backgroundTasks: async (toolUseId) => {
      const current = live();
      if (current.backgroundDisabled) throw new Error('Background tasks are disabled for this session.');
      if (toolUseId !== undefined && typeof toolUseId !== 'string') throw new TypeError('toolUseId must be a string.');
      const moving = [...current.foreground.values()]
        .filter((entry) => toolUseId === undefined || entry.toolUseId === toolUseId);
      for (const entry of moving) {
        current.foreground.delete(entry.toolUseId);
        const taskId = nextId(current, 'task');
        startBackground(current, {
          taskId,
          toolUseId: entry.toolUseId,
          description: entry.description,
          output: entry.output,
        });
        current.outbox.push(backgroundTasksChanged(sessionView(current), backgroundListOf(current)));
        entry.resolve({ taskId });
      }
      if (moving.length > 0) current.notify();
      return moving.length > 0;
    },
    getStatus: async () => {
      const current = live();
      return statusOf({
        sessionId: current.sessionId,
        cwd: current.cwd,
        model: current.model,
        login: loginMethodOf(runtime.account()),
        agent: current.agent,
        additionalDirectories: current.additionalDirectories,
        settingSources: current.settingSources,
        version: CLAUDE_CODE_VERSION,
      });
    },
    listPermissionRules: async () => {
      const current = live();
      return {
        state: permissionRulesOf({
          fileSettings: effectiveSettingsOf(current),
          trusted: runtime.isTrusted(current.cwd),
          cwd: current.cwd,
          additionalDirectories: current.additionalDirectories,
        }),
      };
    },
    getHooksListing: async () => hooksListingOf(effectiveSettingsOf(live())),
    getSettings: async () => {
      const current = live();
      return settingsOf({
        fileSettings: effectiveSettingsOf(current),
        settingSources: current.settingSources,
        model: current.model,
        effort: current.effort,
      });
    },
    getSkillsDialog: async () => {
      live();
      const skills = COMMANDS.filter((command) => SKILL_NAMES.includes(command.name));
      return skillsDialogOf(skills.map((command) => ({ name: command.name, description: command.description })));
    },
    getSandboxDialog: async () => {
      live();
      return sandboxDialogOf();
    },
    getPlan: async () => {
      live();
      return { exists: false };
    },
    getChromeDialog: async () => chromeDialogOf(live().chrome),
    getMemoryDialog: async () => {
      const current = live();
      return memoryDialogOf({ cwd: current.cwd, home: current.home });
    },
    exportConversation: async () => {
      const current = live();
      const record = store.read(current.sessionId);
      return {
        text: exportTextOf(record?.transcript ?? []),
        default_filename: exportFilenameOf(new Date()),
      };
    },
    getTaskOutput: async (taskId) => {
      const current = live();
      const text = typeof taskId === 'string' ? current.shellOutputs.get(taskId) : undefined;
      if (text === undefined) {
        throw new Error('get_task_output: no shell or Monitor task with that task_id in this session');
      }
      return taskOutputOf(text);
    },
    cancelAsyncMessage: async (uuid) => {
      const current = live();
      if (typeof uuid !== 'string' || uuid === '') throw new TypeError('uuid must be a message uuid.');
      if (!queue.remove(uuid)) return false;
      announceCancelled(current, uuid);
      return true;
    },
    askSideQuestion: async (question, options) => {
      live();
      if (typeof question !== 'string' || question.trim() === '') {
        throw new TypeError('question must be a non-empty string.');
      }
      if (options?.history !== undefined && !Array.isArray(options.history)) {
        throw new TypeError('history must be a list of messages.');
      }
      if (options?.signal?.aborted === true) return null;
      return sideAnswerOf(question);
    },
    setCwd: async (target, options) => {
      const current = live();
      if (typeof target !== 'string' || !isAbsolute(target)) throw new TypeError('cwd must be an absolute path.');
      return changeCwd(current, runtime, resolve(target), options);
    },
    request: async (payload) => {
      const current = live();
      if (!isObject(payload) || typeof payload.subtype !== 'string') throw new TypeError('request needs a subtype.');
      if (payload.subtype !== 'file_suggestions') throw new Error(`Unsupported control request: ${payload.subtype}`);
      if (typeof payload.query !== 'string') throw new TypeError('query must be a string.');
      return {
        subtype: 'success',
        request_id: randomUUID(),
        response: { suggestions: suggestionsOf(current, payload.query), cwd: current.cwd },
      };
    },
    claudeAuthenticate: async (loginWithClaudeAi) => {
      live();
      if (typeof loginWithClaudeAi !== 'boolean') throw new TypeError('loginWithClaudeAi must be a boolean.');
      const flow = runtime.startLogin(loginWithClaudeAi ? 'claudeai' : 'console', owner);
      return { manualUrl: flow.manualUrl, automaticUrl: flow.automaticUrl };
    },
    claudeOAuthCallback: async (authorizationCode, state) => {
      live();
      if (typeof authorizationCode !== 'string' || authorizationCode === ''
        || typeof state !== 'string' || state === '') {
        throw new Error('Invalid code. Please make sure the full code was copied');
      }
      return runtime.completeLogin(authorizationCode, state);
    },
    claudeOAuthWaitForCompletion: async () => {
      live();
      return runtime.waitForLogin();
    },
    mcpAuthenticate: async (serverName, redirectUri) => {
      const current = live();
      const server = current.mcp.get(serverName);
      if (server === undefined) throw new Error(`Server not found: ${serverName}`);
      if (redirectUri !== undefined && typeof redirectUri !== 'string') {
        throw new TypeError('redirectUri must be a string.');
      }
      if (!server.oauth) {
        if (server.transport === 'stdio') {
          throw new Error(`Server type ${server.transport} does not support OAuth authentication`);
        }
        return { requiresUserAction: false, callbackExpected: false };
      }
      if (server.authorized) return { requiresUserAction: false, callbackExpected: false };
      return mcpAuthorizationOf({ serverName, state: mcpFlowOf(current, serverName), redirectUri });
    },
    mcpSubmitOAuthCallbackUrl: async (serverName, callbackUrl) => {
      const current = live();
      const flow = current.mcpFlows.get(serverName);
      if (flow === undefined) throw new Error(`No active OAuth flow for server: ${serverName}`);
      if (typeof callbackUrl !== 'string') throw new TypeError('callbackUrl must be a string.');
      const params = parseAddress(callbackUrl).searchParams;
      if (params.get('state') !== flow.state) throw new Error('The OAuth state does not match this flow.');
      if (!params.get('code')) throw new Error('The callback address carries no authorization code.');
      current.mcpFlows.delete(serverName);
      const server = current.mcp.get(serverName);
      if (server !== undefined) server.authorized = true;
      return {};
    },
    mcpClearAuth: async (serverName) => {
      const current = live();
      const server = current.mcp.get(serverName);
      if (server === undefined) throw new Error(`Server not found: ${serverName}`);
      current.mcpFlows.delete(serverName);
      server.authorized = false;
      return { message: 'Authentication cleared' };
    },
    close: () => {
      close();
    },
  };
}

/**
 * Announces that a queued prompt was cancelled before its turn started.
 * @param {SessionCore} core
 * @param {string} uuid
 * @returns {void}
 */
function announceCancelled(core, uuid) {
  core.outbox.push(commandLifecycle(sessionView(core), uuid, 'cancelled'));
  core.notify();
}

/**
 * The @ index answer. The index warms up after the query starts: until then it answers nothing, as the runtime's does.
 * @param {SessionCore} core
 * @param {string} query
 * @returns {Array<{path: string}>}
 */
function suggestionsOf(core, query) {
  if (Date.now() < core.fileIndexReadyAt) return [];
  return fileSuggestionsOf(core.cwd, query);
}

/**
 * The sign-in an MCP server's authorization runs under: the state of the open flow, or a new one.
 * @param {SessionCore} core
 * @param {string} serverName
 * @returns {string}
 */
function mcpFlowOf(core, serverName) {
  const open = core.mcpFlows.get(serverName);
  if (open !== undefined) return open.state;
  const state = randomUUID();
  core.mcpFlows.set(serverName, { state });
  return state;
}

/**
 * The runtime's set_cwd: the session moves to another folder. A folder Claude Code does not trust answers `needs_trust`
 * until the caller accepts it with the directory that answer named. Accepting records the trust, and the session's
 * transcript moves to the new folder.
 * @param {SessionCore} core
 * @param {RuntimeState} runtime
 * @param {string} dir absolute, resolved
 * @param {{trustAccepted?: boolean, trustedDirectory?: string}} [options]
 * @returns {Record<string, unknown>}
 */
export function changeCwd(core, runtime, dir, options = {}) {
  if (options.trustAccepted === true && options.trustedDirectory === undefined) {
    throw new Error('set_cwd: invalid request — trust_accepted requires trusted_directory '
      + '(echo the directory from the needs_trust response)');
  }
  if (dir === core.cwd) return { status: 'ok', cwd: dir, changed: false, transcript_relocated: false };
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error('set_cwd: the directory does not exist.');
  if (!runtime.isTrusted(dir)) {
    const accepted = options.trustAccepted === true && options.trustedDirectory === dir;
    if (!accepted) return { status: 'needs_trust', directory: dir };
    runtime.trust(dir);
  }
  core.cwd = dir;
  persist(core, (record) => {
    record.cwd = dir;
  });
  return { status: 'ok', cwd: dir, changed: true, transcript_relocated: true };
}

/** @returns {IteratorReturnResult<void>} */
function endOfSession() {
  return { done: true, value: undefined };
}

/**
 * Creates the mock Query for one call of query(). Nothing is opened until the first pull or control call, so open
 * errors (a missing resume target, for example) surface through the iterator, as the SDK reports them.
 * @param {{prompt: string|AsyncIterable<SDKUserMessage>, options?: SdkOptions, store: RecordStore, delayMs: number,
 *   log?: Logger, fileSettings?: Record<string, unknown>, backgroundDisabled?: boolean,
 *   backgroundTiming?: BackgroundTiming, runtime?: RuntimeState}} args `fileSettings` are the settings the user's
 *   files define; `backgroundDisabled` mirrors CLAUDE_CODE_DISABLE_BACKGROUND_TASKS; `runtime` is the trust record,
 *   account and sign-in the queries of one adapter share (a query without one keeps its own, in memory)
 * @returns {SdkQuery & RuntimeControls}
 */
export function createMockQuery({ prompt, options = {}, store, delayMs, log, fileSettings = {},
  backgroundDisabled = false, backgroundTiming = {}, runtime = createRuntimeState() }) {
  validateOptions(options);
  if (typeof prompt !== 'string' && !(isObject(prompt) && typeof prompt[Symbol.asyncIterator] === 'function')) {
    throw new TypeError('prompt must be a string or an async iterable of user messages.');
  }
  if (!Number.isInteger(delayMs) || delayMs < 0) throw new RangeError('delayMs must be a non-negative integer.');
  for (const [name, ms] of Object.entries(backgroundTiming)) {
    if (!Number.isInteger(ms) || ms < 0) {
      throw new RangeError(`backgroundTiming.${name} must be a non-negative integer.`);
    }
  }

  // A query that does not persist its session keeps its record in memory: nothing is written and nothing is listed.
  const recordStore = options.persistSession === false ? createMemoryStore() : store;
  /** The sign-ins this query starts belong to it: closing the query abandons them. */
  const owner = {};
  const queue = new InputQueue();
  /** @type {SessionCore|null} */
  let core = null;
  let closed = false;
  /** @type {AsyncGenerator<SDKMessage, void, unknown>|null} */
  let generator = null;
  /** @type {() => void} */
  let resolveClosed = () => {};
  const closedNow = new Promise((resolveWait) => {
    resolveClosed = () => resolveWait(undefined);
  });

  /** @returns {SessionCore} */
  const open = () => {
    if (core !== null) return core;
    const record = openRecord({ store: recordStore, options, cwd: options.cwd ?? process.cwd(), now: Date.now() });
    const created = createCore({ record, options, store: recordStore, delayMs, log, fileSettings, backgroundDisabled,
      backgroundTiming, runtime });
    core = created;
    const external = options.abortController?.signal;
    if (external !== undefined) {
      if (external.aborted) created.sessionAbort.abort(new SessionClosed());
      else external.addEventListener('abort', () => created.sessionAbort.abort(new SessionClosed()), { once: true });
    }
    const source = typeof prompt === 'string' ? singlePrompt(prompt) : prompt;
    pumpSource(queue, source, created.sessionAbort.signal, (message) => acceptPrompt(created, message))
      .catch((error) => queue.fail(error));
    log?.debug('mock session opened', { sessionId: created.sessionId, resumed: options.resume !== undefined });
    return created;
  };

  /** Ends the query: the session controller aborts, the generator is released and pending pulls finish. */
  const close = () => {
    if (closed) return;
    closed = true;
    core?.sessionAbort.abort(new SessionClosed());
    generator?.return(undefined).catch(() => {});
    resolveClosed();
    runtime.abandonLogin(owner);
  };

  /** @returns {AsyncGenerator<SDKMessage, void, unknown>} */
  const sessionOf = () => {
    if (generator === null) generator = session();
    return generator;
  };

  /** @returns {AsyncGenerator<SDKMessage, void, unknown>} */
  async function* session() {
    if (closed) return;
    yield* sessionLoop(open(), queue, options);
  }

  const controls = createControls({
    open,
    isClosed: () => closed || core?.sessionAbort.signal.aborted === true,
    close,
    queue,
    store: recordStore,
    runtime,
    owner,
  });
  /** @type {SdkQuery & RuntimeControls} */
  const query = {
    ...controls,
    next: () => {
      if (closed) return Promise.resolve(endOfSession());
      return Promise.race([
        sessionOf().next(),
        closedNow.then(() => endOfSession()),
      ]);
    },
    return: async () => {
      close();
      return endOfSession();
    },
    throw: (error) => {
      close();
      return Promise.reject(error);
    },
    [Symbol.asyncIterator]() {
      return query;
    },
  };
  return query;
}
