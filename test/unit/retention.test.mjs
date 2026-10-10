/**
 * Conversation retention (deploy/retention.mjs): the cleanupPeriodDays that the installer writes to the Claude Code
 * settings.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RETENTION_DAYS, applyRetention, planRetention } from '../../deploy/retention.mjs';

const SCRIPT = fileURLToPath(new URL('../../deploy/retention.mjs', import.meta.url));

/** A fresh directory for one test, removed when the test ends. */
function makeDir(ctx) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caw-retention-'));
  ctx.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('planRetention', () => {
  it('creates the settings with the retention period when there is no file', () => {
    assert.deepEqual(planRetention(null), {
      outcome: 'created',
      text: `{\n  "cleanupPeriodDays": ${RETENTION_DAYS}\n}\n`,
    });
  });

  it('adds the period to an object and keeps every other key, in its order', () => {
    const plan = planRetention('{\n  "model": "opus",\n  "env": { "A": "1" }\n}\n');
    assert.equal(plan.outcome, 'set');
    assert.deepEqual(Object.keys(JSON.parse(plan.text)), ['model', 'env', 'cleanupPeriodDays']);
    assert.deepEqual(JSON.parse(plan.text), { model: 'opus', env: { A: '1' }, cleanupPeriodDays: RETENTION_DAYS });
  });

  it('never changes a period the file already sets, whatever the value', () => {
    for (const value of ['30', '1', '0', '7', 'null']) {
      assert.deepEqual(planRetention(`{"cleanupPeriodDays": ${value}}`), { outcome: 'kept' }, value);
    }
  });

  it('refuses a file that is not valid JSON or whose top level is not an object', () => {
    for (const text of ['{"model": ', '', '[]', 'null', '"text"', '42']) {
      assert.equal(planRetention(text).outcome, 'refused', JSON.stringify(text));
    }
  });
});

describe('applyRetention', () => {
  it('creates the settings file and its directory, readable by the owner only', (ctx) => {
    const file = path.join(makeDir(ctx), 'claude', 'settings.json');
    assert.equal(applyRetention(file).outcome, 'created');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).cleanupPeriodDays, RETENTION_DAYS);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  it('replaces an existing file in place, keeps its keys, and leaves no temporary file behind', (ctx) => {
    const dir = makeDir(ctx);
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, '{"model":"opus"}', { mode: 0o644 });
    assert.equal(applyRetention(file).outcome, 'set');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { model: 'opus', cleanupPeriodDays: RETENTION_DAYS });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir), ['settings.json']);
  });

  it('refuses to replace a symbolic link, so the link and its target stay as they are', (ctx) => {
    const dir = makeDir(ctx);
    const target = path.join(dir, 'dotfiles-settings.json');
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(target, '{}\n');
    fs.symlinkSync(target, file);
    assert.equal(applyRetention(file).outcome, 'refused');
    assert.ok(fs.lstatSync(file).isSymbolicLink());
    assert.equal(fs.readFileSync(target, 'utf8'), '{}\n');
  });

  it('leaves a file that is not valid JSON byte for byte as it was', (ctx) => {
    const file = path.join(makeDir(ctx), 'settings.json');
    fs.writeFileSync(file, '{"model": "opus",}');
    assert.equal(applyRetention(file).outcome, 'refused');
    assert.equal(fs.readFileSync(file, 'utf8'), '{"model": "opus",}');
  });
});

describe('deploy/retention.mjs command line', () => {
  it('reports what it did and exits 0; a refused file exits 1 with the manual step on stderr', (ctx) => {
    const file = path.join(makeDir(ctx), 'settings.json');
    const created = spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' });
    assert.equal(created.status, 0, created.stderr);
    assert.match(created.stdout, /^Created .*cleanupPeriodDays 3650/);

    const again = spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' });
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /already sets cleanupPeriodDays, so it was left unchanged/);

    fs.writeFileSync(file, '{');
    const refused = spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /not valid JSON/);
    assert.match(refused.stderr, /"cleanupPeriodDays": 3650/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{');
  });

  it('exits 2 without a settings path', () => {
    const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage:/);
  });
});
