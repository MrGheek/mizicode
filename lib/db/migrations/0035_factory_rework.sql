-- RFC 0003 Phase 2 — Code Factory: rework items.
--
-- A work order that fails a station gate (or the deliverable contract) is
-- routed to rework. Each rejection is recorded as a rework item so the defect
-- loop is tracked: producing station, defect class, cycle number, cleared-at.
CREATE TABLE IF NOT EXISTS rework_items (
  id serial PRIMARY KEY,
  work_order_id integer NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  station_id integer NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  defect_class text NOT NULL,
  cycle integer NOT NULL DEFAULT 1,
  created_at timestamp NOT NULL DEFAULT now(),
  cleared_at timestamp
);

CREATE INDEX IF NOT EXISTS rework_items_work_order_idx ON rework_items(work_order_id);
CREATE INDEX IF NOT EXISTS rework_items_station_idx ON rework_items(station_id);