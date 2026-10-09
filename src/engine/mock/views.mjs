// @ts-check
/**
 * Builders of the runtime views the mock answers with: the data behind the terminal's /status, /permissions, /hooks,
 * /config, /memory, /skills, /sandbox, /plan, /chrome, /export and the @ file index. They take plain data, so the query
 * only gathers what each screen needs, and every shape follows what Claude Code 2.1.295 returns.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * The hook events the runtime's catalog lists, with the summaries the /hooks screen shows.
 * @type {ReadonlyArray<{name: string, summary: string, supportsMatcher: boolean}>}
 */
export const EVENT_CATALOG = Object.freeze([
  { name: 'PreToolUse', summary: 'Before tool execution', supportsMatcher: true },
  { name: 'PostToolUse', summary: 'After tool execution', supportsMatcher: true },
  { name: 'Notification', summary: 'When Claude Code sends a notification', supportsMatcher: true },
  { name: 'UserPromptSubmit', summary: 'When the user submits a prompt', supportsMatcher: false },
  { name: 'SessionStart', summary: 'When a session starts or resumes', supportsMatcher: true },
  { name: 'SessionEnd', summary: 'When a session ends', supportsMatcher: false },
  { name: 'Stop', summary: 'Right before Claude concludes its response', supportsMatcher: false },
  { name: 'SubagentStop', summary: 'When a subagent task finishes', supportsMatcher: false },
  { name: 'PreCompact', summary: 'Before the conversation is compacted', supportsMatcher: true },
]);

/** Largest number of file suggestions one answer carries. */
const MAX_SUGGESTIONS = 100;
/** Largest number of directory entries the file index walks for one answer. */
const MAX_SCANNED_ENTRIES = 5000;
/** Directories the file index never enters. */
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules']);

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function stringsOf(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

/**
 * @param {unknown} content a message's content: a string, or content blocks
 * @returns {string} the text of the content; empty when it has none
 */
function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/**
 * One rule row. A Bash prefix rule carries the plain-language reading the terminal shows under it.
 * @param {'allow'|'ask'|'deny'} behavior
 * @param {string} rule
 */
function ruleRow(behavior, rule) {
  const prefix = /^Bash\((.+):\*\)$/.exec(rule);
  return {
    behavior,
    source: 'projectSettings',
    rule,
    ...(prefix ? { description: { prefix: 'Any Bash command starting with ', emphasis: prefix[1] } } : {}),
    editability: 'persistent',
  };
}

/**
 * The permission rules of the session's settings, as /permissions lists them. Project allow rules count only in a
 * folder Claude Code trusts: without the trust record the runtime ignores them. Ask and deny rules always apply.
 * @param {{fileSettings: Record<string, unknown>, trusted: boolean, cwd: string, additionalDirectories: string[]}} args
 */
export function permissionRulesOf({ fileSettings, trusted, cwd, additionalDirectories }) {
  const permissions = isRecord(fileSettings.permissions) ? fileSettings.permissions : {};
  return {
    rules: [
      ...(trusted ? stringsOf(permissions.allow).map((rule) => ruleRow('allow', rule)) : []),
      ...stringsOf(permissions.ask).map((rule) => ruleRow('ask', rule)),
      ...stringsOf(permissions.deny).map((rule) => ruleRow('deny', rule)),
    ],
    workspaceDirectories: additionalDirectories.map((path) => ({ path, source: 'session' })),
    originalCwd: cwd,
    managedOnly: false,
  };
}

/**
 * The hooks of the settings, as /hooks lists them: one row per command hook, the events that have hooks, and the
 * catalog.
 * @param {Record<string, unknown>} fileSettings
 */
export function hooksListingOf(fileSettings) {
  const config = isRecord(fileSettings.hooks) ? fileSettings.hooks : {};
  /** @type {Array<Record<string, any>>} */
  const hooks = [];
  for (const [event, groups] of Object.entries(config)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
      const matcher = typeof group.matcher === 'string' ? group.matcher : '';
      for (const hook of group.hooks) {
        if (!isRecord(hook) || hook.type !== 'command' || typeof hook.command !== 'string') continue;
        const timeout = Number.isInteger(hook.timeout) ? hook.timeout : 60;
        hooks.push({
          event,
          matcher,
          source: 'projectSettings',
          sourceLabel: 'Project settings (.claude/settings.json)',
          type: 'command',
          displayText: hook.command,
          commandText: hook.command,
          contentLabel: 'Command',
          timeout,
          editable: { matcher, config: { type: 'command', command: hook.command, timeout } },
        });
      }
    }
  }
  const events = [...new Set(hooks.map((hook) => hook.event))].map((name) => {
    const known = EVENT_CATALOG.find((entry) => entry.name === name);
    return {
      name,
      summary: known?.summary ?? name,
      supportsMatcher: known?.supportsMatcher ?? true,
      hookCount: hooks.filter((hook) => hook.event === name).length,
    };
  });
  return {
    events,
    hooks,
    eventCatalog: EVENT_CATALOG.map((entry) => ({ ...entry })),
    policy: {},
  };
}

