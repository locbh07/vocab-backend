export type JlptQuestionType =
  | 'vocab_kanji_reading'
  | 'vocab_kanji_writing'
  | 'vocab_word_formation'
  | 'vocab_context'
  | 'vocab_paraphrase'
  | 'vocab_usage'
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
  vocab_word_formation: 'Từ vựng - cấu tạo từ (語形成)',
  vocab_context: 'Từ vựng - chọn theo ngữ cảnh (文脈規定)',
  vocab_paraphrase: 'Từ vựng - từ gần nghĩa (言い換え類義)',
  vocab_usage: 'Từ vựng - cách dùng từ (用法)',
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
    'Xác định từ được cho bằng kana, chọn kanji đúng theo nghĩa và từ loại, loại trừ chữ đồng âm sai nghĩa.',
  vocab_word_formation:
    'Phân tích gốc từ, tiền tố/hậu tố và dạng biến đổi để chọn từ đúng hình thái trong câu.',
  vocab_context:
    'Đặt từng đáp án vào câu, kiểm tra sắc thái nghĩa và độ tự nhiên với cụm xung quanh, ưu tiên đáp án hợp văn cảnh.',
  vocab_paraphrase:
    'So sánh nghĩa cốt lõi của từ gạch dưới với từng lựa chọn, loại những từ chỉ gần bề mặt nhưng sai sắc thái.',
  vocab_usage:
    'Đối chiếu cách kết hợp từ (collocation), mẫu đi kèm và bối cảnh để chọn cách dùng tự nhiên nhất.',
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

const MONDAI_STRATEGY_OVERRIDE: Record<string, string> = {
  'N2-10': 'Đọc nhanh đoạn ngắn, xác định câu chứa đáp án, tránh suy diễn vượt quá thông tin nêu trực tiếp.',
  'N2-11': 'Theo dõi mạch luận của đoạn trung bình, đối chiếu lựa chọn với ý chính từng đoạn con.',
  'N2-12': 'So sánh 2 đoạn A/B theo điểm giống-khác, chọn đáp án phản ánh đúng quan hệ giữa hai đoạn.',
  'N2-13': 'Tập trung luận điểm chính và thái độ tác giả trong đoạn dài, loại đáp án sai trọng tâm.',
  'N2-14': 'Tìm tín hiệu dữ liệu (mục, bảng, tiêu đề, điều kiện) và đối chiếu chính xác yêu cầu câu hỏi.',
  'N1-8': 'Đọc nhanh đoạn ngắn, chốt đáp án bằng bằng chứng trực tiếp trong câu then chốt.',
  'N1-9': 'Theo dõi quan hệ nhân quả/đối lập trong đoạn trung bình để chọn đáp án đúng mạch lập luận.',
  'N1-10': 'Bám luận điểm chính đoạn dài, phân biệt ý chính với ví dụ phụ để tránh chọn nhầm.',
  'N1-11': 'Đối chiếu 2 đoạn A/B theo quan điểm và điểm giao nhau, chọn đáp án phản ánh đúng tổng hợp.',
  'N1-12': 'Xác định chủ trương/lập trường tác giả trong đoạn dài, ưu tiên đáp án bám luận cứ chính.',
  'N1-13': 'Giải bài theo kỹ thuật tra cứu thông tin: xác định tiêu chí, quét nhanh, rồi kiểm tra chéo.',
};

