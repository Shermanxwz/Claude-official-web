/**
 * The context meter and the compactions, on the real gateway with the mock engine. Each journey opens its own page and
 * ends with assertClean() (no console errors, page errors or unexpected failed responses).
 *  - CM1: a plain turn fills the header ring, and its tooltip gives the figures.
 *  - CM2: /compact shows the compacting row, the running line and the ring's compacting state; the row then becomes the
 *    manual divider, and the ring leaves its compacting state.
 *  - CM3: a prompt that makes the runtime compact by itself shows the compacting row in the middle of the turn, the
 *    automatic divider replaces it, the summary note follows, the turn finishes, and the ring drops from its peak.
 *    After a reload the divider keeps its sizes (the transcript has the summary, the session the sizes).
 *  - CM4: on a phone the ring stays in the header, and the page does not scroll sideways.
 *  - CM5: a reload in the middle of a compaction shows the row again, counting from the start of the compaction.
 *  - CM6: after /compact and a reload, the timeline starts at the compaction's divider with its sizes, then the
 *    collapsed summary note, and shows no message from before the compaction.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  DESKTOP,
  MOBILE,
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

const TEST_TIMEOUT_MS = 120_000;
/** Pacing of the mock: a compaction pauses 100 steps of it (4 s here), so the compacting row is visible for a while. */
const MOCK_DELAY_MS = '40';

/** @type {Awaited<ReturnType<typeof startApp>>} */
let app;
/** @type {import('playwright-core').Browser} */
let browser;

before(async () => {
  app = await startApp({ env: { CAW_MOCK_DELAY_MS: MOCK_DELAY_MS } });
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close();
  await app?.close();
});

/**
 * The tooltip of the ring (its aria-label) gives the figures: "38,416 of 100,000 tokens (38%). ...".
 * @param {string} label
 * @returns {{used: number, max: number, percent: number}|null}
 */
function figuresOf(label) {
  const match = /^([\d,]+) of ([\d,]+) tokens \((\d+)%\)/.exec(label);
  if (!match) return null;
  return {
    used: Number(match[1].replace(/,/g, '')),
    max: Number(match[2].replace(/,/g, '')),
    percent: Number(match[3]),
  };
}

/**
 * On a phone the session list sits in a drawer that starts closed; the header's menu button opens it.
 * @param {import('playwright-core').Page} page
 */
async function openDrawer(page) {
  if ((await page.locator('.app').getAttribute('data-sidebar')) !== 'open') {
    await page.locator('.hdr-menu, .app-reopen').filter({ visible: true }).first().click();
  }
  await page.locator('.sidebar-new').waitFor({ state: 'visible' });
}

/**
 * The whole seconds a compacting row or the running line shows ("12 s", "Compacting the conversation (12 s)").
 * @param {string|null} text
 * @returns {number} -1 when the text holds no number
 */
function secondsOf(text) {
  const match = /(\d+)/.exec(text ?? '');
  return match ? Number(match[1]) : -1;
}

/**
 * What the ring shows now, or null while it is hidden (no live session reports a window yet).
 * @param {import('playwright-core').Page} page
 * @returns {Promise<{label: string, tone: string|null, compacting: boolean, fill: number}|null>}
 */
async function readRing(page) {
  const ring = page.locator('button.ctx-meter:not([hidden])');
  if ((await ring.count()) === 0) return null;
  return ring.evaluate((el) => ({
    label: el.getAttribute('aria-label') ?? '',
    tone: el.dataset.tone ?? null,
    compacting: el.classList.contains('is-compacting'),
    fill: Number(getComputedStyle(el.querySelector('.ctx-ring')).getPropertyValue('--ctx-pct')),
  }));
}

/**
 * Waits until the ring shows figures with a used count, and returns its reading with the figures.
 * @param {import('playwright-core').Page} page
 * @param {string} message
 */
function settledRing(page, message) {
  return eventually(async () => {
    const reading = await readRing(page);
    const figures = reading ? figuresOf(reading.label) : null;
    return figures && figures.used > 0 ? { ...reading, figures } : null;
  }, { message });
}

test('CM1 a plain turn fills the ring, and its tooltip gives the figures', { timeout: TEST_TIMEOUT_MS }, () =>
  withPage(browser, 'CM1 ring after a plain turn', { baseURL: app.url, viewport: DESKTOP }, async (ui) => {
    const { page } = ui;
    await signIn(page, app.url);
    await createSession(page, { title: 'Ring after a turn' });
    await runTurn(page, 'Summarize the demo app');

    const reading = await settledRing(page, 'the ring never showed the context figures');
    const { used, max, percent } = reading.figures;
    assert.ok(max > 0, 'the window size is known');
    assert.ok(Math.abs(percent - (100 * used) / max) <= 1, `the tooltip's percentage matches ${used} of ${max}`);
    assert.equal(reading.tone, 'normal', 'a small context is in the normal tone');
    assert.equal(reading.compacting, false, 'no compaction runs');
    assert.match(reading.label, /\. Compacts automatically at [\d,]+\.$/, 'the tooltip names the automatic point');
    await eventually(async () => ((await readRing(page))?.fill ?? 0) > 0, {
      message: 'the ring stayed empty after the turn',
    });
  }));

