/**
 * Pending request cards: permission prompts, AskUserQuestion questions, ExitPlanMode plans and MCP elicitations.
 * Answers are posted to /api/sessions/:id/requests/:requestId (docs/PROTOCOL.md). A card leaves the timeline when the
 * gateway reports request_resolved. Text goes through textContent and Markdown through renderMarkdown().
 */
import { h, clear, icon } from '../dom.js';
import { errorText } from '../api.js';
import { getLocale } from '../i18n.js';
import { relativeTime } from './format.js';
import { isDefaultChecked, describeSuggestion, checkedIndexes } from './suggestions.js';
import { displayPath, isRecord } from './tools/summaries.js';
import { renderTool } from './tools/index.js';

const KINDS = Object.freeze(['permission', 'question', 'plan', 'elicitation']);
const PREVIEW_LIMIT = 4000;
const TEXT_LIMIT = 2000;
const SHORT_LIMIT = 500;
const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 12;
const MAX_FIELDS = 25;
const MAX_ENUM = 50;
const SHORTCUT_KEYS = Object.freeze(['1', '2', '3']);
const PLAN_MODES = Object.freeze(['default', 'acceptEdits', 'auto']);
const PATH_KEYS = new Set(['file_path', 'path', 'notebook_path']);
/**
 * Tool names that tools/index.js renders with a dedicated family (diff, command, search, plan...). Their permission
 * previews reuse those cards; every other name gets the key/value text. Keep in step with the FAMILIES table there.
 */
const RICH_TOOLS = new Set([
  'Bash', 'BashOutput', 'KillShell', 'KillBash', 'TaskStop', 'Monitor',
  'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'Agent', 'Task',
  'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'ExitPlanMode', 'EnterPlanMode',
]);
const GONE_CODES = new Set(['REQUEST_NOT_FOUND', 'SESSION_NOT_FOUND', 'SESSION_NOT_LIVE']);
const SKIP = Object.freeze({ skip: true });
const INVALID = Object.freeze({ invalid: true });

const KIND_ICONS = Object.freeze({ permission: 'shield', question: 'user', plan: 'list', elicitation: 'plug', unknown: 'alert' });
const KIND_LABELS = Object.freeze({
  permission: 'cards.request.kind.permission',
  question: 'cards.request.kind.question',
  plan: 'cards.request.kind.plan',
  elicitation: 'cards.request.kind.elicitation',
  unknown: 'cards.request.kind.unknown',
});
const PLAN_MODE_LABELS = Object.freeze({
  default: 'cards.request.plan.mode.default',
  acceptEdits: 'cards.request.plan.mode.acceptEdits',
  auto: 'cards.request.plan.mode.auto',
});

let cardCounter = 0;

/**
 * @typedef {(key: string, vars?: Record<string, string | number>) => string} Translate
 * @typedef {{
 *   api: { post: (path: string, body?: unknown) => Promise<unknown> },
 *   sessionId: string | null,
 *   t: Translate,
 *   renderMarkdown: (text: string) => HTMLElement,
 *   profile: string | null,
 *   toast: (message: string, level?: string) => void,
 *   cwd: string | null,
 * }} RequestContext
 * @typedef {{
 *   uid: string,
 *   kind: string,
 *   request: Record<string, any>,
 *   ctx: RequestContext,
 *   card: HTMLElement,
 *   titleEl: HTMLElement,
 *   bodyEl: HTMLElement,
 *   statusEl: HTMLElement,
 *   actionsEl: HTMLElement,
 *   endpoint: string | null,
 *   controls: HTMLElement[],
 *   keys: Map<string, {body: () => Record<string, unknown>, enabled?: () => boolean}> | null,
 *   focusTarget: HTMLElement | null,
 *   gate?: () => void,
 * }} RequestView
 */

/**
 * Builds the card for one pending request. Never throws: a payload that cannot be shown renders a read-only fallback.
 * @param {Record<string, any>} request PendingRequest (docs/PROTOCOL.md)
 * @param {RequestContext} ctx
 * @returns {HTMLElement}
 */
