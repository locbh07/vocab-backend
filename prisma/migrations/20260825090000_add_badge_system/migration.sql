CREATE TABLE IF NOT EXISTS user_badge_unlock (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  badge_key VARCHAR(50) NOT NULL,
  unlocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_user_badge_unlock_user_badge UNIQUE (user_id, badge_key)
);

CREATE INDEX IF NOT EXISTS idx_user_badge_unlock_user
ON user_badge_unlock(user_id);
