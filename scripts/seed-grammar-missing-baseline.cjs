require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const SOURCE_BOOK_BY_LEVEL = {
  N5: 'minna1',
  N4: 'minna2',
  N3: 'shinkanzen_n3',
  N2: 'shinkanzen_n2',
  N1: 'shinkanzen_n1',
};

const BASELINE = {
  N5: [
    { point: 'Vてください', meaning: 'xin hay lam...', usage: 'V-te + kudasai' },
    { point: 'Vないでください', meaning: 'xin dung lam...', usage: 'V-nai + de kudasai' },
    { point: 'Vてもいいです', meaning: 'duoc phep lam...', usage: 'V-te mo ii desu' },
    { point: 'Vてはいけません', meaning: 'khong duoc lam...', usage: 'V-te wa ikemasen' },
    { point: 'Nがほしいです', meaning: 'muon co N', usage: 'N + ga hoshii desu' },
    { point: 'Vたいです', meaning: 'muon lam...', usage: 'V-masu stem + tai desu' },
    { point: 'VたりVたりします', meaning: 'lam nao do... va ...', usage: 'V-ta ri V-ta ri shimasu' },
    { point: 'Vたことがあります', meaning: 'da tung lam...', usage: 'V-ta + koto ga arimasu' },
    { point: 'Vることができます', meaning: 'co the lam...', usage: 'V-ru + koto ga dekimasu' },
    { point: 'Vるまえに', meaning: 'truoc khi lam...', usage: 'V-dic + mae ni' },
    { point: 'Vてから', meaning: 'sau khi lam...', usage: 'V-te kara' },
    { point: 'Sとおもいます', meaning: 'toi nghi rang...', usage: 'S + to omoimasu' },
    { point: 'Sといいます', meaning: 'noi rang...', usage: 'S + to iimasu' },
    { point: 'Nになります', meaning: 'tro thanh N', usage: 'N + ni narimasu' },
  ],
  N4: [
    { point: 'Vたら', meaning: 'neu... thi...', usage: 'V-ta ra' },
    { point: 'Vば', meaning: 'neu... thi...', usage: 'V-e ba / A-kereba / N nara' },
    { point: 'Nなら', meaning: 'neu la N thi...', usage: 'N + nara' },
    { point: 'Vようにする', meaning: 'co gang tao thoi quen', usage: 'V-dic + you ni suru' },
    { point: 'Vようになる', meaning: 'tro nen co the...', usage: 'V-dic + you ni naru' },
    { point: 'Vことにする', meaning: 'quyet dinh lam...', usage: 'V-dic + koto ni suru' },
    { point: 'Vことになる', meaning: 'duoc quyet dinh la...', usage: 'V-dic + koto ni naru' },
    { point: 'Vてしまう', meaning: 'lam xong/lam lo', usage: 'V-te shimau' },
    { point: 'Vておく', meaning: 'lam truoc de chuan bi', usage: 'V-te oku' },
    { point: 'Vてみる', meaning: 'thu lam...', usage: 'V-te miru' },
    { point: 'Vそうです(ve be ngoai)', meaning: 'co ve nhu...', usage: 'V-masu stem + sou desu' },
    { point: 'Sそうです(truyen dat)', meaning: 'nghe noi la...', usage: 'S + sou desu' },
    { point: 'Vられる(ukemi)', meaning: 'the bi dong', usage: 'Passive form' },
    { point: 'Vさせる(shieki)', meaning: 'the sai khien', usage: 'Causative form' },
    { point: 'Vさせられる(shieki ukemi)', meaning: 'the bi bat buoc', usage: 'Causative-passive form' },
    { point: 'Vながら', meaning: 'vua... vua...', usage: 'V-masu stem + nagara' },
    { point: 'Sのに', meaning: 'mac du...', usage: 'Plain + noni' },
  ],
  N3: [
    { point: 'Vるうちに', meaning: 'trong luc...', usage: 'V-dic + uchi ni' },
    { point: 'Vたところ', meaning: 'sau khi thu lam', usage: 'V-ta + tokoro' },
    { point: 'Vたとたん(に)', meaning: 'vua moi... thi', usage: 'V-ta + totan(ni)' },
    { point: 'Vることになる', meaning: 'di den ket qua...', usage: 'V-dic + koto ni naru' },
    { point: 'Vることはない', meaning: 'khong can...', usage: 'V-dic + koto wa nai' },
    { point: 'Vるわけにはいかない', meaning: 'khong the...', usage: 'V-dic + wake ni wa ikanai' },
    { point: 'Vてしょうがない', meaning: 'rat... khong chiu noi', usage: 'V-te shouganai' },
    { point: 'Nにくらべて', meaning: 'so voi N', usage: 'N + ni kurabete' },
    { point: 'Nによって', meaning: 'tuy theo N', usage: 'N + ni yotte' },
    { point: 'Nわりに', meaning: 'du... nhung', usage: 'N no wari ni' },
    { point: 'Sにちがいない', meaning: 'chac chan la...', usage: 'Plain + ni chigainai' },
  ],
  N2: [
    { point: 'Vるにしたがって', meaning: 'cang... cang...', usage: 'V-dic + ni shitagatte' },
    { point: 'Vるにともなって', meaning: 'cung voi su thay doi', usage: 'V-dic + ni tomonatte' },
    { point: 'Vるにちがいない', meaning: 'chac chan la...', usage: 'V-dic + ni chigainai' },
    { point: 'Nにかかわらず', meaning: 'bat ke...', usage: 'N + ni kakawarazu' },
    { point: 'Nに応じて', meaning: 'ung voi, theo', usage: 'N + ni oujite' },
    { point: 'Nに基づいて', meaning: 'dua tren', usage: 'N + ni motozuite' },
    { point: 'Nをめぐって', meaning: 'xoay quanh', usage: 'N + wo megutte' },
    { point: 'Vるかぎり', meaning: 'chung nao con...', usage: 'V-dic + kagiri' },
    { point: 'Vるおそれがある', meaning: 'co nguy co...', usage: 'V-dic + osore ga aru' },
    { point: 'Vるにすぎない', meaning: 'chi don gian la...', usage: 'V-dic + ni suginai' },
    { point: 'Nにほかならない', meaning: 'khong gi khac ngoai', usage: 'N + ni hokanaranai' },
  ],
  N1: [
    { point: 'Vるまでもない', meaning: 'khong can phai...', usage: 'V-dic + made mo nai' },
    { point: 'Vるにたえない', meaning: 'khong chiu noi de...', usage: 'V-dic + ni taenai' },
    { point: 'Vるにかたくない', meaning: 'de dang hinh dung', usage: 'V-dic + ni katakunai' },
    { point: 'Vるをえない', meaning: 'buoc phai...', usage: 'V-dic + wo enai' },
    { point: 'Vるよりほかない', meaning: 'khong con cach nao khac', usage: 'V-dic + yori hoka nai' },
    { point: 'Nに即して', meaning: 'phu hop voi thuc te', usage: 'N + ni sokushite' },
    { point: 'Nを余儀なくされる', meaning: 'bi buoc phai', usage: 'N + wo yoginaku sareru' },
    { point: 'Nを皮切りに', meaning: 'bat dau tu', usage: 'N + wo kawakiri ni' },
    { point: 'Nに至るまで', meaning: 'den ca...', usage: 'N + ni itaru made' },
    { point: 'Nにひきかえ', meaning: 'nguoc lai voi', usage: 'N + ni hikikae' },
  ],
};

