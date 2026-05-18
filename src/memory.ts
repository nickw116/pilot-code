import fs from "fs";
import path from "path";

// OpenClaw-style memory system:
//   {workspace}/memory/MEMORY.md       — long-term memory (durable facts, preferences, decisions)
//   {workspace}/memory/YYYY-MM-DD.md   — daily notes (observations, session summaries)
//
// MEMORY.md is injected into the system prompt at session start.
// Today and yesterday's daily notes are also loaded.

const MEMORY_DIR = "memory";
const MEMORY_FILE = "MEMORY.md";

function getMemoryDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, MEMORY_DIR);
}

function ensureMemoryDir(workspaceRoot: string): string {
  const dir = getMemoryDir(workspaceRoot);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// --- Read operations ---

export function loadLongTermMemory(workspaceRoot: string): string {
  const file = path.join(getMemoryDir(workspaceRoot), MEMORY_FILE);
  if (!fs.existsSync(file)) return "";
  return fs.readFileSync(file, "utf-8");
}

export function loadRecentDailyNotes(workspaceRoot: string, days = 2): string {
  const dir = getMemoryDir(workspaceRoot);
  if (!fs.existsSync(dir)) return "";

  const results: string[] = [];
  const today = new Date();

  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const filename = formatDate(d) + ".md";
    const filepath = path.join(dir, filename);
    if (fs.existsSync(filepath)) {
      const content = fs.readFileSync(filepath, "utf-8");
      results.push(`## ${filename}\n${content}`);
    }
  }
  return results.join("\n\n");
}

// --- Write operations ---

export function appendToLongTermMemory(workspaceRoot: string, entry: string): void {
  const dir = ensureMemoryDir(workspaceRoot);
  const file = path.join(dir, MEMORY_FILE);
  let existing = "";
  if (fs.existsSync(file)) {
    existing = fs.readFileSync(file, "utf-8");
  }
  const date = formatDate(new Date());
  const line = `- ${entry} (${date})\n`;
  fs.writeFileSync(file, existing + (existing.endsWith("\n") || !existing ? "" : "\n") + line, "utf-8");
}

export function appendDailyNote(workspaceRoot: string, content: string): void {
  const dir = ensureMemoryDir(workspaceRoot);
  const today = formatDate(new Date()) + ".md";
  const filepath = path.join(dir, today);
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  const entry = `\n### ${time}\n${content}\n`;
  fs.appendFileSync(filepath, entry, "utf-8");
}

// --- Search ---

export function searchMemory(workspaceRoot: string, query: string, limit = 5): string[] {
  const dir = getMemoryDir(workspaceRoot);
  if (!fs.existsSync(dir)) return [];

  const results: string[] = [];
  const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (keywords.length === 0) return results;

  // Search MEMORY.md
  const memoryFile = path.join(dir, MEMORY_FILE);
  if (fs.existsSync(memoryFile)) {
    const content = fs.readFileSync(memoryFile, "utf-8");
    if (keywords.some((kw) => content.toLowerCase().includes(kw))) {
      results.push(`[${MEMORY_FILE}]\n${content}`);
    }
  }

  // Search daily notes (most recent first)
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}(-.*)?\.md$/.test(f))
    .sort()
    .reverse();

  for (const file of files) {
    if (results.length >= limit) break;
    const content = fs.readFileSync(path.join(dir, file), "utf-8");
    if (keywords.some((kw) => content.toLowerCase().includes(kw))) {
      results.push(`[${file}]\n${content}`);
    }
  }

  return results;
}

// --- Context building (for system prompt injection) ---

export function buildMemoryContext(workspaceRoot: string): string {
  const longTerm = loadLongTermMemory(workspaceRoot);
  const daily = loadRecentDailyNotes(workspaceRoot);

  const parts: string[] = [];
  if (longTerm.trim()) {
    parts.push(longTerm.trim());
  }
  if (daily.trim()) {
    parts.push(daily.trim());
  }

  return parts.length > 0 ? parts.join("\n\n") : "";
}

// --- Listing (for API) ---

export function listMemoryFiles(workspaceRoot: string): { name: string; size: number; modified: string }[] {
  const dir = getMemoryDir(workspaceRoot);
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const stat = fs.statSync(path.join(dir, f));
      return { name: f, size: stat.size, modified: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}
