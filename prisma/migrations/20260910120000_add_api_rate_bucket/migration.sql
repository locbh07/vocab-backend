CREATE TABLE "api_rate_bucket" (
  "key" VARCHAR(64) PRIMARY KEY,
  "count" INTEGER NOT NULL,
  "reset_at" TIMESTAMPTZ NOT NULL
);
CREATE INDEX "api_rate_bucket_reset_at_idx" ON "api_rate_bucket" ("reset_at");
ALTER TABLE "api_rate_bucket" ENABLE ROW LEVEL SECURITY;
