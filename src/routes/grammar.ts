import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { toReadingHiragana, toRubyHtml } from '../lib/japaneseReading';

const PLACEHOLDER_PATTERNS = [
  'この文型',
  '例文です',
  'this sentence uses',
  'ví dụ minh họa',
  'vi du minh hoa',
  'ví dụ cho mẫu',
  'vi du cho mau',
];

function isPlaceholderUsage(exampleJa?: string | null, exampleVi?: string | null) {
  const text = `${String(exampleJa || '')} ${String(exampleVi || '')}`.toLowerCase();
  return PLACEHOLDER_PATTERNS.some((pattern) => text.includes(pattern));
}

export function createGrammarRouter() {
  const router = Router();

  router.get('/', async (req: Request, res: Response) => {
    const level = String(req.query.level || 'N5');
    const track = String(req.query.track || '').trim().toLowerCase();
    const sourceBook = String(req.query.sourceBook || '').trim();
    const sourceUnit = String(req.query.sourceUnit || '').trim();

    // Use raw SQL for compatibility when Prisma client is not regenerated yet.
    const predicates: Prisma.Sql[] = [Prisma.sql`level = ${level}`];
    if (track === 'core' || track === 'supplemental') {
      predicates.push(Prisma.sql`track = ${track}`);
    }
    if (sourceBook) {
      predicates.push(Prisma.sql`source_book = ${sourceBook}`);
    }
    if (sourceUnit) {
      predicates.push(Prisma.sql`source_unit = ${sourceUnit}`);
    }

    try {
      const whereSql = predicates.length
        ? Prisma.sql`WHERE ${Prisma.join(predicates, ' AND ')}`
        : Prisma.sql``;
      const rows = await prisma.$queryRaw(
        Prisma.sql`
          SELECT *
          FROM grammar
          ${whereSql}
          ORDER BY COALESCE(priority, 2147483647) ASC, grammar_id ASC
        `,
      );
      return res.json(rows);
    } catch (_err) {
      const rows = await prisma.grammar.findMany({
        where: { level },
        orderBy: { grammar_id: 'asc' },
      });
      return res.json(rows);
    }
  });

  router.get('/:id', async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid grammar id' });

    const grammar = await prisma.grammar.findUnique({ where: { grammar_id: BigInt(id) } });
    const usages = await prisma.grammarUsage.findMany({
      where: { grammar_id: BigInt(id) },
      orderBy: { usage_id: 'asc' },
    });

    const validUsages = usages.filter(
      (usage) => !isPlaceholderUsage(usage.example_ja, usage.example_vi),
    );

    const usagesWithReading = await Promise.all(
      validUsages.map(async (usage) => {
        const exampleJa = String(usage.example_ja || '').trim();
        if (!exampleJa) {
          return {
            ...usage,
            example_ja_ruby_html: '',
            example_ja_reading_hira: '',
          };
        }
        try {
          const [rubyHtml, readingHira] = await Promise.all([
            toRubyHtml(exampleJa),
            toReadingHiragana(exampleJa),
          ]);
          return {
            ...usage,
            example_ja_ruby_html: rubyHtml,
            example_ja_reading_hira: readingHira,
          };
        } catch (_err) {
          return {
            ...usage,
            example_ja_ruby_html: '',
            example_ja_reading_hira: '',
          };
        }
      }),
    );

    return res.json({ grammar, usages: usagesWithReading });
  });

  return router;
}
