import { prisma } from './prisma';
import { toReadingHiragana, toRubyHtml } from './japaneseReading';

export type ReadingSentence = {
  sentence_ja: string;
  sentence_ruby_html: string;
  reading_hira: string;
};

export type QuestionReadingCache = {
  question_text_ja: string;
  question_ruby_html: string;
  question_reading_hira: string;
  option_readings: Record<string, string>;
  option_ruby_htmls: Record<string, string>;
  passage_text: string;
  passage_ruby_html: string;
  passage_reading_hira: string;
  sentence_readings: ReadingSentence[];
};

type CacheKey = {
  level: string;
  examId: string;
  part: number;
  sectionIndex: number;
  questionIndex: number;
};

type GetOrCreateArgs = CacheKey & {
  questionText: string;
  options: Record<string, string>;
  passageText: string;
  force?: boolean;
};

type CacheRow = {
  reading_json: unknown;
};

let ensureTablePromise: Promise<void> | null = null;

export async function getOrCreateQuestionReadingCache(args: GetOrCreateArgs): Promise<QuestionReadingCache> {
  await ensureExamReadingCacheTable();
  if (!args.force) {
    const cached = await getQuestionReadingCache(args);
    if (cached) return cached;
  }

  const built = await buildQuestionReadingCache({
    questionText: args.questionText,
    options: args.options,
    passageText: args.passageText,
  });
  await saveQuestionReadingCache(args, built);
  return built;
}

export async function getQuestionReadingCache(key: CacheKey): Promise<QuestionReadingCache | null> {
  const rows = await prisma.$queryRawUnsafe<Array<CacheRow>>(
    `
      SELECT reading_json
      FROM jlpt_exam_reading_cache
      WHERE level = $1
        AND exam_id = $2
        AND part = $3
        AND section_index = $4
        AND question_index = $5
      LIMIT 1
    `,
    key.level,
    key.examId,
    key.part,
    key.sectionIndex,
    key.questionIndex,
  );
  if (!rows.length) return null;
  return normalizeReadingCache(rows[0].reading_json);
}

export async function precomputeExamReadings(args: {
  level: string;
  examId: string;
  force?: boolean;
}): Promise<{ total: number; created: number; skipped: number }> {
  await ensureExamReadingCacheTable();
  const parts = await prisma.jlptExam.findMany({
    where: { level: args.level, exam_id: args.examId },
    orderBy: { part: 'asc' },
    select: { part: true, json_data: true },
  });

  let total = 0;
  let created = 0;
  let skipped = 0;

  for (const partRow of parts) {
    const json = (partRow.json_data || {}) as Record<string, unknown>;
    const sections = Array.isArray(json.sections) ? (json.sections as Array<Record<string, unknown>>) : [];
    for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
      const section = sections[sectionIndex] || {};
      const questions = Array.isArray(section.questions) ? (section.questions as Array<Record<string, unknown>>) : [];
      for (let questionIndex = 0; questionIndex < questions.length; questionIndex += 1) {
        total += 1;
        const question = questions[questionIndex] || {};
        const key: CacheKey = {
          level: args.level,
          examId: args.examId,
          part: partRow.part,
          sectionIndex,
          questionIndex,
        };
        if (!args.force) {
          const cached = await getQuestionReadingCache(key);
          if (cached) {
            skipped += 1;
            continue;
          }
        }

        const options = extractOptions(question);
        const questionText = normalizeSpace(stripHtml(toText(question.question_html ?? question.ques) || ''));
        const passageText = extractPassageText(json, question);
        const built = await buildQuestionReadingCache({
          questionText,
          options,
          passageText,
        });
        await saveQuestionReadingCache(key, built);
        created += 1;
      }
    }
  }

  return { total, created, skipped };
}

