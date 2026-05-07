-- Add symbol metadata column to lane_claims for symbol-level conflict detection.
-- Nullable JSONB array of symbol names (e.g. ["validateEmail", "parseDate"]).
-- Claims without this column fall back to file-path-level overlap detection.
ALTER TABLE "lane_claims" ADD COLUMN IF NOT EXISTS "claim_symbols" jsonb;
