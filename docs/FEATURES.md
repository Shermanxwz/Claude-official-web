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
| Move to the background (Ctrl+B) | A "Run in background" button on a running Bash or Agent card | `backgroundTasks(toolUseId)`; `POST /api/sessions/:id/background` |
| Work summary | A group label such as "5 steps" | `tool_use_summary` messages |
| Turn footer | Duration, turn count, the error reason for failed turns and any permission denials | `result` message (`subtype` `success` or an error subtype; `permission_denials`) |
| Interrupt | Stop button while a turn runs; background tasks keep running, as after Esc in the terminal | `interrupt()` on the query; every query declares `perTaskStopAffordance` |
| Refusal fallback | When the model declines and the turn is retried on a fallback model, a notice explains it and the declined response is marked as withdrawn. Without a fallback, a notice offers "Edit and retry" | `system` `model_refusal_fallback` (`retracted_message_uuids`) and `model_refusal_no_fallback` (`refused_user_message_uuid`) |
| Plugin installation | A row for each installation step | `system` `plugin_install` messages |
| Queued input | A message sent during a turn shows as queued until the runtime echoes it | Input streaming: the runtime queues the user message; gateway event `message_accepted` |
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
| Permission modes | Mode picker: default, acceptEdits, plan, auto and dontAsk | `setPermissionMode(mode)`; `permissionMode` option when a session starts |
| Bypass mode | Offered only when the operator enabled it | `bypassPermissions`; requires `CAW_ALLOW_BYPASS=1` and the `full` profile (`501 FEATURE_DISABLED` otherwise). The same rule applies to `CAW_DEFAULT_PERMISSION_MODE=bypassPermissions` |
| Denials | A red row for each denied tool call | `system` `permission_denied` messages; `result.permission_denials` |

## Model, effort and context

| Capability | Web surface | Mechanism |
|---|---|---|
| Model switching | Model picker in the header and in the session settings | `setModel(model)`; the choices come from `initializationResult().models` |
| Effort | Picker for low, medium, high, xhigh and max, for the current session. Typing `/effort <level>` runs Claude Code's own command, which also saves the level as the default | `applyFlagSettings({ effortLevel })` |
| Fast mode (`/fast`) | A "Fast" toggle when the model supports it, with the state Claude Code reports (on, cooling down, or why it is unavailable) | `applyFlagSettings({ fastMode })` in the session's flag layer; `supportsFastMode` in the model list; `fast_mode_state` and `fast_mode_disabled_reason` from `system` `init` and `result` |
| Context usage | A context meter and a panel with the breakdown | `getContextUsage()` |
| Usage limits | A banner when a limit or warning applies | `rate_limit_event` messages |
| Prompt suggestions | A suggested next prompt above the composer | `prompt_suggestion` messages (`promptSuggestions` option) |
| Account | Account information reported by Claude Code | `initializationResult().account` |

## Commands and input

| Capability | Web surface | Mechanism |
|---|---|---|
| Slash commands from Claude Code | Command palette opened with `/`, listing built-in commands, skills, custom commands and MCP prompts | `initializationResult().commands`, refreshed by `system` `commands_changed`; the command is sent as a user message |
| Commands with a graphical equivalent | `/model`, `/permissions`, `/effort`, `/fast`, `/rewind`, `/fork`, `/rename`, `/mcp` and `/terminal` open the matching control when picked from the palette. Typed commands are always sent to Claude Code unchanged | Gateway actions that call the SDK methods listed in this table |
| Commands that run inside the session | Output appears as a command-output card | Sent as a message; `system` `local_command_output` messages |
| File mentions with `@` | Fuzzy file search inside the session's directory | `GET /api/fs/search` (containment-checked by the gateway). The runtime answers a `file_suggestions` control request, but the SDK has no public method for it, so the gateway searches itself |
| Images | Paste or drag an image; thumbnails in the composer and the timeline | `POST /api/attachments`; sent as base64 image blocks |
| Other files | Uploaded files shown as chips | Sent as `Attached file: <path>` text |
| Keyboard input | Multi-line composer; Enter sends on desktop and Shift+Enter starts a new line | `POST /api/sessions/:id/messages` |
| Drafts | Unsent text is kept for each session in the browser | Browser storage, as a per-viewer convenience |

## Sessions

| Capability | Web surface | Mechanism |
|---|---|---|
| Start a session | New-session dialog with a project directory, title and settings | `query()` for a new session; the session is live until it is closed or idles out |
| Resume and open | Any saved session opens on demand | `query()` with `resume`; `POST /api/sessions/:id/open` |
| Session list | Sidebar grouped by project, with a filter and paging | `listSessions()`; `GET /api/sessions` |
| Transcript history | Older messages load when you scroll up | `getSessionMessages()` through the gateway's `before` and `limit` paging |
| Rename | A rename action | `renameSession(sessionId, title)` |
| Tag | A tag field in the session details | `tagSession(sessionId, tag)` |
| Fork | Fork the conversation at a message into a new session | `forkSession(sessionId, { upToMessageId })` |
| Rewind code | A dry-run preview, then restore the files to a chosen message | `rewindFiles(userMessageId, { dryRun })`; requires file checkpointing (`enableFileCheckpointing`) |
| Rewind conversation | Restart the conversation from an earlier message | Reopen with `resume` and `resumeSessionAt` set to the transcript entry before the chosen message |
| Delete | A delete action for saved sessions (`full` profile; not for live sessions) | `deleteSession(sessionId)` |
| Single writer | A session open in the terminal tab is read-only in the GUI | Gateway lock (`SESSION_LOCKED`); `terminal_state` events |

