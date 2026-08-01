/* eslint-disable no-console */
// Generates a translated-meanings overlay for the bundled kanji dataset (Pattern D in
// content_translation_architecture.md — a static asset merged client-side, no backend/DB
// involvement). Source: vocab-frontend/public/data/kanji/kanji-en.json (13k+ entries, English
// glosses). Output: vocab-frontend/public/data/kanji/kanji-<lang>.json, a sparse
// `{ [char]: { meanings: string[] } }` map — intentionally NOT a full parallel dataset, since
// strokes/readings/grade/jlpt are already language-neutral and stay sourced from kanji-en.json
// at merge time (see KanjiList.jsx/KanjiPracticePage.jsx/KanjiTodayPanel.jsx for the merge).
//
// Scoped by default to "relevant" kanji only — Joyo (grade 1-6 or 8) or JLPT-tagged, ~2,400
// characters, the set actually reachable through this app's level filters — not the full raw
// 13k-entry dictionary. Pass --all to cover every kanji-en.json entry instead.
//
// Idempotent/resumable: characters already present in the output file are skipped unless
// --force. Checkpoints to disk periodically so an interrupted run doesn't lose progress.
//
// Usage: node scripts/generate-kanji-meanings-lang.cjs --lang zh [--batch-size 25] [--delay-ms 400] [--all] [--force] [--dry-run]
require("dotenv").config();
const fs = require("fs");
const path = require("path");

const LANGUAGE_NAMES = {
  zh: "Chinese (Simplified)",
  ko: "Korean",
  pt: "Portuguese (Brazil)",
  id: "Indonesian",
  ne: "Nepali",
  my: "Burmese",
  fil: "Filipino",
};

const FRONTEND_KANJI_DIR = path.resolve(__dirname, "..", "..", "vocab-frontend", "public", "data", "kanji");

function parseArgs(argv) {
  const out = { lang: null, batchSize: 25, delayMs: 400, all: false, force: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--lang") out.lang = String(argv[++i] || "").trim();
    else if (arg === "--batch-size") out.batchSize = Math.max(1, Number(argv[++i] || out.batchSize));
    else if (arg === "--delay-ms") out.delayMs = Math.max(0, Number(argv[++i] || out.delayMs));
    else if (arg === "--all") out.all = true;
    else if (arg === "--force") out.force = true;
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

const isRelevant = (v) => {
  const isJoyo = Number.isFinite(v.grade) && ((v.grade >= 1 && v.grade <= 6) || v.grade === 8);
  return isJoyo || v.jlpt_new != null || v.jlpt_old != null;
};

async function callGeminiTranslateBatch({ model, apiKey, languageName, items }) {
  const systemInstruction = [
    `You translate English gloss meanings of Japanese kanji characters into ${languageName}.`,
    'Each item has an id (the kanji character itself) and a "meanings" array of short English ' +
      `gloss words/phrases for that character. Translate the array to natural, concise ${languageName} ` +
      "equivalents, keeping the same array order and length where possible.",
    "Do NOT add pinyin/romanization or explanations — output only the translated gloss words/phrases.",
    'Return strict JSON: {"items":[{"id": "<same id>", "meanings": ["...", "..."]}]}. One output item per input item, matching ids exactly.',
  ].join(" ");

  const prompt = JSON.stringify({ items: items.map((item) => ({ id: item.id, meanings: item.meanings })) });

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
  if (!args.lang) throw new Error("--lang is required, e.g. --lang zh");
  const languageName = LANGUAGE_NAMES[args.lang];
  if (!languageName) throw new Error(`Add "${args.lang}" to LANGUAGE_NAMES in this script first.`);
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");
  const model = process.env.GEMINI_TRANSLATE_MODEL || "gemini-3.5-flash-lite";

  const enPath = path.join(FRONTEND_KANJI_DIR, "kanji-en.json");
  const outPath = path.join(FRONTEND_KANJI_DIR, `kanji-${args.lang}.json`);
  const rawEn = JSON.parse(fs.readFileSync(enPath, "utf8"));
  const existing = !args.force && fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, "utf8")) : {};

  const entries = Object.entries(rawEn).filter(([, v]) => args.all || isRelevant(v));
  const pending = entries.filter(([char, v]) => !existing[char] && Array.isArray(v.meanings) && v.meanings.length);

  console.log(
    `Translating to '${args.lang}' (${languageName}) using model '${model}'${args.dryRun ? " [dry-run]" : ""}`,
  );
  console.log(`Target set: ${entries.length} char(s) (${args.all ? "all kanji-en.json entries" : "Joyo + JLPT-tagged"}).`);
  console.log(`${pending.length} char(s) need a ${languageName} meanings translation.`);
  if (!pending.length) return;

  const items = pending.map(([char, v]) => ({ id: char, meanings: v.meanings }));
  const batches = chunk(items, args.batchSize);
  let translated = 0;
  let failed = 0;

  for (let i = 0; i < batches.length; i += 1) {
    const byId = await translateBatchWithRetry({ model, apiKey, languageName }, batches[i]);
    for (const item of batches[i]) {
      const result = byId.get(String(item.id));
      if (!result || !Array.isArray(result.meanings) || !result.meanings.length) {
        failed += 1;
        continue;
      }
      if (!args.dryRun) existing[item.id] = { meanings: result.meanings };
      translated += 1;
    }
    console.log(`  batch ${i + 1}/${batches.length} done (translated=${translated}, failed=${failed})`);
    if (!args.dryRun && i % 10 === 0) {
      fs.writeFileSync(outPath, JSON.stringify(existing), "utf8");
    }
    if (args.delayMs && i < batches.length - 1) await sleep(args.delayMs);
  }

  if (!args.dryRun) {
    fs.writeFileSync(outPath, JSON.stringify(existing), "utf8");
    console.log(`Wrote ${outPath}`);
  }
  console.log(`Done. translated=${translated}, failed=${failed}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
