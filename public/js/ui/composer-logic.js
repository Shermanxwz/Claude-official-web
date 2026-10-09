/**
 * Pure helpers for the header and composer: trigger detection, command ranking and merging, effort levels, draft keys,
 * byte formatting and send-shortcut decisions. No DOM access, so every function is unit-tested in Node.
 */

/**
 * @typedef {Object} Trigger
 * @property {'slash'|'mention'} type
 * @property {string} query   text typed after the trigger character, up to the caret
 * @property {number} start   index of the trigger character in the message text
 */

/**
 * A row shown by the slash palette: either a Claude Code command (`source: 'sdk'`) or a command the GUI implements
 * itself (`source: 'gui'`, identified by `guiId`).
 * @typedef {Object} CommandItem
 * @property {string} name
 * @property {string} description
 * @property {string} argumentHint
 * @property {string[]} aliases
 * @property {boolean} builtin
 * @property {'sdk'|'gui'} source
 * @property {string} [guiId]
 */

/**
 * @typedef {Object} GuiCommandSpec
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {string} [argumentHint]
 */

/** @typedef {'low'|'medium'|'high'|'xhigh'|'max'} EffortLevelName */

const WHITESPACE_RE = /\s/;
const EFFORT_ORDER = /** @type {const} */ (['low', 'medium', 'high', 'xhigh', 'max']);
const BYTE_UNITS = /** @type {const} */ (['B', 'KB', 'MB', 'GB', 'TB']);
const DRAFT_KEY_PREFIX = 'caw.draft.';

/**
 * Finds the completion trigger that the caret is inside, if any. `/` opens the slash palette only as the first
 * character of the whole message. `@` opens the mention palette at the start of a token: at the start of the text or
 * after any whitespace, newlines included. A query ends at the first whitespace, so a palette closes once the user
 * types a space.
 * @param {string} text
 * @param {number} caret
 * @returns {Trigger|null}
 */
export function detectTrigger(text, caret) {
  const value = typeof text === 'string' ? text : '';
  const position = Number.isFinite(caret) ? Math.min(Math.max(0, Math.trunc(caret)), value.length) : value.length;
  const before = value.slice(0, position);
  if (before.startsWith('/')) {
    const query = before.slice(1);
    if (!WHITESPACE_RE.test(query)) return { type: 'slash', query, start: 0 };
  }
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && !WHITESPACE_RE.test(before.charAt(at - 1))) return null;
  const query = before.slice(at + 1);
  return WHITESPACE_RE.test(query) ? null : { type: 'mention', query, start: at };
}

/**
 * Replaces the trigger text (from its start to the caret) with `replacement`, keeping whatever follows the caret.
 * @param {string} text
 * @param {Trigger} trigger
 * @param {number} caret
 * @param {string} replacement
 * @returns {{text: string, caret: number}}
 */
export function applyCompletion(text, trigger, caret, replacement) {
  const value = typeof text === 'string' ? text : '';
  const end = Math.min(Math.max(trigger.start, Math.trunc(caret)), value.length);
  const following = value.charAt(end);
  let insert = replacement;
  if (following !== '' && WHITESPACE_RE.test(following) && insert.endsWith(' ')) insert = insert.slice(0, -1);
  const next = value.slice(0, trigger.start) + insert + value.slice(end);
  return { text: next, caret: trigger.start + insert.length };
}

/**
 * Ranks a command against a lowercase query. Exact name beats name prefix, which beats alias prefix, name substring
 * and finally an in-order (fuzzy) match, where tighter matches score higher. Returns 0 when nothing matches.
 * @param {CommandItem} item
 * @param {string} query  lowercase, non-empty
 * @returns {number}
 */
function scoreCommand(item, query) {
  const name = item.name.toLowerCase();
  if (name === query) return 100;
  if (name.startsWith(query)) return 80;
  if (item.aliases.some((alias) => alias.toLowerCase().startsWith(query))) return 70;
  if (name.includes(query)) return 50;
  let at = 0;
  let first = -1;
  for (const ch of query) {
    const found = name.indexOf(ch, at);
    if (found < 0) return 0;
    if (first < 0) first = found;
    at = found + 1;
  }
  const gaps = at - first - query.length;
  return Math.max(1, 20 - gaps);
}

