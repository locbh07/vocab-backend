require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

function normalizePoint(input) {
  return String(input || '')
    .toLowerCase()
    .trim()
    .replace(/[〜～]/g, '~')
    .replace(/[（）\(\)\[\]【】「」『』]/g, '')
    .replace(/\s+/g, '')
    .replace(/[・･]/g, '')
    .replace(/[①②③④⑤⑥⑦⑧⑨⑩]/g, '')
    .replace(/[\/／]/g, '/')
    .replace(/[~]/g, '');
}

function scoreRow(row) {
  let score = 0;
  if (String(row.track || '') === 'core') score += 20;
  if (String(row.meaning_vi || '').trim()) score += 8;
  const unit = String(row.source_unit || '').toLowerCase();
  if (unit && !unit.startsWith('supplemental')) score += 4;
  if (Number.isFinite(Number(row.priority))) {
    score += Math.max(0, 3 - Math.floor(Number(row.priority) / 100));
  }
  return score;
}

async function main() {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT grammar_id, level, grammar_point, track, source_unit, priority, meaning_vi
    FROM grammar
    ORDER BY level ASC, COALESCE(priority, 2147483647) ASC, grammar_id ASC;
  `);

  const grouped = new Map();
  for (const row of rows) {
    const norm = normalizePoint(row.grammar_point);
    if (!norm) continue;
    const key = `${String(row.level || '').toUpperCase()}||${norm}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }

  let groupsTouched = 0;
  let rowsChanged = 0;

  for (const [, list] of grouped) {
    if (!Array.isArray(list) || list.length <= 1) continue;
    groupsTouched += 1;

    const sorted = [...list].sort((a, b) => {
      const sa = scoreRow(a);
      const sb = scoreRow(b);
      if (sa !== sb) return sb - sa;
      const pa = Number.isFinite(Number(a.priority)) ? Number(a.priority) : 2147483647;
      const pb = Number.isFinite(Number(b.priority)) ? Number(b.priority) : 2147483647;
      if (pa !== pb) return pa - pb;
      return Number(a.grammar_id) - Number(b.grammar_id);
    });

    const keep = sorted[0];
    const demote = sorted
      .slice(1)
      .map((r) => Number(r.grammar_id))
      .filter((id) => Number.isFinite(id));

    // Keep one representative as core, move duplicates to supplemental.
    await prisma.$executeRawUnsafe(
      `UPDATE grammar SET track = 'core' WHERE grammar_id = $1;`,
      Number(keep.grammar_id),
    );
    if (demote.length > 0) {
      await prisma.$executeRawUnsafe(
        `
        UPDATE grammar
        SET track = 'supplemental',
            source_unit = CASE
              WHEN source_unit IS NULL OR TRIM(source_unit) = '' THEN 'Supplemental 01'
              WHEN source_unit ILIKE 'Supplemental %' THEN source_unit
              ELSE source_unit
            END
        WHERE grammar_id = ANY($1::bigint[]);
        `,
        demote,
      );
      rowsChanged += demote.length;
    }
  }

  // Re-rank priorities: core first.
  await prisma.$executeRawUnsafe(`
    WITH ranked AS (
      SELECT grammar_id, ROW_NUMBER() OVER (
        PARTITION BY level
        ORDER BY
          CASE WHEN track = 'core' THEN 0 ELSE 1 END,
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
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE track='core')::int AS core,
           COUNT(*) FILTER (WHERE track<>'core')::int AS supplemental
    FROM grammar
    GROUP BY level
    ORDER BY level ASC;
  `);

  console.log(`[grammar-dedupe] groupsTouched=${groupsTouched} rowsDemoted=${rowsChanged}`);
  for (const row of summary) {
    console.log(
      `[grammar-dedupe] ${row.level}: total=${row.total} core=${row.core} supplemental=${row.supplemental}`,
    );
  }
}

main()
  .catch((err) => {
    console.error('[grammar-dedupe] failed', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
