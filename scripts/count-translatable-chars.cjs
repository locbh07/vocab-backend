/* eslint-disable no-console */
// Đếm số ký tự tiếng Việt trong các field cần dịch sang tiếng Anh (word/meaning/example/note),
// ước tính số token và chi phí Gemini 3.5 Flash-Lite cho việc dịch batch.
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

// Giá Gemini 3.5 Flash-Lite (paid tier), theo triệu token — 2026-07.
const PRICE_PER_M_INPUT = 0.3;
const PRICE_PER_M_OUTPUT = 2.5;
// Hệ số ước lượng token/ký tự cho tiếng Việt (có dấu, nhiều token hơn tiếng Anh thuần).
const CHARS_PER_TOKEN = 2.5;

function sumChars(rows, fields) {
  let chars = 0;
  let nonEmptyRows = 0;
  for (const row of rows) {
    let rowHasContent = false;
    for (const field of fields) {
      const value = row[field];
      if (typeof value === "string" && value.trim().length > 0) {
        chars += value.length;
        rowHasContent = true;
      }
    }
    if (rowHasContent) nonEmptyRows += 1;
  }
  return { chars, nonEmptyRows, totalRows: rows.length };
}

function printSection(name, stats) {
  const tokens = Math.ceil(stats.chars / CHARS_PER_TOKEN);
  console.log(`\n${name}`);
  console.log(`  Rows: ${stats.totalRows} (${stats.nonEmptyRows} có nội dung cần dịch)`);
  console.log(`  Ký tự: ${stats.chars.toLocaleString("en-US")}`);
  console.log(`  ~Token ước tính: ${tokens.toLocaleString("en-US")}`);
  return tokens;
}

async function main() {
  const [vocab, vocabExamples, grammar, grammarUsages] = await Promise.all([
    prisma.vocabulary.findMany({
      select: { word_vi: true, example_vi: true },
    }),
    prisma.vocabularyExample.findMany({
      select: { example_vi: true },
    }),
    prisma.grammar.findMany({
      select: { meaning_vi: true, grammar_usage_text: true, note: true },
    }),
    prisma.grammarUsage.findMany({
      select: { example_vi: true },
    }),
  ]);

  let totalTokens = 0;

  totalTokens += printSection(
    "Vocabulary (word_vi + example_vi)",
    sumChars(vocab, ["word_vi", "example_vi"])
  );
  totalTokens += printSection(
    "VocabularyExample (example_vi)",
    sumChars(vocabExamples, ["example_vi"])
  );
  totalTokens += printSection(
    "Grammar (meaning_vi + grammar_usage_text + note)",
    sumChars(grammar, ["meaning_vi", "grammar_usage_text", "note"])
  );
  totalTokens += printSection(
    "GrammarUsage (example_vi)",
    sumChars(grammarUsages, ["example_vi"])
  );

  // Input = tổng token nguồn (tiếng Việt) gửi đi dịch.
  // Output = bản dịch tiếng Anh, giả định độ dài xấp xỉ input (~1.0x, dịch Anh thường ngắn hơn Việt có dấu).
  const inputTokens = totalTokens;
  const outputTokens = Math.ceil(totalTokens * 0.85);

  const inputCost = (inputTokens / 1_000_000) * PRICE_PER_M_INPUT;
  const outputCost = (outputTokens / 1_000_000) * PRICE_PER_M_OUTPUT;
  const totalCost = inputCost + outputCost;

  console.log("\n=== TỔNG ƯỚC TÍNH (dịch 1 lượt sang tiếng Anh) ===");
  console.log(`Input token (VI gốc): ~${inputTokens.toLocaleString("en-US")}`);
  console.log(`Output token (EN dịch, ước ~85% input): ~${outputTokens.toLocaleString("en-US")}`);
  console.log(
    `Chi phí nếu tính phí (Gemini 3.5 Flash-Lite): $${inputCost.toFixed(4)} (input) + $${outputCost.toFixed(4)} (output) = $${totalCost.toFixed(2)}`
  );
  console.log(
    "Lưu ý: đây là ước lượng thô (2.5 ký tự/token cho tiếng Việt), số thật phụ thuộc tokenizer thực tế của model."
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
