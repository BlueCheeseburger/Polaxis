-- Run once in Supabase SQL editor. Adds pin + archetype support to saved_points (now used as history).
ALTER TABLE saved_points
  ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS archetype TEXT;

CREATE INDEX IF NOT EXISTS saved_points_client_pinned_created_idx
  ON saved_points (client_id, pinned DESC, created_at DESC);
