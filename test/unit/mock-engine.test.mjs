// Tests for the deterministic mock engine (src/engine/mock). Every test uses its own temporary state and project
// directories, removed afterwards, and makes no network calls. Pacing is 0 except where a test needs a pause to act on.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createMockAdapter,
  DEFAULT_DELAY_MS,
  delayFromValue,
  MAX_DELAY_MS,
  resolveDelay,
} from '../../src/engine/mock/index.mjs';
import { createMockQuery } from '../../src/engine/mock/query.mjs';
import { createMockStore, newRecord } from '../../src/engine/mock/store.mjs';
import { SCENARIO_NAMES, selectScenario } from '../../src/engine/mock/scenarios.mjs';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * A fresh state directory, removed when the test ends.
 * @param {import('node:test').TestContext} t
 * @returns {string}
 */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'caw-mock-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A project directory with a couple of files, removed when the test ends.
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

/**
 * The background timing of the tests: a foreground command waits 25 ms to be moved, and a background one runs
 * 40 ms.
 */
const FAST_BACKGROUND = { waitMs: 25, runMs: 40 };

/**
 * An adapter over a state directory, with the options a test needs. Two adapters over one directory behave like two
 * server restarts.
 * @param {string} stateDir
 * @param {{delayMs?: number, config?: Record<string, unknown>, resolvedSettings?: Record<string, unknown>,
 *   backgroundTiming?: {waitMs?: number, runMs?: number}}} [options]
 */
function adapterWith(stateDir, {
  delayMs = 0, config = {}, resolvedSettings, backgroundTiming = FAST_BACKGROUND,
} = {}) {
  return createMockAdapter({
    config: { stateDir, ...config },
    log: silent,
    delayMs,
    resolvedSettings,
    backgroundTiming,
  });
}

/**
 * An adapter over a state directory with the default options.
 * @param {string} stateDir
 * @param {number} [delayMs]
 */
function adapterAt(stateDir, delayMs = 0) {
  return adapterWith(stateDir, { delayMs });
}

/**
 * An SDK user message as the host sends it.
 * @param {string} text
 * @param {string} [uuid]
 */
function userPrompt(text, uuid = randomUUID()) {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, uuid };
}

/**
 * A prompt stream the test drives: push prompts while the session runs, end it when no more turns should follow.
 */
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

/**
 * Drains a query into an array. Stops early when `until` returns true for a message, which closes the query.
 * @param {AsyncIterable<any>} query
 * @param {(message: any) => boolean} [until]
 */
async function collect(query, until) {
  const messages = [];
  for await (const message of query) {
    messages.push(message);
    if (until && until(message)) break;
  }
  return messages;
}

/**
 * One turn in a fresh session: the prompt is queued and the stream ends after it, so the session finishes by itself.
 * @param {any} adapter
 * @param {string} cwd
 * @param {string} text
 * @param {Record<string, unknown>} [options]
 * @param {string} [uuid] the uuid of the prompt message
 */
async function runSingle(adapter, cwd, text, options = {}, uuid = randomUUID()) {
  const channel = promptChannel();
  channel.push(userPrompt(text, uuid));
  channel.end();
  const query = adapter.query({ prompt: channel.stream, options: { cwd, includePartialMessages: true, ...options } });
  return collect(query);
}

/**
 * Checks the invariants every mock sequence keeps: init first, one session id, unique uuids, every streamed message id
 * finished by an assistant message, and every tool_use answered by a tool_result. Returns the result messages.
 * @param {any[]} messages
 */
function assertWellFormed(messages) {
  assert.equal(messages[0]?.type, 'system', 'the first message is a system message');
  assert.equal(messages[0].subtype, 'init', 'the first message is init');
  const sessionId = messages[0].session_id;
  const uuids = new Set();
  const streamed = new Set();
  const finished = new Set();
  const toolUses = new Set();
  const toolResults = new Set();
  for (const message of messages) {
    if (typeof message.session_id === 'string') assert.equal(message.session_id, sessionId, 'one session id');
    if (typeof message.uuid === 'string') {
      assert.ok(!uuids.has(message.uuid), `uuid ${message.uuid} repeats`);
      uuids.add(message.uuid);
    }
    if (message.type === 'stream_event' && message.event.type === 'message_start') {
      streamed.add(message.event.message.id);
    }
    if (message.type === 'assistant') {
      finished.add(message.message.id);
      for (const block of message.message.content) if (block.type === 'tool_use') toolUses.add(block.id);
    }
    if (message.type === 'user' && Array.isArray(message.message.content)) {
      for (const block of message.message.content) if (block.type === 'tool_result') toolResults.add(block.tool_use_id);
    }
  }
  for (const id of streamed) assert.ok(finished.has(id), `streamed message ${id} has a final assistant message`);
  for (const id of toolUses) assert.ok(toolResults.has(id), `tool_use ${id} has a tool_result`);
  return messages.filter((message) => message.type === 'result');
}

/**
 * Checks the turn linkage: every assistant message, stream event and result carries the uuid of the prompt that
 * started the turn (the last of the batch), and every result lists every prompt the turn answers, in order.
 * @param {any[]} messages
 * @param {string[]} uuids the answered prompts, in consumption order
 */
function assertLinked(messages, uuids) {
  const turnUuid = uuids[uuids.length - 1];
  const linked = messages.filter((m) => m.type === 'assistant' || m.type === 'stream_event' || m.type === 'result');
  assert.ok(linked.length > 0, 'the turn has linked messages');
  for (const message of linked) {
    assert.equal(message.user_message_uuid, turnUuid, `${message.type} carries the uuid of its prompt`);
  }
  const results = messages.filter((m) => m.type === 'result');
  assert.equal(results.length, 1, 'one result per turn');
  assert.deepEqual(results[0].user_message_uuids, uuids, 'the result lists every prompt the turn answers');
}

