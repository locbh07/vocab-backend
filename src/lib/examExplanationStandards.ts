import type { JlptQuestionType } from './jlptQuestionType';

// Never silently discard an image and let the model infer its contents from the answer key.
export const MISSING_IMAGE_TEXT = '[JLPT_IMAGE_REQUIRES_TRANSCRIPTION]';

export function explanationSourceText(html: string): string {
  return String(html || '')
    .replace(/<(rt|rp|script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<img\b[^>]*>/gi, MISSING_IMAGE_TEXT)
    .replace(/<br\s*\/?>|<\/(?:p|div|tr|li)>/gi, '\n')
    .replace(/<\/(?:td|th)>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

export function assertExplanationSource(source: string, requirePassage = false): void {
  if (source.includes(MISSING_IMAGE_TEXT)) {
    throw Object.assign(new Error('Bài này có nội dung trong ảnh chưa được chuyển thành văn bản. Cần bổ sung nội dung bảng/ảnh trước khi tạo giải thích.'), { status: 422 });
  }
  if (requirePassage && !source.trim()) {
    throw Object.assign(new Error('Chưa có bài đọc hoặc lời thoại để làm căn cứ giải thích.'), { status: 422 });
  }
}

export const EXPLANATION_FORMAT_RULES = [
  'Viết tiếng Việt có dấu, đi thẳng vào đáp án và căn cứ; không chào hỏi, không lặp lời khuyên chung.',
  'Giữ nguyên tiếng Nhật tự nhiên. KHÔNG chèn ruby, HTML hoặc cách đọc trong ngoặc vào văn bản Nhật. Cách đọc chỉ nằm trong reading_hira hoặc danh sách vocab.',
  'Mỗi từ vựng gồm surface, reading_hira, meaning_vi. surface là nguyên từ/cụm trong câu, gồm cả đuôi chia; không cắt thân từ như 届 hoặc 入. Có thể thêm dictionary_form riêng nếu cần.',
  'Liệt kê các từ Kanji và từ/cụm quan trọng giúp hiểu câu; không lặp cùng từ trong một câu, không thêm từ ngoài nội dung.',
  'Mỗi lựa chọn phải có lý do riêng: chỉ rõ sai ở âm, nghĩa, kết hợp, điều kiện hoặc căn cứ nào. Không dùng lý do chỉ nói không phù hợp ngữ cảnh.',
  'Không bịa từ tương ứng với cách đọc sai, không suy ra nội dung nguồn từ đáp án. Nếu nguồn mâu thuẫn hoặc thiếu căn cứ, nêu rõ giới hạn thay vì khẳng định.',
  'quote_ja của mỗi evidence là MỘT đoạn liền mạch chép đúng nguyên văn nguồn. Cần nhiều chỗ thì tách thành nhiều evidence, không nối hai chỗ cách xa nhau vào một trích dẫn. Với hội thoại, chỉ giữ nhãn người nói khi nhãn đó đứng ngay trước đoạn được trích.',
].join('\n');

export function questionTeachingRules(type: JlptQuestionType): string {
  const rules: Record<JlptQuestionType, string> = {
    vocab_kanji_reading: 'Chỉ rõ cách đọc của từ được hỏi và chỗ khác biệt của từng lựa chọn: trường âm, âm đục, âm ngắt, âm ghép. Hán Việt/On/Kun và 1–2 từ ghép chỉ thêm khi hữu ích và chắc chắn; không dùng từ ghép khác làm bằng chứng tuyệt đối cho cách đọc của từ này.',
    vocab_kanji_writing: 'Đối chiếu từ kana với Kanji theo nghĩa trong câu. Phân biệt các chữ/từ đồng âm và giải thích nghĩa từng lựa chọn; không giải như bài chỉ chọn phát âm.',
    vocab_word_formation: 'Phân tích gốc từ, tiền tố/hậu tố, nghĩa và quy tắc kết hợp. Cho câu đã điền, giải thích cụ thể vì sao các cách ghép khác không dùng được.',
    vocab_context: 'Cho câu đã điền và dịch sát nghĩa. Chỉ ra dấu hiệu trong câu, kết hợp từ, sắc thái và điều kiện sử dụng; với lựa chọn sai, đưa cách sửa khi có ích.',
    vocab_paraphrase: 'Đối chiếu cụm gốc với cách diễn đạt tương đương, giữ chủ thể, thời, mức độ và sắc thái. Giải thích tại sao thay từng lựa chọn làm đổi nghĩa cả câu.',
    vocab_usage: 'Phân tích đủ từng câu lựa chọn: nghĩa từ, đối tượng, trợ từ, kết hợp và ngữ cảnh. Với câu sai, corrected_ja là cả câu được sửa tự nhiên; giải thích đã sửa gì.',
    grammar_choice: 'Cho câu hoàn chỉnh sau khi điền và bản dịch. Nêu cấu trúc kết nối trước/sau chỗ trống, ý nghĩa và điểm khác biệt của từng mẫu ngữ pháp dễ nhầm.',
    sentence_order: 'Dùng đủ bốn mảnh đúng một lần. Giải thích liên kết từng cặp/mẫu ngữ pháp trong reason_vi và vai trò mỗi mảnh trong option_analysis. ordered_options phải đặt đáp án đúng tại vị trí ★ thực tế trong đề. Mảnh không ở ★ vẫn là thành phần đúng của câu.',
    reading_cloze: 'Đây là điền đoạn văn: dùng cả câu trước và sau, xác định từ quy chiếu, liên từ, thời và mạch ý. Trích căn cứ, cho câu đã điền và phân tích vì sao từng lựa chọn phá vỡ liên kết.',
    reading_content: 'Trích nguyên văn căn cứ và giải thích quan hệ diễn đạt tương đương. Đoạn ngắn: câu quyết định; đoạn vừa: nhân quả/đối lập/chủ thể; A/B: căn cứ từ cả hai; chủ trương: luận điểm khác ví dụ; tra cứu: đối chiếu đủ điều kiện, ngoại lệ, chú thích và phép tính nếu có. Không suy diễn ngoài bài.',
    listening: 'Chỉ dựa trên lời thoại được cung cấp, không tuyên bố đã nghe audio. Trích lời quyết định, người nói, phủ định/thay đổi ý và trình tự hành động. Phân tích phương án sai theo lời thoại; nêu thiếu dữ kiện nếu transcript không đủ.',
    unknown: 'Xác định yêu cầu từ đề thực tế; không tự giả định bài ★ hoặc dạng bài chỉ từ độ dài lựa chọn. Nêu điểm chưa xác định nếu không đủ thông tin.',
  };
  return rules[type];
}

export type ExplanationEvidence = { quote_ja: string; explanation_vi: string; sentence_index?: number };

export function normalizeEvidence(raw: unknown, source: string, sentences: string[] = []): ExplanationEvidence[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const quote = String(item.quote_ja || '').trim();
    const explanation = String(item.explanation_vi || '').trim();
    if (!quote || !explanation) return [];
    const segments = groundQuoteSegments(quote, source);
    if (!segments) return [];
    // Derive the index from the actual quote, never trust a model-supplied index.
    const first = quoteKey(segments[0].body);
    const index = sentences.findIndex(s => quoteKey(s).includes(first));
    return [{ quote_ja: quote, explanation_vi: explanation, ...(index >= 0 ? { sentence_index: index + 1 } : {}) }];
  });
}

const quoteKey = (value: string) => String(value || '').replace(/\s+/g, '');

// A listening transcript is a run of "男：…  女：…" turns, and the model routinely quotes two
// turns at once or re-attaches the speaker tag from the start of a turn to a sentence in the
// middle of it. Both are honest quotes, so verify the quote turn by turn instead of demanding
// one contiguous substring - while still refusing anything the source does not actually say,
// including a line attributed to the wrong speaker.
const SPEAKER_TAG = /[^\s。、，,？！?!：:]{1,8}[：:]/gu;

type QuoteSegment = { speaker: string; body: string };

function splitSpeakerSegments(input: string): QuoteSegment[] {
  const segments: QuoteSegment[] = [];
  const pattern = new RegExp(SPEAKER_TAG.source, 'gu');
  let speaker = '';
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input))) {
    const body = input.slice(cursor, match.index);
    if (body.trim()) segments.push({ speaker, body });
    speaker = match[0].slice(0, -1);
    cursor = match.index + match[0].length;
  }
  const tail = input.slice(cursor);
  if (tail.trim()) segments.push({ speaker, body: tail });
  return segments;
}

