#!/usr/bin/env bash
#
# Installs claude-official-web as a systemd user service on Linux.
#
#   scripts/install-linux.sh [--allow-root] [--show-token]   install, or update an existing installation
#   scripts/install-linux.sh --uninstall [--purge]           stop and remove the service
#   scripts/install-linux.sh --help
#
# Re-running is safe: dependencies are reinstalled, the unit is rendered again, and the existing configuration and login
# token are kept. Only the configuration overrides listed in --help are written to the configuration file.
set -euo pipefail
umask 077

readonly APP="claude-official-web"
readonly UNIT_NAME="${APP}.service"
readonly CONFIG_DIR="${HOME}/.config/${APP}"
readonly ENV_FILE="${CONFIG_DIR}/env"
readonly STATE_DIR="${HOME}/.local/state/${APP}"
readonly UNIT_DIR="${HOME}/.config/systemd/user"
readonly UNIT_FILE="${UNIT_DIR}/${UNIT_NAME}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly ROOT
readonly TEMPLATE="${ROOT}/deploy/${UNIT_NAME}"

ALLOW_ROOT=0
SHOW_TOKEN=0
UNINSTALL=0
PURGE=0
NODE_BIN=""
NODE_BIN_DIR=""
TOKEN=""
GENERATED_TOKEN=0
UNIT_TMP=""
LOCAL_URL=""
OVERRIDES=()

say() {
  printf '%s\n' "$*"
}

warn() {
  printf 'warning: %s\n' "$*" >&2
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<EOF
Usage:
  scripts/install-linux.sh [--allow-root] [--show-token]   install, or update an existing installation
  scripts/install-linux.sh --uninstall [--purge]           stop and remove the service
  scripts/install-linux.sh --help

Options:
  --allow-root   permit running as root (the service still runs as the invoking user, which is not recommended)
  --show-token   print the login token once after installation. The token is never printed otherwise.
  --uninstall    stop, disable and remove the unit. The configuration file and its token are kept.
  --purge        with --uninstall, also remove the configuration file and its token

Configuration overrides, written to ${ENV_FILE} when set in the environment:
  CAW_PUBLIC_ORIGIN  CAW_PORT  CAW_HOST  CAW_WORKSPACE_ROOTS  CAW_TERMINAL
  CAW_ACCESS_PROFILE  CAW_APP_NAME  CAW_CLAUDE_BIN

Example:
  CAW_PUBLIC_ORIGIN=https://claude.example.com CAW_WORKSPACE_ROOTS="\$HOME/projects" scripts/install-linux.sh
EOF
}

