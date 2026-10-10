/**
 * The side question overlay above the composer (docs/FRONTEND.md). A question asked beside the conversation: the
 * spinner while it runs, then the answer as Markdown with Copy and Close. Nothing enters the transcript. One question
 * is in flight at a time; a failure shows inline; switching sessions or closing drops a late answer.
 */
import { h, clear, icon } from '../dom.js';
import { errorText } from '../api.js';

const QUESTION_LIMIT = 2000;

/**
 * @typedef {(key: string, vars?: Record<string, string | number>) => string} Translate
 * @typedef {{response: string, synthetic?: boolean, refusalFallback?: boolean}} SideAnswer
 */

/**
 * @param {{
 *   t: Translate,
 *   actions: {
 *     sideQuestion: (question: string) => Promise<SideAnswer>,
 *     toast: (message: string, level?: string) => void,
 *   },
 *   renderMarkdown: (text: string) => HTMLElement,
 *   onClose: (restoreFocus: boolean) => void,
 * }} options
 */
export function createSideQuestion({ t, actions, renderMarkdown, onClose }) {
  /** Bumped by every ask, close and session change: an answer that arrives with an older number is dropped. */
  let generation = 0;
  let busy = false;
  let answer = /** @type {string|null} */ (null);

  const questionEl = h('p', { class: 'side-question' });
  const input = /** @type {HTMLTextAreaElement} */ (h('textarea', {
    class: 'side-input',
    attrs: {
      rows: 2,
      maxlength: QUESTION_LIMIT,
      autocomplete: 'off',
      placeholder: t('composer.side.placeholder'),
      'aria-label': t('composer.side.question'),
    },
    on: {
      keydown: (/** @type {KeyboardEvent} */ event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          submit();
        }
      },
    },
  }));
  const askBtn = h('button', {
    class: 'btn btn-primary btn-sm side-ask',
    attrs: { type: 'button' },
    text: t('composer.side.ask'),
    on: { click: () => submit() },
  });
  const formEl = h('div', { class: 'side-form' }, input, askBtn);
  const loadingEl = h('p', { class: 'side-loading', attrs: { role: 'status' } },
    h('span', { class: 'activity-arc', attrs: { 'aria-hidden': 'true' } }),
    h('span', { text: t('composer.side.thinking') }));
  const answerEl = h('div', { class: 'side-answer' });
  const noteEl = h('p', { class: 'side-note', attrs: { hidden: true } });
  const errorEl = h('p', { class: 'side-error', attrs: { role: 'alert', hidden: true } });
  const copyBtn = h('button', {
    class: 'btn btn-secondary btn-sm side-copy',
    attrs: { type: 'button', hidden: true },
    on: { click: () => copyAnswer() },
  }, icon('copy'), h('span', { text: t('composer.side.copy') }));
  const closeBtn = h('button', {
    class: 'btn btn-ghost btn-sm side-close',
    attrs: { type: 'button' },
    on: { click: () => close() },
  }, t('composer.side.close'));
  const element = h('section', {
    class: 'composer-side',
    attrs: { role: 'region', 'aria-label': t('composer.side.region'), hidden: true },
    on: {
      keydown: (/** @type {KeyboardEvent} */ event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
        }
      },
    },
  },
  h('div', { class: 'side-head' }, h('span', { class: 'side-title', text: t('composer.side.title') }), closeBtn),
  questionEl,
  formEl,
  loadingEl,
  errorEl,
  answerEl,
  noteEl,
  h('div', { class: 'side-actions' }, copyBtn));

  /** Shows the state the other fields describe: form (ask), spinner (busy), answer or error. */
  function paint(mode) {
    formEl.hidden = mode !== 'ask';
    askBtn.disabled = busy;
    loadingEl.hidden = !busy;
    questionEl.hidden = mode === 'ask' || !questionEl.textContent;
    answerEl.hidden = busy || answer === null;
    noteEl.hidden = busy || noteEl.textContent === '';
    copyBtn.hidden = busy || answer === null;
  }

  /** @param {string|null} question  the question to ask, or null to open the form */
  function open(question) {
    generation += 1;
    busy = false;
    answer = null;
    errorEl.hidden = true;
    noteEl.textContent = '';
    clear(answerEl);
    element.hidden = false;
    if (question === null) {
      questionEl.textContent = '';
      input.value = '';
      paint('ask');
      input.focus();
      return;
    }
    ask(question);
  }

  /** @param {string} question */
  function ask(question) {
    const text = question.trim();
    if (!text || busy) return;
    generation += 1;
    const mine = generation;
    busy = true;
    answer = null;
    errorEl.hidden = true;
    noteEl.textContent = '';
    clear(answerEl);
    questionEl.textContent = text;
    element.hidden = false;
    paint('busy');
    Promise.resolve()
      .then(() => actions.sideQuestion(text))
      .then((result) => {
        if (mine !== generation) return;
        busy = false;
        answer = typeof result?.response === 'string' ? result.response : '';
        answerEl.append(renderMarkdown(answer));
        const notes = [];
        if (result?.refusalFallback === true) notes.push(t('composer.side.fallback'));
        if (result?.synthetic === true) notes.push(t('composer.side.synthetic'));
        noteEl.textContent = notes.join(' ');
        paint('answer');
      }, (error) => {
        if (mine !== generation) return;
        busy = false;
        errorEl.textContent = errorText(error, t);
        errorEl.hidden = false;
        paint('error');
      });
  }

  function submit() {
    if (busy) return;
    if (!formEl.hidden) ask(input.value);
  }

  function copyAnswer() {
    if (answer === null) return;
    const text = answer;
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(text))
      .then(
        () => actions.toast(t('composer.side.copied'), 'info'),
        () => actions.toast(t('composer.side.copyFailed'), 'error'),
      );
  }

  /** @param {{restoreFocus?: boolean}} [options] restoreFocus: hand the focus back to the composer (default) */
  function close({ restoreFocus = true } = {}) {
    const wasOpen = !element.hidden;
    generation += 1;
    busy = false;
    answer = null;
    element.hidden = true;
    clear(answerEl);
    if (wasOpen) onClose(restoreFocus);
  }

  return {
    element,
    /** @returns {boolean} */
    isOpen() {
      return !element.hidden;
    },
    /** Opens the form with no question, or asks `question` at once. */
    open,
    close,
    /** @returns {boolean} whether a question is waiting for its answer */
    isBusy() {
      return busy;
    },
  };
}
