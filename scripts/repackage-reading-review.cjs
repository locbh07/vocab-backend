// Rebuild field coverage from the original content export; no database access.
const fs = require('node:fs');
const path = require('node:path');
const { fieldsIn, hash, read } = require('./export-reading-review.cjs');
const { validate } = require('./check-reading-review.cjs');
const [source, output, reviewedFile] = process.argv.slice(2);
if (!source || !output || fs.existsSync(output)) throw new Error('Use source-folder new-output-folder [reviewed-result.json]');
const reviewed = reviewedFile ? read(reviewedFile) : null;
if (reviewed) validate(read(path.join(source, 'INPUT', `${reviewed.batch_id}.json`)), reviewed);
const write = (name, data) => {
  const file = path.join(output, name); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
};
const manifest = read(path.join(source, 'MANIFEST.json'));
let total = 0, added = 0, carried = 0;
for (const batch of manifest.batches) {
  const input = read(path.join(source, 'INPUT', `${batch.batch_id}.json`));
  for (const unit of input.units) {
    const oldCount = unit.fields.length;
    unit.fields = fieldsIn(unit.explanation);
    added += unit.fields.length - oldCount;
    total += unit.fields.length;
    const { source_sha256, ...base } = unit;
    unit.source_sha256 = hash(base);
  }
  write(`INPUT/${batch.batch_id}.json`, input);
  const template = { format_version: input.format_version, batch_id: input.batch_id, items: input.units.map((unit) => ({
    id: unit.id, source_sha256: unit.source_sha256, status: 'pending', review_note_vi: '',
    fields: unit.fields.map((field) => ({ ...field, status: 'pending', segments: [], review_note_vi: '' })),
  })) };
  if (reviewed?.batch_id === batch.batch_id) {
    for (const item of template.items) {
      const previous = reviewed.items.find((old) => old.id === item.id);
      for (const [i, field] of item.fields.entries()) {
        const old = previous?.fields.find((candidate) => candidate.path === field.path && candidate.source_sha256 === field.source_sha256 && candidate.source_text === field.source_text);
        if (old) { item.fields[i] = old; carried++; }
      }
    }
  }
  write(`TEMPLATES/${batch.batch_id}.json`, template);
  batch.fields = input.units.reduce((n, unit) => n + unit.fields.length, 0);
}
manifest.fields = total;
manifest.coverage_revision = 2;
manifest.repackaged_at = new Date().toISOString();
manifest.repackage_note = 'Same database snapshot and batch IDs; leaf-only reading filter restores options and passage sentences. Use revised INPUT/TEMPLATES together.';
write('MANIFEST.json', manifest);
write('START_HERE.md', fs.readFileSync('docs/reading-review-handoff.md', 'utf8'));
write('RESULTS/.gitkeep', '');
write('REVISION.md', `Coverage revision 2\n\nUse this package instead of the previous AI.zip. Batch numbers are unchanged; source_sha256 values changed where fields were restored.\n\n${added} previously omitted fields added. ${carried} reviewed fields carried into the template for ${reviewed?.batch_id || 'none'}; leave them intact and complete pending fields. Item status remains pending until every field is reviewed.\n\nOriginal read-only database baseline remains at ${path.resolve(source, 'BASELINE')}. No database was contacted or modified.\n`);
console.log(JSON.stringify({ folder: path.resolve(output), fields: total, added, carried, batches: manifest.batches.length }, null, 2));
