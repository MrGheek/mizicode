import { describe, expect, it } from "vitest";
import {
  EXTERNALIZE_THRESHOLD_INTENT_BYTES,
  EXTERNALIZE_THRESHOLD_BYTES,
  MemoryExternalizeStore,
  byteLength,
  buildPointerText,
  externalizeIfLarge,
  externalizeKey,
  formatBytes,
  semanticFilterTerminal,
} from "../services/hybrid-search";

const PYTEST_OUTPUT = [
  "$ pytest tests -q",
  "=========================== test session starts ============================",
  "collected 12 tests",
  "tests/test_auth.py::test_ok PASSED",
  "tests/test_auth.py::test_passenger PASSED",
  "tests/test_auth.py::test_suite_a PASSED",
  "tests/test_auth.py::test_token FAILED",
  "src/auth.py:12: in login",
  "    raise RuntimeError(\"boom\")",
  "E RuntimeError: boom",
  "",
  "========================= 3 passed, 1 failed in 0.8s ==========================",
  "exit code: 1",
].join("\n");

const MIXED_OUTPUT = [
  "async def _login(self, user: str) -> Token:",
  "from tests.utils import auth_token",
  "WARNING: flaky network", "WARNING: flaky network", "WARNING: flaky network",
  "-----",
  "-----",
  "-----",
  "src/auth.py:47:1: unused variable 'tmp'",
].join("\n");

describe("externalizeIfLarge", () => {
  it("keeps output below the threshold", async () => {
    const store = new MemoryExternalizeStore();
    const content = "x".repeat(1000);
    const d = await externalizeIfLarge({ source: "cmd:test", content, store });
    expect(d.kind).toBe("kept");
    if (d.kind === "kept") expect(d.sizeBytes).toBe(1000);
  });

  it("externalizes output above the default 100 KB threshold with a recoverable pointer", async () => {
    const store = new MemoryExternalizeStore();
    const content = "line\n".repeat(30_000);
    expect(byteLength(content)).toBeGreaterThan(EXTERNALIZE_THRESHOLD_BYTES);

    const d = await externalizeIfLarge({ source: "grep:src", content, store });
    expect(d.kind).toBe("externalized");
    if (d.kind !== "externalized") return;

    expect(store.size).toBe(1);
    expect(d.pointer).toContain("grep:src");
    expect(d.pointer).toContain(d.key);
    expect(d.bytesAvoided).toBe(d.sizeBytes - byteLength(d.pointer));
    expect(d.bytesAvoided).toBeGreaterThan(0);

    const recovered = await store.get(d.key);
    expect(recovered).toBe(content);
  });

  it("uses the lower 25 KB threshold when intentScoped", async () => {
    const store = new MemoryExternalizeStore();
    const content = "z".repeat(40 * 1024);
    expect(byteLength(content)).toBeGreaterThan(EXTERNALIZE_THRESHOLD_INTENT_BYTES);

    const scoped = await externalizeIfLarge({ source: "read:big.json", content, intentScoped: true, store });
    expect(scoped.kind).toBe("externalized");

    const unscoped = await externalizeIfLarge({ source: "read:big.json", content, store });
    expect(unscoped.kind).toBe("kept");
  });

  it("produces content-derived keys so identical blobs dedupe", async () => {
    const store = new MemoryExternalizeStore();
    const content = "same bytes ".repeat(5000);
    const k1 = await store.put({ source: "cmd:x", contentType: "tool-output", content });
    const k2 = await store.put({ source: "cmd:x", contentType: "tool-output", content });
    expect(k1).toBe(k2);
    expect(store.size).toBe(1);

    const other = content + "!";
    expect(externalizeKey("cmd:x", other)).not.toBe(k1);
  });
});

describe("externalize helpers", () => {
  it("formats bytes readably", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.00 MB");
  });

  it("points at both source and key", () => {
    const p = buildPointerText({ source: "cmd:lint", key: "cmd::lint::abcdef1234", sizeBytes: 3000 });
    expect(p).toContain("cmd:lint");
    expect(p).toContain("cmd::lint::abcdef1234");
  });
});

