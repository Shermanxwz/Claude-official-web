// Tests for the scenarios the browser tests and the integration tests drive (src/engine/mock/scenarios.mjs): the
// refusal-prompt dialog through a real query, the paced slow answer, and the shape of tool results with content blocks.
// Each query uses its own temporary state and project folder, removed afterwards; nothing touches the network.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createMockAdapter } from '../../src/engine/mock/index.mjs';
import { selectScenario, toolResult } from '../../src/engine/mock/scenarios.mjs';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * A fresh directory, removed when the test ends.
 * @param {import('node:test').TestContext} t
 * @returns {string}
 */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'caw-mock-scenarios-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A project folder with one file, removed when the test ends.
 * @param {import('node:test').TestContext} t
 * @returns {string}
 */
function projectDir(t) {
  const dir = tempDir(t);
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'app.js'), "console.log('hi');\n");
  return dir;
}

/** An SDK user message as the host sends it. */
function userPrompt(text, uuid = randomUUID()) {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, uuid };
}

/** A prompt stream that yields the given prompts and then ends. */
function promptsThenEnd(...prompts) {
  return (async function* prompt() {
    for (const message of prompts) yield message;
  })();
}

/** Drains a query into an array. */
async function collect(query) {
  const messages = [];
  for await (const message of query) messages.push(message);
  return messages;
}

/**
 * A query over a fresh adapter with one prompt and the given options, not yet started.
 * @param {import('node:test').TestContext} t
 * @param {string} text
 * @param {Record<string, unknown>} options
 */
function queryFor(t, text, options) {
  const adapter = createMockAdapter({ config: { stateDir: tempDir(t) }, log: silent, delayMs: 0 });
  const cwd = projectDir(t);
  const uuid = randomUUID();
  const query = adapter.query({
    prompt: promptsThenEnd(userPrompt(text, uuid)),
    options: { cwd, includePartialMessages: true, ...options },
  });
  return { adapter, cwd, uuid, query };
}

/** The dialog options of a host that renders the refusal prompt and answers with the given result. */
function dialogHost(answer, dialogs = []) {
  return {
    supportedDialogKinds: ['refusal_fallback_prompt'],
    onUserDialog: async (/** @type {any} */ dialog) => {
      dialogs.push(dialog);
      return answer;
    },
  };
}

/** The refused answer of a turn: the assistant message that stopped for the refusal. */
const refusedOf = (/** @type {any[]} */ messages) => messages.find((message) => message.type === 'assistant'
  && message.message.stop_reason === 'refusal');

/** The session state changes of a turn, in order. */
const statesOf = (/** @type {any[]} */ messages) => messages.filter((message) => message.type === 'system'
  && message.subtype === 'session_state_changed').map((message) => message.state);

describe('refusal-prompt scenario through a query', () => {
  test('retry_fallback retries on the fallback model the query names, once the dialog has answered', async (t) => {
    const dialogs = [];
    const { adapter, cwd, query } = queryFor(t, 'refusal-prompt please', {
      fallbackModel: 'claude-haiku-mock',
      ...dialogHost({ behavior: 'completed', result: 'retry_fallback' }, dialogs),
    });
    const messages = await collect(query);
    assert.equal(dialogs.length, 1);
    assert.equal(dialogs[0].dialogKind, 'refusal_fallback_prompt');
    const refused = refusedOf(messages);
    assert.deepEqual(dialogs[0].payload.retractedMessageUuids, [refused.uuid]);
    assert.equal(dialogs[0].payload.originalModel, 'claude-opus-mock');
    assert.equal(dialogs[0].payload.fallbackModel, 'claude-haiku-mock');
    assert.match(dialogs[0].payload.guidanceText, /Retry it on the fallback model or edit the prompt\./);
    const retry = messages.find((message) => message.type === 'assistant'
      && message.message.stop_reason === 'end_turn');
    assert.deepEqual(retry.supersedes, [refused.uuid]);
    const notice = messages.find((message) => message.type === 'system'
      && message.subtype === 'model_refusal_fallback');
    assert.equal(notice.fallback_model, 'claude-haiku-mock');
    assert.deepEqual(notice.retracted_message_uuids, [refused.uuid]);
    const states = statesOf(messages);
    const waiting = states.indexOf('requires_action');
    assert.ok(waiting >= 0 && states[waiting + 1] === 'running', 'the session waits for the dialog, then runs');
    assert.equal(messages.find((message) => message.type === 'result').subtype, 'success');
    const stored = await adapter.getSessionMessages(messages[0].session_id, { dir: cwd });
    assert.deepEqual(stored.map((entry) => entry.type), ['user', 'assistant']);
    assert.equal(stored[1].message.content[0].text, 'Here is the answer from the fallback model.');
  });

  test('edit_prompt retracts the refused answer and ends the turn, so the prompt can be sent again', async (t) => {
    const { adapter, cwd, query } = queryFor(t, 'refusal-prompt please',
      dialogHost({ behavior: 'completed', result: 'edit_prompt' }));
    const messages = await collect(query);
    assert.equal(messages.find((message) => message.type === 'result').subtype, 'success');
    assert.equal(messages.some((message) => message.type === 'system' && message.subtype === 'model_refusal_fallback'),
      false, 'no fallback answer follows');
    const stored = await adapter.getSessionMessages(messages[0].session_id, { dir: cwd });
    assert.deepEqual(stored.map((entry) => entry.type), ['user'], 'the refused answer leaves the transcript');
  });

  test('cancelled keeps the refusal and says no fallback ran; the dialog offers the default model', async (t) => {
    const dialogs = [];
    const { adapter, cwd, uuid, query } = queryFor(t, 'refusal-prompt please',
      dialogHost({ behavior: 'cancelled' }, dialogs));
    const messages = await collect(query);
    assert.equal(dialogs[0].payload.fallbackModel, 'claude-sonnet-mock');
    const notice = messages.find((message) => message.type === 'system'
      && message.subtype === 'model_refusal_no_fallback');
    assert.equal(notice.original_model, 'claude-opus-mock');
    assert.equal(notice.refused_user_message_uuid, uuid);
    const stored = await adapter.getSessionMessages(messages[0].session_id, { dir: cwd });
    assert.deepEqual(stored.map((entry) => entry.type), ['user', 'assistant']);
    assert.equal(stored[1].message.content[0].text, "I can't help with that request.");
  });

  test('a host that renders no dialog gets the no-fallback notice at once, without a dialog', async (t) => {
    const { query } = queryFor(t, 'refusal-prompt please', { supportedDialogKinds: [] });
    const messages = await collect(query);
    assert.ok(messages.some((message) => message.type === 'system' && message.subtype === 'model_refusal_no_fallback'));
    assert.equal(statesOf(messages).includes('requires_action'), false);
  });
});

