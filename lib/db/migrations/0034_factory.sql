-- RFC 0003 Phase 1 — Code Factory: products, work orders, stations.
--
-- A product is a repo with a roadmap that outlives any single session. Work
-- orders flow through stations (sessions with a role + capacity). WIP limits
-- bound concurrent work per product/station (Little's law).
CREATE TABLE IF NOT EXISTS products (
  id serial PRIMARY KEY,
  name text NOT NULL,
  repo_url text NOT NULL UNIQUE,
  roadmap_json jsonb NOT NULL DEFAULT '[]',
  wip_limit integer NOT NULL DEFAULT 4,
  quality_gate_config jsonb,
  pipeline_config jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS work_orders (
  id serial PRIMARY KEY,
  product_id integer NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  goal text NOT NULL,
  priority text NOT NULL DEFAULT 'normal',
  dependencies_json jsonb NOT NULL DEFAULT '[]',
  acceptance_criteria jsonb,
  assigned_station_id integer,
  status text NOT NULL DEFAULT 'queued',
  rework_count integer NOT NULL DEFAULT 0,
  last_defect_class text,
  session_id integer,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  started_at timestamp,
  completed_at timestamp
);

CREATE TABLE IF NOT EXISTS stations (
  id serial PRIMARY KEY,
  product_id integer NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  session_id integer,
  role text NOT NULL DEFAULT 'build',
  capacity integer NOT NULL DEFAULT 2,
  wip_limit integer NOT NULL DEFAULT 2,
  defect_count integer NOT NULL DEFAULT 0,
  rework_cycles integer NOT NULL DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
