/**
 * aiyu-multi-agent chat — Interactive session mode
 * Hermes-style TUI: prompt_toolkit-like autocomplete, Rich-like panels,
 * status bar, ghost text, spinner, multiline, image paste, file history.
 */

const chalk = require("chalk");
const readline = require("readline");
const fs = require("fs");
const path = require("path");
const os = require("os");

const config = require("../core/config");
const agentRuntime = require("../core/agent-runtime");
const userConfig = require("../core/user-config");
const utils = require("../utils");
const H = require("../core/hermes-theme");
const sessionStore = require("../core/session-store");

function showSlashMenu() {
  const lines = [];
  lines.push("");
  lines.push(H.style.accent("  ╭─ Slash Commands ─" + "─".repeat(40) + "╮"));
  lines.push("");
  // Derive main commands from SLASH_COMMANDS so this stays in sync with the picker
  const allCmds = [
    ...SLASH_COMMANDS.map(c => [c.cmd, c.desc]),
    // Config subcommands (detail-only, not in picker)
    ["/config set ...",  "Set API key, base URL, or model"],
    ["/config default",  "Set default provider and model"],
    ["/config reset",    "Reset config to defaults"],
    // Non-slash entries
    ["Ctrl+C",           "Interrupt / force exit (double)"],
    ["exit / quit",      "End session"],
  ];
  const maxCmd = Math.max(...allCmds.map(c => c[0].length));
  for (const [cmd, desc] of allCmds) {
    const padded = H.padVisible(H.style.accent(cmd), maxCmd + 2);
    lines.push(`  ${padded} ${H.style.dim(desc)}`);
  }
  lines.push("");
  lines.push(H.style.accent("  Keyboard Shortcuts:"));
  const maxKey = Math.max(...H.KEYBOARD_SHORTCUTS.map(k => k[0].length));
  for (const [key, action] of H.KEYBOARD_SHORTCUTS) {
    const padded = H.padVisible(H.style.accent(key), maxKey + 2);
    lines.push(`  ${padded} ${H.style.dim(action)}`);
  }
  lines.push("");
  lines.push(H.style.border("  ╰" + "─".repeat(56) + "╯"));
  lines.push("");
  console.log(lines.join("\n"));
}

const SLASH_COMMANDS = [
  { cmd: "/new",       desc: "Start a new session (clear history)" },
  { cmd: "/clear",     desc: "Alias for /new" },
  { cmd: "/history",   desc: "List saved chat sessions" },
  { cmd: "/browse",    desc: "Interactive session picker (arrow keys)" },
  { cmd: "/load",      desc: "Load a saved session by id" },
  { cmd: "/save",      desc: "Save conversation to file" },
  { cmd: "/rename",    desc: "Rename current session" },
  { cmd: "/delete",    desc: "Delete a saved session by id" },
  { cmd: "/retry",     desc: "Resend the last message to agent" },
  { cmd: "/undo",      desc: "Remove the last user/agent exchange" },
  { cmd: "/model",     desc: "Switch model for current provider" },
  { cmd: "/provider",  desc: "Switch LLM provider" },
  { cmd: "/config",    desc: "Show current config" },
  { cmd: "/statusbar", desc: "Toggle status bar visibility" },
  { cmd: "/indicator", desc: "Switch spinner style (kaomoji/emoji/unicode/ascii)" },
  { cmd: "/compact",   desc: "Toggle compact mode (minimal UI)" },
  { cmd: "/image",       desc: "Paste image from clipboard" },
  { cmd: "/images",      desc: "Show pending image queue" },
  { cmd: "/removeimage", desc: "Remove last image from queue" },
  { cmd: "/clearimages", desc: "Clear all pending images" },
  { cmd: "/file",        desc: "Attach a text/code file" },
  { cmd: "/files",       desc: "Show pending file attachments" },
  { cmd: "/removefile",  desc: "Remove last file from queue" },
  { cmd: "/clearfiles",  desc: "Clear all pending files" },
  { cmd: "/help",        desc: "Show this menu" },
];

/** Format file size in human-readable units */
function formatFileSize(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log2(bytes) / 10);
  const val = (bytes / (1 << (i * 10))).toFixed(i === 0 ? 0 : 1);
  return `${val} ${units[Math.min(i, units.length - 1)]}`;
}

/** Strip ANSI escape codes — safe version for internal use */
function stripAnsiSafe(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, "");
}

// ── Session History Persistence (SQLite via session-store) ─────────────

function generateSessionId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function saveSession(sessionId, agentName, provider, model, title, messages) {
  // Upsert session metadata
  sessionStore.createSession({ id: sessionId, agentName, provider, model, title });
  // Messages are persisted per-turn via saveTurn in the main loop
}

function listSessions() {
  return sessionStore.listSessions();
}

function loadSession(sessionId) {
  return sessionStore.loadSession(sessionId);
}

function deleteSavedSession(sessionId) {
  return sessionStore.deleteSession(sessionId);
}

function cleanupOldSessions(days = 30) {
  return sessionStore.cleanupOldSessions(days);
}

// ── Interactive Session Picker ────────────────────────────────────────

