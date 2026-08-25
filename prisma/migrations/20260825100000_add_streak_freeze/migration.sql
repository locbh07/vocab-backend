CREATE TABLE IF NOT EXISTS user_streak_freeze (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  freeze_date TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_user_streak_freeze_user_date UNIQUE (user_id, freeze_date)
);

CREATE INDEX IF NOT EXISTS idx_user_streak_freeze_user
ON user_streak_freeze(user_id);