function normalizePoint(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[〜～]/g, '~')
    .replace(/[（）\(\)\[\]【】「」『』]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[／/]/g, '/');
}

async function ensureColumns() {
  await prisma.$executeRawUnsafe(`
    ALTER TABLE grammar
      ADD COLUMN IF NOT EXISTS source_book VARCHAR(64),
      ADD COLUMN IF NOT EXISTS source_unit VARCHAR(64),
      ADD COLUMN IF NOT EXISTS track VARCHAR(20) NOT NULL DEFAULT 'core',
      ADD COLUMN IF NOT EXISTS priority INT;
  `);
}

async function getNextPriority(level) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COALESCE(MAX(priority), 0)::int AS max_priority FROM grammar WHERE level = $1;`,
    level,
  );
  const value = Array.isArray(rows) && rows[0] ? Number(rows[0].max_priority) : 0;
  return Number.isFinite(value) ? value + 1 : 1;
}

async function main() {
  await ensureColumns();

  const existingRows = await prisma.$queryRawUnsafe(`
    SELECT grammar_id, level, grammar_point
    FROM grammar
    ORDER BY grammar_id ASC;
  `);
  const byLevel = new Map();
  for (const row of existingRows) {
    const level = String(row.level || '').toUpperCase();
    const key = normalizePoint(row.grammar_point);
    if (!byLevel.has(level)) byLevel.set(level, new Set());
    if (key) byLevel.get(level).add(key);
  }

  let inserted = 0;
  for (const level of Object.keys(BASELINE)) {
    const list = BASELINE[level];
    const existing = byLevel.get(level) || new Set();
    let nextPriority = await getNextPriority(level);
    const sourceBook = SOURCE_BOOK_BY_LEVEL[level];

    for (const item of list) {
      const norm = normalizePoint(item.point);
      if (!norm || existing.has(norm)) continue;

      await prisma.$executeRawUnsafe(
        `
        INSERT INTO grammar (
          grammar_point,
          level,
          source_book,
          source_unit,
          track,
          priority,
          meaning_vi,
          grammar_usage,
          note
        ) VALUES ($1, $2, $3, $4, 'core', $5, $6, $7, $8);
        `,
        item.point,
        level,
        sourceBook,
        item.unit || null,
        nextPriority,
        item.meaning || null,
        item.usage || null,
        'auto-seeded baseline candidate',
      );
      existing.add(norm);
      nextPriority += 1;
      inserted += 1;
    }
  }

  console.log(`[seed-grammar-missing-baseline] inserted: ${inserted}`);
}

main()
  .catch((err) => {
    console.error('[seed-grammar-missing-baseline] failed', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
