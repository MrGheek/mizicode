import { describe, expect, it } from "vitest";
import {
  RETRIEVAL_SIMILARITY_FLOOR,
  isNearDuplicate,
  taskRelativeRerank,
  tokenJaccard,
  tokenize,
} from "../services/task-relative-rerank";

describe("tokenize / tokenJaccard", () => {
  it("splits on non-alphanumerics and lowercases", () => {
    expect([...tokenize("Auth::verifyJwt(token)")].sort()).toEqual(["auth", "token", "verifyjwt"]);
  });

  it("is 1.0 for identical text and 0 for disjoint text", () => {
    expect(tokenJaccard("run database migrations", "run database migrations")).toBe(1);
    expect(tokenJaccard("run database migrations", "helvetica neue font")) .toBe(0);
  });

  it("sits between for partial overlap", () => {
    const j = tokenJaccard("deploy runs migrations first", "deploys run migrations after");
    expect(j).toBeGreaterThan(0);
    expect(j).toBeLessThan(1);
  });
});

describe("isNearDuplicate — embedding reuse gate (RFC Layer 3 §11)", () => {
  it("reuses a stored vector when token overlap clears the threshold", () => {
    const a = "always run database migrations before production deploy";
    expect(isNearDuplicate(a, a)).toBe(true);

    // One word swaps a single token out of 40 → IoU 39/41 ≈ 0.951 ≥ 0.95.
    const alpha = Array.from({ length: 40 }, (_, i) => `alpha${String(i).padStart(3, "0")}`);
    const beta  = [...alpha];
    beta[7] = "zzz";
    expect(isNearDuplicate(alpha.join(" "), beta.join(" "))).toBe(true);
  });

  it("never reuses for genuinely different content", () => {
    expect(isNearDuplicate("always run database migrations before production deploy", "preferred font is helvetica neue")).toBe(false);
  });

  it("respects a custom threshold", () => {
    // Jaccard of the 10-slot alphabet vs one swap:
    const a = "alpha beta gamma delta epsilon zeta eta theta iota kappa"; // 10 unique tokens
    const b = "alpha beta gamma delta epsilon zeta eta theta iota omicron"; // 9 of 10 shared
    expect(tokenJaccard(a, b)).toBeCloseTo(9 / 11, 5); // inter=9, union=11
    expect(isNearDuplicate(a, b, { nearDupIou: 0.8 })).toBe(true);
    expect(isNearDuplicate(a, b, { nearDupIou: 0.95 })).toBe(false);
  });
});

describe("taskRelativeRerank — LLMLingua two-loss, task-relative", () => {
  const items = [
    { id: "db",   text: "run database migrations before deploy", base: 0.4 },
    { id: "ui",   text: "style the login button with helvetica", base: 0.5 },
    { id: "auth", text: "verify jwt token on every request",      base: 0.5 },
  ];

  it("lifts intent-close symbols above query-alone relevance", () => {
    const out = taskRelativeRerank(items, "database migrations must run before every production deploy", { floor: 0 });
    const ranked = out.map((r) => r.item.id);
    expect(ranked[0]).toBe("db"); // task-close beats ui's high base score
    expect(ranked).toContain("ui");
    expect(out.find((r) => r.item.id === "db")!.taskRelevance).toBeGreaterThan(
      out.find((r) => r.item.id === "ui")!.taskRelevance,
    );
  });

  it("drops candidates whose blend falls below the similarity floor", () => {
    const withJunk = [
      ...items,
      { id: "junk", text: "xray telemetry packet telemetry packet telemetry", base: 0.1 },
    ];
    const out = taskRelativeRerank(withJunk, "database migrations before deploy", { floor: 0.3 });
    // junk has no task-token overlap and a low base → blend 0.06 < floor → flagged.
    const junk = out.find((r) => r.item.id === "junk");
    expect(junk?.admitted).toBe(false);
    // Task-close and high-base symbols stay admitted.
    expect(out.find((r) => r.item.id === "db")!.admitted).toBe(true);
    expect(out.find((r) => r.item.id === "ui")!.admitted).toBe(true);
  });

  it("exports the default floor for retrieval gates", () => {
    expect(RETRIEVAL_SIMILARITY_FLOOR).toBe(0.05);
  });
});