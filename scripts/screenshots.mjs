// @ts-check

/**
 * Renders the README screenshots from a live gateway: desktop light, desktop dark and phone. The gateway runs the mock
 * engine with auth off, on a demo workspace under the OS temporary directory. The conversation is scripted through the
 * UI, so every picture shows what a user would see. Everything temporary is removed at the end.
 *
 * Usage: node scripts/screenshots.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startServer } from '../src/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'docs', 'screenshots');
const DEMO_DIR_NAME = 'agent-web-demo';
const PROJECT = 'acme-web';
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const TITLE_PORT = 'Read PORT from the environment';
const TITLE_ROUTING = 'Explore the routing layer';
const TITLE_UPLOAD = 'Fix flaky upload test';
const STEP_TIMEOUT_MS = 20_000;

/** The demo project. The mock engine's edit scenario talks about src/app.js, so the file matches it. */
const PROJECT_FILES = {
  'package.json': '{\n  "name": "acme-web",\n  "version": "0.1.0",\n  "private": true,\n'
    + '  "scripts": {\n    "start": "node src/app.js",\n    "test": "node --test"\n  }\n}\n',
  'README.md': '# acme-web\n\nA small web app that serves a health endpoint.\n',
  'src/app.js': [
    "import express from 'express';",
    '',
    'const app = express();',
    'const port = 3000;',
    '',
    "app.get('/', (req, res) => {",
    "  res.send('Hello from the demo app');",
    '});',
    '',
    "app.get('/health', (req, res) => {",
    '  res.json({ ok: true });',
    '});',
    '',
    'app.listen(port, () => {',
    '  process.stdout.write(`Listening on ${port}\\n`);',
    '});',
    '',
  ].join('\n'),
  'test/app.test.js': "import { test } from 'node:test';\n\ntest('health endpoint', () => {});\n",
};

/**
 * Scrolls the timeline so that the diff card and the todo list share the visible part of the transcript, with the
 * composer below it. Cards that are collapsed are opened first. Returns a short report of what it did.
 */
const FRAME_CHANGES = `(() => {
  const scroller = document.querySelector('.tl-scroll');
  const diffBody = document.querySelector('.tl-scroll .tool-diff-view');
  const todoBody = document.querySelector('.tl-scroll .tool-todos');
  if (!scroller || !diffBody || !todoBody) return 'missing';
  const diff = diffBody.closest('details');
  const todo = todoBody.closest('details');
  for (const card of [diff, todo]) {
    let node = card;
    while (node) {
      node.open = true;
      node = node.parentElement ? node.parentElement.closest('details') : null;
    }
  }
  const frame = scroller.getBoundingClientRect();
  const offset = (element) => element.getBoundingClientRect().top - frame.top + scroller.scrollTop;
  const top = offset(diff);
  const todoBottom = offset(todo) + todo.getBoundingClientRect().height;
  // When the diff, the todo card and the last turn's footer fit together, the frame ends below that footer, so no line
  // of text is cut by the edge of the conversation.
  const results = [...scroller.querySelectorAll('.turn-result')];
  const last = results[results.length - 1];
  const footerBottom = last ? offset(last) + last.getBoundingClientRect().height : todoBottom;
  const margin = 12;
  const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const clamp = (value) => Math.min(max, Math.max(0, value));
  const high = clamp(top - margin);
  const low = clamp(todoBottom - scroller.clientHeight + margin);
  const end = clamp(Math.max(todoBottom, footerBottom) - scroller.clientHeight + margin);
  const fits = low <= high;
  scroller.scrollTop = fits ? (end <= high ? end : high) : low;
  return JSON.stringify({ fits, scrollTop: Math.round(scroller.scrollTop), max: Math.round(max) });
})()`;

/** Moves the pointer off the transcript and closes anything that could appear in a picture by accident. */
const QUIET_PAGE = `(() => {
  for (const button of document.querySelectorAll('.toast-close')) button.click();
  return document.querySelectorAll('.toast').length;
})()`;

/**
 * Creates a session through the New session dialog. The dialog opens in the folder of the last session started in this
 * browser, so the project row is only clicked while that folder is not the one shown.
 * @param {import('playwright-core').Page} page
 * @param {string} title
 * @returns {Promise<string>} the session id
 */
