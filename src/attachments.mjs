// @ts-check
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { AppError, UPLOAD_DIR_NAME } from './contracts.mjs';

/** @typedef {import('./contracts.mjs').Config} Config */
/** @typedef {import('./contracts.mjs').Logger} Logger */
/** @typedef {import('./contracts.mjs').AttachmentsApi} AttachmentsApi */
/** @typedef {import('./contracts.mjs').WorkspacesApi} WorkspacesApi */
/** @typedef {import('./state.mjs').StateStore} StateStore */
/** @typedef {import('node:http').IncomingMessage} IncomingMessage */

/**
 * @typedef {Object} UploadRecord
 * @property {string} path        absolute batch directory created by save()
 * @property {number} createdAt   epoch milliseconds
 */

/**
 * @typedef {Object} Context
 * @property {Config} config
 * @property {Logger} log
 * @property {WorkspacesApi} workspaces
 * @property {ReturnType<typeof createUploadLedger>} ledger
 */

const MAX_NAME_LENGTH = 120;
const MAX_EXTENSION_LENGTH = 32;
const MAX_RECORDS = 10000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HEAD_BYTES = 16;
const MAX_BATCH_ATTEMPTS = 5;
const BATCH_NAME_RE = /^\d{8}-[0-9a-f]{8}$/;
const MIME_RE = /^[a-z0-9!#$%&'*+.^_`|~-]+\/[a-z0-9!#$%&'*+.^_`|~-]+$/;
const CONTENT_LENGTH_RE = /^\d{1,15}$/;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FALLBACK_MEDIA_TYPE = 'application/octet-stream';

/**
 * @param {unknown} err
 * @returns {string|undefined}
 */
function errnoOf(err) {
  return err && typeof err === 'object' && 'code' in err ? String(err.code) : undefined;
}

/**
 * @param {string} p
 * @returns {Promise<import('node:fs').Stats|null>}
 */
function lstatOrNull(p) {
  return fs.promises.lstat(p).catch(() => null);
}

/** @returns {AppError} */
function notAllowed() {
  return new AppError(422, 'PATH_NOT_ALLOWED', 'path is not an upload inside this working directory');
}

/**
 * @param {Date} date
 * @returns {string}
 */
function dateStamp(date) {
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

/**
 * @param {string} text
 * @returns {string}
 */
function trimEnds(text) {
  return text.replace(/^[. ]+/, '').replace(/[. ]+$/, '');
}

/**
 * Keeps letters, digits, '.', '_', spaces, parentheses, '-' and CJK ideographs of the base name. Keeps the extension
 * when the name must be truncated to MAX_NAME_LENGTH.
 * @param {unknown} fileName
 * @returns {string}
 */
function sanitizeFileName(fileName) {
  const raw = typeof fileName === 'string' ? fileName : '';
  const base = raw.replace(/\\/g, '/').split('/').pop() ?? '';
  let name = trimEnds(base
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/[^A-Za-z0-9._ ()\-一-鿿]/g, '')
    .replace(/ {2,}/g, ' '));
  if (name.length > MAX_NAME_LENGTH) {
    const dot = name.lastIndexOf('.');
    const extension = dot > 0 && name.length - dot <= MAX_EXTENSION_LENGTH ? name.slice(dot) : '';
    name = trimEnds(name.slice(0, MAX_NAME_LENGTH - extension.length)) + extension;
  }
  return name === '' ? 'file' : name;
}

/**
 * @param {unknown} value
 * @returns {string} a bare `type/subtype` that is not image/*, or application/octet-stream
 */
function fileMediaType(value) {
  if (typeof value !== 'string') {
    return FALLBACK_MEDIA_TYPE;
  }
  const bare = value.split(';')[0].trim().toLowerCase();
  if (bare.length > 255 || !MIME_RE.test(bare) || bare.startsWith('image/')) {
    return FALLBACK_MEDIA_TYPE;
  }
  return bare;
}

/**
 * @param {Buffer} head first bytes of the file
 * @returns {string|null} image media type recognised by its magic bytes
 */
function detectImageMediaType(head) {
  if (head.length >= PNG_MAGIC.length && head.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    return 'image/png';
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return 'image/jpeg';
  }
  if (head.length >= 6) {
    const gif = head.toString('latin1', 0, 6);
    if (gif === 'GIF87a' || gif === 'GIF89a') {
      return 'image/gif';
    }
  }
  if (head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/**
 * @param {unknown} raw
 * @returns {number|null}
 */
function parseContentLength(raw) {
  if (raw === undefined) {
    return null;
  }
  if (typeof raw !== 'string' || !CONTENT_LENGTH_RE.test(raw)) {
    throw new AppError(400, 'BAD_REQUEST', 'invalid Content-Length');
  }
  return Number(raw);
}

/**
 * Counts the bytes of an upload, keeps its first bytes for magic detection and fails with 413 past the limit.
 */
class UploadGuard extends Transform {
  /** @param {number} maxBytes */
  constructor(maxBytes) {
    super();
    this.maxBytes = maxBytes;
    /** @type {number} */
    this.size = 0;
    /** @type {Buffer} */
    this.head = Buffer.alloc(0);
  }

  /**
   * @param {Buffer} chunk
   * @param {BufferEncoding} _encoding
   * @param {(error?: Error|null, data?: Buffer) => void} callback
   */
  _transform(chunk, _encoding, callback) {
    this.size += chunk.length;
    if (this.size > this.maxBytes) {
      callback(new AppError(413, 'PAYLOAD_TOO_LARGE', `upload exceeds ${this.maxBytes} bytes`));
      return;
    }
    if (this.head.length < HEAD_BYTES) {
      this.head = Buffer.concat([this.head, chunk.subarray(0, HEAD_BYTES - this.head.length)]);
    }
    callback(null, chunk);
  }
}

/**
 * Serialises every read-modify-write of the 'uploads' state record so concurrent uploads and cleanup cannot lose
 * entries. Records beyond MAX_RECORDS are evicted oldest first and their batch directories are removed through
 * `removeBatch`, which applies the cleanup safety checks. A batch that fails to be removed stays recorded and is
 * retried first on the next pass, so the list can exceed the bound only while removals keep failing.
 * @param {StateStore} stateStore
 * @param {(dir: string) => Promise<'removed'|'missing'|'rejected'|'failed'>} removeBatch
 */
function createUploadLedger(stateStore, removeBatch) {
  let queue = Promise.resolve();

  /**
   * @param {unknown} value
   * @returns {value is UploadRecord}
   */
  function isRecord(value) {
    return typeof value === 'object' && value !== null && 'path' in value && 'createdAt' in value
      && typeof value.path === 'string' && typeof value.createdAt === 'number' && Number.isFinite(value.createdAt);
  }

  /**
   * @template T
   * @param {(records: UploadRecord[]) => Promise<{records: UploadRecord[], value: T}>} change
   * @returns {Promise<T>}
   */
  function transact(change) {
    const run = queue.then(async () => {
      const state = await stateStore.read('uploads', { dirs: /** @type {unknown[]} */ ([]) });
      const current = Array.isArray(state?.dirs) ? state.dirs.filter(isRecord) : [];
      const { records, value } = await change(current);
      const overflow = Math.max(0, records.length - MAX_RECORDS);
      /** @type {UploadRecord[]} */
      const retained = [];
      for (const record of records.slice(0, overflow)) {
        if ((await removeBatch(record.path)) === 'failed') {
          retained.push(record);
        }
      }
      await stateStore.write('uploads', { dirs: [...retained, ...records.slice(overflow)] });
      return value;
    });
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  return { transact };
}

/**
 * @param {Context} ctx
 * @param {string} uploadRoot
 */
async function ensureUploadRoot(ctx, uploadRoot) {
  try {
    await fs.promises.mkdir(uploadRoot, { mode: 0o700 });
  } catch (err) {
    if (errnoOf(err) !== 'EEXIST') {
      throw err;
    }
  }
  const stat = await fs.promises.lstat(uploadRoot);
  if (!stat.isDirectory()) {
    ctx.log.warn('upload directory is not a plain directory');
    throw new AppError(422, 'PATH_NOT_ALLOWED', 'upload directory is not a plain directory');
  }
}

/**
 * @param {Context} ctx
 * @param {string} cwd realpath of the working directory
 * @returns {Promise<string>} the new, empty batch directory
 */
async function createBatchDir(ctx, cwd) {
  const uploadRoot = path.join(cwd, UPLOAD_DIR_NAME);
  await ensureUploadRoot(ctx, uploadRoot);
  for (let attempt = 0; attempt < MAX_BATCH_ATTEMPTS; attempt += 1) {
    const dir = path.join(uploadRoot, `${dateStamp(new Date())}-${randomBytes(4).toString('hex')}`);
    try {
      await fs.promises.mkdir(dir, { mode: 0o700 });
      return dir;
    } catch (err) {
      if (errnoOf(err) !== 'EEXIST') {
        throw err;
      }
    }
  }
  throw new Error('could not allocate an upload directory');
}

/**
 * Removes a batch directory this module created. Errors are logged without any name or content.
 * @param {Context} ctx
 * @param {string} dir
 */
async function discardBatch(ctx, dir) {
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
  } catch (err) {
    ctx.log.warn('could not remove a partial upload', { code: errnoOf(err) });
  }
}

/**
 * Maps a failed pipeline to an API error. Errors of the request stream (client abort) become 400; errors of the file
 * writer stay internal.
 * @param {unknown} err
 * @param {IncomingMessage} req
 * @param {'request'|'writer'|null} firstFailure
 * @returns {unknown}
 */
function mapReceiveError(err, req, firstFailure) {
  if (err instanceof AppError) {
    return err;
  }
  if (firstFailure === 'request' || (firstFailure === null && req.aborted === true)) {
    return new AppError(400, 'BAD_REQUEST', 'upload was interrupted');
  }
  return err;
}

/**
 * Streams the request body into `partPath` (flags 'wx', mode 0600) with backpressure and the size limit.
 * @param {Context} ctx
 * @param {IncomingMessage} req
 * @param {string} partPath
 * @returns {Promise<{size: number, head: Buffer}>}
 */
async function receiveBody(ctx, req, partPath) {
  const guard = new UploadGuard(ctx.config.uploadMaxBytes);
  const writer = fs.createWriteStream(partPath, { flags: 'wx', mode: 0o600 });
  /** @type {'request'|'writer'|null} */
  let firstFailure = null;
  req.once('error', () => {
    firstFailure = firstFailure ?? 'request';
  });
  writer.once('error', () => {
    firstFailure = firstFailure ?? 'writer';
  });
  try {
    await pipeline(req, guard, writer);
  } catch (err) {
    throw mapReceiveError(err, req, firstFailure);
  }
  return { size: guard.size, head: guard.head };
}

/**
 * @param {Context} ctx
 * @param {UploadRecord} record
 */
async function recordBatch(ctx, record) {
  await ctx.ledger.transact(async (records) => ({ records: [...records, record], value: undefined }));
}

/**
 * @param {Context} ctx
 * @param {IncomingMessage} req
 * @param {{cwd: string, fileName: string, mediaType: string}} opts
 */
async function saveUpload(ctx, req, opts) {
  const cwd = await ctx.workspaces.resolveDir(opts.cwd);
  const declaredLength = parseContentLength(req.headers?.['content-length']);
  if (declaredLength !== null && declaredLength > ctx.config.uploadMaxBytes) {
    throw new AppError(413, 'PAYLOAD_TOO_LARGE', `upload exceeds ${ctx.config.uploadMaxBytes} bytes`);
  }
  const batchDir = await createBatchDir(ctx, cwd);
  const name = sanitizeFileName(opts.fileName);
  const finalPath = path.join(batchDir, name);
  /** @type {{size: number, head: Buffer}} */
  let received;
  try {
    received = await receiveBody(ctx, req, `${finalPath}.part`);
    await fs.promises.rename(`${finalPath}.part`, finalPath);
  } catch (err) {
    await discardBatch(ctx, batchDir);
    throw err;
  }
  const imageType = detectImageMediaType(received.head);
  try {
    await recordBatch(ctx, { path: batchDir, createdAt: Date.now() });
  } catch (err) {
    await discardBatch(ctx, batchDir);
    throw err;
  }
  /** @type {'file'|'image'} */
  const kind = imageType === null ? 'file' : 'image';
  ctx.log.debug('upload stored', { kind, size: received.size });
  return {
    path: finalPath,
    name,
    size: received.size,
    mediaType: imageType ?? fileMediaType(opts.mediaType),
    kind,
  };
}

/**
 * @param {unknown} p
 * @returns {Promise<string|null>}
 */
async function realpathOrNull(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0')) {
    return null;
  }
  try {
    return await fs.promises.realpath(p);
  } catch {
    return null;
  }
}

/**
 * @param {string} file
 * @returns {Promise<Buffer>}
 */
async function readHead(file) {
  const handle = await fs.promises.open(file, 'r');
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * @param {Context} ctx
 * @param {string} absPath
 * @param {string} cwd
 * @returns {Promise<{kind: 'image', mediaType: string, data: string}|{kind: 'file', path: string}>}
 */
async function resolveUpload(ctx, absPath, cwd) {
  const cwdReal = await ctx.workspaces.resolveDir(cwd);
  const uploadRoot = path.join(cwdReal, UPLOAD_DIR_NAME);
  const file = await realpathOrNull(absPath);
  if (file === null || file === uploadRoot || !file.startsWith(uploadRoot + path.sep)) {
    throw notAllowed();
  }
  const stat = await fs.promises.stat(file).catch(() => null);
  if (stat === null || !stat.isFile()) {
    throw notAllowed();
  }
  const limit = ctx.config.imageMaxBytes;
  if (stat.size > limit) {
    return { kind: 'file', path: file };
  }
  const mediaType = detectImageMediaType(await readHead(file));
  if (mediaType === null) {
    return { kind: 'file', path: file };
  }
  const data = await fs.promises.readFile(file);
  if (data.length > limit) {
    return { kind: 'file', path: file };
  }
  return { kind: 'image', mediaType, data: data.toString('base64') };
}

/**
 * @param {string} dir
 * @returns {boolean} true only for `<...>/.caw-uploads/<YYYYMMDD>-<8 hex>`
 */
function isBatchPath(dir) {
  return path.isAbsolute(dir)
    && path.basename(path.dirname(dir)) === UPLOAD_DIR_NAME
    && BATCH_NAME_RE.test(path.basename(dir));
}

/**
 * Removes one batch directory only when it passes the upload-layout, symbolic-link and roots checks. Used by cleanup
 * and by eviction; anything that fails a check is left untouched.
 * @param {{log: Logger, workspaces: WorkspacesApi}} ctx
 * @param {string} dir
 * @returns {Promise<'removed'|'missing'|'rejected'|'failed'>}
 */
async function removeUploadBatch(ctx, dir) {
  if (!isBatchPath(dir)) {
    ctx.log.warn('dropped an upload record outside the upload layout');
    return 'rejected';
  }
  const parentStat = await lstatOrNull(path.dirname(dir));
  const dirStat = await lstatOrNull(dir);
  if (parentStat === null || dirStat === null) {
    return 'missing';
  }
  if (!parentStat.isDirectory() || !dirStat.isDirectory()) {
    ctx.log.warn('dropped an upload record that is a symbolic link or not a directory');
    return 'rejected';
  }
  if (!(await ctx.workspaces.isInsideRoots(dir))) {
    ctx.log.warn('dropped an upload record outside the workspace roots');
    return 'rejected';
  }
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
    return 'removed';
  } catch (err) {
    ctx.log.warn('upload cleanup failed for one directory', { code: errnoOf(err) });
    return 'failed';
  }
}

/**
 * @param {Context} ctx
 * @param {number} now epoch milliseconds
 * @returns {Promise<{removed: number}>}
 */
function cleanupUploads(ctx, now) {
  const cutoff = now - ctx.config.uploadRetentionDays * DAY_MS;
  return ctx.ledger.transact(async (records) => {
    /** @type {UploadRecord[]} */
    const keep = [];
    let removed = 0;
    for (const record of records) {
      if (record.createdAt >= cutoff) {
        keep.push(record);
        continue;
      }
      const outcome = await removeUploadBatch(ctx, record.path);
      if (outcome === 'removed') {
        removed += 1;
      } else if (outcome === 'failed') {
        keep.push(record);
      }
    }
    return { records: keep, value: { removed } };
  });
}

/**
 * Attachment storage under `<cwd>/.caw-uploads/<YYYYMMDD>-<8 hex>/`. Only directories created by save() are ever
 * deleted.
 * @param {{config: Config, log: Logger, workspaces: WorkspacesApi, stateStore: StateStore}} deps
 * @returns {AttachmentsApi}
 */
export function createAttachments({ config, log, workspaces, stateStore }) {
  /** @type {Context} */
  const ctx = {
    config,
    log,
    workspaces,
    ledger: createUploadLedger(stateStore, (dir) => removeUploadBatch({ log, workspaces }, dir)),
  };
  return {
    save: (req, opts) => saveUpload(ctx, req, opts),
    resolveAttachment: (absPath, cwd) => resolveUpload(ctx, absPath, cwd),
    cleanup: (now = Date.now()) => cleanupUploads(ctx, now),
  };
}
