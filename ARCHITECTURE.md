# Architecture

claude-official-web is a self-hosted, graphical Web host for the **official Claude Agent SDK**, which runs the
**official Claude Code runtime**. The browser never replaces the runtime: every turn, tool call, permission decision,
skill, hook, plugin, MCP server and session file is owned by Claude Code itself. The gateway only transports,
authenticates and renders.

```text
Browser (graphical UI + optional terminal tab)
  │  same-origin HTTPS: JSON REST + Server-Sent Events (+ WebSocket for the optional terminal)
  ▼
Node gateway (src/app.mjs)
  ├─ auth: token login → HMAC-signed HttpOnly cookie, login rate limit, exact-Origin check on every write
  ├─ access profile gate: read | standard | full
  ├─ EventHub: global sequence, bounded per-client queues, heartbeat, replay-after-seq, resync
  ├─ workspaces: allowed roots, realpath containment, directory browser, @-mention file search
  ├─ attachments: <cwd>/.caw-uploads/<batch>/, size limits, 7-day cleanup
  └─ terminal (optional, full profile only): node-pty running `claude --resume <id>` over WebSocket
  │
  ▼
EngineHost (src/engine/host.mjs)
  ├─ one live SDK `query()` per open session, streaming-input mode
  ├─ canUseTool / onElicitation → PendingRequest registry → browser cards → decision
  ├─ controls: interrupt, setModel, setPermissionMode, applyFlagSettings(effort), rewindFiles,
  │            getContextUsage, supportedCommands/Models/Agents, MCP status/toggle/reconnect, reload
  ├─ session files: listSessions, getSessionMessages, rename, tag, fork, delete, subagents
  └─ idle shutdown, LRU limit on live processes, single writer (GUI xor terminal)
  │
  ▼
Engine adapter: src/engine/sdk-adapter.mjs (real)  |  src/engine/mock/ (deterministic demo + tests)
  │
  ▼
@anthropic-ai/claude-agent-sdk → official Claude Code binary → ~/.claude + project .claude
```

## Fidelity contract

- The SDK is started with Claude Code's own system prompt and tool preset
  (`systemPrompt: {type:'preset', preset:'claude_code'}`, `tools: {type:'preset', preset:'claude_code'}`) and all
  filesystem setting sources (`user`, `project`, `local`). CLAUDE.md, settings, permission rules, hooks, skills,
  commands, plugins, MCP servers and subagents therefore load exactly as they do in the terminal.
- Sessions are the same `~/.claude/projects/<dir>/<id>.jsonl` files the CLI uses. A GUI session can be continued in a
  terminal with `claude --resume <id>`; a terminal session can be opened in the GUI.
- Everything the SDK can express has a graphical surface (see `docs/FEATURES.md`). Terminal-only commands
  (`/theme`, `/terminal-setup`, `!` shell mode, TUI pickers) are reachable through the optional terminal tab, which
  attaches to the same session while the GUI pauses writing (single writer).
- Unknown SDK message types are kept as diagnostic entries, never dropped; Settings → "Show runtime events" renders
  them as generic cards, so new runtime features remain inspectable before the UI learns them.
- Folder trust mirrors Claude Code's trust dialog: only trusted folders load project settings, hooks, skills, MCP
  servers and CLAUDE.md (`settingSources` includes `project` and `local`); untrusted folders run with user settings.
- Thinking is shown as the terminal shows it: queries start with the runtime's `--thinking-display summarized` flag
  (`extraArgs`), because a non-interactive session ignores `showThinkingSummaries`; a setting that turns summaries
  off (`showThinkingSummaries: false`) is honored.
- Stop behaves like Esc: queries declare `perTaskStopAffordance`, so an interrupt ends the turn and background tasks keep
  running until they are stopped from the Tasks panel. Ctrl+B is `backgroundTasks()`.

## Official interfaces

Every Claude Code behavior goes through a public export of `@anthropic-ai/claude-agent-sdk`: `query()` and its
control methods, its callbacks (`canUseTool`, `onElicitation`), the session functions (`listSessions`,
`getSessionMessages`, `renameSession`, `forkSession`, …) and `resolveSettings()`. Settings are changed only through the
runtime (`applyFlagSettings`, `updateSettings`, permission updates returned from `canUseTool`), never by editing files.
Typed slash commands are passed to the runtime unchanged, so its own handlers run.

The gateway implements only what has no public interface:

| Part | Why it is the gateway's |
|---|---|
| Login, cookies, Origin/Host checks, SSE, uploads, workspace roots | Hosting a web UI, not a Claude Code feature |
| `@` file autocomplete (`GET /api/fs/search`) | The runtime answers a `file_suggestions` control request, but the SDK exposes no method for it |
| Folder trust store | The SDK has no API for Claude Code's trust records; trust is applied through `settingSources` |

Public SDK interfaces that are deliberately not used:

| Interface | Reason |
|---|---|
| `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` | Marked unstable by the SDK; the runtime's `/usage` command works when typed |
| `readMcpResource` (MCP Apps widgets) | Alpha, and it renders third-party HTML |
| `onUserDialog` / `supportedDialogKinds` | Payload shapes are not documented; without them the runtime uses its plain refusal flow, which the UI renders |
| `prewarm`, `startup` | Alpha process pre-warming; sessions start on demand |
| `setMcpPermissionModeOverride` | Only tightens MCP servers under `bypassPermissions`/`auto`; not exposed yet |
| `resumeDropsTurn` | Guards single-turn truncation in headless edit-and-retry; rewind here spans any number of turns |
| `/bridge`, `/browser` subpath exports | They connect to Anthropic's hosted sessions (Remote Control), not to a self-hosted runtime |

## Process model

One Node process serves HTTP and owns the EngineHost. Each live session is one Claude Code child process spawned by the
SDK; idle sessions are closed after `CAW_IDLE_TIMEOUT_MS` and resumed on demand, and at most `CAW_MAX_LIVE_SESSIONS`
are live at once. Restarting the gateway ends in-flight turns, but conversations persist on disk and resume on the next
message.

## Trust boundaries

- The Web token authenticates only this gateway. It and every `CAW_*` variable are removed from the Claude Code child
  environment. With `CAW_TOKEN_SHA256` only a digest is stored and sessions are signed with an in-memory secret, so
  an agent that can read the service's files still cannot mint a session and approve its own requests.
- Requests must carry an allowed `Host` (loopback or the public origin's host) and, for writes and the terminal
  upgrade, the exact `Origin`; this blocks CSRF, cross-site WebSocket hijacking and DNS rebinding.
- The gateway never reads Claude credentials (`~/.claude/.credentials.json`, keychains) and never edits settings or
  history files directly; all such changes go through SDK calls.
- Model output is untrusted: Markdown is sanitized with DOMPurify, tool output is rendered as text, and no
  model-provided HTML is executed.
- The terminal is equivalent to shell access and is disabled unless `CAW_TERMINAL=1` and the profile is `full`.
- `bypassPermissions` mode is disabled unless `CAW_ALLOW_BYPASS=1` and the profile is `full`.

See `docs/PROTOCOL.md` for the wire contract, `docs/FRONTEND.md` for the browser module contracts and
`docs/ENGINEERING.md` for code standards.
