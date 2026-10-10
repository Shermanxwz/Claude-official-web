# Deployment guide (Linux server)

This guide runs claude-official-web on a Linux server that you control, as a dedicated non-root user, behind an HTTPS
entry point. Each step says what it changes. Replace `claude.example.com` with your own hostname throughout.

The gateway runs Claude Code on the server, so the server is where your projects, your Claude Code login and your
session history live. Use a host you trust with that.

## 1. Prerequisites

- A Linux distribution with systemd, including its user manager (`systemctl --user` must work for the service user).
- Node.js 22.12 or newer. Check with `node -v`. Install it by your usual method, for example nvm or your distribution's
  Node.js 22 packages.
- Git, or a copy of the repository.
- A Claude subscription or an Anthropic API key. Read the usage section of the README before you choose.
- A way to reach the server over HTTPS: a Cloudflare-managed domain, a Tailscale tailnet, or a domain with a TLS reverse
  proxy you operate. See step 8.
- Optional, for the terminal tab only: `build-essential` and `python3`, which node-pty needs to compile.

## 2. Create a dedicated user

Run as an administrator:

```bash
sudo adduser --disabled-password --gecos "" claude-web
```

This creates a user with no password login. Log in as that user over SSH (add your public key to
`/home/claude-web/.ssh/authorized_keys`) so that `systemctl --user` is available. Do the remaining steps as that user,
unless a step says otherwise.

## 3. Get the code

Clone the repository, or unpack a release archive, into `~/claude-official-web`, then change into it:

```bash
cd ~/claude-official-web
```

## 4. Check the code before you deploy it

Run the production seal. It needs the development dependencies and Chromium for the browser suite:

```bash
npm ci
npm run seal
```

The last line must start with `SEALED claude-official-web@`. If the server cannot run Chromium, run
`npm run seal -- --skip-e2e` instead. Its last line starts with `SEALED-WITHOUT-E2E`, which is weaker evidence. Read
[PRODUCTION_SEAL.md](PRODUCTION_SEAL.md) for what the seal proves.

## 5. Log in to Claude Code as the service user

The service runs as this user and uses this user's Claude Code login. Log in once, interactively:

```bash
claude
```

Inside Claude Code, run `/login`, complete the browser flow, then run `/exit`. Claude Code stores the login under the
user's home directory. The gateway never reads it.

You can sign in from the browser instead, after the service is running. Open **Settings → Account** and choose **Sign in
with Claude** (a subscription) or **Sign in with the Console** (an API account). That needs the `full` access profile,
which is the default. The gateway starts the same sign-in flow that `/login` uses, and Claude Code stores the login as
it does for `/login`.

Use the same Claude Code version as the SDK. The SDK bundles the Claude Code binary, and the installer reports that
binary's path and version at the end of installation. The gateway uses the bundled binary unless `CAW_CLAUDE_BIN` says
otherwise.

## 6. Install the service

Set the public origin, which is the exact address users type in the browser, and run the installer. Create the workspace
directory first, because the installer requires every entry in `CAW_WORKSPACE_ROOTS` to exist:

```bash
mkdir -p ~/projects
cd ~/claude-official-web
CAW_PUBLIC_ORIGIN=https://claude.example.com CAW_WORKSPACE_ROOTS="$HOME/projects" scripts/install-linux.sh
```

`CAW_WORKSPACE_ROOTS` lists the directories where sessions may start and where the directory browser looks. Prefer a
directory of projects over your whole home directory, which also holds `~/.ssh` and other credentials. The roots limit
sessions, not the agent: Claude Code's permission system decides what the agent may touch.

The installer:

- checks Node.js (22.12 or newer) and npm, and refuses to run as root (use `--allow-root` only if you understand why);
- checks the existing configuration before it installs anything. It refuses a file that sets both token settings, a
  plaintext token shorter than 16 characters, a malformed hash, `CAW_REQUIRE_AUTH=0` or `CAW_ENGINE=mock`, and it names
  the setting to fix;
- runs `npm ci --omit=dev` in the project directory;
- creates `~/.config/claude-official-web/env` (directory mode 700, file mode 600). If the file holds no login token, it
  generates a 32-byte token and stores only its SHA-256 hash, as `CAW_TOKEN_SHA256`;