export function renderRequest(request, ctx) {
  const kind = KINDS.includes(request?.kind) ? request.kind : 'unknown';
  const view = createView(request, kind, ctx);
  try {
    const build = BUILDERS[kind];
    if (build) build(view, request);
    else buildUnsupported(view, request);
  } catch (error) {
    console.error('request card failed; showing the fallback', error);
    clear(view.bodyEl);
    clear(view.actionsEl);
    view.controls = [];
    view.keys = null;
    view.focusTarget = null;
    buildUnsupported(view, request);
  }
  if (ctx.profile === 'read') {
    setState(view, 'readonly');
    setStatus(view, ctx.t('cards.request.readOnly'), 'info');
  } else if (!view.endpoint) {
    setState(view, 'readonly');
    setStatus(view, ctx.t('cards.request.stale'), 'info');
  } else if (view.keys) {
    bindShortcuts(view);
    requestAnimationFrame(() => focusIfIdle(view));
  }
  return view.card;
}

/**
 * @param {Record<string, any>} request
 * @param {string} kind
 * @param {RequestContext} ctx
 * @returns {RequestView}
 */
function createView(request, kind, ctx) {
  const uid = `req${++cardCounter}`;
  const titleEl = h('h3', { class: 'request-title', attrs: { id: `${uid}-title` } });
  const bodyEl = h('div', { class: 'request-body' });
  const statusEl = h('p', { class: 'request-status', attrs: { role: 'status', hidden: true } });
  const actionsEl = h('div', { class: 'request-actions' });
  const millis = typeof request?.createdAt === 'number' ? request.createdAt : Number.NaN;
  const created = new Date(millis);
  const time = Number.isNaN(created.getTime()) ? null : h('time', {
    class: 'request-time',
    attrs: { datetime: created.toISOString() },
    text: relativeTime(created, getLocale()),
  });
  const head = h('header', { class: 'request-head' },
    h('span', { class: 'request-badge' }, icon(KIND_ICONS[kind]), h('span', { text: ctx.t(KIND_LABELS[kind]) })),
    textOf(request?.agentId) ? h('span', { class: 'request-chip', text: ctx.t('cards.request.fromAgent') }) : null,
    time);
  const card = h('section', {
    class: ['request-card', `is-${kind}`],
    dataset: { kind, state: 'ready', requestId: textOf(request?.id) || null },
    attrs: { 'aria-labelledby': `${uid}-title` },
  }, head, titleEl, bodyEl, statusEl, actionsEl);
  return {
    uid,
    kind,
    request,
    ctx,
    card,
    titleEl,
    bodyEl,
    statusEl,
    actionsEl,
    endpoint: endpointOf(request, ctx.sessionId),
    controls: [],
    keys: null,
    focusTarget: null,
  };
}

/** @type {Record<string, (view: RequestView, request: Record<string, any>) => void>} */
const BUILDERS = {
  permission: buildPermission,
  question: buildQuestion,
  plan: buildPlan,
  elicitation: buildElicitation,
};

// -------------------------------------------------------------------------------------------------------------------
// Permission

