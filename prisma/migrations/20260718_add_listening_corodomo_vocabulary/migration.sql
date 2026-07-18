CREATE TABLE IF NOT EXISTS listening_corodomo_vocabulary (
  id BIGSERIAL PRIMARY KEY,
  text TEXT NOT NULL,
  lang VARCHAR(10) NOT NULL DEFAULT 'ja',
  target_lang VARCHAR(10) NOT NULL DEFAULT 'vi',
  translation TEXT NOT NULL,
  pos TEXT,
  level VARCHAR(50),
  source_query TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT listening_corodomo_vocabulary_text_lang_uniq UNIQUE(text, lang, target_lang)
);

CREATE INDEX IF NOT EXISTS idx_listening_corodomo_vocabulary_lookup
  ON listening_corodomo_vocabulary (text, lang, target_lang);