/** Text of the assistant messages of the top level, in order. */
function topLevelText(messages) {
  return messages
    .filter((message) => message.type === 'assistant' && message.parent_tool_use_id === null)
    .flatMap((message) => message.message.content)
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/** The tool_result block answering one tool_use id, or undefined. */
function toolResultOf(messages, toolUseId) {
  for (const message of messages) {
    if (message.type !== 'user' || !Array.isArray(message.message.content)) continue;
    const block = message.message.content.find((item) => item.type === 'tool_result' && item.tool_use_id === toolUseId);
    if (block) return { block, message };
  }
  return undefined;
}

/** A canUseTool callback that allows everything as the host would after a click. */
const allowAll = async (/** @type {string} */ _name, /** @type {Record<string, unknown>} */ input) => ({
  behavior: 'allow',
  updatedInput: input,
});

/** Answers every AskUserQuestion with the first option of each question. */
const pickFirstAnswers = async (/** @type {string} */ name, /** @type {any} */ input) => {
  if (name !== 'AskUserQuestion') return { behavior: 'allow', updatedInput: input };
  const answers = Object.fromEntries(input.questions.map((question) => [question.question, question.options[0].label]));
  return { behavior: 'allow', updatedInput: { ...input, answers } };
};

const SCENARIO_PROMPTS = {
  compact: '/compact',
  context: '/context',
  usage: '/usage',
  clear: '/clear',
  tool: 'please run the tool',
  edit: 'edit the server file',
  question: 'ask me a question',
  plan: 'make a plan',
  todo: 'track the todo list',
  agent: 'use an agent for this',
  web: 'search the web',
  mcp: 'check mcp issues',
  elicit: 'elicit my credentials',
  notify: 'notify me when done',
  rate: 'check the rate',
  hook: 'run a hook first',
  auth: 'check the auth token',
  error: 'produce an error',
  slow: 'answer slowly',
  think: 'think it through first',
  background: 'start a background build',
  'refusal-none': 'refusal-none please',
  refusal: 'trigger a refusal',
  plugin: 'install the plugin',
  default: 'Tell me something about the project',
};

/** The scenarios whose turn ends with an error result, and the error each one reports. */
const FAILING_SCENARIOS = {
  error: 'Mock failure requested',
  auth: 'Invalid API key · Please run /login',
};

describe('scenario selection', () => {
  test('every scenario has a prompt that selects it, and the table has no extra names', () => {
    assert.deepEqual([...SCENARIO_NAMES].sort(), Object.keys(SCENARIO_PROMPTS).sort());
    for (const [name, prompt] of Object.entries(SCENARIO_PROMPTS)) {
      assert.equal(selectScenario(prompt).name, name, `"${prompt}" selects ${name}`);
    }
  });

  test('keywords match word starts only, and slash commands match by prefix', () => {
    assert.equal(selectScenario('please generate a summary').name, 'default');
    assert.equal(selectScenario('  /compact now  ').name, 'compact');
    assert.equal(selectScenario('compact the notes').name, 'default');
  });
});

describe('well-formed sequences for every scenario', () => {
  for (const name of SCENARIO_NAMES) {
    test(`scenario ${name}`, async (t) => {
      const stateDir = tempDir(t);
      const cwd = projectDir(t);
      const adapter = adapterAt(stateDir);
      const options = {
        canUseTool: pickFirstAnswers,
        onElicitation: async () => ({ action: 'accept', content: { username: 'octocat' } }),
      };
      const messages = await runSingle(adapter, cwd, SCENARIO_PROMPTS[name], options);
      const results = assertWellFormed(messages);
      assert.equal(results.length, 1, 'exactly one result per turn');
      if (Object.hasOwn(FAILING_SCENARIOS, name)) {
        assert.equal(results[0].subtype, 'error_during_execution');
        assert.equal(results[0].is_error, true);
        assert.deepEqual(results[0].errors, [FAILING_SCENARIOS[name]]);
      } else {
        assert.equal(results[0].subtype, 'success');
        assert.equal(results[0].is_error, false);
      }
      assert.equal(messages.at(-1).type, 'system', 'the turn ends with the idle state change');
    });
  }

  test('streamed text arrives in chunks and the final message repeats the streamed id', async (t) => {
    const messages = await runSingle(adapterAt(tempDir(t)), projectDir(t), 'Tell me something');
    const deltas = messages.filter((m) => m.type === 'stream_event' && m.event.type === 'content_block_delta');
    assert.ok(deltas.length > 3, 'several text deltas');
    const start = messages.find((m) => m.type === 'stream_event' && m.event.type === 'message_start');
    const final = messages.find((m) => m.type === 'assistant' && m.parent_tool_use_id === null);
    assert.equal(final.message.id, start.event.message.id);
    assert.equal(final.message.content[0].text, deltas.map((m) => m.event.delta.text).join(''));
  });

  test('without includePartialMessages no stream events are produced', async (t) => {
    const adapter = adapterAt(tempDir(t));
    const channel = promptChannel();
    channel.push(userPrompt('Tell me something'));
    channel.end();
    const query = adapter.query({ prompt: channel.stream, options: { cwd: projectDir(t) } });
    const messages = await collect(query);
    assert.equal(messages.some((m) => m.type === 'stream_event'), false);
    assertWellFormed(messages);
  });
});

describe('approvals', () => {
  test('allow: the bash tool runs and its output is returned with the structured result', async (t) => {
    const calls = [];
    const canUseTool = async (name, input, options) => {
      calls.push({ name, input, options });
      return { behavior: 'allow', updatedInput: input };
    };
    const messages = await runSingle(adapterAt(tempDir(t)), projectDir(t), 'run the tool', { canUseTool });
    assertWellFormed(messages);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'Bash');
    assert.deepEqual(calls[0].input, { command: 'ls -la', description: 'List project files' });
    assert.equal(typeof calls[0].options.requestId, 'string');
    assert.equal(calls[0].options.suggestions[0].type, 'addRules');
    const toolUse = messages.find((m) => m.type === 'assistant'
      && m.message.content.some((b) => b.type === 'tool_use'));
    const found = toolResultOf(messages, toolUse.message.content.find((b) => b.type === 'tool_use').id);
    assert.equal(found.block.is_error, undefined);
    assert.equal(found.message.tool_use_result.interrupted, false);
    assert.match(found.message.tool_use_result.stdout, /src/);
    assert.equal(messages.some((m) => m.type === 'tool_use_summary'), true);
  });

  test('deny: the denial becomes an error tool_result and the turn continues with a reply', async (t) => {
    const canUseTool = async () => ({ behavior: 'deny', message: 'Not this time' });
    const messages = await runSingle(adapterAt(tempDir(t)), projectDir(t), 'run the tool', { canUseTool });
    const results = assertWellFormed(messages);
    const toolUse = messages.find((m) => m.type === 'assistant'
      && m.message.content.some((b) => b.type === 'tool_use'));
    const found = toolResultOf(messages, toolUse.message.content.find((b) => b.type === 'tool_use').id);
    assert.equal(found.block.is_error, true);
    assert.equal(found.block.content, 'Not this time');
    assert.match(topLevelText(messages), /I won't run that command/);
    assert.equal(results[0].subtype, 'success');
    assert.equal(results[0].permission_denials.length, 1);
    assert.equal(results[0].permission_denials[0].tool_name, 'Bash');
  });

  test('deny with interrupt stops the turn with aborted_tools and the interruption marker', async (t) => {
    const canUseTool = async () => ({ behavior: 'deny', message: 'Stop now', interrupt: true });
    const messages = await runSingle(adapterAt(tempDir(t)), projectDir(t), 'run the tool', { canUseTool });
    const results = assertWellFormed(messages);
    assert.equal(results.length, 1);
    assert.equal(results[0].subtype, 'error_during_execution');
    assert.equal(results[0].terminal_reason, 'aborted_tools');
    assert.ok(messages.some((m) => m.type === 'user' && m.isSynthetic === true));
  });

  test('without a canUseTool callback the call is denied and reported as permission_denied', async (t) => {
    const messages = await runSingle(adapterAt(tempDir(t)), projectDir(t), 'run the tool');
    const results = assertWellFormed(messages);
    const denied = messages.find((m) => m.type === 'system' && m.subtype === 'permission_denied');
    assert.ok(denied, 'a permission_denied message is emitted');
    assert.equal(denied.tool_name, 'Bash');
    assert.equal(results[0].permission_denials.length, 1);
  });

  test('bypassPermissions and dontAsk modes: bypass runs without asking, dontAsk denies without asking', async (t) => {
    let asked = 0;
    const canUseTool = async (_name, input) => {
      asked += 1;
      return { behavior: 'allow', updatedInput: input };
    };
    const bypass = await runSingle(adapterAt(tempDir(t)), projectDir(t), 'run the tool', {
      canUseTool,
      permissionMode: 'bypassPermissions',
    });
    assertWellFormed(bypass);
    assert.equal(asked, 0);
    assert.equal(bypass.some((m) => m.type === 'system' && m.subtype === 'permission_denied'), false);

    const dontAsk = await runSingle(adapterAt(tempDir(t)), projectDir(t), 'run the tool', {
      canUseTool,
      permissionMode: 'dontAsk',
    });
    assertWellFormed(dontAsk);
    assert.equal(asked, 0);
    const denied = dontAsk.find((m) => m.type === 'system' && m.subtype === 'permission_denied');
    assert.equal(denied.decision_reason_type, 'dontAsk');
  });

  test('acceptEdits mode lets the edit run without a prompt, but still asks for bash', async (t) => {
    const asked = [];
    const canUseTool = async (name, input) => {
      asked.push(name);
      return { behavior: 'allow', updatedInput: input };
    };
    const messages = await runSingle(adapterAt(tempDir(t)), projectDir(t), 'edit the server file', {
      canUseTool,
      permissionMode: 'acceptEdits',
    });
    assertWellFormed(messages);
    assert.deepEqual(asked, []);
    assert.equal(messages.filter((m) => m.type === 'result')[0].subtype, 'success');
  });

  test('an edit waits for the approval and returns the structured patch', async (t) => {
    const messages = await runSingle(adapterAt(tempDir(t)), projectDir(t), 'edit the server file', {
      canUseTool: allowAll,
    });
    assertWellFormed(messages);
    const editUse = messages
      .filter((m) => m.type === 'assistant')
      .flatMap((m) => m.message.content)
      .find((b) => b.type === 'tool_use' && b.name === 'Edit');
    const found = toolResultOf(messages, editUse.id);
    assert.equal(found.message.tool_use_result.structuredPatch[0].lines.length, 4);
    assert.equal(found.message.tool_use_result.userModified, false);
  });
});

describe('questions, plans and elicitation', () => {
  const questionUse = (messages) => messages
    .filter((m) => m.type === 'assistant')
    .flatMap((m) => m.message.content)
    .find((b) => b.type === 'tool_use' && b.name === 'AskUserQuestion');

  test('AskUserQuestion: the answers come back as the tool result and shape the reply', async (t) => {
    const asked = [];
    const canUseTool = async (name, input, options) => {
      asked.push({ name, title: options.title, toolUseID: options.toolUseID });
      return pickFirstAnswers(name, input);
    };
    const messages = await runSingle(adapterAt(tempDir(t)), projectDir(t), 'ask me a question', { canUseTool });
    const results = assertWellFormed(messages);
    assert.equal(results[0].subtype, 'success');
    assert.deepEqual(asked.map((entry) => entry.name), ['AskUserQuestion']);
    assert.equal(asked[0].title, 'Claude has questions for you');
    const toolUse = questionUse(messages);
    assert.equal(asked[0].toolUseID, toolUse.id);
    const found = toolResultOf(messages, toolUse.id);
    assert.deepEqual(found.message.tool_use_result.answers, {
      'Which authentication method should the demo use?': 'Magic link',
      'Which features should be enabled?': 'Dark mode',
    });
    assert.match(found.block.content, /"Which features should be enabled\?"="Dark mode"/);
    assert.equal(
      topLevelText(messages),
      'I need two decisions before I continue.\nThanks. I will use Magic link for sign-in and enable Dark mode.',
    );
  });

  test('AskUserQuestion denied: the refusal is the tool result and the reply carries on with defaults', async (t) => {
    const canUseTool = async () => ({ behavior: 'deny', message: 'No answers today' });
    const messages = await runSingle(adapterAt(tempDir(t)), projectDir(t), 'ask me a question', { canUseTool });
    const results = assertWellFormed(messages);
    assert.equal(results[0].subtype, 'success');
    assert.equal(results[0].permission_denials[0].tool_name, 'AskUserQuestion');
    const found = toolResultOf(messages, questionUse(messages).id);
    assert.equal(found.block.is_error, true);
    assert.equal(found.block.content, 'No answers today');
    assert.match(topLevelText(messages), /I will continue with sensible defaults/);
  });

  test('AskUserQuestion without a prompt tool is reported as permission_denied with no_prompt_tool', async (t) => {
    const messages = await runSingle(adapterAt(tempDir(t)), projectDir(t), 'ask me a question');
    assertWellFormed(messages);
    const denied = messages.find((m) => m.type === 'system' && m.subtype === 'permission_denied');
    assert.equal(denied.tool_name, 'AskUserQuestion');
    assert.equal(denied.decision_reason_type, 'no_prompt_tool');
  });

  test('plan mode: the plan goes to the approval callback and an approval lets the work start', async (t) => {
    const seen = [];
    const canUseTool = async (name, input, options) => {
      seen.push({ name, plan: input.plan, title: options.title });
      return { behavior: 'allow', updatedInput: input };
    };
    const messages = await runSingle(adapterAt(tempDir(t)), projectDir(t), 'make a plan', { canUseTool });
    const results = assertWellFormed(messages);
    assert.equal(results[0].subtype, 'success');
    assert.equal(seen[0].name, 'ExitPlanMode');
    assert.equal(seen[0].title, 'Claude has a plan ready');
    assert.match(seen[0].plan, /^# Plan/);
    const status = messages.find((m) => m.type === 'system' && m.subtype === 'status');
    assert.equal(status.permissionMode, 'plan');
    const toolUse = messages
      .filter((m) => m.type === 'assistant')
      .flatMap((m) => m.message.content)
      .find((b) => b.type === 'tool_use' && b.name === 'ExitPlanMode');
    const found = toolResultOf(messages, toolUse.id);
    assert.equal(found.block.content, 'User has approved your plan. You can now start coding.');
    assert.equal(found.message.tool_use_result.isAgent, false);
    assert.match(topLevelText(messages), /Plan approved — implementing\.$/);
  });

  test('plan mode: a rejected plan comes back as an error and the reply revises it', async (t) => {
    const canUseTool = async () => ({ behavior: 'deny', message: 'Add tests first' });
    const messages = await runSingle(adapterAt(tempDir(t)), projectDir(t), 'make a plan', { canUseTool });
    assertWellFormed(messages);
    const toolUse = messages
      .filter((m) => m.type === 'assistant')
      .flatMap((m) => m.message.content)
      .find((b) => b.type === 'tool_use' && b.name === 'ExitPlanMode');
    const found = toolResultOf(messages, toolUse.id);
    assert.equal(found.block.is_error, true);
    assert.equal(found.block.content, 'Add tests first');
    assert.match(topLevelText(messages), /I'll revise the plan\./);
  });

  test('elicitation: the form reaches onElicitation and an accepted answer is reported back', async (t) => {
    const requests = [];
    const onElicitation = async (request, options) => {
      requests.push({ request, requestId: options.requestId });
      return { action: 'accept', content: { username: 'octocat', remember: true } };
    };
    const messages = await runSingle(adapterAt(tempDir(t)), projectDir(t), 'elicit my credentials', { onElicitation });
    assertWellFormed(messages);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].request.serverName, 'github');
    assert.equal(requests[0].request.mode, 'form');
    assert.deepEqual(requests[0].request.requestedSchema.required, ['username']);
    assert.equal(typeof requests[0].requestId, 'string');
    assert.match(topLevelText(messages), /Signed in as octocat \(remembered\)\./);
    const states = messages
      .filter((m) => m.type === 'system' && m.subtype === 'session_state_changed')
      .map((m) => m.state);
    const waiting = states.indexOf('requires_action');
    assert.ok(waiting > 0 && states[waiting + 1] === 'running', 'the session waits for the answer, then resumes');
  });

  test('elicitation: a decline and a missing callback are both reported and the reply continues', async (t) => {
    const declined = await runSingle(adapterAt(tempDir(t)), projectDir(t), 'elicit my credentials', {
      onElicitation: async () => ({ action: 'decline' }),
    });
    assertWellFormed(declined);
    assert.match(topLevelText(declined), /You declined to sign in/);
    const cancelled = await runSingle(adapterAt(tempDir(t)), projectDir(t), 'elicit my credentials');
    assertWellFormed(cancelled);
    assert.match(topLevelText(cancelled), /The sign-in was cancelled/);
  });
});

describe('interrupt, abort and close', () => {
  test('interrupt during streaming keeps the streamed text as an aborted message and ends the turn', async (t) => {
    const channel = promptChannel();
    const uuid = randomUUID();
    channel.push(userPrompt('answer slowly', uuid));
    channel.end();
    const query = adapterAt(tempDir(t), 5).query({
      prompt: channel.stream,
      options: { cwd: projectDir(t), includePartialMessages: true },
    });
    const messages = [];
    let deltas = 0;
    for await (const message of query) {
      messages.push(message);
      if (message.type === 'stream_event' && message.event.type === 'content_block_delta') {
        deltas += 1;
        if (deltas === 3) await query.interrupt();
      }
    }
    const results = assertWellFormed(messages);
    assert.equal(results.length, 1);
    assert.equal(results[0].subtype, 'error_during_execution');
    assert.equal(results[0].terminal_reason, 'aborted_streaming');
    assert.deepEqual(results[0].errors, ['Interrupted']);
    const aborted = messages.find((m) => m.type === 'assistant' && m.aborted === true);
    assert.ok(aborted, 'the partial message is marked aborted');
    const streamed = messages
      .filter((m) => m.type === 'stream_event' && m.event.type === 'content_block_delta')
      .map((m) => m.event.delta.text)
      .join('');
    assert.equal(aborted.message.content[0].text, streamed);
    assert.ok(streamed.length > 0 && streamed.length < 60 * 'Part 1 of 60. '.length);
    assert.ok(messages.some((m) => m.type === 'user' && m.isSynthetic === true), 'the interruption marker is written');
    assert.equal(messages.at(-1).subtype, 'session_state_changed');
    assert.equal(messages.at(-1).state, 'idle');
    assertLinked(messages, [uuid]);
  });

  test('interrupt with no turn running resolves without effect', async (t) => {
    const channel = promptChannel();
    channel.end();
    const query = adapterAt(tempDir(t)).query({ prompt: channel.stream, options: { cwd: projectDir(t) } });
    assert.deepEqual(await query.interrupt(), { still_queued: [] });
    const messages = await collect(query);
    assert.deepEqual(messages.map((m) => m.subtype ?? m.type), ['init', 'autocompact_state', 'active_goal']);
  });

  test('an aborted controller ends the stream without a result, and later calls reject', async (t) => {
    const controller = new AbortController();
    const channel = promptChannel();
    channel.push(userPrompt('answer slowly'));
    channel.end();
    const query = adapterAt(tempDir(t), 5).query({
      prompt: channel.stream,
      options: { cwd: projectDir(t), includePartialMessages: true, abortController: controller },
    });
    const messages = [];
    for await (const message of query) {
      messages.push(message);
      if (message.type === 'stream_event' && message.event.type === 'content_block_delta') controller.abort();
    }
    assert.equal(messages.some((m) => m.type === 'result'), false);
    assert.equal(messages.at(-1).type, 'stream_event');
    await assert.rejects(query.setModel('claude-opus-mock'), /The query is closed\./);
  });

  test('close() ends the stream at once and every later call rejects', async (t) => {
    const channel = promptChannel();
    channel.push(userPrompt('answer slowly'));
    const query = adapterAt(tempDir(t), 5).query({
      prompt: channel.stream,
      options: { cwd: projectDir(t), includePartialMessages: true },
    });
    const messages = [];
    for await (const message of query) {
      messages.push(message);
      if (message.type === 'stream_event' && message.event.type === 'content_block_delta') query.close();
    }
    channel.end();
    assert.equal(messages.some((m) => m.type === 'result'), false);
    await assert.rejects(query.initializationResult(), /The query is closed\./);
    await assert.rejects(query.interrupt(), /The query is closed\./);
    assert.deepEqual(await query.return(), { done: true, value: undefined });
    await assert.rejects(query.throw(new Error('boom')), /boom/);
  });
});

/**
 * Whether a message ends a turn: the idle state that the turn yields last, after its result and trailing messages.
 * @param {any} message
 * @returns {boolean}
 */
function isTurnEnd(message) {
  return message.type === 'system' && message.subtype === 'session_state_changed' && message.state === 'idle';
}

/** Resolves after a short pause, so that consecutive sessions get distinct timestamps. */
function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pulls messages from a live query until one satisfies `until`. Unlike for-await, stopping here does not close
 * the query.
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

/**
 * A query whose prompt stream stays open, with its init message and the two settings messages after it already
 * consumed. It is closed when the test ends.
 * @param {import('node:test').TestContext} t
 * @param {string} stateDir
 * @param {string} cwd
 * @param {Record<string, unknown>} [options]
 */
async function openQuery(t, stateDir, cwd, options = {}) {
  return openOn(t, adapterAt(stateDir), cwd, options);
}

/**
 * The same as openQuery, on the adapter given.
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
  const init = await query.next();
  const settings = [await query.next(), await query.next()];
  assert.deepEqual(settings.map((next) => next.value.type), ['autocompact_state', 'active_goal'],
    'init is followed by the autocompact and goal settings');
  return { query, channel, init: init.value };
}

/** The Agent tool result of a turn: the top-level user message that carries the agent id. */
function agentReplyOf(messages) {
  return messages.find((m) => m.type === 'user' && m.tool_use_result?.agentId !== undefined);
}

describe('persistence across restarts', () => {
  test('a finished session is listed, read back and resumed by a second adapter over the same state', async (t) => {
    const stateDir = tempDir(t);
    const cwd = projectDir(t);
    const first = await runSingle(adapterAt(stateDir), cwd, 'Tell me something about the project');
    const sessionId = first[0].session_id;
    const second = adapterAt(stateDir);

    const listed = await second.listSessions({ dir: cwd });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].sessionId, sessionId);
    assert.equal(listed[0].summary, 'Tell me something about the project');
    assert.equal(listed[0].cwd, cwd);

    const stored = await second.getSessionMessages(sessionId, { dir: cwd });
    assert.deepEqual(stored.map((entry) => entry.type), ['user', 'assistant']);
    assert.equal(stored[0].message.content, 'Tell me something about the project');

    const resumed = await runSingle(second, cwd, 'And one more thing', { resume: sessionId });
    assertWellFormed(resumed);
    assert.equal(resumed[0].session_id, sessionId);
    const after = await second.getSessionMessages(sessionId, { dir: cwd });
    assert.deepEqual(after.map((entry) => entry.type), ['user', 'assistant', 'user', 'assistant']);
    assert.equal(after[2].message.content, 'And one more thing');
  });

  test('continue picks up the latest session of the directory', async (t) => {
    const stateDir = tempDir(t);
    const cwd = projectDir(t);
    const older = await runSingle(adapterAt(stateDir), cwd, 'First topic');
    await pause(4);
    const newer = await runSingle(adapterAt(stateDir), cwd, 'Second topic');
    const continued = await runSingle(adapterAt(stateDir), cwd, 'Keep going', { continue: true });
    assert.equal(continued[0].session_id, newer[0].session_id);
    assert.notEqual(continued[0].session_id, older[0].session_id);
  });

  test('a title option names a new session in the listing', async (t) => {
    const stateDir = tempDir(t);
    const cwd = projectDir(t);
    const messages = await runSingle(adapterAt(stateDir), cwd, 'Tell me something', { title: 'Demo session' });
    const [info] = await adapterAt(stateDir).listSessions({ dir: cwd });
    assert.equal(info.sessionId, messages[0].session_id);
    assert.equal(info.summary, 'Demo session');
    assert.equal(info.customTitle, 'Demo session');
    assert.equal(info.firstPrompt, 'Tell me something');
  });

  test('rename, tag and delete change what the listing shows, and unknown ids are reported', async (t) => {
    const stateDir = tempDir(t);
    const cwd = projectDir(t);
    const messages = await runSingle(adapterAt(stateDir), cwd, 'Tell me something');
    const sessionId = messages[0].session_id;
    const adapter = adapterAt(stateDir);

    await adapter.renameSession(sessionId, '  Renamed  ');
    await adapter.tagSession(sessionId, 'urgent');
    let info = await adapter.getSessionInfo(sessionId, { dir: cwd });
    assert.equal(info.summary, 'Renamed');
    assert.equal(info.tag, 'urgent');
    await adapter.tagSession(sessionId, null);
    info = await adapter.getSessionInfo(sessionId, { dir: cwd });
    assert.equal(info.tag, undefined);
    await assert.rejects(adapter.renameSession(sessionId, '   '), /title must be a non-empty string/);
    await assert.rejects(adapter.renameSession(randomUUID(), 'Nope'), /Session not found/);

    const elsewhere = projectDir(t);
    await assert.rejects(adapter.renameSession(sessionId, 'Scoped', { dir: elsewhere }), /Session not found/);
    await assert.rejects(adapter.tagSession(sessionId, 'scoped', { dir: elsewhere }), /Session not found/);
    await adapter.tagSession(sessionId, 'scoped', { dir: cwd });
    assert.equal((await adapter.getSessionInfo(sessionId, { dir: cwd })).tag, 'scoped');
    assert.equal(await adapter.getSessionInfo(sessionId, { dir: elsewhere }), undefined);

    assert.equal(await adapter.getSessionInfo(sessionId, { dir: join(cwd, 'elsewhere') }), undefined);
    await assert.rejects(adapter.deleteSession(sessionId, { dir: elsewhere }), /Session not found/);
    await adapter.deleteSession(sessionId, { dir: cwd });
    assert.deepEqual(await adapter.listSessions({ dir: cwd }), []);
    assert.equal(await adapter.getSessionInfo(sessionId), undefined);
    assert.deepEqual(await adapter.getSessionMessages(sessionId), []);
    await assert.rejects(adapter.deleteSession(sessionId), /Session not found/);
  });

  test('listings are newest first, filtered by directory and paged', async (t) => {
    const stateDir = tempDir(t);
    const cwd = projectDir(t);
    const elsewhere = projectDir(t);
    const ids = [];
    for (const text of ['First question', 'Second question', 'Third question']) {
      await pause(4);
      ids.push((await runSingle(adapterAt(stateDir), cwd, text))[0].session_id);
    }
    await pause(4);
    await runSingle(adapterAt(stateDir), elsewhere, 'Elsewhere');
    const adapter = adapterAt(stateDir);
    const inCwd = await adapter.listSessions({ dir: cwd });
    assert.deepEqual(inCwd.map((info) => info.sessionId), [ids[2], ids[1], ids[0]]);
    const page = await adapter.listSessions({ dir: cwd, limit: 2, offset: 1 });
    assert.deepEqual(page.map((info) => info.sessionId), [ids[1], ids[0]]);
    assert.equal((await adapter.listSessions()).length, 4);
    await assert.rejects(adapter.listSessions({ limit: -1 }), /limit must be a non-negative integer/);
  });

  test('a session that never received a prompt is stored but not listed', async (t) => {
    const stateDir = tempDir(t);
    const cwd = projectDir(t);
    const channel = promptChannel();
    channel.end();
    const messages = await collect(adapterAt(stateDir).query({ prompt: channel.stream, options: { cwd } }));
    const sessionId = messages[0].session_id;
    const adapter = adapterAt(stateDir);
    assert.deepEqual(await adapter.listSessions({ dir: cwd }), []);
    assert.equal(await adapter.getSessionInfo(sessionId), undefined);
    assert.deepEqual(await adapter.getSessionMessages(sessionId), []);
  });

  test('forkSession copies the transcript up to a message and leaves the source unchanged', async (t) => {
    const stateDir = tempDir(t);
    const cwd = projectDir(t);
    const messages = await runSingle(adapterAt(stateDir), cwd, 'Tell me something');
    const sourceId = messages[0].session_id;
    const adapter = adapterAt(stateDir);
    const before = await adapter.getSessionMessages(sourceId, { dir: cwd });
    const { sessionId: forkId } = await adapter.forkSession(sourceId, { upToMessageId: before[0].uuid });
    assert.notEqual(forkId, sourceId);
    const forked = await adapter.getSessionMessages(forkId, { dir: cwd });
    assert.deepEqual(forked.map((entry) => entry.uuid), [before[0].uuid]);
    const info = await adapter.getSessionInfo(forkId, { dir: cwd });
    assert.equal(info.summary, 'Tell me something (fork)');
    assert.equal((await adapter.getSessionMessages(sourceId, { dir: cwd })).length, before.length);
    await assert.rejects(adapter.forkSession(sourceId, { dir: projectDir(t) }), /Session not found/);
  });

  test('resumeSessionAt cuts the stored transcript, and a fork from it leaves the source as it was', async (t) => {
    const stateDir = tempDir(t);
    const cwd = projectDir(t);
    const messages = await runSingle(adapterAt(stateDir), cwd, 'Tell me something');
    const sessionId = messages[0].session_id;
    const adapter = adapterAt(stateDir);
    await pause(4);
    await runSingle(adapter, cwd, 'Tell me more', { resume: sessionId });
    const stored = await adapter.getSessionMessages(sessionId, { dir: cwd });
    assert.equal(stored.length, 4);
    const cutAt = stored[1].uuid;

    await pause(4);
    const resumed = await runSingle(adapter, cwd, 'Try again', { resume: sessionId, resumeSessionAt: cutAt });
    assertWellFormed(resumed);
    const after = await adapter.getSessionMessages(sessionId, { dir: cwd });
    assert.deepEqual(after.map((entry) => entry.type), ['user', 'assistant', 'user', 'assistant']);
    assert.equal(after[1].uuid, cutAt);
    assert.equal(after[2].message.content, 'Try again');

    await pause(4);
    const branch = await runSingle(adapter, cwd, 'Branch here', {
      resume: sessionId,
      forkSession: true,
      resumeSessionAt: cutAt,
    });
    assertWellFormed(branch);
    const branchId = branch[0].session_id;
    assert.notEqual(branchId, sessionId);
    const branched = await adapter.getSessionMessages(branchId, { dir: cwd });
    assert.deepEqual(branched.map((entry) => entry.type), ['user', 'assistant', 'user', 'assistant']);
    assert.equal(branched[2].message.content, 'Branch here');
    const source = await adapter.getSessionMessages(sessionId, { dir: cwd });
    assert.equal(source[2].message.content, 'Try again');

    await assert.rejects(
      runSingle(adapter, cwd, 'Lost', { resume: sessionId, resumeSessionAt: randomUUID() }),
      /Message not found in session/,
    );
  });

  test('resume of an unknown id, a session of another directory or an empty directory fails clearly', async (t) => {
    const stateDir = tempDir(t);
    const cwd = projectDir(t);
    const messages = await runSingle(adapterAt(stateDir), cwd, 'Tell me something');
    const sessionId = messages[0].session_id;
    await assert.rejects(runSingle(adapterAt(stateDir), cwd, 'x', { resume: randomUUID() }),
      /No conversation found with session ID/);
    await assert.rejects(runSingle(adapterAt(stateDir), projectDir(t), 'x', { resume: sessionId }),
      /No conversation found with session ID/);
    await assert.rejects(runSingle(adapterAt(stateDir), projectDir(t), 'x', { continue: true }),
      /No conversation found to continue/);
  });

  test('a sessionId that is already stored cannot start a new session', async (t) => {
    const stateDir = tempDir(t);
    const cwd = projectDir(t);
    const messages = await runSingle(adapterAt(stateDir), cwd, 'Tell me something');
    await assert.rejects(runSingle(adapterAt(stateDir), cwd, 'Again', { sessionId: messages[0].session_id }),
      /Session already exists/);
  });
});

