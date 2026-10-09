import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRuntimeTrust, startQuietQuery, PROBE_DIR_NAME } from '../../src/engine/trust.mjs';
import { AsyncQueue } from '../../src/engine/queue.mjs';

const ROOT = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'caw-trust-'));
const STATE = path.join(ROOT, 'state');
fs.mkdirSync(STATE);
const FOLDER = path.join(ROOT, 'alpha');
fs.mkdirSync(FOLDER);
after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

/**
 * Scripted engine. `setCwd` is the runtime's answer (a value, or a function of the directory and options);
 * `hangInit` makes the handshake never answer.
 * @param {{setCwd?: unknown, hangInit?: boolean}} [script]
 */
function fakeEngine(script = {}) {
  const engine = {
    /** @type {any[]} */
    queries: [],
    /** @type {Error|null} */
    startError: null,
    query({ options }) {
      if (engine.startError) throw engine.startError;
      const messages = new AsyncQueue();
      /** @type {unknown[][]} */
      const calls = [];
      const query = {
        options,
        calls,
        messages,
        closed: false,
        [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](),
        close() {
          this.closed = true;
          messages.end();
        },
        initializationResult: async () => {
          calls.push(['initializationResult']);
          if (script.hangInit) await new Promise(() => {});
          return {};
        },
        setCwd: async (/** @type {string} */ dir, /** @type {unknown} */ opts) => {
          calls.push(opts === undefined ? ['setCwd', dir] : ['setCwd', dir, opts]);
          if (typeof script.setCwd === 'function') return script.setCwd(dir, opts);
          return script.setCwd ?? { status: 'ok', cwd: dir, changed: false };
        },
      };
      engine.queries.push(query);
      return query;
    },
  };
  return engine;
}

/**
 * @param {ReturnType<typeof fakeEngine>} engine
 * @param {{budgetMs?: number}} [options]
 */
function recorder(engine, options = {}) {
  /** @type {Array<{msg: string, fields: unknown}>} */
  const warnings = [];
  const trust = createRuntimeTrust({
    engine,
    config: { stateDir: STATE, claudeBin: null },
    log: {
      debug() {},
      info() {},
      warn: (msg, fields) => warnings.push({ msg, fields }),
      error() {},
    },
    env: () => ({ CLAUDE_AGENT_SDK_CLIENT_APP: 'test/1' }),
    budgetMs: options.budgetMs,
  });
  return { trust, warnings };
}

