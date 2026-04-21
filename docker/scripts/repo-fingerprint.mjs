#!/usr/bin/env node
/**
 * repo-fingerprint.mjs — Repo Intelligence: Language & framework detection
 *
 * Walks a repository directory and produces a fingerprint:
 * - Primary and all detected languages
 * - Framework indicators
 * - Package manager
 * - Monorepo detection
 * - Test tooling
 * - Entry points
 * - Fingerprint hash for stale-detection
 *
 * No external dependencies — uses only Node.js built-ins.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'target',
  '__pycache__', '.pytest_cache', '.mypy_cache', 'vendor', '.vendor',
  'generated', 'gen', '.next', '.nuxt', '.cache', 'coverage', '.nyc_output',
  '.turbo', '.parcel-cache', 'storybook-static', '.storybook-static',
]);

const IGNORE_EXTENSIONS = new Set([
  '.lock', '.sum', '.min.js', '.min.css', '.map', '.wasm',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.avif',
  '.mp4', '.mp3', '.wav', '.ogg', '.pdf', '.zip', '.tar', '.gz', '.bz2',
  '.exe', '.dll', '.so', '.dylib', '.a', '.lib',
  '.pyc', '.pyo', '.class', '.o',
]);

const MAX_FILE_SIZE_BYTES = 1024 * 1024; // 1 MB
const MAX_FILE_COUNT = 10000;

const LANG_BY_EXT = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript',
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.swift': 'Swift',
  '.cs': 'C#',
  '.cpp': 'C++', '.cc': 'C++', '.cxx': 'C++', '.hpp': 'C++',
  '.c': 'C', '.h': 'C',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.sh': 'Shell', '.bash': 'Shell',
  '.yaml': 'YAML', '.yml': 'YAML',
  '.json': 'JSON',
  '.md': 'Markdown',
  '.sql': 'SQL',
  '.html': 'HTML', '.htm': 'HTML',
  '.css': 'CSS', '.scss': 'CSS', '.sass': 'CSS', '.less': 'CSS',
  '.vue': 'Vue',
  '.svelte': 'Svelte',
  '.ex': 'Elixir', '.exs': 'Elixir',
  '.hs': 'Haskell',
  '.scala': 'Scala',
  '.r': 'R', '.R': 'R',
  '.lua': 'Lua',
  '.tf': 'Terraform', '.tfvars': 'Terraform',
};

const FRAMEWORK_INDICATORS = {
  'package.json': (content) => {
    const indicators = [];
    try {
      const pkg = JSON.parse(content);
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps['react']) indicators.push('React');
      if (deps['vue']) indicators.push('Vue');
      if (deps['@angular/core']) indicators.push('Angular');
      if (deps['svelte']) indicators.push('Svelte');
      if (deps['next']) indicators.push('Next.js');
      if (deps['nuxt']) indicators.push('Nuxt');
      if (deps['express']) indicators.push('Express');
      if (deps['fastify']) indicators.push('Fastify');
      if (deps['hono']) indicators.push('Hono');
      if (deps['nestjs'] || deps['@nestjs/core']) indicators.push('NestJS');
      if (deps['drizzle-orm']) indicators.push('Drizzle ORM');
      if (deps['prisma'] || deps['@prisma/client']) indicators.push('Prisma');
      if (deps['vite']) indicators.push('Vite');
      if (deps['webpack']) indicators.push('Webpack');
      if (deps['esbuild']) indicators.push('esbuild');
      if (deps['tailwindcss']) indicators.push('Tailwind CSS');
    } catch {}
    return indicators;
  },
  'requirements.txt': () => ['Python/pip'],
  'pyproject.toml': (content) => {
    const indicators = ['Python'];
    if (content.includes('fastapi')) indicators.push('FastAPI');
    if (content.includes('django')) indicators.push('Django');
    if (content.includes('flask')) indicators.push('Flask');
    return indicators;
  },
  'Cargo.toml': () => ['Rust/Cargo'],
  'go.mod': () => ['Go modules'],
  'pom.xml': () => ['Maven/Java'],
  'build.gradle': () => ['Gradle'],
};

const PKG_MANAGER_INDICATORS = {
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
  'package-lock.json': 'npm',
  'bun.lockb': 'bun',
  'Pipfile.lock': 'pipenv',
  'poetry.lock': 'poetry',
  'Cargo.lock': 'cargo',
  'go.sum': 'go modules',
};

const TEST_TOOL_INDICATORS = {
  'jest.config.js': 'Jest', 'jest.config.ts': 'Jest', 'jest.config.mjs': 'Jest',
  'vitest.config.js': 'Vitest', 'vitest.config.ts': 'Vitest',
  'pytest.ini': 'pytest', 'setup.cfg': 'pytest (maybe)',
  'karma.conf.js': 'Karma',
  'playwright.config.ts': 'Playwright', 'playwright.config.js': 'Playwright',
  'cypress.config.js': 'Cypress', 'cypress.config.ts': 'Cypress',
};

const MONOREPO_INDICATORS = new Set([
  'pnpm-workspace.yaml', 'lerna.json', 'nx.json', 'turbo.json',
  'rush.json', 'packages',
]);

const ENTRY_POINT_NAMES = new Set([
  'index.ts', 'index.js', 'index.tsx', 'main.ts', 'main.js', 'main.py',
  'app.ts', 'app.js', 'app.py', 'server.ts', 'server.js', 'server.py',
  'src/index.ts', 'src/index.js', 'src/main.ts', 'src/main.js',
  'cmd/main.go', 'main.go', 'lib/index.ts', 'lib/index.js',
]);

/**
 * Walk directory tree, yielding {filePath, stats} for each file.
 * Respects ignore patterns and hard caps.
 */
