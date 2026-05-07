-- Add unique index on operator_credentials(provider) to ensure only one
-- credential per provider can exist (enforces single-operator invariant at DB level).
CREATE UNIQUE INDEX IF NOT EXISTS "operator_credentials_provider_unique"
  ON "operator_credentials" ("provider");
