/**
 * The shell's extra surfaces, through the web UI on a 1440x900 desktop: the runtime panel, the developer console, the
 * quick switcher, sidebar deep search, the session panel (folders, agent, fallback model, export), the background task
 * output viewer, MCP authentication and the account sign-in. One gateway (mock engine, auth on) and one Chromium serve
 * the whole file. Every test ends with assertClean(): no console errors, page errors or unexpected failed responses.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import {
  createSession,
  eventually,
  launchBrowser,
  runTurn,
  sendMessage,
  sessionIdOf,
  signIn,
  startApp,
  withPage,
} from './helpers.mjs';

const TEST_TIMEOUT_MS = 120_000;

/** @type {Awaited<ReturnType<typeof startApp>>} */
let app;
/** @type {import('playwright-core').Browser} */
let browser;

before(async () => {
  app = await startApp({ env: { CAW_MOCK_DELAY_MS: '10', CAW_MAX_LIVE_SESSIONS: '16' } });
  // A second folder inside the workspace root, for the session panel's folder test.
  fs.mkdirSync(path.join(app.root, 'extras'), { recursive: true });
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close();
  await app?.close();
});

/**
 * Opens the quick switcher with Ctrl+K (the Linux shortcut the page uses) and returns its dialog.
 * @param {import('playwright-core').Page} page
 */
async function openSwitcher(page) {
  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog', { name: 'Quick switcher', exact: true });
  await dialog.waitFor();
  return dialog;
}

/**
 * Opens a side panel by its label from the quick switcher, and returns the panel's dialog.
 * @param {import('playwright-core').Page} page
 * @param {string} label
 */
async function openPanelFromSwitcher(page, label) {
  const dialog = await openSwitcher(page);
  await dialog.getByRole('option', { name: label, exact: true }).click();
  const panel = page.getByRole('dialog', { name: label, exact: true });
  await panel.waitFor();
  return panel;
}

/** Waits for a toast with the given text to show up. */
async function expectToast(page, text) {
  await page.locator('.toast', { hasText: text }).first().waitFor({ state: 'attached' });
}

test('runtime panel: tabs read the runtime, and saved memory offers a restart', { timeout: TEST_TIMEOUT_MS }, async () => {
  await withPage(browser, 'E1 runtime panel', { baseURL: app.url }, async (ui) => {
    const { page } = ui;
    await signIn(page, app.url);
    await createSession(page, { title: 'Runtime views' });
    const panel = await openPanelFromSwitcher(page, 'Runtime');

    await panel.locator('.runtime-tab', { hasText: 'Usage' }).click();
    await eventually(async () => (await panel.locator('.runtime-tab.is-active').textContent())?.trim() === 'Usage');
    await panel.locator('.runtime-stage .runtime-body').first().waitFor();

    await panel.locator('.runtime-tab', { hasText: 'Settings' }).click();
    await panel.locator('.runtime-body pre.devtools-json').first().waitFor();

    await panel.locator('.runtime-tab', { hasText: 'Memory' }).click();
    const editor = panel.locator('textarea.runtime-memory').first();
    await editor.waitFor();
    await editor.fill(`Notes from the shell extras test ${Date.now()}`);
    await panel.getByRole('button', { name: 'Save memory', exact: true }).first().click();
    await expectToast(page, 'Memory saved');
    await panel.locator('.runtime-restart', { hasText: 'Restart the session to load the saved memory.' }).waitFor();
    await panel.locator('.runtime-restart').getByRole('button', { name: 'Restart session', exact: true }).click();
    await eventually(async () => (await panel.locator('.runtime-restart').count()) === 0);
    await page.keyboard.press('Escape');
    await panel.waitFor({ state: 'detached' });
  });
});

test('developer console: the event log records this page and can be filtered and cleared', { timeout: TEST_TIMEOUT_MS }, async () => {
  await withPage(browser, 'E2 developer console', { baseURL: app.url }, async (ui) => {
    const { page } = ui;
    await signIn(page, app.url);
    await createSession(page, { title: 'Console events' });
    const panel = await openPanelFromSwitcher(page, 'Developer console');

    await eventually(async () => (await panel.locator('ul.evt-list > li.evt').count()) > 0);
    const summary = panel.locator('.sheet-note[role="status"]', { hasText: 'events' }).first();
    assert.match((await summary.textContent()) ?? '', /events/);

    const filter = panel.getByLabel('Filter events', { exact: true });
    const firstType = (await panel.locator('.evt-type').first().textContent())?.trim() ?? '';
    assert.notEqual(firstType, '');
    await filter.selectOption(firstType);
    await eventually(async () => {
      const types = await panel.locator('.evt-type').allTextContents();
      return types.length > 0 && types.every((type) => type.trim() === firstType);
    }, { message: `the filter kept only ${firstType} events` });

    await filter.selectOption('all');
    await panel.getByRole('button', { name: 'Clear log', exact: true }).click();
    await eventually(async () => (await panel.locator('ul.evt-list > li.evt').count()) <= 2);

    await panel.locator('.devtools-view pre.devtools-json').first().waitFor();
    await page.keyboard.press('Escape');
    await panel.waitFor({ state: 'detached' });
  });
});

