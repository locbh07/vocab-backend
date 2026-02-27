import type { JlptQuestionType } from './jlptQuestionType';
import { toReadingHiragana, toRubyHtml } from './japaneseReading';

type OptionAnalysis = {
  option: string;
  meaning_vi: string;
  verdict: 'correct' | 'wrong';
  reason_vi: string;
};

type GrammarPoint = {
  point: string;
  note_vi: string;
};

type OptionWithReading = {
  option: string;
  text_ja: string;
  text_ruby_html: string;
  reading_hira: string;
  meaning_vi: string;
};

type PassageOptionWithReading = {
  option: string;
  text_ja: string;
  text_ruby_html: string;
  reading_hira: string;
  meaning_vi: string;
};

type KeyVocab = {
  surface: string;
  reading_hira: string;
  meaning_vi: string;
  why_important: string;
};

type PassageQuestionPayload = {
  questionLabel: string;
  questionWithBlank: string;
  questionWithAnswer: string;
  options: Record<string, string>;
  correctAnswer: string;
};

type PassageSentenceReading = {
  sentence_ja: string;
  sentence_ruby_html: string;
  reading_hira: string;
  translation_vi: string;
};

type SentenceOrderSolution = {
  ordered_options: string[];
  ordered_sentence_ja: string;
  ordered_sentence_ruby_html: string;
  ordered_sentence_reading_hira: string;
  star_option: string;
  reason_vi: string;
};

export type PassageExplanationPayload = {
  level: string;
  examId: string;
  part: number;
  sectionTitle: string;
  mondaiLabel: string;
  questionType: JlptQuestionType;
  questionTypeLabelVi: string;
  typeStrategyVi: string;
  passageText: string;
  blankLabels: string[];
  questions: PassageQuestionPayload[];
  precomputedReadings?: PassagePrecomputedSeed;
};

export type PassageQuestionExplanation = {
  question_label: string;
  sentence_with_blank: string;
  sentence_with_blank_ruby_html: string;
  sentence_with_blank_reading_hira: string;
  sentence_with_answer: string;
  sentence_with_answer_ruby_html: string;
  sentence_with_answer_reading_hira: string;
  correct_option: string;
  option_details: PassageOptionWithReading[];
  option_analysis: OptionAnalysis[];
  reasoning_vi: string;
};

export type PassageExplanation = {
  passage_ja: string;
  passage_ruby_html: string;
  passage_reading_hira: string;
  passage_translation_vi: string;
  sentence_readings: PassageSentenceReading[];
  passage_theme_vi: string;
  passage_summary_vi: string;
  key_logic_vi: string[];
  questions: PassageQuestionExplanation[];
  global_traps_vi: string[];
  reading_strategy_vi: string;
  final_takeaway_vi: string;
};

export type ExamQuestionExplanation = {
  question_ja: string;
  question_ruby_html: string;
  question_reading_hira: string;
  question_translation_vi: string;
  sentence_order_solution: SentenceOrderSolution | null;
  key_point_vi: string;
  reasoning_steps_vi: string[];
  option_analysis: OptionAnalysis[];
  options_with_reading: OptionWithReading[];
  key_vocab: KeyVocab[];
  grammar_points: GrammarPoint[];
  trap_patterns_vi: string[];
  part_strategy_vi: string;
  quick_tip_vi: string;
  final_conclusion_vi: string;
};

export type ExamQuestionPayload = {
  level: string;
  examId: string;
  part: number;
  sectionTitle: string;
  questionLabel: string;
  mondaiLabel: string;
  questionType: JlptQuestionType;
  questionTypeLabelVi: string;
  typeStrategyVi: string;
  questionText: string;
  questionWithBlank: string;
  questionWithAnswer: string;
  blankLabels: string[];
  isClozeQuestion: boolean;
  options: Record<string, string>;
  correctAnswer: string;
  passageText: string;
  sentenceOrderExpectedOrder?: string[];
  precomputedReadings?: {
    questionReadingHira: string;
    questionRubyHtml: string;
    optionReadings: Record<string, string>;
    optionRubyHtmls: Record<string, string>;
  };
};

type OpenAIChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

type PrecomputedReadings = {
  questionReadingHira: string;
  questionRubyHtml: string;
  optionReadings: Record<string, string>;
  optionRubyHtmls: Record<string, string>;
};

type PassagePrecomputedReadings = {
  passageRubyHtml: string;
  passageReadingHira: string;
  sentenceReadings: Array<{ sentence_ja: string; sentence_ruby_html: string; reading_hira: string }>;
  questionBlankReadings: Record<string, string>;
  questionBlankRubyHtmls: Record<string, string>;
  questionAnswerReadings: Record<string, string>;
  questionAnswerRubyHtmls: Record<string, string>;
  questionOptionReadings: Record<string, Record<string, string>>;
  questionOptionRubyHtmls: Record<string, Record<string, string>>;
};

export type ReadingSeedQuestionData = {
  questionReadingHira: string;
  questionRubyHtml: string;
  optionReadings: Record<string, string>;
  optionRubyHtmls: Record<string, string>;
  passageText: string;
  passageRubyHtml: string;
  passageReadingHira: string;
  sentenceReadings: Array<{ sentence_ja: string; sentence_ruby_html: string; reading_hira: string }>;
};

export type PassagePrecomputedSeed = Partial<PassagePrecomputedReadings>;

export async function generateExamQuestionExplanation(
  payload: ExamQuestionPayload,
): Promise<{ explanation: ExamQuestionExplanation; model: string }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const err = new Error('OPENAI_API_KEY is not configured') as Error & { status?: number };
    err.status = 500;
    throw err;
  }

  const model = process.env.OPENAI_EXAM_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const precomputedReadings =
    payload.precomputedReadings && payload.precomputedReadings.questionReadingHira
      ? {
          questionReadingHira: payload.precomputedReadings.questionReadingHira,
          questionRubyHtml: payload.precomputedReadings.questionRubyHtml || '',
          optionReadings: payload.precomputedReadings.optionReadings || {},
          optionRubyHtmls: payload.precomputedReadings.optionRubyHtmls || {},
        }
      : await buildPrecomputedReadings(payload);
  const prompt = buildPrompt(payload, precomputedReadings);
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            'Ban la giao vien JLPT cap cao.',
            'Tra loi bang tieng Viet ro rang, lap luan chat che.',
            'Không biet thi noi không biet, không du doan qua muc tu dữ liệu.',
          ].join(' '),
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    const detail = await safeReadBody(response);
    const err = new Error(`OpenAI request failed (${response.status}): ${detail}`) as Error & { status?: number };
    err.status = 502;
    throw err;
  }

  const data = (await response.json()) as OpenAIChatCompletionResponse;
  const rawContent = String(data?.choices?.[0]?.message?.content || '').trim();
  if (!rawContent) {
    const err = new Error('OpenAI returned empty explanation') as Error & { status?: number };
    err.status = 502;
    throw err;
  }

  const parsed = parseLooseJson(rawContent);
  const normalized = normalizeExplanation(parsed, payload, precomputedReadings);
  const completed = await completeSentenceOrderSolution({
    apiKey,
    model,
    payload,
    explanation: normalized,
    precomputedReadings,
  });
  return {
    explanation: completed,
    model,
  };
}

