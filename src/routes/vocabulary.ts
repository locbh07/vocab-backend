import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';

export function createVocabularyRouter() {
  const router = Router();

  router.get('/all', async (req: Request, res: Response) => {
    const prefix = String(req.query.prefix || '3000_common_');
    const rows = await prisma.vocabulary.findMany({
      where: { topic: { startsWith: prefix } },
      orderBy: { id: 'asc' },
    });
    return res.json(rows);
  });

  router.get('/topics', async (req: Request, res: Response) => {
    const prefix = String(req.query.prefix || '3000_common_');
    const rows = await prisma.$queryRaw<Array<{ topic: string }>>`
      SELECT topic
      FROM vocabulary
      WHERE topic LIKE ${prefix + '%'}
      GROUP BY topic
      ORDER BY MIN(id) ASC
    `;
    return res.json(rows.map((r: { topic: string }) => r.topic));
  });

  router.get('/count', async (req: Request, res: Response) => {
    const prefix = String(req.query.prefix || '').trim();
    if (!prefix) {
      const count = await prisma.vocabulary.count({ where: { core_order: { not: null } } });
      return res.json({ count });
    }
    const count = await prisma.vocabulary.count({ where: { topic: { startsWith: prefix } } });
    return res.json({ count });
  });

  router.patch('/:id', async (req: Request, res: Response) => {
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
