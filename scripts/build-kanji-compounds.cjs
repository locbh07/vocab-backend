#!/usr/bin/env node
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const DEFAULT_JMDICT_URL = 'https://www.edrdg.org/pub/Nihongo/JMdict_e.gz';
const MAZII_WORD_SEARCH_URL = 'https://mazii.net/api/search/word/v3';
const MAZII_KANJI_SEARCH_URL = 'https://mazii.net/api/search/kanji/v3';
const MAZII_DECRYPT_PASSWORD =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAk+47ErEUkqhTJY8YdQ7jkYLe1WXhSsAwl/uWudmHuRMiFodTmd3R7xrQh3dYYTIlMFFn//mINIm8LdCJ2lIS1M6aXUyVS4OI551IS8Musrd2E8cGQDofixcxll/dspL+li15jXD4ktgQaHESvbedA9ppBrMLoetBD2p+gCKXfD8Rnrf/uFNIxJyW4WJJTns4JrbcWojy1JfVP91cs+61ScIPJN1RzMiM8rqL8lBF+AgEjEsOkUTStn0ELKzlOAyl+h81xw1PIFHGLNhTs+GcuQMQyXJrPTQrQsqBlm0LvxUl79ZhzesAxeNWfGQA+V95pKMyaMCuj5QbprID73858wIDAQAB';
const MAZII_DECRYPT_SALT = 'mazii-search-v3';
const MAZII_TIMEOUT_MS = 15000;
const MAZII_PROGRESS_STEP = 200;
const HANVIET_CHAR_OVERRIDES = {};

const args = new Set(process.argv.slice(2));
const includeJmdict = !args.has('--skip-jmdict');
const refreshJmdict = args.has('--refresh-jmdict');
const reset = !args.has('--no-reset');
const dryRun = args.has('--dry-run');
const useMazii = args.has('--use-mazii');
const refreshMaziiCache = args.has('--refresh-mazii-cache');
const maziiBackfillJmdictVi = args.has('--mazii-backfill-jmdict-vi');

const jmdictLimitArg = process.argv.find((arg) => arg.startsWith('--jmdict-limit='));
const jmdictLimit = jmdictLimitArg ? Number(jmdictLimitArg.split('=')[1]) : 0;

const vocabLimitArg = process.argv.find((arg) => arg.startsWith('--vocab-limit='));
const vocabLimit = vocabLimitArg ? Number(vocabLimitArg.split('=')[1]) : 0;

const maziiConcurrencyArg = process.argv.find((arg) => arg.startsWith('--mazii-concurrency='));
const maziiConcurrencyRaw = maziiConcurrencyArg ? Number(maziiConcurrencyArg.split('=')[1]) : 4;
const maziiConcurrency = Number.isFinite(maziiConcurrencyRaw)
  ? Math.max(1, Math.min(10, Number(maziiConcurrencyRaw)))
  : 4;

const maziiJmdictWordLimitArg = process.argv.find((arg) =>
  arg.startsWith('--mazii-jmdict-word-limit='),
);
const maziiJmdictWordLimitRaw = maziiJmdictWordLimitArg
  ? Number(maziiJmdictWordLimitArg.split('=')[1])
  : 5000;
const maziiJmdictWordLimit = Number.isFinite(maziiJmdictWordLimitRaw)
  ? Math.max(0, Number(maziiJmdictWordLimitRaw))
  : 5000;

const maziiJmdictPriArg = process.argv.find((arg) =>
  arg.startsWith('--mazii-jmdict-priority-threshold='),
);
const maziiJmdictPriRaw = maziiJmdictPriArg
  ? Number(maziiJmdictPriArg.split('=')[1])
  : 900;
const maziiJmdictPriorityThreshold = Number.isFinite(maziiJmdictPriRaw)
  ? Math.max(1, Number(maziiJmdictPriRaw))
  : 900;

const maziiBackfillLimitArg = process.argv.find((arg) =>
  arg.startsWith('--mazii-backfill-limit='),
);
const maziiBackfillLimitRaw = maziiBackfillLimitArg
  ? Number(maziiBackfillLimitArg.split('=')[1])
  : 20000;
const maziiBackfillLimit = Number.isFinite(maziiBackfillLimitRaw)
  ? Math.max(1, Number(maziiBackfillLimitRaw))
  : 20000;

const maziiBackfillWordArg = process.argv.find((arg) =>
  arg.startsWith('--mazii-backfill-word='),
);
const maziiBackfillWords = maziiBackfillWordArg
  ? String(maziiBackfillWordArg.split('=')[1] || '')
      .split(',')
      .map((word) => String(word || '').trim())
      .filter(Boolean)
  : [];

