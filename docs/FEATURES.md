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
| Extended thinking | A collapsed "Thinking" block for each reply | `assistant` content blocks `thinking` and `redacted_thinking` |
| Markdown and code | Sanitized Markdown with highlighted code blocks | Text blocks rendered by `renderMarkdown()` (marked and DOMPurify) |
| Tool use | One card per tool call, grouped into collapsible work steps | `assistant` `tool_use` blocks; results from `user` `tool_result` blocks |
| All tool families | Bash and BashOutput; Read, Write, Edit, MultiEdit and NotebookEdit with diffs; Grep, Glob and LS; WebFetch and WebSearch; Agent and Task; TodoWrite; plan tools; `mcp__<server>__<tool>`; a generic fallback | Tool names in `tool_use` blocks; structured results from `tool_use_result` when present |
| Subagents | The subagent's conversation nested inside its Agent or Task card | Messages with `parent_tool_use_id`; `listSubagents()` and `getSubagentMessages()` for history |
| Background tasks | Task rows in the timeline and a background-tasks panel, with a stop action | `system` `task_started`, `task_progress`, `task_updated` and `task_notification`; `stopTask(taskId)` |
| Work summary | A group label such as "5 steps" | `tool_use_summary` messages |
| Turn footer | Duration, turn count, the error reason for failed turns and any permission denials | `result` message (`subtype` `success` or an error subtype; `permission_denials`) |
| Interrupt | Stop button while a turn runs | `interrupt()` on the query |
| Queued input | A message sent during a turn shows as queued until the runtime echoes it | Input streaming: the runtime queues the user message; gateway event `message_accepted` |
| Compaction | A "Context compacted" divider and status text | `system` `compact_boundary` and `status` messages |
| API retries | A muted inline notice | `system` `api_retry` messages |

## Permissions and questions

| Capability | Web surface | Mechanism |
|---|---|---|
| Tool approvals | Permission card with allow once, allow always and deny (with an optional reason) | `canUseTool` callback creates a pending request; decision sent to `POST /api/sessions/:id/requests/:rid` |
| Permission suggestions | "Allow always" saves the rules that Claude Code proposes; each suggestion can be unticked | `PermissionUpdate` suggestions and `suggestionIndexes` in the decision |
| Questions | A question card with the offered options and free text (`AskUserQuestion`) | `canUseTool` for the `AskUserQuestion` tool; answers returned as `updatedInput.answers` |
| Plan mode | A plan card to approve (choosing the next permission mode) or reject with feedback | `ExitPlanMode` through `canUseTool`; `setPermissionMode(nextMode)` after approval |
| MCP elicitation | A form or link card asking an MCP server for input | `onElicitation` callback; accept, decline or cancel with content |
| Permission modes | Mode picker: default, acceptEdits, plan, auto and dontAsk | `setPermissionMode(mode)`; `permissionMode` option when a session starts |
| Bypass mode | Offered only when the operator enabled it | `bypassPermissions`; requires `CAW_ALLOW_BYPASS=1` and the `full` profile |
| Denials | A red row for each denied tool call | `system` `permission_denied` messages; `result.permission_denials` |

## Model, effort and context

| Capability | Web surface | Mechanism |
|---|---|---|
| Model switching | Model picker in the header and in the session settings | `setModel(model)`; `supportedModels()` lists the choices |
| Effort | Picker for low, medium, high, xhigh and max | `applyFlagSettings({ effortLevel })` |
| Context usage | A context meter and a panel with the breakdown | `getContextUsage()` |
| Usage limits | A banner when a limit or warning applies | `rate_limit_event` messages |
| Prompt suggestions | A suggested next prompt above the composer | `prompt_suggestion` messages (`promptSuggestions` option) |
| Account | Account information reported by Claude Code | `accountInfo()` |

## Commands and input

| Capability | Web surface | Mechanism |
|---|---|---|
| Slash commands from Claude Code | Command palette opened with `/`, listing skills, custom commands and MCP prompts | `supportedCommands()`; the command is sent as a user message |
| Commands with a graphical equivalent | `/model`, `/permissions`, `/effort`, `/rewind`, `/fork`, `/rename`, `/mcp` and `/terminal` | Gateway actions that call the SDK methods listed in this table |
| Commands that run inside the session | Output appears as a command-output card | Sent as a message; `system` `local_command_output` messages |
| File mentions with `@` | Fuzzy file search inside the session's directory | `GET /api/fs/search` (containment-checked by the gateway) |
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

## Extensions and configuration

| Capability | Web surface | Mechanism |
|---|---|---|
| CLAUDE.md, settings, permission rules, hooks, skills, commands, plugins, MCP servers and subagents | Load exactly as they do in the terminal; the capabilities panel lists what was loaded | `systemPrompt` and `tools` presets (`claude_code`); `settingSources` `user`, `project` and `local` |
| MCP server status | An MCP panel with the state of each server and its tools | `mcpServerStatus()` |
| MCP toggle and reconnect | Switch a server on or off, or reconnect it | `toggleMcpServer(name, enabled)`; `reconnectMcpServer(name)` |
| Reload plugins and skills | A reload action after you install or change them | `reloadPlugins()` |
| Output style | Shown in the capabilities panel when styles are available | `outputStyle` and `availableOutputStyles` in the capabilities response |
| Hooks | Hook rows in the work steps; failing hooks are highlighted | `system` `hook_started`, `hook_progress` and `hook_response` messages |
| Memory recall | A muted row when Claude Code recalls memory | `system` `memory_recall` messages |
| Notifications | Toasts in the page, and browser notifications when you enable them | `system` `notification` messages |

## Terminal tab (optional)

| Capability | Web surface | Mechanism |
|---|---|---|
| Interactive terminal | An xterm.js panel attached to a session (`claude --resume <id>`) or to a fresh `claude` in a project | WebSocket `GET /api/terminal` backed by node-pty; requires `CAW_TERMINAL=1` and the `full` profile |

The terminal is equivalent to a shell as the service user. It is disabled by default. While it is attached to a session,
the graphical interface cannot write to that session, and it resumes writing when the terminal detaches.

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