export function inferJlptQuestionMeta(input: InferInput): JlptQuestionMeta {
  const level = String(input.level || '').toUpperCase();
  const section = normalize(input.sectionTitle);
  const question = normalize(input.questionText);
  const mondaiNumber = detectMondaiNumber({
    level,
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
    const heuristic = inferByHeuristic(input, section, question);
    questionType = inferByN2Mondai({ level, mondaiNumber, fallback: heuristic });
    if (questionType === heuristic) {
      questionType = inferByN1Mondai({ level, mondaiNumber, fallback: heuristic });
    }
  }

  const base = describeJlptQuestionType(questionType);
  const overrideKey = mondaiNumber ? `${level}-${mondaiNumber}` : '';
  const strategyVi = MONDAI_STRATEGY_OVERRIDE[overrideKey] || base.strategyVi;

  return {
    mondaiLabel,
    mondaiNumber,
    questionType,
    questionTypeLabelVi: base.questionTypeLabelVi,
    strategyVi,
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
  if (args.level !== 'N2' || !args.mondaiNumber) return args.fallback;

  const n = args.mondaiNumber;
  if (n === 1) return 'vocab_kanji_reading';
  if (n === 2) return 'vocab_kanji_writing';
  if (n === 3) return 'vocab_word_formation';
  if (n === 4) return 'vocab_context';
  if (n === 5) return 'vocab_paraphrase';
  if (n === 6) return 'vocab_usage';
  if (n === 7) return 'grammar_choice';
  if (n === 8) return 'sentence_order';
  if (n === 9) return 'reading_cloze';
  if (n >= 10 && n <= 14) return 'reading_content';
  return args.fallback;
}

function inferByN1Mondai(args: {
  level: string;
  mondaiNumber: number | null;
  fallback: JlptQuestionType;
}): JlptQuestionType {
  if (args.level !== 'N1' || !args.mondaiNumber) return args.fallback;

  const n = args.mondaiNumber;
  if (n === 1) return 'vocab_kanji_reading';
  if (n === 2) return 'vocab_context';
  if (n === 3) return 'vocab_paraphrase';
  if (n === 4) return 'vocab_usage';
  if (n === 5) return 'grammar_choice';
  if (n === 6) return 'sentence_order';
  if (n === 7) return 'reading_cloze';
  if (n >= 8 && n <= 13) return 'reading_content';
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
  if (hasAny(section, ['意味', '近い', '言葉'])) return 'vocab_paraphrase';

  const avgLength =
    input.optionTexts.length > 0
      ? input.optionTexts.reduce((sum, item) => sum + String(item || '').trim().length, 0) / input.optionTexts.length
      : 0;
  if (avgLength > 0 && avgLength <= 8 && input.optionTexts.length >= 3) return 'sentence_order';

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

  const fromSectionPattern = inferMondaiFromSectionPattern({
    level: input.level,
    part: input.part,
    sectionTitle,
  });
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

function inferMondaiFromSectionPattern(args: {
  level: string;
  part: number;
  sectionTitle: string;
}): number | null {
  // Keep conservative pattern inference for N2 only.
  if (String(args.level || '').toUpperCase() !== 'N2') return null;
  const sectionTitle = args.sectionTitle;
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
  const level = String(input.level || '').toUpperCase();
  const n = parseQuestionNumber(input.questionLabel);
  if (n === null) return null;

  if (level === 'N2') {
    if (input.part === 1) {
      if (n >= 1 && n <= 5) return 1;
      if (n >= 6 && n <= 10) return 2;
      if (n >= 11 && n <= 13) return 3;
      if (n >= 14 && n <= 20) return 4;
      if (n >= 21 && n <= 25) return 5;
      if (n >= 26 && n <= 30) return 6;
    }
    if (input.part === 2) {
      if (n >= 31 && n <= 42) return 7;
      if (n >= 43 && n <= 47) return 8;
      if (n >= 48 && n <= 51) return 9;
      if (n >= 52 && n <= 56) return 10;
      if (n >= 57 && n <= 64) return 11;
      if (n >= 65 && n <= 66) return 12;
      if (n >= 67 && n <= 69) return 13;
      if (n >= 70 && n <= 71) return 14;
    }
  }

  if (level === 'N1') {
    if (input.part === 1) {
      if (n >= 1 && n <= 6) return 1;
      if (n >= 7 && n <= 13) return 2;
      if (n >= 14 && n <= 19) return 3;
      if (n >= 20 && n <= 25) return 4;
    }
    if (input.part === 2) {
      if (n >= 26 && n <= 35) return 5;
      if (n >= 36 && n <= 40) return 6;
      if (n >= 41 && n <= 44) return 7;
      if (n >= 45 && n <= 48) return 8;
      if (n >= 49 && n <= 56) return 9;
      if (n >= 57 && n <= 59) return 10;
      if (n >= 60 && n <= 61) return 11;
      if (n >= 62 && n <= 64) return 12;
      if (n >= 65 && n <= 66) return 13;
    }
  }

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
