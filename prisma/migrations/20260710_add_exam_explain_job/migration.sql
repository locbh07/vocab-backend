CREATE TABLE IF NOT EXISTS exam_explain_job (
  id BIGSERIAL PRIMARY KEY,
  level VARCHAR(5) NOT NULL,
  exam_id VARCHAR(10),
  exam_ids JSONB NOT NULL,
  parts JSONB NOT NULL,
  provider VARCHAR(20) NOT NULL DEFAULT 'gemini',
  force_refresh BOOLEAN NOT NULL DEFAULT FALSE,
  status VARCHAR(30) NOT NULL,
  current_exam_index INT NOT NULL DEFAULT 0,
  current_part_index INT NOT NULL DEFAULT 0,
  current_start_index INT NOT NULL DEFAULT 0,
  total_generated INT NOT NULL DEFAULT 0,
  total_skipped_cached INT NOT NULL DEFAULT 0,
  total_skipped_no_script INT NOT NULL DEFAULT 0,
  total_failed INT NOT NULL DEFAULT 0,
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_exam_explain_job_status
ON exam_explain_job (status, created_at);

CREATE TABLE IF NOT EXISTS exam_explain_job_log (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT NOT NULL REFERENCES exam_explain_job(id) ON DELETE CASCADE,
  level VARCHAR(5) NOT NULL,
  exam_id VARCHAR(10) NOT NULL,
  part INT NOT NULL,
  section_index INT,
  kind VARCHAR(20) NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_exam_explain_job_log_job
ON exam_explain_job_log (job_id, created_at);
