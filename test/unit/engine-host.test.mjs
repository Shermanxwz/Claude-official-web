import { test, describe, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EngineHost } from '../../src/engine/host.mjs';
import { AsyncQueue } from '../../src/engine/queue.mjs';
import { AppError, DIALOG_KINDS, UNATTENDED_QUESTION_MESSAGE, isUuid } from '../../src/contracts.mjs';

/** The gateway's state folder for every host of this file: trust probes run inside it, never in the repository. */
const STATE_DIR = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'caw-host-state-'));
/** The working folder is a real folder, because the trust handshake resolves the folder it records. */
const CWD = path.join(STATE_DIR, 'alpha');
const OUTSIDE = '/elsewhere/beta';
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';
const UNKNOWN = '44444444-4444-4444-8444-444444444444';
const MINUTE = 60_000;
fs.mkdirSync(CWD);
/** The user's home folder of the harness, so that memory files never reach the real one. */
const HOME = path.join(STATE_DIR, 'home');
fs.mkdirSync(HOME);

after(() => {
  fs.rmSync(STATE_DIR, { recursive: true, force: true });
});

/** Lets pending promise chains and the pump run to their next macrotask. */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Asserts that the promise rejects with an AppError of the given status and code. */
async function expectError(promise, status, code) {
  await assert.rejects(promise, (error) => error instanceof AppError && error.status === status && error.code === code);
}

/** Scripted stand-in for the SDK query: the test emits messages and inspects every control call. */
class FakeQuery {
  /** @type {Map<string, Error>} */
  failures = new Map();
  /** @type {'end'|'fail'} */
  closeMode = 'end';
  ignoreClose = false;
  closed = false;
  /** Methods that never answer, so that the control timeout is what ends them. */
  hangs = new Set();

  /**
   * @param {AsyncQueue<unknown>} prompt
   * @param {Record<string, unknown>} options
   */
  constructor(prompt, options) {
    this.prompt = prompt;
    this.options = options;
    this.messages = new AsyncQueue();
    this.calls = [];
    this.values = {
      initializationResult: structuredClone(DEFAULT_INIT),
      mcpServerStatus: structuredClone(DEFAULT_MCP),
      rewindFiles: { ...DEFAULT_REWIND },
      getContextUsage: structuredClone(DEFAULT_CONTEXT),
      backgroundTasks: true,
      reloadOutputStyles: { available_output_styles: ['default', 'explanatory'] },
      setCwd: { status: 'ok', cwd: CWD, changed: false },
      interrupt: undefined,
    };
  }

  [Symbol.asyncIterator]() {
    return this.messages[Symbol.asyncIterator]();
  }

  /** @param {unknown} msg */
  emit(msg) {
    if (this.closed || this.messages.ended) throw new Error('test emitted after the query ended');
    this.messages.push(msg);
  }

  finish() {
    this.messages.end();
  }

  /** @param {Error} error */
  fail(error) {
    this.messages.fail(error);
  }

