/* eslint-disable no-console */
// Pre-translates every listening transcript line that has no 'vi' translation
// yet, using the same free Google Translate endpoint the app's on-demand
// fallback already uses (translateWithPublicEndpoint in src/routes/listening.ts).
// Run with limited concurrency + pacing to avoid hammering the endpoint.
//
// Why this exists: 107 videos had their Corodomo-sourced Vietnamese
// translations removed because they were misaligned (see
// realign-corodomo-translations.cjs for why a naive time-overlap realignment
// isn't reliable enough either — a second divergence layer was found deeper
// in at least one video). Rather than watching lines translate live while
// playing (too slow to keep up with playback), this pre-fills the cache so
// they're instantly available.
const { PrismaClient, Prisma } = require("@prisma/client");

const prisma = new PrismaClient();

function parseArgs(argv) {
  const out = { concurrency: 4, delayMs: 150, limit: Infinity, videoIds: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--concurrency") out.concurrency = Math.max(1, Number(argv[++i] || out.concurrency));
    else if (arg === "--delay-ms") out.delayMs = Math.max(0, Number(argv[++i] || out.delayMs));
    else if (arg === "--limit") out.limit = Math.max(1, Number(argv[++i] || out.limit));
    else if (arg === "--video-ids") {
      out.videoIds = String(argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  return out;
}

async function translateWithPublicEndpoint(text, targetLanguage) {
  const params = new URLSearchParams({ client: "gtx", sl: "ja", tl: targetLanguage, dt: "t", q: text });
  const response = await fetch(`https://translate.googleapis.com/translate_a/single?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`translate.googleapis.com failed: ${response.status}`);
  }
  const payload = await response.json();
  const segments = Array.isArray(payload) && Array.isArray(payload[0]) ? payload[0] : [];
  return segments.map((item) => (Array.isArray(item) ? String(item[0] || "") : "")).join("").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithConcurrency(items, concurrency, worker) {
  let index = 0;
  let done = 0;
  let failed = 0;
  const runners = Array.from({ length: concurrency }, async () => {
    while (index < items.length) {
      const current = items[index];
      index += 1;
      try {
        await worker(current);
      } catch (error) {
        failed += 1;
        console.warn(`  failed ${current.video_id}#${current.line_index}:`, error?.message || error);
      }
      done += 1;
      if (done % 200 === 0 || done === items.length) {
        console.log(`  progress: ${done}/${items.length} (failed=${failed})`);
      }
    }
  });
  await Promise.all(runners);
  return { done, failed };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const predicates = [Prisma.sql`t.id IS NULL`];
  if (options.videoIds.length) {
    predicates.push(Prisma.sql`l.video_id = ANY(${options.videoIds})`);
  }

  const rows = await prisma.$queryRaw(Prisma.sql`
    SELECT l.video_id, l.line_index, l.text
    FROM listening_transcript_line l
    LEFT JOIN listening_transcript_translation t
      ON t.video_id = l.video_id AND t.line_index = l.line_index AND t.language = 'vi'
    WHERE ${Prisma.join(predicates, " AND ")} AND trim(l.text) <> ''
    ORDER BY l.video_id, l.line_index
    LIMIT ${options.limit}
  `);

  console.log(`Translating ${rows.length} lines (concurrency=${options.concurrency}, delayMs=${options.delayMs})...`);

  const { done, failed } = await runWithConcurrency(rows, options.concurrency, async (row) => {
    const translation = await translateWithPublicEndpoint(row.text, "vi");
    if (options.delayMs) await sleep(options.delayMs);
    if (!translation) return;
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO listening_transcript_translation (
        video_id, line_index, language, source_text, translation, provider, created_at, updated_at
      ) VALUES (${row.video_id}, ${row.line_index}, 'vi', ${row.text}, ${translation}, 'google-public', NOW(), NOW())
      ON CONFLICT (video_id, line_index, language)
      DO UPDATE SET source_text = EXCLUDED.source_text, translation = EXCLUDED.translation,
        provider = EXCLUDED.provider, updated_at = NOW()
    `);
  });

  console.log(`Done. translated=${done - failed}, failed=${failed}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
