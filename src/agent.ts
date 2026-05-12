import { Agent } from "@mariozechner/pi-agent-core";
import {
  streamSimpleOpenAICompletions,
  registerApiProvider,
  type Model,
} from "@mariozechner/pi-ai";
import { tools } from "./tools.js";
import { publish } from "./sse.js";
import { bridgeAndPublish } from "./event-bridge.js";
import { loadContext, appendContext, updateSessionTitle, type ContextMessage } from "./session.js";
import { compactIfNeeded } from "./compaction.js";

registerApiProvider({
  api: "openai-completions",
  stream: streamSimpleOpenAICompletions as any,
  streamSimple: streamSimpleOpenAICompletions as any,
}, "xiaomi-openai");

const mimoModel: Model<any> = {
  id: "mimo-v2.5-pro",
  name: "MiMo V2.5 Pro",
  api: "openai-completions",
  provider: "xiaomi",
  baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0.7, output: 2.1, cacheRead: 0.14, cacheWrite: 0 },
  contextWindow: 1000000,
  maxTokens: 131072,
};

const SYSTEM_PROMPT =
  "你是 Pilot Code，一个智能编程助手。你可以读写文件、执行命令来帮助用户。请用中文回答。修改文件前先读取，使用 edit 做精确修改。";

const agents = new Map<string, Agent>();

function getAgent(sessionKey: string): Agent {
  const existing = agents.get(sessionKey);
  if (existing) return existing;

  const agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model: mimoModel,
      tools,
    },
    streamFn: streamSimpleOpenAICompletions as any,
    getApiKey: (provider: string) => {
      if (provider === "xiaomi") return process.env.XIAOMI_API_KEY;
      return undefined;
    },
    convertToLlm: (messages) => messages as any[],
    transformContext: compactIfNeeded,
    toolExecution: "sequential",
  });

  agent.subscribe((event) => {
    const runId = currentRunIds.get(sessionKey);
    if (runId) bridgeAndPublish(event, runId, sessionKey);
  });

  // Restore conversation history from JSONL
  const history = loadContext(sessionKey);
  if (history.length > 0) {
    const restored = history.map((msg) => ({
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp || Date.now(),
    }));
    agent.state.messages = restored as any;
    console.log(`[agent] Restored ${restored.length} messages for ${sessionKey}`);
  }

  agents.set(sessionKey, agent);
  return agent;
}

const currentRunIds = new Map<string, string>();

export async function runPrompt(message: string, sessionKey: string): Promise<string> {
  const agent = getAgent(sessionKey);
  const runId = crypto.randomUUID();
  currentRunIds.set(sessionKey, runId);

  try {
    await agent.prompt(message);
  } catch (err: any) {
    publish(sessionKey, {
      eventId: "",
      kind: "run.error",
      runId,
      sessionKey,
      payload: { error: err.message || "Agent error" },
    });
  } finally {
    currentRunIds.delete(sessionKey);
  }

  // Persist user + assistant messages
  const lastAssistant = agent.state.messages
    ?.filter((m: any) => m.role === "assistant")
    .pop();
  const toSave: ContextMessage[] = [{ role: "user", content: message }];
  if (lastAssistant) {
    const text = typeof lastAssistant.content === "string"
      ? lastAssistant.content
      : (lastAssistant.content as any[])?.filter((b: any) => b.type === "text").map((b: any) => b.text).join("") || "";
    if (text) toSave.push({ role: "assistant", content: text, model: mimoModel.name });
  }
  appendContext(sessionKey, toSave);

  // Auto-generate session title from first assistant response
  if (toSave.length > 1 && toSave[1]?.role === "assistant") {
    const firstUserMsg = loadContext(sessionKey).find((m) => m.role === "user");
    if (firstUserMsg && firstUserMsg === toSave[0]) {
      const title = toSave[1].content.slice(0, 50).replace(/\n/g, " ");
      updateSessionTitle(sessionKey, title);
    }
  }

  return runId;
}

export function abort(sessionKey: string): void {
  const agent = agents.get(sessionKey);
  if (!agent) return;
  agent.abort();
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

/** Remove agent from memory (e.g. when session is deleted) */
export function destroyAgent(sessionKey: string): void {
  agents.delete(sessionKey);
  currentRunIds.delete(sessionKey);
}

// --- Model switching ---

const modelRegistry: Record<string, { name: string; alias: string }> = {
  "xiaomi/mimo-v2.5-pro": { name: "MiMo V2.5 Pro", alias: "MiMo Pro" },
  "deepseek/deepseek-v4-flash": { name: "DeepSeek V4 Flash", alias: "DeepSeek" },
};

export function getModelList() {
  return Object.entries(modelRegistry).map(([id, info]) => ({
    id,
    name: info.name,
    alias: info.alias,
  }));
}

export function switchModel(sessionKey: string, modelId: string): boolean {
  if (!modelRegistry[modelId]) return false;
  // MVP: only mimo is actually supported; accept any registered model
  return true;
}