export async function generatePassageExplanation(
  payload: PassageExplanationPayload,
): Promise<{ explanation: PassageExplanation; model: string }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const err = new Error('OPENAI_API_KEY is not configured') as Error & { status?: number };
    err.status = 500;
    throw err;
  }

  const model = process.env.OPENAI_EXAM_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const precomputed = await buildPassagePrecomputedReadings(payload, payload.precomputedReadings);
  const prompt = buildPassagePrompt(payload, precomputed);
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            'Ban la giao vien JLPT doc hieu cap cao.',
            'Phan tich theo dòng mạch toàn đoạn, không tach roi tung cau.',
            'Tra loi bang tieng Viet, lap luan chat che va ngan gon.',
          ].join(' '),
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    const detail = await safeReadBody(response);
    const err = new Error(`OpenAI request failed (${response.status}): ${detail}`) as Error & { status?: number };
    err.status = 502;
    throw err;
  }

  const data = (await response.json()) as OpenAIChatCompletionResponse;
  const rawContent = String(data?.choices?.[0]?.message?.content || '').trim();
  if (!rawContent) {
    const err = new Error('OpenAI returned empty passage explanation') as Error & { status?: number };
    err.status = 502;
    throw err;
  }

  const parsed = parseLooseJson(rawContent);
  const normalized = normalizePassageExplanation(parsed, payload, precomputed);
  const completed = await fillMissingPassageOptionContent({
    apiKey,
    model,
    payload,
    explanation: normalized,
  });
  return {
    explanation: completed,
    model,
  };
}

function buildPrompt(payload: ExamQuestionPayload, precomputedReadings: PrecomputedReadings) {
  const isSentenceOrder = payload.questionType === 'sentence_order';
  const isReadingContent = payload.questionType === 'reading_content';
  const optionsText = Object.entries(payload.options)
    .map(([key, text]) => `${key}. ${text}`)
    .join('\n');
  const optionsReadingText = Object.entries(precomputedReadings.optionReadings)
    .map(([key, reading]) => `${key}. ${reading}`)
    .join('\n');

  return [
    'Hay phan tich 1 câu hỏi JLPT va tra JSON dung schema.',
    `Level: ${payload.level}`,
    `Exam ID: ${payload.examId}`,
    `Part: ${payload.part}`,
    `Muc câu hỏi: ${payload.sectionTitle || '(không co)'}`,
    `Nhan câu hỏi: ${payload.questionLabel || '(không co)'}`,
    `Nhan nhom Mondai: ${payload.mondaiLabel || '(không co)'}`,
    `Loai câu hỏi: ${payload.questionTypeLabelVi} (${payload.questionType})`,
    `Chiến lược giai uu tien: ${payload.typeStrategyVi || '(không co)'}`,
    `Câu hỏi goc: ${payload.questionText || '(không co)'}`,
    `Dang câu hỏi điền chỗ trống: ${payload.isClozeQuestion ? 'co' : 'không'}`,
    `Câu chứa o trong: ${payload.questionWithBlank || '(không co)'}`,
    `Câu sau khi điền đáp án dung: ${payload.questionWithAnswer || '(không co)'}`,
    `Cac o trong trong doan: ${(payload.blankLabels || []).join(', ') || '(không co)'}`,
    `Cach doc câu hỏi (tokenizer): ${precomputedReadings.questionReadingHira || '(không co)'}`,
    `Ngữ cảnh doan van/nghe: ${payload.passageText || '(không co)'}`,
    isReadingContent
      ? 'Luu y quan trong: question_ja phai la câu hỏi trac nghiem (vi du: 52. ...), KHONG được lay cau trong doan van lam question_ja.'
      : 'Luu y quan trong: question_ja phai dung voi câu hỏi ma de bai yeu cau.',
    `Cac đáp án:\n${optionsText || '(không co)'}`,
    `Cach doc đáp án (tokenizer):\n${optionsReadingText || '(không co)'}`,
    `Đáp án dung: ${payload.correctAnswer || '(không ro)'}`,
    payload.questionType === 'sentence_order' && (payload.sentenceOrderExpectedOrder || []).length
      ? `Thu tu chuan tham khao tu de: ${(payload.sentenceOrderExpectedOrder || []).join('-')}`
      : '',
    '',
    'Bat buoc thuc hien:',
    '1) Cho cau tieng Nhat goc va cach doc hiragana cua cau.',
    '2) Doi voi moi đáp án, cho text tieng Nhat + cach doc + nghia Viet.',
    '3) Liet ke tu kho (kanji) trong cau va giai thich vi sao quan trong.',
    '4) Phan tich dung/sai tung đáp án, neu nguoi hoc de bi nham thi noi ro bay.',
    `5) Viet chiến lược lam bai theo loai câu hỏi nay: ${payload.typeStrategyVi || partSpecificInstruction(payload.part)}`,
    '6) Kiem tra tinh nhat quan: đáp án danh dau correct phai trung đáp án dung de bai.',
    '7) Uu tien dung cach doc tokenizer da cho; neu không phu hop moi tu dieu chinh rat ngan gon.',
    '8) Neu la cau điền chỗ trống, phai dua tren câu chứa o trong va mach van ban, không được dich ro ro tung lựa chọn mot cach may moc.',
    isSentenceOrder
      ? '9) Day la dang sap xep cau co dau ★: ordered_options BAT BUOC phai gom DAY DU tat ca lựa chọn (1-2-3-4) moi lựa chọn dung 1 lan, cho cau hoan chinh sau sap xep, va chi ro manh dung o vi tri ★.'
      : '9) Neu không phai dang sap xep, de null cho sentence_order_solution.',
    '',
    'Trả về JSON dung cac key sau, không them key khac:',
    '{',
    '  "question_ja": "string",',
    '  "question_reading_hira": "string",',
    '  "question_translation_vi": "string",',
    '  "sentence_order_solution": {',
    '    "ordered_options": ["1|2|3|4 day du tat ca lựa chọn"],',
    '    "ordered_sentence_ja": "string",',
    '    "ordered_sentence_reading_hira": "string",',
    '    "star_option": "1|2|3|4",',
    '    "reason_vi": "string"',
    '  } | null,',
    '  "key_point_vi": "string",',
    '  "reasoning_steps_vi": ["string"],',
    '  "option_analysis": [',
    '    { "option": "1|2|3|4", "meaning_vi": "string", "verdict": "correct|wrong", "reason_vi": "string" }',
    '  ],',
    '  "options_with_reading": [',
    '    { "option": "1|2|3|4", "text_ja": "string", "reading_hira": "string", "meaning_vi": "string" }',
    '  ],',
    '  "key_vocab": [',
    '    { "surface": "string", "reading_hira": "string", "meaning_vi": "string", "why_important": "string" }',
    '  ],',
    '  "grammar_points": [',
    '    { "point": "string", "note_vi": "string" }',
    '  ],',
    '  "trap_patterns_vi": ["string"],',
    '  "part_strategy_vi": "string",',
    '  "quick_tip_vi": "string",',
    '  "final_conclusion_vi": "string"',
    '}',
  ].join('\n');
}

