// The transitions of the live context meter (src/engine/context-meter.mjs): the sources of `used`, how a call's usage
// streams in, what a window answer and a compaction change, and what a transcript says about its last call and about
// its compactions.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyWindow,
  callUsageOf,
  countAfterCompaction,
  emptyContextMeter,
  endCompaction,
  estimateAfterCompaction,
  fillUsed,
  isCompactPrompt,
  isNewerCall,
  isSubagentMessage,
  observeUsage,
  postTokensOf,
  recordCompaction,
  snapshotContextMeter,
  startCompaction,
  transcriptContextOf,
  usageTokens,
} from '../../src/engine/context-meter.mjs';

/** A usage object of the Messages API. */
function usage(input, output = 0, cacheCreate = 0, cacheRead = 0) {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: cacheCreate,
    cache_read_input_tokens: cacheRead,
  };
}

/** The stream_event that opens a main-thread call (or a subagent call when `parent` is given). */
function start(id, input, { cacheCreate = 0, cacheRead = 0, output = 1, parent = null } = {}) {
  return {
    type: 'stream_event',
    uuid: `stream-${id}`,
    session_id: 'session',
    parent_tool_use_id: parent,
    event: { type: 'message_start', message: { id, usage: usage(input, output, cacheCreate, cacheRead) } },
  };
}

/** The stream_event that reports the output of the call so far. */
function delta(output) {
  return {
    type: 'stream_event',
    uuid: `delta-${output}`,
    session_id: 'session',
    parent_tool_use_id: null,
    event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: output } },
  };
}

/** The assistant message of a call: its id, usage and the parent it belongs to. */
function assistant(id, input, output, { cacheCreate = 0, cacheRead = 0, parent = null } = {}) {
  return {
    type: 'assistant',
    uuid: `assistant-${id}-${output}`,
    session_id: 'session',
    parent_tool_use_id: parent,
    message: {
      id,
      role: 'assistant',
      model: 'sonnet',
      content: [],
      usage: usage(input, output, cacheCreate, cacheRead),
    },
  };
}

describe('the meter record', () => {
  test('an empty meter knows nothing, and a snapshot shares no object with the meter', () => {
    const meter = emptyContextMeter();
    assert.deepEqual(meter, {
      used: null,
      max: null,
      autoCompactAt: null,
      autoCompact: null,
      source: null,
      compacting: null,
      lastCompaction: null,
    });
    meter.compacting = { since: 1, trigger: null };
    meter.lastCompaction = { trigger: 'auto', preTokens: 1, postTokens: null, durationMs: null, at: 1 };
    const copy = snapshotContextMeter(meter);
    copy.compacting.since = 2;
    copy.lastCompaction.preTokens = 2;
    assert.equal(meter.compacting.since, 1);
    assert.equal(meter.lastCompaction.preTokens, 1);
    assert.equal(snapshotContextMeter(emptyContextMeter()).compacting, null);
  });
});

describe('usage of a call', () => {
  test('the prompt side is input, cache creation and cache read, and a usage without input belongs to no call', () => {
    assert.deepEqual(callUsageOf(usage(3, 10, 100, 900)), { prompt: 1003, output: 10 });
    assert.deepEqual(callUsageOf({ input_tokens: null, cache_read_input_tokens: 500, output_tokens: null }),
      { prompt: 500, output: 0 });
    assert.equal(callUsageOf(usage(0, 0)), null, 'a synthetic message reports zeros');
    assert.equal(callUsageOf({ input_tokens: -5, output_tokens: 3 }), null, 'a negative count is not a count');
    assert.equal(callUsageOf(undefined), null);
    assert.equal(usageTokens(usage(3, 100, 0, 40000)), 40103);
    assert.equal(usageTokens(usage(0, 0)), null);
  });

  test('a subagent message is one that names the tool call that started it', () => {
    assert.equal(isSubagentMessage({ parent_tool_use_id: 'toolu_1' }), true);
    assert.equal(isSubagentMessage({ parent_tool_use_id: null }), false);
    assert.equal(isSubagentMessage({}), false);
  });

  test('a /compact prompt is the command with or without instructions, and nothing else', () => {
    for (const text of ['/compact', '/compact  ', '  /compact keep the plan', '/compact\nplease']) {
      assert.equal(isCompactPrompt(text), true, text);
    }
    for (const text of ['/compactly', 'please /compact', '/Compact', '/context', '']) {
      assert.equal(isCompactPrompt(text), false, text);
    }
  });
});

