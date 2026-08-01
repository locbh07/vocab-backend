// One-off backfill: translate every distinct vocabulary.topic value to the target language up
// front, instead of waiting for the lazy fire-and-forget path in routes/vocabulary.ts to catch
// up one prefix group at a time as users browse. Safe to re-run — skips topics that already
// have a cached translation with a matching source_hash. Requires a fresh `npm run build`
// first (reads the compiled dist/lib/contentTranslation.js, not the TS source).
//
// Usage: node scripts/backfill-vocabulary-topic-translations.cjs [--lang en]
const { PrismaClient } = require("@prisma/client");

async function main() {
  const language = (() => {
    const idx = process.argv.indexOf("--lang");
    return idx >= 0 ? String(process.argv[idx + 1] || "en").trim() : "en";
  })();

  const prisma = new PrismaClient();
  try {
    const { translateVocabularyTopic } = require("../dist/lib/contentTranslation");
    const rows = await prisma.$queryRawUnsafe("SELECT DISTINCT topic FROM vocabulary WHERE topic IS NOT NULL AND topic <> ''");
    const topics = rows.map((r) => r.topic);
    console.log(`Found ${topics.length} distinct topics. Translating to '${language}'.`);

    let done = 0;
    let failed = 0;
    const concurrency = 6;
    let cursor = 0;

    async function worker() {
      while (cursor < topics.length) {
        const idx = cursor++;
        const topic = topics[idx];
        try {
          const result = await translateVocabularyTopic(topic, language);
          if (!result) failed++;
        } catch (e) {
          failed++;
          console.error("failed:", topic, e.message);
        }
        done++;
        if (done % 40 === 0) console.log(`  ${done}/${topics.length} done`);
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    console.log(`Done. translated_or_cached=${done - failed}, failed=${failed}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
