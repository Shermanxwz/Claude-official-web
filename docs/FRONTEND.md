# Frontend contracts

Vanilla ES modules served as-is (no bundler, no framework). Strict CSP: scripts only from `'self'`, no inline script,
no `eval`, no `innerHTML` with untrusted data (use `h()`/`textContent`; Markdown goes through `renderMarkdown()` only).

## Files and owners

| Path | Purpose |
|---|---|
| `public/index.html` | shell: `<div id="app">`, loads `/css/app.css`, `/css/composer.css`, `/css/cards.css`, `/css/tools.css`, `/css/terminal.css`, `/js/main.js` |
| `public/css/app.css` | design tokens (CSS variables, light/dark), layout, shell components |
| `public/css/cards.css` | timeline, bubbles, work groups, request cards |
| `public/css/tools.css` | tool cards |
| `public/css/terminal.css` | terminal panel |
| `public/js/dom.js` | `h()`, `clear()`, `icon()` helpers (shared, already written) |
| `public/js/api.js` | HTTP + SSE client |
| `public/js/store.js` | app state container |
| `public/js/i18n.js` + `public/js/locales/*.js` | translations |
| `public/js/main.js` | bootstrap |
| `public/js/ui/*.js` | shell: app-shell, sidebar, header, composer, panels, login, new-session, dialog, toasts, menus |
| `public/js/markdown.js` | `renderMarkdown(text): HTMLElement` (marked + DOMPurify) |
| `public/js/timeline/model.js` | pure reducer: transcript + live SDK messages → render model (no DOM; unit-tested in Node) |
| `public/js/timeline/view.js` | renders the model, incremental updates |
| `public/js/timeline/tools/*.js` | one renderer per tool family |
| `public/js/timeline/requests.js` | permission / question / plan / elicitation cards |
| `public/js/timeline/rewind.js` | rewind + fork dialogs |
| `public/js/terminal.js` | terminal panel (xterm.js) |
| `public/js/ui/runtime-panels.js` | the Runtime panel: status, permission rules, hooks, memory, usage, skills, sandbox, settings, Claude in Chrome |
| `public/js/ui/account.js` | account section of Settings: Claude Code's own sign-in flow |
| `public/js/ui/devtools.js` | developer console: raw runtime views + bounded event log |
| `public/js/ui/quick-switcher.js` | ⌘K / Ctrl+K quick switcher: sessions, panels, GUI commands |
| `public/js/ui/side-question.js` | `/btw` side-question overlay above the composer |
| `public/js/ui/activity.js` | running line (activity, elapsed time, output tokens) and the pinned todo bar above the composer |
| `public/js/context.js` | context meter and compaction: ring, tooltip, divider texts, elapsed time (pure) |

Owners in this round: **shell** (`app-shell.js`, `api.js`, `store.js`, `main.js`, `sidebar.js`, `panels.js`,
`dialog.js`, `menu.js`, `toasts.js`, `login.js`, `runtime-panels.js`, `account.js`, `devtools.js`,
`quick-switcher.js`, `locales/*.core.js`, `css/app.css`, `test/e2e/helpers.mjs`) and **conversation**
(`composer.js`, `composer-logic.js`, `header.js`, `new-session.js`, `side-question.js`, `activity.js`, `timeline/**`,
`locales/*.composer.js`, `*.cards.js`, `*.tools.js`, `css/composer.css`, `cards.css`, `tools.css`). The conversation
owner reaches shell behavior only through the `actions` contract below.

Vendored libraries are served by the gateway from `node_modules`:
`/vendor/marked.esm.js`, `/vendor/purify.es.mjs`, `/vendor/xterm/xterm.mjs`, `/vendor/xterm/xterm.css`,
`/vendor/xterm/addon-fit.mjs`.

## Shared helpers (`public/js/dom.js`)

```js
h(tag, props?, ...children) // props: {class, dataset:{}, attrs:{}, on:{click: fn}, style:{}, text, title, ...DOM props}
clear(el)                    // remove all children
icon(name)                   // returns <span class="icon icon-<name>" aria-hidden="true"> (CSS draws it)
```

## i18n (`public/js/i18n.js`)

```js
t(key, vars?) -> string      // `{name}` placeholders; missing key → key itself
getLocale() -> 'en'|'zh-CN'; setLocale(locale); onLocaleChange(fn) -> unsubscribe
registerMessages(locale, messages)  // locales/*.js call this; files: en.core.js, zh-CN.core.js (shell),
                                    // en.cards.js, zh-CN.cards.js (timeline), en.terminal.js, zh-CN.terminal.js
```
Default locale: saved preference, else `navigator.language` starting with `zh` → `zh-CN`, else `en`. Keys are
namespaced: `shell.*`, `cards.*`, `terminal.*`, `common.*` (shell owner defines `common.*`).

## API client (`public/js/api.js`)

