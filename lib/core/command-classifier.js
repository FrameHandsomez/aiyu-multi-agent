/**
 * Command Classifier — 3-tier command safety analysis
 *
 * safe     → run immediately (read-only, known-safe commands)
 * moderate → needs approval (write/mutate operations on allowed commands)
 * dangerous → needs approval + "always" choice hidden (rm -rf, sudo, pipe-to-shell, etc.)
 */

const { ALLOWED_COMMANDS, BLOCKED_FLAGS } = require("./guardrails");

// ── Read-only commands — never mutate filesystem ──────────────────
const READ_ONLY = new Set([
  "ls", "cat", "echo", "grep", "find", "head", "tail",
  "wc", "sort", "uniq", "git", "node", "python3",
  "which", "whoami", "pwd", "env", "printenv", "type",
  "stat", "file", "diff", "comm", "cut", "tr", "tee",
]);

// ── Write-capable commands — allowed but mutate filesystem ─────────
const WRITE_CAPABLE = new Set([
  "mkdir", "cp", "mv", "npm", "npx", "bun",
]);

// ── Dangerous regex patterns — always ask, hide "always" choice ───
const DANGEROUS_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s|--force\s)/,       // rm -rf, rm --force
  /\bsudo\b/,                                          // sudo anything
  /\bchmod\s+777\b/,                                   // chmod 777
  /\|\s*(sh|bash|zsh|dash|ksh)\b/,                     // pipe to shell
  />\s*\/etc\//,                                       // write to /etc
  /\bcurl\s+.*\|\s*(sh|bash)/,                         // curl | sh
  /\bdd\s+if=/,                                        // dd (disk destroy)
  /\bmkfs\b/,                                          // format filesystem
  /:\(\)\{.*:\|:&\};:/,                                // fork bomb
  /\bshutdown\b/,                                      // shutdown
  /\breboot\b/,                                        // reboot
  /\bkill\s+-9\s+1\b/,                                 // kill init
  /\bformat\s+[A-Z]:/i,                               // format drive (Windows)
  /\brmdir\s+\/[a-zA-Z]/,                              // rmdir root paths
  /\bgit\s+push\s+.*--force/,                          // force push
  /\bgit\s+reset\s+--hard/,                            // hard reset
  /\bnpm\s+publish/,                                   // npm publish (irreversible)
];

// ── Moderate patterns — write operations that need approval ───────
const MODERATE_PATTERNS = [
  /\bnpm\s+install\b/,          // npm install (adds node_modules)
  /\bnpm\s+uninstall\b/,        // npm uninstall
  /\bbun\s+(install|add|remove)\b/, // bun package ops
  /\bgit\s+checkout\b/,         // git checkout (switches branch)
  /\bgit\s+merge\b/,            // git merge
  /\bgit\s+rebase\b/,           // git rebase
  /\bgit\s+clean\b/,            // git clean (deletes untracked)
  /\bgit\s+stash\s+drop\b/,     // stash drop (irreversible)
  /\bdocker\s+(rm|rmi)\b/,      // docker remove
  /\bdocker\s+system\s+prune\b/, // docker prune
];

/**
 * Classify a command string into safety tier.
 *
 * @param {string} command  Full command string (e.g., "rm -rf /tmp/build")
 * @param {string[]} [args] Argument array (optional, used for flag analysis)
 * @returns {{ tier: "safe"|"moderate"|"dangerous", reason: string }}
 */
function classify(command, args) {
  if (!command || typeof command !== "string") {
    return { tier: "dangerous", reason: "Empty or invalid command" };
  }

  const cmd = command.trim();
  const base = cmd.includes("/") || cmd.includes("\\")
    ? cmd.split(/[/\\]/).pop().split(/\s/)[0]
    : cmd.split(/\s/)[0];

  // 1. Check BLOCKED_FLAGS first — always dangerous
  if (args && args.length > 0) {
    for (const arg of args) {
      for (const flag of BLOCKED_FLAGS) {
        if (arg === flag || arg.startsWith(flag + "=")) {
          return { tier: "dangerous", reason: `Blocked flag "${flag}" — arbitrary code execution` };
        }
        if (flag.length === 2 && arg.length > 2 && arg[0] === flag[0] && arg[1] === flag[1]) {
          const remainder = arg.slice(2);
          if (/[ '"();{}]/.test(remainder)) {
            return { tier: "dangerous", reason: `Blocked flag "${flag}" — arbitrary code execution` };
          }
        }
      }
    }
  }
  // Also check flags in the command string itself
  for (const flag of BLOCKED_FLAGS) {
    const flagPattern = new RegExp(`\\s${flag.replace("-", "\\-")}\\b`);
    if (flagPattern.test(cmd)) {
      return { tier: "dangerous", reason: `Blocked flag "${flag}" — arbitrary code execution` };
    }
  }

  // 2. Check dangerous patterns — always dangerous regardless of base command
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(cmd)) {
      return { tier: "dangerous", reason: `Matches dangerous pattern: ${pattern.source}` };
    }
  }

  // 3. Command not in ALLOWED_COMMANDS → dangerous
  if (!ALLOWED_COMMANDS.includes(base)) {
    return { tier: "dangerous", reason: `Command "${base}" not in allowed list` };
  }

  // 4. Check moderate patterns
  for (const pattern of MODERATE_PATTERNS) {
    if (pattern.test(cmd)) {
      return { tier: "moderate", reason: `Matches moderate pattern: ${pattern.source}` };
    }
  }

  // 5. Write-capable command → moderate
  if (WRITE_CAPABLE.has(base)) {
    return { tier: "moderate", reason: `"${base}" is write-capable` };
  }

  // 6. Read-only + in ALLOWED → safe
  if (READ_ONLY.has(base) && ALLOWED_COMMANDS.includes(base)) {
    return { tier: "safe", reason: `"${base}" is read-only and allowed` };
  }

  // 7. In ALLOWED but not explicitly classified → moderate (conservative)
  if (ALLOWED_COMMANDS.includes(base)) {
    return { tier: "moderate", reason: `"${base}" is allowed but not classified as read-only` };
  }

  // 8. Fallback — dangerous
  return { tier: "dangerous", reason: `Unrecognized command "${base}"` };
}

module.exports = { classify, READ_ONLY, WRITE_CAPABLE, DANGEROUS_PATTERNS, MODERATE_PATTERNS };
