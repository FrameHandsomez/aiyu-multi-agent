# CLI Changelog

All notable changes to the **CLI layer** (`lib/commands/`, `bin/cli.js`, `lib/core/hermes-theme.js`, `lib/core/chat-session.js`, `lib/core/llm-providers.js`) will be documented in this file.

This changelog tracks the `aiyu-cli` branch exclusively. For platform-wide changes, see [CHANGELOG.md](./CHANGELOG.md).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [0.5.0] - 2026-05-08

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
