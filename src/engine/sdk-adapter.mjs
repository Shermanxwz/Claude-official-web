// @ts-check
/**
 * The EngineAdapter backed by the real @anthropic-ai/claude-agent-sdk. Every method delegates to one SDK export; no
 * behavior is added here, so the EngineHost sees exactly the SDK's semantics.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  deleteSession,
  forkSession,
  getSessionInfo,
  getSessionMessages,
  getSubagentMessages,
  listSessions,
  listSubagents,
  query,
  renameSession,
  resolveSettings,
  tagSession,
} from '@anthropic-ai/claude-agent-sdk';

/** @typedef {import('../contracts.mjs').EngineAdapter} EngineAdapter */
/** @typedef {import('../contracts.mjs').Config} Config */
/** @typedef {import('../contracts.mjs').Logger} Logger */

const require = createRequire(import.meta.url);

/**
 * Version of the installed SDK, read from the package.json that sits next to its entry point.
 * @returns {string|null}
 */
function readSdkVersion() {
  try {
    const entry = require.resolve('@anthropic-ai/claude-agent-sdk');
    const manifest = JSON.parse(readFileSync(join(dirname(entry), 'package.json'), 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}

/**
 * @param {{config: Config, log: Logger}} options
 * @returns {EngineAdapter}
 */
export function createSdkAdapter({ config, log }) {
  const sdkVersion = readSdkVersion();
  log.info('engine adapter ready', { engine: 'sdk', sdkVersion, customBinary: typeof config.claudeBin === 'string' });
  return {
    kind: 'sdk',
    sdkVersion,
    query: (params) => query(params),
    listSessions: (options) => listSessions(options),
    getSessionMessages: (sessionId, options) => getSessionMessages(sessionId, options),
    getSessionInfo: (sessionId, options) => getSessionInfo(sessionId, options),
    renameSession: (sessionId, title, options) => renameSession(sessionId, title, options),
    tagSession: (sessionId, tag, options) => tagSession(sessionId, tag, options),
    forkSession: (sessionId, options) => forkSession(sessionId, options),
    deleteSession: (sessionId, options) => deleteSession(sessionId, options),
    listSubagents: (sessionId) => listSubagents(sessionId),
    getSubagentMessages: (sessionId, agentId) => getSubagentMessages(sessionId, agentId),
    resolveSettings: (options) => resolveSettings(options),
  };
}
