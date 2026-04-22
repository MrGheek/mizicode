-- Migration: add embeddings storage to session_repo_context
-- Task #48: Add vector embeddings to repo search so results match by meaning
--
-- Adds two columns to session_repo_context:
--   embeddings_json: stores serialised {ref, vec}[] from the indexer's vector phase
--   has_embeddings:  boolean flag so queries can quickly check if vectors are available
--
-- Uses IF NOT EXISTS / safe re-execution pattern.

ALTER TABLE "session_repo_context"
  ADD COLUMN IF NOT EXISTS "embeddings_json" jsonb;

ALTER TABLE "session_repo_context"
  ADD COLUMN IF NOT EXISTS "has_embeddings" boolean NOT NULL DEFAULT false;

ALTER TABLE "session_repo_context"
  ADD COLUMN IF NOT EXISTS "embedding_dim" integer;
