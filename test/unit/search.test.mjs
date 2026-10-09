import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionSearch, parseSearchQuery } from '../../src/search.mjs';
import { AppError } from '../../src/contracts.mjs';

/**
 * A listing of sessions and their transcripts. Sessions are listed newest first, as the SDK lists them.
 * @param {Array<Record<string, unknown> & {sessionId: string}>} sessions
 * @param {Record<string, unknown[]>} transcripts
 */
function fixture(sessions, transcripts = {}) {
  /** @type {Array<{limit: number, offset: number}>} */
  const pages = [];
  /** @type {string[]} */
  const reads = [];
  return {
    pages,
    reads,
    listSessions: async ({ limit, offset }) => {
      pages.push({ limit, offset });
      return sessions.slice(offset, offset + limit).map((session) => ({ cwd: '/work/alpha', ...session }));
    },
    getSessionMessages: async (/** @type {string} */ sessionId) => {
      reads.push(sessionId);
      const messages = transcripts[sessionId];
      if (messages === undefined) throw new Error('unreadable transcript');
      return messages;
    },
  };
}

/** @param {string} text */
function userTurn(text) {
  return { type: 'user', message: { role: 'user', content: text } };
}

/** @param {string} text */
function assistantTurn(text) {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } };
}

/** @param {string} sessionId @param {number} lastModified @param {Record<string, unknown>} [extra] */
function session(sessionId, lastModified, extra = {}) {
  return { sessionId, lastModified, summary: `Summary ${sessionId}`, ...extra };
}

describe('search query', () => {
  test('is trimmed and lower-cased, and must be 2 to 200 characters', () => {
    assert.equal(parseSearchQuery('  Deploy  '), 'deploy');
    assert.equal(parseSearchQuery('ab'), 'ab');
    assert.equal(parseSearchQuery('x'.repeat(200)), 'x'.repeat(200));
    for (const raw of ['a', ' a ', 'x'.repeat(201), '😀', '', null, 42, undefined]) {
      assert.throws(() => parseSearchQuery(raw), (error) => error instanceof AppError && error.status === 400
        && error.code === 'BAD_REQUEST', String(raw));
    }
    assert.equal(parseSearchQuery('😀😀'), '😀😀');
  });
});

