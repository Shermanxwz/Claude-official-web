// @ts-check
/**
 * Real-engine validation for a deployment host. Starts the gateway on a random loopback port with the real Claude Agent
 * SDK engine and temporary workspace and state directories, then drives real model turns through the HTTP API and the
 * event stream. It proves that Claude Code is logged in for this user, that a turn completes and is recorded on disk,
 * that capabilities are reported and, with --with-tools, that a tool approval round-trips to a file on disk.
 *
 *   node scripts/runtime-smoke.mjs               one reply turn
 *   node scripts/runtime-smoke.mjs --with-tools  also a Write turn approved through the request API
 *
 * Prerequisite: Claude Code is logged in as the user running this script (run `claude` once and complete /login).
 * CAW_* variables of the calling shell are ignored, except CAW_CLAUDE_BIN, so the run is deterministic.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SESSION_COOKIE } from '../src/contracts.mjs';
import { startServer } from '../src/server.mjs';

const WITH_TOOLS = process.argv.includes('--with-tools');
const HTTP_TIMEOUT_MS = 60_000;
const HELLO_TIMEOUT_MS = 15_000;
const REPLY_TIMEOUT_MS = 180_000;
const APPROVAL_TIMEOUT_MS = 120_000;
const LOGIN_HINT = 'Claude Code is not logged in for this user — run `claude` once and use /login. '
  + 'If Claude Code is installed elsewhere, set CAW_CLAUDE_BIN to its executable.';

class SmokeError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'SmokeError';
  }
}

class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   */
  constructor(status, code, message) {
    super(`HTTP ${status} ${code}: ${message}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * @typedef {{type: string, id: string, data: any}} SseEvent
 * @typedef {{predicate: (event: SseEvent) => boolean, resolve: (event: SseEvent) => void,
 *   reject: (error: Error) => void, timer: NodeJS.Timeout | null}} Waiter
 */

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {number} started a performance.now() reading
 * @returns {number} elapsed milliseconds
 */
function elapsed(started) {
  return Math.round(performance.now() - started);
}

/**
 * @param {Response} response
 * @returns {Promise<any>} parsed JSON body, or null when the body is empty or not JSON
 */
async function readJson(response) {
  const text = await response.text();
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Minimal SSE frame parser: `event:` and `data:` fields, frames separated by a blank line.
 * @param {string} frame one frame without its terminating blank line
 * @returns {SseEvent | null}
 */
function parseFrame(frame) {
  let type = 'message';
  let id = '';
  /** @type {string[]} */
  const data = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) type = line.slice(6).trim();
    else if (line.startsWith('id:')) id = line.slice(3).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  return data.length > 0 ? { type, id, data: JSON.parse(data.join('\n')) } : null;
}

/**
 * An unavailable engine is fatal for the smoke whatever is being awaited.
 * @param {SseEvent} event
 * @returns {boolean}
 */
function isEngineUnavailable(event) {
  if (event.type === 'notice') return event.data?.code === 'ENGINE_UNAVAILABLE';
  if (event.type === 'session_state') return event.data?.live?.error?.code === 'ENGINE_UNAVAILABLE';
  return false;
}

/**
 * @param {SseEvent} event
 * @param {string} sessionId
 * @returns {boolean}
 */
function isTurnResult(event, sessionId) {
  return event.type === 'sdk' && event.data?.sessionId === sessionId && event.data?.msg?.type === 'result';
}

/**
 * @param {SseEvent} event
 * @param {string} sessionId
 * @returns {boolean}
 */
function isPermissionRequest(event, sessionId) {
  return event.type === 'request' && event.data?.request?.sessionId === sessionId
    && event.data?.request?.kind === 'permission';
}

/**
 * Reads an open text/event-stream response and lets callers await events that match a predicate.
 * @param {Response} response
 */
function openEvents(response) {
  if (!response.body) throw new SmokeError('the event stream response has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  /** @type {SseEvent[]} */
  const events = [];
  /** @type {Waiter[]} */
  const waiters = [];
  let buffer = '';
  let closing = false;
  /** @type {Error | null} */
  let failure = null;

  /** @param {Error} error */
  const fail = (error) => {
    if (failure) return;
    failure = error;
    for (const waiter of waiters.splice(0)) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  };

  /** @param {SseEvent} event */
  const publish = (event) => {
    events.push(event);
    if (isEngineUnavailable(event)) {
      fail(new SmokeError(LOGIN_HINT));
      return;
    }
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(event)) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(event);
    }
  };

  void (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, '\n');
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const event = parseFrame(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          if (event) publish(event);
          boundary = buffer.indexOf('\n\n');
        }
      }
      fail(new SmokeError('the event stream closed unexpectedly'));
    } catch (error) {
      if (!closing) fail(error instanceof Error ? error : new SmokeError(String(error)));
    }
  })();

  /**
   * @param {(event: SseEvent) => boolean} predicate
   * @param {string} label
   * @param {number} timeoutMs
   * @param {number} [from] index of the first event that may match
   * @returns {Promise<SseEvent>}
   */
  const waitFor = (predicate, label, timeoutMs, from = 0) => {
    const existing = events.slice(from).find(predicate);
    if (existing) return Promise.resolve(existing);
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      /** @type {Waiter} */
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index !== -1) waiters.splice(index, 1);
        reject(new SmokeError(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${label}`));
      }, timeoutMs);
      waiters.push(waiter);
    });
  };

  return {
    events,
    waitFor,
    async close() {
      closing = true;
      try {
        await reader.cancel();
      } catch {
        // The stream had already ended.
      }
    },
  };
}

