/**
 * Pure helper functions for migrate.ts — no side effects, no DB connections,
 * no process.exit.  Kept in a separate module so they can be unit-tested
 * without triggering the migration script's top-level startup logic.
 */

/**
 * Append `-c default_transaction_read_only=off` to the PostgreSQL startup
 * options so Drizzle's internal connections open in read-write mode even
 * when the role default is read-only.
 */
export function withReadWrite(connectionString: string): string {
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

/**
 * For Fly.io Postgres clusters: DATABASE_URL from `fly postgres attach`
 * uses port 5432 which connects directly to a specific machine — that
 * machine may be a replica.  Port 5433 is served by HAProxy and always
 * routes to the current leader/primary, so swap 5432 → 5433 for any
 * Fly.io internal hostname (.internal or .flycast).
 *
 * A URL produced by `fly postgres attach` may omit the port entirely,
 * relying on the Postgres default of 5432.  In that case new URL().port
 * returns "".  We treat "" as equivalent to "5432" so the HAProxy swap
 * fires correctly for both forms.
 *
 * Only activates when MIGRATE_DATABASE_URL is not already set (if the
 * caller explicitly provided a URL they know it's correct).
 */
export function withFlyLeaderPort(connectionString: string): string {
  if (process.env["MIGRATE_DATABASE_URL"]) return connectionString;
  try {
    const u = new URL(connectionString);
    const isFlyInternal =
      u.hostname.endsWith(".internal") || u.hostname.endsWith(".flycast");
    if (isFlyInternal && (u.port === "5432" || u.port === "")) {
      u.port = "5433";
      console.log(
        `[migrate] Fly.io Postgres detected — routing via HAProxy leader port 5433 ` +
        `(was 5432 direct). Set MIGRATE_DATABASE_URL to override.`
      );
    }
    return u.toString();
  } catch {
    return connectionString;
  }
}
