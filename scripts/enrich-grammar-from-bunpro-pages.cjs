require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const REF_PATH = path.join(__dirname, '..', 'data', 'grammar-reference', 'bunpro-reference.json');
const LEVELS = ['N5', 'N4', 'N3', 'N2', 'N1'];

const EN_HINT_WORDS = new Set([
  'as',
  'soon',
  'than',
  'the',
  'a',
  'an',
  'to',
  'with',
  'without',
  'from',
  'for',
  'of',
  'in',
  'on',
  'at',
  'by',
  'when',
  'while',
  'after',
  'before',
  'during',
  'until',
  'unless',
  'if',
  'even',
  'though',
  'although',
  'despite',
  'must',
  'should',
  'can',
  'cannot',
  'able',
  'only',
  'just',
  'rather',
  'instead',
  'about',
  'through',
  'against',
  'like',
  'same',
  'no',
  'not',
  'or',
  'and',
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeHtmlEntities(input) {
  const text = String(input || '');
  return text
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function stripTags(input) {
  return decodeHtmlEntities(String(input || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
}

function removeParenContent(input) {
  let s = String(input || '');
  for (let i = 0; i < 3; i += 1) {
    s = s.replace(/\([^)]*\)/g, '').replace(/（[^）]*）/g, '');
  }
  return s;
}

function normalizePoint(input) {
  const base = removeParenContent(String(input || '').normalize('NFKC'));
  return base
    .toLowerCase()
    .replace(/[①②③④⑤⑥⑦⑧⑨⑩]/g, '')
    .replace(/[0-9]/g, '')
    .replace(/[~～]/g, '')
    .replace(/[・･·]/g, '')
    .replace(/[／\\\/]/g, '/')
    .replace(/[「」『』【】〈〉《》、。・]/g, '')
    .replace(/[\s\t\r\n]+/g, '')
    .trim();
}

function hasVietnameseChars(input) {
  return /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(
    String(input || ''),
  );
}

function looksEnglishMeaning(input) {
  const text = decodeHtmlEntities(input);
  if (!text) return false;
  if (hasVietnameseChars(text)) return false;
  if (!/[A-Za-z]/.test(text)) return false;

  const words = text
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return false;

  let hits = 0;
  for (const w of words) {
    if (EN_HINT_WORDS.has(w)) hits += 1;
  }
  return hits >= 2;
}

function isFallbackMeaning(input) {
  return String(input || '').includes('Ý nghĩa của mẫu ngữ pháp');
}

function isFallbackUsage(row) {
  const usage = String(row.grammar_usage || '').trim();
  const point = String(row.grammar_point || '').trim();
  return !usage || usage === point;
}

function isFallbackExample(exampleJa, exampleVi) {
  const ja = String(exampleJa || '');
  const vi = String(exampleVi || '');
  return !ja.trim() || !vi.trim() || ja.includes('この文型') || vi.includes('Ví dụ minh họa');
}

function translate(text, fromLang, toLang) {
  const q = encodeURIComponent(String(text || '').trim());
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${fromLang}&tl=${toLang}&dt=t&q=${q}`;
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0',
          },
        },
        (res) => {
          let raw = '';
          res.on('data', (chunk) => {
            raw += chunk;
          });
          res.on('end', () => {
            try {
              const data = JSON.parse(raw);
              const translated = Array.isArray(data?.[0])
                ? data[0]
                    .map((part) => (Array.isArray(part) ? String(part[0] || '') : ''))
                    .join('')
                    .trim()
                : '';
              resolve(translated || '');
            } catch (err) {
              reject(err);
            }
          });
        },
      )
      .on('error', (err) => reject(err));
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
        },
        (res) => {
          let raw = '';
          res.on('data', (chunk) => {
            raw += chunk;
          });
          res.on('end', () => resolve(raw));
        },
      )
      .on('error', (err) => reject(err));
  });
}

function extractNextData(html) {
  const m = String(html || '').match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/,
  );
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch (_err) {
    return null;
  }
}

function buildExampleFromStudyQuestion(q) {
  const answer = stripTags(q?.answer);
  const contentRaw = String(q?.content || '');
  if (!answer || !contentRaw) return null;

  const withAnswer = contentRaw.replace(/<span class='study-area-input'>____<\/span>/g, answer);
  const ja = stripTags(withAnswer);
  if (!ja) return null;
  return { ja };
}

async function fetchBunproEntry(slug) {
  const url = `https://bunpro.jp/grammar_points/${encodeURIComponent(slug)}`;
  const html = await httpGet(url);
  const data = extractNextData(html);
  if (!data?.props?.pageProps?.reviewable) return null;

  const reviewable = data.props.pageProps.reviewable;
  const included = data?.props?.pageProps?.included || {};
  const studyQuestions = Array.isArray(included.studyQuestions) ? included.studyQuestions : [];

  const chosenQuestion =
    studyQuestions.find((q) => String(q.used_in || '').toLowerCase() === 'examples') ||
    studyQuestions[0];
  const example = buildExampleFromStudyQuestion(chosenQuestion);

  return {
    slug,
    title: stripTags(reviewable.title),
    meaningEn: stripTags(reviewable.meaning),
    structure: stripTags(reviewable.polite_structure || reviewable.casual_structure || ''),
    exampleJa: example?.ja || '',
  };
}

async function loadDbByLevel(level) {
  const rows = await prisma.$queryRawUnsafe(
    `
    SELECT g.grammar_id, g.grammar_point, g.meaning_vi, g.grammar_usage,
           gu.usage_id, gu.example_ja, gu.example_vi
    FROM grammar g
    LEFT JOIN LATERAL (
      SELECT usage_id, example_ja, example_vi
      FROM grammar_usage
      WHERE grammar_id = g.grammar_id
      ORDER BY usage_id ASC
      LIMIT 1
    ) gu ON true
    WHERE g.track='core' AND g.level=$1
    ORDER BY g.grammar_id;
  `,
    level,
  );

  const map = new Map();
  for (const row of rows) {
    const keys = new Set();
    keys.add(normalizePoint(row.grammar_point));
    keys.add(normalizePoint(removeParenContent(row.grammar_point)));
    for (const key of keys) {
      if (!key) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row);
    }
  }
  return map;
}

async function upsertUsage(grammarId, usageId, formation, exampleJa, exampleVi) {
  if (usageId) {
    await prisma.$executeRawUnsafe(
      `
      UPDATE grammar_usage
      SET formation = COALESCE(NULLIF(TRIM(formation), ''), $2),
          example_ja = $3,
          example_vi = $4
      WHERE usage_id = $1;
    `,
      Number(usageId),
      formation || null,
      exampleJa,
      exampleVi,
    );
    return;
  }

  await prisma.$executeRawUnsafe(
    `
    INSERT INTO grammar_usage (grammar_id, formation, example_ja, example_vi)
    VALUES ($1, $2, $3, $4);
  `,
    Number(grammarId),
    formation || null,
    exampleJa,
    exampleVi,
  );
}

function pickTarget(candidates) {
  const sorted = [...new Map(candidates.map((r) => [String(r.grammar_id), r])).values()].sort(
    (a, b) => Number(a.grammar_id) - Number(b.grammar_id),
  );
  return (
    sorted.find(
      (r) =>
        isFallbackUsage(r) ||
        isFallbackExample(r.example_ja, r.example_vi) ||
        looksEnglishMeaning(r.meaning_vi) ||
        isFallbackMeaning(r.meaning_vi),
    ) || sorted[0]
  );
}

async function enrichLevel(level, slugs) {
  const dbMap = await loadDbByLevel(level);
  let matched = 0;
  let notMatched = 0;
  let updated = 0;

  for (let i = 0; i < slugs.length; i += 1) {
    const slug = slugs[i];
    let entry;
    try {
      entry = await fetchBunproEntry(slug);
    } catch (_err) {
      notMatched += 1;
      continue;
    }
    if (!entry?.title) {
      notMatched += 1;
      continue;
    }

    const key = normalizePoint(entry.title);
    const candidates = dbMap.get(key) || [];
    if (candidates.length === 0) {
      notMatched += 1;
      continue;
    }
    matched += 1;
    const target = pickTarget(candidates);

    let nextMeaning = decodeHtmlEntities(target.meaning_vi);
    if (looksEnglishMeaning(nextMeaning) || isFallbackMeaning(nextMeaning) || !nextMeaning) {
      try {
        const vi = await translate(entry.meaningEn, 'en', 'vi');
        if (vi) nextMeaning = vi;
        await sleep(60);
      } catch (_err) {
        // keep existing meaning
      }
    }

    let nextUsage = String(target.grammar_usage || '').trim();
    if (isFallbackUsage(target) && entry.structure) {
      nextUsage = entry.structure;
    } else if (!nextUsage) {
      nextUsage = entry.structure || String(target.grammar_point || '').trim();
    }

    let nextExampleJa = String(target.example_ja || '').trim();
    let nextExampleVi = String(target.example_vi || '').trim();
    if (isFallbackExample(nextExampleJa, nextExampleVi) && entry.exampleJa) {
      nextExampleJa = entry.exampleJa;
      try {
        const vi = await translate(entry.exampleJa, 'ja', 'vi');
        if (vi) nextExampleVi = vi;
        await sleep(60);
      } catch (_err) {
        nextExampleVi = nextExampleVi || '';
      }
      if (!nextExampleVi) {
        nextExampleVi = `Vi du cho mau "${target.grammar_point}".`;
      }
    }

    await prisma.$executeRawUnsafe(
      `
      UPDATE grammar
      SET meaning_vi = $2,
          grammar_usage = $3
      WHERE grammar_id = $1;
    `,
      Number(target.grammar_id),
      nextMeaning || null,
      nextUsage || null,
    );

    await upsertUsage(
      Number(target.grammar_id),
      target.usage_id ? Number(target.usage_id) : null,
      nextUsage || null,
      nextExampleJa || `This sentence uses "${target.grammar_point}".`,
      nextExampleVi || `Vi du cho mau "${target.grammar_point}".`,
    );
    updated += 1;

    if ((i + 1) % 20 === 0) {
      console.log(`[grammar:bunpro-enrich] ${level} processed ${i + 1}/${slugs.length}`);
    }
  }

  return { level, totalSlugs: slugs.length, matched, notMatched, updated };
}

async function main() {
  if (!fs.existsSync(REF_PATH)) {
    throw new Error(`Missing reference file: ${REF_PATH}`);
  }
  const ref = JSON.parse(fs.readFileSync(REF_PATH, 'utf8'));
  const argLevel = String(process.argv[2] || '').trim().toUpperCase();
  const levels = argLevel && LEVELS.includes(argLevel) ? [argLevel] : LEVELS;

  const reports = [];
  for (const level of levels) {
    const items = ref?.levels?.[level]?.items || [];
    const slugs = [...new Set(items.map((x) => String(x.slug || '').trim()).filter(Boolean))];
    console.log(`[grammar:bunpro-enrich] start ${level} slugs=${slugs.length}`);
    const report = await enrichLevel(level, slugs);
    reports.push(report);
    console.log(
      `[grammar:bunpro-enrich] done ${level} updated=${report.updated} matched=${report.matched} notMatched=${report.notMatched}`,
    );
  }

  console.log('[grammar:bunpro-enrich] summary');
  for (const r of reports) {
    console.log(
      `- ${r.level}: updated=${r.updated}, matched=${r.matched}/${r.totalSlugs}, notMatched=${r.notMatched}`,
    );
  }
}

main()
  .catch((err) => {
    console.error('[grammar:bunpro-enrich] failed', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

