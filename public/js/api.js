/**
 * HTTP and Server-Sent Events client for the gateway contract (docs/PROTOCOL.md).
 * Importable in Node: DOM globals (fetch, EventSource, XMLHttpRequest, window) are only touched inside calls.
 */

import { store } from './store.js';

/**
 * Failed API call. `code` is a stable protocol code (or 'NETWORK' when the request never reached the gateway).
 */
export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {number} [retryAfter] seconds, from the Retry-After header
   */
  constructor(status, code, message, retryAfter) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/** Every event type the gateway can send (docs/PROTOCOL.md, Events). */
export const EVENT_TYPES = Object.freeze([
  'hello', 'heartbeat', 'resync', 'sessions_changed', 'session_state', 'sdk', 'request', 'request_resolved',
  'message_accepted', 'notice', 'terminal_state',
]);

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
/** The gateway heartbeats every 15 s; silence for longer than this means the connection is stalled. */
const STALL_TIMEOUT_MS = 45000;

const FALLBACK_CODES = /** @type {Record<number, string>} */ ({
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  421: 'HOST_REJECTED',
  429: 'RATE_LIMITED',
});

/**
 * Delay before reconnect attempt `attempt` (0-based): 1 s, 2 s, 4 s, ... capped at 30 s.
 * @param {number} attempt
 * @returns {number} milliseconds
 */
export function reconnectDelayMs(attempt) {
  const n = Number.isFinite(attempt) ? Math.min(30, Math.max(0, Math.floor(attempt))) : 0;
  return Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** n);
}

/**
 * Localized text for any error. Known protocol codes map to `common.error.<CODE>`; anything else falls back to
 * the server's message or a generic internal-error line. Never returns a stack trace.
 * @param {unknown} err
 * @param {(key: string, vars?: Record<string, string | number>) => string} translate
 * @returns {string}
 */
export function errorText(err, translate) {
  if (err instanceof ApiError) {
    const key = `common.error.${err.code}`;
    const localized = translate(key, { seconds: err.retryAfter ?? 0 });
    if (localized !== key) return localized;
    return err.message || translate('common.error.INTERNAL');
  }
  return translate('common.error.INTERNAL');
}

/** RFC 4122 version-4 UUID; works in insecure contexts (plain HTTP on a LAN address) too. */
export function createUuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function abortError() {
  return new DOMException('The operation was aborted.', 'AbortError');
}

/** @param {unknown} err */
function isAbort(err) {
  return typeof err === 'object' && err !== null && /** @type {{name?: string}} */ (err).name === 'AbortError';
}

/** @param {string | null | undefined} value */
function parseRetryAfter(value) {
  if (value == null) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : undefined;
}

/** A 401 UNAUTHENTICATED anywhere means the session cookie is gone: show the login view. */
function markUnauthenticated() {
  const { auth } = store.get();
  if (auth.authenticated) store.set({ auth: { ...auth, authenticated: false } });
}

/**
 * @param {{ok: boolean, status: number, headers: {get(name: string): string | null}, text(): Promise<string>}} res
 * @param {unknown} data
 */
function toApiError(res, data) {
  const body = data && typeof data === 'object' ? /** @type {Record<string, any>} */ (data).error : null;
  const code = typeof body?.code === 'string' ? body.code : (FALLBACK_CODES[res.status] ?? (
    res.status >= 500 ? 'INTERNAL' : 'BAD_REQUEST'));
  const message = typeof body?.message === 'string' ? body.message : `HTTP ${res.status}`;
  const error = new ApiError(res.status, code, message, parseRetryAfter(res.headers.get('Retry-After')));
  if (res.status === 401 && code === 'UNAUTHENTICATED') markUnauthenticated();
  return error;
}