  /**
   * @param {string} name
   * @param {unknown[]} args
   */
  async #call(name, ...args) {
    this.calls.push([name, ...args]);
    const failure = this.failures.get(name);
    if (failure) throw failure;
    if (this.hangs.has(name)) await new Promise(() => {});
    const value = this.values[name];
    return typeof value === 'function' ? value(...args) : value;
  }

  interrupt(...args) { return this.#call('interrupt', ...args); }
  setCwd(directory, options) { return this.#call('setCwd', directory, ...(options ? [options] : [])); }
  setPermissionMode(mode) { return this.#call('setPermissionMode', mode); }
  setModel(model) { return this.#call('setModel', model); }
  applyFlagSettings(settings) { return this.#call('applyFlagSettings', settings); }
  rewindFiles(messageId, options) { return this.#call('rewindFiles', messageId, options); }
  getContextUsage(options) { return this.#call('getContextUsage', options); }
  initializationResult() { return this.#call('initializationResult'); }
  mcpServerStatus() { return this.#call('mcpServerStatus'); }
  toggleMcpServer(name, enabled) { return this.#call('toggleMcpServer', name, enabled); }
  reconnectMcpServer(name) { return this.#call('reconnectMcpServer', name); }
  reloadPlugins(options) { return this.#call('reloadPlugins', options); }
  reloadSkills() { return this.#call('reloadSkills'); }
  reloadOutputStyles() { return this.#call('reloadOutputStyles'); }
  stopTask(taskId) { return this.#call('stopTask', taskId); }
  backgroundTasks(toolUseId) { return this.#call('backgroundTasks', toolUseId); }
  updateSettings(source, settings) { return this.#call('updateSettings', source, settings); }
  setMcpServers(servers) { return this.#call('setMcpServers', servers); }
  setMcpPermissionModeOverride(name, mode) { return this.#call('setMcpPermissionModeOverride', name, mode); }
  mcpAuthenticate(name) { return this.#call('mcpAuthenticate', name); }
  mcpSubmitOAuthCallbackUrl(name, url) { return this.#call('mcpSubmitOAuthCallbackUrl', name, url); }
  mcpClearAuth(name) { return this.#call('mcpClearAuth', name); }
  getStatus() { return this.#call('getStatus'); }
  listPermissionRules() { return this.#call('listPermissionRules'); }
  getHooksListing() { return this.#call('getHooksListing'); }
  getSettings() { return this.#call('getSettings'); }
  getSkillsDialog() { return this.#call('getSkillsDialog'); }
  getSandboxDialog() { return this.#call('getSandboxDialog'); }
  getPlan() { return this.#call('getPlan'); }
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(options) {
    return this.#call('usage', options);
  }
  accountInfo() { return this.#call('accountInfo'); }
  getChromeDialog() { return this.#call('getChromeDialog'); }
  getMemoryDialog() { return this.#call('getMemoryDialog'); }
  readFile(filePath, options) { return this.#call('readFile', filePath, options); }
  getTaskOutput(taskId) { return this.#call('getTaskOutput', taskId); }
  askSideQuestion(question) { return this.#call('askSideQuestion', question); }
  exportConversation() { return this.#call('exportConversation'); }
  cancelAsyncMessage(uuid) { return this.#call('cancelAsyncMessage', uuid); }
  request(envelope) { return this.#call('request', envelope); }

  close() {
    this.calls.push(['close']);
    if (this.ignoreClose) return;
    this.closed = true;
    if (this.closeMode === 'fail') {
      this.messages.fail(Object.assign(new Error('Operation aborted'), { name: 'AbortError' }));
    } else {
      this.messages.end();
    }
  }
}

const DEFAULT_INIT = {
  commands: [{ name: 'help', description: 'Show help', argumentHint: '' }],
  models: [{ value: 'sonnet', displayName: 'Sonnet', description: 'Balanced' }],
  agents: [{ name: 'Explore', description: 'Search the code' }],
  account: { email: 'dev@example.com', subscriptionType: 'max' },
  output_style: 'default',
  available_output_styles: ['default', 'explanatory'],
};
const DEFAULT_MCP = [{ name: 'docs', status: 'connected', tools: [{ name: 'search' }] }];
const DEFAULT_REWIND = { canRewind: true, filesChanged: ['a.txt'], insertions: 1, deletions: 0 };
const DEFAULT_CONTEXT = {
  categories: [],
  totalTokens: 10,
  maxTokens: 200000,
  rawMaxTokens: 200000,
  percentage: 0,
  gridRows: [],
  model: 'sonnet',
};

/**
 * In-memory stand-in for the EngineAdapter. Session files live in `store`; every call is recorded in `calls`.
 */
function createEngine() {
  /** @type {Map<string, {info: Record<string, unknown>, messages: Array<Record<string, unknown>>}>} */
  const store = new Map();
  const engine = {
    kind: 'sdk',
    sdkVersion: '0.3.295',
    queries: /** @type {FakeQuery[]} */ ([]),
    probes: /** @type {FakeQuery[]} */ ([]),
    /** Answers given to every trust probe (the values of its FakeQuery), for example a refused setCwd. */
    probeValues: /** @type {Record<string, unknown>} */ ({}),
    store,
    calls: /** @type {unknown[][]} */ ([]),
    startError: /** @type {Error|null} */ (null),
    infoError: /** @type {Error|null} */ (null),
    /** The settings the user's files define, as resolveSettings reports them. */
    settingsOnDisk: /** @type {Record<string, unknown>} */ ({}),
    /** Every resolveSettings call, with its options. */
    settingsLookups: /** @type {Array<Record<string, unknown>>} */ ([]),
    resolveError: /** @type {Error|null} */ (null),
    resolveHangs: false,
    /** @param {{prompt: AsyncQueue<unknown>, options: Record<string, unknown>}} params */
    query({ prompt, options }) {
      if (engine.startError) throw engine.startError;
      const query = new FakeQuery(prompt, options);
      // Quiet queries (trust probes) never persist a session; they are kept apart from the session queries.
      if (options.persistSession === false) {
        Object.assign(query.values, engine.probeValues);
        engine.probes.push(query);
      } else {
        engine.queries.push(query);
      }
      return query;
    },
    /** @param {Record<string, unknown>} [options] */
    async resolveSettings(options) {
      engine.settingsLookups.push(options ?? {});
      if (engine.resolveHangs) await new Promise(() => {});
      if (engine.resolveError) throw engine.resolveError;
      return { effective: { ...engine.settingsOnDisk }, provenance: {}, sources: [] };
    },
    async listSessions(options) {
      engine.calls.push(['listSessions', options]);
      let infos = [...store.values()].map((entry) => ({ ...entry.info }));
      if (options?.dir !== undefined) infos = infos.filter((info) => info.cwd === options.dir);
      infos.sort((a, b) => b.lastModified - a.lastModified);
      const offset = options?.offset ?? 0;
      const end = options?.limit === undefined ? undefined : offset + options.limit;
      return infos.slice(offset, end);
    },
    async getSessionMessages(sessionId, options) {
      engine.calls.push(['getSessionMessages', sessionId, options]);
      return (store.get(sessionId)?.messages ?? []).map((message) => ({ ...message }));
    },
    async getSessionInfo(sessionId) {
      engine.calls.push(['getSessionInfo', sessionId]);
      if (engine.infoError) throw engine.infoError;
      const entry = store.get(sessionId);
      return entry ? { ...entry.info } : undefined;
    },
    async renameSession(sessionId, title) {
      engine.calls.push(['renameSession', sessionId, title]);
      const entry = store.get(sessionId);
      if (!entry) throw new Error('Session not found');
      entry.info.customTitle = title;
      entry.info.summary = title;
      entry.info.lastModified += 1;
    },
    async tagSession(sessionId, tag) {
      engine.calls.push(['tagSession', sessionId, tag]);
      const entry = store.get(sessionId);
      if (!entry) throw new Error('Session not found');
      if (tag === null) delete entry.info.tag;
      else entry.info.tag = tag;
    },
    async forkSession(sessionId, options) {
      engine.calls.push(['forkSession', sessionId, options]);
      const entry = store.get(sessionId);
      if (!entry) throw new Error('Session not found');
      const cut = options?.upToMessageId === undefined
        ? entry.messages.length
        : entry.messages.findIndex((m) => m.uuid === options.upToMessageId) + 1;
      const forkId = randomUUID();
      const messages = entry.messages.slice(0, cut);
      store.set(forkId, {
        info: { sessionId: forkId, summary: options?.title ?? 'fork', lastModified: 2000, cwd: entry.info.cwd },
        messages,
      });
      return { sessionId: forkId };
    },
    async deleteSession(sessionId) {
      engine.calls.push(['deleteSession', sessionId]);
      if (!store.has(sessionId)) throw new Error('Session not found');
      store.delete(sessionId);
    },
    async listSubagents(sessionId) {
      engine.calls.push(['listSubagents', sessionId]);
      return ['agent-a'];
    },
    async getSubagentMessages(sessionId, agentId) {
      engine.calls.push(['getSubagentMessages', sessionId, agentId]);
      return [];
    },
  };
  return engine;
}

/**
 * Adds a persisted session to the fake store.
 * @param {ReturnType<typeof createEngine>} engine
 * @param {string} sessionId
 * @param {{cwd?: string, messages?: Array<Record<string, unknown>>, lastModified?: number, summary?: string}} [extra]
 */
function addSession(engine, sessionId, { cwd = CWD, messages = [], lastModified = 1000, summary = 'Earlier' } = {}) {
  engine.store.set(sessionId, {
    info: { sessionId, summary, lastModified, fileSize: messages.length * 100, cwd },
    messages,
  });
}

/** @param {Record<string, unknown>} [over] */
function makeConfig(over = {}) {
  const { defaults, ...rest } = over;
  return {
    host: '127.0.0.1',
    port: 0,
    requireAuth: false,
    token: '',
    publicOrigin: '',
    profile: 'full',
    appName: 'test',
    version: '1.2.3',
    roots: [CWD],
    stateDir: STATE_DIR,
    engine: 'sdk',
    claudeBin: null,
    defaults: { model: null, permissionMode: 'default', effort: null, ...defaults },
    terminal: false,
    allowBypass: false,
    idleTimeoutMs: 10 * MINUTE,
    maxLiveSessions: 3,
    uploadMaxBytes: 1024,
    imageMaxBytes: 1024,
    uploadRetentionDays: 7,
    sessionTtlMs: 1000,
    trustProxy: false,
    logLevel: 'error',
    ...rest,
  };
}

/** Folder trust of the harness by default: the workspace root and the folders below it are trusted. */
const TRUSTED = async (p) => p === CWD || p.startsWith(`${CWD}/`);

/** The workspace roots of the harness by default: the folder of the tests and the folders below it. */
const INSIDE_ROOTS = async (p) => p === CWD || p.startsWith(`${CWD}/`);

/**
 * A host wired to the fake engine, a recording publisher, a recording logger and a manual clock.
 * `trusted` is the isTrustedCwd option; `null` leaves the option out so the host's default applies. `allowed` answers
 * the workspace roots check. `settingsOnDisk` is what the fake engine reports for the user's settings files.
 * `unattended` is the switch the host reads: a test turns it on or off by setting its `on` flag, then calls
 * applyUnattended.
 * @param {{config?: Record<string, unknown>, clock?: number,
 *   trusted?: ((p: string) => Promise<boolean>)|null, allowed?: (p: string) => Promise<boolean>,
 *   settingsOnDisk?: Record<string, unknown>, unattended?: {on: boolean}}} [options]
 */
function harness({ config = {}, clock = 1_000_000, trusted = TRUSTED, allowed = INSIDE_ROOTS,
  settingsOnDisk = {}, resolveDir, homeDir = HOME, unattended = { on: false } } = {}) {
  const events = [];
  const logs = [];
  const engine = createEngine();
  engine.settingsOnDisk = settingsOnDisk;
  const time = { now: clock };
  let seq = 0;
  const recordLog = (level) => (msg, fields) => logs.push({ level, msg, fields });
  /** @type {ConstructorParameters<typeof EngineHost>[0]} */
  const options = {
    engine,
    config: makeConfig(config),
    log: { debug: recordLog('debug'), info: recordLog('info'), warn: recordLog('warn'), error: recordLog('error') },
    publish: (event) => {
      events.push(event);
      seq += 1;
      return seq;
    },
    getSeq: () => seq,
    isAllowedCwd: allowed,
    now: () => time.now,
    homeDir,
    unattended: () => unattended.on,
  };
  if (trusted !== null) options.isTrustedCwd = trusted;
  if (resolveDir !== undefined) options.resolveDir = resolveDir;
  const host = new EngineHost(options);
  return { host, engine, events, logs, time, sequence: () => seq, unattended };
}

/** @param {Record<string, unknown>} [overrides] */
function initMessage(sessionId, overrides = {}) {
  return {
    type: 'system',
    subtype: 'init',
    uuid: randomUUID(),
    session_id: sessionId,
    apiKeySource: 'none',
    claude_code_version: '2.1.295',
    cwd: CWD,
    tools: [],
    mcp_servers: [],
    model: 'claude-sonnet-test',
    permissionMode: 'default',
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
    agents: [],
    ...overrides,
  };
}

/** @param {string} sessionId @param {string} [uuid] */
function statusMessage(sessionId, uuid = randomUUID()) {
  return { type: 'system', subtype: 'status', status: null, uuid, session_id: sessionId };
}

/** @param {string} sessionId @param {string} uuid @param {string} [text] */
function assistantMessage(sessionId, uuid, text = 'Hello.') {
  return {
    type: 'assistant',
    uuid,
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { id: `msg-${uuid}`, role: 'assistant', content: [{ type: 'text', text }] },
  };
}

/** @param {string} sessionId @param {string} uuid @param {string} text */
function userEntry(sessionId, uuid, text) {
  return {
    type: 'user', uuid, session_id: sessionId, parent_tool_use_id: null, message: { role: 'user', content: text },
  };
}

/** @param {FakeQuery} query */
async function nextInput(query) {
  const { value } = await query.prompt[Symbol.asyncIterator]().next();
  return value;
}

/** @param {Array<{type: string}>} events @param {string} type */
function ofType(events, type) {
  return events.filter((event) => event.type === type);
}

/**
 * Starts a new session, lets its initialize handshake be answered, and delivers its init message (Claude Code sends
 * it with the first prompt, which the fake stands in for). The handshake's call is dropped from the query's calls, so
 * a test sees only the calls its own action makes; the handshake has tests of its own.
 * @param {ReturnType<typeof harness>} h
 * @param {Record<string, unknown>} [input]
 * @param {Record<string, unknown>} [init]
 */
async function startLive(h, input = { cwd: CWD }, init = {}) {
  const info = await h.host.createSession(input);
  const query = h.engine.queries[h.engine.queries.length - 1];
  await flush();
  query.calls.length = 0;
  query.emit(initMessage(info.sessionId, init));
  await flush();
  return { sessionId: info.sessionId, query, info };
}

/**
 * Makes every session query the engine starts answer its initialize handshake with what `answer` returns. The handshake
 * is sent before createSession returns, so the answer has to be set when the query is made. Trust probes (quiet
 * queries) keep their own answers.
 * @param {ReturnType<typeof harness>} h
 * @param {() => Promise<unknown>} answer
 */
function handshakeWith(h, answer) {
  const makeQuery = h.engine.query;
  h.engine.query = (args) => {
    const query = makeQuery(args);
    if (args.options.persistSession !== false) query.values.initializationResult = answer;
    return query;
  };
}

/** A promise that the test settles itself. */
function deferred() {
  /** @type {(value: unknown) => void} */
  let resolve = () => {};
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * Opens a persisted session like startLive: the handshake is answered, its call is dropped, then init is delivered.
 * @param {ReturnType<typeof harness>} h
 * @param {string} sessionId
 * @param {Record<string, unknown>} [settings]
 */
async function openLive(h, sessionId, settings) {
  const info = await h.host.openSession(sessionId, settings);
  const query = h.engine.queries[h.engine.queries.length - 1];
  await flush();
  query.calls.length = 0;
  query.emit(initMessage(sessionId));
  await flush();
  return { sessionId, query, info };
}

describe('EngineHost starting queries', () => {
  test('createSession starts a new query with exactly the documented SDK options', async () => {
    const h = harness();
    const info = await h.host.createSession({
      cwd: CWD, title: '  Build  ', model: 'sonnet', permissionMode: 'acceptEdits', effort: 'high',
    });
    const query = h.engine.queries[0];
    const {
      canUseTool, onElicitation, onUserDialog, env, stderr, abortController, supportedDialogKinds, ...rest
    } = query.options;
    assert.ok(isUuid(info.sessionId));
    assert.equal(rest.sessionId, info.sessionId);
    assert.deepEqual(rest, {
      cwd: CWD,
      sessionId: info.sessionId,
      title: 'Build',
      model: 'sonnet',
      permissionMode: 'acceptEdits',
      effort: 'high',
      allowDangerouslySkipPermissions: false,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      tools: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
      includePartialMessages: true,
      includeHookEvents: true,
      promptSuggestions: true,
      agentProgressSummaries: true,
      enableFileCheckpointing: true,
      perTaskStopAffordance: true,
      extraArgs: { 'thinking-display': 'summarized' },
      toolConfig: { askUserQuestion: { previewFormat: 'markdown' } },
    });
    assert.ok(query.prompt instanceof AsyncQueue);
    assert.ok(abortController instanceof AbortController);
    assert.equal(typeof canUseTool, 'function');
    assert.equal(typeof onElicitation, 'function');
    assert.equal(typeof onUserDialog, 'function');
    assert.deepEqual(supportedDialogKinds, [...DIALOG_KINDS]);
    assert.equal(typeof stderr, 'function');
    assert.equal(env.CLAUDE_AGENT_SDK_CLIENT_APP, 'claude-official-web/1.2.3');
    assert.equal(Object.keys(env).some((name) => name.startsWith('CAW_')), false);
    assert.equal('pathToClaudeCodeExecutable' in query.options, false);
    assert.equal(info.state, 'starting');
    assert.equal(info.title, 'Build');
    assert.equal(info.model, 'sonnet');
    assert.equal(info.effort, 'high');
  });

  test('a configured claude binary is passed as pathToClaudeCodeExecutable', async () => {
    const h = harness({ config: { claudeBin: '/opt/claude/bin/claude' } });
    await h.host.createSession({ cwd: CWD });
    assert.equal(h.engine.queries[0].options.pathToClaudeCodeExecutable, '/opt/claude/bin/claude');
  });

  test('createSession publishes the new session state and a sessions_changed event', async () => {
    const h = harness();
    const info = await h.host.createSession({ cwd: CWD });
    const states = ofType(h.events, 'session_state');
    assert.equal(states.at(-1).data.live.sessionId, info.sessionId);
    assert.deepEqual(ofType(h.events, 'sessions_changed').at(-1), {
      type: 'sessions_changed',
      data: { reason: 'created', sessionId: info.sessionId },
    });
  });

  test('createSession validates the cwd, title and enumerations', async () => {
    const h = harness();
    await expectError(h.host.createSession({ cwd: '' }), 400, 'BAD_REQUEST');
    await expectError(h.host.createSession({ cwd: CWD, title: 'x'.repeat(201) }), 422, 'INVALID_ARGUMENT');
    await expectError(h.host.createSession({ cwd: CWD, permissionMode: 'yolo' }), 422, 'INVALID_ARGUMENT');
    await expectError(h.host.createSession({ cwd: CWD, effort: 'extreme' }), 422, 'INVALID_ARGUMENT');
    await expectError(h.host.createSession({ cwd: CWD, model: 'two words' }), 422, 'INVALID_ARGUMENT');
    assert.equal(h.engine.queries.length, 0);
  });

  test('openSession resumes the stored session without a title and with the stored cwd', async () => {
    const h = harness();
    addSession(h.engine, S1, { summary: 'Earlier work' });
    const { query } = await openLive(h, S1, { model: 'opus' });
    assert.equal(query.options.resume, S1);
    assert.equal(query.options.model, 'opus');
    assert.equal('sessionId' in query.options, false);
    assert.equal('title' in query.options, false);
    assert.equal('resumeSessionAt' in query.options, false);
    assert.equal(query.options.cwd, CWD);
    assert.equal(h.host.liveInfo(S1).state, 'idle');
  });

  test('openSession reports unknown, malformed and outside-root sessions', async () => {
    const h = harness();
    await expectError(h.host.openSession('not-a-uuid'), 400, 'BAD_REQUEST');
    await expectError(h.host.openSession(UNKNOWN), 404, 'SESSION_NOT_FOUND');
    addSession(h.engine, S2, { cwd: OUTSIDE });
    await expectError(h.host.openSession(S2), 404, 'SESSION_NOT_FOUND');
    assert.equal(h.engine.queries.length, 0);
  });

  test('concurrent opens of one session share a single start', async () => {
    const h = harness();
    addSession(h.engine, S1);
    const [first, second] = await Promise.all([h.host.openSession(S1), h.host.openSession(S1)]);
    assert.equal(h.engine.queries.length, 1);
    assert.equal(first.sessionId, S1);
    assert.equal(second.sessionId, S1);
  });

  test('settings stored while a session is closed apply to its next start', async () => {
    const h = harness();
    addSession(h.engine, S1);
    assert.deepEqual(await h.host.updateSettings(S1, { model: 'haiku', effort: 'low' }), {
      live: null, restartRequired: false,
    });
    const { query } = await openLive(h, S1);
    assert.equal(query.options.model, 'haiku');
    assert.equal(query.options.effort, 'low');
  });

  test('a query with no mode of its own starts without a permissionMode option, and reports null until init',
    async () => {
      const h = harness({ config: { defaults: { permissionMode: null } } });
      const info = await h.host.createSession({ cwd: CWD });
      const [query] = h.engine.queries;
      assert.equal('permissionMode' in query.options, false);
      assert.equal(h.host.liveInfo(info.sessionId).permissionMode, null);
      query.emit(initMessage(info.sessionId, { permissionMode: 'acceptEdits' }));
      await flush();
      assert.equal(h.host.liveInfo(info.sessionId).permissionMode, 'acceptEdits');
    });

  test('bypassPermissions is refused unless the gateway allows it', async () => {
    const refused = harness();
    await expectError(refused.host.createSession({ cwd: CWD, permissionMode: 'bypassPermissions' }), 501,
      'FEATURE_DISABLED');
    assert.equal(refused.engine.queries.length, 0);
    addSession(refused.engine, S1);
    await expectError(refused.host.updateSettings(S1, { permissionMode: 'bypassPermissions' }), 501,
      'FEATURE_DISABLED');
    await expectError(refused.host.openSession(S1, { permissionMode: 'bypassPermissions' }), 501, 'FEATURE_DISABLED');

    const allowed = harness({ config: { allowBypass: true } });
    const { sessionId } = await startLive(allowed, { cwd: CWD, permissionMode: 'bypassPermissions' },
      { permissionMode: 'bypassPermissions' });
    assert.equal(allowed.engine.queries[0].options.allowDangerouslySkipPermissions, true);
    assert.equal(allowed.host.liveInfo(sessionId).permissionMode, 'bypassPermissions');
  });
});

describe('EngineHost stream state and events', () => {
  test('the handshake makes a new session idle before any prompt; the values chosen stand, the version is unknown', async () => {
    // Claude Code's settings decide the mode when none is chosen, so the gateway has no mode of its own to show.
    const h = harness({ config: { defaults: { permissionMode: null } } });
    const info = await h.host.createSession({ cwd: CWD, model: 'sonnet', effort: 'low' });
    const query = h.engine.queries[0];
    await flush();
    // The ready refresh reads the context window once the handshake is answered (see #refreshContext).
    assert.deepEqual(query.calls.map((call) => call[0]), ['initializationResult', 'getContextUsage']);
    const live = h.host.liveInfo(info.sessionId);
    assert.equal(live.state, 'idle');
    assert.equal(live.model, 'sonnet');
    assert.equal(live.permissionMode, null);
    assert.equal(live.effort, 'low');
    assert.equal(live.claudeCodeVersion, null);
    assert.deepEqual(ofType(h.events, 'session_state').map((e) => e.data.live.state), ['starting', 'idle', 'idle']);
    assert.equal(query.closed, false);
  });

  test('system init then records the model, mode, effort and version that the runtime reports', async () => {
    const h = harness({ config: { defaults: { permissionMode: null } } });
    const info = await h.host.createSession({ cwd: CWD, model: 'sonnet', effort: 'low' });
    const query = h.engine.queries[0];
    await flush();
    query.emit(initMessage(info.sessionId, {
      model: 'claude-x', permissionMode: 'plan', effort: 'low', claude_code_version: '2.1.295',
    }));
    await flush();
    const live = h.host.liveInfo(info.sessionId);
    assert.equal(live.state, 'idle');
    assert.equal(live.model, 'claude-x');
    assert.equal(live.permissionMode, 'plan');
    assert.equal(live.effort, 'low');
    assert.equal(live.claudeCodeVersion, '2.1.295');
    const detail = await h.host.getSession(info.sessionId);
    assert.equal(detail.init.model, 'claude-x');
    assert.deepEqual(ofType(h.events, 'session_state').map((e) => e.data.live.state),
      ['starting', 'idle', 'idle', 'idle']);
    assert.equal(query.closed, false);
  });

  test('a stream that never sends init still becomes idle, publishing the idle state once', async () => {
    const h = harness();
    const info = await h.host.createSession({ cwd: CWD });
    const query = h.engine.queries[0];
    await flush();
    assert.equal(h.host.liveInfo(info.sessionId).state, 'idle');
    assert.equal((await h.host.getSession(info.sessionId)).init, null, 'no system/init has arrived');
    assert.deepEqual(query.calls.map((call) => call[0]), ['initializationResult', 'getContextUsage']);
    await flush();
    assert.equal(h.host.liveInfo(info.sessionId).state, 'idle');
    // The idle state is published once; the context window the ready refresh read is published with it.
    assert.equal(ofType(h.events, 'session_state').filter((event) => event.data.live?.state === 'idle').length, 2);
    assert.equal(query.closed, false);
  });

  test('a handshake that is refused leaves the session starting, publishes nothing, and a later init still makes it idle',
    async () => {
      const h = harness();
      handshakeWith(h, () => Promise.reject(new Error('refused by the runtime')));
      const info = await h.host.createSession({ cwd: CWD });
      const query = h.engine.queries[0];
      await flush();
      assert.equal(h.host.liveInfo(info.sessionId).state, 'starting');
      assert.deepEqual(ofType(h.events, 'session_state').map((event) => event.data.live.state), ['starting']);
      assert.deepEqual(ofType(h.events, 'notice'), []);
      assert.ok(h.logs.some((entry) => entry.msg === 'initialize handshake not answered'), 'the refusal is logged');
      assert.equal(query.closed, false);
      query.emit(initMessage(info.sessionId));
      await flush();
      assert.equal(h.host.liveInfo(info.sessionId).state, 'idle');
    });

  test('a session closed before its handshake is answered is not revived by the answer', async () => {
    const h = harness();
    const answer = deferred();
    handshakeWith(h, () => answer.promise);
    const info = await h.host.createSession({ cwd: CWD });
    await flush();
    assert.equal(h.host.liveInfo(info.sessionId).state, 'starting');
    await h.host.closeSession(info.sessionId);
    assert.equal(h.host.liveInfo(info.sessionId), null);
    const published = h.events.length;
    answer.resolve(structuredClone(DEFAULT_INIT));
    await flush();
    assert.equal(h.host.liveInfo(info.sessionId), null, 'the closed session stays closed');
    assert.deepEqual(h.events.slice(published), [], 'and the answer publishes nothing for it');
  });

  test('a handshake that is not answered within 60 s changes nothing: the session stays starting', async (t) => {
    // The folder is not trusted, so no trust probe runs; the timers are faked before the session starts.
    const h = harness({ trusted: async () => false });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    handshakeWith(h, () => new Promise(() => {}));
    const info = await h.host.createSession({ cwd: CWD });
    const query = h.engine.queries[0];
    await flush();
    t.mock.timers.tick(59_999);
    await flush();
    assert.equal(h.host.liveInfo(info.sessionId).state, 'starting');
    t.mock.timers.tick(1);
    await flush();
    assert.equal(h.host.liveInfo(info.sessionId).state, 'starting');
    assert.equal(query.closed, false);
    assert.ok(h.logs.some((entry) => entry.msg === 'initialize handshake not answered'), 'the timeout is logged');
  });

  test('every SDK message is published with its sequence number and kept in the ring', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    const uuids = [randomUUID(), randomUUID(), randomUUID()];
    for (const uuid of uuids) query.emit(statusMessage(sessionId, uuid));
    await flush();
    const sdkEvents = ofType(h.events, 'sdk');
    assert.equal(sdkEvents.length, 4);
    assert.equal(sdkEvents[1].data.sessionId, sessionId);
    assert.equal(sdkEvents[1].data.msg.uuid, uuids[0]);
    const detail = await h.host.getSession(sessionId);
    const expectedSeqs = h.events.map((event, index) => ({ event, seq: index + 1 }))
      .filter(({ event }) => event.type === 'sdk').map(({ seq }) => seq);
    assert.deepEqual(detail.liveEvents.map((item) => item.seq), expectedSeqs);
    assert.equal(detail.liveEvents[2].msg.uuid, uuids[1]);
    assert.equal(detail.seq, h.sequence());
  });

  test('the event ring keeps at most 2000 messages and drops the oldest first', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    for (let i = 0; i < 2050; i += 1) query.emit(statusMessage(sessionId));
    await flush();
    const detail = await h.host.getSession(sessionId);
    assert.equal(detail.liveEvents.length, 2000);
    const newest = ofType(h.events, 'sdk').at(-1);
    assert.equal(detail.liveEvents.at(-1).seq, h.events.indexOf(newest) + 1);
  });

  test('the event ring keeps at most about 4 MiB of JSON', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    const padding = 'x'.repeat(300_000);
    for (let i = 0; i < 20; i += 1) query.emit({ ...statusMessage(sessionId), padding });
    await flush();
    const detail = await h.host.getSession(sessionId);
    const bytes = JSON.stringify(detail.liveEvents).length;
    assert.ok(detail.liveEvents.length >= 1);
    assert.ok(bytes <= 4 * 1024 * 1024 + 1024, `ring holds ${bytes} bytes`);
    assert.ok(detail.liveEvents.length < 20);
    assert.equal(detail.liveEvents.at(-1).msg.padding.length, 300_000);
  });

  test('session_state is published on changes only, not for every streamed message', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    // The ready refresh publishes the context window it reads once the call settles, which is after startLive.
    await flush();
    const before = ofType(h.events, 'session_state').length;
    for (let i = 0; i < 50; i += 1) query.emit({ type: 'stream_event', uuid: randomUUID(), session_id: sessionId });
    await flush();
    assert.equal(ofType(h.events, 'session_state').length, before);
  });

  test('assistant, user and stream messages refresh lastActivity', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    h.time.now += 5000;
    query.emit(assistantMessage(sessionId, randomUUID()));
    await flush();
    assert.equal(h.host.liveInfo(sessionId).lastActivity, h.time.now);
    h.time.now += 5000;
    query.emit({ type: 'stream_event', uuid: randomUUID(), session_id: sessionId });
    await flush();
    assert.equal(h.host.liveInfo(sessionId).lastActivity, h.time.now);
  });

  test('session_state_changed, status and result move the state machine', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    query.emit({
      type: 'system', subtype: 'session_state_changed', state: 'running', uuid: randomUUID(), session_id: sessionId,
    });
    await flush();
    assert.equal(h.host.liveInfo(sessionId).state, 'running');
    query.emit({
      type: 'system', subtype: 'status', status: 'requesting', permissionMode: 'auto', uuid: randomUUID(),
      session_id: sessionId,
    });
    await flush();
    assert.equal(h.host.liveInfo(sessionId).permissionMode, 'auto');
    query.emit({ type: 'result', subtype: 'success', is_error: false, uuid: randomUUID(), session_id: sessionId });
    await flush();
    assert.equal(h.host.liveInfo(sessionId).state, 'idle');
  });

  test('commands_changed refreshes the commands of the cached capabilities', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    await h.host.getCapabilities(sessionId);
    query.emit({
      type: 'system', subtype: 'commands_changed', uuid: randomUUID(), session_id: sessionId,
      commands: [{ name: 'deploy', description: 'Deploy', argumentHint: '' }],
    });
    await flush();
    const caps = await h.host.getCapabilities(sessionId);
    assert.deepEqual(caps.commands.map((c) => c.name), ['deploy']);
    assert.equal(query.calls.filter((c) => c[0] === 'initializationResult').length, 1);
  });

  test('a message stream that ends normally removes the session without an error notice', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    query.finish();
    await flush();
    assert.equal(h.host.liveInfo(sessionId), null);
    assert.deepEqual(ofType(h.events, 'notice'), []);
    assert.deepEqual(ofType(h.events, 'session_state').at(-1).data, { sessionId, live: null });
  });
});

describe('EngineHost sendMessage', () => {
  test('a text message reaches the query as an SDK user message and marks the session running', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    const clientMessageId = randomUUID();
    const result = await h.host.sendMessage(sessionId, { clientMessageId, text: 'hello there' });
    assert.deepEqual(result, { accepted: true, duplicate: false });
    assert.deepEqual(await nextInput(query), {
      type: 'user',
      message: { role: 'user', content: 'hello there' },
      parent_tool_use_id: null,
      uuid: clientMessageId,
      session_id: sessionId,
    });
    assert.equal(h.host.liveInfo(sessionId).state, 'running');
    assert.deepEqual(ofType(h.events, 'message_accepted').at(-1).data, { sessionId, clientMessageId });
  });

  test('images become base64 image blocks ahead of the text block', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    await h.host.sendMessage(sessionId, {
      clientMessageId: randomUUID(),
      text: 'what is this?',
      images: [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }],
    });
    const message = await nextInput(query);
    assert.deepEqual(message.message.content, [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
      { type: 'text', text: 'what is this?' },
    ]);
  });

  test('an image without text sends only the image block', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    await h.host.sendMessage(sessionId, {
      clientMessageId: randomUUID(),
      text: '',
      images: [{ mediaType: 'image/webp', data: 'UklGRg==' }],
    });
    const message = await nextInput(query);
    assert.deepEqual(message.message.content, [
      { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'UklGRg==' } },
    ]);
  });

  test('malformed messages are rejected with 400 before anything is sent', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    const good = randomUUID();
    const cases = [
      null,
      { clientMessageId: 'not-a-uuid', text: 'hi' },
      { clientMessageId: good, text: 42 },
      { clientMessageId: good, text: '   ' },
      { clientMessageId: good, text: 'hi', images: 'x' },
      { clientMessageId: good, text: 'hi', images: [{ mediaType: 'image/svg+xml', data: 'PHN2Zy8+' }] },
      { clientMessageId: good, text: 'hi', images: [{ mediaType: 'image/png', data: 'not base64!' }] },
      {
        clientMessageId: good,
        text: 'hi',
        images: Array.from({ length: 11 }, () => ({ mediaType: 'image/png', data: 'AA==' })),
      },
    ];
    for (const message of cases) {
      await expectError(h.host.sendMessage(sessionId, message), 400, 'BAD_REQUEST');
    }
    assert.equal(query.prompt.size, 0);
  });

  test('a clientMessageId seen within 10 minutes is accepted without being sent again', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    const clientMessageId = randomUUID();
    assert.equal((await h.host.sendMessage(sessionId, { clientMessageId, text: 'once' })).duplicate, false);
    assert.deepEqual(await h.host.sendMessage(sessionId, { clientMessageId, text: 'once' }), {
      accepted: true, duplicate: true,
    });
    await nextInput(query);
    assert.equal(query.prompt.size, 0);
    h.time.now += 10 * MINUTE + 1;
    assert.equal((await h.host.sendMessage(sessionId, { clientMessageId, text: 'again' })).duplicate, false);
  });

  test('sending to a closed session opens it first', async () => {
    const h = harness();
    addSession(h.engine, S1);
    const { query: first } = await openLive(h, S1);
    await h.host.closeSession(S1);
    assert.equal(first.closed, true);
    const clientMessageId = randomUUID();
    await h.host.sendMessage(S1, { clientMessageId, text: 'back again' });
    assert.equal(h.engine.queries.length, 2);
    assert.equal(h.engine.queries[1].options.resume, S1);
    assert.equal((await nextInput(h.engine.queries[1])).uuid, clientMessageId);
  });

  test('sending after the query ended on its own starts a fresh query', async () => {
    const h = harness();
    addSession(h.engine, S1);
    const { query } = await openLive(h, S1);
    query.finish();
    await flush();
    await h.host.sendMessage(S1, { clientMessageId: randomUUID(), text: 'still there?' });
    assert.equal(h.engine.queries.length, 2);
  });

  test('a locked session refuses messages with 409 SESSION_LOCKED', async () => {
    const h = harness();
    addSession(h.engine, S1);
    await h.host.lockForTerminal(S1);
    await expectError(h.host.sendMessage(S1, { clientMessageId: randomUUID(), text: 'hi' }), 409, 'SESSION_LOCKED');
    assert.equal(h.engine.queries.length, 0);
  });
});

describe('EngineHost capacity and eviction', () => {
  test('the least recently active idle session is closed to make room for a new one', async () => {
    const h = harness({ config: { maxLiveSessions: 2 } });
    const first = await startLive(h);
    h.time.now += 1000;
    const second = await startLive(h);
    h.time.now += 1000;
    const third = await startLive(h);
    assert.equal(h.host.liveInfo(first.sessionId), null);
    assert.equal(first.query.closed, true);
    assert.notEqual(h.host.liveInfo(second.sessionId), null);
    assert.notEqual(h.host.liveInfo(third.sessionId), null);
    assert.equal(h.host.allLive().length, 2);
    const stopped = ofType(h.events, 'session_state').some((e) => e.data.sessionId === first.sessionId
      && e.data.live === null);
    assert.ok(stopped);
  });

  test('busy sessions are skipped when choosing the victim', async () => {
    const h = harness({ config: { maxLiveSessions: 2 } });
    const first = await startLive(h);
    h.time.now += 1000;
    const second = await startLive(h);
    await h.host.sendMessage(first.sessionId, { clientMessageId: randomUUID(), text: 'working' });
    h.time.now += 1000;
    await startLive(h);
    assert.notEqual(h.host.liveInfo(first.sessionId), null);
    assert.equal(h.host.liveInfo(second.sessionId), null);
  });

  test('sessions waiting for a permission answer are never evicted, even when least recently active', async () => {
    const h = harness({ config: { maxLiveSessions: 2 } });
    const waiting = await startLive(h);
    const pending = waiting.query.options.canUseTool('Bash', { command: 'ls' }, {
      signal: new AbortController().signal, toolUseID: 'tu-1',
    });
    h.time.now += 1000;
    const idle = await startLive(h);
    h.time.now += 1000;
    const fresh = await h.host.createSession({ cwd: CWD });
    assert.notEqual(h.host.liveInfo(waiting.sessionId), null);
    assert.equal(h.host.liveInfo(idle.sessionId), null);
    assert.notEqual(h.host.liveInfo(fresh.sessionId), null);
    await h.host.closeSession(waiting.sessionId);
    assert.deepEqual(await pending, { behavior: 'deny', message: 'Request cancelled.' });
  });

  test('when every live session is busy the start is refused with 429 TOO_MANY_SESSIONS', async () => {
    const h = harness({ config: { maxLiveSessions: 1 } });
    const busy = await startLive(h);
    await h.host.sendMessage(busy.sessionId, { clientMessageId: randomUUID(), text: 'working' });
    await expectError(h.host.createSession({ cwd: CWD }), 429, 'TOO_MANY_SESSIONS');
    assert.equal(h.engine.queries.length, 1);
  });
});

describe('EngineHost closing, interrupting and settings', () => {
  test('closeSession ends the input, closes and aborts the query and publishes the removal', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    const controller = query.options.abortController;
    await h.host.closeSession(sessionId);
    assert.equal(query.prompt.ended, true);
    assert.equal(query.closed, true);
    assert.equal(controller.signal.aborted, true);
    assert.equal(h.host.liveInfo(sessionId), null);
    assert.deepEqual(ofType(h.events, 'session_state').at(-1).data, { sessionId, live: null });
    assert.equal(ofType(h.events, 'notice').length, 0);
  });

  test('an abort error raised while closing is not reported as a failure', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    query.closeMode = 'fail';
    await h.host.closeSession(sessionId);
    assert.equal(ofType(h.events, 'notice').length, 0);
    assert.equal(h.host.liveInfo(sessionId), null);
  });

  test('closing a session that is not open does nothing', async () => {
    const h = harness();
    await h.host.closeSession(S1);
    assert.equal(h.events.length, 0);
  });

  test('closeSession returns after at most three seconds when the query never finishes', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    query.ignoreClose = true;
    const started = Date.now();
    await h.host.closeSession(sessionId);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 2900 && elapsed < 6000, `closed after ${elapsed} ms`);
    assert.equal(h.host.liveInfo(sessionId), null);
  });

  test('interrupt calls the query on a live session and is a no-op otherwise', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    await h.host.interrupt(sessionId);
    assert.deepEqual(query.calls.filter((c) => c[0] === 'interrupt'), [['interrupt']]);
    await h.host.interrupt(UNKNOWN);
    assert.equal(h.engine.queries.length, 1);
  });

  test('updateSettings applies model, mode and effort to the live query', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    const { live, restartRequired } = await h.host.updateSettings(sessionId,
      { model: 'opus', permissionMode: 'plan', effort: null });
    assert.deepEqual(query.calls.filter((c) => c[0] !== 'close'), [
      ['setModel', 'opus'],
      ['getContextUsage', { detail: 'summary' }],
      ['setPermissionMode', 'plan'],
      ['applyFlagSettings', { effortLevel: null }],
    ]);
    assert.equal(restartRequired, false);
    assert.equal(live.model, 'opus');
    assert.equal(live.permissionMode, 'plan');
    assert.equal(live.effort, null);
  });

  test('a null model clears the override by passing undefined to the query', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    const { live } = await h.host.updateSettings(sessionId, { model: null });
    assert.deepEqual(query.calls.at(-2), ['setModel', undefined]);
    // The window may belong to the new model, so the meter reads it again once the model is set.
    assert.deepEqual(query.calls.at(-1), ['getContextUsage', { detail: 'summary' }]);
    assert.equal(live.model, null);
  });

  test('openSession on a live session applies the settings and returns its info', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    const info = await h.host.openSession(sessionId, { effort: 'max' });
    assert.deepEqual(query.calls.at(-1), ['applyFlagSettings', { effortLevel: 'max' }]);
    assert.equal(info.effort, 'max');
    assert.equal(h.engine.queries.length, 1);
  });

  test('invalid settings are refused with 422 before the query is touched', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    await expectError(h.host.updateSettings(sessionId, { permissionMode: 'loud' }), 422, 'INVALID_ARGUMENT');
    await expectError(h.host.updateSettings(sessionId, { effort: 'extreme' }), 422, 'INVALID_ARGUMENT');
    await expectError(h.host.updateSettings(sessionId, { model: 'two words' }), 422, 'INVALID_ARGUMENT');
    await expectError(h.host.updateSettings(sessionId, { model: 7 }), 422, 'INVALID_ARGUMENT');
    assert.equal(query.calls.length, 0);
  });

  test('a failing control call is reported as ENGINE_ERROR without the engine text', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    query.failures.set('setModel', new Error('internal path /home/claude/.claude/secret.json'));
    await assert.rejects(h.host.updateSettings(sessionId, { model: 'opus' }), (error) => {
      assert.equal(error.status, 502);
      assert.equal(error.code, 'ENGINE_ERROR');
      assert.equal(error.message.includes('secret'), false);
      return true;
    });
    assert.equal(h.host.liveInfo(sessionId).model, 'claude-sonnet-test');
  });
});

/**
 * Calls the query's canUseTool callback the way the SDK does. Returns the pending result and the request's controller.
 * @param {FakeQuery} query
 * @param {string} toolName
 * @param {Record<string, unknown>} input
 * @param {Record<string, unknown>} [extra]
 */
function callTool(query, toolName, input, extra = {}) {
  const controller = new AbortController();
  const options = { signal: controller.signal, toolUseID: 'tu-1', ...extra };
  return { pending: query.options.canUseTool(toolName, input, options), controller };
}

/**
 * Calls the query's onElicitation callback the way the SDK does.
 * @param {FakeQuery} query
 * @param {Record<string, unknown>} elicitation
 * @param {Record<string, unknown>} [extra]
 */
function callElicitation(query, elicitation, extra = {}) {
  const controller = new AbortController();
  const options = { signal: controller.signal, requestId: 'mcp-1', ...extra };
  return { pending: query.options.onElicitation(elicitation, options), controller };
}

/** @param {ReturnType<typeof harness>} h */
function lastRequest(h) {
  return ofType(h.events, 'request').at(-1).data.request;
}

/** @param {ReturnType<typeof harness>} h */
function lastOutcome(h) {
  return ofType(h.events, 'request_resolved').at(-1).data.outcome;
}

describe('EngineHost permission prompts', () => {
  test('a permission prompt is published, answered through respond() and returned to the SDK', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    const suggestion = { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' };
    const { pending } = callTool(query, 'Bash', { command: 'ls' }, {
      toolUseID: 'tu-1', requestId: 'sdk-1', title: 'Allow ls?', suggestions: [suggestion],
    });
    await flush();
    const request = lastRequest(h);
    assert.equal(request.kind, 'permission');
    assert.equal(request.id, 'sdk-1');
    assert.equal(request.sessionId, sessionId);
    assert.equal(request.toolName, 'Bash');
    assert.equal(request.toolUseId, 'tu-1');
    assert.equal(request.title, 'Allow ls?');
    assert.deepEqual(request.input, { command: 'ls' });
    assert.deepEqual(request.suggestions, [suggestion]);
    assert.equal(h.host.liveInfo(sessionId).state, 'requires_action');
    assert.equal(h.host.liveInfo(sessionId).pendingCount, 1);
    assert.deepEqual((await h.host.getSession(sessionId)).pending.map((item) => item.id), ['sdk-1']);
    await h.host.respond(sessionId, 'sdk-1', { decision: 'allow' });
    assert.deepEqual(await pending, { behavior: 'allow', updatedInput: { command: 'ls' } });
    assert.equal(h.host.liveInfo(sessionId).state, 'running');
    assert.equal(h.host.liveInfo(sessionId).pendingCount, 0);
    assert.deepEqual(ofType(h.events, 'request_resolved').at(-1).data, {
      sessionId, requestId: 'sdk-1', outcome: 'allowed',
    });
  });

  test('permission answers map to allow, always-allow and deny results', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    const suggestions = [
      { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' },
      { type: 'addRules', rules: [{ toolName: 'Edit' }], behavior: 'allow', destination: 'session' },
    ];
    const edited = callTool(query, 'Bash', { command: 'ls' }, { requestId: 'p-1', suggestions });
    await h.host.respond(sessionId, 'p-1', { decision: 'allow', updatedInput: { command: 'ls -la' } });
    assert.deepEqual(await edited.pending, { behavior: 'allow', updatedInput: { command: 'ls -la' } });

    const chosen = callTool(query, 'Bash', { command: 'pwd' }, { requestId: 'p-2', suggestions });
    await h.host.respond(sessionId, 'p-2', { decision: 'allow_always', suggestionIndexes: [1] });
    assert.deepEqual(await chosen.pending, {
      behavior: 'allow', updatedInput: { command: 'pwd' }, updatedPermissions: [suggestions[1]],
    });

    const every = callTool(query, 'Bash', { command: 'date' }, { requestId: 'p-3', suggestions });
    await h.host.respond(sessionId, 'p-3', { decision: 'allow_always' });
    assert.deepEqual((await every.pending).updatedPermissions, suggestions);

    const refused = callTool(query, 'Bash', { command: 'rm -rf /' }, { requestId: 'p-4' });
    await h.host.respond(sessionId, 'p-4', { decision: 'deny', message: 'Too dangerous', interrupt: true });
    assert.deepEqual(await refused.pending, { behavior: 'deny', message: 'Too dangerous', interrupt: true });

    const plain = callTool(query, 'Bash', { command: 'make' }, { requestId: 'p-5' });
    await h.host.respond(sessionId, 'p-5', { decision: 'deny' });
    assert.deepEqual(await plain.pending, {
      behavior: 'deny', message: 'The user denied this action.', interrupt: false,
    });
    assert.deepEqual(ofType(h.events, 'request_resolved').map((event) => event.data.outcome), [
      'allowed', 'allowed', 'allowed', 'denied', 'denied',
    ]);
  });

  test('invalid permission answers are refused with 400 and the request stays pending', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    const suggestions = [{ type: 'addRules', rules: [], behavior: 'allow', destination: 'session' }];
    const { pending } = callTool(query, 'Bash', { command: 'ls' }, { requestId: 'v-1', suggestions });
    const invalid = [
      null,
      { decision: 'maybe' },
      { decision: 'allow', extra: true },
      { decision: 'allow', message: 42 },
      { decision: 'allow', updatedInput: [] },
      { decision: 'allow', interrupt: 'yes' },
      { decision: 'allow_always', suggestionIndexes: [1] },
      { decision: 'allow_always', suggestionIndexes: [0, 0] },
      { decision: 'allow_always', suggestionIndexes: ['0'] },
      { decision: 'allow_always', suggestionIndexes: 'all' },
    ];
    for (const body of invalid) {
      await expectError(h.host.respond(sessionId, 'v-1', body), 400, 'BAD_REQUEST');
    }
    assert.equal(h.host.liveInfo(sessionId).pendingCount, 1);
    await h.host.respond(sessionId, 'v-1', { decision: 'allow' });
    assert.deepEqual(await pending, { behavior: 'allow', updatedInput: { command: 'ls' } });
  });

  test('requests that forbid a permanent allow refuse allow_always', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    const suggestions = [{ type: 'addRules', rules: [], behavior: 'allow', destination: 'session' }];
    const { pending } = callTool(query, 'Bash', { command: 'ls' }, {
      requestId: 'n-1', suggestions, suppressAlwaysAllowRule: true,
    });
    await expectError(h.host.respond(sessionId, 'n-1', { decision: 'allow_always' }), 400, 'BAD_REQUEST');
    await h.host.respond(sessionId, 'n-1', { decision: 'allow' });
    await pending;
  });

  test('a repeated SDK request id gets a fresh id while pending, and sessions never collide', async () => {
    const h = harness();
    const first = await startLive(h);
    const second = await startLive(h);
    const a = callTool(first.query, 'Bash', { command: 'a' }, { requestId: 'same' });
    const b = callTool(second.query, 'Bash', { command: 'b' }, { requestId: 'same' });
    const c = callTool(first.query, 'Bash', { command: 'c' }, { requestId: 'same' });
    const ids = ofType(h.events, 'request').map((event) => event.data.request.id);
    assert.equal(ids[0], 'same');
    assert.equal(ids[1], 'same');
    assert.notEqual(ids[2], 'same');
    assert.equal(h.host.liveInfo(first.sessionId).pendingCount, 2);
    assert.equal(h.host.liveInfo(second.sessionId).pendingCount, 1);
    await h.host.respond(first.sessionId, 'same', { decision: 'allow' });
    assert.deepEqual(await a.pending, { behavior: 'allow', updatedInput: { command: 'a' } });
    await h.host.respond(second.sessionId, 'same', { decision: 'deny' });
    assert.equal((await b.pending).behavior, 'deny');
    await h.host.respond(first.sessionId, ids[2], { decision: 'allow' });
    assert.deepEqual(await c.pending, { behavior: 'allow', updatedInput: { command: 'c' } });
  });

  test('respond reports unknown, other-session and malformed request ids', async () => {
    const h = harness();
    const first = await startLive(h);
    const second = await startLive(h);
    callTool(first.query, 'Bash', { command: 'ls' }, { requestId: 'r-1' });
    await expectError(h.host.respond(first.sessionId, 'missing', { decision: 'allow' }), 404, 'REQUEST_NOT_FOUND');
    await expectError(h.host.respond(second.sessionId, 'r-1', { decision: 'allow' }), 404, 'REQUEST_NOT_FOUND');
    await expectError(h.host.respond(first.sessionId, '', { decision: 'allow' }), 400, 'BAD_REQUEST');
    await expectError(h.host.respond('nope', 'r-1', { decision: 'allow' }), 400, 'BAD_REQUEST');
    assert.equal(h.host.liveInfo(first.sessionId).pendingCount, 1);
  });

  test('a request the SDK aborts is cancelled, leaves the pending list and cannot be answered any more', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    const { pending, controller } = callTool(query, 'Bash', { command: 'ls' }, { requestId: 'a-1' });
    controller.abort();
    assert.deepEqual(await pending, { behavior: 'deny', message: 'Request cancelled.' });
    assert.equal(h.host.liveInfo(sessionId).pendingCount, 0);
    assert.equal(lastOutcome(h), 'cancelled');
    await expectError(h.host.respond(sessionId, 'a-1', { decision: 'allow' }), 404, 'REQUEST_NOT_FOUND');
  });

  test('a request that arrives with an aborted signal is denied without being shown', async () => {
    const h = harness();
    const { query } = await startLive(h);
    const controller = new AbortController();
    controller.abort();
    const result = await query.options.canUseTool('Bash', { command: 'ls' }, {
      signal: controller.signal, toolUseID: 'tu-1',
    });
    assert.deepEqual(result, { behavior: 'deny', message: 'Request cancelled.' });
    assert.equal(ofType(h.events, 'request').length, 0);
    assert.equal(ofType(h.events, 'request_resolved').length, 0);
  });

  test('a session waiting for an answer stays requires_action until it is answered', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    const { pending } = callTool(query, 'Bash', { command: 'ls' }, { requestId: 'w-1' });
    query.emit({
      type: 'system', subtype: 'session_state_changed', state: 'idle', uuid: randomUUID(), session_id: sessionId,
    });
    query.emit({ type: 'result', subtype: 'success', is_error: false, uuid: randomUUID(), session_id: sessionId });
    await h.host.sendMessage(sessionId, { clientMessageId: randomUUID(), text: 'while you wait' });
    await flush();
    assert.equal(h.host.liveInfo(sessionId).state, 'requires_action');
    await h.host.respond(sessionId, 'w-1', { decision: 'allow' });
    await pending;
    assert.equal(h.host.liveInfo(sessionId).state, 'running');
  });

  test('closing the session cancels every pending request with a cancelled outcome and no notice', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    const permission = callTool(query, 'Bash', { command: 'ls' }, { requestId: 'c-1' });
    const question = callTool(query, 'AskUserQuestion', { questions: [] }, { requestId: 'c-2' });
    const elicitation = callElicitation(query, { serverName: 'docs', message: 'Name?' }, { requestId: 'c-3' });
    await h.host.closeSession(sessionId);
    assert.deepEqual(await permission.pending, { behavior: 'deny', message: 'Request cancelled.' });
    assert.deepEqual(await question.pending, { behavior: 'deny', message: 'Request cancelled.' });
    assert.deepEqual(await elicitation.pending, { action: 'cancel' });
    assert.deepEqual(ofType(h.events, 'request_resolved').map((event) => event.data.outcome), [
      'cancelled', 'cancelled', 'cancelled',
    ]);
    assert.equal(ofType(h.events, 'notice').length, 0);
    assert.equal(h.host.liveInfo(sessionId), null);
  });
});

describe('EngineHost questions and plans', () => {
  test('an AskUserQuestion prompt is answered with the answers and an optional response', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    const questions = [{
      question: 'Which file?', header: 'File', multiSelect: false,
      options: [{ label: 'a.txt', description: 'The first' }, { label: 'b.txt', description: 'The second' }],
    }];
    const { pending } = callTool(query, 'AskUserQuestion', { questions }, { requestId: 'q-1' });
    await flush();
    const request = lastRequest(h);
    assert.equal(request.kind, 'question');
    assert.deepEqual(request.input, { questions });
    await h.host.respond(sessionId, 'q-1', { answers: { 'Which file?': 'a.txt' }, response: 'Thanks' });
    assert.deepEqual(await pending, {
      behavior: 'allow',
      updatedInput: { questions, answers: { 'Which file?': 'a.txt' }, response: 'Thanks' },
    });
    assert.equal(lastOutcome(h), 'answered');

    const multi = callTool(query, 'AskUserQuestion', { questions }, { requestId: 'q-2' });
    await h.host.respond(sessionId, 'q-2', { answers: { 'Which file?': ['a.txt', 'b.txt'] } });
    const multiResult = await multi.pending;
    assert.deepEqual(multiResult.updatedInput.answers, { 'Which file?': ['a.txt', 'b.txt'] });
    assert.equal('response' in multiResult.updatedInput, false);

    const declined = callTool(query, 'AskUserQuestion', { questions }, { requestId: 'q-3' });
    await h.host.respond(sessionId, 'q-3', { decline: true });
    assert.deepEqual(await declined.pending, { behavior: 'deny', message: 'The user declined to answer.' });
    assert.equal(lastOutcome(h), 'denied');
  });

  test('question answers are validated before they settle', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    const { pending } = callTool(query, 'AskUserQuestion', { questions: [] }, { requestId: 'qv-1' });
    const invalid = [
      { answers: 'x' },
      { answers: { Q: 5 } },
      { answers: { Q: [1] } },
      { answers: {}, response: 3 },
      { response: 'no answers' },
      { decline: false },
      { decline: true, answers: {} },
      { answers: {}, extra: 1 },
    ];
    for (const body of invalid) {
      await expectError(h.host.respond(sessionId, 'qv-1', body), 400, 'BAD_REQUEST');
    }
    assert.equal(h.host.liveInfo(sessionId).pendingCount, 1);
    await h.host.respond(sessionId, 'qv-1', { answers: {} });
    assert.deepEqual(await pending, { behavior: 'allow', updatedInput: { questions: [], answers: {} } });
  });

  test('a plan approval is answered with allow, and the mode it asks for is applied after the answer', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    const plan = '1. Read the files\n2. Edit them';
    const { pending } = callTool(query, 'ExitPlanMode', { plan }, { requestId: 'pl-1' });
    await flush();
    assert.equal(lastRequest(h).kind, 'plan');
    assert.deepEqual(lastRequest(h).input, { plan });
    await h.host.respond(sessionId, 'pl-1', { decision: 'approve', nextMode: 'acceptEdits' });
    assert.deepEqual(await pending, { behavior: 'allow', updatedInput: { plan } });
    assert.equal(query.calls.some((call) => call[0] === 'setPermissionMode'), false);
    await flush();
    assert.deepEqual(query.calls.filter((call) => call[0] === 'setPermissionMode'), [
      ['setPermissionMode', 'acceptEdits'],
    ]);
    assert.equal(h.host.liveInfo(sessionId).permissionMode, 'acceptEdits');
    assert.equal(lastOutcome(h), 'allowed');
  });

  test('a plan approval without a mode keeps the mode, and a rejection carries its message', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    const approved = callTool(query, 'ExitPlanMode', { plan: 'p' }, { requestId: 'pl-2' });
    await h.host.respond(sessionId, 'pl-2', { decision: 'approve' });
    assert.deepEqual(await approved.pending, { behavior: 'allow', updatedInput: { plan: 'p' } });
    const rejected = callTool(query, 'ExitPlanMode', { plan: 'p' }, { requestId: 'pl-3' });
    await h.host.respond(sessionId, 'pl-3', { decision: 'reject', message: 'Split step two' });
    assert.deepEqual(await rejected.pending, { behavior: 'deny', message: 'Split step two' });
    const silent = callTool(query, 'ExitPlanMode', { plan: 'p' }, { requestId: 'pl-4' });
    await h.host.respond(sessionId, 'pl-4', { decision: 'reject' });
    assert.deepEqual(await silent.pending, {
      behavior: 'deny', message: 'The user rejected the plan. Revise it.',
    });
    await flush();
    assert.equal(query.calls.some((call) => call[0] === 'setPermissionMode'), false);
    assert.equal(h.host.liveInfo(sessionId).permissionMode, 'default');
    assert.equal(lastOutcome(h), 'denied');
  });

  test('plan answers need a decision and a known next mode, and never escalate to bypass', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    const { pending } = callTool(query, 'ExitPlanMode', { plan: 'p' }, { requestId: 'pv-1' });
    const invalid = [
      {},
      { decision: 'maybe' },
      { decision: 'approve', nextMode: 'plan' },
      { decision: 'approve', nextMode: 'bypassPermissions' },
      { decision: 'reject', message: 7 },
      { decision: 'approve', extra: true },
    ];
    for (const body of invalid) {
      await expectError(h.host.respond(sessionId, 'pv-1', body), 400, 'BAD_REQUEST');
    }
    await h.host.respond(sessionId, 'pv-1', { decision: 'reject' });
    await pending;
  });

  test('a mode change that fails after a plan approval is logged without its details', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    query.failures.set('setPermissionMode', new Error('refused by /home/claude/.claude/settings.json'));
    const { pending } = callTool(query, 'ExitPlanMode', { plan: 'p' }, { requestId: 'pf-1' });
    await h.host.respond(sessionId, 'pf-1', { decision: 'approve', nextMode: 'auto' });
    assert.deepEqual(await pending, { behavior: 'allow', updatedInput: { plan: 'p' } });
    await flush();
    assert.equal(h.host.liveInfo(sessionId).permissionMode, 'default');
    const warning = h.logs.find((entry) => entry.msg === 'could not apply the mode chosen with the plan');
    assert.equal(warning.level, 'warn');
    assert.equal(JSON.stringify(warning).includes('settings.json'), false);
  });
});

describe('EngineHost MCP elicitations', () => {
  test('an elicitation is answered with accept content, accept without content, decline or cancel', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    const elicitation = {
      serverName: 'docs',
      message: 'Your name?',
      mode: 'form',
      requestedSchema: { type: 'object', properties: { name: { type: 'string' } } },
      title: 'Name',
      displayName: 'Docs',
      description: 'Tell us your name',
    };
    const { pending } = callElicitation(query, elicitation, { requestId: 'e-1' });
    await flush();
    const request = lastRequest(h);
    assert.equal(request.kind, 'elicitation');
    assert.equal(request.id, 'e-1');
    assert.deepEqual(request.elicitation, elicitation);
    assert.equal(request.title, 'Name');
    assert.equal(h.host.liveInfo(sessionId).state, 'requires_action');
    const content = { name: 'Ada', age: 36, admin: false, tags: ['x', 'y'] };
    await h.host.respond(sessionId, 'e-1', { action: 'accept', content });
    assert.deepEqual(await pending, { action: 'accept', content });
    assert.equal(lastOutcome(h), 'allowed');

    const bare = callElicitation(query, elicitation, { requestId: 'e-2' });
    await h.host.respond(sessionId, 'e-2', { action: 'accept' });
    assert.deepEqual(await bare.pending, { action: 'accept' });

    const declined = callElicitation(query, elicitation, { requestId: 'e-3' });
    await h.host.respond(sessionId, 'e-3', { action: 'decline' });
    assert.deepEqual(await declined.pending, { action: 'decline' });
    assert.equal(lastOutcome(h), 'denied');

    const cancelled = callElicitation(query, elicitation, { requestId: 'e-4' });
    await h.host.respond(sessionId, 'e-4', { action: 'cancel' });
    assert.deepEqual(await cancelled.pending, { action: 'cancel' });
  });

  test('elicitation answers need an action and flat content values', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    const { pending } = callElicitation(query, { serverName: 'docs', message: 'Name?' }, { requestId: 'ev-1' });
    const invalid = [
      {},
      { action: 'maybe' },
      { action: 'accept', extra: 1 },
      { action: 'accept', content: 'text' },
      { action: 'accept', content: { nested: { a: 1 } } },
      { action: 'accept', content: { list: [1, 2] } },
      { action: 'accept', content: { nothing: null } },
    ];
    for (const body of invalid) {
      await expectError(h.host.respond(sessionId, 'ev-1', body), 400, 'BAD_REQUEST');
    }
    await h.host.respond(sessionId, 'ev-1', { action: 'cancel' });
    assert.deepEqual(await pending, { action: 'cancel' });
  });

  test('an elicitation the SDK aborts resolves as cancel', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    const { pending, controller } = callElicitation(query, { serverName: 'docs', message: 'Name?' }, {
      requestId: 'ea-1',
    });
    controller.abort();
    assert.deepEqual(await pending, { action: 'cancel' });
    assert.equal(h.host.liveInfo(sessionId).pendingCount, 0);
    assert.equal(lastOutcome(h), 'cancelled');
  });
});

