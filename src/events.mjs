// @ts-check
/**
 * Server-Sent Events hub: one global sequence, a bounded replay buffer, per-client backpressure limits and heartbeats.
 */

import { EVENT_TYPES, SESSION_SCOPED_EVENTS } from './contracts.mjs';
import { secureHeaders } from './security.mjs';

/** @typedef {import('node:http').IncomingMessage} IncomingMessage */
/** @typedef {import('node:http').ServerResponse} ServerResponse */
/** @typedef {import('./contracts.mjs').Logger} Logger */

/**
 * @typedef {Object} BufferedEvent
 * @property {number} seq
 * @property {string} type
 * @property {Record<string, unknown>} data
 * @property {string|undefined} sessionId
 */

/**
 * @typedef {Object} Client
 * @property {ServerResponse} res
 * @property {string|undefined} watch
 * @property {boolean} blocked       true from the first unflushed write until 'drain'
 * @property {number} pending        bytes written while blocked
 * @property {boolean} ended
 */

const SCOPED_TYPES = /** @type {readonly string[]} */ (SESSION_SCOPED_EVENTS);
const KNOWN_TYPES = /** @type {readonly string[]} */ (EVENT_TYPES);
/** Control frames written by the hub itself; engine code may not publish them. */
const CONTROL_TYPES = ['hello', 'heartbeat', 'resync'];
const ID_RE = /^(.+):(\d{1,16})$/;

/**
 * @param {string} id
 * @param {string} type
 * @param {Record<string, unknown>} data
 * @returns {string}
 */