function buildPassagePrompt(payload: PassageExplanationPayload, precomputed: PassagePrecomputedReadings) {
  const isReadingCloze = payload.questionType === 'reading_cloze';

  const sentenceListText =
    precomputed.sentenceReadings
      .map((item, index) => `${index + 1}. ${item.sentence_ja}`)
      .join('\n') || '(không co)';

  const questionsText = payload.questions
    .map((q) => {
      const optionsText = Object.entries(q.options)
        .map(([key, text]) => {
          const reading = precomputed.questionOptionReadings[q.questionLabel]?.[key] || '';
          return `${key}. ${text}${reading ? ` (doc: ${reading})` : ''}`;
        })
        .join('\n');
      if (isReadingCloze) {
        return [
          `Question ${q.questionLabel}:`,
          `- Câu chứa o trong: ${q.questionWithBlank || '(không co)'}`,
          `- Cach doc câu chứa o trong: ${precomputed.questionBlankReadings[q.questionLabel] || '(không co)'}`,
          `- Câu sau khi điền đáp án dung: ${q.questionWithAnswer || '(không co)'}`,
          `- Cach doc câu sau khi điền dung: ${precomputed.questionAnswerReadings[q.questionLabel] || '(không co)'}`,
          `- Đáp án dung: ${q.correctAnswer || '(không ro)'}`,
          `- Lựa chọn:\n${optionsText || '(không co)'}`,
        ].join('\n');
      }
      return [
        `Question ${q.questionLabel}:`,
        `- Câu hỏi: ${q.questionWithBlank || '(không co)'}`,
        `- Cach doc câu hỏi: ${precomputed.questionBlankReadings[q.questionLabel] || '(không co)'}`,
        `- Đáp án dung: ${q.correctAnswer || '(không ro)'}`,
        `- Lựa chọn:\n${optionsText || '(không co)'}`,
      ].join('\n');
    })
    .join('\n\n');

  return [
    isReadingCloze
      ? 'Hay phan tich 1 cum bai doc hieu co nhieu o trong.'
      : 'Hay phan tich bai doc hieu va tra loi câu hỏi theo noi dung doan van.',
    `Level: ${payload.level}`,
    `Exam ID: ${payload.examId}`,
    `Part: ${payload.part}`,
    `Section: ${payload.sectionTitle || '(không co)'}`,
    `Nhan nhom Mondai: ${payload.mondaiLabel || '(không co)'}`,
    `Loai câu hỏi: ${payload.questionTypeLabelVi} (${payload.questionType})`,
    `Chiến lược xu ly uu tien: ${payload.typeStrategyVi || '(không co)'}`,
    isReadingCloze
      ? `Cac o trong: ${(payload.blankLabels || []).join(', ') || '(không co)'}`
      : 'Dang bai: Doc hieu câu hỏi noi dung (không phai dien o trong).',
    `Doan van:\n${payload.passageText || '(không co)'}`,
    `Cach doc toàn đoạn (tokenizer):\n${precomputed.passageReadingHira || '(không co)'}`,
    `Danh sach cau can dich (giu nguyen thu tu):\n${sentenceListText}`,
    '',
    'Thong tin tung cau trong cum:',
    questionsText || '(không co)',
    '',
    'Yeu cau:',
    isReadingCloze
      ? '1) Phan tich tong quan doan van truoc, sau do moi di vao tung o trong.'
      : '1) Phan tich tong quan doan van truoc, sau do moi di vao tung câu hỏi.',
    isReadingCloze
      ? '2) Voi moi o trong, giai thich vi sao đáp án dung hop dòng mạch, va vi sao cac đáp án sai bi lech ngữ cảnh.'
      : '2) Voi moi câu hỏi, giai thich vi sao đáp án dung theo bang chung trong doan, va vi sao cac đáp án sai.',
    '3) Nhan manh lien ket giua cac cau (quan he truoc-sau, giat doan, doi y, ket luan).',
    isReadingCloze
      ? '4) Neu co bay de nham giua cac o trong, phai chi ro.'
      : '4) Neu co bay doc hieu (tu de gay nham, suy luan vuot qua van ban), phai chi ro.',
    '5) Muc sentence_readings bat buoc theo danh sach cau da cho: dung index de map dung cau, không được dao thu tu.',
    '6) Trong moi question.option_analysis, bat buoc dien du 4 lựa chọn va không de trong meaning_vi/reason_vi.',
    '',
    'Trả về JSON dung schema sau, không them key khac:',
    '{',
    '  "passage_ja": "string",',
    '  "passage_translation_vi": "string",',
    '  "sentence_readings": [',
    '    { "index": 1, "sentence_ja": "string", "translation_vi": "string" }',
    '  ],',
    '  "passage_theme_vi": "string",',
    '  "passage_summary_vi": "string",',
    '  "key_logic_vi": ["string"],',
    '  "questions": [',
    '    {',
    '      "question_label": "string",',
    '      "sentence_with_blank": "string",',
    '      "sentence_with_answer": "string",',
    '      "correct_option": "1|2|3|4",',
    '      "option_analysis": [',
    '        { "option": "1|2|3|4", "meaning_vi": "string", "verdict": "correct|wrong", "reason_vi": "string" }',
    '      ],',
    '      "reasoning_vi": "string"',
    '    }',
    '  ],',
    '  "global_traps_vi": ["string"],',
    '  "reading_strategy_vi": "string",',
    '  "final_takeaway_vi": "string"',
    '}',
  ].join('\n');
}

function partSpecificInstruction(part: number): string {
  if (part === 1) {
    return 'Tap trung vao am doc kanji, nghia theo ngữ cảnh, va bay dong am/dong tu.';
  }
  if (part === 2) {
    return 'Tap trung vao lien ket cau, logic truoc-sau, dau hieu ngu phap de loai tru.';
  }
  return 'Tap trung vao tu khoa nghe, tu phu dinh, su doi y o cuoi cau, va by ngữ cảnh.';
}

function parseLooseJson(raw: string): unknown {
  const trimmed = raw.trim();
  const withoutFence = trimmed
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '');

  try {
    return JSON.parse(withoutFence);
  } catch {
    const firstBrace = withoutFence.indexOf('{');
    const lastBrace = withoutFence.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const candidate = withoutFence.slice(firstBrace, lastBrace + 1);
      return JSON.parse(candidate);
    }
    throw new Error('Invalid JSON from OpenAI');
  }
}

