// @ts-check
/**
 * Process bootstrap: wires configuration, the engine, workspaces, attachments, terminal, maintenance and the HTTP
 * server together. Run directly (`node src/server.mjs`) it also installs signal handlers and crash guards.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp } from './app.mjs';
import { createAuth } from './auth.mjs';
import { ConfigError, loadConfig } from './config.mjs';
import { EventHub } from './events.mjs';
import { createLogger } from './log.mjs';
import { isLoopbackHost } from './security.mjs';

/** @typedef {import('./contracts.mjs').EngineAdapter} EngineAdapter */
/** @typedef {import('./contracts.mjs').Logger} Logger */

const SHUTDOWN_TIMEOUT_MS = 5000;
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

/**
 * @param {unknown} error
 * @returns {string}
 */
function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {unknown} error
 * @returns {string|undefined}
 */
function stackOf(error) {
  return error instanceof Error ? error.stack : undefined;
}

/**
 * Runs one shutdown step; a failure is logged so the remaining steps still run.
 * @param {Logger} log
 * @param {string} label
 * @param {() => unknown} task
 */
async function safely(log, label, task) {
  try {
    await task();
  } catch (error) {
    log.error(label, { error: describe(error) });
  }
}

/**
 * @param {http.Server} server
 * @param {number} port
 * @param {string} host
 * @returns {Promise<void>}
 */
function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (/** @type {Error} */ error) => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

/**
 * Mock pacing taken from the environment handed to startServer (not process.env), blank meaning unset.
 * @param {Record<string, string|undefined>} env
 * @returns {string|undefined}
 */
function mockDelay(env) {
  const raw = env.CAW_MOCK_DELAY_MS;
  return raw === undefined || raw.trim() === '' ? undefined : raw.trim();
}

/**
 * Starts the gateway. Configuration errors (ConfigError) are thrown before anything is started.
 * @param {{env?: Record<string, string|undefined>, engine?: EngineAdapter, listenHost?: string, listenPort?: number}}
 *   [options] `engine` replaces the engine selected by CAW_ENGINE; `listenHost`/`listenPort` override CAW_HOST/CAW_PORT
 * @returns {Promise<{server: http.Server, url: string, config: import('./contracts.mjs').Config, log: Logger,
 *   engineHost: import('./engine/host.mjs').EngineHost, events: EventHub, close: () => Promise<void>}>}
 */
export async function startServer({ env = process.env, engine, listenHost, listenPort } = {}) {
  const config = loadConfig(env);
  await fs.promises.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const log = createLogger({ level: config.logLevel });
  const bootId = crypto.randomUUID();
  const events = new EventHub({ bootId, version: config.version, log });
  const publish = (/** @type {import('./contracts.mjs').GatewayEvent} */ event) => events.publish(event);

  const adapter = engine ?? (config.engine === 'mock'
    ? (await import('./engine/mock/index.mjs')).createMockAdapter({ config, log, delayMs: mockDelay(env) })
    : (await import('./engine/sdk-adapter.mjs')).createSdkAdapter({ config, log }));
  const stateStore = (await import('./state.mjs')).createStateStore(config.stateDir);
  const workspaces = (await import('./workspaces.mjs')).createWorkspaces(config, { stateStore });
  const attachments = (await import('./attachments.mjs')).createAttachments({ config, log, workspaces, stateStore });
  const { EngineHost } = await import('./engine/host.mjs');
  const engineHost = new EngineHost({
    engine: adapter,
    config,
    log,
    publish,
    getSeq: () => events.lastSeq,
    isAllowedCwd: (/** @type {string} */ p) => workspaces.isInsideRoots(p),
    isTrustedCwd: (/** @type {string} */ p) => workspaces.isTrusted(p),
  });
  const terminal = await (await import('./terminal.mjs')).createTerminal({ config, log, engineHost, publish });
  const maintenance = await (await import('./maintenance.mjs'))
    .startMaintenance({ config, log, attachments, engineHost });
  const auth = await createAuth(config, { log, bootId, stateStore });
  const app = createApp({
    config, log, engine: adapter, engineHost, events, auth, workspaces, attachments, terminal, bootId,
    publicDir: PUBLIC_DIR,
  });

  let closing = /** @type {Promise<void>|null} */ (null);
  /** Stops accepting connections, ends streams, closes terminals and sessions. Safe to call more than once. */
  const close = () => {
    if (!closing) closing = shutdown();
    return closing;
  };
  /** @returns {Promise<void>} */
  async function shutdown() {
    const stopped = new Promise((resolve) => server.close(() => resolve(undefined)));
    events.close();
    await safely(log, 'terminal shutdown failed', () => terminal.closeAll());
    await safely(log, 'maintenance shutdown failed', () => maintenance.stop());
    await closeEngine();
    server.closeAllConnections();
    await stopped;
  }
  async function closeEngine() {
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => {
        log.warn('engine shutdown exceeded its time limit', { timeoutMs: SHUTDOWN_TIMEOUT_MS });
        resolve(undefined);
      }, SHUTDOWN_TIMEOUT_MS);
      timer.unref?.();
    });
    const finished = Promise.resolve()
      .then(() => engineHost.shutdown())
      .catch((error) => log.error('engine shutdown failed', { error: describe(error) }));
    await Promise.race([finished, deadline]);
    clearTimeout(timer);
  }

  const server = http.createServer((req, res) => {
    void app.handleRequest(req, res);
  });
  // Server-Sent Events and uploads are long-lived, so the request timeout is disabled; idle sockets still expire.
  server.requestTimeout = 0;
  server.headersTimeout = 60000;
  server.keepAliveTimeout = 65000;
  server.on('upgrade', app.handleUpgrade);

  const host = listenHost ?? config.host;
  const port = listenPort ?? config.port;
  try {
    await listen(server, port, host);
  } catch (error) {
    await close();
    throw error;
  }
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const shownHost = host.includes(':') ? `[${host}]` : host;
  return {
    server,
    url: `http://${shownHost}:${actualPort}`,
    config,
    log,
    engineHost,
    events,
    close,
  };
}

async function main() {
  let running;
  try {
    running = await startServer();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`Configuration error: ${error.message}\n`);
      process.exit(2);
    }
    process.stderr.write(`Startup failed: ${describe(error)}\n`);
    process.exit(1);
  }
  const { log, config } = running;
  log.info('listening', { url: running.url });
  if (!config.requireAuth) log.warn('authentication is disabled; every client that can reach the listener has access');
  if (!config.publicOrigin && !isLoopbackHost(config.host)) {
    log.warn('CAW_PUBLIC_ORIGIN is not set and the listener is not on loopback; origin checks trust the Host header');
  }

  let stopping = false;
  /** @param {string} signal */
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down', { signal });
    running.close().then(
      () => process.exit(0),
      (error) => {
        log.error('shutdown failed', { error: describe(error) });
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.on('uncaughtException', (error) => {
    log.error('uncaught exception', { error: describe(error), stack: stackOf(error) });
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', { error: describe(reason), stack: stackOf(reason) });
    process.exit(1);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main();
}