test('CM2 /compact shows the compacting row, then the manual divider, and the ring leaves its compacting state', {
  timeout: TEST_TIMEOUT_MS,
}, () =>
  withPage(browser, 'CM2 manual compaction', { baseURL: app.url, viewport: DESKTOP }, async (ui) => {
    const { page } = ui;
    await signIn(page, app.url);
    await createSession(page, { title: 'Manual compaction' });
    await runTurn(page, 'Summarize the demo app');
    await settledRing(page, 'the ring never showed the context figures before /compact');

    await sendMessage(page, '/compact');
    const row = page.locator('.divider.is-compacting[role="status"]');
    await row.waitFor();
    assert.match(await row.innerText(), /Compacting the conversation/);
    await page.locator('button.ctx-meter.is-compacting').waitFor();
    await page.locator('.composer-activity:not([hidden]) .activity-text', { hasText: 'Compacting the conversation (' })
      .waitFor();

    const divider = page.locator('.divider.is-compact', { hasText: 'Compacted with /compact:' });
    await divider.waitFor();
    assert.equal(await page.locator('.divider.is-compacting').count(), 0,
      'the row became the divider, not a second one');
    // The runtime streams the summary after the boundary; it shows as its own note, and the divider stays one.
    await page.locator('.notice[data-code="compact-summary"]').waitFor();
    assert.equal(await page.locator('.divider.is-compact').count(), 1, 'one divider for the compaction');
    await waitForTurnResult(page, 2);
    await eventually(async () => (await page.locator('button.ctx-meter.is-compacting').count()) === 0, {
      message: 'the ring kept its compacting state after the compaction',
    });
    // The boundary leaves `used` as it was: the next API call's usage replaces it (PROTOCOL.md, "Context meter and
    // compaction"). The ring is shown again with its figures; the drop itself is checked in CM3, where the context is
    // large enough for the drop to show.
    assert.ok((await settledRing(page, 'the ring showed no figures after /compact')).figures.used > 0);
  }));

test('CM3 an automatic compaction shows its row mid-turn, then its divider, the turn finishes, and the ring drops', {
  timeout: TEST_TIMEOUT_MS,
}, () =>
  withPage(browser, 'CM3 automatic compaction', { baseURL: app.url, viewport: DESKTOP }, async (ui) => {
    const { page } = ui;
    await signIn(page, app.url);
    await createSession(page, { title: 'Automatic compaction' });
    await sendMessage(page, 'Read the two log batches, then report on them (autocompact)');

    const row = page.locator('.divider.is-compacting[role="status"]');
    await row.waitFor();
    assert.equal(await page.locator('.turn-result').count(), 0, 'the compaction happens before the turn ends');
    // The context is at its largest here: the reads of both log batches are in it.
    const peak = await settledRing(page, 'the ring showed no figures during the compaction');
    await page.locator('.composer-activity:not([hidden]) .activity-text', { hasText: 'Compacting the conversation (' })
      .waitFor();

    const divider = page.locator('.divider.is-compact', { hasText: 'Compacted automatically:' });
    await divider.waitFor();
    await page.locator('.notice[data-code="compact-summary"]').waitFor();
    await waitForTurnResult(page, 1);

    const texts = await page.locator('.tl-list > *')
      .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ''));
    const at = texts.findIndex((text) => text.includes('Compacted automatically:'));
    const answer = texts.findIndex((text) => text.includes('Both log batches processed without errors.'));
    assert.ok(at >= 0 && answer > at, 'the answer that follows the compaction comes after its divider');
    assert.equal(await page.locator('.divider.is-compacting').count(), 0);

    // The answer's call sends the shorter context, so the ring drops from its peak.
    const after = await settledRing(page, 'the ring showed no figures after the automatic compaction');
    assert.ok(after.figures.used < peak.figures.used,
      `the ring dropped from ${peak.figures.used} to ${after.figures.used}`);

    // A reload reads the transcript, which names no sizes for the compaction, so the sizes come from the session.
    await page.reload();
    await page.locator('.divider.is-compact', { hasText: 'Compacted automatically:' }).waitFor();
    assert.equal(await page.locator('.divider.is-compact').count(), 1, 'one divider after the reload too');
    await page.locator('.notice[data-code="compact-summary"]').waitFor();
  }));