describe('session search', () => {
  test('a title, summary or first prompt that contains the query is a title match with no snippets', async () => {
    const data = fixture([
      session('s1', 300, { customTitle: 'Deploy the API' }),
      session('s2', 200, { summary: 'Notes about DEPLOY steps' }),
      session('s3', 100, { firstPrompt: 'how do I deploy?' }),
    ]);
    const { search } = createSessionSearch(data);
    const { results, scanned, truncated } = await search('deploy', 10);
    assert.deepEqual(results.map((r) => [r.sessionId, r.matchedIn, r.snippets, r.title]), [
      ['s1', 'title', [], 'Deploy the API'],
      ['s2', 'title', [], 'Notes about DEPLOY steps'],
      ['s3', 'title', [], 'Summary s3'],
    ]);
    assert.deepEqual(data.reads, []);
    assert.equal(scanned, 0);
    assert.equal(truncated, false);
  });

  test('the title of a result is the custom title first, then the summary', async () => {
    const data = fixture([session('s1', 1, { customTitle: 'Custom', summary: 'Summary deploy' })]);
    const { results } = await createSessionSearch(data).search('deploy', 5);
    assert.equal(results[0].matchedIn, 'title');
    assert.equal(results[0].title, 'Custom');
    const named = fixture([session('s2', 1, { customTitle: 'Custom deploy', summary: 'Summary' })]);
    assert.equal((await createSessionSearch(named).search('deploy', 5)).results[0].title, 'Custom deploy');
  });

  test('a transcript match is a content match with snippets of the user and assistant text, case-insensitively',
    async () => {
      const data = fixture([session('s1', 500)], {
        s1: [
          userTurn('We should Deploy on Friday.'),
          { type: 'system', message: { content: 'deploy the system message is not searched' } },
          assistantTurn('Deploying now.'),
          { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'deploy' }] } },
        ],
      });
      const { results, scanned } = await createSessionSearch(data).search('DEPLOY', 5);
      assert.equal(scanned, 1);
      assert.deepEqual(results, [{
        sessionId: 's1',
        cwd: '/work/alpha',
        title: 'Summary s1',
        lastModified: 500,
        matchedIn: 'content',
        snippets: ['We should Deploy on Friday.', 'Deploying now.'],
      }]);
    });

  test('a snippet is at most 160 characters around the first match, with whitespace collapsed', async () => {
    const long = `${'word '.repeat(40)}TARGET\n\n${'tail '.repeat(40)}`;
    const data = fixture([session('s1', 1)], { s1: [assistantTurn(long)] });
    const [snippet] = (await createSessionSearch(data).search('target', 5)).results[0].snippets;
    assert.ok(snippet.length <= 160, `snippet is ${snippet.length} characters`);
    assert.ok(snippet.includes('TARGET'));
    assert.equal(/\s{2,}|\n/.test(snippet), false);
  });

  test('at most three snippets are kept for one session', async () => {
    const data = fixture([session('s1', 1)], {
      s1: [userTurn('deploy 1'), userTurn('deploy 2'), userTurn('deploy 3'), userTurn('deploy 4')],
    });
    const [result] = (await createSessionSearch(data).search('deploy', 5)).results;
    assert.deepEqual(result.snippets, ['deploy 1', 'deploy 2', 'deploy 3']);
  });

  test('only the newest 50 unmatched sessions are read, and the result list is newest first and limited', async () => {
    const sessions = Array.from({ length: 60 }, (_, i) => session(`s${i}`, 1000 - i));
    const transcripts = Object.fromEntries(sessions.map((s) => [s.sessionId, [userTurn('the word here')]]));
    transcripts.s55 = [userTurn('deploy from the oldest')];
    const data = fixture(sessions, transcripts);
    const outcome = await createSessionSearch(data).search('deploy', 20);
    assert.equal(outcome.scanned, 50);
    assert.deepEqual(outcome.results, []);

    const newer = fixture(
      [session('a', 300), session('b', 200), session('c', 100)],
      { a: [userTurn('deploy a')], b: [userTurn('deploy b')], c: [userTurn('deploy c')] },
    );
    const limited = await createSessionSearch(newer).search('deploy', 2);
    assert.deepEqual(limited.results.map((r) => r.sessionId), ['a', 'b']);
    assert.equal(limited.scanned, 3);
  });

  test('only the newest 4000 messages of a transcript are searched', async () => {
    const early = Array.from({ length: 4005 }, (_, i) => userTurn(i === 0 ? 'deploy early' : `filler ${i}`));
    const late = Array.from({ length: 4005 }, (_, i) => userTurn(i === 4004 ? 'deploy late' : `filler ${i}`));
    const data = fixture([session('early', 2), session('late', 1)], { early, late });
    const { results } = await createSessionSearch(data).search('deploy', 5);
    assert.deepEqual(results.map((r) => r.sessionId), ['late']);
  });

  test('an unreadable transcript is skipped, and the rest of the search answers', async () => {
    const data = fixture([session('broken', 2), session('fine', 1)], { fine: [userTurn('deploy fine')] });
    const outcome = await createSessionSearch(data).search('deploy', 5);
    assert.deepEqual(outcome.results.map((r) => r.sessionId), ['fine']);
    assert.equal(outcome.scanned, 1);
    assert.deepEqual(data.reads, ['broken', 'fine']);
  });

  test('the content scan stops at its time budget and says so', async () => {
    const sessions = Array.from({ length: 10 }, (_, i) => session(`s${i}`, 100 - i));
    const transcripts = Object.fromEntries(sessions.map((s) => [s.sessionId, [userTurn('nothing')]]));
    let clock = 0;
    const search = createSessionSearch({
      ...fixture(sessions, transcripts),
      now: () => {
        clock += 10;
        return clock;
      },
      budgetMs: 25,
    });
    const outcome = await search.search('deploy', 5);
    assert.equal(outcome.truncated, true);
    assert.equal(outcome.scanned, 2);
  });

  test('the listing is read page by page until a short page ends it', async () => {
    const sessions = Array.from({ length: 501 }, (_, i) => session(`s${i}`, 1000 - i, { customTitle: `title ${i}` }));
    const data = fixture(sessions);
    const outcome = await createSessionSearch(data).search('title 49', 50);
    assert.deepEqual(data.pages, [{ limit: 500, offset: 0 }, { limit: 500, offset: 500 }]);
    assert.ok(outcome.results.some((r) => r.title === 'title 49'));
    assert.equal(outcome.scanned, 0);
  });

  test('a query that matches nothing answers no results with the number of transcripts it read', async () => {
    const data = fixture([session('s1', 1), session('s2', 2)], { s1: [userTurn('hello')], s2: [assistantTurn('hi')] });
    assert.deepEqual(await createSessionSearch(data).search('deploy', 5), {
      results: [],
      scanned: 2,
      truncated: false,
    });
  });

  test('a session without a working folder answers a null cwd', async () => {
    const data = {
      listSessions: async () => [{ sessionId: 's1', lastModified: 1, customTitle: 'deploy' }],
      getSessionMessages: async () => [],
    };
    const [result] = (await createSessionSearch(data).search('deploy', 5)).results;
    assert.equal(result.cwd, null);
    assert.equal(result.title, 'deploy');
  });
});
