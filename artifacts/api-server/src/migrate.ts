/**
 * Standalone database migration script.
 *
 * Used as the Fly.io release command:
 *   [deploy]
 *   release_command = "node dist/migrate.mjs"
 *
 * Runs once per deploy, before any app instances start, with full access
 * to production secrets.  Exits 0 on success, 1 on failure (which aborts
 * the deploy so broken schemas never reach production traffic).
 *
 * READ-ONLY ROLE WORKAROUND:
 *   fly postgres attach creates the mizi_api role with
 *   default_transaction_read_only = on at the role/database level.
 *   withReadWrite() appends `-c default_transaction_read_only=off` to
 *   the DATABASE_URL startup options.  Raw pool.connect() calls use
 *   "BEGIN READ WRITE" to force a read-write transaction regardless of
 *   the role or session default.
 *
 * RECOVERY-MODE GUARD:
 *   After a Fly machine restart the Postgres server briefly enters WAL
 *   recovery before becoming the primary.  "BEGIN READ WRITE" is
 *   outright rejected during recovery (PostgreSQL error 0A000).
 *   waitForPrimary() polls pg_is_in_recovery() with a 5-second delay
 *   between attempts and waits up to 90 seconds.  This covers the
 *   post-restart window.  If recovery persists beyond 90 s the script
 *   aborts so that a mis-configured standby never silently skips
 *   migrations.
 *
 * BOOTSTRAP STRATEGY FOR FRESH DATABASES:
 *   The migration journal only tracks a subset of schema changes — the
 *   initial schema was created via `drizzle-kit push` and was never
 *   captured in a migration file.  On a completely empty production DB
 *   the first journal entry (0000_add_lane_claims_active_unique_idx.sql)
 *   fails immediately because lane_claims does not exist yet.
 *
 *   Fix: if we detect an empty DB (lane_claims absent), we:
 *     1. Execute _bootstrap.sql — a full pg_dump of the current dev
 *        schema, with every CREATE converted to IF NOT EXISTS.
 *     2. Mark every migration that appears in _journal.json as already
 *        applied in drizzle.__drizzle_migrations (SHA-256 of file body,
 *        the same hash Drizzle's migrator computes).
 *   This leaves the DB in exactly the state that Drizzle would expect
 *   had all migrations run from scratch, so future deploys use the
 *   normal incremental migrate() path.
 */
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createPool } from "@workspace/db";

const rawUrl = process.env["DATABASE_URL"];
if (!rawUrl) {
  console.error("[migrate] DATABASE_URL is not set — cannot run migrations");
  process.exit(1);
}

/**
 * Append `-c default_transaction_read_only=off` to the PostgreSQL startup
 * options so Drizzle's internal connections open in read-write mode even
 * when the role default is read-only.
 */
function withReadWrite(connectionString: string): string {
  try {
    const u = new URL(connectionString);
    const existing = u.searchParams.get("options") ?? "";
    const flag = "-c default_transaction_read_only=off";
    u.searchParams.set("options", existing ? `${existing} ${flag}` : flag);
    return u.toString();
  } catch {
    console.warn("[migrate] Could not parse DATABASE_URL as a URL — using as-is");
    return connectionString;
  }
}

const pool = createPool(withReadWrite(rawUrl));
const db = drizzle(pool);

/**
 * Wait until the connected Postgres server is the primary (not in
 * recovery).  Polls pg_is_in_recovery() every 5 seconds up to
 * maxWaitMs (default 90 s).  Throws if the server never leaves
 * recovery within the timeout.
 */
