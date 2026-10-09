/**
 * User journeys through the web UI on a 1440x900 desktop. One gateway (mock engine, auth on) and one Chromium serve the
 * whole file. Every test opens its own browser context, so each journey starts from an empty page, and every test ends
 * with assertClean(): no console errors, page errors or unexpected failed responses.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  PROJECT,
  TOKEN,
  createSession,
  eventually,
  launchBrowser,
  runTurn,
  sendMessage,
  sessionIdOf,
  signIn,
  startApp,
  timelineOrder,
  waitForTurnResult,
  withPage,
} from './helpers.mjs';

const TEST_TIMEOUT_MS = 90_000;
const UUID = /^[0-9a-f-]{36}$/i;
const SESSION_HASH = /^#\/s\/[0-9a-f-]{36}$/i;

/** @type {Awaited<ReturnType<typeof startApp>>} */
let app;
/** @type {import('playwright-core').Browser} */
let browser;

before(async () => {
  // Pacing is slower than the helpers' default, so the Stop control of journey 7 has time to be clicked. More live
  // sessions are allowed, because every journey keeps its sessions open.
  app = await startApp({ env: { CAW_MOCK_DELAY_MS: '25', CAW_MAX_LIVE_SESSIONS: '32' } });
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close();
  await app?.close();
});

/**
 * A request card that is still waiting for an answer.
 * @param {import('playwright-core').Page} page
 * @param {'permission'|'question'|'plan'|'elicitation'} kind
 */
function pendingCard(page, kind) {
  return page.locator(`section.request-card[data-kind="${kind}"][data-state="ready"]`);
}

/**
 * Opens the collapsed work groups and tool cards of the timeline, so that their output can be read.
 * @param {import('playwright-core').Page} page
 */
async function expandTimeline(page) {
  // Each click re-renders part of the list, so the first closed element is asked for again every time.
  for (const selector of ['details.work:not([open]) > summary.work-summary', 'details.tool-card:not([open]) > summary.tool-head']) {
    for (let clicks = 0; clicks < 30; clicks += 1) {
      const next = page.locator(selector).first();
      if ((await next.count()) === 0) break;
      await next.click();
    }
  }
}

/**
 * Hovers a sent message so that its action toolbar shows, then returns the message.
 * @param {import('playwright-core').Page} page
 * @param {string} text
 */
async function hoverUserMessage(page, text) {
  const message = page.locator('.msg-user', { hasText: text }).first();
  await message.hover();
  return message;
}

test('J1 a wrong token is refused, the right one signs in, and a new session starts', { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'J1 sign in and start a session', { baseURL: app.url }, async (ui) => {
    const { page } = ui;
    ui.allowFailure({ method: 'POST', path: '/api/login', status: 401 });
    await page.goto(app.url);
    await page.getByLabel('Access token').fill('not-the-right-token-0000');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'That access token is not correct.' }).waitFor();

    await page.getByLabel('Access token').fill(TOKEN);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.locator('.sidebar-new').waitFor();
    await page.locator('.sidebar-empty-title', { hasText: 'No sessions yet' }).waitFor();
    await page.locator('.welcome', { hasText: 'Start a conversation' }).waitFor();

    const sessionId = await createSession(page, { folder: PROJECT, title: 'Journey one' });
    assert.match(sessionId, UUID);
    assert.match(new URL(page.url()).hash, SESSION_HASH);
    await page.locator('.session-main[aria-current="true"]', { hasText: 'Journey one' }).waitFor();
    assert.equal(await page.locator('.composer-input').isEnabled(), true);
  }));

test('J2 a message streams a Markdown answer, and its code block can be copied', { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'J2 Markdown answer', { baseURL: app.url }, async (ui) => {
    const { page } = ui;
    await signIn(page, app.url);
    await createSession(page, { title: 'Markdown reply' });
    await sendMessage(page, 'Summarize the demo app');
    await waitForTurnResult(page, 1);
    assert.deepEqual(await timelineOrder(page), ['user', 'assistant', 'result']);

    const answer = page.locator('.msg-assistant').first();
    await answer.locator('h2', { hasText: 'Mock answer' }).waitFor();
    await answer.locator('blockquote', { hasText: 'Summarize the demo app' }).waitFor();
    await answer.locator('pre code', { hasText: 'function greet(name)' }).waitFor();

    await answer.locator('.code-copy').click();
    await answer.locator('.code-copy', { hasText: 'Copied' }).waitFor();
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(clipboard, /function greet\(name\)/);

    await page.locator('.turn-result.is-done', { hasText: 'Done' }).waitFor();
  }));

