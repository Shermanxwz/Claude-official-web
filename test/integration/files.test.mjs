/**
 * Integration tests: workspace browsing and folder creation, the file search used for @-mentions, uploads (images and
 * other files), the attachments a message may reference, and the upload size limit. Every test talks to a real gateway
 * whose engine is the deterministic mock.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, it, before, after } from 'node:test';
import {
  assertError,
  client,
  createLive,
  eventNamed,
  startTestServer,
} from './helpers.mjs';

/** A PNG signature followed by padding: enough for the gateway to recognise the image by its bytes. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const UPLOAD_PATH = /\/\.caw-uploads\/\d{8}-[0-9a-f]{8}\//;

/**
 * Uploads one file to a folder.
 * @param {ReturnType<typeof client>} api
 * @param {string} cwd
 * @param {string} name the file name, as the browser would send it (it is URI-encoded on the wire)
 * @param {Buffer|string} body
 * @param {Record<string, string>} [headers]
 */
function upload(api, cwd, name, body, headers = {}) {
  return api.post(`/api/attachments?cwd=${encodeURIComponent(cwd)}`, body, {
    headers: { 'X-File-Name': encodeURIComponent(name), ...headers },
  });
}

describe('files: workspaces', { timeout: 120000 }, () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let server;
  /** @type {ReturnType<typeof client>} */
  let api;
  before(async () => {
    server = await startTestServer();
    api = client(server.url);
    await api.login();
  });
  after(async () => {
    await server.close();
  });

  it('lists the workspace roots at the top level, and marks project folders and omits hidden ones', async () => {
    fs.mkdirSync(path.join(server.root, '.hidden-dir'));
    const top = await api.get('/api/fs/dirs');
    assert.equal(top.status, 200);
    assert.deepEqual(top.json, {
      path: null,
      parent: null,
      entries: [{ name: path.basename(server.root), path: server.root, isProject: false }],
    });
    const inside = await api.get(`/api/fs/dirs?path=${encodeURIComponent(server.root)}`);
    assert.equal(inside.json.path, server.root);
    assert.equal(inside.json.parent, null, 'a root has no parent to climb to');
    assert.deepEqual(inside.json.entries, [{ name: 'proj', path: server.proj, isProject: true }],
      'the hidden folder is omitted and proj is a project because it has a package.json');
  });

  it('lists the folders of a folder sorted by name, with its parent and the project flags', async () => {
    fs.mkdirSync(path.join(server.proj, 'zeta'));
    fs.mkdirSync(path.join(server.proj, 'Alpha'));
    fs.writeFileSync(path.join(server.proj, 'Alpha', 'CLAUDE.md'), '# Alpha\n');
    fs.mkdirSync(path.join(server.proj, '.cache'));
    const res = await api.get(`/api/fs/dirs?path=${encodeURIComponent(server.proj)}`);
    assert.equal(res.status, 200);
    assert.equal(res.json.parent, server.root);
    assert.deepEqual(res.json.entries.map((entry) => entry.name), ['Alpha', 'node_modules', 'src', 'zeta']);
    const flags = Object.fromEntries(res.json.entries.map((entry) => [entry.name, entry.isProject]));
    assert.deepEqual(flags, { Alpha: true, node_modules: false, src: false, zeta: false });
    assert.ok(res.json.entries.every((entry) => entry.path === path.join(server.proj, entry.name)));
  });

  it('refuses to list a folder outside the roots, also when the path climbs out of a root', async () => {
    assertError(await api.get(`/api/fs/dirs?path=${encodeURIComponent(server.outside)}`), 422, 'PATH_NOT_ALLOWED');
    assertError(await api.get(`/api/fs/dirs?path=${encodeURIComponent(`${server.proj}/../../outside`)}`), 422,
      'PATH_NOT_ALLOWED');
    assertError(await api.get(`/api/fs/dirs?path=${encodeURIComponent(`${server.proj}/src/app.js`)}`), 422,
      'PATH_NOT_ALLOWED');
  });

  it('creates a folder inside a root, and refuses names that are invalid, taken or outside', async () => {
    const created = await api.post('/api/fs/mkdir', { parent: server.proj, name: 'docs' });
    assert.equal(created.status, 200);
    assert.equal(created.json.path, path.join(server.proj, 'docs'));
    assert.ok(fs.statSync(created.json.path).isDirectory());
    assertError(await api.post('/api/fs/mkdir', { parent: server.proj, name: 'docs' }), 409, 'CONFLICT');
    for (const name of ['a/b', '..', '.', '', 'semi;colon']) {
      assertError(await api.post('/api/fs/mkdir', { parent: server.proj, name }), 422, 'INVALID_ARGUMENT');
    }
    assertError(await api.post('/api/fs/mkdir', { parent: server.proj, name: 'x'.repeat(101) }), 400,
      'BAD_REQUEST');
    assertError(await api.post('/api/fs/mkdir', { parent: server.proj, name: 42 }), 400, 'BAD_REQUEST');
    assertError(await api.post('/api/fs/mkdir', { parent: server.outside, name: 'fresh' }), 422,
      'PATH_NOT_ALLOWED');
    assert.equal(fs.existsSync(path.join(server.outside, 'fresh')), false);
  });

  it('searches files by name and ranks an exact name above a prefix and a substring', async () => {
    fs.writeFileSync(path.join(server.proj, 'app-notes.md'), '# Notes\n');
    const exact = await api.get(`/api/fs/search?cwd=${encodeURIComponent(server.proj)}&q=app.js`);
    assert.equal(exact.status, 200);
    assert.equal(exact.json.results[0].path, path.join('src', 'app.js'));
    assert.equal(exact.json.results[0].type, 'file');

    const prefix = await api.get(`/api/fs/search?cwd=${encodeURIComponent(server.proj)}&q=app`);
    const paths = prefix.json.results.map((result) => result.path);
    assert.ok(paths.includes(path.join('src', 'app.js')) && paths.includes('app-notes.md'));
    assert.equal(paths[0], 'app-notes.md', 'a name that starts with the query and matches the whole path ranks first');
    assert.ok(!paths.some((item) => item.startsWith('node_modules')), 'node_modules is not searched');
    assert.ok(!paths.some((item) => item.startsWith('.git')), '.git is not searched');

    const folder = await api.get(`/api/fs/search?cwd=${encodeURIComponent(server.proj)}&q=util`);
    assert.ok(folder.json.results.some((result) => result.path === path.join('src', 'util') && result.type === 'dir'),
      'folders are results too, marked as dir');
    assert.equal((await api.get(`/api/fs/search?cwd=${encodeURIComponent(server.proj)}&q=left-pad`)).json.results
      .length, 0, 'files in node_modules are skipped');
    assert.equal((await api.get(`/api/fs/search?cwd=${encodeURIComponent(server.proj)}&q=config`)).json.results
      .length, 0, 'files in .git are skipped');
  });

  it('bounds the search: the limit is 1 to 200, the query is at most 200 characters, the folder must be inside a root',
    async () => {
      const cwd = encodeURIComponent(server.proj);
      const one = await api.get(`/api/fs/search?cwd=${cwd}&q=app&limit=1`);
      assert.equal(one.json.results.length, 1);
      assertError(await api.get(`/api/fs/search?cwd=${cwd}&q=app&limit=0`), 400, 'BAD_REQUEST');
      assertError(await api.get(`/api/fs/search?cwd=${cwd}&q=app&limit=201`), 400, 'BAD_REQUEST');
      assertError(await api.get(`/api/fs/search?cwd=${cwd}&q=${'a'.repeat(201)}`), 400, 'BAD_REQUEST');
      assertError(await api.get(`/api/fs/search?cwd=${encodeURIComponent(server.outside)}&q=app`), 422,
        'PATH_NOT_ALLOWED');
    });

  it('with an empty query, lists the most recently modified files and no folders', async () => {
    const recent = path.join(server.proj, 'app-notes.md');
    const future = Date.now() / 1000 + 3600;
    fs.utimesSync(recent, future, future);
    const res = await api.get(`/api/fs/search?cwd=${encodeURIComponent(server.proj)}&q=`);
    assert.equal(res.json.results[0].path, 'app-notes.md');
    assert.ok(res.json.results.every((result) => result.type === 'file'));
  });
});

