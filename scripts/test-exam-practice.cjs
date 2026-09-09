// Run after npm run build. No database access or mutations.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildPracticeCatalog, practiceMondaiNumber } = require('../dist/lib/examPractice');
const section = (sec, count = 2) => ({ sec, questions: Array.from({ length: count }, () => ({})) });
const row = (level, exam_id, part, sections) => ({ level, exam_id, part, json_data: { sections } });

test('recognizes Japanese, fullwidth, hiragana and observed OCR headings', () => {
  for (const text of ['問題１２', 'もんだい１２', '問題: 12次の文章', '問题12', '間題 12', '<b>問題</b>12']) {
    assert.equal(practiceMondaiNumber(text), 12);
  }
  assert.equal(practiceMondaiNumber('There are 12 questions'), null);
});
test('N3 vocabulary and grammar do not collide when numbering restarts', () => {
  const groups = buildPracticeCatalog([row('N3', '202512', 1, [section('問題1')]), row('N3', '202512', 2, [section('問題1')])]);
  assert.deepEqual(groups.map(g => g.id), ['vocabulary-1', 'grammar-1']);
});
test('N2 grammar stays together across physical part changes; preserves source positions', () => {
  const groups = buildPracticeCatalog([
    row('N2', '202407', 2, [section('問題7', 10)]),
    row('N2', '202512', 1, [section('問題1', 5), section('問題7', 12)]),
  ]);
  const grammar = groups.find(g => g.id === 'grammar-7');
  assert.deepEqual(grammar.exams.map(e => [e.examId, e.questionCount]), [['202512', 12], ['202407', 10]]);
  assert.deepEqual(grammar.exams[0].segments, [{ part: 1, sectionIndexes: [1] }]);
});
test('listening includes all nonempty sections even without mondai headings', () => {
  const groups = buildPracticeCatalog([row('N2', '202512', 3, [section('問題1'), section('2番', 3), section('', 1), section('問題4', 0)])]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, 'listening');
  assert.equal(groups[0].exams[0].questionCount, 6);
  assert.deepEqual(groups[0].exams[0].segments[0].sectionIndexes, [0, 1, 2]);
});
test('empty/missing/unrecognized sections are not invented or assigned by index', () => {
  assert.deepEqual(buildPracticeCatalog([row('N5', '202407', 2, [section('もんだい１', 0), section('', 4)])]), []);
});

test('catalog API validates level/user and applies existing free/premium exam limits', async () => {
  const express = require('express');
  const { prisma } = require('../dist/lib/prisma');
  const { createExamRouter } = require('../dist/routes/exam');
  const originals = [prisma.userAccount.findUnique, prisma.$queryRaw, prisma.jlptExam.findMany];
  let premium = false;
  let query;
  prisma.userAccount.findUnique = async ({ where }) => where.id === 999n ? { role: premium ? 'PREMIUM' : 'USER', exam_enabled: false } : null;
  prisma.$queryRaw = async () => [{ exam_id: '202512' }];
  prisma.jlptExam.findMany = async args => { query = args; return [row('N2', '202512', 1, [section('問題1')])]; };
  const app = express(); app.use('/exam', createExamRouter());
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/exam/practice/`;
  try {
    assert.equal((await fetch(url + 'N6?userId=999')).status, 400);
    assert.equal((await fetch(url + 'N2')).status, 404);
    const response = await fetch(url + 'N2?userId=999');
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.groups[0].id, 'vocabulary-1');
    assert.equal(data.fullAccess, false);
    assert.deepEqual(query.where.exam_id, { in: ['202512'] });
    assert.equal(JSON.stringify(data).includes('questions'), false);
    premium = true;
    assert.equal((await (await fetch(url + 'N2?userId=999')).json()).fullAccess, true);
    assert.equal(query.where.exam_id, undefined);
  } finally {
    await new Promise(resolve => server.close(resolve));
    [prisma.userAccount.findUnique, prisma.$queryRaw, prisma.jlptExam.findMany] = originals;
    await prisma.$disconnect();
  }
});
