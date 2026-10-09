// @ts-check
/**
 * Pending interactive requests (permission prompts, questions, plan approvals, MCP elicitations). The SDK callback
 * waits on a promise here until the browser answers through POST /api/sessions/:id/requests/:requestId, the SDK
 * aborts the request, or the session closes. Bodies are validated per kind (docs/PROTOCOL.md) before they settle.
 */

import { AppError } from '../contracts.mjs';

/** @typedef {import('../contracts.mjs').PendingRequest} PendingRequest */
/** @typedef {import('../contracts.mjs').Publish} Publish */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').PermissionResult} PermissionResult */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').PermissionUpdate[]} PermissionUpdateList */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').ElicitationResult} ElicitationResult */
/** @typedef {Record<string, any>} RequestBody  a validated, normalized body for one request kind */
/** @typedef {{cancelled: true} | {body: RequestBody}} RequestOutcome */
/** @typedef {'allowed'|'denied'|'answered'|'cancelled'} ResolutionOutcome */

const MESSAGE_MAX = 2000;
const TEXT_MAX = 10000;
const DENIED_MESSAGE = 'The user denied this action.';
const CANCELLED_MESSAGE = 'Request cancelled.';
const QUESTION_DECLINED_MESSAGE = 'The user declined to answer.';
const PLAN_REJECTED_MESSAGE = 'The user rejected the plan. Revise it.';
const PERMISSION_KEYS = ['decision', 'message', 'updatedInput', 'suggestionIndexes', 'interrupt'];
const PLAN_NEXT_MODES = ['default', 'acceptEdits', 'auto'];

/**
 * @typedef {Object} RegistryEntry
 * @property {PendingRequest} request
 * @property {(result: RequestOutcome) => void} resolve
 * @property {() => void} detach   removes the abort listener
 */

/**
 * @param {string} message
 * @returns {AppError}
 */
function badRequest(message) {
  return new AppError(400, 'BAD_REQUEST', message);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * @param {Record<string, unknown>} body
 * @param {string[]} allowed
 */
function assertKeys(body, allowed) {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw badRequest('The request body contains an unknown field.');
  }
}

/**
 * @param {Record<string, unknown>} body
 * @param {string} key
 * @param {number} max
 * @returns {string|undefined}
 */
function optionalString(body, key, max) {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max) {
    throw badRequest(`${key} must be a string of at most ${max} characters.`);
  }
  return value;
}

/**
 * @param {Record<string, unknown>} body
 * @param {string} key
 * @returns {boolean|undefined}
 */
function optionalBoolean(body, key) {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw badRequest(`${key} must be a boolean.`);
  return value;
}

/**
 * @param {Record<string, unknown>} body
 * @param {string} key
 * @returns {Record<string, unknown>|undefined}
 */
function optionalPlainObject(body, key) {
  const value = body[key];
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) throw badRequest(`${key} must be an object.`);
  return value;
}

/**
 * @param {Record<string, unknown>} body
 * @param {number} count number of suggestions the request offers
 * @returns {number[]|undefined}
 */
function optionalSuggestionIndexes(body, count) {
  const value = body.suggestionIndexes;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > count) {
    throw badRequest('suggestionIndexes must list existing suggestions.');
  }
  const seen = new Set();
  for (const index of value) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= count || seen.has(index)) {
      throw badRequest('suggestionIndexes must reference existing suggestions, each at most once.');
    }
    seen.add(index);
  }
  return [...value];
}

/**
 * @param {PendingRequest} request
 * @param {Record<string, unknown>} body
 * @returns {{body: RequestBody, outcome: ResolutionOutcome}}
 */
function normalizePermission(request, body) {
  assertKeys(body, PERMISSION_KEYS);
  const decision = body.decision;
  if (decision !== 'allow' && decision !== 'allow_always' && decision !== 'deny') {
    throw badRequest('decision must be "allow", "allow_always" or "deny".');
  }
  if (decision === 'allow_always' && request.suppressAlwaysAllowRule === true) {
    throw badRequest('This request cannot be allowed permanently.');
  }
  const suggestions = Array.isArray(request.suggestions) ? request.suggestions : [];
  /** @type {RequestBody} */
  const normalized = { decision };
  const message = optionalString(body, 'message', MESSAGE_MAX);
  if (message !== undefined) normalized.message = message;
  const updatedInput = optionalPlainObject(body, 'updatedInput');
  if (updatedInput !== undefined) normalized.updatedInput = updatedInput;
  const suggestionIndexes = optionalSuggestionIndexes(body, suggestions.length);
  if (suggestionIndexes !== undefined) normalized.suggestionIndexes = suggestionIndexes;
  const interrupt = optionalBoolean(body, 'interrupt');
  if (interrupt !== undefined) normalized.interrupt = interrupt;
  return { body: normalized, outcome: decision === 'deny' ? 'denied' : 'allowed' };
}