/** A transcript with two turns: user, assistant, user, assistant. */
function turns(sessionId) {
  return [
    userEntry(sessionId, 'u-1', 'first question'),
    assistantMessage(sessionId, 'a-1', 'first answer'),
    userEntry(sessionId, 'u-2', 'second question'),
    assistantMessage(sessionId, 'a-2', 'second answer'),
  ];
}

describe('EngineHost rewind', () => {
  test('a code rewind restores the files of an open session and leaves the conversation alone', async () => {
    const h = harness();
    addSession(h.engine, S1, { messages: turns(S1) });
    const { query } = await openLive(h, S1);
    const result = await h.host.rewind(S1, { userMessageId: 'u-2', mode: 'code' });
    assert.deepEqual(result, { files: { ...DEFAULT_REWIND } });
    assert.deepEqual(query.calls, [['rewindFiles', 'u-2', { dryRun: false }]]);
    assert.equal(h.engine.queries.length, 1);
    assert.equal(query.closed, false);
  });

  test('a code rewind of a closed session starts it first', async () => {
    const h = harness();
    addSession(h.engine, S1, { messages: turns(S1) });
    await h.host.rewind(S1, { userMessageId: 'u-2', mode: 'code' });
    assert.equal(h.engine.queries.length, 1);
    assert.equal(h.engine.queries[0].options.resume, S1);
    // The query answers its handshake when it starts; the rewind and the ready refresh are its only other calls.
    const calls = h.engine.queries[0].calls;
    assert.deepEqual(calls.filter((call) => call[0] !== 'getContextUsage'), [
      ['initializationResult'],
      ['rewindFiles', 'u-2', { dryRun: false }],
    ]);
    assert.deepEqual(calls.filter((call) => call[0] === 'getContextUsage'),
      [['getContextUsage', { detail: 'summary' }]]);
  });

  test('a refused file rewind is 422 CANNOT_REWIND with its first line, and nothing restarts', async () => {
    const h = harness();
    addSession(h.engine, S1, { messages: turns(S1) });
    const { query } = await openLive(h, S1);
    query.values.rewindFiles = { canRewind: false, error: 'a.txt changed on disk\nmore detail', filesChanged: [] };
    await assert.rejects(h.host.rewind(S1, { userMessageId: 'u-2', mode: 'both' }), (error) => error.status === 422
      && error.code === 'CANNOT_REWIND' && error.message === 'a.txt changed on disk');
    assert.equal(query.closed, false);
    assert.equal(h.engine.queries.length, 1);
    assert.equal(ofType(h.events, 'sessions_changed').some((event) => event.data.reason === 'rewind'), false);
  });

  test('a failing file rewind is reported as ENGINE_ERROR without the engine text', async () => {
    const h = harness();
    addSession(h.engine, S1, { messages: turns(S1) });
    const { query } = await openLive(h, S1);
    query.failures.set('rewindFiles', new Error('EACCES /home/claude/.claude/file-history'));
    await assert.rejects(h.host.rewind(S1, { userMessageId: 'u-2', mode: 'code' }), (error) => error.status === 502
      && error.code === 'ENGINE_ERROR' && error.message === 'The files could not be rewound.');
  });

  test('a dry run previews the change and never restarts or changes the session', async () => {
    const h = harness();
    addSession(h.engine, S1, { messages: turns(S1) });
    const { query } = await openLive(h, S1);
    query.values.rewindFiles = {
      canRewind: false, error: 'not possible', filesChanged: ['b.txt'], insertions: 2, deletions: 1,
    };
    const both = await h.host.rewind(S1, { userMessageId: 'u-2', mode: 'both', dryRun: true });
    assert.equal(both.files.canRewind, false);
    assert.deepEqual(both.conversation, { resumeAt: 'a-1' });
    const conversation = await h.host.rewind(S1, { userMessageId: 'u-2', mode: 'conversation', dryRun: true });
    assert.deepEqual(conversation, { conversation: { resumeAt: 'a-1' } });
    assert.deepEqual(query.calls, [['rewindFiles', 'u-2', { dryRun: true }]]);
    assert.equal(query.closed, false);
    assert.equal(h.engine.queries.length, 1);
  });

  test('a conversation rewind restarts the query before the message without reporting an end', async () => {
    const h = harness();
    addSession(h.engine, S1, { messages: turns(S1) });
    const { query: first } = await openLive(h, S1);
    assert.deepEqual(await h.host.rewind(S1, { userMessageId: 'u-2', mode: 'conversation' }), {
      conversation: { resumeAt: 'a-1' },
    });
    assert.equal(h.engine.queries.length, 2);
    const second = h.engine.queries[1];
    assert.equal(first.closed, true);
    assert.equal(second.options.resume, S1);
    assert.equal(second.options.resumeSessionAt, 'a-1');
    // The restarted query has answered its handshake, so the session is idle again before any prompt reaches it.
    assert.deepEqual(second.calls, [['initializationResult'], ['getContextUsage', { detail: 'summary' }]]);
    assert.equal(h.host.liveInfo(S1).state, 'idle');
    assert.equal(ofType(h.events, 'notice').length, 0);
    assert.equal(h.events.some((event) => event.type === 'session_state' && event.data.live === null), false);
    assert.deepEqual(ofType(h.events, 'sessions_changed').at(-1).data, { reason: 'rewind', sessionId: S1 });
  });

  test('a conversation rewind of a closed session starts it at the entry before the message', async () => {
    const h = harness();
    addSession(h.engine, S1, { messages: turns(S1) });
    await h.host.rewind(S1, { userMessageId: 'u-2', mode: 'conversation' });
    assert.equal(h.engine.queries.length, 1);
    assert.equal(h.engine.queries[0].options.resume, S1);
    assert.equal(h.engine.queries[0].options.resumeSessionAt, 'a-1');
  });

  test('a both rewind rewinds the files first and then restarts the conversation', async () => {
    const h = harness();
    addSession(h.engine, S1, { messages: turns(S1) });
    const { query: first } = await openLive(h, S1);
    assert.deepEqual(await h.host.rewind(S1, { userMessageId: 'u-2', mode: 'both' }), {
      files: { ...DEFAULT_REWIND },
      conversation: { resumeAt: 'a-1' },
    });
    assert.deepEqual(first.calls, [['rewindFiles', 'u-2', { dryRun: false }], ['close']]);
    assert.equal(h.engine.queries[1].options.resumeSessionAt, 'a-1');
  });

  test('a refused both rewind changes neither the files nor the conversation', async () => {
    const h = harness();
    addSession(h.engine, S1, { messages: turns(S1) });
    const { query } = await openLive(h, S1);
    query.values.rewindFiles = { canRewind: false, error: 'nope' };
    await expectError(h.host.rewind(S1, { userMessageId: 'u-2', mode: 'both' }), 422, 'CANNOT_REWIND');
    assert.equal(query.closed, false);
    assert.equal(h.engine.queries.length, 1);
  });

  test('a running turn refuses every rewind mode, a dry run included, with 409 before anything changes', async () => {
    const h = harness();
    addSession(h.engine, S1, { messages: turns(S1) });
    const { query } = await openLive(h, S1);
    await h.host.sendMessage(S1, { clientMessageId: randomUUID(), text: 'a third question' });
    assert.equal(h.host.liveInfo(S1).state, 'running');
    for (const [mode, dryRun] of [['code', false], ['conversation', false], ['both', false], ['code', true],
      ['conversation', true], ['both', true]]) {
      await expectError(h.host.rewind(S1, { userMessageId: 'u-2', mode, dryRun }), 409, 'CONFLICT');
    }
    await assert.rejects(h.host.rewind(S1, { userMessageId: 'u-2', mode: 'both' }),
      (error) => error.message === 'Stop the running turn before rewinding this session.');
    assert.equal(query.closed, false);
    assert.equal(h.engine.queries.length, 1);
    assert.equal(query.calls.some(([name]) => name === 'rewindFiles' || name === 'close'), false);
    assert.equal(ofType(h.events, 'sessions_changed').some((event) => event.data.reason === 'rewind'), false);

    query.emit({ type: 'result', subtype: 'success', is_error: false, uuid: randomUUID(), session_id: S1 });
    await flush();
    assert.equal(h.host.liveInfo(S1).state, 'idle');
    assert.deepEqual(await h.host.rewind(S1, { userMessageId: 'u-2', mode: 'code' }), { files: { ...DEFAULT_REWIND } });
  });

  test('a session waiting for a permission answer refuses the rewind too', async () => {
    const h = harness();
    addSession(h.engine, S1, { messages: turns(S1) });
    const { query } = await openLive(h, S1);
    callTool(query, 'Bash', { command: 'ls' }, { requestId: 'r-1' });
    await flush();
    assert.equal(h.host.liveInfo(S1).state, 'requires_action');
    await expectError(h.host.rewind(S1, { userMessageId: 'u-2', mode: 'conversation' }), 409, 'CONFLICT');
    assert.equal(query.closed, false);
    assert.equal(h.engine.queries.length, 1);
  });

  test('only user messages after the first entry can be rewound to', async () => {
    const h = harness();
    addSession(h.engine, S1, { messages: turns(S1) });
    await openLive(h, S1);
    for (const userMessageId of ['u-1', 'a-1', 'missing']) {
      await expectError(h.host.rewind(S1, { userMessageId, mode: 'conversation' }), 422, 'CANNOT_REWIND');
    }
    const created = await startLive(h);
    await expectError(h.host.rewind(created.sessionId, { userMessageId: 'u-1', mode: 'conversation' }),
      422, 'CANNOT_REWIND');
  });

  test('rewind validates its arguments before it touches the session', async () => {
    const h = harness();
    addSession(h.engine, S1, { messages: turns(S1) });
    const { query } = await openLive(h, S1);
    await expectError(h.host.rewind(S1, { userMessageId: 'u-2', mode: 'undo' }), 422, 'INVALID_ARGUMENT');
    await expectError(h.host.rewind(S1, { userMessageId: 'u-2', mode: 'code', dryRun: 'yes' }), 400,
      'BAD_REQUEST');
    await expectError(h.host.rewind(S1, { userMessageId: '', mode: 'code' }), 400, 'BAD_REQUEST');
    await expectError(h.host.rewind('not-a-uuid', { userMessageId: 'u-2', mode: 'code' }), 400, 'BAD_REQUEST');
    await expectError(h.host.rewind(UNKNOWN, { userMessageId: 'u-2', mode: 'conversation' }), 404,
      'SESSION_NOT_FOUND');
    assert.equal(h.engine.queries.length, 1);
    assert.deepEqual(query.calls, []);
  });
});

const EMPTY_CAPABILITIES = {
  stale: true,
  commands: [],
  models: [],
  agents: [],
  account: null,
  mcpServers: [],
  outputStyle: null,
  availableOutputStyles: [],
};

describe('EngineHost capabilities', () => {
  test('a live session reports its commands, models, agents, account, servers and output styles', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    assert.deepEqual(await h.host.getCapabilities(sessionId), {
      stale: false,
      commands: DEFAULT_INIT.commands,
      models: DEFAULT_INIT.models,
      agents: DEFAULT_INIT.agents,
      account: DEFAULT_INIT.account,
      mcpServers: DEFAULT_MCP,
      outputStyle: 'default',
      availableOutputStyles: ['default', 'explanatory'],
    });
    assert.equal(query.calls.filter((call) => call[0] === 'initializationResult').length, 1);
  });

  test('the MCP servers of the capabilities and of an MCP action keep their tools and lose the secrets of their configs', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    // Secrets exist only in this test: a URL with a password and query values, a header, an argument and an env value.
    query.values.mcpServerStatus = [{
      name: 'github',
      status: 'connected',
      tools: [{ name: 'search' }],
      config: { type: 'http', url: 'https://user:pw@mcp.test/sse?token=abc&team=ops', headers: { Authorization: 'Bearer abc' } },
    }, {
      name: 'filesystem',
      status: 'connected',
      tools: [],
      config: { type: 'stdio', command: 'npx', args: ['fs', '--api-key', 'abc'], env: { ROOT_TOKEN: 'abc' } },
    }];
    const expected = [{
      name: 'github',
      status: 'connected',
      tools: [{ name: 'search' }],
      config: {
        type: 'http',
        url: 'https://mcp.test/sse?token=[redacted]&team=[redacted]',
        headers: { Authorization: '[redacted]' },
      },
    }, {
      name: 'filesystem',
      status: 'connected',
      tools: [],
      config: { type: 'stdio', command: 'npx', args: ['fs', '--api-key', '[redacted]'], env: { ROOT_TOKEN: '[redacted]' } },
    }];
    const caps = await h.host.getCapabilities(sessionId);
    assert.deepEqual(caps.mcpServers, expected);
    const answer = await h.host.mcpAction(sessionId, 'github', { action: 'reconnect' });
    assert.deepEqual(answer.mcpServers, expected);
    assert.doesNotMatch(JSON.stringify([caps, answer]), /abc|pw@/);
  });

  test('capabilities are cached for 30 seconds and read again afterwards', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    await h.host.getCapabilities(sessionId);
    h.time.now += 29_000;
    await h.host.getCapabilities(sessionId);
    assert.equal(query.calls.filter((call) => call[0] === 'mcpServerStatus').length, 1);
    h.time.now += 1_000;
    await h.host.getCapabilities(sessionId);
    assert.equal(query.calls.filter((call) => call[0] === 'mcpServerStatus').length, 2);
  });

  test('a closed session answers with the last known capabilities of its folder, marked stale', async () => {
    const h = harness();
    const { sessionId } = await startLive(h);
    await h.host.getCapabilities(sessionId);
    await h.host.closeSession(sessionId);
    addSession(h.engine, S2, { cwd: CWD });
    addSession(h.engine, S3, { cwd: `${CWD}/other` });
    const sameFolder = await h.host.getCapabilities(S2);
    assert.equal(sameFolder.stale, true);
    assert.deepEqual(sameFolder.commands, DEFAULT_INIT.commands);
    const otherFolder = await h.host.getCapabilities(S3);
    assert.equal(otherFolder.stale, true);
    assert.deepEqual(otherFolder.models, DEFAULT_INIT.models);
    const outside = randomUUID();
    addSession(h.engine, outside, { cwd: OUTSIDE });
    await expectError(h.host.getCapabilities(outside), 404, 'SESSION_NOT_FOUND');
  });

  test('a closed session with nothing remembered answers with empty, stale capabilities', async () => {
    const h = harness();
    addSession(h.engine, S1);
    assert.deepEqual(await h.host.getCapabilities(S1), EMPTY_CAPABILITIES);
    await expectError(h.host.getCapabilities(UNKNOWN), 404, 'SESSION_NOT_FOUND');
    await expectError(h.host.getCapabilities('bad'), 400, 'BAD_REQUEST');
  });

  test('a failing capability query answers with the last known capabilities, marked stale, and only logs the failure',
    async () => {
      const h = harness();
      const { sessionId, query } = await startLive(h);
      await h.host.getCapabilities(sessionId);
      h.time.now += 30_000;
      query.failures.set('mcpServerStatus', new Error('mcp down'));
      const caps = await h.host.getCapabilities(sessionId);
      assert.equal(caps.stale, true);
      assert.deepEqual(caps.models, DEFAULT_INIT.models);
      assert.deepEqual(caps.mcpServers, DEFAULT_MCP);
      assert.equal(ofType(h.events, 'notice').length, 0);
      assert.equal(h.logs.some((entry) => entry.level === 'debug' && entry.msg === 'capability query failed'), true);
    });

  test('when both capability queries fail with nothing known, the answer is empty and stale', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    query.failures.set('initializationResult', new Error('x'));
    query.failures.set('mcpServerStatus', new Error('y'));
    assert.deepEqual(await h.host.getCapabilities(sessionId), { ...EMPTY_CAPABILITIES, stale: true });
  });

  test('when the init query fails, the commands last announced by the query are used', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    query.emit({
      type: 'system',
      subtype: 'commands_changed',
      uuid: randomUUID(),
      session_id: sessionId,
      commands: [{ name: 'deploy', description: 'Deploy', argumentHint: '' }],
    });
    await flush();
    query.failures.set('initializationResult', new Error('gone'));
    const caps = await h.host.getCapabilities(sessionId);
    assert.deepEqual(caps.commands.map((command) => command.name), ['deploy']);
  });
});

