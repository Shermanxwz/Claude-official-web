# Changelog

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses semantic versioning.

## [1.1.0] - 2026-10-09

An audit of every public interface of the Claude Agent SDK 0.3.295 against the gateway. Capabilities the SDK offers
are now wired through it; what the gateway implements itself, and the SDK interfaces it deliberately leaves out, are
listed under "Official interfaces" in `ARCHITECTURE.md`.

### Added

- Ctrl+B equivalent: a "Run in background" button on a running Bash or Agent card (`backgroundTasks()`,
  `POST /api/sessions/:id/background`), a header badge with the number of background tasks, and
  `features.backgroundTasks` in `GET /api/meta` (false when `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` is set).
- Fast mode (`/fast`): a toggle for models that support it, applied through the session's flag settings layer
  (`applyFlagSettings({fastMode})`), with the state and the reason Claude Code reports. `fastMode`,
  `fastModeState`, `fastModeDisabledReason` and `backgroundTasks` in `LiveInfo`.
- Output style picker for trusted folders through the runtime's own settings writer
  (`updateSettings('localSettings', {outputStyle})`, `POST /api/sessions/:id/output-style`), and a reload for output
  styles.
- Plugin reloads run the check `/reload-plugins` makes: when applying would change the tools the prompt cache depends
  on, the UI shows what would change and asks before `force: true`.
- Notices for a model refusal with fallback (the declined response is marked as withdrawn) and without fallback (with
  "Edit and retry"), plugin installation steps and completed MCP browser steps.
- `/fast` in the command palette.

### Changed

- Thinking now shows its summary: queries start with the runtime's `--thinking-display summarized` flag, because a
  non-interactive session ignores the `showThinkingSummaries` setting; `showThinkingSummaries: false` in any loaded
  settings file is honored (read with `resolveSettings()`). A thinking block without text shows a muted label.
- Stop behaves like Esc in the terminal: queries declare `perTaskStopAffordance`, so background tasks keep running
  after an interrupt and are stopped from the Tasks panel.
- The idle sweep and the live-session limit never close a session that has background tasks running.
- The mock engine reports Claude Code's own output style names and only reads the environment given to the server.

## [1.0.0] - 2026-10-09

First release of claude-official-web, a self-hosted graphical Web host for the official Claude Agent SDK
(`@anthropic-ai/claude-agent-sdk` 0.3.295), which runs the official Claude Code runtime (2.1.295).

### Added

- Graphical conversation view for every Claude Code session: streaming replies, thinking, tool cards for each tool
  family, subagent nesting, background tasks and a work-process summary per turn.
- Interactive requests as cards: permission decisions (allow once, allow always, deny with a reason), AskUserQuestion,
  plan approval and MCP elicitation.
- Session management: start, resume, rename, tag, fork, rewind code and conversation, delete, and paged history.
  Sessions are the same files the terminal uses, so `claude --resume <id>` continues any of them.
- Model, permission mode and effort switching on live sessions; slash commands from the SDK, skills, custom commands
  and MCP prompts; `@` file mentions; image and file attachments; interrupts and queued messages.
- Context usage, usage-limit banner, prompt suggestions, desktop notifications, hook visibility, MCP server status
  with toggle and reconnect, and plugin and skill reload.
- Workspace roots with a directory browser and realpath containment; session list grouped by project.
- Optional terminal tab, disabled by default, that attaches to a session through `claude --resume` (`CAW_TERMINAL=1`,
  `full` profile only).
- Mock engine (`CAW_ENGINE=mock`) for demonstrations and tests, with `npm run demo` requiring no account.
- Production tooling: `npm run seal` (manifest, static checks, type check, unit, integration and browser tests, and a
  receipt bound to the source manifest), `npm run smoke:runtime` for real turns on the deployment host,
  `npm run smoke:gateway` for a deployed gateway, a Linux installer that creates a hardened systemd user service, and a
  CI workflow.
- English and Simplified Chinese documentation.
- Folder trust, as in Claude Code's own trust dialog: an untrusted folder runs with user settings only. Trusting a folder
  from the new-session notice or from a session banner loads its project settings, hooks, skills, CLAUDE.md and MCP
  servers. Endpoints `GET /api/fs/trust` and `POST /api/fs/trust`.
- Installer that stores the login token as a SHA-256 hash by default (`CAW_TOKEN_SHA256`) and prints the token once.
  `--plain-token` keeps the plaintext `CAW_TOKEN` form, and `--rotate-token` issues a new token. The existing configuration
  is checked before any dependency is installed.
- A 22-test browser suite that is part of `npm run seal`, and `npm run screenshots` to render the README screenshots.

### Security

- Token login with an HMAC-signed, HttpOnly, SameSite=Strict session cookie (Secure over HTTPS); login rate limiting.
- Exact Origin check on every write and on the terminal WebSocket upgrade; `CAW_PUBLIC_ORIGIN` pins the canonical
  origin.
- Three access profiles (`read`, `standard`, `full`); destructive and terminal actions require `full`.
- `bypassPermissions` and the terminal are disabled unless explicitly enabled.
- The Web token and every `CAW_*` variable are removed from the Claude Code child environment. The gateway never reads
  or copies Claude credentials.
- Model output and tool output are untrusted: Markdown is sanitized with DOMPurify, tool output is shown as text, and
  a strict Content Security Policy forbids inline scripts and `eval`.
- Attachment and body size limits, path containment for every file operation, and cleanup of gateway-created uploads.
- systemd unit with `NoNewPrivileges`, `UMask=0077` and control-group kill semantics; the installer keeps the
  configuration file at mode 600.
- Host check: a request whose `Host` header is neither a loopback name nor the host of `CAW_PUBLIC_ORIGIN` is refused
  with `421 HOST_REJECTED`.
- The login token is stored as a SHA-256 hash by default. Sessions in that mode are signed with a random secret that ends
  at restart. Logout revocations persist across restarts.
- Event streams are limited to 64 open at once and 16 per client address (`429 TOO_MANY_STREAMS`). A request body that
  stops arriving for 30 seconds is closed, and control calls to Claude Code time out after 10 seconds.
- `CAW_TRUST_PROXY` takes the client address from `CF-Connecting-IP`, then `X-Real-IP`, then the last `X-Forwarded-For`
  entry.
- "Always allow" pre-selects allow rules and session-only mode switches (as Claude Code's "allow all edits during this
  session"); directory grants and other changes need an explicit tick. Without explicit indexes the API saves allow
  rules only.
- Rejected Claude Code credentials are reported to the session with the `ENGINE_UNAVAILABLE` code.
- `bypassPermissions`, including as the default permission mode, requires `CAW_ALLOW_BYPASS=1` and the `full` profile.