/**
 * @param {unknown} value
 * @returns {Record<string, string | string[]>}
 */
function normalizeAnswers(value) {
  if (!isPlainObject(value)) throw badRequest('answers must be an object mapping each question to its answer.');
  const entries = Object.entries(value).map(([question, answer]) => {
    if (typeof answer === 'string') return [question, answer];
    if (Array.isArray(answer) && answer.every((item) => typeof item === 'string')) return [question, [...answer]];
    throw badRequest('Each answer must be a string or an array of strings.');
  });
  return Object.fromEntries(entries);
}

/**
 * @param {Record<string, unknown>} body
 * @returns {{body: RequestBody, outcome: ResolutionOutcome}}
 */
function normalizeQuestion(body) {
  if (Object.hasOwn(body, 'decline')) {
    assertKeys(body, ['decline']);
    if (body.decline !== true) throw badRequest('decline must be true.');
    return { body: { decline: true }, outcome: 'denied' };
  }
  assertKeys(body, ['answers', 'response']);
  /** @type {RequestBody} */
  const normalized = { answers: normalizeAnswers(body.answers) };
  const response = optionalString(body, 'response', TEXT_MAX);
  if (response !== undefined) normalized.response = response;
  return { body: normalized, outcome: 'answered' };
}

/**
 * @param {Record<string, unknown>} body
 * @returns {{body: RequestBody, outcome: ResolutionOutcome}}
 */
function normalizePlan(body) {
  assertKeys(body, ['decision', 'message', 'nextMode']);
  const decision = body.decision;
  if (decision !== 'approve' && decision !== 'reject') throw badRequest('decision must be "approve" or "reject".');
  /** @type {RequestBody} */
  const normalized = { decision };
  const message = optionalString(body, 'message', TEXT_MAX);
  if (message !== undefined) normalized.message = message;
  if (body.nextMode !== undefined) {
    if (!PLAN_NEXT_MODES.includes(/** @type {string} */ (body.nextMode))) {
      throw badRequest('nextMode must be "default", "acceptEdits" or "auto".');
    }
    normalized.nextMode = body.nextMode;
  }
  return { body: normalized, outcome: decision === 'approve' ? 'allowed' : 'denied' };
}

/**
 * @param {unknown} value
 * @returns {Record<string, string | number | boolean | string[]>}
 */
function normalizeContent(value) {
  if (!isPlainObject(value)) throw badRequest('content must be an object.');
  const entries = Object.entries(value).map(([key, item]) => {
    if (typeof item === 'string' || typeof item === 'boolean') return [key, item];
    if (typeof item === 'number' && Number.isFinite(item)) return [key, item];
    if (Array.isArray(item) && item.every((element) => typeof element === 'string')) return [key, [...item]];
    throw badRequest('content values must be strings, numbers, booleans or arrays of strings.');
  });
  return Object.fromEntries(entries);
}

/**
 * @param {Record<string, unknown>} body
 * @returns {{body: RequestBody, outcome: ResolutionOutcome}}
 */
function normalizeElicitation(body) {
  assertKeys(body, ['action', 'content']);
  const action = body.action;
  if (action !== 'accept' && action !== 'decline' && action !== 'cancel') {
    throw badRequest('action must be "accept", "decline" or "cancel".');
  }
  /** @type {RequestBody} */
  const normalized = { action };
  if (body.content !== undefined) normalized.content = normalizeContent(body.content);
  return { body: normalized, outcome: action === 'accept' ? 'allowed' : 'denied' };
}

/**
 * Validates a response body against the kind of the pending request.
 * @param {PendingRequest} request
 * @param {unknown} body
 * @returns {{body: RequestBody, outcome: ResolutionOutcome}}
 */
