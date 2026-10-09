// @ts-check
/**
 * Optional terminal: the real Claude Code TUI running in a pseudo-terminal and attached over a WebSocket. It is
 * equivalent to shell access, so every entry point is validated here. The gateway authenticates the upgrade and checks
 * the Origin and access profile before it calls handleUpgrade (see docs/PROTOCOL.md, "Terminal").
 *
 * Single writer: a session terminal holds the session lock (EngineHost.lockForTerminal) from the moment the Claude Code
 * process is about to start until that process has exited, so the graphical view never writes to the same transcript.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { WebSocket, WebSocketServer } from 'ws';
import { AppError, isUuid } from './contracts.mjs';

/** @typedef {import('./contracts.mjs').Config} Config */
/** @typedef {import('./contracts.mjs').Logger} Logger */
/** @typedef {import('./contracts.mjs').EngineHostApi} EngineHostApi */
/** @typedef {import('./contracts.mjs').Publish} Publish */
/** @typedef {import('./contracts.mjs').TerminalApi} TerminalApi */

/**
 * The subset of node-pty's IPty used by this module.
 * @typedef {Object} PtyProcess
 * @property {number} pid
 * @property {(listener: (data: string) => void) => {dispose(): void}} onData
 * @property {(listener: (event: {exitCode: number, signal?: number}) => void) => {dispose(): void}} onExit
 * @property {(data: string) => void} write
 * @property {(cols: number, rows: number) => void} resize
 * @property {(signal?: string) => void} kill
 * @property {() => void} pause
 * @property {() => void} resume
 */

/**
 * The subset of the node-pty module used by this module. Tests inject a fake.
 * @typedef {Object} PtyModule
 * @property {(file: string, args: string[], options: {name: string, cols: number, rows: number, cwd: string,
 *   env: Record<string, string>}) => PtyProcess} spawn
 */

/**
 * @typedef {{kind: 'session', sessionId: string} | {kind: 'directory', cwd: string}} Target
 */

const MAX_TERMINALS = 4;
const WS_MAX_PAYLOAD = 1 << 20;
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_INPUT_CHARS = 65536;
const MAX_CWD_CHARS = 4096;
const MAX_QUEUED_FRAMES = 64;
const COLS_RANGE = /** @type {const} */ ([20, 500]);
const ROWS_RANGE = /** @type {const} */ ([5, 200]);
const OUTPUT_BATCH_MS = 16;
const OUTPUT_FRAME_CHARS = 64 * 1024;
const OUTPUT_FLUSH_NOW_CHARS = 1024 * 1024;
const BACKPRESSURE_HIGH_BYTES = 2 * 1024 * 1024;
const BACKPRESSURE_LOW_BYTES = 512 * 1024;
const BACKPRESSURE_POLL_MS = 50;
const TERMINATE_GRACE_MS = 3000;
const HEARTBEAT_MS = 30000;
const CLOSE_ALL_TIMEOUT_MS = 10000;
const PTY_NAME = 'xterm-256color';
const PTY_COLS = 100;
const PTY_ROWS = 30;

const requireFromHere = createRequire(import.meta.url);

/**
 * Creates the terminal service. When it is disabled, every upgrade is refused by destroying the socket.
 * @param {{config: Config, log: Logger, engineHost: EngineHostApi, publish: Publish, ptyModule?: PtyModule}} deps
 * @returns {Promise<TerminalApi>}
 */