/** @param {RequestView} view @param {Record<string, any>} request */
function buildPermission(view, request) {
  const { t, cwd } = view.ctx;
  const input = isRecord(request.input) ? request.input : {};
  const tool = textOf(request.toolName) || t('cards.request.unknownTool');
  setTitle(view, textOf(request.title) || textOf(request.displayName) || t('cards.request.permission.title', { tool }));

  const details = [];
  const description = textOf(request.description);
  if (description) details.push(h('p', { class: 'request-text', text: description }));
  const reason = textOf(request.decisionReason);
  if (reason) details.push(h('p', { class: 'request-reason' }, icon('info'), h('span', { text: reason })));
  const blocked = textOf(request.blockedPath);
  if (blocked) details.push(keyValue(t('cards.request.blockedPath'), displayPath(blocked, cwd), blocked));
  const server = textOf(request.mcpServer?.name);
  if (server) details.push(keyValue(t('cards.request.server'), server));
  const preview = toolPreview(view, request, input);
  if (preview) details.push(preview);
  const denyReason = h('input', {
    class: 'input request-deny-input',
    attrs: {
      type: 'text',
      maxlength: TEXT_LIMIT,
      autocomplete: 'off',
      placeholder: t('cards.request.denyPlaceholder'),
      'aria-label': t('cards.request.denyReason'),
    },
  });
  const suggestions = Array.isArray(request.suggestions) ? request.suggestions : [];
  // "Always allow" applies the checked suggestions: allow rules and session-only mode switches start checked; directory
  // grants, other mode changes and deny or ask rules start unchecked.
  const always = suggestions.length > 0 && request.suppressAlwaysAllowRule !== true ? suggestionList(view, suggestions) : null;
  if (always) details.push(always.element);
  details.push(h('label', { class: 'field request-deny-field' },
    h('span', { class: 'field-label', text: t('cards.request.denyReason') }),
    denyReason));
  view.bodyEl.append(...details);
  view.controls.push(denyReason);

  /** @type {Array<{kind: 'primary'|'secondary', label: string, title: string|null, enabled?: () => boolean, body: () => Record<string, unknown>}>} */
  const options = [{
    kind: 'primary',
    label: t('cards.request.allow'),
    title: null,
    body: () => ({ decision: 'allow' }),
  }];
  if (always) {
    options.push({
      kind: 'secondary',
      label: t('cards.request.alwaysAllow'),
      title: null,
      enabled: () => always.checked().length > 0,
      body: () => ({ decision: 'allow_always', suggestionIndexes: always.checked() }),
    });
  }
  options.push({
    kind: 'secondary',
    label: t('cards.request.deny'),
    title: null,
    body: () => {
      const message = denyReason.value.trim().slice(0, TEXT_LIMIT);
      return message ? { decision: 'deny', message } : { decision: 'deny' };
    },
  });

  const buttons = options.map((option, index) => actionButton(view, {
    kind: option.kind,
    label: option.label,
    title: option.title,
    hint: h('kbd', { class: 'request-key', attrs: { 'aria-hidden': 'true' }, text: SHORTCUT_KEYS[index] }),
    onClick: () => submit(view, option.body()),
  }));
  view.keys = new Map(options.slice(0, SHORTCUT_KEYS.length).map((option, index) => [SHORTCUT_KEYS[index], option]));
  view.focusTarget = request.defaultToNo === true ? buttons[buttons.length - 1] : buttons[0];
  // The button needs one checked suggestion, and its tooltip names the checked ones. setState re-applies this rule.
  const alwaysButton = always ? buttons[1] : null;
  view.gate = () => {
    if (!always || !alwaysButton) return;
    alwaysButton.disabled = view.card.dataset.state !== 'ready' || always.checked().length === 0;
    alwaysButton.title = always.title();
  };
  view.gate();
}

/**
 * The tool call as the tool's own card shows it (a diff for edits, the command for Bash), or key/value text for tools
 * without a dedicated renderer.
 * @param {RequestView} view
 * @param {Record<string, any>} request
 * @param {Record<string, unknown>} input
 * @returns {HTMLElement|null}
 */
function toolPreview(view, request, input) {
  const name = textOf(request.toolName);
  if (name && (RICH_TOOLS.has(name) || name.startsWith('mcp__'))) {
    try {
      const card = renderTool({
        id: textOf(request.toolUseId) || undefined,
        name,
        input,
        running: false,
        pendingRequestId: textOf(request.id),
      }, {
        t: view.ctx.t,
        renderMarkdown: view.ctx.renderMarkdown,
        sessionId: view.ctx.sessionId ?? null,
        cwd: view.ctx.cwd ?? null,
        renderChildren: () => h('div', { class: 'sub-entries' }),
        open: true,
      });
      return h('div', { class: 'request-tool' }, card);
    } catch (error) {
      console.error('permission preview fell back to key/value text', error);
    }
  }
  const text = previewOf(input, view.ctx.cwd ?? null);
  return text ? h('pre', { class: 'request-input', text }) : null;
}

/**
 * One checkbox per "always allow" suggestion, with what it changes and where the change is kept. Only the checked ones
 * are sent with the answer.
 * @param {RequestView} view
 * @param {unknown[]} suggestions
 * @returns {{element: HTMLElement, checked: () => number[], title: () => string}}
 */
