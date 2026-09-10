import { prisma } from './prisma';
import { generateGeminiJson } from './gemini';

// Per-sentence kanji glossary for a reading passage.
//
// This deliberately lives outside jlpt_passage_explanation: adding a field to the explanation
// schema would mean bumping EXPLANATION_PROMPT_VERSION, which is part of the explanation cache
// key, which would throw away every explanation already generated. Keeping the glossary in its
// own table with its own version lets it be filled in behind existing explanations - the
// expensive part stays cached, only the cheap missing part is generated.
//
// The prompt here is small on purpose: it sees the sentences and nothing else - no options, no
// answers, no reasoning - so a glossary pass costs a fraction of a full explanation.

export type PassageVocabItem = {
  surface: string;
  reading_hira: string;
  meaning_vi: string;
};

export type PassageVocabSentence = {
  sentence_ja: string;
  vocab: PassageVocabItem[];
};

export type PassageVocab = {
  sentences: PassageVocabSentence[];
};

export type PassageVocabKey = {
  level: string;
  examId: string;
  part: number;
  sectionIndex: number;
  groupHash: string;
};

// Bump when the prompt or normalization changes and existing glossaries should be rebuilt.
export const PASSAGE_VOCAB_VERSION = 1;

const MAX_VOCAB_PER_SENTENCE = 24;
const VOCAB_TIMEOUT_MS = 60_000;

const VOCAB_SYSTEM_INSTRUCTION = [
  'Ban la giao vien JLPT chuyen soan bang tu vung cho bai doc.',
  'Chi liet ke tu that su xuat hien trong cau, khong tu bia them tu.',
  'Cach doc phai dung theo ngu canh cua cau, khong lay cach doc tu dien mac dinh.',
].join(' ');

let ensureTablePromise: Promise<void> | null = null;

export async function getCachedPassageVocab(key: PassageVocabKey): Promise<PassageVocab | null> {
  await ensurePassageVocabTable();
  const rows = await prisma.$queryRawUnsafe<Array<{ vocab_json: unknown }>>(
    `
      SELECT vocab_json
      FROM jlpt_passage_vocab
      WHERE level = $1
        AND exam_id = $2
        AND part = $3
        AND section_index = $4
        AND group_hash = $5
        AND vocab_version = $6
      LIMIT 1
    `,
    key.level,
    key.examId,
    key.part,
    key.sectionIndex,
    key.groupHash,
    PASSAGE_VOCAB_VERSION,
  );
  if (!rows.length) return null;
  return normalizePassageVocabRow(rows[0].vocab_json);
}

export async function generatePassageVocab(args: {
  level: string;
  sentences: string[];
}): Promise<{ vocab: PassageVocab; model: string }> {
  const sentences = (args.sentences || []).map((item) => String(item || '')).filter((item) => item.trim().length > 0);
  if (!sentences.length) {
    return { vocab: { sentences: [] }, model: 'skipped-empty' };
  }

  const prompt = buildPassageVocabPrompt(args.level, sentences);
  const result = await generateGeminiJson({
    systemInstruction: VOCAB_SYSTEM_INSTRUCTION,
    prompt,
    timeoutMs: VOCAB_TIMEOUT_MS,
  });

  // generateGeminiJson already parses when the model behaves; rawText is the fallback for the
  // times it wraps the object in prose or a code fence.
  const parsed = result.json ?? parseLooseJson(result.rawText);
  return {
    vocab: normalizeGeneratedVocab(parsed, sentences),
    model: result.model,
  };
}

export async function savePassageVocab(args: PassageVocabKey & { vocab: PassageVocab; sourceModel: string }) {
  await ensurePassageVocabTable();
  await prisma.$executeRawUnsafe(
    `
      INSERT INTO jlpt_passage_vocab (
        level, exam_id, part, section_index, group_hash, vocab_version,
        vocab_json, source_model, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, NOW(), NOW())
      ON CONFLICT (level, exam_id, part, section_index, group_hash, vocab_version)
      DO UPDATE SET
        vocab_json = EXCLUDED.vocab_json,
        source_model = EXCLUDED.source_model,
        updated_at = NOW()
    `,
    args.level,
    args.examId,
    args.part,
    args.sectionIndex,
    args.groupHash,
    PASSAGE_VOCAB_VERSION,
    JSON.stringify(args.vocab),
    args.sourceModel,
  );
}