async function pickSession() {
  const sessions = listSessions();
  if (sessions.length === 0) {
    console.log(H.style.dim("\n  No saved sessions yet.\n"));
    return null;
  }

  if (!process.stdout.isTTY) {
    console.log(H.style.accent(`\n  Saved sessions (${sessions.length}):`));
    sessions.slice(0, 20).forEach((s) => {
      const when = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : "";
      const title = s.title || "Untitled";
      console.log(H.style.text(`    ${s.id}  ${title}${when ? "  —  " + when : ""}`));
    });
    console.log("");
    return null;
  }

  const items = sessions.slice(0, 50);
  const N = items.length;
  const LINES = N + 3; // header + N items + hint + extra

  // Ensure stdin is active
  process.stdin.resume();
  readline.emitKeypressEvents(process.stdin);
  try {
    process.stdin.setRawMode(true);
  } catch {
    // Non-TTY fallback
    console.log(H.style.accent(`\n  Saved sessions (${sessions.length}):`));
    items.forEach((s) => {
      const when = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : "";
      const title = s.title || "Untitled";
      console.log(H.style.text(`    ${s.id}  ${title}${when ? "  —  " + when : ""}`));
    });
    console.log("");
    return null;
  }

  return new Promise((resolve) => {
    let sel = 0;
    let filterText = "";

    // Reserve space
    process.stdout.write('\n'.repeat(LINES + 2));
    readline.moveCursor(process.stdout, 0, -(LINES + 2));

    const draw = () => {
      readline.cursorTo(process.stdout, 0);
      readline.clearScreenDown(process.stdout);

      const filtered = filterText
        ? items.filter(s => (s.title + s.id).toLowerCase().includes(filterText.toLowerCase()))
        : items;

      const displayItems = filtered.length > 0 ? filtered : items;
      const displayN = Math.min(displayItems.length, N);

      // Header
      process.stdout.write('\n' + H.style.accent(`  Sessions (${displayItems.length}/${items.length})`));
      if (filterText) process.stdout.write(H.style.dim(`  [filter: "${filterText}"]`));
      process.stdout.write('\n');

      for (let i = 0; i < displayN; i++) {
        const active = i === sel;
        const s = displayItems[i];
        const marker = active ? H.style.accent('❯ ') : '  ';
        const idStr = H.style.dim(s.id.slice(0, 12));
        const title = active ? H.style.accent((s.title || "Untitled").slice(0, 40)) : H.style.text((s.title || "Untitled").slice(0, 40));
        const when = s.updatedAt ? H.style.dim(new Date(s.updatedAt).toLocaleDateString()) : "";
        const agentTag = H.style.dim(`[${s.agentName}]`);
        process.stdout.write(`${marker}${title}  ${agentTag}  ${when}  ${idStr}\n`);
      }

      process.stdout.write(H.style.dim('  ↑↓ move   Enter select   Esc cancel   Type to filter') + '\n');
    };

    const cleanup = (selected) => {
      process.stdin.off('keypress', onKey);
      try { process.stdin.setRawMode(false); } catch {}
      readline.moveCursor(process.stdout, 0, -(LINES + 2));
      readline.cursorTo(process.stdout, 0);
      readline.clearScreenDown(process.stdout);
      resolve(selected);
    };

    const onKey = (str, key) => {
      if (!key) {
        // Character input for filtering
        if (str && str.length === 1 && str.charCodeAt(0) >= 32) {
          filterText += str;
          sel = 0;
          readline.moveCursor(process.stdout, 0, -(LINES + 2));
          draw();
        }
        return;
      }
      if (key.name === 'up') {
        sel = Math.max(0, sel - 1);
        readline.moveCursor(process.stdout, 0, -(LINES + 2));
        draw();
      } else if (key.name === 'down') {
        const filtered = filterText
          ? items.filter(s => (s.title + s.id).toLowerCase().includes(filterText.toLowerCase()))
          : items;
        sel = Math.min(filtered.length - 1, sel + 1);
        readline.moveCursor(process.stdout, 0, -(LINES + 2));
        draw();
      } else if (key.name === 'return') {
        const filtered = filterText
          ? items.filter(s => (s.title + s.id).toLowerCase().includes(filterText.toLowerCase()))
          : items;
        if (filtered[sel]) cleanup(filtered[sel]);
        else cleanup(null);
      } else if (key.name === 'escape') {
        cleanup(null);
      } else if (key.name === 'backspace') {
        if (filterText.length > 0) {
          filterText = filterText.slice(0, -1);
          sel = 0;
        }
        readline.moveCursor(process.stdout, 0, -(LINES + 2));
        draw();
      } else if (key.ctrl && key.name === 'c') {
        cleanup(null);
      }
    };

    draw();
    process.stdin.on('keypress', onKey);
  });
}

// ── File Attachment Helpers ───────────────────────────────────────────

function getLangFromExt(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    ".js": "javascript", ".ts": "typescript", ".jsx": "jsx", ".tsx": "tsx",
    ".py": "python", ".rb": "ruby", ".java": "java", ".c": "c", ".cpp": "cpp",
    ".cs": "csharp", ".go": "go", ".rs": "rust", ".php": "php",
    ".html": "html", ".htm": "html", ".css": "css", ".scss": "scss", ".sass": "sass",
    ".json": "json", ".xml": "xml", ".yaml": "yaml", ".yml": "yaml",
    ".md": "markdown", ".sh": "bash", ".ps1": "powershell", ".sql": "sql",
    ".swift": "swift", ".kt": "kotlin", ".scala": "scala", ".r": "r",
    ".dart": "dart", ".lua": "lua", ".vim": "vim",
  };
  return map[ext] || ext.slice(1) || "text";
}

function formatFileAttachment(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return `[Error: file not found: ${filePath}]`;
    }
    const content = fs.readFileSync(filePath, "utf-8");
    const lang = getLangFromExt(filePath);
    const name = path.basename(filePath);
    return `\n<file path="${filePath}" language="${lang}">\n\`\`\`${lang}\n${content}\n\`\`\`\n</file>\n`;
  } catch (err) {
    return `[Error reading file: ${filePath} - ${err.message}]`;
  }
}

/**
 * Persistent readline reader — one instance per session.
 *
 * Features:
 *   - Tab completion for slash commands
 *   - Multiline input via \ at end of line
 *   - Ctrl+L clear screen
 *   - Double Ctrl+C force exit
 *   - Ctrl+C during agent run = cancel
 *
 * Why singleton: creating a new readline interface per message on
 * Windows/PowerShell can leave stdin paused after inquirer runs,
 * causing the next rl to fire `close` before `line` → "exit" immediately.
 */
class InputReader {
  constructor() {
    this._rl = null;
    this._resolver = null;
    this._lastCtrlC = 0;
    this._onCancel = null;
    this._onRetry = null;
    this._multiline = false;
    this._multilineBuf = "";
  }

  /** Call while agent is processing — Ctrl+C triggers fn instead of exit. */
  setBusy(fn) { this._onCancel = fn; }
  setIdle()   { this._onCancel = null; }

  prefill(text) {
    if (!this._rl) return;
    const v = text == null ? "" : String(text);
    try {
      this._rl.write(null, { ctrl: true, name: "u" });
      if (v) this._rl.write(v);
    } catch {}
  }

  /** Clear the ghost hint line below the prompt */
  _clearGhostHint() {
    if (!this._ghostHintLine) return;
    // Move down, clear that line, move back up
    readline.moveCursor(process.stdout, 0, 1);
    readline.clearLine(process.stdout, 0);
    readline.moveCursor(process.stdout, 0, -1);
    this._ghostHintLine = "";
  }

  _completer(line) {
    const trimmed = line.trimStart();
    // Only complete slash commands
    if (!trimmed.startsWith("/")) return [[], line];
    const hits = SLASH_COMMANDS.filter(c => c.cmd.startsWith(trimmed));
    if (hits.length === 0) return [[], line];
    // Return completions + the shared prefix up to where the cursor is
    return [hits.map(c => c.cmd), line];
  }

