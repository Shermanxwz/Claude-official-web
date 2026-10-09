// @ts-check
/**
 * Static checks over the repository. Prints one `path:line: rule: detail` line per violation to stderr and exits 1 when
 * any exist; otherwise prints a single CHECK_OK line. Run with `npm run check`.
 *
 * Scope: every regular file under src, public, scripts, test, docs, deploy and .github, plus the root files. Binary
 * files (by extension or NUL byte) get the size limit only. This file is exempt from the content rules because it
 * defines them.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = 'scripts/check.mjs';
const MAX_FILE_BYTES = 300 * 1024;
const SCAN_DIRECTORIES = ['src', 'public', 'scripts', 'test', 'docs', 'deploy', '.github'];
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', '.state']);
const SKIPPED_PATHS = new Set(['test/e2e/artifacts']);
const SKIPPED_NAMES = new Set(['.DS_Store']);
const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.otf',
  '.pdf', '.zip', '.gz', '.tgz', '.wasm', '.mp4', '.webm']);
const TAB_CHECKED_EXTENSIONS = new Set(['.mjs', '.js', '.css', '.html', '.json', '.yml', '.yaml', '.md', '.sh']);
const JSON_EXTENSIONS = new Set(['.json', '.webmanifest']);
const MODULE_EXTENSIONS = new Set(['.mjs', '.js']);
const SYNTAX_DIRECTORIES = ['src/', 'scripts/', 'public/js/', 'test/'];

const SOURCE_PATTERNS = [
  { rule: 'no-console', pattern: /\bconsole\./g, detail: 'use src/log.mjs instead of console.*' },
  { rule: 'no-eval', pattern: /(?<![\w$.])eval\s*\(/g, detail: 'eval() is forbidden' },
  { rule: 'no-function-constructor', pattern: /\bnew\s+Function\s*\(/g, detail: 'new Function() is forbidden' },
  { rule: 'no-shell', pattern: /\bshell\s*:\s*true\b/g, detail: 'child processes must never run through a shell' },
  {
    rule: 'no-exec',
    pattern: /(?<![\w$.])exec(?:Sync)?\s*\(/g,
    detail: 'exec() runs a command through a shell; use execFile or spawn with an argument array',
  },
];
const CHILD_PROCESS_METHOD_EXEC = /\.exec(?:Sync)?\s*\(/g;

const BROWSER_PATTERNS = [
  {
    rule: 'no-innerhtml',
    pattern: /\.(?:inner|outer)HTML\s*\+?=(?!=)/g,
    detail: 'assign DOM through h() or textContent, never innerHTML/outerHTML',
  },
  { rule: 'no-insert-html', pattern: /\binsertAdjacentHTML\s*\(/g, detail: 'insertAdjacentHTML is forbidden; build nodes with h()' },
  { rule: 'no-document-write', pattern: /\bdocument\.write(?:ln)?\s*\(/g, detail: 'document.write is forbidden' },
];

const SCRIPT_TAG = /<script\b[^>]*>/gi;
const ELEMENT_TAG = /<[a-z][^>]*>/gi;
const EVENT_ATTRIBUTE = /\son[a-z]+\s*=/i;
const UNFINISHED_MARKER = /\b(?:TODO|FIXME|XXX)\b/g;
const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"\n]+)['"]/g;

/**
 * @typedef {{file: string, line: number, rule: string, detail: string}} Violation
 */

/** @type {Violation[]} */
const violations = [];

/**
 * @param {string} file
 * @param {number} line
 * @param {string} rule
 * @param {string} detail
 */
function report(file, line, rule, detail) {
  violations.push({ file, line, rule, detail });
}

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
 * @param {string} text
 * @returns {number[]} offset at which each line starts
 */
