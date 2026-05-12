import Database from "better-sqlite3";
import crypto from "crypto";
import fs from "fs";
import path from "path";

const DB_PATH = process.env.USER_DB_PATH || path.join(import.meta.dirname, "..", "h5-chat", "bridge", "users.db");
const SESSIONS_DIR = process.env.SESSIONS_DIR || path.join(import.meta.dirname, "..", "data", "sessions");

let db: Database.Database;

function getDb(): Database.Database {
  if (db) return db;
  db = new Database(DB_PATH, { readonly: false });
  db.pragma("journal_mode = WAL");
  return db;
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

/** Generate a session key: agent:<agentId>:h5-<username>-<timestamp> */
function makeSessionKey(userId: number, username: string, agentId: string): string {
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15).replace(/(\d{8})(\d{6})/, "$1-$2");
  return `agent:${agentId}:h5-${username}-${ts}`;
}

/** Create a new session for a user */
export function createSession(userId: number, username: string, agentId = "main"): Session {
  const d = getDb();
  const sessionKey = makeSessionKey(userId, username, agentId);
  const now = Date.now() / 1000;

  // Deactivate previous active sessions for this user+agent
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

/** Get the active session for a user+agent, or create one */
export function getOrCreateActiveSession(userId: number, username: string, agentId = "main"): Session {
  const d = getDb();
  const row = d
    .prepare("SELECT * FROM sessions WHERE user_id = ? AND agent_id = ? AND active = 1 ORDER BY updated_at DESC LIMIT 1")
    .get(userId, agentId) as Session | undefined;
  if (row) return row;
  return createSession(userId, username, agentId);
}

/** List all sessions for a user */
export function listSessions(userId: number): Session[] {
  return getDb()
    .prepare("SELECT * FROM sessions WHERE user_id = ? ORDER BY updated_at DESC")
    .all(userId) as Session[];
}

/** Switch active session */
export function switchSession(userId: number, sessionKey: string): Session | null {
  const d = getDb();
  const session = d
    .prepare("SELECT * FROM sessions WHERE user_id = ? AND session_key = ?")
    .get(userId, sessionKey) as Session | undefined;
  if (!session) return null;

  // Deactivate all, activate this one
  d.prepare("UPDATE sessions SET active = 0 WHERE user_id = ?").run(userId);
  d.prepare("UPDATE sessions SET active = 1, updated_at = ? WHERE id = ?")
    .run(Date.now() / 1000, session.id);
  return { ...session, active: 1 };
}

/** Delete a session */
export function deleteSession(userId: number, sessionKey: string): boolean {
  const d = getDb();
  const result = d
    .prepare("DELETE FROM sessions WHERE user_id = ? AND session_key = ?")
    .run(userId, sessionKey);
  // Also delete the JSONL file
  const jsonlPath = path.join(SESSIONS_DIR, `${sessionKey}.jsonl`);
  try { fs.unlinkSync(jsonlPath); } catch {}
  return result.changes > 0;
}

// --- JSONL context persistence ---

export interface ContextMessage {
  role: "user" | "assistant";
  content: string;
  model?: string;
  timestamp?: number;
}

/** Load context from JSONL file */
export function loadContext(sessionKey: string): ContextMessage[] {
  const filePath = path.join(SESSIONS_DIR, `${sessionKey}.jsonl`);
  if (!fs.existsSync(filePath)) return [];

  const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
  const messages: ContextMessage[] = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "message") {
        messages.push(entry.data);
      }
    } catch {}
  }
  return messages;
}

/** Save new messages to JSONL (append-only) */
export function appendContext(sessionKey: string, messages: ContextMessage[]): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const filePath = path.join(SESSIONS_DIR, `${sessionKey}.jsonl`);
  const stream = fs.createWriteStream(filePath, { flags: "a" });
  const now = Date.now();

  for (const msg of messages) {
    const entry = {
      id: crypto.randomUUID(),
      timestamp: now,
      type: "message",
      data: { ...msg, timestamp: now },
    };
    stream.write(JSON.stringify(entry) + "\n");
  }
  stream.end();

  // Update session timestamp
  try {
    getDb().prepare("UPDATE sessions SET updated_at = ? WHERE session_key = ?")
      .run(now / 1000, sessionKey);
  } catch {}
}

/** Update session title */
export function updateSessionTitle(sessionKey: string, title: string): void {
  try {
    getDb().prepare("UPDATE sessions SET title = ? WHERE session_key = ? AND title = ''")
      .run(title, sessionKey);
  } catch {}
}