const cacheDir = path.join(__dirname, '.cache');
const jmdictGzPath = path.join(cacheDir, 'JMdict_e.gz');
const frontendKanjiDataPath = path.resolve(
  __dirname,
  '../../vocab-frontend/public/data/kanji/kanjiData.json',
);

async function main() {
  console.log('[kanji-compounds] start');
  await ensureTable();

  const mazii = await createMaziiProvider({
    enabled: useMazii,
    refresh: refreshMaziiCache,
    dryRun,
    concurrency: maziiConcurrency,
  });

  if (reset && !dryRun) {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE kanji_compound');
    await prisma.$executeRawUnsafe('TRUNCATE TABLE kanji_compound_lookup_cache');
    console.log('[kanji-compounds] truncated existing tables');
  } else if (!dryRun) {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE kanji_compound_lookup_cache');
    console.log('[kanji-compounds] cleared lookup cache table');
  }

  const hanvietMap = await loadHanvietMap();
  const vocabSummary = await importFromVocabulary(hanvietMap, {
    mazii,
    limit: Number.isFinite(vocabLimit) && vocabLimit > 0 ? vocabLimit : 0,
  });
  console.log(
    `[kanji-compounds] vocabulary done: words=${vocabSummary.words} rows=${vocabSummary.rows} upserted=${vocabSummary.upserted}`,
  );

  if (includeJmdict) {
    const jmdictXml = await loadJMdictXml({ refresh: refreshJmdict });
    if (mazii.enabled && maziiJmdictWordLimit > 0) {
      const candidates = collectJmdictMaziiCandidates(jmdictXml, {
        wordLimit: maziiJmdictWordLimit,
        priorityThreshold: maziiJmdictPriorityThreshold,
        entryLimit: Number.isFinite(jmdictLimit) && jmdictLimit > 0 ? jmdictLimit : 0,
      });
      console.log(
        `[kanji-compounds] mazii jmdict candidates: words=${candidates.words.length} chars(all)=${candidates.kanjiChars.length} pri<=${maziiJmdictPriorityThreshold}`,
      );
      await mazii.prefetchWords(candidates.words);
      await mazii.prefetchKanjis(candidates.kanjiChars);
    }
    const jmdictSummary = await importFromJMdict(hanvietMap, {
      xml: jmdictXml,
      limit: Number.isFinite(jmdictLimit) && jmdictLimit > 0 ? jmdictLimit : 0,
      mazii,
    });
    console.log(
      `[kanji-compounds] jmdict done: entries=${jmdictSummary.entries} rows=${jmdictSummary.rows} upserted=${jmdictSummary.upserted}`,
    );
  } else {
    console.log('[kanji-compounds] skip jmdict by flag');
  }

  if (mazii.enabled && maziiBackfillJmdictVi) {
    const backfillSummary = await backfillJmdictVietnameseFromMazii(mazii, {
      limit: maziiBackfillLimit,
      dryRun,
      words: maziiBackfillWords,
    });
    console.log(
      `[kanji-compounds] mazii jmdict vi backfill: candidates=${backfillSummary.candidates} updated_words=${backfillSummary.updatedWords} updated_rows=${backfillSummary.updatedRows}`,
    );
  }

  if (mazii.enabled) {
    const s = mazii.stats;
    console.log(
      `[kanji-compounds] mazii stats: word{cache_hit=${s.word_cache_hit}, fetched=${s.word_fetched}, missing=${s.word_missing}, errors=${s.word_errors}} kanji{cache_hit=${s.kanji_cache_hit}, fetched=${s.kanji_fetched}, missing=${s.kanji_missing}, errors=${s.kanji_errors}}`,
    );
  }

  const countRows = await prisma.$queryRawUnsafe('SELECT COUNT(*)::int AS c FROM kanji_compound');
  console.log(`[kanji-compounds] total rows=${Number(countRows[0]?.c || 0)}`);
}

