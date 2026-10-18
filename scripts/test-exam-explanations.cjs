// Run after npm run build. All model calls are mocked; no database or external API access.
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('exam explanation cache routes can bypass the shared rate-limit store', async () => {
  const { createSimpleRateLimit } = require('../dist/middleware/simpleRateLimit');
  const middleware = createSimpleRateLimit({
    windowMs: 60_000,
    max: 1,
    keyPrefix: 'test-exam',
    skip: req => req.path === '/question-explanation' || req.path === '/passage-explanation',
  });
  for (const path of ['/question-explanation', '/passage-explanation']) {
    let nextCalls = 0;
    const response = {
      set: () => response,
      status: () => response,
      json: () => response,
    };
    await middleware({ path }, response, () => { nextCalls += 1; });
    assert.equal(nextCalls, 1);
  }
});

const { inferJlptQuestionMeta } = require('../dist/lib/jlptQuestionType');
const standards = require('../dist/lib/examExplanationStandards');
const explanations = require('../dist/lib/examExplanation');
const infer = (level, part, sectionTitle, questionText = '') => inferJlptQuestionMeta({
  level, part, sectionTitle, questionText, questionLabel: '1', optionTexts: ['あ', 'い', 'う', 'え'], hasPassage: false, isClozeQuestion: false,
}).questionType;
const options = { 1: '調べる', 2: '確認する', 3: '聞く', 4: '取材する' };
const seed = { questionReadingHira: 'よみ', questionRubyHtml: '', optionReadings: {}, optionRubyHtmls: {} };
const payload = { level: 'N2', examId: 'test', part: 1, sectionTitle: '問題6', questionLabel: '1', mondaiLabel: '問題6', questionType: 'vocab_usage', questionTypeLabelVi: 'Cách dùng', typeStrategyVi: '', questionText: '取材する', questionWithBlank: '取材する', questionWithAnswer: '', blankLabels: [], isClozeQuestion: false, options, correctAnswer: '4', passageText: '', precomputedReadings: seed };
const optionAnalysis = () => Object.keys(options).map(option => ({ option, verdict: option === '4' ? 'correct' : 'wrong', meaning_vi: `Nghĩa ${option}`, reason_vi: `Lý do riêng ${option}`, corrected_ja: option === '4' ? '' : '友人に聞く。', trap_vi: option === '4' ? '' : 'Sai đối tượng' }));
const rawQuestion = () => ({ question_ja: 'KHÔNG ĐƯỢC THAY ĐỀ', question_translation_vi: 'Phỏng vấn', key_point_vi: 'Ngữ cảnh phỏng vấn để thu thập tin.', option_analysis: optionAnalysis(), key_vocab: [] });

test('N3–N5 use physical part and explicit mondai, never short answer length', () => {
  for (const level of ['N3', 'N4', 'N5']) {
    assert.equal(infer(level, 1, 'もんだい１'), 'vocab_kanji_reading');
    assert.equal(infer(level, 1, '問題２'), 'vocab_kanji_writing');
    assert.equal(infer(level, 1, '間題: 3'), 'vocab_context');
    assert.equal(infer(level, 1, '問题4'), 'vocab_paraphrase');
    assert.equal(infer(level, 2, '問題1'), 'grammar_choice');
    assert.equal(infer(level, 2, '問題2'), 'sentence_order');
    assert.equal(infer(level, 2, '問題3'), 'reading_cloze');
    assert.equal(infer(level, 2, '問題4'), 'reading_content');
    assert.equal(infer(level, 1, ''), 'unknown');
  }
  assert.equal(infer('N4', 1, '問題5'), 'vocab_usage');
  assert.equal(infer('N2', 3, '問題1 ★'), 'listening');
});

test('N1/N2 mapping survives grammar moving to physical part 1', () => {
  assert.equal(infer('N2', 1, '問題7'), 'grammar_choice');
  assert.equal(infer('N2', 1, '問題8'), 'sentence_order');
  assert.equal(infer('N2', 1, '問題9'), 'reading_cloze');
  assert.equal(infer('N1', 1, '問題5'), 'grammar_choice');
  assert.equal(infer('N1', 1, '問題6'), 'sentence_order');
  assert.equal(infer('N1', 1, '問題7'), 'reading_cloze');
  assert.equal(infer('N2', 2, '問題14'), 'reading_content');
});

