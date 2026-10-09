// Tests for the plain-data answers of the mock's runtime controls (src/engine/mock/answers.mjs). Every function here is
// pure, so the tests need no state directory.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  builtInServers,
  dialogResultOf,
  dynamicServerOf,
  hasPlanLimitsOf,
  LOCAL_CALLBACK_PORT,
  loginMethodOf,
  mcpAuthorizationOf,
  parseAddress,
  redirectOf,
  serverEntry,
  serverStatusOf,
  sideAnswerOf,
  startModeOf,
  TASK_OUTPUT_LIMIT,
  taskOutputOf,
} from '../../src/engine/mock/answers.mjs';

const FAILED_FILESYSTEM = { status: 'failed', error: 'spawn npx ENOENT' };

describe('built-in MCP servers', () => {
  test('github connects, filesystem fails to start, and mock-oauth waits for a sign-in', () => {
    const servers = builtInServers();
    assert.deepEqual([...servers.keys()], ['github', 'filesystem', 'mock-oauth']);
    assert.deepEqual(serverStatusOf(servers.get('github')), { status: 'connected' });
    assert.deepEqual(serverStatusOf(servers.get('filesystem')), FAILED_FILESYSTEM);
    assert.deepEqual(serverStatusOf(servers.get('mock-oauth')), { status: 'needs-auth' });
    assert.equal(servers.get('github').transport, 'http');
    assert.equal(servers.get('filesystem').transport, 'stdio');
    assert.equal(servers.get('mock-oauth').oauth, true);
    assert.deepEqual(servers.get('github').tools.map((tool) => tool.name), ['search_issues']);
  });

  test('each call returns entries of its own, so a change to one call does not reach the next', () => {
    const first = builtInServers();
    first.get('github').enabled = false;
    assert.equal(serverStatusOf(builtInServers().get('github')).status, 'connected');
  });
});

describe('serverStatusOf', () => {
  test('a disabled server reports disabled whatever else it is', () => {
    assert.deepEqual(serverStatusOf(serverEntry({ enabled: false, reachable: false })), { status: 'disabled' });
    assert.deepEqual(serverStatusOf(serverEntry({ enabled: false, oauth: true, authorized: true })), {
      status: 'disabled',
    });
  });

  test('a sign-in that has not completed comes before reachability', () => {
    assert.deepEqual(serverStatusOf(serverEntry({ oauth: true })), { status: 'needs-auth' });
    assert.deepEqual(serverStatusOf(serverEntry({ oauth: true, reachable: false })), { status: 'needs-auth' });
  });

  test('a reachable server connects once it has any sign-in it needs', () => {
    assert.deepEqual(serverStatusOf(serverEntry({ oauth: true, authorized: true })), { status: 'connected' });
    assert.deepEqual(serverStatusOf(serverEntry({})), { status: 'connected' });
    assert.deepEqual(serverStatusOf(serverEntry({ reachable: false })), FAILED_FILESYSTEM);
    const unreachable = serverEntry({ oauth: true, authorized: true, reachable: false });
    assert.deepEqual(serverStatusOf(unreachable), FAILED_FILESYSTEM);
  });
});

describe('dynamicServerOf', () => {
  test('the transport comes from the config; a config without one is stdio', () => {
    assert.equal(dynamicServerOf('docs', { type: 'http', url: 'http://localhost:9' }).transport, 'http');
    assert.equal(dynamicServerOf('docs', { command: 'node' }).transport, 'stdio');
    assert.equal(dynamicServerOf('docs', null).transport, 'stdio');
    assert.equal(dynamicServerOf('docs', { type: 7 }).transport, 'stdio');
  });

  test('a dynamic server is marked dynamic and connects without tools unless it is the browser server', () => {
    const docs = dynamicServerOf('docs', { command: 'node' });
    assert.equal(docs.dynamic, true);
    assert.deepEqual(docs.tools, []);
    assert.deepEqual(serverStatusOf(docs), { status: 'connected' });
    const browser = dynamicServerOf('browser', { command: 'node' });
    assert.deepEqual(browser.tools.map((tool) => tool.name), ['browser_navigate', 'browser_take_screenshot']);
    assert.equal(browser.tools.find((tool) => tool.name === 'browser_take_screenshot').readOnly, true);
    assert.equal(browser.tools.find((tool) => tool.name === 'browser_navigate').readOnly, false);
  });
});

