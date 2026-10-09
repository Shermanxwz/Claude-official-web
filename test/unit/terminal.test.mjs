// Hermetic tests for src/terminal.mjs. A fake node-pty module and a fake engine host stand in for the real pseudo
// terminal and session store; a real HTTP server accepts real WebSocket clients. Nothing starts Claude Code, opens a
// network connection beyond loopback, or reads ~/.claude.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { WebSocket } from 'ws';
import { AppError } from '../../src/contracts.mjs';
import { createTerminal, resolveClaudeBinary } from '../../src/terminal.mjs';

const require = createRequire(import.meta.url);

const SESSION_A = '6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
const SESSION_B = '7a2d3b8f-4c5e-4f60-9b0c-1d2e3f4a5b6c';
const SESSION_C = '8b3e4c9a-5d6f-4071-8c1d-2e3f4a5b6c7d';
const SESSION_D = '9c4f5dab-6e70-4182-9d2e-3f4a5b6c7d8e';
const SESSION_E = 'ad506ebc-7f81-4293-8e3f-4a5b6c7d8e9f';
const SESSION_OUTSIDE = 'be617fcd-8092-43a4-8f40-5b6c7d8e9fa0';
const UNKNOWN_SESSION = 'cf728ade-91a3-44b5-9051-6c7d8e9fa0b1';

/** @type {{base: string, root: string, project: string, outside: string, sibling: string, file: string,
 *   escape: string, claudeBin: string}} */
let fixture;

before(async () => {
  const base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'caw-terminal-test-')));
  const root = path.join(base, 'workspaces', 'main');
  const project = path.join(root, 'project');
  const outside = path.join(base, 'outside');
  const sibling = path.join(base, 'workspaces', 'main-evil');
  const file = path.join(root, 'notes.txt');
  const escape = path.join(root, 'escape');
  const innerLink = path.join(root, 'inner-link');
  await fsp.mkdir(project, { recursive: true });
  await fsp.mkdir(outside, { recursive: true });
  await fsp.mkdir(sibling, { recursive: true });
  await fsp.writeFile(file, 'not a directory\n', { mode: 0o644 });
  await fsp.symlink(outside, escape);
  await fsp.symlink(project, innerLink);
  const claudeBin = await writeExecutable(path.join(base, 'bin'), 'claude');
  fixture = { base, root, project, outside, sibling, file, escape, innerLink, claudeBin };
});

after(async () => {
  await fsp.rm(fixture.base, { recursive: true, force: true });
});

describe('createTerminal availability', () => {
  test('is disabled by configuration and never loads a pty module', async () => {
    const procs = [];
    const terminal = await createTerminal({
      config: baseConfig({ terminal: false }),
      log: createLog(),
      engineHost: createFakeEngine({}),
      publish: () => 0,
      ptyModule: createFakePtyModule(procs),
    });
    assert.equal(terminal.enabled, false);
    assert.equal(terminal.disabledReason, 'disabled');
    await terminal.closeAll();
    assert.equal(procs.length, 0);
  });

  test('is unavailable when the pty module cannot spawn', async () => {
    const terminal = await createTerminal({
      config: baseConfig(),
      log: createLog(),
      engineHost: createFakeEngine({}),
      publish: () => 0,
      ptyModule: {},
    });
    assert.equal(terminal.enabled, false);
    assert.equal(terminal.disabledReason, 'node-pty-unavailable');
    await terminal.closeAll();
  });

  test('is enabled with an injected pty module', async () => {
    const terminal = await createTerminal({
      config: baseConfig(),
      log: createLog(),
      engineHost: createFakeEngine({}),
      publish: () => 0,
      ptyModule: createFakePtyModule([]),
    });
    assert.equal(terminal.enabled, true);
    assert.equal(terminal.disabledReason, null);
    await terminal.closeAll();
  });

  test('reflects whether the real node-pty module loads when none is injected', async () => {
    const loads = await import('node-pty').then(() => true, () => false);
    const terminal = await createTerminal({
      config: baseConfig(),
      log: createLog(),
      engineHost: createFakeEngine({}),
      publish: () => 0,
    });
    assert.equal(terminal.enabled, loads);
    assert.equal(terminal.disabledReason, loads ? null : 'node-pty-unavailable');
    await terminal.closeAll();
  });

  test('refuses every upgrade by destroying the socket when disabled', async () => {
    await withHarness({ config: { terminal: false } }, async (h) => {
      const client = h.connect(`?cwd=${enc(fixture.project)}`);
      await waitUntil(() => client.closeEvent, 'refused socket');
      assert.equal(client.isOpen, false);
      assert.equal(client.closeEvent.code, 1006);
      assert.equal(h.procs.length, 0);
    });
  });
});