test('J3 a tool asks first: Allow runs it, Deny with a reason ends it as an error', { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'J3 tool approval', { baseURL: app.url }, async (ui) => {
    const { page } = ui;
    await signIn(page, app.url);
    await createSession(page, { title: 'Tool approvals' });

    await sendMessage(page, 'Run a tool to list the project');
    const first = pendingCard(page, 'permission');
    await first.waitFor();
    for (const name of ['Allow', 'Always allow', 'Deny']) {
      await first.getByRole('button', { name, exact: true }).waitFor();
    }
    await first.getByRole('button', { name: 'Allow', exact: true }).click();
    await waitForTurnResult(page, 1);
    await expandTimeline(page);
    await page.locator('.tool-card .tool-code', { hasText: 'package.json' }).waitFor();
    await page.locator('.tool-card.tool-status-done').first().waitFor();

    await sendMessage(page, 'Run another tool and deny it');
    const second = pendingCard(page, 'permission');
    await second.waitFor();
    await second.locator('.request-note-toggle').click();
    await second.locator('.request-deny-input').fill('Please list the files another way');
    await second.getByRole('button', { name: 'Deny', exact: true }).click();
    await page.locator('.tool-card.tool-status-error').first().waitFor();
    await waitForTurnResult(page, 2);
    await expandTimeline(page);
    await page.locator('.tool-card', { hasText: 'Please list the files another way' }).first().waitFor();
    assert.match(await page.locator('.turn-result').nth(1).innerText(), /Denied: Bash \(1\)/);
  }));

test('J4 an edit asks first with a +/- diff, and the applied edit shows its diff', { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'J4 edit approval', { baseURL: app.url }, async (ui) => {
    const { page } = ui;
    await signIn(page, app.url);
    await createSession(page, { title: 'Edit review' });

    await sendMessage(page, 'Edit the port handling');
    const card = pendingCard(page, 'permission');
    await card.waitFor();
    await card.locator('.tool-diff-row.is-add', { hasText: 'Number(process.env.PORT)' }).waitFor();
    await card.locator('.tool-diff-row.is-del', { hasText: 'const port = 3000;' }).waitFor();
    await card.getByRole('button', { name: 'Allow', exact: true }).click();

    await waitForTurnResult(page, 1);
    await expandTimeline(page);
    await page.locator('.tool-card .tool-diff-row.is-add', { hasText: 'Number(process.env.PORT)' }).first().waitFor();
    await page.locator('.tool-card .tool-diff-row.is-del', { hasText: 'const port = 3000;' }).first().waitFor();
    await page.locator('.msg-assistant', { hasText: 'The port now reads from' }).waitFor();
  }));

test('J5 a question is answered with options and the answer reaches the assistant', { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'J5 question answers', { baseURL: app.url }, async (ui) => {
    const { page } = ui;
    await signIn(page, app.url);
    await createSession(page, { title: 'Questions' });

    await sendMessage(page, 'Ask me a question before you continue');
    const card = pendingCard(page, 'question');
    await card.waitFor();
    for (const label of ['Password', 'Dark mode', 'Exports']) {
      await card.locator('.request-option-label', { hasText: new RegExp(`^${label}$`) }).click();
    }
    await card.getByRole('button', { name: 'Submit answers', exact: true }).click();

    await waitForTurnResult(page, 1);
    await page.locator('.msg-assistant', {
      hasText: 'I will use Password for sign-in and enable Dark mode, Exports.',
    }).waitFor();
  }));

test('J6 a plan is approved with acceptEdits, and the header shows the new permission mode', { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'J6 plan approval', { baseURL: app.url }, async (ui) => {
    const { page } = ui;
    await signIn(page, app.url);
    await createSession(page, { title: 'Plan review' });

    await sendMessage(page, 'Plan the release steps');
    const card = pendingCard(page, 'plan');
    await card.waitFor();
    await card.locator('.request-plan h1', { hasText: 'Plan' }).waitFor();
    await card.locator('select.request-mode').selectOption('acceptEdits');
    await card.getByRole('button', { name: 'Approve plan', exact: true }).click();

    await waitForTurnResult(page, 1);
    await page.locator('.msg-assistant', { hasText: 'Plan approved' }).waitFor();
    const mode = page.locator('select.hdr-mode');
    await eventually(async () => (await mode.inputValue()) === 'acceptEdits', {
      message: 'the header permission mode did not change to acceptEdits after the plan was approved',
    });
  }));

test('J7 Stop ends a running turn as interrupted, and the composer stays usable', { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'J7 stop a running turn', { baseURL: app.url }, async (ui) => {
    const { page } = ui;
    await signIn(page, app.url);
    await createSession(page, { title: 'Stop control' });

    await sendMessage(page, 'Give me a slow answer');
    await page.locator('.composer-stop').waitFor();
    await page.locator('.composer-stop').click();
    await page.locator('.turn-result.is-interrupted', { hasText: 'Interrupted' }).waitFor();
    await page.locator('.state-badge[data-state="idle"]').waitFor({ state: 'attached' });

    assert.equal(await page.locator('.composer-input').isEnabled(), true);
    await runTurn(page, 'Hello again after the stop');
    await page.locator('.msg-assistant', { hasText: 'Hello again after the stop' }).waitFor();
  }));

