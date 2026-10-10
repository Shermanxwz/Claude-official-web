# Visual and interaction design

Binding for every stylesheet and view. The product is a workbench for supervising a coding agent on your own
machine: you read what it says, see what it does, and decide when it asks. The design follows from that job.

## Principles

1. **Two voices.** What Claude *says* is prose: a calm reading face at reading size, generous line height, at most
   about 70 characters per line. What Claude *does* is an action log: the monospace face, compact rows, one line per
   step until opened. The two never share a style.
2. **Decisions carry the weight.** The only strong color and the only docked, elevated element in the conversation is
   a request that waits for you (approval, question, plan, dialog). Everything else stays quiet.
3. **State is visible without reading.** Running, waiting for you, idle and failed each have one glyph and one color,
   used the same way in the sidebar, the header and the composer.
4. **Keyboard first, touch ready.** Every frequent action has a key (see Keys); every target is at least 44 px on
   touch screens.
5. **Structure is information.** Borders, tints and shadows mark separate objects or layers, never decoration. A card
   inside a card is not allowed; nested detail is indented with a 2 px rule instead.

## Type

- `--font-sans`: `"Atkinson Hyperlegible Next", system-ui, -apple-system, "Segoe UI", "PingFang SC",
  "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC", sans-serif`.
- `--font-mono`: `"Atkinson Hyperlegible Mono", ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas,
  "PingFang SC", monospace`.
- Both are variable fonts (OFL-1.1), vendored in `public/fonts/` with their licenses, declared in `app.css` with
  `font-display: swap`, weight range `200 800`, and the `unicode-range` split of the files (latin, latin-ext; the sans
  also has an italic for latin). Chinese text falls back to the system CJK face by design.
- Scale (px / line height): `--fs-xs` 12/16 (meta, badges), `--fs-sm` 13/18 (secondary UI, action rows),
  `--fs-md` 15/22 (UI body), `--fs-prose` 16/26 (assistant and user message text), `--fs-lg` 17/24 (panel and dialog
  titles), `--fs-xl` 22/28 (welcome title only). Mono runs one step smaller than its context: 13 px in action rows,
  12.5 px in diffs and outputs, line height 1.55.
- Settings → Text size sets `--fs-scale` (Small .93, Medium 1, Large 1.13). Every size token is `calc(Npx *
  var(--fs-scale))`, and so is any size outside the scale (the 12.5 px mono), so one setting scales the whole interface.
  No stylesheet sets a literal pixel font size.
- Weights: 400 text, 500 labels and controls, 600 titles and primary buttons. No all-caps labels; sentence case
  everywhere. Numbers that line up use `font-variant-numeric: tabular-nums`.

## Color

Tokens are defined once in `app.css` for light (`:root`), dark (`:root[data-theme="dark"]`) and system dark
(`@media (prefers-color-scheme: dark)` with `:root:not([data-theme="light"])`). Values:

| token | light | dark | use |
|---|---|---|---|
| `--bg` | `#FBFBFA` | `#121316` | conversation canvas |
| `--bg-sunken` | `#F3F4F2` | `#0D0E10` | sidebar, code, inputs, user messages |
| `--bg-elev` | `#FFFFFF` | `#1A1C20` | composer, menus, dialogs, panels, request cards |
| `--bg-hover` | `#ECEEEA` | `#22252A` | hover and selected rows |
| `--fg` | `#17191C` | `#E8EAED` | text |
| `--fg-muted` | `#5A6068` | `#A2A9B2` | secondary text |
| `--fg-subtle` | `#666C74` | `#858C95` | placeholders, disabled, decorative glyphs |
| `--border` | `#E2E4E0` | `#2A2D33` | separators, control borders |
| `--border-strong` | `#C9CDC7` | `#3A3E46` | focused or hovered borders |
| `--accent` | `#3949C7` | `#8D99FF` | primary actions, links, running state |
| `--accent-fg` | `#FFFFFF` | `#0D0E10` | text on accent |
| `--accent-soft` | `#ECEEFB` | `#23284A` | selected state, accent tints |
| `--attention` | `#B45309` | `#F2B24C` | waiting for you: request cards, pending badges |
| `--attention-soft` | `#FDF3E4` | `#3A2A12` | request card tint |
| `--success` | `#1F7A3E` | `#5BD48A` | done |
| `--danger` | `#B42318` | `#FF7B72` | errors, deny, delete |
| `--diff-add-bg` | `#E3F3E7` | `rgba(63, 185, 80, 0.16)` | added lines |
| `--diff-del-bg` | `#FBE7E6` | `rgba(248, 81, 73, 0.16)` | removed lines |