describe('subagent transcripts', () => {
  test('an Agent call stores its nested transcript under the agent id', async (t) => {
    const stateDir = tempDir(t);
    const cwd = projectDir(t);
    const messages = await runSingle(adapterAt(stateDir), cwd, 'use an agent for this');
    assertWellFormed(messages);
    const sessionId = messages[0].session_id;
    const agentReply = agentReplyOf(messages);
    const agentId = agentReply.tool_use_result.agentId;
    const parentId = agentReply.message.content[0].tool_use_id;
    const adapter = adapterAt(stateDir);

    assert.deepEqual(await adapter.listSubagents(sessionId), [agentId]);
    const nested = await adapter.getSubagentMessages(sessionId, agentId);
    assert.deepEqual(nested.map((entry) => entry.type), ['assistant', 'assistant', 'user', 'assistant']);
    assert.ok(nested.every((entry) => entry.parent_tool_use_id === parentId));
    assert.equal(nested[0].message.content[0].text, 'Searching the source tree for route definitions.');
    assert.deepEqual(await adapter.getSubagentMessages(sessionId, 'agent_mock_99'), []);
    assert.deepEqual(await adapter.listSubagents(randomUUID()), []);
    const store = createMockStore(join(stateDir, 'mock-sessions'));
    assert.deepEqual(await store.listSubagents(sessionId, { dir: join(cwd, 'elsewhere') }), []);
    assert.equal((await store.getSubagentMessages(sessionId, agentId, { dir: cwd })).length, 4);
    assert.deepEqual(await store.getSubagentMessages(sessionId, agentId, { dir: join(cwd, 'elsewhere') }), []);
    const top = await adapter.getSessionMessages(sessionId, { dir: cwd });
    assert.ok(top.every((entry) => entry.parent_tool_use_id === null),
      'the main transcript keeps top-level entries only');
  });

  test('a fork keeps the subagent transcripts that its cut still references', async (t) => {
    const stateDir = tempDir(t);
    const cwd = projectDir(t);
    const messages = await runSingle(adapterAt(stateDir), cwd, 'use an agent for this');
    const sessionId = messages[0].session_id;
    const agentId = agentReplyOf(messages).tool_use_result.agentId;
    const adapter = adapterAt(stateDir);

    const whole = await adapter.forkSession(sessionId, { dir: cwd });
    assert.deepEqual(await adapter.listSubagents(whole.sessionId), [agentId]);
    const [firstPrompt] = await adapter.getSessionMessages(sessionId, { dir: cwd });
    const early = await adapter.forkSession(sessionId, { upToMessageId: firstPrompt.uuid });
    assert.deepEqual(await adapter.listSubagents(early.sessionId), []);
    const earlyMessages = await adapter.getSessionMessages(early.sessionId, { dir: cwd });
    assert.equal(earlyMessages.length, 1);
  });
});

