import fs from "fs";
import path from "path";

const AUDIT_DIR = path.join(process.cwd(), "data", "audit");

function getAuditFile(): string {
  const d = new Date();
  const dateStr = d.toISOString().slice(0, 10).replace(/-/g, "");
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  return path.join(AUDIT_DIR, `audit-${dateStr}.jsonl`);
}

export interface AuditEntry {
  timestamp: number;
  userId: number;
  username: string;
  sessionKey: string;
  model: string;
  durationMs: number;
  error?: string;
}

export function appendAuditLog(entry: AuditEntry): void {
  try {
    const line = JSON.stringify(entry) + "\n";
    fs.appendFileSync(getAuditFile(), line);
  } catch (err) {
    console.error("[audit] failed to write:", err);
  }
}
