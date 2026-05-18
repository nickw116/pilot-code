import "dotenv/config";

// Global error handlers — prevent ACP child-process crashes from killing the main process
process.on("unhandledRejection", (reason) => {
  console.error("[global] Unhandled rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[global] Uncaught exception:", err.stack || err);
});

import express from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import multer from "multer";
import { registerSubscriber, unregisterSubscriber, publish } from "./sse.js";
import * as agentModule from "./agent.js";
import * as authMod from "./auth.js";
import * as sessionMod from "./session.js";
import { getContextStats } from "./compaction.js";
import { checkRateLimit } from "./rate-limit.js";
import { transcribeAudio, describeVideo } from "./media-provider.js";
import { appendDailyNote } from "./memory.js";
import { getUserWorkspaceDir } from "./tools.js";

const PORT = parseInt(process.env.PORT || "8081", 10);

const app = express();
app.use(express.json({ limit: "100mb" }));

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
  res.json({ connected: true, user: user.username, role: user.role, allowed_agent: user.allowedAgent, preferred_agent: user.preferredAgent });
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

app.put("/api/user/preferred-agent", auth, (req, res) => {
  const user = (req as any).user;
  const { agent_id } = req.body || {};
  if (!agent_id || typeof agent_id !== "string") {
    return res.status(400).json({ detail: "Missing agent_id" });
  }
  const allowed = authMod.getAllowedAgents(user.allowedAgent);
  if (!allowed.includes(agent_id)) {
    return res.status(403).json({ detail: "No permission for this agent" });
  }
  authMod.setPreferredAgent(user.userId, agent_id);
  res.json({ ok: true, preferred_agent: agent_id });
});

// --- Session routes ---

app.get("/api/agents", auth, (req, res) => {
  const user = (req as any).user;
  const allowedIds = authMod.getAllowedAgents(user.allowedAgent);
  res.json({ agents: agentModule.getAgentList(allowedIds) });
});

app.get("/api/session", auth, (req, res) => {
  const user = (req as any).user;
  const agentId = user.preferredAgent && authMod.getAllowedAgents(user.allowedAgent).includes(user.preferredAgent)
    ? user.preferredAgent
    : user.allowedAgent;
  const s = sessionMod.getOrCreateActiveSession(user.userId, user.username, agentId);
  res.json({ sessionKey: s.session_key });
});

app.get("/api/sessions", auth, (req, res) => {
  const user = (req as any).user;
  const agentId = req.query.agent_id as string | undefined;
  const sessions = sessionMod.listSessions(user.userId, agentId).map((s) => ({
    sessionKey: s.session_key,
    title: s.title,
    agentId: s.agent_id,
    createdAt: s.created_at,
    active: s.active === 1,
  }));
  res.json({ sessions });
});

app.get("/api/admin/sessions", auth, (req, res) => {
  const user = (req as any).user;
  if (user.allowedAgent !== "main" && user.allowedAgent !== "dev") {
    return res.status(403).json({ detail: "Forbidden: insufficient privileges" });
  }
  const agentId = req.query.agent_id as string | undefined;
  if (agentId && (typeof agentId !== "string" || agentId.length > 32)) {
    return res.status(400).json({ detail: "Invalid agent_id" });
  }
  const sessions = sessionMod.listAllSessions(agentId).map((s) => {
    const status = sessionMod.getSessionStatus(s.session_key);
    return {
      sessionKey: s.session_key,
      title: s.title,
      agentId: s.agent_id,
      username: s.username,
      displayName: s.display_name,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
      active: s.active === 1,
      status: status ? status.status : "idle",
    };
  });
  res.json({ sessions });
});

function checkAgentPermission(user: any, agentId: string): boolean {
  const allowedIds = authMod.getAllowedAgents(user.allowedAgent);
  return allowedIds.includes(agentId);
}

app.post("/api/session/new", auth, (req, res) => {
  const user = (req as any).user;
  const { agent_id } = req.body || {};
  const aid = agent_id || "main";
  if (!checkAgentPermission(user, aid)) {
    return res.status(403).json({ detail: "No permission for this agent" });
  }

  // Memory flush: save old session's recent context before creating a new one
  try {
    const oldSession = sessionMod.getOrCreateActiveSession(user.userId, user.username, aid);
    const oldMessages = sessionMod.loadContext(oldSession.session_key, 20);
    if (oldMessages.length > 0) {
      const noteLines: string[] = ["[新会话前 memory flush]"];
      for (const msg of oldMessages) {
        const role = msg.role === "user" ? "用户" : "助手";
        const text = (msg.content || "").slice(0, 300);
        if (text) noteLines.push(`${role}: ${text}`);
      }
      const wsDir = getUserWorkspaceDir(user.userId, aid);
      appendDailyNote(wsDir, noteLines.join("\n"));
      console.log(`[memory] flushed ${oldMessages.length} messages from old session before creating new session`);
    }
  } catch (err) {
    console.error("[memory] new-session flush failed:", err);
  }

  const s = sessionMod.createSession(user.userId, user.username, aid);
  res.json({ sessionKey: s.session_key });
});