test('J8 / lists the commands, Escape closes the list, and @ lists project files', { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'J8 command and file palettes', { baseURL: app.url }, async (ui) => {
    const { page } = ui;
    await signIn(page, app.url);
    await createSession(page, { title: 'Palette' });
    const input = page.locator('.composer-input');

    await input.click();
    await input.pressSequentially('/');
    const commands = page.locator('[role="listbox"][aria-label="Commands"]');
    await commands.waitFor();
    const compact = commands.locator('[role="option"]', { hasText: '/compact' });
    await compact.waitFor();
    assert.match(await compact.innerText(), /Built-in/);
    const model = commands.locator('[role="option"]', { hasText: '/model' });
    await model.waitFor();
    assert.match(await model.innerText(), /App/);

    await page.keyboard.press('Escape');
    await commands.waitFor({ state: 'detached' });
    assert.equal(await input.inputValue(), '/');

    await input.fill('');
    await input.pressSequentially('@app');
    const files = page.locator('[role="listbox"][aria-label="Files"]');
    await files.waitFor();
    await files.locator('[role="option"]', { hasText: 'src/app.js' }).click();
    assert.equal(await input.inputValue(), '@src/app.js ');
  }));

test('J9 an attached picture shows as a chip with a thumbnail and is sent without an error', { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'J9 attachment', { baseURL: app.url }, async (ui) => {
    const { page } = ui;
    await signIn(page, app.url);
    await createSession(page, { title: 'Attachments' });

    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.locator('.composer-attach').click(),
    ]);
    await chooser.setFiles(app.png);
    await page.locator('.chip.is-done', { hasText: 'pixel.png' }).waitFor();
    await page.locator('.chip img.chip-thumb').waitFor();

    await sendMessage(page, 'Here is a tiny picture');
    await waitForTurnResult(page, 1);
    await page.locator('.msg-user .file-chip', { hasText: 'pixel.png' }).waitFor();
    assert.equal(await page.locator('.toast-error').count(), 0);
    assert.equal(await page.locator('.chip').count(), 0);
  }));

test('J10 a reload keeps the session from the address and the order of every turn', { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'J10 reload keeps the transcript', { baseURL: app.url }, async (ui) => {
    const { page } = ui;
    await signIn(page, app.url);
    const sessionId = await createSession(page, { title: 'Reload check' });
    await runTurn(page, 'Explain the health endpoint');
    await runTurn(page, 'Explain the start script');

    await page.reload();
    await page.locator('.session-main[aria-current="true"]', { hasText: 'Reload check' }).waitFor();
    await waitForTurnResult(page, 2);
    assert.equal(sessionIdOf(page), sessionId);
    assert.deepEqual(await timelineOrder(page), ['user', 'assistant', 'result', 'user', 'assistant', 'result']);
    const messages = await page.locator('.msg-user .msg-text').allInnerTexts();
    assert.deepEqual(messages, ['Explain the health endpoint', 'Explain the start script']);
  }));

test('J11 rewinding from a message previews the changed file and reports success', { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'J11 rewind from a message', { baseURL: app.url }, async (ui) => {
    const { page } = ui;
    await signIn(page, app.url);
    await createSession(page, { title: 'Rewind check' });
    await runTurn(page, 'Explain the health endpoint');
    await runTurn(page, 'Explain the start script');

    const message = await hoverUserMessage(page, 'Explain the start script');
    await message.locator('.msg-action', { hasText: 'Rewind' }).click();
    const dialog = page.getByRole('dialog', { name: 'Rewind session', exact: true });
    await dialog.waitFor();
    await dialog.locator('.rewind-files code', { hasText: 'src/app.js' }).waitFor();
    const confirm = dialog.getByRole('button', { name: 'Rewind', exact: true });
    await eventually(() => confirm.isEnabled(), { message: 'the Rewind button stayed disabled after the preview' });
    await confirm.click();

    await page.locator('.toast', { hasText: 'Session rewound' }).waitFor();
    await dialog.waitFor({ state: 'detached' });
    await eventually(async () => (await page.locator('.msg-user').count()) === 1, {
      message: 'the rewound message is still in the timeline',
    });
  }));

