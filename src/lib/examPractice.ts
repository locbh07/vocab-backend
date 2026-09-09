type JsonSection = { section_title?: unknown; sec?: unknown; questions?: unknown[] };
export type PracticeRow = { level: string; exam_id: string; part: number; json_data: unknown };

// Read explicit headings, including known OCR variants. Never infer from question
// counts: those change across years. N3–N5 restart numbering in part 2.
export function practiceMondaiNumber(title: unknown): number | null {
  const text = String(title || '').normalize('NFKC').replace(/<[^>]*>/g, ' ');
  const match = text.match(/(?:問題|問题|間題|もんだい|mondai)\s*[:：]?\s*(\d+)/i);
  return match && Number(match[1]) > 0 ? Number(match[1]) : null;
}

export function buildPracticeCatalog(rows: PracticeRow[]) {
  const groups = new Map<string, {
    id: string; category: string; mondai: number | null; label: string;
    exams: Array<{ examId: string; questionCount: number; segments: Array<{ part: number; sectionIndexes: number[] }> }>;
  }>();
  for (const row of rows) {
    const data = (row.json_data || {}) as { sections?: JsonSection[] };
    const sections = Array.isArray(data.sections) ? data.sections : [];
    sections.forEach((section, sectionIndex) => {
      const count = Array.isArray(section.questions) ? section.questions.length : 0;
      if (!count) return;
      const mondai = row.part === 3 ? null : practiceMondaiNumber(section.section_title || section.sec);
      if (row.part !== 3 && mondai === null) return;
      const advanced = row.level === 'N1' || row.level === 'N2';
      const vocabEnd = row.level === 'N1' ? 4 : 6;
      const grammarEnd = row.level === 'N1' ? 7 : 9;
      const category = row.part === 3 ? 'listening' : advanced
        ? mondai! <= vocabEnd ? 'vocabulary' : mondai! <= grammarEnd ? 'grammar' : 'reading'
        : row.part === 1 ? 'vocabulary' : mondai! <= 3 ? 'grammar' : 'reading';
      const id = row.part === 3 ? 'listening' : `${category}-${mondai}`;
      if (!groups.has(id)) groups.set(id, {
        id, category, mondai, label: row.part === 3 ? 'Nghe hiểu — toàn bộ phần nghe' : `Mondai ${mondai}`,
        exams: [],
      });
      const group = groups.get(id)!;
      let exam = group.exams.find(item => item.examId === row.exam_id);
      if (!exam) { exam = { examId: row.exam_id, questionCount: 0, segments: [] }; group.exams.push(exam); }
      exam.questionCount += count;
      let segment = exam.segments.find(item => item.part === row.part);
      if (!segment) { segment = { part: row.part, sectionIndexes: [] }; exam.segments.push(segment); }
      segment.sectionIndexes.push(sectionIndex);
    });
  }
  const order = ['vocabulary', 'grammar', 'reading', 'listening'];
  return [...groups.values()].sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category) || (a.mondai || 0) - (b.mondai || 0))
    .map(group => ({ ...group, exams: group.exams.sort((a, b) => b.examId.localeCompare(a.examId)) }));
}
