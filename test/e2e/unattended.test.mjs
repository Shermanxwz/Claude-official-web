/**
 * Unattended mode in the browser, against a real gateway (mock engine). The gateway runs with CAW_UNATTENDED=1, so the
 * switch is on and every request is answered by the gateway itself. The page is kept hidden (so a request that settled
 * would notify) and watched from before it loads: no request card, pending badge, "Needs you" state or title count may
 * appear for a request the gateway answers at once, and no request notification may fire. Each test ends with
 * assertClean(), like the journeys.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  createSession,
  eventually,
  launchBrowser,
  sendMessage,
  signIn,
  startApp,
  waitForTurnResult,
  withPage,
} from './helpers.mjs';

const TEST_TIMEOUT_MS = 90_000;
/** The environment of a gateway whose unattended switch is on. IS_SANDBOX lets a root test run allow bypass. */
const UNATTENDED_ENV = { CAW_UNATTENDED: '1', CAW_ACCESS_PROFILE: 'full', IS_SANDBOX: '1' };

/** @type {Awaited<ReturnType<typeof startApp>>} */
let app;
/** @type {import('playwright-core').Browser} */
let browser;

before(async () => {
  app = await startApp({ env: UNATTENDED_ENV });
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close();
  await app?.close();
});

/**
 * Runs before the app in every page: the page counts as hidden and notifications are recorded, the notification pref is
 * on, and a MutationObserver records anything a waiting request would show. Only the function body is serialized.
 */
function watchScript() {
  window.__flashes = [];
  window.__notes = [];
  class RecordingNotification {
    constructor(title, options = {}) {
      window.__notes.push({ title, body: options.body ?? '', tag: options.tag ?? '' });
    }

    static get permission() {
      return 'granted';
    }

    static requestPermission() {
      return Promise.resolve('granted');
    }

    close() {}
  }
  Object.defineProperty(window, 'Notification', { configurable: true, value: RecordingNotification });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  try {
    if (localStorage.getItem('caw.prefs') === null) localStorage.setItem('caw.prefs', JSON.stringify({ notify: true }));
  } catch {
    // Storage is unavailable: the notification pref stays at its default and the check still holds.
  }
  const WATCHED = [
    '.request-card', '.session-pending', '.badge-attention', '[data-state="attention"]',
    '[data-state="requires_action"]',
  ];
  const flag = (node) => {
    if (!(node instanceof Element)) return;
    const hit = [node, ...node.querySelectorAll('*')].find((el) => WATCHED.some((selector) => el.matches(selector)));
    if (hit) window.__flashes.push(hit.outerHTML.slice(0, 160));
  };
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'childList') record.addedNodes.forEach(flag);
      else if (record.target instanceof Element) flag(record.target);
    }
    if (/^\(\d+\)/.test(document.title)) window.__flashes.push(`title: ${document.title}`);
  });
  // The document itself: this script runs before the page has an element to watch.
  observer.observe(document, {
    childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-state', 'class'],
  });
}

/**
 * What the watch recorded so far.
 * @param {import('playwright-core').Page} page
 * @returns {Promise<{flashes: string[], notes: Array<{title: string, body: string, tag: string}>}>}
 */
function watched(page) {
  return page.evaluate(() => ({ flashes: window.__flashes, notes: window.__notes }));
}

/**
 * A request card that is still waiting for an answer.
 * @param {import('playwright-core').Page} page
 * @param {'permission'|'question'|'plan'|'elicitation'} kind
 */
function pendingCard(page, kind) {
  return page.locator(`section.request-card[data-kind="${kind}"][data-state="ready"]`);
}

/**
 * Opens Settings from the header's unattended pill, which opens it at the switch.
 * @param {import('playwright-core').Page} page
 */
async function openSettingsFromPill(page) {
  await page.locator('.hdr-unattended').click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.waitFor();
  return settings;
}

