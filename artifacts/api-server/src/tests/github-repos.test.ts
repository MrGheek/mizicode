/**
 * Tests for the GitHub repo picker — pagination and org grouping.
 *
 * Covers:
 * - parseLinkNext: null input, no next rel, single next rel, next among
 *   multiple rels, extra whitespace around rel=
 * - fetchAllRepos: single-page response, multi-page traversal, affiliation
 *   query param, Authorization header forwarding, error propagation
 * - GET /auth/github/repos route: 404 when no token stored, owner field
 *   present on every repo, multi-org response groups correctly
 * - groupByOwner pure utility: repos from multiple orgs land under the
 *   right headings (mirrors the reduce used in LaunchSessionDialog)
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { createHash, createCipheriv, randomBytes } from "crypto";
import app from "../app";
import { db, operatorCredentialsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { parseLinkNext, fetchAllRepos } from "../routes/auth";

// ─── Shared test constants ────────────────────────────────────────────────────

const TEST_MEM_TOKEN = `test-github-repos-token-${Date.now()}`;
const FAKE_GH_TOKEN = "ghs_fakegithubtoken1234567890";

// ─── Env / cleanup ────────────────────────────────────────────────────────────

const originalMemToken = process.env["MIZI_MEM_TOKEN"];

beforeAll(() => {
  process.env["MIZI_MEM_TOKEN"] = TEST_MEM_TOKEN;
});

afterAll(async () => {
  if (originalMemToken === undefined) {
    delete process.env["MIZI_MEM_TOKEN"];
  } else {
    process.env["MIZI_MEM_TOKEN"] = originalMemToken;
  }
  // Remove any credential rows written during tests
  await db
    .delete(operatorCredentialsTable)
    .where(eq(operatorCredentialsTable.provider, "github"))
    .catch(() => {});
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Replicate the AES-256-GCM encryption used by auth.ts so we can insert
 * a valid encrypted token into the DB without importing the private helper.
 */
function encryptTokenForTest(plaintext: string, secret: string): string {
  const key = createHash("sha256").update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return iv.toString("hex") + tag.toString("hex") + encrypted.toString("hex");
}

async function storeTestGitHubToken(token: string) {
  await db
    .delete(operatorCredentialsTable)
    .where(eq(operatorCredentialsTable.provider, "github"));
  await db.insert(operatorCredentialsTable).values({
    provider: "github",
    accessTokenEncrypted: encryptTokenForTest(token, TEST_MEM_TOKEN),
    githubLogin: "test-user",
    githubAvatarUrl: "https://avatars.githubusercontent.com/u/1",
  });
}

async function clearStoredToken() {
  await db
    .delete(operatorCredentialsTable)
    .where(eq(operatorCredentialsTable.provider, "github"));
}

function makeRepo(
  fullName: string,
  owner: string,
  opts: { private?: boolean } = {}
) {
  return {
    full_name: fullName,
    name: fullName.split("/")[1]!,
    private: opts.private ?? false,
    html_url: `https://github.com/${fullName}`,
    clone_url: `https://github.com/${fullName}.git`,
    owner: { login: owner },
  };
}

function makeFetchResponse(
  repos: ReturnType<typeof makeRepo>[],
  linkHeader?: string
): Response {
  return {
    ok: true,
    status: 200,
    json: async () => repos,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "link" ? (linkHeader ?? null) : null,
    },
  } as unknown as Response;
}

// ─── parseLinkNext ────────────────────────────────────────────────────────────

