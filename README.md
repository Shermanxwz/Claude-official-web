English · [简体中文](README.zh-CN.md)

# claude-official-web

A self-hosted graphical Web host for the official Claude Agent SDK. It runs the same Claude Code runtime as the `claude`
terminal, so your CLAUDE.md, settings, permission rules, hooks, skills, plugins, MCP servers, subagents and session files
behave exactly as they do in the terminal.

## Screenshots

![Desktop, light theme](docs/screenshots/desktop-light.png)

![Desktop, dark theme](docs/screenshots/desktop-dark.png)

![Mobile](docs/screenshots/mobile.png)

## What it is

claude-official-web has two parts:

- The **gateway** is a Node.js process. It checks your login, serves the interface and forwards requests to the official
  Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` 0.3.295).
- The **engine** is the SDK, which starts the official Claude Code runtime (2.1.295) for each live session. Every reply,
  tool call, permission decision and file change is produced by Claude Code itself. The gateway only transports and
  displays them.

The interface renders the conversation, approval cards and session tools in your browser. It can also attach a terminal
tab, which you turn on only when you need it.

Because the engine is Claude Code, sessions are the same files the terminal uses in `~/.claude/projects`. A session
started in the browser can be continued in a terminal with `claude --resume <id>`, and the other way round.

claude-official-web is an independent project. It is not affiliated with, endorsed by or sponsored by Anthropic. The
interface does not present itself as Claude Code and does not use Claude Code's branding. The product name is
configurable (`CAW_APP_NAME`, default `Agent Web`).

## Features

This is an overview. The complete map, with the SDK call or message behind each feature, is in
[docs/FEATURES.md](docs/FEATURES.md).

- **Conversation:** streaming replies, collapsible thinking, Markdown and code, tool cards for every tool family (diffs
  for edits), subagents nested in their parent card, background tasks, interrupts, queued messages, compaction and
  context usage.
- **Approvals:** permission cards (allow once, allow always, or deny with a reason), answers to AskUserQuestion, plan
  approval, MCP elicitation, permission modes, and model and effort switching.
- **Sessions:** start, resume, rename, tag, fork, rewind code or conversation, delete, paged history, and a session list
  grouped by project.
- **Input:** slash commands from Claude Code (skills, custom commands and MCP prompts, plus the built-in commands that work
  without a terminal), `@` file mentions, image and file attachments, and prompt suggestions.
- **Workspaces:** allowed roots with a directory browser. Every path is checked against those roots.
- **Extensions:** MCP server status, toggle and reconnect; reload of plugins and skills; CLAUDE.md, settings, hooks and
  plugins loaded as they are in the terminal.
- **Operations:** a token login, a health endpoint, structured logs, a systemd service installer, and a verification
  suite (`npm run seal`).
- **Terminal fallback (optional):** a terminal tab for the commands that exist only in the terminal.

## Requirements

- Linux or macOS. The production installer manages systemd user services, so it runs on Linux. On macOS, run the gateway
  with `npm start`.
- Node.js 22.12 or newer.
- A Claude subscription or an Anthropic API key. See [Usage and billing](#usage-and-billing).
- Claude Code logged in once on the server, as the same user that runs the gateway. The SDK ships the Claude Code binary,
  so the gateway does not need a separate installation. To log in, run `claude` (or `npx @anthropic-ai/claude-code`) once
  as that user and complete `/login`.
- Only for the terminal tab: `build-essential` and `python3`, which node-pty needs to compile.

## Quick demo

No account is needed. The demo uses the built-in mock engine:

```bash
npm ci
npm run demo
```

Open <http://127.0.0.1:4180>. The demo has no login, so run it only on your own machine and never expose it to a network.

## Production install (Linux)

1. Log in to Claude Code as the user who will run the service, and complete `/login` (see [Requirements](#requirements)).
2. Clone or unpack the project into `~/claude-official-web`. Then run the installer from that directory. Set the origin
   first if you will open the gateway through a hostname:

   ```bash
   cd ~/claude-official-web
   CAW_PUBLIC_ORIGIN=https://claude.example.com scripts/install-linux.sh
   ```

The installer checks Node.js, installs the production dependencies, creates the configuration file with a generated
login token, installs and starts a systemd user service, and waits for its health check. Running it again is safe. It
keeps your configuration and token.

The configuration lives in `~/.config/claude-official-web/env` (mode 600). It contains the login token, so treat that
file like a password. After you change it, run `systemctl --user restart claude-official-web`.

```bash
systemctl --user status claude-official-web
systemctl --user restart claude-official-web
journalctl --user -u claude-official-web -f
loginctl enable-linger "$USER"                 # keep the service running after you log out
scripts/install-linux.sh --uninstall           # remove the service and keep the configuration
scripts/install-linux.sh --uninstall --purge   # also remove the configuration and the token
```

The installer also accepts `--show-token` (print the token once; it is never printed otherwise), `--allow-root` (not
recommended) and `--help`. The deployment guide in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) covers the whole server
setup, updates and backups.

## Remote access

Expose the gateway only over HTTPS, and never publish its port directly. Choose one of these:

- **Cloudflare Tunnel with Cloudflare Access (recommended for a public hostname).** The tunnel forwards to
  `http://127.0.0.1:4180`. Access asks for an identity before the token is even considered.