async function ensureTable() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS kanji_compound (
      id BIGSERIAL PRIMARY KEY,
      kanji_char VARCHAR(8) NOT NULL,
      word_ja VARCHAR(255) NOT NULL,
      reading_kana VARCHAR(255) NOT NULL DEFAULT '',
      meaning_vi TEXT NOT NULL DEFAULT '',
      meaning_en TEXT NOT NULL DEFAULT '',
      hanviet_word VARCHAR(255) NOT NULL DEFAULT '',
      source VARCHAR(30) NOT NULL,
      source_ref VARCHAR(255) NOT NULL DEFAULT '',
      priority INT NOT NULL DEFAULT 1000,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_kanji_compound_unique
    ON kanji_compound(kanji_char, word_ja, reading_kana, source);
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS idx_kanji_compound_char_priority
    ON kanji_compound(kanji_char, priority, word_ja);
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS kanji_compound_lookup_cache (
      id BIGSERIAL PRIMARY KEY,
      kanji_char VARCHAR(8) NOT NULL,
      limit_size INT NOT NULL,
      compounds_json JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_kanji_compound_lookup_cache_key
    ON kanji_compound_lookup_cache(kanji_char, limit_size);
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS kanji_compound_mazii_word_cache (
      id BIGSERIAL PRIMARY KEY,
      query_word VARCHAR(255) NOT NULL,
      found BOOLEAN NOT NULL DEFAULT FALSE,
      reading_kana VARCHAR(255) NOT NULL DEFAULT '',
      meaning_vi TEXT NOT NULL DEFAULT '',
      payload_json JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_kanji_compound_mazii_word_cache_word
    ON kanji_compound_mazii_word_cache(query_word);
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS kanji_compound_mazii_kanji_cache (
      id BIGSERIAL PRIMARY KEY,
      kanji_char VARCHAR(8) NOT NULL,
      found BOOLEAN NOT NULL DEFAULT FALSE,
      hanviet_char VARCHAR(64) NOT NULL DEFAULT '',
      payload_json JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_kanji_compound_mazii_kanji_cache_char
    ON kanji_compound_mazii_kanji_cache(kanji_char);
  `);
}

async function loadHanvietMap() {
  if (!fs.existsSync(frontendKanjiDataPath)) {
    console.warn(`[kanji-compounds] missing hanviet file: ${frontendKanjiDataPath}`);
    return {};
  }
  const raw = JSON.parse(fs.readFileSync(frontendKanjiDataPath, 'utf8'));
  const map = {};
  for (const row of raw) {
    if (!Array.isArray(row)) continue;
    const char = String(row[0] || '').trim();
    const hvRaw = String(row[1] || '').trim();
    if (!char || !hvRaw) continue;
    const selected = pickHanvietSyllable(char, hvRaw);
    if (!selected) continue;
    map[char] = selected;
  }
  return map;
}

async function importFromVocabulary(hanvietMap, opts) {
  const { mazii, limit } = opts;
  const rows = await prisma.$queryRawUnsafe(`
    SELECT
      id::text AS id,
      COALESCE(word_ja, '') AS word_ja,
      COALESCE(word_hira_kana, '') AS word_hira_kana,
      COALESCE(word_vi, '') AS word_vi,
      core_order
    FROM vocabulary
    WHERE COALESCE(word_ja, '') <> ''
    ORDER BY core_order ASC NULLS LAST, id ASC
  `);

  const sourceRows = Number.isFinite(limit) && limit > 0 ? rows.slice(0, limit) : rows;
  if (mazii.enabled) {
    const wordQueries = [];
    const kanjiChars = new Set();
    for (const row of sourceRows) {
      const wordJa = String(row.word_ja || '').trim();
      if (!wordJa || !containsKanji(wordJa)) continue;
      const normalizedWord = normalizeWordForMazii(wordJa);
      if (normalizedWord) wordQueries.push(normalizedWord);
      for (const ch of uniqueKanjiChars(wordJa)) {
        kanjiChars.add(ch);
      }
    }
    await mazii.prefetchWords(wordQueries);
    await mazii.prefetchKanjis(Array.from(kanjiChars));
  }

  let words = 0;
  let outRows = 0;
  let upserted = 0;
  const buffer = [];

  for (const row of sourceRows) {
    const wordJa = String(row.word_ja || '').trim();
    if (!wordJa || !containsKanji(wordJa)) continue;
    words += 1;
    const chars = uniqueKanjiChars(wordJa);
    if (!chars.length) continue;

    const normalizedWord = normalizeWordForMazii(wordJa);
    const maziiWord = mazii.enabled ? mazii.getWord(normalizedWord) : null;

    const reading = String(maziiWord?.reading_kana || row.word_hira_kana || '').trim();
    const meaningVi = String(maziiWord?.meaning_vi || row.word_vi || '').trim();
    const hvWord = toHanvietWord(wordJa, hanvietMap, mazii);
    const basePriority = Number.isFinite(Number(row.core_order))
      ? Number(row.core_order)
      : 1000000 + Number(row.id || 0);

    for (const ch of chars) {
      buffer.push({
        kanji_char: ch,
        word_ja: wordJa,
        reading_kana: reading,
        meaning_vi: meaningVi,
        meaning_en: '',
        hanviet_word: hvWord,
        source: 'vocabulary',
        source_ref: `vocabulary:${String(row.id || '')}`,
        priority: basePriority,
      });
      outRows += 1;
    }

    if (buffer.length >= 4000) {
      if (!dryRun) upserted += await upsertBatch(buffer);
      buffer.length = 0;
    }
  }

  if (buffer.length > 0) {
    if (!dryRun) upserted += await upsertBatch(buffer);
  }

  return { words, rows: outRows, upserted };
}

async function importFromJMdict(hanvietMap, opts) {
  const { xml: inputXml, limit, mazii } = opts;
  const xml = String(inputXml || '');
  if (!xml) {
    return { entries: 0, rows: 0, upserted: 0 };
  }

  const entryChunks = xml.split('<entry>').slice(1);
  const totalEntries = limit > 0 ? Math.min(entryChunks.length, limit) : entryChunks.length;

  let rows = 0;
  let upserted = 0;
  const buffer = [];

  for (let i = 0; i < totalEntries; i += 1) {
    const body = entryChunks[i].split('</entry>')[0] || '';
    const entSeq = firstMatch(body, /<ent_seq>([^<]+)<\/ent_seq>/);
    const kebs = allMatches(body, /<keb>([^<]+)<\/keb>/g).map(decodeXml);
    if (!kebs.length) continue;
    const rebs = allMatches(body, /<reb>([^<]+)<\/reb>/g).map(decodeXml);
    const glosses = allMatches(body, /<gloss(?:\s+[^>]*)?>([^<]+)<\/gloss>/g).map(decodeXml);
    const kePri = allMatches(body, /<ke_pri>([^<]+)<\/ke_pri>/g);
    const pri = computeJmdictPriority(kePri);
    const meaningEn = glosses.slice(0, 3).join('; ');

    for (const word of kebs) {
      if (!containsKanji(word)) continue;
      const chars = uniqueKanjiChars(word);
      if (!chars.length) continue;
      const maziiWord = mazii?.enabled ? mazii.getWord(normalizeWordForMazii(word)) : null;
      const reading = String(maziiWord?.reading_kana || rebs[0] || '').trim();
      const meaningVi = String(maziiWord?.meaning_vi || '').trim();
      const hvWord = toHanvietWord(word, hanvietMap, mazii);
      for (const ch of chars) {
        buffer.push({
          kanji_char: ch,
          word_ja: word,
          reading_kana: reading,
          meaning_vi: meaningVi,
          meaning_en: meaningEn,
          hanviet_word: hvWord,
          source: 'jmdict',
          source_ref: entSeq ? `jmdict:${entSeq}` : 'jmdict',
          priority: 2000000 + pri,
        });
        rows += 1;
      }
    }

    if (buffer.length >= 6000) {
      if (!dryRun) upserted += await upsertBatch(buffer);
      buffer.length = 0;
      if ((i + 1) % 5000 === 0) {
        console.log(`[kanji-compounds] jmdict progress ${i + 1}/${totalEntries}`);
      }
    }
  }

  if (buffer.length > 0) {
    if (!dryRun) upserted += await upsertBatch(buffer);
  }

  return { entries: totalEntries, rows, upserted };
}

async function backfillJmdictVietnameseFromMazii(mazii, opts) {
  const limit = Number.isFinite(opts?.limit) ? Math.max(1, Number(opts.limit)) : 20000;
  const localDryRun = Boolean(opts?.dryRun);
  const explicitWords = uniqueStrings(opts?.words || []);
  const rows = await prisma.$queryRawUnsafe(
    `
      SELECT DISTINCT word_ja
      FROM kanji_compound
      WHERE source = 'jmdict'
        AND COALESCE(meaning_vi, '') = ''
      ORDER BY word_ja ASC
      LIMIT $1
    `,
    limit,
  );

  const words = uniqueStrings([
    ...explicitWords,
    ...rows.map((row) => String(row.word_ja || '').trim()).filter(Boolean),
  ]);
  if (!words.length) {
    return { candidates: 0, updatedWords: 0, updatedRows: 0 };
  }

  await mazii.prefetchWords(words.map((word) => normalizeWordForMazii(word)));

  let updatedWords = 0;
  let updatedRows = 0;

  for (const wordJa of words) {
    const maziiWord = mazii.getWord(normalizeWordForMazii(wordJa));
    const meaningVi = String(maziiWord?.meaning_vi || '').trim();
    if (!meaningVi) continue;
    if (localDryRun) {
      updatedWords += 1;
      continue;
    }
    const affected = await prisma.$executeRawUnsafe(
      `
        UPDATE kanji_compound
        SET
          meaning_vi = $1,
          reading_kana = CASE
            WHEN COALESCE(reading_kana, '') = '' THEN $2
            ELSE reading_kana
          END,
          updated_at = NOW()
        WHERE source = 'jmdict'
          AND word_ja = $3
          AND COALESCE(meaning_vi, '') = ''
      `,
      meaningVi,
      String(maziiWord?.reading_kana || '').trim(),
      wordJa,
    );
    const count = Number(affected || 0);
    if (count > 0) {
      updatedWords += 1;
      updatedRows += count;
    }
  }

  if (!localDryRun && updatedRows > 0) {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE kanji_compound_lookup_cache');
  }

  return {
    candidates: words.length,
    updatedWords,
    updatedRows,
  };
}

async function loadJMdictXml({ refresh }) {
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

  if (refresh || !fs.existsSync(jmdictGzPath)) {
    console.log(`[kanji-compounds] download ${DEFAULT_JMDICT_URL}`);
    const res = await fetch(DEFAULT_JMDICT_URL);
    if (!res.ok) {
      throw new Error(`Failed to download JMdict_e.gz: HTTP ${res.status}`);
    }
    const arr = await res.arrayBuffer();
    fs.writeFileSync(jmdictGzPath, Buffer.from(arr));
  }

  const gz = fs.readFileSync(jmdictGzPath);
  return zlib.gunzipSync(gz).toString('utf8');
}

function collectJmdictMaziiCandidates(xml, opts) {
  const { wordLimit, priorityThreshold, entryLimit } = opts || {};
  const limit = Number.isFinite(wordLimit) ? Math.max(0, Number(wordLimit)) : 0;
  if (limit <= 0) return { words: [], kanjiChars: [] };

  const threshold = Number.isFinite(priorityThreshold)
    ? Math.max(1, Number(priorityThreshold))
    : 60;
  const chunks = String(xml || '').split('<entry>').slice(1);
  const total = Number.isFinite(entryLimit) && entryLimit > 0 ? Math.min(chunks.length, entryLimit) : chunks.length;

  const words = [];
  const seenWords = new Set();
  const seenChars = new Set();

  for (let i = 0; i < total; i += 1) {
    const body = chunks[i].split('</entry>')[0] || '';
    const kePri = allMatches(body, /<ke_pri>([^<]+)<\/ke_pri>/g);
    const pri = computeJmdictPriority(kePri);

    const kebs = allMatches(body, /<keb>([^<]+)<\/keb>/g).map(decodeXml);
    for (const rawWord of kebs) {
      const word = normalizeWordForMazii(rawWord);
      if (!word || !containsKanji(word) || seenWords.has(word)) continue;
      for (const ch of uniqueKanjiChars(word)) {
        seenChars.add(ch);
      }
      if (words.length >= limit) continue;
      if (pri > threshold) continue;
      seenWords.add(word);
      words.push(word);
    }
  }

  return {
    words,
    kanjiChars: Array.from(seenChars),
  };
}

async function upsertBatch(rows) {
  if (!rows.length) return 0;
  const uniqueRows = dedupeRows(rows);
  if (!uniqueRows.length) return 0;
  const chunkSize = 500;
  let upserted = 0;
  for (let i = 0; i < uniqueRows.length; i += chunkSize) {
    const chunk = uniqueRows.slice(i, i + chunkSize);
    const params = [];
    const valuesSql = chunk
      .map((row, idx) => {
        const base = idx * 9;
        params.push(
          row.kanji_char,
          row.word_ja,
          row.reading_kana || '',
          row.meaning_vi || '',
          row.meaning_en || '',
          row.hanviet_word || '',
          row.source || 'unknown',
          row.source_ref || '',
          Number.isFinite(row.priority) ? row.priority : 9999999,
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`;
      })
      .join(', ');

    await prisma.$executeRawUnsafe(
      `
        INSERT INTO kanji_compound (
          kanji_char, word_ja, reading_kana, meaning_vi, meaning_en, hanviet_word,
          source, source_ref, priority
        )
        VALUES ${valuesSql}
        ON CONFLICT (kanji_char, word_ja, reading_kana, source)
        DO UPDATE SET
          meaning_vi = EXCLUDED.meaning_vi,
          meaning_en = EXCLUDED.meaning_en,
          hanviet_word = EXCLUDED.hanviet_word,
          source_ref = EXCLUDED.source_ref,
          priority = EXCLUDED.priority,
          updated_at = NOW()
      `,
      ...params,
    );
    upserted += chunk.length;
  }
  return upserted;
}

