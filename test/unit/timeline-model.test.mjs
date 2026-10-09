import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModel } from '../../public/js/timeline/model.js';
import { isDefaultChecked, describeSuggestion, checkedIndexes, ruleText } from '../../public/js/timeline/suggestions.js';

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SESSION = '11111111-1111-4111-8111-111111111111';

/** Transcript record (SessionMessage shape). */
const tx = (type, id, message, extra = {}) => ({
  type,
  uuid: uuid(id),
  session_id: SESSION,
  message,
  parent_tool_use_id: null,
  parent_agent_id: null,
  timestamp: '2026-10-09T10:00:00.000Z',
  ...extra,
});

/** Live SDK messages. */
const live = {
  user: (id, content, extra = {}) => ({
    type: 'user',
    uuid: uuid(id),
    session_id: SESSION,
    message: { role: 'user', content },
    parent_tool_use_id: null,
    ...extra,
  }),
  assistant: (id, messageId, content, extra = {}) => ({
    type: 'assistant',
    uuid: uuid(id),
    session_id: SESSION,
    message: { id: messageId, type: 'message', role: 'assistant', model: 'm', content, stop_reason: null },
    parent_tool_use_id: null,
    ...extra,
  }),
  result: (id, extra = {}) => ({
    type: 'result',
    subtype: 'success',
    uuid: uuid(id),
    session_id: SESSION,
    duration_ms: 1200,
    duration_api_ms: 900,
    is_error: false,
    num_turns: 1,
    result: 'done',
    stop_reason: 'end_turn',
    total_cost_usd: 0.01,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    errors: [],
    ...extra,
  }),
  system: (id, subtype, extra = {}) => ({
    type: 'system',
    subtype,
    uuid: uuid(id),
    session_id: SESSION,
    ...extra,
  }),
  stream: (id, event, parent = null) => ({
    type: 'stream_event',
    uuid: uuid(id),
    session_id: SESSION,
    event,
    parent_tool_use_id: parent,
  }),
  toolResult: (id, toolUseId, content, extra = {}) => ({
    type: 'user',
    uuid: uuid(id),
    session_id: SESSION,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: false }] },
    parent_tool_use_id: null,
    ...extra,
  }),
};

const kinds = (model) => model.getEntries().map((entry) => entry.kind);
const find = (model, kind) => model.getEntries().filter((entry) => entry.kind === kind);
const toolsIn = (entry) => entry.items.filter((item) => item.kind === 'tool');

test('transcript load builds turns, bubbles, tool cards and tool results', () => {
  const model = createModel();
  model.loadTranscript([
    tx('user', 1, { role: 'user', content: 'list files' }),
    tx('assistant', 2, { id: 'msg-a', role: 'assistant', content: [{ type: 'text', text: 'Looking.' }] }),
    tx('assistant', 3, { id: 'msg-b', role: 'assistant', content: [{ type: 'tool_use', id: 'T1', name: 'Bash', input: { command: 'ls' } }] }),
    tx('user', 4, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'T1', content: 'a.txt\nb.txt' }] }),
    tx('assistant', 5, { id: 'msg-c', role: 'assistant', content: [{ type: 'text', text: 'Two files.' }] }),
  ]);
  assert.deepEqual(kinds(model), ['user', 'assistant', 'work', 'assistant']);
  const [user, , work] = model.getEntries();
  assert.equal(user.text, 'list files');
  const tool = toolsIn(work)[0];
  assert.equal(tool.name, 'Bash');
  assert.equal(tool.result.content, 'a.txt\nb.txt');
  assert.equal(tool.result.isError, false);
  assert.equal(tool.running, false, 'transcript turns are never running');
  assert.equal(work.open, false);
});

test('transcript tool results never render as user bubbles', () => {
  const model = createModel();
  model.loadTranscript([
    tx('user', 1, { role: 'user', content: 'go' }),
    tx('assistant', 2, { id: 'm', role: 'assistant', content: [{ type: 'tool_use', id: 'X', name: 'Read', input: { file_path: '/a' } }] }),
    tx('user', 3, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'X', content: [{ type: 'text', text: 'body' }] }] }),
  ]);
  assert.equal(find(model, 'user').length, 1);
  assert.equal(toolsIn(find(model, 'work')[0])[0].result.content, 'body');
});

test('results that arrive before their tool_use are attached when the card appears', () => {
  const model = createModel();
  model.applyLiveEvent(live.user(1, 'run'));
  model.applyLiveEvent(live.toolResult(2, 'EARLY', 'ok'));
  model.applyLiveEvent(live.assistant(3, 'm1', [{ type: 'tool_use', id: 'EARLY', name: 'Bash', input: { command: 'x' } }]));
  const tool = toolsIn(find(model, 'work')[0])[0];
  assert.equal(tool.result.content, 'ok');
  assert.equal(tool.running, false);
});

test('live tool results after tool_use mark the card finished and keep the group open until result', () => {
  const model = createModel();
  model.applyLiveEvent(live.user(1, 'run'));
  model.applyLiveEvent(live.assistant(2, 'm1', [{ type: 'tool_use', id: 'T9', name: 'Grep', input: { pattern: 'x' } }]));
  let group = find(model, 'work')[0];
  assert.equal(group.open, true);
  assert.equal(group.running, true);
  assert.equal(toolsIn(group)[0].running, true);
  model.applyLiveEvent(live.toolResult(3, 'T9', 'match'));
  group = find(model, 'work')[0];
  assert.equal(toolsIn(group)[0].running, false);
  assert.equal(group.running, false);
  assert.equal(group.open, true, 'still open while the turn runs');
  model.applyLiveEvent(live.result(4));
  assert.equal(find(model, 'work')[0].open, false, 'collapsed after result');
});

test('structured tool_use_result is attached as structured output', () => {
  const model = createModel();
  model.applyLiveEvent(live.user(1, 'read'));
  model.applyLiveEvent(live.assistant(2, 'm1', [{ type: 'tool_use', id: 'R1', name: 'Read', input: { file_path: '/x' } }]));
  model.applyLiveEvent(live.toolResult(3, 'R1', 'contents', { tool_use_result: { type: 'text', file: { numLines: 2 } } }));
  assert.deepEqual(toolsIn(find(model, 'work')[0])[0].structured, { type: 'text', file: { numLines: 2 } });
});

test('subagent messages nest inside the Agent card instead of the main flow', () => {
  const model = createModel();
  model.applyLiveEvent(live.user(1, 'delegate'));
  model.applyLiveEvent(live.assistant(2, 'm1', [{ type: 'tool_use', id: 'AG', name: 'Agent', input: { prompt: 'p' } }]));
  model.applyLiveEvent(live.assistant(3, 'm2', [{ type: 'tool_use', id: 'SUB1', name: 'Bash', input: { command: 'ls' } }], { parent_tool_use_id: 'AG' }));
  model.applyLiveEvent(live.toolResult(4, 'SUB1', 'listing', { parent_tool_use_id: 'AG' }));
  model.applyLiveEvent(live.assistant(5, 'm3', [{ type: 'text', text: 'inner answer' }], { parent_tool_use_id: 'AG' }));
  const mainWork = find(model, 'work');
  assert.equal(mainWork.length, 1);
  assert.equal(toolsIn(mainWork[0]).length, 1, 'only the Agent card is in the main flow');
  const agent = toolsIn(mainWork[0])[0];
  assert.deepEqual(agent.children.map((entry) => entry.kind), ['work', 'assistant']);
  assert.equal(toolsIn(agent.children[0])[0].result.content, 'listing');
  assert.equal(agent.children[1].blocks[0].text, 'inner answer');
});

