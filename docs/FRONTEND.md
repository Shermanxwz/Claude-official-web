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
api.get(path, {signal}?) / api.post(path, body?) / api.patch(path, body) / api.del(path)  // JSON in/out, throws ApiError
api.upload(cwd, file /* File|Blob */, name) -> Promise<{path,name,size,mediaType,kind}>
connectEvents({ watch, after, onEvent(type, data), onStatus(status /* 'connecting'|'open'|'closed' */) })
  -> { close(), reconnect({watch, after}) }
```
`401 UNAUTHENTICATED` anywhere → `store.set({auth: {authenticated:false}})` (shows login). SSE reconnect uses
exponential backoff 1 s → 30 s, resets on `hello`. On `resync` or bootId change the app reloads the snapshot of the
current session and the session list.

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
createHeader({ container, api, store, t, actions }) -> { setSession(sessionId|null) }
createComposer({ container, api, store, t, actions }) -> { setSession(sessionId|null), focus(), insertText(text),
                                                            setSuggestion(text|null) }
createTimeline({ container, api, store, t, actions })                   // see below
createTerminalPanel({ container, api, store, t }) -> { open({sessionId}|{cwd}), close(), isOpen() }
openPanel(name, { api, store, t, actions })   // panels.js: 'session'|'capabilities'|'context'|'tasks'|'settings'
```

`actions` is created once by the shell and passed to every part:

```js
actions = {
  selectSession(sessionId),            // switch view, reload timeline, reconnect SSE with watch + after
  newSession(),                        // opens the new-session dialog
  sendMessage({ text, attachments }),  // generates clientMessageId (crypto.randomUUID), optimistic render, POST
  interrupt(),                         // POST /interrupt for the current session
  updateSettings({ model, permissionMode, effort }),
  openRewind(userMessageId?), openFork(upToMessageId?),   // timeline/rewind.js dialogs
  openTerminal(), openPanel(name), renameSession(), toast(message, level = 'info'),
  insertIntoComposer(text),            // e.g. prompt suggestions, file mentions
}
```

Locale files per owner: `en.core.js`/`zh-CN.core.js` (shell: app-shell, sidebar, login, dialogs, panels, toasts),
`en.composer.js`/`zh-CN.composer.js` (header + composer + palettes), `en.cards.js`/`zh-CN.cards.js` (timeline),
`en.tools.js`/`zh-CN.tools.js` (tool cards), `en.terminal.js`/`zh-CN.terminal.js`. `main.js` imports all of them. CSS per owner: `app.css` (shell), `composer.css`
(header + composer), `cards.css` (timeline), `tools.css` (tool cards), `terminal.css`; `index.html` links all five.

## Timeline model rules (`public/js/timeline/model.js`)

Input sources: transcript `SessionMessage[]` (with `index`), the snapshot `liveEvents`, then live `sdk` events.

1. Entries are keyed by `uuid`; a message with a uuid already present is ignored (transcript/live overlap).
2. Assistant messages: consecutive assistant entries with the same `message.id` render as one bubble; blocks are
   `text` (Markdown), `thinking`/`redacted_thinking` (collapsed "Thinking" disclosure), `tool_use` (tool card),
   `server_tool_use` / `web_search_tool_result` (web search card), anything else → generic block.
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
   system-reminder-only content render as muted notes.
8. System / event messages:
   - `system/init`: no row (header data). `system/compact_boundary`: divider "Context compacted".
   - `system/status`: header status text (compacting / requesting). `system/api_retry`: muted inline notice.
   - `system/local_command_output`: monospace "Command output" card.
   - `system/informational`: inline notice styled by `level`. `system/notification`: toast (shell) + nothing inline.
   - `system/permission_denied`: red inline row. `system/hook_*`: rows inside the work group (errors highlighted).
   - `system/task_*`: background task rows + feed the background tasks panel (shell reads from store).
   - `system/memory_recall`, `system/files_persisted`, `system/thinking_tokens`, `system/session_state_changed`,
     `system/commands_changed`, `system/background_tasks_changed`: no inline row (state only), except memory recall →
     muted row.
   - `conversation_reset`: divider "Conversation cleared".
   - `rate_limit_event`: banner (shell) when status ≠ `allowed`.
   - `prompt_suggestion`: suggestion chip above the composer (shell), latest only.
   - `auth_status`: banner.
   - `result`: turn footer (duration, turns, error subtype + `errors[]` in red for error results, permission denials).
     A result whose `terminal_reason` starts with `aborted` is shown as a neutral "Interrupted" footer, not an error.
   - Any other type/subtype → collapsed generic row showing the JSON (never throw).

