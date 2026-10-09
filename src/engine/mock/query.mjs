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
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { EFFORT_LEVELS, isUuid, PERMISSION_MODES } from '../../contracts.mjs';
import {
  CONTEXT_MAX_TOKENS,
  interruptedMessage,
  permissionDenied,
  promptSuggestion,
  ScenarioFailure,
  selectScenario,
  stateChanged,
  statusMessage,
  syntheticUser,
  taskNotification,
  toolResult,
  usageOf,
} from './scenarios.mjs';
import { newRecord, sliceRecord } from './store.mjs';

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
/** @typedef {import('./store.mjs').MockStore} MockStore */
/** @typedef {import('./store.mjs').MockSessionRecord} MockSessionRecord */
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

/**
 * One configured MCP server as the mock tracks it.
 * @typedef {{status: 'connected'|'failed'|'needs-auth'|'pending'|'disabled', error?: string, enabled: boolean}} McpEntry
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

export const MODEL_DEFAULT = 'claude-sonnet-mock';
export const CLAUDE_CODE_VERSION = '2.1.295-mock';

/** The tool names the mock advertises in system/init. */
const TOOL_NAMES = ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'TodoWrite', 'Agent',
  'AskUserQuestion', 'ExitPlanMode'];
/** Tools that acceptEdits mode runs without asking. */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const OUTPUT_STYLES = ['default', 'explanatory', 'learning'];
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
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
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
    /** @type {SDKUserMessage[]} */
    this.items = [];
    /** @type {number} */
    this.open = 0;
    /** @type {Array<(result: IteratorResult<SDKUserMessage, void>) => void>} */
    this.takers = [];
  }

  /** @param {SDKUserMessage} message */
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
   * @returns {SDKUserMessage[]}
   */
  drainWaiting() {
    return this.items.splice(0);
  }

  /** @returns {Promise<IteratorResult<SDKUserMessage, void>>} */
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
 * Mutable state shared by the session generator, the scenarios and the control methods.
 * @typedef {Object} SessionCore
 * @property {string} sessionId
 * @property {string} cwd
 * @property {string} model
 * @property {PermissionMode} permissionMode
 * @property {EffortLevel|null} effort
 * @property {string} outputStyle
 * @property {number} delayMs
 * @property {MockStore} store
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
 * @property {Map<string, McpEntry>} mcp
 * @property {Set<string>} dynamicServers           servers set through setMcpServers
 * @property {Map<string, {toolUseId: string, stopped: boolean}>} tasks
 * @property {Set<string>} stoppedToolUseIds        tool_use ids whose task was stopped
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
 * Pumps one prompt source into the queue. The source counts as open until it ends or the session stops.
 * @param {InputQueue} queue
 * @param {AsyncIterable<unknown>} source
 * @param {AbortSignal} signal
 * @returns {Promise<void>}
 */
