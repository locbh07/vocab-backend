require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const DECK_FILES = {
  N5: path.join(__dirname, '..', 'data', 'grammar-reference', 'sources', 'mnn1.html'),
  N4: path.join(__dirname, '..', 'data', 'grammar-reference', 'sources', 'mnn2.html'),
  N3: path.join(__dirname, '..', 'data', 'grammar-reference', 'sources', 'sk_n3.html'),
  N2: path.join(__dirname, '..', 'data', 'grammar-reference', 'sources', 'sk_n2.html'),
  N1: path.join(__dirname, '..', 'data', 'grammar-reference', 'sources', 'sk_n1.html'),
};

function cleanText(input) {
  return String(input || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

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

function parseReferenceFromHtml(html) {
  const re =
    /<a href="(\/grammar_points\/[^"]+)"[\s\S]*?<p class="v-text_large--400 deck-card-title">([\s\S]*?)<\/p>[\s\S]*?<span class="u-text_body--400 u-text_fg-secondary">([\s\S]*?)<\/span>/g;
  const rows = [];
  let match;
  while ((match = re.exec(html)) !== null) {
    const grammarPoint = cleanText(match[2]);
    const gloss = cleanText(match[3]);
    if (!grammarPoint || !gloss) continue;
    rows.push({ grammarPoint, gloss });
  }
  return rows;
}

function buildRefMapByLevel() {
  const mapByLevel = new Map();
  for (const level of Object.keys(DECK_FILES)) {
    const file = DECK_FILES[level];
    if (!fs.existsSync(file)) continue;
    const html = fs.readFileSync(file, 'utf8');
    const rows = parseReferenceFromHtml(html);
    const map = new Map();
    for (const row of rows) {
      const key = normalizePoint(row.grammarPoint);
      if (!key) continue;
      if (!map.has(key)) map.set(key, row.gloss);
    }
    mapByLevel.set(level, map);
  }
  return mapByLevel;
}

async function main() {
  const refMaps = buildRefMapByLevel();

  const rows = await prisma.$queryRawUnsafe(`
    SELECT grammar_id, level, grammar_point, meaning_vi
    FROM grammar
    WHERE meaning_vi IS NULL OR TRIM(meaning_vi) = ''
    ORDER BY level ASC, priority ASC, grammar_id ASC;
  `);

  let updated = 0;
  for (const row of rows) {
    const level = String(row.level || '').toUpperCase();
    const key = normalizePoint(row.grammar_point);
    if (!key) continue;
    const gloss = String(refMaps.get(level)?.get(key) || '').trim();
    if (!gloss) continue;

    await prisma.$executeRawUnsafe(
      `UPDATE grammar SET meaning_vi = $2 WHERE grammar_id = $1;`,
      Number(row.grammar_id),
      gloss,
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

  console.log(`[fill-meaning-reference] updated=${updated}`);
  for (const row of summary) {
    console.log(`[fill-meaning-reference] ${row.level}: no_meaning=${row.no_meaning}/${row.total}`);
  }
}

main()
  .catch((err) => {
    console.error('[fill-meaning-reference] failed', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
