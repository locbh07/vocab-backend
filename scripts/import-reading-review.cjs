// Explicit environment, dry-run by default. Writes only reviewed metadata, with
// an exact-content concurrency guard and an append-only rollback journal.
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { PrismaClient } = require('@prisma/client');
const { validate } = require('./check-reading-review.cjs');
const { hash, read } = require('./export-reading-review.cjs');
const arg = name => process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3);
const stringify = v => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? String(x) : x);
const table = kind => kind === 'question' ? 'jlpt_question_explanation' : 'jlpt_passage_explanation';
function contextFor(exam, unit) {
  const section = exam?.sections?.[unit.identity.section_index];
  const selected = unit.kind === 'question' ? [section?.questions?.[unit.identity.question_index]].filter(Boolean) : section?.questions || [];
  const ids = new Set(selected.flatMap(q => [q.passage_id ?? q.pid].flat().filter(id => id != null).map(String)));
  return { section_title: section?.sec || '', questions: selected, passages: (exam?.passages || []).filter(p => ids.has(String(p.passage_id ?? p.pid))) };
}
async function main() {
  const env = arg('env'), input = arg('input'), results = arg('results'), out = arg('out');
  const apply = process.argv.includes('--apply');
  if (!['local', 'production'].includes(env) || !input || !results || !out) throw Error('Required: --env=local|production --input=export-folder --results=result-folder --out=new-backup-folder [--apply]');
  if (fs.existsSync(out)) throw Error('Output already exists; use a new backup folder');
  const loaded = require('dotenv').config({ path: `.env.${env}`, override: true });
  if (loaded.error || !process.env.DATABASE_URL) throw Error('Selected environment unavailable');
  const db = new PrismaClient();
  try {
    const snapshot = await db.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      return {
        exams: await tx.$queryRawUnsafe('SELECT level, exam_id, part, json_data FROM jlpt_exam'),
        question: await tx.$queryRawUnsafe('SELECT id, explanation_json FROM jlpt_question_explanation'),
        passage: await tx.$queryRawUnsafe('SELECT id, explanation_json FROM jlpt_passage_explanation'),
      };
    }, { isolationLevel: 'RepeatableRead', timeout: 120000 });
    const exams = new Map(snapshot.exams.map(r => [`${r.level}:${r.exam_id}:${r.part}`, r.json_data]));
    const rows = Object.fromEntries(['question', 'passage'].map(k => [k, new Map(snapshot[k].map(r => [String(r.id), r]))]));
    fs.mkdirSync(out, { recursive: true });
    const report = { environment: env, mode: apply ? 'apply' : 'dry-run', batches: 0, candidates: 0, updated: 0, needs_human_review: [], conflicts: [], already_applied: [], started_at: new Date().toISOString() };
    const plan = [];
    const files = fs.readdirSync(path.join(input, 'INPUT')).filter(f => /^batch-\d+\.json$/.test(f)).sort();
    for (const file of files) {
      const batch = read(path.join(input, 'INPUT', file));
      const result = read(path.join(results, file));
      validate(batch, result);
      report.batches++;
      for (let i = 0; i < batch.units.length; i++) {
        const unit = batch.units[i], item = result.items[i];
        if (item.status !== 'completed') { report.needs_human_review.push(unit.id); continue; }
        const row = rows[unit.kind].get(String(unit.identity.id));
        const exam = exams.get(`${unit.identity.level}:${unit.identity.exam_id}:${unit.identity.part}`);
        if (row?.explanation_json?._reading_review?.source_sha256 === unit.source_sha256) { report.already_applied.push(unit.id); continue; }
        if (!row || !isDeepStrictEqual(row.explanation_json, unit.explanation) || !isDeepStrictEqual(contextFor(exam, unit), unit.context)) {
          report.conflicts.push({ id: unit.id, reason: 'Content changed since export' }); continue;
        }
        const metadata = { version: 1, batch_id: batch.batch_id, source_sha256: unit.source_sha256, imported_at: report.started_at,
          fields: item.fields.map(f => ({ path: f.path, source_text: f.source_text, segments: f.segments })) };
        const entry = { id: String(row.id), kind: unit.kind, identity: unit.identity, before: row.explanation_json, metadata, exam };
        fs.appendFileSync(path.join(out, 'rollback.jsonl'), stringify(entry) + '\n');
        plan.push(entry); report.candidates++;
      }
    }
    // Entire validation and backup must finish before the first write.
    fs.writeFileSync(path.join(out, 'report.json'), stringify(report));
    if (apply) {
      for (let start = 0; start < plan.length; start += 25) {
        const outcomes = await db.$transaction(async tx => {
          const done = [];
          for (const entry of plan.slice(start, start + 25)) {
            const i = entry.identity;
            const changed = await tx.$executeRawUnsafe(
              `UPDATE ${table(entry.kind)} SET explanation_json = explanation_json || jsonb_build_object('_reading_review', $1::jsonb), updated_at = NOW()
               WHERE id = $2::bigint AND explanation_json = $3::jsonb
               AND EXISTS (SELECT 1 FROM jlpt_exam WHERE level = $4 AND exam_id = $5 AND part = $6 AND json_data = $7::jsonb)`,
              stringify(entry.metadata), entry.id, stringify(entry.before), i.level, i.exam_id, i.part, stringify(entry.exam));
            done.push({ id: `${entry.kind}:${entry.id}`, changed });
          }
          return done;
        }, { timeout: 120000 });
        for (const result of outcomes) {
          if (result.changed === 1) report.updated++;
          else report.conflicts.push({ id: result.id, reason: 'Concurrent content change' });
          fs.appendFileSync(path.join(out, 'applied.jsonl'), stringify(result) + '\n');
        }
        fs.writeFileSync(path.join(out, 'report.json'), stringify(report));
        if (start % 250 === 0) console.log(`Applied ${report.updated}/${plan.length}`);
      }
    }
    report.finished_at = new Date().toISOString();
    fs.writeFileSync(path.join(out, 'report.json'), stringify(report));
    console.log(stringify({ ...report, needs_human_review: report.needs_human_review.length, conflicts: report.conflicts.length, already_applied: report.already_applied.length }));
  } finally { await db.$disconnect(); }
}
main().catch(e => { console.error(e.message.replace(/postgres(?:ql)?:\/\/\S+/g, '[redacted]')); process.exitCode = 1; });
