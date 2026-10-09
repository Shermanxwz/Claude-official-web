# Wire protocol (browser ⇄ gateway)

This document is the binding contract between the backend (`src/`) and the frontend (`public/`). Shapes are given in
TypeScript notation; SDK types refer to `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`.

## Conventions

- All API paths start with `/api/`. Request and response bodies are JSON (`application/json`) unless stated.
- Authentication: `caw_session` cookie (HttpOnly, SameSite=Strict, Secure when the public origin is https).
- Every non-GET request and the terminal WebSocket upgrade must carry an `Origin` header equal to `CAW_PUBLIC_ORIGIN`
  (when set) or to `http(s)://<Host>`; otherwise `403 ORIGIN_REJECTED`.
- Errors always use status + body `{ "error": { "code": string, "message": string } }`. Messages are human readable
  English; the UI maps known codes to localized text. Stack traces are never returned.
- Session ids are UUIDs. Any path segment that should be a UUID but is not → `400 BAD_REQUEST`.
- `Host` must be a loopback name (`127.0.0.1`, `localhost`, `[::1]`, any port) or the host of `CAW_PUBLIC_ORIGIN`;
  otherwise `421 HOST_REJECTED`. This blocks DNS-rebinding attacks, notably against demo mode without auth.
- Request bodies must arrive within 30 s of inactivity between chunks, otherwise `408` is not sent; the connection is
  closed. Session routes for sessions whose `cwd` lies outside the workspace roots answer `404 SESSION_NOT_FOUND`; a
  live session whose folder stops resolving inside the roots (for example a swapped symlink) is closed and stops
  publishing events. Selecting a suggestion that switches to `bypassPermissions` needs `CAW_ALLOW_BYPASS=1`.
- Body limit: 1 MiB for JSON (`413 PAYLOAD_TOO_LARGE`). Uploads have their own limit.

### Error codes

| Status | Code | Meaning |
|---|---|---|
| 400 | `BAD_REQUEST` | malformed body/params |
| 401 | `UNAUTHENTICATED` | no/expired session cookie |
| 401 | `INVALID_TOKEN` | wrong login token |
| 403 | `ORIGIN_REJECTED` | Origin check failed |
| 403 | `FORBIDDEN` | access profile does not allow this action |
| 421 | `HOST_REJECTED` | `Host` header is not an allowed name (DNS-rebinding protection) |
| 404 | `NOT_FOUND` / `SESSION_NOT_FOUND` / `REQUEST_NOT_FOUND` | unknown route / session / pending request |
| 409 | `SESSION_LOCKED` | terminal holds the session |
| 409 | `SESSION_NOT_LIVE` | action needs a live session (call `open` first) |
| 409 | `CONFLICT` | state conflict (e.g. delete a live session) |
| 413 | `PAYLOAD_TOO_LARGE` | body or upload too large |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | wrong content type |
| 422 | `PATH_NOT_ALLOWED` | path outside workspace roots or not a directory |
| 422 | `INVALID_ARGUMENT` | semantically invalid value (mode, effort, model…) |
| 422 | `CANNOT_REWIND` | rewind target invalid |
| 429 | `RATE_LIMITED` | login attempts exceeded (`Retry-After` header) |
| 429 | `TOO_MANY_SESSIONS` | live session limit reached and none idle |
| 429 | `TOO_MANY_STREAMS` | event-stream limit reached (64 total, 16 per client address) |
| 500 | `INTERNAL` | unexpected error |
| 501 | `FEATURE_DISABLED` | terminal / bypass / feature not enabled |
| 501 | `FEATURE_UNAVAILABLE` | the installed SDK/runtime does not offer this control (the UI points to the terminal tab) |
| 502 | `ENGINE_ERROR` | Claude Code / SDK call failed (message is safe summary) |
| 503 | `ENGINE_UNAVAILABLE` | engine cannot start (e.g. not logged in, binary missing) |

### Access profiles (`CAW_ACCESS_PROFILE`, default `full`)

- `read`: GET routes, SSE, login/logout only.
- `standard`: everything except `DELETE /api/sessions/:id`, terminal, `bypassPermissions` mode.
- `full`: everything (terminal still needs `CAW_TERMINAL=1`; bypass still needs `CAW_ALLOW_BYPASS=1`).

## Auth and meta

### `GET /api/session` (no auth required)
```ts
{ authenticated: boolean, authRequired: boolean, profile: 'read'|'standard'|'full'|null,
  appName: string, version: string, bootId: string }
```

### `POST /api/login` `{ token: string }` → `{ ok: true }` + Set-Cookie
Rate limit: 10 failed attempts per 10 minutes per client address → `429 RATE_LIMITED` with `Retry-After`.

### `POST /api/logout` → `{ ok: true }` (clears cookie, revokes it)

### `GET /api/meta`
```ts
{ appName: string, version: string, bootId: string, engine: 'sdk'|'mock',
  sdkVersion: string | null,            // @anthropic-ai/claude-agent-sdk version
  claudeCodeVersion: string | null,     // from the last init message, null until known
  profile: 'read'|'standard'|'full',
  roots: string[],                      // absolute workspace roots
  defaults: { model: string|null,
              permissionMode: PermissionMode|null,   // null (default) = Claude Code's own settings decide
              effort: EffortLevel|null,
              fallbackModel: string|null },          // CAW_FALLBACK_MODEL
  features: { terminal: boolean, bypass: boolean, uploads: boolean, backgroundTasks: boolean,  // see /background
              accountLogin: boolean,                 // the engine can run Claude Code's own sign-in (see Account)
              browserTools: boolean,                 // CAW_BROWSER_MCP_COMMAND is configured (see Browser tools)
              chrome: boolean },                     // CAW_CHROME=1: queries start with --chrome
  limits: { uploadMaxBytes: number, imageMaxBytes: number, maxLiveSessions: number } }
```

