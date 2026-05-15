import { z } from "zod";
import WebSocket from "ws";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getBridge, getBridgeStatus } from "../../services/bridge-registry.js";
import { logger } from "../../lib/logger.js";

// Per-lane in-flight exec lock: prevents concurrent bridge_exec calls on the
// same lane from interleaving each other's output frames. Key format: "sessionId:laneId".
const inFlightExecs = new Set<string>();

export function registerBridgeTools(server: McpServer): void {
  server.registerTool("bridge_status", {
    description: "[Read] Check whether a lane's bridge is ready for commands.",
    inputSchema: z.object({
      sessionId: z.number().int().describe("Session ID"),
      laneId: z.number().int().describe("Lane ID"),
    }),
  }, async ({ sessionId, laneId }) => {
    const status = getBridgeStatus(sessionId, laneId);
    return { content: [{ type: "text", text: JSON.stringify({ sessionId, laneId, bridge: status }, null, 2) }] };
  });

  server.registerTool("bridge_exec", {
    description: "[Write] Dispatch a prompt to a running lane bridge and return the response as a single text result. The lane must have an active bridge connection.",
    inputSchema: z.object({
      sessionId: z.number().int().describe("Session ID"),
      laneId: z.number().int().describe("Lane ID"),
      prompt: z.string().describe("Prompt to dispatch to the running agent"),
      timeoutMs: z.number().int().min(1000).max(300000).optional().describe("Response timeout in ms (default: 60000)"),
    }),
  }, async ({ sessionId, laneId, prompt, timeoutMs }) => {
    const bridgeWs = getBridge(sessionId, laneId);
    if (!bridgeWs || bridgeWs.readyState !== WebSocket.OPEN) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Bridge not connected. Check bridge_status first." }) }] };
    }

    // Per-lane execution lock: reject concurrent calls to the same lane to
    // prevent output frame interleaving across simultaneous bridge_exec requests.
    const laneKey = `${sessionId}:${laneId}`;
    if (inFlightExecs.has(laneKey)) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Lane is busy — another bridge_exec is already in progress. Retry after the current exec completes." }) }] };
    }
    inFlightExecs.add(laneKey);

    const ws = bridgeWs;
    const timeout = timeoutMs ?? 60_000;

    try {
      const result = await new Promise<string>((resolve) => {
        const chunks: string[] = [];
        let settled = false;

        const tid = setTimeout(() => {
          if (settled) return;
          settled = true;
          ws.off("message", onMessage);
          resolve(JSON.stringify({ error: "Bridge exec timed out", partialOutput: chunks.join("") }));
        }, timeout);

        function onMessage(raw: import("ws").RawData) {
          let frame: { type: string; [k: string]: unknown };
          try {
            frame = JSON.parse(raw.toString()) as { type: string; [k: string]: unknown };
          } catch {
            return;
          }
          if (frame.type === "output" || frame.type === "chunk") {
            chunks.push(String(frame["text"] ?? frame["content"] ?? ""));
          }
          if (frame.type === "done" || frame.type === "error") {
            if (settled) return;
            settled = true;
            clearTimeout(tid);
            ws.off("message", onMessage);
            resolve(JSON.stringify({ output: chunks.join(""), frame }));
          }
        }

        ws.on("message", onMessage);

        const execMsg = JSON.stringify({ type: "exec", prompt: prompt.trim() });
        ws.send(execMsg, (err) => {
          if (err) {
            if (settled) return;
            settled = true;
            clearTimeout(tid);
            ws.off("message", onMessage);
            logger.error({ err, sessionId, laneId }, "[MCP] bridge_exec send failed");
            resolve(JSON.stringify({ error: "Failed to send command to bridge" }));
          }
        });
      });

      return { content: [{ type: "text", text: result }] };
    } finally {
      inFlightExecs.delete(laneKey);
    }
  });
}
