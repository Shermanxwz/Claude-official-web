// Tests for the runtime controls and query options of the mock (src/engine/mock/query.mjs): the interrupt receipt
// and the queued prompts, the side question, task output, the working folder and its trust, the @ file index, MCP
// servers and their sign-ins, the account sign-in, the runtime views and the options the runtime answers from. Every
// test uses its own temporary state and project directories, removed afterwards, and makes no network calls.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createMockAdapter } from '../../src/engine/mock/index.mjs';
import { FILE_INDEX_WARMUP_MS } from '../../src/engine/mock/answers.mjs';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * A fresh directory, removed when the test ends.
 * @param {import('node:test').TestContext} t
 * @returns {string}
 */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'caw-mock-controls-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A project folder with a couple of files, removed when the test ends.
 * @param {import('node:test').TestContext} t
 * @returns {string}
 */
function projectDir(t) {
  const dir = tempDir(t);
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'app.js'), "console.log('hi');\n");
  writeFileSync(join(dir, 'README.md'), '# Demo\n');
  return dir;
}

/** The background timing of the tests: a foreground command waits 25 ms to be moved, a background one runs 40 ms. */
const FAST_BACKGROUND = { waitMs: 25, runMs: 40 };

/**
 * An adapter over a state directory. Two adapters over one directory behave like two server restarts.
 * @param {string} stateDir
 * @param {{delayMs?: number, resolvedSettings?: Record<string, unknown>, backgroundTiming?: {waitMs?: number,
 *   runMs?: number}}} [options]
 */
function adapterWith(stateDir, { delayMs = 0, resolvedSettings, backgroundTiming = FAST_BACKGROUND } = {}) {
  return createMockAdapter({ config: { stateDir }, log: silent, delayMs, resolvedSettings, backgroundTiming });
}

/**
 * An SDK user message as the host sends it.
 * @param {string} text
 * @param {string} [uuid]
 */
function userPrompt(text, uuid = randomUUID()) {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, uuid };
}

/** A prompt stream the test drives: push prompts while the session runs, end it when no more turns should follow. */
function promptChannel() {
  /** @type {any[]} */
  const queued = [];
  /** @type {((result: IteratorResult<any>) => void) | null} */
  let waiter = null;
  let ended = false;
  const settle = (/** @type {IteratorResult<any>} */ result) => {
    const resolve = waiter;
    waiter = null;
    if (resolve) resolve(result);
  };
  return {
    stream: {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (queued.length > 0) return Promise.resolve({ done: false, value: queued.shift() });
            if (ended) return Promise.resolve({ done: true, value: undefined });
            return new Promise((resolve) => {
              waiter = resolve;
            });
          },
        };
      },
    },
    push(/** @type {any} */ message) {
      if (waiter) settle({ done: false, value: message });
      else queued.push(message);
    },
    end() {
      ended = true;
      if (waiter) settle({ done: true, value: undefined });
    },
  };
}

/** Drains a query into an array, from its first message to the end of the session. */
async function collect(query) {
  const messages = [];
  for await (const message of query) messages.push(message);
  return messages;
}

/**
 * One turn in a fresh session: the prompt is queued and the stream ends after it, so the session finishes by itself.
 * @param {any} adapter
 * @param {string} cwd
 * @param {string} text
 * @param {Record<string, unknown>} [options]
 * @param {string} [uuid]
 */
async function runSingle(adapter, cwd, text, options = {}, uuid = randomUUID()) {
  const channel = promptChannel();
  channel.push(userPrompt(text, uuid));
  channel.end();
  return collect(adapter.query({ prompt: channel.stream, options: { cwd, includePartialMessages: true, ...options } }));
}

/**
 * Pulls messages until one satisfies `until`, which is included.
 * @param {any} query
 * @param {(message: any) => boolean} until
 */
async function pullUntil(query, until) {
  const messages = [];
  for (;;) {
    const next = await query.next();
    if (next.done) break;
    messages.push(next.value);
    if (until(next.value)) break;
  }
  return messages;
}

/** The end of a turn: its result message. */
const isResult = (/** @type {any} */ message) => message.type === 'result';
/** A streamed text delta of an answer. */
const isTextDelta = (/** @type {any} */ message) => message.type === 'stream_event'
  && message.event.type === 'content_block_delta' && message.event.delta.type === 'text_delta';
/** The lifecycle message of one prompt in one state. */
const lifecycleOf = (/** @type {string} */ uuid, /** @type {string} */ state) => (/** @type {any} */ message) =>
  message.type === 'command_lifecycle' && message.command_uuid === uuid && message.state === state;

