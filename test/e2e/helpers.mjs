/**
 * Shared harness for the browser suite. startApp starts the gateway on a loopback port with the mock engine and a
 * temporary workspace; newPage opens a Chromium context that records what the page reports (console errors, uncaught
 * errors, failed responses and failed requests); the UI steps below are the ones the journeys share. Nothing here
 * changes product code.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startServer } from '../../src/server.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ARTIFACT_DIR = path.join(REPO_ROOT, 'test', 'e2e', 'artifacts');
export const TOKEN = 'e2e-test-token-1234567890';
export const PROJECT = 'acme-web';
export const DESKTOP = Object.freeze({ width: 1440, height: 900 });
export const MOBILE = Object.freeze({ width: 390, height: 844 });

const TIMEOUT_MS = 15000;
const IGNORED_CONSOLE_MESSAGE = /^Failed to load resource/;
const IGNORED_REQUEST_FAILURE = /^net::ERR_ABORTED/;
/** A 1x1 transparent PNG, small enough to upload in every test. */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

/** The demo project: the files the mock scenarios talk about. */
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
 * Writes the demo project below `project`.
 * @param {string} project
 */
export function writeProject(project) {
  for (const [relative, content] of Object.entries(PROJECT_FILES)) {
    const target = path.join(project, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

/**
 * Starts a gateway with its own temporary workspace (root/acme-web), state directory and home directory.
 * @param {{auth?: boolean, env?: Record<string, string>}} [options]
 * @returns {Promise<{url: string, root: string, project: string, png: string, close: () => Promise<void>}>}
 */
export async function startApp({ auth = true, env = {} } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caw-e2e-')));
  const root = path.join(base, 'workspace');
  const project = path.join(root, PROJECT);
  const stateDir = path.join(base, 'state');
  const home = path.join(base, 'home');
  const scratch = path.join(base, 'scratch');
  const png = path.join(scratch, 'pixel.png');
  /** @type {Awaited<ReturnType<typeof startServer>> | null} */
  let running = null;
  try {
    writeProject(project);
    for (const dir of [stateDir, home, scratch]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(png, PNG_BYTES);
    running = await startServer({
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        CAW_ENGINE: 'mock',
        CAW_MOCK_DELAY_MS: '2',
        CAW_REQUIRE_AUTH: auth ? '1' : '0',
        CAW_TOKEN: TOKEN,
        CAW_WORKSPACE_ROOTS: root,
        CAW_STATE_DIR: stateDir,
        CAW_LOG_LEVEL: 'error',
        CAW_MAX_LIVE_SESSIONS: '8',
        ...env,
      },
      listenHost: '127.0.0.1',
      listenPort: 0,
    });
  } catch (error) {
    fs.rmSync(base, { recursive: true, force: true });
    throw error;
  }
  const handle = running;
  let closing = null;
  return {
    url: handle.url,
    root,
    project,
    png,
    close() {
      closing ??= handle.close().finally(() => fs.rmSync(base, { recursive: true, force: true }));
      return closing;
    },
  };
}

/** Chromium for the whole file. CAW_CHROMIUM_PATH overrides the Playwright-managed browser. */
export function launchBrowser() {
  return chromium.launch({ executablePath: process.env.CAW_CHROMIUM_PATH || undefined });
}

/**
 * @param {string} text
 * @returns {string} a file-name-safe form of a test name
 */
function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'test';
}

/**
 * Opens a browser context and a page. The page records console errors, uncaught page errors, HTTP responses with a
 * status of 400 or more (except /favicon.ico) and failed requests. Browser messages about failed resource loads are
 * left to the response record, which has the URL and status.
 * @param {import('playwright-core').Browser} browser
 * @param {{baseURL?: string, testName?: string} & import('playwright-core').BrowserContextOptions} [options]
 */
export async function newPage(browser, { baseURL, testName = 'page', ...contextOptions } = {}) {
  const context = await browser.newContext({
    baseURL,
    viewport: DESKTOP,
    locale: 'en-US',
    ...contextOptions,
  });
  if (baseURL) await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL });
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT_MS);

  /** @type {string[]} */
  const problems = [];
  /** @type {Array<(method: string, pathname: string, status: number) => boolean>} */
  const expected = [];
  let closed = false;

  page.on('console', (message) => {
    if (message.type() !== 'error' || IGNORED_CONSOLE_MESSAGE.test(message.text())) return;
    problems.push(`console error: ${message.text()}`);
  });
  page.on('pageerror', (error) => {
    problems.push(`page error: ${error.message}`);
  });
  page.on('response', (response) => {
    const status = response.status();
    const url = new URL(response.url());
    if (status < 400 || url.pathname === '/favicon.ico') return;
    const method = response.request().method();
    if (expected.some((match) => match(method, url.pathname, status))) return;
    problems.push(`HTTP ${status} ${method} ${url.pathname}`);
  });
  page.on('requestfailed', (request) => {
    const reason = request.failure()?.errorText ?? 'unknown';
    if (!IGNORED_REQUEST_FAILURE.test(reason)) problems.push(`request failed (${reason}): ${request.url()}`);
  });

  return {
    page,
    context,
    /**
     * Declares one failed response as expected, for example the 401 of a wrong token.
     * @param {{method: string, path: string, status: number}} rule
     */
    allowFailure(rule) {
      expected.push((method, pathname, status) => method === rule.method && pathname === rule.path
        && status === rule.status);
    },
    /** Fails when the page reported anything unexpected. */
    assertClean() {
      assert.deepEqual(problems, [], `the page reported problems:\n${problems.join('\n')}`);
    },
    /** Saves the current page to test/e2e/artifacts, so a failed run can be looked at. Never throws. */
    async saveFailureScreenshot(name = testName) {
      try {
        if (closed) return;
        fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(ARTIFACT_DIR, `${slug(name)}.png`), fullPage: false });
      } catch {
        // The screenshot is evidence for a failure that is already being reported; losing it must not hide that.
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await context.close();
    },
  };
}

