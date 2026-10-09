/**
 * Journeys for the official runtime features the interface shows: background tasks, model refusals, plugin installs,
 * output styles, plugin reloads, fast mode and thinking summaries. One gateway (mock engine, auth on) and one Chromium
 * serve the whole file. Every test opens its own browser context and ends with assertClean(): no console errors, page
 * errors or unexpected failed responses.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  createSession,
  eventually,
  launchBrowser,
  runTurn,
  sendMessage,
  signIn,
  startApp,
  waitForTurnResult,
  withPage,
} from './helpers.mjs';

const TEST_TIMEOUT_MS = 90_000;

/** @type {Awaited<ReturnType<typeof startApp>>} */
let app;
/** @type {import('playwright-core').Browser} */
let browser;

before(async () => {
  // Every journey keeps its session open, so more live sessions are allowed than the default.
  app = await startApp({ env: { CAW_MAX_LIVE_SESSIONS: '32' } });
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close();
  await app?.close();
});

/**
 * Opens the Capabilities sheet from the header's overflow menu.
 * @param {import('playwright-core').Page} page
 * @returns {Promise<import('playwright-core').Locator>} the sheet
 */
async function openCapabilities(page) {
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Capabilities', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Capabilities', exact: true });
  await sheet.waitFor();
  return sheet;
}

/**
 * Sets the trust of a folder with the gateway's own endpoint, called from the page as the app would call it.
 * @param {import('playwright-core').Page} page
 * @param {string} folder
 * @param {boolean} trusted
 */
async function setFolderTrust(page, folder, trusted) {
  const status = await page.evaluate(async ({ path, value }) => {
    const response = await fetch('/api/fs/trust', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, trusted: value }),
      credentials: 'same-origin',
    });
    return response.status;
  }, { path: folder, value: trusted });
  assert.equal(status, 200, `setting the trust of ${folder} failed`);
}

/**
 * Closes the open side sheet with its own close button.
 * @param {import('playwright-core').Locator} sheet
 */
async function closeSheet(sheet) {
  await sheet.getByRole('button', { name: 'Close', exact: true }).click();
  await sheet.waitFor({ state: 'detached' });
}

test('O1 a running command moves to the background from its card, and the header counts it', { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'O1 background from a card', { baseURL: app.url }, async (ui) => {
    const { page } = ui;
    await signIn(page, app.url);
    await createSession(page, { title: 'Background build' });

    await sendMessage(page, 'Run the build in the background');
    const move = page.getByRole('button', { name: 'Run in background', exact: true });
    await move.waitFor();
    // The control sits in the card's action row, never in its summary, so pressing it cannot toggle the details.
    const placement = await move.evaluate((node) => ({
      inSummary: node.closest('summary') !== null,
      inActions: node.closest('.tool-actions') !== null,
    }));
    assert.deepEqual(placement, { inSummary: false, inActions: true });

    await move.click();
    await page.locator('button.hdr-tasks', { hasText: '1 background' }).waitFor();
    await waitForTurnResult(page, 1);
    assert.equal(await page.getByRole('button', { name: 'Run in background', exact: true }).count(), 0);
    await page.locator('.msg-assistant', { hasText: 'The build is running in the background' }).waitFor();

    await page.locator('button.hdr-tasks').click();
    await page.getByRole('dialog', { name: 'Background tasks', exact: true }).waitFor();
  }));

test('O2 the fallback model\'s answer replaces the refused one, and the notice explains it', { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'O2 refusal with fallback', { baseURL: app.url }, async (ui) => {
    const { page } = ui;
    await signIn(page, app.url);
    await createSession(page, { title: 'Refusal fallback' });

    await sendMessage(page, 'Refusal check with a fallback');
    await page.locator('.msg-assistant', { hasText: 'Here is the answer from the fallback model.' }).waitFor();
    const notice = page.locator('.notice[data-code="refusal-fallback"]');
    await notice.waitFor();
    assert.match(await notice.innerText(), /retried with Claude Sonnet/);
    await waitForTurnResult(page, 1);

    // The retry supersedes the refused answer, which leaves without a marker; the end-of-turn notice withdraws nothing.
    assert.equal(await page.locator('.msg-assistant', { hasText: "I can't help with that request." }).count(), 0);
    assert.equal(await page.locator('.withdrawn').count(), 0);
  }));

test('O3 a refusal with no fallback model offers Edit and retry, which opens the rewind dialog', { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'O3 refusal without fallback', { baseURL: app.url }, async (ui) => {
    const { page } = ui;
    await signIn(page, app.url);
    await createSession(page, { title: 'Refusal without fallback' });
    // A rewind cannot target the first message of a conversation, so an earlier turn comes first.
    await runTurn(page, 'Hello before the check');

    await sendMessage(page, 'Run the refusal-none check');
    const notice = page.locator('.notice[data-code="refusal-no-fallback"]');
    await notice.waitFor();
    assert.match(await notice.innerText(), /No fallback model is configured/);
    await notice.getByRole('button', { name: 'Edit and retry', exact: true }).click();

    const rewind = page.getByRole('dialog', { name: 'Rewind session', exact: true });
    await rewind.waitFor();
    await rewind.getByRole('button', { name: 'Cancel', exact: true }).click();
    await rewind.waitFor({ state: 'detached' });
    await waitForTurnResult(page, 2);
  }));