describe('upgrade query validation', () => {
  // Query strings are built inside each test: fixture paths only exist once the suite's before() hook has run.
  const cases = [
    ['neither sessionId nor cwd', () => ''],
    ['both sessionId and cwd', () => `?sessionId=${SESSION_A}&cwd=${enc(fixture.project)}`],
    ['sessionId repeated', () => `?sessionId=${SESSION_A}&sessionId=${SESSION_B}`],
    ['sessionId that is not a UUID', () => '?sessionId=../../etc/passwd'],
    ['empty sessionId', () => '?sessionId='],
    ['relative cwd', () => '?cwd=project'],
    ['empty cwd', () => '?cwd='],
    ['cwd containing a NUL byte', () => `?cwd=${enc(`${fixture.project}\0`)}`],
    ['cwd outside the roots', () => `?cwd=${enc(fixture.outside)}`],
    ['cwd sharing a name prefix with a root', () => `?cwd=${enc(fixture.sibling)}`],
    ['cwd that is a file', () => `?cwd=${enc(fixture.file)}`],
    ['cwd that does not exist', () => `?cwd=${enc(path.join(fixture.root, 'missing'))}`],
    ['cwd symlink that escapes the roots', () => `?cwd=${enc(fixture.escape)}`],
  ];

  for (const [label, buildQuery] of cases) {
    test(`rejects ${label} with BAD_REQUEST and close 1008`, async () => {
      await withHarness({}, async (h) => {
        const client = await connectOpen(h, buildQuery());
        await waitUntil(() => client.closeEvent, 'close');
        assert.deepEqual(client.frames.map((f) => f.type), ['error']);
        assert.equal(client.frames[0].code, 'BAD_REQUEST');
        assert.equal(typeof client.frames[0].message, 'string');
        assert.equal(client.closeEvent.code, 1008);
        assert.equal(h.procs.length, 0);
        assert.deepEqual(h.engine.calls.lock, []);
      });
    });
  }

  test('accepts the workspace root itself as a directory terminal', async () => {
    await withHarness({}, async (h) => {
      const client = await connectOpen(h, `?cwd=${enc(fixture.root)}`);
      await waitUntil(() => h.procs.length === 1, 'spawn');
      assert.equal(h.procs[0].options.cwd, fixture.root);
      assert.deepEqual(h.procs[0].args, []);
      assert.equal(client.closeEvent, null);
    });
  });

  test('spawns a directory terminal in the resolved real path', async () => {
    await withHarness({}, async (h) => {
      await connectOpen(h, `?cwd=${enc(fixture.innerLink)}`);
      await waitUntil(() => h.procs.length === 1, 'spawn');
      assert.equal(h.procs[0].options.cwd, fixture.project);
      assert.equal(h.procs[0].file, fixture.claudeBin);
      assert.deepEqual(h.procs[0].args, []);
      assert.deepEqual(h.events, [], 'directory terminals do not lock sessions');
    });
  });
});

