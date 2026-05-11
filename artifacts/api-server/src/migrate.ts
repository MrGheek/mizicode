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
 * Also called directly in local dev via: node dist/migrate.mjs
 */
import path from "path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "@workspace/db";

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
