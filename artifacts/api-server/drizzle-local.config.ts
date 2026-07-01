import { defineConfig } from "drizzle-kit";
import path from "path";
import os from "os";

// Use SQLite for local testing
const dbPath = process.env.MIZI_LOCAL_DB_PATH ||
  path.join(os.homedir(), ".mizi", "local.db");

export default defineConfig({
  schema: path.join(__dirname, "../../../lib/db/src/schema/index.ts"),
  out: path.join(__dirname, "../../../lib/db/migrations-sqlite"),
  dialect: "sqlite",
  dbCredentials: {
    url: `file:${dbPath}`,
  },
});