/**
 * An open query: its initialize handshake is answered at once, and nothing is streamed until the first prompt is pushed
 * (see startedWith). It is closed when the test ends.
 * @param {import('node:test').TestContext} t
 * @param {any} adapter
 * @param {string} cwd
 * @param {Record<string, unknown>} [options]
 */
async function openOn(t, adapter, cwd, options = {}) {
  const channel = promptChannel();
  const query = adapter.query({ prompt: channel.stream, options: { cwd, ...options } });
  t.after(() => {
    channel.end();
    query.close();
  });
  await query.initializationResult();
  return { query, channel };
}

/**
 * Pushes the first prompt of an open query and reads the stream up to the settings that follow system/init. Returns
 * the init message; the turn the prompt starts is still to be read by the test.
 * @param {any} query
 * @param {{push: (message: any) => void}} channel
 * @param {string} [text]
 */
async function startedWith(query, channel, text = 'Tell me something') {
  channel.push(userPrompt(text));
  const messages = await pullUntil(query, (message) => message.type === 'active_goal');
  assert.deepEqual(messages.slice(-2).map((message) => message.type), ['autocompact_state', 'active_goal']);
  return messages.find((message) => message.type === 'system' && message.subtype === 'init');
}

/** An open query over a fresh adapter, with the default options. */
async function openQuery(t, options = {}) {
  return openOn(t, adapterWith(tempDir(t)), projectDir(t), options);
}

/** A query whose first turn is slow enough to be interrupted: each streamed chunk waits 400 ms. */
async function openSlow(t, options = {}) {
  return openOn(t, adapterWith(tempDir(t), { delayMs: 100 }), projectDir(t), {
    includePartialMessages: true,
    ...options,
  });
}

/**
 * Starts a build and moves it to the background as soon as its call arrives, as Ctrl+B does.
 * @param {any} query
 * @param {{push: (message: any) => void}} channel
 */
async function startBuildInBackground(query, channel) {
  channel.push(userPrompt('start a background build'));
  const before = await pullUntil(query, (message) => message.type === 'assistant'
    && message.message.content.some((block) => block.type === 'tool_use'));
  const toolUse = before.at(-1).message.content.find((block) => block.type === 'tool_use');
  assert.equal(await query.backgroundTasks(toolUse.id), true, 'the running command moves to the background');
  return toolUse.id;
}

/** Pulls messages until the task of a background command completes. */
const isTaskCompleted = (/** @type {string} */ taskId) => (/** @type {any} */ message) =>
  message.type === 'system' && message.subtype === 'task_notification' && message.task_id === taskId;

describe('interrupt receipts and queued prompts', () => {
  test('interrupt names the prompts still queued, and the queued turn runs after the interrupted one', async (t) => {
    const { query, channel } = await openSlow(t);
    channel.push(userPrompt('answer slowly'));
    await pullUntil(query, isTextDelta);
    const queued = userPrompt('Tell me something');
    channel.push(queued);
    await pullUntil(query, lifecycleOf(queued.uuid, 'queued'));
    assert.deepEqual(await query.interrupt(), { still_queued: [queued.uuid] });
    await pullUntil(query, isResult);
    const next = await pullUntil(query, isResult);
    assert.deepEqual(next.at(-1).user_message_uuids, [queued.uuid]);
  });

  test('interrupt with cancelQueued drops every queued prompt and announces each cancellation in order', async (t) => {
    const { query, channel } = await openSlow(t);
    channel.push(userPrompt('answer slowly'));
    await pullUntil(query, isTextDelta);
    const second = userPrompt('Tell me something');
    const third = userPrompt('Tell me again');
    channel.push(second);
    channel.push(third);
    await pullUntil(query, lifecycleOf(third.uuid, 'queued'));
    const receipt = await query.interrupt({ cancelQueued: true });
    assert.deepEqual(receipt, { still_queued: [], cancelled: [second.uuid, third.uuid] });
    const announced = await pullUntil(query, lifecycleOf(third.uuid, 'cancelled'));
    assert.deepEqual(
      announced.filter((message) => message.type === 'command_lifecycle' && message.state === 'cancelled')
        .map((message) => message.command_uuid),
      [second.uuid, third.uuid],
    );
    await pullUntil(query, isResult);
  });

  test('cancelAsyncMessage removes one queued prompt; a prompt that is not queued is answered false', async (t) => {
    const { query, channel } = await openSlow(t);
    channel.push(userPrompt('answer slowly'));
    await pullUntil(query, isTextDelta);
    const second = userPrompt('Tell me something');
    const third = userPrompt('Tell me again');
    channel.push(second);
    channel.push(third);
    await pullUntil(query, lifecycleOf(third.uuid, 'queued'));
    assert.equal(await query.cancelAsyncMessage(third.uuid), true);
    assert.equal(await query.cancelAsyncMessage(third.uuid), false, 'a second cancel finds nothing');
    assert.equal(await query.cancelAsyncMessage(randomUUID()), false);
    await assert.rejects(query.cancelAsyncMessage(''), /uuid must be a message uuid\./);
    await pullUntil(query, lifecycleOf(third.uuid, 'cancelled'));
    assert.deepEqual(await query.interrupt(), { still_queued: [second.uuid] });
    await pullUntil(query, isResult);
    const next = await pullUntil(query, isResult);
    assert.deepEqual(next.at(-1).user_message_uuids, [second.uuid]);
  });
});