describe('streamed usage', () => {
  test('a main-thread call shows its prompt at once, and its output grows with the stream but never goes back', () => {
    const meter = emptyContextMeter();
    let call = observeUsage(meter, null, start('m1', 3, { cacheRead: 40000 }));
    assert.deepEqual([meter.used, meter.source], [40004, 'stream']);
    call = observeUsage(meter, call, delta(250));
    assert.equal(meter.used, 40253);
    call = observeUsage(meter, call, delta(100));
    assert.equal(meter.used, 40253, 'a smaller output does not lower the call');
    call = observeUsage(meter, call, assistant('m1', 3, 250, { cacheRead: 40000 }));
    assert.equal(meter.used, 40253, 'the final message of the same call changes nothing more');
    assert.equal(call.id, 'm1');
  });

  test('a new message id opens a new call, whatever its size', () => {
    const meter = emptyContextMeter();
    let call = observeUsage(meter, null, assistant('m1', 3, 500, { cacheRead: 60000 }));
    assert.equal(meter.used, 60503);
    call = observeUsage(meter, call, assistant('m2', 3, 5, { cacheRead: 1000 }));
    assert.equal(meter.used, 1008);
    assert.equal(call.id, 'm2');
  });

  test('a subagent message changes nothing and keeps the call of the main thread', () => {
    const meter = emptyContextMeter();
    const call = observeUsage(meter, null, start('m1', 3, { cacheRead: 40000 }));
    const before = snapshotContextMeter(meter);
    const kept = observeUsage(meter, call, start('s1', 6000, { parent: 'toolu_9' }));
    assert.deepEqual(meter, before);
    assert.equal(kept, call);
    assert.equal(observeUsage(meter, call, assistant('s1', 6000, 900, { parent: 'toolu_9' })), call);
    assert.deepEqual(meter, before);
  });

  test('a message whose usage belongs to no call, or that carries no usage, changes nothing', () => {
    const meter = emptyContextMeter();
    assert.equal(observeUsage(meter, null, assistant('x', 0, 0)), null);
    assert.equal(observeUsage(meter, null, delta(50)), null, 'a delta with no open call');
    assert.equal(observeUsage(meter, null, { type: 'user', message: {}, parent_tool_use_id: null }), null);
    assert.equal(observeUsage(meter, null, { type: 'stream_event', parent_tool_use_id: null }), null);
    assert.deepEqual(meter, emptyContextMeter());
  });
});

describe('sources of used', () => {
  test('a source fills the meter only when it ranks at least as high as the current one', () => {
    const meter = emptyContextMeter();
    fillUsed(meter, 39116, 'estimate');
    assert.deepEqual([meter.used, meter.source], [39116, 'estimate']);
    fillUsed(meter, 50000, 'transcript');
    assert.deepEqual([meter.used, meter.source], [50000, 'transcript']);
    fillUsed(meter, 60000, 'estimate');
    assert.deepEqual([meter.used, meter.source], [50000, 'transcript'], 'an estimate never replaces a transcript');
    fillUsed(meter, 70000, 'api-usage');
    assert.deepEqual([meter.used, meter.source], [70000, 'api-usage']);
    fillUsed(meter, 80000, 'transcript');
    assert.equal(meter.used, 70000);
    fillUsed(meter, 90000, 'api-usage');
    assert.equal(meter.used, 90000, 'an equal rank replaces');
    fillUsed(meter, null, 'api-usage');
    fillUsed(meter, -1, 'api-usage');
    fillUsed(meter, Number.NaN, 'api-usage');
    assert.equal(meter.used, 90000, 'a missing or invalid count changes nothing');
  });

  test('nothing replaces a value from the stream', () => {
    const meter = emptyContextMeter();
    observeUsage(meter, null, start('m1', 3, { cacheRead: 40000 }));
    fillUsed(meter, 10, 'api-usage');
    fillUsed(meter, 10, 'transcript');
    fillUsed(meter, 10, 'estimate');
    assert.deepEqual([meter.used, meter.source], [40004, 'stream']);
  });
});

