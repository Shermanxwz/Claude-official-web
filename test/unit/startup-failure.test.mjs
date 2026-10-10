/**
 * Startup failure texts: the sentence shown when the engine refuses to start, chosen by the runtime's
 * startup_failure_reason (STARTUP_FAILURE_REASONS and startupFailureText in public/js/api.js). The English and Chinese
 * catalogs must define the same keys, with the same placeholders.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { STARTUP_FAILURE_REASONS, startupFailureText } from '../../public/js/api.js';
import { setLocale, t } from '../../public/js/i18n.js';
import '../../public/js/locales/en.cards.js';
import '../../public/js/locales/zh-CN.cards.js';

const CATALOG_EN = new URL('../../public/js/locales/en.cards.js', import.meta.url);
const CATALOG_ZH = new URL('../../public/js/locales/zh-CN.cards.js', import.meta.url);
const PREFIX = 'cards.startup.';

/** The reasons whose sentence shows the runtime's own first line. */
const WITH_MESSAGE = [
  'managed_settings_invalid', 'org_pin_api_key_conflict', 'org_pin_mismatch', 'provider_not_allowed',
  'worktree_resume_refused', 'unknown',
];

/** Message keys defined in a catalog source file. Every entry starts a line as `'key':`. */
function keysOf(url) {
  return new Set([...readFileSync(url, 'utf8').matchAll(/^\s*'([^']+)'\s*:/gm)].map((match) => match[1]));
}

/** Runs `fn` with `locale` active, then restores English, so tests do not depend on each other's locale. */
function inLocale(locale, fn) {
  setLocale(locale);
  try {
    return fn();
  } finally {
    setLocale('en');
  }
}

/** The startup text for a reason and a first line, in the given locale. */
function textFor(locale, reason, message) {
  return inLocale(locale, () => startupFailureText(reason, message, t));
}

/** The catalog text for one `cards.startup.*` key, in the given locale. */
function catalogText(locale, reason) {
  return inLocale(locale, () => t(`${PREFIX}${reason}`));
}

describe('startupFailureText', () => {
  it('returns null when there is no reason, so the caller shows its generic text', () => {
    for (const reason of [undefined, null, '', 42]) {
      assert.equal(startupFailureText(reason, 'first line', t), null);
    }
  });

  it('gives a listed reason its own sentence and does not append the runtime line', () => {
    assert.equal(textFor('en', 'cwd_unavailable', 'ENOENT: /home/u/project'),
      'The project folder was moved, deleted or cannot be read.');
    assert.equal(textFor('zh-CN', 'cwd_unavailable', 'ENOENT: /home/u/project'), '项目文件夹已被移动、删除或无法读取。');
  });

  it('puts the runtime line into the reasons whose sentence has a {message} placeholder', () => {
    assert.equal(textFor('en', 'org_pin_mismatch', 'pin differs'),
      'Your organization’s managed settings do not allow this setup: pin differs');
    assert.equal(textFor('zh-CN', 'worktree_resume_refused', 'dirty index'),
      '会话的工作树没有通过安全检查：dirty index');
  });

  it('uses the same sentence for the two sign-in reasons and for the two settings reasons', () => {
    assert.equal(textFor('en', 'org_config_refused', 'x'), textFor('en', 'gateway_signin_required', 'x'));
    assert.equal(textFor('en', 'org_config_required_unavailable', 'x'),
      textFor('en', 'remote_settings_required_unavailable', 'x'));
  });

  it('gives an unknown reason the generic refusal with the runtime line, in each language', () => {
    assert.equal(textFor('en', 'quota_exhausted', 'Out of quota'), 'Claude Code refused to start: Out of quota');
    assert.equal(textFor('zh-CN', 'quota_exhausted', 'Out of quota'), 'Claude Code 拒绝启动：Out of quota');
    assert.equal(textFor('en', 'quota_exhausted', '  padded  '), 'Claude Code refused to start: padded');
  });

  it('has nothing to show for an unknown reason without a runtime line, so the caller falls back', () => {
    assert.equal(textFor('en', 'quota_exhausted', '   '), null);
    assert.equal(textFor('en', 'quota_exhausted', undefined), null);
  });
});

describe('the startup catalogs', () => {
  const listed = [...STARTUP_FAILURE_REASONS, 'unknown'];

  it('list each reason once', () => {
    assert.equal(new Set(STARTUP_FAILURE_REASONS).size, STARTUP_FAILURE_REASONS.length);
  });

  it('define every listed reason and the unknown fallback, and nothing else, in both languages', () => {
    for (const url of [CATALOG_EN, CATALOG_ZH]) {
      const defined = [...keysOf(url)].filter((key) => key.startsWith(PREFIX))
        .map((key) => key.slice(PREFIX.length));
      assert.deepEqual(defined.sort(), [...listed].sort(), url.pathname);
    }
  });

  it('give each reason a sentence in both languages, with the same {placeholders}', () => {
    const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).join(',');
    for (const reason of listed) {
      const english = catalogText('en', reason);
      const chinese = catalogText('zh-CN', reason);
      assert.notEqual(english, `${PREFIX}${reason}`, `en is missing ${reason}`);
      assert.notEqual(chinese, `${PREFIX}${reason}`, `zh-CN is missing ${reason}`);
      assert.equal(placeholders(chinese), placeholders(english), reason);
      assert.equal(english.includes('{message}'), WITH_MESSAGE.includes(reason), `{message} in ${reason}`);
    }
  });

  it('define the same cards.* keys in English and Chinese', () => {
    const en = keysOf(CATALOG_EN);
    const zh = keysOf(CATALOG_ZH);
    assert.deepEqual([...en].filter((key) => !zh.has(key)).sort(), []);
    assert.deepEqual([...zh].filter((key) => !en.has(key)).sort(), []);
  });
});