describe('EngineHost MCP servers, reload and context usage', () => {
  test('toggling an MCP server calls the query and returns the status of every server', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    assert.deepEqual(await h.host.mcpAction(sessionId, 'docs', { action: 'toggle', enabled: false }), {
      mcpServers: DEFAULT_MCP,
    });
    assert.deepEqual(query.calls, [['toggleMcpServer', 'docs', false], ['mcpServerStatus']]);
    await h.host.mcpAction(sessionId, 'docs', { action: 'toggle' });
    assert.deepEqual(query.calls.at(-2), ['toggleMcpServer', 'docs', true]);
  });

  test('reconnecting an MCP server calls the query', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    await h.host.mcpAction(sessionId, 'docs', { action: 'reconnect' });
    assert.deepEqual(query.calls, [['reconnectMcpServer', 'docs'], ['mcpServerStatus']]);
  });

  test('an MCP change drops the cached capabilities so the next read is fresh', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    await h.host.getCapabilities(sessionId);
    await h.host.mcpAction(sessionId, 'docs', { action: 'reconnect' });
    await h.host.getCapabilities(sessionId);
    assert.equal(query.calls.filter((call) => call[0] === 'initializationResult').length, 2);
  });

  test('MCP actions are validated before the query is called', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    await expectError(h.host.mcpAction(sessionId, 'docs', { action: 'delete' }), 422, 'INVALID_ARGUMENT');
    await expectError(h.host.mcpAction(sessionId, 'docs', null), 400, 'BAD_REQUEST');
    await expectError(h.host.mcpAction(sessionId, 'docs', { action: 'toggle', enabled: 'yes' }), 400,
      'BAD_REQUEST');
    await expectError(h.host.mcpAction(sessionId, '', { action: 'toggle' }), 400, 'BAD_REQUEST');
    await expectError(h.host.mcpAction(sessionId, 'x'.repeat(201), { action: 'toggle' }), 400, 'BAD_REQUEST');
    await expectError(h.host.mcpAction(UNKNOWN, 'docs', { action: 'toggle' }), 409, 'SESSION_NOT_LIVE');
    assert.deepEqual(query.calls, []);
  });

  test('a failing MCP call is reported as ENGINE_ERROR and does not expose the engine message', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    query.failures.set('toggleMcpServer', new Error('internal: /home/claude/.claude/mcp.json'));
    await assert.rejects(h.host.mcpAction(sessionId, 'docs', { action: 'toggle' }), (error) => {
      assert.equal(error.status, 502);
      assert.equal(error.code, 'ENGINE_ERROR');
      assert.equal(error.message, 'The MCP server could not be updated.');
      return true;
    });
    query.failures.delete('toggleMcpServer');
    query.failures.set('mcpServerStatus', new Error('status down'));
    await assert.rejects(h.host.mcpAction(sessionId, 'docs', { action: 'reconnect' }), (error) => error.code
      === 'ENGINE_ERROR' && error.message === 'The MCP server status could not be read.');
  });

  test('reloading plugins or skills calls the matching query method and drops the cached capabilities', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    await h.host.getCapabilities(sessionId);
    await h.host.reload(sessionId, 'plugins');
    await h.host.reload(sessionId, 'skills');
    assert.deepEqual(query.calls.filter((call) => call[0].startsWith('reload')), [
      ['reloadPlugins', { holdOnCacheImpact: true }], ['reloadSkills'],
    ]);
    await h.host.getCapabilities(sessionId);
    assert.equal(query.calls.filter((call) => call[0] === 'initializationResult').length, 2);
  });

  test('reload refuses unknown targets, sessions that are not open and failures', async () => {
    const h = harness();
    addSession(h.engine, S1);
    await expectError(h.host.reload(S1, 'hooks'), 422, 'INVALID_ARGUMENT');
    await expectError(h.host.reload(S1, 'plugins'), 409, 'SESSION_NOT_LIVE');
    const { sessionId, query } = await startLive(h);
    query.failures.set('reloadSkills', new Error('nope'));
    await assert.rejects(h.host.reload(sessionId, 'skills'), (error) => error.status === 502
      && error.message === 'The session could not be reloaded.');
  });

  test('context usage is read from the live query at summary detail', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    assert.deepEqual(await h.host.getContextUsage(sessionId), DEFAULT_CONTEXT);
    assert.deepEqual(query.calls, [['getContextUsage', { detail: 'summary' }]]);
  });

  test('context usage needs an open session and reports failures safely', async () => {
    const h = harness();
    addSession(h.engine, S1);
    await expectError(h.host.getContextUsage(S1), 409, 'SESSION_NOT_LIVE');
    await expectError(h.host.getContextUsage('nope'), 400, 'BAD_REQUEST');
    const { sessionId, query } = await startLive(h);
    query.failures.set('getContextUsage', new Error('x'));
    await assert.rejects(h.host.getContextUsage(sessionId), (error) => error.code === 'ENGINE_ERROR'
      && error.message === 'The context usage could not be read.');
  });

  test('stopTask stops a task of an open session and needs the session to be open', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    await h.host.stopTask(sessionId, 'task-1');
    assert.deepEqual(query.calls.at(-1), ['stopTask', 'task-1']);
    await expectError(h.host.stopTask(UNKNOWN, 'task-1'), 409, 'SESSION_NOT_LIVE');
    await expectError(h.host.stopTask(sessionId, ''), 400, 'BAD_REQUEST');
    query.failures.set('stopTask', new Error('x'));
    await assert.rejects(h.host.stopTask(sessionId, 'task-1'), (error) => error.status === 502
      && error.message === 'The task could not be stopped.');
  });
});

describe('EngineHost subagents', () => {
  test('subagents are listed and read through the engine', async () => {
    const h = harness();
    addSession(h.engine, S1);
    assert.deepEqual(await h.host.listSubagents(S1), ['agent-a']);
    assert.deepEqual(await h.host.getSubagentMessages(S1, 'agent-a'), []);
    const subagentCalls = h.engine.calls.filter((call) => call[0] === 'listSubagents'
      || call[0] === 'getSubagentMessages');
    assert.deepEqual(subagentCalls, [
      ['listSubagents', S1],
      ['getSubagentMessages', S1, 'agent-a'],
    ]);
    await expectError(h.host.listSubagents('nope'), 400, 'BAD_REQUEST');
    await expectError(h.host.getSubagentMessages(S1, ''), 400, 'BAD_REQUEST');
    await expectError(h.host.listSubagents(UNKNOWN), 404, 'SESSION_NOT_FOUND');
  });

  test('a failing subagent read is reported without the engine text', async () => {
    const h = harness();
    addSession(h.engine, S1);
    h.engine.listSubagents = async () => {
      throw new Error('/home/claude/.claude/subagents denied');
    };
    await assert.rejects(h.host.listSubagents(S1), (error) => error.status === 502
      && error.message === 'The subagents could not be listed.');
  });
});

describe('EngineHost session listing and detail', () => {
  test('listing without a folder shows only sessions inside the workspace roots, newest first', async () => {
    const h = harness();
    addSession(h.engine, S1, { cwd: CWD, lastModified: 1000, summary: 'Older' });
    addSession(h.engine, S2, { cwd: OUTSIDE, lastModified: 3000, summary: 'Outside' });
    addSession(h.engine, S3, { cwd: `${CWD}/sub`, lastModified: 2000, summary: 'Nested' });
    const listed = await h.host.listSessions();
    assert.deepEqual(listed.map((session) => session.sessionId), [S3, S1]);
    assert.equal(listed[0].summary, 'Nested');
    assert.equal(listed[0].live, null);
  });

  test('listing a folder includes its open sessions that are not saved yet', async () => {
    const h = harness();
    addSession(h.engine, S1, { cwd: CWD, lastModified: 1000 });
    addSession(h.engine, S2, { cwd: OUTSIDE, lastModified: 5000 });
    const { sessionId } = await h.host.createSession({ cwd: CWD, title: 'Fresh' });
    const listed = await h.host.listSessions({ cwd: CWD });
    assert.deepEqual(listed.map((session) => session.sessionId), [sessionId, S1]);
    assert.equal(listed[0].summary, 'Fresh');
    assert.equal(listed[0].customTitle, 'Fresh');
    assert.equal(listed[0].live.state, 'idle', 'the handshake is answered, so the new session is idle before a prompt');
    assert.deepEqual(h.engine.calls.at(-1), ['listSessions', { dir: CWD, limit: 100, offset: 0 }]);
  });

  test('listing pages return the requested window and validate their arguments', async () => {
    const h = harness();
    const ids = Array.from({ length: 5 }, () => randomUUID());
    ids.forEach((id, index) => addSession(h.engine, id, { cwd: CWD, lastModified: 1000 + index }));
    const page = await h.host.listSessions({ cwd: CWD, limit: 2, offset: 1 });
    assert.deepEqual(page.map((session) => session.sessionId), [ids[3], ids[2]]);
    await expectError(h.host.listSessions({ cwd: '' }), 400, 'BAD_REQUEST');
    await expectError(h.host.listSessions({ cwd: 5 }), 400, 'BAD_REQUEST');
    await expectError(h.host.listSessions({ limit: 0 }), 400, 'BAD_REQUEST');
    await expectError(h.host.listSessions({ limit: 501 }), 400, 'BAD_REQUEST');
    await expectError(h.host.listSessions({ limit: 1.5 }), 400, 'BAD_REQUEST');
    await expectError(h.host.listSessions({ offset: -1 }), 400, 'BAD_REQUEST');
  });

  test('getSession returns the stored info of a closed session and the live detail of an open one', async () => {
    const h = harness();
    addSession(h.engine, S1, { summary: 'Stored', lastModified: 1000 });
    const closed = await h.host.getSession(S1);
    assert.equal(closed.info.summary, 'Stored');
    assert.equal(closed.live, null);
    assert.equal(closed.init, null);
    assert.deepEqual(closed.pending, []);
    assert.deepEqual(closed.liveEvents, []);
    const { sessionId } = await startLive(h, { cwd: CWD }, { model: 'claude-x' });
    const open = await h.host.getSession(sessionId);
    assert.equal(open.info, null);
    assert.equal(open.live.state, 'idle');
    assert.equal(open.init.model, 'claude-x');
    assert.equal(open.liveEvents.length, 1);
    assert.equal(open.seq, h.sequence());
  });

  test('getSession answers 404 for unknown sessions and treats a failing read as unknown', async () => {
    const h = harness();
    await expectError(h.host.getSession('bad'), 400, 'BAD_REQUEST');
    await expectError(h.host.getSession(UNKNOWN), 404, 'SESSION_NOT_FOUND');
    addSession(h.engine, S1);
    h.engine.infoError = new Error('disk gone');
    await expectError(h.host.getSession(S1), 404, 'SESSION_NOT_FOUND');
    assert.equal(h.logs.some((entry) => entry.msg === 'reading a session failed'), true);
  });

  test('getSession answers with the gateway clock, so a client can convert the times the meter holds', async () => {
    const h = harness();
    addSession(h.engine, S1);
    h.time.now = 77_000;
    assert.equal((await h.host.getSession(S1)).now, 77_000);
    const { sessionId } = await startLive(h);
    h.time.now = 78_500;
    assert.equal((await h.host.getSession(sessionId)).now, 78_500);
  });
});

describe('EngineHost transcripts', () => {
  const indexes = (messages) => messages.map((message) => message.index);

  test('getTranscript returns windows of the stored messages with their indexes', async () => {
    const h = harness();
    const messages = Array.from({ length: 10 }, (_, i) => userEntry(S1, `m-${i}`, `message ${i}`));
    addSession(h.engine, S1, { messages });
    const all = await h.host.getTranscript(S1);
    assert.equal(all.total, 10);
    assert.equal(all.start, 0);
    assert.equal(all.hasMore, false);
    assert.deepEqual(indexes(all.messages), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const last3 = await h.host.getTranscript(S1, { tail: 3 });
    assert.deepEqual(indexes(last3.messages), [7, 8, 9]);
    assert.equal(last3.start, 7);
    assert.equal(last3.hasMore, true);
    const before = await h.host.getTranscript(S1, { before: 5, limit: 2 });
    assert.deepEqual(indexes(before.messages), [3, 4]);
    assert.equal(before.hasMore, true);
    const head = await h.host.getTranscript(S1, { before: 1, limit: 5 });
    assert.deepEqual(indexes(head.messages), [0]);
    assert.equal(head.hasMore, false);
    const clamped = await h.host.getTranscript(S1, { before: 100, limit: 3 });
    assert.deepEqual(indexes(clamped.messages), [7, 8, 9]);
  });

  test('transcript windows are validated and unknown sessions are 404', async () => {
    const h = harness();
    addSession(h.engine, S1, { messages: [userEntry(S1, 'm-1', 'hi')] });
    await expectError(h.host.getTranscript(S1, { tail: 0 }), 400, 'BAD_REQUEST');
    await expectError(h.host.getTranscript(S1, { tail: 5001 }), 400, 'BAD_REQUEST');
    await expectError(h.host.getTranscript(S1, { before: -1 }), 400, 'BAD_REQUEST');
    await expectError(h.host.getTranscript('nope'), 400, 'BAD_REQUEST');
    await expectError(h.host.getTranscript(UNKNOWN), 404, 'SESSION_NOT_FOUND');
  });

  test('the transcript is read once per version of the session file, with system messages', async () => {
    const h = harness();
    addSession(h.engine, S1, { messages: [userEntry(S1, 'm-1', 'hi')] });
    await h.host.getTranscript(S1);
    await h.host.getTranscript(S1, { tail: 1 });
    const reads = h.engine.calls.filter((call) => call[0] === 'getSessionMessages');
    assert.equal(reads.length, 1);
    assert.deepEqual(reads[0][2], { includeSystemMessages: true });
    const entry = h.engine.store.get(S1);
    entry.messages.push(userEntry(S1, 'm-2', 'again'));
    entry.info.lastModified += 1;
    assert.equal((await h.host.getTranscript(S1)).total, 2);
    assert.equal(h.engine.calls.filter((call) => call[0] === 'getSessionMessages').length, 2);
  });

  test('an open session without a stored file has an empty transcript', async () => {
    const h = harness();
    const { sessionId } = await startLive(h);
    assert.deepEqual(await h.host.getTranscript(sessionId), { messages: [], total: 0, start: 0, hasMore: false });
  });
});

describe('EngineHost fork, rename, tag and delete', () => {
  test('fork copies the session up to a message under a new id and announces it', async () => {
    const h = harness();
    addSession(h.engine, S1, { messages: turns(S1) });
    const { sessionId } = await h.host.fork(S1, { upToMessageId: 'a-1', title: 'Branch' });
    assert.ok(isUuid(sessionId));
    assert.notEqual(sessionId, S1);
    assert.deepEqual(h.engine.calls.at(-1), ['forkSession', S1, { upToMessageId: 'a-1', title: 'Branch' }]);
    assert.equal(h.engine.store.get(sessionId).messages.length, 2);
    assert.deepEqual(ofType(h.events, 'sessions_changed').at(-1).data, { reason: 'fork', sessionId });
  });

  test('fork without options copies the whole session, and a blank title is dropped', async () => {
    const h = harness();
    addSession(h.engine, S1, { messages: turns(S1) });
    const { sessionId } = await h.host.fork(S1, { title: '   ' });
    assert.deepEqual(h.engine.calls.at(-1), ['forkSession', S1, {}]);
    assert.equal(h.engine.store.get(sessionId).messages.length, 4);
  });

  test('fork validates its arguments and reports failures without the engine text', async () => {
    const h = harness();
    addSession(h.engine, S1);
    await expectError(h.host.fork('bad'), 400, 'BAD_REQUEST');
    await expectError(h.host.fork(S1, { upToMessageId: '' }), 400, 'BAD_REQUEST');
    await expectError(h.host.fork(S1, { title: 'x'.repeat(201) }), 422, 'INVALID_ARGUMENT');
    await expectError(h.host.fork(UNKNOWN), 404, 'SESSION_NOT_FOUND');
    assert.equal(h.engine.calls.some((call) => call[0] === 'forkSession'), false);
    h.engine.forkSession = async () => {
      throw new Error('disk full at /home/claude/.claude/projects');
    };
    await assert.rejects(h.host.fork(S1), (error) => error.status === 502
      && error.message === 'Claude Code could not fork the session.');
  });

  test('rename changes the stored title, trimmed, and announces it', async () => {
    const h = harness();
    addSession(h.engine, S1, { summary: 'Old' });
    await h.host.rename(S1, '  New name  ');
    assert.deepEqual(h.engine.calls.at(-1), ['renameSession', S1, 'New name']);
    assert.equal(h.engine.store.get(S1).info.customTitle, 'New name');
    assert.deepEqual(ofType(h.events, 'sessions_changed').at(-1).data, { reason: 'renamed', sessionId: S1 });
  });

  test('renaming an open session also changes its live title and publishes the state', async () => {
    const h = harness();
    addSession(h.engine, S1);
    await openLive(h, S1);
    await h.host.rename(S1, 'Live title');
    assert.equal(h.host.liveInfo(S1).title, 'Live title');
    assert.equal(ofType(h.events, 'session_state').at(-1).data.live.title, 'Live title');
  });

  test('renaming a session that is only open changes the live title and touches no file', async () => {
    const h = harness();
    const { sessionId } = await startLive(h);
    await h.host.rename(sessionId, 'Only live');
    assert.equal(h.host.liveInfo(sessionId).title, 'Only live');
    assert.equal(h.engine.calls.some((call) => call[0] === 'renameSession'), false);
  });

  test('rename validates the title and reports unknown sessions and engine failures', async () => {
    const h = harness();
    addSession(h.engine, S1);
    await expectError(h.host.rename(S1, '   '), 422, 'INVALID_ARGUMENT');
    await expectError(h.host.rename(S1, 42), 400, 'BAD_REQUEST');
    await expectError(h.host.rename(S1, 'x'.repeat(201)), 422, 'INVALID_ARGUMENT');
    await expectError(h.host.rename(UNKNOWN, 'Name'), 404, 'SESSION_NOT_FOUND');
    h.engine.renameSession = async () => {
      throw new Error('locked by another process: /home/claude/.claude/x');
    };
    await assert.rejects(h.host.rename(S1, 'Name'), (error) => error.status === 502
      && error.message === 'The session could not be renamed.');
  });

  test('tag sets, replaces and clears the tag of a stored session; a blank tag clears it', async () => {
    const h = harness();
    addSession(h.engine, S1);
    await h.host.tag(S1, '  urgent ');
    assert.deepEqual(h.engine.calls.at(-1), ['tagSession', S1, 'urgent']);
    assert.equal(h.engine.store.get(S1).info.tag, 'urgent');
    await h.host.tag(S1, null);
    assert.deepEqual(h.engine.calls.at(-1), ['tagSession', S1, null]);
    assert.equal('tag' in h.engine.store.get(S1).info, false);
    await h.host.tag(S1, '   ');
    assert.deepEqual(h.engine.calls.at(-1), ['tagSession', S1, null]);
    assert.deepEqual(ofType(h.events, 'sessions_changed').at(-1).data, { reason: 'tagged', sessionId: S1 });
  });

  test('tagging an open session without a stored file publishes the change and calls no tag function', async () => {
    const h = harness();
    const { sessionId } = await startLive(h);
    await h.host.tag(sessionId, 'x');
    assert.equal(h.engine.calls.some((call) => call[0] === 'tagSession'), false);
    assert.deepEqual(ofType(h.events, 'sessions_changed').at(-1).data, { reason: 'tagged', sessionId });
  });

  test('tag validates its input and reports unknown sessions and engine failures', async () => {
    const h = harness();
    addSession(h.engine, S1);
    await expectError(h.host.tag(S1, 'x'.repeat(101)), 422, 'INVALID_ARGUMENT');
    await expectError(h.host.tag(S1, 7), 400, 'BAD_REQUEST');
    await expectError(h.host.tag(UNKNOWN, 'x'), 404, 'SESSION_NOT_FOUND');
    h.engine.tagSession = async () => {
      throw new Error('nope');
    };
    await assert.rejects(h.host.tag(S1, 'x'), (error) => error.status === 502
      && error.message === 'The session could not be tagged.');
  });

  test('deleting a closed session removes its file, announces it and forgets its transcript', async () => {
    const h = harness();
    addSession(h.engine, S1, { messages: turns(S1) });
    await h.host.getTranscript(S1);
    await h.host.deleteSession(S1);
    assert.equal(h.engine.store.has(S1), false);
    assert.deepEqual(ofType(h.events, 'sessions_changed').at(-1).data, { reason: 'deleted', sessionId: S1 });
    await expectError(h.host.getSession(S1), 404, 'SESSION_NOT_FOUND');
  });

  test('open sessions cannot be deleted, and unknown sessions are 404', async () => {
    const h = harness();
    addSession(h.engine, S1);
    await openLive(h, S1);
    await expectError(h.host.deleteSession(S1), 409, 'CONFLICT');
    await h.host.closeSession(S1);
    await expectError(h.host.deleteSession(UNKNOWN), 404, 'SESSION_NOT_FOUND');
    await expectError(h.host.deleteSession('bad'), 400, 'BAD_REQUEST');
    assert.equal(h.engine.store.has(S1), true);
    h.engine.deleteSession = async () => {
      throw new Error('EPERM /home/claude/.claude/projects/x.jsonl');
    };
    await assert.rejects(h.host.deleteSession(S1), (error) => error.status === 502
      && error.message === 'The session could not be deleted.');
  });
});

describe('EngineHost terminal locks', () => {
  test('a locked session closes its query and refuses every start until released', async () => {
    const h = harness();
    addSession(h.engine, S1, { messages: turns(S1) });
    const { query } = await openLive(h, S1);
    const release = await h.host.lockForTerminal(S1);
    assert.equal(query.closed, true);
    assert.equal(h.host.liveInfo(S1), null);
    await expectError(h.host.openSession(S1), 409, 'SESSION_LOCKED');
    await expectError(h.host.sendMessage(S1, { clientMessageId: randomUUID(), text: 'x' }), 409, 'SESSION_LOCKED');
    await expectError(h.host.rewind(S1, { userMessageId: 'u-2', mode: 'code' }), 409, 'SESSION_LOCKED');
    await expectError(h.host.deleteSession(S1), 409, 'SESSION_LOCKED');
    await expectError(h.host.lockForTerminal(S1), 409, 'SESSION_LOCKED');
    assert.equal(h.engine.queries.length, 1);
    release();
    release();
    await h.host.openSession(S1);
    assert.equal(h.engine.queries.length, 2);
  });

  test('a lock taken while the session is opening waits for the start and then closes it', async () => {
    const h = harness();
    addSession(h.engine, S1);
    const opening = h.host.openSession(S1);
    const locking = h.host.lockForTerminal(S1);
    await opening;
    const release = await locking;
    assert.equal(h.engine.queries.length, 1);
    assert.equal(h.engine.queries[0].closed, true);
    assert.equal(h.host.liveInfo(S1), null);
    release();
  });

  test('locks need a valid id and a session inside the roots, and cannot be taken twice', async () => {
    const h = harness();
    await expectError(h.host.lockForTerminal('bad'), 400, 'BAD_REQUEST');
    await expectError(h.host.lockForTerminal(S1), 404, 'SESSION_NOT_FOUND');
    addSession(h.engine, S1);
    addSession(h.engine, S2, { cwd: OUTSIDE });
    await expectError(h.host.lockForTerminal(S2), 404, 'SESSION_NOT_FOUND');
    const release = await h.host.lockForTerminal(S1);
    await expectError(h.host.lockForTerminal(S1), 409, 'SESSION_LOCKED');
    release();
  });
});

describe('EngineHost idle sessions and shutdown', () => {
  test('sweepIdle closes sessions idle for longer than the timeout, but not busy or waiting ones', async () => {
    const h = harness({ config: { idleTimeoutMs: 60_000, maxLiveSessions: 5 } });
    const idle = await startLive(h);
    const busy = await startLive(h);
    await h.host.sendMessage(busy.sessionId, { clientMessageId: randomUUID(), text: 'working' });
    const waiting = await startLive(h);
    callTool(waiting.query, 'Bash', { command: 'ls' }, { requestId: 'sw-1' });
    h.time.now += 60_000;
    assert.equal(await h.host.sweepIdle(), 0);
    h.time.now += 1;
    assert.equal(await h.host.sweepIdle(), 1);
    assert.equal(h.host.liveInfo(idle.sessionId), null);
    assert.notEqual(h.host.liveInfo(busy.sessionId), null);
    assert.notEqual(h.host.liveInfo(waiting.sessionId), null);
    assert.deepEqual(ofType(h.events, 'session_state').at(-1).data, { sessionId: idle.sessionId, live: null });
    assert.equal(ofType(h.events, 'notice').length, 0);
  });

  test('shutdown closes every open session, cancels pending requests and refuses new starts', async () => {
    const h = harness();
    const a = await startLive(h);
    const b = await startLive(h);
    addSession(h.engine, S3);
    const request = callTool(a.query, 'Bash', { command: 'ls' }, { requestId: 'sd-1' });
    await h.host.shutdown();
    assert.equal(a.query.closed, true);
    assert.equal(b.query.closed, true);
    assert.deepEqual(await request.pending, { behavior: 'deny', message: 'Request cancelled.' });
    assert.deepEqual(h.host.allLive(), []);
    await expectError(h.host.createSession({ cwd: CWD }), 503, 'ENGINE_UNAVAILABLE');
    await expectError(h.host.openSession(S3), 503, 'ENGINE_UNAVAILABLE');
    await h.host.shutdown();
    assert.equal(ofType(h.events, 'notice').length, 0);
  });
});

describe('EngineHost failures of a running query', () => {
  test('a stream that fails publishes an error notice and removes the session', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    query.fail(new Error('Claude Code process exited with code 1'));
    await flush();
    assert.equal(h.host.liveInfo(sessionId), null);
    assert.deepEqual(ofType(h.events, 'notice').at(-1).data, {
      sessionId, level: 'error', code: 'ENGINE_ERROR', message: 'Claude Code process exited with code 1',
    });
    assert.deepEqual(ofType(h.events, 'session_state').at(-1).data, { sessionId, live: null });
    assert.equal(h.logs.some((entry) => entry.level === 'warn' && entry.msg === 'session stopped with an error'),
      true);
  });

  test('setup failures are unavailable, other failures are errors, and only the first line is shown', async () => {
    const cases = [
      [
        'spawn /usr/bin/claude ENOENT\n    at ChildProcess._handle',
        'ENGINE_UNAVAILABLE',
        'spawn /usr/bin/claude ENOENT',
      ],
      ['Invalid API key · Please run /login', 'ENGINE_UNAVAILABLE', 'Invalid API key · Please run /login'],
      ['Native CLI binary for linux-x64 not found', 'ENGINE_UNAVAILABLE', 'Native CLI binary for linux-x64 not found'],
      ['Something unexpected happened', 'ENGINE_ERROR', 'Something unexpected happened'],
      ['', 'ENGINE_ERROR', 'Claude Code stopped unexpectedly.'],
    ];
    for (const [text, code, message] of cases) {
      const h = harness();
      const { query } = await startLive(h);
      query.fail(new Error(text));
      await flush();
      const notice = ofType(h.events, 'notice').at(-1);
      assert.equal(notice.data.code, code, text);
      assert.equal(notice.data.message, message, text);
    }
  });

  test('long error messages are cut to 300 characters and nothing after the first line is shown', async () => {
    const h = harness();
    const { query } = await startLive(h);
    query.fail(new Error(`${'e'.repeat(500)}\nsecret transcript line`));
    await flush();
    const notice = ofType(h.events, 'notice').at(-1);
    assert.equal(notice.data.message.length, 300);
    assert.equal(notice.data.message.includes('secret'), false);
  });

  test('a failing query cancels its pending requests', async () => {
    const h = harness();
    const { query } = await startLive(h);
    const request = callTool(query, 'Bash', { command: 'ls' }, { requestId: 'f-1' });
    query.fail(new Error('boom'));
    assert.deepEqual(await request.pending, { behavior: 'deny', message: 'Request cancelled.' });
    assert.equal(ofType(h.events, 'request_resolved').at(-1).data.outcome, 'cancelled');
  });

  test('a query that ends on its own while a request is open cancels the request', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    const request = callTool(query, 'Bash', { command: 'ls' }, { requestId: 'e-1' });
    query.finish();
    assert.deepEqual(await request.pending, { behavior: 'deny', message: 'Request cancelled.' });
    assert.equal(h.host.liveInfo(sessionId), null);
    assert.equal(ofType(h.events, 'notice').length, 0);
  });
});