test('subagent messages that arrive before their card are buffered and replayed', () => {
  const model = createModel();
  model.applyLiveEvent(live.user(1, 'x'));
  model.applyLiveEvent(live.assistant(2, 'm2', [{ type: 'text', text: 'late child' }], { parent_tool_use_id: 'AG2' }));
  assert.equal(find(model, 'assistant').length, 0);
  model.applyLiveEvent(live.assistant(3, 'm1', [{ type: 'tool_use', id: 'AG2', name: 'Task', input: {} }]));
  const agent = toolsIn(find(model, 'work')[0])[0];
  assert.equal(agent.children[0].blocks[0].text, 'late child');
});

test('work groups get the tool_use_summary label and a step count', () => {
  const model = createModel();
  model.applyLiveEvent(live.user(1, 'read two'));
  model.applyLiveEvent(live.assistant(2, 'm1', [
    { type: 'tool_use', id: 'A', name: 'Read', input: { file_path: '/a' } },
    { type: 'tool_use', id: 'B', name: 'Read', input: { file_path: '/b' } },
  ]));
  model.applyLiveEvent(live.toolResult(3, 'A', 'a'));
  model.applyLiveEvent(live.toolResult(4, 'B', 'b'));
  assert.equal(find(model, 'work')[0].label, null);
  assert.equal(find(model, 'work')[0].count, 2);
  model.applyLiveEvent({ type: 'tool_use_summary', uuid: uuid(5), session_id: SESSION, summary: 'Read 2 files', preceding_tool_use_ids: ['B'] });
  assert.equal(find(model, 'work')[0].label, 'Read 2 files');
});

test('assistant text splits work groups; a message with several blocks keeps one bubble per run', () => {
  const model = createModel();
  model.applyLiveEvent(live.user(1, 'go'));
  model.applyLiveEvent(live.assistant(2, 'm1', [
    { type: 'text', text: 'first' },
    { type: 'tool_use', id: 'Q', name: 'Bash', input: { command: 'pwd' } },
    { type: 'text', text: 'second' },
  ]));
  assert.deepEqual(kinds(model), ['user', 'assistant', 'work', 'assistant']);
  const bubbles = find(model, 'assistant');
  assert.equal(bubbles[0].blocks[0].text, 'first');
  assert.equal(bubbles[1].blocks[0].text, 'second');
  const keys = model.getEntries().map((entry) => entry.key);
  assert.equal(new Set(keys).size, keys.length, 'keys are unique');
});

test('consecutive assistant messages with the same message.id share one bubble', () => {
  const model = createModel();
  model.applyLiveEvent(live.user(1, 'x'));
  model.applyLiveEvent(live.assistant(2, 'same', [{ type: 'thinking', thinking: 'hmm', signature: 's' }]));
  model.applyLiveEvent(live.assistant(3, 'same', [{ type: 'text', text: 'answer' }]));
  const bubbles = find(model, 'assistant');
  assert.equal(bubbles.length, 1);
  assert.deepEqual(bubbles[0].blocks.map((block) => block.kind), ['thinking', 'text']);
});

test('streaming draft shows deltas in place and is finalized by final assistant messages', () => {
  const model = createModel();
  model.applyLiveEvent(live.user(1, 'hi'));
  model.applyLiveEvent(live.stream(2, { type: 'message_start', message: { id: 'M' } }));
  model.applyLiveEvent(live.stream(3, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
  model.applyLiveEvent(live.stream(4, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } }));
  let draft = model.getEntries().at(-1);
  assert.equal(draft.streaming, true);
  const block = draft.blocks[0];
  assert.equal(block.text, 'Hel');
  model.applyLiveEvent(live.stream(5, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } }));
  draft = model.getEntries().at(-1);
  assert.equal(draft.blocks[0].key, block.key, 'the same block object keeps its key while streaming');
  assert.equal(draft.blocks[0].text, 'Hello');
  model.applyLiveEvent(live.assistant(6, 'M', [{ type: 'text', text: 'Hello' }]));
  assert.equal(model.getEntries().some((entry) => entry.streaming), false, 'all blocks finalized, draft hidden');
  model.applyLiveEvent(live.stream(7, { type: 'message_stop' }));
  assert.equal(find(model, 'assistant').length, 1);
});

