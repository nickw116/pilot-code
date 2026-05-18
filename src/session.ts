import Database from "better-sqlite3";
import path from "path";

const DB_PATH = process.env.USER_DB_PATH || path.join(process.cwd(), "data", "db", "users.db");

let db: Database.Database;

function getDb(): Database.Database {
  if (db) return db;
  db = new Database(DB_PATH, { readonly: false });
  db.pragma("journal_mode = WAL");
  ensureTables(db);
  return db;
}

function ensureTables(d: Database.Database) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      model TEXT,
      run_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_key, id);

    CREATE TABLE IF NOT EXISTS session_status (
      session_key TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      run_id TEXT,
      error TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS acp_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL,
      run_id TEXT NOT NULL,
      log_type TEXT NOT NULL,
      tool TEXT,
      text TEXT,
      detail TEXT,
      duration_ms INTEGER,
      seq INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_acp_logs_run ON acp_logs(session_key, run_id, seq);
  `);
}

export interface Session {
  id: number;
  user_id: number;
  agent_id: string;
  session_key: string;
  title: string;
  created_at: number;
  updated_at: number;
  active: number;
}

function makeSessionKey(userId: number, username: string, agentId: string): string {
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15).replace(/(\d{8})(\d{6})/, "$1-$2");
  return `agent:${agentId}:h5-${username}-${ts}`;
}

export function createSession(userId: number, username: string, agentId = "main"): Session {
  const d = getDb();
  const sessionKey = makeSessionKey(userId, username, agentId);
  const now = Date.now() / 1000;

  d.prepare("UPDATE sessions SET active = 0 WHERE user_id = ? AND agent_id = ? AND active = 1")
    .run(userId, agentId);

  const result = d
    .prepare("INSERT INTO sessions (user_id, agent_id, session_key, title, created_at, updated_at, active) VALUES (?, ?, ?, '', ?, ?, 1)")
    .run(userId, agentId, sessionKey, now, now);

  return {
    id: Number(result.lastInsertRowid),
    user_id: userId,
    agent_id: agentId,
    session_key: sessionKey,
    title: "",
    created_at: now,
    updated_at: now,
    active: 1,
  };
}

export function getOrCreateActiveSession(userId: number, username: string, agentId = "main"): Session {
  const d = getDb();
  const row = d
    .prepare("SELECT * FROM sessions WHERE user_id = ? AND agent_id = ? AND active = 1 ORDER BY updated_at DESC LIMIT 1")
    .get(userId, agentId) as Session | undefined;
  if (row) return row;
  return createSession(userId, username, agentId);
}

export function listSessions(userId: number, agentId?: string): Session[] {
  if (agentId) {
    return getDb()
      .prepare("SELECT * FROM sessions WHERE user_id = ? AND agent_id = ? ORDER BY updated_at DESC")
      .all(userId, agentId) as Session[];
  }
  return getDb()
    .prepare("SELECT * FROM sessions WHERE user_id = ? ORDER BY updated_at DESC")
    .all(userId) as Session[];
}

export interface AllSessionRow extends Session {
  username: string;
  display_name: string;
}

export function listAllSessions(agentId?: string): AllSessionRow[] {
  const d = getDb();
  if (agentId) {
    return d.prepare(
      `SELECT s.*, u.username, u.display_name FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.agent_id = ? ORDER BY s.updated_at DESC`
    ).all(agentId) as AllSessionRow[];
  }
  return d.prepare(
    `SELECT s.*, u.username, u.display_name FROM sessions s JOIN users u ON s.user_id = u.id ORDER BY s.updated_at DESC`
  ).all() as AllSessionRow[];
}

export function switchSession(userId: number, sessionKey: string): Session | null {
  const d = getDb();
  const session = d
    .prepare("SELECT * FROM sessions WHERE user_id = ? AND session_key = ?")
    .get(userId, sessionKey) as Session | undefined;
  if (!session) return null;

  d.prepare("UPDATE sessions SET active = 0 WHERE user_id = ?").run(userId);
  d.prepare("UPDATE sessions SET active = 1 WHERE id = ?")
    .run(session.id);
  return { ...session, active: 1 };
}

export function deleteSession(userId: number, sessionKey: string): boolean {
  const d = getDb();
  const result = d
    .prepare("DELETE FROM sessions WHERE user_id = ? AND session_key = ?")
    .run(userId, sessionKey);
  d.prepare("DELETE FROM messages WHERE session_key = ?").run(sessionKey);
  d.prepare("DELETE FROM session_status WHERE session_key = ?").run(sessionKey);
  d.prepare("DELETE FROM acp_logs WHERE session_key = ?").run(sessionKey);
  return result.changes > 0;
}

// --- Session status (state machine) ---

export type SessionStatus = "idle" | "generating" | "completed" | "interrupted" | "error";

export interface SessionStatusInfo {
  status: SessionStatus;
  runId: string | null;
  error: string | null;
  updatedAt: number;
}

export function setSessionStatus(sessionKey: string, status: SessionStatus, extra?: { runId?: string; error?: string }): void {
  const d = getDb();
  const now = Date.now();
  const runId = extra?.runId || null;
  const error = extra?.error || null;
  d.prepare(`
    INSERT INTO session_status (session_key, status, run_id, error, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_key) DO UPDATE SET status = excluded.status, run_id = excluded.run_id, error = excluded.error, updated_at = excluded.updated_at
  `).run(sessionKey, status, runId, error, now);
}

export function getSessionStatus(sessionKey: string): SessionStatusInfo | null {
  const d = getDb();
  const row = d.prepare("SELECT status, run_id as runId, error, updated_at as updatedAt FROM session_status WHERE session_key = ?")
    .get(sessionKey) as SessionStatusInfo | undefined;
  return row || null;
}

export function cleanInterruptedSessions(): number {
  const d = getDb();
  const result = d.prepare(
    "UPDATE session_status SET status = 'interrupted', error = '服务重启，生成被中断' WHERE status = 'generating'"
  ).run();
  return result.changes;
}

// --- Message persistence (SQLite, replaces JSONL) ---

export interface ContextMessage {
  role: "user" | "assistant";
  content: string;
  model?: string;
  runId?: string;
  dbId?: number;
  timestamp?: number;
}

export function loadContext(sessionKey: string, limit = 200): ContextMessage[] {
  const d = getDb();
  const count = d.prepare("SELECT COUNT(*) as cnt FROM messages WHERE session_key = ?").get(sessionKey) as { cnt: number };
  const offset = Math.max(0, count.cnt - limit);
  return d.prepare(
    "SELECT id as dbId, role, content, model, run_id as runId, created_at as timestamp FROM messages WHERE session_key = ? ORDER BY id ASC LIMIT ? OFFSET ?"
  ).all(sessionKey, limit, offset) as ContextMessage[];
}

export function appendContext(sessionKey: string, messages: ContextMessage[], runId?: string): void {
  const d = getDb();
  const insert = d.prepare(
    "INSERT INTO messages (session_key, role, content, model, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  );
  d.transaction(() => {
    for (const msg of messages) {
      const ts = msg.timestamp || Date.now();
      insert.run(sessionKey, msg.role, msg.content, msg.model || null, runId || null, ts);
    }
  })();

  try {
    d.prepare("UPDATE sessions SET updated_at = ? WHERE session_key = ?")
      .run(Date.now() / 1000, sessionKey);
  } catch {}
}

export function updateSessionTitle(sessionKey: string, title: string): void {
  try {
    getDb().prepare("UPDATE sessions SET title = ? WHERE session_key = ? AND title = ''")
      .run(title, sessionKey);
  } catch {}
}

// --- ACP log persistence ---

export interface AcpLogRow {
  logType: string;
  tool: string | null;
  text: string | null;
  detail: string | null;
  durationMs: number | null;
  seq: number;
  createdAt: number;
}

export function appendAcpLog(sessionKey: string, runId: string, log: { type: string; tool?: string | null; text?: string; detail?: string | null; durationMs?: number | null }, seq: number): void {
  const d = getDb();
  d.prepare(
    "INSERT INTO acp_logs (session_key, run_id, log_type, tool, text, detail, duration_ms, seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(sessionKey, runId, log.type, log.tool ?? null, log.text ?? null, log.detail ?? null, log.durationMs ?? null, seq, Date.now());
}

export function loadAcpLogs(sessionKey: string, runId: string): AcpLogRow[] {
  const d = getDb();
  return d.prepare(
    "SELECT log_type as logType, tool, text, detail, duration_ms as durationMs, seq, created_at as createdAt FROM acp_logs WHERE session_key = ? AND run_id = ? ORDER BY seq ASC"
  ).all(sessionKey, runId) as AcpLogRow[];
}

export function deleteAcpLogs(sessionKey: string): void {
  try {
    getDb().prepare("DELETE FROM acp_logs WHERE session_key = ?").run(sessionKey);
  } catch {}
}