### `GET /healthz` (no auth) → `{ ok: true }`

## Workspaces

### `GET /api/fs/dirs?path=<abs>`
Lists sub-directories (not files) of `path`, which must be a root or inside a root. Without `path`, lists the roots.
```ts
{ path: string|null, parent: string|null, entries: { name: string, path: string, isProject: boolean }[] }
```
`isProject` is true when the directory contains `.git`, `.claude`, `CLAUDE.md` or `package.json`. Hidden directories
(name starts with `.`) are omitted. Max 500 entries, sorted by name.

### `GET /api/fs/trust?path=<abs>` → `{ path: string, trusted: boolean }`
### `POST /api/fs/trust` `{ path: string, trusted: boolean }` → `{ path: string, trusted: boolean, runtimeTrust: RuntimeTrust }` (profile `standard`+)
```ts
type RuntimeTrust = 'accepted'   // Claude Code recorded the trust now
                  | 'already'    // Claude Code already trusted the folder
                  | 'failed'     // the handshake failed (logged); the gateway record is kept
                  | 'skipped';   // trusted: false, or the engine has no runtime trust (never for the real SDK)
```
Folder trust mirrors Claude Code's own trust dialog. A session whose cwd is trusted (the folder itself or any parent
was trusted) starts with `settingSources: ['user', 'project', 'local']`; an untrusted one starts with `['user']`, so
project hooks, MCP servers, settings, skills and CLAUDE.md of an unknown repository never run without consent.
`LiveInfo.trusted` reports what the live query was started with; trusting a folder applies to sessions (re)opened
afterwards (the UI closes and reopens the current session).

Claude Code keeps its own trust record (`projects[<dir>].hasTrustDialogAccepted` in `~/.claude.json`) and, without it,
silently ignores project `allow` permission rules (and other trust-gated project features) even when project settings
are loaded. The gateway therefore records trust through the runtime's own handshake, never by editing that file:
`trusted: true` starts a throwaway query (cwd `<stateDir>/trust-probe`, `persistSession: false`, `settingSources: []`),
calls the runtime's `set_cwd` control with the folder (`setCwd(path)`); an answer `{status: 'needs_trust', directory}`
is accepted with `setCwd(path, {trustAccepted: true, trustedDirectory: directory})` (`runtimeTrust: 'accepted'`), an
answer `{status: 'ok'}` means it was already trusted (`'already'`). The probe is closed at once; at most 8 s. Starting
or resuming a session in a folder the gateway trusts runs the same handshake once per folder per gateway process
(before the query starts; a failure is logged and published once as a `warning` notice with code `RUNTIME_TRUST`, and
the session still starts). `trusted: false` only removes the gateway's record: Claude Code has no control to revoke its
own trust (the README says how to remove it in a terminal).

