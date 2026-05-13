import { Agent } from "@mariozechner/pi-agent-core";
import {
  streamSimpleOpenAICompletions,
  registerApiProvider,
  type Model,
  type ImageContent,
} from "@mariozechner/pi-ai";
import fs from "fs";
import path from "path";
import { createUserTools, getUserWorkspaceDir } from "./tools.js";
import { publish } from "./sse.js";
import { bridgeAndPublish } from "./event-bridge.js";
import { loadContext, appendContext, updateSessionTitle, type ContextMessage } from "./session.js";
import { compactIfNeeded } from "./compaction.js";
import { appendAuditLog } from "./audit.js";
import { buildSkillSummary } from "./skills/index.js";

registerApiProvider({
  api: "openai-completions",
  stream: streamSimpleOpenAICompletions as any,
  streamSimple: streamSimpleOpenAICompletions as any,
}, "xiaomi-openai");

// --- Load agents.json config ---

interface AgentConfig {
  id: string;
  name: string;
  model: string;
  fallbacks: string[];
  systemPrompt: string;
  timeoutSeconds: number;
  tools?: string[];
}

interface AgentsConfig {
  agents: AgentConfig[];
  models: Record<string, {
    provider: string;
    api: string;
    baseUrl: string;
    reasoning: boolean;
    contextWindow: number;
    maxTokens: number;
    modalities?: { input: string[]; output: string[] };
  }>;
}

let agentsConfig: AgentsConfig = { agents: [], models: {} };
const configPath = path.join(import.meta.dirname, "..", "agents.json");
if (fs.existsSync(configPath)) {
  try {
    agentsConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    console.log(`[config] loaded ${agentsConfig.agents?.length || 0} agent configs from agents.json`);
  } catch (err) {
    console.error("[config] failed to parse agents.json:", err);
  }
}

const agentConfigs = new Map<string, AgentConfig>();
for (const ac of agentsConfig.agents || []) {
  agentConfigs.set(ac.id, ac);
}

const mimoModel: Model<any> = {
  id: "mimo-v2.5",
  name: "MiMo V2.5",
  api: "openai-completions",
  provider: "xiaomi",
  baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0.7, output: 2.1, cacheRead: 0.14, cacheWrite: 0 },
  contextWindow: 1000000,
  maxTokens: 131072,
  compat: {
    thinkingFormat: "deepseek",
    requiresReasoningContentOnAssistantMessages: true,
    supportsDeveloperRole: false,
    supportsStore: false,
    supportsReasoningEffort: false,
  },
};

const deepseekModel: Model<any> = {
  id: "deepseek-v4-flash",
  name: "DeepSeek V4 Flash",
  api: "openai-completions",
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 8192,
};

const DEFAULT_SYSTEM_PROMPT =
  "你是 Pilot Code，一个智能编程助手。你可以读写文件、执行命令来帮助用户。请用中文回答。修改文件前先读取，使用 edit 做精确修改。如果 opencode 工具可用，复杂的多文件编辑、调试或重构任务可以委托给 opencode 处理。";

// --- SessionLane: per-session serial queue ---

class SessionLane {
  private queue: Array<() => Promise<void>> = [];
  private running = false;

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(async () => {
        try { resolve(await task()); }
        catch (e) { reject(e); }
      });
      this.dequeue();
    });
  }

  private async dequeue() {
    if (this.running || this.queue.length === 0) return;
    this.running = true;
    const task = this.queue.shift()!;
    await task();
    this.running = false;
    this.dequeue();
  }
}

const lanes = new Map<string, SessionLane>();

function getOrCreateLane(sessionKey: string): SessionLane {
  let lane = lanes.get(sessionKey);
  if (!lane) {
    lane = new SessionLane();
    lanes.set(sessionKey, lane);
  }
  return lane;
}

// --- Agent pool ---

interface AgentEntry {
  agent: Agent;
  modelId: string;
  agentId: string;
  userId: number;
  lastActivityAt: number;
}

const agents = new Map<string, AgentEntry>();
const currentImages = new Map<string, ImageContent[]>();