function normalizeExplanation(
  raw: unknown,
  payload: ExamQuestionPayload,
  precomputedReadings: PrecomputedReadings,
): ExamQuestionExplanation {
  const value = isObject(raw) ? raw : {};
  const optionItems = Array.isArray(value.option_analysis) ? value.option_analysis : [];
  const byOption = new Map<string, OptionAnalysis>();

  for (const item of optionItems) {
    if (!isObject(item)) continue;
    const option = normalizeOptionKey(item.option);
    if (!option) continue;
    const verdict = item.verdict === 'correct' ? 'correct' : 'wrong';
    byOption.set(option, {
      option,
      meaning_vi: text(item.meaning_vi) || '',
      verdict,
      reason_vi: text(item.reason_vi) || '',
    });
  }

  for (const [option] of Object.entries(payload.options)) {
    if (!byOption.has(option)) {
      byOption.set(option, {
        option,
        meaning_vi: '',
        verdict: option === payload.correctAnswer ? 'correct' : 'wrong',
        reason_vi: '',
      });
    }
  }

  const optionAnalysis = Array.from(byOption.values()).sort((a, b) => sortOptionKey(a.option, b.option));

  if (payload.correctAnswer) {
    for (const item of optionAnalysis) {
      item.verdict = item.option === payload.correctAnswer ? 'correct' : 'wrong';
    }
  }

  const questionJaFallback = payload.questionWithBlank || payload.questionText || '';
  const forceOriginalQuestionText = payload.questionType === 'reading_content' || payload.questionType === 'reading_cloze';

  return {
    question_ja: forceOriginalQuestionText ? questionJaFallback : text(value.question_ja) || questionJaFallback,
    question_ruby_html: precomputedReadings.questionRubyHtml || '',
    question_reading_hira: precomputedReadings.questionReadingHira || text(value.question_reading_hira) || '',
    question_translation_vi: text(value.question_translation_vi) || '',
    sentence_order_solution: asSentenceOrderSolution(value.sentence_order_solution, payload),
    key_point_vi: text(value.key_point_vi) || '',
    reasoning_steps_vi: asStringArray(value.reasoning_steps_vi),
    option_analysis: optionAnalysis,
    options_with_reading: asOptionWithReading(
      value.options_with_reading,
      payload.options,
      precomputedReadings.optionReadings,
      precomputedReadings.optionRubyHtmls,
    ),
    key_vocab: asKeyVocab(value.key_vocab),
    grammar_points: asGrammarPoints(value.grammar_points),
    trap_patterns_vi: asStringArray(value.trap_patterns_vi),
    part_strategy_vi: text(value.part_strategy_vi) || payload.typeStrategyVi || '',
    quick_tip_vi: text(value.quick_tip_vi) || '',
    final_conclusion_vi: text(value.final_conclusion_vi) || '',
  };
}

function asSentenceOrderSolution(value: unknown, payload: ExamQuestionPayload): SentenceOrderSolution | null {
  const isSentenceOrder = payload.questionType === 'sentence_order';
  if (!isSentenceOrder) return null;

  const row = isObject(value) ? value : {};
  const optionsSet = new Set(Object.keys(payload.options || {}));
  const orderedRaw = Array.isArray((row as Record<string, unknown>).ordered_options)
    ? ((row as Record<string, unknown>).ordered_options as unknown[])
    : [];
  const ordered_options = orderedRaw
    .map((item) => normalizeOptionKey(item))
    .filter((item) => item.length > 0 && optionsSet.has(item));

  return {
    ordered_options,
    ordered_sentence_ja: text((row as Record<string, unknown>).ordered_sentence_ja) || '',
    ordered_sentence_ruby_html: text((row as Record<string, unknown>).ordered_sentence_ruby_html) || '',
    ordered_sentence_reading_hira: text((row as Record<string, unknown>).ordered_sentence_reading_hira) || '',
    star_option: payload.correctAnswer || normalizeOptionKey((row as Record<string, unknown>).star_option) || '',
    reason_vi: text((row as Record<string, unknown>).reason_vi) || '',
  };
}

async function completeSentenceOrderSolution(args: {
  apiKey: string;
  model: string;
  payload: ExamQuestionPayload;
  explanation: ExamQuestionExplanation;
  precomputedReadings: PrecomputedReadings;
}): Promise<ExamQuestionExplanation> {
  if (args.payload.questionType !== 'sentence_order') return args.explanation;
  if (!args.explanation.sentence_order_solution) return args.explanation;

  const optionKeys = Object.keys(args.payload.options || {}).sort((a, b) => sortOptionKey(a, b));
  let solution = { ...args.explanation.sentence_order_solution };
  const expectedOrder = uniqueOptions(args.payload.sentenceOrderExpectedOrder || [], optionKeys);
  if (hasCompleteOrder(expectedOrder, optionKeys)) {
    solution.ordered_options = expectedOrder;
  }

  const inferredOrder = inferOptionOrderFromSentence(solution.ordered_sentence_ja, args.payload.options);
  const mergedOrder = uniqueOptions([...solution.ordered_options, ...inferredOrder], optionKeys);
  if (mergedOrder.length) {
    solution.ordered_options = mergedOrder;
  }

  if (!hasCompleteOrder(solution.ordered_options, optionKeys)) {
    const repaired = await repairSentenceOrderSolutionWithModel({
      apiKey: args.apiKey,
      model: args.model,
      payload: args.payload,
      current: solution,
    });
    if (repaired) {
      solution = repaired;
    }
  }

  if (!hasCompleteOrder(solution.ordered_options, optionKeys)) {
    solution.ordered_options = uniqueOptions([...solution.ordered_options, ...optionKeys], optionKeys);
  }

  solution.star_option = args.payload.correctAnswer || solution.star_option || '';

  if (
    !isSentenceContainsAllOptionTexts(solution.ordered_sentence_ja, solution.ordered_options, args.payload.options) ||
    !isSentenceOptionOrderConsistent(solution.ordered_sentence_ja, solution.ordered_options, args.payload.options)
  ) {
    solution.ordered_sentence_ja = buildSentenceOrderCompletionSentence(args.payload, solution.ordered_options);
  }

  if (!solution.ordered_sentence_reading_hira && solution.ordered_sentence_ja) {
    solution.ordered_sentence_reading_hira = await toReadingHiragana(solution.ordered_sentence_ja);
  }

  if (!solution.ordered_sentence_ruby_html && solution.ordered_sentence_ja) {
    solution.ordered_sentence_ruby_html = await toRubyHtml(solution.ordered_sentence_ja);
  }

  if (!solution.reason_vi && hasCompleteOrder(expectedOrder, optionKeys)) {
    solution.reason_vi = `Thu tu được chuan hoa theo đáp án chuan cua de: ${expectedOrder.join('→')}.`;
  }

  return {
    ...args.explanation,
    sentence_order_solution: solution,
  };
}

