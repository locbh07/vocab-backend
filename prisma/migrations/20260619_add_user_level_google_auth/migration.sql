ALTER TABLE "useraccount"
  ADD COLUMN IF NOT EXISTS "level" VARCHAR(10),
  ADD COLUMN IF NOT EXISTS "google_id" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "auth_user_id" VARCHAR(255);

CREATE UNIQUE INDEX IF NOT EXISTS "useraccount_google_id_key" ON "useraccount"("google_id");
CREATE UNIQUE INDEX IF NOT EXISTS "useraccount_auth_user_id_key" ON "useraccount"("auth_user_id");
