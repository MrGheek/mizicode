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
 */
import path from "path";
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

async function main(): Promise<void> {
  // __dirname is injected by the esbuild banner at build time.
  const migrationsFolder = path.join(__dirname, "migrations");

  console.log("[migrate] Starting database migrations…");
  console.log("[migrate] Migrations folder:", migrationsFolder);

  try {
    await migrate(db, { migrationsFolder });
    console.log("[migrate] All migrations applied successfully.");
  } catch (err) {
    console.error("[migrate] Migration failed:", err);
    await pool.end();
    process.exit(1);
  }

  await pool.end();
  process.exit(0);
}

main();