export async function consumeNonAdminPassageVocabQuota(args: PassageVocabKey & { userId: number }): Promise<boolean> {
  await ensurePassageVocabTable();
  const affected = await prisma.$executeRawUnsafe(
    `
      INSERT INTO jlpt_passage_vocab_request_log (
        user_id, level, exam_id, part, section_index, group_hash, vocab_version, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      ON CONFLICT (user_id, level, exam_id, part, section_index, group_hash, vocab_version)
      DO NOTHING
    `,
    args.userId,
    args.level,
    args.examId,
    args.part,
    args.sectionIndex,
    args.groupHash,
    PASSAGE_VOCAB_VERSION,
  );
  return Number(affected) > 0;
}

function buildPassageVocabPrompt(level: string, sentences: string[]): string {
  const sentenceList = sentences.map((sentence, index) => `${index + 1}. ${sentence}`).join('\n');

  return [
    'Hay lap bang tu vung cho tung cau cua mot bai doc JLPT.',
    `Level: ${level || '(không ro)'}`,
    '',
    'Danh sach cau (giu nguyen thu tu, dung index de map):',
    sentenceList,
    '',
    'Yeu cau:',
    '1) Voi MOI cau, liet ke tat ca tu co chua kanji xuat hien trong cau do.',
    '2) Ngoai ra bo sung tu katakana quan trong hoac cum thanh ngu/ngu phap dang chu y neu co.',
    '3) surface BAT BUOC la chuoi xuat hien nguyen van trong cau, không được viet lai hay chia lai.',
    '4) Với động từ/tính từ đã chia, surface giữ nguyên cả đuôi chia xuất hiện trong câu (苦しんだ), reading_hira đọc đúng cả từ (くるしんだ). Không cắt thân từ hoặc thay bằng dạng từ điển không có trong câu.',
    '5) reading_hira phai la cach doc DUNG NGU CANH cua cau, viet bang hiragana.',
    '   Vi du: 日本 trong van ban thuong doc la "にほん" chu không phai "にっぽん".',
    '6) meaning_vi ngan gon (1 dong), dung nghia theo ngu canh cau do.',
    '7) Không lap lai cung mot surface hai lan trong cung mot cau.',
    `8) Toi da ${MAX_VOCAB_PER_SENTENCE} muc moi cau. Neu cau không co tu nao dang liet ke thi tra vocab la mang rong.`,
    '9) Phai tra du so cau bang so cau da cho, dung index tuong ung.',
    '',
    'Trả về JSON dung schema sau, không them key khac:',
    '{',
    '  "sentences": [',
    '    {',
    '      "index": 1,',
    '      "vocab": [',
    '        { "surface": "string", "reading_hira": "string", "meaning_vi": "string" }',
    '      ]',
    '    }',
    '  ]',
    '}',
  ].join('\n');
}

function normalizeGeneratedVocab(raw: unknown, sentences: string[]): PassageVocab {
  const byIndex = new Map<number, unknown>();
  if (isObject(raw) && Array.isArray((raw as Record<string, unknown>).sentences)) {
    ((raw as Record<string, unknown>).sentences as unknown[]).forEach((item, position) => {
      if (!isObject(item)) return;
      const declared = parsePositiveInt((item as Record<string, unknown>).index);
      // Fall back to array position when the model omits or mangles the index.
      const index = declared && declared <= sentences.length ? declared : position + 1;
      if (!byIndex.has(index)) byIndex.set(index, item);
    });
  }

  return {
    sentences: sentences.map((sentence, position) => ({
      sentence_ja: sentence,
      vocab: normalizeVocabItems(byIndex.get(position + 1), sentence),
    })),
  };
}

function normalizeVocabItems(value: unknown, sentence: string): PassageVocabItem[] {
  if (!isObject(value)) return [];
  const rows = Array.isArray((value as Record<string, unknown>).vocab)
    ? ((value as Record<string, unknown>).vocab as unknown[])
    : [];

  const seen = new Set<string>();
  const out: PassageVocabItem[] = [];
  for (const row of rows) {
    if (!isObject(row)) continue;
    const surface = text((row as Record<string, unknown>).surface);
    const meaning = text((row as Record<string, unknown>).meaning_vi);
    if (!surface || !meaning) continue;
    // The model occasionally invents a dictionary form that is not in the sentence. Those entries
    // are worse than useless in a glossary meant to be read alongside the text, so drop them.
    if (!sentence.includes(surface)) continue;
    if (seen.has(surface)) continue;
    seen.add(surface);
    out.push({
      surface,
      reading_hira: resolveReading(surface, text((row as Record<string, unknown>).reading_hira) || ''),
      meaning_vi: meaning,
    });
    if (out.length >= MAX_VOCAB_PER_SENTENCE) break;
  }
  return out;
}

