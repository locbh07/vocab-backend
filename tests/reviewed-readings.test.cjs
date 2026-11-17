const test = require('node:test');
const assert = require('node:assert/strict');
const { applyReviewedReadings } = require('../dist/lib/reviewedReadings');
test('reviewed readings override tokenizer fields without changing source text', () => {
  const input = { question_ja: '君に任せる', question_ruby_html: 'old', question_reading_hira: 'old', key_vocab: [{ surface: '君', reading_hira: 'くん' }], _reading_review: { version: 1, fields: [
    { path: '/question_ja', source_text: '君に任せる', segments: [{ surface: '君', reading_hira: 'きみ' }, { surface: 'に', reading_hira: '' }, { surface: '任', reading_hira: 'まか' }, { surface: 'せる', reading_hira: '' }] },
    { path: '/key_vocab/0/surface', source_text: '君', segments: [{ surface: '君', reading_hira: 'きみ' }] },
  ] } };
  const result = applyReviewedReadings(input);
  assert.equal(result.question_reading_hira, 'きみにまかせる');
  assert.equal(result.question_ja, input.question_ja);
  assert.equal(result.key_vocab[0].reading_hira, 'きみ');
  assert.equal(input.key_vocab[0].reading_hira, 'くん');
});
test('changed source fields and malicious pointers never receive stale annotations', () => {
  const input = { question_ja: '田中君', question_ruby_html: 'current', _reading_review: { version: 1, fields: [
    { path: '/question_ja', source_text: '君', segments: [{ surface: '君', reading_hira: 'きみ' }] },
    { path: '/__proto__/polluted', source_text: '君', segments: [{ surface: '君', reading_hira: 'きみ' }] },
  ] } };
  assert.equal(applyReviewedReadings(input).question_ruby_html, 'current');
  assert.equal({}.polluted, undefined);
});
