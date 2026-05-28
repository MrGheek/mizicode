import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";
import { rm, cp, readFile } from "node:fs/promises";

// Plugins (e.g. 'esbuild-plugin-pino') may use `require` to resolve dependencies
globalThis.require = createRequire(import.meta.url);

const artifactDir = path.dirname(fileURLToPath(import.meta.url));

// Distribution mode: "cloud" (default) or "local"
// Set via MIZI_DISTRIBUTION env var, e.g. MIZI_DISTRIBUTION=local pnpm build
const DISTRIBUTION = process.env.MIZI_DISTRIBUTION || "cloud";
const IS_LOCAL = DISTRIBUTION === "local";

console.log(`[build] Distribution: ${DISTRIBUTION}`);

// ─── Cloud-only stub plugin (local builds only) ───────────────────────────────
// esbuild builds its module graph BEFORE dead-code elimination, so modules that
// are statically imported (even from dead-code paths) still get bundled.  This
// plugin intercepts every cloud-only module and replaces it with an empty stub
// so that:
//   • vastai, fly, vllm strings never appear in dist/index.mjs
//   • init_vastai / init_fly / fly_exports etc. are declared but never called,
//     so minifySyntax=true eliminates them as unused variables.
// Files that statically import vastai / fly are also stubbed here.
const CLOUD_ONLY_FILES = new RegExp(
  [
    "services/(vastai|fly|templates)",        // cloud service modules
    "routes/(sessions|offers|templates|orchestrate)", // cloud route modules
  ].join("|") + "\\.(ts|js)$"
);

function localCloudStubPlugin() {
  if (!IS_LOCAL) return { name: "cloud-stub-noop", setup() {} };
  return {
    name: "local-cloud-stub",
    setup(build) {
      build.onLoad({ filter: CLOUD_ONLY_FILES }, (args) => {
        console.log(`[local-cloud-stub] stubbing ${path.basename(args.path)}`);
        return { contents: "// cloud-only module — stubbed for local distribution\n", loader: "js" };
      });
    },
  };
}

// In local builds, gate cloud-only provider code behind IS_CLOUD_BUILD=false
// so esbuild's dead-code elimination strips Vast.ai, Fly.io, and vLLM imports.
const defines = {
  "process.env.MIZI_DISTRIBUTION": JSON.stringify(DISTRIBUTION),
  __IS_LOCAL_BUILD__: String(IS_LOCAL),
  __IS_CLOUD_BUILD__: String(!IS_LOCAL),
};

