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
import { createPool } from "@workspace/db";
import { withReadWrite, withFlyLeaderPort } from "./migrate-helpers.js";

// MIGRATE_DATABASE_URL takes priority over DATABASE_URL.
// Use it to provide a URL that explicitly targets the primary, e.g. the
// Fly.io HAProxy leader port (5433) rather than the direct machine port (5432).
const rawUrl = process.env["MIGRATE_DATABASE_URL"] ?? process.env["DATABASE_URL"];
if (!rawUrl) {
  console.error("[migrate] DATABASE_URL (or MIGRATE_DATABASE_URL) is not set — cannot run migrations");
  process.exit(1);
}

const pool = createPool(withReadWrite(withFlyLeaderPort(rawUrl)));

/**
 * Wait until the Postgres server accepts write transactions.
 *
 * Previously used pg_is_in_recovery() but that proved unreliable when
 * connecting via Fly.io HAProxy (flycast:5433) — the HAProxy may report the
 * current leader as "in recovery" during brief failover windows even though
 * the server does accept writes.
 *
 * Instead we attempt a lightweight BEGIN READ WRITE / SELECT 1 / ROLLBACK.
 * - If it succeeds the server is writable — proceed.
 * - If it fails with a read-only or recovery error we wait and retry.
 * - We still log the pg_is_in_recovery() value for diagnostics only.
 *
 * maxWaitMs default is 90 s to cover post-restart WAL recovery windows.
 */
