/**
 * Pure timeline reducer: transcript messages + live SDK messages -> render model.
 * No DOM access. Its only import is the pure ANSI helper in ./format.js, so it runs unchanged in Node
 * (see test/unit/timeline-model.test.mjs).
 *
 * getEntries() returns the entries in display order. Every entry has a stable `key` and a numeric `version` that
 * changes whenever the entry (or a part the view renders) changes:
 *
 *  - user:           { key, uuid, clientMessageId, text, images: [{mediaType, data}], attachments: [{path, name, kind,
 *                      mediaType}], status: 'sending'|'sent'|'queued'|'failed', accepted, local, synthetic, error }
 *                      'sending' until the gateway accepts the message, then 'sent' (uuid = clientMessageId). 'queued'
 *                      while it waits behind a running turn; such messages sit in a list at the end of the timeline and
 *                      start the next turn when the running one closes. 'failed' keeps the error for a Retry.
 *  - assistant:      { uuid, messageId, blocks, streaming, error, aborted }
 *                      block = {key, kind:'text', text} | {key, kind:'thinking', text, redacted}
 *                            | {key, kind:'generic', raw, label}
 *                      streaming drafts may also contain {key, kind:'tool-draft', name, partial}
 *  - work:           { label, count, items, open, running }   (a run of tool cards and progress rows)
 *                      tool item = {kind:'tool', key, id, name, input, result: {content, isError, images}|null,
 *                                   structured, children (Entry[]|undefined), running, pendingRequestId,
 *                                   elapsedSeconds, messageUuid, resultUuid}
 *                      row item  = {kind:'row', key, rowKind:'hook'|'task'|'denied'|'notice'|'withdrawn', ...fields}
 *  - withdrawn:      { key, uuid }   (a retracted response, shown as one muted "Response withdrawn" row)
 *  - notice:         { level:'info'|'warning'|'error'|'muted', code, text, vars }
 *  - divider:        { variant:'compact'|'clear'|'compacting', preTokens, postTokens, durationMs, trigger, since }
 *                      'compacting' is the live row of a compaction in progress (since: epoch ms, null when the status
 *                      was replayed without a time); the boundary turns that same entry into 'compact' in place. A
 *                      status that ends the compaction without a boundary drops the row. A 'compact' divider with null
 *                      sizes is one the summary added (see addSummary); the view fills its sizes from the session
 *  - command-output: { text }
 *  - result:         { subtype, durationMs, durationApiMs, numTurns, isError, interrupted, errors,
 *                      permissionDenials: [{toolName}], terminalReason, totalCostUsd }
 *  - request:        { request }   (PendingRequest, placed after the active turn; it shows only once it has waited for
 *                      the user for the attention delay, see addPending and settlePending)
 *  - auto:           { requestKind, toolName, input, serverName, questionText }   (a request the gateway answered on
 *                      its own in unattended mode: one muted record, no buttons)
 *  - generic:        { label, raw, diagnostic: true }   (unknown message types or subtypes, kept for diagnostics;
 *                      the view shows them only while the runtime-events preference is on)
 *
 * Inputs are kept in an operation log, so an older transcript page can be prepended (prependTranscript) and the
 * state rebuilt. Pending requests and the session state are applied on top of the replayed state.
 */

import { stripAnsi } from './format.js';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const BASE64_RE = /^[A-Za-z0-9+/=\s]+$/;
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const ACTIVE_STATES = new Set(['starting', 'running', 'requires_action']);
/**
 * The states in which the session runs a message. 'starting' only opens the query: a session resumed by its first
 * message reports 'idle' once Claude Code is ready, before it takes the message, then 'running'.
 */
const RUNNING_STATES = new Set(['running', 'requires_action']);
const INACTIVE_STATES = new Set(['idle', 'closing', 'error', 'closed', 'stopped']);
const HOOK_TEXT_LIMIT = 4000;
const REMINDER_RE = /<system-reminder>([\s\S]*?)<\/system-reminder>/g;
const STDOUT_RE = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/;
const COMMAND_NAME_RE = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;
/** Synthetic user texts the SDK writes when the user stops a turn; they show as notices, not as prompts. */
const INTERRUPT_NOTICES = new Map([
  ['[Request interrupted by user]', 'interrupted'],
  ['[Request interrupted by user for tool use]', 'interrupted-tool'],
]);
/** The sizes of a compaction divider that has none (a summary with no boundary before it). */
const NO_SIZES = Object.freeze({ trigger: null, preTokens: null, postTokens: null, durationMs: null });

/**
 * @typedef {Object} Turn   state shared by a turn's main flow and the child flows of its subagents
 * @property {boolean} live        set once live (non-transcript) activity was seen for the turn
 * @property {boolean} closed      set by a result, an inactive session state or a conversation reset
 * @property {boolean} sendPending set while a message sent from this browser waits for the session to report running
 * @property {Flow|null} main
 * @property {number|null} startedAt   epoch ms of the turn's first event (its first live message or its local send)
 * @property {Map<string, number>} tokens  output tokens of each main-thread message of the turn, by message id
 */

/**
 * @typedef {Object} Flow   an ordered list of entries: a turn's main content, or the children of a subagent card
 * @property {Array<Object>} entries
 * @property {Object|null} owner   tool item that owns this flow (subagent flows), else null
 * @property {Flow|null} parent
 * @property {Turn} state
 */

/**
 * @typedef {Object} ToolResult
 * @property {string} content
 * @property {boolean} isError
 * @property {Array<{mediaType: string, data: string}>} images
 */

/**
 * The snapshot's live events that a load replays after the transcript page. The transcript of a compacted session
 * starts at its last compaction (getSessionMessages returns the chain from that boundary, a system record without its
 * subtype), while the snapshot still holds the events of the whole query. The events before the snapshot's copy of
 * that boundary belong to the conversation the compaction replaced, so they are left out; otherwise every event is
 * replayed.
 * @template {{msg?: unknown}} T
 * @param {T[]|null|undefined} events the snapshot's liveEvents, oldest first
 * @param {{messages?: unknown, start?: unknown}|null|undefined} page the transcript page the load shows
 * @returns {T[]}
 */
export function replayedEvents(events, page) {
  const list = Array.isArray(events) ? events : [];
  const messages = Array.isArray(page?.messages) ? page.messages : [];
  const first = page?.start === 0 ? messages[0] : null;
  if (!first || first.type !== 'system' || typeof first.uuid !== 'string') return list;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const msg = /** @type {{uuid?: unknown}|null|undefined} */ (list[index]?.msg);
    if (msg?.uuid === first.uuid) return list.slice(index);
  }
  return list;
}

/**
 * Creates an independent timeline model.
 * @returns {{
 *   loadTranscript: (messages: Array<Record<string, any>>) => void,
 *   prependTranscript: (messages: Array<Record<string, any>>) => void,
 *   applyLiveEvent: (msg: Record<string, any>, time?: number|null) => void,
 *   addOptimistic: (message: {clientMessageId: string, text: string, attachments?: unknown}) => void,
 *   markAccepted: (clientMessageId: string) => void,
 *   markFailed: (clientMessageId: string, error: unknown) => void,
 *   discardOptimistic: (clientMessageId: string) => void,
 *   applyNotice: (notice: {code: string, level?: string, text?: string}) => void,
 *   setPending: (requests: Array<Record<string, any>>) => void,
 *   addPending: (request: Record<string, any>) => boolean,
 *   settlePending: (requestId: string) => void,
 *   resolvePending: (requestId: string, options?: {auto?: boolean}) => void,
 *   setSessionState: (state: string|null) => void,
 *   getEntries: () => Array<Record<string, any>>,
 *   getVersion: () => number,
 *   getUserMessages: () => Array<{uuid: string, text: string, index: number}>,
 *   getPendingUserMessages: () => Array<{clientMessageId: string, text: string,
 *     attachments: Array<Record<string, any>>, accepted: boolean, status: string, error: string|null}>,
 *   getRunState: () => {running: boolean, status: string|null, compactResult: string|null, activity: string|null,
 *     compactingSince: number|null}
 * }}
 */