describe('startModeOf', () => {
  test('a mode passed as an option wins over the settings', () => {
    assert.equal(startModeOf('acceptEdits', { permissions: { defaultMode: 'plan' } }), 'acceptEdits');
  });

  test('a null option counts as not passed, so the settings decide', () => {
    assert.equal(startModeOf(null, { permissions: { defaultMode: 'plan' } }), 'plan');
    assert.equal(startModeOf(undefined, { permissions: { defaultMode: 'dontAsk' } }), 'dontAsk');
  });

  test('without an option or a known settings default the mode is default', () => {
    assert.equal(startModeOf(undefined, {}), 'default');
    assert.equal(startModeOf(undefined, { permissions: { defaultMode: 'turbo' } }), 'default');
    assert.equal(startModeOf(undefined, { permissions: 'plan' }), 'default');
    assert.equal(startModeOf(undefined, { permissions: null }), 'default');
  });
});

describe('taskOutputOf', () => {
  test('output that fits is kept whole, with its size', () => {
    assert.deepEqual(taskOutputOf('Build succeeded\n'), {
      output: 'Build succeeded\n',
      total_bytes: 16,
      truncated: false,
    });
    assert.deepEqual(taskOutputOf(''), { output: '', total_bytes: 0, truncated: false });
  });

  test('output longer than the limit keeps its end, and says that its start was cut off', () => {
    const text = `start-${'x'.repeat(TASK_OUTPUT_LIMIT)}end`;
    const answer = taskOutputOf(text);
    assert.equal(TASK_OUTPUT_LIMIT, 8192);
    assert.equal(answer.truncated, true);
    assert.equal(answer.total_bytes, Buffer.byteLength(text));
    assert.equal(answer.output.length, TASK_OUTPUT_LIMIT);
    assert.ok(answer.output.endsWith('end'));
    assert.ok(!answer.output.includes('start-'));
  });

  test('output exactly at the limit is not truncated', () => {
    const answer = taskOutputOf('y'.repeat(TASK_OUTPUT_LIMIT));
    assert.equal(answer.truncated, false);
    assert.equal(answer.output.length, TASK_OUTPUT_LIMIT);
  });
});

describe('sideAnswerOf', () => {
  test('an ordinary question is answered with its text, trimmed, and is not synthetic', () => {
    assert.deepEqual(sideAnswerOf('  What is the plan?  '), {
      response: 'Side answer: What is the plan?',
      synthetic: false,
    });
  });

  test('a question that mentions a refusal is answered through the fallback model', () => {
    const answer = sideAnswerOf('Why the refusal?');
    assert.equal(answer.refusalFallback.originalModel, 'claude-opus-mock');
    assert.equal(answer.refusalFallback.fallbackModel, 'claude-sonnet-mock');
    assert.equal(answer.refusalFallback.content, answer.response);
    assert.equal('refusalFallback' in sideAnswerOf('What is the plan?'), false);
  });

  test('the answer keeps at most 200 characters of the question', () => {
    const answer = sideAnswerOf('q'.repeat(500));
    assert.equal(answer.response, `Side answer: ${'q'.repeat(200)}`);
  });
});

