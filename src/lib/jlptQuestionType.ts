export type JlptQuestionType =
  | 'vocab_kanji_reading'
  | 'vocab_kanji_writing'
  | 'vocab_context'
  | 'grammar_choice'
  | 'sentence_order'
  | 'reading_cloze'
  | 'reading_content'
  | 'listening'
  | 'unknown';

export type JlptQuestionMeta = {
  mondaiLabel: string;
  mondaiNumber: number | null;
  questionType: JlptQuestionType;
  questionTypeLabelVi: string;
  strategyVi: string;
};

export type JlptQuestionTypeDescriptor = {
  questionTypeLabelVi: string;
  strategyVi: string;
};

type InferInput = {
  level: string;
  part: number;
  sectionTitle: string;
  questionLabel: string;
  questionText: string;
  optionTexts: string[];
  hasPassage: boolean;
  isClozeQuestion: boolean;
};

const TYPE_LABELS: Record<JlptQuestionType, string> = {
  vocab_kanji_reading: 'Từ vựng/Kanji - chọn cách đọc',
  vocab_kanji_writing: 'Từ vựng/Kanji - chọn cách viết',
  vocab_context: 'Từ vựng - nghĩa/ngữ cảnh',
  grammar_choice: 'Ngữ pháp - chọn cấu trúc',
  sentence_order: 'Sắp xếp câu (dạng có dấu sao ★)',
  reading_cloze: 'Đọc hiểu - điền chỗ trống',
  reading_content: 'Đọc hiểu - nội dung câu hỏi',
  listening: 'Nghe hiểu',
  unknown: 'Chưa phân loại',
};

const TYPE_STRATEGIES: Record<JlptQuestionType, string> = {
  vocab_kanji_reading:
    'Xác định âm On/Kun, loại trừ nhanh theo phát âm sai, sau đó đối chiếu nghĩa để tránh nhầm đồng âm.',
  vocab_kanji_writing:
    'Xác định từ được cho bằng hiragana, chọn kanji đúng theo nghĩa và hình thái từ, loại trừ kanji đồng âm sai nghĩa.',
  vocab_context:
    'Đặt từng đáp án vào câu, kiểm tra sắc thái nghĩa và độ tự nhiên với cụm xung quanh, ưu tiên đáp án hợp văn cảnh.',
  grammar_choice:
    'Xác định vai trò ngữ pháp của chỗ trống (trợ từ/liên từ/mẫu câu), sau đó loại trừ đáp án sai theo mẫu kết hợp.',
  sentence_order:
    'Đây là dạng sắp xếp 4 mảnh câu với vị trí ★, ghép thành câu hoàn chỉnh, rồi xác định mảnh nào đúng ở vị trí ★.',
  reading_cloze:
    'Đọc mạch toàn đoạn trước, xác định vai trò logic của ô trống, rồi chọn đáp án hợp nhất với ý trước-sau.',
  reading_content:
    'Tóm tắt ý chính, tìm câu then chốt trong đoạn, đối chiếu từng lựa chọn theo bằng chứng trực tiếp/ngụ ý.',
  listening:
    'Bắt từ khóa, chú ý phủ định và chuyển ý cuối câu, không chốt đáp án trước khi nghe hết thông tin.',
  unknown:
    'Đọc kỹ ngữ cảnh, xác định mục tiêu câu hỏi, loại trừ đáp án không hợp lý theo từng bước.',
};

export function inferJlptQuestionMeta(input: InferInput): JlptQuestionMeta {
  const section = normalize(input.sectionTitle);
  const question = normalize(input.questionText);
  const mondaiNumber = detectMondaiNumber({
    level: input.level,
    part: input.part,
    sectionTitle: section,
    questionLabel: input.questionLabel,
    questionText: question,
  });
  const mondaiLabel = mondaiNumber ? `問題${mondaiNumber}` : '';

  let questionType: JlptQuestionType = 'unknown';

  if (containsStar(section) || containsStar(question)) {
    questionType = 'sentence_order';
  } else if (input.part === 3 || hasAny(section, ['聴解', '聞く', '音声', '会話'])) {
    questionType = 'listening';
  } else {
    questionType = inferByN2Mondai({
      level: input.level,
      mondaiNumber,
      fallback: inferByHeuristic(input, section, question),
    });
  }

  return {
    mondaiLabel,
    mondaiNumber,
    questionType,
    ...describeJlptQuestionType(questionType),
  };
}

export function describeJlptQuestionType(questionType: JlptQuestionType): JlptQuestionTypeDescriptor {
  return {
    questionTypeLabelVi: TYPE_LABELS[questionType] || TYPE_LABELS.unknown,
    strategyVi: TYPE_STRATEGIES[questionType] || TYPE_STRATEGIES.unknown,
  };
}