function containsKanji(text) {
  return CJK_RE.test(String(text || ''));
}

function uniqueKanjiChars(word) {
  const seen = new Set();
  const out = [];
  for (const ch of Array.from(String(word || ''))) {
    if (!containsKanji(ch) || seen.has(ch)) continue;
    seen.add(ch);
    out.push(ch);
  }
  return out;
}

function toHanvietWord(word, hanvietMap, mazii) {
  const parts = [];
  for (const ch of Array.from(String(word || ''))) {
    if (!containsKanji(ch)) continue;
    const hvFromMazii = mazii?.enabled ? mazii.getKanjiHanviet(ch) : '';
    const hv = String(hvFromMazii || hanvietMap[ch] || '').trim();
    if (!hv) continue;
    parts.push(hv);
  }
  return parts.join(' ');
}

function pickHanvietSyllable(char, hvRaw) {
  const override = String(HANVIET_CHAR_OVERRIDES[char] || '').trim();
  if (override) return override;
  const parts = String(hvRaw || '')
    .split(/\s+/)
    .map((part) => String(part || '').trim())
    .filter(Boolean);
  if (!parts.length) return '';
  const withDiacritics = parts.find((part) => /[^\x00-\x7F]/.test(part));
  return withDiacritics || parts[0];
}

function computeJmdictPriority(priTags) {
  if (!Array.isArray(priTags) || !priTags.length) return 900;
  const scoreMap = {
    news1: 10,
    ichi1: 10,
    spec1: 10,
    gai1: 20,
    news2: 40,
    ichi2: 40,
    spec2: 50,
    gai2: 60,
  };
  let best = 900;
  for (const tag of priTags) {
    const t = String(tag || '').trim();
    if (!t) continue;
    const score = Object.prototype.hasOwnProperty.call(scoreMap, t) ? scoreMap[t] : 200;
    if (score < best) best = score;
  }
  return best;
}

