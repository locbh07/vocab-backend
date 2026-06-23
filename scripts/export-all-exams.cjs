const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
require('dotenv').config();

const prisma = new PrismaClient();

function jsonReplacer(_key, value) {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  return value;
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, jsonReplacer, 2)}\n`, 'utf8');
}

function parseArgs() {
  const args = process.argv.slice(2);
  const outputFlag = args.findIndex((arg) => arg === '--output');
  const outputAssignment = args.find((arg) => arg.startsWith('--output='));
  const defaultName = `exam-review-export-${new Date().toISOString().slice(0, 10)}`;
  const output = outputFlag >= 0
    ? args[outputFlag + 1]
    : outputAssignment?.slice('--output='.length) || args.find((arg) => !arg.startsWith('-')) || path.join('exports', defaultName);
  if (!output) throw new Error('Missing value after --output');
  return { outputDir: path.resolve(process.cwd(), output) };
}

function keyOf(row, includeQuestion = true) {
  const values = [row.level, row.exam_id, row.part, row.section_index];
  if (includeQuestion) values.push(row.question_index);
  return values.join(':');
}

function rubyToText(value) {
  return String(value || '')
    .replace(/<ruby[^>]*>(.*?)<rt[^>]*>(.*?)<\/rt>.*?<\/ruby>/gis, '$1（$2）')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

function blockquote(value) {
  return rubyToText(value).split('\n').map((line) => `> ${line}`).join('\n');
}

function markdownJson(value) {
  return ['```json', JSON.stringify(value, jsonReplacer, 2), '```'].join('\n');
}

function buildReviewMarkdown(exam, indexes) {
  const lines = [
    `# ${exam.level} – ${exam.exam_id}`,
    '',
    'Bản này dùng để soát chính tả, cách đọc và giải thích. Chỉ những mục đã có trong database mới hiển thị dữ liệu bổ sung.',
    '',
  ];

  for (const part of exam.parts) {
    const data = part.json_data || {};
    lines.push(`## Phần ${part.part}`, '', `Nguồn: \`${part.source_file}\``, '');

    for (const passage of data.passages || []) {
      lines.push(`### Đoạn văn ${passage.pid ?? ''}`.trim(), '', blockquote(passage.passage), '');
    }

    (data.sections || []).forEach((section, sectionIndex) => {
      const passageExplanation = indexes.passage.get(
        [exam.level, exam.exam_id, part.part, sectionIndex].join(':'),
      );
      lines.push(`### ${rubyToText(section.sec) || `Mục ${sectionIndex + 1}`}`, '');
      if (passageExplanation) {
        lines.push('#### Giải thích chung của đoạn/mục', '', markdownJson(passageExplanation.explanation_json), '');
      }

      (section.questions || []).forEach((question, questionIndex) => {
        const lookup = {
          level: exam.level,
          exam_id: exam.exam_id,
          part: part.part,
          section_index: sectionIndex,
          question_index: questionIndex,
        };
        const key = keyOf(lookup);
        const meta = indexes.meta.get(key);
        const reading = indexes.reading.get(key);
        const explanation = indexes.question.get(key);
        const label = meta?.question_label || question.qid || questionIndex + 1;

        lines.push(`#### Câu ${label}`, '', blockquote(question.ques), '');
        Object.entries(question.options || {}).forEach(([option, text]) => {
          lines.push(`- ${option}: ${rubyToText(text)}`);
        });
        lines.push('', `**Đáp án:** ${question.answer ?? ''}`, '');
        if (question.expl) lines.push('**Giải thích gốc:**', '', blockquote(question.expl), '');
        if (reading) lines.push('**Cách đọc đã lưu:**', '', markdownJson(reading.reading_json), '');
        if (explanation) lines.push('**Giải thích chi tiết đã lưu:**', '', markdownJson(explanation.explanation_json), '');
      });
    });
  }
  return `${lines.join('\n')}\n`;
}

async function tableRows(tableName, orderBy) {
  return prisma.$queryRawUnsafe(`SELECT * FROM ${tableName} ORDER BY ${orderBy}`);
}