describe('control methods', () => {
  test('initializationResult, supported lists and accountInfo describe the mock', async (t) => {
    const { query } = await openQuery(t, tempDir(t), projectDir(t));
    const init = await query.initializationResult();
    assert.ok(init.commands.some((command) => command.name === 'compact'));
    assert.ok(init.agents.some((agent) => agent.name === 'Explore'));
    assert.equal(init.output_style, 'default');
    assert.ok(init.models.length > 0);
    assert.equal(init.account.email, 'demo@example.com');
    assert.deepEqual(await query.accountInfo(), init.account);
    const commands = await query.supportedCommands();
    assert.deepEqual(commands.map((command) => command.name), init.commands.map((command) => command.name));
    assert.ok((await query.supportedAgents()).length >= 3);
    assert.ok((await query.supportedModels()).length >= 1);
  });

  test('mcp status, toggles and reconnects follow the mock servers', async (t) => {
    const { query } = await openQuery(t, tempDir(t), projectDir(t));
    const status = await query.mcpServerStatus();
    const github = status.find((server) => server.name === 'github');
    const filesystem = status.find((server) => server.name === 'filesystem');
    assert.equal(github.status, 'connected');
    assert.equal(github.tools[0].name, 'search_issues');
    assert.equal(filesystem.status, 'failed');
    assert.equal(filesystem.error, 'spawn npx ENOENT');
    await query.toggleMcpServer('github', false);
    assert.equal((await query.mcpServerStatus()).find((server) => server.name === 'github').status, 'disabled');
    await assert.rejects(query.reconnectMcpServer('github'), /MCP server github is disabled/);
    await query.toggleMcpServer('github', true);
    assert.equal((await query.mcpServerStatus()).find((server) => server.name === 'github').status, 'connected');
    await assert.rejects(query.toggleMcpServer('missing', true), /No MCP server named missing/);
    await assert.rejects(query.toggleMcpServer('github', 'yes'), /enabled must be a boolean/);
  });

  test('mcp resources, dynamic servers and permission overrides', async (t) => {
    const { query } = await openQuery(t, tempDir(t), projectDir(t));
    const resource = await query.readMcpResource('github', 'ui://widget/app.html');
    assert.equal(resource.contents[0].mimeType, 'text/html');
    assert.match(resource.contents[0].text, /Mock resource/);
    await assert.rejects(query.readMcpResource('filesystem', 'ui://widget/app.html'), /is not connected/);
    await assert.rejects(query.readMcpResource('github', 'https://example.com'), /ui:\/\/ scheme/);
    assert.deepEqual(await query.setMcpServers({ docs: { command: 'node' } }), {
      added: ['docs'],
      removed: [],
      errors: {},
    });
    assert.deepEqual(await query.setMcpServers({}), { added: [], removed: ['docs'], errors: {} });
    assert.deepEqual(await query.setMcpPermissionModeOverride('github', 'auto'), {});
    const warning = await query.setMcpPermissionModeOverride('unknown', 'auto');
    assert.match(warning.warning, /No MCP server named unknown/);
    await assert.rejects(query.setMcpPermissionModeOverride('github', 'always'), /mode must be default, auto or null/);
  });

  test('setPermissionMode and setModel announce a status, and the new model answers the next turn', async (t) => {
    const { query, channel } = await openQuery(t, tempDir(t), projectDir(t));
    await query.setPermissionMode('acceptEdits');
    const modeStatus = await query.next();
    assert.equal(modeStatus.value.subtype, 'status');
    assert.equal(modeStatus.value.permissionMode, 'acceptEdits');
    await query.setModel('claude-opus-mock');
    const modelStatus = await query.next();
    assert.equal(modelStatus.value.subtype, 'status');
    channel.push(userPrompt('Tell me something'));
    const turn = await pullUntil(query, (message) => message.type === 'result');
    const reply = turn.find((message) => message.type === 'assistant' && message.parent_tool_use_id === null);
    assert.equal(reply.message.model, 'claude-opus-mock');
    assert.equal(turn.at(-1).subtype, 'success');
    await assert.rejects(query.setPermissionMode('yolo'), /Unknown permission mode: yolo/);
    await assert.rejects(query.setModel(''), /model must be a non-empty string/);
  });

  test('readFile stays inside the project and rewindFiles knows the prompt checkpoints', async (t) => {
    const cwd = projectDir(t);
    const { query, channel } = await openQuery(t, tempDir(t), cwd);
    const file = await query.readFile('src/app.js');
    assert.equal(file.contents, "console.log('hi');\n");
    assert.equal(file.absPath, join(cwd, 'src', 'app.js'));
    assert.equal(await query.readFile('../outside.txt'), null);
    assert.equal(await query.readFile('missing.txt'), null);
    const truncated = await query.readFile('src/app.js', { maxBytes: 7 });
    assert.equal(truncated.truncated, true);
    assert.equal(truncated.contents, 'console');
    assert.equal((await query.readFile('src/app.js', { encoding: 'base64' })).encoding, 'base64');
    await assert.rejects(query.readFile(''), /path must be a non-empty string/);

    const prompt = userPrompt('Tell me something');
    channel.push(prompt);
    await pullUntil(query, (message) => message.type === 'result');
    assert.deepEqual(await query.rewindFiles(prompt.uuid), {
      canRewind: true,
      filesChanged: ['src/app.js'],
      insertions: 3,
      deletions: 1,
    });
    assert.deepEqual(await query.rewindFiles(randomUUID()), {
      canRewind: false,
      error: 'No checkpoint for that message',
    });
    await assert.rejects(query.rewindFiles(''), /userMessageId must be a message uuid/);
  });

  test('stopTask ends a running Agent task early and drops its nested messages', async (t) => {
    const cwd = projectDir(t);
    const channel = promptChannel();
    channel.push(userPrompt('use an agent for this'));
    const query = adapterAt(tempDir(t), 20).query({ prompt: channel.stream, options: { cwd } });
    t.after(() => {
      channel.end();
      query.close();
    });
    const seen = [];
    let started = null;
    for (;;) {
      const next = await query.next();
      if (next.done) break;
      seen.push(next.value);
      if (next.value.type === 'system' && next.value.subtype === 'task_started') {
        started = next.value;
        await query.stopTask(started.task_id);
        await query.stopTask('no-such-task');
      }
      if (next.value.type === 'result') break;
    }
    assert.ok(started, 'the Agent task starts');
    const stopped = seen.find((m) => m.type === 'system' && m.subtype === 'task_notification'
      && m.status === 'stopped');
    assert.equal(stopped.task_id, started.task_id);
    const nested = seen.filter((m) => m.parent_tool_use_id === started.tool_use_id);
    assert.equal(nested.length, 0, 'nested messages after the stop are dropped');
    assertWellFormed(seen);
    assert.equal(seen.find((m) => m.type === 'result').subtype, 'success');
    assert.equal(await query.backgroundTasks(), false);
  });

  test('settings, reloads and flag settings reach the next answers', async (t) => {
    const { query } = await openQuery(t, tempDir(t), projectDir(t));
    await query.updateSettings('localSettings', { outputStyle: 'Explanatory' });
    assert.equal((await query.initializationResult()).output_style, 'Explanatory');
    await assert.rejects(query.updateSettings('projectSettings', {}), /Unknown settings source/);
    await assert.rejects(query.updateSettings('userSettings', { outputStyle: 3 }), /outputStyle must be a string/);
    const reloaded = await query.reloadPlugins();
    assert.equal(reloaded.error_count, 0);
    assert.deepEqual(reloaded.mcpServers.map((server) => server.name), ['github', 'filesystem']);
    const skills = await query.reloadSkills();
    assert.ok(skills.skills.some((skill) => skill.name === 'code-review'));
    const styles = await query.reloadOutputStyles();
    assert.deepEqual(styles.available_output_styles, ['default', 'Proactive', 'Concise', 'Explanatory', 'Learning']);
    await query.applyFlagSettings({ effortLevel: 'high', model: 'claude-haiku-mock' });
    await assert.rejects(query.applyFlagSettings({ effortLevel: 'extreme' }), /Unknown effort level: extreme/);
  });

  test('argument checks on the remaining control methods', async (t) => {
    const { query } = await openQuery(t, tempDir(t), projectDir(t));
    await query.setMaxThinkingTokens(null);
    await query.setMaxThinkingTokens(2048);
    await assert.rejects(query.setMaxThinkingTokens(-1), /maxThinkingTokens must be a non-negative integer or null/);
    await query.seedReadState('src/app.js', Date.now());
    await assert.rejects(query.seedReadState(42, 1), /seedReadState needs a path and an mtime/);
    await assert.rejects(query.streamInput('not a stream'), /streamInput needs an async iterable/);
    assert.deepEqual(await query.interrupt(), { still_queued: [] });
  });

  test('getContextUsage and the usage response follow the session and its five-hour utilization', async (t) => {
    const { query, channel } = await openQuery(t, tempDir(t), projectDir(t));
    const fresh = await query.getContextUsage();
    assert.equal(fresh.maxTokens, 200000);
    assert.equal(fresh.isAutoCompactEnabled, true);
    assert.ok(fresh.categories.some((category) => category.kind === 'free'));
    channel.push(userPrompt('check the rate'));
    await pullUntil(query, (message) => message.type === 'result');
    const usage = await query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
    assert.equal(usage.subscription_type, 'pro');
    assert.ok(Math.abs(usage.rate_limits.five_hour.utilization - 85) < 1e-9);
    const after = await query.getContextUsage();
    assert.ok(after.totalTokens > fresh.totalTokens);
    assert.notEqual(after.apiUsage, null);
  });
});

