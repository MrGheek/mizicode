-- RFC 0006 Phase 1 — Code Factory (fab): factories, station_claims, product
-- priority / due date / factory membership, and the shared lane pool with
-- claim/release. Stations become role definitions; executing sessions are
-- claimed from the pool at dispatch and released when idle.

CREATE TABLE IF NOT EXISTS factories (
  id serial PRIMARY KEY,
  name text NOT NULL,
  lane_pool_limit integer NOT NULL DEFAULT 8,
  budget_usd real,
  default_policy_json jsonb NOT NULL DEFAULT '{"defaultWipLimit":4,"defaultStationRoles":["build","review"],"defaultQualityGateConfig":null,"lanePool":{"idleReleaseAfterMs":300000,"claimLapseAfterMs":900000}}',
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

ALTER TABLE products ADD COLUMN IF NOT EXISTS factory_id integer REFERENCES factories(id) ON DELETE RESTRICT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS product_priority text NOT NULL DEFAULT 'p2';
ALTER TABLE products ADD COLUMN IF NOT EXISTS due_date timestamp;
ALTER TABLE products ADD COLUMN IF NOT EXISTS budget_usd real;

CREATE TABLE IF NOT EXISTS station_claims (
  id serial PRIMARY KEY,
  product_id integer NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  station_id integer NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  session_id integer NOT NULL,
  work_order_id integer,
  claimed_at timestamp NOT NULL DEFAULT now(),
  expires_at timestamp NOT NULL,
  last_heartbeat_at timestamp NOT NULL DEFAULT now(),
  released_at timestamp,
  active boolean NOT NULL DEFAULT true
);

-- A session (box) backs one station at a time; a station holds one claim.
CREATE UNIQUE INDEX IF NOT EXISTS station_claims_active_session_unique_idx ON station_claims(session_id) WHERE active = true;
CREATE UNIQUE INDEX IF NOT EXISTS station_claims_active_station_unique_idx ON station_claims(station_id) WHERE active = true;

CREATE INDEX IF NOT EXISTS station_claims_product_idx ON station_claims(product_id);

-- Backfill: one default fab hosts every existing product (the pilot fab).
INSERT INTO factories (name, lane_pool_limit, budget_usd)
SELECT 'Mizi Fab', 8, NULL
WHERE NOT EXISTS (SELECT 1 FROM factories);

UPDATE products
SET factory_id = (SELECT id FROM factories ORDER BY id LIMIT 1)
WHERE factory_id IS NULL;
