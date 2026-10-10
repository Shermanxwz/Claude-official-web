English · [简体中文](README.zh-CN.md)

# claude-official-web

A self-hosted graphical Web host for the official Claude Agent SDK. It runs the same Claude Code runtime as the `claude`
terminal, so your CLAUDE.md, settings, permission rules, hooks, skills, plugins, MCP servers, subagents and session
files behave exactly as they do in the terminal.

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

- **Conversation:** streaming replies, collapsible thinking with its summary, Markdown and code, tool cards for every
  tool family (diffs for edits), subagents nested in their parent card, background tasks (including moving a running
  command or subagent to the background, like Ctrl+B), interrupts that leave background tasks running, queued messages
  that you can cancel, a Stop menu that can also clear the queue, refusal-fallback notices, a live context meter, and
  compaction shown while it runs and afterwards as a divider with its sizes and time. Side questions (`/btw`) get an
  answer that stays out of the transcript.
- **Approvals:** permission cards (allow once, allow always, or deny with a reason), answers to AskUserQuestion, plan
  approval, MCP elicitation, permission modes, and model, effort and fast mode switching. Allow always saves the ticked
  suggestions: allow rules and session-only mode switches start ticked, directory grants and other changes only when you
  tick them. When a model declines a request, a dialog offers to retry on the fallback model, edit the prompt or cancel.
- **Sessions:** start, resume, rename, tag, fork, rewind code or conversation, delete, paged history, export to a text
  file (`/export`), and a session list grouped by project. Search matches the titles and first prompts of every
  conversation, and the message text of the 50 most recently changed ones (within 5 seconds). A quick switcher (Ctrl+K,
  or ⌘K on a Mac) finds sessions by title and runs the same search.
