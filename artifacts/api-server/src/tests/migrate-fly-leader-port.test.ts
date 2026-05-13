/**
 * Unit tests for withFlyLeaderPort() in migrate.ts (Task #378).
 *
 * Covers:
 *   - Fly internal URL with no explicit port (default 5432) → swapped to 5433
 *   - Fly internal URL with explicit port 5432 → swapped to 5433
 *   - Fly internal URL already on port 5433 → no change
 *   - Non-Fly hostname → no change
 *   - MIGRATE_DATABASE_URL env var set → no change (early-return path)
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { withFlyLeaderPort } from "../migrate-helpers.js";

describe("withFlyLeaderPort", () => {
  beforeEach(() => {
    vi.stubEnv("MIGRATE_DATABASE_URL", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("swaps default-port Fly internal URL (.internal) to 5433", () => {
    const input = "postgres://user:pass@top1.nearest.of.myapp-db.internal/mydb";
    const result = withFlyLeaderPort(input);
    expect(new URL(result).port).toBe("5433");
  });

  it("swaps default-port Fly internal URL (.flycast) to 5433", () => {
    const input = "postgres://user:pass@myapp-db.flycast/mydb";
    const result = withFlyLeaderPort(input);
    expect(new URL(result).port).toBe("5433");
  });

  it("swaps explicit port 5432 on a Fly internal URL to 5433", () => {
    const input = "postgres://user:pass@top1.nearest.of.myapp-db.internal:5432/mydb";
    const result = withFlyLeaderPort(input);
    expect(new URL(result).port).toBe("5433");
  });

  it("leaves a Fly internal URL already on port 5433 unchanged", () => {
    const input = "postgres://user:pass@top1.nearest.of.myapp-db.internal:5433/mydb";
    const result = withFlyLeaderPort(input);
    expect(new URL(result).port).toBe("5433");
    expect(result).toBe(input);
  });

  it("does not modify a non-Fly hostname", () => {
    const input = "postgres://user:pass@db.example.com:5432/mydb";
    const result = withFlyLeaderPort(input);
    expect(result).toBe(input);
  });

  it("does not modify a localhost URL", () => {
    const input = "postgres://user:pass@localhost:5432/mydb";
    const result = withFlyLeaderPort(input);
    expect(result).toBe(input);
  });

  it("returns the string unchanged when MIGRATE_DATABASE_URL is set", () => {
    vi.stubEnv("MIGRATE_DATABASE_URL", "postgres://override:5432/overridedb");
    const input = "postgres://user:pass@top1.nearest.of.myapp-db.internal/mydb";
    const result = withFlyLeaderPort(input);
    expect(result).toBe(input);
  });
});
