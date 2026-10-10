// The argument parsing and the plan of scripts/upgrade-runtime.mjs. The npm runner is a fake here, so no npm runs.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, parseArgs, readInstalledVersions, stepsFor, UsageError } from '../../scripts/upgrade-runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SDK = '@anthropic-ai/claude-agent-sdk';
const CURRENT = { version: '0.3.295', claudeCodeVersion: '2.1.295' };
const TARGET = '0.3.296';
const TARGET_CLAUDE_CODE = '2.1.296';
const ROLLBACK = 'git checkout -- package.json package-lock.json SOURCE_MANIFEST.sha256 && npm ci';

/**
 * A stand-in for the npm runner. A registry lookup answers from `latest` (null for a failed lookup) and from `releases`
 * (an SDK version to the Claude Code version it bundles, null when that field cannot be read). Any other call succeeds,
 * unless its command line is `failOn`. Every call is recorded as its command line.
 * @param {{latest?: string|null, releases?: Record<string, string|null>, failOn?: string}} [options]
 * @returns {{run: (args: string[]) => {status: number, stdout: string}, calls: string[]}}
 */
function fakeNpm({
  latest = TARGET,
  releases = { [TARGET]: TARGET_CLAUDE_CODE, [CURRENT.version]: CURRENT.claudeCodeVersion },
  failOn = '',
} = {}) {
  /** @type {string[]} */
  const calls = [];
  /** @param {string[]} args */
  const run = (args) => {
    const line = args.join(' ');
    calls.push(line);
    if (args[0] !== 'view') return { status: line === failOn ? 1 : 0, stdout: '' };
    const [, spec, field] = args;
    if (spec === SDK) {
      return latest === null ? { status: 1, stdout: '' } : { status: 0, stdout: JSON.stringify(latest) };
    }
    const version = spec.slice(spec.lastIndexOf('@') + 1);
    if (!(version in releases)) return { status: 0, stdout: '' };
    if (field === 'version') return { status: 0, stdout: JSON.stringify(version) };
    const claudeCode = releases[version];
    if (field === 'claudeCodeVersion' && claudeCode !== null) return { status: 0, stdout: JSON.stringify(claudeCode) };
    return { status: 1, stdout: '' };
  };
  return { run, calls };
}

/**
 * Runs main() against a fake npm and records what it printed.
 * @param {string[]} argv
 * @param {{npm?: ReturnType<typeof fakeNpm>, installed?: () => {version: string, claudeCodeVersion: string}}} [options]
 * @returns {{code: number, out: string, err: string, calls: string[]}}
 */
function runMain(argv, { npm = fakeNpm(), installed = () => CURRENT } = {}) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const err = [];
  const code = main(argv, {
    run: npm.run,
    installed,
    log: (line) => out.push(line),
    fail: (line) => err.push(line),
  });
  return { code, out: out.join('\n'), err: err.join('\n'), calls: npm.calls };
}

/**
 * The commands that change something, without the registry lookups.
 * @param {string[]} calls
 * @returns {string[]}
 */
function changesOf(calls) {
  return calls.filter((line) => !line.startsWith('view '));
}

/**
 * @param {() => unknown} fn
 * @param {RegExp} message
 */
function assertUsageError(fn, message) {
  assert.throws(fn, (error) => error instanceof UsageError && message.test(error.message));
}

describe('upgrade runtime arguments', () => {
  test('with no arguments, the latest version and no dry run', () => {
    assert.deepEqual(parseArgs([]), { version: null, dryRun: false, help: false });
  });

  test('an exact version and --dry-run are read in either order', () => {
    assert.deepEqual(parseArgs(['--dry-run', TARGET]), { version: TARGET, dryRun: true, help: false });
    assert.deepEqual(parseArgs([TARGET, '--dry-run']), { version: TARGET, dryRun: true, help: false });
  });

  test('--help and -h ask for the usage', () => {
    assert.equal(parseArgs(['--help']).help, true);
    assert.equal(parseArgs(['-h']).help, true);
  });

  test('an unknown option is a usage error', () => {
    assertUsageError(() => parseArgs(['--force']), /unknown option: --force/);
  });

  test('a second version is a usage error', () => {
    assertUsageError(() => parseArgs([TARGET, '0.3.297']), /only one version can be given/);
  });

  test('a version that is not x.y.z is a usage error', () => {
    for (const version of ['latest', '0.3', 'v0.3.296', '0.3.296-beta.1']) {
      assertUsageError(() => parseArgs([version]), /not an exact version/);
    }
  });
});

describe('upgrade runtime steps', () => {
  test('install the exact SDK, refresh the manifest, check the contract and seal, in that order', () => {
    assert.deepEqual(stepsFor(TARGET).map((step) => step.args), [
      ['install', '--save-exact', `${SDK}@${TARGET}`],
      ['run', 'manifest'],
      ['run', 'contract'],
      ['run', 'seal'],
    ]);
  });
});

