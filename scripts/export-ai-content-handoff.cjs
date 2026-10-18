/* eslint-disable no-console */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
require('dotenv').config();

const prisma = new PrismaClient();
const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = {};
  for (const raw of argv.slice(2)) {
    const match = raw.match(/^--([^=]+)(?:=(.*))?$/);
    if (match) args[match[1]] = match[2] === undefined ? true : match[2];
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return {
    output: path.resolve(ROOT, String(args.output || `backups/ai-content-handoff-${stamp}`)),
    level: args.level ? String(args.level).toUpperCase() : null,
    examId: args.examId ? String(args.examId) : null,
    examBatchSize: positiveInt(args['exam-batch-size'], 20),
    vocabBatchSize: positiveInt(args['vocab-batch-size'], 100),
    grammarBatchSize: positiveInt(args['grammar-batch-size'], 50),
  };
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function jsonReplacer(_key, value) {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  return value;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, jsonReplacer, 2)}\n`, 'utf8');
}

function cleanText(value) {
  return String(value ?? '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value, jsonReplacer)).digest('hex').slice(0, 16);
}

function chunks(items, size) {
  const output = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
}

function batchName(index) {
  return `batch-${String(index + 1).padStart(4, '0')}.json`;
}

function writeBatches(output, target, items, size, instructions) {
  const inputDir = path.join(output, target, 'input');
  const resultDir = path.join(output, target, 'results');
  fs.mkdirSync(inputDir, { recursive: true });
  fs.mkdirSync(resultDir, { recursive: true });
  const groups = chunks(items, size);
  groups.forEach((group, index) => {
    writeJson(path.join(inputDir, batchName(index)), {
      format_version: 1,
      target,
      batch_number: index + 1,
      batch_count: groups.length,
      instructions,
      items: group,
    });
  });
  fs.writeFileSync(path.join(resultDir, '.gitkeep'), '', 'utf8');
  return groups.length;
}

function buildExamItems(rows) {
  const items = [];
  for (const row of rows) {
    const data = row.json_data || {};
    const passages = new Map((data.passages || []).map((passage) => [String(passage.pid), cleanText(passage.passage)]));
    (data.sections || []).forEach((section, sectionIndex) => {
      (section.questions || []).forEach((question, questionIndex) => {
        const locator = {
          level: row.level,
          exam_id: row.exam_id,
          part: row.part,
          section_index: sectionIndex,
          question_index: questionIndex,
        };
        const source = {
          section: cleanText(section.sec),
          passage: cleanText(question.passage || passages.get(String(question.pid)) || ''),
          question: cleanText(question.ques || question.question_html),
          options: Object.fromEntries(Object.entries(question.options || {}).map(([key, value]) => [key, cleanText(value)])),
          correct_answer: String(question.answer ?? ''),
        };
        items.push({
          id: `exam:${row.level}:${row.exam_id}:${row.part}:${sectionIndex}:${questionIndex}`,
          locator,
          source_fingerprint: fingerprint(source),
          task: cleanText(question.expl || question.explanation) ? 'review_or_improve' : 'create_explanation',
          source,
          current_explanation_vi: cleanText(question.expl || question.explanation),
          proposed_explanation_vi: '',
          review_status: 'pending',
          review_note_vi: '',
        });
      });
    });
  }
  return items;
}

async function main() {
  const args = parseArgs(process.argv);
  if (fs.existsSync(args.output)) throw new Error(`Output folder already exists: ${args.output}`);
  fs.mkdirSync(args.output, { recursive: true });

  const where = {
    ...(args.level ? { level: args.level } : {}),
    ...(args.examId ? { exam_id: args.examId } : {}),
  };
  const [examRows, vocabulary, grammar] = await Promise.all([
    prisma.jlptExam.findMany({ where, orderBy: [{ level: 'asc' }, { exam_id: 'asc' }, { part: 'asc' }] }),
    prisma.vocabulary.findMany({
      orderBy: [{ level: 'asc' }, { id: 'asc' }],
      select: { id: true, word_ja: true, word_hira_kana: true, word_romaji: true, word_vi: true, example_ja: true, example_vi: true, topic: true, level: true, track: true, source_book: true, source_unit: true },
    }),
    prisma.grammar.findMany({
      orderBy: [{ level: 'asc' }, { grammar_id: 'asc' }],
      include: { usages: { orderBy: { usage_id: 'asc' } } },
    }),
  ]);

  const examItems = buildExamItems(examRows);
  const vocabItems = vocabulary.map((row) => ({
    id: `vocabulary:${row.id}`,
    source_fingerprint: fingerprint(row),
    original: row,
    proposed_patch: {},
    review_status: 'pending',
    review_note_vi: '',
  }));
  const grammarItems = grammar.map((row) => ({
    id: `grammar:${row.grammar_id}`,
    source_fingerprint: fingerprint(row),
    original: row,
    proposed_patch: {},
    proposed_usage_patches: [],
    review_status: 'pending',
    review_note_vi: '',
  }));

  const counts = {
    exam_questions: examItems.length,
    exam_missing_explanations: examItems.filter((item) => item.task === 'create_explanation').length,
    vocabulary: vocabItems.length,
    grammar: grammarItems.length,
  };
  const batches = {
    exam_explanations: writeBatches(args.output, 'exam-explanations', examItems, args.examBatchSize,
      'Chỉ điền proposed_explanation_vi, review_status và review_note_vi. Không sửa id, locator, source hoặc source_fingerprint.'),
    vocabulary: writeBatches(args.output, 'vocabulary', vocabItems, args.vocabBatchSize,
      'Chỉ điền proposed_patch, review_status và review_note_vi. Không sửa original, id hoặc source_fingerprint.'),
    grammar: writeBatches(args.output, 'grammar', grammarItems, args.grammarBatchSize,
      'Chỉ điền proposed_patch, proposed_usage_patches, review_status và review_note_vi. Không sửa original, id hoặc source_fingerprint.'),
  };

  writeJson(path.join(args.output, 'manifest.json'), {
    format_version: 1,
    exported_at: new Date().toISOString(),
    source: 'local PostgreSQL selected by .env; secrets are not included',
    filters: { level: args.level, exam_id: args.examId },
    counts,
    batches,
  });
  fs.copyFileSync(path.join(ROOT, 'docs', 'ai-web-content-handoff.md'), path.join(args.output, 'START_HERE.md'));
  fs.copyFileSync(path.join(ROOT, 'docs', 'ai-web-explanation-golden-samples.md'), path.join(args.output, 'GOLDEN_SAMPLES.md'));
  console.log(JSON.stringify({ output: args.output, counts, batches }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
