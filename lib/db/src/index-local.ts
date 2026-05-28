/**
 * index-local.ts
 *
 * SQLite database driver for Mizi-Local distribution.
 * Uses Drizzle's better-sqlite3 adapter.
 * Database stored at ~/.mizi/local.db.
 * Migrations run automatically on first boot.
 *
 * This module is selected by the api-server when MIZI_DISTRIBUTION=local.
 */

import { drizzle as drizzleSQLite } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import path from "path";
import os from "os";
import fs from "fs";
import * as schema from "./schema/index.js";

const LOCAL_DB_DIR =
  process.env.MIZI_LOCAL_DB_DIR || path.join(os.homedir(), ".mizi");

const LOCAL_DB_PATH =
  process.env.MIZI_LOCAL_DB_PATH || path.join(LOCAL_DB_DIR, "local.db");

if (!fs.existsSync(LOCAL_DB_DIR)) {
  fs.mkdirSync(LOCAL_DB_DIR, { recursive: true });
  console.log(`[db-local] Created local data directory: ${LOCAL_DB_DIR}`);
}

const sqlite = new Database(LOCAL_DB_PATH);

// Enable WAL mode for better concurrent read performance
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzleSQLite(sqlite, { schema });

// Stub pool for compatibility with code that imports pool
export const pool = {
  end: async () => {},
  connect: async () => { throw new Error("pg pool not available in local SQLite mode"); },
  query: async () => { throw new Error("pg pool not available in local SQLite mode"); },
  on: () => {},
};

export function createPool(_connectionString: string): never {
  throw new Error("createPool is not available in local SQLite mode — use SQLite db directly");
}

export { LOCAL_DB_PATH };

export * from "./schema/index.js";
