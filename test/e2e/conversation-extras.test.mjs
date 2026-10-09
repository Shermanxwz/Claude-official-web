/**
 * Conversation extras through the web UI on a 1440x900 desktop: a queued message cancelled and Stop that clears the
 * queue, the side question from the palette, the Shift+Tab mode cycle, prompt recall, the running line, the todo bar, a
 * plan reloaded while it waits, the refusal dialog (retry and edit), the Advanced section of New session, a screenshot
 * from the browser server and a background command. One gateway (mock engine, auth on) and one Chromium serve the file;
 * every test opens its own context and ends with assertClean(): no console errors, page errors or unexpected failures.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import {
  PROJECT,
  createSession,
  eventually,
  launchBrowser,
  runTurn,
  sendMessage,
  sessionIdOf,
  signIn,
  startApp,
  waitForTurnResult,
  withPage,
} from './helpers.mjs';

const TEST_TIMEOUT_MS = 90_000;
/** A second folder inside the workspace root, offered as an additional directory. */
const SHARED_FOLDER = 'shared-lib';

/** @type {Awaited<ReturnType<typeof startApp>>} */
let app;
/** @type {import('playwright-core').Browser} */
let browser;

before(async () => {
  // Slower pacing gives the queue and the running line time to be seen; more live sessions keep every test's session.
  app = await startApp({
    env: {
      CAW_MOCK_DELAY_MS: '25',
      CAW_MAX_LIVE_SESSIONS: '32',
      // The browser tools row of New session and the browse scenario need the browser server configured.
      CAW_BROWSER_MCP_COMMAND: JSON.stringify(['caw-browser-mcp']),
    },
  });
  fs.mkdirSync(path.join(app.root, SHARED_FOLDER), { recursive: true });
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close();
  await app?.close();
});

/**
 * A request card that waits for an answer.
 * @param {import('playwright-core').Page} page
 * @param {string} kind  the card's data-kind, for example 'plan' or 'dialog'
 */
function pendingCard(page, kind) {
  return page.locator(`section.request-card[data-kind="${kind}"][data-state="ready"]`);
}

/**
 * Sends a message while a turn runs, so it waits in the queue as a queued bubble.
 * @param {import('playwright-core').Page} page
 * @param {string} text
 */
async function queue(page, text) {
  await page.locator('.composer-input').fill(text);
  await page.locator('.composer-send').click();
  await page.locator('.msg-user.is-queued', { hasText: text }).waitFor();
}

/**
 * Opens New session on the project folder, the way createSession does, and returns the dialog.
 * @param {import('playwright-core').Page} page
 */
