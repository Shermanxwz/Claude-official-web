// Tests for the state the mock's queries share (src/engine/mock/runtime.mjs): the folder trust record, the account
// and a sign-in in progress. Persistent records live in a temporary directory that is removed afterwards.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeState, DEFAULT_ACCOUNT, LOGIN_CODE } from '../../src/engine/mock/runtime.mjs';

/**
 * A fresh directory, removed when the test ends.
 * @param {import('node:test').TestContext} t
 * @returns {string}
 */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'caw-mock-runtime-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The state of a sign-in URL's `state` parameter. */
function stateOf(url) {
  return new URL(url).searchParams.get('state');
}

describe('folder trust', () => {
  test('nothing is trusted at first; a trusted folder covers the folders under it, not its name prefixes', () => {
    const runtime = createRuntimeState();
    assert.equal(runtime.isTrusted('/work/app'), false);
    runtime.trust('/work/app');
    assert.equal(runtime.isTrusted('/work/app'), true);
    assert.equal(runtime.isTrusted('/work/app/src/deep'), true);
    assert.equal(runtime.isTrusted('/work'), false);
    assert.equal(runtime.isTrusted('/work/apple'), false);
  });

  test('trusting a folder twice keeps one record', () => {
    const runtime = createRuntimeState();
    runtime.trust('/work/app');
    runtime.trust('/work/app/');
    assert.equal(runtime.isTrusted('/work/app'), true);
  });

  test('with a directory the trust record persists across runtimes, and is written 0600 in a 0700 directory', (t) => {
    const dir = join(tempDir(t), 'mock-runtime');
    createRuntimeState({ dir }).trust('/work/app');
    assert.equal(createRuntimeState({ dir }).isTrusted('/work/app/src'), true);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, 'trust.json')).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir), ['trust.json'], 'no temporary file is left behind');
  });

  test('a corrupt or foreign trust record reads as untrusted, and a new trust replaces it', (t) => {
    const dir = join(tempDir(t), 'mock-runtime');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'trust.json'), '{ not json');
    const runtime = createRuntimeState({ dir });
    assert.equal(runtime.isTrusted('/work/app'), false);
    runtime.trust('/work/app');
    assert.equal(runtime.isTrusted('/work/app'), true);
    writeFileSync(join(dir, 'trust.json'), JSON.stringify({ trusted: ['relative/folder', 42, '/work/other'] }));
    assert.equal(runtime.isTrusted('relative/folder'), false, 'relative entries are ignored');
    assert.equal(runtime.isTrusted('/work/other/src'), true);
  });
});

describe('the account', () => {
  test('the mock starts signed in with the demo account', () => {
    const runtime = createRuntimeState();
    assert.deepEqual(runtime.account(), {
      email: 'demo@example.com',
      subscriptionType: 'pro',
      apiProvider: 'firstParty',
    });
    assert.deepEqual(runtime.account(), { ...DEFAULT_ACCOUNT });
  });

  test('an account returned is a copy: changing it does not change the runtime', () => {
    const runtime = createRuntimeState();
    runtime.account().email = 'changed@example.test';
    assert.equal(runtime.account().email, 'demo@example.com');
  });

  test('with a directory the account persists across runtimes', (t) => {
    const dir = join(tempDir(t), 'mock-runtime');
    const next = {
      email: 'next@example.test',
      organization: 'Next',
      subscriptionType: 'Claude API',
      apiProvider: 'firstParty',
    };
    createRuntimeState({ dir }).setAccount(next);
    assert.deepEqual(createRuntimeState({ dir }).account(), next);
    assert.equal(statSync(join(dir, 'account.json')).mode & 0o777, 0o600);
  });

  test('a corrupt account record reads as the demo account', (t) => {
    const dir = join(tempDir(t), 'mock-runtime');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'account.json'), JSON.stringify({ account: 'signed in' }));
    assert.deepEqual(createRuntimeState({ dir }).account(), { ...DEFAULT_ACCOUNT });
  });
});