- **Unattended mode:** one switch under which nothing waits for you: Claude runs every tool without asking, decides
  its own questions and approves its own plans, like a Codex setup that never asks (see
  [Unattended mode](#unattended-mode)).
- **Session settings:** an agent, additional directories, a fallback model and browser tools for each session. A change
  to the fallback model applies after a restart, and a change to the additional directories restarts a live session.
- **Input:** slash commands from Claude Code (skills, custom commands and MCP prompts, plus the built-in commands that
  work without a terminal), `@` file mentions, image and file attachments, and prompt suggestions.
- **Workspaces and folder trust:** allowed roots with a directory browser. Every path is checked against those roots. A
  folder's project settings, hooks, skills, CLAUDE.md and MCP servers load only after you trust the folder.
- **Runtime panels:** `/status`, `/permissions`, `/hooks`, `/memory` (an editor for the CLAUDE.md files that Claude Code
  loads), `/skills`, `/sandbox`, `/usage` and, for the `full` profile, the settings view (`/config`). The panels show
  what the runtime reports. Only the memory editor changes anything.
- **Extensions:** MCP servers with their status, toggle, reconnect and sign-in (OAuth); reload of plugins (with the
  prompt-cache check of `/reload-plugins`), skills and output styles; an output style picker; CLAUDE.md, settings, hooks
  and plugins loaded as they are in the terminal, once the folder is trusted.
- **Account:** Claude Code's sign-in from the browser, in Settings → Account, through the same flow as `/login`. The
  gateway never reads the credentials.
- **Browser tools (optional):** Claude in Chrome on a desktop host, or a browser MCP server that you configure and
  switch on per session. See [Browser](#browser).
- **Interface:** light, dark and system themes, three text sizes, keyboard shortcuts (Shift+Tab cycles the permission
  mode), touch targets of at least 44 px on touch screens, and a developer console (`/devtools`) that shows the raw
  output of each runtime view and the events this page received.
- **Official interfaces only:** every Claude Code feature goes through the Agent SDK. The public interfaces come first.
  Where the SDK has none, the gateway calls the runtime's own screens, and only when the installed runtime offers them.
  The few parts the gateway implements itself, and the reasons, are listed in
  [ARCHITECTURE.md](ARCHITECTURE.md#official-interfaces).
- **Operations:** a token login (stored as a hash by default), a health endpoint, structured logs, a systemd service
  installer, and a verification suite (`npm run seal`).
- **Terminal fallback (optional):** a terminal tab for the commands that exist only in the terminal.

## Requirements

- Linux or macOS. The production installer manages systemd user services, so it runs on Linux. On macOS, run the gateway
  with `npm start`.
- Node.js 22.12 or newer.
- A Claude subscription or an Anthropic API key. See [Usage and billing](#usage-and-billing).
- Claude Code logged in once on the server, as the same user that runs the gateway. The SDK ships the Claude Code
  binary, so the gateway does not need a separate installation. To log in, run `claude` (or `npx
  @anthropic-ai/claude-code`) once as that user and complete `/login`. Or sign in from the browser after the first
  start, in Settings → Account. That needs the `full` access profile.
- Only for the terminal tab: `build-essential` and `python3`, which node-pty needs to compile.

## Quick demo

No account is needed. The demo uses the built-in mock engine:

```bash
npm ci
npm run demo
```

Open <http://127.0.0.1:4180>. The demo has no login, so run it only on your own machine and never expose it to a
network.

## Production install (Linux)

1. Log in to Claude Code as the user who will run the service, and complete `/login` (see
   [Requirements](#requirements)).
2. Clone or unpack the project into `~/claude-official-web`. Then run the installer from that directory. Set the origin
   first if you will open the gateway through a hostname:

   ```bash
   cd ~/claude-official-web
   CAW_PUBLIC_ORIGIN=https://claude.example.com scripts/install-linux.sh
   ```

The installer checks Node.js, installs the production dependencies, creates the configuration file, installs and starts
a systemd user service, and waits for its health check. Running it again is safe: it keeps your configuration and your
login token, and it updates the dependencies and the unit. It also restarts a running service to apply the
configuration. In the default hash mode, that signs every browser out.

**The login token is printed once.** A new installation generates a token and stores only its SHA-256 hash, as
`CAW_TOKEN_SHA256`, in the configuration file. Save the token in a password manager when the installer prints it. The
file cannot show the token again. If you lose it, run `scripts/install-linux.sh --rotate-token`. Run the installer in
your own terminal rather than through Claude Code, so that the printed token never reaches a session transcript.

The configuration lives in `~/.config/claude-official-web/env` (mode 600). After you change it, run
`systemctl --user restart claude-official-web`.

```bash
systemctl --user status claude-official-web
systemctl --user restart claude-official-web
journalctl --user -u claude-official-web -f
loginctl enable-linger "$USER"                 # keep the service running after you log out
scripts/install-linux.sh --rotate-token        # issue a new login token; every browser signs in again
scripts/install-linux.sh --uninstall           # remove the service and keep the configuration
scripts/install-linux.sh --uninstall --purge   # also remove the configuration and the token
```

The installer also accepts these options:

- `--plain-token` stores a newly issued token as plaintext (`CAW_TOKEN`) instead of a hash. Use it only when the file
  must be able to show the token.
- `--rotate-token` issues a new token, stores it in the same way (or as plaintext with `--plain-token`), and restarts
  the service. Every browser session ends.
- `--show-token` prints a token issued by this run, or the plaintext token that is already stored. A stored hash cannot
  be shown.
- `--keep-claude-retention` leaves the Claude Code settings alone. By default, when `cleanupPeriodDays` is not set in
  `~/.claude/settings.json`, the installer sets it to 3650, so conversations are kept for about ten years instead of 30
  days.
- `--allow-root` (not recommended) and `--help`.

Before it installs anything, the installer checks the existing configuration. It refuses a file that sets both token
settings, a plaintext token shorter than 16 characters, a malformed hash, `CAW_REQUIRE_AUTH=0` or `CAW_ENGINE=mock`, and
it names the setting to fix. `--rotate-token` skips the token checks, because it replaces the stored token.

The deployment guide in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) covers the whole server setup, updates and backups.
To keep the service running for years with little attention, read its
[Long-term operation](docs/DEPLOYMENT.md#long-term-operation) section.

## Remote access

Expose the gateway only over HTTPS, and never publish its port directly. Choose one of these:

- **Cloudflare Tunnel with Cloudflare Access (recommended for a public hostname).** The tunnel forwards to
  `http://127.0.0.1:4180`. Access asks for an identity before the token is even considered.
- **Tailscale.** `tailscale serve --bg --https=443 127.0.0.1:4180` publishes the gateway to your tailnet only.
- **A TLS reverse proxy** that you operate, such as Caddy or nginx. Streaming requires response buffering to be off. The
  examples in the deployment guide set that.

Whichever you choose, set `CAW_PUBLIC_ORIGIN` to the exact origin that appears in the browser's address bar: scheme,
host and port, without a path or a trailing slash. A write from any other origin is refused with `ORIGIN_REJECTED`. The
gateway also accepts a request only when its `Host` header is that host or a loopback name, so the proxy must forward
the `Host` header unchanged. Otherwise the gateway answers `421 HOST_REJECTED`.

Behind a proxy or tunnel on the same host, set `CAW_TRUST_PROXY=1` so that each visitor has its own login and stream
limits. Read the deployment guide before you do: it is safe only when the proxy sets the client address header itself.

## Configuration

The gateway reads every setting from the environment. The production service reads them from the configuration file.
Boolean settings accept `0`, `1`, `true` or `false`. An invalid value stops the gateway at startup with a message that
names the variable, and the exit status is 2.

| Variable | Default | Meaning |
|---|---|---|
| `CAW_HOST` | `127.0.0.1` | Address the gateway listens on: an IP address or host name, up to 255 characters without spaces. Keep it on loopback and publish through HTTPS. |
| `CAW_PORT` | `4180` | Port the gateway listens on, from 1 to 65535. |
| `CAW_REQUIRE_AUTH` | `1` | `1` requires the login token. `0` turns login off and is accepted only with a loopback `CAW_HOST`; the installer refuses it. |
| `CAW_TOKEN` | none | Login token in plaintext, 16 to 1024 characters. Use it or `CAW_TOKEN_SHA256`, not both. `--plain-token` writes it. |
| `CAW_TOKEN_SHA256` | none | SHA-256 of the login token, as 64 hexadecimal characters. The installer writes this by default. |
| `CAW_PUBLIC_ORIGIN` | unset | The canonical origin users open, for example `https://claude.example.com`: scheme, host and port, with no path, query, fragment, credentials or trailing slash. Set it behind any proxy or tunnel. |
| `CAW_ACCESS_PROFILE` | `full` | `read` (viewing only), `standard` (everything except deleting sessions, the account sign-in, the terminal, browser tools, the settings view and bypass mode) or `full`. |
| `CAW_APP_NAME` | `Agent Web` | The product name shown in the interface, at most 60 characters. |
| `CAW_WORKSPACE_ROOTS` | `$HOME` | Colon-separated existing absolute directories where sessions may start and the directory browser looks. Prefer a projects directory. The roots limit sessions, not the agent. |
| `CAW_STATE_DIR` | `$XDG_STATE_HOME/claude-official-web`, or `~/.local/state/claude-official-web` | The gateway's state directory: session revocations, trusted folders and the folders for its own queries. An absolute path. |
| `CAW_ENGINE` | `sdk` | `sdk` runs Claude Code through the Agent SDK. `mock` selects the built-in demo engine; the installer refuses it. |
| `CAW_CLAUDE_BIN` | unset (the SDK's bundled binary) | Absolute path to an existing Claude Code executable, used for chats, sign-in and the terminal instead of the bundled binary. There is no fallback when it is set. |
| `CAW_DEFAULT_MODEL` | unset (Claude Code's default) | Model for new sessions, at most 200 characters. |
| `CAW_DEFAULT_PERMISSION_MODE` | unset (Claude Code's settings decide) | Permission mode for new sessions: `default`, `acceptEdits`, `plan`, `auto`, `dontAsk` or `bypassPermissions`. Unset, the mode comes from Claude Code's own settings, as it does in the terminal. `bypassPermissions` needs `CAW_ALLOW_BYPASS=1`. |
| `CAW_DEFAULT_EFFORT` | unset (Claude Code's default) | Effort level for new sessions: `low`, `medium`, `high`, `xhigh` or `max`. |
| `CAW_FALLBACK_MODEL` | unset | Fallback model for new sessions (`--fallback-model`), at most 200 characters. A refused answer can be retried on it. |
| `CAW_CHROME` | `0` | `1` starts each query with Claude in Chrome (the CLI's `--chrome` flag). It needs a claude.ai sign-in, and Chrome with the Claude in Chrome extension on the gateway's machine. |
| `CAW_BROWSER_MCP_COMMAND` | unset | A JSON array with the command and its arguments for a browser MCP server, for example `["npx","-y","@playwright/mcp@0.0.82","--headless","--isolated"]`. Sessions can switch it on as the `browser` server. The array holds 1 to 32 strings of up to 1024 characters; the first is an absolute path or a bare command name. |
| `CAW_TERMINAL` | `0` | `1` enables the terminal tab. It needs the `full` profile and node-pty, and it is equivalent to shell access. |
| `CAW_ALLOW_BYPASS` | `0` | `1` allows the `bypassPermissions` mode, including as the default mode, and makes the unattended switch available. It needs `CAW_ACCESS_PROFILE=full`; under `read` or `standard` the gateway refuses to start with it. As root it also needs `IS_SANDBOX=1` (see [Unattended mode](#unattended-mode)). |
| `CAW_UNATTENDED` | `0` | `1` turns on [unattended mode](#unattended-mode) by default and implies `CAW_ALLOW_BYPASS=1`. The switch in Settings can still turn it off; the saved choice wins after that. Needs the `full` profile. |
| `CAW_IDLE_TIMEOUT_MS` | `1800000` (30 minutes) | Idle live sessions close after this time, from 60000 to 86400000 milliseconds, and resume when you send the next message. |
| `CAW_MAX_LIVE_SESSIONS` | `4` | The maximum number of live Claude Code processes at once, from 1 to 32. |
| `CAW_UPLOAD_MAX_BYTES` | `26214400` (25 MiB) | The largest accepted attachment, from 1 KiB to 1 GiB. |
| `CAW_IMAGE_MAX_BYTES` | `5242880` (5 MiB) | The largest image sent inline as an image, from 1 KiB to 20 MiB. A larger image, up to `CAW_UPLOAD_MAX_BYTES`, is sent as a file path. |
| `CAW_UPLOAD_RETENTION_DAYS` | `7` | Attachment batches created by the gateway are removed after this many days, from 1 to 365. |
| `CAW_SESSION_TTL_HOURS` | `168` (7 days) | How long a web login session stays valid, in hours, from 1 to 8760. |
| `CAW_TRUST_PROXY` | `0` | `1` takes the client address from `CF-Connecting-IP`, then `X-Real-IP`, then the last `X-Forwarded-For` entry. Use it only when the gateway is reachable only through a proxy that sets one of those headers itself. |
| `CAW_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |
| `CAW_MOCK_DELAY_MS` | `12` | The delay between simulated output tokens, from 0 to 10000 milliseconds. Mock engine only. |
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` | unset | Read from the gateway's environment and inherited by Claude Code. A non-empty value other than `0` or `false` turns background tasks off, and the gateway then offers no Run in background action. |

## Security model

The full threat model and the list of controls are in [SECURITY.md](SECURITY.md). In brief:

- One operator and one login token. The token signs you in, and the session afterwards is an HttpOnly, SameSite=Strict
  cookie. The installer stores only the token's SHA-256 hash, so the configuration file cannot be used to sign in. To
  hash a token that you choose yourself, run these commands, then put the 64-character output in `CAW_TOKEN_SHA256`:

  ```bash
  read -r -s -p "Login token: " TOKEN && echo
  printf '%s' "$TOKEN" | sha256sum | cut -d' ' -f1    # macOS: shasum -a 256 | cut -d' ' -f1
  unset TOKEN
  ```

- Every request must name an allowed host: a loopback name (`127.0.0.1`, `localhost` or `[::1]`) or the host of
  `CAW_PUBLIC_ORIGIN`. Any other host gets `421 HOST_REJECTED`, which blocks DNS-rebinding attacks.
- Every write must come from the configured origin. This blocks cross-site requests and cross-site WebSocket hijacking.
- In the default hash mode, sessions end when the gateway restarts, including after an installer run. With a plaintext
  `CAW_TOKEN`, they survive restarts. A logout stays in effect across restarts in both modes.
- Logins are throttled: ten failures per client address in ten minutes. Event streams are limited to 64 open at once and
  16 per client address. A request body that stops arriving for 30 seconds is closed. Most control calls to Claude Code
  time out after 10 seconds; a few allow longer (usage 15 seconds, side questions and sign-in 120 seconds).
- Folder trust: an untrusted folder runs with your user settings only. Trusting a folder also records Claude Code's own
  trust for it, through the runtime's handshake, and the gateway cannot revoke that record. To remove it, stop Claude
  Code, then set `hasTrustDialogAccepted` to `false` for the folder under `projects` in `~/.claude.json`, or delete that
  folder's entry. Trust a folder only after you have read what is in it.
- The gateway never reads Claude credentials. It removes the login token and every `CAW_*` variable from the environment
  of Claude Code.
- Model output is untrusted. Markdown is sanitized, and tool output is shown as text.
- Permissions are Claude Code's own. Approve only what you have read: an approved command runs with the service user's
  full authority. Browser tools have the same authority; see [Browser](#browser).

## Unattended mode

The equivalent of a "never ask" Codex setup (`approvalPolicy: 'never'` with `danger-full-access`): one switch under
which nothing waits for you. Claude runs every tool without asking (Claude Code's `bypassPermissions` mode), its
questions are answered with "decide yourself, say which option you chose and why", its plans are approved, MCP forms
are declined, and a refused answer is not retried on another model. Each automatic answer leaves one line in the
conversation, so you can see afterwards what was asked. Subagents inherit the mode.

- Turn it on for the server with `CAW_UNATTENDED=1` (it needs `CAW_ACCESS_PROFILE=full`). It is then on by default,
  and anyone with the `full` profile can switch it off and on again in Settings → Permissions. The choice is saved in
  the state directory and survives restarts. With only `CAW_ALLOW_BYPASS=1`, the switch is available but starts off.
- While it is on, the header shows an **Unattended** pill and the permission mode is fixed. Turning it off returns each
  live session to the mode it had before.
- Claude Code refuses bypass mode when it runs as root. Run the gateway as a normal user (the installer's default), or,
  on a machine that is a dedicated sandbox, set `IS_SANDBOX=1` in the service environment. As root without either, the
  gateway refuses to start with the bypass settings and says why.

Unattended means that whatever a file, a web page or a tool result tells the model can be acted on without review, with
the service user's authority. Use it on a machine or user account dedicated to the agent, with backups and git.

## Browser

Claude can drive a browser in two ways. They are separate, and you can enable either or both.

- **Claude in Chrome** (`CAW_CHROME=1`) uses the Claude in Chrome extension in a Chrome browser on the same machine as
  the gateway, with that browser's sign-ins. It needs a claude.ai sign-in for Claude Code, so it does not work on a
  headless server. The Claude in Chrome tab in the runtime panels shows whether it is allowed, installed and connected,
  with links to install it and to reconnect it.
- **A browser MCP server** (`CAW_BROWSER_MCP_COMMAND`) is a server that you start on the gateway's host. The example in
  the configuration table runs Playwright's browser server headless, which suits a server without a display. A session
  gets it as the `browser` server when someone with the `full` profile turns on **Browser tools** in the session
  settings. Only the operator sets the command, and a user cannot supply one. The deployment guide explains the setup.

Browser tools act with the service user's network access and files, and what a web page says can steer the model. Turn
them on only for the sessions that need them.

## Terminal fallback

Some Claude Code features exist only in the terminal: `/theme`, `/terminal-setup`, vim mode, custom keybindings, `!`
shell mode, full-screen dialogs such as `/resume` and `/config`, changing hooks and permission rules (the panels show
them read-only), choosing among several Chrome browsers (`/chrome`), and `/logout`. Sign-in is in Settings → Account, so
`/login` no longer needs the terminal. The optional terminal tab runs Claude Code in a pseudo-terminal. It either
attaches to a session (`claude --resume <id>`) or starts a fresh `claude` in a project.

Enable it with `CAW_TERMINAL=1`. It needs the `full` profile, and node-pty must be built, which requires
`build-essential` and `python3`. The terminal is equivalent to a shell as the service user, so enable it only on a host
that only you operate. While the terminal is attached to a session, the browser cannot send messages, rewind, fork,
delete or use live controls in that session; it can still rename and tag it, and settings changes are kept for its next
start. Detach the terminal to continue in the browser.

The terminal runs the executable from `CAW_CLAUDE_BIN` when that is set, with no fallback. Otherwise it runs the native
binary that the SDK ships for the platform, and only when that is missing, the first `claude` on `PATH`.

## Sessions and the terminal

Sessions started in the browser are stored in `~/.claude/projects`, just like terminal sessions. To continue one in a
terminal, run `claude --resume <id>` with its session ID. Sessions created by the SDK may not appear in Claude Code's
interactive `/resume` picker, so use the session ID.

## Usage and billing

Anthropic's help center says:

> You can still use the Claude Agent SDK, `claude -p`, and third-party apps with your subscription limits.

Source: [Use the Claude Agent SDK with your Claude
plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).

The Agent SDK documentation adds this note:

> Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits
> for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods described
> in the Quickstart instead.

Source: [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview).

What this means for you:

- claude-official-web is built for **personal self-hosting**. You run the gateway for yourself, on a server you control,
  with your own login.
- If you give access to other people, or run the gateway for a team or for customers, do not share a claude.ai login.
  Use Anthropic API keys, as the Agent SDK quickstart describes.
- Every turn uses the account you logged in with, and it counts against that account's limits or billing.
- Settings → Account shows whether Claude Code uses a Claude subscription, with its plan, or an API account, with its
  provider. That choice decides what is billed.

## Development

```bash
npm ci
npm run dev            # mock engine, restarts on change, no login
npm test               # unit and integration tests (about 1,700)
npm run test:e2e       # 50 browser tests; install Chromium first: npx playwright-core install chromium
npm run typecheck      # tsc over the JSDoc types
npm run check          # static rules over the whole tree
npm run seal           # runs the checks above and verifies the source manifest; writes .state/seal-receipt.json
```

The other scripts are `npm run manifest` and `npm run manifest:verify` (source manifest), `npm run smoke:runtime` and
`npm run smoke:gateway` (real-engine and deployed-gateway validation, see
[docs/PRODUCTION_SEAL.md](docs/PRODUCTION_SEAL.md)), `npm run screenshots` (renders the images in `docs/screenshots`
with Chromium), and `npm run maintenance:prune` (removes expired attachments).

The layout is:

- `src/`: the Node.js gateway (ES modules with `// @ts-check`).
- `public/`: the browser interface (vanilla ES modules, no bundler).
- `test/unit`, `test/integration`, `test/e2e`: the test suites. `test/e2e` drives Chromium.
- `scripts/`: the seal, static checks, smoke tests and the installer.
- `deploy/`: the systemd user unit template.
- `docs/`: the deployment, feature, seal, protocol, frontend and engineering documents.

The contracts are [ARCHITECTURE.md](ARCHITECTURE.md), [docs/PROTOCOL.md](docs/PROTOCOL.md),
[docs/FRONTEND.md](docs/FRONTEND.md) and [docs/ENGINEERING.md](docs/ENGINEERING.md). Dependencies are pinned exactly,
and adding one requires an architecture decision.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ENGINE_UNAVAILABLE` (HTTP 503), or a notice with this code in a session | Claude Code is not logged in for the user that runs the gateway, its binary cannot be found, or its sign-in was rejected during a session | Run `claude` as that user and complete `/login`, or sign in from Settings → Account with the `full` profile. Then reopen the session. Set `CAW_CLAUDE_BIN` if the binary cannot be found. Restart the service after a configuration change. |
| Settings → Account says that sign-in needs the full access profile | `CAW_ACCESS_PROFILE` is `read` or `standard` | Use `full`, or sign in with `claude` and `/login` in a terminal on the server. |
| `FEATURE_DISABLED` (HTTP 501) when a session turns on browser tools | `CAW_BROWSER_MCP_COMMAND` is not set | Set the command in the configuration file, restart the service, and turn browser tools on again. |
| The Claude in Chrome tab shows that it is not installed or not connected | The extension is missing from the Chrome that runs on the gateway's machine, Chrome is not running, or Claude Code has no claude.ai sign-in | Install the Claude in Chrome extension in that Chrome, make sure Claude Code is signed in with a claude.ai account, then use the reconnect link in the tab. |
| `HOST_REJECTED` (HTTP 421) | The `Host` header is neither a loopback name nor the host of `CAW_PUBLIC_ORIGIN`. Usually `CAW_PUBLIC_ORIGIN` is missing, or a proxy rewrites `Host` | Set `CAW_PUBLIC_ORIGIN` to the address in the browser, make the proxy forward `Host` unchanged (`proxy_set_header Host $host;` in nginx), then restart the service. |
| `ORIGIN_REJECTED` | The browser's origin differs from `CAW_PUBLIC_ORIGIN`, which is common behind a proxy or tunnel | Set `CAW_PUBLIC_ORIGIN` to the exact origin in the address bar, then restart the service. |
| `INVALID_TOKEN` (HTTP 401) | The login token does not match the configured token | Enter the token that the installer printed. If it is lost, run `scripts/install-linux.sh --rotate-token` in your own terminal. Every session ends. |
| `RATE_LIMITED` (HTTP 429) | Too many failed login attempts from one client address | Wait for the `Retry-After` period. Behind a proxy without `CAW_TRUST_PROXY=1`, all visitors share one count. |
| `TOO_MANY_STREAMS` (HTTP 429) | More than 16 event streams from one client address, or 64 in all | Close the other gateway tabs. Behind a proxy without `CAW_TRUST_PROXY=1`, all visitors share one limit. |
| `SESSION_LOCKED` | The terminal tab holds the session | Exit the terminal session or detach it. The browser can write again. |
| `TOO_MANY_SESSIONS` | Every live slot is busy | Wait for a session to go idle, or raise `CAW_MAX_LIVE_SESSIONS`. Each live session is a separate process. |
| Browsers ask you to sign in again | The service restarted. In hash mode the session secret exists only in memory, so every restart, including an installer run, ends the sessions | Sign in again. A plaintext `CAW_TOKEN` keeps sessions across restarts. |
| A session shows the untrusted-folder banner | The folder has not been trusted, so its project hooks, MCP servers and CLAUDE.md do not load | Trust the folder from the banner. The session restarts with project settings. |
| The installer refuses the configuration | The file sets something the production service does not accept, such as both token settings | Fix the named setting in `~/.config/claude-official-web/env`. `--rotate-token` replaces the stored token settings. |
| The terminal tab reports that node-pty is missing | node-pty was not compiled during installation | Install `build-essential` and `python3`, then run `scripts/install-linux.sh` again. |
| Replies stop partway behind nginx | Response buffering or a short timeout on the event stream | Set `proxy_buffering off` and `proxy_read_timeout 3600s` for the gateway location. |
| The service stops when you log out | Lingering is not enabled for the user | Run `loginctl enable-linger "$USER"`. |
| The service does not start | A configuration error, or Node.js is missing | Run `journalctl --user -u claude-official-web -n 100 --no-pager`. Exit status 2 means a configuration error; fix the variable named in the log. |

## License

MIT. See [LICENSE](LICENSE).
