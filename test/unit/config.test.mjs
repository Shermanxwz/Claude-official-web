// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BYPASS_ROOT_MESSAGE } from '../../src/contracts.mjs';
import { ConfigError, loadConfig } from '../../src/config.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOKEN = 'token-with-16-plus';

let root = '';
let dirA = '';
let dirB = '';
let aFile = '';

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'caw-config-'));
  dirA = path.join(root, 'workspace-a');
  dirB = path.join(root, 'workspace-b');
  fs.mkdirSync(dirA);
  fs.mkdirSync(dirB);
  aFile = path.join(root, 'plain.txt');
  fs.writeFileSync(aFile, 'not a directory');
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * Environment that is valid by default. HOME and the state directory point into the temporary tree. IS_SANDBOX=1 keeps
 * the root guard (bypass refused as root outside a sandbox) out of the tests that are not about it: the guard's own
 * tests inject the user id and the environment they need.
 * @param {Record<string, string>} [extra]
 * @returns {Record<string, string>}
 */
function env(extra = {}) {
  return { HOME: root, CAW_TOKEN: TOKEN, CAW_STATE_DIR: path.join(root, 'state'), IS_SANDBOX: '1', ...extra };
}

/**
 * @param {Record<string, string>} extra
 * @param {string} variable
 */
function assertInvalid(extra, variable) {
  assert.throws(() => loadConfig(env(extra)), (error) => {
    assert.ok(error instanceof ConfigError, `expected ConfigError, got ${error?.name}`);
    assert.ok(error.message.includes(variable), `message should name ${variable}: ${error.message}`);
    return true;
  });
}

describe('loadConfig defaults', () => {
  it('resolves every default from a minimal environment', () => {
    const config = loadConfig(env(), { packageVersion: '9.9.9' });
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.port, 4180);
    assert.equal(config.requireAuth, true);
    assert.equal(config.token, TOKEN);
    assert.equal(config.publicOrigin, '');
    assert.equal(config.profile, 'full');
    assert.equal(config.appName, 'Agent Web');
    assert.equal(config.version, '9.9.9');
    assert.deepEqual(config.roots, [fs.realpathSync(root)]);
    assert.equal(config.stateDir, path.join(root, 'state'));
    assert.equal(config.engine, 'sdk');
    assert.equal(config.claudeBin, null);
    // Without CAW_DEFAULT_PERMISSION_MODE the runtime's settings decide the mode of a new session.
    assert.deepEqual(config.defaults, { model: null, permissionMode: null, effort: null, fallbackModel: null });
    assert.equal(config.chrome, false);
    assert.equal(config.browserMcpCommand, null);
    assert.equal(config.terminal, false);
    assert.equal(config.allowBypass, false);
    assert.equal(config.idleTimeoutMs, 1800000);
    assert.equal(config.maxLiveSessions, 4);
    assert.equal(config.uploadMaxBytes, 26214400);
    assert.equal(config.imageMaxBytes, 5242880);
    assert.equal(config.uploadRetentionDays, 7);
    assert.equal(config.sessionTtlMs, 168 * 3600000);
    assert.equal(config.trustProxy, false);
    assert.equal(config.logLevel, 'info');
  });

  it('reads the package version from package.json when no version is passed', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    assert.equal(loadConfig(env()).version, manifest.version);
  });

  it('does not create or write anything', () => {
    const stateDir = path.join(root, 'never-created');
    loadConfig(env({ CAW_STATE_DIR: stateDir }));
    assert.equal(fs.existsSync(stateDir), false);
  });

  it('returns a frozen configuration object', () => {
    const config = loadConfig(env());
    assert.equal(Object.isFrozen(config), true);
    assert.equal(Object.isFrozen(config.defaults), true);
  });

  it('treats blank variables as unset', () => {
    const config = loadConfig(env({ CAW_PORT: '  ', CAW_APP_NAME: '', CAW_DEFAULT_MODEL: ' ' }));
    assert.equal(config.port, 4180);
    assert.equal(config.appName, 'Agent Web');
    assert.equal(config.defaults.model, null);
  });

  it('derives the state directory from XDG_STATE_HOME when it is absolute, else from HOME', () => {
    const xdg = path.join(root, 'xdg-state');
    assert.equal(loadConfig(env({ CAW_STATE_DIR: '', XDG_STATE_HOME: xdg })).stateDir,
      path.join(xdg, 'claude-official-web'));
    assert.equal(loadConfig(env({ CAW_STATE_DIR: '', XDG_STATE_HOME: 'relative/state' })).stateDir,
      path.join(root, '.local', 'state', 'claude-official-web'));
  });
});

