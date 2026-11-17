const test = require('node:test');
const assert = require('node:assert/strict');
const { validate } = require('../scripts/check-reading-review.cjs');
const { fieldsIn } = require('../scripts/export-reading-review.cjs');
function example() {
  const fields = fieldsIn({ sentence_ja: '鋭い感覚。', sentence_ruby_html: '<ruby>鋭<rt>するど</rt></ruby>', reading_hira: 'するどいかんかく。' });
  const input = { batch_id: 'batch-0001', units: [{ id: 'question:1', source_sha256: 'baseline', fields }] };
  const result = { format_version: 'reading-review-v1', batch_id: input.batch_id, items: [{ id: 'question:1', source_sha256: 'baseline', status: 'completed', fields: fields.map((f) => ({ ...f, status: 'completed', segments: [{ surface: '鋭', reading_hira: 'するど' }, { surface: 'い', reading_hira: '' }, { surface: '感覚', reading_hira: 'かんかく' }, { surface: '。', reading_hira: '' }] })) }] };
  return { input, result };
}
test('review preserves field identity and accepts segmented contextual readings', () => {
  const { input, result } = example();
  assert.equal(input.units[0].fields.length, 1);
  assert.equal(validate(input, result).completed, 1);
});
test('reading-named containers do not hide source sentences and translations', () => {
  const fields = fieldsIn({ options_with_reading: [{ text_ja: '工場へ行った', reading_hira: 'こうじょうへいった', text_ruby_html: '<ruby>工場</ruby>' }], sentence_readings: [{ sentence_ja: '調査が行われた', reading_hira: 'ちょうさがおこなわれた', vocab: [{ surface: '調査', reading_hira: 'ちょうさ' }] }] });
  assert.deepEqual(fields.map((f) => f.path), ['/options_with_reading/0/text_ja', '/sentence_readings/0/sentence_ja', '/sentence_readings/0/vocab/0/surface']);
});
test('review rejects changed source, missing items and unannotated kanji', () => {
  for (const mutate of [r => r.items.pop(), r => r.items[0].fields[0].source_text += 'x', r => r.items[0].fields[0].segments[0].reading_hira = '', r => r.items[0].fields[0].segments[0].surface = '犬']) {
    const { input, result } = example(); mutate(result); assert.throws(() => validate(input, result));
  }
});
test('uncertain readings must be explicitly flagged instead of guessed', () => {
  const { input, result } = example();
  Object.assign(result.items[0].fields[0], { status: 'needs_human_review', segments: [], review_note_vi: 'Context required' });
  assert.throws(() => validate(input, result));
  Object.assign(result.items[0], { status: 'needs_human_review', review_note_vi: 'Context required' });
  assert.equal(validate(input, result).needs_human_review, 1);
});
