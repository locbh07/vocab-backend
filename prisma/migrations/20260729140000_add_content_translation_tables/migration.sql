CREATE TABLE IF NOT EXISTS vocabulary_translation (
  id BIGSERIAL PRIMARY KEY,
  vocab_id BIGINT NOT NULL REFERENCES vocabulary(id) ON DELETE CASCADE,
  language VARCHAR(10) NOT NULL,
  word TEXT,
  example TEXT,
  provider VARCHAR(20) NOT NULL DEFAULT 'gemini',
  source_hash VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vocabulary_translation_vocab_language
ON vocabulary_translation (vocab_id, language);

CREATE INDEX IF NOT EXISTS idx_vocabulary_translation_vocab_id
ON vocabulary_translation (vocab_id);

CREATE TABLE IF NOT EXISTS vocabulary_example_translation (
  id BIGSERIAL PRIMARY KEY,
  vocab_example_id BIGINT NOT NULL REFERENCES vocabulary_example(id) ON DELETE CASCADE,
  language VARCHAR(10) NOT NULL,
  example TEXT,
  provider VARCHAR(20) NOT NULL DEFAULT 'gemini',
  source_hash VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vocabulary_example_translation_example_language
ON vocabulary_example_translation (vocab_example_id, language);

CREATE INDEX IF NOT EXISTS idx_vocabulary_example_translation_example_id
ON vocabulary_example_translation (vocab_example_id);

CREATE TABLE IF NOT EXISTS grammar_translation (
  id BIGSERIAL PRIMARY KEY,
  grammar_id BIGINT NOT NULL REFERENCES grammar(grammar_id) ON DELETE CASCADE,
  language VARCHAR(10) NOT NULL,
  meaning TEXT,
  usage_text TEXT,
  note TEXT,
  provider VARCHAR(20) NOT NULL DEFAULT 'gemini',
  source_hash VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_grammar_translation_grammar_language
ON grammar_translation (grammar_id, language);

CREATE INDEX IF NOT EXISTS idx_grammar_translation_grammar_id
ON grammar_translation (grammar_id);

CREATE TABLE IF NOT EXISTS grammar_usage_translation (
  id BIGSERIAL PRIMARY KEY,
  usage_id BIGINT NOT NULL REFERENCES grammar_usage(usage_id) ON DELETE CASCADE,
  language VARCHAR(10) NOT NULL,
  example TEXT,
  provider VARCHAR(20) NOT NULL DEFAULT 'gemini',
  source_hash VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_grammar_usage_translation_usage_language
ON grammar_usage_translation (usage_id, language);

CREATE INDEX IF NOT EXISTS idx_grammar_usage_translation_usage_id
ON grammar_usage_translation (usage_id);
