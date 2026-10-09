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

## Ownership during parallel work

Each worker edits only the files assigned to it. If a change is needed elsewhere, describe it precisely in the final
report instead of editing. Contracts (`docs/PROTOCOL.md`, `docs/FRONTEND.md`, `docs/DESIGN.md`, `src/contracts.mjs`)
change only through the integrator.