export async function createTerminal({ config, log, engineHost, publish, ptyModule }) {
  const { pty, disabledReason } = await selectPty(config, ptyModule);
  if (!pty) {
    log.info('terminal disabled', { reason: disabledReason });
    return {
      enabled: false,
      disabledReason,
      handleUpgrade(_req, socket) {
        socket.destroy();
      },
      async closeAll() {},
    };
  }

  /** @type {Set<TerminalConnection>} */
  const registry = new Set();
  /** @type {Array<() => void>} */
  const emptyWaiters = [];
  // Resolved once, here, so the path logged below is the path every session runs.
  const claudeBin = resolveClaudeBinary(config);
  if (claudeBin) log.info('terminal claude binary resolved', { path: claudeBin });
  else log.warn('terminal claude binary not found');
  const deps = { config, log, engineHost, publish, pty, claudeBin };
  let closing = false;

  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });
  wss.on('error', (err) => log.warn('terminal socket server error', { error: errorName(err) }));

  /** @param {TerminalConnection} connection */
  const unregister = (connection) => {
    registry.delete(connection);
    if (registry.size === 0) for (const notify of emptyWaiters.splice(0)) notify();
  };

  /**
   * @param {number} timeoutMs
   * @returns {Promise<void>}
   */
  const waitForEmpty = (timeoutMs) => new Promise((resolve) => {
    if (registry.size === 0) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, timeoutMs);
    emptyWaiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });

  /**
   * @param {import('ws').WebSocket} ws
   * @param {import('node:http').IncomingMessage} request
   */
  const accept = (ws, request) => {
    const connection = new TerminalConnection(ws, deps, unregister);
    connection.listen();
    if (closing) {
      connection.shutdown(1001, 'Server shutting down');
      return;
    }
    /** @type {Target} */
    let target;
    try {
      target = parseTarget(request.url);
    } catch (err) {
      connection.reject('BAD_REQUEST', err instanceof AppError ? err.message : 'Invalid terminal request', 1008);
      return;
    }
    if (registry.size >= MAX_TERMINALS) {
      connection.reject('TOO_MANY_TERMINALS', `At most ${MAX_TERMINALS} terminals can be open at once`, 1013);
      return;
    }
    registry.add(connection);
    connection.start(target).catch((err) => {
      log.error('terminal connection failed', { error: errorName(err) });
      connection.shutdown(1011, 'INTERNAL');
    });
  };

  return {
    enabled: true,
    disabledReason: null,
    handleUpgrade(req, socket, head) {
      if (closing) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws, request) => accept(ws, request));
    },
    async closeAll() {
      closing = true;
      for (const connection of [...registry]) connection.shutdown(1001, 'Server shutting down');
      await waitForEmpty(CLOSE_ALL_TIMEOUT_MS);
      if (registry.size > 0) log.warn('terminal shutdown timed out', { open: registry.size });
      wss.close();
    },
  };
}

/**
 * Claude Code executable for terminal sessions, in the order the SDK uses for the engine, so both run the same binary:
 * `config.claudeBin` when set (never falling back to another binary), else the native binary the SDK ships for this
 * platform (the musl package first on musl hosts), else the first executable `claude` on PATH (absolute entries only).
 * @param {Config} config
 * @param {{
 *   env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, arch?: string, preferMusl?: boolean,
 *   bundled?: (pkg: string, binName: string) => string|null,
 * }} [options] `bundled` looks up a package's binary and defaults to this checkout's node_modules.
 * @returns {string|null}
 */
export function resolveClaudeBinary(config, {
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  preferMusl = platform === 'linux' && isMuslHost(),
  bundled = resolveSdkBinary,
} = {}) {
  const binName = platform === 'win32' ? 'claude.exe' : 'claude';
  if (config.claudeBin) return isExecutableFile(config.claudeBin) ? config.claudeBin : null;
  for (const pkg of sdkPackageNames(platform, arch, preferMusl)) {
    const shipped = bundled(pkg, binName);
    if (shipped) return shipped;
  }
  return findOnPath(binName, env.PATH ?? env.Path ?? '');
}

/**
 * One WebSocket client and the Claude Code process (if any) it controls. All state transitions go through
 * `shutdown()`, `onPtyExit()` and `finishIfIdle()`, which keeps the lock release and the timers idempotent.
 */
class TerminalConnection {
  /**
   * @param {import('ws').WebSocket} ws
   * @param {{config: Config, log: Logger, engineHost: EngineHostApi, publish: Publish, pty: PtyModule,
   *   claudeBin: string|null}} deps
   * @param {(connection: TerminalConnection) => void} onFinished
   */
  constructor(ws, deps, onFinished) {
    this.ws = ws;
    this.deps = deps;
    this.onFinished = onFinished;
    /** @type {string|null} */
    this.sessionId = null;
    /** @type {number|null} */
    this.pid = null;
    /** Shutdown has started: no further setup, input or output. */
    this.closing = false;
    /** The setup coroutine (start) has not finished yet. */
    this.setupPending = false;
    this.finished = false;
    /** The pty is running, so queued client frames may be processed. */
    this.ready = false;
    /** @type {Array<{raw: import('ws').WebSocket.RawData, isBinary: boolean}>} */
    this.queued = [];
    /** @type {PtyProcess|null} */
    this.pty = null;
    this.ptyRunning = false;
    /** SIGHUP has been sent to the pty. */
    this.terminating = false;
    /** @type {(() => void)|null} */
    this.releaseLock = null;
    this.attached = false;
    this.paused = false;
    this.alive = true;
    this.output = '';
    /** @type {Array<{dispose(): void}>} */
    this.subscriptions = [];
    /** @type {ReturnType<typeof setTimeout>|null} */
    this.flushTimer = null;
    /** @type {ReturnType<typeof setInterval>|null} */
    this.pollTimer = null;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this.terminateTimer = null;
    /** @type {ReturnType<typeof setInterval>|null} */
    this.heartbeatTimer = null;
  }

