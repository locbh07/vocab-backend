/* eslint-disable no-console */
// Batch-translates Vocabulary/VocabularyExample/Grammar/GrammarUsage Vietnamese
// content into the target language (default: en) using Gemini, storing results
// in the generic *_translation tables (see prisma/migrations/20260729140000_add_content_translation_tables).
//
// Idempotent/resumable: a row is only re-translated if it has no translation row
// yet for the target language, or its Vietnamese source text changed since the
// last translation (source_hash mismatch, computed in SQL so re-runs are safe
// to interrupt at any point).
//
// Usage:
//   node scripts/batch-translate-content.cjs --lang en [--type vocabulary|vocabulary-example|grammar|grammar-usage|all]
//     [--batch-size 40] [--delay-ms 400] [--limit 100] [--dry-run]
require("dotenv").config();
const { PrismaClient, Prisma } = require("@prisma/client");

const prisma = new PrismaClient();

function parseArgs(argv) {
  const out = {
    lang: "en",
    type: "all",
    batchSize: 40,
    delayMs: 400,
    limit: Infinity,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--lang") out.lang = String(argv[++i] || out.lang).trim();
    else if (arg === "--type") out.type = String(argv[++i] || out.type).trim();
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

async function callGeminiTranslateBatch({ model, apiKey, languageName, items, fields }) {
  const systemInstruction = [
    `You translate short Vietnamese-language dictionary content for a Japanese-language learning app into ${languageName}.`,
    "Each item has an id and one or more Vietnamese text fields. Translate ONLY those fields to natural, concise " +
      `${languageName}, suitable for a vocabulary/grammar dictionary entry.`,
    "Do NOT translate, transliterate, or alter any Japanese text if it appears embedded in a field.",
    "If a field is null or empty in the input, return it as null in the output — do not invent content.",
    "Return strict JSON: {\"items\":[{\"id\": <same id>, " +
      fields.map((f) => `"${f}": "..."`).join(", ") +
      "}]}. Return exactly one output item per input item, matching ids exactly.",
  ].join(" ");

  const prompt = JSON.stringify({
    items: items.map((item) => {
      const out = { id: Number(item.id) };
      for (const f of fields) out[f] = item[f] ?? null;
      return out;
    }),
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

async function translateBatchWithRetry(options, items, fields) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await callGeminiTranslateBatch({ ...options, items, fields });
    } catch (error) {
      console.warn(`  batch attempt ${attempt} failed:`, error?.message || error);
      if (attempt === 2) return new Map();
      await sleep(1000);
    }
  }
  return new Map();
}

async function processType({ name, fetchSql, fields, upsert, geminiOptions, args }) {
  const rows = await prisma.$queryRaw(fetchSql);
  console.log(`\n[${name}] ${rows.length} row(s) need translation (lang=${args.lang})`);
  if (rows.length === 0) return { translated: 0, failed: 0 };

  const batches = chunk(rows, args.batchSize);
  let translated = 0;
  let failed = 0;

  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i];
    const byId = await translateBatchWithRetry(geminiOptions, batch, fields);

    for (const row of batch) {
      const result = byId.get(String(row.id));
      if (!result) {
        failed += 1;
        console.warn(`  [${name}] no translation returned for id=${row.id}`);
        continue;
      }
      if (args.dryRun) {
        console.log(`  [dry-run] id=${row.id}:`, JSON.stringify(result));
        translated += 1;
        continue;
      }
      await upsert(row, result);
      translated += 1;
    }

    console.log(`  [${name}] batch ${i + 1}/${batches.length} done (translated=${translated}, failed=${failed})`);
    if (args.delayMs && i < batches.length - 1) await sleep(args.delayMs);
  }

  return { translated, failed };
}

function buildVocabularyTask(args, geminiOptions) {
  const fetchSql = Prisma.sql`
    WITH source AS (
      SELECT id, word_vi AS word, example_vi AS example,
        encode(sha256(convert_to(coalesce(word_vi,'') || chr(31) || coalesce(example_vi,''), 'UTF8')), 'hex') AS source_hash
      FROM vocabulary
      WHERE word_vi IS NOT NULL OR example_vi IS NOT NULL
    )
    SELECT s.* FROM source s
    LEFT JOIN vocabulary_translation t ON t.vocab_id = s.id AND t.language = ${args.lang}
    WHERE t.id IS NULL OR t.source_hash IS DISTINCT FROM s.source_hash
    ORDER BY s.id
    LIMIT ${args.limit}
  `;
  return {
    name: "vocabulary",
    fetchSql,
    fields: ["word", "example"],
    geminiOptions,
    args,
    upsert: (row, result) =>
      prisma.$executeRaw(Prisma.sql`
        INSERT INTO vocabulary_translation (vocab_id, language, word, example, provider, source_hash, created_at, updated_at)
        VALUES (${row.id}, ${args.lang}, ${result.word ?? null}, ${result.example ?? null}, 'gemini', ${row.source_hash}, NOW(), NOW())
        ON CONFLICT (vocab_id, language) DO UPDATE SET
          word = EXCLUDED.word, example = EXCLUDED.example, provider = EXCLUDED.provider,
          source_hash = EXCLUDED.source_hash, updated_at = NOW()
      `),
  };
}

