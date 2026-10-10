// @ts-check
/**
 * Checks the runtime surface the gateway relies on (src/engine/runtime-surface.mjs) against the installed Claude Agent
 * SDK and the Claude Code executable it bundles, and prints the versions in use. Run with `npm run contract`.
 * `npm run contract -- --candidate` checks an SDK installed without saving it (the weekly CI canary): a version other
 * than the pinned one is then reported, not counted as a failure.
 *
 *   exit 0  every entry is present, and the installed SDK matches package.json and the executable's checksum
 *   exit 1  an entry is missing, or the SDK or the executable does not match what the gateway pins
 *   exit 2  the executable for this platform is not installed (run npm ci)
 *
 * The SDK's declaration file (sdk.d.ts) and implementation (sdk.mjs) are read as text. The executable is read once as
 * bytes and searched for each runtime name; it is not run.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RUNTIME_SURFACE } from '../src/engine/runtime-surface.mjs';
import { resolveClaudeBinary } from '../src/terminal.mjs';

/** @typedef {import('../src/engine/runtime-surface.mjs').SurfaceEntry} SurfaceEntry */
/** @typedef {import('../src/contracts.mjs').Config} Config */
/**
 * What the entries are checked against.
 * @typedef {{declarations: string, implementation: string, hasToken: (token: string) => boolean}} Sources
 */
