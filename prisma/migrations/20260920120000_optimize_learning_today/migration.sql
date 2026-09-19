-- Hot-path indexes for /learning/new-words, /learning/reviews, /learning/today
-- and /learning/dashboard. The first/third/fourth names also exist in older
-- databases created before Prisma migrations, so deployment remains idempotent.
CREATE INDEX IF NOT EXISTS idx_log_user_time
  ON user_review_log(user_id, review_time);

CREATE INDEX IF NOT EXISTS idx_user_review_log_user_mode_time
  ON user_review_log(user_id, mode, review_time DESC);

CREATE INDEX IF NOT EXISTS ix_uvp_user_mastered_nextreview
  ON user_vocab_progress(user_id, is_mastered, next_review_date);

CREATE INDEX IF NOT EXISTS ix_uvp_user_firstseen
  ON user_vocab_progress(user_id, first_seen_date);
