import { applyReviewedReadings } from '../lib/reviewedReadings';
import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { requireUser } from '../middleware/userGuard';
import { buildExamStudy } from '../lib/examStudy';

type Catalog = ReturnType<typeof buildExamStudy>;
let cached: { catalog: Catalog; expires: number } | undefined;
let pending: Promise<Catalog> | undefined;
async function catalog(): Promise<Catalog> {
  if (cached && cached.expires > Date.now()) return cached.catalog;
  if (pending) return pending;
  pending = (async () => {
    // Existing content only: no cache regeneration, AI calls or schema writes.
    const [exams, questions, passages] = await Promise.all([
      prisma.jlptExam.findMany({ where: { level: 'N2' }, select: { level: true, exam_id: true, part: true, json_data: true }, orderBy: [{ exam_id: 'desc' }, { part: 'asc' }] }),
      prisma.$queryRaw<any[]>`SELECT DISTINCT ON (exam_id, part, section_index, question_index) level, exam_id, part, section_index, question_index, explanation_json FROM jlpt_question_explanation WHERE level = 'N2' AND prompt_version = 24 ORDER BY exam_id DESC, part, section_index, question_index, updated_at DESC`,
      prisma.$queryRaw<any[]>`SELECT DISTINCT ON (exam_id, part, section_index, group_hash) level, exam_id, part, section_index, explanation_json FROM jlpt_passage_explanation WHERE level = 'N2' AND prompt_version = 24 ORDER BY exam_id DESC, part, section_index, group_hash, updated_at DESC`,
    ]);
    const result = buildExamStudy(exams, questions.map(r => ({ ...r, explanation_json: applyReviewedReadings(r.explanation_json) })), passages.map(r => ({ ...r, explanation_json: applyReviewedReadings(r.explanation_json) })));
    cached = { catalog: result, expires: Date.now() + 15 * 60_000 };
    return result;
  })();
  try { return await pending; } finally { pending = undefined; }
}

export function createExamStudyRouter() {
  const router = Router();
  router.get('/n2', async (req, res) => {
    await requireUser(req);
    const category = String(req.query.category || 'vocabulary');
    const page = Number(req.query.page || 1);
    const q = String(req.query.q || '').normalize('NFKC').trim().toLocaleLowerCase();
    const includeSupplemental = req.query.supplemental === '1';
    const includeBasic = req.query.basic === '1';
    if (!['vocabulary', 'kanji', 'grammar', 'traps'].includes(category) || !Number.isSafeInteger(page) || page < 1 || page > 1000 || q.length > 80) {
      return res.status(400).json({ message: 'Bộ lọc không hợp lệ.' });
    }
    const data = await catalog();
    const items = data.items.filter((i) => i.category === category && (includeBasic || !i.basic) && (includeSupplemental || i.sourceCount > 0) && (!q || `${i.title} ${i.examples.map((e) => `${e.surface} ${e.reading} ${e.meaning} ${e.note}`).join(' ')}`.normalize('NFKC').toLocaleLowerCase().includes(q)));
    const pageSize = 30;
    return res.json({ meta: data.meta, total: items.length, page, pageSize, items: items.slice((page - 1) * pageSize, page * pageSize) });
  });
  return router;
}
