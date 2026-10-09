import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAccount } from '../../src/engine/account.mjs';
import { AppError } from '../../src/contracts.mjs';
import { AsyncQueue } from '../../src/engine/queue.mjs';

const ROOT = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'caw-account-'));
after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

/**
 * Scripted engine: every query answers the account calls from `script` and records what it was asked. `omit` names
 * the methods the runtime does not offer.
 * @param {{accountInfo?: unknown, authenticate?: (login: boolean) => unknown,
 *   callback?: (code: string, state: string) => unknown, omit?: string[]}} [script]
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
        closed: false,
        [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](),
        close() {
          this.closed = true;
          calls.push(['close']);
          messages.end();
        },
        accountInfo: async () => {
          calls.push(['accountInfo']);
          return script.accountInfo === undefined ? { subscriptionType: 'Claude Max' } : script.accountInfo;
        },
        claudeAuthenticate: async (/** @type {boolean} */ login) => {
          calls.push(['claudeAuthenticate', login]);
          return script.authenticate
            ? script.authenticate(login)
            : { manualUrl: 'https://claude.ai/oauth/authorize?state=1', automaticUrl: null };
        },
        claudeOAuthCallback: async (/** @type {string} */ code, /** @type {string} */ state) => {
          calls.push(['claudeOAuthCallback', code, state]);
          return script.callback ? script.callback(code, state) : { account: { email: 'dev@example.com' } };
        },
      };
      for (const name of script.omit ?? []) delete query[name];
      engine.queries.push(query);
      return query;
    },
  };
  return engine;
}

/**
 * An account service wired to the scripted engine and recording publisher and sign-in hook.
 * @param {ReturnType<typeof fakeEngine>} engine
 * @param {{idleMs?: number, liveQuery?: () => unknown}} [options]
 */
function service(engine, options = {}) {
  /** @type {any[]} */
  const events = [];
  let signedIn = 0;
  const account = createAccount({
    engine,
    config: { stateDir: ROOT, claudeBin: null },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    publish: (/** @type {unknown} */ event) => events.push(event),
    env: () => ({ CLAUDE_AGENT_SDK_CLIENT_APP: 'test/1' }),
    liveQuery: options.liveQuery ?? (() => null),
    onSignedIn: () => {
      signedIn += 1;
    },
    idleMs: options.idleMs,
  });
  return { account, events, signedIn: () => signedIn };
}

/** @param {() => Promise<unknown>} fn @param {number} status @param {string} code */
async function expectError(fn, status, code) {
  await assert.rejects(fn, (error) => error instanceof AppError && error.status === status && error.code === code);
}

describe('account read', () => {
  test('starts the account query in its own folder with the user settings only, and reads the account', async () => {
    const engine = fakeEngine();
    const { account } = service(engine);
    const status = await account.status();
    assert.deepEqual(status, { account: { subscriptionType: 'Claude Max' }, signInPending: false });
    assert.equal(engine.queries.length, 1);
    const [query] = engine.queries;
    assert.equal(query.options.cwd, path.join(ROOT, 'account'));
    assert.equal(query.options.persistSession, false);
    assert.deepEqual(query.options.settingSources, ['user']);
    assert.equal(query.options.env.CLAUDE_AGENT_SDK_CLIENT_APP, 'test/1');
    assert.equal(fs.statSync(path.join(ROOT, 'account')).isDirectory(), true);
    await account.close();
  });

  test('an account with no field set is reported as no account', async () => {
    const engine = fakeEngine({ accountInfo: { email: null, organization: '' } });
    const { account } = service(engine);
    assert.deepEqual(await account.status(), { account: null, signInPending: false });
    await account.close();
  });

  test('a live session answers the read, and no account query is started for it', async () => {
    const engine = fakeEngine();
    const live = { accountInfo: async () => ({ email: 'live@example.com' }) };
    const { account } = service(engine, { liveQuery: () => live });
    assert.deepEqual(await account.status(), { account: { email: 'live@example.com' }, signInPending: false });
    assert.equal(engine.queries.length, 0);
    await account.close();
  });

  test('a failed read is a 502 without the engine text', async () => {
    const engine = fakeEngine({ accountInfo: undefined });
    const { account } = service(engine);
    await account.status();
    const [query] = engine.queries;
    query.accountInfo = async () => {
      throw new Error('internal /home/claude/.claude/.credentials.json');
    };
    await expectError(() => account.status(), 502, 'ENGINE_ERROR');
    await account.close();
  });

  test('a query that cannot start is a 503 that names the installation', async () => {
    const engine = fakeEngine();
    engine.startError = new Error('spawn claude ENOENT');
    const { account } = service(engine);
    await assert.rejects(account.status(), (error) => error instanceof AppError && error.status === 503
      && error.code === 'ENGINE_UNAVAILABLE' && !error.message.includes('ENOENT'));
  });
});

