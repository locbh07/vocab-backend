CREATE TABLE IF NOT EXISTS "page_comment" (
  "id" BIGSERIAL PRIMARY KEY,
  "user_id" BIGINT NOT NULL REFERENCES "useraccount"("id") ON DELETE CASCADE,
  "page_key" VARCHAR(300) NOT NULL,
  "page_url" TEXT,
  "content" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_page_comment_page_created"
  ON "page_comment"("page_key", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_page_comment_user_created"
  ON "page_comment"("user_id", "created_at" DESC);
