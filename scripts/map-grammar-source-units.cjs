require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const LEVEL_CONFIG = {
  N5: { corePrefix: 'Lesson', coreSegments: 25 },
  N4: { corePrefix: 'Lesson', coreSegments: 25 },
  N3: { corePrefix: 'Chapter', coreSegments: 20 },
  N2: { corePrefix: 'Chapter', coreSegments: 20 },
  N1: { corePrefix: 'Chapter', coreSegments: 20 },
};

function pad2(n) {
  return String(n).padStart(2, '0');
}

function buildCoreUnitLabel(level, index, total) {
  const cfg = LEVEL_CONFIG[level];
  if (!cfg || total <= 0) return null;
  const seg = Math.min(
    cfg.coreSegments,
    Math.max(1, Math.floor((index * cfg.coreSegments) / total) + 1),
  );
  return `${cfg.corePrefix} ${pad2(seg)}`;
}

function buildSupplementalLabel(index) {
  const seg = Math.max(1, Math.floor(index / 10) + 1);
  return `Supplemental ${pad2(seg)}`;
}

async function assignUnitsForLevel(level) {
  const rows = await prisma.$queryRawUnsafe(
    `
    SELECT grammar_id, track, priority
    FROM grammar
    WHERE level = $1
    ORDER BY
      CASE WHEN track = 'core' THEN 0 ELSE 1 END ASC,
      COALESCE(priority, 2147483647) ASC,
      grammar_id ASC;
    `,
    level,
  );

  const core = rows.filter((r) => String(r.track || 'core') === 'core');
  const supplemental = rows.filter((r) => String(r.track || 'core') !== 'core');

  for (let i = 0; i < core.length; i += 1) {
    const row = core[i];
    const unit = buildCoreUnitLabel(level, i, core.length);
    await prisma.$executeRawUnsafe(
      `UPDATE grammar SET source_unit = $2 WHERE grammar_id = $1;`,
      Number(row.grammar_id),
      unit,
    );
  }

  for (let i = 0; i < supplemental.length; i += 1) {
    const row = supplemental[i];
    const unit = buildSupplementalLabel(i);
    await prisma.$executeRawUnsafe(
      `UPDATE grammar SET source_unit = $2 WHERE grammar_id = $1;`,
      Number(row.grammar_id),
      unit,
    );
  }

  return { core: core.length, supplemental: supplemental.length };
}

async function printSummary() {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT level, source_unit, COUNT(*)::int AS count
    FROM grammar
    GROUP BY level, source_unit
    ORDER BY level ASC, source_unit ASC;
  `);
  const byLevel = new Map();
  for (const row of rows) {
    const level = String(row.level || '');
    if (!byLevel.has(level)) byLevel.set(level, 0);
    byLevel.set(level, byLevel.get(level) + 1);
  }
  console.log('[map-grammar-source-units] filled units by level');
  for (const [level, cnt] of byLevel.entries()) {
    console.log(`- ${level}: ${cnt}`);
  }
}

async function main() {
  const levels = Object.keys(LEVEL_CONFIG);
  for (const level of levels) {
    const result = await assignUnitsForLevel(level);
    console.log(
      `[map-grammar-source-units] ${level} core=${result.core} supplemental=${result.supplemental}`,
    );
  }
  await printSummary();
}

main()
  .catch((err) => {
    console.error('[map-grammar-source-units] failed', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
