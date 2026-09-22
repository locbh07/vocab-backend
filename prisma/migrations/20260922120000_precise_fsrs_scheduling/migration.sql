-- Vocabulary reviews previously used a DATE column, which discarded FSRS's
-- sub-day due time (for example, a 10-minute relearning interval). Existing
-- values were written as Asia/Tokyo wall-clock timestamps, so preserve that
-- interpretation while converting them to absolute instants.
ALTER TABLE "user_vocab_progress"
  ALTER COLUMN "next_review_date" TYPE TIMESTAMPTZ(6)
    USING "next_review_date"::timestamp AT TIME ZONE 'Asia/Tokyo',
  ALTER COLUMN "last_reviewed_at" TYPE TIMESTAMPTZ(6)
    USING "last_reviewed_at" AT TIME ZONE 'Asia/Tokyo';

-- ts-fsrs needs the current learning-step index to continue learning and
-- relearning sequences correctly after a request or server restart.
ALTER TABLE "user_vocab_progress"
  ADD COLUMN "learning_steps" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE IF EXISTS "user_kanji_progress"
  ADD COLUMN IF NOT EXISTS "learning_steps" INTEGER NOT NULL DEFAULT 0;