test('U1 the header shows the unattended pill, and the composer names the mode', { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'U1 pill and label', { baseURL: app.url }, async (ui) => {
    const { page } = ui;
    await page.addInitScript(watchScript);
    await signIn(page, app.url);
    await createSession(page, { title: 'Unattended pill' });

    const pill = page.locator('.hdr-unattended');
    await pill.waitFor({ state: 'visible' });
    assert.equal((await pill.textContent())?.trim(), 'Unattended');
    assert.equal(await page.locator('.composer-mode-text').textContent(), 'Unattended — no approvals');
    assert.equal(await page.locator('.composer-mode').isDisabled(), true, 'the composer mode cannot be changed');
    assert.equal(await page.locator('.hdr-mode').isDisabled(), true, 'the header permission select cannot be changed');

    await page.locator('.composer-input').click();
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.locator('.composer-mode-text').textContent(), 'Unattended — no approvals');
    assert.equal(await page.locator('.composer-footer.is-flash').count(), 0, 'Shift+Tab shows no mode change');
  }));

test('U2 a tool runs without asking when the switch is on from the start', { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'U2 tool on from the start', { baseURL: app.url }, async (ui) => {
    const { page } = ui;
    await page.addInitScript(watchScript);
    await signIn(page, app.url);
    await createSession(page, { title: 'Automatic tools' });

    await sendMessage(page, 'Run a tool to list the project');
    await waitForTurnResult(page, 1);
    // A query starts in bypassPermissions while the switch is on, so the tool needs no answer and raises no request.
    assert.equal(await page.locator('.work-item[data-tool="Bash"]').count(), 1, 'the tool ran');
    assert.equal(await page.locator('section.request-card').count(), 0, 'no approval card was shown');
    assert.equal(await page.locator('.work-auto').count(), 0, 'and no record, since nothing was asked');

    const { flashes, notes } = await watched(page);
    assert.deepEqual(flashes, [], 'nothing waited for the user: no card, badge, glyph or title count');
    assert.deepEqual(notes.filter((note) => note.tag.startsWith('request-')), [], 'no request notification');
  }));