describe('EngineHost start failures', () => {
  test('a query that cannot start is unavailable and leaves no session behind', async () => {
    const h = harness();
    h.engine.startError = new Error('spawn /opt/claude ENOENT');
    await assert.rejects(h.host.createSession({ cwd: CWD }), (error) => error.status === 503
      && error.code === 'ENGINE_UNAVAILABLE' && !error.message.includes('/opt/claude'));
    assert.deepEqual(h.host.allLive(), []);
    assert.equal(ofType(h.events, 'session_state').length, 0);
    assert.equal(ofType(h.events, 'sessions_changed').length, 0);
    h.engine.startError = new Error('the engine broke');
    await expectError(h.host.createSession({ cwd: CWD }), 502, 'ENGINE_ERROR');
    assert.equal(h.engine.queries.length, 0);
  });

  test('a session that failed to open can be opened once the engine recovers', async () => {
    const h = harness();
    addSession(h.engine, S1);
    h.engine.startError = new Error('spawn x ENOENT');
    await expectError(h.host.openSession(S1), 503, 'ENGINE_UNAVAILABLE');
    h.engine.startError = null;
    const { query } = await openLive(h, S1);
    assert.equal(query.options.resume, S1);
    assert.equal(h.host.liveInfo(S1).state, 'idle');
  });
});

describe('EngineHost log hygiene', () => {
  test('logs never carry prompts, tool input, transcript text, stderr, errors or folders', async () => {
    const h = harness();
    addSession(h.engine, S1, { messages: [userEntry(S1, 'u-1', 'SECRET-TRANSCRIPT')] });
    const { sessionId, query } = await startLive(h);
    await h.host.sendMessage(sessionId, { clientMessageId: randomUUID(), text: 'SECRET-PROMPT' });
    callTool(query, 'Bash', { command: 'cat SECRET-COMMAND' }, { requestId: 'l-1' });
    query.options.stderr(Buffer.from('SECRET-STDERR'));
    await h.host.getTranscript(S1);
    await h.host.respond(sessionId, 'l-1', { decision: 'deny', message: 'SECRET-DENIAL' });
    await h.host.rename(sessionId, 'SECRET-TITLE');
    query.fail(new Error(`SECRET-ERROR\n${CWD}`));
    await flush();
    await h.host.listSessions({ cwd: CWD });
    const logged = JSON.stringify(h.logs);
    for (const secret of ['SECRET-PROMPT', 'SECRET-COMMAND', 'SECRET-STDERR', 'SECRET-DENIAL', 'SECRET-TITLE',
      'SECRET-ERROR', 'SECRET-TRANSCRIPT', CWD]) {
      assert.equal(logged.includes(secret), false, `${secret} must not be logged`);
    }
    assert.equal(h.logs.some((entry) => entry.level === 'debug' && entry.msg === 'engine stderr'), true);
  });
});

const CREDENTIALS_NOTICE = 'Claude Code credentials were rejected. Log in again on the server: run `claude` and use '
  + '/login.';
const TIMEOUT_NOTICE = 'The Claude Code runtime did not respond in time.';
const CONTROL_TIMEOUT = 10_000;

/** @param {string} sessionId @param {string} error */
function retryMessage(sessionId, error) {
  return {
    type: 'system',
    subtype: 'api_retry',
    attempt: 1,
    max_retries: 10,
    retry_delay_ms: 500,
    error_status: 401,
    error,
    uuid: randomUUID(),
    session_id: sessionId,
  };
}

/** @param {string} sessionId @param {string} error */
function assistantError(sessionId, error) {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    session_id: sessionId,
    parent_tool_use_id: null,
    error,
    message: { id: `msg-${randomUUID()}`, role: 'assistant', content: [{ type: 'text', text: 'Please log in.' }] },
  };
}

describe('EngineHost credential failures', () => {
  test('a retry that reports rejected credentials sets the session error and publishes one notice per query',
    async () => {
      const h = harness();
      const { sessionId, query } = await startLive(h);
      query.emit(retryMessage(sessionId, 'authentication_failed'));
      await flush();
      query.emit(retryMessage(sessionId, 'authentication_failed'));
      await flush();
      assert.deepEqual(h.host.liveInfo(sessionId).error, { code: 'ENGINE_UNAVAILABLE', message: CREDENTIALS_NOTICE });
      const notices = ofType(h.events, 'notice');
      assert.equal(notices.length, 1);
      assert.deepEqual(notices[0].data, {
        sessionId,
        level: 'error',
        code: 'ENGINE_UNAVAILABLE',
        message: CREDENTIALS_NOTICE,
      });
      assert.equal(query.closed, false);
      assert.equal(h.logs.some((entry) => entry.msg === 'the runtime rejected its credentials'), true);
      assert.equal(JSON.stringify(h.logs).includes('authentication_failed'), false);
    });

  test('other retries and errors are not credential failures', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    for (const error of ['rate_limit', 'server_error', 'overloaded', 'billing_error', 'cloud_credential_error']) {
      query.emit(retryMessage(sessionId, error));
      query.emit(assistantError(sessionId, error));
    }
    await flush();
    assert.equal(h.host.liveInfo(sessionId).error, null);
    assert.equal(ofType(h.events, 'notice').length, 0);
  });

  test('an assistant message with an authentication error is reported the same way, and a query that starts again '
    + 'reports once more', async () => {
    const h = harness();
    addSession(h.engine, S1, { messages: turns(S1) });
    const { query } = await openLive(h, S1);
    query.emit(assistantError(S1, 'oauth_org_not_allowed'));
    query.emit(assistantError(S1, 'account_on_hold'));
    await flush();
    assert.equal(ofType(h.events, 'notice').length, 1);
    await h.host.closeSession(S1);
    const reopened = await openLive(h, S1);
    reopened.query.emit(assistantError(S1, 'verification_required'));
    await flush();
    assert.equal(ofType(h.events, 'notice').length, 2);
    assert.equal(h.host.liveInfo(S1).error.code, 'ENGINE_UNAVAILABLE');
  });
});

describe('EngineHost lifecycle queue', () => {
  test('a send that arrives during a conversation rewind reaches the restarted query only', async () => {
    const h = harness();
    addSession(h.engine, S1, { messages: turns(S1) });
    const { query: first } = await openLive(h, S1);
    const clientMessageId = randomUUID();
    const rewinding = h.host.rewind(S1, { userMessageId: 'u-2', mode: 'conversation' });
    const sending = h.host.sendMessage(S1, { clientMessageId, text: 'after the rewind' });
    await rewinding;
    assert.deepEqual(await sending, { accepted: true, duplicate: false });
    assert.equal(h.engine.queries.length, 2);
    const [, second] = h.engine.queries;
    assert.equal(first.closed, true);
    assert.equal(first.prompt.size, 0);
    assert.equal(second.options.resume, S1);
    assert.equal(second.options.resumeSessionAt, 'a-1');
    assert.equal((await nextInput(second)).uuid, clientMessageId);
  });

  test('an open during a conversation rewind waits for the restart and starts no second query', async () => {
    const h = harness();
    addSession(h.engine, S1, { messages: turns(S1) });
    await openLive(h, S1);
    const rewinding = h.host.rewind(S1, { userMessageId: 'u-2', mode: 'conversation' });
    const opening = h.host.openSession(S1);
    await rewinding;
    const info = await opening;
    assert.equal(info.sessionId, S1);
    assert.equal(h.engine.queries.length, 2);
    assert.equal(h.engine.queries[0].closed, true);
    assert.equal(h.engine.queries[1].closed, false);
  });

  test('a close during a conversation rewind waits for the restart and then stops the restarted query', async () => {
    const h = harness();
    addSession(h.engine, S1, { messages: turns(S1) });
    await openLive(h, S1);
    const rewinding = h.host.rewind(S1, { userMessageId: 'u-2', mode: 'conversation' });
    const closing = h.host.closeSession(S1);
    await rewinding;
    await closing;
    assert.equal(h.host.liveInfo(S1), null);
    assert.equal(h.engine.queries.length, 2);
    assert.equal(h.engine.queries[1].closed, true);
  });

  test('a dry run of a rewind changes nothing and starts nothing new', async () => {
    const h = harness();
    addSession(h.engine, S1, { messages: turns(S1) });
    await openLive(h, S1);
    const preview = await h.host.rewind(S1, { userMessageId: 'u-2', mode: 'conversation', dryRun: true });
    assert.deepEqual(preview, { conversation: { resumeAt: 'a-1' } });
    assert.equal(h.engine.queries.length, 1);
    assert.equal(h.engine.queries[0].closed, false);
  });

  test('a query that ended by itself takes no more input, and the next send starts the session again', async () => {
    const h = harness();
    addSession(h.engine, S1, { messages: turns(S1) });
    const { query } = await openLive(h, S1);
    query.finish();
    await flush();
    assert.equal(query.prompt.ended, true);
    assert.equal(h.host.liveInfo(S1), null);
    await h.host.sendMessage(S1, { clientMessageId: randomUUID(), text: 'again' });
    assert.equal(h.engine.queries.length, 2);
    assert.equal(h.engine.queries[1].options.resume, S1);
  });
});

describe('EngineHost close and lock ordering', () => {
  test('a send that arrives while the session is closing is not lost: it opens the session again', async () => {
    const h = harness();
    addSession(h.engine, S1, { messages: turns(S1) });
    const { query } = await openLive(h, S1);
    const closing = h.host.closeSession(S1);
    const clientMessageId = randomUUID();
    const sending = h.host.sendMessage(S1, { clientMessageId, text: 'still there?' });
    await closing;
    assert.deepEqual(await sending, { accepted: true, duplicate: false });
    assert.equal(query.closed, true);
    assert.equal(query.prompt.size, 0);
    assert.equal(h.engine.queries.length, 2);
    assert.equal(h.engine.queries[1].options.resume, S1);
    assert.equal((await nextInput(h.engine.queries[1])).uuid, clientMessageId);
  });

  test('a send that arrives during a terminal lock answers SESSION_LOCKED and starts nothing', async () => {
    const h = harness();
    addSession(h.engine, S1, { messages: turns(S1) });
    const { query } = await openLive(h, S1);
    const locking = h.host.lockForTerminal(S1);
    const sending = h.host.sendMessage(S1, { clientMessageId: randomUUID(), text: 'x' });
    const release = await locking;
    await expectError(sending, 409, 'SESSION_LOCKED');
    assert.equal(query.closed, true);
    assert.equal(h.engine.queries.length, 1);
    release();
  });
});

describe('EngineHost workspace roots', () => {
  test('session routes answer 404 for a session whose folder is outside the roots, and touch nothing', async () => {
    const h = harness();
    addSession(h.engine, S2, { cwd: OUTSIDE, messages: turns(S2) });
    const hidden = S2;
    await expectError(h.host.getSession(hidden), 404, 'SESSION_NOT_FOUND');
    await expectError(h.host.getTranscript(hidden, { tail: 2 }), 404, 'SESSION_NOT_FOUND');
    await expectError(h.host.sessionCwd(hidden), 404, 'SESSION_NOT_FOUND');
    await expectError(h.host.getCapabilities(hidden), 404, 'SESSION_NOT_FOUND');
    await expectError(h.host.fork(hidden, {}), 404, 'SESSION_NOT_FOUND');
    await expectError(h.host.rename(hidden, 'Renamed'), 404, 'SESSION_NOT_FOUND');
    await expectError(h.host.tag(hidden, 'tag'), 404, 'SESSION_NOT_FOUND');
    await expectError(h.host.deleteSession(hidden), 404, 'SESSION_NOT_FOUND');
    await expectError(h.host.listSubagents(hidden), 404, 'SESSION_NOT_FOUND');
    await expectError(h.host.getSubagentMessages(hidden, 'agent-a'), 404, 'SESSION_NOT_FOUND');
    await expectError(h.host.openSession(hidden), 404, 'SESSION_NOT_FOUND');
    await expectError(h.host.sendMessage(hidden, { clientMessageId: randomUUID(), text: 'x' }), 404,
      'SESSION_NOT_FOUND');
    await expectError(h.host.updateSettings(hidden, { model: 'haiku' }), 404, 'SESSION_NOT_FOUND');
    await expectError(h.host.rewind(hidden, { userMessageId: 'u-2', mode: 'code' }), 404, 'SESSION_NOT_FOUND');
    await expectError(h.host.lockForTerminal(hidden), 404, 'SESSION_NOT_FOUND');
    assert.equal(h.engine.queries.length, 0);
    assert.equal(h.engine.store.has(hidden), true);
    const changed = h.engine.calls.filter((call) => ['renameSession', 'tagSession', 'deleteSession', 'forkSession']
      .includes(call[0]));
    assert.deepEqual(changed, []);
  });

  test('listing an explicit folder outside the roots answers 422 PATH_NOT_ALLOWED without reading the engine',
    async () => {
      const h = harness();
      await expectError(h.host.listSessions({ cwd: OUTSIDE }), 422, 'PATH_NOT_ALLOWED');
      assert.equal(h.engine.calls.some((call) => call[0] === 'listSessions'), false);
    });

  test('creating a session outside the roots answers 422 PATH_NOT_ALLOWED and starts nothing', async () => {
    const h = harness();
    await expectError(h.host.createSession({ cwd: OUTSIDE }), 422, 'PATH_NOT_ALLOWED');
    assert.equal(h.engine.queries.length, 0);
  });

  test('a session inside the roots is served next to one outside them', async () => {
    const h = harness();
    addSession(h.engine, S1, { cwd: CWD, messages: turns(S1) });
    addSession(h.engine, S2, { cwd: OUTSIDE, messages: turns(S2) });
    assert.equal((await h.host.getSession(S1)).info.sessionId, S1);
    assert.equal((await h.host.getTranscript(S1, { tail: 1 })).total, 4);
    await expectError(h.host.getSession(S2), 404, 'SESSION_NOT_FOUND');
  });
});

describe('EngineHost control timeouts', () => {
  test('every control call gives up after 10 s with 502 ENGINE_ERROR and the runtime timeout message', async () => {
    const cases = [
      ['interrupt', (h, id) => h.host.interrupt(id)],
      ['getContextUsage', (h, id) => h.host.getContextUsage(id)],
      ['reconnectMcpServer', (h, id) => h.host.mcpAction(id, 'docs', { action: 'reconnect' })],
      ['toggleMcpServer', (h, id) => h.host.mcpAction(id, 'docs', { action: 'toggle', enabled: false })],
      ['reloadPlugins', (h, id) => h.host.reload(id, 'plugins')],
      ['reloadSkills', (h, id) => h.host.reload(id, 'skills')],
      ['rewindFiles', (h, id) => h.host.rewind(id, { userMessageId: 'u-2', mode: 'code', dryRun: true })],
      ['stopTask', (h, id) => h.host.stopTask(id, 'task-1')],
      ['setModel', (h, id) => h.host.updateSettings(id, { model: 'haiku' })],
      ['setPermissionMode', (h, id) => h.host.updateSettings(id, { permissionMode: 'acceptEdits' })],
      ['applyFlagSettings', (h, id) => h.host.updateSettings(id, { effort: 'low' })],
    ];
    for (const [method, invoke] of cases) {
      const h = harness();
      const { sessionId, query } = await startLive(h);
      query.hangs.add(method);
      mock.timers.enable({ apis: ['setTimeout'] });
      try {
        const outcome = invoke(h, sessionId).then(() => null, (error) => error);
        await flush();
        mock.timers.tick(CONTROL_TIMEOUT - 1);
        await flush();
        assert.equal(query.calls.some((call) => call[0] === method), true, `${method} was called`);
        mock.timers.tick(1);
        const error = await outcome;
        assert.ok(error instanceof AppError, `${method} answered ${String(error)}`);
        assert.equal(error.status, 502, method);
        assert.equal(error.code, 'ENGINE_ERROR', method);
        assert.equal(error.message, TIMEOUT_NOTICE, method);
        assert.equal(h.host.liveInfo(sessionId).state, 'idle', `${method} leaves the session open`);
      } finally {
        mock.timers.reset();
      }
    }
  });

  test('a capability query that times out answers from the last known capabilities, marked stale', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    await h.host.getCapabilities(sessionId);
    h.time.now += 30_000;
    query.hangs.add('initializationResult');
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const outcome = h.host.getCapabilities(sessionId);
      await flush();
      mock.timers.tick(CONTROL_TIMEOUT);
      const caps = await outcome;
      assert.equal(caps.stale, true);
      assert.deepEqual(caps.models, DEFAULT_INIT.models);
      assert.deepEqual(caps.mcpServers, DEFAULT_MCP);
      assert.equal(ofType(h.events, 'notice').length, 0);
    } finally {
      mock.timers.reset();
    }
  });

  test('an answer that comes before the 10 s limit is returned as it is', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const outcome = h.host.getContextUsage(sessionId);
      await flush();
      mock.timers.tick(CONTROL_TIMEOUT - 1);
      assert.deepEqual(await outcome, DEFAULT_CONTEXT);
      assert.equal(query.calls.at(-1)[0], 'getContextUsage');
    } finally {
      mock.timers.reset();
    }
  });

  test('a full context usage read is given 30 seconds before it times out', async (t) => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    query.hangs.add('getContextUsage');
    mock.timers.enable({ apis: ['setTimeout'] });
    t.after(() => mock.timers.reset());
    let settled = false;
    const outcome = h.host.getContextUsage(sessionId, 'full').then(() => null, (error) => {
      settled = true;
      return error;
    });
    for (let turns = 0; !query.calls.some((call) => call[0] === 'getContextUsage') && turns < 1000; turns += 1) {
      await flush();
    }
    mock.timers.tick(CONTROL_TIMEOUT + 19_999);
    await flush();
    assert.equal(settled, false);
    mock.timers.tick(1);
    const error = await outcome;
    assert.ok(error instanceof AppError);
    assert.equal(error.status, 502);
    assert.equal(error.message, TIMEOUT_NOTICE);
  });
});

describe('EngineHost folder trust', () => {
  test('without a trust check every folder is untrusted: the query loads user settings only', async () => {
    const h = harness({ trusted: null });
    const { sessionId, query, info } = await startLive(h);
    assert.deepEqual(query.options.settingSources, ['user']);
    assert.equal(info.trusted, false);
    assert.equal(h.host.liveInfo(sessionId).trusted, false);
  });

  test('a trusted folder loads project and local settings, and LiveInfo says so', async () => {
    const h = harness({ trusted: async (p) => p === CWD });
    const { sessionId, query, info } = await startLive(h);
    assert.deepEqual(query.options.settingSources, ['user', 'project', 'local']);
    assert.equal(info.trusted, true);
    assert.equal(h.host.liveInfo(sessionId).trusted, true);
  });

  test('trust is read at every start, so trusting a folder applies to the next start of its sessions', async () => {
    const trustedFolders = new Set();
    const h = harness({ trusted: async (p) => trustedFolders.has(p) });
    addSession(h.engine, S1, { messages: turns(S1) });
    await openLive(h, S1);
    assert.deepEqual(h.engine.queries[0].options.settingSources, ['user']);
    trustedFolders.add(CWD);
    await h.host.closeSession(S1);
    await openLive(h, S1);
    assert.deepEqual(h.engine.queries[1].options.settingSources, ['user', 'project', 'local']);
    assert.equal(h.host.liveInfo(S1).trusted, true);
    await h.host.rewind(S1, { userMessageId: 'u-2', mode: 'conversation' });
    assert.deepEqual(h.engine.queries[2].options.settingSources, ['user', 'project', 'local']);
    assert.equal(h.host.liveInfo(S1).trusted, true);
  });

  test('a failing trust check counts as untrusted', async () => {
    const h = harness({ trusted: async () => { throw new Error('trust store locked'); } });
    const { sessionId, query } = await startLive(h);
    assert.deepEqual(query.options.settingSources, ['user']);
    assert.equal(h.host.liveInfo(sessionId).trusted, false);
  });
});

describe('EngineHost limits and version', () => {
  test('transcript windows are capped at 1000 messages and listings at 500', async () => {
    const h = harness();
    addSession(h.engine, S1, { messages: turns(S1) });
    await expectError(h.host.getTranscript(S1, { tail: 1001 }), 400, 'BAD_REQUEST');
    await expectError(h.host.getTranscript(S1, { before: 2, limit: 1001 }), 400, 'BAD_REQUEST');
    await expectError(h.host.listSessions({ cwd: CWD, limit: 501 }), 400, 'BAD_REQUEST');
    assert.equal((await h.host.getTranscript(S1, { tail: 1000 })).total, 4);
    assert.equal((await h.host.listSessions({ cwd: CWD, limit: 500 })).length, 1);
  });

  test('lastClaudeCodeVersion reports the version of the latest init message and outlives its session', async () => {
    const h = harness();
    assert.equal(h.host.lastClaudeCodeVersion(), null);
    const { sessionId } = await startLive(h);
    assert.equal(h.host.lastClaudeCodeVersion(), '2.1.295');
    await h.host.closeSession(sessionId).catch(() => undefined);
    assert.equal(h.host.lastClaudeCodeVersion(), '2.1.295');
  });
});

/** @param {string} sessionId @param {unknown} title */
function titleChange(sessionId, title) {
  return { type: 'system', subtype: 'session_title_changed', title, uuid: randomUUID(), session_id: sessionId };
}

describe('EngineHost session titles', () => {
  test('a title the runtime reports replaces the session title and is published to every client', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h, { cwd: CWD, title: 'Typed by the user' });
    query.emit(titleChange(sessionId, 'Fix the login redirect'));
    await flush();
    assert.equal(h.host.liveInfo(sessionId).title, 'Fix the login redirect');
    const states = ofType(h.events, 'session_state');
    assert.equal(states.filter((event) => event.data.live?.title === 'Fix the login redirect').length, 1);
    const announced = ofType(h.events, 'sessions_changed').filter((event) => event.data.reason === 'title');
    assert.deepEqual(announced.map((event) => event.data), [{ reason: 'title', sessionId }]);
    assert.equal((await h.host.getSession(sessionId)).live.title, 'Fix the login redirect');
    const listed = await h.host.listSessions({ cwd: CWD });
    assert.equal(listed[0].summary, 'Fix the login redirect');
  });

  test('an empty, blank or non-string title changes nothing and announces nothing', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h, { cwd: CWD, title: 'Typed by the user' });
    const before = h.events.length;
    for (const title of ['', '   \n ', undefined, 42, null]) query.emit(titleChange(sessionId, title));
    await flush();
    const later = h.events.slice(before);
    assert.equal(h.host.liveInfo(sessionId).title, 'Typed by the user');
    assert.equal(ofType(later, 'session_state').length, 0);
    assert.equal(ofType(later, 'sessions_changed').length, 0);
  });

  test('a reported title is trimmed and capped like a title the user typed', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h, { cwd: CWD });
    query.emit(titleChange(sessionId, `  ${'t'.repeat(250)}  `));
    await flush();
    assert.equal(h.host.liveInfo(sessionId).title, 't'.repeat(200));
  });

  test('a title reported for a resumed session is applied the same way', async () => {
    const h = harness();
    addSession(h.engine, S1, { messages: turns(S1) });
    const { query } = await openLive(h, S1);
    query.emit(titleChange(S1, 'Resumed title'));
    await flush();
    assert.equal(h.host.liveInfo(S1).title, 'Resumed title');
    const announced = ofType(h.events, 'sessions_changed').filter((event) => event.data.reason === 'title');
    assert.deepEqual(announced.map((event) => event.data), [{ reason: 'title', sessionId: S1 }]);
  });
});

const CLOSE_WAIT_MS_IN_TESTS = 3000;

/**
 * Workspace roots that stop admitting the test folder once `swapped.out` is set, the way a symlink swapped in after
 * the query started would.
 */
function swappableRoots() {
  const swapped = { out: false };
  const allowed = async (p) => !swapped.out && (p === CWD || p.startsWith(`${CWD}/`));
  return { swapped, allowed };
}

describe('EngineHost live sessions whose folder left the roots', () => {
  test('every live-only route closes the query and answers 404 SESSION_NOT_FOUND', async () => {
    const { swapped, allowed } = swappableRoots();
    const h = harness({ allowed });
    addSession(h.engine, S1, { messages: turns(S1) });
    const { query } = await openLive(h, S1);
    const before = query.calls.length;
    swapped.out = true;
    await expectError(h.host.interrupt(S1), 404, 'SESSION_NOT_FOUND');
    assert.deepEqual(query.calls.slice(before), [['close']]);
    assert.equal(h.host.liveInfo(S1), null);
    assert.deepEqual(ofType(h.events, 'session_state').at(-1).data, { sessionId: S1, live: null });
    await expectError(h.host.getContextUsage(S1), 404, 'SESSION_NOT_FOUND');
    await expectError(h.host.updateSettings(S1, { model: 'haiku' }), 404, 'SESSION_NOT_FOUND');
    await expectError(h.host.reload(S1, 'skills'), 404, 'SESSION_NOT_FOUND');
    await expectError(h.host.stopTask(S1, 'task-1'), 404, 'SESSION_NOT_FOUND');
    await expectError(h.host.mcpAction(S1, 'docs', { action: 'toggle', enabled: false }), 404, 'SESSION_NOT_FOUND');
    await expectError(h.host.respond(S1, 'req-1', { decision: 'allow' }), 404, 'SESSION_NOT_FOUND');
    await expectError(h.host.sendMessage(S1, { clientMessageId: randomUUID(), text: 'hello' }), 404,
      'SESSION_NOT_FOUND');
    await expectError(h.host.openSession(S1), 404, 'SESSION_NOT_FOUND');
    await expectError(h.host.closeSession(S1), 404, 'SESSION_NOT_FOUND');
    assert.equal(h.engine.queries.length, 1);
    assert.deepEqual(query.calls.slice(before), [['close']]);
  });

  test('while it closes the query publishes nothing more, and the call answers 404 once it has stopped', async () => {
    const { swapped, allowed } = swappableRoots();
    const h = harness({ allowed });
    addSession(h.engine, S1, { messages: turns(S1) });
    const { query } = await openLive(h, S1);
    query.ignoreClose = true;
    swapped.out = true;
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const outcome = h.host.interrupt(S1).then(() => null, (error) => error);
      await flush();
      const before = h.events.length;
      query.emit(assistantMessage(S1, 'a-late', 'still talking'));
      await flush();
      assert.deepEqual(ofType(h.events.slice(before), 'sdk'), []);
      mock.timers.tick(CLOSE_WAIT_MS_IN_TESTS);
      const error = await outcome;
      assert.ok(error instanceof AppError, `answered ${String(error)}`);
      assert.equal(error.status, 404);
      assert.equal(error.code, 'SESSION_NOT_FOUND');
    } finally {
      mock.timers.reset();
      query.finish();
    }
  });

  test('sweepIdle closes a running query whose folder left the roots, even when nothing touches it', async () => {
    const { swapped, allowed } = swappableRoots();
    const h = harness({ allowed });
    const { sessionId, query } = await startLive(h);
    await h.host.sendMessage(sessionId, { clientMessageId: randomUUID(), text: 'working' });
    assert.equal(h.host.liveInfo(sessionId).state, 'running');
    swapped.out = true;
    assert.equal(await h.host.sweepIdle(), 1);
    assert.equal(query.closed, true);
    assert.equal(h.host.liveInfo(sessionId), null);
    assert.deepEqual(ofType(h.events, 'session_state').at(-1).data, { sessionId, live: null });
    assert.equal(await h.host.sweepIdle(), 0);
  });

  test('a session that is not open answers 404 once its file lies outside the roots', async () => {
    const h = harness();
    addSession(h.engine, S1, { cwd: OUTSIDE, messages: turns(S1) });
    await expectError(h.host.interrupt(S1), 404, 'SESSION_NOT_FOUND');
    await expectError(h.host.getContextUsage(S1), 404, 'SESSION_NOT_FOUND');
    await expectError(h.host.respond(S1, 'req-1', { decision: 'allow' }), 404, 'SESSION_NOT_FOUND');
    await expectError(h.host.closeSession(S1), 404, 'SESSION_NOT_FOUND');
    assert.equal(h.engine.queries.length, 0);
  });

  test('routes on a session that does not exist keep their own answers', async () => {
    const h = harness();
    await h.host.interrupt(UNKNOWN);
    await h.host.closeSession(UNKNOWN);
    await expectError(h.host.getContextUsage(UNKNOWN), 409, 'SESSION_NOT_LIVE');
    await expectError(h.host.respond(UNKNOWN, 'req-1', { decision: 'allow' }), 404, 'REQUEST_NOT_FOUND');
    assert.equal(h.engine.queries.length, 0);
  });
});

