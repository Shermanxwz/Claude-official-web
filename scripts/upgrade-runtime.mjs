// @ts-check
/**
 * Moves the gateway to another Claude Agent SDK version, and with it to the Claude Code runtime that SDK bundles, in
 * one checked sequence:
 *
 *   npm run upgrade:runtime                  the latest SDK version on the npm registry
 *   npm run upgrade:runtime -- 0.3.296       an exact version
 *   npm run upgrade:runtime -- --dry-run     print the versions and the steps, change nothing
 *
 * It prints the current and the target SDK and Claude Code versions, then runs `npm install --save-exact` for the
 * target, `npm run manifest`, `npm run contract` and `npm run seal`, and stops at the first failure with the rollback
 * commands. It never runs git itself, and it changes nothing when the target is the installed version.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * @typedef {{status: number|null, stdout: string}} RunResult
 * @typedef {(args: string[], options: {capture: boolean}) => RunResult} Runner
 * @typedef {{version: string, claudeCodeVersion: string}} Versions
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SDK_NAME = '@anthropic-ai/claude-agent-sdk';
const SDK_PACKAGE_JSON = path.join(ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json');
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const ROLLBACK = 'git checkout -- package.json package-lock.json SOURCE_MANIFEST.sha256 && npm ci';
const RESTART = 'systemctl --user restart claude-official-web';
const USAGE = `usage: npm run upgrade:runtime -- [<version>] [--dry-run]
  <version>    an exact SDK version, such as 0.3.296; without one, the latest version on the npm registry
  --dry-run    print the versions and the steps, change nothing
  -h, --help   show this help`;

/** A problem with the command line. */
export class UsageError extends Error {}

/**
 * @param {string[]} argv the arguments after the script name
 * @returns {{version: string|null, dryRun: boolean, help: boolean}}
 * @throws {UsageError} for an unknown option, a second version or a version that is not x.y.z
 */
export function parseArgs(argv) {
  /** @type {{version: string|null, dryRun: boolean, help: boolean}} */
  const options = { version: null, dryRun: false, help: false };
  for (const arg of argv) {
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg.startsWith('-')) {
      throw new UsageError(`unknown option: ${arg}`);
    } else if (options.version !== null) {
      throw new UsageError(`only one version can be given, not ${options.version} and ${arg}`);
    } else if (!VERSION_PATTERN.test(arg)) {
      throw new UsageError(`not an exact version: ${arg} (expected x.y.z, such as 0.3.296)`);
    } else {
      options.version = arg;
    }
  }
  return options;
}

/**
 * The npm steps after the target is known, in the order they run. The first failure stops the sequence.
 * @param {string} target
 * @returns {Array<{label: string, args: string[]}>}
 */
export function stepsFor(target) {
  return [
    { label: `install SDK ${target} exactly`, args: ['install', '--save-exact', `${SDK_NAME}@${target}`] },
    { label: 'refresh SOURCE_MANIFEST.sha256', args: ['run', 'manifest'] },
    { label: 'check the runtime contract', args: ['run', 'contract'] },
    { label: 'run the production seal', args: ['run', 'seal'] },
  ];
}

/**
 * Runs npm with the npm CLI that started this script when that is available, so that no shell is involved (as in
 * seal.mjs). A captured run returns its standard output; an uncaptured run shows its output as it goes.
 * @param {string[]} args
 * @param {{capture: boolean}} options
 * @returns {RunResult}
 */
export function npmRunner(args, { capture }) {
  const cli = process.env.npm_execpath ?? '';
  const useCli = /npm-cli\.js$/.test(cli);
  const result = spawnSync(useCli ? process.execPath : 'npm', useCli ? [cli, ...args] : args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  return { status: result.status, stdout: result.stdout ?? '' };
}

/**
 * One field of a registry entry, as npm prints it with --json. Null when npm fails or prints no string.
 * @param {Runner} run
 * @param {string} spec a package name, or name@version
 * @param {string} field
 * @returns {string|null}
 */
function registryField(run, spec, field) {
  const result = run(['view', spec, field, '--json'], { capture: true });
  if (result.status !== 0) return null;
  try {
    const value = JSON.parse(result.stdout);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/**
 * The SDK version installed in this checkout and the Claude Code version its package names.
 * @param {string} [file] the SDK's package.json; the installed one by default
 * @returns {Versions}
 */
export function readInstalledVersions(file = SDK_PACKAGE_JSON) {
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { version: manifest.version, claudeCodeVersion: manifest.claudeCodeVersion };
}

/**
 * @param {string[]} argv the arguments after the script name
 * @param {{
 *   run?: Runner, installed?: () => Versions, log?: (line: string) => void, fail?: (line: string) => void,
 * }} [io] injected by the tests; the defaults run npm and print to the terminal
 * @returns {number} process exit code
 */
export function main(argv, io = {}) {
  const run = io.run ?? npmRunner;
  const installed = io.installed ?? (() => readInstalledVersions());
  const log = io.log ?? console.log;
  const fail = io.fail ?? console.error;

  /** @type {ReturnType<typeof parseArgs>} */
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    fail(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    log(USAGE);
    return 0;
  }

  /** @type {Versions} */
  let current;
  try {
    current = installed();
  } catch {
    fail('The Claude Agent SDK is not installed in this checkout. Run npm ci first.');
    return 1;
  }

  const target = options.version ?? registryField(run, SDK_NAME, 'dist-tags.latest');
  if (target === null) {
    fail('Could not read the latest SDK version from the npm registry. Check the network, or give a version.');
    return 1;
  }
  if (options.version !== null && registryField(run, `${SDK_NAME}@${target}`, 'version') !== target) {
    fail(`SDK ${target} is not on the npm registry.`);
    return 1;
  }
  const targetClaudeCode = registryField(run, `${SDK_NAME}@${target}`, 'claudeCodeVersion');
  if (targetClaudeCode === null) {
    fail(`Could not read the Claude Code version that SDK ${target} bundles.`);
    return 1;
  }

  log(`SDK          current ${current.version}   target ${target}`);
  log(`Claude Code  current ${current.claudeCodeVersion}   target ${targetClaudeCode}`);
  if (target === current.version) {
    log(`Already on SDK ${target}; nothing to do.`);
    return 0;
  }

  const steps = stepsFor(target);
  if (options.dryRun) {
    log('');
    log('Dry run: nothing changed. These steps would run in order, and the first failure would stop them:');
    for (const [index, step] of steps.entries()) log(`  ${index + 1}. npm ${step.args.join(' ')}`);
    log(`On failure, roll back with: ${ROLLBACK}`);
    return 0;
  }

  for (const [index, step] of steps.entries()) {
    log(`\n[${index + 1}/${steps.length}] ${step.label}: npm ${step.args.join(' ')}`);
    if (run(step.args, { capture: false }).status !== 0) {
      fail(`\nThe upgrade stopped at step ${index + 1} (${step.label}). The steps after it did not run.`);
      fail(`Roll back with: ${ROLLBACK}`);
      return 1;
    }
  }
  log(`\nUpgraded to SDK ${target} (Claude Code ${targetClaudeCode}).`);
  log('Review the changes with git diff, then commit package.json, package-lock.json and SOURCE_MANIFEST.sha256.');
  log(`Restart the service to run it: ${RESTART}`);
  log('Optional, needs a Claude login and spends a few turns: npm run smoke:runtime');
  return 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2));
}
