import type { MiziSkillManifest, SkillClass, InstallRisk, TrustTier, TaskMode, SessionType } from "./skills-types";
import type { SkillSource } from "@workspace/db";

interface RawFile {
  path: string;
  content: string;
}

// ─── Language / framework keyword → repoKind mappings ────────────────────────

const REPO_KIND_PATTERNS: Array<{ keywords: string[]; kinds: string[] }> = [
  { keywords: ["flutter", "dart"],                              kinds: ["flutter", "dart"] },
  { keywords: ["android", "kotlin", "kmp", "compose"],         kinds: ["android", "kotlin", "kmp", "gradle"] },
  { keywords: ["ios", "swift", "swiftui", "swiftpm", "macos"], kinds: ["ios", "swift", "swiftpm", "macos"] },
  { keywords: ["react-native", "expo"],                         kinds: ["react-native", "expo", "javascript", "typescript"] },
  { keywords: ["nextjs", "next.js", "next"],                   kinds: ["next", "react", "typescript", "node"] },
  { keywords: ["react", "tsx", "jsx"],                         kinds: ["react", "javascript", "typescript"] },
  { keywords: ["vue"],                                          kinds: ["vue", "javascript", "typescript"] },
  { keywords: ["angular"],                                      kinds: ["angular", "typescript"] },
  { keywords: ["svelte"],                                       kinds: ["svelte", "javascript", "typescript"] },
  { keywords: ["typescript", "ts-node"],                        kinds: ["typescript", "node", "nodejs"] },
  { keywords: ["javascript", "nodejs", "node.js"],              kinds: ["javascript", "node", "nodejs"] },
  { keywords: ["python", "django", "fastapi", "flask"],         kinds: ["python", "django", "fastapi", "flask"] },
  { keywords: ["ruby", "rails", "sinatra"],                     kinds: ["ruby", "rails", "sinatra"] },
  { keywords: ["java", "spring", "maven", "gradle"],           kinds: ["java", "spring", "maven", "gradle"] },
  { keywords: ["golang", "go-lang"],                            kinds: ["go", "golang"] },
  { keywords: ["rust", "cargo"],                               kinds: ["rust", "cargo"] },
  { keywords: ["cpp", "c++", "cmake", "clang"],                kinds: ["cpp", "c++", "cmake"] },
  { keywords: ["csharp", "dotnet", ".net", "blazor"],          kinds: ["csharp", "dotnet"] },
  { keywords: ["php", "laravel", "symfony"],                   kinds: ["php", "laravel"] },
  { keywords: ["clickhouse", "postgres", "sqlite", "mysql"],   kinds: ["sql", "database"] },
];

/**
 * Infer repoKinds from skill name, file path, and frontmatter description.
 * Returns ["any"] when no framework/language keyword is detected.
 */
export function detectRepoKinds(path: string, name: string, description: string): string[] {
  const haystack = [path, name, description].join(" ").toLowerCase();

  // Special case: "go" is a short word that collides with common English — require
  // it to appear as a standalone token (word boundary) to avoid false positives.
  const hasGo = /\bgo[-\s]?(build|review|test|lang|workflow|patterns|skill)\b|\bgo\b/.test(haystack)
    && !haystack.includes("golang") === false || /\bgo\b/.test(haystack) && /\bgo[-_](build|review|test|patterns|workflow|skill|developer|coder)\b/.test(haystack);

  const matched = new Set<string>();

  for (const { keywords, kinds } of REPO_KIND_PATTERNS) {
    for (const kw of keywords) {
      if (kw === "golang" || kw === "go-lang") {
        if (haystack.includes(kw)) kinds.forEach(k => matched.add(k));
      } else if (kw === "next") {
        // "next" alone is too broad — require "nextjs" or path containing "next"
        if (haystack.includes("nextjs") || haystack.includes("next.js")) kinds.forEach(k => matched.add(k));
      } else if (haystack.includes(kw)) {
        kinds.forEach(k => matched.add(k));
      }
    }
  }

  // Handle standalone "go" with path-based evidence (e.g. skills/go-build/SKILL.md)
  if (/\/go[-_]/.test(path) || /^go[-_]/.test(name)) {
    matched.add("go");
    matched.add("golang");
  }

  return matched.size > 0 ? Array.from(matched) : ["any"];
}