async function buildAll() {
  const distDir = path.resolve(artifactDir, "dist");
  await rm(distDir, { recursive: true, force: true });

  await esbuild({
    entryPoints: [
      path.resolve(artifactDir, "src/index.ts"),
      path.resolve(artifactDir, "src/migrate.ts"),
    ],
    platform: "node",
    bundle: true,
    format: "esm",
    outdir: distDir,
    outExtension: { ".js": ".mjs" },
    logLevel: "info",
    define: defines,
    // Some packages may not be bundleable, so we externalize them, we can add more here as needed.
    // Some of the packages below may not be imported or installed, but we're adding them in case they are in the future.
    // Examples of unbundleable packages:
    // - uses native modules and loads them dynamically (e.g. sharp)
    // - use path traversal to read files (e.g. @google-cloud/secret-manager loads sibling .proto files)
    external: [
      "*.node",
      "sharp",
      "better-sqlite3",
      "sqlite3",
      "canvas",
      "bcrypt",
      "argon2",
      "fsevents",
      "re2",
      "farmhash",
      "xxhash-addon",
      "bufferutil",
      "utf-8-validate",
      "ssh2",
      "cpu-features",
      "dtrace-provider",
      "isolated-vm",
      "lightningcss",
      "pg-native",
      "oracledb",
      "mongodb-client-encryption",
      "nodemailer",
      "handlebars",
      "knex",
      "typeorm",
      "protobufjs",
      "onnxruntime-node",
      "@tensorflow/*",
      "@prisma/client",
      "@mikro-orm/*",
      "@grpc/*",
      "@swc/*",
      "@aws-sdk/*",
      "@azure/*",
      "@opentelemetry/*",
      "@google-cloud/*",
      "@google/*",
      "googleapis",
      "firebase-admin",
      "@parcel/watcher",
      "@sentry/profiling-node",
      "@tree-sitter/*",
      "aws-sdk",
      "classic-level",
      "dd-trace",
      "ffi-napi",
      "grpc",
      "hiredis",
      "kerberos",
      "leveldown",
      "miniflare",
      "mysql2",
      "newrelic",
      "odbc",
      "piscina",
      "realm",
      "ref-napi",
      "rocksdb",
      "sass-embedded",
      "sequelize",
      "serialport",
      "snappy",
      "tinypool",
      "usb",
      "workerd",
      "wrangler",
      "zeromq",
      "zeromq-prebuilt",
      "playwright",
      "puppeteer",
      "puppeteer-core",
      "electron",
    ],
    sourcemap: "linked",
    // In local builds, enable syntax-level optimisations so esbuild actually
    // eliminates `if (false) { … }` branches (constant-folded cloud guards).
    // Without this flag esbuild folds the condition but keeps the dead body.
    minifySyntax: IS_LOCAL,
    plugins: [
      // pino relies on workers to handle logging, instead of externalizing it we use a plugin to handle it
      esbuildPluginPino({ transports: ["pino-pretty"] }),
      // In local builds, stub out cloud-only service/route modules so their
      // content (vastai, fly, vllm strings) is never included in the bundle.
      localCloudStubPlugin(),
    ],
    // Make sure packages that are cjs only (e.g. express) but are bundled continue to work in our esm output file
    banner: {
      js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';

globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
    `,
    },
  });
}

async function copyMigrations() {
  const migrationsSource = path.resolve(artifactDir, "../../lib/db/migrations");
  const migrationsDest   = path.resolve(artifactDir, "dist/migrations");
  await cp(migrationsSource, migrationsDest, { recursive: true });
  console.log("Copied migrations → dist/migrations");
}

async function copyLocalAssets() {
  if (!IS_LOCAL) return;
  const { mkdir, writeFile } = await import("node:fs/promises");
  const distDir = path.resolve(artifactDir, "dist");
  await mkdir(path.join(distDir, "local"), { recursive: true });
  // Write a distribution marker so the runtime knows it's a local build
  await writeFile(path.join(distDir, "local/.distribution"), "local\n");
  console.log("Local distribution marker written → dist/local/.distribution");
}

// ─── Bundle scan: fail if cloud tokens appear in a local build ───────────────
async function scanLocalBundleForCloudTokens() {
  if (!IS_LOCAL) return;
  const bundlePath = path.resolve(artifactDir, "dist/index.mjs");
  const content = await readFile(bundlePath, "utf8");

  // These tokens must not appear in a local distribution bundle.
  // Exception: "vastai" and "flyMachine" may appear as Drizzle schema column
  // *key names* in the sessions schema (they are always exported).  We therefore
  // scan for the more specific FUNCTIONAL identifiers (function calls, string
  // literals used at runtime) rather than raw identifier substrings.
  const FORBIDDEN = [
    /vastai_exports/,           // vastai module barrel
    /init_vastai/,              // vastai ESM init wrapper
    /fly_exports/,              // fly module barrel
    /init_fly\b/,               // fly ESM init wrapper
    /vLLM did not respond/,     // sessions.ts cloud status message
    /Vast\.ai instance/,        // sessions.ts cloud status message
    /"vastai\.com"/,            // API endpoint string
    /fly\.machines\./,          // Fly.io machines API path
  ];

  const hits = FORBIDDEN.flatMap((re) => (re.test(content) ? [re.source] : []));
  if (hits.length > 0) {
    console.error("\n[bundle-scan] FAILED — local build contains cloud-only tokens:");
    hits.forEach((h) => console.error(`  • ${h}`));
    console.error("  Fix: ensure cloud-only modules are only imported inside !IS_LOCAL_DISTRIBUTION blocks\n");
    process.exit(1);
  }
  console.log("[bundle-scan] PASSED — no cloud-only tokens found in local bundle");
}

buildAll()
  .then(() => copyMigrations())
  .then(() => copyLocalAssets())
  .then(() => scanLocalBundleForCloudTokens())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
