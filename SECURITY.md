# Security policy

## Supported versions

Security fixes are released for the latest 1.x version. Earlier pre-release builds are not supported. Check the version
with `GET /api/meta` (field `version`) or in `package.json`.

| Version | Supported |
|---|---|
| 1.x (latest release) | Yes |
| Anything older | No |

## Reporting a vulnerability

Do not report vulnerabilities in a public issue or pull request. Use GitHub's private vulnerability reporting for this
repository: open the **Security** tab and choose **Report a vulnerability**.

Include, where you can:

- the version (`package.json`) and the commit you tested;
- the configuration: access profile, whether `CAW_TERMINAL` or `CAW_ALLOW_BYPASS` was enabled, whether the token is
  stored as a hash or in plaintext, and how the gateway was exposed (loopback, tunnel, reverse proxy, Tailscale);
- steps to reproduce, the observed result and the impact you expect.

Never include a real login token, cookie, API key or Claude credentials in a report. Replace them with placeholders.

The maintainers will acknowledge reports as soon as they can and will coordinate a fix and disclosure timeline with you.

## Threat model

claude-official-web is a self-hosted remote control for an agent that can read and write files and run commands as the
user that operates it. It is designed for one trusted operator who runs the gateway for themselves.

Assumptions:

- The operator controls the host, the service account and the Claude Code login.
- The gateway is reached only through the operator's chosen HTTPS entry point.
- Anything the operator approves runs with the service account's authority, exactly as in the terminal.

Threats the project defends against:

- **Remote unauthenticated access.** Every API route except the session probe and login requires a valid session cookie.
  The health check answers without one and reveals nothing else.
- **Cross-site request forgery and cross-site WebSocket hijacking.** Every non-GET request and the terminal upgrade must
  carry the exact configured Origin.
- **DNS rebinding.** Every request, including the health check and the terminal upgrade, must carry a `Host` header that
  is a loopback name or the host of `CAW_PUBLIC_ORIGIN`. Any other host is refused with `421 HOST_REJECTED` before
  routing.
- **Malicious model output and repository content.** Markdown is sanitized, tool output is rendered as text, and no
  model-provided HTML or script runs in the browser. Model actions remain subject to Claude Code's permission system and
  to the operator's approvals.
- **Untrusted repositories.** A folder's project settings, hooks, skills, CLAUDE.md and MCP servers load only after the
  operator trusts that folder. Until then a session runs with the operator's user settings only.
- **Path traversal.** Every path used for workspaces, attachments, file search and directory browsing is resolved with
  `realpath` and must stay inside an allowed root. A session whose folder lies outside the roots answers
  `404 SESSION_NOT_FOUND`.
- **Upload abuse.** Uploads have size limits, are written with mode 0600 under the workspace, and are removed after the
  retention period. Only files the gateway created are ever deleted.
- **Token theft.** The login token is never logged, never placed in a URL, never passed to Claude Code and never
  returned by the API. By default the configuration file holds only the token's SHA-256 hash, so reading that file does
  not reveal the token. The login cookie is HttpOnly and SameSite=Strict.
- **An agent reading the configuration file.** Claude Code runs as the same operating-system user and can read the files
  that user can read. With a plaintext `CAW_TOKEN` in the file, an agent could read the token, sign in and approve its
  own requests. The hashed default removes that route. The remaining limit is described under known limitations.
- **Resource exhaustion by clients.** Event streams, request bodies, login attempts and calls into Claude Code are
  limited (see the controls below).
- **Credential access.** The gateway never reads `~/.claude/.credentials.json` or keychain entries, and never edits
  settings or history files directly. Its only direct writes are the memory files listed under Authorization, uploads,
  folders created through the directory browser (`POST /api/fs/mkdir`, inside a workspace root) and its own state.

Out of scope:

- Compromise of the host, the service account or the operator's machine.
- A malicious operator.
- Multi-user isolation. The gateway is not a multi-tenant service; every signed-in person has the operator's authority.
- Availability attacks by someone who already holds a valid login.
- The security of Anthropic's models, services and the Claude Code runtime. Report those to Anthropic.

## Implemented controls

Authentication and sessions:

- Token login issues an HMAC-signed session cookie that is HttpOnly, SameSite=Strict and Path=/, and Secure when the
  public origin is HTTPS. Logout revokes the cookie server-side, and the revocation is kept in the state directory, so
  it survives restarts.
- The token is configured either as `CAW_TOKEN_SHA256` (the default when the installer creates it) or as plaintext
  `CAW_TOKEN` (16 to 1024 characters). Exactly one of the two must be set when authentication is required.
- Session signing depends on the mode. With `CAW_TOKEN_SHA256` the signing secret is random and kept in memory only, so
  sessions end when the gateway restarts. With a plaintext `CAW_TOKEN` the secret is derived from the token, so sessions
  survive restarts and end when the token changes.
- Login attempts are rate limited: ten failed attempts per client address in ten minutes return `429 RATE_LIMITED` with
  a `Retry-After` header.