function suggestionList(view, suggestions) {
  const { t } = view.ctx;
  const described = suggestions.map((suggestion) => describeSuggestion(suggestion, t));
  const boxes = suggestions.map((suggestion) => {
    const box = h('input', {
      class: 'request-suggestion-check',
      attrs: { type: 'checkbox' },
      on: { change: () => view.gate?.() },
    });
    box.checked = isDefaultChecked(suggestion);
    view.controls.push(box);
    return box;
  });
  const checked = () => checkedIndexes(boxes.map((box) => box.checked));
  const element = h('fieldset', { class: 'request-suggestions' },
    h('legend', { class: 'request-suggestions-title', text: t('cards.request.suggestions') }),
    boxes.map((box, index) => h('label', { class: 'request-suggestion' },
      box,
      h('span', { class: 'request-suggestion-body' },
        h('span', { class: 'request-suggestion-title', text: described[index].title }),
        described[index].meta ? h('span', { class: 'request-suggestion-meta', text: described[index].meta }) : null))));
  return {
    element,
    checked,
    title: () => checked().map((index) => described[index].title).join('; '),
  };
}

/**
 * Shows the tool input as readable text: the command first, then each field, paths shown relative to the cwd.
 * @param {Record<string, unknown>} input
 * @param {string|null} cwd
 * @returns {string}
 */
function previewOf(input, cwd) {
  const parts = [];
  const command = textOf(input.command);
  if (command) parts.push(command);
  for (const [key, value] of Object.entries(input)) {
    if (key === 'command') continue;
    if (typeof value === 'string') {
      if (value.trim()) parts.push(`${key}: ${PATH_KEYS.has(key) ? displayPath(value, cwd) : value}`);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      parts.push(`${key}: ${value}`);
    } else if (value !== null && typeof value === 'object') {
      parts.push(`${key}: ${jsonOf(value)}`);
    }
  }
  return clip(parts.join('\n'), PREVIEW_LIMIT);
}

// -------------------------------------------------------------------------------------------------------------------
// Questions (AskUserQuestion)

/** @param {RequestView} view @param {Record<string, any>} request */
function buildQuestion(view, request) {
  const { t } = view.ctx;
  setTitle(view, textOf(request.title) || t('cards.request.question.title'));
  const { questions, complete } = parseQuestions(request.input);
  if (!complete) {
    view.bodyEl.append(
      h('p', { class: 'request-text', text: t('cards.request.question.unsupported') }),
      h('pre', { class: 'request-input', text: clip(jsonOf(request.input), PREVIEW_LIMIT) }));
    actionButton(view, {
      kind: 'secondary',
      label: t('cards.request.decline'),
      onClick: () => submit(view, { decline: true }),
    });
    return;
  }
  const groups = questions.map((question, index) => questionGroup(view, question, `${view.uid}-q${index}`));
  view.bodyEl.append(...groups.map((group) => group.node));
  actionButton(view, {
    kind: 'primary',
    label: t('cards.request.question.submit'),
    onClick: () => {
      const answers = collectAnswers(groups);
      if (!answers) {
        setStatus(view, t('cards.request.question.required'), 'error');
        return;
      }
      submit(view, { answers });
    },
  });
  actionButton(view, {
    kind: 'secondary',
    label: t('cards.request.decline'),
    onClick: () => submit(view, { decline: true }),
  });
}

/**
 * @param {unknown} input
 * @returns {{questions: Array<{question: string, header: string, multiSelect: boolean, options: Array<{label: string, description: string}>}>, complete: boolean}}
 */
function parseQuestions(input) {
  const raw = isRecord(input) && Array.isArray(input.questions) ? input.questions : [];
  const questions = [];
  let complete = raw.length > 0 && raw.length <= MAX_QUESTIONS;
  for (const entry of raw.slice(0, MAX_QUESTIONS)) {
    const record = isRecord(entry) ? entry : null;
    const question = record ? textOf(record.question) : '';
    const options = record && Array.isArray(record.options)
      ? record.options
        .filter(isRecord)
        .map((option) => ({ label: textOf(option.label), description: textOf(option.description) }))
        .filter((option) => option.label !== '')
        .slice(0, MAX_OPTIONS)
      : [];
    if (!record || !question || options.length === 0) {
      complete = false;
      continue;
    }
    questions.push({
      question,
      header: textOf(record.header),
      multiSelect: record.multiSelect === true,
      options,
    });
  }
  return { questions, complete };
}

/**
 * One question: its options (radio or checkbox) and an "Other" text answer.
 * @param {RequestView} view
 * @param {{question: string, header: string, multiSelect: boolean, options: Array<{label: string, description: string}>}} question
 * @param {string} name
 */
