#!/usr/bin/env node
/**
 * repo-graph.mjs — Repo Intelligence: Import/dependency graph extraction
 *
 * Builds a symbol and import graph from the repository using regex-based
 * parsing (no tree-sitter dependency — works out of the box with Node.js).
 * Produces:
 * - File nodes with metadata
 * - Symbol nodes (functions, classes, exports)
 * - Import/dependency edges
 *
 * Language support: TypeScript/JavaScript, Python, Go, Rust
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const MAX_FILE_SIZE = 1024 * 1024; // 1 MB
const MAX_SYMBOLS = 5000;
const MAX_EDGES = 10000;
const MAX_CHUNK_COUNT = 50000;

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target', '__pycache__',
  'vendor', '.vendor', 'generated', 'gen', '.next', '.nuxt', 'coverage',
]);

const SUPPORTED_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs']);

const LANG_FOR_EXT = {
  '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
};

function extractImportsTS(content, filePath) {
  const imports = [];
  const fromPattern = /(?:import|export)\s+(?:[^;'"]*\s+from\s+)?['"]([^'"]+)['"]/g;
  const requirePattern = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = fromPattern.exec(content)) !== null) {
    imports.push(m[1]);
  }
  while ((m = requirePattern.exec(content)) !== null) {
    imports.push(m[1]);
  }
  return imports;
}

function extractSymbolsTS(content) {
  const symbols = [];
  const patterns = [
    { re: /export\s+(?:async\s+)?function\s+(\w+)/g, kind: 'function' },
    { re: /export\s+(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/g, kind: 'class' },
    { re: /export\s+(?:type|interface)\s+(\w+)/g, kind: 'interface' },
    { re: /export\s+const\s+(\w+)/g, kind: 'constant' },
    { re: /^(?:async\s+)?function\s+(\w+)/gm, kind: 'function' },
    { re: /^(?:abstract\s+)?class\s+(\w+)/gm, kind: 'class' },
    { re: /^const\s+(\w+)\s*=/gm, kind: 'variable' },
  ];
  const seen = new Set();
  for (const { re, kind } of patterns) {
    let m;
    while ((m = re.exec(content)) !== null) {
      const name = m[1];
      if (!seen.has(name) && name.length > 1) {
        seen.add(name);
        const line = content.slice(0, m.index).split('\n').length;
        symbols.push({ name, kind, line });
      }
    }
  }
  return symbols.slice(0, 50);
}

function extractImportsPython(content) {
  const imports = [];
  const patterns = [
    /^import\s+([\w.]+)/gm,
    /^from\s+([\w.]+)\s+import/gm,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(content)) !== null) {
      imports.push(m[1]);
    }
  }
  return imports;
}

function extractSymbolsPython(content) {
  const symbols = [];
  const patterns = [
    { re: /^def\s+(\w+)\s*\(/gm, kind: 'function' },
    { re: /^class\s+(\w+)/gm, kind: 'class' },
    { re: /^async\s+def\s+(\w+)\s*\(/gm, kind: 'function' },
  ];
  const seen = new Set();
  for (const { re, kind } of patterns) {
    let m;
    while ((m = re.exec(content)) !== null) {
      const name = m[1];
      if (!seen.has(name)) {
        seen.add(name);
        const line = content.slice(0, m.index).split('\n').length;
        symbols.push({ name, kind, line });
      }
    }
  }
  return symbols.slice(0, 50);
}

function extractImportsGo(content) {
  const imports = [];
  const singleRe = /import\s+"([^"]+)"/g;
  const blockRe = /import\s*\(([^)]+)\)/gs;
  let m;
  while ((m = singleRe.exec(content)) !== null) {
    imports.push(m[1]);
  }
  while ((m = blockRe.exec(content)) !== null) {
    const block = m[1];
    const pkgRe = /"([^"]+)"/g;
    let pm;
    while ((pm = pkgRe.exec(block)) !== null) {
      imports.push(pm[1]);
    }
  }
  return imports;
}

function extractSymbolsGo(content) {
  const symbols = [];
  const patterns = [
    { re: /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(/gm, kind: 'function' },
    { re: /^type\s+(\w+)\s+struct/gm, kind: 'struct' },
    { re: /^type\s+(\w+)\s+interface/gm, kind: 'interface' },
  ];
  const seen = new Set();
  for (const { re, kind } of patterns) {
    let m;
    while ((m = re.exec(content)) !== null) {
      const name = m[1];
      if (!seen.has(name)) {
        seen.add(name);
        const line = content.slice(0, m.index).split('\n').length;
        symbols.push({ name, kind, line });
      }
    }
  }
  return symbols.slice(0, 50);
}

function extractImportsRust(content) {
  const imports = [];
  const re = /use\s+([\w:]+)/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    imports.push(m[1]);
  }
  return imports;
}

function extractSymbolsRust(content) {
  const symbols = [];
  const patterns = [
    { re: /^pub\s+(?:async\s+)?fn\s+(\w+)/gm, kind: 'function' },
    { re: /^(?:async\s+)?fn\s+(\w+)/gm, kind: 'function' },
    { re: /^pub\s+struct\s+(\w+)/gm, kind: 'struct' },
    { re: /^pub\s+trait\s+(\w+)/gm, kind: 'interface' },
    { re: /^pub\s+enum\s+(\w+)/gm, kind: 'enum' },
  ];
  const seen = new Set();
  for (const { re, kind } of patterns) {
    let m;
    while ((m = re.exec(content)) !== null) {
      const name = m[1];
      if (!seen.has(name)) {
        seen.add(name);
        const line = content.slice(0, m.index).split('\n').length;
        symbols.push({ name, kind, line });
      }
    }
  }
  return symbols.slice(0, 50);
}

function computeContentHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function* walkDir(rootDir) {
  function* walk(dir, rel) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const name = entry.name;
      if (name.startsWith('.')) continue;
      const abs = path.join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(name)) continue;
        yield* walk(abs, relPath);
      } else if (entry.isFile()) {
        const ext = path.extname(name).toLowerCase();
        if (!SUPPORTED_EXTS.has(ext)) continue;
        let stats;
        try { stats = fs.statSync(abs); } catch { continue; }
        if (stats.size > MAX_FILE_SIZE) continue;
        yield { filePath: abs, relPath, stats, ext, lang: LANG_FOR_EXT[ext] };
      }
    }
  }
  yield* walk(rootDir, '');
}

export async function buildGraph(repoPath) {
  const fileNodes = [];
  const symbolNodes = [];
  const edges = [];
  const filePathToRelPath = new Map();

  let symbolCount = 0;
  let edgeCount = 0;
  const startTime = Date.now();
  const MAX_DURATION_MS = 4 * 60 * 1000; // 4 min (leave 1 min buffer for reporting)

  for (const { filePath, relPath, stats, ext, lang } of walkDir(repoPath)) {
    if (Date.now() - startTime > MAX_DURATION_MS) {
      console.warn('[repo-graph] Time limit reached — partial graph returned');
      break;
    }

    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    const contentHash = computeContentHash(content);
    const fileNode = {
      path: relPath,
      lang,
      sizeBytes: stats.size,
      mtime: stats.mtimeMs,
      contentHash,
      lineCount: content.split('\n').length,
    };
    fileNodes.push(fileNode);
    filePathToRelPath.set(filePath, relPath);

    let imports = [];
    let symbols = [];

    if (lang === 'typescript' || lang === 'javascript') {
      imports = extractImportsTS(content, filePath);
      symbols = extractSymbolsTS(content);
    } else if (lang === 'python') {
      imports = extractImportsPython(content);
      symbols = extractSymbolsPython(content);
    } else if (lang === 'go') {
      imports = extractImportsGo(content);
      symbols = extractSymbolsGo(content);
    } else if (lang === 'rust') {
      imports = extractImportsRust(content);
      symbols = extractSymbolsRust(content);
    }

    for (const sym of symbols) {
      if (symbolCount >= MAX_SYMBOLS) break;
      symbolNodes.push({ ...sym, path: relPath, lang, callers: [], callees: [] });
      symbolCount++;
    }

    for (const importPath of imports) {
      if (edgeCount >= MAX_EDGES) break;
      if (importPath.startsWith('.')) {
        const resolvedRel = resolveRelativeImport(relPath, importPath);
        if (resolvedRel) {
          edges.push({ from: relPath, to: resolvedRel, kind: 'import' });
          edgeCount++;
        }
      }
    }
  }

  return {
    fileNodes,
    symbolNodes,
    edges,
    indexedSymbols: symbolCount,
    edgeCount: edgeCount,
    durationMs: Date.now() - startTime,
  };
}

function resolveRelativeImport(fromRelPath, importPath) {
  const fromDir = path.dirname(fromRelPath);
  const candidates = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.js'];
  for (const suffix of candidates) {
    const candidate = path.normalize(path.join(fromDir, importPath + suffix));
    if (!candidate.startsWith('..')) {
      return candidate;
    }
  }
  return null;
}

export function computeFileCentrality(fileNodes, edges) {
  const inDegree = {};
  const outDegree = {};
  for (const f of fileNodes) {
    inDegree[f.path] = 0;
    outDegree[f.path] = 0;
  }
  for (const e of edges) {
    if (e.from in outDegree) outDegree[e.from]++;
    if (e.to in inDegree) inDegree[e.to]++;
  }
  return fileNodes.map(f => ({
    ...f,
    inDegree: inDegree[f.path] || 0,
    outDegree: outDegree[f.path] || 0,
    centralityScore: ((inDegree[f.path] || 0) * 2 + (outDegree[f.path] || 0)) / Math.max(1, fileNodes.length),
    dependencyDegree: (inDegree[f.path] || 0) + (outDegree[f.path] || 0),
  }));
}