/**
 * Filters and orders palette rows. An empty query keeps the given order. Otherwise rows are sorted by score, then by
 * their original position, so equal matches keep the order the caller chose.
 * @template {CommandItem} T
 * @param {T[]} items
 * @param {string} query
 * @returns {T[]}
 */
export function filterCommands(items, query) {
  const list = Array.isArray(items) ? items : [];
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (!needle) return list.slice();
  return list
    .map((item, index) => ({ item, index, score: scoreCommand(item, needle) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((row) => row.item);
}

/**
 * Builds the slash palette rows: GUI commands first, then Claude Code commands. A GUI command is dropped when a Claude
 * Code command or alias already uses its name, so `/model` never appears twice.
 * @param {Array<{name?: string, description?: string, argumentHint?: string, aliases?: string[], builtin?: boolean}>}
 *   sdkCommands  capabilities.commands
 * @param {GuiCommandSpec[]} guiCommands
 * @returns {CommandItem[]}
 */
export function mergeCommands(sdkCommands, guiCommands) {
  const sdk = (Array.isArray(sdkCommands) ? sdkCommands : [])
    .filter((cmd) => cmd && typeof cmd.name === 'string' && cmd.name.length > 0)
    .map((cmd) => ({
      name: cmd.name,
      description: typeof cmd.description === 'string' ? cmd.description : '',
      argumentHint: typeof cmd.argumentHint === 'string' ? cmd.argumentHint : '',
      aliases: Array.isArray(cmd.aliases) ? cmd.aliases.filter((alias) => typeof alias === 'string') : [],
      builtin: cmd.builtin === true,
      source: /** @type {const} */ ('sdk'),
    }));
  const taken = new Set();
  for (const cmd of sdk) {
    taken.add(cmd.name.toLowerCase());
    for (const alias of cmd.aliases) taken.add(alias.toLowerCase());
  }
  const gui = (Array.isArray(guiCommands) ? guiCommands : [])
    .filter((cmd) => cmd && typeof cmd.name === 'string' && !taken.has(cmd.name.toLowerCase()))
    .map((cmd) => ({
      name: cmd.name,
      description: cmd.description ?? '',
      argumentHint: cmd.argumentHint ?? '',
      aliases: [],
      builtin: false,
      source: /** @type {const} */ ('gui'),
      guiId: cmd.id,
    }));
  return [...gui, ...sdk];
}

/**
 * Effort levels a model accepts, in canonical order. Empty when the model does not support effort, so the header
 * hides the control.
 * @param {{supportsEffort?: boolean, supportedEffortLevels?: string[]} | null | undefined} model  ModelInfo
 * @returns {EffortLevelName[]}
 */
export function effortLevelsFor(model) {
  if (!model || model.supportsEffort === false) return [];
  const supported = Array.isArray(model.supportedEffortLevels) ? model.supportedEffortLevels : [];
  return EFFORT_ORDER.filter((level) => supported.includes(level));
}

/**
 * A ModelInfo row as the SDK reports it (only the fields the picker reads).
 * @typedef {Object} ModelRow
 * @property {string} value
 * @property {string} [resolvedModel]
 * @property {string} [displayName]
 * @property {string} [description]
 * @property {boolean} [supportsEffort]
 * @property {string[]} [supportedEffortLevels]
 * @property {boolean} [supportsFastMode]
 */

/** Characters that may follow a canonical model id in a concrete one: a date, a [1m] context tag, '@' for Vertex. */
const MODEL_SUFFIX_BOUNDARY = new Set(['-', '[', '@', ':']);

/** @param {unknown} value */
function modelKey(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * When several rows match equally, the row named after the model wins over the 'default' pointer, so a concrete id
 * shows its own alias rather than "Default".
 * @param {ModelRow[]} rows
 * @returns {ModelRow|null}
 */
function preferNamed(rows) {
  return rows.find((row) => modelKey(row.value) !== 'default') ?? rows[0] ?? null;
}

/**
 * Finds the row a model id refers to. The SDK reports concrete ids such as 'claude-sonnet-4-5-20250929' while the rows
 * are keyed by alias ('sonnet', 'default'), so matching runs in three steps: an exact, case-insensitive match on
 * `value`; an exact match on `resolvedModel`; then the longest `resolvedModel` that the id extends at a suffix
 * boundary. A dated id therefore matches its canonical row, while 'claude-sonnet-4-50' does not match
 * 'claude-sonnet-4-5'.
 * @param {ModelRow[] | null | undefined} models
 * @param {string|null|undefined} key
 * @returns {ModelRow|null}
 */
export function findModelInfo(models, key) {
  const rows = Array.isArray(models) ? models.filter((row) => row && typeof row.value === 'string') : [];
  const needle = modelKey(key);
  if (!needle) return null;
  const byValue = rows.find((row) => modelKey(row.value) === needle);
  if (byValue) return byValue;
  const exact = preferNamed(rows.filter((row) => modelKey(row.resolvedModel) === needle));
  if (exact) return exact;
  let bestLength = 0;
  /** @type {ModelRow[]} */
  let best = [];
  for (const row of rows) {
    const resolved = modelKey(row.resolvedModel);
    if (!resolved || resolved.length < bestLength || !needle.startsWith(resolved)) continue;
    if (!MODEL_SUFFIX_BOUNDARY.has(needle.charAt(resolved.length))) continue;
    if (resolved.length > bestLength) {
      bestLength = resolved.length;
      best = [row];
    } else {
      best.push(row);
    }
  }
  return preferNamed(best);
}

/**
 * Contents of the model picker for one session. The current model is always a visible choice: its row when one
 * matches, otherwise the raw id as the first, selected option. The empty value stands for the account default.
 * @param {ModelRow[]} models
 * @param {string|null|undefined} current  the session's model id, or null for the account default
 * @param {{defaultLabel: string, currentLabel: (id: string) => string}} labels
 * @returns {{options: Array<{value: string, label: string, title: string}>, value: string, match: ModelRow|null}}
 */
export function modelSelectPlan(models, current, labels) {
  const rows = Array.isArray(models) ? models.filter((row) => row && typeof row.value === 'string' && row.value) : [];
  const id = typeof current === 'string' ? current.trim() : '';
  const match = findModelInfo(rows, id);
  /** @type {Array<{value: string, label: string, title: string}>} */
  const options = [];
  if (id && !match) options.push({ value: id, label: labels.currentLabel(id), title: id });
  options.push({ value: '', label: labels.defaultLabel, title: '' });
  for (const row of rows) {
    options.push({ value: row.value, label: row.displayName || row.value, title: row.description || '' });
  }
  return { options, value: match ? match.value : id, match };
}

/**
 * The model whose effort levels apply: the session's model when one is set, otherwise the account default. A set
 * model that is not listed has unknown effort support, so no default is substituted for it.
 * @param {ModelRow[]} models
 * @param {string|null|undefined} current
 * @param {string|null|undefined} defaultModel
 * @returns {ModelRow|null}
 */
export function effortModelFor(models, current, defaultModel) {
  const id = typeof current === 'string' && current.trim() ? current : defaultModel;
  return findModelInfo(models, id);
}

/**
 * What the Fast mode control shows for a session.
 * @typedef {Object} FastModeView
 * @property {boolean} visible  whether the control is shown at all
 * @property {boolean} pressed  whether fast mode is requested, or, when nothing is requested, running
 * @property {'on'|'cooldown'|'off'|null} state  what the runtime last reported; null when it has not said
 * @property {string|null} reason  why fast mode cannot serve (FastModeDisabledReason), or null
 */

/**
 * The Fast mode control for one session. `requested` is what the user chose (LiveInfo.fastMode: true, false, or null to
 * follow the settings), `runtime` what the runtime last reported (fastModeState) and `reason` the disabled reason. The
 * control is shown when the model supports fast mode, or while a request is on or the runtime is on or cooling down.
 * It is pressed when the request is on, or when nothing is requested and the runtime is on.
 * @param {{requested?: boolean|null, runtime?: string|null, reason?: string|null} | null | undefined} input
 * @param {boolean} supported  the model row the session uses reports supportsFastMode
 * @returns {FastModeView}
 */
export function fastModeView(input, supported) {
  const { requested = null, runtime = null, reason = null } = input ?? {};
  const state = runtime === 'on' || runtime === 'cooldown' || runtime === 'off' ? runtime : null;
  const asked = requested === true || requested === false ? requested : null;
  return {
    visible: supported === true || asked === true || state === 'on' || state === 'cooldown',
    pressed: asked === true || (asked === null && state === 'on'),
    state,
    reason: typeof reason === 'string' && reason !== '' ? reason : null,
  };
}

/**
 * localStorage key for a session's unsent draft, or null when the id is not usable.
 * @param {string|null|undefined} sessionId
 * @returns {string|null}
 */
export function draftKey(sessionId) {
  return typeof sessionId === 'string' && sessionId.length > 0 ? `${DRAFT_KEY_PREFIX}${sessionId}` : null;
}

/**
 * @param {number} value
 * @param {number} unit  index into BYTE_UNITS
 * @returns {string}
 */
function formatScaled(value, unit) {
  if (unit === 0) return String(Math.round(value));
  return value >= 10 ? value.toFixed(0) : value.toFixed(1);
}

/**
 * Human-readable size with binary units (1 KB = 1024 B). Rolls over to the next unit when rounding would print 1024.
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  let value = bytes;
  let unit = 0;
  while (unit < BYTE_UNITS.length - 1 && Number(formatScaled(value, unit)) >= 1024) {
    value /= 1024;
    unit += 1;
  }
  return `${formatScaled(value, unit)} ${BYTE_UNITS[unit]}`;
}

/**
 * Whether a keydown in the composer sends the message. Plain Enter sends on fine-pointer devices and Shift/Alt+Enter
 * insert a newline. Ctrl/Cmd+Enter always sends. Nothing sends while an IME composition is active, and touch devices
 * send only through the button.
 * @param {{key?: string, shiftKey?: boolean, altKey?: boolean, ctrlKey?: boolean, metaKey?: boolean,
 *   isComposing?: boolean, keyCode?: number}} event
 * @param {{coarse?: boolean}} [options]  coarse: the primary pointer is touch
 * @returns {boolean}
 */
export function isSendShortcut(event, { coarse = false } = {}) {
  if (!event || event.key !== 'Enter') return false;
  if (event.isComposing || event.keyCode === 229) return false;
  if (event.ctrlKey || event.metaKey) return true;
  if (coarse || event.shiftKey || event.altKey) return false;
  return true;
}

/**
 * The parts of an attachment chip that a composer mount resets when another mount takes the chip over.
 * @typedef {Object} DetachableChip
 * @property {string} status
 * @property {number} progress
 * @property {string|null} error
 * @property {boolean} retryable
 * @property {AbortController|null} controller
 * @property {unknown} el
 */

/**
 * Hands an attachment chip over to a composer that did not render it. DOM references belong to the old mount and are
 * dropped. An upload that was still running cannot finish without that mount, so it is cut short: the chip keeps its
 * file, name, kind, path and thumbnail, offers a retry, and has no message yet, so the message is chosen in the
 * current language when the chip renders. Returns the controller of the cut-short upload, which the caller aborts.
 * @param {DetachableChip} chip
 * @returns {AbortController|null}
 */
export function detachChip(chip) {
  chip.el = null;
  if (chip.status !== 'uploading') return null;
  const running = chip.controller ?? null;
  chip.controller = null;
  chip.status = 'error';
  chip.progress = 0;
  chip.error = null;
  chip.retryable = true;
  return running;
}

/**
 * Puts a message that was not sent back in front of the text already typed, on a line of its own. An empty message
 * changes nothing, and whitespace-only text is replaced.
 * @param {string} restored
 * @param {string|null|undefined} current
 * @returns {string}
 */
export function joinRestoredText(restored, current) {
  const before = typeof current === 'string' ? current : '';
  if (!restored) return before;
  return before.trim() ? `${restored}\n${before}` : restored;
}