describe('EngineHost bypassPermissions suggestions', () => {
  const bypass = { type: 'setMode', mode: 'bypassPermissions', destination: 'session' };

  test('a permission answer cannot select the mode change while bypass is off', async () => {
    const h = harness({ config: { allowBypass: false } });
    const { sessionId, query } = await startLive(h);
    const { pending } = callTool(query, 'Bash', { command: 'ls' }, { requestId: 'b-1', suggestions: [bypass] });
    await flush();
    await expectError(h.host.respond(sessionId, 'b-1', { decision: 'allow_always', suggestionIndexes: [0] }),
      400, 'BAD_REQUEST');
    assert.equal(ofType(h.events, 'request_resolved').length, 0);
    await h.host.respond(sessionId, 'b-1', { decision: 'allow' });
    assert.deepEqual(await pending, { behavior: 'allow', updatedInput: { command: 'ls' } });
  });

  test('with bypass enabled the mode change is persisted through the permission result', async () => {
    const h = harness({ config: { allowBypass: true } });
    const { sessionId, query } = await startLive(h);
    const { pending } = callTool(query, 'Bash', { command: 'ls' }, { requestId: 'b-2', suggestions: [bypass] });
    await flush();
    await h.host.respond(sessionId, 'b-2', { decision: 'allow_always', suggestionIndexes: [0] });
    assert.deepEqual(await pending, {
      behavior: 'allow', updatedInput: { command: 'ls' }, updatedPermissions: [bypass],
    });
  });
});

/**
 * A system/background_tasks_changed message: the whole set of live tasks after a change.
 * @param {string} sessionId
 * @param {Array<Record<string, unknown>>} tasks
 */
function backgroundChange(sessionId, tasks) {
  return { type: 'system', subtype: 'background_tasks_changed', tasks, uuid: randomUUID(), session_id: sessionId };
}

/**
 * A result message of a finished turn. Fields that a test does not set are the ordinary ones of a success.
 * @param {string} sessionId
 * @param {Record<string, unknown>} [overrides]
 */
function resultMessage(sessionId, overrides = {}) {
  return {
    type: 'result',
    subtype: 'success',
    uuid: randomUUID(),
    session_id: sessionId,
    is_error: false,
    result: 'Done.',
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    total_cost_usd: 0,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    stop_reason: 'end_turn',
    ...overrides,
  };
}

/** @param {{fastModeState: string|null, fastModeDisabledReason: string|null}} info */
function pickFastMode(info) {
  return { state: info.fastModeState, reason: info.fastModeDisabledReason };
}

const RUNNING_TASK = { task_id: 'bash-1', task_type: 'local_bash', description: 'npm run build' };

describe('EngineHost settings overlay and fast mode', () => {
  test('thinking summaries are requested with the display flag unless the loaded settings turn them off', async () => {
    const off = harness({ settingsOnDisk: { showThinkingSummaries: false } });
    const kept = await startLive(off);
    assert.equal('extraArgs' in kept.query.options, false);
    assert.equal('settings' in kept.query.options, false);
    assert.deepEqual(off.engine.settingsLookups, [{ cwd: CWD, settingSources: ['user', 'project', 'local'] }]);

    // A non-interactive runtime ignores the setting itself, so a user who asked for summaries gets the flag too.
    const on = harness({ settingsOnDisk: { showThinkingSummaries: true } });
    assert.deepEqual((await startLive(on)).query.options.extraArgs, { 'thinking-display': 'summarized' });

    const open = harness();
    const added = await startLive(open);
    assert.deepEqual(added.query.options.extraArgs, { 'thinking-display': 'summarized' });
    assert.equal('settings' in added.query.options, false);
    assert.equal('thinking' in added.query.options, false);
  });

  test('CAW_CHROME adds the chrome flag to the extra arguments, next to the thinking display flag', async () => {
    const quiet = harness({ config: { chrome: true }, settingsOnDisk: { showThinkingSummaries: false } });
    assert.deepEqual((await startLive(quiet)).query.options.extraArgs, { chrome: null });
    const both = await startLive(harness({ config: { chrome: true } }));
    assert.deepEqual(both.query.options.extraArgs, { 'thinking-display': 'summarized', chrome: null });
  });

  test('an untrusted folder reads and loads only the user settings', async () => {
    const h = harness({ trusted: async () => false, settingsOnDisk: { fastMode: true } });
    const { query } = await startLive(h);
    assert.deepEqual(h.engine.settingsLookups, [{ cwd: CWD, settingSources: ['user'] }]);
    assert.deepEqual(query.options.settingSources, ['user']);
    assert.deepEqual(query.options.extraArgs, { 'thinking-display': 'summarized' });
    assert.equal('settings' in query.options, false);
  });

  test('a failed lookup still requests thinking summaries and logs the failure without its text', async () => {
    const h = harness();
    h.engine.resolveError = new Error('cannot read /home/alice/.claude/settings.json');
    const { query } = await startLive(h);
    assert.deepEqual(query.options.extraArgs, { 'thinking-display': 'summarized' });
    const failure = h.logs.find((entry) => entry.msg === 'settings lookup failed; thinking summaries requested');
    assert.equal(failure?.level, 'debug');
    assert.equal(JSON.stringify(h.logs).includes('alice'), false);
  });

  test('a lookup that does not answer within two seconds is abandoned and summaries are requested', async (t) => {
    mock.timers.enable({ apis: ['setTimeout'] });
    t.after(() => mock.timers.reset());
    const h = harness();
    h.engine.resolveHangs = true;
    const started = h.host.createSession({ cwd: CWD });
    await flush();
    mock.timers.tick(1999);
    await flush();
    assert.equal(h.engine.queries.length, 0);
    mock.timers.tick(1);
    await started;
    assert.deepEqual(h.engine.queries[0].options.extraArgs, { 'thinking-display': 'summarized' });
  });

  test('a remembered fast mode rides the flag overlay of the next start, and null leaves it to the settings',
    async () => {
      const h = harness();
      addSession(h.engine, S1);
      await h.host.updateSettings(S1, { fastMode: true });
      const first = await openLive(h, S1);
      assert.deepEqual(first.query.options.settings, { fastMode: true });
      await h.host.closeSession(S1);
      await h.host.updateSettings(S1, { fastMode: false });
      assert.deepEqual((await openLive(h, S1)).query.options.settings, { fastMode: false });
      await h.host.closeSession(S1);
      await h.host.updateSettings(S1, { fastMode: null });
      const third = await openLive(h, S1);
      assert.equal('settings' in third.query.options, false);
    });

  test('the fast mode that init and every result report replaces the live state', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h, { cwd: CWD }, {
      fast_mode_state: 'off',
      fast_mode_disabled_reason: 'sdk_opt_in_required',
    });
    assert.deepEqual(pickFastMode(h.host.liveInfo(sessionId)), { state: 'off', reason: 'sdk_opt_in_required' });
    query.emit(resultMessage(sessionId, { fast_mode_state: 'on' }));
    await flush();
    assert.deepEqual(pickFastMode(h.host.liveInfo(sessionId)), { state: 'on', reason: null });
    query.emit(resultMessage(sessionId, { fast_mode_state: 'off', fast_mode_disabled_reason: 'model_not_allowed' }));
    await flush();
    assert.deepEqual(pickFastMode(h.host.liveInfo(sessionId)), { state: 'off', reason: 'model_not_allowed' });
    query.emit(resultMessage(sessionId));
    await flush();
    assert.deepEqual(pickFastMode(h.host.liveInfo(sessionId)), { state: 'off', reason: 'model_not_allowed' });
  });

  test('fastMode reaches the live query as a flag setting, and an invalid value is refused first', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    const { live: on } = await h.host.updateSettings(sessionId, { fastMode: true });
    assert.equal(on.fastMode, true);
    assert.deepEqual(query.calls.at(-1), ['applyFlagSettings', { fastMode: true }]);
    const { live: off } = await h.host.updateSettings(sessionId, { fastMode: null });
    assert.equal(off.fastMode, null);
    assert.deepEqual(query.calls.at(-1), ['applyFlagSettings', { fastMode: null }]);
    await expectError(h.host.updateSettings(sessionId, { fastMode: 'yes' }), 422, 'INVALID_ARGUMENT');
    assert.equal(query.calls.filter((call) => call[0] === 'applyFlagSettings').length, 2);
  });
});

describe('EngineHost background tasks', () => {
  test('background_tasks_changed sets the live count and leaves ambient tasks out', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    query.emit(backgroundChange(sessionId, [RUNNING_TASK, { ...RUNNING_TASK, task_id: 'agent-1', ambient: true }]));
    await flush();
    assert.equal(h.host.liveInfo(sessionId).backgroundTasks, 1);
    query.emit(backgroundChange(sessionId, []));
    await flush();
    assert.equal(h.host.liveInfo(sessionId).backgroundTasks, 0);
  });

  test('a background_tasks_changed message without a task list changes nothing and keeps the session running',
    async () => {
      const h = harness();
      const { sessionId, query } = await startLive(h);
      query.emit(backgroundChange(sessionId, [RUNNING_TASK]));
      await flush();
      query.emit({ type: 'system', subtype: 'background_tasks_changed', uuid: randomUUID(), session_id: sessionId });
      query.emit(backgroundChange(sessionId, [RUNNING_TASK, null, 'shell']));
      await flush();
      assert.equal(h.host.liveInfo(sessionId).backgroundTasks, 1);
      assert.notEqual(h.host.liveInfo(sessionId).state, 'error');
    });

  test('the idle sweep and making room leave a session with background tasks alone', async () => {
    const h = harness({ config: { maxLiveSessions: 1, idleTimeoutMs: MINUTE } });
    const { sessionId, query } = await startLive(h);
    query.emit(backgroundChange(sessionId, [RUNNING_TASK]));
    await flush();
    const later = h.time.now + 10 * MINUTE;
    assert.equal(await h.host.sweepIdle(later), 0);
    await expectError(h.host.createSession({ cwd: CWD }), 429, 'TOO_MANY_SESSIONS');
    assert.equal(query.closed, false);
    query.emit(backgroundChange(sessionId, []));
    await flush();
    assert.equal(await h.host.sweepIdle(later), 1);
    assert.equal(h.host.liveInfo(sessionId), null);
  });

  test('a query that ends takes its count with it, and the next start begins at zero', async () => {
    const h = harness();
    addSession(h.engine, S1);
    const { query } = await openLive(h, S1);
    query.emit(backgroundChange(S1, [RUNNING_TASK]));
    await flush();
    assert.equal(h.host.liveInfo(S1).backgroundTasks, 1);
    query.finish();
    await flush();
    assert.equal(h.host.liveInfo(S1), null);
    await openLive(h, S1);
    assert.equal(h.host.liveInfo(S1).backgroundTasks, 0);
  });

  test('backgroundTasks reports whether a task moved, with or without a tool use id', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    assert.deepEqual(await h.host.backgroundTasks(sessionId, 'toolu_mock_1'), { backgrounded: true });
    assert.deepEqual(query.calls.at(-1), ['backgroundTasks', 'toolu_mock_1']);
    query.values.backgroundTasks = false;
    assert.deepEqual(await h.host.backgroundTasks(sessionId, 'toolu_done'), { backgrounded: false });
    assert.deepEqual(await h.host.backgroundTasks(sessionId), { backgrounded: false });
    assert.deepEqual(query.calls.at(-1), ['backgroundTasks', undefined]);
  });

  test('backgroundTasks answers 501 before the query is touched when the runtime disabled tasks', async () => {
    const h = harness({ config: { backgroundTasksDisabled: true } });
    const { sessionId, query } = await startLive(h);
    await expectError(h.host.backgroundTasks(sessionId, 'toolu_mock_1'), 501, 'FEATURE_DISABLED');
    assert.equal(query.calls.some((call) => call[0] === 'backgroundTasks'), false);
  });

  test('backgroundTasks needs a live session, refuses a locked one and reports failures without the engine text',
    async () => {
      const h = harness();
      addSession(h.engine, S1);
      await expectError(h.host.backgroundTasks(S1, 'toolu_mock_1'), 409, 'SESSION_NOT_LIVE');
      await openLive(h, S1);
      const release = await h.host.lockForTerminal(S1);
      await expectError(h.host.backgroundTasks(S1, 'toolu_mock_1'), 409, 'SESSION_LOCKED');
      release();
      const { query } = await openLive(h, S1);
      query.failures.set('backgroundTasks', new Error('socket /run/caw/secret'));
      await assert.rejects(h.host.backgroundTasks(S1, 'toolu_mock_1'), (error) => error.status === 502
        && error.code === 'ENGINE_ERROR' && error.message === 'The tasks could not be moved to the background.');
    });
});

describe('EngineHost output style', () => {
  test('setOutputStyle writes the local setting and keeps cached capabilities in step', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    await h.host.getCapabilities(sessionId);
    const answer = await h.host.setOutputStyle(sessionId, '  explanatory ');
    assert.deepEqual(answer, { outputStyle: 'explanatory', availableOutputStyles: ['default', 'explanatory'] });
    assert.deepEqual(query.calls.at(-1), ['updateSettings', 'localSettings', { outputStyle: 'explanatory' }]);
    assert.equal((await h.host.getCapabilities(sessionId)).outputStyle, 'explanatory');
    assert.equal(query.calls.filter((call) => call[0] === 'initializationResult').length, 1);
  });

  test('an untrusted folder answers 409 before any call, and styles are validated before the write', async () => {
    const untrusted = harness({ trusted: async () => false });
    const closed = await startLive(untrusted);
    await expectError(untrusted.host.setOutputStyle(closed.sessionId, 'explanatory'), 409, 'CONFLICT');
    assert.equal(closed.query.calls.some((call) => call[0] === 'updateSettings'), false);

    const h = harness();
    const { sessionId, query } = await startLive(h);
    await expectError(h.host.setOutputStyle(sessionId, '   '), 400, 'BAD_REQUEST');
    await expectError(h.host.setOutputStyle(sessionId, 'x'.repeat(101)), 400, 'BAD_REQUEST');
    await expectError(h.host.setOutputStyle(sessionId, 'learning'), 422, 'INVALID_ARGUMENT');
    assert.equal(query.calls.some((call) => call[0] === 'updateSettings'), false);
  });

  test('a closed session is not live, and a failed write is reported without the engine text', async () => {
    const h = harness();
    addSession(h.engine, S1);
    await expectError(h.host.setOutputStyle(S1, 'explanatory'), 409, 'SESSION_NOT_LIVE');
    const { sessionId, query } = await startLive(h);
    query.failures.set('updateSettings', new Error('EACCES /home/alice/project/.claude'));
    await assert.rejects(h.host.setOutputStyle(sessionId, 'explanatory'), (error) => error.status === 502
      && error.message === 'The output style could not be changed.');
    assert.equal((await h.host.getCapabilities(sessionId)).outputStyle, 'default');
  });

  test('when the runtime does not answer for its styles, the change is an engine error, not a bad style', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    query.failures.set('initializationResult', new Error('timeout'));
    await expectError(h.host.setOutputStyle(sessionId, 'explanatory'), 502, 'ENGINE_ERROR');
    assert.equal(query.calls.some((call) => call[0] === 'updateSettings'), false);
  });

  test('style names a client could not select are left out of the lists', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    const long = 'x'.repeat(101);
    query.values.initializationResult = { ...query.values.initializationResult,
      available_output_styles: ['default', long, '', '  ', 7, 'Concise'] };
    assert.deepEqual((await h.host.getCapabilities(sessionId)).availableOutputStyles, ['default', 'Concise']);
    query.values.reloadOutputStyles = { available_output_styles: ['default', long, 'Learning'] };
    assert.deepEqual(await h.host.reload(sessionId, 'output-styles'),
      { ok: true, availableOutputStyles: ['default', 'Learning'] });
  });
});

describe('EngineHost plugin and output style reloads', () => {
  test('a plugins reload is held when the runtime reports cache impact, and the cached capabilities stay', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    await h.host.getCapabilities(sessionId);
    query.values.reloadPlugins = {
      held: true,
      cache_impact: { mcp_servers_added: ['plugin:docs:search'], mcp_servers_removed: [], lsp_tool_change: 'may-add' },
    };
    assert.deepEqual(await h.host.reload(sessionId, 'plugins'), {
      ok: false,
      held: true,
      cacheImpact: { mcpServersAdded: ['plugin:docs:search'], mcpServersRemoved: [], lspToolChange: 'may-add' },
    });
    assert.deepEqual(query.calls.at(-1), ['reloadPlugins', { holdOnCacheImpact: true }]);
    await h.host.getCapabilities(sessionId);
    assert.equal(query.calls.filter((call) => call[0] === 'initializationResult').length, 1);
  });

  test('force applies the plugins reload, and a reload that is not held is ok and drops the cache', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    await h.host.getCapabilities(sessionId);
    query.values.reloadPlugins = { held: false };
    assert.deepEqual(await h.host.reload(sessionId, 'plugins'), { ok: true });
    assert.deepEqual(query.calls.at(-1), ['reloadPlugins', { holdOnCacheImpact: true }]);
    assert.deepEqual(await h.host.reload(sessionId, 'plugins', { force: true }), { ok: true });
    assert.deepEqual(query.calls.at(-1), ['reloadPlugins', undefined]);
    await h.host.getCapabilities(sessionId);
    assert.equal(query.calls.filter((call) => call[0] === 'initializationResult').length, 2);
  });

  test('the output styles reload returns the refreshed list, and the remembered styles follow it', async () => {
    const h = harness();
    addSession(h.engine, S1);
    const { query } = await openLive(h, S1);
    await h.host.getCapabilities(S1);
    query.values.reloadOutputStyles = { available_output_styles: ['default', 'explanatory', 'learning'] };
    assert.deepEqual(await h.host.reload(S1, 'output-styles'), {
      ok: true,
      availableOutputStyles: ['default', 'explanatory', 'learning'],
    });
    await h.host.closeSession(S1);
    const remembered = await h.host.getCapabilities(S1);
    assert.equal(remembered.stale, true);
    assert.deepEqual(remembered.availableOutputStyles, ['default', 'explanatory', 'learning']);
  });

  test('force is valid for plugins only, and a failed reload is reported without the engine text', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    await expectError(h.host.reload(sessionId, 'skills', { force: true }), 400, 'BAD_REQUEST');
    await expectError(h.host.reload(sessionId, 'output-styles', { force: false }), 400, 'BAD_REQUEST');
    await expectError(h.host.reload(sessionId, 'plugins', { force: 'yes' }), 400, 'BAD_REQUEST');
    assert.equal(query.calls.some((call) => call[0].startsWith('reload')), false);
    query.failures.set('reloadPlugins', new Error('/home/alice/plugins secret'));
    await assert.rejects(h.host.reload(sessionId, 'plugins'), (error) => error.status === 502
      && error.message === 'The session could not be reloaded.');
  });
});

/** Resolves a folder inside the harness roots to itself, and refuses every other folder. */
async function folderOf(p) {
  if (!(await INSIDE_ROOTS(p))) throw new Error('outside the roots');
  return p;
}

/** A new folder under the working folder, so that tests never share the files they write. */
function newFolder(name) {
  return fs.mkdtempSync(path.join(CWD, `${name}-`));
}

describe('EngineHost agent, folders, fallback model and browser tools', () => {
  test('the agent is applied through the flag settings, kept for the next start and cleared by null', async () => {
    const h = harness();
    addSession(h.engine, S1);
    const { query } = await openLive(h, S1);
    const { live } = await h.host.updateSettings(S1, { agent: 'reviewer' });
    assert.deepEqual(query.calls.at(-1), ['applyFlagSettings', { agent: 'reviewer' }]);
    assert.equal(live.agent, 'reviewer');
    await h.host.closeSession(S1);
    const reopened = await openLive(h, S1);
    assert.equal(reopened.query.options.agent, 'reviewer');
    await h.host.updateSettings(S1, { agent: null });
    assert.deepEqual(reopened.query.calls.at(-1), ['applyFlagSettings', { agent: null }]);
    assert.equal(h.host.liveInfo(S1).agent, null);
    await expectError(h.host.updateSettings(S1, { agent: '' }), 422, 'INVALID_ARGUMENT');
  });

  test('an agent the runtime refuses is a 422 with the first line of its answer only', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    query.failures.set('applyFlagSettings', new Error('Unknown agent: nobody\n    at /home/claude/secret.js:1'));
    await assert.rejects(h.host.updateSettings(sessionId, { agent: 'nobody' }), (error) => {
      assert.equal(error.status, 422);
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.equal(error.message, 'Unknown agent: nobody');
      return true;
    });
    assert.equal(h.host.liveInfo(sessionId).agent, null);
  });

  test('additional folders are resolved, deduplicated and left out when they are the working folder', async () => {
    const extra = path.join(CWD, 'extra');
    const h = harness({ resolveDir: folderOf });
    const info = await h.host.createSession({ cwd: CWD, additionalDirectories: [extra, extra, CWD] });
    assert.deepEqual(h.engine.queries[0].options.additionalDirectories, [extra]);
    assert.deepEqual(info.additionalDirectories, [extra]);
  });

  test('additional folders outside the roots, relative, not text or too many are refused before any query starts',
    async () => {
      const h = harness({ resolveDir: folderOf });
      await expectError(h.host.createSession({ cwd: CWD, additionalDirectories: [OUTSIDE] }), 422, 'PATH_NOT_ALLOWED');
      await expectError(h.host.createSession({ cwd: CWD, additionalDirectories: ['relative/dir'] }), 422,
        'PATH_NOT_ALLOWED');
      await expectError(h.host.createSession({ cwd: CWD, additionalDirectories: 'extra' }), 400, 'BAD_REQUEST');
      const many = Array.from({ length: 21 }, (_, i) => path.join(CWD, `d${i}`));
      await expectError(h.host.createSession({ cwd: CWD, additionalDirectories: many }), 422, 'INVALID_ARGUMENT');
      assert.equal(h.engine.queries.length, 0);
    });

  test('a change of the additional folders restarts a live query between turns and keeps the session id', async () => {
    const extra = path.join(CWD, 'extra');
    const h = harness({ resolveDir: folderOf });
    const { sessionId, query } = await startLive(h);
    const { live, restartRequired } = await h.host.updateSettings(sessionId, { additionalDirectories: [extra] });
    assert.equal(restartRequired, false);
    assert.equal(query.closed, true);
    assert.equal(h.engine.queries.length, 2);
    const restarted = h.engine.queries[1];
    assert.equal(restarted.options.resume, sessionId);
    assert.deepEqual(restarted.options.additionalDirectories, [extra]);
    assert.deepEqual(live.additionalDirectories, [extra]);
    assert.deepEqual(h.host.liveInfo(sessionId).additionalDirectories, [extra]);
  });

  test('a change of the additional folders is refused with 409 while a turn runs', async () => {
    const h = harness({ resolveDir: folderOf });
    const { sessionId, query } = await startLive(h);
    query.emit({
      type: 'system', subtype: 'session_state_changed', state: 'running', uuid: randomUUID(), session_id: sessionId,
    });
    await flush();
    await expectError(h.host.updateSettings(sessionId, { additionalDirectories: [path.join(CWD, 'extra')] }), 409,
      'CONFLICT');
    assert.equal(h.engine.queries.length, 1);
    assert.equal(query.closed, false);
  });

  test('a changed fallback model is stored, reported as restartRequired and applied at the next start', async () => {
    const h = harness();
    addSession(h.engine, S1);
    const { query } = await openLive(h, S1);
    const first = await h.host.updateSettings(S1, { fallbackModel: 'haiku' });
    assert.equal(first.restartRequired, true);
    assert.equal(first.live.fallbackModel, null);
    assert.equal(query.calls.filter((call) => call[0] !== 'close').length, 0);
    const cleared = await h.host.updateSettings(S1, { fallbackModel: null });
    assert.equal(cleared.restartRequired, false);
    await h.host.updateSettings(S1, { fallbackModel: 'haiku' });
    await h.host.closeSession(S1);
    const reopened = await openLive(h, S1);
    assert.equal(reopened.query.options.fallbackModel, 'haiku');
    assert.equal(h.host.liveInfo(S1).fallbackModel, 'haiku');
    await expectError(h.host.updateSettings(S1, { fallbackModel: 'two words' }), 422, 'INVALID_ARGUMENT');
  });

  test('browser tools are refused with 501 without CAW_BROWSER_MCP_COMMAND, whatever the value', async () => {
    const h = harness();
    await expectError(h.host.createSession({ cwd: CWD, browserTools: true }), 501, 'FEATURE_DISABLED');
    await expectError(h.host.createSession({ cwd: CWD, browserTools: false }), 501, 'FEATURE_DISABLED');
    await expectError(h.host.createSession({ cwd: CWD, browserTools: 'yes' }), 400, 'BAD_REQUEST');
    assert.equal(h.engine.queries.length, 0);
  });

  test('browser tools attach through setMcpServers and start with the operator server', async () => {
    const operator = { browser: { type: 'stdio', command: '/usr/bin/browser-mcp', args: ['--headless'] } };
    const h = harness({ config: { browserMcpCommand: ['/usr/bin/browser-mcp', '--headless'] } });
    const info = await h.host.createSession({ cwd: CWD, browserTools: true });
    const { query } = { query: h.engine.queries[0] };
    assert.deepEqual(query.options.mcpServers, operator);
    assert.equal(info.browserTools, true);
    query.emit(initMessage(info.sessionId));
    await flush();
    const off = await h.host.updateSettings(info.sessionId, { browserTools: false });
    assert.deepEqual(query.calls.at(-1), ['setMcpServers', {}]);
    assert.equal(off.live.browserTools, false);
    const on = await h.host.updateSettings(info.sessionId, { browserTools: true });
    assert.deepEqual(query.calls.at(-1), ['setMcpServers', operator]);
    assert.equal(on.live.browserTools, true);
    await expectError(h.host.updateSettings(info.sessionId, { browserTools: 1 }), 400, 'BAD_REQUEST');
  });

  test('a session that does not start with browser tools has no MCP servers option', async () => {
    const h = harness({ config: { browserMcpCommand: ['/usr/bin/browser-mcp'] } });
    await h.host.createSession({ cwd: CWD });
    assert.equal('mcpServers' in h.engine.queries[0].options, false);
  });
});

describe('EngineHost interrupts and queued messages', () => {
  test('interrupt with cancelQueued drops the queued messages and publishes each one as cancelled', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
    query.values.interrupt = { still_queued: [c], cancelled: [a, b] };
    const outcome = await h.host.interrupt(sessionId, { cancelQueued: true });
    assert.deepEqual(query.calls.at(-1), ['interrupt', { cancelQueued: true }]);
    assert.deepEqual(outcome, { stillQueued: [c], cancelled: [a, b] });
    assert.deepEqual(ofType(h.events, 'message_cancelled').map((event) => event.data), [
      { sessionId, clientMessageId: a },
      { sessionId, clientMessageId: b },
    ]);
  });

  test('interrupt without a receipt answers empty lists, and cancelQueued must be a boolean', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    assert.deepEqual(await h.host.interrupt(sessionId), { stillQueued: [], cancelled: [] });
    assert.deepEqual(query.calls.at(-1), ['interrupt']);
    await expectError(h.host.interrupt(sessionId, { cancelQueued: 'yes' }), 400, 'BAD_REQUEST');
    assert.equal(ofType(h.events, 'message_cancelled').length, 0);
  });

  test('cancelQueued removes one queued message and publishes it only when the runtime cancelled it', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    const queued = randomUUID();
    query.values.cancelAsyncMessage = true;
    assert.deepEqual(await h.host.cancelQueued(sessionId, queued), { cancelled: true });
    assert.deepEqual(query.calls.at(-1), ['cancelAsyncMessage', queued]);
    assert.deepEqual(ofType(h.events, 'message_cancelled').at(-1).data, { sessionId, clientMessageId: queued });
    query.values.cancelAsyncMessage = false;
    assert.deepEqual(await h.host.cancelQueued(sessionId, randomUUID()), { cancelled: false });
    assert.equal(ofType(h.events, 'message_cancelled').length, 1);
  });

  test('cancelQueued validates the id, needs a live session and answers 501 without the runtime control', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    await expectError(h.host.cancelQueued(sessionId, 'not-a-uuid'), 400, 'BAD_REQUEST');
    await expectError(h.host.cancelQueued(UNKNOWN, randomUUID()), 409, 'SESSION_NOT_LIVE');
    query.cancelAsyncMessage = undefined;
    await expectError(h.host.cancelQueued(sessionId, randomUUID()), 501, 'FEATURE_UNAVAILABLE');
    assert.equal(query.calls.some((call) => call[0] === 'cancelAsyncMessage'), false);
  });

  test('a failed cancel of a queued message is a 502 without the engine text', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    query.failures.set('cancelAsyncMessage', new Error('internal /home/claude/.claude/session'));
    await assert.rejects(h.host.cancelQueued(sessionId, randomUUID()), (error) => error.status === 502
      && error.code === 'ENGINE_ERROR' && error.message === 'The queued message could not be cancelled.');
  });
});