describe('store files', () => {
  test('the state directory is 0700, session files are 0600, and no temporary files are left behind', async (t) => {
    const stateDir = tempDir(t);
    await runSingle(adapterAt(stateDir), projectDir(t), 'Tell me something');
    const dir = join(stateDir, 'mock-sessions');
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    const names = readdirSync(dir);
    assert.equal(names.length, 1);
    assert.ok(names.every((name) => name.endsWith('.json')), 'only session files remain');
    for (const name of names) assert.equal(statSync(join(dir, name)).mode & 0o777, 0o600);
  });

  test('a corrupt session file is reported as invalid and is never read as a session', async (t) => {
    const stateDir = tempDir(t);
    const cwd = projectDir(t);
    const messages = await runSingle(adapterAt(stateDir), cwd, 'Tell me something');
    const sessionId = messages[0].session_id;
    writeFileSync(join(stateDir, 'mock-sessions', `${sessionId}.json`), '{ not json');
    const adapter = adapterAt(stateDir);
    const invalid = { message: `Mock session file is invalid: ${sessionId}` };
    await assert.rejects(adapter.getSessionInfo(sessionId), invalid);
    await assert.rejects(adapter.getSessionMessages(sessionId), invalid);
    await assert.rejects(adapter.listSessions({ dir: cwd }), /Mock session file is invalid/);
    await assert.rejects(runSingle(adapter, cwd, 'Again', { resume: sessionId }), /Mock session file is invalid/);
  });

  test('a session file stored under another id is invalid', async (t) => {
    const stateDir = tempDir(t);
    const messages = await runSingle(adapterAt(stateDir), projectDir(t), 'Tell me something');
    const sessionId = messages[0].session_id;
    const dir = join(stateDir, 'mock-sessions');
    const copyId = randomUUID();
    writeFileSync(join(dir, `${copyId}.json`), readFileSync(join(dir, `${sessionId}.json`), 'utf8'), { mode: 0o600 });
    await assert.rejects(adapterAt(stateDir).getSessionInfo(copyId), {
      message: `Mock session file is invalid: ${copyId}`,
    });
  });

  test('a record written before generated titles existed lists under its first prompt', async (t) => {
    const stateDir = tempDir(t);
    const cwd = projectDir(t);
    const prompt = 'Please tell me something about the project and the tests';
    const messages = await runSingle(adapterAt(stateDir), cwd, prompt);
    const file = join(stateDir, 'mock-sessions', `${messages[0].session_id}.json`);
    const record = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(record.generatedTitle, 'Please tell me something about the project and');
    delete record.generatedTitle;
    writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
    const [listed] = await adapterAt(stateDir).listSessions({ dir: cwd });
    assert.equal(listed.summary, prompt);
  });

  test('store arguments are checked, and unknown ids answer empty or undefined', async (t) => {
    assert.throws(() => createMockStore(''), /createMockStore needs a directory/);
    const store = createMockStore(join(tempDir(t), 'nested', 'store'));
    assert.equal(store.read(randomUUID()), undefined);
    assert.equal(store.read('not-a-uuid'), undefined);
    assert.deepEqual(await store.listSessions(), []);
    assert.equal(await store.getSessionInfo('not-a-uuid'), undefined);
    assert.deepEqual(await store.getSessionMessages('not-a-uuid'), []);
    assert.deepEqual(await store.listSubagents('not-a-uuid'), []);
    assert.deepEqual(await store.getSubagentMessages(randomUUID(), 'agent_mock_1'), []);
    await assert.rejects(store.renameSession(randomUUID(), 'Nope'), /Session not found/);
    await assert.rejects(store.tagSession(randomUUID(), 'nope'), /Session not found/);
    await assert.rejects(store.forkSession(randomUUID()), /Session not found/);
    await assert.rejects(store.deleteSession('not-a-uuid'), /Session not found/);
    await assert.rejects(store.getSessionMessages(randomUUID(), { offset: -1 }),
      /offset must be a non-negative integer/);
    const upper = newRecord({ sessionId: randomUUID().toUpperCase(), cwd: projectDir(t) });
    assert.throws(() => store.create(upper), /Session id must be a lowercase UUID/);
    const record = store.create(newRecord({ sessionId: randomUUID(), cwd: projectDir(t) }));
    assert.throws(() => store.create(record), /Session already exists/);
  });
});

describe('pacing and adapter setup', () => {
  test('the pacing is the explicit value, or the default when there is none', () => {
    assert.equal(resolveDelay(undefined), DEFAULT_DELAY_MS);
    assert.equal(resolveDelay(0), 0);
    assert.equal(resolveDelay(MAX_DELAY_MS), MAX_DELAY_MS);
    assert.equal(resolveDelay(' 25 '), 25, 'a string from the environment is trimmed and parsed');
    assert.throws(() => resolveDelay('fast'), RangeError);
    assert.throws(() => resolveDelay(MAX_DELAY_MS + 1), RangeError);
    assert.equal(delayFromValue('7'), 7);
    assert.equal(delayFromValue(MAX_DELAY_MS), MAX_DELAY_MS);
    for (const bad of [-1, 1.5, Number.NaN, MAX_DELAY_MS + 1, '', '  ', 'x', null, true]) {
      assert.throws(() => delayFromValue(bad), RangeError, String(bad));
    }
  });

  test('createMockAdapter describes itself, logs its pacing and rejects a bad pacing', (t) => {
    const stateDir = tempDir(t);
    const logged = [];
    const log = { debug() {}, warn() {}, error() {}, info: (message, fields) => logged.push({ message, fields }) };
    const explicit = createMockAdapter({ config: { stateDir }, log, delayMs: 3 });
    assert.equal(explicit.kind, 'mock');
    assert.equal(explicit.sdkVersion, 'mock');
    createMockAdapter({ config: { stateDir }, log, delayMs: '9' });
    createMockAdapter({ config: { stateDir }, log });
    assert.deepEqual(logged.map((entry) => entry.fields.delayMs), [3, 9, DEFAULT_DELAY_MS]);
    assert.equal(logged[0].message, 'engine adapter ready');
    assert.throws(() => createMockAdapter({ config: { stateDir }, log, delayMs: MAX_DELAY_MS + 1 }), RangeError);
    assert.throws(() => createMockAdapter({ config: { stateDir }, log, delayMs: 2.5 }), RangeError);
  });
});

describe('query option checks', () => {
  test('invalid options are rejected before any session is stored', (t) => {
    const stateDir = tempDir(t);
    const adapter = adapterAt(stateDir);
    const cases = [
      [{ sessionId: 'not-a-uuid' }, /sessionId must be a UUID/],
      [{ resume: 'nope' }, /resume must be a session UUID/],
      [{ resume: randomUUID(), continue: true }, /resume and continue are exclusive/],
      [{ resumeSessionAt: 'abc' }, /resumeSessionAt needs resume or continue/],
      [{ resume: randomUUID(), resumeSessionAt: '' }, /resumeSessionAt must be a message uuid/],
      [{ sessionId: randomUUID(), resume: randomUUID() }, /needs forkSession/],
      [{ permissionMode: 'yolo' }, /Unknown permission mode: yolo/],
      [{ effort: 'extreme' }, /Unknown effort level: extreme/],
      [{ model: '  ' }, /model must be a non-empty string/],
      [{ cwd: 'relative/dir' }, /cwd must be an absolute path/],
      [{ title: '' }, /title must be a non-empty string/],
      [{ settings: 'fast' }, /settings must be an object/],
      [{ perTaskStopAffordance: 'yes' }, /perTaskStopAffordance must be a boolean/],
      [{ settingSources: ['user', 'global'] }, /settingSources must only list user, project, local/],
      [{ settingSources: 'user' }, /settingSources must only list user, project, local/],
    ];
    for (const [options, pattern] of cases) {
      assert.throws(() => adapter.query({ prompt: 'x', options: { cwd: projectDir(t), ...options } }), pattern,
        JSON.stringify(options));
    }
    assert.throws(() => adapter.query({ prompt: 42, options: { cwd: projectDir(t) } }),
      /prompt must be a string or an async iterable/);
    const store = createMockStore(join(stateDir, 'checked'));
    assert.throws(() => createMockQuery({ prompt: 'x', options: { cwd: projectDir(t) }, store, delayMs: 1.5 }),
      RangeError);
    for (const backgroundTiming of [{ waitMs: -1 }, { runMs: 1.5 }]) {
      assert.throws(() => adapterWith(stateDir, { backgroundTiming }).query({
        prompt: 'x',
        options: { cwd: projectDir(t) },
      }), /backgroundTiming\.\w+ must be a non-negative integer/, JSON.stringify(backgroundTiming));
    }
    assert.deepEqual(readdirSync(join(stateDir, 'mock-sessions')), []);
  });

  test('a plain string prompt runs one turn in a fresh session', async (t) => {
    const messages = await collect(adapterAt(tempDir(t)).query({
      prompt: 'Tell me something',
      options: { cwd: projectDir(t) },
    }));
    assertWellFormed(messages);
    assert.equal(messages.at(-1).subtype, 'session_state_changed');
  });
});

describe('turn linkage', () => {
  test('every assistant message, stream event and result carries the uuid of its turn prompt', async (t) => {
    const cases = [
      ['Tell me something', {}],
      ['run the tool', {}],
      ['run the tool', { canUseTool: allowAll }],
      ['run the tool', { canUseTool: async () => ({ behavior: 'deny', message: 'Stop now', interrupt: true }) }],
      ['use an agent for this', { canUseTool: allowAll }],
      ['ask me a question', { canUseTool: pickFirstAnswers }],
      ['make a plan', { canUseTool: allowAll }],
      ['produce an error', {}],
      ['think it through first', {}],
      ['start a background build', {}],
      ['refusal-none please', {}],
      ['trigger a refusal', {}],
      ['install the plugin', {}],
    ];
    for (const [text, options] of cases) {
      const uuid = randomUUID();
      const messages = await runSingle(adapterAt(tempDir(t)), projectDir(t), text, options, uuid);
      assertWellFormed(messages);
      assertLinked(messages, [uuid]);
    }
  });

  test('two turns of one session each link to the prompt that started them', async (t) => {
    const { query, channel } = await openQuery(t, tempDir(t), projectDir(t), { includePartialMessages: true });
    const first = randomUUID();
    channel.push(userPrompt('Tell me something', first));
    assertLinked(await pullUntil(query, (message) => message.type === 'result'), [first]);
    const second = randomUUID();
    channel.push(userPrompt('Tell me more', second));
    assertLinked(await pullUntil(query, (message) => message.type === 'result'), [second]);
  });

  test('prompts already waiting when a turn starts are answered by that turn, in arrival order', async (t) => {
    const stateDir = tempDir(t);
    const cwd = projectDir(t);
    const channel = promptChannel();
    const [first, second, third] = [randomUUID(), randomUUID(), randomUUID()];
    channel.push(userPrompt('Tell me something', first));
    channel.push(userPrompt('Tell me more', second));
    channel.push(userPrompt('And one more thing', third));
    const adapter = adapterAt(stateDir);
    const query = adapter.query({ prompt: channel.stream, options: { cwd, includePartialMessages: true } });
    t.after(() => {
      channel.end();
      query.close();
    });
    const batch = await pullUntil(query, (message) => message.type === 'result');
    assertLinked(batch, [first, second, third]);
    const [result] = batch.filter((message) => message.type === 'result');
    assert.equal(result.user_message_uuid, third, 'the batch is keyed by its last prompt, as the SDK reports it');
    const stored = await adapter.getSessionMessages(batch[0].session_id, { dir: cwd });
    assert.deepEqual(stored.map((entry) => entry.type), ['user', 'user', 'user', 'assistant']);
    assert.deepEqual(stored.slice(0, 3).map((entry) => entry.uuid), [first, second, third]);

    const fourth = randomUUID();
    channel.push(userPrompt('Tell me something else', fourth));
    assertLinked(await pullUntil(query, (message) => message.type === 'result'), [fourth]);
  });

  test('a prompt that does not query is stored, starts no turn and is not listed as answered', async (t) => {
    const stateDir = tempDir(t);
    const cwd = projectDir(t);
    const channel = promptChannel();
    const [first, note, second] = [randomUUID(), randomUUID(), randomUUID()];
    channel.push(userPrompt('Tell me something', first));
    channel.push({ ...userPrompt('Keep this note', note), shouldQuery: false });
    channel.push(userPrompt('Tell me more', second));
    const adapter = adapterAt(stateDir);
    const query = adapter.query({ prompt: channel.stream, options: { cwd, includePartialMessages: true } });
    t.after(() => {
      channel.end();
      query.close();
    });
    const turn = await pullUntil(query, (message) => message.type === 'result');
    assertLinked(turn, [first, second]);
    const stored = await adapter.getSessionMessages(turn[0].session_id, { dir: cwd });
    assert.deepEqual(stored.map((entry) => entry.type), ['user', 'user', 'user', 'assistant']);
    assert.deepEqual(stored.slice(0, 3).map((entry) => entry.uuid), [first, note, second]);
  });

  test('a prompt sent without a uuid gets one, and its turn is linked to it', async (t) => {
    const stateDir = tempDir(t);
    const cwd = projectDir(t);
    const channel = promptChannel();
    channel.push({ type: 'user', message: { role: 'user', content: 'Tell me something' }, parent_tool_use_id: null });
    channel.end();
    const adapter = adapterAt(stateDir);
    const query = adapter.query({ prompt: channel.stream, options: { cwd, includePartialMessages: true } });
    const messages = await collect(query);
    assertWellFormed(messages);
    const [result] = messages.filter((message) => message.type === 'result');
    assert.equal(typeof result.user_message_uuid, 'string');
    assertLinked(messages, [result.user_message_uuid]);
    const stored = await adapter.getSessionMessages(messages[0].session_id, { dir: cwd });
    assert.equal(stored[0].uuid, result.user_message_uuid);
  });
});