function getAgent(sessionKey: string, userId: number, modelId?: string, agentId?: string): Agent {
  const existing = agents.get(sessionKey);
  if (existing) {
    existing.lastActivityAt = Date.now();
    return existing.agent;
  }

  const ac = agentConfigs.get(agentId || "main");
  const resolvedModelId = modelId || ac?.model || "xiaomi/mimo-v2.5";
  const systemPrompt = ac?.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  const model = resolveModel(resolvedModelId);
  if (!model) throw new Error(`Unknown model: ${resolvedModelId}`);

  const resolvedAgentId = agentId || "main";
  const sk = sessionKey;
  const userTools = createUserTools(
    getUserWorkspaceDir(userId, resolvedAgentId),
    ac?.tools,
    () => currentImages.get(sk),
  );

  const skillSummary = buildSkillSummary();
  const fullSystemPrompt = systemPrompt + skillSummary;

  const agent = new Agent({
    initialState: {
      systemPrompt: fullSystemPrompt,
      model,
      tools: userTools,
      thinkingLevel: resolvedModelId.includes("mimo") ? "medium" : "off",
    },
    streamFn: streamSimpleOpenAICompletions as any,
    onPayload: (payload) => {
      (payload as any).max_tokens = model.maxTokens;
      return payload;
    },
    getApiKey: (provider: string) => {
      if (provider === "xiaomi") return process.env.XIAOMI_API_KEY;
      if (provider === "deepseek") return process.env.DEEPSEEK_API_KEY;
      return undefined;
    },
    convertToLlm: (messages) => messages as any[],
    transformContext: compactIfNeeded,
    toolExecution: "sequential",
  });

  const history = loadContext(sessionKey);
  if (history.length > 0) {
    const MAX_HISTORY = 20;
    const MAX_MSG_LEN = 500;
    const recent = history.slice(-MAX_HISTORY);
    const lines = recent.map((m) => {
      const label = m.role === "user" ? "User" : "Assistant";
      const text = (m.content || "").slice(0, MAX_MSG_LEN);
      return `${label}: ${text}`;
    });
    const contextMsg = {
      role: "user" as const,
      content: `[以下是之前对话的摘要，共${history.length}条，请在此基础上继续对话]\n${lines.join("\n")}`,
      timestamp: Date.now(),
    };
    agent.state.messages = [contextMsg];
    console.log(`[agent] restored ${history.length} messages as context summary for session ${sessionKey}`);
  }

  agent.subscribe((event) => {
    const runId = currentRunIds.get(sessionKey);
    if (runId) bridgeAndPublish(event, runId, sessionKey);
  });

  agents.set(sessionKey, { agent, modelId: resolvedModelId, agentId: agentId || "main", userId, lastActivityAt: Date.now() });
  return agent;
}

function resolveModel(modelId: string): Model<any> | null {
  if (modelId === "xiaomi/mimo-v2.5" || modelId === "mimo-v2.5") {
    const cfg = agentsConfig.models?.["xiaomi/mimo-v2.5"];
    const inputModalities = (cfg?.modalities?.input || ["text"]) as ("text" | "image")[];
    return { ...mimoModel, input: inputModalities };
  }
  if (modelId === "deepseek/deepseek-v4-flash" || modelId === "deepseek-v4-flash") {
    return deepseekModel;
  }
  return null;
}

function getApiKeyForProvider(provider: string): string | undefined {
  if (provider === "xiaomi") return process.env.XIAOMI_API_KEY;
  if (provider === "deepseek") return process.env.DEEPSEEK_API_KEY;
  return undefined;
}

const currentRunIds = new Map<string, string>();

async function doRunPromptWithRunId(runId: string, message: string, sessionKey: string, userId: number, agentId?: string, images?: ImageContent[]): Promise<string> {
  const entry = agents.get(sessionKey);
  const modelId = entry?.modelId || "xiaomi/mimo-v2.5";
  const agent = getAgent(sessionKey, userId, modelId, agentId);
  currentRunIds.set(sessionKey, runId);
  const startTime = Date.now();
  let errorMsg = "";

  const model = resolveModel(modelId);
  const apiKey = model ? getApiKeyForProvider(model.provider) : undefined;
  if (model && !apiKey) {
    const errMsg = `模型 ${modelId} 的 API Key 未配置`;
    console.error(`[agent] ${errMsg}`);
    publish(sessionKey, {
      eventId: "",
      kind: "run.error",
      runId,
      sessionKey,
      payload: { error: errMsg },
    });
    publish(sessionKey, {
      eventId: "",
      kind: "run.end",
      runId,
      sessionKey,
    });
    currentRunIds.delete(sessionKey);
    return runId;
  }

  console.log(`[agent] doRun: model=${modelId} hasImages=${!!images} imageCount=${images?.length || 0}`);

  if (images && images.length > 0) {
    currentImages.set(sessionKey, images);
  }

  try {
    await agent.prompt(message, images);
  } catch (err: any) {
    const errMsg = err?.message || "";
    console.error(`[agent] prompt failed: ${errMsg}`, err?.stack || "");
    publish(sessionKey, {
      eventId: "",
      kind: "run.error",
      runId,
      sessionKey,
      payload: { error: errMsg || "Agent error" },
    });
    errorMsg = errMsg || "Agent error";
  } finally {
    currentRunIds.delete(sessionKey);
    currentImages.delete(sessionKey);
    const e = agents.get(sessionKey);
    if (e) e.lastActivityAt = Date.now();
  }

  const activeAgent = agents.get(sessionKey)?.agent || agent;
  const lastAssistant = activeAgent.state.messages
    ?.filter((m: any) => m.role === "assistant")
    .pop();
  const toSave: ContextMessage[] = [{ role: "user", content: message }];
  const resolvedModelName = model?.name || modelId;
  if (lastAssistant) {
    const text = typeof lastAssistant.content === "string"
      ? lastAssistant.content
      : (lastAssistant.content as any[])?.filter((b: any) => b.type === "text").map((b: any) => b.text).join("") || "";
    if (text) toSave.push({ role: "assistant", content: text, model: resolvedModelName });
  }
  appendContext(sessionKey, toSave);

  if (toSave.length > 1 && toSave[1]?.role === "assistant") {
    const firstUserMsg = loadContext(sessionKey).find((m) => m.role === "user");
    if (firstUserMsg && firstUserMsg === toSave[0]) {
      const title = toSave[1].content.slice(0, 50).replace(/\n/g, " ");
      updateSessionTitle(sessionKey, title);
    }
  }

  appendAuditLog({
    timestamp: Date.now(),
    userId,
    username: "",
    sessionKey,
    model: modelId,
    durationMs: Date.now() - startTime,
    error: errorMsg || undefined,
  });

  return runId;
}

