import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { requireAdmin } from '../middleware/adminGuard';

const PATCH_FIELDS = [
  'word_ja',
  'word_hira_kana',
  'word_romaji',
  'word_vi',
  'example_ja',
  'example_vi',
  'topic',
  'level',
  'image_url',
  'audio_url',
  'core_order',
] as const;

type PatchKey = (typeof PATCH_FIELDS)[number];
type VocabSuggestionResult = {
  suggested: Record<string, unknown>;
  imageQuery: string;
  audioQuery: string;
  mode: string;
  provider: string;
  model?: string;
  warning?: string;
};
type OpenAIChatResponse = { choices?: Array<{ message?: { content?: string } }> };

export function createAdminVocabularyRouter() {
  const router = Router();

  router.get('/', async (req: Request, res: Response) => {
    await requireAdmin(req);
    const keyword = String(req.query.keyword || '').trim();
    const topic = String(req.query.topic || '').trim();
    const level = String(req.query.level || '').trim();
    const page = Math.max(Number(req.query.page || 0), 0);
    const size = Math.min(Math.max(Number(req.query.size || 20), 1), 200);

    const rows = await prisma.vocabulary.findMany({
      where: {
        ...(keyword
          ? {
              OR: [
                { word_ja: { contains: keyword, mode: 'insensitive' } },
                { word_hira_kana: { contains: keyword, mode: 'insensitive' } },
                { word_romaji: { contains: keyword, mode: 'insensitive' } },
                { word_vi: { contains: keyword, mode: 'insensitive' } },
              ],
            }
          : {}),
        ...(topic ? { topic } : {}),
        ...(level ? { level } : {}),
      },
      orderBy: { id: 'desc' },
      skip: page * size,
      take: size,
    });
    return res.json(rows);
  });

  router.get('/:id', async (req: Request, res: Response) => {
    await requireAdmin(req);
    const id = Number(req.params.id);
    const vocab = await prisma.vocabulary.findUnique({ where: { id: BigInt(id) } });
    if (!vocab) return res.status(404).json({ message: 'Vocabulary not found' });
    return res.json(vocab);
  });

  router.post('/', async (req: Request, res: Response) => {
    await requireAdmin(req);
    const data = toPatch(req.body || {});
    const created = await prisma.vocabulary.create({ data: data as any });
    return res.json(created);
  });

  router.put('/:id', async (req: Request, res: Response) => {
    await requireAdmin(req);
    const id = Number(req.params.id);
    const existing = await prisma.vocabulary.findUnique({ where: { id: BigInt(id) } });
    if (!existing) return res.status(404).json({ message: 'Vocabulary not found' });

    const data = toPatch(req.body || {}, true);
    const updated = await prisma.vocabulary.update({ where: { id: BigInt(id) }, data: data as any });
    return res.json(updated);
  });

  router.post('/:id/ai-suggest', async (req: Request, res: Response) => {
    await requireAdmin(req);
    const id = Number(req.params.id);
    const vocab = await prisma.vocabulary.findUnique({ where: { id: BigInt(id) } });
    if (!vocab) return res.status(404).json({ message: 'Vocabulary not found' });
    const mode = String(req.body?.mode || req.query?.mode || 'fix').trim() || 'fix';
    const result = await suggestVocabularyWithAi(vocab, mode);
    return res.json(result);
  });

  router.put('/:id/apply', async (req: Request, res: Response) => {
    await requireAdmin(req);
    const id = Number(req.params.id);
    const existing = await prisma.vocabulary.findUnique({ where: { id: BigInt(id) } });
    if (!existing) return res.status(404).json({ message: 'Vocabulary not found' });
    const data = toPatch(req.body || {});
    if (!Object.keys(data).length) return res.status(400).json({ message: 'No supported fields to apply' });
    const updated = await prisma.vocabulary.update({ where: { id: BigInt(id) }, data: data as any });
    return res.json(updated);
  });

  router.post('/ai-suggest/bulk', async (req: Request, res: Response) => {
    await requireAdmin(req);
    const keyword = String(req.query.keyword || '').trim();
    const topic = String(req.query.topic || '').trim();
    const level = String(req.query.level || '').trim();
    const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
    const rows = await prisma.vocabulary.findMany({
      where: {
        ...(keyword
          ? {
              OR: [
                { word_ja: { contains: keyword, mode: 'insensitive' } },
                { word_hira_kana: { contains: keyword, mode: 'insensitive' } },
                { word_romaji: { contains: keyword, mode: 'insensitive' } },
                { word_vi: { contains: keyword, mode: 'insensitive' } },
              ],
            }
          : {}),
        ...(topic ? { topic } : {}),
        ...(level ? { level } : {}),
      },
      orderBy: { id: 'desc' },
      take: limit,
    });
    const fields = Array.isArray(req.body?.fields) ? (req.body.fields as string[]) : [];
    const items = rows.map((row: any) => {
      const suggested: Record<string, unknown> = {};
      for (const field of fields) {
        if ((PATCH_FIELDS as readonly string[]).includes(field)) {
          suggested[field] = (row as unknown as Record<string, unknown>)[field];
        }
      }
      return {
        id: Number(row.id),
        original: row,
        suggested,
        confidence: 0.9,
        notes: 'local suggestion',
      };
    });
    return res.json({ success: true, items, errors: [] });
  });

  router.post('/apply/bulk', async (req: Request, res: Response) => {
    await requireAdmin(req);
    const updates = Array.isArray(req.body?.updates) ? req.body.updates : [];
    let updated = 0;
    const failed: Array<{ id: number | null; message: string }> = [];

    for (const update of updates) {
      const id = Number(update?.id);
      if (!Number.isFinite(id)) {
        failed.push({ id: null, message: 'Missing id' });
        continue;
      }
      const patch = toPatch(update?.patch || {});
      if (!Object.keys(patch).length) {
        failed.push({ id, message: 'Empty patch' });
        continue;
      }
      try {
        await prisma.vocabulary.update({ where: { id: BigInt(id) }, data: patch as any });
        updated += 1;
      } catch (error) {
        failed.push({ id, message: (error as Error).message });
      }
    }
    return res.json({ success: failed.length === 0, updated, failed });
  });

  return router;
}