// ─── Class detection ──────────────────────────────────────────────────────────

/**
 * Detect the skill class from path and content.
 *
 * Priority order:
 * 1. Frontmatter `class:` field (handled by caller)
 * 2. Path-level keywords (most reliable — ECC uses descriptive dir names)
 * 3. Content-level keywords
 * 4. Fallback: "doctrine"
 */
export function detectClass(path: string, content: string): SkillClass {
  const pathLower = path.toLowerCase();
  const parts = pathLower.split("/").filter(Boolean);
  const lastPart = parts[parts.length - 1] || "";
  // If the last segment is a filename (SKILL.md, etc.), use the parent directory name;
  // otherwise use the filename stem. This gives us the skill's logical name.
  const isFilePart = /\.(md|yaml|yml|json)$/.test(lastPart);
  const namePart = isFilePart
    ? (parts.length >= 2 ? parts[parts.length - 2] : lastPart.replace(/\.(md|yaml|yml|json)$/, ""))
    : lastPart;

  // ── Path-level: ECC-specific naming conventions ───────────────────────────
  // repo / language skills (checked first — language names are unambiguous)
  if (/\b(flutter|dart|android|kotlin|kmp|ios|swift|swiftui|react-native|expo|nextjs|vue|angular|svelte|django|fastapi|flask|ruby|rails|sinatra|java|spring|maven|golang|go-lang|rust|cargo|cpp|c\+\+|cmake|clang|csharp|dotnet|blazor|php|laravel|symfony|blender|harmonyos|compose-multiplatform|cisco|clickhouse)\b/.test(namePart)) return "repo";

  // team skills — checked BEFORE workflow because "dmux-workflows" contains "workflow"
  // but is fundamentally a team-coordination skill
  if (/\b(dmux|multi-agent|swarm|coordination|collaboration|carrier|team-flow)\b/.test(namePart)) return "team";

  // workflow skills
  if (/\b(tdd|workflow|loop|pipeline|autonomous|continuous|routing|e2e-testing|browser-qa|eval-harness|benchmark|checkpoint|canary|auto-update|build-fix|feature-dev|git|pr-review)\b/.test(namePart)) return "workflow";

  // context skills
  if (/\b(memory|context|graph|repo|onboard|code-tour|codebase|retrieval|knowledge|index|documentation|docs-lookup)\b/.test(namePart)) return "context";

  // efficiency skills
  if (/\b(compress|token|budget|lean|cost|slim|compact|caveman|context-b)\b/.test(namePart)) return "efficiency";

  // doctrine skills (security, standards, patterns, principles, design)
  if (/\b(security|guardrail|standard|pattern|principle|design|coding|api-design|backend|frontend|accessibility|a11y|review|audit|clean|architecture|brand|voice|healthcare|investor|market|article|content|mle|agentic|ai-first|agent-sort)\b/.test(namePart)) return "doctrine";

  // ── Content-level keywords ────────────────────────────────────────────────
  const lower = content.toLowerCase();

  if (lower.includes("guardrail") || lower.includes("principle") || lower.includes("doctrine") || lower.includes("best practice")) return "doctrine";
  if (lower.includes("tdd") || lower.includes("test-driven") || lower.includes("autonomous loop") || lower.includes("pipeline")) return "workflow";
  if (lower.includes("workflow") || lower.includes("routing") || lower.includes("stage")) return "workflow";
  if (lower.includes("memory") || lower.includes("context") || lower.includes("retrieval") || lower.includes("graph")) return "context";
  if (lower.includes("token") || lower.includes("compress") || lower.includes("budget") || lower.includes("slim")) return "efficiency";
  if (lower.includes("team") || lower.includes("collaborate") || lower.includes("multi-user")) return "team";

  return "doctrine";
}

// ─── Install risk ─────────────────────────────────────────────────────────────

function detectInstallRisk(content: string): InstallRisk {
  const lower = content.toLowerCase();
  if (lower.includes("binary") || (lower.includes("install") && lower.includes("apt"))) return "binary";
  if (lower.includes("post-commit") || lower.includes(".git/hooks")) return "hooked";
  // "hook" alone is too broad — ECC uses "hooks" heavily in prose. Only flag when
  // combined with shell-execution signals.
  if (lower.includes("pre-tool") || lower.includes("posttooluse") || lower.includes("pretooluse")) return "hooked";
  if (lower.includes("config file") || lower.includes("writes to") || lower.includes(".env")) return "config";
  return "virtual";
}

