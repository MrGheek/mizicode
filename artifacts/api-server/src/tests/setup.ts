/**
 * Vitest setup file for E2E tests with local SQLite mode
 *
 * Initializes the SQLite database schema from PostgreSQL bootstrap dump.
 * Handles SQL dialect conversion automatically.
 */

import fs from "fs";
import path from "path";
import os from "os";

const IS_LOCAL = process.env.MIZI_DISTRIBUTION === "local";

if (IS_LOCAL) {
  console.log("[setup] Initializing SQLite database for local tests...");

  const localDbDir = process.env.MIZI_LOCAL_DB_DIR || path.join(os.homedir(), ".mizi");
  const localDbPath = process.env.MIZI_LOCAL_DB_PATH || path.join(localDbDir, "local.db");

  // Create directory if it doesn't exist
  if (!fs.existsSync(localDbDir)) {
    fs.mkdirSync(localDbDir, { recursive: true });
  }

  // If database exists, back it up for a fresh start in tests
  if (fs.existsSync(localDbPath)) {
    const backupPath = `${localDbPath}.backup.${Date.now()}`;
    fs.copyFileSync(localDbPath, backupPath);
    fs.unlinkSync(localDbPath);
    console.log(`[setup] Backed up existing database to ${backupPath}`);
  }

  try {
    // Import AFTER deleting old DB so fresh one is created
    delete require.cache[require.resolve("@workspace/db")];
    
    const Database = require("better-sqlite3");
    const db = new Database(localDbPath);

    // Disable WAL mode for test simplicity (concurrent writes not needed in tests)
    // WAL mode requires additional permissions/file creation
    db.pragma("journal_mode = DELETE");
    db.pragma("foreign_keys = ON");
    db.pragma("synchronous = NORMAL");

    // Create Drizzle migrations table first
    db.exec(`
      CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
    `);

    // Read and convert bootstrap SQL
    const bootstrapPath = path.join(__dirname, "../../../lib/db/migrations/_bootstrap.sql");
    if (fs.existsSync(bootstrapPath)) {
      let bootstrapSql = fs.readFileSync(bootstrapPath, "utf-8");

      // PostgreSQL to SQLite conversions
      bootstrapSql = bootstrapSql
        // Remove SCHEMA-related lines
        .replace(/CREATE SCHEMA IF NOT EXISTS \w+;/g, "")
        .replace(/SET search_path TO.*?;/g, "")
        .replace(/CREATE SEQUENCE.*?;/gs, "")
        .replace(/ALTER SEQUENCE.*?OWNED BY.*?;/g, "")
        .replace(/NEXT VALUE FOR [^\s]+/g, "NULL")
        // Remove USING clauses for indexes
        .replace(/USING \w+/g, "")
        // Remove table/column owner comments
        .replace(/--.*?Owner:.*?\n/g, "")
        // Convert timestamp types
        .replace(/timestamp without time zone/g, "DATETIME")
        .replace(/timestamp\(\d+\) without time zone/g, "DATETIME")
        // Convert jsonb to TEXT (SQLite doesn't have native JSON type but can store JSON in TEXT)
        .replace(/jsonb/g, "TEXT")
        .replace(/'.*?'::jsonb/g, "")
        // Fix DEFAULT now() → DEFAULT CURRENT_TIMESTAMP
        .replace(/DEFAULT now\(\)/g, "DEFAULT CURRENT_TIMESTAMP")
        // Fix DEFAULT CURRENT_TIMESTAMP without parentheses
        .replace(/DEFAULT CURRENT_TIMESTAMP\(\)/g, "DEFAULT CURRENT_TIMESTAMP")
        // Remove schema prefixes
        .replace(/public\./g, "")
        .replace(/drizzle\./g, "")
        // Fix integer DEFAULT expressions for AUTOINCREMENT
        .replace(/id integer NOT NULL/g, "id INTEGER NOT NULL")
        // Remove complex indexes (SQLite has different INDEX syntax)
        .replace(/CREATE INDEX.*?ON.*?;/gs, (match) => {
          // Keep simple indexes, drop complex ones
          if (match.includes("USING") || match.includes("DESC") || match.includes("NULLS")) {
            return "";
          }
          return match;
        })
        // Fix text[] to TEXT (SQLite doesn't have arrays)
        .replace(/text\[\]/g, "TEXT")
        .replace(/integer\[\]/g, "TEXT")
        // Remove CHECK constraints that reference functions
        .replace(/CHECK \([^)]*now\(\)[^)]*\)/g, "")
        // Fix double quotes in DDL
        .replace(/^--/gm, "--");

      // Split by GO or semicolon for statement execution
      const statements = bootstrapSql
        .split(/;\s*\n/)
        .map((stmt) => stmt.trim())
        .filter((stmt) => {
          // Skip comments, empty statements, and known problematic patterns
          if (!stmt || stmt.startsWith("--")) return false;
          if (stmt.includes("CREATE SCHEMA")) return false;
          if (stmt.includes("CREATE SEQUENCE")) return false;
          if (stmt.includes("ALTER SEQUENCE")) return false;
          if (stmt.includes("OWNED BY")) return false;
          if (stmt.includes("SET search_path")) return false;
          return true;
        });

      let successCount = 0;
      let skippedCount = 0;

      for (const stmt of statements) {
        if (!stmt) continue;

        // Add semicolon if missing
        const finalStmt = stmt.endsWith(";") ? stmt : stmt + ";";

        try {
          db.exec(finalStmt);
          successCount++;
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          
          // Some errors are expected (table already exists, etc.)
          if (
            errMsg.includes("already exists") ||
            errMsg.includes("duplicate column") ||
            errMsg.includes("no such column")
          ) {
            skippedCount++;
            // Silently skip
          } else {
            console.debug(`[setup] SQL error (skipped): ${errMsg}`);
            console.debug(`[setup] Failed statement: ${finalStmt.substring(0, 100)}...`);
            skippedCount++;
          }
        }
      }

      console.log(`[setup] Applied bootstrap schema: ${successCount} statements, ${skippedCount} skipped`);
    } else {
      console.warn(`[setup] Bootstrap SQL not found at ${bootstrapPath}`);
    }

    db.close();

    console.log(`[setup] SQLite database initialized at ${localDbPath}`);
  } catch (err) {
    console.error("[setup] Failed to initialize database:", err);
    // Don't fail startup; let tests discover actual issues
  }
} else {
  console.log("[setup] Cloud mode detected; skipping SQLite initialization");
}
