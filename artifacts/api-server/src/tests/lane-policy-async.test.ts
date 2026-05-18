/**
 * Integration tests for the async lane-policy helpers that touch the database.
 * Covers getLanePolicyAsync and resolveValidLaneType.
 *
 * Creates the custom_lane_types table with IF NOT EXISTS so the tests work
 * regardless of whether migration 0023_custom_lane_types has been applied.
 */

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { db, customLaneTypesTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { getLanePolicyAsync, resolveValidLaneType } from "../services/lane-policy";

const CUSTOM_TYPE_NAME = `test-custom-async-${Date.now()}`;
const RESOLVE_TYPE_NAME = `test-resolve-async-${Date.now()}`;

beforeAll(async () => {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS custom_lane_types (
      id serial PRIMARY KEY,
      name text NOT NULL UNIQUE,
      description text NOT NULL DEFAULT '',
      max_concurrent_claims integer NOT NULL DEFAULT 20,
      heavy_job_slots integer NOT NULL DEFAULT 2,
      overlay_skill_ids_json jsonb,
      retrieval_emphasis_json jsonb,
      policy_token_mode text,
      design_categories_json jsonb,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    ALTER TABLE custom_lane_types
      ADD COLUMN IF NOT EXISTS overlay_skill_ids_json jsonb,
      ADD COLUMN IF NOT EXISTS retrieval_emphasis_json jsonb,
      ADD COLUMN IF NOT EXISTS policy_token_mode text,
      ADD COLUMN IF NOT EXISTS design_categories_json jsonb
  `);
});

async function removeCustomType(name: string) {
  await db.delete(customLaneTypesTable).where(eq(customLaneTypesTable.name, name));
}

// ─── getLanePolicyAsync ────────────────────────────────────────────────────────

describe("getLanePolicyAsync", () => {
  afterEach(async () => {
    await removeCustomType(CUSTOM_TYPE_NAME);
  });

  it("returns the built-in policy for a known lane type without a DB query", async () => {
    const policy = await getLanePolicyAsync("backend");
    expect(policy.laneType).toBe("backend");
  });

  it("returns a resolved policy for a custom type stored in the DB", async () => {
    await db.insert(customLaneTypesTable).values({
      name: CUSTOM_TYPE_NAME,
      description: "Async test custom type",
      maxConcurrentClaims: 7,
      heavyJobSlots: 1,
    });
    const policy = await getLanePolicyAsync(CUSTOM_TYPE_NAME);
    expect(policy.laneType).toBe(CUSTOM_TYPE_NAME);
    expect(policy.limits.maxConcurrentClaims).toBe(7);
    expect(policy.limits.heavyJobSlots).toBe(1);
  });

  it("falls back to the general policy for a type not in the DB", async () => {
    const policy = await getLanePolicyAsync("completely-unknown-type-xyz");
    expect(policy.laneType).toBe("general");
  });
});

// ─── resolveValidLaneType ──────────────────────────────────────────────────────

describe("resolveValidLaneType", () => {
  afterEach(async () => {
    await removeCustomType(RESOLVE_TYPE_NAME);
  });

  it("returns 'general' when laneType is undefined", async () => {
    const result = await resolveValidLaneType(undefined);
    expect(result).toBe("general");
  });

  it("returns the same string for a built-in lane type", async () => {
    expect(await resolveValidLaneType("ux")).toBe("ux");
    expect(await resolveValidLaneType("debug")).toBe("debug");
    expect(await resolveValidLaneType("backend")).toBe("backend");
    expect(await resolveValidLaneType("review")).toBe("review");
    expect(await resolveValidLaneType("general")).toBe("general");
  });

  it("returns the custom name when the type exists in the DB", async () => {
    await db.insert(customLaneTypesTable).values({
      name: RESOLVE_TYPE_NAME,
      description: "Resolve test",
      maxConcurrentClaims: 10,
      heavyJobSlots: 2,
    });
    const result = await resolveValidLaneType(RESOLVE_TYPE_NAME);
    expect(result).toBe(RESOLVE_TYPE_NAME);
  });

  it("returns 'general' for an unknown type not present in the DB", async () => {
    const result = await resolveValidLaneType("totally-unknown-xyz-999");
    expect(result).toBe("general");
  });
});