```js
class ApiError extends Error { status; code; retryAfter }
api.get(path, {signal}?) / api.post(path, body?) / api.patch(path, body) / api.put(path, body) / api.del(path)
                                                   // JSON in/out, throws ApiError
api.upload(cwd, file /* File|Blob */, name) -> Promise<{path,name,size,mediaType,kind}>
connectEvents({ watch, after, onEvent(type, data), onStatus(status /* 'connecting'|'open'|'closed' */) })
  -> { close(), reconnect({watch, after}) }
```
`401 UNAUTHENTICATED` anywhere → `store.set({auth: {authenticated:false}})` (shows login). SSE reconnect uses
exponential backoff 1 s → 30 s, resets on `hello`. On `resync` or bootId change the app reloads the snapshot of the
current session and the session list.
Startup failures: `startupFailureText` picks `cards.startup.<reason>` for a listed `startup_failure_reason` (the
timeline notice, header tooltip and shell toast use it); other reasons show `cards.startup.unknown`.

## Store (`public/js/store.js`)

```js
store.get() -> state; store.set(partial); store.update(fn); store.subscribe(fn) -> unsubscribe
state = {
  auth: { authenticated, authRequired, profile },
  meta: <GET /api/meta> | null,
  connection: 'connecting'|'open'|'closed',
  sessions: SessionSummary[],             // sidebar
  live: { [sessionId]: LiveInfo },        // from session_state events
  pending: { [sessionId]: PendingRequest[] },
  currentSessionId: string | null,
  capabilities: { [sessionId]: Capabilities },
  account: { account: AccountInfo|null, signInPending: boolean } | null,   // GET /api/account, account_changed
  prefs: { theme: 'system'|'light'|'dark', locale, fontSize: 'sm'|'md'|'lg', notify: boolean, sidebarOpen: boolean },
}
```
Prefs persist in `localStorage` (wrapped in try/catch).

## Timeline integration

`public/js/timeline/view.js` exports:
```js
createTimeline({ container, api, store, t }) -> {
  load(sessionId): Promise<void>,   // GET /api/sessions/:id + /messages?tail=200, renders, returns seq for SSE `after`
  applyEvent(type, data),           // the shell forwards every SSE event; timeline filters by current session
  addOptimisticUserMessage({ clientMessageId, text, attachments }),
  loadOlder(): Promise<void>,
  destroy() }
```
`load()` resolves to `{ seq }` so the shell can (re)connect SSE with `after=seq`.
`createTimeline` also takes `onTodos(todos|null)` and `onActivity(activity|null)` callbacks, which the shell forwards
to the composer (`setTodos`, `setActivity`):
```js
todos = [{ content: string, activeForm: string, status: 'pending'|'in_progress'|'completed' }]  // latest TodoWrite of
                                     // the main thread in the current session; null when none
activity = { running: true, startedAt: number /* ms epoch of the turn's first event */, text: string|null
             /* system/task_summary or the running tool, e.g. "Reading src/app.js" */, outputTokens: number
             /* sum of message_delta usage.output_tokens of the turn's main-thread messages */ }  // null when idle
```
`applyEvent('message_cancelled', {sessionId, clientMessageId})` removes that queued user message from the model.
Pending request cards are part of the timeline (rendered at the bottom of the current turn, sticky above the composer
on mobile) and answered via `POST /api/sessions/:id/requests/:rid`.

The shell owns header, sidebar, composer, panels and dialogs; the timeline owns everything inside the scrolling
conversation area. `public/js/ui/dialog.js` exports `openDialog({ title, body /* Node */, actions: [{label, kind:
'primary'|'danger'|'secondary', onClick}] , onClose }) -> { close() }` and `confirmDialog({title, message, danger})
-> Promise<boolean>` for both owners.

## Shell composition

`public/js/ui/app-shell.js` creates the layout and wires the parts. Factories (all return `{ destroy() }` plus the
listed methods):

```js
createSidebar({ container, api, store, t, actions })                    // sessions, projects, search, new session
createHeader({ container, api, store, t, actions }) -> { setSession(sessionId|null), toggleFast() -> boolean }
createComposer({ container, api, store, t, actions }) -> { setSession(sessionId|null), focus(), insertText(text),
                                                            setSuggestion(text|null), setTodos(todos|null),
                                                            setActivity(activity|null), setText(text) }
createTimeline({ container, api, store, t, actions, onTodos, onActivity })   // see below
createTerminalPanel({ container, api, store, t }) -> { open({sessionId}|{cwd}), close(), isOpen() }
openPanel(name, { api, store, t, actions }, opts)   // panels.js: 'session'|'capabilities'|'context'|'tasks'|'settings'
                                                    // |'runtime'|'developer'; opts: { tab?, section? }
```

`actions` is created once by the shell and passed to every part:

