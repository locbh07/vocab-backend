/* eslint-disable no-console */
const fs = require("node:fs/promises");
const path = require("node:path");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const dataDir =
  process.env.LISTENING_DATA_DIR ||
  path.resolve(process.cwd(), "..", "vocab-frontend", "src", "data", "listening");
const corodomoVocabularyPath = path.join(dataDir, "corodomoVocabulary.json");
const BATCH_SIZE = Math.max(1, Number(process.env.CORODOMO_VOCAB_IMPORT_BATCH_SIZE || 500));

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeCorodomoVocabulary(vocabularyData) {
  const rawItems = vocabularyData?.data;
  const items = Array.isArray(rawItems)
    ? rawItems
    : rawItems && typeof rawItems === "object"
      ? Object.values(rawItems)
      : [];

  const out = [];
  const seen = new Set();
  for (const item of items) {
    const text = cleanText(item?.text);
    const lang = cleanText(item?.lang || "ja").toLowerCase() || "ja";
    const targetLang = cleanText(item?.targetLang || item?.target_lang || "vi").toLowerCase() || "vi";
    const translation = cleanText(item?.translation);
    const pos = cleanText(item?.pos);
    const level = cleanText(item?.level);
    const sourceQuery = cleanText(item?.sourceQuery || item?.source_query);
    if (!text || !translation || !/^[a-z]{2,10}$/i.test(lang) || !/^[a-z]{2,10}$/i.test(targetLang)) {
      continue;
    }
    const key = `${text}::${lang}::${targetLang}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text, lang, targetLang, translation, pos, level, sourceQuery });
  }
  return out;
}

function sqlQuote(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function ensureTable() {
  await prisma.$executeRawUnsafe(`
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
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE listening_corodomo_vocabulary
    ADD COLUMN IF NOT EXISTS pos TEXT;
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE listening_corodomo_vocabulary
    ADD COLUMN IF NOT EXISTS level VARCHAR(50);
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS idx_listening_corodomo_vocabulary_lookup
    ON listening_corodomo_vocabulary (text, lang, target_lang);
  `);
}

async function importBatch(items) {
  if (!items.length) return;
  const values = items
    .map(
      (item) =>
        `(${sqlQuote(item.text)}, ${sqlQuote(item.lang)}, ${sqlQuote(item.targetLang)}, ${sqlQuote(
          item.translation,
        )}, ${sqlQuote(item.pos)}, ${sqlQuote(item.level)}, ${sqlQuote(item.sourceQuery)}, NOW(), NOW())`,
    )
    .join(",\n");

  await prisma.$executeRawUnsafe(`
    INSERT INTO listening_corodomo_vocabulary (
      text, lang, target_lang, translation, pos, level, source_query, created_at, updated_at
    ) VALUES
    ${values}
    ON CONFLICT (text, lang, target_lang)
    DO UPDATE SET
      translation = EXCLUDED.translation,
      pos = EXCLUDED.pos,
      level = EXCLUDED.level,
      source_query = EXCLUDED.source_query,
      updated_at = NOW()
  `);
}

async function main() {
  await ensureTable();

  const raw = JSON.parse(await fs.readFile(corodomoVocabularyPath, "utf8"));
  const items = normalizeCorodomoVocabulary(raw);
  let imported = 0;

  for (let index = 0; index < items.length; index += BATCH_SIZE) {
    const batch = items.slice(index, index + BATCH_SIZE);
    await importBatch(batch);
    imported += batch.length;
    console.log(`Imported ${imported}/${items.length} Corodomo vocabulary rows`);
  }

  const countRows = await prisma.$queryRawUnsafe(
    "SELECT COUNT(*)::int AS count FROM listening_corodomo_vocabulary WHERE lang = 'ja' AND target_lang = 'vi'",
  );
  console.log(
    `Done. imported=${imported}, tableJaVi=${Number(countRows?.[0]?.count || 0)}. Source JSON was kept unchanged.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
