import { spawn, type ChildProcess } from "child_process";
import path from "path";
import { createInterface } from "readline";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, any>;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, any>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

type PendingRequest = {
  resolve: (result: any) => void;
  reject: (err: Error) => void;
};

export interface AcpClientOptions {
  command?: string;
  args?: string[];
  clientInfo?: { name: string; title: string; version: string };
}

export type AcpLogEventType =
  | "tool_start"
  | "tool_end"
  | "text_delta"
  | "reasoning"
  | "step_start"
  | "step_finish"
  | "log";

export interface AcpLogEvent {
  type: AcpLogEventType;
  tool?: string;
  text: string;
  detail?: string;
  durationMs?: number;
}

export class AcpClient {
  private proc: ChildProcess | null = null;
  private msgId = 0;
  private pending = new Map<number, PendingRequest>();
  private buffer = "";
  private sessionId: string | null = null;
  private initialized = false;
  private rl: ReturnType<typeof createInterface> | null = null;
  private onNotification: ((method: string, params: any) => void) | null = null;
  private onLog: ((event: AcpLogEvent) => void) | null = null;

  private cwd: string = process.cwd();
  private opts: AcpClientOptions;
  private promptTextAccumulator = "";

  constructor(opts?: AcpClientOptions) {
    this.opts = opts || {};
  }

  async start(cwd: string, notificationHandler?: (method: string, params: any) => void): Promise<void> {
    this.cwd = cwd;
    this.onNotification = notificationHandler || null;

    const cmd = this.opts.command || process.env.OPENCODE_ACP_COMMAND || "opencode";
    const args = this.opts.args || process.env.OPENCODE_ACP_ARGS?.split(" ") || ["acp"];

    this.proc = spawn(cmd, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    if (!this.proc.stdin || !this.proc.stdout) {
      throw new Error("Failed to create stdio pipes for opencode acp");
    }

    this.proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString().trim();
      if (text) {
        console.debug("[acp] stderr:", text);
        this.emitLog({ type: "log", text });
      }
    });

    this.proc.on("error", (err) => {
      console.error("[acp] process error:", err.message);
    });

    this.proc.on("exit", (code) => {
      console.log("[acp] process exited with code:", code);
      this.proc = null;
      this.initialized = false;
      this.sessionId = null;
      this.buffer = "";
      if (this.rl) {
        this.rl.close();
        this.rl = null;
      }
      for (const [id, p] of this.pending) {
        p.reject(new Error("ACP process exited"));
        this.pending.delete(id);
      }
    });