function lineStarts(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

/**
 * @param {number[]} starts
 * @param {number} offset
 * @returns {number} 1-based line number
 */
function lineOf(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

/**
 * @param {string} file
 * @param {string} text
 * @param {RegExp} pattern global pattern
 * @param {string} rule
 * @param {string} detail
 */
function scanPattern(file, text, pattern, rule, detail) {
  const starts = lineStarts(text);
  for (const match of text.matchAll(pattern)) {
    report(file, lineOf(starts, match.index ?? 0), rule, detail);
  }
}

/**
 * Blanks out inline code spans so that Markdown may mention a forbidden word as a literal.
 * @param {string} text
 * @returns {string} same length as the input
 */
function maskInlineCode(text) {
  return text.replace(/`[^`\n]*`/g, (span) => ' '.repeat(span.length));
}

/**
 * @param {string} absolute
 * @returns {boolean}
 */
function isFile(absolute) {
  try {
    return fs.statSync(absolute).isFile();
  } catch {
    return false;
  }
}

/**
 * @param {string} relDirectory
 * @param {string[]} out
 */
function collectDirectory(relDirectory, out) {
  const absolute = path.join(ROOT, relDirectory);
  if (!fs.existsSync(absolute)) return;
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    if (SKIPPED_NAMES.has(entry.name) || SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const rel = `${relDirectory}/${entry.name}`;
    if (SKIPPED_PATHS.has(rel)) continue;
    if (entry.isSymbolicLink()) {
      report(rel, 1, 'no-symlinks', 'symbolic links are not allowed in the scanned tree');
    } else if (entry.isDirectory()) {
      collectDirectory(rel, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
}

/**
 * @param {string[]} out
 */
function collectRootFiles(out) {
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (SKIPPED_NAMES.has(entry.name)) continue;
    if (entry.isSymbolicLink()) {
      report(entry.name, 1, 'no-symlinks', 'symbolic links are not allowed in the scanned tree');
    } else if (entry.isFile()) {
      out.push(entry.name);
    }
  }
}

/**
 * @param {string} file
 * @param {string} text
 * @param {string} extension
 */
function checkLayout(file, text, extension) {
  const starts = lineStarts(text);
  const carriage = text.indexOf('\r');
  if (carriage !== -1) {
    report(file, lineOf(starts, carriage), 'line-endings', 'CR characters found; use LF line endings only');
  }
  if (text.length > 0 && !text.endsWith('\n')) {
    report(file, starts.length, 'final-newline', 'file must end with a newline');
  }
  text.split('\n').forEach((line, index) => {
    if (/[ \t]$/.test(line)) report(file, index + 1, 'trailing-whitespace', 'remove trailing spaces or tabs');
    if (TAB_CHECKED_EXTENSIONS.has(extension) && line.includes('\t')) {
      report(file, index + 1, 'no-tabs', 'indent with spaces, not tab characters');
    }
  });
}

/**
 * @param {string} file
 * @param {string} text
 * @param {string} extension
 */
function checkMarkers(file, text, extension) {
  const scanned = extension === '.md' ? maskInlineCode(text) : text;
  scanPattern(file, scanned, UNFINISHED_MARKER, 'unfinished-marker',
    'TODO/FIXME/XXX markers are not allowed; finish the work or remove the marker');
}

/**
 * @param {string} file
 * @param {string} text
 */
function checkSourceModule(file, text) {
  if (text.split('\n', 1)[0] !== '// @ts-check') {
    report(file, 1, 'ts-check-header', 'backend modules must begin with // @ts-check');
  }
  for (const rule of SOURCE_PATTERNS) scanPattern(file, text, rule.pattern, rule.rule, rule.detail);
  if (/child_process/.test(text)) {
    scanPattern(file, text, CHILD_PROCESS_METHOD_EXEC, 'no-exec',
      'child_process exec() runs a command through a shell; use execFile or spawn with an argument array');
  }
}

/**
 * @param {string} file
 * @param {string} text
 */
function checkBrowserModule(file, text) {
  for (const rule of BROWSER_PATTERNS) scanPattern(file, text, rule.pattern, rule.rule, rule.detail);
}

/**
 * @param {string} file
 * @param {string} text
 */
function checkHtml(file, text) {
  const starts = lineStarts(text);
  for (const match of text.matchAll(SCRIPT_TAG)) {
    if (!/\ssrc\s*=/i.test(match[0])) {
      report(file, lineOf(starts, match.index ?? 0), 'no-inline-script',
        'inline <script> blocks are forbidden; load a module with src=');
    }
  }
  for (const match of text.matchAll(ELEMENT_TAG)) {
    const attribute = EVENT_ATTRIBUTE.exec(match[0]);
    if (attribute) {
      const name = attribute[0].trim().replace(/\s*=$/, '');
      report(file, lineOf(starts, match.index ?? 0), 'no-inline-handler',
        `inline event handler ${name} is forbidden; attach listeners with addEventListener`);
    }
  }
}

/**
 * @param {string} file
 * @param {string} text
 */
function checkJson(file, text) {
  try {
    JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const position = /position (\d+)/.exec(message);
    const line = position ? lineOf(lineStarts(text), Number(position[1])) : 1;
    report(file, line, 'json-parse', message.split('\n')[0]);
  }
}

/**
 * @param {string} file
 * @param {string} text
 */
function checkRelativeImports(file, text) {
  const starts = lineStarts(text);
  const directory = path.dirname(path.join(ROOT, file));
  for (const match of text.matchAll(RELATIVE_IMPORT)) {
    const specifier = match[1];
    if (!isFile(path.resolve(directory, specifier))) {
      report(file, lineOf(starts, match.index ?? 0), 'unresolved-import', `${specifier} does not resolve to a file`);
    }
  }
}

/**
 * @param {string} file
 */
function checkSyntax(file) {
  const result = spawnSync(process.execPath, ['--check', path.join(ROOT, file)], { encoding: 'utf8' });
  if (result.error) {
    report(file, 1, 'js-syntax', `node --check could not run: ${result.error.message}`);
    return;
  }
  if (result.status !== 0) {
    const lines = (result.stderr || '').split('\n');
    const location = /:(\d+)\s*$/.exec(lines[0] || '');
    const reason = lines.find((line) => /^\w*Error\b/.test(line)) || 'syntax error';
    report(file, location ? Number(location[1]) : 1, 'js-syntax', reason.trim());
  }
}

/** @type {string[]} */
const files = [];
collectRootFiles(files);
for (const directory of SCAN_DIRECTORIES) collectDirectory(directory, files);
files.sort(byCodeUnit);

for (const file of files) {
  const buffer = fs.readFileSync(path.join(ROOT, file));
  if (buffer.length > MAX_FILE_BYTES) {
    report(file, 1, 'file-size', `${buffer.length} bytes exceeds the 300 KiB limit`);
  }
  const extension = path.extname(file);
  if (BINARY_EXTENSIONS.has(extension) || buffer.subarray(0, 8000).includes(0)) continue;

  const text = buffer.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buffer)) report(file, 1, 'utf8', 'file is not valid UTF-8');
  checkLayout(file, text, extension);

  if (file !== SELF) {
    checkMarkers(file, text, extension);
    if (file.startsWith('src/') && extension === '.mjs') checkSourceModule(file, text);
    if (file.startsWith('public/') && extension === '.js') checkBrowserModule(file, text);
    if (file.startsWith('public/') && extension === '.html') checkHtml(file, text);
  }
  if (JSON_EXTENSIONS.has(extension)) checkJson(file, text);
  if (MODULE_EXTENSIONS.has(extension)) {
    checkRelativeImports(file, text);
    if (SYNTAX_DIRECTORIES.some((directory) => file.startsWith(directory))) checkSyntax(file);
  }
}

violations.sort((a, b) => byCodeUnit(a.file, b.file) || a.line - b.line || byCodeUnit(a.rule, b.rule));
if (violations.length > 0) {
  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line}: ${violation.rule}: ${violation.detail}`);
  }
  console.error(`CHECK_FAILED files=${files.length} violations=${violations.length}`);
  process.exitCode = 1;
} else {
  console.log(`CHECK_OK files=${files.length} violations=0`);
}