function firstMatch(input, re) {
  const m = String(input || '').match(re);
  return m ? String(m[1] || '').trim() : '';
}

function allMatches(input, re) {
  const out = [];
  let m = re.exec(String(input || ''));
  while (m) {
    out.push(String(m[1] || '').trim());
    m = re.exec(String(input || ''));
  }
  return out;
}

function decodeXml(text) {
  return String(text || '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function dedupeRows(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = `${row.kanji_char}||${row.word_ja}||${row.reading_kana || ''}||${row.source || ''}`;
    byKey.set(key, row);
  }
  return Array.from(byKey.values());
}

function normalizeWordForMazii(word) {
  return String(word || '')
    .replace(/[＜<][^＞>]*[＞>]/g, '')
    .replace(/\s+/g, '')
    .trim();
}

function sanitizePlainText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeHanvietToken(value) {
  return String(value || '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}]/gu, '')
    .toLowerCase()
    .trim();
}

function extractHanvietFromMaziiMean(mean) {
  const firstPart = String(mean || '').split(/[,;，、]/)[0] || '';
  const compact = sanitizePlainText(firstPart)
    .replace(/[(){}\[\]]/g, ' ')
    .split(/\s+/)
    .find(Boolean);
  if (!compact) return '';
  return normalizeHanvietToken(compact);
}

function pickMaziiMeaningVi(item) {
  const shortMean = sanitizePlainText(item?.short_mean || '');
  if (shortMean) return shortMean;
  const means = Array.isArray(item?.means) ? item.means : [];
  const candidates = [];
  for (const entry of means) {
    const text = sanitizePlainText(entry?.mean || '');
    if (!text) continue;
    if (!candidates.includes(text)) candidates.push(text);
    if (candidates.length >= 3) break;
  }
  return candidates.join('; ');
}

function pickMaziiReading(rawPhonetic) {
  const cleaned = sanitizePlainText(rawPhonetic || '');
  if (!cleaned) return '';
  const first = cleaned.split(/\s+/).find(Boolean);
  return first || cleaned;
}

function pickMaziiWordRecord(payload, queryWord) {
  const data = payload && typeof payload === 'object' ? payload.data : null;
  const items = [];
  if (Array.isArray(data?.words)) items.push(...data.words);
  if (Array.isArray(data?.suggestWords)) items.push(...data.suggestWords);
  if (!items.length) return null;

  const normalizedQuery = normalizeWordForMazii(queryWord);
  const exact = items.find((item) => normalizeWordForMazii(item?.word) === normalizedQuery);
  const partial = items.find((item) =>
    String(normalizeWordForMazii(item?.word)).includes(normalizedQuery),
  );
  const best = exact || partial;
  if (!best) return null;

  return {
    reading_kana: pickMaziiReading(best?.phonetic || ''),
    meaning_vi: pickMaziiMeaningVi(best),
    payload_json: best,
  };
}

function pickMaziiKanjiRecord(payload, kanjiChar) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  if (!results.length) return null;
  const best = results.find((item) => String(item?.kanji || '') === kanjiChar);
  if (!best) return null;
  const hanvietChar = extractHanvietFromMaziiMean(best.mean || '');
  return {
    hanviet_char: hanvietChar,
    payload_json: best,
  };
}

