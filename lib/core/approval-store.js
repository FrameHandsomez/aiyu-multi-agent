/**
 * Approval Store — JSON allowlist for command approvals
 *
 * Persistence layer for "always" approvals.
 * Uses file-based locking (lockfile) for concurrent write safety.
 *
 * Schema: ~/.aiyu/allowlist.json
 * {
 *   "version": 1,
 *   "approvals": [
 *     { "command": "npm install", "scope": "always", "approved_at": "...", "project_root": "...", "hash": "sha256:..." }
 *   ]
 * }
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const ALLOWLIST_PATH = path.join(os.homedir(), ".aiyu", "allowlist.json");
const LOCKFILE_PATH = path.join(os.homedir(), ".aiyu", "allowlist.json.lock");
const LOCK_TIMEOUT_MS = 5000;

// ── Session-scoped approvals (in-memory, cleared on process exit) ──
const sessionApprovals = new Map();

// ── Hash helper ────────────────────────────────────────────────────
function _hashCommand(command) {
  return "sha256:" + crypto.createHash("sha256").update(command).digest("hex").slice(0, 16);
}

// ── File locking (simple cross-platform) ──────────────────────────
function _acquireLock() {
  const start = Date.now();
  while (Date.now() - start < LOCK_TIMEOUT_MS) {
    try {
      fs.writeFileSync(LOCKFILE_PATH, String(process.pid), { flag: "wx" });
      return true;
    } catch {
      // Lock exists — check if stale (older than 10s)
      try {
        const stat = fs.statSync(LOCKFILE_PATH);
        if (Date.now() - stat.mtimeMs > 10000) {
          try { fs.unlinkSync(LOCKFILE_PATH); } catch { /* race */ }
        }
      } catch { /* lock file disappeared */ }
      // Brief pause before retry
      const wait = Date.now();
      while (Date.now() - wait < 50) { /* spin */ }
    }
  }
  return false;
}

function _releaseLock() {
  try { fs.unlinkSync(LOCKFILE_PATH); } catch { /* already gone */ }
}

// ── Load / Save ────────────────────────────────────────────────────
function _loadAllowlist() {
  try {
    const data = fs.readFileSync(ALLOWLIST_PATH, "utf-8");
    const parsed = JSON.parse(data);
    if (parsed.version !== 1) return { version: 1, approvals: [] };
    return parsed;
  } catch {
    return { version: 1, approvals: [] };
  }
}

function _saveAllowlist(data) {
  const dir = path.dirname(ALLOWLIST_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ALLOWLIST_PATH, JSON.stringify(data, null, 2), "utf-8");
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Check if a command is approved at the given scope.
 *
 * @param {string} command  Full command string
 * @param {string} [projectRoot]  Optional project root for project-scoped check
 * @returns {{ approved: boolean, scope: string|null }}
 */
function isApproved(command, projectRoot) {
  const hash = _hashCommand(command);

  // 1. Check session approvals (in-memory)
  const sessionKey = projectRoot ? `${hash}:${projectRoot}` : hash;
  if (sessionApprovals.has(sessionKey)) {
    return { approved: true, scope: "session" };
  }

  // 2. Check persistent allowlist
  const allowlist = _loadAllowlist();
  for (const entry of allowlist.approvals) {
    if (entry.hash === hash && entry.scope === "always") {
      // If project-scoped, check project_root matches
      if (entry.project_root && projectRoot && entry.project_root !== projectRoot) continue;
      return { approved: true, scope: "always" };
    }
  }

  return { approved: false, scope: null };
}

/**
 * Record an approval.
 *
 * @param {string} command  Full command string
 * @param {"once"|"session"|"always"} scope
 * @param {string} [projectRoot]  Optional project root for scoping
 */
function recordApproval(command, scope, projectRoot) {
  const hash = _hashCommand(command);

  if (scope === "once") {
    // No persistence needed — one-time approval
    return;
  }

  if (scope === "session") {
    const sessionKey = projectRoot ? `${hash}:${projectRoot}` : hash;
    sessionApprovals.set(sessionKey, { command, approved_at: new Date().toISOString() });
    return;
  }

  if (scope === "always") {
    if (!_acquireLock()) {
      throw new Error("Could not acquire lock on allowlist.json — concurrent write in progress");
    }
    try {
      const allowlist = _loadAllowlist();
      // Don't duplicate
      const exists = allowlist.approvals.some(e => e.hash === hash && e.scope === "always" &&
        (!e.project_root || !projectRoot || e.project_root === projectRoot));
      if (!exists) {
        allowlist.approvals.push({
          command,
          scope: "always",
          approved_at: new Date().toISOString(),
          project_root: projectRoot || null,
          hash,
        });
        _saveAllowlist(allowlist);
      }
    } finally {
      _releaseLock();
    }
  }
}

/**
 * List all approvals (session + persistent).
 *
 * @returns {{ session: Array, persistent: Array }}
 */
function listApprovals() {
  const allowlist = _loadAllowlist();
  return {
    session: [...sessionApprovals.values()],
    persistent: allowlist.approvals,
  };
}

/**
 * Revoke an approval by command hash.
 *
 * @param {string} hashOrCommand  Hash or full command to revoke
 * @returns {boolean}  Whether anything was revoked
 */
function revokeApproval(hashOrCommand) {
  const hash = hashOrCommand.startsWith("sha256:") ? hashOrCommand : _hashCommand(hashOrCommand);

  // Remove from session
  for (const [key, val] of sessionApprovals) {
    if (key.startsWith(hash)) {
      sessionApprovals.delete(key);
    }
  }

  // Remove from persistent
  if (!_acquireLock()) return false;
  try {
    const allowlist = _loadAllowlist();
    const before = allowlist.approvals.length;
    allowlist.approvals = allowlist.approvals.filter(e => e.hash !== hash);
    if (allowlist.approvals.length < before) {
      _saveAllowlist(allowlist);
      return true;
    }
    return false;
  } finally {
    _releaseLock();
  }
}

/**
 * Clear all session approvals (called on process exit).
 */
function clearSession() {
  sessionApprovals.clear();
}

// ── Cleanup on exit ────────────────────────────────────────────────
process.on("exit", clearSession);

module.exports = {
  isApproved,
  recordApproval,
  listApprovals,
  revokeApproval,
  clearSession,
  ALLOWLIST_PATH,
  _hashCommand,
};
