---
title: "CLI UX Principles for AI Agent Platforms"
description: "5 design principles for AI CLI interfaces: trust model, tool lifecycle, interruptibility, persistence, identity. Based on analysis of Cascade, Claude Code, Hermes, and aiyu-multi-agent implementation."
---

# CLI UX Principles for AI Agent Platforms

## Overview

This skill defines 5 UX principles derived from analyzing production AI CLI tools (Cascade, Claude Code, Hermes CLI, Codex, OpenCode) and the aiyu-multi-agent implementation.

## 5 Principles

### 1. Trust Model — "Ask as little as possible, but no less"

**Problem**: Cascade asks EVERY command → user fatigue. Hermes asks only dangerous → occasional risk.

**Solution**: Claude-style 3-level model with user choice:

```
aiyu --trust ask    → 🔒 approve ALL (beginner)
aiyu --trust auto   → ⚖️ safe=auto, dangerous=ask (default)
aiyu --trust yolo   → 🔥 no approvals (power user)
```

**Implementation**:
- `command-classifier.js` — 3-tier classifier (safe/moderate/dangerous)
- `approval-prompt.js` — once/session/always/deny/view + 60s auto-deny
- `approval-store.js` — JSON allowlist with file locking
- Persist default in `~/.aiyu/config.json` (XDG-style)
- Mid-session toggle via `/trust` slash command (cycles ask→auto→yolo)

**Key insight**: Power users (npm CLI audience) hate strict mode. Provide escape hatches.

---

### 2. Tool Lifecycle — "Show the thinking"

**Problem**: Silent tools make users think CLI is frozen.

**Solution**: Hermes-style 2-phase display:

```
  ┊ 📖 preparing fs.read…              ← BEFORE execution
  ┊ 📖 read       src/app.js  0.3s      ← AFTER (with duration)
```

**Implementation**:
- `renderToolPreparing(tool)` — prints preparing line
- `renderToolCompleted(tool, args, durationMs)` — per-tool formatter
- 12 tool-specific formatters (read→path, grep→pattern, exec→command, etc.)
- `_resolveToolIcon()` — maps namespaced tools to emoji icons

**Key insight**: Never print only on completion. User must see "something is happening".

---

### 3. Interruptibility — "Ctrl+C stops work, not session"

**Problem**: Killing process loses all context.

**Solution**:
- Single Ctrl+C → cancel current tool/agent (session survives)
- Double Ctrl+C (within 2s) → force exit
- `err.cancelled` caught → message prefilled for retry

**Implementation**:
- `InputReader._lastCtrlC` timestamp tracking
- `getReader().setBusy(fn)` / `setIdle()` during agent run
- `session.cancel()` via AbortController
- Pre-filled message on cancel for seamless retry

---

### 4. Persistence — "Never fear closing terminal"

**Problem**: Session lost on Ctrl+D or crash.

**Solution**:
- SQLite persistence (`~/.aiyu/sessions.db`)
- Auto-resume latest session on startup (`--resume`)
- Interactive session picker (`/browse`) with arrow keys + live filter
- Per-turn saves (not full rewrite)

**Implementation**:
- `session-store.js` — better-sqlite3 with WAL mode
- `chat.js` — `/browse`, `/load`, `/delete`, `--resume`, `--list`

---

### 5. Identity — "Don't be a clone"

**Problem**: Hermes clone = forgettable.

**Solution**: Pick ONE signature style and own it.

**aiyu signature**: Kaomoji default
```
  ฅ'ω'ฅ  reading the source code...
  (｡•̀ᴗ-)✧ thinking deeply...
  (ﾉ´ヮ`)ﾉ*: ･ﾟ✧ reasoning...
```

**Implementation**:
- `KAWAII_THINKING` array in `hermes-theme.js`
- `getKawaiiSpinnerFrame()` with thinking verbs
- 4 styles available but kaomoji is default
- Tool icons: 📖 read, ✍️ write, 🔍 grep, 💻 shell, 🤖 delegate, 🧠 memory

---

## Architecture: Approval System

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ shell.exec tool │────→│ sandboxExecWith  │────→│ command-        │
│                 │     │ Approval()       │     │ classifier.js │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                              │
                              ▼
                       ┌──────────────┐
                       │  Tier: safe  │────→ run immediately
                       │  Tier: mod   │────→ check allowlist → prompt
                       │  Tier: danger│───→ check allowlist → prompt (hide "always")
                       └──────────────┘
                              │
                              ▼
                       ┌──────────────┐     ┌──────────────┐
                       │ approval-    │←────│ JSON allow   │
                       │ prompt.js    │     │ list.json    │
                       │ (TUI panel)  │     │ (lockfile)   │
                       └──────────────┘     └──────────────┘
```

## File Map

| File | Purpose |
|------|---------|
| `lib/core/command-classifier.js` | 3-tier safety classification |
| `lib/core/approval-store.js` | JSON allowlist persistence |
| `lib/core/approval-prompt.js` | Interactive TUI approval panel |
| `lib/core/guardrails.js` | `sandboxExecWithApproval()` |
| `lib/core/hermes-theme.js` | Tool lifecycle renderers |
| `lib/commands/chat.js` | `/trust`, `/yolo`, `/allowlist` |
| `bin/cli.js` | `--trust` flag |

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| JSON over SQLite for allowlist | <1MB lifetime, debuggable with `cat`, portable |
| File locking over flock | Cross-platform (Windows lacks flock) |
| 3 tiers over binary | Matches Claude Code's `ask/accept-edits/plan` |
| Kaomoji default | Unique identity, memorable, not Hermes clone |
| `--trust` over `--strict`/`--yolo` | Unified flag, clearer mental model |
