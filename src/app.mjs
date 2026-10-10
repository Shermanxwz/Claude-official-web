// @ts-check
/**
 * HTTP application: route table, authentication and access gates, input validation, and the mapping of each request
 * onto the engine, workspace, attachment and terminal modules. Response shapes follow docs/PROTOCOL.md.
 */

import { AppError, EFFORT_LEVELS, PERMISSION_MODES, RUNTIME_VIEWS, isUuid } from './contracts.mjs';
import { createRouter, parseUrl, readJson, sendError, sendJson, serveStatic, withBodyIdleLimit } from './http.mjs';
import { createSessionSearch } from './search.mjs';
import { isAllowedHost, secureHeaders } from './security.mjs';

/** @typedef {import('node:http').IncomingMessage} IncomingMessage */
/** @typedef {import('node:http').ServerResponse} ServerResponse */
/** @typedef {import('node:stream').Duplex} Duplex */
/** @typedef {import('./contracts.mjs').Config} Config */
/** @typedef {import('./contracts.mjs').Logger} Logger */
/** @typedef {import('./contracts.mjs').EngineAdapter} EngineAdapter */
/** @typedef {import('./contracts.mjs').EngineHostApi} EngineHostApi */
/** @typedef {import('./contracts.mjs').WorkspacesApi} WorkspacesApi */
/** @typedef {import('./contracts.mjs').AttachmentsApi} AttachmentsApi */
/** @typedef {import('./contracts.mjs').TerminalApi} TerminalApi */
/** @typedef {import('./contracts.mjs').AccountApi} AccountApi */
/** @typedef {import('./contracts.mjs').SessionSettings} SessionSettings */
/** @typedef {import('./contracts.mjs').PermissionMode} PermissionMode */
/** @typedef {import('./contracts.mjs').EffortLevel} EffortLevel */
/** @typedef {import('./events.mjs').EventHub} EventHub */
/** @typedef {import('./auth.mjs').AuthApi} AuthApi */

/**
 * @typedef {Object} RouteContext
 * @property {IncomingMessage} req
 * @property {ServerResponse} res
 * @property {URL} url
 * @property {Record<string, string>} params
 */

const HANDLED = Symbol('handled');
const MAX_TEXT = 200000;
const MAX_ATTACHMENTS = 20;
const MAX_PATH = 4096;
const DEFAULT_TAIL = 200;
const TOKEN_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const FOLDER_NAME_RE = /^[A-Za-z0-9._ -]{1,100}$/;
const INTEGER_RE = /^\d{1,12}$/;
const MEDIA_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const DEFAULT_UPLOAD_TYPE = 'application/octet-stream';

/** @param {string} message @returns {AppError} */
function badRequest(message) {
  return new AppError(400, 'BAD_REQUEST', message);
}

/**
 * Drops undefined values so optional fields are passed to the modules only when the client sent them.
 * @template {Record<string, unknown>} T
 * @param {T} object
 * @returns {T}
 */
function definedOnly(object) {
  return /** @type {T} */ (Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined)));
}

/**
 * @template T
 * @param {Record<string, unknown>} body
 * @param {string} name
 * @param {(value: unknown) => T} parse
 * @returns {T|undefined}
 */
function optional(body, name, parse) {
  return body[name] === undefined ? undefined : parse(body[name]);
}

/**
 * @param {unknown} value
 * @param {string} name
 * @param {number} max
 * @returns {string}
 */
