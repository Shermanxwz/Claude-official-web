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
  Trusting a folder also records it in Claude Code through the runtime's own `set_cwd` trust handshake, because the
  runtime ignores project allow rules (and other trust-gated features) of folders it has no trust record for.
- The permission mode is not forced: unless the user picks one, queries start without `permissionMode` and Claude Code
  applies `permissions.defaultMode` from its settings, as `claude` does.
- Thinking is shown as the terminal shows it: queries start with the runtime's `--thinking-display summarized` flag
  (`extraArgs`), because a non-interactive session ignores `showThinkingSummaries`; a setting that turns summaries
  off (`showThinkingSummaries: false`) is honored.
- Readiness follows the SDK handshake, not the first prompt. A new or resumed session becomes `idle` once Claude Code
  answers its initialize handshake (`initializationResult()`, which makes no model call). Claude Code sends
  `system/init` only with the first prompt of a streaming session, so the model, the permission mode and the Claude Code
  version are the gateway's own choice, or unknown, until then (`docs/PROTOCOL.md`, "Session states and the ready
  state").
- Stop behaves like Esc: queries declare `perTaskStopAffordance`, so an interrupt ends the turn and background tasks
  keep running until they are stopped from the Tasks panel. Ctrl+B is `backgroundTasks()`.

## Official interfaces

Every Claude Code behavior goes through `@anthropic-ai/claude-agent-sdk`, in this order of preference:

1. Public, typed exports: `query()` and its options, control methods and callbacks (`canUseTool`, `onElicitation`,
   `onUserDialog`), the session functions (`listSessions`, `getSessionMessages`, `renameSession`, `forkSession`, …),
   `resolveSettings()` and `setMcpServers()`. Settings change only through the runtime (`applyFlagSettings`,
   `updateSettings`, permission updates returned from `canUseTool`), never by editing files. The query methods used
   besides those named above are `initializationResult()` (readiness and the capabilities), `accountInfo()`,
   `readFile()` (memory files, with the read permission rules), `setMcpPermissionModeOverride()`,
   `reconnectMcpServer()`, `toggleMcpServer()`, `setMcpServers()` (the operator's browser server), `reloadPlugins()`,
   `reloadSkills()`, `reloadOutputStyles()`, `rewindFiles()`, `stopTask()`, `backgroundTasks()` and `getContextUsage()`.
   The usage view calls `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`: it is typed, and the view is
   offered only while the method exists. The options `agent`, `additionalDirectories` and `fallbackModel` map to
   `--agent`, `--add-dir` and `--fallback-model`.
2. Runtime controls the SDK's query object carries without public typings — the calls behind the terminal's own
   screens: `getStatus` (`/status`), `listPermissionRules` (`/permissions`), `getHooksListing` (`/hooks`),
   `getMemoryDialog` (`/memory`), `getSettings` (`/config`), `getSkillsDialog`, `getSandboxDialog`, `getPlan`,
   `getChromeDialog` (`/chrome`), `exportConversation` (`/export`), `getTaskOutput`, `cancelAsyncMessage`,
   `askSideQuestion` (`/btw`), `setCwd` (the trust handshake), `claudeAuthenticate` / `claudeOAuthCallback`
   (`/login`) and `mcpAuthenticate` / `mcpSubmitOAuthCallbackUrl` / `mcpClearAuth` (`/mcp` sign-in), plus the declared
   `file_suggestions` control request through the query's generic control call. They are used only when present
   (feature detection; a missing one answers `501 FEATURE_UNAVAILABLE`, and the UI points to the terminal tab when it
   is enabled for a `full` profile, else offers Retry); their
   answers are passed on as data and never trusted as HTML. The SDK version is pinned exactly, and the integration
   tests and the real-runtime smoke cover them.
3. The CLI's own flags through the public `extraArgs` option: `--thinking-display summarized` and, opt-in, `--chrome`.

Typed slash commands are passed to the runtime unchanged, so its own handlers run.

The gateway implements only what has no runtime interface:

| Part | Why it is the gateway's |
|---|---|
| Login, cookies, Origin/Host checks, SSE, uploads, workspace roots | Hosting a web UI, not a Claude Code feature |
| `@` file search fallback | Used when the runtime's own index cannot answer (no live session, still indexing) |
| Folder trust record for `settingSources` | Claude Code's trust is recorded through its `set_cwd` handshake; the gateway keeps its own record to decide which settings a query loads |
| Writing a memory file the runtime listed | The terminal's `/memory` opens an editor; the runtime has no write control |
| Conversation search | `listSessions` and `getSessionMessages` are read through the SDK; matching is the gateway's |

Interfaces that are deliberately not used:

| Interface | Reason |
|---|---|
| `readMcpResource` (MCP Apps widgets) | Claude Code 2.1.295 does not advertise `mcp_read_resource_v1` to SDK hosts, so there is nothing to render yet |
| `prewarm`, `startup` | Alpha process pre-warming; sessions start on demand |
| `resumeDropsTurn` | Guards single-turn truncation in headless edit-and-retry; rewind here spans any number of turns |
| `enableRemoteControl`, `/bridge` | Remote Control through Anthropic's hosted service needs a claude.ai sign-in and cannot be verified on a self-hosted test runtime |
| `createSdkMcpServer`, `tool()` | Custom tools belong in Claude Code's own MCP configuration, which the GUI loads |
| `generateSessionTitle`, `submitFeedback`, `messageRated`, `launchUltrareview` | The runtime titles sessions itself; feedback and cloud review are product features of Anthropic's apps |
| `getChromeBrowsers`, `selectChromeBrowser` | Choosing among several connected Chromes cannot be verified here; `/chrome` in the terminal tab does it |
| `filterEscalatingDefaultMode` | The gateway does not compute a default mode; the runtime applies its own settings and trust rules |

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
  history files directly; all such changes go through SDK calls. The one file write of its own is the saving of a
  `CLAUDE.md` or `CLAUDE.local.md` that the runtime lists as editable (see SECURITY.md).
- Model output is untrusted: Markdown is sanitized with DOMPurify, tool output is rendered as text, and no
  model-provided HTML is executed.
- The terminal is equivalent to shell access and is disabled unless `CAW_TERMINAL=1` and the profile is `full`.
- `bypassPermissions` mode needs `CAW_ALLOW_BYPASS=1`, which the gateway accepts only with the `full` profile (see
  SECURITY.md).

See `docs/PROTOCOL.md` for the wire contract, `docs/FRONTEND.md` for the browser module contracts and
`docs/ENGINEERING.md` for code standards.
