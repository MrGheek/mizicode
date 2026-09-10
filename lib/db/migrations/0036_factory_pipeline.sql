-- RFC 0003 Phase 3 — Code Factory: pipeline runs + factory metrics.
--
-- The pipeline runs continuously per product (not per session). Each run is
-- triggered by a completed work order. Staged artifacts are the product's
-- shippable state; ship is gated on the product's quality_gate_config.
--
-- Factory metrics are periodic time-series snapshots capturing the factory's
-- state: throughput, cycle time, defect rate, rework rate, station utilization,
-- WIP occupancy, cost per work order.
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id serial PRIMARY KEY,
  product_id integer NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  trigger_work_order_id integer REFERENCES work_orders(id) ON DELETE SET NULL,
  stage text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  started_at timestamp,
  completed_at timestamp,
  artifacts_json jsonb DEFAULT '[]',
  gate_passed boolean DEFAULT false,
  gate_detail text,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pipeline_runs_product_idx ON pipeline_runs(product_id);
CREATE INDEX IF NOT EXISTS pipeline_runs_trigger_idx ON pipeline_runs(trigger_work_order_id);

CREATE TABLE IF NOT EXISTS factory_metrics (
  id serial PRIMARY KEY,
  product_id integer NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  snapshot_time timestamp NOT NULL DEFAULT now(),
  snapshot_json jsonb NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS factory_metrics_product_time_idx ON factory_metrics(product_id, snapshot_time DESC);