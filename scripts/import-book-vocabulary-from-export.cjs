/* eslint-disable no-console */
const fs = require('node:fs/promises');
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const DEFAULT_IGNORE = new Set(['all_vocabulary_merged.json', 'download_summary.json']);

function parseArgs(argv) {
  const args = { dataDir: process.env.VOCAB_BOOK_DATA_DIR || path.resolve(process.cwd(), 'tmp_vocab_export') };
  for (let i = 2; i < argv.length; i += 1) {
    const token = String(argv[i] || '').trim();
    if (!token) continue;
    if (token.startsWith('--data-dir=')) {
      args.dataDir = token.slice('--data-dir='.length).trim() || args.dataDir;
      continue;
    }
    if (token === '--data-dir' && i + 1 < argv.length) {
      args.dataDir = String(argv[i + 1] || '').trim() || args.dataDir;
      i += 1;
      continue;
    }
  }
  return args;
}

function detectLevelFromBook(sourceBook) {
  const text = String(sourceBook || '').toLowerCase();
  let m = text.match(/^n([1-5])$/);
  if (m) return `N${m[1]}`;
  m = text.match(/-n([1-5])(?:$|[^0-9])/);
  if (m) return `N${m[1]}`;
  m = text.match(/\bn([1-5])\b/);
  if (m) return `N${m[1]}`;
  return null;
}

function cleanText(value) {
  const text = String(value || '').trim();
  return text.length ? text : null;
}

function normalizeExamples(raw) {
  const out = [];
  const pushExample = (jaRaw, viRaw) => {
    const example_ja = cleanText(jaRaw);
    const example_vi = cleanText(viRaw);
    if (!example_ja && !example_vi) return;
    out.push({ example_ja, example_vi });
  };

  const list = Array.isArray(raw?.examples) ? raw.examples : [];
  for (const item of list) {
    pushExample(item?.jp || item?.ja || item?.example_ja, item?.vi || item?.example_vi);
  }

  if (!out.length) {
    pushExample(raw?.example_ja, raw?.example_vi);
  }

  return out.map((item, index) => ({ ...item, order_index: index + 1 }));
}

function normalizeItem(raw, sourceBook) {
  const wordJa = cleanText(raw?.word_ja);
  if (!wordJa) return null;

  const sourceUnit = cleanText(raw?.topic);
  const level = detectLevelFromBook(sourceBook);
  const examples = normalizeExamples(raw);
  const firstExample = examples[0] || null;

  return {
    word_ja: wordJa,
    word_hira_kana: cleanText(raw?.hiragana),
    word_romaji: cleanText(raw?.romaji),
    word_vi: cleanText(raw?.word_vi),
    example_ja: firstExample?.example_ja || null,
    example_vi: firstExample?.example_vi || null,
    topic: sourceUnit,
    level,
    image_url: null,
    audio_url: null,
    core_order: null,
    track: 'book',
    source_book: sourceBook,
    source_unit: sourceUnit,
    __examples: examples,
  };
}

function rowKey(row) {
  return [
    String(row.source_unit || ''),
    String(row.word_ja || ''),
    String(row.word_hira_kana || ''),
  ].join('||');
}

async function ensureColumns() {
  await prisma.$executeRawUnsafe(`
    ALTER TABLE vocabulary
    ADD COLUMN IF NOT EXISTS track VARCHAR(20) NOT NULL DEFAULT 'core',
    ADD COLUMN IF NOT EXISTS source_book VARCHAR(64),
    ADD COLUMN IF NOT EXISTS source_unit VARCHAR(64);
  `);
  await prisma.$executeRawUnsafe(`
    UPDATE vocabulary
    SET track = 'core'
    WHERE track IS NULL OR BTRIM(track) = '';
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS vocabulary_example (
      id BIGSERIAL PRIMARY KEY,
      vocab_id BIGINT NOT NULL REFERENCES vocabulary(id) ON DELETE CASCADE,
      order_index INT NOT NULL,
      example_ja TEXT,
      example_vi TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_vocabulary_example_vocab_order
    ON vocabulary_example(vocab_id, order_index);
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS idx_vocabulary_example_vocab
    ON vocabulary_example(vocab_id);
  `);
}

function splitRowAndExamples(row) {
  const examples = Array.isArray(row.__examples) ? row.__examples : [];
  const { __examples, ...vocabData } = row;
  return { vocabData, examples };
}

