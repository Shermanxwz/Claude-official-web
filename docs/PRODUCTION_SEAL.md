# Production seal

The production seal is a set of mechanical gates that a release must pass. Two evidence levels exist. The seal proves
the source tree is what the reviewed manifest describes and that every gate passes on it. Real-engine validation runs
separately on the deployment host.

## 1. `npm run seal`

The seal runs these gates in order and stops at the first failure:

| Step | Command | What it proves |
|---|---|---|
| 1 | `manifest:verify` | Every covered file matches `SOURCE_MANIFEST.sha256`. No file changed without the manifest being regenerated and reviewed. |
| 2 | `check` | Static rules hold across the tree: no `TODO`, `FIXME` or `XXX` markers; no `console.*` in `src/`; every backend module starts with `// @ts-check`; no `eval`, `new Function`, `shell: true` or shell-based `exec` in `src/`; no `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write` in browser code; no inline scripts or inline event handlers in HTML; LF line endings, no trailing whitespace, no tab indentation and a final newline; valid JSON; every module passes `node --check`; relative imports resolve; no file over 300 KiB; no symbolic links. |
| 3 | `typecheck` | `tsc -p jsconfig.json` passes with JSDoc types checked, including the scripts. |
| 4 | `test` | Unit and integration tests pass with no network access, temporary directories and random ports. Integration tests use the mock engine. |
| 5 | `test:e2e` | The 30 browser tests pass in Chromium, driving the real interface against the mock engine. |

The seal uses the deterministic mock engine. It proves the gateway, the wire protocol, the access rules and the browser
interface behave as specified. It does not prove that a real model answers correctly, and it does not prove that Claude
Code is logged in on the host. Those are the runtime checks in section 3.

### The receipt

On success the seal writes `.state/seal-receipt.json` (the directory is git-ignored) and prints the final line:

```text
SEALED claude-official-web@<version> <sha256 of SOURCE_MANIFEST.sha256>
```

The receipt records:

- `version`: the package version;
- `manifestSha256`: the SHA-256 of the manifest file that the run verified;
- `node`, `platform`: the Node.js version and `platform-arch` of the machine;
- `mode`: `full`, or `without-e2e` when `--skip-e2e` was used;
- `steps`: each executed step with its duration in milliseconds;
- `at`: the completion time, in ISO 8601 format.

A receipt always describes the run that wrote it. The seal removes the previous receipt before it starts, so a failed run
leaves no receipt behind.

### `--skip-e2e`

Use `npm run seal -- --skip-e2e` only where Chromium cannot run. The seal then prints a warning and ends with
`SEALED-WITHOUT-E2E`, and the receipt says `"mode": "without-e2e"`. That receipt is not a production gate. Run the full
seal on a machine with Chromium (for example, the CI workflow) before a release.

## 2. Manifest

`npm run manifest` writes `SOURCE_MANIFEST.sha256`. It lists one `<sha256>  <path>` line for every file under `src`,
`public`, `scripts`, `test` (except `test/e2e/artifacts`), `docs`, `deploy` and `.github`, plus the root documentation,
configuration and license files. Symbolic links are refused. `npm run manifest:verify` recomputes the digests and reports
each added, removed or changed path. It exits with status 1 on any difference, including a formatting-only difference.

Regenerate the manifest after every change, as the last step before a seal. A stale manifest fails step 1 on purpose.

## 3. Real-engine validation on the deployment host

### `npm run smoke:runtime`

Prerequisite: Claude Code is logged in as the user who runs the command (`claude`, then `/login`).

The command starts the gateway on a random loopback port with the real SDK engine, a temporary workspace and a temporary
state directory. It then:

1. logs in with a random token and creates a session in the workspace;
2. opens the event stream for that session;
3. sends a prompt asking the model to reply with a unique marker, and waits up to 180 seconds for the turn result;
4. checks that the assistant's reply contains the marker, that the transcript on disk lists the prompt and the reply,
   and that the capabilities list models and slash commands;
5. with `--with-tools`, asks the model to write a file with the marker using the Write tool, approves that request through
   the request API, and checks the file;
