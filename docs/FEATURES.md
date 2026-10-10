# Feature map

This page maps what Claude Code does in the terminal to the graphical surface of claude-official-web and to the SDK call
or message that implements it. The gateway never reimplements a capability. Each row is delegated to the Claude Code
runtime through the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`).

Terms used in the tables:

- **SDK call**: a method of the live `Query` object for one session, or an exported SDK function.
- **Message**: an SDK message `type` (and `subtype` where one exists) that the timeline renders.
- **Gateway**: an HTTP route or event defined in `docs/PROTOCOL.md`.

## Conversation

| Capability | Web surface | Mechanism |
|---|---|---|
| Streaming replies | Text appears while it is generated; the final message replaces the draft | `stream_event` messages (partial messages are requested with `includePartialMessages`), then `assistant` |
| Extended thinking | A collapsed "Thinking" block with the summary the runtime sends; a muted "Thinking" label when there is no text | `assistant` content blocks `thinking` and `redacted_thinking`. Summaries are requested with the runtime's `--thinking-display summarized` flag (`extraArgs`), because a non-interactive session ignores the `showThinkingSummaries` setting; a setting of `false` in any loaded settings file (read with `resolveSettings()`) is honored |
| Markdown and code | Sanitized Markdown with highlighted code blocks | Text blocks rendered by `renderMarkdown()` (marked and DOMPurify) |
| Tool use | One card per tool call, grouped into collapsible work steps | `assistant` `tool_use` blocks; results from `user` `tool_result` blocks |
| All tool families | Bash and BashOutput; Read, Write, Edit, MultiEdit and NotebookEdit with diffs; Grep, Glob and LS; WebFetch and WebSearch; Agent and Task; TodoWrite; plan tools; `mcp__<server>__<tool>`; a generic fallback | Tool names in `tool_use` blocks; structured results from `tool_use_result` when present |
| Subagents | The subagent's conversation nested inside its Agent or Task card | Messages with `parent_tool_use_id`; `listSubagents()` and `getSubagentMessages()` for history |
| Background tasks | Task rows in the timeline, a header badge with the count, and a background-tasks panel with a stop action | `system` `task_started`, `task_progress`, `task_updated`, `task_notification` and `background_tasks_changed`; `stopTask(taskId)` |
| Background task output | A viewer that shows what a shell or Monitor task printed; for long output, its end | `getTaskOutput()` through `GET /api/sessions/:id/tasks/:taskId/output` (the last 8 KiB when the output is longer) |
| Move to the background (Ctrl+B) | A "Run in background" button on a running Bash or Agent card | `backgroundTasks(toolUseId)`; `POST /api/sessions/:id/background` |
| Work summary | A group label such as "5 steps" | `tool_use_summary` messages |
| Turn footer | Duration, turn count, the error reason for failed turns and any permission denials | `result` message (`subtype` `success` or an error subtype; `permission_denials`) |
| Interrupt | Stop button while a turn runs; background tasks keep running, as after Esc in the terminal. The Stop menu's "Stop and clear the queue" also drops the queued messages | `interrupt()` on the query; every query declares `perTaskStopAffordance`. With `cancelQueued`, `POST /api/sessions/:id/interrupt` also cancels the queued messages (the runtime's `cancel_queued` interrupt) |
| Refusal fallback | When the model declines and the turn is retried on a fallback model, a notice explains it and the declined response is marked as withdrawn. Without a fallback, a notice offers "Edit and retry". A dialog on a refusal offers to retry on the fallback model, edit the prompt or cancel | `system` `model_refusal_fallback` (`retracted_message_uuids`) and `model_refusal_no_fallback` (`refused_user_message_uuid`). The dialog is `onUserDialog` with `supportedDialogKinds: ['refusal_fallback_prompt']`, answered with `result` set to `retry_fallback`, `edit_prompt` or `cancelled` |
| Plugin installation | A row for each installation step | `system` `plugin_install` messages |
| Queued input | A message sent during a turn shows as queued until the runtime echoes it. A queued message can be cancelled from its row | Input streaming: the runtime queues the user message; gateway event `message_accepted`. Cancelling calls `cancelAsyncMessage()` through `DELETE /api/sessions/:id/queued/:clientMessageId`, and the gateway publishes `message_cancelled` |
| Side question (`/btw`) | A question about the conversation, answered beside it. The answer is not added to the transcript | `askSideQuestion()`; `POST /api/sessions/:id/side-question`; one at a time per session |
| Compaction | A "Context compacted" divider and status text | `system` `compact_boundary` and `status` messages |
| API retries | A muted inline notice | `system` `api_retry` messages |
| Rejected sign-in | A notice on the session when Claude Code reports that its credentials were rejected, and an error in the session's status | `system` `api_retry`, or an assistant `error` of an authentication class; gateway notice code `ENGINE_UNAVAILABLE` and `LiveInfo.error` |

## Permissions and questions

| Capability | Web surface | Mechanism |
|---|---|---|
| Tool approvals | Permission card with allow once, allow always and deny (with an optional reason) | `canUseTool` callback creates a pending request; decision sent to `POST /api/sessions/:id/requests/:rid` |
| Permission suggestions | "Allow always" saves the ticked suggestions. Allow rules and session-only mode switches start ticked; directory grants, other mode changes, deny and ask rules start unticked | `PermissionUpdate` suggestions and `suggestionIndexes` in the decision; when it is absent, only `addRules` and `replaceRules` with behavior `allow` are saved |
| Questions | A question card with the offered options and free text (`AskUserQuestion`) | `canUseTool` for the `AskUserQuestion` tool; answers returned as `updatedInput.answers` |
| Plan mode | A plan card to approve (choosing the next permission mode) or reject with feedback | `ExitPlanMode` through `canUseTool`; `setPermissionMode(nextMode)` after approval |
| MCP elicitation | A form or link card asking an MCP server for input, and a muted row when a browser step completes | `onElicitation` callback; accept, decline or cancel with content; `system` `elicitation_complete` |
| Permission modes | Mode picker: default, acceptEdits, plan, auto and dontAsk. Shift+Tab cycles default, acceptEdits, plan and auto (and bypassPermissions when allowed); dontAsk is chosen from the picker | `setPermissionMode(mode)` for a live session through `POST /api/sessions/:id/settings`; `permissionMode` option when a session starts |
| Bypass mode | Offered only when the operator enabled it and the profile is `full` | `bypassPermissions`. `CAW_ALLOW_BYPASS=1` is refused at startup under `read` or `standard`; a request for the mode without the switch answers `501 FEATURE_DISABLED`. `CAW_DEFAULT_PERMISSION_MODE=bypassPermissions` also needs the switch |
| Denials | A red row for each denied tool call | `system` `permission_denied` messages; `result.permission_denials` |

## Model, effort and context

| Capability | Web surface | Mechanism |
|---|---|---|
| Model switching | Model picker in the header and in the session settings | `setModel(model)`; the choices come from `initializationResult().models` |
| Effort | Picker for low, medium, high, xhigh and max, for the current session. Typing `/effort <level>` runs Claude Code's own command, which also saves the level as the default | `applyFlagSettings({ effortLevel })` |
| Fast mode (`/fast`) | A "Fast" toggle when the model supports it, with the state Claude Code reports (on, cooling down, or why it is unavailable) | `applyFlagSettings({ fastMode })` in the session's flag layer; `supportsFastMode` in the model list; `fast_mode_state` and `fast_mode_disabled_reason` from `system` `init` and `result` |
| Context usage | A context meter and a panel with the breakdown | `getContextUsage()`; `GET /api/sessions/:id/context` with detail `summary` or `full` |
| Usage limits | A banner when a limit or warning applies | `rate_limit_event` messages |
| Prompt suggestions | A suggested next prompt above the composer | `prompt_suggestion` messages (`promptSuggestions` option) |
| Account | Account information reported by Claude Code | `initializationResult().account` |

## Commands and input

| Capability | Web surface | Mechanism |
|---|---|---|
| Slash commands from Claude Code | Command palette opened with `/`, listing built-in commands, skills, custom commands and MCP prompts | `initializationResult().commands`, refreshed by `system` `commands_changed`; the command is sent as a user message |
| Commands with a graphical equivalent | `/model`, `/permissions`, `/effort`, `/fast`, `/rewind`, `/fork`, `/rename`, `/mcp`, `/terminal`, `/status`, `/hooks`, `/memory`, `/usage`, `/export`, `/btw`, `/add-dir`, `/devtools` and `/login` open the matching control or panel when picked from the palette. Typed commands are always sent to Claude Code unchanged | Gateway actions that call the SDK methods listed in this table. `/login` opens Settings → Account, `/add-dir` the session's directories and `/devtools` the developer console |
| Commands that run inside the session | Output appears as a command-output card | Sent as a message; `system` `local_command_output` messages |
| File mentions with `@` | Fuzzy file search inside the session's directory | The runtime's `file_suggestions` control request is tried first, through the query's generic control call. The gateway's own search (`GET /api/fs/search`, containment-checked by the gateway) answers when the runtime cannot, for example with no live session or while it is still indexing |
| Images | Paste or drag an image; thumbnails in the composer and the timeline | `POST /api/attachments`; sent as base64 image blocks |
| Other files | Uploaded files shown as chips | Sent as `Attached file: <path>` text |
| Keyboard input | Multi-line composer; Enter sends on desktop and Shift+Enter starts a new line | `POST /api/sessions/:id/messages` |
| Prompt recall | Up walks back through the session's earlier prompts and Down forward again; the draft comes back at the end | Client-side, from the loaded transcript of the session |
| Drafts | Unsent text is kept for each session in the browser | Browser storage, as a per-viewer convenience |

## Sessions

| Capability | Web surface | Mechanism |
|---|---|---|
| Start a session | New-session dialog with a project directory, title and settings. Advanced fields: agent, fallback model, additional directories and browser tools | `query()` for a new session, with the `agent`, `additionalDirectories` and `fallbackModel` options (`--agent`, `--add-dir`, `--fallback-model`); the session is live until it is closed or idles out |
| Resume and open | Any saved session opens on demand | `query()` with `resume`; `POST /api/sessions/:id/open` |
| Session list | Sidebar grouped by project, with a filter and paging | `listSessions()`; `GET /api/sessions` |
| Transcript history | Older messages load when you scroll up | `getSessionMessages()` through the gateway's `before` and `limit` paging |
| Rename | A rename action | `renameSession(sessionId, title)` |
| Tag | A tag field in the session details | `tagSession(sessionId, tag)` |
| Fork | Fork the conversation at a message into a new session | `forkSession(sessionId, { upToMessageId })` |
| Rewind code | A dry-run preview, then restore the files to a chosen message | `rewindFiles(userMessageId, { dryRun })`; requires file checkpointing (`enableFileCheckpointing`). While a turn runs or a request waits, it answers `409 CONFLICT`, dry runs included (`POST /api/sessions/:id/rewind`) |
| Rewind conversation | Restart the conversation from an earlier message | Reopen with `resume` and `resumeSessionAt` set to the transcript entry before the chosen message |
| Delete | A delete action for saved sessions (`full` profile; not for live sessions) | `deleteSession(sessionId)` |
| Export | Export the conversation as a text file (`/export`) | `exportConversation()`; `GET /api/sessions/:id/export` returns the text and a file name |
| Session settings | Change the session's agent, additional directories, fallback model and browser tools. A fallback change applies at the next start, and a directory change restarts a live session | `POST /api/sessions/:id/settings`: `applyFlagSettings({agent})` for the agent; close and resume for directories; a stored value with `restartRequired` for the fallback model; `browserTools` (see Browser tools) |
| Search | Sidebar search and the quick switcher find conversations by title and by message text | `GET /api/sessions/search`: titles, summaries and first prompts from `listSessions()`, then the text of the 50 most recently modified transcripts that did not match, read with `getSessionMessages()` within 5 seconds. `truncated` says when not every session was read |
| Quick switcher | Ctrl+K (⌘K on a Mac) lists sessions by title, and finds messages by their text | Client-side; message matches come from `GET /api/sessions/search` |
| Single writer | While the terminal tab holds a session, the GUI cannot send, rewind, fork, delete or use live controls in it; rename, tag and settings for the next start still work | Gateway lock (`SESSION_LOCKED`); `terminal_state` events |

## Workspaces and folder trust

| Capability | Web surface | Mechanism |
|---|---|---|
| Directory browser | Lists the workspace roots and their sub-folders; project folders are marked | `GET /api/fs/dirs`; a folder counts as a project when it contains `.git`, `.claude`, `CLAUDE.md` or `package.json` |
| Trust status | An untrusted session shows a banner, and the new-session dialog shows a notice for an untrusted folder | `GET /api/fs/trust`; `LiveInfo.trusted` |
| Trust a folder | The new-session notice has a "Trust this folder" checkbox, which is ticked by default. The banner of an untrusted session has a "Trust folder" button. The session then restarts with project settings | `POST /api/fs/trust` with `trusted: true` (profile `standard` or higher); the session is reopened. The answer's `runtimeTrust` reports the result of the runtime's trust handshake (`setCwd()`) |
| Sub-folders | Trusting a folder also trusts the folders inside it | A session is trusted when its folder, or one of its parents, is trusted; paths are resolved with `realpath` |
| Revoking trust | Not offered in the interface. Read-profile viewers see the status but cannot change it | The API accepts `trusted: false`. That removes the gateway's record only; Claude Code's own record in `~/.claude.json` stays until it is removed in a terminal |

Trusted folders are kept in the state directory. A trust change applies to sessions opened afterwards, which is why the
interface closes and reopens the current session.

## Extensions and configuration

| Capability | Web surface | Mechanism |
|---|---|---|
| CLAUDE.md, settings, permission rules, hooks, skills, commands, plugins, MCP servers and subagents | Load as they do in the terminal once the folder is trusted. For an untrusted folder, only user-level files load. The capabilities panel lists what was loaded | `systemPrompt` and `tools` presets (`claude_code`); `settingSources` `['user', 'project', 'local']` for a trusted folder and `['user']` otherwise |
| MCP server status | An MCP panel with the state of each server and its tools | `mcpServerStatus()` |
| MCP toggle and reconnect | Switch a server on or off, or reconnect it | `toggleMcpServer(name, enabled)`; `reconnectMcpServer(name)` |
| MCP sign-in | Sign in to an MCP server that uses OAuth. The sign-in page opens in a browser; where the callback cannot reach the gateway, the callback address is pasted back | `mcpAuthenticate()`, `mcpSubmitOAuthCallbackUrl()` and `mcpClearAuth()`; `POST /api/sessions/:id/mcp/auth` with `start`, `callback` or `clear` |
| Reload plugins, skills and output styles | Reload actions in the capabilities panel. A plugin reload that would change the tools the prompt cache depends on asks first, as `/reload-plugins` does | `reloadPlugins({ holdOnCacheImpact: true })`, then `reloadPlugins()` after confirmation; `reloadSkills()`; `reloadOutputStyles()` |
| Output style | A style picker in the capabilities panel for trusted folders, as the `/config` output-style row | `updateSettings('localSettings', { outputStyle })`, the runtime's own settings writer; styles from `initializationResult()` |
| Hooks | Hook rows in the work steps; failing hooks are highlighted | `system` `hook_started`, `hook_progress` and `hook_response` messages |
| Memory recall | A muted row when Claude Code recalls memory | `system` `memory_recall` messages |
| Memory files | An editor for the CLAUDE.md and CLAUDE.local.md files that Claude Code loads for the session, in the memory panel. Saving offers to restart the session, because Claude Code reads memory files when a query starts | `getMemoryDialog()` lists the files; `GET /api/sessions/:id/memory`; `PUT /api/sessions/:id/memory` (profile `standard` or higher; 256 KiB; only files the runtime lists as editable). This is the gateway's only write to a file that the runtime manages |
| Notifications | Toasts in the page, and browser notifications when you enable them | `system` `notification` messages |

## Runtime panels

The panels show the data the live query returns for the terminal's own screens. Only the memory editor changes anything.
A panel needs a live session; otherwise the gateway answers `409 SESSION_NOT_LIVE`, and the interface offers to open the
session. Each view has a profile, and the view is listed only when the installed SDK offers its method.

| Panel | Web surface | Mechanism |
|---|---|---|
| `/status` | Status tab with the sections the runtime reports | `getStatus()`, view `status` (profile `standard`) |
| `/permissions` | Permissions tab with the rules, their sources and directories. Read only | `listPermissionRules()`, view `permissions` (`read`) |
| `/hooks` | Hooks tab with the events, the hooks and the policy. Read only | `getHooksListing()`, view `hooks` (`standard`) |
| `/memory` | Memory tab, the editor described under Extensions and configuration | `getMemoryDialog()`; `GET` and `PUT /api/sessions/:id/memory` |
| `/skills` | Skills tab | `getSkillsDialog()`, view `skills` (`read`) |
| `/sandbox` | Sandbox tab with support, mode, dependency errors and restrictions | `getSandboxDialog()`, view `sandbox` (`read`) |
| `/plan` | Shown in the developer console only | `getPlan()`, view `plan` (`read`) |
| `/usage` | Usage tab with session cost and totals, rate limits and plan windows; it loads when opened and on Refresh (a read may take up to 15 seconds). Offered only when the SDK has the method | `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`, typed but experimental; view `usage` (`read`) |
| `/config` | A settings tab with the effective settings, secrets redacted. Full profile only | `getSettings()`, view `settings` (`full`) |
| `/mcp` | MCP panel with each server's status and tools | `mcpServerStatus()`, view `mcp` (`read`) |
| `/chrome` | Claude in Chrome tab, shown when `CAW_CHROME=1`: whether it is allowed, installed and connected, with install and reconnect links | `getChromeDialog()`, view `chrome` (`read`) |
| Account | Account information in Settings → Account, which shows which login Claude Code uses | `accountInfo()`, view `account` (`read`); `GET /api/account` |
| Readiness and model list | Not a panel. The ready state and the model choices come from it | `initializationResult()`, view `init` (`standard`) |

Views are read-only data, passed on as the runtime answered them, except for the redaction described in
`docs/PROTOCOL.md`: the `settings` and `mcp` views hide secrets.

## Account and sign-in

| Capability | Web surface | Mechanism |
|---|---|---|
| Sign in with Claude | Settings → Account, "Sign in with Claude" (a subscription) or "Sign in with the Console" (an API account). The page shows the address to open, and the code to paste back | `claudeAuthenticate()` (the runtime's `/login`); `POST /api/account/login` with `method` `claudeai` or `console`; `POST /api/account/login/code` sends the code to `claudeOAuthCallback()`. Profile `full` |
| Account changes | The interface shows the new account when a sign-in completes. Live sessions keep the credentials they started with until they are reopened | `account_changed` event with the new account; the gateway drops its capability caches |
| Sign out | Not offered in the interface | The runtime has no sign-out control; `/logout` in the terminal tab does it |

The gateway never reads or writes the credential files. The sign-in runs in a Claude Code query that the gateway starts
for the account (or in the live session, when there is one).

## Browser tools

| Capability | Web surface | Mechanism |
|---|---|---|
| Claude in Chrome | The Claude in Chrome tab in the runtime panels (`CAW_CHROME=1`). It runs in a Chrome browser on the gateway's machine, with the Claude in Chrome extension and a claude.ai sign-in for Claude Code | `extraArgs` `--chrome` on each query when `CAW_CHROME=1`; `getChromeDialog()` for the tab. Choosing among several Chrome browsers stays in the terminal tab (`/chrome`) |
| Browser MCP server | A session setting, Browser tools, with the full profile. The setting appears only when the operator configured a command. The session then uses the operator's `browser` server | `CAW_BROWSER_MCP_COMMAND`; `POST /api/sessions/:id/settings` with `browserTools`; the `mcpServers` option at start, and `setMcpServers()` on a live query. Without the command the request answers `501 FEATURE_DISABLED` |

## Interface

| Capability | Web surface | Mechanism |
|---|---|---|
| Themes and text size | Settings → Appearance: theme System, Light or Dark; text size Small, Medium or Large. Touch targets are at least 44 px on touch screens | Client-side; kept in the browser for each viewer |
| Language | Settings → Appearance → Language: English or 简体中文 | Client-side |
| Keyboard shortcuts | Ctrl+K (⌘K) opens the quick switcher; Ctrl+Shift+O (⌘+Shift+O) starts a new session; Shift+Tab cycles the permission mode | Client-side actions that call the same endpoints as the buttons |
| Developer console (`/devtools`) | A panel with the raw output of each runtime view and a log of the events this page received. The log can be filtered and cleared | Client-side; the runtime views through the endpoints in Runtime panels, and the page's own event log |

## Terminal tab (optional)

| Capability | Web surface | Mechanism |
|---|---|---|
| Interactive terminal | An xterm.js panel attached to a session (`claude --resume <id>`) or to a fresh `claude` in a project | WebSocket `GET /api/terminal` backed by node-pty; requires `CAW_TERMINAL=1` and the `full` profile |

The terminal is equivalent to a shell as the service user. It is disabled by default. While it is attached to a session,
the graphical interface cannot send messages, rewind, fork, delete or use live controls in that session (rename, tag and
settings for the next start still work), and it resumes when the terminal detaches.

The terminal runs the executable from `CAW_CLAUDE_BIN` when that is set, with no fallback. Otherwise it runs the native
binary that the SDK ships for the platform, and only when that is missing, the first executable `claude` on `PATH`. The
chat passes `CAW_CLAUDE_BIN` to the SDK only when it is set.

## Terminal-only commands

Some Claude Code features are interactive terminal features with no SDK equivalent. Use the terminal tab for them:

| Terminal feature | Why it is terminal-only | How to use it in claude-official-web |
|---|---|---|
| `/theme` and `/terminal-setup` | Change the terminal's own colours and key handling | Use Settings → Appearance for the theme; use the terminal tab only for terminal-level setup |
| Vim mode and custom keybindings | Key handling in the terminal's line editor | Set them in the terminal tab; the browser composer uses its own keys |
| `!` shell mode | Runs a shell command directly from the prompt | Use the terminal tab, or ask Claude to run the command with the Bash tool so that the approval card appears |
| Full-screen dialogs such as `/resume` and `/config` | Full-screen terminal dialogs | Use the sidebar to open sessions and the runtime panels to read the configuration; use the terminal tab for the dialog itself |
| Changing hooks and permission rules | The runtime's editing screens are terminal dialogs; the panels show the rules and hooks read-only | Use the terminal tab |
| `/chrome` browser choice | Choosing among several connected Chrome browsers is an interactive dialog | Use `/chrome` in the terminal tab; the Claude in Chrome tab shows the state |
| `/logout` | The runtime's sign-out has no SDK control | Run `/logout` in the terminal tab |

Sign-in no longer needs the terminal: `/login` is available from Settings → Account (full profile), and `/login` in the
terminal tab still works.

Each terminal-only feature is a separate interaction. Nothing in the gateway performs these actions on your behalf.