const PHONE = { viewport: MOBILE, isMobile: true, hasTouch: true };

test('CM4 on a phone the ring stays in the header, and the page does not scroll sideways', {
  timeout: TEST_TIMEOUT_MS,
}, () =>
  withPage(browser, 'CM4 ring on a phone', { baseURL: app.url, ...PHONE }, async (ui) => {
    const { page } = ui;
    await signIn(page, app.url);
    await openDrawer(page);
    await createSession(page, { title: 'Ring on a phone' });
    await runTurn(page, 'Summarize the demo app');
    await settledRing(page, 'the ring never showed the context figures on a phone');
    assert.equal(await page.locator('button.ctx-meter').isVisible(), true, 'the ring is visible at phone width');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `the page is wider than the phone by ${overflow}px`);
  }));

test('CM5 a reload in the middle of a compaction shows its row again, counting from the start of the compaction', {
  timeout: TEST_TIMEOUT_MS,
}, () =>
  withPage(browser, 'CM5 reload during compaction', { baseURL: app.url, viewport: DESKTOP }, async (ui) => {
    const { page } = ui;
    await signIn(page, app.url);
    await createSession(page, { title: 'Reload while compacting' });
    await sendMessage(page, 'Read the two log batches, then report on them (autocompact)');

    const row = page.locator('.divider.is-compacting[role="status"]');
    await row.waitFor();
    // Reload once the row has counted two seconds: the mock holds the compaction for about four.
    await eventually(async () => secondsOf(await row.locator('.divider-elapsed').textContent()) >= 2, {
      message: 'the compacting row never counted two seconds',
    });
    await page.reload();
    await row.waitFor();
    const elapsed = secondsOf(await row.locator('.divider-elapsed').textContent());
    assert.ok(elapsed >= 2 && elapsed < 60,
      `the row counts from the start of the compaction after a reload (it shows ${elapsed} s)`);
    await page.locator('.composer-activity:not([hidden]) .activity-text', { hasText: 'Compacting the conversation (' })
      .waitFor();

    await page.locator('.divider.is-compact', { hasText: 'Compacted automatically:' }).waitFor();
    assert.equal(await page.locator('.divider.is-compacting').count(), 0, 'the row became the divider');
    await waitForTurnResult(page, 1);
  }));

test('CM6 after /compact and a reload, the timeline starts at the divider and its summary note', {
  timeout: TEST_TIMEOUT_MS,
}, () =>
  withPage(browser, 'CM6 reload after compaction', { baseURL: app.url, viewport: DESKTOP }, async (ui) => {
    const { page } = ui;
    await signIn(page, app.url);
    await createSession(page, { title: 'Reload after compaction' });
    await runTurn(page, 'Summarize the demo app');
    await runTurn(page, '/compact');
    await page.locator('.divider.is-compact', { hasText: 'Compacted with /compact:' }).waitFor();
    assert.ok(await page.locator('.msg-user', { hasText: 'Summarize the demo app' }).count() > 0,
      'the prompt before the compaction is in the timeline until the reload');

    await page.reload();
    await eventually(async () => (await page.locator('.tl-list > *').count()) > 0, {
      message: 'the timeline stayed empty after the reload',
    });
    // The transcript starts at the compaction's boundary, so the first row is its divider, with the sizes the session
    // reports for the compaction.
    const first = page.locator('.tl-list > *').first();
    assert.equal(await first.evaluate((node) => node.matches('.divider.is-compact')), true,
      'the timeline starts with the compaction divider');
    assert.match((await first.innerText()).trim(), /^Compacted with \/compact: [\d.]+k tokens summarized into [\d.]+k/);
    // The summary is a collapsed note right after the divider, and the compaction has one divider and one note.
    const note = page.locator('.tl-list > *').nth(1);
    assert.equal(await note.evaluate((node) => node.matches('.notice[data-code="compact-summary"]')), true,
      'the summary note follows the divider');
    assert.equal(await note.locator('summary').innerText(), 'Summary of the earlier conversation');
    assert.equal(await note.locator('details').evaluate((node) => node.open), false, 'the note is collapsed');
    assert.equal(await page.locator('.notice[data-code="compact-summary"]').count(), 1, 'one summary note');
    assert.equal(await page.locator('.divider.is-compact').count(), 1, 'exactly one compaction divider');
    // Nothing from before the compaction is shown: neither the earlier prompt and answer nor the /compact prompt.
    assert.equal(await page.locator('.tl-list .msg-user').count(), 0, 'no prompt from before the compaction');
    assert.equal(await page.locator('.tl-list .msg-assistant').count(), 0, 'no answer from before the compaction');
  }));
