import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  // Log loudly but do not crash at module load time.
  // pg.Pool connects lazily — the process can start and serve /api/healthz
  // even before DATABASE_URL is injected as a Fly.io secret on first deploy.
  // All actual DB queries will fail until the secret is set.
  console.error(
    "[db] DATABASE_URL is not set — all database operations will fail. " +
      "Set it with: fly secrets set --app mizi-api DATABASE_URL=<connection-string>",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });

/**
 * Create a fresh pg Pool with the given connection string.
 * Used by the migration script to build a pool with custom startup options
 * (e.g. default_transaction_read_only=off) without altering the shared pool.
 */
export function createPool(connectionString: string): InstanceType<typeof Pool> {
  return new Pool({ connectionString });
}

export * from "./schema";
