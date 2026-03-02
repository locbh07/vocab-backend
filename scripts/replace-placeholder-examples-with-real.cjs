require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const REF_PATH = path.join(__dirname, '..', 'data', 'grammar-reference', 'bunpro-reference.json');

const PLACEHOLDER_JA_MARKERS = ['\u3053\u306e\u6587\u578b', '\u4f8b\u6587\u3067\u3059', 'this sentence uses'];
const PLACEHOLDER_VI_MARKERS = ['ví dụ minh họa', 'ví dụ cho mẫu', 'vi du minh hoa', 'vi du cho mau'];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeHtmlEntities(input) {
  return String(input || '')
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

function isPlaceholder(exampleJa, exampleVi) {
  const ja = String(exampleJa || '').toLowerCase();
  const vi = String(exampleVi || '').toLowerCase();
  const jaHit = PLACEHOLDER_JA_MARKERS.some((m) => ja.includes(m));
  const viHit = PLACEHOLDER_VI_MARKERS.some((m) => vi.includes(m));
  return jaHit || viHit;
}

function normalizePoint(input) {
  return String(input || '')
    .normalize('NFKC')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[~～・･·]/g, '')
    .replace(/[「」『』【】〈〉《》、。]/g, '')
    .replace(/[①②③④⑤⑥⑦⑧⑨⑩]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase()
    .trim();
}

function normalizeUnit(input) {
  const s = String(input || '').normalize('NFKC').trim();
  const m = s.match(/(\d+)/);
  const n = m ? Number(m[1]) : null;
  if (!n) return '';
  if (s.includes('\u8ab2')) return `lesson-${n}`;
  if (s.toLowerCase().includes('chapter')) return `chapter-${n}`;
  if (s.toLowerCase().includes('lesson')) return `lesson-${n}`;
  return `unit-${n}`;
}

function translate(text, from, to) {
  const q = encodeURIComponent(String(text || '').trim());
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=${to}&dt=t&q=${q}`;
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
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
      })
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

function extractExampleFromStudyQuestion(studyQuestions) {
  const list = Array.isArray(studyQuestions) ? studyQuestions : [];
  const q =
    list.find((x) => String(x.used_in || '').toLowerCase() === 'examples') ||
    list.find((x) => String(x.content || '').includes('____')) ||
    list[0];
  if (!q) return '';
  const content = String(q.content || '');
  const answer = stripTags(q.answer || '');
  if (!content) return '';
  const text = content.replace(/<span class='study-area-input'>____<\/span>/g, answer);
  return stripTags(text);
}

async function fetchBunproEntry(slug) {
  const decodedSlug = decodeURIComponent(String(slug || '').trim());
  const url = `https://bunpro.jp/grammar_points/${encodeURIComponent(decodedSlug)}`;
  const html = await httpGet(url);
  const data = extractNextData(html);
  const reviewable = data?.props?.pageProps?.reviewable;
  if (!reviewable) return null;
  const included = data?.props?.pageProps?.included || {};
  return {
    slug,
    title: stripTags(reviewable.title),
    meaningEn: stripTags(reviewable.meaning),
    structure: stripTags(reviewable.polite_structure || reviewable.casual_structure || ''),
    exampleJa: extractExampleFromStudyQuestion(included.studyQuestions),
  };
}

function buildRefIndex(ref) {
  const idx = new Map();
  for (const [level, obj] of Object.entries(ref.levels || {})) {
    for (const item of obj.items || []) {
      const unitKey = normalizeUnit(item.chapter);
      const key = `${level}|${unitKey}`;
      if (!idx.has(key)) idx.set(key, []);
      idx.get(key).push(item);
    }
  }
  return idx;
}

async function main() {
  if (!fs.existsSync(REF_PATH)) {
    throw new Error(`Missing reference file: ${REF_PATH}`);
  }
  const ref = JSON.parse(fs.readFileSync(REF_PATH, 'utf8'));
  const refIndex = buildRefIndex(ref);

  const rows = await prisma.$queryRawUnsafe(`
    SELECT g.grammar_id, g.level, g.grammar_point, g.source_unit, g.priority, g.meaning_vi, g.grammar_usage,
           gu.usage_id, gu.formation, gu.example_ja, gu.example_vi
    FROM grammar g
    JOIN grammar_usage gu ON gu.grammar_id = g.grammar_id
    WHERE g.track='core'
    ORDER BY g.level, g.priority NULLS LAST, g.grammar_id, gu.usage_id;
  `);

  const placeholders = rows.filter((r) => isPlaceholder(r.example_ja, r.example_vi));
  console.log(`[replace-real-examples] placeholders=${placeholders.length}`);
  if (placeholders.length === 0) return;

  const bunproCache = new Map();
  let updated = 0;
  let unmatched = 0;

  for (let i = 0; i < placeholders.length; i += 1) {
    const row = placeholders[i];
    const unitKey = normalizeUnit(row.source_unit);
    const key = `${row.level}|${unitKey}`;
    const candidates = refIndex.get(key) || [];

    let match = null;
    const targetPoint = normalizePoint(row.grammar_point);
    const matchedRefItem =
      candidates.find((item) => normalizePoint(item.grammarPoint) === targetPoint) || null;

    const scanList = matchedRefItem ? [matchedRefItem] : candidates;
    for (const item of scanList) {
      const slug = String(item.slug || '').trim();
      if (!slug) continue;

      if (!bunproCache.has(slug)) {
        try {
          bunproCache.set(slug, await fetchBunproEntry(slug));
        } catch (_err) {
          bunproCache.set(slug, null);
        }
        await sleep(40);
      }
      const entry = bunproCache.get(slug);
      if (!entry?.title) continue;

      if (
        matchedRefItem ||
        normalizePoint(entry.title) === targetPoint ||
        normalizePoint(item.grammarPoint) === targetPoint
      ) {
        match = entry;
        break;
      }
    }

    if (!match || !match.exampleJa) {
      unmatched += 1;
      continue;
    }

    let exampleVi = String(row.example_vi || '').trim();
    try {
      const vi = await translate(match.exampleJa, 'ja', 'vi');
      if (vi) exampleVi = vi;
      await sleep(40);
    } catch (_err) {
      // keep old vi if translation fails
    }

    const formation = String(row.formation || '').trim() || String(match.structure || '').trim() || null;

    await prisma.$executeRawUnsafe(
      `
      UPDATE grammar_usage
      SET formation = COALESCE($2, formation),
          example_ja = $3,
          example_vi = $4
      WHERE usage_id = $1;
    `,
      Number(row.usage_id),
      formation,
      match.exampleJa,
      exampleVi || null,
    );

    if (match.structure && String(row.grammar_usage || '').trim() === String(row.grammar_point || '').trim()) {
      await prisma.$executeRawUnsafe(
        `UPDATE grammar SET grammar_usage = $2 WHERE grammar_id = $1;`,
        Number(row.grammar_id),
        match.structure,
      );
    }
    if (match.meaningEn) {
      const hasEn = /[A-Za-z]/.test(String(row.meaning_vi || '')) &&
        !/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđĐ]/i.test(
          String(row.meaning_vi || ''),
        );
      if (hasEn) {
        try {
          const meaningVi = await translate(match.meaningEn, 'en', 'vi');
          if (meaningVi) {
            await prisma.$executeRawUnsafe(
              `UPDATE grammar SET meaning_vi = $2 WHERE grammar_id = $1;`,
              Number(row.grammar_id),
              meaningVi,
            );
          }
        } catch (_err) {
          // skip
        }
      }
    }

    updated += 1;
    if ((i + 1) % 20 === 0) {
      console.log(`[replace-real-examples] processed ${i + 1}/${placeholders.length}`);
    }
  }

  const remain = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*)::int AS c
    FROM grammar_usage gu
    JOIN grammar g ON g.grammar_id=gu.grammar_id
    WHERE g.track='core'
      AND (
        LOWER(COALESCE(gu.example_ja,'')) LIKE '%この文型%'
        OR LOWER(COALESCE(gu.example_ja,'')) LIKE '%例文です%'
        OR LOWER(COALESCE(gu.example_ja,'')) LIKE '%this sentence uses%'
        OR LOWER(COALESCE(gu.example_vi,'')) LIKE '%ví dụ minh họa%'
        OR LOWER(COALESCE(gu.example_vi,'')) LIKE '%ví dụ cho mẫu%'
        OR LOWER(COALESCE(gu.example_vi,'')) LIKE '%vi du minh hoa%'
        OR LOWER(COALESCE(gu.example_vi,'')) LIKE '%vi du cho mau%'
      );
  `);

  console.log(
    `[replace-real-examples] updated=${updated} unmatched=${unmatched} remainingPlaceholders=${remain[0]?.c ?? 0}`,
  );
}

main()
  .catch((err) => {
    console.error('[replace-real-examples] failed', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