describe('side questions and task output', () => {
  test('askSideQuestion answers without a turn; an aborted question has no answer', async (t) => {
    const { query } = await openQuery(t);
    assert.deepEqual(await query.askSideQuestion('  What changed?  '), {
      response: 'Side answer: What changed?',
      synthetic: false,
    });
    assert.equal(await query.askSideQuestion('Anything', { signal: AbortSignal.abort() }), null);
    await assert.rejects(query.askSideQuestion('   '), /question must be a non-empty string\./);
    await assert.rejects(query.askSideQuestion('ok', { history: 'nope' }), /history must be a list of messages\./);
  });

  test('a side question about a refusal is answered through the fallback model', async (t) => {
    const { query } = await openQuery(t);
    const answer = await query.askSideQuestion('Why did the refusal happen?');
    assert.equal(answer.refusalFallback.originalModel, 'claude-opus-mock');
    assert.equal(answer.refusalFallback.fallbackModel, 'claude-sonnet-mock');
  });

  test('getTaskOutput answers the output of a background command, and refuses an id it does not know', async (t) => {
    const { query, channel } = await openOn(t, adapterWith(tempDir(t)), projectDir(t));
    await startBuildInBackground(query, channel);
    const started = await pullUntil(query, (message) => message.type === 'system' && message.subtype === 'task_started'
      && message.is_backgrounded === true);
    const taskId = started.at(-1).task_id;
    assert.deepEqual(await query.getTaskOutput(taskId), { output: '', total_bytes: 0, truncated: false });
    await pullUntil(query, isTaskCompleted(taskId));
    assert.deepEqual(await query.getTaskOutput(taskId), {
      output: 'Build succeeded\n',
      total_bytes: 16,
      truncated: false,
    });
    await assert.rejects(query.getTaskOutput('task_mock_missing'),
      /get_task_output: no shell or Monitor task with that task_id in this session/);
    await assert.rejects(query.getTaskOutput(42), /no shell or Monitor task/);
  });
});

describe('the working folder and its trust', () => {
  test('setCwd asks for trust of an untrusted folder; accepting it moves the session there', async (t) => {
    const stateDir = tempDir(t);
    const adapter = adapterWith(stateDir);
    const cwd = projectDir(t);
    const other = projectDir(t);
    const { query, channel } = await openOn(t, adapter, cwd);
    const init = await startedWith(query, channel);
    await pullUntil(query, isResult);
    await assert.rejects(query.setCwd('relative/folder'), /cwd must be an absolute path\./);
    await assert.rejects(query.setCwd(join(other, 'missing')), /set_cwd: the directory does not exist\./);
    assert.deepEqual(await query.setCwd(other), { status: 'needs_trust', directory: other });
    await assert.rejects(query.setCwd(other, { trustAccepted: true }),
      /set_cwd: invalid request — trust_accepted requires trusted_directory/);
    assert.deepEqual(await query.setCwd(other, { trustAccepted: true, trustedDirectory: other }), {
      status: 'ok',
      cwd: other,
      changed: true,
      transcript_relocated: true,
    });
    assert.deepEqual(await query.setCwd(other), {
      status: 'ok',
      cwd: other,
      changed: false,
      transcript_relocated: false,
    });
    const listed = await adapter.listSessions({ dir: other });
    assert.ok(listed.some((session) => session.sessionId === init.session_id), 'the transcript moved to the folder');
    assert.deepEqual(await adapter.listSessions({ dir: cwd }), []);
  });

  test('the trust a folder is given is shared by every session, so its allow rules count there', async (t) => {
    const adapter = adapterWith(tempDir(t), {
      resolvedSettings: { permissions: { allow: ['Bash(npm test:*)'], ask: ['Bash(git push:*)'] } },
    });
    const cwd = projectDir(t);
    const other = projectDir(t);
    const { query } = await openOn(t, adapter, cwd, { additionalDirectories: ['/shared/lib'] });
    const before = await query.listPermissionRules();
    assert.deepEqual(before.state.rules.map((rule) => rule.behavior), ['ask']);
    assert.deepEqual(before.state.workspaceDirectories, [{ path: '/shared/lib', source: 'session' }]);
    assert.equal(before.state.originalCwd, cwd);
    await query.setCwd(other, { trustAccepted: true, trustedDirectory: other });
    const after = await query.listPermissionRules();
    assert.deepEqual(after.state.rules.map((rule) => rule.behavior), ['allow', 'ask']);
    const { query: second } = await openOn(t, adapter, other);
    assert.ok((await second.listPermissionRules()).state.rules.some((rule) => rule.rule === 'Bash(npm test:*)'));
  });
});