function frame(id, type, data) {
  return `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Keeps the last `bufferSize` events and fans them out to SSE clients.
 */
export class EventHub {
  /** @type {string} */
  #bootId;
  /** @type {string} */
  #version;
  /** @type {Logger} */
  #log;
  /** @type {number} */
  #bufferSize;
  /** @type {number} */
  #clientMaxBytes;
  /** @type {(BufferedEvent|undefined)[]} */
  #ring;
  /** @type {number} */
  #seq = 0;
  /** @type {Set<Client>} */
  #clients = new Set();
  /** @type {ReturnType<typeof setInterval>|null} */
  #timer = null;
  /** @type {boolean} */
  #closed = false;

  /**
   * @param {{bootId: string, version: string, log: Logger, bufferSize?: number, clientMaxBytes?: number,
   *   heartbeatMs?: number}} options
   */
  constructor({ bootId, version, log, bufferSize = 5000, clientMaxBytes = 1048576, heartbeatMs = 15000 }) {
    if (!Number.isSafeInteger(bufferSize) || bufferSize < 1) {
      throw new TypeError('bufferSize must be a positive integer');
    }
    if (!Number.isSafeInteger(clientMaxBytes) || clientMaxBytes < 1) {
      throw new TypeError('clientMaxBytes must be a positive integer');
    }
    this.#bootId = bootId;
    this.#version = version;
    this.#log = log;
    this.#bufferSize = bufferSize;
    this.#clientMaxBytes = clientMaxBytes;
    this.#ring = new Array(bufferSize);
    this.#timer = setInterval(() => this.#heartbeat(), heartbeatMs);
    this.#timer.unref?.();
  }

  /** @returns {number} the most recent sequence number (0 before the first event) */
  get lastSeq() {
    return this.#seq;
  }

  /** @returns {number} connected SSE clients */
  get clientCount() {
    return this.#clients.size;
  }

  /**
   * Sequences and delivers one event. Session-scoped events reach only clients watching that session.
   * @param {{type: string, data: Record<string, unknown>, sessionId?: string}} event
   * @returns {number} the event's sequence number
   */
  publish({ type, data, sessionId }) {
    if (!KNOWN_TYPES.includes(type) || CONTROL_TYPES.includes(type)) {
      throw new TypeError(`Event type cannot be published: ${type}`);
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new TypeError('Event data must be an object');
    }
    if (SCOPED_TYPES.includes(type) && !sessionId) throw new TypeError(`${type} events require a sessionId`);
    this.#seq += 1;
    const entry = { seq: this.#seq, type, data, sessionId };
    this.#ring[(entry.seq - 1) % this.#bufferSize] = entry;
    for (const client of this.#clients) {
      if (this.#visible(entry, client.watch)) this.#send(client, this.#eventFrame(entry));
    }
    return entry.seq;
  }

  /**
   * Opens an SSE stream on the response. Replays buffered events after the cursor, or sends `resync` when the
   * cursor cannot be honoured.
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   * @param {{watch?: string, after?: number, lastEventId?: string, headers?: Record<string, string|number>}} options
   */
  attach(req, res, { watch, after, lastEventId, headers = secureHeaders() }) {
    if (this.#closed) {
      res.writeHead(503, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('The server is shutting down');
      return;
    }
    res.writeHead(200, {
      ...headers,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.socket?.setNoDelay?.(true);
    /** @type {Client} */
    const client = { res, watch, blocked: false, pending: 0, ended: false };
    this.#clients.add(client);
    res.on('close', () => this.#remove(client));
    res.on('error', () => this.#remove(client));

    this.#send(client, ':ok\n\n');
    this.#send(client, frame(this.#currentId(), 'hello', {
      bootId: this.#bootId, version: this.#version, seq: this.#seq,
    }));
    this.#replay(client, this.#cursorFor(after, lastEventId));
  }

  /**
   * @param {number|undefined} after
   * @param {string|undefined} lastEventId
   * @returns {{seq: number}|{resync: 'boot'|'gap'}|null} null when the client sent no cursor
   */
  #cursorFor(after, lastEventId) {
    if (lastEventId) {
      const match = ID_RE.exec(lastEventId);
      if (!match) return { resync: 'gap' };
      if (match[1] !== this.#bootId) return { resync: 'boot' };
      return this.#cursor(Number(match[2]));
    }
    if (after === undefined) return null;
    return this.#cursor(after);
  }

  /**
   * @param {number} seq
   * @returns {{seq: number}|{resync: 'boot'|'gap'}}
   */
  #cursor(seq) {
    if (!Number.isSafeInteger(seq) || seq < 0) return { resync: 'gap' };
    // A cursor ahead of this process belongs to a previous boot, whose sequence numbers may overlap ours.
    if (seq > this.#seq) return { resync: 'boot' };
    const oldest = Math.max(1, this.#seq - this.#bufferSize + 1);
    if (seq < oldest - 1) return { resync: 'gap' };
    return { seq };
  }

  /**
   * @param {Client} client
   * @param {{seq: number}|{resync: 'boot'|'gap'}|null} cursor
   */
  #replay(client, cursor) {
    if (cursor === null) return;
    if ('resync' in cursor) {
      this.#send(client, frame(this.#currentId(), 'resync', { reason: cursor.resync }));
      return;
    }
    for (let seq = cursor.seq + 1; seq <= this.#seq; seq += 1) {
      const entry = this.#ring[(seq - 1) % this.#bufferSize];
      if (entry && entry.seq === seq && this.#visible(entry, client.watch)) {
        this.#send(client, this.#eventFrame(entry));
      }
    }
  }

  /**
   * @param {BufferedEvent} entry
   * @param {string|undefined} watch
   * @returns {boolean}
   */
  #visible(entry, watch) {
    if (!SCOPED_TYPES.includes(entry.type)) return true;
    return watch !== undefined && entry.sessionId === watch;
  }

  /** @returns {string} */
  #currentId() {
    return `${this.#bootId}:${this.#seq}`;
  }

  /**
   * @param {BufferedEvent} entry
   * @returns {string}
   */
  #eventFrame(entry) {
    return frame(`${this.#bootId}:${entry.seq}`, entry.type, entry.data);
  }

  #heartbeat() {
    const data = { t: Date.now() };
    for (const client of this.#clients) this.#send(client, frame(this.#currentId(), 'heartbeat', data));
  }

  /**
   * Writes one frame. Once a write has been refused by the socket, further bytes are counted until 'drain'; a client
   * that accumulates more than `clientMaxBytes` in that state is disconnected and must reconnect.
   * @param {Client} client
   * @param {string} text
   */
  #send(client, text) {
    if (client.ended) return;
    if (client.res.destroyed || client.res.writableEnded) {
      this.#remove(client);
      return;
    }
    if (client.blocked) {
      client.pending += Buffer.byteLength(text);
      if (client.pending > this.#clientMaxBytes) {
        this.#log.warn('sse client too slow, disconnecting', { pendingBytes: client.pending });
        this.#remove(client);
        client.res.destroy();
        return;
      }
    }
    const flushed = client.res.write(text);
    if (!flushed && !client.blocked) {
      client.blocked = true;
      client.pending = 0;
      client.res.once('drain', () => {
        client.blocked = false;
        client.pending = 0;
      });
    }
  }

  /** @param {Client} client */
  #remove(client) {
    client.ended = true;
    this.#clients.delete(client);
  }

  /** Ends every stream and stops the heartbeat. Publishing remains possible afterwards. */
  close() {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    for (const client of [...this.#clients]) {
      this.#remove(client);
      if (!client.res.writableEnded) client.res.end();
    }
  }
}
