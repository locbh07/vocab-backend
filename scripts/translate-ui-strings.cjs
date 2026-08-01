/* eslint-disable no-console */
// Batch-translates missing keys in vocab-frontend/src/i18n/locales/<lang>.json
// from vi.json (the source of truth), using Gemini — same approach as
// batch-translate-content.cjs but for flat UI-string key/value JSON files
// instead of DB rows. Idempotent: only translates keys present in vi.json
// that are missing (or empty) in the target language file.
//
// Usage:
//   node scripts/translate-ui-strings.cjs --lang en [--batch-size 40] [--delay-ms 400] [--dry-run]
require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");

const LOCALES_DIR = path.resolve(__dirname, "..", "..", "vocab-frontend", "src", "i18n", "locales");

function parseArgs(argv) {
  const out = { lang: "en", batchSize: 40, delayMs: 400, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--lang") out.lang = String(argv[++i] || out.lang).trim();
    else if (arg === "--batch-size") out.batchSize = Math.max(1, Number(argv[++i] || out.batchSize));
    else if (arg === "--delay-ms") out.delayMs = Math.max(0, Number(argv[++i] || out.delayMs));
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

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, obj) {
  const sorted = Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]));
  fs.writeFileSync(file, JSON.stringify(sorted, null, 2) + "\n", "utf8");
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

// Canonical VI -> EN terms for recurring domain nouns in this app. Keeping these
// fixed stops Gemini from picking a different synonym per batch (e.g. "Ví dụ" ->
// "Example" one run, "Sample" the next) and gives a known-good anchor to translate
// from when the target language isn't English.
const GLOSSARY_EN = {
  "Từ vựng": "Vocabulary",
  "Ngữ pháp": "Grammar",
  "Ví dụ": "Example",
  "Luyện viết": "Writing Practice",
  "Thẻ ghi nhớ": "Flashcard",
  "Câu hỏi": "Question",
  "Đáp án": "Answer",
  "Giải thích": "Explanation",
  "Chủ đề": "Topic",
  "Bài học": "Lesson",
  "Nghĩa": "Meaning",
  "Cách dùng": "Usage",
  "Yêu thích": "Favorite",
  "Lịch sử": "History",
  "Nghe": "Listening",
};

const TRANSLATION_RULES = [
  "This app shows Japanese vocabulary/grammar content whose meaning/example fields are themselves translated per-language elsewhere. When a Vietnamese UI label names that field generically using the source language name (e.g. 'Nghĩa tiếng Việt', 'nghĩa tiếng Việt', 'định nghĩa tiếng Việt', meaning literally 'Vietnamese meaning/definition'), do NOT translate the language name into the target language — just translate the field concept itself (e.g. 'Meaning', not 'Vietnamese Meaning' or 'French Meaning'). The field's actual content already appears in the target language, so re-naming the language in the label is redundant and wrong.",
  "Do not translate word-for-word. Prefer the shortest natural phrasing a native speaker would actually use in app UI.",
  "Use Title Case for buttons and short nav/menu labels; use sentence case for full sentences, messages, and helper/hint text.",
  "Keep {{placeholder}} tokens exactly unchanged (same spelling, same braces).",
  "Do not add script, characters, or glosses that aren't in the source text (e.g. don't add Japanese kanji like 濁音 next to a romanized term like 'Dakuon' unless the source Vietnamese text itself contained that kanji). Translate only what's there.",
];

async function translateBatch({ model, apiKey, languageName, pairs }) {
  const glossaryLine = Object.entries(GLOSSARY_EN)
    .map(([vi, en]) => `"${vi}" -> "${en}"`)
    .join(", ");

  const systemInstruction = [
    `You translate short Vietnamese UI strings (buttons, labels, messages) for a Japanese-language learning app's interface into ${languageName}.`,
    "Each item has an id and a Vietnamese 'text' value, and may include an optional 'context' hint written by the developer — follow it when present.",
    "Translate to natural, concise UI copy, not a literal word-for-word translation.",
    `Standard glossary — when these Vietnamese terms (or the concept they name) appear, translate them consistently using this English anchor meaning (adapt into ${languageName} from this anchor, not from a different synonym): ${glossaryLine}.`,
    ...TRANSLATION_RULES,
    "Return strict JSON: {\"items\":[{\"id\": <same id>, \"text\": \"...\"}]}. One output item per input item, matching ids exactly.",
  ].join(" ");

  const prompt = JSON.stringify({
    items: pairs.map((p) => ({ id: p.id, text: p.value, ...(p.context ? { context: p.context } : {}) })),
  });

  const model_ = model;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model_)}:generateContent?key=${encodeURIComponent(apiKey)}`;
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

  const items = Array.isArray(parsed?.items) ? parsed.items : [];
  const byId = new Map();
  for (const item of items) {
    if (item && item.id !== undefined) byId.set(String(item.id), String(item.text ?? ""));
  }
  return byId;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");
  const model = process.env.GEMINI_TRANSLATE_MODEL || "gemini-3.5-flash-lite";
  const languageName = LANGUAGE_NAMES[args.lang] || args.lang;

  const viPath = path.join(LOCALES_DIR, "vi.json");
  const targetPath = path.join(LOCALES_DIR, `${args.lang}.json`);
  const contextPath = path.join(LOCALES_DIR, "vi.context.json");
  const source = readJson(viPath);
  const target = readJson(targetPath);
  const contextHints = readJson(contextPath);

  const missingKeys = Object.keys(source).filter((key) => !target[key]);
  console.log(`Source keys: ${Object.keys(source).length}, missing in '${args.lang}': ${missingKeys.length}`);
  if (!missingKeys.length) {
    console.log("Nothing to translate.");
    return;
  }

  const pairs = missingKeys.map((key) => ({ id: key, value: source[key], context: contextHints[key] }));
  const batches = chunk(pairs, args.batchSize);
  let translated = 0;
  let failed = 0;

  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i];
    let byId;
    try {
      byId = await translateBatch({ model, apiKey, languageName, pairs: batch });
    } catch (error) {
      console.warn(`  batch ${i + 1} failed:`, error?.message || error);
      failed += batch.length;
      continue;
    }

    for (const pair of batch) {
      const value = byId.get(pair.id);
      if (!value) {
        failed += 1;
        console.warn(`  no translation returned for key="${pair.id}"`);
        continue;
      }
      if (!args.dryRun) target[pair.id] = value;
      translated += 1;
    }

    console.log(`  batch ${i + 1}/${batches.length} done (translated=${translated}, failed=${failed})`);
    if (args.delayMs && i < batches.length - 1) await sleep(args.delayMs);
  }

  if (args.dryRun) {
    console.log("[dry-run] not writing file.");
  } else {
    writeJson(targetPath, target);
    console.log(`Wrote ${targetPath}`);
  }

  console.log(`Done. translated=${translated}, failed=${failed}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
