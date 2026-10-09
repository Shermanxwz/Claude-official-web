# Changelog

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses semantic versioning.

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