test('ruby is removed without duplicating pronunciation; HTML tables retain cells and rows', () => {
  assert.equal(standards.explanationSourceText('<ruby>発揮<rp>（</rp><rt>はっき</rt><rp>）</rp></ruby>する'), '発揮する');
  assert.equal(standards.explanationSourceText('<table><tr><td>大人</td><td>500円</td></tr><tr><td>子供</td><td>無料</td></tr></table>'), '大人 | 500円 | \n子供 | 無料 | \n');
  assert.throws(() => standards.assertExplanationSource(standards.explanationSourceText('案内<img src="table.png">')), { status: 422 });
  assert.throws(() => standards.assertExplanationSource('', true), { status: 422 });
});

test('passage editorial omission markers do not require a vocabulary list', () => {
  assert.equal(standards.isPassageFootnote('\uFF08\u4E2D\u7565\uFF09'), true);
  assert.equal(standards.isPassageFootnote('(\u524D\u7565)'), true);
  assert.equal(standards.isPassageFootnote('\uFF08\u5F8C\u7565\uFF09'), true);
});

test('passage correspondence metadata does not require a prose glossary', () => {
  assert.equal(standards.isPassageAuxiliaryLine('\u5317\u5ddd\u8fb2\u696d\u5927\u5b66 \u5fdc\u7528\u751f\u547d\u79d1\u5b66\u90e8'), true);
  assert.equal(standards.isPassageAuxiliaryLine('APD\u51fa\u7248 \u7de8\u96c6\u90e8'), true);
  assert.equal(standards.isPassageAuxiliaryLine('\u5ddd\u6ce2\u656c\u4e00'), true);
  assert.equal(standards.isPassageAuxiliaryLine('\u52df\u96c6\u90e8\u9580 | \u5fdc\u52df\u8cc7\u683c |'), true);
  assert.equal(standards.isPassageAuxiliaryLine('\u3088\u308d\u3057\u304f\u304a\u9858\u3044\u3057\u307e\u3059\u3002'), true);
  assert.equal(standards.isPassageAuxiliaryLine('\u4f55\u3088\u308a\u3001\u4e8b\u5f8c\u5bfe\u7b56\u3092\u6025\u304c\u306a\u3051\u308c\u3070\u306a\u3089\u306a\u3044\u304b\u3089\u3067\u3059\u3002'), false);
});

test('evidence must exist in source and sentence index is derived from quote', () => {
  const sentences = ['本日届きました。', '至急送ってください。'];
  const result = standards.normalizeEvidence([
    { quote_ja: '至急送ってください。', explanation_vi: 'Yêu cầu gửi gấp.', sentence_index: 99 },
    { quote_ja: '無料です。', explanation_vi: 'Không có trong bài.' },
  ], sentences.join('\n'), sentences);
  assert.deepEqual(result, [{ quote_ja: sentences[1], explanation_vi: 'Yêu cầu gửi gấp.', sentence_index: 2 }]);
});

test('dialogue evidence is verified turn by turn, not as one contiguous span', () => {
  const script = '男の学生と先生が話しています。 男：計画案を見ていただけましたか？ 女：見ましたよ。細かいスケジュールを組む必要がありそうだけど、交通手段は急いで押えないといけませんね。 男：そうですね。';
  const keep = quote => standards.normalizeEvidence([{ quote_ja: quote, explanation_vi: 'Căn cứ.' }], script).length;
  // Two real turns joined across an intervening sentence, and a speaker tag re-attached to a
  // sentence from the middle of that speaker's turn: both are honest quotes.
  assert.equal(keep('女：交通手段は急いで押えないといけませんね。 男：そうですね。'), 1);
  assert.equal(keep('女：交通手段は急いで押えないといけませんね。'), 1);
  // Still refuses invented lines and lines put in the wrong speaker's mouth.
  assert.equal(keep('女：宿泊先はもう予約しました。'), 0);
  assert.equal(keep('男：交通手段は急いで押えないといけませんね。'), 0);
});

