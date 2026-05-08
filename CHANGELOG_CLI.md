# CLI Changelog

All notable changes to the **CLI layer** (`lib/commands/`, `bin/cli.js`, `lib/core/hermes-theme.js`, `lib/core/chat-session.js`, `lib/core/llm-providers.js`) will be documented in this file.

This changelog tracks the `aiyu-cli` branch exclusively. For platform-wide changes, see [CHANGELOG.md](./CHANGELOG.md).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [0.5.0] - 2026-05-08

### Phase 5.7 — Ghost Hint Cursor Fix + Single-Slash Hint + Picker Blank-Line Gap

#### Fixed

- **Ghost hint cursor desync on Windows** — after showing or clearing the ghost hint on the line below the prompt, the terminal cursor was left at the hint's end column instead of the input's end; readline's next `_refreshLine()` computed relative moves from the wrong spot, producing a huge gap between characters (e.g. `/mo` + `d` appeared as `/mo                                                            d`)
  - Fix: both `_clearGhostHint()` and the ghost hint writer now explicitly reposition the cursor to `promptLen + cursorPos` after moving back up
- **Interactive picker leaves blank-line gap after ESC** — `pickCommand()` and `pickSession()` used a pre-calculated `LINES` constant for cursor movement; when the menu was taller than remaining terminal rows, drawing caused scrolling and the actual drawn lines diverged from `LINES`; `cleanup()` moved the cursor back by `LINES` from its current position but missed lines that had scrolled into scrollback → `clearScreenDown()` couldn't reach them → blank gap
  - Fix: removed pre-allocation (`\n.repeat(LINES)`) and replaced `LINES`-based cursor math with `_drawnLines` tracking — `draw()` increments `_drawnLines` per line written, `cleanup()` and `onKey` redraws use `_drawnLines` to move back exactly the right number of lines

#### Added

- **Single-slash ghost hint** — typing `/` alone now shows a hint for the first matching command with a count of remaining matches, e.g. `/new  — Start a new session (+27 more)`; previously hints only appeared for prefixes of length ≥ 2

#### Changed

- `lib/commands/chat.js` — `_clearGhostHint()` repositions cursor to readline-expected position; ghost hint writer does the same; `pickCommand()` and `pickSession()` use `_drawnLines` tracking instead of `LINES` constant; single-slash hint enabled

---

### Phase 5.6 — Streaming Display Bug Fixes + Layout Redesign

#### Fixed

- **Critical: `streamingBoxOpen` not reset on error/cancel mid-stream** — if an API error or Ctrl+C occurred while the streaming box was open, `writeStreamBoxBottom()` was never called; `streamingBoxOpen` (session-scoped) stayed `true` for all subsequent turns, causing `onStep "thinking"` to silently skip, `tool_started` to draw a box bottom with no matching top, and the terminal to be permanently corrupted for that session
  - Fix: `catch` block now calls `writeStreamBoxBottom()` when `streamingBoxOpen` is true before handling the error or cancel
- **`run.js` `jsonMode` ReferenceError** — `const jsonMode` was declared at line 49 but referenced at line 29 inside the auto-route block → `ReferenceError` crash whenever auto-routing fired with `--json` flag
  - Fix: moved `const jsonMode` declaration to before the auto-route block
- **`tool_completed` double output** — `renderToolCompleted()` was always called followed by a separate `✓ tool: result` status line → every tool result printed two lines; on success the second line was purely redundant
  - Fix: removed the duplicate `✓` status line on success; error line on `evt.error` is kept for visibility
- **Dead event cases in `onStep`** — `case "tool_call"`, `case "tool_result"`, `case "tool_error"` were never emitted by `chat-session.js`; errors route through `tool_completed` with `evt.error`; all three dead cases removed
- **`stopStatusBar()` erasing streaming content** — `\r\x1b[2K` (erase current line) was written every call regardless of whether status bar was actually active, causing the last line of streamed content inside the box to be silently erased each turn
  - Fix: `\r\x1b[2K` now only runs when `statusBarInterval` is non-null (i.e. the bar was actually rendering)
- **`onStep` "thinking" restarting status bar inside open streaming box** — when `onStep({ type: "thinking" })` fired after streaming, it called `startStatusBar()` which placed a new status bar on the content line inside the box; the subsequent `stopStatusBar()` then erased that content line
  - Fix: `case "thinking"` now breaks immediately when `streamingBoxOpen = true`, leaving the box untouched
