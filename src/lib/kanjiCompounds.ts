import { prisma } from './prisma';
import { translateKanjiCompoundMeaning } from './contentTranslation';

export type KanjiCompoundRecord = {
  kanji_char: string;
  word_ja: string;
  reading_kana: string;
  meaning_vi: string;
  meaning_en: string;
  meaning_zh: string;
  hanviet_word: string;
  source: string;
  source_ref: string;
  priority: number;
};

// Languages beyond vi/en/zh are never populated at import time (see bulkUpsertKanjiCompounds) —
// only ever written by scripts/backfill-kanji-compound-meaning-en.cjs after the fact. Kept off
// KanjiCompoundRecord (the import/write shape) on purpose so a re-run of the JMDict/vocabulary
// import can never accidentally wipe an already-backfilled meaning_<lang> value for these.
type ExtraCompoundLanguage = 'meaning_ko' | 'meaning_pt' | 'meaning_id' | 'meaning_ne' | 'meaning_my' | 'meaning_fil';
const EXTRA_COMPOUND_LANGUAGE_COLUMNS: ExtraCompoundLanguage[] = [
  'meaning_ko',
  'meaning_pt',
  'meaning_id',
  'meaning_ne',
  'meaning_my',
  'meaning_fil',
];

type CompoundRow = {
  id?: number;
  kanji_char: string;
  word_ja: string;
  reading_kana: string;
  meaning_vi: string;
  meaning_en: string;
  meaning_zh: string;
  hanviet_word: string;
  source: string;
  source_ref: string;
  priority: number;
} & Record<ExtraCompoundLanguage, string>;

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
          meaning_zh TEXT NOT NULL DEFAULT '',
          hanviet_word VARCHAR(255) NOT NULL DEFAULT '',
          source VARCHAR(30) NOT NULL,
          source_ref VARCHAR(255) NOT NULL DEFAULT '',
          priority INT NOT NULL DEFAULT 1000,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await prisma.$executeRawUnsafe(`
        ALTER TABLE kanji_compound
        ADD COLUMN IF NOT EXISTS meaning_zh TEXT NOT NULL DEFAULT '';
      `);
      await prisma.$executeRawUnsafe(`
        ALTER TABLE kanji_compound
        ADD COLUMN IF NOT EXISTS meaning_ko TEXT NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS meaning_pt TEXT NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS meaning_id TEXT NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS meaning_ne TEXT NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS meaning_my TEXT NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS meaning_fil TEXT NOT NULL DEFAULT '';
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
        const base = index * 10;
        params.push(
          row.kanji_char,
          row.word_ja,
          row.reading_kana,
          row.meaning_vi,
          row.meaning_en,
          row.meaning_zh,
          row.hanviet_word,
          row.source,
          row.source_ref,
          row.priority,
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10})`;
      })
      .join(', ');

    await prisma.$executeRawUnsafe(
      `
        INSERT INTO kanji_compound (
          kanji_char, word_ja, reading_kana, meaning_vi, meaning_en, meaning_zh, hanviet_word,
          source, source_ref, priority
        )
        VALUES ${valuesSql}
        ON CONFLICT (kanji_char, word_ja, reading_kana, source)
        DO UPDATE SET
          meaning_vi = EXCLUDED.meaning_vi,
          meaning_en = EXCLUDED.meaning_en,
          meaning_zh = EXCLUDED.meaning_zh,
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
  language?: string;
}): Promise<CompoundRow[]> {
  await ensureKanjiCompoundTable();
  const kanji = String(args.kanji || '').trim();
  if (!kanji) return [];
  const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(Number(args.limit), 200)) : 30;
  const language = args.language || 'vi';

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
    const rows = asCompoundRows(cachedRows[0].compounds_json);
    const translatedAny = await ensureCompoundMeanings(rows, language);
    if (translatedAny) await saveCompoundLookupCache(kanji, limit, rows);
    return rows;
  }

  // `priority` already encodes the vocabulary-vs-jmdict split by construction (build-kanji-
  // compounds.cjs assigns vocabulary-sourced rows `core_order` or `1_000_000 + id`, and jmdict
  // rows `2_000_000 + frequency_rank` — always a full magnitude higher), so sorting by
  // `priority ASC` alone already puts curated vocabulary entries before generic dictionary
  // ones, correctly ordered by frequency within each group. An earlier version of this query
  // additionally tie-broke on "does meaning_vi exist" before priority — that was redundant for
  // vocabulary-sourced rows (word_vi is essentially always populated there) but skewed jmdict
  // ordering: a less common jmdict word that happened to have a Mazii-matched Vietnamese gloss
  // would rank ahead of a genuinely more common one that didn't, and — since it checked
  // meaning_vi specifically, never meaning_en — did so identically regardless of which UI
  // language the request was for. Removed; `priority ASC` is both simpler and language-neutral.
  const seedLimit = Math.min(
    FAST_QUERY_SEED_MAX,
    Math.max(FAST_QUERY_SEED_MIN, limit * 40),
  );
  let rows = await prisma.$queryRawUnsafe<Array<CompoundRow>>(
    `
      WITH seed AS (
        SELECT
          id, kanji_char, word_ja, reading_kana, meaning_vi, meaning_en, meaning_zh, meaning_ko, meaning_pt, meaning_id, meaning_ne, meaning_my, meaning_fil, hanviet_word, source, source_ref, priority
        FROM kanji_compound
        WHERE kanji_char = $1
        ORDER BY priority ASC, word_ja ASC
        LIMIT $3
      ),
      ranked AS (
        SELECT
          id, kanji_char, word_ja, reading_kana, meaning_vi, meaning_en, meaning_zh, meaning_ko, meaning_pt, meaning_id, meaning_ne, meaning_my, meaning_fil, hanviet_word, source, source_ref, priority,
          ROW_NUMBER() OVER (
            PARTITION BY word_ja, reading_kana
            ORDER BY priority ASC, word_ja ASC
          ) AS rn
        FROM seed
      )
      SELECT
        id, kanji_char, word_ja, reading_kana, meaning_vi, meaning_en, meaning_zh, meaning_ko, meaning_pt, meaning_id, meaning_ne, meaning_my, meaning_fil, hanviet_word, source, source_ref, priority
      FROM ranked
      WHERE rn = 1
      ORDER BY priority ASC, word_ja ASC
      LIMIT $2
    `,
    kanji,
    limit,
    seedLimit,
  );
  normalizeCompoundRowIds(rows);

  // If seed window was not enough due to heavy duplicates, run full query for correctness.
  if (rows.length < limit) {
    rows = await prisma.$queryRawUnsafe<Array<CompoundRow>>(
    `
      WITH ranked AS (
        SELECT
          id, kanji_char, word_ja, reading_kana, meaning_vi, meaning_en, meaning_zh, meaning_ko, meaning_pt, meaning_id, meaning_ne, meaning_my, meaning_fil, hanviet_word, source, source_ref, priority,
          ROW_NUMBER() OVER (
            PARTITION BY word_ja, reading_kana
            ORDER BY priority ASC, word_ja ASC
          ) AS rn
        FROM kanji_compound
        WHERE kanji_char = $1
      )
      SELECT
        id, kanji_char, word_ja, reading_kana, meaning_vi, meaning_en, meaning_zh, meaning_ko, meaning_pt, meaning_id, meaning_ne, meaning_my, meaning_fil, hanviet_word, source, source_ref, priority
      FROM ranked
      WHERE rn = 1
      ORDER BY priority ASC, word_ja ASC
      LIMIT $2
    `,
    kanji,
    limit,
  );
  normalizeCompoundRowIds(rows);
  }
  await ensureCompoundMeanings(rows, language);
  await saveCompoundLookupCache(kanji, limit, rows);
  return rows;
}

// `id` is a Postgres BIGINT column, so $queryRawUnsafe deserializes it as a native JS `bigint`
// — JSON.stringify (used by saveCompoundLookupCache) can't serialize that and throws. Every
// other numeric-looking field here is already a plain number/string from Postgres; `id` is the
// only bigint in this row shape, so normalize it right after each raw query, before it can reach
// JSON.stringify or get handed to translateKanjiCompoundMeaning (which expects a JS number).
function normalizeCompoundRowIds(rows: CompoundRow[]): void {
  for (const row of rows) {
    if (typeof row.id === 'bigint') row.id = Number(row.id);
  }
}

// Lazy-translates whatever this specific request needs instead of requiring a bulk backfill
// job up front — keeps Supabase storage growth proportional to what real users actually browse
// per language, not to every compound row times every supported language. Mutates `rows` in
// place (so the cache write right after this call already includes the fresh translations) and
// returns whether anything was actually translated, so the caller knows whether a cache entry
// needs rewriting.
async function ensureCompoundMeanings(rows: CompoundRow[], language: string): Promise<boolean> {
  if (language === 'vi' || !rows.length) return false;
  const field = `meaning_${language}` as keyof CompoundRow;
  const missing = rows.filter((row) => row.id && !String(row[field] || '').trim());
  if (!missing.length) return false;

  const results = await Promise.all(
    missing.map(async (row) => ({ row, translated: await translateKanjiCompoundMeaning(row.id as number, language) })),
  );
  let any = false;
  for (const { row, translated } of results) {
    if (translated) {
      (row as Record<string, string>)[field] = translated;
      any = true;
    }
  }
  return any;
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
    meaning_zh: String(row.meaning_zh || '').trim(),
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
        id: Number.isFinite(Number(item.id)) ? Number(item.id) : undefined,
        kanji_char: String(item.kanji_char || '').trim(),
        word_ja: String(item.word_ja || '').trim(),
        reading_kana: String(item.reading_kana || '').trim(),
        meaning_vi: String(item.meaning_vi || '').trim(),
        meaning_en: String(item.meaning_en || '').trim(),
        meaning_zh: String(item.meaning_zh || '').trim(),
        ...Object.fromEntries(
          EXTRA_COMPOUND_LANGUAGE_COLUMNS.map((col) => [col, String(item[col] || '').trim()]),
        ),
        hanviet_word: String(item.hanviet_word || '').trim(),
        source: String(item.source || '').trim(),
        source_ref: String(item.source_ref || '').trim(),
        priority: Number(item.priority || 0),
      } as CompoundRow;
    })
    .filter((row): row is CompoundRow => Boolean(row && row.kanji_char && row.word_ja));
}
