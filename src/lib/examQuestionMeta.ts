import { prisma } from './prisma';
import { inferJlptQuestionMeta, JlptQuestionType } from './jlptQuestionType';

export type ExamSectionKind =
  | 'language'
  | 'sentence_order'
  | 'reading_cloze'
  | 'reading_content'
  | 'listening'
  | 'unknown';

export type ExamQuestionMeta = {
  level: string;
  examId: string;
  part: number;
  sectionIndex: number;
  questionIndex: number;
  questionLabel: string;
  displayQuestionNo: number | null;
  mondaiNumber: number | null;
  mondaiLabel: string;
  sectionKind: ExamSectionKind;
  questionType: JlptQuestionType;
};

type MetaRow = {
  question_label: string | null;
  display_question_no: number | null;
  mondai_number: number | null;
  mondai_label: string | null;
  section_kind: string | null;
  question_type: string | null;
};

let ensureExamQuestionMetaTablePromise: Promise<void> | null = null;

export async function ensureExamQuestionMetaTable() {
  if (!ensureExamQuestionMetaTablePromise) {
    ensureExamQuestionMetaTablePromise = (async () => {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS jlpt_exam_question_meta (
          id BIGSERIAL PRIMARY KEY,
          level VARCHAR(5) NOT NULL,
          exam_id VARCHAR(20) NOT NULL,
          part SMALLINT NOT NULL,
          section_index INT NOT NULL,
          question_index INT NOT NULL,
          question_label VARCHAR(40),
          display_question_no INT,
          mondai_number INT,
          mondai_label VARCHAR(20),
          section_kind VARCHAR(40) NOT NULL DEFAULT 'unknown',
          question_type VARCHAR(40) NOT NULL DEFAULT 'unknown',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await prisma.$executeRawUnsafe(`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_jlpt_exam_question_meta_key
        ON jlpt_exam_question_meta(level, exam_id, part, section_index, question_index);
      `);
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_jlpt_exam_question_meta_exam
        ON jlpt_exam_question_meta(level, exam_id, part);
      `);
    })().catch((error) => {
      ensureExamQuestionMetaTablePromise = null;
      throw error;
    });
  }
  return ensureExamQuestionMetaTablePromise;
}

export async function upsertExamQuestionMetaForPart(args: {
  level: string;
  examId: string;
  part: number;
  jsonData?: unknown;
  force?: boolean;
}) {
  await ensureExamQuestionMetaTable();
  const level = String(args.level || '').trim();
  const examId = String(args.examId || '').trim();
  const part = Number(args.part);
  const force = Boolean(args.force);
  if (!level || !examId || !Number.isInteger(part) || part <= 0) {
    const err = new Error('Invalid level/examId/part for metadata precompute') as Error & { status?: number };
    err.status = 400;
    throw err;
  }

  let jsonData = args.jsonData as Record<string, unknown> | null | undefined;
  if (!jsonData) {
    const row = await prisma.jlptExam.findFirst({
      where: { level, exam_id: examId, part },
      select: { json_data: true },
    });
    if (!row) {
      const err = new Error('Exam part not found') as Error & { status?: number };
      err.status = 404;
      throw err;
    }
    jsonData = (row.json_data || {}) as Record<string, unknown>;
  }

  const records = buildMetaRecords({
    level,
    examId,
    part,
    jsonData: jsonData || {},
  });

  if (force) {
    await prisma.$executeRawUnsafe(
      `
        DELETE FROM jlpt_exam_question_meta
        WHERE level = $1 AND exam_id = $2 AND part = $3
      `,
      level,
      examId,
      part,
    );
  }

  for (const item of records) {
    await prisma.$executeRawUnsafe(
      `
        INSERT INTO jlpt_exam_question_meta (
          level, exam_id, part, section_index, question_index,
          question_label, display_question_no, mondai_number, mondai_label,
          section_kind, question_type, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
        ON CONFLICT (level, exam_id, part, section_index, question_index)
        DO UPDATE SET
          question_label = EXCLUDED.question_label,
          display_question_no = EXCLUDED.display_question_no,
          mondai_number = EXCLUDED.mondai_number,
          mondai_label = EXCLUDED.mondai_label,
          section_kind = EXCLUDED.section_kind,
          question_type = EXCLUDED.question_type,
          updated_at = NOW()
      `,
      item.level,
      item.examId,
      item.part,
      item.sectionIndex,
      item.questionIndex,
      item.questionLabel || null,
      item.displayQuestionNo,
      item.mondaiNumber,
      item.mondaiLabel || null,
      item.sectionKind,
      item.questionType,
    );
  }

  return {
    level,
    examId,
    part,
    totalQuestions: records.length,
    force,
  };
}

export async function upsertExamQuestionMetaForExam(args: {
  level: string;
  examId: string;
  force?: boolean;
}) {
  await ensureExamQuestionMetaTable();
  const level = String(args.level || '').trim();
  const examId = String(args.examId || '').trim();
  const force = Boolean(args.force);
  if (!level || !examId) {
    const err = new Error('Invalid level/examId for metadata precompute') as Error & { status?: number };
    err.status = 400;
    throw err;
  }

  const rows = await prisma.jlptExam.findMany({
    where: { level, exam_id: examId },
    orderBy: { part: 'asc' },
    select: { part: true, json_data: true },
  });
  if (!rows.length) {
    const err = new Error('Exam not found') as Error & { status?: number };
    err.status = 404;
    throw err;
  }

  const summaries: Array<{ part: number; totalQuestions: number }> = [];
  for (const row of rows) {
    const result = await upsertExamQuestionMetaForPart({
      level,
      examId,
      part: row.part,
      jsonData: row.json_data,
      force,
    });
    summaries.push({
      part: row.part,
      totalQuestions: result.totalQuestions,
    });
  }

  return {
    level,
    examId,
    force,
    parts: summaries,
  };
}

export async function upsertExamQuestionMetaForLevel(args: {
  level: string;
  force?: boolean;
}) {
  await ensureExamQuestionMetaTable();
  const level = String(args.level || '').trim();
  const force = Boolean(args.force);
  if (!level) {
    const err = new Error('Invalid level for metadata precompute') as Error & { status?: number };
    err.status = 400;
    throw err;
  }

  const rows = await prisma.$queryRawUnsafe<Array<{ exam_id: string }>>(
    `
      SELECT DISTINCT exam_id
      FROM jlpt_exam
      WHERE level = $1
      ORDER BY exam_id DESC
    `,
    level,
  );
  const examIds = rows.map((item) => String(item.exam_id || '')).filter((item) => item.length > 0);
  const examSummaries: Array<{
    examId: string;
    parts: Array<{ part: number; totalQuestions: number }>;
  }> = [];

  for (const examId of examIds) {
    const summary = await upsertExamQuestionMetaForExam({ level, examId, force });
    examSummaries.push({
      examId,
      parts: summary.parts,
    });
  }

  return {
    level,
    force,
    examCount: examSummaries.length,
    exams: examSummaries,
  };
}

export async function upsertExamQuestionMetaForAll(args?: {
  levels?: string[];
  force?: boolean;
}) {
  await ensureExamQuestionMetaTable();
  const force = Boolean(args?.force);
  const requestedLevels = Array.isArray(args?.levels)
    ? args!.levels.map((item) => String(item || '').trim()).filter((item) => item.length > 0)
    : [];

  const levelRows = requestedLevels.length
    ? requestedLevels.map((level) => ({ level }))
    : await prisma.$queryRawUnsafe<Array<{ level: string }>>(
      `
        SELECT DISTINCT level
        FROM jlpt_exam
        ORDER BY level ASC
      `,
    );
  const levels = levelRows.map((row) => String(row.level || '').trim()).filter((item) => item.length > 0);
  const summaries: Array<{
    level: string;
    examCount: number;
    exams: Array<{
      examId: string;
      parts: Array<{ part: number; totalQuestions: number }>;
    }>;
  }> = [];

  for (const level of levels) {
    const summary = await upsertExamQuestionMetaForLevel({ level, force });
    summaries.push({
      level,
      examCount: summary.examCount,
      exams: summary.exams,
    });
  }

  return {
    levels,
    force,
    levelCount: summaries.length,
    summaries,
  };
}

export async function getExamQuestionMeta(args: {
  level: string;
  examId: string;
  part: number;
  sectionIndex: number;
  questionIndex: number;
}): Promise<ExamQuestionMeta | null> {
  await ensureExamQuestionMetaTable();
  const rows = await prisma.$queryRawUnsafe<Array<MetaRow>>(
    `
      SELECT
        question_label,
        display_question_no,
        mondai_number,
        mondai_label,
        section_kind,
        question_type
      FROM jlpt_exam_question_meta
      WHERE level = $1
        AND exam_id = $2
        AND part = $3
        AND section_index = $4
        AND question_index = $5
      LIMIT 1
    `,
    args.level,
    args.examId,
    args.part,
    args.sectionIndex,
    args.questionIndex,
  );
  if (!rows.length) return null;

  const row = rows[0];
  const questionType = normalizeQuestionType(row.question_type);
  return {
    level: args.level,
    examId: args.examId,
    part: args.part,
    sectionIndex: args.sectionIndex,
    questionIndex: args.questionIndex,
    questionLabel: String(row.question_label || ''),
    displayQuestionNo: row.display_question_no === null || row.display_question_no === undefined ? null : Number(row.display_question_no),
    mondaiNumber: row.mondai_number === null || row.mondai_number === undefined ? null : Number(row.mondai_number),
    mondaiLabel: String(row.mondai_label || ''),
    sectionKind: normalizeSectionKind(row.section_kind),
    questionType,
  };
}

function buildMetaRecords(args: {
  level: string;
  examId: string;
  part: number;
  jsonData: Record<string, unknown>;
}): ExamQuestionMeta[] {
  const sections = Array.isArray(args.jsonData.sections)
    ? (args.jsonData.sections as Array<Record<string, unknown>>)
    : [];
  const out: ExamQuestionMeta[] = [];

  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
    const section = sections[sectionIndex] || {};
    const sectionTitle = normalizeSpace(
      stripHtml(
        toText(section.section_title ?? section.sec ?? section.section_html ?? section.title ?? section.heading) || '',
      ),
    );
    const questions = Array.isArray(section.questions)
      ? (section.questions as Array<Record<string, unknown>>)
      : [];

    for (let questionIndex = 0; questionIndex < questions.length; questionIndex += 1) {
      const q = questions[questionIndex] || {};
      const rawQuestionText = normalizeSpace(stripHtml(toText(q.question_html ?? q.ques) || ''));
      const rawQuestionLabel = toText(q.question_id ?? q.qid) || `${questionIndex + 1}`;
      const displayQuestionNo = extractDisplayQuestionNo(rawQuestionText, rawQuestionLabel, questionIndex);
      const questionLabelForInfer = displayQuestionNo !== null ? String(displayQuestionNo) : rawQuestionLabel;
      const options = extractOptions(q);
      const passageText = extractPassageText(args.jsonData, q);
      const markerCandidates = buildBlankMarkerCandidates(rawQuestionText, questionLabelForInfer);
      const sentenceWithBlank = extractSentenceAroundBlank(passageText, markerCandidates);
      const isClozeQuestion = isOnlyBlankMarker(rawQuestionText) && Boolean(sentenceWithBlank);
      const inferred = inferJlptQuestionMeta({
        level: args.level,
        part: args.part,
        sectionTitle,
        questionLabel: questionLabelForInfer,
        questionText: rawQuestionText,
        optionTexts: Object.values(options),
        hasPassage: Boolean(passageText),
        isClozeQuestion,
      });

      out.push({
        level: args.level,
        examId: args.examId,
        part: args.part,
        sectionIndex,
        questionIndex,
        questionLabel: rawQuestionLabel,
        displayQuestionNo,
        mondaiNumber: inferred.mondaiNumber,
        mondaiLabel: inferred.mondaiLabel,
        sectionKind: toSectionKind(inferred.questionType),
        questionType: inferred.questionType,
      });
    }
  }

  return out;
}

function toSectionKind(questionType: JlptQuestionType): ExamSectionKind {
  if (questionType === 'sentence_order') return 'sentence_order';
  if (questionType === 'reading_cloze') return 'reading_cloze';
  if (questionType === 'reading_content') return 'reading_content';
  if (questionType === 'listening') return 'listening';
  if (
    questionType === 'vocab_kanji_reading' ||
    questionType === 'vocab_kanji_writing' ||
    questionType === 'vocab_context' ||
    questionType === 'grammar_choice'
  ) {
    return 'language';
  }
  return 'unknown';
}

function normalizeQuestionType(input: string | null): JlptQuestionType {
  const value = String(input || '').trim();
  const allowed: JlptQuestionType[] = [
    'vocab_kanji_reading',
    'vocab_kanji_writing',
    'vocab_context',
    'grammar_choice',
    'sentence_order',
    'reading_cloze',
    'reading_content',
    'listening',
    'unknown',
  ];
  return allowed.includes(value as JlptQuestionType) ? (value as JlptQuestionType) : 'unknown';
}

function normalizeSectionKind(input: string | null): ExamSectionKind {
  const value = String(input || '').trim();
  const allowed: ExamSectionKind[] = [
    'language',
    'sentence_order',
    'reading_cloze',
    'reading_content',
    'listening',
    'unknown',
  ];
  return allowed.includes(value as ExamSectionKind) ? (value as ExamSectionKind) : 'unknown';
}

function extractDisplayQuestionNo(questionText: string, questionLabel: string, questionIndex: number): number | null {
  const fromText = parseLeadingQuestionNo(questionText);
  if (fromText !== null) return fromText;
  const fromLabel = parseDigits(questionLabel);
  if (fromLabel !== null) return fromLabel;
  const fallback = Number(questionIndex) + 1;
  return Number.isFinite(fallback) ? fallback : null;
}

function parseLeadingQuestionNo(text: string): number | null {
  const normalized = toAsciiDigitsLocal(String(text || ''));
  const m = normalized.match(/^\s*(\d{1,3})\s*[.．。]/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function parseDigits(text: string): number | null {
  const normalized = toAsciiDigitsLocal(String(text || ''));
  const m = normalized.match(/\d+/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function extractPassageText(partJson: Record<string, unknown>, question: Record<string, unknown>): string {
  const passages = Array.isArray(partJson.passages)
    ? (partJson.passages as Array<Record<string, unknown>>)
    : [];
  if (!passages.length) return '';

  const rawPassageId = question.passage_id ?? question.pid;
  const ids = Array.isArray(rawPassageId)
    ? rawPassageId.map((item) => String(item))
    : [String(rawPassageId ?? '')];
  const validIds = ids.filter((id) => id.length > 0);
  if (!validIds.length) return '';

  const texts: string[] = [];
  for (const p of passages) {
    const passageId = String(p.passage_id ?? p.pid ?? '');
    if (!validIds.includes(passageId)) continue;
    const rawText = toText(p.passage_html ?? p.passage) || '';
    const cleaned = normalizeSpace(stripHtml(rawText));
    if (cleaned) texts.push(cleaned);
  }
  return texts.join('\n');
}

function extractOptions(question: Record<string, unknown>): Record<string, string> {
  const rawOptions = isObject(question.options) ? (question.options as Record<string, unknown>) : {};
  const options: Record<string, string> = {};
  for (const key of Object.keys(rawOptions)) {
    const value = toText(rawOptions[key]);
    if (!value) continue;
    options[key] = sanitizeOptionText(key, value);
  }
  return options;
}

function buildBlankMarkerCandidates(rawQuestionText: string, questionLabel: string): string[] {
  const labels = new Set<string>();
  const questionText = String(rawQuestionText || '').trim();
  const labelText = String(questionLabel || '').trim();

  if (isOnlyBlankMarker(questionText)) {
    const markerDigits = extractDigits(questionText);
    if (markerDigits) labels.add(markerDigits);
  } else if (labelText) {
    labels.add(labelText);
    const digits = extractDigits(labelText);
    if (digits) labels.add(digits);
  }

  if (!labels.size) return [];
  const out = new Set<string>();
  for (const label of labels) {
    out.add(`(${label})`);
    out.add(`\uFF08${label}\uFF09`);
  }
  return Array.from(out);
}

function extractSentenceAroundBlank(passageText: string, markers: string[]): string {
  if (!passageText || !markers.length) return '';
  let markerIndex = -1;
  let markerValue = '';
  for (const marker of markers) {
    const index = passageText.indexOf(marker);
    if (index >= 0 && (markerIndex < 0 || index < markerIndex)) {
      markerIndex = index;
      markerValue = marker;
    }
  }
  if (markerIndex < 0 || !markerValue) return '';
  const start = findSentenceStart(passageText, markerIndex);
  const end = findSentenceEnd(passageText, markerIndex + markerValue.length);
  return normalizeSpace(passageText.slice(start, end));
}

function findSentenceStart(text: string, index: number): number {
  for (let i = index - 1; i >= 0; i -= 1) {
    const ch = text[i];
    if (
      ch === '\n' ||
      ch === '\u3002' ||
      ch === '\uFF61' ||
      ch === '\uFF0E' ||
      ch === '\uFF01' ||
      ch === '\uFF1F' ||
      ch === '!' ||
      ch === '?'
    ) {
      return i + 1;
    }
  }
  return 0;
}

function findSentenceEnd(text: string, index: number): number {
  for (let i = index; i < text.length; i += 1) {
    const ch = text[i];
    if (
      ch === '\n' ||
      ch === '\u3002' ||
      ch === '\uFF61' ||
      ch === '\uFF0E' ||
      ch === '\uFF01' ||
      ch === '\uFF1F' ||
      ch === '!' ||
      ch === '?'
    ) {
      return i + 1;
    }
  }
  return text.length;
}

function isOnlyBlankMarker(text: string): boolean {
  if (!text) return false;
  const normalized = text.replace(/\s+/g, '');
  return /^[()\uFF08]?\d{1,3}[)\uFF09]?[.．。、]?$/.test(normalized);
}

function extractDigits(value: string): string {
  const normalized = toAsciiDigitsLocal(String(value || ''));
  const m = normalized.match(/\d+/);
  return m ? String(Number(m[0])) : '';
}

function sanitizeOptionText(optionKey: string, input: string): string {
  const cleaned = normalizeSpace(stripHtml(input));
  const key = String(optionKey || '').trim();
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return cleaned
    .replace(/^[\s\u3000]*[0-9０-９]+[\s\u3000]*[.)．。､、:：\-－ー]?\s*/u, '')
    .replace(new RegExp(`^[\\s\\u3000]*${escapedKey}[\\s\\u3000]*[.)．。､、:：\\-－ー]?\\s*`, 'u'), '')
    .trim();
}

function stripHtml(input: string): string {
  return input
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizeSpace(input: string): string {
  return input
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

function toAsciiDigitsLocal(value: string): string {
  return String(value || '').replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0));
}

function toText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str.length ? str : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
