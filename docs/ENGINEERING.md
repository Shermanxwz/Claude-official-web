# Engineering standards

These rules are binding for every change. `npm run seal` enforces the mechanical ones.

## Runtime and dependencies

- Node.js ≥ 22.12, ES modules only. Backend files are `.mjs`; browser files are `.js` ES modules.
- Runtime dependencies are fixed: `@anthropic-ai/claude-agent-sdk` (+ its peers `@anthropic-ai/sdk`,
  `@modelcontextprotocol/sdk`, `zod`), `ws`, `@xterm/xterm`, `@xterm/addon-fit`, `marked`, `dompurify`, optional
  `node-pty`. Dev: `typescript` (type checking only), `@types/node`, `@types/ws`, `playwright-core`.
  Adding a dependency requires an architecture decision; do not add one in a feature change.
- Versions are pinned exactly; `package-lock.json` is committed.

## Code

- Every backend file starts with `// @ts-check` and passes `npm run typecheck` (`tsc -p jsconfig.json`). Exported
  functions and classes carry JSDoc types. SDK types are imported with
  `/** @typedef {import('@anthropic-ai/claude-agent-sdk').SDKMessage} SDKMessage */`.
- Shared types, constants and `AppError` live in `src/contracts.mjs`. Throw `new AppError(status, code, message)` for
  every expected failure; the HTTP layer turns it into the documented error body. Anything else becomes
  `500 INTERNAL` and is logged without user content.
- No `console.*` in `src/` (use `src/log.mjs`); scripts may print. No `eval`, `new Function`, `child_process` with
  `shell: true`, or string-built shell commands.
- Never log or persist tokens, cookies, prompt text, model output or file contents.
- Validate every external input (HTTP params, bodies, headers, WebSocket frames, environment). Paths: resolve with
  `fs.realpath` and require containment in an allowed root (`root + path.sep` prefix or equality).
- Style: 2-space indent, single quotes, semicolons, ≤ 120 columns, `const` by default, early returns, small functions.
  No dead code, commented-out code, `TODO`, `FIXME` or `XXX`.
- Browser code: build DOM with `h()` / `textContent`; never assign untrusted strings to `innerHTML`; Markdown only via
  `renderMarkdown()`. All user-visible strings go through `t()`.

## Tests

- `node:test` + `node:assert/strict`. Unit tests in `test/unit/`, integration tests (real HTTP server + mock engine)
  in `test/integration/`, browser tests (playwright-core + Chromium) in `test/e2e/`.
- Tests are hermetic: no network, temporary directories from `fs.mkdtemp(os.tmpdir())` cleaned up in `after`, random
  free ports (`listen(0)`), no dependence on the real `~/.claude`.
- Every module ships with tests covering success paths, validation failures and edge cases. A bug fix comes with a
  regression test.
- `npm test` must pass with zero failures and no unhandled rejections; `npm run check` and `npm run typecheck` must be
  clean.

## Runtime contract and upgrades

The gateway relies on names that the Claude Agent SDK and the Claude Code executable it bundles define. They are
listed in `src/engine/runtime-surface.mjs`, one entry per name, with its kind (method, option, export, environment
name, flag, stream message or dialog key), the source that declares or implements it (`sdk.d.ts`, `sdk.mjs` or the
binary) and the gateway file that uses it. `npm run contract` (`scripts/runtime-contract.mjs`) checks every entry
against the installed SDK and the executable for this platform. The executable is searched as bytes and never run.
The check also requires the installed SDK to be the version `package.json` pins, and the executable's sha256 to be the
one the SDK manifest records. It prints one row per kind and exits 0 only when every entry and version passes (1 when
one does not, 2 when the executable is not installed). `npm run seal` runs it too.

- A change that calls a new runtime name adds it to the list. `test/unit/runtime-surface.test.mjs` fails when a method
  the gateway calls by name through `runtimeMethod()` or `methodOf()`, or a method of `RUNTIME_VIEWS`, is not listed,
  and when an undeclared method stays listed after the gateway stops calling it. The unit tests run the checks and the
  upgrade plan on fake input and the installed SDK's package.json, so they need no network and run no npm.
- An upgrade is one command. `npm run upgrade:runtime -- --dry-run` prints the current and target SDK and Claude Code
  versions and the steps, and changes nothing. `npm run upgrade:runtime` moves to the latest SDK on the npm registry;
  `npm run upgrade:runtime -- 0.3.296` moves to an exact version. The command runs `npm install --save-exact`,
  `npm run manifest`, `npm run contract` and `npm run seal` in that order, stops at the first failure and prints the
  rollback: `git checkout -- package.json package-lock.json SOURCE_MANIFEST.sha256 && npm ci`. It never runs git itself.
- After a successful upgrade, review the diff, run `npm test` and `npm run check`, commit `package.json`,
  `package-lock.json` and `SOURCE_MANIFEST.sha256`, and restart the service with
  `systemctl --user restart claude-official-web`. `npm run smoke:runtime` runs a real turn against a signed-in gateway;
  run it when the change touches the engine.
- A `MISSING` line from `npm run contract` means the name is no longer in its source. Fix the gateway code that uses
  it, or remove the entry when the gateway no longer uses it. A `VERSION` line means the installed SDK, its manifest or
  the executable is not the one `package.json` pins: run `npm ci`, then `npm run contract` again.

## Ownership during parallel work

Each worker edits only the files assigned to it. If a change is needed elsewhere, describe it precisely in the final
report instead of editing. Contracts (`docs/PROTOCOL.md`, `docs/FRONTEND.md`, `docs/DESIGN.md`, `src/contracts.mjs`)
change only through the integrator.
