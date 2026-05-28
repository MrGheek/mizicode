/**
 * lib/db/src/index.ts
 *
 * Database adapter gateway.
 *
 * Selects the correct backend at runtime based on MIZI_DISTRIBUTION:
 *   - "local" → SQLite via better-sqlite3 (no DATABASE_URL required)
 *   - anything else → PostgreSQL via pg Pool (requires DATABASE_URL)
 *
 * Uses top-level await (valid in ESM, requires module: esnext + Node ≥ 16).
 * The module finishes loading with the correct `db` / `pool` binding before
 * any consumer code runs — live binding semantics guarantee this.
 */

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema/index.js";

export * from "./schema/index.js";

const IS_LOCAL = process.env.MIZI_DISTRIBUTION === "local";

// `db` is declared as NodePgDatabase so that Drizzle query-builder calls
// (findMany, transaction, inArray, etc.) have their callback parameter types
// inferred from the schema, eliminating the implicit-any errors that arise when
// db is typed as `any`. In local-SQLite mode the runtime value is a
// BetterSQLite3Database, but Drizzle's query-builder interface is structurally
// compatible so all existing call sites work correctly at runtime.
export let db = undefined as unknown as NodePgDatabase<typeof schema>;

// Pool and createPool retain `any` — the pg.Pool type and the SQLite stub share
// only a loose structural overlap, and all raw pool usage is cloud-mode only.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export let pool: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export let createPool: (connectionString: string) => any;

if (IS_LOCAL) {
  // ── SQLite (local distribution) ────────────────────────────────────────────
  // Dynamic import keeps better-sqlite3 out of the cloud bundle entirely.
  const sqlite3Mod = await import("./index-local.js");
  // Cast to NodePgDatabase: Drizzle's query-builder interface is structurally
  // compatible between SQLite and Postgres — Pg-only methods (selectDistinctOn,
  // refreshMaterializedView) are never called in local mode.
  db = sqlite3Mod.db as unknown as NodePgDatabase<typeof schema>;
  pool = sqlite3Mod.pool;
  createPool = sqlite3Mod.createPool;
} else {
  // ── PostgreSQL (cloud / development) ───────────────────────────────────────
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { default: pg } = await import("pg");
  const { Pool } = pg;

  if (!process.env.DATABASE_URL) {
    // Log loudly but do not crash at module-load time.
    // pg.Pool connects lazily — the process can start and serve /api/healthz
    // even before DATABASE_URL is injected as a Fly.io secret on first deploy.
    // All actual DB queries will fail until the secret is set.
    console.error(
      "[db] DATABASE_URL is not set — all database operations will fail. " +
        "Set it with: fly secrets set --app mizi-api DATABASE_URL=<connection-string>",
    );
  }

  const cloudPool = new Pool({ connectionString: process.env.DATABASE_URL });

  /**
   * Force read-write mode on every connection acquired from the pool.
   *
   * The production role (mizi_api) has default_transaction_read_only=on.
   * Drizzle issues a plain BEGIN (not BEGIN READ WRITE), which inherits the
   * role default and makes every INSERT/UPDATE/DELETE fail.
   */
  cloudPool.on("connect", (client) => {
    client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE").catch(
      (err: unknown) => {
        console.error("[db] Failed to set session read-write mode:", err);
      },
    );
  });

  db = drizzle(cloudPool, { schema });
  pool = cloudPool;
  createPool = (connectionString: string) => new Pool({ connectionString });
}