describe('session terminals', () => {
  test('locks the session, resumes it in place and keeps the lock until the process exits', async () => {
    await withHarness({ pty: { exitOnKill: false } }, async (h) => {
      await connectOpen(h, `?sessionId=${SESSION_A}`);
      await waitUntil(() => h.procs.length === 1, 'spawn');
      const proc = h.procs[0];
      assert.deepEqual(h.engine.calls.lock, [SESSION_A]);
      assert.equal(proc.file, fixture.claudeBin);
      assert.deepEqual(proc.args, ['--resume', SESSION_A]);
      assert.equal(proc.options.cwd, fixture.project);
      assert.deepEqual(h.events.map((e) => e.data), [{ sessionId: SESSION_A, attached: true }]);
      assert.equal(h.events[0].type, 'terminal_state');
      assert.equal(h.events[0].sessionId, SESSION_A);

      h.clients[0].ws.terminate();
      await waitUntil(() => proc.signals.length === 1, 'SIGHUP');
      assert.deepEqual(proc.signals, ['SIGHUP']);
      await sleep(30);
      assert.deepEqual(h.engine.calls.release, [], 'the lock is held while the process is still running');
      assert.equal(h.events.length, 1);

      proc.exit(0);
      await waitUntil(() => h.engine.calls.release.length === 1, 'lock release');
      assert.deepEqual(h.engine.calls.release, [SESSION_A]);
      assert.equal(h.engine.locked.has(SESSION_A), false);
      assert.deepEqual(h.events.map((e) => e.data.attached), [true, false]);
    });
  });

  test('releases the lock exactly once when the client closes and the process then exits', async () => {
    await withHarness({ pty: { exitOnKill: true } }, async (h) => {
      await connectOpen(h, `?sessionId=${SESSION_B}`);
      await waitUntil(() => h.procs.length === 1, 'spawn');
      h.clients[0].ws.close(1000, 'bye');
      await waitUntil(() => h.engine.calls.release.length === 1, 'lock release');
      await sleep(30);
      await h.terminal.closeAll();
      assert.deepEqual(h.engine.calls.release, [SESSION_B]);
    });
  });

  test('reports SESSION_LOCKED when another terminal holds the session', async () => {
    await withHarness({}, async (h) => {
      h.engine.locked.add(SESSION_C);
      const client = await connectOpen(h, `?sessionId=${SESSION_C}`);
      await waitUntil(() => client.closeEvent, 'close');
      assert.deepEqual(client.frames.map((f) => f.code), ['SESSION_LOCKED']);
      assert.equal(client.closeEvent.code, 1008);
      assert.equal(h.procs.length, 0);
      assert.deepEqual(h.engine.calls.release, []);
      assert.deepEqual(h.events, []);
    });
  });

  test('reports SESSION_NOT_FOUND for an unknown session', async () => {
    await withHarness({}, async (h) => {
      const client = await connectOpen(h, `?sessionId=${UNKNOWN_SESSION}`);
      await waitUntil(() => client.closeEvent, 'close');
      assert.deepEqual(client.frames.map((f) => f.code), ['SESSION_NOT_FOUND']);
      assert.equal(client.closeEvent.code, 1008);
      assert.deepEqual(h.engine.calls.lock, []);
    });
  });

  test('refuses a session whose directory is outside the roots without taking the lock', async () => {
    await withHarness({}, async (h) => {
      h.engine.sessions.set(SESSION_OUTSIDE, fixture.outside);
      const client = await connectOpen(h, `?sessionId=${SESSION_OUTSIDE}`);
      await waitUntil(() => client.closeEvent, 'close');
      assert.deepEqual(client.frames.map((f) => f.code), ['PATH_NOT_ALLOWED']);
      assert.equal(client.closeEvent.code, 1008);
      assert.deepEqual(h.engine.calls.lock, []);
      assert.equal(h.procs.length, 0);
    });
  });

  test('reports ENGINE_UNAVAILABLE before taking the lock when no Claude Code binary exists', async () => {
    await withHarness({ config: { claudeBin: path.join(fixture.base, 'missing', 'claude') } }, async (h) => {
      const client = await connectOpen(h, `?sessionId=${SESSION_A}`);
      await waitUntil(() => client.closeEvent, 'close');
      assert.deepEqual(client.frames.map((f) => f.code), ['ENGINE_UNAVAILABLE']);
      assert.equal(client.closeEvent.code, 1011);
      assert.deepEqual(h.engine.calls.lock, []);
    });
  });

  test('releases the lock and reports ENGINE_UNAVAILABLE when the process cannot be spawned', async () => {
    await withHarness({ pty: { failSpawn: true } }, async (h) => {
      const client = await connectOpen(h, `?sessionId=${SESSION_D}`);
      await waitUntil(() => client.closeEvent, 'close');
      assert.deepEqual(client.frames.map((f) => f.code), ['ENGINE_UNAVAILABLE']);
      assert.equal(client.closeEvent.code, 1011);
      assert.deepEqual(h.engine.calls.lock, [SESSION_D]);
      assert.deepEqual(h.engine.calls.release, [SESSION_D]);
      assert.deepEqual(h.events, [], 'a terminal that never started is never reported as attached');
    });
  });

  test('does not spawn when the client leaves while the lock is still being acquired', async () => {
    await withHarness({}, async (h) => {
      h.engine.holdLocks = true;
      const client = await connectOpen(h, `?sessionId=${SESSION_E}`);
      await waitUntil(() => h.engine.calls.lock.length === 1, 'lock request');
      client.ws.terminate();
      await sleep(20);
      h.engine.releaseHeldLocks();
      await waitUntil(() => h.engine.calls.release.length === 1, 'lock release');
      assert.equal(h.procs.length, 0);
      assert.deepEqual(h.events, []);
    });
  });

  test('queues frames sent before the process starts and applies them afterwards', async () => {
    await withHarness({}, async (h) => {
      h.engine.holdLocks = true;
      const client = await connectOpen(h, `?sessionId=${SESSION_A}`);
      await waitUntil(() => h.engine.calls.lock.length === 1, 'lock request');
      send(client, { type: 'input', data: 'early ' });
      send(client, { type: 'resize', cols: 120, rows: 40 });
      await sleep(20);
      assert.equal(h.procs.length, 0);
      h.engine.releaseHeldLocks();
      await waitUntil(() => h.procs.length === 1, 'spawn');
      await waitUntil(() => h.procs[0].writes.length === 1 && h.procs[0].resizes.length === 1, 'queued frames');
      assert.deepEqual(h.procs[0].writes, ['early ']);
      assert.deepEqual(h.procs[0].resizes, [{ cols: 120, rows: 40 }]);
    });
  });
});

