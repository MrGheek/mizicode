/**
 * Unit tests for the skills-import path enumeration logic.
 *
 * These tests mock the GitHub Git Trees API and verify that listSkillPaths
 * (exercised indirectly via importSkillFromUrl) correctly discovers all
 * skill paths without pagination loops, truncation, or duplicate entries —
 * including ECC-style layouts with 249 subdirectories.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// The internal listSkillPaths function is not exported, so we test its
// behaviour by inspecting which paths the importer tries to fetch raw content
// for.  We mock global.fetch so that:
//   - /repos/.../git/trees/... returns a synthetic tree
//   - /repos/.../commits/... returns a fake SHA
//   - /repos/.../... (repo metadata) returns a default branch stub
//   - raw.githubusercontent.com returns empty 404 for all files
//   - DB calls are stubbed via vi.mock
// ---------------------------------------------------------------------------

vi.mock("@workspace/db", () => {
  const table = () => ({});
  return {
    db: {
      insert: () => ({ values: () => [{ id: 1, repoUrl: "", commitSha: "" }] }),
      select: () => ({
        from: () => ({ where: () => ({ orderBy: () => ({ limit: () => [] }) }) }),
      }),
    },
    skillSourcesTable: table(),
    skillsTable: table(),
    skillVersionsTable: table(),
    eq: () => {},
    desc: () => {},
  };
});

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Build a fake tree that resembles ECC's 249-skill layout
function makeEccTree(skillCount: number) {
  const tree: { path: string; type: string }[] = [];
  for (let i = 0; i < skillCount; i++) {
    const name = `skill-${String(i).padStart(3, "0")}`;
    tree.push({ path: `skills/${name}`, type: "tree" });
    tree.push({ path: `skills/${name}/SKILL.md`, type: "blob" });
  }
  // Also add a handful of flat command files
  for (let i = 0; i < 5; i++) {
    tree.push({ path: `commands/cmd-${i}.md`, type: "blob" });
  }
  // Root README (should be picked up)
  tree.push({ path: "README.md", type: "blob" });
  return tree;
}

function buildFetchMock(tree: { path: string; type: string }[]) {
  return vi.fn(async (url: string | Request) => {
    const urlStr = typeof url === "string" ? url : url.url;

    // Git Trees API
    if (urlStr.includes("/git/trees/")) {
      return new Response(JSON.stringify({ tree, truncated: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Commit SHA lookup
    if (urlStr.includes("/commits/")) {
      return new Response(JSON.stringify({ sha: "abc123def456" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Repo metadata (default_branch)
    if (urlStr.match(/\/repos\/[^/]+\/[^/]+$/) && !urlStr.includes("/license")) {
      return new Response(JSON.stringify({ default_branch: "main" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // License endpoint
    if (urlStr.includes("/license")) {
      return new Response(null, { status: 404 });
    }

    // All raw file fetches → 404 so rawFiles stays empty (we only test path discovery)
    if (urlStr.includes("raw.githubusercontent.com")) {
      return new Response(null, { status: 404 });
    }

    return new Response(null, { status: 404 });
  });
}

describe("listSkillPaths — Git Trees API enumeration", () => {
  let originalFetch: typeof global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;
  let calledTreeUrls: string[];

  beforeEach(() => {
    originalFetch = global.fetch;
    calledTreeUrls = [];
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("issues exactly ONE Git Trees request for a 249-skill ECC repo", async () => {
    const tree = makeEccTree(249);
    fetchMock = buildFetchMock(tree);
    const treeRequests: string[] = [];

    global.fetch = vi.fn(async (url: string | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : (url as Request).url;
      if (urlStr.includes("/git/trees/")) treeRequests.push(urlStr);
      return fetchMock(url, init);
    }) as typeof global.fetch;

    const { importSkillFromUrl } = await import("../services/skills-import");
    try {
      await importSkillFromUrl("https://github.com/test-owner/test-repo");
    } catch {
      // DB stub is minimal — error is expected after path enumeration
    }

    expect(treeRequests.length).toBe(1);
    expect(treeRequests[0]).toContain("/git/trees/");
    expect(treeRequests[0]).toContain("recursive=1");
  });

  it("discovers all 249 SKILL.md paths and 5 flat command files + README", async () => {
    const tree = makeEccTree(249);
    const rawFetchedPaths: string[] = [];

    global.fetch = vi.fn(async (url: string | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : (url as Request).url;
      if (urlStr.includes("raw.githubusercontent.com")) {
        // Record which paths were fetched
        const m = urlStr.match(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\/(.+)$/);
        if (m) rawFetchedPaths.push(m[1]);
        return new Response(null, { status: 404 });
      }
      return buildFetchMock(tree)(url, init);
    }) as typeof global.fetch;

    const { importSkillFromUrl } = await import("../services/skills-import");
    try {
      await importSkillFromUrl("https://github.com/ecc-owner/ecc-repo");
    } catch {
      // Expected — DB stub is minimal
    }

    const skillMdPaths = rawFetchedPaths.filter(p => p.startsWith("skills/") && p.endsWith("/SKILL.md"));
    const commandPaths = rawFetchedPaths.filter(p => p.startsWith("commands/") && p.endsWith(".md"));
    const readmePaths = rawFetchedPaths.filter(p => p === "README.md");

    expect(skillMdPaths.length).toBe(249);
    expect(commandPaths.length).toBe(5);
    expect(readmePaths.length).toBe(1);
  });

  it("produces no duplicate paths even when skill names share prefixes", async () => {
    const tree: { path: string; type: string }[] = [
      { path: "skills/react", type: "tree" },
      { path: "skills/react/SKILL.md", type: "blob" },
      { path: "skills/react-native", type: "tree" },
      { path: "skills/react-native/SKILL.md", type: "blob" },
      { path: "skills/react-query", type: "tree" },
      { path: "skills/react-query/SKILL.md", type: "blob" },
      { path: "skills/react-query/CLAUDE.md", type: "blob" }, // extra file in same dir
      { path: "commands/build.md", type: "blob" },
      { path: "commands/build.md", type: "blob" }, // duplicate in source tree
    ];

    const rawFetchedPaths: string[] = [];
    global.fetch = vi.fn(async (url: string | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : (url as Request).url;
      if (urlStr.includes("raw.githubusercontent.com")) {
        const m = urlStr.match(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\/(.+)$/);
        if (m) rawFetchedPaths.push(m[1]);
        return new Response(null, { status: 404 });
      }
      return buildFetchMock(tree)(url, init);
    }) as typeof global.fetch;

    const { importSkillFromUrl } = await import("../services/skills-import");
    try {
      await importSkillFromUrl("https://github.com/test-owner/mixed-repo");
    } catch {
      // Expected
    }

    const unique = new Set(rawFetchedPaths);
    expect(unique.size).toBe(rawFetchedPaths.length); // no duplicates
    // react-query should yield both SKILL.md and CLAUDE.md
    expect(rawFetchedPaths).toContain("skills/react-query/SKILL.md");
    expect(rawFetchedPaths).toContain("skills/react-query/CLAUDE.md");
    // Flat command file (deduplicated from duplicate source entry)
    expect(rawFetchedPaths.filter(p => p === "commands/build.md").length).toBe(1);
  });

  it("handles an empty tree gracefully — no skill files found error", async () => {
    const tree: { path: string; type: string }[] = [];
    global.fetch = buildFetchMock(tree) as typeof global.fetch;

    const { importSkillFromUrl } = await import("../services/skills-import");
    await expect(
      importSkillFromUrl("https://github.com/empty-owner/empty-repo")
    ).rejects.toThrow(/No skill files found/);
  });

  it("does not pick up deeply nested paths (more than one subdir level)", async () => {
    const tree: { path: string; type: string }[] = [
      { path: "skills/react", type: "tree" },
      { path: "skills/react/SKILL.md", type: "blob" },
      { path: "skills/react/examples", type: "tree" },
      { path: "skills/react/examples/hooks.md", type: "blob" },   // too deep
      { path: "skills/react/examples/context.md", type: "blob" }, // too deep
    ];

    const rawFetchedPaths: string[] = [];
    global.fetch = vi.fn(async (url: string | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : (url as Request).url;
      if (urlStr.includes("raw.githubusercontent.com")) {
        const m = urlStr.match(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\/(.+)$/);
        if (m) rawFetchedPaths.push(m[1]);
        return new Response(null, { status: 404 });
      }
      return buildFetchMock(tree)(url, init);
    }) as typeof global.fetch;

    const { importSkillFromUrl } = await import("../services/skills-import");
    try {
      await importSkillFromUrl("https://github.com/test-owner/deep-repo");
    } catch {
      // Expected — no raw files found
    }

    expect(rawFetchedPaths).toContain("skills/react/SKILL.md");
    expect(rawFetchedPaths).not.toContain("skills/react/examples/hooks.md");
    expect(rawFetchedPaths).not.toContain("skills/react/examples/context.md");
  });
});
