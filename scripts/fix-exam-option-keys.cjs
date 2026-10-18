const { PrismaClient } = require('@prisma/client');
const envArg = process.argv.find(value => value.startsWith('--env='));
const targetEnv = envArg ? envArg.slice('--env='.length) : 'local';
if (!['local', 'staging', 'production'].includes(targetEnv)) {
  throw new Error(`Unsupported environment: ${targetEnv}`);
}
const apply = process.argv.includes('--apply');
if (apply && targetEnv === 'production' && !process.argv.includes('--confirm-production')) {
  throw new Error('Production apply requires --confirm-production');
}
require('dotenv').config({ path: `.env.${targetEnv}`, override: true });
const prisma = new PrismaClient();

function printedOption(value) {
  const match = String(value || '').match(/^\s*([1-4１-４])(?:\s|　)/u);
  if (!match) return '';
  const code = match[1].charCodeAt(0);
  return code >= 0xff10 ? String(code - 0xfee0) : match[1];
}

async function main() {
  const rows = await prisma.jlptExam.findMany({ orderBy: [{ level: 'asc' }, { exam_id: 'asc' }, { part: 'asc' }] });
  const changes = [];
  for (const row of rows) {
    const json = structuredClone(row.json_data);
    const questions = (json.sections || []).flatMap((section, sectionIndex) =>
      (section.questions || []).map((question, questionIndex) => ({ sectionIndex, questionIndex, question })),
    );
    const partChanges = [];
    for (const entry of questions) {
      const options = entry.question.options;
      if (!options || typeof options !== 'object' || Array.isArray(options)) continue;
      const mapped = Object.entries(options).map(([key, value]) => [key, printedOption(value), value]);
      if (mapped.length !== 4 || mapped.some(([, printed]) => !printed)) continue;
      if (new Set(mapped.map(([, printed]) => printed)).size !== 4) continue;
      if (mapped.every(([key, printed]) => key === printed)) continue;
      const reordered = Object.fromEntries(mapped.map(([, printed, value]) => [printed, value]).sort(([a], [b]) => Number(a) - Number(b)));
      if (!Object.prototype.hasOwnProperty.call(reordered, String(entry.question.answer || ''))) {
        throw new Error(`Answer missing after option rekey: ${row.level}:${row.exam_id}:${row.part}:${entry.sectionIndex}:${entry.questionIndex}`);
      }
      entry.question.options = reordered;
      partChanges.push({ section_index: entry.sectionIndex, question_index: entry.questionIndex, map: Object.fromEntries(mapped.map(([key, printed]) => [key, printed])) });
    }
    if (partChanges.length) changes.push({ row, json, changes: partChanges });
  }
  if (apply) {
    await prisma.$transaction(async tx => {
      for (const change of changes) {
        await tx.jlptExamRevision.create({ data: { level: change.row.level, exam_id: change.row.exam_id, part: change.row.part, json_data: change.row.json_data, note: 'Before correcting option keys from printed option numbers for detailed AI import' } });
        await tx.jlptExam.update({ where: { id: change.row.id }, data: { json_data: change.json } });
      }
    });
  }
  console.log(JSON.stringify({ environment: targetEnv, mode: apply ? 'applied' : 'dry-run', exam_parts: changes.length, questions: changes.reduce((n, c) => n + c.changes.length, 0), changes: changes.flatMap(c => c.changes.map(x => ({ level: c.row.level, exam_id: c.row.exam_id, part: c.row.part, ...x }))) }, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