- The client address for that limit, and for the stream limit below, is the socket address. With `CAW_TRUST_PROXY=1` it
  is taken from `CF-Connecting-IP`, then `X-Real-IP`, then the last `X-Forwarded-For` entry. The first `X-Forwarded-For`
  entry is ignored because the client sends it. Values that are not IP addresses are ignored.
- `CAW_REQUIRE_AUTH=1` is the default. The installer refuses to run while the configuration sets `CAW_REQUIRE_AUTH=0` or
  `CAW_ENGINE=mock`, and it checks the token settings before it installs anything.

Request integrity:

- Host check: every request, including `/healthz` and the terminal upgrade, must carry a `Host` header that is
  `localhost`, `127.0.0.1` or `[::1]` on any port, or the host of `CAW_PUBLIC_ORIGIN`. Anything else returns `421
  HOST_REJECTED`.
- Every non-GET request and the terminal WebSocket upgrade must carry an Origin equal to `CAW_PUBLIC_ORIGIN` (or to the
  request origin when that variable is unset). Anything else returns `403 ORIGIN_REJECTED`.
- JSON bodies are limited to 1 MiB. A request body that stops arriving for 30 seconds is closed without a response.
  Uploads and images have their own limits (`CAW_UPLOAD_MAX_BYTES`, `CAW_IMAGE_MAX_BYTES`).

Limits:

- Event streams: at most 64 open at once, and 16 per client address (`429 TOO_MANY_STREAMS`).
- Live sessions: at most `CAW_MAX_LIVE_SESSIONS` Claude Code processes (`429 TOO_MANY_SESSIONS` when all are busy).
- Control calls to Claude Code time out after 10 seconds (`502 ENGINE_ERROR`), except the few that need longer: the
  usage view 15 seconds, the full context breakdown 30 seconds, side questions and sign-in completion 120 seconds.

Authorization:

- Three access profiles. `read` is for viewing. `standard` is everything except deleting sessions, the account sign-in,
  the terminal, browser tools, the `settings` view (`/config`) and the `bypassPermissions` mode. `full` is everything.
- Folder trust (`GET` and `POST /api/fs/trust`; changing trust needs `standard` or higher). An untrusted folder starts
  its sessions with user settings only. A trusted folder, or a folder inside one, also loads project and local settings.
  The trust list is kept in the state directory, and it applies to sessions opened after the change. The gateway writes
  Claude Code's own trust record only through the runtime's handshake, and only for the folder that was asked for.
- The terminal is disabled unless `CAW_TERMINAL=1` and the profile is `full`.
- `CAW_ALLOW_BYPASS=1` is accepted only with `CAW_ACCESS_PROFILE=full`. Under `read` or `standard` the gateway refuses
  to start with it, so no route can reach the `bypassPermissions` mode. A default mode of `bypassPermissions` also needs
  the switch.
- "Always allow" saves the ticked suggestions. The UI pre-ticks allow rules (`addRules` and `replaceRules` with behavior
  `allow`) and session-only mode switches; directory grants, other mode changes, deny and ask rules are saved only when
  ticked. Without explicit indexes the API saves allow rules only, and a selected suggestion that switches to
  `bypassPermissions` is refused unless the bypass rule above allows it.
- When Claude Code reports rejected credentials, the gateway publishes a notice with the code `ENGINE_UNAVAILABLE` and
  sets that error on the session, so the operator sees the failure.
- Memory files. `PUT /api/sessions/:id/memory` (profile `standard` or higher, live session) saves only a `CLAUDE.md` or
  `CLAUDE.local.md` that the runtime lists as editable. The file must not be a symbolic link, and its real path must lie
  inside a workspace root or inside `$HOME/.claude`. Content is limited to 256 KiB. The write is atomic, a new file gets
  mode 0644, and a missing folder is created only under `$HOME/.claude`.
- Claude Code sign-in (`/api/account/login` and `/api/account/login/code`, profile `full`) runs in the runtime. The
  gateway passes the code to the runtime and keeps no copy of it. Only the runtime writes the credentials. Signing out
  is not offered. MCP server sign-in (`/api/sessions/:id/mcp/auth`, profile `standard`) is the runtime's OAuth flow, and
  the callback address is passed on the same way.

Browser hardening:

- A strict Content Security Policy allows scripts only from the application's own origin, with no inline script and no
  `eval`.
- Markdown is rendered only through the sanitizing renderer (marked with DOMPurify). Tool output and user text are set
  with `textContent`, never as HTML.

Process and environment isolation:

- The Web token and every `CAW_*` variable are removed from the environment of the Claude Code child process.
- Each live session is a separate Claude Code process. Idle sessions are closed, and the number of live processes is
  capped (`CAW_MAX_LIVE_SESSIONS`).
- Logs are structured and drop fields named `token`, `cookie`, `authorization`, `password`, `text`, `prompt`,
  `content` and `data`. Sign-in codes, OAuth state and MCP callback addresses are never logged, and the runtime's stderr
  is logged at debug level as a byte count only.
