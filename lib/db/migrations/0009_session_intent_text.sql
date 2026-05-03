-- Migration: add intent_text to sessions
-- Task #193: Natural-language session intent at launch
--
-- intent_text stores the optional natural-language description of what the
-- user is working on. It is captured by the launch dialog, shown as an
-- editable goal badge in the cockpit, seeded as the opening memory note, and
-- forwarded to bundle compilation as a soft ranking hint.
--
-- Idempotency guard: safe to re-run.

ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "intent_text" text;