  _init() {
    if (this._rl) return;
    process.stdin.resume();
    this._rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      historySize: 100,
      removeHistoryDuplicates: true,
      completer: (line) => this._completer(line),
    });

    this._rl.on("line", (raw) => {
      const input = raw.replace(/\r$/, "");
      // Multiline continuation: line ending with \ → collect more lines
      if (input.endsWith("\\") && !input.endsWith("\\\\")) {
        const content = input.slice(0, -1); // remove trailing \
        this._multilineBuf += (this._multilineBuf ? "\n" : "") + content;
        this._multiline = true;
        this._rl.setPrompt(H.style.dim("  │ ") + " ");
        this._rl.prevRows = 0;
        this._rl.prompt();
        return;
      }
      // Finalize: append this line to any accumulated multiline buffer
      const fullInput = this._multiline
        ? this._multilineBuf + "\n" + input
        : input;
      this._multiline = false;
      this._multilineBuf = "";

      if (!this._resolver) return;
      const resolve = this._resolver;
      this._resolver = null;
      resolve(fullInput);
    });

    this._rl.on("close", () => {
      this._clearGhostHint();
      if (this._resolver) {
        this._resolver("exit");
        this._resolver = null;
      }
    });

    this._rl.on("SIGINT", () => {
      const now = Date.now();
      if (now - this._lastCtrlC < 2000) {
        console.log(H.style.statusWarn("\n  Force exit. Goodbye!\n"));
        this.close();
        process.exit(0);
      }
      this._lastCtrlC = now;

      // While agent is running, Ctrl+C cancels it (not exit).
      if (this._onCancel) {
        this._onCancel();
        return;
      }
      // In multiline mode, cancel the continuation
      if (this._multiline) {
        this._multiline = false;
        this._multilineBuf = "";
        console.log(H.style.dim("\n  (multiline cancelled)"));
        this._rl.setPrompt(H.style.accent(H.PROMPT_SYMBOLS.idle) + " ");
        this._rl.prevRows = 0;
        this._rl.prompt();
        return;
      }
      console.log(H.style.statusWarn("\n  (Ctrl+C again to force exit)\n"));
      if (this._resolver) this._rl.prompt();
    });

    this._rl.on("SIGCONT", () => {
      this._rl.prompt(true);
    });

    // Ctrl+L → clear screen, Ctrl+R → retry, Ctrl+V → paste image
    // Also: ghost text hint for partial slash commands
    readline.emitKeypressEvents(process.stdin);
    this._ghostHintLine = "";
    const onKeypress = (str, key) => {
      if (key && key.ctrl && !key.meta) {
        if (key.name === "l") this.clearScreen();
        else if (key.name === "r" && this._onRetry) this._onRetry();
        return;
      }
      // Ghost text: after a short delay, show partial slash hint below prompt
      // We write it on the NEXT line and move cursor back — readline still
      // owns the current line so its internal state stays consistent.
      if (this._ghostTimer) clearTimeout(this._ghostTimer);
      // Clear on Enter BEFORE readline redraws (cursor still on input line)
      if (key && (key.name === "return" || key.name === "escape")) {
        this._clearGhostHint();
        return;
      }
      this._clearGhostHint();
      this._ghostTimer = setTimeout(() => {
        const line = this._rl?.line?.trimStart() || "";
        if (!line.startsWith("/") || line.length < 2) return;
        const exact = SLASH_COMMANDS.find(c => c.cmd === line);
        if (exact) return; // already a full command
        const hits = SLASH_COMMANDS.filter(c => c.cmd.startsWith(line));
        if (hits.length !== 1) return;
        const suffix = hits[0].cmd.slice(line.length);
        const hint = H.style.dim(hits[0].cmd + "  — " + hits[0].desc);
        this._ghostHintLine = hint;
        // Write hint on the line below, then move cursor back up
        process.stdout.write("\n" + hint);
        readline.moveCursor(process.stdout, 0, -1);
        // Move cursor to end of current input line
        const cursorPos = (this._rl?.cursor ?? 0);
        const lineLen = stripAnsiSafe(this._rl?.line ?? "").length;
        readline.moveCursor(process.stdout, cursorPos - lineLen, 0);
      }, 150);
    };
    process.stdin.on("keypress", onKeypress);
    // Store reference so we can clean up on close()
    this._keypressHandler = onKeypress;
  }

  read(promptSymbol) {
    this._init();
    return new Promise((resolve) => {
      this._resolver = resolve;
      this._multiline = false;
      this._multilineBuf = "";
      this._rl.setPrompt(H.style.accent(promptSymbol) + " ");
      // Reset prevRows so _refreshLine() won't move the cursor up into
      // previously-printed output (e.g. slash menu) and call clearScreenDown on it.
      this._rl.prevRows = 0;
      this._rl.prompt();
    });
  }

  /** Clear the terminal screen (Ctrl+L handler). */
  clearScreen() {
    process.stdout.write("\x1b[2J\x1b[H");
    if (this._rl) this._rl.prompt(true);
  }

  // Pre-load file history into readline's in-memory history array.
  loadHistory(entries = []) {
    this._init();
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i] && !this._rl.history.includes(entries[i])) {
        this._rl.history.push(entries[i]);
      }
    }
  }

  close() {
    if (this._rl) {
      if (this._keypressHandler) {
        process.stdin.off("keypress", this._keypressHandler);
        this._keypressHandler = null;
      }
      this._rl.close();
      this._rl = null;
    }
  }
}

// Module-level singleton so it survives across re-prompts in the same session.
let _reader = null;

function getReader() {
  if (!_reader) _reader = new InputReader();
  return _reader;
}

function closeReader() {
  if (_reader) {
    _reader.close();
    _reader = null;
  }
}

/**
 * Read one line of input via InputReader singleton.
 * Returns the trimmed text.
 */
async function readInput(promptSymbol) {
  const reader = getReader();
  const raw = await reader.read(promptSymbol);
  return raw.trim();
}

/**
 * Attempt to paste image from clipboard.
 * Saves to a temp file and returns the path, or null if no image.
 *
 * On Windows: uses base64 encoding via PowerShell because PowerShell
 * cannot pipe binary data reliably through cmd.exe / Node.js execSync.
 * On WSL2: uses powershell.exe to access Windows clipboard from Linux.
 */
function pasteImageFromClipboard() {
  const tmpDir = path.join(os.tmpdir(), "aiyu-chat-images");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const imgPath = path.join(tmpDir, `paste-${Date.now()}.png`);
  try {
    const { execSync } = require("child_process");
    if (process.platform === "win32") {
      // Hermes-style: extract as base64 then decode to PNG
      const scriptPath = path.join(tmpDir, `_clip-${Date.now()}.ps1`);
      const script = [
        "Add-Type -AssemblyName System.Windows.Forms,System.Drawing",
        "$img = $null",
        "for ($i = 0; $i -lt 10; $i++) {",
        "  try { $img = [System.Windows.Forms.Clipboard]::GetImage() } catch { $img = $null }",
        "  if ($null -ne $img) { break }",
        "  Start-Sleep -Milliseconds 80",
        "}",
        "if ($null -eq $img) { Write-Host 'NO_IMAGE'; exit }",
        "$ms = New-Object System.IO.MemoryStream",
        "$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)",
        "$b64 = [System.Convert]::ToBase64String($ms.ToArray())",
        "Write-Host $b64",
      ].join("\n");
      fs.writeFileSync(scriptPath, script, "utf-8");
      const result = execSync(
        `powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "${scriptPath}"`,
        { stdio: ["pipe", "pipe", "pipe"], timeout: 5000, encoding: "utf-8" }
      ).trim();
      try { fs.unlinkSync(scriptPath); } catch {}
      if (result && !result.startsWith("NO_IMAGE")) {
        const buf = Buffer.from(result, "base64");
        fs.writeFileSync(imgPath, buf);
        if (fs.existsSync(imgPath) && fs.statSync(imgPath).size > 0) return imgPath;
      }
    } else if (process.platform === "darwin") {
      execSync(`pngpaste ${imgPath}`, { stdio: "pipe", timeout: 3000 });
      if (fs.existsSync(imgPath) && fs.statSync(imgPath).size > 0) return imgPath;
    } else {
      // Linux / WSL2
      const isWSL = fs.existsSync("/proc/version") &&
        fs.readFileSync("/proc/version", "utf-8").toLowerCase().includes("microsoft");
      if (isWSL) {
        // WSL2: use powershell.exe to access Windows clipboard
        const result = execSync(
          `powershell.exe -NoProfile -Command "` +
          `Add-Type -AssemblyName System.Windows.Forms,System.Drawing;` +
          `$img=[System.Windows.Forms.Clipboard]::GetImage();` +
          `if($null -eq $img){exit 1};` +
          `$ms=New-Object System.IO.MemoryStream;` +
          `$img.Save($ms,[System.Drawing.Imaging.ImageFormat]::Png);` +
          `[System.Convert]::ToBase64String($ms.ToArray())"`,
          { stdio: ["pipe", "pipe", "pipe"], timeout: 5000, encoding: "utf-8" }
        ).trim();
        if (result) {
          const buf = Buffer.from(result, "base64");
          fs.writeFileSync(imgPath, buf);
          if (fs.existsSync(imgPath) && fs.statSync(imgPath).size > 0) return imgPath;
        }
      } else {
        // Native Linux
        execSync(`xclip -selection clipboard -t image/png -o > ${imgPath}`, { stdio: "pipe", timeout: 3000 });
        if (fs.existsSync(imgPath) && fs.statSync(imgPath).size > 0) return imgPath;
      }
    }
  } catch { /* no image in clipboard or tool not available */ }
  return null;
}