  /** Attaches the socket listeners. Runs before anything else so that no client frame is missed. */
  listen() {
    const { ws } = this;
    ws.on('message', (raw, isBinary) => this.onMessage(raw, isBinary));
    ws.on('pong', () => {
      this.alive = true;
    });
    ws.on('error', (err) => {
      this.deps.log.debug('terminal socket error', { sessionId: this.sessionId, error: errorName(err) });
      ws.terminate();
      this.onSocketClosed();
    });
    ws.on('close', () => this.onSocketClosed());
  }

  /**
   * Refuses the connection before any terminal exists: an error frame, then a close.
   * @param {string} code
   * @param {string} message
   * @param {number} closeCode
   */
  reject(code, message, closeCode) {
    this.sendFrame({ type: 'error', code, message });
    this.shutdown(closeCode, code);
  }

  /**
   * Resolves the target, takes the session lock and starts the Claude Code process. Never rejects.
   * @param {Target} target
   * @returns {Promise<void>}
   */
  async start(target) {
    this.sessionId = target.kind === 'session' ? target.sessionId : null;
    this.setupPending = true;
    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    try {
      await this.setup(target);
    } catch (err) {
      this.onSetupError(err);
    } finally {
      this.setupPending = false;
      this.finishIfIdle();
    }
  }

  /**
   * @param {Target} target
   */
  async setup(target) {
    const { config, engineHost } = this.deps;
    const cwd = target.kind === 'session' ? await engineHost.sessionCwd(target.sessionId) : target.cwd;
    if (this.closing) return;
    const realCwd = await resolveAllowedDir(cwd, config.roots);
    if (this.closing) return;
    if (!realCwd) {
      throw target.kind === 'session'
        ? new AppError(422, 'PATH_NOT_ALLOWED', 'The session directory is not inside a workspace root')
        : new AppError(400, 'BAD_REQUEST', 'cwd must be an existing directory inside a workspace root');
    }
    const bin = this.deps.claudeBin;
    if (!bin) throw new AppError(503, 'ENGINE_UNAVAILABLE', 'The Claude Code executable was not found');
    if (target.kind === 'session') {
      this.releaseLock = await engineHost.lockForTerminal(target.sessionId);
      if (this.closing) return;
    }
    this.launch(bin, target, realCwd);
  }

  /**
   * @param {string} bin
   * @param {Target} target
   * @param {string} cwd
   */
  launch(bin, target, cwd) {
    const args = target.kind === 'session' ? ['--resume', target.sessionId] : [];
    /** @type {PtyProcess} */
    let proc;
    try {
      proc = this.deps.pty.spawn(bin, args, {
        name: PTY_NAME,
        cols: PTY_COLS,
        rows: PTY_ROWS,
        cwd,
        env: buildChildEnv(process.env),
      });
    } catch (err) {
      this.deps.log.error('terminal spawn failed', { sessionId: this.sessionId, error: errorName(err) });
      throw new AppError(503, 'ENGINE_UNAVAILABLE', 'Claude Code could not be started in a terminal');
    }
    this.pty = proc;
    this.pid = proc.pid;
    this.ptyRunning = true;
    this.subscriptions.push(proc.onData((chunk) => this.onPtyData(chunk)));
    this.subscriptions.push(proc.onExit((event) => this.onPtyExit(event)));
    this.deps.log.info('terminal started', { sessionId: this.sessionId, pid: proc.pid });
    if (target.kind === 'session') {
      this.attached = true;
      this.deps.publish({
        type: 'terminal_state',
        sessionId: target.sessionId,
        data: { sessionId: target.sessionId, attached: true },
      });
    }
    this.ready = true;
    this.drainQueue();
  }

  /** @param {unknown} err */
  onSetupError(err) {
    if (this.closing) return;
    if (err instanceof AppError) {
      this.reject(err.code, err.message, err.status >= 500 ? 1011 : 1008);
      return;
    }
    this.deps.log.error('terminal setup failed', { sessionId: this.sessionId, error: errorName(err) });
    this.reject('INTERNAL', 'The terminal could not be started', 1011);
  }