### `GET /api/fs/search?cwd=<abs>&q=<text>&limit=50&session=<uuid>`
`session` (optional): a live session whose `cwd` equals `cwd`. The runtime's own `@` index answers first — the
`file_suggestions` control request (`SDKControlFileSuggestionsRequest`, sent with the query's generic control call),
the same fuzzy index the terminal's `@` uses, at most 1.5 s. Its paths are relative to `cwd`; a trailing `/` marks a
directory (`type: 'dir'`, the slash removed). When it returns at least one result the answer is
`{ results, source: 'runtime' }`; otherwise (no `session`, not live, another cwd, the control is missing or fails or
times out, or the index is still warming up and returns nothing) the gateway's own walk below answers with
`source: 'gateway'`.

### `POST /api/fs/mkdir` `{ parent: string, name: string }` → `{ path: string }`
`name`: 1–100 chars, `[A-Za-z0-9._ -]`, not `.`/`..`. Profile `standard`+.

The gateway's walk: fuzzy file search for `@` mentions inside `cwd`. Skips `.git`, `node_modules`, `.caw-uploads` and
hidden dirs; visits at most 20 000 entries.
→ `{ results: { path: string /* relative to cwd */, type: 'file'|'dir' }[], source: 'runtime'|'gateway' }`

## Sessions

Types used below:
```ts
type LiveState = 'starting'|'idle'|'running'|'requires_action'|'closing'|'error';
type LiveInfo = { sessionId: string, cwd: string, state: LiveState, model: string|null,
  permissionMode: PermissionMode|null,     // null until system/init reports the mode Claude Code started in
  effort: EffortLevel|null, title: string|null,
  agent: string|null,                      // main-thread agent the query runs as (`--agent`); null = none
  additionalDirectories: string[],         // extra working directories the query was started with (`--add-dir`)
  fallbackModel: string|null,              // fallback model the query was started with (`--fallback-model`)
  browserTools: boolean,                   // the operator's browser MCP server is attached (see /browser)
  lockedBy: 'terminal'|null, pendingCount: number, lastActivity: number,
  claudeCodeVersion: string|null, error: { code: string, message: string } | null, trusted: boolean,
  fastMode: boolean|null,                  // fast mode the gateway requested for this session; null = follow settings
  fastModeState: 'off'|'on'|'cooldown'|null,     // what the runtime last reported (init or result); null = unknown
  fastModeDisabledReason: string|null,     // FastModeDisabledReason from the same report; null when nothing blocks it
  backgroundTasks: number };               // live background tasks, ambient ones excluded (background_tasks_changed)
type SessionSummary = SDKSessionInfo & { live: LiveInfo | null };
type PendingRequest = {
  id: string, sessionId: string, kind: 'permission'|'question'|'plan'|'elicitation'|'dialog', createdAt: number,
  toolName?: string, toolUseId?: string, agentId?: string, input?: Record<string, unknown>,
  title?: string, displayName?: string, description?: string, decisionReason?: string, blockedPath?: string,
  suggestions?: PermissionUpdate[], suppressAlwaysAllowRule?: boolean, defaultToNo?: boolean,
  mcpServer?: { name: string, source: string }, elicitation?: ElicitationRequest,
  dialog?: RefusalFallbackDialog };       // kind 'dialog' only
// The runtime's request_user_dialog of kind 'refusal_fallback_prompt' (the terminal's "retry with the fallback
// model?" prompt). Strings are copied as given (display as text); unknown payload keys are dropped.
type RefusalFallbackDialog = { dialogKind: 'refusal_fallback_prompt', originalModel: string, fallbackModel: string,
  apiRefusalCategory: string|null, guidanceText: string|null, retractedMessageUuids: string[] };
type LiveEvent = { seq: number, msg: SDKMessage };
```

### How live queries are started and kept

- Thinking summaries: Claude Code reads `showThinkingSummaries` only in its interactive terminal; a non-interactive
  session (every SDK query) receives thinking blocks without text unless the display is given explicitly. Before each
  start the gateway reads the settings the query will load with `resolveSettings({cwd, settingSources})` (same sources
  as the query, at most 2 s) and, unless they set `showThinkingSummaries: false`, starts the query with
  `extraArgs: {'thinking-display': 'summarized'}` (the runtime's `--thinking-display` flag; the `thinking` option is
  not used because it would also force the thinking type). When the lookup fails or times out, summaries are requested
  (logged at debug level). A remembered `fastMode` is passed as the flag-layer overlay `settings: {fastMode}`.
- Every query declares `perTaskStopAffordance: true` (see interrupt).
- Permission mode: the `permissionMode` option is passed only when the user or `CAW_DEFAULT_PERMISSION_MODE` chose a
  mode. Otherwise it is omitted and Claude Code applies `permissions.defaultMode` from its settings exactly as
  `claude` does in a terminal (the runtime itself drops escalating modes that only project settings ask for).
  `LiveInfo.permissionMode` is `null` until `system/init` reports the mode, then follows `init` and `system/status`.
  If `init` reports `bypassPermissions` while bypass is not allowed (`CAW_ALLOW_BYPASS` unset; the query was started
  with `allowDangerouslySkipPermissions: false`), the gateway calls `setPermissionMode('default')` at once and publishes
  a `warning` notice with code `BYPASS_REFUSED`.
- `agent` → option `agent` (the main thread runs as that agent, like `claude --agent`); `additionalDirectories` →
  option `additionalDirectories` (like `--add-dir`); `fallbackModel` → option `fallbackModel` (like
  `--fallback-model`; default `CAW_FALLBACK_MODEL`). Each is passed only when set.
- Every query passes `onUserDialog` with `supportedDialogKinds: ['refusal_fallback_prompt']`, so the runtime asks
  before retrying a refused answer on the fallback model instead of ending the turn with the plain refusal error. The
  dialog becomes a pending request of kind `dialog` (see requests). A dialog of any other kind is answered
  `{behavior: 'cancelled'}` at once (it cannot arrive, because only this kind is declared).
- `CAW_CHROME=1` adds the CLI's own `--chrome` flag (`extraArgs: {chrome: null}`): Claude in Chrome, which drives a
  Chrome browser with the Claude in Chrome extension on the machine that runs the gateway and needs a claude.ai
  sign-in. Status and browser choice are runtime views (`chrome`, `POST /chrome/browser`).
- Runtime trust: see `POST /api/fs/trust` (the handshake runs before the start when the folder is trusted).
- `LiveInfo.backgroundTasks` follows `system/background_tasks_changed` (replace semantics; entries with `ambient: true`
  are not counted) and drops to 0 when the query ends. The idle sweep never closes a session whose count is above 0,
  and making room for a new live session only evicts idle sessions without pending requests and without background
  tasks (otherwise `429 TOO_MANY_SESSIONS`), so background work is never killed by housekeeping.

### `GET /api/sessions?cwd=<abs>&limit=100&offset=0`
→ `{ sessions: SessionSummary[] }` sorted by `lastModified` desc. Without `cwd`: all projects, filtered to sessions
whose `cwd` is inside a workspace root (sessions without `cwd` are included only if live). Live sessions that have no
file yet are included.

### `POST /api/sessions` `{ cwd: string, title?: string } & SessionSettings`
Starts a new live session with a gateway-assigned UUID → `{ live: LiveInfo }`. `cwd` must be inside a root.
```ts
type SessionSettings = {
  model?: string|null,                 // null = Claude Code's default model
  permissionMode?: PermissionMode|null, // null = Claude Code's settings decide (not passed to the runtime)
  effort?: EffortLevel|null,
  fastMode?: boolean|null,
  agent?: string|null,                 // 1–200 chars; the runtime validates the name (422 with its message)
  additionalDirectories?: string[],    // ≤ 20 absolute directories inside the roots, realpath'd, deduplicated,
                                       // the cwd itself dropped; otherwise 422 PATH_NOT_ALLOWED
  fallbackModel?: string|null,         // 1–200 chars
  browserTools?: boolean };            // attach the operator's browser MCP server (profile full; see Browser tools)
```

### `GET /api/sessions/:id`
```ts
{ info: SDKSessionInfo | null, live: LiveInfo | null, pending: PendingRequest[],
  liveEvents: LiveEvent[],   // SDK messages of the current live query (bounded), oldest first
  seq: number,               // EventHub high-water mark at snapshot time
  init: SDKSystemMessage | null }  // last system/init message of the live query
```
`404 SESSION_NOT_FOUND` when neither a file nor a live session exists.

### `GET /api/sessions/:id/messages?tail=200` or `?before=<index>&limit=200`
Transcript from disk (`getSessionMessages`, system messages included).
```ts
{ messages: (SessionMessage & { index: number })[], total: number, start: number, hasMore: boolean }
```
`tail=N` returns the last N; `before=i&limit=N` returns up to N messages with index < i. `start` = index of first item.

### `POST /api/sessions/:id/open` `SessionSettings` → `{ live: LiveInfo }`
Resumes the session in a live query (no-op if already live). `409 SESSION_LOCKED` if the terminal holds it.

### `POST /api/sessions/:id/close` → `{ ok: true }` (closes the live query; pending requests are cancelled)

### `POST /api/sessions/:id/messages`
```ts
{ clientMessageId: string /* UUID */, text: string, attachments?: { path: string }[] }
```
`attachments[].path` must be absolute paths previously returned by `POST /api/attachments` for the same cwd. Images
(`image/png|jpeg|gif|webp`, ≤ `imageMaxBytes`) are sent as base64 image blocks; other files are referenced in the text
as `Attached file: <path>`. Opens the session if needed. Duplicate `clientMessageId` within 10 minutes is accepted
without re-sending. → `{ accepted: true, duplicate: boolean }`.
While a turn is running the message is queued by the runtime (shown as "queued" until echoed).

### `POST /api/sessions/:id/interrupt` `{ cancelQueued?: boolean }` → `{ ok: true, stillQueued: string[], cancelled: string[] }`
Stops the current turn only. Every query declares `perTaskStopAffordance: true` (the UI stops background tasks one at a
time from the Tasks panel), so background shells and agents keep running, as they do after Esc in the terminal.
The runtime's interrupt receipt lists the user messages that will still run (`stillQueued`) and, with
`cancelQueued: true` (the runtime's `cancel_queued` interrupt), the queued messages it dropped (`cancelled`). Both hold
message uuids, which are the `clientMessageId`s the browser sent; a runtime without a receipt answers empty lists. Every
cancelled id is published as `message_cancelled`. Not live → `{ ok: true, stillQueued: [], cancelled: [] }`.

### `DELETE /api/sessions/:id/queued/:clientMessageId` → `{ cancelled: boolean }`
Removes one message that waits in the runtime's queue behind a running turn: `cancel_async_message` (the runtime's
`cancelAsyncMessage(uuid)`). `cancelled: false` when it already started or is unknown. A cancelled message is published
as `message_cancelled`. Profile `standard`+; `409 SESSION_NOT_LIVE` when not live; `501 FEATURE_UNAVAILABLE` when the
SDK's query has no such control.

### `POST /api/sessions/:id/background` `{ toolUseId?: string }` → `{ backgrounded: boolean }`
The terminal's Ctrl+B: `backgroundTasks(toolUseId)`. With `toolUseId` it moves the one foreground Bash command or
subagent started by that `tool_use` block to the background; without it, every foreground task. The blocking tool call
returns at once with a "running in the background" `tool_result`, the turn continues, and the task reports through
`system/task_*` messages. `backgrounded: false` when `toolUseId` matched no foreground task (it already finished, for
example). Profile `standard`+. `409 SESSION_NOT_LIVE` when not live. `501 FEATURE_DISABLED` when background tasks are
disabled for the runtime (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` set to a non-empty value other than `0`/`false` in the
environment the gateway was started with, which the runtime inherits; `Config.backgroundTasksDisabled`), checked
before the call. Other failures → `502 ENGINE_ERROR`.

### `POST /api/sessions/:id/settings` `SessionSettings`
Applies to the live query (`setModel`, `setPermissionMode`, `applyFlagSettings({effortLevel})`,
`applyFlagSettings({fastMode})`, `applyFlagSettings({agent})`); if not live, stored for the next open.
`bypassPermissions` requires feature + profile. → `{ live: LiveInfo | null, restartRequired: boolean }`
`permissionMode: null` on a live query is `400 BAD_REQUEST` (a running query cannot go back to "settings decide").
`agent: null` clears the main-thread agent (`applyFlagSettings({agent: null})`). `additionalDirectories` changes on a
live query restart it (close, then resume with the new list), like a trust change; refused with `409 CONFLICT` while a
turn is running or requests are pending. `fallbackModel` cannot change in a running query: it is stored and
`restartRequired: true` tells the UI to offer a restart (close + open). `restartRequired` is false otherwise.
`fastMode` is the terminal's `/fast`, kept in the session's flag settings layer only (nothing is written to settings
files): `true`/`false` → `applyFlagSettings({fastMode: true|false})`, `null` → `applyFlagSettings({fastMode: null})`,
which falls back to the user's settings. A stored value is applied at the next start through the `settings` option
(`{fastMode}`). SDK sessions are opted out of fast mode until the host sets it (`fast_mode_disabled_reason:
'sdk_opt_in_required'`). `LiveInfo.fastMode` reports the request; whether fast mode serves is `fastModeState` and
`fastModeDisabledReason`, updated from `system/init` and from every `result` that carries them.

### `POST /api/sessions/:id/requests/:requestId`
Body depends on the request kind:
```ts
// permission
{ decision: 'allow' | 'allow_always' | 'deny', message?: string, updatedInput?: Record<string, unknown>,
  suggestionIndexes?: number[] /* suggestions to persist for allow_always; default: only addRules/replaceRules
                                   suggestions — directory and mode suggestions are applied only when selected */,
  interrupt?: boolean }
// question (AskUserQuestion)
{ answers: Record<string, string | string[]>, response?: string } | { decline: true }
// plan (ExitPlanMode)
{ decision: 'approve' | 'reject', message?: string, nextMode?: 'default'|'acceptEdits'|'auto' }
// elicitation (MCP)
{ action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown> }
// dialog (refusal_fallback_prompt)
{ result: 'retry_fallback' | 'edit_prompt' | 'cancelled' }
```
A dialog answer becomes `{behavior: 'completed', result}`; a dialog cancelled by the gateway (session closed, query
ended) becomes `{behavior: 'cancelled'}`, after which the runtime applies its default (`cancelled`). `retry_fallback`
retries the refused turn on `fallbackModel`; `edit_prompt` ends the turn so the user can rephrase (the UI puts the
refused prompt back into the composer); `cancelled` ends it with the refusal. The outcome is `answered`.
→ `{ ok: true }`. Mapping to the SDK: permission allow → `{behavior:'allow', updatedInput: updatedInput ?? input,
updatedPermissions?}`; deny → `{behavior:'deny', message: message || 'The user denied this action', interrupt?}`;
question → allow with `updatedInput: {...input, answers, response?}`, decline → deny; plan approve → allow then
`setPermissionMode(nextMode)` when given, reject → deny with the feedback message.

### `GET /api/sessions/:id/context?detail=summary|full` → `SDKControlGetContextUsageResponse` (`409 SESSION_NOT_LIVE` if not live)
`detail` defaults to `summary` (the last response's usage plus local estimates; used by the header meter). `full`
counts each category with the token-count API, as the terminal's `/context` does (the context panel asks for it; its
timeout is 30 s). Control calls to the runtime time out after 10 s unless stated otherwise (`502 ENGINE_ERROR`;
capabilities fall back to `stale: true`).
When the runtime reports rejected credentials (`system/api_retry` or an assistant `error` of an authentication class)
the gateway publishes a `notice` with code `ENGINE_UNAVAILABLE` and sets `LiveInfo.error`.

### `GET /api/sessions/:id/capabilities`
```ts
{ stale: boolean, commands: SlashCommand[], models: ModelInfo[], agents: AgentInfo[], account: AccountInfo | null,
  mcpServers: McpServerStatus[], outputStyle: string | null, availableOutputStyles: string[] }
```
Live sessions return fresh data (cached ≤ 30 s, commands refreshed by `commands_changed`). Non-live sessions return the
last known capabilities for the same cwd (or the last known globally) with `stale: true`, or empty lists.

### `POST /api/sessions/:id/mcp` `{ server: string, action: 'toggle'|'reconnect'|'permission-mode', enabled?: boolean, mode?: 'default'|'auto'|null }` → `{ mcpServers, warning?: string }`
`permission-mode` pins (or clears, `mode: null`) a per-server permission-mode override with
`setMcpPermissionModeOverride(server, mode)`: tighten-only — it matters only while the session mode would auto-allow
(`bypassPermissions`/`auto`); `default` forces a prompt for each of the server's actions, `auto` routes them through
the auto-mode classifier. `warning` is the runtime's note when no connected server has that name. Profile `standard`+.

### `POST /api/sessions/:id/mcp/auth` `{ server: string, action: 'start'|'callback'|'clear', callbackUrl?: string }`
The terminal's `/mcp` → Authenticate, for servers whose status is `needs-auth`:
```ts
// start → mcpAuthenticate(server)   (no custom redirect URI: the runtime's own localhost callback is used)
{ authUrl: string|null, requiresUserAction: boolean, callbackExpected: boolean,
  redirectScheme: 'localhost'|'custom'|null, callbackPort: number|null }
// callback → mcpSubmitOAuthCallbackUrl(server, callbackUrl): the full address the browser landed on after approving
{ ok: true }
// clear → mcpClearAuth(server): forgets the server's stored credentials
{ ok: true }
```
`authUrl` is returned only when it is an `http(s)` URL (otherwise `502 ENGINE_ERROR`). `callbackUrl` must be an
`http(s)` URL of at most 4096 characters (`400 BAD_REQUEST`). `requiresUserAction: false` means nothing to do (already
authorized). Because the runtime's callback listens on the gateway's machine, a browser elsewhere cannot reach it: after
approving, the user copies the address of the page that fails to load and submits it with `callback`. On the same
machine the callback completes by itself; the UI polls `GET /capabilities` until the server is `connected` (5 min).
Profile `standard`+; `409 SESSION_NOT_LIVE`; `501 FEATURE_UNAVAILABLE` when the SDK's query has no such control.
### `POST /api/sessions/:id/reload` `{ what: 'plugins'|'skills'|'output-styles', force?: boolean }`
```ts
→ { ok: true, availableOutputStyles?: string[] }      // applied
| { ok: false, held: true, cacheImpact: { mcpServersAdded: string[], mcpServersRemoved: string[],
                                          lspToolChange: 'adds'|'may-add'|'removes'|'may-remove'|null } }
```
`plugins` runs the check the terminal's `/reload-plugins` makes: without `force` it calls
`reloadPlugins({holdOnCacheImpact: true})`; when the runtime holds the reload because applying it would change the
tool list the conversation's prompt cache depends on, nothing is applied and the answer is the `held` form (names are
plugin-authored: display as text only). `force: true` calls `reloadPlugins()`. `skills` → `reloadSkills()`.
`output-styles` → `reloadOutputStyles()` and returns the refreshed `availableOutputStyles`. `force` is only valid with
`plugins`. Every successful reload drops the capabilities cache. Profile `standard`+; `409 SESSION_NOT_LIVE` when not
live.

### `POST /api/sessions/:id/output-style` `{ style: string }` → `{ outputStyle: string, availableOutputStyles: string[] }`
The terminal's `/config` output-style row: `updateSettings('localSettings', {outputStyle: style})`, the runtime's own
settings writer, which writes the project's `.claude/settings.local.json` and applies the style to the live session.
`style` is 1–100 characters once trimmed (`400 BAD_REQUEST` otherwise) and must be one of the session's
`availableOutputStyles` (`422 INVALID_ARGUMENT`); when the runtime does not answer for its styles the answer is
`502 ENGINE_ERROR`. Style names longer than 100 characters are left out of `availableOutputStyles`. The runtime refuses sessions that
do not load local settings, so an untrusted folder answers `409 CONFLICT` ("Trust this folder to change its output
style.") before any call. Profile `standard`+; `409 SESSION_NOT_LIVE` when not live. The capabilities cache keeps the
new `outputStyle`.

### `POST /api/sessions/:id/tasks/:taskId/stop` → `{ ok: true }`

### `GET /api/sessions/:id/tasks/:taskId/output` → `{ output: string, totalBytes: number, truncated: boolean }`
The output of a shell or Monitor task of the live session, running or ended (`get_task_output`): the end of the output
decoded as UTF-8 (`truncated: true` when only the last 8 KiB are returned). An unknown task → `404 NOT_FOUND` with the
runtime's message. Profile `read`+; `409 SESSION_NOT_LIVE`; `501 FEATURE_UNAVAILABLE`.

### `POST /api/sessions/:id/rewind`
```ts
{ userMessageId: string, mode: 'code'|'conversation'|'both', dryRun?: boolean }
→ { files?: RewindFilesResult, conversation?: { resumeAt: string } }
```
`code` uses `rewindFiles(userMessageId, {dryRun})` (opens the session if needed). `conversation` reopens the live query
with `resume` + `resumeSessionAt = <uuid of the transcript entry immediately before userMessageId>`; if the target is
the first message → `422 CANNOT_REWIND`. `dryRun` never changes anything.

### `POST /api/sessions/:id/fork` `{ upToMessageId?: string, title?: string }` → `{ sessionId: string }`
### `PATCH /api/sessions/:id` `{ title?: string, tag?: string|null }` → `{ ok: true }`
### `DELETE /api/sessions/:id` → `{ ok: true }` (`full` profile; `409 CONFLICT` if live)
### `GET /api/sessions/:id/subagents` → `{ agents: string[] }`
### `GET /api/sessions/:id/subagents/:agentId/messages` → `{ messages: SessionMessage[] }`

### `GET /api/sessions/search?q=<text>&limit=20`
Finds conversations by title and content. `q`: 2–200 characters once trimmed (`400 BAD_REQUEST`), matched
case-insensitively as a plain substring. `limit` 1–50 (default 20).
```ts
{ results: { sessionId: string, cwd: string|null, title: string|null, lastModified: number,
             matchedIn: 'title'|'content', snippets: string[] }[],
  scanned: number,       // sessions whose transcript was read
  truncated: boolean }   // the content scan stopped at its budget
```
Every session inside the roots is matched first on what `listSessions()` reports (custom title, summary, first prompt;
`matchedIn: 'title'`, no snippets). Then the transcripts of the 50 most recently modified sessions that did not match
yet are read with `getSessionMessages()` — only the text blocks of user and assistant messages, at most 4 000 messages
per session — within an overall budget of 5 s. Up to 3 snippets per session, each at most 160 characters around a
match, whitespace collapsed. Results are ordered by `lastModified` desc. Profile `read`+. The route is matched before
`/api/sessions/:id`.

### `GET /api/sessions/:id/runtime` → `{ views: RuntimeViewName[] }`
### `GET /api/sessions/:id/runtime/:view` → `{ view: RuntimeViewName, data: unknown, fetchedAt: number }`
Read-only views of the live runtime, the data behind the terminal's own screens. `views` lists the ones the installed
SDK's query offers (method present); the UI shows only those. `data` is the runtime's answer as given, except where
noted. `409 SESSION_NOT_LIVE` when not live (the UI offers to open the session); `501 FEATURE_UNAVAILABLE` when the
method is missing; `502 ENGINE_ERROR` on failure or timeout (10 s unless noted).

| view | runtime call | terminal screen | profile | notes |
|---|---|---|---|---|
| `status` | `getStatus()` | `/status` | `standard` | `{sections: [{title, rows: [{label, value}]}]}` |
| `permissions` | `listPermissionRules()` | `/permissions` | `read` | `{state: {rules: [{behavior, source, rule, description?, editability}], workspaceDirectories, originalCwd, managedOnly}}` |
| `hooks` | `getHooksListing()` | `/hooks` | `standard` | `{events, hooks, eventCatalog, policy}` |
| `settings` | `getSettings()` | `/config` | `full` | `{effective, sources, applied}`; every value inside an `env` object is replaced by `"[redacted]"` |
| `skills` | `getSkillsDialog()` | `/skills` | `read` | `{skills: [...]}` |
| `sandbox` | `getSandboxDialog()` | `/sandbox` | `read` | sandbox support, mode, dependency errors, restrictions |
| `plan` | `getPlan()` | plan mode | `read` | `{exists: boolean, ...}` |
| `usage` | `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({skipBehaviors: true})` | `/usage` | `read` | session cost and totals, `rate_limits_available`, plan windows; 15 s; experimental in the SDK, so the view is listed only while the method exists |
| `account` | `accountInfo()` | `/status` account | `read` | `AccountInfo` |
| `init` | `initializationResult()` | — | `standard` | `SDKControlInitializeResponse` |
| `mcp` | `mcpServerStatus()` | `/mcp` | `read` | `McpServerStatus[]` |
| `chrome` | `getChromeDialog()` | `/chrome` | `read` | Claude in Chrome status (see `CAW_CHROME`) |

The `status`, `permissions`, `hooks`, `settings`, `skills`, `sandbox`, `plan`, `chrome` and `account` calls are
runtime controls that the SDK ships without public typings (`get_status`, `list_permission_rules`, …); the gateway
calls them only when present (feature detection, never by constructing raw control requests) and the UI falls back to
the terminal tab when they are missing.

### `GET /api/sessions/:id/memory`
The terminal's `/memory`: the memory files Claude Code loads for this session (`getMemoryDialog()`), each read through
the SDK's public `readFile(path, {maxBytes: 262144})`, which applies the session's read permission rules.
```ts
{ files: { kind: string, path: string, label: string, description: string, exists: boolean,
           content: string|null,   // null when missing or the runtime refused to read it
           truncated: boolean,     // the file is larger than 256 KiB; content holds the first 256 KiB
           editable: boolean }[],
  folders: unknown[], autoMemory: unknown, autoDream: unknown }   // as the runtime reports them
```
`editable` is true for a file named `CLAUDE.md` or `CLAUDE.local.md` whose real path (or, for a missing file, its
parent's) lies inside a workspace root or inside `$HOME/.claude`, and that is not a symbolic link. Profile `read`+;
`409 SESSION_NOT_LIVE`; `501 FEATURE_UNAVAILABLE`.

### `PUT /api/sessions/:id/memory` `{ path: string, content: string }` → `{ ok: true, bytes: number }`
Saves one memory file, as the terminal's `/memory` does by opening it in an editor. `path` must be a file the runtime
lists for this live session with `editable: true` (`422 PATH_NOT_ALLOWED`); `content` at most 256 KiB as UTF-8
(`413 PAYLOAD_TOO_LARGE`). The write is atomic (temporary file in the same directory, then rename); a new file gets mode
0644 and a missing parent directory is created only under `$HOME/.claude`. Claude Code reads memory files when a query
starts, so the UI offers to restart the session to apply the change. Profile `standard`+.

### `GET /api/sessions/:id/export` → `{ text: string, filename: string }`
The terminal's `/export`: the conversation as plain text (`exportConversation()`); `filename` is the runtime's
`default_filename` reduced to `[A-Za-z0-9._-]` and ending in `.txt`. Profile `read`+; `409 SESSION_NOT_LIVE`;
`501 FEATURE_UNAVAILABLE`.

### `POST /api/sessions/:id/side-question` `{ question: string }` → `{ response: string|null, synthetic: boolean, refusalFallback: { originalModel: string, fallbackModel: string }|null }`
The terminal's `/btw`: a quick question about the conversation, answered by the model without adding a turn to the
transcript (`askSideQuestion(question)`). `question`: 1–4 000 characters once trimmed. Opens the session when needed
(like sending a message). One side question at a time per session (`409 CONFLICT`); 120 s timeout (`502`).
`response: null` when the runtime returned nothing. It uses the account's usage. Profile `standard`+;
`501 FEATURE_UNAVAILABLE` when the method is missing.

### Browser tools (`CAW_BROWSER_MCP_COMMAND`)
When the operator sets `CAW_BROWSER_MCP_COMMAND` to a JSON array of strings (the command and its arguments, for example
`["npx","-y","@playwright/mcp@<version>","--headless","--isolated"]`), `meta.features.browserTools` is true and a
session can attach that MCP server under the name `browser` with `POST /settings {browserTools: true}` (profile
`full`): a live query gets it through the SDK's public `setMcpServers({browser: {type: 'stdio', command, args}})`, a
query that starts with it remembered gets it through the `mcpServers` option. `false` detaches it
(`setMcpServers({})`). The array: 1–32 strings, each 1–1024 characters, the first an absolute path or a bare command
name; anything else is a configuration error at startup. The user never supplies the command. Screenshots the server
returns are image blocks in its tool results and render in the MCP tool card.

## Account (Claude Code's own sign-in)

Claude Code's `/login`, run by the runtime itself; the gateway never reads or writes credentials. The calls go to a
live session's query when one exists, otherwise to the gateway's account query: a query started on demand with cwd
`<stateDir>/account`, `persistSession: false` and `settingSources: ['user']`, closed after 5 minutes without use and
right after a sign-in completes. These are runtime controls without public typings (`accountInfo` is public), used
only when present (`501 FEATURE_UNAVAILABLE` otherwise).

### `GET /api/account` → `{ account: AccountInfo|null, signInPending: boolean }`
`accountInfo()`; `account: null` when nobody is signed in. Profile `read`+.

### `POST /api/account/login` `{ method: 'claudeai'|'console' }` → `{ manualUrl: string, automaticUrl: string|null }`
Starts the runtime's sign-in (`claudeAuthenticate(method === 'claudeai')`): `claudeai` for a Claude subscription,
`console` for an Anthropic Console (API) account. A flow already in progress for the same method is joined; a flow for
the other method is replaced. The user opens `manualUrl`, signs in, and copies the code the page shows. `automaticUrl`
completes only in a browser on the gateway's machine. Both must be `https` URLs (`502 ENGINE_ERROR` otherwise).
Profile `full`. Policy refusals (managed settings) → `403 FORBIDDEN` with the runtime's message.

### `POST /api/account/login/code` `{ code: string }` → `{ account: AccountInfo }`
`code` is what the sign-in page shows: `<authorizationCode>#<state>`; anything without exactly one `#` and two
non-empty parts → `422 INVALID_ARGUMENT` "Invalid code. Please make sure the full code was copied". Then
`claudeOAuthCallback(code, state)` (waits for the token exchange, at most 2 minutes). On success the gateway drops its
capability caches, closes the account query and publishes `account_changed` `{ account }`; live sessions keep running
with the credentials they started with until they are reopened. No flow in progress → `409 CONFLICT`. Profile `full`.

### `DELETE /api/account/login` → `{ ok: true }`
Abandons the flow in progress (closes the account query). Profile `full`.

Signing out is not offered: the runtime has no sign-out control. The terminal tab (`/logout`) does it.

## Attachments

### `POST /api/attachments?cwd=<abs>`
Raw body; headers `Content-Type` (file MIME) and `X-File-Name` (URI-encoded original name). Saved as
`<cwd>/.caw-uploads/<YYYYMMDD>-<8 hex>/<sanitized name>` with mode 0600.
→ `{ path: string, name: string, size: number, mediaType: string, kind: 'image'|'file' }`.
Limit `CAW_UPLOAD_MAX_BYTES` (default 25 MiB). Files older than `CAW_UPLOAD_RETENTION_DAYS` (default 7) are removed by
maintenance; only gateway-created files are ever deleted.

## Events (Server-Sent Events)

### `GET /api/events?watch=<sessionId>&after=<seq>`
`text/event-stream`. Each frame: `id: <bootId>:<seq>`, `event: <type>`, `data: <json>`. `after` (optional) replays
buffered events with `seq > after`; on automatic reconnect the browser's `Last-Event-ID` is honoured the same way. If
the requested position is no longer buffered or the bootId differs, the server sends `resync` first.
Global events are delivered to every client; `sdk` events only for the watched session.

| event | data | scope |
|---|---|---|
| `hello` | `{ bootId, version, seq }` | sent first on every connection |
| `heartbeat` | `{ t: number }` | every 15 s |
| `resync` | `{ reason: 'gap'|'boot'|'overflow' }` | client must reload snapshot |
| `sessions_changed` | `{ reason: string, sessionId?: string }` | global |
| `session_state` | `{ live: LiveInfo }` or `{ sessionId, live: null }` when closed | global |
| `sdk` | `{ sessionId, msg: SDKMessage }` | watched session only |
| `request` | `{ request: PendingRequest }` | global |
| `request_resolved` | `{ sessionId, requestId, outcome: 'allowed'|'denied'|'answered'|'cancelled' }` | global |
| `message_accepted` | `{ sessionId, clientMessageId }` | global |
| `message_cancelled` | `{ sessionId, clientMessageId }` | global — a queued message the runtime dropped |
| `account_changed` | `{ account: AccountInfo|null }` | global — after a sign-in through the GUI |
| `notice` | `{ sessionId?, level: 'info'|'warning'|'error', code, message }` | global |
| `terminal_state` | `{ sessionId, attached: boolean }` | global |

Per-client queues are bounded (1 MiB); a client that falls behind is disconnected and must reconnect (it then gets
`resync` if events were dropped). The replay buffer holds the most recent 5 000 events. At most 64 streams are open
at once and 16 per client address (`429 TOO_MANY_STREAMS`).

## Terminal (optional)

`GET /api/terminal?sessionId=<uuid>` WebSocket (or `?cwd=<abs>` for a fresh `claude`). Requires `CAW_TERMINAL=1`,
profile `full`, valid cookie and Origin. While attached to a session the GUI cannot write to it (`SESSION_LOCKED`).
Client → server text frames: `{"type":"input","data":string}` | `{"type":"resize","cols":n,"rows":n}`.
Server → client: `{"type":"output","data":string}` | `{"type":"exit","code":n}` | `{"type":"error","code","message"}`.