describe('loadConfig validation', () => {
  it('accepts the port range boundaries and rejects values outside it', () => {
    assert.equal(loadConfig(env({ CAW_PORT: '1' })).port, 1);
    assert.equal(loadConfig(env({ CAW_PORT: '65535' })).port, 65535);
    for (const value of ['0', '65536', 'abc', '1.5', '-1', '1e3', '12x']) {
      assertInvalid({ CAW_PORT: value }, 'CAW_PORT');
    }
  });

  it('parses boolean flags and rejects anything else', () => {
    assert.equal(loadConfig(env({ CAW_REQUIRE_AUTH: '0', CAW_HOST: '127.0.0.1' })).requireAuth, false);
    assert.equal(loadConfig(env({ CAW_REQUIRE_AUTH: 'false' })).requireAuth, false);
    assert.equal(loadConfig(env({ CAW_REQUIRE_AUTH: 'TRUE' })).requireAuth, true);
    assert.equal(loadConfig(env({ CAW_TERMINAL: '1' })).terminal, true);
    assert.equal(loadConfig(env({ CAW_TRUST_PROXY: 'true' })).trustProxy, true);
    assertInvalid({ CAW_REQUIRE_AUTH: 'yes' }, 'CAW_REQUIRE_AUTH');
    assertInvalid({ CAW_TERMINAL: 'on' }, 'CAW_TERMINAL');
    assertInvalid({ CAW_ALLOW_BYPASS: '2' }, 'CAW_ALLOW_BYPASS');
    assertInvalid({ CAW_TRUST_PROXY: 'no' }, 'CAW_TRUST_PROXY');
  });

  it('rejects a host that contains characters outside host syntax', () => {
    assertInvalid({ CAW_HOST: 'bad host' }, 'CAW_HOST');
    assertInvalid({ CAW_HOST: 'example.com/path' }, 'CAW_HOST');
    assert.equal(loadConfig(env({ CAW_HOST: '[::1]' })).host, '[::1]');
  });

  it('requires a token of 16 to 1024 characters when auth is on', () => {
    assertInvalid({ CAW_TOKEN: '' }, 'CAW_TOKEN');
    assertInvalid({ CAW_TOKEN: 'x'.repeat(15) }, 'CAW_TOKEN');
    assertInvalid({ CAW_TOKEN: 'x'.repeat(1025) }, 'CAW_TOKEN');
    assert.equal(loadConfig(env({ CAW_TOKEN: 'x'.repeat(16) })).token.length, 16);
    assert.equal(loadConfig(env({ CAW_TOKEN: 'x'.repeat(1024) })).token.length, 1024);
  });

  it('still validates a provided token length when auth is off', () => {
    assert.equal(loadConfig(env({ CAW_REQUIRE_AUTH: '0', CAW_TOKEN: '' })).token, '');
    assertInvalid({ CAW_REQUIRE_AUTH: '0', CAW_TOKEN: 'short' }, 'CAW_TOKEN');
  });

  it('accepts CAW_TOKEN_SHA256 as the only credential and normalizes it to lowercase hex', () => {
    const config = loadConfig(env({ CAW_TOKEN: '', CAW_TOKEN_SHA256: 'AB'.repeat(32) }));
    assert.equal(config.token, '');
    assert.equal(config.tokenSha256, 'ab'.repeat(32));
    assert.equal(loadConfig(env()).tokenSha256, '');
    assert.equal(loadConfig(env({ CAW_REQUIRE_AUTH: '0', CAW_TOKEN: '', CAW_TOKEN_SHA256: '' })).tokenSha256, '');
  });

  it('requires exactly one of CAW_TOKEN and CAW_TOKEN_SHA256 when auth is on', () => {
    assertInvalid({ CAW_TOKEN: '' }, 'CAW_TOKEN');
    assert.throws(() => loadConfig(env({ CAW_TOKEN_SHA256: 'a'.repeat(64) })), (error) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /not both/);
      return true;
    });
    for (const digest of ['a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), `${'a'.repeat(63)} `]) {
      assertInvalid({ CAW_TOKEN: '', CAW_TOKEN_SHA256: digest }, 'CAW_TOKEN_SHA256');
    }
    assert.throws(() => loadConfig(env({ CAW_REQUIRE_AUTH: '0', CAW_TOKEN_SHA256: 'a'.repeat(64) })), ConfigError);
  });

  it('allows disabling auth only on loopback hosts', () => {
    for (const host of ['127.0.0.1', '::1', 'localhost', '[::1]']) {
      assert.equal(loadConfig(env({ CAW_REQUIRE_AUTH: '0', CAW_HOST: host })).requireAuth, false, host);
    }
    for (const host of ['0.0.0.0', '192.168.1.10', '::']) {
      assert.throws(() => loadConfig(env({ CAW_REQUIRE_AUTH: '0', CAW_HOST: host })), ConfigError, host);
    }
    assert.throws(() => loadConfig(env({ CAW_REQUIRE_AUTH: '0', CAW_HOST: '0.0.0.0' })),
      (error) => error.message.includes('CAW_REQUIRE_AUTH') && error.message.includes('CAW_HOST'));
  });

  it('requires the access profile to be read, standard or full', () => {
    assert.equal(loadConfig(env({ CAW_ACCESS_PROFILE: 'read' })).profile, 'read');
    assert.equal(loadConfig(env({ CAW_ACCESS_PROFILE: 'standard' })).profile, 'standard');
    assertInvalid({ CAW_ACCESS_PROFILE: 'admin' }, 'CAW_ACCESS_PROFILE');
  });

  it('validates the application name length and characters', () => {
    assert.equal(loadConfig(env({ CAW_APP_NAME: '  My Gateway  ' })).appName, 'My Gateway');
    assert.equal(loadConfig(env({ CAW_APP_NAME: 'x'.repeat(60) })).appName.length, 60);
    assertInvalid({ CAW_APP_NAME: 'x'.repeat(61) }, 'CAW_APP_NAME');
    assertInvalid({ CAW_APP_NAME: 'bad\nname' }, 'CAW_APP_NAME');
  });

  it('accepts exact origins only and canonicalizes nothing else', () => {
    assert.equal(loadConfig(env({ CAW_PUBLIC_ORIGIN: 'https://example.com' })).publicOrigin, 'https://example.com');
    assert.equal(loadConfig(env({ CAW_PUBLIC_ORIGIN: 'http://localhost:4180' })).publicOrigin,
      'http://localhost:4180');
    assert.equal(loadConfig(env({ CAW_PUBLIC_ORIGIN: 'https://[::1]:8443' })).publicOrigin, 'https://[::1]:8443');
    for (const value of [
      'https://example.com/',
      'https://example.com/path',
      'https://example.com?x=1',
      'https://example.com#frag',
      'https://user:pw@example.com',
      'https://Example.com',
      'https://example.com:443',
      'HTTPS://example.com',
      'ftp://example.com',
      'example.com',
    ]) {
      assertInvalid({ CAW_PUBLIC_ORIGIN: value }, 'CAW_PUBLIC_ORIGIN');
    }
  });

  it('accepts only the listed engines, permission modes, efforts and log levels', () => {
    assert.equal(loadConfig(env({ CAW_ENGINE: 'mock' })).engine, 'mock');
    assertInvalid({ CAW_ENGINE: 'codex' }, 'CAW_ENGINE');
    assert.equal(loadConfig(env({ CAW_DEFAULT_PERMISSION_MODE: 'acceptEdits' })).defaults.permissionMode,
      'acceptEdits');
    assertInvalid({ CAW_DEFAULT_PERMISSION_MODE: 'yolo' }, 'CAW_DEFAULT_PERMISSION_MODE');
    assert.equal(loadConfig(env({ CAW_DEFAULT_EFFORT: 'max' })).defaults.effort, 'max');
    assert.equal(loadConfig(env({ CAW_DEFAULT_EFFORT: '' })).defaults.effort, null);
    assertInvalid({ CAW_DEFAULT_EFFORT: 'extreme' }, 'CAW_DEFAULT_EFFORT');
    assert.equal(loadConfig(env({ CAW_LOG_LEVEL: 'debug' })).logLevel, 'debug');
    assertInvalid({ CAW_LOG_LEVEL: 'trace' }, 'CAW_LOG_LEVEL');
  });

  it('requires bypassPermissions as default only when CAW_ALLOW_BYPASS=1', () => {
    assertInvalid({ CAW_DEFAULT_PERMISSION_MODE: 'bypassPermissions' }, 'CAW_DEFAULT_PERMISSION_MODE');
    const config = loadConfig(env({ CAW_DEFAULT_PERMISSION_MODE: 'bypassPermissions', CAW_ALLOW_BYPASS: '1' }));
    assert.equal(config.defaults.permissionMode, 'bypassPermissions');
    assert.equal(config.allowBypass, true);
  });

  it('refuses CAW_ALLOW_BYPASS=1 under the read and standard profiles, with one message', () => {
    for (const profile of ['read', 'standard']) {
      assert.throws(() => loadConfig(env({ CAW_ALLOW_BYPASS: '1', CAW_ACCESS_PROFILE: profile })), (error) => {
        assert.ok(error instanceof ConfigError, `expected ConfigError, got ${error?.name}`);
        assert.equal(error.message, 'CAW_ALLOW_BYPASS=1 requires CAW_ACCESS_PROFILE=full', profile);
        return true;
      });
    }
  });

  it('accepts CAW_ALLOW_BYPASS=1 under the full profile, and the switch off under any profile', () => {
    const config = loadConfig(env({ CAW_ALLOW_BYPASS: '1', CAW_ACCESS_PROFILE: 'full' }));
    assert.equal(config.profile, 'full');
    assert.equal(config.allowBypass, true);
    assert.equal(loadConfig(env({ CAW_ALLOW_BYPASS: '1' })).allowBypass, true, 'full is the default profile');
    for (const profile of ['read', 'standard', 'full']) {
      assert.equal(loadConfig(env({ CAW_ALLOW_BYPASS: '0', CAW_ACCESS_PROFILE: profile })).allowBypass, false);
    }
  });

  it('refuses bypassPermissions as the default mode under any profile but full, through the same rule', () => {
    const bypass = { CAW_DEFAULT_PERMISSION_MODE: 'bypassPermissions', CAW_ALLOW_BYPASS: '1' };
    assertInvalid({ ...bypass, CAW_ACCESS_PROFILE: 'standard' }, 'CAW_ALLOW_BYPASS=1 requires CAW_ACCESS_PROFILE=full');
    assertInvalid({ ...bypass, CAW_ACCESS_PROFILE: 'read' }, 'CAW_ALLOW_BYPASS=1 requires CAW_ACCESS_PROFILE=full');
    assertInvalid({ CAW_DEFAULT_PERMISSION_MODE: 'bypassPermissions', CAW_ACCESS_PROFILE: 'standard' },
      'CAW_ALLOW_BYPASS=1');
    const config = loadConfig(env({ ...bypass, CAW_ACCESS_PROFILE: 'full' }));
    assert.equal(config.profile, 'full');
    assert.equal(config.defaults.permissionMode, 'bypassPermissions');
  });

  it('validates the default model length', () => {
    assert.equal(loadConfig(env({ CAW_DEFAULT_MODEL: 'claude-sonnet' })).defaults.model, 'claude-sonnet');
    assertInvalid({ CAW_DEFAULT_MODEL: 'm'.repeat(201) }, 'CAW_DEFAULT_MODEL');
  });

  it('validates the claude binary override as an absolute existing file', () => {
    const binary = path.join(root, 'claude');
    fs.writeFileSync(binary, '#!/bin/sh\n');
    assert.equal(loadConfig(env({ CAW_CLAUDE_BIN: binary })).claudeBin, binary);
    assertInvalid({ CAW_CLAUDE_BIN: 'claude' }, 'CAW_CLAUDE_BIN');
    assertInvalid({ CAW_CLAUDE_BIN: path.join(root, 'missing') }, 'CAW_CLAUDE_BIN');
    assertInvalid({ CAW_CLAUDE_BIN: root }, 'CAW_CLAUDE_BIN');
  });

  it('requires the state directory to be absolute', () => {
    assert.equal(loadConfig(env({ CAW_STATE_DIR: path.join(root, 'state/') })).stateDir, path.join(root, 'state'));
    assertInvalid({ CAW_STATE_DIR: 'relative/state' }, 'CAW_STATE_DIR');
  });

  it('checks integer ranges for every numeric limit', () => {
    const ranges = [
      ['CAW_IDLE_TIMEOUT_MS', '60000', '86400000', '59999', '86400001'],
      ['CAW_MAX_LIVE_SESSIONS', '1', '32', '0', '33'],
      ['CAW_UPLOAD_MAX_BYTES', '1024', '1073741824', '1023', '1073741825'],
      ['CAW_IMAGE_MAX_BYTES', '1024', '20971520', '1023', '20971521'],
      ['CAW_UPLOAD_RETENTION_DAYS', '1', '365', '0', '366'],
      ['CAW_SESSION_TTL_HOURS', '1', '8760', '0', '8761'],
    ];
    for (const [name, low, high, below, above] of ranges) {
      assert.doesNotThrow(() => loadConfig(env({ [name]: low })), name);
      assert.doesNotThrow(() => loadConfig(env({ [name]: high })), name);
      assertInvalid({ [name]: below }, name);
      assertInvalid({ [name]: above }, name);
      assertInvalid({ [name]: 'many' }, name);
    }
    assert.equal(loadConfig(env({ CAW_SESSION_TTL_HOURS: '24' })).sessionTtlMs, 24 * 3600000);
  });
});