test('a message whose blocks arrive as several final messages sharing message.id finalizes block by block', () => {
  const model = createModel();
  model.applyLiveEvent(live.user(1, 'do'));
  model.applyLiveEvent(live.stream(2, { type: 'message_start', message: { id: 'MM' } }));
  model.applyLiveEvent(live.stream(3, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
  model.applyLiveEvent(live.stream(4, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'A' } }));
  model.applyLiveEvent(live.stream(5, { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'TT', name: 'Bash', input: {} } }));
  model.applyLiveEvent(live.stream(6, { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"l' } }));
  let draft = model.getEntries().at(-1);
  assert.equal(draft.blocks.length, 2);
  assert.equal(draft.blocks[1].kind, 'tool-draft');
  assert.equal(draft.blocks[1].partial, '{"command":"l');
  model.applyLiveEvent(live.assistant(7, 'MM', [{ type: 'text', text: 'A' }]));
  model.applyLiveEvent(live.assistant(8, 'MM', [{ type: 'tool_use', id: 'TT', name: 'Bash', input: { command: 'ls' } }]));
  assert.equal(toolsIn(find(model, 'work')[0])[0].input.command, 'ls');
  draft = model.getEntries().find((entry) => entry.streaming);
  assert.equal(draft, undefined, 'nothing left to stream once every block is final');
  model.applyLiveEvent(live.stream(9, { type: 'message_stop' }));
  assert.equal(model.getEntries().some((entry) => entry.streaming), false);
});

test('a result clears any streaming draft and closes the turn', () => {
  const model = createModel();
  model.applyLiveEvent(live.user(1, 'x'));
  model.applyLiveEvent(live.stream(2, { type: 'message_start', message: { id: 'Z' } }));
  model.applyLiveEvent(live.stream(3, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
  model.applyLiveEvent(live.stream(4, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }));
  model.applyLiveEvent(live.result(5, { subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', errors: [] }));
  assert.equal(model.getEntries().some((entry) => entry.streaming), false);
  assert.equal(model.getRunState().running, false);
});

test('uuid dedupe: a message already present from the transcript is ignored when it reappears live', () => {
  const model = createModel();
  model.loadTranscript([
    tx('user', 1, { role: 'user', content: 'hello' }),
    tx('assistant', 2, { id: 'a', role: 'assistant', content: [{ type: 'text', text: 'hi there' }] }),
  ]);
  const before = model.getEntries().length;
  model.applyLiveEvent(live.user(1, 'hello'));
  model.applyLiveEvent(live.assistant(2, 'a', [{ type: 'text', text: 'hi there' }]));
  assert.equal(model.getEntries().length, before);
  model.applyLiveEvent(live.assistant(3, 'b', [{ type: 'text', text: 'new' }]));
  assert.equal(model.getEntries().length, before + 1);
});

test('snapshot liveEvents overlapping the transcript keep a running turn running', () => {
  const model = createModel();
  model.loadTranscript([
    tx('user', 1, { role: 'user', content: 'long task' }),
    tx('assistant', 2, { id: 'a', role: 'assistant', content: [{ type: 'tool_use', id: 'L1', name: 'Bash', input: { command: 'sleep 9' } }] }),
  ]);
  assert.equal(model.getRunState().running, false);
  model.applyLiveEvent(live.user(1, 'long task'));
  model.applyLiveEvent(live.assistant(2, 'a', [{ type: 'tool_use', id: 'L1', name: 'Bash', input: { command: 'sleep 9' } }]));
  model.setSessionState('running');
  assert.equal(model.getRunState().running, true);
  assert.equal(toolsIn(find(model, 'work')[0])[0].running, true);
  model.applyLiveEvent(live.result(3));
  assert.equal(model.getRunState().running, false);
});

test('optimistic messages are replaced by the echo with the same uuid', () => {
  const model = createModel();
  model.addOptimistic({ clientMessageId: uuid(50), text: 'ship it', attachments: [{ path: '/w/.caw-uploads/a/spec.pdf' }] });
  const sent = model.getEntries().at(-1);
  assert.equal(sent.status, 'sending');
  assert.equal(sent.attachments[0].name, 'spec.pdf');
  model.markAccepted(uuid(50));
  assert.equal(sent.status, 'sent');
  model.applyLiveEvent(live.user(50, 'ship it'));
  assert.equal(find(model, 'user').length, 1);
  assert.equal(find(model, 'user')[0].status, 'sent');
  assert.equal(model.getEntries().filter((entry) => entry.status === 'queued').length, 0);
});

test('optimistic messages are replaced by identical text when the echo has no matching uuid', () => {
  const model = createModel();
  model.addOptimistic({ clientMessageId: uuid(60), text: 'yes' });
  model.applyLiveEvent(live.user(61, 'yes'));
  assert.equal(model.getEntries().filter((entry) => entry.status === 'sending' || entry.status === 'queued').length, 0);
  assert.equal(find(model, 'user').length, 1);
});

test('markFailed keeps the optimistic entry with its error; discardOptimistic removes it', () => {
  const model = createModel();
  model.addOptimistic({ clientMessageId: uuid(70), text: 'oops' });
  model.markFailed(uuid(70), new Error('network down'));
  const failed = model.getEntries().at(-1);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'network down');
  model.discardOptimistic(uuid(70));
  assert.equal(model.getEntries().some((entry) => entry.clientMessageId === uuid(70)), false);
  model.markAccepted(uuid(999));
  model.markFailed(uuid(999), 'ignored');
});

test('a message sent while idle starts its own turn; rewind can target it before any reload', () => {
  const model = createModel();
  model.addOptimistic({ clientMessageId: uuid(40), text: 'first ask' });
  assert.equal(model.getRunState().running, true, 'the sent message starts a running turn');
  assert.deepEqual(kinds(model), ['user']);
  assert.equal(model.getEntries()[0].status, 'sending');
  assert.deepEqual(model.getUserMessages(), [], 'an unconfirmed message cannot be rewound to');
  model.markAccepted(uuid(40));
  assert.equal(model.getEntries()[0].status, 'sent');
  assert.deepEqual(model.getUserMessages(), [{ uuid: uuid(40), text: 'first ask', index: 0 }]);
  model.applyLiveEvent(live.assistant(41, 'm41', [{ type: 'text', text: 'answer' }]));
  assert.deepEqual(kinds(model), ['user', 'assistant'], 'the reply follows the prompt in the same turn');
  model.applyLiveEvent(live.result(42));
  assert.equal(model.getRunState().running, false);
});

test('a message sent while a turn runs waits at the end, then starts the next turn when the result arrives', () => {
  const model = createModel();
  model.applyLiveEvent(live.user(1, 'first'));
  model.applyLiveEvent(live.assistant(2, 'm2', [{ type: 'text', text: 'working' }]));
  model.addOptimistic({ clientMessageId: uuid(10), text: 'second' });
  assert.equal(model.getEntries().at(-1).status, 'queued');
  assert.equal(model.getEntries().at(-1).text, 'second');
  model.markAccepted(uuid(10));
  assert.equal(model.getEntries().at(-1).status, 'queued', 'accepted, but still behind the running turn');
  assert.deepEqual(model.getUserMessages().map((item) => item.text), ['first']);
  model.applyLiveEvent(live.result(3));
  assert.equal(model.getEntries().some((entry) => entry.status === 'queued'), false);
  assert.deepEqual(find(model, 'user').map((entry) => entry.status), ['sent', 'sent']);
  assert.equal(model.getRunState().running, true, 'the next turn runs');
  model.applyLiveEvent(live.assistant(4, 'm4', [{ type: 'text', text: 'second answer' }]));
  assert.deepEqual(kinds(model), ['user', 'assistant', 'result', 'user', 'assistant']);
  model.applyLiveEvent(live.result(5));
  assert.equal(model.getRunState().running, false);
  assert.deepEqual(model.getUserMessages().map((item) => item.text), ['first', 'second']);
});

test('a queued message the gateway has not accepted moves into the next turn as sending, then sent', () => {
  const model = createModel();
  model.applyLiveEvent(live.user(1, 'first'));
  model.addOptimistic({ clientMessageId: uuid(11), text: 'later' });
  model.applyLiveEvent(live.result(2));
  const later = find(model, 'user')[1];
  assert.equal(later.status, 'sending');
  assert.equal(model.getRunState().running, true);
  model.markAccepted(uuid(11));
  assert.equal(later.status, 'sent');
  assert.equal(later.uuid, uuid(11));
});

test('a session that goes idle moves queued messages into the timeline without starting a turn', () => {
  const model = createModel();
  model.applyLiveEvent(live.user(1, 'first'));
  model.addOptimistic({ clientMessageId: uuid(12), text: 'waiting' });
  model.markAccepted(uuid(12));
  model.setSessionState('idle');
  assert.equal(model.getEntries().some((entry) => entry.status === 'queued'), false);
  assert.equal(find(model, 'user')[1].status, 'sent');
  assert.equal(model.getRunState().running, false);
});

test('a live echo of a queued message moves it into the running turn instead of repeating it', () => {
  const model = createModel();
  model.applyLiveEvent(live.user(1, 'first'));
  model.addOptimistic({ clientMessageId: uuid(13), text: 'second' });
  model.applyLiveEvent(live.user(13, 'second'));
  assert.equal(find(model, 'user').length, 2);
  assert.equal(model.getEntries().some((entry) => entry.status === 'queued'), false);
  assert.equal(find(model, 'user')[1].uuid, uuid(13));
  assert.deepEqual(find(model, 'user').map((entry) => entry.status), ['sent', 'sent']);
});

test('a message that fails before the SDK starts it frees its turn, so the next message does not queue behind it', () => {
  const model = createModel();
  model.addOptimistic({ clientMessageId: uuid(14), text: 'nope' });
  model.markFailed(uuid(14), 'gateway unreachable');
  assert.equal(model.getRunState().running, false);
  model.addOptimistic({ clientMessageId: uuid(15), text: 'retry' });
  assert.equal(model.getEntries().at(-1).status, 'sending');
  assert.equal(model.getEntries().some((entry) => entry.status === 'queued'), false);
});

test('a failed queued message stays at the end with its error until it is discarded', () => {
  const model = createModel();
  model.applyLiveEvent(live.user(1, 'first'));
  model.addOptimistic({ clientMessageId: uuid(16), text: 'queued one' });
  model.markFailed(uuid(16), new Error('limit reached'));
  const failed = model.getEntries().at(-1);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'limit reached');
  assert.equal(model.getRunState().running, true, 'the running turn is unaffected');
  model.discardOptimistic(uuid(16));
  assert.equal(model.getEntries().some((entry) => entry.clientMessageId === uuid(16)), false);
});

test('a transcript that already holds an accepted message does not repeat it when it is restored', () => {
  const model = createModel();
  model.addOptimistic({ clientMessageId: uuid(17), text: 'saved' });
  model.markAccepted(uuid(17));
  model.loadTranscript([tx('user', 17, { role: 'user', content: 'saved' })]);
  model.addOptimistic({ clientMessageId: uuid(17), text: 'saved' });
  assert.equal(find(model, 'user').length, 1);
});

test('pending local messages are reported for a reload until the transcript confirms them', () => {
  const model = createModel();
  model.applyLiveEvent(live.user(1, 'first'));
  model.addOptimistic({ clientMessageId: uuid(18), text: 'second' });
  model.addOptimistic({ clientMessageId: uuid(19), text: 'third' });
  model.markAccepted(uuid(19));
  assert.deepEqual(model.getPendingUserMessages().map((item) => [item.clientMessageId, item.status, item.accepted]),
    [[uuid(18), 'queued', false], [uuid(19), 'queued', true]]);
  model.applyLiveEvent(live.result(2));
  assert.deepEqual(model.getPendingUserMessages().map((item) => [item.clientMessageId, item.status]), [[uuid(18), 'sending']]);
  model.markAccepted(uuid(18));
  assert.deepEqual(model.getPendingUserMessages(), []);
});

test('a message sent to an idle session keeps its turn pending until the session reports running', () => {
  const model = createModel();
  model.setSessionState('idle');
  model.addOptimistic({ clientMessageId: uuid(21), text: 'hello' });
  assert.equal(model.getRunState().running, false, 'not running until the session says so');
  model.setSessionState('idle');
  assert.equal(model.getEntries().at(-1).status, 'sending', 'a stale idle report keeps the pending turn');
  model.setSessionState('running');
  assert.equal(model.getRunState().running, true);
  model.applyLiveEvent(live.result(22));
  assert.equal(model.getRunState().running, false);
});

test('synthetic interrupt texts show as muted notices in the transcript and in live data', () => {
  const model = createModel();
  model.loadTranscript([tx('user', 23, { role: 'user', content: '[Request interrupted by user]' })]);
  model.applyLiveEvent(live.user(24, [{ type: 'text', text: '[Request interrupted by user for tool use]' }]));
  assert.equal(find(model, 'user').length, 0);
  assert.deepEqual(find(model, 'notice').map((entry) => [entry.level, entry.code]),
    [['muted', 'interrupted'], ['muted', 'interrupted-tool']]);
});

test('an interrupted result shows once: the SDK "Interrupted" error line is not listed again', () => {
  const model = createModel();
  model.applyLiveEvent(live.user(25, 'x'));
  model.applyLiveEvent(live.result(26, { subtype: 'error_during_execution', is_error: true, errors: ['Interrupted'] }));
  const footer = find(model, 'result')[0];
  assert.equal(footer.interrupted, true);
  assert.equal(footer.isError, false);
  assert.deepEqual(footer.errors, []);
});

test('a repeated subagent message does not pull later top-level messages into the subagent card', () => {
  const model = createModel();
  model.applyLiveEvent(live.user(27, 'delegate'));
  model.applyLiveEvent(live.assistant(28, 'm1', [{ type: 'tool_use', id: 'AG9', name: 'Agent', input: { prompt: 'p' } }]));
  const child = live.assistant(29, 'm2', [{ type: 'text', text: 'child' }], { parent_tool_use_id: 'AG9' });
  model.applyLiveEvent(child);
  model.applyLiveEvent(child);
  model.applyLiveEvent(live.assistant(30, 'm3', [{ type: 'text', text: 'top level' }]));
  const agent = toolsIn(find(model, 'work')[0])[0];
  assert.deepEqual(agent.children.map((entry) => entry.kind), ['assistant'], 'only the child message is inside the card');
  assert.equal(find(model, 'assistant').at(-1).blocks[0].text, 'top level');
});

test('getUserMessages lists sent user prompts only, in order', () => {
  const model = createModel();
  model.loadTranscript([
    tx('user', 1, { role: 'user', content: 'first' }),
    tx('assistant', 2, { id: 'a', role: 'assistant', content: [{ type: 'tool_use', id: 'U', name: 'Bash', input: {} }] }),
    tx('user', 3, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'U', content: 'r' }] }),
    tx('user', 4, { role: 'user', content: 'second' }, { is_meta: true }),
  ]);
  model.applyLiveEvent(live.user(5, 'third'));
  model.addOptimistic({ clientMessageId: uuid(6), text: 'pending' });
  assert.deepEqual(model.getUserMessages().map((item) => item.text), ['first', 'third']);
  assert.deepEqual(model.getUserMessages().map((item) => item.index), [0, 1]);
});

test('system subtypes map to the rows and notices listed in FRONTEND.md', () => {
  const model = createModel();
  model.applyLiveEvent(live.user(1, 'go'));
  model.applyLiveEvent(live.system(2, 'init', { model: 'x', cwd: '/w', tools: [] }));
  model.applyLiveEvent(live.system(3, 'status', { status: 'compacting' }));
  model.applyLiveEvent(live.system(4, 'compact_boundary', { compact_metadata: { trigger: 'auto', pre_tokens: 150000 } }));
  model.applyLiveEvent(live.system(5, 'api_retry', { attempt: 2, max_retries: 10, retry_delay_ms: 4000, error_status: 529, error: 'overloaded' }));
  model.applyLiveEvent(live.system(6, 'local_command_output', { content: '\u001b[32mok\u001b[0m' }));
  model.applyLiveEvent(live.system(7, 'informational', { content: 'careful', level: 'warning' }));
  model.applyLiveEvent(live.system(8, 'informational', { content: 'plain', level: 'notice' }));
  model.applyLiveEvent(live.system(9, 'informational', { content: 'tip', level: 'suggestion' }));
  model.applyLiveEvent(live.system(10, 'notification', { key: 'k', text: 'toast', priority: 'low' }));
  model.applyLiveEvent(live.system(11, 'permission_denied', { tool_name: 'Bash', tool_use_id: 'P1', message: 'denied', decision_reason: 'rule' }));
  model.applyLiveEvent(live.system(12, 'hook_started', { hook_id: 'h1', hook_name: 'lint', hook_event: 'PostToolUse' }));
  model.applyLiveEvent(live.system(13, 'hook_progress', { hook_id: 'h1', hook_name: 'lint', hook_event: 'PostToolUse', stdout: '', stderr: '', output: 'running' }));
  model.applyLiveEvent(live.system(14, 'hook_response', { hook_id: 'h1', hook_name: 'lint', hook_event: 'PostToolUse', outcome: 'error', output: 'bad', stdout: '', stderr: '' }));
  model.applyLiveEvent(live.system(15, 'task_started', { task_id: 'T', description: 'index repo', task_type: 'local_agent' }));
  model.applyLiveEvent(live.system(16, 'task_progress', { task_id: 'T', description: 'index repo', usage: { total_tokens: 1, tool_uses: 3, duration_ms: 500 }, summary: 'scanning' }));
  model.applyLiveEvent(live.system(17, 'task_notification', { task_id: 'T', status: 'completed', output_file: '/o', summary: 'done' }));
  model.applyLiveEvent(live.system(18, 'memory_recall', { mode: 'select', memories: [{ path: '/m', scope: 'personal' }] }));
  model.applyLiveEvent(live.system(19, 'files_persisted', { files: [], failed: [], processed_at: 'x' }));
  model.applyLiveEvent(live.system(20, 'session_state_changed', { state: 'running' }));
  model.applyLiveEvent(live.system(21, 'mirror_error', { error: 'boom', key: { projectKey: 'p', sessionId: 's' } }));
  model.applyLiveEvent({ type: 'conversation_reset', uuid: uuid(22), session_id: SESSION, new_conversation_id: uuid(23), trigger: 'clear' });
  model.applyLiveEvent({ type: 'rate_limit_event', uuid: uuid(24), session_id: SESSION, rate_limit_info: { status: 'allowed' } });
  model.applyLiveEvent({ type: 'prompt_suggestion', uuid: uuid(25), session_id: SESSION, suggestion: 'next?' });
  model.applyLiveEvent({ type: 'auth_status', uuid: uuid(26), session_id: SESSION, isAuthenticating: false, output: [] });
  model.applyLiveEvent({ type: 'keep_alive' });
  model.applyLiveEvent({ type: 'future_thing', uuid: uuid(27), payload: 1 });

  const entries = model.getEntries();
  const byKind = (kind) => entries.filter((entry) => entry.kind === kind);
  assert.equal(byKind('divider')[0].variant, 'compact');
  assert.equal(byKind('divider')[0].preTokens, 150000);
  assert.equal(byKind('notice').find((entry) => entry.code === 'api-retry').level, 'muted');
  assert.equal(byKind('command-output')[0].text, 'ok');
  const informational = byKind('notice').filter((entry) => entry.code === 'informational');
  assert.deepEqual(informational.map((entry) => entry.level), ['warning', 'muted', 'info']);
  const work = byKind('work')[0];
  const rows = work.items.filter((item) => item.kind === 'row');
  assert.deepEqual(rows.map((row) => row.rowKind), ['denied', 'hook', 'task']);
  const hook = rows.find((row) => row.rowKind === 'hook');
  assert.equal(hook.status, 'error', 'hook response replaces the started row in place');
  assert.equal(hook.output, 'bad');
  const task = rows.find((row) => row.rowKind === 'task');
  assert.equal(task.status, 'completed');
  assert.equal(task.summary, 'done');
  assert.equal(byKind('notice').find((entry) => entry.code === 'memory-recall').vars.count, 1);
  assert.equal(byKind('divider')[1].variant, 'clear');
  assert.equal(byKind('generic').filter((entry) => entry.label === 'system/mirror_error').length, 1);
  assert.equal(byKind('generic').filter((entry) => entry.label === 'future_thing').length, 1);
  assert.equal(byKind('generic').length, 2, 'init, status, notification, rate limit, suggestion, keep alive emit nothing');
});

test('transcript system records without a subtype are skipped rather than shown as empty rows', () => {
  const model = createModel();
  model.loadTranscript([
    tx('user', 1, { role: 'user', content: 'hi' }),
    tx('system', 2, undefined),
  ]);
  assert.equal(model.getEntries().length, 1);
});

test('interrupted result (terminal_reason aborted_*) is not an error', () => {
  const model = createModel();
  model.applyLiveEvent(live.user(1, 'x'));
  model.applyLiveEvent(live.result(2, { subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools', errors: ['Interrupted'] }));
  const footer = find(model, 'result')[0];
  assert.equal(footer.interrupted, true);
  assert.equal(footer.isError, false);
  assert.deepEqual(footer.errors, [], 'the headline already says Interrupted');
});

test('error results list their errors and permission denials', () => {
  const model = createModel();
  model.applyLiveEvent(live.user(1, 'x'));
  model.applyLiveEvent(live.result(2, {
    subtype: 'error_max_turns',
    is_error: true,
    errors: ['Reached the turn limit'],
    permission_denials: [{ tool_name: 'Bash', tool_use_id: 'T', tool_input: {} }],
  }));
  const footer = find(model, 'result')[0];
  assert.equal(footer.isError, true);
  assert.equal(footer.interrupted, false);
  assert.deepEqual(footer.errors, ['Reached the turn limit']);
  assert.deepEqual(footer.permissionDenials, [{ toolName: 'Bash' }]);
  assert.equal(footer.durationMs, 1200);
});

test('assistant API error and unknown assistant blocks are visible', () => {
  const model = createModel();
  model.applyLiveEvent(live.user(1, 'x'));
  model.applyLiveEvent(live.assistant(2, 'm', [{ type: 'mcp_tool_result', tool_use_id: 'z', content: [] }], { error: 'rate_limit' }));
  assert.equal(find(model, 'assistant')[0].blocks[0].kind, 'generic');
});

test('user images and synthetic or meta messages', () => {
  const model = createModel();
  model.applyLiveEvent(live.user(1, [
    { type: 'text', text: 'look' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
    { type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: '<svg/>' } },
  ]));
  assert.deepEqual(find(model, 'user')[0].images, [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }]);
  model.applyLiveEvent(live.user(2, 'Caveat: generated while running commands', { isSynthetic: true }));
  model.applyLiveEvent(live.user(3, '<system-reminder>todo list changed</system-reminder>'));
  model.applyLiveEvent(live.user(4, 'do it', { origin: { kind: 'task-notification' } }));
  const notes = find(model, 'notice').filter((entry) => entry.code === 'user-meta');
  assert.equal(notes.length, 3);
  assert.ok(notes.every((entry) => entry.level === 'muted'));
  assert.equal(notes[1].text, 'todo list changed');
  assert.equal(find(model, 'user').length, 1, 'only the real prompt is a bubble');
});

test('pending requests link to tool cards and sit after the active turn', () => {
  const model = createModel();
  model.applyLiveEvent(live.user(1, 'x'));
  model.applyLiveEvent(live.assistant(2, 'm', [{ type: 'tool_use', id: 'PERM', name: 'Bash', input: { command: 'rm -rf x' } }]));
  model.setPending([{ id: 'req-1', sessionId: SESSION, kind: 'permission', createdAt: 1, toolName: 'Bash', toolUseId: 'PERM' }]);
  assert.equal(toolsIn(find(model, 'work')[0])[0].pendingRequestId, 'req-1');
  const last = model.getEntries().at(-1);
  assert.equal(last.kind, 'request');
  assert.equal(last.key, 'req:req-1');
  model.resolvePending('req-1');
  assert.equal(toolsIn(find(model, 'work')[0])[0].pendingRequestId, null);
  assert.equal(model.getEntries().some((entry) => entry.kind === 'request'), false);
});

test('session state idle closes the running turn and drops the draft', () => {
  const model = createModel();
  model.applyLiveEvent(live.user(1, 'x'));
  model.applyLiveEvent(live.assistant(2, 'm', [{ type: 'tool_use', id: 'K', name: 'Bash', input: {} }]));
  assert.equal(model.getRunState().running, true);
  model.setSessionState('idle');
  assert.equal(model.getRunState().running, false);
  assert.equal(find(model, 'work')[0].open, false);
  model.setSessionState('running');
  assert.equal(model.getRunState().running, false, 'a closed turn stays closed');
});

test('prependTranscript rebuilds older history before the current entries and keeps tool pairing', () => {
  const model = createModel();
  model.loadTranscript([
    tx('user', 3, { role: 'user', content: 'second question' }),
    tx('user', 4, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'OLD', content: 'late result' }] }),
  ]);
  model.prependTranscript([
    tx('user', 1, { role: 'user', content: 'first question' }),
    tx('assistant', 2, { id: 'a', role: 'assistant', content: [{ type: 'tool_use', id: 'OLD', name: 'Bash', input: {} }] }),
  ]);
  assert.deepEqual(kinds(model), ['user', 'work', 'user']);
  assert.equal(toolsIn(find(model, 'work')[0])[0].result.content, 'late result');
  assert.equal(model.getUserMessages().length, 2);
});

