#!/usr/bin/env node
/**
 * fix-zod-index.mjs
 *
 * Orval (when run with schemas config or mode: split) generates
 * `lib/api-zod/src/index.ts` with multiple wildcard re-exports including
 * `./generated/types` and `./generated/api.schemas`. These cause TS2308
 * duplicate-export errors when the generated Zod schemas and TypeScript types
 * share the same identifier (e.g. SearchRepoParams).
 *
 * This script overwrites `api-zod/src/index.ts` with only the Zod schemas
 * export, which is all the package needs. TypeScript types for API consumers
 * are provided by `@workspace/api-client-react`.
 */
import { writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexPath = resolve(__dirname, "../../lib/api-zod/src/index.ts");

const correct = `export * from "./generated/api";\n`;

writeFileSync(indexPath, correct, "utf-8");
console.log("[fix-zod-index] Wrote api-zod/src/index.ts with single Zod schema export");
