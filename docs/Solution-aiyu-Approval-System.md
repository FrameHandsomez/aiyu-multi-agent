# Solution: Hermes-style Dangerous-Command Approval for aiyu-multi-agent

> **Status**: ✅ Implemented, tested, committed
> **Commit**: Phase 5.2 — Hermes-style dangerous-command approval
> **Date**: 2026-05-08

## Problem

Hermes CLI has a sophisticated approval system for dangerous commands:
- 3-tier classification (safe/moderate/dangerous)
- once/session/always/deny choices
- Persistent allowlist with file locking
- 60s auto-deny timeout
- /yolo bypass mode

Cascade (IDE panel) only has Run/Skip. aiyu needed parity + leapfrog.

## Solution Architecture

### 4-Layer Stack

```
┌─────────────────────────────────────────┐
│  Layer 4: CLI + Slash Commands          │  bin/cli.js --trust, /trust, /yolo
│  Layer 3: Interactive TUI Prompt          │  lib/core/approval-prompt.js
│  Layer 2: JSON Allowlist + Locking        │  lib/core/approval-store.js
│  Layer 1: 3-Tier Command Classifier     │  lib/core/command-classifier.js
└─────────────────────────────────────────┘
              ↓
┌─────────────────────────────────────────┐
│  Integration: guardrails.sandboxExec    │  lib/core/guardrails.js
│  WithApproval() — async flow            │
└─────────────────────────────────────────┘
```

### Trust Model: 3 Levels (Claude-style)

```bash
aiyu --trust ask   # 🔒 approve ALL commands
aiyu --trust auto  # ⚖️ safe=auto, dangerous=ask (default)
aiyu --trust yolo  # 🔥 no approvals
```

- Default persisted in `~/.aiyu/config.json` (XDG-style)
- `--trust` CLI flag overrides config
- `/trust` mid-session cycles ask→auto→yolo, saves new default

### Command Classification

| Tier | Criteria | Action | "always" choice |
|------|----------|--------|-----------------|
| safe | read-only + allowed list | run immediately | N/A |
| moderate | write-capable (npm install, git checkout) | prompt | ✅ available |
| dangerous | rm -rf, sudo, pipe-to-shell, blocked flags | prompt | ❌ hidden |

### Files Changed

| File | Lines | Change |
|------|-------|--------|
| `lib/core/command-classifier.js` | new | 3-tier classifier with regex patterns |
| `lib/core/approval-store.js` | new | JSON allowlist + lockfile |
| `lib/core/approval-prompt.js` | new | TUI panel with once/session/always/deny/view |
| `lib/core/guardrails.js` | +54 | `sandboxExecWithApproval()` |
| `lib/core/tool-definitions.js` | ±20 | `shell.exec` → approval flow |
| `lib/core/chat-session.js` | +2 | pass strictMode/yoloMode to tools |
| `lib/core/react-loop.js` | +2 | pass strictMode/yoloMode to tools |
| `lib/commands/chat.js` | +60 | `/trust`, `/yolo`, `/allowlist`, `--trust` integration |
| `bin/cli.js` | +1 | `--trust <level>` flag |
| `lib/core/user-config.js` | +5 | `default_trust_level` persistence |
| `.windsurf/skills/cli-ux-principles/SKILL.md` | new | Reusable skill |

### Hermes Parity Matrix

| Feature | Hermes | aiyu Phase 5.2 | Status |
|---------|--------|----------------|--------|
| 3-tier classification | tirith | command-classifier.js | ✅ |
| once/session/always/deny | ✅ | ✅ | ✅ |
| Persistent allowlist | flock | lockfile | ✅ |
| Auto-deny timeout | 60s | 60s | ✅ |
| "always" hidden for dangerous | ✅ | ✅ | ✅ |
| /yolo bypass | ✅ | ✅ | ✅ |
| --strict mode | ❌ | ✅ (leapfrog) | 🚀 |
| Project-scoped allowlist | ✅ | ✅ | ✅ |
| Mid-session trust toggle | ❌ | ✅ (leapfrog) | 🚀 |
| Config persistence | ❌ | ✅ (leapfrog) | 🚀 |

## Testing

```bash
# Classifier
node -e "const {classify} = require('./lib/core/command-classifier')"
# → safe: ls, cat, git status
# → moderate: npm install, mkdir
# → dangerous: rm -rf, sudo, curl | sh

# Store
node -e "const s = require('./lib/core/approval-store'); s.recordApproval('npm install','session'); console.log(s.isApproved('npm install'))"
# → { approved: true, scope: 'session' }

# CLI
aiyu chat --trust ask      # strict mode
aiyu chat --trust yolo     # no approvals
aiyu chat                  # uses saved default
# then /trust → cycles ask→auto→yolo, saves default
```

## References

- Skill file: `.windsurf/skills/cli-ux-principles/SKILL.md`
- Changelog: `CHANGELOG_CLI.md` Phase 5.2
- Original Hermes analysis: HermesBrain vault

## Next Steps (Optional)

1. `~/.aiyu/dangerous-patterns.json` — user-extensible regex patterns
2. `aiyu trust list/revoke` — standalone CLI subcommand
3. `--dry-run` flag — preview what commands would need approval
