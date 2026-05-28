#!/usr/bin/env node
/**
 * serve.mjs — Static file server for the Mizi-Local dashboard.
 *
 * Serves the pre-built React app from the dist/public directory adjacent to
 * this file. Used by systemd/launchd service units and by mizi-local-start.sh
 * when the dashboard has been built into a release tarball.
 *
 * Environment variables:
 *   PORT              HTTP port to listen on (default: 3738)
 *   MIZI_DISTRIBUTION Must be "local" (sanity check)
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? "3738", 10);
const DIST_DIR = path.join(__dirname, "dist", "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".ico":  "image/x-icon",
  ".woff2":"font/woff2",
  ".woff": "font/woff",
  ".ttf":  "font/ttf",
  ".txt":  "text/plain",
};

function mimeFor(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": mimeFor(filePath),
      "Cache-Control": path.extname(filePath) === ".html"
        ? "no-cache"
        : "public, max-age=31536000, immutable",
    });
    res.end(data);
  });
}

// Resolved DIST_DIR — used for containment checks so symlinks and relative
// segments in DIST_DIR itself are normalised once at startup.
const RESOLVED_DIST_DIR = path.resolve(DIST_DIR);

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const relPath = decodeURIComponent(url.pathname).replace(/^\/+/, "");

  // Resolve the candidate to an absolute, normalised path so that sequences
  // like "../../etc/passwd" are fully collapsed before the containment check.
  const candidate = path.resolve(RESOLVED_DIST_DIR, relPath);

  // Security: reject any path that escapes the distribution directory.
  // We require the resolved path to start with RESOLVED_DIST_DIR followed by
  // the OS separator so that a file named "dist/public_extra" can never
  // match the prefix "dist/public".
  if (candidate !== RESOLVED_DIST_DIR && !candidate.startsWith(RESOLVED_DIST_DIR + path.sep)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.stat(candidate, (err, stat) => {
    if (!err && stat.isFile()) {
      serveFile(res, candidate);
    } else {
      // SPA fallback — serve index.html for all non-asset routes
      serveFile(res, path.join(RESOLVED_DIST_DIR, "index.html"));
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[mizi-dashboard] Serving ${DIST_DIR} on http://0.0.0.0:${PORT}`);
});

process.on("SIGTERM", () => { server.close(); process.exit(0); });
process.on("SIGINT",  () => { server.close(); process.exit(0); });
