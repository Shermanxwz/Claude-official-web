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
 *                                   elapsedSeconds}
 *                      row item  = {kind:'row', key, rowKind:'hook'|'task'|'denied', ...fields}
 *  - notice:         { level:'info'|'warning'|'error'|'muted', code, text, vars }
 *  - divider:        { variant:'compact'|'clear', preTokens, trigger }
 *  - command-output: { text }
 *  - result:         { subtype, durationMs, durationApiMs, numTurns, isError, interrupted, errors,
 *                      permissionDenials: [{toolName}], terminalReason, totalCostUsd }
 *  - request:        { request }   (PendingRequest, placed after the active turn)
 *  - generic:        { label, raw }   (unknown types, shown as collapsed JSON)
 *
 * Inputs are kept in an operation log, so an older transcript page can be prepended (prependTranscript) and the
 * state rebuilt. Pending requests and the session state are applied on top of the replayed state.
 */

import { stripAnsi } from './format.js';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const BASE64_RE = /^[A-Za-z0-9+/=\s]+$/;
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const ACTIVE_STATES = new Set(['starting', 'running', 'requires_action']);
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

/**
 * @typedef {Object} Turn   state shared by a turn's main flow and the child flows of its subagents
 * @property {boolean} live        set once live (non-transcript) activity was seen for the turn
 * @property {boolean} closed      set by a result, an inactive session state or a conversation reset
 * @property {boolean} sendPending set while a message sent from this browser waits for the session to report running
 * @property {Flow|null} main
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
 * Creates an independent timeline model.
 * @returns {{
 *   loadTranscript: (messages: Array<Record<string, any>>) => void,
 *   prependTranscript: (messages: Array<Record<string, any>>) => void,
 *   applyLiveEvent: (msg: Record<string, any>) => void,
 *   addOptimistic: (message: {clientMessageId: string, text: string, attachments?: unknown}) => void,
 *   markAccepted: (clientMessageId: string) => void,
 *   markFailed: (clientMessageId: string, error: unknown) => void,
 *   discardOptimistic: (clientMessageId: string) => void,
 *   setPending: (requests: Array<Record<string, any>>) => void,
 *   resolvePending: (requestId: string) => void,
 *   setSessionState: (state: string|null) => void,
 *   getEntries: () => Array<Record<string, any>>,
 *   getVersion: () => number,
 *   getUserMessages: () => Array<{uuid: string, text: string, index: number}>,
 *   getPendingUserMessages: () => Array<{clientMessageId: string, text: string, attachments: Array<Record<string, any>>,
 *                                        accepted: boolean, status: string, error: string|null}>,
 *   getRunState: () => {running: boolean, status: string|null, compactResult: string|null}
 * }}
 */