test('O4 a plugin installation shows each step in the timeline', { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'O4 plugin install steps', { baseURL: app.url }, async (ui) => {
    const { page } = ui;
    await signIn(page, app.url);
    await createSession(page, { title: 'Plugin install' });

    await sendMessage(page, 'Install the plugin for this project');
    const steps = page.locator('.notice[data-code="plugin-install"]');
    await steps.filter({ hasText: /^Installing plugins/ }).waitFor();
    await steps.filter({ hasText: 'Installed plugin demo-plugin.' }).waitFor();
    await steps.filter({ hasText: 'Plugin installation finished.' }).waitFor();
    await waitForTurnResult(page, 1);
    await page.locator('.msg-assistant', { hasText: 'Plugins are ready.' }).waitFor();
  }));

test('O5 an output style is locked until the folder is trusted, then it can be chosen', { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'O5 output style', { baseURL: app.url }, async (ui) => {
    const { page } = ui;
    await signIn(page, app.url);
    await setFolderTrust(page, app.project, false);
    const sessionId = await createSession(page, { title: 'Output style', trust: false });
    await runTurn(page, 'Hello for the output style check');

    let sheet = await openCapabilities(page);
    const style = sheet.getByRole('combobox', { name: 'Output style', exact: true });
    await style.waitFor();
    assert.equal(await style.isDisabled(), true);
    await sheet.getByText('Trust this folder to change its output style.', { exact: true }).waitFor();
    await closeSheet(sheet);

    // Trust the folder, then reopen the session so that the runtime loads the project settings, as the trust banner does.
    await setFolderTrust(page, app.project, true);
    await page.evaluate(async (id) => {
      const post = (path) => fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        credentials: 'same-origin',
      });
      const closed = await post(`/api/sessions/${id}/close`);
      if (!closed.ok) throw new Error(`closing the session failed with ${closed.status}`);
      const opened = await post(`/api/sessions/${id}/open`);
      if (!opened.ok) throw new Error(`reopening the session failed with ${opened.status}`);
    }, sessionId);

    sheet = await openCapabilities(page);
    const trusted = sheet.getByRole('combobox', { name: 'Output style', exact: true });
    await eventually(async () => !(await trusted.isDisabled()), {
      message: 'the output style select stayed disabled after the folder was trusted',
    });
    // The Explanatory style, whatever case the runtime reports its name in.
    const explanatory = await trusted.locator('option', { hasText: /^explanatory$/i }).getAttribute('value');
    assert.ok(explanatory, 'the runtime offers no Explanatory output style');
    await trusted.selectOption(explanatory);
    await page.locator('.toast', { hasText: `Output style set to ${explanatory}` }).waitFor();
    await eventually(async () => (await trusted.inputValue()) === explanatory, {
      message: `the output style select did not keep ${explanatory}`,
    });
    await closeSheet(sheet);
  }));

test('O6 reloading plugins asks first when the prompt cache would change', { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'O6 plugin reload confirmation', { baseURL: app.url }, async (ui) => {
    const { page } = ui;
    await signIn(page, app.url);
    await createSession(page, { title: 'Plugin reload' });
    // A plugin that a turn installed stays pending until a reload applies it; the runtime holds that reload while the
    // prompt cache depends on the tool list.
    await runTurn(page, 'Install the plugin for the reload check');

    const sheet = await openCapabilities(page);
    await sheet.getByRole('button', { name: 'Reload plugins', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: 'Reload plugins?', exact: true });
    await confirm.waitFor();
    await confirm.getByText('plugin:demo-plugin:docs', { exact: true }).waitFor();
    await confirm.getByRole('button', { name: 'Reload anyway', exact: true }).click();
    await page.locator('.toast', { hasText: 'Reloaded' }).waitFor();
    await confirm.waitFor({ state: 'detached' });
    await closeSheet(sheet);
  }));

test('O7 Opus offers fast mode: the toggle is pressed, and the runtime reports it on', { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'O7 fast mode', { baseURL: app.url }, async (ui) => {
    const { page } = ui;
    await signIn(page, app.url);
    await createSession(page, { title: 'Fast mode' });
    await page.locator('select.hdr-model').selectOption({ label: 'Opus' });
    await runTurn(page, 'Hello in fast mode');

    const fast = page.locator('button.hdr-fast');
    await fast.waitFor();
    assert.equal(await fast.getAttribute('aria-pressed'), 'false');
    await fast.click();
    await eventually(async () => (await fast.getAttribute('aria-pressed')) === 'true', {
      message: 'the fast mode toggle was not pressed after the click',
    });
    // The runtime reports the state with its next result.
    await runTurn(page, 'Hello again in fast mode');
    await page.locator('button.hdr-fast[data-state="on"]').waitFor();
  }));

test('O8 a thinking block with a summary opens to its text', { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'O8 thinking summary', { baseURL: app.url }, async (ui) => {
    const { page } = ui;
    await signIn(page, app.url);
    await createSession(page, { title: 'Thinking' });

    await sendMessage(page, 'Think it through before you answer');
    await waitForTurnResult(page, 1);
    const thinking = page.locator('details.thinking').first();
    await thinking.locator('summary.thinking-summary').click();
    await thinking.locator('.thinking-body', { hasText: 'The request is simple, so I will answer it directly.' }).waitFor();
    assert.equal(await thinking.evaluate((node) => node.open), true);
  }));