// ─── Trigger tasks ────────────────────────────────────────────────────────────

function extractTriggerTasks(content: string): TaskMode[] {
  const lower = content.toLowerCase();
  const tasks: TaskMode[] = [];
  if (lower.includes("build") || lower.includes("implement") || lower.includes("develop")) tasks.push("build");
  if (lower.includes("review") || lower.includes("pull request")) tasks.push("review");
  if (lower.includes("debug") || lower.includes("fix") || lower.includes("bugfix")) tasks.push("debug");
  if (lower.includes("refactor")) tasks.push("refactor");
  if (lower.includes("explore") || lower.includes("research")) tasks.push("explore");
  if (lower.includes("team") || lower.includes("collaborate") || lower.includes("multi-user")) tasks.push("team");
  return tasks.length > 0 ? tasks : ["build", "debug", "refactor"];
}

// ─── Instruction extraction ───────────────────────────────────────────────────

/**
 * Extract actionable instruction bullets from a skill document.
 *
 * Priority order:
 * 1. "When to Activate" section (ECC convention)
 * 2. "When to Use" section (legacy convention)
 * 3. "Rules / Instructions / Guidelines / Principles" section
 * 4. "Core Principles" / numbered sections
 * 5. Fallback: all bullets in the document, capped at MAX_FALLBACK_BULLETS
 * 6. Last resort: prose paragraphs
 *
 * Cap: MAX_BULLETS total instructions returned.
 */
const MAX_BULLETS = 15;
const MAX_FALLBACK_BULLETS = 10;