- **Tailscale.** `tailscale serve --bg --https=443 127.0.0.1:4180` publishes the gateway to your tailnet only.
- **A TLS reverse proxy** that you operate, such as Caddy or nginx. Streaming requires response buffering to be off. The
  examples in the deployment guide set that.

Whichever you choose, set `CAW_PUBLIC_ORIGIN` to the exact origin that appears in the browser's address bar: scheme, host
and port, without a path or a trailing slash. A request from any other origin is refused with `ORIGIN_REJECTED`.

## Configuration

The gateway reads every setting from the environment. The production service reads them from the configuration file.

| Variable | Default | Meaning |
|---|---|---|
| `CAW_HOST` | `127.0.0.1` | Address the gateway listens on. Keep it on loopback and publish through HTTPS. |
| `CAW_PORT` | `4180` | Port the gateway listens on. |
| `CAW_REQUIRE_AUTH` | `1` | `1` requires the login token. `0` is for the demo only. |
| `CAW_TOKEN` | none | Login token, at least 16 characters, required when `CAW_REQUIRE_AUTH=1`. The installer generates one. |
| `CAW_PUBLIC_ORIGIN` | unset | The canonical origin users open, for example `https://claude.example.com`. Set it behind any proxy or tunnel. |
| `CAW_ACCESS_PROFILE` | `full` | `read` (viewing and login only), `standard` (everything except deleting sessions, the terminal and bypass mode) or `full`. |
| `CAW_APP_NAME` | `Agent Web` | The product name shown in the interface. |
| `CAW_WORKSPACE_ROOTS` | `$HOME` | Colon-separated directories that sessions may use. Every path is resolved and must stay inside one of them. |
| `CAW_STATE_DIR` | `~/.local/state/claude-official-web` | The gateway's state directory. |
| `CAW_ENGINE` | `sdk` | `sdk` runs Claude Code through the Agent SDK. `mock` selects the built-in demo engine. |
| `CAW_CLAUDE_BIN` | unset (the SDK's bundled binary) | Path to a Claude Code executable to use instead of the bundled one. |
| `CAW_DEFAULT_MODEL` | unset (Claude Code's default) | Model for new sessions. |
| `CAW_DEFAULT_PERMISSION_MODE` | `default` | Permission mode for new sessions. |
| `CAW_DEFAULT_EFFORT` | unset (Claude Code's default) | Effort level for new sessions: `low`, `medium`, `high`, `xhigh` or `max`. |
| `CAW_TERMINAL` | `0` | `1` enables the terminal tab. It needs the `full` profile and node-pty, and it is equivalent to shell access. |
| `CAW_ALLOW_BYPASS` | `0` | `1` allows the `bypassPermissions` mode. It needs the `full` profile. |
| `CAW_IDLE_TIMEOUT_MS` | `1800000` (30 minutes) | Idle live sessions close after this time and resume when you send the next message. |
| `CAW_MAX_LIVE_SESSIONS` | `4` | The maximum number of live Claude Code processes at once. |
| `CAW_UPLOAD_MAX_BYTES` | `26214400` (25 MiB) | The largest accepted attachment. |
| `CAW_IMAGE_MAX_BYTES` | `5242880` (5 MiB) | The largest accepted image attachment. |
| `CAW_UPLOAD_RETENTION_DAYS` | `7` | Attachment batches created by the gateway are removed after this many days. |
| `CAW_SESSION_TTL_HOURS` | `168` (7 days) | How long a web login session stays valid, in hours. |
| `CAW_TRUST_PROXY` | `0` | `1` takes the client address from `X-Forwarded-For`. Use it only behind a proxy that overwrites that header. |
| `CAW_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |
| `CAW_MOCK_DELAY_MS` | `12` | The delay between simulated output tokens. Mock engine only. |

## Security model

The full threat model and the list of controls are in [SECURITY.md](SECURITY.md). In brief:

- One operator and one token. The token signs you in, and the session afterwards is an HttpOnly, SameSite=Strict cookie.
- Every write must come from the configured origin. This blocks cross-site requests and cross-site WebSocket hijacking.
- The gateway never reads Claude credentials. It removes the login token and every `CAW_*` variable from the environment
  of Claude Code.
- Model output is untrusted. Markdown is sanitized, and tool output is shown as text.
- Permissions are Claude Code's own. Approve only what you have read: an approved command runs with the service user's
  full authority.

## Terminal fallback

Some Claude Code features exist only in the terminal: `/theme`, `/terminal-setup`, vim mode, custom keybindings, `!` shell
mode, full-screen pickers such as `/resume` and `/config`, and `/login`. The optional terminal tab runs Claude Code in a
pseudo-terminal. It either attaches to a session (`claude --resume <id>`) or starts a fresh `claude` in a project.

Enable it with `CAW_TERMINAL=1`. It needs the `full` profile, and node-pty must be built, which requires `build-essential`
and `python3`. The terminal is equivalent to a shell as the service user, so enable it only on a host that only you
operate. While the terminal is attached to a session, the browser cannot write to that session. Detach the terminal to
continue in the browser.

## Sessions and the terminal

Sessions started in the browser are stored in `~/.claude/projects`, just like terminal sessions. To continue one in a
terminal, run `claude --resume <id>` with its session ID. Sessions created by the SDK may not appear in Claude Code's
interactive `/resume` picker, so use the session ID.

## Usage and billing

Anthropic's help center says:

> You can still use the Claude Agent SDK, `claude -p`, and third-party apps with your subscription limits.

Source: [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).

The Agent SDK documentation adds this note:

> Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for
> their products, including agents built on the Claude Agent SDK. Use the API key authentication methods described in the
> Quickstart instead.

Source: [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview).

What this means for you:

- claude-official-web is built for **personal self-hosting**. You run the gateway for yourself, on a server you control,
  with your own login.
- If you give access to other people, or run the gateway for a team or for customers, do not share a claude.ai login.
  Use Anthropic API keys, as the Agent SDK quickstart describes.
- Every turn uses the account you logged in with, and it counts against that account's limits or billing.

## Development

```bash
npm ci
npm run dev            # mock engine, restarts on change, no login
npm test               # unit and integration tests
npm run test:e2e       # browser tests; install Chromium first: npx playwright-core install chromium
npm run typecheck      # tsc over the JSDoc types
npm run check          # static rules over the whole tree
npm run seal           # runs the checks above and verifies the source manifest; writes .state/seal-receipt.json
```

The other scripts are `npm run manifest` and `npm run manifest:verify` (source manifest), `npm run smoke:runtime` and
`npm run smoke:gateway` (real-engine and deployed-gateway validation, see
[docs/PRODUCTION_SEAL.md](docs/PRODUCTION_SEAL.md)), and `npm run maintenance:prune` (removes expired attachments).

The layout is:

- `src/`: the Node.js gateway (ES modules with `// @ts-check`).
- `public/`: the browser interface (vanilla ES modules, no bundler).
- `test/unit`, `test/integration`, `test/e2e`: the test suites. `test/e2e` drives Chromium.
- `scripts/`: the seal, static checks, smoke tests and the installer.
- `deploy/`: the systemd user unit template.
- `docs/`: the deployment, feature, seal, protocol, frontend and engineering documents.

The contracts are [ARCHITECTURE.md](ARCHITECTURE.md), [docs/PROTOCOL.md](docs/PROTOCOL.md), [docs/FRONTEND.md](docs/FRONTEND.md)
and [docs/ENGINEERING.md](docs/ENGINEERING.md). Dependencies are pinned exactly, and adding one requires an architecture
decision.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ENGINE_UNAVAILABLE` (HTTP 503) | Claude Code is not logged in for the user that runs the gateway, or its binary cannot be found | Run `claude` as that user and complete `/login`, or set `CAW_CLAUDE_BIN`. Then restart the service. |
| `SESSION_LOCKED` | The terminal tab holds the session | Exit the terminal session or detach it. The browser can write again. |
| `ORIGIN_REJECTED` | The browser's origin differs from `CAW_PUBLIC_ORIGIN`, which is common behind a proxy or tunnel | Set `CAW_PUBLIC_ORIGIN` to the exact origin in the address bar, then restart the service. |
| `RATE_LIMITED` | Too many failed login attempts from one address | Wait for the `Retry-After` period, and check the token. |
| `TOO_MANY_SESSIONS` | Every live slot is busy | Wait for a session to go idle, or raise `CAW_MAX_LIVE_SESSIONS`. Each live session is a separate process. |
| The terminal tab reports that node-pty is missing | node-pty was not compiled during installation | Install `build-essential` and `python3`, then run `scripts/install-linux.sh` again. |
| Replies stop partway behind nginx | Response buffering or a short timeout on the event stream | Set `proxy_buffering off` and `proxy_read_timeout 3600s` for the gateway location. |
| The service stops when you log out | Lingering is not enabled for the user | Run `loginctl enable-linger "$USER"`. |
| The service does not start | A configuration error, or Node.js is missing | Run `journalctl --user -u claude-official-web -n 100 --no-pager`. Exit status 2 means a configuration error; fix the variable named in the log. |

## License

MIT. See [LICENSE](LICENSE).