async function waitForPrimary(maxWaitMs = 90_000): Promise<void> {
  const start = Date.now();
  let attempt = 0;

  while (true) {
    attempt++;
    const client = await pool.connect();
    let inRecovery: boolean;
    try {
      const res = await client.query<{ r: boolean }>(
        "SELECT pg_is_in_recovery() AS r"
      );
      inRecovery = res.rows[0]?.r ?? true;
    } finally {
      client.release();
    }

    if (!inRecovery) {
      if (attempt > 1) {
        console.log(`[migrate] Primary is ready after ${Math.round((Date.now() - start) / 1000)}s.`);
      }
      return;
    }

    const elapsed = Date.now() - start;
    if (elapsed >= maxWaitMs) {
      throw new Error(
        `[migrate] Postgres server is still in recovery mode after ${Math.round(elapsed / 1000)}s. ` +
        `Ensure DATABASE_URL points to the primary, not a standby replica.`
      );
    }

    console.log(`[migrate] Server in recovery mode (attempt ${attempt}, ${Math.round(elapsed / 1000)}s elapsed) — waiting 5s…`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
  }
}

/** True when the public schema has no user tables (completely fresh DB). */
async function isDatabaseEmpty(): Promise<boolean> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = 'public' AND tablename = 'lane_claims'
       LIMIT 1`
    );
    return res.rows.length === 0;
  } finally {
    client.release();
  }
}

/**
 * Bootstrap a fresh database:
 *   1. Run _bootstrap.sql to create the full current schema.
 *   2. Insert every migration from the journal into the Drizzle
 *      migration-tracking table so future runs skip them.
 */
async function bootstrapFreshDatabase(migrationsFolder: string): Promise<void> {
  const bootstrapPath = path.join(migrationsFolder, "_bootstrap.sql");
  if (!fs.existsSync(bootstrapPath)) {
    throw new Error(
      `[migrate] _bootstrap.sql not found at ${bootstrapPath} — cannot bootstrap empty database`
    );
  }

  console.log("[migrate] Fresh database detected — running bootstrap SQL…");
  const bootstrapSql = fs.readFileSync(bootstrapPath, "utf-8");

  const client = await pool.connect();
  try {
    // BEGIN READ WRITE overrides default_transaction_read_only unconditionally.
    // Only safe to call AFTER waitForPrimary() confirms we're not in recovery.
    await client.query("BEGIN READ WRITE");

    // Previous failed deploys may have left the drizzle tracking schema in a
    // partial state (e.g. Drizzle's own migrator created __drizzle_migrations
    // with its PRIMARY KEY before the actual migration SQL failed).  That leaves
    // an existing PK that conflicts when bootstrap SQL tries to ADD CONSTRAINT.
    // Since we are in the "fresh DB" path (lane_claims absent), no real schema
    // has been applied yet — the drizzle schema is just leftover bookkeeping.
    // Drop and recreate it so bootstrap gets a clean slate.
    await client.query(`
      DROP SCHEMA IF EXISTS drizzle CASCADE;
      CREATE SCHEMA drizzle;
    `);

    // Apply the full schema.  Every CREATE in _bootstrap.sql uses IF NOT EXISTS,
    // and the drizzle schema is now empty so no constraint conflicts occur.
    await client.query(bootstrapSql);

    // Read the journal and mark every listed migration as applied.
    const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
    if (fs.existsSync(journalPath)) {
      const journal = JSON.parse(fs.readFileSync(journalPath, "utf-8")) as {
        entries: Array<{ tag: string; when: number; breakpoints: boolean }>;
      };

      for (const entry of journal.entries) {
        const sqlPath = path.join(migrationsFolder, `${entry.tag}.sql`);
        if (!fs.existsSync(sqlPath)) {
          console.warn(`[migrate] Journal references ${entry.tag}.sql but file is missing — skipping hash insert`);
          continue;
        }
        const sqlContent = fs.readFileSync(sqlPath, "utf-8");
        const hash = crypto.createHash("sha256").update(sqlContent).digest("hex");

        // Only insert if not already present (idempotent).
        await client.query(
          `INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
           SELECT $1, $2
           WHERE NOT EXISTS (
             SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash = $1
           )`,
          [hash, entry.when]
        );
      }
    }

    await client.query("COMMIT");
    console.log("[migrate] Bootstrap complete — all schema objects created and migrations marked applied.");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  // __dirname is injected by the esbuild banner at build time.
  const migrationsFolder = path.join(__dirname, "migrations");

  console.log("[migrate] Starting database migrations…");
  console.log("[migrate] Migrations folder:", migrationsFolder);

  try {
    // Wait until the primary is out of WAL recovery before touching DDL.
    await waitForPrimary();

    if (await isDatabaseEmpty()) {
      await bootstrapFreshDatabase(migrationsFolder);
    } else {
      console.log("[migrate] Existing database detected — running incremental migrations…");
      await migrate(db, { migrationsFolder });
      console.log("[migrate] All migrations applied successfully.");
    }
  } catch (err) {
    console.error("[migrate] Migration failed:", err);
    await pool.end();
    process.exit(1);
  }

  await pool.end();
  process.exit(0);
}

main();
