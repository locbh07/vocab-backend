const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ path: '.env.local', override: true });
const { importDetailedQuestionExplanationLocal, importDetailedPassageExplanationLocal } = require('../dist/routes/exam');

const sourceDir = path.resolve(process.argv[2] || 'backups/ai-detailed-production-2026-10-13');
const resultDir = path.resolve(process.argv[3] || 'backups/ai-detailed-chuan-20261014/RESULTS');
const apply = process.argv.includes('--apply');
const limitArg = process.argv.find(v => v.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.slice(8)) : Infinity;
const batchArg = process.argv.find(v => v.startsWith('--batch='));
const onlyBatch = batchArg ? batchArg.slice(8).replace(/\.json$/, '') + '.json' : '';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

function passageToQuestion(raw, unit) {
  const question = raw?.questions?.[0];
  if (!question) return null;
  return {
    completed_sentence_ja: '',
    completed_sentence_translation_vi: '',
    evidence: question.evidence || [],
    question_ja: unit.questions[0].question_text,
    question_reading_hira: '',
    question_translation_vi: '',
    sentence_order_solution: null,
    key_point_vi: question.reasoning_vi || '',
    reasoning_steps_vi: [],
    option_analysis: question.option_analysis || [],
    options_with_reading: question.option_details || [],
    key_vocab: [],
    grammar_points: [],
    trap_patterns_vi: raw.global_traps_vi || [],
  };
}

async function main() {
  const files = fs.readdirSync(resultDir).filter(name => /^batch-\d+\.json$/.test(name) && (!onlyBatch || name === onlyBatch)).sort();
  const summary = { mode: apply ? 'apply' : 'dry-run', batches: files.length, attempted: 0, imported: 0, skipped_review: 0, skipped_schema: 0, failed: 0, failures: {} };
  for (const name of files) {
    const input = read(path.join(sourceDir, 'INPUT', name));
    const result = read(path.join(resultDir, name));
    for (const item of result.items || []) {
      if (summary.attempted >= limit) break;
      const unit = input.units.find(row => row.id === item.id);
      if (!unit || unit.source_sha256 !== item.source_sha256) {
        summary.failed += 1; summary.failures['source identity mismatch'] = (summary.failures['source identity mismatch'] || 0) + 1; continue;
      }
      if (item.status !== 'completed') { summary.skipped_review += 1; continue; }
      let raw = item.explanation;
      if (unit.kind === 'question' && raw?.questions) {
        raw = passageToQuestion(raw, unit);
        if (!raw?.question_translation_vi) { summary.skipped_schema += 1; continue; }
      }
      summary.attempted += 1;
      const location = { level: unit.location.level, examId: unit.location.exam_id, part: Number(unit.location.part), sectionIndex: Number(unit.location.section_index) };
      try {
        if (unit.kind === 'passage') {
          await importDetailedPassageExplanationLocal({ ...location, questionIndexes: unit.questions.map(q => Number(q.question_index)), rawExplanation: raw, save: apply });
        } else {
          await importDetailedQuestionExplanationLocal({ ...location, questionIndex: Number(unit.questions[0].question_index), rawExplanation: raw, save: apply });
        }
        summary.imported += 1;
      } catch (error) {
        summary.failed += 1;
        const message = String(error?.message || error).slice(0, 240);
        summary.failures[message] = (summary.failures[message] || 0) + 1;
      }
    }
    if (summary.attempted >= limit) break;
    if ((summary.imported + summary.failed) % 250 === 0) console.error(`progress imported=${summary.imported} failed=${summary.failed}`);
  }
  const report = path.join(path.dirname(resultDir), apply ? 'import-report.json' : 'dry-run-report.json');
  fs.writeFileSync(report, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ...summary, failures: Object.entries(summary.failures).sort((a,b) => b[1]-a[1]).slice(0,30), report }, null, 2));
  if (summary.failed) process.exitCode = 2;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