function buildVocabularyExampleTask(args, geminiOptions) {
  const fetchSql = Prisma.sql`
    WITH source AS (
      SELECT id, example_vi AS example,
        encode(sha256(convert_to(coalesce(example_vi,''), 'UTF8')), 'hex') AS source_hash
      FROM vocabulary_example
      WHERE example_vi IS NOT NULL
    )
    SELECT s.* FROM source s
    LEFT JOIN vocabulary_example_translation t ON t.vocab_example_id = s.id AND t.language = ${args.lang}
    WHERE t.id IS NULL OR t.source_hash IS DISTINCT FROM s.source_hash
    ORDER BY s.id
    LIMIT ${args.limit}
  `;
  return {
    name: "vocabulary_example",
    fetchSql,
    fields: ["example"],
    geminiOptions,
    args,
    upsert: (row, result) =>
      prisma.$executeRaw(Prisma.sql`
        INSERT INTO vocabulary_example_translation (vocab_example_id, language, example, provider, source_hash, created_at, updated_at)
        VALUES (${row.id}, ${args.lang}, ${result.example ?? null}, 'gemini', ${row.source_hash}, NOW(), NOW())
        ON CONFLICT (vocab_example_id, language) DO UPDATE SET
          example = EXCLUDED.example, provider = EXCLUDED.provider,
          source_hash = EXCLUDED.source_hash, updated_at = NOW()
      `),
  };
}

function buildGrammarTask(args, geminiOptions) {
  const fetchSql = Prisma.sql`
    WITH source AS (
      SELECT grammar_id AS id, meaning_vi AS meaning, grammar_usage AS usage_text, note,
        encode(sha256(convert_to(
          coalesce(meaning_vi,'') || chr(31) || coalesce(grammar_usage,'') || chr(31) || coalesce(note,''), 'UTF8'
        )), 'hex') AS source_hash
      FROM grammar
      WHERE meaning_vi IS NOT NULL OR grammar_usage IS NOT NULL OR note IS NOT NULL
    )
    SELECT s.* FROM source s
    LEFT JOIN grammar_translation t ON t.grammar_id = s.id AND t.language = ${args.lang}
    WHERE t.id IS NULL OR t.source_hash IS DISTINCT FROM s.source_hash
    ORDER BY s.id
    LIMIT ${args.limit}
  `;
  return {
    name: "grammar",
    fetchSql,
    fields: ["meaning", "usage_text", "note"],
    geminiOptions,
    args,
    upsert: (row, result) =>
      prisma.$executeRaw(Prisma.sql`
        INSERT INTO grammar_translation (grammar_id, language, meaning, usage_text, note, provider, source_hash, created_at, updated_at)
        VALUES (${row.id}, ${args.lang}, ${result.meaning ?? null}, ${result.usage_text ?? null}, ${result.note ?? null}, 'gemini', ${row.source_hash}, NOW(), NOW())
        ON CONFLICT (grammar_id, language) DO UPDATE SET
          meaning = EXCLUDED.meaning, usage_text = EXCLUDED.usage_text, note = EXCLUDED.note,
          provider = EXCLUDED.provider, source_hash = EXCLUDED.source_hash, updated_at = NOW()
      `),
  };
}

function buildGrammarUsageTask(args, geminiOptions) {
  const fetchSql = Prisma.sql`
    WITH source AS (
      SELECT usage_id AS id, example_vi AS example,
        encode(sha256(convert_to(coalesce(example_vi,''), 'UTF8')), 'hex') AS source_hash
      FROM grammar_usage
      WHERE example_vi IS NOT NULL
    )
    SELECT s.* FROM source s
    LEFT JOIN grammar_usage_translation t ON t.usage_id = s.id AND t.language = ${args.lang}
    WHERE t.id IS NULL OR t.source_hash IS DISTINCT FROM s.source_hash
    ORDER BY s.id
    LIMIT ${args.limit}
  `;
  return {
    name: "grammar_usage",
    fetchSql,
    fields: ["example"],
    geminiOptions,
    args,
    upsert: (row, result) =>
      prisma.$executeRaw(Prisma.sql`
        INSERT INTO grammar_usage_translation (usage_id, language, example, provider, source_hash, created_at, updated_at)
        VALUES (${row.id}, ${args.lang}, ${result.example ?? null}, 'gemini', ${row.source_hash}, NOW(), NOW())
        ON CONFLICT (usage_id, language) DO UPDATE SET
          example = EXCLUDED.example, provider = EXCLUDED.provider,
          source_hash = EXCLUDED.source_hash, updated_at = NOW()
      `),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");

  const model = process.env.GEMINI_TRANSLATE_MODEL || "gemini-3.5-flash-lite";
  const languageName = LANGUAGE_NAMES[args.lang] || args.lang;
  const geminiOptions = { model, apiKey, languageName };

  console.log(`Translating to '${args.lang}' (${languageName}) using model '${model}'${args.dryRun ? " [dry-run]" : ""}`);

  const allTasks = {
    vocabulary: () => buildVocabularyTask(args, geminiOptions),
    "vocabulary-example": () => buildVocabularyExampleTask(args, geminiOptions),
    grammar: () => buildGrammarTask(args, geminiOptions),
    "grammar-usage": () => buildGrammarUsageTask(args, geminiOptions),
  };

  const typesToRun = args.type === "all" ? Object.keys(allTasks) : [args.type];
  const summary = {};
  for (const type of typesToRun) {
    if (!allTasks[type]) throw new Error(`Unknown --type '${type}'`);
    summary[type] = await processType(allTasks[type]());
  }

  console.log("\n=== Summary ===");
  for (const [type, stats] of Object.entries(summary)) {
    console.log(`${type}: translated=${stats.translated}, failed=${stats.failed}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
