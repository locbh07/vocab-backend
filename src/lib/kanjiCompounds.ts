import { prisma } from './prisma';

export type KanjiCompoundRecord = {
  kanji_char: string;
  word_ja: string;
  reading_kana: string;
  meaning_vi: string;
  meaning_en: string;
  hanviet_word: string;
  source: string;
  source_ref: string;
  priority: number;
};

type CompoundRow = {
  kanji_char: string;
  word_ja: string;
  reading_kana: string;
  meaning_vi: string;
  meaning_en: string;
  hanviet_word: string;
  source: string;
  source_ref: string;
  priority: number;
};

type CompoundCacheRow = {
  compounds_json: unknown;
};

const FAST_QUERY_SEED_MIN = 240;
const FAST_QUERY_SEED_MAX = 4000;

let ensureTablePromise: Promise<void> | null = null;

export async function ensureKanjiCompoundTable() {
  if (!ensureTablePromise) {
    ensureTablePromise = (async () => {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS kanji_compound (
          id BIGSERIAL PRIMARY KEY,
          kanji_char VARCHAR(8) NOT NULL,
          word_ja VARCHAR(255) NOT NULL,
          reading_kana VARCHAR(255) NOT NULL DEFAULT '',
          meaning_vi TEXT NOT NULL DEFAULT '',
          meaning_en TEXT NOT NULL DEFAULT '',
          hanviet_word VARCHAR(255) NOT NULL DEFAULT '',
          source VARCHAR(30) NOT NULL,
          source_ref VARCHAR(255) NOT NULL DEFAULT '',
          priority INT NOT NULL DEFAULT 1000,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await prisma.$executeRawUnsafe(`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_kanji_compound_unique
        ON kanji_compound(kanji_char, word_ja, reading_kana, source);
      `);
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_kanji_compound_char_priority
        ON kanji_compound(kanji_char, priority, word_ja);
      `);
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_kanji_compound_char_source_priority_word
        ON kanji_compound(kanji_char, source, priority, word_ja);
      `);
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS kanji_compound_lookup_cache (
          id BIGSERIAL PRIMARY KEY,
          kanji_char VARCHAR(8) NOT NULL,
          limit_size INT NOT NULL,
          compounds_json JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await prisma.$executeRawUnsafe(`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_kanji_compound_lookup_cache_key
        ON kanji_compound_lookup_cache(kanji_char, limit_size);
      `);
    })().catch((error) => {
      ensureTablePromise = null;
      throw error;
    });
  }
  return ensureTablePromise;
}

export async function replaceAllKanjiCompounds(rows: KanjiCompoundRecord[]) {
  await ensureKanjiCompoundTable();
  await prisma.$executeRawUnsafe('TRUNCATE TABLE kanji_compound');
  await clearKanjiCompoundLookupCache();
  await bulkUpsertKanjiCompounds(rows);
}

export async function bulkUpsertKanjiCompounds(rows: KanjiCompoundRecord[]) {
  await ensureKanjiCompoundTable();
  const normalized = rows
    .map((row) => normalizeRecord(row))
    .filter((row) => row !== null) as KanjiCompoundRecord[];
  const deduped = dedupeRecords(normalized);
  if (!deduped.length) return { upserted: 0 };

  const chunkSize = 500;
  let upserted = 0;
  for (let i = 0; i < deduped.length; i += chunkSize) {
    const chunk = deduped.slice(i, i + chunkSize);
    const params: unknown[] = [];
    const valuesSql = chunk
      .map((row, index) => {
        const base = index * 9;
        params.push(
          row.kanji_char,
          row.word_ja,
          row.reading_kana,
          row.meaning_vi,
          row.meaning_en,
          row.hanviet_word,
          row.source,
          row.source_ref,
          row.priority,
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`;
      })
      .join(', ');

    await prisma.$executeRawUnsafe(
      `
        INSERT INTO kanji_compound (
          kanji_char, word_ja, reading_kana, meaning_vi, meaning_en, hanviet_word,
          source, source_ref, priority
        )
        VALUES ${valuesSql}
        ON CONFLICT (kanji_char, word_ja, reading_kana, source)
        DO UPDATE SET
          meaning_vi = EXCLUDED.meaning_vi,
          meaning_en = EXCLUDED.meaning_en,
          hanviet_word = EXCLUDED.hanviet_word,
          source_ref = EXCLUDED.source_ref,
          priority = EXCLUDED.priority,
          updated_at = NOW()
      `,
      ...params,
    );
    upserted += chunk.length;
  }
  if (upserted > 0) {
    await clearKanjiCompoundLookupCache();
  }
  return { upserted };
}

export async function listKanjiCompounds(args: {
  kanji: string;
  limit?: number;
}): Promise<CompoundRow[]> {
  await ensureKanjiCompoundTable();
  const kanji = String(args.kanji || '').trim();
  if (!kanji) return [];
  const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(Number(args.limit), 200)) : 30;

  const cachedRows = await prisma.$queryRawUnsafe<Array<CompoundCacheRow>>(
    `
      SELECT compounds_json
      FROM kanji_compound_lookup_cache
      WHERE kanji_char = $1
        AND limit_size = $2
      LIMIT 1
    `,
    kanji,
    limit,
  );
  if (cachedRows.length > 0) {
    return asCompoundRows(cachedRows[0].compounds_json);
  }

  const seedLimit = Math.min(
    FAST_QUERY_SEED_MAX,
    Math.max(FAST_QUERY_SEED_MIN, limit * 40),
  );
  let rows = await prisma.$queryRawUnsafe<Array<CompoundRow>>(
    `
      WITH seed AS (
        SELECT
          kanji_char, word_ja, reading_kana, meaning_vi, meaning_en, hanviet_word, source, source_ref, priority
        FROM kanji_compound
        WHERE kanji_char = $1
        ORDER BY
          CASE
            WHEN COALESCE(meaning_vi, '') <> '' THEN 0
            WHEN COALESCE(meaning_en, '') <> '' THEN 1
            ELSE 2
          END,
          CASE source WHEN 'vocabulary' THEN 0 WHEN 'jmdict' THEN 1 ELSE 2 END,
          priority ASC,
          word_ja ASC
        LIMIT $3
      ),
      ranked AS (
        SELECT
          kanji_char, word_ja, reading_kana, meaning_vi, meaning_en, hanviet_word, source, source_ref, priority,
          ROW_NUMBER() OVER (
            PARTITION BY word_ja, reading_kana
            ORDER BY
              CASE source WHEN 'vocabulary' THEN 0 WHEN 'jmdict' THEN 1 ELSE 2 END,
              CASE WHEN COALESCE(meaning_vi, '') <> '' THEN 0 ELSE 1 END,
              priority ASC,
              word_ja ASC
          ) AS rn
        FROM seed
      )
      SELECT
        kanji_char, word_ja, reading_kana, meaning_vi, meaning_en, hanviet_word, source, source_ref, priority
      FROM ranked
      WHERE rn = 1
      ORDER BY
        CASE
          WHEN COALESCE(meaning_vi, '') <> '' THEN 0
          WHEN COALESCE(meaning_en, '') <> '' THEN 1
          ELSE 2
        END,
        priority ASC,
        word_ja ASC
      LIMIT $2
    `,
    kanji,
    limit,
    seedLimit,
  );

  // If seed window was not enough due to heavy duplicates, run full query for correctness.
  if (rows.length < limit) {
    rows = await prisma.$queryRawUnsafe<Array<CompoundRow>>(
    `
      WITH ranked AS (
        SELECT
          kanji_char, word_ja, reading_kana, meaning_vi, meaning_en, hanviet_word, source, source_ref, priority,
          ROW_NUMBER() OVER (
            PARTITION BY word_ja, reading_kana
            ORDER BY
              CASE source WHEN 'vocabulary' THEN 0 WHEN 'jmdict' THEN 1 ELSE 2 END,
              CASE WHEN COALESCE(meaning_vi, '') <> '' THEN 0 ELSE 1 END,
              priority ASC,
              word_ja ASC
          ) AS rn
        FROM kanji_compound
        WHERE kanji_char = $1
      )
      SELECT
        kanji_char, word_ja, reading_kana, meaning_vi, meaning_en, hanviet_word, source, source_ref, priority
      FROM ranked
      WHERE rn = 1
      ORDER BY
        CASE
          WHEN COALESCE(meaning_vi, '') <> '' THEN 0
          WHEN COALESCE(meaning_en, '') <> '' THEN 1
          ELSE 2
        END,
        priority ASC,
        word_ja ASC
      LIMIT $2
    `,
    kanji,
    limit,
  );
  }
  await saveCompoundLookupCache(kanji, limit, rows);
  return rows;
}

async function saveCompoundLookupCache(kanji: string, limit: number, rows: CompoundRow[]) {
  await prisma.$executeRawUnsafe(
    `
      INSERT INTO kanji_compound_lookup_cache (
        kanji_char, limit_size, compounds_json, created_at, updated_at
      )
      VALUES ($1, $2, $3::jsonb, NOW(), NOW())
      ON CONFLICT (kanji_char, limit_size)
      DO UPDATE SET
        compounds_json = EXCLUDED.compounds_json,
        updated_at = NOW()
    `,
    kanji,
    limit,
    JSON.stringify(rows),
  );
}

async function clearKanjiCompoundLookupCache() {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE kanji_compound_lookup_cache');
}

function normalizeRecord(row: KanjiCompoundRecord): KanjiCompoundRecord | null {
  const kanji_char = String(row.kanji_char || '').trim();
  const word_ja = String(row.word_ja || '').trim();
  if (!kanji_char || !word_ja) return null;
  return {
    kanji_char,
    word_ja,
    reading_kana: String(row.reading_kana || '').trim(),
    meaning_vi: String(row.meaning_vi || '').trim(),
    meaning_en: String(row.meaning_en || '').trim(),
    hanviet_word: String(row.hanviet_word || '').trim(),
    source: String(row.source || 'unknown').trim() || 'unknown',
    source_ref: String(row.source_ref || '').trim(),
    priority: Number.isFinite(row.priority) ? Number(row.priority) : 1000,
  };
}

function dedupeRecords(rows: KanjiCompoundRecord[]): KanjiCompoundRecord[] {
  const byKey = new Map<string, KanjiCompoundRecord>();
  rows.forEach((row) => {
    const key = `${row.kanji_char}||${row.word_ja}||${row.reading_kana}||${row.source}`;
    byKey.set(key, row);
  });
  return Array.from(byKey.values());
}

function asCompoundRows(value: unknown): CompoundRow[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((row) => {
      if (typeof row !== 'object' || row === null) return null;
      const item = row as Record<string, unknown>;
      return {
        kanji_char: String(item.kanji_char || '').trim(),
        word_ja: String(item.word_ja || '').trim(),
        reading_kana: String(item.reading_kana || '').trim(),
        meaning_vi: String(item.meaning_vi || '').trim(),
        meaning_en: String(item.meaning_en || '').trim(),
        hanviet_word: String(item.hanviet_word || '').trim(),
        source: String(item.source || '').trim(),
        source_ref: String(item.source_ref || '').trim(),
        priority: Number(item.priority || 0),
      };
    })
    .filter((row): row is CompoundRow => Boolean(row && row.kanji_char && row.word_ja));
}