test('quick switcher: sessions by title, and messages by their text', { timeout: TEST_TIMEOUT_MS }, async () => {
  await withPage(browser, 'E3 quick switcher', { baseURL: app.url }, async (ui) => {
    const { page } = ui;
    await signIn(page, app.url);
    const alphaId = await createSession(page, { title: 'Alpha switch' });
    await runTurn(page, 'opening note');
    await runTurn(page, 'hello switcher');
    await createSession(page, { title: 'Beta switch' });

    // Each step waits for the state it depends on: the option is listed before it is clicked, the switcher has closed
    // before the next one is opened, and the message results are rendered before one of them is chosen.
    let dialog = await openSwitcher(page);
    await dialog.getByPlaceholder('Search sessions, panels and commands').fill('alpha');
    const alphaOption = dialog.locator('[role="option"]', { hasText: 'Alpha switch' }).first();
    await alphaOption.waitFor({ state: 'visible' });
    await alphaOption.click();
    await dialog.waitFor({ state: 'detached' });
    await eventually(async () => sessionIdOf(page) === alphaId, { message: 'the switcher did not open the Alpha session' });

    dialog = await openSwitcher(page);
    await dialog.getByPlaceholder('Search sessions, panels and commands').fill('hello switcher');
    const messageOption = dialog.locator('#switcher-opt-search');
    await messageOption.waitFor({ state: 'visible' });
    await messageOption.click();
    await eventually(async () => (await dialog.locator('.switcher-snippet mark').count()) > 0,
      { message: 'the message search never highlighted a match' });
    const marked = (await dialog.locator('.switcher-snippet mark').allTextContents()).map((text) => text.toLowerCase());
    assert.ok(marked.includes('hello') && marked.includes('switcher'), `marked words: ${marked.join(', ')}`);
    const result = dialog.locator('[id^="switcher-result-"]').first();
    await result.waitFor({ state: 'visible' });
    await result.click();
    await dialog.waitFor({ state: 'detached' });
    await eventually(async () => sessionIdOf(page) === alphaId, { message: 'the result did not open its session' });
  });
});

test('sidebar deep search: a query finds messages, and the list comes back', { timeout: TEST_TIMEOUT_MS }, async () => {
  await withPage(browser, 'E4 sidebar deep search', { baseURL: app.url }, async (ui) => {
    const { page } = ui;
    await signIn(page, app.url);
    // The first prompt is kept out of the query's words: the search reads the later messages, which carry the snippets.
    await createSession(page, { title: 'Deep check' });
    await runTurn(page, 'opening note');
    await runTurn(page, 'a sentence about sidebar search');

    const field = page.locator('.sidebar-search-input');
    await field.fill('sidebar search');
    await page.locator('.sidebar-deep', { hasText: 'Search all messages' }).click();
    await page.locator('.search-result').first().waitFor();
    // The words are marked one by one: the search finds messages that hold them apart.
    await eventually(async () => (await page.locator('.search-snippet mark').count()) > 0,
      { message: 'the search results never marked a match' });
    const marked = (await page.locator('.search-snippet mark').allTextContents()).map((text) => text.toLowerCase());
    assert.ok(marked.includes('sidebar') && marked.includes('search'), `marked words: ${marked.join(', ')}`);

    await page.locator('.sidebar-deep-results').getByRole('button', { name: 'Back to all sessions', exact: true }).click();
    await page.locator('.search-result').first().waitFor({ state: 'detached' });
    await field.fill('');
  });
});