app.post("/api/sessions", auth, (req, res) => {
  const user = (req as any).user;
  const { agent_id } = req.body || {};
  const aid = agent_id || "main";
  if (!checkAgentPermission(user, aid)) {
    return res.status(403).json({ detail: "No permission for this agent" });
  }
  const s = sessionMod.createSession(user.userId, user.username, aid);
  res.json({ sessionKey: s.session_key });
});

app.put("/api/sessions/active", auth, (req, res) => {
  const user = (req as any).user;
  const body = req.body || {};
  const session_key = body.session_key || body.sessionKey;
  if (!session_key) return res.status(400).json({ detail: "Missing session_key" });
  const s = sessionMod.switchSession(user.userId, session_key);
  if (!s) return res.status(404).json({ detail: "Session not found" });
  res.json({ ok: true, sessionKey: s.session_key });
});

app.delete("/api/sessions", auth, (req, res) => {
  const user = (req as any).user;
  const body = req.body || {};
  const query = req.query || {};
  const session_key = body.session_key || body.sessionKey || query.sessionKey;
  if (!session_key) return res.status(400).json({ detail: "Missing session_key" });
  agentModule.destroyAgent(session_key as string);
  const ok = sessionMod.deleteSession(user.userId, session_key as string);
  if (!ok) return res.status(404).json({ detail: "Session not found" });
  res.json({ ok: true });
});

// --- Chat ---

app.post("/api/chat/v2", auth, async (req, res) => {
  const user = (req as any).user;
  if (!checkRateLimit(user.userId)) {
    return res.status(429).json({ detail: "请求过于频繁，请稍后再试" });
  }
  const { message, session_key, images, videos, audios } = req.body || {};
  console.log(`[chat/v2] message=${(message || "").slice(0, 80)} images=${images?.length || 0} videos=${videos?.length || 0} audios=${audios?.length || 0} session=${session_key}`);
  if (!message) return res.status(400).json({ detail: "No message" });

  // Resolve session
  const s = session_key
    ? sessionMod.switchSession(user.userId, session_key)
    : sessionMod.getOrCreateActiveSession(user.userId, user.username);
  const sk = s?.session_key || sessionMod.getOrCreateActiveSession(user.userId, user.username).session_key;
  const agentId = s?.agent_id || "main";

  const imageContent = Array.isArray(images) && images.length > 0
    ? images.map((img: any) => ({
        type: "image" as const,
        data: img.data,
        mimeType: img.mimeType,
      }))
    : undefined;

  const videoContent = Array.isArray(videos) && videos.length > 0
    ? videos.map((v: any) => ({ data: v.data, mimeType: v.mimeType }))
    : undefined;

  const audioContent = Array.isArray(audios) && audios.length > 0
    ? audios.map((a: any) => ({ data: a.data, mimeType: a.mimeType }))
    : undefined;

  // Fire-and-forget (runId available immediately)
  const runId = agentModule.runPrompt(message, sk, user.userId, agentId, imageContent, videoContent, audioContent);
  res.json({ ok: true, sessionKey: sk, runId: await runId });
});

app.post("/api/chat", auth, async (req, res) => {
  const user = (req as any).user;
  if (!checkRateLimit(user.userId)) {
    return res.status(429).json({ detail: "请求过于频繁，请稍后再试" });
  }
  const { message, session_key, images, videos, audios } = req.body || {};
  console.log(`[chat] message=${(message || "").slice(0, 80)} images=${images?.length || 0} videos=${videos?.length || 0} audios=${audios?.length || 0} session=${session_key}`);
  if (!message) return res.status(400).json({ detail: "No message" });

  const s = session_key
    ? sessionMod.switchSession(user.userId, session_key)
    : sessionMod.getOrCreateActiveSession(user.userId, user.username);
  const sk = s?.session_key || sessionMod.getOrCreateActiveSession(user.userId, user.username).session_key;
  const agentId = s?.agent_id || "main";

  const imageContent = Array.isArray(images) && images.length > 0
    ? images.map((img: any) => ({
        type: "image" as const,
        data: img.data,
        mimeType: img.mimeType,
      }))
    : undefined;

  const videoContent = Array.isArray(videos) && videos.length > 0
    ? videos.map((v: any) => ({ data: v.data, mimeType: v.mimeType }))
    : undefined;

  const audioContent = Array.isArray(audios) && audios.length > 0
    ? audios.map((a: any) => ({ data: a.data, mimeType: a.mimeType }))
    : undefined;

  const runId = await agentModule.runPrompt(message, sk, user.userId, agentId, imageContent, videoContent, audioContent);
  res.json({ ok: true, sessionKey: sk, runId });
});