```js
actions = {
  selectSession(sessionId),            // switch view, reload timeline, reconnect SSE with watch + after
  newSession(),                        // opens the new-session dialog
  sendMessage({ text, attachments, clientMessageId }),  // reuses clientMessageId when given (retry of a lost
                                       // response must not duplicate the turn), else crypto.randomUUID(); POST
  interrupt(),                         // POST /interrupt for the current session
  updateSettings({ model, permissionMode, effort, fastMode }),   // any subset; fastMode: true|false|null
  openRewind(userMessageId?), openFork(upToMessageId?),   // timeline/rewind.js dialogs; Rewind is disabled while
                                       // a turn runs or a request waits (the gateway answers 409 CONFLICT then, and
                                       // the dialog shows that message)
  openTerminal(), openPanel(name), renameSession(), toast(message, level = 'info'),
  confirmEndBackground(sessionId) -> Promise<boolean>,  // asks before close, terminal, trust restart or conversation
                                       // rewind while LiveInfo.backgroundTasks > 0 (ending the query stops them)
  toggleFastMode() -> boolean,         // the header's fast toggle (false when not offered); used by `/fast`
  insertIntoComposer(text),            // e.g. prompt suggestions, file mentions
  // ---- added in this round (implemented by the shell owner in app-shell.js) ----
  openPanel(name, opts?),              // opts: { tab?: string, section?: string } (see openPanel)
  interrupt({ cancelQueued } = {}),    // POST /interrupt; returns the receipt; cancelled ids leave the timeline
  cancelQueued(clientMessageId) -> Promise<boolean>,   // DELETE /queued/:id; true when the runtime dropped it
  sideQuestion(question) -> Promise<{ response, synthetic, refusalFallback }>,   // POST /side-question
  exportConversation() -> Promise<void>,   // GET /export, then saves `filename` (Blob + a[download]); toasts
  showTaskOutput(taskId),              // opens the task output viewer (GET /tasks/:taskId/output, refresh button)
  cyclePermissionMode() -> PermissionMode|null,   // Shift+Tab, like the terminal: default → acceptEdits → plan →
                                       // auto → bypassPermissions (only when meta.features.bypass) → default; from
                                       // any other mode (dontAsk, unknown, null) to acceptEdits; updateSettings;
                                       // returns the new mode (null when no live/known session or profile read)
  openQuickSwitcher(),                 // ⌘K / Ctrl+K
  restartSession() -> Promise<void>,   // close + open the current session (after memory edits, fallback model)
}
```

Locale files per owner: `en.core.js`/`zh-CN.core.js` (shell: app-shell, sidebar, login, dialogs, panels, toasts),
`en.composer.js`/`zh-CN.composer.js` (header + composer + palettes), `en.cards.js`/`zh-CN.cards.js` (timeline),
`en.tools.js`/`zh-CN.tools.js` (tool cards), `en.terminal.js`/`zh-CN.terminal.js`. `main.js` imports all of them. CSS per owner: `app.css` (shell), `composer.css`
(header + composer), `cards.css` (timeline), `tools.css` (tool cards), `terminal.css`; `index.html` links all five.

## Timeline model rules (`public/js/timeline/model.js`)

Input sources: transcript `SessionMessage[]` (with `index`), the snapshot `liveEvents`, then live `sdk` events.

1. Entries are keyed by `uuid`; a message with a uuid already present is ignored (transcript/live overlap) — except
   that an assistant message whose uuid is already present still settles streaming state: a draft with the same
   `message.id` counts its blocks as finalized exactly as if the message were new. Reloading a session whose snapshot
   `liveEvents` replay the stream (`stream_event`s) of a message the transcript already holds must not leave a draft
   ("generating…" with raw partial JSON) on screen. Covered by unit tests built from a real snapshot shape:
   transcript `[user, assistant(text, id X), assistant(tool_use ExitPlanMode, id X)]` plus `liveEvents`
   `[system/init, …, stream_event message_start(X) … content_block_* … message_stop, assistant(text, X),
   assistant(tool_use, X)]` while a plan request is pending.
   `message_cancelled` removes the queued user message with that `clientMessageId` (no row is left).
2. Assistant messages: consecutive assistant entries with the same `message.id` render as one bubble; blocks are
   `text` (Markdown), `thinking`/`redacted_thinking` (collapsed "Thinking" disclosure; a block whose text is empty —
   summaries off, or redacted — renders as a muted, non-expandable "Thinking" label instead of an empty disclosure),
   `tool_use` (tool card), `server_tool_use` / `web_search_tool_result` (web search card), anything else → generic
   block.
3. Streaming: `stream_event` messages with `parent_tool_use_id === null` build a draft keyed by the message id from
   `message_start`; `content_block_start/delta/stop` update `draft.blocks[index]` (`text_delta`, `thinking_delta`,
   `input_json_delta` → raw partial JSON shown as text). When a final assistant message with the same `message.id`
   arrives, `draft.finalized += content.length` and only `draft.blocks.slice(finalized)` stay visible. Drafts are
   cleared on `result`, on `message_stop` once all blocks are finalized, and on interrupt.
4. Tool results: `tool_result` blocks inside user messages are attached to the tool card with the same `tool_use_id`
   (never shown as user bubbles). Live `SDKUserMessage.tool_use_result` (structured output) is attached as
   `structured` for richer rendering when present.
5. Subagents: messages whose `parent_tool_use_id` is an `Agent`/`Task` tool_use id are nested inside that card
   (collapsed list), not in the main flow.
6. Work process: between a user message and the next user message, tool cards and progress rows are grouped into
   collapsible "work" groups placed in order between assistant text blocks. A group is expanded while the turn is
   running and collapsed after `result`. `tool_use_summary` messages provide the group label
   (`preceding_tool_use_ids`). Default label: "N steps".