test('session panel: folders restart the session, the agent and fallback change, and the export downloads', { timeout: TEST_TIMEOUT_MS }, async () => {
  await withPage(browser, 'E5 session panel', { baseURL: app.url }, async (ui) => {
    const { page } = ui;
    await signIn(page, app.url);
    await createSession(page, { title: 'Session panel' });
    await runTurn(page, 'hello export');
    const panel = await openPanelFromSwitcher(page, 'Session');

    await panel.getByRole('button', { name: 'Add folder', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Choose a folder', exact: true });
    await picker.waitFor();
    await picker.locator('.dir-up').click();
    await picker.locator('.dir-row', { hasText: 'extras' }).click();
    await picker.getByRole('button', { name: 'Use this folder', exact: true }).click();
    await picker.waitFor({ state: 'detached' });
    // A folder change restarts the session on the spot, so the panel offers no restart for it.
    await expectToast(page, 'Folders saved');
    await panel.locator('.dir-list, .item-list', { hasText: 'extras' }).first().waitFor();

    const agent = panel.getByLabel('Agent', { exact: true });
    if (await agent.count() > 0 && (await agent.evaluate((node) => node.tagName)) === 'SELECT') {
      const value = await agent.locator('option').nth(1).getAttribute('value');
      if (value) {
        await agent.selectOption(value);
        await expectToast(page, 'Agent set to');
      }
    }

    const fallback = panel.getByLabel('Fallback model', { exact: true });
    const model = await fallback.locator('option').nth(1).getAttribute('value');
    assert.ok(model, 'the fallback select offers at least one model');
    await fallback.selectOption(model);
    await panel.locator('.sheet-inline', { hasText: 'Changes apply after the session restarts.' }).waitFor();
    await panel.getByRole('button', { name: 'Restart session', exact: true }).click();
    await expectToast(page, 'Session restarted');

    const downloaded = page.waitForEvent('download');
    await panel.getByRole('button', { name: 'Export conversation', exact: true }).click();
    const download = await downloaded;
    assert.match(download.suggestedFilename(), /\.(md|json|txt)$/);
    const bytes = fs.readFileSync(await download.path());
    assert.ok(bytes.length > 0, 'the exported conversation is not empty');
    await page.keyboard.press('Escape');
    await panel.waitFor({ state: 'detached' });
  });
});

test('background tasks: the output viewer shows what a background command printed', { timeout: TEST_TIMEOUT_MS }, async () => {
  await withPage(browser, 'E6 task output', { baseURL: app.url }, async (ui) => {
    const { page } = ui;
    await signIn(page, app.url);
    await createSession(page, { title: 'Background task' });
    // The build runs in the foreground until the tool card's "Run in background" moves it; the turn then goes on.
    await sendMessage(page, 'background');
    await page.getByRole('button', { name: 'Run in background', exact: true }).click();

    const tasks = await openPanelFromSwitcher(page, 'Background tasks');
    const output = tasks.getByRole('button', { name: 'Output', exact: true }).first();
    await output.waitFor();
    await output.click();
    const viewer = page.getByRole('dialog', { name: /^Output/ });
    await viewer.waitFor();
    await eventually(async () => {
      const text = (await viewer.locator('.task-output').textContent()) ?? '';
      return text.trim() !== '' && text.trim() !== 'No output yet.';
    }, { message: 'the output viewer never showed the command output' });
    await viewer.getByRole('button', { name: 'Refresh', exact: true }).click();
    await viewer.getByRole('button', { name: 'Close', exact: true }).first().click();
    await viewer.waitFor({ state: 'detached' });
  });
});

test('MCP: authenticate a server by pasting the callback address, then see it connected', { timeout: TEST_TIMEOUT_MS }, async () => {
  await withPage(browser, 'E7 MCP authentication', { baseURL: app.url }, async (ui) => {
    const { page } = ui;
    await signIn(page, app.url);
    await createSession(page, { title: 'MCP sign-in' });
    const panel = await openPanelFromSwitcher(page, 'Capabilities');

    const row = panel.locator('.item', { hasText: 'mock-oauth' }).first();
    await row.getByRole('button', { name: 'Authenticate', exact: true }).click();
    const link = panel.locator('.mcp-auth a').first();
    await link.waitFor();
    const state = new URL(await link.getAttribute('href') ?? '').searchParams.get('state') ?? '';
    assert.notEqual(state, '', 'the authorization address carries a state');

    await panel.getByPlaceholder('http://localhost:…/callback?code=…').fill(
      `http://localhost:54545/callback?code=e2e&state=${encodeURIComponent(state)}`);
    await panel.getByRole('button', { name: 'Submit', exact: true }).click();
    await eventually(async () => (await row.locator('.chip', { hasText: 'Connected' }).count()) > 0,
      { message: 'mock-oauth never reported Connected' });
    await page.keyboard.press('Escape');
    await panel.waitFor({ state: 'detached' });
  });
});

test('account: the runtime sign-in steps, with a pasted code, sign the account in', { timeout: TEST_TIMEOUT_MS }, async () => {
  await withPage(browser, 'E8 account sign-in', { baseURL: app.url }, async (ui) => {
    const { page } = ui;
    await signIn(page, app.url);
    await createSession(page, { title: 'Account sign-in' });
    const panel = await openPanelFromSwitcher(page, 'Settings');

    await panel.getByRole('button', { name: 'Sign in with Claude', exact: true }).click();
    const link = panel.getByRole('link', { name: 'Open sign-in page', exact: true });
    await link.waitFor();
    const state = new URL(await link.getAttribute('href') ?? '').searchParams.get('state') ?? '';
    assert.notEqual(state, '', 'the sign-in address carries a state');

    await panel.getByLabel('Sign-in code', { exact: true }).fill(`mock-code#${state}`);
    await panel.getByRole('button', { name: 'Submit code', exact: true }).click();
    await expectToast(page, 'Signed in as');
    await panel.locator('.account .chip', { hasText: 'Signed in' }).waitFor();
    await page.keyboard.press('Escape');
    await panel.waitFor({ state: 'detached' });
  });
});