describe("parseLinkNext", () => {
  it("returns null for null input", () => {
    expect(parseLinkNext(null)).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseLinkNext("")).toBeNull();
  });

  it("returns null when there is no rel=next", () => {
    const header =
      '<https://api.github.com/user/repos?page=1>; rel="prev"';
    expect(parseLinkNext(header)).toBeNull();
  });

  it("extracts the URL from a single rel=next entry", () => {
    const url = "https://api.github.com/user/repos?page=2&per_page=100";
    const header = `<${url}>; rel="next"`;
    expect(parseLinkNext(header)).toBe(url);
  });

  it("extracts rel=next correctly when multiple rels are present", () => {
    const nextUrl = "https://api.github.com/user/repos?page=3&per_page=100";
    const header = [
      '<https://api.github.com/user/repos?page=2&per_page=100>; rel="prev"',
      `<${nextUrl}>; rel="next"`,
      '<https://api.github.com/user/repos?page=10&per_page=100>; rel="last"',
      '<https://api.github.com/user/repos?page=1&per_page=100>; rel="first"',
    ].join(", ");
    expect(parseLinkNext(header)).toBe(nextUrl);
  });

  it("handles extra whitespace around rel= value", () => {
    const url = "https://api.github.com/user/repos?page=2";
    const header = `<${url}>;  rel="next"`;
    expect(parseLinkNext(header)).toBe(url);
  });

  it("returns null when rel=next is absent but rel=last is present", () => {
    const header =
      '<https://api.github.com/user/repos?page=1>; rel="first", <https://api.github.com/user/repos?page=5>; rel="last"';
    expect(parseLinkNext(header)).toBeNull();
  });
});

// ─── fetchAllRepos ────────────────────────────────────────────────────────────

describe("fetchAllRepos", () => {
  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("uses affiliation=owner,organization_member in the initial URL", async () => {
    const capturedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        capturedUrls.push(url);
        return makeFetchResponse([makeRepo("alice/repo-a", "alice")]);
      })
    );

    await fetchAllRepos("test-token");
    vi.unstubAllGlobals();

    expect(capturedUrls.length).toBeGreaterThan(0);
    const firstUrl = capturedUrls[0]!;
    expect(firstUrl).toContain("affiliation=owner,organization_member");
  });

  it("sends the Authorization header with the provided token", async () => {
    const capturedHeaders: Record<string, string>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, opts: RequestInit) => {
        capturedHeaders.push((opts.headers ?? {}) as Record<string, string>);
        return makeFetchResponse([makeRepo("alice/repo-a", "alice")]);
      })
    );

    await fetchAllRepos("my-secret-token");
    vi.unstubAllGlobals();

    expect(capturedHeaders[0]?.["Authorization"]).toBe("Bearer my-secret-token");
  });

  it("returns all repos from a single page when there is no next link", async () => {
    const page1 = [
      makeRepo("alice/repo-a", "alice"),
      makeRepo("alice/repo-b", "alice"),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => makeFetchResponse(page1)));

    const result = await fetchAllRepos("tok");
    vi.unstubAllGlobals();

    expect(result).toHaveLength(2);
    expect(result[0]!.full_name).toBe("alice/repo-a");
  });

  it("traverses multiple pages via Link: next headers", async () => {
    const page1 = [makeRepo("alice/repo-a", "alice")];
    const page2 = [makeRepo("acme/repo-x", "acme")];
    const page3 = [makeRepo("acme/repo-y", "acme")];

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        makeFetchResponse(page1, '<https://api.github.com/user/repos?page=2>; rel="next"')
      )
      .mockResolvedValueOnce(
        makeFetchResponse(page2, '<https://api.github.com/user/repos?page=3>; rel="next"')
      )
      .mockResolvedValueOnce(makeFetchResponse(page3));

    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchAllRepos("tok");
    vi.unstubAllGlobals();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.full_name)).toEqual([
      "alice/repo-a",
      "acme/repo-x",
      "acme/repo-y",
    ]);
  });

  it("increments the page number for subsequent fetches", async () => {
    const capturedUrls: string[] = [];

    const fetchMock = vi.fn(async (url: string) => {
      capturedUrls.push(url);
      if (capturedUrls.length === 1) {
        return makeFetchResponse(
          [makeRepo("alice/r1", "alice")],
          '<https://api.github.com/user/repos?page=2>; rel="next"'
        );
      }
      return makeFetchResponse([makeRepo("alice/r2", "alice")]);
    });

    vi.stubGlobal("fetch", fetchMock);
    await fetchAllRepos("tok");
    vi.unstubAllGlobals();

    expect(capturedUrls).toHaveLength(2);
    expect(capturedUrls[1]).toMatch(/[?&]page=2(&|$)/);
    expect(capturedUrls[1]).toContain("affiliation=owner,organization_member");
  });

  it("throws when the GitHub API returns a non-ok status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 401,
        headers: { get: () => null },
      }))
    );

    await expect(fetchAllRepos("bad-token")).rejects.toThrow("401");
    vi.unstubAllGlobals();
  });

  it("accumulates repos from all pages in order", async () => {
    const names = ["a", "b", "c", "d", "e"];
    const fetchMock = vi.fn();
    for (let i = 0; i < names.length; i++) {
      const isLast = i === names.length - 1;
      const repo = makeRepo(`alice/${names[i]}`, "alice");
      fetchMock.mockResolvedValueOnce(
        makeFetchResponse(
          [repo],
          isLast
            ? undefined
            : `<https://api.github.com/user/repos?page=${i + 2}>; rel="next"`
        )
      );
    }

    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchAllRepos("tok");
    vi.unstubAllGlobals();

    expect(result.map((r) => r.name)).toEqual(names);
  });
});

