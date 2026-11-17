// Read-only content export. Never imports routes or cache builders (which may write).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const stringify = (value) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? String(v) : v, 2);
const hash = (value) => crypto.createHash('sha256').update(stringify(value)).digest('hex');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const kanji = /[\u3400-\u4dbf\u4e00-\u9fff]/;
const pointerKey = (key) => String(key).replace(/~/g, '~0').replace(/\//g, '~1');

function fieldsIn(value, pointer = '') {
  if (typeof value === 'string') {
    // Filter the leaf field only. Parent arrays such as options_with_reading and
    // sentence_readings contain source sentences that must also be reviewed.
    const leaf = pointer.slice(pointer.lastIndexOf('/') + 1);
    if (!kanji.test(value) || /(?:ruby_html|_hira)$|^reading$/i.test(leaf)) return [];
    // Explanations are plain text. HTML is kept in the context, never rewritten by AI.
    if (/<\/?[a-z][^>]*>/i.test(value)) return [];
    return [{ path: pointer, source_text: value, source_sha256: hash(value) }];
  }
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => fieldsIn(child, `${pointer}/${pointerKey(key)}`));
}

async function main() {
  const env = process.argv.find((v) => v.startsWith('--env='))?.slice(6);
  const output = process.argv.find((v) => v.startsWith('--out='))?.slice(6);
  if (!['local', 'production'].includes(env) || !output) throw new Error('Use --env=local|production --out=backups/reading-review-YYYY-MM-DD');
  const out = path.resolve(output);
  if (fs.existsSync(out)) throw new Error('Output already exists; choose a new folder');
  const loaded = require('dotenv').config({ path: `.env.${env}`, override: true });
  if (loaded.error || !process.env.DATABASE_URL) throw new Error('Selected database environment is unavailable');
  const db = new PrismaClient();
  let snapshot;
  try {
    snapshot = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      const exams = await tx.$queryRawUnsafe('SELECT level, exam_id, part, json_data FROM jlpt_exam ORDER BY level, exam_id, part');
      const questions = await tx.$queryRawUnsafe('SELECT DISTINCT ON (level, exam_id, part, section_index, question_index) id, level, exam_id, part, section_index, question_index, question_hash, prompt_version, explanation_json, updated_at FROM jlpt_question_explanation ORDER BY level, exam_id, part, section_index, question_index, prompt_version DESC, updated_at DESC, id DESC');
      const passages = await tx.$queryRawUnsafe('SELECT DISTINCT ON (level, exam_id, part, section_index, group_hash) id, level, exam_id, part, section_index, group_hash, prompt_version, explanation_json, updated_at FROM jlpt_passage_explanation ORDER BY level, exam_id, part, section_index, group_hash, prompt_version DESC, updated_at DESC, id DESC');
      const readings = await tx.$queryRawUnsafe('SELECT level, exam_id, part, section_index, question_index, reading_json FROM jlpt_exam_reading_cache ORDER BY level, exam_id, part, section_index, question_index');
      return { exams, questions, passages, readings };
    }, { isolationLevel: 'RepeatableRead', timeout: 120000, maxWait: 15000 });
  } finally { await db.$disconnect(); }
  const write = (name, value) => {
    const file = path.join(out, name); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : stringify(value), 'utf8');
  };
  const examKey = (r) => `${r.level}:${r.exam_id}:${r.part}`;
  const exams = new Map(snapshot.exams.map((r) => [examKey(r), r.json_data]));
  const units = [];
  for (const kind of ['question', 'passage']) {
    for (const row of snapshot[kind === 'question' ? 'questions' : 'passages']) {
      const exam = exams.get(examKey(row));
      const section = exam?.sections?.[row.section_index];
      const selected = kind === 'question' ? [section?.questions?.[row.question_index]].filter(Boolean) : section?.questions || [];
      const passageIds = new Set(selected.flatMap((q) => [q.passage_id ?? q.pid].flat().filter((id) => id != null).map(String)));
      const context = {
        section_title: section?.sec || '',
        questions: selected,
        passages: (exam?.passages || []).filter((p) => passageIds.has(String(p.passage_id ?? p.pid))),
      };
      const readingCache = snapshot.readings.filter((r) => examKey(r) === examKey(row) && r.section_index === row.section_index && (kind === 'passage' || r.question_index === row.question_index));
      const { explanation_json, ...identity } = row;
      const unit = {
        id: `${kind}:${row.id}`, kind, identity,
        context, context_sha256: hash(context),
        explanation: explanation_json,
        explanation_sha256: hash(explanation_json),
        precomputed_readings_untrusted: readingCache,
        fields: fieldsIn(explanation_json),
      };
      unit.source_sha256 = hash(unit);
      units.push(unit);
    }
  }
  const batches = [];
  let pending = [];
  function flush() {
    if (!pending.length) return;
    const batch_id = `batch-${String(batches.length + 1).padStart(4, '0')}`;
    write(`INPUT/${batch_id}.json`, { format_version: 'reading-review-v1', batch_id, units: pending });
    write(`TEMPLATES/${batch_id}.json`, { format_version: 'reading-review-v1', batch_id, items: pending.map((u) => ({
      id: u.id, source_sha256: u.source_sha256, status: 'pending', review_note_vi: '',
      fields: u.fields.map((f) => ({ ...f, status: 'pending', segments: [], review_note_vi: '' })),
    })) });
    batches.push({ batch_id, units: pending.length, fields: pending.reduce((n, u) => n + u.fields.length, 0), levels: [...new Set(pending.map((u) => u.identity.level))] });
    pending = [];
  }
  for (const unit of units) {
    if (pending.length && (pending.length >= 3 || stringify([...pending, unit]).length > 80000)) flush();
    pending.push(unit);
    if (unit.kind === 'passage') flush();
  }
  flush();
  // Local import baseline, not needed by the external AI. No user/account tables.
  write('BASELINE/content-snapshot.json', snapshot);
  write('START_HERE.md', fs.readFileSync('docs/reading-review-handoff.md', 'utf8'));
  write('RESULTS/.gitkeep', '');
  const manifest = { format_version: 'reading-review-v1', exported_at: new Date().toISOString(), environment: env, database_mode: 'READ ONLY / REPEATABLE READ', exam_parts: snapshot.exams.length, question_explanations: snapshot.questions.length, passage_explanations: snapshot.passages.length, reading_cache_rows: snapshot.readings.length, units: units.length, fields: units.reduce((n, u) => n + u.fields.length, 0), batches };
  write('MANIFEST.json', manifest);
  console.log(stringify({ folder: out, ...manifest, batches: batches.length }));
}
if (require.main === module) main().catch(() => { console.error('Export failed. No database writes were performed; check the selected environment and output path.'); process.exitCode = 1; });
module.exports = { fieldsIn, hash, read };