test('specific option reasons and corrected forms survive normalization', () => {
  const raw = rawQuestion();
  raw.option_analysis[3].reason_vi = 'Hoạt động thu thập thông tin cho công việc làm báo.';
  const result = explanations.normalizeExplanation(raw, payload, seed);
  assert.equal(result.question_ja, payload.questionText);
  assert.equal(result.option_analysis[3].reason_vi, raw.option_analysis[3].reason_vi);
  assert.equal(result.option_analysis[0].corrected_ja, '友人に聞く。');
  assert.equal(result.option_analysis[0].trap_vi, 'Sai đối tượng');
});

test('passage normalizer keeps sentence glossary and maps evidence to display number', () => {
  const source = '本日届きました。';
  const question = { questionLabel: '6', displayLabel: '57', questionWithBlank: '何が届きましたか。', questionWithAnswer: '', correctAnswer: '4', options };
  const passagePayload = { ...payload, questionType: 'reading_content', passageText: source, questions: [question] };
  const readings = { passageRubyHtml: '', passageReadingHira: '', sentenceReadings: [{ sentence_ja: source, sentence_ruby_html: '', reading_hira: '' }], questionBlankReadings: {}, questionBlankRubyHtmls: {}, questionAnswerReadings: {}, questionAnswerRubyHtmls: {}, questionOptionReadings: {}, questionOptionRubyHtmls: {} };
  const result = explanations.normalizePassageExplanation({
    passage_ja: 'REWRITTEN SOURCE',
    sentence_readings: [{ index: 1, sentence_ja: source, translation_vi: 'Đã đến hôm nay.', vocab: [
      { surface: '届きました', dictionary_form: '届く', reading_hira: 'とどきました', meaning_vi: 'Đã đến' },
      { surface: '届きました', reading_hira: 'とどきました', meaning_vi: 'Trùng' },
      { surface: '学校', reading_hira: 'がっこう', meaning_vi: 'Không có trong câu' },
    ] }],
    questions: [{ question_label: '6', reasoning_vi: 'Căn cứ thời điểm trong câu.', option_analysis: optionAnalysis(), evidence: [{ quote_ja: source, explanation_vi: 'Đối chiếu câu gốc.' }] }],
  }, passagePayload, readings);
  assert.equal(result.passage_ja, source);
  assert.equal(result.questions[0].question_label, '6');
  assert.equal(result.questions[0].display_question_label, '57');
  // The prompt heads each block with the label, and the model echoes the heading back; a
  // cosmetic prefix must not throw the whole answer away.
  const echoed = explanations.normalizePassageExplanation({
    sentence_readings: [{ index: 1, sentence_ja: source, translation_vi: 'Đã đến hôm nay.', vocab: [{ surface: '届きました', reading_hira: 'とどきました', meaning_vi: 'Đã đến' }] }],
    questions: [{ question_label: 'Question 6', reasoning_vi: 'Căn cứ thời điểm trong câu.', option_analysis: optionAnalysis(), evidence: [{ quote_ja: source, explanation_vi: 'Đối chiếu câu gốc.' }] }],
  }, passagePayload, readings);
  assert.equal(echoed.questions[0].question_label, '6');
  assert.equal(echoed.questions[0].reasoning_vi, 'Căn cứ thời điểm trong câu.');
  assert.equal(echoed.questions[0].evidence.length, 1);
  explanations.validatePassageExplanation(echoed);
  assert.deepEqual(result.sentence_readings[0].evidence_for, ['57']);
  assert.equal(result.sentence_readings[0].vocab.length, 1);
  assert.equal(result.sentence_readings[0].vocab[0].dictionary_form, '届く');
  explanations.validatePassageExplanation(result);
  // A trailing "（注1）…" glossary line is not prose: it must not be required to carry a
  // vocab list, but a real sentence with kanji still must.
  const footnote = { sentence_ja: '（注1）見すごす：ここでは、そのままにする', sentence_ruby_html: '', reading_hira: '', translation_vi: '', vocab: [] };
  explanations.validatePassageExplanation({ ...result, sentence_readings: [...result.sentence_readings, footnote] });
  assert.throws(() => explanations.validatePassageExplanation({
    ...result, sentence_readings: [...result.sentence_readings, { ...footnote, sentence_ja: '本日届きました。' }],
  }), { status: 502 });
  result.questions[0].evidence = [];
  assert.throws(() => explanations.validatePassageExplanation(result), { status: 502 });
});

