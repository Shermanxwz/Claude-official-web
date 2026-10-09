import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSdkAdapter } from '../../src/engine/sdk-adapter.mjs';

const SDK_MANIFEST = new URL('../../node_modules/@anthropic-ai/claude-agent-sdk/package.json', import.meta.url);

/** Logger that records every call instead of printing. */
function recordingLog() {
  const calls = [];
  const record = (level) => (msg, fields) => calls.push({ level, msg, fields });
  return { calls, log: { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') } };
}

describe('createSdkAdapter', () => {
  test('exposes the adapter surface the EngineHost relies on', () => {
    const { log } = recordingLog();
    const adapter = createSdkAdapter({ config: { claudeBin: null }, log });
    assert.equal(adapter.kind, 'sdk');
    for (const name of ['query', 'listSessions', 'getSessionMessages', 'getSessionInfo', 'renameSession',
      'tagSession', 'forkSession', 'deleteSession', 'listSubagents', 'getSubagentMessages', 'resolveSettings']) {
      assert.equal(typeof adapter[name], 'function', `${name} must be a function`);
    }
  });

  test('resolveSettings answers the SDK shape of effective settings, provenance and sources', async () => {
    const { log } = recordingLog();
    const adapter = createSdkAdapter({ config: { claudeBin: null }, log });
    const cwd = mkdtempSync(join(tmpdir(), 'caw-sdk-adapter-'));
    try {
      // Without the user, project and local sources the answer does not depend on the user's settings files, and the
      // test checks only the shape, which the machine's managed policy tier cannot change.
      const resolved = await adapter.resolveSettings({ cwd, settingSources: [] });
      assert.deepEqual(Object.keys(resolved).sort(), ['effective', 'provenance', 'sources']);
      assert.equal(typeof resolved.effective, 'object');
      assert.equal(typeof resolved.provenance, 'object');
      assert.ok(Array.isArray(resolved.sources));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('reports the installed SDK version exactly as its package manifest states it', () => {
    const { log } = recordingLog();
    const adapter = createSdkAdapter({ config: { claudeBin: null }, log });
    const manifest = JSON.parse(readFileSync(SDK_MANIFEST, 'utf8'));
    assert.match(adapter.sdkVersion, /^\d+\.\d+\.\d+$/);
    assert.equal(adapter.sdkVersion, manifest.version);
  });

  test('logs readiness with the SDK version and whether a custom binary is configured, never its path', () => {
    const { calls, log } = recordingLog();
    createSdkAdapter({ config: { claudeBin: '/opt/private/claude' }, log });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].level, 'info');
    assert.equal(calls[0].fields.engine, 'sdk');
    assert.equal(calls[0].fields.customBinary, true);
    assert.equal(JSON.stringify(calls).includes('/opt/private/claude'), false);
  });

  test('a null binary override is reported as the default executable', () => {
    const { calls, log } = recordingLog();
    createSdkAdapter({ config: { claudeBin: null }, log });
    assert.equal(calls[0].fields.customBinary, false);
  });
});
