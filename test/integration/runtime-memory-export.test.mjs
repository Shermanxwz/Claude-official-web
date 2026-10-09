/**
 * Integration tests: the memory files a session loads (GET and PUT /api/sessions/:id/memory) and the conversation
 * export (GET /api/sessions/:id/export). The memory dialog lists the project's CLAUDE.md and the user's file, reads
 * each one through the runtime, and saves only the files the runtime lists as editable.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, before, after } from 'node:test';
import { assertError, client, createLive, runTurn, startTestServer } from './helpers.mjs';

describe('memory files and export', { timeout: 120000 }, () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let server;
  /** @type {ReturnType<typeof client>} */
  let api;
  /** The project's instruction file, inside the workspace. */
  let projectFile = '';
  /** The user's instruction file, in the home directory the queries see (a temporary one for this file). */
  let userFile = '';
  /** The HOME the queries inherit from this process, restored when the file's tests end. */
  const savedHome = process.env.HOME;
  /** @type {string} */
  let home = '';
  before(async () => {
    // Queries take their environment from this process, so HOME points at an empty folder: the user's own CLAUDE.md
    // (if any) never changes what these tests see.
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'caw-it-home-'));
    process.env.HOME = home;
    server = await startTestServer();
    api = client(server.url);
    await api.login();
    projectFile = path.join(server.proj, 'CLAUDE.md');
    userFile = path.join(home, '.claude', 'CLAUDE.md');
    fs.writeFileSync(projectFile, '# Project notes\n');
  });
  after(async () => {
    await server.close();
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('lists the project file with its content, and the user file as missing', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const memory = await api.get(`/api/sessions/${live.sessionId}/memory`);
    assert.equal(memory.status, 200);
    const project = memory.json.files.find((file) => file.kind === 'project');
    assert.equal(project.path, projectFile);
    assert.equal(project.exists, true);
    assert.equal(project.content, '# Project notes\n');
    assert.equal(project.truncated, false);
    assert.equal(project.editable, true, 'a CLAUDE.md inside a workspace root can be saved');
    const user = memory.json.files.find((file) => file.kind === 'user');
    assert.equal(user.path, userFile);
    assert.equal(user.exists, false);
    assert.equal(user.content, null);
    assert.ok(Array.isArray(memory.json.folders));
    assert.equal(typeof memory.json.autoMemory, 'object');
    assert.equal(typeof memory.json.autoDream, 'object');
  });

  it('saves a listed memory file atomically and reports its size; an unlisted file is refused', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const pathname = `/api/sessions/${live.sessionId}/memory`;
    const saved = await api.put(pathname, { path: projectFile, content: '# Saved\n' });
    assert.equal(saved.status, 200, saved.text);
    assert.deepEqual(saved.json, { ok: true, bytes: 8 });
    assert.equal(fs.readFileSync(projectFile, 'utf8'), '# Saved\n');
    assert.deepEqual(fs.readdirSync(server.proj).filter((name) => name.includes('.tmp')), [],
      'no temporary file is left behind');
    const reread = await api.get(pathname);
    assert.equal(reread.json.files.find((file) => file.kind === 'project').content, '# Saved\n');

    assertError(await api.put(pathname, { path: path.join(server.proj, 'src', 'app.js'), content: 'x' }),
      422, 'PATH_NOT_ALLOWED');
    assertError(await api.put(pathname, { path: projectFile, content: 42 }), 400, 'BAD_REQUEST');
    assertError(await api.put(pathname, { path: projectFile, content: 'x'.repeat(256 * 1024 + 1) }),
      413, 'PAYLOAD_TOO_LARGE');
  });

  it('exports the conversation as text, with a file name the browser can save', async () => {
    const live = await createLive(api, { cwd: server.proj });
    const events = await api.events({ watch: live.sessionId, after: 0 });
    try {
      await runTurn(api, events, live.sessionId, 'Tell me something about the project');
      const exported = await api.get(`/api/sessions/${live.sessionId}/export`);
      assert.equal(exported.status, 200);
      assert.match(exported.json.text, /^> Tell me something about the project\n\n/);
      assert.match(exported.json.filename, /^conversation-[0-9-]+\.txt$/);
      assert.equal(/^[A-Za-z0-9._-]+$/.test(exported.json.filename), true);
    } finally {
      events.close();
    }
  });

  it('a session that is not live cannot be exported', async () => {
    const live = await createLive(api, { cwd: server.proj });
    assert.equal((await api.post(`/api/sessions/${live.sessionId}/close`, {})).status, 200);
    assertError(await api.get(`/api/sessions/${live.sessionId}/export`), 409, 'SESSION_NOT_LIVE');
    assertError(await api.get(`/api/sessions/${live.sessionId}/memory`), 409, 'SESSION_NOT_LIVE');
  });
});
