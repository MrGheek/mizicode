#!/usr/bin/env node
/**
 * claw-bridge — outbound WebSocket bridge client for MIZI instances
 *
 * Opens a persistent connection to wss://<api-host>/api/bridge/:sessionId/:laneId
 * and listens for { type: "exec", prompt } messages.  When one arrives it runs
 * `claw prompt "<text>"` as a subprocess, captures stdout line-by-line, and
 * streams structured JSON frames back over the same WebSocket:
 *
 *   { type: "observation", text: "..." }   — tool output / intermediate lines
 *   { type: "done",        result: "..." } — final assistant reply
 *   { type: "error",       message: "..." } — subprocess error
 *
 * Reconnects with exponential backoff (1 s → 2 → 4 → … capped at 60 s) if the
 * socket drops.  A single exec runs at a time; concurrent exec frames are queued
 * rather than dropped (queue length = 1, extras are rejected with an error frame).
 *
 * Uses Node 22's built-in global WebSocket (no external dependencies).
 * Requires Node >= 22.4.0 (WebSocket unflagged in that release).
 *
 * Required env vars:
 *   MIZI_BRIDGE_URL    wss://…/api/bridge/:sessionId/:laneId
 *   MIZI_MEM_TOKEN     bearer token (same as used elsewhere in onstart.sh)
 *
 * Optional env vars:
 *   CLAW_BIN           path to the claw binary (default: claw)
 *   BRIDGE_MAX_BACKOFF maximum reconnect delay in seconds (default: 60)
 *   BRIDGE_LOG_FILE    path to log file (default: /var/log/claw-bridge.log)
 */

import { createWriteStream } from "fs";
import { spawn } from "child_process";
import { URL } from "url";

// ─── Config ───────────────────────────────────────────────────────────────────

const BRIDGE_URL   = process.env["MIZI_BRIDGE_URL"]    ?? "";
const MEM_TOKEN    = process.env["MIZI_MEM_TOKEN"]     ?? "";
const CLAW_BIN     = process.env["CLAW_BIN"]           ?? "claw";
const MAX_BACKOFF  = parseInt(process.env["BRIDGE_MAX_BACKOFF"] ?? "60", 10) * 1000;
const LOG_FILE     = process.env["BRIDGE_LOG_FILE"]    ?? "/var/log/claw-bridge.log";

if (!BRIDGE_URL) {
  process.stderr.write("claw-bridge: MIZI_BRIDGE_URL is not set — exiting\n");
  process.exit(0); // non-fatal: bridge feature is optional
}

// ─── Logging ─────────────────────────────────────────────────────────────────

const logStream = createWriteStream(LOG_FILE, { flags: "a" });

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  logStream.write(line);
}

// ─── State ────────────────────────────────────────────────────────────────────

let ws = null;
let execRunning = false;
let reconnectDelay = 1000;
let reconnectTimer = null;
let stopping = false;

// ─── WebSocket helpers ────────────────────────────────────────────────────────

function buildUrl() {
  // Token is sent as a query param — the built-in WHATWG WebSocket API does
  // not support custom HTTP headers, so the server's ?token= path is used.
  const u = new URL(BRIDGE_URL);
  if (MEM_TOKEN) u.searchParams.set("token", MEM_TOKEN);
  return u.toString();
}

function send(frame) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(frame));
  }
}

// ─── Exec handler ─────────────────────────────────────────────────────────────

function runExec(prompt) {
  if (execRunning) {
    send({ type: "error", message: "A claw exec is already in progress on this lane" });
    return;
  }
  execRunning = true;
  log(`exec: running claw prompt (${prompt.length} chars)`);

  const child = spawn(CLAW_BIN, ["prompt", prompt], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  let outputBuf = "";

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    outputBuf += text;
    // Stream each non-empty line as an observation frame
    const lines = text.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) send({ type: "observation", text: trimmed });
    }
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (text) send({ type: "observation", text: `[stderr] ${text}` });
  });

  child.on("error", (err) => {
    log(`exec: claw spawn error — ${err.message}`);
    send({ type: "error", message: `Failed to spawn claw: ${err.message}` });
    execRunning = false;
  });

  child.on("close", (code) => {
    log(`exec: claw exited with code ${code}`);
    if (code === 0) {
      send({ type: "done", result: outputBuf.trim() });
    } else {
      send({ type: "error", message: `claw exited with code ${code}` });
    }
    execRunning = false;
  });
}

// ─── Connection management ────────────────────────────────────────────────────

function connect() {
  if (stopping) return;

  const url = buildUrl();
  log(`Connecting to bridge at ${BRIDGE_URL}`);

  // Uses Node 22's built-in global WebSocket (WHATWG API) — no npm package needed.
  ws = new WebSocket(url);

  ws.onopen = () => {
    log("Bridge connected");
    reconnectDelay = 1000; // reset backoff on successful connection
  };

  ws.onmessage = (event) => {
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      log(`Received non-JSON message: ${event.data}`);
      return;
    }

    if (frame.type === "exec" && typeof frame.prompt === "string") {
      runExec(frame.prompt);
    } else if (frame.type === "registered") {
      log(`Registration confirmed: session=${frame.sessionId} lane=${frame.laneId}`);
    } else {
      log(`Unknown frame type: ${frame.type}`);
    }
  };

  ws.onclose = (event) => {
    log(`Bridge disconnected (code=${event.code} reason=${event.reason})`);
    ws = null;
    scheduleReconnect();
  };

  ws.onerror = (event) => {
    log(`Bridge error: ${event.message ?? "unknown"}`);
    // onclose will fire after onerror, triggering reconnect
  };
}

function scheduleReconnect() {
  if (stopping || reconnectTimer) return;
  log(`Reconnecting in ${reconnectDelay / 1000}s...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  // Exponential backoff with jitter, capped at MAX_BACKOFF
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_BACKOFF);
  reconnectDelay += Math.floor(Math.random() * 500); // ±500 ms jitter
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

process.on("SIGTERM", () => {
  log("SIGTERM received — shutting down bridge");
  stopping = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) ws.close(1000, "Shutdown");
  process.exit(0);
});

process.on("SIGINT", () => {
  log("SIGINT received — shutting down bridge");
  stopping = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) ws.close(1000, "Shutdown");
  process.exit(0);
});

// ─── Start ────────────────────────────────────────────────────────────────────

log(`claw-bridge starting (claw=${CLAW_BIN} url=${BRIDGE_URL})`);
connect();