function decryptMaziiPayload(encryptedData) {
  try {
    const [ivBase64, cipherBase64] = String(encryptedData || '').split(':');
    if (!ivBase64 || !cipherBase64) return null;
    const derived = crypto.pbkdf2Sync(
      MAZII_DECRYPT_PASSWORD,
      Buffer.from(MAZII_DECRYPT_SALT, 'utf8'),
      10000,
      48,
      'sha256',
    );
    const key = derived.subarray(0, 32);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivBase64, 'base64'));
    let jsonText = decipher.update(cipherBase64, 'base64', 'utf8');
    jsonText += decipher.final('utf8');
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

async function fetchMaziiJson(url, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MAZII_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const raw = await res.json();
    return raw?.encryptedData ? decryptMaziiPayload(raw.encryptedData) : raw;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function runWithConcurrency(items, concurrency, worker) {
  if (!Array.isArray(items) || items.length === 0) return;
  const size = Math.max(1, Number(concurrency) || 1);
  let index = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) return;
      await worker(items[current], current);
    }
  });
  await Promise.all(workers);
}

function uniqueStrings(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const text = String(value || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

async function loadMaziiWordCacheRows(queryWords) {
  const keys = uniqueStrings(queryWords);
  if (!keys.length) return [];
  return prisma.$queryRawUnsafe(
    `
      SELECT query_word, found, reading_kana, meaning_vi, payload_json
      FROM kanji_compound_mazii_word_cache
      WHERE query_word = ANY($1::text[])
    `,
    keys,
  );
}

async function loadMaziiKanjiCacheRows(kanjiChars) {
  const keys = uniqueStrings(kanjiChars);
  if (!keys.length) return [];
  return prisma.$queryRawUnsafe(
    `
      SELECT kanji_char, found, hanviet_char, payload_json
      FROM kanji_compound_mazii_kanji_cache
      WHERE kanji_char = ANY($1::text[])
    `,
    keys,
  );
}

async function upsertMaziiWordCacheRow(row) {
  await prisma.$executeRawUnsafe(
    `
      INSERT INTO kanji_compound_mazii_word_cache (
        query_word, found, reading_kana, meaning_vi, payload_json, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, NOW(), NOW())
      ON CONFLICT (query_word)
      DO UPDATE SET
        found = EXCLUDED.found,
        reading_kana = EXCLUDED.reading_kana,
        meaning_vi = EXCLUDED.meaning_vi,
        payload_json = EXCLUDED.payload_json,
        updated_at = NOW()
    `,
    row.query_word,
    row.found,
    row.reading_kana || '',
    row.meaning_vi || '',
    row.payload_json ? JSON.stringify(row.payload_json) : null,
  );
}

async function upsertMaziiKanjiCacheRow(row) {
  await prisma.$executeRawUnsafe(
    `
      INSERT INTO kanji_compound_mazii_kanji_cache (
        kanji_char, found, hanviet_char, payload_json, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4::jsonb, NOW(), NOW())
      ON CONFLICT (kanji_char)
      DO UPDATE SET
        found = EXCLUDED.found,
        hanviet_char = EXCLUDED.hanviet_char,
        payload_json = EXCLUDED.payload_json,
        updated_at = NOW()
    `,
    row.kanji_char,
    row.found,
    row.hanviet_char || '',
    row.payload_json ? JSON.stringify(row.payload_json) : null,
  );
}

async function createMaziiProvider({ enabled, refresh, dryRun: localDryRun, concurrency }) {
  const stats = {
    word_cache_hit: 0,
    word_fetched: 0,
    word_missing: 0,
    word_errors: 0,
    kanji_cache_hit: 0,
    kanji_fetched: 0,
    kanji_missing: 0,
    kanji_errors: 0,
  };
  const wordMap = new Map();
  const kanjiMap = new Map();

  if (!enabled) {
    return {
      enabled: false,
      stats,
      prefetchWords: async () => {},
      prefetchKanjis: async () => {},
      getWord: () => null,
      getKanjiHanviet: () => '',
    };
  }

  console.log(`[kanji-compounds] mazii enabled (concurrency=${concurrency}, refresh=${refresh})`);

  return {
    enabled: true,
    stats,
    async prefetchWords(inputWords) {
      const keys = uniqueStrings((inputWords || []).map(normalizeWordForMazii));
      if (!keys.length) return;

      if (!refresh) {
        const cachedRows = await loadMaziiWordCacheRows(keys);
        for (const row of cachedRows) {
          const key = String(row.query_word || '').trim();
          if (!key) continue;
          wordMap.set(key, {
            found: Boolean(row.found),
            reading_kana: sanitizePlainText(row.reading_kana || ''),
            meaning_vi: sanitizePlainText(row.meaning_vi || ''),
          });
        }
        stats.word_cache_hit += cachedRows.length;
      }

      const missing = keys.filter((key) => !wordMap.has(key));
      if (!missing.length) return;

      console.log(`[kanji-compounds] mazii word fetch start: missing=${missing.length}`);
      let done = 0;
      await runWithConcurrency(missing, concurrency, async (queryWord) => {
        let row = null;
        try {
          const payload = await fetchMaziiJson(MAZII_WORD_SEARCH_URL, {
            dict: 'javi',
            type: 'word',
            query: queryWord,
            limit: 20,
            page: 1,
          });
          const parsed = payload ? pickMaziiWordRecord(payload, queryWord) : null;
          if (parsed) {
            row = {
              query_word: queryWord,
              found: true,
              reading_kana: parsed.reading_kana || '',
              meaning_vi: parsed.meaning_vi || '',
              payload_json: parsed.payload_json || null,
            };
            stats.word_fetched += 1;
          } else {
            row = {
              query_word: queryWord,
              found: false,
              reading_kana: '',
              meaning_vi: '',
              payload_json: payload || null,
            };
            stats.word_missing += 1;
          }
        } catch {
          row = {
            query_word: queryWord,
            found: false,
            reading_kana: '',
            meaning_vi: '',
            payload_json: null,
          };
          stats.word_errors += 1;
        }
        wordMap.set(queryWord, row);
        if (!localDryRun) {
          await upsertMaziiWordCacheRow(row);
        }
        done += 1;
        if (done % MAZII_PROGRESS_STEP === 0 || done === missing.length) {
          console.log(`[kanji-compounds] mazii word fetch progress ${done}/${missing.length}`);
        }
      });
    },
    async prefetchKanjis(inputChars) {
      const keys = uniqueStrings(inputChars);
      if (!keys.length) return;

      if (!refresh) {
        const cachedRows = await loadMaziiKanjiCacheRows(keys);
        for (const row of cachedRows) {
          const char = String(row.kanji_char || '').trim();
          if (!char) continue;
          kanjiMap.set(char, {
            found: Boolean(row.found),
            hanviet_char: sanitizePlainText(row.hanviet_char || ''),
          });
        }
        stats.kanji_cache_hit += cachedRows.length;
      }

      const missing = keys.filter((key) => !kanjiMap.has(key));
      if (!missing.length) return;

      console.log(`[kanji-compounds] mazii kanji fetch start: missing=${missing.length}`);
      let done = 0;
      await runWithConcurrency(missing, concurrency, async (kanjiChar) => {
        let row = null;
        try {
          const payload = await fetchMaziiJson(MAZII_KANJI_SEARCH_URL, {
            dict: 'javi',
            type: 'kanji',
            query: kanjiChar,
            page: 1,
          });
          const parsed = payload ? pickMaziiKanjiRecord(payload, kanjiChar) : null;
          if (parsed?.hanviet_char) {
            row = {
              kanji_char: kanjiChar,
              found: true,
              hanviet_char: parsed.hanviet_char,
              payload_json: parsed.payload_json || null,
            };
            stats.kanji_fetched += 1;
          } else {
            row = {
              kanji_char: kanjiChar,
              found: false,
              hanviet_char: '',
              payload_json: payload || null,
            };
            stats.kanji_missing += 1;
          }
        } catch {
          row = {
            kanji_char: kanjiChar,
            found: false,
            hanviet_char: '',
            payload_json: null,
          };
          stats.kanji_errors += 1;
        }
        kanjiMap.set(kanjiChar, row);
        if (!localDryRun) {
          await upsertMaziiKanjiCacheRow(row);
        }
        done += 1;
        if (done % MAZII_PROGRESS_STEP === 0 || done === missing.length) {
          console.log(`[kanji-compounds] mazii kanji fetch progress ${done}/${missing.length}`);
        }
      });
    },
    getWord(word) {
      const key = normalizeWordForMazii(word);
      if (!key) return null;
      const row = wordMap.get(key);
      if (!row?.found) return null;
      return {
        reading_kana: sanitizePlainText(row.reading_kana || ''),
        meaning_vi: sanitizePlainText(row.meaning_vi || ''),
      };
    },
    getKanjiHanviet(kanjiChar) {
      const row = kanjiMap.get(String(kanjiChar || '').trim());
      if (!row?.found) return '';
      return normalizeHanvietToken(row.hanviet_char || '');
    },
  };
}

main()
  .catch((error) => {
    console.error('[kanji-compounds] failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