export async function precomputeLevelReadings(args: {
  level: string;
  force?: boolean;
}): Promise<{
  level: string;
  force: boolean;
  examCount: number;
  total: number;
  created: number;
  skipped: number;
  exams: Array<{ examId: string; total: number; created: number; skipped: number }>;
}> {
  await ensureExamReadingCacheTable();
  const level = String(args.level || '').trim();
  const force = Boolean(args.force);
  if (!level) {
    const err = new Error('Invalid level for reading precompute') as Error & { status?: number };
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
  const exams: Array<{ examId: string; total: number; created: number; skipped: number }> = [];
  let total = 0;
  let created = 0;
  let skipped = 0;

  for (const examId of examIds) {
    const summary = await precomputeExamReadings({ level, examId, force });
    exams.push({
      examId,
      ...summary,
    });
    total += summary.total;
    created += summary.created;
    skipped += summary.skipped;
  }

  return {
    level,
    force,
    examCount: exams.length,
    total,
    created,
    skipped,
    exams,
  };
}

export async function precomputeAllReadings(args?: {
  levels?: string[];
  force?: boolean;
}): Promise<{
  levels: string[];
  force: boolean;
  levelCount: number;
  total: number;
  created: number;
  skipped: number;
  summaries: Array<{
    level: string;
    examCount: number;
    total: number;
    created: number;
    skipped: number;
  }>;
}> {
  await ensureExamReadingCacheTable();
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
    total: number;
    created: number;
    skipped: number;
  }> = [];
  let total = 0;
  let created = 0;
  let skipped = 0;

  for (const level of levels) {
    const summary = await precomputeLevelReadings({ level, force });
    summaries.push({
      level,
      examCount: summary.examCount,
      total: summary.total,
      created: summary.created,
      skipped: summary.skipped,
    });
    total += summary.total;
    created += summary.created;
    skipped += summary.skipped;
  }

  return {
    levels,
    force,
    levelCount: summaries.length,
    total,
    created,
    skipped,
    summaries,
  };
}

async function buildQuestionReadingCache(args: {
  questionText: string;
  options: Record<string, string>;
  passageText: string;
}): Promise<QuestionReadingCache> {
  const questionText = String(args.questionText || '');
  const passageText = String(args.passageText || '');

  const question_ruby_html = await toRubyHtml(questionText);
  const question_reading_hira = await toReadingHiragana(questionText);

  const optionEntries = Object.entries(args.options || {});
  const option_readings = Object.fromEntries(
    await Promise.all(
      optionEntries.map(async ([option, value]) => [option, await toReadingHiragana(String(value || ''))] as const),
    ),
  );
  const option_ruby_htmls = Object.fromEntries(
    await Promise.all(
      optionEntries.map(async ([option, value]) => [option, await toRubyHtml(String(value || ''))] as const),
    ),
  );

  const passage_ruby_html = await toRubyHtml(passageText);
  const passage_reading_hira = await toReadingHiragana(passageText);

  const sentences = splitJapaneseSentences(passageText);
  const sentence_readings: ReadingSentence[] = await Promise.all(
    sentences.map(async (sentence) => ({
      sentence_ja: sentence,
      sentence_ruby_html: await toRubyHtml(sentence),
      reading_hira: await toReadingHiragana(sentence),
    })),
  );

  return {
    question_text_ja: questionText,
    question_ruby_html,
    question_reading_hira,
    option_readings,
    option_ruby_htmls,
    passage_text: passageText,
    passage_ruby_html,
    passage_reading_hira,
    sentence_readings,
  };
}

async function saveQuestionReadingCache(key: CacheKey, cache: QuestionReadingCache) {
  await prisma.$executeRawUnsafe(
    `
      INSERT INTO jlpt_exam_reading_cache (
        level, exam_id, part, section_index, question_index, reading_json, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW(), NOW())
      ON CONFLICT (level, exam_id, part, section_index, question_index)
      DO UPDATE SET
        reading_json = EXCLUDED.reading_json,
        updated_at = NOW()
    `,
    key.level,
    key.examId,
    key.part,
    key.sectionIndex,
    key.questionIndex,
    JSON.stringify(cache),
  );
}

