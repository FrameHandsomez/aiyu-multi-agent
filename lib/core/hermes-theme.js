/**
 * Hermes-style terminal theme for aiyu-multi-agent
 *
 * Ported from Hermes Agent CLI (Python / prompt_toolkit + Rich)
 * Adapted for Node.js with chalk ^4.1.2
 */

const chalk = require("chalk");

// ── Color Palette (Hermes hex → chalk approximations) ────────────────

const COLORS = {
  cream:          "#FFF8DC",   // primary text
  gold:           "#FFD700",   // accent / highlights
  dimGold:        "#B8860B",   // secondary accent
  darkBg:         "#1a1a2e",   // status bar / menu bg
  midBg:          "#333355",   // selected item bg
  bronze:         "#CD7F32",   // border lines
  silver:         "#C0C0C0",   // status bar text
  dimSilver:      "#8B8682",   // status bar dim text
  sage:           "#8FBC8F",   // status bar "good"
  orange:         "#FF8C00",   // status bar "warn"
  coral:          "#FF6B6B",   // status bar "critical"
  red:            "#FF4444",   // voice / error
};

// ── Prompt Symbols (per state) ──────────────────────────────────────

const PROMPT_SYMBOLS = {
  idle:            "\u276F ",         // ❯ (with trailing space)
  agentRunning:    "\u2695",          // ⚕
  commandRunning:  null,              // uses spinner frames instead
  approvalPending: "\u26A0",          // ⚠
  clarifyQuestion: "?",
  clarifyFreetext: "\u270E",          // ✎
  sudoPrompt:      "\uD83D\uDD10",    // 🔐
  voiceRecording:  "\u25CF",          // ●
  voiceProcessing: "\u25C9",          // ◉
};

// ── Braille Spinner Frames ───────────────────────────────────────────

const SPINNER_FRAMES = ["\u28CB","\u28D9","\u2839","\u2838","\u283C","\u2834","\u2826","\u2827","\u2807","\u280F"];
// ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏

// ── Kawaii Spinner (Thinking State) ───────────────────────────────────

const KAWAII_THINKING = [
  "(｡•́︿•̀｡)", "(◔_◔)", "(¬‿¬)",
  "( •_•)>⌐■-■", "(⌐■_■)", "(´･_･`)",
  "◉_◉", "(°ロ°)", "( ˘⌣˘)♡", "ヽ(>∀<☆)☆",
  "٩(๑❛ᴗ❛๑)۶", "(⊙_⊙)", "(¬_¬)",
  "( ͡° ͜ʖ ͡°)", "ಠ_ಠ",
];

const THINKING_VERBS = [
  "pondering", "contemplating", "musing", "cogitating",
  "ruminating", "deliberating", "meditating", "reflecting",
  "analyzing", "synthesizing", "processing", "computing",
];

// Indicator styles: kaomoji | emoji | unicode | ascii
const INDICATOR_STYLES = {
  kaomoji: { frames: KAWAII_THINKING, suffix: (i) => THINKING_VERBS[i % THINKING_VERBS.length] + "..." },
  emoji:   { frames: ["\uD83E\uDDE0","\uD83D\uDCAD","\u2728","\uD83D\uDD2E","\uD83D\uDCA1","\u26A1","\uD83D\uDCAB"], suffix: () => "" },
  unicode: { frames: SPINNER_FRAMES, suffix: () => "" },
  ascii:   { frames: ["|", "/", "-", "\\"], suffix: () => "" },
};

let currentIndicatorStyle = "kaomoji";

function setIndicatorStyle(styleName) {
  if (INDICATOR_STYLES[styleName]) {
    currentIndicatorStyle = styleName;
    return true;
  }
  return false;
}

function getIndicatorStyle() {
  return currentIndicatorStyle;
}

function getKawaiiSpinnerFrame(index) {
  const cfg = INDICATOR_STYLES[currentIndicatorStyle];
  const frame = cfg.frames[index % cfg.frames.length];
  const suffix = cfg.suffix ? cfg.suffix(index) : "";
  return suffix ? `${frame} ${suffix}` : frame;
}

// ── Box Drawing (Rich-style response panel) ──────────────────────────

const BOX = {
  topLeft:     "\u256D",   // ╭
  topRight:    "\u256E",   // ╮
  bottomLeft:  "\u2570",   // ╰
  bottomRight: "\u256F",   // ╯
  horizontal:  "\u2500",   // ─
  vertical:    "\u2502",   // │
};

// ── Chalk Style Builders ──────────────────────────────────────────────

