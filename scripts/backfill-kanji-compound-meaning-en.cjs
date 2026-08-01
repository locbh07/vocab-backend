/* eslint-disable no-console */
// Backfills target-language meanings for kanji_compound rows that have a Vietnamese meaning
// but none yet in that language (kanji_compound is a raw-SQL-managed table, not a Prisma model
// — see src/lib/kanjiCompounds.ts). Mirrors the batching/Gemini-calling approach of
// scripts/batch-translate-content.cjs, but writes directly to a meaning_<lang> column instead
// of a separate *_translation table since this table carries language columns inline.
// Currently only meaning_vi/meaning_en columns exist — adding a third language requires a
// migration to add a meaning_<lang> column first (see prisma/migrations for the pattern).
//
// Usage: node scripts/backfill-kanji-compound-meaning-en.cjs [--lang en] [--batch-size 40] [--delay-ms 400] [--limit 100000] [--dry-run]
require("dotenv").config();
const { PrismaClient, Prisma } = require("@prisma/client");

const prisma = new PrismaClient();

const LANGUAGE_NAMES = {
  en: "English",
  zh: "Chinese (Simplified)",
  ko: "Korean",
  pt: "Portuguese (Brazil)",
  id: "Indonesian",
  ne: "Nepali",
  my: "Burmese",
  fil: "Filipino",
};

function parseArgs(argv) {
  const out = { lang: "en", batchSize: 40, delayMs: 400, limit: 100000, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--lang") out.lang = String(argv[++i] || out.lang).trim();
    else if (arg === "--batch-size") out.batchSize = Math.max(1, Number(argv[++i] || out.batchSize));
    else if (arg === "--delay-ms") out.delayMs = Math.max(0, Number(argv[++i] || out.delayMs));
    else if (arg === "--limit") out.limit = Math.max(1, Number(argv[++i] || out.limit));
    else if (arg === "--dry-run") out.dryRun = true;
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function callGeminiTranslateBatch({ model, apiKey, languageName, items }) {
  const systemInstruction = [
    `You translate short Vietnamese meanings of Japanese kanji compound words into ${languageName}.`,
    `Each item has an id and a Vietnamese 'meaning' field. Translate ONLY that field to natural, concise ${languageName}, ` +
      "suitable for a dictionary compound-word gloss.",
    "Do NOT translate, transliterate, or alter any Japanese text if it appears embedded in a field.",
    "If a field is null or empty in the input, return it as null in the output — do not invent content.",
    'Return strict JSON: {"items":[{"id": <same id>, "meaning": "..."}]}. Return exactly one output item per input item, matching ids exactly.',
  ].join(" ");

  const prompt = JSON.stringify({
    items: items.map((item) => ({ id: Number(item.id), meaning: item.meaning_vi ?? null })),
  });

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Gemini request failed (${response.status}): ${detail.slice(0, 300)}`);
  }

  const data = await response.json();
  const rawText = String(data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "");
  if (!rawText) throw new Error("Gemini returned empty content");

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (_err) {
    const fenced = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
    if (!fenced) throw new Error("Could not parse Gemini JSON response");
    parsed = JSON.parse(fenced);
  }

  const resultItems = Array.isArray(parsed?.items) ? parsed.items : [];
  const byId = new Map();
  for (const item of resultItems) {
    if (item && item.id !== undefined && item.id !== null) byId.set(String(item.id), item);
  }
  return byId;
}

async function translateBatchWithRetry(geminiOptions, items) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await callGeminiTranslateBatch({ ...geminiOptions, items });
    } catch (error) {
      console.warn(`  batch attempt ${attempt} failed:`, error?.message || error);
      if (attempt === 2) return new Map();
      await sleep(1000);
    }
  }
  return new Map();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.lang !== "en") {
    // Only meaning_vi/meaning_en columns exist today. Add a `meaning_<lang>` column via a new
    // migration (see prisma/migrations/20260731150000_add_vocabulary_topic_translation for the
    // pattern) before pointing this script at another language.
    throw new Error(`kanji_compound has no meaning_${args.lang} column yet — add a migration first.`);
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");
  const model = process.env.GEMINI_TRANSLATE_MODEL || "gemini-3.5-flash-lite";
  const languageName = LANGUAGE_NAMES[args.lang] || args.lang;
  const geminiOptions = { model, apiKey, languageName };

  console.log(`Backfilling kanji_compound.meaning_en (${languageName}) using model '${model}'${args.dryRun ? " [dry-run]" : ""}`);

  const rows = await prisma.$queryRaw(Prisma.sql`
    SELECT id, meaning_vi
    FROM kanji_compound
    WHERE (meaning_en IS NULL OR meaning_en = '')
      AND meaning_vi IS NOT NULL AND meaning_vi <> ''
    ORDER BY id
    LIMIT ${args.limit}
  `);
  console.log(`${rows.length} row(s) need an English meaning.`);
  if (!rows.length) return;

  const batches = chunk(rows, args.batchSize);
  let translated = 0;
  let failed = 0;

  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i];
    const byId = await translateBatchWithRetry(geminiOptions, batch);

    for (const row of batch) {
      const result = byId.get(String(row.id));
      if (!result || !result.meaning) {
        failed += 1;
        continue;
      }
      if (args.dryRun) {
        translated += 1;
        continue;
      }
      await prisma.$executeRaw(Prisma.sql`
        UPDATE kanji_compound SET meaning_en = ${result.meaning}, updated_at = NOW() WHERE id = ${row.id}
      `);
      translated += 1;
    }

    console.log(`  batch ${i + 1}/${batches.length} done (translated=${translated}, failed=${failed})`);
    if (args.delayMs && i < batches.length - 1) await sleep(args.delayMs);
  }

  // routes/kanji.ts's compounds lookup is served from kanji_compound_lookup_cache (a
  // precomputed-JSON cache table, separate from kanji_compound itself) — writing new
  // meaning_en values directly here does NOT invalidate it, so already-cached kanji would
  // keep serving stale (pre-backfill) results indefinitely without this.
  if (!args.dryRun && translated > 0) {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE kanji_compound_lookup_cache');
    console.log('Cleared kanji_compound_lookup_cache so the API picks up new translations.');
  }

  console.log(`Done. translated=${translated}, failed=${failed}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