export function extractSystemInstructions(content: string): string[] {
  // Strip YAML frontmatter so key-value lines (e.g. "description: Nothing here")
  // are not mistakenly picked up as prose instructions.
  const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "");
  const collected: string[] = [];

  function addBullets(section: string, limit: number): void {
    const bullets = section.match(/^[-*]\s+(.+)$/gm);
    if (bullets) {
      for (const b of bullets) {
        if (collected.length >= limit) break;
        const text = b.replace(/^[-*]\s+/, "").trim();
        if (text.length > 5 && !collected.includes(text)) collected.push(text);
      }
    }
  }

  function addNumberedBullets(section: string, limit: number): void {
    const bullets = section.match(/^[-*\d.]\s+(.+)$/gm);
    if (bullets) {
      for (const b of bullets) {
        if (collected.length >= limit) break;
        const text = b.replace(/^[-*\d.]\s+/, "").trim();
        if (text.length > 5 && !collected.includes(text)) collected.push(text);
      }
    }
  }

  // 1 + 2. "When to Activate" or "When to Use" section
  const activateMatch = body.match(/##\s*when to (activate|use)\b[\s\S]*?(?=\n##|$)/i);
  if (activateMatch) addBullets(activateMatch[0], MAX_BULLETS);

  // 3. Rules / Instructions / Guidelines / Principles section
  if (collected.length < MAX_BULLETS) {
    const rulesMatch = body.match(/##\s*(rules?|instructions?|guidelines?|principles?)\b[\s\S]*?(?=\n##|$)/i);
    if (rulesMatch) addNumberedBullets(rulesMatch[0], MAX_BULLETS);
  }

  // 4. "Core Principles" or similar numbered sections
  if (collected.length < MAX_BULLETS) {
    const coreMatch = body.match(/##\s*(core principles?|key principles?|core rules?)\b[\s\S]*?(?=\n##|$)/i);
    if (coreMatch) addNumberedBullets(coreMatch[0], MAX_BULLETS);
  }

  // 5. Fallback: scan all bullets in document
  if (collected.length === 0) {
    const allBullets = body.match(/^[-*]\s+(.+)$/gm);
    if (allBullets) {
      for (const b of allBullets) {
        if (collected.length >= MAX_FALLBACK_BULLETS) break;
        const text = b.replace(/^[-*]\s+/, "").trim();
        if (text.length > 5 && !collected.includes(text)) collected.push(text);
      }
    }
  }

  // 6. Last resort: prose paragraphs (frontmatter already stripped from body)
  if (collected.length === 0) {
    const paras = body.split(/\n+/).filter(l => l.trim().length > 20 && !l.startsWith("#")).slice(0, 4);
    paras.forEach(p => collected.push(p.trim()));
  }

  return collected.slice(0, MAX_BULLETS).filter(l => l.length > 5);
}

// ─── Summary extraction ───────────────────────────────────────────────────────

function extractSummary(content: string, filename: string): string {
  const descMatch = content.match(/##\s*(description|summary|overview|about)\s*\n+(.+)/i);
  if (descMatch?.[2]) return descMatch[2].trim();

  const firstPara = content.split(/\n+/).find(l => l.trim().length > 20 && !l.startsWith("#"));
  if (firstPara) return firstPara.trim().slice(0, 200);

  return `Skill imported from ${filename}`;
}

// ─── Front matter parser ──────────────────────────────────────────────────────

function parseFrontMatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const [key, ...rest] = line.split(":");
    if (key && rest.length) result[key.trim()] = rest.join(":").trim();
  }
  return result;
}

// ─── Slug derivation ──────────────────────────────────────────────────────────

function deriveSlugFromPath(path: string, repoUrl: string): string {
  const repoName = repoUrl.split("/").pop()?.replace(/\.git$/, "") || "unknown";
  const filename = path.split("/").pop()?.replace(/\.(md|yaml|yml|json)$/, "") || "skill";
  const base = filename === "SKILL" || filename === "CLAUDE" || filename === "AGENTS" ? repoName : filename;
  return base
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

// ─── Single-file normalization ────────────────────────────────────────────────

function normalizeSingleFile(file: RawFile, source: SkillSource, trustTier: TrustTier): MiziSkillManifest | null {
  const { path, content } = file;
  if (!content || content.trim().length < 20) return null;

  const frontMatter = parseFrontMatter(content);
  const skillClass = (frontMatter["class"] as SkillClass) || detectClass(path, content);
  const installRisk = detectInstallRisk(content);
  const systemInstructions = extractSystemInstructions(content);
  if (systemInstructions.length === 0) return null;

  const slug = frontMatter["name"]
    ? frontMatter["name"].toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-")
    : deriveSlugFromPath(path, source.repoUrl);

  const name = frontMatter["name"] || slug;
  const summary = frontMatter["description"] || extractSummary(content, path);
  const repoKinds = detectRepoKinds(path, name, summary);

  const sessions: SessionType[] = ["solo", "team"];

  const instructionText = systemInstructions.join(" ");
  const tokenOverheadEstimate = Math.max(60, Math.min(500, Math.ceil(instructionText.length / 4)));

  return {
    schemaVersion: 1,
    id: slug,
    name,
    class: skillClass,
    source: {
      repoUrl: source.repoUrl,
      commitSha: source.pinnedCommitSha || undefined,
      license: source.license || undefined,
      trust: trustTier,
    },
    summary,
    triggers: {
      tasks: extractTriggerTasks(content),
      repoKinds,
      sessionModes: sessions,
    },
    compatibility: {
      models: ["kimi", "qwen", "glm", "deepseek", "minimax"],
      interfaces: ["claw", "vscode", "bolt"],
    },
    instructions: { system: systemInstructions },
    install: { type: installRisk, outputs: ["system_prompt_fragment"] },
    cost: { tokenOverheadEstimate },
    rankingHints: { taskFitWeight: 0.7, repoFitWeight: 0.5, measuredLiftWeight: 0.5 },
    safety: {
      shellExecution: installRisk === "hooked" || installRisk === "binary" ? "restricted" : "none",
      networkAccess: installRisk === "networked" ? "restricted" : "none",
    },
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function normalizeSource(rawFiles: RawFile[], source: SkillSource): MiziSkillManifest[] {
  const trustTier: TrustTier = "user_approved";

  const results: MiziSkillManifest[] = [];
  const seenSlugs = new Set<string>();

  for (const file of rawFiles) {
    const manifest = normalizeSingleFile(file, source, trustTier);
    if (!manifest) continue;

    let slug = manifest.id;
    let counter = 2;
    while (seenSlugs.has(slug)) {
      slug = `${manifest.id}-${counter++}`;
    }
    seenSlugs.add(slug);
    results.push({ ...manifest, id: slug });
  }

  return results;
}