/**
 * The settings cascade of the session, as /config reads it: the effective settings, the sources they came from and the
 * values the session applies.
 * @param {{fileSettings: Record<string, unknown>, settingSources: string[], model: string,
 *   effort: string|null}} args
 */
export function settingsOf({ fileSettings, settingSources, model, effort }) {
  return {
    effective: { ...fileSettings },
    sources: settingSources.length === 0 ? [] : [{ source: 'projectSettings', settings: { ...fileSettings } }],
    applied: {
      model,
      effort: effort ?? 'medium',
      advisor: null,
      ultracode: false,
      ultracodeRequested: false,
      ultracodeAvailable: false,
    },
  };
}

/**
 * @param {string} path
 * @returns {boolean}
 */
function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The instruction files /memory lists: the project's CLAUDE.md and the user's ~/.claude/CLAUDE.md. The mock never reads
 * the user's own folder, so the user file is reported as missing whatever the machine holds.
 * @param {{cwd: string, home: string}} args
 */
export function memoryDialogOf({ cwd, home }) {
  const project = join(cwd, 'CLAUDE.md');
  const user = join(home, '.claude', 'CLAUDE.md');
  return {
    files: [
      {
        kind: 'project',
        path: project,
        label: 'Project instructions',
        description: 'Saved in ./CLAUDE.md',
        exists: isFile(project),
      },
      {
        kind: 'user',
        path: user,
        label: 'User instructions',
        description: 'Saved in ~/.claude/CLAUDE.md',
        exists: false,
      },
    ],
    folders: [],
    auto_memory: {
      enabled: false,
      toggleable: false,
      status: "off — can't be turned on here; use a session started outside Claude Code",
    },
    auto_dream: { shown: false, enabled: false, toggleable: false, status: 'off while auto-memory is off', detail: '' },
  };
}

/**
 * The skills /skills lists.
 * @param {Array<{name: string, description: string}>} skills
 */
export function skillsDialogOf(skills) {
  return {
    skills: skills.map((skill) => ({ name: skill.name, display_name: skill.name, description: skill.description })),
  };
}

/**
 * The sandbox state /sandbox shows: not enabled, and the runtime's dependencies are missing.
 */
export function sandboxDialogOf() {
  return {
    supported: true,
    locked: false,
    overrides_locked: false,
    enabled: false,
    enabled_in_settings: false,
    mode: 'disabled',
    auto_allow_available: true,
    no_sandbox_allowed: true,
    unsandboxed_fallback: true,
    dependencies: { errors: ['bubblewrap (bwrap) not installed', 'socat not installed'], warnings: [] },
    excluded_commands: [],
    restrictions: {
      fs_deny_read: [],
      fs_allow_read: [],
      fs_allow_write: [],
      fs_deny_write: [],
      network_allowed_domains: [],
      network_denied_domains: [],
      network_managed: false,
      unix_sockets: [],
      allow_all_unix_sockets: false,
      ignored_glob_patterns: [],
    },
  };
}

/**
 * The Claude in Chrome status. The mock has no browser: the status follows whether the session starts with --chrome.
 * @param {boolean} enabled
 */
export function chromeDialogOf(enabled) {
  return {
    enabled,
    supported: true,
    extensionInstalled: enabled,
    connected: enabled,
    browsers: ['Google Chrome'],
    selectedBrowser: enabled ? 'Google Chrome' : null,
  };
}

/**
 * The /status screen. Optional rows appear only when the session has the setting.
 * @param {{sessionId: string, cwd: string, model: string, login: string, agent: string|null,
 *   additionalDirectories: string[], settingSources: string[], version: string}} args
 */
