CREATE TABLE IF NOT EXISTS ai_review_job (
  id BIGSERIAL PRIMARY KEY,
  target_type VARCHAR(40) NOT NULL,
  status VARCHAR(30) NOT NULL,
  provider VARCHAR(40) NOT NULL DEFAULT 'gemini',
  model VARCHAR(100),
  filter_json JSONB,
  prompt_version INT NOT NULL DEFAULT 1,
  total INT NOT NULL DEFAULT 0,
  processed INT NOT NULL DEFAULT 0,
  failed INT NOT NULL DEFAULT 0,
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_review_job_target_status
ON ai_review_job (target_type, status, created_at);

CREATE TABLE IF NOT EXISTS ai_review_item (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT NOT NULL REFERENCES ai_review_job(id) ON DELETE CASCADE,
  target_type VARCHAR(40) NOT NULL,
  target_key VARCHAR(200) NOT NULL,
  status VARCHAR(30) NOT NULL,
  original_json JSONB NOT NULL,
  suggested_patch JSONB,
  suggestions JSONB,
  confidence DOUBLE PRECISION,
  error_message TEXT,
  applied_by BIGINT,
  applied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_review_item_job_target
ON ai_review_item (job_id, target_key);

CREATE INDEX IF NOT EXISTS idx_ai_review_item_job_status
ON ai_review_item (job_id, status);

CREATE INDEX IF NOT EXISTS idx_ai_review_item_target
ON ai_review_item (target_type, target_key);

CREATE TABLE IF NOT EXISTS ai_review_apply_log (
  id BIGSERIAL PRIMARY KEY,
  item_id BIGINT NOT NULL,
  target_type VARCHAR(40) NOT NULL,
  target_key VARCHAR(200) NOT NULL,
  before_json JSONB NOT NULL,
  patch_json JSONB NOT NULL,
  after_json JSONB NOT NULL,
  applied_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_review_apply_log_target
ON ai_review_apply_log (target_type, target_key, created_at);
