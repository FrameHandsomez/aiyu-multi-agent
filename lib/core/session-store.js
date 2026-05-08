/**
 * Session Store — SQLite persistence for chat sessions
 *
 * Replaces file-based session storage with structured SQLite.
 * Falls back to file-based if better-sqlite3 is unavailable.
 *
 * Schema:
 *   sessions     (id, agentName, provider, model, title, createdAt, updatedAt)
 *   messages     (sessionId, idx, role, content)
 *   steps        (sessionId, turnIdx, step, thought, toolCalls, durationMs, createdAt)
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const DATA_DIR = path.join(os.homedir(), ".aiyu");
const DB_PATH = path.join(DATA_DIR, "sessions.db");

let db = null;
let _sqliteAvailable = false;

function _initDb() {
  if (db) return db;

  // Try better-sqlite3
  try {
    const Database = require("better-sqlite3");
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    _sqliteAvailable = true;
  } catch {
    // Fallback: file-based (legacy mode)
    _sqliteAvailable = false;
    return null;
  }

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      agentName TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      title TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      sessionId TEXT NOT NULL,
      idx INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      PRIMARY KEY (sessionId, idx),
      FOREIGN KEY (sessionId) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sessionId TEXT NOT NULL,
      turnIdx INTEGER NOT NULL,
      step INTEGER NOT NULL,
      thought TEXT,
      toolCalls TEXT,
      durationMs INTEGER,
      createdAt INTEGER NOT NULL,
      FOREIGN KEY (sessionId) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updatedAt);
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(sessionId);
    CREATE INDEX IF NOT EXISTS idx_steps_session ON steps(sessionId);
  `);

  return db;
}

// ── Legacy file-based fallback ──────────────────────────────────────

const HISTORY_DIR = path.join(os.homedir(), ".aiyu", "history");

function _ensureHistoryDir() {
  if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });
}

function _legacySave(sessionId, agentName, provider, model, title, messages) {
  try {
    _ensureHistoryDir();
    const filePath = path.join(HISTORY_DIR, `${sessionId}.json`);
    let createdAt = new Date().toISOString();
    if (fs.existsSync(filePath)) {
      try {
        const prev = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        if (prev?.createdAt) createdAt = prev.createdAt;
      } catch {}
    }
    const data = {
      id: sessionId,
      createdAt,
      updatedAt: new Date().toISOString(),
      agentName,
      provider,
      model,
      title,
      messages,
    };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  } catch {}
}

function _legacyList() {
  try {
    if (!fs.existsSync(HISTORY_DIR)) return [];
    return fs.readdirSync(HISTORY_DIR)
      .filter(f => f.endsWith(".json"))
      .map(f => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, f), "utf-8"));
          return { id: data.id, title: data.title || "Untitled", updatedAt: data.updatedAt, agentName: data.agentName };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  } catch { return []; }
}

function _legacyLoad(sessionId) {
  try {
    const filePath = path.join(HISTORY_DIR, `${sessionId}.json`);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch { return null; }
}

function _legacyDelete(sessionId) {
  try {
    const filePath = path.join(HISTORY_DIR, `${sessionId}.json`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return true;
  } catch { return false; }
}

function _legacyCleanup(days = 30) {
  try {
    if (!fs.existsSync(HISTORY_DIR)) return 0;
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    const files = fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith(".json"));
    let deleted = 0;
    for (const f of files) {
      const stat = fs.statSync(path.join(HISTORY_DIR, f));
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(path.join(HISTORY_DIR, f));
        deleted++;
      }
    }
    return deleted;
  } catch { return 0; }
}

// ── Public API ────────────────────────────────────────────────────────

function isAvailable() {
  return !!_initDb();
}

function createSession({ id, agentName, provider, model, title = "" }) {
  const now = Date.now();
  const d = _initDb();
  if (d) {
    const stmt = d.prepare(`
      INSERT OR REPLACE INTO sessions (id, agentName, provider, model, title, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, agentName, provider || null, model || null, title, now, now);
    return;
  }
  // Legacy fallback
  _legacySave(id, agentName, provider, model, title, []);
}

function saveMessage(sessionId, idx, role, content) {
  const d = _initDb();
  if (d) {
    const stmt = d.prepare(`
      INSERT OR REPLACE INTO messages (sessionId, idx, role, content) VALUES (?, ?, ?, ?)
    `);
    stmt.run(sessionId, idx, role, content);
    // Update session timestamp
    d.prepare(`UPDATE sessions SET updatedAt = ? WHERE id = ?`).run(Date.now(), sessionId);
    return;
  }
  // Legacy: re-save entire session — caller handles full save
}

function saveTurn(sessionId, turnIdx, userMessage, assistantEntry) {
  const d = _initDb();
  if (!d) return; // Legacy handled by caller

  const now = Date.now();

  // Save user message
  d.prepare(`
    INSERT OR REPLACE INTO messages (sessionId, idx, role, content) VALUES (?, ?, ?, ?)
  `).run(sessionId, turnIdx * 2, "user", userMessage);

  // Save assistant message
  d.prepare(`
    INSERT OR REPLACE INTO messages (sessionId, idx, role, content) VALUES (?, ?, ?, ?)
  `).run(sessionId, turnIdx * 2 + 1, "assistant", assistantEntry.content || "");

  // Save steps
  if (assistantEntry.steps && assistantEntry.steps.length > 0) {
    const stepStmt = d.prepare(`
      INSERT INTO steps (sessionId, turnIdx, step, thought, toolCalls, durationMs, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const s of assistantEntry.steps) {
      stepStmt.run(
        sessionId,
        turnIdx,
        s.step || 0,
        s.thought || "",
        JSON.stringify(s.toolCalls || []),
        s.duration_ms || 0,
        now
      );
    }
  }

  // Update timestamp
  d.prepare(`UPDATE sessions SET updatedAt = ? WHERE id = ?`).run(now, sessionId);
}

function listSessions() {
  const d = _initDb();
  if (d) {
    const rows = d.prepare(`
      SELECT id, agentName, title, updatedAt FROM sessions ORDER BY updatedAt DESC
    `).all();
    return rows.map(r => ({
      id: r.id,
      title: r.title || "Untitled",
      updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : "",
      agentName: r.agentName,
    }));
  }
  return _legacyList();
}

function loadSession(sessionId) {
  const d = _initDb();
  if (d) {
    const session = d.prepare(`SELECT * FROM sessions WHERE id = ?`).get(sessionId);
    if (!session) {
      // Try legacy fallback
      const legacy = _legacyLoad(sessionId);
      if (legacy) return legacy;
      return null;
    }

    const messages = d.prepare(`
      SELECT role, content FROM messages WHERE sessionId = ? ORDER BY idx ASC
    `).all(sessionId);

    return {
      id: session.id,
      createdAt: session.createdAt ? new Date(session.createdAt).toISOString() : new Date().toISOString(),
      updatedAt: session.updatedAt ? new Date(session.updatedAt).toISOString() : new Date().toISOString(),
      agentName: session.agentName,
      provider: session.provider || undefined,
      model: session.model || undefined,
      title: session.title || "",
      messages: messages.map(m => ({ role: m.role, content: m.content })),
    };
  }

  return _legacyLoad(sessionId);
}

function deleteSession(sessionId) {
  const d = _initDb();
  if (d) {
    d.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
    return true;
  }
  return _legacyDelete(sessionId);
}

function cleanupOldSessions(days = 30) {
  const d = _initDb();
  if (d) {
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    const result = d.prepare(`DELETE FROM sessions WHERE updatedAt < ?`).run(cutoff);
    return result.changes || 0;
  }
  return _legacyCleanup(days);
}

function getSessionCount() {
  const d = _initDb();
  if (d) {
    const row = d.prepare(`SELECT COUNT(*) as count FROM sessions`).get();
    return row.count || 0;
  }
  try {
    if (!fs.existsSync(HISTORY_DIR)) return 0;
    return fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith(".json")).length;
  } catch { return 0; }
}

// ── Interactive Picker Data ──────────────────────────────────────────

function searchSessions(query) {
  const d = _initDb();
  if (d) {
    const rows = d.prepare(`
      SELECT id, agentName, title, updatedAt FROM sessions
      WHERE title LIKE ? OR id LIKE ?
      ORDER BY updatedAt DESC LIMIT 50
    `).all(`%${query}%`, `%${query}%`);
    return rows.map(r => ({
      id: r.id,
      title: r.title || "Untitled",
      updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : "",
      agentName: r.agentName,
    }));
  }
  // Fallback: filter legacy list
  const all = _legacyList();
  const q = query.toLowerCase();
  return all.filter(s =>
    (s.title && s.title.toLowerCase().includes(q)) ||
    s.id.toLowerCase().includes(q)
  );
}

module.exports = {
  isAvailable,
  createSession,
  saveMessage,
  saveTurn,
  listSessions,
  loadSession,
  deleteSession,
  cleanupOldSessions,
  getSessionCount,
  searchSessions,
};
