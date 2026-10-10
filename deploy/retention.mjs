// @ts-check
/**
 * Keeps Claude Code's conversation transcripts. Claude Code deletes a transcript that has not been used for
 * cleanupPeriodDays, which is 30 days unless the user settings file sets it. scripts/install-linux.sh runs this script
 * on that settings file. It sets the period to RETENTION_DAYS when the file does not set one, and changes nothing else.
 *
 *   node deploy/retention.mjs <path of the settings file>
 *
 * Exit status: 0 when the file was created or changed, or already sets the period; 1 when the file was left alone
 * (invalid JSON, a top level that is not an object, a symbolic link, or an I/O error), with the reason on stderr.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Retention written when the settings file does not set one: about ten years, the figure Claude Code suggests. */
export const RETENTION_DAYS = 3650;

/**
 * @typedef {{outcome: 'created' | 'set', text: string} | {outcome: 'kept'} | {outcome: 'refused', reason: string}} Plan
 */

/**
 * @param {Record<string, unknown>} settings
 * @returns {string} the file content, indented the way Claude Code writes its settings
 */
function serialize(settings) {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/**
 * Decides what the settings file needs. It reads and writes nothing; the caller does.
 * @param {string | null} text the file's content, or null when the file does not exist
 * @returns {Plan}
 */
export function planRetention(text) {
  if (text === null) return { outcome: 'created', text: serialize({ cleanupPeriodDays: RETENTION_DAYS }) };
  let settings;
  try {
    settings = JSON.parse(text);
  } catch {
    return { outcome: 'refused', reason: 'it is not valid JSON' };
  }
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    return { outcome: 'refused', reason: 'its top level is not a JSON object' };
  }
  // A value the user set is never changed, whatever it is.
  if (Object.hasOwn(settings, 'cleanupPeriodDays')) return { outcome: 'kept' };
  return { outcome: 'set', text: serialize({ ...settings, cleanupPeriodDays: RETENTION_DAYS }) };
}

/**
 * @param {string} file
 * @returns {boolean} true when a symbolic link sits at `file`, dangling or not
 */
function isSymbolicLink(file) {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Writes `text` to `file` through a temporary file beside it, created with mode 0600 and renamed over the target. A
 * crash leaves the old file or the new one, never a part of either.
 * @param {string} file
 * @param {string} text
 */
function writeAtomically(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * Applies the retention setting to the settings file. A file that cannot be changed safely is left as it is.
 * @param {string} file absolute path of the settings file
 * @returns {Plan} what was done, or why nothing was
 */
export function applyRetention(file) {
  // A symbolic link is refused rather than replaced: a rename would turn the link into a plain file.
  if (isSymbolicLink(file)) return { outcome: 'refused', reason: 'it is a symbolic link' };
  const plan = planRetention(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
  if (plan.outcome === 'created' || plan.outcome === 'set') writeAtomically(file, plan.text);
  return plan;
}

/**
 * Command line: applies the retention setting to the file named by the only argument and reports what it did.
 * @param {string[]} args
 * @returns {number} exit status
 */
function main(args) {
  if (args.length !== 1) {
    console.error('usage: node deploy/retention.mjs <path of the settings file>');
    return 2;
  }
  const file = path.resolve(args[0]);
  let plan;
  try {
    plan = applyRetention(file);
  } catch (error) {
    console.error(`warning: ${file} was not changed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const retained = 'conversations are kept for about ten years.';
  switch (plan.outcome) {
    case 'created':
      console.log(`Created ${file} with cleanupPeriodDays ${RETENTION_DAYS}: ${retained}`);
      return 0;
    case 'set':
      console.log(`Set cleanupPeriodDays to ${RETENTION_DAYS} in ${file}: ${retained}`);
      return 0;
    case 'kept':
      console.log(`${file} already sets cleanupPeriodDays, so it was left unchanged.`);
      return 0;
    case 'refused':
      console.error(`warning: ${file} was not changed because ${plan.reason}. `
        + `To keep conversations for about ten years, add "cleanupPeriodDays": ${RETENTION_DAYS} to its `
        + 'top-level object by hand. Without it, Claude Code deletes conversations not used for 30 days.');
      return 1;
  }
}

// Runs only as the entry point, so that the tests can import the functions.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