async function syncExamples(vocabId, examples) {
  await prisma.$executeRawUnsafe('DELETE FROM vocabulary_example WHERE vocab_id = $1', Number(vocabId));
  if (!examples.length) return;
  for (const item of examples) {
    await prisma.$executeRawUnsafe(
      `
      INSERT INTO vocabulary_example (vocab_id, order_index, example_ja, example_vi)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (vocab_id, order_index)
      DO UPDATE SET
        example_ja = EXCLUDED.example_ja,
        example_vi = EXCLUDED.example_vi,
        updated_at = NOW()
      `,
      Number(vocabId),
      Number(item.order_index),
      item.example_ja || null,
      item.example_vi || null,
    );
  }
}

async function upsertBookRows(sourceBook, rows) {
  const existingRows = await prisma.vocabulary.findMany({
    where: { track: 'book', source_book: sourceBook },
    select: {
      id: true,
      source_unit: true,
      word_ja: true,
      word_hira_kana: true,
    },
  });

  const existingByKey = new Map();
  for (const row of existingRows) {
    const key = rowKey(row);
    if (!existingByKey.has(key)) existingByKey.set(key, Number(row.id));
  }

  let created = 0;
  let updated = 0;
  const keepIds = new Set();
  const tasks = rows.map((row) => {
    const key = rowKey(row);
    const existingId = existingByKey.get(key);
    return existingId ? { kind: 'update', id: existingId, row } : { kind: 'create', row };
  });

  const batchSize = 50;
  for (let i = 0; i < tasks.length; i += batchSize) {
    const batch = tasks.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (task) => {
        const { vocabData, examples } = splitRowAndExamples(task.row);
        if (task.kind === 'update') {
          const id = Number(task.id);
          await prisma.vocabulary.update({
            where: { id: BigInt(id) },
            data: vocabData,
          });
          await syncExamples(id, examples);
          return { kind: 'update', id };
        }
        const createdRow = await prisma.vocabulary.create({ data: vocabData });
        await syncExamples(Number(createdRow.id), examples);
        return { kind: 'create', id: Number(createdRow.id) };
      }),
    );

    for (const result of results) {
      keepIds.add(result.id);
      if (result.kind === 'update') updated += 1;
      else created += 1;
    }
  }

  const keepList = Array.from(keepIds);
  const deleted = await prisma.vocabulary.deleteMany({
    where: {
      track: 'book',
      source_book: sourceBook,
      ...(keepList.length ? { id: { notIn: keepList.map((id) => BigInt(id)) } } : {}),
    },
  });

  return { created, updated, deleted: deleted.count };
}

async function loadBookFile(filePath, sourceBook) {
  const raw = await fs.readFile(filePath, 'utf8');
  const sanitized = String(raw || '').replace(/^\uFEFF/, '').trim();
  let data;
  try {
    data = JSON.parse(sanitized);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    throw new Error(`Invalid JSON in ${sourceBook} (${filePath}): ${message}`);
  }
  if (!Array.isArray(data)) return [];
  return data.map((item) => normalizeItem(item, sourceBook)).filter(Boolean);
}

async function main() {
  const args = parseArgs(process.argv);
  const dataDir = path.resolve(args.dataDir);

  await ensureColumns();

  const files = await fs.readdir(dataDir, { withFileTypes: true });
  const jsonFiles = files
    .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.json') && !DEFAULT_IGNORE.has(d.name))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));

  if (!jsonFiles.length) {
    console.log(`No book JSON files found in ${dataDir}`);
    return;
  }

  let totalCreated = 0;
  let totalUpdated = 0;
  let totalDeleted = 0;
  let totalRows = 0;
  let skippedFiles = 0;

  for (const fileName of jsonFiles) {
    const sourceBook = fileName.replace(/\.json$/i, '');
    const filePath = path.join(dataDir, fileName);
    let rows = [];
    try {
      rows = await loadBookFile(filePath, sourceBook);
    } catch (error) {
      skippedFiles += 1;
      const message = error && error.message ? error.message : String(error);
      console.warn(`[skip] ${sourceBook}: ${message}`);
      continue;
    }
    if (!rows.length) {
      console.log(`[skip] ${sourceBook}: no rows`);
      continue;
    }

    const result = await upsertBookRows(sourceBook, rows);
    totalRows += rows.length;
    totalCreated += result.created;
    totalUpdated += result.updated;
    totalDeleted += result.deleted;

    console.log(
      `[ok] ${sourceBook}: in=${rows.length}, created=${result.created}, updated=${result.updated}, deleted=${result.deleted}`,
    );
  }

  console.log('---');
  console.log(`Data dir: ${dataDir}`);
  console.log(`Rows processed: ${totalRows}`);
  console.log(`Created: ${totalCreated}`);
  console.log(`Updated: ${totalUpdated}`);
  console.log(`Deleted obsolete: ${totalDeleted}`);
  console.log(`Skipped files: ${skippedFiles}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