export function statusOf({ sessionId, cwd, model, login, agent, additionalDirectories, settingSources, version }) {
  const sources = settingSources.length === 0
    ? 'None'
    : (settingSources.includes('project') ? 'Shared project settings' : 'User settings only');
  return {
    sections: [
      {
        title: 'Session',
        rows: [
          { label: 'Version', value: version },
          { label: 'Session ID', value: sessionId },
          { label: 'Session kind', value: 'interactive' },
          { label: 'cwd', value: cwd },
          { label: 'Login method', value: login },
          { label: 'Anthropic base URL', value: 'https://api.anthropic.com' },
          ...(agent === null ? [] : [{ label: 'Agent', value: agent }]),
          ...(additionalDirectories.length === 0
            ? []
            : [{ label: 'Additional directories', value: additionalDirectories.join(', ') }]),
        ],
      },
      {
        title: 'Environment',
        rows: [
          { label: 'Model', value: model },
          { label: 'Setting sources', value: sources },
          { label: 'Auto mode server', value: 'Disabled' },
        ],
      },
    ],
  };
}

/**
 * The conversation as the terminal's /export writes it: each prompt as quoted lines, each answer's text blocks as they
 * are, separated by blank lines. Tool results and system entries are left out.
 * @param {Array<{type: string, parent_tool_use_id: string|null, message: any}>} transcript
 * @returns {string}
 */
export function exportTextOf(transcript) {
  /** @type {string[]} */
  const parts = [];
  for (const entry of transcript) {
    if (entry.parent_tool_use_id !== null) continue;
    if (entry.type === 'user') {
      const text = textOfContent(entry.message?.content);
      if (text !== '') parts.push(text.split('\n').map((line) => `> ${line}`).join('\n'));
    } else if (entry.type === 'assistant') {
      const blocks = Array.isArray(entry.message?.content) ? entry.message.content : [];
      for (const block of blocks) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
          parts.push(block.text);
        }
      }
    }
  }
  return parts.length === 0 ? '' : `${parts.join('\n\n')}\n`;
}

/**
 * The default file name of an export: conversation-<YYYY-MM-DD-HHmmss>.txt in local time.
 * @param {Date} now
 * @returns {string}
 */
export function exportFilenameOf(now) {
  const pad = (/** @type {number} */ value) => String(value).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `conversation-${date}-${time}.txt`;
}

/**
 * The @ index answer: files and directories under `cwd` whose relative path contains the query, ignoring case.
 * Directories end in a slash. An empty query lists the top-level entries. `.git` and `node_modules` are never entered.
 * @param {string} cwd
 * @param {string} query
 * @returns {Array<{path: string}>}
 */
export function fileSuggestionsOf(cwd, query) {
  const needle = query.toLowerCase();
  /** @type {Array<{path: string}>} */
  const found = [];
  /** @type {string[]} */
  const pending = [''];
  let scanned = 0;
  while (pending.length > 0 && scanned < MAX_SCANNED_ENTRIES && found.length < MAX_SUGGESTIONS) {
    const relativeDir = /** @type {string} */ (pending.shift());
    let entries;
    try {
      entries = readdirSync(join(cwd, relativeDir), { withFileTypes: true })
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      scanned += 1;
      if (scanned > MAX_SCANNED_ENTRIES) break;
      const rel = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
      const isDirectory = entry.isDirectory();
      if (needle === '' || rel.toLowerCase().includes(needle)) {
        found.push({ path: isDirectory ? `${rel}/` : rel });
      }
      if (isDirectory && needle !== '') pending.push(rel);
    }
  }
  return found.slice(0, MAX_SUGGESTIONS);
}

/**
 * Turns a glob of the rule syntax into a regular expression: `**` crosses directories, `*` and `?` do not.
 * @param {string} glob
 * @returns {RegExp}
 */
function globRegExp(glob) {
  const escape = (/** @type {string} */ text) => text.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const source = glob
    .split('**')
    .map((part) => part.split('*').map((piece) => piece.split('?').map(escape).join('[^/]')).join('[^/]*'))
    .join('.*');
  return new RegExp(`^${source}$`);
}

/**
 * Whether a `Read(...)` deny rule of the settings covers the file. A pattern that starts with ./ is relative to the
 * session's folder; any other pattern is matched against the absolute path.
 * @param {Record<string, unknown>} fileSettings
 * @param {string} cwd
 * @param {string} absPath
 * @returns {boolean}
 */
export function readDeniedBy(fileSettings, cwd, absPath) {
  const permissions = isRecord(fileSettings.permissions) ? fileSettings.permissions : {};
  for (const rule of stringsOf(permissions.deny)) {
    const match = /^Read\((.+)\)$/.exec(rule);
    if (!match) continue;
    const pattern = match[1];
    const underCwd = pattern.startsWith('./');
    const subject = underCwd ? relative(cwd, absPath).split(sep).join('/') : absPath;
    if (globRegExp(underCwd ? pattern.slice(2) : pattern).test(subject)) return true;
  }
  return false;
}