app.post("/api/abort", auth, (req, res) => {
  const user = (req as any).user;
  const { session_key } = req.body || {};
  if (!session_key) return res.status(400).json({ detail: "Missing session_key" });
  agentModule.abort(session_key);
  sessionMod.setSessionStatus(session_key, "idle");
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

  const sessionStatus = sessionMod.getSessionStatus(sessionKey);
  if (sessionStatus && sessionStatus.status === "generating" && sessionStatus.runId) {
    // Replay persisted ACP logs so the frontend recovers progress after reconnect
    try {
      const existingLogs = sessionMod.loadAcpLogs(sessionKey, sessionStatus.runId);
      for (const log of existingLogs) {
        const replayEvent = {
          eventId: `evt-acp-replay-${log.seq}`,
          kind: "acp.log_event",
          runId: sessionStatus.runId,
          sessionKey,
          payload: {
            type: log.logType,
            tool: log.tool,
            text: log.text,
            detail: log.detail,
            durationMs: log.durationMs,
          },
        };
        try { res.write(`data: ${JSON.stringify(replayEvent)}\n\n`); } catch {}
      }
    } catch {}

    const snapshotEvent = {
      eventId: `evt-snapshot-${Date.now()}`,
      kind: "snapshot",
      runId: sessionStatus.runId,
      sessionKey,
      payload: {
        activeRuns: {
          [sessionStatus.runId]: {
            status: "streaming",
            mainText: "",
            steps: [],
          },
        },
      },
    };
    try { res.write(`data: ${JSON.stringify(snapshotEvent)}\n\n`); } catch {}
  }

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
  const limit = Math.max(1, Math.min(500, parseInt(req.query.limit as string, 10) || 200));
  const messages = sessionMod.loadContext(sessionKey, limit);
  const status = sessionMod.getSessionStatus(sessionKey);
  const entries = messages.map((m) => {
    let acpLogs: sessionMod.AcpLogRow[] = [];
    if (m.role === "assistant" && m.runId) {
      try { acpLogs = sessionMod.loadAcpLogs(sessionKey, m.runId); } catch {}
    }
    return {
      id: String(m.dbId ?? m.timestamp),
      role: m.role,
      content: m.content,
      model: m.model,
      runId: m.runId || null,
      timestamp: m.timestamp,
      acpLogs: acpLogs.length > 0 ? acpLogs.map((l) => ({
        type: l.logType,
        tool: l.tool,
        text: l.text,
        detail: l.detail,
        durationMs: l.durationMs,
        ts: l.createdAt,
      })) : undefined,
    };
  });
  res.json({
    entries,
    messages: entries,
    status: status ? { status: status.status, runId: status.runId, error: status.error } : { status: "idle" },
  });
});

// --- Models ---

app.get("/api/models", auth, (req, res) => {
  const sessionKey = (req.query.sessionKey as string) || "";
  const current = sessionKey ? agentModule.getCurrentModel(sessionKey) : null;
  res.json({
    models: agentModule.getModelList(),
    default: current || agentModule.getModelList()[0]?.id || "",
  });
});

app.post("/api/model/switch", auth, (req, res) => {
  const user = (req as any).user;
  const { model, session_key } = req.body || {};
  if (!model || !session_key) {
    return res.status(400).json({ detail: "Missing model or session_key" });
  }
  const ok = agentModule.switchModel(session_key, model, user.userId);
  if (!ok) return res.status(400).json({ detail: "Unknown model" });
  res.json({ ok: true, model });
});

// --- File transfer ---

const WORKSPACE_ROOT = path.resolve(process.env.WORKSPACE_DIR || path.join(process.cwd(), "data", "workspace"));