async function pumpSource(queue, source, signal) {
  queue.attach();
  try {
    for await (const message of source) {
      if (signal.aborted) break;
      if (!isUserMessage(message)) throw new TypeError('The prompt must yield SDK user messages.');
      queue.push(message);
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
    cwd, title } = options;
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
  if (permissionMode !== undefined && !PERMISSION_MODES.some((mode) => mode === permissionMode)) {
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
}

/**
 * Opens the record the query runs on.
 * - new: a record with options.sessionId, or a random UUID.
 * - resume: the stored record with that id; its cwd must match, otherwise the session is not found.
 * - continue: the most recent record of cwd.
 * - forkSession: a new record copied from the source, cut at resumeSessionAt; the source is not changed.
 * - resumeSessionAt without a fork: the stored record is cut at that message, so later turns continue from there.
 * @param {{store: MockStore, options: SdkOptions, cwd: string, now: number}} args
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
 * @type {Record<'message'|'tool'|'agent'|'hook', string>}
 */
const ID_PREFIX = { message: 'msg_mock_', tool: 'toolu_mock_', agent: 'agent_mock_', hook: 'hook_mock_' };

/**
 * Builds the shared state of one session from its stored record.
 * @param {{record: MockSessionRecord, options: SdkOptions, store: MockStore, delayMs: number, log: Logger|undefined}} args
 * @returns {SessionCore}
 */
export function createCore({ record, options, store, delayMs, log }) {
  const { uuid: uuidSequence = 0, ...counters } = record.counters;
  let pending = signalPair();
  /** @type {SessionCore} */
  const core = {
    sessionId: record.sessionId,
    cwd: record.cwd,
    model: typeof options.model === 'string' ? options.model : MODEL_DEFAULT,
    permissionMode: options.permissionMode ?? 'default',
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
    dynamicServers: new Set(),
    mcp: new Map([
      ['github', { status: 'connected', enabled: true }],
      ['filesystem', { status: 'failed', enabled: true, error: 'spawn npx ENOENT' }],
    ]),
    tasks: new Map(),
    stoppedToolUseIds: new Set(),
    closed: false,
  };
  return core;
}

/**
 * The next id of one kind, such as `toolu_mock_3`.
 * @param {SessionCore} core
 * @param {'message'|'tool'|'agent'|'hook'} kind
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
    this.finalText = '';
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
        this.openTools.set(block.id, { parentToolUseId: message.parent_tool_use_id, agentId: message.agent_id ?? null });
      }
      if (topLevel && block.type === 'text') this.finalText = block.text;
    }
    if (topLevel) {
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
 * @property {SDKPermissionDenial[]} denials                  denied tool calls of this turn
 * @property {number} startedAt
 * @property {string} userMessageUuid                         uuid of the last prompt of the turn's batch, as the SDK reports it
 * @property {string[]} userMessageUuids                      uuids of every prompt the turn answers, in consumption order
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
    ...(core.mcp.get('github')?.status === 'connected' ? [{ name: 'MCP tools', tokens: GITHUB_TOOL_TOKENS }] : []),
    { name: 'Messages', tokens: messageTokens },
  ];
  const used = rows.reduce((sum, row) => sum + row.tokens, 0);
  const models = Object.values(core.modelUsage);
  const total = (/** @type {(model: ModelUsage) => number} */ pick) => models.reduce((sum, model) => sum + pick(model), 0);
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
  return { envelope: () => envelopeOf(core), now: () => Date.now(), model: core.model };
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
    return { allowed: true, input };
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
  const suggestions = [{ type: 'addRules', rules: [{ toolName }], behavior: 'allow', destination: 'localSettings' }];
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
  if (decision.behavior === 'allow') return { allowed: true, input: decision.updatedInput ?? input };
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
 * The context one scenario reads for one turn.
 * @param {{core: SessionCore, turn: TurnState, userText: string, streamPartials: boolean}} args
 * @returns {TurnContext}
 */
export function turnContextOf({ core, turn, userText, streamPartials }) {
  return {
    sessionId: core.sessionId,
    cwd: core.cwd,
    model: core.model,
    userText,
    userMessageUuid: turn.userMessageUuid,
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
    mcpConnected: (serverName) => core.mcp.get(serverName)?.status === 'connected',
    describeSession: () => describeSessionOf(core),
  };
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
 * terminal messages, the interruption marker is written and one error result ends the turn.
 * @param {SessionCore} core
 * @param {TurnContext} ctx
 * @param {TurnState} turn
 * @param {TurnObserver} observer
 * @param {TurnStop} stop
 * @param {(message: SDKMessage) => SDKMessage} seen
 * @returns {Generator<SDKMessage, void, unknown>}
 */
export function* closeInterruptedTurn(core, ctx, turn, observer, stop, seen) {
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
  yield seen(syntheticUser(ctx, '[Request interrupted by user]'));
  yield seen(resultOf(core, turn, observer, { error: 'Interrupted', terminalReason: stop.terminalReason }));
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
  const observer = new TurnObserver();
  const text = prompts.map((prompt) => promptText(prompt)).join('\n\n');
  const scenario = selectScenario(text);
  const ctx = turnContextOf({ core, turn, userText: text, streamPartials });
  /** @param {SDKMessage} message */
  const seen = (message) => {
    observer.see(message);
    if (message.type === 'rate_limit_event' && message.rate_limit_info.rateLimitType === 'five_hour' &&
      typeof message.rate_limit_info.utilization === 'number') {
      core.fiveHourUtilization = message.rate_limit_info.utilization * 100;
    }
    if (message.type === 'system' && message.subtype === 'task_started') {
      core.tasks.set(message.task_id, { toolUseId: message.tool_use_id, stopped: false });
    }
    if (message.type === 'system' && message.subtype === 'task_notification') core.tasks.delete(message.task_id);
    persistIfNeeded(core, message);
    return message;
  };
  yield seen(stateChanged(ctx, 'running'));
  try {
    for await (const message of scenario.run(ctx)) {
      const parent = parentToolUseIdOf(message);
      if (parent !== null && core.stoppedToolUseIds.has(parent)) continue;
      yield seen(message);
    }
    addUsage(core, observer);
    core.turnIndex += 1;
    yield seen(resultOf(core, turn, observer, { error: null, terminalReason: null }));
    yield seen(promptSuggestion(ctx, SUGGESTIONS[core.turnIndex % SUGGESTIONS.length]));
  } catch (error) {
    if (error instanceof SessionClosed || core.sessionAbort.signal.aborted) return;
    if (error instanceof TurnStop) {
      addUsage(core, observer);
      core.turnIndex += 1;
      yield* closeInterruptedTurn(core, ctx, turn, observer, error, seen);
    } else if (error instanceof ScenarioFailure) {
      addUsage(core, observer);
      core.turnIndex += 1;
      yield seen(resultOf(core, turn, observer, { error: error.message, terminalReason: 'model_error' }));
    } else {
      throw error;
    }
  } finally {
    core.turnAbort = null;
  }
  yield seen(stateChanged(ctx, 'idle'));
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
  { name: 'compact', description: 'Clear conversation history but keep a summary in context', argumentHint: '<instructions>', builtin: true },
  { name: 'clear', description: 'Clear conversation history and free up context', argumentHint: '', builtin: true },
  { name: 'context', description: 'Show current context usage', argumentHint: '', builtin: true },
  { name: 'usage', description: 'Show session cost, token usage and plan limits', argumentHint: '', builtin: true },
  { name: 'init', description: 'Initialize a new CLAUDE.md file with codebase documentation', argumentHint: '', builtin: true },
  { name: 'review', description: 'Review a pull request', argumentHint: '<pr number>', builtin: true },
  { name: 'code-review', description: 'Review the current changes for bugs and style issues', argumentHint: '<files>' },
  { name: 'verify', description: 'Check that the project builds and its tests pass', argumentHint: '' },
  { name: 'deploy-check', description: 'Check a deployment plan before it ships', argumentHint: '<environment>' },
];

/** The skills the mock advertises (they are commands without the builtin flag). */
const SKILL_NAMES = ['code-review', 'verify', 'deploy-check'];

/** @type {AgentInfo[]} */
export const AGENTS = [
  { name: 'general-purpose', description: 'General-purpose agent for researching complex questions and multi-step tasks' },
  { name: 'Explore', description: 'Fast agent for exploring codebases and answering questions about them' },
  { name: 'Plan', description: 'Software architect agent for designing implementation plans' },
];

/** @type {ModelInfo[]} */
export const MODELS = [
  {
    value: 'default',
    displayName: 'Default (recommended)',
    description: 'Balanced model for everyday coding work',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high'],
  },
  {
    value: 'opus',
    displayName: 'Opus',
    description: 'Most capable model for complex, long-running work',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    value: 'sonnet',
    displayName: 'Sonnet',
    description: 'Fast and capable model for most coding tasks',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high'],
  },
  {
    value: 'haiku',
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
    mcp_servers: [...core.mcp].map(([name, server]) => ({ name, status: server.status })),
    model: core.model,
    permissionMode: core.permissionMode,
    slash_commands: COMMANDS.map((command) => command.name),
    output_style: core.outputStyle,
    skills: [...SKILL_NAMES],
    plugins: [],
    agents: AGENTS.map((agent) => agent.name),
    effort: core.effort,
    capabilities: ['interrupt_receipt_v1'],
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
 * The session generator: init first, then one turn per batch of prompts, until the prompts end or the session closes.
 * A batch is the prompt that was taken plus every prompt already waiting behind it, so prompts sent close together are
 * answered by one turn. Control messages are yielded while the session waits for its next prompt.
 * @param {SessionCore} core
 * @param {InputQueue} queue
 * @param {SdkOptions} options
 * @returns {AsyncGenerator<SDKMessage, void, unknown>}
 */
export async function* sessionLoop(core, queue, options) {
  try {
    yield initMessage(core);
    for (;;) {
      const next = yield* waitFor(core, queue.take(), core.sessionAbort.signal);
      if (next.done === true) break;
      // One macrotask lets the pump deliver the prompts the host already pushed.
      yield* waitFor(core, new Promise((resolveTick) => setImmediate(resolveTick)), core.sessionAbort.signal);
      const batch = [next.value, ...queue.drainWaiting()].map((prompt) => linkedPrompt(core, prompt));
      /** @type {LinkedPrompt[]} */
      const answered = [];
      for (const prompt of batch) {
        persistPrompt(core, prompt);
        if (prompt.shouldQuery !== false) answered.push(prompt);
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

/** The mock MCP servers: github connects, filesystem always fails, as a misconfigured server would. */
const MCP_CONNECTABLE = new Map([['github', true], ['filesystem', false]]);
const MCP_UI_HTML = '<!doctype html><title>Mock resource</title><p>A static resource from the mock MCP server.</p>';

/**
 * The status a server reaches when it is enabled and connected or reconnected.
 * @param {string} name
 * @returns {{status: 'connected'|'failed', error?: string}}
 */
function connectedStatus(name) {
  return MCP_CONNECTABLE.get(name) === true ? { status: 'connected' } : { status: 'failed', error: 'spawn npx ENOENT' };
}

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
 * SDK-shaped status of every configured server.
 * @param {SessionCore} core
 * @returns {McpServerStatus[]}
 */
export function mcpStatusOf(core) {
  return [...core.mcp].map(([name, server]) => ({
    name,
    status: server.status,
    ...(server.error === undefined ? {} : { error: server.error }),
    scope: 'user',
    source: 'user',
    tools: name === 'github' && server.status === 'connected'
      ? [{ name: 'search_issues', description: 'Search issues in the connected repository',
        annotations: { readOnly: true } }]
      : [],
  }));
}

/**
 * Initialization result: the lists a client shows before the first turn.
 * @param {SessionCore} core
 * @returns {SDKControlInitializeResponse}
 */
export function initializationOf(core) {
  return {
    commands: COMMANDS.map((command) => ({ ...command })),
    agents: AGENTS.map((agent) => ({ ...agent })),
    output_style: core.outputStyle,
    available_output_styles: [...OUTPUT_STYLES],
    models: MODELS.map((model) => ({ ...model })),
    account: { email: 'demo@example.com', subscriptionType: 'pro', apiProvider: 'firstParty' },
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
  const githubConnected = core.mcp.get('github')?.status === 'connected';
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
  const sumOf = (/** @type {(model: ModelUsage) => number} */ pick) => totals.reduce((sum, model) => sum + pick(model), 0);
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
 * The /usage data in the SDK's response shape. Rate limits follow the five-hour utilization of the session. The
 * behaviors scan reads real transcripts, so the mock always answers it with null.
 * @param {SessionCore} core
 * @returns {UsageResponse}
 */
export function usageResponseOf(core) {
  const summary = describeSessionOf(core);
  const resetsAt = (/** @type {number} */ hours) => new Date(Date.now() + hours * 3600_000).toISOString();
  return {
    session: {
      total_cost_usd: summary.costUsd,
      total_api_duration_ms: 0,
      total_duration_ms: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
      model_usage: Object.fromEntries(Object.entries(core.modelUsage).map(([model, value]) => [model, { ...value }])),
    },
    subscription_type: 'pro',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: core.fiveHourUtilization, resets_at: resetsAt(1) },
      seven_day: { utilization: 31, resets_at: resetsAt(72) },
    },
    behaviors: null,
  };
}

/**
 * Every Query member except the iterator protocol.
 * @typedef {Omit<SdkQuery, 'next' | 'return' | 'throw' | typeof Symbol.asyncIterator>} ControlMethods
 */

/**
 * Builds the control methods of one query. Each call first checks that the query is open, so a closed query rejects
 * every control call. Methods that change the session queue a status message for the consumer.
 * @param {{open: () => SessionCore, isClosed: () => boolean, close: () => void, queue: InputQueue,
 *   store: MockStore}} deps
 * @returns {ControlMethods}
 */
export function createControls({ open, isClosed, close, queue, store }) {
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
    interrupt: async () => {
      const current = live();
      current.turnAbort?.abort(new TurnStop('aborted_streaming', 'Interrupted by user'));
      return { still_queued: [] };
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
      if (!current.mcp.has(serverName) && !current.dynamicServers.has(serverName)) {
        return { warning: `No MCP server named ${serverName} is known yet.` };
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
      announce(current, current.permissionMode);
    },
    updateSettings: async (source, settings) => {
      const current = live();
      if (source !== 'localSettings' && source !== 'userSettings') throw new TypeError('Unknown settings source.');
      if (!isObject(settings)) throw new TypeError('settings must be an object.');
      for (const [key, value] of Object.entries(settings)) {
        if (typeof value !== 'string') throw new TypeError(`${key} must be a string.`);
      }
      if (source === 'localSettings' && typeof settings.outputStyle === 'string') {
        current.outputStyle = settings.outputStyle;
      }
    },
    initializationResult: async () => initializationOf(live()),
    reinitialize: async () => initializationOf(live()),
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
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => usageResponseOf(live()),
    accountInfo: async () => initializationOf(live()).account,
    readFile: async (path, options) => {
      const current = live();
      if (typeof path !== 'string' || path === '') throw new TypeError('path must be a non-empty string.');
      const absPath = resolve(current.cwd, path);
      const rel = relative(current.cwd, absPath);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
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
      if (typeof path !== 'string' || !Number.isFinite(mtime)) throw new TypeError('seedReadState needs a path and an mtime.');
    },
    reloadPlugins: async (options) => {
      const current = live();
      return {
        commands: COMMANDS.map((command) => ({ ...command })),
        agents: AGENTS.map((agent) => ({ ...agent })),
        plugins: [],
        mcpServers: mcpStatusOf(current),
        error_count: 0,
        ...(options?.holdOnCacheImpact === true ? { held: false } : {}),
      };
    },
    reloadSkills: async () => {
      live();
      return { skills: COMMANDS.filter((command) => SKILL_NAMES.includes(command.name)).map((command) => ({ ...command })) };
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
      const next = connectedStatus(serverName);
      current.mcp.set(serverName, { status: next.status, error: next.error, enabled: true });
    },
    toggleMcpServer: async (serverName, enabled) => {
      const current = live();
      serverOf(current, serverName);
      if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean.');
      current.mcp.set(serverName, enabled
        ? { ...connectedStatus(serverName), enabled: true }
        : { status: 'disabled', enabled: false });
    },
    readMcpResource: async (serverName, uri) => {
      const current = live();
      const server = serverOf(current, serverName);
      if (server.status !== 'connected') throw new Error(`MCP server ${serverName} is not connected.`);
      if (typeof uri !== 'string' || !uri.startsWith('ui://')) throw new TypeError('uri must use the ui:// scheme.');
      return { contents: [{ uri, mimeType: 'text/html', text: MCP_UI_HTML }] };
    },
    setMcpServers: async (servers) => {
      const current = live();
      if (!isObject(servers)) throw new TypeError('servers must be an object.');
      const names = Object.keys(servers);
      const added = names.filter((name) => !current.dynamicServers.has(name));
      const removed = [...current.dynamicServers].filter((name) => !Object.hasOwn(servers, name));
      current.dynamicServers = new Set(names);
      return { added, removed, errors: {} };
    },
    streamInput: async (stream) => {
      const current = live();
      if (!isObject(stream) || typeof stream[Symbol.asyncIterator] !== 'function') {
        throw new TypeError('streamInput needs an async iterable of user messages.');
      }
      await pumpSource(queue, stream, current.sessionAbort.signal);
    },
    stopTask: async (taskId) => {
      const current = live();
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
      live();
      if (toolUseId !== undefined && typeof toolUseId !== 'string') throw new TypeError('toolUseId must be a string.');
      return false;
    },
    close: () => {
      close();
    },
  };
}

/** @returns {IteratorReturnResult<void>} */
function endOfSession() {
  return { done: true, value: undefined };
}

/**
 * Creates the mock Query for one call of query(). Nothing is opened until the first pull or control call, so open
 * errors (a missing resume target, for example) surface through the iterator, as the SDK reports them.
 * @param {{prompt: string|AsyncIterable<SDKUserMessage>, options?: SdkOptions, store: MockStore, delayMs: number,
 *   log?: Logger}} args
 * @returns {SdkQuery}
 */
export function createMockQuery({ prompt, options = {}, store, delayMs, log }) {
  validateOptions(options);
  if (typeof prompt !== 'string' && !(isObject(prompt) && typeof prompt[Symbol.asyncIterator] === 'function')) {
    throw new TypeError('prompt must be a string or an async iterable of user messages.');
  }
  if (!Number.isInteger(delayMs) || delayMs < 0) throw new RangeError('delayMs must be a non-negative integer.');

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
    const record = openRecord({ store, options, cwd: options.cwd ?? process.cwd(), now: Date.now() });
    const created = createCore({ record, options, store, delayMs, log });
    core = created;
    const external = options.abortController?.signal;
    if (external !== undefined) {
      if (external.aborted) created.sessionAbort.abort(new SessionClosed());
      else external.addEventListener('abort', () => created.sessionAbort.abort(new SessionClosed()), { once: true });
    }
    const source = typeof prompt === 'string' ? singlePrompt(prompt) : prompt;
    pumpSource(queue, source, created.sessionAbort.signal).catch((error) => queue.fail(error));
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
    store,
  });
  /** @type {SdkQuery} */
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
