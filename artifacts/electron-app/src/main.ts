/**
 * main.ts — Mizi Electron main process
 *
 * Boot sequence:
 *   1. Verify system Node.js ≥ 20 is present (required for API server child process)
 *   2. Ensure Ollama is running: start it if installed-but-idle, warn if missing
 *   3. Spawn the API server as a Node.js child process (MIZI_DISTRIBUTION=local)
 *   4. Spawn the dashboard static server
 *   5. Open a BrowserWindow pointing at the dashboard
 *   6. Create a system-tray icon with status and quick-access menu
 *   7. On quit, SIGTERM both child processes cleanly
 *
 * Native dependencies (better-sqlite3) are pre-installed into api-server/dist/
 * at build time via scripts/install-native-deps.mjs — no network access needed
 * at runtime. The Node.js child process uses the same system Node ABI that was
 * used during packaging, so the pre-built .node binary loads without recompilation.
 */

import { app, BrowserWindow, Menu, Tray, shell, nativeImage, dialog } from "electron";
import { spawn, execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import http from "node:http";
import fs from "node:fs";

// ── Constants ─────────────────────────────────────────────────────────────────

const API_PORT       = Number(process.env["MIZI_API_PORT"])       || 4000;
const DASHBOARD_PORT = Number(process.env["MIZI_DASHBOARD_PORT"]) || 3000;
const OLLAMA_PORT    = 11434;
const MIZI_HOME      = process.env["MIZI_HOME"] ?? path.join(process.env["HOME"] ?? "/tmp", ".mizi");
const IS_PACKAGED    = app.isPackaged;

// process.resourcesPath is set by Electron only in packaged builds.
// In dev we point at the monorepo root (three directories up from dist/main.js).
const RES = IS_PACKAGED
  ? process.resourcesPath
  : path.join(__dirname, "..", "..", "..");

const API_DIST_DIR = IS_PACKAGED
  ? path.join(RES, "api-server", "dist")
  : path.join(RES, "artifacts", "api-server", "dist");

const API_DIST = path.join(API_DIST_DIR, "index.mjs");

const DASHBOARD_SERVE = IS_PACKAGED
  ? path.join(RES, "dashboard", "serve.mjs")
  : path.join(RES, "artifacts", "dashboard", "serve.mjs");

// ── Child-process handles ─────────────────────────────────────────────────────

let apiProcess:       ChildProcess | null = null;
let dashboardProcess: ChildProcess | null = null;
let tray:             Tray         | null = null;
let mainWindow:       BrowserWindow | null = null;

// ── Utility: one-shot HTTP probe ──────────────────────────────────────────────

function probeTcp(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ hostname: "127.0.0.1", port, path: "/" }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(800, () => { req.destroy(); resolve(false); });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll a port until it responds or the deadline passes. */
async function pollUntilReady(port: number, maxWaitMs = 25_000): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (await probeTcp(port)) return true;
    await sleep(600);
  }
  return false;
}

// ── System Node.js discovery ──────────────────────────────────────────────────

/**
 * Returns the path to system Node.js ≥ 20, or shows an error dialog and
 * returns null if Node is absent or too old.
 *
 * Note: Electron bundles its own Node.js, but the API server (which uses the
 * better-sqlite3 native module) must run in the *same* Node.js ABI that was
 * used when better-sqlite3 was compiled at packaging time. We therefore spawn
 * the API server as a system Node child process, not inside Electron's process.
 */
function findNodeBin(): string | null {
  const candidates = [
    "/opt/homebrew/bin/node",   // Homebrew on Apple Silicon
    "/usr/local/bin/node",      // Homebrew on Intel / nvm default
    "/usr/bin/node",            // System package managers
  ];

  let nodeBin: string | null = null;
  for (const c of candidates) {
    if (fs.existsSync(c)) { nodeBin = c; break; }
  }
  if (!nodeBin) {
    try { nodeBin = execFileSync("which", ["node"], { encoding: "utf8" }).trim(); }
    catch { /* not on PATH */ }
  }

  if (!nodeBin) {
    dialog.showMessageBoxSync({
      type: "error",
      title: "Node.js Not Found",
      message: "Mizi requires Node.js ≥ 20 to run the local AI server.",
      detail:
        "Please install Node.js from https://nodejs.org (LTS recommended), " +
        "then relaunch Mizi.\n\nIf you installed Node.js via Homebrew, make " +
        "sure /opt/homebrew/bin is in your PATH.",
      buttons: ["Open nodejs.org", "Quit"],
    });
    void shell.openExternal("https://nodejs.org");
    app.quit();
    return null;
  }

  // Verify version ≥ 20
  try {
    const raw = execFileSync(nodeBin, ["--version"], { encoding: "utf8" }).trim(); // e.g. "v22.3.0"
    const major = parseInt(raw.replace(/^v/, "").split(".")[0] ?? "0", 10);
    if (major < 20) {
      dialog.showMessageBoxSync({
        type: "error",
        title: "Node.js Too Old",
        message: `Mizi requires Node.js ≥ 20 but found ${raw}.`,
        detail: "Please upgrade Node.js from https://nodejs.org, then relaunch Mizi.",
        buttons: ["Open nodejs.org", "Quit"],
      });
      void shell.openExternal("https://nodejs.org");
      app.quit();
      return null;
    }
  } catch { /* version check failed — proceed anyway */ }

  return nodeBin;
}