function userWorkspace(userId: number): string {
  const dir = path.join(WORKSPACE_ROOT, `user-${userId}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function userUploadDir(userId: number): string {
  const dir = path.join(userWorkspace(userId), "uploads");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const user = (req as any).user;
      cb(null, userUploadDir(user.userId));
    },
    filename: (_req, file, cb) => {
      const safeName = path.basename(file.originalname || "upload");
      const ts = Date.now().toString(36);
      cb(null, `${ts}_${safeName}`);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
});

app.post("/api/upload", auth, upload.single("file"), (req, res) => {
  const file = req.file as Express.Multer.File | undefined;
  const user = (req as any).user;
  if (!file) {
    return res.status(400).json({ detail: "No file provided" });
  }
  const ws = userWorkspace(user.userId);
  const relativePath = path.relative(ws, file.path);

  const result: Record<string, any> = {
    url: `/api/download?path=${encodeURIComponent(relativePath)}`,
    filename: file.originalname,
    mimetype: file.mimetype,
    size: file.size,
  };

  if (file.mimetype.startsWith("image/")) {
    const b64 = fs.readFileSync(file.path).toString("base64");
    result.inline = `data:${file.mimetype};base64,${b64}`;
    result.preview = result.inline;
  } else if (file.mimetype.startsWith("video/") && file.size <= 16 * 1024 * 1024) {
    const b64 = fs.readFileSync(file.path).toString("base64");
    result.inline = `data:${file.mimetype};base64,${b64}`;
    result.preview = result.inline;
  } else if (file.mimetype.startsWith("audio/") && file.size <= 16 * 1024 * 1024) {
    const b64 = fs.readFileSync(file.path).toString("base64");
    result.inline = `data:${file.mimetype};base64,${b64}`;
    result.preview = result.inline;
  } else {
    const TEXT_EXTENSIONS = [".txt", ".md", ".csv", ".json", ".xml", ".html", ".css", ".js", ".ts", ".jsx", ".tsx", ".py", ".java", ".c", ".cpp", ".h", ".go", ".rs", ".rb", ".php", ".sh", ".bash", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf", ".log", ".sql", ".vue", ".svelte", ".swift", ".kt"];
    const ext = path.extname(file.originalname || "").toLowerCase();
    const sizeLimit = 100_000;
    if (TEXT_EXTENSIONS.includes(ext) || (file.mimetype && file.mimetype.startsWith("text/")) || file.size <= sizeLimit) {
      try {
        const content = fs.readFileSync(file.path, "utf-8");
        result.textContent = content.length > 50000 ? content.slice(0, 50000) + "\n... (truncated)" : content;
      } catch {}
    }
  }

  res.json(result);
});

app.post("/api/stt", auth, upload.single("audio"), async (req, res) => {
  const file = req.file as Express.Multer.File | undefined;
  console.log("[stt] request received, file:", file ? `${file.originalname} ${file.mimetype} ${file.size}B` : "none");
  if (!file) {
    return res.status(400).json({ detail: "No audio file provided" });
  }

  try {
    const { execFile } = await import("child_process");
    const wavPath = file.path + ".wav";

    await new Promise<void>((resolve, reject) => {
      execFile("ffmpeg", ["-y", "-i", file.path, "-ar", "16000", "-ac", "1", wavPath], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    const audioBuffer = fs.readFileSync(wavPath);
    const base64Audio = audioBuffer.toString("base64");
    if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
    if (fs.existsSync(file.path)) fs.unlinkSync(file.path);

    const text = await transcribeAudio(base64Audio, "wav");
    res.json({ text });
  } catch (err: any) {
    console.error("[stt] error:", err?.message || err);
    if (file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    res.status(500).json({ detail: "语音识别失败" });
  }
});

app.get("/api/download", auth, (req, res) => {
  const filePath = req.query.path as string;
  const url = req.query.url as string;
  const filename = (req.query.filename as string) || "download";
  const user = (req as any).user;

  if (filePath) {
    const ws = userWorkspace(user.userId);
    const resolved = path.resolve(ws, filePath);
    if (!resolved.startsWith(ws)) {
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

const FRONTEND_DIR = path.join(process.cwd(), "frontend", "dist");
if (fs.existsSync(FRONTEND_DIR)) {
  app.use(express.static(FRONTEND_DIR));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(FRONTEND_DIR, "index.html"));
  });
}

// --- Start ---
app.listen(PORT, () => {
  console.log(`Pilot Agent bridge listening on http://0.0.0.0:${PORT}`);
  console.log(`Workspace: ${process.env.WORKSPACE_DIR || "data/workspace"}`);
  const cleaned = sessionMod.cleanInterruptedSessions();
  if (cleaned > 0) {
    console.log(`[startup] cleaned ${cleaned} interrupted sessions`);
  }
});