const style = {
  /** Primary text — cream */
  text:        (s) => chalk.hex(COLORS.cream)(s),
  /** Accent — gold bold */
  accent:      (s) => chalk.hex(COLORS.gold).bold(s),
  /** Dim accent — dimGold */
  dimAccent:   (s) => chalk.hex(COLORS.dimGold)(s),
  /** Bronze border */
  border:      (s) => chalk.hex(COLORS.bronze)(s),
  /** Status bar bg + silver text */
  statusText:  (s) => chalk.bgHex(COLORS.darkBg).hex(COLORS.silver)(s),
  /** Status bar bg + gold bold */
  statusStrong:(s) => chalk.bgHex(COLORS.darkBg).hex(COLORS.gold).bold(s),
  /** Status bar bg + dim silver */
  statusDim:   (s) => chalk.bgHex(COLORS.darkBg).hex(COLORS.dimSilver)(s),
  /** Status bar bg + sage (good) */
  statusGood:  (s) => chalk.bgHex(COLORS.darkBg).hex(COLORS.sage).bold(s),
  /** Status bar bg + orange (warn) */
  statusWarn:  (s) => chalk.bgHex(COLORS.darkBg).hex(COLORS.orange).bold(s),
  /** Status bar bg + coral (critical) */
  statusBad:   (s) => chalk.bgHex(COLORS.darkBg).hex(COLORS.coral).bold(s),
  /** Completion menu item */
  menuItem:    (s) => chalk.bgHex(COLORS.darkBg).hex(COLORS.cream)(s),
  /** Completion menu selected item */
  menuSelected:(s) => chalk.bgHex(COLORS.midBg).hex(COLORS.gold)(s),
  /** Clarify selected */
  clarifySel:  (s) => chalk.hex(COLORS.gold).bold(s),
  /** Error */
  error:       (s) => chalk.hex(COLORS.coral).bold(s),
  /** Dim / secondary info */
  dim:         (s) => chalk.hex(COLORS.dimSilver)(s),
};

// ── Response Box Renderer ─────────────────────────────────────────────

/**
 * Render a Rich-style panel around agent response text.
 * ╭─⚕ Aiyu──────────────────╮
 *     response text (4-space indent)
 * ╰──────────────────────────╯
 */
function renderResponseBox(title, body, width) {
  const termWidth = width || process.stdout.columns || 80;
  const innerWidth = termWidth - 4; // borders + padding

  // Top border: ╭─⚕ Title──────╮
  const titleVisible = title ? (" " + title + " ") : "";
  const titleVisibleLen = visibleLen(titleVisible);
  const topContentLen = Math.max(0, innerWidth - titleVisibleLen);
  const topLine = BOX.topLeft + BOX.horizontal + style.accent(titleVisible) +
    BOX.horizontal.repeat(topContentLen) + BOX.topRight;

  // Body lines — 4-space indent, wrapped
  const bodyLines = [];
  for (const rawLine of body.split("\n")) {
    // Wrap long lines
    const lineVisLen = stripAnsi(rawLine).length;
    if (lineVisLen <= innerWidth - 4) {
      bodyLines.push("    " + rawLine);
    } else {
      // Simple wrap
      const words = rawLine.split(" ");
      let current = "";
      for (const word of words) {
        const test = current ? current + " " + word : word;
        if (stripAnsi(test).length > innerWidth - 4) {
          if (current) bodyLines.push("    " + current);
          current = word;
        } else {
          current = test;
        }
      }
      if (current) bodyLines.push("    " + current);
    }
  }

  // Bottom border: ╰──────╯
  const bottomLine = BOX.bottomLeft + BOX.horizontal.repeat(innerWidth) + BOX.bottomRight;

  return [
    style.border(topLine),
    ...bodyLines,
    style.border(bottomLine),
  ].join("\n");
}

// ── Status Bar Renderer ──────────────────────────────────────────────

/**
 * Format: ⚕ model │ tokens │ % │ elapsed │ lastStep
 * e.g.   ⚕ claude-opus-4 │ 12K/200K │ 6% │ 2m 30s │ 45.2s
 */
function renderStatusBar({ model, tokensUsed, tokensMax, percent, elapsed, lastStep }) {
  const parts = [];
  if (model)     parts.push(style.statusStrong(PROMPT_SYMBOLS.agentRunning + " " + model));
  if (tokensUsed !== undefined) {
    const tokStr = formatTokens(tokensUsed) + (tokensMax ? "/" + formatTokens(tokensMax) : "");
    parts.push(style.statusText(tokStr));
  }
  if (percent !== undefined) parts.push(style.statusText(percent + "%"));
  if (elapsed)   parts.push(style.statusText(elapsed));
  if (lastStep)  parts.push(style.statusDim(lastStep));
  return style.statusText(" " + parts.join(style.dim(" │ ")) + " ");
}

function formatTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "K";
  return String(n);
}

// ── Spinner Helper ───────────────────────────────────────────────────

function getSpinnerFrame(index) {
  return SPINNER_FRAMES[index % SPINNER_FRAMES.length];
}

// ── Utility ───────────────────────────────────────────────────────────

/** Strip ANSI escape codes to measure visible length */
function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, "");
}

/** Visible length of a string (ignoring ANSI codes) */
function visibleLen(str) {
  return stripAnsi(str).length;
}

/** Pad a possibly-ANSI string to a visible width */
function padVisible(str, width, alignRight = false) {
  const vLen = visibleLen(str);
  const pad = Math.max(0, width - vLen);
  if (alignRight) return " ".repeat(pad) + str;
  return str + " ".repeat(pad);
}

// ── Slash Command Autocomplete Styling ───────────────────────────────

/**
 * Render a completion dropdown for slash commands.
 * Mimics prompt_toolkit completion menu.
 */
function renderCompletionMenu(commands, selectedIndex, filterText) {
  const lines = [];
  const header = filterText
    ? `  Commands (/${filterText}*)`
    : "  Commands — Tab/↑↓ select, Enter confirm, Esc cancel";
  lines.push(style.accent(header));
  lines.push("");

  if (commands.length === 0) {
    lines.push(style.dim("  (no matching commands)"));
  } else {
    const maxCmdLen = Math.max(...commands.map(c => c.cmd.length));
    commands.forEach((item, i) => {
      const padded = padVisible(item.cmd, maxCmdLen + 2);
      if (i === selectedIndex) {
        lines.push("  " + style.menuSelected(padVisible(item.cmd, maxCmdLen + 2)) + " " + style.clarifySel(item.desc));
      } else {
        lines.push("  " + style.menuItem(padVisible(item.cmd, maxCmdLen + 2)) + " " + style.dim(item.desc));
      }
    });
  }
  lines.push("");
  return lines.join("\n");
}

// ── Ghost Text (inline auto-suggest) ─────────────────────────────────

/**
 * Render ghost text suggestion after the cursor.
 * The suggestion portion is rendered dim so it appears as "ghost" text.
 */
function renderGhostText(typed, suggestion) {
  if (!suggestion || suggestion === typed) return typed;
  const remaining = suggestion.slice(typed.length);
  if (!remaining) return typed;
  return typed + style.dim(remaining);
}

// ── Startup Banner ──────────────────────────────────────────────────

const BANNER_BOX = {
  topLeft:     "\u2554",   // ╔
  topRight:    "\u2557",   // ╗
  bottomLeft:  "\u255A",   // ╚
  bottomRight: "\u255D",   // ╝
  horizontal:  "\u2550",   // ═
  vertical:    "\u2551",   // ║
};

function renderStartupBanner({ version, model, contextWindow, width }) {
  const w = width || process.stdout.columns || 80;
  const innerW = Math.min(54, w - 4);
  const title = "\u2695 Aiyu MultiAgent — AI Agent Platform";
  const subtitle = `v${version || "2.x.x"} \u00B7 ${model || "claude-opus-4"} \u00B7 context: ${contextWindow || "200K"}`;

  // Compact mode for narrow terminals
  if (w < 42) {
    return style.accent(`\u2695 Aiyu MultiAgent — AI Agent Platform`);
  }

  const titleVisLen = visibleLen(title);
  const subVisLen = visibleLen(subtitle);
  const titlePad = Math.max(0, innerW - titleVisLen);
  const subPad = Math.max(0, innerW - subVisLen);

  const top = BANNER_BOX.topLeft + BANNER_BOX.horizontal.repeat(innerW + 2) + BANNER_BOX.topRight;
  const mid1 = BANNER_BOX.vertical + " " + style.accent(title) + " ".repeat(titlePad) + " " + BANNER_BOX.vertical;
  const mid2 = BANNER_BOX.vertical + " " + style.dimAccent(subtitle) + " ".repeat(subPad) + " " + BANNER_BOX.vertical;
  const bot = BANNER_BOX.bottomLeft + BANNER_BOX.horizontal.repeat(innerW + 2) + BANNER_BOX.bottomRight;

  return [style.border(top), mid1, mid2, style.border(bot)].join("\n");
}