test('versions change only for entries that changed (incremental rendering)', () => {
  const model = createModel();
  model.applyLiveEvent(live.user(1, 'x'));
  model.applyLiveEvent(live.assistant(2, 'a', [{ type: 'text', text: 'one' }]));
  const before = model.getEntries();
  const userVersion = before[0].version;
  const bubbleVersion = before[1].version;
  model.applyLiveEvent(live.assistant(3, 'b', [{ type: 'text', text: 'two' }]));
  const after = model.getEntries();
  assert.equal(after[0].version, userVersion);
  assert.equal(after[1].version, bubbleVersion);
  assert.ok(model.getVersion() > 0);
});

test('malformed input never throws and degrades to generic entries', () => {
  const model = createModel();
  const hostile = [
    null,
    42,
    'text',
    [],
    { type: 'assistant' },
    { type: 'assistant', message: null },
    { type: 'assistant', uuid: uuid(1), message: { id: 1, content: [null, 3, { type: 'tool_use' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result' }] } },
    { type: 'system' },
    { type: 'system', subtype: 42 },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: null } },
    { type: 'result' },
  ];
  for (const message of hostile) {
    assert.doesNotThrow(() => model.applyLiveEvent(message));
  }
  assert.doesNotThrow(() => model.loadTranscript(hostile));
  assert.doesNotThrow(() => model.getEntries());
  assert.doesNotThrow(() => model.getUserMessages());
  assert.doesNotThrow(() => model.setPending([null, {}, { id: 3 }]));
});

test('fuzz: 500 random and garbage messages never throw and always yield renderable entries', () => {
  let seed = 0x9e3779b9;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (items) => items[Math.floor(random() * items.length)];
  const types = ['user', 'assistant', 'system', 'result', 'stream_event', 'tool_progress', 'tool_use_summary', 'conversation_reset', 'weird', undefined, null, 7];
  const subtypes = ['init', 'status', 'compact_boundary', 'api_retry', 'hook_started', 'hook_response', 'task_started', 'task_notification', 'permission_denied', 'informational', 'session_state_changed', 'nope', undefined];
  const blockTypes = ['text', 'thinking', 'tool_use', 'tool_result', 'image', 'server_tool_use', 'web_search_tool_result', 'redacted_thinking', 'zzz', undefined];
  const randomBlock = () => {
    const type = pick(blockTypes);
    return pick([null, 1, 'x', {
      type,
      text: pick(['a', undefined, 3]),
      id: pick(['T1', 'T2', undefined]),
      name: pick(['Bash', 'Agent', undefined]),
      input: pick([{}, null, 'str', { command: 'x' }]),
      tool_use_id: pick(['T1', 'T2', 'missing']),
      content: pick(['c', [{ type: 'text', text: 't' }, null], undefined, { type: 'web_search_tool_result_error', error_code: 'x' }]),
      is_error: pick([true, false, undefined]),
      source: pick([{ type: 'base64', media_type: 'image/png', data: 'AAAA' }, null]),
    }]);
  };
  const randomMessage = () => {
    const type = pick(types);
    const message = {
      type,
      uuid: pick([uuid(Math.floor(random() * 40)), undefined, null, 5]),
      subtype: pick(subtypes),
      parent_tool_use_id: pick([null, 'T1', 'T2', 'ghost', undefined]),
      message: pick([undefined, null, { id: pick(['m1', 'm2', undefined]), content: pick([[randomBlock(), randomBlock()], 'str', null]) }]),
      event: pick([undefined, { type: 'message_start', message: { id: 'm1' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'z' } }, { type: 'message_stop' }, null]),
      state: pick(['idle', 'running', undefined]),
      status: pick(['compacting', null, undefined]),
      preceding_tool_use_ids: pick([['T1'], undefined, 'x']),
      summary: 'sum',
      tool_use_id: pick(['T1', 'T2', undefined]),
      elapsed_time_seconds: pick([1.5, undefined, 'x']),
      is_error: pick([true, false, undefined]),
      subtype_result: undefined,
      terminal_reason: pick(['aborted_streaming', 'completed', undefined, 3]),
      errors: pick([['e'], undefined, 'nope']),
      permission_denials: pick([[{ tool_name: 'B' }], undefined, null]),
      tool_use_result: pick([{ a: 1 }, undefined]),
    };
    return pick([message, message, message, null, 'string', 17, []]);
  };
  const model = createModel();
  for (let i = 0; i < 500; i += 1) {
    const item = randomMessage();
    if (random() < 0.1) {
      assert.doesNotThrow(() => model.loadTranscript([item]));
    } else if (random() < 0.05) {
      assert.doesNotThrow(() => model.addOptimistic({ clientMessageId: uuid(i % 7), text: 'q', attachments: [null, { path: 'p' }] }));
    } else if (random() < 0.03) {
      assert.doesNotThrow(() => model.setPending([{ id: `r${i % 3}`, kind: 'permission', toolUseId: pick(['T1', undefined]) }]));
    } else {
      assert.doesNotThrow(() => model.applyLiveEvent(item));
    }
    if (i % 50 === 0) {
      const entries = model.getEntries();
      assert.ok(Array.isArray(entries));
      for (const entry of entries) {
        assert.equal(typeof entry.kind, 'string');
        assert.equal(typeof entry.key, 'string');
      }
    }
  }
  assert.doesNotThrow(() => model.getEntries());
  assert.doesNotThrow(() => model.getUserMessages());
  assert.doesNotThrow(() => model.getRunState());
});

/** Entries grouped by the user message that starts each turn. */
const turnGroups = (model) => {
  const groups = [];
  for (const entry of model.getEntries()) {
    if (entry.kind === 'user' || groups.length === 0) groups.push([]);
    groups[groups.length - 1].push(entry);
  }
  return groups;
};

test('a result names its turn, so results of earlier turns stay in their turns after a reload', () => {
  const model = createModel();
  model.loadTranscript([
    tx('user', 101, { role: 'user', content: 'hook run' }),
    tx('assistant', 102, { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Checked.' }] }),
    tx('user', 103, { role: 'user', content: 'error please' }),
    tx('assistant', 104, { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'Trying.' }] }),
    tx('user', 105, { role: 'user', content: 'slow stream' }),
    tx('assistant', 106, { id: 'm3', role: 'assistant', content: [{ type: 'text', text: 'Streaming.' }] }),
  ]);
  // A reload's snapshot holds the results, which the transcript never has, after the transcript has been applied.
  model.applyLiveEvent(live.result(201, { user_message_uuid: uuid(101), user_message_uuids: [uuid(101)] }));
  model.applyLiveEvent(live.result(202, {
    user_message_uuid: uuid(103),
    user_message_uuids: [uuid(103)],
    subtype: 'error_during_execution',
    is_error: true,
    errors: ['boom'],
  }));
  const [first, second, third] = turnGroups(model);
  assert.deepEqual(first.map((entry) => entry.kind), ['user', 'assistant', 'result']);
  assert.equal(first[2].isError, false);
  assert.deepEqual(second.map((entry) => entry.kind), ['user', 'assistant', 'result']);
  assert.equal(second[2].isError, true);
  assert.deepEqual(third.map((entry) => entry.kind), ['user', 'assistant']);
});

test('a result without a user message uuid never joins a turn that already has its result', () => {
  const model = createModel();
  model.loadTranscript([
    tx('user', 101, { role: 'user', content: 'first' }),
    tx('user', 103, { role: 'user', content: 'second' }),
  ]);
  model.applyLiveEvent(live.result(201));
  model.applyLiveEvent(live.result(202));
  assert.equal(find(model, 'result').length, 1);
});

test('a live copy of a transcript message moves the cursor to its turn, so a result without a name lands there', () => {
  const model = createModel();
  model.loadTranscript([
    tx('user', 101, { role: 'user', content: 'first' }),
    tx('assistant', 102, { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'One.' }] }),
    tx('user', 103, { role: 'user', content: 'second' }),
    tx('assistant', 104, { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'Two.' }] }),
  ]);
  model.applyLiveEvent(live.assistant(102, 'm1', [{ type: 'text', text: 'One.' }]));
  model.applyLiveEvent(live.result(201));
  const [first, second] = turnGroups(model);
  assert.deepEqual(first.map((entry) => entry.kind), ['user', 'assistant', 'result']);
  assert.deepEqual(second.map((entry) => entry.kind), ['user', 'assistant']);
});

