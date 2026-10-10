// @ts-check
/**
 * The live context meter of a session (docs/PROTOCOL.md "Context meter and compaction"). These are the transitions the
 * EngineHost applies to a session's meter as the runtime's messages arrive. They change the meter in place and never
 * publish: the host publishes the LiveInfo after each message, and that publish only happens when the meter changed.
 */

/** @typedef {import('../contracts.mjs').ContextMeter} ContextMeter */
/** @typedef {import('../contracts.mjs').ContextUsage} ContextUsage */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SDKMessage} SDKMessage */

/**
 * The API call whose usage is streaming. `prompt` is input + cache creation + cache read; `output` is the output tokens
 * reported so far for the call, which never decrease within it.
 * @typedef {{id: string|null, prompt: number, output: number}} CallUsage
 */

/**
 * The counters of one usage object. Each may be missing or null.
 * @typedef {{input_tokens?: number|null, cache_creation_input_tokens?: number|null,
 *   cache_read_input_tokens?: number|null, output_tokens?: number|null}} UsageCounters
 */

/** Rank of each source of `used`: a value is replaced only by a source that ranks at least as high. */
const RANK = /** @type {const} */ ({ stream: 3, count: 3, 'api-usage': 2, transcript: 1, estimate: 0 });

/**
 * A meter before anything is known.
 * @returns {ContextMeter}
 */
export function emptyContextMeter() {
  return {
    used: null,
    max: null,
    autoCompactAt: null,
    autoCompact: null,
    source: null,
    compacting: null,
    lastCompaction: null,
  };
}

/**
 * A copy of the meter that shares no object with it, for a LiveInfo that may be kept.
 * @param {ContextMeter} meter
 * @returns {ContextMeter}
 */
export function snapshotContextMeter(meter) {
  return {
    ...meter,
    compacting: meter.compacting === null ? null : { ...meter.compacting },
    lastCompaction: meter.lastCompaction === null ? null : { ...meter.lastCompaction },
  };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is number} whether the value is a finite number of zero or more
 */
function isCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * @param {unknown} value
 * @returns {number} the counter, or 0 when it is missing or not a count
 */
function counterOf(value) {
  return isCount(value) ? /** @type {number} */ (value) : 0;
}

/**
 * The input side and the output of one usage object. A usage without input tokens belongs to no API call (a synthetic
 * or interrupted message reports zeros), so it yields null.
 * @param {unknown} usage
 * @returns {{prompt: number, output: number}|null}
 */
export function callUsageOf(usage) {
  if (!isRecord(usage)) return null;
  const counts = /** @type {UsageCounters} */ (usage);
  const prompt = counterOf(counts.input_tokens) + counterOf(counts.cache_creation_input_tokens)
    + counterOf(counts.cache_read_input_tokens);
  if (prompt === 0) return null;
  return { prompt, output: counterOf(counts.output_tokens) };
}

/**
 * The tokens of one usage object: input + cache creation + cache read + output.
 * @param {unknown} usage
 * @returns {number|null} null when the usage belongs to no API call
 */
export function usageTokens(usage) {
  const call = callUsageOf(usage);
  return call === null ? null : call.prompt + call.output;
}

/**
 * Whether a message comes from a subagent: it names the tool call that started the subagent. Subagent messages never
 * count toward the context of the main thread.
 * @param {unknown} msg
 * @returns {boolean}
 */
export function isSubagentMessage(msg) {
  return typeof (/** @type {{parent_tool_use_id?: unknown}} */ (msg).parent_tool_use_id) === 'string';
}

/**
 * Whether a prompt is the /compact command, with or without instructions.
 * @param {string} text
 * @returns {boolean}
 */
export function isCompactPrompt(text) {
  return /^\/compact(?:\s|$)/.test(text.trim());
}

/**
 * Sets `used` from the stream: the tokens of the call so far.
 * @param {ContextMeter} meter
 * @param {CallUsage} call
 */
function showStream(meter, call) {
  meter.used = call.prompt + call.output;
  meter.source = 'stream';
}

/**
 * Opens a new API call. Its usage shows at once.
 * @param {ContextMeter} meter
 * @param {CallUsage} call
 * @returns {CallUsage}
 */
function openCall(meter, call) {
  showStream(meter, call);
  return call;
}