export function createModel({ now = Date.now, describeTool = null } = {}) {
  /** @type {Array<{op: string, [key: string]: any}>} */
  let log = [];
  let counter = 0;
  let seq = 0;
  /** Time of the operation being applied (epoch ms), so a replay keeps the times the live events had. */
  let eventTime = 0;

  /** @type {Flow[]} */
  let turns = [];
  /** @type {Flow|null} */
  let current = null;
  /** @type {Flow|null} the turn the SDK message being applied names through its user message uuid(s), else null */
  let named = null;
  /** @type {{messageId: string, blocks: Array<Record<string, any>|undefined>, finalized: number, stopped: boolean,
   *   version: number, settled: Set<string>}|null} */
  let draft = null;
  /** @type {Map<string, Record<string, any>>} */
  let toolIndex = new Map();
  /** @type {Map<Object, Flow>} */
  let containerOf = new Map();
  /** @type {Map<Object, Record<string, any>>} */
  let groupOf = new Map();
  /** @type {Map<Object, Flow>} */
  let childFlowOf = new Map();
  /** @type {Set<string>} tool_use ids of the requests unattended mode answered */
  let autoAnswered = new Set();
  /** @type {Map<string, Record<string, any>>} */
  let rowIndex = new Map();
  /** @type {Map<string, Flow>} */
  let flowOfUuid = new Map();
  /** @type {Set<string>} the uuid of every transcript record, shown or not (a replayed boundary is checked here) */
  let transcriptUuids = new Set();
  /** @type {Map<string, number>} */
  let bubbleCount = new Map();
  /** @type {Map<string, Array<{raw: any, live: boolean}>>} */
  let orphans = new Map();
  /** @type {Map<string, ToolResult & {structured?: unknown, uuid?: string|null}>} */
  let pendingResults = new Map();
  /** @type {Array<Record<string, any>>} local user messages that wait behind a running turn, oldest first */
  let queued = [];
  /** @type {Array<Record<string, any>>} local user messages not yet pruned, oldest first */
  let locals = [];
  /** @type {Map<string, Record<string, any>>} user entries by clientMessageId and by uuid */
  let userEntries = new Map();
  let runStatus = { status: null, compactResult: null };
  /** @type {{entry: Record<string, any>, flow: Flow}|null} the compaction in progress and the row that shows it */
  let compacting = null;
  /** Set by a main-thread compact_boundary: the next main-thread user message may be the summary it leaves. */
  let summaryDue = false;
  /** @type {string|null} the runtime's one-line activity for the running turn (system/task_summary) */
  let activity = null;
  /** @type {Array<{request: Record<string, any>, version: number}>} */
  let pending = [];
  /**
   * Requests the model was told about and that are not resolved yet, by id (a resolution may arrive after the list
   * changed).
   */
  /** @type {Map<string, Record<string, any>>} */
  let known = new Map();
  /**
   * Requests the model was told about that have not waited for the user for the attention delay (addPending), by id.
   * @type {Map<string, Record<string, any>>}
   */
  let arriving = new Map();
  /** @type {string|null} */
  let sessionState = null;

  /** @param {Object} obj */
  const touch = (obj) => {
    counter += 1;
    obj.version = counter;
  };

  /** Records a structural change (an entry added or removed) that no single object's version covers. */
  const bump = () => {
    counter += 1;
  };

  /**
   * @param {Object} obj @param {string} field @param {unknown} value
   * @returns {boolean} true when the value changed
   */
  const setField = (obj, field, value) => {
    if (obj[field] === value) return false;
    obj[field] = value;
    touch(obj);
    return true;
  };

  /** @param {string} prefix @param {string|null} uuid */
  const nextKey = (prefix, uuid) => {
    seq += 1;
    return uuid ? `${prefix}:${uuid}` : `${prefix}#${seq}`;
  };

  /** @param {unknown} value @returns {value is Record<string, any>} */
  const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

  /** @param {Record<string, any>} raw @returns {boolean} true for a message of the main thread, not of a subagent */
  const isMainThread = (raw) => !(typeof raw.parent_tool_use_id === 'string' && raw.parent_tool_use_id);

  /** @param {Record<string, any>} raw @returns {boolean} true for the boundary that ends a compaction */
  const isBoundary = (raw) => raw.type === 'system' && raw.subtype === 'compact_boundary';

  /** @param {...unknown} values @returns {number|null} the first finite number among the values */
  const firstNumber = (...values) => values.find((value) => Number.isFinite(value)) ?? null;

  /** @param {unknown} content @returns {Array<Record<string, any>>} */
  const normalizeContent = (content) => {
    if (typeof content === 'string') return [{ type: 'text', text: content }];
    if (!Array.isArray(content)) return [];
    return content.filter((block) => isObject(block));
  };

  /** @param {Record<string, any>} block @returns {{mediaType: string, data: string}|null} */
  const imageFrom = (block) => {
    const source = block.source;
    if (!isObject(source) || source.type !== 'base64') return null;
    const mediaType = String(source.media_type ?? '');
    const data = typeof source.data === 'string' ? source.data : '';
    if (!IMAGE_TYPES.has(mediaType) || !data || !BASE64_RE.test(data)) return null;
    return { mediaType, data: data.replace(/\s+/g, '') };
  };

  /** @param {unknown} attachments */
  const normalizeAttachments = (attachments) => {
    if (!Array.isArray(attachments)) return [];
    const out = [];
    for (const item of attachments) {
      if (!isObject(item) || typeof item.path !== 'string') continue;
      const fallback = item.path.split(/[\\/]/).pop() || item.path;
      out.push({
        path: item.path,
        name: typeof item.name === 'string' && item.name ? item.name : fallback,
        kind: item.kind === 'image' ? 'image' : 'file',
        mediaType: typeof item.mediaType === 'string' ? item.mediaType : '',
      });
    }
    return out;
  };

  /** @param {Record<string, any>} block @returns {ToolResult} */
  const toolResultFrom = (block) => {
    const images = [];
    let content = '';
    if (typeof block.content === 'string') {
      content = block.content;
    } else if (Array.isArray(block.content)) {
      const parts = [];
      for (const part of block.content) {
        if (!isObject(part)) continue;
        if (part.type === 'text' && typeof part.text === 'string') {
          parts.push(part.text);
        } else if (part.type === 'image') {
          const image = imageFrom(part);
          if (image) images.push(image);
          else parts.push('[image]');
        } else if (typeof part.type === 'string') {
          parts.push(`[${part.type}]`);
        }
      }
      content = parts.join('\n');
    }
    return { content, isError: block.is_error === true, images };
  };

  /** @param {Record<string, any>} block */
  const webSearchResultFrom = (block) => {
    const body = block.content;
    if (isObject(body) && body.type === 'web_search_tool_result_error') {
      return {
        result: { content: String(body.error_code ?? 'error'), isError: true, images: [] },
        structured: undefined,
      };
    }
    const hits = Array.isArray(body) ? body.filter((hit) => isObject(hit)) : [];
    const content = hits.map((hit) => `${String(hit.title ?? '')}\n${String(hit.url ?? '')}`).join('\n\n');
    const structured = {
      results: [{
        tool_use_id: String(block.tool_use_id ?? ''),
        content: hits.map((hit) => ({ title: String(hit.title ?? ''), url: String(hit.url ?? '') })),
      }],
    };
    return { result: { content, isError: false, images: [] }, structured };
  };

  /** @param {unknown} error */
  const errorText = (error) => {
    if (typeof error === 'string') return error;
    if (isObject(error) && typeof error.message === 'string') return error.message;
    return error == null ? '' : String(error);
  };

  /** @param {string} text @param {boolean} [innerOnly] */
  const stripReminders = (text, innerOnly = false) => {
    const bodies = [];
    const rest = String(text ?? '').replace(REMINDER_RE, (_match, inner) => {
      bodies.push(String(inner).trim());
      return '';
    }).trim();
    return innerOnly ? bodies.join('\n\n') : rest;
  };

  /** @param {unknown} level */
  const mapInformationalLevel = (level) => {
    if (level === 'warning') return 'warning';
    if (level === 'notice') return 'muted';
    return 'info';
  };

  // ---------------------------------------------------------------------------------------------------------------
  // Turn and flow state

  /** @returns {Flow} */
  const newTurn = () => {
    /** @type {Turn} */
    const state = { live: false, closed: false, sendPending: false, main: null, startedAt: null, tokens: new Map() };
    /** @type {Flow} */
    const flow = { entries: [], owner: null, parent: null, state };
    state.main = flow;
    turns.push(flow);
    current = flow;
    return flow;
  };

  /** @returns {Flow} the turn the message being applied names, else the current turn, starting one when none exists */
  const baseFlow = () => named ?? current ?? newTurn();

  /**
   * The turn live activity goes to: the turn the message names, else the current turn while it is open. A closed turn
   * hands over to the next open turn of the timeline (a snapshot can hold turns the transcript already has), and only
   * when there is none does a new turn start.
   * @returns {Flow}
   */
  const liveFlow = () => {
    if (named) return named;
    if (current && !current.state.closed) return current;
    const index = current ? turns.indexOf(current) : -1;
    const next = index < 0 ? undefined : turns.slice(index + 1).find((flow) => !flow.state.closed);
    if (next) {
      current = next;
      return next;
    }
    return newTurn();
  };

  /**
   * The turn an SDK message names through its user message uuids. The list comes first, in consumption order: a batch
   * of messages merged into one turn lists all of them, and user_message_uuid names the last one. Null when none of
   * the named user messages is in the timeline yet.
   * @param {Record<string, any>} raw
   * @returns {Flow|null}
   */
  const namedTurn = (raw) => {
    const listed = Array.isArray(raw.user_message_uuids) ? raw.user_message_uuids : [];
    for (const id of [...listed, raw.user_message_uuid]) {
      const entry = typeof id === 'string' ? userEntries.get(id) : undefined;
      const flow = entry ? containerOf.get(entry) : undefined;
      if (flow) return flow.state.main ?? flow;
    }
    return null;
  };

  /** @param {Flow} flow @returns {boolean} */
  const flowOpen = (flow) => {
    if (!flow.owner) return flow.state.live && !flow.state.closed;
    if (flow.owner.result) return false;
    return flow.parent ? flowOpen(flow.parent) : false;
  };

  /**
   * Keeps a group's count and running flag in step with its tools.
   * @param {Record<string, any>} group
   * @returns {boolean} true when either changed
   */
  const refreshGroup = (group) => {
    const tools = group.items.filter((item) => item.kind === 'tool');
    const counted = setField(group, 'count', tools.length);
    const ran = setField(group, 'running', tools.some((item) => item.running));
    return counted || ran;
  };

  /**
   * A change inside a subagent's flow shows on its card. Every owner up the chain is touched, with the work group that
   * holds it, so the keyed render rebuilds those cards. A top-level flow has no owner and touches nothing.
   * @param {Flow} flow
   */
  const touchOwners = (flow) => {
    let owner = flow.owner;
    while (owner) {
      touch(owner);
      const group = groupOf.get(owner);
      if (group) touch(group);
      const holder = containerOf.get(owner);
      owner = holder ? holder.owner : null;
    }
  };

  /** @param {Flow} flow */
  const syncFlow = (flow) => {
    const open = flowOpen(flow);
    let changed = false;
    for (const entry of flow.entries) {
      if (entry.kind !== 'work') continue;
      for (const item of entry.items) {
        if (item.kind !== 'tool') continue;
        if (setField(item, 'running', item.result == null && open)) {
          // The group header counts running tools, so the group shows the change too.
          touch(entry);
          changed = true;
        }
        const child = childFlowOf.get(item);
        if (child) syncFlow(child);
      }
      if (setField(entry, 'open', open)) changed = true;
      if (refreshGroup(entry)) changed = true;
    }
    if (changed) touchOwners(flow);
  };

  /** @param {Turn} state */
  const markLive = (state) => {
    if (state.live) return;
    state.live = true;
    state.sendPending = false;
    if (state.startedAt === null) state.startedAt = eventTime || now();
    if (state.main) syncFlow(state.main);
  };

  /**
   * Removes an entry from a flow. A structural change, so the model's version moves on.
   * @param {Flow} flow
   * @param {Record<string, any>} entry
   */
  const dropEntry = (flow, entry) => {
    const index = flow.entries.indexOf(entry);
    if (index < 0) return;
    flow.entries.splice(index, 1);
    bump();
    touchOwners(flow);
  };

  /**
   * The live compaction starts as one row at the end of the turn; a repeated status shows the same row. The row starts
   * at the time the status arrived, or with no start when the status was replayed without a time. Returns the flow the
   * row sits in.
   * @param {string|null} uuid
   * @returns {Flow}
   */
  const startCompacting = (uuid) => {
    const flow = liveFlow();
    markLive(flow.state);
    if (!compacting) {
      const entry = pushEntry(flow, {
        kind: 'divider', key: nextKey('cmp', uuid), variant: 'compacting', since: eventTime || null,
        trigger: null, preTokens: null, postTokens: null, durationMs: null,
      });
      compacting = { entry, flow };
    }
    return flow;
  };

  /**
   * The boundary of a compaction turns its row into the divider, in place (same key, so the view keeps the position).
   * @param {{trigger: string|null, preTokens: number|null, postTokens: number|null, durationMs: number|null}} details
   * @returns {Flow|null} the flow of the row, or null when no row waits for a boundary
   */
  const settleCompacting = (details) => {
    if (!compacting) return null;
    const { entry, flow } = compacting;
    compacting = null;
    Object.assign(entry, details, { variant: 'compact' });
    touch(entry);
    touchOwners(flow);
    return flow;
  };

  /** The status says the compaction is over and no boundary turned the row into a divider: the row goes. */
  const endCompacting = () => {
    if (!compacting) return;
    const { entry, flow } = compacting;
    compacting = null;
    dropEntry(flow, entry);
  };

  /**
   * Ends a turn, then starts the messages that waited behind it, in order. A turn ended by its result hands them to the
   * SDK, which runs them next; a turn ended by an idle session only moves them into the timeline.
   * @param {Turn} state
   * @param {boolean} [sessionIdle]
   */
  const closeTurn = (state, sessionIdle = false) => {
    if (state.closed) return;
    state.closed = true;
    state.sendPending = false;
    activity = null;
    // A compaction belongs to the turn it runs in; when the turn ends, its row cannot still be waiting.
    if (compacting && compacting.flow.state === state) endCompacting();
    if (state.main) {
      syncFlow(state.main);
      pruneLocals(state.main);
    }
    startQueued(!sessionIdle);
  };

  const clearDraft = () => {
    draft = null;
  };

  const maybeClearDraft = () => {
    if (draft && draft.stopped && draft.finalized >= draft.blocks.length) draft = null;
  };

  // ---------------------------------------------------------------------------------------------------------------
  // Entry construction

  /** @param {Flow} flow @param {Record<string, any>} entry */
  const pushEntry = (flow, entry) => {
    touch(entry);
    flow.entries.push(entry);
    touchOwners(flow);
    return entry;
  };

  /** @param {Flow} flow @param {Record<string, any>} item */
  const appendWorkItem = (flow, item) => {
    const last = flow.entries[flow.entries.length - 1];
    let group = last && last.kind === 'work' ? last : null;
    if (!group) {
      group = pushEntry(flow, {
        kind: 'work', key: `w:${item.key}`, label: null, count: 0, items: [], open: false, running: false,
      });
    }
    group.items.push(item);
    containerOf.set(item, flow);
    groupOf.set(item, group);
    if (item.kind === 'tool') setField(item, 'running', item.result == null && flowOpen(flow));
    setField(group, 'open', flowOpen(flow));
    refreshGroup(group);
    // The group's items changed; its count and flags may not have, so its version is bumped here.
    touch(group);
    touchOwners(flow);
    return group;
  };

  /** @param {Record<string, any>} owner @returns {Flow} */
  const ensureChildFlow = (owner) => {
    const existing = childFlowOf.get(owner);
    if (existing) return existing;
    const parent = containerOf.get(owner) ?? baseFlow();
    /** @type {Flow} */
    const child = { entries: [], owner, parent, state: parent.state };
    childFlowOf.set(owner, child);
    owner.children = child.entries;
    touch(owner);
    return child;
  };

  /** @param {string} id @returns {string|null} */
  const pendingRequestFor = (id) => {
    const match = pending.find((entry) => entry.request.toolUseId === id);
    return match ? match.request.id : null;
  };

  /**
   * Creates the tool card for a tool_use block, or returns the one already known for that id.
   * @param {Flow} flow
   * @param {{id: string, name: string, input: unknown, messageUuid?: string|null}} spec
   */
  const addTool = (flow, spec) => {
    const id = spec.id || nextKey('tool', null);
    const existing = toolIndex.get(id);
    if (existing) return existing;
    const item = {
      kind: 'tool',
      key: `t:${id}`,
      id,
      name: spec.name || 'tool',
      input: isObject(spec.input) ? spec.input : {},
      result: null,
      structured: undefined,
      children: undefined,
      running: false,
      pendingRequestId: pendingRequestFor(id),
      elapsedSeconds: undefined,
      messageUuid: spec.messageUuid ?? null,
      resultUuid: null,
      version: 0,
    };
    touch(item);
    toolIndex.set(id, item);
    appendWorkItem(flow, item);
    if (AGENT_TOOLS.has(item.name)) ensureChildFlow(item);
    if (pendingResults.has(id)) {
      const queued = pendingResults.get(id);
      pendingResults.delete(id);
      applyResult(item, queued, queued.structured, queued.uuid);
    }
    drainOrphans(id);
    return item;
  };

  /**
   * @param {Record<string, any>} item
   * @param {ToolResult} result
   * @param {unknown} [structured]
   * @param {string|null} [uuid] the message that carried the result
   */
  const applyResult = (item, result, structured, uuid = null) => {
    if (item.result) return;
    item.result = { content: result.content, isError: result.isError, images: result.images ?? [] };
    item.resultUuid = typeof uuid === 'string' ? uuid : null;
    if (structured !== undefined) item.structured = structured;
    touch(item);
    setField(item, 'running', false);
    const group = groupOf.get(item);
    if (group) {
      refreshGroup(group);
      touch(group);
    }
    const holder = containerOf.get(item);
    if (holder) touchOwners(holder);
    const child = childFlowOf.get(item);
    if (child) syncFlow(child);
  };

  /** @param {string} id @param {ToolResult} result @param {unknown} [structured] @param {string|null} [uuid] */
  const deliverResult = (id, result, structured, uuid = null) => {
    const item = toolIndex.get(id);
    if (item) applyResult(item, result, structured, uuid);
    else pendingResults.set(id, Object.assign({}, result, { structured, uuid }));
  };

  /** @param {string} id */
  const drainOrphans = (id) => {
    const list = orphans.get(id);
    if (!list) return;
    orphans.delete(id);
    for (const entry of list) guard(() => ingest(entry.raw, entry.live), entry.raw, entry.live);
  };

  /**
   * Creates or updates a progress row inside a work group.
   * @param {Flow} flow
   * @param {string} key
   * @param {Record<string, any>} fields
   */
  const upsertRow = (flow, key, fields) => {
    const existing = rowIndex.get(key);
    if (existing) {
      Object.assign(existing, fields);
      touch(existing);
      const group = groupOf.get(existing);
      if (group) touch(group);
      const holder = containerOf.get(existing);
      if (holder) touchOwners(holder);
      return existing;
    }
    const row = Object.assign({ kind: 'row', key }, fields);
    rowIndex.set(key, row);
    touch(row);
    appendWorkItem(flow, row);
    return row;
  };

  /**
   * Routes a message to the main turn, or to the children of the subagent card that produced it. Messages whose card
   * has not arrived yet are buffered and replayed when it does.
   * @param {Record<string, any>} raw
   * @param {boolean} live
   * @returns {Flow|null}
   */
  const resolveFlow = (raw, live) => {
    const parentId = raw.parent_tool_use_id;
    if (typeof parentId === 'string' && parentId) {
      const owner = toolIndex.get(parentId);
      if (!owner) {
        const list = orphans.get(parentId) ?? [];
        list.push({ raw, live });
        orphans.set(parentId, list);
        return null;
      }
      return ensureChildFlow(owner);
    }
    return live ? liveFlow() : baseFlow();
  };

  /**
   * @param {Flow} flow
   * @param {string} level
   * @param {string} code
   * @param {Record<string, any>} vars
   * @param {string} text
   * @param {string|null} key
   */
  const addNotice = (flow, level, code, vars, text, key) => {
    pushEntry(flow, { kind: 'notice', key: key ?? nextKey('n', null), level, code, text, vars });
    return flow;
  };

  /**
   * A notice the gateway raises outside the SDK stream (for example ENGINE_UNAVAILABLE). It lands in the open turn, or
   * starts one. The same notice right after itself is not added twice.
   * @param {{code: string, level: string, text: string}} notice
   */
  const addInlineNotice = ({ code, level, text }) => {
    const flow = liveFlow();
    const last = flow.entries[flow.entries.length - 1];
    if (last && last.kind === 'notice' && last.code === code && last.text === text) return;
    addNotice(flow, level, code, {}, text, null);
  };

  /**
   * A request the gateway answered on its own (unattended mode: request_resolved with auto). It leaves one muted record
   * in the flow of the tool it belongs to, else in the live turn. A record never has buttons.
   * @param {Record<string, any>} request
   */
  const addAutoEntry = (request) => {
    if (typeof request.toolUseId === 'string' && request.toolUseId) autoAnswered.add(request.toolUseId);
    const tool = typeof request.toolUseId === 'string' ? toolIndex.get(request.toolUseId) : undefined;
    const flow = (tool && containerOf.get(tool)) || liveFlow();
    const server = isObject(request.mcpServer) ? request.mcpServer : {};
    const elicitation = isObject(request.elicitation) ? request.elicitation : {};
    const serverName = [server.name, elicitation.serverName].find((name) => typeof name === 'string' && name) ?? '';
    const questions = isObject(request.input) && Array.isArray(request.input.questions) ? request.input.questions : [];
    const questionText = questions
      .map((question) => (isObject(question) && typeof question.question === 'string' ? question.question : ''))
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 2000);
    pushEntry(flow, {
      kind: 'auto',
      key: `a:${request.id}`,
      requestKind: typeof request.kind === 'string' ? request.kind : 'unknown',
      toolName: typeof request.toolName === 'string' ? request.toolName : (tool?.name ?? ''),
      input: isObject(request.input) ? request.input : {},
      serverName,
      questionText,
    });
  };

  /** @param {any} raw @param {boolean} live @param {string|null} label @returns {Flow} */
  const addGeneric = (raw, live, label) => {
    const flow = live ? liveFlow() : baseFlow();
    const uuid = isObject(raw) && typeof raw.uuid === 'string' ? raw.uuid : null;
    let text = label;
    if (!text && isObject(raw)) {
      text = typeof raw.type === 'string' ? raw.type : 'unknown';
      if (typeof raw.subtype === 'string') text += `/${raw.subtype}`;
    }
    pushEntry(flow, { kind: 'generic', key: nextKey('g', uuid), label: text || 'unknown', raw, diagnostic: true });
    return flow;
  };

  /**
   * The summary a compaction leaves in place of the conversation: one muted note under its own name, after the divider
   * of its compaction. A summary with no divider before it (a transcript that starts at a compaction, or a stream that
   * dropped the boundary) gets a plain one. A compaction still waiting for its boundary turns its row into that plain
   * divider, because the summary says the compaction is over.
   * @param {boolean} live
   * @param {string} text
   * @param {string|null} uuid
   * @returns {Flow}
   */
  const addSummary = (live, text, uuid) => {
    const waiting = compacting ? settleCompacting(NO_SIZES) : null;
    const flow = waiting ?? (live ? liveFlow() : baseFlow());
    const last = flow.entries[flow.entries.length - 1];
    if (!last || last.kind !== 'divider' || last.variant !== 'compact') {
      pushEntry(flow, { kind: 'divider', key: nextKey('dv', uuid), variant: 'compact', ...NO_SIZES });
    }
    return addNotice(flow, 'muted', 'compact-summary', {}, text, nextKey('n', uuid));
  };

  // ---------------------------------------------------------------------------------------------------------------
  // Message handlers. Each returns the flow it wrote to, or null when it wrote nothing.

  /** @param {Record<string, any>} raw @param {boolean} live @returns {Flow|null} */
  const onUser = (raw, live) => {
    const message = isObject(raw.message) ? raw.message : {};
    const blocks = normalizeContent(message.content);
    const uuid = typeof raw.uuid === 'string' ? raw.uuid : null;
    // The first main-thread user message after a compaction boundary may be the summary. Any main-thread user message
    // ends that wait, so a synthetic message that comes later is a plain note again.
    const mainThread = isMainThread(raw);
    const afterBoundary = mainThread && summaryDue;
    if (mainThread) summaryDue = false;
    const toolResults = blocks.filter((block) => block.type === 'tool_result');
    const rest = blocks.filter((block) => block.type !== 'tool_result');
    for (const block of toolResults) {
      const structured = toolResults.length === 1 && raw.tool_use_result !== undefined
        ? raw.tool_use_result
        : undefined;
      deliverResult(String(block.tool_use_id ?? ''), toolResultFrom(block), structured, uuid);
    }
    if (toolResults.length > 0 && rest.length === 0) return current ?? null;
    if (!mainThread) return onSubagentUser(raw, live, rest);

    const rawText = rest
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n');
    const visible = stripReminders(rawText);
    const images = rest.map((block) => (block.type === 'image' ? imageFrom(block) : null)).filter(Boolean);
    const origin = isObject(raw.origin) ? raw.origin : null;

    const interrupt = INTERRUPT_NOTICES.get(visible.trim());
    if (interrupt) {
      const flow = live ? liveFlow() : baseFlow();
      addNotice(flow, 'muted', interrupt, {}, '', nextKey('n', uuid));
      return flow;
    }

    // The summary a compaction leaves in place of the conversation. A transcript marks it isCompactSummary; the live
    // stream sends it as the synthetic user message that follows the boundary.
    if (raw.isCompactSummary === true || (afterBoundary && raw.isSynthetic === true)) {
      return addSummary(live, visible || stripReminders(rawText, true), uuid);
    }

    if (raw.isSynthetic === true || raw.is_meta === true ||
        (origin && typeof origin.kind === 'string' && origin.kind !== 'human')) {
      const flow = live ? liveFlow() : baseFlow();
      addNotice(flow, 'muted', 'user-meta',
        { source: origin && typeof origin.kind === 'string' ? origin.kind : 'synthetic' },
        visible || stripReminders(rawText, true), nextKey('n', uuid));
      return flow;
    }

    const stdout = STDOUT_RE.exec(rawText);
    if (stdout) {
      const flow = live ? liveFlow() : baseFlow();
      pushEntry(flow, { kind: 'command-output', key: nextKey('c', uuid), text: stripAnsi(stdout[1].trim()) });
      return flow;
    }
    const command = COMMAND_NAME_RE.exec(rawText);
    if (command) {
      const flow = live ? liveFlow() : baseFlow();
      const args = COMMAND_ARGS_RE.exec(rawText);
      const label = [command[1].trim(), args ? args[1].trim() : ''].filter(Boolean).join(' ');
      addNotice(flow, 'muted', 'command', {}, label, nextKey('n', uuid));
      return flow;
    }

    if (visible === '' && images.length === 0) {
      if (!/<system-reminder>/.test(rawText)) return null;
      const flow = live ? liveFlow() : baseFlow();
      addNotice(flow, 'muted', 'user-meta', { source: 'reminder' }, stripReminders(rawText, true), nextKey('n', uuid));
      return flow;
    }

    // A live prompt that echoes a message sent from this browser updates that message. Otherwise it joins the running
    // turn (folded message) or starts a new one. Transcript prompts always start one.
    if (live) {
      const echoed = adoptLocal(uuid, visible, images);
      if (echoed) return echoed;
    }
    const runningTurn = Boolean(live && turnRunning());
    const turn = runningTurn && current ? current : newTurn();
    if (live) markLive(turn.state);
    const entry = {
      kind: 'user',
      key: nextKey('u', uuid),
      uuid,
      clientMessageId: uuid,
      text: visible,
      images,
      attachments: [],
      status: 'sent',
      accepted: true,
      echoed: false,
      local: false,
      synthetic: false,
      error: null,
    };
    if (uuid) userEntries.set(uuid, entry);
    placeUser(turn, entry);
    return turn;
  };

  /**
   * A user turn inside a subagent (its prompt, or a message sent to it while it runs). It belongs to the agent's card,
   * never to the main conversation. The first one repeats the Agent call's prompt, which the card already shows, so it
   * adds nothing; any other becomes a muted note in the card. A message whose card has not arrived yet waits for it.
   * @param {Record<string, any>} raw
   * @param {boolean} live
   * @param {Array<Record<string, any>>} blocks  the message's blocks other than tool results
   * @returns {Flow|null}
   */
  const onSubagentUser = (raw, live, blocks) => {
    const text = stripReminders(blocks
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')).trim();
    if (text === '') return null;
    const owner = toolIndex.get(String(raw.parent_tool_use_id));
    if (owner && typeof owner.input.prompt === 'string' && owner.input.prompt.trim() === text) return null;
    const flow = resolveFlow(raw, live);
    if (!flow) return null;
    const uuid = typeof raw.uuid === 'string' ? raw.uuid : null;
    return addNotice(flow, 'muted', 'agent-message', {}, text, nextKey('n', uuid));
  };

  /**
   * @param {Flow} flow
   * @param {Record<string, any>} block
   * @param {string} messageId
   * @param {string|null} uuid
   * @param {Record<string, any>} raw
   */
  const appendAssistantBlock = (flow, block, messageId, uuid, raw) => {
    const type = block.type;
    if (type === 'text') {
      appendBubble(flow, { kind: 'text', text: String(block.text ?? '') }, messageId, uuid, raw);
    } else if (type === 'thinking') {
      appendBubble(flow, { kind: 'thinking', text: String(block.thinking ?? ''), redacted: false },
        messageId, uuid, raw);
    } else if (type === 'redacted_thinking') {
      appendBubble(flow, { kind: 'thinking', text: '', redacted: true }, messageId, uuid, raw);
    } else if (type === 'tool_use') {
      addTool(flow, {
        id: String(block.id ?? ''), name: String(block.name ?? 'tool'), input: block.input, messageUuid: uuid,
      });
    } else if (type === 'server_tool_use' && block.name === 'web_search') {
      const input = isObject(block.input) ? block.input : {};
      addTool(flow, {
        id: String(block.id ?? ''), name: 'WebSearch', input: { query: input.query ?? '' }, messageUuid: uuid,
      });
    } else if (type === 'web_search_tool_result') {
      const id = String(block.tool_use_id ?? '');
      const card = toolIndex.get(id) ?? addTool(flow, { id, name: 'WebSearch', input: {}, messageUuid: uuid });
      const { result, structured } = webSearchResultFrom(block);
      applyResult(card, result, structured, uuid);
    } else {
      appendBubble(flow, { kind: 'generic', raw: block, label: String(type ?? 'block') }, messageId, uuid, raw);
    }
  };

  /**
   * Appends a block to the bubble that is last in the flow when it belongs to the same message; otherwise a new bubble
   * starts (work groups between text blocks split bubbles).
   * @param {Flow} flow
   * @param {Record<string, any>} block
   * @param {string} messageId
   * @param {string|null} uuid
   * @param {Record<string, any>} raw
   */
  const appendBubble = (flow, block, messageId, uuid, raw) => {
    const last = flow.entries[flow.entries.length - 1];
    let bubble = last && last.kind === 'assistant' && last.messageId === messageId && !last.streaming ? last : null;
    if (!bubble) {
      let key;
      if (uuid) {
        const ordinal = bubbleCount.get(uuid) ?? 0;
        bubbleCount.set(uuid, ordinal + 1);
        key = ordinal === 0 ? `a:${uuid}` : `a:${uuid}/${ordinal}`;
      } else {
        key = nextKey('a', null);
      }
      bubble = pushEntry(flow, {
        kind: 'assistant',
        key,
        uuid,
        messageId,
        blocks: [],
        streaming: false,
        error: null,
        aborted: raw.aborted === true,
      });
    }
    block.key = `${bubble.key}/${bubble.blocks.length}`;
    touch(block);
    bubble.blocks.push(block);
    touch(bubble);
    touchOwners(flow);
  };

  /**
   * A final assistant message settles the streaming draft of the same message id: its blocks count as finalized, so
   * only the blocks it does not cover stay visible. Each message settles a draft once, by uuid.
   * @param {Record<string, any>} raw
   */
  const settleDraft = (raw) => {
    if (!draft || raw.type !== 'assistant') return;
    const message = isObject(raw.message) ? raw.message : {};
    if (message.id !== draft.messageId) return;
    const uuid = typeof raw.uuid === 'string' ? raw.uuid : null;
    if (uuid && draft.settled.has(uuid)) return;
    if (uuid) draft.settled.add(uuid);
    draft.finalized += normalizeContent(message.content).length;
    touch(draft);
    maybeClearDraft();
  };

  /** @param {Record<string, any>} raw @param {boolean} live @returns {Flow|null} */
  const onAssistant = (raw, live) => {
    const message = isObject(raw.message) ? raw.message : {};
    const content = normalizeContent(message.content);
    const flow = resolveFlow(raw, live);
    if (!flow) return null;
    const uuid = typeof raw.uuid === 'string' ? raw.uuid : null;
    const messageId = typeof message.id === 'string' ? message.id : nextKey('msg', null);
    if (live) markLive(flow.state);
    // A refusal-fallback retry names the refused messages it replaces; they leave the timeline without a marker.
    withdrawMessages(uuidSet(raw, 'supersedes'), { marker: false });
    if (live) settleDraft(raw);
    for (const block of content) appendAssistantBlock(flow, block, messageId, uuid, raw);
    if (typeof raw.error === 'string' && raw.error) {
      addNotice(flow, 'error', 'assistant-error', { error: raw.error }, '', uuid ? `n:${uuid}:error` : null);
    }
    return flow;
  };

  /** @param {Record<string, any>} raw @param {boolean} live @param {string|null} uuid @returns {Flow|null} */
  const upsertTask = (raw, subtype, live, uuid) => {
    if (raw.skip_transcript === true || raw.ambient === true) return null;
    const flow = resolveFlow(raw, live);
    if (!flow) return null;
    if (live) markLive(flow.state);
    const taskId = String(raw.task_id ?? uuid ?? nextKey('task', null));
    /** @type {Record<string, any>} */
    const fields = { rowKind: 'task', taskId };
    if (subtype === 'task_started') {
      Object.assign(fields, {
        description: String(raw.description ?? ''), status: 'running', subagentType: raw.subagent_type ?? null,
      });
    } else if (subtype === 'task_progress') {
      Object.assign(fields, {
        description: String(raw.description ?? ''),
        summary: typeof raw.summary === 'string' ? raw.summary : null,
        toolUses: isObject(raw.usage) ? raw.usage.tool_uses : null,
        durationMs: isObject(raw.usage) ? raw.usage.duration_ms : null,
        lastToolName: raw.last_tool_name ?? null,
      });
    } else if (subtype === 'task_updated') {
      const patch = isObject(raw.patch) ? raw.patch : {};
      if (typeof patch.status === 'string') fields.status = patch.status;
      if (typeof patch.description === 'string') fields.description = patch.description;
      if (typeof patch.error === 'string') fields.error = patch.error;
    } else {
      Object.assign(fields, {
        status: String(raw.status ?? 'completed'),
        summary: typeof raw.summary === 'string' ? raw.summary : null,
      });
    }
    upsertRow(flow, `task:${taskId}`, fields);
    return flow;
  };

  /**
   * Forgets a tool card that left the timeline, so a later result for its id is not attached to it.
   * @param {Record<string, any>} item
   */
  const forgetTool = (item) => {
    if (toolIndex.get(item.id) === item) toolIndex.delete(item.id);
    groupOf.delete(item);
    containerOf.delete(item);
    childFlowOf.delete(item);
  };

  /**
   * Takes a tool card out of its work group. Its result, if any, goes with it.
   * @param {Flow} flow
   * @param {Record<string, any>} item
   */
  const dropTool = (flow, item) => {
    const group = groupOf.get(item);
    if (group) {
      const index = group.items.indexOf(item);
      if (index >= 0) group.items.splice(index, 1);
      refreshGroup(group);
      touch(group);
    }
    forgetTool(item);
    touchOwners(flow);
  };

  /**
   * Puts the "Response withdrawn" marker where a tool card stood: the card leaves its group, and a muted row takes its
   * place.
   * @param {Flow} flow
   * @param {Record<string, any>} item
   * @param {string} uuid
   */
  const markToolWithdrawn = (flow, item, uuid) => {
    const group = groupOf.get(item);
    const row = { kind: 'row', key: `wd:${uuid}`, rowKind: 'withdrawn' };
    touch(row);
    const index = group ? group.items.indexOf(item) : -1;
    if (group && index >= 0) {
      group.items[index] = row;
      groupOf.set(row, group);
      containerOf.set(row, flow);
      refreshGroup(group);
      touch(group);
    }
    forgetTool(item);
    touchOwners(flow);
  };

  /**
   * Turns a retracted response into its marker. Each retracted message leaves one "Response withdrawn" marker where its
   * first visible piece stood (an assistant bubble, or a tool card whose tool_use or tool_result came in it); the other
   * pieces of that message are removed. Subagent flows are searched too. With `marker: false` (a message that
   * supersedes them arrived, and stands in their place) every piece is removed and no marker is left.
   * @param {Set<string>} uuids
   * @param {{marker?: boolean}} [options]
   */
  const withdrawMessages = (uuids, { marker = true } = {}) => {
    if (uuids.size === 0) return;
    const marked = new Set();
    /** @param {Flow} flow */
    const visit = (flow) => {
      for (const entry of [...flow.entries]) {
        if (entry.kind === 'assistant' && uuids.has(entry.uuid)) {
          if (!marker || marked.has(entry.uuid)) {
            const index = flow.entries.indexOf(entry);
            if (index >= 0) flow.entries.splice(index, 1);
            bump();
          } else {
            marked.add(entry.uuid);
            entry.kind = 'withdrawn';
            entry.blocks = [];
            touch(entry);
          }
          touchOwners(flow);
        } else if (entry.kind === 'work') {
          for (const item of [...entry.items]) {
            if (item.kind !== 'tool') continue;
            const hit = [item.messageUuid, item.resultUuid].find((id) => typeof id === 'string' && uuids.has(id));
            if (hit === undefined) {
              const child = childFlowOf.get(item);
              if (child) visit(child);
            } else if (!marker || marked.has(hit)) {
              dropTool(flow, item);
            } else {
              marked.add(hit);
              markToolWithdrawn(flow, item, hit);
            }
          }
        }
      }
    };
    for (const turn of turns) visit(turn);
  };

  /**
   * The uuids a message lists in one of its fields, as a set of non-empty strings.
   * @param {Record<string, any>} raw
   * @param {'retracted_message_uuids'|'supersedes'} field
   * @returns {Set<string>}
   */
  const uuidSet = (raw, field) => {
    const list = Array.isArray(raw[field]) ? raw[field] : [];
    return new Set(list.filter((id) => typeof id === 'string' && id !== ''));
  };

  /**
   * The primary model refused a turn and a fallback model answered it. The retracted messages are withdrawn, and an
   * open streaming draft goes too: the retry streams a new message. A subagent or side question that fell back shows
   * the notice inside its work group, the session-level fallback as a notice in the turn.
   * @param {Record<string, any>} raw
   * @param {boolean} live
   * @param {string|null} uuid
   * @returns {Flow|null}
   */
  const onRefusalFallback = (raw, live, uuid) => {
    const flow = resolveFlow(raw, live);
    if (!flow) return null;
    if (live) markLive(flow.state);
    // A subagent or side question that fell back streams nothing into the main draft; only a session fallback drops it.
    if (raw.scope !== 'local') clearDraft();
    withdrawMessages(uuidSet(raw, 'retracted_message_uuids'));
    const vars = { category: typeof raw.api_refusal_category === 'string' ? raw.api_refusal_category : null };
    const text = typeof raw.content === 'string' ? raw.content : '';
    if (raw.scope === 'local') {
      upsertRow(flow, `refusal:${uuid ?? nextKey('r', null)}`, {
        rowKind: 'notice', level: 'warning', code: 'refusal-fallback', vars, text,
      });
      return flow;
    }
    return addNotice(flow, 'warning', 'refusal-fallback', vars, text, uuid ? `n:${uuid}` : null);
  };

  /**
   * The model refused and no fallback ran. The notice names the user message that was refused, so the view can offer to
   * edit and retry it.
   * @param {Record<string, any>} raw
   * @param {boolean} live
   * @param {string|null} uuid
   * @returns {Flow|null}
   */
  const onRefusalNoFallback = (raw, live, uuid) => {
    const flow = resolveFlow(raw, live);
    if (!flow) return null;
    if (live) markLive(flow.state);
    const refused = typeof raw.refused_user_message_uuid === 'string' && raw.refused_user_message_uuid !== ''
      ? raw.refused_user_message_uuid : null;
    const vars = {
      refused,
      category: typeof raw.api_refusal_category === 'string' ? raw.api_refusal_category : null,
    };
    const text = typeof raw.content === 'string' ? raw.content : '';
    return addNotice(flow, 'warning', 'refusal-no-fallback', vars, text, uuid ? `n:${uuid}` : null);
  };

  /**
   * One step of a headless plugin installation, as a muted row. A failed install is a warning.
   * @param {Record<string, any>} raw
   * @param {boolean} live
   * @param {string|null} uuid
   * @returns {Flow}
   */
  const onPluginInstall = (raw, live, uuid) => {
    const flow = live ? liveFlow() : baseFlow();
    const status = typeof raw.status === 'string' ? raw.status : '';
    const vars = {
      status,
      name: typeof raw.name === 'string' ? raw.name : '',
      error: typeof raw.error === 'string' ? raw.error : '',
    };
    return addNotice(flow, status === 'failed' ? 'warning' : 'muted', 'plugin-install', vars, '',
      uuid ? `n:${uuid}` : null);
  };

  /**
   * An MCP server confirmed that a URL step finished in the browser, as a muted row.
   * @param {Record<string, any>} raw
   * @param {boolean} live
   * @param {string|null} uuid
   * @returns {Flow}
   */
  const onElicitationComplete = (raw, live, uuid) => {
    const flow = live ? liveFlow() : baseFlow();
    const server = typeof raw.mcp_server_name === 'string' ? raw.mcp_server_name : '';
    return addNotice(flow, 'muted', 'elicitation-complete', { server }, '', uuid ? `n:${uuid}` : null);
  };

  /** @param {Record<string, any>} raw @param {boolean} live @returns {Flow|null} */
  const onSystem = (raw, live) => {
    const subtype = typeof raw.subtype === 'string'
      ? raw.subtype
      : (isObject(raw.message) && typeof raw.message.subtype === 'string' ? raw.message.subtype : null);
    if (subtype === null) {
      // Transcript system records reach the browser without a subtype and carry nothing to show.
      return live ? addGeneric(raw, live, 'system') : null;
    }
    const uuid = typeof raw.uuid === 'string' ? raw.uuid : null;
    switch (subtype) {
      case 'init':
      case 'notification':
      case 'files_persisted':
      case 'thinking_tokens':
      case 'commands_changed':
      case 'background_tasks_changed':
        return null;
      case 'status': {
        runStatus = { status: raw.status ?? null, compactResult: raw.compact_result ?? null };
        if (live && raw.status && current && !current.state.closed) markLive(current.state);
        let flow = null;
        if (raw.status === 'compacting') {
          if (live) flow = startCompacting(uuid);
        } else if (!raw.status && raw.compact_result !== 'success') {
          // A success keeps the row: the boundary that follows turns it into the divider in place.
          endCompacting();
        }
        if (raw.compact_result === 'failed') {
          const failed = baseFlow();
          return addNotice(failed, 'error', 'compact-failed', {},
            typeof raw.compact_error === 'string' ? raw.compact_error : '', uuid ? `n:${uuid}` : null);
        }
        return flow;
      }
      case 'compact_boundary': {
        const meta = isObject(raw.compact_metadata) ? raw.compact_metadata
          : (isObject(raw.compactMetadata) ? raw.compactMetadata : {});
        const details = {
          trigger: typeof meta.trigger === 'string' ? meta.trigger : null,
          preTokens: firstNumber(meta.pre_tokens, meta.preTokens),
          postTokens: firstNumber(meta.post_tokens, meta.postTokens),
          durationMs: firstNumber(meta.duration_ms, meta.durationMs),
        };
        // The summary follows as the next main-thread user message (see onUser).
        if (isMainThread(raw)) summaryDue = true;
        const settled = live ? settleCompacting(details) : null;
        if (settled) return settled;
        const flow = live ? liveFlow() : baseFlow();
        pushEntry(flow, { kind: 'divider', key: nextKey('dv', uuid), variant: 'compact', ...details });
        return flow;
      }
      case 'api_retry': {
        const flow = resolveFlow(raw, live);
        if (!flow) return null;
        if (live) markLive(flow.state);
        return addNotice(flow, 'muted', 'api-retry', {
          attempt: raw.attempt,
          max: raw.max_retries,
          delayMs: raw.retry_delay_ms,
          status: raw.error_status,
          error: raw.error,
        }, '', uuid ? `n:${uuid}` : null);
      }
      case 'local_command_output': {
        const flow = live ? liveFlow() : baseFlow();
        pushEntry(flow, {
          kind: 'command-output', key: nextKey('c', uuid), text: stripAnsi(String(raw.content ?? '')),
        });
        return flow;
      }
      case 'informational': {
        const flow = resolveFlow(raw, live);
        if (!flow) return null;
        return addNotice(flow, mapInformationalLevel(raw.level), 'informational', {}, String(raw.content ?? ''),
          uuid ? `n:${uuid}` : null);
      }
      case 'session_state_changed':
        if (raw.state === 'idle' && live) endIdle();
        return null;
      case 'task_summary':
        // The runtime's one-line activity for the running turn: it shows beside the working indicator, not as a row.
        // A summary that arrives after the turn closed has no turn beside it, so it is dropped rather than carried on.
        if (live && current && !current.state.closed) {
          activity = typeof raw.detail === 'string' && raw.detail.trim() ? raw.detail.trim() : null;
        }
        return null;
      case 'post_turn_summary':
      case 'session_title_changed':
        return null;
      case 'memory_recall': {
        const flow = live ? liveFlow() : baseFlow();
        const count = Array.isArray(raw.memories) ? raw.memories.length : 0;
        return addNotice(flow, 'muted', 'memory-recall', { count }, '', uuid ? `n:${uuid}` : null);
      }
      case 'permission_denied': {
        const flow = resolveFlow(raw, live);
        if (!flow) return null;
        if (live) markLive(flow.state);
        upsertRow(flow, `denied:${String(raw.tool_use_id ?? uuid ?? nextKey('d', null))}`, {
          rowKind: 'denied',
          toolName: String(raw.tool_name ?? ''),
          message: String(raw.message ?? ''),
          reason: typeof raw.decision_reason === 'string' ? raw.decision_reason : '',
          status: 'denied',
        });
        return flow;
      }
      case 'hook_started':
      case 'hook_progress':
      case 'hook_response': {
        const flow = resolveFlow(raw, live);
        if (!flow) return null;
        if (live) markLive(flow.state);
        /** @type {Record<string, any>} */
        const fields = {
          rowKind: 'hook',
          hookName: String(raw.hook_name ?? ''),
          hookEvent: String(raw.hook_event ?? ''),
          status: subtype === 'hook_response' ? String(raw.outcome ?? 'success') : 'running',
        };
        if (typeof raw.output === 'string') fields.output = raw.output.slice(0, HOOK_TEXT_LIMIT);
        upsertRow(flow, `hook:${String(raw.hook_id ?? uuid ?? nextKey('h', null))}`, fields);
        return flow;
      }
      case 'task_started':
      case 'task_progress':
      case 'task_updated':
      case 'task_notification':
        return upsertTask(raw, subtype, live, uuid);
      case 'model_refusal_fallback':
        return onRefusalFallback(raw, live, uuid);
      case 'model_refusal_no_fallback':
        return onRefusalNoFallback(raw, live, uuid);
      case 'plugin_install':
        return onPluginInstall(raw, live, uuid);
      case 'elicitation_complete':
        return onElicitationComplete(raw, live, uuid);
      case 'control_request_progress':
        return null;
      default:
        return addGeneric(raw, live, `system/${subtype}`);
    }
  };

  /** @param {Record<string, any>} raw @returns {Flow} */
  const onResult = (raw) => {
    const flow = baseFlow();
    // A result that names no turn may only fill a turn that has no result yet, so it cannot be placed twice.
    if (!named && flow.entries.some((entry) => entry.kind === 'result')) return null;
    const uuid = typeof raw.uuid === 'string' ? raw.uuid : null;
    const terminal = typeof raw.terminal_reason === 'string' ? raw.terminal_reason : null;
    const subtype = typeof raw.subtype === 'string' ? raw.subtype : 'success';
    const rawErrors = Array.isArray(raw.errors) ? raw.errors.map(String) : [];
    // An interrupted turn says so in its headline; the SDK's own "Interrupted" error line would repeat it.
    const interrupted = (terminal !== null && terminal.startsWith('aborted'))
      || (rawErrors.length === 1 && rawErrors[0] === 'Interrupted');
    const errors = interrupted ? [] : rawErrors;
    const failed = !interrupted && (raw.is_error === true || subtype !== 'success');
    if (failed && errors.length === 0 && typeof raw.result === 'string' && raw.result) errors.push(raw.result);
    // A question that unattended mode answered is recorded as such; the runtime still lists it as a denial.
    const denials = Array.isArray(raw.permission_denials)
      ? raw.permission_denials.filter(isObject)
        .filter((denial) => !autoAnswered.has(String(denial.tool_use_id ?? '')))
        .map((denial) => ({ toolName: String(denial.tool_name ?? '') }))
      : [];
    pushEntry(flow, {
      kind: 'result',
      key: nextKey('res', uuid),
      subtype,
      durationMs: typeof raw.duration_ms === 'number' ? raw.duration_ms : null,
      durationApiMs: typeof raw.duration_api_ms === 'number' ? raw.duration_api_ms : null,
      numTurns: typeof raw.num_turns === 'number' ? raw.num_turns : null,
      isError: failed,
      interrupted,
      errors,
      permissionDenials: denials,
      terminalReason: terminal,
      totalCostUsd: typeof raw.total_cost_usd === 'number' ? raw.total_cost_usd : null,
    });
    closeTurn(flow.state);
    clearDraft();
    return flow;
  };

  /** @param {string} messageId @returns {void} */
  const ensureDraft = (messageId) => {
    if (!draft) draft = { messageId, blocks: [], finalized: 0, stopped: false, version: 0, settled: new Set() };
  };

  /** @param {number} index @param {Record<string, any>} block */
  const makeDraftBlock = (index, block) => {
    const key = `d:${draft ? draft.messageId : 'stream'}/${index}`;
    const type = block.type;
    let made;
    if (type === 'text') made = { key, kind: 'text', text: String(block.text ?? '') };
    else if (type === 'thinking') made = { key, kind: 'thinking', text: String(block.thinking ?? ''), redacted: false };
    else if (type === 'redacted_thinking') made = { key, kind: 'thinking', text: '', redacted: true };
    else if (type === 'tool_use' || type === 'server_tool_use')
      made = { key, kind: 'tool-draft', name: String(block.name ?? 'tool'), partial: '' };
    else made = { key, kind: 'generic', raw: block, label: String(type ?? 'block') };
    touch(made);
    return made;
  };

  /** @param {Record<string, any>} block @param {Record<string, any>} delta */
  const applyDelta = (block, delta) => {
    if (delta.type === 'text_delta' && block.kind === 'text') block.text += String(delta.text ?? '');
    else if (delta.type === 'thinking_delta' && block.kind === 'thinking') block.text += String(delta.thinking ?? '');
    else if (delta.type === 'input_json_delta' && block.kind === 'tool-draft')
      block.partial += String(delta.partial_json ?? '');
    else return;
    touch(block);
  };

  /** @param {Record<string, any>} raw @returns {Flow|null} */
  const onStream = (raw) => {
    if (typeof raw.parent_tool_use_id === 'string' && raw.parent_tool_use_id) return null;
    const event = isObject(raw.event) ? raw.event : null;
    if (!event) return null;
    const flow = liveFlow();
    markLive(flow.state);
    switch (event.type) {
      case 'message_start': {
        const id = isObject(event.message) && typeof event.message.id === 'string'
          ? event.message.id
          : nextKey('stream', null);
        if (draft && draft.messageId !== id) clearDraft();
        ensureDraft(id);
        touch(draft);
        break;
      }
      case 'content_block_start': {
        ensureDraft(nextKey('stream', null));
        const index = Number(event.index) || 0;
        draft.blocks[index] = makeDraftBlock(index, isObject(event.content_block) ? event.content_block : {});
        touch(draft);
        break;
      }
      case 'content_block_delta': {
        ensureDraft(nextKey('stream', null));
        const index = Number(event.index) || 0;
        const delta = isObject(event.delta) ? event.delta : {};
        const typeHint = delta.type === 'text_delta' ? 'text'
          : delta.type === 'thinking_delta' ? 'thinking' : delta.type === 'input_json_delta' ? 'tool_use' : 'generic';
        const block = draft.blocks[index] ?? (draft.blocks[index] = makeDraftBlock(index, { type: typeHint }));
        applyDelta(block, delta);
        touch(draft);
        break;
      }
      case 'message_stop':
        if (draft) {
          draft.stopped = true;
          maybeClearDraft();
        }
        break;
      case 'message_delta': {
        // The runtime reports the message's output tokens so far; the turn's count sums its messages (see activity).
        const usage = isObject(event.usage) ? event.usage : {};
        const tokens = Number(usage.output_tokens);
        if (draft && Number.isFinite(tokens)) flow.state.tokens.set(draft.messageId, tokens);
        break;
      }
      default:
        break;
    }
    return flow;
  };

  /** @param {Record<string, any>} raw @returns {Flow|null} */
  const onToolProgress = (raw) => {
    const item = toolIndex.get(String(raw.tool_use_id ?? ''));
    if (!item) return null;
    const flow = containerOf.get(item) ?? liveFlow();
    markLive(flow.state);
    if (typeof raw.elapsed_time_seconds === 'number' && setField(item, 'elapsedSeconds', raw.elapsed_time_seconds)) {
      // The group header shows the running tool's elapsed time, so the group is touched as well as the owners.
      const group = groupOf.get(item);
      if (group) touch(group);
      touchOwners(flow);
    }
    return flow;
  };

  /** @param {Record<string, any>} raw */
  const onSummary = (raw) => {
    const ids = Array.isArray(raw.preceding_tool_use_ids) ? raw.preceding_tool_use_ids : [];
    for (const id of ids) {
      const item = toolIndex.get(String(id));
      const group = item ? groupOf.get(item) : null;
      if (group) {
        const changed = setField(group, 'label', String(raw.summary ?? ''));
        const holder = containerOf.get(item);
        if (changed && holder) touchOwners(holder);
        break;
      }
    }
    return null;
  };

  /** @param {Record<string, any>} raw @returns {Flow} */
  const onReset = (raw) => {
    const flow = baseFlow();
    const uuid = typeof raw.uuid === 'string' ? raw.uuid : null;
    pushEntry(flow, { kind: 'divider', key: nextKey('dv', uuid), variant: 'clear', preTokens: null, trigger: null });
    closeTurn(flow.state);
    clearDraft();
    return flow;
  };

  /** @param {Record<string, any>} raw */
  const isActivity = (raw) => {
    if (raw.type === 'assistant' || raw.type === 'user' || raw.type === 'stream_event' ||
        raw.type === 'tool_progress') return true;
    if (raw.type !== 'system') return false;
    if (raw.subtype === 'status') return Boolean(raw.status);
    return raw.subtype === 'api_retry' || raw.subtype === 'permission_denied' ||
      String(raw.subtype).startsWith('hook_');
  };

  /**
   * Handles one message. Duplicates (same uuid already seen in transcript or live data) only refresh the turn they
   * belong to, so a snapshot that overlaps the transcript is harmless.
   * @param {any} raw
   * @param {boolean} live
   */
  function ingest(raw, live) {
    if (!isObject(raw)) {
      if (live) addGeneric(raw, true, 'unknown');
      return;
    }
    const uuid = typeof raw.uuid === 'string' && raw.uuid ? raw.uuid : null;
    if (!live && uuid) transcriptUuids.add(uuid);
    if (uuid && flowOfUuid.has(uuid)) {
      const known = flowOfUuid.get(uuid);
      if (live && known) {
        if (isActivity(raw)) markLive(known.state);
        // A replayed boundary that the transcript shows ends the compaction row the replay started.
        if (isBoundary(raw)) endCompacting();
        // A subagent's flow is not a turn: the turn it belongs to becomes current.
        current = known.state.main ?? known;
        // A replayed final message still settles the draft its stream built (rule 1).
        if (raw.type === 'assistant') settleDraft(raw);
      }
      return;
    }
    // The transcript keeps a compaction's boundary as a record without its subtype, which shows nothing, and the
    // summary after it adds the divider (addSummary). A reload replays that boundary with its subtype: it ends the row
    // the replay started and adds no second divider.
    if (live && uuid && isBoundary(raw) && transcriptUuids.has(uuid)) {
      endCompacting();
      return;
    }
    // A message that names its user message is placed in that turn, and the cursor moves there so the messages after it
    // without a name follow it.
    const outer = named;
    named = namedTurn(raw);
    if (named) current = named;
    /** @type {Flow|null} */
    let flow = null;
    try {
      flow = route(raw, live);
    } finally {
      named = outer;
    }
    if (uuid && flow && !flowOfUuid.has(uuid)) flowOfUuid.set(uuid, flow);
  }

  /**
   * Hands a message to its handler. Returns the flow it wrote to, or null when it wrote nothing.
   * @param {any} raw
   * @param {boolean} live
   * @returns {Flow|null}
   */
  function route(raw, live) {
    switch (raw.type) {
      case 'user': return onUser(raw, live);
      case 'assistant': return onAssistant(raw, live);
      case 'system': return onSystem(raw, live);
      case 'result': return live ? onResult(raw) : null;
      case 'stream_event': return live ? onStream(raw) : null;
      case 'tool_progress': return live ? onToolProgress(raw) : null;
      case 'tool_use_summary': return live ? onSummary(raw) : null;
      case 'conversation_reset': return onReset(raw);
      case 'command_lifecycle': return applyCommandState(raw);
      case 'active_goal':
      case 'autocompact_state':
      case 'keep_alive':
      case 'rate_limit_event':
      case 'prompt_suggestion':
      case 'auth_status':
        return null;
      default:
        return addGeneric(raw, live, null);
    }
  }

  /** @param {any} raw @param {boolean} live */
  const guard = (fn, raw, live) => {
    try {
      fn();
    } catch {
      try {
        addGeneric(raw, live, 'malformed');
      } catch {
        // A value that cannot even be shown as generic is skipped.
      }
    }
  };

  // ---------------------------------------------------------------------------------------------------------------
  // Operation log

  /** @param {{op: string, [key: string]: any}} operation */
  const apply = (operation) => {
    eventTime = typeof operation.at === 'number' ? operation.at : 0;
    switch (operation.op) {
      case 'transcript':
        for (const message of operation.messages) guard(() => ingest(message, false), message, false);
        break;
      case 'live':
        guard(() => ingest(operation.msg, true), operation.msg, true);
        break;
      case 'opt':
        addOptimisticEntry(operation);
        break;
      case 'accepted':
        markAcceptedEntry(operation.clientMessageId);
        break;
      case 'failed':
        markFailedEntry(operation.clientMessageId, operation.error);
        break;
      case 'discard':
        discardEntry(operation.clientMessageId);
        break;
      case 'cancel':
        cancelQueuedEntry(operation.clientMessageId);
        break;
      case 'evict':
        withdrawMessages(new Set(operation.uuids), { marker: false });
        break;
      case 'notice':
        addInlineNotice(operation);
        break;
      case 'auto':
        addAutoEntry(operation.request);
        break;
      default:
        break;
    }
  };

  const reset = () => {
    turns = [];
    current = null;
    draft = null;
    toolIndex = new Map();
    containerOf = new Map();
    groupOf = new Map();
    childFlowOf = new Map();
    autoAnswered = new Set();
    rowIndex = new Map();
    flowOfUuid = new Map();
    transcriptUuids = new Set();
    bubbleCount = new Map();
    orphans = new Map();
    pendingResults = new Map();
    queued = [];
    locals = [];
    userEntries = new Map();
    runStatus = { status: null, compactResult: null };
    compacting = null;
    summaryDue = false;
    activity = null;
  };

  const relinkPending = () => {
    const wanted = new Map();
    for (const entry of pending) {
      const toolUseId = entry.request.toolUseId;
      if (typeof toolUseId === 'string') wanted.set(toolUseId, entry.request.id);
    }
    for (const item of toolIndex.values()) {
      if (!setField(item, 'pendingRequestId', wanted.get(item.id) ?? null)) continue;
      const group = groupOf.get(item);
      if (group) touch(group);
      const holder = containerOf.get(item);
      if (holder) touchOwners(holder);
    }
  };

  /**
   * The session reports that it is no longer working. A message just sent keeps its turn until the session reports
   * running, so a stale idle report cannot take the message out of the timeline's running turn.
   */
  const endIdle = () => {
    if (current && current.state.sendPending) return;
    if (current) closeTurn(current.state, true);
    clearDraft();
  };

  const applySessionState = () => {
    if (sessionState !== null && INACTIVE_STATES.has(sessionState)) endIdle();
  };

  const replay = () => {
    reset();
    for (const operation of log) apply(operation);
    relinkPending();
    applySessionState();
  };

  // ---------------------------------------------------------------------------------------------------------------
  // Optimistic user messages

  /** @returns {boolean} true while the current turn runs: live activity seen and the turn not closed */
  const turnRunning = () => Boolean(current && current.state.live && !current.state.closed);

  /**
   * Adds an entry to a turn and indexes where it sits.
   * @param {Flow} flow
   * @param {Record<string, any>} entry
   */
  const placeUser = (flow, entry) => {
    pushEntry(flow, entry);
    containerOf.set(entry, flow);
    if (entry.uuid) flowOfUuid.set(entry.uuid, flow);
  };

  /**
   * Marks a local message as part of the conversation: the gateway accepted it, and the SDK stores it under the
   * clientMessageId as its uuid, so rewind and fork can target it before the next transcript reload.
   * @param {Record<string, any>} entry
   * @param {string|null} uuid the uuid the echo carries, when there was one
   */
  const confirmLocal = (entry, uuid) => {
    const id = uuid ?? entry.clientMessageId;
    entry.echoed = true;
    setField(entry, 'uuid', id);
    setField(entry, 'status', 'sent');
    setField(entry, 'error', null);
    userEntries.set(id, entry);
    const flow = containerOf.get(entry);
    if (flow) flowOfUuid.set(id, flow);
  };

  /**
   * Starts a turn with a message the user just sent. A session that reports running marks the turn live at once; one
   * that does not yet, or only starts, keeps it pending until it reports running, so the 'idle' of a session that has
   * just become ready does not end the turn before it runs.
   * @param {Record<string, any>} entry
   */
  const startLocalTurn = (entry) => {
    const turn = newTurn();
    turn.state.sendPending = true;
    turn.state.startedAt = eventTime || now();
    placeUser(turn, entry);
    if (sessionState === null || RUNNING_STATES.has(sessionState)) markLive(turn.state);
    return turn;
  };

  /**
   * Moves the queued messages into a new turn, in order, once the turn ahead of them has closed. Accepted messages
   * become 'sent'; the others stay 'sending' until the gateway accepts them. Failed ones stay where they are.
   * @param {boolean} running whether the SDK runs the new turn right away
   */
  const startQueued = (running) => {
    const ready = queued.filter((entry) => entry.status === 'queued');
    if (ready.length === 0) return;
    queued = queued.filter((entry) => entry.status !== 'queued');
    const turn = newTurn();
    if (running) markLive(turn.state);
    for (const entry of ready) {
      placeUser(turn, entry);
      if (entry.accepted) confirmLocal(entry, null);
      else setField(entry, 'status', 'sending');
    }
    bump();
  };

  /**
   * Adds a message the user just sent. It starts a turn when none is running and waits in the queued list otherwise.
   * A message whose clientMessageId is already known (a retry, or a transcript that has it) adds nothing.
   * @param {{clientMessageId: string, text: string, attachments?: unknown}} operation
   */
  const addOptimisticEntry = ({ clientMessageId, text, attachments }) => {
    if (userEntries.has(clientMessageId)) return;
    const waiting = turnRunning();
    const entry = {
      kind: 'user',
      key: `o:${clientMessageId}`,
      uuid: null,
      clientMessageId,
      text: String(text ?? ''),
      images: [],
      attachments: normalizeAttachments(attachments),
      status: waiting ? 'queued' : 'sending',
      accepted: false,
      echoed: false,
      local: true,
      synthetic: false,
      error: null,
    };
    touch(entry);
    userEntries.set(clientMessageId, entry);
    locals.push(entry);
    if (waiting) {
      queued.push(entry);
      bump();
    } else {
      startLocalTurn(entry);
    }
  };

  /**
   * Moves a message that waited in the queued list into the running turn, or starts a turn for it when none runs.
   * @param {Record<string, any>} entry
   * @returns {Flow}
   */
  const joinRunningTurn = (entry) => {
    const waiting = queued.indexOf(entry);
    if (waiting >= 0) queued.splice(waiting, 1);
    let turn;
    if (turnRunning() && current) {
      turn = current;
    } else {
      turn = newTurn();
      markLive(turn.state);
    }
    placeUser(turn, entry);
    bump();
    return turn;
  };

  /**
   * A live user message that echoes a message sent from this browser (same uuid, or the same text when the echo has
   * no uuid we know) updates that message instead of adding a second bubble.
   * @param {string|null} uuid
   * @param {string} text
   * @param {Array<{mediaType: string, data: string}>} images
   * @returns {Flow|null} the turn now holding the message, or null when no local message matches
   */
  const adoptLocal = (uuid, text, images) => {
    let entry = uuid !== null ? userEntries.get(uuid) : undefined;
    if (entry && (!entry.local || entry.echoed)) entry = undefined;
    if (!entry) {
      const trimmed = text.trim();
      entry = locals.find((item) => !item.echoed && item.status !== 'failed' && item.text.trim() === trimmed);
    }
    if (!entry) return null;
    if (images.length > 0 && entry.images.length === 0) setField(entry, 'images', images);
    let turn = containerOf.get(entry);
    // Still queued: the SDK has started the message, so it joins the running turn.
    if (!turn) turn = joinRunningTurn(entry);
    confirmLocal(entry, uuid);
    return turn;
  };

  /**
   * The runtime's report on a message the user sent (command_lifecycle): queued behind a running turn, started or
   * completed. It sets the message's status and adds no row. A message still waiting in the queued list moves into the
   * running turn when the runtime starts it, so it is never listed twice. A failed message keeps its error.
   * @param {Record<string, any>} raw
   * @returns {null}
   */
  const applyCommandState = (raw) => {
    const id = typeof raw.command_uuid === 'string' ? raw.command_uuid : '';
    const entry = id ? userEntries.get(id) : undefined;
    if (!entry || entry.status === 'failed') return null;
    if (raw.state === 'queued' && entry.status !== 'sent') {
      setField(entry, 'accepted', true);
      setField(entry, 'status', 'queued');
    } else if (raw.state === 'started' || raw.state === 'completed') {
      setField(entry, 'accepted', true);
      if (entry.local) {
        if (!containerOf.has(entry) && queued.includes(entry)) joinRunningTurn(entry);
        confirmLocal(entry, id);
      } else {
        setField(entry, 'status', 'sent');
      }
    }
    return null;
  };

  /** @param {string} clientMessageId */
  const markAcceptedEntry = (clientMessageId) => {
    const entry = userEntries.get(clientMessageId);
    if (!entry || !entry.local) return;
    setField(entry, 'accepted', true);
    if (entry.status === 'failed') setField(entry, 'status', containerOf.has(entry) ? 'sending' : 'queued');
    if (entry.status === 'sending' && containerOf.has(entry)) confirmLocal(entry, null);
  };

  /** @param {string} clientMessageId @param {unknown} error */
  const markFailedEntry = (clientMessageId, error) => {
    const entry = userEntries.get(clientMessageId);
    if (!entry || !entry.local) return;
    setField(entry, 'status', 'failed');
    setField(entry, 'error', errorText(error) || 'failed');
    const turn = containerOf.get(entry);
    // A turn that holds only this message never reached the SDK, so it is not running and the messages behind can go.
    if (turn && !turn.state.closed && turn.entries.every((item) => item.kind === 'user')) closeTurn(turn.state);
  };

  /** @param {string} clientMessageId */
  const discardEntry = (clientMessageId) => {
    const entry = userEntries.get(clientMessageId);
    if (!entry || !entry.local) return;
    userEntries.delete(clientMessageId);
    if (entry.uuid) userEntries.delete(entry.uuid);
    locals = locals.filter((item) => item !== entry);
    const waiting = queued.indexOf(entry);
    if (waiting >= 0) queued.splice(waiting, 1);
    const turn = containerOf.get(entry);
    if (turn) {
      containerOf.delete(entry);
      const index = turn.entries.indexOf(entry);
      if (index >= 0) turn.entries.splice(index, 1);
      if (entry.uuid && flowOfUuid.get(entry.uuid) === turn) flowOfUuid.delete(entry.uuid);
      if (turn.entries.length === 0) removeTurn(turn);
    }
    bump();
  };

  /** @param {Flow} flow */
  const removeTurn = (flow) => {
    turns = turns.filter((turn) => turn !== flow);
    if (current === flow) current = turns[turns.length - 1] ?? null;
  };

  /**
   * Confirmed local messages of a finished turn can no longer be echoed, so they stop being candidates for matching.
   * @param {Flow} flow
   */
  const pruneLocals = (flow) => {
    locals = locals.filter((entry) => !(entry.status === 'sent' && containerOf.get(entry) === flow));
  };

  /**
   * The runtime dropped a message that waited in its queue (message_cancelled). A message the runtime started is not
   * in the queue any more, so the cancellation leaves it alone.
   * @param {string} clientMessageId
   */
  const cancelQueuedEntry = (clientMessageId) => {
    const entry = userEntries.get(clientMessageId);
    if (!entry || !entry.local) return;
    if (entry.echoed && !queued.includes(entry)) return;
    discardEntry(clientMessageId);
  };

  // -------------------------------------------------------------------------------------------------------------------
  // Activity and todos (the composer's running line and todo bar)

  /**
   * The running tool card of a turn: the last tool in its own work groups that has no result yet.
   * @param {Flow} flow
   * @returns {Record<string, any>|null}
   */
  const runningToolOf = (flow) => {
    let found = null;
    for (const entry of flow.entries) {
      if (entry.kind !== 'work') continue;
      for (const item of entry.items) {
        if (item.kind === 'tool' && item.running) found = item;
      }
    }
    return found;
  };

  /**
   * One line for what the running turn does: the runtime's task summary, else the running tool described by the caller.
   * @returns {string|null}
   */
  const activityText = () => {
    if (activity) return activity;
    const tool = current ? runningToolOf(current) : null;
    if (!tool || typeof describeTool !== 'function') return null;
    const text = describeTool(tool);
    return typeof text === 'string' && text.trim() ? text.trim() : null;
  };

  /**
   * The running turn as the composer shows it, or null while the session is idle. `waiting` is true while a request
   * (a permission, a question, a plan or a dialog) waits for the user.
   * @returns {{running: boolean, startedAt: number, text: string|null, outputTokens: number, queued: number,
   *   waiting: boolean}|null}
   */
  const activityView = () => {
    if (!turnRunning() || !current) return null;
    let outputTokens = 0;
    for (const value of current.state.tokens.values()) outputTokens += value;
    return {
      running: true,
      startedAt: current.state.startedAt ?? 0,
      text: activityText(),
      outputTokens,
      queued: queued.length,
      waiting: pending.length > 0,
    };
  };

  /**
   * The latest TodoWrite of the main thread (subagent todo lists are not part of the turn's flow). Null when none.
   * @returns {Array<{content: string, activeForm: string, status: 'pending'|'in_progress'|'completed'}>|null}
   */
  const todosView = () => {
    let latest = null;
    for (const turn of turns) {
      for (const entry of turn.entries) {
        if (entry.kind !== 'work') continue;
        for (const item of entry.items) {
          if (item.kind === 'tool' && item.name === 'TodoWrite' && isObject(item.input) &&
              Array.isArray(item.input.todos)) {
            latest = item.input.todos;
          }
        }
      }
    }
    if (!latest) return null;
    /** @type {Array<{content: string, activeForm: string, status: 'pending'|'in_progress'|'completed'}>} */
    const todos = [];
    for (const todo of latest) {
      if (!isObject(todo) || typeof todo.content !== 'string' || !todo.content.trim()) continue;
      const content = todo.content.trim();
      const activeForm = typeof todo.activeForm === 'string' && todo.activeForm.trim()
        ? todo.activeForm.trim()
        : content;
      const status = todo.status === 'in_progress' || todo.status === 'completed' ? todo.status : 'pending';
      todos.push({ content, activeForm, status });
    }
    return todos;
  };

  /**
   * The user prompt a refusal dialog offers to edit: the message that started the turn the dialog belongs to.
   * @returns {string}
   */
  const promptOfCurrentTurn = () => {
    const turn = current ?? turns[turns.length - 1];
    if (!turn) return '';
    for (let index = turn.entries.length - 1; index >= 0; index -= 1) {
      const entry = turn.entries[index];
      if (entry.kind === 'user' && entry.text) return entry.text;
    }
    return '';
  };

  // -------------------------------------------------------------------------------------------------------------------
  // Public API

  return {
    /**
     * Appends a transcript page (oldest first).
     * @param {Array<Record<string, any>>} messages
     */
    loadTranscript(messages) {
      const operation = { op: 'transcript', messages: Array.isArray(messages) ? messages : [] };
      log.push(operation);
      apply(operation);
      relinkPending();
      applySessionState();
    },

    /**
     * Prepends an older transcript page (oldest first) and rebuilds the state from the operation log.
     * @param {Array<Record<string, any>>} messages
     */
    prependTranscript(messages) {
      log.unshift({ op: 'transcript', messages: Array.isArray(messages) ? messages : [] });
      replay();
    },

    /**
     * @param {Record<string, any>} msg a live SDK message, or a message from the snapshot's liveEvents
     * @param {number|null} [time] when the message arrived (epoch ms); null when that is not known, as for a snapshot's
     *   events. A live message is stamped with the time it is applied.
     */
    applyLiveEvent(msg, time = now()) {
      const operation = { op: 'live', msg, at: typeof time === 'number' ? time : null };
      log.push(operation);
      apply(operation);
      relinkPending();
    },

    /** @param {{clientMessageId: string, text: string, attachments?: unknown}} message */
    addOptimistic(message) {
      if (!isObject(message) || typeof message.clientMessageId !== 'string') return;
      const operation = {
        op: 'opt',
        at: now(),
        clientMessageId: message.clientMessageId,
        text: message.text,
        attachments: message.attachments,
      };
      log.push(operation);
      apply(operation);
    },

    /** @param {string} clientMessageId */
    markAccepted(clientMessageId) {
      const operation = { op: 'accepted', clientMessageId };
      log.push(operation);
      apply(operation);
    },

    /** @param {string} clientMessageId @param {unknown} error */
    markFailed(clientMessageId, error) {
      const operation = { op: 'failed', clientMessageId, error };
      log.push(operation);
      apply(operation);
    },

    /** Removes an optimistic message, e.g. before resending a failed one. @param {string} clientMessageId */
    discardOptimistic(clientMessageId) {
      const operation = { op: 'discard', clientMessageId };
      log.push(operation);
      apply(operation);
    },

    /**
     * Adds an inline error notice for a gateway notice the timeline shows (ENGINE_UNAVAILABLE). Kept in the log, so it
     * survives a replay.
     * @param {{code: string, level?: string, text?: string}} notice
     */
    applyNotice(notice) {
      if (!isObject(notice) || typeof notice.code !== 'string') return;
      const operation = {
        op: 'notice',
        code: notice.code,
        level: typeof notice.level === 'string' ? notice.level : 'error',
        text: String(notice.text ?? ''),
      };
      log.push(operation);
      apply(operation);
    },

    /** Replaces the pending request list. @param {Array<Record<string, any>>} requests */
    setPending(requests) {
      /** @type {Array<{request: Record<string, any>, version: number}>} */
      const next = [];
      for (const request of Array.isArray(requests) ? requests : []) {
        if (!isObject(request) || typeof request.id !== 'string') continue;
        arriving.delete(request.id);
        const previous = pending.find((entry) => entry.request.id === request.id);
        if (previous && previous.request === request) {
          next.push(previous);
        } else {
          const item = { request, version: 0 };
          touch(item);
          next.push(item);
        }
      }
      pending = next;
      for (const entry of next) known.set(entry.request.id, entry.request);
      relinkPending();
    },

    /**
     * A live request the page has just learned of. It waits in `arriving` until settlePending moves it to the pending
     * list the view shows, so a request the gateway resolves within the attention delay never shows: no card, no
     * buttons and no signal.
     * @param {Record<string, any>} request
     * @returns {boolean} true when the request is new
     */
    addPending(request) {
      if (!isObject(request) || typeof request.id !== 'string' || known.has(request.id)) return false;
      known.set(request.id, request);
      arriving.set(request.id, request);
      return true;
    },

    /**
     * A request has waited for the user for the attention delay: it joins the pending list and the render. Nothing
     * happens for a request that was resolved meanwhile.
     * @param {string} requestId
     */
    settlePending(requestId) {
      const request = arriving.get(requestId);
      if (!request) return;
      arriving.delete(requestId);
      const item = { request, version: 0 };
      touch(item);
      pending = [...pending, item];
      relinkPending();
    },

    /**
     * A request was answered or dropped. A refusal dialog that resolves evicts the refused messages it retracted,
     * without a marker: the retry replaces them. The eviction is logged, so a replay keeps it. With `auto`, the gateway
     * answered the request itself (unattended mode), and the timeline keeps one muted record of it.
     * @param {string} requestId
     * @param {{auto?: boolean}} [options]
     */
    resolvePending(requestId, { auto = false } = {}) {
      const request = known.get(requestId);
      known.delete(requestId);
      arriving.delete(requestId);
      pending = pending.filter((entry) => entry.request.id !== requestId);
      relinkPending();
      if (!request) return;
      if (auto) {
        const record = { op: 'auto', request };
        log.push(record);
        apply(record);
      }
      if (request.kind === 'dialog') {
        const uuids = Array.isArray(request.dialog?.retractedMessageUuids)
          ? request.dialog.retractedMessageUuids.filter((id) => typeof id === 'string' && id !== '')
          : [];
        if (uuids.length > 0) {
          const operation = { op: 'evict', uuids };
          log.push(operation);
          apply(operation);
        }
      }
    },

    /**
     * Removes a queued message the runtime dropped (message_cancelled). It is logged, so a replay keeps it gone.
     * @param {string} clientMessageId
     */
    cancelQueued(clientMessageId) {
      const operation = { op: 'cancel', clientMessageId };
      log.push(operation);
      apply(operation);
    },

    /**
     * Session state from the gateway or the SDK. An inactive state closes the current turn and drops the draft.
     * @param {string|null} state
     */
    setSessionState(state) {
      sessionState = typeof state === 'string' ? state : null;
      if (sessionState !== null && ACTIVE_STATES.has(sessionState)) {
        // The session now runs the message sent behind this pending turn (not yet while it only starts).
        if (current && current.state.sendPending && RUNNING_STATES.has(sessionState)) markLive(current.state);
        return;
      }
      applySessionState();
    },

    /** @returns {Array<Record<string, any>>} */
    getEntries() {
      /** @type {Array<Record<string, any>>} */
      const out = [];
      for (const turn of turns) {
        for (const entry of turn.entries) {
          // A work group with nothing in it has nothing to show.
          if (entry.kind === 'work' && entry.items.length === 0) continue;
          out.push(entry);
        }
      }
      if (draft) {
        const visible = draft.blocks.slice(draft.finalized).filter(Boolean);
        if (visible.length > 0) {
          out.push({
            kind: 'assistant',
            key: `d:${draft.messageId}`,
            uuid: null,
            messageId: draft.messageId,
            blocks: visible,
            streaming: true,
            error: null,
            aborted: false,
            version: draft.version,
          });
        }
      }
      for (const entry of pending) {
        const prompt = entry.request.kind === 'dialog' ? promptOfCurrentTurn() : '';
        out.push({
          kind: 'request', key: `req:${entry.request.id}`, request: entry.request, version: entry.version, prompt,
        });
      }
      out.push(...queued);
      return out;
    },

    /** @returns {number} increases on every model mutation */
    getVersion() {
      return counter;
    },

    /** Sent user messages that can be rewound to or forked from, oldest first. */
    getUserMessages() {
      /** @type {Array<{uuid: string, text: string, index: number}>} */
      const found = [];
      for (const turn of turns) {
        for (const entry of turn.entries) {
          if (entry.kind !== 'user' || entry.synthetic || !entry.uuid || entry.status !== 'sent') continue;
          if (!entry.text.trim()) continue;
          found.push({ uuid: entry.uuid, text: entry.text, index: found.length });
        }
      }
      return found;
    },

    /**
     * The latest TodoWrite of the main thread, or null when there is none (docs/FRONTEND.md).
     * @returns {Array<{content: string, activeForm: string, status: 'pending'|'in_progress'|'completed'}>|null}
     */
    getTodos() {
      return todosView();
    },

    /**
     * The running turn: its start, what it does, its output tokens, the queued messages, and whether a request waits
     * for the user (`waiting`). Null while idle.
     * @returns {{running: boolean, startedAt: number, text: string|null, outputTokens: number, queued: number,
     *   waiting: boolean}|null}
     */
    getActivity() {
      return activityView();
    },

    /**
     * activity: the runtime's one-line activity of the running turn, null when none is reported.
     * compactingSince: epoch ms when the compaction in progress started; null while none runs, and when its row was
     * replayed without a time (the view then counts from the session's start).
     * @returns {{running: boolean, status: string|null, compactResult: string|null, activity: string|null,
     *   compactingSince: number|null}}
     */
    getRunState() {
      return {
        running: turnRunning(),
        status: runStatus.status,
        compactResult: runStatus.compactResult,
        activity: turnRunning() ? activity : null,
        compactingSince: compacting ? compacting.entry.since : null,
      };
    },

    /**
     * Local messages that the transcript does not confirm yet (sending, queued or failed), oldest first. The view
     * restores them with addOptimistic after a reload, so they survive it.
     * @returns {Array<{clientMessageId: string, text: string, attachments: Array<Record<string, any>>,
     *   accepted: boolean, status: string, error: string|null}>}
     */
    getPendingUserMessages() {
      return locals
        .filter((entry) => entry.status !== 'sent')
        .map((entry) => ({
          clientMessageId: entry.clientMessageId,
          text: entry.text,
          attachments: entry.attachments,
          accepted: entry.accepted,
          status: entry.status,
          error: entry.error,
        }));
    },
  };
}
