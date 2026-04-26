-- migration.sql
-- Run this ONCE in the Supabase SQL editor.
-- Adds address verification workflow + resets existing parsed addresses so the
-- new parser can re-extract them on the next sync.

-- ── 1. Add new columns to locations ─────────────────────────────────────────

ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS address_verified  BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS address_candidates JSONB,
  ADD COLUMN IF NOT EXISTS address_cross     TEXT,
  ADD COLUMN IF NOT EXISTS zip               TEXT,
  ADD COLUMN IF NOT EXISTS notes_override    BOOLEAN DEFAULT FALSE;

-- Index for the "needs verification" query
CREATE INDEX IF NOT EXISTS idx_locations_unverified
  ON locations (address_verified)
  WHERE address_verified = FALSE;

-- ── 2. Reset existing parsed addresses ──────────────────────────────────────
-- Per user choice: re-extract everything with the new parser, mark unverified.
-- This preserves notes (the source of truth) but clears the parser's previous output.
-- Manually-edited addresses (notes_override = TRUE) are preserved & marked verified.

UPDATE locations
SET
  address           = NULL,
  city              = NULL,
  state_code        = NULL,
  address_cross     = NULL,
  zip               = NULL,
  geocode_query     = NULL,
  -- Keep lat/lng so the map still has pins; user can re-geocode after verify
  address_verified  = FALSE,
  address_candidates = NULL
WHERE COALESCE(notes_override, FALSE) = FALSE;

-- For locations the user manually edited, trust them
UPDATE locations
SET address_verified = TRUE
WHERE COALESCE(notes_override, FALSE) = TRUE
  AND address IS NOT NULL;

-- ── 3. Optional: reset sync_log so next sync does a clean pass ──────────────
-- Uncomment if you want to force a full re-sync after migration:
-- UPDATE sync_log SET last_sync = NULL WHERE id = 1;