function inferByN2Mondai(args: {
  level: string;
  mondaiNumber: number | null;
  fallback: JlptQuestionType;
}): JlptQuestionType {
  if (String(args.level || '').toUpperCase() !== 'N2' || !args.mondaiNumber) {
    return args.fallback;
  }

  const n = args.mondaiNumber;
  if (n === 1) return 'vocab_kanji_reading';
  if (n === 2) return 'vocab_kanji_writing';
  if (n === 3 || n === 4 || n === 5 || n === 6) return 'vocab_context';
  if (n === 7) return 'grammar_choice';
  if (n === 8) return 'sentence_order';
  if (n === 9) return 'reading_cloze';
  if (n >= 10 && n <= 14) return 'reading_content';
  return args.fallback;
}

function inferByHeuristic(
  input: Pick<InferInput, 'part' | 'hasPassage' | 'isClozeQuestion' | 'optionTexts'>,
  section: string,
  question: string,
): JlptQuestionType {
  if (input.isClozeQuestion && input.hasPassage) return 'reading_cloze';
  if (input.hasPassage || hasAny(section, ['読んで', '文章', '本文'])) return 'reading_content';
  if (hasAny(section, ['読み方', '読む']) || hasAny(question, ['読み方'])) return 'vocab_kanji_reading';
  if (hasAny(section, ['文法', '表現', '使い方'])) return 'grammar_choice';
  if (hasAny(section, ['意味', '近い', '言葉'])) return 'vocab_context';

  const avgLength =
    input.optionTexts.length > 0
      ? input.optionTexts.reduce((sum, item) => sum + String(item || '').trim().length, 0) /
        input.optionTexts.length
      : 0;
  if (avgLength > 0 && avgLength <= 8 && input.optionTexts.length >= 3) {
    return 'sentence_order';
  }

  return input.part === 3 ? 'listening' : 'unknown';
}

function detectMondaiNumber(input: {
  level: string;
  part: number;
  sectionTitle: string;
  questionLabel: string;
  questionText: string;
}): number | null {
  const sectionTitle = toAsciiDigits(String(input.sectionTitle || ''));
  const fromTitle = parseMondaiFromTitle(sectionTitle);
  if (fromTitle) return fromTitle;

  const fromSectionPattern = inferMondaiFromSectionPattern(sectionTitle);
  if (fromSectionPattern) return fromSectionPattern;

  const fromQuestionRange = inferMondaiFromQuestionRange({
    level: input.level,
    part: input.part,
    questionLabel: input.questionLabel,
  });
  if (fromQuestionRange) return fromQuestionRange;

  const fromQuestionText = parseMondaiFromTitle(toAsciiDigits(String(input.questionText || '')));
  if (fromQuestionText) return fromQuestionText;

  return null;
}

function parseMondaiFromTitle(sectionTitle: string): number | null {
  const match = sectionTitle.match(/問題\s*([0-9]+)/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function inferMondaiFromSectionPattern(sectionTitle: string): number | null {
  if (containsStar(sectionTitle)) return 8;
  if (
    sectionTitle.includes('文章全体') ||
    (sectionTitle.includes('（48）') && sectionTitle.includes('（51）')) ||
    (sectionTitle.includes('(48)') && sectionTitle.includes('(51)'))
  ) {
    return 9;
  }
  if (sectionTitle.includes('次の(1)から(5)') || sectionTitle.includes('次の(1) から (5)')) return 10;
  if (sectionTitle.includes('次の(1)から(3)') || sectionTitle.includes('次の(1) から (3)')) return 11;
  if (sectionTitle.includes('次のAとB')) return 12;
  if (sectionTitle.includes('次の文章を読んで')) return 13;
  if (sectionTitle.includes('右のページ') || sectionTitle.includes('案内である')) return 14;
  if (sectionTitle.includes('★に入る')) return 8;
  if (sectionTitle.includes('次の文の（　）')) return 7;
  return null;
}

function inferMondaiFromQuestionRange(input: { level: string; part: number; questionLabel: string }): number | null {
  if (String(input.level || '').toUpperCase() !== 'N2' || input.part !== 2) return null;
  const n = parseQuestionNumber(input.questionLabel);
  if (n === null) return null;
  if (n >= 43 && n <= 47) return 8;
  if (n >= 48 && n <= 51) return 9;
  if (n >= 52 && n <= 56) return 10;
  if (n >= 57 && n <= 64) return 11;
  if (n >= 65 && n <= 66) return 12;
  if (n >= 67 && n <= 69) return 13;
  if (n >= 70 && n <= 71) return 14;
  return null;
}

function parseQuestionNumber(questionLabel: string): number | null {
  const m = toAsciiDigits(String(questionLabel || '')).match(/\d+/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function containsStar(text: string): boolean {
  return text.includes('★');
}

function toAsciiDigits(value: string): string {
  return value.replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0));
}

function normalize(value: string): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function hasAny(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}