test('a message that names an earlier turn lands there, and the messages after it without a name follow it', () => {
  const model = createModel();
  model.loadTranscript([
    tx('user', 101, { role: 'user', content: 'first' }),
    tx('user', 103, { role: 'user', content: 'second' }),
  ]);
  model.applyLiveEvent(live.assistant(202, 'late', [{ type: 'text', text: 'Late reply.' }], { user_message_uuid: uuid(101) }));
  model.applyLiveEvent(live.system(203, 'informational', { content: 'Note.', level: 'info' }));
  const [first, second] = turnGroups(model);
  assert.deepEqual(first.map((entry) => entry.kind), ['user', 'assistant', 'notice']);
  assert.deepEqual(second.map((entry) => entry.kind), ['user']);
});

test('a message that follows a finished turn joins the next turn of the timeline, not a new turn at the end', () => {
  const model = createModel();
  model.loadTranscript([
    tx('user', 101, { role: 'user', content: 'first' }),
    tx('user', 103, { role: 'user', content: 'second' }),
    tx('user', 105, { role: 'user', content: 'third' }),
  ]);
  model.applyLiveEvent(live.result(201, { user_message_uuid: uuid(101), user_message_uuids: [uuid(101)] }));
  model.applyLiveEvent(live.system(202, 'informational', { content: 'Note.', level: 'info' }));
  assert.deepEqual(kinds(model), ['user', 'result', 'user', 'notice', 'user']);
});

