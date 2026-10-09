// @ts-check
/**
 * Production seal. Runs every mechanical gate in order, stops at the first failure and, when all gates pass, writes
 * .state/seal-receipt.json and prints a SEALED line. The browser suite needs Chromium; --skip-e2e runs everything else
 * and produces a receipt marked "without-e2e" (SEALED-WITHOUT-E2E) for environments that cannot run it.
 *
 *   npm run seal
 *   npm run seal -- --skip-e2e
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = path.join(ROOT, '.state');
const RECEIPT = path.join(STATE_DIR, 'seal-receipt.json');
const MANIFEST = path.join(ROOT, 'SOURCE_MANIFEST.sha256');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/** @type {{name: string, script: string, browser?: boolean}[]} */
const STEPS = [
  { name: 'manifest:verify', script: 'manifest:verify' },
  { name: 'check', script: 'check' },
  { name: 'typecheck', script: 'typecheck' },
  { name: 'test', script: 'test' },
  { name: 'test:e2e', script: 'test:e2e', browser: true },
];

const USAGE = `usage: npm run seal [-- --skip-e2e]
  --skip-e2e  skip the browser suite (test/e2e). The receipt is marked "without-e2e" and the final line is
              SEALED-WITHOUT-E2E, which is not a full production seal.
  -h, --help  show this help`;

/**
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/**
 * Runs npm through the npm CLI that started this script when that is available, so no shell is involved.
 * @param {string[]} args
 * @returns {{command: string, args: string[]}}
 */
function npmCommand(args) {
  const cli = process.env.npm_execpath;
  if (cli && /npm-cli\.js$/.test(cli)) return { command: process.execPath, args: [cli, ...args] };
  return { command: 'npm', args };
}

/**
 * @param {{name: string, script: string}} step
 * @returns {{ok: boolean, ms: number, reason: string}}
 */
function runStep(step) {
  const { command, args } = npmCommand(['run', step.script]);
  const started = performance.now();
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
  const ms = Math.round(performance.now() - started);
  if (result.error) return { ok: false, ms, reason: `could not start npm: ${result.error.message}` };
  if (result.status !== 0) {
    const reason = result.signal ? `terminated by ${result.signal}` : `exit code ${result.status}`;
    return { ok: false, ms, reason };
  }
  return { ok: true, ms, reason: '' };
}

/**
 * @returns {number} process exit code
 */
function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const unknown = args.find((arg) => arg !== '--skip-e2e');
  if (unknown) {
    console.error(`unknown argument: ${unknown}\n${USAGE}`);
    return 2;
  }

  const skipE2e = args.includes('--skip-e2e');
  const mode = skipE2e ? 'without-e2e' : 'full';
  const steps = STEPS.filter((step) => !(skipE2e && step.browser));
  fs.rmSync(RECEIPT, { force: true }); // a receipt must describe the run that wrote it, never an earlier one

  console.log(`SEAL claude-official-web@${pkg.version} node=${process.version} `
    + `platform=${process.platform}-${process.arch} mode=${mode}`);
  if (skipE2e) {
    console.error('');
    console.error('!!! WARNING: --skip-e2e: the browser suite (test/e2e) was NOT run.');
    console.error('!!! This seal is incomplete and must not be used as a production release gate.');
    console.error('');
  }

  const started = performance.now();
  /** @type {{name: string, ms: number}[]} */
  const results = [];
  for (const [index, step] of steps.entries()) {
    const label = `[${index + 1}/${steps.length}] ${step.name}`;
    console.log(`\n${label}`);
    const outcome = runStep(step);
    if (!outcome.ok) {
      console.error(`\nSEAL FAILED at ${step.name} after ${formatDuration(outcome.ms)}: ${outcome.reason}`);
      return 1;
    }
    results.push({ name: step.name, ms: outcome.ms });
    console.log(`${label} passed in ${formatDuration(outcome.ms)}`);
  }

  const manifestSha256 = crypto.createHash('sha256').update(fs.readFileSync(MANIFEST)).digest('hex');
  const receipt = {
    version: pkg.version,
    manifestSha256,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    mode,
    steps: results,
    at: new Date().toISOString(),
  };
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`);

  const total = Math.round(performance.now() - started);
  console.log(`\nSEAL SUMMARY steps=${results.length}/${steps.length} total=${formatDuration(total)} mode=${mode}`);
  for (const result of results) console.log(`  ${result.name.padEnd(16)} ${formatDuration(result.ms)}`);
  console.log(`receipt: ${path.relative(ROOT, RECEIPT)}`);
  const finalLabel = skipE2e ? 'SEALED-WITHOUT-E2E' : 'SEALED';
  console.log(`${finalLabel} claude-official-web@${pkg.version} ${manifestSha256}`);
  return 0;
}

process.exitCode = main();
