import { describe, expect, it } from "vitest";
import {
  detectManifestKind,
  mergeJsonManifests,
  mergeTomlManifests,
  structuralMergeManifest,
} from "../services/json-merge";

describe("mergeJsonManifests", () => {
  it("unions disjoint dependency additions from two lanes", () => {
    const base = JSON.stringify({ name: "app", dependencies: { lodash: "^4.17.0" } }, null, 2);
    const incoming = JSON.stringify({ name: "app", dependencies: { lodash: "^4.17.0", axios: "^1.0.0" } }, null, 2);
    const r = mergeJsonManifests(base, incoming);
    expect(r.status).toBe("merged");
    if (r.status !== "merged") return;
    const parsed = JSON.parse(r.content);
    expect(parsed.dependencies).toEqual({ lodash: "^4.17.0", axios: "^1.0.0" });
    expect(r.mergedKeys).toContain("dependencies.axios");
  });

  it("unions disjoint regions of the same manifest (pact 13/13 pattern)", () => {
    const base = JSON.stringify({ name: "app", dependencies: { a: "1" }, scripts: { build: "tsc" } }, null, 2);
    const laneA = JSON.stringify({ name: "app", dependencies: { a: "1", b: "2" }, scripts: { build: "tsc" } }, null, 2);
    const laneB = JSON.stringify({ name: "app", dependencies: { a: "1", c: "3" }, scripts: { build: "tsc", test: "vitest" } }, null, 2);

    const r1 = mergeJsonManifests(base, laneA);
    expect(r1.status).toBe("merged");
    const r2 = mergeJsonManifests(base, laneB);
    expect(r2.status).toBe("merged");

    // Both lanes' additions survive the structural merge.
    if (r1.status !== "merged" || r2.status !== "merged") return;
    const merged = mergeJsonManifests(r1.content, r2.content);
    expect(merged.status).toBe("merged");
    if (merged.status !== "merged") return;
    const parsed = JSON.parse(merged.content);
    expect(parsed.dependencies).toEqual({ a: "1", b: "2", c: "3" });
    expect(parsed.scripts).toEqual({ build: "tsc", test: "vitest" });
  });

  it("reports a conflict when a key differs on both sides", () => {
    const base = JSON.stringify({ dependencies: { lodash: "^4.17.0" } }, null, 2);
    const incoming = JSON.stringify({ dependencies: { lodash: "^5.0.0" } }, null, 2);
    const r = mergeJsonManifests(base, incoming);
    expect(r.status).toBe("conflict");
    if (r.status !== "conflict") return;
    expect(r.conflicts).toEqual([{ block: "dependencies", key: "lodash", ours: '"^4.17.0"', theirs: '"^5.0.0"' }]);
  });

  it("preserves non-dependency top-level fields", () => {
    const base = JSON.stringify({ name: "app", version: "1.0.0", dependencies: {} }, null, 2);
    const incoming = JSON.stringify({ name: "app", version: "1.0.0", dependencies: { x: "1" } }, null, 2);
    const r = mergeJsonManifests(base, incoming);
    expect(r.status).toBe("merged");
    if (r.status !== "merged") return;
    const parsed = JSON.parse(r.content);
    expect(parsed.name).toBe("app");
    expect(parsed.version).toBe("1.0.0");
  });
});

describe("mergeTomlManifests", () => {
  it("unions disjoint dependency additions in Cargo.toml", () => {
    const base = [
      "[package]",
      'name = "app"',
      "version = \"0.1.0\"",
      "",
      "[dependencies]",
      'serde = "1"',
    ].join("\n");
    const incoming = [
      "[package]",
      'name = "app"',
      "version = \"0.1.0\"",
      "",
      "[dependencies]",
      'serde = "1"',
      'tokio = { version = "1", features = ["full"] }',
    ].join("\n");

    const r = mergeTomlManifests(base, incoming);
    expect(r.status).toBe("merged");
    if (r.status !== "merged") return;
    expect(r.content).toContain('serde = "1"');
    expect(r.content).toContain('tokio = { version = "1", features = ["full"] }');
    expect(r.mergedKeys).toContain("dependencies.tokio");
  });

  it("preserves non-mergeable tables and comments verbatim", () => {
    const base = [
      "# top comment",
      "[package]",
      'name = "app"',
      "",
      "[dependencies]",
      'serde = "1"',
    ].join("\n");
    const incoming = [
      "# top comment",
      "[package]",
      'name = "app"',
      "",
      "[dependencies]",
      'serde = "1"',
      'anyhow = "1"',
    ].join("\n");

    const r = mergeTomlManifests(base, incoming);
    expect(r.status).toBe("merged");
    if (r.status !== "merged") return;
    expect(r.content).toContain("# top comment");
    expect(r.content).toContain('[package]');
    expect(r.content).toContain('name = "app"');
  });

  it("reports a conflict when a dependency version differs", () => {
    const base = "[dependencies]\nserde = \"1\"\n";
    const incoming = "[dependencies]\nserde = \"2\"\n";
    const r = mergeTomlManifests(base, incoming);
    expect(r.status).toBe("conflict");
    if (r.status !== "conflict") return;
    expect(r.conflicts).toEqual([{ block: "dependencies", key: "serde", ours: '"1"', theirs: '"2"' }]);
  });
});

describe("detectManifestKind / structuralMergeManifest", () => {
  it("detects supported manifests", () => {
    expect(detectManifestKind("package.json")).toBe("json");
    expect(detectManifestKind("Cargo.toml")).toBe("toml");
    expect(detectManifestKind("pyproject.toml")).toBe("toml");
    expect(detectManifestKind("src/index.ts")).toBeNull();
  });

  it("dispatches by file type", () => {
    const r = structuralMergeManifest("package.json", "{}", '{"dependencies":{"x":"1"}}');
    expect(r.status).toBe("merged");
    const t = structuralMergeManifest("Cargo.toml", "[dependencies]\n", "[dependencies]\nserde = \"1\"\n");
    expect(t.status).toBe("merged");
    const unsupported = structuralMergeManifest("src/index.ts", "a", "b");
    expect(unsupported.status).toBe("conflict");
  });
});