describe('the @ file index', () => {
  test('the index answers nothing during its warm-up, then lists the matching files', async (t) => {
    const cwd = projectDir(t);
    const { query } = await openOn(t, adapterWith(tempDir(t)), cwd);
    const early = await query.request({ subtype: 'file_suggestions', query: 'app' });
    assert.equal(early.subtype, 'success');
    assert.equal(typeof early.request_id, 'string');
    assert.deepEqual(early.response, { suggestions: [], cwd });
    await new Promise((resolve) => setTimeout(resolve, FILE_INDEX_WARMUP_MS + 50));
    const late = await query.request({ subtype: 'file_suggestions', query: 'app' });
    assert.deepEqual(late.response.suggestions, [{ path: 'src/app.js' }]);
  });

  test('other control requests and malformed file requests are refused', async (t) => {
    const { query } = await openQuery(t);
    await assert.rejects(query.request({ subtype: 'mcp_status' }), /Unsupported control request: mcp_status/);
    await assert.rejects(query.request({}), /request needs a subtype\./);
    await assert.rejects(query.request({ subtype: 'file_suggestions', query: 3 }), /query must be a string\./);
  });
});

describe('reading files and the MCP servers', () => {
  test('readFile returns null for a file that a Read deny rule covers', async (t) => {
    const cwd = projectDir(t);
    const adapter = adapterWith(tempDir(t), { resolvedSettings: { permissions: { deny: ['Read(./README.md)'] } } });
    const { query } = await openOn(t, adapter, cwd);
    assert.equal(await query.readFile('README.md'), null);
    assert.equal((await query.readFile('src/app.js')).contents, "console.log('hi');\n");
  });

  test('setMcpServers adds and removes servers; the browser server offers the browser tools', async (t) => {
    const { query } = await openQuery(t);
    const servers = { browser: { type: 'stdio', command: 'node' }, docs: { command: 'node' } };
    assert.deepEqual(await query.setMcpServers(servers), {
      added: ['browser', 'docs'],
      removed: [],
      errors: {},
    });
    const status = await query.mcpServerStatus();
    const browser = status.find((server) => server.name === 'browser');
    assert.equal(browser.status, 'connected');
    assert.deepEqual(browser.tools.map((tool) => tool.name), ['browser_navigate', 'browser_take_screenshot']);
    assert.deepEqual(browser.tools[1].annotations, { readOnly: true });
    assert.ok(status.some((server) => server.name === 'github'), 'the built-in servers stay');
    assert.deepEqual(await query.setMcpServers({ browser: { command: 'node' } }), {
      added: [],
      removed: ['docs'],
      errors: {},
    });
    await assert.rejects(query.setMcpServers(null), /servers must be an object\./);
  });

  test('an mcpServers option configures servers from the start, and the init message lists them', async (t) => {
    const { query, channel } = await openQuery(t, { mcpServers: { docs: { type: 'http', url: 'http://localhost:9' } } });
    const init = await startedWith(query, channel);
    assert.ok(init.mcp_servers.some((server) => server.name === 'docs' && server.status === 'connected'));
    const docs = (await query.mcpServerStatus()).find((server) => server.name === 'docs');
    assert.equal(docs.tools.length, 0);
  });

  test('an mcpServers option that is not an object is refused before the query starts', (t) => {
    const adapter = adapterWith(tempDir(t));
    assert.throws(() => adapter.query({ prompt: 'Tell me', options: { cwd: projectDir(t), mcpServers: 'docs' } }),
      /mcpServers must be an object\./);
  });

  test('setMcpPermissionModeOverride accepts a connected server and warns about any other name', async (t) => {
    const { query } = await openQuery(t);
    assert.deepEqual(await query.setMcpPermissionModeOverride('github', 'auto'), {});
    assert.deepEqual(await query.setMcpPermissionModeOverride('mock-oauth', null), {
      warning: 'No MCP server named "mock-oauth" is connected.',
    });
    assert.deepEqual(await query.setMcpPermissionModeOverride('missing', 'default'), {
      warning: 'No MCP server named "missing" is connected.',
    });
  });

  test('the mock-oauth server needs a sign-in: its flow opens an address, and a callback completes it', async (t) => {
    const { query } = await openQuery(t);
    const before = (await query.mcpServerStatus()).find((server) => server.name === 'mock-oauth');
    assert.equal(before.status, 'needs-auth');
    assert.deepEqual(before.tools, []);
    const started = await query.mcpAuthenticate('mock-oauth');
    assert.equal(started.requiresUserAction, true);
    assert.equal(started.callbackExpected, true);
    assert.equal(started.redirectScheme, 'localhost');
    assert.equal(started.callbackPort, 53682);
    assert.equal(new URL(started.authUrl).searchParams.get('state'), started.state);
    assert.equal((await query.mcpAuthenticate('mock-oauth')).state, started.state, 'a second start keeps the flow');
    const callback = (/** @type {string} */ state, code = 'abc') =>
      `http://localhost:53682/callback?code=${code}&state=${state}`;
    await assert.rejects(query.mcpSubmitOAuthCallbackUrl('mock-oauth', callback('wrong')),
      /The OAuth state does not match this flow\./);
    await assert.rejects(query.mcpSubmitOAuthCallbackUrl('mock-oauth', callback(started.state, '')),
      /The callback address carries no authorization code\./);
    assert.deepEqual(await query.mcpSubmitOAuthCallbackUrl('mock-oauth', callback(started.state)), {});
    const after = (await query.mcpServerStatus()).find((server) => server.name === 'mock-oauth');
    assert.equal(after.status, 'connected');
    assert.deepEqual(after.tools.map((tool) => tool.name), ['whoami']);
    assert.deepEqual(await query.mcpAuthenticate('mock-oauth'), { requiresUserAction: false, callbackExpected: false });
    assert.deepEqual(await query.mcpClearAuth('mock-oauth'), { message: 'Authentication cleared' });
    assert.equal((await query.mcpServerStatus()).find((server) => server.name === 'mock-oauth').status, 'needs-auth');
  });

  test('a sign-in can return to a custom address, which has no callback port', async (t) => {
    const { query } = await openQuery(t);
    const started = await query.mcpAuthenticate('mock-oauth', 'myapp://callback');
    assert.equal(started.redirectScheme, 'custom');
    assert.equal('callbackPort' in started, false);
  });

  test('the MCP auth calls refuse servers they cannot sign in to, and flows that are not open', async (t) => {
    const { query } = await openQuery(t);
    await assert.rejects(query.mcpAuthenticate('missing'), /Server not found: missing/);
    assert.deepEqual(await query.mcpAuthenticate('github'), { requiresUserAction: false, callbackExpected: false });
    await assert.rejects(query.mcpAuthenticate('filesystem'),
      /Server type stdio does not support OAuth authentication/);
    await assert.rejects(query.mcpAuthenticate('mock-oauth', 42), /redirectUri must be a string\./);
    await assert.rejects(query.mcpSubmitOAuthCallbackUrl('github', 'http://localhost/x?code=1&state=1'),
      /No active OAuth flow for server: github/);
    await assert.rejects(query.mcpClearAuth('missing'), /Server not found: missing/);
  });

  test('the browser server: the screenshot prompt calls the tool and answers with the image', async (t) => {
    const { query, channel } = await openQuery(t);
    await query.setMcpServers({ browser: { command: 'node' } });
    channel.push(userPrompt('browse the page and take a screenshot'));
    const turn = await pullUntil(query, isResult);
    const call = turn.find((message) => message.type === 'assistant'
      && message.message.content.some((block) => block.type === 'tool_use'));
    const toolUse = call.message.content.find((block) => block.type === 'tool_use');
    assert.equal(toolUse.name, 'mcp__browser__browser_take_screenshot');
    assert.deepEqual(toolUse.input, { type: 'png' });
    const answered = turn.find((message) => message.type === 'user' && Array.isArray(message.message.content)
      && message.message.content.some((block) => block.type === 'tool_result' && block.tool_use_id === toolUse.id));
    const [result] = answered.message.content;
    assert.deepEqual(result.content.map((block) => block.type), ['text', 'image']);
    const image = result.content[1];
    assert.equal(image.source.media_type, 'image/png');
    assert.equal(Buffer.from(image.source.data, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(turn.at(-1).subtype, 'success');
  });

  test('without the browser server the screenshot prompt says so and runs no tool', async (t) => {
    const { query, channel } = await openQuery(t);
    channel.push(userPrompt('browse the page and take a screenshot'));
    const turn = await pullUntil(query, isResult);
    assert.equal(turn.some((message) => message.type === 'assistant'
      && message.message.content.some((block) => block.type === 'tool_use')), false);
    const text = turn.filter((message) => message.type === 'assistant')
      .flatMap((message) => message.message.content)
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    assert.equal(text, 'The browser server is not connected, so there is no screenshot.');
  });
});

describe('the claude.ai sign-in', () => {
  test('a claude.ai sign-in offers two addresses, joins the one in progress, and a code completes it', async (t) => {
    const { query } = await openQuery(t);
    const flow = await query.claudeAuthenticate(true);
    assert.match(flow.manualUrl, /^https:\/\/claude\.ai\/oauth\/authorize\?/);
    assert.match(flow.automaticUrl, /redirect=localhost$/);
    assert.equal((await query.claudeAuthenticate(true)).manualUrl, flow.manualUrl);
    const state = new URL(flow.manualUrl).searchParams.get('state');
    await assert.rejects(query.claudeAuthenticate('yes'), /loginWithClaudeAi must be a boolean\./);
    await assert.rejects(query.claudeOAuthCallback('', state),
      /Invalid code\. Please make sure the full code was copied/);
    await assert.rejects(query.claudeOAuthCallback('mock-code', 'wrong'),
      /The sign-in state does not match this flow\./);
    await assert.rejects(query.claudeOAuthCallback('bad-code', state), /The authorization code was not accepted\./);
    const signedIn = await query.claudeOAuthCallback('mock-code', state);
    assert.deepEqual(signedIn.account, {
      email: 'demo@example.test',
      organization: 'Demo',
      subscriptionType: 'pro',
      apiProvider: 'firstParty',
    });
    assert.deepEqual(await query.accountInfo(), signedIn.account);
  });

  test('a console sign-in makes an API account, which reports no plan limits', async (t) => {
    const { query } = await openQuery(t);
    const flow = await query.claudeAuthenticate(false);
    assert.match(flow.manualUrl, /^https:\/\/console-login\.example\.test\/oauth\/authorize\?/);
    const { account } = await query.claudeOAuthCallback('mock-code', new URL(flow.manualUrl).searchParams.get('state'));
    assert.equal(account.subscriptionType, 'Claude API');
    const usage = await query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
    assert.deepEqual([usage.subscription_type, usage.rate_limits_available, usage.rate_limits], [null, false, null]);
    const rows = (await query.getStatus()).sections[0].rows;
    assert.equal(rows.find((row) => row.label === 'Login method').value, 'Claude API account');
  });

  test('the demo account, a plan account, reports its five-hour window', async (t) => {
    const { query } = await openQuery(t);
    const usage = await query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
    assert.equal(usage.subscription_type, 'pro');
    assert.equal(usage.rate_limits_available, true);
    assert.equal(usage.rate_limits.five_hour.utilization, 0);
    assert.equal(typeof usage.rate_limits.seven_day.resets_at, 'string');
    assert.equal(usage.behaviors, null);
  });

  test('waiting for a sign-in resolves when its code completes it, and rejects when its query closes', async (t) => {
    const adapter = adapterWith(tempDir(t));
    const { query } = await openOn(t, adapter, projectDir(t));
    const flow = await query.claudeAuthenticate(true);
    const waiting = query.claudeOAuthWaitForCompletion();
    await query.claudeOAuthCallback('mock-code', new URL(flow.manualUrl).searchParams.get('state'));
    assert.deepEqual((await waiting).account.email, 'demo@example.test');
    const other = await openOn(t, adapter, projectDir(t));
    await other.query.claudeAuthenticate(false);
    const abandoned = other.query.claudeOAuthWaitForCompletion();
    other.query.close();
    await assert.rejects(abandoned, /The sign-in was abandoned\./);
  });

  test('a sign-in that is replaced rejects the code of the old address; the account survives a restart', async (t) => {
    const stateDir = tempDir(t);
    const first = await openOn(t, adapterWith(stateDir), projectDir(t));
    const old = await first.query.claudeAuthenticate(true);
    const replacement = await first.query.claudeAuthenticate(false);
    await assert.rejects(first.query.claudeOAuthCallback('mock-code', new URL(old.manualUrl).searchParams.get('state')),
      /The sign-in state does not match this flow\./);
    await first.query.claudeOAuthCallback('mock-code', new URL(replacement.manualUrl).searchParams.get('state'));
    const restarted = await openOn(t, adapterWith(stateDir), projectDir(t));
    assert.equal((await restarted.query.accountInfo()).subscriptionType, 'Claude API');
  });

  test('without a sign-in in progress a code is refused', async (t) => {
    const { query } = await openQuery(t);
    await assert.rejects(query.claudeOAuthCallback('mock-code', 'any'), /No active claude_authenticate flow/);
    await assert.rejects(query.claudeOAuthWaitForCompletion(), /No active claude_authenticate flow/);
  });
});

describe('the runtime views', () => {
  test('getStatus names the session, the model and the optional agent and folders', async (t) => {
    const sessionId = randomUUID();
    const { query } = await openOn(t, adapterWith(tempDir(t)), projectDir(t), {
      sessionId,
      agent: 'Explore',
      additionalDirectories: ['/shared/lib'],
      settingSources: ['user'],
    });
    const rows = Object.fromEntries((await query.getStatus()).sections.flatMap((section) => section.rows)
      .map((row) => [row.label, row.value]));
    assert.equal(rows['Session ID'], sessionId);
    assert.equal(rows.Agent, 'Explore');
    assert.equal(rows['Additional directories'], '/shared/lib');
    assert.equal(rows['Setting sources'], 'User settings only');
    assert.equal(rows['Login method'], 'claude.ai account');
    assert.equal(rows.Model, 'claude-sonnet-mock');
  });

  test('hooks, settings, the plan, skills, sandbox and chrome views follow the settings and the session', async (t) => {
    const adapter = adapterWith(tempDir(t), {
      resolvedSettings: { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } },
    });
    const { query } = await openOn(t, adapter, projectDir(t));
    const hooks = await query.getHooksListing();
    assert.deepEqual(hooks.events.map((event) => event.name), ['Stop']);
    assert.equal(hooks.hooks[0].displayText, 'echo done');
    const settings = await query.getSettings();
    assert.equal(settings.effective.hooks.Stop.length, 1);
    assert.equal(settings.applied.effort, 'medium');
    await query.applyFlagSettings({ effortLevel: 'high' });
    assert.equal((await query.getSettings()).applied.effort, 'high');
    assert.deepEqual(await query.getPlan(), { exists: false });
    assert.ok((await query.getSkillsDialog()).skills.some((skill) => skill.name === 'code-review'));
    assert.equal((await query.getSandboxDialog()).enabled, false);
    assert.equal((await query.getChromeDialog()).enabled, false);
  });

  test('getChromeDialog follows --chrome; getMemoryDialog reports a project CLAUDE.md once it exists', async (t) => {
    const cwd = projectDir(t);
    const { query } = await openOn(t, adapterWith(tempDir(t)), cwd, { extraArgs: { chrome: null } });
    assert.equal((await query.getChromeDialog()).enabled, true);
    let memory = await query.getMemoryDialog();
    assert.equal(memory.files[0].exists, false);
    writeFileSync(join(cwd, 'CLAUDE.md'), '# Notes\n');
    memory = await query.getMemoryDialog();
    assert.equal(memory.files[0].path, join(cwd, 'CLAUDE.md'));
    assert.equal(memory.files[0].exists, true);
    assert.equal(memory.files[1].exists, false, 'the user file is never reported as present');
  });

  test('exportConversation returns the conversation text and a default file name', async (t) => {
    const { query, channel } = await openQuery(t);
    channel.push(userPrompt('Tell me something'));
    await pullUntil(query, isResult);
    const exported = await query.exportConversation();
    assert.match(exported.text, /^> Tell me something\n\n/);
    assert.ok(exported.text.endsWith('\n'));
    assert.match(exported.default_filename, /^conversation-\d{4}-\d{2}-\d{2}-\d{6}\.txt$/);
  });

  test('initializationResult carries the runtime fields, and reinitialize answers the same', async (t) => {
    const { query } = await openQuery(t);
    const init = await query.initializationResult();
    assert.deepEqual(init.capabilities, ['ui_surface_v1']);
    assert.equal(init.session_state, 'idle');
    assert.equal(init.feedback_mode, 'off');
    assert.equal(init.current_permission_mode, 'default');
    assert.equal(init.pid, process.pid);
    assert.equal(init.user_output_styles_dir, '/mock/output-styles');
    assert.equal(init.remote_control_available, false);
    assert.equal(init.analytics_disabled, false);
    assert.deepEqual(await query.reinitialize(), init);
  });
});

describe('query options the runtime answers from', () => {
  test('the fallback model named by the query is the model a refusal is retried on', async (t) => {
    const messages = await runSingle(adapterWith(tempDir(t)), projectDir(t), 'trigger a refusal', {
      fallbackModel: 'claude-haiku-mock',
    });
    const notice = messages.find((message) => message.type === 'system'
      && message.subtype === 'model_refusal_fallback');
    assert.equal(notice.fallback_model, 'claude-haiku-mock');
    assert.equal(notice.content,
      'Claude Opus (mock) declined this request, so it was retried with Claude Haiku (mock).');
  });

  test('the runtime options are checked before any query starts', (t) => {
    const adapter = adapterWith(tempDir(t));
    const cwd = projectDir(t);
    const refused = (/** @type {Record<string, unknown>} */ options) => () =>
      adapter.query({ prompt: 'Tell me something', options: { cwd, ...options } });
    assert.throws(refused({ agent: '' }), /agent must be a non-empty string\./);
    assert.throws(refused({ fallbackModel: '  ' }), /fallbackModel must be a non-empty string\./);
    assert.throws(refused({ additionalDirectories: ['relative'] }),
      /additionalDirectories must be a list of absolute paths\./);
    assert.throws(refused({ supportedDialogKinds: [1] }), /supportedDialogKinds must be a list of strings\./);
    assert.throws(refused({ supportedDialogKinds: ['refusal_fallback_prompt'] }),
      /supportedDialogKinds requires onUserDialog\./);
    assert.throws(refused({ persistSession: 'no' }), /persistSession must be a boolean\./);
    assert.throws(refused({ allowDangerouslySkipPermissions: 'yes' }),
      /allowDangerouslySkipPermissions must be a boolean\./);
  });

  test('a query that does not persist its session writes no file and is not listed', async (t) => {
    const stateDir = tempDir(t);
    const adapter = adapterWith(stateDir);
    const cwd = projectDir(t);
    const messages = await runSingle(adapter, cwd, 'Tell me something', { persistSession: false });
    assert.equal(messages.find((message) => message.type === 'result').subtype, 'success');
    assert.deepEqual(readdirSync(join(stateDir, 'mock-sessions')), []);
    assert.deepEqual(await adapter.listSessions({ dir: cwd }), []);
    await runSingle(adapter, cwd, 'Tell me something');
    assert.equal((await adapter.listSessions({ dir: cwd })).length, 1, 'a persisting query is listed');
  });

  test('the permission mode a session starts in: the option, then the settings, then default', async (t) => {
    const cwd = projectDir(t);
    const adapter = adapterWith(tempDir(t), { resolvedSettings: { permissions: { defaultMode: 'acceptEdits' } } });
    const started = async (/** @type {Record<string, unknown>} */ options) => {
      const { query, channel } = await openOn(t, adapter, cwd, options);
      // The handshake reports the mode before the first prompt; system/init reports it once the prompt has arrived.
      const handshakeMode = (await query.initializationResult()).current_permission_mode;
      const init = await startedWith(query, channel);
      assert.equal(handshakeMode, init.permissionMode);
      return init.permissionMode;
    };
    assert.equal(await started({}), 'acceptEdits');
    assert.equal(await started({ permissionMode: 'plan' }), 'plan');
    assert.equal(await started({ permissionMode: null }), 'acceptEdits');
    assert.equal(await started({ settingSources: [] }), 'default', 'without setting sources the settings do not count');
  });

  test('a session with additional folders and an agent reports both in its status', async (t) => {
    const { query } = await openQuery(t, { agent: 'Explore', additionalDirectories: ['/shared/lib'] });
    const labels = (await query.getStatus()).sections[0].rows.map((row) => row.label);
    assert.ok(labels.includes('Agent'));
    assert.ok(labels.includes('Additional directories'));
  });
});