export function runPrompt(message: string, sessionKey: string, userId: number, agentId?: string, images?: ImageContent[]): Promise<string> {
  const runId = crypto.randomUUID();
  const lane = getOrCreateLane(sessionKey);
  lane.enqueue(() => doRunPromptWithRunId(runId, message, sessionKey, userId, agentId, images)).catch((err) => {
    console.error("[agent] runPrompt unhandled:", err.message);
    publish(sessionKey, {
      eventId: "",
      kind: "run.error",
      runId,
      sessionKey,
      payload: { error: err.message || "Unknown error" },
    });
    publish(sessionKey, {
      eventId: "",
      kind: "run.end",
      runId,
      sessionKey,
    });
  });
  return Promise.resolve(runId);
}

export function abort(sessionKey: string): void {
  const entry = agents.get(sessionKey);
  if (!entry) return;
  entry.agent.abort();
  const runId = currentRunIds.get(sessionKey);
  if (runId) {
    publish(sessionKey, {
      eventId: "",
      kind: "run.end",
      runId,
      sessionKey,
    });
  }
  currentRunIds.delete(sessionKey);
}

export function destroyAgent(sessionKey: string): void {
  agents.delete(sessionKey);
  currentRunIds.delete(sessionKey);
  lanes.delete(sessionKey);
}

// --- Model switching ---

const modelRegistry: Record<string, { name: string; alias: string }> = {
  "xiaomi/mimo-v2.5": { name: "MiMo V2.5", alias: "MiMo" },
  "deepseek/deepseek-v4-flash": { name: "DeepSeek V4 Flash", alias: "DeepSeek" },
};

export function getAgentList(allowedIds?: string[]) {
  const all = Array.from(agentConfigs.values()).map((ac) => ({
    id: ac.id,
    name: ac.name,
    tools: ac.tools || [],
  }));
  if (!allowedIds) return all;
  return all.filter((a) => allowedIds.includes(a.id));
}

export function getModelList() {
  return Object.entries(modelRegistry).map(([id, info]) => ({
    id,
    name: info.name,
    alias: info.alias,
  }));
}

export function getCurrentModel(sessionKey: string): string | null {
  const entry = agents.get(sessionKey);
  return entry?.modelId || null;
}

export function switchModel(sessionKey: string, modelId: string, userId: number): boolean {
  if (!modelRegistry[modelId]) return false;

  const model = resolveModel(modelId);
  if (!model) return false;

  agents.delete(sessionKey);
  getAgent(sessionKey, userId, modelId);
  console.log(`[agent] switched session ${sessionKey} to model ${modelId}`);
  return true;
}

// --- Session lifecycle: evict idle agents ---

const IDLE_TIMEOUT_MS = (parseInt(process.env.SESSION_IDLE_TIMEOUT || "86400", 10)) * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [sk, entry] of agents) {
    if (now - entry.lastActivityAt > IDLE_TIMEOUT_MS) {
      console.log(`[lifecycle] evicting idle agent for session ${sk} (idle ${Math.round((now - entry.lastActivityAt) / 60000)}min)`);
      agents.delete(sk);
      lanes.delete(sk);
    }
  }
}, 5 * 60 * 1000);
