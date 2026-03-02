require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const LEVEL_ORDER = ['N5', 'N4', 'N3', 'N2', 'N1'];
const SOURCE_BOOK_BY_LEVEL = {
  N5: 'minna1',
  N4: 'minna2',
  N3: 'shinkanzen_n3',
  N2: 'shinkanzen_n2',
  N1: 'shinkanzen_n1',
};

function normalizePoint(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[〜～]/g, '~')
    .replace(/[（）\(\)\[\]【】「」『』]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[／/]/g, '/');
}

async function ensureColumns() {
  await prisma.$executeRawUnsafe(`
    ALTER TABLE grammar
      ADD COLUMN IF NOT EXISTS source_book VARCHAR(64),
      ADD COLUMN IF NOT EXISTS source_unit VARCHAR(64),
      ADD COLUMN IF NOT EXISTS track VARCHAR(20) NOT NULL DEFAULT 'core',
      ADD COLUMN IF NOT EXISTS priority INT;
  `);
}

async function backfillBooksAndPriority() {
  for (const level of LEVEL_ORDER) {
    const sourceBook = SOURCE_BOOK_BY_LEVEL[level];
    await prisma.$executeRawUnsafe(
      `
      UPDATE grammar
      SET source_book = COALESCE(NULLIF(TRIM(source_book), ''), $2),
          track = COALESCE(NULLIF(TRIM(track), ''), 'core')
      WHERE level = $1;
      `,
      level,
      sourceBook,
    );
  }

  await prisma.$executeRawUnsafe(`
    WITH ranked AS (
      SELECT grammar_id, ROW_NUMBER() OVER (
        PARTITION BY level
        ORDER BY
          CASE WHEN track = 'core' THEN 0 ELSE 1 END,
          grammar_id ASC
      ) AS rn
      FROM grammar
    )
    UPDATE grammar g
    SET priority = ranked.rn
    FROM ranked
    WHERE g.grammar_id = ranked.grammar_id;
  `);
}

async function markCrossLevelDuplicatesAsSupplemental() {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT grammar_id, level, grammar_point, track
    FROM grammar
    ORDER BY grammar_id ASC;
  `);

  const grouped = new Map();
  for (const row of rows) {
    const key = normalizePoint(row.grammar_point);
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }

  let touched = 0;
  for (const [, list] of grouped) {
    if (!Array.isArray(list) || list.length <= 1) continue;

    list.sort((a, b) => {
      const ia = LEVEL_ORDER.indexOf(String(a.level || '').toUpperCase());
      const ib = LEVEL_ORDER.indexOf(String(b.level || '').toUpperCase());
      if (ia !== ib) return ia - ib;
      return Number(a.grammar_id) - Number(b.grammar_id);
    });

    const keep = list[0];
    const toSupplemental = list
      .filter((r) => Number(r.grammar_id) !== Number(keep.grammar_id))
      .map((r) => Number(r.grammar_id))
      .filter((id) => Number.isFinite(id));

    if (toSupplemental.length > 0) {
      await prisma.$executeRawUnsafe(
        `
        UPDATE grammar
        SET track = 'supplemental'
        WHERE grammar_id = ANY($1::bigint[]);
        `,
        toSupplemental,
      );
      touched += toSupplemental.length;
    }
  }

  await prisma.$executeRawUnsafe(`
    WITH ranked AS (
      SELECT grammar_id, ROW_NUMBER() OVER (
        PARTITION BY level
        ORDER BY
          CASE WHEN track = 'core' THEN 0 ELSE 1 END,
          grammar_id ASC
      ) AS rn
      FROM grammar
    )
    UPDATE grammar g
    SET priority = ranked.rn
    FROM ranked
    WHERE g.grammar_id = ranked.grammar_id;
  `);

  return touched;
}

async function printSummary() {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT level, track, COUNT(*)::int AS count
    FROM grammar
    GROUP BY level, track
    ORDER BY level ASC, track ASC;
  `);
  console.log('[reclassify-grammar] summary by level/track');
  for (const row of rows) {
    console.log(`- ${row.level} ${row.track}: ${row.count}`);
  }
}

async function main() {
  await ensureColumns();
  await backfillBooksAndPriority();
  const duplicateTouched = await markCrossLevelDuplicatesAsSupplemental();
  await printSummary();
  console.log(`[reclassify-grammar] set supplemental from cross-level duplicates: ${duplicateTouched}`);
}

main()
  .catch((err) => {
    console.error('[reclassify-grammar] failed', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
