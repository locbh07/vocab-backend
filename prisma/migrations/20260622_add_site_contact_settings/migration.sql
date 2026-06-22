CREATE TABLE IF NOT EXISTS "site_contact_settings" (
  "id" SMALLINT PRIMARY KEY,
  "eyebrow" VARCHAR(80) NOT NULL,
  "title" VARCHAR(200) NOT NULL,
  "description" TEXT NOT NULL,
  "email" VARCHAR(255),
  "phone" VARCHAR(50),
  "address" VARCHAR(500),
  "updated_by" BIGINT REFERENCES "useraccount"("id") ON DELETE SET NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "site_contact_channel" (
  "id" BIGSERIAL PRIMARY KEY,
  "platform" VARCHAR(30) NOT NULL,
  "label" VARCHAR(80) NOT NULL,
  "handle" VARCHAR(120),
  "url" TEXT,
  "qr_image" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "sort_order" INT NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_site_contact_channel_order"
  ON "site_contact_channel"("enabled", "sort_order", "id");

INSERT INTO "site_contact_settings" ("id", "eyebrow", "title", "description")
VALUES (
  1,
  'Kết nối với chúng tôi',
  'Đồng hành trên hành trình học tiếng Nhật',
  'Theo dõi các kênh chính thức hoặc liên hệ trực tiếp khi bạn cần hỗ trợ.'
)
ON CONFLICT ("id") DO NOTHING;
