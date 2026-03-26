CREATE TABLE IF NOT EXISTS vocabulary_example (
  id BIGSERIAL PRIMARY KEY,
  vocab_id BIGINT NOT NULL REFERENCES vocabulary(id) ON DELETE CASCADE,
  order_index INT NOT NULL,
  example_ja TEXT,
  example_vi TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vocabulary_example_vocab_order
  ON vocabulary_example(vocab_id, order_index);

CREATE INDEX IF NOT EXISTS idx_vocabulary_example_vocab
  ON vocabulary_example(vocab_id);