function normalizeRequestBody(request, body) {
  if (!isPlainObject(body)) throw badRequest('The request body must be a JSON object.');
  switch (request.kind) {
    case 'permission':
      return normalizePermission(request, body);
    case 'question':
      return normalizeQuestion(body);
    case 'plan':
      return normalizePlan(body);
    case 'elicitation':
      return normalizeElicitation(body);
    default:
      throw new TypeError(`Unknown request kind: ${String(request.kind)}`);
  }
}

/**
 * Owns every pending request of every session. Entries are keyed per session so a request id only has to be unique
 * inside its session.
 */
export class RequestRegistry {
  /** @type {Publish} */
  #publish;
  /** @type {() => number} */
  #now;
  /** @type {Map<string, Map<string, RegistryEntry>>} */
  #sessions = new Map();

  /**
   * @param {{publish: Publish, now?: () => number}} options
   */
  constructor({ publish, now = Date.now }) {
    this.#publish = publish;
    this.#now = now;
  }

  /**
   * Stores a pending request and publishes it. The returned promise settles with the user's body, or with
   * `{cancelled: true}` when the signal aborts before an answer arrives.
   * @param {PendingRequest} request
   * @param {AbortSignal} [signal]
   * @returns {Promise<RequestOutcome>}
   */
  create(request, signal) {
    if (typeof request?.id !== 'string' || request.id === '') throw new TypeError('request.id is required');
    if (typeof request.sessionId !== 'string' || request.sessionId === '') {
      throw new TypeError('request.sessionId is required');
    }
    if (signal?.aborted) return Promise.resolve({ cancelled: true });
    const pending = {
      ...request,
      createdAt: Number.isFinite(request.createdAt) ? request.createdAt : this.#now(),
    };
    const { sessionId, id } = pending;
    const bySession = this.#sessions.get(sessionId) ?? new Map();
    if (bySession.has(id)) throw new Error('A pending request with this id already exists in the session.');
    this.#sessions.set(sessionId, bySession);
    return new Promise((resolve) => {
      const onAbort = () => this.#settle(sessionId, id, { cancelled: true }, 'cancelled');
      signal?.addEventListener('abort', onAbort, { once: true });
      bySession.set(id, {
        request: pending,
        resolve,
        detach: () => signal?.removeEventListener('abort', onAbort),
      });
      this.#publish({ type: 'request', sessionId, data: { request: pending } });
    });
  }

  /**
   * Answers a pending request. The body is validated before anything settles, so an invalid answer leaves the
   * request pending and the user can retry.
   * @param {string} sessionId
   * @param {string} id
   * @param {unknown} body
   * @returns {void}
   */
  respond(sessionId, id, body) {
    const entry = this.#sessions.get(sessionId)?.get(id);
    if (!entry) throw new AppError(404, 'REQUEST_NOT_FOUND', 'The request is no longer pending.');
    const { body: normalized, outcome } = normalizeRequestBody(entry.request, body);
    this.#settle(sessionId, id, { body: normalized }, outcome);
  }

  /**
   * @param {string} sessionId
   * @returns {PendingRequest[]} pending requests of the session, oldest first
   */
  list(sessionId) {
    const bySession = this.#sessions.get(sessionId);
    return bySession ? [...bySession.values()].map((entry) => entry.request) : [];
  }

  /**
   * @param {string} sessionId
   * @returns {number}
   */
  count(sessionId) {
    return this.#sessions.get(sessionId)?.size ?? 0;
  }

  /**
   * @param {string} sessionId
   * @param {string} id
   * @returns {boolean}
   */
  has(sessionId, id) {
    return this.#sessions.get(sessionId)?.has(id) ?? false;
  }