/**
 * Raises the output tokens of the call to `output` when it is higher than what the call already reported.
 * @param {ContextMeter} meter
 * @param {CallUsage} call
 * @param {number} output
 * @returns {CallUsage}
 */
function growCall(meter, call, output) {
  if (output <= call.output) return call;
  const grown = { ...call, output };
  showStream(meter, grown);
  return grown;
}

/**
 * Keeps `used` in step with one message. A main-thread message_start opens an API call, whose input side is what the
 * model saw; the output tokens then follow the call's message_delta and its assistant messages, never backwards. A
 * subagent message changes nothing. Returns the call the message belongs to, which the caller keeps for the next one.
 * @param {ContextMeter} meter
 * @param {CallUsage|null} call
 * @param {SDKMessage} msg
 * @returns {CallUsage|null}
 */
export function observeUsage(meter, call, msg) {
  if (isSubagentMessage(msg)) return call;
  if (msg.type === 'stream_event') {
    const event = msg.event;
    if (event?.type === 'message_start') {
      const usage = callUsageOf(event.message?.usage);
      if (usage === null) return call;
      return openCall(meter, { id: event.message.id ?? null, prompt: usage.prompt, output: usage.output });
    }
    if (event?.type === 'message_delta' && call !== null) {
      return growCall(meter, call, counterOf(event.usage?.output_tokens));
    }
    return call;
  }
  if (msg.type === 'assistant') {
    const usage = callUsageOf(msg.message?.usage);
    if (usage === null) return call;
    const id = msg.message.id;
    if (call !== null && call.id === id) return growCall(meter, call, usage.output);
    return openCall(meter, { id, prompt: usage.prompt, output: usage.output });
  }
  return call;
}

/**
 * Fills `used` from a source the stream has not supplied. The value is taken when its source ranks at least as high as
 * the current one, so an estimate never replaces a transcript value and nothing replaces a value from the stream.
 * @param {ContextMeter} meter
 * @param {number|null} tokens
 * @param {'api-usage'|'transcript'|'estimate'} source
 */
export function fillUsed(meter, tokens, source) {
  if (!isCount(tokens)) return;
  const current = meter.source === null ? -1 : RANK[meter.source];
  if (RANK[source] < current) return;
  meter.used = tokens;
  meter.source = source;
}

/**
 * Whether the API call the stream reports now started after a compaction. `atBoundary` is the call the stream reported
 * last before the compaction's boundary. A call with another id is newer, and any call is newer than none. Without an
 * id the objects are compared, which takes a grown copy of the boundary call for a newer one: observeUsage replaces the
 * object when its output grows, so the ids are what tell the calls apart.
 * @param {CallUsage|null} current the call the meter follows now
 * @param {CallUsage|null} atBoundary the call it followed when the boundary came
 * @returns {boolean}
 */
export function isNewerCall(current, atBoundary) {
  if (current === null) return false;
  if (atBoundary === null) return true;
  if (typeof current.id === 'string' && typeof atBoundary.id === 'string') return current.id !== atBoundary.id;
  return current !== atBoundary;
}

/**
 * Right after a compaction the size the stream reported no longer holds. The estimate is the fixed part of the context
 * (the summary's total) plus what the compaction leaves (post_tokens). Without both, the value stays, marked as an
 * estimate, so that a later fill may replace it.
 * @param {ContextMeter} meter
 * @param {number|null} fixedTokens
 * @param {number|null} postTokens
 */
export function estimateAfterCompaction(meter, fixedTokens, postTokens) {
  if (isCount(fixedTokens) && isCount(postTokens)) {
    meter.used = fixedTokens + postTokens;
    meter.source = 'estimate';
    return;
  }
  if (meter.used !== null) meter.source = 'estimate';
}

/**
 * The count of the whole context after a compaction (getContextUsage, full detail): it replaces the size the stream
 * reported before the compaction, which no longer holds. It is ignored when a new API call has reported since the
 * compaction, because that call's usage is newer.
 * @param {ContextMeter} meter
 * @param {number|null} tokens
 * @param {boolean} newerCall an API call started after the compaction
 */
export function countAfterCompaction(meter, tokens, newerCall) {
  if (!isCount(tokens) || newerCall) return;
  meter.used = tokens;
  meter.source = 'count';
}

/**
 * Takes the window and the auto-compact settings from a getContextUsage answer. A value the answer leaves out keeps the
 * one the meter had. The threshold applies only while auto-compact is on.
 * @param {ContextMeter} meter
 * @param {Pick<ContextUsage, 'maxTokens'|'autoCompactThreshold'|'isAutoCompactEnabled'>} usage
 */