test('passage normalizer maps split heading and prose rows by text before sentence index', () => {
  const heading = '\u6f2b\u753b\u3067\u5b66\u3076\u672c';
  const prose = '\u8fd1\u5e74\u3001\u6f2b\u753b\u5f62\u5f0f\u306e\u672c\u304c\u591a\u304f\u51fa\u7248\u3055\u308c\u3066\u3044\u308b\u3002';
  const combined = heading + prose;
  const question = { questionLabel: '1', displayLabel: '1', questionWithBlank: '', questionWithAnswer: '', correctAnswer: '4', options };
  const passagePayload = { ...payload, questionType: 'reading_content', passageText: combined, questions: [question] };
  const readings = {
    passageRubyHtml: '', passageReadingHira: '',
    sentenceReadings: [{ sentence_ja: combined, sentence_ruby_html: '', reading_hira: '' }],
    questionBlankReadings: {}, questionBlankRubyHtmls: {}, questionAnswerReadings: {},
    questionAnswerRubyHtmls: {}, questionOptionReadings: {}, questionOptionRubyHtmls: {},
  };
  const result = explanations.normalizePassageExplanation({
    sentence_readings: [
      { index: 1, sentence_ja: heading, translation_vi: 'S\u00e1ch h\u1ecdc qua manga.', vocab: [{ surface: '\u6f2b\u753b', reading_hira: '\u307e\u3093\u304c', meaning_vi: 'manga' }] },
      { index: 2, sentence_ja: prose, translation_vi: 'Nh\u1eefng n\u0103m g\u1ea7n \u0111\u00e2y, nhi\u1ec1u s\u00e1ch manga \u0111\u01b0\u1ee3c xu\u1ea5t b\u1ea3n.', vocab: [{ surface: '\u8fd1\u5e74', reading_hira: '\u304d\u3093\u306d\u3093', meaning_vi: 'nh\u1eefng n\u0103m g\u1ea7n \u0111\u00e2y' }] },
    ],
    questions: [{ question_label: '1', reasoning_vi: 'C\u0103n c\u1ee9 theo c\u00e2u trong b\u00e0i.', option_analysis: optionAnalysis(), evidence: [{ quote_ja: prose, explanation_vi: 'B\u00e0i n\u00eau xu h\u01b0\u1edbng xu\u1ea5t b\u1ea3n.' }] }],
  }, passagePayload, readings);
  assert.equal(result.sentence_readings[0].translation_vi, 'S\u00e1ch h\u1ecdc qua manga. Nh\u1eefng n\u0103m g\u1ea7n \u0111\u00e2y, nhi\u1ec1u s\u00e1ch manga \u0111\u01b0\u1ee3c xu\u1ea5t b\u1ea3n.');
  assert.deepEqual(result.sentence_readings[0].vocab.map(item => item.surface), ['\u6f2b\u753b', '\u8fd1\u5e74']);
  explanations.validatePassageExplanation(result);
});