# systemd substitutes unit values without a shell, so paths that would need escaping are refused instead.
require_unit_safe_path() {
  local label="$1" value="$2"
  case "$value" in
    /*) ;;
    *) die "${label} must be an absolute path: ${value}" ;;
  esac
  case "$value" in
    *[[:space:]]* | *[[:cntrl:]]* | *\"* | *\\* | *%*)
      die "${label} contains characters the systemd unit cannot express (spaces, quotes, backslashes, percent signs or control characters): ${value}" ;;
  esac
}

is_canonical_origin() {
  "$NODE_BIN" -e '
    let url;
    try { url = new URL(process.argv[1]); } catch { process.exit(1); }
    const ok = url.origin === process.argv[1] && ["http:", "https:"].includes(url.protocol)
      && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
    process.exit(ok ? 0 : 1);
  ' "$1"
}

# Prints the unquoted value of NAME from the configuration file (the last assignment wins).
env_value() {
  local name="$1" line
  line="$(grep -E "^${name}=" "$ENV_FILE" | tail -n 1 || true)"
  line="${line#"${name}="}"
  line="${line#\"}"
  line="${line%\"}"
  printf '%s' "$line"
}

quote_env() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

# Replaces every assignment of NAME, or appends one when it is absent.
set_env() {
  local name="$1" value="$2" tmp
  tmp="$(mktemp "${CONFIG_DIR}/.env.XXXXXX")"
  {
    grep -v -E "^${name}=" "$ENV_FILE" || true
    printf '%s=%s\n' "$name" "$(quote_env "$value")"
  } >"$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$ENV_FILE"
}

# Appends NAME only when it is absent, so existing values are preserved.
ensure_env() {
  local name="$1" value="$2"
  if ! grep -q -E "^${name}=" "$ENV_FILE"; then
    printf '%s=%s\n' "$name" "$(quote_env "$value")" >>"$ENV_FILE"
  fi
}

apply_override() {
  local name="$1"
  if [[ -n "${!name:-}" ]]; then
    set_env "$name" "${!name}"
    OVERRIDES+=("$name")
  fi
}

validate_overrides() {
  if [[ -n "${CAW_PUBLIC_ORIGIN:-}" ]] && ! is_canonical_origin "$CAW_PUBLIC_ORIGIN"; then
    die "CAW_PUBLIC_ORIGIN must be a canonical origin such as https://claude.example.com"
  fi
  if [[ -n "${CAW_PORT:-}" ]]; then
    if [[ ! "$CAW_PORT" =~ ^[0-9]{1,5}$ ]] || (( 10#$CAW_PORT < 1 || 10#$CAW_PORT > 65535 )); then
      die "CAW_PORT must be a number from 1 to 65535"
    fi
  fi
  if [[ -n "${CAW_HOST:-}" && "$CAW_HOST" == *[[:space:]]* ]]; then
    die "CAW_HOST must not contain whitespace"
  fi
  if [[ -n "${CAW_TERMINAL:-}" && "$CAW_TERMINAL" != "0" && "$CAW_TERMINAL" != "1" ]]; then
    die "CAW_TERMINAL must be 0 or 1"
  fi
  if [[ -n "${CAW_ACCESS_PROFILE:-}" ]]; then
    case "$CAW_ACCESS_PROFILE" in
      read | standard | full) ;;
      *) die "CAW_ACCESS_PROFILE must be read, standard or full" ;;
    esac
  fi
  if [[ -n "${CAW_APP_NAME:-}" ]]; then
    if [[ "${#CAW_APP_NAME}" -gt 60 || "$CAW_APP_NAME" == *[[:cntrl:]]* ]]; then
      die "CAW_APP_NAME must be at most 60 characters without control characters"
    fi
  fi
  if [[ -n "${CAW_WORKSPACE_ROOTS:-}" ]]; then
    local root roots=()
    IFS=':' read -r -a roots <<<"$CAW_WORKSPACE_ROOTS"
    for root in "${roots[@]}"; do
      [[ "$root" == /* && -d "$root" ]] || die "CAW_WORKSPACE_ROOTS entry is not an existing absolute directory: ${root}"
    done
  fi
  if [[ -n "${CAW_CLAUDE_BIN:-}" ]]; then
    [[ "$CAW_CLAUDE_BIN" == /* && -f "$CAW_CLAUDE_BIN" && -x "$CAW_CLAUDE_BIN" ]] \
      || die "CAW_CLAUDE_BIN must be an absolute path to an executable file: ${CAW_CLAUDE_BIN}"
  fi
}

# Writes the configuration file: defaults for missing keys, then the overrides, then the token.
configure() {
  mkdir -p "$CONFIG_DIR" "$STATE_DIR" "$UNIT_DIR"
  chmod 700 "$CONFIG_DIR" "$STATE_DIR"
  if [[ ! -e "$ENV_FILE" ]]; then
    : >"$ENV_FILE"
  fi
  chmod 600 "$ENV_FILE"

  ensure_env CAW_HOST "127.0.0.1"
  ensure_env CAW_PORT "4180"
  ensure_env CAW_REQUIRE_AUTH "1"
  ensure_env CAW_ENGINE "sdk"
  ensure_env CAW_ACCESS_PROFILE "full"
  ensure_env CAW_APP_NAME "Agent Web"
  ensure_env CAW_WORKSPACE_ROOTS "$HOME"
  ensure_env CAW_STATE_DIR "$STATE_DIR"
  ensure_env CAW_TERMINAL "0"

  apply_override CAW_PUBLIC_ORIGIN
  apply_override CAW_PORT
  apply_override CAW_HOST
  apply_override CAW_WORKSPACE_ROOTS
  apply_override CAW_TERMINAL
  apply_override CAW_ACCESS_PROFILE
  apply_override CAW_APP_NAME
  apply_override CAW_CLAUDE_BIN

  if [[ "$(env_value CAW_REQUIRE_AUTH)" != "1" ]]; then
    die "${ENV_FILE} must keep CAW_REQUIRE_AUTH=1 for the production service"
  fi
  if [[ "$(env_value CAW_ENGINE)" != "sdk" ]]; then
    die "${ENV_FILE} must use CAW_ENGINE=sdk for the production service (the mock engine is for demos)"
  fi

  TOKEN="$(env_value CAW_TOKEN)"
  if [[ -z "$TOKEN" ]]; then
    TOKEN="$("$NODE_BIN" -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
    set_env CAW_TOKEN "$TOKEN"
    GENERATED_TOKEN=1
  elif [[ "${#TOKEN}" -lt 16 ]]; then
    die "CAW_TOKEN in ${ENV_FILE} is shorter than 16 characters; replace it, or remove the line to generate a new token"
  fi

  if [[ -z "$(env_value CAW_PUBLIC_ORIGIN)" ]]; then
    warn "CAW_PUBLIC_ORIGIN is not set. Set it to the HTTPS origin users open before exposing the gateway, for example:"
    warn "  CAW_PUBLIC_ORIGIN=https://claude.example.com scripts/install-linux.sh"
  fi
  if [[ "$(env_value CAW_TERMINAL)" == "1" ]]; then
    warn "the terminal tab is enabled. It is equivalent to shell access for this user; enable it only on a single-user host."
  fi
  case "$(env_value CAW_HOST)" in
    127.0.0.1 | localhost | ::1) ;;
    *) warn "CAW_HOST is not loopback. Serve the gateway only through HTTPS (see docs/DEPLOYMENT.md)." ;;
  esac
}

install_dependencies() {
  say "Installing production dependencies in ${ROOT} (npm ci --omit=dev) ..."
  (cd "$ROOT" && npm ci --omit=dev)
  say "Optional terminal tab: needs build-essential and python3 to compile node-pty."
  if (cd "$ROOT" && "$NODE_BIN" -e 'import("node-pty").then(() => process.exit(0), () => process.exit(1))') \
    >/dev/null 2>&1; then
    say "node-pty: loaded."
  else
    say "node-pty: not available. The gateway works without it; install the tools above and re-run to enable the terminal tab."
  fi
}

# Renders the unit template with plain string replacement (no sed escaping).
render_unit() {
  local content
  content="$(<"$TEMPLATE")"
  content="${content//__PROJECT_ROOT__/"$ROOT"}"
  content="${content//__NODE_BIN_DIR__/"$NODE_BIN_DIR"}"
  content="${content//__NODE_BIN__/"$NODE_BIN"}"
  content="${content//__ENV_FILE__/"$ENV_FILE"}"
  local placeholder
  for placeholder in __PROJECT_ROOT__ __NODE_BIN__ __NODE_BIN_DIR__ __ENV_FILE__; do
    if [[ "$content" == *"$placeholder"* ]]; then
      die "unresolved placeholder ${placeholder} in ${TEMPLATE}"
    fi
  done
  printf '%s\n' "$content"
}

install_unit() {
  UNIT_TMP="$(mktemp "${UNIT_DIR}/.${UNIT_NAME}.XXXXXX")"
  render_unit >"$UNIT_TMP"
  chmod 644 "$UNIT_TMP"
  mv -f "$UNIT_TMP" "$UNIT_FILE"
  UNIT_TMP=""
  say "Installed ${UNIT_FILE}"
}

start_service() {
  local was_active=0
  systemctl --user daemon-reload
  if systemctl --user is-active --quiet "$UNIT_NAME"; then was_active=1; fi
  systemctl --user enable --now "$UNIT_NAME"
  # enable --now leaves a running service untouched, so restart it to apply the configuration just written.
  if [[ "$was_active" -eq 1 ]]; then systemctl --user restart "$UNIT_NAME"; fi
}

probe_address() {
  local host
  host="$(env_value CAW_HOST)"
  local port
  port="$(env_value CAW_PORT)"
  case "$host" in
    '' | 0.0.0.0) host="127.0.0.1" ;;
    :: | ::0) host="[::1]" ;;
    *:*) host="[${host}]" ;;
  esac
  LOCAL_URL="http://${host}:${port:-4180}/"
}

wait_for_health() {
  local attempt
  for ((attempt = 0; attempt < 40; attempt++)); do
    if "$NODE_BIN" -e 'fetch(process.argv[1]).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' \
      "${LOCAL_URL}healthz" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

check_claude_code() {
  local candidate="" arch="" suffix version configured
  configured="$(env_value CAW_CLAUDE_BIN)"
  if [[ -n "$configured" ]]; then
    candidate="$configured"
  else
    case "$(uname -m)" in
      x86_64 | amd64) arch="x64" ;;
      aarch64 | arm64) arch="arm64" ;;
    esac
    if [[ -n "$arch" ]]; then
      for suffix in "" "-musl"; do
        if [[ -x "${ROOT}/node_modules/@anthropic-ai/claude-agent-sdk-linux-${arch}${suffix}/claude" ]]; then
          candidate="${ROOT}/node_modules/@anthropic-ai/claude-agent-sdk-linux-${arch}${suffix}/claude"
          break
        fi
      done
    fi
    if [[ -z "$candidate" ]] && command -v claude >/dev/null 2>&1; then
      candidate="$(command -v claude)"
    fi
  fi

  say ""
  if [[ -z "$candidate" ]]; then
    warn "no Claude Code executable was found. Run the installer again, or set CAW_CLAUDE_BIN to one."
    return 0
  fi
  version="$("$candidate" --version 2>/dev/null | head -n 1 || true)"
  if [[ -n "$version" ]]; then
    say "Claude Code runtime: ${version} (${candidate})"
  else
    warn "the Claude Code executable at ${candidate} did not report a version"
  fi
  say "Login: the service runs as $(id -un) and uses that account's Claude Code login. Start Claude Code once as this"
  say "same user and complete /login:"
  say "  ${candidate}"
  say "The gateway never reads or copies credentials; the login belongs to Claude Code."
}

check_linger() {
  local linger
  linger="$(loginctl show-user "$(id -un)" --property=Linger --value 2>/dev/null || true)"
  if [[ "$linger" != "yes" ]]; then
    say ""
    say "The service stops when this user logs out unless lingering is enabled. Run once:"
    say "  loginctl enable-linger $(id -un)"
    say "(as root if your system asks for authorization)"
  fi
}

uninstall() {
  systemctl --user disable --now "$UNIT_NAME" >/dev/null 2>&1 || true
  rm -f -- "$UNIT_FILE"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  systemctl --user reset-failed "$UNIT_NAME" >/dev/null 2>&1 || true
  say "Removed ${UNIT_FILE}."
  if [[ "$PURGE" -eq 1 ]]; then
    rm -f -- "$ENV_FILE"
    rmdir "$CONFIG_DIR" 2>/dev/null || true
    say "Purged ${ENV_FILE}. The login token is gone; a new install generates a new one."
  else
    say "Kept ${ENV_FILE}, which contains the login token. Use --purge to remove it."
  fi
  say "Conversation files in ~/.claude and the state directory ${STATE_DIR} were not touched."
}

cleanup() {
  if [[ -n "$UNIT_TMP" && -e "$UNIT_TMP" ]]; then
    rm -f -- "$UNIT_TMP"
  fi
}
trap cleanup EXIT

while (($# > 0)); do
  case "$1" in
    --allow-root) ALLOW_ROOT=1 ;;
    --show-token) SHOW_TOKEN=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --purge) PURGE=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

if [[ "$PURGE" -eq 1 && "$UNINSTALL" -eq 0 ]]; then die "--purge requires --uninstall"; fi
if [[ "$SHOW_TOKEN" -eq 1 && "$UNINSTALL" -eq 1 ]]; then die "--show-token applies only to an installation"; fi
if [[ "$(uname -s)" != "Linux" ]]; then
  die "this installer manages systemd user services and runs only on Linux. Elsewhere, run npm start (see docs/DEPLOYMENT.md)."
fi
if [[ "$(id -u)" -eq 0 && "$ALLOW_ROOT" -eq 0 ]]; then
  die "refusing to run as root. Run as the normal user who will own the service, or pass --allow-root if you understand the consequences."
fi
if ! command -v systemctl >/dev/null 2>&1; then die "systemctl was not found; this installer needs systemd user services"; fi

if [[ "$UNINSTALL" -eq 1 ]]; then
  uninstall
  exit 0
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then die "Node.js 22.12 or newer is required, but node was not found on PATH"; fi
if ! "$NODE_BIN" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)'; then
  die "Node.js $("$NODE_BIN" -p 'process.versions.node') is too old; 22.12 or newer is required"
fi
if ! command -v npm >/dev/null 2>&1; then die "npm was not found on PATH"; fi
if [[ ! -f "${ROOT}/package-lock.json" ]]; then die "package-lock.json is missing from ${ROOT}"; fi
if ! systemctl --user show-environment >/dev/null 2>&1; then
  die "the systemd user manager is not reachable from this session. Log in as this user with systemd (for example over SSH) and retry."
fi

NODE_BIN_DIR="$(dirname "$NODE_BIN")"
require_unit_safe_path "project root" "$ROOT"
require_unit_safe_path "Node.js executable" "$NODE_BIN"
require_unit_safe_path "Node.js directory" "$NODE_BIN_DIR"
require_unit_safe_path "configuration file" "$ENV_FILE"
if [[ ! -f "$TEMPLATE" ]]; then die "the unit template is missing: ${TEMPLATE}"; fi

validate_overrides
install_dependencies
configure
install_unit
start_service
probe_address
if ! wait_for_health; then
  die "the service did not become healthy at ${LOCAL_URL}healthz. Read the logs with: journalctl --user -u ${UNIT_NAME} -n 100 --no-pager"
fi

say ""
systemctl --user --no-pager --lines=0 status "$UNIT_NAME" || true
say ""
say "claude-official-web is running."
say "Local URL:     ${LOCAL_URL}"
say "Configuration: ${ENV_FILE} (mode 600; it holds the login token)"
if [[ "$GENERATED_TOKEN" -eq 1 ]]; then
  say "Login token:   generated and stored in the configuration file"
else
  say "Login token:   kept from the existing configuration file"
fi
if [[ "$SHOW_TOKEN" -eq 1 ]]; then
  say "Token value:   ${TOKEN}"
  say "                Store it in a password manager. Anyone who has it can use this gateway."
fi
if [[ "${#OVERRIDES[@]}" -gt 0 ]]; then
  say "Applied overrides: ${OVERRIDES[*]}"
fi
say "Logs:          journalctl --user -u ${UNIT_NAME} -f"
check_linger
check_claude_code
