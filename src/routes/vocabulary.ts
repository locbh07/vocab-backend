import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { requireAdmin } from '../middleware/adminGuard';

const ALLOWED_PREFIXES = new Set([
  '3000_common_',
  '1000_N5_',
  '1500_N4_',
  '2000_N3_',
  '2500_N2_',
  '3000_N1_',
]);
const ALLOWED_TRACKS = new Set(['core', 'book']);

type VocabTrack = 'core' | 'book';

function normalizePrefix(value: unknown): string {
  const prefix = String(value || '3000_common_').trim();
  return ALLOWED_PREFIXES.has(prefix) ? prefix : '3000_common_';
}

function normalizeTrack(value: unknown): VocabTrack {
  const track = String(value || 'core').trim().toLowerCase();
  return ALLOWED_TRACKS.has(track) ? (track as VocabTrack) : 'core';
}

function cleanText(value: unknown): string {
  return String(value || '').trim();
}

function normalizeBoolean(value: unknown): boolean {
  const text = String(value || '').trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'yes' || text === 'on';
}

export function createVocabularyRouter() {
  const router = Router();

  router.get('/all', async (req: Request, res: Response) => {
    const track = normalizeTrack(req.query.track);
    const prefix = normalizePrefix(req.query.prefix);
    const sourceBook = cleanText(req.query.sourceBook);
    const sourceUnit = cleanText(req.query.sourceUnit);
    const level = cleanText(req.query.level);
    const includeExamples = normalizeBoolean(req.query.includeExamples);

    const where: Prisma.VocabularyWhereInput =
      track === 'core'
        ? { track: 'core', topic: { startsWith: prefix } }
        : {
            track: 'book',
            ...(sourceBook ? { source_book: sourceBook } : {}),
            ...(sourceUnit ? { source_unit: sourceUnit } : {}),
            ...(level ? { level } : {}),
          };

    const orderBy: Prisma.VocabularyOrderByWithRelationInput[] =
      track === 'core'
        ? [{ id: 'asc' }]
        : [{ source_book: 'asc' }, { source_unit: 'asc' }, { id: 'asc' }];

    const rows = await prisma.vocabulary.findMany({ where, orderBy });
    if (!includeExamples || !rows.length) {
      return res.json(rows);
    }

    const vocabIds = rows.map((row) => Number(row.id)).filter(Number.isFinite);
    const examples = await prisma.$queryRaw<Array<{
      vocab_id: bigint | number;
      order_index: number;
      example_ja: string | null;
      example_vi: string | null;
    }>>(
      Prisma.sql`
        SELECT vocab_id, order_index, example_ja, example_vi
        FROM vocabulary_example
        WHERE vocab_id IN (${Prisma.join(vocabIds)})
        ORDER BY vocab_id ASC, order_index ASC
      `,
    );

    const byVocabId = new Map<number, Array<{ order_index: number; example_ja: string | null; example_vi: string | null }>>();
    for (const ex of examples) {
      const id = Number(ex.vocab_id);
      const list = byVocabId.get(id) || [];
      list.push({
        order_index: Number(ex.order_index),
        example_ja: ex.example_ja,
        example_vi: ex.example_vi,
      });
      byVocabId.set(id, list);
    }

    return res.json(
      rows.map((row) => ({
        ...row,
        examples: byVocabId.get(Number(row.id)) || [],
      })),
    );
  });

  router.get('/topics', async (req: Request, res: Response) => {
    const track = normalizeTrack(req.query.track);
    const prefix = normalizePrefix(req.query.prefix);
    const sourceBook = cleanText(req.query.sourceBook);
    const sourceUnit = cleanText(req.query.sourceUnit);
    const level = cleanText(req.query.level);

    const predicates: Prisma.Sql[] = [Prisma.sql`track = ${track}`];
    if (track === 'core') {
      predicates.push(Prisma.sql`topic LIKE ${prefix + '%'}`);
    } else {
      if (sourceBook) predicates.push(Prisma.sql`source_book = ${sourceBook}`);
      if (sourceUnit) predicates.push(Prisma.sql`source_unit = ${sourceUnit}`);
      if (level) predicates.push(Prisma.sql`level = ${level}`);
    }

    const whereClause = Prisma.join(predicates, ' AND ');
    const rows = await prisma.$queryRaw<Array<{ topic: string | null }>>(
      Prisma.sql`
        SELECT topic
        FROM vocabulary
        WHERE ${whereClause}
        GROUP BY topic
        ORDER BY MIN(id) ASC
      `,
    );

    return res.json(rows.map((r) => String(r.topic || '')).filter(Boolean));
  });

  router.get('/books', async (req: Request, res: Response) => {
    const level = cleanText(req.query.level);
    const predicates: Prisma.Sql[] = [Prisma.sql`track = 'book'`, Prisma.sql`source_book IS NOT NULL`];
    if (level) predicates.push(Prisma.sql`level = ${level}`);
    const whereClause = Prisma.join(predicates, ' AND ');
    const rows = await prisma.$queryRaw<Array<{ source_book: string | null }>>(
      Prisma.sql`
        SELECT source_book
        FROM vocabulary
        WHERE ${whereClause}
        GROUP BY source_book
        ORDER BY source_book ASC
      `,
    );
    return res.json(rows.map((r) => String(r.source_book || '')).filter(Boolean));
  });

  router.get('/units', async (req: Request, res: Response) => {
    const sourceBook = cleanText(req.query.sourceBook);
    if (!sourceBook) return res.status(400).json({ message: 'sourceBook is required' });

    const rows = await prisma.$queryRaw<Array<{ source_unit: string | null }>>(
      Prisma.sql`
        SELECT source_unit
        FROM vocabulary
        WHERE track = 'book'
          AND source_book = ${sourceBook}
          AND source_unit IS NOT NULL
        GROUP BY source_unit
        ORDER BY source_unit ASC
      `,
    );

    return res.json(rows.map((r) => String(r.source_unit || '')).filter(Boolean));
  });

  router.get('/count', async (req: Request, res: Response) => {
    const track = normalizeTrack(req.query.track);
    const sourceBook = cleanText(req.query.sourceBook);
    const sourceUnit = cleanText(req.query.sourceUnit);
    const level = cleanText(req.query.level);
    const prefix = String(req.query.prefix || '').trim();

    if (track === 'core' && !prefix) {
      const count = await prisma.vocabulary.count({ where: { track: 'core', core_order: { not: null } } });
      return res.json({ count });
    }

    const where: Prisma.VocabularyWhereInput =
      track === 'core'
        ? { track: 'core', topic: { startsWith: normalizePrefix(prefix) } }
        : {
            track: 'book',
            ...(sourceBook ? { source_book: sourceBook } : {}),
            ...(sourceUnit ? { source_unit: sourceUnit } : {}),
            ...(level ? { level } : {}),
          };

    const count = await prisma.vocabulary.count({ where });
    return res.json({ count });
  });

  router.patch('/:id', async (req: Request, res: Response) => {
    await requireAdmin(req);
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
    const existing = await prisma.vocabulary.findUnique({ where: { id: BigInt(id) } });
    if (!existing) return res.status(404).json({ message: `Vocabulary not found: ${id}` });

    const body = req.body || {};
    const data = {
      word_ja: pick(body.word_ja, existing.word_ja),
      word_hira_kana: pick(body.word_hira_kana, existing.word_hira_kana),
      word_romaji: pick(body.word_romaji, existing.word_romaji),
      word_vi: pick(body.word_vi, existing.word_vi),
      example_ja: pick(body.example_ja, existing.example_ja),
      example_vi: pick(body.example_vi, existing.example_vi),
      topic: pick(body.topic, existing.topic),
      level: pick(body.level, existing.level),
      image_url: pick(body.image_url, existing.image_url),
      audio_url: pick(body.audio_url, existing.audio_url),
      core_order: body.core_order === undefined ? existing.core_order : Number(body.core_order),
      track: body.track === undefined ? existing.track : normalizeTrack(body.track),
      source_book: pick(body.source_book, existing.source_book),
      source_unit: pick(body.source_unit, existing.source_unit),
    };

    const updated = await prisma.vocabulary.update({ where: { id: BigInt(id) }, data });
    return res.json(updated);
  });

  return router;
}

function pick(incoming: unknown, current: string | null): string | null {
  if (incoming === undefined || incoming === null) return current;
  const text = String(incoming);
  return text.trim().length ? text : current;
}
