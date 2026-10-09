// @ts-check
/**
 * Single-consumer async queue. The producer pushes items synchronously; the consumer iterates with `for await`.
 *
 * - `end()` lets buffered items drain, then completes iteration.
 * - `fail(error)` discards buffered items and rejects the consumer's read with `error` exactly once.
 * - `return()` from the consumer (break, throw, explicit close) stops the queue and discards buffered items; later
 *   pushes are refused just as after `end()`.
 * @template T
 */
export class AsyncQueue {
  /** @type {T[]} */
  #items = [];
  /** @type {Array<{resolve: (r: IteratorResult<T>) => void, reject: (e: unknown) => void}>} */
  #waiters = [];
  #ended = false;
  /** @type {{error: unknown}|null} */
  #pendingError = null;

  /** @param {T} item */
  push(item) {
    if (this.#ended) throw new Error('AsyncQueue: push after end');
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ value: item, done: false });
    else this.#items.push(item);
  }

  end() {
    if (this.#ended) return;
    this.#ended = true;
    this.#releaseWaiters();
  }

  /** @param {unknown} error */
  fail(error) {
    if (this.#ended) return;
    this.#ended = true;
    this.#items = [];
    const waiter = this.#waiters.shift();
    if (waiter) {
      this.#releaseWaiters();
      waiter.reject(error);
      return;
    }
    this.#pendingError = { error };
  }

  get ended() {
    return this.#ended;
  }

  get size() {
    return this.#items.length;
  }

  /** @returns {AsyncIterator<T>} */
  [Symbol.asyncIterator]() {
    return {
      next: () => this.#next(),
      return: () => {
        this.#items = [];
        this.#pendingError = null;
        this.#ended = true;
        this.#releaseWaiters();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }

  /** @returns {Promise<IteratorResult<T>>} */
  #next() {
    if (this.#items.length > 0) {
      const value = /** @type {T} */ (this.#items.shift());
      return Promise.resolve({ value, done: false });
    }
    if (this.#pendingError) {
      const { error } = this.#pendingError;
      this.#pendingError = null;
      return Promise.reject(error);
    }
    if (this.#ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }

  #releaseWaiters() {
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }
}