describe('dialogResultOf', () => {
  test('a completed answer with a known result is that result', () => {
    assert.equal(dialogResultOf({ behavior: 'completed', result: 'retry_fallback' }), 'retry_fallback');
    assert.equal(dialogResultOf({ behavior: 'completed', result: 'edit_prompt' }), 'edit_prompt');
    assert.equal(dialogResultOf({ behavior: 'completed', result: 'cancelled' }), 'cancelled');
  });

  test('anything else leaves the refusal in place as cancelled', () => {
    assert.equal(dialogResultOf({ behavior: 'cancelled' }), 'cancelled');
    assert.equal(dialogResultOf({ behavior: 'completed', result: 'retry' }), 'cancelled');
    assert.equal(dialogResultOf({ behavior: 'completed' }), 'cancelled');
    assert.equal(dialogResultOf(['completed']), 'cancelled');
    assert.equal(dialogResultOf(null), 'cancelled');
    assert.equal(dialogResultOf(undefined), 'cancelled');
  });
});

describe('parseAddress', () => {
  test('an absolute URL parses; anything else is refused with a message', () => {
    assert.equal(parseAddress('https://example.test/cb?code=1').hostname, 'example.test');
    assert.throws(() => parseAddress('/relative/path'), {
      name: 'TypeError',
      message: 'The address must be an absolute URL.',
    });
    assert.throws(() => parseAddress(''), TypeError);
  });
});

describe('redirectOf', () => {
  test('no redirect address means the runtime callback on its own port', () => {
    assert.deepEqual(redirectOf(undefined), { redirectScheme: 'localhost', callbackPort: LOCAL_CALLBACK_PORT });
    assert.equal(LOCAL_CALLBACK_PORT, 53682);
  });

  test('a localhost address keeps its port; without one it uses the callback port', () => {
    assert.deepEqual(redirectOf('http://localhost:4000/cb'), { redirectScheme: 'localhost', callbackPort: 4000 });
    assert.deepEqual(redirectOf('http://127.0.0.1/cb'), {
      redirectScheme: 'localhost',
      callbackPort: LOCAL_CALLBACK_PORT,
    });
  });

  test('any other address is a custom scheme, including https on localhost', () => {
    assert.deepEqual(redirectOf('myapp://callback'), { redirectScheme: 'custom' });
    assert.deepEqual(redirectOf('https://localhost/cb'), { redirectScheme: 'custom' });
  });
});

describe('mcpAuthorizationOf', () => {
  test('the answer names the authorize address with the server and the state, and expects a callback', () => {
    const answer = mcpAuthorizationOf({ serverName: 'mock oauth', state: 'abc', redirectUri: undefined });
    const url = new URL(answer.authUrl);
    assert.equal(url.origin, 'https://mcp-auth.example.test');
    assert.equal(url.pathname, '/authorize');
    assert.equal(url.searchParams.get('server'), 'mock oauth');
    assert.equal(url.searchParams.get('state'), 'abc');
    assert.equal(answer.requiresUserAction, true);
    assert.equal(answer.callbackExpected, true);
    assert.equal(answer.state, 'abc');
    assert.equal(answer.redirectScheme, 'localhost');
    assert.equal(answer.callbackPort, LOCAL_CALLBACK_PORT);
  });

  test('a custom redirect address is returned as a custom scheme without a port', () => {
    const answer = mcpAuthorizationOf({ serverName: 'docs', state: 's', redirectUri: 'myapp://cb' });
    assert.equal(answer.redirectScheme, 'custom');
    assert.equal('callbackPort' in answer, false);
  });
});

describe('account answers', () => {
  test('a plan account has plan limits and a claude.ai login; an API account has neither', () => {
    assert.equal(hasPlanLimitsOf({ subscriptionType: 'pro' }), true);
    assert.equal(hasPlanLimitsOf({ subscriptionType: 'Claude API' }), false);
    assert.equal(hasPlanLimitsOf({ subscriptionType: null }), false);
    assert.equal(hasPlanLimitsOf({}), false);
    assert.equal(loginMethodOf({ subscriptionType: 'pro' }), 'claude.ai account');
    assert.equal(loginMethodOf({ subscriptionType: 'Claude API' }), 'Claude API account');
  });
});