function questionGroup(view, question, name) {
  const { t } = view.ctx;
  const inputs = question.options.map((option) => h('input', {
    attrs: { type: question.multiSelect ? 'checkbox' : 'radio', name, value: option.label },
  }));
  const other = h('input', {
    class: 'input request-other-input',
    attrs: {
      type: 'text',
      maxlength: SHORT_LIMIT,
      autocomplete: 'off',
      placeholder: t('cards.request.question.otherPlaceholder'),
      'aria-label': t('cards.request.question.other'),
    },
  });
  const options = question.options.map((option, index) => h('label', { class: 'request-option' },
    inputs[index],
    h('span', { class: 'request-option-body' },
      h('span', { class: 'request-option-label', text: option.label }),
      option.description ? h('span', { class: 'request-option-desc', text: option.description }) : null)));
  const node = h('fieldset', { class: 'request-question', dataset: { multi: question.multiSelect ? 'true' : 'false' } },
    h('legend', { class: 'request-q-legend' },
      question.header ? h('span', { class: 'request-chip', text: question.header }) : null,
      h('span', { class: 'request-q-text', text: question.question })),
    h('div', { class: 'request-options' }, options),
    h('label', { class: 'request-other' },
      h('span', { class: 'field-label', text: t('cards.request.question.other') }),
      other));
  if (!question.multiSelect) {
    // A typed answer replaces the radio choice, and choosing a radio clears the typed answer.
    other.addEventListener('input', () => {
      if (other.value !== '') for (const input of inputs) input.checked = false;
    });
    for (const input of inputs) {
      input.addEventListener('change', () => {
        if (input.checked) other.value = '';
      });
    }
  }
  view.controls.push(...inputs, other);
  return { question, inputs, other, node };
}

/**
 * @param {Array<{question: {question: string, multiSelect: boolean}, inputs: HTMLInputElement[], other: HTMLInputElement}>} groups
 * @returns {Record<string, string | string[]> | null} null while a question has no answer
 */
function collectAnswers(groups) {
  /** @type {Record<string, string | string[]>} */
  const answers = {};
  for (const { question, inputs, other } of groups) {
    const typed = other.value.trim().slice(0, SHORT_LIMIT);
    const picked = inputs.filter((control) => control.checked).map((control) => control.value);
    if (question.multiSelect) {
      const values = typed ? [...picked, typed] : picked;
      if (values.length === 0) return null;
      answers[question.question] = values;
    } else {
      const value = typed || picked[0] || '';
      if (!value) return null;
      answers[question.question] = value;
    }
  }
  return answers;
}

// -------------------------------------------------------------------------------------------------------------------
// Plans (ExitPlanMode)

/** @param {RequestView} view @param {Record<string, any>} request */
function buildPlan(view, request) {
  const { t, renderMarkdown } = view.ctx;
  const input = isRecord(request.input) ? request.input : {};
  const plan = textOf(input.plan);
  setTitle(view, textOf(request.title) || t('cards.request.plan.title'));
  const modeSelect = h('select', { class: 'select request-mode', attrs: { id: `${view.uid}-mode` } },
    PLAN_MODES.map((mode) => h('option', { attrs: { value: mode }, text: t(PLAN_MODE_LABELS[mode]) })));
  const feedback = h('textarea', {
    class: 'textarea request-feedback',
    attrs: {
      id: `${view.uid}-feedback`,
      rows: 2,
      maxlength: TEXT_LIMIT,
      placeholder: t('cards.request.plan.feedbackPlaceholder'),
    },
  });
  view.bodyEl.append(
    h('div', { class: 'request-plan' },
      plan ? renderMarkdown(plan) : h('p', { class: 'request-text', text: t('cards.request.plan.empty') })),
    h('label', { class: 'field' },
      h('span', { class: 'field-label', text: t('cards.request.plan.nextMode') }),
      modeSelect),
    h('label', { class: 'field' },
      h('span', { class: 'field-label', text: t('cards.request.plan.feedback') }),
      feedback));
  view.controls.push(modeSelect, feedback);
  actionButton(view, {
    kind: 'primary',
    label: t('cards.request.plan.approve'),
    onClick: () => {
      const nextMode = PLAN_MODES.includes(modeSelect.value) ? modeSelect.value : 'default';
      submit(view, { decision: 'approve', nextMode });
    },
  });
  actionButton(view, {
    kind: 'secondary',
    label: t('cards.request.plan.reject'),
    onClick: () => {
      const message = feedback.value.trim().slice(0, TEXT_LIMIT);
      submit(view, message ? { decision: 'reject', message } : { decision: 'reject' });
    },
  });
}

