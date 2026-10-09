// @ts-check
/**
 * Writes or verifies SOURCE_MANIFEST.sha256: one `<sha256>  <path>` line per covered file, sorted by POSIX path.
 *
 *   node scripts/source-manifest.mjs            write the manifest
 *   node scripts/source-manifest.mjs --verify   exit 1 when the tree or the manifest text differs
 *
 * Covered: every regular file under src, public, scripts, test (except test/e2e/artifacts), docs, deploy and .github,
 * plus the root files in ROOT_FILES. The manifest does not cover itself. Symbolic links are refused, because a link
 * can point outside the tree and the digest would not describe what is actually shipped.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = 'SOURCE_MANIFEST.sha256';
const DIRECTORIES = ['src', 'public', 'scripts', 'test', 'docs', 'deploy', '.github'];
const ROOT_FILES = ['package.json', 'package-lock.json', 'jsconfig.json', 'README.md', 'README.zh-CN.md',
  'ARCHITECTURE.md', 'SECURITY.md', 'CHANGELOG.md', 'LICENSE', '.gitignore', '.editorconfig'];
const EXCLUDED_NAMES = new Set(['.DS_Store', 'node_modules', '.git', '.state']);
const EXCLUDED_PATHS = new Set(['test/e2e/artifacts']);
const LINE_PATTERN = /^([0-9a-f]{64}) {2}(.+)$/;

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function byCodeUnit(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * @param {string} relDirectory
 * @param {string[]} out
 */
function collectDirectory(relDirectory, out) {
  const absolute = path.join(ROOT, relDirectory);
  if (!fs.existsSync(absolute)) return;
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    if (EXCLUDED_NAMES.has(entry.name)) continue;
    const rel = `${relDirectory}/${entry.name}`;
    if (EXCLUDED_PATHS.has(rel)) continue;
    if (entry.isDirectory()) {
      collectDirectory(rel, out);
    } else if (entry.isFile()) {
      out.push(rel);
    } else {
      throw new Error(`refusing to cover a non-regular entry: ${rel}`);
    }
  }
}

/**
 * @returns {string[]} covered POSIX paths, sorted
 */
function coveredFiles() {
  /** @type {string[]} */
  const files = [];
  for (const file of ROOT_FILES) {
    const absolute = path.join(ROOT, file);
    if (!fs.existsSync(absolute)) throw new Error(`required root file is missing: ${file}`);
    if (!fs.lstatSync(absolute).isFile()) throw new Error(`required root entry is not a regular file: ${file}`);
    files.push(file);
  }
  for (const directory of DIRECTORIES) collectDirectory(directory, files);
  return [...new Set(files)].sort(byCodeUnit);
}

/**
 * @param {string} rel
 * @returns {string} hex SHA-256 of the file content
 */
function digest(rel) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex');
}

/**
 * @returns {string} canonical manifest text for the current tree
 */
function renderManifest() {
  return coveredFiles().map((file) => `${digest(file)}  ${file}\n`).join('');
}

/**
 * @param {string} text
 * @returns {Map<string, string>} digest by path
 */
function parseManifest(text) {
  /** @type {Map<string, string>} */
  const entries = new Map();
  text.split('\n').forEach((line, index) => {
    if (line === '') return;
    const match = LINE_PATTERN.exec(line);
    if (!match) throw new Error(`malformed manifest line ${index + 1}`);
    if (entries.has(match[2])) throw new Error(`duplicate manifest entry: ${match[2]}`);
    entries.set(match[2], match[1]);
  });
  return entries;
}

/**
 * @returns {number} process exit code
 */
function verify() {
  const manifestPath = path.join(ROOT, MANIFEST);
  if (!fs.existsSync(manifestPath)) {
    console.error(`${MANIFEST} is missing; run npm run manifest and commit the result`);
    return 1;
  }
  const recordedText = fs.readFileSync(manifestPath, 'utf8');
  const expectedText = renderManifest();
  const expectedCount = expectedText.split('\n').length - 1;
  if (recordedText === expectedText) {
    console.log(`SOURCE_MANIFEST_OK files=${expectedCount}`);
    return 0;
  }

  const recorded = parseManifest(recordedText);
  const current = parseManifest(expectedText);
  const paths = [...new Set([...recorded.keys(), ...current.keys()])].sort(byCodeUnit);
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const file of paths) {
    if (!recorded.has(file)) {
      console.error(`ADDED ${file}`);
      added += 1;
    } else if (!current.has(file)) {
      console.error(`REMOVED ${file}`);
      removed += 1;
    } else if (recorded.get(file) !== current.get(file)) {
      console.error(`CHANGED ${file}`);
      changed += 1;
    }
  }
  if (added + removed + changed === 0) {
    console.error('FORMAT the digests match but the manifest text is not canonical; run npm run manifest');
  }
  console.error(`SOURCE_MANIFEST_MISMATCH added=${added} removed=${removed} changed=${changed}`);
  return 1;
}

/**
 * @returns {number} process exit code
 */
function main() {
  const args = process.argv.slice(2);
  const unknown = args.find((arg) => arg !== '--verify');
  if (unknown) {
    console.error(`unknown argument: ${unknown}\nusage: source-manifest.mjs [--verify]`);
    return 2;
  }
  if (args.includes('--verify')) return verify();
  const text = renderManifest();
  fs.writeFileSync(path.join(ROOT, MANIFEST), text);
  console.log(`SOURCE_MANIFEST_WRITTEN files=${text.split('\n').length - 1}`);
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`source-manifest: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
