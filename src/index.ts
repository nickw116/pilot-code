import "dotenv/config";
import express from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { registerSubscriber, unregisterSubscriber, publish } from "./sse.js";
import * as agentModule from "./agent.js";
import * as authMod from "./auth.js";
import * as sessionMod from "./session.js";
import { getContextStats } from "./compaction.js";

const PORT = parseInt(process.env.PORT || "8081", 10);

const app = express();
app.use(express.json({ limit: "10mb" }));

// CORS
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  if (_req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// --- Auth middleware ---
function auth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ detail: "Unauthorized" });

  const user = authMod.validateToken(token);
  if (!user) return res.status(401).json({ detail: "Invalid or expired token" });

  (req as any).user = user;
  next();
}

// --- Routes ---

app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ detail: "Missing username or password" });
  }
  const result = authMod.login(username, password);
  if (!result) {
    return res.status(401).json({ detail: "Invalid username or password" });
  }
  res.json(result);
});

app.post("/api/logout", auth, (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (token) authMod.logout(token);
  res.json({ ok: true });
});

app.get("/api/status", auth, (req, res) => {
  const user = (req as any).user;
  res.json({ connected: true, user: user.username, role: user.role });
});

app.post("/api/change-password", auth, (req, res) => {
  const user = (req as any).user;
  const { old_password, new_password } = req.body || {};
  if (!old_password || !new_password) {
    return res.status(400).json({ detail: "Missing old_password or new_password" });
  }
  const result = authMod.changePassword(user.userId, old_password, new_password);
  if (!result.ok) return res.status(400).json({ detail: result.message });
  res.json({ ok: true });
});

// --- Session routes ---

app.get("/api/session", auth, (req, res) => {
  const user = (req as any).user;
  const s = sessionMod.getOrCreateActiveSession(user.userId, user.username);
  res.json({ sessionKey: s.session_key });
});

app.get("/api/sessions", auth, (req, res) => {
  const user = (req as any).user;
  const sessions = sessionMod.listSessions(user.userId).map((s) => ({
    sessionKey: s.session_key,
    title: s.title,
    active: s.active === 1,
  }));
  res.json({ sessions });
});

app.post("/api/session/new", auth, (req, res) => {
  const user = (req as any).user;
  const { agent_id } = req.body || {};
  const s = sessionMod.createSession(user.userId, user.username, agent_id || "main");
  res.json({ sessionKey: s.session_key });
});

app.post("/api/sessions", auth, (req, res) => {
  const user = (req as any).user;
  const { agent_id } = req.body || {};
  const s = sessionMod.createSession(user.userId, user.username, agent_id || "main");
  res.json({ sessionKey: s.session_key });
});

app.put("/api/sessions/active", auth, (req, res) => {
  const user = (req as any).user;
  const { session_key } = req.body || {};
  if (!session_key) return res.status(400).json({ detail: "Missing session_key" });
  const s = sessionMod.switchSession(user.userId, session_key);
  if (!s) return res.status(404).json({ detail: "Session not found" });
  res.json({ ok: true, sessionKey: s.session_key });
});

app.delete("/api/sessions", auth, (req, res) => {
  const user = (req as any).user;
  const { session_key } = req.body || {};
  if (!session_key) return res.status(400).json({ detail: "Missing session_key" });
  agentModule.destroyAgent(session_key);
  const ok = sessionMod.deleteSession(user.userId, session_key);
  if (!ok) return res.status(404).json({ detail: "Session not found" });
  res.json({ ok: true });
});

// --- Chat ---

app.post("/api/chat/v2", auth, (req, res) => {
  const user = (req as any).user;
  const { message, session_key } = req.body || {};
  if (!message) return res.status(400).json({ detail: "No message" });

  // Resolve session
  const s = session_key
    ? sessionMod.switchSession(user.userId, session_key)
    : sessionMod.getOrCreateActiveSession(user.userId, user.username);
  const sk = s?.session_key || sessionMod.getOrCreateActiveSession(user.userId, user.username).session_key;

  // Fire-and-forget
  agentModule.runPrompt(message, sk).catch((err) => {
    console.error("[chat/v2] agent error:", err.message);
  });

  res.json({ ok: true, sessionKey: sk });
});

// Legacy chat alias
app.post("/api/chat", (req, _res, next) => {
  req.url = "/api/chat/v2";
  next("router");
});

app.post("/api/abort", auth, (req, res) => {
  const user = (req as any).user;
  const { session_key } = req.body || {};
  if (!session_key) return res.status(400).json({ detail: "Missing session_key" });
  agentModule.abort(session_key);
  res.json({ ok: true });
});

