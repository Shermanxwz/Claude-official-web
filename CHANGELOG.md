# Changelog

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses semantic versioning.

## [1.2.1] - 2026-10-10

Fixes found by running Claude Code 2.1.295 subagents through the web interface.

### Fixed

- A subagent's prompt no longer appears as a message of yours. Claude Code streams the subagent's first user turn under
  the Agent call (`parent_tool_use_id`); it now stays in the agent's card, where a later message sent to the agent
  shows as a note. The mock engine streams that prompt too, and its subagent transcripts start with it.
- An agent's finished summary in its card is rendered as Markdown instead of showing the raw markup.
- The Account panel waits for a Claude Code process that is still starting (up to 60 seconds for the initialize
  handshake) instead of answering `502` after 10 seconds.
- A fresh clone passes the seal when the optional `node-pty` could not be built: the terminal imports it by a computed
  name, so the type check no longer needs it installed.

## [1.2.0] - 2026-10-10

The rest of Claude Code's terminal screens move into the browser through the runtime's own controls, the interface
gets a complete visual system, and an independent review's findings are fixed. Verified against the real Claude Code
2.1.295 runtime as well as the mock engine.

### Added

- Runtime panels that show Claude Code's own screens: `/status`, `/permissions`, `/hooks`, `/skills`, `/sandbox`,
  `/usage`, `/mcp`, `/config` (`full` profile), `/plan` (developer console) and, with `CAW_CHROME=1`, Claude in Chrome.
  The data is read through `GET /api/sessions/:id/runtime` and `GET /api/sessions/:id/runtime/:view`.
- A memory editor for the `CLAUDE.md` and `CLAUDE.local.md` files that Claude Code loads (`GET` and
  `PUT /api/sessions/:id/memory`). Saving offers a session restart.
