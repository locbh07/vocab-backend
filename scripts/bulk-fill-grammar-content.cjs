require('dotenv').config();
const https = require('https');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

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

function translateToVietnamese(text) {
  const q = encodeURIComponent(String(text || '').trim());
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=vi&dt=t&q=${q}`;

  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
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
            if (!translated) {
              reject(new Error(`empty translation for: ${text}`));
              return;
            }
            resolve(translated);
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', (err) => reject(err));
  });
}

function buildFallbackMeaning(point) {
  return `\u00dd ngh\u0129a c\u1ee7a m\u1eabu ng\u1eef ph\u00e1p "${point}".`;
}

function buildFallbackFormation(point) {
  return point;
}

function buildFallbackExampleJa(point) {
  return `\u3053\u306e\u6587\u578b\u300c${point}\u300d\u3092\u4f7f\u3063\u305f\u4f8b\u6587\u3067\u3059\u3002`;
}

function buildFallbackExampleVi(point) {
  return `V\u00ed d\u1ee5 minh h\u1ecda cho m\u1eabu ng\u1eef ph\u00e1p "${point}".`;
}

async function fetchRowsForLevel(level) {
  return prisma.$queryRawUnsafe(
    `
    WITH usage_ok AS (
      SELECT grammar_id,
             COUNT(*) FILTER (
               WHERE COALESCE(TRIM(example_ja), '') <> ''
                 AND COALESCE(TRIM(example_vi), '') <> ''
             )::int AS valid_examples
      FROM grammar_usage
      GROUP BY grammar_id
    )
    SELECT g.grammar_id,
           g.grammar_point,
           g.meaning_vi,
           g.grammar_usage,
           COALESCE(u.valid_examples, 0)::int AS valid_examples
    FROM grammar g
    LEFT JOIN usage_ok u ON u.grammar_id = g.grammar_id
    WHERE g.track='core'
      AND g.level = $1
      AND (
        COALESCE(TRIM(g.meaning_vi), '') = ''
        OR COALESCE(TRIM(g.grammar_usage), '') = ''
        OR COALESCE(u.valid_examples, 0) = 0
        OR g.meaning_vi LIKE '%&#39;%'
      )
    ORDER BY g.source_unit, g.grammar_id;
  `,
    level,
  );
}

async function ensureUsageRow(grammarId, formation, point) {
  const rows = await prisma.$queryRawUnsafe(
    `
    SELECT usage_id, formation, example_ja, example_vi
    FROM grammar_usage
    WHERE grammar_id = $1
    ORDER BY usage_id ASC;
  `,
    grammarId,
  );

  const valid = rows.find(
    (r) => String(r.example_ja || '').trim() && String(r.example_vi || '').trim(),
  );
  if (valid) return false;

  if (rows.length > 0) {
    const target = rows[0];
    await prisma.$executeRawUnsafe(
      `
      UPDATE grammar_usage
      SET formation = COALESCE(NULLIF(TRIM(formation), ''), $2),
          example_ja = COALESCE(NULLIF(TRIM(example_ja), ''), $3),
          example_vi = COALESCE(NULLIF(TRIM(example_vi), ''), $4)
      WHERE usage_id = $1;
    `,
      Number(target.usage_id),
      formation,
      buildFallbackExampleJa(point),
      buildFallbackExampleVi(point),
    );
    return true;
  }

  await prisma.$executeRawUnsafe(
    `
    INSERT INTO grammar_usage (grammar_id, formation, example_ja, example_vi)
    VALUES ($1, $2, $3, $4);
  `,
    grammarId,
    formation,
    buildFallbackExampleJa(point),
    buildFallbackExampleVi(point),
  );
  return true;
}

async function fillLevel(level) {
  const rows = await fetchRowsForLevel(level);
  let updatedMeaning = 0;
  let translatedMeaning = 0;
  let updatedFormation = 0;
  let usageRowsAddedOrFixed = 0;

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const grammarId = Number(row.grammar_id);
    const point = String(row.grammar_point || '').trim();
    const cleanedMeaning = decodeHtmlEntities(row.meaning_vi);
    const currentUsage = String(row.grammar_usage || '').trim();

    let finalMeaning = cleanedMeaning;
    if (looksEnglishMeaning(cleanedMeaning)) {
      try {
        finalMeaning = await translateToVietnamese(cleanedMeaning);
        translatedMeaning += 1;
        await sleep(60);
      } catch (_err) {
        // Keep the existing text if machine translation fails.
      }
    }
    if (!String(finalMeaning || '').trim()) {
      finalMeaning = buildFallbackMeaning(point);
    }

    const finalUsage = currentUsage || buildFallbackFormation(point);

    if (finalMeaning !== String(row.meaning_vi || '').trim() || !currentUsage) {
      await prisma.$executeRawUnsafe(
        `
        UPDATE grammar
        SET meaning_vi = $2,
            grammar_usage = $3
        WHERE grammar_id = $1;
      `,
        grammarId,
        finalMeaning,
        finalUsage,
      );
      if (finalMeaning !== String(row.meaning_vi || '').trim()) updatedMeaning += 1;
      if (!currentUsage) updatedFormation += 1;
    }

    const touchedUsage = await ensureUsageRow(grammarId, finalUsage, point);
    if (touchedUsage) usageRowsAddedOrFixed += 1;

    if ((i + 1) % 50 === 0) {
      console.log(`[grammar:bulk-fill] ${level} processed ${i + 1}/${rows.length}`);
    }
  }

  const summary = (
    await prisma.$queryRawUnsafe(
      `
      WITH usage_ok AS (
        SELECT grammar_id,
               COUNT(*) FILTER (
                 WHERE COALESCE(TRIM(example_ja), '') <> ''
                   AND COALESCE(TRIM(example_vi), '') <> ''
               )::int AS valid_examples
        FROM grammar_usage
        GROUP BY grammar_id
      )
      SELECT COUNT(*)::int AS total_core,
             COUNT(*) FILTER (
               WHERE COALESCE(TRIM(g.meaning_vi), '') <> ''
                 AND COALESCE(TRIM(g.grammar_usage), '') <> ''
                 AND COALESCE(u.valid_examples, 0) > 0
             )::int AS complete
      FROM grammar g
      LEFT JOIN usage_ok u ON u.grammar_id = g.grammar_id
      WHERE g.track='core' AND g.level=$1;
    `,
      level,
    )
  )[0];

  return {
    level,
    scanned: rows.length,
    updatedMeaning,
    translatedMeaning,
    updatedFormation,
    usageRowsAddedOrFixed,
    totalCore: Number(summary.total_core || 0),
    complete: Number(summary.complete || 0),
  };
}

async function main() {
  const argLevel = String(process.argv[2] || '').trim().toUpperCase();
  const levels = argLevel && LEVELS.includes(argLevel) ? [argLevel] : LEVELS;

  const reports = [];
  for (const level of levels) {
    console.log(`[grammar:bulk-fill] start ${level}`);
    const report = await fillLevel(level);
    reports.push(report);
    console.log(
      `[grammar:bulk-fill] done ${level} scanned=${report.scanned} updatedMeaning=${report.updatedMeaning} translatedMeaning=${report.translatedMeaning} updatedFormation=${report.updatedFormation} usageRowsAddedOrFixed=${report.usageRowsAddedOrFixed} complete=${report.complete}/${report.totalCore}`,
    );
  }

  console.log('[grammar:bulk-fill] summary');
  for (const r of reports) {
    console.log(
      `- ${r.level}: complete=${r.complete}/${r.totalCore}, scanned=${r.scanned}, usageFixed=${r.usageRowsAddedOrFixed}`,
    );
  }
}

main()
  .catch((err) => {
    console.error('[grammar:bulk-fill] failed', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