describe('workspace roots', () => {
  it('resolves each root with realpath, drops duplicates and keeps order', () => {
    const link = path.join(root, 'link-to-a');
    fs.symlinkSync(dirA, link);
    const config = loadConfig(env({ CAW_WORKSPACE_ROOTS: `${dirA}:${dirB}:${link}` }));
    assert.deepEqual(config.roots, [fs.realpathSync(dirA), fs.realpathSync(dirB)]);
  });

  it('rejects missing paths, files, relative paths and empty entries', () => {
    assertInvalid({ CAW_WORKSPACE_ROOTS: path.join(root, 'absent') }, 'CAW_WORKSPACE_ROOTS');
    assertInvalid({ CAW_WORKSPACE_ROOTS: aFile }, 'CAW_WORKSPACE_ROOTS');
    assertInvalid({ CAW_WORKSPACE_ROOTS: 'relative/dir' }, 'CAW_WORKSPACE_ROOTS');
    assertInvalid({ CAW_WORKSPACE_ROOTS: `${dirA}::${dirB}` }, 'CAW_WORKSPACE_ROOTS');
  });
});

describe('background tasks switch', () => {
  it('reads CLAUDE_CODE_DISABLE_BACKGROUND_TASKS as off when it is unset, blank, 0 or false in any letter case', () => {
    for (const raw of [undefined, '', '   ', '0', ' 0 ', 'false', 'FALSE', 'False']) {
      const extra = raw === undefined ? {} : { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: raw };
      assert.equal(loadConfig(env(extra)).backgroundTasksDisabled, false, `value ${JSON.stringify(raw)}`);
    }
  });

  it('reads any other non-empty value as on, the runtime inheriting the same variable', () => {
    for (const raw of ['1', 'true', 'TRUE', 'yes', 'off', ' 1 ']) {
      const config = loadConfig(env({ CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: raw }));
      assert.equal(config.backgroundTasksDisabled, true, `value ${JSON.stringify(raw)}`);
    }
  });
});