    this.rl = createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line: string) => {
      this.handleMessage(line);
    });

    const externalHandler = this.onNotification;
    this.onNotification = (method: string, params: any) => {
      if (method === "session/request_permission" && params?.requestId) {
        const reqId = params.requestId;
        console.log("[acp] auto-allowing permission request:", reqId);
        this.respondPermission(reqId, "allow");
        return;
      }
      this.handleAcpNotification(method, params);
      if (externalHandler) {
        externalHandler(method, params);
      }
    };

    await this.initialize();
    this.sessionId = await this.createSession();
    this.initialized = true;
    console.log("[acp] ready, sessionId:", this.sessionId);
  }

  setLogHandler(handler: (event: AcpLogEvent) => void): void {
    this.onLog = handler;
  }

  private emitLog(event: AcpLogEvent): void {
    if (this.onLog) this.onLog(event);
  }

  private handleAcpNotification(method: string, params: any): void {
    if (method === "session/update" && params?.update) {
      this.handleSessionUpdate(params.update);
      return;
    }

    if (method !== "message.part.updated" || !params?.part) return;
    const part = params.part;

    if (part.type === "step-start") {
      this.emitLog({ type: "step_start", text: "开始处理..." });
      return;
    }

    if (part.type === "step-finish") {
      const reason = part.reason || "";
      const tokens = part.tokens;
      const duration = part.time
        ? (part.time.end && part.time.start ? part.time.end - part.time.start : undefined)
        : undefined;
      const tokenInfo = tokens ? ` (${tokens.total || 0} tokens)` : "";
      this.emitLog({
        type: "step_finish",
        text: `步骤完成: ${reason}${tokenInfo}`,
        detail: reason,
        durationMs: duration,
      });
      return;
    }

    if (part.type === "reasoning" && part.text) {
      this.emitLog({ type: "reasoning", text: part.text });
      return;
    }

    if (part.type === "tool" && part.state) {
      const state = part.state;
      const toolName = part.tool || "tool";
      if (state.status === "pending") {
        return;
      }
      if (state.status === "running") {
        const inputDesc = this.describeToolInput(toolName, state.input);
        this.emitLog({ type: "tool_start", tool: toolName, text: inputDesc });
        return;
      }
      if (state.status === "completed") {
        const outputDesc = this.describeToolOutput(toolName, state.output, state.input);
        const duration = state.time?.end && state.time?.start
          ? state.time.end - state.time.start
          : undefined;
        this.emitLog({
          type: "tool_end",
          tool: toolName,
          text: outputDesc,
          durationMs: duration,
        });
        return;
      }
    }

    if (part.type === "text" && part.text) {
      this.promptTextAccumulator += part.text;
      this.emitLog({ type: "text_delta", text: part.text });
    }
  }

  private handleSessionUpdate(update: any): void {
    const updateType = update?.sessionUpdate;
    if (!updateType) return;

    if (updateType === "agent_message_chunk" && update?.content?.type === "text") {
      const chunk = update.content.text || "";
      this.promptTextAccumulator += chunk;
      this.emitLog({ type: "text_delta", text: chunk });
    } else if (updateType === "agent_thought_chunk" && update?.content?.type === "text") {
      this.emitLog({ type: "reasoning", text: update.content.text || "" });
    } else if (updateType === "tool_call" && update?.tool) {
      const toolName = update.tool.name || "tool";
      const inputDesc = this.describeToolInput(toolName, update.tool.input);
      this.emitLog({ type: "tool_start", tool: toolName, text: inputDesc });
    } else if (updateType === "tool_result" && update?.tool) {
      const toolName = update.tool.name || "tool";
      const outputDesc = this.describeToolOutput(toolName, update.tool.output, update.tool.input);
      this.emitLog({ type: "tool_end", tool: toolName, text: outputDesc });
    } else if (updateType === "usage_update") {
      console.debug("[acp] usage:", JSON.stringify(update).slice(0, 200));
    }
  }

  private describeToolInput(tool: string, input: any): string {
    if (!input) return "";
    if (tool === "read" && input.filePath) return input.filePath;
    if (tool === "write" && input.path) return `${input.path} (${(input.content || "").length} bytes)`;
    if (tool === "edit" && input.path) {
      const count = input.edits?.length || 1;
      return `${input.path} (${count}处修改)`;
    }
    if (tool === "bash" && input.command) return input.command.slice(0, 120);
    return JSON.stringify(input).slice(0, 150);
  }

  private describeToolOutput(tool: string, output: any, input: any): string {
    if (!output) return "(无输出)";
    if (typeof output !== "string") return JSON.stringify(output).slice(0, 200);
    if (tool === "read") {
      const lineMatch = output.match(/total (\d+) lines/i) || output.match(/(\d+):/g);
      const lines = (output.match(/\n/g) || []).length;
      const title = input?.filePath ? path.basename(input.filePath) : "";
      return title ? `${title} (${lines}行)` : `读取完成 (${lines}行)`;
    }
    if (tool === "bash") {
      const lines = output.split("\n").length;
      const preview = output.split("\n").slice(-3).join("\n").slice(0, 200);
      return `${lines}行输出\n${preview}`;
    }
    if (tool === "edit") return output.slice(0, 200);
    return output.slice(0, 200);
  }

  private send(msg: JsonRpcRequest | JsonRpcNotification): void {
    if (!this.proc?.stdin?.writable) {
      throw new Error("ACP process not running");
    }
    const data = JSON.stringify(msg) + "\n";
    this.proc.stdin.write(data);
  }

  private request(method: string, params?: Record<string, any>): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.msgId;
      this.pending.set(id, { resolve, reject });
      const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params: params || {} };
      this.send(msg);

      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`ACP request timeout: ${method}`));
        }
      }, 300000);
    });
  }

  private notify(method: string, params?: Record<string, any>): void {
    const msg: JsonRpcNotification = { jsonrpc: "2.0", method, params: params || {} };
    this.send(msg);
  }

  private handleMessage(raw: string): void {
    if (!raw.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        if (msg.error) {
          console.debug("[acp] response error id=", msg.id, JSON.stringify(msg.error).slice(0, 300));
          pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        } else {
          console.debug("[acp] response id=", msg.id, "result keys:", Object.keys(msg.result || {}), "text:", (msg.result?.text || "").length, "stopReason:", msg.result?.stopReason);
          pending.resolve(msg.result);
        }
      }
      return;
    }

    if (msg.method && this.onNotification) {
      this.onNotification(msg.method, msg.params);
    }
  }

  private async initialize(): Promise<any> {
    const result = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: this.opts.clientInfo || {
        name: "pilot-agent",
        title: "Pilot Agent",
        version: "0.1.0",
      },
    });
    console.log("[acp] initialized, agent:", result.agentInfo?.name, result.agentInfo?.version);
    return result;
  }

  private async createSession(): Promise<string> {
    const result = await this.request("session/new", {
      cwd: this.cwd,
      mcpServers: [],
    });
    return result.sessionId;
  }

  async prompt(text: string, images?: { data: string; mimeType: string }[]): Promise<{ stopReason: string; content: string }> {
    this.promptTextAccumulator = "";

    // Create a fresh session per prompt to prevent context accumulation
    this.sessionId = await this.createSession();

    const prompt: any[] = [{ type: "text", text }];
    if (images && images.length > 0) {
      for (const img of images) {
        prompt.push({ type: "image", data: img.data, mimeType: img.mimeType });
      }
    }

    const result = await this.request("session/prompt", {
      sessionId: this.sessionId,
      prompt,
    });

    const responseText = result.text || this.promptTextAccumulator || "";
    console.log("[acp] prompt completed, responseText length:", responseText.length,
      "result.text:", (result.text || "").length,
      "accumulated:", this.promptTextAccumulator.length);

    return {
      stopReason: result.stopReason || "end_turn",
      content: responseText,
    };
  }

  cancel(): void {
    if (this.sessionId) {
      this.notify("session/cancel", { sessionId: this.sessionId });
    }
  }

  respondPermission(requestId: string | number, outcome: "allow" | "deny" | "cancelled"): void {
    const id = ++this.msgId;
    const msg: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method: "session/request_permission",
      params: {
        sessionId: this.sessionId,
        requestId,
        outcome,
      },
    };
    this.send(msg);
  }

  isReady(): boolean {
    return this.initialized && this.proc != null && this.sessionId != null;
  }

  async stop(): Promise<void> {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    if (this.proc) {
      this.proc.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        if (!this.proc) { resolve(); return; }
        const timeout = setTimeout(() => {
          this.proc?.kill("SIGKILL");
          resolve();
        }, 5000);
        this.proc.on("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      this.proc = null;
    }
    this.initialized = false;
    this.sessionId = null;
    this.pending.clear();
    this.onLog = null;
    this.onNotification = null;
  }

  async dispose(): Promise<void> {
    await this.stop();
    this.msgId = 0;
  }
}
