/* eslint-disable no-console */
// Convert an edited <book>-review.csv back into tmp_vocab_export/<book>.json,
// so it can then be pushed to the DB with import-book-vocabulary-from-export.cjs.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'tmp_vocab_export');

function parseArgs(argv) {
  const book = argv[2] && !argv[2].startsWith('--') ? argv[2] : 'mimi-n3';
  return { book };
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }

  const header = rows.shift();
  return rows
    .filter((values) => values.length && values.some(Boolean))
    .map((values) => Object.fromEntries(header.map((key, index) => [key, values[index] || ''])));
}

function main() {
  const { book } = parseArgs(process.argv);
  const inputPath = path.join(DATA_DIR, `${book}-review.csv`);
  if (!fs.existsSync(inputPath)) {
    console.error(`Not found: ${inputPath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(inputPath, 'utf8').replace(/^﻿/, '');
  const rows = parseCsv(raw);

  const items = rows
    .map((row) => {
      const wordJa = String(row.word_ja || '').trim();
      if (!wordJa) return null;

      const jaLines = String(row.example_ja || '').split('\n').map((s) => s.trim());
      const viLines = String(row.example_vi || '').split('\n').map((s) => s.trim());
      const lineCount = Math.max(jaLines.length, viLines.length);
      const examples = [];
      for (let i = 0; i < lineCount; i += 1) {
        const jp = jaLines[i] || '';
        const vi = viLines[i] || '';
        if (jp || vi) examples.push({ jp, vi });
      }

      const wordEn = String(row.word_en || '').trim();

      return {
        id: String(row.stt || '').trim() || undefined,
        word_ja: wordJa,
        hiragana: String(row.hiragana || '').trim(),
        word_vi: String(row.word_vi || '').trim(),
        ...(wordEn ? { word_en: wordEn } : {}),
        examples,
        note: String(row.note || '').trim(),
        topic: String(row.topic || '').trim(),
      };
    })
    .filter(Boolean);

  const outputPath = path.join(DATA_DIR, `${book}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(items, null, 2), 'utf8');
  console.log(`Wrote ${items.length} rows -> ${outputPath}`);
}

main();
