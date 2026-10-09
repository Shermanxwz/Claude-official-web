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
  defaults: { model: string|null, permissionMode: PermissionMode, effort: EffortLevel|null },
  features: { terminal: boolean, bypass: boolean, uploads: boolean, backgroundTasks: boolean },  // see /background
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
### `POST /api/fs/trust` `{ path: string, trusted: boolean }` → `{ path: string, trusted: boolean }` (profile `standard`+)
Folder trust mirrors Claude Code's own trust dialog. A session whose cwd is trusted (the folder itself or any parent
was trusted) starts with `settingSources: ['user', 'project', 'local']`; an untrusted one starts with `['user']`, so
project hooks, MCP servers, settings, skills and CLAUDE.md of an unknown repository never run without consent.
`LiveInfo.trusted` reports what the live query was started with; trusting a folder applies to sessions (re)opened
afterwards (the UI closes and reopens the current session).

### `POST /api/fs/mkdir` `{ parent: string, name: string }` → `{ path: string }`
`name`: 1–100 chars, `[A-Za-z0-9._ -]`, not `.`/`..`. Profile `standard`+.

### `GET /api/fs/search?cwd=<abs>&q=<text>&limit=50`
Fuzzy file search for `@` mentions inside `cwd`. Skips `.git`, `node_modules`, `.caw-uploads` and hidden dirs; visits at
most 20 000 entries. → `{ results: { path: string /* relative to cwd */, type: 'file'|'dir' }[] }`

## Sessions

Types used below:
```ts
type LiveState = 'starting'|'idle'|'running'|'requires_action'|'closing'|'error';
type LiveInfo = { sessionId: string, cwd: string, state: LiveState, model: string|null,
  permissionMode: PermissionMode, effort: EffortLevel|null, title: string|null,
  lockedBy: 'terminal'|null, pendingCount: number, lastActivity: number,
  claudeCodeVersion: string|null, error: { code: string, message: string } | null, trusted: boolean,
  fastMode: boolean|null,                  // fast mode the gateway requested for this session; null = follow settings
  fastModeState: 'off'|'on'|'cooldown'|null,     // what the runtime last reported (init or result); null = unknown
  fastModeDisabledReason: string|null,     // FastModeDisabledReason from the same report; null when nothing blocks it
  backgroundTasks: number };               // live background tasks, ambient ones excluded (background_tasks_changed)
type SessionSummary = SDKSessionInfo & { live: LiveInfo | null };
type PendingRequest = {
  id: string, sessionId: string, kind: 'permission'|'question'|'plan'|'elicitation', createdAt: number,
  toolName?: string, toolUseId?: string, agentId?: string, input?: Record<string, unknown>,
  title?: string, displayName?: string, description?: string, decisionReason?: string, blockedPath?: string,
  suggestions?: PermissionUpdate[], suppressAlwaysAllowRule?: boolean, defaultToNo?: boolean,
  mcpServer?: { name: string, source: string }, elicitation?: ElicitationRequest };
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
- `LiveInfo.backgroundTasks` follows `system/background_tasks_changed` (replace semantics; entries with `ambient: true`
  are not counted) and drops to 0 when the query ends. The idle sweep never closes a session whose count is above 0,
  and making room for a new live session only evicts idle sessions without pending requests and without background
  tasks (otherwise `429 TOO_MANY_SESSIONS`), so background work is never killed by housekeeping.

### `GET /api/sessions?cwd=<abs>&limit=100&offset=0`
→ `{ sessions: SessionSummary[] }` sorted by `lastModified` desc. Without `cwd`: all projects, filtered to sessions
whose `cwd` is inside a workspace root (sessions without `cwd` are included only if live). Live sessions that have no
file yet are included.

### `POST /api/sessions` `{ cwd: string, title?: string, model?: string, permissionMode?: PermissionMode, effort?: EffortLevel }`
Starts a new live session with a gateway-assigned UUID → `{ live: LiveInfo }`. `cwd` must be inside a root.

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

### `POST /api/sessions/:id/open` `{ model?, permissionMode?, effort? }` → `{ live: LiveInfo }`
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

### `POST /api/sessions/:id/interrupt` → `{ ok: true }`
Stops the current turn only. Every query declares `perTaskStopAffordance: true` (the UI stops background tasks one at a
time from the Tasks panel), so background shells and agents keep running, as they do after Esc in the terminal.

### `POST /api/sessions/:id/background` `{ toolUseId?: string }` → `{ backgrounded: boolean }`
The terminal's Ctrl+B: `backgroundTasks(toolUseId)`. With `toolUseId` it moves the one foreground Bash command or
subagent started by that `tool_use` block to the background; without it, every foreground task. The blocking tool call
returns at once with a "running in the background" `tool_result`, the turn continues, and the task reports through
`system/task_*` messages. `backgrounded: false` when `toolUseId` matched no foreground task (it already finished, for
example). Profile `standard`+. `409 SESSION_NOT_LIVE` when not live. `501 FEATURE_DISABLED` when background tasks are
disabled for the runtime (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` set to a non-empty value other than `0`/`false` in the
environment the gateway was started with, which the runtime inherits; `Config.backgroundTasksDisabled`), checked
before the call. Other failures → `502 ENGINE_ERROR`.

### `POST /api/sessions/:id/settings` `{ model?: string|null, permissionMode?: PermissionMode, effort?: EffortLevel|null, fastMode?: boolean|null }`
Applies to the live query (`setModel`, `setPermissionMode`, `applyFlagSettings({effortLevel})`,
`applyFlagSettings({fastMode})`); if not live, stored for the next open. `bypassPermissions` requires feature + profile.
→ `{ live: LiveInfo | null }`
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
```
→ `{ ok: true }`. Mapping to the SDK: permission allow → `{behavior:'allow', updatedInput: updatedInput ?? input,
updatedPermissions?}`; deny → `{behavior:'deny', message: message || 'The user denied this action', interrupt?}`;
question → allow with `updatedInput: {...input, answers, response?}`, decline → deny; plan approve → allow then
`setPermissionMode(nextMode)` when given, reject → deny with the feedback message.

### `GET /api/sessions/:id/context` → `SDKControlGetContextUsageResponse` (`409 SESSION_NOT_LIVE` if not live)
Control calls to the runtime time out after 10 s (`502 ENGINE_ERROR`; capabilities fall back to `stale: true`).
When the runtime reports rejected credentials (`system/api_retry` or an assistant `error` of an authentication class)
the gateway publishes a `notice` with code `ENGINE_UNAVAILABLE` and sets `LiveInfo.error`.

### `GET /api/sessions/:id/capabilities`
```ts
{ stale: boolean, commands: SlashCommand[], models: ModelInfo[], agents: AgentInfo[], account: AccountInfo | null,
  mcpServers: McpServerStatus[], outputStyle: string | null, availableOutputStyles: string[] }
```
Live sessions return fresh data (cached ≤ 30 s, commands refreshed by `commands_changed`). Non-live sessions return the
last known capabilities for the same cwd (or the last known globally) with `stale: true`, or empty lists.

### `POST /api/sessions/:id/mcp` `{ server: string, action: 'toggle'|'reconnect', enabled?: boolean }` → `{ mcpServers }`
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