describe('slow scenario pacing', () => {
  /**
   * A turn context for the scenario functions, with the pauses recorded instead of waited for.
   * @param {{delayMs: number, pauses: number[]}} options
   */
  function fakeContext({ delayMs, pauses }) {
    const sessionId = '0b6f6a52-2d2e-4f7a-9d8e-1a2b3c4d5e6f';
    let sequence = 0;
    /** @type {Record<string, number>} */
    const counters = {};
    return {
      sessionId,
      cwd: '/work',
      model: 'claude-sonnet-mock',
      userText: 'answer slowly',
      userMessageUuid: '9d1f0e2a-3b4c-4d5e-8f60-718293a4b5c6',
      userMessageUuids: ['9d1f0e2a-3b4c-4d5e-8f60-718293a4b5c6'],
      delayMs,
      streamPartials: true,
      turnIndex: 0,
      thinkingSummaries: false,
      nextId: (/** @type {string} */ kind) => {
        counters[kind] = (counters[kind] ?? 0) + 1;
        return `${kind}_fake_${counters[kind]}`;
      },
      envelope: () => {
        sequence += 1;
        return { uuid: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`, session_id: sessionId };
      },
      now: () => Date.now(),
      pause: function* pause(/** @type {number} */ ms) {
        pauses.push(ms);
      },
    };
  }

  /** Runs the slow scenario against a fake context and collects what it yields. */
  async function runSlow(delayMs) {
    const pauses = [];
    const scenario = selectScenario('answer slowly');
    assert.equal(scenario.name, 'slow');
    const messages = [];
    for await (const message of scenario.run(fakeContext({ delayMs, pauses }))) messages.push(message);
    return { messages, pauses };
  }

  test('the answer streams sixty chunks, each held back by at least 50 ms', async () => {
    const { messages, pauses } = await runSlow(0);
    const deltas = messages.filter((message) => message.type === 'stream_event'
      && message.event.type === 'content_block_delta');
    assert.equal(deltas.length, 60);
    assert.equal(pauses.length, 60);
    assert.deepEqual([...new Set(pauses)], [50]);
    const answer = messages.find((message) => message.type === 'assistant');
    assert.equal(answer.message.content[0].text.startsWith('Part 1 of 60. Part 2 of 60. '), true);
    assert.equal(answer.message.content[0].text.endsWith('Part 60 of 60. '), true);
  });

  test('the pause grows with the delay: four times the delay, and never less than 50 ms', async () => {
    assert.deepEqual([...new Set((await runSlow(20)).pauses)], [80]);
    assert.deepEqual([...new Set((await runSlow(5)).pauses)], [50]);
  });
});

describe('tool results with content blocks', () => {
  /** A context that only supplies the envelope a tool result carries. */
  const envelopeOnly = {
    envelope: () => ({
      uuid: '00000000-0000-4000-8000-000000000001',
      session_id: '0b6f6a52-2d2e-4f7a-9d8e-1a2b3c4d5e6f',
    }),
  };

  test('a result of text and image blocks is kept as a list, and is answered by the tool_use it names', () => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
    const message = toolResult(envelopeOnly, {
      toolUseId: 'toolu_mock_1',
      content: [{ type: 'text', text: 'Screenshot of the page.' }, image],
    });
    assert.equal(message.type, 'user');
    assert.equal(message.parent_tool_use_id, null);
    assert.deepEqual(message.message.content, [{
      type: 'tool_result',
      tool_use_id: 'toolu_mock_1',
      content: [{ type: 'text', text: 'Screenshot of the page.' }, image],
    }]);
    assert.equal('tool_use_result' in message, false);
    assert.equal('agent_id' in message, false);
  });

  test('an error result carries the error flag, the runtime result and the subagent it belongs to', () => {
    const message = toolResult(envelopeOnly, {
      toolUseId: 'toolu_mock_2',
      content: 'Command failed',
      isError: true,
      toolUseResult: { interrupted: false },
      parentToolUseId: 'toolu_mock_1',
      agentId: 'agent_mock_1',
    });
    assert.equal(message.message.content[0].is_error, true);
    assert.equal(message.message.content[0].content, 'Command failed');
    assert.deepEqual(message.tool_use_result, { interrupted: false });
    assert.equal(message.parent_tool_use_id, 'toolu_mock_1');
    assert.equal(message.agent_id, 'agent_mock_1');
  });

  test('a plain successful result carries no error flag', () => {
    const block = toolResult(envelopeOnly, { toolUseId: 'toolu_mock_3', content: 'ok' }).message.content[0];
    assert.equal('is_error' in block, false);
  });
});