/**
 * @param {string} baseUrl exact origin of the started gateway
 */
function createClient(baseUrl) {
  const origin = new URL(baseUrl).origin;
  let cookie = '';

  /**
   * @param {string} method
   * @param {string} pathname
   * @param {unknown} [body]
   * @returns {Promise<any>}
   */
  async function call(method, pathname, body) {
    /** @type {Record<string, string>} */
    const headers = { origin, cookie };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(new URL(pathname, baseUrl), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const parsed = await readJson(response);
    if (!response.ok) {
      throw new ApiError(response.status, parsed?.error?.code ?? 'HTTP_ERROR',
        parsed?.error?.message ?? 'the request failed');
    }
    return parsed;
  }

  /** @param {string} token */
  async function login(token) {
    const response = await fetch(new URL('/api/login', baseUrl), {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
      redirect: 'error',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const parsed = await readJson(response);
    if (!response.ok) {
      throw new ApiError(response.status, parsed?.error?.code ?? 'HTTP_ERROR', parsed?.error?.message ?? 'login failed');
    }
    const issued = response.headers.getSetCookie().find((value) => value.startsWith(`${SESSION_COOKIE}=`));
    if (!issued) throw new SmokeError('login succeeded without issuing a session cookie');
    cookie = issued.split(';', 1)[0];
  }

  /** @param {string} sessionId */
  async function watch(sessionId) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    /** @type {Response} */
    let response;
    try {
      response = await fetch(new URL(`/api/events?watch=${encodeURIComponent(sessionId)}`, baseUrl), {
        headers: { origin, cookie, accept: 'text/event-stream' },
        redirect: 'error',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new ApiError(response.status, 'EVENTS_FAILED', 'the event stream could not be opened');
    return openEvents(response);
  }

  return { call, login, watch };
}

/**
 * @param {any} message an SDK result message
 * @param {string} label
 */
function assertTurnSucceeded(message, label) {
  if (message.subtype === 'success' && message.is_error !== true) return;
  const errors = Array.isArray(message.errors) ? message.errors.map(String).join(' ') : '';
  if (/log ?in|\/login|credential|authenticat/i.test(errors)) throw new SmokeError(LOGIN_HINT);
  const detail = errors ? `: ${errors.slice(0, 300)}` : '';
  throw new SmokeError(`${label} ended with ${message.subtype ?? 'an unknown result'}${detail}`);
}

/**
 * @param {SseEvent[]} events
 * @param {string} sessionId
 * @returns {string} all assistant text blocks of the session, in order
 */
function assistantText(events, sessionId) {
  /** @type {string[]} */
  const parts = [];
  for (const event of events) {
    if (event.type !== 'sdk' || event.data?.sessionId !== sessionId) continue;
    const message = event.data.msg;
    if (message?.type !== 'assistant' || !Array.isArray(message.message?.content)) continue;
    for (const block of message.message.content) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
  }
  return parts.join('\n');
}

/**
 * The transcript is written by Claude Code as the turn ends, so allow a short settling period.
 * @param {ReturnType<typeof createClient>} client
 * @param {string} sessionId
 * @param {string} marker
 */
async function awaitTranscript(client, sessionId, marker) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const page = await client.call('GET', `/api/sessions/${sessionId}/messages?tail=200`);
    const messages = Array.isArray(page?.messages) ? page.messages : [];
    const prompted = messages.some((entry) => entry?.type === 'user' && JSON.stringify(entry).includes(marker));
    const replied = messages.some((entry) => entry?.type === 'assistant' && JSON.stringify(entry).includes(marker));
    if (prompted && replied) return;
    await delay(500);
  }
  throw new SmokeError('GET /messages does not list the completed turn (prompt and reply) from disk');
}

/**
 * Requests a Write, approves it through the request API and checks the file the approved tool wrote.
 * @param {ReturnType<typeof createClient>} client
 * @param {ReturnType<typeof openEvents>} events
 * @param {string} sessionId
 * @param {string} workspace
 * @param {string} marker
 */
async function runToolApproval(client, events, sessionId, workspace, marker) {
  const boundary = events.events.length;
  await client.call('POST', `/api/sessions/${sessionId}/messages`, {
    clientMessageId: crypto.randomUUID(),
    text: `Use the Write tool to create a file named smoke.txt in the current directory whose entire content is `
      + `exactly ${marker}. Then reply with exactly: WRITTEN`,
  });
  const next = await events.waitFor((event) => isPermissionRequest(event, sessionId)
    || isTurnResult(event, sessionId), 'a Write approval request', APPROVAL_TIMEOUT_MS, boundary);
  if (!isPermissionRequest(next, sessionId)) {
    throw new SmokeError('the Write turn finished without an approval request, so the approval path was not exercised; '
      + 'check the permission rules for Write in ~/.claude/settings.json');
  }
  const request = next.data.request;
  if (request.toolName !== 'Write') {
    await client.call('POST', `/api/sessions/${sessionId}/requests/${request.id}`,
      { decision: 'deny', message: 'the runtime smoke approves only Write' });
    throw new SmokeError(`expected an approval request for Write, received one for ${request.toolName}`);
  }
  await client.call('POST', `/api/sessions/${sessionId}/requests/${request.id}`, { decision: 'allow' });
  const finished = await events.waitFor((event) => isTurnResult(event, sessionId), 'the end of the Write turn',
    REPLY_TIMEOUT_MS, boundary);
  assertTurnSucceeded(finished.data.msg, 'the Write turn');
  const file = path.join(workspace, 'smoke.txt');
  const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (!content.includes(marker)) throw new SmokeError('smoke.txt does not contain the marker after the approved Write');
}

/**
 * @param {string} workspace
 * @param {string} state
 * @param {string} token
 * @returns {Record<string, string>} environment for the gateway
 */
function smokeEnvironment(workspace, state, token) {
  /** @type {Record<string, string>} */
  const inherited = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string') continue;
    if (key.startsWith('CAW_') && key !== 'CAW_CLAUDE_BIN') continue;
    inherited[key] = value;
  }
  return {
    ...inherited,
    CAW_ENGINE: 'sdk',
    CAW_REQUIRE_AUTH: '1',
    CAW_TOKEN: token,
    CAW_WORKSPACE_ROOTS: workspace,
    CAW_STATE_DIR: state,
    CAW_ACCESS_PROFILE: 'full',
    CAW_TERMINAL: '0',
    CAW_ALLOW_BYPASS: '0',
    CAW_LOG_LEVEL: 'warn',
  };
}

/**
 * @param {string} label
 * @param {() => Promise<unknown>} action
 */
async function attempt(label, action) {
  try {
    await action();
  } catch (error) {
    console.error(`WARNING: cleanup could not ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * @returns {Promise<Record<string, unknown>>} the validation receipt
 */
async function run() {
  const started = performance.now();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caw-runtime-smoke-'));
  const workspace = path.join(root, 'workspace');
  const state = path.join(root, 'state');
  fs.mkdirSync(workspace);
  fs.mkdirSync(state);
  const token = crypto.randomBytes(24).toString('base64url');
  const marker = `CAW-SMOKE-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;

  /** @type {Awaited<ReturnType<typeof startServer>> | null} */
  let gateway = null;
  /** @type {ReturnType<typeof createClient> | null} */
  let client = null;
  /** @type {ReturnType<typeof openEvents> | null} */
  let events = null;
  let sessionId = '';

  try {
    const setupStart = performance.now();
    gateway = await startServer({
      env: smokeEnvironment(workspace, state, token),
      listenHost: '127.0.0.1',
      listenPort: 0,
    });
    client = createClient(gateway.url);
    await client.login(token);
    const created = await client.call('POST', '/api/sessions', { cwd: workspace, title: 'Runtime smoke' });
    sessionId = created.live.sessionId;
    events = await client.watch(sessionId);
    await events.waitFor((event) => event.type === 'hello', 'the event stream greeting', HELLO_TIMEOUT_MS);
    const setupMs = elapsed(setupStart);

    const replyStart = performance.now();
    await client.call('POST', `/api/sessions/${sessionId}/messages`, {
      clientMessageId: crypto.randomUUID(),
      text: `Reply with exactly this text and nothing else: ${marker}`,
    });
    const reply = await events.waitFor((event) => isTurnResult(event, sessionId), 'the reply turn', REPLY_TIMEOUT_MS);
    assertTurnSucceeded(reply.data.msg, 'the reply turn');
    if (!assistantText(events.events, sessionId).includes(marker)) {
      throw new SmokeError(`the assistant reply does not contain ${marker}`);
    }
    const replyMs = elapsed(replyStart);

    const transcriptStart = performance.now();
    await awaitTranscript(client, sessionId, marker);
    const transcriptMs = elapsed(transcriptStart);

    const capabilitiesStart = performance.now();
    const capabilities = await client.call('GET', `/api/sessions/${sessionId}/capabilities`);
    if (!Array.isArray(capabilities?.models) || capabilities.models.length === 0) {
      throw new SmokeError('capabilities returned no models');
    }
    if (!Array.isArray(capabilities?.commands) || capabilities.commands.length === 0) {
      throw new SmokeError('capabilities returned no slash commands');
    }
    const capabilitiesMs = elapsed(capabilitiesStart);

    let toolApprovalMs = null;
    if (WITH_TOOLS) {
      const toolStart = performance.now();
      await runToolApproval(client, events, sessionId, workspace, marker);
      toolApprovalMs = elapsed(toolStart);
    }

    const meta = await client.call('GET', '/api/meta');
    if (meta.engine !== 'sdk') throw new SmokeError(`the gateway reports engine ${meta.engine}, expected sdk`);
    if (!meta.claudeCodeVersion) throw new SmokeError('/api/meta reports no Claude Code version after a completed turn');

    return {
      ok: true,
      engine: 'sdk',
      sdkVersion: meta.sdkVersion ?? null,
      claudeCodeVersion: meta.claudeCodeVersion,
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      withTools: WITH_TOOLS,
      checks: {
        login: true,
        sessionCreated: true,
        eventStream: true,
        replyTurn: true,
        transcript: true,
        capabilities: true,
        toolApproval: WITH_TOOLS,
      },
      capabilities: { models: capabilities.models.length, commands: capabilities.commands.length },
      durationsMs: {
        setup: setupMs,
        replyTurn: replyMs,
        transcript: transcriptMs,
        capabilities: capabilitiesMs,
        ...(toolApprovalMs === null ? {} : { toolApproval: toolApprovalMs }),
        total: elapsed(started),
      },
      at: new Date().toISOString(),
    };
  } finally {
    if (client && sessionId) {
      const api = client;
      await attempt('close the session', () => api.call('POST', `/api/sessions/${sessionId}/close`));
      await attempt('delete the session', () => api.call('DELETE', `/api/sessions/${sessionId}`));
    }
    if (events) await events.close();
    if (gateway) {
      const server = gateway;
      await attempt('stop the gateway', () => server.close());
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/**
 * @param {unknown} error
 * @returns {string} an actionable one-line description
 */
function describeFailure(error) {
  if (error instanceof ApiError && error.code === 'ENGINE_UNAVAILABLE') return LOGIN_HINT;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** @returns {Promise<number>} process exit code */
async function main() {
  try {
    const receipt = await run();
    console.log(JSON.stringify(receipt, null, 2));
    console.log('RUNTIME_VALIDATED');
    return 0;
  } catch (error) {
    console.error(`RUNTIME_SMOKE_FAILED: ${describeFailure(error)}`);
    return 1;
  }
}

process.exitCode = await main();