`--warning`/`--warning-soft` stay as aliases of `--attention`/`--attention-soft`; `--info` follows `--accent`. The
existing `--success-soft`, `--danger-soft`, `--info-soft` keep their roles with values derived from the table. Text on
every background meets 4.5:1, `--fg-subtle` included; meta text (times, counts, project headings) uses `--fg-muted`.
Never use Anthropic's or Claude Code's brand colors.

## Shape, depth, motion

- Radii by role: 6 px for inputs, small buttons and chips inside rows; 10 px for buttons, action rows and code
  blocks; 14 px for the composer, request cards, menus, panels and dialogs; 999 px for badges and pills.
- Depth: only floating layers have shadows — menus and the docked request card `0 8px 24px -8px rgba(15,17,20,.18)`,
  dialogs and panels `0 24px 64px -16px rgba(15,17,20,.28)` (dark: black at .5/.6). Anything in the flow uses a
  border or a tint, not a shadow.
- Motion answers actions: expand/collapse 140 ms, panels and sheets 200 ms, both `cubic-bezier(.2,.7,.2,1)`. The
  ambient motions are the running glyph and, only while a compaction runs, the context ring's arc and the compacting
  row's sweep (1.4 s). `prefers-reduced-motion: reduce` removes all of it.
- Focus: `outline: 2px solid var(--accent); outline-offset: 2px` on every focusable element (`:focus-visible`).

## State glyphs (same everywhere)

| state | glyph | color |
|---|---|---|
| running / starting | a small rotating arc (12 px) | `--accent` |
| waiting for you (`requires_action`, pending requests) | filled dot with a ring | `--attention` |
| idle / done | none in lists; a check in the turn footer | `--fg-subtle` / `--success` |
| error | exclamation dot | `--danger` |

## Layout and components

- **Shell.** Desktop: sidebar 280 px (`--bg-sunken`, right border) | conversation column centered with
  `--content-max: 760px`. Below 768 px the sidebar becomes a drawer and panels become full-height sheets.
- **Sidebar.** Top: logo, app name, collapse button. Then a quiet "New session" button (`--bg-elev`, border, accent
  icon, label, `⌘⇧O`/`Ctrl+Shift+O` hint on desktop) and a search field that shows `⌘K`. Projects are small headings
  (`--fs-xs`, 600, `--fg-muted`, folder name and count). A session row: state glyph, title (`--fs-sm`, 500, one line),
  relative time right-aligned (`--fs-xs`, tabular); a pending count as an `--attention` pill. The selected row uses
  `--bg-hover` with a 2 px accent bar on the left. Footer: connection dot and label, settings, sign out.
- **Header (52 px).** Title (`--fs-md`, 600) above the folder path (`--fs-xs`, mono, `--fg-muted`, middle-truncated).
  Right side: session controls as pills — model, permission mode, effort (native selects styled as 32 px pills with a
  chevron, `appearance: none`), the Fast toggle, the agent chip when set, a context ring (18 px circle in a 32 px target
  showing how full the context window is, live from `LiveInfo.context`; the exact numbers and the auto-compact point in
  its tooltip; `--fg-muted`, then `--attention` from 85 % of the auto-compact point, then `--danger` from 95 % of the
  window; a 2 × 3 px `--fg-muted` mark just outside the ring at the auto-compact point; its fill eases over 400 ms so a
  compaction's drop is visible; while a compaction runs a 30 % accent arc turns around it), the state badge (`Working`
  accent, `Needs you` attention, `Idle` muted), overflow menu. While unattended mode is on, an attention-toned
  "Unattended" pill sits before the state badge (32 px; icon only below 768 px; 44 px on touch screens), the permission
  select is disabled with the reason in its tooltip, and the composer's mode label reads "Unattended — no approvals".
- **Messages.** The user's message: right-aligned, `--bg-sunken`, radius 14 px, `--fs-prose`, at most 80 % wide.
  Claude's prose: no container, `--fs-prose`. Turn footer: a muted sentence such as "Done in 0.9 s, 3 turns" with a
  check, or "Interrupted", or the error in `--danger` — no middle-dot meta strings.
- **Action log (work groups and tool rows).** A group header is one muted line: layers icon, "3 steps" and the
  runtime's summary when present, chevron. A tool row is one line, 34 px high: state glyph, verb in the sans face
  (`--fs-sm`, 500: Read, Edit, Run, Search, Fetch, Ask, Plan…), target in mono (`--fs-sm`, truncated in the middle
  for paths), and on the right the diff stat (`+3 −1` in success/danger) or duration. Opening a row shows its detail
  indented under a 2 px `--border` rule: command and output blocks, diffs, structured results — not a nested card.
  Diffs: full column width, line numbers in `--fg-subtle`, mono 12.5 px, radius 10 px, border.
