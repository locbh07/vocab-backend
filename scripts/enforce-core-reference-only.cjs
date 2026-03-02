require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const REF_PATH = path.join(__dirname, '..', 'data', 'grammar-reference', 'bunpro-reference.json');

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
    .replace(/[ 　\t\r\n]+/g, '');
}

function scoreRow(row) {
  let score = 0;
  if (String(row.track || '') === 'core') score += 20;
  if (String(row.meaning_vi || '').trim()) score += 8;
  if (String(row.grammar_usage || '').trim()) score += 4;
  const unit = String(row.source_unit || '').toLowerCase();
  if (unit.includes('chapter') || unit.includes('課') || unit.includes('lesson')) score += 2;
  const p = Number(row.priority);
  if (Number.isFinite(p)) score += Math.max(0, 3 - Math.floor(p / 100));
  return score;
}

async function main() {
  if (!fs.existsSync(REF_PATH)) {
    throw new Error(`Missing reference file: ${REF_PATH}`);
  }
  const ref = JSON.parse(fs.readFileSync(REF_PATH, 'utf8'));

  const rows = await prisma.$queryRawUnsafe(`
    SELECT grammar_id, level, grammar_point, source_unit, source_book, track, priority, meaning_vi, grammar_usage
    FROM grammar
    ORDER BY level ASC, COALESCE(priority, 2147483647) ASC, grammar_id ASC;
  `);

  const byLevel = new Map();
  for (const row of rows) {
    const level = String(row.level || '').toUpperCase();
    if (!byLevel.has(level)) byLevel.set(level, []);
    byLevel.get(level).push(row);
  }

  let coreAssigned = 0;
  for (const level of Object.keys(ref.levels || {})) {
    const refLevel = ref.levels[level];
    const levelRows = byLevel.get(level) || [];

    // Default everything in this level to supplemental first.
    await prisma.$executeRawUnsafe(`UPDATE grammar SET track='supplemental' WHERE level=$1;`, level);

    const keyToRows = new Map();
    for (const row of levelRows) {
      const key = normalizePoint(row.grammar_point);
      if (!key) continue;
      if (!keyToRows.has(key)) keyToRows.set(key, []);
      keyToRows.get(key).push(row);
    }
    for (const [, arr] of keyToRows) {
      arr.sort((a, b) => {
        const sa = scoreRow(a);
        const sb = scoreRow(b);
        if (sa !== sb) return sb - sa;
        const pa = Number.isFinite(Number(a.priority)) ? Number(a.priority) : 2147483647;
        const pb = Number.isFinite(Number(b.priority)) ? Number(b.priority) : 2147483647;
        if (pa !== pb) return pa - pb;
        return Number(a.grammar_id) - Number(b.grammar_id);
      });
    }
    const usedIds = new Set();

    for (const item of refLevel.items || []) {
      const key = normalizePoint(item.grammarPoint);
      if (!key) continue;
      const candidates = (keyToRows.get(key) || []).filter(
        (r) => !usedIds.has(Number(r.grammar_id)),
      );
      if (candidates.length === 0) {
        const anySameKey = keyToRows.get(key) || [];
        const donorMeaning = String(anySameKey[0]?.meaning_vi || '').trim() || null;
        const donorUsage = String(anySameKey[0]?.grammar_usage || '').trim() || null;
        await prisma.$executeRawUnsafe(
          `
          INSERT INTO grammar (
            grammar_point, level, source_book, source_unit, track, priority, meaning_vi, grammar_usage, note
          ) VALUES ($1, $2, $3, $4, 'core', NULL, $5, $6, $7);
          `,
          item.grammarPoint,
          level,
          refLevel.sourceBook || null,
          item.chapter || null,
          donorMeaning,
          donorUsage,
          'auto-added to enforce exact reference count',
        );
        coreAssigned += 1;
      } else {
        const chosen = candidates[0];
        usedIds.add(Number(chosen.grammar_id));

        await prisma.$executeRawUnsafe(
          `
          UPDATE grammar
          SET track='core',
              source_unit = COALESCE(NULLIF(TRIM(source_unit), ''), $2),
              source_book = COALESCE(NULLIF(TRIM(source_book), ''), $3)
          WHERE grammar_id=$1;
          `,
          Number(chosen.grammar_id),
          item.chapter || null,
          refLevel.sourceBook || null,
        );
        coreAssigned += 1;
      }
    }
  }

  await prisma.$executeRawUnsafe(`
    WITH ranked AS (
      SELECT grammar_id, ROW_NUMBER() OVER (
        PARTITION BY level
        ORDER BY
          CASE WHEN track='core' THEN 0 ELSE 1 END,
          COALESCE(priority, 2147483647) ASC,
          grammar_id ASC
      ) AS rn
      FROM grammar
    )
    UPDATE grammar g
    SET priority = ranked.rn
    FROM ranked
    WHERE g.grammar_id = ranked.grammar_id;
  `);

  const summary = await prisma.$queryRawUnsafe(`
    SELECT level,
           COUNT(*) FILTER (WHERE track='core')::int AS core,
           COUNT(*) FILTER (WHERE track='supplemental')::int AS supplemental,
           COUNT(*)::int AS all_count
    FROM grammar
    GROUP BY level
    ORDER BY level ASC;
  `);
  console.log(`[enforce-core-reference-only] coreAssigned=${coreAssigned}`);
  for (const row of summary) {
    console.log(
      `[enforce-core-reference-only] ${row.level}: core=${row.core} supplemental=${row.supplemental} all=${row.all_count}`,
    );
  }
}

main()
  .catch((err) => {
    console.error('[enforce-core-reference-only] failed', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
