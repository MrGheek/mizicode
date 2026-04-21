import type { FloatrSkillManifest, SkillClass, InstallRisk, TrustTier, TaskMode, SessionType } from "./skills-types";
import type { SkillSource } from "@workspace/db";

interface RawFile {
  path: string;
  content: string;
}

function detectClass(path: string, content: string): SkillClass {
  const lower = content.toLowerCase();
  const pathLower = path.toLowerCase();

  if (pathLower.includes("doctrine") || pathLower.includes("karpathy") || pathLower.includes("guardrail")) return "doctrine";
  if (pathLower.includes("workflow") || pathLower.includes("flow") || pathLower.includes("routing")) return "workflow";
  if (pathLower.includes("graph") || pathLower.includes("context") || pathLower.includes("memory") || pathLower.includes("repo")) return "context";
  if (pathLower.includes("compress") || pathLower.includes("token") || pathLower.includes("caveman") || pathLower.includes("lean")) return "efficiency";

  if (lower.includes("behavior") || lower.includes("guardrail") || lower.includes("principle") || lower.includes("doctrine")) return "doctrine";
  if (lower.includes("workflow") || lower.includes("routing") || lower.includes("stage") || lower.includes("pipeline")) return "workflow";
  if (lower.includes("memory") || lower.includes("context") || lower.includes("retrieval") || lower.includes("graph")) return "context";
  if (lower.includes("token") || lower.includes("compress") || lower.includes("budget") || lower.includes("slim")) return "efficiency";

  return "doctrine";
}

function detectInstallRisk(content: string): InstallRisk {
  const lower = content.toLowerCase();
  if (lower.includes("binary") || lower.includes("executable") || lower.includes("install") && lower.includes("apt")) return "binary";
  if (lower.includes("hook") || lower.includes("post-commit") || lower.includes(".git/hooks")) return "hooked";
  if (lower.includes("config file") || lower.includes("writes to") || lower.includes(".env")) return "config";
  if (lower.includes("network") || lower.includes("api call") || lower.includes("fetch")) return "networked";
  return "virtual";
}

function extractTriggerTasks(content: string): TaskMode[] {
  const lower = content.toLowerCase();
  const tasks: TaskMode[] = [];
  if (lower.includes("build") || lower.includes("implement") || lower.includes("develop")) tasks.push("build");
  if (lower.includes("review") || lower.includes("pr") || lower.includes("pull request")) tasks.push("review");
  if (lower.includes("debug") || lower.includes("fix") || lower.includes("bugfix")) tasks.push("debug");
  if (lower.includes("refactor")) tasks.push("refactor");
  if (lower.includes("explore") || lower.includes("research")) tasks.push("explore");
  if (lower.includes("team") || lower.includes("collaborate") || lower.includes("multi-user")) tasks.push("team");
  return tasks.length > 0 ? tasks : ["build", "debug", "refactor"];
}

function extractSystemInstructions(content: string): string[] {
  const lines: string[] = [];

  const whenToUseMatch = content.match(/##\s*when to use[\s\S]*?(?=\n##|$)/i);
  if (whenToUseMatch) {
    const section = whenToUseMatch[0];
    const bullets = section.match(/^[-*]\s+(.+)$/gm);
    if (bullets) {
      bullets.forEach(b => lines.push(b.replace(/^[-*]\s+/, "").trim()));
    }
  }

  const rulesMatch = content.match(/##\s*(rules?|instructions?|guidelines?|principles?)[\s\S]*?(?=\n##|$)/i);
  if (rulesMatch) {
    const section = rulesMatch[0];
    const bullets = section.match(/^[-*\d.]\s+(.+)$/gm);
    if (bullets) {
      bullets.forEach(b => lines.push(b.replace(/^[-*\d.]\s+/, "").trim()));
    }
  }

  if (lines.length === 0) {
    const allBullets = content.match(/^[-*]\s+(.+)$/gm);
    if (allBullets) {
      allBullets.slice(0, 8).forEach(b => lines.push(b.replace(/^[-*]\s+/, "").trim()));
    }
  }

  if (lines.length === 0) {
    const paras = content.split(/\n+/).filter(l => l.trim().length > 20 && !l.startsWith("#")).slice(0, 4);
    paras.forEach(p => lines.push(p.trim()));
  }

  return lines.slice(0, 10).filter(l => l.length > 5);
}

function extractSummary(content: string, filename: string): string {
  const descMatch = content.match(/##\s*(description|summary|overview|about)[\s\S]*?\n(.+)/i);
  if (descMatch && descMatch[2]) return descMatch[2].trim();

  const firstPara = content.split(/\n+/).find(l => l.trim().length > 20 && !l.startsWith("#"));
  if (firstPara) return firstPara.trim().slice(0, 200);

  return `Skill imported from ${filename}`;
}

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

function normalizeSingleFile(file: RawFile, source: SkillSource, trustTier: TrustTier): FloatrSkillManifest | null {
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

  const sessions: SessionType[] = skillClass === "context" && content.toLowerCase().includes("team")
    ? ["solo", "team"]
    : ["solo", "team"];

  return {
    schemaVersion: 1,
    id: slug,
    name: frontMatter["name"] || slug,
    class: skillClass,
    source: {
      repoUrl: source.repoUrl,
      commitSha: source.pinnedCommitSha || undefined,
      license: source.license || undefined,
      trust: trustTier,
    },
    summary: frontMatter["description"] || extractSummary(content, path),
    triggers: {
      tasks: extractTriggerTasks(content),
      repoKinds: ["any"],
      sessionModes: sessions,
    },
    compatibility: {
      models: ["kimi", "qwen", "glm", "deepseek", "minimax"],
      interfaces: ["claw", "vscode", "bolt"],
    },
    instructions: { system: systemInstructions },
    install: { type: installRisk, outputs: ["system_prompt_fragment"] },
    cost: { tokenOverheadEstimate: Math.min(500, systemInstructions.join(" ").length / 4) },
    rankingHints: { taskFitWeight: 0.7, repoFitWeight: 0.5, measuredLiftWeight: 0.5 },
    safety: {
      shellExecution: installRisk === "hooked" || installRisk === "binary" ? "restricted" : "none",
      networkAccess: installRisk === "networked" ? "restricted" : "none",
    },
  };
}

export function normalizeSource(rawFiles: RawFile[], source: SkillSource): FloatrSkillManifest[] {
  const trustTier: TrustTier = "user_approved";

  const results: FloatrSkillManifest[] = [];
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