// ── Tool Call Display (scrollback mode) ───────────────────────────────

const TOOL_ICONS = {
  search:   "\uD83D\uDD0D",   // 🔍
  read:     "\uD83D\uDCD6",   // 📖
  write:    "\u270D\uFE0F ",   // ✍️
  bash:     "\uD83D\uDCBB",    // 💻
  patch:    "\uD83D\uDD27",    // 🔧
  navigate: "\uD83C\uDF10",   // 🌐
  grep:     "\uD83D\uDD0D",   // 🔍
  edit:     "\u270F\uFE0F",    // ✏️
  glob:     "\uD83D\uDCC2",   // 📂
  default:  "\u26A1",          // ⚡
};

function renderToolCall({ tool, args, durationMs }) {
  const icon = TOOL_ICONS[tool] || TOOL_ICONS.default;
  const verb = tool.padEnd(9);
  const detail = args ? JSON.stringify(args).slice(0, 50) : "";
  const duration = durationMs ? (durationMs / 1000).toFixed(1) + "s" : "";
  const prefix = "\u250A "; // ┊
  return prefix + icon + " " + style.text(verb) + " " + style.dim(detail) + "  " + style.dim(duration);
}

// ── Paste Collapse Helper ─────────────────────────────────────────────

const PASTE_DIR = require("path").join(require("os").homedir(), ".aiyu", "pastes");

function collapsePaste(text, index = 1) {
  const lines = text.split("\n").length;
  return `[Pasted text #${index}: ${lines} lines → ${PASTE_DIR}]`;
}

function savePasteToFile(text, index = 1) {
  const fs = require("fs");
  const path = require("path");
  if (!fs.existsSync(PASTE_DIR)) {
    fs.mkdirSync(PASTE_DIR, { recursive: true });
  }
  const filePath = path.join(PASTE_DIR, `paste_${Date.now()}_${index}.txt`);
  fs.writeFileSync(filePath, text, "utf-8");
  return filePath;
}

// ── Inline Diff Preview ──────────────────────────────────────────────

function renderInlineDiff(oldText, newText) {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const output = [];

  // Simple line-by-line diff
  const maxLen = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < maxLen; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];
    if (oldLine === undefined) {
      output.push(chalk.bgHex("#1a3a1a").hex("#8FBC8F")("+ " + newLine));
    } else if (newLine === undefined) {
      output.push(chalk.bgHex("#3a1a1a").hex("#FF6B6B")("- " + oldLine));
    } else if (oldLine !== newLine) {
      output.push(chalk.bgHex("#3a1a1a").hex("#FF6B6B")("- " + oldLine));
      output.push(chalk.bgHex("#1a3a1a").hex("#8FBC8F")("+ " + newLine));
    }
  }
  return output.join("\n");
}

// ── Push-to-Bottom Helper ────────────────────────────────────────────

function pushToBottom() {
  // Clear screen and reset cursor to top-left for clean startup render
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[2J\x1b[H");
  }
}

// ── Compact Mode Check ───────────────────────────────────────────────

function isCompactMode() {
  return (process.stdout.columns || 80) < 40;
}

// ── Keyboard Shortcut Help ───────────────────────────────────────────

const KEYBOARD_SHORTCUTS = [
  ["Enter",         "Submit message"],
  ["\\ + Enter",    "Continue on new line (multiline)"],
  ["↑ / ↓",         "History navigation"],
  ["Tab",           "Autocomplete slash commands"],
  ["Ctrl+C",        "Interrupt (double = force exit)"],
  ["Ctrl+L",        "Clear screen"],
  ["/indicator",    "Switch spinner style (kaomoji/emoji/unicode/ascii)"],
];

// ── Exports ──────────────────────────────────────────────────────────

module.exports = {
  COLORS,
  PROMPT_SYMBOLS,
  SPINNER_FRAMES,
  BOX,
  style,
  renderResponseBox,
  renderStatusBar,
  renderCompletionMenu,
  renderGhostText,
  getSpinnerFrame,
  stripAnsi,
  visibleLen,
  padVisible,
  formatTokens,
  KEYBOARD_SHORTCUTS,
  // Bonus exports
  KAWAII_THINKING,
  THINKING_VERBS,
  INDICATOR_STYLES,
  setIndicatorStyle,
  getIndicatorStyle,
  getKawaiiSpinnerFrame,
  renderStartupBanner,
  renderToolCall,
  collapsePaste,
  savePasteToFile,
  renderInlineDiff,
  pushToBottom,
  isCompactMode,
};
