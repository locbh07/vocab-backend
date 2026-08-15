import crypto from 'node:crypto';
import type { Request } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { generateGeminiJson } from './gemini';

export const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  zh: 'Chinese (Simplified)',
  ko: 'Korean',
  pt: 'Portuguese (Brazil)',
  id: 'Indonesian',
  ne: 'Nepali',
  my: 'Burmese',
  fil: 'Filipino',
};

// Shared across every route that serves translatable content — keep this Set in sync with
// LANGUAGE_NAMES above (and with frontend `SUPPORTED_LANGUAGES` in utils/language.js) when
// adding a new language.
const SUPPORTED_CONTENT_LANGUAGES = new Set(['vi', 'en', 'zh', 'ko', 'pt', 'id', 'ne', 'my', 'fil']);

export function resolveRequestLanguage(req: Request): string {
  const raw = String(req.query.language ?? req.headers['x-language'] ?? 'vi').trim().toLowerCase();
  return SUPPORTED_CONTENT_LANGUAGES.has(raw) ? raw : 'vi';
}

function translateModel(): string {
  return process.env.GEMINI_TRANSLATE_MODEL || 'gemini-3.5-flash-lite';
}

function hashSource(parts: Array<string | null | undefined>): string {
  return crypto
    .createHash('sha256')
    .update(parts.map((p) => p ?? '').join(''))
    .digest('hex');
}

