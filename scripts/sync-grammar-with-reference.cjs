require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const REF_PATH = path.join(__dirname, '..', 'data', 'grammar-reference', 'bunpro-reference.json');
const REPORT_PATH = path.join(__dirname, '..', 'data', 'grammar-reference', 'comparison-report.json');

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
    .replace(/[～~]/g, '');
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

async function fetchDbRows() {
  return prisma.$queryRawUnsafe(`
    SELECT grammar_id, level, grammar_point, source_book, source_unit, track, priority
    FROM grammar
    ORDER BY level ASC, COALESCE(priority, 2147483647) ASC, grammar_id ASC;
  `);
}

function buildDbLevelMaps(rows) {
  const map = new Map();
  for (const row of rows) {
    const level = String(row.level || '').toUpperCase();
    if (!map.has(level)) map.set(level, []);
    map.get(level).push(row);
  }
  return map;
}

function getNextPriority(levelRows) {
  const current = levelRows
    .map((r) => Number(r.priority))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => b - a)[0];
  return Number.isFinite(current) ? current + 1 : 1;
}

async function main() {
  if (!fs.existsSync(REF_PATH)) {
    throw new Error(`Reference not found: ${REF_PATH}. Run grammar:reference:build first.`);
  }
  await ensureColumns();

  const ref = JSON.parse(fs.readFileSync(REF_PATH, 'utf8'));
  const dbRows = await fetchDbRows();
  const dbByLevel = buildDbLevelMaps(dbRows);

  const report = {
    generatedAt: new Date().toISOString(),
    referenceFile: REF_PATH,
    summary: {},
    levels: {},
  };

  let insertedTotal = 0;

  for (const level of Object.keys(ref.levels || {})) {
    const refLevel = ref.levels[level];
    const dbLevelRows = dbByLevel.get(level) || [];

    const dbKeyMap = new Map();
    for (const row of dbLevelRows) {
      const k = normalizePoint(row.grammar_point);
      if (!k) continue;
      if (!dbKeyMap.has(k)) dbKeyMap.set(k, []);
      dbKeyMap.get(k).push(row);
    }

    const missing = [];
    const matched = [];
    const ambiguous = [];
    const matchedByCore = [];
    const ambiguousCore = [];

    for (const item of refLevel.items || []) {
      const key = normalizePoint(item.grammarPoint);
      if (!key) continue;
      const hit = dbKeyMap.get(key) || [];
      if (hit.length === 0) {
        missing.push(item);
      } else if (hit.length === 1) {
        matched.push({ item, row: hit[0] });
        matchedByCore.push({ item, row: hit[0] });
      } else {
        ambiguous.push({ item, rows: hit });
        const coreHit = hit.filter((r) => String(r.track || 'core') === 'core');
        if (coreHit.length === 1) {
          matchedByCore.push({ item, row: coreHit[0] });
        } else {
          ambiguousCore.push({ item, rows: coreHit.length > 0 ? coreHit : hit });
        }
      }
    }

    let nextPriority = getNextPriority(dbLevelRows);
    let inserted = 0;
    for (const item of missing) {
      await prisma.$executeRawUnsafe(
        `
        INSERT INTO grammar (
          grammar_point,
          level,
          source_book,
          source_unit,
          track,
          priority,
          meaning_vi,
          grammar_usage,
          note
        ) VALUES ($1, $2, $3, $4, 'core', $5, $6, $7, $8);
        `,
        item.grammarPoint,
        level,
        refLevel.sourceBook || null,
        item.chapter || null,
        nextPriority,
        null,
        null,
        `seeded from reference: ${refLevel.sourceUrl || 'unknown'}`,
      );
      nextPriority += 1;
      inserted += 1;
      insertedTotal += 1;
    }

    report.levels[level] = {
      sourceBook: refLevel.sourceBook,
      sourceTitle: refLevel.sourceTitle,
      sourceUrl: refLevel.sourceUrl,
      referenceCount: (refLevel.items || []).length,
      dbCountBefore: dbLevelRows.length,
      matchedCount: matched.length,
      missingCount: missing.length,
      ambiguousCount: ambiguous.length,
      matchedByCoreCount: matchedByCore.length,
      ambiguousCoreCount: ambiguousCore.length,
      insertedCount: inserted,
      missingSample: missing.slice(0, 40),
    };
  }

  const dbRowsAfter = await fetchDbRows();
  const afterByLevel = buildDbLevelMaps(dbRowsAfter);

  for (const level of Object.keys(report.levels)) {
    report.levels[level].dbCountAfter = (afterByLevel.get(level) || []).length;
  }

  report.summary.insertedTotal = insertedTotal;
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');

  console.log(`[sync-reference] insertedTotal=${insertedTotal}`);
  for (const level of Object.keys(report.levels)) {
    const lv = report.levels[level];
    console.log(
      `[sync-reference] ${level} ref=${lv.referenceCount} matched=${lv.matchedCount} matchedCore=${lv.matchedByCoreCount} missing=${lv.missingCount} inserted=${lv.insertedCount} ambiguous=${lv.ambiguousCount} ambiguousCore=${lv.ambiguousCoreCount}`,
    );
  }
  console.log(`[sync-reference] report=${REPORT_PATH}`);
}

main()
  .catch((err) => {
    console.error('[sync-reference] failed', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