describe('runtime trust of a folder', () => {
  test('a folder the runtime already trusts is recorded as already, through a probe that runs no turn', async () => {
    const engine = fakeEngine();
    const { trust } = recorder(engine);
    assert.equal(await trust.record(FOLDER), 'already');
    assert.equal(engine.queries.length, 1);
    const [probe] = engine.queries;
    assert.equal(probe.closed, true);
    assert.equal(probe.options.persistSession, false);
    assert.deepEqual(probe.options.settingSources, []);
    assert.equal(probe.options.cwd, path.join(STATE, PROBE_DIR_NAME));
    assert.equal(probe.options.env.CLAUDE_AGENT_SDK_CLIENT_APP, 'test/1');
    assert.equal('pathToClaudeCodeExecutable' in probe.options, false);
    assert.deepEqual(probe.calls, [['initializationResult'], ['setCwd', FOLDER]]);
    await trust.close();
  });

  test('a folder the runtime asks to trust is accepted with the answer it names, and the answer is kept', async () => {
    const folder = path.join(ROOT, 'beta');
    fs.mkdirSync(folder);
    /** @type {(dir: string, opts?: {trustAccepted?: boolean}) => unknown} */
    const setCwd = (dir, opts) => (opts?.trustAccepted
      ? { status: 'ok', cwd: dir, changed: true }
      : { status: 'needs_trust', directory: dir });
    const engine = fakeEngine({ setCwd });
    const { trust } = recorder(engine);
    assert.equal(await trust.record(folder), 'accepted');
    assert.deepEqual(engine.queries[0].calls.slice(1), [
      ['setCwd', folder],
      ['setCwd', folder, { trustAccepted: true, trustedDirectory: folder }],
    ]);
    assert.equal(await trust.record(folder), 'accepted');
    assert.equal(engine.queries.length, 1);
    await trust.close();
  });

  test('a refused answer is failed and is not kept, so the next record asks again', async () => {
    const folder = path.join(ROOT, 'gamma');
    fs.mkdirSync(folder);
    let answer = { status: 'error' };
    const engine = fakeEngine({ setCwd: () => answer });
    const { trust } = recorder(engine);
    assert.equal(await trust.record(folder), 'failed');
    answer = { status: 'ok', cwd: folder, changed: false };
    assert.equal(await trust.record(folder), 'already');
    assert.equal(engine.queries.length, 2);
    assert.equal(await trust.record(folder), 'already');
    assert.equal(engine.queries.length, 2);
    await trust.close();
  });

  test('a trust request that comes without the folder, or with another status, is failed', async () => {
    const folder = path.join(ROOT, 'delta');
    fs.mkdirSync(folder);
    const withoutFolder = recorder(fakeEngine({ setCwd: { status: 'needs_trust' } })).trust;
    assert.equal(await withoutFolder.record(folder), 'failed');
    const unknown = recorder(fakeEngine({ setCwd: { status: 'weird' } })).trust;
    assert.equal(await unknown.record(folder), 'failed');
    await withoutFolder.close();
    await unknown.close();
  });

  test('a folder that does not exist is failed, and no probe starts for it', async () => {
    const engine = fakeEngine();
    const { trust } = recorder(engine);
    assert.equal(await trust.record(path.join(ROOT, 'missing')), 'failed');
    assert.equal(engine.queries.length, 0);
    await trust.close();
  });

  test('concurrent records of one folder share a single probe', async () => {
    const engine = fakeEngine();
    const { trust } = recorder(engine);
    const [first, second] = await Promise.all([trust.record(FOLDER), trust.record(FOLDER)]);
    assert.equal(first, 'already');
    assert.equal(second, 'already');
    assert.equal(engine.queries.length, 1);
    await trust.close();
  });

  test('a symbolic link is recorded under the folder it names', async () => {
    const real = path.join(ROOT, 'epsilon');
    fs.mkdirSync(real);
    const link = path.join(ROOT, 'epsilon-link');
    fs.symlinkSync(real, link, 'dir');
    const engine = fakeEngine();
    const { trust } = recorder(engine);
    assert.equal(await trust.record(link), 'already');
    assert.deepEqual(engine.queries[0].calls.at(-1), ['setCwd', real]);
    await trust.close();
  });

  test('a handshake that does not answer within the budget is failed, and its probe is closed', async () => {
    const engine = fakeEngine({ hangInit: true });
    const { trust, warnings } = recorder(engine, { budgetMs: 20 });
    const started = Date.now();
    assert.equal(await trust.record(FOLDER), 'failed');
    assert.ok(Date.now() - started < 2000);
    assert.equal(engine.queries[0].closed, true);
    assert.equal(warnings.length, 0);
    await trust.close();
  });

  test('a runtime that cannot start the probe is failed, and only the error name is logged', async () => {
    const engine = fakeEngine();
    engine.startError = new TypeError('spawn /internal/secret-path ENOENT');
    const { trust, warnings } = recorder(engine);
    assert.equal(await trust.record(FOLDER), 'failed');
    assert.equal(warnings.length, 1);
    assert.deepEqual(warnings[0].fields, { reason: 'TypeError' });
    assert.equal(JSON.stringify(warnings).includes('secret-path'), false);
    await trust.close();
  });

  test('close ends the probes in flight, and records after it are failed without a probe', async () => {
    const engine = fakeEngine({ hangInit: true });
    const { trust } = recorder(engine, { budgetMs: 60_000 });
    const pending = trust.record(FOLDER);
    for (let turns = 0; engine.queries.length === 0 && turns < 1000; turns += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(engine.queries.length, 1);
    await trust.close();
    assert.equal(await pending, 'failed');
    assert.equal(engine.queries[0].closed, true);
    assert.equal(await trust.record(path.join(ROOT, 'alpha')), 'failed');
    assert.equal(engine.queries.length, 1);
  });

  test('the probe folder is created inside the state folder with owner-only access', async () => {
    const engine = fakeEngine();
    const { trust } = recorder(engine);
    await trust.record(FOLDER);
    const mode = fs.statSync(path.join(STATE, PROBE_DIR_NAME)).mode & 0o777;
    assert.equal(mode & 0o077, 0);
    await trust.close();
  });
});

describe('quiet queries', () => {
  test('a quiet query discards its messages, and its close is safe to repeat', async () => {
    const engine = fakeEngine();
    const dir = path.join(ROOT, 'quiet');
    const quiet = await startQuietQuery({
      engine,
      dir,
      settingSources: ['user'],
      env: {},
      claudeBin: '/opt/claude/bin/claude',
    });
    assert.equal(engine.queries[0].options.pathToClaudeCodeExecutable, '/opt/claude/bin/claude');
    assert.deepEqual(engine.queries[0].options.settingSources, ['user']);
    engine.queries[0].messages.push({ type: 'system', subtype: 'init' });
    await new Promise((resolve) => setImmediate(resolve));
    let resolved = false;
    quiet.stopped.then(() => {
      resolved = true;
    });
    quiet.close();
    quiet.close();
    await quiet.stopped;
    assert.equal(resolved, true);
    assert.equal(engine.queries[0].closed, true);
    assert.equal(engine.queries[0].options.abortController.signal.aborted, true);
    assert.equal(fs.statSync(dir).isDirectory(), true);
  });
});
