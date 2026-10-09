/**
 * The phone layout (390x844, touch), the dark theme and the Chinese interface. One gateway and one Chromium serve the
 * file; every test opens its own browser context and ends with assertClean().
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  MOBILE,
  createSession,
  eventually,
  launchBrowser,
  sendMessage,
  sessionIdOf,
  signIn,
  startApp,
  waitForTurnResult,
  withPage,
} from './helpers.mjs';

const TEST_TIMEOUT_MS = 90_000;
const PHONE = { viewport: MOBILE, isMobile: true, hasTouch: true };

/** @type {Awaited<ReturnType<typeof startApp>>} */
let app;
/** @type {import('playwright-core').Browser} */
let browser;

before(async () => {
  app = await startApp({ env: { CAW_MAX_LIVE_SESSIONS: '16' } });
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close();
  await app?.close();
});

/**
 * Fails when the document is wider than the viewport, which is what a horizontal scrollbar on a phone means.
 * @param {import('playwright-core').Page} page
 * @param {string} label
 */
async function assertNoHorizontalOverflow(page, label) {
  const sizes = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  assert.ok(sizes.scroll <= sizes.client, `${label}: the page is ${sizes.scroll}px wide in a ${sizes.client}px viewport`);
}

/**
 * Opens the sidebar drawer on a phone, unless it is open already. Returns once the drawer's controls are visible: the
 * drawer slides in over 220 ms, and its controls stay hidden until the slide has started.
 * @param {import('playwright-core').Page} page
 */
async function openDrawer(page) {
  const layout = page.locator('.app');
  if ((await layout.getAttribute('data-sidebar')) !== 'open') {
    await page.locator('.hdr-menu, .app-reopen').filter({ visible: true }).first().click();
  }
  await eventually(async () => (await layout.getAttribute('data-sidebar')) === 'open', {
    message: 'the sidebar drawer did not open',
  });
  await page.locator('.sidebar-new').waitFor({ state: 'visible' });
}

/**
 * Starts a session the way a phone does: from the drawer, whose New session button is the only one once a session
 * exists. Choosing the new session closes the drawer again.
 * @param {import('playwright-core').Page} page
 * @param {string} title
 * @returns {Promise<string>}
 */
async function newSessionOnPhone(page, title) {
  await openDrawer(page);
  return createSession(page, { title });
}

/**
 * Relative luminance (0 to 1) of an rgb() or rgba() colour string.
 * @param {string} color
 */
