-- Add per-token usage counters for NIM sessions billed by Vultr (and future
-- per-token providers). Both columns are nullable — null means no token data
-- has been reported yet (NVIDIA free endpoints, Vast.ai GPU sessions, etc.).
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS nim_tokens_in  integer,
  ADD COLUMN IF NOT EXISTS nim_tokens_out integer;