const VIETNAMESE_DIACRITICS =
  /[ăâêôơưđáàảãạắằẳẵặấầẩẫậéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i;

// A field "looks untranslated" if the model echoed the Vietnamese source back
// unchanged, or (for non-Vietnamese targets) still contains Vietnamese diacritics.
function looksUntranslated(value: string, source: string | null | undefined, language: string): boolean {
  if (!source || !source.trim()) return false;
  if (value.trim() === source.trim()) return true;
  return language !== 'vi' && VIETNAMESE_DIACRITICS.test(value);
}

async function callTranslateOnce(
  languageName: string,
  fields: Record<string, string | null>,
): Promise<Record<string, unknown>> {
  const fieldNames = Object.keys(fields);
  const { json } = await generateGeminiJson({
    systemInstruction:
      `You translate short Vietnamese-language dictionary content for a Japanese-language learning app into ${languageName}. ` +
      `Each item has an id and one or more Vietnamese text fields. Translate ONLY those fields to natural, concise ${languageName}, ` +
      'suitable for a vocabulary/grammar dictionary entry. ' +
      'Do NOT translate, transliterate, or alter any Japanese text if it appears embedded in a field. ' +
      'Do NOT substitute a different example you may recall for this word — translate exactly the text given. ' +
      'If a field is null or empty in the input, return it as null in the output — do not invent content. ' +
      'Return strict JSON: {"items":[{"id": <same id>, ' +
      fieldNames.map((f) => `"${f}": "..."`).join(', ') +
      '}]}.',
    prompt: JSON.stringify({ items: [{ id: 1, ...fields }] }),
    model: translateModel(),
  });
  const items = Array.isArray((json as any)?.items) ? (json as any).items : [];
  return (items[0] && typeof items[0] === 'object' ? items[0] : {}) as Record<string, unknown>;
}

// Mirrors the items-array framing from scripts/batch-translate-content.cjs, which was
// validated against ~47k real rows: a flat single-object prompt turned out to be
// noticeably less reliable for gemini-3.5-flash-lite (it would sometimes echo the
// Vietnamese source back untranslated, or substitute a memorized Japanese example for
// a well-known vocab item instead of translating the given text). The array/id framing
// anchors the model far more consistently, but for a single-item call it can still
// occasionally leave one field untranslated — so retry once if that's detected.
async function translateFields(
  languageName: string,
  language: string,
  fields: Record<string, string | null>,
): Promise<Record<string, string | null>> {
  const fieldNames = Object.keys(fields);
  const isUntranslated = (result: Record<string, unknown>) =>
    fieldNames.some((key) => {
      const value = result[key];
      return typeof value === 'string' && looksUntranslated(value, fields[key], language);
    });

  let result = await callTranslateOnce(languageName, fields);
  for (let attempt = 0; attempt < 2 && isUntranslated(result); attempt += 1) {
    result = await callTranslateOnce(languageName, fields);
  }

  const out: Record<string, string | null> = {};
  for (const key of fieldNames) {
    const value = result[key];
    out[key] = typeof value === 'string' && value.trim() ? value : null;
  }
  return out;
}

// Fire-and-forget: called after a Vietnamese vocabulary row is created/updated
// so its translations stay in sync without a manual re-run of the batch script.
// Errors are only logged — this must never fail the request that triggered it.
export async function translateVocabularyItem(vocabId: bigint | number, language: string): Promise<void> {
  try {
    const vocab = await prisma.vocabulary.findUnique({ where: { id: BigInt(vocabId) } });
    if (!vocab || (!vocab.word_vi && !vocab.example_vi)) return;

    const sourceHash = hashSource([vocab.word_vi, vocab.example_vi]);
    const existing = await prisma.vocabularyTranslation.findUnique({
      where: { vocab_id_language: { vocab_id: BigInt(vocabId), language } },
    });
    if (existing && existing.source_hash === sourceHash) return;

    const languageName = LANGUAGE_NAMES[language] || language;
    const result = await translateFields(languageName, language, { word: vocab.word_vi, example: vocab.example_vi });

    await prisma.vocabularyTranslation.upsert({
      where: { vocab_id_language: { vocab_id: BigInt(vocabId), language } },
      update: { word: result.word, example: result.example, provider: 'gemini', source_hash: sourceHash },
      create: {
        vocab_id: BigInt(vocabId),
        language,
        word: result.word,
        example: result.example,
        provider: 'gemini',
        source_hash: sourceHash,
      },
    });
  } catch (error) {
    console.error(`[contentTranslation] translateVocabularyItem failed for id=${vocabId}, language=${language}:`, error);
  }
}

// Reference implementation of the read-side overlay pattern: read cached translations in
// bulk, splice `.word`/`.example` onto each row (keeping the same `word_vi`/`example_vi`
// field names so callers never need to change what they read), fire-and-forget any misses
// so they're cached for next time. Shared by every vocabulary-serving route (vocabulary.ts's
// `/all`, learning.ts's `/new-words` and `/reviews`) — don't reimplement this per route.
export async function overlayVocabularyTranslations(rows: any[], language: string): Promise<any[]> {
  if (language === 'vi' || !rows.length) return rows;

  const vocabIds = rows.map((row) => BigInt(row.id));
  const translations = await prisma.vocabularyTranslation.findMany({
    where: { vocab_id: { in: vocabIds }, language },
  });
  const byVocabId = new Map(translations.map((t) => [String(t.vocab_id), t]));

  return rows.map((row) => {
    const translation = byVocabId.get(String(row.id));
    if (!translation) {
      void translateVocabularyItem(row.id, language);
      return { ...row, translated: false };
    }
    return {
      ...row,
      word_vi: translation.word ?? row.word_vi,
      example_vi: translation.example ?? row.example_vi,
      translated: true,
    };
  });
}

// Same cache/fire-and-forget lookup as overlayVocabularyTranslations, but for callers that
// hand-wrote a SQL query selecting a bare `meaning` field (e.g. `v.word_vi AS meaning`)
// instead of full Vocabulary rows — the quiz endpoints in learning.ts do this. Returns a
// vocab_id -> translated meaning map; callers apply it themselves since the row shape varies.
export async function overlayVocabularyMeanings(
  items: Array<{ id: bigint | number; meaning: string | null }>,
  language: string,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (language === 'vi' || !items.length) return result;

  const ids = items.map((item) => BigInt(item.id));
  const translations = await prisma.vocabularyTranslation.findMany({
    where: { vocab_id: { in: ids }, language },
  });
  const byId = new Map(translations.map((t) => [String(t.vocab_id), t.word]));

  for (const item of items) {
    const translated = byId.get(String(item.id));
    if (translated) {
      result.set(String(item.id), translated);
    } else {
      void translateVocabularyItem(item.id, language);
    }
  }
  return result;
}

// Topics are shared strings across many vocabulary rows (e.g. "1000_N5_Ăn, uống"), not a
// per-row field — keyed by the raw topic text itself rather than a foreign key. Callers pass
// the already-fetched Vietnamese topic and get back the cached/freshly-translated string
// directly (unlike the per-row helpers above, which write through Prisma and return void) so
// a single request can await one topic without a second DB round-trip to re-read it.
// Core-track topics are stored as "{levelCode}_{Vietnamese category name}" (e.g.
// "1000_N5_Ăn, uống") — the frontend strips this exact literal prefix client-side in several
// places, so the translated string must keep the prefix byte-for-byte rather than trust the
// model not to touch it.
const TOPIC_PREFIX_RE = /^(\d+_[A-Za-z0-9]+_)/;

export async function translateVocabularyTopic(topic: string, language: string): Promise<string | null> {
  const trimmed = topic.trim();
  if (!trimmed) return null;

  const prefixMatch = trimmed.match(TOPIC_PREFIX_RE);
  const prefix = prefixMatch ? prefixMatch[1] : '';
  const body = prefixMatch ? trimmed.slice(prefix.length) : trimmed;

  try {
    const sourceHash = hashSource([trimmed]);
    const existing = await prisma.vocabularyTopicTranslation.findUnique({
      where: { topic_language: { topic: trimmed, language } },
    });
    if (existing && existing.source_hash === sourceHash) return existing.translation;

    const languageName = LANGUAGE_NAMES[language] || language;
    const result = await translateFields(languageName, language, { topic: body });
    const translated = result.topic ? `${prefix}${result.topic}` : null;

    await prisma.vocabularyTopicTranslation.upsert({
      where: { topic_language: { topic: trimmed, language } },
      update: { translation: translated, provider: 'gemini', source_hash: sourceHash },
      create: {
        topic: trimmed,
        language,
        translation: translated,
        provider: 'gemini',
        source_hash: sourceHash,
      },
    });
    return translated;
  } catch (error) {
    console.error(`[contentTranslation] translateVocabularyTopic failed for topic="${topic}", language=${language}:`, error);
    return null;
  }
}

export async function translateVocabularyExampleItem(vocabExampleId: bigint | number, language: string): Promise<void> {
  try {
    const example = await prisma.vocabularyExample.findUnique({ where: { id: BigInt(vocabExampleId) } });
    if (!example || !example.example_vi) return;

    const sourceHash = hashSource([example.example_vi]);
    const existing = await prisma.vocabularyExampleTranslation.findUnique({
      where: { vocab_example_id_language: { vocab_example_id: BigInt(vocabExampleId), language } },
    });
    if (existing && existing.source_hash === sourceHash) return;

    const languageName = LANGUAGE_NAMES[language] || language;
    const result = await translateFields(languageName, language, { example: example.example_vi });

    await prisma.vocabularyExampleTranslation.upsert({
      where: { vocab_example_id_language: { vocab_example_id: BigInt(vocabExampleId), language } },
      update: { example: result.example, provider: 'gemini', source_hash: sourceHash },
      create: {
        vocab_example_id: BigInt(vocabExampleId),
        language,
        example: result.example,
        provider: 'gemini',
        source_hash: sourceHash,
      },
    });
  } catch (error) {
    console.error(`[contentTranslation] translateVocabularyExampleItem failed for id=${vocabExampleId}, language=${language}:`, error);
  }
}

export async function translateGrammarItem(grammarId: bigint | number, language: string): Promise<void> {
  try {
    const grammar = await prisma.grammar.findUnique({ where: { grammar_id: BigInt(grammarId) } });
    if (!grammar || (!grammar.meaning_vi && !grammar.grammar_usage_text && !grammar.note)) return;

    const sourceHash = hashSource([grammar.meaning_vi, grammar.grammar_usage_text, grammar.note]);
    const existing = await prisma.grammarTranslation.findUnique({
      where: { grammar_id_language: { grammar_id: BigInt(grammarId), language } },
    });
    if (existing && existing.source_hash === sourceHash) return;

    const languageName = LANGUAGE_NAMES[language] || language;
    const result = await translateFields(languageName, language, {
      meaning: grammar.meaning_vi,
      usage_text: grammar.grammar_usage_text,
      note: grammar.note,
    });

    await prisma.grammarTranslation.upsert({
      where: { grammar_id_language: { grammar_id: BigInt(grammarId), language } },
      update: {
        meaning: result.meaning,
        usage_text: result.usage_text,
        note: result.note,
        provider: 'gemini',
        source_hash: sourceHash,
      },
      create: {
        grammar_id: BigInt(grammarId),
        language,
        meaning: result.meaning,
        usage_text: result.usage_text,
        note: result.note,
        provider: 'gemini',
        source_hash: sourceHash,
      },
    });
  } catch (error) {
    console.error(`[contentTranslation] translateGrammarItem failed for id=${grammarId}, language=${language}:`, error);
  }
}

export async function translateGrammarUsageItem(usageId: bigint | number, language: string): Promise<void> {
  try {
    const usage = await prisma.grammarUsage.findUnique({ where: { usage_id: BigInt(usageId) } });
    if (!usage || !usage.example_vi) return;

    const sourceHash = hashSource([usage.example_vi]);
    const existing = await prisma.grammarUsageTranslation.findUnique({
      where: { usage_id_language: { usage_id: BigInt(usageId), language } },
    });
    if (existing && existing.source_hash === sourceHash) return;

    const languageName = LANGUAGE_NAMES[language] || language;
    const result = await translateFields(languageName, language, { example: usage.example_vi });

    await prisma.grammarUsageTranslation.upsert({
      where: { usage_id_language: { usage_id: BigInt(usageId), language } },
      update: { example: result.example, provider: 'gemini', source_hash: sourceHash },
      create: {
        usage_id: BigInt(usageId),
        language,
        example: result.example,
        provider: 'gemini',
        source_hash: sourceHash,
      },
    });
  } catch (error) {
    console.error(`[contentTranslation] translateGrammarUsageItem failed for id=${usageId}, language=${language}:`, error);
  }
}

// site_contact_settings/site_contact_channel (see contactStore.ts) are a low-traffic,
// admin-edited singleton + a handful of channel rows — unlike vocabulary/grammar there's no
// list-rendering cost concern, so these translate synchronously on cache miss (a few seconds
// once per language per edit) instead of the fire-and-forget pattern used elsewhere. The
// GET /contact route caches the response for 60s, so this only runs on a cold cache.
let ensureContactTranslationTablePromise: Promise<void> | null = null;
async function ensureContactTranslationTable(): Promise<void> {
  if (!ensureContactTranslationTablePromise) {
    ensureContactTranslationTablePromise = prisma
      .$executeRawUnsafe(
        `
        CREATE TABLE IF NOT EXISTS site_contact_translation (
          scope VARCHAR(20) NOT NULL,
          ref_id BIGINT NOT NULL,
          language VARCHAR(8) NOT NULL,
          eyebrow TEXT,
          title TEXT,
          description TEXT,
          label TEXT,
          source_hash VARCHAR(64) NOT NULL,
          provider VARCHAR(20) NOT NULL DEFAULT 'gemini',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (scope, ref_id, language)
        )
      `,
      )
      .then(() => undefined)
      .catch((error) => {
        ensureContactTranslationTablePromise = null;
        throw error;
      });
  }
  return ensureContactTranslationTablePromise;
}

export async function translateContactSettings(
  settings: { eyebrow: string; title: string; description: string },
  language: string,
): Promise<{ eyebrow: string; title: string; description: string }> {
  if (language === 'vi') return settings;
  try {
    await ensureContactTranslationTable();
    const sourceHash = hashSource([settings.eyebrow, settings.title, settings.description]);
    const existing = await prisma.$queryRaw<
      Array<{ eyebrow: string | null; title: string | null; description: string | null; source_hash: string }>
    >`
      SELECT eyebrow, title, description, source_hash FROM site_contact_translation
      WHERE scope = 'settings' AND ref_id = 1 AND language = ${language}
      LIMIT 1
    `;
    const row = existing[0];
    if (row && row.source_hash === sourceHash) {
      return {
        eyebrow: row.eyebrow || settings.eyebrow,
        title: row.title || settings.title,
        description: row.description || settings.description,
      };
    }

    const languageName = LANGUAGE_NAMES[language] || language;
    const result = await translateFields(languageName, language, {
      eyebrow: settings.eyebrow,
      title: settings.title,
      description: settings.description,
    });

    await prisma.$executeRaw`
      INSERT INTO site_contact_translation (scope, ref_id, language, eyebrow, title, description, source_hash, provider, updated_at)
      VALUES ('settings', 1, ${language}, ${result.eyebrow}, ${result.title}, ${result.description}, ${sourceHash}, 'gemini', NOW())
      ON CONFLICT (scope, ref_id, language) DO UPDATE SET
        eyebrow = EXCLUDED.eyebrow, title = EXCLUDED.title, description = EXCLUDED.description,
        source_hash = EXCLUDED.source_hash, updated_at = NOW()
    `;

    return {
      eyebrow: result.eyebrow || settings.eyebrow,
      title: result.title || settings.title,
      description: result.description || settings.description,
    };
  } catch (error) {
    console.error(`[contentTranslation] translateContactSettings failed for language=${language}:`, error);
    return settings;
  }
}

export async function translateContactChannels<T extends { id: number; label: string }>(
  channels: T[],
  language: string,
): Promise<T[]> {
  if (language === 'vi' || !channels.length) return channels;
  await ensureContactTranslationTable();

  return Promise.all(
    channels.map(async (channel) => {
      try {
        const sourceHash = hashSource([channel.label]);
        const existing = await prisma.$queryRaw<Array<{ label: string | null; source_hash: string }>>`
          SELECT label, source_hash FROM site_contact_translation
          WHERE scope = 'channel' AND ref_id = ${BigInt(channel.id)} AND language = ${language}
          LIMIT 1
        `;
        const row = existing[0];
        if (row && row.source_hash === sourceHash) {
          return { ...channel, label: row.label || channel.label };
        }

        const languageName = LANGUAGE_NAMES[language] || language;
        const result = await translateFields(languageName, language, { label: channel.label });

        await prisma.$executeRaw`
          INSERT INTO site_contact_translation (scope, ref_id, language, label, source_hash, provider, updated_at)
          VALUES ('channel', ${BigInt(channel.id)}, ${language}, ${result.label}, ${sourceHash}, 'gemini', NOW())
          ON CONFLICT (scope, ref_id, language) DO UPDATE SET
            label = EXCLUDED.label, source_hash = EXCLUDED.source_hash, updated_at = NOW()
        `;

        return { ...channel, label: result.label || channel.label };
      } catch (error) {
        console.error(`[contentTranslation] translateContactChannels failed for channel=${channel.id}, language=${language}:`, error);
        return channel;
      }
    }),
  );
}

// kanji_compound (Pattern C — inline meaning_<lang> columns, raw-SQL table, see kanjiCompounds.ts)
// has no ORM model to bind a dynamic column name through, so the column identifier goes through
// Prisma.raw() — safe only because it's always looked up from this fixed allow-list, never taken
// from request input. Keep in sync with the ALTER TABLE columns in ensureKanjiCompoundTable().
const KANJI_COMPOUND_MEANING_COLUMNS: Record<string, string> = {
  en: 'meaning_en',
  zh: 'meaning_zh',
  ko: 'meaning_ko',
  pt: 'meaning_pt',
  id: 'meaning_id',
  ne: 'meaning_ne',
  my: 'meaning_my',
  fil: 'meaning_fil',
};

// Lazy, on-demand counterpart to scripts/backfill-kanji-compound-meaning-en.cjs — translates a
// single compound row's meaning on cache miss instead of requiring a bulk batch job up front.
// Deliberately synchronous (like translateContactSettings) rather than fire-and-forget: kanji
// compound lists are short (<=30 rows) and low-traffic enough that a first-request Gemini
// round-trip per untranslated row is an acceptable tradeoff for not needing a bulk backfill at
// all — this keeps Supabase storage growth proportional to what users actually browse, not to
// every row in the table times every supported language.
export async function translateKanjiCompoundMeaning(compoundId: bigint | number, language: string): Promise<string | null> {
  const column = KANJI_COMPOUND_MEANING_COLUMNS[language];
  if (!column) return null;
  try {
    const rows = await prisma.$queryRaw<Array<{ meaning_vi: string | null }>>`
      SELECT meaning_vi FROM kanji_compound WHERE id = ${BigInt(compoundId)} LIMIT 1
    `;
    const meaningVi = rows[0]?.meaning_vi;
    if (!meaningVi || !meaningVi.trim()) return null;

    const languageName = LANGUAGE_NAMES[language] || language;
    const result = await translateFields(languageName, language, { meaning: meaningVi });
    const translated = result.meaning;
    if (!translated) return null;

    const columnIdent = Prisma.raw(column);
    await prisma.$executeRaw`
      UPDATE kanji_compound SET ${columnIdent} = ${translated}, updated_at = NOW() WHERE id = ${BigInt(compoundId)}
    `;
    return translated;
  } catch (error) {
    console.error(`[contentTranslation] translateKanjiCompoundMeaning failed for id=${compoundId}, language=${language}:`, error);
    return null;
  }
}