describe('runtime messages around each turn', () => {
  test('a prompt goes queued, started and completed around its turn', async (t) => {
    const uuid = randomUUID();
    const messages = await runSingle(adapterAt(tempDir(t)), projectDir(t), 'Tell me something', {}, uuid);
    const lifecycle = messages.filter((m) => m.type === 'command_lifecycle');
    assert.deepEqual(lifecycle.map((m) => m.state), ['queued', 'started', 'completed']);
    assert.ok(lifecycle.every((m) => m.command_uuid === uuid), 'every state names the prompt');
    const indexOf = (/** @type {(message: any) => boolean} */ predicate) => messages.findIndex(predicate);
    const queued = indexOf((m) => m.type === 'command_lifecycle' && m.state === 'queued');
    const started = indexOf((m) => m.type === 'command_lifecycle' && m.state === 'started');
    const reply = indexOf((m) => m.type === 'assistant');
    const result = indexOf((m) => m.type === 'result');
    const completed = indexOf((m) => m.type === 'command_lifecycle' && m.state === 'completed');
    assert.ok(queued < started && started < reply, 'queued, then started, then the reply');
    assert.ok(result < completed, 'completed comes after the result');
  });

  test('a batch of prompts is queued one by one, started together and completed after the result', async (t) => {
    const channel = promptChannel();
    const [first, second] = [randomUUID(), randomUUID()];
    channel.push(userPrompt('Tell me something', first));
    channel.push(userPrompt('Tell me more', second));
    channel.end();
    const query = adapterAt(tempDir(t)).query({ prompt: channel.stream, options: { cwd: projectDir(t) } });
    const messages = await collect(query);
    const states = messages.filter((m) => m.type === 'command_lifecycle').map((m) => [m.state, m.command_uuid]);
    assert.deepEqual(states, [
      ['queued', first],
      ['queued', second],
      ['started', first],
      ['started', second],
      ['completed', first],
      ['completed', second],
    ]);
    assert.equal(messages.filter((m) => m.type === 'result').length, 1, 'one turn answers both prompts');
  });

  test('a prompt that does not query is queued, started and completed without a turn of its own', async (t) => {
    const channel = promptChannel();
    const [first, note] = [randomUUID(), randomUUID()];
    channel.push(userPrompt('Tell me something', first));
    channel.push({ ...userPrompt('Keep this note', note), shouldQuery: false });
    channel.end();
    const query = adapterAt(tempDir(t)).query({ prompt: channel.stream, options: { cwd: projectDir(t) } });
    const messages = await collect(query);
    const noteStates = messages
      .filter((m) => m.type === 'command_lifecycle' && m.command_uuid === note)
      .map((m) => m.state);
    assert.deepEqual(noteStates, ['queued', 'started', 'completed']);
    assert.equal(messages.filter((m) => m.type === 'result').length, 1);
  });

  test('each tool that runs is announced by one task_summary before its result', async (t) => {
    const cases = [
      ['run the tool', { canUseTool: allowAll }, ['Running ls -la']],
      ['edit the server file', { canUseTool: allowAll }, ['Reading src/app.js', 'Editing src/app.js']],
      ['ask me a question', { canUseTool: pickFirstAnswers }, ['Asking 2 questions']],
      ['make a plan', { canUseTool: allowAll }, ['Presenting the plan for approval']],
      ['track the todo list', {}, ['Updating the todo list']],
      ['use an agent for this', {}, ['Running the Explore agent']],
      ['search the web', {}, ['Searching the web for "claude agent sdk session files"',
        'Fetching https://example.com/docs']],
      ['check mcp issues', { canUseTool: allowAll }, ['Searching GitHub issues']],
      ['run a hook first', {}, ['Running git status --short']],
      ['start a background build', {}, ['Running npm run build']],
    ];
    for (const [text, options, details] of cases) {
      const messages = await runSingle(adapterAt(tempDir(t)), projectDir(t), text, options);
      const summaries = messages.filter((m) => m.type === 'system' && m.subtype === 'task_summary');
      assert.deepEqual(summaries.map((m) => m.detail), details, text);
      const answered = messages
        .filter((m) => m.type === 'user' && m.parent_tool_use_id === null && Array.isArray(m.message.content))
        .flatMap((m) => m.message.content)
        .filter((block) => block.type === 'tool_result' && block.is_error !== true);
      assert.equal(answered.length, summaries.length, `${text}: one summary per tool that runs`);
      for (const summary of summaries) {
        const earlier = messages.slice(0, messages.indexOf(summary));
        assert.ok(earlier.some((m) => m.type === 'assistant' && m.message.content.some((b) => b.type === 'tool_use')),
          `${text}: the summary follows the tool call`);
      }
    }
  });

  test('each result is followed by a post_turn_summary that names the last assistant message', async (t) => {
    const messages = await runSingle(adapterAt(tempDir(t)), projectDir(t), 'Tell me something about the project');
    const summaries = messages.filter((m) => m.type === 'system' && m.subtype === 'post_turn_summary');
    assert.equal(summaries.length, 1);
    const [summary] = summaries;
    const last = messages.filter((m) => m.type === 'assistant' && m.parent_tool_use_id === null).at(-1);
    assert.equal(summary.summarizes_uuid, last.uuid);
    assert.equal(summary.status_category, 'review_ready');
    assert.equal(summary.needs_action, '');
    assert.equal(summary.status_detail, 'This reply comes from the deterministic mock engine.');
    assert.ok(messages.indexOf(summary) > messages.findIndex((m) => m.type === 'result'), 'it follows the result');
  });

  test('interrupted and failed turns each get a status line of their own', async (t) => {
    const channel = promptChannel();
    channel.push(userPrompt('answer slowly'));
    channel.end();
    const query = adapterAt(tempDir(t), 5).query({
      prompt: channel.stream,
      options: { cwd: projectDir(t), includePartialMessages: true },
    });
    const interrupted = [];
    let deltas = 0;
    for await (const message of query) {
      interrupted.push(message);
      if (message.type === 'stream_event' && message.event.type === 'content_block_delta') {
        deltas += 1;
        if (deltas === 3) await query.interrupt();
      }
    }
    const aborted = interrupted.find((m) => m.type === 'assistant' && m.aborted === true);
    const cut = interrupted.find((m) => m.type === 'system' && m.subtype === 'post_turn_summary');
    assert.equal(cut.status_detail, 'Turn was interrupted.');
    assert.equal(cut.summarizes_uuid, aborted.uuid);

    const failed = await runSingle(adapterAt(tempDir(t)), projectDir(t), 'produce an error');
    const failure = failed.find((m) => m.type === 'system' && m.subtype === 'post_turn_summary');
    assert.equal(failure.status_detail, 'Turn failed: Mock failure requested.');
    assert.equal(failure.summarizes_uuid, failed.find((m) => m.type === 'result').uuid,
      'a turn with no assistant message names its result');

    const rejected = await runSingle(adapterAt(tempDir(t)), projectDir(t), 'check the auth token');
    const rejection = rejected.find((m) => m.type === 'system' && m.subtype === 'post_turn_summary');
    assert.equal(rejection.status_detail, 'Turn failed: Invalid API key · Please run /login.');
  });

  test('the first turn names a session without a custom title, and later turns leave the name alone', async (t) => {
    const stateDir = tempDir(t);
    const cwd = projectDir(t);
    const { query, channel } = await openQuery(t, stateDir, cwd);
    channel.push(userPrompt('Please tell me something about the project and the tests'));
    const first = await pullUntil(query, isTurnEnd);
    const titles = first.filter((m) => m.type === 'system' && m.subtype === 'session_title_changed');
    assert.deepEqual(titles.map((m) => m.title), ['Please tell me something about the project and']);
    const listed = await adapterAt(stateDir).listSessions({ dir: cwd });
    assert.equal(listed[0].summary, titles[0].title, 'the listing shows the title');

    channel.push(userPrompt('Tell me more'));
    const second = await pullUntil(query, isTurnEnd);
    assert.equal(second.some((m) => m.type === 'system' && m.subtype === 'session_title_changed'), false);
  });

  test('a session with a custom title keeps it, and no title message is sent', async (t) => {
    const stateDir = tempDir(t);
    const cwd = projectDir(t);
    const { query, channel } = await openQuery(t, stateDir, cwd, { title: 'Named by the host' });
    channel.push(userPrompt('Tell me something'));
    const turn = await pullUntil(query, isTurnEnd);
    assert.equal(turn.some((m) => m.type === 'system' && m.subtype === 'session_title_changed'), false);
    const listed = await adapterAt(stateDir).listSessions({ dir: cwd });
    assert.equal(listed[0].summary, 'Named by the host');
  });

  test('autocompact_state and active_goal come once each, right after init', async (t) => {
    const messages = await runSingle(adapterAt(tempDir(t)), projectDir(t), 'Tell me something');
    assert.deepEqual(messages.slice(0, 3).map((m) => m.type), ['system', 'autocompact_state', 'active_goal']);
    assert.deepEqual(messages[1].value, {
      enabled: true,
      effective_window: 200000,
      threshold: 167000,
      enforced: true,
      source: 'clientdata',
    });
    assert.equal(messages[2].value, null);
    assert.equal(messages.filter((m) => m.type === 'autocompact_state').length, 1);
    assert.equal(messages.filter((m) => m.type === 'active_goal').length, 1);
  });

  test('status messages name the prompts of their turn, and a notice between turns names none', async (t) => {
    const compactUuid = randomUUID();
    const compact = await runSingle(adapterAt(tempDir(t)), projectDir(t), '/compact', {}, compactUuid);
    const compacting = compact.filter((m) => m.type === 'system' && m.subtype === 'status');
    assert.equal(compacting.length, 2);
    for (const status of compacting) assert.deepEqual(status.user_message_uuids, [compactUuid]);

    const planUuid = randomUUID();
    const plan = await runSingle(adapterAt(tempDir(t)), projectDir(t), 'make a plan',
      { canUseTool: allowAll }, planUuid);
    const planning = plan.filter((m) => m.type === 'system' && m.subtype === 'status');
    assert.deepEqual(planning.map((m) => m.permissionMode), ['plan']);
    assert.deepEqual(planning[0].user_message_uuids, [planUuid]);

    const { query } = await openQuery(t, tempDir(t), projectDir(t));
    await query.setPermissionMode('acceptEdits');
    assert.deepEqual((await query.next()).value.user_message_uuids, []);
  });
});

