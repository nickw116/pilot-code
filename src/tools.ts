import { exec } from "child_process";
import fs from "fs";
import path from "path";
import { Type, type Static, type TSchema } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { AcpClient, type AcpLogEvent } from "./acp-client.js";
import { publish } from "./sse.js";
import { appendAcpLog } from "./session.js";
import { loadAllSkills, loadSkillContent } from "./skills/index.js";
import {
  appendToLongTermMemory,
  appendDailyNote,
  searchMemory as searchMemoryFiles,
} from "./memory.js";
import {
  snapshotWorkspace,
  findChangedFiles,
  callMimoReview,
} from "./review.js";

let currentSseSessionKey: string | null = null;
let currentSseRunId: string | null = null;
let acpLogSeq = 0;

export function setAcpSseContext(sessionKey: string, runId: string): void {
  currentSseSessionKey = sessionKey;
  currentSseRunId = runId;
  acpLogSeq = 0;
}

export function clearAcpSseContext(): void {
  currentSseSessionKey = null;
  currentSseRunId = null;
}

const SKIP_PERSIST_TYPES = new Set(["text_delta", "reasoning"]);

function publishAcpLog(event: AcpLogEvent): void {
  if (!currentSseSessionKey || !currentSseRunId) return;
  const seq = acpLogSeq++;
  publish(currentSseSessionKey, {
    eventId: "",
    kind: "acp.log_event",
    runId: currentSseRunId,
    sessionKey: currentSseSessionKey,
    payload: {
      type: event.type,
      tool: event.tool || null,
      text: event.text,
      detail: event.detail || null,
      durationMs: event.durationMs || null,
    },
  });
  if (SKIP_PERSIST_TYPES.has(event.type)) return;
  try {
    appendAcpLog(currentSseSessionKey, currentSseRunId, event, seq);
  } catch (err) {
    console.error("[acp] failed to persist log:", err);
  }
}

const DEFAULT_WORKSPACE = path.resolve(
  process.env.WORKSPACE_DIR ||
    path.join(process.cwd(), "data", "workspace")
);

const DANGEROUS_COMMANDS = [
  /\brm\s+(-\w*r\w*f|--force)\s+\/(\s|$)/i,
  /\brm\s+(-\w*r\w*f|--force)\s+~(\s|$)/i,
  /\brm\s+(-\w*r\w*f|--force)\s+\*(\s|$)/,
  /\bmkfs\b/i,
  /\bdd\s+(if|of)=\/dev\//i,
  /:\(\)\{.*:\|.*&.*\}/,
  /\bchmod\s+(777|-R\s+777)\s+\//i,
  /\bchown\s+-R\s+root\s+\//i,
  /\b(wget|curl)\b.*\|\s*(ba)?sh/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\binit\s+[06]\b/,
  /\bsystemctl\s+(stop|disable|restart|reload)\s+/i,
  /\bservice\s+\w+\s+(stop|restart|reload)\s*/i,
  />\/dev\/sd/i,
];

function checkBashSafety(command: string): string | null {
  for (const pattern of DANGEROUS_COMMANDS) {
    if (pattern.test(command)) {
      return `该命令被安全策略拦截: ${pattern.source}`;
    }
  }
  return null;
}

const AGENTS_MD_CONTENT = `# AGENTS.md

## 项目说明
这是你的工作目录。你可以在这里读写文件、运行命令。

## Pilot Agent 项目路径
Pilot Agent 项目代码在 /home/ubuntu/pilot-agent/ 目录下：
- 后端入口：/home/ubuntu/pilot-agent/src/index.ts
- Agent 逻辑：/home/ubuntu/pilot-agent/src/agent.ts
- SSE 事件桥接：/home/ubuntu/pilot-agent/src/event-bridge.ts
- 前端代码：/home/ubuntu/pilot-agent/frontend/src/
- Agent 配置：/home/ubuntu/pilot-agent/agents.json
- 环境配置：/home/ubuntu/pilot-agent/.env

## 注意事项
- 修改 Pilot Agent 代码时，在 /home/ubuntu/pilot-agent/ 目录下操作
- 不要去 /home/ubuntu/.openclaw/ 目录，那是另一个项目
- 修改文件前先读取
- 用 edit 而非 write 做局部修改
`;

function ensureWorkspace(workspaceRoot: string): void {
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const agentsMd = path.join(workspaceRoot, "AGENTS.md");
  if (!fs.existsSync(agentsMd)) {
    fs.writeFileSync(agentsMd, AGENTS_MD_CONTENT, "utf-8");
  }
}

