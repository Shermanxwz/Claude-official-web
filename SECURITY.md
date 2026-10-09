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
- the configuration: access profile, whether `CAW_TERMINAL` or `CAW_ALLOW_BYPASS` was enabled, and how the gateway was
  exposed (loopback, tunnel, reverse proxy, Tailscale);
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

- **Remote unauthenticated access.** Every API except health, the login page and session probes requires the login
  cookie.
- **Cross-site request forgery and cross-site WebSocket hijacking.** Every non-GET request and the terminal upgrade must
  carry the exact configured Origin.
- **Malicious model output and repository content.** Markdown is sanitized, tool output is rendered as text, and no
  model-provided HTML or script runs in the browser. Model actions remain subject to Claude Code's permission system and
  to the operator's approvals.
- **Path traversal.** Every path used for workspaces, attachments, file search and directory browsing is resolved with
  `realpath` and must stay inside an allowed root.
- **Upload abuse.** Uploads have size limits, are written with mode 0600 under the workspace, and are removed after the
  retention period. Only files the gateway created are ever deleted.
- **Token theft.** The Web token is never logged, never placed in a URL, never passed to Claude Code and never returned
  by the API. The login cookie is HttpOnly and SameSite=Strict.
- **Credential access.** The gateway never reads `~/.claude/.credentials.json` or keychain entries, and never edits
  settings or history files directly.

Out of scope:

- Compromise of the host, the service account or the operator's machine.
- A malicious operator.
- Multi-user isolation. The gateway is not a multi-tenant service; every signed-in person has the operator's authority.
- Availability attacks by someone who already holds a valid login.
- The security of Anthropic's models, services and the Claude Code runtime. Report those to Anthropic.

## Implemented controls

Authentication and sessions:

- Token login issues an HMAC-signed session cookie that is HttpOnly and SameSite=Strict, and Secure when the public
  origin is HTTPS. Logout revokes the cookie server-side.
- Login attempts are rate limited: ten failed attempts per client address in ten minutes return `429 RATE_LIMITED` with
  a `Retry-After` header.
- `CAW_REQUIRE_AUTH=1` is the default. The production installer refuses to write a configuration that disables it.

Request integrity:

- Every non-GET request and the terminal WebSocket upgrade must carry an Origin equal to `CAW_PUBLIC_ORIGIN` (or to the
  request origin when that variable is unset). Anything else returns `403 ORIGIN_REJECTED`.
- JSON bodies are limited to 1 MiB; uploads have their own limits (`CAW_UPLOAD_MAX_BYTES`, `CAW_IMAGE_MAX_BYTES`).

Authorization:

- Three access profiles: `read` (viewing only), `standard` (everything except deleting sessions, the terminal and the
  `bypassPermissions` mode) and `full`. Deleting sessions requires `full`.
- The terminal is disabled unless `CAW_TERMINAL=1` and the profile is `full`.
- `bypassPermissions` is disabled unless `CAW_ALLOW_BYPASS=1` and the profile is `full`.

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
  `content` and `data`.

Service hardening (systemd user unit installed by `scripts/install-linux.sh`):

- `NoNewPrivileges=yes`, `UMask=0077`, `KillMode=control-group` (child processes stop with the service), and a restart
  policy that does not loop on configuration errors.
- The configuration file is created with mode 600 and its directory with mode 700.

## Hardening checklist

For a deployment that is reachable from the internet:

1. Serve the gateway only over HTTPS, through a tunnel, a VPN such as Tailscale, or a TLS reverse proxy. Never expose the
   gateway port directly.
2. Set `CAW_PUBLIC_ORIGIN` to the exact origin that users open in the browser.
3. Keep `CAW_HOST=127.0.0.1` (the default) so the process listens only on loopback.
4. Add an identity check in front of the gateway, such as Cloudflare Access or Tailscale ACLs, in addition to the token.
5. Keep the login token long and random (the installer generates 32 bytes). To rotate it, replace `CAW_TOKEN` in the
   configuration file and restart the service. Treat every browser that may have seen the old token as compromised.
6. Use `CAW_ACCESS_PROFILE=standard` or `read` unless you need session deletion from the browser.
7. Keep `CAW_TERMINAL=0` unless you need the terminal tab. The terminal is equivalent to a shell as the service user.
8. Keep `CAW_ALLOW_BYPASS=0`.
9. Limit `CAW_WORKSPACE_ROOTS` to project directories. Do not include `/`, your whole home directory, or directories that
   hold other secrets such as `~/.ssh`.
10. Run the service as a dedicated non-root user. Enable lingering only for that user (`loginctl enable-linger`).
11. Protect the configuration file (mode 600) and the backups of `~/.claude` and the state directory. Both contain
    sensitive data.
12. Update Node.js, `@anthropic-ai/claude-agent-sdk` and Claude Code together, then rerun `npm run seal` and the runtime
    validation.
13. Review the journal (`journalctl --user -u claude-official-web`) after deployments and after any unexpected
    behavior.
14. For any deployment shared with other people, use Anthropic API keys rather than a claude.ai login. See the usage
    section of the README.

## Known limitations

- The gateway has a single operator and no per-user accounts. Its audit trail is the journal plus Claude Code's own
  session transcripts.
- Permission prompts protect only what the operator reviews. An approved command runs with the service account's full
  authority.
- Prompt injection can steer model output through files, web pages and tool results. Review approvals carefully, and
  prefer `plan` or `default` modes for untrusted repositories.
- Session transcripts in `~/.claude` are stored as plain JSON Lines files.
- The browser security model assumes a modern browser that enforces the Content Security Policy and SameSite cookies.