describe('upgrade runtime plan', () => {
  test('a dry run prints both versions and the steps, and only looks up the registry', () => {
    const result = runMain(['--dry-run', TARGET]);
    assert.equal(result.code, 0);
    assert.match(result.out, /SDK\s+current 0\.3\.295\s+target 0\.3\.296/);
    assert.match(result.out, /Claude Code\s+current 2\.1\.295\s+target 2\.1\.296/);
    assert.match(result.out, /1\. npm install --save-exact @anthropic-ai\/claude-agent-sdk@0\.3\.296/);
    assert.match(result.out, /4\. npm run seal/);
    assert.ok(result.out.includes(`On failure, roll back with: ${ROLLBACK}`));
    assert.deepEqual(changesOf(result.calls), []);
    assert.equal(result.err, '');
  });

  test('without a version, the target is the latest version the registry tags', () => {
    const result = runMain(['--dry-run']);
    assert.match(result.out, /target 0\.3\.296/);
    assert.ok(result.calls.includes(`view ${SDK} dist-tags.latest --json`));
  });

  test('an installed SDK that is the requested version is left alone', () => {
    const npm = fakeNpm({ releases: { [CURRENT.version]: CURRENT.claudeCodeVersion } });
    const result = runMain([CURRENT.version], { npm });
    assert.equal(result.code, 0);
    assert.ok(result.out.includes(`Already on SDK ${CURRENT.version}; nothing to do.`));
    assert.deepEqual(changesOf(result.calls), []);
  });

  test('when the latest version is already installed, nothing changes', () => {
    const result = runMain([], { npm: fakeNpm({ latest: CURRENT.version }) });
    assert.equal(result.code, 0);
    assert.ok(result.out.includes(`Already on SDK ${CURRENT.version}; nothing to do.`));
    assert.deepEqual(changesOf(result.calls), []);
  });

  test('a run installs, refreshes, checks and seals in order, then says what to do next', () => {
    const result = runMain([TARGET]);
    assert.equal(result.code, 0);
    assert.deepEqual(changesOf(result.calls), [
      `install --save-exact ${SDK}@${TARGET}`,
      'run manifest',
      'run contract',
      'run seal',
    ]);
    assert.ok(result.out.includes(`Upgraded to SDK ${TARGET} (Claude Code ${TARGET_CLAUDE_CODE}).`));
    assert.match(result.out, /git diff, then commit package\.json, package-lock\.json and SOURCE_MANIFEST\.sha256/);
    assert.match(result.out, /systemctl --user restart claude-official-web/);
    assert.equal(result.err, '');
  });

  test('a failing step stops the run, skips the later steps and prints the rollback', () => {
    const result = runMain([TARGET], { npm: fakeNpm({ failOn: 'run contract' }) });
    assert.equal(result.code, 1);
    assert.deepEqual(changesOf(result.calls), [
      `install --save-exact ${SDK}@${TARGET}`,
      'run manifest',
      'run contract',
    ]);
    assert.match(result.err, /stopped at step 3 \(check the runtime contract\)\. The steps after it did not run\./);
    assert.ok(result.err.includes(`Roll back with: ${ROLLBACK}`));
    assert.ok(!result.out.includes('Upgraded to'));
  });

  test('a failed install stops before anything else changes', () => {
    const result = runMain([TARGET], { npm: fakeNpm({ failOn: `install --save-exact ${SDK}@${TARGET}` }) });
    assert.equal(result.code, 1);
    assert.deepEqual(changesOf(result.calls), [`install --save-exact ${SDK}@${TARGET}`]);
    assert.match(result.err, /stopped at step 1 \(install SDK 0\.3\.296 exactly\)/);
  });

  test('a registry that cannot name the latest version changes nothing', () => {
    const result = runMain([], { npm: fakeNpm({ latest: null }) });
    assert.equal(result.code, 1);
    assert.match(result.err, /Could not read the latest SDK version from the npm registry/);
    assert.deepEqual(changesOf(result.calls), []);
  });

  test('a version that is not on the registry changes nothing', () => {
    const result = runMain(['9.9.9']);
    assert.equal(result.code, 1);
    assert.match(result.err, /SDK 9\.9\.9 is not on the npm registry\./);
    assert.deepEqual(changesOf(result.calls), []);
  });

  test('a version whose bundled Claude Code cannot be read changes nothing', () => {
    const result = runMain([TARGET], { npm: fakeNpm({ releases: { [TARGET]: null } }) });
    assert.equal(result.code, 1);
    assert.match(result.err, /Could not read the Claude Code version that SDK 0\.3\.296 bundles\./);
    assert.deepEqual(changesOf(result.calls), []);
  });

  test('without an installed SDK it asks for npm ci and looks nothing up', () => {
    const result = runMain([TARGET], {
      installed: () => {
        throw new Error('ENOENT');
      },
    });
    assert.equal(result.code, 1);
    assert.match(result.err, /Run npm ci first\./);
    assert.deepEqual(result.calls, []);
  });

  test('a usage error exits 2 with the usage and runs nothing', () => {
    const result = runMain(['--force']);
    assert.equal(result.code, 2);
    assert.match(result.err, /unknown option: --force/);
    assert.match(result.err, /usage: npm run upgrade:runtime/);
    assert.deepEqual(result.calls, []);
  });

  test('--help prints the usage and exits 0 without looking anything up', () => {
    const result = runMain(['--help']);
    assert.equal(result.code, 0);
    assert.match(result.out, /usage: npm run upgrade:runtime/);
    assert.deepEqual(result.calls, []);
  });
});

describe('upgrade runtime installed versions', () => {
  // The installed SDK, not the pin: the weekly canary installs a newer SDK without saving it, and whether the installed
  // SDK matches the pin is the runtime contract's check (npm run contract).
  test('reads the installed SDK and the Claude Code version it bundles', () => {
    const sdkPackage = JSON.parse(fs.readFileSync(
      path.join(ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8'));
    const installed = readInstalledVersions();
    assert.equal(installed.version, sdkPackage.version);
    assert.equal(installed.claudeCodeVersion, sdkPackage.claudeCodeVersion);
    assert.match(installed.claudeCodeVersion, /^\d+\.\d+\.\d+$/);
  });
});
