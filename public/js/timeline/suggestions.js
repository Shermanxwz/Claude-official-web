/**
 * Pure helpers for the "always allow" suggestions of a permission card: which suggestions start checked, how each one
 * reads, and which ones a click sends. No DOM access; importable in Node (see test/unit/timeline-model.test.mjs).
 *
 * A suggestion is one SDK PermissionUpdate: addRules / replaceRules / removeRules {rules, behavior, destination},
 * setMode {mode, destination}, addDirectories / removeDirectories {directories, destination}.
 */

import { truncateMiddle } from './format.js';

const TEXT_LIMIT = 160;
/** Static key maps, so every message key the card uses appears literally in this file. */
const BEHAVIOR_KEYS = new Map([
  ['allow', 'cards.request.suggestion.allow'],
  ['deny', 'cards.request.suggestion.deny'],
  ['ask', 'cards.request.suggestion.ask'],
]);
const DESTINATION_KEYS = new Map([
  ['session', 'cards.request.dest.session'],
  ['localSettings', 'cards.request.dest.localSettings'],
  ['projectSettings', 'cards.request.dest.projectSettings'],
  ['userSettings', 'cards.request.dest.userSettings'],
  ['cliArg', 'cards.request.dest.cliArg'],
]);
const MODE_KEYS = new Map([
  ['default', 'cards.request.plan.mode.default'],
  ['acceptEdits', 'cards.request.plan.mode.acceptEdits'],
  ['auto', 'cards.request.plan.mode.auto'],
]);

/** @param {unknown} value @returns {value is Record<string, any>} */
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Whether a suggestion starts checked: a rule that allows something, or a mode change for this session only (the one a
 * Write request offers). A directory grant, a mode change kept in settings and a deny rule start unchecked, so "always
 * allow" applies those only when the user ticks them.
 * @param {unknown} suggestion
 * @returns {boolean}
 */
export function isDefaultChecked(suggestion) {
  if (!isRecord(suggestion)) return false;
  if (suggestion.type === 'addRules' || suggestion.type === 'replaceRules') return suggestion.behavior === 'allow';
  return suggestion.type === 'setMode' && suggestion.destination === 'session';
}

/**
 * A permission rule as it is written in settings: "Bash(npm test:*)", or the tool name alone without content.
 * @param {unknown} rule
 * @returns {string} empty when the rule names no tool
 */
export function ruleText(rule) {
  if (!isRecord(rule) || typeof rule.toolName !== 'string' || !rule.toolName.trim()) return '';
  const tool = rule.toolName.trim();
  const content = typeof rule.ruleContent === 'string' ? rule.ruleContent.trim() : '';
  return content ? `${tool}(${content})` : tool;
}

/**
 * The text a suggestion shows: what it changes (title) and where the change is kept (meta).
 * @param {unknown} suggestion
 * @param {(key: string, vars?: Record<string, unknown>) => string} t
 * @returns {{title: string, meta: string}}
 */
export function describeSuggestion(suggestion, t) {
  if (!isRecord(suggestion)) return { title: t('cards.request.suggestion.other', { detail: '' }), meta: '' };
  const meta = destinationText(suggestion.destination, t);
  switch (suggestion.type) {
    case 'addRules': {
      const rules = rulesOf(suggestion);
      const key = BEHAVIOR_KEYS.get(suggestion.behavior);
      return { title: key ? t(key, { rules }) : t('cards.request.suggestion.other', { detail: rules }), meta };
    }
    case 'replaceRules':
      return { title: t('cards.request.suggestion.replace', { rules: rulesOf(suggestion) }), meta };
    case 'removeRules':
      return { title: t('cards.request.suggestion.remove', { rules: rulesOf(suggestion) }), meta };
    case 'addDirectories':
      return { title: t('cards.request.suggestion.directories', { dirs: directoriesOf(suggestion) }), meta };
    case 'removeDirectories':
      return { title: t('cards.request.suggestion.dirsRemove', { dirs: directoriesOf(suggestion) }), meta };
    case 'setMode': {
      const mode = typeof suggestion.mode === 'string' ? suggestion.mode : '';
      const key = MODE_KEYS.get(mode);
      return { title: t('cards.request.suggestion.mode', { mode: key ? t(key) : mode }), meta };
    }
    default:
      return { title: t('cards.request.suggestion.other', { detail: String(suggestion.type ?? '') }), meta };
  }
}

/**
 * The indexes of the checked suggestions, in order: the suggestionIndexes a permission answer sends.
 * @param {boolean[]} checks
 * @returns {number[]}
 */
export function checkedIndexes(checks) {
  return checks.flatMap((checked, index) => (checked ? [index] : []));
}

/** @param {Record<string, any>} suggestion @returns {string} */
function rulesOf(suggestion) {
  const rules = Array.isArray(suggestion.rules) ? suggestion.rules.map(ruleText).filter(Boolean) : [];
  return truncateMiddle(rules.join(', '), TEXT_LIMIT);
}

/** @param {Record<string, any>} suggestion @returns {string} */
function directoriesOf(suggestion) {
  const dirs = Array.isArray(suggestion.directories)
    ? suggestion.directories.filter((dir) => typeof dir === 'string' && dir)
    : [];
  return truncateMiddle(dirs.join(', '), TEXT_LIMIT);
}

/**
 * @param {unknown} destination
 * @param {(key: string, vars?: Record<string, unknown>) => string} t
 * @returns {string} empty when the destination is unknown
 */
function destinationText(destination, t) {
  const key = typeof destination === 'string' ? DESTINATION_KEYS.get(destination) : undefined;
  return key ? t('cards.request.destination', { where: t(key) }) : '';
}
