import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';

export function createGrammarRouter() {
  const router = Router();

  router.get('/', async (req: Request, res: Response) => {
    const level = String(req.query.level || 'N5');
    const rows = await prisma.grammar.findMany({
      where: { level },
      orderBy: { grammar_id: 'asc' },
    });
    return res.json(rows);
  });

  router.get('/:id', async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid grammar id' });

    const grammar = await prisma.grammar.findUnique({ where: { grammar_id: BigInt(id) } });
    const usages = await prisma.grammarUsage.findMany({
      where: { grammar_id: BigInt(id) },
      orderBy: { usage_id: 'asc' },
    });

    return res.json({ grammar, usages });
  });

  return router;
}
