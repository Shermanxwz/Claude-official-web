// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { createAttachments } from '../../src/attachments.mjs';
import { AppError, UPLOAD_DIR_NAME } from '../../src/contracts.mjs';
import { createStateStore } from '../../src/state.mjs';
import { createWorkspaces } from '../../src/workspaces.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH_RE = /^\d{8}-[0-9a-f]{8}$/;
const CONFIG = { uploadMaxBytes: 64 * 1024, imageMaxBytes: 4 * 1024, uploadRetentionDays: 7 };

/** Signature and IHDR header of a 1x1 8-bit RGB PNG (no pixel data; detection needs only the signature). */
const PNG_HEADER = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de', 'hex');
const JPEG_HEADER = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const GIF_HEADER = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([1, 0, 1, 0, 0x80, 0, 0, 0x3b])]);
const WEBP_HEADER = Buffer.concat([
  Buffer.from('RIFF'), Buffer.from([0x1a, 0, 0, 0]), Buffer.from('WEBPVP8L'), Buffer.from([0x0a, 0, 0, 0, 0x2f]),
]);

/**
 * @param {unknown} value
 * @returns {any}
 */
const untyped = (value) => value;

/**
 * @param {Promise<unknown>} promise
 * @param {number} status
 * @param {string} code
 */
function assertAppError(promise, status, code) {
  return assert.rejects(promise, (err) => err instanceof AppError && err.status === status && err.code === code);
}

/**
 * Simulated IncomingMessage: a readable of the given chunks with a headers object.
 * @param {Array<Buffer|string>|Buffer|string} body
 * @param {Record<string, string>} [headers]
 */
function request(body, headers = {}) {
  const chunks = Array.isArray(body) ? body : [body];
  return Object.assign(Readable.from(chunks.map((chunk) => (typeof chunk === 'string' ? Buffer.from(chunk) : chunk))),
    { headers });
}