## Workspaces and folder trust

| Capability | Web surface | Mechanism |
|---|---|---|
| Directory browser | Lists the workspace roots and their sub-folders; project folders are marked | `GET /api/fs/dirs`; a folder counts as a project when it contains `.git`, `.claude`, `CLAUDE.md` or `package.json` |
| Trust status | An untrusted session shows a banner, and the new-session dialog shows a notice for an untrusted folder | `GET /api/fs/trust`; `LiveInfo.trusted` |
| Trust a folder | The new-session notice has a "Trust this folder" checkbox, which is ticked by default. The banner of an untrusted session has a "Trust folder" button. The session then restarts with project settings | `POST /api/fs/trust` with `trusted: true` (profile `standard` or higher); the session is reopened |
| Sub-folders | Trusting a folder also trusts the folders inside it | A session is trusted when its folder, or one of its parents, is trusted; paths are resolved with `realpath` |
| Revoking trust | Not offered in the interface. Read-profile viewers see the status but cannot change it | The API accepts `trusted: false` |

Trusted folders are kept in the state directory. A trust change applies to sessions opened afterwards, which is why the
interface closes and reopens the current session.

## Extensions and configuration

| Capability | Web surface | Mechanism |
|---|---|---|
| CLAUDE.md, settings, permission rules, hooks, skills, commands, plugins, MCP servers and subagents | Load as they do in the terminal once the folder is trusted. For an untrusted folder, only user-level files load. The capabilities panel lists what was loaded | `systemPrompt` and `tools` presets (`claude_code`); `settingSources` `['user', 'project', 'local']` for a trusted folder and `['user']` otherwise |
| MCP server status | An MCP panel with the state of each server and its tools | `mcpServerStatus()` |
| MCP toggle and reconnect | Switch a server on or off, or reconnect it | `toggleMcpServer(name, enabled)`; `reconnectMcpServer(name)` |
| Reload plugins, skills and output styles | Reload actions in the capabilities panel. A plugin reload that would change the tools the prompt cache depends on asks first, as `/reload-plugins` does | `reloadPlugins({ holdOnCacheImpact: true })`, then `reloadPlugins()` after confirmation; `reloadSkills()`; `reloadOutputStyles()` |
| Output style | A style picker in the capabilities panel for trusted folders, as the `/config` output-style row | `updateSettings('localSettings', { outputStyle })`, the runtime's own settings writer; styles from `initializationResult()` |
| Hooks | Hook rows in the work steps; failing hooks are highlighted | `system` `hook_started`, `hook_progress` and `hook_response` messages |
| Memory recall | A muted row when Claude Code recalls memory | `system` `memory_recall` messages |
| Notifications | Toasts in the page, and browser notifications when you enable them | `system` `notification` messages |

## Terminal tab (optional)

| Capability | Web surface | Mechanism |
|---|---|---|
| Interactive terminal | An xterm.js panel attached to a session (`claude --resume <id>`) or to a fresh `claude` in a project | WebSocket `GET /api/terminal` backed by node-pty; requires `CAW_TERMINAL=1` and the `full` profile |

The terminal is equivalent to a shell as the service user. It is disabled by default. While it is attached to a session,
the graphical interface cannot write to that session, and it resumes writing when the terminal detaches.

The terminal runs the executable from `CAW_CLAUDE_BIN` when that is set, with no fallback. Otherwise it runs the native
binary that the SDK ships for the platform, and only when that is missing, the first executable `claude` on `PATH`. The
chat passes `CAW_CLAUDE_BIN` to the SDK only when it is set.

## Terminal-only commands

Some Claude Code features are interactive terminal features with no SDK equivalent. Use the terminal tab for them:

| Terminal feature | Why it is terminal-only | How to use it in claude-official-web |
|---|---|---|
| `/theme` and `/terminal-setup` | Change the terminal's own colours and key handling | Use the Web interface's theme setting; use the terminal tab only for terminal-level setup |
| Vim mode and custom keybindings | Key handling in the terminal's line editor | Set them in the terminal tab; the browser composer uses its own keys |
| `!` shell mode | Runs a shell command directly from the prompt | Use the terminal tab, or ask Claude to run the command with the Bash tool so that the approval card appears |
| Interactive pickers such as `/resume` and the `/config` dialogs | Full-screen terminal dialogs | Use the sidebar to open sessions, and the settings and capabilities panels for configuration; use the terminal tab for the dialog itself |
| `/login` | Opens the browser login flow of Claude Code | Run `claude` once in the terminal tab (or in a shell as the service user) and complete `/login` there |

Each terminal-only feature is a separate interaction. Nothing in the gateway performs these actions on your behalf.