// ── Persistent History (FileHistory-like) ─────────────────────────────

const HISTORY_DIR = path.join(os.homedir(), ".aiyu");
const HISTORY_FILE = path.join(HISTORY_DIR, "chat_history.json");
const MAX_HISTORY = 1000;

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
    }
  } catch { /* ignore */ }
  return [];
}

function saveHistory(history) {
  try {
    if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });
    const trimmed = history.slice(-MAX_HISTORY);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(trimmed, null, 2), "utf-8");
  } catch { /* ignore */ }
}

// ── Status Bar ────────────────────────────────────────────────────────

let statusBarVisible = true;
let statusBarInterval = null;
let spinnerIndex = 0;
let pasteCount = 0;

function startStatusBar(agentName, model, provider) {
  if (!statusBarVisible || !process.stdout.isTTY) return;
  const startTime = Date.now();
  spinnerIndex = 0;
  statusBarInterval = setInterval(() => {
    spinnerIndex++;
    const elapsed = formatElapsed(Date.now() - startTime);
    const spinner = H.isCompactMode() ? H.getSpinnerFrame(spinnerIndex) : H.getKawaiiSpinnerFrame(spinnerIndex);
    const bar = H.renderStatusBar({
      model: model || provider || "mock",
      elapsed,
      lastStep: spinner,
    });
    process.stdout.write("\r\x1b[2K" + bar);
  }, 200);
}

function stopStatusBar() {
  if (statusBarInterval) {
    clearInterval(statusBarInterval);
    statusBarInterval = null;
  }
  if (statusBarVisible && process.stdout.isTTY) {
    process.stdout.write("\r\x1b[2K"); // clear the bar line
  }
}

function formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}m ${sec.toString().padStart(2, "0")}s`;
}

/**
 * Interactive arrow-key command picker.
 * No external dependencies — uses raw TTY keypresses directly.
 */
async function pickCommand() {
  const items = SLASH_COMMANDS;
  const N = items.length;
  const LINES = N + 2; // 1 blank + N items + 1 hint
  const maxDesc = Math.max(20, (process.stdout.columns || 80) - 20); // prevent line wrap

  if (!process.stdout.isTTY) {
    showSlashMenu();
    return null;
  }

  // Ensure stdin is active after closeReader() paused it
  process.stdin.resume();
  readline.emitKeypressEvents(process.stdin);
  try {
    process.stdin.setRawMode(true);
  } catch {
    showSlashMenu();
    return null;
  }

  return new Promise((resolve) => {
    let sel = 0;

    // Reserve space below to prevent scrolling during redraws
    process.stdout.write('\n'.repeat(LINES));
    readline.moveCursor(process.stdout, 0, -LINES);

    const draw = () => {
      readline.cursorTo(process.stdout, 0);
      readline.clearScreenDown(process.stdout);
      process.stdout.write('\n');
      for (let i = 0; i < N; i++) {
        const active = i === sel;
        const marker = active ? H.style.accent('❯ ') : '  ';
        const cmd    = active ? H.style.accent(items[i].cmd.padEnd(13)) : H.style.dim(items[i].cmd.padEnd(13));
        const desc   = items[i].desc.slice(0, maxDesc);
        process.stdout.write(marker + cmd + '  ' + H.style.dim(desc) + '\n');
      }
      process.stdout.write(H.style.dim('  ↑↓ move   Enter select   Esc cancel') + '\n');
    };

    const cleanup = (selected) => {
      process.stdin.off('keypress', onKey);
      try { process.stdin.setRawMode(false); } catch {}
      readline.moveCursor(process.stdout, 0, -LINES);
      readline.cursorTo(process.stdout, 0);
      readline.clearScreenDown(process.stdout);
      resolve(selected);
    };

    const onKey = (str, key) => {
      if (!key) return;
      if (key.name === 'up')                 { sel = (sel - 1 + N) % N; readline.moveCursor(process.stdout, 0, -LINES); draw(); }
      else if (key.name === 'down')          { sel = (sel + 1) % N;     readline.moveCursor(process.stdout, 0, -LINES); draw(); }
      else if (key.name === 'return')        cleanup(items[sel].cmd);
      else if (key.name === 'escape')        cleanup(null);
      else if (key.ctrl && key.name === 'c') cleanup(null);
    };

    draw();
    process.stdin.on('keypress', onKey);
  });
}

async function run(options = {}) {
  const projectDir = process.cwd();

  if (!config.configExists(projectDir)) {
    console.log(H.style.error("No config directory found. Run `aiyu-multi-agent init` first.\n"));
    return;
  }

  // ── Handle --list (sessions list) ──
  if (options.list) {
    const sessions = listSessions();
    if (sessions.length === 0) {
      console.log(H.style.dim("\n  No saved sessions yet.\n"));
      return;
    }
    console.log(H.style.accent(`\n  Saved sessions (${sessions.length}):`));
    sessions.slice(0, 30).forEach((s) => {
      const when = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : "";
      const title = s.title || "Untitled";
      console.log(H.style.text(`    ${s.id}  ${title}${when ? "  —  " + when : ""}`));
    });
    console.log("");
    return;
  }

  const agentName = options.agent || utils.findDefaultAgent(projectDir);
  if (!agentName) {
    console.log(H.style.error("No agent found. Specify with --agent <name>\n"));
    return;
  }
  if (!utils.isValidAgentName(agentName)) {
    console.log(H.style.error(`Invalid agent name: "${agentName}" — cannot contain: / \\ : * ? " < > |\n`));
    return;
  }

  const provider = options.provider;
  let model = options.model;

  // ── Handle --resume ──
  let resumeSession = null;
  if (options.resume) {
    if (typeof options.resume === "string" && options.resume.length > 0) {
      // Resume by specific ID
      const loaded = loadSession(options.resume);
      if (loaded && Array.isArray(loaded.messages)) {
        resumeSession = loaded;
        console.log(H.style.statusGood(`\n  Resuming session: ${loaded.title || options.resume}`));
        console.log(H.style.dim(`  (${loaded.messages.length} messages)\n`));
      } else {
        console.log(H.style.error(`\n  Session not found: ${options.resume}\n`));
        return;
      }
    } else {
      // Interactive picker
      const picked = await pickSession();
      if (picked) {
        const loaded = loadSession(picked.id);
        if (loaded && Array.isArray(loaded.messages)) {
          resumeSession = loaded;
          console.log(H.style.statusGood(`\n  Resuming session: ${loaded.title || picked.id}`));
          console.log(H.style.dim(`  (${loaded.messages.length} messages)\n`));
        } else {
          console.log(H.style.error(`\n  Session not found: ${picked.id}\n`));
          return;
        }
      } else {
        console.log(H.style.dim("\n  Resume cancelled. Starting new session.\n"));
      }
    }
  }

  // ── Push cursor to bottom ──
  H.pushToBottom();

  // ── Session header (Hermes-style banner) ──
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf-8"));
  console.log(H.renderStartupBanner({
    version: pkg.version,
    model: model || provider || "mock",
    contextWindow: "200K",
  }));

  if (!H.isCompactMode()) {
    console.log(H.style.text(`    Chat with: ${H.style.accent(agentName)}`));
    if (provider) console.log(H.style.dim(`    Provider:  ${provider}`));
    if (model)    console.log(H.style.dim(`    Model:     ${model}`));
    console.log(H.style.dim("    Type your message, or 'exit' to quit"));
    console.log(H.style.dim("    Type '/' for slash commands"));
  }
  console.log("");

  let session;
  let lastUserMessage = "";
  const pendingImages = []; // Hermes-style image queue
  const pendingFiles = []; // File attachment queue
  let imageCounter = 0;
  let fileCounter = 0;
  let sessionTitle = resumeSession?.title || "";
  let sessionId = resumeSession?.id || generateSessionId();
  let turnCounter = 0;
  // Load persistent history + pre-load into readline
  const fileHistory = loadHistory();
  const inputHistory = [...fileHistory];
  getReader().loadHistory(fileHistory);

  // Real-time step display callback (Hermes-style)
  const onStep = (evt) => {
    stopStatusBar();
    switch (evt.type) {
      case "thinking": {
        const preview = evt.content.replace(/\n/g, " ").slice(0, 120);
        console.log(H.style.dim(`  [Step ${evt.step}] ${H.style.accent("Thinking...")} ${preview}${evt.content.length > 120 ? "..." : ""}`));
        startStatusBar(agentName, model, provider);
        break;
      }
      case "tool_call": {
        console.log(H.renderToolCall({ tool: evt.tool, args: evt.args, durationMs: evt.duration_ms }));
        startStatusBar(agentName, model, provider);
        break;
      }
      case "tool_result": {
        console.log(H.style.statusGood(`  ✓ ${evt.tool}`) + H.style.dim(`: ${String(evt.result).slice(0, 100)}`));
        // Inline diff preview for write/edit tools
        if ((evt.tool === "write" || evt.tool === "edit") && evt.prevContent && evt.newContent) {
          console.log(H.renderInlineDiff(evt.prevContent, evt.newContent));
        }
        startStatusBar(agentName, model, provider);
        break;
      }
      case "tool_error": {
        console.log(H.style.statusBad(`  ✗ ${evt.tool}`) + H.style.error(`: ${evt.error}`));
        startStatusBar(agentName, model, provider);
        break;
      }
    }
  };

  try {
    session = agentRuntime.createChatSession({
      agentName,
      projectDir,
      provider,
      model,
      onStep,
    });
    if (resumeSession && Array.isArray(resumeSession.messages)) {
      session.setMessages(resumeSession.messages);
      turnCounter = Math.floor((resumeSession.messages.length - 1) / 2); // approx
    }
    saveSession(sessionId, agentName, provider, model, sessionTitle, session.getMessages());
  } catch (err) {
    console.log(H.style.error(`  Error: ${err.message}`));
    return;
  }

  // Clean up sessions older than 30 days (silent)
  const cleaned = cleanupOldSessions(30);
  if (cleaned > 0) {
    console.log(H.style.dim(`  Cleaned up ${cleaned} old session(s).`));
  }

  // Interactive loop
  let pendingCommand = null;
  while (true) {
    let message;
    if (pendingCommand !== null) {
      message = pendingCommand;
      pendingCommand = null;
    } else {
      // Ctrl+R while idle → inject /retry
      getReader()._onRetry = () => {
        if (lastUserMessage && getReader()._resolver) {
          const resolve = getReader()._resolver;
          getReader()._resolver = null;
          resolve("/retry");
        }
      };
      message = await readInput(H.PROMPT_SYMBOLS.idle);
      getReader()._onRetry = null;
    }

    if (!message || message === "exit" || message === "quit") {
      // If user pressed Enter with an image pending, send image-only message
      if (!message && pendingImages.length > 0) {
        message = "";
        // Fall through — image will be prepended in msgToSend logic
      } else {
        console.log(H.style.dim("\n  Session ended.\n"));
        saveHistory(inputHistory);
        closeReader();
        break;
      }
    }

    // Auto-detect pasted image path (Ctrl+V from Windows Explorer → text path)
    const trimmedMsg = message.trim();
    if (message && !message.startsWith("/") && trimmedMsg.match(/\.(png|jpe?g|gif|webp|bmp|svg)\\?$/i)) {
      const potentialPath = trimmedMsg.replace(/^"|'$/g, "").replace(/\\$/, ""); // strip quotes & trailing backslash
      if (fs.existsSync(potentialPath)) {
        imageCounter++;
        pendingImages.push(potentialPath);
        console.log(H.style.dim(`\n  [📎 Image #${imageCounter}]\n`));
        message = ""; // Will be replaced with image reference
      }
    }

    const lower = message.toLowerCase();

    // "/" alone → interactive arrow-key picker
    if (lower === "/") {
      closeReader();
      process.stdin.resume();
      const selected = await pickCommand();
      getReader().loadHistory(inputHistory);
      if (selected) pendingCommand = selected;
      continue;
    }

    // "/help" → static reference display
    if (lower === "/help" || lower === "help") {
      showSlashMenu();
      continue;
    }

    // Partial slash command — auto-expand or show suggestions
    if (message.startsWith("/") && message.length > 1) {
      const exact = SLASH_COMMANDS.find(c => c.cmd === lower);
      if (!exact) {
        const partials = SLASH_COMMANDS.filter(c => c.cmd.startsWith(lower));
        if (partials.length === 1) {
          // Auto-expand: replace message with the full command and process it
          message = partials[0].cmd;
        } else if (partials.length > 1) {
          console.log(H.style.dim("\n  Did you mean:"));
          partials.forEach(p => console.log(H.style.dim(`    ${p.cmd}  — ${p.desc}`)));
          console.log("");
          continue;
        }
      }
    }
    // Recalculate lower after potential auto-expand
    const expandedLower = message.toLowerCase();

    // Toggle status bar
    if (expandedLower === "/statusbar") {
      statusBarVisible = !statusBarVisible;
      console.log(H.style.accent(`\n  Status bar: ${statusBarVisible ? "visible" : "hidden"}\n`));
      continue;
    }

    // Toggle compact mode
    if (expandedLower === "/compact") {
      const compact = !H.isCompactMode();
      H.setCompactMode(compact);
      console.log(H.style.accent(`\n  Compact mode: ${compact ? "on" : "off"}\n`));
      continue;
    }

    // Paste image from clipboard (Hermes-style: show visual, wait for message)
    if (expandedLower === "/image") {
      const imgPath = pasteImageFromClipboard();
      if (imgPath) {
        imageCounter++;
        pendingImages.push(imgPath);
        const stats = fs.statSync(imgPath);
        const fileName = path.basename(imgPath);
        const fileSize = formatFileSize(stats.size);
        console.log(H.style.statusGood(`\n  Image #${imageCounter} attached`));
        console.log(H.style.dim(`     ${fileName}  (${fileSize})`));
        console.log(H.style.dim("     Note: /image reads the clipboard image immediately (no Ctrl+V needed)."));
        console.log(H.style.dim(`     Type your message and press Enter to send\n`));
        continue;
      } else {
        console.log(H.style.statusWarn("\n  No image found in clipboard."));
        console.log(H.style.dim("  On Windows: use Win+Shift+S (Snipping Tool) or Ctrl+C from Paint/browser, then type /image."));
        console.log(H.style.dim("  Tip: paste into Paint to confirm the clipboard is the image you expect.\n"));
        continue;
      }
    }

    // Show pending image queue
    if (expandedLower === "/images") {
      if (pendingImages.length === 0) {
        console.log(H.style.dim("\n  No images pending.\n"));
      } else {
        console.log(H.style.accent(`\n  Pending images (${pendingImages.length}):`));
        pendingImages.forEach((p, i) => {
          const baseIdx = imageCounter - pendingImages.length + i + 1;
          const stats = fs.statSync(p);
          console.log(H.style.text(`    #${baseIdx} ${path.basename(p)}  (${formatFileSize(stats.size)})`));
        });
        console.log("");
      }
      continue;
    }

    // Remove last pending image
    if (expandedLower === "/removeimage") {
      if (pendingImages.length === 0) {
        console.log(H.style.statusWarn("\n  No images to remove.\n"));
      } else {
        const removed = pendingImages.pop();
        imageCounter--;
        console.log(H.style.statusGood(`\n  Removed: ${path.basename(removed)}\n`));
      }
      continue;
    }

    // Clear all pending images
    if (expandedLower === "/clearimages") {
      if (pendingImages.length === 0) {
        console.log(H.style.statusWarn("\n  No images to clear.\n"));
      } else {
        const count = pendingImages.length;
        pendingImages.length = 0;
        imageCounter = 0;
        console.log(H.style.statusGood(`\n  Cleared ${count} image(s) from queue.\n`));
      }
      continue;
    }

    // Attach file
    if (message.startsWith("/file")) {
      const filePath = message.slice("/file".length).trim();
      if (!filePath) {
        console.log(H.style.statusWarn("\n  Usage: /file <path>\n"));
        continue;
      }
      const resolvedPath = path.resolve(filePath);
      if (!fs.existsSync(resolvedPath)) {
        console.log(H.style.error(`\n  File not found: ${resolvedPath}\n`));
        continue;
      }
      const stat = fs.statSync(resolvedPath);
      if (stat.isDirectory()) {
        console.log(H.style.error(`\n  Path is a directory: ${resolvedPath}\n`));
        continue;
      }
      fileCounter++;
      pendingFiles.push(resolvedPath);
      console.log(H.style.statusGood(`\n  File #${fileCounter} attached`));
      console.log(H.style.dim(`     ${path.basename(resolvedPath)}  (${formatFileSize(stat.size)})`));
      console.log(H.style.dim(`     Type your message and press Enter to send\n`));
      continue;
    }

    // Show pending file queue
    if (expandedLower === "/files") {
      if (pendingFiles.length === 0) {
        console.log(H.style.dim("\n  No files pending.\n"));
      } else {
        console.log(H.style.accent(`\n  Pending files (${pendingFiles.length}):`));
        pendingFiles.forEach((p, i) => {
          const baseIdx = fileCounter - pendingFiles.length + i + 1;
          const stats = fs.statSync(p);
          console.log(H.style.text(`    #${baseIdx} ${path.basename(p)}  (${formatFileSize(stats.size)})`));
        });
        console.log("");
      }
      continue;
    }

    // Remove last pending file
    if (expandedLower === "/removefile") {
      if (pendingFiles.length === 0) {
        console.log(H.style.statusWarn("\n  No files to remove.\n"));
      } else {
        const removed = pendingFiles.pop();
        fileCounter--;
        console.log(H.style.statusGood(`\n  Removed: ${path.basename(removed)}\n`));
      }
      continue;
    }

    // Clear all pending files
    if (expandedLower === "/clearfiles") {
      if (pendingFiles.length === 0) {
        console.log(H.style.statusWarn("\n  No files to clear.\n"));
      } else {
        const count = pendingFiles.length;
        pendingFiles.length = 0;
        fileCounter = 0;
        console.log(H.style.statusGood(`\n  Cleared ${count} file(s) from queue.\n`));
      }
      continue;
    }

    // Switch indicator style
    if (expandedLower === "/indicator") {
      const styles = Object.keys(H.INDICATOR_STYLES);
      const current = H.getIndicatorStyle();
      const nextIndex = (styles.indexOf(current) + 1) % styles.length;
      const next = styles[nextIndex];
      H.setIndicatorStyle(next);
      console.log(H.style.accent(`\n  Indicator style: ${current} → ${next}\n`));
      continue;
    }

    // New session / clear history
    if (expandedLower === "/new" || expandedLower === "/clear" || expandedLower === "clear") {
      try {
        session = agentRuntime.createChatSession({ agentName, projectDir, provider, model });
        lastUserMessage = "";
        pendingImages.length = 0;
        pendingFiles.length = 0;
        imageCounter = 0;
        fileCounter = 0;
        sessionTitle = "";
        sessionId = generateSessionId();
        turnCounter = 0;
        saveSession(sessionId, agentName, provider, model, sessionTitle, session.getMessages());
        console.log(H.style.accent("\n  New session started. History cleared.\n"));
      } catch (err) {
        console.log(H.style.error(`  Error: ${err.message}\n`));
      }
      continue;
    }

    // Saved sessions list (also support `history`)
    if (expandedLower === "history" || expandedLower === "/history") {
      const sessions = listSessions();
      if (sessions.length === 0) {
        console.log(H.style.dim("\n  No saved sessions yet.\n"));
        continue;
      }
      console.log(H.style.accent(`\n  Saved sessions (${sessions.length}):`));
      sessions.slice(0, 30).forEach((s) => {
        const when = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : "";
        const title = s.title || "Untitled";
        console.log(H.style.text(`    ${s.id}  ${title}${when ? "  —  " + when : ""}`));
      });
      console.log(H.style.dim(`\n  Tip: /load <id> to resume. Current session id: ${sessionId}\n`));
      continue;
    }

    // Browse sessions (interactive picker)
    if (expandedLower === "/browse") {
      closeReader();
      process.stdin.resume();
      const picked = await pickSession();
      getReader().loadHistory(inputHistory);
      if (picked) {
        const loaded = loadSession(picked.id);
        if (loaded && Array.isArray(loaded.messages)) {
          session = agentRuntime.createChatSession({ agentName, projectDir, provider, model });
          session.setMessages(loaded.messages);
          sessionId = loaded.id || picked.id;
          sessionTitle = loaded.title || "";
          turnCounter = Math.floor((loaded.messages.length - 1) / 2);
          lastUserMessage = "";
          pendingImages.length = 0;
          pendingFiles.length = 0;
          imageCounter = 0;
          fileCounter = 0;
          saveSession(sessionId, agentName, provider, model, sessionTitle, session.getMessages());
          console.log(H.style.statusGood(`\n  Loaded session: ${sessionId}\n`));
        } else {
          console.log(H.style.error(`\n  Session not found: ${picked.id}\n`));
        }
      }
      continue;
    }

    // Load session
    if (expandedLower === "/load" || expandedLower.startsWith("/load ")) {
      const rawId = message.slice("/load".length).trim();
      if (!rawId) {
        console.log(H.style.statusWarn("\n  Usage: /load <session-id>\n"));
        continue;
      }
      const loaded = loadSession(rawId);
      if (!loaded || !Array.isArray(loaded.messages)) {
        console.log(H.style.error(`\n  Session not found: ${rawId}\n`));
        continue;
      }
      try {
        session = agentRuntime.createChatSession({ agentName, projectDir, provider, model });
        session.setMessages(loaded.messages);
        sessionId = loaded.id || rawId;
        sessionTitle = loaded.title || "";
        turnCounter = Math.floor((loaded.messages.length - 1) / 2);
        lastUserMessage = "";
        pendingImages.length = 0;
        pendingFiles.length = 0;
        imageCounter = 0;
        fileCounter = 0;
        console.log(H.style.statusGood(`\n  Loaded session: ${sessionId}\n`));
      } catch (err) {
        console.log(H.style.error(`\n  Load failed: ${err.message}\n`));
      }
      continue;
    }

    // Save conversation
    if (expandedLower === "/save") {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const fileName = `chat-${agentName}-${timestamp}.md`;
      const savePath = path.join(projectDir, fileName);
      const history = session.getHistory();
      let md = `# Chat: ${agentName}\n\n`;
      if (sessionTitle) md += `**Title:** ${sessionTitle}\n\n`;
      md += `**Date:** ${new Date().toISOString()}\n\n`;
      md += "---\n\n";
      for (const entry of history) {
        md += `## ${entry.role.toUpperCase()}\n\n${entry.content}\n\n`;
        if (entry.toolCalls?.length > 0) {
          for (const tc of entry.toolCalls) {
            md += `- Tool \`${tc.tool}\`: ${tc.error ? "ERROR: " + tc.error : "OK"}\n`;
          }
          md += "\n";
        }
      }
      try {
        fs.writeFileSync(savePath, md, "utf-8");
        saveSession(sessionId, agentName, provider, model, sessionTitle, session.getMessages());
        console.log(H.style.statusGood(`\n  Saved to: ${fileName}`));
        console.log(H.style.dim(`  Session id: ${sessionId}\n`));
      } catch (err) {
        console.log(H.style.error(`\n  Save failed: ${err.message}\n`));
      }
      continue;
    }

    // Rename current session
    if (message.startsWith("/rename")) {
      const title = message.slice("/rename".length).trim();
      if (!title) {
        console.log(H.style.statusWarn("\n  Usage: /rename <title>\n"));
        continue;
      }
      sessionTitle = title;
      saveSession(sessionId, agentName, provider, model, sessionTitle, session.getMessages());
      console.log(H.style.statusGood(`\n  Session renamed to: ${title}\n`));
      continue;
    }

    // Delete saved session
    if (message.startsWith("/delete")) {
      const rawId = message.slice("/delete".length).trim();
      if (!rawId) {
        console.log(H.style.statusWarn("\n  Usage: /delete <session-id>\n"));
        continue;
      }
      const deleted = deleteSavedSession(rawId);
      if (deleted) {
        console.log(H.style.statusGood(`\n  Deleted session: ${rawId}\n`));
      } else {
        console.log(H.style.error(`\n  Session not found: ${rawId}\n`));
      }
      continue;
    }

    // Retry last message
    if (expandedLower === "/retry") {
      if (!lastUserMessage) {
        console.log(H.style.statusWarn("\n  No previous message to retry.\n"));
        continue;
      }
      console.log(H.style.dim(`\n  Retrying: "${lastUserMessage.slice(0, 60)}..."\n`));
      // Fall through to send logic with lastUserMessage
    }

    // Undo last exchange
    if (expandedLower === "/undo") {
      const msgs = session.getMessages();
      let removed = 0;
      while (msgs.length > 1 && removed < 2) {
        const last = msgs[msgs.length - 1];
        if (last.role === "assistant" || last.role === "user") {
          msgs.pop();
          removed++;
        } else {
          break;
        }
      }
      const hist = session.getHistory();
      if (hist.length > 0) hist.pop();
      console.log(H.style.accent(`\n  Removed ${removed} message(s).\n`));
      continue;
    }

    // /config command
    if (message.startsWith("/config")) {
      const parts = message.trim().split(/\s+/);
      const subCmd = parts[1] || "show";

      if (subCmd === "show") {
        console.log(userConfig.display());
        continue;
      }

      if (subCmd === "set" && parts.length >= 5) {
        const provider = parts[2];
        const field = parts[3];
        const value = parts.slice(4).join(" ");
        const result = userConfig.interactiveSet(provider, field, value);
        if (result.error) {
          console.log(H.style.error(`  ${result.error}`));
        } else {
          console.log(H.style.statusGood(`  Set ${result.provider}.${result.field} = ${result.value}`));
        }
        continue;
      }

      if (subCmd === "default" && parts.length >= 3) {
        const provider = parts[2];
        const model = parts[3] || "";
        userConfig.setDefaults(provider, model);
        console.log(H.style.statusGood(`  Default provider = ${provider}${model ? ", model = " + model : ""}`));
        continue;
      }

      if (subCmd === "reset") {
        userConfig.save(JSON.parse(JSON.stringify(userConfig.DEFAULTS)));
        console.log(H.style.statusWarn("  Config reset to defaults."));
        continue;
      }

      console.log(H.style.error("  Usage: /config [show|set <provider> <field> <value>|default <provider> [model]|reset]"));
      continue;
    }

    // /model command — switch model for current provider only
    if (message.startsWith("/model")) {
      const parts = message.trim().split(/\s+/);
      const requestedModel = parts[1];

      const PROVIDER_MODELS = {
        openai: ["gpt-4", "gpt-4o", "gpt-3.5-turbo", "gpt-5.5"],
        claude: ["claude-3-5-sonnet-20241022", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"],
        local:  ["llama3", "mistral", "codellama"],
        mock:   ["mock"],
      };

      const currentProvider = provider || "mock";
      const availableModels = PROVIDER_MODELS[currentProvider] || ["mock"];

      if (!requestedModel) {
        console.log(H.style.accent(`\n  Current provider: ${currentProvider}`));
        console.log(H.style.accent(`  Current model:    ${model || "(default)"}`));
        console.log(H.style.accent("  Available models:"));
        availableModels.forEach((m) => {
          const marker = m === (model || availableModels[0]) ? H.style.clarifySel("* ") : "  ";
          console.log(`  ${marker}${H.style.text(m)}`);
        });
        console.log(H.style.dim(`\n  Use '/model <name>' to switch. To change provider, use '/config default <provider> <model>'.\n`));
        continue;
      }

      if (!availableModels.includes(requestedModel)) {
        console.log(H.style.error(`  Model "${requestedModel}" is not available for provider "${currentProvider}".`));
        console.log(H.style.accent("  Available models:"));
        availableModels.forEach(m => console.log(`    ${H.style.text(m)}`));
        console.log(H.style.dim(`\n  To use a model from another provider, switch provider first: '/config default <provider> <model>'\n`));
        continue;
      }

      session.setModel(requestedModel);
      model = requestedModel;
      console.log(H.style.statusGood(`\n  Switched to model: ${requestedModel} (provider: ${currentProvider})\n`));
      continue;
    }

    // /provider command — switch LLM provider
    if (message.startsWith("/provider")) {
      const parts = message.trim().split(/\s+/);
      const requestedProvider = parts[1];
      const VALID_PROVIDERS = ["openai", "claude", "ollama", "mock"];

      if (!requestedProvider) {
        console.log(H.style.accent(`\n  Current provider: ${provider || "(default)"}`));
        console.log(H.style.accent("  Available providers:"));
        VALID_PROVIDERS.forEach((p) => {
          const marker = p === (provider || "mock") ? H.style.clarifySel("* ") : "  ";
          console.log(`  ${marker}${H.style.text(p)}`);
        });
        console.log(H.style.dim(`\n  Use '/provider <name>' to switch.\n`));
        continue;
      }

      if (!VALID_PROVIDERS.includes(requestedProvider)) {
        console.log(H.style.error(`  Unknown provider: ${requestedProvider}`));
        console.log(H.style.accent("  Available providers:"));
        VALID_PROVIDERS.forEach(p => console.log(`    ${H.style.text(p)}`));
        console.log("");
        continue;
      }

      provider = requestedProvider;
      session.setProvider(requestedProvider);
      console.log(H.style.statusGood(`\n  Switched to provider: ${requestedProvider}\n`));
      continue;
    }

    // Unknown slash command — suggest help
    if (message.startsWith("/")) {
      console.log(H.style.error(`  Unknown command: ${message}`));
      console.log(H.style.dim(`  Type '/' or '/help' for available commands.\n`));
      continue;
    }

    // ── Paste collapse: text > 5 lines ──
    const msgLines = message.split("\n");
    let msgToSend = expandedLower === "/retry" ? lastUserMessage : message;
    // Prepend image reference if an image was pasted with /image
    // Prepend image references if images were pasted
    const sentImagePaths = [];
    if (pendingImages.length > 0 && !msgToSend.startsWith("/")) {
      const imgRefs = pendingImages.map(p => `[image:${p}]`).join("\n");
      msgToSend = imgRefs + (msgToSend ? "\n" + msgToSend : "");
      sentImagePaths.push(...pendingImages);
      pendingImages.length = 0;
    }
    // Prepend file attachments
    if (pendingFiles.length > 0 && !msgToSend.startsWith("/")) {
      const fileBlocks = pendingFiles.map(formatFileAttachment).join("\n");
      msgToSend = fileBlocks + (msgToSend ? "\n" + msgToSend : "");
      pendingFiles.length = 0;
      fileCounter = 0;
    }
    if (msgLines.length > 5 && !msgToSend.startsWith("/")) {
      pasteCount++;
      const filePath = H.savePasteToFile(msgToSend, pasteCount);
      const collapsed = H.collapsePaste(msgToSend, pasteCount);
      console.log(H.style.dim(`  ${collapsed}`));
      console.log(H.style.dim(`  Saved to: ${filePath}`));
      msgToSend = collapsed;
    }
    lastUserMessage = message;
    // Auto-generate session title from first user message
    if (!sessionTitle && msgToSend && !msgToSend.startsWith("/")) {
      sessionTitle = msgToSend.replace(/\n/g, " ").slice(0, 60);
      if (msgToSend.length > 60) sessionTitle += "...";
    }
    // Add to input history (deduplicate, max 100)
    if (msgToSend && !msgToSend.startsWith("/") && inputHistory[inputHistory.length - 1] !== msgToSend) {
      inputHistory.push(msgToSend);
      if (inputHistory.length > MAX_HISTORY) inputHistory.shift();
    }

    // Show working indicator + status bar
    process.stdout.write(H.style.dim(`  ${H.PROMPT_SYMBOLS.agentRunning} Working...\n`));
    startStatusBar(agentName, model, provider);

    // On Windows TTY, readline intercepts Ctrl+C before process listeners.
    // Route cancel through the InputReader's SIGINT handler instead.
    getReader().setBusy(() => {
      session.cancel(); // Signal chat-session to abort LLM call
      stopStatusBar();
      console.log(H.style.statusWarn("\n  Cancelling... (Ctrl+C again to force exit)"));
    });

    let streamedOutput = false;
    let streamLineVisibleLen = 0;
    const termWidth = process.stdout.columns || 80;
    const innerWidth = termWidth - 4;
    const wrapWidth = Math.max(20, innerWidth - 4);
    const streamTitle = H.PROMPT_SYMBOLS.agentRunning + " Aiyu";

    const writeStreamBoxTop = () => {
      const titleVisible = " " + streamTitle + " ";
      const titleVisibleLen = H.visibleLen(titleVisible);
      const topContentLen = Math.max(0, innerWidth - titleVisibleLen);
      const topLine = H.BOX.topLeft + H.BOX.horizontal + H.style.accent(titleVisible) +
        H.BOX.horizontal.repeat(topContentLen) + H.BOX.topRight;
      process.stdout.write("\n" + H.style.border(topLine) + "\n");
      process.stdout.write("    ");
      streamLineVisibleLen = 0;
    };

    const writeStreamBoxBottom = () => {
      const bottomLine = H.BOX.bottomLeft + H.BOX.horizontal.repeat(innerWidth) + H.BOX.bottomRight;
      process.stdout.write("\n" + H.style.border(bottomLine) + "\n");
    };

    const onToken = (token) => {
      if (!streamedOutput) {
        streamedOutput = true;
        stopStatusBar();
        writeStreamBoxTop();
      }

      for (let i = 0; i < token.length; i++) {
        const ch = token[i];
        if (ch === "\n") {
          process.stdout.write("\n    ");
          streamLineVisibleLen = 0;
          continue;
        }
        if (streamLineVisibleLen >= wrapWidth) {
          process.stdout.write("\n    ");
          streamLineVisibleLen = 0;
        }
        process.stdout.write(ch);
        streamLineVisibleLen++;
      }
    };

    try {
      const entry = await session.send(msgToSend, { onToken });
      stopStatusBar();

      // Show final response in Rich-style panel
      if (entry.steps?.length > 0) {
        const totalMs = entry.steps.reduce((s, st) => s + (st.duration_ms || 0), 0);
        const totalTokens = entry.usage?.totalTokens || 0;
        console.log(H.style.dim(`  [Done] ${entry.steps.length} step(s), ${(totalMs / 1000).toFixed(1)}s, ${H.formatTokens(totalTokens)} tokens`));
      }

      if (streamedOutput) {
        writeStreamBoxBottom();
        console.log("");
      } else {
        console.log("");
        console.log(H.renderResponseBox(H.PROMPT_SYMBOLS.agentRunning + " Aiyu", entry.content));
        console.log("");
      }

      // Clean up temp image files after successful send
      for (const imgPath of sentImagePaths) {
        try { fs.unlinkSync(imgPath); } catch {}
      }

      // Auto-save session after each successful turn (SQLite with steps)
      sessionStore.saveTurn(sessionId, turnCounter, msgToSend, entry);
      turnCounter++;
    } catch (err) {
      // On error/cancel, temp images are kept so user can retry with /retry
      stopStatusBar();
      if (err.cancelled) {
        console.log(H.style.statusWarn("  Cancelled by user.\n"));
        getReader().prefill(msgToSend);
        continue;
      }
      // Surface API key / auth errors with actionable hints
      const msg = err.message || String(err);
      const isAuthErr = /api.?key|unauthorized|authentication|403|401/i.test(msg);
      if (isAuthErr) {
        console.log(H.style.error(`\n  Auth error: ${msg}`));
        console.log(H.style.dim("  Tip: run /config set <provider> apiKey <your-key> to configure.\n"));
      } else {
        console.log(H.style.error(`\n  Error: ${msg}\n`));
      }
    } finally {
      getReader().setIdle();
    }
  }
}

module.exports = { run };