describe("MemoryExternalizeStore.search", () => {
  it("finds matching lines and scopes by source", async () => {
    const store = new MemoryExternalizeStore();
    await store.put({ source: "cmd:test-a", contentType: "tool-output", content: "alpha\nbeta\ngamma" });
    await store.put({ source: "cmd:test-b", contentType: "tool-output", content: "alpha only here" });

    const hits = await store.search("beta", {});
    expect(hits).toHaveLength(1);
    expect(hits[0].source).toBe("cmd:test-a");

    const scoped = await store.search("alpha", { source: "cmd:test-b" });
    expect(scoped).toHaveLength(1);
    expect(scoped[0].source).toBe("cmd:test-b");
  });
});

describe("semanticFilterTerminal — preservation contract", () => {
  it("preserves exit codes, path:line refs, signatures, imports, and failures", async () => {
    const r = await semanticFilterTerminal(MIXED_OUTPUT, { source: "claw:job-9:lint" });

    expect(r.preserved.exitCodes).toStrictEqual([]);
    // exit code lives in the pytest fixture; assert the preservation sets here.
    expect(r.preserved.signatures).toContain("async def _login(self, user: str) -> Token:");
    expect(r.preserved.imports).toContain("from tests.utils import auth_token");
    expect(r.preserved.pathLineRefs).toContain("src/auth.py:47:1");

    const c = r.condensed;
    expect(c).toContain("async def _login(self, user: str) -> Token:");
    expect(c).toContain("from tests.utils import auth_token");
    expect(c).toContain("src/auth.py:47:1");
    expect(c).toContain("unused variable");
  });

  it("collapses passing-test runs to a count while keeping failure + verdict-summary + exit code", async () => {
    const r = await semanticFilterTerminal(PYTEST_OUTPUT, { source: "claw:job-9:test" });

    const c = r.condensed;
    expect(c).not.toContain("tests/test_auth.py::test_ok PASSED");
    expect(c).not.toContain("tests/test_auth.py::test_passenger PASSED");
    expect(c).not.toContain("tests/test_auth.py::test_suite_a PASSED");
    expect(c).toContain("3 passing test line(s) (collapsed)");
    expect(c).toContain("tests/test_auth.py::test_token FAILED");
    expect(c).toContain("src/auth.py:12: in login");
    expect(c).toContain("E RuntimeError: boom");
    // Counts-summary carries digits → kept verbatim, not collapsed.
    expect(c).toContain("3 passed, 1 failed in 0.8s");

    expect(r.stats.passingTestsCollapsed).toBe(3);
    expect(r.preserved.pathLineRefs).toContain("src/auth.py:12");
    expect(r.preserved.exitCodes).toContain("exit code: 1");
  });

  it("dedupes consecutive duplicate lines and elides separator runs", async () => {
    const r = await semanticFilterTerminal(MIXED_OUTPUT, { source: "claw:job-9:lint" });

    expect(r.preserved.exitCodes).toStrictEqual([]);
    expect(r.stats.repeatedLinesDeduped).toBe(2); // "WARNING: flaky network" ×3 → 2 dropped
    expect(r.stats.ornamentRunsCollapsed).toBe(2); // "-----" ×3 → keep one marker, 2 elided
    expect(r.condensed).toContain("\u27f9 3\u00d7");
  });

  it("reports bytes avoided and consistent stats", async () => {
    const r = await semanticFilterTerminal(PYTEST_OUTPUT, { source: "claw:job-9:test" });
    expect(r.stats.bytesIn).toBeGreaterThan(r.stats.bytesOut);
    expect(r.stats.bytesAvoided).toBe(r.stats.bytesIn - r.stats.bytesOut);
    expect(r.stats.bytesAvoided).toBeGreaterThan(0);
  });
});

describe("tee-recovery", () => {
  it("persists the full unfiltered output and returns a re-readable pointer", async () => {
    const store = new MemoryExternalizeStore();
    const r = await semanticFilterTerminal(PYTEST_OUTPUT, { source: "claw:job-9:test", store });

    expect(r.originalKey).not.toBeNull();
    expect(r.pointer).toContain(r.originalKey as string);
    expect(r.condensed).not.toBe(PYTEST_OUTPUT);

    const recovered = await store.get(r.originalKey as string);
    expect(recovered).toBe(PYTEST_OUTPUT);
  });

  it("skips persistence when persistOriginal is false", async () => {
    const store = new MemoryExternalizeStore();
    const r = await semanticFilterTerminal(MIXED_OUTPUT, { source: "claw:x", store, persistOriginal: false });
    expect(r.originalKey).toBeNull();
    expect(r.pointer).toBeNull();
  });
});