7. User messages: text and image blocks render as the user's bubble (images as thumbnails of the base64 data); the
   optimistic message (keyed `clientMessageId`) is replaced by the first live/transcript user message with the same
   uuid, or with identical text in the same session if no uuid match arrives. Messages with `isSynthetic` or
   system-reminder-only content render as muted notes. A sent message's turn stays pending until the session reports
   `running` (or `requires_action`): a session reopened by its first message reports `starting`, then `idle` once
   Claude Code is ready, before it takes the message, and that `idle` must not end the turn, or the messages that name
   no user message (a compaction's boundary and summary, notices) would land in a new turn after it.
8. System / event messages:
   - `system/init`: no row (header data). `system/compact_boundary`: the divider of the compaction (see
     "Context meter and compaction").
   - `system/status`: `compacting` starts the compacting row; a status with no value ends it (a success keeps the row
     for its boundary); `compact_result: 'failed'` adds the error notice. The status is only recorded (`getRunState()`);
     no header or running-line text shows it. `system/api_retry`: muted inline notice.
   - `system/local_command_output`: monospace "Command output" card.
   - `system/informational`: inline notice styled by `level`. `system/notification`: toast (shell) + nothing inline.
   - `system/permission_denied`: red inline row. `system/hook_*`: rows inside the work group (errors highlighted).
   - An `assistant` message with `supersedes` (the fallback model's retry) evicts the listed messages on arrival —
     assistant bubbles and tool cards whose `tool_use` or `tool_result` came in them — without a marker; it is their
     replacement.
   - `system/model_refusal_fallback` (sent at the end of the turn): warning-styled inline notice with `content`
     (unstable prose: display only). Every entry still shown whose uuid is in `retracted_message_uuids` stops rendering
     its content and becomes one muted "Response withdrawn" row (tool cards included). A session-scope notice drops a
     streaming draft that is still open; `scope: 'local'` (a subagent or side question fell back) leaves the main draft
     alone and renders the notice inside the work group.
   - `system/model_refusal_no_fallback`: warning-styled inline notice with `content`; when
     `refused_user_message_uuid` is set the notice offers "Edit and retry", which calls
     `actions.openRewind(refused_user_message_uuid)`.
   - `system/plugin_install`: muted row per message — started "Installing plugins…", installed "Installed plugin
     {name}", failed (warning) "Could not install {name}: {error}", completed "Plugin installation finished." (the
     locale files hold the exact strings, including the variants without a name).
   - `system/elicitation_complete`: muted row "{mcp_server_name}: request completed in the browser". Pending request
     cards are owned by the gateway and are not changed by it.
   - `system/task_*`: background task rows + feed the background tasks panel (shell reads from store).
   - `system/memory_recall`, `system/files_persisted`, `system/thinking_tokens`, `system/session_state_changed`,
     `system/commands_changed`, `system/background_tasks_changed`, `system/control_request_progress`: no inline row
     (state only), except memory recall → muted row.
   - `conversation_reset`: divider "Conversation cleared".
   - `rate_limit_event`: banner (shell) when status ≠ `allowed`.
   - `prompt_suggestion`: suggestion line above the composer (shell), latest only.
   - `auth_status`: banner.
   - `result`: turn footer (duration, turns, error subtype + `errors[]` in red for error results, permission denials).
     A result whose `terminal_reason` starts with `aborted` is shown as a neutral "Interrupted" footer, not an error.
   - Runtime bookkeeping messages observed from Claude Code 2.1.x render no row: `command_lifecycle` updates the
     status of the user message whose uuid equals `command_uuid` (queued → sent); `system/task_summary` sets the live
     activity text beside the running indicator; `system/post_turn_summary`, `system/session_title_changed` (the shell
     updates the title), `active_goal` and `autocompact_state` are state only.
   - Any other type/subtype is kept as a diagnostic generic entry (never thrown away, never throws) and rendered as a
     collapsed JSON row only when Settings → "Show runtime events" (`prefs.showRuntimeEvents`) is on.

9. Pending request cards (`requests.js`) gain kind `dialog` (`dialog.dialogKind === 'refusal_fallback_prompt'`): a
   warning-styled card "{originalModel} declined this request" with `guidanceText` (plain text) and three actions:
   "Retry with {fallbackModel}" (`retry_fallback`, primary), "Edit prompt" (`edit_prompt`: after the answer the
   composer receives the text of the user message that started the turn via `composer.setText`), "Cancel"
   (`cancelled`). When the request resolves, entries whose uuid is in `retractedMessageUuids` are evicted without a
   marker (as for `supersedes`). Keys 1/2/3 answer it like the permission card.

## Context meter and compaction (`public/js/context.js`)

Data flow: `LiveInfo.context` (`ContextMeter`, docs/PROTOCOL.md "Context meter and compaction") arrives in each
`session_state` event and in the session snapshot. Nothing polls it. Four readers use it:

- Header ring (`ui/header.js`, `button.ctx-meter`): `meterView` gives the fill, tone and tick; the tooltip and
  `aria-label` come from `meterTooltip` (en and zh-CN; automatic, off, compacting and no-sentence variants). The fill
  eases over 400 ms (`@property --ctx-pct`). `is-compacting` turns the ring into a sweep. Hidden while `used` or `max`
  is null.
- Tones (`meterTone`): `normal` below 85 % of the automatic point (of the window when automatic compaction is off),
  `attention` from there, `danger` from 95 % of the window. The tick marks the automatic point.
- Compacting row and divider (`timeline/model.js`, `timeline/view.js`). The runtime streams a compaction in this order
  (verified on Claude Code 2.1.295): `system/status` `compacting`; `system/status` with no value and `compact_result:
  'success'` (or `'failed'`); `system/init` (manual only); `system/compact_boundary` with the sizes; the summary as a
  synthetic user message; for `/compact`, a "Compacted" command output. An automatic compaction in the middle of a turn
  has the same order without `init` and the output. `compacting` adds one live row at the end of the turn (glyph, label,
  elapsed, slim bar). A success keeps the row, and the boundary turns that same entry into the finished divider in
  place. A status with no value that is not a success, or a failed one, removes the row; a failed one keeps the
  failed-compaction notice. Closing the turn removes a row still waiting for its boundary. `compactionText` writes the
  divider, dropping missing parts.
- Summary (`addSummary`): a transcript marks the summary `isCompactSummary`; on the live stream it is the first
  synthetic main-thread user message after a boundary (`summaryDue`). Any later main-thread user message ends that wait,
  so a synthetic message after it stays a muted `user-meta` note. The summary is a collapsed `compact-summary` note
  after its divider. A summary with no divider before it (a transcript starts at the last compaction) gets a plain
  divider first, with null sizes. A compaction still waiting for its boundary turns its row into that divider.
- Sizes after a reload (`lastCompactionDetails`, `timelineItems`): the transcript names no sizes, so the last compact
  divider with null sizes takes `LiveInfo.context.lastCompaction`. Only the last compact divider is looked at; the
  enriched one has the reconcile key `${key}|${lastCompaction.at}`, so it is rebuilt when the sizes arrive.
- Replayed boundary (`transcriptUuids`): the uuid of every transcript record is kept, shown or not. The SDK's
  transcript keeps a boundary as a system record without its subtype, which shows nothing, so the snapshot's copy of
  that boundary (with its subtype) would add a second divider at the end of the turn. A replayed boundary whose uuid the
  transcript holds therefore adds no divider; it ends the compaction row the replayed status started.
- Snapshot replay (`replayedEvents`): the transcript of a compacted session starts at its last boundary, while the
  snapshot holds the events of the whole query (up to 2 000). When the page is the start of the chain and its first
  record is a system record, `load()` replays the snapshot from that record's copy on; the events before it belong to
  the conversation the compaction replaced and would otherwise land after the transcript, out of order.
- Reload in the middle of a compaction: the snapshot's live events carry no time, so their row has `since` null. The row
  and the running line then count from the session's start, `LiveInfo.context.compacting.since`, which is on the
  gateway's clock: `load()` keeps `clockOffset` (the snapshot's `now` minus this browser's clock) and
  `sessionCompactingStart` subtracts it. While `context.compacting` is set and no row is shown, a compacting row is
  drawn at the end of the conversation, and the running line shows the compaction even when the model knows no running
  turn (`activityOf`).
- Running line (`ui/activity.js`): "Compacting the conversation (N s)" while a compaction runs; the start is the row's,
  or the session's (`compactingStart`).
- Context panel (`ui/panels.js`): the live section above the breakdown reads `live.context`; the breakdown still comes
  from `GET /api/sessions/:id/context?detail=full`.

Reduced motion (`prefers-reduced-motion: reduce`): the ring fill is immediate and the sweep stops at a static 30 % arc;
the compacting row's bars stop at half opacity; the running line and header spinners stop. The elapsed seconds keep
counting. Locale keys: `header.context.tip.*`, `shell.context.*`, `cards.divider.*`, `cards.compacting.*`,
`composer.activity.compacting`.

## Tool renderers (`public/js/timeline/tools/`)

Each module exports `render(card, ctx) -> HTMLElement` where
`card = { id, name, input, result?: { content, isError }, structured?, children?: Entry[], running: boolean,
pendingRequestId?: string }` and
`ctx = { t, renderMarkdown, sessionId, cwd, renderChildren(entries) -> HTMLElement, open: boolean,
background?: (toolUseId) -> Promise<void> }`. `background` is present only when the session is live, the profile is
not `read` and `meta.features.backgroundTasks` is true; `bash.js` (Bash) and `agent.js` (Agent/Task) render a "Run in background" button (icon `layers`) on a card
that is `running`, has no result and whose input does not set `run_in_background: true`. It calls
`POST /api/sessions/:id/background {toolUseId}`; `backgrounded: false` → info toast "This task is no longer running in
the foreground"; errors → error toast. The button disables itself while the request runs.
`tools/shell.js` exports `toolShell({ iconName, title, subtitle, status: 'running'|'done'|'error'|'waiting', body,
open })` used by every family so all cards share one look (header row: icon, title, monospace subtitle, status
badge; body collapsible via a `<details>` element). Tool cards are styled in `public/css/tools.css`; their strings
live in `en.tools.js` / `zh-CN.tools.js`. The timeline (`view.js`) re-renders a card when its result arrives.
Families: `bash.js` (Bash, BashOutput, KillShell/TaskStop, Monitor), `file.js` (Read, Write, Edit, MultiEdit,
NotebookEdit — Edit/Write show a unified diff computed from `old_string`/`new_string` or `structuredPatch`),
`search.js` (Grep, Glob, LS), `web.js` (WebFetch, WebSearch), `agent.js` (Agent/Task with nested children),
`todo.js` (TodoWrite checklist), `plan.js` (ExitPlanMode, EnterPlanMode), `mcp.js` (`mcp__<server>__<tool>`),
`generic.js` (fallback). `tools/index.js` exports `renderTool(card, ctx)` choosing the family by name.
MCP results (`mcp.js`, also used for the browser server's and Claude in Chrome's tools) render `image` content blocks
(`{type: 'image', source: {type: 'base64', media_type, data}}` or MCP `{type: 'image', data, mimeType}`) as images
(`data:` URL built only for `image/png|jpeg|gif|webp`, max 5 MiB decoded, click opens a full-size view in a dialog)
and text blocks as text; other block types fall back to the generic JSON view.
Tool inputs follow `node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts`.

## Design tokens (defined once in `app.css`, used by every stylesheet)

Colors: `--bg`, `--bg-elev` (cards, menus), `--bg-sunken` (code, inputs), `--bg-hover`, `--fg`, `--fg-muted`,
`--fg-subtle`, `--border`, `--border-strong`, `--accent`, `--accent-fg` (text on accent), `--accent-soft`, `--danger`,
`--danger-soft`, `--warning`, `--warning-soft`, `--success`, `--success-soft`, `--info`, `--info-soft`,
`--diff-add-bg`, `--diff-del-bg`, `--focus-ring`.
Shape and type: `--radius-sm` (6px), `--radius-md` (10px), `--radius-lg` (14px), `--shadow-sm`, `--shadow-md`,
`--font-sans` (system UI stack + "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC"),
`--font-mono` (ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace), `--fs-xs/sm/md/lg/xl`,
`--space-1`…`--space-6` (4, 8, 12, 16, 24, 32 px), `--header-h` (52px), `--sidebar-w` (280px),
`--content-max` (760px, timeline + composer width), `--fs-scale` (Settings → Text size: .93 / 1 / 1.13; every
font size is a token or `calc(Npx * var(--fs-scale))`, see docs/DESIGN.md).
Themes: `:root` = light, `:root[data-theme="dark"]` = dark, and `@media (prefers-color-scheme: dark)` applies dark
when `data-theme="system"`. Neutral greys with a teal/indigo accent; never Anthropic's or Claude Code's brand colors.

Icons: `icon(name)` renders `<span class="icon icon-NAME">`; `app.css` maps each name to
`/img/icons/NAME.svg` via `mask-image` with `background-color: currentColor` (so icons follow text color). Available
names: send, stop, plus, menu, close, chevron-right, chevron-down, search, folder, file, terminal, settings, sun, moon,
monitor, copy, check, x, alert, info, edit, trash, fork, rewind, refresh, plug, cpu, shield, gauge, clock, user, bot,
tool, image, paperclip, external, more, logout, globe, list, spark, layers, play, lock, unlock, brain, download,
command, at.

## Unattended mode

The gateway's unattended switch (docs/PROTOCOL.md, "Unattended mode") is gateway-wide. The state lives in
`store.unattended` (`UnattendedState`): read from `meta.features.unattended` at boot, refreshed by `unattended_changed`
and by the answer to `PUT /api/unattended`, and read again when Settings opens. The newer state by `changedAt` wins
(`newerUnattended`), so an answer to an older request cannot undo a change; a gateway restart (new `bootId`) takes its
state as it is.

- **Switch**: Settings → Permissions (`panels.js`, the `permissions` section that the header's pill opens). Turning
  it on asks first (`openDialog`, the primary button switches it); turning it off needs no question. Only the full
  access profile may switch it; other profiles and an unavailable gateway see it disabled with the reason
  (`unattendedSwitch`). A failed write is a toast.
- **Indicators while it is on**: the header's attention-toned pill (`hdr-unattended`, icon only on phones), the
  header's permission select and the overflow's permission item disabled with the reason as tooltip, and the
  composer's mode label "Unattended — no approvals". Shift+Tab and the composer's mode menu do nothing
  (`modeCycleAllowed`).
- **Attention**: `store.attention` counts, per session, the requests that have waited for the user for
  `ATTENTION_DELAY_MS` (300 ms, `unattended.js`). The sidebar badge, the header's "Needs you" and the document title
  read it; a session whose only request is answered inside the delay stays "running". A desktop notification fires
  when a request settles, never for one answered sooner. The timeline's pending list follows the same rule: a request
  enters the render only when it settles (`model.addPending`, `settlePending`).
- **Automatic answers**: `request_resolved` with `auto: true` leaves one muted `auto` record in the timeline (`autoEl`
  in `timeline/view.js`) instead of a card: "Allowed automatically (unattended)" with the tool and its target, the
  question collapsed under "Question answered automatically", "Plan approved automatically", "Form declined
  automatically" with the server, or "Not retried on the fallback model (unattended)". Records last for the page's
  lifetime; a reload shows the transcript and the live events only.

## UX requirements

- Desktop: sidebar (sessions grouped by project, search, new session), header (title, cwd, model, permission mode,
  effort, context meter, state badge, menu), timeline, composer. Mobile (< 768 px): sidebar is an off-canvas drawer,
  header compacts into an overflow menu, composer stays at the bottom with safe-area insets, touch targets ≥ 44 px.
- Composer: auto-growing textarea; Enter sends on desktop (Shift+Enter newline), button sends on touch devices; Stop
  button while running (interrupt); `/` opens the command palette (SDK commands + GUI commands `/model`,
  `/permissions`, `/effort`, `/fast`, `/rewind`, `/fork`, `/rename`, `/mcp`, `/terminal`); a GUI command runs only when
  picked from the palette, typed text is always sent to the runtime unchanged; `@` opens file search; paste/drag
  images and files (uploaded first, shown as chips); draft text persisted per session in `localStorage`.
- Fast mode (header, next to effort; in the overflow menu on mobile): a toggle shown when the session's model supports
  fast mode (`ModelInfo.supportsFastMode` of the model row the model select matches) or whenever `LiveInfo.fastMode` is
  true or `fastModeState` is `'on'`/`'cooldown'`. Pressed = `fastMode === true`, or `fastMode === null` with
  `fastModeState === 'on'`. Clicking sends `updateSettings({fastMode: !pressed})`. States: `'on'` accent; `'cooldown'`
  warning label "Cooling down"; requested but `'off'` with a reason → muted with the localized reason in the tooltip
  (unknown reasons show the raw value). Tooltip: "Faster output from Claude Opus. Availability and billing depend on
  your plan." The GUI command `/fast` toggles the same control.
- Background tasks: when `LiveInfo.backgroundTasks > 0` the header shows a small badge "{n} background" that opens the
  Tasks panel.
- Capabilities panel: the "Output style" section lists `availableOutputStyles` in a select with the current
  `outputStyle`; changing it calls `POST /api/sessions/:id/output-style`, then updates the panel and toasts "Output
  style set to {style}". The select is disabled with the note "Trust this folder to change its output style." when
  `LiveInfo.trusted` is false, and with "Open the session to change its output style." when not live. A "Reload
  styles" button calls `POST /reload {what:'output-styles'}`. "Reload plugins" first calls `POST /reload
  {what:'plugins'}`; a `held` answer opens `confirmDialog` ("Reloading changes the tools this conversation uses, so
  the next reply cannot reuse the prompt cache." plus the added/removed MCP servers and the LSP change as plain text);
  confirming repeats the call with `force: true`.
- Accessibility: semantic buttons, `aria-label`s, visible focus, dialogs trap focus and close on Esc,
  `prefers-reduced-motion` respected, color contrast ≥ 4.5:1 in both themes.

### Conversation owner (composer, header, new session, timeline)

- Keyboard, as in the terminal: **Shift+Tab** in the composer calls `actions.cyclePermissionMode()` and shows the new
  mode for 2 s in the composer footer (the footer always shows the current mode in small text, e.g. "Asks before
  each action"); **Esc** in the composer while a turn runs (no palette, menu or dialog open) calls
  `actions.interrupt()`; **↑ / ↓** in an empty composer (caret at the start/end) walk this session's earlier prompts
  (user messages of the loaded transcript plus ones sent in this page, newest first; Esc or editing leaves history
  mode). Shortcuts are listed in the palette's footer hint.
- Running line (`activity.js`, above the composer while `activity` is set): an animated glyph (static when reduced
  motion), `activity.text` or "Working", elapsed time (`12s`, `1m 05s`), output tokens (`↓ 1.2k tokens`) and "Esc to
  stop" on desktop. Replaces the inline "Processing…" row of the timeline.
- Pinned todo bar (`activity.js`): when `todos` has items and not all are completed, or a turn is running, a one-line
  bar above the composer shows "{done}/{total}" and the `activeForm` of the item in progress; clicking expands the
  full checklist (statuses as icons). Hidden otherwise. Never covers a pending request card.
- Queued messages: a queued user bubble shows "Queued" plus a "Cancel" button → `actions.cancelQueued(id)`; true →
  the bubble disappears (the `message_cancelled` event does the same in other tabs); false → toast "This message
  already started". The Stop button gains a menu (secondary click, long press, or a small chevron): "Stop" and "Stop
  and clear the queue" (`actions.interrupt({cancelQueued: true})`), the latter shown only while a message is queued.
- Side question (`side-question.js`): the palette's GUI command `/btw` and typed text that starts with `/btw ` (only
  when the runtime's command list has no `btw`) open an overlay above the composer with the question, a spinner, then
  the answer as Markdown, a "Copy" button and "Close"; nothing enters the transcript; errors show inline. Only one at
  a time.
- New-session dialog: "Permission mode" defaults to "Follow Claude Code settings" (`permissionMode` omitted); an
  "Advanced" disclosure holds Agent (select from the capabilities' `agents`, default none; free text when no list is
  known), Additional directories (folder pickers inside the roots, removable chips), Fallback model (select from the
  model list or none) and, when `meta.features.browserTools` and the profile is `full`, "Browser tools" (checkbox).
- Header: shows the agent as a small chip next to the title when `LiveInfo.agent` is set.
- `@` suggestions pass `session=<id>` so the runtime's own index answers.
- Palette GUI commands (run only when picked, or `/btw` as above): `/model`, `/permissions` (Runtime panel →
  Permission rules), `/effort`, `/fast`, `/rewind`, `/fork`, `/rename`, `/mcp`, `/terminal`, `/status`, `/hooks`,
  `/memory`, `/usage` (Runtime panel → Usage; typing `/usage` still sends the runtime's own command), `/export`, `/btw`,
  `/login` (Settings → Account), `/add-dir` (Session panel → Directories), `/devtools` (Developer console). When the
  runtime offers a command with the same name, the palette lists both and marks the GUI one "Panel".

### Shell owner (panels, sidebar, account, developer console)

- Runtime panel (`openPanel('runtime', {tab})`, `runtime-panels.js`): tabs for the views `GET /runtime` lists —
  Status (sections as label/value rows), Permission rules (table: behavior badge, rule in monospace, source,
  description; note "Edit rules with /permissions in the terminal tab"), Hooks (events with counts, then hooks with
  matcher, type, command text in monospace, source label; disabled rows muted), Memory (each file: label, path,
  exists; editable ones open in a monospace textarea with Save → `PUT /memory`, then "Restart the session to apply"
  → `actions.restartSession()`), Usage (session cost, durations, lines changed; plan windows with utilization bars
  and reset times when `rate_limits_available`, otherwise "Plan limits do not apply to this sign-in"), Skills, Sandbox,
  Settings (profile `full`: effective settings as formatted JSON, then each source), Claude in Chrome (when
  `meta.features.chrome`). Every tab has Refresh, shows "Updated {time}", handles 409 with "Open the session" →
  `POST /open`, 501 with "Not offered by this Claude Code version — use the terminal tab", other errors inline.
  Values from the runtime are text, never HTML.
- Developer console (`openPanel('developer')`, `devtools.js`): a view picker over `GET /runtime/:view` showing the raw
  JSON (pretty-printed, copy button), and an event log of every SSE event this page received for the current
  session (`sdk` messages and gateway events): at most 200 entries and 1 MiB; an entry over 128 KiB is replaced by
  `{type, subtype, bytes}`; filter by type; Clear; cleared on reload. The log starts when the page loads, not when the
  panel opens.
- Quick switcher (`quick-switcher.js`, ⌘K / Ctrl+K anywhere, or the sidebar's search button): one list for sessions
  (title, project, relative time; fuzzy match on title and project), panels and GUI commands; ↑/↓/Enter/Esc; typing
  then "Search message text" runs `GET /api/sessions/search` and lists matches with snippets.
- Sidebar search: the filter box filters titles locally as before; when the query has 2+ characters a "Search all
  conversations" row runs the deep search and shows results with snippets (matches highlighted with `<mark>` built by
  DOM, never HTML strings). When the answer has `truncated: true`, both lists end with one muted line that names the
  answer's `scanLimit` ("Only the 50 most recent sessions were searched.").
- Session panel: Directories (list of `LiveInfo.additionalDirectories`, add with the folder picker, remove; applying
  restarts the session, confirm first when background tasks run), Agent (select; applies live), Fallback model
  (applies after restart; shows "Restart to apply" button), Browser tools (toggle; `full` profile and
  `meta.features.browserTools`), Export conversation (`actions.exportConversation()`).
- Tasks panel: each shell/Monitor task row gets "Show output" → `actions.showTaskOutput(taskId)`: a dialog with the
  output in monospace (keeps the end in view), "Showing the last 8 KB" when truncated, Refresh, auto-refresh every 2 s
  while the task runs.
- Settings → Account (`account.js`): signed-in account (email, organization, plan, API provider) or "Not signed in";
  for profile `full`: "Sign in with Claude account" and "Sign in with Anthropic Console"; the flow shows step 1 "Open
  the sign-in page" (link, opens a new tab, `rel="noopener noreferrer"`), step 2 a code field ("Paste the code shown
  after signing in"), Submit, Cancel; success → toast "Signed in as {email}" and the note "Reopen sessions to use the
  new sign-in". "Sign out" is not offered; the note points to `/logout` in the terminal tab.
- Capabilities → MCP: a `needs-auth` server row gets "Authenticate": shows the auth link (new tab) and a field "Paste
  the address of the page you land on" → `callback`; polls capabilities every 3 s for up to 5 minutes until the server
  is `connected`; rows with credentials offer "Clear authentication"; each row has "Permission override" (Default /
  Auto / None) with the hint that it only tightens bypass and auto modes.
- `message_cancelled` and `account_changed` are forwarded to the timeline / store.
- Never block the UI on a failed request: show a toast with the localized error and keep state consistent.
- Branding: product name comes from `meta.appName`; do not use "Claude Code" as the product name and do not imitate
  Claude Code visual assets.
