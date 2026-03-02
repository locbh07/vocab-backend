const fs = require('fs');
const path = require('path');

const SOURCE_DIR = path.join(__dirname, '..', 'data', 'grammar-reference', 'sources');
const OUT_DIR = path.join(__dirname, '..', 'data', 'grammar-reference');
const OUT_FILE = path.join(OUT_DIR, 'bunpro-reference.json');

const DECKS = [
  {
    key: 'N5',
    sourceBook: 'minna1',
    sourceFile: 'mnn1.html',
    sourceUrl: 'https://bunpro.jp/decks/9fzdtl/%E3%81%BF%E3%82%93%E3%81%AA%E3%81%AE%E6%97%A5%E6%9C%AC%E8%AA%9E-I-Grammar',
  },
  {
    key: 'N4',
    sourceBook: 'minna2',
    sourceFile: 'mnn2.html',
    sourceUrl: 'https://bunpro.jp/decks/6jgltv/%E3%81%BF%E3%82%93%E3%81%AA%E3%81%AE%E6%97%A5%E6%9C%AC%E8%AA%9E-I-I-%5BGrammar%5D',
  },
  {
    key: 'N3',
    sourceBook: 'shinkanzen_n3',
    sourceFile: 'sk_n3.html',
    sourceUrl: 'https://bunpro.jp/decks/zrxuwq/shinkanzen-master-jlpt-n3',
  },
  {
    key: 'N2',
    sourceBook: 'shinkanzen_n2',
    sourceFile: 'sk_n2.html',
    sourceUrl: 'https://bunpro.jp/decks/rmegia/skmn2',
  },
  {
    key: 'N1',
    sourceBook: 'shinkanzen_n1',
    sourceFile: 'sk_n1.html',
    sourceUrl: 'https://bunpro.jp/decks/o49klo/skmn1',
  },
];

function cleanText(input) {
  return String(input || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseChapterBlocks(html) {
  const marker = '<div class="w-100 deck-unit-outer-holder"';
  const parts = html.split(marker);
  if (parts.length <= 1) return [];

  const blocks = [];
  for (let i = 1; i < parts.length; i += 1) {
    const body = marker + parts[i];
    blocks.push(body);
  }
  return blocks;
}

function parseDeckHtml(html, deckMeta) {
  const title = cleanText((/<title>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || '');
  const blocks = parseChapterBlocks(html);
  const items = [];
  let chapterFallback = 1;

  for (const block of blocks) {
    const chapterRaw = (/<div>([^<]*?(?:Chapter|課)[^<]*)<\/div>/i.exec(block) || [])[1] || '';
    const chapter = cleanText(chapterRaw) || `Chapter ${chapterFallback}`;
    if (!chapterRaw) chapterFallback += 1;

    const cardRe =
      /<a href="(\/grammar_points\/[^"]+)"[\s\S]*?<p class="v-text_large--400 deck-card-title">([\s\S]*?)<\/p>/g;
    let match;
    while ((match = cardRe.exec(block)) !== null) {
      const href = match[1];
      const titleText = cleanText(match[2]);
      if (!href || !titleText) continue;
      const slug = href.replace(/^\/grammar_points\//, '').replace(/\?.*$/, '');
      items.push({
        grammarPoint: titleText,
        chapter,
        href,
        slug,
      });
    }
  }

  const dedup = new Map();
  for (const item of items) {
    const key = `${item.slug}||${item.grammarPoint}`;
    if (!dedup.has(key)) dedup.set(key, item);
  }

  return {
    level: deckMeta.key,
    sourceBook: deckMeta.sourceBook,
    sourceUrl: deckMeta.sourceUrl,
    sourceTitle: title,
    count: dedup.size,
    items: Array.from(dedup.values()),
  };
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const output = {
    generatedAt: new Date().toISOString(),
    source: 'bunpro deck HTML',
    levels: {},
  };

  for (const deck of DECKS) {
    const filePath = path.join(SOURCE_DIR, deck.sourceFile);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Missing source file: ${filePath}`);
    }
    const html = fs.readFileSync(filePath, 'utf8');
    const parsed = parseDeckHtml(html, deck);
    output.levels[deck.key] = parsed;
    console.log(`[build-reference] ${deck.key} ${parsed.sourceBook}: ${parsed.count}`);
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2), 'utf8');
  console.log(`[build-reference] wrote ${OUT_FILE}`);
}

main();
