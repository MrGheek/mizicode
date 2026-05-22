#!/usr/bin/env node
// Patches bolt.diy's vite.config.ts to allow *.fly.dev hosts.
// Run after pnpm install in the Dockerfile.
// Using an external script avoids shell-escaping issues in RUN node -e "..."

import { readFileSync, writeFileSync } from 'fs';

const p = '/opt/bolt-diy/vite.config.ts';
let c = readFileSync(p, 'utf8');

// If allowedHosts already exists in the file, force its value to `true`.
// Do NOT skip — the existing value might be a restrictive array like ['localhost'].
if (c.includes('allowedHosts')) {
  const patched = c.replace(/allowedHosts\s*:\s*[^,}\n]+/g, 'allowedHosts: true');
  if (!patched.includes('allowedHosts: true')) {
    console.error('[bolt-patch] ERROR: failed to force allowedHosts: true — check vite.config.ts');
    process.exit(1);
  }
  writeFileSync(p, patched);
  console.log('[bolt-patch] vite.config.ts: forced existing allowedHosts to true');
  process.exit(0);
}

const SERVER_BLOCK = `    server: { host: true, allowedHosts: true },`;

// bolt.diy uses: export default defineConfig((config) => { return { ...
// Inject server: right after the first "return {" inside defineConfig
const patched = c.replace(/^(  return \{)/m, `$1\n${SERVER_BLOCK}`);

if (!patched.includes('allowedHosts')) {
  console.error('[bolt-patch] ERROR: regex did not match — vite.config.ts structure may have changed');
  console.error('[bolt-patch] First 500 chars:', c.slice(0, 500));
  process.exit(1);
}

writeFileSync(p, patched);
console.log('[bolt-patch] vite.config.ts patched successfully');