test('J11b the rewind preview reads correctly for a single changed file', {
  timeout: TEST_TIMEOUT_MS,
}, () =>
  withPage(browser, 'J11b rewind preview wording', { baseURL: app.url }, async (ui) => {
    const { page } = ui;
    await signIn(page, app.url);
    await createSession(page, { title: 'Rewind wording' });
    await runTurn(page, 'Explain the health endpoint');
    await runTurn(page, 'Explain the start script');

    const message = await hoverUserMessage(page, 'Explain the start script');
    await message.locator('.msg-action', { hasText: 'Rewind' }).click();
    const dialog = page.getByRole('dialog', { name: 'Rewind session', exact: true });
    await dialog.waitFor();
    await dialog.locator('.rewind-files code', { hasText: 'src/app.js' }).waitFor();
    const summary = dialog.locator('.rewind-preview .rewind-note').first();
    assert.match(await summary.innerText(), /^1 file would change/);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  }));

test('J12 forking from a message opens the new session with the conversation so far', { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'J12 fork from a message', { baseURL: app.url }, async (ui) => {
    const { page } = ui;
    await signIn(page, app.url);
    await createSession(page, { title: 'Fork check' });
    const originalId = sessionIdOf(page);
    await runTurn(page, 'Explain the health endpoint');
    await runTurn(page, 'Explain the start script');

    const message = await hoverUserMessage(page, 'Explain the health endpoint');
    await message.locator('.msg-action', { hasText: 'Fork' }).click();
    const dialog = page.getByRole('dialog', { name: 'Fork session', exact: true });
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Fork', exact: true }).click();

    await page.locator('.toast', { hasText: 'Forked into a new session' }).waitFor();
    await eventually(() => UUID.test(sessionIdOf(page)) && sessionIdOf(page) !== originalId, {
      message: 'the forked session was not selected',
    });
    await page.locator('.session-main[aria-current="true"]').waitFor();
    await page.locator('.msg-user', { hasText: 'Explain the health endpoint' }).first().waitFor();
  }));

test('J13 a session can be renamed from its row menu, closed, and then deleted after confirmation', { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'J13 rename, close and delete', { baseURL: app.url }, async (ui) => {
    const { page } = ui;
    await signIn(page, app.url);
    await createSession(page, { title: 'Draft title' });

    await page.locator('li.session-row', { hasText: 'Draft title' }).locator('.session-more').click();
    await page.getByRole('menu', { name: 'Session actions' }).getByRole('menuitem', { name: 'Rename' }).click();
    const rename = page.getByRole('dialog', { name: 'Rename session', exact: true });
    await rename.getByLabel('Title', { exact: true }).fill('Renamed session');
    await rename.getByRole('button', { name: 'Save', exact: true }).click();
    await page.locator('li.session-row', { hasText: 'Renamed session' }).waitFor();
    await page.locator('.hdr-title', { hasText: 'Renamed session' }).waitFor();

    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Session info', exact: true }).click();
    const panel = page.getByRole('dialog', { name: 'Session', exact: true });
    await panel.getByRole('button', { name: 'Close running session', exact: true }).click();
    await page.locator('.toast', { hasText: 'Session closed' }).waitFor();
    await panel.getByRole('button', { name: 'Close', exact: true }).click();
    await panel.waitFor({ state: 'detached' });
    // The sidebar row updates when the session closes; J13b covers that without a reload.
    await page.reload();
    await page.locator('li.session-row', { hasText: 'Renamed session' }).waitFor();

    await page.locator('li.session-row', { hasText: 'Renamed session' }).locator('.session-more').click();
    await page.getByRole('menu', { name: 'Session actions' }).getByRole('menuitem', { name: 'Delete' }).click();
    const confirm = page.getByRole('dialog', { name: 'Delete session?', exact: true });
    await confirm.waitFor();
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click();

    await page.locator('.toast', { hasText: 'Session deleted' }).waitFor();
    await page.locator('li.session-row', { hasText: 'Renamed session' }).waitFor({ state: 'detached' });
  }));

test('J13b closing a session updates its sidebar row without a reload', {
  timeout: TEST_TIMEOUT_MS,
}, () =>
  withPage(browser, 'J13b closed row without reload', { baseURL: app.url }, async (ui) => {
    const { page } = ui;
    await signIn(page, app.url);
    await createSession(page, { title: 'Stale row' });

    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Session info', exact: true }).click();
    const panel = page.getByRole('dialog', { name: 'Session', exact: true });
    await panel.getByRole('button', { name: 'Close running session', exact: true }).click();
    await page.locator('.toast', { hasText: 'Session closed' }).waitFor();
    await panel.getByRole('button', { name: 'Close', exact: true }).click();
    await panel.waitFor({ state: 'detached' });

    const row = page.locator('li.session-row', { hasText: 'Stale row' });
    await eventually(async () => (await row.locator('.state-dot').count()) === 0, {
      message: 'the closed session still shows a live state dot in the sidebar',
    });
    await row.locator('.session-more').click();
    await page.getByRole('menu', { name: 'Session actions' }).getByRole('menuitem', { name: 'Delete' }).waitFor();
  }));