/** @param {{text(): Promise<string>}} res */
async function readJson(res) {
  let text;
  try {
    text = await res.text();
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new ApiError(0, 'NETWORK', 'Network request failed');
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * @param {string} method
 * @param {string} path
 * @param {{headers: Record<string, string>, body?: BodyInit, signal?: AbortSignal}} init
 */
async function fetchResponse(method, path, { headers, body, signal }) {
  try {
    return await fetch(path, { method, headers, body, signal, credentials: 'same-origin' });
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new ApiError(0, 'NETWORK', 'Network request failed');
  }
}

/**
 * XMLHttpRequest variant used only when upload progress is requested. Resolves to the same shape as fetch.
 * @param {string} method
 * @param {string} path
 * @param {{headers: Record<string, string>, body: Blob, signal?: AbortSignal, onProgress: (fraction: number) => void}} opts
 */
function xhrResponse(method, path, { headers, body, signal, onProgress }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open(method, path, true);
    xhr.responseType = 'text';
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    const onAbort = () => xhr.abort();
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    signal?.addEventListener('abort', onAbort, { once: true });
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(Math.min(1, event.loaded / event.total));
    };
    xhr.onload = () => {
      cleanup();
      resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        headers: { get: (name) => xhr.getResponseHeader(name) },
        text: async () => xhr.responseText,
      });
    };
    xhr.onerror = () => {
      cleanup();
      reject(new ApiError(0, 'NETWORK', 'Network request failed'));
    };
    xhr.onabort = () => {
      cleanup();
      reject(abortError());
    };
    xhr.send(body);
  });
}

/**
 * Perform one request and return the parsed JSON body, or throw ApiError.
 * @param {string} method
 * @param {string} path
 * @param {{headers?: Record<string, string>, body?: Blob | string, signal?: AbortSignal, onProgress?: (f: number) => void}} [opts]
 */
async function send(method, path, { headers = {}, body, signal, onProgress } = {}) {
  const allHeaders = { Accept: 'application/json', ...headers };
  const res = onProgress && body instanceof Blob
    ? await xhrResponse(method, path, { headers: allHeaders, body, signal, onProgress })
    : await fetchResponse(method, path, { headers: allHeaders, body: /** @type {BodyInit} */ (body), signal });
  const data = await readJson(res);
  if (!res.ok) throw toApiError(res, data);
  return data;
}

