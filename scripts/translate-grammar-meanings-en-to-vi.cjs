require('dotenv').config();
const https = require('https');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

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

function hasVietnameseChars(input) {
  return /[ăâêôơưđáàảãạắằẳẵặấầẩẫậéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i.test(
    String(input || ''),
  );
}

function looksEnglishMeaning(input) {
  const text = String(input || '').trim();
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

async function main() {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT grammar_id, level, grammar_point, meaning_vi
    FROM grammar
    ORDER BY level ASC, priority ASC, grammar_id ASC;
  `);

  const candidates = rows.filter((r) => looksEnglishMeaning(r.meaning_vi));
  console.log(`[translate-meaning] candidates=${candidates.length}`);

  let updated = 0;
  let failed = 0;

  for (let i = 0; i < candidates.length; i += 1) {
    const row = candidates[i];
    try {
      const translated = await translateToVietnamese(row.meaning_vi);
      await prisma.$executeRawUnsafe(
        `UPDATE grammar SET meaning_vi = $2 WHERE grammar_id = $1;`,
        Number(row.grammar_id),
        translated,
      );
      updated += 1;
    } catch (_err) {
      failed += 1;
    }
    if ((i + 1) % 30 === 0) {
      console.log(`[translate-meaning] processed=${i + 1}/${candidates.length}`);
    }
    await sleep(80);
  }

  const allAfter = await prisma.$queryRawUnsafe(`
    SELECT meaning_vi FROM grammar;
  `);
  const remain = allAfter.filter((r) => String(r.meaning_vi || '').trim()).length;
  const stillEnglish = allAfter.filter((r) => looksEnglishMeaning(r.meaning_vi)).length;

  console.log(`[translate-meaning] updated=${updated} failed=${failed}`);
  console.log(`[translate-meaning] total_non_empty=${remain}`);
  console.log(`[translate-meaning] english_like_before=${candidates.length}`);
  console.log(`[translate-meaning] english_like_after=${stillEnglish}`);
}

main()
  .catch((err) => {
    console.error('[translate-meaning] failed', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