## Tool renderers (`public/js/timeline/tools/`)

Each module exports `render(card, ctx) -> HTMLElement` where
`card = { id, name, input, result?: { content, isError }, structured?, children?: Entry[], running: boolean,
pendingRequestId?: string }` and
`ctx = { t, renderMarkdown, sessionId, cwd, renderChildren(entries) -> HTMLElement, open: boolean }`.
`tools/shell.js` exports `toolShell({ iconName, title, subtitle, status: 'running'|'done'|'error'|'waiting', body,
open })` used by every family so all cards share one look (header row: icon, title, monospace subtitle, status
badge; body collapsible via a `<details>` element). Tool cards are styled in `public/css/tools.css`; their strings
live in `en.tools.js` / `zh-CN.tools.js`. The timeline (`view.js`) re-renders a card when its result arrives.
Families: `bash.js` (Bash, BashOutput, KillShell/TaskStop, Monitor), `file.js` (Read, Write, Edit, MultiEdit,
NotebookEdit — Edit/Write show a unified diff computed from `old_string`/`new_string` or `structuredPatch`),
`search.js` (Grep, Glob, LS), `web.js` (WebFetch, WebSearch), `agent.js` (Agent/Task with nested children),
`todo.js` (TodoWrite checklist), `plan.js` (ExitPlanMode, EnterPlanMode), `mcp.js` (`mcp__<server>__<tool>`),
`generic.js` (fallback). `tools/index.js` exports `renderTool(card, ctx)` choosing the family by name.
Tool inputs follow `node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts`.

## Design tokens (defined once in `app.css`, used by every stylesheet)

Colors: `--bg`, `--bg-elev` (cards, menus), `--bg-sunken` (code, inputs), `--bg-hover`, `--fg`, `--fg-muted`,
`--fg-subtle`, `--border`, `--border-strong`, `--accent`, `--accent-fg` (text on accent), `--accent-soft`, `--danger`,
`--danger-soft`, `--warning`, `--warning-soft`, `--success`, `--success-soft`, `--info`, `--info-soft`,
`--diff-add-bg`, `--diff-del-bg`, `--focus-ring`.
Shape and type: `--radius-sm` (6px), `--radius-md` (10px), `--radius-lg` (14px), `--shadow-sm`, `--shadow-md`,
`--font-sans` (system UI stack + "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC"),
`--font-mono` (ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace), `--fs-xs/sm/md/lg/xl`,
`--space-1`…`--space-6` (4, 8, 12, 16, 24, 32 px), `--header-h` (52px), `--sidebar-w` (288px),
`--content-max` (880px, timeline + composer width).
Themes: `:root` = light, `:root[data-theme="dark"]` = dark, and `@media (prefers-color-scheme: dark)` applies dark
when `data-theme="system"`. Neutral greys with a teal/indigo accent; never Anthropic's or Claude Code's brand colors.

Icons: `icon(name)` renders `<span class="icon icon-NAME">`; `app.css` maps each name to
`/img/icons/NAME.svg` via `mask-image` with `background-color: currentColor` (so icons follow text color). Available
names: send, stop, plus, menu, close, chevron-right, chevron-down, search, folder, file, terminal, settings, sun, moon,
monitor, copy, check, x, alert, info, edit, trash, fork, rewind, refresh, plug, cpu, shield, gauge, clock, user, bot,
tool, image, paperclip, external, more, logout, globe, list, spark, layers, play, lock, unlock, brain, download,
command, at.

## UX requirements

- Desktop: sidebar (sessions grouped by project, search, new session), header (title, cwd, model, permission mode,
  effort, context meter, state badge, menu), timeline, composer. Mobile (< 768 px): sidebar is an off-canvas drawer,
  header compacts into an overflow menu, composer stays at the bottom with safe-area insets, touch targets ≥ 44 px.
- Composer: auto-growing textarea; Enter sends on desktop (Shift+Enter newline), button sends on touch devices; Stop
  button while running (interrupt); `/` opens the command palette (SDK commands + GUI commands `/model`,
  `/permissions`, `/effort`, `/rewind`, `/fork`, `/rename`, `/mcp`, `/terminal`); `@` opens file search; paste/drag
  images and files (uploaded first, shown as chips); draft text persisted per session in `localStorage`.
- Accessibility: semantic buttons, `aria-label`s, visible focus, dialogs trap focus and close on Esc,
  `prefers-reduced-motion` respected, color contrast ≥ 4.5:1 in both themes.
- Never block the UI on a failed request: show a toast with the localized error and keep state consistent.
- Branding: product name comes from `meta.appName`; do not use "Claude Code" as the product name and do not imitate
  Claude Code visual assets.