/**
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 */
function sendJson(method, path, body = {}) {
  return send(method, path, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * @param {string} path
 * @param {{signal?: AbortSignal}} [opts]
 */
export const api = {
  /** @param {string} path @param {{signal?: AbortSignal}} [opts] */
  get(path, opts = {}) {
    return send('GET', path, { signal: opts.signal });
  },
  /** @param {string} path @param {unknown} [body] */
  post(path, body) {
    return sendJson('POST', path, body);
  },
  /** @param {string} path @param {unknown} body */
  patch(path, body) {
    return sendJson('PATCH', path, body);
  },
  /** @param {string} path */
  del(path) {
    return send('DELETE', path);
  },
  /**
   * Upload one file into `<cwd>/.caw-uploads`. Progress requires XMLHttpRequest, so it is used only when
   * `onProgress` is given.
   * @param {string} cwd
   * @param {Blob} file
   * @param {string} [name] original file name (defaults to file.name)
   * @param {{onProgress?: (fraction: number) => void, signal?: AbortSignal}} [opts]
   * @returns {Promise<{path: string, name: string, size: number, mediaType: string, kind: 'image'|'file'}>}
   */
  upload(cwd, file, name, opts = {}) {
    const fileName = name || (typeof File !== 'undefined' && file instanceof File ? file.name : '') || 'file';
    const path = `/api/attachments?cwd=${encodeURIComponent(cwd)}`;
    const headers = {
      'Content-Type': file.type || 'application/octet-stream',
      'X-File-Name': encodeURIComponent(fileName),
    };
    return send('POST', path, { headers, body: file, signal: opts.signal, onProgress: opts.onProgress });
  },
};

/**
 * Sequence number from an SSE id of the form `<bootId>:<seq>`.
 * @param {string} id
 * @returns {number | null}
 */
function parseSeq(id) {
  const index = typeof id === 'string' ? id.lastIndexOf(':') : -1;
  if (index < 0) return null;
  const seq = Number(id.slice(index + 1));
  return Number.isFinite(seq) ? seq : null;
}

/**
 * Open the event stream for the shell. Reconnects with exponential backoff (1 s … 30 s) after any failure or
 * stall, resets the backoff on `hello`, and resumes from the last sequence number seen.
 * @param {{
 *   watch?: string | null,
 *   after?: number | null,
 *   onEvent: (type: string, data: any) => void,
 *   onStatus?: (status: 'connecting' | 'open' | 'closed') => void,
 * }} options
 * @returns {{ close(): void, reconnect(next: {watch?: string | null, after?: number | null}): void }}
 */
export function connectEvents({ watch = null, after = null, onEvent, onStatus }) {
  /** @type {EventSource | null} */
  let source = null;
  let closed = false;
  let attempt = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let retryTimer = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let stallTimer = null;
  let target = { watch, after };
  /** @type {number | null} */
  let lastSeq = after;

  const emit = (/** @type {'connecting' | 'open' | 'closed'} */ status) => {
    try {
      onStatus?.(status);
    } catch (err) {
      queueMicrotask(() => {
        throw err;
      });
    }
  };

  const onlineKick = () => {
    if (!closed && source === null) {
      clearTimeout(retryTimer ?? undefined);
      attempt = 0;
      open();
    }
  };

  function streamUrl() {
    const params = new URLSearchParams();
    if (target.watch) params.set('watch', target.watch);
    if (lastSeq != null) params.set('after', String(lastSeq));
    const query = params.toString();
    return `/api/events${query ? `?${query}` : ''}`;
  }

  function armStallTimer() {
    clearTimeout(stallTimer ?? undefined);
    stallTimer = setTimeout(fail, STALL_TIMEOUT_MS);
  }

  function teardown() {
    clearTimeout(stallTimer ?? undefined);
    stallTimer = null;
    if (source) source.close();
    source = null;
  }

  function fail() {
    if (closed) return;
    teardown();
    emit('closed');
    const delay = reconnectDelayMs(attempt);
    attempt += 1;
    clearTimeout(retryTimer ?? undefined);
    retryTimer = setTimeout(open, delay);
  }

  /**
   * @param {EventSource} es
   * @param {string} type
   * @param {MessageEvent} event
   */
  function onFrame(es, type, event) {
    if (closed || source !== es) return;
    const seq = parseSeq(event.lastEventId);
    if (seq != null) lastSeq = lastSeq == null ? seq : Math.max(lastSeq, seq);
    armStallTimer();
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    if (type === 'hello') attempt = 0;
    try {
      onEvent(type, data);
    } catch (err) {
      queueMicrotask(() => {
        throw err;
      });
    }
  }

  function open() {
    if (closed) return;
    clearTimeout(retryTimer ?? undefined);
    retryTimer = null;
    emit('connecting');
    const es = new EventSource(streamUrl());
    source = es;
    armStallTimer();
    es.onopen = () => {
      if (source === es) emit('open');
    };
    es.onerror = () => {
      if (source === es) fail();
    };
    for (const type of EVENT_TYPES) {
      es.addEventListener(type, (event) => onFrame(es, type, /** @type {MessageEvent} */ (event)));
    }
  }

  if (typeof globalThis.addEventListener === 'function') globalThis.addEventListener('online', onlineKick);

  open();

  return {
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(retryTimer ?? undefined);
      teardown();
      if (typeof globalThis.removeEventListener === 'function') globalThis.removeEventListener('online', onlineKick);
      emit('closed');
    },
    /** @param {{watch?: string | null, after?: number | null}} next */
    reconnect(next) {
      if (closed) return;
      target = { watch: next.watch ?? null, after: next.after ?? null };
      lastSeq = target.after;
      attempt = 0;
      clearTimeout(retryTimer ?? undefined);
      teardown();
      open();
    },
  };
}
