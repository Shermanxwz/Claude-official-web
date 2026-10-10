/**
 * Unattended mode in the browser (docs/PROTOCOL.md, "Unattended mode"): the state the Settings switch and the header
 * show, whether this viewer may switch it, and the "waiting for you" signals. A request the gateway answers at once
 * never raises one: it counts as waiting only after ATTENTION_DELAY_MS unanswered. Pure functions and one timer helper,
 * no DOM; unit tested in Node (test/unit/unattended.test.mjs).
 */

/**
 * The gateway-wide switch (GET /api/unattended, the PUT answer, the unattended_changed event and
 * meta.features.unattended).
 * @typedef {Object} UnattendedState
 * @property {boolean} available           the switch can be on (bypass is allowed on this gateway)
 * @property {boolean} enabled             the switch is on; always false while unavailable
 * @property {'not-allowed'|'profile'|null} reason   why it is unavailable
 * @property {number|null} changedAt       when it was last switched, ms since epoch
 */

/**
 * How long a request must stay unanswered before it counts as waiting for the user. Within this time a request that
 * the gateway resolves (unattended mode answers at once) shows no card, badge, count or notification.
 */
export const ATTENTION_DELAY_MS = 300;

/**
 * @param {unknown} value
 * @returns {UnattendedState | null} null when the value is not a state
 */
export function normalizeUnattended(value) {
  if (typeof value !== 'object' || value === null) return null;
  const input = /** @type {Record<string, unknown>} */ (value);
  const available = input.available === true;
  return {
    available,
    // The switch is never on while it is unavailable (docs/PROTOCOL.md).
    enabled: available && input.enabled === true,
    reason: input.reason === 'not-allowed' || input.reason === 'profile' ? input.reason : null,
    changedAt: typeof input.changedAt === 'number' && Number.isFinite(input.changedAt) ? input.changedAt : null,
  };
}

/**
 * The newer of two states, by `changedAt`. An answer to a request sent before a change must not undo the change.
 * @param {UnattendedState | null | undefined} current
 * @param {UnattendedState | null} incoming
 * @returns {UnattendedState | null}
 */
export function newerUnattended(current, incoming) {
  if (!incoming) return current ?? null;
  if (!current) return incoming;
  return (incoming.changedAt ?? 0) >= (current.changedAt ?? 0) ? incoming : current;
}

/**
 * What the Settings switch shows: its state, whether this viewer may change it, and why not. Only the full access
 * profile switches it; the other profiles see it read-only with the reason.
 * @param {UnattendedState | null} unattended
 * @param {string | null} profile
 * @returns {{checked: boolean, disabled: boolean, reason: 'not-allowed'|'profile'|null}}
 */
export function unattendedSwitch(unattended, profile) {
  if (!unattended) return { checked: false, disabled: true, reason: null };
  if (unattended.available && profile === 'full') return { checked: unattended.enabled, disabled: false, reason: null };
  const reason = profile !== 'full' ? 'profile' : (unattended.reason ?? 'not-allowed');
  return { checked: unattended.enabled, disabled: true, reason };
}

/**
 * Whether the permission mode may change now. Shift+Tab and the composer's mode menu do nothing while unattended mode
 * is on, because every request is answered without a person.
 * @param {UnattendedState | null | undefined} unattended
 * @returns {boolean}
 */
export function modeCycleAllowed(unattended) {
  return unattended?.enabled !== true;
}

/**
 * The requests that have waited for the user for ATTENTION_DELAY_MS, counted per session. Sessions without any are
 * left out.
 * @param {Record<string, Array<{id: string}>>} pending the store's pending requests by session
 * @param {(requestId: string) => boolean} isSettled
 * @returns {Record<string, number>}
 */
export function waitingBySession(pending, isSettled) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const [sessionId, requests] of Object.entries(pending ?? {})) {
    if (!Array.isArray(requests)) continue;
    const waiting = requests.filter((request) => isSettled(request.id)).length;
    if (waiting > 0) counts[sessionId] = waiting;
  }
  return counts;
}

/**
 * How many requests of a session wait for the user now. A session whose requests the page has seen counts the settled
 * ones; a session it has not seen yet falls back to the gateway's own pending count.
 * @param {{pending: Record<string, unknown>, attention: Record<string, number>, live: Record<string, any>}} state
 * @param {string} sessionId
 * @returns {number}
 */
export function waitingCount(state, sessionId) {
  if (Array.isArray(state.pending?.[sessionId])) return state.attention?.[sessionId] ?? 0;
  return Number(state.live?.[sessionId]?.pendingCount) || 0;
}

/**
 * The state a session shows. "requires_action" (Needs you) only while a request waits for the user; until then the
 * session reads as running.
 * @param {{state: string} | null | undefined} live
 * @param {number} waiting
 * @returns {string | null}
 */
export function attentionState(live, waiting) {
  if (!live) return null;
  return live.state === 'requires_action' && waiting <= 0 ? 'running' : live.state;
}

/**
 * Tracks which requests have waited ATTENTION_DELAY_MS. `arrived` starts the delay for a live request; when the delay
 * ends unanswered, the request is settled and `onSettle` runs once. `resolved` cancels a delay still running, so a
 * request answered inside the delay never settles. `settleNow` marks requests the page learns of already waiting (a
 * snapshot): they count at once and raise no signal.
 * @param {{
 *   delayMs?: number,
 *   onSettle?: (request: Record<string, any>) => void,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (timer: unknown) => void,
 * }} [options]
 */
export function createAttentionTracker({
  delayMs = ATTENTION_DELAY_MS,
  onSettle = () => {},
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (timer) => clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (timer)),
} = {}) {
  /** @type {Map<string, {request: Record<string, any>, timer: unknown}>} */
  const arriving = new Map();
  /** @type {Set<string>} */
  const settled = new Set();

  return {
    /**
     * @param {Record<string, any>} request
     * @returns {boolean} true when the request started its delay
     */
    arrived(request) {
      const id = request?.id;
      if (typeof id !== 'string' || arriving.has(id) || settled.has(id)) return false;
      const timer = setTimer(() => {
        arriving.delete(id);
        settled.add(id);
        onSettle(request);
      }, delayMs);
      arriving.set(id, { request, timer });
      return true;
    },
    /** @param {Array<Record<string, any>>} requests requests that are already waiting */
    settleNow(requests) {
      for (const request of Array.isArray(requests) ? requests : []) {
        const id = request?.id;
        if (typeof id !== 'string') continue;
        const entry = arriving.get(id);
        if (entry) {
          clearTimer(entry.timer);
          arriving.delete(id);
        }
        settled.add(id);
      }
    },
    /**
     * @param {string} requestId
     * @returns {boolean} true when the request had been waiting for the user
     */
    resolved(requestId) {
      const entry = arriving.get(requestId);
      if (entry) {
        clearTimer(entry.timer);
        arriving.delete(requestId);
      }
      return settled.delete(requestId);
    },
    /** @param {string} requestId */
    isSettled(requestId) {
      return settled.has(requestId);
    },
    /** Forgets settled requests that are not in `keep` (a closed session's requests leave without a resolution). */
    prune(keep) {
      for (const id of [...settled]) {
        if (!keep.has(id)) settled.delete(id);
      }
    },
    /** Drops every delay and every settled request, without signals (the timeline reloads its session). */
    reset() {
      for (const entry of arriving.values()) clearTimer(entry.timer);
      arriving.clear();
      settled.clear();
    },
  };
}