test('progress rows without tool steps form a group with no step count, and empty groups are never listed', () => {
  const model = createModel();
  model.applyLiveEvent(live.user(1, 'run'));
  model.applyLiveEvent(live.system(2, 'hook_started', { hook_id: 'h1', hook_name: 'Policy', hook_event: 'PreToolUse' }));
  model.applyLiveEvent(live.system(3, 'hook_response', {
    hook_id: 'h1', hook_name: 'Policy', hook_event: 'PreToolUse', outcome: 'success', output: 'ok',
  }));
  const [group] = find(model, 'work');
  assert.equal(group.count, 0, 'progress rows are not tool steps');
  assert.equal(toolsIn(group).length, 0);
  assert.equal(group.items.length, 1, 'the start and the response of one hook share one row');
  assert.equal(group.items[0].rowKind, 'hook');
  assert.equal(group.items[0].status, 'success');
  assert.ok(model.getEntries().every((entry) => entry.kind !== 'work' || entry.items.length > 0));
});

test('a retry reuses the failed message clientMessageId: once discarded it is added again as one pending message', () => {
  const model = createModel();
  model.addOptimistic({ clientMessageId: 'retry-1', text: 'again' });
  model.markFailed('retry-1', 'network down');
  model.discardOptimistic('retry-1');
  assert.equal(find(model, 'user').length, 0);
  model.addOptimistic({ clientMessageId: 'retry-1', text: 'again' });
  model.addOptimistic({ clientMessageId: 'retry-1', text: 'again' });
  const users = find(model, 'user');
  assert.equal(users.length, 1, 'a second add of the same id while it is pending adds nothing');
  assert.equal(users[0].clientMessageId, 'retry-1');
  assert.equal(users[0].status, 'sending');
  assert.equal(users[0].error, null);
  model.markAccepted('retry-1');
  assert.equal(find(model, 'user')[0].status, 'sent');
});

