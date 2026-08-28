ALTER TABLE user_vocab_progress
ADD COLUMN IF NOT EXISTS self_marked_known BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS user_daily_reminder_log (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  reminder_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_user_daily_reminder_log_user_date UNIQUE (user_id, reminder_date)
);

CREATE INDEX IF NOT EXISTS idx_user_daily_reminder_log_date
ON user_daily_reminder_log(reminder_date);