// -------------------------------------------------------------------------------------------------------------------
// MCP elicitations

/** @param {RequestView} view @param {Record<string, any>} request */
function buildElicitation(view, request) {
  const { t } = view.ctx;
  const elicitation = isRecord(request.elicitation) ? request.elicitation : {};
  const server = textOf(request.mcpServer?.name) || textOf(elicitation.serverName) || t('cards.request.unknownServer');
  setTitle(view, textOf(elicitation.title) || textOf(request.title) || t('cards.request.elicitation.title', { server }));
  const message = textOf(elicitation.message);
  if (message) view.bodyEl.append(h('p', { class: 'request-text', text: message }));
  const description = textOf(elicitation.description) || textOf(request.description);
  if (description) view.bodyEl.append(h('p', { class: 'request-text is-muted', text: description }));

  if (elicitation.mode === 'url') {
    const link = safeHttpUrl(elicitation.url);
    if (link) {
      view.bodyEl.append(
        h('p', { class: 'request-url' }, h('code', { text: link })),
        h('a', {
          class: 'btn btn-secondary request-link',
          attrs: { href: link, target: '_blank', rel: 'noopener noreferrer' },
        }, icon('external'), h('span', { text: t('cards.request.elicitation.open') })));
    } else {
      view.bodyEl.append(h('p', { class: 'request-text is-error', text: t('cards.request.elicitation.badUrl') }));
    }
    actionButton(view, {
      kind: 'primary',
      label: t('cards.request.elicitation.done'),
      onClick: () => submit(view, { action: 'accept' }),
    });
  } else {
    const fields = formFields(elicitation.requestedSchema).map((entry, index) => buildField(entry, view.uid, index, t));
    if (fields.length > 0) view.bodyEl.append(h('div', { class: 'request-form' }, fields.map((field) => field.node)));
    view.controls.push(...fields.map((field) => field.control));
    actionButton(view, {
      kind: 'primary',
      label: t('cards.request.elicitation.accept'),
      onClick: () => {
        const collected = collectContent(fields, t);
        if (collected.error) {
          setStatus(view, collected.error, 'error');
          return;
        }
        submit(view, { action: 'accept', content: collected.content });
      },
    });
  }
  actionButton(view, {
    kind: 'secondary',
    label: t('cards.request.decline'),
    onClick: () => submit(view, { action: 'decline' }),
  });
  actionButton(view, {
    kind: 'ghost',
    label: t('cards.request.cancel'),
    onClick: () => submit(view, { action: 'cancel' }),
  });
}

/**
 * @param {unknown} schema requestedSchema (JSON Schema object)
 * @returns {Array<{key: string, prop: Record<string, any>, required: boolean}>}
 */
function formFields(schema) {
  const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(isRecord(schema) && Array.isArray(schema.required)
    ? schema.required.filter((key) => typeof key === 'string')
    : []);
  return Object.entries(properties)
    .slice(0, MAX_FIELDS)
    .map(([key, prop]) => ({ key, prop: isRecord(prop) ? prop : {}, required: required.has(key) }));
}

/**
 * One form field: enum select, checkbox, number, text, or JSON text for arrays and objects.
 * @param {{key: string, prop: Record<string, any>, required: boolean}} entry
 * @param {string} uid
 * @param {number} index
 * @param {Translate} t
 */