/** @typedef {{entry: SurfaceEntry, problems: string[]}} Result */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SDK_NAME = '@anthropic-ai/claude-agent-sdk';
const SDK_DIR = path.join(ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
const QUERY_HEAD = 'export declare interface Query extends AsyncGenerator<SDKMessage, void> {';
const OPTIONS_HEAD = 'export declare type Options = {';
const EXIT_OK = 0;
const EXIT_MISSING = 1;
const EXIT_NO_EXECUTABLE = 2;

/**
 * The declaration block that starts at `head` and ends before the closing brace that starts a line.
 * @param {string} declarations
 * @param {string} head
 * @returns {string|null} null when the block is not in the file
 */
export function declarationBlock(declarations, head) {
  const start = declarations.indexOf(head);
  if (start === -1) return null;
  const end = declarations.indexOf('\n}', start);
  return end === -1 ? null : declarations.slice(start, end);
}

/**
 * Whether a block declares a member at the member indentation: `name(`, `name<`, `name?:` or `name:`.
 * @param {string} block
 * @param {string} name
 * @returns {boolean}
 */
function declaresMember(block, name) {
  return new RegExp(`^ {4}${name}\\??[(:<]`, 'm').test(block);
}

/**
 * Whether sdk.mjs defines a class method with this name, which the minified SDK writes as `name(args) {`.
 * @param {string} implementation
 * @param {string} name
 * @returns {boolean}
 */
function definesMethod(implementation, name) {
  return new RegExp(`[}\\s;,{](?:async\\s+)?${name}\\([^()]*\\)\\s*\\{`).test(implementation);
}

/**
 * Whether the name of one entry is in the source the entry names.
 * @param {SurfaceEntry} entry
 * @param {Sources} sources
 * @returns {boolean}
 */
function nameIsPresent(entry, sources) {
  const { name, kind, source } = entry;
  if (source === 'binary') return sources.hasToken(name);
  if (source === 'sdk.mjs') {
    return kind === 'sdk-method' ? definesMethod(sources.implementation, name) : sources.implementation.includes(name);
  }
  if (kind === 'sdk-export') return new RegExp(`^export declare function ${name}\\b`, 'm').test(sources.declarations);
  const block = declarationBlock(sources.declarations, kind === 'query-method' ? QUERY_HEAD : OPTIONS_HEAD);
  return block !== null && declaresMember(block, name);
}

/**
 * The problems of one entry: its name is not in the source it names, or its wire name is not in the executable.
 * @param {SurfaceEntry} entry
 * @param {Sources} sources
 * @returns {string[]} empty when the entry is present
 */
export function problemsOf(entry, sources) {
  /** @type {string[]} */
  const problems = [];
  if (!nameIsPresent(entry, sources)) problems.push(`${entry.name} is not in ${entry.source}`);
  if (entry.wire !== undefined && !sources.hasToken(`"${entry.wire}"`)) {
    problems.push(`"${entry.wire}" is not in the executable`);
  }
  return problems;
}

/**
 * @param {readonly SurfaceEntry[]} entries
 * @param {Sources} sources
 * @returns {Result[]}
 */
export function checkSurface(entries, sources) {
  return entries.map((entry) => ({ entry, problems: problemsOf(entry, sources) }));
}

/**
 * Entries per kind, in the order the kinds first appear, with how many are missing.
 * @param {Result[]} results
 * @returns {Array<{kind: string, source: string, entries: number, missing: number}>}
 */
export function tallyByKind(results) {
  /** @type {Map<string, {kind: string, source: string, entries: number, missing: number}>} */
  const tally = new Map();
  for (const { entry, problems } of results) {
    const row = tally.get(entry.kind) ?? { kind: entry.kind, source: entry.source, entries: 0, missing: 0 };
    row.entries += 1;
    if (problems.length > 0) row.missing += 1;
    tally.set(entry.kind, row);
  }
  return [...tally.values()];
}

/**
 * @param {string} file
 * @returns {any}
 */
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Reads the installed SDK, verifies the executable against it and prints the report.
 * @param {string[]} argv the command-line arguments after the script
 * @returns {number} process exit code
 */
function main(argv) {
  const candidate = argv.includes('--candidate');
  const pkg = readJson(path.join(ROOT, 'package.json'));
  const sdk = readJson(path.join(SDK_DIR, 'package.json'));
  const pinned = pkg.dependencies?.[SDK_NAME];
  const executable = resolveClaudeBinary(/** @type {Config} */ ({ claudeBin: null }));
  if (executable === null) {
    console.error(`The Claude Code executable for ${process.platform}-${process.arch} is not installed. `
      + `It ships in an optional package of ${SDK_NAME}; run npm ci, then npm run contract again.`);
    return EXIT_NO_EXECUTABLE;
  }
  const platform = path.basename(path.dirname(executable)).replace(/^claude-agent-sdk-/, '');
  const manifest = readJson(path.join(SDK_DIR, 'manifest.json'));
  const bytes = fs.readFileSync(executable);
  /** @type {Sources} */
  const sources = {
    declarations: fs.readFileSync(path.join(SDK_DIR, 'sdk.d.ts'), 'utf8'),
    implementation: fs.readFileSync(path.join(SDK_DIR, 'sdk.mjs'), 'utf8'),
    hasToken: (token) => bytes.indexOf(token) !== -1,
  };
  const results = checkSurface(RUNTIME_SURFACE, sources);
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const recorded = manifest.platforms?.[platform]?.checksum;

  /** @type {string[]} */
  const versionProblems = [];
  if (pinned !== sdk.version && !candidate) {
    versionProblems.push(`installed SDK ${sdk.version} is not the pinned ${pinned}`);
  }
  if (manifest.version !== sdk.claudeCodeVersion) {
    versionProblems.push(
      `the SDK manifest names Claude Code ${manifest.version}, the package ${sdk.claudeCodeVersion}`,
    );
  }
  if (recorded !== digest) versionProblems.push('the executable sha256 is not the one the SDK manifest records');

  const verified = recorded === digest ? 'verified' : 'NOT VERIFIED';
  const role = candidate ? ', checked as a candidate' : '';
  console.log(`${pkg.name} ${pkg.version}: SDK ${sdk.version} (pinned ${pinned}${role}), `
    + `Claude Code ${sdk.claudeCodeVersion}`);
  console.log(`executable: ${path.relative(ROOT, executable)} (${platform}, sha256 ${verified})`);
  console.log('');
  console.log(`${'kind'.padEnd(14)}${'checked in'.padEnd(12)}${'entries'.padStart(8)}${'missing'.padStart(9)}`);
  for (const row of tallyByKind(results)) {
    console.log(`${row.kind.padEnd(14)}${row.source.padEnd(12)}${String(row.entries).padStart(8)}`
      + `${String(row.missing).padStart(9)}`);
  }
  const missing = results.filter((result) => result.problems.length > 0);
  for (const { entry, problems } of missing) {
    console.error(`MISSING ${entry.kind} ${entry.name} (${entry.source}): ${problems.join('; ')}`);
  }
  for (const problem of versionProblems) console.error(`VERSION ${problem}`);
  if (missing.length > 0 || versionProblems.length > 0) {
    console.error(`RUNTIME_CONTRACT_FAILED missing=${missing.length} version_problems=${versionProblems.length}`);
    return EXIT_MISSING;
  }
  console.log(`RUNTIME_CONTRACT_OK entries=${results.length}`);
  return EXIT_OK;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2));
}