describe('files: uploads and attachments', { timeout: 120000 }, () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let server;
  /** @type {ReturnType<typeof client>} */
  let api;
  before(async () => {
    server = await startTestServer();
    api = client(server.url);
    await api.login();
  });
  after(async () => {
    await server.close();
  });

  it('stores an image under .caw-uploads with mode 0600 and recognises it by its bytes', async () => {
    const res = await upload(api, server.proj, 'photo.png', PNG, { 'Content-Type': 'image/png' });
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.json).sort(), ['kind', 'mediaType', 'name', 'path', 'size']);
    assert.equal(res.json.name, 'photo.png');
    assert.equal(res.json.kind, 'image');
    assert.equal(res.json.mediaType, 'image/png');
    assert.equal(res.json.size, PNG.length);
    assert.match(res.json.path, new RegExp(`^${server.proj.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(res.json.path, UPLOAD_PATH);
    assert.match(res.json.path, /\/\d{8}-[0-9a-f]{8}\/photo\.png$/);
    assert.equal(fs.statSync(res.json.path).mode & 0o777, 0o600);
    assert.deepEqual(fs.readFileSync(res.json.path), PNG);
  });

  it('stores any other file as a file, even when the browser calls it an image', async () => {
    const claimed = await upload(api, server.proj, 'notes.txt', 'plain notes\n', { 'Content-Type': 'image/png' });
    assert.equal(claimed.status, 200);
    assert.equal(claimed.json.kind, 'file');
    assert.ok(!claimed.json.mediaType.startsWith('image/'));
    const text = await upload(api, server.proj, 'readme.md', 'hello\n', {
      'Content-Type': 'text/markdown; charset=utf-8',
    });
    assert.equal(text.json.kind, 'file');
    assert.equal(text.json.mediaType, 'text/markdown');
  });

  it('keeps the spaces and brackets of a file name, and decodes its URI encoding', async () => {
    const res = await upload(api, server.proj, 'my notes (v2).txt', 'x\n');
    assert.equal(res.status, 200);
    assert.equal(res.json.name, 'my notes (v2).txt');
    assert.equal(path.basename(res.json.path), 'my notes (v2).txt');
  });

  it('refuses malformed upload requests with 400 BAD_REQUEST, and folders outside the roots with 422', async () => {
    const target = `/api/attachments?cwd=${encodeURIComponent(server.proj)}`;
    assertError(await api.post(target, 'x'), 400, 'BAD_REQUEST');
    assertError(await api.post(target, 'x', { headers: { 'X-File-Name': 'a%2Fb.txt' } }), 400, 'BAD_REQUEST');
    assertError(await api.post(target, 'x', { headers: { 'X-File-Name': '%E0%A4%A' } }), 400, 'BAD_REQUEST');
    assertError(await api.post(target, 'x', { headers: { 'X-File-Name': 'a.txt', 'Content-Type': 'not a type' } }),
      400, 'BAD_REQUEST');
    assertError(await api.post('/api/attachments', 'x', { headers: { 'X-File-Name': 'a.txt' } }), 400,
      'BAD_REQUEST');
    assertError(await upload(api, server.outside, 'a.txt', 'x'), 422, 'PATH_NOT_ALLOWED');
  });

  it('refuses to attach a file that is not in the upload folder of the session, with 422 PATH_NOT_ALLOWED',
    async () => {
      const live = await createLive(api, { cwd: server.proj });
      const pathname = `/api/sessions/${live.sessionId}/messages`;
      const own = await upload(api, server.proj, 'own.txt', 'mine\n');
      const sent = await api.post(pathname, {
        clientMessageId: randomUUID(),
        text: 'Read this',
        attachments: [{ path: own.json.path }],
      });
      assert.equal(sent.status, 200, sent.text);
      assertError(await api.post(pathname, {
        clientMessageId: randomUUID(),
        text: 'Read the code',
        attachments: [{ path: path.join(server.proj, 'src', 'app.js') }],
      }), 422, 'PATH_NOT_ALLOWED');
      assertError(await api.post(pathname, {
        clientMessageId: randomUUID(),
        text: 'Read the other folder',
        attachments: [{ path: path.join(server.proj, '..', 'proj', 'src', 'app.js') }],
      }), 422, 'PATH_NOT_ALLOWED');
      assertError(await api.post(pathname, {
        clientMessageId: randomUUID(),
        text: 'Read a missing file',
        attachments: [{ path: path.join(server.proj, '.caw-uploads', 'missing', 'none.txt') }],
      }), 422, 'PATH_NOT_ALLOWED');
    });

  it('refuses an upload that another folder made, when a session of this folder attaches it', async () => {
    const other = path.join(server.root, 'other');
    fs.mkdirSync(other);
    const foreign = await upload(api, other, 'foreign.txt', 'theirs\n');
    assert.equal(foreign.status, 200);
    const live = await createLive(api, { cwd: server.proj });
    assertError(await api.post(`/api/sessions/${live.sessionId}/messages`, {
      clientMessageId: randomUUID(),
      text: 'Read the foreign file',
      attachments: [{ path: foreign.json.path }],
    }), 422, 'PATH_NOT_ALLOWED');
  });

  it('sends an attached image to the engine as an image block and an attached file as a path in the text',
    async () => {
      const live = await createLive(api, { cwd: server.proj });
      const sessionId = live.sessionId;
      const events = await api.events({ watch: sessionId, after: 0 });
      try {
        const image = await upload(api, server.proj, 'screen.png', PNG, { 'Content-Type': 'image/png' });
        const file = await upload(api, server.proj, 'spec.txt', 'the spec\n');
        const clientMessageId = randomUUID();
        const sent = await api.post(`/api/sessions/${sessionId}/messages`, {
          clientMessageId,
          text: 'Look at both',
          attachments: [{ path: image.json.path }, { path: file.json.path }],
        });
        assert.equal(sent.status, 200, sent.text);
        await events.next(eventNamed('message_accepted', { clientMessageId }));
        await events.next((frame) => frame.event === 'sdk' && frame.data.msg?.type === 'result'
          && frame.data.msg.user_message_uuid === clientMessageId, 10000);
        const transcript = (await api.get(`/api/sessions/${sessionId}/messages?tail=1000`)).json.messages;
        const userMessage = transcript.find((msg) => msg.type === 'user' && msg.uuid === clientMessageId);
        assert.ok(userMessage, 'the stored user message is the one the engine was given');
        const blocks = userMessage.message.content;
        assert.ok(Array.isArray(blocks));
        const imageBlock = blocks.find((block) => block.type === 'image');
        assert.ok(imageBlock, 'the image is a base64 image block');
        assert.equal(imageBlock.source.type, 'base64');
        assert.equal(imageBlock.source.media_type, 'image/png');
        assert.equal(imageBlock.source.data, PNG.toString('base64'));
        const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
        assert.ok(text.includes(`Attached file: ${file.json.path}`), 'the file is referenced by its path');
        assert.ok(!text.includes(image.json.path), 'the image is not referenced as a file');
      } finally {
        events.close();
      }
    });
});

describe('files: upload size limit', { timeout: 120000 }, () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let server;
  /** @type {ReturnType<typeof client>} */
  let api;
  before(async () => {
    server = await startTestServer({ CAW_UPLOAD_MAX_BYTES: '1024' });
    api = client(server.url);
    await api.login();
  });
  after(async () => {
    await server.close();
  });

  /** @returns {string[]} the upload batches that exist in the project */
  function batches() {
    const root = path.join(server.proj, '.caw-uploads');
    return fs.existsSync(root) ? fs.readdirSync(root) : [];
  }

  it('accepts an upload of exactly the limit, and refuses a declared one above it with 413 before reading it',
    async () => {
      const exact = await upload(api, server.proj, 'exact.txt', 'x'.repeat(1024));
      assert.equal(exact.status, 200);
      assert.equal(exact.json.size, 1024);
      assertError(await upload(api, server.proj, 'too-big.txt', 'x'.repeat(1025)), 413, 'PAYLOAD_TOO_LARGE');
      assert.equal(batches().length, 1, 'the refused upload left no batch folder behind');
    });

  it('refuses an upload without a declared length that grows past the limit with 413, and leaves nothing behind',
    async () => {
      const res = await upload(api, server.proj, 'streamed.txt', Buffer.alloc(4096, 0x61), {
        'Transfer-Encoding': 'chunked',
      });
      assertError(res, 413, 'PAYLOAD_TOO_LARGE');
      assert.equal(batches().length, 1, 'only the accepted upload remains');
    });
});
