/**
 * The systemd unit template (deploy/claude-official-web.service): the restart policy that keeps the service running
 * for years. The installer renders this file without changing these settings.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const UNIT = new URL('../../deploy/claude-official-web.service', import.meta.url);

/** The settings of each section, as { section: { Name: value } }. Comment lines and blank lines are skipped. */
function sectionsOf(text) {
  const sections = {};
  let current = null;
  for (const line of text.split('\n')) {
    const header = /^\[(\w+)\]$/.exec(line);
    if (header) {
      current = header[1];
      sections[current] = {};
      continue;
    }
    const setting = /^([A-Za-z]+)=(.*)$/.exec(line);
    if (setting && current) sections[current][setting[1]] = setting[2];
  }
  return sections;
}

describe('deploy/claude-official-web.service restart policy', () => {
  const { Unit, Service } = sectionsOf(readFileSync(UNIT, 'utf8'));

  it('never stops restarting after crashes: no start rate limit', () => {
    assert.equal(Unit.StartLimitIntervalSec, '0');
    assert.equal(Unit.StartLimitBurst, undefined, 'a burst limit does nothing once the interval is 0');
  });

  it('restarts after a failure, after a fixed delay, except for configuration errors', () => {
    assert.equal(Service.Restart, 'on-failure');
    assert.equal(Service.RestartSec, '5');
    assert.equal(Service.RestartPreventExitStatus, '2');
  });
});