describe('Claude Code binary resolution', () => {
  test('prefers config.claudeBin over PATH and never falls back when it is not executable', async () => {
    const dir = await fsp.mkdtemp(path.join(fixture.base, 'bin-'));
    const onPath = await writeExecutable(dir, 'claude');
    const config = { claudeBin: path.join(dir, 'absent') };
    assert.equal(resolveClaudeBinary(config, { env: { PATH: dir }, platform: 'linux', arch: 'x64' }), null);
    assert.equal(
      resolveClaudeBinary({ claudeBin: onPath }, { env: { PATH: fixture.base }, platform: 'linux', arch: 'x64' }),
      onPath,
    );
    assert.equal(
      resolveClaudeBinary({ claudeBin: fixture.file }, { env: { PATH: dir }, platform: 'linux', arch: 'x64' }),
      null,
      'a configured file that is not executable is refused',
    );
  });

  test('uses the first executable claude on PATH and skips non-executable candidates', async () => {
    const first = await fsp.mkdtemp(path.join(fixture.base, 'first-'));
    const second = await fsp.mkdtemp(path.join(fixture.base, 'second-'));
    await fsp.writeFile(path.join(first, 'claude'), '', { mode: 0o644 });
    const expected = await writeExecutable(second, 'claude');
    const env = { PATH: [first, second].join(path.delimiter) };
    assert.equal(resolveClaudeBinary({ claudeBin: null }, { env, platform: 'linux', arch: 'x64' }), expected);
  });

  test('ignores relative PATH entries even when they point at an executable', async () => {
    const dir = await fsp.mkdtemp(path.join(fixture.base, 'relative-'));
    await writeExecutable(dir, 'claude');
    const relative = path.relative(process.cwd(), dir);
    assert.equal(path.isAbsolute(relative), false);
    const bundled = require.resolve('@anthropic-ai/claude-agent-sdk-linux-x64/claude');
    const resolved = resolveClaudeBinary({ claudeBin: null }, {
      env: { PATH: relative },
      platform: 'linux',
      arch: 'x64',
    });
    assert.equal(resolved, bundled);
  });

  test('falls back to the native binary shipped with the SDK', () => {
    const expected = require.resolve('@anthropic-ai/claude-agent-sdk-linux-x64/claude');
    assert.equal(
      resolveClaudeBinary({ claudeBin: null }, { env: { PATH: '' }, platform: 'linux', arch: 'x64' }),
      expected,
    );
  });

  test('returns null when no binary exists for the platform', () => {
    assert.equal(resolveClaudeBinary({ claudeBin: null }, { env: { PATH: '' }, platform: 'plan9', arch: 'x64' }), null);
  });

  test('looks for claude.exe on Windows', async () => {
    const dir = await fsp.mkdtemp(path.join(fixture.base, 'win-'));
    const exe = await writeExecutable(dir, 'claude.exe');
    assert.equal(resolveClaudeBinary({ claudeBin: null }, { env: { PATH: dir }, platform: 'win32', arch: 'x64' }), exe);
  });
});