- Sign-in to Claude Code from the browser, in Settings → Account, through the runtime's own `/login` flow (`GET
  /api/account`, `POST /api/account/login`, `POST /api/account/login/code`, `DELETE /api/account/login` and the
  `account_changed` event). It needs the `full` profile.
- Sign-in to MCP servers that use OAuth (`POST /api/sessions/:id/mcp/auth`).
- Side questions (`/btw`, `POST /api/sessions/:id/side-question`), answered beside the conversation without adding to
  it.
- Export of a conversation to a text file (`/export`, `GET /api/sessions/:id/export`).
- Search across conversations (`GET /api/sessions/search`), a quick switcher (Ctrl+K, or ⌘K on a Mac) and a sidebar
  search. The search answer reports whether every session was read (`truncated`) and the scan limit (`scanLimit`).
- The runtime's own `@` file index (`file_suggestions`) for file mentions, with the gateway's listing as the fallback.
- Cancelling a queued message (`DELETE /api/sessions/:id/queued/:clientMessageId`), and a Stop menu item that also
  clears the queue (`POST /api/sessions/:id/interrupt` with `cancelQueued`).
- A refusal dialog: when a model declines a request, the user can retry on the fallback model, edit the prompt or
  cancel (`onUserDialog` with the `refusal_fallback_prompt` kind).
- Session settings for an agent, additional directories, a fallback model and browser tools
  (`POST /api/sessions/:id/settings`), and the matching options for new sessions.
- Browser tools: Claude in Chrome (`CAW_CHROME=1`), and a browser MCP server that the operator configures
  (`CAW_BROWSER_MCP_COMMAND`) and a `full` profile user can switch on per session.
- Configuration: `CAW_FALLBACK_MODEL`, `CAW_CHROME` and `CAW_BROWSER_MCP_COMMAND`.
- Trusting a folder also records the trust in Claude Code, through the runtime's trust handshake (`setCwd` with
  `trustAccepted`), so that project allow rules and other trust-gated features apply. The API's `trusted: false`
  removes only the gateway's record; Claude Code's own record stays until it is removed in a terminal.
- A developer console (`/devtools`) that shows the output of each runtime view and the events the page received.
- A visual system (`docs/DESIGN.md`): the bundled Atkinson Hyperlegible Next and Mono fonts, light, dark and system
  themes, three text sizes, one set of state glyphs, docked request cards and keyboard shortcuts for the frequent
  actions. Touch targets are at least 44 px on touch screens.

### Changed

- A new or resumed session is ready (idle) once Claude Code answers the SDK's initialize handshake. Claude Code sends
  `system/init` only with the first prompt, so model, permission mode and Claude Code version show as chosen, or as
  Claude Code's defaults, until the first prompt. The mock engine now behaves the same way.
- Without `CAW_DEFAULT_PERMISSION_MODE`, new sessions use the permission mode from Claude Code's own settings
  (`permissions.defaultMode`), as `claude` does. The gateway no longer chooses `default` itself.
- `/login` is no longer terminal-only: sign in from Settings → Account (`full` profile). `/logout` remains a terminal
  command.
- Approval cards show the tool's preview directly (a command block or a diff); "Always allow" lists what it saves as a
  checklist.
- The empty session shows one line of guidance; the composer's suggestion is a quiet line.

### Fixed

- A rewind is refused with `409 CONFLICT` while a turn runs or a request waits, instead of cutting the running turn. A
  dry run is refused the same way, and the header disables Rewind meanwhile.
- If Claude Code asks to trust a different folder than the one requested, the trust is not recorded and the mismatch is
  logged (`directory_mismatch`). A repeated trust of a recorded folder answers `already`.
- The search reports `truncated` when the 50-session scan limit skipped older sessions, and scans in linear time.
- Text size changes apply to the whole interface.
- Toasts no longer cover the Send button.
- Focus returns to the control that opened a dialog or a sheet; dialogs focus their first enabled control.
- Colour contrast is raised for muted text and controls in both themes.
- Runtime tabs wrap instead of hiding; the memory editor's footer no longer covers its text areas; long session titles
  no longer push the time out of the sidebar.

### Security

- `CAW_ALLOW_BYPASS=1` is accepted only with `CAW_ACCESS_PROFILE=full`; under `read` or `standard` the gateway refuses
  to start. `CAW_DEFAULT_PERMISSION_MODE=bypassPermissions` needs the same switch.
- Secrets are redacted wherever MCP and settings data reach the browser (the settings and MCP views, the capabilities
  answer and the answer of the MCP actions): values inside `env` and `headers`, and values of keys with secret-like
  names at any depth; for MCP servers also URL user names and passwords, query and fragment values, and
  secret-looking arguments. Every other runtime view drops the password of any URL written in its text, such as a
  proxy URL in the status view.
- Sign-in codes, OAuth state values and MCP callback addresses are never logged. The runtime's error output is logged at
  debug level as a byte count only.
- Memory files are written only for `CLAUDE.md` and `CLAUDE.local.md`, never through a symbolic link, only inside a
  workspace root or `$HOME/.claude`, atomically, and at most 256 KiB.
- Browser tools run only the command the operator configured. A user can switch them on for a session but cannot supply
  the command.

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
- Folder trust, as in Claude Code's own trust dialog: an untrusted folder runs with user settings only. Trusting a
  folder from the new-session notice or from a session banner loads its project settings, hooks, skills, CLAUDE.md and
  MCP servers. Endpoints `GET /api/fs/trust` and `POST /api/fs/trust`.
- Installer that stores the login token as a SHA-256 hash by default (`CAW_TOKEN_SHA256`) and prints the token once.
  `--plain-token` keeps the plaintext `CAW_TOKEN` form, and `--rotate-token` issues a new token. The existing
  configuration is checked before any dependency is installed.
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
- The login token is stored as a SHA-256 hash by default. Sessions in that mode are signed with a random secret that
  ends at restart. Logout revocations persist across restarts.
- Event streams are limited to 64 open at once and 16 per client address (`429 TOO_MANY_STREAMS`). A request body that
  stops arriving for 30 seconds is closed, and control calls to Claude Code time out after 10 seconds.
- `CAW_TRUST_PROXY` takes the client address from `CF-Connecting-IP`, then `X-Real-IP`, then the last `X-Forwarded-For`
  entry.
- "Always allow" pre-selects allow rules and session-only mode switches (as Claude Code's "allow all edits during this
  session"); directory grants and other changes need an explicit tick. Without explicit indexes the API saves allow
  rules only.
- Rejected Claude Code credentials are reported to the session with the `ENGINE_UNAVAILABLE` code.
- `bypassPermissions`, including as the default permission mode, requires `CAW_ALLOW_BYPASS=1` and the `full` profile.