export function applyWindow(meter, usage) {
  if (isCount(usage.maxTokens)) meter.max = usage.maxTokens;
  const enabled = typeof usage.isAutoCompactEnabled === 'boolean' ? usage.isAutoCompactEnabled : meter.autoCompact;
  meter.autoCompact = enabled;
  if (enabled === false) meter.autoCompactAt = null;
  if (enabled === true && isCount(usage.autoCompactThreshold)) meter.autoCompactAt = usage.autoCompactThreshold;
}

/**
 * The runtime starts a compaction (system/status 'compacting'). The first such status sets the state; a repeat keeps
 * it.
 * @param {ContextMeter} meter
 * @param {number} since
 * @param {'manual'|null} trigger 'manual' when the prompt that started the turn is /compact, else null
 */
export function startCompaction(meter, since, trigger) {
  if (meter.compacting === null) meter.compacting = { since, trigger };
}

/**
 * The compaction state ends (system/status with a null status), with or without a result.
 * @param {ContextMeter} meter
 */
export function endCompaction(meter) {
  meter.compacting = null;
}

/**
 * The size a compaction leaves in the context: post_tokens of its boundary's metadata, the runtime's estimate of the
 * messages that replace the conversation (the system prompt and the tools are not in it).
 * @param {unknown} metadata compact_metadata of the boundary
 * @returns {number|null} null when the metadata gives no size
 */
export function postTokensOf(metadata) {
  const info = isRecord(metadata) ? metadata : {};
  return isCount(info.post_tokens) ? info.post_tokens : null;
}

/**
 * The compact boundary of a finished compaction (system/compact_boundary). The boundary's own trigger wins; without
 * one the trigger of the start is kept, and 'auto' when there is none either. Without a size before the compaction
 * nothing is recorded. Either way the compaction is over.
 * @param {ContextMeter} meter
 * @param {unknown} metadata compact_metadata of the boundary
 * @param {number} at
 * @returns {boolean} whether lastCompaction was set
 */
export function recordCompaction(meter, metadata, at) {
  const started = meter.compacting === null ? null : meter.compacting.trigger;
  meter.compacting = null;
  const info = isRecord(metadata) ? metadata : {};
  if (!isCount(info.pre_tokens)) return false;
  const declared = info.trigger === 'manual' || info.trigger === 'auto' ? info.trigger : null;
  meter.lastCompaction = {
    trigger: declared ?? started ?? 'auto',
    preTokens: /** @type {number} */ (info.pre_tokens),
    postTokens: postTokensOf(metadata),
    durationMs: isCount(info.duration_ms) ? info.duration_ms : null,
    at,
  };
  return true;
}

/**
 * Whether a transcript entry starts the conversation over. Of a compaction, getSessionMessages keeps the summary's flag
 * (`isCompactSummary`) and a boundary record without its subtype. A boundary that still carries its subtype, at the top
 * level or in the message, counts too.
 * @param {unknown} entry
 * @returns {boolean}
 */
function isCompactionMarker(entry) {
  if (!isRecord(entry)) return false;
  if (entry.type === 'user') return entry.isCompactSummary === true;
  const message = isRecord(entry.message) ? entry.message : {};
  return entry.type === 'system' && (entry.subtype === 'compact_boundary' || message.subtype === 'compact_boundary');
}

/**
 * What a transcript says about the context of its session, read from the end. The tokens of the last main-thread API
 * call (see callUsageOf) count when no compaction comes after it. A compaction marker met first means the context was
 * compacted and no call has run since, so its size is not in the transcript: `tokens` is null and `compacted` is true.
 * Subagent messages never count. Without a call or a marker, both are empty.
 * @param {ReadonlyArray<unknown>} messages
 * @returns {{tokens: number|null, compacted: boolean}}
 */
export function transcriptContextOf(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    if (isCompactionMarker(entry)) return { tokens: null, compacted: true };
    if (!isRecord(entry) || entry.type !== 'assistant' || isSubagentMessage(entry)) continue;
    const tokens = usageTokens(isRecord(entry.message) ? entry.message.usage : undefined);
    if (tokens !== null) return { tokens, compacted: false };
  }
  return { tokens: null, compacted: false };
}
