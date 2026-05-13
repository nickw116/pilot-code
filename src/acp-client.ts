import { spawn, type ChildProcess } from "child_process";
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

export class AcpClient {
  private proc: ChildProcess | null = null;
  private msgId = 0;
  private pending = new Map<number, PendingRequest>();
  private buffer = "";
  private sessionId: string | null = null;
  private initialized = false;
  private rl: ReturnType<typeof createInterface> | null = null;
  private onNotification: ((method: string, params: any) => void) | null = null;

  private cwd: string = process.cwd();
  private opts: AcpClientOptions;

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
      if (text) console.debug("[acp] stderr:", text);
    });

    this.proc.on("error", (err) => {
      console.error("[acp] process error:", err.message);
    });

    this.proc.on("exit", (code) => {
      console.log("[acp] process exited with code:", code);
      this.proc = null;
      this.initialized = false;
      this.sessionId = null;
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
      if (externalHandler) {
        externalHandler(method, params);
      }
    };

    await this.initialize();
    this.sessionId = await this.createSession();
    this.initialized = true;
    console.log("[acp] ready, sessionId:", this.sessionId);
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
          pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        } else {
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
        name: "pilot-code",
        title: "Pilot Code",
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
    if (!this.sessionId) throw new Error("No active ACP session");

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

    return {
      stopReason: result.stopReason || "end_turn",
      content: result.text || "",
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
  }
}