- **Request cards.** Docked: while a request is pending the card sits directly above the composer (sticky at the
  bottom of the conversation; on phones it is a sheet above the keyboard), `--bg-elev`, radius 14 px, a 3 px
  `--attention` left edge, the floating shadow. Top line: icon and "Needs your approval" / "Question" / "Plan to
  review" / "Declined by the model" in `--attention`, time on the right. Title (`--fs-md`, 600), description
  (`--fs-sm`, muted). The preview (diff, command, plan, options) is part of the card, not a card inside it.
  The tool's preview is shown directly (a Bash command as one mono block with a copy icon, an edit as its diff), never
  as a tool row inside the card. "Always allow" applies the checked suggestions, listed as a compact checklist under
  the legend "Saved with Always allow", each with a muted scope line and no box of its own; long paths are truncated
  in the middle with the full path in the tooltip. The note to Claude hides behind "Add a note". Actions: primary
  filled accent, deny outlined danger; each shows its key (`1`, `2`, `3`) as a small `kbd`.
- **Composer.** `--bg-elev`, border, radius 14 px, `--shadow` of menus only while focused. Textarea `--fs-prose`.
  Bottom row: attach, the current permission mode as quiet text (click opens the mode menu; Shift+Tab cycles), then
  Stop (while running) and Send (accent, round 32 px). Above it, stacked from the composer upwards: the running line,
  the todo bar, the suggestion line. All three are single quiet lines (no fill, no border) with the same left edge as
  the composer text, 17 px in; the suggestion line is muted text with an accent spark and a dismiss ×. On phones the
  permission mode shows its short name ("Ask", "Plan"…); the full name stays in the tooltip and the menu.
- **Panels.** Right-side panel 440 px (desktop), full-height sheet on phones; header with title and close; tabs as an
  underlined row that wraps rather than hiding tabs; sections separated by space and a heading (`--fs-sm`, 600), not
  boxes. Tables use hairline rows. The sheet body scrolls; a footer never covers content.
- **Dialogs.** 520 px wide (the New session dialog, which holds a folder browser and a two-column form, is 680 px),
  radius 14 px, footer actions right-aligned (primary last). Opening focuses the first enabled control of the body,
  else the primary action; a pending action's button gets focus back when it settles; closing returns focus to the
  control that opened it.
- **Compaction.** While Claude Code compacts the conversation, the end of the turn shows one row in the divider's
  style: the running glyph, "Compacting the conversation", the elapsed seconds and a slim accent sweep along its rule.
  When the compaction ends the same row becomes the divider ("Compacted automatically: 103.5k tokens summarized into
  2.1k in 10.5 s"), in place, with no layout jump. The summary the runtime leaves follows it as a collapsed note,
  "Summary of the earlier conversation". After a reload, a compaction still running shows its row at the end of the
  conversation, counting from the session's own start; a finished one shows its divider where the summary is, with the
  sizes the session reports.
- **Requests answered automatically.** A request counts as waiting only after 300 ms unanswered. One that unattended
  mode answers sooner leaves a single muted line in the action log ("Allowed automatically (unattended)"), with no
  card, buttons, badge, count or notification.
- **Toasts.** Under the header and any banners, right-aligned on desktop, full width inside the 16 px gutter on
  phones; never over the composer, the docked request card or header controls.
- **Message actions.** Copy, edit and rewind show on hover, or after a tap on touch screens (a second tap hides them).
  Rewind is disabled while a turn runs or a request waits, with the reason in its tooltip.
- **Empty states.** No session selected: the logo, "Start a session" (primary), the three most recent projects as
  one-click rows, and a short key list. An empty session: the spark icon, "Start the conversation" and one muted line,
  "Describe a task. @ adds files, / runs commands." Errors say what failed and how to fix it.

## Keys

| key | action | where |
|---|---|---|
| Enter / Shift+Enter | send / new line | composer (desktop) |
| Shift+Tab | next permission mode | composer |
| Esc | stop the running turn (when no menu, palette or dialog is open) | composer |
| ↑ / ↓ | previous / next prompt of this session (empty composer) | composer |
| ⌘K / Ctrl+K | quick switcher | anywhere |
| ⌘⇧O / Ctrl+Shift+O | new session (browsers reserve ⌘N/Ctrl+N) | anywhere |
| 1 / 2 / 3 | answer the focused or only pending request card (not while typing in a field) | conversation |
| / and @ | command palette, file mention | composer |

## Copy

Sentence case, plain verbs, no exclamation marks, no apologies. A button names its result ("Save memory", "Retry
with Claude Sonnet"), and its toast repeats the verb ("Memory saved"). Errors name the cause and the fix. Chinese
copy follows the same rules and uses full-width punctuation.