test('passage normalizer maps one reviewed row back to split source sentences', () => {
  const first = '\u5927\u304d\u306a\u30df\u30b9\u306e\u5834\u5408\u3001\u53f1\u308b\u306e\u306f\u3042\u3068\u307e\u308f\u3057\u306b\u306a\u308a\u307e\u3059\u3002';
  const second = '\u4f55\u3088\u308a\u3001\u4e8b\u5f8c\u5bfe\u7b56\u3092\u6025\u304c\u306a\u3051\u308c\u3070\u306a\u3089\u306a\u3044\u304b\u3089\u3067\u3059\u3002';
  const question = { questionLabel: '1', displayLabel: '1', questionWithBlank: '', questionWithAnswer: '', correctAnswer: '4', options };
  const passagePayload = { ...payload, questionType: 'reading_content', passageText: first + second, questions: [question] };
  const readings = {
    passageRubyHtml: '', passageReadingHira: '',
    sentenceReadings: [first, second].map(sentence_ja => ({ sentence_ja, sentence_ruby_html: '', reading_hira: '' })),
    questionBlankReadings: {}, questionBlankRubyHtmls: {}, questionAnswerReadings: {},
    questionAnswerRubyHtmls: {}, questionOptionReadings: {}, questionOptionRubyHtmls: {},
  };
  const result = explanations.normalizePassageExplanation({
    sentence_readings: [{
      index: 1, sentence_ja: first + second, translation_vi: 'V\u1edbi l\u1ed7i l\u1edbn, tr\u01b0\u1edbc h\u1ebft ph\u1ea3i x\u1eed l\u00fd h\u1eadu qu\u1ea3.',
      vocab: [{ surface: '\u4e8b\u5f8c\u5bfe\u7b56', reading_hira: '\u3058\u3054\u305f\u3044\u3055\u304f', meaning_vi: 'bi\u1ec7n ph\u00e1p kh\u1eafc ph\u1ee5c' }],
    }],
    questions: [{ question_label: '1', reasoning_vi: 'C\u0103n c\u1ee9 theo c\u00e2u trong b\u00e0i.', option_analysis: optionAnalysis(), evidence: [{ quote_ja: second, explanation_vi: 'C\u00e2u n\u00e0y n\u00eau vi\u1ec7c c\u1ea7n l\u00e0m tr\u01b0\u1edbc.' }] }],
  }, passagePayload, readings);
  assert.equal(result.sentence_readings[1].translation_vi, 'V\u1edbi l\u1ed7i l\u1edbn, tr\u01b0\u1edbc h\u1ebft ph\u1ea3i x\u1eed l\u00fd h\u1eadu qu\u1ea3.');
  assert.deepEqual(result.sentence_readings[1].vocab.map(item => item.surface), ['\u4e8b\u5f8c\u5bfe\u7b56']);
});

test('incomplete grammar explanation cannot be cached as complete', () => {
  const grammarPayload = { ...payload, questionType: 'grammar_choice' };
  const result = explanations.normalizeExplanation(rawQuestion(), grammarPayload, seed);
  assert.throws(() => explanations.validateQuestionExplanation(result, grammarPayload), { status: 502 });
});

test('star order checks actual slot, not only option count or answer badge', () => {
  assert.equal(standards.starSlotIndex('スーパーで ___ _★_ ___ ___ 買う。'), 1);
  const question = 'これは ___ ___ ★ ___ です。';
  assert.equal(standards.isValidStarOrder(['1', '2', '4', '3'], ['1', '2', '3', '4'], question, '4'), true);
  assert.equal(standards.isValidStarOrder(['1', '4', '2', '3'], ['1', '2', '3', '4'], question, '4'), false);
  assert.equal(standards.isValidStarOrder(['1', '2', '4', '4'], ['1', '2', '3', '4'], question, '4'), false);
  assert.equal(standards.isValidStarOrder(['1', '2', '4', '3'], ['1', '2', '3', '4'], '★', '4'), false);
});

test('generation rejects incomplete star after repair instead of appending missing options', async () => {
  const gemini = require('../dist/lib/gemini');
  const original = gemini.generateGeminiJson;
  let calls = 0;
  gemini.generateGeminiJson = async () => {
    calls++;
    return { rawText: JSON.stringify({ ...rawQuestion(), sentence_order_solution: { ordered_options: ['1'], ordered_sentence_ja: '', reason_vi: 'Chưa đủ' }, ordered_options: ['1'] }), model: 'test-mock' };
  };
  try {
    await assert.rejects(() => explanations.generateExamQuestionExplanation({ ...payload, questionType: 'sentence_order', questionText: 'これは ___ ___ ★ ___ です。', questionWithBlank: 'これは ___ ___ ★ ___ です。' }), { status: 502 });
    assert.equal(calls, 2);
    // Previously the repair fallback appended 2,3,4, which happens to match this ★ key.
    await assert.rejects(() => explanations.generateExamQuestionExplanation({ ...payload, correctAnswer: '3', questionType: 'sentence_order', questionText: 'これは ___ ___ ★ ___ です。', questionWithBlank: 'これは ___ ___ ★ ___ です。' }), { status: 502 });
    calls = 0;
    await assert.rejects(() => explanations.generateExamQuestionExplanation({ ...payload, passageText: standards.MISSING_IMAGE_TEXT }), { status: 422 });
    assert.equal(calls, 0);
  } finally { gemini.generateGeminiJson = original; }
});

