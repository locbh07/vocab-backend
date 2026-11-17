const fs = require('node:fs');
const path = require('node:path');
const { hash } = require('./export-reading-review.cjs');

function validate(input, result) {
  const fail = (message) => { throw new Error(message); };
  if (result?.format_version !== 'reading-review-v1' || result.batch_id !== input.batch_id) fail('Wrong format or batch');
  if (!Array.isArray(result.items) || result.items.length !== input.units.length) fail('Item count mismatch');
  const counts = { completed: 0, needs_human_review: 0, fields: 0 };
  for (const [index, unit] of input.units.entries()) {
    const item = result.items[index];
    if (!item || item.id !== unit.id || item.source_sha256 !== unit.source_sha256) fail(`Identity mismatch: ${unit.id}`);
    if (!['completed', 'needs_human_review'].includes(item.status)) fail(`Unfinished item: ${unit.id}`);
    if (!Array.isArray(item.fields) || item.fields.length !== unit.fields.length) fail(`Field count mismatch: ${unit.id}`);
    let unresolved = false;
    for (const [i, original] of unit.fields.entries()) {
      const field = item.fields[i], label = `${unit.id}${original.path}`;
      if (!field || field.path !== original.path || field.source_text !== original.source_text || field.source_sha256 !== original.source_sha256 || hash(field.source_text) !== original.source_sha256) fail(`Changed source: ${label}`);
      if (field.status === 'needs_human_review') {
        if (!field.review_note_vi?.trim() || !Array.isArray(field.segments) || field.segments.length) fail(`Review field needs a note and empty segments: ${label}`);
        unresolved = true; continue;
      }
      if (field.status !== 'completed' || !Array.isArray(field.segments) || !field.segments.length) fail(`Unfinished field: ${label}`);
      for (const segment of field.segments) {
        if (!segment || typeof segment.surface !== 'string' || !segment.surface || typeof segment.reading_hira !== 'string') fail(`Invalid segment: ${label}`);
        const hasKanji = /[\u3400-\u4dbf\u4e00-\u9fff]/.test(segment.surface);
        if (hasKanji && (!/^[ぁ-ゖー]+$/.test(segment.reading_hira) || segment.surface.length > 24)) fail(`Kanji needs a short context-specific hiragana segment: ${label}`);
        if (!hasKanji && segment.reading_hira !== '') fail(`Non-kanji segment must not have ruby: ${label}`);
      }
      if (field.segments.map((s) => s.surface).join('') !== original.source_text) fail(`Segments change the source text: ${label}`);
      counts.fields++;
    }
    if (item.status === 'completed' && unresolved) fail(`Completed item has unresolved fields: ${unit.id}`);
    if (item.status === 'needs_human_review' && !item.review_note_vi?.trim()) fail(`Review item needs a note: ${unit.id}`);
    counts[item.status]++;
  }
  return counts;
}

if (require.main === module) {
  try {
    const [folder, file] = process.argv.slice(2);
    const result = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!/^batch-\d{4,}$/.test(result.batch_id)) throw new Error('Invalid batch ID');
    const input = JSON.parse(fs.readFileSync(path.join(folder, 'INPUT', `${result.batch_id}.json`), 'utf8'));
    console.log(JSON.stringify({ batch: result.batch_id, ...validate(input, result), database_writes: 0 }, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { validate };