async function createSession(page, title) {
  await page.getByRole('button', { name: 'New session', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New session', exact: true });
  await dialog.waitFor();
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  for (;;) {
    const shown = (await dialog.locator('.dir-path').textContent()) ?? '';
    if (shown.endsWith(`/${PROJECT}`)) break;
    if (Date.now() > deadline) throw new Error('the New session dialog never showed the project folder');
    const row = dialog.locator('.dir-row', { hasText: PROJECT });
    if ((await row.count()) > 0) await row.first().click();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await dialog.getByPlaceholder('A name for this session').fill(title);
  await dialog.getByRole('button', { name: 'Start session', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.waitForFunction('/^#\\/s\\/[0-9a-f-]{36}$/i.test(location.hash)');
  await page.locator('.session-main[aria-current="true"]', { hasText: title }).waitFor({ state: 'attached' });
  const match = /^#\/s\/([0-9a-f-]{36})$/i.exec(new URL(page.url()).hash);
  if (!match) throw new Error('the new session has no id in the address');
  return match[1];
}

/**
 * Sends one message and waits until the n-th turn has finished (the result line and an idle header).
 * @param {import('playwright-core').Page} page
 * @param {string} text
 * @param {number} turn
 */
async function sendAndWait(page, text, turn) {
  await page.locator('.composer-input').fill(text);
  await page.locator('.composer-send').click();
  await page.locator('.msg-user', { hasText: text }).first().waitFor({ state: 'attached' });
  await page.locator('.turn-result').nth(turn - 1).waitFor({ state: 'attached' });
  await page.locator('.state-badge[data-state="idle"]').waitFor({ state: 'attached' });
}

/**
 * Scripts the curated conversation of the first session: a question, an edit that needs approval, and a todo list.
 * @param {import('playwright-core').Page} page
 */
async function curatedConversation(page) {
  await sendAndWait(page, 'How is the server configured?', 1);

  await page.locator('.composer-input').fill('edit the port handling');
  await page.locator('.composer-send').click();
  const permission = page.locator('section.request-card[data-kind="permission"][data-state="ready"]');
  await permission.waitFor();
  await permission.getByRole('button', { name: 'Allow', exact: true }).click();
  await page.locator('.turn-result').nth(1).waitFor({ state: 'attached' });
  await page.locator('.state-badge[data-state="idle"]').waitFor({ state: 'attached' });

  // The mock engine picks its scenario from the first keyword it finds, and "plan" is checked before "todo". The
  // wording below reaches the todo scenario; "todo plan the release" would open a plan review instead.
  await sendAndWait(page, 'todo list for the release', 3);
}

/**
 * Opens the work groups and the two cards that the picture is about: the Edit card with its diff, and the todo list.
 * A card builds its body the first time it is opened, so these are real clicks.
 * @param {import('playwright-core').Page} page
 */
async function openChangeCards(page) {
  const groups = page.locator('details.work:not([open]) > summary.work-summary');
  for (let clicks = 0; clicks < 30 && (await groups.count()) > 0; clicks += 1) {
    await groups.first().click();
  }
  const cards = [
    page.locator('details.tool-card[data-tool-family="file"]:has(.tool-chip-success)').first(),
    page.locator('details.tool-card[data-tool-family="todo"]').first(),
  ];
  for (const card of cards) {
    if (!(await card.evaluate((node) => node.open))) await card.locator('summary.tool-head').first().click();
  }
  await page.locator('.tl-scroll .tool-diff-view').first().waitFor({ state: 'attached' });
  await page.locator('.tl-scroll .tool-todos').first().waitFor({ state: 'attached' });
}

/**
 * Makes the picture quiet and frames the changes. Throws when the frame cannot be found.
 * @param {import('playwright-core').Page} page
 * @param {string} label
 */
async function frameChanges(page, label) {
  await page.evaluate(QUIET_PAGE);
  await page.locator('.toast').first().waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await openChangeCards(page);
  const report = await page.evaluate(FRAME_CHANGES);
  if (report === 'missing') throw new Error(`${label}: the diff card or the todo list is not on the page`);
  process.stdout.write(`${label}: framed ${report}\n`);
  await page.mouse.move(1, 1);
  const overlays = await page.locator('[role="menu"], [role="listbox"], [role="dialog"]').count();
  if (overlays > 0) throw new Error(`${label}: ${overlays} menu, list or dialog is still open`);
}

/**
 * Writes one picture into docs/screenshots and reports its size.
 * @param {import('playwright-core').Page} page
 * @param {string} name
 */
async function capture(page, name) {
  const file = path.join(OUT_DIR, name);
  await page.screenshot({ path: file, type: 'png', animations: 'disabled', caret: 'hide' });
  const bytes = fs.statSync(file).size;
  process.stdout.write(`${name}: ${bytes} bytes (${(bytes / 1024).toFixed(1)} KiB)\n`);
}

async function main() {
  const demoRoot = path.join(os.tmpdir(), DEMO_DIR_NAME);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'caw-shots-'));
  const stateDir = path.join(scratch, 'state');
  const home = path.join(scratch, 'home');
  /** @type {Awaited<ReturnType<typeof startServer>> | null} */
  let server = null;
  /** @type {import('playwright-core').Browser | null} */
  let browser = null;
  try {
    fs.rmSync(demoRoot, { recursive: true, force: true });
    for (const [relative, content] of Object.entries(PROJECT_FILES)) {
      const target = path.join(demoRoot, PROJECT, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    const root = fs.realpathSync(demoRoot);
    for (const dir of [stateDir, home]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(OUT_DIR, { recursive: true });

    server = await startServer({
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        CAW_ENGINE: 'mock',
        CAW_MOCK_DELAY_MS: '12',
        CAW_REQUIRE_AUTH: '0',
        CAW_WORKSPACE_ROOTS: root,
        CAW_STATE_DIR: stateDir,
        CAW_LOG_LEVEL: 'error',
      },
      listenHost: '127.0.0.1',
      listenPort: 0,
    });
    const url = server.url;
    browser = await chromium.launch({ executablePath: process.env.CAW_CHROMIUM_PATH || undefined });

    // Desktop, light: the sessions are created here, then the scripted conversation runs in the first of them.
    const desktop = await browser.newContext({ viewport: DESKTOP, colorScheme: 'light', locale: 'en-US' });
    const page = await desktop.newPage();
    await page.goto(url);
    await page.locator('.sidebar-new').waitFor({ state: 'attached' });
    await createSession(page, TITLE_ROUTING);
    await createSession(page, TITLE_UPLOAD);
    const portId = await createSession(page, TITLE_PORT);
    await curatedConversation(page);
    await frameChanges(page, 'desktop light');
    await capture(page, 'desktop-light.png');

    // Desktop, dark: the same view after choosing Dark in Settings, with the scroll position kept.
    const scrollBefore = await page.evaluate("document.querySelector('.tl-scroll').scrollTop");
    await page.locator('button[aria-label="Settings"]').first().click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.waitFor();
    await settings.locator('.seg-btn[data-value="dark"]').click();
    await settings.getByRole('button', { name: 'Close', exact: true }).click();
    await settings.waitFor({ state: 'detached' });
    await page.evaluate(`document.querySelector('.tl-scroll').scrollTop = ${Number(scrollBefore)}`);
    await frameChanges(page, 'desktop dark');
    await capture(page, 'desktop-dark.png');

    // Phone, light, two pixels per CSS pixel: the same session, opened from its address.
    const phone = await browser.newContext({
      viewport: PHONE,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      colorScheme: 'light',
      locale: 'en-US',
    });
    const handset = await phone.newPage();
    await handset.goto(`${url}/#/s/${portId}`);
    await handset.locator('.msg-assistant').first().waitFor({ state: 'attached' });
    await handset.locator('.turn-result').nth(2).waitFor({ state: 'attached' });
    await frameChanges(handset, 'phone');
    await capture(handset, 'mobile.png');
  } finally {
    await browser?.close();
    await server?.close();
    fs.rmSync(demoRoot, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