- **`Working...` line persisting across every turn** — `process.stdout.write("... Working...\n")` ended with `\n`, moving the cursor to the next line so the status bar's `\r` overwrote the wrong line; "Working..." was never cleared and accumulated each turn
  - Fix: removed trailing `\n` so the status bar overwrites the same line and `stopStatusBar()` clears it cleanly

#### Changed

- **Response footer unified into one line below box** — previously `[Done · Xs]` was printed *inside* the open streaming box before it was closed, and `renderAgentSignature()` was a separate dim line; both are now merged into a single footer line printed *after* `writeStreamBoxBottom()`:
  ```
  Done · 4.8s · accessibility-specialist (◕‿◕)♿
  ```
  - Token count appended when non-zero: `Done · 4.8s · 120 tok · agent-name (kaomoji)`
  - Applies to both streaming path and non-streaming (`renderResponseBox`) path
- **Tool call display closes streaming box cleanly** — `case "tool_started"` in `onStep` now closes the streaming box (`writeStreamBoxBottom()`) before printing the tool preparing line, then resets `streamedOutput`, `streamRawBuffer`, `streamPrintedCodepoints` so the next LLM step opens a fresh box; produces clean multi-step layout:
  ```
  ╭─ ⚔ Aiyu ──────────────────────────────────╮
      Let me read that file...
  ╰─────────────────────────────────────────────╯
    ┊ 📄 preparing fs.read…
    ✓ fs.read   package.json   0.3s
  ╭─ ⚔ Aiyu ──────────────────────────────────╮
      Here's what I found: ...
  ╰─────────────────────────────────────────────╯
    Done · 2.1s · accessibility-specialist (◕‿◕)♿
  ```

---

### Phase 5.5 — Agent Auto-Routing (Intelligent Agent Selection)

#### Added

- **`lib/core/agent-router.js`** — Keyword-based automatic agent routing module
  - Parses agent frontmatter (`Triggers on`, `Use when/for`, skill names) to build keyword index
  - `route(input, projectDir)` — scores all agents against user input, returns best match
  - `scoreAgent()` — weighted scoring: exact keyword match (+10), partial match (+3), agent name match (+20), description word match (+2)
  - `DOMAIN_FALLBACKS` — 18 domain keyword groups for fallback matching (frontend, backend, debug, devops, security, database, testing, mobile, cloud, docker, documentation, go, angular, accessibility, i18n, game, iot, data)
  - `listAgents()` — list all agents with routing keywords (for `/agents` command)
  - CRLF-safe frontmatter parsing (Windows compatibility)
  - Per-project caching of agent metadata
- **Auto-route in `aiyu-multi-agent run`** — when no `--agent` specified, picks best agent from input instead of using first `.md` file
  - Prints `Auto-routed → <agent> (score: N, method: keyword)` when auto-routed
  - Falls back to `findDefaultAgent()` if no good match
- **Auto-route suggestion in chat** — per-message lightweight check shows `💡 Tip: <agent> may be a better fit` when another agent scores ≥10 higher
- **`/agent [name]`** — switch agent mid-session
  - `/agent debugger` — switch to specific agent by name
  - `/agent` — auto-route from last user message
  - `/agent backend` — auto-route using "backend" as input
  - Re-creates session with new agent, preserves message history
- **`/agents`** — list all available agents with their routing keywords
- **`findAgentByInput(input, projectDir)`** in `lib/utils.js` — utility wrapper around agent-router with fallback

#### Changed

- `lib/commands/run.js` — replaced `findDefaultAgent()` with `agentRouter.route()` when no `--agent` flag
- `lib/commands/chat.js` — added `/agent`, `/agents` slash commands, per-message auto-route suggestion
- `lib/utils.js` — added `findAgentByInput()` export

#### Routing Test Results

| Input | Routed Agent | Score |
|-------|-------------|-------|
| "fix the login bug" | `debugger` | 29 |
| "create a new API endpoint" | `backend-specialist` | 70 |
| "deploy to production" | `devops-engineer` | 36 |
| "make the button responsive" | `frontend-specialist` | 15 |
| "docker compose setup" | `docker-developer` | 30 |
| "security vulnerability scan" | `security-auditor` | 30 |
| "write unit tests" | `test-engineer` | 27 |

---

### Phase 5.4 — 6 UX Fixes (Mirror Energy + Signature Footer + Persona Kaomoji)