test('every change inside a subagent flow touches its Agent card and the work group that holds it', () => {
  const model = createModel();
  model.applyLiveEvent(live.user(1, 'delegate'));
  model.applyLiveEvent(live.assistant(2, 'm-agent', [{ type: 'tool_use', id: 'agent-1', name: 'Agent', input: { prompt: 'x' } }]));
  const [group] = find(model, 'work');
  const owner = group.items[0];

  let cardVersion = owner.version;
  let groupVersion = group.version;
  model.applyLiveEvent(live.assistant(3, 'm-child', [{ type: 'text', text: 'first' }], { parent_tool_use_id: 'agent-1' }));
  assert.ok(owner.version > cardVersion, 'a child message touches the card');
  assert.ok(group.version > groupVersion, 'and the work group that holds the card');

  cardVersion = owner.version;
  model.applyLiveEvent(live.assistant(4, 'm-child', [{ type: 'text', text: 'second' }], { parent_tool_use_id: 'agent-1' }));
  assert.ok(owner.version > cardVersion, 'a further block in the same child bubble touches the card');

  cardVersion = owner.version;
  model.applyLiveEvent(live.assistant(5, 'm-child-tool', [{ type: 'tool_use', id: 'read-1', name: 'Read', input: {} }],
    { parent_tool_use_id: 'agent-1' }));
  assert.ok(owner.version > cardVersion, 'a child tool card touches the card');

  cardVersion = owner.version;
  model.applyLiveEvent(live.toolResult(6, 'read-1', 'ok', { parent_tool_use_id: 'agent-1' }));
  assert.ok(owner.version > cardVersion, 'a child tool result touches the card');

  cardVersion = owner.version;
  model.applyLiveEvent(live.system(7, 'task_progress', { task_id: 't1', tool_use_id: 'agent-1', description: 'Reading',
    usage: { tool_uses: 1, duration_ms: 500 }, parent_tool_use_id: 'agent-1' }));
  assert.ok(owner.version > cardVersion, 'a progress row inside the subagent touches the card');

  cardVersion = owner.version;
  model.applyLiveEvent(live.system(8, 'informational', { content: 'Note from the agent.', level: 'info', parent_tool_use_id: 'agent-1' }));
  assert.ok(owner.version > cardVersion, 'a notice inside the subagent touches the card');
  assert.equal(owner.children.length > 0, true, 'the card keeps its children');
});