test('API rejects missing image before quota and releases quota after failed generation', async () => {
  const express = require('express');
  const { prisma } = require('../dist/lib/prisma');
  const metadata = require('../dist/lib/examQuestionMeta');
  const readings = require('../dist/lib/examReadingCache');
  const { createExamRouter } = require('../dist/routes/exam');
  const originals = [prisma.userAccount.findUnique, prisma.$queryRaw, prisma.$queryRawUnsafe, prisma.$executeRawUnsafe, prisma.jlptExam.findFirst, metadata.getExamQuestionMeta, readings.getOrCreateQuestionReadingCache, explanations.generateExamQuestionExplanation, explanations.generatePassageExplanation];
  let image = false;
  let claims = 0;
  let releases = 0;
  prisma.userAccount.findUnique = async () => ({ role: 'USER', exam_enabled: false });
  prisma.$queryRaw = async () => [{ exam_id: 'test' }];
  prisma.$queryRawUnsafe = async () => [];
  prisma.$executeRawUnsafe = async (sql, ...args) => {
    if (sql.includes('INSERT INTO jlpt_') && sql.includes('_request_log')) { claims++; assert.equal(args.at(-1), 24); }
    if (sql.startsWith('DELETE FROM jlpt_') && sql.includes('_request_log')) { releases++; assert.equal(args.at(-1), 24); }
    return 1;
  };
  prisma.jlptExam.findFirst = async ({ where }) => ({ json_data: {
    sections: [{ sec: where.part === 2 ? '問題10' : '問題6', questions: [{ qid: '1', ques: image ? '<img src="table.png">' : '取材する', options, answer: '4', pid: 'p' }] }],
    passages: [{ pid: 'p', passage: '本日届きました。' }],
  } });
  metadata.getExamQuestionMeta = async () => ({ displayQuestionNo: 57, questionType: 'vocab_usage', mondaiLabel: '問題6' });
  readings.getOrCreateQuestionReadingCache = async () => ({ question_reading_hira: '', question_ruby_html: '', option_readings: {}, option_ruby_htmls: {}, passage_text: '本日届きました。', sentence_readings: [] });
  explanations.generateExamQuestionExplanation = explanations.generatePassageExplanation = async () => { throw Object.assign(new Error('Mock incomplete explanation'), { status: 502 }); };
  const app = express(); app.use(express.json()); app.use('/exam', createExamRouter());
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const send = (route, part) => fetch(`http://127.0.0.1:${server.address().port}/exam/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: 123, level: 'N2', examId: 'test', part, sectionIndex: 0, questionIndex: 0, questionIndexes: [0] }) });
  try {
    for (const [route, part] of [['question-explanation', 1], ['passage-explanation', 2]]) {
      assert.equal((await send(route, part)).status, 502);
    }
    assert.equal(claims, 2); assert.equal(releases, 2);
    image = true;
    for (const [route, part] of [['question-explanation', 1], ['passage-explanation', 2]]) assert.equal((await send(route, part)).status, 422);
    assert.equal(claims, 2, 'No quota charge for incomplete source');
  } finally {
    await new Promise(resolve => server.close(resolve));
    [prisma.userAccount.findUnique, prisma.$queryRaw, prisma.$queryRawUnsafe, prisma.$executeRawUnsafe, prisma.jlptExam.findFirst, metadata.getExamQuestionMeta, readings.getOrCreateQuestionReadingCache, explanations.generateExamQuestionExplanation, explanations.generatePassageExplanation] = originals;
    await prisma.$disconnect();
  }
});