function luminance(color) {
  const [red, green, blue] = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
  const channel = (value) => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

test('M1 the sign-in page and a session fit a phone without horizontal scrolling', { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'M1 no horizontal overflow', { baseURL: app.url, ...PHONE }, async (ui) => {
    const { page } = ui;
    await page.goto(app.url);
    await page.getByLabel('Access token').waitFor();
    await assertNoHorizontalOverflow(page, 'sign-in');

    await signIn(page, app.url);
    await newSessionOnPhone(page, 'Phone layout');
    await page.locator('.composer-input').waitFor();
    await assertNoHorizontalOverflow(page, 'empty session');

    // A long unbroken token must wrap or scroll inside its own element, never widen the page.
    await sendMessage(page, `Check this link https://example.com/${'segment'.repeat(30)}`);
    await waitForTurnResult(page, 1);
    await assertNoHorizontalOverflow(page, 'answered session');
  }));

test('M2 the hamburger opens the drawer, and choosing a session closes it', { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'M2 drawer and session choice', { baseURL: app.url, ...PHONE }, async (ui) => {
    const { page } = ui;
    await signIn(page, app.url);
    const first = await newSessionOnPhone(page, 'Phone one');
    await eventually(async () => (await page.locator('.app').getAttribute('data-sidebar')) === 'closed', {
      message: 'creating a session did not close the drawer',
    });

    await newSessionOnPhone(page, 'Phone two');
    await eventually(async () => (await page.locator('.app').getAttribute('data-sidebar')) === 'closed', {
      message: 'the drawer stayed open after a new session was started',
    });

    await openDrawer(page);
    await page.locator('li.session-row', { hasText: 'Phone one' }).locator('.session-main').click();
    await eventually(async () => (await page.locator('.app').getAttribute('data-sidebar')) === 'closed', {
      message: 'the drawer stayed open after a session was chosen',
    });
    assert.equal(sessionIdOf(page), first);
  }));

test('M2b tapping the session that is already open closes the drawer', {
  timeout: TEST_TIMEOUT_MS,
}, () =>
  withPage(browser, 'M2b tap the open session', { baseURL: app.url, ...PHONE }, async (ui) => {
    const { page } = ui;
    await signIn(page, app.url);
    await newSessionOnPhone(page, 'Phone current');

    await openDrawer(page);
    await page.locator('li.session-row', { hasText: 'Phone current' }).locator('.session-main').tap();
    await eventually(async () => (await page.locator('.app').getAttribute('data-sidebar')) === 'closed', {
      message: 'the drawer stayed open after the session that was already open was tapped',
    });
  }));

test('M3 the send button shows its icon on a phone', { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'M3 send icon', { baseURL: app.url, ...PHONE }, async (ui) => {
    const { page } = ui;
    await signIn(page, app.url);
    await newSessionOnPhone(page, 'Send icon');

    const send = page.locator('.composer-send');
    await send.waitFor();
    const buttonBox = await send.boundingBox();
    assert.ok(buttonBox && buttonBox.width > 0 && buttonBox.height > 0, 'the send button has no size');
    const icon = send.locator('.icon');
    const iconBox = await icon.boundingBox();
    assert.ok(iconBox && iconBox.width > 0 && iconBox.height > 0, 'the send icon has no size');
    const style = await icon.evaluate((node) => {
      const computed = getComputedStyle(node);
      return {
        background: computed.backgroundColor,
        mask: computed.maskImage || computed.webkitMaskImage,
        opacity: computed.opacity,
        visibility: computed.visibility,
      };
    });
    assert.equal(style.visibility, 'visible');
    assert.notEqual(style.opacity, '0');
    assert.notEqual(style.background, 'rgba(0, 0, 0, 0)', 'the send icon paints nothing');
    assert.match(style.mask, /send\.svg/, 'the send icon has no mask image');
    assert.equal(await send.getAttribute('aria-label'), 'Send');

    const asset = await page.request.get(new URL('/img/icons/send.svg', app.url).href);
    assert.equal(asset.status(), 200);
  }));

test('M4 a permission card fits the phone and its buttons can be tapped', { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'M4 permission on a phone', { baseURL: app.url, ...PHONE }, async (ui) => {
    const { page } = ui;
    await signIn(page, app.url);
    await newSessionOnPhone(page, 'Phone approval');

    await sendMessage(page, 'Run a tool on the phone');
    const card = page.locator('section.request-card[data-kind="permission"][data-state="ready"]');
    await card.waitFor();
    await card.scrollIntoViewIfNeeded();
    const cardBox = await card.boundingBox();
    assert.ok(cardBox.x >= 0 && cardBox.x + cardBox.width <= MOBILE.width, 'the permission card is wider than the phone');

    const allow = card.getByRole('button', { name: 'Allow', exact: true });
    await allow.waitFor();
    const allowBox = await allow.boundingBox();
    assert.ok(allowBox.x >= 0 && allowBox.x + allowBox.width <= MOBILE.width, 'the Allow button is off screen');
    await allow.tap();
    await waitForTurnResult(page, 1);
    assert.equal(await page.locator('section.request-card[data-kind="permission"][data-state="ready"]').count(), 0);
  }));

test('T1 Settings switches to the dark theme, and the page background follows', { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'T1 dark theme', { baseURL: app.url }, async (ui) => {
    const { page } = ui;
    await signIn(page, app.url);
    await createSession(page, { title: 'Theme check' });

    const lightBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.ok(luminance(lightBackground) > 0.8, `the light page background is ${lightBackground}`);

    await page.locator('button[aria-label="Settings"]').first().click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.waitFor();
    await settings.locator('.seg-btn[data-value="dark"]').click();

    await eventually(() => page.evaluate(() => document.documentElement.dataset.theme === 'dark'), {
      message: 'the document did not switch to the dark theme',
    });
    const darkBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.ok(luminance(darkBackground) < 0.05, `the dark page background is ${darkBackground}`);
  }));

test('T2 the interface switches to 简体中文, and the choice survives a reload', { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'T2 Chinese interface', { baseURL: app.url }, async (ui) => {
    const { page } = ui;
    await signIn(page, app.url);
    await page.getByRole('button', { name: 'New session', exact: true }).first().waitFor();

    await page.locator('button[aria-label="Settings"]').first().click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.waitFor();
    await settings.getByLabel('Language', { exact: true }).selectOption('zh-CN');
    await page.getByRole('button', { name: '新建会话', exact: true }).first().waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'zh-CN');

    await page.reload();
    await page.getByRole('button', { name: '新建会话', exact: true }).first().waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'zh-CN');
  }));
