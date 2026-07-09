DO $$ BEGIN
  CREATE TYPE "UserPlan" AS ENUM ('FREE', 'PREMIUM');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "useraccount"
  ADD COLUMN IF NOT EXISTS "plan" "UserPlan" NOT NULL DEFAULT 'FREE',
  ADD COLUMN IF NOT EXISTS "premium_valid_until" TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS "stripe_customer_id" VARCHAR(255) NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "useraccount_stripe_customer_id_key"
  ON "useraccount" ("stripe_customer_id");

ALTER TABLE "vocabulary"
  ADD COLUMN IF NOT EXISTS "is_free_preview" BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE "grammar"
  ADD COLUMN IF NOT EXISTS "is_free_preview" BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE "listening_video"
  ADD COLUMN IF NOT EXISTS "is_free_preview" BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS "stripe_webhook_event" (
  "id" BIGSERIAL PRIMARY KEY,
  "event_id" VARCHAR(255) NOT NULL UNIQUE,
  "event_type" VARCHAR(120) NOT NULL,
  "processed_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
