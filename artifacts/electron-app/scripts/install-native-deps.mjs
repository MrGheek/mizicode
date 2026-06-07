#!/usr/bin/env node
/**
 * install-native-deps.mjs — Build-time step run before electron-builder
 *
 * Installs better-sqlite3 into artifacts/api-server/dist/ using the system
 * Node.js npm, so the native .node binary is compiled for the system Node ABI.
 * The resulting node_modules/ directory is then copied into the app bundle by
 * electron-builder's extraResources configuration.
 *
 * Why system Node, not @electron/rebuild?
 * ────────────────────────────────────────
 * The Mizi API server runs as a system Node.js child process (not inside
 * Electron's bundled Node). Therefore better-sqlite3 must be compiled for the
 * same ABI as system Node, not Electron's internal Node version.
 * @electron/rebuild is reserved for native modules that run *inside* Electron's
 * own process (renderer or main); none of our current main-process code uses
 * native modules, so @electron/rebuild has no work to do here.
 *
 * Usage (called automatically by pnpm build:electron):
 *   node artifacts/electron-app/scripts/install-native-deps.mjs
 */

import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, writeFileSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/ → electron-app/ → artifacts/ → workspace root
const workspaceRoot = path.resolve(__dirname, "..", "..", "..");
const apiDistDir    = path.join(workspaceRoot, "artifacts", "api-server", "dist");

// ── Sanity check ──────────────────────────────────────────────────────────────

if (!existsSync(apiDistDir)) {
  console.error(`[install-native-deps] api-server/dist not found at:\n  ${apiDistDir}`);
  console.error("  Run 'pnpm build:local' before 'pnpm build:electron'.");
  process.exit(1);
}

// ── Skip if already installed ─────────────────────────────────────────────────

const nmDir = path.join(apiDistDir, "node_modules", "better-sqlite3");
if (existsSync(nmDir)) {
  console.log("[install-native-deps] better-sqlite3 already present — skipping.");
  process.exit(0);
}

// ── Write a minimal package.json if none exists ───────────────────────────────
// npm install requires a package.json in the target directory.

const pkgPath = path.join(apiDistDir, "package.json");
if (!existsSync(pkgPath)) {
  writeFileSync(
    pkgPath,
    JSON.stringify({ name: "mizi-local-api", version: "1.0.0", type: "module", private: true }, null, 2)
  );
}

// ── Install ───────────────────────────────────────────────────────────────────

console.log("[install-native-deps] Installing better-sqlite3 into api-server/dist…");
console.log(`  Target: ${apiDistDir}`);

try {
  execSync(
    "npm install --save better-sqlite3@^12.10.0 --omit=dev --no-audit --no-fund",
    { cwd: apiDistDir, stdio: "inherit" }
  );
  console.log("[install-native-deps] Done — native module bundled for system Node ABI.");
} catch (/** @type {any} */ err) {
  console.error("[install-native-deps] ERROR:", err.message ?? err);
  console.error("  Ensure npm and Node.js ≥ 20 are available in the build environment.");
  process.exit(1);
}