function groundQuoteSegments(quote: string, source: string): QuoteSegment[] | null {
  const segments = splitSpeakerSegments(quote);
  if (!segments.length) return null;
  const turns = splitSpeakerSegments(source);
  const wholeSource = quoteKey(source);
  const grounded = segments.every(segment => {
    const body = quoteKey(segment.body);
    if (!body) return false;
    if (!segment.speaker) return wholeSource.includes(body);
    return turns.some(turn => turn.speaker === segment.speaker && quoteKey(turn.body).includes(body));
  });
  return grounded ? segments : null;
}

// The trailing "（注1）語：意味　（注2）…" line of a reading passage is a glossary of hard words,
// not prose. Models either skip it or gloss it as a whole, and demanding a translation plus a
// vocab list for it fails an otherwise complete explanation.
export function isPassageFootnote(sentence: string): boolean {
  return /^[\s　]*[（(]\s*注\s*\d*\s*[）)]/u.test(String(sentence || ''));
}

export function starSlotIndex(question: string): number | null {
  // Imported exams use _★_ as ONE slot. Match the four-slot cluster only;
  // punctuation and the long vowel mark in Japanese words are not blanks.
  const cluster = question.match(/(?:(?:[＿_－\-〜～]*★[＿_－\-〜～]*|[＿_－\-〜～]+)\s*){4}/gu)?.find(s => s.includes('★')) || '';
  const slots = (cluster.match(/[＿_－\-〜～]*★[＿_－\-〜～]*|[＿_－\-〜～]+/gu) || []).map(s => s.includes('★') ? '★' : s);
  return slots.length === 4 && slots.filter(s => s === '★').length === 1 ? slots.indexOf('★') : null;
}

export function isValidStarOrder(order: string[], options: string[], question: string, correct: string): boolean {
  const slot = starSlotIndex(question);
  return order.length === options.length && new Set(order).size === options.length &&
    order.every(o => options.includes(o)) && slot !== null && order[slot] === correct;
}

export function assertStarQuestionSource(question: string): void {
  if (starSlotIndex(question) === null) {
    throw Object.assign(new Error('Câu ★ này chưa có đủ bốn vị trí trống rõ ràng trong dữ liệu đề. Cần chỉnh lại nội dung câu trước khi tạo giải thích.'), { status: 422 });
  }
}
