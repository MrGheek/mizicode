/**
 * main.ts — Mizi Electron main process
 *
 * Orchestrates the local distribution:
 *   1. On first launch, installs better-sqlite3 native module for system Node
 *   2. Spawns the API server (Node child process, MIZI_DISTRIBUTION=local)
 *   3. Spawns the dashboard static server (serve.mjs)
 *   4. Opens a BrowserWindow pointing at the dashboard
 *   5. Creates a system-tray icon with status and quick-access menu
 *   6. On quit, SIGTERMs both child processes cleanly
 */

import { app, BrowserWindow, Menu, Tray, shell, nativeImage, dialog } from "electron";
import { spawn, execFile, execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import http from "node:http";
import fs from "node:fs";

// ── Constants ─────────────────────────────────────────────────────────────────

const API_PORT       = Number(process.env["MIZI_API_PORT"])       || 4000;
const DASHBOARD_PORT = Number(process.env["MIZI_DASHBOARD_PORT"]) || 3000;
const MIZI_HOME      = process.env["MIZI_HOME"] ?? path.join(process.env["HOME"] ?? "/tmp", ".mizi");
const IS_PACKAGED    = app.isPackaged;

// In production  : resources live in process.resourcesPath (Contents/Resources/)
// In development : run from the monorepo root
const RES = IS_PACKAGED
  ? process.resourcesPath
  : path.join(__dirname, "..", "..", "..");           // monorepo root

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

// ── Find system Node.js ───────────────────────────────────────────────────────

function findNodeBin(): string {
  const candidates = [
    "/opt/homebrew/bin/node",  // Homebrew on Apple Silicon
    "/usr/local/bin/node",     // Homebrew on Intel / nvm
    "/usr/bin/node",           // system package managers
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  try {
    return execFileSync("which", ["node"], { encoding: "utf8" }).trim();
  } catch {
    return "node"; // hope it's on PATH
  }
}

// ── Poll until a port accepts connections ─────────────────────────────────────

function poll(port: number, maxWaitMs = 25_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + maxWaitMs;
    function attempt(): void {
      const req = http.get({ hostname: "127.0.0.1", port, path: "/" }, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() >= deadline) {
          reject(new Error(`Port ${port} not ready after ${maxWaitMs}ms`));
        } else {
          setTimeout(attempt, 600);
        }
      });
      req.setTimeout(1000, () => req.destroy());
    }
    attempt();
  });
}

// ── First-run: install better-sqlite3 for the system Node ABI ────────────────

function setupDependencies(nodeBin: string): Promise<void> {
  const nmDir = path.join(API_DIST_DIR, "node_modules", "better-sqlite3");
  if (fs.existsSync(nmDir)) return Promise.resolve(); // already installed

  return new Promise((resolve, reject) => {
    // Show a non-interactive "setting up" window
    const setupWin = new BrowserWindow({
      width: 460,
      height: 170,
      resizable: false,
      frame: false,
      alwaysOnTop: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    void setupWin.loadURL(
      "data:text/html," +
        encodeURIComponent(
          `<!DOCTYPE html><html><body style="margin:0;background:#111;color:#e5e5e5;
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
            display:flex;flex-direction:column;align-items:center;
            justify-content:center;height:100vh;gap:10px;">
            <p style="font-size:15px;font-weight:500;margin:0">Setting up Mizi…</p>
            <p style="font-size:12px;color:#888;margin:0">Installing local dependencies (one-time)</p>
          </body></html>`
        )
    );

    // Resolve the npm binary next to the discovered node binary
    const npmBin = path.join(path.dirname(nodeBin), "npm");
    const npm    = fs.existsSync(npmBin) ? npmBin : "npm";

    const child = execFile(
      npm,
      ["install", "--save", "better-sqlite3@^12.10.0", "--omit=dev", "--no-audit", "--no-fund"],
      { cwd: API_DIST_DIR, env: { ...process.env, NODE_ENV: "production" } },
      (err) => {
        setupWin.destroy();
        if (err) reject(new Error(`Dependency install failed: ${err.message}`));
        else resolve();
      }
    );
    void child;
  });
}

// ── Spawn background services ─────────────────────────────────────────────────

async function startServices(): Promise<void> {
  const nodeBin = findNodeBin();
  const logsDir = path.join(MIZI_HOME, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(path.join(MIZI_HOME, "workspace"), { recursive: true });

  // First-run setup (packaged only; dev already has node_modules)
  if (IS_PACKAGED) {
    await setupDependencies(nodeBin);
  }

  // API server ────────────────────────────────────────────────────────────────
  if (fs.existsSync(API_DIST)) {
    const apiLog = fs.createWriteStream(path.join(logsDir, "mizi-api.log"), { flags: "a" });
    apiProcess = spawn(nodeBin, [API_DIST], {
      env: {
        ...process.env,
        PORT:                 String(API_PORT),
        MIZI_DISTRIBUTION:    "local",
        MIZI_LOCAL_DB_PATH:   path.join(MIZI_HOME, "local.db"),
        MIZI_LOCAL_WORKSPACE: path.join(MIZI_HOME, "workspace"),
        OLLAMA_BASE_URL:      "http://localhost:11434",
        LOG_LEVEL:            "info",
        NODE_ENV:             "production",
      },
    });
    apiProcess.stdout?.pipe(apiLog);
    apiProcess.stderr?.pipe(apiLog);
    apiProcess.on("exit", (code) => console.log("[mizi] API server exited:", code));
  } else {
    console.warn("[mizi] API dist not found at:", API_DIST);
  }

  // Dashboard static server ───────────────────────────────────────────────────
  if (fs.existsSync(DASHBOARD_SERVE)) {
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
  } else {
    console.warn("[mizi] Dashboard serve.mjs not found at:", DASHBOARD_SERVE);
  }

  // Wait for both services to accept connections (non-fatal on timeout)
  await Promise.all([
    poll(API_PORT).catch((e: Error) => console.warn("[mizi] API poll:", e.message)),
    poll(DASHBOARD_PORT).catch((e: Error) => console.warn("[mizi] Dashboard poll:", e.message)),
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
    if (!url.startsWith(`http://localhost:`)) {
      void shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  mainWindow.on("closed", () => { mainWindow = null; });
}

// ── System tray ───────────────────────────────────────────────────────────────

function createTray(): void {
  // Use a bundled 16×16 PNG if present; fall back to an empty image
  const iconPath = IS_PACKAGED
    ? path.join(process.resourcesPath, "build", "tray-icon.png")
    : path.join(__dirname, "..", "build", "tray-icon.png");

  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    : nativeImage.createEmpty();

  tray = new Tray(icon);
  tray.setToolTip("Mizi – Local AI");

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
    { label: `API         →  localhost:${API_PORT}`,       enabled: false },
    { label: `Dashboard  →  localhost:${DASHBOARD_PORT}`, enabled: false },
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
  try {
    await startServices();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void dialog.showErrorBox("Mizi – Setup Error", `Could not start services:\n\n${msg}\n\nCheck logs at ${path.join(MIZI_HOME, "logs")}`);
  }

  createTray();
  createWindow();

  app.on("activate", () => {
    // Re-open window on dock click (macOS convention)
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