async function repairSentenceOrderSolutionWithModel(args: {
  apiKey: string;
  model: string;
  payload: ExamQuestionPayload;
  current: SentenceOrderSolution;
}): Promise<SentenceOrderSolution | null> {
  const optionKeys = Object.keys(args.payload.options || {}).sort((a, b) => sortOptionKey(a, b));
  if (!optionKeys.length) return null;

  const optionsText = optionKeys.map((key) => `${key}. ${args.payload.options[key] || ''}`).join('\n');
  const prompt = [
    'Ban dang sua ket qua dang sap xep cau JLPT co dau ★.',
    'NHIEM VU: trả về DUY NHAT JSON va KHONG text khac.',
    `Câu hỏi: ${args.payload.questionText || args.payload.questionWithBlank || ''}`,
    `Cau co o trong: ${args.payload.questionWithBlank || ''}`,
    `Cau da dien đáp án dung: ${args.payload.questionWithAnswer || ''}`,
    `Đáp án dung (vi tri ★): ${args.payload.correctAnswer || ''}`,
    `Cac lựa chọn:\n${optionsText}`,
    `Ket qua hien tai ordered_options: ${(args.current.ordered_options || []).join(', ') || '(rong)'}`,
    `Ket qua hien tai ordered_sentence_ja: ${args.current.ordered_sentence_ja || '(rong)'}`,
    '',
    'RANG BUOC BAT BUOC:',
    `- ordered_options phai chua DAY DU ${optionKeys.join(', ')} va moi lựa chọn dung 1 lan.`,
    '- star_option phai bang đáp án dung de bai.',
    '- ordered_sentence_ja phai la cau da sap xep day du tat ca manh.',
    '',
    'Schema:',
    '{',
    '  "ordered_options": ["1","2","3","4"],',
    '  "ordered_sentence_ja": "string",',
    '  "reason_vi": "string"',
    '}',
  ].join('\n');

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${args.apiKey}`,
      },
      body: JSON.stringify({
        model: args.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'Ban la giao vien JLPT. Tra JSON hop le, dung schema, không noi them.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
      }),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as OpenAIChatCompletionResponse;
    const raw = String(data?.choices?.[0]?.message?.content || '').trim();
    if (!raw) return null;
    const parsed = parseLooseJson(raw);
    const row = isObject(parsed) ? parsed : {};
    const orderedRaw = Array.isArray((row as Record<string, unknown>).ordered_options)
      ? ((row as Record<string, unknown>).ordered_options as unknown[])
      : [];
    const ordered_options = uniqueOptions(
      orderedRaw.map((item) => normalizeOptionKey(item)),
      optionKeys,
    );
    const ordered_sentence_ja = text((row as Record<string, unknown>).ordered_sentence_ja) || '';
    const reason_vi = text((row as Record<string, unknown>).reason_vi) || args.current.reason_vi || '';

    const completedOrder = hasCompleteOrder(ordered_options, optionKeys)
      ? ordered_options
      : uniqueOptions([...ordered_options, ...optionKeys], optionKeys);

    return {
      ...args.current,
      ordered_options: completedOrder,
      ordered_sentence_ja: ordered_sentence_ja || args.current.ordered_sentence_ja,
      reason_vi,
    };
  } catch {
    return null;
  }
}

function inferOptionOrderFromSentence(sentence: string, options: Record<string, string>): string[] {
  const target = String(sentence || '');
  if (!target) return [];
  return Object.entries(options || {})
    .map(([option, optionText]) => ({
      option: normalizeOptionKey(option),
      index: optionText ? target.indexOf(optionText) : -1,
      length: String(optionText || '').length,
    }))
    .filter((item) => item.option && item.index >= 0)
    .sort((a, b) => a.index - b.index || b.length - a.length)
    .map((item) => item.option);
}

function uniqueOptions(values: string[], allowKeys: string[]): string[] {
  const allow = new Set(allowKeys);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const option = normalizeOptionKey(value);
    if (!option || !allow.has(option) || seen.has(option)) continue;
    seen.add(option);
    out.push(option);
  }
  return out;
}

function hasCompleteOrder(orderedOptions: string[], optionKeys: string[]): boolean {
  if (orderedOptions.length !== optionKeys.length) return false;
  const sortedOrdered = [...orderedOptions].sort((a, b) => sortOptionKey(a, b));
  const sortedKeys = [...optionKeys].sort((a, b) => sortOptionKey(a, b));
  return sortedOrdered.every((value, idx) => value === sortedKeys[idx]);
}

function isSentenceContainsAllOptionTexts(
  sentence: string,
  orderedOptions: string[],
  options: Record<string, string>,
): boolean {
  const target = String(sentence || '');
  if (!target || !orderedOptions.length) return false;
  return orderedOptions.every((option) => {
    const textValue = String(options[option] || '');
    return textValue.length > 0 && target.includes(textValue);
  });
}

function isSentenceOptionOrderConsistent(
  sentence: string,
  orderedOptions: string[],
  options: Record<string, string>,
): boolean {
  const target = String(sentence || '');
  if (!target || orderedOptions.length === 0) return false;

  let cursor = -1;
  for (const option of orderedOptions) {
    const textValue = String(options[option] || '');
    if (!textValue) return false;
    const index = target.indexOf(textValue, cursor + 1);
    if (index < 0) return false;
    if (index < cursor) return false;
    cursor = index;
  }
  return true;
}

function buildSentenceOrderCompletionSentence(payload: ExamQuestionPayload, orderedOptions: string[]): string {
  const orderedText = orderedOptions.map((option) => String(payload.options[option] || '')).join('');
  const base = payload.questionWithBlank || payload.questionText || '';
  if (!base) return orderedText;

  const starClusterPattern = /(?:[＿_ー－\-〜～]+\s*)*★(?:\s*[＿_ー－\-〜～]+)*/u;
  const replaced = base
    .replace(starClusterPattern, orderedText)
    .replace(/★/gu, orderedText);

  if (replaced !== base) return normalizeWhitespaceLine(replaced);
  return normalizeWhitespaceLine(`${base} ${orderedText}`);
}

function normalizeWhitespaceLine(input: string): string {
  return String(input || '').replace(/\s+/g, ' ').trim();
}

function normalizePassageExplanation(
  raw: unknown,
  payload: PassageExplanationPayload,
  precomputed: PassagePrecomputedReadings,
): PassageExplanation {
  const value = isObject(raw) ? raw : {};
  const rawQuestions = Array.isArray(value.questions) ? value.questions : [];
  const byLabel = new Map<string, PassageQuestionExplanation>();

  for (const item of rawQuestions) {
    if (!isObject(item)) continue;
    const label = text(item.question_label);
    if (!label) continue;
    const payloadQuestion = payload.questions.find((q) => q.questionLabel === label);
    const optionAnalysis = normalizeOptionAnalysis(item.option_analysis, payloadQuestion);
    byLabel.set(label, {
      question_label: label,
      sentence_with_blank: text(item.sentence_with_blank) || '',
      sentence_with_blank_ruby_html: precomputed.questionBlankRubyHtmls[label] || '',
      sentence_with_blank_reading_hira: precomputed.questionBlankReadings[label] || '',
      sentence_with_answer: text(item.sentence_with_answer) || '',
      sentence_with_answer_ruby_html: precomputed.questionAnswerRubyHtmls[label] || '',
      sentence_with_answer_reading_hira: precomputed.questionAnswerReadings[label] || '',
      correct_option: text(item.correct_option) || '',
      option_details: buildPassageOptionDetails(payloadQuestion, optionAnalysis, precomputed, label),
      option_analysis: optionAnalysis,
      reasoning_vi: text(item.reasoning_vi) || '',
    });
  }

  const questions: PassageQuestionExplanation[] = payload.questions.map((q) => {
    const existing = byLabel.get(q.questionLabel);
    if (!existing) {
      const fallbackAnalysis = normalizeOptionAnalysis([], q);
      return {
        question_label: q.questionLabel,
        sentence_with_blank: q.questionWithBlank || '',
        sentence_with_blank_ruby_html: precomputed.questionBlankRubyHtmls[q.questionLabel] || '',
        sentence_with_blank_reading_hira: precomputed.questionBlankReadings[q.questionLabel] || '',
        sentence_with_answer: q.questionWithAnswer || '',
        sentence_with_answer_ruby_html: precomputed.questionAnswerRubyHtmls[q.questionLabel] || '',
        sentence_with_answer_reading_hira: precomputed.questionAnswerReadings[q.questionLabel] || '',
        correct_option: q.correctAnswer || '',
        option_details: buildPassageOptionDetails(q, fallbackAnalysis, precomputed, q.questionLabel),
        option_analysis: fallbackAnalysis,
        reasoning_vi: '',
      };
    }
    const forced = normalizeOptionAnalysis(existing.option_analysis, q);
    return {
      ...existing,
      sentence_with_blank: existing.sentence_with_blank || q.questionWithBlank || '',
      sentence_with_blank_ruby_html:
        existing.sentence_with_blank_ruby_html || precomputed.questionBlankRubyHtmls[q.questionLabel] || '',
      sentence_with_blank_reading_hira:
        existing.sentence_with_blank_reading_hira || precomputed.questionBlankReadings[q.questionLabel] || '',
      sentence_with_answer: existing.sentence_with_answer || q.questionWithAnswer || '',
      sentence_with_answer_ruby_html:
        existing.sentence_with_answer_ruby_html || precomputed.questionAnswerRubyHtmls[q.questionLabel] || '',
      sentence_with_answer_reading_hira:
        existing.sentence_with_answer_reading_hira || precomputed.questionAnswerReadings[q.questionLabel] || '',
      correct_option: q.correctAnswer || existing.correct_option || '',
      option_details: buildPassageOptionDetails(q, forced, precomputed, q.questionLabel),
      option_analysis: forced,
    };
  });

  const llmSentences = Array.isArray(value.sentence_readings) ? value.sentence_readings : [];
  const sentenceTranslations = new Map<string, string>();
  const sentenceTranslationsByIndex = new Map<number, string>();
  for (const item of llmSentences) {
    if (!isObject(item)) continue;
    const sentence = normalizeSentenceKey(text(item.sentence_ja) || '');
    const translation = text(item.translation_vi) || '';
    const index = parsePositiveInt(item.index);
    if (index !== null && translation) {
      sentenceTranslationsByIndex.set(index - 1, translation);
    }
    if (!sentence) continue;
    if (translation) sentenceTranslations.set(sentence, translation);
  }

  const sentence_readings: PassageSentenceReading[] = precomputed.sentenceReadings.map((item, index) => {
    const byKey = sentenceTranslations.get(normalizeSentenceKey(item.sentence_ja)) || '';
    const byIndex = sentenceTranslationsByIndex.get(index) || '';
    return {
      sentence_ja: item.sentence_ja,
      sentence_ruby_html: item.sentence_ruby_html,
      reading_hira: item.reading_hira,
      translation_vi: byKey || byIndex,
    };
  });

  return {
    passage_ja: text(value.passage_ja) || payload.passageText || '',
    passage_ruby_html: precomputed.passageRubyHtml || '',
    passage_reading_hira: precomputed.passageReadingHira || '',
    passage_translation_vi: text(value.passage_translation_vi) || '',
    sentence_readings,
    passage_theme_vi: text(value.passage_theme_vi) || '',
    passage_summary_vi: text(value.passage_summary_vi) || '',
    key_logic_vi: asStringArray(value.key_logic_vi),
    questions,
    global_traps_vi: asStringArray(value.global_traps_vi),
    reading_strategy_vi: text(value.reading_strategy_vi) || '',
    final_takeaway_vi: text(value.final_takeaway_vi) || '',
  };
}

function normalizeOptionAnalysis(value: unknown, question?: PassageQuestionPayload): OptionAnalysis[] {
  const rows = Array.isArray(value) ? value : [];
  const byOption = new Map<string, OptionAnalysis>();
  for (const item of rows) {
    if (!isObject(item)) continue;
    const option = normalizeOptionKey(item.option);
    if (!option) continue;
    byOption.set(option, {
      option,
      meaning_vi: text(item.meaning_vi) || '',
      verdict: item.verdict === 'correct' ? 'correct' : 'wrong',
      reason_vi: text(item.reason_vi) || '',
    });
  }
  const options = question ? Object.keys(question.options || {}) : Array.from(byOption.keys());
  for (const opt of options) {
    if (!byOption.has(opt)) {
      byOption.set(opt, {
        option: opt,
        meaning_vi: '',
        verdict: question?.correctAnswer === opt ? 'correct' : 'wrong',
        reason_vi: '',
      });
    }
  }

  const out = Array.from(byOption.values()).sort((a, b) => sortOptionKey(a.option, b.option));
  if (question?.correctAnswer) {
    out.forEach((item) => {
      item.verdict = item.option === question.correctAnswer ? 'correct' : 'wrong';
    });
  }
  return out;
}

function buildPassageOptionDetails(
  question: PassageQuestionPayload | undefined,
  optionAnalysis: OptionAnalysis[],
  precomputed: PassagePrecomputedReadings,
  questionLabel: string,
): PassageOptionWithReading[] {
  const options = question?.options || {};
  const meanings = new Map(optionAnalysis.map((item) => [normalizeOptionKey(item.option), item.meaning_vi || '']));
  return Object.entries(options)
    .map(([option, text_ja]) => ({
      option,
      text_ja,
      text_ruby_html: precomputed.questionOptionRubyHtmls[questionLabel]?.[option] || '',
      reading_hira: precomputed.questionOptionReadings[questionLabel]?.[option] || '',
      meaning_vi: meanings.get(normalizeOptionKey(option)) || '',
    }))
    .sort((a, b) => sortOptionKey(a.option, b.option));
}

function asOptionWithReading(
  value: unknown,
  options: Record<string, string>,
  optionReadings: Record<string, string>,
  optionRubyHtmls: Record<string, string>,
): OptionWithReading[] {
  const list = Array.isArray(value) ? value : [];
  const byOption = new Map<string, OptionWithReading>();

  for (const item of list) {
    if (!isObject(item)) continue;
    const option = normalizeOptionKey(item.option);
    if (!option) continue;
    byOption.set(option, {
      option,
      text_ja: text(item.text_ja) || options[option] || '',
      text_ruby_html: optionRubyHtmls[option] || text(item.text_ruby_html) || '',
      reading_hira: optionReadings[option] || text(item.reading_hira) || '',
      meaning_vi: text(item.meaning_vi) || '',
    });
  }

  for (const [option, optionText] of Object.entries(options)) {
    if (!byOption.has(option)) {
      byOption.set(option, {
        option,
        text_ja: optionText,
        text_ruby_html: optionRubyHtmls[option] || '',
        reading_hira: optionReadings[option] || '',
        meaning_vi: '',
      });
    }
  }

  return Array.from(byOption.values()).sort((a, b) => sortOptionKey(a.option, b.option));
}

async function buildPassagePrecomputedReadings(
  payload: PassageExplanationPayload,
  seed?: PassagePrecomputedSeed,
): Promise<PassagePrecomputedReadings> {
  try {
    const passageText = payload.passageText || '';
    const passageRubyHtml = seed?.passageRubyHtml || (await toRubyHtml(passageText));
    const passageReadingHira = seed?.passageReadingHira || (await toReadingHiragana(passageText));
    const sentenceReadings =
      seed?.sentenceReadings && seed.sentenceReadings.length > 0
        ? seed.sentenceReadings.map((item) => ({
            sentence_ja: item.sentence_ja || '',
            sentence_ruby_html: item.sentence_ruby_html || '',
            reading_hira: item.reading_hira || '',
          }))
        : await Promise.all(
            splitJapaneseSentences(passageText).map(async (sentence) => ({
              sentence_ja: sentence,
              sentence_ruby_html: await toRubyHtml(sentence),
              reading_hira: await toReadingHiragana(sentence),
            })),
          );

    const questionBlankReadingsEntries = await Promise.all(
      payload.questions.map(async (question) => [
        question.questionLabel,
        seed?.questionBlankReadings?.[question.questionLabel] || (await toReadingHiragana(question.questionWithBlank || '')),
      ]),
    );
    const questionBlankRubyHtmlEntries = await Promise.all(
      payload.questions.map(async (question) => [
        question.questionLabel,
        seed?.questionBlankRubyHtmls?.[question.questionLabel] || (await toRubyHtml(question.questionWithBlank || '')),
      ]),
    );
    const questionAnswerReadingsEntries = await Promise.all(
      payload.questions.map(async (question) => [
        question.questionLabel,
        seed?.questionAnswerReadings?.[question.questionLabel] || (await toReadingHiragana(question.questionWithAnswer || '')),
      ]),
    );
    const questionAnswerRubyHtmlEntries = await Promise.all(
      payload.questions.map(async (question) => [
        question.questionLabel,
        seed?.questionAnswerRubyHtmls?.[question.questionLabel] || (await toRubyHtml(question.questionWithAnswer || '')),
      ]),
    );
    const questionOptionReadingsEntries = await Promise.all(
      payload.questions.map(async (question) => {
        const seedOptionMap = seed?.questionOptionReadings?.[question.questionLabel];
        const optionEntries = await Promise.all(
          Object.entries(question.options || {}).map(async ([option, text]) => [
            option,
            seedOptionMap?.[option] || (await toReadingHiragana(text || '')),
          ] as const),
        );
        return [question.questionLabel, Object.fromEntries(optionEntries)] as const;
      }),
    );
    const questionOptionRubyHtmlEntries = await Promise.all(
      payload.questions.map(async (question) => {
        const seedOptionMap = seed?.questionOptionRubyHtmls?.[question.questionLabel];
        const optionEntries = await Promise.all(
          Object.entries(question.options || {}).map(async ([option, text]) => [
            option,
            seedOptionMap?.[option] || (await toRubyHtml(text || '')),
          ] as const),
        );
        return [question.questionLabel, Object.fromEntries(optionEntries)] as const;
      }),
    );

    return {
      passageRubyHtml,
      passageReadingHira,
      sentenceReadings,
      questionBlankReadings: Object.fromEntries(questionBlankReadingsEntries),
      questionBlankRubyHtmls: Object.fromEntries(questionBlankRubyHtmlEntries),
      questionAnswerReadings: Object.fromEntries(questionAnswerReadingsEntries),
      questionAnswerRubyHtmls: Object.fromEntries(questionAnswerRubyHtmlEntries),
      questionOptionReadings: Object.fromEntries(questionOptionReadingsEntries),
      questionOptionRubyHtmls: Object.fromEntries(questionOptionRubyHtmlEntries),
    };
  } catch {
    return {
      passageRubyHtml: '',
      passageReadingHira: '',
      sentenceReadings: [],
      questionBlankReadings: {},
      questionBlankRubyHtmls: {},
      questionAnswerReadings: {},
      questionAnswerRubyHtmls: {},
      questionOptionReadings: {},
      questionOptionRubyHtmls: {},
    };
  }
}

function splitJapaneseSentences(text: string): string[] {
  const normalized = String(text || '')
    .replace(/\r/g, '')
    .replace(/\n+/g, '\n')
    .trim();
  if (!normalized) return [];

  const chunks = normalized.split('\n');
  const out: string[] = [];
  for (const chunk of chunks) {
    const parts = chunk
      .split(/(?<=[。｡！？!?])/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .filter((item) => !isPassageSectionMarker(item));
    if (parts.length === 0 && chunk.trim()) {
      const plain = chunk.trim();
      if (!isPassageSectionMarker(plain)) out.push(plain);
    } else {
      out.push(...parts);
    }
  }
  return out;
}

function isPassageSectionMarker(value: string): boolean {
  const raw = String(value || '').trim();
  if (!raw) return true;
  const normalized = raw
    .replace(/[Ａ-Ｚ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[（）]/g, (ch) => (ch === '（' ? '(' : ')'))
    .replace(/^[\s　]+|[\s　]+$/g, '');
  if (/^[A-Z]$/.test(normalized)) return true;
  if (/^\([A-Z0-9]+\)$/.test(normalized)) return true;
  if (/^\d+$/.test(normalized)) return true;
  if (/^\(\d+\)$/.test(normalized)) return true;
  if (/^[①-⑳]+$/.test(normalized)) return true;
  return false;
}

async function buildPrecomputedReadings(payload: ExamQuestionPayload): Promise<PrecomputedReadings> {
  try {
    const questionReadingSource = payload.questionWithBlank || payload.questionText || '';
    const questionReadingHira = await toReadingHiragana(questionReadingSource);
    const questionRubyHtml = await toRubyHtml(questionReadingSource);
    const optionReadingsEntries = await Promise.all(
      Object.entries(payload.options).map(async ([option, optionText]) => {
        const reading = await toReadingHiragana(optionText || '');
        return [option, reading] as const;
      }),
    );
    const optionRubyHtmlEntries = await Promise.all(
      Object.entries(payload.options).map(async ([option, optionText]) => {
        const ruby = await toRubyHtml(optionText || '');
        return [option, ruby] as const;
      }),
    );
    return {
      questionReadingHira,
      questionRubyHtml,
      optionReadings: Object.fromEntries(optionReadingsEntries),
      optionRubyHtmls: Object.fromEntries(optionRubyHtmlEntries),
    };
  } catch {
    return {
      questionReadingHira: '',
      questionRubyHtml: '',
      optionReadings: {},
      optionRubyHtmls: {},
    };
  }
}

function asKeyVocab(value: unknown): KeyVocab[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!isObject(item)) return null;
      const surface = text(item.surface) || '';
      const reading_hira = text(item.reading_hira) || '';
      const meaning_vi = text(item.meaning_vi) || '';
      const why_important = text(item.why_important) || '';
      if (!surface && !reading_hira && !meaning_vi && !why_important) return null;
      return { surface, reading_hira, meaning_vi, why_important };
    })
    .filter((item): item is KeyVocab => Boolean(item));
}

function asGrammarPoints(value: unknown): GrammarPoint[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!isObject(item)) return null;
      const point = text(item.point) || '';
      const note_vi = text(item.note_vi) || '';
      if (!point && !note_vi) return null;
      return { point, note_vi };
    })
    .filter((item): item is GrammarPoint => Boolean(item));
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => text(item) || '').filter((item) => item.length > 0);
}

async function fillMissingPassageOptionContent(args: {
  apiKey: string;
  model: string;
  payload: PassageExplanationPayload;
  explanation: PassageExplanation;
}): Promise<PassageExplanation> {
  const missingQuestions = args.explanation.questions
    .filter((question) =>
      question.option_analysis.some(
        (item) => !text(item.meaning_vi) || !text(item.reason_vi),
      ),
    )
    .map((question) => question.question_label);

  if (!missingQuestions.length) return args.explanation;

  try {
    const questionInfo = args.payload.questions
      .filter((question) => missingQuestions.includes(question.questionLabel))
      .map((question) => ({
        question_label: question.questionLabel,
        question_text: question.questionWithBlank,
        correct_option: question.correctAnswer,
        options: Object.entries(question.options).map(([option, textJa]) => ({ option, text_ja: textJa })),
      }));

    const prompt = [
      'Dien dữ liệu con thieu cho phan giai thich doc hieu JLPT.',
      'Trả về JSON voi schema:',
      '{ "questions": [ { "question_label": "string", "options": [ { "option": "1|2|3|4", "meaning_vi": "string", "reason_vi": "string" } ] } ] }',
      'Bat buoc: meaning_vi va reason_vi không được rong.',
      `Doan van:\n${args.payload.passageText || '(không co)'}`,
      `Cac câu hỏi can dien:\n${JSON.stringify(questionInfo)}`,
    ].join('\n');

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${args.apiKey}`,
      },
      body: JSON.stringify({
        model: args.model,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'Ban la giao vien JLPT. Tra loi ngan gon, ro rang, dung JSON.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
      }),
    });

    if (!response.ok) {
      return forceFallbackPassageOptionContent(args.explanation);
    }

    const data = (await response.json()) as OpenAIChatCompletionResponse;
    const rawContent = String(data?.choices?.[0]?.message?.content || '').trim();
    if (!rawContent) return forceFallbackPassageOptionContent(args.explanation);
    const parsed = parseLooseJson(rawContent);
    return mergePassageOptionContent(args.explanation, parsed);
  } catch {
    return forceFallbackPassageOptionContent(args.explanation);
  }
}