test('a tool result touches its work group even when the group still runs other tools', () => {
  const model = createModel();
  model.applyLiveEvent(live.user(1, 'go'));
  model.applyLiveEvent(live.assistant(2, 'm1', [
    { type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'ls' } },
    { type: 'tool_use', id: 'bash-2', name: 'Bash', input: { command: 'pwd' } },
  ]));
  const [group] = find(model, 'work');
  const groupVersion = group.version;
  model.applyLiveEvent(live.toolResult(3, 'bash-1', 'ok'));
  assert.equal(group.count, 2, 'the count does not change, so only the result can refresh the group');
  assert.ok(group.version > groupVersion);
  assert.equal(toolsIn(group)[0].running, false);
  assert.equal(toolsIn(group)[1].running, true);
});

test('a running tool updates its work group: elapsed time and a pending permission show in the group header and rows', () => {
  const model = createModel();
  model.applyLiveEvent(live.user(1, 'run'));
  model.applyLiveEvent(live.assistant(2, 'm1', [{ type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'ls' } }]));
  const [group] = find(model, 'work');

  let version = group.version;
  model.applyLiveEvent({ type: 'tool_progress', uuid: uuid(3), session_id: SESSION, tool_use_id: 'bash-1', elapsed_time_seconds: 3 });
  assert.equal(toolsIn(group)[0].elapsedSeconds, 3);
  assert.ok(group.version > version, 'the group header shows the elapsed time');

  version = group.version;
  model.setPending([{ id: 'rq-1', toolUseId: 'bash-1', kind: 'permission', sessionId: SESSION }]);
  assert.equal(toolsIn(group)[0].pendingRequestId, 'rq-1');
  assert.ok(group.version > version, 'a permission waiting on a tool touches its group');
});

test('an ENGINE_UNAVAILABLE notice adds one inline error notice, once, and a replay keeps it', () => {
  const model = createModel();
  model.loadTranscript([tx('user', 101, { role: 'user', content: 'hello' })]);
  model.applyNotice({ code: 'ENGINE_UNAVAILABLE', level: 'error', text: '' });
  model.applyNotice({ code: 'ENGINE_UNAVAILABLE', level: 'error', text: '' });
  const notices = find(model, 'notice');
  assert.equal(notices.length, 1, 'the same notice right after itself is not repeated');
  assert.equal(notices[0].code, 'ENGINE_UNAVAILABLE');
  assert.equal(notices[0].level, 'error');
  assert.deepEqual(kinds(model), ['user', 'notice']);

  model.prependTranscript([tx('user', 100, { role: 'user', content: 'older' })]);
  assert.deepEqual(kinds(model), ['user', 'user', 'notice'], 'the notice survives a replay of the older page');
});

test('an inline notice with no open turn starts one, and a notice after a finished turn joins the next one', () => {
  const model = createModel();
  model.applyNotice({ code: 'ENGINE_UNAVAILABLE', level: 'error', text: '' });
  assert.deepEqual(kinds(model), ['notice']);
  model.applyLiveEvent(live.user(1, 'later'));
  model.applyLiveEvent(live.result(2));
  model.applyNotice({ code: 'ENGINE_UNAVAILABLE', level: 'error', text: '' });
  assert.deepEqual(kinds(model), ['notice', 'user', 'result', 'notice']);
});

test('a permission suggestion starts checked only when it adds an allow rule', () => {
  assert.equal(isDefaultChecked({ type: 'addRules', behavior: 'allow', rules: [], destination: 'localSettings' }), true);
  assert.equal(isDefaultChecked({ type: 'replaceRules', behavior: 'allow', rules: [] }), true);
  assert.equal(isDefaultChecked({ type: 'addRules', behavior: 'deny', rules: [] }), false, 'a deny rule is never applied by default');
  assert.equal(isDefaultChecked({ type: 'addDirectories', directories: ['/home/u/.ssh'], destination: 'session' }), false);
  assert.equal(isDefaultChecked({ type: 'setMode', mode: 'acceptEdits', destination: 'session' }), false);
  assert.equal(isDefaultChecked({ type: 'removeRules', behavior: 'allow', rules: [] }), false);
  assert.equal(isDefaultChecked(null), false);
});

test('every suggestion reads as what it changes, with where the change is kept', () => {
  const t = (key, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key);
  const rule = describeSuggestion({
    type: 'addRules', behavior: 'allow', destination: 'localSettings',
    rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }, { toolName: 'Read' }],
  }, t);
  assert.equal(rule.title, 'cards.request.suggestion.allow {"rules":"Bash(npm test:*), Read"}');
  assert.equal(rule.meta, 'cards.request.destination {"where":"cards.request.dest.localSettings"}');

  const dirs = describeSuggestion({ type: 'addDirectories', directories: ['/home/u/.ssh'], destination: 'session' }, t);
  assert.equal(dirs.title, 'cards.request.suggestion.directories {"dirs":"/home/u/.ssh"}');
  assert.equal(dirs.meta, 'cards.request.destination {"where":"cards.request.dest.session"}');

  const mode = describeSuggestion({ type: 'setMode', mode: 'acceptEdits', destination: 'userSettings' }, t);
  assert.equal(mode.title, 'cards.request.suggestion.mode {"mode":"cards.request.plan.mode.acceptEdits"}');

  const unknown = describeSuggestion({ type: 'mysteryUpdate' }, t);
  assert.equal(unknown.title, 'cards.request.suggestion.other {"detail":"mysteryUpdate"}');
  assert.equal(unknown.meta, '', 'no destination, no meta line');
});

test('checked suggestions give the indexes that an always-allow answer sends, and a tool name alone is a rule', () => {
  assert.deepEqual(checkedIndexes([true, false, true]), [0, 2]);
  assert.deepEqual(checkedIndexes([false, false]), []);
  assert.equal(ruleText({ toolName: 'Bash', ruleContent: 'npm test:*' }), 'Bash(npm test:*)');
  assert.equal(ruleText({ toolName: 'WebFetch' }), 'WebFetch');
  assert.equal(ruleText({ toolName: '  ' }), '');
});