function makeResolve(workspaceRoot: string) {
  return (p: string): string => {
    const abs = path.resolve(workspaceRoot, p);
    if (!abs.startsWith(workspaceRoot)) throw new Error(`Path escapes workspace: ${p}`);
    return abs;
  };
}

export function createUserTools(workspaceRoot: string, allowedTools?: string[], getImages?: () => { data: string; mimeType: string }[] | undefined): { tools: AgentTool<TSchema, string | Record<string, unknown>>[]; dispose: () => Promise<void> } {
  ensureWorkspace(workspaceRoot);
  const resolve = makeResolve(workspaceRoot);

  const ReadParams = Type.Object({
    paths: Type.Array(Type.String({ description: "File or directory paths" })),
    startLine: Type.Optional(Type.Number({ description: "Start line (1-indexed)" })),
    endLine: Type.Optional(Type.Number({ description: "End line" })),
  });

  function doRead(params: Static<typeof ReadParams>): AgentToolResult<string> {
    const results: string[] = [];
    for (const raw of params.paths) {
      const p = resolve(raw);
      if (!fs.existsSync(p)) {
        results.push(`${raw}: not found`);
        continue;
      }
      const stat = fs.statSync(p);
      if (stat.isDirectory()) {
        const entries = fs.readdirSync(p);
        results.push(`${raw}/\n${entries.map((e) => `  ${e}`).join("\n")}`);
      } else {
        let content = fs.readFileSync(p, "utf-8");
        const lines = content.split("\n");
        const start = (params.startLine ?? 1) - 1;
        const end = params.endLine ?? lines.length;
        const sliced = lines.slice(start, end);
        results.push(
          sliced.map((line, i) => `${String(start + i + 1).padStart(4)}\t${line}`).join("\n")
        );
      }
    }
    const text = results.join("\n\n");
    return { content: [{ type: "text", text }], details: text };
  }

  const WriteParams = Type.Object({
    path: Type.String({ description: "File path" }),
    content: Type.String({ description: "File content" }),
  });

  function doWrite(params: Static<typeof WriteParams>): AgentToolResult<string> {
    const p = resolve(params.path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, params.content, "utf-8");
    const msg = `Wrote ${Buffer.byteLength(params.content)} bytes to ${params.path}`;
    return { content: [{ type: "text", text: msg }], details: msg };
  }

  const EditParams = Type.Object({
    path: Type.String({ description: "File path" }),
    edits: Type.Array(
      Type.Object({
        old_string: Type.String({ description: "Text to find" }),
        new_string: Type.String({ description: "Replacement text" }),
      })
    ),
  });

  function doEdit(params: Static<typeof EditParams>): AgentToolResult<string> {
    const p = resolve(params.path);
    let content = fs.readFileSync(p, "utf-8");
    const diffs: string[] = [];
    for (const edit of params.edits) {
      const idx = content.indexOf(edit.old_string);
      if (idx === -1) {
        return {
          content: [{ type: "text", text: `edit failed: string not found in ${params.path}` }],
          details: "string not found",
        };
      }
      const after = content.replace(edit.old_string, edit.new_string);
      if (after === content) {
        return {
          content: [{ type: "text", text: `edit failed: replacement is identical` }],
          details: "no change",
        };
      }
      content = after;
      diffs.push(
        `--- ${edit.old_string.slice(0, 60)}\n+++ ${edit.new_string.slice(0, 60)}`
      );
    }
    fs.writeFileSync(p, content, "utf-8");
    const msg = `Edited ${params.path} (${diffs.length} change${diffs.length > 1 ? "s" : ""})\n${diffs.join("\n")}`;
    return { content: [{ type: "text", text: msg }], details: msg };
  }

  const BashParams = Type.Object({
    command: Type.String({ description: "Shell command" }),
    timeout: Type.Optional(Type.Number({ description: "Timeout ms", default: 30000 })),
  });

  function doBash(
    params: Static<typeof BashParams>,
    signal?: AbortSignal
  ): Promise<AgentToolResult<string>> {
    return new Promise((resolve_) => {
      const blockReason = checkBashSafety(params.command);
      if (blockReason) {
        return resolve_({
          content: [{ type: "text", text: `⛔ ${blockReason}` }],
          details: "blocked",
        });
      }
      const timeout = params.timeout ?? 30000;
      exec(
        params.command,
        { cwd: workspaceRoot, timeout, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          let text = "";
          if (stdout) text += stdout;
          if (stderr) text += (text ? "\n" : "") + stderr;
          if (error && !text) text = `Exit code ${error.code ?? "null"}: ${error.message}`;
          resolve_({
            content: [{ type: "text", text }],
            details: text,
          });
        }
      );
      signal?.addEventListener("abort", () => {
        resolve_({
          content: [{ type: "text", text: "Command aborted" }],
          details: "aborted",
        });
      });
    });
  }

  let acpClient: AcpClient | null = null;
  let acpReady = false;

  async function ensureAcp(): Promise<AcpClient> {
    if (acpClient && acpReady && acpClient.isReady()) return acpClient;
    if (acpClient) {
      await acpClient.stop().catch(() => {});
    }
    acpClient = new AcpClient();
    acpClient.setLogHandler(publishAcpLog);
    await acpClient.start(workspaceRoot, (method, params) => {
      console.debug("[acp] notification:", method, JSON.stringify(params).slice(0, 200));
    });
    acpReady = true;
    return acpClient;
  }

  let claudeAcpClient: AcpClient | null = null;
  let claudeAcpReady = false;

  async function ensureClaudeAcp(): Promise<AcpClient> {
    if (claudeAcpClient && claudeAcpReady && claudeAcpClient.isReady()) return claudeAcpClient;
    if (claudeAcpClient) {
      await claudeAcpClient.stop().catch(() => {});
    }
    claudeAcpClient = new AcpClient({
      command: process.env.CLAUDE_CODE_ACP_COMMAND || process.execPath,
      args: process.env.CLAUDE_CODE_ACP_ARGS?.split(" ") || [
        "/home/ubuntu/.openclaw/npm/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js",
      ],
      clientInfo: { name: "pilot-agent-claude", title: "Pilot Agent (Claude)", version: "0.1.0" },
    });
    claudeAcpClient.setLogHandler(publishAcpLog);
    await claudeAcpClient.start(workspaceRoot, (method, params) => {
      console.debug("[claude-acp] notification:", method, JSON.stringify(params).slice(0, 200));
    });
    claudeAcpReady = true;
    return claudeAcpClient;
  }

  const OpenCodeParams = Type.Object({
    prompt: Type.String({ description: "The coding task or question to send to opencode" }),
  });

  async function doOpenCode(
    params: Static<typeof OpenCodeParams>,
    signal?: AbortSignal
  ): Promise<AgentToolResult<string>> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const client = await ensureAcp();
        const images = getImages?.();
        const result = await client.prompt(params.prompt, images);
        const text = result.content || "(opencode completed with no text output)";
        return {
          content: [{ type: "text", text }],
          details: text,
        };
      } catch (err: any) {
        const msg = err?.message || String(err);
        if (msg.includes("ENOENT") || msg.includes("spawn")) {
          return {
            content: [{ type: "text", text: "opencode 命令未找到。请确认 opencode 已安装并在 PATH 中。" }],
            details: "opencode not found",
          };
        }
        if ((msg.includes("timeout") || msg.includes("ACP process exited")) && attempt === 0) {
          console.warn("[acp] opencode failure, restarting client and retrying...");
          acpReady = false;
          if (acpClient) await acpClient.stop().catch(() => {});
          continue;
        }
        return {
          content: [{ type: "text", text: `opencode 错误: ${msg}` }],
          details: msg,
        };
      }
    }
    return {
      content: [{ type: "text", text: "opencode 错误: 重试后仍然超时" }],
      details: "timeout after retry",
    };
  }

  function getAcpClientInner(): AcpClient | null {
    return acpClient && acpReady ? acpClient : null;
  }

  const tools: AgentTool<TSchema, string | Record<string, unknown>>[] = [
    {
      name: "read",
      description: "Read file contents or list directory contents",
      parameters: ReadParams,
      label: "Read",
      execute: (_id, params) => Promise.resolve(doRead(params as Static<typeof ReadParams>)),
    },
    {
      name: "write",
      description: "Create or overwrite a file",
      parameters: WriteParams,
      label: "Write",
      execute: (_id, params) => Promise.resolve(doWrite(params as Static<typeof WriteParams>)),
    },
    {
      name: "edit",
      description: "Replace text in a file",
      parameters: EditParams,
      label: "Edit",
      execute: (_id, params) => Promise.resolve(doEdit(params as Static<typeof EditParams>)),
    },
    {
      name: "bash",
      description: "Execute a bash command",
      parameters: BashParams,
      label: "Bash",
      execute: (_id, params, signal) => doBash(params as Static<typeof BashParams>, signal),
    },
  ];

  if (process.env.OPENCODE_ENABLED === "true" || process.env.OPENCODE_ACP_COMMAND) {
    tools.push({
      name: "opencode",
      description: "Delegate a coding task to opencode (a powerful AI coding agent with ACP protocol). Use this for complex code changes, refactoring, debugging, or multi-file edits that benefit from LSP-aware code understanding. opencode can read/write files, run commands, and interact with you. Provide a clear description of what needs to be done.",
      parameters: OpenCodeParams,
      label: "OpenCode",
      execute: (_id, params, signal) => doOpenCode(params as Static<typeof OpenCodeParams>, signal),
    });
  }

  const ClaudeCodeParams = Type.Object({
    prompt: Type.String({ description: "The coding task or question to send to Claude Code" }),
  });

  async function doClaudeCode(
    params: Static<typeof ClaudeCodeParams>,
    signal?: AbortSignal
  ): Promise<AgentToolResult<string>> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const client = await ensureClaudeAcp();
        const images = getImages?.();
        const result = await client.prompt(params.prompt, images);
        const text = result.content || "(Claude Code completed with no text output)";
        return {
          content: [{ type: "text", text }],
          details: text,
        };
      } catch (err: any) {
        const msg = err?.message || String(err);
        if (msg.includes("ENOENT") || msg.includes("spawn")) {
          return {
            content: [{ type: "text", text: "Claude Code ACP 未找到。请确认 @agentclientprotocol/claude-agent-acp 已安装。" }],
            details: "claude-agent-acp not found",
          };
        }
        if ((msg.includes("timeout") || msg.includes("ACP process exited")) && attempt === 0) {
          console.warn("[claude-acp] failure, restarting client and retrying...");
          claudeAcpReady = false;
          if (claudeAcpClient) await claudeAcpClient.stop().catch(() => {});
          continue;
        }
        return {
          content: [{ type: "text", text: `Claude Code 错误: ${msg}` }],
          details: msg,
        };
      }
    }
    return {
      content: [{ type: "text", text: "Claude Code 错误: 重试后仍然超时" }],
      details: "timeout after retry",
    };
  }

  if (process.env.CLAUDE_CODE_DISABLED !== "true") {
    const REVIEW_ENABLED = process.env.REVIEW_ENABLED !== "false";
    const MAX_REVIEW_ROUNDS = 2;

    async function doClaudeCodeWithReview(
      params: Static<typeof ClaudeCodeParams>,
      signal?: AbortSignal
    ): Promise<AgentToolResult<string>> {
      const snapshot = REVIEW_ENABLED
        ? snapshotWorkspace(workspaceRoot)
        : null;

      let result = await doClaudeCode(params, signal);

      if (!snapshot) return result;

      const changes = findChangedFiles(workspaceRoot, snapshot);
      if (changes.length === 0) return result;

      for (let round = 0; round < MAX_REVIEW_ROUNDS; round++) {
        if (signal?.aborted) break;

        publishAcpLog({
          type: "tool_start",
          tool: "mimo_review",
          text: `MIMO 自动 Review 第 ${round + 1} 轮 (${changes.length} 个文件)`,
        });

        const resultText = result.content
          .map((c: any) => (c.type === "text" ? c.text : ""))
          .join("");
        const review = await callMimoReview(
          params.prompt,
          resultText,
          changes
        );

        publishAcpLog({
          type: "tool_end",
          tool: "mimo_review",
          text: review.hasIssues
            ? "发现问题，反馈给 Claude Code 自动修复..."
            : "✅ 代码质量良好",
        });

        if (!review.hasIssues) {
          const text =
            resultText +
            `\n\n--- MIMO Review ✅ ---\n${review.review}`;
          return { content: [{ type: "text", text }], details: result.details };
        }

        const fixPrompt = `你之前的代码修改经过了 MIMO 自动 Review，发现以下问题，请立即修复：

${review.review}

请直接修复所有问题，修改完成后简要说明修复了什么。`;

        const newSnapshot = snapshotWorkspace(workspaceRoot);
        result = await doClaudeCode({ prompt: fixPrompt }, signal);

        const newChanges = findChangedFiles(workspaceRoot, newSnapshot);
        if (newChanges.length === 0) break;
        changes.length = 0;
        changes.push(...newChanges);
      }

      return result;
    }

    tools.push({
      name: "claude_code",
      description:
        "Delegate a coding task to Claude Code (Anthropic's AI coding agent via ACP protocol). Use this for complex code analysis, refactoring, debugging, or multi-file edits. Claude Code can read/write files, run commands, and interact with you. After Claude Code completes, MIMO automatically reviews the changes and feeds back issues for self-fixing. Provide a clear description of what needs to be done.",
      parameters: ClaudeCodeParams,
      label: "Claude Code",
      execute: (_id, params, signal) =>
        doClaudeCodeWithReview(
          params as Static<typeof ClaudeCodeParams>,
          signal
        ),
    });
  }

  const SkillParams = Type.Object({
    id: Type.String({ description: "Skill ID to load (e.g. 'github', 'stock-chart-analysis', 'frontend-spec')" }),
  });

  function doSkill(params: Static<typeof SkillParams>): AgentToolResult<string> {
    const content = loadSkillContent(params.id);
    return { content: [{ type: "text", text: content }], details: content };
  }

  tools.push({
    name: "skill",
    description: "Load a skill's full knowledge and reference docs. Use this to get detailed instructions before executing skill-related tasks. Available skill IDs are listed in your system prompt under '可用 Skills'.",
    parameters: SkillParams,
    label: "Skill",
    execute: (_id, params) => Promise.resolve(doSkill(params as Static<typeof SkillParams>)),
  });

  // --- Memory tools (always available, not filtered) ---

  const MemorySaveParams = Type.Object({
    content: Type.String({ description: "Content to save to memory" }),
    type: Type.Union([
      Type.Literal("long_term"),
      Type.Literal("daily"),
    ], { description: "'long_term' = durable facts/preferences (MEMORY.md), 'daily' = today's note" }),
  });

  function doMemorySave(params: Static<typeof MemorySaveParams>): AgentToolResult<string> {
    if (params.type === "long_term") {
      appendToLongTermMemory(workspaceRoot, params.content);
      return { content: [{ type: "text", text: "已保存到长期记忆 (MEMORY.md)" }], details: "saved to MEMORY.md" };
    } else {
      appendDailyNote(workspaceRoot, params.content);
      return { content: [{ type: "text", text: "已保存到今日笔记" }], details: "saved to daily note" };
    }
  }

  const MemorySearchParams = Type.Object({
    query: Type.String({ description: "Search query to find relevant memories" }),
  });

  function doMemorySearch(params: Static<typeof MemorySearchParams>): AgentToolResult<string> {
    const results = searchMemoryFiles(workspaceRoot, params.query);
    if (results.length === 0) {
      return { content: [{ type: "text", text: "未找到相关记忆" }], details: "no results" };
    }
    const text = results.join("\n---\n");
    return { content: [{ type: "text", text }], details: text };
  }

  const memoryTools: AgentTool<TSchema, string | Record<string, unknown>>[] = [
    {
      name: "memory_save",
      description: "Save important information to persistent memory. Use 'long_term' for durable facts, user preferences, and standing decisions. Use 'daily' for observations and session summaries.",
      parameters: MemorySaveParams,
      label: "Memory Save",
      execute: (_id, params) => Promise.resolve(doMemorySave(params as Static<typeof MemorySaveParams>)),
    },
    {
      name: "memory_search",
      description: "Search across all memory files (MEMORY.md and daily notes) for relevant information. Use this before answering questions to check if relevant context was previously saved.",
      parameters: MemorySearchParams,
      label: "Memory Search",
      execute: (_id, params) => Promise.resolve(doMemorySearch(params as Static<typeof MemorySearchParams>)),
    },
  ];

  const filtered = allowedTools
    ? tools.filter((t) => allowedTools.includes(t.name))
    : tools;

  // Memory tools are always available regardless of agent tool restrictions
  filtered.push(...memoryTools);

  async function dispose(): Promise<void> {
    if (acpClient) {
      await acpClient.dispose().catch(() => {});
      acpClient = null;
      acpReady = false;
    }
    if (claudeAcpClient) {
      await claudeAcpClient.dispose().catch(() => {});
      claudeAcpClient = null;
      claudeAcpReady = false;
    }
  }

  return { tools: filtered, dispose };
}

export const tools = createUserTools(DEFAULT_WORKSPACE).tools;

export function getUserWorkspaceDir(userId: number, agentId?: string): string {
  const base = path.join(DEFAULT_WORKSPACE, `user-${userId}`);
  if (!agentId || agentId === "main") return base;
  return path.join(base, agentId);
}