function mergePassageOptionContent(explanation: PassageExplanation, raw: unknown): PassageExplanation {
  const value = isObject(raw) ? raw : {};
  const questions = Array.isArray(value.questions) ? value.questions : [];
  const fillMap = new Map<string, Map<string, { meaning_vi: string; reason_vi: string }>>();

  for (const item of questions) {
    if (!isObject(item)) continue;
    const label = text(item.question_label);
    if (!label) continue;
    const options = Array.isArray(item.options) ? item.options : [];
    const optionMap = new Map<string, { meaning_vi: string; reason_vi: string }>();
    for (const opt of options) {
      if (!isObject(opt)) continue;
      const option = normalizeOptionKey(opt.option);
      if (!option) continue;
      optionMap.set(option, {
        meaning_vi: text(opt.meaning_vi) || '',
        reason_vi: text(opt.reason_vi) || '',
      });
    }
    fillMap.set(label, optionMap);
  }

  const nextQuestions = explanation.questions.map((question) => {
    const optionMap = fillMap.get(question.question_label);
    if (!optionMap) return applyOptionFallback(question);
    const option_analysis = question.option_analysis.map((item) => {
      const key = normalizeOptionKey(item.option);
      const filled = optionMap.get(key);
      return {
        ...item,
        meaning_vi: item.meaning_vi || filled?.meaning_vi || '',
        reason_vi: item.reason_vi || filled?.reason_vi || '',
      };
    });
    const option_details = question.option_details.map((item) => {
      const key = normalizeOptionKey(item.option);
      const filled = optionMap.get(key);
      return {
        ...item,
        meaning_vi: item.meaning_vi || filled?.meaning_vi || '',
      };
    });
    return applyOptionFallback({
      ...question,
      option_analysis,
      option_details,
    });
  });

  return {
    ...explanation,
    questions: nextQuestions,
  };
}