function buildField({ key, prop, required }, uid, index, t) {
  const id = `${uid}-f${index}`;
  const label = textOf(prop.title) || key;
  const hint = textOf(prop.description);
  const type = typeof prop.type === 'string' ? prop.type : '';
  const requiredAttr = required ? 'true' : null;
  /** @type {HTMLElement} */
  let control;
  /** @type {() => {value: unknown} | typeof SKIP | typeof INVALID} */
  let read;
  if (Array.isArray(prop.enum) && prop.enum.length > 0) {
    const values = prop.enum.slice(0, MAX_ENUM);
    const select = h('select', { class: 'select', attrs: { id, 'aria-required': requiredAttr } },
      required ? null : h('option', { attrs: { value: '' }, text: t('cards.request.elicitation.noValue') }),
      values.map((value, position) => h('option', { attrs: { value: String(position) }, text: String(value) })));
    control = select;
    read = () => (select.value === '' ? SKIP : { value: values[Number(select.value)] });
  } else if (type === 'boolean') {
    const check = h('input', { class: 'request-check', attrs: { id, type: 'checkbox' } });
    control = check;
    read = () => (check.checked || required ? { value: check.checked } : SKIP);
  } else if (type === 'number' || type === 'integer') {
    const integer = type === 'integer';
    const input = h('input', {
      class: 'input',
      attrs: { id, type: 'number', step: integer ? '1' : 'any', 'aria-required': requiredAttr },
    });
    control = input;
    read = () => {
      const raw = input.value.trim();
      if (raw === '') return SKIP;
      const value = Number(raw);
      if (!Number.isFinite(value) || (integer && !Number.isInteger(value))) return INVALID;
      return { value };
    };
  } else if (type === 'string' || type === '') {
    const input = h('input', {
      class: 'input',
      attrs: {
        id,
        type: 'text',
        maxlength: Number.isFinite(prop.maxLength) && prop.maxLength > 0 ? prop.maxLength : null,
        'aria-required': requiredAttr,
      },
    });
    control = input;
    read = () => (input.value === '' ? SKIP : { value: input.value });
  } else {
    const area = h('textarea', {
      class: 'textarea request-json',
      attrs: { id, rows: 3, spellcheck: 'false', 'aria-required': requiredAttr },
    });
    control = area;
    read = () => {
      const raw = area.value.trim();
      if (raw === '') return SKIP;
      try {
        return { value: JSON.parse(raw) };
      } catch {
        return INVALID;
      }
    };
  }
  const node = h('label', { class: 'field request-field' },
    h('span', { class: 'field-label' }, label,
      required ? h('span', { class: 'request-required', attrs: { 'aria-hidden': 'true' }, text: ' *' }) : null),
    hint ? h('span', { class: 'field-hint', text: hint }) : null,
    control);
  return { key, label, required, node, control, read };
}

/**
 * @param {Array<{key: string, label: string, required: boolean, read: () => any}>} fields
 * @param {Translate} t
 * @returns {{content: Record<string, unknown>, error?: undefined} | {error: string, content?: undefined}}
 */
function collectContent(fields, t) {
  /** @type {Record<string, unknown>} */
  const content = {};
  for (const field of fields) {
    const result = field.read();
    if (result === INVALID) return { error: t('cards.request.elicitation.invalid', { name: field.label }) };
    if (result === SKIP) {
      if (field.required) return { error: t('cards.request.elicitation.required', { name: field.label }) };
      continue;
    }
    content[field.key] = result.value;
  }
  return { content };
}

// -------------------------------------------------------------------------------------------------------------------
// Fallback, submission and keyboard

/** @param {RequestView} view @param {Record<string, any>} request */
function buildUnsupported(view, request) {
  const { t } = view.ctx;
  setTitle(view, t('cards.request.unsupported.title'));
  view.bodyEl.append(
    h('p', { class: 'request-text', text: t('cards.request.unsupported.text') }),
    h('pre', { class: 'request-input', text: clip(jsonOf(request), PREVIEW_LIMIT) }));
  setState(view, 'readonly');
}

/**
 * Posts one answer. The card stays locked until the gateway reports request_resolved (or the request is gone).
 * @param {RequestView} view
 * @param {Record<string, unknown>} payload
 */
async function submit(view, payload) {
  const { t, api, toast } = view.ctx;
  if (!view.endpoint || view.card.dataset.state !== 'ready') return;
  setState(view, 'sending');
  setStatus(view, t('cards.request.sending'), 'info');
  try {
    await api.post(view.endpoint, payload);
    setState(view, 'sent');
    setStatus(view, t('cards.request.sent'), 'info');
  } catch (error) {
    const gone = GONE_CODES.has(/** @type {any} */ (error)?.code);
    setState(view, gone ? 'stale' : 'ready');
    const message = gone ? t('cards.request.stale') : errorText(error, t);
    setStatus(view, message, 'error');
    toast?.(message, 'error');
  }
}