// ── Ollama lifecycle ───────────────────────────────────────────────────────────

function findOllamaBin(): string | null {
  const candidates = [
    "/opt/homebrew/bin/ollama",
    "/usr/local/bin/ollama",
    "/usr/bin/ollama",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  try { return execFileSync("which", ["ollama"], { encoding: "utf8" }).trim(); }
  catch { return null; }
}

/**
 * Ensure Ollama is running before services start. Mirrors the logic in
 * mizi-local-start.sh (lines 117–209) adapted for an Electron context:
 *
 *  1. Already responding → "running"
 *  2. Binary found, idle → spawn "ollama serve", wait up to 15s → "started"
 *  3. Binary not found   → show warning dialog with download link → "missing"
 *  4. Spawn succeeded but timed out → "timeout" (non-fatal; API server retries)
 */
async function ensureOllama(): Promise<"running" | "started" | "missing" | "timeout"> {
  // 1. Already up?
  if (await probeTcp(OLLAMA_PORT)) return "running";

  // 2. Find the binary
  const ollamaBin = findOllamaBin();
  if (!ollamaBin) {
    const choice = dialog.showMessageBoxSync({
      type: "warning",
      title: "Ollama Not Installed",
      message: "Ollama was not found on this machine.",
      detail:
        "Mizi uses Ollama to run AI models locally. Without it, AI inference " +
        "will not work.\n\nInstall Ollama from ollama.com and relaunch Mizi, or " +
        "click 'Continue' to open the dashboard without AI support.",
      buttons: ["Download Ollama", "Continue Anyway"],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice === 0) void shell.openExternal("https://ollama.com/download/mac");
    return "missing";
  }

  // 3. Ollama installed but not running — start it
  console.log("[mizi] Starting Ollama…");
  const ollamaLog = fs.createWriteStream(
    path.join(MIZI_HOME, "logs", "mizi-ollama.log"),
    { flags: "a" }
  );
  const ollamaProc = spawn(ollamaBin, ["serve"], {
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  ollamaProc.stdout?.pipe(ollamaLog);
  ollamaProc.stderr?.pipe(ollamaLog);

  // 4. Wait up to 15s for Ollama to accept connections
  const ready = await pollUntilReady(OLLAMA_PORT, 15_000);
  if (!ready) {
    console.warn("[mizi] Ollama did not start within 15s");
    return "timeout";
  }

  console.log("[mizi] Ollama started");
  return "started";
}

// ── Spawn background services ─────────────────────────────────────────────────

async function startServices(nodeBin: string): Promise<void> {
  const logsDir = path.join(MIZI_HOME, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(path.join(MIZI_HOME, "workspace"), { recursive: true });

  // API server ────────────────────────────────────────────────────────────────
  if (!fs.existsSync(API_DIST)) {
    console.warn("[mizi] API dist not found at:", API_DIST);
  } else {
    const apiLog = fs.createWriteStream(path.join(logsDir, "mizi-api.log"), { flags: "a" });
    apiProcess = spawn(nodeBin, [API_DIST], {
      env: {
        ...process.env,
        PORT:                 String(API_PORT),
        MIZI_DISTRIBUTION:    "local",
        MIZI_LOCAL_DB_PATH:   path.join(MIZI_HOME, "local.db"),
        MIZI_LOCAL_WORKSPACE: path.join(MIZI_HOME, "workspace"),
        OLLAMA_BASE_URL:      `http://localhost:${OLLAMA_PORT}`,
        LOG_LEVEL:            "info",
        NODE_ENV:             "production",
      },
    });
    apiProcess.stdout?.pipe(apiLog);
    apiProcess.stderr?.pipe(apiLog);
    apiProcess.on("exit", (code) => console.log("[mizi] API server exited:", code));
  }

  // Dashboard static server ───────────────────────────────────────────────────
  if (!fs.existsSync(DASHBOARD_SERVE)) {
    console.warn("[mizi] Dashboard serve.mjs not found at:", DASHBOARD_SERVE);
  } else {
    const dashLog = fs.createWriteStream(path.join(logsDir, "mizi-dashboard.log"), { flags: "a" });
    dashboardProcess = spawn(nodeBin, [DASHBOARD_SERVE], {
      env: {
        ...process.env,
        PORT:              String(DASHBOARD_PORT),
        MIZI_DISTRIBUTION: "local",
        NODE_ENV:          "production",
      },
    });
    dashboardProcess.stdout?.pipe(dashLog);
    dashboardProcess.stderr?.pipe(dashLog);
    dashboardProcess.on("exit", (code) => console.log("[mizi] Dashboard exited:", code));
  }

  // Wait for both services (non-fatal on timeout)
  await Promise.all([
    pollUntilReady(API_PORT).then((ok) => { if (!ok) console.warn("[mizi] API timed out"); }),
    pollUntilReady(DASHBOARD_PORT).then((ok) => { if (!ok) console.warn("[mizi] Dashboard timed out"); }),
  ]);
}

// ── Teardown ──────────────────────────────────────────────────────────────────

function stopServices(): void {
  for (const proc of [apiProcess, dashboardProcess]) {
    try { if (proc && !proc.killed) proc.kill("SIGTERM"); } catch { /* ignore */ }
  }
  apiProcess       = null;
  dashboardProcess = null;
}

// ── Browser window ────────────────────────────────────────────────────────────

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width:  1280,
    height: 820,
    title:  "Mizi",
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
    },
  });

  void mainWindow.loadURL(`http://localhost:${DASHBOARD_PORT}`);

  // External links open in the default browser, not in Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith("http://localhost:")) {
      void shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  mainWindow.on("closed", () => { mainWindow = null; });
}

// ── System tray ───────────────────────────────────────────────────────────────

function createTray(ollamaStatus: string): void {
  const iconPath = IS_PACKAGED
    ? path.join(process.resourcesPath, "build", "tray-icon.png")
    : path.join(__dirname, "..", "build", "tray-icon.png");

  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    : nativeImage.createEmpty();

  tray = new Tray(icon);
  tray.setToolTip("Mizi – Local AI");

  const ollamaLabel = ollamaStatus === "running" || ollamaStatus === "started"
    ? `Ollama: running  ✓`
    : `Ollama: ${ollamaStatus} ⚠`;

  const menu = Menu.buildFromTemplate([
    {
      label: "Open Dashboard",
      click: () => { if (mainWindow) mainWindow.focus(); else createWindow(); },
    },
    {
      label: "Open in Browser",
      click: () => void shell.openExternal(`http://localhost:${DASHBOARD_PORT}`),
    },
    { type: "separator" },
    { label: `API        →  localhost:${API_PORT}`,       enabled: false },
    { label: `Dashboard →  localhost:${DASHBOARD_PORT}`, enabled: false },
    { label: ollamaLabel,                                 enabled: false },
    { type: "separator" },
    { label: "View Logs",
      click: () => void shell.openPath(path.join(MIZI_HOME, "logs")) },
    { type: "separator" },
    { label: "Quit Mizi", role: "quit" },
  ]);

  tray.setContextMenu(menu);
  tray.on("double-click", () => { if (mainWindow) mainWindow.focus(); else createWindow(); });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

// On macOS, keep the process alive when all windows close (lives in the tray)
app.on("window-all-closed", () => { /* intentionally empty */ });

app.on("before-quit", stopServices);

void app.whenReady().then(async () => {
  // Step 1 — Verify system Node.js
  const nodeBin = findNodeBin();
  if (!nodeBin) return; // findNodeBin() already called app.quit()

  // Step 2 — Ensure Ollama lifecycle
  let ollamaStatus = "unknown";
  try {
    ollamaStatus = await ensureOllama();
  } catch (err) {
    console.warn("[mizi] Ollama check failed:", err);
  }

  // Step 3 — Start API + dashboard
  try {
    await startServices(nodeBin);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void dialog.showErrorBox(
      "Mizi – Service Error",
      `Could not start services:\n\n${msg}\n\nSee logs at ${path.join(MIZI_HOME, "logs")}`
    );
  }

  // Step 4 — UI
  createTray(ollamaStatus);
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