- writes the defaults that the file does not set yet: `CAW_HOST`, `CAW_PORT`, `CAW_REQUIRE_AUTH`, `CAW_ENGINE`,
  `CAW_ACCESS_PROFILE`, `CAW_APP_NAME`, `CAW_WORKSPACE_ROOTS`, `CAW_STATE_DIR` and `CAW_TERMINAL`;
- applies the configuration overrides you passed in the environment: `CAW_PUBLIC_ORIGIN`, `CAW_PORT`, `CAW_HOST`,
  `CAW_WORKSPACE_ROOTS`, `CAW_TERMINAL`, `CAW_ACCESS_PROFILE`, `CAW_APP_NAME` and `CAW_CLAUDE_BIN`;
- sets `cleanupPeriodDays` to 3650 in the Claude Code settings file when that file does not set it, so conversations are
  kept for about ten years (`--keep-claude-retention` skips this; see [Long-term operation](#long-term-operation));
- installs `~/.config/systemd/user/claude-official-web.service`, enables it and starts it. A service that is already
  running is restarted so that the new configuration takes effect;
- waits for the health check and reports the local URL and the Claude Code runtime it found;
- enables lingering for the user when the system allows it, so that the service survives logout (step 7).

### The login token

A new installation prints the token once, in the installer output:

```text
Login token (shown once; save it now in a password manager):

  <token>
```

Save it at that moment. The configuration file keeps only the SHA-256 hash, so the token cannot be read back later.
Anyone who has the token can use the gateway. Run the installer in your own terminal, not through Claude Code, so that
the printed token is not written to a session transcript.

Options:

- `--plain-token` stores a newly issued token as `CAW_TOKEN` in plaintext. Choose it only if the file must be able to
  reveal the token. With a plaintext token, `--show-token` prints the stored value again.
- `--show-token` prints a token issued by this run, or the stored plaintext token. A stored hash cannot be shown.
- `--rotate-token` issues a new token. See "Rotate the token" below.

Re-running the installer is safe. It keeps the configuration values you set, keeps the existing token, and updates the
dependencies and the unit. It restarts a running service, and in the default hash mode that ends every browser session,
because the session secret exists only in memory. Sign in again afterwards. With a plaintext `CAW_TOKEN`, sessions
survive the restart.

Useful service commands:

```bash
systemctl --user status claude-official-web
systemctl --user restart claude-official-web     # after editing the configuration file
journalctl --user -u claude-official-web -f      # follow the logs
```

### Rotate the token

Rotate the token when you have lost it, or when someone who should not have it may have seen it:

```bash
cd ~/claude-official-web
scripts/install-linux.sh --rotate-token
```

The installer issues a new token, stores its hash (or the plaintext with `--plain-token`), restarts the service and
prints the new token once. Every browser session ends with the restart, so sign in again with the new token. Treat every
browser that might have seen the old token as compromised.

Rotation also replaces the stored token settings, so it repairs a file that sets both `CAW_TOKEN` and `CAW_TOKEN_SHA256`
or holds a malformed hash. A plaintext installation becomes a hashed one the same way. Run it in your own terminal, as
described above.

### Optional settings

The configuration file holds every setting that the README's configuration table describes. These are the ones that
matter on a server:

- `CAW_ALLOW_BYPASS` (default `0`). Keep it at `0` unless you need the `bypassPermissions` mode, which runs without
  permission prompts. The switch needs `CAW_ACCESS_PROFILE=full`, and the gateway refuses to start with the switch under
  `read` or `standard`. `CAW_DEFAULT_PERMISSION_MODE=bypassPermissions` needs the switch too. Set it only on a host
  where you accept that every action runs without a prompt.
- `CAW_DEFAULT_PERMISSION_MODE` (unset by default). Unset, new sessions take the permission mode from Claude Code's own
  settings, as they do in the terminal. Set it only to override those settings.
- `CAW_FALLBACK_MODEL`. The model that a refused answer can be retried on (`--fallback-model`). Choose a model that your
  account can use.
- `CAW_DEFAULT_MODEL` and `CAW_DEFAULT_EFFORT`. The defaults for new sessions. Leave them unset to keep Claude Code's
  own defaults.
- `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`. A value other than `0` or `false` turns background tasks off for Claude Code,
  and the gateway then offers no "Run in background" action.

Restart the service after you change any of them.

### Unattended mode

To let sessions run without any approval (see the README's "Unattended mode"), add this line to
`~/.config/claude-official-web/env` and restart the service:

```bash
CAW_UNATTENDED=1
```

It needs `CAW_ACCESS_PROFILE=full` (the default). The switch in Settings → Permissions can turn it off and on again;
the last choice is saved in the state directory and wins over the variable after that. To make the switch available
but off by default, set `CAW_ALLOW_BYPASS=1` instead.

Claude Code refuses bypass mode when it runs as root, and the gateway then refuses to start with these settings. The
service user created in step 2 is not root, so this applies only to a gateway that you run as root yourself. On a
machine that is a dedicated sandbox, `IS_SANDBOX=1` in the same file lifts the restriction; anywhere else, run the
gateway as its own user. Give that user only the folders and credentials the agent should have, and keep the projects
in git, because nothing is reviewed before it runs.

### Browser tools on a headless server

A server without a display cannot run Claude in Chrome, so use a browser MCP server instead. The gateway starts that
server on the host. A session uses it only when a user with the `full` profile turns on **Browser tools** in the session
settings.

1. Install a Chromium for the service user, which the MCP server starts, for example with `npx playwright install
   chromium`. Alternatively, point the command at an existing Chrome or Chromium with `--executable-path <path>`.
2. Check that the service can run `npx`. The unit's `PATH` includes the Node.js bin directory that the installer found,
   so run the installer again after you change the Node.js installation (see step 10).
3. Pin the version of the MCP server. The example below uses `@playwright/mcp@0.0.82`, the version whose flags this
   guide was checked against. For another version, run `npx -y @playwright/mcp@<version> --help` and confirm that
   `--headless`, `--isolated` and `--executable-path` are still listed.
4. Set the command in the configuration file. Single quotes keep the double quotes of the JSON array:

   ```bash
   CAW_BROWSER_MCP_COMMAND='["npx","-y","@playwright/mcp@0.0.82","--headless","--isolated"]'
   ```

   Then run `systemctl --user restart claude-official-web`.

5. Open a session, turn on **Browser tools** in its settings, and check that the MCP panel shows the `browser` server as
   connected.

`--headless` runs the browser without a display. `--isolated` keeps the browser profile in memory, so no sign-in or
cookie outlives the session. If Chromium does not start, check the host's sandbox support first. `--no-sandbox` exists,
but it weakens the browser's isolation, so use it only as a last resort.

Browser tools act with the service user's network access and files, and what a web page says can steer the model. Read
[SECURITY.md](../SECURITY.md) before you turn them on.

### Claude in Chrome on a desktop host

Claude in Chrome drives a Chrome browser on the same machine as the gateway. It suits a desktop where you run the
gateway, and it does not work on a headless server.

1. Sign Claude Code in with a claude.ai account, because Claude in Chrome does not work with a Console-only login. In
   **Settings → Account**, choose **Sign in with Claude**. That needs the `full` profile.
2. Install the Claude in Chrome extension in the Chrome profile that runs on this machine.
3. Set `CAW_CHROME=1` in the configuration file, then run `systemctl --user restart claude-official-web`. Each query
   then starts with `--chrome`.
4. Open the **Claude in Chrome** tab in the runtime panels. It shows whether Claude in Chrome is allowed, installed and
   connected, and it has links to install the extension and to reconnect it. Choosing among several Chrome browsers is
   done with `/chrome` in the terminal tab.

## 7. Keep the service running after you log out

By default systemd stops a user's services when that user logs out. Enable lingering once:

```bash
loginctl enable-linger "$USER"
```

The installer tries this command for you. If your system refuses it, the installer prints the same command with `sudo`
to run once.

## 8. Expose the gateway over HTTPS

Expose only HTTPS. Never publish the gateway port (4180 by default) directly to the internet. Choose one option.

### Option A: Cloudflare Tunnel with Cloudflare Access (recommended for a public hostname)

Cloudflare Access puts an identity check in front of the gateway. The gateway's token remains the second factor.

1. Install `cloudflared` by following Cloudflare's instructions for your distribution.
2. Authenticate and create a tunnel, then point the hostname at it:

   ```bash
   cloudflared tunnel login
   cloudflared tunnel create claude-web
   cloudflared tunnel route dns claude-web claude.example.com
   ```

3. Create `~/.cloudflared/config.yml`. Replace the tunnel ID and the hostname:

   ```yaml
   tunnel: <TUNNEL-UUID>
   credentials-file: /home/claude-web/.cloudflared/<TUNNEL-UUID>.json
   ingress:
     - hostname: claude.example.com
       service: http://127.0.0.1:4180
     - service: http_status:404
   ```

4. Run the tunnel as a service. Cloudflare's documentation describes `cloudflared service install`, which needs
   administrator rights, and running `cloudflared tunnel run claude-web` under systemd.
5. In the Cloudflare dashboard, create a self-hosted Access application for `claude.example.com` with an Allow policy
   for the people who should reach it.
6. Add the line `CAW_TRUST_PROXY=1` to `~/.config/claude-official-web/env`, then restart the service. Cloudflare sets
   `CF-Connecting-IP` at its edge, and the gateway reads that header first, so each visitor counts separately. This is
   safe because the gateway listens on `127.0.0.1`, so the tunnel is the only network route to it.

### Option B: Tailscale (private to your tailnet)

Tailscale serves the gateway over HTTPS to devices on your tailnet only. It does not expose the gateway to the internet.

1. Install and sign in to Tailscale on the server.
2. Find the server's MagicDNS name with `tailscale status`. It has the form `host.tailnet-name.ts.net`.
3. Publish the gateway in the background:

   ```bash
   tailscale serve --bg --https=443 127.0.0.1:4180
   tailscale serve status
   ```

   If Tailscale reports a permission error, let your user manage Tailscale once with
   `sudo tailscale set --operator=$USER`, then run the commands again.

4. Set the public origin to the HTTPS name and apply it:

   ```bash
   cd ~/claude-official-web
   CAW_PUBLIC_ORIGIN=https://host.tailnet-name.ts.net scripts/install-linux.sh
   ```

   Re-running the installer updates `CAW_PUBLIC_ORIGIN` in the configuration file and restarts the service, which ends
   browser sessions in the default hash mode. Leave `CAW_TRUST_PROXY` at `0` unless you have checked which
   client-address headers `tailscale serve` sends.

### Option C: A TLS reverse proxy that you operate

Use this when you have a domain and a certificate and want to terminate TLS yourself.

**Caddy** obtains certificates automatically. `flush_interval -1` disables response buffering, which the event stream
needs. Caddy forwards the `Host` header unchanged:

```caddyfile
claude.example.com {
    reverse_proxy 127.0.0.1:4180 {
        flush_interval -1
    }
}
```

If you set `CAW_TRUST_PROXY=1`, add `header_up X-Real-IP {http.request.remote.host}` inside the `reverse_proxy` block.
Caddy does not set `X-Real-IP` itself, and this line replaces any `X-Real-IP` value that a visitor sent.

**nginx** needs these settings for the gateway: `Host` is forwarded unchanged, buffering is off and the timeouts are
long for the event stream, and the upgrade headers are passed for the terminal WebSocket.

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl http2;
    server_name claude.example.com;
    ssl_certificate     /etc/letsencrypt/live/claude.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/claude.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:4180;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

The certificate paths shown are the Let's Encrypt defaults. Use your own paths if they differ. The `X-Forwarded-For` and
`X-Real-IP` lines overwrite whatever a visitor sent, and the gateway reads them only when `CAW_TRUST_PROXY=1`.

### Proxies, the Host header and client addresses

Whichever option you choose, the browser's address bar must match `CAW_PUBLIC_ORIGIN` exactly, including the scheme and
the absence of a trailing slash. Otherwise every write fails with `ORIGIN_REJECTED`.

The gateway also accepts a request only when its `Host` header is `CAW_PUBLIC_ORIGIN`'s host or a loopback name. The
proxy must therefore forward `Host` unchanged. Otherwise the gateway answers `421 HOST_REJECTED`. `npm run
smoke:gateway` checks `/healthz` through the public URL, so it shows this problem.

With a reverse proxy or tunnel on the same host, the gateway sees the proxy as the client. Without `CAW_TRUST_PROXY=1`,
every visitor shares one client address. The login limit (ten failures in ten minutes) and the stream limit (16 per
client) then apply to all visitors together, so ten wrong tokens from anyone block sign-in for everyone for ten minutes.

Set `CAW_TRUST_PROXY=1` only when the proxy sets the client address header itself and the gateway is reachable only
through that proxy. The gateway reads `CF-Connecting-IP`, then `X-Real-IP`, then the last `X-Forwarded-For` entry, and
it ignores the first `X-Forwarded-For` entry, which the visitor sends. Otherwise a visitor can choose its own address.
The installer does not set `CAW_TRUST_PROXY`; add the line to the configuration file and restart the service.

## 9. Verify the deployment

Enter the token at the prompt. It is not echoed, and it does not appear on the command line or in your shell history:

```bash
cd ~/claude-official-web
export CAW_GATEWAY_URL=https://claude.example.com
read -r -s -p "Login token: " CAW_GATEWAY_TOKEN && echo
export CAW_GATEWAY_TOKEN
npm run smoke:gateway
unset CAW_GATEWAY_TOKEN
```

Use the token you saved when the installer printed it, or the one from `--rotate-token`. The configuration file holds
only the hash by default, so it cannot supply the token.

The gateway check ends with `GATEWAY_VALIDATED`. It creates no sessions and runs no model turns. It also requests
`/healthz` through the public URL, so a proxy that rewrites the `Host` header fails here.

Then run the runtime check on the server itself, where Claude Code is logged in:

```bash
npm run smoke:runtime
npm run smoke:runtime -- --with-tools
```

The first command sends one real turn and checks the reply and the transcript. The second also asks for a file write,
approves it through the request API and checks the file. Both use model usage on your login. They end with
`RUNTIME_VALIDATED`. If they report that Claude Code is not logged in, complete step 5 and try again.

## 10. Update

```bash
cd ~/claude-official-web
git pull                       # or unpack the new release archive over the old one
npm ci                         # refresh the development dependencies for the seal
npm run seal
scripts/install-linux.sh       # refresh dependencies, the unit and the configuration defaults; restarts the service
npm run smoke:runtime
npm run smoke:gateway          # with the variables from step 9
```

The installer restarts the service. In the default hash mode every browser session ends at that restart, so sign in
again afterwards.

Keep Node.js, `@anthropic-ai/claude-agent-sdk` and the Claude Code binary aligned. The lock file pins the SDK, and the
SDK bundles the matching runtime. If you also install a separate `claude` command, update it at the same time. Compare
`claudeCodeVersion` in `GET /api/meta` with `claude --version` after an update.

If you change the Node.js installation path (for example by switching nvm versions), run the installer again so that the
service uses the new path.

## 11. Back up

Back up these locations regularly, and encrypt the backups. They hold sensitive data:

- `~/.claude`: session transcripts, settings, and the Claude Code login.
- `~/.local/state/claude-official-web`: gateway state. It holds the session revocations, the list of trusted folders and
  the folders that the gateway uses for its own runtime queries (the sign-in query and the trust check).
- `~/.config/claude-official-web/env`: the configuration. It holds the hash of the login token, or the token itself if
  you installed with `--plain-token`.

Do not keep backups of the configuration file in an unencrypted place.

## 12. Uninstall

Stop and remove the service but keep the configuration file (and the token hash, or the plaintext token):

```bash
scripts/install-linux.sh --uninstall
```

Remove the configuration file as well:

```bash
scripts/install-linux.sh --uninstall --purge
```

`--purge` removes the token setting along with the file, whether it is a hash or a plaintext token. A new installation
then issues a new token.

Uninstalling never deletes conversations in `~/.claude` or the state directory. Delete those yourself if you no longer
need them. To stop lingering, run `loginctl disable-linger "$USER"`.

## Long-term operation

The service is built to run for years with little attention. This section says what runs by itself, what eventually
needs a person and how to notice it, and how to upgrade the runtime.

### What runs by itself

- **Exact pins.** `package.json` pins `@anthropic-ai/claude-agent-sdk` to one version, with no range, and the lock file
  pins every other dependency. Installing or restarting the service never picks up a newer SDK.
- **No self-updates.** The gateway sets `DISABLE_AUTOUPDATER=1` for Claude Code unless you set that variable
  yourself, so the runtime never replaces itself with a version that nobody has checked.
- **Restarts after crashes.** systemd restarts the service five seconds after each exit, however often it crashes, and
  no start limit ever stops it. The one exception is a configuration error (exit status 2): another start cannot fix it,
  so systemd stops, and the log shows the reason.
- **Start at boot.** With lingering enabled (step 7), the service starts at boot and keeps running after you log out.
- **Bounded state.** Once an hour the gateway deletes uploads older than `CAW_UPLOAD_RETENTION_DAYS` (7 by
  default). Every minute it closes sessions that have been idle for `CAW_IDLE_TIMEOUT_MS` (30 minutes by default). A
  session that is running or waiting for an answer is never closed.
- **Conversation retention.** When the Claude Code settings file (`~/.claude/settings.json`, or
  `$CLAUDE_CONFIG_DIR/settings.json` when that is set) does not set `cleanupPeriodDays`, the installer sets it to 3650.
  Claude Code then keeps transcripts for about ten years instead of deleting them after 30 days. An existing value is
  never changed, and `--keep-claude-retention` leaves the file alone.

### What eventually needs a person

Each item says what you will see, and what to do about it.

- **The runtime is older than Anthropic accepts.** Sessions cannot start. The timeline shows "This Claude Code
  version is older than Anthropic now accepts. Upgrade claude web on the server with npm run upgrade:runtime, then
  restart it." The status badge in the header shows the same text on hover. Run the upgrade below.
- **The sign-in has expired or was revoked.** The timeline shows "The sign-in has expired or was revoked. Sign in again
  in Settings → Account." Open Settings → Account in the web UI and sign in again.
- **Node.js 22 reaches end of life on 2027-04-30.** Install Node.js 24, which CI already tests, and then run
  `scripts/install-linux.sh` again. The installer writes the new Node.js path into the unit and installs the
  dependencies for it. Then check the service as in step 9.
- **Journal size.** The service logs to the journal. By default journald keeps up to 10% of the file system (at most
  4 GB) for the whole journal, not only for this service. To keep less, set it in `/etc/systemd/journald.conf`, for
  example `SystemMaxUse=500M` under `[Journal]`, then run `sudo systemctl restart systemd-journald`. Read the service
  log with `journalctl --user -u claude-official-web -n 100 --no-pager`.
- **TLS certificates.** Caddy obtains and renews its certificates by itself. With nginx and Let's Encrypt, the certbot
  timer renews them. Check that the timer is active, and that nginx reloads after each renewal. A deploy hook that runs
  `systemctl reload nginx` does this.

### Upgrading the runtime

1. Run `npm run upgrade:runtime` in the repository. It installs the newest Claude Agent SDK, which bundles Claude Code,
   and checks the runtime contract, the source manifest and the seal. To choose a version, pass it:
   `npm run upgrade:runtime -- <version>`. If a check fails, the message names it.
2. Restart the service with `systemctl --user restart claude-official-web`. In the default hash mode every browser
   session ends at the restart, so sign in again afterwards.
3. Commit the three files the upgrade changed (`package.json`, `package-lock.json`, `SOURCE_MANIFEST.sha256`) and push
   them, so that the next `git pull` (section 10) does not conflict and other installs can update the same way.
4. Optionally run `npm run smoke:runtime`. It runs a real turn with the installed runtime and checks that Claude Code is
   still signed in for this user.

The weekly CI canary (`.github/workflows/ci.yml`) runs the same contract, the type check and the tests against the
newest SDK without changing the pin. A green canary means the upgrade is expected to pass; GitHub emails you when it
fails.

Section 10 explains how to compare the versions after an update.

## Troubleshooting

See the troubleshooting section of the README for the common error codes and fixes.
