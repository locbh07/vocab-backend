const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const LEVELS = ['N5', 'N4', 'N3', 'N2', 'N1'];
const VOCAB_PREFIX_BY_LEVEL = {
  N5: '1000_N5_',
  N4: '1500_N4_',
  N3: '2000_N3_',
  N2: '2500_N2_',
  N1: '3000_N1_',
};

function readPercent() {
  const arg = process.argv.find((item) => item.startsWith('--percent='));
  const raw = arg ? Number(arg.split('=')[1]) : 30;
  if (!Number.isFinite(raw)) return 30;
  return Math.min(Math.max(raw, 1), 100);
}

function shouldReset() {
  return process.argv.includes('--reset');
}

function takeCount(total, percent) {
  if (total <= 0) return 0;
  return Math.max(1, Math.ceil((total * percent) / 100));
}

async function markVocabulary(level, percent) {
  const prefix = VOCAB_PREFIX_BY_LEVEL[level];
  const items = await prisma.vocabulary.findMany({
    where: {
      OR: [
        { level },
        ...(prefix ? [{ topic: { startsWith: prefix } }] : []),
      ],
    },
    orderBy: [{ core_order: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });
  const ids = items.slice(0, takeCount(items.length, percent)).map((item) => item.id);
  if (!ids.length) return { total: items.length, marked: 0 };
  await prisma.vocabulary.updateMany({
    where: { id: { in: ids } },
    data: { isFreePreview: true },
  });
  return { total: items.length, marked: ids.length };
}

async function markGrammar(level, percent) {
  const items = await prisma.grammar.findMany({
    where: { level },
    orderBy: [{ priority: 'asc' }, { grammar_id: 'asc' }],
    select: { grammar_id: true },
  });
  const ids = items.slice(0, takeCount(items.length, percent)).map((item) => item.grammar_id);
  if (!ids.length) return { total: items.length, marked: 0 };
  await prisma.grammar.updateMany({
    where: { grammar_id: { in: ids } },
    data: { isFreePreview: true },
  });
  return { total: items.length, marked: ids.length };
}

async function markListening(level, percent) {
  const normalizedLevel = level.toLowerCase();
  const rows = await prisma.$queryRaw`
    SELECT video_id
    FROM listening_video
    WHERE ${normalizedLevel} = ANY(normalized_levels)
      OR (
        COALESCE(array_length(normalized_levels, 1), 0) = 0
        AND EXISTS (
          SELECT 1
          FROM unnest(levels) AS source_level
          WHERE LOWER(source_level) = ${normalizedLevel}
        )
      )
    ORDER BY COALESCE(source_order, 2147483647) ASC, inserted_at ASC, video_id ASC
  `;
  const ids = rows.slice(0, takeCount(rows.length, percent)).map((item) => item.video_id);
  if (!ids.length) return { total: rows.length, marked: 0 };
  await prisma.listeningVideo.updateMany({
    where: { video_id: { in: ids } },
    data: { isFreePreview: true },
  });
  return { total: rows.length, marked: ids.length };
}

async function main() {
  const percent = readPercent();
  if (shouldReset()) {
    await Promise.all([
      prisma.vocabulary.updateMany({ data: { isFreePreview: false } }),
      prisma.grammar.updateMany({ data: { isFreePreview: false } }),
      prisma.listeningVideo.updateMany({ data: { isFreePreview: false } }),
    ]);
  }

  for (const level of LEVELS) {
    const [vocabulary, grammar, listening] = await Promise.all([
      markVocabulary(level, percent),
      markGrammar(level, percent),
      markListening(level, percent),
    ]);
    console.log(
      `${level}: vocabulary ${vocabulary.marked}/${vocabulary.total}, ` +
        `grammar ${grammar.marked}/${grammar.total}, listening ${listening.marked}/${listening.total}`,
    );
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
