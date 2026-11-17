const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://unused@127.0.0.1:1/unused';
process.env.JWT_SECRET = 'synthetic-study-test-secret';
const { buildExamStudy } = require('../dist/lib/examStudy');
const exams = [{ level: 'N2', exam_id: '202407', part: 1, json_data: { sections: [{ questions: [
  { qid: '1', ques: '1番 資料を読んだ。資料です。', options: { 1: '資料', 2: '読んだ' }, passage_id: 'p1' },
  { qid: '2', ques: '資料を読む。', options: {}, passage_id: 'p1' },
] }], passages: [{ passage_id: 'p1', passage_html: '<ruby>自然<rt>しぜん</rt></ruby>を守る。' }] } }];
const questions = [0, 1].map((i) => ({ level: 'N2', exam_id: '202407', part: 1, section_index: 0, question_index: i, explanation_json: {
  question_ja: i ? '資料を読む。' : '資料を読んだ。',
  key_vocab: [{ surface: '資料', reading_hira: 'しりょう', meaning_vi: 'tài liệu' }, { surface: i ? '読む' : '読んだ', dictionary_form: '読む', reading_hira: i ? 'よむ' : 'よんだ', meaning_vi: 'đọc' }, { surface: '未掲載', reading_hira: 'みけいさい', meaning_vi: 'bổ sung' }],
  grammar_points: [{ point: '～を', note_vi: 'A' }, { point: '~を', note_vi: 'B' }],
  trap_patterns_vi: ['Chú ý phủ định', 'Một bẫy phủ định khác'],
} }));
const passages = [{ level: 'N2', exam_id: '202407', part: 1, section_index: 0, explanation_json: { passage_ja: '自然を守る。', sentence_readings: [{ sentence_ja: '自然を守る。', vocab: [{ surface: '自然', reading_hira: 'しぜん', meaning_vi: 'thiên nhiên' }] }] } }];

test('frequency counts independent questions/passages once, strips ruby and question numbering', () => {
  const c = buildExamStudy(exams, questions, [...passages, ...passages]);
  const get = (category, title) => c.items.find(i => i.category === category && i.title === title);
  assert.equal(get('vocabulary', '資料').sourceCount, 2);
  assert.equal(get('vocabulary', '自然').sourceCount, 1);
  assert.equal(get('vocabulary', '未掲載').sourceCount, 0);
  assert.equal(get('vocabulary', '未掲載').explanationCount, 2);
  assert.equal(get('grammar', '~を').sourceCount, 2);
  assert.equal(get('traps', 'Phủ định và ngoại lệ').sourceCount, 2);
  assert.equal(get('kanji', '番'), undefined);
  assert.equal(get('kanji', '自').sourceCount, 1);
  assert.equal(c.meta.sourceCount, 3);
  assert.equal(c.meta.examCount, 1);
});
test('dictionary forms group without replacing readings of inflected surfaces', () => {
  const c = buildExamStudy(exams, questions, passages);
  const item = c.items.find(i => i.category === 'vocabulary' && i.title === '読む');
  assert.equal(item.sourceCount, 2);
  assert.ok(item.examples.some(e => e.surface === '読んだ' && e.reading === 'よんだ'));
  assert.ok(item.examples.some(e => e.surface === '読む' && e.reading === 'よむ'));
  const other = buildExamStudy([...exams, { ...exams[0], level: 'N1' }], questions, passages);
  assert.equal(other.meta.examCount, 1);
});
test('study endpoint requires verified identity, validates paging and returns bounded results', async (t) => {
  require('express-async-errors');
  const express = require('express');
  const { prisma } = require('../dist/lib/prisma');
  const { signAuthToken } = require('../dist/lib/authToken');
  const { createExamStudyRouter } = require('../dist/routes/examStudy');
  prisma.userAccount.findUnique = async () => ({ id: 1n, username: 'test', fullname: 'Test', role: 'USER', plan: 'FREE' });
  prisma.jlptExam.findMany = async () => exams;
  prisma.$queryRaw = async (sql) => sql[0].includes('jlpt_question_explanation') ? questions : passages;
  const app = express(); app.use('/exam/study', createExamStudyRouter());
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ message: err.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/exam/study/n2`;
  assert.equal((await fetch(url)).status, 401);
  const headers = { Authorization: `Bearer ${signAuthToken({ userId: 1 })}` };
  assert.equal((await fetch(url + '?page=-1', { headers })).status, 400);
  assert.equal((await fetch(url + '?category=unknown', { headers })).status, 400);
  const result = await (await fetch(url + '?q=' + encodeURIComponent('資料'), { headers })).json();
  assert.equal(result.total, 1);
  assert.equal(result.items[0].title, '資料');
  assert.ok(result.items.length <= 30);
});