/** The tool_result that answers the Bash call of a turn, with the message that carries it. */
function bashResultOf(messages) {
  const toolUse = messages
    .filter((m) => m.type === 'assistant')
    .flatMap((m) => m.message.content)
    .find((b) => b.type === 'tool_use' && b.name === 'Bash');
  return toolResultOf(messages, toolUse.id);
}

describe('permission suggestions', () => {
  test('a Bash request offers two suggestions, and the approval records the ones it returns', async (t) => {
    const cwd = projectDir(t);
    const offered = [];
    const canUseTool = async (name, input, options) => {
      offered.push(options.suggestions);
      return { behavior: 'allow', updatedInput: input, updatedPermissions: [options.suggestions[1]] };
    };
    const messages = await runSingle(adapterAt(tempDir(t)), cwd, 'run the tool', { canUseTool });
    assertWellFormed(messages);
    assert.deepEqual(offered[0], [
      {
        type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }], behavior: 'allow',
        destination: 'localSettings',
      },
      { type: 'addDirectories', directories: [join(cwd, '..')], destination: 'session' },
    ]);
    assert.deepEqual(bashResultOf(messages).message.tool_use_result.updatedPermissions, [offered[0][1]]);
  });

  test('an approval that returns both suggestions records both, in the order returned', async (t) => {
    const canUseTool = async (name, input, options) => ({
      behavior: 'allow',
      updatedInput: input,
      updatedPermissions: [...options.suggestions].reverse(),
    });
    const messages = await runSingle(adapterAt(tempDir(t)), projectDir(t), 'run the tool', { canUseTool });
    assertWellFormed(messages);
    const recorded = bashResultOf(messages).message.tool_use_result.updatedPermissions;
    assert.deepEqual(recorded.map((update) => update.type), ['addDirectories', 'addRules']);
  });

  test('an approval without updatedPermissions records none', async (t) => {
    const messages = await runSingle(adapterAt(tempDir(t)), projectDir(t), 'run the tool', { canUseTool: allowAll });
    assertWellFormed(messages);
    assert.deepEqual(bashResultOf(messages).message.tool_use_result.updatedPermissions, []);
  });
});

describe('api retries and failures', () => {
  test('the auth scenario retries twice with a 401 notice each time, then fails with the sign-in hint', async (t) => {
    const messages = await runSingle(adapterAt(tempDir(t)), projectDir(t), 'check the auth token');
    const results = assertWellFormed(messages);
    const retries = messages.filter((m) => m.type === 'system' && m.subtype === 'api_retry');
    assert.deepEqual(retries.map((retry) => retry.attempt), [1, 2]);
    assert.deepEqual(retries.map((retry) => retry.retry_delay_ms), [500, 1000]);
    for (const retry of retries) {
      assert.equal(retry.max_retries, 2);
      assert.equal(retry.error, 'authentication_failed');
      assert.equal(retry.error_status, 401);
    }
    assert.equal(results[0].subtype, 'error_during_execution');
    assert.equal(results[0].is_error, true);
    assert.deepEqual(results[0].errors, ['Invalid API key · Please run /login']);
    assert.equal(results[0].terminal_reason, 'model_error');
  });
});

describe('model aliases', () => {
  test('each alias names the wire id it resolves to, so the init model matches one row', async (t) => {
    const { query, init } = await openQuery(t, tempDir(t), projectDir(t));
    const expected = {
      default: 'claude-sonnet-mock',
      sonnet: 'claude-sonnet-mock',
      opus: 'claude-opus-mock',
      haiku: 'claude-haiku-mock',
    };
    const initRows = (await query.initializationResult()).models;
    const listed = await query.supportedModels();
    for (const rows of [initRows, listed]) {
      assert.deepEqual(Object.fromEntries(rows.map((row) => [row.value, row.resolvedModel])), expected);
    }
    assert.equal(init.model, 'claude-sonnet-mock');
    assert.ok(initRows.some((row) => row.resolvedModel === init.model));
  });
});

/** Whether an assistant message calls a tool. */
function callsTool(message) {
  return message.type === 'assistant' && message.message.content.some((block) => block.type === 'tool_use');
}

/** The task_started message of a task, or undefined. */
function taskStartedOf(messages) {
  return messages.find((m) => m.type === 'system' && m.subtype === 'task_started');
}

/** The task_notification messages, in order. */
function notificationsOf(messages) {
  return messages.filter((m) => m.type === 'system' && m.subtype === 'task_notification');
}

/** The background_tasks_changed messages, in order. */
function listingsOf(messages) {
  return messages.filter((m) => m.type === 'system' && m.subtype === 'background_tasks_changed');
}

/** The fast mode state of a message, with the reason it is off (null when there is none). */
function fastOf(message) {
  return { state: message.fast_mode_state, reason: message.fast_mode_disabled_reason ?? null };
}

/**
 * Runs one turn on an open query and returns its result.
 * @param {any} query
 * @param {{push: (message: any) => void}} channel
 * @param {string} [text]
 */
async function turnResult(query, channel, text = 'Tell me something') {
  channel.push(userPrompt(text));
  const turn = await pullUntil(query, isTurnEnd);
  return turn.find((message) => message.type === 'result');
}

/**
 * Pulls messages until `done` accepts everything pulled so far, the messages passed in included. Unlike pullUntil, the
 * check sees the whole list, so an event that arrived earlier than expected does not leave the pull waiting for it.
 * @param {any} query
 * @param {(messages: any[]) => boolean} done
 * @param {any[]} [messages] messages already pulled; the new ones are appended to them
 */
async function pullAll(query, done, messages = []) {
  while (!done(messages)) {
    const next = await query.next();
    if (next.done) break;
    messages.push(next.value);
  }
  return messages;
}

/**
 * Starts a build and moves it to the background as soon as its call arrives, as Ctrl+B does. The command is still in
 * the foreground while its call is pending, so the move cannot miss it.
 * @param {any} query
 * @param {{push: (message: any) => void}} channel
 * @returns {Promise<{before: any[], toolUseId: string}>} the messages up to the call, and the call's id
 */
async function startBuildInBackground(query, channel) {
  channel.push(userPrompt('start a background build'));
  const before = await pullUntil(query, callsTool);
  const toolUse = before.at(-1).message.content.find((block) => block.type === 'tool_use');
  assert.equal(await query.backgroundTasks(toolUse.id), true, 'the running command moves to the background');
  return { before, toolUseId: toolUse.id };
}

/**
 * Starts a build, moves it to the background, then interrupts a second turn while it streams. Returns the messages of
 * the interrupted turn, and what the session delivers once its prompts have ended.
 * @param {import('node:test').TestContext} t
 * @param {Record<string, unknown>} options the query options
 */
async function interruptWhileBuilding(t, options) {
  const adapter = adapterWith(tempDir(t), { delayMs: 5, backgroundTiming: { waitMs: 25, runMs: 800 } });
  const { query, channel } = await openOn(t, adapter, projectDir(t), { includePartialMessages: true, ...options });
  const { before } = await startBuildInBackground(query, channel);
  await pullAll(query, (list) => list.some(isTurnEnd), before);
  channel.push(userPrompt('answer slowly'));
  await pullUntil(query, (m) => m.type === 'stream_event' && m.event.type === 'content_block_delta');
  await query.interrupt();
  const cut = await pullUntil(query, isTurnEnd);
  channel.end();
  return { cut, tail: await collect(query) };
}

describe('thinking summaries', () => {
  const SUMMARY = 'The request is simple, so I will answer it directly.';
  const thinkingOf = (/** @type {any[]} */ messages) => messages
    .filter((m) => m.type === 'assistant')
    .flatMap((m) => m.message.content)
    .find((block) => block.type === 'thinking');
  const thinkingDeltasOf = (/** @type {any[]} */ messages) => messages
    .filter((m) => m.type === 'stream_event' && m.event.type === 'content_block_delta'
      && m.event.delta.type === 'thinking_delta');

  test('the thinking text is kept only when the query passes --thinking-display summarized', async (t) => {
    const cwd = projectDir(t);
    const hidden = await runSingle(adapterAt(tempDir(t)), cwd, 'think it through first');
    assertWellFormed(hidden);
    assert.equal(thinkingOf(hidden).thinking, '');
    assert.equal(thinkingOf(hidden).signature, 'mock-thinking-signature');
    const shown = await runSingle(adapterAt(tempDir(t)), cwd, 'think it through first', {
      extraArgs: { 'thinking-display': 'summarized' },
    });
    assert.equal(thinkingOf(shown).thinking, SUMMARY);
    assert.equal(topLevelText(shown), 'Here is the answer, reached after thinking it through.');
  });

  test('a streamed thinking block sends its text as one thinking_delta, and only when summaries are on', async (t) => {
    const cwd = projectDir(t);
    const shown = await runSingle(adapterAt(tempDir(t)), cwd, 'think it through first', {
      extraArgs: { 'thinking-display': 'summarized' },
    });
    const deltas = thinkingDeltasOf(shown);
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0].event.delta.thinking, SUMMARY);
    assert.equal(deltas[0].event.delta.estimated_tokens, null);
    const hidden = await runSingle(adapterAt(tempDir(t)), cwd, 'think it through first');
    assert.equal(thinkingDeltasOf(hidden).length, 0);
  });

  test('like a non-interactive runtime, only the display flag decides, not showThinkingSummaries', async (t) => {
    const cwd = projectDir(t);
    const fromFiles = adapterWith(tempDir(t), { resolvedSettings: { showThinkingSummaries: true } });
    assert.equal(thinkingOf(await runSingle(fromFiles, cwd, 'think it through first')).thinking, '');

    const flagged = adapterWith(tempDir(t), { resolvedSettings: { showThinkingSummaries: false } });
    const shown = await runSingle(flagged, cwd, 'think it through first', {
      settings: { showThinkingSummaries: false },
      extraArgs: { 'thinking-display': 'summarized' },
    });
    assert.equal(thinkingOf(shown).thinking, SUMMARY);

    const omitted = await runSingle(adapterAt(tempDir(t)), cwd, 'think it through first', {
      extraArgs: { 'thinking-display': 'omitted' },
    });
    assert.equal(thinkingOf(omitted).thinking, '');
  });

  test('extraArgs must map flag names to strings or null', async (t) => {
    const cwd = projectDir(t);
    for (const extraArgs of [[], 'thinking-display', { 'thinking-display': 1 }]) {
      assert.throws(() => adapterAt(tempDir(t)).query({ prompt: 'hi', options: { cwd, extraArgs } }),
        /extraArgs must map flag names to strings or null/);
    }
  });

  test('resolveSettings reports the files, every source by default, and nothing for an empty list', async (t) => {
    const adapter = adapterWith(tempDir(t), { resolvedSettings: { showThinkingSummaries: true } });
    const cwd = projectDir(t);
    assert.deepEqual(await adapter.resolveSettings({ cwd, settingSources: ['user', 'project', 'local'] }), {
      effective: { showThinkingSummaries: true },
      provenance: {},
      sources: [],
    });
    assert.deepEqual((await adapter.resolveSettings({ cwd })).effective, { showThinkingSummaries: true });
    assert.deepEqual((await adapter.resolveSettings({ cwd, settingSources: [] })).effective, {});
  });
});

describe('fast mode', () => {
  test('fast mode stays off, with its reason, until the host opts in and the model supports it', async (t) => {
    const { query, channel, init } = await openQuery(t, tempDir(t), projectDir(t));
    assert.deepEqual(fastOf(init), { state: 'off', reason: 'sdk_opt_in_required' });

    await query.applyFlagSettings({ fastMode: true });
    assert.equal((await query.next()).value.subtype, 'status');
    assert.deepEqual(fastOf(await turnResult(query, channel)), { state: 'off', reason: 'model_not_allowed' });

    await query.applyFlagSettings({ model: 'claude-opus-mock' });
    assert.equal((await query.next()).value.subtype, 'status');
    assert.deepEqual(fastOf(await turnResult(query, channel)), { state: 'on', reason: null });

    await query.applyFlagSettings({ fastMode: false });
    assert.equal((await query.next()).value.subtype, 'status');
    assert.deepEqual(fastOf(await turnResult(query, channel)), { state: 'off', reason: null });

    await query.applyFlagSettings({ fastMode: null });
    assert.equal((await query.next()).value.subtype, 'status');
    assert.deepEqual(fastOf(await turnResult(query, channel)), { state: 'off', reason: 'sdk_opt_in_required' });
  });

  test('a fastMode setting in the query options opens fast mode at start', async (t) => {
    const { init } = await openQuery(t, tempDir(t), projectDir(t), { model: 'opus', settings: { fastMode: true } });
    assert.deepEqual(fastOf(init), { state: 'on', reason: null });
  });

  test('fastMode null hands the decision to the settings files', async (t) => {
    const adapter = adapterWith(tempDir(t), { resolvedSettings: { fastMode: true } });
    const { query, channel, init } = await openOn(t, adapter, projectDir(t), { model: 'opus' });
    assert.deepEqual(fastOf(init), { state: 'off', reason: 'sdk_opt_in_required' }, 'the files alone do not opt in');
    await query.applyFlagSettings({ fastMode: null });
    assert.equal((await query.next()).value.subtype, 'status');
    assert.deepEqual(fastOf(await turnResult(query, channel)), { state: 'on', reason: null });
  });

  test('fastMode accepts only a boolean or null', async (t) => {
    const { query } = await openQuery(t, tempDir(t), projectDir(t));
    await assert.rejects(query.applyFlagSettings({ fastMode: 'on' }), /fastMode must be a boolean or null\./);
  });
});