describe('EngineHost MCP authentication and permission modes', () => {
  test('an MCP permission-mode override is set through the runtime and its warning is passed on', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    query.values.setMcpPermissionModeOverride = { warning: 'No connected server is named docs.' };
    const answer = await h.host.mcpAction(sessionId, 'docs', { action: 'permission-mode', mode: 'auto' });
    assert.deepEqual(query.calls.at(-2), ['setMcpPermissionModeOverride', 'docs', 'auto']);
    assert.deepEqual(answer, { mcpServers: DEFAULT_MCP, warning: 'No connected server is named docs.' });
    query.values.setMcpPermissionModeOverride = {};
    assert.deepEqual(await h.host.mcpAction(sessionId, 'docs', { action: 'permission-mode', mode: null }), {
      mcpServers: DEFAULT_MCP,
    });
    assert.deepEqual(query.calls.at(-2), ['setMcpPermissionModeOverride', 'docs', null]);
    await expectError(h.host.mcpAction(sessionId, 'docs', { action: 'permission-mode', mode: 'plan' }), 422,
      'INVALID_ARGUMENT');
  });

  test('an MCP sign-in starts with the runtime and returns only the fields the browser needs', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    query.values.mcpAuthenticate = {
      authUrl: 'https://auth.example.com/authorize?client=x',
      requiresUserAction: true,
      callbackExpected: true,
      redirectScheme: 'localhost',
      state: 'secret-state',
      callbackPort: 53123,
    };
    const answer = await h.host.mcpAuth(sessionId, 'docs', { action: 'start' });
    assert.deepEqual(query.calls.at(-1), ['mcpAuthenticate', 'docs']);
    assert.deepEqual(answer, {
      authUrl: 'https://auth.example.com/authorize?client=x',
      requiresUserAction: true,
      callbackExpected: true,
      redirectScheme: 'localhost',
      callbackPort: 53123,
    });
    query.values.mcpAuthenticate = { requiresUserAction: false, callbackExpected: false };
    assert.deepEqual(await h.host.mcpAuth(sessionId, 'docs', { action: 'start' }), {
      authUrl: null,
      requiresUserAction: false,
      callbackExpected: false,
      redirectScheme: null,
      callbackPort: null,
    });
  });

  test('an MCP sign-in address that is not http or https is a 502 and is not returned', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    query.values.mcpAuthenticate = { authUrl: 'javascript:alert(1)', requiresUserAction: true, callbackExpected: true };
    await assert.rejects(h.host.mcpAuth(sessionId, 'docs', { action: 'start' }), (error) => {
      assert.equal(error.status, 502);
      assert.equal(error.code, 'ENGINE_ERROR');
      assert.equal(error.message, 'The sign-in address of the server is not usable.');
      return true;
    });
  });

  test('the callback address is submitted, clear forgets the credentials, and bad actions are refused first',
    async () => {
      const h = harness();
      const { sessionId, query } = await startLive(h);
      const callback = 'http://localhost:53123/callback?code=abc&state=xyz';
      assert.deepEqual(await h.host.mcpAuth(sessionId, 'docs', { action: 'callback', callbackUrl: callback }), {
        ok: true,
      });
      assert.deepEqual(query.calls.at(-1), ['mcpSubmitOAuthCallbackUrl', 'docs', callback]);
      assert.deepEqual(await h.host.mcpAuth(sessionId, 'docs', { action: 'clear' }), { ok: true });
      assert.deepEqual(query.calls.at(-1), ['mcpClearAuth', 'docs']);
      await expectError(h.host.mcpAuth(sessionId, 'docs', { action: 'callback', callbackUrl: 'ftp://example.com/x' }),
        400, 'BAD_REQUEST');
      await expectError(h.host.mcpAuth(sessionId, 'docs', { action: 'callback' }), 400, 'BAD_REQUEST');
      await expectError(h.host.mcpAuth(sessionId, 'docs', { action: 'refresh' }), 422, 'INVALID_ARGUMENT');
      assert.equal(query.calls.filter((call) => call[0] === 'mcpSubmitOAuthCallbackUrl').length, 1);
      await expectError(h.host.mcpAuth(UNKNOWN, 'docs', { action: 'clear' }), 409, 'SESSION_NOT_LIVE');
    });

  test('an MCP authentication failure answers 502 with the first line only, and a missing method is 501', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    query.failures.set('mcpAuthenticate', new Error('Server type stdio does not support OAuth\nat /internal/path'));
    await assert.rejects(h.host.mcpAuth(sessionId, 'docs', { action: 'start' }), (error) => error.status === 502
      && error.code === 'ENGINE_ERROR' && error.message === 'Server type stdio does not support OAuth');
    query.mcpClearAuth = undefined;
    await expectError(h.host.mcpAuth(sessionId, 'docs', { action: 'clear' }), 501, 'FEATURE_UNAVAILABLE');
  });
});

describe('EngineHost runtime views, memory, export, task output and side questions', () => {
  test('the runtime views list only the methods the query offers', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    const { views } = await h.host.runtimeViews(sessionId);
    for (const view of ['status', 'settings', 'usage', 'init', 'skills']) assert.ok(views.includes(view), view);
    query.getSkillsDialog = undefined;
    assert.equal((await h.host.runtimeViews(sessionId)).views.includes('skills'), false);
    await expectError(h.host.runtimeViews(UNKNOWN), 409, 'SESSION_NOT_LIVE');
  });

  test('a runtime view answers the runtime data, redacts the settings environment and passes the usage arguments',
    async () => {
      const h = harness();
      const { sessionId, query } = await startLive(h);
      query.values.getStatus = { sections: [{ title: 'Environment', rows: [] }] };
      query.values.getSettings = {
        effective: { model: 'sonnet', env: { ANTHROPIC_API_KEY: 'sk-live', HOME_DIR: '/home/u' } },
        sources: [],
        applied: null,
      };
      const status = await h.host.runtimeView(sessionId, 'status');
      assert.equal(status.view, 'status');
      assert.deepEqual(status.data, { sections: [{ title: 'Environment', rows: [] }] });
      assert.equal(status.fetchedAt, h.time.now);
      const settings = await h.host.runtimeView(sessionId, 'settings');
      assert.deepEqual(settings.data.effective, {
        model: 'sonnet',
        env: { ANTHROPIC_API_KEY: '[redacted]', HOME_DIR: '[redacted]' },
      });
      assert.equal(settings.data.applied, null);
      await h.host.runtimeView(sessionId, 'usage');
      assert.deepEqual(query.calls.at(-1), ['usage', { skipBehaviors: true }]);
    });

  test('an unknown runtime view is 404, a view the query lacks is 501, and a closed session is 409', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    await expectError(h.host.runtimeView(sessionId, 'secrets'), 404, 'NOT_FOUND');
    await expectError(h.host.runtimeView(sessionId, '__proto__'), 404, 'NOT_FOUND');
    query.getPlan = undefined;
    await expectError(h.host.runtimeView(sessionId, 'plan'), 501, 'FEATURE_UNAVAILABLE');
    await expectError(h.host.runtimeView(UNKNOWN, 'status'), 409, 'SESSION_NOT_LIVE');
  });

  test('memory files come with their content and editable flag, and an entry without a path is dropped', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    const folder = newFolder('memory-read');
    const project = path.join(folder, 'CLAUDE.md');
    const user = path.join(HOME, '.claude', 'CLAUDE.md');
    fs.writeFileSync(project, '# Project\n');
    query.values.getMemoryDialog = {
      files: [
        { kind: 'project', path: project, label: 'Project instructions', description: 'd', exists: true },
        { kind: 'user', path: user, label: 'User instructions', description: 'd', exists: false },
        { kind: 'broken', exists: true },
      ],
      folders: ['x'],
      auto_memory: { enabled: false },
      auto_dream: null,
    };
    query.values.readFile = (filePath) => (filePath === project
      ? { contents: '# Project\n', absPath: project, truncated: false }
      : null);
    const memory = await h.host.getMemory(sessionId);
    const rows = memory.files.map((file) => [file.kind, file.exists, file.content, file.truncated, file.editable]);
    assert.deepEqual(rows, [
      ['project', true, '# Project\n', false, true],
      ['user', false, null, false, true],
    ]);
    assert.deepEqual(memory.folders, ['x']);
    assert.deepEqual(memory.autoMemory, { enabled: false });
    assert.equal(memory.autoDream, null);
    assert.deepEqual(query.calls.filter((call) => call[0] === 'readFile').map((call) => call[1]), [project, user]);
    assert.deepEqual(query.calls.filter((call) => call[0] === 'readFile')[0][2], { maxBytes: 262144 });
  });

  test('a memory file is saved only when the runtime lists it, it is editable and it is at most 256 KiB', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    const folder = newFolder('memory-write');
    const project = path.join(folder, 'CLAUDE.md');
    const notes = path.join(folder, 'notes.md');
    query.values.getMemoryDialog = {
      files: [
        { kind: 'project', path: project, label: 'Project', description: '', exists: false },
        { kind: 'notes', path: notes, label: 'Notes', description: '', exists: false },
      ],
    };
    assert.deepEqual(await h.host.writeMemory(sessionId, project, '# Saved\n'), { bytes: 8 });
    assert.equal(fs.readFileSync(project, 'utf8'), '# Saved\n');
    await expectError(h.host.writeMemory(sessionId, notes, 'x'), 422, 'PATH_NOT_ALLOWED');
    await expectError(h.host.writeMemory(sessionId, path.join(folder, 'other.md'), 'x'), 422, 'PATH_NOT_ALLOWED');
    await expectError(h.host.writeMemory(sessionId, project, 'x'.repeat(262_145)), 413, 'PAYLOAD_TOO_LARGE');
    await expectError(h.host.writeMemory(sessionId, '', 'x'), 400, 'BAD_REQUEST');
    await expectError(h.host.writeMemory(sessionId, project, 12), 400, 'BAD_REQUEST');
    assert.equal(fs.readFileSync(project, 'utf8'), '# Saved\n');
  });

  test('the conversation export keeps the runtime text and a file name made of safe characters', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    query.values.exportConversation = {
      text: 'User: hi\nAssistant: hello',
      default_filename: '../conversation 2026/10/09?.txt',
    };
    assert.deepEqual(await h.host.exportConversation(sessionId), {
      text: 'User: hi\nAssistant: hello',
      filename: 'conversation20261009.txt',
    });
    query.values.exportConversation = { text: '' };
    assert.deepEqual(await h.host.exportConversation(sessionId), { text: '', filename: 'conversation.txt' });
    await expectError(h.host.exportConversation(UNKNOWN), 409, 'SESSION_NOT_LIVE');
  });

  test('a task output is the runtime end of the output, and an unknown task is a 404 with the runtime message',
    async () => {
      const h = harness();
      const { sessionId, query } = await startLive(h);
      query.values.getTaskOutput = { output: 'done\n', total_bytes: 5, truncated: false };
      assert.deepEqual(await h.host.taskOutput(sessionId, 'bash-1'), {
        output: 'done\n', totalBytes: 5, truncated: false,
      });
      assert.deepEqual(query.calls.at(-1), ['getTaskOutput', 'bash-1']);
      const unknown = 'get_task_output: no shell or Monitor task with that task_id in this session';
      query.failures.set('getTaskOutput', new Error(`${unknown}\n/internal`));
      await assert.rejects(h.host.taskOutput(sessionId, 'bash-9'), (error) => error.status === 404
        && error.code === 'NOT_FOUND' && error.message === unknown);
      query.failures.set('getTaskOutput', new Error('boom /secret'));
      await assert.rejects(h.host.taskOutput(sessionId, 'bash-1'), (error) => error.status === 502
        && error.message === 'The task output could not be read.');
      await expectError(h.host.taskOutput(sessionId, ''), 400, 'BAD_REQUEST');
    });

  test('a side question answers in the runtime shape, and one is answered at a time per session', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    query.values.askSideQuestion = {
      response: 'Yes.',
      synthetic: false,
      refusalFallback: { originalModel: 'opus', fallbackModel: 'sonnet', content: 'not passed on' },
    };
    assert.deepEqual(await h.host.sideQuestion(sessionId, '  Is it done?  '), {
      response: 'Yes.',
      synthetic: false,
      refusalFallback: { originalModel: 'opus', fallbackModel: 'sonnet' },
    });
    assert.deepEqual(query.calls.at(-1), ['askSideQuestion', 'Is it done?']);
    query.values.askSideQuestion = null;
    assert.deepEqual(await h.host.sideQuestion(sessionId, 'Again?'), {
      response: null,
      synthetic: false,
      refusalFallback: null,
    });
    let release = () => undefined;
    query.values.askSideQuestion = new Promise((resolve) => {
      release = () => resolve({ response: 'Late.', synthetic: true, refusalFallback: null });
    });
    const first = h.host.sideQuestion(sessionId, 'Slow?');
    await flush();
    await expectError(h.host.sideQuestion(sessionId, 'Second?'), 409, 'CONFLICT');
    release();
    assert.deepEqual(await first, { response: 'Late.', synthetic: true, refusalFallback: null });
    await expectError(h.host.sideQuestion(sessionId, '   '), 400, 'BAD_REQUEST');
    await expectError(h.host.sideQuestion(sessionId, 'x'.repeat(4001)), 400, 'BAD_REQUEST');
    query.askSideQuestion = undefined;
    await expectError(h.host.sideQuestion(sessionId, 'Missing?'), 501, 'FEATURE_UNAVAILABLE');
  });
});

describe('EngineHost file suggestions, runtime trust and the bypass guard', () => {
  test('a side question unanswered after 120 seconds is a 502, and the next one can be asked',
    async (t) => {
      const h = harness();
      const { sessionId, query } = await startLive(h);
      query.hangs.add('askSideQuestion');
      mock.timers.enable({ apis: ['setTimeout'] });
      t.after(() => mock.timers.reset());
      let settled = false;
      const outcome = h.host.sideQuestion(sessionId, 'Why?').then(() => null, (error) => {
        settled = true;
        return error;
      });
      for (let turns = 0; !query.calls.some((call) => call[0] === 'askSideQuestion') && turns < 1000; turns += 1) {
        await flush();
      }
      mock.timers.tick(119_999);
      await flush();
      assert.equal(settled, false);
      mock.timers.tick(1);
      const error = await outcome;
      assert.ok(error instanceof AppError);
      assert.equal(error.status, 502);
      assert.equal(error.code, 'ENGINE_ERROR');
      assert.equal(error.message, TIMEOUT_NOTICE);
      query.hangs.delete('askSideQuestion');
      query.values.askSideQuestion = { response: 'Yes.', synthetic: false, refusalFallback: null };
      const again = await h.host.sideQuestion(sessionId, 'Again?');
      assert.deepEqual(again, { response: 'Yes.', synthetic: false, refusalFallback: null });
    });

  test('file suggestions come from the runtime for the live folder, and are null otherwise', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    query.values.request = {
      subtype: 'success',
      request_id: 'r1',
      response: { suggestions: [{ path: 'src/host.mjs' }, { path: 'src/' }, { path: '../escape' }, { path: '/abs' }] },
    };
    assert.deepEqual(await h.host.fileSuggestions(sessionId, CWD, 'host', 10), [
      { path: 'src/host.mjs', type: 'file' },
      { path: 'src', type: 'dir' },
    ]);
    assert.deepEqual(query.calls.at(-1), ['request', { subtype: 'file_suggestions', query: 'host' }]);
    assert.equal(await h.host.fileSuggestions(sessionId, OUTSIDE, 'host', 10), null);
    assert.equal(await h.host.fileSuggestions(UNKNOWN, CWD, 'host', 10), null);
    query.values.request = { response: { suggestions: [] } };
    assert.equal(await h.host.fileSuggestions(sessionId, CWD, 'none', 10), null);
    query.failures.set('request', new Error('index down'));
    assert.equal(await h.host.fileSuggestions(sessionId, CWD, 'host', 10), null);
    query.failures.clear();
    query.request = undefined;
    assert.equal(await h.host.fileSuggestions(sessionId, CWD, 'host', 10), null);
  });

  test('file suggestions also answer for a symbolic link that names the live folder', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    const alias = path.join(STATE_DIR, 'file-suggestions-alias');
    fs.symlinkSync(CWD, alias, 'dir');
    query.values.request = { response: { suggestions: [{ path: 'README.md' }] } };
    assert.deepEqual(await h.host.fileSuggestions(sessionId, alias, 'read', 10), [{ path: 'README.md', type: 'file' }]);
    assert.deepEqual(query.calls.at(-1), ['request', { subtype: 'file_suggestions', query: 'read' }]);
  });

  test('file suggestions give up when the runtime does not answer within 1.5 seconds, and answer null', async (t) => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    query.hangs.add('request');
    mock.timers.enable({ apis: ['setTimeout'] });
    t.after(() => mock.timers.reset());
    const outcome = h.host.fileSuggestions(sessionId, CWD, 'host', 10);
    // The folder checks read the disk before the request is sent, so wait until the request is recorded.
    for (let turns = 0; !query.calls.some((call) => call[0] === 'request') && turns < 1000; turns += 1) {
      await flush();
    }
    mock.timers.tick(1499);
    await flush();
    assert.equal(query.calls.some((call) => call[0] === 'request'), true);
    mock.timers.tick(1);
    assert.equal(await outcome, null);
  });

  test('the runtime trust of a folder is recorded once, and a refused handshake is not kept', async () => {
    const h = harness();
    const second = path.join(STATE_DIR, 'second');
    fs.mkdirSync(second);
    assert.equal(await h.host.recordRuntimeTrust(CWD), 'already');
    assert.equal(await h.host.recordRuntimeTrust(CWD), 'already');
    assert.equal(h.engine.probes.length, 1);
    h.engine.probeValues.setCwd = { status: 'error' };
    assert.equal(await h.host.recordRuntimeTrust(second), 'failed');
    h.engine.probeValues.setCwd = (directory, options) => (options
      ? { status: 'ok', cwd: directory, changed: true }
      : { status: 'needs_trust', directory });
    assert.equal(await h.host.recordRuntimeTrust(second), 'accepted');
    const probe = h.engine.probes.at(-1);
    assert.deepEqual(probe.calls.filter((call) => call[0] === 'setCwd'), [
      ['setCwd', second],
      ['setCwd', second, { trustAccepted: true, trustedDirectory: second }],
    ]);
    const probes = h.engine.probes.length;
    // Only the call that ran the handshake answers 'accepted'; a repeat finds the folder trusted.
    assert.equal(await h.host.recordRuntimeTrust(second), 'already');
    assert.equal(h.engine.probes.length, probes);
  });

  test('a trusted start whose folder the runtime does not record shows one RUNTIME_TRUST notice per folder',
    async () => {
      const h = harness();
      h.engine.probeValues.setCwd = { status: 'error' };
      const first = await h.host.createSession({ cwd: CWD });
      await h.host.createSession({ cwd: CWD });
      const notices = ofType(h.events, 'notice').filter((event) => event.data.code === 'RUNTIME_TRUST');
      assert.equal(notices.length, 1);
      assert.equal(notices[0].sessionId, first.sessionId);
      assert.equal(notices[0].data.level, 'warning');
      assert.equal(h.engine.queries.length, 2);
    });

  test('a query that starts with bypass permissions is set back to default with a notice', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h, { cwd: CWD }, { permissionMode: 'bypassPermissions' });
    await flush();
    assert.deepEqual(query.calls.at(-1), ['setPermissionMode', 'default']);
    assert.equal(h.host.liveInfo(sessionId).permissionMode, 'default');
    assert.equal(h.host.liveInfo(sessionId).state, 'idle');
    const notices = ofType(h.events, 'notice');
    assert.deepEqual(notices.map((event) => [event.data.level, event.data.code]), [['warning', 'BYPASS_REFUSED']]);
  });

  test('a bypass the runtime cannot turn off closes the session and publishes an error notice', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    query.failures.set('setPermissionMode', new Error('refused by policy'));
    query.emit({
      type: 'system', subtype: 'status', status: 'requesting', permissionMode: 'bypassPermissions', uuid: randomUUID(),
      session_id: sessionId,
    });
    await flush();
    assert.equal(h.host.liveInfo(sessionId), null);
    assert.equal(query.closed, true);
    assert.deepEqual(ofType(h.events, 'notice').at(-1).data, {
      sessionId,
      level: 'error',
      code: 'BYPASS_REFUSED',
      message: 'Bypass permissions could not be turned off, so the session was closed.',
    });
  });

  test('a refusal fallback dialog is a pending request answered through respond, and other dialogs are cancelled',
    async () => {
      const h = harness();
      const { sessionId, query } = await startLive(h);
      const onUserDialog = query.options.onUserDialog;
      const signal = new AbortController().signal;
      const answer = onUserDialog({
        dialogKind: 'refusal_fallback_prompt',
        payload: {
          originalModel: 'opus',
          fallbackModel: 'sonnet',
          apiRefusalCategory: 'cyber',
          guidanceText: 'Try again',
          retractedMessageUuids: ['u1', 7],
        },
        toolUseID: 'tool-9',
      }, { signal, requestId: 'dlg-1' });
      await flush();
      const { pending } = await h.host.getSession(sessionId);
      assert.equal(pending.length, 1);
      assert.equal(pending[0].kind, 'dialog');
      assert.equal(pending[0].toolUseId, 'tool-9');
      assert.deepEqual(pending[0].dialog, {
        dialogKind: 'refusal_fallback_prompt',
        originalModel: 'opus',
        fallbackModel: 'sonnet',
        apiRefusalCategory: 'cyber',
        guidanceText: 'Try again',
        retractedMessageUuids: ['u1'],
      });
      await h.host.respond(sessionId, pending[0].id, { result: 'retry_fallback' });
      assert.deepEqual(await answer, { behavior: 'completed', result: 'retry_fallback' });
      const unknownKind = { dialogKind: 'unknown_kind', payload: {} };
      assert.deepEqual(await onUserDialog(unknownKind, { signal, requestId: 'dlg-2' }), { behavior: 'cancelled' });
      assert.deepEqual(await onUserDialog({ dialogKind: 'refusal_fallback_prompt', payload: { originalModel: 'opus' } },
        { signal, requestId: 'dlg-3' }), { behavior: 'cancelled' });
    });

  test('a refusal dialog the SDK aborts is cancelled, leaves the pending list and cannot be answered any more',
    async () => {
      const h = harness();
      const { sessionId, query } = await startLive(h);
      const controller = new AbortController();
      const answer = query.options.onUserDialog({
        dialogKind: 'refusal_fallback_prompt',
        payload: { originalModel: 'opus', fallbackModel: 'sonnet' },
      }, { signal: controller.signal, requestId: 'dlg-abort' });
      await flush();
      const [shown] = (await h.host.getSession(sessionId)).pending;
      assert.equal(shown.kind, 'dialog');
      controller.abort();
      assert.deepEqual(await answer, { behavior: 'cancelled' });
      assert.equal((await h.host.getSession(sessionId)).pending.length, 0);
      await expectError(h.host.respond(sessionId, shown.id, { result: 'retry_fallback' }), 404, 'REQUEST_NOT_FOUND');
    });

  test('closing the session cancels its open dialog, which the runtime then settles by its default', async () => {
    const h = harness();
    const { sessionId, query } = await startLive(h);
    const answer = query.options.onUserDialog({
      dialogKind: 'refusal_fallback_prompt',
      payload: { originalModel: 'opus', fallbackModel: 'sonnet' },
    }, { signal: new AbortController().signal, requestId: 'dlg-7' });
    await flush();
    await h.host.closeSession(sessionId);
    assert.deepEqual(await answer, { behavior: 'cancelled' });
  });
});