function toPatch(payload: Record<string, unknown>, includeEmpty = false): Record<string, any> {
  const out: Record<string, any> = {};
  for (const key of PATCH_FIELDS) {
    if (!(key in payload)) continue;
    const value = payload[key];
    if (value === null || value === undefined) continue;
    if (key === 'core_order') {
      const n = Number(value);
      if (Number.isFinite(n)) out[key] = n;
      continue;
    }
    const text = String(value);
    if (!includeEmpty && !text.trim().length) continue;
    out[key] = text;
  }
  return out;
}

function buildLocalSuggestion(vocab: any, mode = 'fix', warning?: string): VocabSuggestionResult {
  return {
    suggested: {
      word_ja: vocab.word_ja,
      word_hira_kana: vocab.word_hira_kana,
      word_romaji: vocab.word_romaji,
      word_vi: vocab.word_vi,
      example_ja: vocab.example_ja,
      example_vi: vocab.example_vi,
      topic: vocab.topic,
      level: vocab.level,
      image_url: vocab.image_url,
      audio_url: vocab.audio_url,
      core_order: vocab.core_order,
    },
    imageQuery: String(vocab.word_ja || vocab.word_vi || '').trim(),
    audioQuery: String(vocab.word_ja || vocab.word_hira_kana || '').trim(),
    mode,
    provider: 'local',
    ...(warning ? { warning } : {}),
  };
}

async function suggestVocabularyWithAi(vocab: any, mode = 'fix'): Promise<VocabSuggestionResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_VOCAB_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  if (!apiKey) {
    return buildLocalSuggestion(vocab, mode, 'OPENAI_API_KEY is not configured. Using local fallback.');
  }

  const base = buildLocalSuggestion(vocab, mode);
  const payload = {
    word_ja: base.suggested.word_ja,
    word_hira_kana: base.suggested.word_hira_kana,
    word_romaji: base.suggested.word_romaji,
    word_vi: base.suggested.word_vi,
    example_ja: base.suggested.example_ja,
    example_vi: base.suggested.example_vi,
    topic: base.suggested.topic,
    level: base.suggested.level,
    image_url: base.suggested.image_url,
    audio_url: base.suggested.audio_url,
    core_order: base.suggested.core_order,
  };

  const systemPrompt =
    'You fix Japanese vocabulary records for a study app. Return only strict JSON. ' +
    'Preserve meaning. Keep Japanese fields natural and correct. Do not invent random facts. ' +
    'When example_ja contains ruby/furigana, verify reading must match sentence context.';
  const userPrompt = `
mode: ${mode}
current_record:
${JSON.stringify(payload, null, 2)}

Return JSON only in this shape:
{
  "suggested": {
    "word_ja": "...",
    "word_hira_kana": "...",
    "word_romaji": "...",
    "word_vi": "...",
    "example_ja": "...",
    "example_vi": "...",
    "topic": "...",
    "level": "...",
    "image_url": "...",
    "audio_url": "...",
    "core_order": 123
  },
  "imageQuery": "...",
  "audioQuery": "..."
}
Rules:
- Keep empty string for unknown optional fields.
- Keep core_order numeric when available.
- Keep output concise and safe for learners.
- Validate ruby/furigana in example_ja by sentence context.
- Keep ruby HTML valid: <ruby>漢字<rt>かな</rt></ruby>.
- If a word has multiple readings (e.g. 日本), choose reading that fits the actual phrase in example_ja.
`.trim();

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      return buildLocalSuggestion(vocab, mode, `OpenAI request failed (${response.status}): ${detail}`);
    }

    const data = (await response.json()) as OpenAIChatResponse;
    const content = String(data?.choices?.[0]?.message?.content || '').trim();
    if (!content) {
      return buildLocalSuggestion(vocab, mode, 'OpenAI returned empty content. Using local fallback.');
    }

    const parsed = JSON.parse(content) as any;
    const rawSuggested = parsed?.suggested ?? parsed ?? {};
    const patched = toPatch(rawSuggested, true);
    const suggested: Record<string, unknown> = { ...base.suggested, ...patched };
    return {
      suggested,
      imageQuery: String(parsed?.imageQuery || base.imageQuery || '').trim(),
      audioQuery: String(parsed?.audioQuery || base.audioQuery || '').trim(),
      mode,
      provider: 'openai',
      model,
    };
  } catch (error) {
    return buildLocalSuggestion(
      vocab,
      mode,
      `OpenAI parsing/runtime error: ${(error as Error)?.message || 'unknown error'}`,
    );
  }
}
