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

const SUPPORTED_CONTENT_LANGUAGES = new Set(['vi', 'en', 'zh', 'ko', 'pt', 'id', 'ne', 'my', 'fil']);

function normalizeLanguage(value: unknown): string {
  const lang = String(value || 'vi').trim().toLowerCase();
  return SUPPORTED_CONTENT_LANGUAGES.has(lang) ? lang : 'vi';
}

function resolveRequestLanguage(req: Request): string {
  return normalizeLanguage(req.query.language ?? req.headers['x-language']);
}

// GET / returns raw SQL rows (actual DB column names: meaning_vi, grammar_usage).
async function overlayGrammarListTranslations(rows: any[], language: string): Promise<any[]> {
  if (language === 'vi' || !rows.length) return rows;

  const grammarIds = rows.map((row) => BigInt(row.grammar_id));
  const translations = await prisma.grammarTranslation.findMany({
    where: { grammar_id: { in: grammarIds }, language },
  });
  const byGrammarId = new Map(translations.map((t) => [String(t.grammar_id), t]));

  return rows.map((row) => {
    const translation = byGrammarId.get(String(row.grammar_id));
    if (!translation) return { ...row, translated: false };
    return {
      ...row,
      meaning_vi: translation.meaning ?? row.meaning_vi,
      grammar_usage: translation.usage_text ?? row.grammar_usage,
      note: translation.note ?? row.note,
      translated: true,
    };
  });
}

// GET /:id returns Prisma-mapped fields (grammar_usage_text) for the grammar row,
// plus a list of GrammarUsage rows (example_vi each).
async function overlayGrammarDetailTranslation(grammar: any, language: string): Promise<any> {
  if (language === 'vi') return { ...grammar, translated: false };

  const translation = await prisma.grammarTranslation.findUnique({
    where: { grammar_id_language: { grammar_id: grammar.grammar_id, language } },
  });
  if (!translation) return { ...grammar, translated: false };
  return {
    ...grammar,
    meaning_vi: translation.meaning ?? grammar.meaning_vi,
    grammar_usage_text: translation.usage_text ?? grammar.grammar_usage_text,
    note: translation.note ?? grammar.note,
    translated: true,
  };
}

async function overlayGrammarUsageTranslations(usages: any[], language: string): Promise<any[]> {
  if (language === 'vi' || !usages.length) return usages;

  const usageIds = usages.map((usage) => BigInt(usage.usage_id));
  const translations = await prisma.grammarUsageTranslation.findMany({
    where: { usage_id: { in: usageIds }, language },
  });
  const byUsageId = new Map(translations.map((t) => [String(t.usage_id), t]));

  return usages.map((usage) => {
    const translation = byUsageId.get(String(usage.usage_id));
    if (!translation) return { ...usage, translated: false };
    return { ...usage, example_vi: translation.example ?? usage.example_vi, translated: true };
  });
}

export function createGrammarRouter() {
  const router = Router();

  router.get('/', async (req: Request, res: Response) => {
    const language = resolveRequestLanguage(req);
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
      const translated = await overlayGrammarListTranslations(rows as any[], language);
      return res.json(translated.map((row) => ({ ...row, isLocked: false })));
    } catch (_err) {
      const rows = await prisma.grammar.findMany({
        where: { level },
        orderBy: { grammar_id: 'asc' },
      });
      return res.json((rows as any[]).map((row) => ({ ...row, isLocked: false })));
    }
  });

  router.get('/:id', async (req: Request, res: Response) => {
    const language = resolveRequestLanguage(req);
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid grammar id' });

    const grammarRow = await prisma.grammar.findUnique({ where: { grammar_id: BigInt(id) } });
    if (!grammarRow) return res.status(404).json({ message: 'Grammar not found' });
    const grammar = await overlayGrammarDetailTranslation(grammarRow, language);

    const usageRows = await prisma.grammarUsage.findMany({
      where: { grammar_id: BigInt(id) },
      orderBy: { usage_id: 'asc' },
    });
    const usages = await overlayGrammarUsageTranslations(usageRows, language);

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