describe('runtime options', () => {
  it('reads the fallback model as a short text, and leaves it unset when blank', () => {
    const loaded = loadConfig(env({ CAW_FALLBACK_MODEL: ' claude-haiku-5-5 ' }));
    assert.equal(loaded.defaults.fallbackModel, 'claude-haiku-5-5');
    assert.equal(loadConfig(env({ CAW_FALLBACK_MODEL: '   ' })).defaults.fallbackModel, null);
    assertInvalid({ CAW_FALLBACK_MODEL: 'x'.repeat(201) }, 'CAW_FALLBACK_MODEL');
  });

  it('reads CAW_CHROME as a flag', () => {
    assert.equal(loadConfig(env({ CAW_CHROME: '1' })).chrome, true);
    assert.equal(loadConfig(env({ CAW_CHROME: '0' })).chrome, false);
  });

  it('reads the browser MCP command as a JSON array of one to 32 strings, and rejects anything else', () => {
    const config = loadConfig(env({
      CAW_BROWSER_MCP_COMMAND: JSON.stringify(['npx', '-y', '@playwright/mcp@0.0.40', '--headless']),
    }));
    assert.deepEqual(config.browserMcpCommand, ['npx', '-y', '@playwright/mcp@0.0.40', '--headless']);
    const absolute = loadConfig(env({ CAW_BROWSER_MCP_COMMAND: JSON.stringify(['/opt/browser/bin/serve']) }));
    assert.deepEqual(absolute.browserMcpCommand, ['/opt/browser/bin/serve']);
    assertInvalid({ CAW_BROWSER_MCP_COMMAND: 'npx -y server' }, 'CAW_BROWSER_MCP_COMMAND');
    assertInvalid({ CAW_BROWSER_MCP_COMMAND: '[]' }, 'CAW_BROWSER_MCP_COMMAND');
    assertInvalid({ CAW_BROWSER_MCP_COMMAND: JSON.stringify(Array(33).fill('npx')) }, 'CAW_BROWSER_MCP_COMMAND');
    assertInvalid({ CAW_BROWSER_MCP_COMMAND: JSON.stringify(['npx', 3]) }, 'CAW_BROWSER_MCP_COMMAND');
    assertInvalid({ CAW_BROWSER_MCP_COMMAND: JSON.stringify(['npx', 'a\nb']) }, 'CAW_BROWSER_MCP_COMMAND');
    assertInvalid({ CAW_BROWSER_MCP_COMMAND: JSON.stringify(['./relative/server']) }, 'CAW_BROWSER_MCP_COMMAND');
    assertInvalid({ CAW_BROWSER_MCP_COMMAND: JSON.stringify(['x'.repeat(1025)]) }, 'CAW_BROWSER_MCP_COMMAND');
  });
});