export function createModel() {
  /** @type {Array<{op: string, [key: string]: any}>} */
  let log = [];
  let counter = 0;
  let seq = 0;

  /** @type {Flow[]} */
  let turns = [];
  /** @type {Flow|null} */
  let current = null;
  /** @type {Flow|null} the turn the SDK message being applied names through its user message uuid(s), else null */
  let named = null;
  /** @type {{messageId: string, blocks: Array<Record<string, any>|undefined>, finalized: number, stopped: boolean, version: number}|null} */
  let draft = null;
  /** @type {Map<string, Record<string, any>>} */
  let toolIndex = new Map();
  /** @type {Map<Object, Flow>} */
  let containerOf = new Map();
  /** @type {Map<Object, Record<string, any>>} */
  let groupOf = new Map();
  /** @type {Map<Object, Flow>} */
  let childFlowOf = new Map();
  /** @type {Map<string, Record<string, any>>} */
  let rowIndex = new Map();
  /** @type {Map<string, Flow>} */
  let flowOfUuid = new Map();
  /** @type {Map<string, number>} */
  let bubbleCount = new Map();
  /** @type {Map<string, Array<{raw: any, live: boolean}>>} */
  let orphans = new Map();
  /** @type {Map<string, ToolResult & {structured?: unknown}>} */
  let pendingResults = new Map();
  /** @type {Array<Record<string, any>>} local user messages that wait behind a running turn, oldest first */
  let queued = [];
  /** @type {Array<Record<string, any>>} local user messages not yet pruned, oldest first */
  let locals = [];
  /** @type {Map<string, Record<string, any>>} user entries by clientMessageId and by uuid */
  let userEntries = new Map();
  let runStatus = { status: null, compactResult: null };
  /** @type {Array<{request: Record<string, any>, version: number}>} */
  let pending = [];
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

  /** @param {Object} obj @param {string} field @param {unknown} value */
  const setField = (obj, field, value) => {
    if (obj[field] !== value) {
      obj[field] = value;
      touch(obj);
    }
  };

  /** @param {string} prefix @param {string|null} uuid */
  const nextKey = (prefix, uuid) => {
    seq += 1;
    return uuid ? `${prefix}:${uuid}` : `${prefix}#${seq}`;
  };

  /** @param {unknown} value @returns {value is Record<string, any>} */
  const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

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
      return { result: { content: String(body.error_code ?? 'error'), isError: true, images: [] }, structured: undefined };
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
    const state = { live: false, closed: false, sendPending: false, main: null };
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

  /** @param {Record<string, any>} group */
  const refreshGroup = (group) => {
    const tools = group.items.filter((item) => item.kind === 'tool');
    setField(group, 'count', tools.length);
    setField(group, 'running', tools.some((item) => item.running));
  };

  /** @param {Flow} flow */
  const syncFlow = (flow) => {
    const open = flowOpen(flow);
    for (const entry of flow.entries) {
      if (entry.kind !== 'work') continue;
      for (const item of entry.items) {
        if (item.kind !== 'tool') continue;
        setField(item, 'running', item.result == null && open);
        const child = childFlowOf.get(item);
        if (child) syncFlow(child);
      }
      setField(entry, 'open', open);
      refreshGroup(entry);
    }
  };

  /** @param {Turn} state */
  const markLive = (state) => {
    if (state.live) return;
    state.live = true;
    state.sendPending = false;
    if (state.main) syncFlow(state.main);
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
    return entry;
  };

  /** @param {Flow} flow @param {Record<string, any>} item */
  const appendWorkItem = (flow, item) => {
    const last = flow.entries[flow.entries.length - 1];
    let group = last && last.kind === 'work' ? last : null;
    if (!group) {
      group = pushEntry(flow, { kind: 'work', key: `w:${item.key}`, label: null, count: 0, items: [], open: false, running: false });
    }
    group.items.push(item);
    containerOf.set(item, flow);
    groupOf.set(item, group);
    if (item.kind === 'tool') setField(item, 'running', item.result == null && flowOpen(flow));
    setField(group, 'open', flowOpen(flow));
    refreshGroup(group);
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
   * @param {{id: string, name: string, input: unknown}} spec
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
      version: 0,
    };
    touch(item);
    toolIndex.set(id, item);
    appendWorkItem(flow, item);
    if (AGENT_TOOLS.has(item.name)) ensureChildFlow(item);
    if (pendingResults.has(id)) {
      const queued = pendingResults.get(id);
      pendingResults.delete(id);
      applyResult(item, queued, queued.structured);
    }
    drainOrphans(id);
    return item;
  };

  /**
   * @param {Record<string, any>} item
   * @param {ToolResult} result
   * @param {unknown} [structured]
   */
  const applyResult = (item, result, structured) => {
    if (item.result) return;
    item.result = { content: result.content, isError: result.isError, images: result.images ?? [] };
    if (structured !== undefined) item.structured = structured;
    touch(item);
    setField(item, 'running', false);
    const group = groupOf.get(item);
    if (group) refreshGroup(group);
    const child = childFlowOf.get(item);
    if (child) syncFlow(child);
  };

  /** @param {string} id @param {ToolResult} result @param {unknown} [structured] */
  const deliverResult = (id, result, structured) => {
    const item = toolIndex.get(id);
    if (item) applyResult(item, result, structured);
    else pendingResults.set(id, Object.assign({}, result, { structured }));
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

  /** @param {Flow} flow @param {string} level @param {string} code @param {Record<string, any>} vars @param {string} text @param {string|null} key */
  const addNotice = (flow, level, code, vars, text, key) => {
    pushEntry(flow, { kind: 'notice', key: key ?? nextKey('n', null), level, code, text, vars });
    return flow;
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
    pushEntry(flow, { kind: 'generic', key: nextKey('g', uuid), label: text || 'unknown', raw });
    return flow;
  };

  // ---------------------------------------------------------------------------------------------------------------
  // Message handlers. Each returns the flow it wrote to, or null when it wrote nothing.

  /** @param {Record<string, any>} raw @param {boolean} live @returns {Flow|null} */
  const onUser = (raw, live) => {
    const message = isObject(raw.message) ? raw.message : {};
    const blocks = normalizeContent(message.content);
    const toolResults = blocks.filter((block) => block.type === 'tool_result');
    const rest = blocks.filter((block) => block.type !== 'tool_result');
    for (const block of toolResults) {
      const structured = toolResults.length === 1 && raw.tool_use_result !== undefined ? raw.tool_use_result : undefined;
      deliverResult(String(block.tool_use_id ?? ''), toolResultFrom(block), structured);
    }
    if (toolResults.length > 0 && rest.length === 0) return current ?? null;

    const rawText = rest
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n');
    const visible = stripReminders(rawText);
    const images = rest.map((block) => (block.type === 'image' ? imageFrom(block) : null)).filter(Boolean);
    const origin = isObject(raw.origin) ? raw.origin : null;
    const uuid = typeof raw.uuid === 'string' ? raw.uuid : null;

    const interrupt = INTERRUPT_NOTICES.get(visible.trim());
    if (interrupt) {
      const flow = live ? liveFlow() : baseFlow();
      addNotice(flow, 'muted', interrupt, {}, '', nextKey('n', uuid));
      return flow;
    }

    if (raw.isSynthetic === true || raw.is_meta === true || raw.isCompactSummary === true ||
        (origin && typeof origin.kind === 'string' && origin.kind !== 'human')) {
      const flow = live ? liveFlow() : baseFlow();
      addNotice(flow, 'muted', 'user-meta', { source: origin && typeof origin.kind === 'string' ? origin.kind : 'synthetic' },
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
      appendBubble(flow, { kind: 'thinking', text: String(block.thinking ?? ''), redacted: false }, messageId, uuid, raw);
    } else if (type === 'redacted_thinking') {
      appendBubble(flow, { kind: 'thinking', text: '', redacted: true }, messageId, uuid, raw);
    } else if (type === 'tool_use') {
      addTool(flow, { id: String(block.id ?? ''), name: String(block.name ?? 'tool'), input: block.input });
    } else if (type === 'server_tool_use' && block.name === 'web_search') {
      const input = isObject(block.input) ? block.input : {};
      addTool(flow, { id: String(block.id ?? ''), name: 'WebSearch', input: { query: input.query ?? '' } });
    } else if (type === 'web_search_tool_result') {
      const id = String(block.tool_use_id ?? '');
      const card = toolIndex.get(id) ?? addTool(flow, { id, name: 'WebSearch', input: {} });
      const { result, structured } = webSearchResultFrom(block);
      applyResult(card, result, structured);
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
    if (live && draft && messageId === draft.messageId) {
      draft.finalized += content.length;
      touch(draft);
      maybeClearDraft();
    }
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
      Object.assign(fields, { description: String(raw.description ?? ''), status: 'running', subagentType: raw.subagent_type ?? null });
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
        if (raw.compact_result === 'failed') {
          const flow = baseFlow();
          return addNotice(flow, 'error', 'compact-failed', {},
            typeof raw.compact_error === 'string' ? raw.compact_error : '', uuid ? `n:${uuid}` : null);
        }
        return null;
      }
      case 'compact_boundary': {
        const flow = live ? liveFlow() : baseFlow();
        const meta = isObject(raw.compact_metadata) ? raw.compact_metadata
          : (isObject(raw.compactMetadata) ? raw.compactMetadata : {});
        const preTokens = typeof meta.pre_tokens === 'number' ? meta.pre_tokens
          : (typeof meta.preTokens === 'number' ? meta.preTokens : null);
        pushEntry(flow, {
          kind: 'divider',
          key: nextKey('dv', uuid),
          variant: 'compact',
          preTokens,
          trigger: typeof meta.trigger === 'string' ? meta.trigger : null,
        });
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
        pushEntry(flow, { kind: 'command-output', key: nextKey('c', uuid), text: stripAnsi(String(raw.content ?? '')) });
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
    const denials = Array.isArray(raw.permission_denials)
      ? raw.permission_denials.filter(isObject).map((denial) => ({ toolName: String(denial.tool_name ?? '') }))
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
    if (!draft) draft = { messageId, blocks: [], finalized: 0, stopped: false, version: 0 };
  };

  /** @param {number} index @param {Record<string, any>} block */
  const makeDraftBlock = (index, block) => {
    const key = `d:${draft ? draft.messageId : 'stream'}/${index}`;
    const type = block.type;
    let made;
    if (type === 'text') made = { key, kind: 'text', text: String(block.text ?? '') };
    else if (type === 'thinking') made = { key, kind: 'thinking', text: String(block.thinking ?? ''), redacted: false };
    else if (type === 'redacted_thinking') made = { key, kind: 'thinking', text: '', redacted: true };
    else if (type === 'tool_use' || type === 'server_tool_use') made = { key, kind: 'tool-draft', name: String(block.name ?? 'tool'), partial: '' };
    else made = { key, kind: 'generic', raw: block, label: String(type ?? 'block') };
    touch(made);
    return made;
  };

  /** @param {Record<string, any>} block @param {Record<string, any>} delta */
  const applyDelta = (block, delta) => {
    if (delta.type === 'text_delta' && block.kind === 'text') block.text += String(delta.text ?? '');
    else if (delta.type === 'thinking_delta' && block.kind === 'thinking') block.text += String(delta.thinking ?? '');
    else if (delta.type === 'input_json_delta' && block.kind === 'tool-draft') block.partial += String(delta.partial_json ?? '');
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
        const id = isObject(event.message) && typeof event.message.id === 'string' ? event.message.id : nextKey('stream', null);
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
    if (typeof raw.elapsed_time_seconds === 'number') setField(item, 'elapsedSeconds', raw.elapsed_time_seconds);
    return flow;
  };

  /** @param {Record<string, any>} raw */
  const onSummary = (raw) => {
    const ids = Array.isArray(raw.preceding_tool_use_ids) ? raw.preceding_tool_use_ids : [];
    for (const id of ids) {
      const item = toolIndex.get(String(id));
      const group = item ? groupOf.get(item) : null;
      if (group) {
        setField(group, 'label', String(raw.summary ?? ''));
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
    if (raw.type === 'assistant' || raw.type === 'user' || raw.type === 'stream_event' || raw.type === 'tool_progress') return true;
    if (raw.type !== 'system') return false;
    if (raw.subtype === 'status') return Boolean(raw.status);
    return raw.subtype === 'api_retry' || raw.subtype === 'permission_denied' || String(raw.subtype).startsWith('hook_');
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
    if (uuid && flowOfUuid.has(uuid)) {
      const known = flowOfUuid.get(uuid);
      if (live && known) {
        if (isActivity(raw)) markLive(known.state);
        // A subagent's flow is not a turn: the turn it belongs to becomes current.
        current = known.state.main ?? known;
      }
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
    rowIndex = new Map();
    flowOfUuid = new Map();
    bubbleCount = new Map();
    orphans = new Map();
    pendingResults = new Map();
    queued = [];
    locals = [];
    userEntries = new Map();
    runStatus = { status: null, compactResult: null };
  };

  const relinkPending = () => {
    const wanted = new Map();
    for (const entry of pending) {
      const toolUseId = entry.request.toolUseId;
      if (typeof toolUseId === 'string') wanted.set(toolUseId, entry.request.id);
    }
    for (const item of toolIndex.values()) setField(item, 'pendingRequestId', wanted.get(item.id) ?? null);
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
   * that does not yet keeps it pending until it reports running.
   * @param {Record<string, any>} entry
   */
  const startLocalTurn = (entry) => {
    const turn = newTurn();
    turn.state.sendPending = true;
    placeUser(turn, entry);
    if (sessionState === null || ACTIVE_STATES.has(sessionState)) markLive(turn.state);
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
    if (!turn) {
      // Still queued: the SDK has started the message, so it joins the running turn.
      const waiting = queued.indexOf(entry);
      if (waiting >= 0) queued.splice(waiting, 1);
      if (turnRunning() && current) {
        turn = current;
      } else {
        turn = newTurn();
        markLive(turn.state);
      }
      placeUser(turn, entry);
      bump();
    }
    confirmLocal(entry, uuid);
    return turn;
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
    // A turn that holds only this message never reached the SDK, so it is not running and the messages behind it can go.
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

  // ---------------------------------------------------------------------------------------------------------------
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

    /** @param {Record<string, any>} msg a live SDK message, or a message from the snapshot's liveEvents */
    applyLiveEvent(msg) {
      log.push({ op: 'live', msg });
      guard(() => ingest(msg, true), msg, true);
      relinkPending();
    },

    /** @param {{clientMessageId: string, text: string, attachments?: unknown}} message */
    addOptimistic(message) {
      if (!isObject(message) || typeof message.clientMessageId !== 'string') return;
      const operation = {
        op: 'opt',
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

    /** Replaces the pending request list. @param {Array<Record<string, any>>} requests */
    setPending(requests) {
      /** @type {Array<{request: Record<string, any>, version: number}>} */
      const next = [];
      for (const request of Array.isArray(requests) ? requests : []) {
        if (!isObject(request) || typeof request.id !== 'string') continue;
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
      relinkPending();
    },

    /** @param {string} requestId */
    resolvePending(requestId) {
      pending = pending.filter((entry) => entry.request.id !== requestId);
      relinkPending();
    },

    /**
     * Session state from the gateway or the SDK. An inactive state closes the current turn and drops the draft.
     * @param {string|null} state
     */
    setSessionState(state) {
      sessionState = typeof state === 'string' ? state : null;
      if (sessionState !== null && ACTIVE_STATES.has(sessionState)) {
        // The session now runs the message sent behind this pending turn.
        if (current && current.state.sendPending) markLive(current.state);
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
        out.push({ kind: 'request', key: `req:${entry.request.id}`, request: entry.request, version: entry.version });
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

    /** @returns {{running: boolean, status: string|null, compactResult: string|null}} */
    getRunState() {
      return { running: turnRunning(), status: runStatus.status, compactResult: runStatus.compactResult };
    },

    /**
     * Local messages that the transcript does not confirm yet (sending, queued or failed), oldest first. The view
     * restores them with addOptimistic after a reload, so they survive it.
     * @returns {Array<{clientMessageId: string, text: string, attachments: Array<Record<string, any>>, accepted: boolean, status: string, error: string|null}>}
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
