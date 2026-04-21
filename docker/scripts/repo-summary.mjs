#!/usr/bin/env node
/**
 * repo-summary.mjs — Repo Intelligence: Architecture summary generation
 *
 * Computes a compact architecture summary from the graph data:
 * - Major modules (top-level directories with source files)
 * - Hotspot files (ranked by centrality + dependency degree + file size)
 * - Test strategy detection
 * - Complexity classification
 * - Graph density
 *
 * No external dependencies — pure Node.js.
 */

/**
 * @param {Object} opts
 * @param {Array} opts.fileNodes - file nodes with path, lang, sizeBytes, centralityScore, dependencyDegree
 * @param {Array} opts.edges - import edges {from, to, kind}
 * @param {Object} opts.fingerprint - output from repo-fingerprint.mjs
 */
export function buildSummary({ fileNodes, edges, fingerprint }) {
  const modules = detectModules(fileNodes);
  const hotspots = rankHotspots(fileNodes);
  const testStrategy = detectTestStrategy(fileNodes, fingerprint);
  const graphDensity = computeGraphDensity(fileNodes, edges);
  const complexityClass = classifyComplexity(fileNodes, edges);
  const architectureSketch = buildArchitectureSketch({ modules, hotspots, fingerprint, complexityClass });

  return {
    architectureSketch,
    majorModules: modules.slice(0, 10),
    hotspots: hotspots.slice(0, 20),
    testStrategy,
    graphDensity,
    complexityClass,
  };
}

function detectModules(fileNodes) {
  const moduleCounts = {};
  const moduleLangs = {};
  for (const f of fileNodes) {
    const parts = f.path.split('/');
    if (parts.length < 2) continue;
    const topDir = parts[0];
    if (['src', 'lib', 'app', 'pkg', 'cmd', 'internal'].includes(topDir) && parts.length >= 3) {
      const mod = `${topDir}/${parts[1]}`;
      moduleCounts[mod] = (moduleCounts[mod] || 0) + 1;
      if (!moduleLangs[mod]) moduleLangs[mod] = {};
      if (f.lang) moduleLangs[mod][f.lang] = (moduleLangs[mod][f.lang] || 0) + 1;
    } else {
      moduleCounts[topDir] = (moduleCounts[topDir] || 0) + 1;
      if (!moduleLangs[topDir]) moduleLangs[topDir] = {};
      if (f.lang) moduleLangs[topDir][f.lang] = (moduleLangs[topDir][f.lang] || 0) + 1;
    }
  }

  return Object.entries(moduleCounts)
    .filter(([name, count]) => count >= 2 && !['node_modules', '.git'].includes(name))
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => {
      const langMap = moduleLangs[name] || {};
      const primaryLang = Object.entries(langMap).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
      return {
        name,
        path: name,
        fileCount: count,
        primaryLang,
        description: null,
      };
    });
}

function rankHotspots(fileNodes) {
  return fileNodes
    .filter(f => f.centralityScore !== undefined)
    .map(f => {
      const centralityScore = f.centralityScore || 0;
      const dependencyDegree = f.dependencyDegree || 0;
      const sizeScore = Math.min(1, (f.sizeBytes || 0) / (100 * 1024));
      const score = centralityScore * 0.5 + (dependencyDegree / Math.max(1, fileNodes.length)) * 0.3 + sizeScore * 0.2;
      return {
        path: f.path,
        score: Math.round(score * 1000) / 1000,
        centralityScore: Math.round(centralityScore * 1000) / 1000,
        dependencyDegree,
        fileSizeBytes: f.sizeBytes || 0,
        lang: f.lang || null,
      };
    })
    .sort((a, b) => b.score - a.score);
}

function detectTestStrategy(fileNodes, fingerprint) {
  const testFiles = fileNodes.filter(f =>
    /\.(test|spec)\.(ts|js|tsx|jsx|py)$/.test(f.path) ||
    /__tests__\//.test(f.path) ||
    /\/tests?\//.test(f.path)
  );

  if (testFiles.length === 0) return 'No test files detected';

  const tools = fingerprint?.testTooling || [];
  const ratio = Math.round((testFiles.length / Math.max(1, fileNodes.length)) * 100);

  if (tools.length > 0) {
    return `${tools.join(', ')} — ${testFiles.length} test files (${ratio}% of codebase)`;
  }
  return `${testFiles.length} test files detected (${ratio}% of codebase)`;
}

function computeGraphDensity(fileNodes, edges) {
  const n = fileNodes.length;
  if (n <= 1) return 0;
  const maxEdges = n * (n - 1);
  return maxEdges > 0 ? Math.round((edges.length / maxEdges) * 10000) / 10000 : 0;
}

function classifyComplexity(fileNodes, edges) {
  const n = fileNodes.length;
  const e = edges.length;
  const ratio = n > 0 ? e / n : 0;
  if (n > 500 || ratio > 5) return 'very-high';
  if (n > 200 || ratio > 3) return 'high';
  if (n > 50 || ratio > 1.5) return 'medium';
  return 'low';
}

function buildArchitectureSketch({ modules, hotspots, fingerprint, complexityClass }) {
  const parts = [];
  const langs = fingerprint?.primaryLangs?.join(', ') || 'unknown';
  const frameworks = fingerprint?.frameworks?.join(', ');
  const pm = fingerprint?.packageManager;
  const monorepo = fingerprint?.monorepo;

  parts.push(`${langs} codebase${frameworks ? ` using ${frameworks}` : ''}${pm ? ` (${pm})` : ''}.`);

  if (monorepo) parts.push('Monorepo layout detected.');

  if (modules.length > 0) {
    const topMods = modules.slice(0, 5).map(m => m.name).join(', ');
    parts.push(`Major modules: ${topMods}.`);
  }

  const topHotspot = hotspots[0];
  if (topHotspot) {
    parts.push(`Most central file: ${topHotspot.path} (${topHotspot.dependencyDegree} connections).`);
  }

  parts.push(`Complexity: ${complexityClass}.`);

  return parts.join(' ');
}