describe('unattended mode and the root guard', () => {
  const ROOT_MESSAGE = 'Claude Code refuses bypass mode as root. Run the gateway as a normal user, or set '
    + 'IS_SANDBOX=1 if this machine is a dedicated sandbox.';

  /** The environment of a gateway with no sandbox marker: the root guard sees exactly these variables. */
  function bare(extra = {}) {
    return { HOME: root, CAW_TOKEN: TOKEN, CAW_STATE_DIR: path.join(root, 'state'), ...extra };
  }

  it('starts with the switch off and bypass unavailable by default', () => {
    const config = loadConfig(env());
    assert.equal(config.unattendedDefault, false);
    assert.equal(config.allowBypass, false);
  });

  it('CAW_UNATTENDED=1 makes the switch on by default and bypass available', () => {
    const config = loadConfig(env({ CAW_UNATTENDED: '1' }));
    assert.equal(config.unattendedDefault, true);
    assert.equal(config.allowBypass, true);
  });

  it('CAW_ALLOW_BYPASS=1 makes bypass available without making the switch on', () => {
    const config = loadConfig(env({ CAW_ALLOW_BYPASS: '1' }));
    assert.equal(config.allowBypass, true);
    assert.equal(config.unattendedDefault, false);
  });

  it('CAW_UNATTENDED=1 needs the full profile, under read and standard alike', () => {
    for (const profile of ['read', 'standard']) {
      assert.throws(() => loadConfig(env({ CAW_UNATTENDED: '1', CAW_ACCESS_PROFILE: profile })),
        (error) => error instanceof ConfigError
          && error.message === 'CAW_UNATTENDED=1 requires CAW_ACCESS_PROFILE=full', profile);
    }
    assert.equal(loadConfig(env({ CAW_UNATTENDED: '0', CAW_ACCESS_PROFILE: 'read' })).unattendedDefault, false);
  });

  it('CAW_ALLOW_BYPASS=1 keeps its own message under the other profiles', () => {
    assert.throws(() => loadConfig(env({ CAW_ALLOW_BYPASS: '1', CAW_ACCESS_PROFILE: 'standard' })),
      (error) => error instanceof ConfigError && error.message === 'CAW_ALLOW_BYPASS=1 requires CAW_ACCESS_PROFILE=full');
  });

  it('CAW_UNATTENDED is read as a flag', () => {
    assert.throws(() => loadConfig(env({ CAW_UNATTENDED: 'yes' })),
      (error) => error instanceof ConfigError && error.message === 'CAW_UNATTENDED must be 0, 1, true or false');
  });

  it('refuses every bypass setting as root without a sandbox, with the documented message', () => {
    for (const extra of [
      { CAW_ALLOW_BYPASS: '1' },
      { CAW_UNATTENDED: '1' },
      { CAW_DEFAULT_PERMISSION_MODE: 'bypassPermissions' },
      { CAW_ALLOW_BYPASS: '1', CAW_DEFAULT_PERMISSION_MODE: 'bypassPermissions' },
    ]) {
      assert.throws(() => loadConfig(bare(extra), { uid: 0 }),
        (error) => error instanceof ConfigError && error.message === ROOT_MESSAGE, JSON.stringify(extra));
    }
    assert.equal(ROOT_MESSAGE, BYPASS_ROOT_MESSAGE);
  });

  it('accepts bypass as root when IS_SANDBOX=1 or a non-empty CLAUDE_CODE_BUBBLEWRAP is set', () => {
    const sandboxes = [{ IS_SANDBOX: '1' }, { CLAUDE_CODE_BUBBLEWRAP: '/usr/bin/bwrap' }];
    for (const sandbox of sandboxes) {
      const config = loadConfig(bare({ CAW_UNATTENDED: '1', ...sandbox }), { uid: 0 });
      assert.equal(config.allowBypass, true, JSON.stringify(sandbox));
      assert.equal(config.unattendedDefault, true);
    }
    assert.equal(loadConfig(bare({ CAW_ALLOW_BYPASS: '1', IS_SANDBOX: '1' }), { uid: 0 }).allowBypass, true);
  });

  it('does not count IS_SANDBOX set to anything but 1, or a blank CLAUDE_CODE_BUBBLEWRAP, as a sandbox', () => {
    for (const sandbox of [{ IS_SANDBOX: '0' }, { IS_SANDBOX: 'true' }, { CLAUDE_CODE_BUBBLEWRAP: '  ' }]) {
      assert.throws(() => loadConfig(bare({ CAW_ALLOW_BYPASS: '1', ...sandbox }), { uid: 0 }),
        (error) => error instanceof ConfigError && error.message === ROOT_MESSAGE, JSON.stringify(sandbox));
    }
  });

  it('accepts bypass for a normal user, with or without a sandbox', () => {
    assert.equal(loadConfig(bare({ CAW_ALLOW_BYPASS: '1' }), { uid: 1000 }).allowBypass, true);
    assert.equal(loadConfig(bare({ CAW_UNATTENDED: '1' }), { uid: 1000 }).unattendedDefault, true);
    assert.equal(loadConfig(bare({ CAW_DEFAULT_PERMISSION_MODE: 'bypassPermissions', CAW_ALLOW_BYPASS: '1' }),
      { uid: 1000 }).defaults.permissionMode, 'bypassPermissions');
  });

  it('leaves root alone when no bypass setting is made', () => {
    const config = loadConfig(bare({ CAW_DEFAULT_PERMISSION_MODE: 'default', CAW_ALLOW_BYPASS: '0' }), { uid: 0 });
    assert.equal(config.allowBypass, false);
    assert.equal(config.defaults.permissionMode, 'default');
  });
});
