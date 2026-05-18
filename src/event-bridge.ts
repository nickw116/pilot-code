import type { AgentEvent } from "@mariozechner/pi-agent-core";
import crypto from "crypto";
import { publish, type SseEvent } from "./sse.js";

/** Translate Pi AgentEvent → H5 frontend SSE events and publish them. */
export function bridgeAndPublish(
  event: AgentEvent,
  runId: string,
  sessionKey: string
): void {
  const events = translate(event, runId, sessionKey);
  for (const e of events) {
    publish(sessionKey, e);
  }
}

function sse(
  kind: string,
  runId: string,
  sessionKey: string,
  payload: Record<string, unknown> = {}
): SseEvent {
  return {
    eventId: `evt-${crypto.randomBytes(4).toString("hex")}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    runId,
    sessionKey,
    payload,
  };
}

let accumulatedText = "";
let accumulatedThinking = "";

function translate(
  event: AgentEvent,
  runId: string,
  sessionKey: string
): SseEvent[] {
  if (event.type === "message_update") {
    const sub = event.assistantMessageEvent;
    if (sub.type === "text_delta" || sub.type === "thinking_delta") {
      console.log(`[bridge] ${sub.type} len=${(sub.delta || "").length} textAcc=${accumulatedText.length} thinkAcc=${accumulatedThinking.length}`);
    }
  }
  switch (event.type) {
    case "agent_start":
      accumulatedText = "";
      accumulatedThinking = "";
      return [sse("run.started", runId, sessionKey)];

    case "message_update": {
      const sub = event.assistantMessageEvent;
      if (sub.type === "text_delta" && sub.delta) {
        accumulatedText += sub.delta;
        return [sse("assistant.delta", runId, sessionKey, { delta: sub.delta })];
      }
      if (sub.type === "thinking_delta" && sub.delta) {
        accumulatedThinking += sub.delta;
        return [sse("assistant.thinking", runId, sessionKey, { delta: sub.delta })];
      }
      if (sub.type === "toolcall_start") {
        const subAny = sub as any;
        return [
          sse("tool_use", runId, sessionKey, {
            name: subAny.toolName || subAny.partial?.toolCalls?.[0]?.name,
            id: subAny.id || subAny.contentIndex,
          }),
        ];
      }
      return [];
    }

    case "tool_execution_start":
      return [
        sse("command.output", runId, sessionKey, {
          text: `▶ ${event.toolName}(${JSON.stringify(event.args).slice(0, 200)})`,
        }),
      ];

    case "tool_execution_end": {
      const resultText =
        typeof event.result?.content === "string"
          ? event.result.content
          : Array.isArray(event.result?.content)
            ? event.result.content
                .map((c: any) => c.text ?? "")
                .join("")
            : JSON.stringify(event.result);
      return [
        sse("tool_result", runId, sessionKey, {
          name: event.toolName,
          output: String(resultText).slice(0, 2000),
          isError: event.isError,
        }),
      ];
    }

    case "agent_end": {
      const done = sse("run.done", runId, sessionKey);
      if (accumulatedText) {
        return [
          sse("full_result", runId, sessionKey, { text: accumulatedText }),
          done,
        ];
      }
      return [done];
    }

    case "message_start":
    case "message_end":
    case "turn_start":
    case "turn_end":
    case "tool_execution_update":
      return [];

    default:
      return [];
  }
}