async function ensureExamReadingCacheTable() {
  if (!ensureTablePromise) {
    ensureTablePromise = (async () => {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS jlpt_exam_reading_cache (
          id BIGSERIAL PRIMARY KEY,
          level VARCHAR(5) NOT NULL,
          exam_id VARCHAR(10) NOT NULL,
          part SMALLINT NOT NULL,
          section_index INT NOT NULL,
          question_index INT NOT NULL,
          reading_json JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await prisma.$executeRawUnsafe(`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_jlpt_exam_reading_cache_key
        ON jlpt_exam_reading_cache(level, exam_id, part, section_index, question_index);
      `);
    })().catch((error) => {
      ensureTablePromise = null;
      throw error;
    });
  }
  return ensureTablePromise;
}

function normalizeReadingCache(value: unknown): QuestionReadingCache {
  const row = isObject(value) ? value : {};
  const option_readings = asStringMap((row as Record<string, unknown>).option_readings);
  const option_ruby_htmls = asStringMap((row as Record<string, unknown>).option_ruby_htmls);
  const sentenceRows = Array.isArray((row as Record<string, unknown>).sentence_readings)
    ? ((row as Record<string, unknown>).sentence_readings as unknown[])
    : [];
  const sentence_readings: ReadingSentence[] = sentenceRows
    .map((item) => {
      if (!isObject(item)) return null;
      return {
        sentence_ja: toText((item as Record<string, unknown>).sentence_ja) || '',
        sentence_ruby_html: toText((item as Record<string, unknown>).sentence_ruby_html) || '',
        reading_hira: toText((item as Record<string, unknown>).reading_hira) || '',
      };
    })
    .filter((item): item is ReadingSentence => Boolean(item));

  return {
    question_text_ja: toText((row as Record<string, unknown>).question_text_ja) || '',
    question_ruby_html: toText((row as Record<string, unknown>).question_ruby_html) || '',
    question_reading_hira: toText((row as Record<string, unknown>).question_reading_hira) || '',
    option_readings,
    option_ruby_htmls,
    passage_text: toText((row as Record<string, unknown>).passage_text) || '',
    passage_ruby_html: toText((row as Record<string, unknown>).passage_ruby_html) || '',
    passage_reading_hira: toText((row as Record<string, unknown>).passage_reading_hira) || '',
    sentence_readings,
  };
}

function extractOptions(question: Record<string, unknown>): Record<string, string> {
  const rawOptions = isObject(question.options) ? (question.options as Record<string, unknown>) : {};
  const options: Record<string, string> = {};
  for (const key of Object.keys(rawOptions)) {
    const value = toText(rawOptions[key]);
    if (value) options[key] = sanitizeOptionText(key, value);
  }
  return options;
}

function extractPassageText(partJson: Record<string, unknown>, question: Record<string, unknown>): string {
  const passages = Array.isArray(partJson.passages) ? (partJson.passages as Array<Record<string, unknown>>) : [];
  if (!passages.length) return '';

  const rawPassageId = question.passage_id ?? question.pid;
  const ids = Array.isArray(rawPassageId) ? rawPassageId.map((item) => String(item)) : [String(rawPassageId ?? '')];
  const validIds = ids.filter((id) => id.length > 0);
  if (!validIds.length) return '';

  const texts: string[] = [];
  for (const passage of passages) {
    const passageId = String(passage.passage_id ?? passage.pid ?? '');
    if (!validIds.includes(passageId)) continue;
    const rawText = toText(passage.passage_html ?? passage.passage) || '';
    const cleaned = normalizeSpace(stripHtml(rawText));
    if (cleaned) texts.push(cleaned);
  }
  return texts.join('\n');
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

function sanitizeOptionText(optionKey: string, input: string): string {
  const cleaned = normalizeSpace(stripHtml(input));
  const key = String(optionKey || '').trim();
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return cleaned
    .replace(/^[\s\u3000]*[0-9０-９]+[\s\u3000]*[.)．。､、:：\-－ー]?\s*/u, '')
    .replace(new RegExp(`^[\\s\\u3000]*${escapedKey}[\\s\\u3000]*[.)．。､、:：\\-－ー]?\\s*`, 'u'), '')
    .trim();
}

function asStringMap(value: unknown): Record<string, string> {
  if (!isObject(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, row] of Object.entries(value)) {
    out[key] = toText(row) || '';
  }
  return out;
}

function toText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str.length ? str : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