describe('sign-in', () => {
  test('a claude.ai sign-in offers a manual and an automatic address with its state', () => {
    const runtime = createRuntimeState();
    const flow = runtime.startLogin('claudeai', {});
    assert.match(flow.manualUrl, /^https:\/\/claude\.ai\/oauth\/authorize\?code=true&state=/);
    assert.equal(flow.automaticUrl, `${flow.manualUrl}&redirect=localhost`);
    assert.equal(flow.method, 'claudeai');
    assert.ok(stateOf(flow.manualUrl));
  });

  test('a console sign-in uses the console address', () => {
    const flow = createRuntimeState().startLogin('console', {});
    assert.match(flow.manualUrl, /^https:\/\/console-login\.example\.test\/oauth\/authorize\?/);
  });

  test('a second start for the same method joins the sign-in in progress', () => {
    const runtime = createRuntimeState();
    const first = runtime.startLogin('claudeai', {});
    const second = runtime.startLogin('claudeai', {});
    assert.equal(second.manualUrl, first.manualUrl);
    assert.equal(runtime.signInInProgress().state, stateOf(first.manualUrl));
  });

  test('a start for the other method replaces the sign-in, and the waiter of the old one is rejected', async () => {
    const runtime = createRuntimeState();
    const old = runtime.startLogin('claudeai', {});
    const waiting = runtime.waitForLogin();
    const replacement = runtime.startLogin('console', {});
    await assert.rejects(waiting, /The sign-in was replaced by a new one\./);
    assert.notEqual(stateOf(replacement.manualUrl), stateOf(old.manualUrl));
    assert.equal(runtime.signInInProgress().method, 'console');
  });

  test('completing without a sign-in in progress is refused', () => {
    const runtime = createRuntimeState();
    assert.throws(() => runtime.completeLogin(LOGIN_CODE, 'any'), /No active claude_authenticate flow/);
    assert.throws(() => runtime.waitForLogin(), /No active claude_authenticate flow/);
  });

  test('a wrong state or a wrong code leaves the sign-in open for another try', () => {
    const runtime = createRuntimeState();
    const flow = runtime.startLogin('claudeai', {});
    const state = stateOf(flow.manualUrl);
    assert.throws(() => runtime.completeLogin(LOGIN_CODE, 'other-state'),
      /The sign-in state does not match this flow\./);
    assert.throws(() => runtime.completeLogin('wrong-code', state), /The authorization code was not accepted\./);
    assert.notEqual(runtime.signInInProgress(), null);
    assert.equal(runtime.completeLogin(LOGIN_CODE, state).account.email, 'demo@example.test');
  });

  test('a completed claude.ai sign-in signs the account in as a plan account, and ends the sign-in', async () => {
    const runtime = createRuntimeState();
    const flow = runtime.startLogin('claudeai', {});
    const waiting = runtime.waitForLogin();
    const result = runtime.completeLogin(LOGIN_CODE, stateOf(flow.manualUrl));
    assert.deepEqual(result, {
      account: {
        email: 'demo@example.test',
        organization: 'Demo',
        subscriptionType: 'pro',
        apiProvider: 'firstParty',
      },
    });
    assert.deepEqual(await waiting, result);
    assert.deepEqual(runtime.account(), result.account);
    assert.equal(runtime.signInInProgress(), null);
  });

  test('a completed console sign-in signs the account in as an API account', () => {
    const runtime = createRuntimeState();
    const flow = runtime.startLogin('console', {});
    assert.equal(runtime.completeLogin(LOGIN_CODE, stateOf(flow.manualUrl)).account.subscriptionType, 'Claude API');
  });

  test('a completed sign-in persists the account when the runtime has a directory', (t) => {
    const dir = join(tempDir(t), 'mock-runtime');
    const runtime = createRuntimeState({ dir });
    const flow = runtime.startLogin('claudeai', {});
    runtime.completeLogin(LOGIN_CODE, stateOf(flow.manualUrl));
    assert.equal(createRuntimeState({ dir }).account().email, 'demo@example.test');
    assert.equal(JSON.parse(readFileSync(join(dir, 'account.json'), 'utf8')).account.organization, 'Demo');
  });

  test('abandoning a sign-in belongs to its owner: another owner leaves it open', async () => {
    const runtime = createRuntimeState();
    const owner = {};
    runtime.startLogin('claudeai', owner);
    runtime.abandonLogin({});
    assert.notEqual(runtime.signInInProgress(), null);
    const waiting = runtime.waitForLogin();
    runtime.abandonLogin(owner);
    await assert.rejects(waiting, /The sign-in was abandoned\./);
    assert.equal(runtime.signInInProgress(), null);
  });
});