test('U3 a permission that waits when the switch turns on is answered at once, and its record stays',
  { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'U3 pending permission', { baseURL: app.url }, async (ui) => {
    const { page } = ui;
    await page.addInitScript(watchScript);
    await signIn(page, app.url);
    await createSession(page, { title: 'Waiting permission' });

    // Off first: the query returns to the mode the session chose, so the tool asks.
    const settings = await openSettingsFromPill(page);
    const toggle = settings.getByRole('switch', { name: 'Unattended mode', exact: true });
    await toggle.click();
    await eventually(async () => (await toggle.getAttribute('aria-checked')) === 'false', {
      message: 'the switch did not turn off',
    });
    await settings.getByRole('button', { name: 'Close', exact: true }).first().click();
    await settings.waitFor({ state: 'detached' });

    await sendMessage(page, 'Run a tool to list the project');
    const card = pendingCard(page, 'permission');
    await card.waitFor();

    // On again, from Settings: the request that waits is answered by the gateway at once.
    await page.locator('button[aria-label="Settings"]').first().click();
    const again = page.getByRole('dialog', { name: 'Settings', exact: true });
    await again.waitFor();
    await again.getByRole('switch', { name: 'Unattended mode', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Turn on unattended mode?', exact: true });
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Turn on unattended mode', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });

    const record = page.locator('.work-auto', { hasText: 'Allowed automatically (unattended)' });
    await record.waitFor();
    assert.equal(await record.locator('.work-auto-tool').textContent(), 'Bash');
    assert.equal(await record.locator('.work-auto-target').textContent(), 'ls -la');
    await card.waitFor({ state: 'detached' });
    await waitForTurnResult(page, 1);
    assert.equal(await page.locator('section.request-card').count(), 0);
  }));

test('U4 a question is answered by the gateway, and the record keeps the question', { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'U4 automatic question', { baseURL: app.url }, async (ui) => {
    const { page } = ui;
    await page.addInitScript(watchScript);
    await signIn(page, app.url);
    await createSession(page, { title: 'Automatic question' });

    await sendMessage(page, 'Ask me a question before you continue');
    const record = page.locator('.work-auto', { hasText: 'Question answered automatically' });
    await record.waitFor();
    await waitForTurnResult(page, 1);
    // The gateway declined the question with its unattended message, so the assistant carries on with its defaults.
    await page.locator('.msg-assistant', { hasText: 'No problem, I will continue with sensible defaults.' }).waitFor();
    assert.equal(await page.locator('section.request-card').count(), 0);

    await record.locator('summary', { hasText: 'Show the question' }).click();
    assert.match(await record.locator('.work-auto-question').textContent() ?? '',
      /Which authentication method should the demo use\?/);
    const { flashes } = await watched(page);
    assert.deepEqual(flashes, []);
  }));

test('U5 turning it off from the pill brings the approval card back for the next tool',
  { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'U5 switch off', { baseURL: app.url }, async (ui) => {
    const { page } = ui;
    await page.addInitScript(watchScript);
    await signIn(page, app.url);
    await createSession(page, { title: 'Switch off' });

    const settings = await openSettingsFromPill(page);
    const toggle = settings.getByRole('switch', { name: 'Unattended mode', exact: true });
    assert.equal(await toggle.getAttribute('aria-checked'), 'true');
    assert.equal(await toggle.isDisabled(), false, 'the full profile may switch it');
    await toggle.click();
    await eventually(async () => (await toggle.getAttribute('aria-checked')) === 'false', {
      message: 'the switch did not turn off',
    });
    // Turning it off asks nothing.
    assert.equal(await page.getByRole('dialog', { name: 'Turn on unattended mode?', exact: true }).count(), 0);
    await page.locator('.hdr-unattended').waitFor({ state: 'hidden' });
    await settings.getByRole('button', { name: 'Close', exact: true }).first().click();
    await settings.waitFor({ state: 'detached' });

    await sendMessage(page, 'Run a tool to list the project');
    const card = pendingCard(page, 'permission');
    await card.waitFor();
    await card.getByRole('button', { name: 'Allow', exact: true }).click();
    await waitForTurnResult(page, 1);
    // A request the user answers by hand waited for them, so it notified; an automatic answer leaves no such record.
    const { notes } = await watched(page);
    assert.ok(notes.some((note) => note.tag.startsWith('request-')), 'a request that waited for the user notified');
    assert.equal(await page.locator('.work-auto').count(), 0);
  }));

test('U6 turning it on asks first: Cancel keeps it off, and the button turns it on',
  { timeout: TEST_TIMEOUT_MS }, async () => {
  const bypass = await startApp({ env: { CAW_ALLOW_BYPASS: '1', IS_SANDBOX: '1', CAW_ACCESS_PROFILE: 'full' } });
  try {
    await withPage(browser, 'U6 confirm on', { baseURL: bypass.url }, async (ui) => {
      const { page } = ui;
      await signIn(page, bypass.url);
      await page.locator('button[aria-label="Settings"]').first().click();
      const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
      await settings.waitFor();
      const toggle = settings.getByRole('switch', { name: 'Unattended mode', exact: true });
      await eventually(async () => !(await toggle.isDisabled()), { message: 'the switch never became available' });
      assert.equal(await toggle.getAttribute('aria-checked'), 'false');

      await toggle.click();
      const dialog = page.getByRole('dialog', { name: 'Turn on unattended mode?', exact: true });
      await dialog.waitFor();
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
      assert.equal(await toggle.getAttribute('aria-checked'), 'false');
      assert.equal(await page.locator('.hdr-unattended').isVisible(), false, 'no pill while the switch is off');

      await toggle.click();
      await dialog.waitFor();
      await dialog.getByRole('button', { name: 'Turn on unattended mode', exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
      await eventually(async () => (await toggle.getAttribute('aria-checked')) === 'true', {
        message: 'the switch did not turn on',
      });
      await page.locator('.hdr-unattended').waitFor({ state: 'visible' });
    });
  } finally {
    await bypass.close();
  }
});

test('U7 a gateway without the switch shows it disabled, with the reason', { timeout: TEST_TIMEOUT_MS }, async () => {
  const plain = await startApp({ env: {} });
  try {
    await withPage(browser, 'U7 disabled switch', { baseURL: plain.url }, async (ui) => {
      const { page } = ui;
      await signIn(page, plain.url);
      await page.locator('button[aria-label="Settings"]').first().click();
      const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
      await settings.waitFor();
      const toggle = settings.getByRole('switch', { name: 'Unattended mode', exact: true });
      await settings.getByText('Turn it on with CAW_UNATTENDED=1 on the server.', { exact: true }).waitFor();
      assert.equal(await toggle.isDisabled(), true);
      assert.equal(await toggle.getAttribute('aria-checked'), 'false');
      assert.equal(await page.locator('.hdr-unattended').isVisible(), false, 'no pill without unattended mode');
    });
  } finally {
    await plain.close();
  }
});