/**
 * Runs one test body on a fresh page. The page must end without reported problems; on any failure the page is saved
 * to test/e2e/artifacts before the error is rethrown.
 * @template T
 * @param {import('playwright-core').Browser} browser
 * @param {string} testName
 * @param {Parameters<typeof newPage>[1]} options
 * @param {(ui: Awaited<ReturnType<typeof newPage>>) => Promise<T>} body
 * @returns {Promise<T>}
 */
export async function withPage(browser, testName, options, body) {
  const ui = await newPage(browser, { ...options, testName });
  try {
    const result = await body(ui);
    ui.assertClean();
    return result;
  } catch (error) {
    await ui.saveFailureScreenshot(testName);
    throw error;
  } finally {
    await ui.close();
  }
}

/**
 * Polls `check` until it returns a truthy value.
 * @template T
 * @param {() => Promise<T> | T} check
 * @param {{timeout?: number, message?: string}} [options]
 * @returns {Promise<T>}
 */
export async function eventually(check, { timeout = TIMEOUT_MS, message = 'the condition was never met' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await check();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) throw new Error(`${message} (last value: ${String(last)})`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Shared UI steps
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Opens the app at its root and signs in with the token. Waits until the session list has loaded (either its rows or
 * its empty state), so that the first click does not race the boot. The sidebar is attached rather than visible,
 * because on a phone the closed drawer hides it.
 * @param {import('playwright-core').Page} page
 * @param {string} url
 * @param {string} [token]
 */
export async function signIn(page, url, token = TOKEN) {
  await page.goto(url);
  await page.getByLabel('Access token').fill(token);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('.sidebar-new').waitFor({ state: 'attached' });
  await page.locator('.sidebar-empty, .session-main').first().waitFor({ state: 'attached' });
}

/**
 * Creates a session through the New session dialog: opens the dialog, enters the folder, optionally titles the
 * session and starts it. Returns the new session id from the URL hash. The dialog trusts an untrusted folder by default;
 * `trust: false` leaves the folder untrusted, so the session starts with user settings only.
 * @param {import('playwright-core').Page} page
 * @param {{folder?: string, title?: string, trust?: boolean}} [options]
 * @returns {Promise<string>}
 */
export async function createSession(page, { folder = PROJECT, title, trust = true } = {}) {
  await page.getByRole('button', { name: 'New session', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New session', exact: true });
  await dialog.waitFor();
  // The dialog opens in the folder of the last session started in this browser, so the row is only clicked while
  // that folder is not the one shown.
  await eventually(async () => {
    const shown = (await dialog.locator('.dir-path').textContent()) ?? '';
    if (shown.endsWith(`/${folder}`)) return true;
    const row = dialog.locator('.dir-row', { hasText: folder });
    if ((await row.count()) > 0) await row.first().click();
    return false;
  }, { message: `the New session dialog never showed the folder ${folder}` });
  if (title) await dialog.getByPlaceholder('A name for this session').fill(title);
  if (!trust) {
    // The trust notice shows only while the folder on screen is untrusted; its checkbox is what applies trust.
    const checkbox = dialog.locator('.trust-notice input[type="checkbox"]');
    await checkbox.waitFor({ state: 'attached' });
    await checkbox.uncheck();
  }
  await dialog.getByRole('button', { name: 'Start session', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.waitForFunction(() => /^#\/s\/[0-9a-f-]{36}$/i.test(location.hash));
  await page.locator('.session-main[aria-current="true"]').waitFor({ state: 'attached' });
  return sessionIdOf(page);
}

/**
 * @param {import('playwright-core').Page} page
 * @returns {string} the session id in the URL hash, or '' when none is selected
 */
export function sessionIdOf(page) {
  const match = /^#\/s\/([0-9a-f-]{36})$/i.exec(new URL(page.url()).hash);
  return match ? match[1] : '';
}

/**
 * Types a message in the composer and sends it with the Send button. Returns once the message is in the timeline.
 * @param {import('playwright-core').Page} page
 * @param {string} text
 */
export async function sendMessage(page, text) {
  await page.locator('.composer-input').fill(text);
  await page.locator('.composer-send').click();
  await page.locator('.msg-user', { hasText: text }).first().waitFor();
}

/**
 * Waits until the n-th turn result (1-based) is shown and the session reports idle.
 * @param {import('playwright-core').Page} page
 * @param {number} n
 */
export async function waitForTurnResult(page, n) {
  await page.locator('.turn-result').nth(n - 1).waitFor();
  await page.locator('.state-badge[data-state="idle"]').waitFor({ state: 'attached' });
}

/**
 * Sends a message and waits for the turn to finish.
 * @param {import('playwright-core').Page} page
 * @param {string} text
 */
export async function runTurn(page, text) {
  const before = await page.locator('.turn-result').count();
  await sendMessage(page, text);
  await waitForTurnResult(page, before + 1);
}

/**
 * Lists the direct children of the timeline as "user", "assistant", "result" or "other", in document order.
 * @param {import('playwright-core').Page} page
 * @returns {Promise<string[]>}
 */
export function timelineOrder(page) {
  return page.locator('.tl-list > *').evaluateAll((nodes) => nodes.map((node) => {
    if (node.classList.contains('msg-user')) return 'user';
    if (node.classList.contains('msg-assistant')) return 'assistant';
    if (node.classList.contains('turn-result')) return 'result';
    return 'other';
  }));
}