6. closes and deletes the session, stops the gateway and removes the temporary directories.

It prints a JSON receipt with the SDK version and the Claude Code version reported by `/api/meta`, and the duration of each
stage, followed by `RUNTIME_VALIDATED`. Failures print one actionable line. For example, an unavailable engine prints the
instruction to log in with `claude` and `/login`.

The command ignores `CAW_*` variables in the calling shell, except `CAW_CLAUDE_BIN`, so its result does not depend on
local gateway settings. Session transcripts are removed with the session. Empty project folders that Claude Code created
for the temporary workspace may remain.

This command uses model usage on the account you are logged in with.

### `npm run smoke:gateway`

Validates a deployed gateway over the network. It needs `CAW_GATEWAY_URL` and `CAW_GATEWAY_TOKEN`, and optionally
`CAW_GATEWAY_ORIGIN`. The token is the one you saved when the installer printed it, or the one from `--rotate-token`. The
configuration file holds only its hash by default, so enter the token at the prompt shown in the deployment guide rather
than on the command line. It checks:

- `/healthz` responds through the public URL, so a proxy that rewrites the `Host` header fails here with 421;
- the unauthenticated session probe reports that authentication is required;
- login sets the session cookie with HttpOnly, SameSite=Strict and, over HTTPS, Secure;
- a write with a foreign Origin is rejected with `ORIGIN_REJECTED`;
- the authenticated meta reports the `sdk` engine;
- the event stream sends `hello` within 10 seconds and `heartbeat` within 20 seconds;
- logout revokes the session, and `/api/meta` then returns `UNAUTHENTICATED`.

It creates no sessions and runs no model turns, so it is safe to run against a live gateway. It never prints the token or
the cookie. It ends with `GATEWAY_VALIDATED`.

## 4. What CI cannot prove

The CI workflow runs the seal (steps 1 to 5) on a clean checkout of every push, pull request and weekly schedule. CI
cannot prove:

- that a real model turn completes, because CI has no account and no credentials;
- that Claude Code is logged in on a particular host;
- the deployed configuration: the TLS certificate, the tunnel or proxy, Cloudflare Access or Tailscale rules, and the
  `CAW_PUBLIC_ORIGIN` value;
- that the proxy forwards the `Host` header unchanged and, with `CAW_TRUST_PROXY=1`, sets the client address header itself;
- that node-pty compiles on the target host;
- that systemd user services and lingering behave as expected on the target host;
- the usage limits and billing of the account in use.

Those are covered by `smoke:runtime`, `smoke:gateway` and the deployment steps in [DEPLOYMENT.md](DEPLOYMENT.md).

## 5. Release checklist

1. Make sure the working tree contains only the intended changes, and that `CHANGELOG.md` describes them.
2. Update `version` in `package.json` if the release changes it, and make the matching entry in `CHANGELOG.md`.
3. Run `npm ci`. If the interface changed, run `npm run screenshots` and review the three PNG files in `docs/screenshots/`
   (section 6). Then run `npm run manifest`, then `npm run seal`. Keep the `SEALED` line and the receipt with the release
   record.
4. Confirm that the CI workflow passes on the release commit.
5. On the deployment host, update the code, run `scripts/install-linux.sh`, then `npm run smoke:runtime -- --with-tools` and
   `npm run smoke:gateway`. Keep the `RUNTIME_VALIDATED` and `GATEWAY_VALIDATED` output with the release record.
6. Tag the commit with the version number, and publish the release notes from `CHANGELOG.md`.

## 6. Screenshots (not a gate)

`npm run screenshots` renders the desktop light, desktop dark and phone screenshots that the README shows. It uses the
mock engine with login off, on a demo workspace in the system temporary directory. It needs Chromium
(`npx playwright-core install chromium`) and writes the images to `docs/screenshots/`.

The screenshots are not a gate. Review them by eye before a release, because a rendering change is visible to users but
changes no protocol or access rule. The images are part of the source manifest, so run `npm run manifest` after they
change, and before the seal.
