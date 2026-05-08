# HermesBrain Vault Reference: aiyu Approval System

> **Copy this to:** `HermesBrain/Solutions/Solution-aiyu-Approval-System.md`
> **Date**: 2026-05-08

## Solution Summary

Ported Hermes-style dangerous-command approval system to `aiyu-multi-agent` with leapfrog improvements.

## Parity Matrix

| Feature | Hermes | aiyu | Status |
|---------|--------|------|--------|
| 3-tier classifier (safe/moderate/dangerous) | tirith | command-classifier.js | ✅ |
| once/session/always/deny choices | ✅ | ✅ | ✅ |
| Persistent allowlist | flock | lockfile (cross-platform) | ✅ |
| Auto-deny timeout (60s) | ✅ | ✅ | ✅ |
| "always" hidden for dangerous | ✅ | ✅ | ✅ |
| /yolo bypass | ✅ | ✅ | ✅ |
| --strict mode | ❌ | ✅ (leapfrog) | 🚀 |
| Mid-session trust toggle | ❌ | ✅ (leapfrog) | 🚀 |
| Config persistence (XDG-style) | ❌ | ✅ (leapfrog) | 🚀 |

## Files

- `lib/core/command-classifier.js` — 3-tier classification
- `lib/core/approval-store.js` — JSON allowlist + lockfile
- `lib/core/approval-prompt.js` — TUI approval panel
- `lib/core/guardrails.js` — `sandboxExecWithApproval()`
- `lib/commands/chat.js` — `/trust`, `/yolo`, `/allowlist`
- `bin/cli.js` — `--trust ask/auto/yolo`

## Full Documentation

See: `aiyu-multi-agent/docs/Solution-aiyu-Approval-System.md`

## Skill Reuse

Skill file: `.windsurf/skills/cli-ux-principles/SKILL.md`
- 5 UX principles for AI CLI platforms
- Based on analysis of Cascade, Claude Code, Hermes, Codex, OpenCode