describe('account sign-in', () => {
  test('a sign-in asks the runtime for the address of the chosen method and reports the flow as pending', async () => {
    const engine = fakeEngine();
    const { account } = service(engine);
    await expectError(() => account.startLogin('gmail'), 400, 'BAD_REQUEST');
    const answer = await account.startLogin('claudeai');
    assert.deepEqual(answer, { manualUrl: 'https://claude.ai/oauth/authorize?state=1', automaticUrl: null });
    assert.deepEqual(engine.queries[0].calls.at(-1), ['claudeAuthenticate', true]);
    assert.equal((await account.status()).signInPending, true);
    await account.startLogin('console');
    assert.deepEqual(engine.queries.at(-1).calls.at(-1), ['claudeAuthenticate', false]);
    await account.cancelLogin();
    assert.equal((await account.status()).signInPending, false);
    await account.close();
  });

  test('a sign-in asked for again with the same method is joined on the same account query', async () => {
    const engine = fakeEngine();
    const { account } = service(engine);
    await account.startLogin('claudeai');
    await account.startLogin('claudeai');
    assert.equal(engine.queries.length, 1);
    assert.deepEqual(engine.queries[0].calls.filter((call) => call[0] === 'claudeAuthenticate'), [
      ['claudeAuthenticate', true],
      ['claudeAuthenticate', true],
    ]);
    assert.equal((await account.status()).signInPending, true);
    await account.close();
  });

  test('a sign-in address that is not https is a 502, and an automatic address is kept when it is https', async () => {
    const engine = fakeEngine({
      authenticate: () => ({ manualUrl: 'javascript:alert(1)', automaticUrl: null }),
    });
    const { account } = service(engine);
    await expectError(() => account.startLogin('claudeai'), 502, 'ENGINE_ERROR');
    await account.cancelLogin();
    await account.close();

    const withAutomatic = fakeEngine({
      authenticate: () => ({ manualUrl: 'https://claude.ai/a', automaticUrl: 'https://claude.ai/b' }),
    });
    const second = service(withAutomatic);
    assert.deepEqual(await second.account.startLogin('claudeai'), {
      manualUrl: 'https://claude.ai/a',
      automaticUrl: 'https://claude.ai/b',
    });
    await second.account.close();
  });

  test('a runtime without the sign-in control answers 501, and a policy refusal answers 403', async () => {
    const missing = fakeEngine({ omit: ['claudeAuthenticate'] });
    await expectError(() => service(missing).account.startLogin('claudeai'), 501, 'FEATURE_UNAVAILABLE');

    const blocked = fakeEngine({
      authenticate: () => {
        throw new Error('Login blocked: your organization does not allow this\n    at internal');
      },
    });
    await assert.rejects(service(blocked).account.startLogin('console'), (error) => error instanceof AppError
      && error.status === 403 && error.code === 'FORBIDDEN'
      && error.message === 'Login blocked: your organization does not allow this');

    const failing = fakeEngine({ authenticate: () => Promise.reject(new Error('socket hang up /internal')) });
    await assert.rejects(service(failing).account.startLogin('console'), (error) => error instanceof AppError
      && error.status === 502 && error.message === 'The sign-in could not be started.');
  });

  test('a new method replaces the sign-in in progress, and the old account query is closed', async () => {
    const engine = fakeEngine();
    const { account } = service(engine);
    await account.startLogin('claudeai');
    await account.startLogin('console');
    assert.equal(engine.queries.length, 2);
    assert.equal(engine.queries[0].closed, true);
    assert.equal(engine.queries[1].closed, false);
    await account.close();
  });

  test('completing with the code of the page signs in: the code is split, the account is published and the caches go',
    async () => {
      const engine = fakeEngine();
      const { account, events, signedIn } = service(engine);
      await account.startLogin('claudeai');
      const { account: signedAccount } = await account.completeLogin('  AUTHCODE#STATE  ');
      assert.deepEqual(signedAccount, { email: 'dev@example.com' });
      assert.deepEqual(engine.queries[0].calls.at(-2), ['claudeOAuthCallback', 'AUTHCODE', 'STATE']);
      assert.equal(engine.queries[0].closed, true);
      assert.equal(signedIn(), 1);
      assert.deepEqual(events, [{ type: 'account_changed', data: { account: { email: 'dev@example.com' } } }]);
      assert.equal((await account.status()).signInPending, false);
      await account.close();
    });

  test('a code without exactly two non-empty parts is a 422, and a code without a flow is a 409', async () => {
    const engine = fakeEngine();
    const { account } = service(engine);
    await expectError(() => account.completeLogin('no-separator'), 422, 'INVALID_ARGUMENT');
    await expectError(() => account.completeLogin('#state'), 422, 'INVALID_ARGUMENT');
    await expectError(() => account.completeLogin('a#b#c'), 422, 'INVALID_ARGUMENT');
    await expectError(() => account.completeLogin(`${'a'.repeat(2049)}#b`), 422, 'INVALID_ARGUMENT');
    await expectError(() => account.completeLogin(42), 422, 'INVALID_ARGUMENT');
    await expectError(() => account.completeLogin('code#state'), 409, 'CONFLICT');
    assert.equal(engine.queries.length, 0);
    await account.close();
  });

  test('a rejected code is a 502 that asks for a new sign-in, and an answer without an account is refused too',
    async () => {
      const engine = fakeEngine({ callback: () => Promise.reject(new Error('invalid_grant /internal')) });
      const { account, events, signedIn } = service(engine);
      await account.startLogin('claudeai');
      await assert.rejects(account.completeLogin('code#state'), (error) => error instanceof AppError
        && error.status === 502 && error.message === 'The sign-in could not be completed. Start the sign-in again.');
      assert.equal(signedIn(), 0);
      assert.deepEqual(events, []);

      const empty = fakeEngine({ callback: () => ({ account: null }) });
      const second = service(empty);
      await second.account.startLogin('claudeai');
      await expectError(() => second.account.completeLogin('code#state'), 502, 'ENGINE_ERROR');
      await second.account.close();
      await account.close();
    });

  test('a runtime without the completion control is a 501', async () => {
    const engine = fakeEngine({ omit: ['claudeOAuthCallback'] });
    const { account } = service(engine);
    await account.startLogin('claudeai');
    await expectError(() => account.completeLogin('code#state'), 501, 'FEATURE_UNAVAILABLE');
    await account.close();
  });
});

describe('account query lifetime', () => {
  test('the account query closes after it has been idle for the idle time', async () => {
    const engine = fakeEngine();
    const { account } = service(engine, { idleMs: 10 });
    await account.status();
    assert.equal(engine.queries[0].closed, false);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(engine.queries[0].closed, true);
    await account.close();
  });

  test('each use restarts the idle time, so a busy account query stays open', async () => {
    const engine = fakeEngine();
    const { account } = service(engine, { idleMs: 40 });
    await account.status();
    for (let i = 0; i < 4; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      await account.status();
    }
    assert.equal(engine.queries[0].closed, false);
    await account.close();
  });

  test('after close, every call answers 503 and the query is closed', async () => {
    const engine = fakeEngine();
    const { account } = service(engine);
    await account.status();
    await account.close();
    assert.equal(engine.queries[0].closed, true);
    await expectError(() => account.status(), 503, 'ENGINE_UNAVAILABLE');
    await expectError(() => account.startLogin('claudeai'), 503, 'ENGINE_UNAVAILABLE');
    assert.equal(engine.queries.length, 1);
  });
});
