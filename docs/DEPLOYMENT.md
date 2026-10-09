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
  proxy you operate. See step 7.
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

Use the same Claude Code version as the SDK. The SDK bundles the Claude Code binary, and the installer reports that
binary's path and version at the end of installation. The gateway uses the bundled binary unless `CAW_CLAUDE_BIN` says
otherwise.

## 6. Install the service

Set the public origin, which is the exact address users type in the browser, and run the installer:

```bash
cd ~/claude-official-web
CAW_PUBLIC_ORIGIN=https://claude.example.com scripts/install-linux.sh
```

The installer:

- checks Node.js (22.12 or newer) and npm, and refuses to run as root (use `--allow-root` only if you understand why);
- runs `npm ci --omit=dev` in the project directory;
- creates `~/.config/claude-official-web/env` (directory mode 700, file mode 600) and generates a 32-byte login token
  there if none exists;
- applies the configuration overrides you passed in the environment: `CAW_PUBLIC_ORIGIN`, `CAW_PORT`, `CAW_HOST`,
  `CAW_WORKSPACE_ROOTS`, `CAW_TERMINAL`, `CAW_ACCESS_PROFILE`, `CAW_APP_NAME` and `CAW_CLAUDE_BIN`;
- installs `~/.config/systemd/user/claude-official-web.service`, enables it and starts it;
- waits for the health check and reports the local URL and the Claude Code runtime it found.

The token is not printed. It is in the configuration file. To print it once, add `--show-token`, and store it in a
password manager before you clear the terminal. Anyone with the token can use the gateway.

Re-running the installer is safe. It keeps existing configuration values and the existing token, and updates the unit
and dependencies.

Useful service commands:

```bash
systemctl --user status claude-official-web
systemctl --user restart claude-official-web     # after editing the configuration file
journalctl --user -u claude-official-web -f      # follow the logs
```

## 7. Keep the service running after you log out

By default systemd stops a user's services when that user logs out. Enable lingering once:

```bash
loginctl enable-linger "$USER"
```

Your system may ask for administrator authorization for this command. The installer prints the same advice if lingering
is not enabled.

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
5. In the Cloudflare dashboard, create a self-hosted Access application for `claude.example.com` with an Allow policy for
   the people who should reach it.

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

   Re-running the installer updates `CAW_PUBLIC_ORIGIN` in the configuration file and restarts the service.

### Option C: A TLS reverse proxy that you operate

Use this when you have a domain and a certificate and want to terminate TLS yourself.

**Caddy** obtains certificates automatically. `flush_interval -1` disables response buffering, which the event stream
needs:

```caddyfile
claude.example.com {
    reverse_proxy 127.0.0.1:4180 {
        flush_interval -1
    }
}
```

**nginx** needs three settings for the gateway: buffering is off and the timeouts are long for the event stream, and the
upgrade headers are passed for the terminal WebSocket.

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
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

The certificate paths shown are the Let's Encrypt defaults. Use your own paths if they differ.

With a reverse proxy on the same host, the gateway sees the proxy's address as the client. Set `CAW_TRUST_PROXY=1` only
when the proxy overwrites `X-Forwarded-For` with the real client address, so that login rate limiting stays per client.
The installer does not set it.

Whatever option you choose, the browser's address bar must match `CAW_PUBLIC_ORIGIN` exactly, including the scheme and
the absence of a trailing slash. Otherwise every write fails with `ORIGIN_REJECTED`.

## 9. Verify the deployment

Read the token from the configuration file into the environment without printing it, then run the gateway check:

```bash
export CAW_GATEWAY_URL=https://claude.example.com
export CAW_GATEWAY_TOKEN="$(sed -n 's/^CAW_TOKEN="\(.*\)"$/\1/p' ~/.config/claude-official-web/env)"
npm run smoke:gateway
unset CAW_GATEWAY_TOKEN
```

The gateway check ends with `GATEWAY_VALIDATED`. It creates no sessions and runs no model turns.

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
scripts/install-linux.sh       # refresh dependencies, the unit and the configuration defaults
npm run smoke:runtime
npm run smoke:gateway          # with the variables from step 9
```

Keep Node.js, `@anthropic-ai/claude-agent-sdk` and the Claude Code binary aligned. The lock file pins the SDK, and the
SDK bundles the matching runtime. If you also install a separate `claude` command, update it at the same time. Compare
`claudeCodeVersion` in `GET /api/meta` with `claude --version` after an update.

If you change the Node.js installation path (for example by switching nvm versions), run the installer again so that the
service uses the new path.

## 11. Back up

Back up these locations regularly, and encrypt the backups. They hold sensitive data:

- `~/.claude`: session transcripts, settings, and the Claude Code login.
- `~/.local/state/claude-official-web`: gateway state.
- `~/.config/claude-official-web/env`: the login token.

Do not keep backups of the configuration file in an unencrypted place.

## 12. Uninstall

Stop and remove the service but keep the configuration file (and the token):

```bash
scripts/install-linux.sh --uninstall
```

Remove the configuration file as well:

```bash
scripts/install-linux.sh --uninstall --purge
```

Uninstalling never deletes conversations in `~/.claude` or the state directory. Delete those yourself if you no longer
need them. To stop lingering, run `loginctl disable-linger "$USER"`.

## Troubleshooting

See the troubleshooting section of the README for the common error codes and fixes.