/**
 * Number keys 1 to 3 answer the oldest pending permission prompt while focus is not in a field.
 * @param {RequestView} view
 */
function bindShortcuts(view) {
  const onKey = (/** @type {KeyboardEvent} */ event) => {
    if (!view.card.isConnected) {
      document.removeEventListener('keydown', onKey);
      return;
    }
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    const option = view.keys?.get(event.key);
    if (!option || view.card.dataset.state !== 'ready' || !keyboardIsFree(event.target)) return;
    if (option.enabled && !option.enabled()) return;
    if (firstReadyPermission() !== view.card) return;
    event.preventDefault();
    submit(view, option.body());
  };
  document.addEventListener('keydown', onKey);
}

/** @param {RequestView} view */
function focusIfIdle(view) {
  if (!view.card.isConnected || view.card.dataset.state !== 'ready' || !view.focusTarget) return;
  if (!keyboardIsFree(null) || firstReadyPermission() !== view.card) return;
  view.focusTarget.focus({ preventScroll: true });
}

/**
 * @param {EventTarget|null} target
 * @returns {boolean} true when typing a number should not answer a prompt
 */
function keyboardIsFree(target) {
  if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) {
    return false;
  }
  const active = document.activeElement;
  if (!active || active === document.body || active === document.documentElement) return true;
  return active.closest('.tl-root') !== null;
}

/** @returns {Element|null} the oldest permission card that still accepts an answer */
function firstReadyPermission() {
  return document.querySelector('.request-card[data-kind="permission"][data-state="ready"]');
}

/**
 * @param {RequestView} view
 * @param {{kind: 'primary'|'secondary'|'ghost'|'danger', label: string, onClick: () => void, hint?: HTMLElement|null, title?: string|null}} options
 * @returns {HTMLButtonElement}
 */
function actionButton(view, { kind, label, onClick, hint = null, title = null }) {
  const button = h('button', {
    class: ['btn', `btn-${kind}`, 'request-btn'],
    attrs: { type: 'button', title },
    on: { click: onClick },
  }, hint, h('span', { text: label }));
  view.controls.push(button);
  view.actionsEl.append(button);
  return button;
}

/**
 * @param {RequestView} view
 * @param {'ready'|'sending'|'sent'|'stale'|'readonly'} state
 */
function setState(view, state) {
  view.card.dataset.state = state;
  view.card.setAttribute('aria-busy', state === 'sending' ? 'true' : 'false');
  const locked = state !== 'ready';
  for (const control of view.controls) control.disabled = locked;
  view.gate?.();
}

/**
 * @param {RequestView} view
 * @param {string} text
 * @param {'info'|'error'} [level]
 */
function setStatus(view, text, level = 'info') {
  view.statusEl.hidden = !text;
  view.statusEl.textContent = text;
  view.statusEl.setAttribute('role', level === 'error' ? 'alert' : 'status');
  view.statusEl.className = `request-status is-${level}`;
}

/** @param {RequestView} view @param {string} text */
function setTitle(view, text) {
  view.titleEl.textContent = text;
}

/**
 * @param {Record<string, any>} request
 * @param {string|null} sessionId
 * @returns {string|null}
 */
function endpointOf(request, sessionId) {
  const requestId = textOf(request?.id);
  const session = textOf(sessionId) || textOf(request?.sessionId);
  if (!requestId || !session) return null;
  return `/api/sessions/${encodeURIComponent(session)}/requests/${encodeURIComponent(requestId)}`;
}

/** @param {unknown} value @returns {string} trimmed text, or '' for anything that is not a string */
function textOf(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** @param {unknown} value @returns {string} */
function jsonOf(value) {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return '';
  }
}

/** @param {string} text @param {number} limit */
function clip(text, limit) {
  return text.length > limit ? `${text.slice(0, limit)}\n…` : text;
}

/** @param {unknown} value @returns {string|null} the URL when it is http or https */
function safeHttpUrl(value) {
  const text = textOf(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} label
 * @param {string} value
 * @param {string} [title]
 */
function keyValue(label, value, title) {
  return h('div', { class: 'request-kv' },
    h('span', { class: 'request-k', text: label }),
    h('code', { class: 'request-v', text: value, attrs: { title: title ?? value } }));
}