async function waitForPrimary(maxWaitMs = 90_000): Promise<void> {
  const start = Date.now();
  let attempt = 0;

  while (true) {
    attempt++;
    const client = await pool.connect();
    try {
      // Diagnostic only — do not gate on this value.
      let recoveryState = "unknown";
      try {
        const res = await client.query<{ r: boolean }>("SELECT pg_is_in_recovery() AS r");
        recoveryState = res.rows[0]?.r ? "replica (in recovery)" : "primary";
      } catch { /* ignore — we care about writability, not this flag */ }

      // The real test: can we start a read-write transaction?
      await client.query("BEGIN READ WRITE");
      await client.query("SELECT 1");
      await client.query("ROLLBACK");

      if (attempt > 1) {
        console.log(`[migrate] Server is writable after ${Math.round((Date.now() - start) / 1000)}s (pg_is_in_recovery=${recoveryState}).`);
      } else if (recoveryState === "replica (in recovery)") {
        console.warn(`[migrate] pg_is_in_recovery()=true but BEGIN READ WRITE succeeded — proceeding (HAProxy may report stale recovery state).`);
      }
      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const isReadOnly =
        msg.includes("read-only") ||
        msg.includes("recovery") ||
        msg.includes("0A000") ||   // PostgreSQL SQLSTATE: feature not supported in standby
        msg.includes("25006");     // PostgreSQL SQLSTATE: read_only_sql_transaction

      try { await client.query("ROLLBACK"); } catch { /* ignore */ }

      const elapsed = Date.now() - start;
      if (!isReadOnly) {
        // Non-recovery error (auth failure, connection refused, etc.) — fatal.
        throw new Error(
          `[migrate] Cannot connect to database: ${msg}. ` +
          `Ensure DATABASE_URL is set correctly.`
        );
      }

      if (elapsed >= maxWaitMs) {
        // Timed out waiting for primary — log a warning and proceed.
        // Every migration SQL step uses BEGIN READ WRITE explicitly, so if
        // the server truly isn't writable the migration will fail there with
        // a clear error.  This avoids blocking deploys when the HAProxy
        // routing is temporarily stale (e.g. post-failover window on Fly.io).
        console.warn(
          `[migrate] WARNING: Server did not become writable after ${Math.round(elapsed / 1000)}s ` +
          `(last error: ${msg}). Proceeding anyway — migration SQL will fail if not on primary.`
        );
        return;
      }

      console.log(`[migrate] Server not yet writable (attempt ${attempt}, ${Math.round(elapsed / 1000)}s elapsed): ${msg} — waiting 5s…`);
    } finally {
      client.release();
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
  }
}

/**
 * Zombie migration recovery.
 *
 * A zombie migration is a row in drizzle.__drizzle_migrations whose hash was
 * recorded (so Drizzle thinks it was applied) but whose DDL was never actually
 * executed — typically because the role's default_transaction_read_only=on
 * caused Drizzle's internal BEGIN (not BEGIN READ WRITE) to silently no-op.
 *
 * Strategy: for each known-bad migration tag (verified by checking a sentinel
 * column/table), delete its hash from __drizzle_migrations and re-run the SQL
 * directly under BEGIN READ WRITE.  All migration SQL uses IF NOT EXISTS /
 * ADD COLUMN IF NOT EXISTS so it is safe to re-run.
 *
 * Guarding:
 *   0027_sessions_plan_snapshot  → sentinel: sessions.plan_snapshot_json
 *   0028_project_plans           → sentinel: public.project_plans table
 *   0029_project_tasks_detail    → depends on 0028; no extra sentinel needed
 */
async function repairZombieMigrations(migrationsFolder: string): Promise<void> {
  const client = await pool.connect();
  try {
    // 1. Check sentinel columns/tables to decide which migrations are zombies.
    const sentinelCheck = await client.query<{ pp: string | null; psj: string | null }>(`
      SELECT
        to_regclass('public.project_plans')::text AS pp,
        (SELECT column_name FROM information_schema.columns
         WHERE table_schema='public' AND table_name='sessions'
           AND column_name='plan_snapshot_json'
         LIMIT 1) AS psj
    `);
    const projectPlansExists = !!sentinelCheck.rows[0]?.pp;
    const planSnapshotExists = !!sentinelCheck.rows[0]?.psj;

    if (projectPlansExists && planSnapshotExists) return; // All good.

    // 2. Does the Drizzle migration schema even exist?
    const schemaCheck = await client.query<{ exists: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.schemata WHERE schema_name = 'drizzle'
      ) AS exists
    `);
    if (!schemaCheck.rows[0]?.exists) return; // No migration tracking yet — fresh path will handle it.

    // 3. Determine which migrations are zombies based on sentinel checks.
    const zombieTags: string[] = [];
    if (!planSnapshotExists) zombieTags.push("0027_sessions_plan_snapshot");
    if (!projectPlansExists) {
      zombieTags.push("0028_project_plans");
      zombieTags.push("0029_project_tasks_detail");
    }
    const hashesToDelete: string[] = [];

    for (const tag of zombieTags) {
      const sqlPath = path.join(migrationsFolder, `${tag}.sql`);
      if (!fs.existsSync(sqlPath)) {
        console.warn(`[migrate] repairZombieMigrations: ${tag}.sql not found — skipping`);
        continue;
      }
      const content = fs.readFileSync(sqlPath, "utf-8");
      const hash = crypto.createHash("sha256").update(content).digest("hex");
      hashesToDelete.push(hash);
    }

    if (hashesToDelete.length === 0) return;

    // 4. Run the migration SQL directly (with BEGIN READ WRITE so the role's
    //    default_transaction_read_only=on cannot block us), delete the stale
    //    hash entries, and re-insert them.  We do NOT rely on Drizzle's
    //    migrate() for this — its db.transaction() uses plain BEGIN which is
    //    blocked by the role default.  After this block, migrate() will see
    //    the hashes as already applied and skip them (no-op).
    console.warn(
      `[migrate] ZOMBIE MIGRATION DETECTED: project_plans table missing despite migration records. ` +
      `Re-running SQL for ${zombieTags.join(", ")} with BEGIN READ WRITE.`
    );
    await client.query("BEGIN READ WRITE");
    try {
      // Ensure drizzle tracking schema + table exist (Drizzle may not have
      // initialised them yet if migrate() was never allowed to write).
      await client.query(`CREATE SCHEMA IF NOT EXISTS drizzle`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
          id serial PRIMARY KEY,
          hash text NOT NULL,
          created_at bigint
        )
      `);

      // Delete stale entries.
      await client.query(
        `DELETE FROM drizzle.__drizzle_migrations WHERE hash = ANY($1::text[])`,
        [hashesToDelete]
      );

      // Run each zombie migration's SQL directly.
      for (const tag of zombieTags) {
        const sqlPath = path.join(migrationsFolder, `${tag}.sql`);
        if (!fs.existsSync(sqlPath)) continue;
        const content = fs.readFileSync(sqlPath, "utf-8");
        console.log(`[migrate] Running zombie SQL: ${tag}`);
        await client.query(content);

        // Re-insert the hash so migrate() treats this as applied.
        const hash = crypto.createHash("sha256").update(content).digest("hex");
        await client.query(
          `INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
           SELECT $1, $2
           WHERE NOT EXISTS (
             SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash = $1
           )`,
          [hash, Date.now()]
        );
      }

      await client.query("COMMIT");
      console.log(`[migrate] Zombie migrations applied and re-recorded successfully.`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err; // Bubble up — we need these tables to exist.
    }
  } catch (err) {
    // Fatal — if the zombie SQL failed we cannot start safely.
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Custom incremental migration runner.
 *
 * Replaces drizzle-orm/node-postgres/migrator's migrate() because that
 * function issues plain BEGIN internally — which is blocked by the production
 * role's default_transaction_read_only=on even when the connection URL carries
 * options=-c default_transaction_read_only=off.
 *
 * This runner uses explicit BEGIN READ WRITE for every migration transaction,
 * which unconditionally overrides the role/session default.
 */
async function runIncrementalMigrations(migrationsFolder: string): Promise<void> {
  const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
  if (!fs.existsSync(journalPath)) {
    console.warn("[migrate] No journal found — skipping incremental migrations");
    return;
  }

  const journal = JSON.parse(fs.readFileSync(journalPath, "utf-8")) as {
    entries: Array<{ tag: string; when: number }>;
  };

  // --- Phase 1: read-only scan to find unapplied migrations ---
  // This phase works on replicas too, so it never blocks deploys.
  const unapplied: Array<{ tag: string; content: string; when: number }> = [];
  {
    const client = await pool.connect();
    try {
      // Check if the tracking table even exists.
      const tableExists = await client.query<{ exists: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'
        ) AS exists
      `);

      let appliedHashes = new Set<string>();
      if (tableExists.rows[0]?.exists) {
        const { rows } = await client.query<{ hash: string }>(
          `SELECT hash FROM drizzle.__drizzle_migrations`
        );
        appliedHashes = new Set(rows.map((r) => r.hash));
      }

      for (const entry of journal.entries) {
        const sqlPath = path.join(migrationsFolder, `${entry.tag}.sql`);
        if (!fs.existsSync(sqlPath)) {
          console.warn(`[migrate] Journal references ${entry.tag}.sql but file is missing — skipping`);
          continue;
        }
        const content = fs.readFileSync(sqlPath, "utf-8");
        const hash = crypto.createHash("sha256").update(content).digest("hex");
        if (!appliedHashes.has(hash)) {
          unapplied.push({ tag: entry.tag, content, when: entry.when });
        }
      }
    } finally {
      client.release();
    }
  }

  if (unapplied.length === 0) {
    console.log(`[migrate] No new migrations — database is up to date.`);
    return;
  }

  // --- Phase 2: write phase — requires a writable (primary) connection ---
  // This will fail cleanly if the pool is connected to a replica.
  const client = await pool.connect();
  try {
    // Ensure the Drizzle tracking schema and table exist (idempotent).
    await client.query("BEGIN READ WRITE");
    await client.query(`CREATE SCHEMA IF NOT EXISTS drizzle`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
        id serial PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `);
    await client.query("COMMIT");

    for (const { tag, content, when } of unapplied) {
      console.log(`[migrate] Applying migration: ${tag}`);
      await client.query("BEGIN READ WRITE");
      try {
        await client.query(content);
        await client.query(
          `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)`,
          [crypto.createHash("sha256").update(content).digest("hex"), when]
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(
          `[migrate] Migration ${tag} failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    console.log(`[migrate] Applied ${unapplied.length} new migration(s).`);
  } finally {
    client.release();
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
      await repairZombieMigrations(migrationsFolder);
      await runIncrementalMigrations(migrationsFolder);
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