describe('window and compactions', () => {
  test('the window and threshold come from the answer; the threshold applies only while auto-compact is on', () => {
    const meter = emptyContextMeter();
    applyWindow(meter, { maxTokens: 100000, autoCompactThreshold: 67000, isAutoCompactEnabled: true });
    assert.deepEqual([meter.max, meter.autoCompact, meter.autoCompactAt], [100000, true, 67000]);
    applyWindow(meter, { isAutoCompactEnabled: false, autoCompactThreshold: 67000 });
    assert.deepEqual([meter.max, meter.autoCompact, meter.autoCompactAt], [100000, false, null]);
    applyWindow(meter, { maxTokens: 200000 });
    assert.deepEqual([meter.max, meter.autoCompact, meter.autoCompactAt], [200000, false, null]);
    applyWindow(meter, { isAutoCompactEnabled: true });
    assert.deepEqual([meter.max, meter.autoCompact, meter.autoCompactAt], [200000, true, null]);
  });

  test('an answer that leaves the switch out keeps the switch the meter had', () => {
    const meter = emptyContextMeter();
    applyWindow(meter, { maxTokens: 1 });
    assert.equal(meter.autoCompact, null);
    applyWindow(meter, { maxTokens: 2, isAutoCompactEnabled: true, autoCompactThreshold: 5 });
    applyWindow(meter, { maxTokens: 3 });
    assert.deepEqual([meter.max, meter.autoCompact, meter.autoCompactAt], [3, true, 5]);
  });

  test('a compaction starts once and ends with a null status', () => {
    const meter = emptyContextMeter();
    startCompaction(meter, 100, null);
    startCompaction(meter, 200, 'manual');
    assert.deepEqual(meter.compacting, { since: 100, trigger: null });
    endCompaction(meter);
    assert.equal(meter.compacting, null);
  });

  test('a boundary records the compaction: its trigger first, then the trigger of the start, then auto', () => {
    const meter = emptyContextMeter();
    startCompaction(meter, 10, 'manual');
    const boundary = { trigger: 'auto', pre_tokens: 75000, post_tokens: 2069, duration_ms: 1200 };
    assert.equal(recordCompaction(meter, boundary, 20), true);
    assert.deepEqual(meter.lastCompaction, {
      trigger: 'auto', preTokens: 75000, postTokens: 2069, durationMs: 1200, at: 20,
    });
    assert.equal(meter.compacting, null, 'the boundary ends the compaction');

    startCompaction(meter, 30, 'manual');
    recordCompaction(meter, { pre_tokens: 40000 }, 40);
    assert.deepEqual(meter.lastCompaction, {
      trigger: 'manual', preTokens: 40000, postTokens: null, durationMs: null, at: 40,
    });

    recordCompaction(meter, { pre_tokens: 41000, trigger: 'sideways' }, 50);
    assert.equal(meter.lastCompaction.trigger, 'auto', 'an unknown trigger without a start is auto');
  });

  test('a boundary without a size before the compaction records nothing, and still ends the compaction', () => {
    const meter = emptyContextMeter();
    startCompaction(meter, 10, 'manual');
    const kept = { trigger: 'auto', preTokens: 5, postTokens: null, durationMs: null, at: 1 };
    meter.lastCompaction = kept;
    assert.equal(recordCompaction(meter, { post_tokens: 5 }, 60), false);
    assert.equal(recordCompaction(meter, undefined, 61), false);
    assert.equal(meter.compacting, null);
    assert.deepEqual(meter.lastCompaction, kept);
  });
});

