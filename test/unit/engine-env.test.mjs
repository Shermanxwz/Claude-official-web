import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { engineEnv } from '../../src/engine/env.mjs';

const CLIENT_APP = 'claude-official-web/1.0.0';

describe('engineEnv', () => {
  test('removes every CAW_ variable and keeps the other strings', () => {
    const env = engineEnv(
      {
        CAW_TOKEN: 'secret-token',
        CAW_REQUIRE_AUTH: '1',
        CAW_ALLOW_BYPASS: '1',
        HOME: '/home/claude',
        PATH: '/usr/bin',
        ANTHROPIC_API_KEY: 'sk-test',
        CLAUDE_CONFIG_DIR: '/home/claude/.claude',
      },
      { clientApp: CLIENT_APP },
    );
    assert.equal(env.CAW_TOKEN, undefined);
    assert.equal(env.CAW_REQUIRE_AUTH, undefined);
    assert.equal(env.CAW_ALLOW_BYPASS, undefined);
    assert.equal(env.HOME, '/home/claude');
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.ANTHROPIC_API_KEY, 'sk-test');
    assert.equal(env.CLAUDE_CONFIG_DIR, '/home/claude/.claude');
  });

  test('adds the client app name and replaces an inherited value', () => {
    const inherited = engineEnv({ CLAUDE_AGENT_SDK_CLIENT_APP: 'someone-else/9.9.9' }, { clientApp: CLIENT_APP });
    assert.equal(inherited.CLAUDE_AGENT_SDK_CLIENT_APP, CLIENT_APP);
    const fresh = engineEnv({ HOME: '/h' }, { clientApp: CLIENT_APP });
    assert.equal(fresh.CLAUDE_AGENT_SDK_CLIENT_APP, CLIENT_APP);
  });

  test('strips only names that start with the exact CAW_ prefix', () => {
    const env = engineEnv(
      { CAWX: 'kept', XCAW_Y: 'kept', caw_lower: 'kept', CAW: 'kept', CAW_: 'dropped', 'CAW_NESTED_CAW_X': 'dropped' },
      { clientApp: CLIENT_APP },
    );
    assert.equal(env.CAWX, 'kept');
    assert.equal(env.XCAW_Y, 'kept');
    assert.equal(env.caw_lower, 'kept');
    assert.equal(env.CAW, 'kept');
    assert.equal(env.CAW_, undefined);
    assert.equal(env.CAW_NESTED_CAW_X, undefined);
  });

  test('drops values that are not strings', () => {
    const env = engineEnv({ DEFINED: 'yes', MISSING: undefined }, { clientApp: CLIENT_APP });
    assert.equal(env.DEFINED, 'yes');
    assert.equal('MISSING' in env, false);
  });

  test('returns a new object and never mutates the source', () => {
    const source = { CAW_TOKEN: 'x', HOME: '/h' };
    const before = { ...source };
    const env = engineEnv(source, { clientApp: CLIENT_APP });
    assert.notEqual(env, source);
    assert.deepEqual(source, before);
    env.HOME = '/changed';
    assert.equal(source.HOME, '/h');
  });

  test('defaults to process.env and still strips CAW_ variables from it', () => {
    const env = engineEnv(undefined, { clientApp: CLIENT_APP });
    assert.equal(env.CLAUDE_AGENT_SDK_CLIENT_APP, CLIENT_APP);
    for (const name of Object.keys(env)) {
      assert.equal(name.startsWith('CAW_'), false, `unexpected gateway variable ${name}`);
    }
  });
});
