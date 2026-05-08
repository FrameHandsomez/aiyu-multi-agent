/**
 * Approval Prompt — Interactive TUI for command approval
 *
 * Renders a Hermes-style approval panel with choices:
 *   once    → approve this invocation only
 *   session → approve for entire session
 *   always  → approve permanently (written to allowlist.json)
 *   deny    → block the command
 *   view    → show full command (only if truncated)
 *
 * For "dangerous" tier commands, "always" choice is hidden.
 */

const readline = require("readline");
const { classify } = require("./command-classifier");
const approvalStore = require("./approval-store");
const H = require("./hermes-theme");

const AUTO_DENY_TIMEOUT_MS = 60000; // 60s → auto-deny (Hermes parity)

// ── Render approval panel ─────────────────────────────────────────

function _renderPanel(command, tier, reason, showAlways) {
  const lines = [];

  // Header
  const borderColor = tier === "dangerous" ? H.style.statusBad : H.style.accent;
  lines.push(borderColor("╭─ ⚠ Command Approval ────────────────────────────────────────────╮"));

  // Command preview
  const maxCmdLen = 60;
  const truncated = command.length > maxCmdLen;
  const cmdPreview = truncated ? command.slice(0, maxCmdLen) + "…" : command;
  lines.push(borderColor("│") + ` ${H.style.accent(cmdPreview)}`.padEnd(67) + borderColor("│"));

  // Tier + reason
  const tierLabel = tier === "dangerous"
    ? H.style.statusBad("⛔ DANGEROUS")
    : H.style.accent("⚠ MODERATE");
  lines.push(borderColor("│") + ` ${tierLabel} — ${H.style.dim(reason)}`.slice(0, 66).padEnd(67) + borderColor("│"));

  // Choices
  const choices = _buildChoices(showAlways);
  lines.push(borderColor("│") + "                                                                " + borderColor("│"));
  lines.push(borderColor("│") + `  Choices:`.padEnd(67) + borderColor("│"));
  for (const c of choices) {
    lines.push(borderColor("│") + `    ${c.key}] ${c.label}`.padEnd(67) + borderColor("│"));
  }
  if (truncated) {
    lines.push(borderColor("│") + `    v] View full command`.padEnd(67) + borderColor("│"));
  }
  lines.push(borderColor("│") + "                                                                " + borderColor("│"));
  lines.push(borderColor("│") + `  Auto-deny in ${AUTO_DENY_TIMEOUT_MS / 1000}s`.padEnd(67) + borderColor("│"));

  lines.push(borderColor("╰────────────────────────────────────────────────────────────────╯"));

  return lines.join("\n");
}

function _buildChoices(showAlways) {
  const choices = [
    { key: "o", label: "once    — approve this time only", value: "once" },
    { key: "s", label: "session — approve for this session", value: "session" },
  ];
  if (showAlways) {
    choices.push({ key: "a", label: "always  — approve permanently (allowlist)", value: "always" });
  }
  choices.push({ key: "d", label: "deny    — block this command", value: "deny" });
  return choices;
}

// ── Interactive prompt ─────────────────────────────────────────────

/**
 * Prompt user for command approval.
 *
 * @param {string} command   Full command string
 * @param {object} [options]
 * @param {string} [options.projectRoot]  For project-scoped allowlist
 * @param {boolean} [options.strictMode]  If true, even "safe" commands need approval
 * @param {boolean} [options.yoloMode]    If true, auto-approve everything
 * @returns {Promise<{ approved: boolean, scope: string|null }>}
 */
async function promptApproval(command, options = {}) {
  const { projectRoot, strictMode = false, yoloMode = false } = options;

  // Yolo mode — auto-approve everything
  if (yoloMode) {
    return { approved: true, scope: "session" };
  }

  // Classify the command
  const { tier, reason } = classify(command);

  // Safe commands — auto-approve unless strict mode
  if (tier === "safe" && !strictMode) {
    return { approved: true, scope: null };
  }

  // Check if already approved (session or persistent)
  const existing = approvalStore.isApproved(command, projectRoot);
  if (existing.approved) {
    return { approved: true, scope: existing.scope };
  }

  // Need to ask — render panel and prompt
  const showAlways = tier !== "dangerous";
  const panel = _renderPanel(command, tier, reason, showAlways);
  console.log(panel);

  // If not TTY, auto-deny (can't prompt)
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(H.style.statusBad("  ✗ Auto-denied (non-interactive terminal)"));
    return { approved: false, scope: null };
  }

  const result = await _readChoice(command, showAlways, strictMode);

  if (result === "deny") {
    console.log(H.style.statusBad(`  ✗ Denied: ${command.split(/\s/)[0]}`));
    return { approved: false, scope: null };
  }

  if (result === "view") {
    console.log(H.style.dim(`  Full command: ${command}`));
    // Re-prompt after viewing
    return promptApproval(command, options);
  }

  // Record the approval
  approvalStore.recordApproval(command, result, projectRoot);
  const scopeLabel = result === "once" ? "this time" : result;
  console.log(H.style.statusGood(`  ✓ Approved (${scopeLabel}): ${command.split(/\s/)[0]}`));
  return { approved: true, scope: result };
}

// ── Read user choice with timeout ──────────────────────────────────

function _readChoice(command, showAlways, strictMode) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    const validKeys = new Set(["o", "s", "d"]);
    if (showAlways) validKeys.add("a");
    if (command.length > 60) validKeys.add("v");

    // Auto-deny timeout
    const timer = setTimeout(() => {
      rl.close();
      console.log(H.style.statusBad("\n  ✗ Auto-denied (60s timeout)"));
      resolve("deny");
    }, AUTO_DENY_TIMEOUT_MS);

    rl.question("  Your choice: ", (answer) => {
      clearTimeout(timer);
      rl.close();
      const key = answer.trim().toLowerCase();
      if (validKeys.has(key)) {
        resolve(key === "o" ? "once" : key === "s" ? "session" : key === "a" ? "always" : key === "v" ? "view" : "deny");
      } else {
        console.log(H.style.dim("  Invalid choice — denied by default"));
        resolve("deny");
      }
    });
  });
}

module.exports = { promptApproval, classify, AUTO_DENY_TIMEOUT_MS };