function requiredString(value, name, max) {
  if (typeof value !== 'string' || value.length > max) {
    throw badRequest(`${name} must be a string of at most ${max} characters`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @param {number} max
 * @returns {string}
 */
function nonEmptyString(value, name, max) {
  const text = requiredString(value, name, max);
  if (text.trim() === '') throw badRequest(`${name} must not be empty`);
  return text;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string} an absolute-path candidate (validated further by the workspace module)
 */
function pathValue(value, name) {
  if (typeof value !== 'string' || value === '' || value.length > MAX_PATH || value.includes('\u0000')) {
    throw badRequest(`${name} must be a path of 1 to ${MAX_PATH} characters`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string} an identifier such as a request, task or agent id
 */
function tokenValue(value, name) {
  if (typeof value !== 'string' || !TOKEN_RE.test(value)) throw badRequest(`${name} is not a valid identifier`);
  return value;
}

/**
 * @param {string} id
 * @returns {string}
 */
function sessionIdValue(id) {
  if (!isUuid(id)) throw badRequest('Session id must be a UUID');
  return id;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {boolean}
 */
function booleanValue(value, name) {
  if (typeof value !== 'boolean') throw badRequest(`${name} must be true or false`);
  return value;
}

/**
 * @template {string} T
 * @param {unknown} value
 * @param {string} name
 * @param {readonly T[]} allowed
 * @returns {T}
 */
function choiceValue(value, name, allowed) {
  if (typeof value !== 'string' || !(/** @type {readonly string[]} */ (allowed)).includes(value)) {
    throw new AppError(422, 'INVALID_ARGUMENT', `${name} must be one of: ${allowed.join(', ')}`);
  }
  return /** @type {T} */ (value);
}

/**
 * @param {URLSearchParams} query
 * @param {string} name
 * @param {number} min
 * @param {number} max
 * @returns {number|undefined}
 */
function queryInteger(query, name, min, max) {
  const raw = query.get(name);
  if (raw === null) return undefined;
  const value = INTEGER_RE.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw badRequest(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/**
 * @param {string|null} raw
 * @returns {string|null} null when the parameter is absent or blank
 */
function optionalPathQuery(raw) {
  return raw === null || raw === '' ? null : pathValue(raw, 'path');
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
function fileNameHeader(raw) {
  if (typeof raw !== 'string' || raw === '') throw badRequest('The X-File-Name header is required');
  let name;
  try {
    name = decodeURIComponent(raw);
  } catch {
    throw badRequest('X-File-Name must be URI-encoded');
  }
  if (name.trim() === '' || name.length > 255 || CONTROL_RE.test(name) || /[/\\]/.test(name)) {
    throw badRequest('X-File-Name is not a valid file name');
  }
  return name;
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
function uploadMediaType(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_UPLOAD_TYPE;
  const type = raw.split(';', 1)[0].trim().toLowerCase();
  if (!MEDIA_TYPE_RE.test(type)) throw badRequest('Content-Type must be a media type such as image/png');
  return type;
}

/**
 * @param {unknown} value
 * @returns {string[]} absolute paths previously returned by POST /api/attachments
 */
function attachmentPaths(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) {
    throw badRequest(`attachments must be an array of at most ${MAX_ATTACHMENTS} items`);
  }
  return value.map((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw badRequest('Each attachment must be an object with a path');
    }
    return pathValue(/** @type {Record<string, unknown>} */ (item).path, 'attachments[].path');
  });
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function nullableModel(value) {
  return value === null ? null : nonEmptyString(value, 'model', 200);
}

/**
 * @param {unknown} value
 * @returns {EffortLevel|null}
 */
function nullableEffort(value) {
  if (value === null) return null;
  return /** @type {EffortLevel} */ (choiceValue(value, 'effort', EFFORT_LEVELS));
}

/**
 * @param {unknown} value
 * @returns {PermissionMode}
 */
function permissionModeValue(value) {
  return /** @type {PermissionMode} */ (choiceValue(value, 'permissionMode', PERMISSION_MODES));
}

/**
 * @param {unknown} value
 * @returns {boolean|null} true or false to request fast mode, null to let the settings decide
 */
function nullableFastMode(value) {
  if (value === null) return null;
  if (typeof value !== 'boolean') throw new AppError(422, 'INVALID_ARGUMENT', 'fastMode must be true, false or null');
  return value;
}

/**
 * @param {unknown} value
 * @returns {PermissionMode|null} null: Claude Code's settings decide (the host refuses it for an open session)
 */
function nullablePermissionMode(value) {
  return value === null ? null : permissionModeValue(value);
}

/**
 * @param {unknown} value
 * @returns {string|null} null clears the main-thread agent
 */
function nullableAgent(value) {
  return value === null ? null : nonEmptyString(value, 'agent', 200);
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function nullableFallbackModel(value) {
  return value === null ? null : nonEmptyString(value, 'fallbackModel', 200);
}

/**
 * @param {unknown} value
 * @returns {string[]} folders as sent (the host resolves them)
 */
function directoryList(value) {
  if (!Array.isArray(value)) throw badRequest('additionalDirectories must be a list of folders');
  return value.map((item) => pathValue(item, 'additionalDirectories'));
}

/**
 * @param {unknown} value
 * @returns {'default'|'auto'|null}
 */
function mcpModeValue(value) {
  return value === null ? null : /** @type {'default'|'auto'} */ (choiceValue(value, 'mode', ['default', 'auto']));
}

/**
 * Reads the optional session settings shared by session creation, open and settings: the model, permission mode,
 * effort, fast mode, main-thread agent, additional folders, fallback model and browser tools.
 * @param {Record<string, unknown>} body
 * @returns {SessionSettings}
 */
function settingsFrom(body) {
  return definedOnly({
    model: optional(body, 'model', nullableModel),
    permissionMode: optional(body, 'permissionMode', nullablePermissionMode),
    effort: optional(body, 'effort', nullableEffort),
    fastMode: optional(body, 'fastMode', nullableFastMode),
    agent: optional(body, 'agent', nullableAgent),
    additionalDirectories: optional(body, 'additionalDirectories', directoryList),
    fallbackModel: optional(body, 'fallbackModel', nullableFallbackModel),
    browserTools: optional(body, 'browserTools', (value) => booleanValue(value, 'browserTools')),
  });
}

/**
 * The runtime view a path names.
 * @param {string} name
 * @returns {string}
 */
function runtimeViewName(name) {
  if (!Object.hasOwn(RUNTIME_VIEWS, name)) throw new AppError(404, 'NOT_FOUND', 'No such runtime view');
  return name;
}

/**
 * @param {IncomingMessage} req
 * @returns {string|undefined}
 */
function lastEventIdHeader(req) {
  const value = req.headers['last-event-id'];
  return typeof value === 'string' ? value : undefined;
}

/**
 * @param {import('node:stream').Duplex} socket
 * @param {number} status
 * @param {string} reason
 */
function rejectUpgrade(socket, status, reason) {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/**
 * @param {ServerResponse} res
 * @param {number} status
 * @param {string} text
 * @param {Record<string, string|number>} headers
 */
function sendText(res, status, text, headers) {
  res.writeHead(status, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

/**
 * @param {{config: Config, log: Logger, engine: EngineAdapter, engineHost: EngineHostApi, events: EventHub,
 *   auth: AuthApi, workspaces: WorkspacesApi, attachments: AttachmentsApi, terminal: TerminalApi, account: AccountApi,
 *   bootId: string, publicDir: string}} deps
 * @returns {{handleRequest: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
 *   handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void}}
 */
export function createApp({ config, log, engine, engineHost, events, auth, workspaces, attachments, terminal, account,
  bootId, publicDir }) {
  const https = config.publicOrigin.startsWith('https://');
  const securityHeaders = () => secureHeaders({}, { https });
  const router = createRouter();
  const search = createSessionSearch({
    listAll: () => engineHost.listAllSessions(),
    getSessionMessages: (sessionId) => engine.getSessionMessages(sessionId),
  });
  /** Last Claude Code version seen on a live session; remembered once known. */
  let claudeCodeVersion = /** @type {string|null} */ (null);

  /** @throws {AppError} 501 when bypassPermissions is not enabled, 403 when the profile is not full */
  function assertBypassAllowed() {
    if (!config.allowBypass) {
      throw new AppError(501, 'FEATURE_DISABLED', 'The bypassPermissions mode is disabled (set CAW_ALLOW_BYPASS=1)');
    }
    auth.requireProfile(config.profile, 'full');
  }

  /**
   * Settings that need more than the route's profile: bypass permissions and the browser tools need the full profile.
   * @param {SessionSettings} settings
   */
  function assertSettingsAllowed(settings) {
    if (settings.permissionMode === 'bypassPermissions') assertBypassAllowed();
    if (settings.browserTools !== undefined) auth.requireProfile(config.profile, 'full');
  }

  function metaBody() {
    for (const live of engineHost.allLive()) {
      if (live.claudeCodeVersion) claudeCodeVersion = live.claudeCodeVersion;
    }
    const remembered = engineHost.lastClaudeCodeVersion?.() ?? null;
    if (remembered) claudeCodeVersion = remembered;
    return {
      appName: config.appName,
      version: config.version,
      bootId,
      engine: config.engine,
      sdkVersion: engine.sdkVersion ?? null,
      claudeCodeVersion,
      profile: config.profile,
      roots: config.roots,
      defaults: config.defaults,
      features: {
        terminal: terminal.enabled,
        bypass: config.allowBypass && config.profile === 'full',
        uploads: true,
        backgroundTasks: !config.backgroundTasksDisabled,
        accountLogin: true,
        browserTools: Array.isArray(config.browserMcpCommand),
        chrome: config.chrome === true,
      },
      limits: {
        uploadMaxBytes: config.uploadMaxBytes,
        imageMaxBytes: config.imageMaxBytes,
        maxLiveSessions: config.maxLiveSessions,
      },
    };
  }

  // Public routes: no profile means no session is required. Origin is still checked for writes.
  router.add('GET', '/api/session', ({ req }) => auth.sessionInfo(req));
  router.add('POST', '/api/login', async ({ req, res }) => {
    await auth.login(req, res);
    return HANDLED;
  });

  // Any signed-in client.
  router.add('POST', '/api/logout', async ({ req, res }) => {
    await auth.logout(req, res);
    return HANDLED;
  }, { profile: 'read' });

  // read
  router.add('GET', '/api/meta', () => metaBody(), { profile: 'read' });
  router.add('GET', '/api/events', ({ req, res, url }) => {
    const watch = url.searchParams.get('watch');
    if (watch !== null && !isUuid(watch)) throw badRequest('watch must be a session UUID');
    events.attach(req, res, {
      clientAddress: auth.clientAddress(req),
      watch: watch ?? undefined,
      after: queryInteger(url.searchParams, 'after', 0, 999999999999),
      lastEventId: lastEventIdHeader(req),
      headers: securityHeaders(),
    });
    return HANDLED;
  }, { profile: 'read' });
  router.add('GET', '/api/fs/dirs', ({ url }) => workspaces.listDirs(optionalPathQuery(url.searchParams.get('path'))),
    { profile: 'read' });
  router.add('GET', '/api/fs/search', async ({ url }) => {
    const cwd = await workspaces.resolveDir(pathValue(url.searchParams.get('cwd'), 'cwd'));
    const q = url.searchParams.get('q') ?? '';
    if (q.length > 200) throw badRequest('q must be at most 200 characters');
    const limit = queryInteger(url.searchParams, 'limit', 1, 200) ?? 50;
    const session = url.searchParams.get('session');
    if (session !== null) {
      const runtime = await engineHost.fileSuggestions(sessionIdValue(session), cwd, q, limit);
      if (runtime !== null) return { results: runtime, source: 'runtime' };
    }
    const found = await workspaces.search(cwd, q, limit);
    return { results: found.results, source: 'gateway' };
  }, { profile: 'read' });
  router.add('GET', '/api/fs/trust', async ({ url }) => {
    const folder = pathValue(url.searchParams.get('path'), 'path');
    return { path: folder, trusted: await workspaces.isTrusted(folder) };
  }, { profile: 'read' });
  router.add('GET', '/api/sessions', async ({ url }) => {
    const options = definedOnly({
      cwd: optionalPathQuery(url.searchParams.get('cwd')) ?? undefined,
      limit: queryInteger(url.searchParams, 'limit', 1, 500) ?? 100,
      offset: queryInteger(url.searchParams, 'offset', 0, 1000000) ?? 0,
    });
    return { sessions: await engineHost.listSessions(options) };
  }, { profile: 'read' });
  // Registered before /api/sessions/:id, which would otherwise match the word "search".
  router.add('GET', '/api/sessions/search', ({ url }) => {
    const limit = queryInteger(url.searchParams, 'limit', 1, 50) ?? 20;
    return search.search(url.searchParams.get('q') ?? '', limit);
  }, { profile: 'read' });
  router.add('GET', '/api/sessions/:id', ({ params }) => engineHost.getSession(sessionIdValue(params.id)),
    { profile: 'read' });
  router.add('GET', '/api/sessions/:id/messages', ({ params, url }) => {
    const id = sessionIdValue(params.id);
    const tail = queryInteger(url.searchParams, 'tail', 1, 1000);
    const before = queryInteger(url.searchParams, 'before', 0, 1000000000);
    const limit = queryInteger(url.searchParams, 'limit', 1, 1000);
    if (tail !== undefined && before !== undefined) throw badRequest('Use either tail or before, not both');
    if (before === undefined && limit !== undefined) throw badRequest('limit requires before');
    const options = before !== undefined
      ? { before, limit: limit ?? DEFAULT_TAIL }
      : { tail: tail ?? DEFAULT_TAIL };
    return engineHost.getTranscript(id, options);
  }, { profile: 'read' });
  router.add('GET', '/api/sessions/:id/context', ({ params, url }) => {
    const detail = url.searchParams.get('detail');
    if (detail !== null && detail !== 'summary' && detail !== 'full') {
      throw badRequest('detail must be summary or full');
    }
    return engineHost.getContextUsage(sessionIdValue(params.id), detail ?? undefined);
  }, { profile: 'read' });
  router.add('GET', '/api/sessions/:id/capabilities', ({ params }) =>
    engineHost.getCapabilities(sessionIdValue(params.id)), { profile: 'read' });
  router.add('GET', '/api/sessions/:id/subagents', async ({ params }) => ({
    agents: await engineHost.listSubagents(sessionIdValue(params.id)),
  }), { profile: 'read' });
  router.add('GET', '/api/sessions/:id/subagents/:agentId/messages', async ({ params }) => ({
    messages: await engineHost.getSubagentMessages(sessionIdValue(params.id), tokenValue(params.agentId, 'agentId')),
  }), { profile: 'read' });
  router.add('GET', '/api/sessions/:id/tasks/:taskId/output', ({ params }) =>
    engineHost.taskOutput(sessionIdValue(params.id), tokenValue(params.taskId, 'taskId')), { profile: 'read' });
  router.add('GET', '/api/sessions/:id/runtime', ({ params }) => engineHost.runtimeViews(sessionIdValue(params.id)),
    { profile: 'read' });
  router.add('GET', '/api/sessions/:id/runtime/:view', ({ params }) => {
    const id = sessionIdValue(params.id);
    const view = runtimeViewName(params.view);
    auth.requireProfile(config.profile, RUNTIME_VIEWS[view].profile);
    return engineHost.runtimeView(id, view);
  }, { profile: 'read' });
  router.add('GET', '/api/sessions/:id/memory', ({ params }) => engineHost.getMemory(sessionIdValue(params.id)),
    { profile: 'read' });
  router.add('GET', '/api/sessions/:id/export', ({ params }) =>
    engineHost.exportConversation(sessionIdValue(params.id)), { profile: 'read' });
  router.add('GET', '/api/account', () => account.status(), { profile: 'read' });

  // standard
  router.add('POST', '/api/fs/mkdir', async ({ req }) => {
    const body = await readJson(req);
    const parent = pathValue(body.parent, 'parent');
    const name = requiredString(body.name, 'name', 100);
    if (name === '.' || name === '..' || !FOLDER_NAME_RE.test(name)) {
      throw new AppError(422, 'INVALID_ARGUMENT', 'Folder names use letters, digits, dot, underscore, space or hyphen');
    }
    return workspaces.mkdir(parent, name);
  }, { profile: 'standard' });
  router.add('POST', '/api/fs/trust', async ({ req }) => {
    const body = await readJson(req);
    const folder = pathValue(body.path, 'path');
    const trusted = booleanValue(body.trusted, 'trusted');
    const result = await workspaces.setTrusted(folder, trusted);
    const runtimeTrust = trusted ? await engineHost.recordRuntimeTrust(result.path) : 'skipped';
    return { ...result, runtimeTrust };
  }, { profile: 'standard' });
  router.add('POST', '/api/sessions', async ({ req }) => {
    const body = await readJson(req);
    const settings = settingsFrom(body);
    assertSettingsAllowed(settings);
    const title = optional(body, 'title', (value) => nonEmptyString(value, 'title', 200));
    const cwd = await workspaces.resolveDir(pathValue(body.cwd, 'cwd'));
    return { live: await engineHost.createSession(definedOnly({ cwd, title, ...settings })) };
  }, { profile: 'standard' });
  router.add('POST', '/api/sessions/:id/open', async ({ req, params }) => {
    const id = sessionIdValue(params.id);
    const settings = settingsFrom(await readJson(req));
    assertSettingsAllowed(settings);
    return { live: await engineHost.openSession(id, settings) };
  }, { profile: 'standard' });
  router.add('POST', '/api/sessions/:id/close', async ({ params }) => {
    await engineHost.closeSession(sessionIdValue(params.id));
    return { ok: true };
  }, { profile: 'standard' });
  router.add('POST', '/api/sessions/:id/messages', async ({ req, params }) => {
    const id = sessionIdValue(params.id);
    const body = await readJson(req);
    const clientMessageId = body.clientMessageId;
    if (typeof clientMessageId !== 'string' || !isUuid(clientMessageId)) {
      throw badRequest('clientMessageId must be a UUID');
    }
    let text = requiredString(body.text, 'text', MAX_TEXT);
    const references = attachmentPaths(body.attachments);
    if (text.trim() === '' && references.length === 0) throw badRequest('The message has no text or attachments');
    const cwd = await engineHost.sessionCwd(id);
    /** @type {Array<{mediaType: string, data: string}>} */
    const images = [];
    for (const reference of references) {
      const resolved = await attachments.resolveAttachment(reference, cwd);
      if (resolved.kind === 'image') images.push({ mediaType: resolved.mediaType, data: resolved.data });
      else text += `\n\nAttached file: ${resolved.path}`;
    }
    return engineHost.sendMessage(id, { clientMessageId, text, images });
  }, { profile: 'standard' });
  router.add('POST', '/api/sessions/:id/interrupt', async ({ req, params }) => {
    const id = sessionIdValue(params.id);
    const body = await readJson(req);
    const cancelQueued = optional(body, 'cancelQueued', (value) => booleanValue(value, 'cancelQueued'));
    return { ok: true, ...(await engineHost.interrupt(id, definedOnly({ cancelQueued }))) };
  }, { profile: 'standard' });
  router.add('DELETE', '/api/sessions/:id/queued/:clientMessageId', ({ params }) =>
    engineHost.cancelQueued(sessionIdValue(params.id), tokenValue(params.clientMessageId, 'clientMessageId')),
  { profile: 'standard' });
  router.add('POST', '/api/sessions/:id/settings', async ({ req, params }) => {
    const id = sessionIdValue(params.id);
    const settings = settingsFrom(await readJson(req));
    assertSettingsAllowed(settings);
    return engineHost.updateSettings(id, settings);
  }, { profile: 'standard' });
  router.add('POST', '/api/sessions/:id/mcp', async ({ req, params }) => {
    const id = sessionIdValue(params.id);
    const body = await readJson(req);
    const server = nonEmptyString(body.server, 'server', 200);
    const action = /** @type {'toggle'|'reconnect'|'permission-mode'} */ (
      choiceValue(body.action, 'action', ['toggle', 'reconnect', 'permission-mode']));
    const enabled = optional(body, 'enabled', (value) => booleanValue(value, 'enabled'));
    const mode = optional(body, 'mode', mcpModeValue);
    return engineHost.mcpAction(id, server, definedOnly({ action, enabled, mode }));
  }, { profile: 'standard' });
  router.add('POST', '/api/sessions/:id/mcp/auth', async ({ req, params }) => {
    const id = sessionIdValue(params.id);
    const body = await readJson(req);
    const server = nonEmptyString(body.server, 'server', 200);
    const action = /** @type {'start'|'callback'|'clear'} */ (choiceValue(body.action, 'action',
      ['start', 'callback', 'clear']));
    const callbackUrl = optional(body, 'callbackUrl', (value) => requiredString(value, 'callbackUrl', 4096));
    return engineHost.mcpAuth(id, server, definedOnly({ action, callbackUrl }));
  }, { profile: 'standard' });
  router.add('PUT', '/api/sessions/:id/memory', async ({ req, params }) => {
    const id = sessionIdValue(params.id);
    const body = await readJson(req);
    const content = requiredString(body.content, 'content', 1048576);
    const { bytes } = await engineHost.writeMemory(id, pathValue(body.path, 'path'), content);
    return { ok: true, bytes };
  }, { profile: 'standard' });
  router.add('POST', '/api/sessions/:id/side-question', async ({ req, params }) => {
    const id = sessionIdValue(params.id);
    const body = await readJson(req);
    return engineHost.sideQuestion(id, requiredString(body.question, 'question', MAX_TEXT));
  }, { profile: 'standard' });
  router.add('POST', '/api/sessions/:id/reload', async ({ req, params }) => {
    const id = sessionIdValue(params.id);
    const body = await readJson(req);
    const what = choiceValue(body.what, 'what', ['plugins', 'skills', 'output-styles']);
    const force = optional(body, 'force', (value) => booleanValue(value, 'force'));
    return engineHost.reload(id, what, definedOnly({ force }));
  }, { profile: 'standard' });
  router.add('POST', '/api/sessions/:id/background', async ({ req, params }) => {
    const id = sessionIdValue(params.id);
    const body = await readJson(req);
    const toolUseId = optional(body, 'toolUseId', (value) => tokenValue(value, 'toolUseId'));
    return engineHost.backgroundTasks(id, toolUseId);
  }, { profile: 'standard' });
  router.add('POST', '/api/sessions/:id/output-style', async ({ req, params }) => {
    const id = sessionIdValue(params.id);
    const body = await readJson(req);
    return engineHost.setOutputStyle(id, requiredString(body.style, 'style', MAX_TEXT));
  }, { profile: 'standard' });
  router.add('POST', '/api/sessions/:id/rewind', async ({ req, params }) => {
    const id = sessionIdValue(params.id);
    const body = await readJson(req);
    const userMessageId = tokenValue(body.userMessageId, 'userMessageId');
    const mode = choiceValue(body.mode, 'mode', ['code', 'conversation', 'both']);
    const dryRun = optional(body, 'dryRun', (value) => booleanValue(value, 'dryRun'));
    return engineHost.rewind(id, definedOnly({ userMessageId, mode, dryRun }));
  }, { profile: 'standard' });
  router.add('POST', '/api/sessions/:id/fork', async ({ req, params }) => {
    const id = sessionIdValue(params.id);
    const body = await readJson(req);
    const upToMessageId = optional(body, 'upToMessageId', (value) => tokenValue(value, 'upToMessageId'));
    const title = optional(body, 'title', (value) => nonEmptyString(value, 'title', 200));
    return engineHost.fork(id, definedOnly({ upToMessageId, title }));
  }, { profile: 'standard' });
  router.add('POST', '/api/sessions/:id/requests/:requestId', async ({ req, params }) => {
    const id = sessionIdValue(params.id);
    const requestId = tokenValue(params.requestId, 'requestId');
    await engineHost.respond(id, requestId, await readJson(req));
    return { ok: true };
  }, { profile: 'standard' });
  router.add('POST', '/api/sessions/:id/tasks/:taskId/stop', async ({ params }) => {
    await engineHost.stopTask(sessionIdValue(params.id), tokenValue(params.taskId, 'taskId'));
    return { ok: true };
  }, { profile: 'standard' });
  router.add('PATCH', '/api/sessions/:id', async ({ req, params }) => {
    const id = sessionIdValue(params.id);
    const body = await readJson(req);
    const title = optional(body, 'title', (value) => nonEmptyString(value, 'title', 200));
    const tag = optional(body, 'tag', (value) => (value === null ? null : requiredString(value, 'tag', 100)));
    if (title === undefined && tag === undefined) throw badRequest('Provide a title or a tag');
    if (title !== undefined) await engineHost.rename(id, title);
    if (tag !== undefined) await engineHost.tag(id, tag);
    return { ok: true };
  }, { profile: 'standard' });
  router.add('POST', '/api/attachments', async ({ req, url }) => {
    const cwd = await workspaces.resolveDir(pathValue(url.searchParams.get('cwd'), 'cwd'));
    const fileName = fileNameHeader(req.headers['x-file-name']);
    const mediaType = uploadMediaType(req.headers['content-type']);
    return withBodyIdleLimit(req, () => attachments.save(req, { cwd, fileName, mediaType }));
  }, { profile: 'standard' });

  // Claude Code's own sign-in (the gateway never reads the credentials).
  router.add('POST', '/api/account/login', async ({ req }) => {
    const body = await readJson(req);
    // The account checks the method itself and answers 400 for any other value.
    return account.startLogin(/** @type {'claudeai'|'console'} */ (body.method));
  }, { profile: 'full' });
  router.add('POST', '/api/account/login/code', async ({ req }) => {
    const body = await readJson(req);
    return account.completeLogin(typeof body.code === 'string' ? body.code : '');
  }, { profile: 'full' });
  router.add('DELETE', '/api/account/login', async () => {
    await account.cancelLogin();
    return { ok: true };
  }, { profile: 'full' });

  // full
  router.add('DELETE', '/api/sessions/:id', async ({ params }) => {
    await engineHost.deleteSession(sessionIdValue(params.id));
    return { ok: true };
  }, { profile: 'full' });
  router.add('GET', '/api/terminal', () => {
    throw badRequest('This endpoint requires a WebSocket upgrade');
  }, { profile: 'full' });

  /**
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   */
  async function dispatch(req, res) {
    if (!isAllowedHost(req.headers.host, config.publicOrigin)) {
      log.warn('request host rejected');
      throw new AppError(421, 'HOST_REJECTED', 'The Host header is not allowed');
    }
    const url = parseUrl(req);
    const { pathname } = url;
    const method = req.method ?? '';
    if (method === 'GET' && pathname === '/healthz') {
      sendJson(res, 200, { ok: true }, securityHeaders());
      return;
    }
    if (pathname !== '/api' && !pathname.startsWith('/api/')) {
      if (!(await serveStatic(req, res, { publicDir, https }))) sendText(res, 404, 'Not found', securityHeaders());
      return;
    }
    const matched = router.match(method, pathname);
    if (matched === null || 'methodMismatch' in matched) {
      throw new AppError(404, 'NOT_FOUND', 'No such API route');
    }
    const { route, params } = matched;
    const safe = method === 'GET' || method === 'HEAD';
    if (route.profile === undefined) {
      if (!safe) auth.checkOrigin(req);
    } else {
      const actor = auth.authenticate(req);
      if (!actor) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue');
      if (!safe) auth.checkOrigin(req);
      auth.requireProfile(actor.profile, route.profile);
    }
    const result = await route.handler(/** @type {RouteContext} */ ({ req, res, url, params }));
    if (result !== HANDLED) sendJson(res, 200, result, securityHeaders());
  }

  return {
    /**
     * @param {IncomingMessage} req
     * @param {ServerResponse} res
     */
    async handleRequest(req, res) {
      try {
        await dispatch(req, res);
      } catch (error) {
        sendError(res, error, log, securityHeaders());
      }
    },

    /**
     * Only the terminal WebSocket is upgraded. Every failure is answered with a bare status line and the socket is
     * closed, because no HTTP response machinery is available after an upgrade request.
     * @param {IncomingMessage} req
     * @param {Duplex} socket
     * @param {Buffer} head
     */
    handleUpgrade(req, socket, head) {
      if (!isAllowedHost(req.headers.host, config.publicOrigin)) {
        log.warn('upgrade host rejected');
        rejectUpgrade(socket, 421, 'Misdirected Request');
        return;
      }
      let url;
      try {
        url = parseUrl(req);
      } catch {
        socket.destroy();
        return;
      }
      if (url.pathname !== '/api/terminal' || req.method !== 'GET') {
        socket.destroy();
        return;
      }
      const actor = auth.authenticate(req);
      if (!actor) {
        rejectUpgrade(socket, 401, 'Unauthorized');
        return;
      }
      try {
        auth.checkOrigin(req);
        auth.requireProfile(actor.profile, 'full');
      } catch {
        log.warn('terminal upgrade rejected', { status: 403 });
        rejectUpgrade(socket, 403, 'Forbidden');
        return;
      }
      if (!terminal.enabled) {
        log.warn('terminal upgrade rejected', { status: 501 });
        rejectUpgrade(socket, 501, 'Not Implemented');
        return;
      }
      terminal.handleUpgrade(req, socket, head);
    },
  };
}
