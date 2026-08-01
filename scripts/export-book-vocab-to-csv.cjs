/* eslint-disable no-console */
// Export a tmp_vocab_export/<book>.json file to a CSV that's easy to review/edit
// in Excel or Google Sheets, then re-import with import-csv-to-book-vocab.cjs.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'tmp_vocab_export');

function parseArgs(argv) {
  const book = argv[2] && !argv[2].startsWith('--') ? argv[2] : 'mimi-n3';
  return { book };
}

function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function main() {
  const { book } = parseArgs(process.argv);
  const inputPath = path.join(DATA_DIR, `${book}.json`);
  if (!fs.existsSync(inputPath)) {
    console.error(`Not found: ${inputPath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(inputPath, 'utf8').replace(/^﻿/, '');
  const data = JSON.parse(raw);
  const header = ['stt', 'topic', 'word_ja', 'hiragana', 'word_vi', 'word_en', 'example_ja', 'example_vi', 'note'];
  const lines = [header.join(',')];

  data.forEach((item, index) => {
    const examples = Array.isArray(item.examples) ? item.examples : [];
    const exampleJa = examples.map((e) => e.jp || e.ja || '').join('\n');
    const exampleVi = examples.map((e) => e.vi || '').join('\n');
    const row = [
      index + 1,
      item.topic || '',
      item.word_ja || '',
      item.hiragana || '',
      item.word_vi || '',
      item.word_en || '',
      exampleJa,
      exampleVi,
      item.note || '',
    ];
    lines.push(row.map(csvEscape).join(','));
  });

  const outputPath = path.join(DATA_DIR, `${book}-review.csv`);
  // BOM so Excel on Windows opens Japanese/Vietnamese text as UTF-8 instead of mojibake.
  fs.writeFileSync(outputPath, '﻿' + lines.join('\r\n'), 'utf8');
  console.log(`Wrote ${data.length} rows -> ${outputPath}`);
}

main();