// --- SSE ---

app.get("/api/events", auth, (req, res) => {
  const user = (req as any).user;
  const sessionKey = (req.query.sessionKey as string) ||
    sessionMod.getOrCreateActiveSession(user.userId, user.username).session_key;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const subscriberId = crypto.randomUUID();
  registerSubscriber(sessionKey, subscriberId, res as any);

  const heartbeat = setInterval(() => {
    try { res.write(":\n\n"); } catch { clearInterval(heartbeat); }
  }, 8000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unregisterSubscriber(sessionKey, subscriberId);
  });
});

app.post("/api/events/ack", auth, (_req, res) => {
  res.json({ ok: true });
});

// --- History ---

app.get("/api/history", auth, (req, res) => {
  const user = (req as any).user;
  const sessionKey = (req.query.sessionKey as string) ||
    sessionMod.getOrCreateActiveSession(user.userId, user.username).session_key;
  const messages = sessionMod.loadContext(sessionKey);
  const entries = messages.map((m, i) => ({
    id: String(i),
    role: m.role,
    content: m.content,
    model: m.model,
    timestamp: m.timestamp,
  }));
  res.json({ entries, messages: entries });
});

// --- Models ---

app.get("/api/models", auth, (_req, res) => {
  res.json({
    models: agentModule.getModelList(),
  });
});

app.post("/api/model/switch", auth, (req, res) => {
  const { model, session_key } = req.body || {};
  if (!model || !session_key) {
    return res.status(400).json({ detail: "Missing model or session_key" });
  }
  const ok = agentModule.switchModel(session_key, model);
  if (!ok) return res.status(400).json({ detail: "Unknown model" });
  res.json({ ok: true, model });
});

// --- File transfer ---

const WORKSPACE = path.resolve(process.env.WORKSPACE_DIR || path.join(import.meta.dirname, "..", "data", "workspace"));
const UPLOAD_DIR = path.join(WORKSPACE, "uploads");

app.post("/api/upload", auth, (req, res) => {
  // Simple base64 upload for MVP
  const { filename, content_b64 } = req.body || {};
  if (!filename || !content_b64) {
    return res.status(400).json({ detail: "Missing filename or content_b64" });
  }
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const safeName = path.basename(filename);
  const filePath = path.join(UPLOAD_DIR, safeName);
  fs.writeFileSync(filePath, Buffer.from(content_b64, "base64"));
  const relativePath = path.relative(WORKSPACE, filePath);
  res.json({ url: `/api/download?path=${encodeURIComponent(relativePath)}`, filename: safeName });
});

app.get("/api/download", auth, (req, res) => {
  const filePath = req.query.path as string;
  const url = req.query.url as string;
  const filename = (req.query.filename as string) || "download";

  if (filePath) {
    const resolved = path.resolve(WORKSPACE, filePath);
    if (!resolved.startsWith(WORKSPACE)) {
      return res.status(403).json({ detail: "Path escapes workspace" });
    }
    if (!fs.existsSync(resolved)) return res.status(404).json({ detail: "Not found" });
    return res.download(resolved, filename);
  }

  if (url) {
    return res.redirect(url);
  }

  res.status(400).json({ detail: "Missing path or url" });
});

app.get("/api/local-file", auth, (req, res) => {
  const filePath = req.query.path as string;
  if (!filePath) return res.status(400).json({ detail: "Missing path" });
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return res.status(404).json({ detail: "Not found" });
  res.sendFile(resolved);
});

// --- Context stats ---

app.get("/api/context/stats", auth, (req, res) => {
  const user = (req as any).user;
  const sessionKey = (req.query.sessionKey as string) ||
    sessionMod.getOrCreateActiveSession(user.userId, user.username).session_key;
  res.json(getContextStats(sessionKey));
});

// --- Health ---

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", version: "0.3.0" });
});

// --- Serve frontend (production) ---

const FRONTEND_DIR = path.join(import.meta.dirname, "..", "frontend", "dist");
if (fs.existsSync(FRONTEND_DIR)) {
  app.use(express.static(FRONTEND_DIR));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(FRONTEND_DIR, "index.html"));
  });
}

// --- Start ---
app.listen(PORT, () => {
  console.log(`Pilot Code bridge listening on http://0.0.0.0:${PORT}`);
  console.log(`Workspace: ${process.env.WORKSPACE_DIR || "data/workspace"}`);
});