function createLog() {
  /** @type {Array<{level: string, message: string, fields: Record<string, unknown>}>} */
  const entries = [];
  /** @param {string} level */
  const record = (level) => (/** @type {string} */ message, /** @type {Record<string, unknown>} */ fields = {}) => {
    entries.push({ level, message, fields });
  };
  return { entries, debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') };
}

/** @param {string} dir */
async function batchEntries(dir) {
  try {
    return (await fs.promises.readdir(path.join(dir, UPLOAD_DIR_NAME))).sort();
  } catch {
    return null;
  }
}

describe('attachments', () => {
  /** @type {string} */
  let tmp;
  /** @type {string} */
  let ws;
  /** @type {string} */
  let outside;
  /** @type {ReturnType<typeof createWorkspaces>} */
  let workspaces;
  /** @type {ReturnType<typeof createStateStore>} */
  let stateStore;

  before(async () => {
    tmp = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'caw-attach-')));
    ws = path.join(tmp, 'ws');
    outside = path.join(tmp, 'outside');
    await fs.promises.mkdir(ws, { recursive: true });
    await fs.promises.mkdir(outside, { recursive: true });
    workspaces = createWorkspaces({ roots: [ws] });
    stateStore = createStateStore(path.join(tmp, 'state'));
  });

  after(async () => {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  });

  /**
   * @param {string} name
   * @returns {Promise<string>} a new empty working directory inside the root
   */
  async function freshCwd(name) {
    const dir = path.join(ws, name);
    await fs.promises.mkdir(dir, { recursive: true });
    return dir;
  }

  /**
   * @param {{overrides?: Record<string, unknown>, store?: ReturnType<typeof createStateStore>,
   *   logger?: unknown}} [opts]
   */
  function makeAttachments({ overrides = {}, store = stateStore, logger = createLog() } = {}) {
    return createAttachments({
      config: untyped({ ...CONFIG, ...overrides }),
      log: untyped(logger),
      workspaces,
      stateStore: store,
    });
  }

  describe('save', () => {
    it('stores a file in a 0700 batch directory as a 0600 file and records the batch', async () => {
      const cwd = await freshCwd('happy');
      const attachments = makeAttachments();
      const result = await attachments.save(request('hello world'), {
        cwd, fileName: 'notes.txt', mediaType: 'text/plain; charset=utf-8',
      });

      assert.deepEqual(Object.keys(result).sort(), ['kind', 'mediaType', 'name', 'path', 'size']);
      assert.equal(result.name, 'notes.txt');
      assert.equal(result.size, 11);
      assert.equal(result.kind, 'file');
      assert.equal(result.mediaType, 'text/plain');
      const batch = path.dirname(result.path);
      assert.equal(path.dirname(batch), path.join(cwd, UPLOAD_DIR_NAME));
      assert.match(path.basename(batch), BATCH_RE);
      assert.equal(await fs.promises.readFile(result.path, 'utf8'), 'hello world');
      assert.equal((await fs.promises.stat(result.path)).mode & 0o777, 0o600);
      assert.equal((await fs.promises.stat(batch)).mode & 0o777, 0o700);
      assert.equal((await fs.promises.stat(path.join(cwd, UPLOAD_DIR_NAME))).mode & 0o777, 0o700);
      assert.deepEqual(await fs.promises.readdir(batch), ['notes.txt']);

      const state = await stateStore.read('uploads', { dirs: [] });
      const record = state.dirs.find((entry) => entry.path === batch);
      assert.equal(typeof record?.createdAt, 'number');
    });

    it('detects PNG, JPEG, GIF and WEBP by magic bytes and overrides the declared media type', async () => {
      const cwd = await freshCwd('images');
      const attachments = makeAttachments();
      const cases = [
        ['a.png', PNG_HEADER, 'application/pdf', 'image/png'],
        ['b.jpg', JPEG_HEADER, 'text/plain', 'image/jpeg'],
        ['c.gif', GIF_HEADER, 'application/octet-stream', 'image/gif'],
        ['d.webp', WEBP_HEADER, 'image/png', 'image/webp'],
      ];
      for (const [fileName, bytes, declared, expected] of cases) {
        const result = await attachments.save(request(bytes), { cwd, fileName, mediaType: declared });
        assert.equal(result.kind, 'image', fileName);
        assert.equal(result.mediaType, expected, fileName);
        assert.equal(result.size, bytes.length);
      }
    });

    it('keeps a valid non-image declared type and falls back to octet-stream otherwise', async () => {
      const cwd = await freshCwd('declared');
      const attachments = makeAttachments();
      const cases = [
        ['text/plain; charset=utf-8', 'text/plain'],
        ['TEXT/HTML', 'text/html'],
        ['application/x-thing+json', 'application/x-thing+json'],
        ['image/svg+xml', 'application/octet-stream'],
        ['image/png', 'application/octet-stream'],
        ['not a mime', 'application/octet-stream'],
        ['', 'application/octet-stream'],
        ['a'.repeat(300) + '/x', 'application/octet-stream'],
        [undefined, 'application/octet-stream'],
      ];
      for (const [declared, expected] of cases) {
        const result = await attachments.save(request('plain text'), {
          cwd, fileName: 'f.txt', mediaType: untyped(declared),
        });
        assert.equal(result.kind, 'file', String(declared));
        assert.equal(result.mediaType, expected, String(declared));
      }
    });

    it('treats truncated magic bytes and empty uploads as plain files', async () => {
      const cwd = await freshCwd('truncated');
      const attachments = makeAttachments();
      const short = await attachments.save(request(Buffer.from([0xff, 0xd8])), {
        cwd, fileName: 'short.jpg', mediaType: 'application/octet-stream',
      });
      assert.equal(short.kind, 'file');
      assert.equal(short.size, 2);
      const empty = await attachments.save(request([]), { cwd, fileName: 'empty.txt', mediaType: 'text/plain' });
      assert.equal(empty.kind, 'file');
      assert.equal(empty.size, 0);
      assert.equal(empty.mediaType, 'text/plain');
    });

    it('rejects bodies over the limit with 413 and removes the partial batch', async () => {
      const cwd = await freshCwd('limit');
      const attachments = makeAttachments({ overrides: { uploadMaxBytes: 16 } });
      await assertAppError(
        attachments.save(request([Buffer.alloc(10), Buffer.alloc(10)]), {
          cwd, fileName: 'big.bin', mediaType: 'application/octet-stream',
        }),
        413,
        'PAYLOAD_TOO_LARGE',
      );
      assert.deepEqual(await batchEntries(cwd), []);

      const exact = await attachments.save(request([Buffer.alloc(8), Buffer.alloc(8)]), {
        cwd, fileName: 'edge.bin', mediaType: 'application/octet-stream',
      });
      assert.equal(exact.size, 16);
    });

    it('refuses a declared Content-Length above the limit before creating anything', async () => {
      const cwd = await freshCwd('declared-length');
      const attachments = makeAttachments({ overrides: { uploadMaxBytes: 16 } });
      await assertAppError(
        attachments.save(request('x', { 'content-length': '999999' }), {
          cwd, fileName: 'a.txt', mediaType: 'text/plain',
        }),
        413,
        'PAYLOAD_TOO_LARGE',
      );
      assert.equal(await batchEntries(cwd), null);
    });

    it('rejects a malformed Content-Length with 400', async () => {
      const cwd = await freshCwd('bad-length');
      const attachments = makeAttachments();
      for (const value of ['abc', '-1', '1.5', '']) {
        await assertAppError(
          attachments.save(request('x', { 'content-length': value }), {
            cwd, fileName: 'a.txt', mediaType: 'text/plain',
          }),
          400,
          'BAD_REQUEST',
        );
      }
    });

    it('maps a client abort to 400 and removes the partial upload', async () => {
      const cwd = await freshCwd('abort');
      const attachments = makeAttachments();
      const interrupted = Readable.from((async function* interruptedBody() {
        yield Buffer.from('partial data');
        throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      })());
      await assertAppError(
        attachments.save(Object.assign(interrupted, { headers: {} }), {
          cwd, fileName: 'x.bin', mediaType: 'application/octet-stream',
        }),
        400,
        'BAD_REQUEST',
      );
      assert.deepEqual(await batchEntries(cwd), []);
    });

    it('sanitises file names and always keeps the file inside its batch directory', async () => {
      const cwd = await freshCwd('names');
      const attachments = makeAttachments();
      const cases = [
        ['../../etc/passwd', 'passwd'],
        ['..\\..\\evil.exe', 'evil.exe'],
        ['/abs/path/report.pdf', 'report.pdf'],
        ['C:\\Users\\me\\doc.txt', 'doc.txt'],
        ['...', 'file'],
        ['', 'file'],
        ['   ', 'file'],
        ['***', 'file'],
        ['.hidden', 'hidden'],
        ['trailing. ', 'trailing'],
        ['a\u0000b.txt', 'ab.txt'],
        ['tab\there\nnew.txt', 'tabherenew.txt'],
        ['a  b   c.txt', 'a b c.txt'],
        ['  spaced name  .txt  ', 'spaced name .txt'],
        ['r\u00e9sum\u00e9.pdf', 'rsum.pdf'],
        ['emoji\u{1F600}.txt', 'emoji.txt'],
        ['\u62a5\u544a \u6700\u7ec8\u7248 (1).pdf', '\u62a5\u544a \u6700\u7ec8\u7248 (1).pdf'],
        ['a+b=c;d.txt', 'abcd.txt'],
        [undefined, 'file'],
      ];
      for (const [fileName, expected] of cases) {
        const result = await attachments.save(request('x'), {
          cwd, fileName: untyped(fileName), mediaType: 'text/plain',
        });
        assert.equal(result.name, expected, JSON.stringify(fileName));
        assert.equal(path.basename(result.path), expected, JSON.stringify(fileName));
        assert.equal(path.dirname(path.dirname(result.path)), path.join(cwd, UPLOAD_DIR_NAME));
      }
    });

    it('limits names to 120 characters and keeps a short extension', async () => {
      const cwd = await freshCwd('long-names');
      const attachments = makeAttachments();
      const withExtension = await attachments.save(request('x'), {
        cwd, fileName: `${'x'.repeat(200)}.pdf`, mediaType: 'application/pdf',
      });
      assert.equal(withExtension.name.length, 120);
      assert.ok(withExtension.name.endsWith('.pdf'));

      const withoutExtension = await attachments.save(request('x'), {
        cwd, fileName: 'y'.repeat(200), mediaType: 'text/plain',
      });
      assert.equal(withoutExtension.name.length, 120);

      const longExtension = await attachments.save(request('x'), {
        cwd, fileName: `${'a'.repeat(100)}.${'b'.repeat(40)}`, mediaType: 'text/plain',
      });
      assert.equal(longExtension.name.length, 120);
      assert.ok(longExtension.name.startsWith('a'.repeat(100)));
    });

    it('refuses a .caw-uploads that is a symbolic link or a regular file', async () => {
      const linked = await freshCwd('link-root');
      const target = path.join(outside, 'store');
      await fs.promises.mkdir(target, { recursive: true });
      await fs.promises.symlink(target, path.join(linked, UPLOAD_DIR_NAME));
      const attachments = makeAttachments();
      await assertAppError(
        attachments.save(request('x'), { cwd: linked, fileName: 'a.txt', mediaType: 'text/plain' }),
        422,
        'PATH_NOT_ALLOWED',
      );
      assert.deepEqual(await fs.promises.readdir(target), []);

      const filed = await freshCwd('file-root');
      await fs.promises.writeFile(path.join(filed, UPLOAD_DIR_NAME), 'not a directory');
      await assertAppError(
        attachments.save(request('x'), { cwd: filed, fileName: 'a.txt', mediaType: 'text/plain' }),
        422,
        'PATH_NOT_ALLOWED',
      );
    });

    it('validates the working directory', async () => {
      const attachments = makeAttachments();
      const options = { fileName: 'a.txt', mediaType: 'text/plain' };
      await assertAppError(attachments.save(request('x'), { ...options, cwd: outside }), 422, 'PATH_NOT_ALLOWED');
      await assertAppError(attachments.save(request('x'), { ...options, cwd: 'relative' }), 422, 'PATH_NOT_ALLOWED');
      await assertAppError(
        attachments.save(request('x'), { ...options, cwd: path.join(ws, 'missing') }),
        422,
        'PATH_NOT_ALLOWED',
      );
    });

    it('records concurrent uploads without losing entries', async () => {
      const store = createStateStore(path.join(tmp, 'state-concurrent'));
      const attachments = makeAttachments({ store });
      const cwd = await freshCwd('concurrent');
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => attachments.save(
        request(`body ${i}`), { cwd, fileName: `f${i}.txt`, mediaType: 'text/plain' },
      )));
      const state = await store.read('uploads', { dirs: [] });
      assert.equal(state.dirs.length, 10);
      assert.equal(new Set(state.dirs.map((entry) => entry.path)).size, 10);
      for (const result of results) {
        assert.ok(state.dirs.some((entry) => entry.path === path.dirname(result.path)));
      }
    });

    it('keeps only the newest 10 000 batch records', async () => {
      const store = createStateStore(path.join(tmp, 'state-bounded'));
      const dirs = Array.from({ length: 10000 }, (_, i) => ({
        path: path.join(tmp, 'ghost', String(i)), createdAt: i,
      }));
      await store.write('uploads', { dirs });
      const attachments = makeAttachments({ store });
      const cwd = await freshCwd('bounded');
      const result = await attachments.save(request('x'), { cwd, fileName: 'a.txt', mediaType: 'text/plain' });
      const state = await store.read('uploads', { dirs: [] });
      assert.equal(state.dirs.length, 10000);
      assert.equal(state.dirs[0].createdAt, 1);
      assert.equal(state.dirs[9999].path, path.dirname(result.path));
    });

    it('removes the batch directories of evicted records under the cleanup safety checks', async () => {
      const store = createStateStore(path.join(tmp, 'state-evict'));
      const attachments = makeAttachments({ store });
      const cwd = await freshCwd('evict');
      const uploads = path.join(cwd, UPLOAD_DIR_NAME);
      const oldBatch = path.join(uploads, '20250101-11111111');
      await fs.promises.mkdir(oldBatch, { recursive: true });
      await fs.promises.writeFile(path.join(oldBatch, 'old.txt'), 'old');
      const escapeTarget = path.join(outside, 'evict-target');
      await fs.promises.mkdir(escapeTarget, { recursive: true });
      await fs.promises.writeFile(path.join(escapeTarget, 'keep.txt'), 'keep');
      const linkedBatch = path.join(uploads, '20250101-22222222');
      await fs.promises.symlink(escapeTarget, linkedBatch);
      const ghosts = Array.from({ length: 9999 }, (_, i) => ({
        path: path.join(tmp, 'ghost', String(i)), createdAt: i + 2,
      }));
      await store.write('uploads', {
        dirs: [{ path: oldBatch, createdAt: 0 }, { path: linkedBatch, createdAt: 1 }, ...ghosts],
      });

      const result = await attachments.save(request('new'), { cwd, fileName: 'new.txt', mediaType: 'text/plain' });

      assert.equal(fs.existsSync(oldBatch), false);
      assert.equal(fs.lstatSync(linkedBatch).isSymbolicLink(), true);
      assert.equal(fs.readFileSync(path.join(escapeTarget, 'keep.txt'), 'utf8'), 'keep');
      const { dirs } = await store.read('uploads', { dirs: [] });
      assert.equal(dirs.length, 10000);
      assert.equal(dirs.at(-1).path, path.dirname(result.path));
      assert.equal(dirs.some((entry) => entry.path === oldBatch || entry.path === linkedBatch), false);
    });

    it('never logs file names or file contents', async () => {
      const logger = createLog();
      const attachments = makeAttachments({ logger });
      const cwd = await freshCwd('privacy');
      await attachments.save(request('TOP-SECRET-BODY'), {
        cwd, fileName: 'secret-name-xyz.txt', mediaType: 'text/plain',
      });
      const logged = JSON.stringify(logger.entries);
      assert.equal(logged.includes('secret-name-xyz'), false);
      assert.equal(logged.includes('TOP-SECRET-BODY'), false);
    });
  });

  describe('resolveAttachment', () => {
    /** @type {string} */
    let cwd;
    /** @type {string} */
    let batch;
    /** @type {{small: string, large: string, text: string}} */
    let saved;
    /** @type {ReturnType<typeof makeAttachments>} */
    let api;

    before(async () => {
      cwd = await freshCwd('resolve');
      api = makeAttachments({ overrides: { imageMaxBytes: 64 } });
      const small = await api.save(request(PNG_HEADER), { cwd, fileName: 'small.png', mediaType: 'image/png' });
      const large = await api.save(request(Buffer.concat([PNG_HEADER, Buffer.alloc(100)])), {
        cwd, fileName: 'large.png', mediaType: 'image/png',
      });
      const text = await api.save(request('just text'), { cwd, fileName: 'text.txt', mediaType: 'text/plain' });
      saved = { small: small.path, large: large.path, text: text.path };
      batch = path.dirname(small.path);
      await fs.promises.writeFile(path.join(cwd, 'outside-uploads.txt'), 'not an upload');
      await fs.promises.writeFile(path.join(outside, 'target.txt'), 'outside');
    });

    it('returns small images as base64 data', async () => {
      const resolved = await api.resolveAttachment(saved.small, cwd);
      assert.deepEqual(resolved, { kind: 'image', mediaType: 'image/png', data: PNG_HEADER.toString('base64') });
    });

    it('returns oversized images and other files as realpath references', async () => {
      assert.deepEqual(await api.resolveAttachment(saved.large, cwd), { kind: 'file', path: saved.large });
      assert.deepEqual(await api.resolveAttachment(saved.text, cwd), { kind: 'file', path: saved.text });
    });

    it('rejects paths outside this working directory uploads', async () => {
      const cases = [
        path.join(cwd, 'outside-uploads.txt'),
        path.join(cwd, UPLOAD_DIR_NAME),
        batch,
        `${batch}/../../outside-uploads.txt`,
        path.join(cwd, UPLOAD_DIR_NAME, 'does-not-exist.txt'),
        'relative/path.txt',
        `${saved.text}\0`,
        path.join(outside, 'target.txt'),
      ];
      for (const candidate of cases) {
        await assertAppError(api.resolveAttachment(candidate, cwd), 422, 'PATH_NOT_ALLOWED');
      }
    });

    it('rejects an upload that belongs to a different working directory', async () => {
      const other = await freshCwd('resolve-other');
      await assertAppError(api.resolveAttachment(saved.text, other), 422, 'PATH_NOT_ALLOWED');
    });

    it('rejects a symbolic link inside the uploads that points outside them', async () => {
      const link = path.join(batch, 'escape-link.txt');
      await fs.promises.symlink(path.join(outside, 'target.txt'), link);
      await assertAppError(api.resolveAttachment(link, cwd), 422, 'PATH_NOT_ALLOWED');
    });

    it('rejects a working directory outside the roots', async () => {
      await assertAppError(api.resolveAttachment(saved.text, outside), 422, 'PATH_NOT_ALLOWED');
    });
  });

  describe('cleanup', () => {
    it('removes batches older than the retention window and keeps newer ones', async () => {
      const store = createStateStore(path.join(tmp, 'state-cleanup-age'));
      const attachments = makeAttachments({ store });
      const cwd = await freshCwd('cleanup-age');
      const old = await attachments.save(request('old'), { cwd, fileName: 'old.txt', mediaType: 'text/plain' });
      const fresh = await attachments.save(request('new'), { cwd, fileName: 'new.txt', mediaType: 'text/plain' });
      const state = await store.read('uploads', { dirs: [] });
      state.dirs[0].createdAt = Date.now() - 8 * DAY_MS;
      await store.write('uploads', state);

      assert.deepEqual(await attachments.cleanup(), { removed: 1 });
      assert.equal(fs.existsSync(path.dirname(old.path)), false);
      assert.equal(fs.existsSync(path.dirname(fresh.path)), true);
      assert.equal((await store.read('uploads', { dirs: [] })).dirs.length, 1);
    });

    it('uses the injected clock to decide what has expired', async () => {
      const store = createStateStore(path.join(tmp, 'state-cleanup-clock'));
      const attachments = makeAttachments({ store });
      const cwd = await freshCwd('cleanup-clock');
      const saved = await attachments.save(request('x'), { cwd, fileName: 'a.txt', mediaType: 'text/plain' });
      const { createdAt } = (await store.read('uploads', { dirs: [] })).dirs[0];

      assert.deepEqual(await attachments.cleanup(createdAt + 6 * DAY_MS), { removed: 0 });
      assert.equal(fs.existsSync(path.dirname(saved.path)), true);
      assert.deepEqual(await attachments.cleanup(createdAt + 8 * DAY_MS), { removed: 1 });
      assert.equal(fs.existsSync(path.dirname(saved.path)), false);
    });

    it('drops records of missing directories without counting them', async () => {
      const store = createStateStore(path.join(tmp, 'state-cleanup-missing'));
      const attachments = makeAttachments({ store });
      const cwd = await freshCwd('cleanup-missing');
      const saved = await attachments.save(request('x'), { cwd, fileName: 'a.txt', mediaType: 'text/plain' });
      await fs.promises.rm(path.dirname(saved.path), { recursive: true, force: true });

      assert.deepEqual(await attachments.cleanup(Date.now() + 8 * DAY_MS), { removed: 0 });
      assert.deepEqual((await store.read('uploads', { dirs: [] })).dirs, []);
    });

    it('never deletes records that do not follow the upload layout or that point at symbolic links', async () => {
      const store = createStateStore(path.join(tmp, 'state-cleanup-unsafe'));
      const attachments = makeAttachments({ store });
      const cwd = await freshCwd('cleanup-unsafe');
      const uploads = path.join(cwd, UPLOAD_DIR_NAME);
      await fs.promises.mkdir(uploads, { recursive: true });
      const realOutside = path.join(outside, 'precious');
      await fs.promises.mkdir(realOutside, { recursive: true });
      await fs.promises.writeFile(path.join(realOutside, 'keep.txt'), 'keep');
      const linkedBatch = path.join(uploads, '20260101-aaaaaaaa');
      await fs.promises.symlink(realOutside, linkedBatch);
      const looksLikeBatch = path.join(cwd, 'data', '20260101-bbbbbbbb');
      await fs.promises.mkdir(looksLikeBatch, { recursive: true });
      await store.write('uploads', {
        dirs: [
          { path: realOutside, createdAt: 0 },
          { path: linkedBatch, createdAt: 0 },
          { path: looksLikeBatch, createdAt: 0 },
          { path: `${uploads}/../../outside`, createdAt: 0 },
        ],
      });

      assert.deepEqual(await attachments.cleanup(Date.now()), { removed: 0 });
      assert.equal(fs.readFileSync(path.join(realOutside, 'keep.txt'), 'utf8'), 'keep');
      assert.equal(fs.existsSync(looksLikeBatch), true);
      assert.deepEqual((await store.read('uploads', { dirs: [] })).dirs, []);
    });

    it('does nothing when no batch has expired', async () => {
      const attachments = makeAttachments();
      assert.deepEqual(await attachments.cleanup(), { removed: 0 });
    });
  });
});
