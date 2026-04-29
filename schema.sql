-- ============================================================
-- RAPTOR COUNT — Supabase schema
-- Run this entire file in the Supabase SQL Editor
-- ============================================================

-- Daily summary snapshots
CREATE TABLE IF NOT EXISTS snapshots (
  id            SERIAL PRIMARY KEY,
  snap_date     DATE NOT NULL UNIQUE,
  total         INTEGER NOT NULL DEFAULT 0,
  raptor        INTEGER NOT NULL DEFAULT 0,
  raptor_r      INTEGER NOT NULL DEFAULT 0,
  wti_price     NUMERIC(8,2),
  commentary    TEXT,
  scraped_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Individual vehicles tracked by VIN
-- One row per VIN per day seen — lets us track new arrivals vs lingering stock
CREATE TABLE IF NOT EXISTS vehicles (
  id            SERIAL PRIMARY KEY,
  vin           TEXT NOT NULL,
  model_year    INTEGER,
  model         TEXT,         -- 'F-150' or 'Ranger'
  trim          TEXT,         -- 'Raptor' or 'Raptor R'
  color         TEXT,
  msrp          NUMERIC(10,2),
  dealer_name   TEXT,
  dealer_city   TEXT,
  dealer_state  TEXT,
  dealer_url    TEXT,
  vehicle_url   TEXT,         -- direct link to this truck on dealer site
  first_seen    DATE NOT NULL,
  last_seen     DATE NOT NULL,
  active        BOOLEAN DEFAULT TRUE,
  UNIQUE(vin)
);

-- Daily log of which VINs were seen each day (for trend tracking)
CREATE TABLE IF NOT EXISTS vehicle_daily (
  id            SERIAL PRIMARY KEY,
  snap_date     DATE NOT NULL,
  vin           TEXT NOT NULL,
  dealer_name   TEXT,
  UNIQUE(snap_date, vin)
);

-- Donations tracker (display only — actual payments via Stripe)
CREATE TABLE IF NOT EXISTS donations (
  id            SERIAL PRIMARY KEY,
  amount_cents  INTEGER NOT NULL,
  display_name  TEXT DEFAULT 'Anonymous',
  message       TEXT,
  donated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_snap_date    ON snapshots(snap_date DESC);
CREATE INDEX IF NOT EXISTS idx_veh_active   ON vehicles(active, trim);
CREATE INDEX IF NOT EXISTS idx_vdaily_date  ON vehicle_daily(snap_date DESC);
CREATE INDEX IF NOT EXISTS idx_donations    ON donations(donated_at DESC);

-- Row Level Security: public can read everything, only service role can write
ALTER TABLE snapshots     ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE donations     ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read snapshots"     ON snapshots     FOR SELECT USING (true);
CREATE POLICY "public read vehicles"      ON vehicles      FOR SELECT USING (true);
CREATE POLICY "public read vehicle_daily" ON vehicle_daily FOR SELECT USING (true);
CREATE POLICY "public read donations"     ON donations     FOR SELECT USING (true);

-- Only service_role key can write (your cron job uses this key)
CREATE POLICY "service write snapshots"     ON snapshots     FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service write vehicles"      ON vehicles      FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service write vehicle_daily" ON vehicle_daily FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service write donations"     ON donations     FOR ALL USING (auth.role() = 'service_role');