#### Added

- **Communication Style in system prompt** — `prompt-builder.js` now injects "Match user's energy and length" rule
  - Short greeting → short reply (1-2 lines)
  - Detailed question → detailed answer
  - Never dump capability menus unless explicitly asked
- **`renderAgentSignature(agentName)`** — Hermes-style footer signature (content-first, metadata-second)
  - e.g., `                    ─ accessibility-specialist (◕‿◕)♿`
  - Replaces verbose header that printed every turn
- **`PERSONA_KAOMOJI` table** — 15 persona-distinct kaomoji replacing generic 🤖
  - accessibility: (◕‿◕)♿, frontend: (｡◕‿◕｡)✧, backend: ╰(´◓ω◔`)╯, debug: (¬､¬)🔍, security: ⚔(ಠ_ಠ), etc.
  - Default fallback: (ฅ'ω'ฅ)

#### Fixed

- **[Step 1] Thinking... duplicate removed** — replaced with kaomoji spinner, only shown when content is substantial (>10 chars)
- **0 tokens hidden** — `[Done · 0.8s]` instead of `[Done · 0.8s, 0 tokens]` when provider doesn't count
- **Markdown asterisks stripped from streaming** — `**bold**` → `bold` in onToken path (full render in renderResponseBox)

#### Changed

- `lib/core/prompt-builder.js` — added `## Communication Style` section
- `lib/core/hermes-theme.js` — added `PERSONA_KAOMOJI`, `renderAgentSignature()`
- `lib/commands/chat.js` — thinking event uses kaomoji spinner, footer signature, markdown strip, hide 0 tokens

---

### Phase 5.3 — Trust Model Persistence + Claude-style 3-Level Trust

#### Added

- **Persistent default trust level** — `~/.aiyu/config.json` stores `default_trust_level` (ask/auto/yolo)
  - XDG-style: stored alongside other user config, not mixed with allowlist
  - Load priority: `--trust` CLI flag > user config > `"auto"` fallback
  - `/trust` slash command saves new level as default immediately
- **`user-config.setTrustLevel(level)`** — validates (ask|auto|yolo) + writes config atomically
- **Startup banner shows trust level** — `🔒 ask`, `⚖️ auto`, or `🔥 yolo` next to provider/model
- **`cli-ux-principles` skill** — `.windsurf/skills/cli-ux-principles/SKILL.md`
  - 5 UX principles for AI CLI platforms (trust, lifecycle, interruptibility, persistence, identity)
  - Architecture diagrams, Hermes parity matrix, file map
  - Reusable by any agent building CLI tools
- **Solution documentation** — `docs/Solution-aiyu-Approval-System.md`
  - Full implementation details, parity matrix, testing commands
  - `docs/HERMESBRAIN-REFERENCE.md` — copy-ready reference for HermesBrain vault

#### Changed

- `lib/commands/chat.js` — `/trust` slash command now calls `userConfig.setTrustLevel()` to persist
- `bin/cli.js` — `--strict`/`--yolo` replaced with unified `--trust <ask|auto|yolo>`
- `lib/core/user-config.js` — added `default_trust_level` field + `setTrustLevel()` helper

---

### Phase 5.2 — Hermes-style Dangerous-Command Approval

#### Added

- **`lib/core/command-classifier.js`** — 3-tier command safety analysis (safe / moderate / dangerous)
  - `classify(cmd)` → `{ tier, reason }` using `ALLOWED_COMMANDS` + `READ_ONLY` + `WRITE_CAPABLE` sets
  - `DANGEROUS_PATTERNS` — regex patterns for rm -rf, sudo, pipe-to-shell, fork bomb, etc.
  - `MODERATE_PATTERNS` — npm install, git checkout/merge/rebase, docker rm, etc.
  - `BLOCKED_FLAGS` integration — `-e`, `-c`, `-i`, `--eval` always dangerous
- **`lib/core/approval-store.js`** — JSON allowlist persistence (`~/.aiyu/allowlist.json`)
  - Scopes: `once` (no persistence), `session` (in-memory), `always` (JSON file)
  - File-based locking (`.lock` file) for concurrent write safety
  - `recordApproval()`, `isApproved()`, `listApprovals()`, `revokeApproval()`
  - SHA-256 hash of command for allowlist matching + drift detection
- **`lib/core/approval-prompt.js`** — Interactive TUI approval panel (Hermes-style)
  - Choices: `once` / `session` / `always` / `deny` / `view` (view only if command > 60 chars)
  - "always" choice hidden for `dangerous` tier commands
  - 60s auto-deny timeout (Hermes parity)
  - Non-TTY fallback → auto-deny
- **`guardrails.sandboxExecWithApproval()`** — Async approval-integrated exec
  - Classifies command → checks allowlist → prompts if needed → executes
  - Supports `strictMode` (ask even for safe) and `yoloMode` (skip all)
  - User-approved commands outside `ALLOWED_COMMANDS` still run with env sanitization
- **`shell.exec` tool** — Now uses `sandboxExecWithApproval` instead of hard block
  - Returns exit code 126 for `APPROVAL_DENIED`
  - Passes `_strictMode` and `_yoloMode` through tool args
- **CLI flags**: `--strict` (paranoid mode), `--yolo` (CI/CD mode)
- **Slash commands**: `/yolo` (toggle), `/trust` (session-approve moderate cmds), `/allowlist` (list/revoke)

#### Changed

- `lib/core/tool-definitions.js` — `shell.exec` replaced inline dangerous-pattern check + `sandboxExec` with `sandboxExecWithApproval`
- `lib/core/chat-session.js` — Accepts `strictMode` / `yoloMode` options, passes to tool args
- `lib/core/react-loop.js` — Passes `_strictMode` / `_yoloMode` in tool args
- `lib/commands/chat.js` — Initializes `yoloMode` from `--yolo` flag, `strictMode` from `--strict` flag

#### Hermes Parity

| Feature | Hermes | aiyu Phase 5.2 |
|---------|--------|----------------|
| 3-tier classification | ✓ (tirith) | ✓ (command-classifier) |
| once/session/always/deny | ✓ | ✓ |
| Persistent allowlist | ✓ (flock) | ✓ (lockfile) |
| Auto-deny timeout | 60s | 60s |
| "always" hidden for dangerous | ✓ | ✓ |
| /yolo bypass | ✓ | ✓ |
| --strict mode | ✗ | ✓ (leapfrog) |
| Project-scoped allowlist | ✓ | ✓ (via projectRoot) |

---

### Phase 5 — SQLite Persistence + Interactive Session Picker

#### Added

- **`lib/core/session-store.js`** — SQLite session persistence with `better-sqlite3` (file-based fallback if native module unavailable)
  - Schema: `sessions`, `messages`, `steps` tables with WAL mode
  - Methods: `createSession`, `saveTurn`, `listSessions`, `loadSession`, `deleteSession`, `cleanupOldSessions`, `searchSessions`
  - Backward compatible: reads legacy `~/.aiyu/history/*.json` files if session not found in SQLite
- **`/browse`** — Interactive arrow-key session picker with live filtering
  - Arrow keys (↑↓) to navigate, Enter to select, Esc to cancel
  - Type characters to filter sessions by title or ID
  - Shows title, agent name, date, and truncated session ID
- **`--resume [sessionId]`** — Resume saved session from CLI
  - `aiyu-multi-agent chat --resume <id>` — resume by specific ID
  - `aiyu-multi-agent chat --resume` — open interactive picker (same as `/browse`)
- **`--list`** — List saved sessions and exit
  - `aiyu-multi-agent chat --list` — prints all sessions with title + date
- **Per-turn persistence** — Each successful assistant response is saved as a "turn" with user message, assistant response, and ReAct steps
- **Steps stored in SQLite** — ReAct loop steps (thought, toolCalls, durationMs) persisted per turn for replay/debug
- **`turnCounter`** — Tracks conversation turns within a session, preserved across `/load` and `/browse`
- **Hermes-style tool lifecycle display** — 3-layer event callback pattern (preparing → completed)
  - `renderToolPreparing(tool)` — prints `┊ 📖 preparing fs.read…` before tool executes
  - `renderToolCompleted(tool, args, durationMs)` — per-tool formatter prints `┊ 📖 read  src/app.js  0.3s`
  - `_resolveToolIcon()` — maps namespaced tools (`fs.read`, `shell.exec`) → emoji icons
  - Tool icons: 📖 read, ✍️ write, ✏️ edit, 📂 glob, 🔍 grep, 💻 shell, 🌐 fetch, 🤖 delegate, 🧠 memory, 🌍 web, 📝 plan
- **`tool_started` / `tool_completed` events** — Event callback pattern in `chat-session.js` and `react-loop.js`
  - `onStep({ type: "tool_started", tool, args })` fires before execution
  - `onStep({ type: "tool_completed", tool, args, duration_ms, result/error })` fires after
  - `onToolEvent` callback added to `runAgent()` for non-chat execution path

#### Changed

- `lib/commands/chat.js` — Replaced file-based `saveSession`/`listSessions`/`loadSession` with `sessionStore` equivalents
- `/delete` — Now uses `sessionStore.deleteSession()` (works for both SQLite and legacy files)
- `/new` — Resets `turnCounter` to 0
- `/load` — Restores `turnCounter` from loaded session message count
- Auto-save after each turn — Now calls `sessionStore.saveTurn()` instead of rewriting entire JSON file

#### Hermes Parity + Leapfrog

| Feature | Hermes | aiyu Phase 5 |
|---------|--------|--------------|
| `--resume` | ✅ | ✅ |
| `--continue` | ✅ | ✅ (via `--resume` without args) |
| `sessions list` | ✅ | ✅ (via `--list`) |
| `sessions browse` | ✅ | ✅ (via `/browse` or `--resume`) |
| `/history` | ✅ | ✅ |
| `/save` | ✅ | ✅ |
| Backend | File-based | **SQLite** — faster, structured, searchable |
| Step persistence | ❌ (assumed) | **Steps table** — ReAct loop preserved |
| Live filter in picker | ❌ (assumed) | **Type to filter** |

---

## [0.4.0] - 2026-05-08

### Phase 4 — Session Management + File Attachments + Provider Switching

#### Added

- **`/rename <title>`** — set session title + persist to disk
- **`/delete <id>`** — delete saved session file
- **Auto-cleanup** — sessions older than 30 days are cleaned on startup
- **`/file <path>`** — attach text/code file with auto language detection
- **`/files`** — show pending file queue
- **`/removefile`** — remove last file from queue
- **`/clearfiles`** — clear all pending files
- Files formatted with `<file>` tags + fenced code blocks
- **`/provider <name>`** — switch LLM provider mid-session (`openai`/`claude`/`ollama`/`mock`)
- **`/model <name>`** — fixed `setModel` to actually affect LLM calls
- `setProvider()` added to `chat-session.js`
- `provider`/`model` now mutable closures (not `const`)

#### Changed

- `lib/commands/chat.js` — session management, file attachment, provider switching commands
- `lib/core/chat-session.js` — `setProvider()`, mutable provider/model state

---

## [0.3.0] - 2026-05-07

### Phase 3 — Streaming, Sessions, Image Queue, UI Polish

#### Added — 3C: Streaming Response

- **SSE (Server-Sent Events) parser** utility for streaming APIs
- **`callOpenAI`** — support streaming with `onToken` callback + tool call accumulation
- **`callClaude`** — support streaming with `onToken` callback + `text_delta` + `input_json_delta`
- `chat-session.js` — pass `onToken` through to LLM calls
- `chat.js` — display tokens in real-time, skip response box when streamed

#### Added — 3B: Auto-save Chat Sessions

- **Auto-save** session messages to `~/.aiyu/history/<id>.json` after each successful turn
- **`/history`** — lists saved sessions
- **`/load <id>`** — resumes a prior session
- **`/new`** — starts a new session id and persists empty session
- **`/save`** — now also persists session and prints session id
- `chat-session.setMessages()` — restore saved context

#### Added — 3A: Image Queue Management

- **`/clearimages`** — empty pending image queue entirely
- **Auto-delete temp image files** after successful LLM send to prevent disk clutter
- Keep temp images on error/cancel so user can retry with `/retry`
- `sentImagePaths` tracking for reliable cleanup

#### Changed — UI

- **Startup banner emoji** changed from ⚕ to ⚔ (`hermes-theme.js`)
- **Hermes response box** restored during streaming — top/bottom borders drawn, tokens inside box with indentation + Windows Terminal wrapping
- Avoid duplicated output by skipping post-render box when streaming

---

## [0.2.0] - 2026-05-07

### Phase 2 — Image Paste + Clipboard + Cancel + Ghost Text

#### Added

- **`/image` command** — reads clipboard image via PowerShell base64 extraction
- **Pending image queue** — `/images` and `/removeimage` commands
- **Auto-detect pasted image path** — when a message ends with an image extension (`.png`/`.jpg` etc.) and the path exists on disk, auto-convert to `[image:path]` reference (works when user copies a file from Windows Explorer and Ctrl+V pastes the path)
- **Ctrl+C cancel** — cancels AI thinking immediately with `AbortController`
- Stop failover chain on cancellation (`err.cancelled`)
- **Double Ctrl+C** — forces exit; prefill prompt after cancel
- **`[image:path]` → base64** content arrays for Claude/OpenAI APIs
- **Ghost text hint** — keypress listener with 150ms debounce shows hint on line below prompt when typing a partial slash command that matches exactly 1 command
- `_clearGhostHint()` on line submit, close, and next keypress
- `stripAnsiSafe` helper for cursor position calculation

#### Fixed

- **Empty message sends pending image** — ghost text cleanup timing fix
- **`/image` on Windows** — `pasteImageFromClipboard()` now writes a temp `.ps1` script file instead of inline PowerShell, fixing `$` escaping issues
- `/image` shows `[🖼 Image #N]` visual indicator (Hermes-style)
- `/new` and `/clear` reset `lastImagePath` and `imageCount`
- Removed broken Ctrl+V keypress handler (terminals intercept it for paste)

#### Changed

- `KEYBOARD_SHORTCUTS` updated: Ctrl+V → `/image`

---

## [0.1.0] - 2026-05-07

### Phase 1 — Hermes Theme Migration + Feature Parity

#### Added

- **Ctrl+R keybinding** — retry last message from idle prompt
- **Ctrl+V keybinding** — paste image from clipboard → `[image:path]`
- **`/compact` command** — toggle compact mode (manual override)
- `setCompactMode()` in `hermes-theme.js` with auto/manual toggle
- **Session title auto-gen** from first user message
- **Markdown-lite rendering** in response box: **bold**, *italic*, `code`, fenced code blocks, headings, lists (ordered/unordered), block quotes
- `KEYBOARD_SHORTCUTS` updated with Ctrl+R, Ctrl+V, `/compact`
- `pasteImageFromClipboard()` restored and wired to Ctrl+V

#### Changed — Theme Migration (`chalk` → `hermes-theme`)

All commands and `bin/cli.js` now use `H.style.*` instead of raw `chalk` calls for consistent theming across the entire CLI:

- **`bin/cli.js`** — status, trace, dev-mode, generate → `H.style`/`H.renderStartupBanner`
- **`add.js`** — error/statusWarn/statusGood/dim/text
- **`init.js` + `init-inline.js`** — spinner, created/linked messages, next steps
- **`inspect.js`** — agent info display, skill details
- **`publish.js`** — validation, packaging messages
- **`remove.js`** — uninstall feedback
- **`run.js`** — agent execution output
- **`test.js`** — test runner output

---

## Commits Covered

| Hash | Date | Message |
|------|------|---------|
| `TBD` | 2026-05-08 | Phase 5: SQLite persistence + interactive session picker |
| `9ea13a4` | 2026-05-08 | Phase 4: Session management + file attachments + provider switching |
| `c0fa973` | 2026-05-07 | UI: Change agentRunning symbol from ⚕ to ⚔ |
| `775a0e1` | 2026-05-07 | UI: Change startup banner emoji from ⚕ to ⚔ |
| `8ab4bbc` | 2026-05-07 | UI: Restore Hermes response box during streaming |
| `86d7677` | 2026-05-07 | Phase 3B: Auto-save chat sessions + load/resume |
| `93dbab5` | 2026-05-07 | Phase 3C: Streaming response for Claude and OpenAI |
| `9275993` | 2026-05-07 | Phase 3A: Image queue management polish |
| `4fd23f7` | 2026-05-07 | Phase 2: Image paste from clipboard + Ctrl+C cancel |
| `84ba2a8` | 2026-05-07 | feat(cli): auto-detect pasted image path + remove broken Ctrl+V handler |
| `6fe565a` | 2026-05-07 | fix(cli): empty message sends pending image + ghost text cleanup timing |
| `67b250a` | 2026-05-07 | fix(cli): /image command works on Windows + Hermes-style UX |
| `19c5fcb` | 2026-05-07 | feat(cli): ghost text hint for partial slash commands |
| `90c37ba` | 2026-05-07 | feat(cli): Phase 2 — Hermes feature parity |
| `70eec4e` | 2026-05-07 | refactor: migrate CLI commands from chalk to hermes-theme (H.style) |

**Total: 16 commits | +1,850 / −380 lines across 21 files**