  /**
   * Cancels every pending request of one session.
   * @param {string} sessionId
   * @returns {number} how many requests were cancelled
   */
  cancelSession(sessionId) {
    const ids = [...(this.#sessions.get(sessionId)?.keys() ?? [])];
    for (const id of ids) this.#settle(sessionId, id, { cancelled: true }, 'cancelled');
    return ids.length;
  }

  /** Cancels every pending request of every session. */
  cancelAll() {
    for (const sessionId of [...this.#sessions.keys()]) this.cancelSession(sessionId);
  }

  /**
   * Removes an entry, settles its promise and publishes the resolution. Unknown entries are ignored, so a late abort
   * or a repeated response is harmless.
   * @param {string} sessionId
   * @param {string} id
   * @param {RequestOutcome} result
   * @param {ResolutionOutcome} outcome
   */
  #settle(sessionId, id, result, outcome) {
    const bySession = this.#sessions.get(sessionId);
    const entry = bySession?.get(id);
    if (!bySession || !entry) return;
    bySession.delete(id);
    if (bySession.size === 0) this.#sessions.delete(sessionId);
    entry.detach();
    entry.resolve(result);
    this.#publish({ type: 'request_resolved', sessionId, data: { sessionId, requestId: id, outcome } });
  }
}

/**
 * @param {string} message
 * @returns {PermissionResult}
 */
function deny(message) {
  return { behavior: 'deny', message };
}

/**
 * @param {PermissionUpdateList|undefined} suggestions
 * @param {number[]|undefined} indexes
 * @returns {PermissionUpdateList}
 */
function selectSuggestions(suggestions, indexes) {
  const list = Array.isArray(suggestions) ? suggestions : [];
  if (indexes === undefined) return list.filter(isAllowRuleSuggestion);
  return indexes.map((index) => list[index]);
}

/**
 * Suggestions applied by "Always allow" when the client names none: allow rules only. Directory grants, mode changes
 * and deny rules widen access in ways the user must opt into explicitly (docs/PROTOCOL.md).
 * @param {unknown} suggestion
 * @returns {boolean}
 */
function isAllowRuleSuggestion(suggestion) {
  if (!suggestion || typeof suggestion !== 'object') return false;
  const { type, behavior } = /** @type {{type?: unknown, behavior?: unknown}} */ (suggestion);
  return (type === 'addRules' || type === 'replaceRules') && behavior === 'allow';
}

/**
 * @param {PendingRequest} request
 * @param {RequestBody} body
 * @returns {PermissionResult}
 */
function permissionResult(request, body) {
  if (body.decision === 'deny') {
    return { behavior: 'deny', message: body.message || DENIED_MESSAGE, interrupt: body.interrupt === true };
  }
  const updatedInput = body.updatedInput ?? request.input ?? {};
  if (body.decision === 'allow') return { behavior: 'allow', updatedInput };
  const updatedPermissions = selectSuggestions(request.suggestions, body.suggestionIndexes);
  return updatedPermissions.length > 0
    ? { behavior: 'allow', updatedInput, updatedPermissions }
    : { behavior: 'allow', updatedInput };
}

/**
 * @param {PendingRequest} request
 * @param {RequestBody} body
 * @returns {PermissionResult}
 */
function questionResult(request, body) {
  if (body.decline === true) return deny(QUESTION_DECLINED_MESSAGE);
  const response = body.response ? { response: body.response } : {};
  return { behavior: 'allow', updatedInput: { ...request.input, answers: body.answers, ...response } };
}

/**
 * Maps a settled request to the SDK's CanUseTool result.
 * @param {PendingRequest} request
 * @param {RequestOutcome} outcome
 * @returns {PermissionResult}
 */
export function toPermissionResult(request, outcome) {
  if (request.kind === 'elicitation') throw new TypeError('Elicitation requests use toElicitationResult');
  if ('cancelled' in outcome) return deny(CANCELLED_MESSAGE);
  const { body } = outcome;
  switch (request.kind) {
    case 'permission':
      return permissionResult(request, body);
    case 'question':
      return questionResult(request, body);
    case 'plan':
      return body.decision === 'approve'
        ? { behavior: 'allow', updatedInput: request.input ?? {} }
        : deny(body.message || PLAN_REJECTED_MESSAGE);
    default:
      throw new TypeError(`Unknown request kind: ${String(request.kind)}`);
  }
}

/**
 * Maps a settled MCP elicitation to the SDK's onElicitation result.
 * @param {RequestOutcome} outcome
 * @returns {ElicitationResult}
 */
export function toElicitationResult(outcome) {
  if ('cancelled' in outcome) return { action: 'cancel' };
  const { body } = outcome;
  if (body.action !== 'accept') return { action: body.action };
  return body.content === undefined ? { action: 'accept' } : { action: 'accept', content: body.content };
}