async function main() {
  const { outputDir } = parseArgs();
  if (fs.existsSync(outputDir)) {
    throw new Error(`Output folder already exists: ${outputDir}`);
  }
  fs.mkdirSync(outputDir, { recursive: true });

  const [examRows, revisions, metadata, readings, questionExplanations, passageExplanations] = await Promise.all([
    prisma.jlptExam.findMany({ orderBy: [{ level: 'asc' }, { exam_id: 'asc' }, { part: 'asc' }] }),
    tableRows('jlpt_exam_revision', 'level, exam_id, part, created_at'),
    tableRows('jlpt_exam_question_meta', 'level, exam_id, part, section_index, question_index'),
    tableRows('jlpt_exam_reading_cache', 'level, exam_id, part, section_index, question_index'),
    tableRows('jlpt_question_explanation', 'level, exam_id, part, section_index, question_index'),
    tableRows('jlpt_passage_explanation', 'level, exam_id, part, section_index'),
  ]);

  const indexes = {
    meta: new Map(metadata.map((row) => [keyOf(row), row])),
    reading: new Map(readings.map((row) => [keyOf(row), row])),
    question: new Map(questionExplanations.map((row) => [keyOf(row), row])),
    passage: new Map(passageExplanations.map((row) => [keyOf(row, false), row])),
  };

  const examsByKey = new Map();
  for (const row of examRows) {
    const examKey = `${row.level}:${row.exam_id}`;
    if (!examsByKey.has(examKey)) {
      examsByKey.set(examKey, { level: row.level, exam_id: row.exam_id, parts: [] });
    }
    examsByKey.get(examKey).parts.push(row);
  }

  const manifest = {
    exported_at: new Date().toISOString(),
    source: 'PostgreSQL tables used by vocab-backend',
    exam_count: examsByKey.size,
    part_count: examRows.length,
    levels: {},
    related_record_counts: {
      revisions: revisions.length,
      question_metadata: metadata.length,
      reading_cache: readings.length,
      question_explanations: questionExplanations.length,
      passage_explanations: passageExplanations.length,
    },
    exams: [],
  };

  for (const exam of examsByKey.values()) {
    const examDir = path.join(outputDir, exam.level, exam.exam_id);
    fs.mkdirSync(examDir, { recursive: true });
    const related = {
      metadata: metadata.filter((row) => row.level === exam.level && row.exam_id === exam.exam_id),
      readings: readings.filter((row) => row.level === exam.level && row.exam_id === exam.exam_id),
      question_explanations: questionExplanations.filter(
        (row) => row.level === exam.level && row.exam_id === exam.exam_id,
      ),
      passage_explanations: passageExplanations.filter(
        (row) => row.level === exam.level && row.exam_id === exam.exam_id,
      ),
      revisions: revisions.filter((row) => row.level === exam.level && row.exam_id === exam.exam_id),
    };
    writeJson(path.join(examDir, 'exam.json'), exam);
    writeJson(path.join(examDir, 'related-data.json'), related);
    fs.writeFileSync(path.join(examDir, 'review.md'), buildReviewMarkdown(exam, indexes), 'utf8');

    manifest.levels[exam.level] = (manifest.levels[exam.level] || 0) + 1;
    manifest.exams.push({
      level: exam.level,
      exam_id: exam.exam_id,
      parts: exam.parts.length,
      folder: `${exam.level}/${exam.exam_id}`,
    });
  }

  const rawDir = path.join(outputDir, '_related-data');
  fs.mkdirSync(rawDir, { recursive: true });
  writeJson(path.join(rawDir, 'all-exams.json'), examRows);
  writeJson(path.join(rawDir, 'all-revisions.json'), revisions);
  writeJson(path.join(rawDir, 'all-question-metadata.json'), metadata);
  writeJson(path.join(rawDir, 'all-readings.json'), readings);
  writeJson(path.join(rawDir, 'all-question-explanations.json'), questionExplanations);
  writeJson(path.join(rawDir, 'all-passage-explanations.json'), passageExplanations);
  writeJson(path.join(outputDir, 'manifest.json'), manifest);
  fs.writeFileSync(
    path.join(outputDir, 'README.md'),
    [
      '# Toàn bộ đề thi JLPT',
      '',
      `- Tổng số đề: ${manifest.exam_count}`,
      `- Tổng số phần: ${manifest.part_count}`,
      `- Theo cấp độ: ${Object.entries(manifest.levels).map(([level, count]) => `${level}: ${count}`).join(', ')}`,
      '',
      'Mỗi thư mục đề có:',
      '',
      '- `review.md`: bản dễ đọc để kiểm tra chính tả, cách đọc và giải thích.',
      '- `exam.json`: nội dung gốc hiện tại của đề.',
      '- `related-data.json`: metadata, cách đọc, giải thích và lịch sử sửa của riêng đề đó.',
      '',
      '`_related-data` chứa bản tổng hợp nguyên trạng của các bảng nội dung liên quan đến đề thi.',
      'Dữ liệu lượt làm bài, mã truy cập và log yêu cầu không được xuất vì không phải nội dung đề thi.',
      '',
    ].join('\n'),
    'utf8',
  );

  console.log(JSON.stringify({ outputDir, ...manifest.related_record_counts, exams: manifest.exam_count, parts: manifest.part_count }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