describe('EngineHost unattended mode (docs/PROTOCOL.md "Unattended mode")', () => {
  /**
   * Turns the switch on or off the way the gateway does: the saved value changes, then every live query is applied.
   * @param {ReturnType<typeof harness>} h
   * @param {boolean} on
   */
  async function switchTo(h, on) {
    h.unattended.on = on;
    await h.host.applyUnattended();
  }

  /** @param {FakeQuery} query */
  function modeCalls(query) {
    return query.calls.filter((call) => call[0] === 'setPermissionMode');
  }

  test('a query started while the switch is on runs in bypassPermissions, and the mode the session chose comes back',
    async () => {
      const h = harness({ config: { allowBypass: true } });
      h.unattended.on = true;
      const { sessionId, query } = await startLive(h, { cwd: CWD, permissionMode: 'acceptEdits' },
        { permissionMode: 'bypassPermissions' });
      assert.equal(query.options.permissionMode, 'bypassPermissions');
      assert.equal(h.host.liveInfo(sessionId).permissionMode, 'bypassPermissions');
      await switchTo(h, false);
      assert.deepEqual(modeCalls(query), [['setPermissionMode', 'acceptEdits']]);
      assert.equal(h.host.liveInfo(sessionId).permissionMode, 'acceptEdits');
      assert.equal(ofType(h.events, 'notice').length, 0, 'bypass is allowed, so the refusal notice never shows');
    });

  test('turning the switch on sets bypassPermissions on every live query, and each keeps its own mode for later',
    async () => {
      const h = harness({ config: { allowBypass: true } });
      const chosen = await startLive(h, { cwd: CWD, permissionMode: 'acceptEdits' }, { permissionMode: 'acceptEdits' });
      const plain = await startLive(h, { cwd: CWD }, { permissionMode: 'default' });
      await switchTo(h, true);
      assert.deepEqual(modeCalls(chosen.query), [['setPermissionMode', 'bypassPermissions']]);
      assert.deepEqual(modeCalls(plain.query), [['setPermissionMode', 'bypassPermissions']]);
      assert.equal(h.host.liveInfo(chosen.sessionId).permissionMode, 'bypassPermissions');
      assert.equal(h.host.liveInfo(plain.sessionId).permissionMode, 'bypassPermissions');
      await switchTo(h, false);
      assert.deepEqual(modeCalls(chosen.query).at(-1), ['setPermissionMode', 'acceptEdits']);
      assert.deepEqual(modeCalls(plain.query).at(-1), ['setPermissionMode', 'default']);
      assert.equal(h.host.liveInfo(chosen.sessionId).permissionMode, 'acceptEdits');
      assert.equal(h.host.liveInfo(plain.sessionId).permissionMode, 'default');
    });

  test('a query whose mode was not known returns to default when the switch turns off', async () => {
    const h = harness({ config: { allowBypass: true, defaults: { permissionMode: null } } });
    const { sessionId, query } = await startLive(h, { cwd: CWD }, { permissionMode: undefined });
    await switchTo(h, true);
    await switchTo(h, false);
    assert.deepEqual(modeCalls(query), [['setPermissionMode', 'bypassPermissions'], ['setPermissionMode', 'default']]);
    assert.equal(h.host.liveInfo(sessionId).permissionMode, 'default');
  });

  test('a mode a person chooses while the switch is on is kept, and applied when the switch turns off', async () => {
    const h = harness({ config: { allowBypass: true } });
    h.unattended.on = true;
    const { sessionId, query } = await startLive(h, { cwd: CWD }, { permissionMode: 'bypassPermissions' });
    const { live } = await h.host.updateSettings(sessionId, { permissionMode: 'acceptEdits' });
    assert.equal(live.permissionMode, 'bypassPermissions');
    assert.deepEqual(modeCalls(query), []);
    await switchTo(h, false);
    assert.deepEqual(modeCalls(query), [['setPermissionMode', 'acceptEdits']]);
    assert.equal(h.host.liveInfo(sessionId).permissionMode, 'acceptEdits');
  });

  test('a restart while the switch holds a query starts it in bypassPermissions, and the chosen mode comes back',
    async () => {
      const extra = path.join(CWD, 'extra');
      const h = harness({ config: { allowBypass: true }, resolveDir: folderOf });
      h.unattended.on = true;
      const { sessionId, query } = await startLive(h, { cwd: CWD, permissionMode: 'acceptEdits' },
        { permissionMode: 'bypassPermissions' });
      await h.host.updateSettings(sessionId, { additionalDirectories: [extra] });
      assert.equal(query.closed, true);
      const restarted = h.engine.queries[1];
      assert.equal(restarted.options.permissionMode, 'bypassPermissions');
      await switchTo(h, false);
      assert.deepEqual(modeCalls(restarted), [['setPermissionMode', 'acceptEdits']]);
      assert.equal(h.host.liveInfo(sessionId).permissionMode, 'acceptEdits');
    });

  test('a mode chosen while the switch is on survives a restart', async () => {
    const extra = path.join(CWD, 'extra');
    const h = harness({ config: { allowBypass: true }, resolveDir: folderOf });
    h.unattended.on = true;
    const { sessionId } = await startLive(h, { cwd: CWD }, { permissionMode: 'bypassPermissions' });
    await h.host.updateSettings(sessionId, { permissionMode: 'acceptEdits' });
    await h.host.updateSettings(sessionId, { additionalDirectories: [extra] });
    const restarted = h.engine.queries[1];
    await switchTo(h, false);
    assert.deepEqual(modeCalls(restarted), [['setPermissionMode', 'acceptEdits']]);
  });

  test('a switch-off the runtime refuses closes that session, rather than leaving it in bypass', async () => {
    const h = harness({ config: { allowBypass: true } });
    h.unattended.on = true;
    const { sessionId, query } = await startLive(h, { cwd: CWD }, { permissionMode: 'bypassPermissions' });
    query.failures.set('setPermissionMode', new Error('refused by /home/claude/.claude/settings.json'));
    await switchTo(h, false);
    assert.equal(query.closed, true);
    assert.equal(h.host.liveInfo(sessionId), null);
    assert.deepEqual(ofType(h.events, 'session_state').at(-1).data, { sessionId, live: null });
    const warning = h.logs.find((entry) => entry.msg === 'could not change the permission mode of a session');
    assert.equal(warning.level, 'warn');
    assert.equal(JSON.stringify(warning).includes('settings.json'), false);
  });

  test('a mode change the runtime refuses when the switch turns on is logged, and the other sessions still switch',
    async () => {
      const h = harness({ config: { allowBypass: true } });
      const refusing = await startLive(h, { cwd: CWD }, { permissionMode: 'acceptEdits' });
      const willing = await startLive(h, { cwd: CWD }, { permissionMode: 'default' });
      refusing.query.failures.set('setPermissionMode', new Error('refused by /home/claude/.claude/settings.json'));
      await switchTo(h, true);
      assert.equal(h.host.liveInfo(refusing.sessionId).permissionMode, 'acceptEdits');
      assert.notEqual(h.host.liveInfo(refusing.sessionId), null);
      assert.equal(h.host.liveInfo(willing.sessionId).permissionMode, 'bypassPermissions');
      const warning = h.logs.find((entry) => entry.msg === 'could not change the permission mode of a session');
      assert.equal(warning.level, 'warn');
      assert.equal(warning.fields.sessionId, refusing.sessionId);
      assert.equal(JSON.stringify(warning).includes('settings.json'), false);
    });

  test('turning the switch on answers the requests already waiting, with auto: true, and nothing stays requires_action',
    async () => {
      const h = harness({ config: { allowBypass: true } });
      const { sessionId, query } = await startLive(h);
      const bash = callTool(query, 'Bash', { command: 'ls' }, { requestId: 'w-bash' }).pending;
      const question = callTool(query, 'AskUserQuestion', { questions: [] }, { requestId: 'w-question' }).pending;
      const plan = callTool(query, 'ExitPlanMode', { plan: 'p' }, { requestId: 'w-plan' }).pending;
      const mcp = callElicitation(query, { serverName: 'docs', message: 'Name?' }, { requestId: 'w-mcp' }).pending;
      await flush();
      assert.equal(h.host.liveInfo(sessionId).state, 'requires_action');
      assert.equal(h.host.liveInfo(sessionId).pendingCount, 4);
      await switchTo(h, true);
      assert.deepEqual(await bash, { behavior: 'allow', updatedInput: { command: 'ls' } });
      assert.deepEqual(await question, { behavior: 'deny', message: UNATTENDED_QUESTION_MESSAGE });
      assert.deepEqual(await plan, { behavior: 'allow', updatedInput: { plan: 'p' } });
      assert.deepEqual(await mcp, { action: 'decline' });
      assert.equal(h.host.liveInfo(sessionId).pendingCount, 0);
      assert.equal(h.host.liveInfo(sessionId).state, 'running');
      assert.deepEqual(ofType(h.events, 'request_resolved').slice(-4).map((event) => [
        event.data.requestId, event.data.outcome, event.data.auto,
      ]), [['w-bash', 'allowed', true], ['w-question', 'denied', true], ['w-plan', 'allowed', true],
        ['w-mcp', 'denied', true]]);
    });

  test('a permission prompt raised while the switch is on is answered at once and never shows requires_action',
    async () => {
      const h = harness({ config: { allowBypass: true } });
      h.unattended.on = true;
      const { sessionId, query } = await startLive(h, { cwd: CWD }, { permissionMode: 'bypassPermissions' });
      const { pending } = callTool(query, 'Bash', { command: 'ls' }, { requestId: 'a-1' });
      assert.deepEqual(await pending, { behavior: 'allow', updatedInput: { command: 'ls' } });
      assert.equal(lastOutcome(h), 'allowed');
      assert.equal(ofType(h.events, 'request_resolved').at(-1).data.auto, true);
      const states = ofType(h.events, 'session_state').map((event) => event.data.live?.state);
      assert.equal(states.includes('requires_action'), false);
      assert.equal(h.host.liveInfo(sessionId).state, 'running');
    });

  test('each automatic answer is published with auto: true, and a person\'s answer of any kind never carries it',
    async () => {
      const h = harness({ config: { allowBypass: true } });
      h.unattended.on = true;
      const { sessionId, query } = await startLive(h, { cwd: CWD }, { permissionMode: 'bypassPermissions' });
      const dialog = query.options.onUserDialog({
        dialogKind: 'refusal_fallback_prompt', payload: { originalModel: 'opus', fallbackModel: 'sonnet' },
      }, { signal: new AbortController().signal, requestId: 'd-auto' });
      const elicit = callElicitation(query, { serverName: 'docs', message: 'Name?' }, { requestId: 'e-auto' }).pending;
      const question = callTool(query, 'AskUserQuestion', { questions: [] }, { requestId: 'q-auto' }).pending;
      const plan = callTool(query, 'ExitPlanMode', { plan: 'p' }, { requestId: 'p-auto' }).pending;
      const permission = callTool(query, 'Bash', { command: 'ls' }, { requestId: 'b-auto' }).pending;
      await flush();
      assert.deepEqual(await dialog, { behavior: 'completed', result: 'cancelled' });
      assert.deepEqual(await elicit, { action: 'decline' });
      assert.deepEqual(await question, { behavior: 'deny', message: UNATTENDED_QUESTION_MESSAGE });
      assert.deepEqual(await plan, { behavior: 'allow', updatedInput: { plan: 'p' } });
      assert.deepEqual(await permission, { behavior: 'allow', updatedInput: { command: 'ls' } });
      assert.deepEqual(ofType(h.events, 'request_resolved').map((event) => [
        event.data.requestId, event.data.outcome, event.data.auto,
      ]), [['d-auto', 'answered', true], ['e-auto', 'denied', true], ['q-auto', 'denied', true],
        ['p-auto', 'allowed', true], ['b-auto', 'allowed', true]]);
      await switchTo(h, false);
      const manual = callTool(query, 'Bash', { command: 'pwd' }, { requestId: 'm-1' }).pending;
      await h.host.respond(sessionId, 'm-1', { decision: 'allow' });
      await manual;
      assert.deepEqual(ofType(h.events, 'request_resolved').at(-1).data, {
        sessionId, requestId: 'm-1', outcome: 'allowed',
      });
    });

  test('a session opened from history while the switch is on starts in bypassPermissions', async () => {
    const h = harness({ config: { allowBypass: true } });
    addSession(h.engine, S1);
    h.unattended.on = true;
    await h.host.openSession(S1);
    const query = h.engine.queries[h.engine.queries.length - 1];
    await flush();
    query.emit(initMessage(S1, { permissionMode: 'bypassPermissions' }));
    await flush();
    assert.equal(query.options.permissionMode, 'bypassPermissions');
    assert.equal(h.host.liveInfo(S1).permissionMode, 'bypassPermissions');
    await switchTo(h, false);
    assert.deepEqual(modeCalls(query), [['setPermissionMode', 'default']]);
  });

  test('applying the switch again changes nothing, and a closed session is not reached', async () => {
    const h = harness({ config: { allowBypass: true } });
    const { sessionId, query } = await startLive(h, { cwd: CWD, permissionMode: 'acceptEdits' },
      { permissionMode: 'acceptEdits' });
    await switchTo(h, true);
    await switchTo(h, true);
    assert.deepEqual(modeCalls(query), [['setPermissionMode', 'bypassPermissions']]);
    await h.host.closeSession(sessionId);
    await switchTo(h, false);
    assert.deepEqual(modeCalls(query), [['setPermissionMode', 'bypassPermissions']]);
  });

  test('switching on and off quickly ends in the value saved last, because each change reads the switch when it runs',
    async () => {
      const h = harness({ config: { allowBypass: true } });
      const { sessionId, query } = await startLive(h, { cwd: CWD, permissionMode: 'acceptEdits' },
        { permissionMode: 'acceptEdits' });
      h.unattended.on = true;
      const first = h.host.applyUnattended();
      h.unattended.on = false;
      const second = h.host.applyUnattended();
      await Promise.all([first, second]);
      assert.deepEqual(modeCalls(query), []);
      assert.equal(h.host.liveInfo(sessionId).permissionMode, 'acceptEdits');
    });
});

describe('EngineHost context meter', () => {
  /**
   * A getContextUsage answer for a window: the summary's total, the window and the auto-compact settings.
   * @param {{totalTokens?: number, maxTokens?: number, threshold?: number|null, enabled?: boolean}} [over]
   */
  function windowAnswer({
    totalTokens = 39116, maxTokens = 100000, threshold = 67000, enabled = true, apiUsage = null,
  } = {}) {
    const answer = {
      ...structuredClone(DEFAULT_CONTEXT),
      totalTokens,
      maxTokens,
      rawMaxTokens: maxTokens,
      isAutoCompactEnabled: enabled,
      apiUsage,
    };
    if (threshold !== null) answer.autoCompactThreshold = threshold;
    return answer;
  }

  /**
   * Makes every query the engine starts answer getContextUsage with `answer`, before the query is made.
   * @param {ReturnType<typeof harness>} h
   * @param {Record<string, unknown>} answer
   */
  function windowOf(h, answer) {
    const makeQuery = h.engine.query;
    h.engine.query = (args) => {
      const query = makeQuery(args);
      query.values.getContextUsage = structuredClone(answer);
      return query;
    };
  }

  /**
   * A stream_event that opens a call: its message id and the usage it reports when it starts.
   * @param {string} sessionId
   * @param {string} id
   * @param {{input: number, cacheRead?: number, cacheCreate?: number, output?: number}} usage
   * @param {string|null} [parent] the tool call of a subagent
   */
  function callStart(sessionId, id, { input, cacheRead = 0, cacheCreate = 0, output = 1 }, parent = null) {
    return {
      type: 'stream_event',
      uuid: randomUUID(),
      session_id: sessionId,
      parent_tool_use_id: parent,
      event: {
        type: 'message_start',
        message: {
          id,
          usage: {
            input_tokens: input,
            cache_creation_input_tokens: cacheCreate,
            cache_read_input_tokens: cacheRead,
            output_tokens: output,
          },
        },
      },
    };
  }

  /**
   * The stream_event that reports the output a call has so far.
   * @param {string} sessionId
   * @param {number} output
   * @param {string|null} [parent]
   */
  function callOutput(sessionId, output, parent = null) {
    return {
      type: 'stream_event',
      uuid: randomUUID(),
      session_id: sessionId,
      parent_tool_use_id: parent,
      event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: output } },
    };
  }

  /**
   * The assistant message of a call, with the usage it ends with.
   * @param {string} sessionId
   * @param {string} id
   * @param {{input: number, cacheRead?: number, cacheCreate?: number, output: number}} usage
   * @param {string|null} [parent]
   */
  function callEnd(sessionId, id, { input, cacheRead = 0, cacheCreate = 0, output }, parent = null) {
    return {
      type: 'assistant',
      uuid: randomUUID(),
      session_id: sessionId,
      parent_tool_use_id: parent,
      message: {
        id,
        role: 'assistant',
        model: 'sonnet',
        content: [{ type: 'text', text: 'answer' }],
        usage: {
          input_tokens: input,
          cache_creation_input_tokens: cacheCreate,
          cache_read_input_tokens: cacheRead,
          output_tokens: output,
        },
      },
    };
  }

  /**
   * The system/status of a compaction.
   * @param {string} sessionId
   * @param {string|null} status
   * @param {object} [extra]
   */
  function compactionStatus(sessionId, status, extra = {}) {
    return { type: 'system', subtype: 'status', status, uuid: randomUUID(), session_id: sessionId, ...extra };
  }

  /** The system/compact_boundary of a finished compaction. @param {string} sessionId @param {object} metadata */
  function boundaryOf(sessionId, metadata) {
    return { type: 'system', subtype: 'compact_boundary', compact_metadata: metadata, uuid: randomUUID(),
      session_id: sessionId };
  }

  /** @param {ReturnType<typeof harness>} h @param {string} sessionId */
  const meterOf = (h, sessionId) => h.host.liveInfo(sessionId).context;

  /**
   * Holds the full count of a query (getContextUsage at full detail) until the test answers it: `release` answers it
   * with a value and `fail` rejects it. The summary is answered as usual.
   * @param {FakeQuery} query
   */
  function holdFullCount(query) {
    const answer = query.getContextUsage.bind(query);
    /** @type {{resolve: (value: unknown) => void, reject: (error: Error) => void}|null} */
    let held = null;
    query.getContextUsage = (options) => {
      if (options?.detail !== 'full') return answer(options);
      query.calls.push(['getContextUsage', options]);
      return new Promise((resolve, reject) => {
        held = { resolve, reject };
      });
    };
    return {
      release: (value) => held?.resolve(value),
      fail: (error) => held?.reject(error),
    };
  }

  /** Lets the reads the host starts after an event finish: each one takes a few macrotasks. */
  async function settle() {
    for (let turns = 0; turns < 20; turns += 1) await flush();
  }

  test('the meter reads the window once the handshake answers, and estimates the fixed overhead', async () => {
    const h = harness();
    windowOf(h, windowAnswer());
    const info = await h.host.createSession({ cwd: CWD });
    const query = h.engine.queries[0];
    await flush();
    assert.deepEqual(meterOf(h, info.sessionId), {
      used: 39116, max: 100000, autoCompactAt: 67000, autoCompact: true, source: 'estimate',
      compacting: null, lastCompaction: null,
    });
    assert.deepEqual(query.calls.filter((call) => call[0] === 'getContextUsage'),
      [['getContextUsage', { detail: 'summary' }]]);
  });

  test('a call shows its prompt as it starts and its output as it streams, and the next call replaces it', async () => {
    const h = harness();
    windowOf(h, windowAnswer());
    const { sessionId, query } = await startLive(h);
    query.emit(callStart(sessionId, 'msg_1', { input: 3, cacheRead: 40000 }));
    await flush();
    assert.deepEqual([meterOf(h, sessionId).used, meterOf(h, sessionId).source], [40004, 'stream']);
    query.emit(callOutput(sessionId, 300));
    await flush();
    assert.equal(meterOf(h, sessionId).used, 40303);
    query.emit(callEnd(sessionId, 'msg_1', { input: 3, cacheRead: 40000, output: 300 }));
    await flush();
    assert.equal(meterOf(h, sessionId).used, 40303, 'the final message of the call adds nothing');
    query.emit(callStart(sessionId, 'msg_2', { input: 3, cacheRead: 41000 }));
    await flush();
    assert.equal(meterOf(h, sessionId).used, 41004);
  });

  test('a subagent call leaves the meter alone', async () => {
    const h = harness();
    windowOf(h, windowAnswer());
    const { sessionId, query } = await startLive(h);
    query.emit(callStart(sessionId, 'msg_1', { input: 3, cacheRead: 40000 }));
    await flush();
    const before = meterOf(h, sessionId);
    query.emit(callStart(sessionId, 'sub_1', { input: 6000 }, 'toolu_agent'));
    query.emit(callOutput(sessionId, 800, 'toolu_agent'));
    query.emit(callEnd(sessionId, 'sub_1', { input: 6000, output: 800 }, 'toolu_agent'));
    await flush();
    assert.deepEqual(meterOf(h, sessionId), before);
  });

  test('a model change reads the window again, so the threshold follows the new model', async () => {
    const h = harness();
    windowOf(h, windowAnswer());
    const { sessionId, query } = await startLive(h);
    query.values.getContextUsage = windowAnswer({ maxTokens: 200000, threshold: 167000 });
    await h.host.updateSettings(sessionId, { model: 'opus' });
    await flush();
    assert.deepEqual([meterOf(h, sessionId).max, meterOf(h, sessionId).autoCompactAt], [200000, 167000]);
    assert.deepEqual(query.calls.slice(-2), [['setModel', 'opus'], ['getContextUsage', { detail: 'summary' }]]);
  });

  test('a compaction shows as compacting, then its boundary is recorded and the window is read again', async () => {
    const h = harness();
    windowOf(h, windowAnswer());
    const { sessionId, query } = await startLive(h);
    h.time.now = 5000;
    query.emit(compactionStatus(sessionId, 'compacting'));
    await flush();
    assert.deepEqual(meterOf(h, sessionId).compacting, { since: 5000, trigger: null });
    query.emit(compactionStatus(sessionId, null, { compact_result: 'success' }));
    await flush();
    assert.equal(meterOf(h, sessionId).compacting, null);
    h.time.now = 6200;
    query.emit(boundaryOf(sessionId, { trigger: 'auto', pre_tokens: 75000, post_tokens: 2069, duration_ms: 1200 }));
    await flush();
    assert.deepEqual(meterOf(h, sessionId).lastCompaction, {
      trigger: 'auto', preTokens: 75000, postTokens: 2069, durationMs: 1200, at: 6200,
    });
    // The size the stream reported before the compaction no longer holds: the context is counted in full.
    assert.deepEqual(query.calls.at(-1), ['getContextUsage', { detail: 'full' }]);
    assert.deepEqual([meterOf(h, sessionId).used, meterOf(h, sessionId).source], [39116, 'count']);
  });

  test('after a compaction, an API call that starts before the full count answers keeps its newer usage', async () => {
    const h = harness();
    windowOf(h, windowAnswer({ totalTokens: 41000 }));
    const { sessionId, query } = await startLive(h);
    query.emit(callStart(sessionId, 'msg_before', { input: 2, cacheRead: 70000, cacheCreate: 4000 }));
    await flush();
    /** @type {(value: unknown) => void} */
    let answerCount = () => {};
    const counted = new Promise((resolve) => { answerCount = resolve; });
    const original = query.getContextUsage.bind(query);
    query.getContextUsage = async (options) => {
      if (options?.detail === 'full') {
        query.calls.push(['getContextUsage', options]);
        await counted;
        return { ...windowAnswer({ totalTokens: 41000 }) };
      }
      return original(options);
    };
    query.emit(boundaryOf(sessionId, { trigger: 'auto', pre_tokens: 74003, post_tokens: 2069 }));
    query.emit(callStart(sessionId, 'msg_after', { input: 2, cacheRead: 30000, cacheCreate: 2029 }));
    await flush();
    answerCount(null);
    await flush();
    assert.deepEqual([meterOf(h, sessionId).used, meterOf(h, sessionId).source], [32032, 'stream']);
  });

  test('a /compact prompt marks the compaction it starts as manual', async () => {
    const h = harness();
    windowOf(h, windowAnswer());
    const { sessionId, query } = await startLive(h);
    await h.host.sendMessage(sessionId, { clientMessageId: randomUUID(), text: '/compact' });
    query.emit(compactionStatus(sessionId, 'compacting'));
    await flush();
    assert.equal(meterOf(h, sessionId).compacting.trigger, 'manual');
    query.emit(boundaryOf(sessionId, { pre_tokens: 40000, post_tokens: 1960 }));
    await flush();
    assert.equal(meterOf(h, sessionId).lastCompaction.trigger, 'manual');
  });

  test('a failed compaction reads the window again, and a read that fails keeps the values the meter had', async () => {
    const h = harness();
    windowOf(h, windowAnswer());
    const { sessionId, query } = await startLive(h);
    query.emit(compactionStatus(sessionId, 'compacting'));
    query.emit(compactionStatus(sessionId, null, { compact_result: 'failed', compact_error: 'refused' }));
    await flush();
    assert.equal(query.calls.at(-1)[0], 'getContextUsage');
    const before = structuredClone(meterOf(h, sessionId));
    query.failures.set('getContextUsage', new Error('control channel closed'));
    query.emit(compactionStatus(sessionId, 'compacting'));
    query.emit(compactionStatus(sessionId, null, { compact_result: 'failed', compact_error: 'refused' }));
    await flush();
    assert.deepEqual(meterOf(h, sessionId), before);
    assert.ok(h.logs.some((entry) => entry.level === 'debug' && entry.msg === 'context usage not read'));
  });

  test('a resumed session reads its last call from the transcript until the runtime reports one', async () => {
    const h = harness();
    const usage = {
      input_tokens: 3, cache_creation_input_tokens: 1000, cache_read_input_tokens: 38000, output_tokens: 250,
    };
    addSession(h.engine, S1, {
      messages: [
        userEntry(S1, 'u-1', 'question'),
        { ...assistantMessage(S1, 'a-1', 'answer'), message: { id: 'msg_a1', role: 'assistant', model: 'sonnet',
          content: [{ type: 'text', text: 'answer' }], usage } },
      ],
    });
    windowOf(h, windowAnswer());
    const { query } = await openLive(h, S1);
    await flush();
    assert.deepEqual([meterOf(h, S1).used, meterOf(h, S1).source], [39253, 'transcript']);
    query.emit(callStart(S1, 'msg_2', { input: 3, cacheRead: 40000 }));
    await flush();
    assert.deepEqual([meterOf(h, S1).used, meterOf(h, S1).source], [40004, 'stream']);
  });

  test('the meter is published when it changes, not for every message of a call', async () => {
    const h = harness();
    windowOf(h, windowAnswer());
    const { sessionId, query } = await startLive(h);
    const before = ofType(h.events, 'session_state').length;
    query.emit(callStart(sessionId, 'msg_1', { input: 3, cacheRead: 40000 }));
    await flush();
    const started = ofType(h.events, 'session_state').length;
    assert.equal(started, before + 1);
    query.emit(callOutput(sessionId, 1));
    query.emit(callEnd(sessionId, 'msg_1', { input: 3, cacheRead: 40000, output: 1 }));
    await flush();
    assert.equal(ofType(h.events, 'session_state').length, started);
    query.emit(callOutput(sessionId, 200));
    await flush();
    const events = ofType(h.events, 'session_state');
    assert.equal(events.length, started + 1);
    assert.equal(events.at(-1).data.live.context.used, 40203);
  });

  test('right after a boundary the meter estimates the context, until the full count answers', async () => {
    const h = harness();
    windowOf(h, windowAnswer());
    const { sessionId, query } = await startLive(h);
    query.emit(callStart(sessionId, 'msg_1', { input: 3, cacheRead: 40000 }));
    await flush();
    const count = holdFullCount(query);
    query.emit(boundaryOf(sessionId, { trigger: 'auto', pre_tokens: 40004, post_tokens: 2069 }));
    await flush();
    // The fixed part (the summary's total) and what the compaction leaves; the size the stream reported no longer holds.
    assert.deepEqual([meterOf(h, sessionId).used, meterOf(h, sessionId).source], [41185, 'estimate']);
    count.release(windowAnswer({ totalTokens: 41190 }));
    await settle();
    assert.deepEqual([meterOf(h, sessionId).used, meterOf(h, sessionId).source], [41190, 'count']);
  });

  test('a failed full count falls back to the fixed part plus the compaction size, never to apiUsage', async () => {
    const h = harness();
    windowOf(h, windowAnswer({
      apiUsage: { input_tokens: 9, output_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 50000 },
    }));
    const { sessionId, query } = await startLive(h);
    await settle();
    assert.deepEqual([meterOf(h, sessionId).used, meterOf(h, sessionId).source], [50018, 'api-usage']);
    query.emit(callStart(sessionId, 'msg_1', { input: 3, cacheRead: 40000 }));
    await flush();
    const count = holdFullCount(query);
    query.emit(boundaryOf(sessionId, { trigger: 'auto', pre_tokens: 40004, post_tokens: 2069 }));
    await flush();
    count.fail(new Error('control channel closed'));
    await settle();
    assert.deepEqual([meterOf(h, sessionId).used, meterOf(h, sessionId).source], [41185, 'estimate']);
    const debugged = h.logs.filter((entry) => entry.level === 'debug').map((entry) => entry.msg);
    assert.ok(debugged.includes('context not counted after a compaction'));
    // A later refresh (here the one a failed compaction makes) still never takes apiUsage from before the compaction.
    query.emit(compactionStatus(sessionId, 'compacting'));
    query.emit(compactionStatus(sessionId, null, { compact_result: 'failed', compact_error: 'refused' }));
    await settle();
    assert.deepEqual([meterOf(h, sessionId).used, meterOf(h, sessionId).source], [41185, 'estimate']);
  });

  test('a call that streams while the full count is pending keeps its usage when the count fails', async () => {
    const h = harness();
    windowOf(h, windowAnswer());
    const { sessionId, query } = await startLive(h);
    // The window the summary reports after the compaction differs from the one the session started with.
    query.values.getContextUsage = windowAnswer({ maxTokens: 200000, threshold: 167000 });
    query.emit(callStart(sessionId, 'msg_1', { input: 3, cacheRead: 40000 }));
    await flush();
    const count = holdFullCount(query);
    query.emit(boundaryOf(sessionId, { trigger: 'auto', pre_tokens: 40004, post_tokens: 2069 }));
    await flush();
    query.emit(callStart(sessionId, 'msg_2', { input: 3, cacheRead: 42000 }));
    await flush();
    count.fail(new Error('control channel closed'));
    await settle();
    assert.deepEqual([meterOf(h, sessionId).used, meterOf(h, sessionId).source], [42004, 'stream']);
    assert.deepEqual([meterOf(h, sessionId).max, meterOf(h, sessionId).autoCompactAt], [200000, 167000],
      'the window comes from the summary read after the failure');
  });

  test('a resumed session whose last compaction has no call after it counts its context in full', async () => {
    const h = harness();
    // What getSessionMessages returns after a compaction (PROTOCOL.md): a boundary without subtype, then the summary.
    addSession(h.engine, S1, {
      messages: [
        { type: 'system', uuid: 'boundary-1', session_id: S1, parent_tool_use_id: null, parent_agent_id: null },
        { type: 'user', uuid: 'summary-1', session_id: S1, parent_tool_use_id: null, parent_agent_id: null,
          isCompactSummary: true, is_meta: true, message: { role: 'user', content: 'Summary' } },
      ],
    });
    const makeQuery = h.engine.query;
    h.engine.query = (args) => {
      const query = makeQuery(args);
      query.values.getContextUsage = (options) => windowAnswer({
        totalTokens: options?.detail === 'full' ? 41190 : 39116,
      });
      return query;
    };
    const { sessionId } = await openLive(h, S1);
    await settle();
    assert.deepEqual([meterOf(h, sessionId).used, meterOf(h, sessionId).source], [41190, 'count']);
  });
});
