import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncQueue } from '../../src/engine/queue.mjs';

/** Resolves after pending microtasks and one macrotask, so consumers reach their waits. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('AsyncQueue', () => {
  test('yields pushed items in order', async () => {
    const queue = new AsyncQueue();
    queue.push('a');
    queue.push('b');
    queue.push('c');
    queue.end();
    const seen = [];
    for await (const item of queue) seen.push(item);
    assert.deepEqual(seen, ['a', 'b', 'c']);
  });

  test('waits when empty and resumes on the next push', async () => {
    const queue = new AsyncQueue();
    const iterator = queue[Symbol.asyncIterator]();
    let settled = false;
    const pending = iterator.next().then((result) => {
      settled = true;
      return result;
    });
    await tick();
    assert.equal(settled, false);
    queue.push(42);
    assert.deepEqual(await pending, { value: 42, done: false });
  });

  test('completes after end() once buffered items are drained', async () => {
    const queue = new AsyncQueue();
    queue.push(1);
    queue.end();
    assert.equal(queue.ended, true);
    const iterator = queue[Symbol.asyncIterator]();
    assert.deepEqual(await iterator.next(), { value: 1, done: false });
    assert.deepEqual(await iterator.next(), { value: undefined, done: true });
    assert.deepEqual(await iterator.next(), { value: undefined, done: true });
  });

  test('end() releases a waiting consumer as done', async () => {
    const queue = new AsyncQueue();
    const iterator = queue[Symbol.asyncIterator]();
    const pending = iterator.next();
    await tick();
    queue.end();
    assert.deepEqual(await pending, { value: undefined, done: true });
  });

  test('push after end throws and end is idempotent', () => {
    const queue = new AsyncQueue();
    queue.end();
    queue.end();
    assert.throws(() => queue.push('late'), /push after end/);
  });

  test('size reports the number of buffered items', () => {
    const queue = new AsyncQueue();
    assert.equal(queue.size, 0);
    queue.push('x');
    queue.push('y');
    assert.equal(queue.size, 2);
  });

  test('fail() rejects a waiting consumer and then completes', async () => {
    const queue = new AsyncQueue();
    const iterator = queue[Symbol.asyncIterator]();
    const pending = iterator.next();
    await tick();
    const boom = new Error('boom');
    queue.fail(boom);
    await assert.rejects(pending, (error) => error === boom);
    assert.deepEqual(await iterator.next(), { value: undefined, done: true });
  });

  test('fail() discards buffered items and rejects the next read once', async () => {
    const queue = new AsyncQueue();
    queue.push('lost');
    const boom = new Error('broken pipe');
    queue.fail(boom);
    assert.equal(queue.size, 0);
    assert.equal(queue.ended, true);
    const iterator = queue[Symbol.asyncIterator]();
    await assert.rejects(iterator.next(), (error) => error === boom);
    assert.deepEqual(await iterator.next(), { value: undefined, done: true });
  });

  test('for await propagates a failure after the buffered items were read', async () => {
    const queue = new AsyncQueue();
    queue.push('first');
    const seen = [];
    const consumer = (async () => {
      for await (const item of queue) seen.push(item);
    })();
    await tick();
    queue.fail(new Error('engine stopped'));
    await assert.rejects(consumer, /engine stopped/);
    assert.deepEqual(seen, ['first']);
  });

  test('fail() and end() after completion are ignored', async () => {
    const queue = new AsyncQueue();
    queue.end();
    queue.fail(new Error('too late'));
    const iterator = queue[Symbol.asyncIterator]();
    assert.deepEqual(await iterator.next(), { value: undefined, done: true });
  });

  test('return() from the consumer stops the queue and discards buffered items', async () => {
    const queue = new AsyncQueue();
    queue.push(1);
    queue.push(2);
    queue.push(3);
    for await (const item of queue) {
      assert.equal(item, 1);
      break;
    }
    assert.equal(queue.size, 0);
    assert.equal(queue.ended, true);
    assert.throws(() => queue.push(4), /push after end/);
  });

  test('return() releases a pending read as done', async () => {
    const queue = new AsyncQueue();
    const iterator = queue[Symbol.asyncIterator]();
    const pending = iterator.next();
    await tick();
    assert.deepEqual(await iterator.return(), { value: undefined, done: true });
    assert.deepEqual(await pending, { value: undefined, done: true });
  });

  test('delivers items pushed from another task in order', async () => {
    const queue = new AsyncQueue();
    const producer = (async () => {
      for (let i = 0; i < 50; i += 1) {
        queue.push(i);
        if (i % 7 === 0) await tick();
      }
      queue.end();
    })();
    const seen = [];
    for await (const item of queue) seen.push(item);
    await producer;
    assert.deepEqual(seen, Array.from({ length: 50 }, (_, i) => i));
  });
});
