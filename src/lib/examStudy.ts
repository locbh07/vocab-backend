import { createHash } from 'crypto';

type Row = { level: string; exam_id: string; part: number; section_index?: number; question_index?: number; json_data?: any; explanation_json?: any };
export type StudyCategory = 'vocabulary' | 'kanji' | 'grammar' | 'traps';
type Source = { id: string; examId: string; part: number; sectionIndex: number; questionIndex?: number; label: string; text: string; kind: 'question' | 'passage' };
type Example = { source: Omit<Source, 'text'>; surface: string; reading: string; meaning: string; sentence: string; note: string };
export type StudyItem = { id: string; category: StudyCategory; title: string; sourceCount: number; explanationCount: number; examCount: number; basic: boolean; examples: Example[] };
type Bucket = { category: StudyCategory; title: string; sources: Set<string>; explanationSources: Set<string>; exams: Set<string>; forms: Set<string>; examples: Example[] };
const text = (value: unknown): string => String(value || '').replace(/<rt\b[^>]*>[\s\S]*?<\/rt>/gi, '').replace(/<rp\b[^>]*>[\s\S]*?<\/rp>/gi, '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
const norm = (value: unknown) => text(value).normalize('NFKC').replace(/\s+/g, '');
const list = (value: any): any[] => Array.isArray(value) ? value : [];
const key = (row: Row) => `${row.exam_id}:${row.part}`;
const sourceRef = ({ text: _text, ...source }: Source) => source;
const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').toLowerCase();
const basicWords = new Set(['する', 'ある', 'いる', 'なる', 'できる', 'だ', 'です', 'ない', 'こと', 'もの', 'の', 'は', 'が', 'を', 'に', 'で', 'と', 'も', 'から', 'まで', 'よ', 'ね', 'それ', 'これ', 'あれ', 'どれ', 'その', 'この', 'あの', 'どの', 'ため', 'よう', 'そう', 'ん', 'ます']);

// Labels describe broad trap families, not editorially proven equivalence of examples.
function trapFamily(note: string): string {
  const s = fold(note);
  if (/phu dinh|ngoai le|否定|例外/.test(s)) return 'Phủ định và ngoại lệ';
  if (/truong am|am ngat|am duc|cach doc|dong am|kanji|漢字|読み/.test(s)) return 'Cách đọc và chữ gần giống';
  if (/chu the|nguoi noi|ai lam|doi tuong|chu ngu/.test(s)) return 'Nhầm chủ thể hoặc đối tượng';
  if (/truoc khi|sau khi|dau tien|thu tu|thay doi y|cuoi cung/.test(s)) return 'Thứ tự và thay đổi ý định';
  if (/ket hop|collocation|tro tu|cach dung|dung tu|sac thai/.test(s)) return 'Kết hợp từ và sắc thái sử dụng';
  if (/dieu kien|nguyen nhan|ket qua|muc dich|ly do/.test(s)) return 'Điều kiện, nguyên nhân và mục đích';
  if (/suy dien|qua muc|tuyet doi|tat ca|luon luon|mot phan/.test(s)) return 'Suy diễn và khái quát quá mức';
  if (/tuong duong|dien dat|dong nghia|gan nghia/.test(s)) return 'Diễn đạt tương đương';
  return 'Các điểm dễ nhầm khác';
}

export function buildExamStudy(exams: Row[], questions: Row[], passages: Row[]) {
  const rows = exams.filter((r) => r.level === 'N2');
  const sources = new Map<string, Source>();
  const examMap = new Map(rows.map((r) => [key(r), r.json_data || {}]));
  const buckets = new Map<string, Bucket>();
  const annotated = new Set<string>();
  function bucket(category: StudyCategory, title: string) {
    const id = `${category}:${norm(title)}`;
    if (!buckets.has(id)) buckets.set(id, { category, title: text(title), sources: new Set(), explanationSources: new Set(), exams: new Set(), forms: new Set(), examples: [] });
    return buckets.get(id)!;
  }
  function add(category: StudyCategory, title: string, source: Source, example: Omit<Example, 'source'>, inSource = true) {
    if (!text(title)) return;
    const b = bucket(category, title);
    if (example.surface) b.forms.add(norm(example.surface));
    b.explanationSources.add(source.id);
    if (inSource) { b.sources.add(source.id); b.exams.add(source.examId); }
    if (b.examples.length < 5 && !b.examples.some((e) => e.source.id === source.id && e.surface === example.surface && e.note === example.note)) {
      b.examples.push({ source: sourceRef(source), ...example, sentence: example.sentence.slice(0, 1600), note: example.note.slice(0, 1200) });
    }
  }
  for (const row of rows) {
    const data = row.json_data || {};
    list(data.sections).forEach((section, si) => list(section.questions).forEach((q, qi) => {
      const id = `q:${key(row)}:${si}:${qi}`;
      const questionText = text(q.ques ?? q.question_html).replace(/^\s*[（(]?\d+[）)]?\s*(?:番|[.．、])\s*/, '');
      sources.set(id, { id, examId: row.exam_id, part: row.part, sectionIndex: si, questionIndex: qi, kind: 'question', label: String(q.qid ?? qi + 1), text: [questionText, ...Object.values(q.options || {}).map(text)].join('\n') });
    }));
    for (const p of list(data.passages)) {
      const pid = String(p.passage_id ?? p.pid);
      const id = `p:${key(row)}:${pid}`;
      const si = list(data.sections).findIndex((s) => list(s.questions).some((q) => [q.passage_id ?? q.pid].flat().map(String).includes(pid)));
      sources.set(id, { id, examId: row.exam_id, part: row.part, sectionIndex: Math.max(0, si), kind: 'passage', label: `Đoạn ${pid}`, text: text(p.passage_html ?? p.passage) });
    }
  }
  const gloss = (words: any[], source: Source, sentence: string) => {
    for (const word of words) {
      const surface = text(word?.surface), title = text(word?.dictionary_form) || surface;
      if (!surface || !text(word?.meaning_vi)) continue;
      add('vocabulary', title, source, { surface, reading: text(word.reading_hira), meaning: text(word.meaning_vi), sentence, note: '' }, norm(source.text).includes(norm(surface)));
    }
  };
  const notes = (explanation: any, source: Source, sentence: string) => {
    for (const g of list(explanation.grammar_points)) add('grammar', text(g.point).replace(/[～〜]/g, '~'), source, { surface: text(g.point), reading: '', meaning: '', sentence, note: text(g.note_vi) });
    const traps = [...list(explanation.trap_patterns_vi), ...list(explanation.global_traps_vi), ...list(explanation.option_analysis).map((o) => o.trap_vi)].map(text).filter(Boolean);
    for (const trap of traps) add('traps', trapFamily(trap), source, { surface: '', reading: '', meaning: '', sentence, note: trap });
  };
  for (const row of questions.filter((r) => r.level === 'N2')) {
    const source = sources.get(`q:${key(row)}:${row.section_index}:${row.question_index}`);
    if (!source) continue;
    const e = row.explanation_json || {};
    annotated.add(source.id);
    const sentence = text(e.completed_sentence_ja || e.question_ja) || source.text;
    gloss(list(e.key_vocab), source, sentence);
    notes(e, source, sentence);
  }
  // A shared passage is counted once, regardless of the number of questions referencing it.
  for (const row of passages.filter((r) => r.level === 'N2')) {
    const e = row.explanation_json || {}, exam = examMap.get(key(row));
    const passageText = norm(e.passage_ja);
    const matched = [...sources.values()].filter((s) => s.kind === 'passage' && s.examId === row.exam_id && s.part === row.part && norm(s.text) && passageText.includes(norm(s.text)));
    for (const source of matched) {
      annotated.add(source.id);
      for (const sentence of list(e.sentence_readings)) if (norm(source.text).includes(norm(sentence.sentence_ja)) && norm(sentence.sentence_ja)) gloss(list(sentence.vocab), source, text(sentence.sentence_ja));
      gloss(list(e.key_vocab), source, text(e.passage_ja));
      notes(e, source, text(e.passage_ja));
    }
    for (const q of list(e.questions)) {
      const section = list(exam?.sections)[row.section_index || 0];
      const qi = list(section?.questions).findIndex((original, i) => String(original.qid ?? i + 1) === String(q.question_label));
      const source = sources.get(`q:${key(row)}:${row.section_index}:${qi}`);
      if (!source) continue;
      annotated.add(source.id);
      gloss(list(q.key_vocab), source, text(q.sentence_with_answer_ja || q.sentence_with_blank_ja));
      notes(q, source, text(q.sentence_with_answer_ja || q.sentence_with_blank_ja) || source.text);
    }
  }
  // Measure each annotated vocabulary candidate across the entire written corpus,
  // not just questions for which the AI happened to list it as a keyword.
  const vocab = [...buckets.values()].filter((b) => b.category === 'vocabulary');
  const normalizedSources = [...sources.values()].map((source) => ({ source, normalized: norm(source.text) }));
  for (const b of vocab) {
    const forms = [...new Set([norm(b.title), ...b.forms].filter(Boolean))];
    for (const { source, normalized } of normalizedSources) if (forms.some((f) => normalized.includes(f))) { b.sources.add(source.id); b.exams.add(source.examId); }
  }
  for (const source of sources.values()) {
    for (const char of new Set(source.text.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) || [])) {
      const b = bucket('kanji', char); b.sources.add(source.id); b.exams.add(source.examId);
      if (b.examples.length < 5) {
        const pos = source.text.indexOf(char);
        b.examples.push({ source: sourceRef(source), surface: char, reading: '', meaning: '', note: 'Xem chữ trong câu; không suy âm On/Kun từ một từ riêng lẻ.', sentence: source.text.slice(Math.max(0, pos - 70), pos + 120) });
      }
    }
  }
  const kanjiExamples = new Map<string, Map<string, Example>>();
  for (const v of vocab) for (const example of v.examples) {
    if (!norm(sources.get(example.source.id)?.text).includes(norm(example.surface))) continue;
    for (const char of new Set(example.surface.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) || [])) {
      if (!kanjiExamples.has(char)) kanjiExamples.set(char, new Map());
      kanjiExamples.get(char)!.set(example.surface, example);
    }
  }
  for (const b of buckets.values()) if (b.category === 'kanji') {
    const examples = kanjiExamples.get(b.title);
    if (examples?.size) b.examples = [...examples.values()].slice(0, 5);
  }
  const items: StudyItem[] = [...buckets.entries()].map(([key, b]) => ({ id: createHash('sha256').update(key).digest('hex').slice(0, 20), category: b.category, title: b.title, sourceCount: b.sources.size, explanationCount: b.explanationSources.size, examCount: b.exams.size, basic: b.category === 'vocabulary' && basicWords.has(b.title), examples: b.examples }));
  items.sort((a, b) => b.sourceCount - a.sourceCount || b.examCount - a.examCount || a.title.localeCompare(b.title, 'ja'));
  return { meta: { level: 'N2', examCount: new Set(rows.map((r) => r.exam_id)).size, sourceCount: sources.size, questionCount: [...sources.values()].filter((s) => s.kind === 'question').length, passageCount: [...sources.values()].filter((s) => s.kind === 'passage').length, annotatedSourceCount: annotated.size, generatedAt: new Date().toISOString(), readingStatus: 'unreviewed', counts: Object.fromEntries(['vocabulary', 'kanji', 'grammar', 'traps'].map((c) => [c, items.filter((i) => i.category === c).length])) }, items };
}