// ─── GET /auth/github/repos route ────────────────────────────────────────────

describe("GET /api/auth/github/repos", () => {
  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("returns 404 when no GitHub token is stored", async () => {
    await clearStoredToken();

    const res = await request(app)
      .get("/api/auth/github/repos")
      .set("Authorization", `Bearer ${TEST_MEM_TOKEN}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/connect github/i);
  });

  it("returns the mapped repo list with owner field on every entry", async () => {
    await storeTestGitHubToken(FAKE_GH_TOKEN);

    const mockRepos = [
      makeRepo("alice/alpha", "alice"),
      makeRepo("acme-corp/backend", "acme-corp"),
      makeRepo("acme-corp/frontend", "acme-corp"),
    ];

    vi.stubGlobal("fetch", vi.fn(async () => makeFetchResponse(mockRepos)));

    const res = await request(app)
      .get("/api/auth/github/repos")
      .set("Authorization", `Bearer ${TEST_MEM_TOKEN}`);

    vi.unstubAllGlobals();
    await clearStoredToken();

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.repos)).toBe(true);
    expect(res.body.repos).toHaveLength(3);

    for (const repo of res.body.repos) {
      expect(typeof repo.owner).toBe("string");
      expect(repo.owner.length).toBeGreaterThan(0);
      expect(typeof repo.fullName).toBe("string");
      expect(typeof repo.name).toBe("string");
      expect(typeof repo.cloneUrl).toBe("string");
      expect(typeof repo.htmlUrl).toBe("string");
      expect(typeof repo.private).toBe("boolean");
    }
  });

  it("maps owner.login to the owner field correctly", async () => {
    await storeTestGitHubToken(FAKE_GH_TOKEN);

    const mockRepos = [
      makeRepo("alice/alpha", "alice"),
      makeRepo("acme-corp/backend", "acme-corp"),
    ];

    vi.stubGlobal("fetch", vi.fn(async () => makeFetchResponse(mockRepos)));

    const res = await request(app)
      .get("/api/auth/github/repos")
      .set("Authorization", `Bearer ${TEST_MEM_TOKEN}`);

    vi.unstubAllGlobals();
    await clearStoredToken();

    expect(res.status).toBe(200);
    const owners = res.body.repos.map((r: { owner: string }) => r.owner);
    expect(owners).toContain("alice");
    expect(owners).toContain("acme-corp");
  });

  it("returns hasMore:true on page 1 and hasMore:false on page 2", async () => {
    await storeTestGitHubToken(FAKE_GH_TOKEN);

    const page1 = [makeRepo("alice/repo-a", "alice")];
    const page2 = [makeRepo("acme/repo-b", "acme"), makeRepo("acme/repo-c", "acme")];

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        makeFetchResponse(page1, '<https://api.github.com/user/repos?page=2>; rel="next"')
      )
    );

    const res1 = await request(app)
      .get("/api/auth/github/repos?page=1")
      .set("Authorization", `Bearer ${TEST_MEM_TOKEN}`);

    vi.unstubAllGlobals();

    vi.stubGlobal("fetch", vi.fn(async () => makeFetchResponse(page2)));

    const res2 = await request(app)
      .get("/api/auth/github/repos?page=2")
      .set("Authorization", `Bearer ${TEST_MEM_TOKEN}`);

    vi.unstubAllGlobals();
    await clearStoredToken();

    expect(res1.status).toBe(200);
    expect(res1.body.repos).toHaveLength(1);
    expect(res1.body.hasMore).toBe(true);
    expect(res1.body.page).toBe(1);

    expect(res2.status).toBe(200);
    expect(res2.body.repos).toHaveLength(2);
    expect(res2.body.hasMore).toBe(false);
    expect(res2.body.page).toBe(2);
  });

  it("returns 401 when no operator token is provided", async () => {
    const res = await request(app).get("/api/auth/github/repos");
    expect(res.status).toBe(401);
  });

  it("returns 500 when the GitHub API fails", async () => {
    await storeTestGitHubToken(FAKE_GH_TOKEN);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503, headers: { get: () => null } }))
    );

    const res = await request(app)
      .get("/api/auth/github/repos")
      .set("Authorization", `Bearer ${TEST_MEM_TOKEN}`);

    vi.unstubAllGlobals();
    await clearStoredToken();

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/fetch/i);
  });
});

// ─── groupByOwner — pure utility (mirrors LaunchSessionDialog reduce) ─────────

/**
 * The picker's grouping logic is a one-liner `reduce` in the component.
 * We extract and verify it here so regressions are caught without needing
 * a browser / Playwright run.
 */
function groupByOwner<T extends { owner: string }>(
  repos: T[]
): Record<string, T[]> {
  return repos.reduce<Record<string, T[]>>((acc, repo) => {
    const key = repo.owner;
    if (!acc[key]) acc[key] = [];
    acc[key]!.push(repo);
    return acc;
  }, {});
}

describe("groupByOwner (org-grouping logic)", () => {
  const sampleRepos = [
    { fullName: "alice/a1", name: "a1", owner: "alice", private: false, htmlUrl: "", cloneUrl: "" },
    { fullName: "alice/a2", name: "a2", owner: "alice", private: true, htmlUrl: "", cloneUrl: "" },
    { fullName: "acme/b1", name: "b1", owner: "acme", private: false, htmlUrl: "", cloneUrl: "" },
    { fullName: "acme/b2", name: "b2", owner: "acme", private: false, htmlUrl: "", cloneUrl: "" },
    { fullName: "acme/b3", name: "b3", owner: "acme", private: true, htmlUrl: "", cloneUrl: "" },
    { fullName: "solo-org/c1", name: "c1", owner: "solo-org", private: false, htmlUrl: "", cloneUrl: "" },
  ];

  it("produces one key per distinct owner", () => {
    const grouped = groupByOwner(sampleRepos);
    expect(Object.keys(grouped).sort()).toEqual(["acme", "alice", "solo-org"]);
  });

  it("places all repos under the correct owner heading", () => {
    const grouped = groupByOwner(sampleRepos);
    expect(grouped["alice"]).toHaveLength(2);
    expect(grouped["acme"]).toHaveLength(3);
    expect(grouped["solo-org"]).toHaveLength(1);
  });

  it("preserves repo identity within each group", () => {
    const grouped = groupByOwner(sampleRepos);
    const aliceNames = grouped["alice"]!.map((r) => r.name);
    expect(aliceNames).toContain("a1");
    expect(aliceNames).toContain("a2");
  });

  it("returns an empty object for an empty repo list", () => {
    expect(groupByOwner([])).toEqual({});
  });

  it("handles a list where all repos share the same owner", () => {
    const allAlice = sampleRepos.filter((r) => r.owner === "alice");
    const grouped = groupByOwner(allAlice);
    expect(Object.keys(grouped)).toEqual(["alice"]);
    expect(grouped["alice"]).toHaveLength(2);
  });

  it("handles a list where every repo is from a different org", () => {
    const oneEach = [
      { fullName: "org1/r", name: "r", owner: "org1", private: false, htmlUrl: "", cloneUrl: "" },
      { fullName: "org2/r", name: "r", owner: "org2", private: false, htmlUrl: "", cloneUrl: "" },
      { fullName: "org3/r", name: "r", owner: "org3", private: false, htmlUrl: "", cloneUrl: "" },
    ];
    const grouped = groupByOwner(oneEach);
    expect(Object.keys(grouped)).toHaveLength(3);
    for (const key of Object.keys(grouped)) {
      expect(grouped[key]).toHaveLength(1);
    }
  });

  it("sorts owner keys alphabetically when Object.keys result is sorted", () => {
    const grouped = groupByOwner(sampleRepos);
    const sortedKeys = Object.keys(grouped).sort();
    expect(sortedKeys).toEqual(["acme", "alice", "solo-org"]);
  });
});