describe('after a compaction', () => {
  test('a call is newer than the boundary when it has another id, or when the boundary had no call', () => {
    const atBoundary = { id: 'msg_1', prompt: 40000, output: 10 };
    assert.equal(isNewerCall(null, null), false, 'no call at all');
    assert.equal(isNewerCall(null, atBoundary), false, 'nothing has streamed since the boundary');
    assert.equal(isNewerCall(atBoundary, null), true, 'a call after a boundary that had none');
    assert.equal(isNewerCall({ ...atBoundary, output: 500 }, atBoundary), false, 'the same call, with more output');
    assert.equal(isNewerCall({ id: 'msg_2', prompt: 10, output: 0 }, atBoundary), true, 'another call');
  });

  test('without ids a call is compared as an object, so a grown copy of the boundary call counts as newer', () => {
    const atBoundary = { id: null, prompt: 40000, output: 10 };
    assert.equal(isNewerCall(atBoundary, atBoundary), false);
    assert.equal(isNewerCall({ ...atBoundary, output: 500 }, atBoundary), true);
  });

  test('the estimate is the fixed part plus what the compaction leaves, whatever the meter showed before', () => {
    const meter = emptyContextMeter();
    fillUsed(meter, 50000, 'transcript');
    countAfterCompaction(meter, 60000, false);
    estimateAfterCompaction(meter, 39116, 2069);
    assert.deepEqual([meter.used, meter.source], [41185, 'estimate']);
    observeUsage(meter, null, start('m2', 3, { cacheRead: 3000 }));
    assert.deepEqual([meter.used, meter.source], [3004, 'stream'], 'a call that streams after it replaces it');
  });

  test('without both sizes the value stays, as an estimate that a later fill may replace', () => {
    const meter = emptyContextMeter();
    observeUsage(meter, null, start('m1', 3, { cacheRead: 40000 }));
    estimateAfterCompaction(meter, null, 2069);
    assert.deepEqual([meter.used, meter.source], [40004, 'estimate']);
    fillUsed(meter, 39116, 'estimate');
    assert.deepEqual([meter.used, meter.source], [39116, 'estimate']);
    const empty = emptyContextMeter();
    estimateAfterCompaction(empty, 39116, null);
    assert.deepEqual([empty.used, empty.source], [null, null], 'nothing is known, so nothing is estimated');
  });

  test('post_tokens of a boundary is the size it leaves, when its metadata gives one', () => {
    assert.equal(postTokensOf({ pre_tokens: 1, post_tokens: 2069 }), 2069);
    assert.equal(postTokensOf({ post_tokens: -1 }), null);
    assert.equal(postTokensOf(undefined), null);
  });
});

describe('the context a transcript records', () => {
  test('the last main-thread call counts, skipping subagent messages and synthetic ones', () => {
    const messages = [
      { type: 'user' },
      { type: 'assistant', parent_tool_use_id: null, message: { usage: usage(3, 100, 0, 40000) } },
      { type: 'assistant', parent_tool_use_id: 'toolu_1', message: { usage: usage(6000, 50) } },
      { type: 'assistant', parent_tool_use_id: null, message: { usage: usage(0, 0) } },
    ];
    assert.deepEqual(transcriptContextOf(messages), { tokens: 40103, compacted: false });
  });

  test('a transcript with no call and no compaction knows nothing', () => {
    assert.deepEqual(transcriptContextOf([]), { tokens: null, compacted: false });
    assert.deepEqual(transcriptContextOf([{ type: 'user' }]), { tokens: null, compacted: false });
  });

  test('a compaction with no call after it leaves the size unknown, in the runtime shape and in the mock shape', () => {
    const before = assistant('m1', 3, 100, { cacheRead: 40000 });
    // getSessionMessages returns the boundary without subtype or message, and the summary with its flag (PROTOCOL.md).
    const runtime = [
      before,
      { type: 'system', uuid: 'boundary', session_id: 'session', parent_tool_use_id: null, parent_agent_id: null },
      { type: 'user', uuid: 'summary', message: { role: 'user', content: 'Summary' }, isCompactSummary: true,
        is_meta: true },
    ];
    assert.deepEqual(transcriptContextOf(runtime), { tokens: null, compacted: true });
    // The mock keeps the subtype of the boundary in its message, and its summary is a plain user message.
    const mock = [
      before,
      { type: 'system', parent_tool_use_id: null, message: { type: 'system', subtype: 'compact_boundary' } },
      { type: 'user', message: { role: 'user', content: 'Summary' } },
    ];
    assert.deepEqual(transcriptContextOf(mock), { tokens: null, compacted: true });
    assert.deepEqual(transcriptContextOf([before, { type: 'system', subtype: 'compact_boundary' }]),
      { tokens: null, compacted: true }, 'a boundary with its subtype at the top level is a marker too');
  });

  test('a call after the compaction counts, and an older call before it does not', () => {
    const summary = { type: 'user', isCompactSummary: true, message: { role: 'user', content: 'Summary' } };
    const transcript = [assistant('m1', 3, 100, { cacheRead: 40000 }), summary, assistant('m2', 3, 50,
      { cacheRead: 9000 })];
    assert.deepEqual(transcriptContextOf(transcript), { tokens: 9053, compacted: false });
    const subagent = assistant('s1', 6000, 900, { parent: 'toolu_9' });
    assert.deepEqual(transcriptContextOf([...transcript.slice(0, 2), subagent]), { tokens: null, compacted: true },
      'a subagent call after the compaction does not count, so the compaction is what the transcript says');
  });
});