  /**
   * @param {import('ws').WebSocket.RawData} raw
   * @param {boolean} isBinary
   */
  onMessage(raw, isBinary) {
    if (this.closing) return;
    if (!this.ready) {
      if (this.queued.length >= MAX_QUEUED_FRAMES) {
        this.sendError('BAD_REQUEST', 'Too many messages before the terminal started');
        return;
      }
      this.queued.push({ raw, isBinary });
      return;
    }
    this.handleFrame(raw, isBinary);
  }

  drainQueue() {
    for (const frame of this.queued.splice(0)) {
      if (this.closing) return;
      this.handleFrame(frame.raw, frame.isBinary);
    }
  }

  /**
   * @param {import('ws').WebSocket.RawData} raw
   * @param {boolean} isBinary
   */
  handleFrame(raw, isBinary) {
    if (isBinary) {
      this.sendError('BAD_REQUEST', 'Binary frames are not supported');
      return;
    }
    const buffer = toBuffer(raw);
    if (buffer.length > MAX_FRAME_BYTES) {
      this.sendError('BAD_REQUEST', 'Message is larger than 64 KiB');
      return;
    }
    /** @type {unknown} */
    let message;
    try {
      message = JSON.parse(buffer.toString('utf8'));
    } catch {
      this.sendError('BAD_REQUEST', 'Message is not valid JSON');
      return;
    }
    if (!isRecord(message)) {
      this.sendError('BAD_REQUEST', 'Message must be a JSON object');
      return;
    }
    if (message.type === 'input') {
      this.handleInput(message.data);
    } else if (message.type === 'resize') {
      this.handleResize(message.cols, message.rows);
    } else {
      this.sendError('BAD_REQUEST', 'Unknown message type');
    }
  }

  /** @param {unknown} data */
  handleInput(data) {
    if (typeof data !== 'string' || data.length > MAX_INPUT_CHARS) {
      this.sendError('BAD_REQUEST', `input.data must be a string of at most ${MAX_INPUT_CHARS} characters`);
      return;
    }
    this.withPty((pty) => pty.write(data));
  }

  /**
   * @param {unknown} cols
   * @param {unknown} rows
   */
  handleResize(cols, rows) {
    if (!isIntegerIn(cols, COLS_RANGE) || !isIntegerIn(rows, ROWS_RANGE)) {
      this.sendError('BAD_REQUEST', 'resize needs integer cols (20-500) and rows (5-200)');
      return;
    }
    this.withPty((pty) => pty.resize(cols, rows));
  }