describe('spawn environment and command line', () => {
  test('removes CAW_* variables, keeps the rest and declares the terminal capabilities', async () => {
    const saved = { ...process.env };
    process.env.CAW_TOKEN = 'token-value-for-test';
    process.env.caw_settings = 'lowercase-gateway-setting';
    process.env.CAW_TEST_KEEP_NOT = '1';
    process.env.ANTHROPIC_TEST_KEEP = 'kept';
    try {
      await withHarness({}, async (h) => {
        await connectOpen(h, `?cwd=${enc(fixture.project)}`);
        await waitUntil(() => h.procs.length === 1, 'spawn');
        const env = h.procs[0].options.env;
        const gatewayKeys = Object.keys(env).filter((key) => /^caw_/i.test(key));
        assert.deepEqual(gatewayKeys, []);
        assert.equal(env.TERM, 'xterm-256color');
        assert.equal(env.COLORTERM, 'truecolor');
        assert.equal(env.ANTHROPIC_TEST_KEEP, 'kept');
        assert.equal(h.procs[0].options.name, 'xterm-256color');
        assert.equal(h.procs[0].options.cols, 100);
        assert.equal(h.procs[0].options.rows, 30);
      });
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });
});

describe('frames from the client', () => {
  test('forwards input and applies valid resizes', async () => {
    await withHarness({}, async (h) => {
      const client = await connectOpen(h, `?cwd=${enc(fixture.project)}`);
      await waitUntil(() => h.procs.length === 1, 'spawn');
      send(client, { type: 'input', data: '/help\r' });
      send(client, { type: 'input', data: '\x1b[A' });
      send(client, { type: 'resize', cols: 20, rows: 5 });
      send(client, { type: 'resize', cols: 500, rows: 200 });
      await waitUntil(() => h.procs[0].resizes.length === 2, 'resizes');
      assert.deepEqual(h.procs[0].writes, ['/help\r', '\x1b[A']);
      assert.deepEqual(h.procs[0].resizes, [{ cols: 20, rows: 5 }, { cols: 500, rows: 200 }]);
      assert.deepEqual(client.frames, []);
    });
  });

  test('rejects malformed messages with BAD_REQUEST without closing the socket', async () => {
    await withHarness({}, async (h) => {
      const client = await connectOpen(h, `?cwd=${enc(fixture.project)}`);
      await waitUntil(() => h.procs.length === 1, 'spawn');
      const bad = [
        '{not json',
        '[1,2,3]',
        'null',
        '"input"',
        JSON.stringify({ type: 'paste', data: 'x' }),
        JSON.stringify({ data: 'x' }),
        JSON.stringify({ type: 'input' }),
        JSON.stringify({ type: 'input', data: 42 }),
        JSON.stringify({ type: 'input', data: ['x'] }),
        JSON.stringify({ type: 'input', data: 'x'.repeat(65537) }),
        JSON.stringify({ type: 'input', data: 'x'.repeat(70 * 1024) }),
        JSON.stringify({ type: 'resize', cols: 19, rows: 30 }),
        JSON.stringify({ type: 'resize', cols: 501, rows: 30 }),
        JSON.stringify({ type: 'resize', cols: 80, rows: 4 }),
        JSON.stringify({ type: 'resize', cols: 80, rows: 201 }),
        JSON.stringify({ type: 'resize', cols: 80.5, rows: 30 }),
        JSON.stringify({ type: 'resize', cols: '80', rows: 30 }),
        JSON.stringify({ type: 'resize', cols: 80 }),
      ];
      for (const text of bad) client.ws.send(text);
      await waitUntil(() => client.frames.length === bad.length, 'error frames');
      assert.ok(client.frames.every((f) => f.type === 'error' && f.code === 'BAD_REQUEST'));
      assert.deepEqual(h.procs[0].writes, []);
      assert.deepEqual(h.procs[0].resizes, []);
      assert.equal(client.closeEvent, null, 'the socket stays open');

      send(client, { type: 'input', data: 'still alive' });
      await waitUntil(() => h.procs[0].writes.length === 1, 'write after errors');
      assert.deepEqual(h.procs[0].writes, ['still alive']);
    });
  });

  test('accepts input of the maximum length that fits in a 64 KiB frame', async () => {
    await withHarness({}, async (h) => {
      const client = await connectOpen(h, `?cwd=${enc(fixture.project)}`);
      await waitUntil(() => h.procs.length === 1, 'spawn');
      const data = 'p'.repeat(65000);
      send(client, { type: 'input', data });
      await waitUntil(() => h.procs[0].writes.length === 1, 'write');
      assert.equal(h.procs[0].writes[0], data);
      assert.deepEqual(client.frames, []);
    });
  });

  test('rejects binary frames with an error frame and keeps the socket open', async () => {
    await withHarness({}, async (h) => {
      const client = await connectOpen(h, `?cwd=${enc(fixture.project)}`);
      await waitUntil(() => h.procs.length === 1, 'spawn');
      const validText = JSON.stringify({ type: 'input', data: 'binary-input' });
      client.ws.send(Buffer.from(validText, 'utf8'), { binary: true });
      await waitUntil(() => client.frames.length === 1, 'error frame');
      assert.equal(client.frames[0].type, 'error');
      assert.equal(client.frames[0].code, 'BAD_REQUEST');
      assert.equal(client.closeEvent, null);
      assert.deepEqual(h.procs[0].writes, []);
    });
  });
});

describe('output and exit', () => {
  test('batches chunks that arrive within one 16 ms window into one output frame', async () => {
    await withHarness({}, async (h) => {
      const client = await connectOpen(h, `?cwd=${enc(fixture.project)}`);
      await waitUntil(() => h.procs.length === 1, 'spawn');
      h.procs[0].emitData('a');
      h.procs[0].emitData('b');
      h.procs[0].emitData('c');
      await waitUntil(() => client.frames.length >= 1, 'output');
      await sleep(40);
      assert.deepEqual(client.frames, [{ type: 'output', data: 'abc' }]);
    });
  });

  test('splits large output into frames of at most 64K characters without breaking surrogate pairs', async () => {
    await withHarness({}, async (h) => {
      const client = await connectOpen(h, `?cwd=${enc(fixture.project)}`);
      await waitUntil(() => h.procs.length === 1, 'spawn');
      const text = `${'a'.repeat(65535)}\u{1F600}${'b'.repeat(200000)}`;
      h.procs[0].emitData(text);
      await waitUntil(() => client.frames.reduce((n, f) => n + f.data.length, 0) === text.length, 'all output');
      const frames = client.frames.map((f) => f.data);
      assert.ok(frames.every((data) => data.length <= 65536));
      assert.ok(frames.every((data) => !/[\uD800-\uDBFF]$/.test(data)), 'no frame ends inside a surrogate pair');
      assert.equal(frames.join(''), text);
    });
  });

  test('sends output produced before the exit ahead of the exit frame, then closes with 1000', async () => {
    await withHarness({}, async (h) => {
      const client = await connectOpen(h, `?cwd=${enc(fixture.project)}`);
      await waitUntil(() => h.procs.length === 1, 'spawn');
      h.procs[0].emitData('last words');
      h.procs[0].exit(3);
      await waitUntil(() => client.closeEvent, 'close');
      assert.deepEqual(client.frames, [
        { type: 'output', data: 'last words' },
        { type: 'exit', code: 3 },
      ]);
      assert.equal(client.closeEvent.code, 1000);
    });
  });

  test('pauses the pty while the client lags and resumes once the socket drains', async () => {
    await withHarness({}, async (h) => {
      const client = await connectOpen(h, `?cwd=${enc(fixture.project)}`);
      await waitUntil(() => h.procs.length === 1, 'spawn');
      const proc = h.procs[0];
      assert.equal(proc.pauseCalls, 0);
      client.ws.pause();
      const chunk = 'y'.repeat(1024 * 1024);
      for (let i = 0; i < 64 && !proc.paused; i += 1) {
        proc.emitData(chunk);
        await sleep(2);
      }
      await waitUntil(() => proc.paused, 'pause', 10000);
      assert.ok(proc.pauseCalls >= 1);
      client.ws.resume();
      await waitUntil(() => !proc.paused && proc.resumeCalls >= 1, 'resume', 10000);
      assert.equal(proc.paused, false);
    });
  });
});

describe('shutdown and limits', () => {
  test('closeAll kills every process, closes every socket with 1001 and releases every lock', async () => {
    await withHarness({}, async (h) => {
      const a = await connectOpen(h, `?sessionId=${SESSION_A}`);
      const b = await connectOpen(h, `?sessionId=${SESSION_B}`);
      const dir = await connectOpen(h, `?cwd=${enc(fixture.project)}`);
      await waitUntil(() => h.procs.length === 3, 'spawns');
      await h.terminal.closeAll();
      for (const client of [a, b, dir]) {
        await waitUntil(() => client.closeEvent, 'close');
        assert.equal(client.closeEvent.code, 1001);
      }
      assert.ok(h.procs.every((proc) => proc.signals.length === 1 && proc.signals[0] === 'SIGHUP'));
      assert.deepEqual([...h.engine.calls.release].sort(), [SESSION_A, SESSION_B].sort());
      assert.deepEqual(
        h.events.map((e) => [e.sessionId, e.data.attached]).sort(),
        [[SESSION_A, false], [SESSION_A, true], [SESSION_B, false], [SESSION_B, true]].sort(),
      );
    });
  });

  test('refuses upgrades after closeAll', async () => {
    await withHarness({}, async (h) => {
      await h.terminal.closeAll();
      const client = h.connect(`?cwd=${enc(fixture.project)}`);
      await waitUntil(() => client.closeEvent, 'refused socket');
      assert.equal(client.isOpen, false);
      assert.equal(h.procs.length, 0);
    });
  });

  test('escalates to SIGKILL when the process ignores SIGHUP', { timeout: 15000 }, async () => {
    await withHarness({ pty: { exitOnKill: false } }, async (h) => {
      await connectOpen(h, `?cwd=${enc(fixture.project)}`);
      await waitUntil(() => h.procs.length === 1, 'spawn');
      h.clients[0].ws.terminate();
      await waitUntil(() => h.procs[0].signals.length === 1, 'SIGHUP');
      await waitUntil(() => h.procs[0].signals.length === 2, 'SIGKILL', 8000);
      assert.deepEqual(h.procs[0].signals, ['SIGHUP', 'SIGKILL']);
      h.procs[0].exit(137);
    });
  });

  test('allows four terminals at once and refuses the fifth with TOO_MANY_TERMINALS and close 1013', async () => {
    await withHarness({}, async (h) => {
      const clients = [];
      for (let i = 0; i < 4; i += 1) clients.push(await connectOpen(h, `?cwd=${enc(fixture.project)}`));
      const refused = await connectOpen(h, `?cwd=${enc(fixture.project)}`);
      await waitUntil(() => refused.closeEvent, 'close');
      assert.deepEqual(refused.frames.map((f) => f.code), ['TOO_MANY_TERMINALS']);
      assert.equal(refused.closeEvent.code, 1013);
      assert.equal(h.procs.length, 4);

      clients[0].ws.terminate();
      await waitUntil(() => h.procs.filter((p) => p.exited).length === 1, 'one exit');
      const next = await connectOpen(h, `?cwd=${enc(fixture.project)}`);
      await waitUntil(() => h.procs.length === 5, 'fifth spawn');
      assert.equal(next.closeEvent, null);
    });
  });

  test('counts terminals that are still acquiring their session lock against the limit', async () => {
    await withHarness({}, async (h) => {
      h.engine.holdLocks = true;
      const ids = [SESSION_A, SESSION_B, SESSION_C, SESSION_D];
      for (const id of ids) await connectOpen(h, `?sessionId=${id}`);
      await waitUntil(() => h.engine.calls.lock.length === 4, 'lock requests');
      const refused = await connectOpen(h, `?sessionId=${SESSION_E}`);
      await waitUntil(() => refused.closeEvent, 'close');
      assert.deepEqual(refused.frames.map((f) => f.code), ['TOO_MANY_TERMINALS']);
      assert.equal(refused.closeEvent.code, 1013);
      assert.deepEqual([...h.engine.calls.lock].sort(), [...ids].sort());
      h.engine.releaseHeldLocks();
      await waitUntil(() => h.procs.length === 4, 'four spawns');
    });
  });

  test('pings the client and drops a peer that stops answering', { timeout: 15000 }, async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    await withHarness({}, async (h) => {
      const client = await connectOpen(h, `?cwd=${enc(fixture.project)}`, { autoPong: false });
      await waitUntil(() => h.procs.length === 1, 'spawn');
      t.mock.timers.tick(30000);
      await waitUntil(() => client.pings === 1, 'ping');
      t.mock.timers.tick(30000);
      await waitUntil(() => client.closeEvent, 'terminated peer', 5000);
      assert.equal(client.closeEvent.code, 1006);
      assert.equal(h.procs.length, 1);
    });
  });

  test('keeps a responsive peer connected across heartbeats', { timeout: 15000 }, async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    await withHarness({}, async (h) => {
      const client = await connectOpen(h, `?cwd=${enc(fixture.project)}`);
      await waitUntil(() => h.procs.length === 1, 'spawn');
      for (let round = 1; round <= 3; round += 1) {
        t.mock.timers.tick(30000);
        await waitUntil(() => client.pings === round, 'ping');
        await sleep(20);
      }
      assert.equal(client.closeEvent, null);
      assert.equal(h.procs[0].signals.length, 0);
    });
  });
});

