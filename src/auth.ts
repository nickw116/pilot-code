import Database from "better-sqlite3";
import crypto from "crypto";
import fs from "fs";
import path from "path";

const DB_PATH = process.env.USER_DB_PATH || path.join(process.cwd(), "data", "db", "users.db");

let db: Database.Database;

function getDb(): Database.Database {
  if (db) return db;
  db = new Database(DB_PATH, { readonly: false });
  db.pragma("journal_mode = WAL");
  ensureUserColumns(db);
  return db;
}

function ensureUserColumns(d: Database.Database) {
  const cols = (d.pragma("table_info(users)") as { name: string }[]).map(c => c.name);
  if (!cols.includes("allowed_agent")) {
    d.exec("ALTER TABLE users ADD COLUMN allowed_agent TEXT DEFAULT 'main'");
  }
  if (!cols.includes("preferred_agent")) {
    d.exec("ALTER TABLE users ADD COLUMN preferred_agent TEXT DEFAULT NULL");
  }
}

const AGENT_HIERARCHY = ["main", "dev", "user"];

export function getAllowedAgents(allowedAgent: string | null): string[] {
  const top = allowedAgent || "user";
  const idx = AGENT_HIERARCHY.indexOf(top);
  if (idx < 0) return ["user"];
  return AGENT_HIERARCHY.slice(idx);
}

export interface User {
  id: number;
  username: string;
  password_hash: string;
  role: string;
  display_name: string;
  enabled: number;
  allowed_agent: string | null;
  preferred_agent: string | null;
}

function hashPassword(password: string): string {
  return crypto.createHash("sha256").update(password).digest("hex");
}

export function login(
  username: string,
  password: string
): { token: string; username: string; role: string; display_name: string; allowed_agent: string; preferred_agent: string | null } | null {
  const d = getDb();
  const user = d
    .prepare("SELECT * FROM users WHERE username = ? AND enabled = 1")
    .get(username) as User | undefined;
  if (!user) return null;

  if (user.password_hash !== hashPassword(password)) return null;

  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now() / 1000;
  d.prepare("INSERT INTO tokens (user_id, token, created_at, expires_at) VALUES (?, ?, ?, 0)")
    .run(user.id, token, now);
  d.prepare("UPDATE users SET last_login = ? WHERE id = ?").run(now, user.id);

  return {
    token,
    username: user.username,
    role: user.role,
    display_name: user.display_name,
    allowed_agent: user.allowed_agent || "user",
    preferred_agent: user.preferred_agent,
  };
}

export interface TokenUser {
  userId: number;
  username: string;
  role: string;
  displayName: string;
  allowedAgent: string;
  preferredAgent: string | null;
}

export function validateToken(token: string): TokenUser | null {
  const d = getDb();
  const row = d
    .prepare(
      `SELECT t.user_id, u.username, u.role, u.display_name, u.enabled, u.allowed_agent, u.preferred_agent
       FROM tokens t JOIN users u ON t.user_id = u.id
       WHERE t.token = ? AND u.enabled = 1`
    )
    .get(token) as any | undefined;
  if (!row) return null;
  return {
    userId: row.user_id,
    username: row.username,
    role: row.role,
    displayName: row.display_name,
    allowedAgent: row.allowed_agent || "user",
    preferredAgent: row.preferred_agent,
  };
}

export function logout(token: string): void {
  getDb().prepare("DELETE FROM tokens WHERE token = ?").run(token);
}

export function changePassword(
  userId: number,
  oldPassword: string,
  newPassword: string
): { ok: boolean; message?: string } {
  const d = getDb();
  const user = d.prepare("SELECT password_hash FROM users WHERE id = ?").get(userId) as User | undefined;
  if (!user) return { ok: false, message: "User not found" };
  if (user.password_hash !== hashPassword(oldPassword))
    return { ok: false, message: "Old password incorrect" };
  d.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
    .run(hashPassword(newPassword), userId);
  // Revoke all tokens for this user
  d.prepare("DELETE FROM tokens WHERE user_id = ?").run(userId);
  return { ok: true };
}

export function setPreferredAgent(userId: number, agentId: string): void {
  getDb().prepare("UPDATE users SET preferred_agent = ? WHERE id = ?").run(agentId, userId);
}