  /** @param {string} chunk */
  onPtyData(chunk) {
    if (this.closing || !this.ptyRunning) return;
    this.output += chunk;
    if (this.output.length >= OUTPUT_FLUSH_NOW_CHARS) {
      this.flushOutput();
    } else if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => this.flushOutput(), OUTPUT_BATCH_MS);
    }
  }

  /** Sends everything buffered as output frames of at most 64K characters, never splitting a surrogate pair. */
  flushOutput() {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const text = this.output;
    this.output = '';
    let offset = 0;
    while (offset < text.length) {
      let end = Math.min(text.length, offset + OUTPUT_FRAME_CHARS);
      if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
      this.sendFrame({ type: 'output', data: text.slice(offset, end) });
      offset = end;
    }
    this.applyBackpressure();
  }

  /** @param {{exitCode: number, signal?: number}} event */
  onPtyExit(event) {
    if (!this.ptyRunning) return;
    this.ptyRunning = false;
    if (this.terminateTimer !== null) {
      clearTimeout(this.terminateTimer);
      this.terminateTimer = null;
    }
    const code = Number.isInteger(event.exitCode) ? event.exitCode : -1;
    this.deps.log.info('terminal exited', { sessionId: this.sessionId, pid: this.pid, exitCode: code });
    this.flushOutput();
    this.sendFrame({ type: 'exit', code });
    this.shutdown(1000, 'exited');
  }

  /** Flow control: pause the pty while the socket has more than 2 MiB queued, resume below 512 KiB. */
  applyBackpressure() {
    if (this.paused || !this.ptyRunning || this.ws.bufferedAmount <= BACKPRESSURE_HIGH_BYTES) return;
    this.paused = true;
    this.withPty((pty) => pty.pause());
    this.pollTimer = setInterval(() => {
      if (this.ws.bufferedAmount < BACKPRESSURE_LOW_BYTES) this.resumeOutput();
    }, BACKPRESSURE_POLL_MS);
  }

  resumeOutput() {
    if (!this.paused) return;
    this.paused = false;
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.withPty((pty) => pty.resume());
  }

  /**
   * Starts the shutdown: no further input or output, the socket is closed, the Claude Code process is asked to exit,
   * and the session lock is released once nothing is left running.
   * @param {number} closeCode
   * @param {string} reason
   */
  shutdown(closeCode, reason) {
    this.closing = true;
    this.output = '';
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close(closeCode, reason);
    this.stopPty();
    this.finishIfIdle();
  }

  onSocketClosed() {
    this.shutdown(1000, 'closed');
  }

  /** Sends SIGHUP and escalates to SIGKILL when the process is still alive after the grace period. */
  stopPty() {
    if (!this.ptyRunning || this.terminating) return;
    this.terminating = true;
    this.resumeOutput();
    this.withPty((pty) => pty.kill('SIGHUP'));
    this.terminateTimer = setTimeout(() => {
      this.terminateTimer = null;
      this.withPty((pty) => pty.kill('SIGKILL'));
    }, TERMINATE_GRACE_MS);
  }

  heartbeat() {
    if (this.closing) return;
    if (!this.alive) {
      this.deps.log.info('terminal peer unresponsive', { sessionId: this.sessionId, pid: this.pid });
      this.ws.terminate();
      return;
    }
    this.alive = false;
    if (this.ws.readyState === WebSocket.OPEN) this.ws.ping();
  }

  finishIfIdle() {
    if (!this.finished && this.closing && !this.setupPending && !this.ptyRunning) this.finish();
  }

  /** Releases every resource. Runs once, and only after the Claude Code process has exited. */
  finish() {
    this.finished = true;
    this.queued = [];
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    if (this.terminateTimer !== null) clearTimeout(this.terminateTimer);
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    this.flushTimer = null;
    this.terminateTimer = null;
    this.pollTimer = null;
    this.heartbeatTimer = null;
    const release = this.releaseLock;
    this.releaseLock = null;
    if (release) {
      try {
        release();
      } catch (err) {
        this.deps.log.warn('terminal lock release failed', { sessionId: this.sessionId, error: errorName(err) });
      }
    }
    if (this.attached && this.sessionId !== null) {
      this.attached = false;
      this.deps.publish({
        type: 'terminal_state',
        sessionId: this.sessionId,
        data: { sessionId: this.sessionId, attached: false },
      });
    }
    this.deps.log.info('terminal closed', { sessionId: this.sessionId, pid: this.pid });
    this.onFinished(this);
  }

  /** @param {(pty: PtyProcess) => void} action */
  withPty(action) {
    if (!this.ptyRunning || this.pty === null) return;
    try {
      action(this.pty);
    } catch (err) {
      this.deps.log.debug('terminal pty call failed', { sessionId: this.sessionId, error: errorName(err) });
    }
  }

  /**
   * @param {string} code
   * @param {string} message
   */
  sendError(code, message) {
    this.sendFrame({ type: 'error', code, message });
  }

  /** @param {Record<string, unknown>} frame */
  sendFrame(frame) {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(frame));
    } catch (err) {
      this.deps.log.debug('terminal frame not sent', { sessionId: this.sessionId, error: errorName(err) });
    }
  }
}

/**
 * @param {Config} config
 * @param {PtyModule|undefined} injected
 * @returns {Promise<{pty: PtyModule|null, disabledReason: 'disabled'|'node-pty-unavailable'|null}>}
 */
async function selectPty(config, injected) {
  if (!config.terminal) return { pty: null, disabledReason: 'disabled' };
  const pty = injected ?? (await loadNodePty());
  if (!pty || typeof pty.spawn !== 'function') return { pty: null, disabledReason: 'node-pty-unavailable' };
  return { pty, disabledReason: null };
}

/** @returns {Promise<PtyModule|null>} */
async function loadNodePty() {
  try {
    const mod = await import('node-pty');
    return { spawn: mod.spawn };
  } catch {
    return null;
  }
}

/**
 * Validates the upgrade query: exactly one of sessionId (UUID) or cwd (absolute path).
 * @param {string|undefined} rawUrl
 * @returns {Target}
 */