function normalizePassageVocabRow(value: unknown): PassageVocab {
  if (!isObject(value)) return { sentences: [] };
  const rows = Array.isArray((value as Record<string, unknown>).sentences)
    ? ((value as Record<string, unknown>).sentences as unknown[])
    : [];
  const sentences: PassageVocabSentence[] = rows
    .map((item) => {
      if (!isObject(item)) return null;
      const sentenceJa = text((item as Record<string, unknown>).sentence_ja) || '';
      const vocabRows = Array.isArray((item as Record<string, unknown>).vocab)
        ? ((item as Record<string, unknown>).vocab as unknown[])
        : [];
      const vocab: PassageVocabItem[] = vocabRows
        .map((row) => {
          if (!isObject(row)) return null;
          const surface = text((row as Record<string, unknown>).surface);
          if (!surface) return null;
          return {
            surface,
            reading_hira: text((row as Record<string, unknown>).reading_hira) || '',
            meaning_vi: text((row as Record<string, unknown>).meaning_vi) || '',
          };
        })
        .filter((row): row is PassageVocabItem => Boolean(row));
      return { sentence_ja: sentenceJa, vocab };
    })
    .filter((item): item is PassageVocabSentence => Boolean(item));
  return { sentences };
}

// A reading only earns its place when it tells the reader something the surface does not. The
// model happily emits ファン as ふぁん and とは as とは, which is pure noise in a list meant to be
// skimmed, so redundant readings are dropped and the UI renders surface + meaning alone.
function resolveReading(surface: string, reading: string): string {
  const normalized = toHiragana(reading);
  if (!normalized) return '';
  if (!containsKanji(surface)) return '';
  if (normalized === toHiragana(surface)) return '';
  return normalized;
}

function containsKanji(input: string): boolean {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(input);
}

// The glossary is displayed next to hiragana readings elsewhere in the explanation, so katakana
// coming back from the model is folded to hiragana for consistency.
function toHiragana(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code >= 0x30a1 && code <= 0x30f6) {
      out += String.fromCharCode(code - 0x60);
    } else {
      out += input[i];
    }
  }
  return out;
}

function parseLooseJson(raw: string): unknown {
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function parsePositiveInt(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function ensurePassageVocabTable() {
  if (!ensureTablePromise) {
    ensureTablePromise = (async () => {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS jlpt_passage_vocab (
          id BIGSERIAL PRIMARY KEY,
          level TEXT NOT NULL,
          exam_id TEXT NOT NULL,
          part INT NOT NULL,
          section_index INT NOT NULL,
          group_hash TEXT NOT NULL,
          vocab_version INT NOT NULL DEFAULT 1,
          vocab_json JSONB NOT NULL,
          source_model TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await prisma.$executeRawUnsafe(`
        CREATE UNIQUE INDEX IF NOT EXISTS jlpt_passage_vocab_key_idx
        ON jlpt_passage_vocab (
          level, exam_id, part, section_index, group_hash, vocab_version
        )
      `);
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS jlpt_passage_vocab_request_log (
          id BIGSERIAL PRIMARY KEY,
          user_id BIGINT NOT NULL,
          level TEXT NOT NULL,
          exam_id TEXT NOT NULL,
          part INT NOT NULL,
          section_index INT NOT NULL,
          group_hash TEXT NOT NULL,
          vocab_version INT NOT NULL DEFAULT 1,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await prisma.$executeRawUnsafe(`
        CREATE UNIQUE INDEX IF NOT EXISTS jlpt_passage_vocab_request_log_key_idx
        ON jlpt_passage_vocab_request_log (
          user_id, level, exam_id, part, section_index, group_hash, vocab_version
        )
      `);
    })().catch((error) => {
      ensureTablePromise = null;
      throw error;
    });
  }
  return ensureTablePromise;
}
