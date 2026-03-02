require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

function normalizePoint(input) {
  return String(input || '')
    .toLowerCase()
    .trim()
    .replace(/[〜～]/g, '~')
    .replace(/[（）\(\)\[\]【】「」『』]/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/（[^）]*）/g, '')
    .replace(/[①②③④⑤⑥⑦⑧⑨⑩]/g, '')
    .replace(/[0-9０-９]/g, '')
    .replace(/[・･]/g, '')
    .replace(/[\/／]/g, '/')
    .replace(/[~]/g, '')
    .replace(/[ 　\t\r\n]+/g, '')
    .trim();
}

function pickBetterMeaning(a, b) {
  const aa = String(a || '').trim();
  const bb = String(b || '').trim();
  if (!aa) return bb;
  if (!bb) return aa;
  return bb.length > aa.length ? bb : aa;
}

async function main() {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT grammar_id, level, grammar_point, meaning_vi
    FROM grammar
    ORDER BY grammar_id ASC;
  `);

  const donorByKey = new Map();
  for (const row of rows) {
    const meaning = String(row.meaning_vi || '').trim();
    if (!meaning) continue;
    const key = normalizePoint(row.grammar_point);
    if (!key) continue;
    const current = donorByKey.get(key) || '';
    donorByKey.set(key, pickBetterMeaning(current, meaning));
  }

  let updated = 0;
  for (const row of rows) {
    const meaning = String(row.meaning_vi || '').trim();
    if (meaning) continue;
    const key = normalizePoint(row.grammar_point);
    if (!key) continue;
    const donorMeaning = String(donorByKey.get(key) || '').trim();
    if (!donorMeaning) continue;

    await prisma.$executeRawUnsafe(
      `UPDATE grammar SET meaning_vi = $2 WHERE grammar_id = $1;`,
      Number(row.grammar_id),
      donorMeaning,
    );
    updated += 1;
  }

  const summary = await prisma.$queryRawUnsafe(`
    SELECT level,
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE meaning_vi IS NULL OR TRIM(meaning_vi)='')::int AS no_meaning
    FROM grammar
    GROUP BY level
    ORDER BY level ASC;
  `);

  console.log(`[fill-meaning] updated=${updated}`);
  for (const row of summary) {
    console.log(`[fill-meaning] ${row.level}: no_meaning=${row.no_meaning}/${row.total}`);
  }
}

main()
  .catch((err) => {
    console.error('[fill-meaning] failed', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
