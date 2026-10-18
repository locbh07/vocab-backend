/* eslint-disable no-console */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
require('dotenv').config();

const prisma = new PrismaClient();

function parseArgs(argv) {
  const args = {};
  for (const raw of argv.slice(2)) {
    const match = raw.match(/^--([^=]+)(?:=(.*))?$/);
    if (match) args[match[1]] = match[2] === undefined ? true : match[2];
  }
  if (!args.input) throw new Error('Usage: node scripts/import-ai-exam-explanations.cjs --input=<results-folder> [--apply]');
  return { input: path.resolve(process.cwd(), String(args.input)), apply: Boolean(args.apply) };
}

function cleanText(value) {
  return String(value ?? '').replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item)).digest('hex').slice(0, 16);
}

function currentSource(row, locator) {
  const data = row.json_data || {};
  const section = (data.sections || [])[locator.section_index];
  const question = section?.questions?.[locator.question_index];
  if (!question) return null;
  const passages = new Map((data.passages || []).map((passage) => [String(passage.pid), cleanText(passage.passage)]));
  return {
    section: cleanText(section.sec),
    passage: cleanText(question.passage || passages.get(String(question.pid)) || ''),
    question: cleanText(question.ques || question.question_html),
    options: Object.fromEntries(Object.entries(question.options || {}).map(([key, value]) => [key, cleanText(value)])),
    correct_answer: String(question.answer ?? ''),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const files = fs.statSync(args.input).isDirectory()
    ? fs.readdirSync(args.input).filter((name) => name.endsWith('.json')).sort().map((name) => path.join(args.input, name))
    : [args.input];
  if (!files.length) throw new Error(`No JSON result files found in ${args.input}`);

  const submitted = files.flatMap((file) => {
    const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (data.target !== 'exam-explanations' || !Array.isArray(data.items)) throw new Error(`Invalid exam result file: ${file}`);
    return data.items;
  });
  const accepted = submitted.filter((item) => ['completed', 'updated', 'approved'].includes(String(item.review_status || '').toLowerCase()) && String(item.proposed_explanation_vi || '').trim());
  const seen = new Set();
  const errors = [];
  const changes = [];

  for (const item of accepted) {
    if (seen.has(item.id)) { errors.push(`${item.id}: duplicate id`); continue; }
    seen.add(item.id);
    const locator = item.locator || {};
    const row = await prisma.jlptExam.findUnique({ where: { level_exam_id_part: { level: String(locator.level), exam_id: String(locator.exam_id), part: Number(locator.part) } } });
    if (!row) { errors.push(`${item.id}: exam part not found`); continue; }
    const source = currentSource(row, locator);
    if (!source) { errors.push(`${item.id}: question not found`); continue; }
    if (fingerprint(source) !== item.source_fingerprint) { errors.push(`${item.id}: source changed after export`); continue; }
    const explanation = String(item.proposed_explanation_vi).trim();
    if (explanation.length < 10 || explanation.length > 5000) { errors.push(`${item.id}: explanation length must be 10..5000`); continue; }
    changes.push({ item, row, explanation });
  }

  if (errors.length) {
    console.error(JSON.stringify({ mode: args.apply ? 'apply' : 'dry-run', valid: changes.length, errors }, null, 2));
    process.exitCode = 1;
    return;
  }

  const grouped = new Map();
  for (const change of changes) {
    const key = `${change.row.level}:${change.row.exam_id}:${change.row.part}`;
    if (!grouped.has(key)) grouped.set(key, { row: change.row, changes: [] });
    grouped.get(key).changes.push(change);
  }

  if (args.apply) {
    await prisma.$transaction(async (tx) => {
      for (const group of grouped.values()) {
        const jsonData = structuredClone(group.row.json_data);
        await tx.jlptExamRevision.create({ data: { level: group.row.level, exam_id: group.row.exam_id, part: group.row.part, note: 'Before AI web explanation import', json_data: group.row.json_data } });
        for (const change of group.changes) {
          const { section_index: sectionIndex, question_index: questionIndex } = change.item.locator;
          jsonData.sections[sectionIndex].questions[questionIndex].expl = change.explanation.replace(/\n/g, '<br/>');
        }
        await tx.jlptExam.update({ where: { id: group.row.id }, data: { json_data: jsonData } });
      }
    });
  }
  console.log(JSON.stringify({ mode: args.apply ? 'applied' : 'dry-run', result_files: files.length, submitted: submitted.length, accepted: accepted.length, valid_changes: changes.length, exam_parts_changed: grouped.size }, null, 2));
}

main().catch((error) => { console.error(error.message || error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
