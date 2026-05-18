import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { loadContext, appendContext } from "./session.js";

/** Approximate token count: 1 token ≈ 4 chars for Chinese/mixed text */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/** Count total tokens in a list of agent messages */
export function countMessageTokens(messages: AgentMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      total += estimateTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if ("text" in block && typeof block.text === "string") {
          total += estimateTokens(block.text);
        }
      }
    }
  }
  return total;
}

const MAX_CONTEXT_TOKENS = 800_000; // leave headroom for 1M window
const KEEP_RECENT_MESSAGES = 4; // always keep last N messages

/** Compress old messages into a single summary message */
function createSummaryMessage(oldMessages: AgentMessage[]): AgentMessage {
  const lines: string[] = ["[ conversation summary ]"];
  for (const msg of oldMessages) {
    const role = msg.role === "user" ? "User" : "Assistant";
    let text = "";
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("");
    }
    if (text) {
      const truncated = text.length > 500 ? text.slice(0, 500) + "..." : text;
      lines.push(`${role}: ${truncated}`);
    }
  }
  return {
    role: "user",
    content: lines.join("\n"),
    timestamp: Date.now(),
  };
}

/**
 * Transform context before each LLM call.
 * If total tokens exceed MAX_CONTEXT_TOKENS, compress older messages.
 * When compaction happens, onCompact callback is invoked with the old messages
 * so callers can save them to persistent memory before they are lost.
 */
export async function compactIfNeeded(
  messages: AgentMessage[],
  onCompact?: (oldMessages: AgentMessage[]) => void
): Promise<AgentMessage[]> {
  const totalTokens = countMessageTokens(messages);

  if (totalTokens < MAX_CONTEXT_TOKENS) {
    return messages;
  }

  console.log(`[compaction] Context ${totalTokens} tokens exceeds ${MAX_CONTEXT_TOKENS}, compacting...`);

  // Keep system message (first if role=system/user with system prompt) + recent messages
  const systemMsgs = messages.slice(0, 1);
  const bodyMsgs = messages.slice(1);

  if (bodyMsgs.length <= KEEP_RECENT_MESSAGES) {
    return messages; // can't compact further
  }

  const cutoff = bodyMsgs.length - KEEP_RECENT_MESSAGES;
  const oldMessages = bodyMsgs.slice(0, cutoff);
  const recentMessages = bodyMsgs.slice(cutoff);

  // Notify caller so it can flush old messages to persistent memory
  if (onCompact) {
    try { onCompact(oldMessages); } catch (err) {
      console.error("[memory] compaction flush callback failed:", err);
    }
  }

  const summary = createSummaryMessage(oldMessages);
  const compacted = [...systemMsgs, summary, ...recentMessages];

  const newTokens = countMessageTokens(compacted);
  console.log(`[compaction] Compacted ${messages.length} -> ${compacted.length} messages, ${totalTokens} -> ${newTokens} tokens`);

  return compacted;
}

/** Check JSONL context size and return whether compaction is recommended */
export function getContextStats(sessionKey: string): {
  messageCount: number;
  estimatedTokens: number;
  needsCompaction: boolean;
} {
  const messages = loadContext(sessionKey);
  const tokens = messages.reduce((sum, m) => sum + estimateTokens(m.content || ""), 0);
  return {
    messageCount: messages.length,
    estimatedTokens: tokens,
    needsCompaction: tokens > MAX_CONTEXT_TOKENS,
  };
}
