CREATE TABLE IF NOT EXISTS vocabulary_topic_translation (
  id BIGSERIAL PRIMARY KEY,
  topic VARCHAR(255) NOT NULL,
  language VARCHAR(10) NOT NULL,
  translation TEXT,
  provider VARCHAR(20) NOT NULL DEFAULT 'gemini',
  source_hash VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vocabulary_topic_translation_topic_language
ON vocabulary_topic_translation (topic, language);