describe('background tasks', () => {
  test('a command nobody moves finishes in the foreground', async (t) => {
    const messages = await runSingle(adapterAt(tempDir(t)), projectDir(t), 'start a background build');
    assertWellFormed(messages);
    assert.equal(taskStartedOf(messages), undefined);
    assert.equal(listingsOf(messages).length, 0);
    assert.equal(bashResultOf(messages).block.content, 'Build succeeded');
    assert.match(topLevelText(messages), /The build finished and succeeded\./);
  });

  test('Ctrl+B moves a running command: it starts as a background task, and it completes later', async (t) => {
    const { query, channel } = await openQuery(t, tempDir(t), projectDir(t));
    const { before, toolUseId } = await startBuildInBackground(query, channel);
    // The completion may arrive inside the turn or after it, so the wait covers both: the turn's end, the notice and
    // the emptied list.
    const messages = await pullAll(query, (list) => list.some(isTurnEnd)
      && notificationsOf(list).length === 1 && listingsOf(list).length === 2, before);

    const started = taskStartedOf(messages);
    assert.equal(started.tool_use_id, toolUseId);
    assert.equal(started.task_type, 'local_bash');
    assert.equal(started.is_backgrounded, true);
    assert.equal(started.description, 'Build the project');
    const outputFile = `/tmp/mock-tasks/${started.task_id}.output`;
    assert.equal(bashResultOf(messages).block.content,
      `Command running in background with ID: ${started.task_id}. Output is being written to: ${outputFile}`);
    assert.deepEqual(listingsOf(messages).map((m) => m.tasks.map((task) => task.task_id)), [[started.task_id], []]);
    assert.equal(messages.find((m) => m.type === 'result').subtype, 'success');

    const [notice] = notificationsOf(messages);
    assert.equal(notice.task_id, started.task_id);
    assert.equal(notice.tool_use_id, toolUseId);
    assert.equal(notice.status, 'completed');
    assert.equal(notice.output_file, outputFile);
    assert.equal(notice.summary, 'Background command "Build the project" completed');
    assert.equal(await query.backgroundTasks(), false, 'nothing is left to move');
  });

  test('stopTask ends a background command early and reports it stopped, so it never completes', async (t) => {
    const adapter = adapterWith(tempDir(t), { backgroundTiming: { waitMs: 25, runMs: 5000 } });
    const { query, channel } = await openOn(t, adapter, projectDir(t));
    const { before } = await startBuildInBackground(query, channel);
    const started = taskStartedOf(await pullAll(query, (list) => list.some(isTurnEnd), before));
    await query.stopTask(started.task_id);
    const [stopped] = notificationsOf(await pullUntil(query, (m) => m.type === 'system'
      && m.subtype === 'task_notification'));
    assert.equal(stopped.task_id, started.task_id);
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.summary, 'Stopped by request');
    channel.end();
    const tail = await collect(query);
    assert.deepEqual(notificationsOf(tail), [], 'the stopped command never completes');
    assert.deepEqual(listingsOf(tail).map((m) => m.tasks), [[]]);
  });

  test('an interrupt leaves a background command running when perTaskStopAffordance is set', async (t) => {
    const { cut, tail } = await interruptWhileBuilding(t, { perTaskStopAffordance: true });
    assert.equal(cut.find((m) => m.type === 'result').terminal_reason, 'aborted_streaming');
    assert.deepEqual(notificationsOf(cut), []);
    assert.deepEqual(listingsOf(cut), []);
    const [done] = notificationsOf(tail);
    assert.equal(done.status, 'completed');
    assert.equal(done.summary, 'Background command "Build the project" completed');
  });

  test('an interrupt stops a background command when perTaskStopAffordance is not set', async (t) => {
    const { cut, tail } = await interruptWhileBuilding(t, {});
    const [stopped] = notificationsOf(cut);
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.summary, 'Stopped by the interrupt');
    assert.deepEqual(listingsOf(cut).at(-1).tasks, []);
    assert.deepEqual(notificationsOf(tail), [], 'nothing completes after the interrupt');
  });

  test('with background tasks disabled, the move is refused and the command finishes in the foreground', async (t) => {
    const adapter = adapterWith(tempDir(t), { config: { backgroundTasksDisabled: true } });
    const { query, channel } = await openOn(t, adapter, projectDir(t));
    channel.push(userPrompt('start a background build'));
    const before = await pullUntil(query, callsTool);
    await assert.rejects(query.backgroundTasks(), /Background tasks are disabled for this session\./);
    const all = [...before, ...(await pullUntil(query, isTurnEnd))];
    assert.equal(taskStartedOf(all), undefined);
    assert.equal(bashResultOf(all).block.content, 'Build succeeded');
    assert.equal(all.find((m) => m.type === 'result').subtype, 'success');
  });

  test('backgroundTasks answers false when no command runs, and checks its argument', async (t) => {
    const { query } = await openQuery(t, tempDir(t), projectDir(t));
    assert.equal(await query.backgroundTasks(), false);
    assert.equal(await query.backgroundTasks('toolu_mock_404'), false);
    await assert.rejects(query.backgroundTasks(7), /toolUseId must be a string/);
  });

  test('after the prompts end, the session stays open until the background command finishes', async (t) => {
    const adapter = adapterWith(tempDir(t), { backgroundTiming: { waitMs: 25, runMs: 40 } });
    const channel = promptChannel();
    channel.push(userPrompt('start a background build'));
    channel.end();
    const query = adapter.query({ prompt: channel.stream, options: { cwd: projectDir(t) } });
    const messages = [];
    for await (const message of query) {
      messages.push(message);
      if (callsTool(message)) await query.backgroundTasks();
    }
    assertWellFormed(messages);
    const [notice] = notificationsOf(messages);
    assert.equal(notice.status, 'completed');
    assert.equal(messages.at(-1).subtype, 'background_tasks_changed', 'the session ends with the emptied list');
    assert.deepEqual(messages.at(-1).tasks, []);
  });
});

describe('refusals', () => {
  test('a refusal with no fallback model keeps the refused answer and adds the notice', async (t) => {
    const cwd = projectDir(t);
    const adapter = adapterAt(tempDir(t));
    const uuid = randomUUID();
    const messages = await runSingle(adapter, cwd, 'refusal-none please', {}, uuid);
    const results = assertWellFormed(messages);
    assert.equal(results[0].subtype, 'success');
    assert.equal(results[0].stop_reason, 'refusal');
    assert.equal(topLevelText(messages), "I can't help with that request.");
    const notice = messages.find((m) => m.type === 'system' && m.subtype === 'model_refusal_no_fallback');
    assert.equal(notice.refused_user_message_uuid, uuid);
    assert.equal(notice.original_model, 'claude-opus-mock');
    assertLinked(messages, [uuid]);
    const stored = await adapter.getSessionMessages(messages[0].session_id, { dir: cwd });
    assert.deepEqual(stored.map((entry) => entry.type), ['user', 'assistant'], 'the notice is not stored');
    assert.equal(stored[1].message.stop_reason, 'refusal');
    assert.equal(stored[1].message.content[0].text, "I can't help with that request.");
  });

  test('a refusal with a fallback model is retried, and the refused answer leaves the transcript', async (t) => {
    const cwd = projectDir(t);
    const adapter = adapterAt(tempDir(t));
    const uuid = randomUUID();
    const messages = await runSingle(adapter, cwd, 'trigger a refusal', {}, uuid);
    const results = assertWellFormed(messages);
    assert.equal(results[0].subtype, 'success');
    assert.equal(results[0].stop_reason, 'end_turn');
    const refused = messages.find((m) => m.type === 'assistant' && m.message.stop_reason === 'refusal');
    const retry = messages.find((m) => m.type === 'assistant' && m.message.stop_reason === 'end_turn');
    const notice = messages.find((m) => m.type === 'system' && m.subtype === 'model_refusal_fallback');
    assert.deepEqual(retry.supersedes, [refused.uuid], 'the retry names the refused answer it replaces');
    assert.ok(messages.indexOf(notice) > messages.indexOf(retry), 'the notice comes at the end of the turn');
    assert.ok(messages.indexOf(notice) < messages.indexOf(results[0]));
    assert.deepEqual(notice.retracted_message_uuids, [refused.uuid]);
    assert.equal(notice.refused_user_message_uuid, uuid);
    assert.equal(notice.fallback_model, 'claude-sonnet-mock');
    assert.equal(topLevelText(messages),
      "I can't help with that request.\nHere is the answer from the fallback model.");
    assertLinked(messages, [uuid]);
    const stored = await adapter.getSessionMessages(messages[0].session_id, { dir: cwd });
    assert.deepEqual(stored.map((entry) => entry.type), ['user', 'assistant']);
    assert.equal(stored[1].message.content[0].text, 'Here is the answer from the fallback model.');
  });
});

describe('plugins and reloads', () => {
  test('a reload with nothing pending applies at once, and reports held false when asked to hold', async (t) => {
    const { query } = await openQuery(t, tempDir(t), projectDir(t));
    const reloaded = await query.reloadPlugins({ holdOnCacheImpact: true });
    assert.equal(reloaded.held, false);
    assert.equal(reloaded.cache_impact, undefined);
    assert.deepEqual(reloaded.plugins, []);
  });

  test('a plugin installed by a turn is held by a reload that would change the tools, then applied', async (t) => {
    const { query, channel } = await openQuery(t, tempDir(t), projectDir(t));
    assert.equal((await turnResult(query, channel, 'install the plugin')).subtype, 'success');

    const held = await query.reloadPlugins({ holdOnCacheImpact: true });
    assert.equal(held.held, true);
    assert.deepEqual(held.cache_impact, {
      mcp_servers_added: ['plugin:demo-plugin:docs'],
      mcp_servers_removed: [],
      lsp_tool_change: null,
    });
    assert.deepEqual(held.plugins, []);
    assert.equal(held.mcpServers.some((server) => server.name === 'plugin:demo-plugin:docs'), false);

    const applied = await query.reloadPlugins();
    assert.equal(applied.held, undefined);
    assert.deepEqual(applied.plugins.map((plugin) => plugin.name), ['demo-plugin']);
    const server = applied.mcpServers.find((item) => item.name === 'plugin:demo-plugin:docs');
    assert.equal(server.status, 'connected');

    const again = await query.reloadPlugins({ holdOnCacheImpact: true });
    assert.equal(again.held, false, 'nothing is pending any more');
  });
});

describe('output style and local settings', () => {
  test('the output style follows the local settings, and an unknown style changes nothing', async (t) => {
    const { query } = await openQuery(t, tempDir(t), projectDir(t));
    await query.updateSettings('localSettings', { outputStyle: 'Learning' });
    assert.equal((await query.initializationResult()).output_style, 'Learning');
    await assert.rejects(query.updateSettings('localSettings', { outputStyle: 'poetic' }),
      /Unknown output style: poetic/);
    assert.equal((await query.initializationResult()).output_style, 'Learning');
  });

  test('local settings are refused when the query leaves the local source out', async (t) => {
    const { query } = await openQuery(t, tempDir(t), projectDir(t), { settingSources: ['user', 'project'] });
    await assert.rejects(query.updateSettings('localSettings', { outputStyle: 'Learning' }),
      /Local settings are not loaded for this session\./);
    assert.equal((await query.initializationResult()).output_style, 'default');
  });
});