describe('logging and publication', () => {
  test('logs metadata only, never terminal content', async () => {
    await withHarness({ pty: { exitOnKill: true } }, async (h) => {
      const client = await connectOpen(h, `?sessionId=${SESSION_A}`);
      await waitUntil(() => h.procs.length === 1, 'spawn');
      send(client, { type: 'input', data: 'SECRET-INPUT-TEXT' });
      await waitUntil(() => h.procs[0].writes.length === 1, 'write');
      h.procs[0].emitData('SECRET-OUTPUT-TEXT');
      client.ws.close(1000, 'done');
      await waitUntil(() => h.engine.calls.release.length === 1, 'release');
      const logged = JSON.stringify(h.log.entries);
      assert.ok(logged.includes(SESSION_A), 'session id is logged');
      assert.ok(h.log.entries.some((entry) => entry.msg === 'terminal started'));
      assert.ok(h.log.entries.some((entry) => entry.msg === 'terminal exited' && entry.fields.exitCode === 0));
      assert.equal(logged.includes('SECRET-INPUT-TEXT'), false);
      assert.equal(logged.includes('SECRET-OUTPUT-TEXT'), false);
      assert.equal(logged.includes(fixture.project), false, 'directory paths are not logged');
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------------

/**
 * @param {Partial<Record<string, unknown>>} [overrides]
 */
function baseConfig(overrides = {}) {
  return {
    terminal: true,
    roots: [fixture.root],
    claudeBin: fixture.claudeBin,
    ...overrides,
  };
}

/**
 * @param {string} dir
 * @param {string} name
 * @returns {Promise<string>}
 */
async function writeExecutable(dir, name) {
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await fsp.writeFile(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await fsp.chmod(file, 0o755);
  return file;
}

/** @param {string} value */
function enc(value) {
  return encodeURIComponent(value);
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @template T
 * @param {() => T | false | null | undefined} check
 * @param {string} label
 * @param {number} [timeoutMs]
 * @returns {Promise<T>}
 */
async function waitUntil(check, label, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(5);
  }
}

/** Fake of the node-pty IPty surface used by the gateway. Records every call; exit is driven by the test. */
class FakePty {
  /**
   * @param {string} file
   * @param {string[]} args
   * @param {Record<string, unknown>} options
   * @param {{exitOnKill: boolean, pid: number}} behaviour
   */
  constructor(file, args, options, behaviour) {
    this.file = file;
    this.args = args;
    this.options = options;
    this.pid = behaviour.pid;
    this.exitOnKill = behaviour.exitOnKill;
    this.exited = false;
    this.paused = false;
    this.pauseCalls = 0;
    this.resumeCalls = 0;
    this.writes = [];
    this.resizes = [];
    this.signals = [];
    this.dataListeners = new Set();
    this.exitListeners = new Set();
  }

  onData(listener) {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener) {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  write(data) {
    this.writes.push(data);
  }

  resize(cols, rows) {
    this.resizes.push({ cols, rows });
  }

  kill(signal = 'SIGHUP') {
    this.signals.push(signal);
    if (this.exitOnKill) setImmediate(() => this.exit(signal === 'SIGKILL' ? 137 : 0));
  }

  pause() {
    this.paused = true;
    this.pauseCalls += 1;
  }

  resume() {
    this.paused = false;
    this.resumeCalls += 1;
  }

  emitData(data) {
    for (const listener of [...this.dataListeners]) listener(data);
  }

  exit(exitCode = 0) {
    if (this.exited) return;
    this.exited = true;
    for (const listener of [...this.exitListeners]) listener({ exitCode, signal: undefined });
  }
}

/**
 * @param {FakePty[]} procs every spawned process is appended here
 * @param {{exitOnKill?: boolean, failSpawn?: boolean}} [behaviour]
 */
function createFakePtyModule(procs, behaviour = {}) {
  const exitOnKill = behaviour.exitOnKill ?? true;
  let nextPid = 40000;
  return {
    spawn(file, args, options) {
      if (behaviour.failSpawn) throw new Error('spawn failed');
      const proc = new FakePty(file, args, options, { exitOnKill, pid: (nextPid += 1) });
      procs.push(proc);
      return proc;
    },
  };
}

/**
 * Fake EngineHost surface: sessions map to directories, locks are recorded, and a held lock can be released later.
 * @param {Record<string, string>} initialSessions session id to cwd
 */
function createFakeEngine(initialSessions) {
  const engine = {
    sessions: new Map(Object.entries(initialSessions)),
    locked: new Set(),
    holdLocks: false,
    calls: { lock: /** @type {string[]} */ ([]), release: /** @type {string[]} */ ([]) },
    /** @type {Array<() => void>} */
    pending: [],
    async sessionCwd(sessionId) {
      const cwd = engine.sessions.get(sessionId);
      if (cwd === undefined) throw new AppError(404, 'SESSION_NOT_FOUND', 'Session not found');
      return cwd;
    },
    async lockForTerminal(sessionId) {
      engine.calls.lock.push(sessionId);
      if (engine.holdLocks) await new Promise((resolve) => engine.pending.push(resolve));
      if (!engine.sessions.has(sessionId)) throw new AppError(404, 'SESSION_NOT_FOUND', 'Session not found');
      if (engine.locked.has(sessionId)) throw new AppError(409, 'SESSION_LOCKED', 'Session is held by a terminal');
      engine.locked.add(sessionId);
      return () => {
        engine.calls.release.push(sessionId);
        engine.locked.delete(sessionId);
      };
    },
    releaseHeldLocks() {
      for (const resolve of engine.pending.splice(0)) resolve();
    },
  };
  return engine;
}

function createLog() {
  /** @type {Array<{level: string, msg: string, fields: Record<string, unknown>}>} */
  const entries = [];
  const record = (level) => (msg, fields = {}) => {
    entries.push({ level, msg, fields });
  };
  return { entries, debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') };
}

/**
 * Real HTTP server whose upgrade handler mirrors app.mjs: it only forwards the terminal route.
 * @param {import('../../src/contracts.mjs').TerminalApi} terminal
 */
async function startServer(terminal) {
  const server = http.createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (pathname !== '/api/terminal') {
      socket.destroy();
      return;
    }
    terminal.handleUpgrade(req, socket, head);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    url: (query) => `ws://127.0.0.1:${port}/api/terminal${query}`,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

/**
 * A real `ws` client that records every frame and the close event.
 * @param {string} url
 * @param {{autoPong?: boolean}} [options]
 */
function openClient(url, { autoPong = true } = {}) {
  const ws = new WebSocket(url, { autoPong, handshakeTimeout: 5000 });
  const client = {
    ws,
    /** @type {any[]} */
    frames: [],
    isOpen: false,
    /** @type {{code: number, reason: string}|null} */
    closeEvent: null,
    pings: 0,
  };
  ws.on('open', () => {
    client.isOpen = true;
  });
  ws.on('message', (data, isBinary) => {
    client.frames.push(isBinary ? { binary: true } : JSON.parse(data.toString('utf8')));
  });
  ws.on('ping', () => {
    client.pings += 1;
  });
  ws.on('error', () => {});
  ws.on('close', (code, reason) => {
    client.closeEvent = { code, reason: reason.toString('utf8') };
  });
  return client;
}

/**
 * Runs `fn` with a fresh terminal service, HTTP server and fakes, and tears everything down afterwards.
 * @param {{config?: Record<string, unknown>, pty?: {exitOnKill?: boolean, failSpawn?: boolean}}} options
 * @param {(h: Harness) => Promise<void>} fn
 */
async function withHarness(options, fn) {
  const procs = [];
  const log = createLog();
  const engine = createFakeEngine({
    [SESSION_A]: fixture.project,
    [SESSION_B]: fixture.project,
    [SESSION_C]: fixture.project,
    [SESSION_D]: fixture.project,
    [SESSION_E]: fixture.project,
  });
  const events = [];
  const config = baseConfig(options.config ?? {});
  const terminal = await createTerminal({
    config,
    log,
    engineHost: engine,
    publish: (event) => {
      events.push(event);
      return events.length;
    },
    ptyModule: createFakePtyModule(procs, options.pty ?? {}),
  });
  const server = await startServer(terminal);
  /** @type {Array<ReturnType<typeof openClient>>} */
  const clients = [];
  const harness = {
    terminal,
    procs,
    log,
    events,
    engine,
    clients,
    /**
     * @param {string} query
     * @param {{autoPong?: boolean}} [clientOptions]
     */
    connect(query, clientOptions) {
      const client = openClient(server.url(query), clientOptions);
      clients.push(client);
      return client;
    },
  };
  try {
    await fn(harness);
  } finally {
    for (const client of clients) client.ws.terminate();
    engine.holdLocks = false;
    engine.releaseHeldLocks();
    await sleep(5);
    for (const proc of procs) proc.exit(0);
    await terminal.closeAll();
    await server.close();
  }
}

/**
 * Connects and waits until the upgrade completed or was refused.
 * @param {{connect: (query: string, options?: {autoPong?: boolean}) => ReturnType<typeof openClient>}} h
 * @param {string} query
 * @param {{autoPong?: boolean}} [options]
 */
async function connectOpen(h, query, options) {
  const client = h.connect(query, options);
  await waitUntil(() => client.isOpen || client.closeEvent, 'socket open or refused');
  return client;
}

/**
 * @param {{ws: WebSocket}} client
 * @param {Record<string, unknown>} message
 */
function send(client, message) {
  client.ws.send(JSON.stringify(message));
}