function* walkDir(rootDir, relBase = '') {
  let count = 0;
  function* walk(dir, rel) {
    if (count >= MAX_FILE_COUNT) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (count >= MAX_FILE_COUNT) return;
      const name = entry.name;
      if (name.startsWith('.') && name !== '.env') {
        const isKnownGoodDot = false;
        if (!isKnownGoodDot) continue;
      }
      const absPath = path.join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(name)) continue;
        yield* walk(absPath, relPath);
      } else if (entry.isFile()) {
        const ext = path.extname(name).toLowerCase();
        if (IGNORE_EXTENSIONS.has(ext)) continue;
        let stats;
        try {
          stats = fs.statSync(absPath);
        } catch {
          continue;
        }
        if (stats.size > MAX_FILE_SIZE_BYTES) continue;
        count++;
        yield { filePath: absPath, relPath, stats, name, ext };
      }
    }
  }
  yield* walk(rootDir, relBase);
}

function computeFingerprintHash(files) {
  const hash = crypto.createHash('sha256');
  for (const f of files.slice(0, 500)) {
    hash.update(`${f.relPath}:${f.mtime}:${f.size}\n`);
  }
  return hash.digest('hex').slice(0, 32);
}

export async function fingerprint(repoPath) {
  const langCounts = {};
  const frameworks = new Set();
  const testTooling = new Set();
  const entryPoints = [];
  const fileManifest = [];
  let packageManager = null;
  let monorepo = false;
  const rootEntries = new Set();

  try {
    const topLevel = fs.readdirSync(repoPath, { withFileTypes: true });
    for (const e of topLevel) {
      rootEntries.add(e.name);
    }
  } catch {}

  for (const [indicator, pm] of Object.entries(PKG_MANAGER_INDICATORS)) {
    if (rootEntries.has(indicator)) {
      packageManager = pm;
      break;
    }
  }

  for (const indicator of MONOREPO_INDICATORS) {
    if (rootEntries.has(indicator)) {
      monorepo = true;
      break;
    }
  }

  for (const [configFile] of Object.entries(TEST_TOOL_INDICATORS)) {
    if (rootEntries.has(configFile)) {
      testTooling.add(TEST_TOOL_INDICATORS[configFile]);
    }
  }

  for (const entry of walkDir(repoPath)) {
    const { filePath, relPath, stats, name, ext } = entry;

    fileManifest.push({ relPath, mtime: stats.mtimeMs, size: stats.size });

    const lang = LANG_BY_EXT[ext];
    if (lang) {
      langCounts[lang] = (langCounts[lang] || 0) + 1;
    }

    if (FRAMEWORK_INDICATORS[name]) {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const detected = FRAMEWORK_INDICATORS[name](content);
        for (const fw of detected) frameworks.add(fw);
      } catch {}
    }

    for (const [configFile, tool] of Object.entries(TEST_TOOL_INDICATORS)) {
      if (name === configFile || relPath === configFile) {
        testTooling.add(tool);
      }
    }

    for (const ep of ENTRY_POINT_NAMES) {
      if (relPath === ep || name === ep.split('/').pop()) {
        if (!entryPoints.includes(relPath)) {
          entryPoints.push(relPath);
        }
      }
    }
  }

  const sortedLangs = Object.entries(langCounts)
    .filter(([lang]) => !['YAML', 'JSON', 'Markdown'].includes(lang))
    .sort((a, b) => b[1] - a[1]);

  const primaryLangs = sortedLangs.slice(0, 3).map(([lang]) => lang);
  const allLangs = sortedLangs.map(([lang]) => lang);
  const fingerprintHash = computeFingerprintHash(fileManifest);

  return {
    primaryLangs,
    allLangs,
    frameworks: [...frameworks],
    packageManager,
    monorepo,
    testTooling: [...testTooling],
    entryPoints: entryPoints.slice(0, 10),
    fileCount: fileManifest.length,
    fingerprintHash,
  };
}
