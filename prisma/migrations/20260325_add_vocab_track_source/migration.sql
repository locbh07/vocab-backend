-- Add vocabulary segmentation fields for core/book tracks.
ALTER TABLE vocabulary
  ADD COLUMN IF NOT EXISTS track VARCHAR(20) NOT NULL DEFAULT 'core',
  ADD COLUMN IF NOT EXISTS source_book VARCHAR(64),
  ADD COLUMN IF NOT EXISTS source_unit VARCHAR(64);

UPDATE vocabulary
SET track = 'core'
WHERE track IS NULL OR BTRIM(track) = '';

CREATE INDEX IF NOT EXISTS idx_vocabulary_track_core_order
  ON vocabulary(track, core_order, id);

CREATE INDEX IF NOT EXISTS idx_vocabulary_track_source_book_unit
  ON vocabulary(track, source_book, source_unit, id);

-- Persist learning scope (core/book + book filters) on user plans.
ALTER TABLE user_learning_plan
  ADD COLUMN IF NOT EXISTS track VARCHAR(20) NOT NULL DEFAULT 'core',
  ADD COLUMN IF NOT EXISTS source_book VARCHAR(64),
  ADD COLUMN IF NOT EXISTS source_unit VARCHAR(64);

UPDATE user_learning_plan
SET track = 'core'
WHERE track IS NULL OR BTRIM(track) = '';

CREATE INDEX IF NOT EXISTS idx_user_learning_plan_user_active_track
  ON user_learning_plan(user_id, is_active, track, id DESC);