function parseTarget(rawUrl) {
  /** @type {URLSearchParams} */
  let params;
  try {
    params = new URL(rawUrl ?? '/', 'http://localhost').searchParams;
  } catch {
    throw badRequest('Malformed terminal request');
  }
  const sessionIds = params.getAll('sessionId');
  const cwds = params.getAll('cwd');
  if (sessionIds.length + cwds.length !== 1) throw badRequest('Exactly one of sessionId or cwd is required');
  if (sessionIds.length === 1) {
    if (!isUuid(sessionIds[0])) throw badRequest('sessionId must be a UUID');
    return { kind: 'session', sessionId: sessionIds[0] };
  }
  const cwd = cwds[0];
  if (cwd.length === 0 || cwd.length > MAX_CWD_CHARS || cwd.includes('\0') || !path.isAbsolute(cwd)) {
    throw badRequest('cwd must be an absolute path');
  }
  return { kind: 'directory', cwd };
}

/**
 * Realpath of `candidate` when it is an existing directory inside one of the roots, otherwise null.
 * @param {unknown} candidate
 * @param {string[]} roots
 * @returns {Promise<string|null>}
 */
async function resolveAllowedDir(candidate, roots) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || candidate.includes('\0')) return null;
  try {
    const real = await fs.promises.realpath(candidate);
    if (!(await fs.promises.stat(real)).isDirectory()) return null;
    return roots.some((root) => isInsideRoot(real, root)) ? real : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} real realpath of a candidate directory
 * @param {string} root realpath of a workspace root
 */
function isInsideRoot(real, root) {
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return real === root || real.startsWith(prefix);
}

/**
 * @param {string} binName
 * @param {string} pathValue
 * @returns {string|null}
 */
function findOnPath(binName, pathValue) {
  for (const dir of pathValue.split(path.delimiter)) {
    // Relative entries would resolve against the working directory, so they are never searched.
    if (dir === '' || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, binName);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Packages that ship the native binary, in lookup order. This mirrors the SDK's own choice (sdk.mjs), so the terminal
 * and the engine run the same file.
 * @param {string} platform
 * @param {string} arch
 * @param {boolean} preferMusl
 * @returns {string[]}
 */
function sdkPackageNames(platform, arch, preferMusl) {
  if (platform === 'android') return [`@anthropic-ai/claude-agent-sdk-linux-${arch}-android`];
  const name = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;
  if (platform !== 'linux') return [name];
  return preferMusl ? [`${name}-musl`, name] : [name, `${name}-musl`];
}

/** @type {boolean | null} */
let muslHost = null;

/**
 * True on Linux when the process report has no glibc runtime version, the same test the SDK uses for musl.
 * @returns {boolean}
 */
function isMuslHost() {
  if (muslHost === null) {
    /** @type {{header?: {glibcVersionRuntime?: string}} | null} */
    const report = typeof process.report?.getReport === 'function' ? process.report.getReport() : null;
    muslHost = process.platform === 'linux' && report !== null && report.header?.glibcVersionRuntime === undefined;
  }
  return muslHost;
}

/**
 * @param {string} pkg
 * @param {string} binName
 * @returns {string|null}
 */
function resolveSdkBinary(pkg, binName) {
  try {
    const file = requireFromHere.resolve(`${pkg}/${binName}`);
    // Existence is enough, as in the SDK: a shipped binary that cannot start fails at spawn rather than silently
    // running a different claude from PATH.
    return fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} file
 * @returns {boolean}
 */
function isExecutableFile(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Child environment: the gateway environment without any CAW_* variable (the Web token and gateway settings never
 * reach Claude Code), with the terminal capabilities declared.
 * @param {NodeJS.ProcessEnv} source
 * @returns {Record<string, string>}
 */
function buildChildEnv(source) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && !/^caw_/i.test(key)) env[key] = value;
  }
  env.TERM = PTY_NAME;
  env.COLORTERM = 'truecolor';
  return env;
}

/**
 * @param {import('ws').WebSocket.RawData} raw
 * @returns {Buffer}
 */
function toBuffer(raw) {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {readonly [number, number]} range
 * @returns {value is number}
 */
function isIntegerIn(value, [min, max]) {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * @param {number} code
 * @returns {boolean}
 */
function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * @param {string} message
 * @returns {AppError}
 */
function badRequest(message) {
  return new AppError(400, 'BAD_REQUEST', message);
}

/**
 * Error identity for logs: a code or a name, never the message (which may contain paths or content).
 * @param {unknown} err
 * @returns {string}
 */
function errorName(err) {
  if (isRecord(err)) {
    if (typeof err.code === 'string') return err.code;
    if (typeof err.name === 'string') return err.name;
  }
  return 'Error';
}