- The `settings` and `mcp` runtime views replace the values of `env` and `headers` objects, and the values of keys that
  look like secrets, with `[redacted]`. The `mcp` view also removes URL user names and passwords, replaces query and
  fragment values, and replaces secret-looking command arguments. The keys stay visible.

Service hardening (systemd user unit installed by `scripts/install-linux.sh`):

- `NoNewPrivileges=yes`, `UMask=0077`, `KillMode=control-group` (child processes stop with the service), and a restart
  policy that does not restart on configuration errors (exit status 2).
- The configuration file is created with mode 600 and its directory with mode 700.

## Hardening checklist

For a deployment that is reachable from the internet:

1. Serve the gateway only over HTTPS, through a tunnel, a VPN such as Tailscale, or a TLS reverse proxy. Never expose
   the gateway port directly. The proxy must forward the `Host` header unchanged.
2. Set `CAW_PUBLIC_ORIGIN` to the exact origin that users open in the browser.
3. Keep `CAW_HOST=127.0.0.1` (the default) so the process listens only on loopback.
4. Add an identity check in front of the gateway, such as Cloudflare Access or Tailscale ACLs, in addition to the token.
5. Keep the login token long and random. The installer generates 32 random bytes and keeps only their hash. To rotate
   it, run `scripts/install-linux.sh --rotate-token` in your own terminal, not through Claude Code. Every session ends
   with the restart, so sign in again. Treat every browser that may have seen the old token as compromised. If you
   choose your own token, use at least 32 random bytes: with only its hash on disk, a weak token can be guessed offline
   by anyone who reads the file.
6. Use `CAW_ACCESS_PROFILE=standard` or `read` unless you need session deletion, Claude Code sign-in, browser tools or
   the settings view from the browser.
7. Keep `CAW_TERMINAL=0` unless you need the terminal tab. The terminal is equivalent to a shell as the service user.
8. Keep `CAW_ALLOW_BYPASS=0`. Leave `CAW_CHROME` and `CAW_BROWSER_MCP_COMMAND` unset unless you use browser tools.
9. Limit `CAW_WORKSPACE_ROOTS` to project directories. Do not include `/`, your whole home directory, or directories
   that hold other secrets such as `~/.ssh`. The roots limit where sessions start and what the directory browser lists.
   They do not confine the agent, which is confined only by Claude Code's permissions.
10. Review a folder before you trust it. A trusted folder's hooks and MCP servers run as the service user. In the
    new-session dialog, untick "Trust this folder" for a folder you have not reviewed.
11. Set `CAW_TRUST_PROXY=1` only behind a proxy that sets the client address header itself, with the gateway reachable
    only through that proxy.
12. Run the service as a dedicated non-root user. Enable lingering only for that user (`loginctl enable-linger`).
13. Protect the configuration file (mode 600) and the backups of `~/.claude` and the state directory. Both contain
    sensitive data.
14. Update Node.js, `@anthropic-ai/claude-agent-sdk` and Claude Code together, then rerun `npm run seal` and the runtime
    validation.
15. Review the journal (`journalctl --user -u claude-official-web`) after deployments and after any unexpected
    behavior.
16. For any deployment shared with other people, use Anthropic API keys rather than a claude.ai login. See the usage
    section of the README.

## Known limitations

- The gateway has a single operator and no per-user accounts. Its audit trail is the journal plus Claude Code's own
  session transcripts.
- Permission prompts protect only what the operator reviews. An approved command runs with the service account's full
  authority.
- Prompt injection can steer model output through files, web pages and tool results. Review approvals carefully, and
  prefer `plan` or `default` modes for untrusted repositories.
- The hashed token keeps the token out of the configuration file, but it does not separate the agent from the gateway.
  Claude Code and the gateway run as the same user, so anything that can read the gateway's memory as that user can also
  sign in. The hash also does not protect a token you chose yourself from being guessed offline if it is weak.
- In the default hash mode, sessions end at every gateway restart. A re-run of the installer restarts a running service,
  so browsers sign in again after an update.
- The new-session notice ticks "Trust this folder" by default. Starting a session in an untrusted folder therefore
  trusts that folder unless the operator unticks the box. The interface has no control to revoke trust. The API accepts
  `trusted: false`, which removes only the gateway's record. Claude Code's own trust record in `~/.claude.json` stays
  until it is removed in a terminal, as the README explains.
- Session transcripts in `~/.claude` are stored as plain JSON Lines files.
- Redaction is by key name, and for MCP servers by URL and argument shape (in the `mcp` view, the capabilities answer
  and the MCP action answer). Other runtime views only lose URL passwords: hook commands, for example, are shown as
  configured, so a secret written inline in a hook command is visible to every profile that can open the hooks view.
- Browser tools (`CAW_BROWSER_MCP_COMMAND`) run the command the operator configured as the service user, with that
  user's files and network access. Pages a browser loads can steer the model. Claude in Chrome (`CAW_CHROME=1`) acts in
  the Chrome of the machine that runs the gateway, with that profile's sign-ins.
- The browser security model assumes a modern browser that enforces the Content Security Policy and SameSite cookies.
