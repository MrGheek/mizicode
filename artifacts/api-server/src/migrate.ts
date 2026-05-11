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
 * WHY a custom pool instead of @workspace/db's shared pool:
 *   fly postgres attach creates the mizi_api role with
 *   default_transaction_read_only = on at the role/database level.
 *   Drizzle's migrator opens a transaction and immediately tries
 *   CREATE SCHEMA "drizzle", which Postgres rejects with error 25006
 *   ("cannot execute CREATE SCHEMA in a read-only transaction").
 *   Passing `-c default_transaction_read_only=off` in the PostgreSQL
 *   startup options overrides the role default for every connection
 *   this pool opens, allowing DDL statements to execute.
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
 * options so DDL runs even when the role/database default is read-only.
 * pg-connection-string forwards the `options` query param verbatim in the
 * startup message, where PostgreSQL treats it like `psql -c "SET ..."`.
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
    await client.query("BEGIN");

    // Apply the full schema (every statement has IF NOT EXISTS so this is safe).
    await client.query(bootstrapSql);

    // Make sure the Drizzle journal table has the proper primary-key default.
    await client.query(`
      ALTER TABLE drizzle.__drizzle_migrations
        ALTER COLUMN id SET DEFAULT nextval('drizzle.__drizzle_migrations_id_seq'::regclass)
    `);

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

        // Only insert if not already present (idempotent in case bootstrap
        // SQL itself already included the drizzle_migrations rows).
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