function forceFallbackPassageOptionContent(explanation: PassageExplanation): PassageExplanation {
  return {
    ...explanation,
    questions: explanation.questions.map((question) => applyOptionFallback(question)),
  };
}

function applyOptionFallback(question: PassageQuestionExplanation): PassageQuestionExplanation {
  const option_analysis = question.option_analysis.map((item) => {
    const isCorrect = normalizeOptionKey(item.option) === normalizeOptionKey(question.correct_option);
    return {
      ...item,
      reason_vi:
        item.reason_vi ||
        (isCorrect
          ? 'Lựa chọn nay phu hop nhat voi noi dung va lap luan trong doan van.'
          : 'Lựa chọn nay không khop voi thong tin/chu de được neu trong doan van.'),
      meaning_vi: item.meaning_vi || '',
    };
  });
  const meaningMap = new Map(option_analysis.map((item) => [normalizeOptionKey(item.option), item.meaning_vi || '']));
  const option_details = question.option_details.map((item) => ({
    ...item,
    meaning_vi: item.meaning_vi || meaningMap.get(normalizeOptionKey(item.option)) || '',
  }));
  return {
    ...question,
    option_analysis,
    option_details,
  };
}

function normalizeSentenceKey(input: string): string {
  return String(input || '')
    .replace(/\s+/g, '')
    .replace(/[（(]/g, '(')
    .replace(/[）)]/g, ')')
    .replace(/[。．]/g, '。')
    .trim();
}

function parsePositiveInt(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function normalizeOptionKey(value: unknown): string {
  const raw = text(value) || '';
  if (!raw) return '';
  const normalized = raw.replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0));
  const matched = normalized.match(/[1-4]/);
  return matched ? matched[0] : normalized;
}

function sortOptionKey(a: string, b: string): number {
  const na = Number(normalizeOptionKey(a));
  const nb = Number(normalizeOptionKey(b));
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return String(a).localeCompare(String(b));
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str.length ? str : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function safeReadBody(response: Response) {
  try {
    const responseText = await response.text();
    return responseText.slice(0, 400);
  } catch {
    return 'Unable to read response body';
  }
}