async function openNewSession(page) {
  await page.getByRole('button', { name: 'New session', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New session', exact: true });
  await dialog.waitFor();
  await eventually(async () => {
    const shown = (await dialog.locator('.dir-path').textContent()) ?? '';
    if (shown.endsWith(`/${PROJECT}`)) return true;
    const row = dialog.locator('.dir-row', { hasText: PROJECT });
    if ((await row.count()) > 0) await row.first().click();
    return false;
  }, { message: `the New session dialog never showed the folder ${PROJECT}` });
  return dialog;
}

/**
 * Starts the session the dialog describes and returns its id once the page shows it.
 * @param {import('playwright-core').Page} page
 * @param {import('playwright-core').Locator} dialog
 */
async function startFromDialog(page, dialog) {
  await dialog.getByRole('button', { name: 'Start session', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.waitForFunction(() => /^#\/s\/[0-9a-f-]{36}$/i.test(location.hash));
  await page.locator('.session-main[aria-current="true"]').waitFor({ state: 'attached' });
  return sessionIdOf(page);
}

/**
 * The session as the API reports it, the live info included.
 * @param {import('playwright-core').Page} page
 * @param {string} id
 */
function readSession(page, id) {
  return page.evaluate(async (sessionId) => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { credentials: 'same-origin' });
    return response.json();
  }, id);
}

test('slow: a queued message can be cancelled, and Stop clears the rest of the queue', { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'conversation-extras-slow', { baseURL: app.url }, async ({ page }) => {
    await signIn(page, app.url);
    await createSession(page);
    await sendMessage(page, 'slow first answer');
    await page.locator('.state-badge[data-state="running"]').waitFor();

    await queue(page, 'queued to cancel');
    await page.locator('.msg-user.is-queued', { hasText: 'queued to cancel' })
      .getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.locator('.msg-user', { hasText: 'queued to cancel' }).waitFor({ state: 'detached' });

    await queue(page, 'queued to clear');
    await page.locator('.composer-stop-more').click();
    await page.getByRole('menuitem', { name: 'Stop and clear the queue', exact: true }).click();
    await page.locator('.turn-result.is-interrupted').waitFor();
    await page.locator('.msg-user', { hasText: 'queued to clear' }).waitFor({ state: 'detached' });
    assert.equal(await page.locator('.msg-user.is-queued').count(), 0, 'the queue is not empty after Stop');
  }));

test('side question: /btw from the palette answers beside the conversation and adds nothing to it', { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'conversation-extras-btw', { baseURL: app.url }, async ({ page }) => {
    await signIn(page, app.url);
    await createSession(page);
    await page.locator('.composer-input').fill('/btw');
    await page.locator('.palette-option', { hasText: 'btw' }).first().click();

    const side = page.locator('.composer-side');
    await side.waitFor();
    await side.locator('.side-input').fill('What does this project do?');
    await side.getByRole('button', { name: 'Ask', exact: true }).click();
    const answer = side.locator('.side-answer');
    await answer.waitFor();
    assert.notEqual((await answer.textContent())?.trim(), '', 'the side question has no answer');
    assert.equal(await page.locator('.tl-list .msg-user').count(), 0, 'the side question entered the transcript');

    await side.getByRole('button', { name: 'Close', exact: true }).click();
    await side.waitFor({ state: 'hidden' });
  }));

test('mode: Shift+Tab cycles the permission mode, flashes the new word and changes the header too', { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'conversation-extras-mode', { baseURL: app.url }, async ({ page }) => {
    await signIn(page, app.url);
    await createSession(page);
    const previousMode = await page.locator('.hdr-mode').inputValue();
    const word = await page.locator('.composer-mode-text').textContent();

    await page.locator('.composer-input').focus();
    await page.keyboard.press('Shift+Tab');
    await page.locator('.composer-footer.is-flash').waitFor();
    assert.notEqual(await page.locator('.composer-mode-text').textContent(), word, 'the footer word did not change');
    await eventually(async () => (await page.locator('.hdr-mode').inputValue()) !== previousMode, {
      message: 'the header mode did not follow the cycle',
    });
    await eventually(async () => (await page.locator('.composer-footer.is-flash').count()) === 0, {
      timeout: 5_000,
      message: 'the flash did not end after two seconds',
    });
  }));

test('recall: the arrow keys walk this session\'s earlier prompts and restore the draft', { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'conversation-extras-recall', { baseURL: app.url }, async ({ page }) => {
    await signIn(page, app.url);
    await createSession(page);
    await runTurn(page, 'recall one');
    await runTurn(page, 'recall two');

    const input = page.locator('.composer-input');
    await input.focus();
    await page.keyboard.press('ArrowUp');
    await eventually(async () => (await input.inputValue()) === 'recall two', { message: 'ArrowUp did not recall the newest prompt' });
    await page.keyboard.press('ArrowUp');
    await eventually(async () => (await input.inputValue()) === 'recall one', { message: 'ArrowUp did not go further back' });
    await page.keyboard.press('ArrowDown');
    await eventually(async () => (await input.inputValue()) === 'recall two', { message: 'ArrowDown did not walk forward' });
    await page.keyboard.press('ArrowDown');
    await eventually(async () => (await input.inputValue()) === '', { message: 'the draft was not restored' });
  }));

test('running line: shows the elapsed time while a turn works and is gone once it is idle', { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'conversation-extras-running-line', { baseURL: app.url }, async ({ page }) => {
    await signIn(page, app.url);
    await createSession(page);
    const line = page.locator('.composer-activity');
    await sendMessage(page, 'slow timing check');
    await eventually(async () => line.isVisible(), { message: 'the running line never appeared' });
    await eventually(async () => /\d+s/.test((await line.locator('.activity-time').textContent()) ?? ''), {
      message: 'the running line never showed an elapsed time',
    });
    await waitForTurnResult(page, 1);
    await eventually(async () => !(await line.isVisible()), { message: 'the running line stayed after the turn' });
  }));

test('todo: the todo bar follows the checklist the turn writes', { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'conversation-extras-todo', { baseURL: app.url }, async ({ page }) => {
    await signIn(page, app.url);
    await createSession(page);
    await runTurn(page, 'todo checklist for the change');

    const bar = page.locator('.composer-todos');
    await bar.waitFor();
    await eventually(async () => (await page.locator('.todo-count').textContent())?.trim() === '1/4', {
      message: 'the todo count is not 1/4',
    });
    await page.locator('.todo-toggle').click();
    assert.equal(await page.locator('.todo-list .todo-item').count(), 4, 'the todo list does not show all four items');
  }));

test('plan: reloading while a plan waits shows the request card and no draft of the tool call', { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'conversation-extras-plan', { baseURL: app.url }, async ({ page }) => {
    await signIn(page, app.url);
    await createSession(page);
    await sendMessage(page, 'plan the change');
    await pendingCard(page, 'plan').waitFor();

    await page.reload();
    await page.locator('.session-main[aria-current="true"]').waitFor();
    await pendingCard(page, 'plan').waitFor();
    assert.equal(await page.locator('.draft-tool').count(), 0, 'a draft of the plan tool call is shown after reload');
    assert.equal(await page.locator('.tl-list').getByText('Writing…', { exact: true }).count(), 0);
    // The plan tool row waits closed: the request card above the composer already shows the plan.
    assert.equal(await page.locator('.work-item details.tool-card[open]').count(), 0, 'the waiting row is open');

    await pendingCard(page, 'plan').getByRole('button', { name: 'Approve plan', exact: true }).click();
    await waitForTurnResult(page, 1);
  }));

test('refusal: retry on the fallback model answers the refused prompt', { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'conversation-extras-refusal-retry', { baseURL: app.url }, async ({ page }) => {
    await signIn(page, app.url);
    await createSession(page);
    await sendMessage(page, 'refusal-prompt explain the rules');
    const card = pendingCard(page, 'dialog');
    await card.waitFor();
    // While the dialog waits, the running line says so, with the waiting dot in place of the arc.
    await page.locator('.composer-activity.is-waiting .activity-text', { hasText: 'Waiting for you' }).waitFor();
    await card.getByRole('button', { name: /^Retry with /u }).click();
    await card.waitFor({ state: 'detached' });
    await waitForTurnResult(page, 1);
    assert.ok((await page.locator('.msg-assistant').count()) >= 1, 'no answer from the fallback model');
  }));

test('refusal: edit prompt puts the refused prompt back into the composer', { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'conversation-extras-refusal-edit', { baseURL: app.url }, async ({ page }) => {
    await signIn(page, app.url);
    await createSession(page);
    const prompt = 'refusal-prompt rewrite this paragraph';
    await sendMessage(page, prompt);
    const card = pendingCard(page, 'dialog');
    await card.waitFor();
    await card.getByRole('button', { name: 'Edit the prompt', exact: true }).click();
    await card.waitFor({ state: 'detached' });
    await eventually(async () => (await page.locator('.composer-input').inputValue()) === prompt, {
      message: 'the refused prompt is not in the composer',
    });
  }));

test('new session: the Advanced fields reach the live session', { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'conversation-extras-advanced', { baseURL: app.url }, async ({ page }) => {
    await signIn(page, app.url);
    const dialog = await openNewSession(page);
    await dialog.locator('.newsession-advanced-toggle').click();

    // The agent is a list when the server offers agents, a text field otherwise; the labels wrap their options.
    const agent = dialog.locator('#new-session-agent');
    let agentName = 'reviewer';
    if ((await agent.evaluate((node) => node.tagName)) === 'SELECT') {
      await agent.selectOption({ index: 1 });
      agentName = await agent.inputValue();
    } else {
      await agent.fill(agentName);
    }
    const fallback = dialog.locator('#new-session-fallback');
    await fallback.selectOption({ index: 1 });
    const fallbackModel = await fallback.inputValue();

    // The additional-directory browser opens on the session folder; its toolbar goes up to the root, where the
    // shared folder is listed.
    await dialog.getByRole('button', { name: 'Add folder', exact: true }).click();
    const extra = dialog.locator('.dir-browser-extra');
    await extra.locator('.dir-toolbar button').first().click();
    await extra.locator('.dir-row', { hasText: SHARED_FOLDER }).first().click();
    await extra.getByRole('button', { name: 'Add this folder', exact: true }).click();
    await dialog.locator('.dir-chip', { hasText: SHARED_FOLDER }).waitFor();

    const id = await startFromDialog(page, dialog);
    await page.locator('.msg-user, .tl-empty').first().waitFor();
    await sendMessage(page, 'advanced check');
    const { live } = await readSession(page, id);
    assert.equal(live.agent, agentName);
    assert.equal(live.fallbackModel, fallbackModel);
    assert.ok(live.additionalDirectories.some((dir) => dir.endsWith(`/${SHARED_FOLDER}`)),
      `the additional directory is missing: ${JSON.stringify(live.additionalDirectories)}`);
    await page.locator('.hdr-agent', { hasText: agentName }).waitFor();
  }));

test('browse: a screenshot from the browser server shows in its card and opens full size', { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'conversation-extras-browse', { baseURL: app.url }, async ({ page }) => {
    await signIn(page, app.url);
    const dialog = await openNewSession(page);
    await dialog.locator('.newsession-advanced-toggle').click();
    await dialog.getByLabel('Browser tools', { exact: true }).check();
    const id = await startFromDialog(page, dialog);
    assert.match(id, /^[0-9a-f-]{36}$/i);

    await sendMessage(page, 'browse the docs page');
    // A finished work group and its tool card start closed. Expanding them while the turn runs races the re-renders
    // of the running group, so the turn finishes first; each click then opens one level, outer before inner.
    await waitForTurnResult(page, 1);
    const group = page.locator('details.work').first();
    const tool = group.locator('details.tool-card').first();
    const shot = page.locator('.tool-image-button img').first();
    await eventually(async () => {
      if (await shot.isVisible()) return true;
      if (!(await group.evaluate((el) => el.open))) await group.locator(':scope > summary.work-summary').click();
      if (!(await tool.evaluate((el) => el.open))) await tool.locator(':scope > summary.tool-head').click();
      return false;
    }, { message: 'the screenshot never showed in its card' });
    assert.ok(await shot.evaluate((img) => img.complete && img.naturalWidth > 0), 'the screenshot did not load');

    await page.locator('.tool-image-button').first().click();
    const full = page.getByRole('dialog').filter({ has: page.locator('img.tool-image-full') });
    await full.waitFor();
    assert.ok(await full.locator('img.tool-image-full').evaluate((img) => img.naturalWidth > 0));
    // The dialog has its own corner close button too; the labelled footer button is the last one.
    await full.getByRole('button', { name: 'Close', exact: true }).last().click();
    await full.waitFor({ state: 'detached' });
  }));

test('background: a command moved to the background is counted in the header', { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'conversation-extras-background', { baseURL: app.url }, async ({ page }) => {
    await signIn(page, app.url);
    await createSession(page);
    await sendMessage(page, 'background build check');
    // The command runs in the foreground until it is moved; the turn ends once it is in the background.
    await eventually(async () => {
      if (await page.getByRole('button', { name: 'Run in background', exact: true }).isVisible()) return true;
      const closed = page.locator('details.work:not([open]) > summary.work-summary, details.tool-card:not([open]) > summary.tool-head').first();
      if ((await closed.count()) > 0) await closed.click();
      return false;
    }, { message: 'the Run in background button never appeared' });
    await page.getByRole('button', { name: 'Run in background', exact: true }).click();
    await waitForTurnResult(page, 1);
    await eventually(async () => /1 background/u.test((await page.locator('.hdr-tasks').textContent()) ?? ''), {
      message: 'the header does not count the background task',
    });
  }));
